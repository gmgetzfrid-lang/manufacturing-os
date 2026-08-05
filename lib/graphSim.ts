// lib/graphSim.ts — the physics under both graph renderers.
//
// One simulation, two dimensionalities. The 2D canvas and the 3D WebGL view
// share this engine so a layout you tune in one is the same layout in the
// other — flipping to 3D lifts your map off the page, it doesn't rebuild it.
//
// Design notes:
//   * Every force is a live parameter (center / repel / link / distance),
//     because the single biggest thing Obsidian's graph gets right is that
//     you can FEEL the layout respond while you drag a slider.
//   * Repulsion uses a spatial hash, so cost scales with local density
//     rather than n². 3,000 nodes stays interactive.
//   * Positions seed deterministically from node ids: the same graph lands
//     the same way on every machine, every visit, before physics runs.
//   * Pure state + a tick() function — no rendering, no DOM, unit-testable.

export interface SimNodeInit {
  id: string;
  /** Visual weight; heavier nodes resist being shoved around. */
  mass?: number;
}

export interface SimEdge {
  a: string;
  b: string;
  /** Multiplies link force for this edge (0 = decorative, never pulls). */
  strength?: number;
  /** Overrides the global rest length. */
  distance?: number;
}

export interface SimParams {
  /** 2 keeps z at 0; 3 lets the layout breathe into depth. */
  dimensions: 2 | 3;
  /** Pull toward the origin — stops islands drifting into the void. */
  centerForce: number;
  /** How hard nodes push each other apart. */
  repelForce: number;
  /** How hard links pull their endpoints together. */
  linkForce: number;
  /** Rest length of a link. */
  linkDistance: number;
  /** Velocity damping per tick. Lower = more viscous. */
  damping: number;
}

export const DEFAULT_SIM_PARAMS: SimParams = {
  dimensions: 2,
  centerForce: 0.6,
  repelForce: 1,
  linkForce: 1,
  linkDistance: 90,
  damping: 0.82,
};

export interface SimNode extends SimNodeInit {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  mass: number;
  /** Held by a drag or explicitly anchored — physics won't move it. */
  fixed: boolean;
}

/** Deterministic seed: the same id always starts in the same place, so a
 *  graph looks familiar before a single tick has run.
 *
 *  Distribution matters more than it sounds. Picking a random radius fills a
 *  SHELL, not a volume — in 2D that reads as a ring of dots, and in 3D as a
 *  hollow bubble. Area in 2D grows with r² and volume in 3D with r³, so the
 *  radius has to be sqrt/cbrt-warped for points to land evenly through the
 *  disc / ball. */
export function seedPosition(id: string, dimensions: 2 | 3): { x: number; y: number; z: number } {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 16777619); }
  const u = (h >>> 0) / 4294967296;              // angle
  const v = ((h >>> 9) % 4093) / 4093;           // second angle / depth
  const w = ((h >>> 3) % 6151) / 6151;           // radius sample
  const R = 900;

  if (dimensions === 2) {
    const angle = u * Math.PI * 2;
    const radius = 60 + Math.sqrt(w) * R;        // even over the disc
    return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius, z: 0 };
  }
  // Even through the ball: uniform direction, cube-root radius.
  const theta = u * Math.PI * 2;
  const phi = Math.acos(2 * v - 1);              // no clumping at the poles
  const radius = 60 + Math.cbrt(w) * R;
  return {
    x: Math.sin(phi) * Math.cos(theta) * radius,
    y: Math.sin(phi) * Math.sin(theta) * radius,
    z: Math.cos(phi) * radius,
  };
}

const CELL = 130;
const MAX_SPEED = 16;

export class GraphSim {
  nodes: SimNode[] = [];
  edges: SimEdge[] = [];
  params: SimParams;
  /** Simulation temperature: forces scale with it, and it cools each tick
   *  so the layout settles instead of jittering forever. */
  alpha = 1;

  private byId = new Map<string, SimNode>();

  constructor(params?: Partial<SimParams>) {
    this.params = { ...DEFAULT_SIM_PARAMS, ...params };
  }

  get(id: string): SimNode | undefined { return this.byId.get(id); }

  /** Apply new force parameters and wake the layout so a slider is answered
   *  immediately rather than on the next rebuild. Changing dimensionality
   *  goes through setDimensions so existing positions are carried over. */
  configure(patch: Partial<SimParams>, opts?: { reheat?: number }): void {
    const { dimensions, ...rest } = patch;
    Object.assign(this.params, rest);
    if (dimensions && dimensions !== this.params.dimensions) this.setDimensions(dimensions);
    this.reheat(opts?.reheat ?? 0.35);
  }

  /** Rebuild from a new node/edge set, carrying over positions of nodes that
   *  survived so the map doesn't jump when a filter changes. */
  setGraph(
    nodes: SimNodeInit[],
    edges: SimEdge[],
    opts?: { restore?: Record<string, [number, number, number]> },
  ): void {
    const prev = this.byId;
    const next = new Map<string, SimNode>();
    const dims = this.params.dimensions;
    this.nodes = nodes.map((n) => {
      const old = prev.get(n.id);
      const mem = opts?.restore?.[n.id];
      const p = old ?? (mem
        ? { x: mem[0], y: mem[1], z: mem[2] }
        : seedPosition(n.id, dims));
      const sn: SimNode = {
        ...n,
        x: p.x, y: p.y, z: dims === 3 ? p.z : 0,
        vx: old?.vx ?? 0, vy: old?.vy ?? 0, vz: old?.vz ?? 0,
        mass: n.mass ?? 1,
        fixed: old?.fixed ?? false,
      };
      next.set(n.id, sn);
      return sn;
    });
    this.byId = next;
    this.edges = edges.filter((e) => next.has(e.a) && next.has(e.b));
    this.reheat(prev.size > 0 ? 0.4 : 1);
  }

  /** Switching dimensionality: INFLATE a flat layout into a ball (or flatten
   *  it back) without losing the arrangement you already recognize.
   *
   *  Nudging z alone leaves a pancake with jitter — still visually 2D. Each
   *  node keeps its distance from the centre and its horizontal bearing, and
   *  gains a polar angle from its deterministic seed, so the disc becomes a
   *  sphere while neighbours stay neighbours. */
  setDimensions(dimensions: 2 | 3): void {
    if (this.params.dimensions === dimensions) return;
    this.params.dimensions = dimensions;

    if (dimensions === 2) {
      for (const n of this.nodes) {
        // Flatten: fold depth back into the radius so the ball becomes a disc
        // rather than a squashed silhouette.
        const r = Math.sqrt(n.x * n.x + n.y * n.y + n.z * n.z);
        const flat = Math.sqrt(n.x * n.x + n.y * n.y) || 1;
        n.x = (n.x / flat) * r;
        n.y = (n.y / flat) * r;
        n.z = 0; n.vz = 0;
      }
    } else {
      for (const n of this.nodes) {
        const r = Math.sqrt(n.x * n.x + n.y * n.y + n.z * n.z) || 200;
        const theta = Math.atan2(n.y, n.x);
        // Polar angle from the seed: stable per node, evenly spread overall.
        const seed = seedPosition(n.id, 3);
        const phi = Math.acos(Math.max(-1, Math.min(1, seed.z / (Math.hypot(seed.x, seed.y, seed.z) || 1))));
        n.x = r * Math.sin(phi) * Math.cos(theta);
        n.y = r * Math.sin(phi) * Math.sin(theta);
        n.z = r * Math.cos(phi);
        n.vz = 0;
      }
    }
    this.reheat(0.9);
  }

  reheat(to = 0.5): void { this.alpha = Math.max(this.alpha, to); }

  get settled(): boolean { return this.alpha < 0.005; }

  positions(): Record<string, [number, number, number]> {
    const out: Record<string, [number, number, number]> = {};
    for (const n of this.nodes) out[n.id] = [Math.round(n.x), Math.round(n.y), Math.round(n.z)];
    return out;
  }

  /** One step. Returns false once the layout has settled, so the render loop
   *  can stop spending on physics while still drawing. */
  tick(): boolean {
    if (this.settled) return false;
    const { centerForce, repelForce, linkForce, linkDistance, damping, dimensions } = this.params;
    const a = this.alpha;
    const is3d = dimensions === 3;

    // ── Repulsion, spatial-hashed ────────────────────────────────────────
    const grid = new Map<string, SimNode[]>();
    for (const n of this.nodes) {
      const key = is3d
        ? `${Math.floor(n.x / CELL)},${Math.floor(n.y / CELL)},${Math.floor(n.z / CELL)}`
        : `${Math.floor(n.x / CELL)},${Math.floor(n.y / CELL)}`;
      (grid.get(key) ?? grid.set(key, []).get(key)!).push(n);
    }
    const zRange = is3d ? [-1, 0, 1] : [0];
    for (const n of this.nodes) {
      if (n.fixed) continue;
      const cx = Math.floor(n.x / CELL), cy = Math.floor(n.y / CELL), cz = Math.floor(n.z / CELL);
      let fx = 0, fy = 0, fz = 0;
      for (let gx = cx - 1; gx <= cx + 1; gx++) {
        for (let gy = cy - 1; gy <= cy + 1; gy++) {
          for (const dz of zRange) {
            const cell = grid.get(is3d ? `${gx},${gy},${cz + dz}` : `${gx},${gy}`);
            if (!cell) continue;
            for (const m of cell) {
              if (m === n) continue;
              const dx = n.x - m.x, dy = n.y - m.y, dz2 = is3d ? n.z - m.z : 0;
              const d2 = dx * dx + dy * dy + dz2 * dz2 + 0.01;
              if (d2 > CELL * CELL) continue;
              const f = Math.min(14, (repelForce * 300 * (n.mass + m.mass)) / d2);
              fx += dx * f; fy += dy * f; fz += dz2 * f;
            }
          }
        }
      }
      // Centering — weak, and weaker still for heavy hubs so they anchor.
      const c = centerForce * 0.001;
      fx -= n.x * c; fy -= n.y * c; if (is3d) fz -= n.z * c;

      n.vx = (n.vx + fx * a) * damping;
      n.vy = (n.vy + fy * a) * damping;
      n.vz = is3d ? (n.vz + fz * a) * damping : 0;
    }

    // ── Springs ──────────────────────────────────────────────────────────
    for (const e of this.edges) {
      const na = this.byId.get(e.a)!, nb = this.byId.get(e.b)!;
      const dx = nb.x - na.x, dy = nb.y - na.y, dz = is3d ? nb.z - na.z : 0;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz) + 0.01;
      const rest = e.distance ?? linkDistance;
      const k = ((d - rest) / d) * 0.03 * linkForce * (e.strength ?? 1) * a;
      const fx = dx * k, fy = dy * k, fz = dz * k;
      if (!na.fixed) { na.vx += fx / na.mass; na.vy += fy / na.mass; if (is3d) na.vz += fz / na.mass; }
      if (!nb.fixed) { nb.vx -= fx / nb.mass; nb.vy -= fy / nb.mass; if (is3d) nb.vz -= fz / nb.mass; }
    }

    // ── Integrate ────────────────────────────────────────────────────────
    for (const n of this.nodes) {
      if (n.fixed) { n.vx = 0; n.vy = 0; n.vz = 0; continue; }
      const sp = Math.sqrt(n.vx * n.vx + n.vy * n.vy + n.vz * n.vz);
      if (sp > MAX_SPEED) {
        const s = MAX_SPEED / sp;
        n.vx *= s; n.vy *= s; n.vz *= s;
      }
      n.x += n.vx; n.y += n.vy;
      if (is3d) n.z += n.vz; else n.z = 0;
    }

    this.alpha *= 0.985;
    return true;
  }
}

// ── Graph traversal helpers shared by local-graph and path finding ────────

export function buildAdjacency(edges: Array<{ a: string; b: string }>): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>();
  for (const e of edges) {
    (adj.get(e.a) ?? adj.set(e.a, new Set()).get(e.a)!).add(e.b);
    (adj.get(e.b) ?? adj.set(e.b, new Set()).get(e.b)!).add(e.a);
  }
  return adj;
}

/** Every node within `depth` hops of a root — Obsidian's local graph, but
 *  it also reports HOW FAR each node is so the renderer can fade by distance. */
export function neighborhood(
  rootId: string, adj: Map<string, Set<string>>, depth: number,
): Map<string, number> {
  const seen = new Map<string, number>([[rootId, 0]]);
  let frontier = [rootId];
  for (let d = 1; d <= depth; d++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const nb of adj.get(id) ?? []) {
        if (seen.has(nb)) continue;
        seen.set(nb, d);
        next.push(nb);
      }
    }
    if (next.length === 0) break;
    frontier = next;
  }
  return seen;
}

/** Shortest chain of connections between two nodes — "how are these two
 *  related?", answered with the actual path rather than a vague score.
 *  Breadth-first, so the first path found is the shortest. */
export function shortestPath(
  fromId: string, toId: string, adj: Map<string, Set<string>>, maxHops = 8,
): string[] | null {
  if (fromId === toId) return [fromId];
  const prev = new Map<string, string>();
  const seen = new Set([fromId]);
  let frontier = [fromId];
  for (let d = 0; d < maxHops; d++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const nb of adj.get(id) ?? []) {
        if (seen.has(nb)) continue;
        seen.add(nb);
        prev.set(nb, id);
        if (nb === toId) {
          const path = [toId];
          let cur = toId;
          while (prev.has(cur)) { cur = prev.get(cur)!; path.push(cur); }
          return path.reverse();
        }
        next.push(nb);
      }
    }
    if (next.length === 0) return null;
    frontier = next;
  }
  return null;
}
