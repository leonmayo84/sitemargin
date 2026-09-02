import { serve } from "npm:@supabase/functions-js@2/serve";
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const COOKIE_NAME = "sm_remember";
const REMEMBER_DAYS = 30;
const IS_PROD = Deno.env.get("ENV") !== "local";

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
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
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (IS_PROD) flags.push("Secure"); // allow plain http on localhost during dev
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

serve(async (req) => {
  const url = new URL(req.url);
  const action = url.searchParams.get("action"); // "issue" | "refresh" | "revoke"

  try {
    if (req.method === "POST" && action === "issue") {
      // Called right after a normal sign-in, only when the user checked
      // "Remember me". Requires a live Supabase access token.
      const accessToken = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
      if (!accessToken) return json({ error: "Missing Authorization header" }, 401);
      const { data: userRes, error: userErr } = await admin.auth.getUser(accessToken);
      if (userErr || !userRes?.user) return json({ error: "Invalid or expired session" }, 401);

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
        return json({ error: "Could not enable Remember Me — please try again." }, 500);
      }

      return json({ ok: true }, 200, {
        "Set-Cookie": cookieHeader(rawToken, REMEMBER_DAYS * 86400),
      });
    }

    if (req.method === "POST" && action === "refresh") {
      const rawToken = readCookie(req, COOKIE_NAME);
      if (!rawToken) return json({ error: "No remember-me session" }, 401);
      const tokenHash = await sha256Hex(rawToken);

      const { data: row, error: rowErr } = await admin
        .from("persistent_sessions")
        .select("id, user_id, family_id, revoked_at, expires_at")
        .eq("token_hash", tokenHash)
        .maybeSingle();

      if (rowErr) {
        console.error("auth-session refresh: lookup failed", rowErr);
        return json({ error: "Something went wrong — please sign in again." }, 500);
      }
      if (!row) return json({ error: "Session not recognized — please sign in again." }, 401, { "Set-Cookie": clearCookieHeader() });

      if (row.revoked_at) {
        // Reuse of an already-rotated (or already-revoked) token: treat as
        // theft, kill the whole chain, force a real re-login.
        await admin.from("persistent_sessions")
          .update({ revoked_at: new Date().toISOString(), revoked_reason: "reuse_detected" })
          .eq("family_id", row.family_id)
          .is("revoked_at", null);
        console.warn("auth-session refresh: reuse detected, family revoked", row.family_id);
        return json({ error: "This session is no longer valid — please sign in again." }, 401, { "Set-Cookie": clearCookieHeader() });
      }

      if (new Date(row.expires_at) < new Date()) {
        return json({ error: "Session expired — please sign in again." }, 401, { "Set-Cookie": clearCookieHeader() });
      }

      const { data: userRec, error: userLookupErr } = await admin.auth.admin.getUserById(row.user_id);
      if (userLookupErr || !userRec?.user?.email) {
        return json({ error: "Account lookup failed — please sign in again." }, 500);
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
        return json({ error: "Something went wrong — please sign in again." }, 500);
      }

      let session;
      try {
        session = await mintSupabaseSession(userRec.user.email);
      } catch (err) {
        console.error("auth-session refresh: mint failed", err);
        return json({ error: "Could not restore your session — please sign in again." }, 500);
      }

      return json({
        access_token: session.access_token,
        refresh_token: session.refresh_token,
        expires_at: session.expires_at,
      }, 200, { "Set-Cookie": cookieHeader(newRawToken, REMEMBER_DAYS * 86400) });
    }

    if (req.method === "POST" && action === "revoke") {
      const rawToken = readCookie(req, COOKIE_NAME);
      if (rawToken) {
        const tokenHash = await sha256Hex(rawToken);
        await admin.from("persistent_sessions")
          .update({ revoked_at: new Date().toISOString(), revoked_reason: "user_signed_out" })
          .eq("token_hash", tokenHash);
      }
      return json({ ok: true }, 200, { "Set-Cookie": clearCookieHeader() });
    }

    return json({ error: "Unknown action" }, 422);
  } catch (err) {
    console.error("auth-session: unexpected error", err);
    return json({ error: "Something went wrong — please try again." }, 500);
  }
});
