// lib/stampLayout.ts
//
// The PURE math behind content-aware stamping — measured, never guessed.
// Split from lib/stamping.ts so every placement rule unit-tests without a
// PDF or a canvas.
//
// Why this exists: the first stamping pass used fixed coordinates and fixed
// font sizes. Real drawings punished it — long watermark strings ran off the
// page, footers overflowed narrow sheets, and the always-bottom-right QR sat
// on top of title blocks. Every function here takes measurements in and
// returns positions/sizes that provably fit.

export type Corner = "br" | "bl" | "tr" | "tl";

/** Ink densities (0..1 fraction of dark pixels) for a page's candidate
 *  regions, from the low-res raster analysis. */
export interface PageInk {
  corners: Record<Corner, number>;
  topBand: number;
  bottomBand: number;
}

// ─── Watermark: fit a rotated line inside the page ───────────────────────

export interface RotatedFit {
  size: number;
  /** Bounding box of the rotated run at that size. */
  boxW: number;
  boxH: number;
}

/**
 * Largest font size (≤ maxSize) at which a text run of width
 * `widthAt1pt * size` and height `size`, rotated by `angleDeg`, fits within
 * (maxWFrac·pageW, maxHFrac·pageH). Returns minSize even if it overflows —
 * the caller truncates the text instead of shrinking below legibility.
 */
export function fitRotatedTextSize(input: {
  widthAt1pt: number;
  pageW: number;
  pageH: number;
  angleDeg: number;
  maxWFrac?: number;
  maxHFrac?: number;
  maxSize?: number;
  minSize?: number;
}): RotatedFit {
  const {
    widthAt1pt, pageW, pageH, angleDeg,
    maxWFrac = 0.88, maxHFrac = 0.8, maxSize = 32, minSize = 8,
  } = input;
  const a = Math.abs(angleDeg) * (Math.PI / 180);
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const fits = (size: number) => {
    const w = widthAt1pt * size;
    const h = size;
    return (
      w * cos + h * sin <= pageW * maxWFrac &&
      w * sin + h * cos <= pageH * maxHFrac
    );
  };
  let size = maxSize;
  while (size > minSize && !fits(size)) size -= 1;
  const w = widthAt1pt * size;
  return { size, boxW: w * cos + size * sin, boxH: w * sin + size * cos };
}

/**
 * Start point (pdf-lib rotates around the text's baseline origin) that
 * CENTERS a run of `textW`×`textH` rotated by `angleDeg` on the page.
 */
export function centerRotatedText(input: {
  pageW: number;
  pageH: number;
  textW: number;
  textH: number;
  angleDeg: number;
}): { x: number; y: number } {
  const { pageW, pageH, textW, textH, angleDeg } = input;
  const t = angleDeg * (Math.PI / 180);
  // Baseline direction u and glyph-up direction v of the rotated run.
  const ux = Math.cos(t), uy = Math.sin(t);
  const vx = -Math.sin(t), vy = Math.cos(t);
  return {
    x: pageW / 2 - (textW * ux + textH * vx) / 2,
    y: pageH / 2 - (textW * uy + textH * vy) / 2,
  };
}

// ─── Footer: wrap to a measured width ────────────────────────────────────

/**
 * Greedy word-wrap using the caller's measure function (font width at the
 * chosen size). Words longer than maxWidth are hard-broken so no line can
 * ever overflow. Never returns an empty array for non-empty text.
 */
export function wrapToWidth(
  text: string,
  maxWidth: number,
  measure: (s: string) => number,
): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const lines: string[] = [];
  let line = "";
  const pushWord = (word: string) => {
    // Hard-break an over-long single word.
    while (measure(word) > maxWidth && word.length > 1) {
      let cut = word.length - 1;
      while (cut > 1 && measure(word.slice(0, cut)) > maxWidth) cut -= 1;
      if (line) { lines.push(line); line = ""; }
      lines.push(word.slice(0, cut));
      word = word.slice(cut);
    }
    const candidate = line ? `${line} ${word}` : word;
    if (measure(candidate) <= maxWidth || !line) line = candidate;
    else { lines.push(line); line = word; }
  };
  for (const w of words) pushWord(w);
  if (line) lines.push(line);
  return lines;
}

// ─── Region choice: put ink where the page has none ──────────────────────

/** Preference when densities tie (within `bias`): document-control
 *  convention reads bottom-right first, so prefer it, then bottom-left. */
const CORNER_PREFERENCE: Corner[] = ["br", "bl", "tr", "tl"];

export function pickQrCorner(corners: Record<Corner, number>, bias = 0.03): Corner {
  let best: Corner = "br";
  let bestScore = Number.POSITIVE_INFINITY;
  CORNER_PREFERENCE.forEach((c, i) => {
    // Later preferences must beat earlier ones by more than the bias.
    const score = corners[c] + i * bias;
    if (score < bestScore) { bestScore = score; best = c; }
  });
  return best;
}

/** Footer edge: bottom by convention unless the bottom band is clearly
 *  busier than the top (title blocks live at the bottom of most drawings). */
export function pickFooterEdge(topBand: number, bottomBand: number, margin = 0.06): "top" | "bottom" {
  return bottomBand > topBand + margin ? "top" : "bottom";
}

/**
 * Blind placement (SHR-8) — when raster analysis isn't available: no DOM,
 * which is EVERY server route (the share download, the transmittal portal),
 * or a render failure. The old fallback asserted that the bottom-right corner
 * and the bottom band were blank — on an engineering drawing that is the
 * title block (ISO 7200 and ASME Y14.1 both put it at the bottom-right), and
 * the top-right usually carries the revision block. Blind, nothing is drawn
 * on the bottom band or on the right-hand side of the top band:
 *   * the QR goes top-left — the one corner neither standard gives a block;
 *   * the footer runs along the TOP from just right of the QR, in EVERY
 *     orientation, and titleBlockReserve() keeps it clear of the right-hand
 *     (revision) block. The bottom is never used blind: a title block sits
 *     there on landscape and portrait sheets alike, and on a portrait sheet
 *     it takes most of the width (ASME A: 450 of 540 pt inside the border;
 *     ISO A4: 510 of 547), so no bottom footer clears it.
 * The values are pseudo-densities that steer pickQrCorner / pickFooterEdge.
 * The page size is accepted for the callers' symmetry with the measured
 * path; blind, every orientation places the same way.
 */
export function fallbackInk(_pageW: number, _pageH: number): PageInk {
  return {
    corners: { br: 1, bl: 1, tr: 1, tl: 0 },
    topBand: 0,
    bottomBand: 1,
  };
}

/** Blind placement: how much of the top band's right-hand side the footer
 *  leaves to the revision block (ASME Y14.35 puts it top-right; ≈ 7 in /
 *  504 pt on a large sheet). Sized like the widest title block — ASME Y14.1
 *  ≈ 6¼ in (450 pt), ISO 7200 at most 180 mm (≈ 510 pt) — capped at 520 pt
 *  and at half the sheet so a small page keeps room for the footer. On a
 *  portrait sheet the half is the bound (306 pt on Letter): a revision block
 *  wider than that can still meet the footer's longest line. */
export function titleBlockReserve(pageW: number): number {
  return Math.min(pageW * 0.5, 520);
}

// ─── Page rotation: measure and draw in ONE space (PHYS-12 / PKG-13) ─────
//
// A page's /Rotate turns it CLOCKWISE for display and print. pdf.js applies
// it — the ink analysis measures the page AS DISPLAYED — while pdf-lib draws
// in the page's unrotated user space (MediaBox). So every mark is laid out in
// DISPLAY space (the functions above take display width/height) and each
// anchor point is mapped into user space here, its angle advanced by the
// rotation, so the QR lands in the corner the analysis chose and every mark
// reads upright on the printed sheet.

/** A page's /Rotate, normalized to the four values PDF allows. */
export type PageRotation = 0 | 90 | 180 | 270;

export function normalizeRotation(angleDeg: number): PageRotation {
  const quarterTurns = Math.round((Number.isFinite(angleDeg) ? angleDeg : 0) / 90);
  return ((((quarterTurns % 4) + 4) % 4) * 90) as PageRotation;
}

/** The page as displayed and printed: a quarter turn swaps the MediaBox's sides. */
export function displaySize(
  mediaW: number, mediaH: number, rotation: PageRotation,
): { width: number; height: number } {
  return rotation === 90 || rotation === 270
    ? { width: mediaH, height: mediaW }
    : { width: mediaW, height: mediaH };
}

/** A point in DISPLAY space (origin at the bottom-left of the page as the
 *  reader sees it, y up) → the page's unrotated user space, where pdf-lib
 *  draws. A mark drawn at that point must also be rotated by `rotation`
 *  degrees (counter-clockwise in user space) to read upright. */
export function displayToUser(
  x: number, y: number, mediaW: number, mediaH: number, rotation: PageRotation,
): { x: number; y: number } {
  switch (rotation) {
    case 90: return { x: mediaW - y, y: x };
    case 180: return { x: mediaW - x, y: mediaH - y };
    case 270: return { x: y, y: mediaH - x };
    default: return { x, y };
  }
}

// ─── QR geometry: a plate that can never leave the page ──────────────────

export interface QrPlacement {
  qrX: number;
  qrY: number;
  qrSize: number;
  plate: { x: number; y: number; w: number; h: number };
  /** Baseline position for the "SCAN TO VERIFY" caption. */
  labelX: number;
  labelY: number;
  labelSize: number;
}

export function placeQr(input: {
  pageW: number;
  pageH: number;
  corner: Corner;
}): QrPlacement {
  const { pageW, pageH, corner } = input;
  const qrSize = Math.max(40, Math.min(64, pageW / 12));
  const labelSize = Math.max(5, qrSize * 0.11);
  const labelGap = labelSize + 3;
  const pad = 3;
  const marginX = Math.max(8, pageW * 0.025);
  const marginY = Math.max(8, pageH * 0.02);

  const plateW = qrSize + pad * 2;
  const plateH = qrSize + pad * 2 + labelGap;

  const left = corner === "bl" || corner === "tl";
  const bottom = corner === "bl" || corner === "br";
  const plateX = left ? marginX : pageW - marginX - plateW;
  const plateY = bottom ? marginY : pageH - marginY - plateH;

  // Caption sits inside the plate, under the code.
  const qrX = plateX + pad;
  const qrY = plateY + pad + labelGap;
  return {
    qrX, qrY, qrSize,
    plate: { x: plateX, y: plateY, w: plateW, h: plateH },
    labelX: plateX + pad,
    labelY: plateY + pad,
    labelSize,
  };
}
