/**
 * Service worker — offline read cache.
 *
 * Deliberately narrow. A planner that shows a stale schedule as though it were
 * current is worse than one that says it's offline, so:
 *   - Navigations are network-first and only fall back to cache when the
 *     network genuinely fails.
 *   - API and auth requests are never cached at all.
 *   - Nothing is ever written offline. Mutations require the network, because
 *     a queued write replayed hours later could reshuffle a schedule the
 *     student has since acted on.
 */

const CACHE = "ib-calendar-os-v1";
const SHELL = ["/calendar", "/tasks", "/review"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Never cache anything carrying a session or hitting the database.
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/auth/")) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
          return response;
        })
        .catch(() => caches.match(request).then((hit) => hit ?? caches.match("/calendar"))),
    );
    return;
  }

  // Static assets are immutable and safe to serve cache-first.
  if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith(
      caches.match(request).then(
        (hit) =>
          hit ??
          fetch(request).then((response) => {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
            return response;
          }),
      ),
    );
  }
});
