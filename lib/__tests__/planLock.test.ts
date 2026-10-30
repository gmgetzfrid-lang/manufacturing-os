// Moving one step's plan moves that step only: the task row above it
// refits to wrap its steps; the steps linked after it keep their plan.

import { describe, it, expect } from "vitest";
import { withAncestors, type ReflowNode } from "@/lib/scheduleReflow";

const h = (n: number) => new Date(Date.UTC(2026, 9, 26, 13) + n * 3_600_000).toISOString();
const N: ReflowNode[] = [
  { id: "task", parentId: null, plannedStartAt: h(0), plannedAt: h(10), status: "planned", dependsOn: null, links: null },
  { id: "a", parentId: "task", plannedStartAt: h(0), plannedAt: h(4), status: "planned", dependsOn: null, links: null },
  { id: "b", parentId: "task", plannedStartAt: h(4), plannedAt: h(10), status: "planned", dependsOn: ["a"], links: null },
  { id: "other", parentId: null, plannedStartAt: h(0), plannedAt: h(2), status: "planned", dependsOn: null, links: null },
];

describe("the plan moves only where it's moved", () => {
  it("the step after it keeps its plan; the task row wraps the move", () => {
    const out = withAncestors(N, [{ id: "a", plannedStartAt: h(8), plannedAt: h(12) }]);
    expect(out.map((c) => c.id).sort()).toEqual(["a", "task"]);
    expect(out.find((c) => c.id === "task")).toEqual({ id: "task", plannedStartAt: h(4), plannedAt: h(12) });
  });
  it("inside its task row: nothing else changes", () => {
    expect(withAncestors(N, [{ id: "a", plannedStartAt: h(1), plannedAt: h(4) }]).map((c) => c.id)).toEqual(["a", "task"]);
    expect(withAncestors(N, [{ id: "b", plannedStartAt: h(5), plannedAt: h(9) }]).map((c) => c.id)).toEqual(["b", "task"]);
  });
});
