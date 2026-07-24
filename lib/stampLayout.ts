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

/** Neutral fallback when raster analysis isn't available (no DOM, render
 *  failure): the historical placements. */
export const FALLBACK_INK: PageInk = {
  corners: { br: 0, bl: 1, tr: 1, tl: 1 },
  topBand: 1,
  bottomBand: 0,
};

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
