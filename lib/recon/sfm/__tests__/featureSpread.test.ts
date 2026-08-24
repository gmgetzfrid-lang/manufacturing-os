import { describe, expect, it } from "vitest";
import { distributeByGrid } from "../features";

function makeRng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

const W = 1280;
const H = 720;

describe("distributing features across the frame", () => {
  it("keeps everything when under the target", () => {
    const pts = [{ x: 5, y: 5, response: 1 }, { x: 700, y: 300, response: 2 }];
    expect(distributeByGrid(pts, W, H, 100)).toEqual([0, 1]);
  });

  // The failure this exists for: response-ranked selection puts the whole
  // budget on the loudest texture and starves the rest of the frame.
  it("does not let one loud corner of the frame take the whole budget", () => {
    const rng = makeRng(7);
    const pts: Array<{ x: number; y: number; response: number }> = [];
    // 5,000 strong corners in one 200px patch...
    for (let i = 0; i < 5000; i++) {
      pts.push({ x: 100 + rng() * 200, y: 100 + rng() * 200, response: 100 + rng() });
    }
    // ...and 400 weaker ones spread over the rest of the frame.
    for (let i = 0; i < 400; i++) {
      pts.push({ x: 400 + rng() * 850, y: rng() * 700, response: 1 + rng() });
    }
    const picked = distributeByGrid(pts, W, H, 2000);
    expect(picked.length).toBe(2000);
    const outsideLoudPatch = picked.filter((i) => pts[i].x > 350).length;
    // Response-ranked selection would take 0 of these until the patch was
    // exhausted; round-robin coverage must keep essentially all of them.
    expect(outsideLoudPatch).toBeGreaterThan(350);
  });

  it("prefers the strongest corner within each cell", () => {
    const pts = [
      { x: 10, y: 10, response: 1 },
      { x: 12, y: 12, response: 9 }, // same cell, stronger
      { x: 640, y: 360, response: 5 },
    ];
    const picked = distributeByGrid(pts, W, H, 2);
    expect(picked).toContain(1);
    expect(picked).toContain(2);
  });

  it("fills the budget from dense cells once every cell is represented", () => {
    const rng = makeRng(11);
    const pts: Array<{ x: number; y: number; response: number }> = [];
    for (let i = 0; i < 3000; i++) {
      pts.push({ x: rng() * W, y: rng() * H, response: rng() });
    }
    expect(distributeByGrid(pts, W, H, 2400).length).toBe(2400);
  });
});
