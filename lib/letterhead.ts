// letterhead — a company's letterhead, for printed reports to sit on.
//
// Uploaded once in Schedule setup → Printed reports, as a Word file, a PDF
// or a picture of the page:
//   Word   its own header and footer (logo, address, coloured bars, text
//          boxes) laid out as Word lays them out, and its margins — where
//          the report goes. The first page's header, if it has its own,
//          on page 1; the rest on every page after.
//   PDF /  a picture of the page, behind the report on every page; the
//   image  report goes in the blank part of it (found from the picture,
//          adjustable).
// Kept as data (never as markup): drawn by letterheadHtml with every piece
// of text escaped and every picture checked to be an image.

import { noEmDash } from "@/lib/noEmDash";
import JSZip from "jszip";

/** A picture: a data: URL, and its size on the page in inches. */
export interface LhImg { src: string; w: number; h: number }
export interface LhRun {
  t?: string;
  tab?: boolean;
  br?: boolean;
  font?: string;
  /** Font size, points. */
  pt?: number;
  b?: boolean;
  i?: boolean;
  u?: boolean;
  /** "1F3864" */
  color?: string;
  img?: LhImg;
}
export interface LhPara {
  align?: "left" | "center" | "right" | "justify";
  runs: LhRun[];
  /** Space before / after, points. */
  before?: number;
  after?: number;
  /** Line spacing, as a multiple. */
  line?: number;
}
export interface LhTable { rows: Array<{ cells: Array<{ w?: number; items: LhItem[] }> }> }
export type LhItem = { p: LhPara } | { table: LhTable };
/** Something placed on the page itself: a picture, a box of colour (a
 *  bar or a rule), or a text box — inches from the page's top-left. */
export interface LhFloat { x: number; y: number; w: number; h: number; src?: string; fill?: string; items?: LhItem[] }
/** A header (`top`: inches from the top of the page) or footer
 *  (`bottom`: inches from the bottom), `w` wide from `x`. */
export interface LhBand { x: number; w: number; top?: number; bottom?: number; items: LhItem[]; floats: LhFloat[] }
/** What's drawn on a page. */
export interface LhLayer { image?: string; header?: LhBand; footer?: LhBand; floats?: LhFloat[] }

export interface Letterhead {
  v: 1;
  /** The file it came from. */
  name: string;
  kind: "docx" | "pdf" | "image";
  /** Paper, inches (8.5 × 11 letter; 8.27 × 11.69 A4). */
  page: { w: number; h: number };
  /** Where the report goes: inches in from each edge. */
  margins: { top: number; right: number; bottom: number; left: number };
  /** Every page after the first (and the first, unless `first` is set). */
  layer: LhLayer;
  /** Page 1's own letterhead (Word's "different first page"). */
  first?: LhLayer;
  /** On every page, or the first only. */
  pages?: "all" | "first";
  savedAt?: string;
}

export const LETTER = { w: 8.5, h: 11 };
export const A4 = { w: 8.27, h: 11.69 };

// ─── A small XML reader (Word's parts are plain, well-formed XML) ────────

export interface XNode { name: string; attrs: Record<string, string>; kids: XNode[]; text: string }

const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'" };
const decode = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) =>
  e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENT[e] ?? m);

export function parseXml(xml: string): XNode {
  const root: XNode = { name: "#root", attrs: {}, kids: [], text: "" };
  const stack: XNode[] = [root];
  const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  for (let m = re.exec(xml); m; m = re.exec(xml)) {
    const top = stack[stack.length - 1];
    if (m[1] != null) { top.text += m[1]; continue; }
    if (m[6] != null) { top.text += decode(m[6]); continue; }
    if (!m[3]) continue; // comment / declaration
    if (m[2] === "/") { if (stack.length > 1) stack.pop(); continue; }
    const attrs: Record<string, string> = {};
    for (const a of m[4].matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1]] = decode(a[2] ?? a[3] ?? "");
    const node: XNode = { name: m[3], attrs, kids: [], text: "" };
    top.kids.push(node);
    if (m[5] !== "/") stack.push(node);
  }
  return root;
}

const kid = (n: XNode | undefined, name: string) => n?.kids.find((k) => k.name === name);
const kids = (n: XNode | undefined, name: string) => n?.kids.filter((k) => k.name === name) ?? [];
/** The first descendant with this name. */
function find(n: XNode | undefined, name: string): XNode | undefined {
  if (!n) return undefined;
  for (const k of n.kids) { if (k.name === name) return k; const d = find(k, name); if (d) return d; }
  return undefined;
}
const val = (n: XNode | undefined, attr = "w:val") => n?.attrs[attr];
const num = (s: string | undefined) => (s != null && s.trim() !== "" && Number.isFinite(Number(s)) ? Number(s) : undefined);

const TWIP = 1440;     // per inch
const EMU = 914400;    // per inch

// ─── Word → letterhead ───────────────────────────────────────────────────

interface Ctx {
  page: { w: number; h: number };
  mar: { top: number; right: number; bottom: number; left: number; header: number; footer: number };
  /** Relationship id → a data: URL, per part. */
  media: Map<string, string>;
  /** Character style defaults (font, size) by style id; doc defaults under "". */
  styles: Map<string, { font?: string; pt?: number; align?: LhPara["align"]; before?: number; after?: number; line?: number }>;
  theme: { minor?: string; major?: string };
  /** Pictures and shapes placed on the page, collected as the part is read. */
  sink: LhFloat[];
}

const fontOf = (rFonts: XNode | undefined, c: Ctx) => {
  const f = val(rFonts, "w:ascii") ?? val(rFonts, "w:hAnsi");
  if (f) return f;
  const th = val(rFonts, "w:asciiTheme") ?? val(rFonts, "w:hAnsiTheme");
  return th ? (/major/i.test(th) ? c.theme.major : c.theme.minor) : undefined;
};

function runProps(rPr: XNode | undefined, c: Ctx, base: { font?: string; pt?: number }): Omit<LhRun, "t" | "tab" | "br" | "img"> {
  const style = c.styles.get(val(kid(rPr, "w:rStyle")) ?? "\u0000");
  const sz = num(val(kid(rPr, "w:sz")));
  const on = (name: string) => { const n = kid(rPr, name); return n ? val(n) !== "0" && val(n) !== "false" : undefined; };
  const color = val(kid(rPr, "w:color"));
  return {
    font: fontOf(kid(rPr, "w:rFonts"), c) ?? style?.font ?? base.font,
    pt: sz != null ? sz / 2 : style?.pt ?? base.pt,
    ...(on("w:b") ? { b: true } : {}),
    ...(on("w:i") ? { i: true } : {}),
    ...(kid(rPr, "w:u") && val(kid(rPr, "w:u")) !== "none" ? { u: true } : {}),
    ...(color && /^[0-9a-f]{6}$/i.test(color) ? { color: color.toUpperCase() } : {}),
  };
}

/** A drawing's extent, inches. */
const extentOf = (n: XNode | undefined) => {
  const e = kid(n, "wp:extent");
  return { w: (num(val(e, "cx")) ?? 0) / EMU, h: (num(val(e, "cy")) ?? 0) / EMU };
};

/** Where an anchored drawing sits on the page. `paraY`: the top of the
 *  paragraph it's anchored to, inches from the page top. */
function anchorPos(a: XNode, size: { w: number; h: number }, c: Ctx, paraY: number): { x: number; y: number } {
  const ph = kid(a, "wp:positionH"), pv = kid(a, "wp:positionV");
  const contentW = c.page.w - c.mar.left - c.mar.right;
  const areaH = (rel: string | undefined): [number, number] => {
    switch (rel) {
      case "page": return [0, c.page.w];
      case "leftMargin": case "insideMargin": return [0, c.mar.left];
      case "rightMargin": case "outsideMargin": return [c.page.w - c.mar.right, c.mar.right];
      default: return [c.mar.left, contentW]; // margin, column, character
    }
  };
  const areaV = (rel: string | undefined): [number, number] => {
    switch (rel) {
      case "page": return [0, c.page.h];
      case "topMargin": return [0, c.mar.top];
      case "bottomMargin": return [c.page.h - c.mar.bottom, c.mar.bottom];
      case "margin": return [c.mar.top, c.page.h - c.mar.top - c.mar.bottom];
      default: return [paraY, 0]; // paragraph, line
    }
  };
  const place = (n: XNode | undefined, [a0, len]: [number, number], size0: number) => {
    const off = num(kid(n, "wp:posOffset")?.text);
    if (off != null) return a0 + off / EMU;
    const al = kid(n, "wp:align")?.text?.trim();
    if (al === "center") return a0 + (len - size0) / 2;
    if (al === "right" || al === "bottom" || al === "outside") return a0 + len - size0;
    return a0;
  };
  return { x: place(ph, areaH(val(ph, "relativeFrom")), size.w), y: place(pv, areaV(val(pv, "relativeFrom")), size.h) };
}

/** A shape's fill: "1F3864", from <a:solidFill><a:srgbClr val=…>. */
const fillOf = (spPr: XNode | undefined) => {
  const v = val(find(kid(spPr, "a:solidFill"), "a:srgbClr"), "val");
  return v && /^[0-9a-f]{6}$/i.test(v) ? v.toUpperCase() : undefined;
};

/** One drawing (inline or anchored): its picture, or a coloured shape or
 *  text box. */
function drawingOf(d: XNode, c: Ctx, paraY: number): { inline?: LhImg; float?: LhFloat } | null {
  const anchor = kid(d, "wp:anchor");
  const inline = kid(d, "wp:inline");
  const host = anchor ?? inline;
  if (!host) return null;
  const size = extentOf(host);
  if (!(size.w > 0 && size.h > 0)) return null;
  const blip = find(host, "a:blip");
  const src = blip ? c.media.get(val(blip, "r:embed") ?? "") : undefined;
  if (inline) return src ? { inline: { src, ...size } } : null;
  const pos = anchorPos(anchor!, size, c, paraY);
  if (src) return { float: { ...pos, ...size, src } };
  // A shape: a bar, a rule, or a text box.
  const wsp = find(anchor, "wps:wsp");
  if (!wsp) return null;
  const spPr = kid(wsp, "wps:spPr");
  const geom = val(kid(spPr, "a:prstGeom"), "prst");
  const box = find(wsp, "w:txbxContent");
  const items = box ? blockItems(box, c, { font: undefined, pt: undefined }) : undefined;
  let fill = fillOf(spPr);
  let h = size.h;
  if (geom === "line" || !fill) {
    // A rule: its line colour and weight.
    const ln = kid(spPr, "a:ln");
    const lc = fillOf(ln);
    if (lc && (geom === "line" || !items?.length)) { fill = lc; h = Math.max(h, (num(val(ln, "w")) ?? 12700) / EMU); }
  }
  if (!fill && !items?.length) return null;
  return { float: { ...pos, w: size.w, h, ...(fill ? { fill } : {}), ...(items?.length ? { items } : {}) } };
}

/** Old-style (VML) pictures: <w:pict><v:shape style="…"><v:imagedata r:id=…>. */
function pictOf(p: XNode, c: Ctx, paraY: number): LhFloat | LhImg | null {
  const shape = find(p, "v:shape") ?? find(p, "v:rect");
  const imgd = find(p, "v:imagedata");
  const src = imgd ? c.media.get(val(imgd, "r:id") ?? "") : undefined;
  if (!shape || !src) return null;
  const st = Object.fromEntries((shape.attrs.style ?? "").split(";").map((kv) => kv.split(":").map((x) => x.trim())).filter((x) => x.length === 2)) as Record<string, string>;
  const inch = (v?: string) => { if (!v) return 0; const n = parseFloat(v); return /pt$/.test(v) ? n / 72 : /in$/.test(v) ? n : /cm$/.test(v) ? n / 2.54 : /mm$/.test(v) ? n / 25.4 : /px$/.test(v) ? n / 96 : n / 72; };
  const w = inch(st.width), h = inch(st.height);
  if (!(w > 0 && h > 0)) return null;
  if (st.position !== "absolute") return { src, w, h };
  const relH = st["mso-position-horizontal-relative"], relV = st["mso-position-vertical-relative"];
  const x = (relH === "page" ? 0 : c.mar.left) + inch(st["margin-left"] ?? st.left);
  const y = (relV === "page" ? 0 : relV === "margin" ? c.mar.top : paraY) + inch(st["margin-top"] ?? st.top);
  return { x, y, w, h, src };
}

/** A paragraph's own settings: alignment and spacing (its style's, then its own). */
function paraProps(pPr: XNode | undefined, c: Ctx): Pick<LhPara, "align" | "before" | "after" | "line"> & { font?: string; pt?: number } {
  const style = c.styles.get(val(kid(pPr, "w:pStyle")) ?? "") ?? c.styles.get("");
  const jc = val(kid(pPr, "w:jc"));
  const sp = kid(pPr, "w:spacing");
  const align = jc === "center" ? "center" : jc === "right" || jc === "end" ? "right" : jc === "both" || jc === "distribute" ? "justify" : jc ? "left" : style?.align;
  const twPt = (s?: string) => (num(s) != null ? num(s)! / 20 : undefined);
  const auto = (a: string) => val(sp, a) === "1" || val(sp, a) === "true";
  const before = sp ? (auto("w:beforeAutospacing") ? 5 : twPt(val(sp, "w:before"))) : undefined;
  const after = sp ? (auto("w:afterAutospacing") ? 5 : twPt(val(sp, "w:after"))) : undefined;
  const lineRule = val(sp, "w:lineRule");
  const lineV = num(val(sp, "w:line"));
  const line = lineV != null && (!lineRule || lineRule === "auto") ? lineV / 240 : undefined;
  const rPr = kid(pPr, "w:rPr");
  return {
    align,
    before: before ?? style?.before, after: after ?? style?.after, line: line ?? style?.line,
    font: fontOf(kid(rPr, "w:rFonts"), c) ?? style?.font, pt: num(val(kid(rPr, "w:sz"))) != null ? num(val(kid(rPr, "w:sz")))! / 2 : style?.pt,
  };
}

/** A part's paragraphs and tables, in order. `y`: running estimate of the
 *  page height they've reached (for paragraph-anchored drawings). */
function blockItems(n: XNode, c: Ctx, base: { font?: string; pt?: number }, at?: { y: number }): LhItem[] {
  const out: LhItem[] = [];
  for (const k of n.kids) {
    if (k.name === "w:p") {
      const pp = paraProps(kid(k, "w:pPr"), c);
      const font = pp.font ?? base.font, pt = pp.pt ?? base.pt;
      const runs: LhRun[] = [];
      const y0 = at?.y ?? 0;
      const walk = (parent: XNode) => {
        for (const r of parent.kids) {
          if (r.name === "w:hyperlink" || r.name === "w:smartTag" || r.name === "w:sdt" || r.name === "w:sdtContent" || r.name === "w:ins") { walk(r); continue; }
          if (r.name === "mc:AlternateContent") { const ch = kid(r, "mc:Choice"); if (ch) walk(ch); continue; }
          if (r.name !== "w:r") continue;
          const props = runProps(kid(r, "w:rPr"), c, { font, pt });
          for (const x of r.kids) {
            if (x.name === "w:t") runs.push({ ...props, t: x.text });
            else if (x.name === "w:tab") runs.push({ tab: true });
            else if (x.name === "w:br" || x.name === "w:cr") runs.push({ br: true });
            else if (x.name === "w:drawing") {
              const d = drawingOf(x, c, y0);
              if (d?.inline) runs.push({ img: d.inline });
              if (d?.float) c.sink.push(d.float);
            } else if (x.name === "w:pict") {
              const p = pictOf(x, c, y0);
              if (p && "x" in p) c.sink.push(p); else if (p) runs.push({ img: p });
            } else if (x.name === "mc:AlternateContent") {
              const ch = kid(x, "mc:Choice");
              const d = ch && kid(ch, "w:drawing") ? drawingOf(kid(ch, "w:drawing")!, c, y0) : null;
              if (d?.inline) runs.push({ img: d.inline });
              if (d?.float) c.sink.push(d.float);
            }
          }
        }
      };
      walk(k);
      const para: LhPara = { runs, ...(pp.align && pp.align !== "left" ? { align: pp.align } : {}),
        ...(pp.before ? { before: pp.before } : {}), ...(pp.after ? { after: pp.after } : {}), ...(pp.line && pp.line !== 1 ? { line: pp.line } : {}) };
      // An empty paragraph still takes a line: keep its size.
      if (!runs.length) para.runs.push({ t: "", pt: pt ?? 11, font });
      out.push({ p: para });
      if (at) at.y += paraHeight(para);
    } else if (k.name === "w:tbl") {
      const rows = kids(k, "w:tr").map((tr) => ({
        cells: kids(tr, "w:tc").map((tc) => {
          const w = num(val(kid(kid(tc, "w:tcPr"), "w:tcW"), "w:w"));
          const type = val(kid(kid(tc, "w:tcPr"), "w:tcW"), "w:type");
          return { ...(w && (!type || type === "dxa") ? { w: w / TWIP } : {}), items: blockItems(tc, c, base) };
        }),
      }));
      out.push({ table: { rows } });
      if (at) at.y += rows.reduce((a, r) => a + Math.max(0, ...r.cells.map((cell) => cell.items.reduce((s, it) => s + itemHeight(it), 0))), 0);
    } else if (k.name === "w:sdt") {
      out.push(...blockItems(kid(k, "w:sdtContent") ?? k, c, base, at));
    }
  }
  return out;
}

/** A paragraph's height on the page, inches (an estimate: its biggest
 *  font, line spacing, and space around it). */
export function paraHeight(p: LhPara): number {
  const pt = Math.max(0, ...p.runs.map((r) => (r.img ? r.img.h * 72 : r.pt ?? 11)));
  const lines = 1 + p.runs.filter((r) => r.br).length;
  return (pt * 1.17 * (p.line ?? 1) * lines + (p.before ?? 0) + (p.after ?? 0)) / 72;
}
const itemHeight = (it: LhItem): number => ("p" in it ? paraHeight(it.p)
  : it.table.rows.reduce((a, r) => a + Math.max(0, ...r.cells.map((c) => c.items.reduce((s, x) => s + itemHeight(x), 0))), 0));
export const bandHeight = (items: LhItem[]) => items.reduce((a, it) => a + itemHeight(it), 0);

/** A Word file (.docx) as a letterhead. Pictures come out as data: URLs. */
export async function letterheadFromDocx(data: ArrayBuffer | Uint8Array, name: string): Promise<Letterhead> {
  const zip = await JSZip.loadAsync(data);
  const text = async (p: string) => (await zip.file(p)?.async("string")) ?? null;
  const docXml = await text("word/document.xml");
  if (!docXml) throw new Error("That isn't a Word file (.docx) - no document inside.");
  const doc = parseXml(docXml);
  const body = find(doc, "w:body");
  // The last section's settings: page size, margins, which header goes where.
  const sect = body ? [...body.kids].reverse().find((k) => k.name === "w:sectPr") ?? find(body, "w:sectPr") : undefined;
  const pgSz = kid(sect, "w:pgSz"), pgMar = kid(sect, "w:pgMar");
  const page = { w: (num(val(pgSz, "w:w")) ?? 12240) / TWIP, h: (num(val(pgSz, "w:h")) ?? 15840) / TWIP };
  const tw = (a: string, d: number) => Math.abs(num(val(pgMar, a)) ?? d) / TWIP;
  const mar = { top: tw("w:top", 1440), right: tw("w:right", 1440), bottom: tw("w:bottom", 1440), left: tw("w:left", 1440), header: tw("w:header", 720), footer: tw("w:footer", 720) };

  // Theme fonts and styles: a run with no font of its own takes these.
  const themeXml = await text("word/theme/theme1.xml");
  const theme: Ctx["theme"] = {};
  if (themeXml) {
    const th = parseXml(themeXml);
    theme.major = val(kid(find(th, "a:majorFont"), "a:latin"), "typeface");
    theme.minor = val(kid(find(th, "a:minorFont"), "a:latin"), "typeface");
  }
  const styles: Ctx["styles"] = new Map();
  const stylesXml = await text("word/styles.xml");
  const base: Ctx = { page, mar, media: new Map(), styles, theme, sink: [] };
  if (stylesXml) {
    const st = parseXml(stylesXml);
    const dRpr = kid(kid(find(st, "w:docDefaults"), "w:rPrDefault"), "w:rPr");
    const dSz = num(val(kid(dRpr, "w:sz")));
    styles.set("", { font: fontOf(kid(dRpr, "w:rFonts"), base), pt: dSz != null ? dSz / 2 : 11 });
    const all = new Map(kids(find(st, "w:styles"), "w:style").map((s) => [s.attrs["w:styleId"], s]));
    const resolve = (id: string, depth = 0): { font?: string; pt?: number; align?: LhPara["align"]; before?: number; after?: number; line?: number } => {
      const s = all.get(id);
      if (!s || depth > 8) return styles.get("") ?? {};
      const parent = val(kid(s, "w:basedOn"));
      const up = parent ? resolve(parent, depth + 1) : styles.get("") ?? {};
      const rPr = kid(s, "w:rPr");
      const sz = num(val(kid(rPr, "w:sz")));
      const pp = paraProps(kid(s, "w:pPr"), { ...base, styles: new Map() });
      return { font: fontOf(kid(rPr, "w:rFonts"), base) ?? up.font, pt: sz != null ? sz / 2 : up.pt,
        align: pp.align ?? up.align, before: pp.before ?? up.before, after: pp.after ?? up.after, line: pp.line ?? up.line };
    };
    for (const id of all.keys()) if (id) styles.set(id, resolve(id));
  }

  const rels = async (part: string) => {
    const dir = part.replace(/[^/]+$/, ""), file = part.replace(/^.*\//, "");
    const xml = await text(`${dir}_rels/${file}.rels`);
    return xml ? kids(find(parseXml(xml), "Relationships"), "Relationship") : [];
  };
  const docRels = await rels("word/document.xml");
  const target = (id: string | undefined) => docRels.find((r) => r.attrs.Id === id)?.attrs.Target;
  const mediaOf = async (part: string) => {
    const m = new Map<string, string>();
    for (const r of await rels(part)) {
      if (!/\/image$/.test(r.attrs.Type ?? "") || r.attrs.TargetMode === "External") continue;
      const p = ("word/" + r.attrs.Target).replace(/\/[^/]+\/\.\.\//g, "/");
      const f = zip.file(p);
      const ext = (p.split(".").pop() ?? "").toLowerCase();
      const mime = ext === "png" ? "image/png" : ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "gif" ? "image/gif" : ext === "webp" ? "image/webp" : null;
      if (f && mime) m.set(r.attrs.Id, `data:${mime};base64,${await f.async("base64")}`);
    }
    return m;
  };
  const refs = (tag: string) => Object.fromEntries(kids(sect, tag).map((r) => [val(r, "w:type") ?? "default", target(val(r, "r:id"))]));
  const heads = refs("w:headerReference"), feet = refs("w:footerReference");
  const titlePg = !!kid(sect, "w:titlePg") && val(kid(sect, "w:titlePg")) !== "0";
  const contentW = page.w - mar.left - mar.right;

  const band = async (file: string | undefined, kind: "header" | "footer"): Promise<{ band?: LhBand; floats: LhFloat[] }> => {
    if (!file) return { floats: [] };
    const part = `word/${file}`;
    const xml = await text(part);
    if (!xml) return { floats: [] };
    const root = find(parseXml(xml), kind === "header" ? "w:hdr" : "w:ftr");
    if (!root) return { floats: [] };
    const media = await mediaOf(part);
    // Header text runs down from its distance; a footer's ends at its distance.
    const hgt = bandHeight(blockItems(root, { ...base, media, sink: [] }, styles.get("") ?? {}));
    const c: Ctx = { ...base, media, sink: [] };
    const at = { y: kind === "header" ? mar.header : page.h - mar.footer - hgt };
    const items = blockItems(root, c, styles.get("") ?? {}, at);
    const floats = c.sink;
    const hasText = items.some((it) => "table" in it || it.p.runs.some((r) => (r.t && r.t.trim()) || r.img));
    return { band: hasText ? { x: mar.left, w: contentW, ...(kind === "header" ? { top: mar.header } : { bottom: mar.footer }), items, floats: [] } : undefined, floats };
  };
  const layerOf = async (h: string | undefined, f: string | undefined): Promise<LhLayer> => {
    const hb = await band(h, "header"), fb = await band(f, "footer");
    return { ...(hb.band ? { header: hb.band } : {}), ...(fb.band ? { footer: fb.band } : {}), floats: [...hb.floats, ...fb.floats] };
  };
  const layer = await layerOf(heads.default, feet.default);
  const first = titlePg && (heads.first || feet.first) ? await layerOf(heads.first, feet.first) : undefined;

  // Where the report starts and ends: Word's margins, pushed past anything
  // the letterhead puts in the way.
  const clear = (l: LhLayer | undefined) => {
    if (!l) return { top: 0, bottom: 0 };
    const hTop = l.header ? (l.header.top ?? 0) + bandHeight(l.header.items) : 0;
    const fBot = l.footer ? (l.footer.bottom ?? 0) + bandHeight(l.footer.items) : 0;
    const fl = l.floats ?? [];
    const top = Math.max(hTop, ...fl.filter((x) => x.y + x.h <= page.h * 0.4).map((x) => x.y + x.h));
    const bottom = Math.max(fBot, ...fl.filter((x) => x.y >= page.h * 0.6).map((x) => page.h - x.y));
    return { top, bottom };
  };
  const a = clear(layer), b = clear(first);
  const round = (x: number) => Math.round(x * 100) / 100;
  return {
    v: 1, name, kind: "docx", page: { w: round(page.w), h: round(page.h) },
    margins: {
      top: round(Math.max(mar.top, Math.max(a.top, b.top) + 0.15)),
      bottom: round(Math.max(mar.bottom, Math.max(a.bottom, b.bottom) + 0.15)),
      left: round(mar.left), right: round(mar.right),
    },
    layer, ...(first ? { first } : {}), pages: "all",
  };
}

// ─── A picture of the page (PDF, image) → where the report goes ─────────

/** The blank part of a letterhead page, from a picture of it (RGBA): below
 *  the header, above the footer, inside anything down the sides. Faint
 *  marks (a watermark) don't count. Inches. */
export function blankArea(px: Uint8ClampedArray, W: number, H: number, page: { w: number; h: number }): Letterhead["margins"] {
  const inkAt = (x: number, y: number) => {
    const i = (y * W + x) * 4;
    const a = px[i + 3] / 255;
    const g = (px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114) * a + 255 * (1 - a);
    return g < 200;
  };
  const rowInk = new Uint32Array(H);
  for (let y = 0; y < H; y++) { let n = 0; for (let x = 0; x < W; x++) if (inkAt(x, y)) n++; rowInk[y] = n; }
  const minInk = Math.max(1, Math.round(W * 0.002));
  let headEnd = 0;
  for (let y = 0; y < Math.round(H * 0.4); y++) if (rowInk[y] >= minInk) headEnd = y + 1;
  let footStart = H;
  for (let y = H - 1; y >= Math.round(H * 0.65); y--) if (rowInk[y] >= minInk) footStart = y;
  // Down the sides, between header and footer.
  const colInk = new Uint32Array(W);
  for (let y = headEnd; y < footStart; y++) for (let x = 0; x < W; x++) if (inkAt(x, y)) colInk[x]++;
  const minCol = Math.max(2, Math.round((footStart - headEnd) * 0.05));
  let leftEnd = 0;
  for (let x = 0; x < Math.round(W * 0.3); x++) if (colInk[x] >= minCol) leftEnd = x + 1;
  let rightStart = W;
  for (let x = W - 1; x >= Math.round(W * 0.7); x--) if (colInk[x] >= minCol) rightStart = x;
  const inX = page.w / W, inY = page.h / H;
  const gap = 0.2, min = 0.5;
  const r2 = (x: number) => Math.round(x * 100) / 100;
  return {
    top: r2(Math.max(min, headEnd ? headEnd * inY + gap : 0.75)),
    bottom: r2(Math.max(min, footStart < H ? (H - footStart) * inY + gap : 0.75)),
    left: r2(Math.max(0.6, leftEnd ? leftEnd * inX + gap : 0.75)),
    right: r2(Math.max(0.6, rightStart < W ? (W - rightStart) * inX + gap : 0.75)),
  };
}

/** Paper for a picture of a page: letter or A4 by its shape, else letter
 *  width and the picture's own shape. */
export function paperFor(wPx: number, hPx: number): { w: number; h: number } {
  const r = hPx / wPx;
  if (Math.abs(r - LETTER.h / LETTER.w) < 0.03) return LETTER;
  if (Math.abs(r - A4.h / A4.w) < 0.03) return A4;
  return { w: LETTER.w, h: Math.round(LETTER.w * r * 100) / 100 };
}

// ─── Checked on the way in (what's saved is shared: never trust it) ──────

const IMG_RE = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/;
const FONT_RE = /^[A-Za-z0-9 ._-]{1,60}$/;
const HEX_RE = /^[0-9A-F]{6}$/;
const fin = (x: unknown, lo: number, hi: number): number | undefined => (typeof x === "number" && Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : undefined);

function cleanImg(x: unknown): LhImg | undefined {
  const o = x as LhImg;
  if (!o || typeof o.src !== "string" || o.src.length > 3_000_000 || !IMG_RE.test(o.src)) return undefined;
  const w = fin(o.w, 0.01, 20), h = fin(o.h, 0.01, 20);
  return w && h ? { src: o.src, w, h } : undefined;
}
function cleanRun(x: unknown): LhRun | null {
  const r = x as LhRun;
  if (!r || typeof r !== "object") return null;
  const out: LhRun = {};
  if (typeof r.t === "string") out.t = r.t.slice(0, 500);
  if (r.tab) out.tab = true;
  if (r.br) out.br = true;
  if (typeof r.font === "string" && FONT_RE.test(r.font)) out.font = r.font;
  const pt = fin(r.pt, 4, 96); if (pt) out.pt = pt;
  if (r.b) out.b = true; if (r.i) out.i = true; if (r.u) out.u = true;
  if (typeof r.color === "string" && HEX_RE.test(r.color)) out.color = r.color;
  const img = r.img ? cleanImg(r.img) : undefined; if (img) out.img = img;
  return out;
}
function cleanItems(x: unknown, depth = 0): LhItem[] {
  if (!Array.isArray(x) || depth > 3) return [];
  return x.slice(0, 120).map((it): LhItem | null => {
    if (it && typeof it === "object" && "p" in it) {
      const p = (it as { p: LhPara }).p;
      const align = p?.align && ["left", "center", "right", "justify"].includes(p.align) ? p.align : undefined;
      return { p: { runs: (Array.isArray(p?.runs) ? p.runs.slice(0, 200) : []).map(cleanRun).filter((r): r is LhRun => !!r),
        ...(align ? { align } : {}), ...(fin(p.before, 0, 200) ? { before: fin(p.before, 0, 200) } : {}),
        ...(fin(p.after, 0, 200) ? { after: fin(p.after, 0, 200) } : {}), ...(fin(p.line, 0.5, 4) ? { line: fin(p.line, 0.5, 4) } : {}) } };
    }
    if (it && typeof it === "object" && "table" in it) {
      const t = (it as { table: LhTable }).table;
      return { table: { rows: (Array.isArray(t?.rows) ? t.rows.slice(0, 30) : []).map((r) => ({
        cells: (Array.isArray(r?.cells) ? r.cells.slice(0, 12) : []).map((c) => ({ ...(fin(c?.w, 0.05, 20) ? { w: fin(c.w, 0.05, 20) } : {}), items: cleanItems(c?.items, depth + 1) })),
      })) } };
    }
    return null;
  }).filter((it): it is LhItem => !!it);
}
function cleanFloat(x: unknown): LhFloat | null {
  const f = x as LhFloat;
  if (!f || typeof f !== "object") return null;
  const xx = fin(f.x, -5, 25), y = fin(f.y, -5, 30), w = fin(f.w, 0.01, 25), h = fin(f.h, 0.005, 30);
  if (xx == null || y == null || !w || !h) return null;
  const src = f.src ? cleanImg({ src: f.src, w, h })?.src : undefined;
  const fill = typeof f.fill === "string" && HEX_RE.test(f.fill) ? f.fill : undefined;
  const items = f.items ? cleanItems(f.items) : undefined;
  if (!src && !fill && !items?.length) return null;
  return { x: xx, y, w, h, ...(src ? { src } : {}), ...(fill ? { fill } : {}), ...(items?.length ? { items } : {}) };
}
function cleanBand(x: unknown, kind: "top" | "bottom"): LhBand | undefined {
  const b = x as LhBand;
  if (!b || typeof b !== "object") return undefined;
  const xx = fin(b.x, 0, 20), w = fin(b.w, 0.1, 25), at = fin(b[kind], 0, 20);
  if (xx == null || !w || at == null) return undefined;
  return { x: xx, w, [kind]: at, items: cleanItems(b.items), floats: [] };
}
function cleanLayer(x: unknown): LhLayer | undefined {
  const l = x as LhLayer;
  if (!l || typeof l !== "object") return undefined;
  const image = typeof l.image === "string" && l.image.length < 6_000_000 && IMG_RE.test(l.image) ? l.image : undefined;
  const floats = (Array.isArray(l.floats) ? l.floats.slice(0, 60) : []).map(cleanFloat).filter((f): f is LhFloat => !!f);
  return { ...(image ? { image } : {}), ...(cleanBand(l.header, "top") ? { header: cleanBand(l.header, "top") } : {}),
    ...(cleanBand(l.footer, "bottom") ? { footer: cleanBand(l.footer, "bottom") } : {}), ...(floats.length ? { floats } : {}) };
}

/** A saved letterhead, checked: numbers in range, pictures only pictures,
 *  fonts and colours plain. Null when it isn't one. */
export function cleanLetterhead(x: unknown): Letterhead | null {
  const l = x as Letterhead;
  if (!l || typeof l !== "object" || l.v !== 1 || !["docx", "pdf", "image"].includes(l.kind)) return null;
  // Paper of a real size, or it isn't a letterhead.
  const inRange = (x: unknown, lo: number, hi: number) => typeof x === "number" && Number.isFinite(x) && x >= lo && x <= hi;
  if (!inRange(l.page?.w, 3, 20) || !inRange(l.page?.h, 3, 30)) return null;
  const pw = l.page.w, ph = l.page.h;
  const m = l.margins ?? ({} as Letterhead["margins"]);
  const mg = (v: unknown, max: number) => fin(v, 0, max) ?? 0.75;
  const layer = cleanLayer(l.layer);
  if (!layer) return null;
  const first = l.first ? cleanLayer(l.first) : undefined;
  return {
    v: 1, name: typeof l.name === "string" ? l.name.slice(0, 160) : "Letterhead", kind: l.kind,
    page: { w: pw, h: ph },
    margins: { top: mg(m.top, ph / 2), bottom: mg(m.bottom, ph / 2), left: mg(m.left, pw / 3), right: mg(m.right, pw / 3) },
    layer, ...(first ? { first } : {}), pages: l.pages === "first" ? "first" : "all",
    ...(typeof l.savedAt === "string" && l.savedAt.length < 40 ? { savedAt: l.savedAt } : {}),
  };
}

// ─── Drawing it ──────────────────────────────────────────────────────────

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const fontStack = (f?: string) => (f ? `'${f.replace(/'/g, "")}', ` : "") + "Calibri, Carlito, Arial, sans-serif";

function runHtml(r: LhRun): string {
  if (r.br) return "<br>";
  if (r.tab) return "<span style=\"display:inline-block;width:0.5in\"></span>";
  if (r.img) return `<img src="${r.img.src}" alt="" style="width:${r.img.w}in;height:${r.img.h}in;vertical-align:bottom">`;
  if (!r.t) return r.pt ? `<span style="font-size:${r.pt}pt">&#8203;</span>` : "";
  const st = [r.font ? `font-family:${fontStack(r.font)}` : "", r.pt ? `font-size:${r.pt}pt` : "", r.b ? "font-weight:700" : "",
    r.i ? "font-style:italic" : "", r.u ? "text-decoration:underline" : "", r.color ? `color:#${r.color}` : ""].filter(Boolean).join(";");
  return `<span style="${st}">${esc(r.t).replace(/ {2,}/g, (s) => " " + "&nbsp;".repeat(s.length - 1))}</span>`;
}
function itemsHtml(items: LhItem[]): string {
  return items.map((it) => {
    if ("p" in it) {
      const p = it.p;
      const st = [`text-align:${p.align ?? "left"}`, `margin:${p.before ?? 0}pt 0 ${p.after ?? 0}pt`, `line-height:${(p.line ?? 1) * 1.17}`].join(";");
      return `<div style="${st}">${p.runs.map(runHtml).join("")}</div>`;
    }
    return `<table style="border-collapse:collapse;width:100%"><tbody>${it.table.rows.map((r) => `<tr>${r.cells.map((c) =>
      `<td style="vertical-align:top;padding:0${c.w ? `;width:${c.w}in` : ""}">${itemsHtml(c.items)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
  }).join("");
}
function floatHtml(f: LhFloat): string {
  const box = `position:absolute;left:${f.x}in;top:${f.y}in;width:${f.w}in;height:${f.h}in`;
  if (f.src) return `<img src="${f.src}" alt="" style="${box}">`;
  return `<div style="${box}${f.fill ? `;background:#${f.fill}` : ""};overflow:hidden">${f.items ? itemsHtml(f.items) : ""}</div>`;
}

/** One page's letterhead as HTML, `page.w` × `page.h` inches, positioned
 *  from its top-left. Text escaped; pictures checked by cleanLetterhead. */
export function layerHtml(l: LhLayer, page: { w: number; h: number }, opts: { blank?: boolean } = {}): string {
  const parts: string[] = [];
  if (opts.blank) parts.push("<div style=\"position:absolute;inset:0;background:#fff\"></div>");
  if (l.image) parts.push(`<img src="${l.image}" alt="" style="position:absolute;left:0;top:0;width:${page.w}in;height:${page.h}in">`);
  for (const f of l.floats ?? []) parts.push(floatHtml(f));
  const band = (b: LhBand, edge: "top" | "bottom") =>
    `<div style="position:absolute;left:${b.x}in;${edge}:${b[edge]}in;width:${b.w}in;font-family:${fontStack()};font-size:11pt;color:#000">${itemsHtml(b.items)}</div>`;
  if (l.header) parts.push(band(l.header, "top"));
  if (l.footer) parts.push(band(l.footer, "bottom"));
  return parts.join("");
}

/** The print page around a report: the letterhead behind every page (or
 *  page 1's own on page 1), the report inside the margins — a table whose
 *  header and footer rows hold the margins on every printed page. */
export function letterheadPrintCss(lh: Letterhead, scope = ""): string {
  const s = scope ? `${scope} ` : "";
  const m = lh.margins;
  return `@page{size:${lh.page.w}in ${lh.page.h}in;margin:0}
${s}.lh-layer{position:fixed;left:0;top:0;width:${lh.page.w}in;height:${lh.page.h}in;z-index:0;pointer-events:none}
${s}.lh-first{position:absolute;left:0;top:0;width:${lh.page.w}in;height:${lh.page.h}in;z-index:1;pointer-events:none}
${s}.lh-frame{position:relative;z-index:2;width:${lh.page.w}in;border-collapse:collapse;border-spacing:0}
${s}.lh-frame>thead>tr>td{height:${m.top}in;padding:0}
${s}.lh-frame>tfoot>tr>td{height:${m.bottom}in;padding:0}
${s}.lh-frame>tbody>tr{break-inside:auto!important}
${s}.lh-frame>tbody>tr>td{padding:0 ${m.right}in 0 ${m.left}in;vertical-align:top}`;
}

/** The letterhead layers (the repeating one, and page 1's own) as HTML. */
export function letterheadLayersHtml(lh: Letterhead): { every: string; first: string } {
  const firstOnly = lh.pages === "first";
  const pageOne = lh.first ?? lh.layer;
  return {
    // Every page — none when it's the first page only. No em dash on paper
    // either, whatever the Word file had.
    every: firstOnly ? "" : noEmDash(layerHtml(lh.layer, lh.page)),
    // Page 1: its own letterhead over the repeating one (blanking it where they differ).
    first: lh.first || firstOnly ? noEmDash(layerHtml(pageOne, lh.page, { blank: !firstOnly && !!lh.first })) : "",
  };
}

/** A whole printable document: the letterhead and `bodyHtml` in its margins. */
export function letterheadDocument(lh: Letterhead, title: string, bodyHtml: string, extraCss = ""): string {
  const { every, first } = letterheadLayersHtml(lh);
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>
body{margin:0;-webkit-print-color-adjust:exact;print-color-adjust:exact}
${letterheadPrintCss(lh)}
${extraCss}</style></head><body>
${every ? `<div class="lh-layer">${every}</div>` : ""}${first ? `<div class="lh-first">${first}</div>` : ""}
<table class="lh-frame"><thead><tr><td></td></tr></thead><tfoot><tr><td></td></tr></tfoot><tbody><tr><td>${bodyHtml}</td></tr></tbody></table>
</body></html>`;
}
