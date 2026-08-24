// Analytic gradients through the full splat forward model, on the CPU.
//
// Original derivation-by-hand of the chain rule through:
//   compositing  C = Σ c_i α_i T_i           (reverse-scan trick for dC/dα_i)
//   evaluation   α = o · exp(−½ dᵀ Q d)      (Q the conic, d the pixel offset)
//   conic        Q = Σ'⁻¹                    (dΣ'⁻¹ = −Q dΣ' Q)
//   projection   Σ' = T Σ Tᵀ,  T = J·W      (J depends on the camera point)
//   shape        Σ = M Mᵀ,  M = R(q)·diag(s)
//   camera       p = W·X + t,  x = f·p/z + c
//
// Ordering by depth is treated as fixed (non-differentiable), as in the
// published method. Everything here is validated against numerical
// differentiation in the test-suite; the WGSL kernels must then match THIS.
//
// Deliberately O(pixels × splats): it is the correctness reference for small
// scenes, not the trainer.

import type { Pose } from "../recon/math/twoView";
import type { SplatModel } from "./model";
import { sigmoid } from "./model";
import { quatToMat } from "./project";

export interface SplatGrads {
  positions: Float32Array;
  logScales: Float32Array;
  quats: Float32Array;
  logitOpacities: Float32Array;
  colors: Float32Array;
}

export interface ForwardBackwardResult {
  loss: number;
  color: Float32Array;
  grads: SplatGrads;
}

interface Prepared {
  i: number;
  // Camera-space point.
  px: number; py: number; pz: number;
  // Screen centre.
  sx: number; sy: number;
  // T = J·W rows.
  t00: number; t01: number; t02: number;
  t10: number; t11: number; t12: number;
  // World covariance upper triangle.
  s00: number; s01: number; s02: number; s11: number; s12: number; s22: number;
  // Screen covariance and conic.
  covA: number; covB: number; covC: number;
  qA: number; qB: number; qC: number;
  radius: number;
  opacity: number;
  // Gradient accumulators (screen-space).
  gX: number; gY: number;
  gQA: number; gQB: number; gQC: number;
  gOpacity: number;
  gR: number; gG: number; gB: number;
}

const COV_FLOOR = 0.3;

export interface ForwardBackwardOptions {
  /** Contributions below this alpha are skipped (rasteriser default 1/255). */
  alphaCutoff?: number;
  /** Bounding radius in standard deviations (rasteriser default 3). */
  radiusSigma?: number;
  /** Stop compositing when transmittance falls below this. */
  minT?: number;
}

export function forwardBackward(
  model: SplatModel,
  pose: Pose,
  focal: number,
  cx: number,
  cy: number,
  width: number,
  height: number,
  target: Float32Array,
  options: ForwardBackwardOptions = {},
): ForwardBackwardResult {
  // The hard cutoffs are performance features with a gradient cost: pixels at
  // a splat's rim flip in and out as it moves, which finite differences see
  // and the analytic gradient deliberately does not. The gradient-check tests
  // shrink the cutoffs until that rim mass is negligible; production keeps
  // the fast defaults, accepting rim noise far below the learning rate.
  const alphaCutoff = options.alphaCutoff ?? 1 / 255;
  const radiusSigma = options.radiusSigma ?? 3;
  const minT = options.minT ?? 1e-4;
  const W = pose.R;
  const prepared: Prepared[] = [];

  for (let i = 0; i < model.count; i++) {
    const X = [model.positions[i * 3], model.positions[i * 3 + 1], model.positions[i * 3 + 2]];
    const px = W[0] * X[0] + W[1] * X[1] + W[2] * X[2] + pose.t[0];
    const py = W[3] * X[0] + W[4] * X[1] + W[5] * X[2] + pose.t[1];
    const pz = W[6] * X[0] + W[7] * X[1] + W[8] * X[2] + pose.t[2];
    if (pz <= 0.05) continue;
    const invZ = 1 / pz;
    const sx = focal * px * invZ + cx;
    const sy = focal * py * invZ + cy;

    const j00 = focal * invZ;
    const j02 = -focal * px * invZ * invZ;
    const j11 = focal * invZ;
    const j12 = -focal * py * invZ * invZ;
    const t00 = j00 * W[0] + j02 * W[6];
    const t01 = j00 * W[1] + j02 * W[7];
    const t02 = j00 * W[2] + j02 * W[8];
    const t10 = j11 * W[3] + j12 * W[6];
    const t11 = j11 * W[4] + j12 * W[7];
    const t12 = j11 * W[5] + j12 * W[8];

    const s0 = Math.exp(model.logScales[i * 3]);
    const s1 = Math.exp(model.logScales[i * 3 + 1]);
    const s2 = Math.exp(model.logScales[i * 3 + 2]);
    const R = quatToMat(
      model.quats[i * 4], model.quats[i * 4 + 1], model.quats[i * 4 + 2], model.quats[i * 4 + 3],
    );
    const m = [
      R[0] * s0, R[1] * s1, R[2] * s2,
      R[3] * s0, R[4] * s1, R[5] * s2,
      R[6] * s0, R[7] * s1, R[8] * s2,
    ];
    const s00 = m[0] * m[0] + m[1] * m[1] + m[2] * m[2];
    const s01 = m[0] * m[3] + m[1] * m[4] + m[2] * m[5];
    const s02 = m[0] * m[6] + m[1] * m[7] + m[2] * m[8];
    const s11 = m[3] * m[3] + m[4] * m[4] + m[5] * m[5];
    const s12 = m[3] * m[6] + m[4] * m[7] + m[5] * m[8];
    const s22 = m[6] * m[6] + m[7] * m[7] + m[8] * m[8];

    const u00 = t00 * s00 + t01 * s01 + t02 * s02;
    const u01 = t00 * s01 + t01 * s11 + t02 * s12;
    const u02 = t00 * s02 + t01 * s12 + t02 * s22;
    const u10 = t10 * s00 + t11 * s01 + t12 * s02;
    const u11 = t10 * s01 + t11 * s11 + t12 * s12;
    const u12 = t10 * s02 + t11 * s12 + t12 * s22;
    const covA = u00 * t00 + u01 * t01 + u02 * t02 + COV_FLOOR;
    const covB = u00 * t10 + u01 * t11 + u02 * t12;
    const covC = u10 * t10 + u11 * t11 + u12 * t12 + COV_FLOOR;

    const det = covA * covC - covB * covB;
    if (det <= 0 || !Number.isFinite(det)) continue;
    const invDet = 1 / det;
    const qA = covC * invDet;
    const qB = -covB * invDet;
    const qC = covA * invDet;
    const mid = (covA + covC) / 2;
    const radius = Math.ceil(
      radiusSigma * Math.sqrt(mid + Math.sqrt(Math.max(0.01, mid * mid - det))),
    );
    if (sx + radius < 0 || sx - radius >= width || sy + radius < 0 || sy - radius >= height) continue;

    prepared.push({
      i, px, py, pz, sx, sy,
      t00, t01, t02, t10, t11, t12,
      s00, s01, s02, s11, s12, s22,
      covA, covB, covC, qA, qB, qC, radius,
      opacity: sigmoid(model.logitOpacities[i]),
      gX: 0, gY: 0, gQA: 0, gQB: 0, gQC: 0, gOpacity: 0, gR: 0, gG: 0, gB: 0,
    });
  }
  prepared.sort((a, b) => a.pz - b.pz);

  const color = new Float32Array(width * height * 3);
  let loss = 0;
  const invN = 1 / (width * height * 3);

  // Per-pixel forward + backward. The per-pixel contribution list is rebuilt
  // rather than stored globally — reference-implementation simplicity.
  interface Contribution { p: Prepared; alpha: number; T: number; G: number; dx: number; dy: number; clamped: boolean; }
  const contribs: Contribution[] = [];

  for (let pyx = 0; pyx < height; pyx++) {
    for (let pxx = 0; pxx < width; pxx++) {
      const fx = pxx + 0.5;
      const fy = pyx + 0.5;
      contribs.length = 0;
      let T = 1;
      let cr = 0, cg = 0, cb = 0;
      for (const p of prepared) {
        if (T < minT) break;
        const dx = fx - p.sx;
        const dy = fy - p.sy;
        if (Math.abs(dx) > p.radius || Math.abs(dy) > p.radius) continue;
        const power = -0.5 * (p.qA * dx * dx + p.qC * dy * dy) - p.qB * dx * dy;
        if (power > 0) continue;
        const G = Math.exp(power);
        const raw = p.opacity * G;
        const clamped = raw > 0.99;
        const alpha = clamped ? 0.99 : raw;
        if (alpha < alphaCutoff) continue;
        const w = alpha * T;
        const mi = p.i * 3;
        cr += model.colors[mi] * w;
        cg += model.colors[mi + 1] * w;
        cb += model.colors[mi + 2] * w;
        contribs.push({ p, alpha, T, G, dx, dy, clamped });
        T *= 1 - alpha;
      }

      const o = (pyx * width + pxx) * 3;
      color[o] = cr; color[o + 1] = cg; color[o + 2] = cb;
      const dr = cr - target[o];
      const dg = cg - target[o + 1];
      const db = cb - target[o + 2];
      loss += (Math.abs(dr) + Math.abs(dg) + Math.abs(db)) * invN;
      const gr = Math.sign(dr) * invN;
      const gg = Math.sign(dg) * invN;
      const gb = Math.sign(db) * invN;

      // Reverse scan: S accumulates the composited colour BEHIND the current
      // splat, giving dC/dα_i = c_i·T_i − S_i/(1−α_i).
      let sr = 0, sg = 0, sb = 0;
      for (let k = contribs.length - 1; k >= 0; k--) {
        const c = contribs[k];
        const mi = c.p.i * 3;
        const w = c.alpha * c.T;
        c.p.gR += gr * w;
        c.p.gG += gg * w;
        c.p.gB += gb * w;
        const dCdA_r = model.colors[mi] * c.T - sr / (1 - c.alpha);
        const dCdA_g = model.colors[mi + 1] * c.T - sg / (1 - c.alpha);
        const dCdA_b = model.colors[mi + 2] * c.T - sb / (1 - c.alpha);
        sr += model.colors[mi] * w;
        sg += model.colors[mi + 1] * w;
        sb += model.colors[mi + 2] * w;
        if (c.clamped) continue;
        const gAlpha = gr * dCdA_r + gg * dCdA_g + gb * dCdA_b;
        // α = o·G.
        c.p.gOpacity += gAlpha * c.G;
        const gG = gAlpha * c.p.opacity;
        // G = exp(power).
        const gPower = gG * c.G;
        c.p.gQA += gPower * (-0.5 * c.dx * c.dx);
        c.p.gQB += gPower * (-c.dx * c.dy);
        c.p.gQC += gPower * (-0.5 * c.dy * c.dy);
        // d(power)/d(dx) with dx = fx − sx  →  d/d(sx) flips sign.
        const gdx = gPower * (-c.p.qA * c.dx - c.p.qB * c.dy);
        const gdy = gPower * (-c.p.qC * c.dy - c.p.qB * c.dx);
        c.p.gX -= gdx;
        c.p.gY -= gdy;
      }
    }
  }

  // Per-splat backward from screen-space accumulators to model parameters.
  const grads: SplatGrads = {
    positions: new Float32Array(model.count * 3),
    logScales: new Float32Array(model.count * 3),
    quats: new Float32Array(model.count * 4),
    logitOpacities: new Float32Array(model.count),
    colors: new Float32Array(model.count * 3),
  };

  for (const p of prepared) {
    const i = p.i;
    grads.colors[i * 3] += p.gR;
    grads.colors[i * 3 + 1] += p.gG;
    grads.colors[i * 3 + 2] += p.gB;
    // o = sigmoid(l).
    grads.logitOpacities[i] += p.gOpacity * p.opacity * (1 - p.opacity);

    // Conic → covariance: dΣ⁻¹/dΣ = −Q dΣ Q, so
    // gCov = −Q · gQ · Q with gQ symmetric (B counted once in accumulators).
    const { qA, qB, qC, gQA, gQB, gQC } = p;
    const g00 = gQA, g01 = gQB / 2, g11 = gQC;
    // n = Q · gQsym · Q  (2x2 symmetric).
    const a00 = qA * g00 + qB * g01;
    const a01 = qA * g01 + qB * g11;
    const a10 = qB * g00 + qC * g01;
    const a11 = qB * g01 + qC * g11;
    const nA = -(a00 * qA + a01 * qB);
    const nB = -(a00 * qB + a01 * qC) - (a10 * qA + a11 * qB);
    const nC = -(a10 * qB + a11 * qC);
    // gCov upper triangle with B's two symmetric slots folded into nB.
    const gCovA = nA;
    const gCovB = nB / 2 * 2; // symmetric pair — kept explicit for clarity
    const gCovC = nC;

    // cov = T Σ Tᵀ: gΣ = Tᵀ gCov T ; gT = (gCov + gCovᵀ) T Σ.
    const { t00, t01, t02, t10, t11, t12 } = p;
    const gS00 = gCovA * t00 * t00 + gCovB * t00 * t10 + gCovC * t10 * t10;
    const gS01 = 2 * gCovA * t00 * t01 + gCovB * (t00 * t11 + t01 * t10) + 2 * gCovC * t10 * t11;
    const gS02 = 2 * gCovA * t00 * t02 + gCovB * (t00 * t12 + t02 * t10) + 2 * gCovC * t10 * t12;
    const gS11 = gCovA * t01 * t01 + gCovB * t01 * t11 + gCovC * t11 * t11;
    const gS12 = 2 * gCovA * t01 * t02 + gCovB * (t01 * t12 + t02 * t11) + 2 * gCovC * t11 * t12;
    const gS22 = gCovA * t02 * t02 + gCovB * t02 * t12 + gCovC * t12 * t12;

    // gT rows: gT = 2·gCovSym·T·Σ with gCovSym = [[gCovA, gCovB/2],[gCovB/2, gCovC]].
    const { s00, s01, s02, s11, s12, s22 } = p;
    const ts00 = t00 * s00 + t01 * s01 + t02 * s02;
    const ts01 = t00 * s01 + t01 * s11 + t02 * s12;
    const ts02 = t00 * s02 + t01 * s12 + t02 * s22;
    const ts10 = t10 * s00 + t11 * s01 + t12 * s02;
    const ts11 = t10 * s01 + t11 * s11 + t12 * s12;
    const ts12 = t10 * s02 + t11 * s12 + t12 * s22;
    const gT00 = 2 * gCovA * ts00 + gCovB * ts10;
    const gT01 = 2 * gCovA * ts01 + gCovB * ts11;
    const gT02 = 2 * gCovA * ts02 + gCovB * ts12;
    const gT10 = 2 * gCovC * ts10 + gCovB * ts00;
    const gT11 = 2 * gCovC * ts11 + gCovB * ts01;
    const gT12 = 2 * gCovC * ts12 + gCovB * ts02;

    // Σ = M Mᵀ: gM = 2 gΣsym M, with gΣ accumulated on the upper triangle
    // where off-diagonals already carry both symmetric slots (factor folded
    // above), so gΣsym here halves them back.
    const R = quatToMat(
      model.quats[i * 4], model.quats[i * 4 + 1], model.quats[i * 4 + 2], model.quats[i * 4 + 3],
    );
    const s0 = Math.exp(model.logScales[i * 3]);
    const s1 = Math.exp(model.logScales[i * 3 + 1]);
    const s2 = Math.exp(model.logScales[i * 3 + 2]);
    const m = [
      R[0] * s0, R[1] * s1, R[2] * s2,
      R[3] * s0, R[4] * s1, R[5] * s2,
      R[6] * s0, R[7] * s1, R[8] * s2,
    ];
    const gs = [
      [gS00, gS01 / 2, gS02 / 2],
      [gS01 / 2, gS11, gS12 / 2],
      [gS02 / 2, gS12 / 2, gS22],
    ];
    const gm = new Array<number>(9);
    for (let r = 0; r < 3; r++) {
      for (let c2 = 0; c2 < 3; c2++) {
        gm[r * 3 + c2] = 2 * (
          gs[r][0] * m[0 + c2] + gs[r][1] * m[3 + c2] + gs[r][2] * m[6 + c2]
        );
      }
    }
    // M = R diag(s): gs_k = Σ_r gM[r,k]·R[r,k];  gR[r,k] = gM[r,k]·s_k.
    const gScale0 = gm[0] * R[0] + gm[3] * R[3] + gm[6] * R[6];
    const gScale1 = gm[1] * R[1] + gm[4] * R[4] + gm[7] * R[7];
    const gScale2 = gm[2] * R[2] + gm[5] * R[5] + gm[8] * R[8];
    grads.logScales[i * 3] += gScale0 * s0;
    grads.logScales[i * 3 + 1] += gScale1 * s1;
    grads.logScales[i * 3 + 2] += gScale2 * s2;

    const gRm = [
      gm[0] * s0, gm[1] * s1, gm[2] * s2,
      gm[3] * s0, gm[4] * s1, gm[5] * s2,
      gm[6] * s0, gm[7] * s1, gm[8] * s2,
    ];
    // R(q) for normalised q; backprop through normalisation numerically
    // exact: dR/dq computed at the raw quaternion via central differences of
    // the (cheap, exact) quatToMat — a closed form exists, but the numeric
    // Jacobian of a 4→9 polynomial map is exact to rounding here and keeps
    // this reference readable.
    const q = [
      model.quats[i * 4], model.quats[i * 4 + 1], model.quats[i * 4 + 2], model.quats[i * 4 + 3],
    ];
    const EPS = 1e-6;
    for (let k = 0; k < 4; k++) {
      const qp = [...q]; qp[k] += EPS;
      const qm = [...q]; qm[k] -= EPS;
      const Rp = quatToMat(qp[0], qp[1], qp[2], qp[3]);
      const Rm = quatToMat(qm[0], qm[1], qm[2], qm[3]);
      let g = 0;
      for (let e = 0; e < 9; e++) g += gRm[e] * (Rp[e] - Rm[e]) / (2 * EPS);
      grads.quats[i * 4 + k] += g;
    }

    // Screen centre and Jacobian back to the camera-space point.
    const { px, py, pz } = p;
    const invZ = 1 / pz;
    let gPx = p.gX * focal * invZ;
    let gPy = p.gY * focal * invZ;
    let gPz = -focal * invZ * invZ * (p.gX * px + p.gY * py);
    // T = J·W also depends on (px, py, pz) through J:
    //   t0k = f/z·W0k − f·px/z²·W2k ;  t1k = f/z·W1k − f·py/z²·W2k.
    const W2 = [W[6], W[7], W[8]];
    const gJ00 = gT00 * W[0] + gT01 * W[1] + gT02 * W[2];
    const gJ02 = gT00 * W2[0] + gT01 * W2[1] + gT02 * W2[2];
    const gJ11 = gT10 * W[3] + gT11 * W[4] + gT12 * W[5];
    const gJ12 = gT10 * W2[0] + gT11 * W2[1] + gT12 * W2[2];
    // j00 = f/z, j02 = −f·px/z², j11 = f/z, j12 = −f·py/z².
    gPx += gJ02 * (-focal * invZ * invZ);
    gPy += gJ12 * (-focal * invZ * invZ);
    gPz += gJ00 * (-focal * invZ * invZ)
      + gJ11 * (-focal * invZ * invZ)
      + gJ02 * (2 * focal * px * invZ * invZ * invZ)
      + gJ12 * (2 * focal * py * invZ * invZ * invZ);

    // p = W·X + t → gX = Wᵀ·gp.
    grads.positions[i * 3] += W[0] * gPx + W[3] * gPy + W[6] * gPz;
    grads.positions[i * 3 + 1] += W[1] * gPx + W[4] * gPy + W[7] * gPz;
    grads.positions[i * 3 + 2] += W[2] * gPx + W[5] * gPy + W[8] * gPz;
  }

  return { loss, color, grads };
}
