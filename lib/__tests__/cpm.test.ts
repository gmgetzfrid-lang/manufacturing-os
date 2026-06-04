// lib/__tests__/cpm.test.ts
import { describe, it, expect } from "vitest";
import { computeCpm, type CpmNode } from "@/lib/cpm";
import type { DependencyLink } from "@/lib/scheduleLinks";

const d = (s: string) => `${s}T00:00:00.000Z`;
const fs = (predId: string, lag = 0): DependencyLink => ({ predId, type: "FS", lagDays: lag });

describe("computeCpm — forward/backward pass", () => {
  it("a straight FS chain is entirely critical with zero float", () => {
    const nodes: CpmNode[] = [
      { id: "a", plannedStartAt: d("2026-01-01"), plannedAt: d("2026-01-01") },
      { id: "b", plannedStartAt: d("2026-01-02"), plannedAt: d("2026-01-02"), dependencyLinks: [fs("a")] },
      { id: "c", plannedStartAt: d("2026-01-03"), plannedAt: d("2026-01-03"), dependencyLinks: [fs("b")] },
    ];
    const r = computeCpm(nodes);
    expect(r.hasLinks).toBe(true);
    expect(r.projectFinish).toBe(d("2026-01-03"));
    expect(r.criticalIds).toEqual(new Set(["a", "b", "c"]));
    expect(r.activities.get("a")!.totalFloatDays).toBe(0);
    expect(r.activities.get("c")!.es).toBe(2); // day index 2
  });

  it("a parallel short task carries float and is NOT on the critical path", () => {
    const nodes: CpmNode[] = [
      { id: "a", plannedStartAt: d("2026-01-01"), plannedAt: d("2026-01-01") },                                  // 1d
      { id: "b", plannedStartAt: d("2026-01-02"), plannedAt: d("2026-01-04"), dependencyLinks: [fs("a")] },      // 3d (long)
      { id: "s", plannedStartAt: d("2026-01-02"), plannedAt: d("2026-01-02"), dependencyLinks: [fs("a")] },      // 1d (short)
      { id: "c", plannedStartAt: d("2026-01-05"), plannedAt: d("2026-01-05"), dependencyLinks: [fs("b"), fs("s")] },
    ];
    const r = computeCpm(nodes);
    expect(r.criticalIds.has("a")).toBe(true);
    expect(r.criticalIds.has("b")).toBe(true);
    expect(r.criticalIds.has("c")).toBe(true);
    expect(r.criticalIds.has("s")).toBe(false);
    // s can slip 2 days (until b's finish) before it moves c.
    expect(r.activities.get("s")!.totalFloatDays).toBe(2);
  });

  it("honors FS lag in the finish date", () => {
    const nodes: CpmNode[] = [
      { id: "a", plannedStartAt: d("2026-01-01"), plannedAt: d("2026-01-01") },
      { id: "b", plannedStartAt: d("2026-01-02"), plannedAt: d("2026-01-02"), dependencyLinks: [fs("a", 2)] },
    ];
    const r = computeCpm(nodes);
    // b can't start until a finishes (day 0) + 1 + 2 = day 3 → finish day 3.
    expect(r.activities.get("b")!.es).toBe(3);
    expect(r.projectFinish).toBe(d("2026-01-04"));
  });

  it("respects a Start-to-Start link", () => {
    const nodes: CpmNode[] = [
      { id: "a", plannedStartAt: d("2026-01-05"), plannedAt: d("2026-01-09") },                                       // 5d
      { id: "b", plannedStartAt: d("2026-01-01"), plannedAt: d("2026-01-02"), dependencyLinks: [{ predId: "a", type: "SS", lagDays: 0 }] },
    ];
    const r = computeCpm(nodes);
    // Origin = b's planned start (day 0); a starts at day 4. SS ⇒ b can't
    // start before a starts, so its earliest start is pulled out to day 4.
    expect(r.activities.get("b")!.es).toBe(4);
  });

  it("reports hasLinks=false when nothing is linked", () => {
    const nodes: CpmNode[] = [
      { id: "a", plannedStartAt: d("2026-01-01"), plannedAt: d("2026-01-02") },
      { id: "b", plannedStartAt: d("2026-01-03"), plannedAt: d("2026-01-04") },
    ];
    const r = computeCpm(nodes);
    expect(r.hasLinks).toBe(false);
  });

  it("ignores summary rows and is cycle-safe", () => {
    const nodes: CpmNode[] = [
      { id: "P", plannedStartAt: d("2026-01-01"), plannedAt: d("2026-01-05") }, // summary (has children)
      { id: "a", parentId: "P", plannedStartAt: d("2026-01-01"), plannedAt: d("2026-01-02"), dependencyLinks: [fs("b")] },
      { id: "b", parentId: "P", plannedStartAt: d("2026-01-03"), plannedAt: d("2026-01-05"), dependencyLinks: [fs("a")] }, // cycle a<->b
    ];
    expect(() => computeCpm(nodes)).not.toThrow();
    const r = computeCpm(nodes);
    expect(r.activities.has("P")).toBe(false); // summary excluded
    expect(r.activities.has("a")).toBe(true);
  });
});
