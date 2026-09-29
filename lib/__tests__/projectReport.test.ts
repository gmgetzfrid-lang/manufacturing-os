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
  function chain(table: string) {
    const c: Record<string, unknown> = {};
    const settle = () => Promise.resolve(state.errors[table]
      ? { data: null, error: { message: state.errors[table] } }
      : { data: state.tables[table] ?? [], error: null });
    const handler: ProxyHandler<Record<string, unknown>> = {
      get(_t, prop: string) {
        if (prop === "then") {
          return (resolve: (v: unknown) => void, reject?: (e: unknown) => void) => settle().then(resolve, reject);
        }
        return () => {
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
