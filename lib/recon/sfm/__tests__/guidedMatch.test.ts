import { describe, expect, it } from "vitest";
import { guidedMatches } from "../guidedMatch";
import { matchMutualCpu } from "../../gpu/matcher";
import type { FrameFeatures } from "../../types";

function makeRng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

const FOCAL = 800;
const CX = 640;
const CY = 360;

/** Two views of a room, with a controllable amount of repeated texture. */
function scene(duplicatePairs: number, seed = 5) {
  const rng = makeRng(seed);
  const R = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const t = [-0.4, 0.05, -0.2];
  // E = [t]x · R for x2ᵀ·E·x1 = 0 with X_cam = R·X + t.
  const E = new Float64Array([
    -t[2] * R[3] + t[1] * R[6], -t[2] * R[4] + t[1] * R[7], -t[2] * R[5] + t[1] * R[8],
    t[2] * R[0] - t[0] * R[6], t[2] * R[1] - t[0] * R[7], t[2] * R[2] - t[0] * R[8],
    -t[1] * R[0] + t[0] * R[3], -t[1] * R[1] + t[0] * R[4], -t[1] * R[2] + t[0] * R[5],
  ]);

  const project = (X: number[], moved: boolean) => {
    const x = moved ? X[0] + t[0] : X[0];
    const y = moved ? X[1] + t[1] : X[1];
    const z = moved ? X[2] + t[2] : X[2];
    return { u: (x / z) * FOCAL + CX, v: (y / z) * FOCAL + CY, z };
  };

  const randomDesc = () => {
    const d = new Uint8Array(32);
    for (let i = 0; i < 32; i++) d[i] = Math.floor(rng() * 256);
    return d;
  };
  /** A copy with `k` random bits flipped — viewpoint noise, or a near-twin. */
  const perturbed = (base: Uint8Array, k: number) => {
    const d = base.slice();
    for (let i = 0; i < k; i++) {
      const bit = Math.floor(rng() * 256);
      d[bit >> 3] ^= 1 << (bit & 7);
    }
    return d;
  };

  const descA: Uint8Array[] = [];
  const descB: Uint8Array[] = [];
  const ptsA: number[] = [];
  const ptsB: number[] = [];
  let n = 0;
  // Each view sees the point through its own noise (~14 bits): a true match
  // sits ~28 bits apart, which is why a near-twin ~30 bits away makes the
  // global ratio ~0.93 and kills it. Bit-identical twins would sneak through
  // the ratio test on the 0 <= r*0 degeneracy, which real texture never does.
  const add = (X: number[], base: Uint8Array) => {
    const a = project(X, false);
    const b = project(X, true);
    if (a.z < 0.5 || b.z < 0.5) return;
    if (a.u < 0 || a.u > 1280 || a.v < 0 || a.v > 720) return;
    if (b.u < 0 || b.u > 1280 || b.v < 0 || b.v > 720) return;
    ptsA.push(a.u, a.v);
    ptsB.push(b.u, b.v);
    descA.push(perturbed(base, 14));
    descB.push(perturbed(base, 14));
    n++;
  };

  // Unique texture: distinctive points anywhere.
  for (let i = 0; i < 60; i++) {
    add([(rng() - 0.5) * 5, (rng() - 0.5) * 3, 2 + rng() * 5], randomDesc());
  }
  // Repeated texture: pairs of points far apart vertically whose descriptors
  // are near-twins — identical bolts on identical panels. The global ratio
  // test sees two nearly equal candidates and refuses both; their epipolar
  // lines differ, so the band separates them.
  for (let i = 0; i < duplicatePairs; i++) {
    const base = randomDesc();
    const twin = perturbed(base, 4);
    const x = (rng() - 0.5) * 5;
    const z = 2 + rng() * 5;
    add([x, -1.2 + rng() * 0.2, z], base);
    add([x + 0.02, 1.2 + rng() * 0.2, z + 0.01], twin);
  }

  const features = (pts: number[], descs: Uint8Array[]): FrameFeatures => ({
    frameIndex: 0,
    count: n,
    keypoints: Float32Array.from(pts),
    descriptors: (() => {
      const out = new Uint8Array(n * 32);
      descs.forEach((d, i) => out.set(d, i * 32));
      return out;
    })(),
    descriptorBytes: 32,
    globalDescriptor: new Float32Array(16),
  });

  return { fa: features(ptsA, descA), fb: features(ptsB, descB), E, n };
}

describe("guided matching along epipolar lines", () => {
  it("recovers the matches the global ratio test kills in a self-similar scene", () => {
    const { fa, fb, E, n } = scene(60); // 120 of 180 points are duplicated pairs
    const global = matchMutualCpu(
      { data: fa.descriptors, count: fa.count },
      { data: fb.descriptors, count: fb.count },
      {},
    );
    const guided = guidedMatches(fa, fb, E, FOCAL, CX, CY, {
      bandPx: 2.5, maxDistance: 110, ratio: 0.85,
    });
    // The global matcher loses most of the duplicated texture (some twins slip
    // through when noise happens to separate them — real fabric is no kinder)...
    expect(global.length).toBeLessThan(n * 0.55);
    // ...the epipolar band gets nearly all of it back.
    expect(guided.length).toBeGreaterThan(n * 0.85);
    expect(guided.length).toBeGreaterThan(global.length * 1.6);
  });

  it("recovers CORRECT matches, not merely numerous ones", () => {
    const { fa, fb, E, n } = scene(60, 11);
    const guided = guidedMatches(fa, fb, E, FOCAL, CX, CY, {
      bandPx: 2.5, maxDistance: 110, ratio: 0.85,
    });
    let right = 0;
    for (const m of guided) if (m.queryIndex === m.trainIndex) right++;
    expect(right / guided.length).toBeGreaterThan(0.95);
    expect(right).toBeGreaterThan(n * 0.8);
  });

  it("matches everything on unique texture too", () => {
    const { fa, fb, E, n } = scene(0, 3);
    const guided = guidedMatches(fa, fb, E, FOCAL, CX, CY, {
      bandPx: 2.5, maxDistance: 110, ratio: 0.85,
    });
    expect(guided.length).toBeGreaterThan(n * 0.9);
  });

  it("never hands two features of one image the same partner in the other", () => {
    const { fa, fb, E } = scene(60, 7);
    const guided = guidedMatches(fa, fb, E, FOCAL, CX, CY, {
      bandPx: 2.5, maxDistance: 110, ratio: 0.85,
    });
    const trains = new Set(guided.map((m) => m.trainIndex));
    expect(trains.size).toBe(guided.length);
  });
});
