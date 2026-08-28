// Supabase Edge Function: storage-itn
// Receives PayFast's ITN for once-off storage upgrade payments, verifies
// it, and flips the matching storage_purchases row to 'complete'.
// verify_jwt is false: PayFast calls this directly, no user session.
//
// Note: Deno's Web Crypto does not support MD5, so a pure-JS MD5
// implementation is used instead of crypto.subtle.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import md5 from "https://esm.sh/js-md5@0.8.3";

function buildSignatureString(params: URLSearchParams, passphrase?: string): string {
  const pairs: string[] = [];
  for (const [key, value] of params.entries()) {
    if (key === "signature") continue;
    pairs.push(`${key}=${encodeURIComponent(value.trim()).replace(/%20/g, "+")}`);
  }
  let str = pairs.join("&");
  if (passphrase) {
    str += `&passphrase=${encodeURIComponent(passphrase.trim()).replace(/%20/g, "+")}`;
  }
  return str;
}

async function confirmWithPayfast(rawBody: string): Promise<boolean> {
  const res = await fetch("https://www.payfast.co.za/eng/query/validate", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: rawBody,
  });
  const text = await res.text();
  return text.trim() === "VALID";
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const rawBody = await req.text();
  const params = new URLSearchParams(rawBody);

  try {
    const passphrase = Deno.env.get("PAYFAST_PASSPHRASE") || undefined;
    const sigString = buildSignatureString(params, passphrase);
    const expectedSignature = md5(sigString);
    const receivedSignature = params.get("signature");

    if (expectedSignature !== receivedSignature) {
      console.error("PayFast ITN signature mismatch");
      return new Response("Invalid signature", { status: 400 });
    }

    const isValid = await confirmWithPayfast(rawBody);
    if (!isValid) {
      console.error("PayFast ITN failed validate check");
      return new Response("Invalid notification", { status: 400 });
    }

    const paymentStatus = params.get("payment_status");
    const mPaymentId = params.get("m_payment_id");
    const amountGross = params.get("amount_gross");

    if (!mPaymentId) {
      return new Response("Missing m_payment_id", { status: 400 });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: purchase, error: fetchError } = await supabase
      .from("storage_purchases")
      .select("*")
      .eq("id", mPaymentId)
      .single();

    if (fetchError || !purchase) {
      console.error("No matching storage_purchases row for", mPaymentId);
      return new Response("Unknown payment reference", { status: 404 });
    }

    if (Math.abs(parseFloat(amountGross ?? "0") - Number(purchase.amount_zar)) > 0.01) {
      console.error("Amount mismatch on storage purchase", mPaymentId);
      return new Response("Amount mismatch", { status: 400 });
    }

    if (paymentStatus === "COMPLETE") {
      await supabase
        .from("storage_purchases")
        .update({
          status: "complete",
          payfast_token: params.get("token") ?? null,
          completed_at: new Date().toISOString(),
        })
        .eq("id", mPaymentId);
    } else {
      await supabase
        .from("storage_purchases")
        .update({ status: "failed" })
        .eq("id", mPaymentId);
    }

    return new Response("OK", { status: 200 });
  } catch (err) {
    console.error("Storage ITN error:", err);
    return new Response("Server error", { status: 500 });
  }
});
