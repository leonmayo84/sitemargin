import { Capacitor } from "@capacitor/core";
import { NativeBiometric } from "capacitor-native-biometric";
import { supabase } from "./supabaseClient";

const SERVER = "za.co.sitemargin.app.session";

export async function biometricAvailable() {
  if (!Capacitor.isNativePlatform()) return false;
  try {
    const result = await NativeBiometric.isAvailable();
    return result.isAvailable;
  } catch (err) {
    console.warn("Biometric availability check failed", err);
    return false;
  }
}

// Call once, right after a normal successful password/magic-link/passkey
// sign-in, behind an explicit "Enable Face ID / Touch ID" toggle the user
// opts into -- never store credentials silently.
export async function enableBiometricUnlock() {
  const { data } = await supabase.auth.getSession();
  const refreshToken = data.session?.refresh_token;
  const email = data.session?.user?.email;
  if (!refreshToken || !email) throw new Error("No active session to protect.");

  try {
    await NativeBiometric.setCredentials({
      username: email,
      password: refreshToken,
      server: SERVER,
    });
    return true;
  } catch (err) {
    console.error("enableBiometricUnlock failed", err);
    throw new Error("Could not enable Face ID / Touch ID — please try again.", { cause: err });
  }
}

// Call on app cold-start when there ARE stored credentials but no live
// Supabase session yet (e.g. app was force-quit).
export async function unlockWithBiometrics() {
  try {
    const verified = await NativeBiometric.verifyIdentity({
      reason: "Sign in to SiteMargin",
      title: "Unlock SiteMargin",
    }).then(() => true).catch(() => false);
    if (!verified) return { ok: false, reason: "cancelled" };

    const creds = await NativeBiometric.getCredentials({ server: SERVER });
    // Supabase auto-refreshes from a bare refresh_token via setSession, but
    // needs SOME access_token string in the call shape -- an expired one is
    // fine, since refresh_token is what actually gets validated server-side.
    const { data, error } = await supabase.auth.setSession({
      access_token: "",
      refresh_token: creds.password,
    });
    if (error) {
      // Refresh token was revoked/expired server-side -- clear the stale
      // local credential rather than getting stuck retrying it forever.
      await NativeBiometric.deleteCredentials({ server: SERVER }).catch(() => {});
      return { ok: false, reason: "expired" };
    }
    return { ok: true, session: data.session };
  } catch (err) {
    console.error("unlockWithBiometrics failed", err);
    return { ok: false, reason: "error" };
  }
}

export async function disableBiometricUnlock() {
  try {
    await NativeBiometric.deleteCredentials({ server: SERVER });
  } catch (err) {
    console.warn("disableBiometricUnlock: nothing to clear or delete failed", err);
  }
}
