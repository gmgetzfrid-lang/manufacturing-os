// PnP against ground truth — the routine that registers every frame after the
// first pair, so an error here is an error in every camera position.

import { describe, expect, it } from "vitest";

import { mat3Mul, mat3Transpose, rodrigues } from "../linalg";
import { pnpDlt, pnpRansac, refinePose, type PnpCorrespondence } from "../pnp";
import type { Pose } from "../twoView";

function makeRng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

function project(pose: Pose, X: readonly number[]): [number, number] | null {
  const c = [
    pose.R[0] * X[0] + pose.R[1] * X[1] + pose.R[2] * X[2] + pose.t[0],
    pose.R[3] * X[0] + pose.R[4] * X[1] + pose.R[5] * X[2] + pose.t[1],
    pose.R[6] * X[0] + pose.R[7] * X[1] + pose.R[8] * X[2] + pose.t[2],
  ];
  if (c[2] <= 1e-6) return null;
  return [c[0] / c[2], c[1] / c[2]];
}

function rotationAngleBetween(A: Float64Array, B: Float64Array): number {
  const rel = mat3Mul(A, mat3Transpose(B));
  const trace = rel[0] + rel[4] + rel[8];
  return (Math.acos(Math.min(1, Math.max(-1, (trace - 1) / 2))) * 180) / Math.PI;
}

function scene(rng: () => number, n: number): Array<[number, number, number]> {
  const pts: Array<[number, number, number]> = [];
  for (let i = 0; i < n; i++) {
    pts.push([(rng() - 0.5) * 8, (rng() - 0.5) * 5, 6 + rng() * 8]);
  }
  return pts;
}

function makeCorr(
  pose: Pose, points: Array<[number, number, number]>, rng: () => number, noise = 0,
): PnpCorrespondence[] {
  const out: PnpCorrespondence[] = [];
  for (const X of points) {
    const p = project(pose, X);
    if (!p) continue;
    out.push({ X, x: p[0] + (rng() - 0.5) * noise, y: p[1] + (rng() - 0.5) * noise });
  }
  return out;
}

const TRUE_POSE: Pose = {
  R: rodrigues([0.08, -0.34, 0.05]),
  t: [0.6, -0.25, 1.4],
};

describe("pnpDlt", () => {
  it("recovers the exact pose from noiseless correspondences", () => {
    const rng = makeRng(11);
    const corr = makeCorr(TRUE_POSE, scene(rng, 20), rng, 0);
    const got = pnpDlt(corr);
    expect(got).not.toBeNull();
    expect(rotationAngleBetween(got!.R, TRUE_POSE.R)).toBeLessThan(0.05);
    for (let i = 0; i < 3; i++) expect(got!.t[i]).toBeCloseTo(TRUE_POSE.t[i], 4);
  });

  it("returns null when given too few points", () => {
    const rng = makeRng(12);
    expect(pnpDlt(makeCorr(TRUE_POSE, scene(rng, 4), rng, 0))).toBeNull();
  });

  it("works at the six-point minimum", () => {
    const rng = makeRng(13);
    const got = pnpDlt(makeCorr(TRUE_POSE, scene(rng, 6), rng, 0));
    expect(got).not.toBeNull();
    expect(rotationAngleBetween(got!.R, TRUE_POSE.R)).toBeLessThan(0.5);
  });
});

describe("refinePose", () => {
  it("pulls a perturbed pose back to the truth", () => {
    const rng = makeRng(21);
    const corr = makeCorr(TRUE_POSE, scene(rng, 60), rng, 0);
    const start: Pose = {
      R: mat3Mul(rodrigues([0.05, 0.04, -0.03]), TRUE_POSE.R),
      t: [TRUE_POSE.t[0] + 0.15, TRUE_POSE.t[1] - 0.1, TRUE_POSE.t[2] + 0.2],
    };
    const refined = refinePose(start, corr, 30, 1e3);
    expect(rotationAngleBetween(refined.R, TRUE_POSE.R))
      .toBeLessThan(rotationAngleBetween(start.R, TRUE_POSE.R));
    expect(rotationAngleBetween(refined.R, TRUE_POSE.R)).toBeLessThan(0.05);
    for (let i = 0; i < 3; i++) expect(refined.t[i]).toBeCloseTo(TRUE_POSE.t[i], 3);
  });
});

describe("pnpRansac", () => {
  it("recovers pose despite 40% outliers", () => {
    const rng = makeRng(31);
    const points = scene(rng, 120);
    const corr = makeCorr(TRUE_POSE, points, rng, 0.0008);
    const clean = corr.length;
    for (let i = 0; i < 80; i++) {
      corr.push({
        X: [(rng() - 0.5) * 8, (rng() - 0.5) * 5, 6 + rng() * 8],
        x: (rng() - 0.5) * 1.2,
        y: (rng() - 0.5) * 0.9,
      });
    }

    const result = pnpRansac(corr, 0.003, { seed: 7, minInliers: 12 });
    expect(result).not.toBeNull();
    expect(rotationAngleBetween(result!.pose.R, TRUE_POSE.R)).toBeLessThan(1.0);
    for (let i = 0; i < 3; i++) expect(result!.pose.t[i]).toBeCloseTo(TRUE_POSE.t[i], 1);
    expect(result!.inlierCount).toBeGreaterThan(clean * 0.85);
    // Outliers were appended after the clean set, so they should be rejected.
    const outlierInliers = result!.inliers.slice(clean).filter(Boolean).length;
    expect(outlierInliers).toBeLessThan(12);
  });

  it("uses a supplied initial guess", () => {
    const rng = makeRng(41);
    const corr = makeCorr(TRUE_POSE, scene(rng, 40), rng, 0.0005);
    const guess: Pose = {
      R: mat3Mul(rodrigues([0.02, 0.03, -0.01]), TRUE_POSE.R),
      t: [TRUE_POSE.t[0] + 0.05, TRUE_POSE.t[1], TRUE_POSE.t[2] - 0.05],
    };
    const result = pnpRansac(corr, 0.003, { seed: 3, initial: guess, minInliers: 10 });
    expect(result).not.toBeNull();
    expect(rotationAngleBetween(result!.pose.R, TRUE_POSE.R)).toBeLessThan(0.5);
  });

  it("returns null when correspondences are pure noise", () => {
    const rng = makeRng(51);
    const corr: PnpCorrespondence[] = [];
    for (let i = 0; i < 60; i++) {
      corr.push({
        X: [(rng() - 0.5) * 8, (rng() - 0.5) * 5, 6 + rng() * 8],
        x: (rng() - 0.5) * 1.4,
        y: (rng() - 0.5) * 1.1,
      });
    }
    const result = pnpRansac(corr, 0.002, { seed: 9, minInliers: 25 });
    expect(result).toBeNull();
  });

  it("reports the mean error in pixels when given a focal length", () => {
    const rng = makeRng(61);
    const corr = makeCorr(TRUE_POSE, scene(rng, 50), rng, 0.001);
    const result = pnpRansac(corr, 0.004, { seed: 5, focal: 900, minInliers: 10 });
    expect(result).not.toBeNull();
    // 0.001 normalised jitter at f=900 is well under a pixel.
    expect(result!.meanErrorPx).toBeLessThan(2);
  });
});
