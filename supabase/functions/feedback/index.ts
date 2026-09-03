// Post-signup feedback capture — JSON API + redirects only.
//
// Supabase Edge Functions rewrite text/html responses to text/plain, so this
// function never renders a page. One-tap links from the email hit it, it
// records the answer, then 302s to the static landing page on the marketing
// site (feedback.html), which handles the richer form over this same API.
//
// Those email links are unauthenticated by nature, so every one carries an
// HMAC over the recipient's address; without a valid signature nothing is
// written. Key material is the service-role key, which already lives in this
// function's env and never leaves the server — only the digest travels.
//
// Routes
//   GET  ?e=&t=&q=ease|tools&v=1..5   record a rating, 302 to the landing page
//   GET  ?e=&t=&q=review              record the review click, 302 to Google
//   GET  ?e=&t=                       JSON: current answers (to prefill the form)
//   POST ?e=&t=   {"feature_request"} save the open answer, JSON back
//
// Deploy:  supabase functions deploy feedback --no-verify-jwt
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
// Google review deep link: https://search.google.com/local/writereview?placeid=<PLACE_ID>
const GOOGLE_REVIEW_URL = Deno.env.get("GOOGLE_REVIEW_URL") ?? "https://www.sitemargin.co.za";
const LANDING_URL = Deno.env.get("FEEDBACK_LANDING_URL") ?? "https://www.sitemargin.co.za/feedback.html";
const SOURCE = "post_signup_email";

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const ALLOWED_ORIGINS = new Set([
  "https://www.sitemargin.co.za",
  "https://sitemargin.co.za",
  "https://app.sitemargin.co.za",
]);

function cors(origin: string | null) {
  const allow = origin && ALLOWED_ORIGINS.has(origin) ? origin : "https://www.sitemargin.co.za";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Vary": "Origin",
  };
}

function json(body: unknown, status: number, origin: string | null, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...cors(origin), ...extra },
  });
}

// ---------------------------------------------------------------- signing --
// The sender must produce the same digest per recipient. Same key, same
// algorithm, email lowercased and trimmed, first 32 hex chars.
let keyPromise: Promise<CryptoKey> | null = null;
function hmacKey() {
  if (!keyPromise) {
    keyPromise = crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(SERVICE_ROLE_KEY),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
  }
  return keyPromise;
}

async function signEmail(email: string): Promise<string> {
  const key = await hmacKey();
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(email.trim().toLowerCase()));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

// Constant-time compare — a length-or-content early exit leaks a forgery oracle.
function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function redirect(to: string) {
  return new Response(null, { status: 302, headers: { Location: to, "Cache-Control": "no-store" } });
}

async function upsert(email: string, patch: Record<string, unknown>, ua: string | null) {
  return await admin.from("feedback_responses").upsert(
    { email, source: SOURCE, ...patch, user_agent: ua?.slice(0, 400) ?? null },
    { onConflict: "email,source" },
  );
}

// ------------------------------------------------------------------ serve --
Deno.serve(async (req) => {
  const origin = req.headers.get("Origin");
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(origin) });

  const url = new URL(req.url);
  const email = (url.searchParams.get("e") ?? "").trim().toLowerCase();
  const token = url.searchParams.get("t") ?? "";
  const ua = req.headers.get("User-Agent");
  const q = url.searchParams.get("q");

  if (!email || !token) return json({ error: "Missing recipient or signature." }, 400, origin);

  if (!safeEqual(token, await signEmail(email))) {
    return json({ error: "This link couldn't be verified. Open the original email and tap through from there." }, 403, origin);
  }

  const land = (extra = "") =>
    `${LANDING_URL}?e=${encodeURIComponent(email)}&t=${token}${extra}`;

  try {
    if (req.method === "POST") {
      const body = await req.json().catch(() => null);
      if (!body || typeof body !== "object") return json({ error: "Malformed request body." }, 422, origin);
      const text = String((body as Record<string, unknown>).feature_request ?? "").slice(0, 4000).trim();
      const { error } = await upsert(email, { feature_request: text || null }, ua);
      if (error) {
        console.error("feedback POST upsert failed", error);
        return json({ error: "That didn't save — please try again." }, 500, origin);
      }
      return json({ ok: true }, 200, origin);
    }

    if (req.method !== "GET") return json({ error: "Method not allowed." }, 405, origin);

    if (q === "review") {
      const { error } = await upsert(email, { review_clicked: true }, ua);
      if (error) console.error("feedback review upsert failed", error); // never block the redirect on logging
      return redirect(GOOGLE_REVIEW_URL);
    }

    if (q === "ease" || q === "tools") {
      const v = Number(url.searchParams.get("v"));
      if (!Number.isInteger(v) || v < 1 || v > 5) return redirect(land("&err=range"));
      const { error } = await upsert(email, q === "ease" ? { ease_of_use: v } : { tools_rating: v }, ua);
      if (error) {
        console.error("feedback rating upsert failed", error);
        return redirect(land("&err=save"));
      }
      return redirect(land(`&done=${q}`));
    }

    // No action: hand the landing page whatever has been answered so far.
    const { data, error } = await admin
      .from("feedback_responses")
      .select("ease_of_use, tools_rating, feature_request, review_clicked")
      .eq("email", email)
      .eq("source", SOURCE)
      .maybeSingle();
    if (error) {
      console.error("feedback read failed", error);
      return json({ error: "Couldn't load your answers." }, 500, origin);
    }
    return json({ email, ...(data ?? { ease_of_use: null, tools_rating: null, feature_request: null, review_clicked: false }) }, 200, origin);
  } catch (err) {
    console.error("feedback: unexpected error", err);
    return json({ error: "Something went wrong handling that." }, 500, origin);
  }
});
