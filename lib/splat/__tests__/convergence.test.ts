// End-to-end proof the training machinery LEARNS: render a ground-truth
// scene from several viewpoints, start a perturbed copy, and train with the
// verified gradients + Adam. The loss must fall substantially and the
// recovered parameters must move toward the truth. This is the CPU dress
// rehearsal of exactly what the WebGPU trainer does at scale.

import { describe, expect, it } from "vitest";

import { AdamOptimizer } from "../adam";
import { forwardBackward } from "../backwardCpu";
import { allocateModel, logit, sigmoid, type SplatModel } from "../model";
import { renderCpu } from "../renderCpu";
import type { Pose } from "../../recon/math/twoView";
import { rodrigues, mat3MulVec } from "../../recon/math/linalg";

const FOCAL = 70;
const W = 56;
const H = 42;
const CX = W / 2;
const CY = H / 2;

function lookFrom(angle: number): Pose {
  // Cameras on a small arc, looking at the cluster around z≈2.
  const R = rodrigues([0, angle, 0]);
  const eye: [number, number, number] = [Math.sin(angle) * 2, 0, 2 - Math.cos(angle) * 2];
  const t = mat3MulVec(R, [-eye[0], -eye[1], -eye[2]]);
  return { R, t: [t[0], t[1], t[2]] };
}

function truthScene(): SplatModel {
  const model = allocateModel(4);
  model.positions.set([
    -0.25, 0.1, 2.0,
    0.3, -0.15, 2.2,
    0.0, 0.25, 1.8,
    0.05, -0.05, 2.5,
  ]);
  model.logScales.fill(Math.log(0.12));
  model.quats.set([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]);
  model.logitOpacities.fill(logit(0.75));
  model.colors.set([
    0.9, 0.15, 0.1,
    0.1, 0.85, 0.2,
    0.15, 0.2, 0.9,
    0.85, 0.8, 0.1,
  ]);
  return model;
}

describe("training convergence on a synthetic scene", () => {
  it("recovers colour and opacity from a perturbed start", () => {
    const truth = truthScene();
    const views = [-0.25, 0, 0.25].map(lookFrom);
    const targets = views.map((pose) =>
      renderCpu(truth, pose, FOCAL, CX, CY, W, H).color);

    // Perturbed start: grey, translucent, slightly moved and mis-sized.
    const model = truthScene();
    model.colors.fill(0.5);
    model.logitOpacities.fill(logit(0.35));
    for (let i = 0; i < model.count * 3; i++) {
      model.positions[i] += (i % 3 === 2 ? 0.05 : -0.04);
      model.logScales[i] += 0.25;
    }

    const opt = new AdamOptimizer({
      positions: 2e-3,
      logScales: 2e-2,
      quats: 4e-3,
      logitOpacities: 8e-2,
      colors: 2e-2,
    });

    const lossAt = () => views.reduce((sum, pose, v) =>
      sum + forwardBackward(model, pose, FOCAL, CX, CY, W, H, targets[v]).loss, 0);

    const before = lossAt();
    for (let iter = 0; iter < 220; iter++) {
      const view = iter % views.length;
      const { grads } = forwardBackward(
        model, views[view], FOCAL, CX, CY, W, H, targets[view],
      );
      opt.apply(model, grads);
    }
    const after = lossAt();

    expect(after).toBeLessThan(before * 0.25);

    // The first splat's colour should be recognisably red again, and the
    // opacities should have risen toward opaque.
    expect(model.colors[0]).toBeGreaterThan(0.6);
    expect(model.colors[1]).toBeLessThan(0.45);
    const meanOpacity = Array.from(model.logitOpacities)
      .reduce((a, l) => a + sigmoid(l), 0) / model.count;
    expect(meanOpacity).toBeGreaterThan(0.5);
  }, 120000);
});
