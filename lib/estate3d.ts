// lib/estate3d.ts — the estate tree as a globe in 3D.
//
// The same tree as the Map (operating area → equipment type → equipment →
// documents). The operating areas sit spread evenly around a sphere; each
// one's equipment types fan outward from it in a cone, equipment beyond
// them, drawings at the tips. Round overall, like the free-form web, but
// every area is its own cluster and every position is fixed — no physics,
// no starburst — so the view is a place you can learn. Unplaced documents
// are not drawn one by one; their group carries the count. Pure.

import { buildEstateTree, type TreeNode } from "@/lib/estateTree";
import type { GraphNode, GraphEdge, GraphNodeType } from "@/lib/orgGraph";

const GOLDEN = Math.PI * (3 - Math.sqrt(5));
export const HUB = "__estate__";
type V3 = [number, number, number];
const norm = (v: V3): V3 => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** k directions spread evenly over a cap of half-angle `angle` around `u`
 *  (the whole sphere when angle is π). */
export function capDirections(u: V3, k: number, angle: number): V3[] {
  if (k <= 0) return [];
  if (k === 1) return [norm(u)];
  const z = norm(u);
  const helper: V3 = Math.abs(z[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const x = norm(cross(helper, z)), y = cross(z, x);
  const out: V3[] = [];
  const span = 1 - Math.cos(angle);
  for (let i = 0; i < k; i++) {
    const cz = 1 - span * ((i + 0.5) / k);
    const r = Math.sqrt(Math.max(0, 1 - cz * cz));
    const phi = i * GOLDEN;
    const lx = r * Math.cos(phi), ly = r * Math.sin(phi);
    out.push(norm([x[0] * lx + y[0] * ly + z[0] * cz, x[1] * lx + y[1] * ly + z[1] * cz, x[2] * lx + y[2] * ly + z[2] * cz]));
  }
  return out;
}

export function estateGlobe(nodes: GraphNode[], edges: GraphEdge[]): { nodes: GraphNode[]; edges: GraphEdge[]; pos: Record<string, [number, number, number]> } {
  const tree = buildEstateTree(nodes, edges);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const treeById = new Map(tree.map((t) => [t.id, t]));
  const isUnplaced = (t: TreeNode): boolean => {
    let p = t.parentId; const seen = new Set<string>();
    while (p && !seen.has(p)) { if (p === "__unplaced__") return true; seen.add(p); p = treeById.get(p)?.parentId ?? null; }
    return false;
  };
  const keep = tree.filter((t) => !(t.kind === "document" && isUnplaced(t)) && !(t.kind === "library" && t.parentId === "__unplaced__"));
  const kids = new Map<string, number>();
  for (const t of keep) if (t.parentId) kids.set(t.parentId, (kids.get(t.parentId) ?? 0) + 1);

  const children = new Map<string | null, TreeNode[]>();
  for (const t of keep) children.set(t.parentId, [...(children.get(t.parentId) ?? []), t]);
  const weight = new Map<string, number>();
  const w = (t: TreeNode): number => {
    const c = weight.get(t.id); if (c !== undefined) return c;
    const v = 1 + (children.get(t.id) ?? []).reduce((s2, k) => s2 + w(k), 0);
    weight.set(t.id, v); return v;
  };
  const roots = children.get(null) ?? [];
  const total = roots.reduce((s2, r) => s2 + w(r), 0);
  const pos: Record<string, [number, number, number]> = {};
  // Biggest areas first, so they take the roomiest spots.
  const byWeight = (l: TreeNode[]) => [...l].sort((p, q) => w(q) - w(p) || p.label.localeCompare(q.label));
  const place = (t: TreeNode, at: V3, dir: V3, depth: number) => {
    pos[t.id] = at;
    const kids = byWeight(children.get(t.id) ?? []);
    if (!kids.length) return;
    // A wider cone for more children, narrowing with depth so clusters
    // stay apart.
    const angle = Math.min(1.3, (0.32 + 0.15 * Math.sqrt(kids.length)) * Math.pow(0.78, depth));
    const dirs = capDirections(dir, kids.length, angle);
    kids.forEach((k, i) => {
      const len = 70 + 24 * Math.sqrt(w(k)) + (kids.length > 12 ? 40 : 0);
      place(k, [at[0] + dirs[i][0] * len, at[1] + dirs[i][1] * len, at[2] + dirs[i][2] * len], dirs[i], depth + 1);
    });
  };
  // Small enough that the clusters fill the globe, big enough that they
  // never touch.
  const R0 = 110 + 15 * Math.sqrt(total) + 30 * Math.sqrt(roots.length);
  const rootDirs = capDirections([0, 1, 0], roots.length, Math.PI);
  byWeight(roots).forEach((r, i) => place(r, [rootDirs[i][0] * R0, rootDirs[i][1] * R0, rootDirs[i][2] * R0], rootDirs[i], 0));
  // The site at the centre, a spoke to each area: one estate, not islands.
  pos[HUB] = [0, 0, 0];

  const typeOf = (t: TreeNode): GraphNodeType => (t.kind === "area" ? "unit" : t.kind === "category" ? "plant" : t.kind === "asset" ? "asset" : t.kind === "project" ? "project" : t.kind === "document" ? "document" : "library");
  const outNodes: GraphNode[] = keep.map((t) => {
    const g = t.graphId ? byId.get(t.graphId) : undefined;
    const label = t.label;
    return g ? { ...g, label } : { id: t.id, type: typeOf(t), label, href: "#", degree: kids.get(t.id) ?? 0, sub: t.kind === "category" ? "Equipment type" : "Group" };
  });
  const keepIds = new Set(keep.map((t) => t.id));
  const outEdges: GraphEdge[] = keep.filter((t) => t.parentId && keepIds.has(t.parentId)).map((t) => {
    const parent = treeById.get(t.parentId!)!;
    return { a: t.parentId!, b: t.id, type: t.kind === "document" ? (parent.kind === "project" ? "project" : "tag") : parent.kind === "group" || parent.kind === "library" ? "library" : "unit" };
  });
  if (roots.length > 1) {
    outNodes.push({ id: HUB, type: "plant", label: "Site", href: "#", degree: roots.length, sub: "Every operating area" });
    for (const r of roots) outEdges.push({ a: HUB, b: r.id, type: "unit" });
  } else delete pos[HUB];
  return { nodes: outNodes, edges: outEdges, pos };
}
