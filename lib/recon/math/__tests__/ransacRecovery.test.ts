import { describe, expect, it } from "vitest";
import { ransacEssential, type Correspondence, type Pose } from "../twoView";

function makeRng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

const IDENTITY: Pose = { R: new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]), t: [0, 0, 0] };

/**
 * A room walked through, with a controlled fraction of the matches being wrong.
 *
 * Real footage carries a lot of bad matches: repeated texture, motion blur
 * smearing descriptors, and ORB's limited invariance all produce confident
 * nonsense. The inlier ratio, not the number of matches, is what decides
 * whether RANSAC can find the model at all.
 */
function contaminated(inlierRatio: number, total: number, seed: number) {
  const rng = makeRng(seed);
  const moved: Pose = { R: IDENTITY.R, t: [-0.45, 0.03, -0.35] };
  const corr: Correspondence[] = [];
  const truthFlags: boolean[] = [];
  while (corr.length < total) {
    if (rng() < inlierRatio) {
      const X: [number, number, number] = [
        (rng() - 0.5) * 6, (rng() - 0.5) * 3, 1.8 + rng() * 6,
      ];
      const proj = (p: Pose) => {
        const R = p.R;
        const z = R[6] * X[0] + R[7] * X[1] + R[8] * X[2] + p.t[2];
        const x = R[0] * X[0] + R[1] * X[1] + R[2] * X[2] + p.t[0];
        const y = R[3] * X[0] + R[4] * X[1] + R[5] * X[2] + p.t[1];
        return { x: x / z, y: y / z, z };
      };
      const a = proj(IDENTITY);
      const b = proj(moved);
      if (a.z < 0.4 || b.z < 0.4) continue;
      corr.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y });
      truthFlags.push(true);
    } else {
      corr.push({
        x1: (rng() - 0.5) * 1.4, y1: (rng() - 0.5) * 1.0,
        x2: (rng() - 0.5) * 1.4, y2: (rng() - 0.5) * 1.0,
      });
      truthFlags.push(false);
    }
  }
  return { corr, truthFlags };
}

/**
 * Plausible descriptor distances, ranked best first.
 *
 * ORB Hamming distances run 0-256. A correct match usually scores lower than a
 * wrong one, but the distributions overlap heavily — modelled here as inliers
 * around 40 and outliers around 60 with wide spread, so the ordering is a real
 * but far-from-perfect signal, which is what the matcher actually supplies.
 */
function rankingFor(truthFlags: boolean[], seed: number): number[] {
  const rng = makeRng(seed);
  const gauss = () => {
    const u = Math.max(1e-9, rng());
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
  };
  return truthFlags
    .map((isInlier, k) => ({ k, d: (isInlier ? 40 + gauss() * 12 : 60 + gauss() * 15) }))
    .sort((a, b) => a.d - b.d)
    .map((r) => r.k);
}

/** How often verification succeeds over several independent draws. */
function successRate(inlierRatio: number, trials = 8, ranked = false) {
  let ok = 0;
  for (let t = 0; t < trials; t++) {
    const { corr, truthFlags } = contaminated(inlierRatio, 400, 1000 + t * 37);
    const expected = truthFlags.filter(Boolean).length;
    const geo = ransacEssential(corr, 0.004, {
      seed: 7 + t,
      ranking: ranked ? rankingFor(truthFlags, 500 + t) : undefined,
    });
    // Success means recovering most of the true correspondences, not merely
    // returning something.
    if (geo && geo.inlierCount > expected * 0.7) ok++;
  }
  return ok / trials;
}

describe("verification at the inlier ratios real footage actually has", () => {
  it("succeeds on clean data, as synthetic test footage always did", () => {
    expect(successRate(0.9)).toBe(1);
  });

  // The band the user's capture sits in. Before local optimisation, an
  // eight-point minimal sample finds the model roughly a third of the time here
  // at the old 700-iteration budget, which is why 10 of 292 pairs verified.
  it("succeeds at a 40% inlier ratio", () => {
    expect(successRate(0.4)).toBeGreaterThanOrEqual(0.875);
  });

  // Uniform sampling cannot reach here and no iteration budget fixes it: a
  // clean eight-point draw at 30% happens once in 15,000, so this records the
  // limit rather than asserting it away.
  it("is beyond uniform sampling at a 30% inlier ratio", () => {
    expect(successRate(0.3)).toBeLessThan(0.5);
  });

  // Which is why the matcher's ordering is passed in. Ranked sampling draws
  // early candidates from the part of the data where inliers are dense, and
  // that is what makes these ratios recoverable at all.
  it("recovers at a 30% inlier ratio once matches are ranked by quality", () => {
    expect(successRate(0.3, 8, true)).toBeGreaterThanOrEqual(0.75);
  });

  it("recovers at 25% with ranking, where uniform sampling cannot", () => {
    expect(successRate(0.25, 8, true)).toBeGreaterThan(successRate(0.25));
  });

  it("still helps where uniform sampling already worked", () => {
    expect(successRate(0.4, 8, true)).toBeGreaterThanOrEqual(0.875);
  });

  it("does not invent a model from pure noise", () => {
    const rng = makeRng(5);
    const corr: Correspondence[] = Array.from({ length: 300 }, () => ({
      x1: (rng() - 0.5) * 1.4, y1: (rng() - 0.5),
      x2: (rng() - 0.5) * 1.4, y2: (rng() - 0.5),
    }));
    const geo = ransacEssential(corr, 0.004, { seed: 3 });
    // Some points will always coincidentally fit; it must not be most of them.
    if (geo) expect(geo.inlierCount).toBeLessThan(corr.length * 0.35);
  });

  it("keeps the recovered inliers accurate, not merely numerous", () => {
    const { corr, truthFlags } = contaminated(0.35, 400, 4242);
    const geo = ransacEssential(corr, 0.004, { seed: 9 });
    expect(geo).not.toBeNull();
    let correct = 0;
    let claimed = 0;
    for (let i = 0; i < corr.length; i++) {
      if (geo!.inliers[i]) { claimed++; if (truthFlags[i]) correct++; }
    }
    expect(correct / claimed).toBeGreaterThan(0.9);
  });
});
