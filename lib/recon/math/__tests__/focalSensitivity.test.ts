import { describe, expect, it } from "vitest";
import { ransacEssential, type Pose } from "../twoView";

function makeRng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

const IDENTITY: Pose = { R: new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]), t: [0, 0, 0] };

/**
 * A room seen from two positions, rendered through a camera of focal TRUE_F.
 * Returned in PIXELS, as the pipeline sees them before un-projecting.
 */
const W = 1280;
const H = 720;
const TRUE_F = 0.8 * W; // a typical phone main camera, about 64 degrees

function capturePixels(seed = 5) {
  const rng = makeRng(seed);
  const moved: Pose = { R: IDENTITY.R, t: [-0.35, 0.02, -0.5] };
  const out: Array<{ ax: number; ay: number; bx: number; by: number }> = [];
  for (let i = 0; i < 500; i++) {
    const X: [number, number, number] = [
      (rng() - 0.5) * 6, (rng() - 0.5) * 3.2, 1.8 + rng() * 7,
    ];
    const proj = (p: Pose) => {
      const R = p.R;
      const z = R[6] * X[0] + R[7] * X[1] + R[8] * X[2] + p.t[2];
      const x = R[0] * X[0] + R[1] * X[1] + R[2] * X[2] + p.t[0];
      const y = R[3] * X[0] + R[4] * X[1] + R[5] * X[2] + p.t[1];
      return { u: (x / z) * TRUE_F + W / 2, v: (y / z) * TRUE_F + H / 2, z };
    };
    const a = proj(IDENTITY);
    const b = proj(moved);
    if (a.z < 0.4 || b.z < 0.4) continue;
    if (a.u < 0 || a.u >= W || a.v < 0 || a.v >= H) continue;
    if (b.u < 0 || b.u >= W || b.v < 0 || b.v >= H) continue;
    // A pixel of matching noise, which is what real features carry.
    out.push({
      ax: a.u + (rng() - 0.5), ay: a.v + (rng() - 0.5),
      bx: b.u + (rng() - 0.5), by: b.v + (rng() - 0.5),
    });
  }
  return out;
}

/** Verify the capture under an assumed focal, exactly as reconstruct.ts does. */
function inliersAtFocal(px: ReturnType<typeof capturePixels>, focal: number) {
  const corr = px.map((p) => ({
    x1: (p.ax - W / 2) / focal, y1: (p.ay - H / 2) / focal,
    x2: (p.bx - W / 2) / focal, y2: (p.by - H / 2) / focal,
  }));
  const geo = ransacEssential(corr, 2.0 / focal, {
    confidence: 0.999, maxIterations: 600, seed: 77,
  });
  return geo ? geo.inlierCount : 0;
}

describe("sensitivity of pair verification to the assumed focal length", () => {
  const px = capturePixels();

  it("verifies nearly everything at the true focal", () => {
    expect(inliersAtFocal(px, TRUE_F)).toBeGreaterThan(px.length * 0.8);
  });

  /**
   * Recorded because it disproved a diagnosis, and would otherwise be
   * rediscovered the hard way.
   *
   * A capture failing verification looks like a calibration problem, and the
   * old prior really was about 50% longer than a phone lens. But verification
   * barely notices: the epipolar test runs in normalised coordinates with a
   * threshold carried in the same units, so getting the focal wrong rescales
   * the points and the tolerance together and very nearly cancels out.
   */
  it("survives a focal 50% too long, losing few correspondences", () => {
    const atTrue = inliersAtFocal(px, TRUE_F);
    const atOldPrior = inliersAtFocal(px, 1.2 * W);
    expect(atOldPrior).toBeGreaterThan(atTrue * 0.9);
  });

  it("survives a focal 20% too short as well", () => {
    const atTrue = inliersAtFocal(px, TRUE_F);
    expect(inliersAtFocal(px, 0.64 * W)).toBeGreaterThan(atTrue * 0.9);
  });

  /**
   * The corollary, and the reason this file exists: inlier count cannot be used
   * to SEARCH for the focal. A shorter hypothesis loosens the normalised
   * threshold in proportion, so the score rewards leniency rather than fit and
   * slides monotonically to the shortest rung offered. Any focal search has to
   * score its residual in pixels instead.
   */
  it("cannot be used to search for the focal — the score has no honest peak", () => {
    const ladder = [0.65, 0.75, 0.85, 0.95, 1.1, 1.3, 1.6];
    const counts = ladder.map((k) => inliersAtFocal(px, k * W));
    const bestIdx = counts.indexOf(Math.max(...counts));
    // The truth is 0.80w, sitting between rungs 1 and 2 — the peak is not there.
    expect(ladder[bestIdx]).toBeLessThanOrEqual(0.75);
  });
});
