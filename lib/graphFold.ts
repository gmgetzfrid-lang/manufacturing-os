// lib/graphFold.ts — fold the starburst. A document whose only link in the
// view is one hub (its unit, its library) is drawn inside that hub as a
// count. Hubs a person opened stay open. Only hubs holding at least `min`
// such documents fold; a hub with two documents stays as it is. Pure.

export interface FoldNode { id: string; type: string; label: string; sub?: string }
export interface FoldEdge { a: string; b: string }

export function foldLeaves<N extends FoldNode, E extends FoldEdge>(nodes: N[], edges: E[], opts: { open: Set<string>; min?: number }): { nodes: N[]; edges: E[]; folded: Map<string, number> } {
  const min = opts.min ?? 5;
  const nb = new Map<string, Set<string>>();
  for (const e of edges) {
    if (!nb.has(e.a)) nb.set(e.a, new Set());
    if (!nb.has(e.b)) nb.set(e.b, new Set());
    nb.get(e.a)!.add(e.b); nb.get(e.b)!.add(e.a);
  }
  const byHub = new Map<string, string[]>();
  for (const n of nodes) {
    if (n.type !== "document") continue;
    const s = nb.get(n.id);
    if (!s || s.size !== 1) continue;
    const hub = [...s][0];
    if (opts.open.has(hub)) continue;
    byHub.set(hub, [...(byHub.get(hub) ?? []), n.id]);
  }
  const folded = new Map<string, number>();
  const drop = new Set<string>();
  for (const [hub, leaves] of byHub) if (leaves.length >= min) { folded.set(hub, leaves.length); for (const l of leaves) drop.add(l); }
  if (!drop.size) return { nodes, edges, folded };
  const out = nodes.filter((n) => !drop.has(n.id)).map((n) => {
    const c = folded.get(n.id);
    return c ? { ...n, label: `${n.label} (+${c})`, sub: `${n.sub ? `${n.sub} · ` : ""}${c} documents folded inside - click to open` } : n;
  });
  return { nodes: out, edges: edges.filter((e) => !drop.has(e.a) && !drop.has(e.b)), folded };
}
