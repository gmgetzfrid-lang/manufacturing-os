// Document-control Round F — P10 EDGES: XEDGE-9, the export SSRF guard.
//
// Before: assertSafeExternalUrl checked the URL it was given, then a plain
// fetch() followed redirects on its own — a public host answering 307 →
// http://169.254.169.254/… received the whole org ZIP with the guard never
// re-run, and only the FIRST resolved address was checked. Now every hop is
// re-checked, the chain is bounded, a redirect that would drop a POST body is
// refused, every DNS answer is checked, and the connection test returns a
// boolean rather than echoing the upstream status.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const state = vi.hoisted(() => ({
  dns: {} as Record<string, string[]>,
  fetches: [] as Array<{ url: string; init: RequestInit }>,
  responses: [] as Response[],
}));

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async (host: string, opts?: { all?: boolean }) => {
    const addrs = state.dns[host] ?? ["93.184.216.34"];
    if (opts?.all) return addrs.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
    return { address: addrs[0], family: 4 };
  }),
}));

import { assertSafeExternalUrl, fetchExternalGuarded, testDestinationConnection, MAX_REDIRECT_HOPS } from "@/lib/exportRunner";

const redirect = (status: number, location: string) => new Response(null, { status, headers: { location } });
const ok = (status = 200) => new Response(null, { status });

beforeEach(() => {
  state.dns = {};
  state.fetches = [];
  state.responses = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    state.fetches.push({ url, init });
    const next = state.responses.shift();
    if (!next) throw new Error("no scripted response");
    return next;
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe("assertSafeExternalUrl checks EVERY address (XEDGE-9 done-when 3)", () => {
  it("a host with a private A record among public ones is refused", async () => {
    state.dns["mixed.example"] = ["93.184.216.34", "10.0.0.5"];
    await expect(assertSafeExternalUrl("https://mixed.example/hook")).rejects.toThrow(/private address 10\.0\.0\.5/);
    state.dns["clean.example"] = ["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"];
    await expect(assertSafeExternalUrl("https://clean.example/hook")).resolves.toBeUndefined();
  });
  it("a host that does not resolve is refused", async () => {
    state.dns["ghost.example"] = [];
    await expect(assertSafeExternalUrl("https://ghost.example/")).rejects.toThrow(/does not resolve/);
  });
});

describe("fetchExternalGuarded (XEDGE-9 done-when 1)", () => {
  it("never follows a redirect to a private address — the body is never sent there", async () => {
    state.responses = [redirect(307, "http://169.254.169.254/latest/meta-data/")];
    await expect(fetchExternalGuarded("https://hooks.example/in", { method: "POST", body: "ZIP" }))
      .rejects.toThrow(/Blocked private-range destination address/);
    expect(state.fetches).toHaveLength(1);
    expect(state.fetches[0].init.redirect).toBe("manual");
  });

  it("follows a public 307 with the body intact, re-checking each hop, and returns the final response", async () => {
    state.responses = [redirect(307, "https://other.example/final"), ok(200)];
    const res = await fetchExternalGuarded("https://hooks.example/in", { method: "POST", body: "ZIP" });
    expect(res.status).toBe(200);
    expect(state.fetches.map((f) => f.url)).toEqual(["https://hooks.example/in", "https://other.example/final"]);
    expect(state.fetches.every((f) => f.init.redirect === "manual" && f.init.body === "ZIP")).toBe(true);
  });

  it("resolves a relative Location against the current URL and re-checks it", async () => {
    state.responses = [redirect(308, "/v2/in"), ok(204)];
    const res = await fetchExternalGuarded("https://hooks.example/v1/in", { method: "POST", body: "ZIP" });
    expect(res.status).toBe(204);
    expect(state.fetches[1].url).toBe("https://hooks.example/v2/in");
  });

  it("bounds the chain", async () => {
    state.responses = Array.from({ length: MAX_REDIRECT_HOPS + 1 }, (_, i) => redirect(307, `https://h${i}.example/`));
    await expect(fetchExternalGuarded("https://hooks.example/in", { method: "POST", body: "ZIP" }))
      .rejects.toThrow(new RegExp(`more than ${MAX_REDIRECT_HOPS} times`));
    expect(state.fetches).toHaveLength(MAX_REDIRECT_HOPS + 1);
  });

  it("refuses a 301/302/303 on a POST rather than silently delivering nothing", async () => {
    for (const status of [301, 302, 303]) {
      state.fetches = [];
      state.responses = [redirect(status, "https://other.example/")];
      await expect(fetchExternalGuarded("https://hooks.example/in", { method: "POST", body: "ZIP" }))
        .rejects.toThrow(new RegExp(`HTTP ${status} redirect, which would drop the export body`));
      expect(state.fetches).toHaveLength(1);
    }
    // a HEAD probe may follow any of them
    state.responses = [redirect(302, "https://other.example/"), ok(200)];
    expect((await fetchExternalGuarded("https://hooks.example/in", { method: "HEAD" })).status).toBe(200);
  });

  it("a non-redirect response is returned as-is, including errors", async () => {
    state.responses = [ok(503)];
    expect((await fetchExternalGuarded("https://hooks.example/in", { method: "POST", body: "ZIP" })).status).toBe(503);
  });
});

describe("testDestinationConnection returns a boolean, not the upstream status (XEDGE-9 done-when 4)", () => {
  const dest = { id: "d", org_id: "o", destination_type: "webhook" as const, webhook_url: "https://hooks.example/in" };

  it("an upstream 4xx/5xx becomes a generic refusal with no status code in it", async () => {
    state.responses = [ok(503)];
    const r = await testDestinationConnection(dest);
    expect(r.ok).toBe(false);
    expect(r.error).not.toMatch(/\b503\b/);
    expect(r.error).toMatch(/did not accept the probe/);
  });

  it("a redirect into the private network is refused, never probed", async () => {
    state.responses = [redirect(307, "http://10.0.0.8:6379/")];
    const r = await testDestinationConnection(dest);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Blocked private-range/);
    expect(state.fetches).toHaveLength(1);
  });

  it("a healthy endpoint (2xx, or 405 to HEAD) is ok", async () => {
    state.responses = [ok(405)];
    expect((await testDestinationConnection(dest)).ok).toBe(true);
    state.responses = [ok(200)];
    expect((await testDestinationConnection(dest)).ok).toBe(true);
  });

  it("the delivery POST goes through the guarded fetch (source pin)", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(`${process.cwd()}/lib/exportRunner.ts`, "utf8");
    expect(src).toMatch(/const res = await fetchExternalGuarded\(dest\.webhook_url, \{\s*method: "POST"/);
    expect(src).not.toMatch(/await fetch\(dest\.webhook_url/);
  });
});
