// lib/fileFinder/balloonLayout.ts — a tree that never overlaps itself.
//
// Physics layouts look alive and read badly: nodes drift over each other,
// labels collide, and the same folder lands somewhere new every visit. A
// file estate is a tree, and a tree has a layout that is simply CORRECT:
// each node's children sit on a ring around it, each child's whole subtree
// fits in a circle, and the ring is made just big enough that those circles
// don't touch. Computed bottom-up, placed top-down, deterministic, and
// nothing ever overlaps — the balloon layout.
//
// Pure: ids, parents and radii in; x/y out. The renderer animates between
// two layouts; this module never animates.

export interface LayoutNode {
  id: string;
  parentId: string | null;
  /** Visual radius of the node itself (icon disc). */
  r: number;
  /** Extra room below for the label. */
  labelPad?: number;
}

export interface Placed { x: number; y: number }

export interface BalloonOptions {
  /** Minimum clear space between neighbouring subtree circles. */
  gap?: number;
  /** Fraction of the circle left clear on the side facing the parent. */
  backGap?: number;
}

export function balloonLayout(nodes: LayoutNode[], opts: BalloonOptions = {}): Map<string, Placed> {
  const gap = opts.gap ?? 14;
  const backGap = opts.backGap ?? 0.6; // radians
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const children = new Map<string, LayoutNode[]>();
  const roots: LayoutNode[] = [];
  for (const n of nodes) {
    if (n.parentId && byId.has(n.parentId)) {
      const arr = children.get(n.parentId) ?? [];
      arr.push(n);
      children.set(n.parentId, arr);
    } else roots.push(n);
  }
  // Stable order: by id, so the same tree lays out the same way every time.
  for (const arr of children.values()) arr.sort((a, b) => a.id.localeCompare(b.id));
  roots.sort((a, b) => a.id.localeCompare(b.id));

  // Bottom-up: how big a circle does each subtree need?
  const need = new Map<string, number>();  // enclosing radius of the subtree
  const ring = new Map<string, number>();  // distance from node to its children
  const own = (n: LayoutNode) => n.r + (n.labelPad ?? 0);
  const measure = (n: LayoutNode): number => {
    const kids = children.get(n.id) ?? [];
    if (!kids.length) { need.set(n.id, own(n)); ring.set(n.id, 0); return own(n); }
    const needs = kids.map((k) => measure(k) + gap);
    const total = needs.reduce((s, x) => s + x, 0);
    const sweep = kids.length === 1 ? Math.PI : 2 * Math.PI - backGap;
    let rho = 0;
    for (const nd of needs) {
      const theta = Math.max(1e-3, (sweep * nd) / total);
      // The chord under this child's sector must fit the child's circle.
      rho = Math.max(rho, nd / Math.sin(Math.min(theta / 2, Math.PI / 2)));
    }
    rho = Math.max(rho, Math.max(...needs) + own(n) + gap, own(n) * 2.2);
    ring.set(n.id, rho);
    const enclosing = rho + Math.max(...needs);
    need.set(n.id, enclosing);
    return enclosing;
  };
  roots.forEach(measure);

  // Top-down placement.
  const out = new Map<string, Placed>();
  const place = (n: LayoutNode, x: number, y: number, heading: number) => {
    out.set(n.id, { x, y });
    const kids = children.get(n.id) ?? [];
    if (!kids.length) return;
    const needs = kids.map((k) => need.get(k.id)! + gap);
    const total = needs.reduce((s, x) => s + x, 0);
    const sweep = kids.length === 1 ? Math.PI : 2 * Math.PI - backGap;
    const rho = ring.get(n.id)!;
    let a = heading - sweep / 2;
    kids.forEach((k, i) => {
      const theta = (sweep * needs[i]) / total;
      const ang = a + theta / 2;
      a += theta;
      place(k, x + rho * Math.cos(ang), y + rho * Math.sin(ang), ang);
    });
  };

  if (roots.length === 1) {
    place(roots[0], 0, 0, -Math.PI / 2);
  } else if (roots.length > 1) {
    // Roots on a ring of their own around the origin, sized the same way.
    const needs = roots.map((r) => need.get(r.id)! + gap);
    const total = needs.reduce((s, x) => s + x, 0);
    let rho = 0;
    for (const nd of needs) {
      const theta = Math.max(1e-3, (2 * Math.PI * nd) / total);
      rho = Math.max(rho, nd / Math.sin(Math.min(theta / 2, Math.PI / 2)));
    }
    let a = -Math.PI / 2;
    roots.forEach((r, i) => {
      const theta = (2 * Math.PI * needs[i]) / total;
      const ang = a + theta / 2;
      a += theta;
      place(r, rho * Math.cos(ang), rho * Math.sin(ang), ang);
    });
  }
  return out;
}

/** Bounding box of a layout, for fitting the camera. */
export function layoutBounds(pos: Map<string, Placed>, pad = 40): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pos.values()) {
    if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y;
  }
  if (!isFinite(minX)) return { minX: -100, minY: -100, maxX: 100, maxY: 100 };
  return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
}
