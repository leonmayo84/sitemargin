// supabase/functions/accounting-sage-za-connect/index.ts
//
// Connects a South African Sage account. Unlike Xero (accounting-oauth-
// start/-callback), Sage ZA has no OAuth redirect — the user just types
// their own Sage username and password into a form in the app, which POSTs
// straight here. See the big comment at the top of _shared/accounting.ts
// for why Sage ZA works this way.
//
// Two-step because a Sage login can have more than one company on it:
//   1. { email, username, password }                    -> validates the
//      login against Sage and returns the company list. If there's exactly
//      one company, it connects immediately instead of making the user
//      pick from a list of one.
//   2. { email, username, password, companyId }          -> connects that
//      specific company once the user has picked from step 1's list.
//
// The username/password are stored on the connection row (sage_username /
// sage_password) because Sage ZA has no session or refresh token to keep
// instead — every sync call re-sends Basic Auth. Same trust boundary as
// storing Xero's access/refresh tokens elsewhere in this table.

import { createClient } from "npm:@supabase/supabase-js@2";
import { sageZaListCompanies } from "../_shared/accounting.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

Deno.serve(async (req) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  };
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const { email, username, password, companyId } = await req.json();
    if (!email || !username || !password) {
      return new Response(JSON.stringify({ error: "Missing email, username, or password." }), {
        status: 400,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    const companies = await sageZaListCompanies(username, password);
    if (!companies.length) {
      return new Response(JSON.stringify({ error: "That Sage login doesn't have any companies on it." }), {
        status: 400,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    let chosen = companies[0];
    if (companies.length > 1) {
      if (!companyId) {
        // Ask the frontend to show a picker rather than guessing which
        // company the user meant.
        return new Response(JSON.stringify({ companies }), {
          headers: { ...cors, "Content-Type": "application/json" },
        });
      }
      const match = companies.find((c) => c.id === companyId);
      if (!match) {
        return new Response(JSON.stringify({ error: "That company wasn't found on this Sage login." }), {
          status: 400,
          headers: { ...cors, "Content-Type": "application/json" },
        });
      }
      chosen = match;
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const { error: upsertErr } = await supabase.from("accounting_connections").upsert(
      {
        owner_email: email,
        provider: "sage",
        tenant_id: chosen.id,
        tenant_name: chosen.name,
        sage_username: username,
        sage_password: password,
        access_token: null,
        refresh_token: null,
        token_expires_at: null,
        status: "connected",
        last_error: null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "owner_email,provider" }
    );
    if (upsertErr) throw upsertErr;

    return new Response(JSON.stringify({ connected: true, company: chosen }), {
      headers: { ...cors, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("accounting-sage-za-connect error:", err);
    return new Response(JSON.stringify({ error: String((err as any)?.message ?? err) }), {
      status: 400,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }
});
