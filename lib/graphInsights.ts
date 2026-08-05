// lib/graphInsights.ts — what the shape of the graph is telling you.
//
// Pure analysis over the org graph (no I/O, fully unit-tested):
//
//   ORPHANS — documents and equipment floating with no meaningful context:
//     no equipment tag, no unit, no curated pin, no project. In a controlled
//     document system an orphan is a red flag: the file exists but nothing
//     ties it to the plant. Library membership alone doesn't count — a doc
//     that's only "in a folder" is exactly the silo problem.
//
//   HUBS — the nodes everything pulls toward. A heat exchanger referenced
//     by forty drawings is critical infrastructure in the data itself:
//     touch it and the blast radius is every line on the map.
//
//   BRIDGES — single edges whose removal splits a connected region in two
//     (Tarjan's bridge-finding). A thin line between two big clusters is
//     hidden cross-pollination: the one valve that appears in both the
//     corrosion file and the Unit 44 drawings.
//
//   REGIONS — connected clusters named after their strongest anchor, so the
//     zoomed-out map reads like a neighborhood map ("Crude Unit" over here,
//     "Standards" over there) and spatial memory can do its job.

import type { GraphNode, GraphEdge, GraphNodeType } from "@/lib/orgGraph";

export interface GraphInsights {
  orphans: GraphNode[];
  hubs: Array<{ node: GraphNode; degree: number }>;
  bridges: Array<{
    a: GraphNode; b: GraphNode;
    /** Node counts of the two sides the edge holds together. */
    sideA: number; sideB: number;
  }>;
  regions: Array<{ label: string; ids: string[] }>;
}

/** Library-membership edges are organizational, not contextual — every
 *  analysis here runs on the meaningful web only. */
const contextEdges = (edges: GraphEdge[]) => edges.filter((e) => e.type !== "library");

/** Which node types can be "orphaned" — grouping nodes (units, plants) are
 *  dropped at degree 0 during assembly, so only content nodes remain. */
const ORPHANABLE: ReadonlySet<GraphNodeType> = new Set(["document", "asset"] as GraphNodeType[]);

/** Preference order for naming a region: the unit anchors the neighborhood
 *  if one is present, then the dominant library/project/asset. */
const REGION_ANCHOR_ORDER: GraphNodeType[] = ["unit", "library", "project", "asset", "plant", "document"];

export function computeInsights(
  nodes: GraphNode[], edges: GraphEdge[],
  opts?: { hubCount?: number; minBridgeSide?: number; minRegionSize?: number },
): GraphInsights {
  const hubCount = opts?.hubCount ?? 12;
  const minBridgeSide = opts?.minBridgeSide ?? 4;
  const minRegionSize = opts?.minRegionSize ?? 8;

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const web = contextEdges(edges).filter((e) => byId.has(e.a) && byId.has(e.b));

  // ── Degrees on the meaningful web ────────────────────────────────────
  const degree = new Map<string, number>();
  for (const e of web) {
    degree.set(e.a, (degree.get(e.a) ?? 0) + 1);
    degree.set(e.b, (degree.get(e.b) ?? 0) + 1);
  }

  const orphans = nodes
    .filter((n) => ORPHANABLE.has(n.type) && !degree.has(n.id))
    .sort((a, b) => a.label.localeCompare(b.label));

  const hubs = nodes
    .map((node) => ({ node, degree: degree.get(node.id) ?? 0 }))
    .filter((h) => h.degree >= 3)
    .sort((x, y) => y.degree - x.degree)
    .slice(0, hubCount);

  // ── Adjacency (dedup parallel edges into one logical link, but remember
  // multiplicity: a pair connected twice can never be a bridge) ─────────
  const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const multiplicity = new Map<string, number>();
  for (const e of web) {
    const k = pairKey(e.a, e.b);
    multiplicity.set(k, (multiplicity.get(k) ?? 0) + 1);
  }
  const adj = new Map<string, string[]>();
  for (const k of multiplicity.keys()) {
    const [a, b] = k.split("|");
    (adj.get(a) ?? adj.set(a, []).get(a)!).push(b);
    (adj.get(b) ?? adj.set(b, []).get(b)!).push(a);
  }

  // ── Connected components (iterative BFS) ─────────────────────────────
  const component = new Map<string, number>();
  const componentMembers: string[][] = [];
  for (const n of nodes) {
    if (component.has(n.id) || !adj.has(n.id)) continue;
    const compId = componentMembers.length;
    const members: string[] = [];
    const queue = [n.id];
    component.set(n.id, compId);
    while (queue.length > 0) {
      const cur = queue.pop()!;
      members.push(cur);
      for (const next of adj.get(cur) ?? []) {
        if (!component.has(next)) { component.set(next, compId); queue.push(next); }
      }
    }
    componentMembers.push(members);
  }

  // ── Bridges — iterative Tarjan with subtree sizes ────────────────────
  const disc = new Map<string, number>();
  const low = new Map<string, number>();
  const subtree = new Map<string, number>();
  const bridgePairs: Array<{ aId: string; bId: string; childSide: number }> = [];
  let timer = 0;

  for (const root of adj.keys()) {
    if (disc.has(root)) continue;
    // Frame: [node, parent, childIndex]
    const stack: Array<[string, string | null, number]> = [[root, null, 0]];
    disc.set(root, timer); low.set(root, timer); subtree.set(root, 1); timer++;
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const [u, parent] = frame;
      const neighbors = adj.get(u) ?? [];
      if (frame[2] < neighbors.length) {
        const v = neighbors[frame[2]++];
        if (!disc.has(v)) {
          disc.set(v, timer); low.set(v, timer); subtree.set(v, 1); timer++;
          stack.push([v, u, 0]);
        } else if (v !== parent) {
          low.set(u, Math.min(low.get(u)!, disc.get(v)!));
        }
        // v === parent: skip exactly one edge back to the parent —
        // multiplicity handles genuine parallel edges below.
      } else {
        stack.pop();
        if (parent !== null) {
          low.set(parent, Math.min(low.get(parent)!, low.get(u)!));
          subtree.set(parent, subtree.get(parent)! + subtree.get(u)!);
          if (low.get(u)! > disc.get(parent)! && (multiplicity.get(pairKey(parent, u)) ?? 0) === 1) {
            bridgePairs.push({ aId: parent, bId: u, childSide: subtree.get(u)! });
          }
        }
      }
    }
  }

  const bridges = bridgePairs
    .map(({ aId, bId, childSide }) => {
      const compSize = componentMembers[component.get(aId)!]?.length ?? 0;
      const sideB = childSide;
      const sideA = compSize - childSide;
      return { a: byId.get(aId)!, b: byId.get(bId)!, sideA, sideB };
    })
    .filter((b) => Math.min(b.sideA, b.sideB) >= minBridgeSide)
    .sort((x, y) => Math.min(y.sideA, y.sideB) - Math.min(x.sideA, x.sideB))
    .slice(0, 20);

  // ── Regions — name each big component after its strongest anchor ─────
  const regions: GraphInsights["regions"] = [];
  for (const members of componentMembers) {
    if (members.length < minRegionSize) continue;
    let anchor: GraphNode | null = null;
    let anchorRank = REGION_ANCHOR_ORDER.length;
    let anchorDegree = -1;
    for (const id of members) {
      const n = byId.get(id);
      if (!n) continue;
      const rank = REGION_ANCHOR_ORDER.indexOf(n.type);
      const d = degree.get(id) ?? 0;
      if (rank < anchorRank || (rank === anchorRank && d > anchorDegree)) {
        anchor = n; anchorRank = rank; anchorDegree = d;
      }
    }
    if (anchor) regions.push({ label: anchor.label, ids: members });
  }
  regions.sort((a, b) => b.ids.length - a.ids.length);

  return { orphans, hubs, bridges, regions: regions.slice(0, 12) };
}
