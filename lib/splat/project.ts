// Projecting a 3D gaussian into a 2D screen-space gaussian.
//
// Original implementation of the standard EWA-splatting derivation (Zwicker
// et al. 2002, as used by 3D Gaussian Splatting): the world covariance
// Σ = R S Sᵀ Rᵀ is pushed through the camera rotation W and the perspective
// Jacobian J, giving the screen covariance Σ' = J W Σ Wᵀ Jᵀ, whose inverse is
// the conic used for per-pixel evaluation.
//
// This TypeScript version is the REFERENCE the WGSL kernels are tested
// against: slow, clear, and exercised by unit tests with known geometry.

import type { Pose } from "../recon/math/twoView";

export interface ProjectedSplat {
  /** Screen-space centre in pixels. */
  x: number;
  y: number;
  /** Camera-space depth (used for sorting; positive in front). */
  depth: number;
  /** Upper triangle of the 2x2 screen covariance (a, b; b, c), pixels². */
  covA: number;
  covB: number;
  covC: number;
  /** Conic = inverse covariance, for exp(-0.5 dᵀ conic d) evaluation. */
  conicA: number;
  conicB: number;
  conicC: number;
  /** Conservative pixel radius containing ~3 sigma. */
  radius: number;
}

/** Rotation matrix (row-major, camera-from-world is NOT applied here) from a
 *  possibly-unnormalised quaternion (w, x, y, z). */
export function quatToMat(
  w: number, x: number, y: number, z: number,
): [number, number, number, number, number, number, number, number, number] {
  const n = Math.hypot(w, x, y, z) || 1;
  w /= n; x /= n; y /= n; z /= n;
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
    2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
    2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y),
  ];
}

/** World covariance Σ = R S Sᵀ Rᵀ as its upper triangle (6 values). */
export function worldCovariance(
  quat: [number, number, number, number],
  scale: [number, number, number],
): [number, number, number, number, number, number] {
  const R = quatToMat(quat[0], quat[1], quat[2], quat[3]);
  // M = R · diag(s); Σ = M Mᵀ.
  const m = [
    R[0] * scale[0], R[1] * scale[1], R[2] * scale[2],
    R[3] * scale[0], R[4] * scale[1], R[5] * scale[2],
    R[6] * scale[0], R[7] * scale[1], R[8] * scale[2],
  ];
  return [
    m[0] * m[0] + m[1] * m[1] + m[2] * m[2],
    m[0] * m[3] + m[1] * m[4] + m[2] * m[5],
    m[0] * m[6] + m[1] * m[7] + m[2] * m[8],
    m[3] * m[3] + m[4] * m[4] + m[5] * m[5],
    m[3] * m[6] + m[4] * m[7] + m[5] * m[8],
    m[6] * m[6] + m[7] * m[7] + m[8] * m[8],
  ];
}

/**
 * Project one gaussian. Returns null when the centre is behind the near
 * plane — the caller culls it.
 *
 * `pose` is world→camera (x_cam = R·X + t), the same convention as the rest
 * of this codebase. `focal` in pixels, `cx, cy` the principal point.
 */
export function projectSplat(
  position: [number, number, number],
  quat: [number, number, number, number],
  scale: [number, number, number],
  pose: Pose,
  focal: number,
  cx: number,
  cy: number,
  near = 0.05,
): ProjectedSplat | null {
  const R = pose.R;
  const px = R[0] * position[0] + R[1] * position[1] + R[2] * position[2] + pose.t[0];
  const py = R[3] * position[0] + R[4] * position[1] + R[5] * position[2] + pose.t[1];
  const pz = R[6] * position[0] + R[7] * position[1] + R[8] * position[2] + pose.t[2];
  if (pz <= near) return null;

  const invZ = 1 / pz;
  const x = focal * px * invZ + cx;
  const y = focal * py * invZ + cy;

  // Perspective Jacobian at the centre (2x3), in pixels per world unit:
  //   J = [ f/z   0    -f·px/z² ]
  //       [ 0    f/z   -f·py/z² ]
  const j00 = focal * invZ;
  const j02 = -focal * px * invZ * invZ;
  const j11 = focal * invZ;
  const j12 = -focal * py * invZ * invZ;

  // T = J · W (2x3), W the camera rotation.
  const t00 = j00 * R[0] + j02 * R[6];
  const t01 = j00 * R[1] + j02 * R[7];
  const t02 = j00 * R[2] + j02 * R[8];
  const t10 = j11 * R[3] + j12 * R[6];
  const t11 = j11 * R[4] + j12 * R[7];
  const t12 = j11 * R[5] + j12 * R[8];

  const [s00, s01, s02, s11, s12, s22] = worldCovariance(quat, scale);

  // Σ' = T Σ Tᵀ (2x2). First U = T·Σ (2x3).
  const u00 = t00 * s00 + t01 * s01 + t02 * s02;
  const u01 = t00 * s01 + t01 * s11 + t02 * s12;
  const u02 = t00 * s02 + t01 * s12 + t02 * s22;
  const u10 = t10 * s00 + t11 * s01 + t12 * s02;
  const u11 = t10 * s01 + t11 * s11 + t12 * s12;
  const u12 = t10 * s02 + t11 * s12 + t12 * s22;

  // A small isotropic floor (0.3px, as in the published method) keeps
  // sub-pixel gaussians visible and the conic invertible.
  let covA = u00 * t00 + u01 * t01 + u02 * t02 + 0.3;
  const covB = u00 * t10 + u01 * t11 + u02 * t12;
  let covC = u10 * t10 + u11 * t11 + u12 * t12 + 0.3;

  const det = covA * covC - covB * covB;
  if (det <= 0 || !Number.isFinite(det)) return null;
  const invDet = 1 / det;

  const mid = (covA + covC) / 2;
  const eig = mid + Math.sqrt(Math.max(0.01, mid * mid - det));
  const radius = Math.ceil(3 * Math.sqrt(eig));

  return {
    x, y,
    depth: pz,
    covA, covB, covC,
    conicA: covC * invDet,
    conicB: -covB * invDet,
    conicC: covA * invDet,
    radius,
  };
}

/** exp(-0.5 dᵀ Σ'⁻¹ d) at pixel (px, py) for a projected splat. */
export function gaussianWeight(s: ProjectedSplat, px: number, py: number): number {
  const dx = px - s.x;
  const dy = py - s.y;
  const power = -0.5 * (s.conicA * dx * dx + s.conicC * dy * dy) - s.conicB * dx * dy;
  return power > 0 ? 0 : Math.exp(power);
}
