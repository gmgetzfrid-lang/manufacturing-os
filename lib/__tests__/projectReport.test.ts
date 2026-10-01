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
  errorCodes: {} as Record<string, string>,
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
      if (state.errors[table]) return Promise.resolve({ data: null, error: { message: state.errors[table], code: state.errorCodes[table] ?? null }, count: null });
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
import { listAccounts, listEntries, computeCostRollup, milestonePctIndex, fmtMoney } from "@/lib/costs";
import { listChangeOrders, approvedChangesByAccount } from "@/lib/changeOrders";
import { computeForecast } from "@/lib/costSeries";
import { gatherProjectSnapshot, resetProjectSnapshotMemo } from "@/lib/projectSnapshot";
import { computeProjectHealth } from "@/lib/projectHealth";
import { PROJECT_MILESTONE_READ_LIMIT } from "@/lib/milestoneLiveness";

const DAY = 86_400_000;
const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY).toISOString();

beforeEach(() => {
  state.tables = {};
  state.errors = {};
  state.errorCodes = {};
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
    expect(html).toContain("100/600 tasks complete");
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
    expect(draft).toContain(`the first ${PROJECT_MILESTONE_READ_LIMIT} of ${PROJECT_MILESTONE_READ_LIMIT + 200} tasks by planned date`);
  });

  it("the report's bound is the snapshot's bound — and the Costs tab's (source pin)", async () => {
    // Verification fix (2026-09-30): the Costs tab read `order("planned_at")`
    // only — no id tiebreak, no explicit bound — so "the same first rows"
    // held only under the API's default cap with no tie at the cut.
    const fs = await import("node:fs");
    for (const f of ["../projectReport.ts", "../projectSnapshot.ts", "../../components/projects/CostsTab.tsx"]) {
      const src = fs.readFileSync(new URL(f, import.meta.url), "utf8");
      const ms = src.slice(src.indexOf('from("milestones")'), src.indexOf('from("milestones")') + 400);
      expect(ms, f).toMatch(/\.order\("planned_at"\)\.order\("id"\)\.limit\(PROJECT_MILESTONE_READ_LIMIT\)/);
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

// ── Verification fix (2026-09-30, projects Round G) ─────────────────────
// J3 (money ledger) merged after J7: computeCostRollup takes the approved
// change orders, `remaining` became budget − spent − open commitments, and
// the cost list functions throw on a failed read (REL-2). The report and the
// snapshot had to follow.

/** The Costs tab's computation (CostsTab.tsx refresh + rollup memo): the
 *  same four reads, the id-keyed index over the bounded milestone rows, and
 *  approvedChangesByAccount(cos) as the fourth argument. */
async function costsTabRollup(projectId: string) {
  const [accounts, entries, cos] = await Promise.all([listAccounts("org1", projectId), listEntries("org1", projectId), listChangeOrders(projectId)]);
  const rows = [...(state.tables.milestones ?? [])]
    .sort((a, b) => String(a.planned_at).localeCompare(String(b.planned_at)))
    .slice(0, PROJECT_MILESTONE_READ_LIMIT);
  const idx = milestonePctIndex(rows.map((m) => ({ id: String(m.id), percentComplete: m.percent_complete as number | null, status: String(m.status) })));
  return computeCostRollup(accounts, entries, idx, approvedChangesByAccount(cos));
}

/** $50k account pinned to a task 40% complete, $10k actual, and a +$10k
 *  change order approved with its entry POSTED (on the ledger). */
const onLedgerCoFixture = () => {
  state.tables.milestones = [
    { id: "m1", name: "Tie-in", planned_at: "2026-12-01T00:00:00Z", status: "in_progress", percent_complete: 40, source: "p6" },
  ];
  state.tables.cost_accounts = [
    { id: "a1", project_id: "p1", name: "Tie-in welding", budget: 50_000, currency: "USD", wbs_milestone_id: "m1", status: "active" },
  ];
  state.tables.cost_entries = [
    { id: "e1", cost_account_id: "a1", project_id: "p1", entry_type: "actual", amount: 10_000, status: "posted", entry_date: "2026-09-01" },
    { id: "e2", cost_account_id: "a1", project_id: "p1", entry_type: "commitment", amount: 10_000, status: "posted", entry_date: "2026-09-02" },
  ];
  state.tables.change_orders = [
    { id: "co1", project_id: "p1", cost_account_id: "a1", co_number: "CO-1", title: "Extra tie-in", amount: 10_000, reason_code: "field_condition", status: "approved", posted_entry_id: "e2" },
  ];
};

describe("report, coach and Costs tab agree on CPI once a change order is approved (MON-5 / PM-12 / COST-4)", () => {
  beforeEach(() => resetProjectSnapshotMemo());

  it("an on-ledger approved CO: all three compute CPI 2.40 (the report and coach printed 2.00)", async () => {
    onLedgerCoFixture();
    const tab = await costsTabRollup("p1");
    const d = await gatherReportData("org1", "p1");
    const snap = await gatherProjectSnapshot("org1", "p1");
    // Revised budget 60k × 40% = 24k earned / 10k actual.
    expect(tab.cpi).toBeCloseTo(2.4, 9);
    expect(d.rollup.cpi).toBe(tab.cpi);
    expect(snap.cpi).toBe(tab.cpi);
    expect(d.rollup.revisedBudget).toBe(60_000);
    expect(snap.revisedBudget).toBe(60_000);
    expect(computeProjectHealth(snap).parts.find((p) => p.label === "Cost")!.detail).toContain("CPI 2.40");
    const html = renderReportHtml(d);
    expect(html).toMatch(/Cost performance \(CPI\)<\/td><td><span class="num">2\.40<\/span>/);
    // The Budget row is the revised figure the Costs tab headlines, with the baseline beside it.
    expect(html).toMatch(/Budget<\/td><td><span class="num">\$60,000<\/span> <span class="muted">— \$50,000 baseline \+ \$10,000 approved change orders/);
  });

  it("a CO approved but whose entry was voided by hand is NOT on the ledger — none of the three count it", async () => {
    onLedgerCoFixture();
    state.tables.cost_entries[1].status = "void";
    const tab = await costsTabRollup("p1");
    const d = await gatherReportData("org1", "p1");
    const snap = await gatherProjectSnapshot("org1", "p1");
    expect(tab.cpi).toBeCloseTo(2.0, 9);
    expect(d.rollup.cpi).toBe(tab.cpi);
    expect(snap.cpi).toBe(tab.cpi);
    expect(snap.approvedCoAmount).toBe(0);
  });

  it("the forecast takes the Costs tab's inputs — revised budget and the pinned subset — and prints its scope note (COST-1)", async () => {
    onLedgerCoFixture();
    // A second, unpinned account: CPI covers only the pinned part.
    state.tables.cost_accounts.push({ id: "a2", project_id: "p1", name: "Scaffold", budget: 20_000, currency: "USD", wbs_milestone_id: null, status: "active" });
    state.tables.cost_entries.push({ id: "e3", cost_account_id: "a2", project_id: "p1", entry_type: "actual", amount: 5_000, status: "posted", entry_date: "2026-09-03" });
    const tab = await costsTabRollup("p1");
    // CostCharts.tsx's call, verbatim in its inputs (no schedule span: one milestone).
    const tabForecast = computeForecast({
      budget: tab.revisedBudget, spent: tab.spent, cpi: tab.cpi,
      pinnedBudget: tab.pinnedBudget, pinnedSpent: tab.pinnedSpent,
      scheduleStart: "2026-12-01", scheduleEnd: "2026-12-01", today: new Date().toISOString().slice(0, 10),
      fmt: (n) => fmtMoney(n, "USD"),
    });
    const d = await gatherReportData("org1", "p1");
    expect(d.forecastSentence).toBe(tabForecast.sentence);
    expect(d.forecastScopeNote).toBe(tabForecast.scopeNote);
    expect(d.forecastScopeNote).toMatch(/^CPI applies to the 75% of budget pinned/);
    expect(renderReportHtml(d)).toContain(d.forecastScopeNote!);
  });
});

describe("'Budget less spent' is budget less spent; Available is its own row (MON-4 report limb)", () => {
  const committedFixture = () => {
    state.tables.cost_accounts = [{ id: "a1", project_id: "p1", name: "Piping", budget: 50_000, currency: "USD", status: "active" }];
    state.tables.cost_entries = [
      { id: "e1", cost_account_id: "a1", project_id: "p1", entry_type: "commitment", amount: 30_000, status: "posted", party_id: "v1", entry_date: "2026-09-01" },
      { id: "e2", cost_account_id: "a1", project_id: "p1", entry_type: "actual", amount: 10_000, status: "posted", party_id: "v1", entry_date: "2026-09-02" },
    ];
  };

  it("$50k budget, $10k spent, $20k still committed: the row labelled 'open commitments are not deducted' prints $40,000 — not $20,000", async () => {
    committedFixture();
    const d = await gatherReportData("org1", "p1");
    const html = renderReportHtml(d);
    expect(html.match(/Budget less spent<\/td><td>(.*?)<\/td>/)?.[1]).toBe(
      '<span class="num ok">$40,000</span> <span class="muted">— open commitments are not deducted</span>');
    const available = html.match(/Available \(uncommitted\)<\/td><td>(.*?)<\/td>/)?.[1] ?? "";
    expect(available).toContain("$20,000");
    expect(available).toContain("less $20,000 of open commitments not yet invoiced");
  });

  it("the lessons-learned draft says finished $40,000 under on actual spend and names the $20,000 still open", async () => {
    committedFixture();
    const cost = (await draftLessonsLearned("org1", "p1")).split("\n")[0];
    expect(cost).toBe("COST: Finished $40,000 under the $50,000 budget on actual spend. $20,000 of open commitments was not yet invoiced when this was drafted.");
    expect(cost).not.toContain("$20,000 under");
  });

  it("with an approved change order the draft measures against the revised budget and says so", async () => {
    onLedgerCoFixture();
    const cost = (await draftLessonsLearned("org1", "p1")).split("\n")[0];
    // e2 (the CO's commitment) is the same party key as the actual → drawn down to 0 open.
    expect(cost).toBe("COST: Finished $50,000 under the $60,000 budget ($50,000 baseline + $10,000 approved change orders) on actual spend (CPI 2.40).");
  });
});

describe("a refused read is said, never printed as zero (REL-2 consumer)", () => {
  it("a refused cost_accounts read: no $0.00 Budget row — the Money section says it could not be read", async () => {
    onLedgerCoFixture();
    state.errors.cost_accounts = "permission denied for table cost_accounts";
    const d = await gatherReportData("org1", "p1");
    expect(d.readFailures).toEqual(["cost accounts"]);
    const html = renderReportHtml(d);
    expect(html).not.toMatch(/<td class="k">Budget<\/td>/);
    expect(html).not.toContain("$0.00");
    expect(html).toMatch(/Cost ledger<\/td><td><span class="flag">Could not read cost accounts<\/span> — the money figures are left out, not printed as zero\./);
    expect(html).toContain("Not read this time: cost accounts");
    const draft = await draftLessonsLearned("org1", "p1");
    expect(draft.split("\n")[0]).toBe("COST: Could not read cost accounts when this draft was written — the cost outcome is left out; fill it in by hand.");
    expect(draft).not.toMatch(/Clean job|budget held/);
  });

  it("a refused change_orders read blanks the Money section too — a budget without its approved changes would read like a real one", async () => {
    onLedgerCoFixture();
    state.errors.change_orders = "permission denied for table change_orders";
    const d = await gatherReportData("org1", "p1");
    expect(d.readFailures).toEqual(["change orders"]);
    const html = renderReportHtml(d);
    expect(html).toContain("Could not read change orders");
    expect(html).not.toContain("Cost performance (CPI)");
  });

  it("a refused milestones read says so instead of 'No schedule loaded', and the pinned CPI is named as unread", async () => {
    onLedgerCoFixture();
    state.errors.milestones = "permission denied for table milestones";
    const d = await gatherReportData("org1", "p1");
    expect(d.readFailures).toEqual(["schedule tasks"]);
    const html = renderReportHtml(d);
    expect(html).not.toContain("No schedule loaded");
    expect(html).toContain("Could not read the schedule");
    expect(html).toMatch(/Cost performance \(CPI\)<\/td><td><span class="muted">Could not read<\/span>/);
    expect(await draftLessonsLearned("org1", "p1")).toContain("SCHEDULE: Could not read the schedule");
  });

  it("a refused punch read is not 'Clear', and the draft never writes 'Clean job' over it", async () => {
    state.errors.punch_items = "permission denied for table punch_items";
    const d = await gatherReportData("org1", "p1");
    expect(d.readFailures).toEqual(["punch items"]);
    expect(renderReportHtml(d)).toMatch(/Punch list<\/td><td><span class="muted">Could not read<\/span>/);
    const draft = await draftLessonsLearned("org1", "p1");
    expect(draft).toBe("NOT READ: punch items could not be read when this draft was written — check it by hand.");
  });

  it("a database migration 20261013 has not reached (no change_orders / punch_items table) is not a failed read — the money prints", async () => {
    state.tables.cost_accounts = [{ id: "a1", project_id: "p1", name: "Piping", budget: 50_000, currency: "USD", status: "active" }];
    state.tables.cost_entries = [{ id: "e1", cost_account_id: "a1", project_id: "p1", entry_type: "actual", amount: 10_000, status: "posted", entry_date: "2026-09-01" }];
    for (const t of ["change_orders", "punch_items"]) {
      state.errors[t] = `relation "public.${t}" does not exist`;
      state.errorCodes[t] = "42P01";
    }
    const d = await gatherReportData("org1", "p1");
    expect(d.readFailures).toEqual([]);
    const html = renderReportHtml(d);
    expect(html).toMatch(/Budget less spent<\/td><td><span class="num ok">\$40,000<\/span>/);
    expect(html).not.toMatch(/Could not read|Not read this time/);
    // A refused read of the same tables IS a failure.
    state.errorCodes.change_orders = "42501";
    expect((await gatherReportData("org1", "p1")).readFailures).toEqual(["change orders"]);
  });

  it("every read landing: no failure line anywhere", async () => {
    onLedgerCoFixture();
    const d = await gatherReportData("org1", "p1");
    expect(d.readFailures).toEqual([]);
    expect(renderReportHtml(d)).not.toMatch(/Could not read|Not read this time/);
  });
});

// ── projects Round G J12 ─────────────────────────────────────────────────
// COST-6 (report half): the close-out record prints each change order's
// proposer and decider, and flags the one person who did both.
// GAP-405 acceptance 2: every decision that closes a gate prints with the
// reason the person who made it recorded.
describe("the report names who proposed and who decided each change order (COST-6)", () => {
  const cos = () => {
    state.tables.cost_accounts = [{ id: "a1", project_id: "p1", name: "Piping", budget: 50_000, currency: "USD", wbs_milestone_id: null, status: "active" }];
    state.tables.cost_entries = [];
    state.tables.change_orders = [
      { id: "co1", project_id: "p1", cost_account_id: "a1", co_number: "CO-001", title: "Extra spools", amount: 4_000, reason_code: "field_condition", status: "approved",
        created_by: "u-a", created_by_name: "mreyes", decided_by: "u-b", decided_by_name: "jchen", decided_at: "2026-09-20T00:00:00Z", decision_note: "Agreed on site", posted_entry_id: null },
      { id: "co2", project_id: "p1", cost_account_id: "a1", co_number: "CO-002", title: "Night shift", amount: 9_000, reason_code: "owner_request", status: "rejected",
        created_by: "u-a", created_by_name: "mreyes", decided_by: "u-a", decided_by_name: "mreyes", decided_at: "2026-09-21T00:00:00Z", decision_note: null, posted_entry_id: null },
      { id: "co3", project_id: "p1", cost_account_id: "a1", co_number: "CO-003", title: "<b>Scaffold</b>", amount: 1_000, reason_code: "owner_request", status: "proposed",
        created_by: "u-c", created_by_name: "pat", decided_by: null, decided_by_name: null, decided_at: null, decision_note: null, posted_entry_id: null },
    ];
  };

  it("each change order prints proposer and decider; the self-decided one is flagged 'same person' and the legend explains it", async () => {
    cos();
    const d = await gatherReportData("o1", "p1");
    const lines = [...d.coLines].sort((a, b) => a.coNumber.localeCompare(b.coNumber));
    expect(lines.map((c) => [c.coNumber, c.proposedBy, c.decidedBy, c.samePerson])).toEqual([
      ["CO-001", "mreyes", "jchen", false], ["CO-002", "mreyes", "mreyes", true], ["CO-003", "pat", null, false],
    ]);
    const html = renderReportHtml(d);
    expect(html).toContain("<th>Proposed by</th><th>Decided by</th>");
    expect(html).toMatch(/CO-002[\s\S]*?<td>mreyes<\/td><td>mreyes[^<]*<span class="muted">[^<]*<\/span> <span class="flag">same person<\/span>/);
    expect(html).toMatch(/CO-001[\s\S]*?<td>mreyes<\/td><td>jchen[\s\S]*?— Agreed on site/);
    expect(html).toContain("same person</span> marks a change order its proposer decided");
    expect(html).toContain("&lt;b&gt;Scaffold&lt;/b&gt;");
    expect(html).not.toContain("<b>Scaffold</b>");
  });

  it("a refused change_orders read prints no table (the Money section already says it could not be read)", async () => {
    cos();
    state.errors.change_orders = "permission denied";
    state.errorCodes.change_orders = "42501";
    const html = renderReportHtml(await gatherReportData("o1", "p1"));
    expect(html).not.toContain("<th>Proposed by</th>");
  });
});

describe("the report prints each closeout decision with its reason (GAP-405)", () => {
  const decided = () => {
    state.tables.project_checklists = [{ id: "cl1", org_id: "o1", project_id: "p1", title: "PSSR", kind: "pssr", status: "open" }];
    state.tables.checklist_items = [
      { id: "i1", checklist_id: "cl1", seq: 1, text: "Relief valves tagged", applicability: "na", status: "na", evidence: [], manual_note: "No relief valves in this scope", updated_by: "u-b", updated_by_name: "jchen", updated_at: "2026-09-25T00:00:00Z" },
      { id: "i2", checklist_id: "cl1", seq: 2, text: "Hydrotest", applicability: "applies", status: "satisfied", evidence: [{ label: "auto", source: "auto" }], manual_note: null, updated_by: null, updated_by_name: "evidence sweep", updated_at: "2026-09-26T00:00:00Z" },
      { id: "i3", checklist_id: "cl1", seq: 3, text: "Walkdown", applicability: "applies", status: "satisfied", evidence: [], manual_note: "Walked with ops 9/24", updated_by: "u-a", updated_by_name: "mreyes", updated_at: "2026-09-24T00:00:00Z" },
    ];
    state.tables.turnover_items = [
      { id: "t1", project_id: "p1", name: "Weld map", status: "waived", required: true, review_note: "Owner accepted the weld log in its place", reviewed_by_name: "pat", reviewed_at: "2026-09-27T00:00:00Z" },
      { id: "t2", project_id: "p1", name: "NDE reports", status: "received", required: true, review_note: null },
    ];
    state.tables.punch_items = [
      { id: "pu1", project_id: "p1", title: "Missing insulation", status: "void", closure_note: "Duplicate of PU-7", closed_by_name: "jchen", closed_at: "2026-09-28T00:00:00Z" },
      { id: "pu2", project_id: "p1", title: "Paint touch-up", status: "open" },
    ];
  };

  it("person-made decisions print newest first with the reason and who made it; a machine green and undecided rows do not", async () => {
    decided();
    const d = await gatherReportData("o1", "p1");
    expect(d.decisions.map((x) => [x.area, x.item, x.decision, x.reason, x.by])).toEqual([
      ["Punch", "Missing insulation", "voided", "Duplicate of PU-7", "jchen"],
      ["Turnover", "Weld map", "waived", "Owner accepted the weld log in its place", "pat"],
      ["Checklist", "PSSR — Relief valves tagged", "not applicable", "No relief valves in this scope", "jchen"],
      ["Checklist", "PSSR — Walkdown", "satisfied", "Walked with ops 9/24", "mreyes"],
    ]);
    expect(d.punchOpen).toBe(1);
    const html = renderReportHtml(d);
    expect(html).toContain("Decisions on the record — each with the reason the person who made it recorded");
    expect(html).toContain("<td>waived</td><td>Owner accepted the weld log in its place</td>");
    expect(html).not.toContain("Hydrotest</td>");
  });

  it("no decisions → no section", async () => {
    const html = renderReportHtml(await gatherReportData("o1", "p1"));
    expect(html).not.toContain("Decisions on the record");
  });
});
