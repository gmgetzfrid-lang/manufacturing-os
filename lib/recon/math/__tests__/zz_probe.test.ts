import { describe, it } from "vitest";
import { ransacEssential, ransacHomography, type Correspondence } from "../twoView";
import { rodrigues, mat3MulVec } from "../linalg";

const W = 1280, H = 720;
const FOCAL = 0.85 * W;
const CX = W / 2, CY = H / 2;
const THR = 2.0 / FOCAL;

function mulrand(seed: number) {
  let s = seed >>> 0 || 1;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

interface SceneOpts {
  n: number; outlierFrac: number; seed: number;
  yawDeg: number; baseline: number; planar: boolean; noisePx: number;
}

function makePair(o: SceneOpts): Correspondence[] {
  const rnd = mulrand(o.seed);
  const R = rodrigues([0, (o.yawDeg * Math.PI) / 180, 0]);
  const C: [number, number, number] = [o.baseline, 0, 0];
  const t = mat3MulVec(R, [-C[0], -C[1], -C[2]]);
  const corr: Correspondence[] = [];
  const nIn = Math.round(o.n * (1 - o.outlierFrac));
  let guard = 0;
  while (corr.length < nIn && guard++ < o.n * 200) {
    // point in front of camera 1
    const Z = o.planar ? 6 : 2 + rnd() * 12;
    const px = (rnd() * W - CX) / FOCAL, py = (rnd() * H - CY) / FOCAL;
    const X: [number, number, number] = [px * Z, py * Z, Z];
    const c2 = mat3MulVec(R, X);
    const z2 = c2[2] + t[2];
    if (z2 < 0.3) continue;
    const x2 = (c2[0] + t[0]) / z2, y2 = (c2[1] + t[1]) / z2;
    if (Math.abs(x2 * FOCAL) > CX || Math.abs(y2 * FOCAL) > CY) continue;
    const np = o.noisePx / FOCAL;
    corr.push({
      x1: px + (rnd() - 0.5) * np, y1: py + (rnd() - 0.5) * np,
      x2: x2 + (rnd() - 0.5) * np, y2: y2 + (rnd() - 0.5) * np,
    });
  }
  while (corr.length < o.n) {
    corr.push({
      x1: (rnd() * W - CX) / FOCAL, y1: (rnd() * H - CY) / FOCAL,
      x2: (rnd() * W - CX) / FOCAL, y2: (rnd() * H - CY) / FOCAL,
    });
  }
  // shuffle
  for (let i = corr.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [corr[i], corr[j]] = [corr[j], corr[i]];
  }
  return corr;
}

describe("probe", () => {
  it("E-RANSAC success vs outlier fraction (700 iters, as reconstruct.ts calls it)", () => {
    for (const outlierFrac of [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7]) {
      let ok = 0, sumIn = 0;
      const TRIALS = 30;
      for (let k = 0; k < TRIALS; k++) {
        const corr = makePair({ n: 200, outlierFrac, seed: 1234 + k * 977, yawDeg: 6, baseline: 0.6, planar: false, noisePx: 1.0 });
        const r = ransacEssential(corr, THR, { confidence: 0.9999, maxIterations: 700, seed: 0x51ed + k });
        const got = r ? r.inlierCount : 0;
        sumIn += got;
        if (got >= 28) ok++;
      }
      const trueIn = Math.round(200 * (1 - outlierFrac));
      require("fs").appendFileSync("/tmp/claude-0/-home-user-manufacturing-os/c50d6c53-2c48-52ae-b05b-5cebffb0e4ed/scratchpad/probe.txt", `outlier=${outlierFrac.toFixed(2)} trueInliers=${trueIn} passRate=${(ok / TRIALS * 100).toFixed(0)}% meanInliers=${(sumIn / TRIALS).toFixed(1)}\n`);
    }
  }, 300000);
});
