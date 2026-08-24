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
import {
  matchMutual, matchMutualCpu,
  type DescriptorSet, type MatchPair, type MatchStageStats,
} from "../gpu/matcher";
import type { FrameFeatures, SfmResult } from "../types";
import { bundleAdjust, type BundleObservation } from "../math/bundle";
import { mat3Mul, mat3MulVec, mat3Transpose } from "../math/linalg";
import { pnpRansac, refinePose, solveRelativeScale, type PnpCorrespondence } from "../math/pnp";
import { guidedMatches } from "./guidedMatch";
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
  const orderOf = new Map<number, number>();
  for (const f of frames) {
    clipOf.set(f.index, f.clipId);
    orderOf.set(f.index, f.orderInClip);
  }

  const verified: VerifiedPairInternal[] = [];
  let crossClipPairs = 0;
  let useGpu = !options.forceCpuMatching;

  const descriptorSet = (f: FrameFeatures): DescriptorSet => ({
    data: f.descriptors, count: f.count,
  });

  // Where candidate matches die, across the strict pass only — mixing the
  // lenient retry in would blur what the numbers mean.
  const matchStats: MatchStageStats = {
    candidates: 0, overDistance: 0, failedRatio: 0, failedMutual: 0, kept: 0,
  };
  /** Raw match counts for ADJACENT same-clip pairs — the capture's backbone. */
  const adjacentMatchCounts: number[] = [];

  const matchPair = async (
    a: number, b: number, ratio: number,
    maxDistance?: number, stats?: MatchStageStats,
  ): Promise<MatchPair[]> => {
    const fa = featureByIndex.get(a);
    const fb = featureByIndex.get(b);
    if (!fa || !fb || fa.count < 20 || fb.count < 20) return [];
    if (useGpu) {
      try {
        return await matchMutual(descriptorSet(fa), descriptorSet(fb), {
          ratio, maxDistance, stats,
        });
      } catch {
        useGpu = false;
      }
    }
    return matchMutualCpu(descriptorSet(fa), descriptorSet(fb), { ratio, maxDistance, stats });
  };

  // Where pairs die, so a failure can name its own cause instead of blaming the
  // capture. Two different thresholds reject a pair and they mean opposite
  // things: too few raw matches is a features-and-overlap problem, too few
  // inliers after RANSAC is a geometry problem.
  const reject = { noFeatures: 0, fewMatches: 0, noModel: 0, fewInliers: 0 };
  /** Last outcome per pair, so a failure can name exactly where a chain broke. */
  const pairOutcome = new Map<string, string>();
  const pairKey = (a: number, b: number) => (a < b ? `${a}:${b}` : `${b}:${a}`);
  /** Where the winning attempt's chain broke; set after growth, for diagnostics. */
  let chainNote = "";
  /** Pairs whose support was recovered by re-matching along epipolar lines. */
  let guidedRescues = 0;
  /** Frames registered by composing a pair pose when PnP could not place them. */
  let compositionRescues = 0;
  /** Where composition bridges die, so a stall names its own cause. */
  const composeStats = { bridges: 0, fewAnchors: 0, scaleVote: 0, scaleFlat: 0, strictGate: 0 };
  /** Frames registered by re-running PnP against the globally refined model. */
  let lateRescues = 0;
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
    maxDistance?: number,
  ): Promise<VerifiedPairInternal | null> => {
    const fa = featureByIndex.get(pair.a);
    const fb = featureByIndex.get(pair.b);
    if (!fa || !fb || fa.count < 20 || fb.count < 20) {
      if (count) reject.noFeatures++;
      pairOutcome.set(pairKey(pair.a, pair.b), "a frame had almost no features");
      return null;
    }

    const matches = await matchPair(
      pair.a, pair.b, ratio, maxDistance, count ? matchStats : undefined,
    );
    if (count) {
      matchCounts.push(matches.length);
      const oa = orderOf.get(pair.a);
      const ob = orderOf.get(pair.b);
      if (clipOf.get(pair.a) === clipOf.get(pair.b) &&
          oa !== undefined && ob !== undefined && Math.abs(oa - ob) === 1) {
        adjacentMatchCounts.push(matches.length);
      }
    }
    if (matches.length < minMatches) {
      if (count) reject.fewMatches++;
      pairOutcome.set(pairKey(pair.a, pair.b), `only ${matches.length} raw matches`);
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

    // Epipolar rescue for the self-similar scene. A capture measured 98% of
    // its candidates dying as AMBIGUOUS — the environment looked like itself
    // everywhere, so the global ratio test rightly refused to choose — while
    // its adjacent frames still matched well enough for RANSAC to recover E.
    // With E in hand, each feature can only match along one line in the other
    // image, and on one line the true match is usually unique even in a hall
    // of mirrors. So: verify on the unambiguous survivors, then re-match
    // everything under the epipolar constraint, ratio-testing only within the
    // band. Gated to starved pairs so a healthy capture's path is untouched.
    let guided: MatchPair[] | null = null;
    if (geo && eCount >= 10 && matches.length < 120) {
      const fa2 = featureByIndex.get(pair.a)!;
      const fb2 = featureByIndex.get(pair.b)!;
      const g = guidedMatches(fa2, fb2, geo.E, focal, cx, cy, {
        bandPx: 2.5, maxDistance: 110, ratio: 0.85,
      });
      if (g.length > eCount) {
        guided = g;
        if (eCount < minInliers && g.length >= minInliers) guidedRescues++;
      }
    }

    const kept0 = guided ? guided.length : eCount;
    const essentialUsable = geo !== null && kept0 >= minInliers;

    let inlierFlags: boolean[] | undefined = geo?.inliers;
    let kept = kept0;
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
      pairOutcome.set(
        pairKey(pair.a, pair.b),
        `no consistent geometry among ${matches.length} matches`,
      );
      return null;
    }
    if (kept < minInliers) {
      if (count) reject.fewInliers++;
      pairOutcome.set(
        pairKey(pair.a, pair.b),
        `only ${kept} of ${matches.length} matches were geometrically consistent`,
      );
      return null;
    }

    const inlierMatches: Array<[number, number]> = [];
    if (guided && !degenerate) {
      for (const m of guided) inlierMatches.push([m.queryIndex, m.trainIndex]);
    } else {
      for (let k = 0; k < matches.length; k++) {
        if (inlierFlags[k]) inlierMatches.push([matches[k].queryIndex, matches[k].trainIndex]);
      }
    }
    pairOutcome.set(
      pairKey(pair.a, pair.b),
      `the pair verified with ${inlierMatches.length} consistent matches` +
      `${degenerate ? " but was planar or rotation-only" : ""}, yet neither PnP nor ` +
      "composition could place the next frame",
    );
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
    // Attempting is cheap and accepting is what the threshold protects, so a
    // pair may TRY from 12 matches — LO-RANSAC plus the epipolar rescue decide
    // whether it earns the full support bar. A real capture had 233 pairs
    // rejected unexamined at ~21 matches each.
    const ok = await verifyPair(pair, i, Math.min(12, strictMatches), strictInliers, true);
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
      const ok = await verifyPair(pair, i, gentleMatches, gentleInliers, false, 0.86, true, 110);
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
  adjacentMatchCounts.sort((a, b) => a - b);
  const adjacentMedian = adjacentMatchCounts.length
    ? adjacentMatchCounts[Math.floor(adjacentMatchCounts.length / 2)] : 0;
  const pct = (n: number) =>
    matchStats.candidates > 0 ? Math.round((n / matchStats.candidates) * 100) : 0;
  const diagnosticsBase =
    `${frames.length} frames, median ${medianFeatures} features each; ` +
    `${proposed.length} pairs proposed, ${verified.length} verified` +
    `${relaxed ? " (after a lenient retry)" : ""}` +
    `${degenerateCount ? `, of which ${degenerateCount} were planar or rotation-only` : ""}; ` +
    `median ${medianMatches} raw matches per pair` +
    `${adjacentMatchCounts.length
      ? ` (${adjacentMedian} between ADJACENT frames, which overlap most)`
      : ""}; ` +
    `of ${matchStats.candidates.toLocaleString()} candidate matches, ` +
    `${pct(matchStats.overDistance)}% died at the distance cap (descriptors changed too ` +
    `much — blur or exposure), ${pct(matchStats.failedRatio)}% were ambiguous (the scene ` +
    `looks like itself — repeated texture), ${pct(matchStats.failedMutual)}% failed the ` +
    `mutual check, ${pct(matchStats.kept)}% kept; rejected ` +
    `${reject.fewMatches} pairs for too few matches, ${reject.fewInliers} for too few ` +
    `inliers after RANSAC, ${reject.noModel} with no consistent model, ` +
    `${reject.noFeatures} for having no features`;
  // The rescue counters keep counting through registration, long after this
  // point — a snapshot taken here would report them as zero forever.
  const diagnostics = () =>
    diagnosticsBase +
    `${guidedRescues ? `; ${guidedRescues} pairs rescued by epipolar re-matching` : ""}` +
    `${compositionRescues ? `; ${compositionRescues} frames placed by pose composition` : ""}` +
    (composeStats.bridges
      ? `; of ${composeStats.bridges} composition bridges tried, ${composeStats.fewAnchors} ` +
        `had under 3 triangulated anchor points, ${composeStats.scaleVote} failed the scale ` +
        `vote, ${composeStats.scaleFlat} could not measure the baseline at all (anchors too ` +
        `distant), ${composeStats.strictGate} failed reprojection after refinement`
      : "") +
    `${lateRescues ? `; ${lateRescues} frames placed on a second pass after global refinement` : ""}` +
    chainNote;

  if (verified.length === 0) {
    throw new Error(
      `No image pairs could be verified. ${diagnostics()}. ` +
      (medianMatches < strictMatches
        ? "Matches are the bottleneck: the frames are not sharing enough recognisable " +
          "detail, which is blur, darkness, or moving too fast between frames."
        : "Matches were plentiful but no consistent camera motion fitted them, which " +
          "usually means repeated texture matching the wrong parts of the scene."),
    );
  }
  report(0.48, `${verified.length} verified pairs · ${crossClipPairs} link different clips`);

  // ── 2. Build tracks ─────────────────────────────────────────────────────
  //
  // Conflict-AWARE union, not blind union followed by deletion. The old order
  // was: merge every match transitively, then throw away any track that ended
  // up claiming two keypoints in one image. One wrong match between two real
  // tracks merged them into a "conflict" and destroyed both — and on
  // self-similar texture, where a few wrong matches are inevitable, the
  // transitive merging shredded nearly everything: an orbit capture produced
  // 331 verified pairs and only 197 surviving points. So refuse the merge that
  // would create the contradiction and drop that one edge; the two tracks it
  // tried to weld stay alive. COLMAP builds its correspondence graph the same
  // way. Strong pairs are processed first so well-supported tracks form before
  // weak edges get the chance to be refused.
  const parent = new Map<number, number>();
  const memberOf = new Map<number, Map<number, number>>();
  const findRoot = (key: number): number => {
    let root = key;
    while (parent.get(root) !== undefined && parent.get(root) !== root) {
      root = parent.get(root)!;
    }
    // Path compression.
    let walk = key;
    while (walk !== root) {
      const next = parent.get(walk)!;
      parent.set(walk, root);
      walk = next;
    }
    return root;
  };
  const ensure = (key: number) => {
    if (!parent.has(key)) {
      parent.set(key, key);
      memberOf.set(key, new Map([[unpackFrame(key), unpackKp(key)]]));
    }
  };
  const tryUnion = (a: number, b: number): void => {
    ensure(a);
    ensure(b);
    let ra = findRoot(a);
    let rb = findRoot(b);
    if (ra === rb) return;
    let ma = memberOf.get(ra)!;
    let mb = memberOf.get(rb)!;
    if (mb.size > ma.size) {
      [ra, rb] = [rb, ra];
      [ma, mb] = [mb, ma];
    }
    // Would the merged track claim two keypoints in one image? Then this edge
    // is a wrong match between two real points — refuse it, keep both tracks.
    for (const [frame, kp] of mb) {
      const held = ma.get(frame);
      if (held !== undefined && held !== kp) return;
    }
    for (const [frame, kp] of mb) ma.set(frame, kp);
    parent.set(rb, ra);
    memberOf.delete(rb);
  };

  const byStrength = [...verified].sort((x, y) => y.matches.length - x.matches.length);
  for (const pair of byStrength) {
    for (const [ka, kb] of pair.matches) {
      tryUnion(packKey(pair.a, ka), packKey(pair.b, kb));
    }
  }

  const tracks: Track[] = [];
  // trackIndex lookup by (frame, keypoint)
  const trackOf = new Map<number, number>();
  for (const [root, views] of memberOf) {
    if (parent.get(root) !== root) continue;
    if (views.size < 2) continue;
    const members = [...views].map(([frame, kp]) => packKey(frame, kp));

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
      `${diagnostics()}. The best pair had ${bestInliers} matches, of which ` +
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

  // PnP with a fixed per-frame seed is deterministic: the same support set
  // fails the same way every time. So a failure is keyed to the support count
  // it failed at, and the frame is retried only once its support has GROWN —
  // blanket clearing meant every composition rescue re-ran the same hopeless
  // candidates, one wasted step each, and the step budget died of it.
  const failed = new Map<number, number>();
  /** Bridges that failed composition, keyed to the model size they failed at. */
  const bridgeFailedAt = new Map<string, number>();
  let sinceBa = 0;
  let minSupport = cfg.sfm.minPnpInliers;

  const registerByComposition = (): boolean => {
    // Every verified pair joining an unregistered frame to a registered one is
    // a candidate, strongest first — the first one whose scale can be pinned
    // and whose composed pose explains the observations wins. Trying only the
    // single strongest and giving up left whole chains stranded behind one
    // unluckily-placed frame.
    // Any pair that earned verification carries enough support to try: a real
    // capture stalled behind a 36-match pair while the bar sat at a flat 40.
    const bridgeMin = Math.min(40, cfg.features.minPairInliers);
    const bridges = verified
      .filter((pair) => {
        if (pair.degenerate || pair.matches.length < bridgeMin) return false;
        return poses.has(pair.a) !== poses.has(pair.b);
      })
      .sort((x, y) => y.matches.length - x.matches.length)
      .slice(0, 24);

    for (const bridge of bridges) {
      // A bridge that failed is deterministic until the model changes: retrying
      // it before another frame registers just burns the budget on a known
      // answer (one stubborn bridge was measured retrying six times unchanged).
      const key = pairKey(bridge.a, bridge.b);
      if (bridgeFailedAt.get(key) === poses.size) continue;
      if (composeFrom(bridge)) return true;
      bridgeFailedAt.set(key, poses.size);
    }
    return false;
  };

  const composeFrom = (bestPair: VerifiedPairInternal): boolean => {
    composeStats.bridges++;
    const aIn = poses.has(bestPair.a);
    const candidate = aIn ? bestPair.b : bestPair.a;
    const anchorFrame = aIn ? bestPair.a : bestPair.b;
    const anchorPose = poses.get(anchorFrame)!;
    // The pair's pose maps a → b. Orient it so it maps anchor → candidate.
    let Rrel = bestPair.pose.R;
    let trel = bestPair.pose.t;
    if (anchorFrame === bestPair.b) {
      const Rt = mat3Transpose(Rrel);
      const t2 = mat3MulVec(Rt, [-trel[0], -trel[1], -trel[2]]);
      Rrel = Rt;
      trel = [t2[0], t2[1], t2[2]];
    }
    const tn = Math.hypot(trel[0], trel[1], trel[2]);
    if (tn < 1e-9) return false;
    const b: [number, number, number] = [trel[0] / tn, trel[1] / tn, trel[2] / tn];

    // Scale anchors come through the PAIR's own matches: an anchor-side
    // keypoint that belongs to a triangulated track gives a known world point,
    // and the match says where the candidate observes it. Deliberately NOT
    // restricted to tracks that already contain the candidate — a chain break
    // means the track graph never linked the candidate to anything, and that
    // is precisely the situation this rescue exists for.
    const toWorld = (x: [number, number, number]) => {
      const Xa = mat3MulVec(anchorPose.R, x);
      const Ar = mat3MulVec(Rrel, [
        Xa[0] + anchorPose.t[0], Xa[1] + anchorPose.t[1], Xa[2] + anchorPose.t[2],
      ]);
      return [Ar[0], Ar[1], Ar[2]] as [number, number, number];
    };
    const scaleObs: Array<{
      X: [number, number, number]; A: [number, number, number];
      x: number; y: number; ti: number;
    }> = [];
    const seenTracks = new Set<number>();
    for (const [ka, kb] of bestPair.matches) {
      const anchorKp = anchorFrame === bestPair.a ? ka : kb;
      const candidateKp = anchorFrame === bestPair.a ? kb : ka;
      const ti = trackOf.get(packKey(anchorFrame, anchorKp));
      if (ti === undefined || seenTracks.has(ti)) continue;
      const track = tracks[ti];
      if (!track.xyz) continue;
      const o = observationOf(candidate, candidateKp);
      if (!o) continue;
      seenTracks.add(ti);
      scaleObs.push({ X: track.xyz, A: toWorld(track.xyz), x: o.x, y: o.y, ti });
    }
    // Tracks the candidate is already part of contribute too.
    for (const ti of tracksByFrame.get(candidate) ?? []) {
      if (seenTracks.has(ti)) continue;
      const track = tracks[ti];
      if (!track.xyz) continue;
      const kp = track.views.get(candidate);
      if (kp === undefined) continue;
      const o = observationOf(candidate, kp);
      if (!o) continue;
      seenTracks.add(ti);
      scaleObs.push({ X: track.xyz, A: toWorld(track.xyz), x: o.x, y: o.y, ti });
    }
    if (scaleObs.length < 3) { composeStats.fewAnchors++; return false; }

    // The scale is one unknown, but the anchors pinning it are triangulated
    // points of uneven quality — a single systematically bad track drags any
    // averaged estimate (a junction measured its median at nearly twice the
    // true scale while ONE equation held the right answer). So treat each
    // equation's solution as a hypothesis and let reprojection vote: the true
    // scale reprojects most of the anchors, a corrupted one reprojects itself.
    const hypotheses: number[] = [];
    for (const o of scaleObs) {
      for (const [c, d] of [
        [b[0] - o.x * b[2], o.x * o.A[2] - o.A[0]],
        [b[1] - o.y * b[2], o.y * o.A[2] - o.A[1]],
      ] as Array<[number, number]>) {
        if (Math.abs(c) > 1e-9) {
          const h = d / c;
          if (Number.isFinite(h) && h > 0) hypotheses.push(h);
        }
      }
    }
    const fallback = solveRelativeScale(scaleObs, b);
    if (fallback && fallback.s > 0) hypotheses.push(fallback.s);
    if (hypotheses.length === 0) { composeStats.scaleVote++; return false; }

    const errAt = (sc: number, o: { A: [number, number, number]; x: number; y: number }) => {
      const z = o.A[2] + sc * b[2];
      if (z <= 1e-6) return Infinity;
      return Math.hypot(
        (o.A[0] + sc * b[0]) / z - o.x,
        (o.A[1] + sc * b[1]) / z - o.y,
      ) * focal;
    };
    // The composed rotation is only RANSAC-grade: half a degree of error is
    // several pixels at this focal, so judging the scale vote at the strict
    // reprojection gate rejects bridges whose scale is actually fine. Vote at
    // a loose gate just to land in the right basin, refine the full 6-DOF pose
    // from there, and only THEN apply the strict gate.
    const limit = cfg.sfm.maxReprojectionErrorPx;
    const basinLimit = limit * 3;
    let bestS = 0;
    let bestInliers = 0;
    let bestErr = Infinity;
    for (const h of hypotheses) {
      let inliers = 0;
      let total = 0;
      for (const o of scaleObs) {
        const e = errAt(h, o);
        if (e < basinLimit) { inliers++; total += e; }
      }
      const mean = inliers > 0 ? total / inliers : Infinity;
      if (inliers > bestInliers || (inliers === bestInliers && mean < bestErr)) {
        bestS = h;
        bestInliers = inliers;
        bestErr = mean;
      }
    }
    if (bestInliers < 3) { composeStats.scaleVote++; return false; }

    // A bridge whose anchors cannot tell baselines apart must not place a
    // camera. When the anchors sit far away, EVERY scale fits them at the
    // loose gate, the winning hypothesis is arbitrary, and one such bridge
    // kept composing a zero-baseline camera. Perturb the scale by more than
    // the gate should tolerate; if the basin barely shrinks, the scale was
    // never actually measured — skip and let a better bridge place the frame.
    const depths = scaleObs
      .map((o) => o.A[2] + bestS * b[2])
      .filter((z) => z > 0)
      .sort((x, y) => x - y);
    const medDepth = depths.length ? depths[depths.length >> 1] : 1;
    const ds = Math.max(bestS * 0.6, medDepth * 0.08);
    const inliersAt = (sc: number) =>
      sc > 0 ? scaleObs.reduce((n, o) => n + (errAt(sc, o) < basinLimit ? 1 : 0), 0) : 0;
    const offSupport = Math.max(inliersAt(bestS + ds), inliersAt(bestS - ds));
    if (offSupport >= bestInliers * 0.85) { composeStats.scaleFlat++; return false; }

    const Rf = mat3Mul(Rrel, anchorPose.R);
    const ta = mat3MulVec(Rrel, anchorPose.t);
    const composed: Pose = {
      R: Rf,
      t: [
        ta[0] + bestS * b[0],
        ta[1] + bestS * b[1],
        ta[2] + bestS * b[2],
      ],
    };

    // In self-similar footage a share of the bridge's matches are WRONG
    // correspondences — epipolar-consistent, but on a different repeat of the
    // texture — so they must not steer the refinement or vote in the final
    // gate. Refine on the basin consensus only, re-fit once on the strict
    // survivors, and measure support against the consensus rather than the
    // raw match count: outliers abstain, as in every other RANSAC step here.
    const reprojPx = (p: Pose, c: PnpCorrespondence): number => {
      const v = mat3MulVec(p.R, c.X);
      const z = v[2] + p.t[2];
      if (z <= 1e-9) return Infinity;
      return Math.hypot(
        (v[0] + p.t[0]) / z - c.x,
        (v[1] + p.t[1]) / z - c.y,
      ) * focal;
    };
    const basin: Array<PnpCorrespondence & { ti: number }> = scaleObs
      .filter((o) => errAt(bestS, o) < basinLimit)
      .map((o) => ({ X: o.X, x: o.x, y: o.y, ti: o.ti }));
    // Refining 6 DOF against 3 points is a tautology — they fit afterwards no
    // matter what. With so few, judge the UNREFINED composed pose, whose only
    // fitted freedom is the voted scale, and demand every point agree.
    let pose = composed;
    let strict: PnpCorrespondence[];
    const strictOf = (p: Pose) => basin.filter((c) => reprojPx(p, c) < limit);
    if (basin.length >= 4) {
      pose = refinePose(composed, basin);
      strict = strictOf(pose);
      if (strict.length >= 4) {
        pose = refinePose(pose, strict);
        strict = strictOf(pose);
      }
    } else {
      strict = strictOf(pose);
    }
    const needed = basin.length >= 4
      ? Math.max(4, Math.ceil(basin.length * 0.6))
      : basin.length;
    if (cfg.sfm.debugCompose) {
      const errs = basin.map((c) => reprojPx(pose, c)).sort((x, y) => x - y);
      const med = errs.length ? errs[errs.length >> 1] : Infinity;
      console.log(
        `[compose] ${anchorFrame}->${candidate} matches=${bestPair.matches.length} ` +
        `obs=${scaleObs.length} s=${bestS.toFixed(3)} basin=${basin.length} ` +
        `strict=${strict.length}/${needed} medPx=${med.toFixed(1)}`,
      );
    }
    if (strict.length < needed) {
      // Near-misses are the COMMON case at a frontier: the anchors are young
      // tracks that no bundle adjustment has touched, so a correct pose often
      // measures a 5–8px median against the 5px gate. Give such a bridge the
      // polish it is missing — place the frame provisionally, run the local
      // bundle adjustment, and keep it only if the consensus then passes the
      // SAME strict gate against the adjusted structure. Everything is
      // restored if it does not, so a wrong pose still cannot get in.
      if (strict.length < Math.max(4, Math.ceil(basin.length * 0.35))) {
        composeStats.strictGate++;
        return false;
      }
      const posesSnap = new Map(poses);
      const xyzSnap = tracks.map((t) =>
        t.xyz ? ([...t.xyz] as [number, number, number]) : null,
      );
      poses.set(candidate, pose);
      triangulatePending();
      runBundle(cfg.sfm.localBaWindow);
      const post = poses.get(candidate)!;
      let postCount = 0;
      for (const o of basin) {
        const X = tracks[o.ti].xyz;
        if (!X) continue;
        if (reprojPx(post, { X, x: o.x, y: o.y }) < limit) postCount++;
      }
      if (postCount >= needed) {
        if (cfg.sfm.debugCompose) {
          console.log(
            `[compose] ${anchorFrame}->${candidate} accepted after local BA ` +
            `(${postCount}/${needed})`,
          );
        }
        compositionRescues++;
        sinceBa = 0;
        return true;
      }
      poses = posesSnap;
      for (let i = 0; i < tracks.length; i++) tracks[i].xyz = xyzSnap[i];
      composeStats.strictGate++;
      return false;
    }

    poses.set(candidate, pose);
    compositionRescues++;
    triangulatePending();
    sinceBa++;
    return true;
  };

  // The budget is a safety net against a cycle nobody foresaw, not a working
  // limit — composition's bridge blacklist and the grown-support retry rule
  // bound the real work. At 2× frames it WAS the working limit: a long orbit
  // died mid-growth with rescues still succeeding.
  for (let step = 0; step < totalFrames * 8 + 200; step++) {
    checkAbort();
    if (poses.size >= totalFrames) break;

    // Which unregistered frame sees the most already-triangulated points?
    let best: { frame: number; count: number } | null = null;
    for (const frame of frames) {
      if (poses.has(frame.index)) continue;
      let count = 0;
      for (const ti of tracksByFrame.get(frame.index) ?? []) {
        if (tracks[ti].xyz) count++;
      }
      if ((failed.get(frame.index) ?? -1) >= count) continue;
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
        // PnP's inlier bar follows minSupport, so relaxing it genuinely changes
        // the outcome for frames that failed under the stricter one.
        failed.clear();
        continue;
      }
      // PnP has run out of frames it can place, but a chain-like capture — a
      // walk, an orbit — routinely strands frames that share HUNDREDS of
      // verified matches with a placed neighbour while seeing only a few
      // triangulated points. Their pose is not actually in doubt: the pair
      // fixes rotation and direction outright, leaving one scalar, the
      // baseline length, which a handful of known points settles. Register
      // one such frame by composition and let ordinary growth resume from it.
      if (registerByComposition()) continue;
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
      failed.set(frameIndex, best.count);
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

  // Name WHERE the chain broke, in capture order — the difference between
  // "reconstruction failed" and knowing which second of video to look at.
  // Called again after the post-refinement pass, which can close breaks.
  const noteChain = () => {
    const byClip = new Map<string, FrameMeta[]>();
    for (const f of frames) {
      const arr = byClip.get(f.clipId) ?? [];
      arr.push(f);
      byClip.set(f.clipId, arr);
    }
    const notes: string[] = [];
    for (const [clipId, arr] of byClip) {
      arr.sort((x, y) => x.orderInClip - y.orderInClip);
      const runs: Array<[number, number]> = [];
      for (let i = 0; i < arr.length; i++) {
        if (!poses.has(arr[i].index)) continue;
        if (runs.length && runs[runs.length - 1][1] === i - 1) runs[runs.length - 1][1] = i;
        else runs.push([i, i]);
      }
      if (!runs.length) continue;
      const runStr = runs
        .map(([s, e]) => (s === e ? `${s + 1}` : `${s + 1}–${e + 1}`))
        .join(", ");
      const breaks: string[] = [];
      for (const [s, e] of runs) {
        for (const [f, g] of [[s - 1, s], [e, e + 1]] as const) {
          if (f < 0 || g >= arr.length) continue;
          if (poses.has(arr[f].index) && poses.has(arr[g].index)) continue;
          const why = pairOutcome.get(pairKey(arr[f].index, arr[g].index)) ??
            "the pair was never even proposed";
          breaks.push(`${f + 1}→${g + 1} (${why})`);
        }
      }
      notes.push(
        `${clipId}: placed kept frames ${runStr} of ${arr.length}` +
        (breaks.length
          ? `; the chain broke at ${breaks.slice(0, 6).join(", ")}` +
            (breaks.length > 6 ? `, and ${breaks.length - 6} more` : "")
          : ""),
      );
    }
    chainNote = notes.length ? `; ${notes.join("; ")}` : "";
  };
  noteChain();

  if (poses.size < 3) {
    const bestConditioned = verified.reduce((m, p) => Math.max(m, p.wellConditioned), 0);
    throw new Error(
      `None of the ${attempts} starting ${attempts === 1 ? "pair" : "pairs"} tried could ` +
      `be grown into a reconstruction. ${diagnostics()}; ${seedCandidates.length} pairs were ` +
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
  let finalBa = runBundle(null);
  triangulatePending();

  // ── 5b. Second-chance registration ──────────────────────────────────────
  // Growth judged every frame against the structure as it existed mid-build.
  // The refinement above just moved every camera and point to their best
  // joint positions, so a frame that failed PnP against the rough model can
  // succeed outright against the polished one — same solver, same gates.
  for (let pass = 0; pass < 3; pass++) {
    let added = 0;
    for (const frame of frames) {
      if (poses.has(frame.index)) continue;
      const corr: PnpCorrespondence[] = [];
      for (const ti of tracksByFrame.get(frame.index) ?? []) {
        const track = tracks[ti];
        if (!track.xyz) continue;
        const kp = track.views.get(frame.index);
        if (kp === undefined) continue;
        const o = observationOf(frame.index, kp);
        if (!o) continue;
        corr.push({ X: track.xyz, x: o.x, y: o.y });
      }
      if (corr.length < RELAXED_MIN_SUPPORT) continue;
      const solved = pnpRansac(corr, cfg.sfm.ransacThresholdPx / focal, {
        seed: 0x3d1c + frame.index,
        minInliers: RELAXED_MIN_SUPPORT,
        focal,
      });
      if (!solved) continue;
      poses.set(frame.index, solved.pose);
      lateRescues++;
      added++;
    }
    if (added === 0) break;
    triangulatePending();
  }
  if (lateRescues > 0) {
    report(0.92, `Refining ${poses.size} cameras`);
    finalBa = runBundle(null);
    triangulatePending();
    noteChain();
  }

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
    diagnostics: diagnostics(),
  };
}

