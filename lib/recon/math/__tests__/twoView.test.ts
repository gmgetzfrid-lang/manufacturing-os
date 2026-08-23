// Ground-truth tests for the two-view geometry.
//
// These matter more than most tests in the codebase: every camera pose in a
// reconstruction descends from this maths, and a sign error here does not throw
// — it quietly produces a room turned inside out. So each routine is checked
// against a synthetic scene whose answer is known exactly.

import { describe, expect, it } from "vitest";

import {
  jacobiEigenSymmetric, mat3Mul, mat3MulVec, mat3Transpose, mat3Det,
  orthonormalize, rodrigues, rodriguesInverse, solveSymmetric, svd3x3,
} from "../linalg";
import {
  Correspondence, Pose, decomposeEssential, essentialFromCorrespondences,
  maxTriangulationAngleDeg, poseToProjection, ransacEssential, reprojectionError,
  triangulateDLT, triangulateMultiView,
} from "../twoView";

// ── Deterministic pseudo-random source ──────────────────────────────────────
function makeRng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** A room-like cloud of points in front of both cameras. */
function makeScene(rng: () => number, n: number) {
  const points: Array<[number, number, number]> = [];
  for (let i = 0; i < n; i++) {
    points.push([
      (rng() - 0.5) * 6,
      (rng() - 0.5) * 4,
      4 + rng() * 6,
    ]);
  }
  return points;
}

function project(pose: Pose, X: readonly number[]): [number, number] | null {
  const c = mat3MulVec(pose.R, X);
  const z = c[2] + pose.t[2];
  if (z <= 1e-6) return null;
  return [(c[0] + pose.t[0]) / z, (c[1] + pose.t[1]) / z];
}

function rotationAngleBetween(A: Float64Array, B: Float64Array): number {
  const rel = mat3Mul(A, mat3Transpose(B));
  const trace = rel[0] + rel[4] + rel[8];
  const cos = Math.min(1, Math.max(-1, (trace - 1) / 2));
  return (Math.acos(cos) * 180) / Math.PI;
}

function angleBetweenVectors(a: readonly number[], b: readonly number[]): number {
  const na = Math.hypot(a[0], a[1], a[2]);
  const nb = Math.hypot(b[0], b[1], b[2]);
  const cos = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (na * nb);
  return (Math.acos(Math.min(1, Math.max(-1, cos))) * 180) / Math.PI;
}

const IDENTITY: Pose = {
  R: new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]),
  t: [0, 0, 0],
};

describe("linalg", () => {
  it("jacobi recovers known eigenvalues of a symmetric matrix", () => {
    // Diagonalisable by inspection: eigenvalues 2, 3, 6.
    const A = new Float64Array([4, 1, -1, 1, 3, 0, -1, 0, 4]);
    const { values, vectors } = jacobiEigenSymmetric(A, 3);
    expect(values[0]).toBeLessThan(values[1]);
    expect(values[1]).toBeLessThan(values[2]);
    // A·v = λ·v for every returned pair.
    for (let i = 0; i < 3; i++) {
      const v = [vectors[i * 3], vectors[i * 3 + 1], vectors[i * 3 + 2]];
      const Av = mat3MulVec(A, v);
      for (let k = 0; k < 3; k++) {
        expect(Av[k]).toBeCloseTo(values[i] * v[k], 8);
      }
    }
  });

  it("svd3x3 reconstructs the original matrix", () => {
    const rng = makeRng(7);
    for (let trial = 0; trial < 20; trial++) {
      const M = new Float64Array(9);
      for (let i = 0; i < 9; i++) M[i] = (rng() - 0.5) * 4;
      const { U, S, V } = svd3x3(M);
      const D = new Float64Array([S[0], 0, 0, 0, S[1], 0, 0, 0, S[2]]);
      const recon = mat3Mul(U, mat3Mul(D, mat3Transpose(V)));
      for (let i = 0; i < 9; i++) expect(recon[i]).toBeCloseTo(M[i], 6);
      expect(S[0]).toBeGreaterThanOrEqual(S[1] - 1e-12);
      expect(S[1]).toBeGreaterThanOrEqual(S[2] - 1e-12);
    }
  });

  it("rodrigues round-trips through matrix form", () => {
    const rng = makeRng(11);
    for (let trial = 0; trial < 50; trial++) {
      const axis = [rng() - 0.5, rng() - 0.5, rng() - 0.5];
      const norm = Math.hypot(axis[0], axis[1], axis[2]) || 1;
      const angle = rng() * 2.8; // stay clear of the pi singularity
      const r = axis.map((a) => (a / norm) * angle);
      const R = rodrigues(r);
      expect(mat3Det(R)).toBeCloseTo(1, 9);
      const back = rodriguesInverse(R);
      for (let i = 0; i < 3; i++) expect(back[i]).toBeCloseTo(r[i], 7);
    }
  });

  it("orthonormalize projects a perturbed rotation back onto SO(3)", () => {
    const R = rodrigues([0.3, -0.7, 0.2]);
    const noisy = Float64Array.from(R);
    for (let i = 0; i < 9; i++) noisy[i] += (i % 3 === 0 ? 0.02 : -0.015);
    const fixed = orthonormalize(noisy);
    expect(mat3Det(fixed)).toBeCloseTo(1, 9);
    const RtR = mat3Mul(mat3Transpose(fixed), fixed);
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        expect(RtR[i * 3 + j]).toBeCloseTo(i === j ? 1 : 0, 9);
      }
    }
  });

  it("solveSymmetric solves a positive definite system", () => {
    const A = new Float64Array([4, 1, 0, 1, 3, 1, 0, 1, 2]);
    const x = new Float64Array([1, -2, 3]);
    const b = new Float64Array(3);
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) b[i] += A[i * 3 + j] * x[j];
    }
    const got = solveSymmetric(A, b, 3);
    expect(got).not.toBeNull();
    for (let i = 0; i < 3; i++) expect(got![i]).toBeCloseTo(x[i], 9);
  });
});

describe("triangulation", () => {
  it("recovers exact 3D points from two noiseless views", () => {
    const rng = makeRng(3);
    const pose2: Pose = { R: rodrigues([0.05, 0.25, -0.02]), t: [-1.2, 0.1, 0.05] };
    const P1 = poseToProjection(IDENTITY);
    const P2 = poseToProjection(pose2);

    for (const X of makeScene(rng, 40)) {
      const a = project(IDENTITY, X)!;
      const b = project(pose2, X)!;
      const got = triangulateDLT(P1, P2, a[0], a[1], b[0], b[1]);
      for (let i = 0; i < 3; i++) expect(got[i]).toBeCloseTo(X[i], 6);
    }
  });

  it("multi-view triangulation improves on two views under noise", () => {
    const rng = makeRng(5);
    const poses: Pose[] = [
      IDENTITY,
      { R: rodrigues([0.02, 0.2, 0]), t: [-1.0, 0, 0] },
      { R: rodrigues([0.03, 0.4, 0.01]), t: [-2.0, 0.05, 0.1] },
      { R: rodrigues([-0.02, 0.3, -0.03]), t: [-1.5, -0.2, 0.2] },
    ];
    const noise = 0.0015;
    let twoViewErr = 0;
    let multiErr = 0;
    const scene = makeScene(rng, 60);

    for (const X of scene) {
      const obs = poses.map((pose) => {
        const p = project(pose, X)!;
        return { pose, x: p[0] + (rng() - 0.5) * noise, y: p[1] + (rng() - 0.5) * noise };
      });
      const two = triangulateDLT(
        poseToProjection(poses[0]), poseToProjection(poses[1]),
        obs[0].x, obs[0].y, obs[1].x, obs[1].y,
      );
      const multi = triangulateMultiView(obs)!;
      twoViewErr += Math.hypot(two[0] - X[0], two[1] - X[1], two[2] - X[2]);
      multiErr += Math.hypot(multi[0] - X[0], multi[1] - X[1], multi[2] - X[2]);
    }
    expect(multiErr).toBeLessThan(twoViewErr);
  });

  it("reports a sensible triangulation angle", () => {
    const X: [number, number, number] = [0, 0, 5];
    const poses = [{ pose: IDENTITY }, { pose: { R: rodrigues([0, 0, 0]), t: [-5, 0, 0] } as Pose }];
    // Camera 2 sits 5 units to the right of camera 1, point 5 units ahead → 45°.
    expect(maxTriangulationAngleDeg(poses, X)).toBeCloseTo(45, 0);
  });
});

describe("essential matrix", () => {
  it("satisfies the epipolar constraint on noiseless data", () => {
    const rng = makeRng(13);
    const pose2: Pose = { R: rodrigues([0.04, 0.3, -0.02]), t: [-1.5, 0.08, 0.03] };
    const corr: Correspondence[] = [];
    for (const X of makeScene(rng, 30)) {
      const a = project(IDENTITY, X)!;
      const b = project(pose2, X)!;
      corr.push({ x1: a[0], y1: a[1], x2: b[0], y2: b[1] });
    }
    const E = essentialFromCorrespondences(corr)!;
    expect(E).not.toBeNull();
    for (const c of corr) {
      const Ex1 = mat3MulVec(E, [c.x1, c.y1, 1]);
      const residual = c.x2 * Ex1[0] + c.y2 * Ex1[1] + Ex1[2];
      expect(Math.abs(residual)).toBeLessThan(1e-8);
    }
  });

  it("decomposition contains the true pose among its four candidates", () => {
    const rng = makeRng(17);
    const trueR = rodrigues([0.06, 0.28, -0.04]);
    const trueT: [number, number, number] = [-1.4, 0.1, 0.05];
    const pose2: Pose = { R: trueR, t: trueT };
    const corr: Correspondence[] = [];
    for (const X of makeScene(rng, 40)) {
      const a = project(IDENTITY, X)!;
      const b = project(pose2, X)!;
      corr.push({ x1: a[0], y1: a[1], x2: b[0], y2: b[1] });
    }
    const E = essentialFromCorrespondences(corr)!;
    const candidates = decomposeEssential(E);
    expect(candidates).toHaveLength(4);
    const found = candidates.some(
      (c) => rotationAngleBetween(c.R, trueR) < 0.5 && angleBetweenVectors(c.t, trueT) < 1.0,
    );
    expect(found).toBe(true);
  });

  it("RANSAC recovers pose from noisy data with outliers", () => {
    const rng = makeRng(23);
    const trueR = rodrigues([0.05, 0.26, -0.03]);
    const trueT: [number, number, number] = [-1.3, 0.09, 0.04];
    const pose2: Pose = { R: trueR, t: trueT };

    const corr: Correspondence[] = [];
    const noise = 0.0008; // ≈ 0.8 px at f = 1000
    for (const X of makeScene(rng, 160)) {
      const a = project(IDENTITY, X)!;
      const b = project(pose2, X)!;
      corr.push({
        x1: a[0] + (rng() - 0.5) * noise, y1: a[1] + (rng() - 0.5) * noise,
        x2: b[0] + (rng() - 0.5) * noise, y2: b[1] + (rng() - 0.5) * noise,
      });
    }
    // 25% gross outliers, as a real matcher produces.
    const outliers = 40;
    for (let i = 0; i < outliers; i++) {
      corr.push({
        x1: (rng() - 0.5) * 1.2, y1: (rng() - 0.5) * 1.0,
        x2: (rng() - 0.5) * 1.2, y2: (rng() - 0.5) * 1.0,
      });
    }

    const result = ransacEssential(corr, 0.002, { seed: 99 });
    expect(result).not.toBeNull();
    expect(rotationAngleBetween(result!.pose.R, trueR)).toBeLessThan(1.0);
    expect(angleBetweenVectors(result!.pose.t, trueT)).toBeLessThan(2.5);
    // Should keep most true correspondences and reject most outliers.
    expect(result!.inlierCount).toBeGreaterThan(140);
    const outlierInliers = result!.inliers.slice(160).filter(Boolean).length;
    expect(outlierInliers).toBeLessThan(10);
    expect(result!.medianTriangulationAngleDeg).toBeGreaterThan(2);
  });

  it("returns triangulated points in front of both cameras", () => {
    const rng = makeRng(31);
    const pose2: Pose = { R: rodrigues([0.03, 0.3, 0]), t: [-1.6, 0, 0] };
    const corr: Correspondence[] = [];
    const truth: Array<[number, number, number]> = [];
    for (const X of makeScene(rng, 60)) {
      const a = project(IDENTITY, X)!;
      const b = project(pose2, X)!;
      corr.push({ x1: a[0], y1: a[1], x2: b[0], y2: b[1] });
      truth.push(X);
    }
    const result = ransacEssential(corr, 0.002, { seed: 5 })!;
    // Recovered translation is only known up to scale; rescale before comparing.
    const scale = Math.hypot(...pose2.t) / Math.hypot(...result.pose.t);
    let checked = 0;
    for (let i = 0; i < corr.length; i++) {
      const X = result.points[i];
      if (!X) continue;
      expect(X[2]).toBeGreaterThan(0);
      const expected = truth[i];
      expect(X[0] * scale).toBeCloseTo(expected[0], 1);
      expect(X[2] * scale).toBeCloseTo(expected[2], 1);
      checked++;
    }
    expect(checked).toBeGreaterThan(40);
  });

  it("rejects a degenerate pure-rotation pair by triangulation angle", () => {
    const rng = makeRng(41);
    // Same camera centre, different orientation: no baseline, no structure.
    const pose2: Pose = { R: rodrigues([0, 0.15, 0]), t: [0, 0, 0] };
    const corr: Correspondence[] = [];
    for (const X of makeScene(rng, 80)) {
      const a = project(IDENTITY, X)!;
      const b = project(pose2, X);
      if (!b) continue;
      corr.push({ x1: a[0], y1: a[1], x2: b[0], y2: b[1] });
    }
    const result = ransacEssential(corr, 0.002, { seed: 3 });
    // Either it fails outright, or it reports an angle too small to trust.
    if (result) expect(result.medianTriangulationAngleDeg).toBeLessThan(1.5);
  });
});

describe("reprojection", () => {
  it("is zero for a perfectly projected point", () => {
    const pose: Pose = { R: rodrigues([0.1, -0.2, 0.05]), t: [0.3, -0.1, 0.2] };
    const X: [number, number, number] = [1.2, -0.4, 6.0];
    const p = project(pose, X)!;
    expect(reprojectionError(pose, X, p[0], p[1])).toBeLessThan(1e-12);
  });

  it("is infinite for a point behind the camera", () => {
    const pose: Pose = { R: new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]), t: [0, 0, 0] };
    expect(reprojectionError(pose, [0, 0, -5], 0, 0)).toBe(Infinity);
  });
});
