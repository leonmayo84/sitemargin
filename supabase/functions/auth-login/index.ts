// Password grant proxy with real HTTP semantics.
//
// supabase-js returns 200 with an error field in the body, which gives a
// non-browser caller nothing to branch on. This fronts the GoTrue password
// grant so native code and future integrations get honest status codes:
//   401 credentials rejected · 422 malformed input · 429 rate limited
//   502 upstream misbehaving · 504 timed out
//
// Deploy:  supabase functions deploy auth-login --no-verify-jwt
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const REQUEST_TIMEOUT_MS = 10000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const ALLOWED = new Set(["https://app.sitemargin.co.za", "https://sitemargin.co.za"]);

const cors = (o: string | null) => ({
  "Access-Control-Allow-Origin": o && ALLOWED.has(o) ? o : "https://app.sitemargin.co.za",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
});

const json = (b: unknown, s: number, o: string | null) =>
  new Response(JSON.stringify(b), {
    status: s,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...cors(o) },
  });

Deno.serve(async (req) => {
  const origin = req.headers.get("Origin");
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(origin) });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405, origin);

  let body: { email?: string; password?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Malformed request body" }, 422, origin);
  }

  const email = (body.email ?? "").trim();
  const password = body.password ?? "";

  // 422 = well-formed JSON, semantically invalid. Distinct from 401, which
  // means "well formed, credentials rejected" — clients want to tell these
  // apart to decide whether to keep what the user typed in the form.
  if (!email || !EMAIL_RE.test(email)) {
    return json({ error: "A valid email is required." }, 422, origin);
  }
  if (!password || password.length < 8) {
    return json({ error: "Password must be at least 8 characters." }, 422, origin);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json", apikey: ANON_KEY },
      body: JSON.stringify({ email, password }),
    });

    let payload: Record<string, unknown>;
    try {
      payload = await res.json();
    } catch {
      return json({ error: "Unexpected response from the authentication service." }, 502, origin);
    }

    // GoTrue answers 400 invalid_grant for a wrong password — normalise it to
    // the 401 the client actually wants to branch on.
    if (res.status === 400 || res.status === 401) {
      return json({ error: "Incorrect email or password." }, 401, origin);
    }
    if (res.status === 422 || res.status === 429) {
      return json(
        { error: payload?.error_description ?? payload?.msg ?? "Request could not be processed." },
        res.status,
        origin,
      );
    }
    if (!res.ok) {
      console.error("auth-login: unexpected upstream status", res.status, payload);
      return json({ error: "Sign-in is temporarily unavailable — please try again." }, 502, origin);
    }

    return json(
      {
        access_token: payload.access_token,
        refresh_token: payload.refresh_token,
        expires_at: payload.expires_at,
      },
      200,
      origin,
    );
  } catch (err) {
    if ((err as Error)?.name === "AbortError") {
      return json({ error: "That's taking too long — check your connection and try again." }, 504, origin);
    }
    console.error("auth-login: unexpected error", err);
    return json({ error: "Something went wrong — please try again." }, 500, origin);
  } finally {
    clearTimeout(timer);
  }
});
