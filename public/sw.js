// SiteMargin service worker — enables "Add to Home Screen" installability
// and lets the app shell load when the connection drops mid-site-visit.
//
// Deliberately simple and conservative: it never caches Supabase API calls
// (different origin, and financial data must always be fresh), and it always
// tries the network first for the page itself so users never get stuck on a
// stale build. Static assets (JS/CSS/images/fonts) are cache-first once
// fetched once, since Vite fingerprints those filenames on every build.

const CACHE_NAME = "sitemargin-shell-v7";

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(
        names
          .filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;

  // Only handle same-origin GET requests. Everything else (Supabase API
  // calls, PayFast redirects, POSTs, etc.) goes straight to the network.
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) {
    return;
  }

  const isNavigation = request.mode === "navigate";

  if (isNavigation) {
    // Network-first for the page shell — always prefer a fresh build when
    // online, fall back to the last cached shell if offline.
    //
    // { cache: "no-store" } is the important part: a plain fetch() here
    // still follows normal HTTP caching, so this "network-first" strategy
    // could be silently satisfied out of the browser's own HTTP cache
    // instead of actually reaching the network — the service worker
    // *looks* like it's checking for a new build every time, but isn't.
    // That's almost certainly why hard-refreshing has been necessary:
    // this override forces every navigation to genuinely hit the server.
    event.respondWith(
      fetch(request, { cache: "no-store" })
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          return response;
        })
        .catch(() => caches.match(request).then((cached) => cached || caches.match("/")))
    );
    return;
  }

  // Cache-first for fingerprinted static assets.
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      });
    })
  );
});
