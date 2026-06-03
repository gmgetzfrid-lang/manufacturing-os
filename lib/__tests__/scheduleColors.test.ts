// lib/__tests__/scheduleColors.test.ts
import { describe, it, expect } from "vitest";
import { assignGroupColors, GROUP_PALETTE, ROOT_COLOR } from "@/lib/scheduleColors";

type N = { id: string; parentId: string | null; name: string; plannedStartAt?: string | null; plannedAt: string };
const d = (s: string) => `${s}T12:00:00Z`;

describe("assignGroupColors — multiple top groups", () => {
  it("gives each top group a distinct hue and shares it with descendants", () => {
    const items: N[] = [
      { id: "A", parentId: null, name: "Phase A", plannedAt: d("2026-01-01") },
      { id: "A1", parentId: "A", name: "a1", plannedAt: d("2026-01-02") },
      { id: "B", parentId: null, name: "Phase B", plannedAt: d("2026-02-01") },
    ];
    const { colorOf, groups } = assignGroupColors(items);
    expect(groups.map((g) => g.id)).toEqual(["A", "B"]); // schedule order
    expect(colorOf(items[0]).rail).toBe(GROUP_PALETTE[0].rail);
    expect(colorOf(items[1]).rail).toBe(GROUP_PALETTE[0].rail); // child shares parent hue
    expect(colorOf(items[2]).rail).toBe(GROUP_PALETTE[1].rail);
  });
});

describe("assignGroupColors — single overarching root", () => {
  const items: N[] = [
    { id: "root", parentId: null, name: "Overall project", plannedStartAt: d("2026-01-01"), plannedAt: d("2026-03-01") },
    { id: "p1", parentId: "root", name: "Design", plannedStartAt: d("2026-01-01"), plannedAt: d("2026-01-20") },
    { id: "p1a", parentId: "p1", name: "drawings", plannedAt: d("2026-01-10") },
    { id: "p2", parentId: "root", name: "Build", plannedStartAt: d("2026-01-21"), plannedAt: d("2026-02-20") },
  ];

  it("anchors color on the root's first-level phases, not the single root", () => {
    const { colorOf, groups } = assignGroupColors(items);
    // groups = the two phases, in schedule order
    expect(groups.map((g) => g.id)).toEqual(["p1", "p2"]);
    // the two phases get DIFFERENT hues (the bug was: all the same)
    expect(colorOf(items[1]).rail).not.toBe(colorOf(items[3]).rail);
    // a deep descendant inherits its phase hue
    expect(colorOf(items[2]).rail).toBe(colorOf(items[1]).rail);
  });

  it("paints the root itself neutral (the envelope), distinct from its phases", () => {
    const { colorOf } = assignGroupColors(items);
    expect(colorOf(items[0]).rail).toBe(ROOT_COLOR.rail);
    expect(colorOf(items[0]).rail).not.toBe(colorOf(items[1]).rail);
  });
});

describe("assignGroupColors — degenerate input", () => {
  it("handles an empty list", () => {
    expect(assignGroupColors([]).groups).toEqual([]);
  });
  it("does not loop on a parent cycle", () => {
    const items: N[] = [
      { id: "x", parentId: "y", name: "x", plannedAt: d("2026-01-01") },
      { id: "y", parentId: "x", name: "y", plannedAt: d("2026-01-02") },
    ];
    expect(() => assignGroupColors(items).colorOf(items[0])).not.toThrow();
  });
});
