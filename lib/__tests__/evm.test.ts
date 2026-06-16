// lib/__tests__/evm.test.ts
//
// Freezes the earned-value math — the core of project controls. These are the
// numbers a controls manager bets a schedule on, so the formulas are pinned to
// a textbook PMP example with hand-computed expectations, plus the divide-by-
// zero and "no actuals yet" edges the live dashboard hits in the real world.

import { describe, it, expect } from "vitest";
import {
  computeEvm, healthOfIndex, deriveEvmFromSchedule, scheduledFraction,
  simulateChangeOrder, formatMoney, parseAmount, type EvmInputs, type CostModel,
} from "@/lib/evm";
import type { Milestone } from "@/types/schema";

// A behind-and-over-budget project — the canonical worked example.
//   BAC 100k · PV 40k · EV 30k · AC 35k
const TEXTBOOK: EvmInputs = { bac: 100_000, pv: 40_000, ev: 30_000, ac: 35_000 };

describe("computeEvm — variances and indices", () => {
  const r = computeEvm(TEXTBOOK);
  it("schedule + cost variances", () => {
    expect(r.sv).toBe(-10_000);   // EV − PV
    expect(r.cv).toBe(-5_000);    // EV − AC
  });
  it("SPI and CPI", () => {
    expect(r.spi).toBe(0.75);     // 30k / 40k
    expect(r.cpi).toBe(0.86);     // 30k / 35k → 0.857 ~ 0.86
  });
  it("progress ratios", () => {
    expect(r.percentComplete).toBe(0.3);   // EV / BAC
    expect(r.percentSpent).toBe(0.35);     // AC / BAC
    expect(r.percentScheduled).toBe(0.4);  // PV / BAC
  });
  it("flags an alert because both indices are below 1.0", () => {
    expect(r.alert).toBe(true);
    expect(r.scheduleHealth).toBe("critical"); // 0.75
    expect(r.costHealth).toBe("critical");     // 0.857 — below the 0.90 line
  });
});

describe("computeEvm — forecasts at completion", () => {
  const r = computeEvm(TEXTBOOK);
  it("EAC by CPI (the headline method)", () => {
    expect(r.eacCpi).toBe(116_666.67);        // BAC / CPI
  });
  it("EAC by budget rate (overrun was a one-off)", () => {
    expect(r.eacBudgetRate).toBe(105_000);    // AC + (BAC − EV)
  });
  it("EAC composite (cost AND schedule drag)", () => {
    // AC + (BAC − EV) / (CPI × SPI) = 35k + 70k / (0.857142 × 0.75)
    expect(r.eacComposite).toBeCloseTo(143_888.89, 1);
  });
  it("ETC and VAC follow the headline EAC", () => {
    expect(r.etc).toBe(81_666.67);            // EAC − AC
    expect(r.vac).toBe(-16_666.67);           // BAC − EAC (forecast overrun)
  });
  it("TCPI — efficiency needed from here on", () => {
    expect(r.tcpiBac).toBe(1.08);             // 70k / 65k → 1.0769
    expect(r.tcpiEac).toBe(0.86);             // 70k / 81.67k
  });
});

describe("computeEvm — missing actual cost keeps cost metrics honestly undefined", () => {
  const r = computeEvm({ bac: 100_000, pv: 40_000, ev: 30_000, ac: null });
  it("schedule side still computes", () => {
    expect(r.spi).toBe(0.75);
    expect(r.sv).toBe(-10_000);
    expect(r.scheduleHealth).toBe("critical");
  });
  it("cost side is null, not faked to zero", () => {
    expect(r.cpi).toBeNull();
    expect(r.cv).toBeNull();
    expect(r.eacCpi).toBeNull();
    expect(r.etc).toBeNull();
    expect(r.tcpiBac).toBeNull();
    expect(r.percentSpent).toBeNull();
    expect(r.costHealth).toBe("unknown");
  });
  it("VAC still falls back to the budget-rate EAC? no — needs AC, so null", () => {
    expect(r.vac).toBeNull();
  });
  it("still alerts on the schedule index alone", () => {
    expect(r.alert).toBe(true);
  });
});

describe("computeEvm — divide-by-zero guards", () => {
  it("PV = 0 ⇒ SPI null (no scheduled work yet)", () => {
    const r = computeEvm({ bac: 100, pv: 0, ev: 0, ac: 0 });
    expect(r.spi).toBeNull();
    expect(r.scheduleHealth).toBe("unknown");
  });
  it("AC = 0 ⇒ CPI null (nothing spent yet)", () => {
    const r = computeEvm({ bac: 100, pv: 50, ev: 40, ac: 0 });
    expect(r.cpi).toBeNull();
    expect(r.cv).toBe(40); // EV − 0 is still a real variance
  });
  it("a healthy project does not alert", () => {
    const r = computeEvm({ bac: 100, pv: 50, ev: 55, ac: 50 });
    expect(r.spi).toBe(1.1);
    expect(r.cpi).toBe(1.1);
    expect(r.alert).toBe(false);
    expect(r.scheduleHealth).toBe("ahead");
    expect(r.costHealth).toBe("ahead");
  });
});

describe("healthOfIndex thresholds", () => {
  it("classifies against the 1.0 line", () => {
    expect(healthOfIndex(1.2)).toBe("ahead");
    expect(healthOfIndex(1.05)).toBe("ahead");
    expect(healthOfIndex(1.0)).toBe("on_track");
    expect(healthOfIndex(0.95)).toBe("watch");
    expect(healthOfIndex(0.9)).toBe("watch");
    expect(healthOfIndex(0.89)).toBe("critical");
    expect(healthOfIndex(null)).toBe("unknown");
  });
});

describe("scheduledFraction — time-phased PV S-curve", () => {
  const now = Date.parse("2026-01-15T00:00:00Z");
  const task = (start: string, finish: string): Milestone => ({
    orgId: "o", name: "t", weight: 1, status: "planned", source: "manual", createdBy: "u",
    plannedStartAt: start, plannedAt: finish,
  });
  it("0 before start, 1 after finish, linear in between", () => {
    expect(scheduledFraction(task("2026-02-01", "2026-02-10"), now)).toBe(0);
    expect(scheduledFraction(task("2026-01-01", "2026-01-10"), now)).toBe(1);
    expect(scheduledFraction(task("2026-01-11", "2026-01-21"), now)).toBeCloseTo(0.4, 5);
  });
  it("zero-duration milestone is a step at its date", () => {
    const ms: Milestone = { orgId: "o", name: "m", weight: 1, status: "planned", source: "manual", createdBy: "u", plannedAt: "2026-01-20" };
    expect(scheduledFraction(ms, now)).toBe(0);
    expect(scheduledFraction({ ...ms, plannedAt: "2026-01-10" }, now)).toBe(1);
  });
});

describe("deriveEvmFromSchedule — schedule + cost model → live EVM", () => {
  const now = new Date("2026-01-15T00:00:00Z");
  // Three 100h leaves at $100/h: A done, B 20% & mid-window, C all future.
  const leaves: Milestone[] = [
    { orgId: "o", id: "a", name: "A", weight: 1, status: "completed", source: "manual", createdBy: "u",
      durationHours: 100, plannedStartAt: "2026-01-01", plannedAt: "2026-01-11", percentComplete: 100 },
    { orgId: "o", id: "b", name: "B", weight: 1, status: "in_progress", source: "manual", createdBy: "u",
      durationHours: 100, plannedStartAt: "2026-01-11", plannedAt: "2026-01-21", percentComplete: 20 },
    { orgId: "o", id: "c", name: "C", weight: 1, status: "planned", source: "manual", createdBy: "u",
      durationHours: 100, plannedStartAt: "2026-02-01", plannedAt: "2026-02-11", percentComplete: 0 },
  ];
  const model: CostModel = { blendedRate: 100, actualCost: 13_000, currency: "USD" };

  it("rolls hours into BAC / PV / EV via the blended rate", () => {
    const s = deriveEvmFromSchedule(leaves, model, { now });
    expect(s.totalHours).toBe(300);
    expect(s.earnedHours).toBe(120);             // 100 + 20 + 0
    expect(s.scheduledHours).toBeCloseTo(140, 5); // 100 + 40 + 0
    expect(s.inputs.bac).toBe(30_000);
    expect(s.inputs.pv).toBeCloseTo(14_000, 2);
    expect(s.inputs.ev).toBe(12_000);
    expect(s.inputs.ac).toBe(13_000);
    expect(s.result.spi).toBe(0.86);   // 12k / 14k
    expect(s.result.cpi).toBe(0.92);   // 12k / 13k
    expect(s.hasActualCost).toBe(true);
  });

  it("excludes summary parents and counts uncosted leaves", () => {
    const withParent: Milestone[] = [
      { orgId: "o", id: "p", name: "Phase", weight: 1, status: "in_progress", source: "manual", createdBy: "u",
        durationHours: 9999, plannedAt: "2026-01-21", isSummary: true },
      ...leaves.map((m) => ({ ...m, parentId: "p" })),
      { orgId: "o", id: "d", name: "No-hours task", weight: 1, status: "planned", source: "manual", createdBy: "u",
        plannedAt: "2026-01-25" },
    ];
    const s = deriveEvmFromSchedule(withParent, model, { now });
    expect(s.costedLeaves).toBe(3);          // a, b, c — NOT the parent
    expect(s.uncostedLeaves).toBe(1);        // d
    expect(s.totalHours).toBe(300);          // parent's 9999h not double-counted
  });

  it("a budget override rescales PV/EV but leaves the indices invariant", () => {
    const s = deriveEvmFromSchedule(leaves, { ...model, budgetOverride: 60_000 }, { now });
    expect(s.inputs.bac).toBe(60_000);
    expect(s.inputs.pv).toBeCloseTo(28_000, 2);
    expect(s.inputs.ev).toBe(24_000);
    expect(s.result.spi).toBe(0.86);                 // unchanged
    expect(s.result.percentComplete).toBe(0.4);      // 120/300 hours done
  });

  it("no actual cost ⇒ schedule-only EVM", () => {
    const s = deriveEvmFromSchedule(leaves, { blendedRate: 100 }, { now });
    expect(s.hasActualCost).toBe(false);
    expect(s.result.cpi).toBeNull();
    expect(s.result.spi).toBe(0.86);
  });

  it("budget override with NO blended rate still yields correct schedule metrics", () => {
    // Regression guard: PV/EV are derived from hour-fractions × BAC, so a pinned
    // budget without a rate must NOT collapse PV/EV to zero (which would falsely
    // read 0% complete / SPI undefined for a half-done project).
    const s = deriveEvmFromSchedule(leaves, { budgetOverride: 500_000, blendedRate: 0 }, { now });
    expect(s.inputs.bac).toBe(500_000);
    expect(s.inputs.ev).toBe(200_000);                 // 0.4 × BAC
    expect(s.inputs.pv).toBeCloseTo(233_333.33, 0);    // 0.4667 × BAC
    expect(s.result.spi).toBe(0.86);
    expect(s.result.percentComplete).toBe(0.4);
  });
});

describe("parseAmount — one money parser that preserves a real zero", () => {
  it("keeps 0, drops empty/garbage, strips separators", () => {
    expect(parseAmount("0")).toBe(0);          // 0 ≠ "unset"
    expect(parseAmount("")).toBeNull();
    expect(parseAmount("   ")).toBeNull();
    expect(parseAmount("abc")).toBeNull();
    expect(parseAmount("1,250")).toBe(1250);
    expect(parseAmount("$2,500")).toBe(2500);
    expect(parseAmount("-5000")).toBe(-5000);  // de-scope / credit
  });
});

describe("simulateChangeOrder — sandbox before touching the baseline", () => {
  it("a pure-budget add raises BAC and the forecast EAC", () => {
    const impact = simulateChangeOrder(TEXTBOOK, { addedBudget: 20_000, scheduleDays: 14 });
    expect(impact.deltaBac).toBe(20_000);
    expect(impact.after.bac).toBe(120_000);
    expect(impact.scheduleDays).toBe(14);
    // New work isn't earned yet, so CPI worsens and EAC climbs.
    expect(impact.after.eacCpi! > impact.before.eacCpi!).toBe(true);
    expect(impact.deltaEac! > 0).toBe(true);
  });
  it("a de-scope credit lowers BAC", () => {
    const impact = simulateChangeOrder(TEXTBOOK, { addedBudget: -10_000 });
    expect(impact.after.bac).toBe(90_000);
    expect(impact.deltaBac).toBe(-10_000);
  });
});

describe("formatMoney — compact tiles", () => {
  it("scales to K / M and carries the symbol", () => {
    expect(formatMoney(1_250)).toBe("$1,250");
    expect(formatMoney(48_000)).toBe("$48K");
    expect(formatMoney(1_200_000)).toBe("$1.2M");
    expect(formatMoney(-5_000)).toBe("-$5,000"); // under the 10K compaction threshold → full
    expect(formatMoney(null)).toBe("—");
    expect(formatMoney(1000, "EUR")).toBe("€1,000");
  });
});
