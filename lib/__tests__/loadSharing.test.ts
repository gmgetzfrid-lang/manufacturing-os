// lib/__tests__/loadSharing.test.ts
//
// The two pieces that make screens open fast without ever mixing up whose
// data is shown: lib/warmLoads (a load shared and its last answer kept,
// forgotten on sign-out) and lib/requestLog (the same read asked twice at
// once goes out once; the timing view keeps only table names, never ids).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { sharedLoad, lastLoaded, keepLoaded, forgetLoads } from "@/lib/warmLoads";
import { loggedFetch, whatOf } from "@/lib/requestLog";

describe("warmLoads", () => {
  beforeEach(() => forgetLoads());

  it("shares one load between readers and keeps its answer", async () => {
    const load = vi.fn(async () => ({ n: 1 }));
    const [a, b] = await Promise.all([sharedLoad("k", load), sharedLoad("k", load)]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    expect(lastLoaded("k")).toEqual({ n: 1 });
  });

  it("a fresh ask loads again and its answer replaces the kept one", async () => {
    await sharedLoad("k", async () => 1);
    await sharedLoad("k", async () => 2, { fresh: true });
    expect(lastLoaded("k")).toBe(2);
  });

  it("keeps the newest answer when an older load answers last", async () => {
    let finishOld!: (v: string) => void;
    const old = sharedLoad("k", () => new Promise<string>((r) => { finishOld = r; }));
    await sharedLoad("k", async () => "new", { fresh: true });
    finishOld("old");
    await old;
    expect(lastLoaded("k")).toBe("new");
  });

  it("forgets everything on sign-out, including a load still on its way", async () => {
    keepLoaded("a", 1);
    let finish!: (v: number) => void;
    const p = sharedLoad("b", () => new Promise<number>((r) => { finish = r; }));
    forgetLoads();
    finish(2);
    await p;
    expect(lastLoaded("a")).toBeUndefined();
    expect(lastLoaded("b")).toBeUndefined();
  });

  it("does not keep a failed load", async () => {
    await expect(sharedLoad("k", async () => { throw new Error("no"); })).rejects.toThrow("no");
    const load = vi.fn(async () => 3);
    expect(await sharedLoad("k", load)).toBe(3);
    expect(load).toHaveBeenCalledTimes(1);
  });
});

describe("requestLog", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  it("names the table or route, never the query or ids", () => {
    expect(whatOf("https://x.supabase.co/rest/v1/tickets?select=*&org_id=eq.215b762d-7be4-4cbd-bdb1-4b2703d81296")).toBe("tickets");
    expect(whatOf("https://x.supabase.co/rest/v1/rpc/search_docs")).toBe("rpc search_docs");
    expect(whatOf("https://x.supabase.co/auth/v1/token?grant_type=password")).toBe("auth token");
    expect(whatOf("/api/projects/215b762d-7be4-4cbd-bdb1-4b2703d81296/report?x=1")).toBe("/api/projects/:id/report");
  });

  it("sends the same read asked twice at once only once, each caller its own copy", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([{ id: 1 }]), { status: 200, headers: { "content-range": "0-0/1" } }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const init = { method: "GET", headers: { Authorization: "Bearer a", Accept: "application/json" } };
    const [r1, r2] = await Promise.all([loggedFetch("https://x.supabase.co/rest/v1/t?a=1", init), loggedFetch("https://x.supabase.co/rest/v1/t?a=1", init)]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await r1.json()).toEqual([{ id: 1 }]);
    expect(await r2.json()).toEqual([{ id: 1 }]);
  });

  it("never shares across sign-ins, writes, or after the answer came", async () => {
    const fetchMock = vi.fn(async () => new Response("[]", { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const url = "https://x.supabase.co/rest/v1/t";
    await Promise.all([
      loggedFetch(url, { method: "GET", headers: { Authorization: "Bearer a" } }),
      loggedFetch(url, { method: "GET", headers: { Authorization: "Bearer b" } }),
      loggedFetch(url, { method: "POST", headers: { Authorization: "Bearer a" }, body: "{}" }),
      loggedFetch(url, { method: "POST", headers: { Authorization: "Bearer a" }, body: "{}" }),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    await loggedFetch(url, { method: "GET", headers: { Authorization: "Bearer a" } });
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });
});
