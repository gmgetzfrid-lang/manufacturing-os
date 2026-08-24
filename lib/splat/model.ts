// The Gaussian-splat scene model this project trains and renders.
//
// Original work. The representation follows the published 3D Gaussian
// Splatting formulation (Kerbl et al. 2023) — anisotropic 3D gaussians with
// per-splat opacity and view-dependent colour — implemented from the maths,
// not from any reference codebase.
//
// Storage layout is struct-of-arrays in flat typed arrays so the same buffers
// upload to the GPU unchanged:
//   positions  3 floats   world xyz
//   logScales  3 floats   log of the per-axis extent (log keeps them positive
//                         under gradient steps)
//   quats      4 floats   rotation (w, x, y, z), normalised on use
//   logitOpacities 1 float  sigmoid(x) is the actual opacity
//   colors     3 floats   base RGB in [0,1] (degree-0 spherical harmonics;
//                         higher-order view dependence can extend this later)

export interface SplatModel {
  count: number;
  positions: Float32Array;
  logScales: Float32Array;
  quats: Float32Array;
  logitOpacities: Float32Array;
  colors: Float32Array;
}

export function allocateModel(count: number): SplatModel {
  return {
    count,
    positions: new Float32Array(count * 3),
    logScales: new Float32Array(count * 3),
    quats: new Float32Array(count * 4),
    logitOpacities: new Float32Array(count),
    colors: new Float32Array(count * 3),
  };
}

export const sigmoid = (x: number): number => 1 / (1 + Math.exp(-x));
export const logit = (p: number): number => Math.log(p / (1 - p));

/**
 * Seed a model from a sparse reconstruction: one gaussian per point, sized to
 * the local point spacing, oriented isotropically, at a conservative opacity.
 * This is the standard initialisation — training refines everything.
 */
export function seedFromPoints(
  points: Array<{ xyz: [number, number, number]; rgb: [number, number, number] }>,
  opacity = 0.1,
): SplatModel {
  const model = allocateModel(points.length);
  // Local spacing: distance to the nearest of a small random sample. Exact
  // nearest-neighbour is O(n²); a sampled estimate is fine for a starting size.
  const sampleCount = Math.min(points.length, 32);
  for (let i = 0; i < points.length; i++) {
    const p = points[i].xyz;
    let nearest = Infinity;
    for (let s = 0; s < sampleCount; s++) {
      const j = (i + 1 + ((s * 2654435761) % Math.max(1, points.length - 1))) % points.length;
      if (j === i) continue;
      const q = points[j].xyz;
      const d = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
      if (d > 1e-12 && d < nearest) nearest = d;
    }
    const scale = Number.isFinite(nearest) ? Math.max(nearest, 1e-4) : 0.01;
    model.positions.set(p, i * 3);
    model.logScales.fill(Math.log(scale), i * 3, i * 3 + 3);
    model.quats.set([1, 0, 0, 0], i * 4);
    model.logitOpacities[i] = logit(opacity);
    model.colors.set(
      [points[i].rgb[0] / 255, points[i].rgb[1] / 255, points[i].rgb[2] / 255],
      i * 3,
    );
  }
  return model;
}
