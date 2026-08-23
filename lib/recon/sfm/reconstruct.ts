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
import { motionConsistent } from "./motionFilter";
import {
  maxTriangulationAngleDeg, ransacEssential, ransacHomography, reprojectionError,
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
  /** Median ray angle over inliers. */
  angleDeg: number;
  /** Inliers triangulating at a healthy angle — what decides if a pair can seed. */
  wellConditioned: number;
  /**
   * A homography explains this pair as well as the essential matrix does, so
   * the scene it saw was a plane or the camera only turned. The matches are
   * real and belong in the track graph; the POSE does not, and must never seed.
   */
  degenerate: boolean;
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
  // A starting guess only. 0.85x the long edge is about a 61-degree horizontal
  // field of view, which is where phone main cameras sit.
  //
  // The previous value of 1.2x came with a comment claiming it matched a 60-70
  // degree lens. It does not: 1.2x the long edge IS a 45-degree lens, roughly
  // 44% too long for a phone. That matters far more than a prior normally
  // would, because pair verification runs on the ESSENTIAL matrix, which needs
  // the focal to un-project points before it can test them. Feed it a focal
  // half again too long and the epipolar constraint is violated systematically,
  // RANSAC finds almost no inliers, and the capture is rejected as having no
  // overlap. Synthetic test footage hid this: noise-free frames yield so many
  // matches that enough survive even a badly wrong model.
  //
  // Measuring it from the footage does NOT work, and it is worth recording why:
  // scoring focal hypotheses by how many correspondences survive verification
  // just picks the smallest hypothesis every time. The RANSAC threshold is
  // carried in normalised units, so a shorter focal spreads the points and
  // loosens the test in step — the score measures leniency, not fit. Tested
  // directly, a 50%-wrong focal costs essentially no inliers on a translating
  // pair, so this prior is not what decides whether a capture verifies.
  // Bundle adjustment refines it later, where the residual is in pixels.
  let focal = 0.85 * Math.max(width, height);

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

  const matchPair = async (a: number, b: number, ratio: number): Promise<MatchPair[]> => {
    const fa = featureByIndex.get(a);
    const fb = featureByIndex.get(b);
    if (!fa || !fb || fa.count < 20 || fb.count < 20) return [];
    if (useGpu) {
      try {
        return await matchMutual(descriptorSet(fa), descriptorSet(fb), { ratio });
      } catch {
        useGpu = false;
      }
    }
    return matchMutualCpu(descriptorSet(fa), descriptorSet(fb), { ratio });
  };

  // Where pairs die, so a failure can name its own cause instead of blaming the
  // capture. Two different thresholds reject a pair and they mean opposite
  // things: too few raw matches is a features-and-overlap problem, too few
  // inliers after RANSAC is a geometry problem.
  const reject = { noFeatures: 0, fewMatches: 0, noModel: 0, fewInliers: 0 };
  const matchCounts: number[] = [];

  /**
   * Verify one pair at a given strictness.
   *
   * Split out because the whole set may need a second, gentler pass. Fixed
   * thresholds assume a capture much like the one they were tuned on; real
   * footage carries motion blur, rolling shutter and exposure swings that thin
   * matches everywhere at once, and a run that verifies almost nothing has
   * usually hit the threshold rather than run out of overlap.
   */
  const verifyPair = async (
    pair: { a: number; b: number; source: string },
    index: number,
    minMatches: number,
    minInliers: number,
    count: boolean,
    ratio = cfg.features.matchRatio,
    allowHomography = false,
  ): Promise<VerifiedPairInternal | null> => {
    const fa = featureByIndex.get(pair.a);
    const fb = featureByIndex.get(pair.b);
    if (!fa || !fb || fa.count < 20 || fb.count < 20) {
      if (count) reject.noFeatures++;
      return null;
    }

    const matches = await matchPair(pair.a, pair.b, ratio);
    if (count) matchCounts.push(matches.length);
    if (matches.length < minMatches) {
      if (count) reject.fewMatches++;
      return null;
    }

    const corr = toCorrespondences(fa, fb, matches, focal, cx, cy);
    const threshold = cfg.sfm.ransacThresholdPx / focal;

    // Order the matches so RANSAC looks for the model where the inliers are
    // dense. The key is the ratio-test margin, not the raw descriptor distance:
    // the mutual and ratio tests have already removed whatever distance alone
    // could separate, so the outliers that survive are repeated structure —
    // bolt rows, panels, railings, floor grating — whose distances are SMALL.
    // How well the best match beat its runner-up still discriminates there.
    const ranking = matches
      .map((m, k) => ({ k, score: m.second > 0 ? m.distance / m.second : m.distance / 256 }))
      .sort((x, y) => x.score - y.score)
      .map((r) => r.k);

    // Find the model on the matches that move like their neighbours, then score
    // EVERY match against it. The prefilter is a good hypothesis generator and
    // a bad inlier set: it discards plenty of true matches too, so using its
    // output directly would fail the support threshold on exactly the pairs it
    // just rescued.
    const consistent = motionConsistent(
      matches.map((m) => ({
        ax: fa.keypoints[m.queryIndex * 2], ay: fa.keypoints[m.queryIndex * 2 + 1],
        bx: fb.keypoints[m.trainIndex * 2], by: fb.keypoints[m.trainIndex * 2 + 1],
      })),
      Math.max(1, width), Math.max(1, height),
    );
    const geo = ransacEssential(corr, threshold, {
      confidence: cfg.sfm.ransacConfidence,
      maxIterations: cfg.sfm.ransacMaxIterations,
      seed: 0x51ed + index,
      ranking,
      hypothesisSubset: consistent ?? undefined,
    });

    // A pair the essential matrix cannot explain is not necessarily a bad pair.
    // The 8-point solution is DEGENERATE when the correspondences lie on a
    // plane or the camera only rotated, and both are ordinary in real footage:
    // a walk through an industrial area spends much of its time facing one flat
    // surface. Such a pair used to be discarded outright, taking its
    // correspondences out of the track graph with it.
    //
    // This is a LAST RESORT, enabled only by the lenient retry pass. A
    // homography has four degrees of freedom and will fit something to almost
    // anything, so it must never compete with a working essential matrix: on a
    // capture that reconstructs cleanly, letting it took registered frames from
    // 86 to 31 and sparse points from 4,735 to 674, because the correspondences
    // it substituted were wrong. It earns its place only where the alternative
    // is no reconstruction at all.
    const eCount = geo ? geo.inlierCount : 0;
    const essentialUsable = geo !== null && eCount >= minInliers;

    let inlierFlags: boolean[] | undefined = geo?.inliers;
    let kept = eCount;
    let degenerate = false;

    if (!essentialUsable && allowHomography) {
      const homography = ransacHomography(corr, threshold, {
        confidence: 0.999, maxIterations: 500, seed: 0x7b0d + index,
      });
      const hCount = homography ? homography.inlierCount : 0;
      // Demand it behave like a real plane: explaining most of what matched,
      // and clearly beating the essential matrix rather than merely tying it.
      if (homography && hCount >= minInliers &&
          hCount >= matches.length * 0.5 && hCount > eCount * 1.2) {
        inlierFlags = homography.inliers;
        kept = hCount;
        degenerate = true;
      }
    }

    if (!inlierFlags) {
      if (count) reject.noModel++;
      return null;
    }
    if (kept < minInliers) {
      if (count) reject.fewInliers++;
      return null;
    }

    const inlierMatches: Array<[number, number]> = [];
    for (let k = 0; k < matches.length; k++) {
      if (inlierFlags[k]) inlierMatches.push([matches[k].queryIndex, matches[k].trainIndex]);
    }
    return {
      a: pair.a, b: pair.b, source: pair.source as VerifiedPairInternal["source"],
      crossClip: clipOf.get(pair.a) !== clipOf.get(pair.b),
      matches: inlierMatches,
      // A degenerate pair has no trustworthy pose. It carries the essential
      // matrix's best guess so the type stays simple, and the seed filter below
      // refuses to start from it.
      pose: geo ? geo.pose : {
        R: new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]), t: [0, 0, 0],
      },
      angleDeg: geo ? geo.medianTriangulationAngleDeg : 0,
      wellConditioned: degenerate ? 0 : (geo ? geo.wellConditionedCount : 0),
      degenerate,
    };
  };

  const strictMatches = cfg.features.minPairInliers;
  const strictInliers = cfg.features.minPairInliers;

  for (let i = 0; i < proposed.length; i++) {
    checkAbort();
    const pair = proposed[i];
    const ok = await verifyPair(pair, i, strictMatches, strictInliers, true);
    if (ok) {
      verified.push(ok);
      if (ok.crossClip) crossClipPairs++;
    }

    if (i % 12 === 0) {
      report(
        0.02 + 0.45 * (i / proposed.length),
        `Verified ${verified.length} of ${i + 1} pairs · ${crossClipPairs} link clips`,
      );
    }
  }

  // Sequential pairs are consecutive frames of one walk: they overlap by
  // construction, so almost all of them should verify. When they do not, the
  // threshold is the likelier culprit, and a second gentler pass costs one more
  // matching sweep against losing the capture entirely. RANSAC still has to
  // find a consistent model — this lowers how much support that model needs,
  // it does not accept anything unverified.
  const sequentialCount = proposed.filter((p) => p.source === "sequential").length;
  const expected = Math.max(1, sequentialCount);
  let relaxed = false;
  if (verified.length < expected * 0.35 && strictInliers > 12) {
    relaxed = true;
    const gentleMatches = Math.max(12, Math.round(strictMatches * 0.55));
    const gentleInliers = Math.max(12, Math.round(strictInliers * 0.55));
    report(
      0.30,
      `Only ${verified.length} of ${proposed.length} pairs verified — retrying more leniently`,
    );
    const already = new Set(verified.map((v) => `${v.a}:${v.b}`));
    for (let i = 0; i < proposed.length; i++) {
      checkAbort();
      const pair = proposed[i];
      if (already.has(`${pair.a}:${pair.b}`)) continue;
      // Loosen the ratio test here too, and only here. Doing it globally buys a
      // few more matches everywhere at the cost of admitting ambiguous ones into
      // captures that were verifying perfectly well — measurably worse scale
      // consistency on a capture that never needed the help.
      // The homography rescue lives here and only here. Measured on a capture
      // that reconstructs cleanly, allowing it in the strict pass took
      // registered frames from 86 to 55 and sparse points from 4,735 to 1,546:
      // where the essential matrix legitimately rejects a pair, a homography
      // will still fit something, and what it fits is wrong. Confined to this
      // retry it cannot touch a capture that is already working, because the
      // retry only runs when the strict pass has already failed badly.
      const ok = await verifyPair(pair, i, gentleMatches, gentleInliers, false, 0.86, true);
      if (ok) {
        verified.push(ok);
        if (ok.crossClip) crossClipPairs++;
      }
      if (i % 12 === 0) {
        report(
          0.30 + 0.15 * (i / proposed.length),
          `Verified ${verified.length} of ${proposed.length} pairs · ${crossClipPairs} link clips`,
        );
      }
    }
  }

  matchCounts.sort((a, b) => a - b);
  const medianMatches = matchCounts.length
    ? matchCounts[Math.floor(matchCounts.length / 2)] : 0;
  const featureCounts = features.map((f) => f.count).sort((a, b) => a - b);
  const medianFeatures = featureCounts.length
    ? featureCounts[Math.floor(featureCounts.length / 2)] : 0;
  /** Everything a failure needs to say to be diagnosable rather than a guess. */
  const degenerateCount = verified.filter((v) => v.degenerate).length;
  const diagnostics =
    `${frames.length} frames, median ${medianFeatures} features each; ` +
    `${proposed.length} pairs proposed, ${verified.length} verified` +
    `${relaxed ? " (after a lenient retry)" : ""}` +
    `${degenerateCount ? `, of which ${degenerateCount} were planar or rotation-only` : ""}; ` +
    `median ${medianMatches} raw matches per pair; rejected ` +
    `${reject.fewMatches} for too few matches, ${reject.fewInliers} for too few ` +
    `inliers after RANSAC, ${reject.noModel} with no consistent model, ` +
    `${reject.noFeatures} for having no features`;

  if (verified.length === 0) {
    throw new Error(
      `No image pairs could be verified. ${diagnostics}. ` +
      (medianMatches < strictMatches
        ? "Matches are the bottleneck: the frames are not sharing enough recognisable " +
          "detail, which is blur, darkness, or moving too fast between frames."
        : "Matches were plentiful but no consistent camera motion fitted them, which " +
          "usually means repeated texture matching the wrong parts of the scene."),
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
  //
  // Score favours many inliers AND real parallax. A pair with 900 matches at
  // 0.3 degrees is worthless; one with 200 matches at 6 degrees is excellent.
  //
  // The parallax measure here is the UPPER quantile, not the median. Walking
  // forward through a space — which is how anyone films a room — most matches
  // are on whatever is straight ahead, and those rays barely diverge however
  // far you walk. Gating on the median therefore rejects almost every pair from
  // exactly the motion this feature exists to support, while the off-axis
  // points that would have seeded it perfectly well sit in the upper tail.
  //
  // The bar also has to be able to come down. A single tier means a capture
  // either clears it or gets told to re-record, and being handed one candidate
  // is indistinguishable from being handed none: there is nothing to retry with.
  const SEED_TIERS = [
    { wellConditioned: 60, inlierScale: 1.5 },
    { wellConditioned: 30, inlierScale: 1.2 },
    { wellConditioned: 15, inlierScale: 1.0 },
    { wellConditioned: 8, inlierScale: 1.0 },
  ];
  const scoreOf = (p: VerifiedPairInternal) =>
    p.wellConditioned * Math.log2(2 + p.matches.length);

  let seedCandidates: Array<{ pair: VerifiedPairInternal; score: number }> = [];
  let seedTier = SEED_TIERS[0];
  for (const tier of SEED_TIERS) {
    seedTier = tier;
    seedCandidates = verified
      .filter((p) =>
        !p.degenerate &&
        p.wellConditioned >= tier.wellConditioned &&
        p.matches.length >= cfg.features.minPairInliers * tier.inlierScale)
      .map((p) => ({ pair: p, score: scoreOf(p) }))
      .sort((x, y) => y.score - x.score);
    // Enough to actually retry with, not merely enough to try once.
    if (seedCandidates.length >= 4) break;
  }

  if (seedCandidates.length === 0) {
    const bestConditioned = verified.reduce((m, p) => Math.max(m, p.wellConditioned), 0);
    const bestInliers = verified.reduce((m, p) => Math.max(m, p.matches.length), 0);
    throw new Error(
      `No image pair had enough parallax to start a reconstruction. ` +
      `${diagnostics}. The best pair had ${bestInliers} matches, of which ` +
      `${bestConditioned} triangulated at a usable angle, against the ` +
      `${SEED_TIERS[SEED_TIERS.length - 1].wellConditioned} needed. This is what ` +
      `filming from one spot looks like — walk through the space instead of ` +
      `panning across it.`,
    );
  }

  const sharesBothFrames = (p: VerifiedPairInternal, used: Set<number>) =>
    used.has(p.a) && used.has(p.b);

  let poses = new Map<number, Pose>();
  const initialFocal = focal;
  /** The frame bundle adjustment pins so the solution cannot drift or rescale. */
  let gaugeFrame = -1;

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

  // ── 4. Grow ─────────────────────────────────────────────────────────────
  const totalFrames = frames.length;
  /** Lowest 2D-3D support we will still attempt a registration from. */
  const RELAXED_MIN_SUPPORT = 10;

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
    const gaugeIndex = poseIndex.get(gaugeFrame);
    if (gaugeIndex !== undefined) fixed.add(gaugeIndex);

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

  /**
   * Build a model outward from one seed pair, and report how many frames it
   * placed. Everything it touches — the pose map, each track's triangulated
   * position, the focal estimate — is reset first, so an attempt that goes
   * nowhere leaves nothing behind for the next one to trip over.
   */
  const growFrom = (seedPair: VerifiedPairInternal): number => {
  poses = new Map<number, Pose>();
  poses.set(seedPair.a, { R: new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]), t: [0, 0, 0] });
  poses.set(seedPair.b, seedPair.pose);
  gaugeFrame = seedPair.a;
  for (const track of tracks) track.xyz = null;
  focal = initialFocal;
  triangulatePending();

  const failed = new Set<number>();
  let sinceBa = 0;
  let minSupport = cfg.sfm.minPnpInliers;

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

    // Running out of confident candidates is not the end. A clip typically
    // joins the model through one or two hard-won cross-clip links, and the
    // frames hanging off those links start out with very little support — so
    // stopping at the first shortfall strands the rest of that clip outside the
    // reconstruction. Relax the bar instead, and only give up when even the
    // relaxed one finds nothing. Registration stays honest either way: PnP
    // still has to find a consistent pose, and bundle adjustment still has to
    // accept it.
    if (!best || best.count < minSupport) {
      if (minSupport > RELAXED_MIN_SUPPORT) {
        minSupport = Math.max(RELAXED_MIN_SUPPORT, Math.floor(minSupport / 2));
        // Frames rejected under the stricter bar deserve another look.
        failed.clear();
        continue;
      }
      break;
    }

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
      minInliers: Math.min(minSupport, cfg.sfm.minPnpInliers),
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

    return poses.size;
  };

  // A seed that scores well on inliers and parallax can still produce a
  // two-view model nothing grows from — a repeated texture matched across the
  // wrong pair, or a baseline that happens to lie along the viewing direction.
  // One seed is therefore not an answer about the capture, only about that
  // pair, so try several before concluding the footage cannot be reconstructed.
  //
  // Diversity is worth preferring but not worth enforcing. Requiring each
  // attempt to use two entirely unseen frames sounds like it spreads the
  // attempts out; on a capture that walks a route once, consecutive pairs
  // necessarily share frames, so it threw away nearly every candidate and left
  // the retry loop with one attempt — the same position as having no retry at
  // all. A candidate sharing ONE frame with an earlier attempt is still a
  // different starting pair, so it is only deprioritised.
  const SEED_ATTEMPTS = 8;
  const GOOD_ENOUGH = Math.max(3, Math.round(totalFrames * 0.6));
  const triedFrames = new Set<number>();
  let bestPoses = new Map<number, Pose>();
  let bestFocal = focal;
  let bestGauge = -1;
  let attempts = 0;

  for (const candidate of seedCandidates) {
    if (attempts >= SEED_ATTEMPTS) break;
    // Skip only a pair whose BOTH frames have already seeded an attempt — that
    // really is the same starting point. Sharing one frame is not.
    if (sharesBothFrames(candidate.pair, triedFrames)) continue;
    triedFrames.add(candidate.pair.a);
    triedFrames.add(candidate.pair.b);
    attempts++;

    const placed = growFrom(candidate.pair);
    if (placed > bestPoses.size) {
      bestPoses = poses;
      bestFocal = focal;
      bestGauge = gaugeFrame;
    }
    if (placed >= GOOD_ENOUGH) break;
    report(0.55, `Retrying from a different starting pair (${placed} of ${totalFrames} placed)`);
  }

  poses = bestPoses;
  focal = bestFocal;
  gaugeFrame = bestGauge;

  if (poses.size < 3) {
    const bestConditioned = verified.reduce((m, p) => Math.max(m, p.wellConditioned), 0);
    throw new Error(
      `None of the ${attempts} starting ${attempts === 1 ? "pair" : "pairs"} tried could ` +
      `be grown into a reconstruction. ${diagnostics}; ${seedCandidates.length} pairs were ` +
      `usable as a starting point (best had ${bestConditioned} well-triangulated points, ` +
      `threshold ${seedTier.wellConditioned}), ${tracks.length.toLocaleString()} feature ` +
      `tracks survived, and registration reached ${poses.size} ` +
      `${poses.size === 1 ? "frame" : "frames"} before stalling.`,
    );
  }

  // The winning attempt's points were overwritten by the attempts that followed
  // it, so rebuild them against the poses actually being kept.
  for (const track of tracks) track.xyz = null;
  triangulatePending();

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
    crossClipPairs,
    diagnostics,
  };
}

