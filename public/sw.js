/* Manufacturing OS service worker — Field Mode v1.
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
 *
 * Hard rule: every fetch handler MUST resolve to a real Response. A handler
 * that resolves to `undefined` (or rejects) makes the browser fail the whole
 * request with "Failed to convert value to 'Response'" — which previously
 * broke navigations to pages that weren't cached yet. Each branch below ends
 * in a guaranteed synthetic Response so that can never happen again.
 */

const VERSION = "mfgos-v3";
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

function emptyResponse() {
  return new Response("", { status: 504, statusText: "Offline" });
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
        } catch {
          return emptyResponse();
        }
      })(),
    );
    return;
  }

  // Other same-origin GETs → stale-while-revalidate.
  event.respondWith(
    (async () => {
      const cached = await caches.match(request);
      const network = fetch(request)
        .then((res) => {
          cachePut(RUNTIME_CACHE, request, res);
          return res;
        })
        .catch(() => undefined);
      // Serve cache immediately if present (network refreshes in the
      // background); otherwise wait for the network; otherwise a safe stub.
      return cached || (await network) || emptyResponse();
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
