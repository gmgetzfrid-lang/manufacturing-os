// projects-tab MON-6 / PERF-3 · projects-and-cost PM-3 — the health
// snapshot counts imported schedules, computes a real SPI, names a read it
// could not make, and gathers once per project.
//
// Before: projectSnapshot.ts:49 filtered milestones to
// `source == null || "manual" || "app"` (a NOT NULL column with a CHECK
// over manual/p6/msproject/csv/mpxj), so a project scheduled entirely from
// a P6 import scored "No schedule yet"; `spi: null` was hard-coded; a
// failed read was indistinguishable from an empty table; and every
// Costs/Quality mount re-ran all thirteen queries.

import { describe, it, expect, vi, beforeEach } from "vitest";

const state = vi.hoisted(() => ({
  tables: {} as Record<string, Array<Record<string, unknown>>>,
  errors: {} as Record<string, string>,
  /** PostgREST error code for a table's error; `errorOnce` answers it on the
   *  first query only (a pre-migration column list, then the legacy one). */
  errorCodes: {} as Record<string, string>,
  errorOnce: {} as Record<string, boolean>,
  fromCalls: [] as string[],
  selects: [] as string[],
  delayMs: 0,
}));

vi.mock("@/lib/supabase", () => {
  function chain(table: string) {
    const c: Record<string, unknown> = {};
    const settle = () => new Promise<{ data: unknown; error: unknown }>((resolve) => {
      const msg = state.errors[table];
      if (msg && state.errorOnce[table]) { delete state.errors[table]; delete state.errorOnce[table]; }
      const out = msg
        ? { data: null, error: { message: msg, code: state.errorCodes[table] ?? null } }
        : { data: state.tables[table] ?? [], error: null };
      if (state.delayMs > 0) setTimeout(() => resolve(out), state.delayMs); else resolve(out);
    });
    const handler: ProxyHandler<Record<string, unknown>> = {
      get(_t, prop: string) {
        if (prop === "then") {
          return (resolve: (v: unknown) => void, reject?: (e: unknown) => void) => settle().then(resolve, reject);
        }
        return (...args: unknown[]) => {
          if (prop === "select") state.selects.push(`${table}:${String(args[0])}`);
          if (prop === "maybeSingle") {
            return settle().then((r) => ({ data: Array.isArray(r.data) ? (r.data[0] ?? null) : null, error: r.error }));
          }
          return new Proxy(c, handler);
        };
      },
    };
    return new Proxy(c, handler);
  }
  return { supabase: { from: (t: string) => { state.fromCalls.push(t); return chain(t); } } };
});

import {
  gatherProjectSnapshot, gatherProjectSnapshotUncached, resetProjectSnapshotMemo,
  invalidateProjectSnapshot, refreshNeedsFreshSnapshot,
} from "@/lib/projectSnapshot";
import { computeProjectHealth, buildCoachItems } from "@/lib/projectHealth";
import { isOverdueMilestone, isImportedMilestone, isLiveMilestone, liveMilestones } from "@/lib/milestoneLiveness";

const DAY = 86_400_000;
const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY).toISOString();

beforeEach(() => {
  state.tables = {};
  state.errors = {};
  state.errorCodes = {};
  state.errorOnce = {};
  state.fromCalls = [];
  state.selects = [];
  state.delayMs = 0;
  resetProjectSnapshotMemo();
});

describe("milestoneLiveness — the one rule", () => {
  it("every stored source counts; imported rows are commitments, not reference data", () => {
    for (const source of ["manual", "p6", "msproject", "csv", "mpxj"]) {
      expect(isLiveMilestone({ source })).toBe(true);
    }
    expect(liveMilestones([{ source: "p6" }, { source: "manual" }])).toHaveLength(2);
    expect(isImportedMilestone({ source: "p6" })).toBe(true);
    expect(isImportedMilestone({ source: "manual" })).toBe(false);
  });

  it("overdue is by UTC day: due today is not overdue anywhere (SCH-5's measured case)", () => {
    // now = 2026-08-21T16:00Z (9am Pacific), task due 2026-08-21T00:00Z.
    const now = Date.parse("2026-08-21T16:00:00Z");
    expect(isOverdueMilestone({ planned_at: "2026-08-21T00:00:00Z", status: "planned" }, now)).toBe(false);
    expect(isOverdueMilestone({ planned_at: "2026-08-20T00:00:00Z", status: "planned" }, now)).toBe(true);
    expect(isOverdueMilestone({ planned_at: "2026-08-20T00:00:00Z", status: "completed" }, now)).toBe(false);
    expect(isOverdueMilestone({ planned_at: null, status: "planned" }, now)).toBe(false);
    // 23:59Z on the due day is still the due day.
    expect(isOverdueMilestone({ planned_at: "2026-08-21T00:00:00Z", status: "planned" }, Date.parse("2026-08-21T23:59:00Z"))).toBe(false);
    expect(isOverdueMilestone({ planned_at: "2026-08-21T00:00:00Z", status: "planned" }, Date.parse("2026-08-22T00:00:00Z"))).toBe(true);
  });
});

describe("gatherProjectSnapshot — imported schedules count (MON-6 / PM-3)", () => {
  it("a project whose only milestones are source='p6' has a real count, overdue and SPI", async () => {
    state.tables.milestones = [
      { id: "m1", parent_id: null, status: "planned", planned_at: iso(-3), percent_complete: 0, weight: 1, duration_hours: null, created_at: iso(-30), baseline_finish_at: null, source: "p6" },
      { id: "m2", parent_id: null, status: "completed", planned_at: iso(-10), percent_complete: 100, weight: 1, duration_hours: null, created_at: iso(-30), baseline_finish_at: iso(-10), source: "p6" },
      { id: "m3", parent_id: null, status: "planned", planned_at: iso(+20), percent_complete: 0, weight: 1, duration_hours: null, created_at: iso(-30), baseline_finish_at: null, source: "mpxj" },
    ];
    const snap = await gatherProjectSnapshot("org1", "p1");
    expect(snap.milestoneCount).toBe(3);
    expect(snap.overdueMilestones).toBe(1);
    expect(snap.hasBaseline).toBe(true);
    // Two tasks were due (m1, m2); one is earned → SPI 0.5 from the
    // schedule engine's own EV math.
    expect(snap.spi).toBeCloseTo(0.5, 5);
    expect(snap.readFailures).toEqual([]);

    // The consumers stop lying: no "No schedule yet", no "Add a schedule" nag.
    const health = computeProjectHealth(snap);
    const sched = health.parts.find((p) => p.label === "Schedule")!;
    expect(sched.score).not.toBeNull();
    expect(sched.detail).toContain("SPI 0.50");
    expect(buildCoachItems(snap, "p1").some((i) => i.id === "schedule")).toBe(false);
  });

  it("SPI stays null (not a fabricated 1.00) while nothing is due yet", async () => {
    state.tables.milestones = [
      { id: "m1", parent_id: null, status: "planned", planned_at: iso(+5), percent_complete: 0, weight: 1, source: "csv" },
    ];
    const snap = await gatherProjectSnapshot("org1", "p1");
    expect(snap.milestoneCount).toBe(1);
    expect(snap.spi).toBeNull();
  });

  it("the EV index is keyed by the real milestone id, so a pinned account yields CPI", async () => {
    state.tables.milestones = [
      { id: "m1", parent_id: null, status: "in_progress", planned_at: iso(+5), percent_complete: 50, weight: 1, source: "p6" },
    ];
    state.tables.cost_accounts = [{ id: "a1", project_id: "p1", name: "Piping", budget: 100, currency: "USD", wbs_milestone_id: "m1" }];
    state.tables.cost_entries = [{ id: "e1", cost_account_id: "a1", project_id: "p1", entry_type: "actual", amount: 40, status: "posted" }];
    const snap = await gatherProjectSnapshot("org1", "p1");
    expect(snap.cpi).toBeCloseTo(1.25, 5);
    expect(snap.committed).toBe(0);
  });
});

describe("gatherProjectSnapshot — an honest gap, not a silent zero", () => {
  it("names the table it could not read instead of presenting zeros as the truth", async () => {
    state.errors.milestones = "permission denied for table milestones";
    state.errors.turnover_items = "relation does not exist";
    const snap = await gatherProjectSnapshot("org1", "p1");
    expect(snap.milestoneCount).toBe(0);
    expect(snap.readFailures).toEqual(expect.arrayContaining(["milestones", "turnover items"]));
    expect(snap.readFailures).not.toContain("punch items");
  });

  it("a refused projects read (not a missing column) is still a named read failure", async () => {
    state.errors.projects = "permission denied for table projects";
    state.errorCodes.projects = "42501";
    const snap = await gatherProjectSnapshot("org1", "p1");
    expect(snap.readFailures).toContain("project");
    expect(snap.notMigrated).toEqual([]);
  });

  it("selects only the columns it reads — never select('*') on projects or cost_documents", async () => {
    // The mock ignores selects; this pins the source so a future edit
    // that widens the query again is visible.
    const fs = await import("node:fs");
    const src = fs.readFileSync(new URL("../projectSnapshot.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/from\("projects"\)\s*\.select\("\*"\)/);
    expect(src).not.toMatch(/from\("cost_documents"\)\s*\.select\("\*"\)/);
  });
});

describe("gatherProjectSnapshot — a database migration 20261013 has not reached", () => {
  it("re-reads projects with the pre-migration column list and names the gap as 'not migrated', not as a failed read", async () => {
    state.tables.projects = [{ purpose: "Replace the exchanger", goals: ["No leaks"] }];
    state.errors.projects = "column projects.job_kind does not exist";
    state.errorCodes.projects = "42703";
    state.errorOnce.projects = true;
    const snap = await gatherProjectSnapshot("org1", "p1");
    expect(snap.readFailures).toEqual([]);
    expect(snap.notMigrated).toEqual(["job size and Summary of Work"]);
    // The legacy read carried only the columns that exist there.
    const projectSelects = state.selects.filter((x) => x.startsWith("projects:"));
    expect(projectSelects).toEqual(["projects:purpose, goals, sow_document_id, job_kind", "projects:purpose, goals"]);
    // …and what it returned is used: purpose and goals are known.
    expect(snap.hasPurpose).toBe(true);
    expect(snap.hasGoals).toBe(true);
    expect(snap.jobKind).toBeNull();
    expect(snap.hasSow).toBe(false);
  });

  it("re-reads cost_documents without rfq_group (PGRST204) so quotes still count", async () => {
    state.tables.cost_documents = [
      { kind: "quote", status: "parsed", vendor_name: "Acme", file_name: "q1.pdf" },
      { kind: "quote", status: "parsed", vendor_name: "Bolt Co", file_name: "q2.pdf" },
    ];
    state.errors.cost_documents = "Could not find the 'rfq_group' column of 'cost_documents' in the schema cache";
    state.errorCodes.cost_documents = "PGRST204";
    state.errorOnce.cost_documents = true;
    const snap = await gatherProjectSnapshot("org1", "p1");
    expect(snap.readFailures).toEqual([]);
    expect(snap.notMigrated).toEqual(["RFQ groups"]);
    expect(snap.quoteCount).toBe(2);
    expect(state.selects.filter((x) => x.startsWith("cost_documents:"))).toEqual([
      "cost_documents:kind, status, rfq_group, vendor_name, file_name",
      "cost_documents:kind, status, vendor_name, file_name",
    ]);
  });

  it("a legacy read that ALSO fails is a read failure", async () => {
    state.errors.projects = "permission denied for table projects";
    state.errorCodes.projects = "42703";
    // errorOnce unset: both reads fail.
    const snap = await gatherProjectSnapshot("org1", "p1");
    expect(snap.readFailures).toContain("project");
  });
});

describe("gatherProjectSnapshot — gather once per project (PERF-3)", () => {
  const countMilestoneReads = () => state.fromCalls.filter((t) => t === "milestones").length;

  it("two concurrent requests for the same project share one round of queries", async () => {
    state.delayMs = 5;
    const [a, b] = await Promise.all([gatherProjectSnapshot("org1", "p1"), gatherProjectSnapshot("org1", "p1")]);
    expect(a).toBe(b);
    expect(countMilestoneReads()).toBe(1);
    // A request landing right after settle (a tab mounting under the coach)
    // is served from that round too.
    await gatherProjectSnapshot("org1", "p1");
    expect(countMilestoneReads()).toBe(1);
    // A different project is its own round; `fresh` bypasses the memo.
    await gatherProjectSnapshot("org1", "p2");
    expect(countMilestoneReads()).toBe(2);
    await gatherProjectSnapshot("org1", "p1", { fresh: true });
    expect(countMilestoneReads()).toBe(3);
  });

  it("aborting the last interested caller cancels the round; the next call starts fresh", async () => {
    state.delayMs = 20;
    const ac = new AbortController();
    const p = gatherProjectSnapshot("org1", "p1", { signal: ac.signal });
    p.catch(() => undefined);
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    expect(countMilestoneReads()).toBe(1);
    state.delayMs = 0;
    await gatherProjectSnapshot("org1", "p1");
    expect(countMilestoneReads()).toBe(2);
  });

  it("a caller that arrives already aborted is refused without a query", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(gatherProjectSnapshot("org1", "p1", { signal: ac.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(countMilestoneReads()).toBe(0);
  });

  it("one waiter aborting does not cancel a round another caller still wants", async () => {
    state.delayMs = 10;
    const ac = new AbortController();
    const keep = gatherProjectSnapshot("org1", "p1");
    const drop = gatherProjectSnapshot("org1", "p1", { signal: ac.signal });
    drop.catch(() => undefined);
    ac.abort();
    const snap = await keep;
    expect(snap.milestoneCount).toBe(0);
    expect(countMilestoneReads()).toBe(1);
  });

  it("the uncached gather is still available for a caller that must see its own write", async () => {
    await gatherProjectSnapshotUncached("org1", "p1");
    await gatherProjectSnapshotUncached("org1", "p1");
    expect(countMilestoneReads()).toBe(2);
  });
});

describe("gatherProjectSnapshot — never served from before a write", () => {
  it("invalidateProjectSnapshot: a request after a write is not answered from the round before it", async () => {
    state.tables.punch_items = [{ status: "open" }];
    const before = await gatherProjectSnapshot("org1", "p1");
    expect(before.punchOpen).toBe(1);
    // The write: the last punch item closes; the surface that wrote calls
    // invalidate, and the next request (inside SNAPSHOT_REUSE_MS) re-gathers.
    state.tables.punch_items = [{ status: "closed" }];
    invalidateProjectSnapshot("org1", "p1");
    const after = await gatherProjectSnapshot("org1", "p1");
    expect(after.punchOpen).toBe(0);
    expect(state.fromCalls.filter((t) => t === "punch_items")).toHaveLength(2);
    // Another project's round is untouched.
    await gatherProjectSnapshot("org1", "p2");
    invalidateProjectSnapshot("org1", "p1");
    await gatherProjectSnapshot("org1", "p2");
    expect(state.fromCalls.filter((t) => t === "punch_items")).toHaveLength(3);
  });

  it("invalidating while a round is in flight lets its waiters finish but offers it to nobody else", async () => {
    state.delayMs = 10;
    const waiting = gatherProjectSnapshot("org1", "p1");
    invalidateProjectSnapshot("org1", "p1");
    const next = gatherProjectSnapshot("org1", "p1");
    expect(await waiting).toBeTruthy();
    expect(await next).toBeTruthy();
    expect(state.fromCalls.filter((t) => t === "punch_items")).toHaveLength(2);
  });

  it("fresh: true after a mutation is served from a new round even inside the reuse window", async () => {
    state.tables.punch_items = [{ status: "open" }];
    await gatherProjectSnapshot("org1", "p1");
    state.tables.punch_items = [];
    const stale = await gatherProjectSnapshot("org1", "p1");
    expect(stale.punchOpen).toBe(1); // the window, by design — hence `fresh` below
    const fresh = await gatherProjectSnapshot("org1", "p1", { fresh: true });
    expect(fresh.punchOpen).toBe(0);
  });

  it("the coach's re-key rule: mount and the first re-key share, every later re-key gathers fresh", () => {
    // Mount: key unchanged.
    expect(refreshNeedsFreshSnapshot(0, 0, 0)).toBe(false);
    // First change (the page's own initial refresh, or a tab mounting): share.
    expect(refreshNeedsFreshSnapshot(0, 0, 1)).toBe(false);
    // Second and later changes follow a write somewhere on the page: fresh.
    expect(refreshNeedsFreshSnapshot(0, 1, 2)).toBe(true);
    expect(refreshNeedsFreshSnapshot(0, 2, 3)).toBe(true);
    // A re-run with the same key (orgId/projectId changed) is not a re-key.
    expect(refreshNeedsFreshSnapshot(0, 2, 2)).toBe(false);
    // A consumer mounted with no key at all never re-keys.
    expect(refreshNeedsFreshSnapshot(undefined, undefined, undefined)).toBe(false);
  });
});
