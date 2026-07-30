import { describe, it, expect } from "vitest";
import { computeCostRollup, milestonePctIndex, type CostAccount, type CostEntry } from "@/lib/costs";

const acct = (over: Partial<CostAccount>): CostAccount => ({
  id: "a1", projectId: "p1", code: "01", name: "Piping", costType: "subcontract",
  budget: 1000, currency: "USD", partyId: null, wbsMilestoneId: null, status: "active",
  ...over,
});
const entry = (over: Partial<CostEntry>): CostEntry => ({
  id: "e1", costAccountId: "a1", projectId: "p1", partyId: null,
  entryType: "actual", amount: 100, entryDate: "2026-07-01",
  description: null, reference: null, status: "posted",
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
    expect(a.remaining).toBe(750);
    expect(a.overBudget).toBe(false);
    expect(r.budget).toBe(1000);
    expect(r.remaining).toBe(750);
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
