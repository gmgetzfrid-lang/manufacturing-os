// Bundle adjustment against ground truth.
//
// The test that matters: perturb a known-good reconstruction, run the solver,
// and check it walks back to the truth. If the Jacobians or the Schur
// elimination were wrong the cost would stall or diverge instead.

import { describe, expect, it } from "vitest";

import { mat3MulVec, rodrigues } from "../linalg";
import { bundleAdjust, reprojectionRmsePx, type BundleObservation } from "../bundle";
import type { Pose } from "../twoView";

function makeRng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

const FOCAL = 900;

/** A ring of cameras looking at a cloud — a miniature of the real capture. */
function buildScene(rng: () => number, nCameras: number, nPoints: number) {
  const points: Array<[number, number, number]> = [];
  for (let i = 0; i < nPoints; i++) {
    points.push([(rng() - 0.5) * 6, (rng() - 0.5) * 3, 8 + (rng() - 0.5) * 5]);
  }

  const poses: Pose[] = [];
  for (let i = 0; i < nCameras; i++) {
    const angle = (i / nCameras) * 0.9 - 0.45;
    const R = rodrigues([0.02 * Math.sin(i), angle * 0.5, 0.01 * i]);
    const t: [number, number, number] = [-i * 0.45, 0.05 * Math.sin(i * 0.7), 0.1 * i];
    poses.push({ R, t });
  }
  return { poses, points };
}

function project(pose: Pose, X: readonly number[], focal: number): [number, number] | null {
  const c = mat3MulVec(pose.R, X);
  const z = c[2] + pose.t[2];
  if (z <= 1e-6) return null;
  return [(focal * (c[0] + pose.t[0])) / z, (focal * (c[1] + pose.t[1])) / z];
}

function buildObservations(
  poses: Pose[], points: Array<[number, number, number]>, focal: number,
  rng: () => number, noisePx: number,
): BundleObservation[] {
  const obs: BundleObservation[] = [];
  for (let c = 0; c < poses.length; c++) {
    for (let p = 0; p < points.length; p++) {
      const uv = project(poses[c], points[p], focal);
      if (!uv) continue;
      // Keep only what a real sensor would see.
      if (Math.abs(uv[0]) > 900 || Math.abs(uv[1]) > 600) continue;
      obs.push({
        cameraIndex: c, pointIndex: p,
        u: uv[0] + (rng() - 0.5) * noisePx,
        v: uv[1] + (rng() - 0.5) * noisePx,
      });
    }
  }
  return obs;
}

function perturb(
  poses: Pose[], points: Array<[number, number, number]>, rng: () => number,
  rotAmp: number, transAmp: number, pointAmp: number,
) {
  const noisyPoses = poses.map((p, i) => {
    if (i === 0) return { R: Float64Array.from(p.R), t: [...p.t] as [number, number, number] };
    const dR = rodrigues([(rng() - 0.5) * rotAmp, (rng() - 0.5) * rotAmp, (rng() - 0.5) * rotAmp]);
    const R = new Float64Array(9);
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        let s = 0;
        for (let k = 0; k < 3; k++) s += dR[r * 3 + k] * p.R[k * 3 + c];
        R[r * 3 + c] = s;
      }
    }
    return {
      R,
      t: [
        p.t[0] + (rng() - 0.5) * transAmp,
        p.t[1] + (rng() - 0.5) * transAmp,
        p.t[2] + (rng() - 0.5) * transAmp,
      ] as [number, number, number],
    };
  });
  const noisyPoints = points.map(
    (X) => [
      X[0] + (rng() - 0.5) * pointAmp,
      X[1] + (rng() - 0.5) * pointAmp,
      X[2] + (rng() - 0.5) * pointAmp,
    ] as [number, number, number],
  );
  return { noisyPoses, noisyPoints };
}

describe("bundleAdjust", () => {
  it("drives a perturbed reconstruction back toward ground truth", () => {
    const rng = makeRng(101);
    const { poses, points } = buildScene(rng, 10, 140);
    const observations = buildObservations(poses, points, FOCAL, rng, 0);
    expect(observations.length).toBeGreaterThan(600);

    const { noisyPoses, noisyPoints } = perturb(poses, points, rng, 0.02, 0.06, 0.12);
    const before = reprojectionRmsePx(noisyPoses, noisyPoints, FOCAL, observations);
    expect(before).toBeGreaterThan(2);

    const result = bundleAdjust(
      {
        poses: noisyPoses, points: noisyPoints, observations,
        focal: FOCAL, fixedCameras: new Set([0]),
      },
      { iterations: 40, huberPx: 1000, functionTolerance: 1e-12 },
    );

    expect(result.finalRmsePx).toBeLessThan(before);
    // Noiseless observations: a correct solver gets essentially exact.
    expect(result.finalRmsePx).toBeLessThan(0.15);
  });

  it("reduces cost with realistic pixel noise and outliers", () => {
    const rng = makeRng(202);
    const { poses, points } = buildScene(rng, 12, 160);
    const observations = buildObservations(poses, points, FOCAL, rng, 1.0);

    // 4% gross mismatches, which robust loss must absorb.
    for (let i = 0; i < Math.floor(observations.length * 0.04); i++) {
      const idx = Math.floor(rng() * observations.length);
      observations[idx] = {
        ...observations[idx],
        u: observations[idx].u + (rng() - 0.5) * 220,
        v: observations[idx].v + (rng() - 0.5) * 220,
      };
    }

    const { noisyPoses, noisyPoints } = perturb(poses, points, rng, 0.015, 0.05, 0.1);
    const result = bundleAdjust(
      {
        poses: noisyPoses, points: noisyPoints, observations,
        focal: FOCAL, fixedCameras: new Set([0]),
      },
      { iterations: 30, huberPx: 2.5 },
    );

    expect(result.finalCost).toBeLessThan(result.initialCost);
    expect(result.finalRmsePx).toBeLessThan(result.initialRmsePx);
  });

  it("recovers an unknown focal length", () => {
    const rng = makeRng(303);
    const { poses, points } = buildScene(rng, 10, 150);
    const observations = buildObservations(poses, points, FOCAL, rng, 0);

    // Start 20% off, as a guessed phone focal length realistically would be.
    const guessed = FOCAL * 1.2;
    const { noisyPoses, noisyPoints } = perturb(poses, points, rng, 0.01, 0.03, 0.08);

    const result = bundleAdjust(
      {
        poses: noisyPoses, points: noisyPoints, observations,
        focal: guessed, fixedCameras: new Set([0]), refineFocal: true,
      },
      { iterations: 60, huberPx: 1000, functionTolerance: 1e-14 },
    );

    // Focal and depth trade off against each other when one camera is pinned,
    // so what must improve is the fit — and the focal should move toward truth.
    expect(result.finalRmsePx).toBeLessThan(result.initialRmsePx);
    expect(Math.abs(result.focal - FOCAL)).toBeLessThan(Math.abs(guessed - FOCAL));
  });

  it("leaves fixed cameras untouched", () => {
    const rng = makeRng(404);
    const { poses, points } = buildScene(rng, 8, 100);
    const observations = buildObservations(poses, points, FOCAL, rng, 0.5);
    const { noisyPoses, noisyPoints } = perturb(poses, points, rng, 0.02, 0.05, 0.1);

    const fixed = new Set([0, 3]);
    const result = bundleAdjust(
      { poses: noisyPoses, points: noisyPoints, observations, focal: FOCAL, fixedCameras: fixed },
      { iterations: 15 },
    );

    for (const i of fixed) {
      for (let k = 0; k < 9; k++) expect(result.poses[i].R[k]).toBe(noisyPoses[i].R[k]);
      for (let k = 0; k < 3; k++) expect(result.poses[i].t[k]).toBe(noisyPoses[i].t[k]);
    }
  });

  it("is a no-op when every camera is fixed", () => {
    const rng = makeRng(505);
    const { poses, points } = buildScene(rng, 4, 40);
    const observations = buildObservations(poses, points, FOCAL, rng, 0);
    const result = bundleAdjust(
      {
        poses, points, observations, focal: FOCAL,
        fixedCameras: new Set([0, 1, 2, 3]),
      },
      { iterations: 5 },
    );
    expect(result.iterations).toBe(0);
    expect(result.finalCost).toBe(result.initialCost);
  });
});
