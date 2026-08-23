import { describe, expect, it } from "vitest";
import { ransacEssential, type Pose } from "../twoView";

function makeRng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

/** Project a world point into a camera, in normalised image coordinates. */
function project(pose: Pose, X: [number, number, number]) {
  const R = pose.R;
  const z = R[6] * X[0] + R[7] * X[1] + R[8] * X[2] + pose.t[2];
  const x = R[0] * X[0] + R[1] * X[1] + R[2] * X[2] + pose.t[0];
  const y = R[3] * X[0] + R[4] * X[1] + R[5] * X[2] + pose.t[1];
  return { x: x / z, y: y / z, z };
}

const IDENTITY: Pose = { R: new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]), t: [0, 0, 0] };

/**
 * A corridor walked forward: most of what the camera sees is straight ahead,
 * a smaller share is wall close to either side. This is how anyone films a
 * space, and it is the geometry the seed gate has to cope with.
 */
function corridorPair(step: number, aheadShare = 0.8) {
  const rng = makeRng(4242);
  // Camera 2 sits `step` metres further down the corridor, same orientation.
  const moved: Pose = { R: IDENTITY.R, t: [0, 0, -step] };
  const corr: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];
  for (let i = 0; i < 400; i++) {
    let X: [number, number, number];
    if (rng() < aheadShare) {
      // Far down the corridor: rays from both cameras are nearly parallel.
      X = [(rng() - 0.5) * 1.5, (rng() - 0.5) * 1.5, 14 + rng() * 12];
    } else {
      // Wall a metre or so to the side, close by: real parallax.
      X = [(rng() < 0.5 ? -1 : 1) * (1.2 + rng() * 0.6), (rng() - 0.5) * 2, 1.5 + rng() * 3];
    }
    const p1 = project(IDENTITY, X);
    const p2 = project(moved, X);
    if (p1.z < 0.3 || p2.z < 0.3) continue;
    corr.push({ x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y });
  }
  return corr;
}

describe("parallax of a forward walk", () => {
  let measured: { median: number; wellConditioned: number; total: number } | null = null;

  it("has a small median angle yet plenty of well-triangulated points", () => {
    const corr = corridorPair(0.55);
    const geo = ransacEssential(corr, 1e-3, { seed: 11 });
    expect(geo).not.toBeNull();
    measured = {
      median: geo!.medianTriangulationAngleDeg,
      wellConditioned: geo!.wellConditionedCount,
      total: geo!.inlierCount,
    };

    // The median is dominated by the points straight ahead, whose rays barely
    // diverge however far you walk. Gating a seed on it rejects this capture.
    expect(geo!.medianTriangulationAngleDeg).toBeLessThan(2.0);

    // Meanwhile the off-axis points that CAN seed a reconstruction are there in
    // numbers. That is the quantity the gate has to look at.
    expect(geo!.wellConditionedCount).toBeGreaterThan(30);
  });

  it("counts fewer well-conditioned points as the walk gets shorter", () => {
    const long = ransacEssential(corridorPair(1.4), 1e-3, { seed: 5 });
    const short = ransacEssential(corridorPair(0.25), 1e-3, { seed: 5 });
    expect(long).not.toBeNull();
    expect(short).not.toBeNull();
    expect(long!.wellConditionedCount).toBeGreaterThan(short!.wellConditionedCount);
  });

  it("still reports large parallax for a sideways pass", () => {
    const rng = makeRng(99);
    const moved: Pose = { R: IDENTITY.R, t: [-0.9, 0, 0] };
    const corr = [];
    for (let i = 0; i < 300; i++) {
      const X: [number, number, number] = [
        (rng() - 0.5) * 4, (rng() - 0.5) * 3, 2.5 + rng() * 3,
      ];
      const p1 = project(IDENTITY, X);
      const p2 = project(moved, X);
      if (p1.z < 0.3 || p2.z < 0.3) continue;
      corr.push({ x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y });
    }
    const geo = ransacEssential(corr, 1e-3, { seed: 3 });
    expect(geo).not.toBeNull();
    expect(geo!.medianTriangulationAngleDeg).toBeGreaterThan(5);
    expect(geo!.wellConditionedCount).toBeGreaterThan(geo!.inlierCount * 0.7);
  });

  it("clears the seed bar the median-based gate rejected it at", () => {
    expect(measured).not.toBeNull();
    // The old gate, which this capture failed.
    expect(measured!.median).toBeLessThan(2.0);
    // The relaxed tier the new gate can fall back to.
    expect(measured!.wellConditioned).toBeGreaterThanOrEqual(8);
  });

  it("reports nothing well-conditioned when the camera only rotates", () => {
    const rng = makeRng(17);
    // Same centre, rotated slightly: no baseline, so no parallax anywhere.
    const c = Math.cos(0.12), s2 = Math.sin(0.12);
    const rotated: Pose = {
      R: new Float64Array([c, 0, s2, 0, 1, 0, -s2, 0, c]),
      t: [0, 0, 0],
    };
    const corr = [];
    for (let i = 0; i < 300; i++) {
      const X: [number, number, number] = [
        (rng() - 0.5) * 6, (rng() - 0.5) * 4, 3 + rng() * 8,
      ];
      const p1 = project(IDENTITY, X);
      const p2 = project(rotated, X);
      if (p1.z < 0.3 || p2.z < 0.3) continue;
      corr.push({ x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y });
    }
    const geo = ransacEssential(corr, 1e-3, { seed: 21 });
    if (geo) expect(geo.wellConditionedCount).toBeLessThan(8);
  });
});
