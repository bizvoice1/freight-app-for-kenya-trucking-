/**
 * Behari Freight — Service Worker
 * --------------------------------
 * Strategy: network-first with cache fallback.
 * - App shell (HTML, JS bundles) served from cache when offline.
 * - API requests always go to the network (no stale data).
 */

const CACHE_VERSION = "behari-v1";
const PRECACHE = ["/", "/index.html"];

/* Install — precache the app shell */
self.addEventListener("install", (e) => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => {
      return cache.addAll(PRECACHE).catch(() => {
        // During development the shell may not exist yet — ignore
      });
    })
  );
});

/* Activate — remove old caches */
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== CACHE_VERSION)
          .map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

/* Fetch — network first, cache fallback */
self.addEventListener("fetch", (e) => {
  // Skip non-GET and cross-origin requests
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;

  e.respondWith(
    fetch(e.request)
      .then((res) => {
        // Clone and cache successful responses
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE_VERSION).then((c) => c.put(e.request, clone));
        }
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
