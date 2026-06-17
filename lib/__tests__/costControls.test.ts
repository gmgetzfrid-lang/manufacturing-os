// lib/__tests__/costControls.test.ts
//
// Freezes the multi-contractor cost rollup — budgets + ledger → EVM at the
// account, party (OBS) and cost-type levels, and a project total. These are the
// numbers a controls manager reports per contractor, so the rollup and the
// per-level CPI/SPI are pinned to a hand-computed scenario.

import { describe, it, expect } from "vitest";
import {
  computeCostRollup, buildScheduleProgressMap, isMissingRelation, type ScheduleProgress,
} from "@/lib/costControls";
import type { CostAccount, CostEntry, Milestone } from "@/types/schema";

const acct = (over: Partial<CostAccount>): CostAccount => ({
  orgId: "o", projectId: "p", name: "A", costType: "labor", budget: 0, ...over,
});
const entry = (over: Partial<CostEntry>): CostEntry => ({
  orgId: "o", projectId: "p", costAccountId: "x", entryType: "actual", amount: 0, ...over,
});

// Two contractors. Acme: labor 100k + material 50k on phase m1. Volt: a 200k
// subcontract on phase m2.
const accounts: CostAccount[] = [
  acct({ id: "A1", partyId: "acme", costType: "labor", budget: 100_000, wbsMilestoneId: "m1" }),
  acct({ id: "A2", partyId: "acme", costType: "material", budget: 50_000, wbsMilestoneId: "m1" }),
  acct({ id: "A3", partyId: "volt", costType: "subcontract", budget: 200_000, wbsMilestoneId: "m2" }),
];
const entries: CostEntry[] = [
  entry({ costAccountId: "A1", entryType: "actual", amount: 60_000 }),
  entry({ costAccountId: "A1", entryType: "commitment", amount: 90_000 }),
  entry({ costAccountId: "A3", entryType: "actual", amount: 40_000 }),
  entry({ costAccountId: "A3", entryType: "commitment", amount: 180_000 }),
];
const progress = new Map<string, ScheduleProgress>([
  ["m1", { percentComplete: 0.5, scheduledFraction: 0.6 }],
  ["m2", { percentComplete: 0.25, scheduledFraction: 0.3 }],
]);
const partyNames = new Map([["acme", "Acme Mechanical"], ["volt", "Volt Electric"]]);

describe("computeCostRollup — project totals", () => {
  const r = computeCostRollup(accounts, entries, { progressByMilestone: progress, partyNames });
  it("sums budget / EV / PV / actual / committed across accounts", () => {
    expect(r.totalBudget).toBe(350_000);
    expect(r.totalEv).toBe(125_000);     // 50k + 25k + 50k
    expect(r.totalPv).toBe(150_000);     // 60k + 30k + 60k
    expect(r.totalActual).toBe(100_000); // 60k + 40k
    expect(r.totalCommitted).toBe(270_000);
    expect(r.uncommitted).toBe(80_000);  // BAC − committed
  });
  it("project EVM: under budget on cost, behind on schedule", () => {
    expect(r.result.cpi).toBe(1.25);     // EV 125k / AC 100k
    expect(r.result.spi).toBe(0.83);     // EV 125k / PV 150k
    expect(r.hasActuals).toBe(true);
    expect(r.hasAccounts).toBe(true);
  });
});

describe("computeCostRollup — per-contractor (OBS) rollup", () => {
  const r = computeCostRollup(accounts, entries, { progressByMilestone: progress, partyNames });
  it("groups by party, largest budget first, with labels", () => {
    expect(r.byParty.map((p) => p.key)).toEqual(["volt", "acme"]); // 200k before 150k
    const acme = r.byParty.find((p) => p.key === "acme")!;
    expect(acme.label).toBe("Acme Mechanical");
    expect(acme.budget).toBe(150_000);
    expect(acme.actual).toBe(60_000);
    expect(acme.accountCount).toBe(2);
    expect(acme.result.cpi).toBe(1.25);  // EV 75k / AC 60k
  });
  it("a contractor with no actuals has an undefined CPI", () => {
    const noActuals = computeCostRollup(
      [acct({ id: "Z", partyId: "zeta", budget: 10_000, wbsMilestoneId: "m1" })],
      [],
      { progressByMilestone: progress },
    );
    expect(noActuals.byParty[0].result.cpi).toBeNull();
    expect(noActuals.hasActuals).toBe(false);
  });
});

describe("computeCostRollup — per-cost-type (CBS) rollup", () => {
  const r = computeCostRollup(accounts, entries, { progressByMilestone: progress, partyNames });
  it("groups by cost type, largest first", () => {
    expect(r.byCostType.map((c) => c.key)).toEqual(["subcontract", "labor", "material"]);
    expect(r.byCostType.find((c) => c.key === "labor")!.budget).toBe(100_000);
    expect(r.byCostType.find((c) => c.key === "subcontract")!.label).toBe("Subcontract");
  });
});

describe("computeCostRollup — edges", () => {
  it("falls back to overall progress for accounts with no WBS link", () => {
    const r = computeCostRollup(
      [acct({ id: "U", budget: 100_000 })], // no wbsMilestoneId
      [],
      { overallPercent: 0.4, overallScheduled: 0.5 },
    );
    expect(r.byAccount[0].ev).toBe(40_000);
    expect(r.byAccount[0].pv).toBe(50_000);
  });
  it("excludes void entries from the rollup", () => {
    const r = computeCostRollup(
      [acct({ id: "A", budget: 100_000, wbsMilestoneId: "m1" })],
      [
        entry({ costAccountId: "A", entryType: "actual", amount: 50_000, status: "void" }),
        entry({ costAccountId: "A", entryType: "actual", amount: 20_000, status: "posted" }),
      ],
      { progressByMilestone: progress },
    );
    expect(r.totalActual).toBe(20_000);
  });
  it("empty project → zeros, not NaN", () => {
    const r = computeCostRollup([], []);
    expect(r.hasAccounts).toBe(false);
    expect(r.totalBudget).toBe(0);
    expect(r.result.spi).toBeNull();
  });
});

describe("isMissingRelation — pre-migration detection (real DB messages)", () => {
  it("matches PostgREST schema-cache and raw Postgres undefined_table", () => {
    expect(isMissingRelation(new Error("Could not find the table 'public.project_parties' in the schema cache"))).toBe(true);
    expect(isMissingRelation({ message: "Could not find the table 'public.cost_entries' in the schema cache" })).toBe(true);
    expect(isMissingRelation('relation "cost_accounts" does not exist')).toBe(true);
  });
  it("does NOT swallow unrelated errors", () => {
    expect(isMissingRelation(new Error("permission denied for table cost_accounts"))).toBe(false);
    expect(isMissingRelation(new Error("new row violates row-level security policy"))).toBe(false);
    expect(isMissingRelation(null)).toBe(false);
    expect(isMissingRelation(undefined)).toBe(false);
  });
});

describe("buildScheduleProgressMap — schedule → progress map", () => {
  const now = new Date("2026-01-15T00:00:00Z");
  const milestones: Milestone[] = [
    { orgId: "o", id: "done", name: "Done", weight: 1, status: "completed", source: "manual", createdBy: "u",
      plannedStartAt: "2026-01-01", plannedAt: "2026-01-10", percentComplete: 100 },
    { orgId: "o", id: "future", name: "Future", weight: 1, status: "planned", source: "manual", createdBy: "u",
      plannedStartAt: "2026-02-01", plannedAt: "2026-02-10", percentComplete: 0 },
  ];
  it("maps rolled-up percent (0..1) and time-phased schedule fraction", () => {
    const map = buildScheduleProgressMap(milestones, now);
    expect(map.get("done")).toEqual({ percentComplete: 1, scheduledFraction: 1 });
    expect(map.get("future")).toEqual({ percentComplete: 0, scheduledFraction: 0 });
  });
});
