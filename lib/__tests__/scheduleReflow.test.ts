// Tests for the on-the-fly reschedule engine. These pin down the
// field scenarios the user described:
//   - drag a parent → whole series moves
//   - drag 3 of 10 sub-items early → only those move, parent bleeds,
//     the other 7 stay on the plan
//   - cleaning-crew holdup → pull some forward, push others back

import { describe, it, expect } from "vitest";
import { computeTreeMove, previewMove, defaultMoveMode, type ReflowNode } from "@/lib/scheduleReflow";

const iso = (d: string) => `${d}T00:00:00.000Z`;
function find(changes: { id: string; plannedStartAt: string; plannedAt: string }[], id: string) {
  return changes.find((c) => c.id === id);
}

// Parent P spanning Mon–Wed with three 1-day leaves on Mon, Tue, Wed.
const tree: ReflowNode[] = [
  { id: "P", parentId: null, plannedStartAt: iso("2026-03-02"), plannedAt: iso("2026-03-04") },
  { id: "a", parentId: "P", plannedStartAt: iso("2026-03-02"), plannedAt: iso("2026-03-02") },
  { id: "b", parentId: "P", plannedStartAt: iso("2026-03-03"), plannedAt: iso("2026-03-03") },
  { id: "c", parentId: "P", plannedStartAt: iso("2026-03-04"), plannedAt: iso("2026-03-04") },
];

describe("computeTreeMove", () => {
  it("no-op for zero delta", () => {
    expect(computeTreeMove(tree, "a", 0)).toEqual([]);
  });

  it("dragging the parent moves the whole series together", () => {
    const ch = computeTreeMove(tree, "P", -1); // one day earlier
    // All four rows shift by -1 day.
    expect(ch).toHaveLength(4);
    expect(find(ch, "a")!.plannedAt).toBe(iso("2026-03-01"));
    expect(find(ch, "b")!.plannedAt).toBe(iso("2026-03-02"));
    expect(find(ch, "c")!.plannedAt).toBe(iso("2026-03-03"));
    expect(find(ch, "P")!.plannedStartAt).toBe(iso("2026-03-01"));
    expect(find(ch, "P")!.plannedAt).toBe(iso("2026-03-03"));
  });

  it("dragging one leaf earlier moves ONLY it; siblings stay; parent bleeds", () => {
    // Representative of "did the first part early, come back for the rest":
    // pull 'a' (the first item) a week early. 'b' and 'c' stay on plan.
    const ch = computeTreeMove(tree, "a", -7);
    expect(find(ch, "b")).toBeUndefined();
    expect(find(ch, "c")).toBeUndefined();
    expect(find(ch, "a")!.plannedAt).toBe(iso("2026-02-23"));
    // Parent now spans from the early 'a' through the still-planned 'c'.
    expect(find(ch, "P")!.plannedStartAt).toBe(iso("2026-02-23"));
    expect(find(ch, "P")!.plannedAt).toBe(iso("2026-03-04")); // finish unchanged
  });

  it("moving an interior leaf within the envelope does NOT change the parent", () => {
    // Tree with slack: items on Mon, Wed, Fri inside a Mon–Fri parent.
    const slack: ReflowNode[] = [
      { id: "P", parentId: null, plannedStartAt: iso("2026-03-02"), plannedAt: iso("2026-03-06") },
      { id: "mon", parentId: "P", plannedStartAt: iso("2026-03-02"), plannedAt: iso("2026-03-02") },
      { id: "wed", parentId: "P", plannedStartAt: iso("2026-03-04"), plannedAt: iso("2026-03-04") },
      { id: "fri", parentId: "P", plannedStartAt: iso("2026-03-06"), plannedAt: iso("2026-03-06") },
    ];
    // Move the Wed item to Thu — still strictly inside Mon..Fri.
    const ch = computeTreeMove(slack, "wed", 1);
    expect(find(ch, "wed")!.plannedAt).toBe(iso("2026-03-05"));
    expect(find(ch, "P")).toBeUndefined(); // envelope unchanged
    expect(find(ch, "mon")).toBeUndefined();
    expect(find(ch, "fri")).toBeUndefined();
  });

  it("holdup scenario: pull one forward and push another back, independently", () => {
    // Jump ahead on 'a' (3 days early); separately push held-up 'c' 3 days late.
    const early = computeTreeMove(tree, "a", -3);
    expect(find(early, "a")!.plannedAt).toBe(iso("2026-02-27"));
    expect(find(early, "b")).toBeUndefined();
    expect(find(early, "c")).toBeUndefined();
    expect(find(early, "P")!.plannedStartAt).toBe(iso("2026-02-27"));

    const late = computeTreeMove(tree, "c", 3);
    expect(find(late, "c")!.plannedAt).toBe(iso("2026-03-07"));
    expect(find(late, "a")).toBeUndefined();
    expect(find(late, "P")!.plannedAt).toBe(iso("2026-03-07"));
  });

  it("multi-day leaf keeps its own duration when moved", () => {
    const t2: ReflowNode[] = [
      { id: "P", parentId: null, plannedStartAt: iso("2026-03-02"), plannedAt: iso("2026-03-06") },
      { id: "x", parentId: "P", plannedStartAt: iso("2026-03-02"), plannedAt: iso("2026-03-04") }, // 3-day
    ];
    const ch = computeTreeMove(t2, "x", 2);
    expect(find(ch, "x")!.plannedStartAt).toBe(iso("2026-03-04"));
    expect(find(ch, "x")!.plannedAt).toBe(iso("2026-03-06")); // still 3 days
  });

  it("reflows multiple ancestor levels", () => {
    const deep: ReflowNode[] = [
      { id: "root", parentId: null,   plannedStartAt: iso("2026-03-02"), plannedAt: iso("2026-03-03") },
      { id: "mid",  parentId: "root", plannedStartAt: iso("2026-03-02"), plannedAt: iso("2026-03-03") },
      { id: "leaf", parentId: "mid",  plannedStartAt: iso("2026-03-03"), plannedAt: iso("2026-03-03") },
    ];
    const ch = computeTreeMove(deep, "leaf", 5); // push leaf out
    expect(find(ch, "leaf")!.plannedAt).toBe(iso("2026-03-08"));
    expect(find(ch, "mid")!.plannedAt).toBe(iso("2026-03-08"));
    expect(find(ch, "root")!.plannedAt).toBe(iso("2026-03-08"));
  });
});

describe("defer vs extend", () => {
  // A 3-day task: Mon→Wed.
  const task: ReflowNode[] = [
    { id: "t", parentId: null, plannedStartAt: iso("2026-03-02"), plannedAt: iso("2026-03-04") },
  ];

  it("defer slides start AND finish (duration unchanged)", () => {
    const ch = computeTreeMove(task, "t", 2, "defer");
    expect(find(ch, "t")!.plannedStartAt).toBe(iso("2026-03-04"));
    expect(find(ch, "t")!.plannedAt).toBe(iso("2026-03-06"));
  });

  it("extend moves finish only (duration grows)", () => {
    const ch = computeTreeMove(task, "t", 2, "extend");
    expect(find(ch, "t")!.plannedStartAt).toBe(iso("2026-03-02")); // start stays
    expect(find(ch, "t")!.plannedAt).toBe(iso("2026-03-06"));      // finish +2
  });

  it("defaultMoveMode: in-progress slipping later = extend; else defer; earlier = defer", () => {
    expect(defaultMoveMode("in_progress", 1)).toBe("extend");
    expect(defaultMoveMode("in_progress", -1)).toBe("defer");
    expect(defaultMoveMode("on_hold", 1)).toBe("defer");
    expect(defaultMoveMode("planned", 2)).toBe("defer");
    expect(defaultMoveMode(undefined, 1)).toBe("defer");
  });

  it("previewMove reports the duration impact", () => {
    const defer = previewMove(task, "t", 2, "defer");
    expect(defer.addsDuration).toBe(false);
    expect(defer.durationDaysBefore).toBe(3);
    expect(defer.durationDaysAfter).toBe(3);

    const extend = previewMove(task, "t", 2, "extend");
    expect(extend.addsDuration).toBe(true);
    expect(extend.durationDaysBefore).toBe(3);
    expect(extend.durationDaysAfter).toBe(5);
  });
});
