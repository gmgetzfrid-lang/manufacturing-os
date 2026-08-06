// lib/pipeTrace.ts — follow a pipe on a P&ID by reading the PIXELS.
//
// The first version of tracing asked a vision model for waypoint coordinates
// along a line. That is spatial coordinate regression over thin line-work —
// the thing vision models are worst at — and it produced strokes that landed
// in the right neighborhood and nowhere near the right pipe. Asking harder
// was never going to fix it: it was the wrong tool.
//
// Following a drawn line is image processing. This module does it properly,
// and it exploits the one thing that makes P&IDs tractable: THEY ARE DRAWN
// ORTHOGONALLY. Pipe runs are horizontal or vertical strokes. So:
//
//   1. binarize      — ink vs paper
//   2. extractSegments — find maximal horizontal and vertical strokes.
//        Text falls out here for free: letterforms never produce straight
//        runs of pipe length, so a minimum-run filter deletes the entire
//        annotation layer without ever "reading" it.
//   3. buildNetwork  — where strokes meet, and CRUCIALLY what kind of meeting
//        it is. A "+" where both strokes continue past the meeting point is a
//        CROSSING (two pipes passing over each other, the single most common
//        way a naive tracer jumps onto the wrong line). A "T" where one stroke
//        terminates is a real branch. Same pixels, opposite meanings.
//   4. tracePipe     — A* over the junction network, priced so the search
//        behaves like a pipefitter's finger: continuing straight is cheap,
//        turning costs real money, and turning at a crossing is nearly
//        forbidden.
//
// Everything here is pure and synchronous — no canvas, no network, no PDF —
// so the hard part is unit-testable against synthetic rasters.

export interface Raster {
  width: number;
  height: number;
  /** 1 = ink, 0 = paper. Row-major, length width*height. */
  ink: Uint8Array;
}

export interface Point { x: number; y: number }

/** A maximal straight stroke of ink. `a`..`b` runs along the stroke's axis;
 *  `c` is its position on the other axis (the center line). */
export interface Segment {
  id: number;
  horizontal: boolean;
  a: number;
  b: number;
  c: number;
  thickness: number;
}

export const segLength = (s: Segment): number => s.b - s.a;
const segStart = (s: Segment): Point => (s.horizontal ? { x: s.a, y: s.c } : { x: s.c, y: s.a });
const segEnd = (s: Segment): Point => (s.horizontal ? { x: s.b, y: s.c } : { x: s.c, y: s.b });

export interface ExtractOptions {
  /** Strokes shorter than this are annotation, not pipe. The single most
   *  important knob: it is what makes text disappear. */
  minRun?: number;
  /** Strokes fatter than this are filled symbols or solid blocks. */
  maxThickness?: number;
}

export interface TraceOptions extends ExtractOptions {
  /** Two strokes this far apart on the cross axis are the same center line. */
  alignTolerance?: number;
  /** White gap a run may jump — line breaks at crossing hops, dimension
   *  arrows, and label interruptions. */
  maxGap?: number;
  /** Cost of changing direction, in pixels-equivalent. High enough that the
   *  search prefers a long straight run over a short zigzag. */
  turnPenalty?: number;
  /** Extra cost for turning at a CROSSING — where both strokes continue
   *  through, so a turn means hopping onto an unrelated pipe. */
  crossingPenalty?: number;
  /** How far from the given endpoint we may look for a pipe to start on. */
  snapRadius?: number;
}

const DEFAULTS = {
  minRun: 14,
  maxThickness: 10,
  alignTolerance: 3,
  maxGap: 14,
  turnPenalty: 45,
  crossingPenalty: 4000,
  snapRadius: 130,
};

/** Ink vs paper. CAD exports anti-alias, so the threshold sits well above
 *  pure black and transparent pixels count as paper. */
export function binarize(
  rgba: Uint8ClampedArray, width: number, height: number, threshold = 170,
): Raster {
  const ink = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < ink.length; i++, p += 4) {
    const lum = (rgba[p] * 299 + rgba[p + 1] * 587 + rgba[p + 2] * 114) / 1000;
    ink[i] = rgba[p + 3] > 32 && lum < threshold ? 1 : 0;
  }
  return { width, height, ink };
}

/** Runs of ink along one row (horizontal) or column (vertical). */
function runsAlongLine(
  raster: Raster, index: number, horizontal: boolean, minRun: number,
): Array<{ a: number; b: number }> {
  const { width, height, ink } = raster;
  const span = horizontal ? width : height;
  const out: Array<{ a: number; b: number }> = [];
  let start = -1;
  for (let i = 0; i < span; i++) {
    const on = horizontal ? ink[index * width + i] : ink[i * width + index];
    if (on) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      if (i - start >= minRun) out.push({ a: start, b: i - 1 });
      start = -1;
    }
  }
  if (start >= 0 && span - start >= minRun) out.push({ a: start, b: span - 1 });
  return out;
}

/** Find every maximal horizontal and vertical stroke.
 *
 *  A 3-pixel-thick pipe shows up as three near-identical runs on consecutive
 *  rows; those merge into ONE segment whose center line is the average, so
 *  downstream geometry deals with center lines rather than pixel rows. */
export function extractSegments(raster: Raster, opts: TraceOptions = {}): Segment[] {
  const minRun = opts.minRun ?? DEFAULTS.minRun;
  const maxThickness = opts.maxThickness ?? DEFAULTS.maxThickness;
  const segments: Segment[] = [];
  let nextId = 0;

  for (const horizontal of [true, false]) {
    const lines = horizontal ? raster.height : raster.width;
    // Strokes still growing downward (or rightward) from the previous line.
    let open: Array<{ a: number; b: number; cFirst: number; cLast: number }> = [];

    const close = (o: { a: number; b: number; cFirst: number; cLast: number }) => {
      const thickness = o.cLast - o.cFirst + 1;
      if (thickness > maxThickness) return;          // filled block, not a pipe
      if (o.b - o.a < minRun) return;
      segments.push({
        id: nextId++, horizontal, a: o.a, b: o.b,
        c: (o.cFirst + o.cLast) / 2, thickness,
      });
    };

    for (let i = 0; i < lines; i++) {
      const runs = runsAlongLine(raster, i, horizontal, minRun);
      const next: typeof open = [];
      const used = new Set<number>();
      for (const run of runs) {
        // Continue the open stroke that overlaps this run the most — a stroke
        // is "the same stroke" one row down when it covers the same span.
        let best = -1;
        let bestOverlap = 0;
        for (let k = 0; k < open.length; k++) {
          if (used.has(k)) continue;
          const o = open[k];
          if (o.cLast !== i - 1) continue;
          const overlap = Math.min(o.b, run.b) - Math.max(o.a, run.a) + 1;
          const shorter = Math.min(o.b - o.a, run.b - run.a) + 1;
          if (overlap > bestOverlap && overlap >= shorter * 0.6) {
            best = k; bestOverlap = overlap;
          }
        }
        if (best >= 0) {
          const o = open[best];
          used.add(best);
          next.push({ a: Math.min(o.a, run.a), b: Math.max(o.b, run.b), cFirst: o.cFirst, cLast: i });
        } else {
          next.push({ a: run.a, b: run.b, cFirst: i, cLast: i });
        }
      }
      for (let k = 0; k < open.length; k++) if (!used.has(k)) close(open[k]);
      open = next;
    }
    for (const o of open) close(o);
  }
  return segments;
}

interface Node {
  id: number;
  x: number;
  y: number;
  /** True where two strokes CROSS (both continue past the meeting point).
   *  Turning here means changing pipes, not following one. */
  crossing: boolean;
}

interface Edge {
  to: number;
  cost: number;
  horizontal: boolean;
}

export interface Network {
  nodes: Node[];
  edges: Edge[][];
}

const keyOf = (x: number, y: number) => `${Math.round(x)},${Math.round(y)}`;

/** Build the junction network: where strokes meet, what kind of meeting it
 *  is, and the pipe stretches between meetings. */
export function buildNetwork(segments: Segment[], opts: TraceOptions = {}): Network {
  const tol = opts.alignTolerance ?? DEFAULTS.alignTolerance;
  const maxGap = opts.maxGap ?? DEFAULTS.maxGap;

  const nodes: Node[] = [];
  const byKey = new Map<string, number>();
  const addNode = (x: number, y: number, crossing: boolean): number => {
    const k = keyOf(x, y);
    const existing = byKey.get(k);
    if (existing !== undefined) {
      if (crossing) nodes[existing].crossing = true;
      return existing;
    }
    const id = nodes.length;
    nodes.push({ id, x, y, crossing });
    byKey.set(k, id);
    return id;
  };

  // Points sitting on each segment, to be threaded into a chain later.
  const onSegment = new Map<number, Array<{ at: number; node: number }>>();
  const mark = (seg: Segment, at: number, node: number) => {
    const list = onSegment.get(seg.id) ?? [];
    list.push({ at, node });
    onSegment.set(seg.id, list);
  };

  const horizontals = segments.filter((s) => s.horizontal);
  const verticals = segments.filter((s) => !s.horizontal);

  for (const h of horizontals) {
    for (const v of verticals) {
      // Do the strokes reach each other?
      if (v.c < h.a - tol || v.c > h.b + tol) continue;
      if (h.c < v.a - tol || h.c > v.b + tol) continue;
      // CROSSING vs TEE — the distinction a naive tracer misses. A crossing
      // has both strokes continuing through the meeting point; a tee has at
      // least one terminating there.
      const eps = tol + 1;
      const vThrough = v.a < h.c - eps && v.b > h.c + eps;
      const hThrough = h.a < v.c - eps && h.b > v.c + eps;
      const node = addNode(v.c, h.c, vThrough && hThrough);
      mark(h, v.c, node);
      mark(v, h.c, node);
    }
  }

  // Endpoints are nodes too — a run has to be enterable at its ends.
  for (const s of segments) {
    mark(s, s.a, addNode(segStart(s).x, segStart(s).y, false));
    mark(s, s.b, addNode(segEnd(s).x, segEnd(s).y, false));
  }

  const edges: Edge[][] = nodes.map(() => []);
  const link = (from: number, to: number, cost: number, horizontal: boolean) => {
    if (from === to) return;
    edges[from].push({ to, cost, horizontal });
    edges[to].push({ to: from, cost, horizontal });
  };

  // Thread each segment's points into a chain of pipe stretches.
  for (const s of segments) {
    const list = (onSegment.get(s.id) ?? []).sort((p, q) => p.at - q.at);
    for (let i = 1; i < list.length; i++) {
      link(list[i - 1].node, list[i].node, list[i].at - list[i - 1].at, s.horizontal);
    }
  }

  // Collinear continuation across a gap: the same pipe interrupted by a
  // crossing hop, a dimension, or a label. Same direction, so no turn.
  for (const group of [horizontals, verticals]) {
    const sorted = [...group].sort((p, q) => p.c - q.c || p.a - q.a);
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const s = sorted[i], t = sorted[j];
        if (Math.abs(s.c - t.c) > tol) break;         // sorted by c — done here
        const gap = t.a - s.b;
        if (gap <= 0 || gap > maxGap) continue;
        const from = byKey.get(keyOf(segEnd(s).x, segEnd(s).y));
        const to = byKey.get(keyOf(segStart(t).x, segStart(t).y));
        if (from !== undefined && to !== undefined) link(from, to, gap, s.horizontal);
      }
    }
  }

  return { nodes, edges };
}

/** Nearest network node to a point, within a radius. */
function nearestNode(network: Network, p: Point, radius: number): number | null {
  let best: number | null = null;
  let bestD = radius * radius;
  for (const n of network.nodes) {
    const d = (n.x - p.x) ** 2 + (n.y - p.y) ** 2;
    if (d <= bestD) { bestD = d; best = n.id; }
  }
  return best;
}

/** Binary heap keyed by priority — the search visits tens of thousands of
 *  states on a real sheet, which is where a naive array scan falls over. */
class Heap {
  private items: Array<{ key: number; pri: number }> = [];
  get size() { return this.items.length; }
  push(key: number, pri: number) {
    const a = this.items;
    a.push({ key, pri });
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].pri <= a[i].pri) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop(): { key: number; pri: number } | undefined {
    const a = this.items;
    if (a.length === 0) return undefined;
    const top = a[0];
    const last = a.pop()!;
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l].pri < a[m].pri) m = l;
        if (r < a.length && a[r].pri < a[m].pri) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

export interface PipeTraceResult {
  ok: boolean;
  /** Pixel waypoints, corners only. */
  points: Point[];
  /** Plain-language reason when ok is false. */
  reason: string | null;
  /** How many direction changes the route makes — a sanity signal. */
  turns: number;
}

/** Follow the pipe from `start` to `goal`.
 *
 *  Search state is (node, direction we arrived travelling) because the cost
 *  of leaving a node depends on whether we keep going straight. That is the
 *  whole trick: it makes "stay on this pipe" cheap and "hop to a pipe that
 *  merely crosses this one" expensive. */
export function tracePipe(
  network: Network, start: Point, goal: Point, opts: TraceOptions = {},
): PipeTraceResult {
  const turnPenalty = opts.turnPenalty ?? DEFAULTS.turnPenalty;
  const crossingPenalty = opts.crossingPenalty ?? DEFAULTS.crossingPenalty;
  const snapRadius = opts.snapRadius ?? DEFAULTS.snapRadius;

  const startNode = nearestNode(network, start, snapRadius);
  const goalNode = nearestNode(network, goal, snapRadius);
  if (startNode === null || goalNode === null) {
    return {
      ok: false, points: [], turns: 0,
      reason: "No pipe found near one of the two tags on this sheet — the marker may be off, or the connection may be drawn on another sheet.",
    };
  }
  if (startNode === goalNode) {
    return { ok: false, points: [], turns: 0, reason: "Both tags resolve to the same point on the drawing." };
  }

  const goalPt = network.nodes[goalNode];
  const h = (id: number) => {
    const n = network.nodes[id];
    return Math.abs(n.x - goalPt.x) + Math.abs(n.y - goalPt.y);
  };

  // Two states per node: arrived horizontally (0) or vertically (1).
  const stateId = (node: number, horiz: boolean) => node * 2 + (horiz ? 0 : 1);
  const g = new Map<number, number>();
  const cameFrom = new Map<number, number>();
  const open = new Heap();

  for (const dir of [true, false]) {
    const s = stateId(startNode, dir);
    g.set(s, 0);
    open.push(s, h(startNode));
  }

  let goalState: number | null = null;
  let guard = 0;
  const GUARD_MAX = 400_000;
  while (open.size > 0) {
    if (++guard > GUARD_MAX) break;
    const top = open.pop()!;
    const node = top.key >> 1;
    const arrivedHoriz = (top.key & 1) === 0;
    const cost = g.get(top.key);
    if (cost === undefined || top.pri > cost + h(node) + 0.001) continue;   // stale
    if (node === goalNode) { goalState = top.key; break; }

    for (const e of network.edges[node]) {
      let step = e.cost;
      if (e.horizontal !== arrivedHoriz) {
        step += turnPenalty;
        // Turning where two pipes merely cross means leaving the pipe we are
        // following for one that has nothing to do with it.
        if (network.nodes[node].crossing) step += crossingPenalty;
      }
      const nextState = stateId(e.to, e.horizontal);
      const tentative = cost + step;
      const known = g.get(nextState);
      if (known !== undefined && known <= tentative) continue;
      g.set(nextState, tentative);
      cameFrom.set(nextState, top.key);
      open.push(nextState, tentative + h(e.to));
    }
  }

  if (goalState === null) {
    return {
      ok: false, points: [], turns: 0,
      reason: "Followed the line-work but found no continuous run between those two tags on this sheet — the path likely leaves the sheet at an off-page connector.",
    };
  }

  // Walk the parents back to the start.
  const chain: number[] = [];
  for (let s: number | undefined = goalState; s !== undefined; s = cameFrom.get(s)) {
    chain.push(s >> 1);
    if (!cameFrom.has(s)) break;
  }
  chain.reverse();

  const raw = chain.map((id) => ({ x: network.nodes[id].x, y: network.nodes[id].y }));
  const points = dropCollinear(raw);
  let turns = 0;
  for (let i = 2; i < points.length; i++) {
    const a = points[i - 2], b = points[i - 1], c = points[i];
    if ((a.x === b.x) !== (b.x === c.x)) turns++;
  }
  return { ok: points.length >= 2, points, reason: null, turns };
}

/** Collapse runs of points that lie on one straight stretch — the drawn line
 *  has a corner only where it actually changes direction. */
export function dropCollinear(points: Point[]): Point[] {
  if (points.length <= 2) return [...points];
  const out: Point[] = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    const a = out[out.length - 1], b = points[i], c = points[i + 1];
    const abH = Math.abs(a.y - b.y) <= 1, bcH = Math.abs(b.y - c.y) <= 1;
    const abV = Math.abs(a.x - b.x) <= 1, bcV = Math.abs(b.x - c.x) <= 1;
    if ((abH && bcH) || (abV && bcV)) continue;      // still going the same way
    out.push(b);
  }
  out.push(points[points.length - 1]);
  return out;
}

/** The whole job, from pixels to normalized waypoints the viewer can stroke.
 *  Coordinates in and out are 0..1 fractions of the page. */
export function tracePipeOnRaster(
  raster: Raster,
  startFrac: Point,
  goalFrac: Point,
  opts: TraceOptions = {},
): PipeTraceResult & { segments: number } {
  const toPx = (p: Point): Point => ({ x: p.x * raster.width, y: p.y * raster.height });
  const segments = extractSegments(raster, opts);
  if (segments.length === 0) {
    return {
      ok: false, points: [], turns: 0, segments: 0,
      reason: "No pipe-like line-work found on this page — if the sheet is a scan, it may be too low-resolution to follow.",
    };
  }
  const network = buildNetwork(segments, opts);
  const result = tracePipe(network, toPx(startFrac), toPx(goalFrac), opts);
  return {
    ...result,
    segments: segments.length,
    points: result.points.map((p) => ({ x: p.x / raster.width, y: p.y / raster.height })),
  };
}
