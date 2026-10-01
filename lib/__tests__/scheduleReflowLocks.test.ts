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
  computeTreeMove, cascadeDependents, sequenceSiblings, computeEdgeResize, computeSummaryResize,
  reflowAllAncestors, reflowNodesFromMilestones, isLocked, planCascade, CascadeRefusedError, type ReflowNode,
} from "@/lib/scheduleReflow";
import type { Milestone } from "@/types/schema";

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

// PT SCH-13 (review): the engines treated imported LEAVES as locked but still
// re-enveloped imported PARENTS — every parent in the tree, not just the drag's
// ancestors — so an imported summary whose stored span differs from its
// children's (MS Project summaries often do; a row left "not in this file"
// under its old phase; a manual task grouped under an imported phase) landed
// in the change set of EVERY move, and applyMilestoneMoves then refused the
// whole batch. A locked parent now keeps its stored dates in every engine and
// is never in a change set; so does a parent with an actual (PC SCHED-5).
describe("SCH-13 · no engine ever writes an imported (or otherwise locked) parent", () => {
  const t = (s: string) => `${s}:00.000Z`;
  const mk = (o: Partial<Milestone>): Milestone => ({
    orgId: "o", name: o.id ?? "t", weight: 1, plannedAt: t("2026-03-10T17:00"), status: "planned", source: "manual", createdBy: "u", ...o,
  });
  // An MS Project summary IP stored 03-01 08:00 → 03-10 17:00 whose children end 03-09 17:00,
  // and an unrelated manual task m.
  const mismatched = (): Milestone[] => [
    mk({ id: "IP", source: "msproject", isSummary: true, plannedStartAt: t("2026-03-01T08:00"), plannedAt: t("2026-03-10T17:00") }),
    mk({ id: "i1", source: "msproject", parentId: "IP", plannedStartAt: t("2026-03-01T08:00"), plannedAt: t("2026-03-05T17:00") }),
    mk({ id: "i2", source: "msproject", parentId: "IP", plannedStartAt: t("2026-03-06T08:00"), plannedAt: t("2026-03-09T17:00") }),
    mk({ id: "m", plannedStartAt: t("2026-04-01T08:00"), plannedAt: t("2026-04-02T17:00") }),
  ];

  it("the reviewer's probe: dragging an unrelated manual task writes that task alone", () => {
    const ch = computeTreeMove(reflowNodesFromMilestones(mismatched()), "m", 2);
    expect(ch.map((c) => c.id)).toEqual(["m"]); // was [IP, m] — and the batch was refused whole
    expect(ch[0].plannedStartAt).toBe(t("2026-04-03T08:00"));
  });

  it("a manual task under an imported phase moves past the phase's finish; the phase keeps the tool's dates", () => {
    const list = [...mismatched(), mk({ id: "mc", parentId: "IP", plannedStartAt: t("2026-03-08T08:00"), plannedAt: t("2026-03-09T17:00") })];
    const nodes = reflowNodesFromMilestones(list);
    expect(computeTreeMove(nodes, "mc", 5).map((c) => c.id)).toEqual(["mc"]);
    expect(computeEdgeResize(nodes, "mc", "finish", 5).map((c) => c.id)).toEqual(["mc"]);
    // a cascade from a manual predecessor into it
    const withLink = reflowNodesFromMilestones([...list.map((m) => (m.id === "mc" ? { ...m, dependsOn: ["m0"] } : m)),
      mk({ id: "m0", plannedStartAt: t("2026-03-01T08:00"), plannedAt: t("2026-03-12T17:00") })]);
    const plan = planCascade(withLink, ["m0"]);
    expect(plan.changes.map((c) => c.id)).toEqual(["mc"]);
    expect(plan.changes[0].plannedStartAt).toBe(t("2026-03-13T08:00"));
  });

  it("sequencing and a summary resize write only manual rows, whatever imported summary sits elsewhere", () => {
    const list = [
      ...mismatched(),
      mk({ id: "P", isSummary: true, plannedStartAt: t("2026-05-01T08:00"), plannedAt: t("2026-05-03T17:00") }),
      mk({ id: "p1", parentId: "P", plannedStartAt: t("2026-05-01T08:00"), plannedAt: t("2026-05-02T17:00") }),
      mk({ id: "p2", parentId: "P", plannedStartAt: t("2026-05-01T08:00"), plannedAt: t("2026-05-03T17:00") }),
    ];
    const nodes = reflowNodesFromMilestones(list);
    const seq = sequenceSiblings(nodes, "P").map((c) => c.id).sort();
    expect(seq).toEqual(["P", "p2"]);
    const resize = computeSummaryResize(nodes, "P", "finish", 2).map((c) => c.id);
    expect(resize).not.toContain("IP");
    expect(resize).toContain("P");
  });

  it("reflowAllAncestors (setTaskDuration's pass) keeps an imported parent and a parent with an actual; a manual one follows", () => {
    const nodes: ReflowNode[] = [
      { id: "IP", plannedStartAt: t("2026-03-01T08:00"), plannedAt: t("2026-03-10T17:00"), locked: true },
      { id: "x", parentId: "IP", plannedStartAt: t("2026-02-20T08:00"), plannedAt: t("2026-03-02T17:00") },
      { id: "AP", plannedStartAt: t("2026-03-01T08:00"), plannedAt: t("2026-03-10T17:00"), actualAt: t("2026-03-10T17:00") },
      { id: "y", parentId: "AP", plannedStartAt: t("2026-02-20T08:00"), plannedAt: t("2026-03-02T17:00") },
      { id: "MP", plannedStartAt: t("2026-03-01T08:00"), plannedAt: t("2026-03-10T17:00") },
      { id: "z", parentId: "MP", plannedStartAt: t("2026-02-20T08:00"), plannedAt: t("2026-03-02T17:00") },
    ];
    expect(reflowAllAncestors(nodes)).toEqual([{ id: "MP", plannedStartAt: t("2026-02-20T08:00"), plannedAt: t("2026-03-02T17:00") }]);
  });

  it("a manual phase above an imported one envelopes the imported phase's stored dates (a locked phase is a fixed box)", () => {
    const nodes: ReflowNode[] = [
      { id: "G", plannedStartAt: t("2026-02-01T08:00"), plannedAt: t("2026-02-02T17:00") },
      { id: "IP", parentId: "G", plannedStartAt: t("2026-03-01T08:00"), plannedAt: t("2026-03-10T17:00"), locked: true },
      { id: "k", parentId: "IP", plannedStartAt: t("2026-03-01T08:00"), plannedAt: t("2026-03-04T17:00"), locked: true },
    ];
    expect(reflowAllAncestors(nodes)).toEqual([{ id: "G", plannedStartAt: t("2026-03-01T08:00"), plannedAt: t("2026-03-10T17:00") }]);
  });
});

// PC SCHED-5 (fourth review pass): a LOCKED phase is never re-enveloped, so
// it never entered the cascade's seeds — a successor linked to the phase was
// silently not pushed when a task inside it moved past its finish, and was not
// reported as held either. The phase row is locked when the board's bulk
// "Done" stamps it completed + actual_at and a child is later reopened. At
// fdb51b1 the phase was re-enveloped and its successor pushed to 06-09 → 06-11.
describe("SCHED-5 · a locked phase's finish-to-start links are still honoured", () => {
  // The move exactly as the board writes it (ExecutionView withCascade): the
  // tree move, then the cascade over the moved nodes.
  const flow = (nodes: ReflowNode[], id: string, delta: number) => {
    const primary = computeTreeMove(nodes, id, delta, "defer");
    const byId = new Map(primary.map((c) => [c.id, c]));
    const updated = nodes.map((n) => (byId.has(n.id) ? { ...n, plannedStartAt: byId.get(n.id)!.plannedStartAt, plannedAt: byId.get(n.id)!.plannedAt } : n));
    return { primary, plan: planCascade(updated, primary.map((c) => c.id)) };
  };
  const probe = (): ReflowNode[] => [
    { id: "P", plannedStartAt: iso("2026-06-01"), plannedAt: iso("2026-06-05"), status: "completed", actualAt: iso("2026-06-05") },
    { id: "C1", parentId: "P", plannedStartAt: iso("2026-06-01"), plannedAt: iso("2026-06-03"), status: "in_progress" },
    { id: "C2", parentId: "P", plannedStartAt: iso("2026-06-04"), plannedAt: iso("2026-06-05"), status: "completed" },
    { id: "S", plannedStartAt: iso("2026-06-06"), plannedAt: iso("2026-06-08"), dependsOn: ["P"] },
  ];

  it("the reviewer's probe: C1 dragged +5 d past its completed phase pushes the phase's successor; the phase is not written", () => {
    const { primary, plan } = flow(probe(), "C1", 5);
    expect(primary.map((c) => c.id)).toEqual(["C1"]); // the locked phase keeps its stored dates
    expect(plan.changes).toEqual([{ id: "S", plannedStartAt: iso("2026-06-09"), plannedAt: iso("2026-06-11") }]); // was []
    expect(plan.held).toEqual([]);
  });

  it("a locked successor of the phase is reported in held instead (imported, or done)", () => {
    for (const lock of [{ locked: true }, { status: "completed" }]) {
      const nodes = probe().map((n) => (n.id === "S" ? { ...n, ...lock } : n));
      const { plan } = flow(nodes, "C1", 5);
      expect(plan.changes).toEqual([]);
      expect(plan.held).toEqual([{ id: "S", predecessorId: "P" }]); // was [] — nothing warned
    }
  });

  it("a move that stays inside the phase's stored finish pushes nothing", () => {
    const { plan } = flow(probe(), "C1", 1); // C1 → 06-02..06-04, still inside 06-05
    expect(plan.changes).toEqual([]);
    expect(plan.held).toEqual([]);
  });

  it("an unlocked phase above the locked one waits for the task inside both (the locked phase is a fixed box, not a lid)", () => {
    const nodes: ReflowNode[] = [
      { id: "G", plannedStartAt: iso("2026-06-01"), plannedAt: iso("2026-06-05") },
      { id: "IP", parentId: "G", plannedStartAt: iso("2026-06-01"), plannedAt: iso("2026-06-05"), locked: true },
      { id: "mc", parentId: "IP", plannedStartAt: iso("2026-06-04"), plannedAt: iso("2026-06-05") },
      { id: "S", plannedStartAt: iso("2026-06-08"), plannedAt: iso("2026-06-09"), dependsOn: ["G"] },
    ];
    const { primary, plan } = flow(nodes, "mc", 4); // mc → 06-08..06-09
    expect(primary.map((c) => c.id)).toEqual(["mc"]); // G envelopes IP's stored box (unchanged); IP is never written
    expect(find(plan.changes, "S")).toEqual({ id: "S", plannedStartAt: iso("2026-06-10"), plannedAt: iso("2026-06-11") });
  });

  it("a task the cascade pushes inside a phase makes the phase's successors look again", () => {
    const nodes: ReflowNode[] = [
      { id: "X", plannedStartAt: iso("2026-06-01"), plannedAt: iso("2026-06-02") },
      { id: "P2", plannedStartAt: iso("2026-06-01"), plannedAt: iso("2026-06-03") },
      { id: "c", parentId: "P2", plannedStartAt: iso("2026-06-03"), plannedAt: iso("2026-06-03"), dependsOn: ["X"] },
      { id: "k", parentId: "P2", plannedStartAt: iso("2026-06-01"), plannedAt: iso("2026-06-01") },
      { id: "S2", plannedStartAt: iso("2026-06-04"), plannedAt: iso("2026-06-04"), dependsOn: ["P2"] },
    ];
    const { plan } = flow(nodes, "X", 3); // X → 06-04..06-05; c → 06-06; P2 re-envelopes to 06-06
    expect(find(plan.changes, "c")!.plannedAt).toBe(iso("2026-06-06"));
    expect(find(plan.changes, "P2")!.plannedAt).toBe(iso("2026-06-06"));
    expect(find(plan.changes, "S2")).toEqual({ id: "S2", plannedStartAt: iso("2026-06-07"), plannedAt: iso("2026-06-07") }); // was left starting before its phase ended
  });

  it("a loop through a phase (S waits for P, a task inside P waits for S) is refused, not pushed round", () => {
    const nodes: ReflowNode[] = [
      { id: "A", plannedStartAt: iso("2026-06-01"), plannedAt: iso("2026-06-02") },
      { id: "P", plannedStartAt: iso("2026-06-01"), plannedAt: iso("2026-06-05") },
      { id: "c", parentId: "P", plannedStartAt: iso("2026-06-03"), plannedAt: iso("2026-06-05"), dependsOn: ["A", "S"] },
      { id: "S", plannedStartAt: iso("2026-06-06"), plannedAt: iso("2026-06-07"), dependsOn: ["P"] },
    ];
    expect(() => planCascade(nodes.map((n) => (n.id === "A" ? { ...n, plannedAt: iso("2026-06-04") } : n)), ["A"])).toThrow(CascadeRefusedError);
  });
});
