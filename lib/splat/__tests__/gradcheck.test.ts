// Numerical gradient checking of the analytic backward pass.
//
// Every parameter class — position, log-scale, quaternion, opacity, colour —
// is perturbed and the finite-difference loss slope compared against the
// analytic gradient. L1's kink makes exact matching impossible where a
// residual crosses zero, so the target image is offset to keep residuals
// one-sided, and tolerances are relative.

import { describe, expect, it } from "vitest";

import { forwardBackward } from "../backwardCpu";
import { allocateModel, logit, type SplatModel } from "../model";
import type { Pose } from "../../recon/math/twoView";

const POSE: Pose = {
  R: new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]),
  t: [0, 0, 0],
};
const FOCAL = 60;
const W = 48;
const H = 36;
const CX = W / 2;
const CY = H / 2;

function scene(): SplatModel {
  const model = allocateModel(3);
  model.positions.set([
    -0.1, 0.05, 1.6,
    0.12, -0.04, 2.1,
    0.0, 0.0, 2.6,
  ]);
  model.logScales.set([
    Math.log(0.09), Math.log(0.14), Math.log(0.11),
    Math.log(0.16), Math.log(0.1), Math.log(0.12),
    Math.log(0.2), Math.log(0.2), Math.log(0.2),
  ]);
  model.quats.set([
    0.9, 0.1, -0.2, 0.05,
    1, 0, 0, 0,
    0.8, -0.3, 0.1, 0.2,
  ]);
  model.logitOpacities.set([logit(0.55), logit(0.4), logit(0.7)]);
  model.colors.set([
    0.9, 0.2, 0.1,
    0.15, 0.8, 0.3,
    0.2, 0.3, 0.85,
  ]);
  return model;
}

/** A target far below every rendered value keeps each residual positive, so
 *  the L1 subgradient is constant near the operating point. */
function offsetTarget(): Float32Array {
  return new Float32Array(W * H * 3).fill(-2);
}

// Cutoffs shrunk until splat-rim pixels flipping in and out of the render
// are far below the gradients under test (see ForwardBackwardOptions).
const OPTS = { alphaCutoff: 1e-5, radiusSigma: 5, minT: 1e-6 };

function numericalGrad(
  model: SplatModel,
  array: Float32Array,
  index: number,
  eps: number,
): number {
  const orig = array[index];
  array[index] = orig + eps;
  const up = forwardBackward(model, POSE, FOCAL, CX, CY, W, H, offsetTarget(), OPTS).loss;
  array[index] = orig - eps;
  const down = forwardBackward(model, POSE, FOCAL, CX, CY, W, H, offsetTarget(), OPTS).loss;
  array[index] = orig;
  return (up - down) / (2 * eps);
}

function checkClass(
  name: keyof ReturnType<typeof forwardBackward>["grads"],
  eps: number,
  tolerance: number,
) {
  const model = scene();
  const { grads } = forwardBackward(model, POSE, FOCAL, CX, CY, W, H, offsetTarget(), OPTS);
  const arr = model[name] as Float32Array;
  const g = grads[name];
  let checked = 0;
  for (let k = 0; k < arr.length; k++) {
    const numeric = numericalGrad(model, arr, k, eps);
    const analytic = g[k];
    const denom = Math.max(Math.abs(numeric), Math.abs(analytic), 1e-6);
    if (Math.abs(numeric) < 1e-7 && Math.abs(analytic) < 1e-7) continue;
    expect(
      Math.abs(numeric - analytic) / denom,
      `${String(name)}[${k}]: numeric ${numeric} vs analytic ${analytic}`,
    ).toBeLessThan(tolerance);
    checked++;
  }
  expect(checked).toBeGreaterThan(0);
}

describe("analytic gradients match numerical differentiation", () => {
  it("colours", () => { checkClass("colors", 1e-3, 0.02); });
  it("opacities", () => { checkClass("logitOpacities", 1e-3, 0.02); });
  it("positions", () => { checkClass("positions", 1e-4, 0.05); });
  it("log-scales", () => { checkClass("logScales", 1e-4, 0.05); });
  it("quaternions", () => { checkClass("quats", 1e-4, 0.05); });
});

describe("loss basics", () => {
  it("is zero when the target equals the render", () => {
    const model = scene();
    const first = forwardBackward(model, POSE, FOCAL, CX, CY, W, H, offsetTarget());
    const second = forwardBackward(model, POSE, FOCAL, CX, CY, W, H, first.color);
    expect(second.loss).toBeCloseTo(0, 6);
  });

  it("a gradient step against a solid target reduces the loss", () => {
    const model = scene();
    const target = new Float32Array(W * H * 3).fill(0.5);
    const before = forwardBackward(model, POSE, FOCAL, CX, CY, W, H, target);
    const lr = 0.5;
    for (let k = 0; k < model.colors.length; k++) {
      model.colors[k] -= lr * before.grads.colors[k];
    }
    const after = forwardBackward(model, POSE, FOCAL, CX, CY, W, H, target);
    expect(after.loss).toBeLessThan(before.loss);
  });
});
