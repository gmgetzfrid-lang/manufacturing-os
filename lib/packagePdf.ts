// lib/packagePdf.ts
//
// WORK PACKAGE PDF: the one printable file per work order that goes to the
// field crew. A cover sheet, a contents page, then every item in the order
// the planner dragged them (blank quality forms, drawings, photos, other
// PDFs). When the signed forms come back scanned they replace the blanks
// and the package is rebuilt the same way, then filed.
//
// Runs in the browser and in node (tests): pdf-lib only, no DOM, no canvas.
// QR codes are drawn straight from qrcode's module matrix as filled
// rectangles, so there is no image encoding anywhere.
//
// Page numbers are worked out before anything is printed on them: every
// part is copied in first (one source file open at a time), then the
// contents is laid out, so the numbers it prints are where each item really
// starts, however many pages the contents itself runs to.

import {
  PDFDocument, PDFName, PDFArray, PDFRef, PDFString, PDFHexString, PDFTextField, StandardFonts, rgb,
  pushGraphicsState, popGraphicsState, concatTransformationMatrix, drawObject, rectangle, fill,
  setFillingRgbColor,
} from "pdf-lib";
import type { PDFFont, PDFPage, PDFImage } from "pdf-lib";

export type PartKind = "form" | "drawing" | "photo" | "file";

export interface PackPart {
  id: string;            // stable item id
  title: string;         // "Exchanger closure", "P&ID 5602-D 1000 rev 11", "Photo: channel head"
  kind: PartKind;
  /** The file: a PDF, or a JPEG/PNG image (one page). */
  bytes: Uint8Array;
  mime: "application/pdf" | "image/jpeg" | "image/png";
  /** A signed copy has replaced the blank form (shown in the contents). */
  signed?: boolean;
  /** Text for a small QR code printed on each page of a FORM (so a scan of it can be matched back), e.g. "pkgform:400101:it_3". Omit for no QR. */
  qr?: string;
  /** Values the app writes on a blank form (its header: WO, equipment, date). */
  fields?: FieldPlacement[];
}

export interface PackMeta {
  workspace: string;        // "Kern Energy"
  project: string;          // "Crude Unit Turnaround 2027"
  wos: string[];            // ["400101", "400102"] (the work orders on this piece of equipment)
  equipment: string;        // "X-1 Overhead Cooler"
  description: string;      // what the work is
  printedAt: Date;          // shown as "Printed Nov 25, 2026 2:30 PM"
  timeZone?: string;        // IANA, for printedAt
  logo?: { bytes: Uint8Array; mime: "image/png" | "image/jpeg" } | null;  // workspace logo for a generated cover
  /** The package's own page (scan to see if drawings are current and to return signed forms). Printed as a QR on the cover with "Scan for this package". */
  landingUrl?: string | null;
  /** "Draft", "Approved", "Issued", "Filed": a small word in the cover's corner. */
  status?: string;
  /** Who printed it, for a sheet's "Prepared by". */
  preparedBy?: string;
}

/** Where a value is written on a sheet: PDF points, origin bottom-left, on
 *  page `page` (0, the first, when not given). */
export interface FieldPlacement {
  key: "wo" | "equipment" | "description" | "project" | "date" | "status" | "workspace" | "by";
  x: number; y: number; size: number; maxWidth?: number;
  page?: number;
  /** The label it was read from ("W/O No.:"), to show on the setup screen. */
  label?: string;
}

export interface KitTemplates {
  /** The workspace's own cover sheet: its first page is used; fields filled by AcroForm field name when it has fields (names matched loosely), else written at `fields` positions; filled forms are flattened. */
  cover?: { bytes: Uint8Array; fields?: FieldPlacement[] } | null;
  /** The workspace's own contents page: its first page is the background; rows are written inside `region` (default: x 54..558, y 90..640 on letter) and it repeats onto more copies of that page when rows don't fit. */
  toc?: { bytes: Uint8Array; region?: { x: number; y: number; w: number; h: number; cols?: TocCols } } | null;
}

export interface Assembled {
  pdf: Uint8Array;
  pages: number;
  toc: Array<{ id: string; title: string; page: number; pages: number }>;
}

// ─── Look ────────────────────────────────────────────────────────────────

const LETTER: [number, number] = [612, 792];
const BLACK = rgb(0, 0, 0);
const GRAY = rgb(0.4, 0.4, 0.4);
const LIGHT = rgb(0.8, 0.8, 0.8);
const WHITE = rgb(1, 1, 1);
const KIND_WORD: Record<PartKind, string> = { form: "Form", drawing: "Drawing", photo: "Photo", file: "File" };

type Fonts = { reg: PDFFont; bold: PDFFont };
type Color = ReturnType<typeof rgb>;
type FieldKey = FieldPlacement["key"];
type Matrix = [number, number, number, number, number, number];

// ─── Bytes ───────────────────────────────────────────────────────────────

function toU8(b: unknown): Uint8Array {
  if (b instanceof Uint8Array) return b;
  if (b instanceof ArrayBuffer) return new Uint8Array(b);
  if (ArrayBuffer.isView(b)) return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  return new Uint8Array(0);
}

/** pdf-lib's JPEG reader looks at the whole underlying buffer, so a view
 *  into a bigger buffer (a Node Buffer, a subarray) gets its own copy. */
function own(b: Uint8Array): Uint8Array {
  return b.byteOffset === 0 && b.byteLength === b.buffer.byteLength ? b : new Uint8Array(b);
}

type Sniffed = "pdf" | "png" | "jpg";

/** What the bytes really are; the stated type only breaks a tie. */
function sniff(b: Uint8Array, mime: string): Sniffed {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpg";
  const end = Math.min(b.length - 4, 1024);
  for (let i = 0; i < end; i += 1) {
    if (b[i] === 0x25 && b[i + 1] === 0x50 && b[i + 2] === 0x44 && b[i + 3] === 0x46) return "pdf";
  }
  return mime === "image/png" ? "png" : mime === "image/jpeg" ? "jpg" : "pdf";
}

type Read = { doc: PDFDocument } | { fail: "locked" | "broken" };

async function loadPdf(bytes: Uint8Array): Promise<PDFDocument> {
  return PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
}

const hasAcroForm = (doc: PDFDocument) => !!doc.catalog.get(PDFName.of("AcroForm"));

/** Bake every form field into its page. pdf-lib 1.17 deletes a flattened
 *  field's widgets but leaves them listed on the page, so they're taken
 *  off the page's annotation list here too. */
function flattenForm(doc: PDFDocument): void {
  const form = doc.getForm();
  const fields = form.getFields();
  if (!fields.length) return;
  const gone = new Set<string>();
  for (const field of fields) {
    gone.add(field.ref.toString());
    for (const widget of field.acroField.getWidgets()) {
      const ref = doc.context.getObjectRef(widget.dict);
      if (ref) gone.add(ref.toString());
    }
  }
  form.flatten();
  for (const page of doc.getPages()) {
    const annots = page.node.Annots();
    if (!annots) continue;
    const keep = annots.asArray().filter((a) => !(a instanceof PDFRef && (gone.has(a.toString()) || !doc.context.lookup(a))));
    if (keep.length !== annots.size()) page.node.set(PDFName.of("Annots"), doc.context.obj(keep));
  }
}

/** Open a PDF. Encrypted files load (ignoreEncryption) but their content
 *  stays encrypted, so copied pages would print blank: they count as
 *  locked. `flatten` bakes form fields into the page so what's on screen is
 *  what prints; a form that won't flatten is used as it is. */
async function readPdf(bytes: Uint8Array, flatten: boolean): Promise<Read> {
  let doc: PDFDocument;
  try {
    doc = await loadPdf(bytes);
  } catch {
    return { fail: "broken" };
  }
  if (doc.isEncrypted) return { fail: "locked" };
  try {
    if (doc.getPageCount() < 1) return { fail: "broken" };
  } catch {
    return { fail: "broken" };
  }
  if (flatten && hasAcroForm(doc)) {
    try {
      flattenForm(doc);
    } catch {
      try { doc = await loadPdf(bytes); } catch { return { fail: "broken" }; }
    }
  }
  return { doc };
}

// ─── Words ───────────────────────────────────────────────────────────────

const charsets = new WeakMap<PDFFont, Set<number>>();
const LOOKALIKE: Record<string, string> = {
  "\u2010": "-", "\u2011": "-", "\u2012": "-", "\u2212": "-", "\u2032": "'", "\u2033": "\"",
  "\u2192": "->", "\u2190": "<-", "\u2194": "<->", "\u21d2": "=>", "\u2264": "<=", "\u2265": ">=",
  "\u2260": "!=", "\u2248": "~", "\u03bc": "\u00b5", "\u2126": "Ohm", "\u03a9": "Ohm", "\u2713": "OK", "\u2714": "OK",
};

/** Emoji and their joiners: decoration, dropped rather than printed as "?". */
let PICTO: RegExp | null = null;
try { PICTO = new RegExp("[\\p{Extended_Pictographic}\\u200d\\ufe0e\\ufe0f]", "gu"); } catch { PICTO = null; }

/** Text the standard fonts can print: any run of spaces or line breaks
 *  becomes one space; a letter the font lacks becomes its plain base letter
 *  (é stays, ő becomes o), else "?". Never throws inside pdf-lib. */
function plain(font: PDFFont, raw: unknown, cap = 600): string {
  let known = charsets.get(font);
  if (!known) {
    known = new Set(font.getCharacterSet());
    charsets.set(font, known);
  }
  const set = known;
  let src = String(raw ?? "");
  if (PICTO) src = src.replace(PICTO, "");
  src = src.replace(/\s+/g, " ").trim();
  let out = "";
  for (const ch of src) {
    if (out.length >= cap) break;
    const cp = ch.codePointAt(0) ?? 63;
    if (set.has(cp)) { out += ch; continue; }
    if (LOOKALIKE[ch]) { out += LOOKALIKE[ch]; continue; }
    const base = ch.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
    out += base && Array.from(base).every((c) => set.has(c.codePointAt(0) ?? -1)) ? base : "?";
  }
  return out;
}

const ELL = "…";

/** The longest start of `s` that fits with "…" on the end. */
function withEllipsis(font: PDFFont, s: string, size: number, maxW: number): string {
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (font.widthOfTextAtSize(s.slice(0, mid).trimEnd() + ELL, size) <= maxW) lo = mid;
    else hi = mid - 1;
  }
  if (lo === 0) return font.widthOfTextAtSize(ELL, size) <= maxW ? ELL : "";
  return s.slice(0, lo).trimEnd() + ELL;
}

/** One line: as is when it fits, else cut with "…". */
function clip(font: PDFFont, s: string, size: number, maxW: number): string {
  if (!s || maxW <= 0) return "";
  return font.widthOfTextAtSize(s, size) <= maxW ? s : withEllipsis(font, s, size, maxW);
}

/** Word-wrap to `maxW`, at most `maxLines`; a word too wide for a line is
 *  broken; what doesn't fit ends the last line with "…". */
function wrap(font: PDFFont, s: string, size: number, maxW: number, maxLines: number): string[] {
  const most = Math.max(1, Math.floor(maxLines));
  const w = (t: string) => font.widthOfTextAtSize(t, size);
  const lines: string[] = [];
  let cur = "";
  for (const word of s.split(" ")) {
    if (!word) continue;
    const next = cur ? `${cur} ${word}` : word;
    if (w(next) <= maxW) { cur = next; continue; }
    if (cur) lines.push(cur);
    let rest = word;
    while (rest.length > 1 && w(rest) > maxW && lines.length <= most) {
      let lo = 1;
      let hi = rest.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (w(rest.slice(0, mid)) <= maxW) lo = mid;
        else hi = mid - 1;
      }
      lines.push(rest.slice(0, lo));
      rest = rest.slice(lo);
    }
    cur = rest;
    if (lines.length >= most) break;
  }
  if (cur) lines.push(cur);
  if (lines.length <= most) return lines;
  const kept = lines.slice(0, most);
  kept[most - 1] = withEllipsis(font, kept[most - 1], size, maxW);
  return kept;
}

function cleanWos(wos: unknown): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of Array.isArray(wos) ? wos : []) {
    const wo = String(raw ?? "").trim().replace(/^w\.?\s*o\.?\s*#?\s*(?=\d)/i, "");
    if (wo && !seen.has(wo)) { seen.add(wo); out.push(wo); }
  }
  return out;
}

/** "WO 400101" or "WO 400101, 400102"; empty when there are none. */
function woLabel(wos: unknown): string {
  const list = cleanWos(wos);
  return list.length ? `WO ${list.join(", ")}` : "";
}

/** "WO 400101 · X-1 Overhead Cooler" */
function jobLine(meta: PackMeta): string {
  return [woLabel(meta.wos), String(meta.equipment ?? "").trim()].filter(Boolean).join(" · ");
}

function itemTitle(part: PackPart | null | undefined): string {
  return String(part?.title ?? "").trim() || "Untitled item";
}

/** "Nov 25, 2026" and "2:30 PM" in the package's time zone. */
function printedWords(at: Date, timeZone?: string): { date: string; time: string } {
  const when = at instanceof Date && !Number.isNaN(at.getTime()) ? at : new Date();
  const opts: Intl.DateTimeFormatOptions = {
    month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true,
  };
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", { ...opts, timeZone: timeZone || undefined }).formatToParts(when);
  } catch {
    parts = new Intl.DateTimeFormat("en-US", opts).formatToParts(when);
  }
  const get = (t: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === t)?.value ?? "";
  return {
    date: `${get("month")} ${get("day")}, ${get("year")}`,
    time: `${get("hour")}:${get("minute")} ${get("dayPeriod").toUpperCase()}`,
  };
}

/** "WO 400101, 400102 - X-1 Overhead Cooler.pdf": safe on Windows and
 *  network shares (no \ / : * ? " < > |), one space between words, at most
 *  150 characters. */
export function suggestFileName(meta: Pick<PackMeta, "wos" | "equipment">): string {
  const wos = cleanWos(meta?.wos);
  const equipment = String(meta?.equipment ?? "").trim();
  let base = wos.length ? `WO ${wos.join(", ")}` : "Work package";
  if (equipment) base += ` - ${equipment}`;
  base = Array.from(base)
    .map((ch) => (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127 || "\\/:*?\"<>|".includes(ch) ? " " : ch))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  base = Array.from(base).slice(0, 150 - ".pdf".length).join("").replace(/[\s.,-]+$/, "");
  return `${base || "Work package"}.pdf`;
}

// ─── Drawing helpers ─────────────────────────────────────────────────────

function text(page: PDFPage, s: string, x: number, y: number, size: number, font: PDFFont, color: Color = BLACK): void {
  if (s) page.drawText(s, { x, y, size, font, color });
}

function textRight(page: PDFPage, s: string, right: number, y: number, size: number, font: PDFFont, color: Color = BLACK): void {
  if (s) page.drawText(s, { x: right - font.widthOfTextAtSize(s, size), y, size, font, color });
}

function rule(page: PDFPage, x0: number, x1: number, y: number, thickness: number, color: Color): void {
  page.drawLine({ start: { x: x0, y }, end: { x: x1, y }, thickness, color });
}

/** A copied page can share its /Contents array with a sibling page of the
 *  same source; drawing on one would then print on both. Give it its own. */
function ownContents(page: PDFPage): void {
  const node = page.node;
  const raw = node.get(PDFName.of("Contents"));
  const val = raw ? node.context.lookup(raw) : undefined;
  if (val instanceof PDFArray) node.set(PDFName.of("Contents"), node.context.obj(val.asArray()));
}

function box(r: { x: number; y: number; width: number; height: number }) {
  return {
    x0: Math.min(r.x, r.x + r.width), y0: Math.min(r.y, r.y + r.height),
    x1: Math.max(r.x, r.x + r.width), y1: Math.max(r.y, r.y + r.height),
  };
}

/** The page as it is seen: its visible size (crop box, after /Rotate) and
 *  a transform so drawing at (x, y) from its seen bottom-left lands right
 *  side up on any page size or rotation. `k` grows marks on sheets bigger
 *  than 11x17 so they still read at 9 pt when printed down to 11x17. */
interface Frame { w: number; h: number; k: number; begin(): void; end(): void }

function frameOf(page: PDFPage): Frame {
  const mb = box(page.getMediaBox());
  let cb = mb;
  try { cb = box(page.getCropBox()); } catch { /* media box */ }
  let x0 = Math.max(mb.x0, cb.x0);
  let y0 = Math.max(mb.y0, cb.y0);
  let x1 = Math.min(mb.x1, cb.x1);
  let y1 = Math.min(mb.y1, cb.y1);
  if (x1 - x0 < 1 || y1 - y0 < 1) ({ x0, y0, x1, y1 } = mb);
  const W = x1 - x0;
  const H = y1 - y0;
  let angle = 0;
  try { angle = page.getRotation().angle || 0; } catch { angle = 0; }
  const rot = (((Math.round(angle / 90) * 90) % 360) + 360) % 360;
  const m: Matrix =
    rot === 90 ? [0, 1, -1, 0, x0 + W, y0]
    : rot === 180 ? [-1, 0, 0, -1, x0 + W, y0 + H]
    : rot === 270 ? [0, -1, 1, 0, x0, y0 + H]
    : [1, 0, 0, 1, x0, y0];
  const w = rot % 180 ? H : W;
  const h = rot % 180 ? W : H;
  const k = Math.min(6, Math.max(1, Math.min(Math.max(w, h) / 1224, Math.min(w, h) / 792)));
  return {
    w, h, k,
    begin: () => page.pushOperators(pushGraphicsState(), concatTransformationMatrix(...m)),
    end: () => page.pushOperators(popGraphicsState()),
  };
}

// ─── QR codes ────────────────────────────────────────────────────────────

interface QrCode { n: number; dark: Uint8Array }
type MakeQr = (text: string | null | undefined) => QrCode | null;

/** qrcode's `create` gives the module matrix; nothing is rendered to an
 *  image, so it works the same in the browser and in node. A QR that can't
 *  be made is simply left off: it never stops the package. */
async function qrMaker(): Promise<MakeQr> {
  type Create = (t: string, o?: { errorCorrectionLevel?: "M" }) => { modules: { size: number; data: Uint8Array } };
  let create: Create | null = null;
  try {
    const mod = (await import("qrcode")) as unknown as { create?: Create; default?: { create?: Create } };
    create = mod.create ?? mod.default?.create ?? null;
  } catch {
    create = null;
  }
  const made = new Map<string, QrCode | null>();
  return (raw) => {
    const t = String(raw ?? "").trim();
    if (!t || !create) return null;
    if (!made.has(t)) {
      let code: QrCode | null = null;
      try {
        const q = create(t, { errorCorrectionLevel: "M" });
        code = { n: q.modules.size, dark: q.modules.data };
      } catch {
        code = null;
      }
      made.set(t, code);
    }
    return made.get(t) ?? null;
  };
}

/** A QR on a white square at (x, y), `size` wide including a 2-module quiet
 *  zone. Dark runs in a row are one rectangle each, all filled at once. */
/** A clickable area on the page that opens `url` (a PDF read on a
 *  computer: the package's QR and link open its page). */
function linkTo(page: PDFPage, url: string, x: number, y: number, w: number, h: number): void {
  try {
    const ctx = page.doc.context;
    const annot = ctx.register(ctx.obj({
      Type: "Annot", Subtype: "Link", Rect: [x, y, x + w, y + h], Border: [0, 0, 0],
      A: { Type: "Action", S: "URI", URI: PDFString.of(url) },
    }));
    const annots = page.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
    if (annots) annots.push(annot); else page.node.set(PDFName.of("Annots"), ctx.obj([annot]));
  } catch { /* the QR still works on paper */ }
}

/** A long link cut to lines that fit (it has no spaces to wrap on). */
function urlLines(font: PDFFont, url: string, size: number, maxW: number, maxLines: number): string[] {
  const out: string[] = [];
  let rest = url;
  while (rest && out.length < maxLines) {
    let n = rest.length;
    while (n > 1 && font.widthOfTextAtSize(rest.slice(0, n), size) > maxW) n -= 1;
    out.push(rest.slice(0, n));
    rest = rest.slice(n);
  }
  return out;
}

function drawQr(page: PDFPage, q: QrCode, x: number, y: number, size: number): void {
  const quiet = 2;
  const m = size / (q.n + quiet * 2);
  page.drawRectangle({ x, y, width: size, height: size, color: WHITE });
  const ops = [pushGraphicsState(), setFillingRgbColor(0, 0, 0)];
  for (let r = 0; r < q.n; r += 1) {
    let c = 0;
    while (c < q.n) {
      if (!q.dark[r * q.n + c]) { c += 1; continue; }
      let e = c + 1;
      while (e < q.n && q.dark[r * q.n + e]) e += 1;
      const top = y + size - (quiet + r) * m;
      // A hair taller than a module so rows never show a seam.
      ops.push(rectangle(x + (quiet + c) * m, top - m * 1.02, (e - c) * m, m * 1.02));
      c = e;
    }
  }
  ops.push(fill(), popGraphicsState());
  page.pushOperators(...ops);
}

// ─── Footer ──────────────────────────────────────────────────────────────

/** 9 pt gray along the seen bottom edge: job left, item centered, page
 *  number right. Each is cut with "…" so none runs into another. `backed`
 *  puts white behind the words (a scanned page carries the old footer). */
function drawFooter(page: PDFPage, fonts: Fonts, f: Frame, left: string, center: string, right: string, backed: boolean): void {
  const font = fonts.reg;
  const size = 9 * f.k;
  const mx = Math.min(36 * f.k, f.w * 0.06);
  const y = 20 * f.k;
  const avail = f.w - mx * 2;
  const gap = 14 * f.k;
  const R = clip(font, plain(font, right), size, avail * 0.3);
  const rw = font.widthOfTextAtSize(R, size);
  const L = clip(font, plain(font, left), size, Math.max(0, Math.min(avail * 0.4, avail - rw - gap)));
  const lw = font.widthOfTextAtSize(L, size);
  const half = Math.min(f.w / 2 - (mx + lw + gap), f.w / 2 - (mx + rw + gap));
  const C = half > 10 * f.k ? clip(font, plain(font, center), size, half * 2) : "";
  const cw = font.widthOfTextAtSize(C, size);
  const runs: Array<[string, number, number]> = [[L, mx, lw], [C, (f.w - cw) / 2, cw], [R, f.w - mx - rw, rw]];
  for (const [s, x, w] of runs) {
    if (!s) continue;
    if (backed) {
      page.drawRectangle({ x: x - 3 * f.k, y: y - 3.5 * f.k, width: w + 6 * f.k, height: size + 5 * f.k, color: WHITE });
    }
    page.drawText(s, { x, y, size, font, color: GRAY });
  }
}

// ─── Contents ────────────────────────────────────────────────────────────

/** Where the list goes. `cols`: the page has its own column headings (its
 *  "Item … Description … Page" row), so no heading row is drawn and each
 *  column is written under its heading when its place is known. */
export interface TocCols { no?: number; item?: number; kind?: number; pageR?: number }
interface Region { x: number; y: number; w: number; h: number; cols?: TocCols }
interface Row { idx: number; lines: string[]; note: "" | "signed" | "missing"; kind: string; h: number }

const GEN_REGION: Region = { x: 54, y: 72, w: 504, h: 600 };
const HEAD_H = 22;          // the "#  Item  Kind  Page" row
const ROW_H = 22;           // one line of title
const LINE2 = 13;           // each extra line of a wrapped title
const TITLE_PT = 10.5;
const NOTE: Record<"signed" | "missing", string> = { signed: "(signed)", missing: "(couldn't be added)" };

/** Pages the contents will take for n items (one line each), on the
 *  app's page or on a workspace's own with a list area `regionH` tall. The
 *  builder numbers each item's first page with it, as printed. */
export function contentsPages(n: number, regionH?: number | null, ownHead = false): number {
  const room = (regionH && regionH >= HEAD_H + ROW_H ? regionH : GEN_REGION.h) - (ownHead ? 0 : HEAD_H);
  return Math.max(1, Math.ceil(Math.max(1, n) / Math.max(1, Math.floor(room / ROW_H))));
}

function columns(r: Region) {
  const c = r.cols;
  const pageR = c?.pageR ?? r.x + r.w;
  // Under the page's own headings, a column it has no heading for is left out.
  const noX: number | null = c ? (c.no ?? (c.item != null ? null : r.x)) : r.x;
  const itemX = c?.item ?? (noX != null ? noX + 30 : r.x);
  const kindX: number | null = c ? (c.kind ?? null) : pageR - 40 - 62;
  const end = kindX != null && kindX > itemX ? kindX : pageR - 40;
  return { noX, itemX, itemW: Math.max(40, end - 10 - itemX), kindX, pageR };
}

/** The contents region on a workspace's own contents page. */
function tocRegion(f: Frame, g: Region | null | undefined): Region {
  const fallback: Region = { x: 54, y: 90, w: f.w - 108, h: f.h - 242 };
  if (g && [g.x, g.y, g.w, g.h].every((n) => Number.isFinite(n)) && g.w >= 160 && g.h >= HEAD_H + ROW_H) {
    return { x: g.x, y: g.y, w: g.w, h: g.h, ...(g.cols ? { cols: g.cols } : {}) };
  }
  return fallback.w >= 160 && fallback.h >= HEAD_H + ROW_H ? fallback : { x: 18, y: 36, w: Math.max(160, f.w - 36), h: Math.max(HEAD_H + ROW_H, f.h - 72) };
}

function layoutRows(parts: PackPart[], failed: boolean[], fonts: Fonts, r: Region): Row[] {
  if (!parts.length) return [{ idx: -1, lines: ["No items yet"], note: "", kind: "", h: ROW_H }];
  const c = columns(r);
  return parts.map((p, idx) => {
    const note: Row["note"] = failed[idx] ? "missing" : p.signed ? "signed" : "";
    const noteW = note ? fonts.bold.widthOfTextAtSize(` ${NOTE[note]}`, TITLE_PT) : 0;
    const title = plain(fonts.reg, itemTitle(p)) || "Untitled item";
    const lines = wrap(fonts.reg, title, TITLE_PT, Math.max(20, c.itemW - noteW), 2);
    return { idx, lines, note, kind: KIND_WORD[p.kind] ?? "File", h: ROW_H + (lines.length - 1) * LINE2 };
  });
}

/** Rows onto pages by height, so the page count is known before drawing. */
function paginate(rows: Row[], room: number): Row[][] {
  const pages: Row[][] = [];
  let cur: Row[] = [];
  let used = 0;
  for (const row of rows) {
    if (cur.length && used + row.h > room) {
      pages.push(cur);
      cur = [];
      used = 0;
    }
    cur.push(row);
    used += row.h;
  }
  pages.push(cur);
  return pages;
}

function drawRows(page: PDFPage, fonts: Fonts, r: Region, rows: Row[], starts: number[]): void {
  const { reg, bold } = fonts;
  const c = columns(r);
  let top = r.y + r.h;
  // The page's own headings stand in for the app's.
  if (!r.cols) {
    const hb = top - 14;
    text(page, "#", r.x, hb, 9, bold, GRAY);
    text(page, "Item", c.itemX, hb, 9, bold, GRAY);
    if (c.kindX != null) text(page, "Kind", c.kindX, hb, 9, bold, GRAY);
    textRight(page, "Page", c.pageR, hb, 9, bold, GRAY);
    top -= HEAD_H;
    rule(page, r.x, c.pageR, top, 0.75, BLACK);
  }
  for (const row of rows) {
    const base = top - 15;
    if (row.idx < 0) {
      text(page, row.lines[0], c.itemX, base, TITLE_PT, reg, GRAY);
    } else {
      if (c.noX != null) text(page, String(row.idx + 1), c.noX, base, TITLE_PT, reg, GRAY);
      row.lines.forEach((line, i) => text(page, line, c.itemX, base - i * LINE2, TITLE_PT, reg));
      if (row.note) {
        const last = row.lines[row.lines.length - 1] ?? "";
        const x = c.itemX + reg.widthOfTextAtSize(`${last} `, TITLE_PT);
        text(page, NOTE[row.note], x, base - (row.lines.length - 1) * LINE2, TITLE_PT, bold, row.note === "missing" ? GRAY : BLACK);
      }
      if (c.kindX != null) text(page, row.kind, c.kindX, base, TITLE_PT, reg);
      textRight(page, String(starts[row.idx] ?? ""), c.pageR, base, TITLE_PT, bold);
    }
    top -= row.h;
    rule(page, r.x, c.pageR, top, 0.5, LIGHT);
  }
}

function drawContentsHead(page: PDFPage, fonts: Fonts, meta: PackMeta, index: number): void {
  text(page, index === 0 ? "Contents" : "Contents (continued)", GEN_REGION.x, 724, 24, fonts.bold);
  const job = clip(fonts.reg, plain(fonts.reg, jobLine(meta)), 11, GEN_REGION.w);
  text(page, job, GEN_REGION.x, 704, 11, fonts.reg, GRAY);
}

// ─── Cover ───────────────────────────────────────────────────────────────

async function embedLogo(out: PDFDocument, logo: PackMeta["logo"]): Promise<PDFImage | null> {
  const bytes = toU8(logo?.bytes);
  if (!logo || !bytes.length) return null;
  try {
    const b = own(bytes);
    const kind = sniff(b, logo.mime);
    if (kind === "png") return await out.embedPng(b);
    if (kind === "jpg") return await out.embedJpg(b);
  } catch { /* the workspace name instead */ }
  return null;
}

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** US letter, black on white. Logo (or workspace name) and status word on
 *  top, the job in big type, the details, then the package QR and the
 *  contents count along the bottom. */
function drawCover(
  page: PDFPage, fonts: Fonts, meta: PackMeta, logo: PDFImage | null,
  items: number, total: number, landing: QrCode | null, when: { date: string; time: string },
): void {
  const { reg, bold } = fonts;
  const W = LETTER[0];
  const M = 60;
  const R = W - M;
  const CW = R - M;
  const top = LETTER[1] - M;

  let statusW = 0;
  const status = clip(bold, plain(bold, meta.status), 11, 160);
  if (status) {
    statusW = bold.widthOfTextAtSize(status, 11) + 20;
    page.drawRectangle({ x: R - statusW, y: top - 24, width: statusW, height: 24, borderColor: BLACK, borderWidth: 1 });
    text(page, status, R - statusW + 10, top - 16, 11, bold);
  }
  if (logo && logo.width > 0 && logo.height > 0) {
    const s = Math.min(160 / logo.width, 48 / logo.height);
    page.drawImage(logo, { x: M, y: top - logo.height * s, width: logo.width * s, height: logo.height * s });
  } else {
    text(page, clip(bold, plain(bold, meta.workspace), 14, CW - statusW - 20), M, top - 16, 14, bold);
  }
  rule(page, M, R, top - 64, 1, BLACK);

  let y = top - 116;
  text(page, "Work package", M, y, 30, bold);
  y -= 40;
  const wo = plain(bold, woLabel(meta.wos));
  for (const line of wo ? wrap(bold, wo, 24, CW, 3) : []) {
    text(page, line, M, y, 24, bold);
    y -= 30;
  }
  const equipment = plain(reg, meta.equipment);
  for (const line of equipment ? wrap(reg, equipment, 18, CW, 2) : []) {
    text(page, line, M, y, 18, reg);
    y -= 24;
  }

  const qrSize = 96;
  const bottomTop = M + (landing ? qrSize : 52) + 28;
  const details = ([["Project", plain(reg, meta.project)], ["Printed", `${when.date} ${when.time}`]] as Array<[string, string]>)
    .filter(([, v]) => v);
  const detailsH = 18 + details.length * 20;
  const description = plain(reg, meta.description, 4000);
  if (description) {
    y -= 10;
    const fit = Math.floor((y - bottomTop - detailsH) / 16) + 1;
    for (const line of wrap(reg, description, 12, CW, Math.min(16, Math.max(1, fit)))) {
      text(page, line, M, y, 12, reg);
      y -= 16;
    }
  }
  y -= 18;
  for (const [label, value] of details) {
    text(page, label, M, y, 10, bold, GRAY);
    text(page, clip(reg, value, 12, CW - 70), M + 70, y, 12, reg);
    y -= 20;
  }

  const boxW = 170;
  const boxH = 52;
  if (landing) {
    drawQr(page, landing, M, M, qrSize);
    const tx = M + qrSize + 14;
    const tw = R - boxW - 16 - tx;
    let ty = M + qrSize - 14;
    text(page, "Scan for this package", tx, ty, 11, bold);
    ty -= 16;
    for (const line of wrap(reg, "Check the drawings are current and return signed forms.", 10.5, tw, 3)) {
      text(page, line, tx, ty, 10.5, reg);
      ty -= 14;
    }
    // The same page as a link: a contractor sent this file clicks it.
    const url = String(meta.landingUrl ?? "").trim();
    if (url) {
      ty -= 2;
      const lines = urlLines(reg, url, 8, tw, 3);
      lines.forEach((line, i) => text(page, line, tx, ty - i * 10, 8, reg, GRAY));
      linkTo(page, url, M, M, qrSize, qrSize);
      linkTo(page, url, tx, ty - (lines.length - 1) * 10 - 3, tw, lines.length * 10 + 2);
    }
  }
  const bx = landing ? R - boxW : M;
  page.drawRectangle({ x: bx, y: M, width: boxW, height: boxH, borderColor: BLACK, borderWidth: 1 });
  text(page, "Contents", bx + 12, M + 32, 10, bold, GRAY);
  text(page, `${count(items, "item", "items")}, ${count(total, "page", "pages")}`, bx + 12, M + 14, 12, reg);
}

/** What each fill writes, from the package. */
function fillValues(font: PDFFont, meta: PackMeta, when: { date: string }): Record<FieldKey, string> {
  return {
    wo: plain(font, cleanWos(meta.wos).join(", ")),
    equipment: plain(font, meta.equipment),
    description: plain(font, meta.description, 4000),
    project: plain(font, meta.project),
    date: when.date,
    status: plain(font, meta.status),
    workspace: plain(font, meta.workspace),
    by: plain(font, meta.preparedBy),
  };
}

/** Write the fills on a sheet's page; `to` maps the sheet's own points to
 *  the page (a form drawn a little smaller). Skips what has no value. */
function writeFills(page: PDFPage, font: PDFFont, fields: FieldPlacement[], pageIndex: number, values: Record<FieldKey, string>, to: { x: number; y: number; s: number }, room: number): number {
  let n = 0;
  for (const p of fields) {
    if (!p || (p.page ?? 0) !== pageIndex || !values[p.key]) continue;
    if (![p.x, p.y, p.size].every((v) => Number.isFinite(v))) continue;
    const size = Math.min(72, Math.max(5, p.size)) * to.s;
    const maxW = (p.maxWidth && p.maxWidth > 0 ? p.maxWidth : Math.max(24, room - p.x - 36)) * to.s;
    const lines = p.key === "description" ? wrap(font, values[p.key], size, maxW, 8) : [clip(font, values[p.key], size, maxW)];
    lines.forEach((line, i) => text(page, line, to.x + p.x * to.s, to.y + p.y * to.s - i * size * 1.25, size, font));
    n += 1;
  }
  return n;
}

/** A fillable form's own fields: the ones the app knows get their values,
 *  then the form is flattened so it prints as one page of ink. */
function fillAcro(doc: PDFDocument, values: Record<FieldKey, string>, font: PDFFont): Set<FieldKey> {
  const filled = new Set<FieldKey>();
  if (!hasAcroForm(doc)) return filled;
  try {
    const fields = doc.getForm().getFields();
    for (const field of fields) {
      if (!(field instanceof PDFTextField)) continue;
      const key = keyForField(field);
      if (!key || !values[key]) continue;
      try { field.setText(fitField(field, values[key], font)); filled.add(key); } catch { /* leave it blank */ }
    }
    if (fields.length) flattenForm(doc);
  } catch { /* print it as it is */ }
  return filled;
}

const KEY_RULES: Array<[FieldKey, RegExp]> = [
  ["equipment", /equip|\btags?\b|\basset/],
  ["description", /desc|scope|\btasks?\b/],
  ["wo", /\bw ?o\b|\bwo ?(no|num|number|nbr|s)\b|work ?order/],
  ["description", /\bwork\b/],
  ["project", /project|\bjob\b|turnaround|\bta\b/],
  ["date", /\bdate|(print|issue|start|due)date/],
  ["status", /\bstatus\b/],
  ["by", /prepared ?by|issued ?by|planner|originator/],
  ["workspace", /\bcompany\b|\bclient\b|\bowner\b|refinery|facility/],
];

/** Which value a cover field wants, from its name ("Work Order No",
 *  "WONumber", "W.O. #", "Equipment Tag", "Scope of work", "Date"). */
function keyForName(raw: string): FieldKey | null {
  const s = raw
    .replace(/\[\d+\]/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .toLowerCase()
    .trim();
  if (!s) return null;
  for (const [key, re] of KEY_RULES) if (re.test(s)) return key;
  return null;
}

function keyForField(field: PDFTextField): FieldKey | null {
  const names: string[] = [];
  try {
    const full = field.getName();
    names.push(full.split(".").pop() ?? full, full);
  } catch { /* nameless */ }
  try {
    const tip = field.acroField.dict.lookup(PDFName.of("TU"));
    if (tip instanceof PDFString || tip instanceof PDFHexString) names.push(tip.decodeText());
  } catch { /* no tooltip */ }
  for (const n of names) {
    const key = keyForName(n);
    if (key) return key;
  }
  return null;
}

const TF = /(\d+(?:\.\d+)?)\s+Tf/;

/** The value as it should go in a cover field. A field left at "auto"
 *  size gets a real one (pdf-lib's auto size blows a multi-line box up to
 *  a few huge words, and shrinks a long line to nothing), and so does one
 *  whose size is too big for its box; a one-line field
 *  gets the value cut with "…" to its width. The widget's own size wins
 *  over the field's, as it does when pdf-lib draws it. */
function fitField(field: PDFTextField, value: string, font: PDFFont): string {
  const max = field.getMaxLength();
  if (max !== undefined) return value.slice(0, max);
  const acro = field.acroField;
  const widgets = acro.getWidgets();
  const sizeIn = (da: string | undefined) => {
    const m = TF.exec(da ?? "");
    return m ? Number(m[1]) : 0;
  };
  let size = sizeIn(widgets[0]?.getDefaultAppearance()) || sizeIn(acro.getDefaultAppearance());
  const rect = widgets[0]?.getRectangle();
  const multi = field.isMultiline();
  // A size too big for the box is an auto size someone's tool baked in.
  const tooBig = multi ? size > 24 : size > Math.max(14, rect?.height ?? 0);
  const setSize = (n: number) => {
    size = Math.round(n * 10) / 10;
    const resize = (da: string) => da.replace(new RegExp(TF.source, "g"), `${size} Tf`);
    const own = acro.getDefaultAppearance();
    acro.setDefaultAppearance(own && TF.test(own) ? resize(own) : `/Helv ${size} Tf 0 g`);
    for (const w of widgets) {
      const da = w.getDefaultAppearance();
      if (da && TF.test(da)) w.setDefaultAppearance(resize(da));
    }
  };
  if (!(size > 0) || tooBig) setSize(multi ? 10 : Math.min(12, Math.max(7, (rect?.height ?? 20) * 0.6)));
  if (multi || !rect || rect.width <= 8) return value;
  // One line: shrink to as small as 8 pt to fit, then cut with "…".
  const room = rect.width - 6;
  const wide = font.widthOfTextAtSize(value, size);
  if (wide > room && size > 8) setSize(Math.max(8, (size * room) / wide));
  return clip(font, value, size, room);
}

/** The workspace's own cover: fill its fields (or write at the given
 *  spots), flatten, put it first. False when it can't be used, so the
 *  generated cover goes in instead. */
async function addTemplateCover(
  out: PDFDocument, fonts: Fonts, meta: PackMeta, cover: NonNullable<KitTemplates["cover"]>,
  makeQr: MakeQr, when: { date: string; time: string },
): Promise<boolean> {
  const read = await readPdf(toU8(cover.bytes), false);
  if (!("doc" in read)) return false;
  const tpl = read.doc;
  const font = fonts.reg;
  const values = fillValues(font, meta, when);
  const filled = new Set<FieldKey>();
  try {
    if (hasAcroForm(tpl)) {
      const form = tpl.getForm();
      const fields = form.getFields();
      for (const field of fields) {
        if (!(field instanceof PDFTextField)) continue;
        const key = keyForField(field);
        if (!key || !values[key]) continue;
        try {
          field.setText(fitField(field, values[key], font));
          filled.add(key);
        } catch { /* leave this one blank */ }
      }
      if (fields.length) {
        try { flattenForm(tpl); } catch { /* print it as it is */ }
      }
    }
  } catch { /* a form pdf-lib can't read: use the page as it is */ }

  let copied: PDFPage[];
  try {
    copied = await out.copyPages(tpl, [0]);
  } catch {
    return false;
  }
  const page = copied[0];
  out.insertPage(0, page);
  ownContents(page);
  page.setFont(font);

  const mb = box(page.getMediaBox());
  const placedFields = (cover.fields ?? []).filter((p) => p && !filled.has(p.key));
  const wrote = filled.size > 0 || writeFills(page, font, placedFields, 0, values, { x: mb.x0, y: mb.y0, s: 1 }, mb.x1 - mb.x0) > 0;

  // A cover with nothing to fill still has to say which job it's for; and
  // the package QR goes on whatever the cover is.
  const landing = makeQr(meta.landingUrl);
  if (!wrote || landing) {
    const f = frameOf(page);
    f.begin();
    if (!wrote) drawFooter(page, fonts, f, jobLine(meta), "", `Printed ${when.date} ${when.time}`, true);
    if (landing) {
      const qs = 72 * f.k;
      const qx = f.w - Math.min(36 * f.k, f.w * 0.06) - qs;
      const qy = 34 * f.k;
      drawQr(page, landing, qx, qy, qs);
      if (meta.landingUrl) linkTo(page, meta.landingUrl, qx, qy, qs, qs);
      const label = "Scan for this package";
      const lw = fonts.bold.widthOfTextAtSize(label, 9 * f.k);
      page.drawRectangle({ x: qx + qs - lw - 2 * f.k, y: qy + qs, width: lw + 2 * f.k, height: 13 * f.k, color: WHITE });
      text(page, label, qx + qs - lw, qy + qs + 3 * f.k, 9 * f.k, fonts.bold);
    }
    f.end();
  }
  return true;
}

// ─── Parts ───────────────────────────────────────────────────────────────

/** EXIF orientation of a JPEG (1 to 8); 1 when there is none. Phone photos
 *  are stored sideways with a tag saying which way is up. */
function jpegOrientation(b: Uint8Array): number {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return 1;
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return 1;
    while (b[i + 1] === 0xff && i + 2 < b.length) i += 1;
    const marker = b[i + 1];
    if (marker === 0xd9 || marker === 0xda) return 1;
    const len = (b[i + 2] << 8) | b[i + 3];
    if (len < 2) return 1;
    const isExif = marker === 0xe1 && len >= 16 && b[i + 4] === 0x45 && b[i + 5] === 0x78
      && b[i + 6] === 0x69 && b[i + 7] === 0x66 && b[i + 8] === 0 && b[i + 9] === 0;
    if (isExif) {
      const t = i + 10;
      const le = b[t] === 0x49;
      const u16 = (o: number) => (le ? b[o] | (b[o + 1] << 8) : (b[o] << 8) | b[o + 1]);
      const u32 = (o: number) => (le
        ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0
        : ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0);
      const end = Math.min(b.length, i + 2 + len);
      const ifd = t + u32(t + 4);
      if (ifd + 2 > end) return 1;
      const entries = u16(ifd);
      for (let e = 0; e < entries; e += 1) {
        const p = ifd + 2 + e * 12;
        if (p + 12 > end) break;
        if (u16(p) === 0x0112) {
          const v = u16(p + 8);
          return v >= 1 && v <= 8 ? v : 1;
        }
      }
      return 1;
    }
    i += 2 + len;
  }
  return 1;
}

/** Image space (unit square) to the page box (x, y, w, h), turned and
 *  mirrored the way the EXIF orientation says. */
function orientMatrix(o: number, x: number, y: number, w: number, h: number): Matrix {
  switch (o) {
    case 2: return [-w, 0, 0, h, x + w, y];
    case 3: return [-w, 0, 0, -h, x + w, y + h];
    case 4: return [w, 0, 0, -h, x, y + h];
    case 5: return [0, -h, -w, 0, x + w, y + h];
    case 6: return [0, -h, w, 0, x, y + h];
    case 7: return [0, h, w, 0, x, y];
    case 8: return [0, h, -w, 0, x + w, y];
    default: return [w, 0, 0, h, x, y];
  }
}

/** One letter page, portrait or landscape to match the photo, the photo
 *  as big as fits inside 36 pt margins, centered. */
async function addImagePage(out: PDFDocument, bytes: Uint8Array, kind: "png" | "jpg"): Promise<void> {
  const img = kind === "png" ? await out.embedPng(bytes) : await out.embedJpg(bytes);
  if (!(img.width > 0 && img.height > 0)) throw new Error("empty image");
  const o = kind === "jpg" ? jpegOrientation(bytes) : 1;
  const seenW = o >= 5 ? img.height : img.width;
  const seenH = o >= 5 ? img.width : img.height;
  const [W, H] = seenW > seenH ? [LETTER[1], LETTER[0]] : LETTER;
  const s = Math.min((W - 72) / seenW, (H - 72) / seenH);
  const dw = seenW * s;
  const dh = seenH * s;
  const page = out.addPage([W, H]);
  const name = page.node.newXObject("Image", img.ref);
  page.pushOperators(
    pushGraphicsState(),
    concatTransformationMatrix(...orientMatrix(o, (W - dw) / 2, (H - dh) / 2, dw, dh)),
    drawObject(name),
    popGraphicsState(),
  );
}

/** The page that stands in for a file that couldn't be read. */
function addPlaceholder(out: PDFDocument, fonts: Fonts, title: string, why: "locked" | "broken"): void {
  const page = out.addPage(LETTER);
  page.setFont(fonts.reg);
  const M = 72;
  const width = LETTER[0] - M * 2;
  let y = LETTER[1] - 180;
  const head = plain(fonts.bold, `This file couldn't be added: ${title.replace(/[.\s]+$/, "")}.`);
  for (const line of wrap(fonts.bold, head, 18, width, 5)) {
    text(page, line, M, y, 18, fonts.bold);
    y -= 24;
  }
  y -= 10;
  const tail = why === "locked"
    ? "It has a password. Save a copy without the password, then add it again."
    : "Add it again.";
  for (const line of wrap(fonts.reg, tail, 13, width, 3)) {
    text(page, line, M, y, 13, fonts.reg, GRAY);
    y -= 18;
  }
}

/** Copy one part's pages onto the end of `out`. False when the file
 *  couldn't be read and a placeholder page went in instead. */
async function addPart(out: PDFDocument, fonts: Fonts, part: PackPart, values?: Record<FieldKey, string>): Promise<boolean> {
  const bytes = toU8(part?.bytes);
  const title = itemTitle(part);
  const kind = bytes.length ? sniff(bytes, part.mime) : null;
  if (kind === "pdf") {
    const read = await readPdf(bytes, true);
    if ("doc" in read) {
      // A blank form's header filled in: its own fillable fields first,
      // then the spots set up in the kit (the rest is filled by hand).
      const blank = part.kind === "form" && !part.signed && !!values;
      const acro = blank ? fillAcro(read.doc, values!, fonts.reg) : new Set<FieldKey>();
      const fills = blank ? (part.fields ?? []).filter((f) => f && !acro.has(f.key)) : [];
      // A blank form gets its code in the bottom corner. Forms often have
      // a signature box down there, so the form is drawn a little smaller
      // (top kept, centered) to leave a clear strip for the code and the
      // footer: nothing on the form is ever covered. Turned pages keep
      // their size (the code goes over the corner as on any page).
      if (part.kind === "form" && part.qr && !part.signed) {
        try {
          const src = read.doc.getPages();
          if (src.every((pg) => !(pg.getRotation().angle % 360))) {
            const embedded = await out.embedPages(src);
            embedded.forEach((ep, i) => {
              const { width: W, height: H } = src[i].getSize();
              const k = Math.min(6, Math.max(1, Math.min(Math.max(W, H) / 1224, Math.min(W, H) / 792)));
              const band = 64 * k;
              const s = Math.min(1, (H - band - 6 * k) / H);
              const page = out.addPage([W, H]);
              const at = { x: (W - W * s) / 2, y: H - H * s - 6 * k };
              page.drawPage(ep, { ...at, xScale: s, yScale: s });
              if (fills.length) writeFills(page, fonts.reg, fills, i, values!, { ...at, s }, W);
            });
            return true;
          }
        } catch { /* copied as is below */ }
      }
      try {
        const pages = await out.copyPages(read.doc, read.doc.getPageIndices());
        pages.forEach((p, i) => {
          out.addPage(p);
          if (!fills.length) return;
          ownContents(p);
          const mb = box(p.getMediaBox());
          writeFills(p, fonts.reg, fills, i, values!, { x: mb.x0, y: mb.y0, s: 1 }, mb.x1 - mb.x0);
        });
        return true;
      } catch { /* placeholder */ }
    }
    addPlaceholder(out, fonts, title, "fail" in read ? read.fail : "broken");
    return false;
  }
  if (kind === "png" || kind === "jpg") {
    try {
      await addImagePage(out, own(bytes), kind);
      return true;
    } catch { /* placeholder */ }
  }
  addPlaceholder(out, fonts, title, "broken");
  return false;
}

// ─── The package ─────────────────────────────────────────────────────────

/** Pages a part will take in the package: a PDF's own count, 1 for an
 *  image, 1 for a file that can't be read (its placeholder page). */
export async function pageCount(bytes: Uint8Array, mime: PackPart["mime"]): Promise<number> {
  const b = toU8(bytes);
  if (!b.length || sniff(b, mime) !== "pdf") return 1;
  const read = await readPdf(b, false);
  return "doc" in read ? read.doc.getPageCount() : 1;
}

/** Cover, contents, then every part in order, footers on every page after
 *  the cover. A part that can't be read becomes one placeholder page and
 *  the package still builds. */
export async function assemblePackage(meta: PackMeta, parts: PackPart[], kit?: KitTemplates): Promise<Assembled> {
  const list = Array.isArray(parts) ? parts.filter(Boolean) : [];
  const out = await PDFDocument.create();
  const fonts: Fonts = {
    reg: await out.embedFont(StandardFonts.Helvetica),
    bold: await out.embedFont(StandardFonts.HelveticaBold),
  };
  const makeQr = await qrMaker();
  const when = printedWords(meta.printedAt, meta.timeZone);
  const fillVals = fillValues(fonts.reg, meta, when);

  // 1. Every part's pages, in order. One source file is open at a time.
  const placed: Array<{ first: number; count: number; failed: boolean }> = [];
  const owner: number[] = [];   // part page index → part index
  for (let i = 0; i < list.length; i += 1) {
    const first = out.getPageCount();
    const ok = await addPart(out, fonts, list[i], fillVals);
    const n = out.getPageCount() - first;
    placed.push({ first, count: n, failed: !ok });
    for (let k = 0; k < n; k += 1) owner.push(i);
  }
  const partPages = out.getPageCount();
  const failed = placed.map((p) => p.failed);

  // 2. Contents: laid out first so its own length, and so every page
  // number in it, is known before anything is printed.
  let tocDoc: PDFDocument | null = null;
  if (kit?.toc?.bytes) {
    const read = await readPdf(toU8(kit.toc.bytes), true);
    if ("doc" in read) tocDoc = read.doc;
  }
  let region = tocDoc ? tocRegion(frameOf(tocDoc.getPage(0)), kit?.toc?.region) : GEN_REGION;
  let tocPages = paginate(layoutRows(list, failed, fonts, region), region.h - (region.cols ? 0 : HEAD_H));
  let copies: PDFPage[] | null = null;
  if (tocDoc) {
    try {
      copies = await out.copyPages(tocDoc, tocPages.map(() => 0));
    } catch {
      copies = null;
      region = GEN_REGION;
      tocPages = paginate(layoutRows(list, failed, fonts, region), region.h - HEAD_H);
    }
  }
  const T = tocPages.length;
  const total = 1 + T + partPages;
  const starts = placed.map((p) => 2 + T + p.first);

  tocPages.forEach((rows, i) => {
    const page = copies ? out.insertPage(i, copies[i]) : out.insertPage(i, LETTER);
    ownContents(page);
    page.setFont(fonts.reg);
    const f = frameOf(page);
    f.begin();
    if (!copies) drawContentsHead(page, fonts, meta, i);
    drawRows(page, fonts, region, rows, starts);
    f.end();
  });

  // 3. Cover, first.
  const covered = kit?.cover?.bytes ? await addTemplateCover(out, fonts, meta, kit.cover, makeQr, when) : false;
  if (!covered) {
    const page = out.insertPage(0, LETTER);
    page.setFont(fonts.reg);
    const logo = await embedLogo(out, meta.logo);
    drawCover(page, fonts, meta, logo, list.length, total, makeQr(meta.landingUrl), when);
  }

  // 4. Footer on every page after the cover; a QR on every page of a form.
  const pages = out.getPages();
  const job = jobLine(meta);
  for (let i = 1; i < pages.length; i += 1) {
    const page = pages[i];
    const pi = i > T ? owner[i - 1 - T] : -1;
    const part = pi >= 0 ? list[pi] : null;
    if (part) {
      ownContents(page);
      page.setFont(fonts.reg);
    }
    const f = frameOf(page);
    f.begin();
    drawFooter(page, fonts, f, job, part ? itemTitle(part) : "Contents", `Page ${i + 1} of ${total}`, !!part?.signed);
    // A signed copy is a scan of the printed blank: it carries its own QR.
    const q = part && part.kind === "form" && !part.signed && !placed[pi].failed ? makeQr(part.qr) : null;
    if (q) {
      const qs = 42 * f.k;
      drawQr(page, q, f.w - Math.min(36 * f.k, f.w * 0.06) - qs, 35 * f.k, qs);
    }
    f.end();
  }

  out.setTitle(suggestFileName(meta).replace(/\.pdf$/i, ""));
  if (String(meta.workspace ?? "").trim()) out.setAuthor(String(meta.workspace).trim());
  if (String(meta.project ?? "").trim()) out.setSubject(String(meta.project).trim());
  if (meta.printedAt instanceof Date && !Number.isNaN(meta.printedAt.getTime())) {
    out.setCreationDate(meta.printedAt);
    out.setModificationDate(meta.printedAt);
  }

  const pdf = await out.save();
  return {
    pdf,
    pages: total,
    toc: list.map((p, i) => ({ id: p.id, title: p.title, page: starts[i], pages: placed[i].count })),
  };
}
