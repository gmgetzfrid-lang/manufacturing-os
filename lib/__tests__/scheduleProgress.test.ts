// lib/__tests__/scheduleProgress.test.ts
//
// Freezes the per-task percent + summary roll-up math. These are the rules the
// scheduling UI and the earned-value metrics both depend on: a leaf's percent
// is reconciled with its status, and a parent's percent/status is a
// duration-weighted roll-up of its leaf descendants (never set directly).

import { describe, it, expect } from "vitest";
import {
  leafPercent, effectiveWeight, clampPercent, deriveSummaryStatus,
  buildProgressIndex, overallPercent, chooseWeightBasis, weightFor, type ProgressNode,
} from "@/lib/scheduleProgress";

describe("leafPercent — status reconciles the stored value", () => {
  it("completed is always 100, planned always 0", () => {
    expect(leafPercent({ status: "completed", percentComplete: 12 })).toBe(100);
    expect(leafPercent({ status: "planned", percentComplete: 80 })).toBe(0);
  });
  it("in_progress uses the explicit percent", () => {
    expect(leafPercent({ status: "in_progress", percentComplete: 60 })).toBe(60);
    expect(leafPercent({ status: "in_progress", percentComplete: null })).toBe(0);
  });
  it("blocked/on_hold keep their logged progress", () => {
    expect(leafPercent({ status: "blocked", percentComplete: 40 })).toBe(40);
    expect(leafPercent({ status: "on_hold", percentComplete: 25 })).toBe(25);
  });
  it("clamps out-of-range", () => {
    expect(clampPercent(150)).toBe(100);
    expect(clampPercent(-5)).toBe(0);
    expect(clampPercent(33.6)).toBe(34);
  });
});

describe("effectiveWeight — duration first, then weight, then 1", () => {
  it("prefers work hours", () => {
    expect(effectiveWeight({ durationHours: 40, weight: 1 })).toBe(40);
  });
  it("falls back to weight then 1", () => {
    expect(effectiveWeight({ durationHours: null, weight: 3 })).toBe(3);
    expect(effectiveWeight({})).toBe(1);
    expect(effectiveWeight({ durationHours: 0, weight: 0 })).toBe(1);
  });
});

describe("deriveSummaryStatus", () => {
  it("all done = completed; empty = planned", () => {
    expect(deriveSummaryStatus({ total: 3, done: 3, blocked: 0, onHold: 0, started: 3 })).toBe("completed");
    expect(deriveSummaryStatus({ total: 0, done: 0, blocked: 0, onHold: 0, started: 0 })).toBe("planned");
  });
  it("blocked and on-hold bubble up; started = in progress", () => {
    expect(deriveSummaryStatus({ total: 4, done: 1, blocked: 1, onHold: 0, started: 2 })).toBe("blocked");
    expect(deriveSummaryStatus({ total: 4, done: 1, blocked: 0, onHold: 1, started: 2 })).toBe("on_hold");
    expect(deriveSummaryStatus({ total: 4, done: 0, blocked: 0, onHold: 0, started: 1 })).toBe("in_progress");
    expect(deriveSummaryStatus({ total: 4, done: 0, blocked: 0, onHold: 0, started: 0 })).toBe("planned");
  });
});

describe("buildProgressIndex — leaves report own %, parents roll up weighted", () => {
  // Phase P with two leaves: a (10h, 100%) and b (30h, 0%).
  // Duration-weighted: (10*100 + 30*0) / 40 = 25%.
  const tree: ProgressNode[] = [
    { id: "P", parentId: null, status: "in_progress" },
    { id: "a", parentId: "P", status: "completed", durationHours: 10 },
    { id: "b", parentId: "P", status: "planned", durationHours: 30 },
  ];

  it("weights the parent by duration, not a flat count", () => {
    const idx = buildProgressIndex(tree);
    expect(idx.get("a")!.percent).toBe(100);
    expect(idx.get("b")!.percent).toBe(0);
    expect(idx.get("P")!.percent).toBe(25);     // duration-weighted, not 50
    expect(idx.get("P")!.isLeaf).toBe(false);
    expect(idx.get("P")!.leafDone).toBe(1);
    expect(idx.get("P")!.leafTotal).toBe(2);
    expect(idx.get("P")!.status).toBe("in_progress");
  });

  it("a partially-complete leaf contributes its fraction", () => {
    const idx = buildProgressIndex([
      { id: "P", parentId: null, status: "planned" },
      { id: "a", parentId: "P", status: "in_progress", percentComplete: 50, durationHours: 10 },
      { id: "b", parentId: "P", status: "in_progress", percentComplete: 50, durationHours: 10 },
    ]);
    expect(idx.get("P")!.percent).toBe(50);
    expect(idx.get("P")!.status).toBe("in_progress");
  });

  it("rolls up through multiple levels", () => {
    const idx = buildProgressIndex([
      { id: "root", parentId: null, status: "planned" },
      { id: "mid", parentId: "root", status: "planned" },
      { id: "l1", parentId: "mid", status: "completed", durationHours: 1 },
      { id: "l2", parentId: "mid", status: "completed", durationHours: 1 },
      { id: "l3", parentId: "root", status: "planned", durationHours: 2 },
    ]);
    expect(idx.get("mid")!.percent).toBe(100);
    // root: (1*100 + 1*100 + 2*0) / 4 = 50
    expect(idx.get("root")!.percent).toBe(50);
  });

  it("a fully-complete phase derives completed", () => {
    const idx = buildProgressIndex([
      { id: "P", parentId: null, status: "in_progress" },
      { id: "a", parentId: "P", status: "completed" },
      { id: "b", parentId: "P", status: "completed" },
    ]);
    expect(idx.get("P")!.percent).toBe(100);
    expect(idx.get("P")!.status).toBe("completed");
  });
});

describe("overallPercent — duration-weighted over leaves only", () => {
  it("ignores summary rows so they don't double-count", () => {
    const pct = overallPercent([
      { id: "P", parentId: null, status: "in_progress" },          // summary — excluded
      { id: "a", parentId: "P", status: "completed", durationHours: 10 },
      { id: "b", parentId: "P", status: "planned", durationHours: 30 },
    ]);
    expect(pct).toBe(25);
  });
  it("empty schedule is 0", () => {
    expect(overallPercent([])).toBe(0);
  });
});

// PT SAF-8: a task completed at 100% and later re-classified Missed kept its
// full earned value (leafPercent returned the stored percent for missed).
// Missed now earns nothing — in leafPercent, so it holds for imported rows
// too — while the stored percent is kept (un-missing gives it back).
describe("SAF-8 · a missed task contributes no earned value", () => {
  it("leafPercent(missed) is 0 whatever percent is stored; blocked / on_hold keep theirs", () => {
    expect(leafPercent({ status: "missed", percentComplete: 100 })).toBe(0);
    expect(leafPercent({ status: "missed", percentComplete: 40 })).toBe(0);
    expect(leafPercent({ status: "blocked", percentComplete: 40 })).toBe(40);
  });
  it("the 100%-then-missed transition: EV drops to zero, and the Missed count and the EV rollup agree", async () => {
    const { computeScheduleMetrics } = await import("@/lib/milestones");
    const base = { orgId: "o", name: "t", weight: 1, plannedAt: "2026-03-01T00:00:00Z", source: "manual" as const, createdBy: "u" };
    const done = [{ ...base, id: "a", status: "completed" as const, percentComplete: 100 }, { ...base, id: "b", status: "planned" as const }];
    const missed = [{ ...base, id: "a", status: "missed" as const, percentComplete: 100 }, { ...base, id: "b", status: "planned" as const }];
    const now = new Date("2026-03-05T00:00:00Z");
    expect(computeScheduleMetrics(done, { now }).earnedValue).toBe(1);
    const m = computeScheduleMetrics(missed, { now });
    expect(m.byStatus.missed).toBe(1);
    expect(m.earnedValue).toBe(0);
    expect(overallPercent(missed)).toBe(0);
    const idx = buildProgressIndex([{ id: "P", parentId: null, status: "planned" }, ...missed.map((x) => ({ ...x, parentId: "P" }))]);
    expect(idx.get("a")!.percent).toBe(0);
    expect(idx.get("P")!.percent).toBe(0);
  });
});

// PC SCHED-7: an all-missed phase used to roll up as "planned, 0%" — missed
// was the one exception state that never bubbled.
describe("SCHED-7 · missed bubbles up, ranked after blocked and before on hold", () => {
  it("an all-missed phase reads missed, not planned", () => {
    const idx = buildProgressIndex([
      { id: "P", parentId: null, status: "planned" },
      { id: "k1", parentId: "P", status: "missed" },
      { id: "k2", parentId: "P", status: "missed" },
    ]);
    expect(idx.get("P")).toMatchObject({ status: "missed", percent: 0, leafDone: 0, leafTotal: 2 });
  });
  it("one missed leaf among open work surfaces the phase as missed; blocked outranks it; it outranks on hold", () => {
    expect(deriveSummaryStatus({ total: 4, done: 1, blocked: 0, onHold: 1, started: 2, missed: 1 })).toBe("missed");
    expect(deriveSummaryStatus({ total: 4, done: 1, blocked: 1, onHold: 0, started: 2, missed: 1 })).toBe("blocked");
    expect(deriveSummaryStatus({ total: 3, done: 0, blocked: 0, onHold: 0, started: 0, missed: 3 })).toBe("missed");
    expect(deriveSummaryStatus({ total: 3, done: 0, blocked: 0, onHold: 0, started: 0 })).toBe("planned"); // callers without the tally are unchanged
  });
  it("the rollup carries through two levels", () => {
    const idx = buildProgressIndex([
      { id: "root", parentId: null, status: "planned" },
      { id: "mid", parentId: "root", status: "planned" },
      { id: "l1", parentId: "mid", status: "missed" },
      { id: "l2", parentId: "root", status: "in_progress", percentComplete: 20 },
    ]);
    expect(idx.get("mid")!.status).toBe("missed");
    expect(idx.get("root")!.status).toBe("missed");
  });
});

// PC SCHED-14: effectiveWeight resolved per node, so a list mixing work
// hours and unit weights summed incompatible units — tagging eight tasks with
// 40 h among 392 unit-weight rows put 45% of the project on 2% of the tasks.
describe("SCHED-14 · one weighting basis per list", () => {
  it("hours only when EVERY leaf has them; otherwise weight for all", () => {
    expect(chooseWeightBasis([{ id: "a", status: "planned", durationHours: 40 }, { id: "b", status: "planned", durationHours: 2 }])).toBe("hours");
    expect(chooseWeightBasis([{ id: "a", status: "planned", durationHours: 40 }, { id: "b", status: "planned", weight: 1 }])).toBe("weight");
    // summaries never decide it
    expect(chooseWeightBasis([{ id: "P", parentId: null, status: "planned" }, { id: "a", parentId: "P", status: "planned", durationHours: 8 }])).toBe("hours");
    expect(chooseWeightBasis([])).toBe("weight");
  });
  it("a mixed list rolls up on the uniform weight basis, not a hours/unit blend", () => {
    // 8 tasks tagged 40 h (done) + 392 untagged unit-weight tasks (not started).
    const mixed: ProgressNode[] = [
      ...Array.from({ length: 8 }, (_, i) => ({ id: `h${i}`, status: "completed" as const, durationHours: 40, weight: 1 })),
      ...Array.from({ length: 392 }, (_, i) => ({ id: `w${i}`, status: "planned" as const, weight: 1 })),
    ];
    expect(overallPercent(mixed)).toBe(2);   // 8 of 400 tasks — was 45 under the blend
    expect(weightFor({ durationHours: 40, weight: 1 }, "weight")).toBe(1);
    expect(weightFor({ durationHours: 40, weight: 1 }, "hours")).toBe(40);
    expect(weightFor({ weight: 0 }, "weight")).toBe(1);
  });
  it("computeScheduleMetrics reports its basis and uses it", async () => {
    const { computeScheduleMetrics } = await import("@/lib/milestones");
    const base = { orgId: "o", name: "t", weight: 1, plannedAt: "2026-03-01T00:00:00Z", source: "manual" as const, createdBy: "u", status: "planned" as const };
    const m = computeScheduleMetrics([{ ...base, id: "a", durationHours: 40 }, { ...base, id: "b" }]);
    expect(m.weightBasis).toBe("weight");
    expect(m.totalWeight).toBe(2);
    const h = computeScheduleMetrics([{ ...base, id: "a", durationHours: 40 }, { ...base, id: "b", durationHours: 10 }]);
    expect(h.weightBasis).toBe("hours");
    expect(h.totalWeight).toBe(50);
  });
});
