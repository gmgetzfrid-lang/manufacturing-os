// Perspective-n-Point: where does this camera sit, given points we already know?
//
// This is how every frame after the first two gets registered. OpenCV.js does
// expose solvePnPRansac, but driving it means marshalling Mats of exactly the
// right channel layout across the WASM boundary for every candidate frame, and
// a silent type mismatch there is very hard to diagnose. The algorithm itself
// is short and testable, so it lives here in TypeScript with the rest of the
// geometry: DLT for the minimal solve, RANSAC for robustness, Gauss-Newton with
// a Huber loss to polish.
//
// All image coordinates are normalised (K⁻¹ applied), so the projection is
// x = (R·X + t).xy / (R·X + t).z.

import {
  mat3MulVec, nullSpace, orthonormalize, rodrigues, solveSymmetric,
} from "./linalg";
import type { Pose } from "./twoView";

export interface PnpCorrespondence {
  /** World point. */
  X: [number, number, number];
  /** Normalised image observation. */
  x: number;
  y: number;
}

/** Direct linear transform pose from >= 6 correspondences. */
export function pnpDlt(corr: PnpCorrespondence[]): Pose | null {
  if (corr.length < 6) return null;

  // Condition the world points — DLT is badly scaled otherwise.
  let cx = 0, cy = 0, cz = 0;
  for (const c of corr) { cx += c.X[0]; cy += c.X[1]; cz += c.X[2]; }
  cx /= corr.length; cy /= corr.length; cz /= corr.length;
  let meanDist = 0;
  for (const c of corr) meanDist += Math.hypot(c.X[0] - cx, c.X[1] - cy, c.X[2] - cz);
  meanDist /= corr.length;
  const scale = meanDist > 1e-9 ? Math.sqrt(3) / meanDist : 1;

  const rows = corr.length * 2;
  const A = new Float64Array(rows * 12);
  corr.forEach((c, i) => {
    const X = (c.X[0] - cx) * scale;
    const Y = (c.X[1] - cy) * scale;
    const Z = (c.X[2] - cz) * scale;
    const r0 = i * 24;
    // x·(P3·X) − (P1·X) = 0
    A[r0] = -X; A[r0 + 1] = -Y; A[r0 + 2] = -Z; A[r0 + 3] = -1;
    A[r0 + 8] = c.x * X; A[r0 + 9] = c.x * Y; A[r0 + 10] = c.x * Z; A[r0 + 11] = c.x;
    const r1 = r0 + 12;
    A[r1 + 4] = -X; A[r1 + 5] = -Y; A[r1 + 6] = -Z; A[r1 + 7] = -1;
    A[r1 + 8] = c.y * X; A[r1 + 9] = c.y * Y; A[r1 + 10] = c.y * Z; A[r1 + 11] = c.y;
  });

  const p = nullSpace(A, rows, 12);

  const Rraw = new Float64Array([p[0], p[1], p[2], p[4], p[5], p[6], p[8], p[9], p[10]]);
  const traw: [number, number, number] = [p[3], p[7], p[11]];

  // The solution is only defined up to scale; recover it from the rotation rows,
  // which must be unit length.
  let norm = 0;
  for (let r = 0; r < 3; r++) {
    norm += Math.hypot(Rraw[r * 3], Rraw[r * 3 + 1], Rraw[r * 3 + 2]);
  }
  norm /= 3;
  if (!Number.isFinite(norm) || norm < 1e-12) return null;

  let s = 1 / norm;
  // Points must end up in front of the camera; if the mean depth is negative
  // the whole solution is the mirrored one.
  let meanDepth = 0;
  for (const c of corr) {
    const X = (c.X[0] - cx) * scale;
    const Y = (c.X[1] - cy) * scale;
    const Z = (c.X[2] - cz) * scale;
    meanDepth += (Rraw[6] * X + Rraw[7] * Y + Rraw[8] * Z + traw[2]) * s;
  }
  if (meanDepth < 0) s = -s;

  const R = orthonormalize(new Float64Array(Rraw.map((v) => v * s)));
  const tScaled: [number, number, number] = [traw[0] * s, traw[1] * s, traw[2] * s];

  // Undo the conditioning: the solve was in centred/scaled world coordinates.
  const centre = mat3MulVec(R, [cx, cy, cz]);
  const t: [number, number, number] = [
    tScaled[0] / scale - centre[0],
    tScaled[1] / scale - centre[1],
    tScaled[2] / scale - centre[2],
  ];

  if (![...R, ...t].every(Number.isFinite)) return null;
  return { R, t };
}

function reprojError(pose: Pose, c: PnpCorrespondence): number {
  const p = mat3MulVec(pose.R, c.X);
  const z = p[2] + pose.t[2];
  if (z <= 1e-9) return Infinity;
  return Math.hypot((p[0] + pose.t[0]) / z - c.x, (p[1] + pose.t[1]) / z - c.y);
}

/**
 * Gauss-Newton refinement of a single pose with the points held fixed.
 *
 * Uses a left perturbation (R ← exp(δ)·R) so the Jacobian is the usual
 * −skew(R·X), matching the convention in bundle.ts.
 */
export function refinePose(
  pose: Pose, corr: PnpCorrespondence[], iterations = 12, huber = 0.006,
): Pose {
  let current: Pose = { R: Float64Array.from(pose.R), t: [...pose.t] as [number, number, number] };

  for (let iter = 0; iter < iterations; iter++) {
    const H = new Float64Array(36);
    const g = new Float64Array(6);
    let used = 0;

    for (const c of corr) {
      const RX = mat3MulVec(current.R, c.X);
      const px = RX[0] + current.t[0];
      const py = RX[1] + current.t[1];
      const pz = RX[2] + current.t[2];
      if (pz <= 1e-9) continue;

      const invZ = 1 / pz;
      const du = px * invZ - c.x;
      const dv = py * invZ - c.y;
      const r = Math.hypot(du, dv);
      const w = r <= huber ? 1 : huber / r;

      const dudp = [invZ, 0, -px * invZ * invZ];
      const dvdp = [0, invZ, -py * invZ * invZ];
      // ∂p/∂δ = −skew(R·X)
      const sk = [
        0, -RX[2], RX[1],
        RX[2], 0, -RX[0],
        -RX[1], RX[0], 0,
      ];

      const Ju = new Float64Array(6);
      const Jv = new Float64Array(6);
      for (let k = 0; k < 3; k++) {
        Ju[k] = -(dudp[0] * sk[k] + dudp[1] * sk[3 + k] + dudp[2] * sk[6 + k]);
        Jv[k] = -(dvdp[0] * sk[k] + dvdp[1] * sk[3 + k] + dvdp[2] * sk[6 + k]);
        Ju[3 + k] = dudp[k];
        Jv[3 + k] = dvdp[k];
      }

      for (let a = 0; a < 6; a++) {
        for (let b = 0; b < 6; b++) H[a * 6 + b] += w * (Ju[a] * Ju[b] + Jv[a] * Jv[b]);
        g[a] -= w * (Ju[a] * du + Jv[a] * dv);
      }
      used++;
    }

    if (used < 4) break;
    // Mild damping keeps the step sane when the geometry is nearly degenerate.
    for (let i = 0; i < 6; i++) H[i * 6 + i] *= 1.0 + 1e-6;

    const delta = solveSymmetric(H, g, 6);
    if (!delta) break;

    const dR = rodrigues([delta[0], delta[1], delta[2]]);
    const R = new Float64Array(9);
    for (let r = 0; r < 3; r++) {
      for (let c2 = 0; c2 < 3; c2++) {
        let s = 0;
        for (let k = 0; k < 3; k++) s += dR[r * 3 + k] * current.R[k * 3 + c2];
        R[r * 3 + c2] = s;
      }
    }
    const next: Pose = {
      R: orthonormalize(R),
      t: [
        current.t[0] + delta[3],
        current.t[1] + delta[4],
        current.t[2] + delta[5],
      ] as [number, number, number],
    };

    const step = Math.hypot(delta[0], delta[1], delta[2], delta[3], delta[4], delta[5]);
    current = next;
    if (step < 1e-10) break;
  }
  return current;
}

export interface PnpResult {
  pose: Pose;
  inliers: boolean[];
  inlierCount: number;
  meanErrorPx: number;
}

/**
 * RANSAC PnP.
 *
 * `thresholdPx / focal` gives the inlier band in normalised units, so callers
 * can think in pixels regardless of image size.
 */
export function pnpRansac(
  corr: PnpCorrespondence[],
  threshold: number,
  options: {
    confidence?: number;
    maxIterations?: number;
    seed?: number;
    minInliers?: number;
    /** Starting guess, e.g. a neighbouring video frame's pose. Tried first. */
    initial?: Pose;
    focal?: number;
  } = {},
): PnpResult | null {
  const n = corr.length;
  const minInliers = options.minInliers ?? 12;
  if (n < 6) return null;

  const confidence = options.confidence ?? 0.999;
  let maxIterations = options.maxIterations ?? 800;
  let seed = options.seed ?? 0x9e3779b9;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };

  const countInliers = (pose: Pose) => {
    const flags = new Array<boolean>(n);
    let count = 0;
    for (let i = 0; i < n; i++) {
      const ok = reprojError(pose, corr[i]) < threshold;
      flags[i] = ok;
      if (ok) count++;
    }
    return { flags, count };
  };

  let bestPose: Pose | null = null;
  let bestFlags: boolean[] = [];
  let bestCount = 0;

  // A neighbouring frame in the same clip is usually within centimetres, so
  // trying the caller's guess first often makes RANSAC unnecessary.
  if (options.initial) {
    const refined = refinePose(options.initial, corr, 8, threshold);
    const { flags, count } = countInliers(refined);
    if (count >= minInliers) {
      bestPose = refined;
      bestFlags = flags;
      bestCount = count;
    }
  }

  const sample = new Set<number>();
  for (let iter = 0; iter < maxIterations; iter++) {
    // Once a strong hypothesis exists, stop early.
    if (bestCount > 0) {
      const ratio = bestCount / n;
      if (ratio > 0.1) {
        const denom = Math.log(1 - Math.pow(ratio, 6));
        if (denom < 0) {
          maxIterations = Math.min(
            maxIterations, Math.ceil(Math.log(1 - confidence) / denom) + 10,
          );
        }
      }
    }
    if (iter >= maxIterations) break;

    sample.clear();
    while (sample.size < 6) sample.add(Math.floor(rand() * n));
    const subset = Array.from(sample).map((i) => corr[i]);

    const candidate = pnpDlt(subset);
    if (!candidate) continue;
    const { flags, count } = countInliers(candidate);
    if (count > bestCount) {
      bestPose = candidate;
      bestFlags = flags;
      bestCount = count;
    }
  }

  if (!bestPose || bestCount < minInliers) return null;

  // Refit on all inliers, then re-classify — a hypothesis from six points is
  // never the best estimate available.
  for (let round = 0; round < 2; round++) {
    const inlierCorr = corr.filter((_, i) => bestFlags[i]);
    if (inlierCorr.length < 6) break;
    const refined = refinePose(bestPose, inlierCorr, 12, threshold);
    const { flags, count } = countInliers(refined);
    if (count >= bestCount) {
      bestPose = refined;
      bestFlags = flags;
      bestCount = count;
    } else {
      break;
    }
  }

  let errSum = 0;
  for (let i = 0; i < n; i++) if (bestFlags[i]) errSum += reprojError(bestPose, corr[i]);
  const focal = options.focal ?? 1;

  return {
    pose: bestPose,
    inliers: bestFlags,
    inlierCount: bestCount,
    meanErrorPx: bestCount ? (errSum / bestCount) * focal : Infinity,
  };
}
