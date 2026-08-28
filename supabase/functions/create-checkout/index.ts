// supabase/functions/create-checkout/index.ts
//
// Called from the app when a signed-in user clicks "Subscribe" on a plan.
// Builds a signed PayFast checkout request, records a pending subscription
// row so payfast-itn has something to match against once payment completes,
// and returns the URL the browser should redirect to.
//
// The actual activation happens in payfast-itn (server-to-server), never
// here — this function only ever hands back a redirect URL.
//
// NOTE: live host changed from www.payfast.co.za to payment.payfast.io —
// confirmed via PayFast's own "Generate Pay Now Buttons" tool, whose
// generated form posts to payment.payfast.io/eng/process.
//
// NOTE: this function is called directly via browser fetch() from
// app.sitemargin.co.za (a different origin than the Supabase functions
// domain), with a custom Authorization header + JSON content-type — that
// combination always triggers a CORS preflight (OPTIONS) request. Fixed by
// adding the same corsHeaders/OPTIONS handling already used in
// storage-checkout.

import { createHash } from "node:crypto";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const PAYFAST_MERCHANT_ID = Deno.env.get("PAYFAST_MERCHANT_ID");
const PAYFAST_MERCHANT_KEY = Deno.env.get("PAYFAST_MERCHANT_KEY");
const PAYFAST_PASSPHRASE = Deno.env.get("PAYFAST_PASSPHRASE");
const PAYFAST_MODE = Deno.env.get("PAYFAST_MODE") ?? "live";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const APP_ORIGIN = Deno.env.get("APP_ORIGIN") ?? "https://app.sitemargin.co.za";

const PLAN_PRICE: Record<string, string> = {
  contractor: "199.00",
  firm: "599.00",
  homeowner: "899.00",
};
const PLAN_NAME: Record<string, string> = {
  contractor: "SiteMargin — Contractor",
  firm: "SiteMargin — Firm",
  homeowner: "SiteMargin — Home Owner",
};
// Contractor/Firm are recurring monthly subscriptions; Home Owner is a
// once-off project purchase (R899/project, per pricing.html) — PayFast
// treats these very differently: a once-off payment must NOT carry any of
// the subscription_type/recurring_amount/frequency/cycles/billing_date
// fields, or PayFast tries to set up recurring billing on a plan that was
// never meant to repeat.
const RECURRING_TIERS = new Set(["contractor", "firm"]);

function pfEncode(value: string): string {
  return encodeURIComponent(value).replace(/%20/g, "+");
}

function signFields(fields: Record<string, string>, passphrase: string): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value === "" || value === undefined || value === null) continue;
    parts.push(`${key}=${pfEncode(String(value))}`);
  }
  const paramString = parts.join("&") + `&passphrase=${pfEncode(passphrase)}`;
  return createHash("md5").update(paramString).digest("hex");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  if (!PAYFAST_MERCHANT_ID || !PAYFAST_MERCHANT_KEY || !PAYFAST_PASSPHRASE) {
    console.error("create-checkout: missing PAYFAST_MERCHANT_ID / PAYFAST_MERCHANT_KEY / PAYFAST_PASSPHRASE secret");
    return new Response(
      JSON.stringify({ error: "Payments aren't configured yet — contact support." }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const token = authHeader.replace("Bearer ", "");
    if (!token) {
      return new Response(JSON.stringify({ error: "Please sign in again." }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    const { data: userData, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !userData?.user?.email) {
      return new Response(JSON.stringify({ error: "Please sign in again." }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const email = userData.user.email;

    const body = await req.json().catch(() => ({}));
    const tier = body?.tier;
    if (!PLAN_PRICE[tier]) {
      return new Response(JSON.stringify({ error: "Unknown plan selected." }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const since = new Date(Date.now() - 60_000).toISOString();
    const { count } = await supabase
      .from("checkout_rate_limits")
      .select("id", { count: "exact", head: true })
      .eq("email", email)
      .gte("created_at", since);
    if ((count ?? 0) >= 5) {
      return new Response(
        JSON.stringify({ error: "Too many attempts — please wait a moment and try again." }),
        { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    await supabase.from("checkout_rate_limits").insert({ email });

    const mPaymentId = crypto.randomUUID();

    const { error: upsertErr } = await supabase.from("subscriptions").upsert(
      {
        email,
        tier,
        status: "pending",
        m_payment_id: mPaymentId,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "email" }
    );
    if (upsertErr) {
      console.error("create-checkout: failed to record pending subscription", upsertErr);
      return new Response(JSON.stringify({ error: "Couldn't start checkout — please try again." }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const host = PAYFAST_MODE === "sandbox" ? "sandbox.payfast.co.za" : "payment.payfast.io";

    const fields: Record<string, string> = {
      merchant_id: PAYFAST_MERCHANT_ID,
      merchant_key: PAYFAST_MERCHANT_KEY,
      return_url: `${APP_ORIGIN}/?checkout=success`,
      cancel_url: `${APP_ORIGIN}/?checkout=cancelled`,
      notify_url: `${SUPABASE_URL}/functions/v1/payfast-itn`,
      email_address: email,
      m_payment_id: mPaymentId,
      amount: PLAN_PRICE[tier],
      item_name: PLAN_NAME[tier],
    };
    if (RECURRING_TIERS.has(tier)) {
      fields.subscription_type = "1";
      fields.billing_date = new Date().toISOString().slice(0, 10);
      fields.recurring_amount = PLAN_PRICE[tier];
      fields.frequency = "3";
      fields.cycles = "0";
    }

    const signature = signFields(fields, PAYFAST_PASSPHRASE);
    const query = new URLSearchParams({ ...fields, signature }).toString();
    const redirectUrl = `https://${host}/eng/process?${query}`;

    return new Response(JSON.stringify({ redirectUrl }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("create-checkout error:", err);
    return new Response(JSON.stringify({ error: "Couldn't start checkout — please try again." }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
