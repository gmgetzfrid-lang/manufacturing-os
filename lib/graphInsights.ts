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
//
// Everything here is computed over the nodes and edges it is GIVEN — and the
// document side of the org graph is the reader's own (documents RLS), so the
// same plant can show a controller and a viewer different orphans, hubs and
// bridges (GM-6). `basis` says so, with the count the reader cannot see.

import type { GraphNode, GraphEdge, GraphNodeType, GraphAccess } from "@/lib/orgGraph";

export interface GraphInsights {
  orphans: GraphNode[];
  hubs: Array<{ node: GraphNode; degree: number }>;
  bridges: Array<{
    a: GraphNode; b: GraphNode;
    /** Node counts of the two sides the edge holds together. */
    sideA: number; sideB: number;
  }>;
  regions: Array<{ label: string; ids: string[] }>;
  /** GM-6 — what these answers were computed over. Always viewer-scoped:
   *  `outsideAccess` documents (when known) are not in them, and `note` is
   *  the line to show beside the counts. */
  basis: { viewerScoped: true; outsideAccess: number | null; note: string };
}

/** GM-6 — the label the insights carry: computed under the reader's ACL. */
export function insightsBasisNote(access?: GraphAccess | null): string {
  const n = access?.outsideAccess ?? null;
  if (n && n > 0) {
    return `Computed on the documents you can see — ${n.toLocaleString("en-US")} more ${n === 1 ? "is" : "are"} outside your access, so another reader may get different answers.`;
  }
  if (n === 0) return "Computed on every document in the org — you can see all of them.";
  return "Computed on the documents you can see.";
}

/** Library-membership edges are organizational, not contextual — every
 *  analysis here runs on the meaningful web only. */
const contextEdges = (edges: GraphEdge[]) => edges.filter((e) => e.type !== "library");

/** Which node types can be "orphaned" — grouping nodes (units, plants) are
 *  dropped at degree 0 during assembly, so only content nodes remain. */
const ORPHANABLE: ReadonlySet<GraphNodeType> = new Set(["document", "asset"] as GraphNodeType[]);

/** Preference for naming a region (lower wins): the unit anchors the
 *  neighborhood if one is present, then the dominant library/project/asset.
 *  A Record, so a new GraphNodeType that is not ranked here is a compile
 *  error (GM-9 — "plot" was missing from the old list, indexOf answered -1,
 *  and a plot plan outranked every unit). */
const REGION_ANCHOR_RANK: Record<GraphNodeType, number> = {
  unit: 0, library: 1, project: 2, asset: 3, plant: 4, document: 5, plot: 6,
};

export function computeInsights(
  nodes: GraphNode[], edges: GraphEdge[],
  opts?: { hubCount?: number; minBridgeSide?: number; minRegionSize?: number; access?: GraphAccess | null },
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

  // ── Adjacency — one logical link per node PAIR (GM-5) ───────────────
  // Several edge types between the same two nodes — a drawing both tagged to
  // a vessel (document_assets) and naming it in its text (entity_mentions),
  // a flow in each direction — are one relationship between those two
  // things, not redundant paths: remove the pair and the clusters still
  // fall apart. Bridges are therefore found on the pair graph, and a pair is
  // never disqualified for carrying more than one edge type.
  const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const pairs = new Set<string>();
  for (const e of web) pairs.add(pairKey(e.a, e.b));
  const adj = new Map<string, string[]>();
  for (const k of pairs) {
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
        // v === parent: the one pair back to the parent (adjacency holds
        // each pair once, so there is no parallel edge to tell apart).
      } else {
        stack.pop();
        if (parent !== null) {
          low.set(parent, Math.min(low.get(parent)!, low.get(u)!));
          subtree.set(parent, subtree.get(parent)! + subtree.get(u)!);
          if (low.get(u)! > disc.get(parent)!) {
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
    let anchorRank = Number.POSITIVE_INFINITY;
    let anchorDegree = -1;
    for (const id of members) {
      const n = byId.get(id);
      if (!n) continue;
      const rank = REGION_ANCHOR_RANK[n.type] ?? Number.POSITIVE_INFINITY;
      const d = degree.get(id) ?? 0;
      if (rank < anchorRank || (rank === anchorRank && d > anchorDegree)) {
        anchor = n; anchorRank = rank; anchorDegree = d;
      }
    }
    if (anchor) regions.push({ label: anchor.label, ids: members });
  }
  regions.sort((a, b) => b.ids.length - a.ids.length);

  return {
    orphans, hubs, bridges, regions: regions.slice(0, 12),
    basis: { viewerScoped: true, outsideAccess: opts?.access?.outsideAccess ?? null, note: insightsBasisNote(opts?.access) },
  };
}
