// intelligence Round G — I-05 (GOV-4 / GOV-10): the storage purge never
// reaches the current month of the AI spend ledger.
//
// ai_usage_events is the ledger every monthly AI cap is enforced from
// (getMonthUsage reads the current UTC month). /api/admin/purge listed it as
// "pure telemetry" with a 7-day floor, so an Admin or Doc Controller at their
// cap could delete the month's rows older than a week, lower the month's
// recorded spend — everyone's in the org — and be admitted again, with no
// second signature. The ledger's cutoff is now clamped to the first instant
// of the UTC month; the other targets keep the window they were given.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

type Call = { table: string; op: "count" | "delete" | "insert"; lt?: string; payload?: unknown };
const db = vi.hoisted(() => ({ calls: [] as Call[] }));

function client() {
  return {
    rpc: async () => ({ data: [], error: null }),
    from(table: string) {
      const call: Call = { table, op: "count" };
      const chain: Record<string, unknown> = {
        select: () => chain,
        delete: () => { call.op = "delete"; return chain; },
        insert: (payload: unknown) => { call.op = "insert"; call.payload = payload; db.calls.push(call); return Promise.resolve({ error: null }); },
        eq: () => chain,
        lt: (_col: string, v: string) => { call.lt = v; return chain; },
        not: () => chain,
        is: () => chain,
        in: () => chain,
        then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => {
          db.calls.push(call);
          return Promise.resolve(call.op === "count" ? { count: 4, error: null } : { error: null }).then(res, rej);
        },
      };
      return chain;
    },
  };
}

vi.mock("@/lib/serverAuth", () => ({
  authorizeOrgRole: vi.fn(async () => ({ userId: "dc1", email: "dc1@x.io", orgId: "o1", role: "DocCtrl", roles: ["DocCtrl"], admin: client() })),
}));
// usageServer (monthStartIso) imports the service-role client at module load.
vi.mock("@/lib/supabaseAdmin", () => ({ supabaseAdmin: {} }));

import { GET, POST } from "@/app/api/admin/purge/route";

const NOW = new Date("2026-10-20T12:00:00.000Z");
const MONTH_START = "2026-10-01T00:00:00.000Z";

beforeEach(() => {
  db.calls = [];
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => { vi.useRealTimers(); });

const purge = (days: number) => POST(new NextRequest("http://x/api/admin/purge", {
  method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" },
  body: JSON.stringify({ orgId: "o1", days, confirm: true }),
}));
const cutoffOf = (table: string, op: Call["op"]) => db.calls.filter((c) => c.table === table && c.op === op).map((c) => c.lt);

describe("GOV-4 / GOV-10 — the purge never reaches this month's AI spend ledger", () => {
  it("days=7 on Oct 20: notifications purge to Oct 13, the ledger only to Oct 1 — its count AND its delete", async () => {
    const res = await purge(7);
    expect(res.status).toBe(200);
    const sevenDaysAgo = "2026-10-13T12:00:00.000Z";
    expect(cutoffOf("notifications", "delete")).toEqual([sevenDaysAgo]);
    // notifications N6 (DELIV-8): delivered and abandoned email are two lines of one table
    expect(cutoffOf("email_notifications", "delete")).toEqual([sevenDaysAgo, sevenDaysAgo]);
    expect(cutoffOf("ai_usage_events", "count")).toEqual([MONTH_START]);
    expect(cutoffOf("ai_usage_events", "delete")).toEqual([MONTH_START]);
    // the DATA_PURGE audit row names the cutoff each table was purged to
    // (the abandoned-email line writes its own record first — notifications N6)
    const audit = db.calls.find((c) => c.table === "audit_logs" && c.op === "insert" && (c.payload as { action?: string }).action === "DATA_PURGE")!.payload as { details: { deleted: Array<{ table: string; cutoffIso: string }> } };
    expect(audit.details.deleted.find((d) => d.table === "ai_usage_events")?.cutoffIso).toBe(MONTH_START);
    expect(audit.details.deleted.find((d) => d.table === "notifications")?.cutoffIso).toBe(sevenDaysAgo);
  });

  it("a window that already ends before the month (days=90) is kept as asked: past months stay purge-eligible", async () => {
    await purge(90);
    const ninetyDaysAgo = new Date(NOW.getTime() - 90 * 86400 * 1000).toISOString();
    expect(ninetyDaysAgo < MONTH_START).toBe(true);
    expect(cutoffOf("ai_usage_events", "delete")).toEqual([ninetyDaysAgo]);
  });

  it("the preview counts the ledger to the month start, says so per target, and is labelled the spend ledger", async () => {
    const res = await GET(new NextRequest("http://x/api/admin/purge?orgId=o1&days=7", { headers: { authorization: "Bearer t" } }));
    const json = await res.json() as { cutoffIso: string; targets: Array<{ table: string; label: string; reason: string; cutoffIso: string }> };
    expect(json.cutoffIso).toBe("2026-10-13T12:00:00.000Z");
    const ledger = json.targets.find((t) => t.table === "ai_usage_events")!;
    expect(ledger.cutoffIso).toBe(MONTH_START);
    expect(ledger.label).toBe("AI spend ledger (past months)");
    expect(ledger.reason).toMatch(/Only rows from before this month are ever eligible/);
    expect(ledger.reason).not.toMatch(/pure telemetry/);
    expect(json.targets.find((t) => t.table === "notifications")!.cutoffIso).toBe("2026-10-13T12:00:00.000Z");
    expect(cutoffOf("ai_usage_events", "count")).toEqual([MONTH_START]);
    expect(db.calls.some((c) => c.op === "delete")).toBe(false);
  });
});
