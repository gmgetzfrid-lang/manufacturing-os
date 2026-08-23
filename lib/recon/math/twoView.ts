// Two-view geometry: essential matrix, pose recovery, triangulation.
//
// OpenCV.js ships ORB, brute-force matching and solvePnPRansac, but its
// JavaScript build does not expose findEssentialMat, recoverPose or
// triangulatePoints — the whitelist upstream leaves them out. These are the
// classical algorithms (Hartley & Zisserman ch. 9-12) rather than anything
// novel, and every routine here is checked against synthetic ground truth in
// twoView.test.ts.
//
// Convention throughout: a camera maps world to camera coordinates as
//   X_cam = R · X_world + t
// and "normalised" image points are pixel coordinates premultiplied by K⁻¹, so
// the projection is simply x = X_cam.xy / X_cam.z.

import {
  mat3Mul, mat3MulVec, mat3Transpose, mat3Det, nullSpace, orthonormalize, svd3x3,
} from "./linalg";

export interface Pose {
  /** Row-major 3x3, world → camera. */
  R: Float64Array;
  /** world → camera translation. */
  t: [number, number, number];
}

export interface Correspondence {
  /** Normalised (K⁻¹-applied) coordinates in view 1 and view 2. */
  x1: number; y1: number;
  x2: number; y2: number;
}

/** Isotropic (Hartley) normalisation: centre on the mean, scale so the mean
 *  distance from the origin is sqrt(2). Without it the 8-point algorithm is
 *  numerically hopeless. */
function normalise(pts: Array<[number, number]>): { T: Float64Array; out: Array<[number, number]> } {
  const n = pts.length;
  let cx = 0, cy = 0;
  for (const [x, y] of pts) { cx += x; cy += y; }
  cx /= n; cy /= n;

  let meanDist = 0;
  for (const [x, y] of pts) meanDist += Math.hypot(x - cx, y - cy);
  meanDist /= n;
  const scale = meanDist > 1e-12 ? Math.SQRT2 / meanDist : 1;

  const T = new Float64Array([scale, 0, -scale * cx, 0, scale, -scale * cy, 0, 0, 1]);
  const out = pts.map(([x, y]) => [(x - cx) * scale, (y - cy) * scale] as [number, number]);
  return { T, out };
}

/** Essential matrix from >= 8 normalised correspondences (linear, then the
 *  rank-2 / equal-singular-value constraint imposed). */
export function essentialFromCorrespondences(corr: Correspondence[]): Float64Array | null {
  if (corr.length < 8) return null;

  const { T: T1, out: p1 } = normalise(corr.map((c) => [c.x1, c.y1]));
  const { T: T2, out: p2 } = normalise(corr.map((c) => [c.x2, c.y2]));

  // Each correspondence contributes one row of the 9-vector constraint
  // x2ᵀ E x1 = 0.
  const A = new Float64Array(corr.length * 9);
  for (let i = 0; i < corr.length; i++) {
    const [u1, v1] = p1[i];
    const [u2, v2] = p2[i];
    const r = i * 9;
    A[r] = u2 * u1;     A[r + 1] = u2 * v1; A[r + 2] = u2;
    A[r + 3] = v2 * u1; A[r + 4] = v2 * v1; A[r + 5] = v2;
    A[r + 6] = u1;      A[r + 7] = v1;      A[r + 8] = 1;
  }

  const e = nullSpace(A, corr.length, 9);
  const Enorm = new Float64Array(e);

  // Undo normalisation: E = T2ᵀ · Ê · T1
  let E = mat3Mul(mat3Transpose(T2), mat3Mul(Enorm, T1));

  // A true essential matrix has singular values (s, s, 0).
  const { U, V } = svd3x3(E);
  const D = new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 0]);
  E = mat3Mul(U, mat3Mul(D, mat3Transpose(V)));

  let norm = 0;
  for (let i = 0; i < 9; i++) norm += E[i] * E[i];
  if (!Number.isFinite(norm) || norm < 1e-18) return null;
  norm = Math.sqrt(norm);
  for (let i = 0; i < 9; i++) E[i] /= norm;
  return E;
}

/** The four (R, t) candidates consistent with an essential matrix. */
export function decomposeEssential(E: Float64Array): Pose[] {
  const { U, V } = svd3x3(E);

  // Keep both factors right-handed so the recovered rotations are proper.
  const Ufix = Float64Array.from(U);
  const Vfix = Float64Array.from(V);
  if (mat3Det(Ufix) < 0) for (let i = 0; i < 3; i++) Ufix[i * 3 + 2] *= -1;
  if (mat3Det(Vfix) < 0) for (let i = 0; i < 3; i++) Vfix[i * 3 + 2] *= -1;

  const W = new Float64Array([0, -1, 0, 1, 0, 0, 0, 0, 1]);
  const Vt = mat3Transpose(Vfix);
  const R1 = orthonormalize(mat3Mul(Ufix, mat3Mul(W, Vt)));
  const R2 = orthonormalize(mat3Mul(Ufix, mat3Mul(mat3Transpose(W), Vt)));
  const t: [number, number, number] = [Ufix[2], Ufix[5], Ufix[8]];
  const tNeg: [number, number, number] = [-t[0], -t[1], -t[2]];

  return [
    { R: R1, t }, { R: R1, t: tNeg },
    { R: R2, t }, { R: R2, t: tNeg },
  ];
}

/** Linear (DLT) triangulation of one point seen by two cameras.
 *  `P` matrices are 3x4 row-major. */
export function triangulateDLT(
  P1: Float64Array, P2: Float64Array,
  x1: number, y1: number, x2: number, y2: number,
): [number, number, number] {
  const A = new Float64Array(16);
  for (let c = 0; c < 4; c++) {
    A[c] = x1 * P1[8 + c] - P1[c];
    A[4 + c] = y1 * P1[8 + c] - P1[4 + c];
    A[8 + c] = x2 * P2[8 + c] - P2[c];
    A[12 + c] = y2 * P2[8 + c] - P2[4 + c];
  }
  const v = nullSpace(A, 4, 4);
  const w = v[3];
  if (Math.abs(w) < 1e-12) return [NaN, NaN, NaN];
  return [v[0] / w, v[1] / w, v[2] / w];
}

export function poseToProjection(pose: Pose): Float64Array {
  const P = new Float64Array(12);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) P[r * 4 + c] = pose.R[r * 3 + c];
    P[r * 4 + 3] = pose.t[r];
  }
  return P;
}

const IDENTITY_POSE: Pose = {
  R: new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]),
  t: [0, 0, 0],
};

/** Pick the (R, t) whose triangulated points lie in front of both cameras.
 *  Also returns the surviving points so the caller does not re-triangulate. */
export function selectPoseByCheirality(
  candidates: Pose[],
  corr: Correspondence[],
): { pose: Pose; points: Array<[number, number, number] | null>; inFront: number } {
  const P1 = poseToProjection(IDENTITY_POSE);
  let best = { pose: candidates[0], points: [] as Array<[number, number, number] | null>, inFront: -1 };

  for (const cand of candidates) {
    const P2 = poseToProjection(cand);
    const points: Array<[number, number, number] | null> = [];
    let inFront = 0;
    for (const c of corr) {
      const X = triangulateDLT(P1, P2, c.x1, c.y1, c.x2, c.y2);
      if (!Number.isFinite(X[0])) { points.push(null); continue; }
      const z1 = X[2];
      const cam2 = mat3MulVec(cand.R, X);
      const z2 = cam2[2] + cand.t[2];
      // Reject points at absurd depth as well as behind: a near-degenerate pair
      // produces "valid" points a thousand baselines away.
      if (z1 > 1e-6 && z2 > 1e-6 && z1 < 1e4 && z2 < 1e4) {
        inFront++;
        points.push(X);
      } else {
        points.push(null);
      }
    }
    if (inFront > best.inFront) best = { pose: cand, points, inFront };
  }
  return best;
}

/** First-order (Sampson) approximation of the geometric epipolar error. */
export function sampsonError(E: Float64Array, c: Correspondence): number {
  const x1 = [c.x1, c.y1, 1];
  const x2 = [c.x2, c.y2, 1];
  const Ex1 = mat3MulVec(E, x1);
  const Etx2 = mat3MulVec(mat3Transpose(E), x2);
  const num = x2[0] * Ex1[0] + x2[1] * Ex1[1] + x2[2] * Ex1[2];
  const denom = Ex1[0] * Ex1[0] + Ex1[1] * Ex1[1] + Etx2[0] * Etx2[0] + Etx2[1] * Etx2[1];
  if (denom < 1e-18) return Infinity;
  return (num * num) / denom;
}

export interface EssentialResult {
  E: Float64Array;
  pose: Pose;
  inliers: boolean[];
  inlierCount: number;
  points: Array<[number, number, number] | null>;
  /** Median angle (degrees) between the two rays over inliers — the honest
   *  measure of whether this pair can be triangulated at all. */
  medianTriangulationAngleDeg: number;
  /**
   * How many inliers triangulate at a healthy angle.
   *
   * Walking forward, most correspondences are points straight ahead whose rays
   * barely diverge however far you walk, so every summary statistic of the
   * angle — median, mean, even a high quantile — is dragged down by geometry
   * that says nothing about whether the pair can seed a reconstruction. What
   * bootstrapping actually needs is ENOUGH well-conditioned points, not a
   * well-conditioned typical point, and that is a count, not an average.
   */
  wellConditionedCount: number;
}

/** Ray angle above which a correspondence triangulates stably. */
export const WELL_CONDITIONED_DEG = 2.0;

function triangulationAngleDeg(pose: Pose, X: [number, number, number]): number {
  // Ray from camera 1 (at the origin, looking down +z) and from camera 2's centre.
  const c2 = mat3MulVec(mat3Transpose(pose.R), [-pose.t[0], -pose.t[1], -pose.t[2]]);
  const r1 = X;
  const r2: [number, number, number] = [X[0] - c2[0], X[1] - c2[1], X[2] - c2[2]];
  const n1 = Math.hypot(r1[0], r1[1], r1[2]);
  const n2 = Math.hypot(r2[0], r2[1], r2[2]);
  if (n1 < 1e-9 || n2 < 1e-9) return 0;
  const cos = (r1[0] * r2[0] + r1[1] * r2[1] + r1[2] * r2[2]) / (n1 * n2);
  return (Math.acos(Math.min(1, Math.max(-1, cos))) * 180) / Math.PI;
}

/**
 * RANSAC essential-matrix estimation.
 *
 * `threshold` is in normalised units — divide the pixel threshold by the focal
 * length before calling, so the same value means the same thing regardless of
 * image resolution.
 */
export function ransacEssential(
  corr: Correspondence[],
  threshold: number,
  options: { confidence?: number; maxIterations?: number; seed?: number } = {},
): EssentialResult | null {
  const n = corr.length;
  if (n < 8) return null;

  const confidence = options.confidence ?? 0.9999;
  const maxIterations = options.maxIterations ?? 2000;
  const thresholdSq = threshold * threshold;

  // Deterministic PRNG: two runs on the same data must give the same model,
  // otherwise a reconstruction is not reproducible.
  let seed = options.seed ?? 0x2f6e2b1;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };

  let bestInliers: boolean[] = [];
  let bestCount = 0;
  let bestE: Float64Array | null = null;
  let iterations = maxIterations;

  const sample = new Set<number>();
  for (let iter = 0; iter < iterations; iter++) {
    sample.clear();
    while (sample.size < 8) sample.add(Math.floor(rand() * n));
    const subset = Array.from(sample).map((i) => corr[i]);

    const E = essentialFromCorrespondences(subset);
    if (!E) continue;

    const inliers = new Array<boolean>(n);
    let count = 0;
    for (let i = 0; i < n; i++) {
      const ok = sampsonError(E, corr[i]) < thresholdSq;
      inliers[i] = ok;
      if (ok) count++;
    }

    if (count > bestCount) {
      bestCount = count;
      bestInliers = inliers;
      bestE = E;

      // Adaptive stopping: once the inlier ratio is high, stop early.
      const ratio = count / n;
      if (ratio > 0.05) {
        const denom = Math.log(1 - Math.pow(ratio, 8));
        if (denom < 0) {
          const needed = Math.log(1 - confidence) / denom;
          iterations = Math.min(iterations, Math.ceil(needed) + 8);
        }
      }
    }
  }

  if (!bestE || bestCount < 8) return null;

  // Refit on all inliers — the 8-point sample was only ever a hypothesis.
  const inlierCorr = corr.filter((_, i) => bestInliers[i]);
  const refined = essentialFromCorrespondences(inlierCorr) ?? bestE;
  const finalInliers = new Array<boolean>(n);
  let finalCount = 0;
  for (let i = 0; i < n; i++) {
    const ok = sampsonError(refined, corr[i]) < thresholdSq;
    finalInliers[i] = ok;
    if (ok) finalCount++;
  }
  if (finalCount < 8) return null;

  const selected = selectPoseByCheirality(
    decomposeEssential(refined),
    corr.filter((_, i) => finalInliers[i]),
  );

  const angles: number[] = [];
  for (const X of selected.points) {
    if (X) angles.push(triangulationAngleDeg(selected.pose, X));
  }
  angles.sort((a, b) => a - b);
  const quantile = (q: number) =>
    angles.length ? angles[Math.min(angles.length - 1, Math.floor(angles.length * q))] : 0;
  const medianAngle = quantile(0.5);
  const wellConditioned = angles.filter((a) => a >= WELL_CONDITIONED_DEG).length;

  // Map the compacted point list back onto the full correspondence indexing.
  const points: Array<[number, number, number] | null> = new Array(n).fill(null);
  let k = 0;
  for (let i = 0; i < n; i++) if (finalInliers[i]) points[i] = selected.points[k++];

  return {
    E: refined,
    pose: selected.pose,
    inliers: finalInliers,
    inlierCount: finalCount,
    points,
    medianTriangulationAngleDeg: medianAngle,
    wellConditionedCount: wellConditioned,
  };
}

/** Reprojection error, in normalised units, of a world point in a pose. */
export function reprojectionError(
  pose: Pose, X: readonly number[], x: number, y: number,
): number {
  const c = mat3MulVec(pose.R, X);
  const z = c[2] + pose.t[2];
  if (z <= 1e-9) return Infinity;
  const px = (c[0] + pose.t[0]) / z;
  const py = (c[1] + pose.t[1]) / z;
  return Math.hypot(px - x, py - y);
}

/** Triangulate from an arbitrary number of views (least squares over all rays). */
export function triangulateMultiView(
  observations: Array<{ pose: Pose; x: number; y: number }>,
): [number, number, number] | null {
  if (observations.length < 2) return null;
  const rows = observations.length * 2;
  const A = new Float64Array(rows * 4);
  observations.forEach((obs, i) => {
    const P = poseToProjection(obs.pose);
    for (let c = 0; c < 4; c++) {
      A[i * 8 + c] = obs.x * P[8 + c] - P[c];
      A[i * 8 + 4 + c] = obs.y * P[8 + c] - P[4 + c];
    }
  });
  const v = nullSpace(A, rows, 4);
  if (Math.abs(v[3]) < 1e-12) return null;
  const X: [number, number, number] = [v[0] / v[3], v[1] / v[3], v[2] / v[3]];
  return Number.isFinite(X[0]) && Number.isFinite(X[1]) && Number.isFinite(X[2]) ? X : null;
}

/** Largest angle between any pair of rays observing a point — the criterion for
 *  whether a track is well-conditioned enough to keep. */
export function maxTriangulationAngleDeg(
  observations: Array<{ pose: Pose }>, X: readonly number[],
): number {
  const centres = observations.map((o) => {
    const c = mat3MulVec(mat3Transpose(o.pose.R), [-o.pose.t[0], -o.pose.t[1], -o.pose.t[2]]);
    return c;
  });
  let best = 0;
  for (let i = 0; i < centres.length; i++) {
    for (let j = i + 1; j < centres.length; j++) {
      const r1 = [X[0] - centres[i][0], X[1] - centres[i][1], X[2] - centres[i][2]];
      const r2 = [X[0] - centres[j][0], X[1] - centres[j][1], X[2] - centres[j][2]];
      const n1 = Math.hypot(r1[0], r1[1], r1[2]);
      const n2 = Math.hypot(r2[0], r2[1], r2[2]);
      if (n1 < 1e-9 || n2 < 1e-9) continue;
      const cos = (r1[0] * r2[0] + r1[1] * r2[1] + r1[2] * r2[2]) / (n1 * n2);
      const ang = (Math.acos(Math.min(1, Math.max(-1, cos))) * 180) / Math.PI;
      if (ang > best) best = ang;
    }
  }
  return best;
}

// ── Homography, and why a reconstruction pipeline needs one ────────────────
//
// The essential matrix is DEGENERATE when the correspondences all lie on a
// plane, or when the camera only rotated. Both are ordinary in real footage:
// an industrial area is flat walls, floor and panels, and a walk through one
// spends much of its time facing a single large surface. On such a pair the
// 8-point solution is underdetermined, RANSAC settles on whichever spurious
// model fits a handful of points, and a perfectly good pair is thrown away as
// unverifiable — taking its correspondences out of the track graph with it.
//
// Estimating a homography alongside E tells us which case we are in. A pair
// that a homography explains as well as the essential matrix is planar or
// rotational: its matches are real and worth keeping for tracks, but its POSE
// cannot be trusted, so it must not seed a reconstruction.

/** Homography from >= 4 correspondences by normalised DLT. */
export function homographyFromCorrespondences(corr: Correspondence[]): Float64Array | null {
  if (corr.length < 4) return null;

  const { T: T1, out: p1 } = normalise(corr.map((c) => [c.x1, c.y1]));
  const { T: T2, out: p2 } = normalise(corr.map((c) => [c.x2, c.y2]));

  const rows = corr.length * 2;
  const A = new Float64Array(rows * 9);
  for (let i = 0; i < corr.length; i++) {
    const [x, y] = p1[i];
    const [u, v] = p2[i];
    const r0 = i * 18;
    A[r0 + 0] = -x; A[r0 + 1] = -y; A[r0 + 2] = -1;
    A[r0 + 6] = u * x; A[r0 + 7] = u * y; A[r0 + 8] = u;
    const r1 = r0 + 9;
    A[r1 + 3] = -x; A[r1 + 4] = -y; A[r1 + 5] = -1;
    A[r1 + 6] = v * x; A[r1 + 7] = v * y; A[r1 + 8] = v;
  }

  const h = nullSpace(A, rows, 9);
  if (!h) return null;

  // Undo the conditioning: H = T2⁻¹ · Ĥ · T1
  const Hn = new Float64Array(h);
  const T2inv = invert3x3(T2);
  if (!T2inv) return null;
  const H = mat3Mul(T2inv, mat3Mul(Hn, T1));

  // Scale so the comparison below is not at the mercy of an arbitrary factor.
  let norm = 0;
  for (let i = 0; i < 9; i++) norm += H[i] * H[i];
  norm = Math.sqrt(norm);
  if (!(norm > 1e-12)) return null;
  for (let i = 0; i < 9; i++) H[i] /= norm;
  return H;
}


function invert3x3(m: Float64Array): Float64Array | null {
  const d =
    m[0] * (m[4] * m[8] - m[5] * m[7]) -
    m[1] * (m[3] * m[8] - m[5] * m[6]) +
    m[2] * (m[3] * m[7] - m[4] * m[6]);
  if (Math.abs(d) < 1e-14) return null;
  const inv = new Float64Array(9);
  inv[0] = (m[4] * m[8] - m[5] * m[7]) / d;
  inv[1] = (m[2] * m[7] - m[1] * m[8]) / d;
  inv[2] = (m[1] * m[5] - m[2] * m[4]) / d;
  inv[3] = (m[5] * m[6] - m[3] * m[8]) / d;
  inv[4] = (m[0] * m[8] - m[2] * m[6]) / d;
  inv[5] = (m[2] * m[3] - m[0] * m[5]) / d;
  inv[6] = (m[3] * m[7] - m[4] * m[6]) / d;
  inv[7] = (m[1] * m[6] - m[0] * m[7]) / d;
  inv[8] = (m[0] * m[4] - m[1] * m[3]) / d;
  return inv;
}

/** Symmetric transfer error: a point must map correctly in both directions. */
function homographyError(H: Float64Array, Hinv: Float64Array, c: Correspondence): number {
  const map = (m: Float64Array, x: number, y: number) => {
    const w = m[6] * x + m[7] * y + m[8];
    if (Math.abs(w) < 1e-12) return null;
    return [(m[0] * x + m[1] * y + m[2]) / w, (m[3] * x + m[4] * y + m[5]) / w];
  };
  const f = map(H, c.x1, c.y1);
  const b = map(Hinv, c.x2, c.y2);
  if (!f || !b) return Infinity;
  return Math.hypot(f[0] - c.x2, f[1] - c.y2) + Math.hypot(b[0] - c.x1, b[1] - c.y1);
}

export interface HomographyResult {
  H: Float64Array;
  inliers: boolean[];
  inlierCount: number;
}

export function ransacHomography(
  corr: Correspondence[],
  threshold: number,
  options: { confidence?: number; maxIterations?: number; seed?: number } = {},
): HomographyResult | null {
  const n = corr.length;
  if (n < 4) return null;

  const confidence = options.confidence ?? 0.999;
  let maxIterations = options.maxIterations ?? 800;
  // Symmetric transfer sums two distances, so the budget is two one-way errors.
  const limit = threshold * 2;

  let state = (options.seed ?? 1) >>> 0 || 1;
  const rand = () => {
    state ^= state << 13; state >>>= 0;
    state ^= state >> 17;
    state ^= state << 5; state >>>= 0;
    return state / 4294967296;
  };

  let bestInliers: boolean[] | null = null;
  let bestCount = 0;

  for (let iter = 0; iter < maxIterations; iter++) {
    const pick = new Set<number>();
    let guard = 0;
    while (pick.size < 4 && guard++ < 64) pick.add(Math.floor(rand() * n));
    if (pick.size < 4) continue;

    const H = homographyFromCorrespondences([...pick].map((i) => corr[i]));
    if (!H) continue;
    const Hinv = invert3x3(H);
    if (!Hinv) continue;

    const inliers = new Array<boolean>(n);
    let count = 0;
    for (let i = 0; i < n; i++) {
      const ok = homographyError(H, Hinv, corr[i]) < limit;
      inliers[i] = ok;
      if (ok) count++;
    }
    if (count > bestCount) {
      bestCount = count;
      bestInliers = inliers;
      const ratio = count / n;
      if (ratio > 0.05) {
        const denom = Math.log(1 - Math.pow(ratio, 4));
        if (denom < 0) {
          maxIterations = Math.min(
            maxIterations, Math.ceil(Math.log(1 - confidence) / denom) + 8,
          );
        }
      }
    }
  }

  if (!bestInliers || bestCount < 4) return null;

  // Refit on everything that agreed, which is worth a few tenths of a pixel.
  const refit = homographyFromCorrespondences(corr.filter((_, i) => bestInliers![i]));
  if (refit) {
    const refitInv = invert3x3(refit);
    if (refitInv) {
      const inliers = new Array<boolean>(n);
      let count = 0;
      for (let i = 0; i < n; i++) {
        const ok = homographyError(refit, refitInv, corr[i]) < limit;
        inliers[i] = ok;
        if (ok) count++;
      }
      if (count >= bestCount) return { H: refit, inliers, inlierCount: count };
    }
  }
  return { H: bestInliers ? new Float64Array(9) : new Float64Array(9), inliers: bestInliers, inlierCount: bestCount };
}
