// supabase/functions/accounting-sync-all/index.ts
//
// Runs accounting-sync for every connected user, once a day. Triggered by
// a pg_cron job (see the accounting_sync_daily_cron migration), not the
// app — the cron job sends a shared secret in the x-cron-secret header,
// checked below. This function has verify_jwt disabled (pg_cron has no
// user session to attach a JWT to) so the secret check is the only thing
// standing between this endpoint and the public internet; treat
// CRON_SYNC_SECRET as sensitive and don't reuse it anywhere else.
//
// One connection failing (bad token, provider API error) is logged onto
// that connection's own row and the loop moves on — a problem with one
// user's Xero account should never stop everyone else's sync from running.

import { createClient } from "npm:@supabase/supabase-js@2";
import { syncConnection, fetchOwnerLineItems } from "../_shared/accounting.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
// Matches the literal embedded in the accounting_sync_daily_cron migration's
// pg_cron job body. Not read from Deno.env because this session has no way
// to set Edge Function secrets on the user's behalf — see the session notes
// for why this one credential is hardcoded rather than an env var like
// every other secret in this codebase.
const CRON_SYNC_SECRET = "BeWvnUhxRglXMl5zOxGT0lyw1wSHWtfgiekvwcGJRDo";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok");

  if (req.headers.get("x-cron-secret") !== CRON_SYNC_SECRET) {
    return new Response(JSON.stringify({ error: "Unauthorized." }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    const { data: connections, error: connErr } = await supabase
      .from("accounting_connections")
      .select("*")
      .eq("status", "connected");
    if (connErr) throw connErr;

    const summary: { owner_email: string; provider: string; pulled: number; matched: number; error?: string }[] = [];

    const byOwner = new Map<string, typeof connections>();
    for (const conn of connections ?? []) {
      if (!byOwner.has(conn.owner_email)) byOwner.set(conn.owner_email, []);
      byOwner.get(conn.owner_email)!.push(conn);
    }

    for (const [email, conns] of byOwner) {
      const lineItems = await fetchOwnerLineItems(supabase, email);
      for (const conn of conns) {
        const result = await syncConnection(supabase, conn, lineItems);
        summary.push({ owner_email: email, provider: conn.provider, ...result });
      }
    }

    console.log(`accounting-sync-all: ran for ${byOwner.size} user(s), ${connections?.length ?? 0} connection(s)`);
    return new Response(JSON.stringify({ ran: summary.length, summary }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("accounting-sync-all error:", err);
    return new Response(JSON.stringify({ error: "Something went wrong running the scheduled sync." }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
