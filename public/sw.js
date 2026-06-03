/* Manufacturing OS service worker — Field Mode v0.
 *
 * Goal: keep the installed PWA usable when the plant network drops. This is a
 * conservative, safe caching layer:
 *
 *   - App shell + static assets: cache-first, so the UI boots offline.
 *   - Same-origin navigations: network-first with an offline fallback page,
 *     so you always get fresh content online and a graceful screen offline.
 *   - Same-origin GET API/data: stale-while-revalidate, so recently-viewed
 *     data is available offline and refreshes in the background online.
 *
 * Deliberately NOT cached: cross-origin requests (Supabase, R2 signed URLs,
 * Stripe, fonts) and any non-GET request. Signed URLs expire and auth must
 * always hit the network, so we never serve those from cache.
 */

const VERSION = "mfgos-v1";
const SHELL_CACHE = `${VERSION}-shell`;
const RUNTIME_CACHE = `${VERSION}-runtime`;

const SHELL_ASSETS = ["/", "/offline", "/icon.svg", "/manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_ASSETS).catch(() => undefined))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => !k.startsWith(VERSION))
            .map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

// Allow the page to tell a freshly-installed worker to take over immediately.
self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});

function isSameOrigin(url) {
  return new URL(url).origin === self.location.origin;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  if (!isSameOrigin(request.url)) return; // never touch Supabase/R2/Stripe/fonts

  // HTML navigations → network-first, fall back to cache, then offline page.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(RUNTIME_CACHE).then((c) => c.put(request, copy));
          return res;
        })
        .catch(() =>
          caches
            .match(request)
            .then((cached) => cached || caches.match("/offline") || caches.match("/")),
        ),
    );
    return;
  }

  const url = new URL(request.url);

  // Static assets (Next build output, images, icon) → cache-first.
  if (
    url.pathname.startsWith("/_next/static/") ||
    /\.(?:js|css|woff2?|png|jpg|jpeg|svg|ico|webp)$/.test(url.pathname)
  ) {
    event.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ||
          fetch(request).then((res) => {
            const copy = res.clone();
            caches.open(SHELL_CACHE).then((c) => c.put(request, copy));
            return res;
          }),
      ),
    );
    return;
  }

  // Other same-origin GETs → stale-while-revalidate.
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(RUNTIME_CACHE).then((c) => c.put(request, copy));
          return res;
        })
        .catch(() => cached);
      return cached || network;
    }),
  );
});
