// Incremental Structure from Motion — five clips in, one coherent map out.
//
// The pipeline is the classical one, and the ordering matters:
//
//   propose pairs  → sequential neighbours inside each clip, PLUS retrieval
//                    candidates across clips. The cross-clip pairs are the
//                    whole ball game: without them each video reconstructs
//                    into its own little world and the hallway never joins
//                    the living room.
//   match + verify → GPU Hamming matching, then a RANSAC essential matrix to
//                    throw away pairs whose "matches" are not consistent with
//                    any camera motion.
//   build tracks   → union-find over surviving matches, so one physical corner
//                    seen in nine frames becomes one 3D point, not nine.
//   seed           → the pair with the most inliers at a healthy triangulation
//                    angle. Forward-walking video is full of pairs with lots of
//                    matches and almost no baseline, which triangulate into
//                    noise; the angle test is what rejects them.
//   grow           → register the frame with the most known 3D points by PnP,
//                    triangulate what that unlocks, and bundle-adjust locally
//                    every few frames so error does not compound.
//   global BA      → one final joint optimisation, refining the shared focal
//                    length along with every pose and point.
//
// Finally the pose graph is split into connected components. More than one
// component means the clips did NOT fuse, and the caller must say so rather
// than presenting a broken scene as a room.

import { DEFAULT_RECON_CONFIG, type ReconConfig } from "../config";
import { matchMutual, matchMutualCpu, type DescriptorSet, type MatchPair } from "../gpu/matcher";
import type { FrameFeatures, SfmResult } from "../types";
import { bundleAdjust, type BundleObservation } from "../math/bundle";
import { pnpRansac } from "../math/pnp";
import {
  maxTriangulationAngleDeg, ransacEssential, reprojectionError,
  triangulateMultiView, type Correspondence, type Pose,
} from "../math/twoView";
import { globalSimilarity } from "./features";

export interface FrameMeta {
  index: number;
  clipId: string;
  clipIndex: number;
  orderInClip: number;
  width: number;
  height: number;
}

export interface ReconstructOptions {
  config?: ReconConfig;
  signal?: AbortSignal;
  onProgress?: (progress: number, detail: string) => void;
  /** Force the CPU matcher (used when WebGPU matching is unavailable). */
  forceCpuMatching?: boolean;
}

interface ProposedPair {
  a: number;
  b: number;
  source: "sequential" | "loop";
}

interface VerifiedPairInternal {
  a: number;
  b: number;
  source: "sequential" | "loop";
  crossClip: boolean;
  /** Inlier correspondences as (keypointA, keypointB). */
  matches: Array<[number, number]>;
  pose: Pose;
  angleDeg: number;
}

class UnionFind {
  private parent = new Map<number, number>();

  find(x: number): number {
    if (!this.parent.has(x)) {
      this.parent.set(x, x);
      return x;
    }
    // Walk to the root, then flatten the path so later lookups are O(1).
    let root = x;
    for (;;) {
      const parent = this.parent.get(root) ?? root;
      if (parent === root) break;
      root = parent;
    }
    let cursor = x;
    while (cursor !== root) {
      const next = this.parent.get(cursor) ?? root;
      this.parent.set(cursor, root);
      cursor = next;
    }
    return root;
  }

  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }

  keys(): IterableIterator<number> {
    return this.parent.keys();
  }
}

/** Pack (frame, keypoint) into one integer key for the union-find. */
const KEY_STRIDE = 1 << 16;
const packKey = (frame: number, kp: number) => frame * KEY_STRIDE + kp;
const unpackFrame = (key: number) => Math.floor(key / KEY_STRIDE);
const unpackKp = (key: number) => key % KEY_STRIDE;

interface Track {
  /** frameIndex → keypoint index. */
  views: Map<number, number>;
  xyz: [number, number, number] | null;
  rgb: [number, number, number];
}

function proposePairs(
  frames: FrameMeta[], features: FrameFeatures[], cfg: ReconConfig,
): ProposedPair[] {
  const pairs: ProposedPair[] = [];
  const seen = new Set<number>();
  const add = (a: number, b: number, source: "sequential" | "loop") => {
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    if (lo === hi) return;
    const key = lo * KEY_STRIDE * 4 + hi;
    if (seen.has(key)) return;
    seen.add(key);
    pairs.push({ a: lo, b: hi, source });
  };

  // ── Sequential, inside each clip ────────────────────────────────────────
  const byClip = new Map<string, FrameMeta[]>();
  for (const f of frames) {
    const list = byClip.get(f.clipId);
    if (list) list.push(f);
    else byClip.set(f.clipId, [f]);
  }
  for (const list of byClip.values()) {
    list.sort((x, y) => x.orderInClip - y.orderInClip);
    for (let i = 0; i < list.length; i++) {
      for (let d = 1; d <= cfg.features.sequentialWindow && i + d < list.length; d++) {
        add(list[i].index, list[i + d].index, "sequential");
      }
      // Quadratic spacing catches the walker doubling back within one clip
      // without paying for an all-pairs comparison.
      for (let step = cfg.features.sequentialWindow; step < list.length; step *= 2) {
        if (i + step < list.length) add(list[i].index, list[i + step].index, "sequential");
      }
    }
  }

  // ── Retrieval, across clips ─────────────────────────────────────────────
  // Each frame proposes its most similar frames by global descriptor. Frames
  // from OTHER clips are boosted, because those are the links that fuse the
  // capture into one scene and they are rarer than same-clip revisits.
  const byIndex = new Map<number, FrameFeatures>();
  for (const f of features) byIndex.set(f.frameIndex, f);

  const clipCount = byClip.size;
  for (const frame of frames) {
    const self = byIndex.get(frame.index);
    if (!self) continue;

    // Same-clip and cross-clip candidates are ranked SEPARATELY, and the
    // cross-clip list gets a guaranteed share of the budget. Ranking them
    // together looks tidier but is a trap: a frame's most similar images are
    // almost always others from its own clip, so they win every slot and the
    // clips never get compared to each other at all — which is precisely the
    // failure this project has to avoid.
    const sameClip: Array<{ index: number; score: number }> = [];
    const otherClip: Array<{ index: number; score: number }> = [];

    for (const other of frames) {
      if (other.index === frame.index) continue;
      const isSame = other.clipId === frame.clipId;
      // Skip near neighbours in the same clip; sequential matching has them.
      if (isSame && Math.abs(other.orderInClip - frame.orderInClip) <= cfg.features.sequentialWindow) {
        continue;
      }
      const of = byIndex.get(other.index);
      if (!of) continue;
      const sim = globalSimilarity(self.globalDescriptor, of.globalDescriptor);
      (isSame ? sameClip : otherClip).push({ index: other.index, score: sim });
    }

    sameClip.sort((x, y) => y.score - x.score);
    otherClip.sort((x, y) => y.score - x.score);

    const budget = cfg.features.loopCandidates;
    // With only one clip there is nothing to link, so spend it all internally.
    const crossBudget = clipCount > 1 ? Math.max(2, Math.ceil(budget * 0.6)) : 0;
    const selfBudget = budget - crossBudget;

    for (let i = 0; i < Math.min(crossBudget, otherClip.length); i++) {
      add(frame.index, otherClip[i].index, "loop");
    }
    for (let i = 0; i < Math.min(selfBudget, sameClip.length); i++) {
      add(frame.index, sameClip[i].index, "loop");
    }
  }

  return pairs;
}

function toCorrespondences(
  fa: FrameFeatures, fb: FrameFeatures, matches: MatchPair[],
  focal: number, cx: number, cy: number,
): Correspondence[] {
  return matches.map((m) => ({
    x1: (fa.keypoints[m.queryIndex * 2] - cx) / focal,
    y1: (fa.keypoints[m.queryIndex * 2 + 1] - cy) / focal,
    x2: (fb.keypoints[m.trainIndex * 2] - cx) / focal,
    y2: (fb.keypoints[m.trainIndex * 2 + 1] - cy) / focal,
  }));
}

/** Connected components over the verified pose graph, restricted to registered frames. */
function connectedComponents(
  registered: Set<number>, pairs: VerifiedPairInternal[], minInliers: number,
): number[][] {
  const adjacency = new Map<number, number[]>();
  for (const f of registered) adjacency.set(f, []);
  for (const p of pairs) {
    if (p.matches.length < minInliers) continue;
    if (!registered.has(p.a) || !registered.has(p.b)) continue;
    adjacency.get(p.a)!.push(p.b);
    adjacency.get(p.b)!.push(p.a);
  }

  const seen = new Set<number>();
  const components: number[][] = [];
  for (const start of registered) {
    if (seen.has(start)) continue;
    const stack = [start];
    const comp: number[] = [];
    seen.add(start);
    while (stack.length) {
      const cur = stack.pop()!;
      comp.push(cur);
      for (const next of adjacency.get(cur) ?? []) {
        if (!seen.has(next)) { seen.add(next); stack.push(next); }
      }
    }
    components.push(comp.sort((a, b) => a - b));
  }
  components.sort((a, b) => b.length - a.length);
  return components;
}

export async function reconstruct(
  frames: FrameMeta[],
  features: FrameFeatures[],
  colorSampler: (frameIndex: number, x: number, y: number) => [number, number, number],
  options: ReconstructOptions = {},
): Promise<SfmResult> {
  const cfg = options.config ?? DEFAULT_RECON_CONFIG;
  const report = options.onProgress ?? (() => {});
  const checkAbort = () => {
    if (options.signal?.aborted) throw new Error("Reconstruction cancelled.");
  };

  if (frames.length < 4) {
    throw new Error("Not enough usable frames to reconstruct — at least 4 are needed.");
  }

  const width = frames[0].width;
  const height = frames[0].height;
  const cx = width / 2;
  const cy = height / 2;
  // Phone cameras cluster around a 60-70 degree horizontal field of view, which
  // puts the focal length near 1.2x the long edge. Bundle adjustment refines it.
  let focal = 1.2 * Math.max(width, height);

  const featureByIndex = new Map<number, FrameFeatures>();
  for (const f of features) featureByIndex.set(f.frameIndex, f);

  // ── 1. Propose and verify pairs ─────────────────────────────────────────
  const proposed = proposePairs(frames, features, cfg);
  report(0.02, `${proposed.length} image pairs to check`);

  const clipOf = new Map<number, string>();
  for (const f of frames) clipOf.set(f.index, f.clipId);

  const verified: VerifiedPairInternal[] = [];
  let crossClipPairs = 0;
  let useGpu = !options.forceCpuMatching;

  const descriptorSet = (f: FrameFeatures): DescriptorSet => ({
    data: f.descriptors, count: f.count,
  });

  for (let i = 0; i < proposed.length; i++) {
    checkAbort();
    const pair = proposed[i];
    const fa = featureByIndex.get(pair.a);
    const fb = featureByIndex.get(pair.b);
    if (!fa || !fb || fa.count < 20 || fb.count < 20) continue;

    let matches: MatchPair[];
    if (useGpu) {
      try {
        matches = await matchMutual(descriptorSet(fa), descriptorSet(fb), {
          ratio: cfg.features.matchRatio,
        });
      } catch {
        // One GPU failure is enough to distrust it for the rest of the run.
        useGpu = false;
        report(i / proposed.length, "GPU matching unavailable — using CPU");
        matches = matchMutualCpu(descriptorSet(fa), descriptorSet(fb), {
          ratio: cfg.features.matchRatio,
        });
      }
    } else {
      matches = matchMutualCpu(descriptorSet(fa), descriptorSet(fb), {
        ratio: cfg.features.matchRatio,
      });
    }

    if (matches.length < cfg.features.minPairInliers) continue;

    const corr = toCorrespondences(fa, fb, matches, focal, cx, cy);
    const geo = ransacEssential(corr, cfg.sfm.ransacThresholdPx / focal, {
      confidence: cfg.sfm.ransacConfidence,
      maxIterations: 700,
      seed: 0x51ed + i,
    });
    if (!geo || geo.inlierCount < cfg.features.minPairInliers) continue;

    const inlierMatches: Array<[number, number]> = [];
    for (let k = 0; k < matches.length; k++) {
      if (geo.inliers[k]) inlierMatches.push([matches[k].queryIndex, matches[k].trainIndex]);
    }

    const crossClip = clipOf.get(pair.a) !== clipOf.get(pair.b);
    if (crossClip) crossClipPairs++;

    verified.push({
      a: pair.a, b: pair.b, source: pair.source, crossClip,
      matches: inlierMatches, pose: geo.pose,
      angleDeg: geo.medianTriangulationAngleDeg,
    });

    if (i % 12 === 0) {
      report(
        0.02 + 0.45 * (i / proposed.length),
        `Verified ${verified.length} of ${i + 1} pairs · ${crossClipPairs} link clips`,
      );
    }
  }

  if (verified.length === 0) {
    throw new Error(
      "No image pairs could be verified. The clips probably do not overlap enough, " +
      "or the footage is too blurry or too dark for features to match.",
    );
  }
  report(0.48, `${verified.length} verified pairs · ${crossClipPairs} link different clips`);

  // ── 2. Build tracks ─────────────────────────────────────────────────────
  const uf = new UnionFind();
  for (const pair of verified) {
    for (const [ka, kb] of pair.matches) {
      uf.union(packKey(pair.a, ka), packKey(pair.b, kb));
    }
  }

  const grouped = new Map<number, number[]>();
  for (const key of uf.keys()) {
    const root = uf.find(key);
    const list = grouped.get(root);
    if (list) list.push(key);
    else grouped.set(root, [key]);
  }

  const tracks: Track[] = [];
  // trackIndex lookup by (frame, keypoint)
  const trackOf = new Map<number, number>();
  for (const members of grouped.values()) {
    if (members.length < 2) continue;
    const views = new Map<number, number>();
    let conflicted = false;
    for (const key of members) {
      const frame = unpackFrame(key);
      if (views.has(frame)) {
        // The same physical point cannot be two keypoints in one image; a track
        // that claims otherwise was merged through a bad match.
        conflicted = true;
        break;
      }
      views.set(frame, unpackKp(key));
    }
    if (conflicted || views.size < 2) continue;

    const first = members[0];
    const fFrame = unpackFrame(first);
    const fKp = unpackKp(first);
    const feat = featureByIndex.get(fFrame);
    const rgb: [number, number, number] = feat
      ? colorSampler(fFrame, feat.keypoints[fKp * 2], feat.keypoints[fKp * 2 + 1])
      : [180, 180, 180];

    const trackIndex = tracks.length;
    tracks.push({ views, xyz: null, rgb });
    for (const [frame, kp] of views) trackOf.set(packKey(frame, kp), trackIndex);
  }

  report(0.52, `${tracks.length.toLocaleString()} feature tracks`);
  if (tracks.length < 40) {
    throw new Error(
      `Only ${tracks.length} feature tracks survived. The clips do not share enough ` +
      `visible detail — try recording more slowly with more overlap.`,
    );
  }

  // Which tracks does each frame see?
  const tracksByFrame = new Map<number, number[]>();
  tracks.forEach((track, ti) => {
    for (const frame of track.views.keys()) {
      const list = tracksByFrame.get(frame);
      if (list) list.push(ti);
      else tracksByFrame.set(frame, [ti]);
    }
  });

  // ── 3. Seed the reconstruction ──────────────────────────────────────────
  // Score favours many inliers AND real parallax. A pair with 900 matches at
  // 0.3 degrees is worthless; one with 200 matches at 6 degrees is excellent.
  const seedCandidates = verified
    .filter((p) => p.angleDeg >= 2.0 && p.matches.length >= cfg.features.minPairInliers * 1.5)
    .map((p) => ({ pair: p, score: p.matches.length * Math.min(p.angleDeg, 12) }))
    .sort((x, y) => y.score - x.score);

  if (seedCandidates.length === 0) {
    throw new Error(
      "No image pair had enough parallax to start a reconstruction. This happens when " +
      "the camera only rotated instead of moving — walk through the space rather than " +
      "panning from one spot.",
    );
  }

  const seed = seedCandidates[0].pair;
  const poses = new Map<number, Pose>();
  poses.set(seed.a, { R: new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]), t: [0, 0, 0] });
  poses.set(seed.b, seed.pose);

  const observationOf = (frameIndex: number, kp: number): { x: number; y: number } | null => {
    const f = featureByIndex.get(frameIndex);
    if (!f || kp >= f.count) return null;
    return {
      x: (f.keypoints[kp * 2] - cx) / focal,
      y: (f.keypoints[kp * 2 + 1] - cy) / focal,
    };
  };

  /** Triangulate every track that now has >= 2 registered views. */
  const triangulatePending = (): number => {
    let created = 0;
    for (let ti = 0; ti < tracks.length; ti++) {
      const track = tracks[ti];
      if (track.xyz) continue;
      const obs: Array<{ pose: Pose; x: number; y: number }> = [];
      for (const [frame, kp] of track.views) {
        const pose = poses.get(frame);
        if (!pose) continue;
        const o = observationOf(frame, kp);
        if (o) obs.push({ pose, x: o.x, y: o.y });
      }
      if (obs.length < 2) continue;

      const X = triangulateMultiView(obs);
      if (!X) continue;
      if (maxTriangulationAngleDeg(obs, X) < cfg.sfm.minTriangulationAngleDeg) continue;

      // Must be in front of, and at a sane distance from, every camera that saw it.
      let ok = true;
      for (const o of obs) {
        const err = reprojectionError(o.pose, X, o.x, o.y) * focal;
        if (!Number.isFinite(err) || err > cfg.sfm.maxReprojectionErrorPx) { ok = false; break; }
      }
      if (!ok) continue;

      track.xyz = X;
      created++;
    }
    return created;
  };

  triangulatePending();

  // ── 4. Grow ─────────────────────────────────────────────────────────────
  const failed = new Set<number>();
  let sinceBa = 0;
  const totalFrames = frames.length;

  const runBundle = (window: number | null) => {
    const registeredList = [...poses.keys()].sort((a, b) => a - b);
    const active = window === null
      ? registeredList
      : registeredList.slice(Math.max(0, registeredList.length - window));
    const activeSet = new Set(active);

    const poseIndex = new Map<number, number>();
    const poseList: Pose[] = [];
    for (const frame of registeredList) {
      poseIndex.set(frame, poseList.length);
      poseList.push(poses.get(frame)!);
    }

    const pointIndex = new Map<number, number>();
    const pointList: Array<[number, number, number]> = [];
    const observations: BundleObservation[] = [];

    for (let ti = 0; ti < tracks.length; ti++) {
      const track = tracks[ti];
      if (!track.xyz) continue;
      let touchesActive = false;
      const rows: BundleObservation[] = [];
      for (const [frame, kp] of track.views) {
        const pi = poseIndex.get(frame);
        if (pi === undefined) continue;
        const f = featureByIndex.get(frame);
        if (!f || kp >= f.count) continue;
        if (activeSet.has(frame)) touchesActive = true;
        rows.push({
          cameraIndex: pi,
          pointIndex: -1, // filled below
          u: f.keypoints[kp * 2] - cx,
          v: f.keypoints[kp * 2 + 1] - cy,
        });
      }
      if (rows.length < 2 || !touchesActive) continue;
      const idx = pointList.length;
      pointIndex.set(ti, idx);
      pointList.push(track.xyz);
      for (const r of rows) observations.push({ ...r, pointIndex: idx });
    }

    if (pointList.length < 12 || observations.length < 40) return null;

    const fixed = new Set<number>();
    for (const frame of registeredList) {
      if (!activeSet.has(frame)) fixed.add(poseIndex.get(frame)!);
    }
    // Gauge freedom: pin the seed frame so the solution cannot drift or rescale.
    fixed.add(poseIndex.get(seed.a)!);

    const result = bundleAdjust(
      {
        poses: poseList,
        points: pointList,
        observations,
        focal,
        fixedCameras: fixed,
        refineFocal: window === null,
      },
      {
        iterations: window === null ? cfg.sfm.globalBaIterations : cfg.sfm.localBaIterations,
        huberPx: 3.0,
      },
    );

    for (const [frame, pi] of poseIndex) poses.set(frame, result.poses[pi]);
    for (const [ti, pi] of pointIndex) tracks[ti].xyz = result.points[pi];
    if (window === null) focal = result.focal;
    return result;
  };

  for (let step = 0; step < totalFrames * 2; step++) {
    checkAbort();
    if (poses.size >= totalFrames) break;

    // Which unregistered frame sees the most already-triangulated points?
    let best: { frame: number; count: number } | null = null;
    for (const frame of frames) {
      if (poses.has(frame.index) || failed.has(frame.index)) continue;
      let count = 0;
      for (const ti of tracksByFrame.get(frame.index) ?? []) {
        if (tracks[ti].xyz) count++;
      }
      if (!best || count > best.count) best = { frame: frame.index, count };
    }
    if (!best || best.count < cfg.sfm.minPnpInliers) break;

    const frameIndex = best.frame;
    const corr = [];
    for (const ti of tracksByFrame.get(frameIndex) ?? []) {
      const track = tracks[ti];
      if (!track.xyz) continue;
      const kp = track.views.get(frameIndex);
      if (kp === undefined) continue;
      const o = observationOf(frameIndex, kp);
      if (!o) continue;
      corr.push({ X: track.xyz, x: o.x, y: o.y });
    }

    // A neighbouring frame from the same clip is a strong starting guess.
    const meta = frames.find((f) => f.index === frameIndex)!;
    let initial: Pose | undefined;
    let bestGap = Infinity;
    for (const other of frames) {
      if (other.clipId !== meta.clipId) continue;
      const pose = poses.get(other.index);
      if (!pose) continue;
      const gap = Math.abs(other.orderInClip - meta.orderInClip);
      if (gap < bestGap) { bestGap = gap; initial = pose; }
    }

    const solved = pnpRansac(corr, cfg.sfm.ransacThresholdPx / focal, {
      seed: 0x7f4a + frameIndex,
      minInliers: cfg.sfm.minPnpInliers,
      initial: bestGap <= 3 ? initial : undefined,
      focal,
    });

    if (!solved) {
      failed.add(frameIndex);
      continue;
    }

    poses.set(frameIndex, solved.pose);
    triangulatePending();
    sinceBa++;

    if (sinceBa >= cfg.sfm.localBaEvery) {
      runBundle(cfg.sfm.localBaWindow);
      sinceBa = 0;
    }

    report(
      0.55 + 0.3 * (poses.size / totalFrames),
      `Registered ${poses.size} of ${totalFrames} frames`,
    );
  }

  if (poses.size < 3) {
    throw new Error(
      "Only a couple of frames could be positioned. The capture does not have enough " +
      "consistent overlap to reconstruct.",
    );
  }

  // ── 5. Global refinement ────────────────────────────────────────────────
  report(0.88, `Refining ${poses.size} cameras`);
  const finalBa = runBundle(null);
  triangulatePending();

  // ── 6. Filter and package ───────────────────────────────────────────────
  const points: SfmResult["points"] = [];
  for (const track of tracks) {
    if (!track.xyz) continue;
    const obs: Array<{ pose: Pose; x: number; y: number }> = [];
    const views: number[] = [];
    let worst = 0;
    for (const [frame, kp] of track.views) {
      const pose = poses.get(frame);
      if (!pose) continue;
      const o = observationOf(frame, kp);
      if (!o) continue;
      const err = reprojectionError(pose, track.xyz, o.x, o.y) * focal;
      if (!Number.isFinite(err)) { worst = Infinity; break; }
      worst = Math.max(worst, err);
      obs.push({ pose, x: o.x, y: o.y });
      views.push(frame);
    }
    if (obs.length < 2 || worst > cfg.sfm.maxReprojectionErrorPx * 1.6) continue;
    if (maxTriangulationAngleDeg(obs, track.xyz) < cfg.sfm.minTriangulationAngleDeg) continue;
    points.push({ xyz: track.xyz, rgb: track.rgb, views });
  }

  const registered = new Set(poses.keys());
  const components = connectedComponents(registered, verified, cfg.features.minPairInliers);

  report(0.98, `${points.length.toLocaleString()} sparse points`);

  return {
    poses,
    points,
    focal,
    principal: [cx, cy],
    registeredFrames: [...registered].sort((a, b) => a - b),
    rmsePx: finalBa?.finalRmsePx ?? 0,
    failedFrames: frames.map((f) => f.index).filter((i) => !registered.has(i)),
    components,
  };
}

/** Cross-clip verified pairs, for reporting whether the capture actually fused. */
export function countCrossClipLinks(
  result: SfmResult, frames: FrameMeta[],
): number {
  const clipOf = new Map<number, string>();
  for (const f of frames) clipOf.set(f.index, f.clipId);
  let count = 0;
  const registered = new Set(result.registeredFrames);
  for (const comp of result.components) {
    const clips = new Set<string>();
    for (const f of comp) if (registered.has(f)) clips.add(clipOf.get(f) ?? "");
    if (clips.size > 1) count += clips.size;
  }
  return count;
}
