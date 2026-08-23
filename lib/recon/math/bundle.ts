// Bundle adjustment — the step that turns "a chain of pairwise estimates" into
// one globally consistent reconstruction.
//
// Without it, incremental SfM drifts: each frame is registered against the
// structure built so far, small errors compound, and by the time the walker
// returns down the hallway the far end of the corridor no longer lines up with
// where it started. Since the whole point of this proof of concept is that five
// separate clips land in ONE space, drift is not cosmetic — it is the failure
// mode.
//
// This is Levenberg-Marquardt on the reprojection error, solved with the Schur
// complement so cost scales with the number of cameras rather than the number
// of points:
//
//     [ U   W ] [ δc ]   [ rc ]          S = U − W·V⁻¹·Wᵀ
//     [ Wᵀ  V ] [ δp ] = [ rp ]    →     S·δc = rc − W·V⁻¹·rp
//
// V is block-diagonal with 3x3 blocks (one per point), so V⁻¹ is free. S is
// dense and small: 6 parameters per camera, a few hundred cameras.

import {
  invertSymmetric3, mat3MulVec, orthonormalize, rodrigues, rodriguesInverse, solveSymmetric,
} from "./linalg";
import type { Pose } from "./twoView";

export interface BundleObservation {
  cameraIndex: number;
  pointIndex: number;
  /** Pixel coordinates relative to the principal point. */
  u: number;
  v: number;
}

export interface BundleProblem {
  poses: Pose[];
  points: Array<[number, number, number]>;
  observations: BundleObservation[];
  /** Shared focal length in pixels (one camera model for the whole capture). */
  focal: number;
  /** Camera indices held fixed — at minimum one, to pin the gauge freedom. */
  fixedCameras: Set<number>;
  /** Refine the shared focal length alongside geometry. */
  refineFocal?: boolean;
}

export interface BundleOptions {
  iterations?: number;
  /** Huber threshold in pixels; residuals beyond it get linear influence. */
  huberPx?: number;
  /** Stop when the relative cost improvement drops below this. */
  functionTolerance?: number;
  initialLambda?: number;
  onProgress?: (iteration: number, cost: number) => void;
}

export interface BundleResult {
  poses: Pose[];
  points: Array<[number, number, number]>;
  focal: number;
  initialCost: number;
  finalCost: number;
  initialRmsePx: number;
  finalRmsePx: number;
  iterations: number;
  converged: boolean;
}

/** Huber weight applied to a residual of magnitude r. */
function huberWeight(r: number, delta: number): number {
  return r <= delta ? 1 : delta / r;
}

function skew(v: readonly number[]): Float64Array {
  return new Float64Array([
    0, -v[2], v[1],
    v[2], 0, -v[0],
    -v[1], v[0], 0,
  ]);
}

/** Total robustified cost, and the RMSE in pixels for reporting. */
function evaluateCost(
  poses: Pose[], points: Array<[number, number, number]>, focal: number,
  observations: BundleObservation[], huber: number,
): { cost: number; rmse: number; valid: number } {
  let cost = 0;
  let sq = 0;
  let valid = 0;
  for (const obs of observations) {
    const pose = poses[obs.cameraIndex];
    const X = points[obs.pointIndex];
    if (!X) continue;
    const c = mat3MulVec(pose.R, X);
    const z = c[2] + pose.t[2];
    if (z <= 1e-6) continue;
    const du = (focal * (c[0] + pose.t[0])) / z - obs.u;
    const dv = (focal * (c[1] + pose.t[1])) / z - obs.v;
    const r = Math.hypot(du, dv);
    const w = huberWeight(r, huber);
    cost += w * r * r;
    sq += r * r;
    valid++;
  }
  return { cost, rmse: valid ? Math.sqrt(sq / valid) : 0, valid };
}

/**
 * Run Levenberg-Marquardt bundle adjustment.
 *
 * The problem is modified in place only through the returned copies; the caller's
 * arrays are left untouched so a failed step can be discarded.
 */
export function bundleAdjust(problem: BundleProblem, options: BundleOptions = {}): BundleResult {
  const iterations = options.iterations ?? 20;
  const huber = options.huberPx ?? 3.0;
  const ftol = options.functionTolerance ?? 1e-6;

  // Work on copies.
  let poses: Pose[] = problem.poses.map((p) => ({ R: Float64Array.from(p.R), t: [...p.t] as [number, number, number] }));
  let points: Array<[number, number, number]> = problem.points.map((p) => (p ? ([...p] as [number, number, number]) : p));
  let focal = problem.focal;

  const nCameras = poses.length;
  const nPoints = points.length;
  const refineFocal = problem.refineFocal ?? false;

  // Only free cameras get parameter slots; fixed ones pin the gauge.
  const cameraSlot = new Int32Array(nCameras).fill(-1);
  let freeCameras = 0;
  for (let i = 0; i < nCameras; i++) {
    if (!problem.fixedCameras.has(i)) cameraSlot[i] = freeCameras++;
  }
  const focalSlot = refineFocal ? freeCameras * 6 : -1;
  const nCameraParams = freeCameras * 6 + (refineFocal ? 1 : 0);

  const initial = evaluateCost(poses, points, focal, problem.observations, huber);
  let cost = initial.cost;

  if (nCameraParams === 0 || initial.valid === 0) {
    return {
      poses, points, focal,
      initialCost: initial.cost, finalCost: initial.cost,
      initialRmsePx: initial.rmse, finalRmsePx: initial.rmse,
      iterations: 0, converged: true,
    };
  }

  let lambda = options.initialLambda ?? 1e-4;
  let converged = false;
  let iter = 0;

  // Scratch buffers reused every iteration.
  const S = new Float64Array(nCameraParams * nCameraParams);
  const bC = new Float64Array(nCameraParams);
  const V = new Float64Array(nPoints * 9);
  const bP = new Float64Array(nPoints * 3);
  // W is stored sparsely: for each observation, its 6x3 (plus optional focal row).
  const Wblocks: Array<{ cam: number; pt: number; data: Float64Array; focalRow: Float64Array | null }> = [];

  for (iter = 0; iter < iterations; iter++) {
    S.fill(0);
    bC.fill(0);
    V.fill(0);
    bP.fill(0);
    Wblocks.length = 0;

    const pointSeen = new Uint8Array(nPoints);

    // ── Accumulate the normal equations ─────────────────────────────────────
    for (const obs of problem.observations) {
      const ci = obs.cameraIndex;
      const pi = obs.pointIndex;
      const pose = poses[ci];
      const X = points[pi];
      if (!X) continue;

      const RX = mat3MulVec(pose.R, X);
      const px = RX[0] + pose.t[0];
      const py = RX[1] + pose.t[1];
      const pz = RX[2] + pose.t[2];
      if (pz <= 1e-6) continue;

      const invZ = 1 / pz;
      const du = focal * px * invZ - obs.u;
      const dv = focal * py * invZ - obs.v;
      const r = Math.hypot(du, dv);
      const w = huberWeight(r, huber);

      // ∂(u,v)/∂p where p is the point in camera coordinates.
      const fz = focal * invZ;
      const dudp = [fz, 0, -focal * px * invZ * invZ];
      const dvdp = [0, fz, -focal * py * invZ * invZ];

      pointSeen[pi] = 1;

      // Point Jacobian: ∂p/∂X = R
      const Ju = new Float64Array(3);
      const Jv = new Float64Array(3);
      for (let k = 0; k < 3; k++) {
        Ju[k] = dudp[0] * pose.R[k] + dudp[1] * pose.R[3 + k] + dudp[2] * pose.R[6 + k];
        Jv[k] = dvdp[0] * pose.R[k] + dvdp[1] * pose.R[3 + k] + dvdp[2] * pose.R[6 + k];
      }

      // V += Jpᵀ W Jp ; bP -= Jpᵀ W r
      const vb = pi * 9;
      for (let a = 0; a < 3; a++) {
        for (let b = 0; b < 3; b++) V[vb + a * 3 + b] += w * (Ju[a] * Ju[b] + Jv[a] * Jv[b]);
        bP[pi * 3 + a] -= w * (Ju[a] * du + Jv[a] * dv);
      }

      const slot = cameraSlot[ci];
      const hasCam = slot >= 0;

      let Cu: Float64Array | null = null;
      let Cv: Float64Array | null = null;
      if (hasCam) {
        // Pose Jacobian with a LEFT perturbation: R ← exp(δ^)·R, t ← t + dt.
        // ∂p/∂δ = −skew(R·X), ∂p/∂t = I.
        const sk = skew(RX);
        Cu = new Float64Array(6);
        Cv = new Float64Array(6);
        for (let k = 0; k < 3; k++) {
          // Rotation part (note the sign from −skew).
          Cu[k] = -(dudp[0] * sk[k] + dudp[1] * sk[3 + k] + dudp[2] * sk[6 + k]);
          Cv[k] = -(dvdp[0] * sk[k] + dvdp[1] * sk[3 + k] + dvdp[2] * sk[6 + k]);
          // Translation part.
          Cu[3 + k] = dudp[k];
          Cv[3 + k] = dvdp[k];
        }

        const base = slot * 6;
        for (let a = 0; a < 6; a++) {
          for (let b = 0; b < 6; b++) {
            S[(base + a) * nCameraParams + base + b] += w * (Cu[a] * Cu[b] + Cv[a] * Cv[b]);
          }
          bC[base + a] -= w * (Cu[a] * du + Cv[a] * dv);
        }
      }

      // Shared focal parameter: ∂u/∂f = px/pz, ∂v/∂f = py/pz.
      let Fu = 0, Fv = 0;
      if (refineFocal) {
        Fu = px * invZ;
        Fv = py * invZ;
        S[focalSlot * nCameraParams + focalSlot] += w * (Fu * Fu + Fv * Fv);
        bC[focalSlot] -= w * (Fu * du + Fv * dv);
        if (hasCam && Cu && Cv) {
          const base = slot * 6;
          for (let a = 0; a < 6; a++) {
            const val = w * (Cu[a] * Fu + Cv[a] * Fv);
            S[(base + a) * nCameraParams + focalSlot] += val;
            S[focalSlot * nCameraParams + base + a] += val;
          }
        }
      }

      // W block (camera/focal × point coupling), stored for the Schur pass.
      if (hasCam && Cu && Cv) {
        const data = new Float64Array(18);
        for (let a = 0; a < 6; a++) {
          for (let b = 0; b < 3; b++) data[a * 3 + b] = w * (Cu[a] * Ju[b] + Cv[a] * Jv[b]);
        }
        Wblocks.push({ cam: slot, pt: pi, data, focalRow: null });
      }
      if (refineFocal) {
        const focalRow = new Float64Array(3);
        for (let b = 0; b < 3; b++) focalRow[b] = w * (Fu * Ju[b] + Fv * Jv[b]);
        Wblocks.push({ cam: -1, pt: pi, data: focalRow, focalRow });
      }
    }

    // ── Schur complement ────────────────────────────────────────────────────
    // Damp both blocks (LM), then eliminate the points.
    const Vinv = new Float64Array(nPoints * 9);
    for (let p = 0; p < nPoints; p++) {
      if (!pointSeen[p]) continue;
      const block = V.subarray(p * 9, p * 9 + 9);
      const damp = lambda * Math.max(1e-12, (block[0] + block[4] + block[8]) / 3);
      const inv = invertSymmetric3(block as Float64Array, damp);
      if (inv) Vinv.set(inv, p * 9);
      else pointSeen[p] = 0;
    }

    for (let i = 0; i < nCameraParams; i++) {
      const d = S[i * nCameraParams + i];
      S[i * nCameraParams + i] = d + lambda * Math.max(1e-12, d);
    }

    // Group W blocks by point so each point is eliminated once.
    const byPoint = new Map<number, typeof Wblocks>();
    for (const blk of Wblocks) {
      if (!pointSeen[blk.pt]) continue;
      const list = byPoint.get(blk.pt);
      if (list) list.push(blk);
      else byPoint.set(blk.pt, [blk]);
    }

    for (const [pi, blocks] of byPoint) {
      const vi = Vinv.subarray(pi * 9, pi * 9 + 9);
      const rp = bP.subarray(pi * 3, pi * 3 + 3);
      // y = V⁻¹ · rp
      const y = [
        vi[0] * rp[0] + vi[1] * rp[1] + vi[2] * rp[2],
        vi[3] * rp[0] + vi[4] * rp[1] + vi[5] * rp[2],
        vi[6] * rp[0] + vi[7] * rp[1] + vi[8] * rp[2],
      ];

      // Each block contributes rows to the reduced system.
      const rows: Array<{ offset: number; size: number; data: Float64Array }> = [];
      for (const blk of blocks) {
        if (blk.cam >= 0) rows.push({ offset: blk.cam * 6, size: 6, data: blk.data });
        else rows.push({ offset: focalSlot, size: 1, data: blk.data });
      }

      for (const rowBlk of rows) {
        // bC -= W · V⁻¹ · rp
        for (let a = 0; a < rowBlk.size; a++) {
          const wa = rowBlk.data.subarray(a * 3, a * 3 + 3);
          bC[rowBlk.offset + a] -= wa[0] * y[0] + wa[1] * y[1] + wa[2] * y[2];
        }
        for (const colBlk of rows) {
          for (let a = 0; a < rowBlk.size; a++) {
            const wa = rowBlk.data.subarray(a * 3, a * 3 + 3);
            // z = V⁻¹ · waᵀ
            const z0 = vi[0] * wa[0] + vi[1] * wa[1] + vi[2] * wa[2];
            const z1 = vi[3] * wa[0] + vi[4] * wa[1] + vi[5] * wa[2];
            const z2 = vi[6] * wa[0] + vi[7] * wa[1] + vi[8] * wa[2];
            for (let b = 0; b < colBlk.size; b++) {
              const wb = colBlk.data.subarray(b * 3, b * 3 + 3);
              S[(rowBlk.offset + a) * nCameraParams + colBlk.offset + b] -=
                wb[0] * z0 + wb[1] * z1 + wb[2] * z2;
            }
          }
        }
      }
    }

    // ── Solve and apply ─────────────────────────────────────────────────────
    const deltaC = solveSymmetric(S, bC, nCameraParams);
    if (!deltaC) {
      lambda *= 10;
      if (lambda > 1e12) break;
      continue;
    }

    const newPoses: Pose[] = poses.map((p, i) => {
      const slot = cameraSlot[i];
      if (slot < 0) return { R: Float64Array.from(p.R), t: [...p.t] as [number, number, number] };
      const base = slot * 6;
      const dR = rodrigues([deltaC[base], deltaC[base + 1], deltaC[base + 2]]);
      const R = orthonormalize(new Float64Array([
        dR[0] * p.R[0] + dR[1] * p.R[3] + dR[2] * p.R[6],
        dR[0] * p.R[1] + dR[1] * p.R[4] + dR[2] * p.R[7],
        dR[0] * p.R[2] + dR[1] * p.R[5] + dR[2] * p.R[8],
        dR[3] * p.R[0] + dR[4] * p.R[3] + dR[5] * p.R[6],
        dR[3] * p.R[1] + dR[4] * p.R[4] + dR[5] * p.R[7],
        dR[3] * p.R[2] + dR[4] * p.R[5] + dR[5] * p.R[8],
        dR[6] * p.R[0] + dR[7] * p.R[3] + dR[8] * p.R[6],
        dR[6] * p.R[1] + dR[7] * p.R[4] + dR[8] * p.R[7],
        dR[6] * p.R[2] + dR[7] * p.R[5] + dR[8] * p.R[8],
      ]));
      return {
        R,
        t: [
          p.t[0] + deltaC[base + 3],
          p.t[1] + deltaC[base + 4],
          p.t[2] + deltaC[base + 5],
        ] as [number, number, number],
      };
    });

    const newFocal = refineFocal ? Math.max(1, focal + deltaC[focalSlot]) : focal;

    // Back-substitute for the points: δp = V⁻¹ (rp − Wᵀ δc)
    const newPoints = points.slice();
    for (const [pi, blocks] of byPoint) {
      const vi = Vinv.subarray(pi * 9, pi * 9 + 9);
      const rhs = [bP[pi * 3], bP[pi * 3 + 1], bP[pi * 3 + 2]];
      for (const blk of blocks) {
        const offset = blk.cam >= 0 ? blk.cam * 6 : focalSlot;
        const size = blk.cam >= 0 ? 6 : 1;
        for (let a = 0; a < size; a++) {
          const d = deltaC[offset + a];
          if (d === 0) continue;
          const wa = blk.data.subarray(a * 3, a * 3 + 3);
          rhs[0] -= wa[0] * d;
          rhs[1] -= wa[1] * d;
          rhs[2] -= wa[2] * d;
        }
      }
      const X = points[pi];
      if (!X) continue;
      newPoints[pi] = [
        X[0] + (vi[0] * rhs[0] + vi[1] * rhs[1] + vi[2] * rhs[2]),
        X[1] + (vi[3] * rhs[0] + vi[4] * rhs[1] + vi[5] * rhs[2]),
        X[2] + (vi[6] * rhs[0] + vi[7] * rhs[1] + vi[8] * rhs[2]),
      ];
    }

    const next = evaluateCost(newPoses, newPoints, newFocal, problem.observations, huber);

    if (next.cost < cost) {
      const improvement = (cost - next.cost) / Math.max(cost, 1e-12);
      poses = newPoses;
      points = newPoints;
      focal = newFocal;
      cost = next.cost;
      lambda = Math.max(lambda * 0.35, 1e-12);
      options.onProgress?.(iter, cost);
      if (improvement < ftol) { converged = true; iter++; break; }
    } else {
      // Rejected step — trust the linearisation less and retry.
      lambda *= 8;
      if (lambda > 1e12) break;
    }
  }

  const final = evaluateCost(poses, points, focal, problem.observations, huber);
  return {
    poses, points, focal,
    initialCost: initial.cost,
    finalCost: final.cost,
    initialRmsePx: initial.rmse,
    finalRmsePx: final.rmse,
    iterations: iter,
    converged,
  };
}

/** Convenience: RMSE in pixels for a solved problem. */
export function reprojectionRmsePx(
  poses: Pose[], points: Array<[number, number, number]>, focal: number,
  observations: BundleObservation[],
): number {
  return evaluateCost(poses, points, focal, observations, Infinity).rmse;
}

export { rodriguesInverse };
