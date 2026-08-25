// supabase/functions/accounting-oauth-start/index.ts
//
// Called from the app's Accounting panel when a user clicks "Connect Xero"
// / "Connect Sage". Returns the provider's OAuth authorize URL for the
// frontend to redirect the browser to — the actual token exchange happens
// in accounting-oauth-callback once the user approves on the provider's
// own site.

import { PROVIDERS, redirectUri, encodeState, type Provider } from "../_shared/accounting.ts";

Deno.serve(async (req) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  };
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const { email, provider } = await req.json();
    if (!email || !PROVIDERS[provider as Provider]) {
      return new Response(JSON.stringify({ error: "Missing or invalid email/provider." }), {
        status: 400,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }
    const p = provider as Provider;
    const cfg = PROVIDERS[p];
    if (!cfg.clientId || !cfg.clientSecret) {
      return new Response(
        JSON.stringify({ error: `${p === "xero" ? "Xero" : "Sage"} isn't configured yet — set ${p.toUpperCase()}_CLIENT_ID / ${p.toUpperCase()}_CLIENT_SECRET as Supabase Edge Function secrets.` }),
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
