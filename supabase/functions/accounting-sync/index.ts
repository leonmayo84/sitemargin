// supabase/functions/accounting-sync/index.ts
//
// Pulls paid purchase invoices/bills from a user's connected Xero and/or
// Sage account since the connection's last sync, records them in
// accounting_transactions, and tries to auto-match each one to an existing
// line_item (same account, name loosely matches the invoice's contact or
// description). Matched line_items get `actual` recomputed as the sum of
// everything currently matched to them and are flagged with actual_source
// so the ledger UI can show "from Xero"/"from Sage" instead of a plain
// manually-typed figure. Anything that doesn't match cleanly is left
// "unmatched" for the user to assign by hand in the Accounting panel —
// guessing wrong here is worse than asking once.
//
// Read-only: this never creates, updates, or deletes anything in Xero or
// Sage — only fetches.

import { createClient } from "npm:@supabase/supabase-js@2";
import { PROVIDERS, refreshToken, type Provider } from "../_shared/accounting.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

type NormalizedTxn = {
  external_id: string;
  contact_name: string | null;
  description: string | null;
  category_hint: string | null;
  amount: number;
  txn_date: string | null;
};

// Xero: Accounting API, bills (ACCPAY invoices) that have been fully paid.
// Field names per Xero's documented Invoices resource — verify against a
// live sandbox response when the real client id/secret are wired up, since
// this has never been run against Xero's actual API from this session.
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
function findMatch(txn: NormalizedTxn, lineItems: { id: string; name: string; project_id: string }[]) {
  const hay = normalize(`${txn.contact_name ?? ""} ${txn.description ?? ""}`);
  if (!hay) return null;
  const candidates = lineItems.filter((li) => {
    const needle = normalize(li.name);
    return needle.length >= 4 && hay.includes(needle);
  });
  return candidates.length === 1 ? candidates[0] : null;
}

Deno.serve(async (req) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  };
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const { email, provider } = await req.json();
    if (!email) {
      return new Response(JSON.stringify({ error: "Missing email." }), {
        status: 400,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    let query = supabase.from("accounting_connections").select("*").eq("owner_email", email).eq("status", "connected");
    if (provider) query = query.eq("provider", provider);
    const { data: connections, error: connErr } = await query;
    if (connErr) throw connErr;
    if (!connections?.length) {
      return new Response(JSON.stringify({ error: "No connected accounting account." }), {
        status: 404,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    const { data: lineItemRows } = await supabase
      .from("line_items")
      .select("id, name, project_id, projects_v2!inner(owner_email)")
      .eq("projects_v2.owner_email", email);
    const lineItems = (lineItemRows ?? []).map((li: any) => ({ id: li.id, name: li.name, project_id: li.project_id }));

    const results: Record<string, { pulled: number; matched: number; error?: string }> = {};

    for (const conn of connections) {
      const p = conn.provider as Provider;
      try {
        let accessToken = conn.access_token as string;
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
              owner_email: email,
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

        // Recompute `actual` for every line item touched this run, as the
        // sum of everything currently matched to it — safe to re-run, and
        // avoids double-counting on repeat syncs.
        const touchedLineItemIds = [...new Set(txns.map((t) => findMatch(t, lineItems)?.id).filter(Boolean))] as string[];
        for (const lineItemId of touchedLineItemIds) {
          const { data: sumRows } = await supabase
            .from("accounting_transactions")
            .select("amount")
            .eq("matched_line_item_id", lineItemId)
            .eq("status", "matched");
          const total = (sumRows ?? []).reduce((s, r: any) => s + Number(r.amount || 0), 0);
          await supabase
            .from("line_items")
            .update({ actual: total, actual_source: p, synced_at: new Date().toISOString() })
            .eq("id", lineItemId);
        }

        await supabase
          .from("accounting_connections")
          .update({ last_synced_at: new Date().toISOString(), last_error: null, status: "connected" })
          .eq("id", conn.id);

        results[p] = { pulled: txns.length, matched: matchedCount };
      } catch (err) {
        console.error(`accounting-sync (${p}) error:`, err);
        await supabase.from("accounting_connections").update({ status: "error", last_error: String(err) }).eq("id", conn.id);
        results[p] = { pulled: 0, matched: 0, error: String(err) };
      }
    }

    return new Response(JSON.stringify({ results }), { headers: { ...cors, "Content-Type": "application/json" } });
  } catch (err) {
    console.error("accounting-sync error:", err);
    return new Response(JSON.stringify({ error: "Something went wrong syncing." }), {
      status: 500,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }
});
