// lib/pidTrace.ts — walking a P&ID the way a process engineer does.
//
// "What's between the crude charge pump and the preheat exchanger?" is a
// question no language model can answer by looking at a drawing, and the
// honest reason is that a P&ID is a picture of a graph, not a graph. Once the
// connectivity IS a graph — equipment as nodes, lines as edges, valves and
// instruments as what sits on those edges — the question becomes a traversal
// and the answer becomes exact.
//
// This is that traversal. Pure, so it's testable without a drawing, a
// database, or a model. What feeds it (extraction, vision, manual capture)
// can change completely without touching the part that has to be right.

/** A component sitting in a line: valve, orifice, spec break, instrument. */
export interface LineComponent {
  tag: string;
  kind: string;              // "valve" | "check" | "control" | "instrument" | …
  /** Position along the edge, 0 at `from`, 1 at `to`. Ordering only. */
  position?: number;
}

/** One connection between two pieces of equipment. */
export interface LineEdge {
  lineId: string;            // "L-44-098"
  from: string;              // equipment tag, normalized by the caller
  to: string;
  /** Which drawing carries this run — the answer must cite a sheet. */
  drawingId?: string;
  /** What's installed along it, in flow order where known. */
  components?: LineComponent[];
  /** TRUE when this edge crosses a sheet boundary via an off-page connector.
   *  A trace that silently walks off-page reads as one drawing when it isn't. */
  offPage?: boolean;
}

export interface TraceStep {
  lineId: string;
  from: string;
  to: string;
  drawingId?: string;
  offPage: boolean;
  components: LineComponent[];
}

export interface TraceResult {
  found: boolean;
  /** Equipment tags in order, start → end. */
  path: string[];
  /** The runs between them, in order. */
  steps: TraceStep[];
  /** Everything installed along the whole route, in order of travel. */
  components: LineComponent[];
  /** Sheets the route crosses — what you'd have to open to see it. */
  drawings: string[];
  /** Set when the trace failed, in words an engineer can act on. */
  reason?: string;
}

/** Punctuation-blind tag identity, matching the mention engine's rules. */
export function normalizeTag(tag: string): string {
  return tag.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

interface Adjacency {
  [tag: string]: Array<{ to: string; edge: LineEdge; reversed: boolean }>;
}

function buildAdjacency(edges: readonly LineEdge[]): Adjacency {
  const adj: Adjacency = {};
  const push = (a: string, b: string, edge: LineEdge, reversed: boolean) => {
    (adj[a] ??= []).push({ to: b, edge, reversed });
  };
  for (const e of edges) {
    const a = normalizeTag(e.from);
    const b = normalizeTag(e.to);
    if (!a || !b) continue;
    // Process flow has a direction, but "what's between these two" is asked
    // in both directions and answered the same way. Direction is preserved
    // per step so the answer can still say which way the product moves.
    push(a, b, e, false);
    push(b, a, e, true);
  }
  return adj;
}

function orderComponents(edge: LineEdge, reversed: boolean): LineComponent[] {
  const list = [...(edge.components ?? [])];
  list.sort((x, y) => (x.position ?? 0.5) - (y.position ?? 0.5));
  return reversed ? list.reverse() : list;
}

/**
 * Shortest route between two pieces of equipment.
 *
 * Breadth-first, so the answer is the fewest runs rather than an arbitrary
 * one — an engineer asking "what's between" means the direct route, and a
 * traversal that wanders through the whole unit is technically a path and
 * practically a wrong answer.
 *
 * `maxHops` bounds a search on a plant-sized graph. Hitting it is reported,
 * never silently returned as "not connected" — those are completely different
 * facts and confusing them is how you conclude two systems are isolated when
 * they are not.
 */
export function tracePath(
  edges: readonly LineEdge[],
  startTag: string,
  endTag: string,
  maxHops = 25,
): TraceResult {
  const start = normalizeTag(startTag);
  const end = normalizeTag(endTag);
  const empty: TraceResult = { found: false, path: [], steps: [], components: [], drawings: [] };

  if (!start || !end) return { ...empty, reason: "Both a start and an end tag are required." };
  if (start === end) {
    return { found: true, path: [start], steps: [], components: [], drawings: [] };
  }

  const adj = buildAdjacency(edges);
  if (!adj[start]) return { ...empty, reason: `${startTag} doesn't appear on any traced line.` };
  if (!adj[end]) return { ...empty, reason: `${endTag} doesn't appear on any traced line.` };

  // BFS with parent links.
  const parent = new Map<string, { from: string; edge: LineEdge; reversed: boolean }>();
  const seen = new Set<string>([start]);
  let frontier = [start];
  let hops = 0;
  let reached = false;

  while (frontier.length > 0 && hops < maxHops && !reached) {
    const next: string[] = [];
    for (const node of frontier) {
      for (const link of adj[node] ?? []) {
        if (seen.has(link.to)) continue;
        seen.add(link.to);
        parent.set(link.to, { from: node, edge: link.edge, reversed: link.reversed });
        if (link.to === end) { reached = true; break; }
        next.push(link.to);
      }
      if (reached) break;
    }
    frontier = next;
    hops += 1;
  }

  if (!reached) {
    return {
      ...empty,
      reason: hops >= maxHops
        ? `No route within ${maxHops} runs. They may still be connected further out.`
        : `No traced route connects ${startTag} to ${endTag}.`,
    };
  }

  // Walk the parent chain back, then reverse into travel order.
  const steps: TraceStep[] = [];
  const path: string[] = [end];
  let cursor = end;
  while (cursor !== start) {
    const p = parent.get(cursor);
    if (!p) break;                                   // defensive; unreachable
    steps.push({
      lineId: p.edge.lineId,
      from: p.reversed ? p.edge.to : p.edge.from,
      to: p.reversed ? p.edge.from : p.edge.to,
      drawingId: p.edge.drawingId,
      offPage: !!p.edge.offPage,
      components: orderComponents(p.edge, p.reversed),
    });
    path.push(p.from);
    cursor = p.from;
  }
  steps.reverse();
  path.reverse();

  const components = steps.flatMap((s) => s.components);
  const drawings = [...new Set(steps.map((s) => s.drawingId).filter((d): d is string => !!d))];
  return { found: true, path, steps, components, drawings };
}

/**
 * Everything reachable from one piece of equipment within N runs.
 *
 * The isolation question: "if I blind this exchanger, what am I touching?"
 * Returns tags with the hop count so a reader can tell immediate neighbours
 * from things three runs away.
 */
export function traceNeighbourhood(
  edges: readonly LineEdge[],
  startTag: string,
  hops = 2,
): Array<{ tag: string; hops: number }> {
  const start = normalizeTag(startTag);
  const adj = buildAdjacency(edges);
  if (!start || !adj[start]) return [];

  const distance = new Map<string, number>([[start, 0]]);
  let frontier = [start];
  for (let d = 1; d <= hops; d++) {
    const next: string[] = [];
    for (const node of frontier) {
      for (const link of adj[node] ?? []) {
        if (distance.has(link.to)) continue;
        distance.set(link.to, d);
        next.push(link.to);
      }
    }
    frontier = next;
    if (frontier.length === 0) break;
  }
  distance.delete(start);
  return [...distance.entries()]
    .map(([tag, h]) => ({ tag, hops: h }))
    .sort((a, b) => a.hops - b.hops || a.tag.localeCompare(b.tag));
}

/**
 * Off-page connectors that go nowhere.
 *
 * A continuation that names a destination drawing which has no matching
 * inbound run is a broken reference: the line leaves the sheet and nothing
 * catches it. This is the audit that finds drawing sets which look complete
 * and aren't.
 */
export function findBrokenConnectors(
  edges: readonly LineEdge[],
): Array<{ lineId: string; drawingId?: string; from: string; danglingAt: string }> {
  const seenAsSource = new Set<string>();
  for (const e of edges) seenAsSource.add(normalizeTag(e.from));

  const broken: Array<{ lineId: string; drawingId?: string; from: string; danglingAt: string }> = [];
  for (const e of edges) {
    if (!e.offPage) continue;
    const dest = normalizeTag(e.to);
    // An off-page run whose destination never appears as the source of any
    // other run has no continuation on the receiving sheet.
    if (!seenAsSource.has(dest)) {
      broken.push({ lineId: e.lineId, drawingId: e.drawingId, from: e.from, danglingAt: e.to });
    }
  }
  return broken;
}
