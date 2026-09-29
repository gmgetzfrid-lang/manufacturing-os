import { describe, it, expect } from "vitest";
import { computeCostRollup, milestonePctIndex, fmtMoney, type CostAccount, type CostEntry } from "@/lib/costs";
import { computeForecast } from "@/lib/costSeries";

const acct = (over: Partial<CostAccount>): CostAccount => ({
  id: "a1", projectId: "p1", code: "01", name: "Piping", costType: "subcontract",
  budget: 1000, currency: "USD", partyId: null, wbsMilestoneId: null, status: "active",
  ...over,
});
const entry = (over: Partial<CostEntry>): CostEntry => ({
  id: "e1", costAccountId: "a1", projectId: "p1", partyId: null,
  entryType: "actual", amount: 100, entryDate: "2026-07-01",
  description: null, reference: null, status: "posted", sourceDocumentId: null,
  ...over,
});

describe("computeCostRollup", () => {
  it("splits committed / actual / adjustments and derives spent + remaining", () => {
    const r = computeCostRollup(
      [acct({})],
      [
        entry({ id: "e1", entryType: "commitment", amount: 800 }),
        entry({ id: "e2", entryType: "actual", amount: 300 }),
        entry({ id: "e3", entryType: "adjustment", amount: -50 }),
      ],
      new Map(),
    );
    const a = r.accounts[0];
    expect(a.committed).toBe(800);
    expect(a.actual).toBe(300);
    expect(a.adjustments).toBe(-50);
    expect(a.spent).toBe(250);
    // MON-4 / COST-2: remaining is UNCOMMITTED — the 800 commitment is drawn
    // down by the 300 invoiced against it, so 500 stays open.
    expect(a.openCommitments).toBe(500);
    expect(a.exposure).toBe(750);
    expect(a.remaining).toBe(250);
    expect(a.remainingActualsOnly).toBe(750);
    expect(a.overBudget).toBe(false);
    expect(r.budget).toBe(1000);
    expect(r.remaining).toBe(250);
    expect(r.remainingActualsOnly).toBe(750);
  });

  it("void entries count for nothing", () => {
    const r = computeCostRollup(
      [acct({})],
      [entry({ amount: 999, status: "void" })],
      new Map(),
    );
    expect(r.spent).toBe(0);
  });

  it("flags over-budget accounts", () => {
    const r = computeCostRollup([acct({ budget: 100 })], [entry({ amount: 150 })], new Map());
    expect(r.accounts[0].overBudget).toBe(true);
    expect(r.accounts[0].remaining).toBe(-50);
  });

  it("computes earned value + CPI only from milestone-pinned accounts", () => {
    const r = computeCostRollup(
      [
        acct({ id: "a1", budget: 1000, wbsMilestoneId: "m1" }), // 60% done → EV 600
        acct({ id: "a2", budget: 500 }),                        // unpinned → excluded from CPI
      ],
      [
        entry({ id: "e1", costAccountId: "a1", amount: 400 }), // AC 400 on pinned
        entry({ id: "e2", costAccountId: "a2", amount: 500 }), // spend on unpinned
      ],
      new Map([["m1", 60]]),
    );
    expect(r.accounts[0].earnedValue).toBe(600);
    expect(r.accounts[1].earnedValue).toBeNull();
    expect(r.earnedValue).toBe(600);
    expect(r.cpi).toBeCloseTo(1.5); // 600 EV / 400 AC — under-running
  });

  it("CPI is null with no actuals on pinned accounts (no divide-by-zero)", () => {
    const r = computeCostRollup([acct({ wbsMilestoneId: "m1" })], [], new Map([["m1", 50]]));
    expect(r.cpi).toBeNull();
  });

  // ── Round G ──────────────────────────────────────────────────────────────

  it("COST-2 / MON-4: budget 1000, committed 900, spent 0 is at risk — 100 uncommitted, not 1000 remaining", () => {
    const r = computeCostRollup([acct({})], [entry({ entryType: "commitment", amount: 900 })], new Map());
    const a = r.accounts[0];
    expect(a.spent).toBe(0);
    expect(a.openCommitments).toBe(900);
    expect(a.exposure).toBe(900);
    expect(a.remaining).toBe(100);
    expect(a.remainingActualsOnly).toBe(1000);
    expect(a.overBudget).toBe(false);
    expect(r.remaining).toBe(100);
    // one more 200 award and the line is over-committed: overBudget trips on
    // EXPOSURE with nothing invoiced yet.
    const over = computeCostRollup([acct({})], [
      entry({ id: "e1", entryType: "commitment", amount: 900 }),
      entry({ id: "e2", entryType: "commitment", amount: 200, partyId: "p2" }),
    ], new Map());
    expect(over.accounts[0].overBudget).toBe(true);
    expect(over.accounts[0].remaining).toBe(-100);
  });

  it("COST-2: a commitment is drawn down by actuals from the SAME party; another party's invoices do not", () => {
    const r = computeCostRollup([acct({})], [
      entry({ id: "e1", entryType: "commitment", amount: 600, partyId: "sub" }),
      entry({ id: "e2", entryType: "actual", amount: 400, partyId: "sub" }),
      entry({ id: "e3", entryType: "actual", amount: 100, partyId: "other" }),
    ], new Map());
    const a = r.accounts[0];
    expect(a.openCommitments).toBe(200);
    expect(a.exposure).toBe(700);   // 500 spent + 200 still open
    expect(a.remaining).toBe(300);
  });

  it("COST-4: an approved change order revises the budget, and EV/CPI/remaining follow the revised figure", () => {
    // 200k account, 100k approved CO, milestone 50%, 150k of actuals.
    const changes = new Map([["a1", 100_000]]);
    const r = computeCostRollup(
      [acct({ budget: 200_000, wbsMilestoneId: "m1" })],
      [entry({ amount: 150_000 })],
      new Map([["m1", 50]]),
      changes,
    );
    const a = r.accounts[0];
    expect(a.approvedChanges).toBe(100_000);
    expect(a.revisedBudget).toBe(300_000);
    expect(a.account.budget).toBe(200_000);        // the baseline stays visible
    expect(a.earnedValue).toBe(150_000);          // revised × 50%
    expect(r.cpi).toBeCloseTo(1.0);               // was 0.667 against the un-revised baseline
    expect(a.remaining).toBe(150_000);
    expect(a.overBudget).toBe(false);
    expect(r.revisedBudget).toBe(300_000);
    expect(r.approvedChanges).toBe(100_000);
    // The finding's literal shape (200k of actuals at 50%): 0.75 against the
    // revised budget, not the 0.5 the un-revised baseline reported.
    const literal = computeCostRollup([acct({ budget: 200_000, wbsMilestoneId: "m1" })], [entry({ amount: 200_000 })], new Map([["m1", 50]]), changes);
    expect(literal.cpi).toBeCloseTo(0.75);
    expect(literal.accounts[0].overBudget).toBe(false);
  });

  it("COST-1: the rollup exposes the pinned subset's budget and spend beside cpi", () => {
    const r = computeCostRollup(
      [acct({ id: "a1", budget: 1000, wbsMilestoneId: "m1" }), acct({ id: "a2", budget: 500 })],
      [entry({ id: "e1", costAccountId: "a1", amount: 400 }), entry({ id: "e2", costAccountId: "a2", amount: 500 })],
      new Map([["m1", 60]]),
    );
    expect(r.pinnedBudget).toBe(1000);
    expect(r.pinnedSpent).toBe(400);
    expect(r.budget).toBe(1500);
    expect(r.spent).toBe(900);
  });

});

describe("computeForecast — COST-1: CPI applies to the pinned subset only", () => {
  const fmt = (n: number) => `$${Math.round(n)}`;

  it("one pinned + one unpinned account never reports an EAC below what is already spent", () => {
    // The finding's own shape: cpi 1.5 measured on a1 (budget 1000, spent 400);
    // a2 (budget 500) has spent 500 with no pin. Old EAC = 1500 / 1.5 = 1000 < 900 spent.
    const f = computeForecast({ budget: 1500, spent: 900, cpi: 1.5, pinnedBudget: 1000, pinnedSpent: 400, today: "2026-02-01", fmt });
    expect(f.basis).toBe("cpi");
    expect(f.eac).not.toBeNull();
    expect(f.eac as number).toBeGreaterThanOrEqual(900);
    expect(f.eac).toBeCloseTo(1000 / 1.5 + 500);   // pinned by CPI + unpinned at budget (already fully spent)
    expect(f.scopeNote).toContain("67% of budget");
    expect(f.scopeNote).toContain("$1000");
  });

  it("the unpinned remainder is carried at the run-rate when the schedule gives one, and the note says so", () => {
    const f = computeForecast({
      budget: 2000, spent: 600, cpi: 1.0, pinnedBudget: 1000, pinnedSpent: 400,
      scheduleStart: "2026-01-01", scheduleEnd: "2026-03-02", today: "2026-01-31", fmt,
    });
    // pinned: 1000 / 1.0 = 1000; unpinned: 200 spent at 50% elapsed → 400.
    expect(f.eac).toBeCloseTo(1400);
    expect(f.scopeNote).toContain("current spend pace");
  });

  it("every account pinned → the note says CPI covers the whole budget", () => {
    const f = computeForecast({ budget: 1000, spent: 400, cpi: 1.25, pinnedBudget: 1000, pinnedSpent: 400, today: "2026-02-01", fmt });
    expect(f.eac).toBeCloseTo(800);
    expect(f.scopeNote).toContain("whole budget");
  });

  it("without a pinned figure the legacy whole-budget division still applies, floored at spent and labelled", () => {
    const f = computeForecast({ budget: 1500, spent: 900, cpi: 1.5, today: "2026-02-01", fmt });
    expect(f.eac).toBe(1000);
    expect(f.scopeNote).toContain("applied to the whole budget");
    const floored = computeForecast({ budget: 1500, spent: 1400, cpi: 1.5, today: "2026-02-01", fmt });
    expect(floored.eac).toBe(1400);
  });
});

describe("fmtMoney — REL-4 / PERF-10", () => {
  it("never renders $NaN", () => {
    expect(fmtMoney(Number.NaN)).toBe("—");
    expect(fmtMoney(Number.POSITIVE_INFINITY)).toBe("—");
    expect(fmtMoney(12.5, "USD")).toMatch(/12\.50/);
  });

  it("reuses one formatter per currency and precision", () => {
    const Orig = Intl.NumberFormat;
    let constructed = 0;
    // A counting stand-in: the module reads Intl.NumberFormat at call time.
    (Intl as unknown as { NumberFormat: unknown }).NumberFormat = function (this: unknown, ...args: unknown[]) {
      constructed++;
      return new (Orig as unknown as new (...a: unknown[]) => Intl.NumberFormat)(...args);
    };
    try {
      fmtMoney(10, "CHF"); fmtMoney(20, "CHF"); fmtMoney(30, "CHF");
      expect(constructed).toBe(1);
      fmtMoney(50_000, "CHF");           // a different precision bucket — one more
      expect(constructed).toBe(2);
    } finally {
      (Intl as unknown as { NumberFormat: unknown }).NumberFormat = Orig;
    }
  });
});

describe("milestonePctIndex", () => {
  it("uses explicit percent, falls back to status", () => {
    const idx = milestonePctIndex([
      { id: "m1", percentComplete: 42.4 },
      { id: "m2", status: "completed" },
      { id: "m3", status: "planned" },
    ]);
    expect(idx.get("m1")).toBe(42);
    expect(idx.get("m2")).toBe(100);
    expect(idx.get("m3")).toBe(0);
  });
});
