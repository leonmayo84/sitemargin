// supabase/functions/_shared/accounting.ts
//
// Shared config + OAuth/token-refresh helpers for the Xero and Sage
// accounting-sync integration. Both providers use OAuth2 authorization-code
// flow; what differs is the endpoint URLs, scopes, and how "which
// company/org did they connect" gets resolved after the token exchange
// (Xero: a separate /connections call returning a tenantId; Sage: a
// /businesses call — Sage's API has changed shape more than once, so
// re-check the field names against their current docs when the real
// client id/secret go in).

export type Provider = "xero" | "sage";

export const PROVIDERS: Record<Provider, {
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string;
  clientId: string;
  clientSecret: string;
}> = {
  xero: {
    authorizeUrl: "https://login.xero.com/identity/connect/authorize",
    tokenUrl: "https://identity.xero.com/connect/token",
    scopes: "openid profile email accounting.transactions.read accounting.contacts.read offline_access",
    clientId: Deno.env.get("XERO_CLIENT_ID") ?? "",
    clientSecret: Deno.env.get("XERO_CLIENT_SECRET") ?? "",
  },
  sage: {
    authorizeUrl: "https://www.sageone.com/oauth2/auth/central",
    tokenUrl: "https://oauth.accounting.sage.com/token",
    // Sage Business Cloud Accounting's public API only offers this one scope today.
    scopes: "full_access",
    clientId: Deno.env.get("SAGE_CLIENT_ID") ?? "",
    clientSecret: Deno.env.get("SAGE_CLIENT_SECRET") ?? "",
  },
};

export function redirectUri(provider: Provider): string {
  const base = Deno.env.get("SUPABASE_URL")!;
  return `${base}/functions/v1/accounting-oauth-callback?provider=${provider}`;
}

// Encodes { email, provider } into the OAuth "state" param so the callback
// — which the accounting platform calls directly, with no SiteMargin
// session attached — knows which user to attach the connection to. Not a
// secret, just an anti-CSRF nonce plus routing info, so a plain base64 blob
// is enough rather than a signed token.
export function encodeState(email: string, provider: Provider): string {
  return btoa(JSON.stringify({ email, provider, nonce: crypto.randomUUID() }));
}

export function decodeState(state: string): { email: string; provider: Provider } {
  const parsed = JSON.parse(atob(state));
  return { email: parsed.email, provider: parsed.provider };
}

export async function exchangeCodeForToken(provider: Provider, code: string) {
  const cfg = PROVIDERS[provider];
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri(provider),
  });
  const res = await fetch(cfg.tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${btoa(`${cfg.clientId}:${cfg.clientSecret}`)}`,
    },
    body,
  });
  if (!res.ok) throw new Error(`${provider} token exchange failed: ${res.status} ${await res.text()}`);
  return res.json() as Promise<{ access_token: string; refresh_token: string; expires_in: number }>;
}

export async function refreshToken(provider: Provider, refresh_token: string) {
  const cfg = PROVIDERS[provider];
  const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token });
  const res = await fetch(cfg.tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${btoa(`${cfg.clientId}:${cfg.clientSecret}`)}`,
    },
    body,
  });
  if (!res.ok) throw new Error(`${provider} token refresh failed: ${res.status} ${await res.text()}`);
  return res.json() as Promise<{ access_token: string; refresh_token: string; expires_in: number }>;
}
