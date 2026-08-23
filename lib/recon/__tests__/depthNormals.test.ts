import { describe, expect, it } from "vitest";
import { depthToPoints, type DenseView, type SweepResult } from "../dense/planeSweep";

const W = 48;
const H = 36;
const FOCAL = 60;
const OPTS = {
  focal: FOCAL,
  principal: [W / 2, H / 2] as [number, number],
  referenceWidth: W,
  referenceHeight: H,
  depthSamples: 64,
  patchRadius: 3,
  maxCost: 0.3,
  neighbours: 2,
};

/** Reference camera at the origin looking down +Z, so world == camera. */
const IDENTITY: DenseView = {
  frameIndex: 0,
  pose: { R: new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]), t: [0, 0, 0] },
  gray: new Uint8Array(W * H),
  rgb: new Uint8Array(W * H * 3).fill(128),
  width: W,
  height: H,
};

/** Depth map of the plane n·X = d, rendered exactly. */
function planeSweepResult(n: [number, number, number], d: number): SweepResult {
  const depth = new Float32Array(W * H);
  const cost = new Float32Array(W * H).fill(0.05);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const rx = (x - OPTS.principal[0]) / FOCAL;
      const ry = (y - OPTS.principal[1]) / FOCAL;
      // z(n·(rx, ry, 1)) = d
      const denom = n[0] * rx + n[1] * ry + n[2];
      depth[y * W + x] = denom > 1e-6 ? d / denom : 0;
    }
  }
  return { depth, cost, width: W, height: H };
}

function unit(v: [number, number, number]): [number, number, number] {
  const l = Math.hypot(...v);
  return [v[0] / l, v[1] / l, v[2] / l];
}

describe("normals from the depth map", () => {
  // A plane's inverse depth is affine in pixel position, so an exact fit must
  // recover the plane's normal exactly — including at grazing angles, which is
  // where a floor lives and where differencing neighbours fails worst.
  it.each([
    ["head on", [0, 0, 1]],
    ["tilted 30 degrees", [0, 0.5, 0.866]],
    ["floor at 75 degrees", [0, 0.966, 0.259]],
    ["skewed both ways", [0.4, -0.3, 0.866]],
  ])("recovers a %s plane's normal", (_label, raw) => {
    const n = unit(raw as [number, number, number]);
    const pts = depthToPoints(IDENTITY, planeSweepResult(n, 4), OPTS, 1);
    expect(pts.length).toBeGreaterThan(200);

    let worstDeg = 0;
    for (const p of pts) {
      // The normal is returned facing the camera, so compare against whichever
      // orientation of the true plane normal faces it too.
      const dot = Math.abs(p.normal[0] * n[0] + p.normal[1] * n[1] + p.normal[2] * n[2]);
      worstDeg = Math.max(worstDeg, (Math.acos(Math.min(1, dot)) * 180) / Math.PI);
    }
    expect(worstDeg).toBeLessThan(1.5);
  });

  it("returns unit normals", () => {
    const pts = depthToPoints(IDENTITY, planeSweepResult(unit([0.2, 0.3, 0.93]), 5), OPTS, 1);
    for (const p of pts) {
      expect(Math.hypot(...p.normal)).toBeCloseTo(1, 5);
    }
  });

  it("always points the normal back toward the camera", () => {
    for (const raw of [[0, 0, 1], [0.5, 0.5, 0.7], [-0.6, 0.2, 0.77]]) {
      const pts = depthToPoints(IDENTITY, planeSweepResult(unit(raw as [number, number, number]), 4), OPTS, 1);
      for (const p of pts) {
        // Camera at the origin looking down +Z: a visible surface's normal must
        // have a negative z component in camera space.
        expect(p.normal[2]).toBeLessThan(0);
      }
    }
  });

  // A window straddling a depth discontinuity fits no plane, and the sample in
  // the middle of it floats between foreground and background.
  it("drops flying pixels at a depth discontinuity", () => {
    const s = planeSweepResult(unit([0, 0, 1]), 4);
    for (let y = 0; y < H; y++) {
      for (let x = W / 2; x < W; x++) s.depth[y * W + x] = 9;
    }
    const pts = depthToPoints(IDENTITY, s, OPTS, 1);
    const nearEdge = pts.filter((p) => {
      const px = (p.xyz[0] / p.xyz[2]) * FOCAL + OPTS.principal[0];
      return Math.abs(px - W / 2) < 2;
    });
    expect(nearEdge.length).toBe(0);
    expect(pts.length).toBeGreaterThan(200);
  });

  it("produces nothing rather than guessing where there is no depth", () => {
    const empty: SweepResult = {
      depth: new Float32Array(W * H), cost: new Float32Array(W * H), width: W, height: H,
    };
    expect(depthToPoints(IDENTITY, empty, OPTS, 1)).toHaveLength(0);
  });
});

describe("coverage versus flying-pixel rejection", () => {
  // Rejecting too eagerly deletes the scene; rejecting too little leaves
  // samples floating in mid-air between a foreground and a background surface.
  it("keeps almost every sample on a clean plane", () => {
    const n = unit([0.1, 0.4, 0.91]);
    const pts = depthToPoints(IDENTITY, planeSweepResult(n, 5), OPTS, 1);
    const usable = (W - 1) * (H - 1);
    expect(pts.length).toBeGreaterThan(usable * 0.9);
  });

  it("tolerates a surface that is noisy without being discontinuous", () => {
    const s = planeSweepResult(unit([0, 0, 1]), 5);
    let seed = 7;
    const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    for (let i = 0; i < s.depth.length; i++) {
      if (s.depth[i] > 0) s.depth[i] *= 1 + (rand() - 0.5) * 0.02;
    }
    const pts = depthToPoints(IDENTITY, s, OPTS, 1);
    expect(pts.length).toBeGreaterThan((W - 1) * (H - 1) * 0.7);
  });

  it("still drops the samples straddling a real depth cliff", () => {
    const s = planeSweepResult(unit([0, 0, 1]), 4);
    for (let y = 0; y < H; y++) {
      for (let x = W / 2; x < W; x++) s.depth[y * W + x] = 12;
    }
    const pts = depthToPoints(IDENTITY, s, OPTS, 1);
    const straddling = pts.filter((p) => {
      const px = (p.xyz[0] / p.xyz[2]) * FOCAL + OPTS.principal[0];
      return Math.abs(px - W / 2) < 2;
    });
    expect(straddling.length).toBe(0);
  });
});
