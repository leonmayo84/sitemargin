// Supabase Edge Function: storage-checkout
// Creates a pending row in storage_purchases and returns the PayFast
// redirect fields the frontend should POST, including a computed
// signature (required since this PayFast account has "require signature"
// enabled under Payment Page Settings).
//
// Note: Deno's built-in Web Crypto (crypto.subtle.digest) does NOT support
// MD5 — only SHA-1/256/384/512 — so PayFast's MD5-based signature scheme
// needs a pure-JS implementation instead.
//
// Note: the process URL is payment.payfast.io, not www.payfast.co.za —
// confirmed against PayFast's own "Generate Pay Now Buttons" tool output,
// which posts to payment.payfast.io/eng/process.
//
// Note: return_url/cancel_url point at the app's root with a ?storage=
// query param, not a real /storage/upgrade-success path — this app is a
// single-page app that routes entirely via query params (see ?accounting=,
// ?tier=, ?login= elsewhere), it has no server-side route for that path,
// so PayFast redirecting there would just 404. StorageView in App.jsx
// reads ?storage=success|cancelled&purchase_id=... and shows the result.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import md5 from "https://esm.sh/js-md5@0.8.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const UPGRADE_CATALOG: Record<
  string,
  { bytes: number; amountZar: number; label: string }
> = {
  individual_100mb: { bytes: 100 * 1024 * 1024, amountZar: 99, label: "100MB storage upgrade" },
  individual_250mb: { bytes: 250 * 1024 * 1024, amountZar: 199, label: "250MB storage upgrade" },
  company_1gb: { bytes: 1 * 1024 * 1024 * 1024, amountZar: 299, label: "1GB storage upgrade" },
  company_10gb: { bytes: 10 * 1024 * 1024 * 1024, amountZar: 469, label: "10GB storage upgrade" },
};

// PayFast requires the signature to be computed over the fields in the
// exact order they're submitted in the form, not alphabetically.
function generatePayfastSignature(
  orderedFields: [string, string][],
  passphrase?: string,
): string {
  const pairs = orderedFields
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${key}=${encodeURIComponent(String(value).trim()).replace(/%20/g, "+")}`);
  let str = pairs.join("&");
  if (passphrase) {
    str += `&passphrase=${encodeURIComponent(passphrase.trim()).replace(/%20/g, "+")}`;
  }
  return md5(str);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: corsHeaders });
  }

  try {
    const { email, upgrade_tier } = await req.json();

    if (!email || !upgrade_tier || !UPGRADE_CATALOG[upgrade_tier]) {
      return new Response(JSON.stringify({ error: "Invalid email or upgrade_tier" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const upgrade = UPGRADE_CATALOG[upgrade_tier];

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: purchase, error } = await supabase
      .from("storage_purchases")
      .insert({
        email,
        upgrade_tier,
        upgrade_bytes: upgrade.bytes,
        amount_zar: upgrade.amountZar,
        status: "pending",
      })
      .select()
      .single();

    if (error) throw error;

    const siteUrl = Deno.env.get("SITE_URL") ?? "https://app.sitemargin.co.za";
    const mPaymentId = purchase.id as string;

    await supabase
      .from("storage_purchases")
      .update({ m_payment_id: mPaymentId })
      .eq("id", purchase.id);

    const orderedFields: [string, string][] = [
      ["merchant_id", Deno.env.get("PAYFAST_MERCHANT_ID")!],
      ["merchant_key", Deno.env.get("PAYFAST_MERCHANT_KEY")!],
      ["return_url", `${siteUrl}/?storage=success&purchase_id=${mPaymentId}`],
      ["cancel_url", `${siteUrl}/?storage=cancelled`],
      ["notify_url", `${Deno.env.get("SUPABASE_URL")}/functions/v1/storage-itn`],
      ["email_address", email],
      ["m_payment_id", mPaymentId],
      ["amount", upgrade.amountZar.toFixed(2)],
      ["item_name", upgrade.label],
    ];

    const passphrase = Deno.env.get("PAYFAST_PASSPHRASE") || undefined;
    const signature = generatePayfastSignature(orderedFields, passphrase);

    const payfastFields: Record<string, string> = Object.fromEntries(orderedFields);
    payfastFields.signature = signature;

    return new Response(
      JSON.stringify({
        purchase_id: purchase.id,
        payfast_url: "https://payment.payfast.io/eng/process",
        fields: payfastFields,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: "Checkout failed", detail: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
