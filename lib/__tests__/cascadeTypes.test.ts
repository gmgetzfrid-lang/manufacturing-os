// lib/__tests__/cascadeTypes.test.ts
//
// The cascade must honor all four relationship types + lag, not just FS.
import { describe, it, expect } from "vitest";
import { cascadeDependents, type ReflowNode } from "@/lib/scheduleReflow";
import type { DependencyLink } from "@/lib/scheduleLinks";

const d = (s: string) => `${s}T00:00:00.000Z`;
const day = (iso: string) => iso.slice(0, 10);
const link = (predId: string, type: DependencyLink["type"], lagDays = 0): DependencyLink => ({ predId, type, lagDays });

describe("cascadeDependents — typed links", () => {
  it("FS+2 leaves a two-day gap after the predecessor finishes", () => {
    const nodes: ReflowNode[] = [
      { id: "a", parentId: null, plannedStartAt: d("2026-01-01"), plannedAt: d("2026-01-10") },
      { id: "b", parentId: null, plannedStartAt: d("2026-01-02"), plannedAt: d("2026-01-04"), links: [link("a", "FS", 2)] },
    ];
    const by = Object.fromEntries(cascadeDependents(nodes, ["a"]).map((c) => [c.id, c]));
    // a finishes Jan10; FS+2 ⇒ start Jan13 (Jan11 & Jan12 are the 2-day gap).
    expect(day(by["b"].plannedStartAt)).toBe("2026-01-13");
  });

  it("SS pulls a successor's start up to the predecessor's start", () => {
    const nodes: ReflowNode[] = [
      { id: "a", parentId: null, plannedStartAt: d("2026-01-05"), plannedAt: d("2026-01-15") },
      { id: "b", parentId: null, plannedStartAt: d("2026-01-01"), plannedAt: d("2026-01-02"), links: [link("a", "SS", 0)] },
    ];
    const by = Object.fromEntries(cascadeDependents(nodes, ["a"]).map((c) => [c.id, c]));
    expect(day(by["b"].plannedStartAt)).toBe("2026-01-05"); // starts with a
    expect(day(by["b"].plannedAt)).toBe("2026-01-06");      // 2-day span preserved
  });

  it("FF makes the successor finish when the predecessor finishes", () => {
    const nodes: ReflowNode[] = [
      { id: "a", parentId: null, plannedStartAt: d("2026-01-01"), plannedAt: d("2026-01-10") },
      { id: "b", parentId: null, plannedStartAt: d("2026-01-01"), plannedAt: d("2026-01-05"), links: [link("a", "FF", 0)] },
    ];
    const by = Object.fromEntries(cascadeDependents(nodes, ["a"]).map((c) => [c.id, c]));
    expect(day(by["b"].plannedAt)).toBe("2026-01-10");      // finishes with a
    expect(day(by["b"].plannedStartAt)).toBe("2026-01-06"); // span (5d) preserved
  });

  it("legacy dependsOn (no links) still behaves as FS+0", () => {
    const nodes: ReflowNode[] = [
      { id: "a", parentId: null, plannedStartAt: d("2026-01-01"), plannedAt: d("2026-01-10") },
      { id: "b", parentId: null, plannedStartAt: d("2026-01-03"), plannedAt: d("2026-01-06"), dependsOn: ["a"] },
    ];
    const by = Object.fromEntries(cascadeDependents(nodes, ["a"]).map((c) => [c.id, c]));
    expect(day(by["b"].plannedStartAt)).toBe("2026-01-11");
    expect(day(by["b"].plannedAt)).toBe("2026-01-14");
  });
});
