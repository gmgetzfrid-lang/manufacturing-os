// projects-tab MON-6 / PERF-3 · projects-and-cost PM-3 — the health
// snapshot counts imported schedules, computes a real SPI, names a read it
// could not make (and the engine leaves out what depends on it), and
// shares a round only where a caller opts in.
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
  /** Chain calls other than select, as `table.method(args)`. */
  calls: [] as string[],
  /** Columns the database does not have yet: a select naming one is
   *  answered 42703, exactly as Postgres answers it. */
  missingColumns: [] as string[],
  delayMs: 0,
}));

vi.mock("@/lib/supabase", () => {
  function chain(table: string) {
    const c: Record<string, unknown> = {};
    let selected = "";
    const settle = () => new Promise<{ data: unknown; error: unknown }>((resolve) => {
      const missing = state.missingColumns.find((col) => selected.split(",").map((x) => x.trim()).includes(col));
      const msg = missing ? `column ${table}.${missing} does not exist` : state.errors[table];
      if (!missing && msg && state.errorOnce[table]) { delete state.errors[table]; delete state.errorOnce[table]; }
      const out = msg
        ? { data: null, error: { message: msg, code: missing ? "42703" : (state.errorCodes[table] ?? null) } }
        : { data: state.tables[table] ?? [], error: null };
      if (state.delayMs > 0) setTimeout(() => resolve(out), state.delayMs); else resolve(out);
    });
    const handler: ProxyHandler<Record<string, unknown>> = {
      get(_t, prop: string) {
        if (prop === "then") {
          return (resolve: (v: unknown) => void, reject?: (e: unknown) => void) => settle().then(resolve, reject);
        }
        return (...args: unknown[]) => {
          if (prop === "select") { selected = String(args[0]); state.selects.push(`${table}:${selected}`); }
          else if (prop !== "abortSignal" && prop !== "maybeSingle") state.calls.push(`${table}.${prop}(${args.map((a) => JSON.stringify(a)).join(",")})`);
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
  invalidateProjectSnapshot, snapshotRekeyMayShare,
} from "@/lib/projectSnapshot";
import { computeProjectHealth, buildCoachItems, PROJECT_FIELDS_NOT_MIGRATED } from "@/lib/projectHealth";
import {
  isOverdueMilestone, isImportedMilestone, isLiveMilestone, liveMilestones, PROJECT_MILESTONE_READ_LIMIT,
} from "@/lib/milestoneLiveness";

const DAY = 86_400_000;
const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY).toISOString();

beforeEach(() => {
  state.tables = {};
  state.errors = {};
  state.errorCodes = {};
  state.errorOnce = {};
  state.fromCalls = [];
  state.selects = [];
  state.calls = [];
  state.missingColumns = [];
  state.delayMs = 0;
  resetProjectSnapshotMemo();
});

/** Let a deferred (macrotask) abort run. */
const nextMacrotask = () => new Promise((r) => setTimeout(r, 0));

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

  it("reads milestones ordered by planned date and bounded like the report, so both see the same rows", async () => {
    await gatherProjectSnapshot("org1", "p1");
    const ms = state.calls.filter((c) => c.startsWith("milestones."));
    expect(ms).toContain('milestones.order("planned_at")');
    expect(ms).toContain(`milestones.limit(${PROJECT_MILESTONE_READ_LIMIT})`);
    expect(ms.indexOf('milestones.order("planned_at")')).toBeLessThan(ms.indexOf(`milestones.limit(${PROJECT_MILESTONE_READ_LIMIT})`));
  });
});

describe("gatherProjectSnapshot — an honest gap, not a silent zero", () => {
  it("names the table it could not read instead of presenting zeros as the truth", async () => {
    state.errors.milestones = "permission denied for table milestones";
    state.errors.turnover_items = "relation does not exist";
    const snap = await gatherProjectSnapshot("org1", "p1");
    expect(snap.milestoneCount).toBe(0);
    expect(snap.readFailures).toEqual(expect.arrayContaining(["schedule tasks", "turnover items"]));
    expect(snap.readFailures).not.toContain("punch items");
  });

  it("a refused projects read (not a missing column) is still a named read failure", async () => {
    state.errors.projects = "permission denied for table projects";
    state.errorCodes.projects = "42501";
    const snap = await gatherProjectSnapshot("org1", "p1");
    expect(snap.readFailures).toContain("project");
    expect(snap.notMigrated).toEqual([]);
    // Nothing about purpose / SOW is known, so nothing is suggested about it.
    const ids = buildCoachItems(snap, "p1").map((i) => i.id);
    expect(ids).not.toContain("sow");
    expect(ids).not.toContain("purpose");
  });

  it("a refused checklist_items read scores Quality unknown — never 'Checklists clear' at 100", async () => {
    state.tables.project_checklists = [{ id: "c1", status: "open" }, { id: "c2", status: "open" }];
    state.errors.checklist_items = "canceling statement due to statement timeout";
    state.errorCodes.checklist_items = "57014";
    const snap = await gatherProjectSnapshot("org1", "p1");
    expect(snap.readFailures).toEqual(["checklist items"]);
    expect(snap.checklistOpenItems).toBe(0); // the zero that stands in for "unknown"…
    const quality = computeProjectHealth(snap).parts.find((p) => p.label === "Quality")!;
    expect(quality.score).toBeNull(); // …is not scored
    expect(quality.detail).toBe("Could not read checklist items");
    expect(quality.detail).not.toContain("Checklists clear");
  });

  it("a refused read drops the part and every suggestion its zero would raise", async () => {
    state.errors.milestones = "permission denied for table milestones";
    state.errorCodes.milestones = "42501";
    state.errors.project_members = "permission denied for table project_members";
    state.tables.cost_accounts = [{ id: "a1", project_id: "p1", name: "Piping", budget: 100, currency: "USD", wbs_milestone_id: "m1" }];
    const snap = await gatherProjectSnapshot("org1", "p1");
    const health = computeProjectHealth(snap);
    expect(health.parts.find((p) => p.label === "Schedule")).toEqual({ label: "Schedule", score: null, detail: "Could not read schedule tasks" });
    // A pinned account's earned value comes from the milestones it could not read.
    expect(health.parts.find((p) => p.label === "Cost")!.score).toBeNull();
    const ids = buildCoachItems(snap, "p1").map((i) => i.id);
    expect(ids).not.toContain("schedule"); // no "Add a schedule" nag for a schedule it could not read
    expect(ids).not.toContain("members");
    expect(ids).not.toContain("budget"); // the budget read DID land: 100 > 0
  });

  it("refused cost accounts: named in readFailures, no 'Add a budget' at the top, Cost and Change control unknown", async () => {
    // lib/costs.ts listAccounts / listEntries THROW on a refused read
    // (projects-tab REL-2, since J3), and the gather names the read — the
    // failure is injected at the table, not into the snapshot.
    state.errors.cost_accounts = "permission denied for table cost_accounts";
    state.errorCodes.cost_accounts = "42501";
    const snap = await gatherProjectSnapshot("org1", "p1");
    expect(snap.readFailures).toEqual(["cost accounts"]);
    expect(snap.notMigrated).toEqual([]);
    const ids = buildCoachItems(snap, "p1").map((i) => i.id);
    expect(ids).not.toContain("budget");
    const parts = computeProjectHealth(snap).parts;
    expect(parts.find((p) => p.label === "Cost")).toEqual({ label: "Cost", score: null, detail: "Could not read cost accounts" });
    expect(parts.find((p) => p.label === "Change control")!.detail).toBe("Could not read cost accounts");
  });

  it("refused cost entries are named too", async () => {
    state.errors.cost_entries = "permission denied for table cost_entries";
    const snap = await gatherProjectSnapshot("org1", "p1");
    expect(snap.readFailures).toEqual(["cost entries"]);
    expect(computeProjectHealth(snap).parts.find((p) => p.label === "Cost")!.detail).toBe("Could not read cost entries");
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
  it("purpose, goals, job_kind and sow_document_id all arrive with 20261013: named as not migrated, never as a failed read", async () => {
    // A real pre-20261013 database: any select naming one of them is 42703.
    state.missingColumns = ["purpose", "goals", "job_kind", "sow_document_id", "rfq_group"];
    state.tables.projects = [{ id: "p1" }];
    const snap = await gatherProjectSnapshot("org1", "p1");
    expect(snap.readFailures).toEqual([]);
    expect(snap.notMigrated).toContain(PROJECT_FIELDS_NOT_MIGRATED);
    // No legacy re-read of columns that cannot exist.
    expect(state.selects.filter((x) => x.startsWith("projects:"))).toEqual(["projects:purpose, goals, sow_document_id, job_kind"]);
    // The coach does not send anyone to an editor whose fields cannot be read.
    const ids = buildCoachItems(snap, "p1").map((i) => i.id);
    expect(ids).not.toContain("sow");
    expect(ids).not.toContain("purpose");
  });

  it("re-reads cost_documents without rfq_group (a 42703 on a pre-migration database) so quotes still count", async () => {
    state.missingColumns = ["rfq_group"];
    state.tables.cost_documents = [
      { kind: "quote", status: "parsed", vendor_name: "Acme", file_name: "q1.pdf" },
      { kind: "quote", status: "parsed", vendor_name: "Bolt Co", file_name: "q2.pdf" },
    ];
    const snap = await gatherProjectSnapshot("org1", "p1");
    expect(snap.readFailures).toEqual([]);
    expect(snap.notMigrated).toEqual(["RFQ groups"]);
    expect(snap.quoteCount).toBe(2);
    expect(state.selects.filter((x) => x.startsWith("cost_documents:"))).toEqual([
      "cost_documents:kind, status, rfq_group, vendor_name, file_name",
      "cost_documents:kind, status, vendor_name, file_name",
    ]);
  });

  it("a table 20261013 creates answering 42P01 is 'not migrated', not an amber read failure — and its suggestions are left out", async () => {
    for (const t of ["change_orders", "project_checklists", "turnover_items", "punch_items"]) {
      state.errors[t] = `relation "public.${t}" does not exist`;
      state.errorCodes[t] = "42P01";
    }
    state.tables.cost_accounts = [{ id: "a1", project_id: "p1", name: "Piping", budget: 100, currency: "USD", wbs_milestone_id: null }];
    const snap = await gatherProjectSnapshot("org1", "p1");
    expect(snap.readFailures).toEqual([]);
    expect(snap.notMigrated).toEqual(expect.arrayContaining(["change orders", "checklists", "turnover items", "punch items"]));
    expect(buildCoachItems(snap, "p1").map((i) => i.id)).not.toContain("checklist");
    const parts = computeProjectHealth(snap).parts;
    expect(parts.find((p) => p.label === "Change control")!.score).toBeNull(); // no vacuous "No change orders" credit
    expect(parts.find((p) => p.label === "Quality")!.detail).toMatch(/^Needs migration 20261013/);
  });

  it("a missing table on a table that predates 20261013 is still a read failure", async () => {
    state.errors.project_members = 'relation "public.project_members" does not exist';
    state.errorCodes.project_members = "42P01";
    const snap = await gatherProjectSnapshot("org1", "p1");
    expect(snap.readFailures).toContain("members");
  });

  it("a legacy read that ALSO fails is a read failure", async () => {
    state.missingColumns = ["rfq_group"];
    state.errors.cost_documents = "permission denied for table cost_documents";
    state.errorCodes.cost_documents = "42501";
    const snap = await gatherProjectSnapshot("org1", "p1");
    expect(snap.readFailures).toContain("cost documents");
  });
});

describe("gatherProjectSnapshot — share only when asked (PERF-3)", () => {
  const countMilestoneReads = () => state.fromCalls.filter((t) => t === "milestones").length;

  it("a sharing request joins the round in flight; a default request is its own round", async () => {
    state.delayMs = 5;
    const [a, b] = await Promise.all([gatherProjectSnapshot("org1", "p1"), gatherProjectSnapshot("org1", "p1", { share: true })]);
    expect(a).toBe(b);
    expect(countMilestoneReads()).toBe(1);
    // A sharing request landing right after settle (a tab mounting under
    // the coach) is served from that round too…
    await gatherProjectSnapshot("org1", "p1", { share: true });
    expect(countMilestoneReads()).toBe(1);
    // …but a default request (the closeout-gates dialog, a remounted coach)
    // never is; nor is another project, nor the legacy `fresh` option.
    await gatherProjectSnapshot("org1", "p1");
    expect(countMilestoneReads()).toBe(2);
    await gatherProjectSnapshot("org1", "p2", { share: true });
    expect(countMilestoneReads()).toBe(3);
    await gatherProjectSnapshot("org1", "p1", { share: true, fresh: true });
    expect(countMilestoneReads()).toBe(4);
  });

  it("a default request right after a write is never answered from the round before it", async () => {
    state.tables.project_members = [{ user_id: "u1" }];
    const before = await gatherProjectSnapshot("org1", "p1");
    expect(before.membersCount).toBe(1);
    // The write: a member is added, the page refreshes, the coach remounts
    // well inside SNAPSHOT_REUSE_MS and gathers without `share`.
    state.tables.project_members = [{ user_id: "u1" }, { user_id: "u2" }];
    const after = await gatherProjectSnapshot("org1", "p1");
    expect(after.membersCount).toBe(2);
  });

  it("aborting the last interested caller cancels the round (one macrotask later); the next call starts fresh", async () => {
    state.delayMs = 20;
    const ac = new AbortController();
    const p = gatherProjectSnapshot("org1", "p1", { signal: ac.signal });
    p.catch(() => undefined);
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    expect(countMilestoneReads()).toBe(1);
    state.delayMs = 0;
    await gatherProjectSnapshot("org1", "p1", { share: true });
    expect(countMilestoneReads()).toBe(2);
  });

  it("abort-then-resubscribe in one tick (a coach re-key) keeps the round: the re-key's run joins it", async () => {
    state.delayMs = 10;
    const mount = new AbortController();
    const first = gatherProjectSnapshot("org1", "p1", { signal: mount.signal });
    first.catch(() => undefined);
    // React: the effect cleanup aborts the mount run, then the re-keyed
    // effect subscribes — synchronously, in the same tick.
    mount.abort();
    const rekey = new AbortController();
    const second = gatherProjectSnapshot("org1", "p1", { signal: rekey.signal, share: true });
    await nextMacrotask();
    const snap = await second;
    expect(snap).toBeTruthy();
    expect(countMilestoneReads()).toBe(1);
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
    const drop = gatherProjectSnapshot("org1", "p1", { signal: ac.signal, share: true });
    drop.catch(() => undefined);
    ac.abort();
    await nextMacrotask();
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
  it("invalidateProjectSnapshot: a sharing request after a write is not answered from the round before it", async () => {
    state.tables.punch_items = [{ status: "open" }];
    const before = await gatherProjectSnapshot("org1", "p1");
    expect(before.punchOpen).toBe(1);
    // The write: the last punch item closes; the surface that wrote calls
    // invalidate, and the next sharing request (inside SNAPSHOT_REUSE_MS) re-gathers.
    state.tables.punch_items = [{ status: "closed" }];
    invalidateProjectSnapshot("org1", "p1");
    const after = await gatherProjectSnapshot("org1", "p1", { share: true });
    expect(after.punchOpen).toBe(0);
    expect(state.fromCalls.filter((t) => t === "punch_items")).toHaveLength(2);
    // Another project's round is untouched.
    await gatherProjectSnapshot("org1", "p2");
    invalidateProjectSnapshot("org1", "p1");
    await gatherProjectSnapshot("org1", "p2", { share: true });
    expect(state.fromCalls.filter((t) => t === "punch_items")).toHaveLength(3);
  });

  it("invalidating while a round is in flight lets its waiters finish but offers it to nobody else", async () => {
    state.delayMs = 10;
    const waiting = gatherProjectSnapshot("org1", "p1");
    invalidateProjectSnapshot("org1", "p1");
    const next = gatherProjectSnapshot("org1", "p1", { share: true });
    expect(await waiting).toBeTruthy();
    expect(await next).toBeTruthy();
    expect(state.fromCalls.filter((t) => t === "punch_items")).toHaveLength(2);
  });

  it("the sharing window is opt-in: only a request that asks is served from a settled round", async () => {
    state.tables.punch_items = [{ status: "open" }];
    await gatherProjectSnapshot("org1", "p1");
    state.tables.punch_items = [];
    const shared = await gatherProjectSnapshot("org1", "p1", { share: true });
    expect(shared.punchOpen).toBe(1); // the window, by design — only for the one re-key no write can precede
    const own = await gatherProjectSnapshot("org1", "p1");
    expect(own.punchOpen).toBe(0);
  });

  it("the coach's re-key rule: only the first re-key shares; the mount run and every later re-key gather their own round", () => {
    // Mount (and a remount after the page's refresh()): key unchanged — own round.
    expect(snapshotRekeyMayShare(0, 0, 0)).toBe(false);
    expect(snapshotRekeyMayShare(7, 7, 7)).toBe(false);
    // First change (a Costs / Quality tab mounting underneath): share.
    expect(snapshotRekeyMayShare(0, 0, 1)).toBe(true);
    // Second and later changes follow a write inside the tab: own round.
    expect(snapshotRekeyMayShare(0, 1, 2)).toBe(false);
    expect(snapshotRekeyMayShare(0, 2, 3)).toBe(false);
    // A re-run with the same key (orgId/projectId changed) is not a re-key.
    expect(snapshotRekeyMayShare(0, 2, 2)).toBe(false);
    // A consumer mounted with no key at all never re-keys.
    expect(snapshotRekeyMayShare(undefined, undefined, undefined)).toBe(false);
  });
});

// ── Verification fix (2026-09-30, projects Round G) ─────────────────────
// After J3 (money ledger): the snapshot reads change orders through
// listChangeOrders and passes approvedChangesByAccount(cos) exactly as the
// Costs tab does; counts approved change orders only while their money is
// on the ledger; burns against the revised budget; and leaves the award
// suggestion out before migration 20261013 gives quotes their RFQ groups.

describe("gatherProjectSnapshot — the Costs tab's money (MON-5 / COST-4)", () => {
  const ledger = (entryStatus: "posted" | "void") => {
    state.tables.cost_accounts = [{ id: "a1", project_id: "p1", name: "Piping", budget: 50_000, currency: "USD", wbs_milestone_id: null }];
    state.tables.cost_entries = [
      { id: "e1", cost_account_id: "a1", project_id: "p1", entry_type: "actual", amount: 30_000, status: "posted" },
      { id: "e2", cost_account_id: "a1", project_id: "p1", entry_type: "commitment", amount: 10_000, status: entryStatus },
    ];
    state.tables.change_orders = [
      { id: "co1", project_id: "p1", cost_account_id: "a1", co_number: "CO-1", title: "t", amount: 10_000, reason_code: "field_condition", status: "approved", posted_entry_id: "e2" },
      { id: "co2", project_id: "p1", cost_account_id: "a1", co_number: "CO-2", title: "t", amount: 4_000, reason_code: "owner_request", status: "approved", posted_entry_id: null },
      { id: "co3", project_id: "p1", cost_account_id: "a1", co_number: "CO-3", title: "t", amount: 2_000, reason_code: "owner_request", status: "proposed", posted_entry_id: null },
    ];
  };

  it("change orders are read through listChangeOrders — the approved COs' linked entries by id", async () => {
    ledger("posted");
    await gatherProjectSnapshot("org1", "p1");
    expect(state.selects).toContain("change_orders:*");
    expect(state.selects).toContain("cost_entries:id, status");
    const src = (await import("node:fs")).readFileSync(new URL("../projectSnapshot.ts", import.meta.url), "utf8");
    expect(src).toContain("computeCostRollup(accounts, entries, pctIdx, approvedChangesByAccount(coRows))");
  });

  it("approvedCoAmount counts only an approved CO whose entry is POSTED — not a link-less or hand-voided one", async () => {
    ledger("posted");
    const on = await gatherProjectSnapshot("org1", "p1");
    expect(on.approvedCoAmount).toBe(10_000); // co1 only: co2 has no entry, co3 is proposed
    expect(on.openChangeOrders).toBe(1);
    expect(on.budget).toBe(50_000); // baseline
    expect(on.revisedBudget).toBe(60_000);
    resetProjectSnapshotMemo();
    ledger("void");
    const off = await gatherProjectSnapshot("org1", "p1");
    expect(off.approvedCoAmount).toBe(0);
    expect(off.revisedBudget).toBe(50_000);
  });

  it("Cost burn is measured against the revised budget (the Costs tab's Budget); change-order growth against the baseline, labelled so", async () => {
    ledger("posted");
    const snap = await gatherProjectSnapshot("org1", "p1");
    const parts = computeProjectHealth(snap).parts;
    // 30k spent and 10k committed of the 60k revised budget — against the
    // base 50k these would read 60% and 20%.
    expect(parts.find((p) => p.label === "Cost")!.detail).toBe("50% of budget spent · 17% committed");
    expect(parts.find((p) => p.label === "Change control")!.detail).toBe("20% growth over the baseline budget via approved change orders · 1 open");
  });

  it("a refused change_orders read leaves Cost unknown (its budget is unknown) — a not-migrated one does not", async () => {
    ledger("posted");
    state.errors.change_orders = "permission denied for table change_orders";
    state.errorCodes.change_orders = "42501";
    const refused = await gatherProjectSnapshot("org1", "p1");
    expect(refused.readFailures).toEqual(["change orders"]);
    expect(computeProjectHealth(refused).parts.find((p) => p.label === "Cost")).toEqual({ label: "Cost", score: null, detail: "Could not read change orders" });

    resetProjectSnapshotMemo();
    state.errors.change_orders = 'relation "public.change_orders" does not exist';
    state.errorCodes.change_orders = "42P01";
    const pre = await gatherProjectSnapshot("org1", "p1");
    expect(pre.readFailures).toEqual([]);
    expect(pre.notMigrated).toEqual(["change orders"]);
    expect(computeProjectHealth(pre).parts.find((p) => p.label === "Cost")!.score).not.toBeNull();
  });

  it("a refused read of the approved COs' linked entries is a change-orders read failure, not an empty list", async () => {
    ledger("posted");
    // listChangeOrders' second read is cost_entries by id; fail cost_entries entirely.
    state.errors.cost_entries = "permission denied for table cost_entries";
    const snap = await gatherProjectSnapshot("org1", "p1");
    expect(snap.readFailures).toEqual(expect.arrayContaining(["cost entries", "change orders"]));
  });
});

describe("buildCoachItems — the award suggestion needs RFQ groups (migration 20261013)", () => {
  const twoQuotesOneScope = (withGroup: boolean) => [
    { kind: "quote", status: "parsed", vendor_name: "Acme", file_name: "q1.pdf", ...(withGroup ? { rfq_group: "Piping" } : {}) },
    { kind: "quote", status: "parsed", vendor_name: "Bolt Co", file_name: "q2.pdf", ...(withGroup ? { rfq_group: "Piping" } : {}) },
  ];

  it("before 20261013 every quote tabulates alone, so the unawarded-group count is a quote count — the award item is left out", async () => {
    state.missingColumns = ["rfq_group"];
    state.tables.cost_documents = twoQuotesOneScope(false);
    const snap = await gatherProjectSnapshot("org1", "p1");
    expect(snap.notMigrated).toEqual(["RFQ groups"]);
    expect(snap.quoteCount).toBe(2);
    expect(buildCoachItems(snap, "p1").map((i) => i.id)).not.toContain("award");
  });

  it("after it, one unawarded RFQ group raises the award item", async () => {
    state.tables.cost_documents = twoQuotesOneScope(true);
    const snap = await gatherProjectSnapshot("org1", "p1");
    expect(snap.notMigrated).toEqual([]);
    expect(snap.unawardedRfqGroups).toBe(1);
    expect(buildCoachItems(snap, "p1").map((i) => i.id)).toContain("award");
  });
});

// ── projects Round G J12 ─────────────────────────────────────────────────
// PERF-8: the page hands the coach the project row and roster it already
// read; the gather reads neither table again. BID-10: the unawarded-field
// count keys RFQ groups as the bid tab does. COST-2: the snapshot carries
// the rollup's exposure for the Cost part.
describe("gatherProjectSnapshot — the page's pre-read (PERF-8)", () => {
  const row = { id: "p1", name: "Unit 300", purpose: "Repipe", goals: ["On time"], sow_document_id: "d-sow", job_kind: "turnaround" };

  it("with the project row and roster handed over, neither projects nor project_members is read; their figures come from the pre-read", async () => {
    const snap = await gatherProjectSnapshot("org1", "p1", { pre: { project: row, members: [{ userId: "a" }, { userId: "b" }, { userId: "c" }] } });
    expect(state.fromCalls).not.toContain("projects");
    expect(state.fromCalls).not.toContain("project_members");
    expect(snap).toMatchObject({ hasPurpose: true, hasGoals: true, hasSow: true, jobKind: "turnaround", membersCount: 3 });
    expect(snap.notMigrated).toEqual([]);
    expect(snap.readFailures).toEqual([]);
  });

  it("without one, both are read as before (the control)", async () => {
    state.tables.projects = [row];
    state.tables.project_members = [{ user_id: "a" }];
    const snap = await gatherProjectSnapshot("org1", "p1");
    expect(state.fromCalls).toContain("projects");
    expect(state.fromCalls).toContain("project_members");
    expect(snap.membersCount).toBe(1);
  });

  it("a pre-read row without the 20261013 columns reads as not migrated — exactly what the read would have said", async () => {
    const snap = await gatherProjectSnapshot("org1", "p1", { pre: { project: { id: "p1", name: "Old" } } });
    expect(state.fromCalls).not.toContain("projects");
    expect(snap.notMigrated).toEqual([PROJECT_FIELDS_NOT_MIGRATED]);
    // the roster was not handed over, so it is read
    expect(state.fromCalls).toContain("project_members");
  });

  it("the coach and the page share the pre-read only for the round it started (a shared round is served as it was)", async () => {
    const a = gatherProjectSnapshot("org1", "p1", { pre: { project: row, members: [] } });
    const b = gatherProjectSnapshot("org1", "p1", { share: true });
    const [sa, sb] = await Promise.all([a, b]);
    expect(sb).toBe(sa);
    expect(state.fromCalls.filter((t) => t === "projects")).toHaveLength(0);
  });
});

describe("gatherProjectSnapshot — RFQ keys and exposure (BID-10 / COST-2)", () => {
  it("'Piping' and 'piping ' are ONE unawarded field, as the bid tab shows them", async () => {
    state.tables.cost_documents = [
      { kind: "quote", status: "parsed", vendor_name: "Acme", file_name: "a.pdf", rfq_group: "Piping" },
      { kind: "quote", status: "parsed", vendor_name: "Bolt", file_name: "b.pdf", rfq_group: "piping " },
      { kind: "quote", status: "parsed", vendor_name: "Cole", file_name: "c.pdf", rfq_group: "Pipe racks" },
    ];
    const snap = await gatherProjectSnapshot("org1", "p1");
    expect(snap.unawardedRfqGroups).toBe(2);
  });

  it("the snapshot carries spent + open commitments as exposure, and the Cost part burns on it", async () => {
    state.tables.cost_accounts = [{ id: "a1", project_id: "p1", name: "Piping", budget: 100_000, currency: "USD", wbs_milestone_id: null }];
    state.tables.cost_entries = [
      { id: "e1", cost_account_id: "a1", project_id: "p1", entry_type: "commitment", amount: 100_000, status: "posted" },
    ];
    const snap = await gatherProjectSnapshot("org1", "p1");
    expect(snap.spent).toBe(0);
    expect(snap.exposure).toBe(100_000);
    const part = computeProjectHealth(snap).parts.find((p) => p.label === "Cost")!;
    expect(part.detail).toBe("0% of budget spent · 100% committed · 100% committed or spent");
    expect(part.score).toBe(60);
  });
});
