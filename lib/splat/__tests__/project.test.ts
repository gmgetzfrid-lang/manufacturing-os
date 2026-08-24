// The projection maths against known geometry: an isotropic gaussian's screen
// footprint must equal f·s/z, rotation must carry anisotropy into the right
// screen direction, and compositing must obey occlusion. Everything downstream
// (GPU kernels, gradients) is validated against these functions.

import { describe, expect, it } from "vitest";

import { allocateModel, logit, seedFromPoints, sigmoid } from "../model";
import { gaussianWeight, projectSplat, worldCovariance } from "../project";
import { renderCpu } from "../renderCpu";
import type { Pose } from "../../recon/math/twoView";

const IDENTITY: Pose = {
  R: new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]),
  t: [0, 0, 0],
};
const FOCAL = 600;
const CX = 320;
const CY = 240;

describe("worldCovariance", () => {
  it("is diagonal s² for an axis-aligned gaussian", () => {
    const cov = worldCovariance([1, 0, 0, 0], [0.5, 2, 3]);
    expect(cov[0]).toBeCloseTo(0.25, 10);
    expect(cov[3]).toBeCloseTo(4, 10);
    expect(cov[5]).toBeCloseTo(9, 10);
    expect(cov[1]).toBeCloseTo(0, 10);
    expect(cov[2]).toBeCloseTo(0, 10);
    expect(cov[4]).toBeCloseTo(0, 10);
  });

  it("a 90° rotation about z swaps the x and y extents", () => {
    const s = Math.SQRT1_2;
    const cov = worldCovariance([s, 0, 0, s], [2, 0.5, 1]);
    expect(cov[0]).toBeCloseTo(0.25, 6);
    expect(cov[3]).toBeCloseTo(4, 6);
  });
});

describe("projectSplat", () => {
  it("puts a centred gaussian at the principal point with footprint f·s/z", () => {
    const z = 4;
    const s = 0.02;
    const proj = projectSplat([0, 0, z], [1, 0, 0, 0], [s, s, s], IDENTITY, FOCAL, CX, CY)!;
    expect(proj.x).toBeCloseTo(CX, 9);
    expect(proj.y).toBeCloseTo(CY, 9);
    expect(proj.depth).toBeCloseTo(z, 12);
    const expected = (FOCAL * s) / z;
    // Screen covariance diagonal ≈ (f·s/z)² plus the 0.3px floor.
    expect(Math.sqrt(proj.covA - 0.3)).toBeCloseTo(expected, 4);
    expect(Math.sqrt(proj.covC - 0.3)).toBeCloseTo(expected, 4);
    expect(Math.abs(proj.covB)).toBeLessThan(1e-6);
  });

  it("culls gaussians behind the camera", () => {
    expect(projectSplat([0, 0, -1], [1, 0, 0, 0], [0.1, 0.1, 0.1], IDENTITY, FOCAL, CX, CY))
      .toBeNull();
  });

  it("weights fall off with distance from the centre", () => {
    const proj = projectSplat([0, 0, 2], [1, 0, 0, 0], [0.05, 0.05, 0.05], IDENTITY, FOCAL, CX, CY)!;
    const centre = gaussianWeight(proj, CX, CY);
    const off = gaussianWeight(proj, CX + 10, CY);
    const far = gaussianWeight(proj, CX + 40, CY);
    expect(centre).toBeCloseTo(1, 5);
    expect(off).toBeLessThan(centre);
    expect(far).toBeLessThan(off);
  });

  it("an elongated gaussian is wider along its long axis on screen", () => {
    const proj = projectSplat(
      [0, 0, 3], [1, 0, 0, 0], [0.3, 0.03, 0.03], IDENTITY, FOCAL, CX, CY,
    )!;
    expect(proj.covA).toBeGreaterThan(proj.covC * 10);
  });
});

describe("renderCpu", () => {
  it("paints an opaque gaussian's colour at its centre and nothing far away", () => {
    const model = allocateModel(1);
    model.positions.set([0, 0, 2]);
    model.logScales.fill(Math.log(0.05));
    model.quats.set([1, 0, 0, 0]);
    model.logitOpacities[0] = logit(0.95);
    model.colors.set([1, 0, 0]);

    const { color, transmittance } = renderCpu(model, IDENTITY, FOCAL, CX, CY, 640, 480);
    const centre = (CY * 640 + CX) * 3;
    expect(color[centre]).toBeGreaterThan(0.85);
    expect(color[centre + 1]).toBeCloseTo(0, 6);
    expect(transmittance[CY * 640 + CX]).toBeLessThan(0.15);
    expect(color[0]).toBeCloseTo(0, 6);
    expect(transmittance[0]).toBeCloseTo(1, 6);
  });

  it("the nearer of two gaussians occludes the farther", () => {
    const model = allocateModel(2);
    // Red near, green far, both on the axis.
    model.positions.set([0, 0, 2, 0, 0, 4]);
    model.logScales.fill(Math.log(0.05));
    model.quats.set([1, 0, 0, 0, 1, 0, 0, 0]);
    model.logitOpacities.set([logit(0.9), logit(0.9)]);
    model.colors.set([1, 0, 0, 0, 1, 0]);

    const { color } = renderCpu(model, IDENTITY, FOCAL, CX, CY, 640, 480);
    const centre = (CY * 640 + CX) * 3;
    expect(color[centre]).toBeGreaterThan(0.8);
    expect(color[centre + 1]).toBeLessThan(0.2);
  });

  it("order in the array does not matter, only depth", () => {
    const build = (nearFirst: boolean) => {
      const model = allocateModel(2);
      const near = [0, 0, 2];
      const far = [0, 0, 4];
      model.positions.set(nearFirst ? [...near, ...far] : [...far, ...near]);
      model.logScales.fill(Math.log(0.05));
      model.quats.set([1, 0, 0, 0, 1, 0, 0, 0]);
      model.logitOpacities.fill(logit(0.7));
      const red = [1, 0, 0];
      const green = [0, 1, 0];
      model.colors.set(nearFirst ? [...red, ...green] : [...green, ...red]);
      return renderCpu(model, IDENTITY, FOCAL, CX, CY, 640, 480).color;
    };
    const a = build(true);
    const b = build(false);
    const centre = (CY * 640 + CX) * 3;
    for (let k = 0; k < 3; k++) expect(a[centre + k]).toBeCloseTo(b[centre + k], 6);
  });
});

describe("seedFromPoints", () => {
  it("copies positions and colours, and sizes to local spacing", () => {
    const points = Array.from({ length: 50 }, (_, i) => ({
      xyz: [Math.cos(i) * 2, Math.sin(i) * 2, (i % 7) * 0.3] as [number, number, number],
      rgb: [i * 5 % 256, 128, 30] as [number, number, number],
    }));
    const model = seedFromPoints(points, 0.12);
    expect(model.count).toBe(50);
    expect(model.positions[3]).toBeCloseTo(points[1].xyz[0], 6);
    expect(sigmoid(model.logitOpacities[0])).toBeCloseTo(0.12, 6);
    for (let i = 0; i < model.count; i++) {
      const s = Math.exp(model.logScales[i * 3]);
      expect(s).toBeGreaterThan(1e-5);
      expect(s).toBeLessThan(10);
    }
  });
});
