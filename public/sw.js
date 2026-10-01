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
 *   - Same-origin GET data (non-API): network-first with cache fallback, so
 *     it is fresh online and still available offline.
 *
 * Deliberately NOT cached (v6, XEDGE-6): cross-origin requests (Supabase, R2
 * signed URLs, Stripe, fonts), any non-GET request, ANY same-origin /api/
 * response (the JSON that carries a signed URL, the streamed share PDF), and
 * any response the server marked Cache-Control: no-store or private. Signed
 * URLs expire and auth must always hit the network, so we never serve those
 * from cache — and a bearer credential or a controlled document must never
 * sit in a device-wide cache that outlives the session (see the SESSION and
 * SIGN_OUT messages below).
 *
 * v7 (public-surfaces PKG-1 SW-OFFLINE): a stated NEVER_CACHE list — the four
 * verify routes and their four scan-landing pages, share, storage,
 * transmittal and intake, the public token pages and the /d/ short link — is
 * never written AND never read back, even as a leftover (a cached CURRENT
 * certified the past: OFF-1), and a QR scan that cannot reach the server is
 * answered with that page's own "can't verify" screen; no URL whose
 * query carries code= or a token parameter, no request with an Authorization
 * header, no redirected response and no identity-varying response is stored
 * (OFF-6/8/10); RUNTIME_CACHE is bounded — 200 entries, 7 days, 2 MiB per entry, least
 * recently used first (OFF-9); the shell is precached per asset (OFF-12); a
 * new worker WAITS for the page's "Update available" tap (OFF-4); VERSION
 * carries the deployed build id (OFF-11); and the worker tells the page when
 * the network stops or starts answering, so "offline" is not navigator.onLine
 * alone (OFF-3). Its footprint is observable: post { type: "CACHE_STATS" }
 * (with a MessagePort, or from a page) and it answers entries, bytes, limits
 * and any shell asset it is missing.
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

// A new VERSION drops every old cache on activate. It has two parts (OFF-11):
//
// SW_SCHEMA — the caching-behaviour generation, bumped by hand whenever what
// the worker stores or serves changes (v4: RSC payloads are never cached; data
// GETs are network-first — stale-while-revalidate was serving old app
// navigations. v5: stop inventing 504s — see the honesty rule below. v6:
// no-store / private and every /api/ response stay OUT of the cache, and the
// cache no longer outlives the session — XEDGE-6. v7: the never-cache list,
// the bounded runtime cache, no install-time skipWaiting — PKG-1 SW-OFFLINE).
// lib/__tests__/sw.test.ts fingerprints this file's code per schema, so a
// behaviour change that forgets the bump fails CI.
//
// SW_BUILD — the deployed build id, written at `prebuild` by
// scripts/stamp-sw-version.mjs from VERCEL_GIT_COMMIT_SHA ?? VERCEL_DEPLOYMENT_ID
// (the id /api/version serves), so every deploy changes this file's bytes: the
// browser installs a new worker, the page offers "Update available", and on
// activation the previous build's caches are dropped. With neither variable
// (next dev, a local build, the Docker image) the script leaves the committed
// "unstamped" in place — deterministic, and the tracked file is never
// rewritten; those deployments roll the caches only on a SW_SCHEMA bump.
// Keep the SW_BUILD line exactly as it is: the script refuses a worker
// without exactly one.
const SW_SCHEMA = 7;
const SW_BUILD = "unstamped";
const VERSION = `mfgos-v${SW_SCHEMA}-${SW_BUILD}`;
const SHELL_CACHE = `${VERSION}-shell`;
const RUNTIME_CACHE = `${VERSION}-runtime`;
// The signed-in identity the worker last saw (see rememberSession below).
const SESSION_CACHE = `${VERSION}-session`;
const SESSION_KEY = "/__mfgos/session";

const SHELL_ASSETS = ["/", "/offline", "/icon.svg", "/manifest.webmanifest"];

// RUNTIME_CACHE budget (OFF-9): at most this many entries, none older than
// this, none larger than this. Trimmed least-recently-used first on every
// write; expired entries are refused on read and swept on write (hourly).
const MAX_RUNTIME_ENTRIES = 200;
const MAX_RUNTIME_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_RUNTIME_ENTRY_BYTES = 2 * 1024 * 1024;
const EXPIRY_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
// Stored on each runtime entry: when it was fetched, and its size.
const CACHED_AT_HEADER = "X-Mfgos-Cached-At";
const BYTES_HEADER = "X-Mfgos-Bytes";

/** Precache the offline shell one asset at a time (OFF-12). cache.addAll is
 *  all-or-nothing, and its failure used to be swallowed — one 404 left the
 *  device with no shell and no sign of why. Returns the assets that failed,
 *  and names them in a console warning. Never rejects: a worker without a
 *  shell still serves the network and the inline offline page. */
async function precacheShell(onlyMissing) {
  let cache;
  try {
    cache = await caches.open(SHELL_CACHE);
  } catch {
    return SHELL_ASSETS.slice();
  }
  let assets = SHELL_ASSETS;
  if (onlyMissing) {
    const have = await Promise.all(assets.map((a) => cache.match(a).catch(() => undefined)));
    assets = assets.filter((_, i) => !have[i]);
  }
  const results = await Promise.allSettled(assets.map((a) => cache.add(a)));
  const failed = assets.filter((_, i) => results[i].status === "rejected");
  if (failed.length) {
    console.warn(`[sw] offline shell precache failed for ${failed.join(", ")} — offline navigations fall back to a plain notice until the next install or sign-in re-warms it`);
  }
  return failed;
}

// No skipWaiting here (OFF-4): a new worker installs and then WAITS, so the
// page's "Update available" tap (the SKIP_WAITING message below) is what
// activates it — or every tab of the old build closing. Taking over at
// install seized open tabs mid-task and left the tap with nothing to do.
self.addEventListener("install", (event) => {
  event.waitUntil(precacheShell(false));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => !k.startsWith(`${VERSION}-`))
            .map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

// Allow the page to tell a freshly-installed worker to take over immediately,
// (v6) to tell it who is signed in / that nobody is any more, and (v7) to ask
// what it last saw of the network and how much it holds.
self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") { self.skipWaiting(); return; }
  const msg = event.data;
  if (!msg || typeof msg !== "object") return;
  let work;
  if (msg.type === "SIGN_OUT") work = forgetSession();
  else if (msg.type === "SESSION" && typeof msg.id === "string" && msg.id) work = rememberSession(msg.id);
  else if (msg.type === "NETWORK_STATUS") {
    if (networkOk !== null) reply(event, { type: "NETWORK", ok: networkOk });
    return;
  } else if (msg.type === "CACHE_STATS") work = cacheStats().then((stats) => reply(event, stats));
  if (work && event.waitUntil) event.waitUntil(work);
});

/** Answer the page that asked — on its MessagePort when it sent one. */
function reply(event, payload) {
  try {
    const target = (event.ports && event.ports[0]) || event.source;
    if (target && target.postMessage) target.postMessage(payload);
  } catch { /* the asking page is gone */ }
}

/* ─── The cache does not outlive the session (v6, XEDGE-6) ─────────────────
 * RUNTIME_CACHE is device-wide: on a shared field tablet the next person would
 * otherwise be served the previous person's pages from disk, and a cached copy
 * outlived the share revocation that was its only kill switch. The page posts
 * SIGN_OUT before tearing the session down, and SESSION (with the signed-in
 * uid) once it knows who is in; the identity the worker last saw lives in its
 * own tiny cache so it survives the worker being stopped and restarted. An
 * identity the worker has never seen, or a different one, purges everything
 * cached at runtime. The shell cache (hashed build assets, the offline page)
 * carries no data and is left alone here (sign-out in RoleContext deletes
 * every cache, the shell included; the next SESSION re-warms it — OFF-8,
 * OFF-12). Everything here is best-effort: a cache
 * that cannot be read counts as "unknown", which purges. */
function purgeRuntimeCache() {
  return caches.delete(RUNTIME_CACHE).catch(() => undefined);
}
async function forgetSession() {
  try {
    const cache = await caches.open(SESSION_CACHE);
    await cache.delete(SESSION_KEY);
  } catch { /* nothing remembered */ }
  await purgeRuntimeCache();
}
async function rememberSession(id) {
  let previous = null;
  let cache = null;
  try {
    cache = await caches.open(SESSION_CACHE);
    const stored = await cache.match(SESSION_KEY);
    previous = stored ? await stored.text() : null;
  } catch { previous = null; }
  if (previous === null || previous !== id) {
    await purgeRuntimeCache();
    try { if (cache) await cache.put(SESSION_KEY, new Response(id)); } catch { /* best-effort */ }
  }
  // A sign-out empties every cache on the device (RoleContext, OFF-8) — the
  // offline shell included; the next sign-in puts back whatever is missing.
  // LAST, after the identity check: a shell fetch has no timeout, and a
  // changed identity's purge must never wait behind the network.
  await precacheShell(true);
}

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
      '<p style="color:#94a3b8;margin:0">This page isn’t available offline. Reconnect and try again.</p>' +
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

/* ─── An offline QR scan gets the page's own fail-safe (OFF-1) ─────────────
 * The four scan-landing pages are dynamic routes: Next renders them on demand
 * and serves them `private, no-cache, no-store`, which isCacheableResponse
 * refuses — so no cached page shell exists to reach the page's "can't verify"
 * branch, and an offline scan used to land on the generic offline page with
 * no word about the print or the tag in the worker's hand. The worker answers
 * a verify navigation it cannot complete itself: the page's own heading and
 * the page's own instruction, on the page's neutral background, never a
 * coloured verdict. Keep `title` and `instruction` identical to each page's
 * error branch — lib/__tests__/sw.test.ts reads the four pages and fails on
 * drift. */
const VERIFY_PAGES = [
  { prefix: "/verify/", title: "Can't verify this code", instruction: "If this QR came from a printed drawing, contact Document Control before using the print." },
  { prefix: "/verify-hold/", title: "Can't verify this tag", instruction: "Treat the hold as ACTIVE until Document Control confirms otherwise." },
  { prefix: "/verify-package/", title: "Can't verify this code", instruction: "If this QR came from a printed pack, contact Document Control before working from it." },
  { prefix: "/verify-ticket/", title: "Can't verify this code", instruction: "If this QR came from an issued deliverable, contact the requester before using the copy." },
];

function verifyPageFor(path) {
  return VERIFY_PAGES.find((p) => path.startsWith(p.prefix));
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function verifyFailSafeResponse(page, url) {
  return new Response(
    '<!doctype html><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">' +
      `<title>${escapeHtml(page.title)}</title>` +
      '<body style="font:16px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#0f172a;color:#e2e8f0">' +
      '<div style="text-align:center;padding:1.5rem;max-width:24rem">' +
      `<h1 style="font-size:1.5rem;margin:0 0 .5rem">${escapeHtml(page.title)}</h1>` +
      '<p style="margin:0;opacity:.8">You’re offline — this can only be checked against the live record. Reconnect and try again.</p>' +
      `<p style="margin:1rem 0 0;font-size:.875rem;font-weight:700">${escapeHtml(page.instruction)}</p>` +
      `<a href="${escapeHtml(url.pathname + url.search)}" style="display:inline-block;margin-top:1.5rem;padding:.5rem 1rem;border-radius:9999px;background:rgba(255,255,255,.15);color:#fff;font-size:.875rem;font-weight:700;text-decoration:none">Try again</a>` +
      "</div></body>",
    { status: 503, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } },
  );
}

/** A request the browser itself gave up on — the user navigated away, the
 *  router cancelled a prefetch, the tab was throttled. There is nothing to
 *  report: synthesizing a response for it invents a server error that never
 *  happened, and the console line is indistinguishable from a real outage. */
function wasAborted(request, err) {
  if (request && request.signal && request.signal.aborted) return true;
  return !!err && err.name === "AbortError";
}

/** Never cached and never served from cache, whatever the response says
 *  (v7, PKG-1 SW-OFFLINE) — matched as path prefixes:
 *
 *    /api/verify…    the four QR verify routes (verify, -hold, -package,
 *                    -ticket): a cached CURRENT replayed offline certified
 *                    the past, and made the page's fail-safe "can't verify"
 *                    branch unreachable (OFF-1)
 *    /verify/, /verify-hold/, /verify-package/, /verify-ticket/
 *                    the scan-landing pages: dynamic and no-store, so never
 *                    stored anyway; offline the worker answers them with
 *                    the page's own fail-safe screen (VERIFY_PAGES above),
 *                    never with a leftover of the page (OFF-1)
 *    /api/share/, /share/            share links: revocation and expiry are
 *                    enforced only at the route, and every access is a
 *                    distribution record (OFF-5, OFF-7, SHR-9)
 *    /api/storage/   Authorization-gated presigned URLs (OFF-6)
 *    /api/transmittal, /transmittal/  the transmittal portal: token-gated,
 *                    and its downloads write the audit row (OFF-6, OFF-7)
 *    /api/intake/, /submit/          the contractor intake portal (token-gated)
 *    /d/             the printed short link — it always redirects (OFF-10)
 *
 *  Every /api/ path is refused below anyway; this list is stated on its own
 *  so it holds even if an API path is ever allow-listed (DEC-44 §3 Reversal),
 *  and because the public token and scan-landing pages are not /api/ paths. */
const NEVER_CACHE_PREFIXES = [
  "/api/verify",
  "/verify/",
  "/verify-hold/",
  "/verify-package/",
  "/verify-ticket/",
  "/api/share/",
  "/share/",
  "/api/storage/",
  "/api/transmittal",
  "/transmittal/",
  "/api/intake/",
  "/submit/",
  "/d/",
];

/** A URL that carries a credential in its query — the OAuth / PKCE return
 *  (`/?code=…`), a magic-link or reset token, a share or portal token — is
 *  never written to disk (OFF-8). */
function carriesCredential(url) {
  for (const name of url.searchParams.keys()) {
    if (name === "code" || /token/i.test(name)) return true;
  }
  return false;
}

/** Same-origin API responses are never cached, whatever their headers say
 *  (v6, XEDGE-6): /api/storage/download-url answers with a bearer URL,
 *  /api/share/file streams a controlled PDF, and a cached copy of either is
 *  replayable by whoever holds the device after a revocation, a supersession
 *  or a sign-out. The allow-list is empty on purpose — a path goes on it only
 *  with a stated reason that its payload is safe to replay offline. */
const CACHEABLE_API_PREFIXES = [];
function isCacheableRequest(request) {
  try {
    const url = new URL(request.url);
    const path = url.pathname;
    if (NEVER_CACHE_PREFIXES.some((p) => path.startsWith(p))) return false;
    if (carriesCredential(url)) return false;
    // A request that authenticates itself by header answers for ONE identity;
    // the Cache API keys on the URL alone (OFF-6).
    if (request.headers && request.headers.get && request.headers.get("Authorization")) return false;
    if (!path.startsWith("/api/")) return true;
    return CACHEABLE_API_PREFIXES.some((p) => path.startsWith(p));
  } catch {
    return false;
  }
}

/** The whole cacheability decision: a complete, non-opaque, OK, not
 *  redirected response to a cacheable request that the server did not mark
 *  no-store / no-cache / private and that does not vary by identity.
 *  Cache-Control is honoured HERE because Cache Storage does not honour it
 *  for us — cache.put() stores whatever it is handed — and an offline
 *  fallback can never revalidate, so no-cache is refused too (SHR-9). A
 *  redirected response is never stored (OFF-10): served for a navigation it
 *  is refused by the browser. */
function isCacheableResponse(request, response) {
  if (!response || !response.ok || response.type === "opaque" || response.redirected) return false;
  if (!isCacheableRequest(request)) return false;
  const header = (name) => (response.headers && response.headers.get(name)) || "";
  const cc = header("Cache-Control");
  if (/\b(?:no-store|no-cache|private)\b/i.test(cc)) return false;
  if (/\*|\bauthorization\b|\bcookie\b/i.test(header("Vary"))) return false;
  return true;
}

// Best-effort cache write. Only stores cacheable responses (above), never
// rejects into the response path, and returns a promise the fetch event keeps
// alive until the write is done.
function cachePut(cacheName, request, response) {
  if (!isCacheableResponse(request, response)) return Promise.resolve();
  const copy = response.clone();
  const write = cacheName === RUNTIME_CACHE
    ? putRuntime(request, copy)
    : caches.open(cacheName).then((c) => c.put(request, copy));
  return write.catch(() => undefined);
}

/* ─── The runtime cache is bounded (OFF-9) ─────────────────────────────────
 * Every entry is stored with the time it was fetched and its size. An entry
 * above MAX_RUNTIME_ENTRY_BYTES is never stored; past MAX_RUNTIME_AGE_MS it is
 * never served (and is deleted); past MAX_RUNTIME_ENTRIES the least recently
 * used go first — Cache Storage keeps entries in the order they were last
 * written, and serving one offline re-writes it at the end. */
async function putRuntime(request, response) {
  const declared = Number(response.headers.get("Content-Length"));
  if (declared > MAX_RUNTIME_ENTRY_BYTES) return;
  const body = await response.blob();
  if (body.size > MAX_RUNTIME_ENTRY_BYTES) return;
  const headers = new Headers(response.headers);
  headers.set(CACHED_AT_HEADER, String(Date.now()));
  headers.set(BYTES_HEADER, String(body.size));
  const cache = await caches.open(RUNTIME_CACHE);
  await cache.put(request, new Response(body, { status: response.status, statusText: response.statusText, headers }));
  await trimRuntime(cache);
}

function isFresh(response) {
  const at = Number(response.headers.get(CACHED_AT_HEADER));
  return at > 0 && Date.now() - at <= MAX_RUNTIME_AGE_MS;
}

let lastExpirySweep = 0;
async function trimRuntime(cache) {
  let keys = await cache.keys();
  if (Date.now() - lastExpirySweep >= EXPIRY_SWEEP_INTERVAL_MS) {
    lastExpirySweep = Date.now();
    const kept = [];
    for (const key of keys) {
      const hit = await cache.match(key);
      if (hit && isFresh(hit)) kept.push(key);
      else await cache.delete(key);
    }
    keys = kept;
  }
  for (let i = 0; i < keys.length - MAX_RUNTIME_ENTRIES; i++) await cache.delete(keys[i]);
}

/** A fresh runtime entry for this request, marked as just used; undefined
 *  for a miss, and an expired entry is deleted rather than served. */
async function matchRuntime(request) {
  let hit;
  try {
    hit = await caches.match(request, { cacheName: RUNTIME_CACHE });
  } catch {
    return undefined;
  }
  if (!hit) return undefined;
  const fresh = isFresh(hit);
  try {
    const cache = await caches.open(RUNTIME_CACHE);
    if (fresh) await cache.put(request, hit.clone());
    else await cache.delete(request);
  } catch { /* best-effort */ }
  return fresh ? hit : undefined;
}

async function matchShell(request) {
  try {
    return await caches.match(request, { cacheName: SHELL_CACHE });
  } catch {
    return undefined;
  }
}

/** What the worker may answer from disk when the network fails: never
 *  anything on the never-cache list (not even a leftover from an older
 *  worker), else a fresh runtime entry, else the shell's copy. */
async function cachedFallback(request) {
  if (!isCacheableRequest(request)) return undefined;
  return (await matchRuntime(request)) || (await matchShell(request));
}

/** The worker's footprint (OFF-9): post { type: "CACHE_STATS" } to read it. */
async function cacheStats() {
  let entries = 0;
  let bytes = 0;
  let oldestCachedAt = null;
  try {
    const cache = await caches.open(RUNTIME_CACHE);
    const keys = await cache.keys();
    entries = keys.length;
    for (const key of keys) {
      const hit = await cache.match(key);
      if (!hit) continue;
      bytes += Number(hit.headers.get(BYTES_HEADER)) || 0;
      const at = Number(hit.headers.get(CACHED_AT_HEADER));
      if (at > 0 && (oldestCachedAt === null || at < oldestCachedAt)) oldestCachedAt = at;
    }
  } catch { /* report what was read */ }
  const shell = await Promise.all(SHELL_ASSETS.map((a) => matchShell(a)));
  return {
    type: "CACHE_STATS",
    version: VERSION,
    entries,
    bytes,
    oldestCachedAt,
    maxEntries: MAX_RUNTIME_ENTRIES,
    maxAgeMs: MAX_RUNTIME_AGE_MS,
    maxEntryBytes: MAX_RUNTIME_ENTRY_BYTES,
    shellMissing: SHELL_ASSETS.filter((_, i) => !shell[i]),
  };
}

/* ─── Reachability (OFF-3) ──────────────────────────────────────────────────
 * navigator.onLine reports "online" on plant Wi-Fi that is associated but has
 * no route out — the most common way a field device is offline. The worker
 * sees every same-origin request it handles, so it tells every window when
 * the network stops answering and when it answers again (one message per
 * change; an aborted request says nothing about the network). "Answers
 * again" is taken only from navigations and data GETs, whose responses must
 * come from the server: a static asset can be answered by the browser's HTTP
 * cache while the device has no route out, so that branch reports failures
 * only. */
let networkOk = null;
function reportNetwork(ok) {
  if (networkOk === ok) return;
  networkOk = ok;
  try {
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((windows) => windows.forEach((w) => w.postMessage({ type: "NETWORK", ok })))
      .catch(() => undefined);
  } catch { /* no clients API */ }
}

/** Keep the worker alive until a cache write finishes. */
function keepAlive(event, work) {
  try {
    if (event.waitUntil) event.waitUntil(work);
  } catch { /* the event already settled — the write stays best-effort */ }
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
          reportNetwork(true);
          keepAlive(event, cachePut(RUNTIME_CACHE, request, res));
          return res;
        } catch (err) {
          // A navigation the browser itself abandoned (the user tapped
          // another link, hit stop) is not an outage: rethrow it rather than
          // invent an offline page for it (hard rule 2; OFF-10).
          if (wasAborted(request, err)) throw err;
          reportNetwork(false);
          // A QR scan that cannot reach the server gets that page's own
          // "can't verify" screen — not the generic offline page, never a
          // stored copy of the page (OFF-1).
          const verifyPage = verifyPageFor(url.pathname);
          if (verifyPage) return verifyFailSafeResponse(verifyPage, url);
          // Each match is awaited so a missing entry (undefined) actually falls
          // through to the next option instead of short-circuiting on a Promise.
          return (
            (await cachedFallback(request)) ||
            (await matchShell("/offline")) ||
            (await matchShell("/")) ||
            offlineHtmlResponse()
          );
        }
      })(),
    );
    return;
  }

  // Static assets (Next build output, images, icon) → cache-first. A path on
  // the never-cache list is never routed here, whatever its extension.
  if (
    (url.pathname.startsWith("/_next/static/") ||
      /\.(?:js|css|woff2?|png|jpg|jpeg|svg|ico|webp)$/.test(url.pathname)) &&
    isCacheableRequest(request)
  ) {
    event.respondWith(
      (async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        try {
          const res = await fetch(request);
          // No reportNetwork(true) here: a hashed asset can resolve from the
          // browser's HTTP cache with no network at all (OFF-3).
          keepAlive(event, cachePut(SHELL_CACHE, request, res));
          return res;
        } catch (err) {
          // A cancelled asset fetch is the browser's business, not an error
          // we should invent a status code for.
          if (wasAborted(request, err)) throw err;
          reportNetwork(false);
          return unavailableResponse();
        }
      })(),
    );
    return;
  }

  // Other same-origin GETs → network-first with cache fallback. (Was
  // stale-while-revalidate, which quietly served outdated app data right
  // after deploys; fresh-when-online + cached-when-offline is the contract
  // Field Mode actually needs.) /api/ responses and the never-cache list are
  // never stored and never replayed — see isCacheableRequest — so offline
  // they fail honestly and the page's own error branch runs.
  event.respondWith(
    (async () => {
      try {
        const res = await fetch(request);
        reportNetwork(true);
        keepAlive(event, cachePut(RUNTIME_CACHE, request, res));
        return res;
      } catch (err) {
        if (wasAborted(request, err)) throw err;
        reportNetwork(false);
        const cached = await cachedFallback(request);
        if (cached) return cached;
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
