import { useEffect, useRef, useState } from "react";
import { supabase } from "./supabaseClient";

const SUPABASE_FUNCTIONS_URL = "https://mcxmtnlhqubaljvnwmzc.supabase.co/functions/v1";
const REFRESH_TIMEOUT_MS = 8000;

// Runs once on app mount, before checkAccess() would otherwise decide the
// user is signed out. If a Remember Me cookie is present and still valid,
// this silently restores a live Supabase session; if not, it's a fast no-op
// and the normal signed-out gate renders as it does today.
export function useRememberMeRestore() {
  const [status, setStatus] = useState("checking"); // checking | restored | none
  const ranRef = useRef(false);

  useEffect(() => {
    if (ranRef.current) return;
    ranRef.current = true;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REFRESH_TIMEOUT_MS);

    (async () => {
      try {
        const res = await fetch(`${SUPABASE_FUNCTIONS_URL}/auth-session?action=refresh`, {
          method: "POST",
          credentials: "include", // send the HttpOnly cookie
          signal: controller.signal,
        });
        if (!res.ok) {
          setStatus("none");
          return;
        }
        const session = await res.json();
        const { error } = await supabase.auth.setSession({
          access_token: session.access_token,
          refresh_token: session.refresh_token,
        });
        setStatus(error ? "none" : "restored");
      } catch (err) {
        if (err?.name !== "AbortError") console.warn("Remember Me restore failed", err);
        setStatus("none");
      } finally {
        clearTimeout(timeoutId);
      }
    })();

    return () => controller.abort();
  }, []);

  return status;
}

export async function enableRememberMe() {
  const { data } = await supabase.auth.getSession();
  const accessToken = data.session?.access_token;
  if (!accessToken) throw new Error("Sign in first.");
  const res = await fetch(`${SUPABASE_FUNCTIONS_URL}/auth-session?action=issue`, {
    method: "POST",
    credentials: "include",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error("Could not enable Remember Me.");
}

export async function disableRememberMe() {
  await fetch(`${SUPABASE_FUNCTIONS_URL}/auth-session?action=revoke`, {
    method: "POST",
    credentials: "include",
  }).catch(() => {});
}
