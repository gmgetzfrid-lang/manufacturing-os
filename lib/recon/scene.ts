// Turning a reconstruction into something a first-person viewer can use.
//
// SfM produces a point cloud in an arbitrary frame: not metric, not
// gravity-aligned, origin wherever the seed pair happened to land. A viewer
// needs the opposite of that — which way is up, how big a metre is, where the
// floor is, and where to put the user. Rather than make the viewer guess or
// have somebody type numbers into a config, all four are derived here from the
// reconstruction itself, and each records HOW it was obtained so an assumption
// never masquerades as a measurement.

import type { ReconConfig } from "./config";
import { jacobiEigenSymmetric, mat3MulVec, mat3Transpose } from "./math/linalg";
import type { Pose } from "./math/twoView";
import { CLIP_COLORS, type ReconReport, type SceneData } from "./types";

export interface PointCloud {
  xyz: Float32Array;
  rgb: Uint8Array;
  count: number;
}

export interface SceneInput {
  id: string;
  label: string;
  poses: Map<number, Pose>;
  /** Frame index → clip id, in capture order. */
  frameClip: Map<number, string>;
  frameOrder: Map<number, number>;
  clips: Array<{ id: string; label: string; keptFrames: number }>;
  points: PointCloud;
  config: ReconConfig;
  report: ReconReport;
}

function cameraCentre(pose: Pose): [number, number, number] {
  const c = mat3MulVec(mat3Transpose(pose.R), [-pose.t[0], -pose.t[1], -pose.t[2]]);
  return [c[0], c[1], c[2]];
}

/** World "up" as the camera saw it. COLMAP-style cameras are x-right, y-DOWN,
 *  z-forward, so up is the negated second row of Rᵀ. */
function cameraUp(pose: Pose): [number, number, number] {
  const u = mat3MulVec(mat3Transpose(pose.R), [0, -1, 0]);
  return [u[0], u[1], u[2]];
}

function cameraForward(pose: Pose): [number, number, number] {
  const f = mat3MulVec(mat3Transpose(pose.R), [0, 0, 1]);
  return [f[0], f[1], f[2]];
}

/**
 * Which way is up.
 *
 * People hold phones roughly upright, so averaging the camera up-vectors over a
 * whole walkthrough cancels the wobble and leaves gravity. That is cross-checked
 * against the plane the camera centres lie in — a walking person's viewpoint
 * traces a horizontal sheet — and the two are blended when they agree.
 */
function deriveUp(poses: Pose[]): { up: [number, number, number]; source: string } {
  if (poses.length === 0) return { up: [0, 1, 0], source: "fallback-default" };

  let ux = 0, uy = 0, uz = 0;
  for (const p of poses) {
    const u = cameraUp(p);
    ux += u[0]; uy += u[1]; uz += u[2];
  }
  let n = Math.hypot(ux, uy, uz);
  if (n < 1e-9) return { up: [0, 1, 0], source: "fallback-default" };
  let up: [number, number, number] = [ux / n, uy / n, uz / n];
  let source = "camera-up-average";

  if (poses.length >= 8) {
    const centres = poses.map(cameraCentre);
    const mean = [0, 0, 0];
    for (const c of centres) { mean[0] += c[0]; mean[1] += c[1]; mean[2] += c[2]; }
    mean[0] /= centres.length; mean[1] /= centres.length; mean[2] /= centres.length;

    // Smallest principal direction of the camera track ≈ the vertical.
    const cov = new Float64Array(9);
    for (const c of centres) {
      const d = [c[0] - mean[0], c[1] - mean[1], c[2] - mean[2]];
      for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) cov[i * 3 + j] += d[i] * d[j];
    }
    // The eigenvector of the smallest eigenvalue is the plane normal.
    const { vectors } = jacobiEigenSymmetric(cov, 3);
    let normal: [number, number, number] = [vectors[0], vectors[1], vectors[2]];
    if (normal[0] * up[0] + normal[1] * up[1] + normal[2] * up[2] < 0) {
      normal = [-normal[0], -normal[1], -normal[2]];
    }
    const agreement = normal[0] * up[0] + normal[1] * up[1] + normal[2] * up[2];
    if (agreement > 0.8) {
      const bx = up[0] + normal[0];
      const by = up[1] + normal[1];
      const bz = up[2] + normal[2];
      n = Math.hypot(bx, by, bz);
      if (n > 1e-9) {
        up = [bx / n, by / n, bz / n];
        source = "camera-up+track-plane";
      }
    }
  }
  return { up, source };
}

/** Rotation taking reconstruction coordinates into a Y-up frame. */
function basisFromUp(up: [number, number, number]): Float64Array {
  const y = up;
  let seed: [number, number, number] = [1, 0, 0];
  if (Math.abs(seed[0] * y[0] + seed[1] * y[1] + seed[2] * y[2]) > 0.9) seed = [0, 0, 1];
  let x: [number, number, number] = [
    seed[1] * y[2] - seed[2] * y[1],
    seed[2] * y[0] - seed[0] * y[2],
    seed[0] * y[1] - seed[1] * y[0],
  ];
  const nx = Math.hypot(...x) || 1;
  x = [x[0] / nx, x[1] / nx, x[2] / nx];
  const z: [number, number, number] = [
    x[1] * y[2] - x[2] * y[1],
    x[2] * y[0] - x[0] * y[2],
    x[0] * y[1] - x[1] * y[0],
  ];
  // Rows are the new basis expressed in old coordinates: R · p_old = p_new.
  return new Float64Array([x[0], x[1], x[2], y[0], y[1], y[2], z[0], z[1], z[2]]);
}

function percentile(sorted: Float64Array | number[], p: number): number {
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * p)));
  return sorted[idx] as number;
}

/**
 * Recover metric scale from the assumption that the phone was held at roughly
 * `assumedCameraHeightM` above the floor.
 *
 * This is an assumption, not a measurement, and it is labelled as such in the
 * output. It only has to be close: the goal is that walking feels right, not
 * that the couch is exactly 8 feet 4 inches away.
 */
function deriveScale(
  camY: number[], pointY: number[], cfg: ReconConfig,
): { floor: number; scale: number; source: string } {
  if (pointY.length < 100 || camY.length === 0) {
    return { floor: 0, scale: 1, source: "fallback-unit" };
  }
  const camSorted = [...camY].sort((a, b) => a - b);
  const camLevel = percentile(camSorted, 0.5);

  const below = pointY.filter((y) => y < camLevel).sort((a, b) => a - b);
  if (below.length < 50) {
    return { floor: Math.min(...pointY), scale: 1, source: "fallback-unit" };
  }
  // 3rd percentile rather than the minimum: stray points under the floor are
  // normal in stereo output and would otherwise set the floor a metre low.
  const floor = percentile(below, 0.03);
  const drop = camLevel - floor;
  if (drop <= 1e-6) return { floor, scale: 1, source: "fallback-unit" };

  return { floor, scale: cfg.viewer.assumedCameraHeightM / drop, source: "camera-height" };
}

/**
 * Where the user spawns.
 *
 * The prescribed shot list has clip C starting at the far end of the hallway and
 * walking in, so its first registered frame is exactly "start near the hallway".
 * When that clip is absent or unregistered, fall back to the registered camera
 * furthest from the middle of the capture — for a hallway-plus-room capture that
 * is the end of the corridor.
 */
function pickStart(
  poses: Map<number, Pose>,
  frameClip: Map<number, string>,
  frameOrder: Map<number, number>,
): { frame: number; source: string } {
  const byClip = new Map<string, number[]>();
  for (const frame of poses.keys()) {
    const clip = frameClip.get(frame) ?? "";
    const list = byClip.get(clip);
    if (list) list.push(frame);
    else byClip.set(clip, [frame]);
  }
  for (const list of byClip.values()) {
    list.sort((a, b) => (frameOrder.get(a) ?? 0) - (frameOrder.get(b) ?? 0));
  }

  for (const [clipId, list] of byClip) {
    if (list.length < 5) continue;
    const lower = clipId.toLowerCase();
    // Clip C walks hallway → room, so its FIRST frame is down the hallway.
    if (lower.includes("video-c") || lower.endsWith("-c") || lower.includes("hall")) {
      return { frame: list[0], source: `${clipId}-first-frame` };
    }
    // Clip D walks room → hallway, so its LAST frame is down the hallway.
    if (lower.includes("video-d") || lower.endsWith("-d")) {
      return { frame: list[list.length - 1], source: `${clipId}-last-frame` };
    }
  }

  const frames = [...poses.keys()];
  const centres = frames.map((f) => cameraCentre(poses.get(f)!));
  const mean = [0, 0, 0];
  for (const c of centres) { mean[0] += c[0]; mean[1] += c[1]; mean[2] += c[2]; }
  mean[0] /= centres.length; mean[1] /= centres.length; mean[2] /= centres.length;
  let best = 0;
  let bestDist = -1;
  centres.forEach((c, i) => {
    const d = Math.hypot(c[0] - mean[0], c[1] - mean[1], c[2] - mean[2]);
    if (d > bestDist) { bestDist = d; best = i; }
  });
  return { frame: frames[best], source: "furthest-camera" };
}

/**
 * Quantised interleaved point payload.
 *
 * 10 bytes per point (3 x int16 position + RGB + 1 pad) and, more importantly,
 * ZERO parsing in the viewer: the buffer is copied straight into a typed array
 * and handed to the GPU. int16 over a 20 m room quantises to about 0.3 mm, far
 * below reconstruction noise.
 */
export function encodePoints(
  xyz: Float32Array, rgb: Uint8Array, count: number,
): { buffer: ArrayBuffer; quantization: SceneData["quantization"] } {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < count; i++) {
    for (let a = 0; a < 3; a++) {
      const v = xyz[i * 3 + a];
      if (v < min[a]) min[a] = v;
      if (v > max[a]) max[a] = v;
    }
  }
  const span: [number, number, number] = [
    Math.max(1e-6, max[0] - min[0]),
    Math.max(1e-6, max[1] - min[1]),
    Math.max(1e-6, max[2] - min[2]),
  ];

  const buffer = new ArrayBuffer(count * 10);
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  for (let i = 0; i < count; i++) {
    const b = i * 10;
    for (let a = 0; a < 3; a++) {
      const norm = (xyz[i * 3 + a] - min[a]) / span[a];
      const q = Math.max(-32768, Math.min(32767, Math.round(norm * 65535 - 32768)));
      view.setInt16(b + a * 2, q, true);
    }
    bytes[b + 6] = rgb[i * 3];
    bytes[b + 7] = rgb[i * 3 + 1];
    bytes[b + 8] = rgb[i * 3 + 2];
  }
  return { buffer, quantization: { min, span } };
}

export function buildScene(input: SceneInput): SceneData {
  const { poses, points, config } = input;
  const poseList = [...poses.values()];

  // ── World frame ─────────────────────────────────────────────────────────
  const { up, source: gravitySource } = deriveUp(poseList);
  const R = basisFromUp(up);

  const rotate = (p: readonly number[]): [number, number, number] => {
    const v = mat3MulVec(R, p);
    return [v[0], v[1], v[2]];
  };

  const camRotated = poseList.map((p) => rotate(cameraCentre(p)));
  const camY = camRotated.map((c) => c[1]);

  const pointYSample: number[] = [];
  const sampleStride = Math.max(1, Math.floor(points.count / 40000));
  for (let i = 0; i < points.count; i += sampleStride) {
    const v = rotate([points.xyz[i * 3], points.xyz[i * 3 + 1], points.xyz[i * 3 + 2]]);
    pointYSample.push(v[1]);
  }

  const { floor, scale, source: scaleSource } = deriveScale(camY, pointYSample, config);

  // Full transform: rotate to Y-up, scale to metres, drop the floor to y = 0.
  const apply = (p: readonly number[]): [number, number, number] => {
    const v = rotate(p);
    return [v[0] * scale, v[1] * scale - floor * scale, v[2] * scale];
  };

  // ── Transform the cloud ─────────────────────────────────────────────────
  const outXyz = new Float32Array(points.count * 3);
  for (let i = 0; i < points.count; i++) {
    const v = apply([points.xyz[i * 3], points.xyz[i * 3 + 1], points.xyz[i * 3 + 2]]);
    outXyz[i * 3] = v[0];
    outXyz[i * 3 + 1] = v[1];
    outXyz[i * 3 + 2] = v[2];
  }

  // Trim statistical outliers so the bounds are not dictated by a handful of
  // stray stereo points a hundred metres away.
  const axisSorted: number[][] = [[], [], []];
  const trimStride = Math.max(1, Math.floor(points.count / 60000));
  for (let i = 0; i < points.count; i += trimStride) {
    for (let a = 0; a < 3; a++) axisSorted[a].push(outXyz[i * 3 + a]);
  }
  axisSorted.forEach((arr) => arr.sort((x, y) => x - y));
  const lo = axisSorted.map((arr) => percentile(arr, 0.004));
  const hi = axisSorted.map((arr) => percentile(arr, 0.996));
  const pad = 1.0;

  const keep = new Uint8Array(points.count);
  let kept = 0;
  for (let i = 0; i < points.count; i++) {
    let ok = true;
    for (let a = 0; a < 3; a++) {
      const v = outXyz[i * 3 + a];
      if (v < lo[a] - pad || v > hi[a] + pad) { ok = false; break; }
    }
    if (ok) { keep[i] = 1; kept++; }
  }

  const finalCount = kept > 1000 ? kept : points.count;
  const finalXyz = new Float32Array(finalCount * 3);
  const finalRgb = new Uint8Array(finalCount * 3);
  let w = 0;
  for (let i = 0; i < points.count; i++) {
    if (kept > 1000 && !keep[i]) continue;
    finalXyz[w * 3] = outXyz[i * 3];
    finalXyz[w * 3 + 1] = outXyz[i * 3 + 1];
    finalXyz[w * 3 + 2] = outXyz[i * 3 + 2];
    finalRgb[w * 3] = points.rgb[i * 3];
    finalRgb[w * 3 + 1] = points.rgb[i * 3 + 1];
    finalRgb[w * 3 + 2] = points.rgb[i * 3 + 2];
    w++;
  }

  const { buffer, quantization } = encodePoints(finalXyz, finalRgb, finalCount);

  // ── Navigation ──────────────────────────────────────────────────────────
  const start = pickStart(poses, input.frameClip, input.frameOrder);
  const startPose = poses.get(start.frame)!;
  const startPos = apply(cameraCentre(startPose));
  const fwdRotated = rotate(cameraForward(startPose));
  const yaw = Math.atan2(fwdRotated[0], fwdRotated[2]);
  const fwdLen = Math.hypot(...fwdRotated) || 1;
  const pitch = Math.max(-0.4, Math.min(0.4, Math.asin(-fwdRotated[1] / fwdLen)));

  const bounds = {
    min: [lo[0] - pad, Math.min(-0.5, lo[1] - pad), lo[2] - pad] as [number, number, number],
    max: [hi[0] + pad, hi[1] + pad, hi[2] + pad] as [number, number, number],
  };

  // ── Capture paths ───────────────────────────────────────────────────────
  const clipEntries = input.clips.map((clip, i) => {
    const frames = [...poses.keys()]
      .filter((f) => input.frameClip.get(f) === clip.id)
      .sort((a, b) => (input.frameOrder.get(a) ?? 0) - (input.frameOrder.get(b) ?? 0));
    const path: number[] = [];
    for (const f of frames) {
      const c = apply(cameraCentre(poses.get(f)!));
      path.push(+c[0].toFixed(4), +c[1].toFixed(4), +c[2].toFixed(4));
    }
    return {
      id: clip.id,
      label: clip.label,
      color: CLIP_COLORS[i % CLIP_COLORS.length],
      registeredFrames: frames.length,
      totalFrames: clip.keptFrames,
      path,
    };
  });

  return {
    format: 2,
    id: input.id,
    label: input.label,
    generated: new Date().toISOString(),
    points: buffer,
    pointCount: finalCount,
    quantization,
    navigation: {
      eyeHeightM: config.viewer.eyeHeightM,
      floorY: 0,
      start: {
        position: [startPos[0], config.viewer.eyeHeightM, startPos[2]],
        yaw,
        pitch,
      },
      startSource: start.source,
      bounds,
    },
    transform: {
      metresPerUnit: scale,
      scaleSource,
      gravitySource,
    },
    clips: clipEntries,
    report: input.report,
  };
}
