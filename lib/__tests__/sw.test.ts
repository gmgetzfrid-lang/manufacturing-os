// lib/__tests__/sw.test.ts
//
// Regression guard for the service worker (public/sw.js): every fetch branch
// must resolve to a real Response or rethrow. The old navigation handler could
// resolve to `undefined` when a page wasn't cached, which made the browser fail
// the request with "Failed to convert value to 'Response'" and broke navigation
// to /projects/[id]. These tests load the worker into a fake global scope and
// assert it always hands respondWith() a Response (or a rejection it owes the
// browser).
//
// document-control Round F — XEDGE-6 (DEC-44 §3): the worker is also a
// device-wide cache that used to outlive sign-out and ignore Cache-Control.
// It refuses to store any response marked no-store / private and ANY
// same-origin /api/ response (the signed-URL JSON, the streamed share PDF),
// never replays an /api/ entry offline, purges its runtime cache on a
// SIGN_OUT message and whenever the SESSION identity a page announces
// differs from the one it remembered.
//
// public-surfaces Round F — PKG-1 SW-OFFLINE (OFF-1…OFF-14, SHR-9). Written
// before the worker changed (OFF-14): the suite used to assert only that a
// branch "never resolves to undefined" — its cache mock's `put` was never
// inspected, so nothing about WHAT the worker stores was guarded. It now
// asserts, per branch: the never-cache list (the four verify routes and their
// scan-landing pages, share, storage, transmittal, intake, the public token
// pages, the /d/ short link) is never written and never read back
// (OFF-1/5/6/7, SHR-9), and an offline scan gets the verify page's own
// fail-safe screen (OFF-1 done-when 4); credential URLs,
// Authorization-bearing requests, redirected responses and identity-varying
// responses are never stored (OFF-6/8/10); an aborted navigation rethrows
// (OFF-10); RUNTIME_CACHE is bounded — 200 entries, 7 days, a per-entry size
// cap, LRU (OFF-9); the shell is precached per asset (OFF-12); install never
// skips waiting (OFF-4); VERSION carries the build id the prebuild script
// stamps and the committed worker is never a stamped one (OFF-11); and the
// worker reports real fetch failures so "offline" is not navigator.onLine
// alone (OFF-3). The page halves — the update toast (OFF-4), the offline copy
// (OFF-3) and the sign-out purge (OFF-8) — are pinned at the bottom.
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import ts from "typescript";
import { postServiceWorkerMessage, clearServiceWorkerSession, announceServiceWorkerSession } from "@/lib/swSession";
import { resolveBuildId, stampSource, UNSTAMPED } from "../../scripts/stamp-sw-version.mjs";
import {
  applyServiceWorkerUpdate, networkSignal, OFFLINE_PILL_TEXT, UPDATE_RELOAD_FALLBACK_MS,
} from "@/components/pwa/ServiceWorkerManager";

type Handler = (event: unknown) => void;
type Store = {
  entries: Map<string, Response>;
  put: ReturnType<typeof vi.fn<(req: unknown, res: Response) => Promise<void>>>;
  add: ReturnType<typeof vi.fn<(req: unknown) => Promise<void>>>;
  addAll: ReturnType<typeof vi.fn<() => Promise<undefined>>>;
  match: ReturnType<typeof vi.fn<(req: unknown) => Promise<Response | undefined>>>;
  delete: ReturnType<typeof vi.fn<(req: unknown) => Promise<boolean>>>;
  keys: ReturnType<typeof vi.fn<() => Promise<{ url: string }[]>>>;
};

const SW_PATH = resolve(process.cwd(), "public/sw.js");
const SW_SOURCE = readFileSync(SW_PATH, "utf8");
const SCHEMA = Number(SW_SOURCE.match(/^const SW_SCHEMA = (\d+);$/m)?.[1]);
const BUILD = SW_SOURCE.match(/^const SW_BUILD = "([^"\n]*)";$/m)?.[1];
const VERSION = `mfgos-v${SCHEMA}-${BUILD}`;
const SHELL = `${VERSION}-shell`;
const RUNTIME = `${VERSION}-runtime`;
const SESSION = `${VERSION}-session`;
const CACHED_AT = "X-Mfgos-Cached-At";
const BYTES = "X-Mfgos-Bytes";
const DAY = 24 * 60 * 60 * 1000;
const ORIGIN = "https://app.test";

/** Absolute URL key, the way Cache Storage resolves a relative request. */
const keyOf = (req: unknown) =>
  new URL(typeof req === "string" ? req : (req as { url: string }).url, ORIGIN).href;

function loadServiceWorker(opts: {
  fetchImpl: (req: unknown) => Promise<Response>;
  source?: string;
  now?: number;
}) {
  const handlers: Record<string, Handler> = {};
  const stores = new Map<string, Store>();
  const storeFor = (name: string): Store => {
    let s = stores.get(name);
    if (!s) {
      const entries = new Map<string, Response>();
      // Cache Storage keeps entries in last-written order: a put of an
      // existing key removes it and appends the new one.
      const write = (req: unknown, res: Response) => { const k = keyOf(req); entries.delete(k); entries.set(k, res); };
      s = {
        entries,
        put: vi.fn(async (req: unknown, res: Response) => { write(req, res); }),
        add: vi.fn(async (req: unknown) => {
          const res = await opts.fetchImpl({ url: keyOf(req), method: "GET" });
          if (!res.ok) throw new TypeError(`bad status ${res.status}`);
          write(req, res);
        }),
        addAll: vi.fn(async () => undefined),
        match: vi.fn(async (req: unknown) => entries.get(keyOf(req))?.clone()),
        delete: vi.fn(async (req: unknown) => entries.delete(keyOf(req))),
        keys: vi.fn(async () => [...entries.keys()].map((url) => ({ url }))),
      };
      stores.set(name, s);
    }
    return s;
  };
  const caches = {
    open: vi.fn(async (name: string) => storeFor(name)),
    match: vi.fn(async (req: unknown, o?: { cacheName?: string }) => {
      for (const name of o?.cacheName ? [o.cacheName] : [...stores.keys()]) {
        const hit = stores.get(name)?.entries.get(keyOf(req));
        if (hit) return hit.clone();
      }
      return undefined;
    }),
    keys: vi.fn(async () => [...stores.keys()]),
    delete: vi.fn(async (name: string) => stores.delete(name)),
  };
  const posted: unknown[] = [];
  const self = {
    addEventListener: (type: string, h: Handler) => { handlers[type] = h; },
    location: { origin: ORIGIN },
    skipWaiting: vi.fn(),
    clients: {
      claim: vi.fn(),
      matchAll: vi.fn(async () => [{ postMessage: (m: unknown) => posted.push(m) }]),
    },
  };
  const clock = { t: opts.now ?? Date.UTC(2026, 9, 1, 12) };
  const warn = vi.fn();
  // The worker is a classic script that reads bare globals (self, caches, fetch,
  // Response, URL, Date, console); a Function factory is the cleanest way to
  // inject mocks — including a clock the TTL tests can move.
  const factory = new Function("self", "caches", "fetch", "Response", "URL", "Date", "console", opts.source ?? SW_SOURCE);
  factory(self, caches, opts.fetchImpl, globalThis.Response, globalThis.URL, { now: () => clock.t }, { warn, log: () => undefined, error: () => undefined });
  /** Every cache write the worker performed, across every cache name. */
  const puts = () => [...stores.values()].flatMap((s) => s.put.mock.calls.map((c) => keyOf(c[0])));
  /** Deliver a message and await whatever the worker asked to keep alive. */
  const message = async (data: unknown, extra: Record<string, unknown> = {}) => {
    let pending: Promise<unknown> | undefined;
    handlers.message!({ data, waitUntil: (p: Promise<unknown>) => { pending = p; }, ...extra });
    await pending;
  };
  const lifecycle = async (type: "install" | "activate") => {
    let pending: Promise<unknown> | undefined;
    handlers[type]!({ waitUntil: (p: Promise<unknown>) => { pending = p; } });
    await pending;
  };
  /** Seed an entry the way putRuntime stores it (stamped with its fetch time). */
  const seedRuntime = (url: string, body: string, cachedAt = clock.t) =>
    storeFor(RUNTIME).entries.set(keyOf(url), new Response(body, { status: 200, headers: { [CACHED_AT]: String(cachedAt), [BYTES]: String(body.length) } }));
  return { handlers, caches, stores, storeFor, puts, message, lifecycle, posted, clock, warn, self, seedRuntime };
}

function fetchEvent(url: string, init: { mode?: string; headers?: Record<string, string>; signal?: { aborted: boolean } } = {}) {
  let responded: Promise<Response> | undefined;
  const pending: Promise<unknown>[] = [];
  const h = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  const event = {
    request: { method: "GET", url, mode: init.mode ?? "cors", headers: { get: (k: string) => h[k.toLowerCase()] ?? null }, signal: init.signal },
    respondWith: (p: Promise<Response>) => { responded = p; },
    waitUntil: (p: Promise<unknown>) => { pending.push(p); },
  };
  return {
    event,
    responded: () => responded !== undefined,
    response: () => responded!,
    /** The response, after every cache write the worker kept alive has finished. */
    settle: async () => { const r = await responded!; await Promise.all(pending); return r; },
  };
}
const navEvent = (url: string, init: { headers?: Record<string, string>; signal?: { aborted: boolean } } = {}) =>
  fetchEvent(url, { ...init, mode: "navigate" });
const dataEvent = (url: string, init: { headers?: Record<string, string>; signal?: { aborted: boolean } } = {}) =>
  fetchEvent(url, { ...init, mode: "cors" });

const offline = async () => { throw new TypeError("Failed to fetch"); };
const html = (body = "<html>page</html>", headers: Record<string, string> = {}) =>
  new Response(body, { status: 200, headers: { "Content-Type": "text/html", ...headers } });

describe("service worker fetch handler", () => {
  it("returns a real Response for a navigation that genuinely fails — network down, nothing cached: the inline offline page", async () => {
    const { handlers } = loadServiceWorker({ fetchImpl: offline });
    const nav = navEvent(`${ORIGIN}/projects/abc`);
    handlers.fetch!(nav.event);
    const res = await nav.response();
    expect(res).toBeInstanceOf(Response); // never undefined -> no "convert to Response" crash
    expect(res!.status).toBe(503);        // a genuine network failure: the 503 that says what it is (hard rule 2)
  });

  it("serves the network response for a navigation when online", async () => {
    const { handlers } = loadServiceWorker({ fetchImpl: async () => html() });
    const nav = navEvent(`${ORIGIN}/projects/abc`);
    handlers.fetch!(nav.event);
    const res = await nav.settle();
    expect(res).toBeInstanceOf(Response);
    expect(res!.status).toBe(200);
  });

  it("falls back to the cached page when the network fails", async () => {
    const { handlers, seedRuntime } = loadServiceWorker({ fetchImpl: offline });
    seedRuntime(`${ORIGIN}/projects/abc`, "<html>cached</html>");
    const nav = navEvent(`${ORIGIN}/projects/abc`);
    handlers.fetch!(nav.event);
    const res = await nav.settle();
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<html>cached</html>");
  });

  it("falls back to the precached /offline page before synthesizing one", async () => {
    const { handlers, storeFor } = loadServiceWorker({ fetchImpl: offline });
    storeFor(SHELL).entries.set(keyOf("/offline"), html("<html>offline page</html>"));
    const nav = navEvent(`${ORIGIN}/never-visited`);
    handlers.fetch!(nav.event);
    expect(await (await nav.settle()).text()).toBe("<html>offline page</html>");
  });

  it("does not touch RSC navigation payloads at all", () => {
    // A stale cached RSC payload pins old build chunks — the app runs old code
    // on every client-side navigation after a deploy. v4 bypassed the cache by
    // wrapping these in fetch().catch(stub); v5 doesn't intercept them at all,
    // which achieves the same "never cached" guarantee and fixes two bugs the
    // wrapper caused:
    //
    //   The router prefetches links on hover and cancels those prefetches
    //   freely. Every cancelled prefetch became a synthetic "504 (Offline)" in
    //   the console for a request nobody was waiting on.
    //
    //   The stub was an EMPTY 504 handed to the router where an RSC flight
    //   payload was expected. A genuine network error makes the router fall
    //   back to a full page load; a malformed one does not.
    const { handlers, caches } = loadServiceWorker({ fetchImpl: async () => new Response("rsc-payload", { status: 200 }) });
    const ev = dataEvent(`${ORIGIN}/documents?_rsc=abc123`);
    handlers.fetch!(ev.event);
    expect(ev.responded()).toBe(false);           // browser handles it directly
    expect(caches.match).not.toHaveBeenCalled();  // cache never consulted
  });

  it("leaves RSC requests flagged by header alone too, not just ?_rsc", () => {
    const { handlers } = loadServiceWorker({ fetchImpl: async () => new Response("x") });
    for (const headers of [{ RSC: "1" }, { "Next-Router-State-Tree": "%5B%5D" }] as Record<string, string>[]) {
      const ev = dataEvent(`${ORIGIN}/documents`, { headers });
      handlers.fetch!(ev.event);
      expect(ev.responded()).toBe(false);
    }
  });

  it("ignores cross-origin and non-GET requests (no respondWith)", () => {
    const { handlers } = loadServiceWorker({ fetchImpl: async () => new Response("x") });
    let called = false;
    handlers.fetch!({ request: { method: "GET", url: "https://supabase.co/rest", mode: "cors" }, respondWith: () => { called = true; } });
    handlers.fetch!({ request: { method: "POST", url: `${ORIGIN}/api`, mode: "cors" }, respondWith: () => { called = true; } });
    expect(called).toBe(false);
  });
});

describe("OFF-10 — a navigation the browser abandoned is rethrown, never answered with an invented 503", () => {
  it("rejects with the AbortError rather than resolving to the offline page", async () => {
    const abort = new DOMException("The user aborted a request.", "AbortError");
    const { handlers, caches } = loadServiceWorker({ fetchImpl: async () => { throw abort; } });
    const nav = navEvent(`${ORIGIN}/projects/abc`);
    handlers.fetch!(nav.event);
    await expect(nav.response()).rejects.toBe(abort);
    expect(caches.match).not.toHaveBeenCalled();
  });

  it("rejects when the request's own signal is aborted, whatever the error", async () => {
    const err = new TypeError("Failed to fetch");
    const { handlers } = loadServiceWorker({ fetchImpl: async () => { throw err; } });
    for (const mk of [navEvent, dataEvent]) {
      const ev = mk(`${ORIGIN}/projects/abc`, { signal: { aborted: true } });
      handlers.fetch!(ev.event);
      await expect(ev.response()).rejects.toBe(err);
    }
  });

  it("never stores a redirected response (the /d/ short link always redirects; any redirect)", async () => {
    const redirected = html("<html>landing</html>");
    Object.defineProperty(redirected, "redirected", { value: true });
    const { handlers, puts } = loadServiceWorker({ fetchImpl: async () => redirected });
    const nav = navEvent(`${ORIGIN}/documents/abc`);
    handlers.fetch!(nav.event);
    expect((await nav.settle()).status).toBe(200); // served, not stored
    expect(puts()).toEqual([]);
  });
});

describe("OFF-1 / OFF-5 / OFF-6 / OFF-7 / SHR-9 — the never-cache list: never written, never read back", () => {
  const NEVER_SUBRESOURCES = [
    `${ORIGIN}/api/verify?doc=d1&v=v1`,
    `${ORIGIN}/api/verify-hold?id=h1`,
    `${ORIGIN}/api/verify-package?pkg=p1&print=x1`,
    `${ORIGIN}/api/verify-ticket?ticket=t1`,
    `${ORIGIN}/api/share/file?token=tok`,
    `${ORIGIN}/api/share/resolve?token=tok`,
    `${ORIGIN}/api/storage/download-url?path=orgs/o/k.pdf&expiresIn=3600`,
    `${ORIGIN}/api/transmittal?token=tok&file=d1`,
    `${ORIGIN}/api/intake/resolve?token=tok`,
    `${ORIGIN}/api/intake/upload`,
  ];

  it.each(NEVER_SUBRESOURCES)("%s — a 200 with no cache header is served but never written", async (url) => {
    const { handlers, puts } = loadServiceWorker({
      fetchImpl: async () => new Response(JSON.stringify({ isCurrent: true }), { status: 200, headers: { "Content-Type": "application/json" } }),
    });
    const ev = dataEvent(url);
    handlers.fetch!(ev.event);
    expect((await ev.settle()).status).toBe(200);
    expect(puts()).toEqual([]);
  });

  it.each(NEVER_SUBRESOURCES)("%s — offline with a leftover entry in every cache: no cache is consulted and the request fails", async (url) => {
    const { handlers, caches, storeFor } = loadServiceWorker({ fetchImpl: offline });
    for (const name of [RUNTIME, SHELL, "mfgos-v6-runtime"]) {
      storeFor(name).entries.set(keyOf(url), new Response("{\"isCurrent\":true}", { status: 200, headers: { [CACHED_AT]: String(Date.now()) } }));
    }
    const ev = dataEvent(url);
    handlers.fetch!(ev.event);
    const res = await ev.settle();
    expect(res.status).toBe(503);                 // !res.ok → the page's fail-safe branch runs
    expect(await res.text()).not.toContain("isCurrent");
    expect(caches.match).not.toHaveBeenCalled();
    for (const s of [RUNTIME, SHELL]) expect(storeFor(s).match).not.toHaveBeenCalled();
  });

  it("OFF-1 done-when 4 (the API half): a phone that scanned online and then loses the network gets the failure, never the earlier verdict", async () => {
    let online = true;
    const { handlers, puts } = loadServiceWorker({
      fetchImpl: async () => {
        if (!online) throw new TypeError("Failed to fetch");
        return new Response(JSON.stringify({ isCurrent: true, verdict: "current" }), { status: 200, headers: { "Content-Type": "application/json" } });
      },
    });
    const url = `${ORIGIN}/api/verify?doc=d1&v=v1`;
    const first = dataEvent(url);
    handlers.fetch!(first.event);
    expect((await first.settle()).status).toBe(200);
    online = false;
    const again = dataEvent(url);
    handlers.fetch!(again.event);
    const res = await again.settle();
    expect(res.ok).toBe(false);
    expect(await res.text()).not.toContain("current");
    expect(puts()).toEqual([]);
  });

  const NEVER_PAGES = [
    `${ORIGIN}/share/tok123`,
    `${ORIGIN}/submit/tok123`,
    `${ORIGIN}/transmittal/tok123`,
    `${ORIGIN}/d/2002-D-10001`,
    `${ORIGIN}/?code=pkce-authorization-code`,
    `${ORIGIN}/reset?token=abc`,
    `${ORIGIN}/welcome?access_token=abc`,
    `${ORIGIN}/confirm?token_hash=abc&type=email`,
  ];

  it.each(NEVER_PAGES)("navigation %s — never written", async (url) => {
    const { handlers, puts } = loadServiceWorker({ fetchImpl: async () => html() });
    const nav = navEvent(url);
    handlers.fetch!(nav.event);
    expect((await nav.settle()).status).toBe(200);
    expect(puts()).toEqual([]);
  });

  it.each(NEVER_PAGES)("navigation %s — offline, its own leftover is never served (the offline page is)", async (url) => {
    const { handlers, storeFor } = loadServiceWorker({ fetchImpl: offline });
    storeFor(RUNTIME).entries.set(keyOf(url), new Response("<html>the live share card</html>", { status: 200, headers: { [CACHED_AT]: String(Date.now()) } }));
    storeFor(SHELL).entries.set(keyOf("/offline"), html("<html>offline page</html>"));
    const nav = navEvent(url);
    handlers.fetch!(nav.event);
    expect(await (await nav.settle()).text()).toBe("<html>offline page</html>");
  });

  it("OFF-6: a request carrying an Authorization header is never stored", async () => {
    const { handlers, puts } = loadServiceWorker({ fetchImpl: async () => new Response("{}", { status: 200 }) });
    const ev = dataEvent(`${ORIGIN}/data.json`, { headers: { Authorization: "Bearer eyJ…" } });
    handlers.fetch!(ev.event);
    await ev.settle();
    expect(puts()).toEqual([]);
  });

  it("OFF-6: a response that varies by identity (Vary: Authorization / Cookie / *) is never stored", async () => {
    for (const vary of ["Authorization", "Accept-Encoding, Cookie", "*"]) {
      const { handlers, puts } = loadServiceWorker({ fetchImpl: async () => new Response("{}", { status: 200, headers: { Vary: vary } }) });
      const ev = dataEvent(`${ORIGIN}/data.json`);
      handlers.fetch!(ev.event);
      await ev.settle();
      expect(puts(), vary).toEqual([]);
    }
  });

  it("the never-cache list wins even over an /api/ allow-list entry (a future Reversal of DEC-44 §3 cannot re-admit a verdict)", async () => {
    const widened = SW_SOURCE.replace("const CACHEABLE_API_PREFIXES = [];", 'const CACHEABLE_API_PREFIXES = ["/api/"];');
    expect(widened).not.toBe(SW_SOURCE);
    const { handlers, puts } = loadServiceWorker({ source: widened, fetchImpl: async () => new Response("{}", { status: 200 }) });
    for (const url of [`${ORIGIN}/api/verify?doc=d1`, `${ORIGIN}/api/share/resolve?token=t`, `${ORIGIN}/api/codebook`]) {
      const ev = dataEvent(url);
      handlers.fetch!(ev.event);
      await ev.settle();
    }
    expect(puts()).toEqual([`${ORIGIN}/api/codebook`]);
  });

  it("a never-cache path that looks like a static asset is not routed cache-first", async () => {
    const { handlers, puts, caches } = loadServiceWorker({ fetchImpl: async () => new Response("png", { status: 200 }) });
    const ev = dataEvent(`${ORIGIN}/share/tok/preview.png`);
    handlers.fetch!(ev.event);
    await ev.settle();
    expect(puts()).toEqual([]);
    expect(caches.match).not.toHaveBeenCalled();
  });
});

describe("OFF-1 done-when 4 — an offline QR scan lands on the page's own fail-safe screen, never a verdict and never the generic offline page", () => {
  // In production the four scan-landing pages are dynamic routes (no
  // generateStaticParams; absent from .next/prerender-manifest.json), served
  // `private, no-cache, no-store` — never cacheable. So no cached page shell
  // can carry an offline scan to the page's own error branch: the worker has
  // to answer with that screen itself.
  const PAGES = [
    { url: `${ORIGIN}/verify/d1?v=v1`, file: "app/verify/[docId]/page.tsx", title: "Can't verify this code", instruction: "If this QR came from a printed drawing, contact Document Control before using the print." },
    { url: `${ORIGIN}/verify-hold/h1`, file: "app/verify-hold/[holdId]/page.tsx", title: "Can't verify this tag", instruction: "Treat the hold as ACTIVE until Document Control confirms otherwise." },
    { url: `${ORIGIN}/verify-package/p1?print=x1`, file: "app/verify-package/[packageId]/page.tsx", title: "Can't verify this code", instruction: "If this QR came from a printed pack, contact Document Control before working from it." },
    { url: `${ORIGIN}/verify-ticket/t1`, file: "app/verify-ticket/[ticketId]/page.tsx", title: "Can't verify this code", instruction: "If this QR came from an issued deliverable, contact the requester before using the copy." },
  ];
  const VERDICTS = /RELEASED|\bCURRENT\b|DO NOT USE|HOLD ACTIVE|matches the current/;
  const NEXT_DYNAMIC = { "Cache-Control": "private, no-cache, no-store, max-age=0, must-revalidate" };

  it.each(PAGES)("$url — offline, nothing cached for it: a 503 carrying the page's own heading and instruction, even with /offline precached", async ({ url, title, instruction }) => {
    const { handlers, storeFor, posted } = loadServiceWorker({ fetchImpl: offline });
    storeFor(SHELL).entries.set(keyOf("/offline"), html("<html>offline page</html>"));
    storeFor(SHELL).entries.set(keyOf("/"), html("<html>home</html>"));
    const nav = navEvent(url);
    handlers.fetch!(nav.event);
    const res = await nav.settle();
    expect(res.status).toBe(503);
    expect(res.headers.get("Content-Type")).toMatch(/^text\/html/);
    const body = await res.text();
    expect(body).toContain(`<h1 style="font-size:1.5rem;margin:0 0 .5rem">${title.replace("'", "&#39;")}</h1>`);
    expect(body).toContain(instruction);
    expect(body).toMatch(/offline/i);
    expect(body).not.toContain("offline page");
    expect(body).not.toMatch(VERDICTS);
    await new Promise((r) => setTimeout(r, 0));
    expect(posted).toEqual([{ type: "NETWORK", ok: false }]);
  });

  it("the review's scenario: a HOLD tag scanned online on Monday (the page served no-store, as Next serves it), scanned again offline on Thursday → \"Treat the hold as ACTIVE…\", with a leftover of the page in every cache ignored", async () => {
    let online = true;
    const { handlers, puts, caches, storeFor, clock } = loadServiceWorker({
      fetchImpl: async () => {
        if (!online) throw new TypeError("Failed to fetch");
        return html("<html>HOLD RELEASED — this tag can come down</html>", NEXT_DYNAMIC);
      },
    });
    const url = `${ORIGIN}/verify-hold/h1`;
    const monday = navEvent(url);
    handlers.fetch!(monday.event);
    expect(await (await monday.settle()).text()).toContain("RELEASED");
    expect(puts()).toEqual([]);
    // even a leftover from some older worker or a header change is never served
    for (const name of [RUNTIME, SHELL]) {
      storeFor(name).entries.set(keyOf(url), new Response("<html>HOLD RELEASED</html>", { status: 200, headers: { [CACHED_AT]: String(clock.t) } }));
    }
    clock.t += 3 * DAY;
    online = false;
    const thursday = navEvent(url);
    handlers.fetch!(thursday.event);
    const res = await thursday.settle();
    expect(res.status).toBe(503);
    const body = await res.text();
    expect(body).toContain("Treat the hold as ACTIVE until Document Control confirms otherwise.");
    expect(body).not.toMatch(VERDICTS);
    expect(caches.match).not.toHaveBeenCalled();
  });

  it.each(PAGES)("$url — online, served from the network and never written (on the never-cache list, whatever its headers)", async ({ url }) => {
    const { handlers, puts } = loadServiceWorker({ fetchImpl: async () => html("<html>verdict page</html>") });
    const nav = navEvent(url);
    handlers.fetch!(nav.event);
    expect((await nav.settle()).status).toBe(200);
    expect(puts()).toEqual([]);
  });

  it.each(PAGES)("$file — the worker's heading and instruction are the page's own error-branch copy (drift fails here)", ({ file, title, instruction }) => {
    const page = readFileSync(resolve(process.cwd(), file), "utf8");
    expect(page).toContain(`>${title.replace("'", "&apos;")}</h1>`);
    expect(page).toContain(instruction);
    expect(SW_SOURCE).toContain(`title: "${title}", instruction: "${instruction}"`);
  });

  it("Try again goes back to the same scan, HTML-escaped; an aborted scan still rethrows", async () => {
    const { handlers } = loadServiceWorker({ fetchImpl: offline });
    const nav = navEvent(`${ORIGIN}/verify/d1?v=v1&src=qr'x`);
    handlers.fetch!(nav.event);
    const body = await (await nav.settle()).text();
    expect(body).toContain(`<a href="/verify/d1?v=v1&amp;src=qr%27x"`);
    const abort = new DOMException("The user aborted a request.", "AbortError");
    const aborted = loadServiceWorker({ fetchImpl: async () => { throw abort; } });
    const ev = navEvent(`${ORIGIN}/verify-hold/h1`);
    aborted.handlers.fetch!(ev.event);
    await expect(ev.response()).rejects.toBe(abort);
  });

  it("a path that only starts like a verify page is not one", async () => {
    const { handlers, storeFor } = loadServiceWorker({ fetchImpl: offline });
    storeFor(SHELL).entries.set(keyOf("/offline"), html("<html>offline page</html>"));
    const nav = navEvent(`${ORIGIN}/verifications`);
    handlers.fetch!(nav.event);
    expect(await (await nav.settle()).text()).toBe("<html>offline page</html>");
  });
});

describe("OFF-13 / XEDGE-6 — Cache-Control is honoured, /api/ is never stored", () => {
  it("bumped VERSION so every cache an older worker filled is swept on activate", async () => {
    expect(SCHEMA).toBeGreaterThanOrEqual(7);
    const { caches, storeFor, lifecycle } = loadServiceWorker({ fetchImpl: async () => new Response("x") });
    storeFor("mfgos-v5-runtime"); // a leftover from an older worker
    storeFor("mfgos-v6-runtime");
    storeFor(RUNTIME);
    await lifecycle("activate");
    expect(caches.delete).toHaveBeenCalledWith("mfgos-v5-runtime");
    expect(caches.delete).toHaveBeenCalledWith("mfgos-v6-runtime");
    expect(caches.delete).not.toHaveBeenCalledWith(RUNTIME);
  });

  // Next marks dynamically rendered pages `private, no-cache, no-store, …`,
  // so those shells no longer cache offline (XEDGE-6 residual); a navigation
  // the server did NOT mark no-store still does.
  it("still caches a navigation the server did not mark no-store (Field Mode keeps its static shells)", async () => {
    const { handlers, puts } = loadServiceWorker({ fetchImpl: async () => html() });
    const nav = navEvent(`${ORIGIN}/projects/abc`);
    handlers.fetch!(nav.event);
    await nav.settle();
    expect(puts()).toEqual([`${ORIGIN}/projects/abc`]);
  });

  it("never writes a Cache-Control: no-store response — navigation or sub-resource", async () => {
    for (const mk of [navEvent, dataEvent]) {
      const { handlers, puts } = loadServiceWorker({
        fetchImpl: async () => new Response("%PDF-1.7", { status: 200, headers: { "Cache-Control": "no-store", "Content-Type": "application/pdf" } }),
      });
      const ev = mk(`${ORIGIN}/docs/file.pdf`);
      handlers.fetch!(ev.event);
      const res = await ev.settle();
      expect(res!.status).toBe(200); // still SERVED, just not stored
      expect(puts()).toEqual([]);
    }
  });

  it("refuses Cache-Control: private and no-cache the same way (an offline fallback can never revalidate — SHR-9)", async () => {
    for (const cc of ["private, max-age=60", "no-cache", "public, No-Cache"]) {
      const { handlers, puts } = loadServiceWorker({
        fetchImpl: async () => new Response("{}", { status: 200, headers: { "Cache-Control": cc } }),
      });
      const ev = dataEvent(`${ORIGIN}/data.json`);
      handlers.fetch!(ev.event);
      await ev.settle();
      expect(puts(), cc).toEqual([]);
    }
  });

  it("a public, revalidating response (Vercel's static HTML) is still cached", async () => {
    const { handlers, puts } = loadServiceWorker({
      fetchImpl: async () => html("<html>static</html>", { "Cache-Control": "public, max-age=0, must-revalidate" }),
    });
    const nav = navEvent(`${ORIGIN}/about`);
    handlers.fetch!(nav.event);
    await nav.settle();
    expect(puts()).toEqual([`${ORIGIN}/about`]);
  });

  it("never stores ANY same-origin /api/ response, even one with no cache header (the signed-URL JSON)", async () => {
    const { handlers, puts } = loadServiceWorker({
      fetchImpl: async () => new Response(JSON.stringify({ url: "https://r2/signed" }), { status: 200, headers: { "Content-Type": "application/json" } }),
    });
    const ev = dataEvent(`${ORIGIN}/api/codebook?x=1`);
    handlers.fetch!(ev.event);
    expect((await ev.settle()).status).toBe(200);
    expect(puts()).toEqual([]);
  });

  it("never replays an /api/ entry offline either — a leftover is a 503, not a stale payload", async () => {
    const { handlers, caches, storeFor } = loadServiceWorker({ fetchImpl: offline });
    storeFor(RUNTIME).entries.set(keyOf(`${ORIGIN}/api/codebook?x=1`), new Response("{\"stale\":1}", { status: 200, headers: { [CACHED_AT]: String(Date.now()) } }));
    const ev = dataEvent(`${ORIGIN}/api/codebook?x=1`);
    handlers.fetch!(ev.event);
    expect((await ev.settle()).status).toBe(503);
    expect(caches.match).not.toHaveBeenCalled();
  });

  it("a non-API same-origin data GET is still cached and still served from cache offline", async () => {
    let online = true;
    const { handlers, puts } = loadServiceWorker({
      fetchImpl: async () => { if (!online) throw new TypeError("offline"); return new Response("{\"name\":\"app\"}", { status: 200 }); },
    });
    const first = dataEvent(`${ORIGIN}/manifest.webmanifest`);
    handlers.fetch!(first.event);
    await first.settle();
    expect(puts()).toEqual([`${ORIGIN}/manifest.webmanifest`]);
    online = false;
    const again = dataEvent(`${ORIGIN}/manifest.webmanifest`);
    handlers.fetch!(again.event);
    expect(await (await again.settle()).text()).toBe("{\"name\":\"app\"}");
  });
});

describe("OFF-9 — RUNTIME_CACHE is bounded: 200 entries, 7 days, a per-entry size cap, least-recently-used first", () => {
  const MiB = 1024 * 1024;

  it("stamps every stored entry with the time it was fetched and its size", async () => {
    const { handlers, storeFor, clock } = loadServiceWorker({ fetchImpl: async () => html("<html>12345</html>") });
    const nav = navEvent(`${ORIGIN}/projects/abc`);
    handlers.fetch!(nav.event);
    await nav.settle();
    const stored = storeFor(RUNTIME).entries.get(`${ORIGIN}/projects/abc`)!;
    expect(stored.headers.get(CACHED_AT)).toBe(String(clock.t));
    expect(stored.headers.get(BYTES)).toBe(String("<html>12345</html>".length));
    expect(stored.headers.get("Content-Type")).toBe("text/html");
    expect(await stored.clone().text()).toBe("<html>12345</html>");
  });

  it("never stores a response above the per-entry threshold — declared or actual size", async () => {
    for (const res of [
      () => html("small", { "Content-Length": String(3 * MiB) }),
      () => html("x".repeat(2 * MiB + 1)),
    ]) {
      const { handlers, puts } = loadServiceWorker({ fetchImpl: async () => res() });
      const nav = navEvent(`${ORIGIN}/projects/big`);
      handlers.fetch!(nav.event);
      expect((await nav.settle()).status).toBe(200);
      expect(puts()).toEqual([]);
    }
  });

  it("keeps at most 200 entries, dropping the least recently written", async () => {
    const { handlers, storeFor } = loadServiceWorker({ fetchImpl: async () => html() });
    for (let i = 0; i <= 200; i++) {
      const nav = navEvent(`${ORIGIN}/p/${i}`);
      handlers.fetch!(nav.event);
      await nav.settle();
    }
    const keys = [...storeFor(RUNTIME).entries.keys()];
    expect(keys).toHaveLength(200);
    expect(keys).not.toContain(`${ORIGIN}/p/0`);
    expect(keys).toContain(`${ORIGIN}/p/200`);
  });

  it("an entry served offline counts as recently used — it outlives the next trim — but keeps its original fetch time, so it still expires", async () => {
    let online = true;
    const { handlers, storeFor, seedRuntime, clock } = loadServiceWorker({
      fetchImpl: async () => { if (!online) throw new TypeError("offline"); return html(); },
    });
    const fetchedAt = clock.t - 6 * DAY;
    seedRuntime(`${ORIGIN}/p/0`, "<html>p0</html>", fetchedAt); // the oldest entry, fetched six days ago
    for (let i = 1; i < 200; i++) {
      const nav = navEvent(`${ORIGIN}/p/${i}`);
      handlers.fetch!(nav.event);
      await nav.settle();
    }
    online = false;
    const read = navEvent(`${ORIGIN}/p/0`);
    handlers.fetch!(read.event);
    expect(await (await read.settle()).text()).toBe("<html>p0</html>");
    online = true;
    const more = navEvent(`${ORIGIN}/p/200`);
    handlers.fetch!(more.event);
    await more.settle();
    const keys = [...storeFor(RUNTIME).entries.keys()];
    expect(keys).toHaveLength(200);
    expect(keys).toContain(`${ORIGIN}/p/0`);
    expect(keys).not.toContain(`${ORIGIN}/p/1`);
    // the touch keeps the original fetch time — age is measured from the network, not the last read
    expect(storeFor(RUNTIME).entries.get(`${ORIGIN}/p/0`)!.headers.get(CACHED_AT)).toBe(String(fetchedAt));
    // …so a sliding TTL cannot keep a regularly read entry alive: two days on it is eight days old
    clock.t += 2 * DAY;
    online = false;
    const late = navEvent(`${ORIGIN}/p/0`);
    handlers.fetch!(late.event);
    expect((await late.settle()).status).toBe(503);
    expect(storeFor(RUNTIME).entries.has(`${ORIGIN}/p/0`)).toBe(false);
  });

  it("an entry older than 7 days is never served and is deleted on the spot", async () => {
    const { handlers, storeFor, seedRuntime, clock } = loadServiceWorker({ fetchImpl: offline });
    seedRuntime(`${ORIGIN}/projects/old`, "<html>old</html>", clock.t - 7 * DAY - 1);
    seedRuntime(`${ORIGIN}/projects/unstamped`, "<html>?</html>", 0);
    seedRuntime(`${ORIGIN}/projects/recent`, "<html>recent</html>", clock.t - 6 * DAY);
    for (const [path, want] of [["old", 503], ["unstamped", 503], ["recent", 200]] as const) {
      const nav = navEvent(`${ORIGIN}/projects/${path}`);
      handlers.fetch!(nav.event);
      expect((await nav.settle()).status, path).toBe(want);
    }
    const keys = [...storeFor(RUNTIME).entries.keys()];
    expect(keys).toEqual([`${ORIGIN}/projects/recent`]);
  });

  it("expired entries are also swept on write (at most hourly), not only when read", async () => {
    const { handlers, storeFor, seedRuntime, clock } = loadServiceWorker({ fetchImpl: async () => html() });
    seedRuntime(`${ORIGIN}/projects/old`, "<html>old</html>", clock.t - 8 * DAY);
    const nav = navEvent(`${ORIGIN}/projects/new`);
    handlers.fetch!(nav.event);
    await nav.settle();
    expect([...storeFor(RUNTIME).entries.keys()]).toEqual([`${ORIGIN}/projects/new`]);
  });

  it("reports its footprint on CACHE_STATS — entry count, bytes, limits, the shell assets it is missing", async () => {
    const { message, seedRuntime, storeFor, clock } = loadServiceWorker({ fetchImpl: offline });
    seedRuntime(`${ORIGIN}/a`, "12345", clock.t - DAY);
    seedRuntime(`${ORIGIN}/b`, "1234567890");
    storeFor(SHELL).entries.set(keyOf("/offline"), html());
    const replies: unknown[] = [];
    await message({ type: "CACHE_STATS" }, { ports: [{ postMessage: (m: unknown) => replies.push(m) }] });
    expect(replies).toEqual([expect.objectContaining({
      type: "CACHE_STATS", version: VERSION, entries: 2, bytes: 15, maxEntries: 200, maxAgeMs: 7 * DAY,
      maxEntryBytes: 2 * MiB, oldestCachedAt: clock.t - DAY,
      shellMissing: ["/", "/icon.svg", "/manifest.webmanifest"],
    })]);
  });
});

describe("OFF-12 / OFF-4 — install: the shell is precached per asset, and the worker waits", () => {
  it("one failing shell asset does not discard the others, and is named in a console warning", async () => {
    const { lifecycle, storeFor, warn, self } = loadServiceWorker({
      fetchImpl: async (req) => ((req as { url: string }).url.endsWith("/manifest.webmanifest") ? new Response("nf", { status: 404 }) : html()),
    });
    await lifecycle("install");
    expect([...storeFor(SHELL).entries.keys()].sort()).toEqual([`${ORIGIN}/`, `${ORIGIN}/icon.svg`, `${ORIGIN}/offline`]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("/manifest.webmanifest");
    expect(self.skipWaiting).not.toHaveBeenCalled(); // OFF-4
  });

  it("install never calls skipWaiting — a new worker waits; only the SKIP_WAITING message activates it", async () => {
    const { lifecycle, handlers, self } = loadServiceWorker({ fetchImpl: async () => html() });
    await lifecycle("install");
    expect(self.skipWaiting).not.toHaveBeenCalled();
    handlers.message!({ data: "SKIP_WAITING" });
    expect(self.skipWaiting).toHaveBeenCalledTimes(1);
    const at = SW_SOURCE.indexOf('self.addEventListener("install"');
    const installHandler = SW_SOURCE.slice(at, SW_SOURCE.indexOf("});", at));
    expect(at).toBeGreaterThan(0);
    expect(installHandler).not.toMatch(/skipWaiting/);
  });

  it("a SESSION announcement re-warms only the shell assets that are missing (after a sign-out emptied Cache Storage)", async () => {
    const fetched: string[] = [];
    const { message, storeFor } = loadServiceWorker({ fetchImpl: async (req) => { fetched.push((req as { url: string }).url); return html(); } });
    storeFor(SHELL).entries.set(keyOf("/"), html());
    storeFor(SHELL).entries.set(keyOf("/icon.svg"), html());
    await message({ type: "SESSION", id: "uid-a" });
    expect(fetched.sort()).toEqual([`${ORIGIN}/manifest.webmanifest`, `${ORIGIN}/offline`]);
  });
});

describe("OFF-11 — VERSION follows the build; the committed worker is never a stamped one", () => {
  it("VERSION is mfgos-v<schema>-<build>, and the committed build id is the unstamped default", () => {
    // a schema bump edits SW_SCHEMA and adds a fingerprint below — nothing here
    expect(Number.isInteger(SCHEMA) && SCHEMA >= 7).toBe(true);
    expect(BUILD).toBe(UNSTAMPED);
    expect(SW_SOURCE).toMatch(/^const VERSION = `mfgos-v\$\{SW_SCHEMA\}-\$\{SW_BUILD\}`;$/m);
  });

  it("activate drops every cache of another build or schema and keeps its own three", async () => {
    const { caches, storeFor, lifecycle } = loadServiceWorker({ fetchImpl: async () => new Response("x") });
    for (const n of [SHELL, RUNTIME, SESSION, `mfgos-v${SCHEMA}-0123abcd-runtime`, `mfgos-v${SCHEMA}-${BUILD}x-runtime`, "mfgos-v6-shell"]) storeFor(n);
    await lifecycle("activate");
    const deleted = caches.delete.mock.calls.map((c) => c[0]).sort();
    expect(deleted).toEqual([`mfgos-v${SCHEMA}-0123abcd-runtime`, `mfgos-v${SCHEMA}-${BUILD}x-runtime`, "mfgos-v6-shell"].sort());
  });

  // CI guard (OFF-11 done-when 3): the worker's code — comments, whitespace
  // and the build stamp ignored — is fingerprinted per SW_SCHEMA. A change to
  // what the worker does fails here until SW_SCHEMA is bumped (which drops
  // every cache the previous behaviour filled) and the new fingerprint is
  // recorded as a NEW entry. Never edit an entry whose schema has merged:
  // devices already run it. (Schema 7's entry was re-recorded once, by the
  // public-surfaces PKG-1 fix pass, before schema 7 had merged anywhere.)
  const SCHEMA_FINGERPRINTS: Record<number, string> = {
    7: "ee632785f10f9c199033bc61617ae8224473785ce576a1a1321730a98a1b44b6",
  };
  const fingerprint = (src: string) => {
    const code = ts.transpileModule(stampSource(src, UNSTAMPED), {
      compilerOptions: { removeComments: true, target: ts.ScriptTarget.ESNext },
    }).outputText.replace(/\s+/g, " ").trim();
    return createHash("sha256").update(code).digest("hex");
  };

  it("CI fails if the worker's caching behaviour changes without SW_SCHEMA changing", () => {
    const fp = fingerprint(SW_SOURCE);
    expect(Math.max(...Object.keys(SCHEMA_FINGERPRINTS).map(Number)), "record the bumped schema's fingerprint").toBe(SCHEMA);
    expect(fp, `public/sw.js changed — bump SW_SCHEMA and add { ${SCHEMA + 1}: "${fp}" }`).toBe(SCHEMA_FINGERPRINTS[SCHEMA]);
    // comment-only edits and the build stamp do not count as a behaviour change
    expect(fingerprint(SW_SOURCE.replace("/* Manufacturing OS service worker", "/* (reworded) Manufacturing OS service worker"))).toBe(fp);
    expect(fingerprint(stampSource(SW_SOURCE, "0123abcd"))).toBe(fp);
    // …a code edit does
    expect(fingerprint(SW_SOURCE.replace("const MAX_RUNTIME_ENTRIES = 200;", "const MAX_RUNTIME_ENTRIES = 201;"))).not.toBe(fp);
  });

  it("resolveBuildId: VERCEL_GIT_COMMIT_SHA, else VERCEL_DEPLOYMENT_ID, else the deterministic unstamped default", () => {
    expect(resolveBuildId({ VERCEL_GIT_COMMIT_SHA: "a1b2c3", VERCEL_DEPLOYMENT_ID: "dpl_x" })).toBe("a1b2c3");
    expect(resolveBuildId({ VERCEL_DEPLOYMENT_ID: "dpl_9Xy" })).toBe("dpl_9Xy");
    expect(resolveBuildId({ VERCEL_GIT_COMMIT_SHA: "", VERCEL_DEPLOYMENT_ID: "dpl_9Xy" })).toBe("dpl_9Xy");
    expect(resolveBuildId({})).toBe(UNSTAMPED);
    // only cache-name-safe characters, bounded
    expect(resolveBuildId({ VERCEL_GIT_COMMIT_SHA: 'ab"c;\n/../d' })).toBe("abcd");
    expect(resolveBuildId({ VERCEL_GIT_COMMIT_SHA: "x".repeat(100) })).toHaveLength(64);
    expect(resolveBuildId({ VERCEL_GIT_COMMIT_SHA: "\"/;" })).toBe(UNSTAMPED);
  });

  it("stampSource rewrites exactly the one SW_BUILD line, is idempotent, and refuses a worker without exactly one", () => {
    const stamped = stampSource(SW_SOURCE, "0123abcd");
    expect(stamped).toContain('const SW_BUILD = "0123abcd";');
    expect(stamped.replace('const SW_BUILD = "0123abcd";', `const SW_BUILD = "${UNSTAMPED}";`)).toBe(SW_SOURCE);
    expect(stampSource(stamped, "0123abcd")).toBe(stamped);
    expect(stampSource(stamped, UNSTAMPED)).toBe(SW_SOURCE); // an unstamped build restores the committed bytes
    expect(() => stampSource("const VERSION = 'x';", "abc")).toThrow(/SW_BUILD/);
    expect(() => stampSource(`${SW_SOURCE}\nconst SW_BUILD = "dup";\n`, "abc")).toThrow(/SW_BUILD/);
  });

  it("the script stamps a worker when a build id is set and leaves it byte-identical when none is (local dev, the Docker image)", () => {
    const dir = mkdtempSync(join(tmpdir(), "sw-stamp-"));
    try {
      const target = join(dir, "sw.js");
      const script = resolve(process.cwd(), "scripts/stamp-sw-version.mjs");
      const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("VERCEL"))) as NodeJS.ProcessEnv;
      writeFileSync(target, SW_SOURCE);
      execFileSync(process.execPath, [script, target], { env, stdio: "pipe" });
      expect(readFileSync(target, "utf8")).toBe(SW_SOURCE);
      execFileSync(process.execPath, [script, target], { env: { ...env, VERCEL_GIT_COMMIT_SHA: "f00dfeed" }, stdio: "pipe" });
      expect(readFileSync(target, "utf8")).toBe(stampSource(SW_SOURCE, "f00dfeed"));
      writeFileSync(target, "// no stamp line\n");
      expect(() => execFileSync(process.execPath, [script, target], { env, stdio: "pipe" })).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prebuild stamps the worker; predev and dev never rewrite it", () => {
    const pkg = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts.prebuild).toMatch(/node scripts\/stamp-sw-version\.mjs/);
    expect(pkg.scripts.prebuild).toMatch(/copy-pdfjs-worker/);
    expect(pkg.scripts.predev ?? "").not.toMatch(/stamp-sw-version/);
    expect(pkg.scripts.dev).not.toMatch(/stamp-sw-version/);
  });
});

describe("OFF-3 — the worker reports what actually happened on the network", () => {
  it("posts NETWORK ok:false to every window on a genuine failure, once per change, and ok:true when a fetch succeeds again", async () => {
    let online = false;
    const { handlers, posted } = loadServiceWorker({ fetchImpl: async () => { if (!online) throw new TypeError("Failed to fetch"); return html(); } });
    const run = async (url: string) => { const ev = navEvent(url); handlers.fetch!(ev.event); await ev.settle().catch(() => undefined); await new Promise((r) => setTimeout(r, 0)); };
    await run(`${ORIGIN}/a`);
    await run(`${ORIGIN}/b`);
    expect(posted).toEqual([{ type: "NETWORK", ok: false }]);
    online = true;
    await run(`${ORIGIN}/c`);
    await run(`${ORIGIN}/d`);
    expect(posted).toEqual([{ type: "NETWORK", ok: false }, { type: "NETWORK", ok: true }]);
  });

  it("a static asset that resolves while the device is offline (the browser's HTTP cache answered it) does not clear the pill", async () => {
    const { handlers, posted, message } = loadServiceWorker({
      fetchImpl: async (req) => {
        if ((req as { url: string }).url.includes("/_next/static/")) return new Response("chunk", { status: 200, headers: { "Content-Type": "text/javascript" } });
        throw new TypeError("Failed to fetch");
      },
    });
    const run = async (ev: ReturnType<typeof fetchEvent>) => { handlers.fetch!(ev.event); await ev.settle(); await new Promise((r) => setTimeout(r, 0)); };
    await run(navEvent(`${ORIGIN}/projects/abc`));
    expect(posted).toEqual([{ type: "NETWORK", ok: false }]);
    const chunk = dataEvent(`${ORIGIN}/_next/static/chunks/app-lazy.js`);
    await run(chunk);
    expect(await (await chunk.response()).text()).toBe("chunk");
    expect(posted).toEqual([{ type: "NETWORK", ok: false }]); // no ok:true flap
    const replies: unknown[] = [];
    await message({ type: "NETWORK_STATUS" }, { source: { postMessage: (m: unknown) => replies.push(m) } });
    expect(replies).toEqual([{ type: "NETWORK", ok: false }]);
  });

  it("a failing static asset is still reported as the network going down", async () => {
    const { handlers, posted } = loadServiceWorker({ fetchImpl: offline });
    const ev = dataEvent(`${ORIGIN}/_next/static/chunks/app-lazy.js`);
    handlers.fetch!(ev.event);
    expect((await ev.settle()).status).toBe(503);
    await new Promise((r) => setTimeout(r, 0));
    expect(posted).toEqual([{ type: "NETWORK", ok: false }]);
  });

  it("an aborted request is not reported as the network going down", async () => {
    const { handlers, posted } = loadServiceWorker({ fetchImpl: async () => { throw new DOMException("x", "AbortError"); } });
    const ev = dataEvent(`${ORIGIN}/data.json`);
    handlers.fetch!(ev.event);
    await ev.response().catch(() => undefined);
    await new Promise((r) => setTimeout(r, 0));
    expect(posted).toEqual([]);
  });

  it("answers NETWORK_STATUS with what it last saw, and says nothing before it has seen anything", async () => {
    const { handlers, message } = loadServiceWorker({ fetchImpl: offline });
    const replies: unknown[] = [];
    const source = { postMessage: (m: unknown) => replies.push(m) };
    await message({ type: "NETWORK_STATUS" }, { source });
    expect(replies).toEqual([]);
    const ev = dataEvent(`${ORIGIN}/data.json`);
    handlers.fetch!(ev.event);
    await ev.settle();
    await message({ type: "NETWORK_STATUS" }, { source });
    expect(replies).toEqual([{ type: "NETWORK", ok: false }]);
  });
});

describe("XEDGE-6 — the cache does not outlive the session", () => {
  it("SIGN_OUT deletes the runtime cache and forgets the session identity", async () => {
    const { caches, storeFor, message } = loadServiceWorker({ fetchImpl: async () => new Response("x") });
    storeFor(RUNTIME).entries.set(`${ORIGIN}/documents`, new Response("cached"));
    const session = storeFor(SESSION);
    session.entries.set(keyOf("/__mfgos/session"), new Response("uid-a"));
    await message({ type: "SIGN_OUT" });
    expect(caches.delete).toHaveBeenCalledWith(RUNTIME);
    expect(session.entries.has(keyOf("/__mfgos/session"))).toBe(false);
  });

  it("SESSION: an unknown or CHANGED identity purges the runtime cache; the same identity does not", async () => {
    const { caches, storeFor, message } = loadServiceWorker({ fetchImpl: async () => html() });
    const session = storeFor(SESSION);
    await message({ type: "SESSION", id: "uid-a" });     // first announcement: nothing known → purge
    expect(caches.delete).toHaveBeenCalledTimes(1);
    expect(caches.delete).toHaveBeenLastCalledWith(RUNTIME);
    expect(await (await session.match("/__mfgos/session"))!.text()).toBe("uid-a");

    await message({ type: "SESSION", id: "uid-a" });     // same person again → keep
    expect(caches.delete).toHaveBeenCalledTimes(1);

    await message({ type: "SESSION", id: "uid-b" });     // another account on the tablet → purge
    expect(caches.delete).toHaveBeenCalledTimes(2);
    expect(await (await session.match("/__mfgos/session"))!.text()).toBe("uid-b");
  });

  it("a changed identity's purge never waits behind the shell re-warm — even a shell fetch that never answers (a hanging plant network)", async () => {
    const { handlers, caches, storeFor } = loadServiceWorker({ fetchImpl: () => new Promise<Response>(() => { /* never answers */ }) });
    storeFor(SESSION).entries.set(keyOf("/__mfgos/session"), new Response("uid-a"));
    storeFor(RUNTIME).entries.set(keyOf(`${ORIGIN}/projects/a`), html("<html>A's page</html>"));
    // the shell cache is empty, so the re-warm fetches every asset — and none answers
    handlers.message!({ data: { type: "SESSION", id: "uid-b" }, waitUntil: () => undefined });
    await vi.waitFor(() => expect(caches.delete).toHaveBeenCalledWith(RUNTIME));
    await vi.waitFor(async () => expect(await (await storeFor(SESSION).match("/__mfgos/session"))!.text()).toBe("uid-b"));
    expect(storeFor(SHELL).add).toHaveBeenCalled(); // the re-warm did start — after the purge
  });

  it("the same identity again still re-warms a missing shell asset", async () => {
    const fetched: string[] = [];
    const { message, storeFor, caches } = loadServiceWorker({ fetchImpl: async (req) => { fetched.push((req as { url: string }).url); return html(); } });
    storeFor(SESSION).entries.set(keyOf("/__mfgos/session"), new Response("uid-a"));
    for (const a of ["/", "/offline", "/icon.svg"]) storeFor(SHELL).entries.set(keyOf(a), html());
    await message({ type: "SESSION", id: "uid-a" });
    expect(caches.delete).not.toHaveBeenCalled();
    expect(fetched).toEqual([`${ORIGIN}/manifest.webmanifest`]);
  });

  it("keeps the SKIP_WAITING string message and ignores junk", async () => {
    const { handlers, caches, message } = loadServiceWorker({ fetchImpl: async () => new Response("x") });
    handlers.message!({ data: "SKIP_WAITING" });
    await message({ type: "SOMETHING_ELSE" });
    await message(null);
    await message(42);
    expect(caches.delete).not.toHaveBeenCalled();
  });
});

describe("lib/swSession — the page's side of the contract", () => {
  const fakeNav = (over: Record<string, unknown> = {}) => {
    const posted: unknown[] = [];
    const worker = { postMessage: (m: unknown) => posted.push(m) };
    return {
      posted,
      nav: { serviceWorker: { controller: worker, getRegistration: async () => ({ active: worker }), ...over } },
    };
  };

  it("posts SIGN_OUT / SESSION to the controlling worker, once each, and reports success", async () => {
    const { posted, nav } = fakeNav();
    expect(await clearServiceWorkerSession(nav)).toBe(true);
    expect(await announceServiceWorkerSession("uid-a", nav)).toBe(true);
    expect(posted).toEqual([{ type: "SIGN_OUT" }, { type: "SESSION", id: "uid-a" }]);
  });

  it("reaches a registered worker that does not control this page yet", async () => {
    const posted: unknown[] = [];
    const nav = { serviceWorker: { controller: null, getRegistration: async () => ({ active: { postMessage: (m: unknown) => posted.push(m) } }) } };
    expect(await postServiceWorkerMessage({ type: "SIGN_OUT" }, nav)).toBe(true);
    expect(posted).toEqual([{ type: "SIGN_OUT" }]);
  });

  it("posts to the controller SYNCHRONOUSLY — before the registration lookup, which a hard sign-out navigation may never let resolve", () => {
    const posted: unknown[] = [];
    const controller = { postMessage: (m: unknown) => posted.push(m) };
    const nav = { serviceWorker: { controller, getRegistration: () => new Promise<never>(() => { /* never resolves */ }) } };
    void clearServiceWorkerSession(nav); // un-awaited, exactly as every sign-out site calls it
    expect(posted).toEqual([{ type: "SIGN_OUT" }]);
  });

  it("a registration lookup that throws AFTER the controller was posted still reports success, and the controller is posted once", async () => {
    const posted: unknown[] = [];
    const controller = { postMessage: (m: unknown) => posted.push(m) };
    expect(await clearServiceWorkerSession({ serviceWorker: { controller, getRegistration: async () => { throw new Error("nope"); } } })).toBe(true);
    expect(await announceServiceWorkerSession("uid-b", { serviceWorker: { controller, getRegistration: async () => ({ active: controller, waiting: null }) } })).toBe(true);
    expect(posted).toEqual([{ type: "SIGN_OUT" }, { type: "SESSION", id: "uid-b" }]);
  });

  it("is best-effort: no service worker API, no worker, or a throwing registration lookup → false, never a throw", async () => {
    expect(await clearServiceWorkerSession({})).toBe(false);
    expect(await clearServiceWorkerSession(undefined)).toBe(false);
    expect(await clearServiceWorkerSession({ serviceWorker: { controller: null, getRegistration: async () => undefined } })).toBe(false);
    expect(await clearServiceWorkerSession({ serviceWorker: { controller: null, getRegistration: async () => { throw new Error("nope"); } } })).toBe(false);
  });

  it("every sign-out site tells the worker, and the protected layout announces the session", () => {
    const src = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");
    for (const p of [
      "components/navigation/Sidebar.tsx",
      "app/(protected)/profile/page.tsx",
      "app/(protected)/layout.tsx",
      "components/subscription/SubscriptionGate.tsx",
    ]) {
      const s = src(p);
      expect(s, p).toMatch(/from "@\/lib\/swSession"|from '@\/lib\/swSession'/);
      expect(s, p).toMatch(/clearServiceWorkerSession\(\)/);
      // the worker is told BEFORE the session is torn down at every site
      const signOuts = [...s.matchAll(/supabase\.auth\.signOut\(\)/g)].map((m) => m.index ?? 0);
      expect(signOuts.length, p).toBeGreaterThan(0);
      for (const at of signOuts) {
        const before = s.slice(Math.max(0, at - 400), at);
        expect(before, `${p}: sign-out at ${at} not preceded by clearServiceWorkerSession()`).toMatch(/clearServiceWorkerSession\(\)/);
      }
    }
    const layout = src("app/(protected)/layout.tsx");
    expect(layout).toMatch(/announceServiceWorkerSession\(uid\)/);
    // no other sign-out site exists to miss (the signatures route's probe client is server-side)
    expect(src("app/page.tsx")).not.toMatch(/auth\.signOut\(/);
  });
});

describe("OFF-8 — whichever way the session ends, Cache Storage is emptied before the redirect", () => {
  const roleContext = readFileSync(resolve(process.cwd(), "components/providers/RoleContext.tsx"), "utf8");
  const start = roleContext.indexOf('if (event === "SIGNED_OUT") {');
  const block = roleContext.slice(start, roleContext.indexOf('window.location.replace("/");', start) + 'window.location.replace("/");'.length);

  it("the SIGNED_OUT branch deletes every cache, awaited and bounded, before window.location.replace", () => {
    expect(start).toBeGreaterThan(0);
    expect(block).toMatch(/caches\.keys\(\)/);
    expect(block).toMatch(/caches\.delete\(/);
    expect(block).toMatch(/await Promise\.race\(\[/);           // awaited …
    expect(block).toMatch(/setTimeout\(/);                        // … but never allowed to hold the sign-out
    expect(block).toMatch(/typeof caches !== "undefined"/);       // no Cache Storage (plain HTTP) is not an error
    expect(block.indexOf("caches.delete(")).toBeLessThan(block.indexOf('window.location.replace("/")'));
  });

  it("the purge it runs empties every cache, including one the worker is not tracking", async () => {
    // The block's purge, lifted verbatim, against an in-memory CacheStorage.
    const purge = block.match(/const purge = ([\s\S]*?);\n/)?.[1];
    expect(purge).toBeTruthy();
    const names = new Set([RUNTIME, SHELL, SESSION, "mfgos-v6-runtime", "some-other-cache"]);
    const caches = { keys: async () => [...names], delete: async (n: string) => names.delete(n) };
    await new Function("caches", `return ${purge};`)(caches);
    expect([...names]).toEqual([]);
  });
});

describe("OFF-3 / OFF-4 — the page side: honest offline copy, an update button that always reloads", () => {
  afterEach(() => vi.useRealTimers());

  it("the offline pill says the connection is lost and data may be missing — never that cached data is being shown", () => {
    expect(OFFLINE_PILL_TEXT).not.toMatch(/cached/i);
    expect(OFFLINE_PILL_TEXT).toMatch(/missing/i);
    const src = readFileSync(resolve(process.cwd(), "components/pwa/ServiceWorkerManager.tsx"), "utf8");
    expect(src).not.toMatch(/showing cached data/);
    expect(src).toMatch(/\{OFFLINE_PILL_TEXT\}/);
  });

  it("the offline page no longer claims recently opened data is available", () => {
    const src = readFileSync(resolve(process.cwd(), "app/offline/page.tsx"), "utf8");
    expect(src).not.toMatch(/still available/);
    expect(src).not.toMatch(/data you\s+opened recently/);
    expect(src).toMatch(/not kept on this\s+device/);
  });

  it("offline is derived from the worker's NETWORK reports, not navigator.onLine alone", () => {
    expect(networkSignal({ type: "NETWORK", ok: false })).toBe(false);
    expect(networkSignal({ type: "NETWORK", ok: true })).toBe(true);
    expect(networkSignal({ type: "NETWORK" })).toBeNull();
    expect(networkSignal({ type: "OTHER", ok: false })).toBeNull();
    expect(networkSignal("NETWORK")).toBeNull();
    expect(networkSignal(null)).toBeNull();
    const src = readFileSync(resolve(process.cwd(), "components/pwa/ServiceWorkerManager.tsx"), "utf8");
    expect(src).toMatch(/NETWORK_STATUS/);
    expect(src).toMatch(/browserOffline \|\| unreachable/);
  });

  const fakeEnv = () => {
    const listeners: Record<string, Array<() => void>> = {};
    const timers: Array<{ cb: () => void; ms: number }> = [];
    const reload = vi.fn();
    return {
      listeners, timers, reload,
      env: {
        serviceWorker: { addEventListener: (type: "controllerchange", cb: () => void) => { (listeners[type] ??= []).push(cb); } },
        reload,
        setTimeout: (cb: () => void, ms: number) => { timers.push({ cb, ms }); return timers.length; },
      },
    };
  };

  it("tapping the toast tells the WAITING worker to take over and reloads on controllerchange — once", () => {
    const { env, listeners, timers, reload } = fakeEnv();
    const waiting = { postMessage: vi.fn() };
    applyServiceWorkerUpdate(waiting, env);
    expect(waiting.postMessage).toHaveBeenCalledWith("SKIP_WAITING");
    expect(reload).not.toHaveBeenCalled();
    listeners.controllerchange!.forEach((cb) => cb());
    expect(reload).toHaveBeenCalledTimes(1);
    timers.forEach((t) => t.cb()); // the fallback firing later does not reload twice
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("the button can never do nothing: no controllerchange → an unconditional reload after the timeout", () => {
    const { env, timers, reload } = fakeEnv();
    applyServiceWorkerUpdate({ postMessage: vi.fn() }, env);
    expect(timers.map((t) => t.ms)).toEqual([UPDATE_RELOAD_FALLBACK_MS]);
    expect(UPDATE_RELOAD_FALLBACK_MS).toBeLessThanOrEqual(5000);
    timers[0].cb();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("no waiting worker, no service worker API, or a worker that refuses the message → reload at once", () => {
    for (const [waiting, sw] of [[null, true], [{ postMessage: vi.fn() }, false], [{ postMessage: () => { throw new Error("gone"); } }, true]] as const) {
      const { env, reload } = fakeEnv();
      applyServiceWorkerUpdate(waiting, sw ? env : { ...env, serviceWorker: null });
      expect(reload).toHaveBeenCalledTimes(1);
    }
  });
});
