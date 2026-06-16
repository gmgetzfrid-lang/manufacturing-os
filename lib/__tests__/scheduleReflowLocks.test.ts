// lib/__tests__/scheduleReflowLocks.test.ts
//
// Freezes the "actuals don't move" rule the user asked for — the MS Project /
// Primavera behaviour where completed work is locked in place and only the
// remaining tasks reschedule around it:
//   - drag a parent → incomplete children slide, completed ones stay put
//   - drag a completed task → no-op
//   - a completed predecessor shields its successors from a cascade
//   - sequencing leaves completed steps where they are
//   - a completed task can't be edge-resized

import { describe, it, expect } from "vitest";
import {
  computeTreeMove, cascadeDependents, sequenceSiblings, computeEdgeResize,
  isLocked, type ReflowNode,
} from "@/lib/scheduleReflow";

const iso = (d: string) => `${d}T00:00:00.000Z`;
function find(changes: { id: string; plannedStartAt: string; plannedAt: string }[], id: string) {
  return changes.find((c) => c.id === id);
}

describe("isLocked", () => {
  it("treats completed (or explicitly pinned) nodes as actuals", () => {
    expect(isLocked({ id: "x", plannedAt: iso("2026-03-02"), status: "completed" })).toBe(true);
    expect(isLocked({ id: "x", plannedAt: iso("2026-03-02"), locked: true })).toBe(true);
    expect(isLocked({ id: "x", plannedAt: iso("2026-03-02"), status: "in_progress" })).toBe(false);
    expect(isLocked(undefined)).toBe(false);
  });
});

describe("computeTreeMove respects locked (completed) work", () => {
  // Parent P with three 1-day leaves; the first (a) is already DONE.
  const tree: ReflowNode[] = [
    { id: "P", parentId: null, plannedStartAt: iso("2026-03-02"), plannedAt: iso("2026-03-04") },
    { id: "a", parentId: "P", plannedStartAt: iso("2026-03-02"), plannedAt: iso("2026-03-02"), status: "completed" },
    { id: "b", parentId: "P", plannedStartAt: iso("2026-03-03"), plannedAt: iso("2026-03-03"), status: "in_progress" },
    { id: "c", parentId: "P", plannedStartAt: iso("2026-03-04"), plannedAt: iso("2026-03-04"), status: "planned" },
  ];

  it("dragging the parent slides only the incomplete children; the done one stays", () => {
    const ch = computeTreeMove(tree, "P", 5);
    expect(find(ch, "a")).toBeUndefined();             // completed → pinned
    expect(find(ch, "b")!.plannedAt).toBe(iso("2026-03-08"));
    expect(find(ch, "c")!.plannedAt).toBe(iso("2026-03-09"));
    // Parent still envelopes the done 'a' (03-02) through the slid 'c' (03-09).
    expect(find(ch, "P")!.plannedStartAt).toBe(iso("2026-03-02"));
    expect(find(ch, "P")!.plannedAt).toBe(iso("2026-03-09"));
  });

  it("dragging a completed leaf is a no-op", () => {
    expect(computeTreeMove(tree, "a", 3)).toEqual([]);
  });
});

describe("cascadeDependents shields completed successors", () => {
  // a → b → c, finish-to-start. 'a' has just moved out to 03-07.
  const movedChain = (bStatus: string): ReflowNode[] => [
    { id: "a", parentId: null, plannedStartAt: iso("2026-03-07"), plannedAt: iso("2026-03-07") },
    { id: "b", parentId: null, plannedStartAt: iso("2026-03-03"), plannedAt: iso("2026-03-03"), dependsOn: ["a"], status: bStatus },
    { id: "c", parentId: null, plannedStartAt: iso("2026-03-04"), plannedAt: iso("2026-03-04"), dependsOn: ["b"], status: "planned" },
  ];

  it("pushes the whole incomplete chain forward", () => {
    const ch = cascadeDependents(movedChain("planned"), ["a"]);
    expect(find(ch, "b")!.plannedAt).toBe(iso("2026-03-08")); // day after a
    expect(find(ch, "c")!.plannedAt).toBe(iso("2026-03-09")); // day after b
  });

  it("a completed predecessor stays, and shields its successor", () => {
    const ch = cascadeDependents(movedChain("completed"), ["a"]);
    expect(find(ch, "b")).toBeUndefined(); // done → not moved
    expect(find(ch, "c")).toBeUndefined(); // its driver (b) didn't move
  });
});

describe("sequenceSiblings leaves completed steps in place", () => {
  // Three steps stacked on the same day under P; b is already done.
  const stacked: ReflowNode[] = [
    { id: "P", parentId: null, plannedStartAt: iso("2026-03-02"), plannedAt: iso("2026-03-02") },
    { id: "a", parentId: "P", plannedStartAt: iso("2026-03-02"), plannedAt: iso("2026-03-02"), status: "planned" },
    { id: "b", parentId: "P", plannedStartAt: iso("2026-03-02"), plannedAt: iso("2026-03-02"), status: "completed" },
    { id: "c", parentId: "P", plannedStartAt: iso("2026-03-02"), plannedAt: iso("2026-03-02"), status: "planned" },
  ];

  it("sequences the open steps around the locked one", () => {
    const ch = sequenceSiblings(stacked, "P");
    expect(find(ch, "b")).toBeUndefined(); // completed step never moves
    // c is pushed to the day after the locked b's finish.
    expect(find(ch, "c")!.plannedStartAt).toBe(iso("2026-03-03"));
  });
});

describe("computeEdgeResize can't resize an actual", () => {
  const task: ReflowNode[] = [
    { id: "t", parentId: null, plannedStartAt: iso("2026-03-02"), plannedAt: iso("2026-03-04"), status: "completed" },
  ];
  it("returns no changes for a completed task", () => {
    expect(computeEdgeResize(task, "t", "finish", 2)).toEqual([]);
  });
});
