// supabase/functions/accounting-oauth-start/index.ts
//
// Called from the app's Accounting panel when a user clicks "Connect Xero".
// Returns Xero's OAuth authorize URL for the frontend to redirect the
// browser to — the actual token exchange happens in
// accounting-oauth-callback once the user approves on Xero's own site.
//
// Xero only: Sage (for South African accounts) doesn't use OAuth at all —
// see accounting-sage-za-connect and the big comment in
// _shared/accounting.ts for why. A "sage" provider here just falls through
// to the "not configured" response below, same as it always has.

import { PROVIDERS, redirectUri, encodeState } from "../_shared/accounting.ts";

Deno.serve(async (req) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  };
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const { email, provider } = await req.json();
    if (!email || provider !== "xero" || !PROVIDERS[provider]) {
      return new Response(JSON.stringify({ error: "Xero is the only accounting connection that uses this flow. Sage connects from its own \"Connect Sage\" form." }), {
        status: 400,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }
    const p = provider;
    const cfg = PROVIDERS[p];
    if (!cfg.clientId || !cfg.clientSecret) {
      return new Response(
        JSON.stringify({ error: "Xero isn't configured yet — set XERO_CLIENT_ID / XERO_CLIENT_SECRET as Supabase Edge Function secrets." }),
        { status: 501, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    const state = encodeState(email, p);
    const params = new URLSearchParams({
      response_type: "code",
      client_id: cfg.clientId,
      redirect_uri: redirectUri(p),
      scope: cfg.scopes,
      state,
    });

    return new Response(JSON.stringify({ url: `${cfg.authorizeUrl}?${params}` }), {
      headers: { ...cors, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("accounting-oauth-start error:", err);
    return new Response(JSON.stringify({ error: "Something went wrong starting the connection." }), {
      status: 500,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }
});
