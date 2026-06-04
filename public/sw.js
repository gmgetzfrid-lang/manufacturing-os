/* Manufacturing OS service worker — minimal + safe (v4).
 *
 * Hard lesson: an aggressive worker that intercepted navigations, API/RSC
 * requests, and dynamic data caused repeated breakage — stale content and
 * synthetic "504 (Offline)" / offline-page responses that broke navigation and
 * blocked drafting-request uploads. This worker does only what's unambiguously
 * safe and NEVER fabricates a response:
 *
 *   - Cache-first ONLY for immutable, content-hashed build assets
 *     (/_next/static/...) and static icons/images. A given URL there never
 *     changes, so the cache can't serve anything stale or broken.
 *   - EVERYTHING ELSE is left entirely to the browser: navigations, API calls,
 *     RSC payloads, Supabase/R2, uploads, and real network errors behave
 *     exactly as if there were no service worker. The SW calls respondWith only
 *     for cacheable static assets, so it can never turn a network hiccup into a
 *     fake 504 or an offline stub.
 */

const VERSION = "mfgos-v4";
const STATIC_CACHE = `${VERSION}-static`;

self.addEventListener("install", () => {
  // Activate immediately so users leave the old, problematic worker behind.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});

function isImmutableAsset(url) {
  try {
    const u = new URL(url);
    if (u.origin !== self.location.origin) return false;
    if (u.pathname.startsWith("/_next/static/")) return true;
    return /\.(?:js|css|woff2?|png|jpg|jpeg|gif|svg|ico|webp)$/.test(u.pathname);
  } catch {
    return false;
  }
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  // Only ever handle GETs for immutable, same-origin static assets. Everything
  // else passes straight through to the network untouched.
  if (request.method !== "GET" || !isImmutableAsset(request.url)) return;

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(STATIC_CACHE).then((c) => c.put(request, copy)).catch(() => {});
        }
        return res;
      });
      // No synthetic fallback: if an asset fetch fails, the promise rejects and
      // the browser surfaces a real network error — never a fabricated stub.
    }),
  );
});
