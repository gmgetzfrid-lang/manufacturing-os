// lib/estate3d.ts — the estate tree, standing up in 3D.
//
// The same tree as the Map (operating area → equipment type → equipment →
// documents), laid out with the same no-overlap balloon layout on the
// ground, then lifted by level: areas on the floor, equipment types above
// them, equipment above those, the drawings at the top. Every position is
// fixed — no physics, no starburst — so the 3D view is a place you can
// learn, not a cloud that re-forms each visit. Unplaced documents are not
// drawn one by one; their group carries the count. Pure.

import { balloonLayout, type LayoutNode } from "@/lib/fileFinder/balloonLayout";
import { buildEstateTree, type TreeNode } from "@/lib/estateTree";
import type { GraphNode, GraphEdge, GraphNodeType } from "@/lib/orgGraph";

const LEVEL = 90;
/** The ground layout is drawn in screen pixels; in 3D the nodes are small
 *  spheres, so the floor plan is tightened to keep them close. */
const SCALE = 0.55;
const R: Record<TreeNode["kind"], number> = { group: 24, area: 26, category: 18, asset: 14, project: 18, library: 16, document: 9 };

export function layeredEstate(nodes: GraphNode[], edges: GraphEdge[]): { nodes: GraphNode[]; edges: GraphEdge[]; pos: Record<string, [number, number, number]> } {
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

  const layout: LayoutNode[] = keep.map((t) => ({ id: t.id, parentId: t.parentId, r: R[t.kind], labelPad: 14 }));
  const flat = balloonLayout(layout, { gap: 18 });
  const depth = (t: TreeNode): number => { let d = 0, p = t.parentId; const seen = new Set<string>(); while (p && !seen.has(p)) { seen.add(p); d++; p = treeById.get(p)?.parentId ?? null; } return d; };

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
  const pos: Record<string, [number, number, number]> = {};
  for (const t of keep) {
    const p = flat.get(t.id) ?? { x: 0, y: 0 };
    pos[t.id] = [p.x * SCALE, depth(t) * LEVEL, p.y * SCALE];
  }
  return { nodes: outNodes, edges: outEdges, pos };
}
