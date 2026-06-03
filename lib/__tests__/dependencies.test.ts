// lib/__tests__/dependencies.test.ts
import { describe, it, expect } from "vitest";
import { cascadeDependents, wouldCreateCycle, type ReflowNode } from "@/lib/scheduleReflow";

const d = (s: string) => `${s}T00:00:00.000Z`;
const day = (iso: string) => iso.slice(0, 10);

describe("wouldCreateCycle", () => {
  const nodes: ReflowNode[] = [
    { id: "a", parentId: null, plannedAt: d("2026-01-05") },
    { id: "b", parentId: null, plannedAt: d("2026-01-10"), dependsOn: ["a"] },
    { id: "c", parentId: null, plannedAt: d("2026-01-15"), dependsOn: ["b"] },
  ];
  it("flags a self-dependency", () => {
    expect(wouldCreateCycle(nodes, "a", "a")).toBe(true);
  });
  it("flags a back-edge (c→a when a→b→c already)", () => {
    // adding 'a depends on c' would cycle (c already depends on a transitively)
    expect(wouldCreateCycle(nodes, "a", "c")).toBe(true);
  });
  it("allows a forward edge", () => {
    // 'c depends on a' is fine (no cycle)
    expect(wouldCreateCycle(nodes, "c", "a")).toBe(false);
  });
});

describe("cascadeDependents — finish-to-start", () => {
  it("pushes a dependent so it starts after its predecessor finishes", () => {
    const nodes: ReflowNode[] = [
      { id: "a", parentId: null, plannedStartAt: d("2026-01-01"), plannedAt: d("2026-01-10") }, // a moved to finish Jan10
      { id: "b", parentId: null, plannedStartAt: d("2026-01-03"), plannedAt: d("2026-01-06"), dependsOn: ["a"] },
    ];
    const by = Object.fromEntries(cascadeDependents(nodes, ["a"]).map((c) => [c.id, c]));
    // b must start the day after a finishes (Jan11) and keep its 3-day span
    expect(day(by["b"].plannedStartAt)).toBe("2026-01-11");
    expect(day(by["b"].plannedAt)).toBe("2026-01-14");
  });

  it("cascades transitively (a→b→c)", () => {
    const nodes: ReflowNode[] = [
      { id: "a", parentId: null, plannedStartAt: d("2026-01-01"), plannedAt: d("2026-01-10") },
      { id: "b", parentId: null, plannedStartAt: d("2026-01-02"), plannedAt: d("2026-01-04"), dependsOn: ["a"] },
      { id: "c", parentId: null, plannedStartAt: d("2026-01-05"), plannedAt: d("2026-01-06"), dependsOn: ["b"] },
    ];
    const by = Object.fromEntries(cascadeDependents(nodes, ["a"]).map((x) => [x.id, x]));
    expect(day(by["b"].plannedStartAt)).toBe("2026-01-11"); // after a (Jan10)
    expect(day(by["b"].plannedAt)).toBe("2026-01-13");      // 2-day span preserved
    expect(day(by["c"].plannedStartAt)).toBe("2026-01-14"); // day after b's new finish (Jan13)
  });

  it("never pulls a dependent earlier (only pushes forward)", () => {
    const nodes: ReflowNode[] = [
      { id: "a", parentId: null, plannedStartAt: d("2026-01-01"), plannedAt: d("2026-01-03") },
      { id: "b", parentId: null, plannedStartAt: d("2026-02-01"), plannedAt: d("2026-02-05"), dependsOn: ["a"] }, // already far after
    ];
    expect(cascadeDependents(nodes, ["a"])).toEqual([]); // b already satisfies the constraint
  });

  it("carries a dependent's subtree when it shifts", () => {
    const nodes: ReflowNode[] = [
      { id: "a", parentId: null, plannedStartAt: d("2026-01-01"), plannedAt: d("2026-01-10") },
      { id: "b", parentId: null, plannedStartAt: d("2026-01-02"), plannedAt: d("2026-01-08"), dependsOn: ["a"] },
      { id: "b1", parentId: "b", plannedStartAt: d("2026-01-02"), plannedAt: d("2026-01-04") },
    ];
    const by = Object.fromEntries(cascadeDependents(nodes, ["a"]).map((x) => [x.id, x]));
    expect(by["b1"]).toBeDefined();
    expect(day(by["b1"].plannedStartAt)).toBe("2026-01-11"); // moved with b
  });

  it("is cycle-safe (does not hang on a dependency cycle)", () => {
    const nodes: ReflowNode[] = [
      { id: "a", parentId: null, plannedStartAt: d("2026-01-01"), plannedAt: d("2026-01-05"), dependsOn: ["b"] },
      { id: "b", parentId: null, plannedStartAt: d("2026-01-01"), plannedAt: d("2026-01-05"), dependsOn: ["a"] },
    ];
    expect(() => cascadeDependents(nodes, ["a"])).not.toThrow();
  });
});
