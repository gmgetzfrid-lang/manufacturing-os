// Feature extraction, plus the sharpness and similarity measures that decide
// which frames are worth keeping.
//
// Two products per frame:
//   · ORB keypoints and 32-byte descriptors, which drive matching and geometry;
//   · a small global descriptor, which is how frames from DIFFERENT clips find
//     each other. Comparing every frame to every other frame is quadratic and
//     unaffordable, so a coarse gradient-orientation signature proposes a short
//     list of plausible revisits and only those get full descriptor matching.
//     Without this step the clips never link and the reconstruction splits into
//     one model per video — the exact failure this project exists to avoid.

import type { OpenCv } from "../opencv";
import { withScope } from "../opencv";
import type { FrameFeatures } from "../types";

export interface ExtractOptions {
  maxFeatures: number;
  scaleFactor: number;
  levels: number;
  fastThreshold: number;
}

/** Variance of the Laplacian — the standard blur proxy.
 *
 *  Used only relative to the clip's own median: the absolute value depends on
 *  lighting, texture and sensor, so a fixed threshold that works in one room
 *  rejects every frame in the next. */
export function sharpness(gray: Uint8Array, width: number, height: number): number {
  // Sub-sample: blur is a low-frequency property, so a quarter-resolution pass
  // gives the same ordering for a fraction of the work.
  const step = 2;
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let y = step; y < height - step; y += step) {
    const row = y * width;
    for (let x = step; x < width - step; x += step) {
      const i = row + x;
      // 4-neighbour Laplacian.
      const lap =
        gray[i - step] + gray[i + step] + gray[i - width * step] + gray[i + width * step] -
        4 * gray[i];
      sum += lap;
      sumSq += lap * lap;
      n++;
    }
  }
  if (n === 0) return 0;
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

const GLOBAL_GRID = 8;
const GLOBAL_BINS = 8;
export const GLOBAL_DESCRIPTOR_LENGTH = GLOBAL_GRID * GLOBAL_GRID * GLOBAL_BINS;

/**
 * Coarse image signature: an 8x8 grid of 8-bin gradient-orientation histograms,
 * L2-normalised per cell.
 *
 * Deliberately crude. It only has to rank "might be the same place" candidates
 * well enough that the real matcher gets a short list, and being gradient-based
 * rather than colour-based makes it tolerant of the exposure swings that happen
 * when a phone pans from a window to a wall.
 */
export function globalDescriptor(
  gray: Uint8Array, width: number, height: number,
): Float32Array {
  const out = new Float32Array(GLOBAL_DESCRIPTOR_LENGTH);
  const cellW = width / GLOBAL_GRID;
  const cellH = height / GLOBAL_GRID;

  for (let y = 1; y < height - 1; y++) {
    const cy = Math.min(GLOBAL_GRID - 1, (y / cellH) | 0);
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const gx = gray[i + 1] - gray[i - 1];
      const gy = gray[i + width] - gray[i - width];
      const mag = Math.hypot(gx, gy);
      if (mag < 8) continue; // ignore flat regions, which carry no information
      let angle = Math.atan2(gy, gx);
      if (angle < 0) angle += Math.PI; // orientation, not direction
      const bin = Math.min(GLOBAL_BINS - 1, ((angle / Math.PI) * GLOBAL_BINS) | 0);
      const cx = Math.min(GLOBAL_GRID - 1, (x / cellW) | 0);
      out[(cy * GLOBAL_GRID + cx) * GLOBAL_BINS + bin] += mag;
    }
  }

  // Per-cell normalisation keeps a bright, high-contrast corner of the image
  // from dominating the whole signature.
  for (let c = 0; c < GLOBAL_GRID * GLOBAL_GRID; c++) {
    let norm = 0;
    for (let b = 0; b < GLOBAL_BINS; b++) {
      const v = out[c * GLOBAL_BINS + b];
      norm += v * v;
    }
    norm = Math.sqrt(norm);
    if (norm > 1e-6) {
      for (let b = 0; b < GLOBAL_BINS; b++) out[c * GLOBAL_BINS + b] /= norm;
    }
  }
  return out;
}

/** Cosine similarity of two global descriptors, in [0, 1]. */
export function globalSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 1e-9 ? dot / denom : 0;
}

/**
 * Median displacement of ORB keypoints between two frames, in pixels.
 *
 * Used to drop frames where the camera did not really move — those add matching
 * cost and no parallax. Cheap because it reuses descriptors already computed.
 */
export function medianDisplacement(
  a: FrameFeatures, b: FrameFeatures, sampleLimit = 250,
): number {
  const n = Math.min(a.count, b.count, sampleLimit);
  if (n < 8) return Number.POSITIVE_INFINITY;

  const popcount = (x: number): number => {
    x = x - ((x >>> 1) & 0x55555555);
    x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
    return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
  };

  const displacements: number[] = [];
  const strideA = Math.max(1, Math.floor(a.count / n));
  for (let i = 0; i < a.count; i += strideA) {
    let best = Infinity;
    let bestJ = -1;
    for (let j = 0; j < b.count; j++) {
      let dist = 0;
      for (let w = 0; w < 8; w++) {
        const av =
          a.descriptors[i * 32 + w * 4] | (a.descriptors[i * 32 + w * 4 + 1] << 8) |
          (a.descriptors[i * 32 + w * 4 + 2] << 16) | (a.descriptors[i * 32 + w * 4 + 3] << 24);
        const bv =
          b.descriptors[j * 32 + w * 4] | (b.descriptors[j * 32 + w * 4 + 1] << 8) |
          (b.descriptors[j * 32 + w * 4 + 2] << 16) | (b.descriptors[j * 32 + w * 4 + 3] << 24);
        dist += popcount(av ^ bv);
        if (dist >= best) break;
      }
      if (dist < best) { best = dist; bestJ = j; }
    }
    if (bestJ >= 0 && best < 64) {
      displacements.push(
        Math.hypot(
          a.keypoints[i * 2] - b.keypoints[bestJ * 2],
          a.keypoints[i * 2 + 1] - b.keypoints[bestJ * 2 + 1],
        ),
      );
    }
  }
  if (displacements.length < 6) return Number.POSITIVE_INFINITY;
  displacements.sort((x, y) => x - y);
  return displacements[Math.floor(displacements.length / 2)];
}

/** Detect ORB keypoints and descriptors on one greyscale frame. */
export function extractFeatures(
  cv: OpenCv,
  frameIndex: number,
  gray: Uint8Array,
  width: number,
  height: number,
  options: ExtractOptions,
): FrameFeatures {
  return withScope((track) => {
    const mat = track(new cv.Mat(height, width, cv.CV_8UC1));
    mat.data.set(gray);

    const orb = track(
      new cv.ORB(
        options.maxFeatures,
        options.scaleFactor,
        options.levels,
        31,   // edgeThreshold
        0,    // firstLevel
        2,    // WTA_K — 2 keeps descriptors compatible with Hamming distance
        cv.ORB_HARRIS_SCORE,
        31,   // patchSize
        options.fastThreshold,
      ),
    );

    const keypoints = track(new cv.KeyPointVector());
    const descriptors = track(new cv.Mat());
    const emptyMask = track(new cv.Mat());
    orb.detectAndCompute(mat, emptyMask, keypoints, descriptors);

    const count = keypoints.size();
    const kp = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) {
      const k = keypoints.get(i);
      kp[i * 2] = k.pt.x;
      kp[i * 2 + 1] = k.pt.y;
    }

    // descriptors.data is a view into WASM memory; copy before anything frees it.
    const descriptorBytes = descriptors.cols || 32;
    const desc = new Uint8Array(count * descriptorBytes);
    if (count > 0 && descriptors.rows === count) {
      desc.set(descriptors.data.subarray(0, count * descriptorBytes));
    }

    return {
      frameIndex,
      count,
      keypoints: kp,
      descriptors: desc,
      descriptorBytes,
      globalDescriptor: globalDescriptor(gray, width, height),
    };
  });
}
