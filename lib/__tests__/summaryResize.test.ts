// lib/__tests__/summaryResize.test.ts
import { describe, it, expect } from "vitest";
import { computeSummaryResize, type ReflowNode } from "@/lib/scheduleReflow";

const d = (s: string) => `${s}T00:00:00.000Z`;
const day = (iso: string) => iso.slice(0, 10);

// root
//   a: Jan01 → Jan05
//   b: Jan06 → Jan10
// leaf envelope: Jan01 … Jan10  (oldSpan = 9 days)
const tree: ReflowNode[] = [
  { id: "root", parentId: null, plannedStartAt: d("2026-01-01"), plannedAt: d("2026-01-10") },
  { id: "a", parentId: "root", plannedStartAt: d("2026-01-01"), plannedAt: d("2026-01-05") },
  { id: "b", parentId: "root", plannedStartAt: d("2026-01-06"), plannedAt: d("2026-01-10") },
];

describe("computeSummaryResize", () => {
  it("no-op for zero / unknown", () => {
    expect(computeSummaryResize(tree, "root", "finish", 0)).toEqual([]);
    expect(computeSummaryResize(tree, "ghost", "finish", 5)).toEqual([]);
  });

  it("dragging the finish edge stretches the subtree proportionally (anchored at start)", () => {
    // +9 days → span doubles (k = 2), anchored at Jan01
    const changes = computeSummaryResize(tree, "root", "finish", 9);
    const by = Object.fromEntries(changes.map((c) => [c.id, c]));
    expect(day(by["a"].plannedStartAt)).toBe("2026-01-01"); // anchor unchanged
    expect(day(by["a"].plannedAt)).toBe("2026-01-09");      // 4d → 8d
    expect(day(by["b"].plannedStartAt)).toBe("2026-01-11");
    expect(day(by["b"].plannedAt)).toBe("2026-01-19");
    // the parent envelope now ends 9 days later
    expect(day(by["root"].plannedAt)).toBe("2026-01-19");
    expect(day(by["root"].plannedStartAt)).toBe("2026-01-01");
  });

  it("dragging the start edge earlier extends from the finish anchor", () => {
    // -9 days → span doubles, anchored at Jan10 (finish)
    const changes = computeSummaryResize(tree, "root", "start", -9);
    const by = Object.fromEntries(changes.map((c) => [c.id, c]));
    expect(day(by["root"].plannedAt)).toBe("2026-01-10");      // finish anchored
    expect(day(by["root"].plannedStartAt)).toBe("2025-12-23"); // 9 days earlier
  });

  it("refuses to collapse the whole phase below a day", () => {
    // shrinking finish by the full span would zero it out → no change
    expect(computeSummaryResize(tree, "root", "finish", -9)).toEqual([]);
  });

  it("keeps every leaf at >= 1 day", () => {
    const changes = computeSummaryResize(tree, "root", "finish", -4); // shrink toward half
    for (const c of changes) {
      expect(Date.parse(c.plannedAt)).toBeGreaterThanOrEqual(Date.parse(c.plannedStartAt));
    }
  });
});
