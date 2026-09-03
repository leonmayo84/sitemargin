// Remember Me: issue / refresh / revoke a rotating, HttpOnly opaque token.
//
// Deployed as v2 on 2026-09-02. Two things the first version got wrong, both
// fatal, both fixed here — do not reintroduce either:
//
//   1. Entrypoint. It used `import { serve } from "npm:@supabase/functions-js@2/serve"`,
//      which is not a Supabase pattern. The runtime entrypoint is Deno.serve.
//   2. CORS. The browser calls this cross-origin from app.sitemargin.co.za with
//      credentials: "include". Without Access-Control-Allow-Credentials and a
//      matching origin, the browser discards the response no matter what the
//      server did.
//
// Deploy:  supabase functions deploy auth-session --no-verify-jwt
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const COOKIE_NAME = "sm_remember";
const REMEMBER_DAYS = 30;
const IS_PROD = Deno.env.get("ENV") !== "local";

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const ALLOWED_ORIGINS = new Set([
  "https://app.sitemargin.co.za",
  "https://www.sitemargin.co.za",
  "https://sitemargin.co.za",
]);

function cors(origin: string | null) {
  const allow = origin && ALLOWED_ORIGINS.has(origin) ? origin : "https://app.sitemargin.co.za";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function json(body: unknown, status = 200, origin: string | null = null, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...cors(origin), ...headers },
  });
}

async function sha256Hex(input: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function cookieHeader(token: string, maxAgeSeconds: number) {
  const flags = [
    `${COOKIE_NAME}=${token}`,
    "HttpOnly",
    "Path=/",
    // Strict would drop the cookie on the top-level navigation back from a
    // magic-link or reset-password email; Lax still blocks cross-site POSTs.
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (IS_PROD) flags.push("Secure");
  return flags.join("; ");
}

function clearCookieHeader() {
  return `${COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${IS_PROD ? "; Secure" : ""}`;
}

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get("Cookie") ?? "";
  const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : null;
}

// Mint a real Supabase session from a trusted signal: an admin-generated
// magic-link token, redeemed server-side via verifyOtp. This is the supported
// way to hand a client a live session off the back of a custom trust check.
async function mintSupabaseSession(email: string) {
  const { data: link, error: linkErr } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  if (linkErr || !link) throw new Error("Could not mint a session");
  const anon = createClient(SUPABASE_URL, ANON_KEY);
  const { data: session, error: verifyErr } = await anon.auth.verifyOtp({
    email,
    token_hash: link.properties.hashed_token,
    type: "magiclink",
  });
  if (verifyErr || !session.session) throw new Error("Could not mint a session");
  return session.session;
}

Deno.serve(async (req) => {
  const origin = req.headers.get("Origin");
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(origin) });

  const url = new URL(req.url);
  const action = url.searchParams.get("action"); // "issue" | "refresh" | "revoke"

  try {
    if (req.method === "POST" && action === "issue") {
      // Called right after a normal sign-in, only when the user ticked
      // "Remember me". Requires a live Supabase access token.
      const accessToken = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
      if (!accessToken) return json({ error: "Missing Authorization header" }, 401, origin);
      const { data: userRes, error: userErr } = await admin.auth.getUser(accessToken);
      if (userErr || !userRes?.user) return json({ error: "Invalid or expired session" }, 401, origin);

      const rawToken = crypto.randomUUID() + crypto.randomUUID();
      const tokenHash = await sha256Hex(rawToken);
      const familyId = crypto.randomUUID();
      const expiresAt = new Date(Date.now() + REMEMBER_DAYS * 86400_000);

      const { error: insertErr } = await admin.from("persistent_sessions").insert({
        user_id: userRes.user.id,
        token_hash: tokenHash,
        family_id: familyId,
        device_label: req.headers.get("User-Agent")?.slice(0, 200) ?? null,
        user_agent: req.headers.get("User-Agent")?.slice(0, 400) ?? null,
        ip_created: req.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ?? null,
        expires_at: expiresAt.toISOString(),
      });
      if (insertErr) {
        console.error("auth-session issue: insert failed", insertErr);
        return json({ error: "Could not enable Remember Me — please try again." }, 500, origin);
      }

      return json({ ok: true }, 200, origin, { "Set-Cookie": cookieHeader(rawToken, REMEMBER_DAYS * 86400) });
    }

    if (req.method === "POST" && action === "refresh") {
      const rawToken = readCookie(req, COOKIE_NAME);
      if (!rawToken) return json({ error: "No remember-me session" }, 401, origin);
      const tokenHash = await sha256Hex(rawToken);

      const { data: row, error: rowErr } = await admin
        .from("persistent_sessions")
        .select("id, user_id, family_id, revoked_at, expires_at")
        .eq("token_hash", tokenHash)
        .maybeSingle();

      if (rowErr) {
        console.error("auth-session refresh: lookup failed", rowErr);
        return json({ error: "Something went wrong — please sign in again." }, 500, origin);
      }
      if (!row) {
        return json({ error: "Session not recognized — please sign in again." }, 401, origin, { "Set-Cookie": clearCookieHeader() });
      }

      if (row.revoked_at) {
        // Reuse of an already-rotated token: treat as theft, kill the whole
        // chain, force a real re-login.
        await admin.from("persistent_sessions")
          .update({ revoked_at: new Date().toISOString(), revoked_reason: "reuse_detected" })
          .eq("family_id", row.family_id)
          .is("revoked_at", null);
        console.warn("auth-session refresh: reuse detected, family revoked", row.family_id);
        return json({ error: "This session is no longer valid — please sign in again." }, 401, origin, { "Set-Cookie": clearCookieHeader() });
      }

      if (new Date(row.expires_at) < new Date()) {
        return json({ error: "Session expired — please sign in again." }, 401, origin, { "Set-Cookie": clearCookieHeader() });
      }

      const { data: userRec, error: userLookupErr } = await admin.auth.admin.getUserById(row.user_id);
      if (userLookupErr || !userRec?.user?.email) {
        return json({ error: "Account lookup failed — please sign in again." }, 500, origin);
      }

      const newRawToken = crypto.randomUUID() + crypto.randomUUID();
      const newHash = await sha256Hex(newRawToken);
      const newExpiresAt = new Date(Date.now() + REMEMBER_DAYS * 86400_000);

      const [{ error: revokeErr }, { error: insertErr }] = await Promise.all([
        admin.from("persistent_sessions")
          .update({ revoked_at: new Date().toISOString(), revoked_reason: "rotated" })
          .eq("id", row.id),
        admin.from("persistent_sessions").insert({
          user_id: row.user_id,
          token_hash: newHash,
          family_id: row.family_id,
          device_label: req.headers.get("User-Agent")?.slice(0, 200) ?? null,
          user_agent: req.headers.get("User-Agent")?.slice(0, 400) ?? null,
          expires_at: newExpiresAt.toISOString(),
        }),
      ]);
      if (revokeErr || insertErr) {
        console.error("auth-session refresh: rotation failed", revokeErr, insertErr);
        return json({ error: "Something went wrong — please sign in again." }, 500, origin);
      }

      let session;
      try {
        session = await mintSupabaseSession(userRec.user.email);
      } catch (err) {
        console.error("auth-session refresh: mint failed", err);
        return json({ error: "Could not restore your session — please sign in again." }, 500, origin);
      }

      return json({
        access_token: session.access_token,
        refresh_token: session.refresh_token,
        expires_at: session.expires_at,
      }, 200, origin, { "Set-Cookie": cookieHeader(newRawToken, REMEMBER_DAYS * 86400) });
    }

    if (req.method === "POST" && action === "revoke") {
      const rawToken = readCookie(req, COOKIE_NAME);
      if (rawToken) {
        const tokenHash = await sha256Hex(rawToken);
        await admin.from("persistent_sessions")
          .update({ revoked_at: new Date().toISOString(), revoked_reason: "user_signed_out" })
          .eq("token_hash", tokenHash);
      }
      return json({ ok: true }, 200, origin, { "Set-Cookie": clearCookieHeader() });
    }

    return json({ error: "Unknown action" }, 422, origin);
  } catch (err) {
    console.error("auth-session: unexpected error", err);
    return json({ error: "Something went wrong — please try again." }, 500, origin);
  }
});
