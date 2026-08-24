// The regime a real couch-orbit capture measured: adjacent frames share
// hundreds of matches, anything further shares almost nothing, and the few
// features that survive three frames are too few for PnP. Growth must walk
// the chain by composing pair poses, or it strands everything past the seed —
// which is exactly what happened (5 of 28 frames, run after run).
//
// This reproduces that structure in seconds, against ground truth.

import { describe, expect, it } from "vitest";

import { DEFAULT_RECON_CONFIG, applyPreset } from "../../config";
import { mat3MulVec } from "../../math/linalg";
import type { Pose } from "../../math/twoView";
import type { FrameFeatures } from "../../types";
import { reconstruct, type FrameMeta } from "../reconstruct";
import { globalDescriptor } from "../features";

function makeRng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

const WIDTH = 960;
const HEIGHT = 540;
const FOCAL = 1.2 * WIDTH;
const CX = WIDTH / 2;
const CY = HEIGHT / 2;
const FRAMES = 26;

function lookAt(eye: [number, number, number], target: [number, number, number]): Pose {
  const f: [number, number, number] = [
    target[0] - eye[0], target[1] - eye[1], target[2] - eye[2],
  ];
  const fn = Math.hypot(...f);
  const fwd: [number, number, number] = [f[0] / fn, f[1] / fn, f[2] / fn];
  const up: [number, number, number] = [0, 1, 0];
  let right: [number, number, number] = [
    up[1] * fwd[2] - up[2] * fwd[1],
    up[2] * fwd[0] - up[0] * fwd[2],
    up[0] * fwd[1] - up[1] * fwd[0],
  ];
  const rn = Math.hypot(...right) || 1;
  right = [right[0] / rn, right[1] / rn, right[2] / rn];
  const down: [number, number, number] = [
    right[1] * fwd[2] - right[2] * fwd[1],
    right[2] * fwd[0] - right[0] * fwd[2],
    right[0] * fwd[1] - right[1] * fwd[0],
  ];
  const R = new Float64Array([
    right[0], right[1], right[2],
    down[0], down[1], down[2],
    fwd[0], fwd[1], fwd[2],
  ]);
  const t = mat3MulVec(R, [-eye[0], -eye[1], -eye[2]]);
  return { R, t: [t[0], t[1], t[2]] };
}

function project(pose: Pose, X: readonly number[]): [number, number] | null {
  const c = mat3MulVec(pose.R, X);
  const z = c[2] + pose.t[2];
  if (z <= 0.2) return null;
  const u = (FOCAL * (c[0] + pose.t[0])) / z + CX;
  const v = (FOCAL * (c[1] + pose.t[1])) / z + CY;
  if (u < 0 || v < 0 || u >= WIDTH || v >= HEIGHT) return null;
  return [u, v];
}

function synthesiseChain(seed: number) {
  const rng = makeRng(seed);

  // An orbit: cameras on a circle, all looking at the centre.
  const centre: [number, number, number] = [0, 1, 0];
  const truthPoses: Pose[] = [];
  for (let i = 0; i < FRAMES; i++) {
    const angle = (i / (FRAMES - 1)) * (Math.PI * 0.7);
    truthPoses.push(lookAt(
      [Math.sin(angle) * 3, 1.5, -Math.cos(angle) * 3], centre,
    ));
  }

  // Points are born per frame with a LIFESPAN: most last 2 frames (adjacent
  // pairs only), a handful last 3 (the PnP-starving, scale-pinning few).
  interface WorldPoint { X: [number, number, number]; born: number; lifespan: number; desc: Uint8Array; }
  const world: WorldPoint[] = [];
  const randomDesc = () => {
    const d = new Uint8Array(32);
    for (let k = 0; k < 32; k++) d[k] = (rng() * 256) | 0;
    return d;
  };
  for (let i = 0; i < FRAMES; i++) {
    // Points scattered around the orbit centre, where every camera looks.
    const make = (lifespan: number) => {
      const X: [number, number, number] = [
        centre[0] + (rng() - 0.5) * 2.4,
        centre[1] + (rng() - 0.5) * 1.6,
        centre[2] + (rng() - 0.5) * 2.4,
      ];
      world.push({ X, born: i, lifespan, desc: randomDesc() });
    };
    for (let p = 0; p < 150; p++) make(2);
    for (let p = 0; p < 8; p++) make(3);
  }

  const frames: FrameMeta[] = [];
  const features: FrameFeatures[] = [];
  for (let i = 0; i < FRAMES; i++) {
    const kp: number[] = [];
    const desc: number[] = [];
    const gray = new Uint8Array(WIDTH * HEIGHT);
    for (const p of world) {
      if (i < p.born || i >= p.born + p.lifespan) continue;
      const uv = project(truthPoses[i], p.X);
      if (!uv) continue;
      kp.push(uv[0] + (rng() - 0.5) * 0.8, uv[1] + (rng() - 0.5) * 0.8);
      const copy = new Uint8Array(p.desc);
      copy[(rng() * 32) | 0] ^= 1 << ((rng() * 8) | 0);
      for (let k = 0; k < 32; k++) desc.push(copy[k]);
      const gx = Math.round(uv[0]);
      const gy = Math.round(uv[1]);
      if (gx > 1 && gy > 1 && gx < WIDTH - 2 && gy < HEIGHT - 2) {
        gray[gy * WIDTH + gx] = 200;
      }
    }
    frames.push({
      index: i, clipId: "walk", clipIndex: 0, orderInClip: i,
      width: WIDTH, height: HEIGHT,
    });
    features.push({
      frameIndex: i,
      count: kp.length / 2,
      keypoints: Float32Array.from(kp),
      descriptors: Uint8Array.from(desc),
      descriptorBytes: 32,
      globalDescriptor: globalDescriptor(gray, WIDTH, HEIGHT),
    });
  }
  return { frames, features, truthPoses };
}

const sampler = () => [128, 128, 128] as [number, number, number];

describe("a chain capture, where only adjacent frames share features", () => {
  it("registers the chain by composing pair poses where PnP starves", async () => {
    const { frames, features } = synthesiseChain(77);
    const cfg = applyPreset(DEFAULT_RECON_CONFIG, "balanced");
    cfg.features.sequentialWindow = 4;
    cfg.features.loopCandidates = 2;

    const result = await reconstruct(frames, features, sampler, {
      config: cfg,
      forceCpuMatching: true,
    });

    // Without composition this stalls at the seed's immediate neighbourhood —
    // the shape a real orbit produced run after run: 5 of 28.
    expect(result.registeredFrames.length).toBeGreaterThanOrEqual(FRAMES * 0.8);
    expect(result.components.length).toBe(1);
  }, 240000);
});
