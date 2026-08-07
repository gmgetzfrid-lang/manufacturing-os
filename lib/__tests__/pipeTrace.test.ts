// Tracing draws a line over a real P&ID and an engineer reads it as "this is
// the pipe". Every behaviour that separates following a pipe from wandering
// through line-work is pinned here against synthetic drawings where the right
// answer is known exactly.

import { describe, it, expect } from "vitest";
import {
  binarize, extractSegments, buildNetwork, tracePipe, tracePipeOnRaster, classifySegments,
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
    const out = tracePipe(net, { x: 25, y: 101 }, { x: 380, y: 390 }, { ...opts, searchRadius: 40 });
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

// Everything below is a lesson from a real SHX P&ID export rather than a
// synthetic ideal — each is a way the first version reported "no continuous
// run" on a drawing whose line is plainly continuous to the eye.
describe("tracePipe on realistic drawing habits", () => {
  const opts = { minRun: 10, alignTolerance: 4 };

  it("starts from a tag printed BESIDE the equipment, not on the pipe", () => {
    const r = board(400, 400);
    hLine(r, 200, 60, 350);
    // The marker sits where the label prints — up and to the left of the
    // line, which is where a draftsman puts it.
    const net = buildNetwork(extractSegments(r, opts), opts);
    const out = tracePipe(net, { x: 40, y: 160 }, { x: 355, y: 240 }, opts);
    expect(out.ok).toBe(true);
    expect(out.turns).toBe(0);
  });

  it("jumps the gap where the line number is printed in the run", () => {
    const r = board(600, 200);
    hLine(r, 100, 20, 240);
    hLine(r, 100, 400, 580);          // 160px of white — the label sits here
    const wide = { ...opts, maxGap: 220 };
    const net = buildNetwork(extractSegments(r, wide), wide);
    const out = tracePipe(net, { x: 25, y: 101 }, { x: 575, y: 101 }, wide);
    expect(out.ok).toBe(true);
    expect(out.turns).toBe(0);
  });

  it("gets through a valve body the stroke extractor cannot see as pipe", () => {
    const r = board(500, 200);
    hLine(r, 100, 20, 220);
    hLine(r, 100, 250, 480);          // 30px break where the valve is drawn
    const net = buildNetwork(extractSegments(r, opts), opts);
    const out = tracePipe(net, { x: 25, y: 101 }, { x: 475, y: 101 }, opts);
    expect(out.ok).toBe(true);
    // Passing through a valve is not the pipe turning.
    expect(out.turns).toBe(0);
  });

  // The failure mode behind "the line wasn't really on the pipe": an
  // unrelated run passing near the tag is a cheaper place to start than the
  // pipe that actually leaves the equipment.
  it("prefers the pipe touching the equipment over one merely passing nearby", () => {
    const r = board(600, 400);
    hLine(r, 100, 50, 550);          // the real line, through both tags
    hLine(r, 160, 50, 550);          // an unrelated parallel run, 60px away
    const net = buildNetwork(extractSegments(r, opts), opts);
    const out = tracePipe(net, { x: 55, y: 101 }, { x: 545, y: 101 }, opts);
    expect(out.ok).toBe(true);
    for (const p of out.points) expect(p.y).toBeCloseTo(100.5, 0);
  });

  it("reports what it saw, so a failure can be diagnosed from outside", () => {
    const r = board(400, 400);
    hLine(r, 100, 20, 380);
    const net = buildNetwork(extractSegments(r, opts), opts);
    const out = tracePipe(net, { x: 25, y: 101 }, { x: 375, y: 101 }, opts);
    expect(out.diagnostics.nodes).toBeGreaterThan(0);
    expect(out.diagnostics.startCandidates).toBeGreaterThan(0);
    expect(out.diagnostics.goalCandidates).toBeGreaterThan(0);
  });
});

// THE convention that makes a P&ID readable: where two lines cross, the
// crossing line is BROKEN so it can never be mistaken for a junction. The
// break is the drafter stating in ink that these pipes do not connect — and
// it means an UNBROKEN meeting is a real connection, the opposite of what a
// naive reading assumes.
describe("the break-at-crossing convention", () => {
  const opts = { minRun: 10, alignTolerance: 4 };

  /** Draw a vertical line that BREAKS where it crosses each header. */
  function brokenVertical(r: Raster, x: number, y1: number, y2: number, breakAt: number[]) {
    let from = y1;
    for (const b of breakAt.sort((p, q) => p - q)) {
      vLine(r, x, from, b - 8);
      from = b + 8;
    }
    vLine(r, x, from, y2);
  }

  it("recognizes a broken crossing and keeps the traced line going straight", () => {
    const r = board(600, 600);
    // Five headers, each crossed by one vertical that breaks over them.
    for (let i = 0; i < 5; i++) hLine(r, 80 + i * 90, 40, 560);
    brokenVertical(r, 300, 40, 560, [80, 170, 260, 350, 440]);
    const net = buildNetwork(extractSegments(r, opts), opts);
    expect(net.crossingStyle).toBe("break");
    expect(net.crossingBreaks).toBeGreaterThanOrEqual(4);

    // Follow the BROKEN line down through every crossing: the breaks must
    // read as "keep going", not as five separate tees.
    const out = tracePipe(net, { x: 301, y: 45 }, { x: 301, y: 555 }, opts);
    expect(out.ok).toBe(true);
    expect(out.turns).toBe(0);
  });

  it("will not turn off onto a header at a broken crossing", () => {
    const r = board(600, 600);
    for (let i = 0; i < 5; i++) hLine(r, 80 + i * 90, 40, 560);
    brokenVertical(r, 300, 40, 560, [80, 170, 260, 350, 440]);
    const net = buildNetwork(extractSegments(r, opts), opts);
    // Every node flanking a break is marked a crossing, so a turn there is
    // priced as leaving the pipe.
    expect(net.nodes.some((n) => n.crossing)).toBe(true);
    const out = tracePipe(net, { x: 301, y: 45 }, { x: 301, y: 555 }, opts);
    for (const p of out.points) expect(p.x).toBeCloseTo(300.5, 0);
  });

  // The correction this convention forces: on a drawing that breaks its
  // crossings, an UNBROKEN meeting means the pipes really do join, so a
  // branch there is legitimate. Treating it as a crossing refuses real
  // connections.
  it("treats an unbroken meeting as a connection it may turn at", () => {
    const r = board(700, 600);
    for (let i = 0; i < 5; i++) hLine(r, 80 + i * 90, 40, 560);
    brokenVertical(r, 300, 40, 560, [80, 170, 260, 350, 440]);
    // A second vertical that does NOT break at y=260 — it connects there.
    vLine(r, 480, 260, 560);
    const net = buildNetwork(extractSegments(r, opts), opts);
    expect(net.crossingStyle).toBe("break");
    const out = tracePipe(net, { x: 45, y: 261 }, { x: 481, y: 555 }, opts);
    expect(out.ok).toBe(true);
    expect(out.turns).toBe(1);
  });
});

// THE wrong-pipe scenario, and the one the user named first: tight clustered
// lines. A pipe interrupted by a valve, with an unrelated neighbour running
// 12px away. If endpoint bridging is allowed to connect any two stroke ends
// that happen to be close, the search steps off the traced pipe onto its
// neighbour for free and returns a confident straight route down the WRONG
// line. Refusing is the correct answer here; a confident wrong answer is the
// one outcome this module exists to prevent.
describe("clustered parallel lines", () => {
  const opts = { minRun: 10, alignTolerance: 4 };

  it("will not hop onto a neighbouring pipe through a valve gap", () => {
    const r = board(600, 300);
    hLine(r, 100, 20, 200);          // pipe A, first half
    hLine(r, 100, 230, 400);         // pipe A, second half (30px valve gap)
    hLine(r, 112, 210, 480);         // pipe B — a different line, 12px away
    const net = buildNetwork(extractSegments(r, opts), opts);
    const out = tracePipe(net, { x: 25, y: 101 }, { x: 470, y: 113 }, opts);
    expect(out.ok).toBe(false);
  });

  it("still follows its own pipe through the same valve gap", () => {
    const r = board(600, 300);
    hLine(r, 100, 20, 200);
    hLine(r, 100, 230, 400);
    hLine(r, 112, 210, 480);
    const net = buildNetwork(extractSegments(r, opts), opts);
    const out = tracePipe(net, { x: 25, y: 101 }, { x: 395, y: 101 }, opts);
    expect(out.ok).toBe(true);
    expect(out.turns).toBe(0);
    for (const p of out.points) expect(p.y).toBeCloseTo(100.5, 0);
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

// Measured on the real Kern crude-unit sheet: of 771 extracted strokes only
// ~207 were pipe. The rest — border, title block, letter bars, bubble chords
// — were all first-class citizens of the network, and a border stroke is a
// 2,700px superhighway connecting everything to everything. Classification
// is what makes real-sheet traces stop wandering through the revision table.
describe("classifySegments", () => {
  const seg = (id, horizontal, a, b, c) => ({ id, horizontal, a, b, c, thickness: 2 });

  it("removes edge-to-edge frame strokes but keeps a long pipe", () => {
    const border = seg(0, true, 10, 990, 20);          // spans the full sheet
    const pipe = seg(1, true, 150, 850, 400);          // long, but starts inside
    const { pipe: kept, frame } = classifySegments([border, pipe], 1000, 800);
    expect(frame).toBe(1);
    expect(kept.map((s) => s.id)).toEqual([1]);
  });

  it("drops title-block strokes inside a bordered sheet, not on a bare one", () => {
    const borderTop = seg(0, true, 10, 990, 10);
    const borderBottom = seg(1, true, 10, 990, 780);
    const titleRule = seg(2, true, 500, 900, 760);     // inside the bottom strip
    const pipeRun = seg(3, true, 100, 600, 400);
    const bordered = classifySegments([borderTop, borderBottom, titleRule, pipeRun], 1000, 800);
    expect(bordered.margin).toBe(1);
    expect(bordered.pipe.map((s) => s.id)).toEqual([3]);
    // Same title-height stroke on a borderless raster is just a pipe.
    const bare = classifySegments([titleRule, pipeRun], 1000, 800);
    expect(bare.margin).toBe(0);
    expect(bare.pipe).toHaveLength(2);
  });

  it("drops a short stray but keeps a short stroke that continues", () => {
    const strayLetterBar = seg(0, true, 100, 118, 200);   // 18px, alone
    const pipeBefore = seg(1, true, 300, 500, 400);
    const shortAfterValve = seg(2, true, 530, 550, 400);  // 20px, same line as 1
    const { pipe, stray } = classifySegments(
      [strayLetterBar, pipeBefore, shortAfterValve], 1000, 800, { alignTolerance: 4, maxGap: 220 });
    expect(stray).toBe(1);
    expect(pipe.map((s) => s.id).sort()).toEqual([1, 2]);
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
