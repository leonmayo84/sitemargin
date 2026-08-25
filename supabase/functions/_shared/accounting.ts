// supabase/functions/_shared/accounting.ts
//
// Shared config, OAuth/token-refresh helpers, and the actual sync logic for
// the Xero and Sage accounting-sync integration. Two edge functions share
// this: accounting-sync (JWT-protected, called from the app for one user at
// a time) and accounting-sync-all (called by a daily pg_cron job across
// every connected user). Both call syncConnection() below for the per-
// connection work so the matching/fetch logic only lives in one place.

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

// ---------------------------------------------------------------------
// Fetch + match + sync — shared by accounting-sync and accounting-sync-all
// ---------------------------------------------------------------------

export type NormalizedTxn = {
  external_id: string;
  contact_name: string | null;
  description: string | null;
  category_hint: string | null;
  amount: number;
  txn_date: string | null;
};

export type LineItemRef = { id: string; name: string; project_id: string };

// Xero: Accounting API, bills (ACCPAY invoices) that have been fully paid.
// Field names per Xero's documented Invoices resource — verify against a
// live sandbox response the first time this runs for real, since it has
// never been exercised against Xero's actual API from this session.
async function fetchXeroInvoices(access_token: string, tenant_id: string, since: string | null): Promise<NormalizedTxn[]> {
  const clauses = [`Type=="ACCPAY"`, `Status=="PAID"`];
  if (since) clauses.push(`UpdatedDateUTC>=DateTime(${since.slice(0, 10).replace(/-/g, ",")})`);
  const url = `https://api.xero.com/api.xro/2.0/Invoices?where=${encodeURIComponent(clauses.join("&&"))}&order=UpdatedDateUTC DESC`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${access_token}`,
      "Xero-tenant-id": tenant_id,
      Accept: "application/json",
    },
  });
  if (!res.ok) throw new Error(`Xero invoices fetch failed: ${res.status} ${await res.text()}`);
  const body = await res.json();
  return (body.Invoices ?? []).map((inv: any) => ({
    external_id: inv.InvoiceID,
    contact_name: inv.Contact?.Name ?? null,
    description: inv.LineItems?.[0]?.Description ?? inv.InvoiceNumber ?? null,
    category_hint: inv.LineItems?.[0]?.AccountCode ?? null,
    amount: Number(inv.Total ?? 0),
    txn_date: inv.DateString ? inv.DateString.slice(0, 10) : null,
  }));
}

// Sage Business Cloud Accounting API v3.1 — purchase invoices. Same caveat
// as Xero above: field names are Sage's documented shape but unverified
// against a live response from here.
async function fetchSageInvoices(access_token: string, business_id: string, since: string | null): Promise<NormalizedTxn[]> {
  const params = new URLSearchParams({ business: business_id, items_per_page: "200" });
  if (since) params.set("updated_or_created_since", since);
  const url = `https://api.accounting.sage.com/v3.1/purchase_invoices?${params}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${access_token}`, Accept: "application/json" } });
  if (!res.ok) throw new Error(`Sage invoices fetch failed: ${res.status} ${await res.text()}`);
  const body = await res.json();
  return (body.$items ?? []).map((inv: any) => ({
    external_id: inv.id,
    contact_name: inv.contact?.displayed_as ?? null,
    description: inv.reference ?? inv.notes ?? null,
    category_hint: inv.ledger_account?.displayed_as ?? null,
    amount: Number(inv.total_amount ?? 0),
    txn_date: inv.date ?? null,
  }));
}

function normalize(s: string | null | undefined): string {
  return (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

// A transaction matches a line item when the line item's name shows up
// inside the transaction's description or contact name. Ambiguous — more
// than one equally-good candidate — is treated as no match, left unmatched
// rather than guessed.
export function findMatch(txn: NormalizedTxn, lineItems: LineItemRef[]): LineItemRef | null {
  const hay = normalize(`${txn.contact_name ?? ""} ${txn.description ?? ""}`);
  if (!hay) return null;
  const candidates = lineItems.filter((li) => {
    const needle = normalize(li.name);
    return needle.length >= 4 && hay.includes(needle);
  });
  return candidates.length === 1 ? candidates[0] : null;
}

// Runs a full sync for one accounting_connections row: refreshes the token
// if needed, fetches invoices since the connection's last sync, upserts
// accounting_transactions, recomputes `actual` on every touched line item,
// and updates the connection's last_synced_at/status. Never throws for a
// per-connection failure — callers get { error } back and can decide
// whether to keep going with other connections.
export async function syncConnection(
  supabase: any,
  conn: { id: string; owner_email: string; provider: Provider; access_token: string; refresh_token: string; token_expires_at: string | null; tenant_id: string; last_synced_at: string | null },
  lineItems: LineItemRef[]
): Promise<{ pulled: number; matched: number; error?: string }> {
  const p = conn.provider;
  try {
    let accessToken = conn.access_token;
    const expiresAt = conn.token_expires_at ? new Date(conn.token_expires_at).getTime() : 0;
    if (!expiresAt || expiresAt < Date.now() + 60_000) {
      const refreshed = await refreshToken(p, conn.refresh_token);
      accessToken = refreshed.access_token;
      await supabase
        .from("accounting_connections")
        .update({
          access_token: refreshed.access_token,
          refresh_token: refreshed.refresh_token,
          token_expires_at: new Date(Date.now() + refreshed.expires_in * 1000).toISOString(),
        })
        .eq("id", conn.id);
    }

    const txns =
      p === "xero"
        ? await fetchXeroInvoices(accessToken, conn.tenant_id, conn.last_synced_at)
        : await fetchSageInvoices(accessToken, conn.tenant_id, conn.last_synced_at);

    let matchedCount = 0;
    for (const txn of txns) {
      const match = findMatch(txn, lineItems);
      const { error: upsertErr } = await supabase.from("accounting_transactions").upsert(
        {
          connection_id: conn.id,
          owner_email: conn.owner_email,
          provider: p,
          external_id: txn.external_id,
          contact_name: txn.contact_name,
          description: txn.description,
          category_hint: txn.category_hint,
          amount: txn.amount,
          txn_date: txn.txn_date,
          status: match ? "matched" : "unmatched",
          matched_line_item_id: match?.id ?? null,
          matched_project_id: match?.project_id ?? null,
        },
        { onConflict: "connection_id,external_id" }
      );
      if (upsertErr) throw upsertErr;
      if (match) matchedCount++;
    }

    // Recompute `actual` for every line item touched this run, as the sum
    // of everything currently matched to it — safe to re-run, and avoids
    // double-counting on repeat syncs.
    const touchedLineItemIds = [...new Set(txns.map((t) => findMatch(t, lineItems)?.id).filter(Boolean))] as string[];
    for (const lineItemId of touchedLineItemIds) {
      const { data: sumRows } = await supabase
        .from("accounting_transactions")
        .select("amount")
        .eq("matched_line_item_id", lineItemId)
        .eq("status", "matched");
      const total = (sumRows ?? []).reduce((s: number, r: any) => s + Number(r.amount || 0), 0);
      await supabase
        .from("line_items")
        .update({ actual: total, actual_source: p, synced_at: new Date().toISOString() })
        .eq("id", lineItemId);
    }

    await supabase
      .from("accounting_connections")
      .update({ last_synced_at: new Date().toISOString(), last_error: null, status: "connected" })
      .eq("id", conn.id);

    return { pulled: txns.length, matched: matchedCount };
  } catch (err) {
    console.error(`syncConnection (${p}, ${conn.owner_email}) error:`, err);
    await supabase.from("accounting_connections").update({ status: "error", last_error: String(err) }).eq("id", conn.id);
    return { pulled: 0, matched: 0, error: String(err) };
  }
}

export async function fetchOwnerLineItems(supabase: any, email: string): Promise<LineItemRef[]> {
  const { data: lineItemRows } = await supabase
    .from("line_items")
    .select("id, name, project_id, projects_v2!inner(owner_email)")
    .eq("projects_v2.owner_email", email);
  return (lineItemRows ?? []).map((li: any) => ({ id: li.id, name: li.name, project_id: li.project_id }));
}
