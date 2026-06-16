// lib/__tests__/scheduleProgress.test.ts
//
// Freezes the per-task percent + summary roll-up math. These are the rules the
// scheduling UI and the earned-value metrics both depend on: a leaf's percent
// is reconciled with its status, and a parent's percent/status is a
// duration-weighted roll-up of its leaf descendants (never set directly).

import { describe, it, expect } from "vitest";
import {
  leafPercent, effectiveWeight, clampPercent, deriveSummaryStatus,
  buildProgressIndex, overallPercent, type ProgressNode,
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
