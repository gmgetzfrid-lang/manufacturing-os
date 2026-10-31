// hourlyLogFiles — the hourly log (lib/hourlyLog) as files to keep: a PDF
// and a Word document on the project's letterhead (page 1 of each shift
// with page 1's letterhead, the rest with the one that repeats), and an
// Excel sheet, one line per row. Each shift starts on a new page.

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage, type PDFPage, type RGB } from "pdf-lib";
import JSZip from "jszip";
import { LETTER, type Letterhead, type LhItem, type LhLayer, type LhPara, type LhRun } from "@/lib/letterhead";
import { noEmDash } from "@/lib/noEmDash";
import type { LogEntry, ShiftLog } from "@/lib/hourlyLog";
import { boldRuns, plainLine } from "@/lib/shiftHourly";

export interface LogFileOpts {
  project: string;
  lh: Letterhead | null;
  /** "Exported Oct 30, 2026 2:15 PM" */
  exported: string;
  /** A picture the file can't carry (GIF, WebP) as a PNG data URL. */
  toPng?: (dataUrl: string) => Promise<string | null>;
}

const PLAIN_MARGINS = { top: 0.75, right: 0.75, bottom: 0.75, left: 0.75 };
const pageOf = (lh: Letterhead | null) => lh?.page ?? LETTER;
const marginsOf = (lh: Letterhead | null) => lh?.margins ?? PLAIN_MARGINS;

/** What a letterhead draws on page 1 of a shift, and on the pages after. */
function layersOf(lh: Letterhead | null): { first: LhLayer | null; rest: LhLayer | null } {
  if (!lh) return { first: null, rest: null };
  const firstOnly = lh.pages === "first";
  return { first: lh.first ?? lh.layer, rest: firstOnly ? null : lh.layer };
}

/** Room for the page number at the foot: nothing of the letterhead there. */
function footFree(lh: Letterhead | null): boolean {
  if (!lh) return true;
  const ph = lh.page.h, mb = lh.margins.bottom;
  return [lh.layer, lh.first].every((l) => !l || (!l.image && !l.footer && !(l.floats ?? []).some((f) => f.y + f.h > ph - mb)));
}

/** A row's text, top to bottom: its name, what happened, what kept going. */
export function entryParas(e: LogEntry): Array<{ text: string; style: "title" | "line" | "cont" | "muted" }> {
  const out: Array<{ text: string; style: "title" | "line" | "cont" | "muted" }> = [];
  if (e.title) out.push({ text: e.title, style: e.kind === "break" ? "muted" : "title" });
  for (const l of e.lines) out.push({ text: l, style: "line" });
  // What moved its % that hour, in the progress color.
  for (const c of e.continuing) out.push({ text: c, style: "cont" });
  if (e.kind !== "break" && !e.lines.length && !e.continuing.length) out.push({ text: e.kind === "meeting" ? "No attendance entered" : "Nothing logged", style: "muted" });
  return out.map((p) => ({ ...p, text: noEmDash(p.text) }));
}

const kicker = (project: string) => `${project} · Hourly shift log`.toUpperCase();
const headingOf = (l: ShiftLog) => `${l.title} · ${l.date}`;
const subOf = (l: ShiftLog, exported: string) => `${l.window}${l.through ? ` · logged through ${l.through}` : ""} · ${exported}`;

/** "data:image/png;base64,…" → its bytes and type. */
function dataUrlBytes(src: string): { mime: string; bytes: Uint8Array } | null {
  const m = /^data:(image\/[a-z+.-]+);base64,(.*)$/i.exec(src);
  if (!m) return null;
  try {
    const bin = atob(m[2]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { mime: m[1].toLowerCase(), bytes };
  } catch { return null; }
}

/** Every picture a letterhead uses. */
function picturesOf(lh: Letterhead | null): string[] {
  const out = new Set<string>();
  const items = (xs: LhItem[]) => xs.forEach((it) => ("p" in it ? it.p.runs.forEach((r) => r.img && out.add(r.img.src)) : it.table.rows.forEach((row) => row.cells.forEach((c) => items(c.items)))));
  for (const l of [lh?.layer, lh?.first]) {
    if (!l) continue;
    if (l.image) out.add(l.image);
    for (const f of l.floats ?? []) { if (f.src) out.add(f.src); if (f.items) items(f.items); }
    if (l.header) items(l.header.items);
    if (l.footer) items(l.footer.items);
  }
  return [...out];
}

/** Pictures as PNG / JPEG (all a PDF takes; Word also takes GIF). */
async function usable(srcs: string[], ok: (mime: string) => boolean, toPng?: LogFileOpts["toPng"]): Promise<Map<string, { mime: string; bytes: Uint8Array }>> {
  const out = new Map<string, { mime: string; bytes: Uint8Array }>();
  for (const src of srcs) {
    let d = dataUrlBytes(src);
    if (d && !ok(d.mime) && toPng) { const png = await toPng(src).catch(() => null); d = png ? dataUrlBytes(png) : null; }
    if (d && ok(d.mime)) out.set(src, d);
  }
  return out;
}

// ─── PDF ─────────────────────────────────────────────────────────────────

const IN = 72;
const INK = rgb(0.06, 0.09, 0.16), GRAY = rgb(0.39, 0.45, 0.53), RULE = rgb(0.85, 0.87, 0.9);
interface Fonts { r: PDFFont; b: PDFFont; i: PDFFont; bi: PDFFont }
const fontFor = (f: Fonts, b?: boolean, i?: boolean) => (b ? (i ? f.bi : f.b) : i ? f.i : f.r);
const hexColor = (h?: string): RGB => (h && /^[0-9a-f]{6}$/i.test(h) ? rgb(parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255) : rgb(0, 0, 0));

// The standard PDF fonts have no arrows and the like: said in plain letters.
const SWAP: Record<string, string> = { "→": "->", "←": "<-", "≥": ">=", "≤": "<=", "‑": "-", "−": "-", " ": " ", " ": " ", " ": " ", "\t": " " };
function textFor(font: PDFFont, seen: Map<string, boolean>) {
  return (s: string) => [...noEmDash(s)].map((ch) => {
    const c = SWAP[ch] ?? ch;
    if (c.length !== 1) return c;
    let good = seen.get(c);
    if (good == null) { try { font.widthOfTextAtSize(c, 10); good = true; } catch { good = false; } seen.set(c, good); }
    return good ? c : "";
  }).join("");
}

/** Words onto lines `width` wide; a word longer than a line, by letter. */
/** Text in bold and plain parts, wrapped to a width: each line its parts. */
function wrapRuns(runs: Array<{ t: string; f: PDFFont }>, size: number, width: number): Array<Array<{ t: string; f: PDFFont }>> {
  const words: Array<{ w: string; f: PDFFont; sp: boolean }> = [];
  for (const r of runs) {
    for (const part of r.t.split(/(\s+)/)) {
      if (!part) continue;
      if (/^\s+$/.test(part)) { if (words.length) words[words.length - 1].sp = true; } else words.push({ w: part, f: r.f, sp: false });
    }
  }
  const lines: Array<Array<{ t: string; f: PDFFont }>> = [];
  let cur: Array<{ t: string; f: PDFFont }> = [], curW = 0, gap = false, gapF: PDFFont | null = null;
  for (const x of words) {
    const ww = x.f.widthOfTextAtSize(x.w, size);
    const sw = gap && gapF ? gapF.widthOfTextAtSize(" ", size) : 0;
    if (cur.length && curW + sw + ww > width) { lines.push(cur); cur = []; curW = 0; }
    else if (cur.length && gap && gapF) { cur.push({ t: " ", f: gapF }); curW += sw; }
    cur.push({ t: x.w, f: x.f }); curW += ww;
    gap = x.sp; gapF = x.f;
  }
  if (cur.length) lines.push(cur);
  // Neighbours in one font drawn as one.
  return lines.map((l) => l.reduce((acc, g) => { const last = acc[acc.length - 1]; if (last && last.f === g.f) last.t += g.t; else acc.push({ ...g }); return acc; }, [] as Array<{ t: string; f: PDFFont }>));
}

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const lines: string[] = [];
  let cur = "";
  for (const w of text.split(/\s+/).filter(Boolean)) {
    const t = cur ? `${cur} ${w}` : w;
    if (font.widthOfTextAtSize(t, size) <= width) { cur = t; continue; }
    if (cur) lines.push(cur);
    cur = "";
    for (const ch of w) {
      if (cur && font.widthOfTextAtSize(cur + ch, size) > width) { lines.push(cur); cur = ch; } else cur += ch;
    }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [""];
}

type Draw = (page: PDFPage, x: number, top: number) => void;
interface Laid { h: number; draw: Draw }

/** A letterhead's paragraphs and tables, `width` wide (points). */
function layItems(items: LhItem[], width: number, fonts: Fonts, imgs: Map<string, PDFImage>, safe: (f: PDFFont) => (s: string) => string): Laid {
  const parts: Laid[] = items.map((it) => ("p" in it ? layPara(it.p, width, fonts, imgs, safe) : (() => {
    const rows = it.table.rows.map((row) => {
      const n = row.cells.length || 1;
      let x = 0;
      const cells = row.cells.map((c) => {
        const w = c.w ? c.w * IN : width / n;
        const laid = { x, ...layItems(c.items, w, fonts, imgs, safe) };
        x += w;
        return laid;
      });
      return { h: Math.max(0, ...cells.map((c) => c.h)), cells };
    });
    return {
      h: rows.reduce((s, r) => s + r.h, 0),
      draw: (page: PDFPage, x: number, top: number) => { let y = top; for (const r of rows) { for (const c of r.cells) c.draw(page, x + c.x, y); y += r.h; } },
    };
  })()));
  return { h: parts.reduce((s, p) => s + p.h, 0), draw: (page, x, top) => { let y = top; for (const p of parts) { p.draw(page, x, y); y += p.h; } } };
}

type Tok = { w: number; text?: string; font?: PDFFont; size?: number; color?: RGB; img?: PDFImage; ih?: number; space?: boolean; br?: boolean };

function layPara(p: LhPara, width: number, fonts: Fonts, imgs: Map<string, PDFImage>, safe: (f: PDFFont) => (s: string) => string): Laid {
  const toks: Tok[] = [];
  let maxSize = 11;
  p.runs.forEach((r: LhRun) => {
    if (r.br) { toks.push({ w: 0, br: true }); return; }
    if (r.tab) { toks.push({ w: 0.5 * IN }); return; }
    if (r.img) { const img = imgs.get(r.img.src); if (img) toks.push({ w: r.img.w * IN, img, ih: r.img.h * IN }); return; }
    const size = r.pt ?? 11;
    maxSize = Math.max(maxSize, size);
    const font = fontFor(fonts, r.b, r.i);
    const t = safe(font)(r.t ?? "");
    for (const piece of t.split(/( +)/)) if (piece) toks.push({ w: font.widthOfTextAtSize(piece, size), text: piece, font, size, color: hexColor(r.color), space: /^ +$/.test(piece) });
  });
  const textH = maxSize * 1.17 * (p.line ?? 1);
  const lines: Tok[][] = [[]];
  let used = 0;
  for (const t of toks) {
    const line = lines[lines.length - 1];
    if (t.br) { lines.push([]); used = 0; continue; }
    if (t.space && !line.length) continue;
    if (!t.space && line.length && used + t.w > width) {
      while (line.length && line[line.length - 1].space) used -= line.pop()!.w;
      lines.push([t]); used = t.w; continue;
    }
    line.push(t); used += t.w;
  }
  const laid = lines.map((l) => {
    while (l.length && l[l.length - 1].space) l.pop();
    return { toks: l, w: l.reduce((s, t) => s + t.w, 0), h: Math.max(textH, ...l.map((t) => t.ih ?? 0)) };
  });
  const before = p.before ?? 0, after = p.after ?? 0;
  return {
    h: before + laid.reduce((s, l) => s + l.h, 0) + after,
    draw: (page, x, top) => {
      const H = page.getHeight();
      let y = top + before;
      for (const l of laid) {
        let dx = p.align === "right" ? width - l.w : p.align === "center" ? (width - l.w) / 2 : 0;
        const base = y + l.h - (textH - maxSize) / 2 - maxSize * 0.22;
        for (const t of l.toks) {
          if (t.img) page.drawImage(t.img, { x: x + dx, y: H - (base + maxSize * 0.22), width: t.w, height: t.ih! });
          else if (t.text && !t.space) page.drawText(t.text, { x: x + dx, y: H - base, size: t.size!, font: t.font!, color: t.color! });
          dx += t.w;
        }
        y += l.h;
      }
    },
  };
}

function drawLayer(page: PDFPage, l: LhLayer, lh: Letterhead, fonts: Fonts, imgs: Map<string, PDFImage>, safe: (f: PDFFont) => (s: string) => string) {
  const H = page.getHeight();
  const bg = l.image ? imgs.get(l.image) : undefined;
  if (bg) page.drawImage(bg, { x: 0, y: 0, width: lh.page.w * IN, height: lh.page.h * IN });
  for (const f of l.floats ?? []) {
    const img = f.src ? imgs.get(f.src) : undefined;
    if (img) page.drawImage(img, { x: f.x * IN, y: H - (f.y + f.h) * IN, width: f.w * IN, height: f.h * IN });
    else if (f.fill) page.drawRectangle({ x: f.x * IN, y: H - (f.y + f.h) * IN, width: f.w * IN, height: f.h * IN, color: hexColor(f.fill) });
    if (f.items?.length) layItems(f.items, f.w * IN, fonts, imgs, safe).draw(page, f.x * IN, f.y * IN);
  }
  if (l.header) layItems(l.header.items, l.header.w * IN, fonts, imgs, safe).draw(page, l.header.x * IN, (l.header.top ?? 0) * IN);
  if (l.footer) {
    const laid = layItems(l.footer.items, l.footer.w * IN, fonts, imgs, safe);
    laid.draw(page, l.footer.x * IN, H - (l.footer.bottom ?? 0) * IN - laid.h);
  }
}

/** The log as a PDF on the letterhead. */
export async function hourlyLogPdf(logs: ShiftLog[], o: LogFileOpts): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`${o.project} - Hourly shift log`);
  const fonts: Fonts = {
    r: await doc.embedFont(StandardFonts.Helvetica), b: await doc.embedFont(StandardFonts.HelveticaBold),
    i: await doc.embedFont(StandardFonts.HelveticaOblique), bi: await doc.embedFont(StandardFonts.HelveticaBoldOblique),
  };
  const seen = new Map<PDFFont, Map<string, boolean>>();
  const safe = (f: PDFFont) => { if (!seen.has(f)) seen.set(f, new Map()); return textFor(f, seen.get(f)!); };
  const pics = await usable(picturesOf(o.lh), (m) => m === "image/png" || m === "image/jpeg", o.toPng);
  const imgs = new Map<string, PDFImage>();
  for (const [src, d] of pics) {
    try { imgs.set(src, d.mime === "image/png" ? await doc.embedPng(d.bytes) : await doc.embedJpg(d.bytes)); } catch { /* a picture it can't read: left off */ }
  }
  const P = pageOf(o.lh), M = marginsOf(o.lh);
  const W = P.w * IN, H = P.h * IN;
  const left = M.left * IN, right = W - M.right * IN, top = M.top * IN, bottom = H - M.bottom * IN;
  const timeW = 0.95 * IN, textX = left + timeW, textW = right - textX;
  const { first, rest } = layersOf(o.lh);

  let page!: PDFPage;
  let y = 0;
  const text = (s: string, x: number, at: number, size: number, font: PDFFont, color: RGB) => page.drawText(safe(font)(s), { x, y: H - at, size, font, color });
  const newPage = (l: LhLayer | null) => {
    page = doc.addPage([W, H]);
    if (l && o.lh) drawLayer(page, l, o.lh, fonts, imgs, safe);
    y = top;
  };
  const tableHead = () => {
    text("TIME", left, y + 8, 7.5, fonts.b, GRAY);
    text("WHAT HAPPENED", textX, y + 8, 7.5, fonts.b, GRAY);
    y += 12;
    page.drawLine({ start: { x: left, y: H - y }, end: { x: right, y: H - y }, thickness: 0.75, color: RULE });
    y += 4;
  };
  const style = { title: { f: fonts.b, s: 10, c: INK }, line: { f: fonts.r, s: 10, c: INK }, cont: { f: fonts.i, s: 9, c: GRAY }, muted: { f: fonts.i, s: 9.5, c: GRAY } };

  for (const l of logs) {
    newPage(first);
    text(kicker(o.project), left, y + 8, 7.5, fonts.b, GRAY);
    y += 13;
    for (const ln of wrap(safe(fonts.b)(headingOf(l)), fonts.b, 14, right - left)) { text(ln, left, y + 13, 14, fonts.b, INK); y += 18; }
    for (const ln of wrap(safe(fonts.r)(subOf(l, o.exported)), fonts.r, 9, right - left)) { text(ln, left, y + 9, 9, fonts.r, GRAY); y += 12; }
    y += 8;
    tableHead();
    for (const e of l.entries) {
      // A line's work order in bold, the rest plain.
      const lines = entryParas(e).flatMap((p, i) => {
        const st = style[p.style];
        const runs = (p.style === "line" || p.style === "cont" ? boldRuns(p.text) : [{ t: p.text, b: false }]).map((r) => { const f = r.b ? (p.style === "cont" ? fonts.bi : fonts.b) : st.f; return { t: safe(f)(r.t), f }; });
        return wrapRuns(runs, st.s, textW).map((segs, j) => ({ segs, s: st.s, c: st.c, h: st.s * 1.32 + (j === 0 && i > 0 ? 2 : 0) }));
      });
      const pad = 5;
      const need = pad + lines.slice(0, 3).reduce((s, x) => s + x.h, 0);
      const cont = () => {
        newPage(rest);
        text(`${headingOf(l)} (continued)`, left, y + 9, 9, fonts.b, GRAY);
        y += 15;
        tableHead();
      };
      if (y + need > bottom) cont();
      y += pad;
      text(e.clock, left, y + 10, 10, fonts.b, e.kind === "break" ? GRAY : INK);
      for (const x of lines) {
        if (y + x.h > bottom) { cont(); y += pad; text(e.clock, left, y + 10, 10, fonts.b, GRAY); }
        let dx = textX;
        for (const g of x.segs) { text(g.t, dx, y + x.s + (x.h - x.s * 1.32), x.s, g.f, x.c); dx += g.f.widthOfTextAtSize(g.t, x.s); }
        y += x.h;
      }
      y += pad;
      page.drawLine({ start: { x: left, y: H - y }, end: { x: right, y: H - y }, thickness: 0.5, color: RULE });
    }
  }
  if (!logs.length) {
    newPage(first);
    text(kicker(o.project), left, y + 8, 7.5, fonts.b, GRAY);
    text("Nothing logged yet.", left, y + 30, 12, fonts.r, INK);
  }
  // Page numbers, where the letterhead leaves the foot free.
  if (footFree(o.lh)) {
    const pages = doc.getPages();
    const at = H - (M.bottom * IN) / 2;
    pages.forEach((pg, i) => {
      page = pg;
      const label = `Page ${i + 1} of ${pages.length}`;
      text(`${o.project} · Hourly shift log`, left, at, 7.5, fonts.r, GRAY);
      text(label, right - fonts.r.widthOfTextAtSize(label, 7.5), at, 7.5, fonts.r, GRAY);
    });
  }
  return doc.save();
}

// ─── Word ────────────────────────────────────────────────────────────────

const TW = 1440, EMU = 914400;
const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const xe = (s: string) => noEmDash(s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const tw = (inches: number) => Math.round(inches * TW);
const emu = (inches: number) => Math.round(inches * EMU);

/** One part of the file (the body, a header, a footer) and the pictures it links. */
class Part {
  rels: Array<{ id: string; type: string; target: string }> = [];
  constructor(public name: string) {}
  link(type: string, target: string): string {
    const had = this.rels.find((r) => r.type === type && r.target === target);
    if (had) return had.id;
    const id = `rId${this.rels.length + 1}`;
    this.rels.push({ id, type, target });
    return id;
  }
  relsXml(): string {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${this.rels.map((r) => `<Relationship Id="${r.id}" Type="${r.type}" Target="${r.target}"/>`).join("")}</Relationships>`;
  }
}

class Media {
  files = new Map<string, { name: string; bytes: Uint8Array }>();
  next = 1;
  constructor(public pics: Map<string, { mime: string; bytes: Uint8Array }>) {}
  /** The picture's id in `part`, or null when it can't go in. */
  use(part: Part, src: string): string | null {
    let f = this.files.get(src);
    if (!f) {
      const d = this.pics.get(src);
      if (!d) return null;
      f = { name: `image${this.files.size + 1}.${d.mime === "image/jpeg" ? "jpeg" : d.mime === "image/gif" ? "gif" : "png"}`, bytes: d.bytes };
      this.files.set(src, f);
    }
    return part.link(`${REL}/image`, `media/${f.name}`);
  }
  id() { return this.next++; }
}

/** A solid box of colour, as a one-pixel picture stretched to size. */
function pixelGif(hex: string): Uint8Array {
  const c = /^[0-9a-f]{6}$/i.test(hex) ? hex : "000000";
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(c.slice(i, i + 2), 16));
  return new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0x80, 0, 0, r, g, b, 0, 0, 0,
    0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0x02, 0x02, 0x44, 0x01, 0, 0x3b]);
}

const graphic = (rid: string, id: number, w: number, h: number) =>
  `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${id}" name="Picture ${id}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${emu(w)}" cy="${emu(h)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic>`;
const inlinePic = (rid: string, id: number, w: number, h: number) =>
  `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${emu(w)}" cy="${emu(h)}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:docPr id="${id}" name="Picture ${id}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>${graphic(rid, id, w, h)}</wp:inline></w:drawing></w:r>`;
const anchorPic = (rid: string, id: number, x: number, y: number, w: number, h: number) =>
  `<w:r><w:drawing><wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="${id}" behindDoc="1" locked="0" layoutInCell="1" allowOverlap="1"><wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="page"><wp:posOffset>${emu(x)}</wp:posOffset></wp:positionH><wp:positionV relativeFrom="page"><wp:posOffset>${emu(y)}</wp:posOffset></wp:positionV><wp:extent cx="${emu(w)}" cy="${emu(h)}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapNone/><wp:docPr id="${id}" name="Picture ${id}"/><wp:cNvGraphicFramePr/>${graphic(rid, id, w, h)}</wp:anchor></w:drawing></w:r>`;

function rPr(o: { font?: string; b?: boolean; i?: boolean; color?: string; pt?: number; u?: boolean }): string {
  const f = o.font ? xe(o.font) : "";
  const inner = [f ? `<w:rFonts w:ascii="${f}" w:hAnsi="${f}" w:cs="${f}"/>` : "", o.b ? "<w:b/>" : "", o.i ? "<w:i/>" : "",
    o.color && /^[0-9a-f]{6}$/i.test(o.color) ? `<w:color w:val="${o.color}"/>` : "",
    o.pt ? `<w:sz w:val="${Math.round(o.pt * 2)}"/><w:szCs w:val="${Math.round(o.pt * 2)}"/>` : "", o.u ? '<w:u w:val="single"/>' : ""].join("");
  return inner ? `<w:rPr>${inner}</w:rPr>` : "";
}
const textRun = (t: string, o: Parameters<typeof rPr>[0] = {}) => `<w:r>${rPr(o)}<w:t xml:space="preserve">${xe(t)}</w:t></w:r>`;

interface DocxCtx { media: Media; part: Part }

function lhParaXml(p: LhPara, c: DocxCtx, ind?: { l: number; r: number }, frame?: string): string {
  const jc = p.align && p.align !== "left" ? `<w:jc w:val="${p.align === "justify" ? "both" : p.align}"/>` : "";
  const indent = ind && (ind.l || ind.r) ? `<w:ind w:left="${tw(ind.l)}" w:right="${tw(ind.r)}"/>` : "";
  const ppr = `<w:pPr>${frame ?? ""}<w:spacing w:before="${Math.round((p.before ?? 0) * 20)}" w:after="${Math.round((p.after ?? 0) * 20)}" w:line="${Math.round((p.line ?? 1) * 240)}" w:lineRule="auto"/>${indent}${jc}</w:pPr>`;
  // A tab before right-aligned or centred words would push them about in Word.
  let lead = p.align === "right" || p.align === "center";
  const runs = p.runs.map((r) => {
    if (r.tab && lead) return "";
    if (!r.tab) lead = false;
    if (r.br) return "<w:r><w:br/></w:r>";
    if (r.tab) return "<w:r><w:tab/></w:r>";
    if (r.img) { const rid = c.media.use(c.part, r.img.src); return rid ? inlinePic(rid, c.media.id(), r.img.w, r.img.h) : ""; }
    return textRun(r.t ?? "", { font: r.font, b: r.b, i: r.i, u: r.u, color: r.color, pt: r.pt });
  }).join("");
  return `<w:p>${ppr}${runs}</w:p>`;
}

function lhItemsXml(items: LhItem[], c: DocxCtx, ind?: { l: number; r: number }): string {
  return items.map((it) => {
    if ("p" in it) return lhParaXml(it.p, c, ind);
    const rows = it.table.rows;
    const n = Math.max(1, ...rows.map((r) => r.cells.length));
    const widths = (rows[0]?.cells ?? []).map((cell) => cell.w ?? 6.5 / n);
    return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblLayout w:type="fixed"/><w:tblCellMar><w:left w:w="0" w:type="dxa"/><w:right w:w="0" w:type="dxa"/></w:tblCellMar><w:tblLook w:val="0000"/></w:tblPr><w:tblGrid>${widths.map((w) => `<w:gridCol w:w="${tw(w)}"/>`).join("")}</w:tblGrid>${rows.map((r) =>
      `<w:tr>${r.cells.map((cell, i) => `<w:tc><w:tcPr><w:tcW w:w="${tw(cell.w ?? widths[i] ?? 6.5 / n)}" w:type="dxa"/></w:tcPr>${lhItemsXml(cell.items, c) || "<w:p/>"}${cell.items.length && !("p" in cell.items[cell.items.length - 1]) ? "<w:p/>" : ""}</w:tc>`).join("")}</w:tr>`).join("")}</w:tbl>`;
  }).join("");
}

/** A header (the letterhead's pictures, boxes and header text) or footer. */
function layerXml(l: LhLayer, kind: "hdr" | "ftr", lh: Letterhead, c: DocxCtx): string {
  const out: string[] = [];
  if (kind === "hdr") {
    const anchors: string[] = [];
    if (l.image) { const rid = c.media.use(c.part, l.image); if (rid) anchors.push(anchorPic(rid, c.media.id(), 0, 0, lh.page.w, lh.page.h)); }
    for (const f of l.floats ?? []) {
      const src = f.src ?? (f.fill ? `fill:${f.fill}` : null);
      if (src) {
        if (src.startsWith("fill:") && !c.media.pics.has(src)) c.media.pics.set(src, { mime: "image/gif", bytes: pixelGif(f.fill!) });
        const rid = c.media.use(c.part, src);
        if (rid) anchors.push(anchorPic(rid, c.media.id(), f.x, f.y, f.w, f.h));
      }
    }
    // The pictures hang off a paragraph of no height at the top.
    if (anchors.length) out.push(`<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="20" w:lineRule="exact"/><w:rPr><w:sz w:val="2"/></w:rPr></w:pPr>${anchors.join("")}</w:p>`);
    // A text box: its paragraphs in a frame where it sat on the page.
    for (const f of l.floats ?? []) {
      if (!f.items?.length) continue;
      const frame = `<w:framePr w:w="${tw(f.w)}" w:h="${tw(f.h)}" w:hRule="exact" w:wrap="none" w:hAnchor="page" w:vAnchor="page" w:x="${tw(f.x)}" w:y="${tw(f.y)}"/>`;
      for (const it of f.items) if ("p" in it) out.push(lhParaXml(it.p, c, undefined, frame));
    }
  }
  const band = kind === "hdr" ? l.header : l.footer;
  if (band) out.push(lhItemsXml(band.items, c, { l: band.x - lh.margins.left, r: lh.page.w - band.x - band.w - lh.margins.right }));
  if (!out.length || /<\/w:tbl>$/.test(out[out.length - 1])) out.push("<w:p/>");
  const tag = kind === "hdr" ? "w:hdr" : "w:ftr";
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><${tag} ${NS}>${out.join("")}</${tag}>`;
}

const pageNumberFooter = (o: LogFileOpts, contentW: number) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:ftr ${NS}><w:p><w:pPr><w:tabs><w:tab w:val="right" w:pos="${tw(contentW)}"/></w:tabs></w:pPr>${textRun(`${o.project} · Hourly shift log`, { color: "64748B", pt: 7.5 })}<w:r><w:tab/></w:r>${textRun("Page ", { color: "64748B", pt: 7.5 })}${["PAGE", "NUMPAGES"].map((f, i) =>
    `${i ? textRun(" of ", { color: "64748B", pt: 7.5 }) : ""}<w:r>${rPr({ color: "64748B", pt: 7.5 })}<w:fldChar w:fldCharType="begin"/></w:r><w:r>${rPr({ color: "64748B", pt: 7.5 })}<w:instrText xml:space="preserve"> ${f} </w:instrText></w:r><w:r>${rPr({ color: "64748B", pt: 7.5 })}<w:fldChar w:fldCharType="separate"/></w:r>${textRun("1", { color: "64748B", pt: 7.5 })}<w:r>${rPr({ color: "64748B", pt: 7.5 })}<w:fldChar w:fldCharType="end"/></w:r>`).join("")}</w:p></w:ftr>`;

/** The first font the letterhead's words use, for the log's own words. */
function bodyFont(lh: Letterhead | null): string {
  const find = (items: LhItem[]): string | undefined => {
    for (const it of items) {
      const f = "p" in it ? it.p.runs.find((r) => r.font && r.t?.trim())?.font : it.table.rows.flatMap((r) => r.cells).map((c) => find(c.items)).find(Boolean);
      if (f) return f;
    }
    return undefined;
  };
  for (const l of [lh?.first, lh?.layer]) {
    const f = l && (find(l.header?.items ?? []) ?? find(l.footer?.items ?? []));
    if (f) return f;
  }
  return "Calibri";
}

function shiftXml(l: ShiftLog, o: LogFileOpts, contentW: number): string {
  const timeW = 0.95;
  const cellP = (t: string, st: Parameters<typeof rPr>[0], after = 20) => `<w:p><w:pPr><w:spacing w:before="0" w:after="${after}"/></w:pPr>${textRun(t, st)}</w:p>`;
  const look = { title: { b: true, pt: 10 }, line: { pt: 10 }, cont: { i: true, pt: 9, color: "64748B" }, muted: { i: true, pt: 9.5, color: "64748B" } } as const;
  const cell = (w: number, inner: string, shade?: string) => `<w:tc><w:tcPr><w:tcW w:w="${tw(w)}" w:type="dxa"/>${shade ? `<w:shd w:val="clear" w:color="auto" w:fill="${shade}"/>` : ""}</w:tcPr>${inner}</w:tc>`;
  const head = `<w:tr><w:trPr><w:cantSplit/><w:tblHeader/></w:trPr>${cell(timeW, cellP("TIME", { b: true, pt: 7.5, color: "64748B" }, 0), "F1F5F9")}${cell(contentW - timeW, cellP("WHAT HAPPENED", { b: true, pt: 7.5, color: "64748B" }, 0), "F1F5F9")}</w:tr>`;
  const rows = l.entries.map((e) => {
    const paras = entryParas(e);
    // A line's work order in bold, the rest plain.
    const para = (p: (typeof paras)[number]) => p.style === "line" || p.style === "cont"
      ? `<w:p><w:pPr><w:spacing w:before="0" w:after="20"/></w:pPr>${boldRuns(p.text).map((r) => textRun(r.t, { ...look[p.style], b: r.b })).join("")}</w:p>`
      : cellP(p.text, look[p.style]);
    return `<w:tr>${paras.length <= 6 ? "<w:trPr><w:cantSplit/></w:trPr>" : ""}${cell(timeW, cellP(e.clock, { b: true, pt: 10, color: e.kind === "break" ? "64748B" : undefined }))}${cell(contentW - timeW, paras.map(para).join(""))}</w:tr>`;
  }).join("");
  const border = (side: string, sz: number, color: string) => `<w:${side} w:val="single" w:sz="${sz}" w:space="0" w:color="${color}"/>`;
  return [
    `<w:p><w:pPr><w:spacing w:before="0" w:after="40"/></w:pPr>${textRun(kicker(o.project), { b: true, pt: 7.5, color: "64748B" })}</w:p>`,
    `<w:p><w:pPr><w:keepNext/><w:spacing w:before="0" w:after="40"/></w:pPr>${textRun(headingOf(l), { b: true, pt: 14 })}</w:p>`,
    `<w:p><w:pPr><w:keepNext/><w:spacing w:before="0" w:after="160"/></w:pPr>${textRun(subOf(l, o.exported), { pt: 9, color: "64748B" })}</w:p>`,
    `<w:tbl><w:tblPr><w:tblW w:w="${tw(contentW)}" w:type="dxa"/><w:tblBorders>${border("top", 6, "CBD5E1")}${border("bottom", 6, "CBD5E1")}${border("insideH", 4, "E2E8F0")}</w:tblBorders><w:tblLayout w:type="fixed"/><w:tblCellMar><w:top w:w="70" w:type="dxa"/><w:left w:w="90" w:type="dxa"/><w:bottom w:w="50" w:type="dxa"/><w:right w:w="90" w:type="dxa"/></w:tblCellMar><w:tblLook w:val="0000"/></w:tblPr><w:tblGrid><w:gridCol w:w="${tw(timeW)}"/><w:gridCol w:w="${tw(contentW - timeW)}"/></w:tblGrid>${head}${rows}</w:tbl>`,
  ].join("");
}

/** The log as a Word document on the letterhead. */
export async function hourlyLogDocx(logs: ShiftLog[], o: LogFileOpts): Promise<Uint8Array> {
  const lh = o.lh;
  const P = pageOf(lh), M = marginsOf(lh);
  const contentW = P.w - M.left - M.right;
  const media = new Media(await usable(picturesOf(lh), (m) => m === "image/png" || m === "image/jpeg" || m === "image/gif", o.toPng));
  const doc = new Part("document.xml");
  const parts: Array<{ part: Part; xml: string; type: "header" | "footer" }> = [];
  const add = (type: "header" | "footer", build: (c: DocxCtx) => string) => {
    const part = new Part(`${type}${parts.length + 1}.xml`);
    parts.push({ part, xml: build({ media, part }), type });
    return doc.link(`${REL}/${type}`, part.name);
  };
  const { first, rest } = layersOf(lh);
  const refs: string[] = [];
  let titlePg = false;
  if (lh) {
    titlePg = first !== rest;
    const empty = { floats: [] } as LhLayer;
    refs.push(`<w:headerReference w:type="default" r:id="${add("header", (c) => layerXml(rest ?? empty, "hdr", lh, c))}"/>`);
    if (titlePg) refs.push(`<w:headerReference w:type="first" r:id="${add("header", (c) => layerXml(first ?? empty, "hdr", lh, c))}"/>`);
  }
  if (footFree(lh)) {
    const id = add("footer", () => pageNumberFooter(o, contentW));
    refs.push(`<w:footerReference w:type="default" r:id="${id}"/>`);
    if (titlePg) refs.push(`<w:footerReference w:type="first" r:id="${id}"/>`);
  } else if (lh) {
    const empty = { floats: [] } as LhLayer;
    refs.push(`<w:footerReference w:type="default" r:id="${add("footer", (c) => layerXml(rest ?? empty, "ftr", lh, c))}"/>`);
    if (titlePg) refs.push(`<w:footerReference w:type="first" r:id="${add("footer", (c) => layerXml(first ?? empty, "ftr", lh, c))}"/>`);
  }
  const hdrAt = lh?.first?.header?.top ?? lh?.layer.header?.top ?? 0.5;
  const ftrAt = lh?.first?.footer?.bottom ?? lh?.layer.footer?.bottom ?? Math.min(0.4, M.bottom / 2);
  const sect = `<w:sectPr>${refs.join("")}<w:type w:val="nextPage"/><w:pgSz w:w="${tw(P.w)}" w:h="${tw(P.h)}"/><w:pgMar w:top="${tw(M.top)}" w:right="${tw(M.right)}" w:bottom="${tw(M.bottom)}" w:left="${tw(M.left)}" w:header="${tw(hdrAt)}" w:footer="${tw(ftrAt)}" w:gutter="0"/>${titlePg ? "<w:titlePg/>" : ""}</w:sectPr>`;
  const body = logs.length
    ? logs.map((l, i) => `${shiftXml(l, o, contentW)}<w:p>${i < logs.length - 1 ? `<w:pPr>${sect}</w:pPr>` : ""}</w:p>`).join("")
    : `<w:p>${textRun("Nothing logged yet.", { pt: 12 })}</w:p>`;
  const font = xe(bodyFont(lh));
  doc.link(`${REL}/styles`, "styles.xml");
  doc.link(`${REL}/settings`, "settings.xml");

  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/><Default Extension="gif" ContentType="image/gif"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>${parts.map((p) => `<Override PartName="/word/${p.part.name}" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.${p.type}+xml"/>`).join("")}</Types>`);
  zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`);
  zip.file("docProps/core.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xe(`${o.project} - Hourly shift log`)}</dc:title></cp:coreProperties>`);
  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${NS}><w:body>${body}${sect}</w:body></w:document>`);
  zip.file("word/styles.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ${NS}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="${font}" w:hAnsi="${font}" w:eastAsia="${font}" w:cs="${font}"/><w:color w:val="0F172A"/><w:sz w:val="20"/><w:szCs w:val="20"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style><w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:uiPriority w:val="99"/><w:semiHidden/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style></w:styles>`);
  zip.file("word/settings.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:settings ${NS}><w:defaultTabStop w:val="720"/><w:characterSpacingControl w:val="doNotCompress"/><w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>`);
  for (const p of parts) {
    zip.file(`word/${p.part.name}`, p.xml);
    if (p.part.rels.length) zip.file(`word/_rels/${p.part.name}.rels`, p.part.relsXml());
  }
  zip.file("word/_rels/document.xml.rels", doc.relsXml());
  for (const f of media.files.values()) zip.file(`word/media/${f.name}`, f.bytes);
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

// ─── Excel ───────────────────────────────────────────────────────────────

const KIND_WORD: Record<LogEntry["kind"], string> = { meeting: "Meeting", permit: "Permitting", work: "Hour", break: "Break", handover: "Turnover meeting" };

/** The log as rows: one item a row, every row with its date, shift and time. */
export function hourlyLogTable(logs: ShiftLog[]): string[][] {
  const out: string[][] = [];
  for (const l of logs) {
    const at = [l.date, l.title];
    for (const e of l.entries) {
      if (e.kind === "break") { out.push([...at, e.clock, "Break", e.title ?? "Break"]); continue; }
      const k = KIND_WORD[e.kind];
      for (const x of e.lines) out.push([...at, e.clock, k, noEmDash(plainLine(x))]);
      for (const x of e.continuing) out.push([...at, e.clock, "Progress", noEmDash(plainLine(x))]);
      if (!e.lines.length && !e.continuing.length) out.push([...at, e.clock, k, e.kind === "meeting" ? "No attendance entered" : "Nothing logged"]);
    }
  }
  return out;
}

/** The log as an Excel workbook. */
export async function hourlyLogXlsx(logs: ShiftLog[], o: Pick<LogFileOpts, "project" | "exported">): Promise<Uint8Array> {
  const XLSX = await import("xlsx");
  const head = ["Date", "Shift", "Time", "Type", "What happened"];
  const rows = hourlyLogTable(logs);
  const aoa = [[`${o.project} - Hourly shift log`], [`${o.exported}. Times are plant time.`], [], head, ...rows];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!cols"] = [18, 12, 10, 12, 100].map((wch) => ({ wch }));
  if (rows.length) ws["!autofilter"] = { ref: `A4:E${aoa.length}` };
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Hourly log");
  return new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer);
}

// ─── In the browser ──────────────────────────────────────────────────────

export const FILE_TYPES = {
  pdf: { ext: "pdf", mime: "application/pdf" },
  docx: { ext: "docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
  xlsx: { ext: "xlsx", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
} as const;
export type LogFormat = keyof typeof FILE_TYPES;

/** A picture the browser can read, redrawn as PNG. */
export async function pngInBrowser(src: string): Promise<string | null> {
  try {
    const img = new Image();
    img.src = src;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    c.getContext("2d")?.drawImage(img, 0, 0);
    return c.toDataURL("image/png");
  } catch { return null; }
}

/** Make the file and save it. */
export async function saveHourlyLog(logs: ShiftLog[], format: LogFormat, o: LogFileOpts & { fileName: string }): Promise<void> {
  const bytes = format === "pdf" ? await hourlyLogPdf(logs, o) : format === "docx" ? await hourlyLogDocx(logs, o) : await hourlyLogXlsx(logs, o);
  const t = FILE_TYPES[format];
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: t.mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `${o.fileName.replace(/[\\/:*?"<>|]/g, "").trim() || "Hourly log"}.${t.ext}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
