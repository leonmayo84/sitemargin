// supabase/functions/payfast-itn/index.ts
//
// PayFast calls this URL server-to-server after a payment completes (this is
// their "ITN" — Instant Transaction Notification). This is the ONLY place a
// subscription actually gets activated — never trust the browser redirect
// alone, since that can be faked by anyone typing the URL.
//
// verify_jwt is OFF for this function on purpose: PayFast calls this URL
// directly and has no Supabase session/JWT to send. Authenticity is instead
// verified below via PayFast's own signature check plus a server-to-server
// validation call back to PayFast.
//
// FIX (2026-08-28): every real ITN call so far had failed with "signature
// mismatch" — no subscription had ever successfully activated. This
// function was the odd one out: the storage-itn/storage-checkout functions
// (added later) both call .trim() on the passphrase and on every field
// value before hashing, specifically to absorb incidental whitespace (a
// trailing newline pasted into the PAYFAST_PASSPHRASE secret, or PayFast
// itself padding a field) — this function never did. Brought it in line.
// Also keeps non-sensitive diagnostic logging around the signature check
// (passphrase length/mode, computed vs received signature, field names —
// never values that could matter, and never the passphrase itself) so a
// bad match is now debuggable in one log line instead of a guessing game.

import { createHash } from "node:crypto";
import { createClient } from "npm:@supabase/supabase-js@2";

const PAYFAST_PASSPHRASE = Deno.env.get("PAYFAST_PASSPHRASE")!;
const PAYFAST_MODE = Deno.env.get("PAYFAST_MODE") ?? "live";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

function pfEncode(value: string): string {
  return encodeURIComponent(value.trim()).replace(/%20/g, "+");
}

function verifySignature(fields: URLSearchParams, passphrase: string): { ok: boolean; computed: string; received: string | null } {
  const receivedSignature = fields.get("signature");
  const parts: string[] = [];
  for (const [key, value] of fields.entries()) {
    if (key === "signature") continue;
    if (value === "") continue;
    parts.push(`${key}=${pfEncode(value)}`);
  }
  const paramString = parts.join("&") + `&passphrase=${pfEncode(passphrase)}`;
  const computed = createHash("md5").update(paramString).digest("hex");
  return { ok: computed === receivedSignature, computed, received: receivedSignature };
}

async function validateWithPayfast(rawBody: string): Promise<boolean> {
  const host = PAYFAST_MODE === "sandbox" ? "https://sandbox.payfast.co.za" : "https://www.payfast.co.za";
  const res = await fetch(`${host}/eng/query/validate`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: rawBody,
  });
  const text = await res.text();
  console.log(`payfast-itn: validateWithPayfast host=${host} status=${res.status} body="${text.trim().slice(0, 200)}"`);
  return text.trim() === "VALID";
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  try {
    const rawBody = await req.text();
    const fields = new URLSearchParams(rawBody);

    // --- diagnostics: never logs the passphrase value itself ---
    console.log(
      `payfast-itn: incoming ITN — mode=${PAYFAST_MODE} passphrase_set=${!!PAYFAST_PASSPHRASE} passphrase_len=${PAYFAST_PASSPHRASE?.length ?? 0} field_names=[${[...fields.keys()].join(",")}] payment_status=${fields.get("payment_status")} m_payment_id=${fields.get("m_payment_id")}`
    );

    const sigResult = verifySignature(fields, PAYFAST_PASSPHRASE);
    console.log(`payfast-itn: signature check — computed=${sigResult.computed} received=${sigResult.received} match=${sigResult.ok}`);

    if (!sigResult.ok) {
      console.error("payfast-itn: signature mismatch");
      return new Response("Invalid signature", { status: 400 });
    }

    const isValid = await validateWithPayfast(rawBody);
    if (!isValid) {
      console.error("payfast-itn: failed PayFast validation");
      return new Response("Failed validation", { status: 400 });
    }

    const paymentStatus = fields.get("payment_status");
    const email = fields.get("email_address");
    const mPaymentId = fields.get("m_payment_id");
    const token = fields.get("token");

    if (!email) {
      return new Response("Missing email", { status: 400 });
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    if (paymentStatus === "COMPLETE") {
      const periodEnd = new Date();
      periodEnd.setMonth(periodEnd.getMonth() + 1);

      const { error: updateErr } = await supabase
        .from("subscriptions")
        .update({
          status: "active",
          payfast_token: token ?? null,
          current_period_end: periodEnd.toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("email", email)
        .eq("m_payment_id", mPaymentId);
      if (updateErr) console.error("payfast-itn: subscription update failed", updateErr);
      else console.log(`payfast-itn: activated subscription for ${email}`);
    } else if (paymentStatus === "CANCELLED") {
      await supabase
        .from("subscriptions")
        .update({ status: "cancelled", updated_at: new Date().toISOString() })
        .eq("email", email);
    }

    return new Response("OK", { status: 200 });
  } catch (err) {
    console.error("payfast-itn error:", err);
    return new Response("Error logged", { status: 200 });
  }
});
