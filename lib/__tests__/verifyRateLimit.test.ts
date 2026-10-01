// public-surfaces Round F PS-VERIFY — the verify door (VFY-12, VFY-13):
// lib/verifyRateLimit.ts (per-IP cap, fail-open, no-store answers) and
// lib/verifyScanLog.ts (the checked, never-blocking scan record).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  checkVerifyRate, verifyMaxPerIpHour, verifyJson, verifyRateLimitedResponse,
  DEFAULT_VERIFY_MAX_PER_IP_HOUR, VERIFY_RETRY_AFTER_SEC, clientIp,
} from "@/lib/verifyRateLimit";
import {
  recordVerifyScan, verifyScanRow, isMissingScanTable, __resetVerifyScanLogWarnings, VERIFY_SCAN_RETENTION_DAYS,
} from "@/lib/verifyScanLog";

type Call = { table: string; method: string; args: unknown[] };

/** A minimal `.from()` client: records calls, answers with `answer`. */
function client(answer: { count?: number | null; error?: { code?: string; message?: string } | null; throws?: boolean }) {
  const calls: Call[] = [];
  const from = (table: string) => {
    const c: Record<string, unknown> = {};
    const h: ProxyHandler<Record<string, unknown>> = {
      get(_t, p: string) {
        if (p === "then") return (resolve: (v: unknown) => void, reject: (e: unknown) => void) => {
          if (answer.throws) return reject(new Error("network down"));
          resolve({ data: null, count: answer.count ?? null, error: answer.error ?? null });
        };
        return (...args: unknown[]) => { calls.push({ table, method: p, args }); return new Proxy(c, h); };
      },
    };
    return new Proxy(c, h);
  };
  return { from, calls };
}

let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  __resetVerifyScanLogWarnings();
});
afterEach(() => errSpy.mockRestore());

describe("checkVerifyRate — a generous per-IP hourly cap that fails OPEN", () => {
  it("default cap is 1200 / IP / hour; VERIFY_MAX_PER_IP_HOUR overrides; garbage falls back", () => {
    expect(DEFAULT_VERIFY_MAX_PER_IP_HOUR).toBe(1200);
    expect(verifyMaxPerIpHour({})).toBe(1200);
    expect(verifyMaxPerIpHour({ VERIFY_MAX_PER_IP_HOUR: "5000" })).toBe(5000);
    expect(verifyMaxPerIpHour({ VERIFY_MAX_PER_IP_HOUR: "-3" })).toBe(1200);
    expect(verifyMaxPerIpHour({ VERIFY_MAX_PER_IP_HOUR: "lots" })).toBe(1200);
  });
  it("counts the caller's verify_scans rows in the last hour", async () => {
    const c = client({ count: 3 });
    const now = Date.parse("2026-10-01T12:00:00Z");
    expect(await checkVerifyRate(c, { ip: "203.0.113.7", maxPerHour: 10, now })).toEqual({ limited: false });
    expect(c.calls.map((x) => [x.table, x.method])).toEqual([
      ["verify_scans", "select"], ["verify_scans", "eq"], ["verify_scans", "gte"],
    ]);
    expect(c.calls[0].args).toEqual(["id", { count: "exact", head: true }]);
    expect(c.calls[1].args).toEqual(["ip", "203.0.113.7"]);
    expect(c.calls[2].args).toEqual(["created_at", "2026-10-01T11:00:00.000Z"]);
  });
  it("at the cap → limited with the retry hint and a fail-safe message", async () => {
    const v = await checkVerifyRate(client({ count: 10 }), { ip: "203.0.113.7", maxPerHour: 10 });
    expect(v.limited).toBe(true);
    if (v.limited) {
      expect(v.retryAfterSec).toBe(VERIFY_RETRY_AFTER_SEC);
      expect(v.message).toMatch(/treat the paper as unverified/);
    }
  });
  it("an unknown IP is never limited (one shared bucket would lock everyone out) — and costs no read", async () => {
    const c = client({ count: 99999 });
    expect(await checkVerifyRate(c, { ip: "unknown", maxPerHour: 1 })).toEqual({ limited: false });
    expect(await checkVerifyRate(c, { ip: "", maxPerHour: 1 })).toEqual({ limited: false });
    expect(c.calls).toEqual([]);
  });
  it("a read error (the table not yet created) or a throw FAILS OPEN", async () => {
    expect(await checkVerifyRate(client({ count: 99999, error: { code: "42P01", message: "relation \"verify_scans\" does not exist" } }), { ip: "1.2.3.4", maxPerHour: 1 })).toEqual({ limited: false });
    expect(await checkVerifyRate(client({ throws: true }), { ip: "1.2.3.4", maxPerHour: 1 })).toEqual({ limited: false });
  });
  it("clientIp takes the first x-forwarded-for hop, else x-real-ip, else 'unknown' (the house helper)", () => {
    expect(clientIp({ headers: new Headers({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" }) })).toBe("203.0.113.7");
    expect(clientIp({ headers: new Headers({ "x-real-ip": "198.51.100.2" }) })).toBe("198.51.100.2");
    expect(clientIp({ headers: new Headers() })).toBe("unknown");
  });
});

describe("verifyJson / verifyRateLimitedResponse — every answer is no-store (VFY-13, OFF-1 dw3)", () => {
  it("a verdict, an error and a 429 all carry Cache-Control: no-store", async () => {
    const ok = verifyJson({ verdict: "current" });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("no-store");
    expect(await ok.json()).toEqual({ verdict: "current" });
    const err = verifyJson({ error: "Invalid code" }, 400);
    expect(err.status).toBe(400);
    expect(err.headers.get("cache-control")).toBe("no-store");
    const limited = verifyRateLimitedResponse({ limited: true, retryAfterSec: 300, message: "slow down" });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("cache-control")).toBe("no-store");
    expect(limited.headers.get("retry-after")).toBe("300");
  });
});

describe("recordVerifyScan — checked, bounded, never blocks the scan", () => {
  it("the row: endpoint, UUID-or-null target, bounded verdict / ip / user agent, no person", () => {
    const row = verifyScanRow({ endpoint: "verify", targetId: "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA", verdict: "current", ip: "203.0.113.7", userAgent: "x".repeat(900) });
    expect(row).toEqual({ endpoint: "verify", target_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", verdict: "current", ip: "203.0.113.7", user_agent: "x".repeat(400) });
    expect(verifyScanRow({ endpoint: "verify-hold", targetId: "not-a-uuid", verdict: "invalid", ip: "", userAgent: null }))
      .toEqual({ endpoint: "verify-hold", target_id: null, verdict: "invalid", ip: "unknown", user_agent: null });
    expect(Object.keys(row).sort()).toEqual(["endpoint", "ip", "target_id", "user_agent", "verdict"]);
  });
  it("inserts into verify_scans and reports success", async () => {
    const c = client({});
    expect(await recordVerifyScan(c, { endpoint: "verify-package", targetId: null, verdict: "empty", ip: "1.2.3.4", userAgent: null })).toBe(true);
    expect(c.calls.map((x) => [x.table, x.method])).toEqual([["verify_scans", "insert"]]);
  });
  it("the missing table (20261134 unapplied) is logged ONCE per runtime as the deploy order; the scan still answers", async () => {
    const missing = { code: "42P01", message: 'relation "verify_scans" does not exist' };
    expect(await recordVerifyScan(client({ error: missing }), { endpoint: "verify", targetId: null, verdict: "current", ip: "1.2.3.4", userAgent: null })).toBe(false);
    expect(await recordVerifyScan(client({ error: missing }), { endpoint: "verify", targetId: null, verdict: "current", ip: "1.2.3.4", userAgent: null })).toBe(false);
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(String(errSpy.mock.calls[0][0])).toMatch(/DEPLOY ORDER: verify_scans does not exist — migration 20261134/);
  });
  it("any other refusal is logged every time; a throw is caught — never rethrown", async () => {
    await recordVerifyScan(client({ error: { code: "23514", message: "check constraint" } }), { endpoint: "verify", targetId: null, verdict: "x", ip: "1", userAgent: null });
    await recordVerifyScan(client({ error: { code: "23514", message: "check constraint" } }), { endpoint: "verify", targetId: null, verdict: "x", ip: "1", userAgent: null });
    expect(errSpy).toHaveBeenCalledTimes(2);
    await expect(recordVerifyScan(client({ throws: true }), { endpoint: "verify", targetId: null, verdict: "x", ip: "1", userAgent: null })).resolves.toBe(false);
  });
  it("isMissingScanTable recognises the Postgres and PostgREST spellings only", () => {
    expect(isMissingScanTable({ code: "42P01" })).toBe(true);
    expect(isMissingScanTable({ code: "PGRST205", message: "Could not find the table 'public.verify_scans' in the schema cache" })).toBe(true);
    expect(isMissingScanTable({ message: 'relation "verify_scans" does not exist' })).toBe(true);
    expect(isMissingScanTable({ code: "23514", message: "check constraint" })).toBe(false);
    expect(isMissingScanTable(null)).toBe(false);
  });
  it("retention is 90 days (the user-informed default)", () => {
    expect(VERIFY_SCAN_RETENTION_DAYS).toBe(90);
  });
});
