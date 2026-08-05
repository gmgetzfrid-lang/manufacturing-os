import { describe, it, expect } from "vitest";
import {
  GraphSim, seedPosition, buildAdjacency, neighborhood, shortestPath,
  DEFAULT_SIM_PARAMS,
} from "@/lib/graphSim";

const dist = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) =>
  Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

const settle = (sim: GraphSim, steps = 600) => {
  for (let i = 0; i < steps; i++) if (!sim.tick()) break;
};

describe("seedPosition", () => {
  it("is deterministic for the same id", () => {
    expect(seedPosition("doc:abc", 2)).toEqual(seedPosition("doc:abc", 2));
  });

  it("keeps z flat in 2D and uses it in 3D", () => {
    expect(seedPosition("doc:abc", 2).z).toBe(0);
    const spread = ["a", "b", "c", "d", "e"].map((id) => seedPosition(id, 3).z);
    expect(spread.some((z) => Math.abs(z) > 1)).toBe(true);
  });

  it("gives different ids different places", () => {
    expect(seedPosition("a", 2)).not.toEqual(seedPosition("b", 2));
  });
});

describe("GraphSim", () => {
  it("settles instead of jittering forever", () => {
    const sim = new GraphSim();
    sim.setGraph([{ id: "a" }, { id: "b" }, { id: "c" }], [{ a: "a", b: "b" }]);
    settle(sim, 2000);
    expect(sim.settled).toBe(true);
    expect(sim.tick()).toBe(false);
  });

  it("pulls linked nodes closer than unlinked ones", () => {
    const sim = new GraphSim({ linkDistance: 60 });
    sim.setGraph(
      [{ id: "a" }, { id: "b" }, { id: "far" }],
      [{ a: "a", b: "b" }],
    );
    settle(sim);
    const a = sim.get("a")!, b = sim.get("b")!, far = sim.get("far")!;
    expect(dist(a, b)).toBeLessThan(dist(a, far));
  });

  it("respects linkDistance — a longer rest length settles further apart", () => {
    const near = new GraphSim({ linkDistance: 40 });
    near.setGraph([{ id: "a" }, { id: "b" }], [{ a: "a", b: "b" }]);
    settle(near);
    const wide = new GraphSim({ linkDistance: 200 });
    wide.setGraph([{ id: "a" }, { id: "b" }], [{ a: "a", b: "b" }]);
    settle(wide);
    expect(dist(wide.get("a")!, wide.get("b")!))
      .toBeGreaterThan(dist(near.get("a")!, near.get("b")!));
  });

  it("keeps z at zero in 2D and moves in 3D", () => {
    const flat = new GraphSim({ dimensions: 2 });
    flat.setGraph([{ id: "a" }, { id: "b" }, { id: "c" }], [{ a: "a", b: "b" }]);
    settle(flat, 200);
    expect(flat.nodes.every((n) => n.z === 0)).toBe(true);

    const deep = new GraphSim({ dimensions: 3, repelForce: 2 });
    deep.setGraph(
      Array.from({ length: 12 }, (_, i) => ({ id: `n${i}` })),
      [],
    );
    settle(deep, 200);
    expect(deep.nodes.some((n) => Math.abs(n.z) > 1)).toBe(true);
  });

  it("lifts an existing 2D layout into 3D without discarding it", () => {
    const sim = new GraphSim({ dimensions: 2 });
    sim.setGraph([{ id: "a" }, { id: "b" }], [{ a: "a", b: "b" }]);
    settle(sim);
    const a = sim.get("a")!;
    const beforeR = Math.hypot(a.x, a.y);
    const beforeBearing = Math.atan2(a.y, a.x);

    sim.setDimensions(3);

    // The arrangement is INFLATED, not rebuilt: each node keeps how far out
    // it sits and which way it faces, and gains a polar angle. Holding x/y
    // fixed instead would only add jitter in z — a pancake, not a ball.
    expect(Math.hypot(a.x, a.y, a.z)).toBeCloseTo(beforeR, 3);
    expect(Math.atan2(a.y, a.x)).toBeCloseTo(beforeBearing, 3);
    expect(sim.settled).toBe(false);
  });

  it("never moves a fixed node", () => {
    const sim = new GraphSim();
    sim.setGraph([{ id: "a" }, { id: "b" }], [{ a: "a", b: "b" }]);
    const a = sim.get("a")!;
    a.fixed = true; a.x = 500; a.y = -25;
    settle(sim);
    expect(a.x).toBe(500);
    expect(a.y).toBe(-25);
  });

  it("carries surviving node positions across a rebuild", () => {
    const sim = new GraphSim();
    sim.setGraph([{ id: "a" }, { id: "b" }], [{ a: "a", b: "b" }]);
    settle(sim);
    const kept = { x: sim.get("a")!.x, y: sim.get("a")!.y };
    sim.setGraph([{ id: "a" }, { id: "c" }], []);
    expect(sim.get("a")!.x).toBe(kept.x);
    expect(sim.get("a")!.y).toBe(kept.y);
  });

  it("restores saved positions for nodes it has never seen", () => {
    const sim = new GraphSim();
    sim.setGraph([{ id: "a" }], [], { restore: { a: [42, -7, 0] } });
    expect(sim.get("a")!.x).toBe(42);
    expect(sim.get("a")!.y).toBe(-7);
  });

  it("drops edges whose endpoints are not in the graph", () => {
    const sim = new GraphSim();
    sim.setGraph([{ id: "a" }], [{ a: "a", b: "ghost" }]);
    expect(sim.edges).toHaveLength(0);
  });

  it("pushes harder apart with a higher repel force", () => {
    const build = (repelForce: number) => {
      const sim = new GraphSim({ repelForce, centerForce: DEFAULT_SIM_PARAMS.centerForce });
      sim.setGraph([{ id: "a" }, { id: "b" }], []);
      // Start them on top of each other so repulsion is the only actor.
      sim.get("a")!.x = 0; sim.get("a")!.y = 0;
      sim.get("b")!.x = 10; sim.get("b")!.y = 0;
      sim.reheat(1);
      settle(sim, 300);
      return dist(sim.get("a")!, sim.get("b")!);
    };
    expect(build(3)).toBeGreaterThan(build(0.2));
  });
});

describe("traversal helpers", () => {
  const adj = buildAdjacency([
    { a: "a", b: "b" }, { a: "b", b: "c" }, { a: "c", b: "d" }, { a: "x", b: "y" },
  ]);

  it("reports each neighbour's hop distance", () => {
    const n = neighborhood("a", adj, 2);
    expect(n.get("a")).toBe(0);
    expect(n.get("b")).toBe(1);
    expect(n.get("c")).toBe(2);
    expect(n.has("d")).toBe(false);
  });

  it("stops early when the neighbourhood is exhausted", () => {
    expect([...neighborhood("x", adj, 5).keys()].sort()).toEqual(["x", "y"]);
  });

  it("finds the shortest path and its order", () => {
    expect(shortestPath("a", "d", adj)).toEqual(["a", "b", "c", "d"]);
  });

  it("prefers a shortcut when one exists", () => {
    const withShortcut = buildAdjacency([
      { a: "a", b: "b" }, { a: "b", b: "c" }, { a: "c", b: "d" }, { a: "a", b: "d" },
    ]);
    expect(shortestPath("a", "d", withShortcut)).toEqual(["a", "d"]);
  });

  it("returns null when nothing connects the two", () => {
    expect(shortestPath("a", "y", adj)).toBeNull();
  });

  it("returns the single node when both ends are the same", () => {
    expect(shortestPath("a", "a", adj)).toEqual(["a"]);
  });

  it("gives up past maxHops rather than searching forever", () => {
    const chain = buildAdjacency(
      Array.from({ length: 20 }, (_, i) => ({ a: `n${i}`, b: `n${i + 1}` })),
    );
    expect(shortestPath("n0", "n20", chain, 3)).toBeNull();
    expect(shortestPath("n0", "n3", chain, 3)).toEqual(["n0", "n1", "n2", "n3"]);
  });
});

describe("seeding fills volume, not a shell", () => {
  // The bug this guards: sampling radius uniformly fills a SHELL, so 2D looked
  // like a ring of dots and 3D like a hollow bubble viewed edge-on.
  const ids = Array.from({ length: 800 }, (_, i) => `doc:${i}`);

  it("spreads points through the disc in 2D, not around its rim", () => {
    const radii = ids.map((id) => {
      const p = seedPosition(id, 2);
      return Math.hypot(p.x, p.y);
    });
    const max = Math.max(...radii);
    // A ring would put almost everything in the outer band. An even disc puts
    // about a quarter of its points inside half the radius (area scales r²).
    const inner = radii.filter((r) => r < max * 0.5).length / radii.length;
    expect(inner).toBeGreaterThan(0.15);
  });

  it("spreads points through the ball in 3D and uses every axis", () => {
    const pts = ids.map((id) => seedPosition(id, 3));
    const max = Math.max(...pts.map((p) => Math.hypot(p.x, p.y, p.z)));
    const inner = pts.filter((p) => Math.hypot(p.x, p.y, p.z) < max * 0.5).length / pts.length;
    expect(inner).toBeGreaterThan(0.05);

    // No axis may be degenerate — a flat sheet is the failure we're guarding.
    const spread = (sel: (p: { x: number; y: number; z: number }) => number) => {
      const vals = pts.map(sel);
      return Math.max(...vals) - Math.min(...vals);
    };
    const sx = spread((p) => p.x), sy = spread((p) => p.y), sz = spread((p) => p.z);
    expect(Math.min(sx, sy, sz)).toBeGreaterThan(Math.max(sx, sy, sz) * 0.6);
  });
});

describe("inflating a flat layout into 3D", () => {
  it("turns a disc into a ball rather than a jittered pancake", () => {
    const sim = new GraphSim({ dimensions: 2 });
    sim.setGraph(
      Array.from({ length: 200 }, (_, i) => ({ id: `n${i}` })),
      [],
    );
    for (let i = 0; i < 400; i++) if (!sim.tick()) break;
    expect(sim.nodes.every((n) => n.z === 0)).toBe(true);

    sim.setDimensions(3);
    const zs = sim.nodes.map((n) => Math.abs(n.z));
    const xs = sim.nodes.map((n) => Math.abs(n.x));
    // Depth must be a comparable magnitude to width — not a nudge.
    const meanZ = zs.reduce((a, b) => a + b, 0) / zs.length;
    const meanX = xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(meanZ).toBeGreaterThan(meanX * 0.3);
  });

  it("keeps each node's distance from the centre when inflating", () => {
    const sim = new GraphSim({ dimensions: 2 });
    sim.setGraph([{ id: "a" }, { id: "b" }], []);
    const before = sim.nodes.map((n) => Math.hypot(n.x, n.y));
    sim.setDimensions(3);
    const after = sim.nodes.map((n) => Math.hypot(n.x, n.y, n.z));
    after.forEach((r, i) => expect(r).toBeCloseTo(before[i], 3));
  });
});
