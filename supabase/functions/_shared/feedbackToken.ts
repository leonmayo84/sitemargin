// Shared by whatever sends the post-signup feedback email (e.g. a Resend
// call inside an Edge Function). It must produce byte-identical digests to
// the `feedback` function's verifier, so this is deliberately the same
// algorithm, same key, same normalisation — do not "tidy" one without the
// other.
//
//   key            SUPABASE_SERVICE_ROLE_KEY (never leaves the server)
//   message        email, trimmed and lowercased
//   digest         HMAC-SHA256 → hex → first 32 chars
//
// Usage:
//   import { buildFeedbackLinks } from "../_shared/feedbackToken.ts";
//   const links = await buildFeedbackLinks("Leon@Example.co.za");
//   html = template
//     .replaceAll("{{FN_URL}}",    links.fnUrl)
//     .replaceAll("{{EMAIL_ENC}}", links.emailEnc)
//     .replaceAll("{{TOKEN}}",     links.token);

const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;

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

export async function signEmail(email: string): Promise<string> {
  const key = await hmacKey();
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(email.trim().toLowerCase()),
  );
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}

export async function buildFeedbackLinks(email: string) {
  const normalised = email.trim().toLowerCase();
  const token = await signEmail(normalised);
  const fnUrl = `${SUPABASE_URL}/functions/v1/feedback`;
  const emailEnc = encodeURIComponent(normalised);
  const base = `${fnUrl}?e=${emailEnc}&t=${token}`;
  return {
    fnUrl,
    emailEnc,
    token,
    // Ready-made hrefs if you'd rather not use the template placeholders.
    open: base,
    review: `${base}&q=review`,
    ease: (v: number) => `${base}&q=ease&v=${v}`,
    tools: (v: number) => `${base}&q=tools&v=${v}`,
  };
}

// Renders the template with a recipient's merge fields applied.
export async function renderFeedbackEmail(
  templateHtml: string,
  opts: { email: string; firstName?: string; unsubscribeUrl?: string },
): Promise<string> {
  const links = await buildFeedbackLinks(opts.email);
  return templateHtml
    .replaceAll("{{FN_URL}}", links.fnUrl)
    .replaceAll("{{EMAIL_ENC}}", links.emailEnc)
    .replaceAll("{{TOKEN}}", links.token)
    .replaceAll("{{FIRST_NAME}}", escapeHtml(opts.firstName?.trim() || "Hi"))
    .replaceAll("{{UNSUBSCRIBE_URL}}", opts.unsubscribeUrl ?? "https://www.sitemargin.co.za");
}

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ESC[c]);
}
