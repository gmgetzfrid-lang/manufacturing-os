// A layout that overlaps is worse than a list. These tests generate messy
// trees — wide folders, deep chains, several roots — and check that no two
// nodes ever touch and that the same tree lands in the same place twice.

import { describe, it, expect } from "vitest";
import { balloonLayout, type LayoutNode } from "@/lib/fileFinder/balloonLayout";

function seeded(seed: number) {
  let s = seed;
  return () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
}

function randomTree(seed: number, count: number, roots: number): LayoutNode[] {
  const rnd = seeded(seed);
  const nodes: LayoutNode[] = [];
  for (let i = 0; i < roots; i++) nodes.push({ id: `root${i}`, parentId: null, r: 22, labelPad: 12 });
  for (let i = 0; i < count; i++) {
    const parent = nodes[Math.floor(rnd() * nodes.length)];
    const isFolder = rnd() < 0.3;
    nodes.push({ id: `n${i}`, parentId: parent.id, r: isFolder ? 16 : 11, labelPad: 12 });
  }
  return nodes;
}

function assertNoOverlap(nodes: LayoutNode[], pos: Map<string, { x: number; y: number }>) {
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = pos.get(nodes[i].id)!, b = pos.get(nodes[j].id)!;
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const min = nodes[i].r + nodes[j].r;
      if (d < min) throw new Error(`${nodes[i].id} and ${nodes[j].id} overlap: ${d.toFixed(1)} < ${min}`);
    }
  }
}

describe("balloonLayout", () => {
  it("places every node", () => {
    const nodes = randomTree(1, 200, 1);
    const pos = balloonLayout(nodes);
    expect(pos.size).toBe(nodes.length);
  });
  it("never overlaps two nodes, across many random trees", () => {
    for (let seed = 1; seed <= 12; seed++) {
      const nodes = randomTree(seed, 150 + seed * 10, 1 + (seed % 3));
      assertNoOverlap(nodes, balloonLayout(nodes));
    }
  });
  it("handles a folder with hundreds of files", () => {
    const nodes: LayoutNode[] = [{ id: "lib", parentId: null, r: 22 }, { id: "f", parentId: "lib", r: 16 }];
    for (let i = 0; i < 400; i++) nodes.push({ id: `file${String(i).padStart(3, "0")}`, parentId: "f", r: 11, labelPad: 12 });
    assertNoOverlap(nodes, balloonLayout(nodes));
  });
  it("is deterministic", () => {
    const nodes = randomTree(7, 120, 2);
    const a = balloonLayout(nodes), b = balloonLayout([...nodes].reverse());
    for (const n of nodes) expect(a.get(n.id)).toEqual(b.get(n.id));
  });
  it("keeps a child's subtree on the far side from its parent", () => {
    const nodes: LayoutNode[] = [
      { id: "root", parentId: null, r: 20 }, { id: "a", parentId: "root", r: 16 },
      { id: "a1", parentId: "a", r: 10 }, { id: "a2", parentId: "a", r: 10 },
    ];
    const pos = balloonLayout(nodes);
    const root = pos.get("root")!, a = pos.get("a")!;
    for (const id of ["a1", "a2"]) {
      const c = pos.get(id)!;
      // The grandchild is farther from the root than its parent is.
      expect(Math.hypot(c.x - root.x, c.y - root.y)).toBeGreaterThan(Math.hypot(a.x - root.x, a.y - root.y));
    }
  });
});
