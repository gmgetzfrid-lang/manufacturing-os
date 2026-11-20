// slideTemplate - a company's PowerPoint template (a branding kit), and
// decks written onto it.
//
// Upload: the file is read in the browser. Its sample slides, notes and any
// macros are dropped; the masters, layouts, theme, fonts and the pictures
// they use are kept. What's left is stored once for the workspace.
//
// Reading: every layout is measured (where its title sits, where its body
// goes, what decoration it carries) and the app picks one for each kind of
// slide it writes: the cover, the agenda, the start of each part, and the
// tables and text. An admin can change any pick.
//
// Writing: each slide is placed on its layout. Titles and subtitles go into
// the layout's own boxes, so they take its fonts and colors; tables and text
// are drawn in the room the layout leaves, in the template's colors.
//
// The XML is read with a plain reader (no entities beyond the five basic
// ones, no DTDs), and nothing in the file is run.

import JSZip from "jszip";
import { parseXml, type XNode } from "@/lib/letterhead";
import { contrast, toOklch } from "@/lib/brandColors";
import { noEmDash } from "@/lib/noEmDash";

export const EMU = 914400;
/** The kinds of slide the app writes. */
export type LayoutRole = "cover" | "agenda" | "section" | "content";
export const LAYOUT_ROLES: LayoutRole[] = ["cover", "agenda", "section", "content"];
export const ROLE_WORD: Record<LayoutRole, string> = { cover: "Cover", agenda: "Agenda", section: "Start of each part", content: "Tables and text" };

export interface Rect { x: number; y: number; w: number; h: number }
export interface PhInfo {
  /** The placeholder's type as written ("title", "body", "pic"...; none means content). */
  type?: string; idx?: string;
  rect: Rect | null;
  /** Its type size in points, from the layout or its master. */
  pt?: number;
  font?: string;
}
export interface LayoutInfo {
  /** Part name: ppt/slideLayouts/slideLayout3.xml */
  file: string;
  name: string;
  phs: PhInfo[];
  /** Pictures and shapes the layout (and its master) always shows. */
  marks: Rect[];
  /** The room for tables and text. */
  room: Rect | null;
  /** The slide number box, when the layout has one. */
  num: PhInfo | null;
  theme: Record<string, string>;
  fonts: { major: string; minor: string };
}
export interface TemplateInfo {
  slide: { w: number; h: number };
  layouts: LayoutInfo[];
  roles: Partial<Record<LayoutRole, string>>;
  notesMaster: string | null;
}

/** What the workspace keeps about its template (small: loaded with the branding). */
export interface SlideTemplateRef {
  path: string;
  name: string;
  size: number;
  savedAt: string;
  /** A picture of the template's first slide, when the file has one. */
  thumbPath?: string;
  layouts: Array<{ file: string; name: string }>;
  /** The app's picks, and the admin's changes to them. */
  roles: Partial<Record<LayoutRole, string>>;
  pick?: Partial<Record<LayoutRole, string>>;
  colors: { main: string; accent: string; swatches: string[] };
  fonts: { title: string; body: string };
}

// ─── Reading XML ──────────────────────────────────────────────────

const kid = (n: XNode | undefined, name: string) => n?.kids.find((k) => k.name === name);
function find(n: XNode | undefined, name: string): XNode | undefined {
  if (!n) return undefined;
  for (const k of n.kids) { if (k.name === name) return k; const d = find(k, name); if (d) return d; }
  return undefined;
}
const num = (s: string | undefined) => (s != null && s !== "" && Number.isFinite(Number(s)) ? Number(s) : undefined);

function dirOf(part: string) { const i = part.lastIndexOf("/"); return i < 0 ? "" : part.slice(0, i); }
function relsPath(part: string) { const d = dirOf(part); const b = part.slice(d.length ? d.length + 1 : 0); return `${d ? `${d}/` : ""}_rels/${b}.rels`; }
function resolvePart(from: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const out = dirOf(from).split("/").filter(Boolean);
  for (const seg of target.split("/")) { if (seg === "..") out.pop(); else if (seg && seg !== ".") out.push(seg); }
  return out.join("/");
}
interface Rel { id: string; type: string; target: string; external: boolean }
async function relsOf(zip: JSZip, part: string): Promise<Rel[]> {
  const f = zip.file(relsPath(part));
  if (!f) return [];
  const x = parseXml(await f.async("string"));
  const root = kid(x, "Relationships");
  return (root?.kids ?? []).filter((k) => k.name === "Relationship").map((k) => ({ id: k.attrs.Id, type: k.attrs.Type ?? "", target: k.attrs.Target ?? "", external: k.attrs.TargetMode === "External" }));
}
const relKind = (type: string) => type.slice(type.lastIndexOf("/") + 1);

/** A shape's box, in EMU. */
function rectOf(shape: XNode): Rect | null {
  const pr = kid(shape, "p:spPr") ?? kid(shape, "p:grpSpPr") ?? shape;
  const xf = kid(pr, "a:xfrm") ?? kid(shape, "p:xfrm");
  const off = kid(xf, "a:off"), ext = kid(xf, "a:ext");
  const x = num(off?.attrs.x), y = num(off?.attrs.y), w = num(ext?.attrs.cx), h = num(ext?.attrs.cy);
  return x == null || y == null || w == null || h == null ? null : { x, y, w, h };
}
function phOf(shape: XNode): XNode | undefined {
  const nv = kid(shape, "p:nvSpPr") ?? kid(shape, "p:nvPicPr") ?? kid(shape, "p:nvGraphicFramePr");
  return kid(kid(nv, "p:nvPr"), "p:ph");
}
const SHAPES = new Set(["p:sp", "p:pic", "p:grpSp", "p:graphicFrame", "p:cxnSp"]);
function treeOf(doc: XNode): XNode[] {
  const tree = find(doc, "p:spTree");
  return (tree?.kids ?? []).filter((k) => SHAPES.has(k.name));
}
/** The type size and font a placeholder sets for its first level. */
function textStyle(shape: XNode | undefined): { pt?: number; font?: string } {
  const body = kid(shape, "p:txBody");
  const lvl = kid(kid(body, "a:lstStyle"), "a:lvl1pPr");
  const def = kid(lvl, "a:defRPr");
  let pt = num(def?.attrs.sz);
  let font = kid(def, "a:latin")?.attrs.typeface;
  if (pt == null || !font) {
    const r = find(body, "a:rPr") ?? find(body, "a:endParaRPr");
    pt ??= num(r?.attrs.sz);
    font ||= kid(r, "a:latin")?.attrs.typeface;
  }
  return { pt: pt != null ? pt / 100 : undefined, font: font || undefined };
}
function levelStyle(styles: XNode | undefined, which: string): { pt?: number; font?: string } {
  const def = kid(kid(kid(styles, which), "a:lvl1pPr"), "a:defRPr");
  const pt = num(def?.attrs.sz);
  return { pt: pt != null ? pt / 100 : undefined, font: kid(def, "a:latin")?.attrs.typeface || undefined };
}
const TITLE_TYPES = new Set(["title", "ctrTitle"]);
const isTitle = (p: { type?: string }) => TITLE_TYPES.has(p.type ?? "");
/** A box for words or content (not a picture, number, date or footer). */
const isBody = (p: { type?: string }) => ["body", "obj", "subTitle", "tbl", "chart", "dgm", undefined].includes(p.type);

async function readTheme(zip: JSZip, part: string): Promise<{ colors: Record<string, string>; fonts: { major: string; minor: string } }> {
  const colors: Record<string, string> = {};
  const f = zip.file(part);
  if (!f) return { colors, fonts: { major: "Calibri", minor: "Calibri" } };
  const x = parseXml(await f.async("string"));
  const scheme = find(x, "a:clrScheme");
  for (const c of scheme?.kids ?? []) {
    const v = kid(c, "a:srgbClr")?.attrs.val ?? kid(c, "a:sysClr")?.attrs.lastClr;
    if (v && /^[0-9a-f]{6}$/i.test(v)) colors[c.name.replace(/^a:/, "")] = v.toUpperCase();
  }
  const fs = find(x, "a:fontScheme");
  return { colors, fonts: { major: kid(kid(fs, "a:majorFont"), "a:latin")?.attrs.typeface || "Calibri", minor: kid(kid(fs, "a:minorFont"), "a:latin")?.attrs.typeface || "Calibri" } };
}
const themeFont = (f: string | undefined, fonts: { major: string; minor: string }) =>
  !f ? undefined : f.startsWith("+mj") ? fonts.major : f.startsWith("+mn") ? fonts.minor : f;

// ─── Measuring the layouts ───────────────────────────────────────

const area = (r: Rect) => Math.max(0, r.w) * Math.max(0, r.h);
const meets = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
/** The room left after a mark that sits in it: cut away the side that keeps the most. */
function carve(r: Rect, o: Rect): Rect {
  if (!meets(r, o)) return r;
  const cuts: Rect[] = [
    { x: r.x, y: Math.max(r.y, o.y + o.h), w: r.w, h: r.y + r.h - Math.max(r.y, o.y + o.h) },
    { x: r.x, y: r.y, w: r.w, h: Math.min(r.y + r.h, o.y) - r.y },
    { x: Math.max(r.x, o.x + o.w), y: r.y, w: r.x + r.w - Math.max(r.x, o.x + o.w), h: r.h },
    { x: r.x, y: r.y, w: Math.min(r.x + r.w, o.x) - r.x, h: r.h },
  ];
  return cuts.reduce((a, b) => (area(b) > area(a) ? b : a));
}

/** Where tables and text go on a layout: its main body box, or the slide
 *  under the title, clear of the layout's pictures and shapes. */
export function roomOf(l: Pick<LayoutInfo, "phs" | "marks">, slide: { w: number; h: number }): Rect | null {
  const full = slide.w * slide.h;
  const title = l.phs.find((p) => isTitle(p) && p.rect)?.rect;
  const bodies = l.phs.filter((p) => isBody(p) && p.rect && !isTitle(p)).map((p) => p.rect as Rect).sort((a, b) => area(b) - area(a));
  const gap = slide.h * 0.025;
  let r: Rect;
  if (bodies[0] && area(bodies[0]) >= full * 0.22) r = { ...bodies[0] };
  else {
    const top = title ? title.y + title.h + gap : slide.h * 0.16;
    const mx = title ? Math.max(slide.w * 0.03, Math.min(title.x, slide.w * 0.12)) : slide.w * 0.055;
    r = { x: mx, y: top, w: slide.w - 2 * mx, h: slide.h * 0.93 - top };
  }
  // Keep inside the slide, clear of the title and the layout's own marks.
  r = { x: Math.max(0, r.x), y: Math.max(0, r.y), w: Math.min(r.w, slide.w - Math.max(0, r.x)), h: Math.min(r.h, slide.h - Math.max(0, r.y)) };
  if (title) r = carve(r, title);
  for (const m of l.marks) if (area(m) < full * 0.6) r = carve(r, { x: m.x - gap / 2, y: m.y - gap / 2, w: m.w + gap, h: m.h + gap });
  return r.w > slide.w * 0.25 && r.h > slide.h * 0.25 ? r : null;
}

function roleByName(name: string, type: string | undefined): LayoutRole | "closing" | null {
  const n = name.toLowerCase().trim();
  if (/agenda|contents|overview|outline/.test(n)) return "agenda";
  if (type === "secHead" || /section|divider|chapter/.test(n)) return "section";
  if (/closing|thank|the end|contact|questions/.test(n)) return "closing";
  if (type === "title" || /^(title|title slide|title page|cover|cover slide|opening)$/.test(n) || /\bcover\b/.test(n)) return "cover";
  return null;
}

/** The app's pick of a layout for each kind of slide. */
export function pickRoles(layouts: LayoutInfo[], slide: { w: number; h: number }): Partial<Record<LayoutRole, string>> {
  const roles: Partial<Record<LayoutRole, string>> = {};
  const named = layouts.map((l) => ({ l, role: roleByName(l.name, undefined) }));
  for (const role of ["cover", "agenda", "section"] as const) {
    const hit = named.find((x) => x.role === role && (role === "agenda" || x.l.phs.some(isTitle)));
    if (hit) roles[role] = hit.l.file;
  }
  // Tables and text: the layout with the most clear room, a title box,
  // and no picture boxes or rows of small boxes to leave empty.
  const full = slide.w * slide.h;
  let best: { l: LayoutInfo; score: number } | null = null;
  for (const { l, role } of named) {
    if (role || !l.room) continue;
    let score = area(l.room) / full;
    if (!l.phs.some(isTitle)) score *= 0.6;
    if (l.phs.some((p) => p.type === "pic" || p.type === "clipArt")) score *= 0.45;
    if (l.phs.filter((p) => isBody(p) && !isTitle(p)).length > 2) score *= 0.5;
    if (/content|text|body|bullet|table|title only/i.test(l.name)) score *= 1.08;
    if (!best || score > best.score) best = { l, score };
  }
  if (best) roles.content = best.l.file;
  if (!roles.cover) {
    // The first layout with a title box is the cover in most templates.
    const c = layouts.find((l) => l.phs.some(isTitle) && l.file !== roles.content);
    if (c) roles.cover = c.file;
  }
  return roles;
}

/** Measure a template: its slide size, every layout, and the picks. */
export async function readTemplate(zip: JSZip): Promise<TemplateInfo> {
  const presPart = "ppt/presentation.xml";
  const pf = zip.file(presPart);
  if (!pf) throw new Error("That file isn't a PowerPoint file. Upload a .pptx or .potx.");
  const pres = parseXml(await pf.async("string"));
  const sz = find(pres, "p:sldSz");
  const slide = { w: num(sz?.attrs.cx) ?? 12192000, h: num(sz?.attrs.cy) ?? 6858000 };
  const presRels = await relsOf(zip, presPart);
  const layouts: LayoutInfo[] = [];
  let notesMaster: string | null = null;
  for (const rel of presRels) {
    const kind = relKind(rel.type);
    if (kind === "notesMaster" && !rel.external) notesMaster = resolvePart(presPart, rel.target);
    if (kind !== "slideMaster" || rel.external) continue;
    const mPart = resolvePart(presPart, rel.target);
    const mf = zip.file(mPart);
    if (!mf) continue;
    const master = parseXml(await mf.async("string"));
    const mRels = await relsOf(zip, mPart);
    const themeRel = mRels.find((r) => relKind(r.type) === "theme");
    const theme = themeRel ? await readTheme(zip, resolvePart(mPart, themeRel.target)) : { colors: {}, fonts: { major: "Calibri", minor: "Calibri" } };
    const styles = find(master, "p:txStyles");
    const titleStyle = levelStyle(styles, "p:titleStyle"), bodyStyle = levelStyle(styles, "p:bodyStyle");
    const mShapes = treeOf(master);
    const mPhs = mShapes.filter(phOf).map((s) => ({ type: phOf(s)!.attrs.type, idx: phOf(s)!.attrs.idx, rect: rectOf(s) }));
    const mMarks = mShapes.filter((s) => !phOf(s)).map(rectOf).filter((r): r is Rect => !!r);
    for (const lr of mRels.filter((r) => relKind(r.type) === "slideLayout" && !r.external)) {
      const file = resolvePart(mPart, lr.target);
      const lf = zip.file(file);
      if (!lf) continue;
      const doc = parseXml(await lf.async("string"));
      const root = kid(doc, "p:sldLayout");
      const name = kid(root, "p:cSld")?.attrs.name || file.replace(/^.*\//, "").replace(/\.xml$/, "");
      const shapes = treeOf(doc);
      const phs: PhInfo[] = shapes.filter(phOf).map((s) => {
        const ph = phOf(s)!;
        const type = ph.attrs.type, idx = ph.attrs.idx;
        const fromMaster = mPhs.find((m) => (m.type ?? "obj") === (type ?? "obj") && (idx == null || m.idx == null || m.idx === idx)) ?? mPhs.find((m) => idx != null && m.idx === idx);
        const own = textStyle(s);
        const base = TITLE_TYPES.has(type ?? "") ? titleStyle : bodyStyle;
        return { type, idx, rect: rectOf(s) ?? fromMaster?.rect ?? null, pt: own.pt ?? base.pt, font: themeFont(own.font ?? base.font, theme.fonts) };
      });
      const showMaster = root?.attrs.showMasterSp !== "0";
      const marks = [...shapes.filter((s) => !phOf(s)).map(rectOf).filter((r): r is Rect => !!r), ...(showMaster ? mMarks : [])];
      const numPh = phs.find((p) => p.type === "sldNum" && p.rect) ?? null;
      const info: LayoutInfo = { file, name, phs, marks, room: null, num: numPh, theme: theme.colors, fonts: theme.fonts };
      info.room = roomOf(info, slide);
      layouts.push(info);
    }
  }
  if (!layouts.length) throw new Error("That file has no slide layouts. Upload the company's PowerPoint template.");
  return { slide, layouts, roles: pickRoles(layouts, slide), notesMaster };
}

// ─── The template's colors and fonts ─────────────────────────────

const hexOf = (v: string) => `#${v}`;
/** The template's main color (its title color, or its first strong
 *  accent), a second color that stands apart from it, and the swatches. */
export function templateColors(l: LayoutInfo): { main: string; accent: string; swatches: string[] } {
  const t = l.theme;
  const accents = ["accent1", "accent2", "accent3", "accent4", "accent5", "accent6"].map((k) => t[k]).filter(Boolean);
  const strong = accents.filter((c) => toOklch(hexOf(c))[1] >= 0.05);
  const readable = (c: string) => contrast(hexOf(c), "#ffffff") >= 4.5;
  const dark2 = t.dk2 && toOklch(hexOf(t.dk2))[1] >= 0.05 ? t.dk2 : null;
  const main = strong.find(readable) ?? (dark2 && readable(dark2) ? dark2 : null) ?? strong[0] ?? t.dk2 ?? "1F2733";
  const hue = (c: string) => toOklch(hexOf(c))[2];
  const gap = (a: number, b: number) => { const d = Math.abs(a - b) % 360; return Math.min(d, 360 - d); };
  const others = strong.filter((c) => c !== main).sort((a, b) => gap(hue(b), hue(main)) - gap(hue(a), hue(main)));
  return { main, accent: others[0] ?? main, swatches: [...new Set(accents)] };
}
/** The fonts the template sets for titles and for body text. */
export function templateFonts(l: LayoutInfo): { title: string; body: string } {
  const title = l.phs.find(isTitle)?.font ?? l.fonts.major;
  const body = l.phs.filter((p) => isBody(p) && !isTitle(p)).sort((a, b) => area(b.rect ?? { x: 0, y: 0, w: 0, h: 0 }) - area(a.rect ?? { x: 0, y: 0, w: 0, h: 0 }))[0]?.font ?? l.fonts.minor;
  return { title, body };
}

// ─── Upload: keep the layouts, drop the samples ──────────────────

const MAIN_PRES = "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml";
const DROP = new Set(["slide", "notesSlide", "comments", "vbaProject", "activeXControl", "oleObject", "control", "video", "audio", "media"]);
const MAX_UNZIPPED = 300 * 1024 * 1024;
export const MAX_TEMPLATE = 25 * 1024 * 1024;

/** The template without its sample slides, ready to store, with its
 *  measurements and the picture of its first slide (if it has one). */
export async function leanTemplate(data: ArrayBuffer | Uint8Array): Promise<{ data: Uint8Array; info: TemplateInfo; thumb: Uint8Array | null }> {
  let zip: JSZip;
  try { zip = await JSZip.loadAsync(data); } catch { throw new Error("That file isn't a PowerPoint file. Upload a .pptx or .potx."); }
  let unzipped = 0;
  zip.forEach((_, f) => { unzipped += (f as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0; });
  if (unzipped > MAX_UNZIPPED) throw new Error("That file is too big to read.");
  if (!zip.file("ppt/presentation.xml")) throw new Error("That file isn't a PowerPoint file. Upload a .pptx or .potx.");

  // Everything the masters and layouts reach, starting from the package root.
  const keep = new Set<string>();
  const rels = new Map<string, Rel[]>();
  const todo = ["__root__"];
  while (todo.length) {
    const part = todo.pop()!;
    const rs = part === "__root__" ? await relsOfRoot(zip) : await relsOf(zip, part);
    const kept = rs.filter((r) => r.external || !DROP.has(relKind(r.type)));
    if (part === "__root__" || zip.file(relsPath(part))) rels.set(part, kept);
    for (const r of kept) {
      if (r.external) continue;
      const t = part === "__root__" ? resolvePart("x", r.target) : resolvePart(part, r.target);
      if (keep.has(t) || !zip.file(t)) continue;
      keep.add(t); todo.push(t);
    }
  }
  const out = new JSZip();
  for (const part of keep) {
    if (part === "ppt/presentation.xml") continue;
    out.file(part, await zip.file(part)!.async("uint8array"));
  }
  // The deck itself: no slides, no custom shows, no slide sections.
  let pres = await zip.file("ppt/presentation.xml")!.async("string");
  pres = pres.replace(/<p:sldIdLst>[\s\S]*?<\/p:sldIdLst>|<p:sldIdLst\/>/g, "")
    .replace(/<p:custShowLst>[\s\S]*?<\/p:custShowLst>/g, "")
    .replace(/<p:ext uri="\{521415D9-36F7-43E2-AB2F-B90AF26B5E84\}">[\s\S]*?<\/p:ext>/g, "");
  out.file("ppt/presentation.xml", pres);
  // Relationship files, without the dropped parts.
  for (const [part, rs] of rels) {
    const path = part === "__root__" ? "_rels/.rels" : relsPath(part);
    if (part !== "__root__" && !keep.has(part)) continue;
    out.file(path, relsXml(rs));
  }
  // Content types: only what's kept; a template (.potx) becomes a presentation.
  const ctx = await zip.file("[Content_Types].xml")?.async("string");
  if (!ctx) throw new Error("That file isn't a PowerPoint file. Upload a .pptx or .potx.");
  const types = ctx.replace(/<Override\s+PartName="\/([^"]+)"[^>]*\/>/g, (m, p: string) => (keep.has(p) || p === "ppt/presentation.xml" ? m : ""))
    .replace(/(PartName="\/ppt\/presentation\.xml"\s+ContentType=")[^"]+"/, `$1${MAIN_PRES}"`)
    .replace(/(ContentType=")[^"]+("\s+PartName="\/ppt\/presentation\.xml")/, `$1${MAIN_PRES}$2`)
    .replace(/<Default\s+Extension="bin"[^>]*vbaProject[^>]*\/>/g, "");
  out.file("[Content_Types].xml", types);
  const info = await readTemplate(out);
  const thumbPart = [...keep].find((p) => /^docProps\/thumbnail\.(jpe?g|png)$/i.test(p));
  const thumb = thumbPart ? await out.file(thumbPart)!.async("uint8array") : null;
  const bytes = await out.generateAsync({ type: "uint8array", compression: "DEFLATE" });
  if (bytes.length > MAX_TEMPLATE) throw new Error(`That template is ${Math.round(bytes.length / 1048576)} MB without its sample slides. The limit is ${MAX_TEMPLATE / 1048576} MB.`);
  return { data: bytes, info, thumb };
}
async function relsOfRoot(zip: JSZip): Promise<Rel[]> {
  const f = zip.file("_rels/.rels");
  if (!f) return [];
  const root = kid(parseXml(await f.async("string")), "Relationships");
  return (root?.kids ?? []).filter((k) => k.name === "Relationship").map((k) => ({ id: k.attrs.Id, type: k.attrs.Type ?? "", target: (k.attrs.Target ?? "").replace(/^\//, ""), external: k.attrs.TargetMode === "External" }));
}
const xa = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const relsXml = (rs: Rel[]) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rs.map((r) => `<Relationship Id="${xa(r.id)}" Type="${xa(r.type)}" Target="${xa(r.target)}"${r.external ? ' TargetMode="External"' : ""}/>`).join("")}</Relationships>`;

// ─── Drawing ─────────────────────────────────────────────────────

/** Text for slide XML: no dashes the house style rules out, no control characters. */
export const xt = (s: string) => noEmDash(s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export interface Run { text: string; b?: boolean; pt?: number; color?: string; font?: string }
export interface Para { runs: Run[]; bullet?: boolean; level?: number; before?: number; after?: number; align?: "l" | "ctr" | "r"; keepBullets?: boolean;
  /** Line spacing in percent. Set on every box the app fills: a layout can
   *  fix its line height in points, made for a far larger type. */
  lnSpc?: number }

const runXml = (r: Run) => `<a:r><a:rPr lang="en-US"${r.pt ? ` sz="${Math.round(r.pt * 100)}"` : ""}${r.b != null ? ` b="${r.b ? 1 : 0}"` : ""} dirty="0">${r.color ? `<a:solidFill><a:srgbClr val="${r.color}"/></a:solidFill>` : ""}${r.font ? `<a:latin typeface="${xa(r.font)}"/><a:cs typeface="${xa(r.font)}"/>` : ""}</a:rPr><a:t>${xt(r.text)}</a:t></a:r>`;
export function paraXml(p: Para, ptFor = 12): string {
  const lvl = p.level ?? 0;
  const ind = p.bullet ? Math.round((0.22 + lvl * 0.25) * EMU * (ptFor / 14)) : 0;
  const attrs = `${p.bullet ? ` marL="${ind}" indent="${-Math.round(ind * 0.75)}"` : p.keepBullets ? "" : ' marL="0" indent="0"'}${p.align ? ` algn="${p.align}"` : ""}`;
  const spc = `${p.lnSpc ? `<a:lnSpc><a:spcPct val="${Math.round(p.lnSpc * 1000)}"/></a:lnSpc>` : ""}${p.before ? `<a:spcBef><a:spcPts val="${Math.round(p.before * 100)}"/></a:spcBef>` : ""}${p.after != null ? `<a:spcAft><a:spcPts val="${Math.round(p.after * 100)}"/></a:spcAft>` : ""}`;
  const bu = p.keepBullets ? "" : p.bullet ? '<a:buFont typeface="Arial"/><a:buChar char="&#8226;"/>' : "<a:buNone/>";
  const first = p.runs[0];
  return `<a:p><a:pPr${attrs}>${spc}${bu}</a:pPr>${p.runs.filter((r) => r.text !== "").map(runXml).join("")}<a:endParaRPr lang="en-US"${first?.pt ? ` sz="${Math.round(first.pt * 100)}"` : ""} dirty="0"/></a:p>`;
}
const xfrm = (r: Rect) => `<a:xfrm><a:off x="${Math.round(r.x)}" y="${Math.round(r.y)}"/><a:ext cx="${Math.max(0, Math.round(r.w))}" cy="${Math.max(0, Math.round(r.h))}"/></a:xfrm>`;

export interface Cell { paras: Para[]; fill?: string; rowSpan?: number; merged?: boolean; ruleTop?: { color: string; pt: number } }

/** One slide on one layout: placeholders filled, shapes drawn. */
export class SlideDraft {
  private n = 1;
  readonly parts: string[] = [];
  notes = "";
  constructor(readonly layout: LayoutInfo) {}
  private id() { return ++this.n; }
  /** Fill one of the layout's own boxes (title, subtitle, body). */
  fill(ph: PhInfo, paras: Para[]) {
    const id = this.id();
    const at = `${ph.type ? ` type="${ph.type}"` : ""}${ph.idx != null ? ` idx="${ph.idx}"` : ""}`;
    this.parts.push(`<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${ph.type ?? "Content"} ${id}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph${at}/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>${paras.map((p) => paraXml({ lnSpc: 100, ...p })).join("")}</p:txBody></p:sp>`);
  }
  text(r: Rect, paras: Para[], o: { anchor?: "t" | "ctr" | "b"; name?: string } = {}) {
    const id = this.id();
    const pt = paras[0]?.runs[0]?.pt ?? 12;
    this.parts.push(`<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${xa(o.name ?? `Text ${id}`)}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr>${xfrm(r)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr><p:txBody><a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0" anchor="${o.anchor ?? "t"}"><a:noAutofit/></a:bodyPr><a:lstStyle/>${paras.map((p) => paraXml(p, pt)).join("")}</p:txBody></p:sp>`);
  }
  box(r: Rect, fill: string, name = "Mark") {
    const id = this.id();
    this.parts.push(`<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${xa(name)} ${id}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>${xfrm(r)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="${fill}"/></a:solidFill><a:ln><a:noFill/></a:ln></p:spPr></p:sp>`);
  }
  /** A table: column widths in EMU, rows of cells, each row's least height. */
  table(r: Rect, cols: number[], rows: Cell[][], heights: number[], pad: { x: number; y: number }) {
    const id = this.id();
    const none = (side: string) => `<a:${side} w="0"><a:noFill/></a:${side}>`;
    const tr = rows.map((row, ri) => `<a:tr h="${Math.round(heights[ri] ?? 0)}">${row.map((c) => {
      const span = c.rowSpan && c.rowSpan > 1 ? ` rowSpan="${c.rowSpan}"` : c.merged ? ' vMerge="1"' : "";
      const top = c.ruleTop ? `<a:lnT w="${Math.round(c.ruleTop.pt * 12700)}"><a:solidFill><a:srgbClr val="${c.ruleTop.color}"/></a:solidFill></a:lnT>` : none("lnT");
      return `<a:tc${span}><a:txBody><a:bodyPr/><a:lstStyle/>${(c.paras.length ? c.paras : [{ runs: [] }]).map((p) => paraXml(p)).join("")}</a:txBody><a:tcPr marL="${Math.round(pad.x)}" marR="${Math.round(pad.x)}" marT="${Math.round(pad.y)}" marB="${Math.round(pad.y)}" anchor="t">${none("lnL")}${none("lnR")}${top}${none("lnB")}${c.fill ? `<a:solidFill><a:srgbClr val="${c.fill}"/></a:solidFill>` : "<a:noFill/>"}</a:tcPr></a:tc>`;
    }).join("")}</a:tr>`).join("");
    const h = heights.reduce((a, c) => a + c, 0);
    this.parts.push(`<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="Table ${id}"/><p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="${Math.round(r.x)}" y="${Math.round(r.y)}"/><a:ext cx="${Math.round(cols.reduce((a, c) => a + c, 0))}" cy="${Math.round(h)}"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr firstRow="1"/><a:tblGrid>${cols.map((w) => `<a:gridCol w="${Math.round(w)}"/>`).join("")}</a:tblGrid>${tr}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`);
  }
}

// ─── Fitting words ───────────────────────────────────────────────

/** How many lines a text takes in a width (inches) at a size (points). */
export function lineCount(text: string, wIn: number, pt: number, wide = 0.5): number {
  const per = (pt * wide) / 72;
  let lines = 0;
  for (const para of text.split("\n")) {
    let cur = 0, n = 1;
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const w = word.length * per;
      if (cur > 0 && cur + per + w > wIn) { n++; cur = w; } else cur += (cur > 0 ? per : 0) + w;
      while (cur > wIn) { n++; cur -= wIn; }
    }
    lines += n;
  }
  return lines;
}
/** The largest size (at most `max`) at which the text fits the box. */
export function fitPt(text: string, box: Rect, max: number, min: number, wide = 0.5, lead = 1.12): number {
  const wIn = Math.max(0.5, box.w / EMU - 0.2), hIn = Math.max(0.2, box.h / EMU - 0.1);
  for (let pt = max; pt > min; pt -= max > 30 ? 2 : 1) if (lineCount(text, wIn, pt, wide) * pt * lead / 72 <= hIn) return pt;
  return min;
}

// ─── Writing the deck ────────────────────────────────────────────

const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/** The deck: the template with these slides in it. */
export async function writeDeck(template: ArrayBuffer | Uint8Array, info: TemplateInfo, slides: SlideDraft[], title: string, opts: { forScreen?: boolean } = {}): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(template);
  const presRelsPath = "ppt/_rels/presentation.xml.rels";
  let presRels = (await zip.file(presRelsPath)?.async("string")) ?? `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`;
  let pres = await zip.file("ppt/presentation.xml")!.async("string");
  let types = await zip.file("[Content_Types].xml")!.async("string");
  const used = new Set([...presRels.matchAll(/Id="([^"]+)"/g)].map((m) => m[1]));
  let rn = 1;
  const freshId = () => { while (used.has(`rId${rn}`)) rn++; used.add(`rId${rn}`); return `rId${rn}`; };
  const sldIds: string[] = [];
  const addRels: string[] = [];
  const addTypes: string[] = [];
  slides.forEach((d, i) => {
    const n = i + 1;
    const part = `ppt/slides/slide${n}.xml`;
    const numPh = d.layout.num;
    let tree = d.parts.join("");
    if (numPh) tree += `<p:sp><p:nvSpPr><p:cNvPr id="999" name="Slide Number"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldNum"${numPh.idx != null ? ` idx="${numPh.idx}"` : ""}/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:fld id="{B6F15528-21DE-4FAA-801E-634DDDAF4B2B}" type="slidenum"><a:rPr lang="en-US"/><a:t>${n}</a:t></a:fld><a:endParaRPr lang="en-US"/></a:p></p:txBody></p:sp>`;
    zip.file(part, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:sld ${NS}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>${tree}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`);
    const rels = [`<Relationship Id="rId1" Type="${REL}/slideLayout" Target="../slideLayouts/${d.layout.file.replace(/^.*\//, "")}"/>`];
    if (d.notes && info.notesMaster) {
      const np = `ppt/notesSlides/notesSlide${n}.xml`;
      zip.file(np, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:notes ${NS}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp><p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>${d.notes.split("\n").map((l) => `<a:p><a:r><a:rPr lang="en-US" dirty="0"/><a:t>${xt(l)}</a:t></a:r></a:p>`).join("")}</p:txBody></p:sp></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>`);
      zip.file(relsPath(np), `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/notesMaster" Target="../${info.notesMaster.replace(/^ppt\//, "")}"/><Relationship Id="rId2" Type="${REL}/slide" Target="../slides/slide${n}.xml"/></Relationships>`);
      rels.push(`<Relationship Id="rId2" Type="${REL}/notesSlide" Target="../notesSlides/notesSlide${n}.xml"/>`);
      addTypes.push(`<Override PartName="/${np}" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/>`);
    }
    zip.file(relsPath(part), `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join("")}</Relationships>`);
    const rid = freshId();
    addRels.push(`<Relationship Id="${rid}" Type="${REL}/slide" Target="slides/slide${n}.xml"/>`);
    sldIds.push(`<p:sldId id="${256 + i}" r:id="${rid}"/>`);
    addTypes.push(`<Override PartName="/${part}" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`);
  });
  presRels = presRels.replace("</Relationships>", `${addRels.join("")}</Relationships>`);
  pres = pres.replace(/<p:sldIdLst>[\s\S]*?<\/p:sldIdLst>/, "");
  const list = `<p:sldIdLst>${sldIds.join("")}</p:sldIdLst>`;
  pres = /<p:sldSz\b/.test(pres) ? pres.replace(/<p:sldSz\b/, `${list}<p:sldSz`) : pres.replace(/(<\/p:sldMasterIdLst>)/, `$1${list}`);
  types = types.replace("</Types>", `${addTypes.join("")}</Types>`);
  if (!/Extension="xml"/i.test(types)) types = types.replace("</Types>", '<Default Extension="xml" ContentType="application/xml"/></Types>');
  zip.file("ppt/presentation.xml", pres);
  zip.file(presRelsPath, presRels);
  zip.file("[Content_Types].xml", types);
  // The file's own record of what's in it, short and true.
  if (zip.file("docProps/app.xml")) zip.file("docProps/app.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Microsoft Office PowerPoint</Application><Slides>${slides.length}</Slides><Notes>${slides.filter((s) => s.notes && info.notesMaster).length}</Notes></Properties>`);
  const core = await zip.file("docProps/core.xml")?.async("string");
  if (core) zip.file("docProps/core.xml", /<dc:title>/.test(core) ? core.replace(/<dc:title>[\s\S]*?<\/dc:title>/, `<dc:title>${xt(title)}</dc:title>`) : core.replace(/<\/cp:coreProperties>/, `<dc:title>${xt(title)}</dc:title></cp:coreProperties>`));
  // For the screen: the same file, not packed (drawn at once, never saved).
  return zip.generateAsync({ type: "uint8array", compression: opts.forScreen ? "STORE" : "DEFLATE", mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation" });
}

/** The layout chosen for a kind of slide: the admin's pick, else the app's. */
export function layoutFor(info: TemplateInfo, role: LayoutRole, pick?: Partial<Record<LayoutRole, string>>): LayoutInfo | null {
  const file = pick?.[role] ?? info.roles[role];
  if (file === "none") return null;
  return info.layouts.find((l) => l.file === file) ?? null;
}

export const titleBox = (l: LayoutInfo) => l.phs.find((p) => isTitle(p) && p.rect) ?? null;
/** The layout's body boxes, largest first. */
export const bodyBoxes = (l: LayoutInfo) => l.phs.filter((p) => isBody(p) && !isTitle(p) && p.rect).sort((a, b) => area(b.rect!) - area(a.rect!));
