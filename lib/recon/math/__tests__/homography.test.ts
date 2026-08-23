import { describe, expect, it } from "vitest";
import {
  homographyFromCorrespondences, ransacHomography, ransacEssential,
  type Correspondence, type Pose,
} from "../twoView";

function makeRng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

const IDENTITY: Pose = { R: new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]), t: [0, 0, 0] };

function project(pose: Pose, X: [number, number, number]) {
  const R = pose.R;
  const z = R[6] * X[0] + R[7] * X[1] + R[8] * X[2] + pose.t[2];
  const x = R[0] * X[0] + R[1] * X[1] + R[2] * X[2] + pose.t[0];
  const y = R[3] * X[0] + R[4] * X[1] + R[5] * X[2] + pose.t[1];
  return { x: x / z, y: y / z, z };
}

/** Correspondences from a set of world points seen by two cameras. */
function seen(pts: Array<[number, number, number]>, second: Pose): Correspondence[] {
  const out: Correspondence[] = [];
  for (const X of pts) {
    const a = project(IDENTITY, X);
    const b = project(second, X);
    if (a.z < 0.3 || b.z < 0.3) continue;
    out.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y });
  }
  return out;
}

/** Points on the plane z = d — a wall straight ahead. */
function wall(rng: () => number, n: number, d = 4): Array<[number, number, number]> {
  return Array.from({ length: n }, () =>
    [(rng() - 0.5) * 5, (rng() - 0.5) * 3, d] as [number, number, number]);
}

/** Points filling a volume — a real room with depth. */
function room(rng: () => number, n: number): Array<[number, number, number]> {
  return Array.from({ length: n }, () =>
    [(rng() - 0.5) * 6, (rng() - 0.5) * 3, 1.5 + rng() * 7] as [number, number, number]);
}

describe("homographyFromCorrespondences", () => {
  it("maps points exactly for a plane seen from two positions", () => {
    const rng = makeRng(3);
    const moved: Pose = { R: IDENTITY.R, t: [-0.4, 0.05, 0] };
    const corr = seen(wall(rng, 40), moved);
    const H = homographyFromCorrespondences(corr);
    expect(H).not.toBeNull();

    let worst = 0;
    for (const c of corr) {
      const w = H![6] * c.x1 + H![7] * c.y1 + H![8];
      const u = (H![0] * c.x1 + H![1] * c.y1 + H![2]) / w;
      const v = (H![3] * c.x1 + H![4] * c.y1 + H![5]) / w;
      worst = Math.max(worst, Math.hypot(u - c.x2, v - c.y2));
    }
    expect(worst).toBeLessThan(1e-9);
  });

  it("needs four correspondences", () => {
    const rng = makeRng(4);
    const corr = seen(wall(rng, 3), { R: IDENTITY.R, t: [-0.3, 0, 0] });
    expect(homographyFromCorrespondences(corr.slice(0, 3))).toBeNull();
  });

  it("recovers a pure rotation, where there is no baseline at all", () => {
    const rng = makeRng(9);
    const a = 0.15;
    const rotated: Pose = {
      R: new Float64Array([Math.cos(a), 0, Math.sin(a), 0, 1, 0, -Math.sin(a), 0, Math.cos(a)]),
      t: [0, 0, 0],
    };
    const corr = seen(room(rng, 60), rotated);
    const H = homographyFromCorrespondences(corr);
    expect(H).not.toBeNull();
    let worst = 0;
    for (const c of corr) {
      const w = H![6] * c.x1 + H![7] * c.y1 + H![8];
      const u = (H![0] * c.x1 + H![1] * c.y1 + H![2]) / w;
      const v = (H![3] * c.x1 + H![4] * c.y1 + H![5]) / w;
      worst = Math.max(worst, Math.hypot(u - c.x2, v - c.y2));
    }
    // A rotation about the optical centre is EXACTLY a homography, whatever the
    // scene depth — which is why such a pair can never yield a baseline.
    expect(worst).toBeLessThan(1e-9);
  });
});

describe("ransacHomography", () => {
  it("finds the plane through heavy outlier contamination", () => {
    const rng = makeRng(21);
    const moved: Pose = { R: IDENTITY.R, t: [-0.4, 0, 0] };
    const corr = seen(wall(rng, 120), moved);
    const clean = corr.length;
    for (let i = 0; i < 60; i++) {
      corr.push({
        x1: (rng() - 0.5) * 2, y1: (rng() - 0.5) * 2,
        x2: (rng() - 0.5) * 2, y2: (rng() - 0.5) * 2,
      });
    }
    const res = ransacHomography(corr, 0.004, { seed: 5 });
    expect(res).not.toBeNull();
    expect(res!.inlierCount).toBeGreaterThan(clean * 0.9);
    // And it must not swallow the noise it was given.
    expect(res!.inlierCount).toBeLessThan(clean + 20);
  });

  it("returns null when there are too few points", () => {
    expect(ransacHomography([], 0.004)).toBeNull();
  });
});

// The reason this file exists: telling apart a pair whose pose can be trusted
// from one whose cannot, which is what decides whether a capture reconstructs.
describe("degeneracy detection, H against E", () => {
  const ratio = (corr: Correspondence[], seed: number) => {
    const e = ransacEssential(corr, 0.004, { seed, maxIterations: 600 });
    const h = ransacHomography(corr, 0.004, { seed, maxIterations: 600 });
    const ec = e ? e.inlierCount : 0;
    const hc = h ? h.inlierCount : 0;
    return hc / Math.max(1, ec);
  };

  it("flags a wall-dominated pair as planar", () => {
    const rng = makeRng(31);
    const corr = seen(wall(rng, 150), { R: IDENTITY.R, t: [-0.4, 0.03, -0.05] });
    // A homography explains a plane completely, so it matches or beats E.
    expect(ratio(corr, 7)).toBeGreaterThan(0.9);
  });

  it("flags a pure rotation as degenerate", () => {
    const rng = makeRng(33);
    const a = 0.12;
    const rotated: Pose = {
      R: new Float64Array([Math.cos(a), 0, Math.sin(a), 0, 1, 0, -Math.sin(a), 0, Math.cos(a)]),
      t: [0, 0, 0],
    };
    expect(ratio(seen(room(rng, 150), rotated), 11)).toBeGreaterThan(0.9);
  });

  it("does NOT flag a genuine room with depth, walked through", () => {
    const rng = makeRng(37);
    const corr = seen(room(rng, 200), { R: IDENTITY.R, t: [-0.5, 0.02, -0.4] });
    // Points at many depths cannot all satisfy one homography, so H falls well
    // short of E — this pair is safe to seed from.
    expect(ratio(corr, 13)).toBeLessThan(0.8);
  });
});
