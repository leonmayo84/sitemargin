// supabase/functions/accounting-sync/index.ts
//
// Called from the app's Accounting panel's "Sync now" button for one user.
// The actual fetch/match/write logic lives in _shared/accounting.ts
// (syncConnection) so it's shared with accounting-sync-all, which runs the
// same thing on a daily schedule for every connected user.
//
// Read-only against Xero/Sage: this never creates, updates, or deletes
// anything on their side — only fetches.

import { createClient } from "npm:@supabase/supabase-js@2";
import { syncConnection, fetchOwnerLineItems, type Provider } from "../_shared/accounting.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

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
    if (provider) query = query.eq("provider", provider as Provider);
    const { data: connections, error: connErr } = await query;
    if (connErr) throw connErr;
    if (!connections?.length) {
      return new Response(JSON.stringify({ error: "No connected accounting account." }), {
        status: 404,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    const lineItems = await fetchOwnerLineItems(supabase, email);

    const results: Record<string, { pulled: number; matched: number; error?: string }> = {};
    for (const conn of connections) {
      results[conn.provider] = await syncConnection(supabase, conn, lineItems);
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
