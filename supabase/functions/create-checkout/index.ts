// supabase/functions/create-checkout/index.ts
//
// Builds a signed PayFast payment request server-side, where the passphrase
// can stay secret. The frontend calls this function with { email, tier },
// and gets back a URL to redirect the user to for PayFast's hosted checkout
// (which itself offers Apple Pay, Google Pay, cards, and EFT as options).

import { createHash } from "node:crypto";
import { createClient } from "npm:@supabase/supabase-js@2";
import { TIERS } from "../_shared/tiers.ts";

const PAYFAST_MERCHANT_ID = Deno.env.get("PAYFAST_MERCHANT_ID")!;
const PAYFAST_MERCHANT_KEY = Deno.env.get("PAYFAST_MERCHANT_KEY")!;
const PAYFAST_PASSPHRASE = Deno.env.get("PAYFAST_PASSPHRASE")!;
const PAYFAST_MODE = Deno.env.get("PAYFAST_MODE") ?? "live"; // "live" | "sandbox"
const APP_URL = Deno.env.get("APP_URL") ?? "https://app.sitemargin.co.za";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// PayFast requires values urlencoded PHP-style (spaces as '+', not %20).
function pfEncode(value: string): string {
  return encodeURIComponent(value).replace(/%20/g, "+");
}

function buildSignature(fields: [string, string][], passphrase: string): string {
  const parts = fields
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}=${pfEncode(String(v))}`);
  const paramString = parts.join("&") + `&passphrase=${pfEncode(passphrase)}`;
  return createHash("md5").update(paramString).digest("hex");
}

Deno.serve(async (req) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  };
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const { email, tier } = await req.json();

    if (!email || !TIERS[tier]) {
      return new Response(JSON.stringify({ error: "Missing or invalid email/tier." }), {
        status: 400,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    // Rate limit: block more than 5 checkout attempts from the same email
    // within 5 minutes, so this endpoint can't be spammed against PayFast.
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const { count } = await supabase
      .from("checkout_rate_limits")
      .select("id", { count: "exact", head: true })
      .eq("email", email)
      .gte("created_at", fiveMinutesAgo);

    if ((count ?? 0) >= 5) {
      return new Response(JSON.stringify({ error: "Too many checkout attempts — please wait a few minutes and try again." }), {
        status: 429,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }
    await supabase.from("checkout_rate_limits").insert({ email });

    const mPaymentId = `sm_${crypto.randomUUID()}`;

    // Record the pending subscription attempt so the ITN webhook has something to match against.
    await supabase.from("subscriptions").upsert(
      {
        email,
        tier,
        status: "inactive",
        m_payment_id: mPaymentId,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "email" }
    );

    const { amount, label, recurring } = TIERS[tier];

    // Field order matters for PayFast's signature — this follows their
    // documented order. The subscription fields (subscription_type onward)
    // are what turns this into a recurring monthly charge; a once-off tier
    // (e.g. homeowner) simply omits them and PayFast treats it as a normal
    // single payment instead.
    const fields: [string, string][] = [
      ["merchant_id", PAYFAST_MERCHANT_ID],
      ["merchant_key", PAYFAST_MERCHANT_KEY],
      ["return_url", `${APP_URL}/?payment=success`],
      ["cancel_url", `${APP_URL}/?payment=cancelled`],
      ["notify_url", `${SUPABASE_URL}/functions/v1/payfast-itn`],
      ["email_address", email],
      ["m_payment_id", mPaymentId],
      ["amount", amount],
      ["item_name", label],
      ...(recurring
        ? ([
            ["subscription_type", "1"],
            ["recurring_amount", amount],
            ["frequency", "3"], // monthly
            ["cycles", "0"], // 0 = indefinite, until cancelled
          ] as [string, string][])
        : []),
    ];

    const signature = buildSignature(fields, PAYFAST_PASSPHRASE);
    const query = fields.map(([k, v]) => `${k}=${pfEncode(v)}`).join("&") + `&signature=${signature}`;

    const base = PAYFAST_MODE === "sandbox" ? "https://sandbox.payfast.co.za/eng/process" : "https://www.payfast.co.za/eng/process";

    return new Response(JSON.stringify({ redirectUrl: `${base}?${query}` }), {
      headers: { ...cors, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("create-checkout error:", err);
    return new Response(JSON.stringify({ error: "Something went wrong building the checkout." }), {
      status: 500,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }
});
