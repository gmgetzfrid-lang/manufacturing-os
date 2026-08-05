/* Manufacturing OS service worker — Field Mode v1.
 *
 * Goal: keep the installed PWA usable when the plant network drops. This is a
 * conservative, safe caching layer:
 *
 *   - App shell + static assets: cache-first (hashed filenames are
 *     immutable), so the UI boots offline.
 *   - Same-origin navigations: network-first with an offline fallback page,
 *     so you always get fresh content online and a graceful screen offline.
 *   - Next.js RSC navigation payloads: NEVER cached — they pin specific
 *     build chunks, and a stale one runs old app code after a deploy.
 *   - Same-origin GET API/data: network-first with cache fallback, so data
 *     is fresh online and recently-viewed screens still work offline.
 *
 * Deliberately NOT cached: cross-origin requests (Supabase, R2 signed URLs,
 * Stripe, fonts) and any non-GET request. Signed URLs expire and auth must
 * always hit the network, so we never serve those from cache.
 *
 * Hard rule 1: a handler passed to respondWith() must never RESOLVE to
 * `undefined` — the browser fails the request with "Failed to convert value to
 * 'Response'", which previously broke navigations to uncached pages. Every
 * branch below ends in a real Response or a rethrow.
 *
 * Hard rule 2 (v5): never invent a server error. Rejecting is legitimate —
 * the browser reports a network failure, which is the truth — but SYNTHESIZING
 * a status code is not. A cancelled prefetch dressed up as "504 (Offline)"
 * reads like the platform fell over, and it hands the Next router a malformed
 * payload where a clean failure would have triggered its own fallback. If we
 * cannot honestly serve a request, we either serve it from cache, fail it, or
 * return a 503 that says what it is.
 */

// Bumping VERSION drops every old cache on activate — the escape hatch when
// caching behavior changes (v4: RSC payloads are never cached; data GETs are
// network-first — stale-while-revalidate was serving old app navigations.
// v5: stop inventing 504s — see the honesty rule below).
const VERSION = "mfgos-v5";
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
  try {
    return new URL(url).origin === self.location.origin;
  } catch {
    return false;
  }
}

// Last-resort responses so respondWith() is never handed undefined / a rejection.
function offlineHtmlResponse() {
  return new Response(
    '<!doctype html><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width,initial-scale=1"><title>Offline</title>' +
      '<body style="font:16px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#0f172a;color:#e2e8f0">' +
      '<div style="text-align:center;padding:2rem">' +
      '<h1 style="font-size:1.25rem;margin:0 0 .5rem">You’re offline</h1>' +
      '<p style="color:#94a3b8;margin:0">This page isn’t cached yet. Reconnect and try again.</p>' +
      "</div></body>",
    { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

// For a sub-resource we genuinely cannot supply while offline. Carries a body
// and a content type so it is diagnosable in the network panel instead of
// looking like a mystery gateway timeout from the server.
function unavailableResponse() {
  return new Response("offline: not cached", {
    status: 503,
    statusText: "Offline",
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

/** A request the browser itself gave up on — the user navigated away, the
 *  router cancelled a prefetch, the tab was throttled. There is nothing to
 *  report: synthesizing a response for it invents a server error that never
 *  happened, and the console line is indistinguishable from a real outage. */
function wasAborted(request, err) {
  if (request && request.signal && request.signal.aborted) return true;
  return !!err && err.name === "AbortError";
}

// Best-effort cache write. Only stores complete, cacheable responses, and never
// rejects into the response path.
function cachePut(cacheName, request, response) {
  if (!response || !response.ok || response.type === "opaque") return;
  const copy = response.clone();
  caches.open(cacheName).then((c) => c.put(request, copy)).catch(() => undefined);
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  if (!isSameOrigin(request.url)) return; // never touch Supabase/R2/Stripe/fonts

  const url = new URL(request.url);

  // Next.js App Router client-side navigations fetch RSC payloads (same
  // origin GETs flagged by the RSC header / _rsc param). These reference
  // build-specific chunk files — serving one stale runs OLD app code and
  // throws hydration errors on every sidebar click after a deploy.
  //
  // We do not touch them AT ALL. Not intercepting achieves "never cached"
  // exactly, and it avoids two bugs the old `fetch().catch(stub)` caused:
  //
  //   The router prefetches links on hover and in the viewport, and cancels
  //   those prefetches freely — you moved the mouse, you navigated, the tab
  //   ran out of sockets during a bulk upload. Every one of those became a
  //   synthetic "504 (Offline)" in the console for a request nobody was
  //   waiting on. That is the 504 against a bare document UUID: a cancelled
  //   prefetch of /documents/<id>, reported as a server failure.
  //
  //   Worse, the stub was an EMPTY 504 handed to the router where an RSC
  //   flight payload was expected. A genuine network error makes the router
  //   fall back to a full page load; a malformed 200-shaped failure does not.
  //   Letting the request fail honestly is what the router is built for.
  const headers = request.headers;
  if (
    url.searchParams.has("_rsc") ||
    (headers && (headers.get("RSC") === "1" || headers.get("Next-Router-State-Tree")))
  ) {
    return;
  }

  // HTML navigations → network-first, fall back to cache, then offline page.
  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const res = await fetch(request);
          cachePut(RUNTIME_CACHE, request, res);
          return res;
        } catch {
          // Each match is awaited so a missing entry (undefined) actually falls
          // through to the next option instead of short-circuiting on a Promise.
          return (
            (await caches.match(request)) ||
            (await caches.match("/offline")) ||
            (await caches.match("/")) ||
            offlineHtmlResponse()
          );
        }
      })(),
    );
    return;
  }

  // Static assets (Next build output, images, icon) → cache-first.
  if (
    url.pathname.startsWith("/_next/static/") ||
    /\.(?:js|css|woff2?|png|jpg|jpeg|svg|ico|webp)$/.test(url.pathname)
  ) {
    event.respondWith(
      (async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        try {
          const res = await fetch(request);
          cachePut(SHELL_CACHE, request, res);
          return res;
        } catch (err) {
          // A cancelled asset fetch is the browser's business, not an error
          // we should invent a status code for.
          if (wasAborted(request, err)) throw err;
          return unavailableResponse();
        }
      })(),
    );
    return;
  }

  // Other same-origin GETs → network-first with cache fallback. (Was
  // stale-while-revalidate, which quietly served outdated app data right
  // after deploys; fresh-when-online + cached-when-offline is the contract
  // Field Mode actually needs.)
  event.respondWith(
    (async () => {
      try {
        const res = await fetch(request);
        cachePut(RUNTIME_CACHE, request, res);
        return res;
      } catch (err) {
        const cached = await caches.match(request);
        if (cached) return cached;
        if (wasAborted(request, err)) throw err;
        return unavailableResponse();
      }
    })(),
  );
});

/* ─── Web Push: scheduled reminders ──────────────────────────────────────
 * Shows the OS notification the reminder cron sends (fires whether the app is
 * open or closed). Clicking focuses an existing window or opens a new one. */
self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = {}; }
  const title = data.title || "Manufacturing OS";
  const options = {
    body: data.body || "",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    tag: data.tag || "mfgos-reminder",
    renotify: true,
    data: { url: data.url || "/" },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of all) {
        if ("focus" in client) {
          try { await client.navigate(target); } catch { /* cross-origin guard */ }
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(target);
    })(),
  );
});
