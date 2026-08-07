// lib/glyphIngest.ts — reading a reference sheet as SHAPES, not words.
//
// Every library in this app assumes a document is words: extract text, chunk,
// embed, retrieve. Some documents break that assumption completely. A symbol
// key, a line-style key, a weld-symbol chart, an electrical symbol sheet, a
// map legend — their content is DRAWN. Chunking the text off one of those
// yields a list of names with nothing attached to them, which is why pointing
// an AI at a legend has never taught it anything.
//
// This module ingests such a sheet the way it is actually organized: a grid of
// cells, each pairing a DRAWN GLYPH with a WRITTEN NAME. It finds the cells,
// separates the drawing from the caption, and MEASURES the drawing.
//
// THE DIVISION OF LABOUR, which is the whole design:
//
//     geometry localizes and measures — a model only ever names.
//
// Nothing here asks a model where a symbol is, how big its gap is, how many
// strokes it has, or what its dash period is. Those are pixel facts, and a
// model asked for them will confabulate plausible numbers. It is asked
// exactly one kind of question — "what is this called" — which is the one
// thing it is genuinely better at than any measurement.
//
// Deliberately discipline-neutral. Nothing in this file knows what a valve is.

import type { Raster } from "@/lib/pipeTrace";

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

const boxRight = (b: Box) => b.x + b.w;
const boxBottom = (b: Box) => b.y + b.h;

/** Ink counts per row (or column) of a region — the classic projection
 *  profile. Cheap, and it is what exposes a page's underlying grid whether
 *  or not the grid is ruled. */
export function projection(raster: Raster, box: Box, axis: "row" | "col"): number[] {
  const { width, ink } = raster;
  const n = axis === "row" ? box.h : box.w;
  const out = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    let count = 0;
    if (axis === "row") {
      const y = box.y + i;
      for (let x = box.x; x < boxRight(box); x++) if (ink[y * width + x]) count++;
    } else {
      const x = box.x + i;
      for (let y = box.y; y < boxBottom(box); y++) if (ink[y * width + x]) count++;
    }
    out[i] = count;
  }
  return out;
}

/** Runs of inked lines separated by gutters of at least `minGutter` blank
 *  ones. A legend's rows and columns are exactly this: content separated by
 *  deliberate whitespace, ruled or not. */
export function bands(profile: number[], minGutter: number): Array<{ from: number; to: number }> {
  const out: Array<{ from: number; to: number }> = [];
  let start = -1;
  let blank = 0;
  for (let i = 0; i < profile.length; i++) {
    if (profile[i] > 0) {
      if (start < 0) start = i - Math.min(blank, 0);
      if (start < 0) start = i;
      blank = 0;
    } else if (start >= 0) {
      blank++;
      if (blank >= minGutter) {
        out.push({ from: start, to: i - blank });
        start = -1;
        blank = 0;
      }
    }
  }
  if (start >= 0) out.push({ from: start, to: profile.length - 1 });
  return out.filter((b) => b.to >= b.from);
}

/** Interior blank runs in a profile — the sheet's own spacing vocabulary. */
function blankRuns(profile: number[]): number[] {
  const runs: number[] = [];
  let run = 0;
  let sawInk = false;
  for (const v of profile) {
    if (v > 0) {
      if (run > 0 && sawInk) runs.push(run);
      run = 0;
      sawInk = true;
    } else if (sawInk) run++;
  }
  return runs;
}

/** Pick the gutter that separates ENTRIES from the gutter that merely
 *  separates a symbol from its own caption.
 *
 *  A fixed threshold cannot do this: on a real sheet the space between a
 *  glyph and the words under it is routinely WIDER than the space between
 *  two columns of entries. What is reliable is that a legend spaces things
 *  consistently, so the run lengths cluster — and the split belongs at the
 *  biggest jump between clusters, whatever its absolute size. */
export function chooseGutter(profile: number[], minGutter: number): number {
  const runs = [...new Set(blankRuns(profile))].sort((a, b) => a - b);
  if (runs.length <= 1) return minGutter;
  let best = minGutter;
  let bestRatio = 1.6;                    // below this the two are one cluster
  for (let i = 1; i < runs.length; i++) {
    const ratio = runs[i] / runs[i - 1];
    if (ratio > bestRatio) {
      bestRatio = ratio;
      best = runs[i];
    }
  }
  return Math.max(minGutter, best);
}

export interface CellOptions {
  /** Blank lines that count as a deliberate separation rather than the space
   *  inside a glyph. Scaled from render width by cellOptionsFor(). */
  minGutter?: number;
  /** Cells smaller than this in either dimension are noise, not entries. */
  minCell?: number;
}

/** Tuned against a 3000px-wide render, scaled to whatever the page is. */
export function cellOptionsFor(width: number, opts: CellOptions = {}): Required<CellOptions> {
  const k = width / 3000;
  return {
    minGutter: opts.minGutter ?? Math.max(3, Math.round(10 * k)),
    minCell: opts.minCell ?? Math.max(6, Math.round(24 * k)),
  };
}

/** Split a reference sheet into its entry cells.
 *
 *  Rows first, then columns WITHIN each row — not a global column split. A
 *  legend is very often ragged: three columns at the top, two below, a full
 *  width note band in the middle. Splitting columns globally smears those
 *  together and every downstream pairing inherits the error. */
export function findCells(raster: Raster, region?: Box, opts: CellOptions = {}): Box[] {
  const { minGutter, minCell } = cellOptionsFor(raster.width, opts);
  const area: Box = region ?? { x: 0, y: 0, w: raster.width, h: raster.height };
  const cells: Box[] = [];
  const rowProfile = projection(raster, area, "row");
  for (const row of bands(rowProfile, chooseGutter(rowProfile, minGutter))) {
    const rowBox: Box = {
      x: area.x, y: area.y + row.from,
      w: area.w, h: row.to - row.from + 1,
    };
    if (rowBox.h < minCell) continue;
    const colProfile = projection(raster, rowBox, "col");
    const cols = bands(colProfile, chooseGutter(colProfile, minGutter));
    for (const col of cols) {
      const cell: Box = {
        x: rowBox.x + col.from, y: rowBox.y,
        w: col.to - col.from + 1, h: rowBox.h,
      };
      if (cell.w < minCell || cell.h < minCell) continue;
      cells.push(cell);
    }
  }
  return cells;
}

/** One blob of connected ink. */
export interface Component {
  box: Box;
  /** Inked pixels — distinguishes a dense letterform from an open outline. */
  pixels: number;
}

/** Connected ink blobs inside a box, 8-connected. Iterative flood fill: a
 *  recursive one blows the stack on a full-page raster. */
export function components(raster: Raster, box: Box, maxComponents = 4000): Component[] {
  const { width, ink } = raster;
  const seen = new Uint8Array(box.w * box.h);
  const out: Component[] = [];
  const stack: number[] = [];
  for (let sy = 0; sy < box.h; sy++) {
    for (let sx = 0; sx < box.w; sx++) {
      const seed = sy * box.w + sx;
      if (seen[seed] || !ink[(box.y + sy) * width + (box.x + sx)]) continue;
      let minX = sx, maxX = sx, minY = sy, maxY = sy, pixels = 0;
      stack.length = 0;
      stack.push(seed);
      seen[seed] = 1;
      while (stack.length > 0) {
        const cur = stack.pop()!;
        const cx = cur % box.w;
        const cy = (cur - cx) / box.w;
        pixels++;
        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = cx + dx, ny = cy + dy;
            if (nx < 0 || ny < 0 || nx >= box.w || ny >= box.h) continue;
            const ni = ny * box.w + nx;
            if (seen[ni] || !ink[(box.y + ny) * width + (box.x + nx)]) continue;
            seen[ni] = 1;
            stack.push(ni);
          }
        }
      }
      out.push({
        box: { x: box.x + minX, y: box.y + minY, w: maxX - minX + 1, h: maxY - minY + 1 },
        pixels,
      });
      if (out.length >= maxComponents) return out;
    }
  }
  return out;
}

export interface CellParts {
  cell: Box;
  /** The drawn symbol — null when the cell is caption-only (a note band). */
  glyph: Box | null;
  /** The written caption — null when the cell is symbol-only. */
  caption: Box | null;
}

/** Separate the DRAWING from the WRITING inside a cell.
 *
 *  Text is recognised structurally rather than read: letterforms are many
 *  small components of similar height sitting on a shared baseline. That
 *  holds for any alphabet and any drafting font, and it never needs OCR —
 *  which matters because on an SHX export there is no text layer to consult
 *  and running OCR to find text you are about to crop anyway is backwards. */
export function splitCell(raster: Raster, cell: Box): CellParts {
  const comps = components(raster, cell);
  if (comps.length === 0) return { cell, glyph: null, caption: null };

  // Character-sized components: small, and small RELATIVE to the cell.
  const heights = comps.map((c) => c.box.h).sort((a, b) => a - b);
  const medianH = heights[Math.floor(heights.length / 2)];
  const textLike = comps.filter((c) =>
    c.box.h <= Math.max(medianH * 1.6, cell.h * 0.42) && c.box.w <= cell.w * 0.30);

  // A caption is a RUN of such components sharing a baseline. Two stray marks
  // are not a word, and a single wide component is a drawing.
  const byBaseline = new Map<number, Component[]>();
  const tol = Math.max(2, Math.round(cell.h * 0.12));
  for (const c of textLike) {
    const key = Math.round(boxBottom(c.box) / tol);
    byBaseline.set(key, [...(byBaseline.get(key) ?? []), c]);
  }
  let caption: Component[] = [];
  for (const group of byBaseline.values()) {
    if (group.length >= 3 && group.length > caption.length) caption = group;
  }

  const captionSet = new Set(caption);
  const drawing = comps.filter((c) => !captionSet.has(c));
  return {
    cell,
    glyph: drawing.length > 0 ? union(drawing.map((c) => c.box)) : null,
    caption: caption.length > 0 ? union(caption.map((c) => c.box)) : null,
  };
}

function union(boxes: Box[]): Box {
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  const r = Math.max(...boxes.map(boxRight));
  const b = Math.max(...boxes.map(boxBottom));
  return { x, y, w: r - x, h: b - y };
}

/** Everything measurable about a drawn glyph — the load-bearing part of a
 *  compiled vocabulary entry, and the part a model must never supply.
 *
 *  These are what let a downstream consumer MATCH: a dash period says which
 *  line style this is, stroke counts and closure say whether a symbol is an
 *  outline or a body, and symmetry separates a bowtie from an arrow. */
export interface GlyphDescriptor {
  width: number;
  height: number;
  aspect: number;
  /** Inked fraction of the bounding box — an outline is sparse, a filled
   *  triangle is dense. */
  inkRatio: number;
  /** Separate blobs; a dashed line is many, a solid one is one. */
  componentCount: number;
  /** Median blank run along the glyph's long axis, 0 when solid. This is how
   *  a line-style key teaches a tracer what "dashed" means on THIS drawing
   *  set rather than by assumption. */
  dashPeriod: number;
  /** Fraction of rows/cols whose ink is mirror-symmetric. */
  symmetryH: number;
  symmetryV: number;
}

export function describeGlyph(raster: Raster, box: Box): GlyphDescriptor {
  const { width, ink } = raster;
  const at = (x: number, y: number) => ink[(box.y + y) * width + (box.x + x)] === 1;

  let inked = 0;
  for (let y = 0; y < box.h; y++) for (let x = 0; x < box.w; x++) if (at(x, y)) inked++;

  // Dash period along the long axis: blank runs between ink runs on the
  // busiest line, which is the glyph's own spine.
  const horizontal = box.w >= box.h;
  const spineProfile = projection(raster, box, horizontal ? "col" : "row");
  const gaps: number[] = [];
  let run = 0, sawInk = false;
  for (const v of spineProfile) {
    if (v > 0) {
      if (run > 0 && sawInk) gaps.push(run);
      run = 0;
      sawInk = true;
    } else if (sawInk) run++;
  }
  gaps.sort((a, b) => a - b);
  const dashPeriod = gaps.length > 0 ? gaps[Math.floor(gaps.length / 2)] : 0;

  let symH = 0, symV = 0;
  for (let y = 0; y < box.h; y++) {
    let same = 0;
    for (let x = 0; x < box.w; x++) if (at(x, y) === at(box.w - 1 - x, y)) same++;
    if (same === box.w) symH++;
  }
  for (let x = 0; x < box.w; x++) {
    let same = 0;
    for (let y = 0; y < box.h; y++) if (at(x, y) === at(x, box.h - 1 - y)) same++;
    if (same === box.h) symV++;
  }

  return {
    width: box.w,
    height: box.h,
    aspect: box.h > 0 ? box.w / box.h : 0,
    inkRatio: box.w * box.h > 0 ? inked / (box.w * box.h) : 0,
    componentCount: components(raster, box).length,
    dashPeriod,
    symmetryH: box.h > 0 ? symH / box.h : 0,
    symmetryV: box.w > 0 ? symV / box.w : 0,
  };
}

export interface GlyphEntry {
  cell: Box;
  glyph: Box;
  caption: Box | null;
  descriptor: GlyphDescriptor;
}

/** The whole shape-ingestion pass over a reference sheet: find the entries,
 *  split drawing from caption, measure every drawing.
 *
 *  What comes back is everything a naming step needs (crops) and everything a
 *  matching step needs (measurements) — with no model having been consulted. */
export function ingestReferenceSheet(
  raster: Raster, region?: Box, opts: CellOptions = {},
): GlyphEntry[] {
  const out: GlyphEntry[] = [];
  for (const cell of findCells(raster, region, opts)) {
    const parts = splitCell(raster, cell);
    if (!parts.glyph) continue;            // caption-only band: a note, not an entry
    out.push({
      cell,
      glyph: parts.glyph,
      caption: parts.caption,
      descriptor: describeGlyph(raster, parts.glyph),
    });
  }
  return out;
}
