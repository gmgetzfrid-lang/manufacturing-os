// CPU reference renderer: front-to-back alpha compositing of projected
// gaussians, the exact computation the WGSL rasteriser performs in tiles.
// Original implementation of the published forward model:
//   C = Σ_i c_i · α_i · T_i,   T_i = Π_{j<i} (1 − α_j),
//   α_i = opacity_i · exp(−½ dᵀ Σ'⁻¹ d),  splats sorted by depth.
//
// Slow by design — it exists to be read, to unit-test the maths, and to
// verify the GPU output pixel-for-pixel on small scenes.

import type { Pose } from "../recon/math/twoView";
import type { SplatModel } from "./model";
import { sigmoid } from "./model";
import { gaussianWeight, projectSplat, type ProjectedSplat } from "./project";

export interface CpuRenderResult {
  /** RGB, row-major, [0,1] floats. */
  color: Float32Array;
  /** Per-pixel remaining transmittance (1 = background shows through). */
  transmittance: Float32Array;
}

export function renderCpu(
  model: SplatModel,
  pose: Pose,
  focal: number,
  cx: number,
  cy: number,
  width: number,
  height: number,
): CpuRenderResult {
  interface Visible { s: ProjectedSplat; i: number; alpha: number; }
  const visible: Visible[] = [];
  for (let i = 0; i < model.count; i++) {
    const s = projectSplat(
      [model.positions[i * 3], model.positions[i * 3 + 1], model.positions[i * 3 + 2]],
      [model.quats[i * 4], model.quats[i * 4 + 1], model.quats[i * 4 + 2], model.quats[i * 4 + 3]],
      [
        Math.exp(model.logScales[i * 3]),
        Math.exp(model.logScales[i * 3 + 1]),
        Math.exp(model.logScales[i * 3 + 2]),
      ],
      pose, focal, cx, cy,
    );
    if (!s) continue;
    if (s.x + s.radius < 0 || s.x - s.radius >= width) continue;
    if (s.y + s.radius < 0 || s.y - s.radius >= height) continue;
    visible.push({ s, i, alpha: sigmoid(model.logitOpacities[i]) });
  }
  visible.sort((a, b) => a.s.depth - b.s.depth);

  const color = new Float32Array(width * height * 3);
  const transmittance = new Float32Array(width * height).fill(1);

  for (const { s, i, alpha } of visible) {
    const x0 = Math.max(0, Math.floor(s.x - s.radius));
    const x1 = Math.min(width - 1, Math.ceil(s.x + s.radius));
    const y0 = Math.max(0, Math.floor(s.y - s.radius));
    const y1 = Math.min(height - 1, Math.ceil(s.y + s.radius));
    const r = model.colors[i * 3];
    const g = model.colors[i * 3 + 1];
    const b = model.colors[i * 3 + 2];
    for (let py = y0; py <= y1; py++) {
      for (let px = x0; px <= x1; px++) {
        const t = transmittance[py * width + px];
        if (t < 1e-4) continue;
        // The published rasteriser clamps per-pixel alpha at 0.99 so
        // transmittance never reaches exact zero mid-list.
        const a = Math.min(0.99, alpha * gaussianWeight(s, px + 0.5, py + 0.5));
        if (a < 1 / 255) continue;
        const w = a * t;
        const o = (py * width + px) * 3;
        color[o] += r * w;
        color[o + 1] += g * w;
        color[o + 2] += b * w;
        transmittance[py * width + px] = t * (1 - a);
      }
    }
  }
  return { color, transmittance };
}
