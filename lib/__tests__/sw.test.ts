// lib/__tests__/sw.test.ts
//
// Contract for the minimal/safe service worker (public/sw.js):
//   - It calls respondWith ONLY for immutable same-origin static assets.
//   - It NEVER intercepts navigations, API/RSC requests, cross-origin, or
//     non-GET requests — those pass straight through to the browser, so the SW
//     can never fabricate a "504 (Offline)" or offline-page stub that breaks
//     navigation or blocks uploads.
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
  const factory = new Function("self", "caches", "fetch", "Response", "URL", code);
  factory(self, caches, opts.fetchImpl, globalThis.Response, globalThis.URL);
  return { handlers, caches };
}

function fire(handlers: Record<string, Handler>, request: { method: string; url: string; mode?: string }) {
  let handled = false;
  let captured: Promise<Response> | undefined;
  handlers.fetch!({ request, respondWith: (p: Promise<Response>) => { handled = true; captured = p; } });
  return { handled, get: () => captured };
}

describe("service worker — minimal/safe contract", () => {
  const passthrough = async () => new Response("x");

  it("does NOT intercept navigations (no synthetic offline/504)", () => {
    const { handlers } = loadServiceWorker({ fetchImpl: passthrough });
    const { handled } = fire(handlers, { method: "GET", url: "https://app.test/requests/new", mode: "navigate" });
    expect(handled).toBe(false);
  });

  it("does NOT intercept same-origin API / RSC GETs", () => {
    const { handlers } = loadServiceWorker({ fetchImpl: passthrough });
    expect(fire(handlers, { method: "GET", url: "https://app.test/api/storage/download-url?path=x" }).handled).toBe(false);
    expect(fire(handlers, { method: "GET", url: "https://app.test/requests/new?_rsc=abc" }).handled).toBe(false);
  });

  it("does NOT intercept cross-origin or non-GET (uploads, Supabase, R2)", () => {
    const { handlers } = loadServiceWorker({ fetchImpl: passthrough });
    expect(fire(handlers, { method: "POST", url: "https://app.test/api/storage/upload-url" }).handled).toBe(false);
    expect(fire(handlers, { method: "PUT", url: "https://xxx.supabase.co/storage/v1/object/upload/sign/a/b" }).handled).toBe(false);
    expect(fire(handlers, { method: "GET", url: "https://xxx.supabase.co/rest/v1/tickets" }).handled).toBe(false);
  });

  it("serves immutable build assets cache-first", async () => {
    const cached = new Response("cached-js", { status: 200 });
    const { handlers } = loadServiceWorker({
      fetchImpl: passthrough,
      cacheMatch: async (req) => ((req as { url: string }).url.includes("/_next/static/") ? cached : undefined),
    });
    const { handled, get } = fire(handlers, { method: "GET", url: "https://app.test/_next/static/chunk.js" });
    expect(handled).toBe(true);
    expect(await get()).toBe(cached);
  });

  it("fetches an uncached static asset from the network (no fabricated response)", async () => {
    const net = new Response("net-css", { status: 200 });
    const { handlers } = loadServiceWorker({ fetchImpl: async () => net });
    const { handled, get } = fire(handlers, { method: "GET", url: "https://app.test/icon.svg" });
    expect(handled).toBe(true);
    const res = await get();
    expect(res).toBe(net);
  });
});
