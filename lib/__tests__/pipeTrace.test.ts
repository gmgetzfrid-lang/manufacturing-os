// Tracing draws a line over a real P&ID and an engineer reads it as "this is
// the pipe". Every behaviour that separates following a pipe from wandering
// through line-work is pinned here against synthetic drawings where the right
// answer is known exactly.

import { describe, it, expect } from "vitest";
import {
  binarize, extractSegments, buildNetwork, tracePipe, tracePipeOnRaster,
  dropCollinear, segLength, type Raster,
} from "../pipeTrace";

// ── A tiny drawing board ────────────────────────────────────────────────
function board(width: number, height: number): Raster {
  return { width, height, ink: new Uint8Array(width * height) };
}
function hLine(r: Raster, y: number, x1: number, x2: number, thick = 2) {
  for (let t = 0; t < thick; t++) {
    for (let x = Math.min(x1, x2); x <= Math.max(x1, x2); x++) r.ink[(y + t) * r.width + x] = 1;
  }
}
function vLine(r: Raster, x: number, y1: number, y2: number, thick = 2) {
  for (let t = 0; t < thick; t++) {
    for (let y = Math.min(y1, y2); y <= Math.max(y1, y2); y++) r.ink[y * r.width + (x + t)] = 1;
  }
}
/** Letter-sized scribble: short strokes in every direction, like a tag. */
function textBlob(r: Raster, x: number, y: number) {
  for (let i = 0; i < 8; i++) {
    hLine(r, y + i, x, x + 6, 1);
    vLine(r, x + i, y, y + 6, 1);
  }
}

describe("binarize", () => {
  it("reads dark pixels as ink and light or transparent as paper", () => {
    const rgba = new Uint8ClampedArray([
      0, 0, 0, 255,          // black → ink
      255, 255, 255, 255,    // white → paper
      120, 120, 120, 255,    // mid grey (anti-aliased stroke) → ink
      0, 0, 0, 0,            // transparent → paper
    ]);
    const r = binarize(rgba, 4, 1);
    expect([...r.ink]).toEqual([1, 0, 1, 0]);
  });
});

describe("extractSegments", () => {
  it("finds a horizontal and a vertical stroke and their center lines", () => {
    const r = board(200, 200);
    hLine(r, 50, 20, 180);
    vLine(r, 100, 60, 190);
    const segs = extractSegments(r, { minRun: 10 });
    const h = segs.find((s) => s.horizontal)!;
    const v = segs.find((s) => !s.horizontal)!;
    expect(h).toBeTruthy();
    expect(v).toBeTruthy();
    expect(h.c).toBeCloseTo(50.5, 1);       // 2px thick, centered between rows
    expect(segLength(h)).toBeGreaterThan(150);
    expect(v.c).toBeCloseTo(100.5, 1);
  });

  // The reason text never has to be "read" or masked: letterforms simply
  // cannot produce straight runs of pipe length.
  it("rejects text-sized scribble entirely", () => {
    const r = board(200, 200);
    textBlob(r, 40, 40);
    textBlob(r, 120, 90);
    expect(extractSegments(r, { minRun: 14 })).toHaveLength(0);
  });

  it("rejects filled blocks as too thick to be pipe", () => {
    const r = board(200, 200);
    for (let y = 40; y < 80; y++) hLine(r, y, 20, 160, 1);
    expect(extractSegments(r, { minRun: 14, maxThickness: 10 })).toHaveLength(0);
  });
});

describe("tracePipe", () => {
  const opts = { minRun: 10, alignTolerance: 4 };

  it("follows an L-bend and reports the corner", () => {
    const r = board(300, 300);
    hLine(r, 100, 30, 200);
    vLine(r, 200, 100, 250);
    const net = buildNetwork(extractSegments(r, opts), opts);
    const out = tracePipe(net, { x: 32, y: 101 }, { x: 201, y: 248 }, opts);
    expect(out.ok).toBe(true);
    expect(out.turns).toBe(1);
    // start → corner → end
    expect(out.points.length).toBe(3);
    expect(out.points[1].x).toBeCloseTo(200.5, 0);
    expect(out.points[1].y).toBeCloseTo(100.5, 0);
  });

  // The failure that makes a naive tracer useless: at a "+" both pipes are
  // present, and hopping onto the wrong one sends someone to isolate a line
  // that has nothing to do with the job.
  it("goes STRAIGHT through a crossing instead of turning onto the other pipe", () => {
    const r = board(400, 400);
    hLine(r, 200, 20, 380);          // our pipe, left to right
    vLine(r, 200, 20, 380);          // an unrelated pipe crossing it
    const net = buildNetwork(extractSegments(r, opts), opts);
    const out = tracePipe(net, { x: 25, y: 201 }, { x: 375, y: 201 }, opts);
    expect(out.ok).toBe(true);
    expect(out.turns).toBe(0);
    for (const p of out.points) expect(p.y).toBeCloseTo(200.5, 0);
  });

  it("marks a crossing as a crossing but a tee as a branch", () => {
    const cross = board(400, 400);
    hLine(cross, 200, 20, 380);
    vLine(cross, 200, 20, 380);
    const crossNet = buildNetwork(extractSegments(cross, opts), opts);
    expect(crossNet.nodes.some((n) => n.crossing)).toBe(true);

    const tee = board(400, 400);
    hLine(tee, 200, 20, 380);
    vLine(tee, 200, 200, 380);       // terminates ON the header — a real branch
    const teeNet = buildNetwork(extractSegments(tee, opts), opts);
    expect(teeNet.nodes.some((n) => n.crossing)).toBe(false);
  });

  it("takes a real tee when that is the only way to the target", () => {
    const r = board(400, 400);
    hLine(r, 100, 20, 300);
    vLine(r, 300, 100, 350);         // branch down off the header
    const net = buildNetwork(extractSegments(r, opts), opts);
    const out = tracePipe(net, { x: 25, y: 101 }, { x: 301, y: 345 }, opts);
    expect(out.ok).toBe(true);
    expect(out.turns).toBe(1);
  });

  it("jumps the small break a crossing hop leaves in the line", () => {
    const r = board(400, 200);
    hLine(r, 100, 20, 190);
    hLine(r, 100, 200, 380);         // same run, 10px gap where a hop was drawn
    const net = buildNetwork(extractSegments(r, { ...opts, maxGap: 16 }), { ...opts, maxGap: 16 });
    const out = tracePipe(net, { x: 25, y: 101 }, { x: 375, y: 101 }, { ...opts, maxGap: 16 });
    expect(out.ok).toBe(true);
    expect(out.turns).toBe(0);
  });

  it("refuses when the two tags are not connected by any line-work", () => {
    const r = board(400, 400);
    hLine(r, 100, 20, 180);
    hLine(r, 300, 220, 380);         // a different pipe entirely, far away
    const net = buildNetwork(extractSegments(r, opts), opts);
    const out = tracePipe(net, { x: 25, y: 101 }, { x: 375, y: 301 }, opts);
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/no continuous run|off-page/i);
  });

  it("refuses when there is no pipe near a tag at all", () => {
    const r = board(400, 400);
    hLine(r, 100, 20, 380);
    const net = buildNetwork(extractSegments(r, opts), opts);
    const out = tracePipe(net, { x: 25, y: 101 }, { x: 380, y: 390 }, { ...opts, snapRadius: 40 });
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/No pipe found near/i);
  });

  it("routes a multi-corner path through crossings without hopping off", () => {
    const r = board(500, 500);
    hLine(r, 100, 50, 300);          // leg 1 →
    vLine(r, 300, 100, 350);         // leg 2 ↓
    hLine(r, 350, 300, 450);         // leg 3 →
    vLine(r, 180, 40, 460);          // a long unrelated pipe crossing leg 1
    hLine(r, 250, 40, 460);          // another crossing leg 2
    const net = buildNetwork(extractSegments(r, opts), opts);
    const out = tracePipe(net, { x: 55, y: 101 }, { x: 445, y: 351 }, opts);
    expect(out.ok).toBe(true);
    expect(out.turns).toBe(2);
    expect(out.points).toHaveLength(4);
  });
});

describe("dropCollinear", () => {
  it("keeps only real corners", () => {
    expect(dropCollinear([
      { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 15 },
    ])).toEqual([{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 15 }]);
  });
  it("leaves a two-point line alone", () => {
    const line = [{ x: 0, y: 0 }, { x: 5, y: 5 }];
    expect(dropCollinear(line)).toEqual(line);
  });
});

describe("tracePipeOnRaster", () => {
  it("takes and returns page fractions", () => {
    const r = board(400, 400);
    hLine(r, 200, 20, 300);
    vLine(r, 300, 200, 380);
    const out = tracePipeOnRaster(r, { x: 25 / 400, y: 201 / 400 }, { x: 301 / 400, y: 375 / 400 },
      { minRun: 10, alignTolerance: 4 });
    expect(out.ok).toBe(true);
    expect(out.segments).toBeGreaterThan(0);
    for (const p of out.points) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(1);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(1);
    }
  });

  it("says so plainly when a page has no line-work to follow", () => {
    const out = tracePipeOnRaster(board(200, 200), { x: 0.1, y: 0.1 }, { x: 0.9, y: 0.9 });
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/No pipe-like line-work/i);
  });
});
