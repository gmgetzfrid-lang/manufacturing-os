// slideRender - a PowerPoint file drawn in the browser, so the slides on
// screen are the slides in the file.
//
// It reads the file the app writes (lib/slideTemplate writeDeck): each
// slide on its layout and master, with the template's own artwork
// (pictures, shapes, freeform paths, groups, rotation), its colors and
// fonts, the boxes the app filled (titles inherit the layout's style), and
// the tables. Shadows and glows are left out; everything else that sets
// where things are and what color they are is drawn.
//
// Output is plain HTML per slide, sized in px at 96 to the inch. Every
// text is escaped, every color is checked, every picture comes from the
// file itself.

import JSZip from "jszip";
import { parseXml, type XNode } from "@/lib/letterhead";

const PX = 9525; // EMU per px
const kid = (n: XNode | undefined, name: string) => n?.kids.find((k) => k.name === name);
const kids = (n: XNode | undefined, name: string) => n?.kids.filter((k) => k.name === name) ?? [];
const num = (s: string | undefined, d = 0) => (s != null && s !== "" && Number.isFinite(Number(s)) ? Number(s) : d);
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const fam = (f: string) => f.replace(/[^\w \-]/g, "").trim();

function dirOf(p: string) { const i = p.lastIndexOf("/"); return i < 0 ? "" : p.slice(0, i); }
function relsPath(p: string) { const d = dirOf(p); return `${d ? `${d}/` : ""}_rels/${p.slice(d.length ? d.length + 1 : 0)}.rels`; }
function resolve(from: string, t: string) {
  if (t.startsWith("/")) return t.slice(1);
  const out = dirOf(from).split("/").filter(Boolean);
  for (const s of t.split("/")) { if (s === "..") out.pop(); else if (s && s !== ".") out.push(s); }
  return out.join("/");
}

// ─── Colors ──────────────────────────────────────────────────────

interface Rgba { r: number; g: number; b: number; a: number }
const hexRgb = (h: string): Rgba => ({ r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: 1 });
const css = (c: Rgba) => `rgba(${Math.round(c.r)},${Math.round(c.g)},${Math.round(c.b)},${Math.max(0, Math.min(1, c.a)).toFixed(3)})`;
function toHsl({ r, g, b }: Rgba): [number, number, number] {
  const R = r / 255, G = g / 255, B = b / 255, mx = Math.max(R, G, B), mn = Math.min(R, G, B), l = (mx + mn) / 2;
  if (mx === mn) return [0, 0, l];
  const d = mx - mn, s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  const h = mx === R ? (G - B) / d + (G < B ? 6 : 0) : mx === G ? (B - R) / d + 2 : (R - G) / d + 4;
  return [h / 6, s, l];
}
function fromHsl(h: number, s: number, l: number, a: number): Rgba {
  if (s === 0) return { r: l * 255, g: l * 255, b: l * 255, a };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const f = (t: number) => { t = (t + 1) % 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; };
  return { r: f(h + 1 / 3) * 255, g: f(h) * 255, b: f(h - 1 / 3) * 255, a };
}
const PRESET: Record<string, string> = { black: "000000", white: "FFFFFF", red: "FF0000", green: "008000", blue: "0000FF", yellow: "FFFF00", gray: "808080", grey: "808080" };

interface Ctx {
  zip: JSZip;
  theme: Record<string, string>;
  map: Record<string, string>;
  fonts: { major: string; minor: string };
  media: (part: string) => Promise<string | null>;
  /** Fonts the slides use, to load. */
  used: Set<string>;
}

/** A color element (a:srgbClr, a:schemeClr...) with its changes applied. */
function colorOf(n: XNode | undefined, ctx: Ctx, ph?: Rgba): Rgba | null {
  if (!n) return null;
  let c: Rgba | null = null;
  const v = n.attrs.val;
  if (n.name === "a:srgbClr" && /^[0-9a-f]{6}$/i.test(v ?? "")) c = hexRgb(v);
  else if (n.name === "a:schemeClr") {
    if (v === "phClr") c = ph ? { ...ph } : null;
    else { const k = ctx.map[v] ?? v; const h = ctx.theme[k]; if (h) c = hexRgb(h); }
  } else if (n.name === "a:sysClr") { const h = n.attrs.lastClr ?? (v === "window" ? "FFFFFF" : "000000"); if (/^[0-9a-f]{6}$/i.test(h)) c = hexRgb(h); }
  else if (n.name === "a:prstClr" && PRESET[v]) c = hexRgb(PRESET[v]);
  else if (n.name === "a:scrgbClr") c = { r: num(n.attrs.r) / 100000 * 255, g: num(n.attrs.g) / 100000 * 255, b: num(n.attrs.b) / 100000 * 255, a: 1 };
  if (!c) return null;
  for (const m of n.kids) {
    const x = num(m.attrs.val) / 100000;
    if (m.name === "a:alpha") c.a = x;
    else if (m.name === "a:tint") c = { r: 255 - (255 - c.r) * x, g: 255 - (255 - c.g) * x, b: 255 - (255 - c.b) * x, a: c.a };
    else if (m.name === "a:shade") c = { r: c.r * x, g: c.g * x, b: c.b * x, a: c.a };
    else if (m.name === "a:lumMod" || m.name === "a:lumOff" || m.name === "a:satMod") {
      const [h, s, l] = toHsl(c);
      c = m.name === "a:lumMod" ? fromHsl(h, s, l * x, c.a) : m.name === "a:lumOff" ? fromHsl(h, s, Math.min(1, l + x), c.a) : fromHsl(h, Math.min(1, s * x), l, c.a);
    }
  }
  return c;
}
const COLOR_TAGS = new Set(["a:srgbClr", "a:schemeClr", "a:sysClr", "a:prstClr", "a:scrgbClr"]);
const colorIn = (n: XNode | undefined, ctx: Ctx, ph?: Rgba) => colorOf(n?.kids.find((k) => COLOR_TAGS.has(k.name)), ctx, ph);

type Paint = { kind: "none" } | { kind: "solid"; c: Rgba } | { kind: "grad"; stops: Array<{ at: number; c: Rgba }>; ang: number } | { kind: "pic"; part: string };
function paintOf(pr: XNode | undefined, ctx: Ctx, style?: XNode, rels?: Map<string, string>, grp?: Paint): Paint | null {
  for (const k of pr?.kids ?? []) {
    if (k.name === "a:noFill") return { kind: "none" };
    if (k.name === "a:solidFill") { const c = colorIn(k, ctx); return c ? { kind: "solid", c } : null; }
    if (k.name === "a:gradFill") {
      const stops = kids(kid(k, "a:gsLst"), "a:gs").map((g) => ({ at: num(g.attrs.pos) / 1000, c: colorIn(g, ctx) })).filter((s): s is { at: number; c: Rgba } => !!s.c);
      return stops.length ? { kind: "grad", stops, ang: num(kid(k, "a:lin")?.attrs.ang) / 60000 } : null;
    }
    if (k.name === "a:blipFill") { const id = kid(k, "a:blip")?.attrs["r:embed"]; const part = id ? rels?.get(id) : undefined; return part ? { kind: "pic", part } : null; }
    if (k.name === "a:grpFill") return grp ?? null;
  }
  // No fill set: the shape's style.
  const ref = kid(style, "a:fillRef");
  if (ref && num(ref.attrs.idx) > 0) { const c = colorIn(ref, ctx); if (c) return { kind: "solid", c }; }
  return null;
}
function lineOf(pr: XNode | undefined, ctx: Ctx, style?: XNode): { c: Rgba; w: number } | null {
  const ln = kid(pr, "a:ln");
  if (ln) {
    if (kid(ln, "a:noFill")) return null;
    const c = colorIn(kid(ln, "a:solidFill"), ctx) ?? (kid(ln, "a:solidFill") ? null : colorIn(kid(style, "a:lnRef"), ctx));
    return c ? { c, w: Math.max(1, num(ln.attrs.w, 9525) / PX) } : null;
  }
  const ref = kid(style, "a:lnRef");
  if (ref && num(ref.attrs.idx) > 0) { const c = colorIn(ref, ctx); if (c) return { c, w: 12700 / PX }; }
  return null;
}

// ─── Geometry ────────────────────────────────────────────────────

interface Box { x: number; y: number; w: number; h: number; rot: number; fh: boolean; fv: boolean }
function boxOf(xf: XNode | undefined): Box | null {
  const off = kid(xf, "a:off"), ext = kid(xf, "a:ext");
  if (!off || !ext) return null;
  return { x: num(off.attrs.x) / PX, y: num(off.attrs.y) / PX, w: num(ext.attrs.cx) / PX, h: num(ext.attrs.cy) / PX, rot: num(xf?.attrs.rot) / 60000, fh: xf?.attrs.flipH === "1", fv: xf?.attrs.flipV === "1" };
}
const place = (b: Box, extra = "") => `position:absolute;left:${b.x.toFixed(2)}px;top:${b.y.toFixed(2)}px;width:${Math.max(0, b.w).toFixed(2)}px;height:${Math.max(0, b.h).toFixed(2)}px;${b.rot || b.fh || b.fv ? `transform:rotate(${b.rot}deg)${b.fh ? " scaleX(-1)" : ""}${b.fv ? " scaleY(-1)" : ""};` : ""}${extra}`;

let gradSeq = 0;
function svgPaint(p: Paint | null, defs: string[], picUrl?: string | null): string {
  if (!p || p.kind === "none") return "none";
  if (p.kind === "solid") return css(p.c);
  if (p.kind === "grad") {
    const id = `g${++gradSeq}`, a = (p.ang * Math.PI) / 180;
    const x2 = 0.5 + Math.cos(a) / 2, y2 = 0.5 + Math.sin(a) / 2;
    defs.push(`<linearGradient id="${id}" x1="${(1 - x2).toFixed(3)}" y1="${(1 - y2).toFixed(3)}" x2="${x2.toFixed(3)}" y2="${y2.toFixed(3)}">${p.stops.map((s) => `<stop offset="${s.at.toFixed(1)}%" stop-color="${css({ ...s.c, a: 1 })}" stop-opacity="${s.c.a}"/>`).join("")}</linearGradient>`);
    return `url(#${id})`;
  }
  if (picUrl) {
    const id = `p${++gradSeq}`;
    defs.push(`<pattern id="${id}" patternUnits="objectBoundingBox" width="1" height="1"><image href="${esc(picUrl)}" width="1" height="1" preserveAspectRatio="none"/></pattern>`);
    return `url(#${id})`;
  }
  return "none";
}
function presetPath(prst: string, w: number, h: number, av: Record<string, number>): string {
  const m = Math.min(w, h);
  switch (prst) {
    case "ellipse": return `M0,${h / 2} A${w / 2},${h / 2} 0 1,0 ${w},${h / 2} A${w / 2},${h / 2} 0 1,0 0,${h / 2} Z`;
    case "roundRect": { const r = m * (av.adj ?? 16667) / 100000; return `M${r},0 H${w - r} A${r},${r} 0 0,1 ${w},${r} V${h - r} A${r},${r} 0 0,1 ${w - r},${h} H${r} A${r},${r} 0 0,1 0,${h - r} V${r} A${r},${r} 0 0,1 ${r},0 Z`; }
    case "triangle": { const x = w * (av.adj ?? 50000) / 100000; return `M${x},0 L${w},${h} L0,${h} Z`; }
    case "rtTriangle": return `M0,0 L${w},${h} L0,${h} Z`;
    case "diamond": return `M${w / 2},0 L${w},${h / 2} L${w / 2},${h} L0,${h / 2} Z`;
    case "parallelogram": { const x = m * (av.adj ?? 25000) / 100000; return `M${x},0 L${w},0 L${w - x},${h} L0,${h} Z`; }
    case "line": case "straightConnector1": return `M0,0 L${w},${h}`;
    default: return `M0,0 H${w} V${h} H0 Z`;
  }
}
function customPaths(geom: XNode, w: number, h: number): Array<{ d: string; fill: boolean; stroke: boolean }> {
  const out: Array<{ d: string; fill: boolean; stroke: boolean }> = [];
  for (const p of kids(kid(geom, "a:pathLst"), "a:path")) {
    const pw = num(p.attrs.w, 0) || w * PX, ph = num(p.attrs.h, 0) || h * PX;
    const sx = w / pw, sy = h / ph;
    const pt = (n: XNode) => `${(num(n.attrs.x) * sx).toFixed(2)},${(num(n.attrs.y) * sy).toFixed(2)}`;
    let d = "";
    for (const c of p.kids) {
      const pts = kids(c, "a:pt");
      if (c.name === "a:moveTo" && pts[0]) d += `M${pt(pts[0])} `;
      else if (c.name === "a:lnTo" && pts[0]) d += `L${pt(pts[0])} `;
      else if (c.name === "a:cubicBezTo" && pts.length === 3) d += `C${pts.map(pt).join(" ")} `;
      else if (c.name === "a:quadBezTo" && pts.length === 2) d += `Q${pts.map(pt).join(" ")} `;
      else if (c.name === "a:close") d += "Z ";
    }
    if (d) out.push({ d, fill: p.attrs.fill !== "none", stroke: p.attrs.stroke !== "false" && p.attrs.stroke !== "0" });
  }
  return out;
}

// ─── Text ────────────────────────────────────────────────────────

/** Paragraph and run settings for one level, merged down the chain. */
interface Lvl { pPr: Record<string, string>; rPr: Record<string, string>; color?: Rgba; font?: string; bu?: { char?: string; font?: string; none?: boolean; auto?: boolean; color?: Rgba }; lnPct?: number; lnPts?: number; bef?: number; aft?: number }
function readLvl(n: XNode | undefined, ctx: Ctx, into: Lvl): Lvl {
  if (!n) return into;
  const out: Lvl = { ...into, pPr: { ...into.pPr, ...n.attrs }, rPr: { ...into.rPr }, bu: into.bu ? { ...into.bu } : undefined };
  for (const k of n.kids) {
    if (k.name === "a:lnSpc") { const p = kid(k, "a:spcPct"), q = kid(k, "a:spcPts"); out.lnPct = p ? num(p.attrs.val) / 100000 : undefined; out.lnPts = q ? num(q.attrs.val) / 100 : undefined; }
    else if (k.name === "a:spcBef") { const q = kid(k, "a:spcPts"); if (q) out.bef = num(q.attrs.val) / 100; }
    else if (k.name === "a:spcAft") { const q = kid(k, "a:spcPts"); if (q) out.aft = num(q.attrs.val) / 100; }
    else if (k.name === "a:buNone") out.bu = { none: true };
    else if (k.name === "a:buChar") out.bu = { ...(out.bu ?? {}), char: k.attrs.char, none: false, auto: false };
    else if (k.name === "a:buAutoNum") out.bu = { ...(out.bu ?? {}), auto: true, none: false };
    else if (k.name === "a:buFont") out.bu = { ...(out.bu ?? {}), font: k.attrs.typeface };
    else if (k.name === "a:buClr") out.bu = { ...(out.bu ?? {}), color: colorIn(k, ctx) ?? undefined };
    else if (k.name === "a:defRPr") Object.assign(out, readRun(k, ctx, out));
  }
  return out;
}
function readRun(r: XNode | undefined, ctx: Ctx, into: Lvl): Pick<Lvl, "rPr" | "color" | "font"> {
  if (!r) return { rPr: into.rPr, color: into.color, font: into.font };
  const fill = kid(r, "a:solidFill");
  const latin = kid(r, "a:latin")?.attrs.typeface;
  return { rPr: { ...into.rPr, ...r.attrs }, color: fill ? colorIn(fill, ctx) ?? into.color : into.color, font: latin || into.font };
}
const WING: Record<string, string> = { "§": "▪", "Ø": "➢", q: "❑", v: "❖", "ü": "✓", l: "●", n: "■", u: "◆", "Ÿ": "•", "": "▪" };
const fontOf = (f: string | undefined, ctx: Ctx) => (!f ? ctx.fonts.minor : f.startsWith("+mj") ? ctx.fonts.major : f.startsWith("+mn") ? ctx.fonts.minor : f);
/** CSS for a font name as PowerPoint names it ("Lato Bold" is Lato at 700). */
function fontCss(name: string, ctx: Ctx, bold: boolean): string {
  let f = fam(name), w = bold ? 700 : 400;
  const m = /^(.*?)\s+(Bold|Semibold|SemiBold|Light|Medium|Black|ExtraBold|Thin)(\s+Bold)?$/i.exec(f);
  if (m) { f = m[1]; const t = m[2].toLowerCase(); w = t === "light" ? 300 : t === "thin" ? 200 : t === "medium" ? 500 : t === "semibold" ? 600 : t === "extrabold" || t === "black" ? 800 : 700; if (m[3] || bold) w = Math.max(w, 700); }
  ctx.used.add(f);
  return `font-family:'${f}',${FALLBACK[f.toLowerCase()] ?? ""}Arial,Helvetica,sans-serif;font-weight:${w};`;
}
const FALLBACK: Record<string, string> = { calibri: "'Carlito',", cambria: "'Caladea',", arial: "'Arimo',", helvetica: "'Arimo',", "times new roman": "'Tinos',", "courier new": "'Cousine'," };

interface TextSrc { body: XNode; chain: Array<XNode | undefined>; bodyPrs: Array<XNode | undefined>; slideNo: number }
function textHtml(t: TextSrc, ctx: Ctx, base: Lvl): string {
  const bp: Record<string, string> = {};
  for (const b of t.bodyPrs) if (b) Object.assign(bp, b.attrs);
  const ins = (k: string, d: number) => num(bp[k], d) / PX;
  const anchor = bp.anchor === "ctr" ? "center" : bp.anchor === "b" ? "flex-end" : "flex-start";
  const lvlOf = (i: number) => {
    let l = base;
    for (const ls of t.chain) l = readLvl(kid(ls, `a:lvl${i + 1}pPr`), ctx, l);
    return l;
  };
  const paras = kids(t.body, "a:p").map((p) => {
    const pPr = kid(p, "a:pPr");
    const lv = num(pPr?.attrs.lvl, 0);
    const L = readLvl(pPr, ctx, lvlOf(lv));
    const runs = p.kids.filter((k) => k.name === "a:r" || k.name === "a:fld" || k.name === "a:br");
    const end = kid(p, "a:endParaRPr");
    const endR = readRun(end, ctx, L);
    const sizeOf = (r: Record<string, string>) => num(r.sz, 1800) / 100;
    const pt = runs.length ? sizeOf(readRun(kid(runs[0], "a:rPr"), ctx, L).rPr) : sizeOf(endR.rPr);
    const lineH = L.lnPts ? `${(L.lnPts * 4 / 3).toFixed(1)}px` : `${((L.lnPct ?? 1) * 1.2).toFixed(3)}`;
    const algn = L.pPr.algn === "ctr" ? "center" : L.pPr.algn === "r" ? "right" : L.pPr.algn === "just" ? "justify" : "left";
    const marL = num(L.pPr.marL) / PX, indent = num(L.pPr.indent) / PX;
    const html = runs.map((r) => {
      if (r.name === "a:br") return "<br/>";
      const R = readRun(kid(r, "a:rPr"), ctx, L);
      const text = r.name === "a:fld" && r.attrs.type === "slidenum" ? String(t.slideNo) : kid(r, "a:t")?.text ?? "";
      const bold = R.rPr.b === "1";
      const c = R.color ?? { r: 0, g: 0, b: 0, a: 1 };
      const caps = R.rPr.cap === "all" ? "text-transform:uppercase;" : R.rPr.cap === "small" ? "font-variant:small-caps;" : "";
      const spc = R.rPr.spc ? `letter-spacing:${(num(R.rPr.spc) / 100 * 4 / 3).toFixed(2)}px;` : "";
      return `<span style="${fontCss(fontOf(R.font, ctx), ctx, bold)}font-size:${(sizeOf(R.rPr) * 4 / 3).toFixed(2)}px;color:${css(c)};${R.rPr.i === "1" ? "font-style:italic;" : ""}${R.rPr.u && R.rPr.u !== "none" ? "text-decoration:underline;" : ""}${caps}${spc}">${esc(text)}</span>`;
    }).join("");
    const hasText = runs.some((r) => r.name !== "a:br" && (kid(r, "a:t")?.text ?? "") !== "");
    let bullet = "";
    if (hasText && L.bu && !L.bu.none && (L.bu.char || L.bu.auto)) {
      const ch = L.bu.auto ? "•" : /wingdings|symbol/i.test(L.bu.font ?? "") ? WING[L.bu.char ?? ""] ?? "•" : L.bu.char ?? "•";
      const bc = L.bu.color ?? L.color ?? { r: 0, g: 0, b: 0, a: 1 };
      bullet = `<span style="display:inline-block;width:${Math.max(0, -indent).toFixed(1)}px;margin-left:${indent.toFixed(1)}px;color:${css(bc)};font-size:${(pt * 4 / 3).toFixed(1)}px">${esc(ch)}</span>`;
    }
    const indentCss = bullet ? "" : `text-indent:${indent.toFixed(1)}px;`;
    const empty = !hasText ? `<span style="font-size:${(pt * 4 / 3).toFixed(1)}px">&#8203;</span>` : "";
    return `<div style="margin:${((L.bef ?? 0) * 4 / 3).toFixed(1)}px 0 ${((L.aft ?? 0) * 4 / 3).toFixed(1)}px ${marL.toFixed(1)}px;${indentCss}text-align:${algn};line-height:${lineH};overflow-wrap:break-word">${bullet}${html}${empty}</div>`;
  }).join("");
  return `<div style="position:absolute;inset:0;padding:${ins("tIns", 45720).toFixed(1)}px ${ins("rIns", 91440).toFixed(1)}px ${ins("bIns", 45720).toFixed(1)}px ${ins("lIns", 91440).toFixed(1)}px;display:flex;flex-direction:column;justify-content:${anchor};${bp.wrap === "none" ? "white-space:nowrap;" : ""}">${paras}</div>`;
}

// ─── Parts ───────────────────────────────────────────────────────

interface Part { doc: XNode; rels: Map<string, string>; path: string }
async function readPart(zip: JSZip, path: string): Promise<Part | null> {
  const f = zip.file(path);
  if (!f) return null;
  const doc = parseXml(await f.async("string"));
  const rels = new Map<string, string>();
  const rf = zip.file(relsPath(path));
  if (rf) for (const r of kids(kid(parseXml(await rf.async("string")), "Relationships"), "Relationship")) if (r.attrs.TargetMode !== "External") rels.set(r.attrs.Id, resolve(path, r.attrs.Target ?? ""));
  return { doc, rels, path };
}
const tree = (doc: XNode) => {
  const find = (n: XNode): XNode | undefined => { for (const k of n.kids) { if (k.name === "p:spTree") return k; const d = find(k); if (d) return d; } return undefined; };
  return find(doc);
};
const phOf = (s: XNode) => kid(kid(kid(s, "p:nvSpPr") ?? kid(s, "p:nvPicPr") ?? kid(s, "p:nvGraphicFramePr"), "p:nvPr"), "p:ph");
const phType = (ph: XNode) => ph.attrs.type ?? "obj";
const sameKind = (a: string, b: string) => a === b || (["title", "ctrTitle"].includes(a) && ["title", "ctrTitle"].includes(b)) || (["body", "obj", "subTitle"].includes(a) && ["body", "obj", "subTitle"].includes(b));

interface Level { part: Part; phs: Array<{ ph: XNode; shape: XNode }> }
const levelOf = (part: Part): Level => ({ part, phs: (tree(part.doc)?.kids ?? []).filter((s) => phOf(s)).map((shape) => ({ ph: phOf(shape)!, shape })) });
/** The layout's (then the master's) box that a slide's placeholder fills. */
function inherit(ph: XNode, lvl: Level): XNode | undefined {
  const t = phType(ph), idx = ph.attrs.idx;
  return (idx != null ? lvl.phs.find((x) => x.ph.attrs.idx === idx && sameKind(phType(x.ph), t)) ?? lvl.phs.find((x) => x.ph.attrs.idx === idx) : undefined)?.shape
    ?? lvl.phs.find((x) => phType(x.ph) === t)?.shape ?? lvl.phs.find((x) => sameKind(phType(x.ph), t))?.shape;
}

// ─── The deck ────────────────────────────────────────────────────

export interface DeckView { w: number; h: number; slides: string[]; fonts: string[] }

/** Draw every slide of a PowerPoint file. `media` turns a picture inside
 *  the file into a URL the page can show. */
export async function renderDeck(data: ArrayBuffer | Uint8Array, media: (part: string, bytes: Uint8Array) => string): Promise<DeckView> {
  const zip = await JSZip.loadAsync(data);
  const pres = await readPart(zip, "ppt/presentation.xml");
  if (!pres) throw new Error("That file isn't a PowerPoint file.");
  const root = kid(pres.doc, "p:presentation");
  const sz = kid(root, "p:sldSz");
  const W = num(sz?.attrs.cx, 12192000) / PX, H = num(sz?.attrs.cy, 6858000) / PX;
  const defaultText = kid(root, "p:defaultTextStyle");
  const urls = new Map<string, Promise<string | null>>();
  const mediaUrl = (part: string) => {
    let u = urls.get(part);
    if (!u) { u = (async () => { const f = zip.file(part); return f ? media(part, await f.async("uint8array")) : null; })(); urls.set(part, u); }
    return u;
  };
  const used = new Set<string>();
  const cache = new Map<string, Promise<Part | null>>();
  const part = (p: string) => { let x = cache.get(p); if (!x) { x = readPart(zip, p); cache.set(p, x); } return x; };
  const slides: string[] = [];
  const ids = kids(kid(root, "p:sldIdLst"), "p:sldId");
  for (let si = 0; si < ids.length; si++) {
    const sp = pres.rels.get(ids[si].attrs["r:id"]);
    const slide = sp ? await part(sp) : null;
    if (!slide) { slides.push(""); continue; }
    const layoutPath = [...slide.rels.values()].find((p) => p.includes("slideLayouts/"));
    const layout = layoutPath ? await part(layoutPath) : null;
    const masterPath = layout ? [...layout.rels.values()].find((p) => p.includes("slideMasters/")) : undefined;
    const master = masterPath ? await part(masterPath) : null;
    const themePath = master ? [...master.rels.values()].find((p) => p.includes("theme/")) : undefined;
    const themeDoc = themePath ? (await part(themePath))?.doc : undefined;
    const theme: Record<string, string> = {};
    const findIn = (n: XNode | undefined, name: string): XNode | undefined => { if (!n) return undefined; for (const k of n.kids) { if (k.name === name) return k; const d = findIn(k, name); if (d) return d; } return undefined; };
    for (const c of findIn(themeDoc, "a:clrScheme")?.kids ?? []) { const v = kid(c, "a:srgbClr")?.attrs.val ?? kid(c, "a:sysClr")?.attrs.lastClr; if (v) theme[c.name.replace(/^a:/, "")] = v; }
    const fs = findIn(themeDoc, "a:fontScheme");
    const fonts = { major: kid(kid(fs, "a:majorFont"), "a:latin")?.attrs.typeface || "Calibri", minor: kid(kid(fs, "a:minorFont"), "a:latin")?.attrs.typeface || "Calibri" };
    const mRoot = master?.doc.kids.find((k) => k.name === "p:sldMaster");
    const map = { ...(kid(mRoot, "p:clrMap")?.attrs ?? { bg1: "lt1", tx1: "dk1", bg2: "lt2", tx2: "dk2" }) };
    const ctx: Ctx = { zip, theme, map, fonts, media: mediaUrl, used };
    const txStyles = kid(mRoot, "p:txStyles");
    const mLvl = master ? levelOf(master) : null, lLvl = layout ? levelOf(layout) : null;
    const showMaster = layout?.doc.kids.find((k) => k.name === "p:sldLayout")?.attrs.showMasterSp !== "0";

    const out: string[] = [];
    // Background: the slide's, the layout's or the master's.
    const bgOf = (p: Part | null) => kid(kid(kid(p?.doc.kids[0], "p:cSld"), "p:bg"), "p:bgPr") ?? kid(kid(p?.doc.kids[0], "p:cSld"), "p:bg");
    const bgNode = [slide, layout, master].map((p) => bgOf(p)).find(Boolean);
    let bg = "#ffffff";
    if (bgNode?.name === "p:bgPr") { const pnt = paintOf(bgNode, ctx); if (pnt?.kind === "solid") bg = css(pnt.c); else if (pnt?.kind === "pic") { const u = await mediaUrl(pnt.part); if (u) out.push(`<img alt="" src="${esc(u)}" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover"/>`); } }
    else if (bgNode?.name === "p:bg") { const ref = kid(bgNode, "p:bgRef"); const c = colorIn(ref, ctx); if (c) bg = css(c); }

    const draw = async (s: XNode, owner: Part, level: "master" | "layout" | "slide", grp?: Paint): Promise<string> => {
      const ph = phOf(s);
      // A layout's (or master's) own boxes show only on the slides that fill them.
      if (ph && level !== "slide") return "";
      const style = kid(s, "p:style");
      if (s.name === "p:grpSp") {
        const xf = kid(kid(s, "p:grpSpPr"), "a:xfrm");
        const b = boxOf(xf);
        if (!b) return "";
        const ch = kid(xf, "a:chOff"), ce = kid(xf, "a:chExt");
        const cx = num(ch?.attrs.x) / PX, cy = num(ch?.attrs.y) / PX, cw = num(ce?.attrs.cx) / PX || b.w, chh = num(ce?.attrs.cy) / PX || b.h;
        const gp = paintOf(kid(s, "p:grpSpPr"), ctx, undefined, owner.rels, grp) ?? grp;
        const inner = (await Promise.all(s.kids.filter((k) => ["p:sp", "p:pic", "p:grpSp", "p:cxnSp", "p:graphicFrame"].includes(k.name)).map((k) => draw(k, owner, level, gp)))).join("");
        return `<div style="${place(b)}"><div style="position:absolute;left:0;top:0;width:${cw}px;height:${chh}px;transform-origin:0 0;transform:scale(${(b.w / cw).toFixed(5)},${(b.h / chh).toFixed(5)}) translate(${-cx}px,${-cy}px)">${inner}</div></div>`;
      }
      // Where it sits: its own box, else the layout's, else the master's.
      const base: Array<XNode | undefined> = ph ? [lLvl ? inherit(ph, lLvl) : undefined, mLvl ? inherit(ph, mLvl) : undefined] : [];
      const xf = kid(kid(s, "p:spPr") ?? kid(s, "p:nvGraphicFramePr"), "a:xfrm") ?? kid(s, "p:xfrm") ?? base.map((b) => kid(kid(b, "p:spPr"), "a:xfrm")).find(Boolean);
      const b = boxOf(xf);
      if (!b) return "";
      if (s.name === "p:pic") {
        const blip = kid(kid(s, "p:blipFill"), "a:blip");
        const id = blip?.attrs["r:embed"];
        const target = id ? owner.rels.get(id) : undefined;
        const u = target ? await mediaUrl(target) : null;
        if (!u) return "";
        const src = kid(kid(s, "p:blipFill"), "a:srcRect");
        const l = num(src?.attrs.l) / 100000, t = num(src?.attrs.t) / 100000, r = num(src?.attrs.r) / 100000, bt = num(src?.attrs.b) / 100000;
        const iw = b.w / Math.max(0.01, 1 - l - r), ih = b.h / Math.max(0.01, 1 - t - bt);
        const op = kid(blip, "a:alphaModFix") ? num(kid(blip, "a:alphaModFix")!.attrs.amt, 100000) / 100000 : 1;
        return `<div style="${place(b, `overflow:hidden;${op < 1 ? `opacity:${op};` : ""}`)}"><img alt="" src="${esc(u)}" style="position:absolute;max-width:none;left:${(-l * iw).toFixed(2)}px;top:${(-t * ih).toFixed(2)}px;width:${iw.toFixed(2)}px;height:${ih.toFixed(2)}px"/></div>`;
      }
      if (s.name === "p:graphicFrame") {
        const tbl = (() => { const f = (n: XNode): XNode | undefined => { for (const k of n.kids) { if (k.name === "a:tbl") return k; const d = f(k); if (d) return d; } return undefined; }; return f(s); })();
        return tbl ? tableHtml(tbl, b, ctx, defaultText, si + 1) : "";
      }
      // A shape: its outline and fill, then its words.
      const spPr = kid(s, "p:spPr");
      const fill = paintOf(spPr, ctx, style, owner.rels, grp);
      const line = lineOf(spPr, ctx, style);
      let svg = "";
      const geom = kid(spPr, "a:custGeom"), prst = kid(spPr, "a:prstGeom");
      if ((fill && fill.kind !== "none") || line) {
        const defs: string[] = [];
        const pic = fill?.kind === "pic" ? await mediaUrl(fill.part) : null;
        const f = svgPaint(fill, defs, pic);
        const stroke = line ? `stroke="${css(line.c)}" stroke-width="${line.w.toFixed(2)}"` : 'stroke="none"';
        const paths = geom ? customPaths(geom, b.w, b.h) : [{ d: presetPath(prst?.attrs.prst ?? "rect", b.w, b.h, Object.fromEntries(kids(kid(prst, "a:avLst"), "a:gd").map((g) => [g.attrs.name, num(/val\s+(-?\d+)/.exec(g.attrs.fmla ?? "")?.[1])]))), fill: !["line", "straightConnector1"].includes(prst?.attrs.prst ?? ""), stroke: true }];
        svg = `<svg width="${b.w.toFixed(2)}" height="${b.h.toFixed(2)}" style="position:absolute;left:0;top:0;overflow:visible">${defs.length ? `<defs>${defs.join("")}</defs>` : ""}${paths.map((p) => `<path d="${p.d}" fill="${p.fill ? f : "none"}" ${p.stroke ? stroke : 'stroke="none"'}/>`).join("")}</svg>`;
      }
      const body = kid(s, "p:txBody");
      let text = "";
      if (body && kids(body, "a:p").some((p) => p.kids.some((k) => k.name === "a:r" || k.name === "a:fld"))) {
        const t = ph ? phType(ph) : "";
        const styleKey = !ph ? null : ["title", "ctrTitle"].includes(t) ? "p:titleStyle" : ["body", "obj", "subTitle"].includes(t) ? "p:bodyStyle" : "p:otherStyle";
        const chain = [styleKey ? kid(txStyles, styleKey) : defaultText, ...base.slice().reverse().map((x) => kid(kid(x, "p:txBody"), "a:lstStyle")), kid(body, "a:lstStyle")];
        const bodyPrs = [...base.slice().reverse().map((x) => kid(kid(x, "p:txBody"), "a:bodyPr")), kid(body, "a:bodyPr")];
        const fontRef = kid(style, "a:fontRef");
        const baseLvl: Lvl = { pPr: {}, rPr: {}, color: colorIn(fontRef, ctx) ?? (theme[map.tx1 ?? "dk1"] ? hexRgb(theme[map.tx1 ?? "dk1"]) : undefined), font: fontRef?.attrs.idx === "major" ? fonts.major : fonts.minor };
        text = textHtml({ body, chain, bodyPrs, slideNo: si + 1 }, ctx, baseLvl);
      }
      return svg || text ? `<div style="${place(b)}">${svg}${text}</div>` : "";
    };

    const shapesOf = (p: Part | null) => (tree(p?.doc ?? { name: "", attrs: {}, kids: [], text: "" })?.kids ?? []).filter((k) => ["p:sp", "p:pic", "p:grpSp", "p:cxnSp", "p:graphicFrame"].includes(k.name));
    if (master && showMaster) for (const s of shapesOf(master)) out.push(await draw(s, master, "master"));
    if (layout) for (const s of shapesOf(layout)) out.push(await draw(s, layout, "layout"));
    for (const s of shapesOf(slide)) out.push(await draw(s, slide, "slide"));
    slides.push(`<div style="position:relative;width:${W}px;height:${H}px;overflow:hidden;background:${bg}">${out.join("")}</div>`);
  }
  return { w: W, h: H, slides, fonts: [...used] };
}

/** A table, row by row: fills, rules, margins and merged cells as written. */
function tableHtml(tbl: XNode, b: Box, ctx: Ctx, defaultText: XNode | undefined, slideNo: number): string {
  const cols = kids(kid(tbl, "a:tblGrid"), "a:gridCol").map((c) => num(c.attrs.w) / PX);
  const rows = kids(tbl, "a:tr");
  let rowNo = -1;
  const body = rows.map((tr, ri) => {
    if (ri > 0) rowNo++;
    const cells = kids(tr, "a:tc").filter((tc) => tc.attrs.vMerge !== "1" && tc.attrs.hMerge !== "1").map((tc) => {
      const pr = kid(tc, "a:tcPr");
      const fill = paintOf(pr, ctx);
      const rule = (side: string) => { const l = kid(pr, side); if (!l || kid(l, "a:noFill")) return "none"; const c = colorIn(kid(l, "a:solidFill"), ctx); return c ? `${Math.max(1, num(l.attrs.w, 12700) / PX).toFixed(2)}px solid ${css(c)}` : "none"; };
      const pad = (k: string, d: number) => (num(pr?.attrs[k], d) / PX).toFixed(1);
      const txt = kid(tc, "a:txBody");
      const inner = txt ? textHtml({ body: txt, chain: [defaultText, kid(txt, "a:lstStyle")], bodyPrs: [], slideNo }, ctx, { pPr: {}, rPr: {}, color: { r: 0, g: 0, b: 0, a: 1 }, font: ctx.fonts.minor }).replace(/^<div style="position:absolute;inset:0;padding:[^"]*"/, '<div style="display:flex;flex-direction:column"') : "";
      return `<td${tc.attrs.rowSpan ? ` rowspan="${num(tc.attrs.rowSpan, 1)}"` : ""}${tc.attrs.gridSpan ? ` colspan="${num(tc.attrs.gridSpan, 1)}"` : ""} style="vertical-align:${pr?.attrs.anchor === "ctr" ? "middle" : pr?.attrs.anchor === "b" ? "bottom" : "top"};padding:${pad("marT", 45720)}px ${pad("marR", 91440)}px ${pad("marB", 45720)}px ${pad("marL", 91440)}px;background:${fill?.kind === "solid" ? css(fill.c) : "transparent"};border-top:${rule("a:lnT")};border-bottom:${rule("a:lnB")};border-left:${rule("a:lnL")};border-right:${rule("a:lnR")}">${inner}</td>`;
    }).join("");
    return `<tr${ri > 0 ? ` data-row="${rowNo}"` : ""} style="height:${(num(tr.attrs.h) / PX).toFixed(1)}px">${cells}</tr>`;
  }).join("");
  return `<div style="${place({ ...b, h: b.h })}"><table style="border-collapse:collapse;table-layout:fixed;width:${cols.reduce((a, c) => a + c, 0).toFixed(1)}px"><colgroup>${cols.map((c) => `<col style="width:${c.toFixed(1)}px"/>`).join("")}</colgroup><tbody>${body}</tbody></table></div>`;
}

/** Load the slides' fonts from Google Fonts when they're there (Lato,
 *  League Spartan, Carlito for Calibri...). Others fall back to Arial. */
export function loadDeckFonts(names: string[]) {
  if (typeof document === "undefined") return;
  const want = [...new Set([...names, ...names.map((n) => FALLBACK[n.toLowerCase()]?.replace(/['",]/g, "")).filter(Boolean) as string[]])]
    .filter((n) => /^[\w \-]+$/.test(n) && !/^(Arial|Helvetica|Calibri|Cambria|Times New Roman|Courier New|Segoe UI)$/i.test(n));
  for (const n of want) {
    const id = `deck-font-${n.replace(/\s+/g, "-").toLowerCase()}`;
    if (document.getElementById(id)) continue;
    const l = document.createElement("link");
    l.id = id; l.rel = "stylesheet";
    l.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(n).replace(/%20/g, "+")}:wght@300;400;500;600;700;800&display=swap`;
    document.head.appendChild(l);
  }
}
