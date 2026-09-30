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
  isLocked, planCascade, type ReflowNode,
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

// PC SCHED-5: cascadeDependents and sequenceSiblings used to test the lock on
// the node they steered only, then shift its whole subtree — so a COMPLETED
// grandchild moved (measured: b1, completed, planned 01-02→01-03, moved nine
// days by cascadeDependents(nodes, ["a"])). They now match computeTreeMove:
// actuals inside a shifted subtree stay put and the parent re-envelopes.
describe("SCHED-5 · an actual one level down never moves", () => {
  it("cascade: a completed child of a pushed successor stays; its parent envelopes it", () => {
    const nodes: ReflowNode[] = [
      { id: "a", parentId: null, plannedStartAt: iso("2026-01-01"), plannedAt: iso("2026-01-10") },
      { id: "b", parentId: null, plannedStartAt: iso("2026-01-02"), plannedAt: iso("2026-01-04"), dependsOn: ["a"] },
      { id: "b1", parentId: "b", plannedStartAt: iso("2026-01-02"), plannedAt: iso("2026-01-03"), status: "completed" },
      { id: "b2", parentId: "b", plannedStartAt: iso("2026-01-04"), plannedAt: iso("2026-01-04"), status: "planned" },
    ];
    const ch = cascadeDependents(nodes, ["a"]);
    expect(find(ch, "b1")).toBeUndefined();                       // the actual is not in the change set
    expect(find(ch, "b2")!.plannedAt).toBe(iso("2026-01-13"));   // the open step moved with its phase
    expect(find(ch, "b")!.plannedStartAt).toBe(iso("2026-01-02")); // phase still covers the done step
    expect(find(ch, "b")!.plannedAt).toBe(iso("2026-01-13"));
  });

  it("sequence: a completed grandchild under a sequenced child stays put", () => {
    const nodes: ReflowNode[] = [
      { id: "P", parentId: null, plannedStartAt: iso("2026-03-02"), plannedAt: iso("2026-03-04") },
      { id: "k1", parentId: "P", plannedStartAt: iso("2026-03-02"), plannedAt: iso("2026-03-02"), status: "planned" },
      { id: "k2", parentId: "P", plannedStartAt: iso("2026-03-02"), plannedAt: iso("2026-03-04") },
      { id: "g1", parentId: "k2", plannedStartAt: iso("2026-03-02"), plannedAt: iso("2026-03-02"), status: "completed" },
      { id: "g2", parentId: "k2", plannedStartAt: iso("2026-03-03"), plannedAt: iso("2026-03-04"), status: "planned" },
    ];
    const ch = sequenceSiblings(nodes, "P");
    expect(find(ch, "g1")).toBeUndefined();                      // the grandchild actual never moves
    expect(find(ch, "g2")!.plannedStartAt).toBe(iso("2026-03-04")); // its open sibling shifted with k2 (+1 day)
  });

  it("a row with an ACTUAL finish (actual_at) is locked whatever its status reads", () => {
    const withActual: ReflowNode = { id: "x", plannedAt: iso("2026-03-02"), status: "in_progress", actualAt: "2026-03-02T15:00:00Z" };
    expect(isLocked(withActual)).toBe(true);
    const nodes: ReflowNode[] = [
      { id: "a", parentId: null, plannedStartAt: iso("2026-03-01"), plannedAt: iso("2026-03-09") },
      { ...withActual, parentId: null, plannedStartAt: iso("2026-03-02"), dependsOn: ["a"] },
    ];
    expect(cascadeDependents(nodes, ["a"])).toEqual([]);
    expect(computeTreeMove(nodes, "x", 3)).toEqual([]);
    expect(computeEdgeResize(nodes, "x", "finish", 2)).toEqual([]);
  });

  it("planCascade reports the locked successor whose link the move broke (held), instead of hiding it", () => {
    const nodes: ReflowNode[] = [
      { id: "a", parentId: null, plannedStartAt: iso("2026-03-01"), plannedAt: iso("2026-03-09") },
      { id: "imp", parentId: null, plannedStartAt: iso("2026-03-03"), plannedAt: iso("2026-03-04"), dependsOn: ["a"], locked: true },
      { id: "done", parentId: null, plannedStartAt: iso("2026-03-20"), plannedAt: iso("2026-03-21"), dependsOn: ["a"], status: "completed" },
    ];
    const plan = planCascade(nodes, ["a"]);
    expect(plan.changes).toEqual([]);
    expect(plan.held).toEqual([{ id: "imp", predecessorId: "a" }]); // 'done' still satisfies the link — not held
  });
});
