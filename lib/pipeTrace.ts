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
  /** White gap a collinear run may jump. Has to be GENEROUS: a real P&ID
   *  breaks the pipe to print its line number in the gap, and that legend can
   *  be a couple of hundred pixels wide at working resolution. Crossing hops
   *  and dimension arrows leave smaller ones. Jumping is priced by length so
   *  long jumps stay possible but expensive. */
  maxGap?: number;
  /** What each pixel of jumped white costs relative to drawn pipe. */
  gapCostMultiplier?: number;
  /** Endpoints this close bridge to each other regardless of direction —
   *  how the run gets through equipment symbols, 45° jogs, valve bodies and
   *  reducers, none of which are horizontal or vertical strokes. */
  bridgeRadius?: number;
  /** Cost of changing direction, in pixels-equivalent. High enough that the
   *  search prefers a long straight run over a short zigzag. */
  turnPenalty?: number;
  /** Extra cost for turning at a CROSSING — where both strokes continue
   *  through, so a turn means hopping onto an unrelated pipe. */
  crossingPenalty?: number;
  /** How far from a tag's marker we look for pipe to start (or finish) on.
   *  Every node inside this radius is a candidate, not just the nearest —
   *  a tag label sits BESIDE its equipment, and the equipment's connection
   *  can be on any side of it. */
  searchRadius?: number;
  /** What a pixel of distance between the tag and the pipe we start on costs,
   *  relative to a pixel of travel along the pipe. Well above 1 on purpose:
   *  distance from the tag is EVIDENCE, not just travel. A run that begins
   *  150 px from the equipment is probably a different pipe that happens to
   *  pass nearby, and starting on it is precisely how a trace ends up
   *  confidently drawn along the wrong line. */
  anchorCostMultiplier?: number;
}

// Tuned for a 3000px-wide render of an E-size sheet, then scaled to whatever
// the page actually renders at (see tracePipeOnRaster).
const DEFAULTS = {
  minRun: 14,
  maxThickness: 10,
  alignTolerance: 4,
  maxGap: 220,
  gapCostMultiplier: 2.5,
  bridgeRadius: 34,
  turnPenalty: 60,
  crossingPenalty: 6000,
  searchRadius: 260,
  anchorCostMultiplier: 4,
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
  /** A hop across something that isn't drawn as an orthogonal stroke —
   *  through a valve body, around a reducer, over a 45° jog. Direction is
   *  carried through unchanged, so crossing one is not a "turn": the pipe
   *  didn't turn, the draftsman just stopped drawing it as a straight line. */
  neutral?: boolean;
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
  const link = (from: number, to: number, cost: number, horizontal: boolean, neutral = false) => {
    if (from === to) return;
    edges[from].push({ to, cost, horizontal, neutral });
    edges[to].push({ to: from, cost, horizontal, neutral });
  };

  // Thread each segment's points into a chain of pipe stretches.
  for (const s of segments) {
    const list = (onSegment.get(s.id) ?? []).sort((p, q) => p.at - q.at);
    for (let i = 1; i < list.length; i++) {
      link(list[i - 1].node, list[i].node, list[i].at - list[i - 1].at, s.horizontal);
    }
  }

  // Collinear continuation across a gap: the same pipe interrupted by its own
  // printed line number, a crossing hop, or a dimension. Same direction, so
  // no turn — but priced by length so the search prefers drawn pipe and only
  // jumps when there is nothing else.
  const gapCost = opts.gapCostMultiplier ?? DEFAULTS.gapCostMultiplier;
  for (const group of [horizontals, verticals]) {
    const sorted = [...group].sort((p, q) => p.c - q.c || p.a - q.a);
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const s = sorted[i], t = sorted[j];
        if (Math.abs(s.c - t.c) > tol) break;         // sorted by c — done here
        const gap = t.a - s.b;
        if (gap > maxGap) break;                      // sorted by a — done here
        if (gap <= 0) continue;
        const from = byKey.get(keyOf(segEnd(s).x, segEnd(s).y));
        const to = byKey.get(keyOf(segStart(t).x, segStart(t).y));
        if (from !== undefined && to !== undefined) link(from, to, gap * gapCost, s.horizontal);
      }
    }
  }

  // Endpoint bridges. A pipe run is not one unbroken orthogonal stroke: it
  // passes THROUGH things — a valve body, a reducer, an instrument, a 45°
  // jog, the wall of an equipment symbol — none of which the stroke extractor
  // sees as pipe. Without these the network shatters into disconnected
  // fragments and the search reports "no continuous run" on a drawing whose
  // line is plainly continuous to the eye. Spatially hashed, so this stays
  // linear rather than comparing every endpoint to every other.
  const bridgeRadius = opts.bridgeRadius ?? DEFAULTS.bridgeRadius;
  const cell = Math.max(1, bridgeRadius);
  const buckets = new Map<string, number[]>();
  const ends: Array<{ node: number; x: number; y: number; seg: number }> = [];
  for (const s of segments) {
    for (const p of [segStart(s), segEnd(s)]) {
      const node = byKey.get(keyOf(p.x, p.y));
      if (node === undefined) continue;
      const idx = ends.length;
      ends.push({ node, x: p.x, y: p.y, seg: s.id });
      const bk = `${Math.floor(p.x / cell)},${Math.floor(p.y / cell)}`;
      buckets.set(bk, [...(buckets.get(bk) ?? []), idx]);
    }
  }
  for (let i = 0; i < ends.length; i++) {
    const e = ends[i];
    const cx = Math.floor(e.x / cell), cy = Math.floor(e.y / cell);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const j of buckets.get(`${cx + dx},${cy + dy}`) ?? []) {
          if (j <= i) continue;
          const o = ends[j];
          if (o.seg === e.seg) continue;
          const d = Math.hypot(o.x - e.x, o.y - e.y);
          if (d > bridgeRadius) continue;
          link(e.node, o.node, d * gapCost, true, true);
        }
      }
    }
  }

  return { nodes, edges };
}

/** Every node within reach of a tag's marker, with how far it sits.
 *
 *  Deliberately NOT "the nearest node". A tag label is printed beside its
 *  equipment, not on the pipe, and the connection can leave from any side —
 *  so the nearest bit of ink is as likely to be the symbol's outline, a
 *  neighbouring line, or the label's own underline as it is the right pipe.
 *  Handing the search every candidate and letting cost decide is what makes
 *  this work on a real sheet instead of a synthetic one. */
function candidatesNear(
  network: Network, p: Point, radius: number,
): Array<{ id: number; dist: number }> {
  const out: Array<{ id: number; dist: number }> = [];
  for (const n of network.nodes) {
    const d = Math.hypot(n.x - p.x, n.y - p.y);
    if (d <= radius) out.push({ id: n.id, dist: d });
  }
  return out.sort((a, b) => a.dist - b.dist);
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
  /** What the tracer actually saw. Tuning a vectorizer against a drawing you
   *  cannot look at is guesswork; these numbers are how a failure becomes
   *  diagnosable from the outside. */
  diagnostics: {
    nodes: number;
    startCandidates: number;
    goalCandidates: number;
  };
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
  // The radius can never reach halfway to the other tag, or "near the start"
  // and "near the goal" start meaning the same nodes and the walk finishes
  // before it has gone anywhere. Bites hardest exactly where it matters: two
  // exchangers drawn side by side.
  const separation = Math.hypot(goal.x - start.x, goal.y - start.y);
  const searchRadius = Math.min(opts.searchRadius ?? DEFAULTS.searchRadius, separation * 0.45);

  const starts = candidatesNear(network, start, searchRadius);
  const goals = candidatesNear(network, goal, searchRadius);
  const diagnostics = {
    nodes: network.nodes.length,
    startCandidates: starts.length,
    goalCandidates: goals.length,
  };
  const fail = (reason: string): PipeTraceResult =>
    ({ ok: false, points: [], turns: 0, reason, diagnostics });

  if (starts.length === 0 || goals.length === 0) {
    const which = starts.length === 0 && goals.length === 0 ? "either tag"
      : starts.length === 0 ? "the first tag" : "the second tag";
    return fail(
      `No pipe found near ${which} on this sheet. The tag marker may be pointing at the wrong place, `
      + "or the equipment may be drawn on a different sheet.",
    );
  }

  const anchorMult = opts.anchorCostMultiplier ?? DEFAULTS.anchorCostMultiplier;
  const goalDist = new Map(goals.map((c) => [c.id, c.dist]));
  // One virtual node stands in for "arrived at the destination tag". Every
  // candidate finishing node links to it at its own distance-from-the-tag
  // cost, so the search weighs HOW WELL each candidate actually reaches the
  // equipment instead of stopping at whichever one it happened to pop first.
  const VIRTUAL = network.nodes.length;
  const h = (id: number) => {
    if (id === VIRTUAL) return 0;
    const n = network.nodes[id];
    return Math.max(0, Math.hypot(n.x - goal.x, n.y - goal.y) - searchRadius);
  };

  // Two states per node: arrived horizontally (0) or vertically (1).
  const stateId = (node: number, horiz: boolean) => node * 2 + (horiz ? 0 : 1);
  const g = new Map<number, number>();
  const cameFrom = new Map<number, number>();
  const open = new Heap();

  // Multi-source: every candidate seeded, priced by how far it sits from the
  // tag, so the search naturally prefers starting on the closest pipe but is
  // free to start on a further one when that is the run that actually goes
  // somewhere.
  for (const c of starts) {
    const seed = c.dist * anchorMult;
    for (const dir of [true, false]) {
      const s = stateId(c.id, dir);
      if ((g.get(s) ?? Infinity) <= seed) continue;
      g.set(s, seed);
      open.push(s, seed + h(c.id));
    }
  }

  let goalState: number | null = null;
  let guard = 0;
  const GUARD_MAX = 600_000;
  while (open.size > 0) {
    if (++guard > GUARD_MAX) break;
    const top = open.pop()!;
    const node = top.key >> 1;
    const arrivedHoriz = (top.key & 1) === 0;
    const cost = g.get(top.key);
    if (cost === undefined || top.pri > cost + h(node) + 0.001) continue;   // stale
    if (node === VIRTUAL) { goalState = top.key; break; }

    // Finishing at the destination tag is just another edge — one that costs
    // however far this candidate sits from the equipment.
    const toGoal = goalDist.get(node);
    if (toGoal !== undefined && cameFrom.has(top.key)) {
      const finish = stateId(VIRTUAL, arrivedHoriz);
      const tentative = cost + toGoal * anchorMult;
      if ((g.get(finish) ?? Infinity) > tentative) {
        g.set(finish, tentative);
        cameFrom.set(finish, top.key);
        open.push(finish, tentative);
      }
    }

    for (const e of network.edges[node]) {
      let step = e.cost;
      // A neutral hop carries the direction through: passing through a valve
      // body is not the pipe turning.
      const nextHoriz = e.neutral ? arrivedHoriz : e.horizontal;
      if (!e.neutral && e.horizontal !== arrivedHoriz) {
        step += turnPenalty;
        // Turning where two pipes merely cross means leaving the pipe we are
        // following for one that has nothing to do with it.
        if (network.nodes[node].crossing) step += crossingPenalty;
      }
      const nextState = stateId(e.to, nextHoriz);
      const tentative = cost + step;
      const known = g.get(nextState);
      if (known !== undefined && known <= tentative) continue;
      g.set(nextState, tentative);
      cameFrom.set(nextState, top.key);
      open.push(nextState, tentative + h(e.to));
    }
  }

  if (goalState === null) {
    return fail(
      "Followed the line-work but found no continuous run between those two tags on this sheet — "
      + "the path likely leaves the sheet at an off-page connector.",
    );
  }

  // Walk the parents back to the start.
  const chain: number[] = [];
  for (let s: number | undefined = goalState; s !== undefined; s = cameFrom.get(s)) {
    const node = s >> 1;
    if (node !== VIRTUAL) chain.push(node);      // the finish marker isn't a place
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
  return { ok: points.length >= 2, points, reason: null, turns, diagnostics };
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
/** The defaults are tuned for a 3000px-wide render; every one of them is a
 *  distance on paper, so they scale with whatever the page renders at. */
export function scaledOptions(width: number, opts: TraceOptions = {}): TraceOptions {
  const k = width / 3000;
  const scale = (v: number) => Math.max(2, Math.round(v * k));
  return {
    minRun: opts.minRun ?? scale(DEFAULTS.minRun),
    maxThickness: opts.maxThickness ?? scale(DEFAULTS.maxThickness),
    alignTolerance: opts.alignTolerance ?? scale(DEFAULTS.alignTolerance),
    maxGap: opts.maxGap ?? scale(DEFAULTS.maxGap),
    bridgeRadius: opts.bridgeRadius ?? scale(DEFAULTS.bridgeRadius),
    turnPenalty: opts.turnPenalty ?? scale(DEFAULTS.turnPenalty),
    searchRadius: opts.searchRadius ?? scale(DEFAULTS.searchRadius),
    gapCostMultiplier: opts.gapCostMultiplier ?? DEFAULTS.gapCostMultiplier,
    crossingPenalty: opts.crossingPenalty ?? DEFAULTS.crossingPenalty,
  };
}

export function tracePipeOnRaster(
  raster: Raster,
  startFrac: Point,
  goalFrac: Point,
  rawOpts: TraceOptions = {},
): PipeTraceResult & { segments: number; lineWork: Segment[] } {
  const opts = scaledOptions(raster.width, rawOpts);
  const toPx = (p: Point): Point => ({ x: p.x * raster.width, y: p.y * raster.height });
  const segments = extractSegments(raster, opts);
  if (segments.length === 0) {
    return {
      ok: false, points: [], turns: 0, segments: 0, lineWork: [],
      diagnostics: { nodes: 0, startCandidates: 0, goalCandidates: 0 },
      reason: "No pipe-like line-work found on this page — if the sheet is a scan, it may be too low-resolution to follow.",
    };
  }
  const network = buildNetwork(segments, opts);
  const result = tracePipe(network, toPx(startFrac), toPx(goalFrac), opts);
  return {
    ...result,
    segments: segments.length,
    lineWork: segments,
    points: result.points.map((p) => ({ x: p.x / raster.width, y: p.y / raster.height })),
  };
}
