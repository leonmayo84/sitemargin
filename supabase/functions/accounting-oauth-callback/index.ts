// supabase/functions/accounting-oauth-callback/index.ts
//
// The redirect URI registered with the Xero/Sage OAuth app. The user lands
// here straight from the provider's own consent screen with no SiteMargin
// session attached, so identity comes entirely from the `state` blob
// created in accounting-oauth-start. Exchanges the code for tokens, records
// the connection, then bounces the browser back into the app.

import { createClient } from "npm:@supabase/supabase-js@2";
import { decodeState, exchangeCodeForToken, type Provider } from "../_shared/accounting.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const APP_URL = Deno.env.get("APP_URL") ?? "https://app.sitemargin.co.za";

async function fetchXeroTenant(access_token: string): Promise<{ id: string; name: string } | null> {
  const res = await fetch("https://api.xero.com/connections", {
    headers: { Authorization: `Bearer ${access_token}` },
  });
  if (!res.ok) return null;
  const list = await res.json();
  const first = Array.isArray(list) ? list[0] : null;
  return first ? { id: first.tenantId, name: first.tenantName ?? "Xero" } : null;
}

async function fetchSageBusiness(access_token: string): Promise<{ id: string; name: string } | null> {
  const res = await fetch("https://api.accounting.sage.com/v3.1/businesses", {
    headers: { Authorization: `Bearer ${access_token}` },
  });
  if (!res.ok) return null;
  const body = await res.json();
  const first = body?.$items?.[0];
  return first ? { id: first.id, name: first.legislative_data?.business_name ?? "Sage" } : null;
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const errorParam = url.searchParams.get("error");

  function bounce(status: "connected" | "error", provider?: string, message?: string) {
    const q = new URLSearchParams({
      accounting: status,
      ...(provider ? { provider } : {}),
      ...(message ? { message } : {}),
    });
    return new Response(null, { status: 302, headers: { Location: `${APP_URL}/?${q}` } });
  }

  if (errorParam) return bounce("error", undefined, errorParam);
  if (!code || !state) return bounce("error", undefined, "missing_code_or_state");

  let email: string, provider: Provider;
  try {
    ({ email, provider } = decodeState(state));
  } catch {
    return bounce("error", undefined, "invalid_state");
  }

  try {
    const token = await exchangeCodeForToken(provider, code);
    const tenant =
      provider === "xero"
        ? await fetchXeroTenant(token.access_token)
        : await fetchSageBusiness(token.access_token);

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    await supabase.from("accounting_connections").upsert(
      {
        owner_email: email,
        provider,
        tenant_id: tenant?.id ?? null,
        tenant_name: tenant?.name ?? null,
        access_token: token.access_token,
        refresh_token: token.refresh_token,
        token_expires_at: new Date(Date.now() + token.expires_in * 1000).toISOString(),
        status: "connected",
        last_error: null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "owner_email,provider" }
    );

    return bounce("connected", provider);
  } catch (err) {
    console.error("accounting-oauth-callback error:", err);
    return bounce("error", provider, "token_exchange_failed");
  }
});
