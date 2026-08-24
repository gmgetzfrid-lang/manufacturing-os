// Second-pass matching along epipolar lines, for scenes that look like
// themselves everywhere.
//
// A real capture measured 98% of its candidate matches dying at the ratio
// test: the environment was so self-similar that for almost every corner there
// were two near-identical candidates, and the test rightly refused to choose.
// Yet its ADJACENT frames still matched well — enough for RANSAC to recover
// the pair's essential matrix from the survivors.
//
// That matrix is the way back in. A feature in one image can only match along
// one line in the other, and on a single epipolar line the true match is
// usually unique even when the frame as a whole is a hall of mirrors. So:
// verify the pair on its unambiguous matches, then re-match EVERYTHING under
// the epipolar constraint, applying the ratio test only among candidates on
// the line. COLMAP does the same, for the same reason.

import type { FrameFeatures } from "../types";
import type { MatchPair } from "../gpu/matcher";

/** Hamming distance between two 32-byte descriptor rows. */
function hamming(a: Uint8Array, ao: number, b: Uint8Array, bo: number): number {
  let d = 0;
  for (let i = 0; i < 32; i++) {
    let v = a[ao + i] ^ b[bo + i];
    // Kernighan popcount: at most 8 iterations per byte.
    while (v) { v &= v - 1; d++; }
  }
  return d;
}

export interface GuidedOptions {
  /** Half-width of the epipolar band, in pixels. */
  bandPx: number;
  maxDistance: number;
  /** Ratio test among candidates INSIDE the band only. */
  ratio: number;
}

/**
 * Match every feature of `fa` against `fb`, restricted to the epipolar band
 * implied by the essential matrix E (x2ᵀ·E·x1 = 0 in normalised coordinates).
 */
export function guidedMatches(
  fa: FrameFeatures,
  fb: FrameFeatures,
  E: Float64Array,
  focal: number,
  cx: number,
  cy: number,
  options: GuidedOptions,
): MatchPair[] {
  const band = options.bandPx / focal;
  const out: MatchPair[] = [];

  // Normalise fb's keypoints once.
  const bx = new Float64Array(fb.count);
  const by = new Float64Array(fb.count);
  for (let j = 0; j < fb.count; j++) {
    bx[j] = (fb.keypoints[j * 2] - cx) / focal;
    by[j] = (fb.keypoints[j * 2 + 1] - cy) / focal;
  }

  for (let i = 0; i < fa.count; i++) {
    const x1 = (fa.keypoints[i * 2] - cx) / focal;
    const y1 = (fa.keypoints[i * 2 + 1] - cy) / focal;

    // Epipolar line in image B: l = E · x1.
    const la = E[0] * x1 + E[1] * y1 + E[2];
    const lb = E[3] * x1 + E[4] * y1 + E[5];
    const lc = E[6] * x1 + E[7] * y1 + E[8];
    const norm = Math.hypot(la, lb);
    if (norm < 1e-12) continue;
    const limit = band * norm;

    let best = 0x7fffffff;
    let second = 0x7fffffff;
    let bestJ = -1;
    for (let j = 0; j < fb.count; j++) {
      if (Math.abs(la * bx[j] + lb * by[j] + lc) > limit) continue;
      const d = hamming(fa.descriptors, i * 32, fb.descriptors, j * 32);
      if (d < best) { second = best; best = d; bestJ = j; }
      else if (d < second) { second = d; }
    }

    if (bestJ < 0 || best > options.maxDistance) continue;
    if (second !== 0x7fffffff && best > options.ratio * second) continue;
    out.push({ queryIndex: i, trainIndex: bestJ, distance: best, second });
  }

  // One feature in B must not be claimed by several features in A — keep the
  // closest claimant, or the geometry gets fed contradictions.
  const byTrain = new Map<number, MatchPair>();
  for (const m of out) {
    const held = byTrain.get(m.trainIndex);
    if (!held || m.distance < held.distance) byTrain.set(m.trainIndex, m);
  }
  return [...byTrain.values()];
}
