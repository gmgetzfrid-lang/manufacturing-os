import { describe, expect, it } from "vitest";
import { PointFuser, type DensePoint } from "../dense/planeSweep";

function pt(
  xyz: [number, number, number],
  rgb: [number, number, number],
  normal: [number, number, number] = [0, 1, 0],
  confidence = 0.9,
): DensePoint {
  return { xyz, rgb, normal, confidence };
}

describe("PointFuser", () => {
  const origin: [number, number, number] = [0, 0, 0];

  it("keeps a voxel two views agree on, in position and colour", () => {
    const f = new PointFuser(0.1, origin);
    f.add([pt([1, 1, 1], [120, 120, 120])], 0);
    f.add([pt([1.01, 1.0, 1.0], [124, 118, 121])], 1);
    const r = f.result(2);
    expect(r.count).toBe(1);
    expect(r.xyz[0]).toBeCloseTo(1.005, 2);
  });

  // Geometric agreement alone cannot tell a real surface from a mismatch that
  // happened to land in the right cell — the colours are what disagree.
  it("drops a voxel whose views disagree wildly on colour", () => {
    const f = new PointFuser(0.1, origin);
    for (let i = 0; i < 30; i++) {
      f.add([pt([i * 0.5, 1, 1], [200, 30, 30])], 0);
      f.add([pt([i * 0.5, 1, 1], [30, 60, 200])], 1);
    }
    const r = f.result(2);
    expect(r.count).toBe(0);
  });

  it("carries a normal through fusion and returns it unit length", () => {
    const f = new PointFuser(0.1, origin);
    f.add([pt([1, 1, 1], [100, 100, 100], [0, 0, 1])], 0);
    f.add([pt([1, 1, 1], [100, 100, 100], [0.05, 0, 0.99])], 1);
    const r = f.result(2);
    expect(r.count).toBe(1);
    expect(Math.hypot(r.normals[0], r.normals[1], r.normals[2])).toBeCloseTo(1, 5);
    expect(r.normals[2]).toBeGreaterThan(0.9);
  });

  it("lets disagreeing normals cancel rather than averaging to a lie", () => {
    const f = new PointFuser(0.1, origin);
    f.add([pt([1, 1, 1], [100, 100, 100], [0, 1, 0])], 0);
    f.add([pt([1, 1, 1], [100, 100, 100], [0, -1, 0])], 1);
    const r = f.result(2);
    // Opposed normals sum to nothing, so the point reports "no normal" and the
    // viewer falls back to a round dot instead of shading a fabricated surface.
    expect(Math.hypot(r.normals[0], r.normals[1], r.normals[2])).toBeCloseTo(0, 5);
  });

  it("weights a confident sample over a marginal one", () => {
    const f = new PointFuser(1.0, origin);
    f.add([pt([0.1, 0.5, 0.5], [100, 100, 100], [0, 1, 0], 1.0)], 0);
    f.add([pt([0.9, 0.5, 0.5], [100, 100, 100], [0, 1, 0], 0.0)], 1);
    const r = f.result(2);
    expect(r.count).toBe(1);
    // Pulled toward the confident sample rather than sitting at the midpoint.
    expect(r.xyz[0]).toBeLessThan(0.5);
  });
});

describe("the multi-view fallback", () => {
  const origin: [number, number, number] = [0, 0, 0];

  // The old fallback was an absolute count, so any scene under 20k voxels fell
  // through it to "keep everything" — taking the colour test down with it.
  it("relaxes view agreement without relaxing colour agreement", () => {
    const f = new PointFuser(0.1, origin);
    for (let i = 0; i < 50; i++) {
      // Single-view points: real surfaces nobody else saw. These must survive.
      f.add([pt([i * 0.5, 0, 0], [100, 100, 100])], 0);
    }
    // One cell two views disagree on in colour. This must not survive, however
    // few points the scene has.
    f.add([pt([100, 0, 0], [10, 200, 10])], 0);
    f.add([pt([100, 0, 0], [200, 10, 200])], 1);

    const r = f.result(2);
    expect(r.count).toBe(50);
    for (let i = 0; i < r.count; i++) expect(r.xyz[i * 3]).toBeLessThan(100);
  });

  it("does not fall back when the strict filter already kept plenty", () => {
    const f = new PointFuser(0.1, origin);
    for (let i = 0; i < 100; i++) {
      f.add([pt([i * 0.5, 0, 0], [100, 100, 100])], 0);
      f.add([pt([i * 0.5, 0, 0], [102, 99, 101])], 1);
    }
    f.add([pt([500, 0, 0], [10, 10, 10])], 0); // single view, unverified
    const r = f.result(2);
    expect(r.count).toBe(100);
  });
});
