// lib/__tests__/sw.test.ts
//
// Regression guard for the service worker (public/sw.js): every fetch branch
// must resolve to a real Response. The old navigation handler could resolve to
// `undefined` when a page wasn't cached, which made the browser fail the request
// with "Failed to convert value to 'Response'" and broke navigation to
// /projects/[id]. These tests load the worker into a fake global scope and
// assert it always hands respondWith() a Response.
//
// document-control Round F — XEDGE-6 (DEC-44 §3): the worker is also a
// device-wide cache that used to outlive sign-out and ignore Cache-Control.
// It now refuses to store any response marked no-store / private and ANY
// same-origin /api/ response (the signed-URL JSON, the streamed share PDF),
// never replays an /api/ entry offline, purges its runtime cache on a
// SIGN_OUT message and whenever the SESSION identity a page announces
// differs from the one it remembered, and bumps VERSION so every cache an
// older worker filled is dropped on activate.
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { postServiceWorkerMessage, clearServiceWorkerSession, announceServiceWorkerSession } from "@/lib/swSession";

type Handler = (event: unknown) => void;
type Store = {
  entries: Map<string, Response>;
  put: ReturnType<typeof vi.fn<(req: unknown, res: Response) => Promise<void>>>;
  addAll: ReturnType<typeof vi.fn<() => Promise<undefined>>>;
  match: ReturnType<typeof vi.fn<(req: unknown) => Promise<Response | undefined>>>;
  delete: ReturnType<typeof vi.fn<(req: unknown) => Promise<boolean>>>;
};

const SW_SOURCE = readFileSync(resolve(process.cwd(), "public/sw.js"), "utf8");
const VERSION = SW_SOURCE.match(/const VERSION = "mfgos-v(\d+)"/)![1];
const RUNTIME = `mfgos-v${VERSION}-runtime`;
const SESSION = `mfgos-v${VERSION}-session`;

function loadServiceWorker(opts: {
  fetchImpl: (req: unknown) => Promise<Response>;
  cacheMatch?: (req: unknown) => Promise<Response | undefined>;
}) {
  const handlers: Record<string, Handler> = {};
  const stores = new Map<string, Store>();
  const keyOf = (req: unknown) => (typeof req === "string" ? req : (req as { url: string }).url);
  const storeFor = (name: string): Store => {
    let s = stores.get(name);
    if (!s) {
      const entries = new Map<string, Response>();
      s = {
        entries,
        put: vi.fn(async (req: unknown, res: Response) => { entries.set(keyOf(req), res); }),
        addAll: vi.fn(async () => undefined),
        match: vi.fn(async (req: unknown) => entries.get(keyOf(req))?.clone()),
        delete: vi.fn(async (req: unknown) => entries.delete(keyOf(req))),
      };
      stores.set(name, s);
    }
    return s;
  };
  const caches = {
    open: vi.fn(async (name: string) => storeFor(name)),
    match: vi.fn(opts.cacheMatch ?? (async () => undefined)),
    keys: vi.fn(async () => [...stores.keys()]),
    delete: vi.fn(async (name: string) => stores.delete(name)),
  };
  const self = {
    addEventListener: (type: string, h: Handler) => { handlers[type] = h; },
    location: { origin: "https://app.test" },
    skipWaiting: vi.fn(),
    clients: { claim: vi.fn() },
  };
  // The worker is a classic script that reads bare globals (self, caches, fetch,
  // Response, URL); a Function factory is the cleanest way to inject mocks.
  const factory = new Function("self", "caches", "fetch", "Response", "URL", SW_SOURCE);
  factory(self, caches, opts.fetchImpl, globalThis.Response, globalThis.URL);
  /** Every cache write the worker performed, across every cache name. */
  const puts = () => [...stores.values()].flatMap((s) => s.put.mock.calls.map((c) => keyOf(c[0])));
  /** Deliver a message and await whatever the worker asked to keep alive. */
  const message = async (data: unknown) => {
    let pending: Promise<unknown> | undefined;
    handlers.message!({ data, waitUntil: (p: Promise<unknown>) => { pending = p; } });
    await pending;
  };
  return { handlers, caches, stores, storeFor, puts, message };
}

function navEvent(url: string) {
  let captured: Promise<Response> | undefined;
  const event = {
    request: { method: "GET", url, mode: "navigate" },
    respondWith: (p: Promise<Response>) => { captured = p; },
  };
  return { event, get: () => captured };
}

function dataEvent(url: string) {
  let captured: Promise<Response> | undefined;
  const event = {
    request: { method: "GET", url, mode: "cors", headers: { get: () => null } },
    respondWith: (p: Promise<Response>) => { captured = p; },
  };
  return { event, get: () => captured };
}

describe("service worker fetch handler", () => {
  it("returns a real Response for a navigation even when offline and nothing is cached", async () => {
    const { handlers } = loadServiceWorker({
      fetchImpl: async () => { throw new Error("offline"); },
      cacheMatch: async () => undefined,
    });
    const { event, get } = navEvent("https://app.test/projects/abc");
    handlers.fetch!(event);
    const res = await get();
    expect(res).toBeInstanceOf(Response); // never undefined -> no "convert to Response" crash
    expect(res!.status).toBe(503);        // the synthetic offline page
  });

  it("serves the network response for a navigation when online", async () => {
    const ok = new Response("<html>page</html>", { status: 200, headers: { "Content-Type": "text/html" } });
    const { handlers } = loadServiceWorker({ fetchImpl: async () => ok });
    const { event, get } = navEvent("https://app.test/projects/abc");
    handlers.fetch!(event);
    const res = await get();
    expect(res).toBeInstanceOf(Response);
    expect(res!.status).toBe(200);
  });

  it("falls back to a cached page when the network fails", async () => {
    const cachedPage = new Response("<html>cached</html>", { status: 200 });
    const { handlers } = loadServiceWorker({
      fetchImpl: async () => { throw new Error("offline"); },
      cacheMatch: async (req) => ((req as { url: string }).url.endsWith("/projects/abc") ? cachedPage : undefined),
    });
    const { event, get } = navEvent("https://app.test/projects/abc");
    handlers.fetch!(event);
    const res = await get();
    expect(res).toBe(cachedPage);
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
    const cacheMatch = vi.fn(async () => new Response("stale", { status: 200 }));
    const { handlers, caches } = loadServiceWorker({
      fetchImpl: async () => new Response("rsc-payload", { status: 200 }),
      cacheMatch,
    });
    let responded = false;
    handlers.fetch!({
      request: { method: "GET", url: "https://app.test/documents?_rsc=abc123", mode: "cors", headers: { get: () => null } },
      respondWith: () => { responded = true; },
    });
    expect(responded).toBe(false);                // browser handles it directly
    expect(caches.match).not.toHaveBeenCalled();  // cache never consulted
  });

  it("leaves RSC requests flagged by header alone too, not just ?_rsc", () => {
    const { handlers } = loadServiceWorker({ fetchImpl: async () => new Response("x") });
    let responded = false;
    handlers.fetch!({
      request: {
        method: "GET", url: "https://app.test/documents", mode: "cors",
        headers: { get: (k: string) => (k === "RSC" ? "1" : null) },
      },
      respondWith: () => { responded = true; },
    });
    expect(responded).toBe(false);
  });

  it("ignores cross-origin and non-GET requests (no respondWith)", () => {
    const { handlers } = loadServiceWorker({ fetchImpl: async () => new Response("x") });
    let called = false;
    handlers.fetch!({ request: { method: "GET", url: "https://supabase.co/rest", mode: "cors" }, respondWith: () => { called = true; } });
    handlers.fetch!({ request: { method: "POST", url: "https://app.test/api", mode: "cors" }, respondWith: () => { called = true; } });
    expect(called).toBe(false);
  });
});

describe("XEDGE-6 — what the worker will and will not store", () => {
  it("bumped VERSION so every cache an older worker filled is swept on activate", async () => {
    expect(Number(VERSION)).toBeGreaterThanOrEqual(6);
    const { handlers, caches, storeFor } = loadServiceWorker({ fetchImpl: async () => new Response("x") });
    storeFor("mfgos-v5-runtime"); // a leftover from the previous worker
    storeFor(RUNTIME);
    let pending: Promise<unknown> | undefined;
    handlers.activate!({ waitUntil: (p: Promise<unknown>) => { pending = p; } });
    await pending;
    expect(caches.delete).toHaveBeenCalledWith("mfgos-v5-runtime");
    expect(caches.delete).not.toHaveBeenCalledWith(RUNTIME);
  });

  // Next marks dynamically rendered pages `private, no-cache, no-store, …`,
  // so those shells no longer cache offline (XEDGE-6 residual); a navigation
  // the server did NOT mark no-store still does.
  it("still caches a navigation the server did not mark no-store (Field Mode keeps its static shells)", async () => {
    const { handlers, puts } = loadServiceWorker({
      fetchImpl: async () => new Response("<html>page</html>", { status: 200, headers: { "Content-Type": "text/html" } }),
    });
    const { event, get } = navEvent("https://app.test/projects/abc");
    handlers.fetch!(event);
    await get();
    await Promise.resolve();
    expect(puts()).toEqual(["https://app.test/projects/abc"]);
  });

  it("never writes a Cache-Control: no-store response — navigation or sub-resource", async () => {
    for (const mk of [navEvent, dataEvent]) {
      const { handlers, puts } = loadServiceWorker({
        fetchImpl: async () => new Response("%PDF-1.7", { status: 200, headers: { "Cache-Control": "no-store", "Content-Type": "application/pdf" } }),
      });
      const { event, get } = mk("https://app.test/share/file.pdf");
      handlers.fetch!(event);
      const res = await get();
      expect(res!.status).toBe(200); // still SERVED, just not stored
      await Promise.resolve();
      expect(puts()).toEqual([]);
    }
  });

  it("refuses Cache-Control: private the same way", async () => {
    const { handlers, puts } = loadServiceWorker({
      fetchImpl: async () => new Response("{}", { status: 200, headers: { "Cache-Control": "private, max-age=60" } }),
    });
    const { event, get } = dataEvent("https://app.test/data.json");
    handlers.fetch!(event);
    await get();
    await Promise.resolve();
    expect(puts()).toEqual([]);
  });

  it("never stores ANY same-origin /api/ response, even one with no cache header (the signed-URL JSON)", async () => {
    const { handlers, puts } = loadServiceWorker({
      fetchImpl: async () => new Response(JSON.stringify({ url: "https://r2/signed" }), { status: 200, headers: { "Content-Type": "application/json" } }),
    });
    const { event, get } = dataEvent("https://app.test/api/storage/download-url?path=orgs/x/y.pdf&expiresIn=3600");
    handlers.fetch!(event);
    const res = await get();
    expect(res!.status).toBe(200);
    await Promise.resolve();
    expect(puts()).toEqual([]);
  });

  it("never replays an /api/ entry offline either — a leftover is a 503, not a stale signed URL", async () => {
    const cacheMatch = vi.fn(async () => new Response("{\"url\":\"stale\"}", { status: 200 }));
    const { handlers } = loadServiceWorker({
      fetchImpl: async () => { throw new Error("offline"); },
      cacheMatch,
    });
    const { event, get } = dataEvent("https://app.test/api/storage/download-url?path=x");
    handlers.fetch!(event);
    const res = await get();
    expect(res!.status).toBe(503);
    expect(cacheMatch).not.toHaveBeenCalled();
  });

  it("a non-API same-origin data GET is still cached and still served from cache offline", async () => {
    const { handlers, puts } = loadServiceWorker({
      fetchImpl: async () => new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }),
    });
    const { event, get } = dataEvent("https://app.test/manifest.webmanifest");
    handlers.fetch!(event);
    await get();
    await Promise.resolve();
    expect(puts()).toEqual(["https://app.test/manifest.webmanifest"]);
  });
});

describe("XEDGE-6 — the cache does not outlive the session", () => {
  it("SIGN_OUT deletes the runtime cache and forgets the session identity", async () => {
    const { caches, storeFor, message } = loadServiceWorker({ fetchImpl: async () => new Response("x") });
    storeFor(RUNTIME).entries.set("https://app.test/documents", new Response("cached"));
    const session = storeFor(SESSION);
    session.entries.set("/__mfgos/session", new Response("uid-a"));
    await message({ type: "SIGN_OUT" });
    expect(caches.delete).toHaveBeenCalledWith(RUNTIME);
    expect(session.entries.has("/__mfgos/session")).toBe(false);
  });

  it("SESSION: an unknown or CHANGED identity purges the runtime cache; the same identity does not", async () => {
    const { caches, storeFor, message } = loadServiceWorker({ fetchImpl: async () => new Response("x") });
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
