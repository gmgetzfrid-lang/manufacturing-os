// projects-tab MON-5 / MON-6 / MON-4 (report label) / SAF-14 (report half)
// · projects-and-cost PM-12 / PM-3 — the printed report computes the same
// CPI as the Costs tab, sees imported schedules, labels the remaining
// figure so it cannot be misread, and renders the closeout gate snapshot.
//
// Before: projectReport.ts built a milestone-percent index keyed by ARRAY
// POSITION from a query that did not select `id`, then discarded it
// (`void pctIdx`) and passed `new Map()` to computeCostRollup — so
// rollup.cpi was null on every report, the CPI row never printed, the
// forecast silently fell to the run-rate basis, and the lessons-learned
// draft never carried the figure. Imported rows were filtered out, so the
// report said "No schedule loaded" for a 400-activity P6 import.

import { describe, it, expect, vi, beforeEach } from "vitest";

const state = vi.hoisted(() => ({
  tables: {} as Record<string, Array<Record<string, unknown>>>,
  errors: {} as Record<string, string>,
}));

vi.mock("@/lib/supabase", () => {
  // Honours what the report's bound depends on: order("planned_at"),
  // limit(n) and select(…, { count: "exact" }) — as PostgREST does.
  function chain(table: string) {
    const c: Record<string, unknown> = {};
    let limit: number | null = null;
    let orderBy: string | null = null;
    let wantCount = false;
    const settle = () => {
      if (state.errors[table]) return Promise.resolve({ data: null, error: { message: state.errors[table] }, count: null });
      let rows = [...(state.tables[table] ?? [])];
      if (orderBy) {
        const k = orderBy;
        rows.sort((a, b) => String(a[k] ?? "\uffff").localeCompare(String(b[k] ?? "\uffff")));
      }
      const total = rows.length;
      if (limit != null) rows = rows.slice(0, limit);
      return Promise.resolve({ data: rows, error: null, count: wantCount ? total : null });
    };
    const handler: ProxyHandler<Record<string, unknown>> = {
      get(_t, prop: string) {
        if (prop === "then") {
          return (resolve: (v: unknown) => void, reject?: (e: unknown) => void) => settle().then(resolve, reject);
        }
        return (...args: unknown[]) => {
          if (prop === "select") wantCount = (args[1] as { count?: string } | undefined)?.count === "exact";
          if (prop === "limit") limit = Number(args[0]);
          if (prop === "order" && orderBy == null) orderBy = String(args[0]);
          if (prop === "maybeSingle") {
            return settle().then((r) => ({ data: Array.isArray(r.data) ? (r.data[0] ?? null) : null, error: r.error }));
          }
          return new Proxy(c, handler);
        };
      },
    };
    return new Proxy(c, handler);
  }
  return { supabase: { from: (t: string) => chain(t) } };
});

import { gatherReportData, renderReportHtml, parseGateSnapshot, draftLessonsLearned } from "@/lib/projectReport";
import { listAccounts, listEntries, computeCostRollup, milestonePctIndex } from "@/lib/costs";
import { PROJECT_MILESTONE_READ_LIMIT } from "@/lib/milestoneLiveness";

const DAY = 86_400_000;
const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY).toISOString();

beforeEach(() => {
  state.tables = {};
  state.errors = {};
  state.tables.projects = [{ id: "p1", name: "Unit 300 repipe", status: "active", owner_user_name: "Pat", goals: ["Zero recordables"] }];
});

const pinnedFixture = () => {
  state.tables.milestones = [
    { id: "m1", name: "Demo complete", planned_at: iso(-2), status: "in_progress", percent_complete: 50, source: "manual" },
  ];
  state.tables.cost_accounts = [
    { id: "a1", project_id: "p1", name: "Piping subcontract", budget: 100_000, currency: "USD", wbs_milestone_id: "m1", status: "active" },
  ];
  state.tables.cost_entries = [
    { id: "e1", cost_account_id: "a1", project_id: "p1", entry_type: "actual", amount: 40_000, status: "posted", entry_date: iso(-1) },
    { id: "e2", cost_account_id: "a1", project_id: "p1", entry_type: "commitment", amount: 90_000, status: "posted", entry_date: iso(-5) },
  ];
};

describe("the printed report's CPI (MON-5 / PM-12)", () => {
  it("a pinned account + a 50% milestone yields the same CPI the Costs tab computes", async () => {
    pinnedFixture();
    const d = await gatherReportData("org1", "p1");
    expect(d.rollup.cpi).not.toBeNull();
    expect(d.rollup.cpi).toBeCloseTo(1.25, 6); // EV 50,000 / actual 40,000

    // The Costs tab's computation (CostsTab.tsx: id-keyed milestonePctIndex
    // over the same rows) — the two must agree.
    const [accounts, entries] = await Promise.all([listAccounts("org1", "p1"), listEntries("org1", "p1")]);
    const tab = computeCostRollup(accounts, entries, milestonePctIndex(
      state.tables.milestones.map((m) => ({ id: String(m.id), percentComplete: m.percent_complete as number, status: String(m.status) })),
    ));
    expect(d.rollup.cpi).toBe(tab.cpi);

    const html = renderReportHtml(d);
    expect(html).toContain("Cost performance (CPI)");
    expect(html).toContain("1.25");
  });

  it("the forecast is on the CPI basis and the lessons-learned draft carries the figure", async () => {
    pinnedFixture();
    const d = await gatherReportData("org1", "p1");
    // computeForecast: cpi basis → "At this performance you'll finish around …"
    expect(d.forecastSentence).toMatch(/^At this performance/);
    const draft = await draftLessonsLearned("org1", "p1");
    expect(draft).toContain("(CPI 1.25)");
  });

  it("the remaining figure is labelled as budget-less-spent with commitments not deducted (MON-4 report limb)", async () => {
    pinnedFixture();
    const html = renderReportHtml(await gatherReportData("org1", "p1"));
    expect(html).toContain("Budget less spent");
    expect(html).toContain("open commitments are not deducted");
    expect(html).not.toMatch(/<td class="k">Remaining<\/td>/);
  });
});

// projects-tab MON-2 (report half, J5 CHARTS fix pass): planned_at is a
// milestone's FINISH. The printed report's run-rate forecast divides by the
// elapsed share of the SAME span the Costs tab uses — earliest task start to
// latest finish (lib/costSeries scheduleSpanFromMilestones) — so paper and
// screen print one EAC. Before: the report sorted planned_at and began its
// span at the first FINISH (12 June here), printing about $57,895 where the
// tab said $40,333.
describe("the printed report's forecast runs over the Costs tab's span (MON-2)", () => {
  const multiDay = [
    { id: "m1", name: "Demo", planned_start_at: "2026-06-01T00:00:00+00:00", planned_at: "2026-06-12T00:00:00+00:00", status: "completed", percent_complete: 100, source: "p6" },
    { id: "m2", name: "Tie-ins", planned_start_at: "2026-07-01T00:00:00+00:00", planned_at: "2026-08-15T00:00:00+00:00", status: "planned", percent_complete: 0, source: "p6" },
    { id: "m3", name: "Hydrotest", planned_start_at: "2026-09-20T00:00:00+00:00", planned_at: "2026-09-30T00:00:00+00:00", status: "planned", percent_complete: 0, source: "p6" },
  ];

  it("multi-day tasks, $121,000 budget, $10,000 spent, no CPI, today 1 July: the report's EAC is the tab's", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-01T12:00:00Z"));
    try {
      state.tables.milestones = multiDay;
      state.tables.cost_accounts = [
        { id: "a1", project_id: "p1", name: "Piping", budget: 121_000, currency: "USD", wbs_milestone_id: null, status: "active" },
      ];
      state.tables.cost_entries = [
        { id: "e1", cost_account_id: "a1", project_id: "p1", entry_type: "actual", amount: 10_000, status: "posted", entry_date: "2026-06-20" },
      ];
      const d = await gatherReportData("org1", "p1");
      expect(d.rollup.cpi).toBeNull();

      // The Costs tab's computation: its span (CostsTab.tsx sets it through
      // scheduleSpanFromMilestones over the same rows) into computeForecast
      // (CostCharts.tsx).
      const { computeForecast, scheduleSpanFromMilestones } = await import("@/lib/costSeries");
      const { fmtMoney } = await import("@/lib/costs");
      const span = scheduleSpanFromMilestones(multiDay);
      expect(span).toEqual({ start: "2026-06-01", end: "2026-09-30" });
      const tab = computeForecast({
        budget: 121_000, spent: 10_000, cpi: null, scheduleStart: span.start, scheduleEnd: span.end,
        today: "2026-07-01", fmt: (n) => fmtMoney(n, "USD"),
      });
      expect(tab.basis).toBe("run_rate");
      expect(tab.eac).toBeCloseTo(10_000 / (30 / 121), 6); // 30 of 121 days elapsed → $40,333

      expect(d.forecastSentence).toBe(tab.sentence);
      expect(d.forecastSentence).toContain(fmtMoney(10_000 / (30 / 121), "USD"));
      // The finish-only span (12 June → 30 September: 19 of 110 days).
      expect(d.forecastSentence).not.toContain(fmtMoney(10_000 / (19 / 110), "USD"));
      expect(renderReportHtml(d)).toContain(tab.sentence!);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the report reads each milestone's start and takes its span from the shared helper (source pin)", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync(new URL("../projectReport.ts", import.meta.url), "utf8");
    expect(src).toMatch(/from\("milestones"\)\.select\("[^"]*\bplanned_start_at\b[^"]*"/);
    expect(src).toContain("scheduleSpanFromMilestones(live.map(");
    expect(src).not.toMatch(/\bdates\[0\]/);
  });
});

/** A P6-scale schedule: `n` imported activities, one a day, ascending. */
const bigSchedule = (n: number) => Array.from({ length: n }, (_, i) => ({
  id: `m${String(i).padStart(4, "0")}`,
  name: `Activity ${i}`,
  planned_at: new Date(Date.UTC(2026, 0, 1) + i * DAY).toISOString(),
  status: i < 100 ? "completed" : "planned",
  percent_complete: i === 550 ? 40 : (i < 100 ? 100 : 0),
  source: "p6",
}));

describe("the report reads the same schedule rows as the Costs tab (MON-5 at P6 scale)", () => {
  it("600 activities, an account pinned to row 550: the report CPI equals the Costs-tab computation", async () => {
    state.tables.milestones = bigSchedule(600);
    state.tables.cost_accounts = [
      { id: "a1", project_id: "p1", name: "Tie-in welding", budget: 50_000, currency: "USD", wbs_milestone_id: "m0550", status: "active" },
    ];
    state.tables.cost_entries = [
      { id: "e1", cost_account_id: "a1", project_id: "p1", entry_type: "actual", amount: 10_000, status: "posted", entry_date: iso(-1) },
    ];
    const d = await gatherReportData("org1", "p1");
    // Every row read: row 550 is in the EV index (the old limit(500) cut it).
    expect(d.milestones).toHaveLength(600);
    expect(d.milestoneTotal).toBe(600);
    expect(d.rollup.cpi).toBeCloseTo(2, 6); // EV 40% × 50,000 = 20,000 / actual 10,000

    // The Costs tab: every row ordered by planned_at (CostsTab.tsx), id-keyed index.
    const [accounts, entries] = await Promise.all([listAccounts("org1", "p1"), listEntries("org1", "p1")]);
    const tab = computeCostRollup(accounts, entries, milestonePctIndex(
      state.tables.milestones.map((m) => ({ id: String(m.id), percentComplete: m.percent_complete as number, status: String(m.status) })),
    ));
    expect(d.rollup.cpi).toBe(tab.cpi);

    const html = renderReportHtml(d);
    expect(html).toContain("100/600 milestones complete");
    expect(html).toContain("600 imported from the schedule file");
    expect(html).not.toMatch(/first \d+ of/);
  });

  it("a schedule larger than the bound says 'first N of M' instead of passing a subset off as the whole", async () => {
    state.tables.milestones = bigSchedule(PROJECT_MILESTONE_READ_LIMIT + 200);
    const d = await gatherReportData("org1", "p1");
    expect(d.milestones).toHaveLength(PROJECT_MILESTONE_READ_LIMIT);
    expect(d.milestoneTotal).toBe(PROJECT_MILESTONE_READ_LIMIT + 200);
    const html = renderReportHtml(d);
    expect(html).toContain(`first ${PROJECT_MILESTONE_READ_LIMIT} of ${PROJECT_MILESTONE_READ_LIMIT + 200} by planned date`);
    const draft = await draftLessonsLearned("org1", "p1");
    expect(draft).toContain(`the first ${PROJECT_MILESTONE_READ_LIMIT} of ${PROJECT_MILESTONE_READ_LIMIT + 200} activities by planned date`);
  });

  it("the report's bound is the snapshot's bound (source pin)", async () => {
    const fs = await import("node:fs");
    for (const f of ["../projectReport.ts", "../projectSnapshot.ts"]) {
      const src = fs.readFileSync(new URL(f, import.meta.url), "utf8");
      const ms = src.slice(src.indexOf('from("milestones")'), src.indexOf('from("milestones")') + 400);
      expect(ms, f).toMatch(/\.order\("planned_at"\)/);
      expect(ms, f).toContain(".limit(PROJECT_MILESTONE_READ_LIMIT)");
    }
  });
});

describe("imported schedules on paper (MON-6 / PM-3)", () => {
  it("an imported-only project prints the milestone table, never 'No schedule loaded'", async () => {
    state.tables.milestones = [
      { id: "m1", name: "Mobilize crane", planned_at: iso(-3), status: "planned", percent_complete: 0, source: "p6" },
      { id: "m2", name: "Hydrotest", planned_at: iso(+4), status: "planned", percent_complete: 0, source: "p6" },
    ];
    const d = await gatherReportData("org1", "p1");
    expect(d.milestones).toHaveLength(2);
    expect(d.milestones.every((m) => m.imported)).toBe(true);
    expect(d.overdue).toBe(1);
    const html = renderReportHtml(d);
    expect(html).not.toContain("No schedule loaded");
    expect(html).toContain("Mobilize crane");
    expect(html).toContain("2 imported from the schedule file");
    expect(html).toContain("1 overdue");
  });

  it("due today is not overdue on paper either (SCH-5 consumer)", async () => {
    const today = new Date(); today.setUTCHours(0, 0, 0, 0);
    state.tables.milestones = [
      { id: "m1", name: "Due today", planned_at: today.toISOString(), status: "planned", percent_complete: 0, source: "manual" },
    ];
    const d = await gatherReportData("org1", "p1");
    expect(d.overdue).toBe(0);
  });
});

describe("the closeout snapshot (SAF-14 report half)", () => {
  it("renders the gate state recorded on the completion audit row, as recorded", async () => {
    state.tables.audit_logs = [{
      timestamp: "2026-09-01T12:00:00Z",
      details: {
        reason: "Punch to be closed by vendor next week",
        gates: [
          { text: "3 punch items still open", ok: false },
          { text: "Turnover package fully accepted", ok: true },
        ],
      },
    }];
    const d = await gatherReportData("org1", "p1");
    expect(d.closeout?.gates).toEqual([
      { text: "3 punch items still open", ok: false },
      { text: "Turnover package fully accepted", ok: true },
    ]);
    const html = renderReportHtml(d);
    expect(html).toContain("<h2>Closeout</h2>");
    expect(html).toContain("Gate state recorded at completion");
    expect(html).toContain("3 punch items still open");
    expect(html).toContain("Punch to be closed by vendor next week");
  });

  it("a completion without a snapshot says so rather than passing today's rows off as closeout day's", async () => {
    state.tables.audit_logs = [{ timestamp: "2026-09-01T12:00:00Z", details: { reason: null } }];
    const html = renderReportHtml(await gatherReportData("org1", "p1"));
    expect(html).toContain("No gate snapshot was recorded with this completion");
  });

  it("no completion row → no closeout section", async () => {
    const d = await gatherReportData("org1", "p1");
    expect(d.closeout).toBeNull();
    expect(renderReportHtml(d)).not.toContain("<h2>Closeout</h2>");
  });

  it("parseGateSnapshot reads the recorded shapes tolerantly and drops nothing", () => {
    expect(parseGateSnapshot(null)).toBeNull();
    expect(parseGateSnapshot({ reason: "x" })).toBeNull();
    expect(parseGateSnapshot({ gates: { punchClear: false, turnover: { ok: true, text: "Turnover 4/4 accepted" }, openChangeOrders: 2 } })).toEqual([
      { text: "punchClear", ok: false },
      { text: "Turnover 4/4 accepted", ok: true },
      { text: "openChangeOrders: 2", ok: null },
    ]);
    expect(parseGateSnapshot({ gateSnapshot: ["Checklists clear", { label: "Punch", passed: false, count: 3 }] })).toEqual([
      { text: "Checklists clear", ok: null },
      { text: "Punch — 3", ok: false },
    ]);
  });
});
