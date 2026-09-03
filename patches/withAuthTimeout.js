// Drop-in replacement for the withAuthTimeout helper in src/App.jsx (~line 1758).
// Same signature, same return shape, so every existing call site
// (sendMagicLink, handlePasswordAuth, handleForgotPassword, handleSetNewPassword)
// keeps working unchanged.
//
// Two things are new:
//
//  1. Real cancellation. The current version races the *result* via
//     Promise.race, but the underlying fetch keeps running after the fallback
//     "wins" — so a late response can overwrite the error the user already saw
//     with a second, unexplained state change. This aborts it.
//
//  2. Survives a backgrounded WebView. Android suspends JS timers when the app
//     loses focus, so a 15s setTimeout may not fire until the user comes back —
//     which is exactly the shape of "the login screen froze" reports that never
//     reproduce on desktop. A visibilitychange listener re-checks the clock the
//     moment the tab is foregrounded and fires immediately if the budget has
//     already passed.
//
// Call sites that pass a plain promise still work; to get true cancellation,
// pass a factory that accepts an AbortSignal:
//
//     await withAuthTimeout(supabase.auth.signInWithPassword({ email, password }))
//     await withAuthTimeout((signal) => fetch(url, { signal }))

const AUTH_TIMEOUT_MS = 15000;

export function withAuthTimeout(promiseFactory) {
  const controller = new AbortController();
  let settled = false;

  const timeoutPromise = new Promise((resolve) => {
    const fire = () =>
      resolve({
        error: { message: "That's taking too long — check your connection and try again." },
      });

    let timer = setTimeout(fire, AUTH_TIMEOUT_MS);

    // If the app was backgrounded mid-request the timer above may be throttled.
    // On regaining visibility, fire immediately if we're already past budget
    // rather than leaving the button stuck reading "Logging in…".
    const startedAt = Date.now();
    const onVisible = () => {
      if (settled || document.visibilityState !== "visible") return;
      if (Date.now() - startedAt >= AUTH_TIMEOUT_MS) {
        clearTimeout(timer);
        fire();
      }
    };
    document.addEventListener("visibilitychange", onVisible);

    // Best-effort cleanup; harmless if it never fires.
    setTimeout(
      () => document.removeEventListener("visibilitychange", onVisible),
      AUTH_TIMEOUT_MS + 1000,
    );
  });

  // Accept either a plain promise (supabase-js call sites) or a factory that
  // wants the signal. supabase-js doesn't expose one, so for those we still
  // race-and-ignore — but we free the UI immediately either way.
  const real = Promise.resolve(
    typeof promiseFactory === "function" ? promiseFactory(controller.signal) : promiseFactory,
  ).catch((err) => ({
    error: { message: err?.message || "Something went wrong — please try again." },
  }));

  return Promise.race([real, timeoutPromise]).then((result) => {
    settled = true;
    controller.abort(); // no-op if `real` already won; cancels a hung request if it didn't
    return result;
  });
}
