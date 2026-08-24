// Adam over the splat model's parameter arrays.
//
// Standard Adam (Kingma & Ba 2015) with per-parameter-class learning rates —
// the splat parameters live on wildly different scales (world units, log
// space, logits), so one global rate cannot serve them. The rates here follow
// the ratios established for gaussian-splat training: positions slowest and
// scaled by scene extent, opacity fastest.

import type { SplatModel } from "./model";
import type { SplatGrads } from "./backwardCpu";

export interface AdamRates {
  positions: number;
  logScales: number;
  quats: number;
  logitOpacities: number;
  colors: number;
}

/** Published defaults, position rate multiplied by the scene extent. */
export function defaultRates(sceneExtent: number): AdamRates {
  return {
    positions: 1.6e-4 * sceneExtent,
    logScales: 5e-3,
    quats: 1e-3,
    logitOpacities: 5e-2,
    colors: 2.5e-3,
  };
}

interface Moments {
  m: Float32Array;
  v: Float32Array;
}

export class AdamOptimizer {
  private readonly state = new Map<keyof AdamRates, Moments>();
  private step = 0;

  constructor(
    private readonly rates: AdamRates,
    private readonly beta1 = 0.9,
    private readonly beta2 = 0.999,
    private readonly eps = 1e-8,
  ) {}

  apply(model: SplatModel, grads: SplatGrads): void {
    this.step++;
    const correct1 = 1 - Math.pow(this.beta1, this.step);
    const correct2 = 1 - Math.pow(this.beta2, this.step);
    for (const key of Object.keys(this.rates) as Array<keyof AdamRates>) {
      const params = model[key];
      const g = grads[key];
      let mv = this.state.get(key);
      if (!mv || mv.m.length !== params.length) {
        mv = { m: new Float32Array(params.length), v: new Float32Array(params.length) };
        this.state.set(key, mv);
      }
      const lr = this.rates[key];
      for (let i = 0; i < params.length; i++) {
        const grad = g[i];
        mv.m[i] = this.beta1 * mv.m[i] + (1 - this.beta1) * grad;
        mv.v[i] = this.beta2 * mv.v[i] + (1 - this.beta2) * grad * grad;
        const mHat = mv.m[i] / correct1;
        const vHat = mv.v[i] / correct2;
        params[i] -= (lr * mHat) / (Math.sqrt(vHat) + this.eps);
      }
    }
  }

  /** Keep optimizer state aligned when splats are added or removed. */
  resize(): void {
    this.state.clear();
    this.step = 0;
  }
}
