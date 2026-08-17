// supabase/functions/payfast-itn/index.ts
//
// PayFast calls this URL server-to-server after a payment completes (this is
// their "ITN" — Instant Transaction Notification). This is the ONLY place a
// subscription actually gets activated — never trust the browser redirect
// alone, since that can be faked by anyone typing the URL.

import { createHash } from "node:crypto";
import { createClient } from "npm:@supabase/supabase-js@2";

const PAYFAST_PASSPHRASE = Deno.env.get("PAYFAST_PASSPHRASE")!;
const PAYFAST_MODE = Deno.env.get("PAYFAST_MODE") ?? "live";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

function pfEncode(value: string): string {
  return encodeURIComponent(value).replace(/%20/g, "+");
}

function verifySignature(fields: URLSearchParams, passphrase: string): boolean {
  const receivedSignature = fields.get("signature");
  const parts: string[] = [];
  for (const [key, value] of fields.entries()) {
    if (key === "signature") continue;
    if (value === "") continue;
    parts.push(`${key}=${pfEncode(value)}`);
  }
  const paramString = parts.join("&") + `&passphrase=${pfEncode(passphrase)}`;
  const computed = createHash("md5").update(paramString).digest("hex");
  return computed === receivedSignature;
}

async function validateWithPayfast(rawBody: string): Promise<boolean> {
  const host = PAYFAST_MODE === "sandbox" ? "https://sandbox.payfast.co.za" : "https://www.payfast.co.za";
  const res = await fetch(`${host}/eng/query/validate`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: rawBody,
  });
  const text = await res.text();
  return text.trim() === "VALID";
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  try {
    const rawBody = await req.text();
    const fields = new URLSearchParams(rawBody);

    // 1. Verify the signature matches what we'd compute ourselves.
    if (!verifySignature(fields, PAYFAST_PASSPHRASE)) {
      console.error("payfast-itn: signature mismatch");
      return new Response("Invalid signature", { status: 400 });
    }

    // 2. Confirm with PayFast directly that this notification is genuine
    //    (protects against spoofed requests hitting this URL directly).
    const isValid = await validateWithPayfast(rawBody);
    if (!isValid) {
      console.error("payfast-itn: failed PayFast validation");
      return new Response("Failed validation", { status: 400 });
    }

    const paymentStatus = fields.get("payment_status");
    const email = fields.get("email_address");
    const mPaymentId = fields.get("m_payment_id");
    const token = fields.get("token"); // present for recurring/subscription payments

    if (!email) {
      return new Response("Missing email", { status: 400 });
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    if (paymentStatus === "COMPLETE") {
      const periodEnd = new Date();
      periodEnd.setMonth(periodEnd.getMonth() + 1);

      await supabase
        .from("subscriptions")
        .update({
          status: "active",
          payfast_token: token ?? null,
          current_period_end: periodEnd.toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("email", email)
        .eq("m_payment_id", mPaymentId);
    } else if (paymentStatus === "CANCELLED") {
      await supabase
        .from("subscriptions")
        .update({ status: "cancelled", updated_at: new Date().toISOString() })
        .eq("email", email);
    }

    // PayFast just needs a 200 OK — it doesn't read the body.
    return new Response("OK", { status: 200 });
  } catch (err) {
    console.error("payfast-itn error:", err);
    // Still return 200 so PayFast doesn't endlessly retry a request we can't process —
    // the error is logged for you to investigate instead.
    return new Response("Error logged", { status: 200 });
  }
});