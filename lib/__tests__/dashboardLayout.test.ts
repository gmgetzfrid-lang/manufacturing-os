// lib/__tests__/dashboardLayout.test.ts
//
// Coverage for the free-form grid engine: collision, vertical compaction,
// move (drag), resize, and first-fit packing. These are the guarantees the
// dashboard's drag-and-drop relies on — no overlaps, no holes.

import { describe, it, expect } from "vitest";
import {
  collides,
  getFirstCollision,
  bottomRow,
  compactVertical,
  moveElement,
  resizeElement,
  firstFreeSlot,
  packLayout,
  type LayoutItem,
} from "@/lib/dashboard/layout";

const COLS = 12;

function noOverlaps(items: LayoutItem[]): boolean {
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (collides(items[i], items[j])) return false;
    }
  }
  return true;
}

describe("collides", () => {
  it("detects overlap and ignores self", () => {
    const a: LayoutItem = { id: "a", x: 0, y: 0, w: 6, h: 2 };
    const b: LayoutItem = { id: "b", x: 3, y: 1, w: 6, h: 2 };
    const c: LayoutItem = { id: "c", x: 6, y: 0, w: 6, h: 2 };
    expect(collides(a, b)).toBe(true);
    expect(collides(a, c)).toBe(false); // share an edge, no overlap
    expect(collides(a, { ...a, id: "a" })).toBe(false);
  });
});

describe("compactVertical", () => {
  it("pulls widgets up to fill holes without overlapping", () => {
    const items: LayoutItem[] = [
      { id: "a", x: 0, y: 5, w: 6, h: 2 },
      { id: "b", x: 6, y: 9, w: 6, h: 2 },
    ];
    const out = compactVertical(items, COLS);
    expect(out.find((i) => i.id === "a")!.y).toBe(0);
    expect(out.find((i) => i.id === "b")!.y).toBe(0);
    expect(noOverlaps(out)).toBe(true);
  });

  it("stacks widgets that share a column", () => {
    const items: LayoutItem[] = [
      { id: "a", x: 0, y: 4, w: 12, h: 3 },
      { id: "b", x: 0, y: 9, w: 6, h: 2 },
    ];
    const out = compactVertical(items, COLS);
    expect(out.find((i) => i.id === "a")!.y).toBe(0);
    expect(out.find((i) => i.id === "b")!.y).toBe(3); // sits right under a
    expect(noOverlaps(out)).toBe(true);
  });

  it("preserves input array order (stable keys)", () => {
    const items: LayoutItem[] = [
      { id: "a", x: 0, y: 0, w: 6, h: 2 },
      { id: "b", x: 6, y: 0, w: 6, h: 2 },
      { id: "c", x: 0, y: 2, w: 12, h: 2 },
    ];
    const out = compactVertical(items, COLS);
    expect(out.map((i) => i.id)).toEqual(["a", "b", "c"]);
  });
});

describe("moveElement", () => {
  it("removing the top banner lets the rest float up (drag a small one up)", () => {
    // Deck removed; a small widget dragged toward the now-empty top row.
    const items: LayoutItem[] = [
      { id: "doc", x: 0, y: 0, w: 12, h: 3 },
      { id: "small", x: 0, y: 3, w: 6, h: 3 },
    ];
    // Drag `small` up to row 0; `doc` should yield and the layout stays legal.
    const out = moveElement(items, "small", 0, 0, COLS);
    const small = out.find((i) => i.id === "small")!;
    const doc = out.find((i) => i.id === "doc")!;
    expect(small.y).toBe(0);
    expect(doc.y).toBe(3); // pushed below, then compacted
    expect(noOverlaps(out)).toBe(true);
  });

  it("clamps x to the grid and never overlaps", () => {
    const items: LayoutItem[] = [
      { id: "a", x: 0, y: 0, w: 6, h: 2 },
      { id: "b", x: 6, y: 0, w: 6, h: 2 },
    ];
    const out = moveElement(items, "a", 99, 0, COLS); // try to shove past the edge
    const a = out.find((i) => i.id === "a")!;
    expect(a.x).toBe(COLS - a.w); // clamped to right edge
    expect(noOverlaps(out)).toBe(true);
  });

  it("dragging down past a sibling swaps them", () => {
    const items: LayoutItem[] = [
      { id: "a", x: 0, y: 0, w: 12, h: 2 },
      { id: "b", x: 0, y: 2, w: 12, h: 2 },
    ];
    const out = moveElement(items, "a", 0, 2, COLS);
    expect(out.find((i) => i.id === "b")!.y).toBe(0);
    expect(out.find((i) => i.id === "a")!.y).toBe(2);
    expect(noOverlaps(out)).toBe(true);
  });
});

describe("resizeElement", () => {
  it("grows a widget and compacts neighbours, no overlap", () => {
    const items: LayoutItem[] = [
      { id: "a", x: 0, y: 0, w: 6, h: 2 },
      { id: "b", x: 0, y: 2, w: 6, h: 2 },
    ];
    const out = resizeElement(items, "a", 6, 4, COLS);
    expect(out.find((i) => i.id === "a")!.h).toBe(4);
    expect(out.find((i) => i.id === "b")!.y).toBe(4);
    expect(noOverlaps(out)).toBe(true);
  });

  it("nudges left when a wider span would spill past the edge", () => {
    const items: LayoutItem[] = [{ id: "a", x: 8, y: 0, w: 4, h: 2 }];
    const out = resizeElement(items, "a", 8, 2, COLS);
    const a = out.find((i) => i.id === "a")!;
    expect(a.w).toBe(8);
    expect(a.x).toBe(COLS - 8);
  });
});

describe("firstFreeSlot / packLayout / bottomRow", () => {
  it("finds the first free slot for a new widget", () => {
    const items: LayoutItem[] = [{ id: "a", x: 0, y: 0, w: 12, h: 3 }];
    expect(firstFreeSlot(items, 6, 2, COLS)).toEqual({ x: 0, y: 3 });
  });

  it("packs an ordered list into compact, non-overlapping coordinates", () => {
    const out = packLayout(
      [
        { id: "deck", w: 12, h: 4 },
        { id: "doc", w: 12, h: 3 },
        { id: "brief", w: 6, h: 3 },
        { id: "launch", w: 6, h: 3 },
      ],
      COLS,
    );
    expect(out.find((i) => i.id === "deck")).toMatchObject({ x: 0, y: 0 });
    expect(out.find((i) => i.id === "doc")).toMatchObject({ x: 0, y: 4 });
    // brief + launch share the next row side by side
    expect(out.find((i) => i.id === "brief")).toMatchObject({ x: 0, y: 7 });
    expect(out.find((i) => i.id === "launch")).toMatchObject({ x: 6, y: 7 });
    expect(noOverlaps(out)).toBe(true);
    expect(bottomRow(out)).toBe(10);
  });

  it("getFirstCollision spots an overlapping probe", () => {
    const items: LayoutItem[] = [{ id: "a", x: 0, y: 0, w: 6, h: 2 }];
    expect(getFirstCollision(items, { id: "p", x: 3, y: 1, w: 6, h: 2 })).toBeTruthy();
    expect(getFirstCollision(items, { id: "p", x: 6, y: 0, w: 6, h: 2 })).toBeUndefined();
  });
});
