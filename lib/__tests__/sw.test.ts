// lib/__tests__/sw.test.ts
//
// Regression guard for the service worker (public/sw.js): every fetch branch
// must resolve to a real Response. The old navigation handler could resolve to
// `undefined` when a page wasn't cached, which made the browser fail the request
// with "Failed to convert value to 'Response'" and broke navigation to
// /projects/[id]. These tests load the worker into a fake global scope and
// assert it always hands respondWith() a Response.
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

type Handler = (event: unknown) => void;

function loadServiceWorker(opts: {
  fetchImpl: (req: unknown) => Promise<Response>;
  cacheMatch?: (req: unknown) => Promise<Response | undefined>;
}) {
  const handlers: Record<string, Handler> = {};
  const cacheStore = {
    put: vi.fn(async () => undefined),
    addAll: vi.fn(async () => undefined),
    match: vi.fn(async () => undefined),
  };
  const caches = {
    open: vi.fn(async () => cacheStore),
    match: vi.fn(opts.cacheMatch ?? (async () => undefined)),
    keys: vi.fn(async () => []),
    delete: vi.fn(async () => true),
  };
  const self = {
    addEventListener: (type: string, h: Handler) => { handlers[type] = h; },
    location: { origin: "https://app.test" },
    skipWaiting: vi.fn(),
    clients: { claim: vi.fn() },
  };
  const code = readFileSync(resolve(process.cwd(), "public/sw.js"), "utf8");
  // The worker is a classic script that reads bare globals (self, caches, fetch,
  // Response, URL); a Function factory is the cleanest way to inject mocks.
  const factory = new Function("self", "caches", "fetch", "Response", "URL", code);
  factory(self, caches, opts.fetchImpl, globalThis.Response, globalThis.URL);
  return { handlers, caches };
}

function navEvent(url: string) {
  let captured: Promise<Response> | undefined;
  const event = {
    request: { method: "GET", url, mode: "navigate" },
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

  it("ignores cross-origin and non-GET requests (no respondWith)", () => {
    const { handlers } = loadServiceWorker({ fetchImpl: async () => new Response("x") });
    let called = false;
    handlers.fetch!({ request: { method: "GET", url: "https://supabase.co/rest", mode: "cors" }, respondWith: () => { called = true; } });
    handlers.fetch!({ request: { method: "POST", url: "https://app.test/api", mode: "cors" }, respondWith: () => { called = true; } });
    expect(called).toBe(false);
  });
});
