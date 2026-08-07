// Shape ingestion is the claim that a reference sheet can be read as drawings
// rather than words. These build synthetic legend sheets where the right
// answer is known exactly, and assert the geometry — never a model — supplies
// every number.

import { describe, it, expect } from "vitest";
import {
  projection, bands, findCells, splitCell, components, describeGlyph,
  ingestReferenceSheet, type Box,
} from "../glyphIngest";
import type { Raster } from "../pipeTrace";

function board(w: number, h: number): Raster {
  return { width: w, height: h, ink: new Uint8Array(w * h) };
}
function rect(r: Raster, b: Box, fill = false) {
  for (let y = b.y; y < b.y + b.h; y++) {
    for (let x = b.x; x < b.x + b.w; x++) {
      const edge = x === b.x || x === b.x + b.w - 1 || y === b.y || y === b.y + b.h - 1;
      if (fill || edge) r.ink[y * r.width + x] = 1;
    }
  }
}
function hRun(r: Raster, y: number, x1: number, x2: number, thick = 2) {
  for (let t = 0; t < thick; t++) {
    for (let x = x1; x <= x2; x++) r.ink[(y + t) * r.width + x] = 1;
  }
}
function vRun(r: Raster, x: number, y1: number, y2: number, thick = 2) {
  for (let t = 0; t < thick; t++) {
    for (let y = y1; y <= y2; y++) r.ink[y * r.width + (x + t)] = 1;
  }
}
/** A caption: small blobs of VARYING width on a shared baseline, the way
 *  real letterforms sit — uniform blocks would be indistinguishable from a
 *  dash chain and would make the tests easier than the drawings. */
function word(r: Raster, x: number, y: number, letters = 6) {
  for (let i = 0; i < letters; i++) {
    rect(r, { x: x + i * 7, y, w: 3 + (i % 3), h: 8 }, true);
  }
}

describe("projection and bands", () => {
  it("counts ink per row and finds content separated by gutters", () => {
    const r = board(100, 60);
    hRun(r, 10, 10, 80);
    hRun(r, 40, 10, 80);
    const prof = projection(r, { x: 0, y: 0, w: 100, h: 60 }, "row");
    expect(prof[10]).toBe(71);
    expect(prof[25]).toBe(0);
    const b = bands(prof, 5);
    expect(b).toHaveLength(2);
    expect(b[0].from).toBe(10);
    expect(b[1].from).toBe(40);
  });

  it("does not split on a gap smaller than the gutter", () => {
    const r = board(100, 60);
    hRun(r, 10, 10, 80);
    hRun(r, 13, 10, 80);           // 1px apart — same glyph, not two rows
    expect(bands(projection(r, { x: 0, y: 0, w: 100, h: 60 }, "row"), 5)).toHaveLength(1);
  });
});

describe("findCells", () => {
  it("splits a legend grid into one cell per entry", () => {
    const r = board(600, 400);
    // 2 rows x 3 columns of entries, generous gutters.
    for (let row = 0; row < 2; row++) {
      for (let col = 0; col < 3; col++) {
        const x = 40 + col * 180, y = 40 + row * 160;
        hRun(r, y + 20, x, x + 60);        // the drawn symbol
        word(r, x, y + 50);                 // its caption
      }
    }
    const cells = findCells(r, undefined, { minGutter: 12, minCell: 20 });
    expect(cells).toHaveLength(6);
  });

  // A legend is routinely ragged — three columns up top, a full-width note
  // band below. Splitting columns globally smears those together.
  it("splits columns within each row, so a ragged sheet survives", () => {
    const r = board(600, 400);
    for (let col = 0; col < 3; col++) {
      const x = 40 + col * 180;
      hRun(r, 60, x, x + 60);
      word(r, x, 90);
    }
    // A full-width two-line note band underneath.
    word(r, 40, 240, 40);
    word(r, 40, 254, 36);
    const cells = findCells(r, undefined, { minGutter: 12, minCell: 20 });
    expect(cells.length).toBe(4);
    const wide = cells.filter((c) => c.w > 250);
    expect(wide).toHaveLength(1);           // the note band stayed whole
  });
});

describe("components", () => {
  it("finds separate ink blobs and their extents", () => {
    const r = board(200, 100);
    rect(r, { x: 10, y: 10, w: 30, h: 20 });
    rect(r, { x: 100, y: 40, w: 25, h: 25 }, true);
    const comps = components(r, { x: 0, y: 0, w: 200, h: 100 });
    expect(comps).toHaveLength(2);
    const solid = comps.find((c) => c.pixels === 625)!;
    expect(solid.box).toEqual({ x: 100, y: 40, w: 25, h: 25 });
  });
});

describe("splitCell", () => {
  it("separates the drawn symbol from its written caption", () => {
    const r = board(300, 200);
    const cell: Box = { x: 20, y: 20, w: 200, h: 120 };
    hRun(r, 40, 30, 120, 3);                // symbol: one wide stroke
    word(r, 30, 90, 8);                     // caption: 8 letter blobs
    const parts = splitCell(r, cell);
    expect(parts.glyph).toBeTruthy();
    expect(parts.caption).toBeTruthy();
    // The caption sits below the symbol and never overlaps it.
    expect(parts.caption!.y).toBeGreaterThan(parts.glyph!.y + parts.glyph!.h - 1);
  });

  it("reports a caption-only band as having no glyph", () => {
    const r = board(300, 200);
    word(r, 30, 40, 10);
    const parts = splitCell(r, { x: 20, y: 20, w: 260, h: 60 });
    expect(parts.glyph).toBeNull();
    expect(parts.caption).toBeTruthy();
  });

  it("treats a lone wide mark as a drawing, not text", () => {
    const r = board(300, 200);
    hRun(r, 50, 30, 250, 3);
    const parts = splitCell(r, { x: 20, y: 20, w: 260, h: 80 });
    expect(parts.glyph).toBeTruthy();
    expect(parts.caption).toBeNull();
  });
});

describe("describeGlyph", () => {
  // The measurement that lets a line-style key teach a tracer what "dashed"
  // means on THIS drawing set instead of by assumption.
  it("measures dash period on a dashed line and zero on a solid one", () => {
    const r = board(300, 60);
    for (let i = 0; i < 6; i++) hRun(r, 20, 20 + i * 40, 20 + i * 40 + 24, 2);
    const dashed = describeGlyph(r, { x: 20, y: 20, w: 244, h: 2 });
    expect(dashed.dashPeriod).toBeGreaterThan(10);
    expect(dashed.componentCount).toBe(6);

    const s = board(300, 60);
    hRun(s, 20, 20, 264, 2);
    const solid = describeGlyph(s, { x: 20, y: 20, w: 244, h: 2 });
    expect(solid.dashPeriod).toBe(0);
    expect(solid.componentCount).toBe(1);
  });

  it("separates a sparse outline from a filled body by ink ratio", () => {
    const r = board(200, 200);
    rect(r, { x: 20, y: 20, w: 60, h: 60 });
    const outline = describeGlyph(r, { x: 20, y: 20, w: 60, h: 60 });
    const f = board(200, 200);
    rect(f, { x: 20, y: 20, w: 60, h: 60 }, true);
    const filled = describeGlyph(f, { x: 20, y: 20, w: 60, h: 60 });
    expect(outline.inkRatio).toBeLessThan(0.25);
    expect(filled.inkRatio).toBeCloseTo(1, 1);
  });

  it("reports symmetry, which separates a bowtie from an arrow", () => {
    const r = board(120, 120);
    rect(r, { x: 20, y: 20, w: 60, h: 60 });     // a square: symmetric both ways
    const d = describeGlyph(r, { x: 20, y: 20, w: 60, h: 60 });
    expect(d.symmetryH).toBeCloseTo(1, 1);
    expect(d.symmetryV).toBeCloseTo(1, 1);
    expect(d.aspect).toBeCloseTo(1, 1);
  });
});

// Every case below is one the adversarial review produced by RUNNING the
// first version, not reading it. Each returned one plausible-looking entry
// instead of an error, which is the worst shape a failure can take.
describe("layouts that broke the first version", () => {
  /** A legend drawn as a ruled table — the common case, and the one that
   *  collapsed to a single meaningless entry because a ruling puts ink in
   *  every gutter it crosses. */
  function ruledLegend(): Raster {
    const r = board(620, 380);
    rect(r, { x: 30, y: 30, w: 560, h: 320 });          // table frame
    for (let i = 1; i < 2; i++) hRun(r, 30 + i * 160, 30, 589, 1);
    for (let i = 1; i < 3; i++) vRun(r, 30 + i * 186, 30, 349, 1);
    for (let row = 0; row < 2; row++) {
      for (let col = 0; col < 3; col++) {
        const x = 60 + col * 186, y = 60 + row * 160;
        hRun(r, y + 15, x, x + 70, 3);
        word(r, x, y + 60);
      }
    }
    return r;
  }

  it("reads a RULED legend as its cells instead of one blob", () => {
    const cells = findCells(ruledLegend(), undefined, { minGutter: 10, minCell: 20 });
    expect(cells.length).toBeGreaterThanOrEqual(6);
  });

  it("sees inside a drawing border instead of calling the sheet one entry", () => {
    const r = board(620, 380);
    rect(r, { x: 10, y: 10, w: 600, h: 360 });          // sheet border only
    for (let col = 0; col < 3; col++) {
      const x = 60 + col * 180;
      hRun(r, 90, x, x + 70, 3);
      word(r, x, 130);
    }
    const cells = findCells(r, undefined, { minGutter: 10, minCell: 20 });
    expect(cells.length).toBeGreaterThanOrEqual(3);
  });

  // One speck in a gutter used to weld the sheet into a single cell and
  // drop every entry.
  it("survives a stray speck in a gutter", () => {
    for (const [sx, sy] of [[300, 60], [45, 200], [590, 300]] as const) {
      const r = board(600, 400);
      for (let row = 0; row < 2; row++) {
        for (let col = 0; col < 3; col++) {
          const x = 40 + col * 180, y = 40 + row * 160;
          hRun(r, y + 20, x, x + 60, 3);
          word(r, x, y + 60);
        }
      }
      r.ink[sy * r.width + sx] = 1;                     // the speck
      const cells = findCells(r, undefined, { minGutter: 12, minCell: 20 });
      expect(cells.length, `speck at ${sx},${sy}`).toBe(6);
    }
  });

  // The inversion: a row of dashes read as a word, so the caption came back
  // as the drawn line and the glyph as the printed name.
  it("does not mistake a dashed line for a caption", () => {
    const r = board(400, 160);
    for (let i = 0; i < 8; i++) hRun(r, 40, 25 + i * 20, 25 + i * 20 + 12, 3);
    word(r, 25, 90, 4);
    const parts = splitCell(r, { x: 15, y: 20, w: 360, h: 120 });
    expect(parts.glyph).toBeTruthy();
    expect(parts.caption).toBeTruthy();
    // The glyph is the wide dashed run; the caption is the short word.
    expect(parts.glyph!.w).toBeGreaterThan(parts.caption!.w);
    expect(parts.glyph!.y).toBeLessThan(parts.caption!.y);
  });

  it("keeps a two-letter caption out of the glyph", () => {
    const r = board(300, 220);
    rect(r, { x: 40, y: 30, w: 50, h: 40 });
    word(r, 40, 110, 2);                                 // "FC"
    const parts = splitCell(r, { x: 20, y: 20, w: 260, h: 160 });
    expect(parts.caption).toBeTruthy();
    expect(parts.glyph!.h).toBeLessThan(60);             // not stretched to the caption
  });

  it("clamps a region that runs off the page instead of reading blanks", () => {
    const r = board(100, 100);
    hRun(r, 50, 10, 90, 3);
    expect(() => findCells(r, { x: 0, y: 0, w: 100, h: 200 })).not.toThrow();
    expect(() => findCells(r, { x: -50, y: -50, w: 400, h: 400 })).not.toThrow();
  });
});

describe("ingestReferenceSheet", () => {
  it("returns a measured entry per drawn symbol, with no model involved", () => {
    const r = board(700, 500);
    for (let row = 0; row < 2; row++) {
      for (let col = 0; col < 3; col++) {
        const x = 50 + col * 210, y = 50 + row * 190;
        if (col === 0) hRun(r, y + 20, x, x + 80, 3);                 // solid line
        else if (col === 1) {                                          // dashed line
          for (let i = 0; i < 4; i++) hRun(r, y + 20, x + i * 22, x + i * 22 + 12, 3);
        } else rect(r, { x, y: y + 5, w: 50, h: 40 });                 // a box symbol
        word(r, x, y + 60);
      }
    }
    const entries = ingestReferenceSheet(r, undefined, { minGutter: 14, minCell: 20 });
    expect(entries).toHaveLength(6);
    for (const e of entries) {
      expect(e.glyph.w).toBeGreaterThan(0);
      expect(e.caption).toBeTruthy();
      expect(e.descriptor.width).toBe(e.glyph.w);
    }
    // The dashed entries are distinguishable from the solid ones by
    // measurement alone — which is the entire premise.
    const dashed = entries.filter((e) => e.descriptor.dashPeriod > 4);
    expect(dashed.length).toBe(2);
  });

  it("returns nothing for a blank sheet rather than inventing entries", () => {
    expect(ingestReferenceSheet(board(400, 400))).toHaveLength(0);
  });
});
