// lib/stamping.ts
//
// CONTENT-AWARE STAMPING — measured, never guessed.
//
// Every uncontrolled copy gets three marks; each one now proves it fits and
// avoids the drawing's own content, per page, whatever the sheet size or
// orientation:
//
//   * Diagonal watermark — font size computed from the MEASURED text width
//     so the rotated run always fits inside the page, centered. Long
//     user/email/date strings shrink (and finally truncate) instead of
//     running off the edge.
//   * Footer lines — word-wrapped to the page width (minus the QR plate
//     when they share an edge) and drawn on whichever horizontal band (top
//     or bottom) the page actually has free — title blocks usually own the
//     bottom, so busy bottoms push the footer up top.
//   * Verify-QR — placed in the EMPTIEST corner of each page, found by
//     rasterizing the page at thumbnail size (pdf.js) and comparing ink
//     density in the four corners. White backing plate, clamped on-page.
//
// The raster analysis is best-effort: no DOM (every server route), worker
// failure, or a page that won't render falls back to the BLIND placement —
// title-block-aware (SHR-8): QR top-left, footer along the top beside it in
// every orientation, nothing on the bottom band (the title block's) or on the
// right-hand side of the top band (the revision block's)
// (lib/stampLayout.ts fallbackInk / titleBlockReserve).
// The pure math lives in lib/stampLayout.ts (unit-tested).
//
// Rotated sheets (PHYS-12 / PKG-13): pdf.js measures a page AS DISPLAYED
// (its /Rotate applied); pdf-lib draws in the unrotated MediaBox. Every mark
// is therefore laid out in display space and mapped into user space through
// one DisplayFrame per page, so the analysis and the drawing never disagree
// about which corner is which.
//
// Stamp text (PHYS-15): the font is pdf-lib's standard Helvetica-Bold, whose
// WinAnsi encoding refuses any other character ("WinAnsi cannot encode …").
// Every text the stamp draws goes through ONE helper, stampText(): a
// character the font prints is drawn as typed (so a stamp that printed
// before is drawn byte for byte as before), and any other is drawn in a form
// the font prints — a Unicode hyphen or minus as "-", a Greek delta as
// "Delta", a prime as a straight quote, other whitespace as a space, else a
// visible "?" — never dropped. A format character (General_Category Cf: a
// zero-width space or joiner, a word joiner, a byte-order mark), which has
// no glyph, is removed and named instead. What was replaced or removed is
// printed on the copy itself (stampTextNote) and returned to the caller.

import { PDFDocument, rgb, StandardFonts, degrees, PDFFont, PDFPage, type Rotation } from "pdf-lib";
import {
  fitRotatedTextSize, centerRotatedText, wrapToWidth,
  pickQrCorner, pickFooterEdge, placeQr,
  normalizeRotation, displaySize, displayToUser,
  fallbackInk, titleBlockReserve, type PageInk, type Corner,
} from "@/lib/stampLayout";

/** PHYS-9: what a stamped copy IS. A stamped copy is never a controlled copy
 *  — a controlled copy is the unstamped pass-through to the checkout holder
 *  (lib/downloads.ts determineControlState) — so there is no "controlled"
 *  member. Neither mark the stamper derives can call the copy a CONTROLLED
 *  COPY: the footer's main line comes from this state (stampMainLine), and a
 *  caller's watermarkText that claims one is replaced by the state's
 *  watermark (stampWatermark). A caller's free-text footerNotice is printed
 *  as given. "review" marks a draft handed out for review. */
export type StampControlState = "uncontrolled" | "review";

const CONTROL_STATE_LABEL: Record<StampControlState, string> = {
  uncontrolled: "UNCONTROLLED COPY",
  review: "UNCONTROLLED COPY — REVIEW ONLY",
};
const CONTROL_STATE_WATERMARK: Record<StampControlState, string> = {
  uncontrolled: "UNCONTROLLED COPY",
  review: "REVIEW ONLY — DO NOT DISTRIBUTE",
};

export type StampOptions = {
  /** PHYS-9: the copy's control state (default "uncontrolled"). It drives
   *  the footer's main line and, when no watermarkText is given, the
   *  watermark — one value for both marks, so they cannot contradict. */
  controlState?: StampControlState;
  userLabel?: string;
  email?: string;
  timestamp?: Date;
  expiresAt?: Date | null;
  watermarkText?: string;
  /** Extra footer line — rev-at-issue + active-change warning. The paper
   *  copy on the desk should warn for itself. */
  footerNotice?: string;
  /** When set, a QR code linking here is stamped on every page so anyone in
   *  the field can scan the PRINT and instantly see whether it's still the
   *  current revision. Paper that verifies itself. */
  verifyUrl?: string;
  /** The original PDF bytes. When provided (and a DOM exists), each page is
   *  rasterized at thumbnail size to find its empty regions so the QR and
   *  footer land where the drawing ISN'T. Omit (or no DOM) → the blind,
   *  title-block-aware placement (SHR-8). */
  sourceBytes?: ArrayBuffer | Uint8Array;
  /** drafting-flow DF-P25: characters the CALLER already printed in a plain
   *  form inside `footerNotice` (a request deliverable's declaration folded —
   *  lib/ticketDeliverableCopy.ts plainCharacters), named in the copy's
   *  "Printed in plain characters" note after the stamper's own. Absent or
   *  empty: the note is exactly as before. */
  plainCharacters?: readonly StampTextMapping[];
};

function formatDate(d?: Date | null) {
  if (!d) return "";
  return d.toLocaleString();
}

/** PHYS-9: the footer's main line, DERIVED from the control state (it used to
 *  be a hardcoded literal that ignored every caller): "UNCONTROLLED COPY •
 *  Downloaded: <when> • Do Not Distribute". With no timestamp the
 *  "Downloaded:" segment is left out rather than printed empty. */
export function stampMainLine(state: StampControlState | undefined, timestamp?: Date | null): string {
  const label = CONTROL_STATE_LABEL[state ?? "uncontrolled"] ?? CONTROL_STATE_LABEL.uncontrolled;
  const parts = [label];
  if (timestamp) parts.push(`Downloaded: ${formatDate(timestamp)}`);
  parts.push("Do Not Distribute");
  return parts.join(" • ");
}

/** PHYS-11 / SHR-11: a page never tells its reader to scan a QR it does not
 *  carry. The share and transmittal routes already word their footer on
 *  whether a verify URL exists; this is the backstop for every caller — and
 *  for a QR whose generation failed. With no QR on the page an instruction
 *  to scan is removed (its sentence, or the clause after an em dash) and one
 *  plain instruction to confirm the revision takes its place. */
const SCAN_INSTRUCTION = /\bscan\s+(?:the\s+|this\s+)?(?:qr\b|code\b|to\s+verify\b)/i;
export function withoutScanInstruction(notice: string): string {
  if (!SCAN_INSTRUCTION.test(notice)) return notice;
  const kept: string[] = [];
  for (const sentence of notice.split(/(?<=[.!?])\s+/)) {
    if (!SCAN_INSTRUCTION.test(sentence)) { kept.push(sentence); continue; }
    // "<facts> — scan the QR to …": keep the facts.
    const clauses = sentence.split(/\s+[—–]\s+/);
    const at = clauses.findIndex((c) => SCAN_INSTRUCTION.test(c));
    const head = at > 0 ? clauses.slice(0, at).join(" — ").trim() : "";
    if (head) kept.push(/[.!?]$/.test(head) ? head : `${head}.`);
  }
  kept.push("Confirm the current revision before use.");
  return kept.join(" ");
}

/** PHYS-9: the watermark's leading text. A caller's watermarkText is printed
 *  as given, unless it claims a CONTROLLED COPY (the words without "UN"),
 *  which a stamped copy never is: then the control state's own watermark is
 *  printed instead. With no watermarkText the state supplies it. */
const CONTROLLED_COPY_CLAIM = /(?<!un)controlled\s+copy/i;
export function claimsControlledCopy(text: string): boolean {
  return CONTROLLED_COPY_CLAIM.test(text);
}
export function stampWatermark(watermarkText: string | undefined, state: StampControlState | undefined): string {
  const forState = CONTROL_STATE_WATERMARK[state ?? "uncontrolled"] ?? CONTROL_STATE_WATERMARK.uncontrolled;
  if (watermarkText === undefined) return forState;
  return claimsControlledCopy(watermarkText) ? forState : watermarkText;
}

// ─── PHYS-15: the stamp's text, in characters its font prints ──────────────

/** The characters the stamp's font (WinAnsi) prints beyond printable ASCII
 *  (0x20–0x7E) and Latin-1 (0xA0–0xFF): cp1252's 27 extras — the en and em
 *  dash, the curly quotes, the bullet, the ellipsis, the euro sign among
 *  them. (lib/transmittals.ts `stampFooterUnprintable` names the same set;
 *  a test pins both against pdf-lib, code point by code point.) */
const WIN_ANSI_EXTRA = new Set<number>([
  0x152, 0x153, 0x160, 0x161, 0x178, 0x17d, 0x17e, 0x192, 0x2c6, 0x2dc,
  0x2013, 0x2014, 0x2018, 0x2019, 0x201a, 0x201c, 0x201d, 0x201e,
  0x2020, 0x2021, 0x2022, 0x2026, 0x2030, 0x2039, 0x203a, 0x20ac, 0x2122,
]);

/** True when the stamp's font prints the code point as typed. */
export function stampFontPrints(cp: number): boolean {
  return (cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff) || WIN_ANSI_EXTRA.has(cp);
}

/** The form a character the font cannot print is drawn in. Characters the
 *  font prints (the en and em dash, the curly quotes) are never here: they
 *  are drawn as typed. */
const PLAIN_FORM: Readonly<Record<number, string>> = {
  // hyphen, non-breaking hyphen, figure dash, horizontal bar, hyphen bullet,
  // minus sign, small em dash, small and fullwidth hyphen-minus
  0x2010: "-", 0x2011: "-", 0x2012: "-", 0x2015: "-", 0x2043: "-", 0x2212: "-", 0xfe58: "-", 0xfe63: "-", 0xff0d: "-",
  // modifier-letter apostrophe, reversed quote, prime, reversed prime
  0x02bc: "'", 0x201b: "'", 0x2032: "'", 0x2035: "'",
  // reversed double quote, double prime, reversed double prime
  0x201f: '"', 0x2033: '"', 0x2036: '"',
  // Greek capital delta, increment (the "∆" of a symbol font)
  0x0394: "Delta", 0x2206: "Delta",
};

/** What a character the font has no form for is drawn as: visible, never
 *  dropped. */
export const STAMP_PLACEHOLDER = "?";

/** A format character (General_Category Cf): a zero-width space (U+200B),
 *  the zero-width non-joiner and joiner, a word joiner (U+2060), a
 *  byte-order mark (U+FEFF), a directional mark. It has no glyph, so a "?"
 *  in its place would put a mark on paper the record does not visibly
 *  carry, and a space (U+FEFF is in JavaScript's `\s`) would split a
 *  number. It is removed from the drawn text and named in `mapped` with
 *  `printedAs: ""`, so the copy's note reads "U+200B removed" — never a
 *  silent drop. The soft hyphen (U+00AD) is Cf too, but WinAnsi prints it,
 *  so like every printed character it is drawn as typed. */
const FORMAT_CHARACTER = /^\p{Cf}$/u;

/** One character the stamp could not print as typed, and what it printed
 *  instead. `codePoint` reads "U+2010". `printedAs` is "" for a format
 *  character, which is removed (FORMAT_CHARACTER). */
export interface StampTextMapping {
  char: string;
  codePoint: string;
  printedAs: string;
}

/** What a stamp drew in place of what it was given. */
export interface StampResult {
  /** Each character drawn in another form, once, in the order met. Empty
   *  when every character printed as typed. */
  mapped: StampTextMapping[];
}

function codePointLabel(cp: number): string {
  return `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;
}

/** PHYS-15: THE helper — `text` as the stamp's font can draw it. A text
 *  whose characters the font all prints comes back as the same string, so
 *  the stamp is drawn exactly as before. Otherwise, character by character
 *  (after composing a letter with its accent, NFC): a character the font
 *  prints is kept; a format character (FORMAT_CHARACTER) is removed and
 *  named; whitespace becomes a space (as the footer's word wrap already
 *  draws it); a dash, prime or delta takes its plain form (PLAIN_FORM); a
 *  compatibility form (a fullwidth digit, a ligature) its plain
 *  decomposition (NFKC) when the font prints every character of it;
 *  anything else the visible placeholder "?". Every replacement and
 *  removal but whitespace is returned in `mapped`. */
export function stampText(text: string): { text: string; mapped: StampTextMapping[] } {
  let asTyped = true;
  for (const ch of text) {
    if (!stampFontPrints(ch.codePointAt(0) ?? 0)) { asTyped = false; break; }
  }
  if (asTyped) return { text, mapped: [] };
  const mapped: StampTextMapping[] = [];
  let out = "";
  for (const ch of text.normalize("NFC")) {
    const cp = ch.codePointAt(0) ?? 0;
    if (stampFontPrints(cp)) { out += ch; continue; }
    if (FORMAT_CHARACTER.test(ch)) {
      if (!mapped.some((m) => m.char === ch)) mapped.push({ char: ch, codePoint: codePointLabel(cp), printedAs: "" });
      continue;
    }
    if (/\s/.test(ch)) { out += " "; continue; }
    let printedAs = PLAIN_FORM[cp];
    if (printedAs === undefined) {
      const compat = ch.normalize("NFKC");
      printedAs = compat !== ch && compat.length > 0 && Array.from(compat).every((c) => stampFontPrints(c.codePointAt(0) ?? 0))
        ? compat
        : STAMP_PLACEHOLDER;
    }
    out += printedAs;
    if (!mapped.some((m) => m.char === ch)) mapped.push({ char: ch, codePoint: codePointLabel(cp), printedAs });
  }
  return { text: out, mapped };
}

/** How many replacements the copy's note names before it says "and N more". */
const NOTE_MAX = 12;

/** PHYS-15: the line a copy carries when its stamp replaced or removed a
 *  character — "Printed in plain characters: U+2010 as "-", U+0394 as
 *  "Delta", U+200B removed." (only characters the font prints), so the paper
 *  says its number or label is not exactly the one on record. Null when
 *  nothing was replaced or removed. */
export function stampTextNote(mapped: readonly StampTextMapping[]): string | null {
  if (mapped.length === 0) return null;
  const named = mapped.slice(0, NOTE_MAX).map((m) => (m.printedAs === "" ? `${m.codePoint} removed` : `${m.codePoint} as "${m.printedAs}"`));
  const more = mapped.length > NOTE_MAX ? ` and ${mapped.length - NOTE_MAX} more` : "";
  return `Printed in plain characters: ${named.join(", ")}${more}.`;
}

function buildStampText(opts: StampOptions) {
  const parts = [];
  const watermarkText = stampWatermark(opts.watermarkText, opts.controlState);
  if (watermarkText) parts.push(watermarkText);
  if (opts.userLabel) parts.push(opts.userLabel);
  if (opts.email) parts.push(opts.email);
  if (opts.timestamp) parts.push(`Downloaded: ${formatDate(opts.timestamp)}`);
  if (opts.expiresAt) parts.push(`Expires: ${formatDate(opts.expiresAt)}`);
  return parts.filter(Boolean).join(" • ");
}

// ─── Page ink analysis (browser-only, best-effort) ───────────────────────

const RASTER_WIDTH = 220;      // thumbnail width in px — cheap and enough
const DARK_LUMA = 200;         // pixel luminance below this counts as ink
const MAX_ANALYZED_PAGES = 40; // beyond this, reuse the last page's analysis

/** Fraction of dark pixels inside a rect of the rasterized page. */
function inkIn(
  data: Uint8ClampedArray, imgW: number, imgH: number,
  x0: number, y0: number, x1: number, y1: number,
): number {
  let dark = 0, total = 0;
  const xa = Math.max(0, Math.floor(x0)), xb = Math.min(imgW, Math.ceil(x1));
  const ya = Math.max(0, Math.floor(y0)), yb = Math.min(imgH, Math.ceil(y1));
  for (let y = ya; y < yb; y += 1) {
    for (let x = xa; x < xb; x += 1) {
      const i = (y * imgW + x) * 4;
      const a = data[i + 3];
      if (a < 30) { total += 1; continue; } // transparent = blank
      const luma = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      if (luma < DARK_LUMA) dark += 1;
      total += 1;
    }
  }
  return total === 0 ? 0 : dark / total;
}

/**
 * Rasterize each page at thumbnail size and measure ink density in the four
 * corner boxes + the top/bottom bands. Returns null when analysis isn't
 * possible (no DOM, pdf.js failure) — callers fall back to convention.
 * Canvas y runs top-down; results are expressed in PDF orientation
 * (bl = bottom-left of the printed page).
 */
async function analyzePageInk(source: ArrayBuffer | Uint8Array): Promise<PageInk[] | null> {
  if (typeof document === "undefined") return null;
  try {
    const { pdfjs } = await import("react-pdf");
    pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
    const bytes = source instanceof Uint8Array ? source : new Uint8Array(source);
    // pdf.js transfers the buffer to its worker — hand it a copy so the
    // caller's bytes stay usable (pdf-lib needs them too).
    const { PDFJS_VERBOSITY } = await import("@/lib/pdfjsConfig");
    const doc = await pdfjs.getDocument({ data: bytes.slice(), verbosity: PDFJS_VERBOSITY }).promise;
    try {
      const out: PageInk[] = [];
      const pageCount = Math.min(doc.numPages, MAX_ANALYZED_PAGES);
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return null;
      for (let p = 1; p <= pageCount; p += 1) {
        const page = await doc.getPage(p);
        const base = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: RASTER_WIDTH / base.width });
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport, canvas }).promise;
        const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const W = canvas.width, H = canvas.height;
        // Corner boxes ≈ the QR plate's share of the page; bands for footers.
        const cw = W * 0.24, ch = H * 0.16, m = W * 0.015;
        const bandH = H * 0.09;
        out.push({
          corners: {
            // canvas top = PDF top; PDF "bl" = canvas bottom-left.
            tl: inkIn(data, W, H, m, m, m + cw, m + ch),
            tr: inkIn(data, W, H, W - m - cw, m, W - m, m + ch),
            bl: inkIn(data, W, H, m, H - m - ch, m + cw, H - m),
            br: inkIn(data, W, H, W - m - cw, H - m - ch, W - m, H - m),
          },
          topBand: inkIn(data, W, H, 0, 0, W, bandH),
          bottomBand: inkIn(data, W, H, 0, H - bandH, W, H),
        });
      }
      return out;
    } finally {
      void doc.destroy();
    }
  } catch (e) {
    console.warn("[stamping] page analysis unavailable — using the blind, title-block-aware placement", e);
    return null;
  }
}

// ─── The stamp itself ────────────────────────────────────────────────────

/** A page as DISPLAYED (after its /Rotate) — the space the ink analysis
 *  measured. `width`/`height` are the displayed sides; `at()` maps a display
 *  point into the user space pdf-lib draws in and turns the mark with the
 *  page, so it reads upright on the printed sheet (PHYS-12 / PKG-13). */
interface DisplayFrame {
  page: PDFPage;
  width: number;
  height: number;
  at(x: number, y: number, angleDeg?: number): { x: number; y: number; rotate: Rotation };
}

function displayFrame(page: PDFPage): DisplayFrame {
  const media = page.getSize();
  const rotation = normalizeRotation(page.getRotation().angle);
  const { width, height } = displaySize(media.width, media.height, rotation);
  return {
    page, width, height,
    at: (x, y, angleDeg = 0) => ({
      ...displayToUser(x, y, media.width, media.height, rotation),
      rotate: degrees(angleDeg + rotation),
    }),
  };
}

function drawWatermark(frame: DisplayFrame, font: PDFFont, text: string): void {
  if (!text) return;
  const { page, width, height } = frame;
  const ANGLE = -30;
  let run = text;
  let widthAt1pt = font.widthOfTextAtSize(run, 1);
  let fit = fitRotatedTextSize({ widthAt1pt, pageW: width, pageH: height, angleDeg: ANGLE });
  // If even the minimum size overflows, truncate the run until it fits —
  // a clipped watermark is useless; a shorter centered one still reads.
  while (run.length > 8) {
    const w = widthAt1pt * fit.size;
    const a = Math.abs(ANGLE) * (Math.PI / 180);
    if (w * Math.cos(a) + fit.size * Math.sin(a) <= width * 0.88) break;
    run = `${run.slice(0, Math.floor(run.length * 0.8))}…`;
    widthAt1pt = font.widthOfTextAtSize(run, 1);
    fit = fitRotatedTextSize({ widthAt1pt, pageW: width, pageH: height, angleDeg: ANGLE });
  }
  const textW = widthAt1pt * fit.size;
  const { x, y } = centerRotatedText({
    pageW: width, pageH: height, textW, textH: fit.size, angleDeg: ANGLE,
  });
  page.drawText(run, {
    ...frame.at(x, y, ANGLE),
    size: fit.size, font,
    color: rgb(0.2, 0.2, 0.2),
    opacity: 0.15,
  });
}

function drawFooter(input: {
  frame: DisplayFrame;
  font: PDFFont;
  /** The footer's main line, the caller's notice (or null) and the PHYS-15
   *  note (or null) — each already through stampText. */
  mainText: string;
  notice: string | null;
  note: string | null;
  edge: "top" | "bottom";
  qrCorner: Corner | null;
  /** Blind placement only: the top band's right-hand share, left to the
   *  revision block (SHR-8). 0 when the page was measured. */
  reserveRight: number;
}): void {
  const { frame, font, mainText, notice, note, edge, qrCorner, reserveRight } = input;
  const { page, width, height } = frame;

  const mainSize = Math.min(10, Math.max(6.5, width / 62));
  const noticeSize = Math.max(6, mainSize - 1.5);
  const marginX = Math.max(10, width * 0.03);
  const marginY = Math.max(8, height * 0.018);

  // Reserve the QR plate's width when the footer shares its edge, so the
  // two can never collide.
  const qrOnThisEdge =
    qrCorner !== null &&
    ((edge === "bottom" && (qrCorner === "bl" || qrCorner === "br")) ||
     (edge === "top" && (qrCorner === "tl" || qrCorner === "tr")));
  const qrReserve = qrOnThisEdge ? Math.max(46, Math.min(70, width / 12)) + width * 0.045 : 0;
  const qrOnLeft = qrCorner === "bl" || qrCorner === "tl";

  const maxLineW = Math.max(width * 0.25, width - marginX * 2 - qrReserve - reserveRight);
  const xStart = marginX + (qrOnThisEdge && qrOnLeft ? qrReserve : 0);

  const mainLines = wrapToWidth(mainText, maxLineW, (s) => font.widthOfTextAtSize(s, mainSize));
  const noticeLines = notice
    ? wrapToWidth(notice, maxLineW, (s) => font.widthOfTextAtSize(s, noticeSize))
    : [];
  // PHYS-15: only when the stamp replaced a character.
  const noteLines = note
    ? wrapToWidth(note, maxLineW, (s) => font.widthOfTextAtSize(s, noticeSize))
    : [];

  // Stack order top→bottom: main lines, notice lines, then the note.
  const entries: Array<{ text: string; size: number; color: ReturnType<typeof rgb> }> = [
    ...mainLines.map((t) => ({ text: t, size: mainSize, color: rgb(0.5, 0.0, 0.0) })),
    ...[...noticeLines, ...noteLines].map((t) => ({ text: t, size: noticeSize, color: rgb(0.55, 0.3, 0.0) })),
  ];
  const lineGap = 2;
  const blockH = entries.reduce((h, e) => h + e.size + lineGap, 0);

  let yCursor = edge === "bottom" ? marginY + blockH : height - marginY;
  for (const e of entries) {
    yCursor -= e.size;
    page.drawText(e.text, {
      ...frame.at(xStart, yCursor),
      size: e.size, font,
      color: e.color,
      opacity: 0.85,
    });
    yCursor -= lineGap;
  }
}

/** Stamp every page. Resolves with what the stamp drew in another form
 *  (PHYS-15) — the copy itself says so too (its footer's last line). */
export async function applyStampToPdfDoc(pdfDoc: PDFDocument, opts: StampOptions): Promise<StampResult> {
  // PKG-13: pdf-lib can LOAD an encrypted PDF (ignoreEncryption) but cannot
  // decrypt it — stamped or merged, its pages are unreadable. Refuse with the
  // reason (a pack records the sheet as skipped, exactly as stampPdf's load
  // already fails an individual download) rather than issue garbage.
  if (pdfDoc.isEncrypted) {
    throw new Error("the PDF is encrypted, so it cannot be stamped — it was not issued as a copy");
  }
  const font = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  if (opts.watermarkText !== undefined && claimsControlledCopy(opts.watermarkText)) {
    // PHYS-9: say so rather than quietly reword a caller.
    console.warn(
      `[stamping] watermarkText "${opts.watermarkText}" claims a controlled copy; a stamped copy is uncontrolled, ` +
      `so the watermark reads "${stampWatermark(opts.watermarkText, opts.controlState)}" instead.`,
    );
  }
  const watermark = buildStampText(opts);

  // Verification QR — generated once, embedded on every page. Failure to
  // generate must never fail the stamp (the copy still goes out, just
  // without the scan affordance).
  let qrImage: Awaited<ReturnType<typeof pdfDoc.embedPng>> | null = null;
  if (opts.verifyUrl) {
    try {
      const { toDataURL } = await import("qrcode");
      const dataUrl = await toDataURL(opts.verifyUrl, { margin: 1, width: 256 });
      qrImage = await pdfDoc.embedPng(dataUrl);
    } catch (e) {
      console.warn("[stamping] QR generation failed (stamp continues without it)", e);
    }
  } else {
    // PHYS-11 / SHR-11: never a silent QR-less copy. The usual cause is no
    // public origin (lib/publicOrigin.ts returned "").
    console.warn(
      "[stamping] no verifyUrl — this copy carries no verify QR and no instruction to scan one. " +
      "If the cause is no public origin, set NEXT_PUBLIC_SITE_URL (lib/publicOrigin.ts).",
    );
  }
  // With no QR on the page, the footer may not tell anyone to scan one.
  const footerOpts: StampOptions = qrImage || !opts.footerNotice
    ? opts
    : { ...opts, footerNotice: withoutScanInstruction(opts.footerNotice) };

  // PHYS-15: every text drawn, in characters the font prints — once, for
  // every page. A text the font prints as typed is unchanged.
  const mainText = stampMainLine(opts.controlState, opts.timestamp);
  const drawnWatermark = stampText(watermark);
  const drawnMain = stampText(mainText);
  const drawnNotice = footerOpts.footerNotice ? stampText(footerOpts.footerNotice) : null;
  const mapped: StampTextMapping[] = [];
  for (const m of [...drawnWatermark.mapped, ...drawnMain.mapped, ...(drawnNotice?.mapped ?? []), ...(opts.plainCharacters ?? [])]) {
    if (!mapped.some((x) => x.char === m.char)) mapped.push(m);
  }
  const note = stampTextNote(mapped);

  // Per-page emptiness analysis — where does this sheet have room?
  const ink = opts.sourceBytes ? await analyzePageInk(opts.sourceBytes) : null;

  const pages = pdfDoc.getPages();
  for (let i = 0; i < pages.length; i += 1) {
    const page = pages[i];
    // Layout runs in DISPLAY space — the space the analysis measured — and
    // every anchor goes through frame.at() into user space (PHYS-12).
    const frame = displayFrame(page);
    const { width, height } = frame;
    // Pages beyond the analyzed cap reuse the last analyzed page (sheets in
    // a set share their template); no analysis at all → the blind,
    // title-block-aware placement (SHR-8).
    const measured: PageInk | undefined = ink?.[Math.min(i, ink.length - 1)];
    const pageInk: PageInk = measured ?? fallbackInk(width, height);

    drawWatermark(frame, font, drawnWatermark.text);

    const qrCorner = qrImage ? pickQrCorner(pageInk.corners) : null;
    const footerEdge = pickFooterEdge(pageInk.topBand, pageInk.bottomBand);
    drawFooter({
      frame, font, mainText: drawnMain.text, notice: drawnNotice?.text ?? null, note, edge: footerEdge, qrCorner,
      reserveRight: measured ? 0 : titleBlockReserve(width),
    });

    if (qrImage && qrCorner) {
      const q = placeQr({ pageW: width, pageH: height, corner: qrCorner });
      // White backing plate: even the emptiest corner of a drawing can have
      // stray linework — the code must stay scannable regardless.
      page.drawRectangle({
        ...frame.at(q.plate.x, q.plate.y), width: q.plate.w, height: q.plate.h,
        color: rgb(1, 1, 1),
        opacity: 0.92,
      });
      page.drawImage(qrImage, { ...frame.at(q.qrX, q.qrY), width: q.qrSize, height: q.qrSize });
      page.drawText("SCAN TO VERIFY", {
        ...frame.at(q.labelX, q.labelY),
        size: q.labelSize,
        font,
        color: rgb(0.25, 0.25, 0.25),
        opacity: 0.9,
      });
    }
  }
  return { mapped };
}

export async function stampPdf(url: string, opts: StampOptions): Promise<Blob> {
  try {
    const res = await fetch(url, { mode: 'cors' });
    if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
    const source = await res.arrayBuffer();
    const pdfDoc = await PDFDocument.load(source);
    await applyStampToPdfDoc(pdfDoc, { ...opts, sourceBytes: source });
    const stamped = await pdfDoc.save();
    return new Blob([stamped as BlobPart], { type: "application/pdf" });
  } catch (error) {
    console.error("PDF Stamping Error:", error);
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes("Failed to fetch")) {
      throw new Error("CORS_BLOCK: Unable to access file data for stamping. Check the storage bucket's CORS configuration.");
    }
    throw error;
  }
}

export async function downloadStampedPdf(params: {
  url: string;
  filename: string;
  options: StampOptions;
}) {
  const blob = await stampPdf(params.url, params.options);
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = params.filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
