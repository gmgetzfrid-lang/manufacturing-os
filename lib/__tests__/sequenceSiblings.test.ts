// lib/__tests__/sequenceSiblings.test.ts
import { describe, it, expect } from "vitest";
import { sequenceSiblings, type ReflowNode } from "@/lib/scheduleReflow";

const d = (s: string) => `${s}T00:00:00.000Z`;
const day = (iso: string) => iso.slice(0, 10);

describe("sequenceSiblings", () => {
  it("no-op with fewer than two children", () => {
    expect(sequenceSiblings([{ id: "p", parentId: null, plannedAt: d("2026-01-01") }], "p")).toEqual([]);
  });

  it("chains overlapping children end-to-end, preserving each duration", () => {
    // a: 4-day (Jan01–Jan04), b: 3-day but OVERLAPS (Jan02–Jan04), c: 2-day (Jan01–Jan02)
    const nodes: ReflowNode[] = [
      { id: "p", parentId: null, plannedStartAt: d("2026-01-01"), plannedAt: d("2026-01-04") },
      { id: "a", parentId: "p", plannedStartAt: d("2026-01-01"), plannedAt: d("2026-01-04") },
      { id: "b", parentId: "p", plannedStartAt: d("2026-01-02"), plannedAt: d("2026-01-04") },
      { id: "c", parentId: "p", plannedStartAt: d("2026-01-01"), plannedAt: d("2026-01-02") },
    ];
    const by = Object.fromEntries(sequenceSiblings(nodes, "p").map((c) => [c.id, c]));
    // order is by start then finish: c(Jan01–02), a(Jan01–04), b(Jan02–04)
    // first stays; next starts day after prior finish; durations preserved
    expect(day(by["a"].plannedStartAt)).toBe("2026-01-03"); // after c's Jan02 finish
    expect(day(by["a"].plannedAt)).toBe("2026-01-06");       // 3-day span preserved
    expect(day(by["b"].plannedStartAt)).toBe("2026-01-07"); // after a's Jan06 finish
    expect(day(by["b"].plannedAt)).toBe("2026-01-09");       // 2-day span preserved
    // parent envelope grows to cover the chain
    expect(day(by["p"].plannedAt)).toBe("2026-01-09");
  });

  it("carries a child's own subtree when it shifts", () => {
    const nodes: ReflowNode[] = [
      { id: "p", parentId: null, plannedStartAt: d("2026-02-01"), plannedAt: d("2026-02-10") },
      { id: "x", parentId: "p", plannedStartAt: d("2026-02-01"), plannedAt: d("2026-02-03") },
      { id: "y", parentId: "p", plannedStartAt: d("2026-02-01"), plannedAt: d("2026-02-05") }, // overlaps x
      { id: "y1", parentId: "y", plannedStartAt: d("2026-02-01"), plannedAt: d("2026-02-05") }, // child of y
    ];
    const by = Object.fromEntries(sequenceSiblings(nodes, "p").map((c) => [c.id, c]));
    // y shifts to start after x finishes (Feb03 → start Feb04); y1 moves with it
    expect(day(by["y"].plannedStartAt)).toBe("2026-02-04");
    expect(by["y1"]).toBeDefined();
    expect(day(by["y1"].plannedStartAt)).toBe("2026-02-04");
  });
});
