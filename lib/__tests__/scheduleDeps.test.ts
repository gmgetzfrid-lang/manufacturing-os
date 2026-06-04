// lib/__tests__/scheduleDeps.test.ts
import { describe, it, expect } from "vitest";
import { resolveVisibleDepIndex } from "@/lib/scheduleDeps";

// Parent chains used across the cases:
//   phaseA ─ a1
//   phaseB ─ b1 ─ b1a
const parents: Record<string, string | null> = {
  phaseA: null, a1: "phaseA",
  phaseB: null, b1: "phaseB", b1a: "b1",
};
const parentOf = (id: string) => parents[id] ?? null;

describe("resolveVisibleDepIndex", () => {
  it("returns the row's own index when it is visible", () => {
    const visible = new Map([["a1", 3]]);
    expect(resolveVisibleDepIndex("a1", visible, parentOf)).toBe(3);
  });

  it("falls back to the nearest visible ancestor when the row is collapsed", () => {
    // a1 is hidden; its parent phaseA is the visible row.
    const visible = new Map([["phaseA", 0]]);
    expect(resolveVisibleDepIndex("a1", visible, parentOf)).toBe(0);
  });

  it("walks multiple levels up to the first visible ancestor", () => {
    // b1a hidden, b1 hidden, phaseB visible.
    const visible = new Map([["phaseB", 5]]);
    expect(resolveVisibleDepIndex("b1a", visible, parentOf)).toBe(5);
  });

  it("prefers the closest visible ancestor over a further one", () => {
    const visible = new Map([["phaseB", 5], ["b1", 6]]);
    expect(resolveVisibleDepIndex("b1a", visible, parentOf)).toBe(6);
  });

  it("returns undefined when nothing in the ancestry is visible", () => {
    const visible = new Map([["somethingElse", 9]]);
    expect(resolveVisibleDepIndex("b1a", visible, parentOf)).toBeUndefined();
  });

  it("does not loop forever on a cyclic parent chain", () => {
    const cyclic: Record<string, string> = { x: "y", y: "x" };
    const visible = new Map<string, number>();
    expect(resolveVisibleDepIndex("x", visible, (id) => cyclic[id] ?? null)).toBeUndefined();
  });
});
