// supabase/functions/cancel-subscription/index.ts
//
// Called from the app when a signed-in user clicks "Cancel subscription" on
// the Contractor or Firm plan. Cancels the recurring PayFast billing token
// (so no future charge happens) and, only once that's confirmed, downgrades
// the local subscription row to "cancelled" — which drops the account back
// to Free-tier limits immediately (see checkAccess/base_storage_bytes,
// which key off subscriptions.status === "active").
//
// Deliberately does NOT touch the local subscription row unless the PayFast
// cancellation actually succeeds: flipping local status without confirming
// the recurring charge is actually stopped would be worse than doing
// nothing — the customer would lose paid access while still being billed.
//
// NOTE ON THE PAYFAST API CALL BELOW: PayFast's subscription-cancel API is
// separate from the checkout/ITN flow used elsewhere in this app, and its
// official docs page is JS-rendered (couldn't be fetched to verify this
// exactly). This implementation is built from PayFast's published Node/PHP
// client library shapes (PUT /subscriptions/{token}/cancel, with
// merchant-id / version / timestamp / signature headers, signature = MD5 of
// merchant-id, passphrase, timestamp, version sorted alphabetically and
// joined as a query string). If this starts returning errors, the response
// body is passed straight through in the error message for debugging.

import { createHash } from "node:crypto";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const PAYFAST_MERCHANT_ID = Deno.env.get("PAYFAST_MERCHANT_ID");
const PAYFAST_PASSPHRASE = Deno.env.get("PAYFAST_PASSPHRASE");
const PAYFAST_MODE = Deno.env.get("PAYFAST_MODE") ?? "live";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

function payfastApiHost(): string {
  // Same live/sandbox split used for the checkout host elsewhere — this
  // specific host for the account-management API is unverified against
  // PayFast's own docs (see file header), so flag loudly if it's wrong
  // rather than silently hitting production from a sandbox test.
  return PAYFAST_MODE === "sandbox" ? "api.sandbox.payfast.co.za" : "api.payfast.co.za";
}

function signApiRequest(params: Record<string, string>, passphrase: string): string {
  const keys = Object.keys(params).sort();
  const parts = keys.map((k) => `${k}=${encodeURIComponent(params[k]).replace(/%20/g, "+")}`);
  const paramString = parts.join("&") + `&passphrase=${encodeURIComponent(passphrase).replace(/%20/g, "+")}`;
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
  if (!PAYFAST_MERCHANT_ID || !PAYFAST_PASSPHRASE) {
    return new Response(JSON.stringify({ error: "Payments aren't configured yet — contact support." }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
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

    const { data: sub, error: subErr } = await supabase
      .from("subscriptions")
      .select("tier, status, payfast_token")
      .eq("email", email)
      .maybeSingle();

    if (subErr || !sub) {
      return new Response(JSON.stringify({ error: "No subscription found for this account." }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (sub.status !== "active") {
      return new Response(JSON.stringify({ error: "This subscription isn't currently active." }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (sub.tier !== "contractor" && sub.tier !== "firm") {
      return new Response(JSON.stringify({ error: "This plan doesn't have a recurring subscription to cancel." }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // No PayFast token on file — there's no recurring billing token for
    // PayFast to cancel (this can happen if a payment completed before
    // tokenization was enabled on the PayFast account). Nothing to cancel
    // on PayFast's side, so it's safe to just downgrade locally.
    if (!sub.payfast_token) {
      await supabase
        .from("subscriptions")
        .update({ status: "cancelled", updated_at: new Date().toISOString() })
        .eq("email", email);
      return new Response(
        JSON.stringify({
          ok: true,
          warning: "No PayFast billing token was on file (nothing to cancel there) — your plan has been downgraded here regardless.",
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const timestamp = new Date().toISOString().slice(0, 19); // PayFast wants no milliseconds
    const signature = signApiRequest(
      { "merchant-id": PAYFAST_MERCHANT_ID, timestamp, version: "v1" },
      PAYFAST_PASSPHRASE
    );

    const pfRes = await fetch(`https://${payfastApiHost()}/subscriptions/${encodeURIComponent(sub.payfast_token)}/cancel`, {
      method: "PUT",
      headers: {
        "merchant-id": PAYFAST_MERCHANT_ID,
        version: "v1",
        timestamp,
        signature,
        "Content-Type": "application/json",
      },
    });

    if (!pfRes.ok) {
      const detail = await pfRes.text().catch(() => "");
      console.error("cancel-subscription: PayFast API rejected cancellation", pfRes.status, detail);
      return new Response(
        JSON.stringify({
          error: `PayFast couldn't cancel this subscription (status ${pfRes.status}). Your plan has NOT been changed — nothing was charged or lost. Please try again, or cancel it directly from your PayFast dashboard under Subscriptions.`,
          detail,
        }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    await supabase
      .from("subscriptions")
      .update({ status: "cancelled", updated_at: new Date().toISOString() })
      .eq("email", email);

    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("cancel-subscription error:", err);
    return new Response(JSON.stringify({ error: "Couldn't cancel — please try again." }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
