"use client";

// PdfRevisionDiff — client-side rasterized TRUE-OVERLAY diff between two PDF
// revisions. Both pages are rendered onto an IDENTICAL pixel grid, REGISTERED
// (scale + translation), then every pixel is classified:
//
//   grey  = ink in BOTH revisions   (unchanged — the overlays fuse)
//   red   = ink only in the BASE    (removed)
//   green = ink only in the COMPARE (added)
//   white = paper
//
// Registration is the whole game. Two revisions of the same sheet almost never
// rasterize on the same pixels — replots move the margins, page boxes change,
// a letter print vs a full-size plot differ in scale — and without correction
// every unchanged line paints twice (once red, once green) instead of fusing
// to grey. Defenses, in order:
//
//   1. COMMON GRID — both pages render onto one canvas size (stretch-normalized
//      when their aspect ratios match, fit-centered otherwise).
//   2. PROFILE REGISTRATION — ink projection profiles (per-column / per-row ink
//      counts) are matched by normalized cross-correlation over a scale range
//      of 90–110% and shifts up to ±12% of the sheet, independently per axis.
//      The base layer is then WARPED (scaled + shifted) onto the compare grid.
//      Projection profiles keep their structure even on dense E-size linework,
//      so this stays robust where 2-D mask search saturates. Applied only when
//      it clearly beats the identity — a real layout change is never
//      "registered away".
//   3. ANTI-ALIAS TOLERANCE — ink with counterpart ink within N px (default 1)
//      counts as unchanged, so hairline rendering fringes don't read as
//      changes. Adjustable: Strict (0) / Normal (1) / Lenient (2).
//
// The view opens FIT-TO-SCREEN (whole sheet visible), with zoom/pan/ctrl-scroll
// for detail. Strictly PDF only — a rasterized overlay, not a vector CAD
// differ. Single page at a time with paging nav.

import React, { useEffect, useRef, useState, useCallback } from "react";
import { Loader2, AlertTriangle, ChevronLeft, ChevronRight, ZoomIn, ZoomOut, Hand, MousePointer2, Crosshair, Eye, Maximize } from "lucide-react";
import { pdfjs } from "react-pdf";
import { useViewerPanZoom } from "@/lib/useViewerPanZoom";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";

// Match the worker config FullScreenViewer uses (idempotent).
pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";

export interface PdfRevisionDiffProps {
  baseUrl: string;
  baseLabel: string;
  compareUrl: string;
  compareLabel: string;
  /** 1-indexed page number. Defaults to 1. */
  page?: number;
  /** Rasterization DPI. 100 is a good default; 150 is sharper but slower. */
  dpi?: number;
}

type DiffStats = { addedPixels: number; removedPixels: number; unchangedPixels: number; totalInkPixels: number };
/** Base→grid transform: x' = sx·x + dx, y' = sy·y + dy. */
type Registration = { sx: number; sy: number; dx: number; dy: number };

const INK_THRESHOLD = 200;      // avg channel below this = ink (not paper)
const MAX_PIXELS = 12_000_000;  // raster cap (E-size @100dpi ≈ 8M)

// ── Rendering ────────────────────────────────────────────────────────────────

async function loadPdf(url: string) {
  return pdfjs.getDocument(url).promise;
}

/** Render page `n` of `url` onto a WxH white canvas. `stretch` fills the grid
 *  exactly (proportional registration for same-aspect sheets); otherwise the
 *  render is fit-centered with white padding. */
async function renderNormalized(url: string, n: number, W: number, H: number, stretch: boolean):
  Promise<{ canvas: HTMLCanvasElement; pageCount: number }> {
  const pdf = await loadPdf(url);
  const clamped = Math.max(1, Math.min(n, pdf.numPages));
  const pdfPage = await pdf.getPage(clamped);
  const v1 = pdfPage.getViewport({ scale: 1 });
  const scale = Math.min(W / v1.width, H / v1.height);
  const viewport = pdfPage.getViewport({ scale });
  const raw = document.createElement("canvas");
  raw.width = Math.max(1, Math.ceil(viewport.width));
  raw.height = Math.max(1, Math.ceil(viewport.height));
  const rawCtx = raw.getContext("2d", { willReadFrequently: true });
  if (!rawCtx) throw new Error("2D canvas context unavailable");
  await pdfPage.render({ canvasContext: rawCtx, viewport, canvas: raw } as Parameters<typeof pdfPage.render>[0]).promise;

  const out = document.createElement("canvas");
  out.width = W; out.height = H;
  const ctx = out.getContext("2d", { willReadFrequently: true })!;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, W, H);
  if (stretch) {
    ctx.drawImage(raw, 0, 0, W, H);
  } else {
    ctx.drawImage(raw, Math.floor((W - raw.width) / 2), Math.floor((H - raw.height) / 2));
  }
  return { canvas: out, pageCount: pdf.numPages };
}

async function probe(url: string, n: number): Promise<{ w: number; h: number; pageCount: number }> {
  const pdf = await loadPdf(url);
  const clamped = Math.max(1, Math.min(n, pdf.numPages));
  const p = await pdf.getPage(clamped);
  const v = p.getViewport({ scale: 1 });
  return { w: v.width, h: v.height, pageCount: pdf.numPages };
}

/** Warp a rendered page by an axis-aligned transform onto a fresh white canvas.
 *  Canvas-level warp (not mask-level) so anti-aliasing stays smooth. */
function warpCanvas(src: HTMLCanvasElement, W: number, H: number, reg: Registration): HTMLCanvasElement {
  const out = document.createElement("canvas");
  out.width = W; out.height = H;
  const ctx = out.getContext("2d", { willReadFrequently: true })!;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, W, H);
  ctx.setTransform(reg.sx, 0, 0, reg.sy, reg.dx, reg.dy);
  ctx.drawImage(src, 0, 0);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  return out;
}

// ── Masks ────────────────────────────────────────────────────────────────────

function toInkMask(canvas: HTMLCanvasElement): Uint8Array {
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const m = new Uint8Array(width * height);
  for (let p = 0, i = 0; p < m.length; p++, i += 4) {
    if (data[i + 3] >= 32 && (data[i] + data[i + 1] + data[i + 2]) / 3 < INK_THRESHOLD) m[p] = 1;
  }
  return m;
}

/** Separable binary dilation by `r` pixels (r passes of 3x3). r=0 returns input. */
function dilate(mask: Uint8Array, W: number, H: number, r: number): Uint8Array {
  if (r <= 0) return mask;
  let cur = mask;
  for (let pass = 0; pass < r; pass++) {
    const hx = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
      const row = y * W;
      for (let x = 0; x < W; x++) {
        const i = row + x;
        if (cur[i] || (x > 0 && cur[i - 1]) || (x < W - 1 && cur[i + 1])) hx[i] = 1;
      }
    }
    const vy = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
      const row = y * W;
      for (let x = 0; x < W; x++) {
        const i = row + x;
        if (hx[i] || (y > 0 && hx[i - W]) || (y < H - 1 && hx[i + W])) vy[i] = 1;
      }
    }
    cur = vy;
  }
  return cur;
}

// ── Profile registration ─────────────────────────────────────────────────────

/** Ink projection profiles: per-column and per-row ink counts, box-smoothed. */
function profiles(mask: Uint8Array, W: number, H: number): { col: Float32Array; row: Float32Array } {
  const col = new Float32Array(W);
  const row = new Float32Array(H);
  for (let y = 0; y < H; y++) {
    const base = y * W;
    for (let x = 0; x < W; x++) {
      if (mask[base + x]) { col[x]++; row[y]++; }
    }
  }
  return { col: smooth(col), row: smooth(row) };
}

function smooth(p: Float32Array): Float32Array {
  const out = new Float32Array(p.length);
  for (let i = 0; i < p.length; i++) {
    let s = 0, n = 0;
    for (let k = -2; k <= 2; k++) {
      const j = i + k;
      if (j >= 0 && j < p.length) { s += p[j]; n++; }
    }
    out[i] = s / n;
  }
  return out;
}

/** Normalized cross-correlation of base profile pA (warped by x→s·x+d) against
 *  pB over their overlap. Returns -1 when the overlap is degenerate. */
function nccAt(pA: Float32Array, pB: Float32Array, s: number, d: number): number {
  const N = pB.length;
  const x0 = Math.max(0, Math.ceil(d));
  const x1 = Math.min(N, Math.floor(pA.length * s + d));
  if (x1 - x0 < N * 0.5) return -1; // require half-sheet overlap
  let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0, n = 0;
  for (let x = x0; x < x1; x += 2) {
    const src = (x - d) / s;
    const i0 = src | 0;
    const f = src - i0;
    const a = i0 + 1 < pA.length ? pA[i0] * (1 - f) + pA[i0 + 1] * f : pA[i0];
    const b = pB[x];
    sa += a; sb += b; saa += a * a; sbb += b * b; sab += a * b; n++;
  }
  if (n < 8) return -1;
  const cov = sab - (sa * sb) / n;
  const va = saa - (sa * sa) / n;
  const vb = sbb - (sb * sb) / n;
  if (va <= 0 || vb <= 0) return -1;
  return cov / Math.sqrt(va * vb);
}

/** Find the best (scale, shift) for one axis by NCC over profiles: scale
 *  0.90–1.10, shift up to ±12% of the axis. Coarse shift scan (step 4), then a
 *  ±4 fine pass at the winning scale. */
function registerAxis(pA: Float32Array, pB: Float32Array): { s: number; d: number; ncc: number; zero: number } {
  const N = pB.length;
  const maxShift = Math.round(N * 0.12);
  const zero = nccAt(pA, pB, 1, 0);
  let best = { s: 1, d: 0, ncc: zero };
  for (let si = -20; si <= 20; si++) {
    const s = 1 + si * 0.005; // 0.90 … 1.10
    for (let d = -maxShift; d <= maxShift; d += 4) {
      const v = nccAt(pA, pB, s, d);
      if (v > best.ncc) best = { s, d, ncc: v };
    }
  }
  for (let d = best.d - 4; d <= best.d + 4; d++) {
    const v = nccAt(pA, pB, best.s, d);
    if (v > best.ncc) best = { s: best.s, d, ncc: v };
  }
  return { ...best, zero };
}

/** Full registration: independent per-axis scale+shift from projection
 *  profiles. Returns identity unless the match clearly beats no-transform. */
function findRegistration(A: Uint8Array, B: Uint8Array, W: number, H: number): Registration {
  const pa = profiles(A, W, H);
  const pb = profiles(B, W, H);
  const rx = registerAxis(pa.col, pb.col);
  const ry = registerAxis(pa.row, pb.row);
  const sx = rx.ncc > rx.zero + 0.01 ? rx.s : 1;
  const dx = rx.ncc > rx.zero + 0.01 ? rx.d : 0;
  const sy = ry.ncc > ry.zero + 0.01 ? ry.s : 1;
  const dy = ry.ncc > ry.zero + 0.01 ? ry.d : 0;
  return { sx, sy, dx, dy };
}

const isIdentity = (r: Registration) => r.sx === 1 && r.sy === 1 && r.dx === 0 && r.dy === 0;

// ── Classification + paint ───────────────────────────────────────────────────

// Class codes: 0 paper, 1 unchanged, 2 removed (base only), 3 added (compare only)
function classify(A: Uint8Array, B: Uint8Array, W: number, H: number, tolerance: number):
  { classes: Uint8Array; stats: DiffStats } {
  const dilA = dilate(A, W, H, tolerance);
  const dilB = dilate(B, W, H, tolerance);
  const classes = new Uint8Array(W * H);
  let added = 0, removed = 0, unchanged = 0;
  for (let i = 0; i < classes.length; i++) {
    const a = A[i], b = B[i];
    if (a) {
      if (b || dilB[i]) { classes[i] = 1; unchanged++; }
      else { classes[i] = 2; removed++; }
    } else if (b) {
      if (dilA[i]) { classes[i] = 1; unchanged++; }
      else { classes[i] = 3; added++; }
    }
  }
  return { classes, stats: { addedPixels: added, removedPixels: removed, unchangedPixels: unchanged, totalInkPixels: added + removed + unchanged } };
}

const COLOR_UNCHANGED: [number, number, number] = [163, 163, 163]; // grey — same ink in both
const COLOR_UNCHANGED_FADED: [number, number, number] = [228, 228, 228];
const COLOR_REMOVED: [number, number, number] = [220, 38, 38];     // red — base only
const COLOR_ADDED: [number, number, number] = [21, 128, 61];       // green — compare only

function paint(ctx: CanvasRenderingContext2D, classes: Uint8Array, W: number, H: number, changesOnly: boolean) {
  const out = ctx.createImageData(W, H);
  const O = out.data;
  const grey = changesOnly ? COLOR_UNCHANGED_FADED : COLOR_UNCHANGED;
  for (let p = 0, i = 0; p < classes.length; p++, i += 4) {
    const c = classes[p];
    if (c === 0) { O[i] = 255; O[i + 1] = 255; O[i + 2] = 255; }
    else if (c === 1) { O[i] = grey[0]; O[i + 1] = grey[1]; O[i + 2] = grey[2]; }
    else if (c === 2) { O[i] = COLOR_REMOVED[0]; O[i + 1] = COLOR_REMOVED[1]; O[i + 2] = COLOR_REMOVED[2]; }
    else { O[i] = COLOR_ADDED[0]; O[i + 1] = COLOR_ADDED[1]; O[i + 2] = COLOR_ADDED[2]; }
    O[i + 3] = 255;
  }
  ctx.putImageData(out, 0, 0);
}

// ── Component ────────────────────────────────────────────────────────────────

interface RasterCache {
  key: string;
  W: number; H: number;
  pageCount: number;
  /** Kept only until the aligned mask is built, then released. */
  baseCanvas: HTMLCanvasElement | null;
  A0: Uint8Array;               // base mask, unregistered
  B: Uint8Array;                // compare mask
  reg: Registration | null;     // computed lazily on first auto-align
  alignedA: Uint8Array | null;  // base mask after warp
}

export default function PdfRevisionDiff({
  baseUrl, baseLabel, compareUrl, compareLabel,
  page = 1, dpi = 100,
}: PdfRevisionDiffProps) {
  const displayCanvasRef = useRef<HTMLCanvasElement>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<DiffStats | null>(null);
  const [zoom, setZoom] = useState(1);
  const [currentPage, setCurrentPage] = useState(page);
  const [pageCount, setPageCount] = useState(1);
  const [canvasSize, setCanvasSize] = useState({ w: 0, h: 0 });
  const [tolerance, setTolerance] = useState(1);        // 0 strict · 1 normal · 2 lenient
  const [autoAlign, setAutoAlign] = useState(true);
  const [changesOnly, setChangesOnly] = useState(false);
  const [regInfo, setRegInfo] = useState<Registration | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fittedKeyRef = useRef<string>("");
  const panZoom = useViewerPanZoom({
    containerRef: scrollRef,
    onZoom: (f) => setZoom((z) => Math.min(6, Math.max(0.05, Math.round(z * f * 1000) / 1000))),
  });

  const rasterRef = useRef<RasterCache | null>(null);
  const classesRef = useRef<{ classes: Uint8Array; W: number; H: number } | null>(null);

  /** Zoom so the whole sheet is visible in the scroll container. */
  const fitToScreen = useCallback((w?: number, h?: number) => {
    const el = scrollRef.current;
    const cw = w ?? rasterRef.current?.W ?? 0;
    const ch = h ?? rasterRef.current?.H ?? 0;
    if (!el || !cw || !ch) return;
    const z = Math.min((el.clientWidth - 32) / cw, (el.clientHeight - 32) / ch);
    setZoom(Math.max(0.05, Math.min(1.5, Math.round(z * 1000) / 1000)));
  }, []);

  const computeDiff = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const renderKey = `${baseUrl}|${compareUrl}|${currentPage}|${dpi}`;
      if (!rasterRef.current || rasterRef.current.key !== renderKey) {
        const [bi, ci] = await Promise.all([probe(baseUrl, currentPage), probe(compareUrl, currentPage)]);
        // One common grid. Stretch-normalize when the sheets share an aspect
        // ratio (same drawing at different print sizes still registers).
        const aspectClose = Math.abs(bi.w / bi.h - ci.w / ci.h) / Math.max(bi.w / bi.h, ci.w / ci.h) < 0.02;
        const naturalW = Math.max(bi.w, ci.w), naturalH = Math.max(bi.h, ci.h);
        let W = Math.round(naturalW * (dpi / 72)), H = Math.round(naturalH * (dpi / 72));
        if (W * H > MAX_PIXELS) {
          const f = Math.sqrt(MAX_PIXELS / (W * H));
          W = Math.max(1, Math.floor(W * f)); H = Math.max(1, Math.floor(H * f));
        }
        const [b, c] = await Promise.all([
          renderNormalized(baseUrl, currentPage, W, H, aspectClose),
          renderNormalized(compareUrl, currentPage, W, H, aspectClose),
        ]);
        rasterRef.current = {
          key: renderKey, W, H,
          pageCount: Math.min(b.pageCount, c.pageCount),
          baseCanvas: b.canvas,
          A0: toInkMask(b.canvas),
          B: toInkMask(c.canvas),
          reg: null,
          alignedA: null,
        };
        classesRef.current = null;
      }
      const m = rasterRef.current;
      setPageCount(m.pageCount);

      // Registration: estimate once per pair/page, warp the BASE onto the grid.
      let A = m.A0;
      let applied: Registration | null = null;
      if (autoAlign) {
        if (!m.reg) {
          m.reg = findRegistration(m.A0, m.B, m.W, m.H);
          if (!isIdentity(m.reg) && m.baseCanvas) {
            m.alignedA = toInkMask(warpCanvas(m.baseCanvas, m.W, m.H, m.reg));
          }
          m.baseCanvas = null; // release the big bitmap — masks are all we need now
        }
        if (!isIdentity(m.reg)) {
          A = m.alignedA ?? m.A0;
          applied = m.reg;
        }
      }
      setRegInfo(applied);

      const { classes, stats: st } = classify(A, m.B, m.W, m.H, tolerance);
      classesRef.current = { classes, W: m.W, H: m.H };

      const display = displayCanvasRef.current;
      if (!display) return;
      display.width = m.W;
      display.height = m.H;
      setCanvasSize({ w: m.W, h: m.H });
      paint(display.getContext("2d")!, classes, m.W, m.H, changesOnly);
      setStats(st);

      // First sight of a new pair/page → show the whole sheet.
      if (fittedKeyRef.current !== m.key) {
        fittedKeyRef.current = m.key;
        fitToScreen(m.W, m.H);
      }
    } catch (e) {
      setError((e as Error).message || "Diff failed");
    } finally {
      setLoading(false);
    }
    // changesOnly is intentionally NOT a dep — a toggle only repaints (below).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseUrl, compareUrl, currentPage, dpi, tolerance, autoAlign, fitToScreen]);

  useEffect(() => { void computeDiff(); }, [computeDiff]);

  // Changes-only is a pure recolor of the cached class map — no re-render.
  useEffect(() => {
    const cl = classesRef.current;
    const display = displayCanvasRef.current;
    if (!cl || !display || loading) return;
    paint(display.getContext("2d")!, cl.classes, cl.W, cl.H, changesOnly);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [changesOnly]);

  const pct = (n: number) => stats && stats.totalInkPixels > 0 ? ((n / stats.totalInkPixels) * 100).toFixed(1) : "0.0";

  const toggleBtn = (active: boolean) =>
    `px-2 py-1 rounded text-[11px] font-bold transition-colors ${active ? "bg-orange-500/20 text-orange-300" : "text-slate-400 hover:text-slate-200"}`;

  const regLabel = regInfo
    ? `registered ${regInfo.sx !== 1 || regInfo.sy !== 1 ? `${(regInfo.sx * 100).toFixed(1)}%/${(regInfo.sy * 100).toFixed(1)}% ` : ""}${regInfo.dx >= 0 ? "+" : ""}${Math.round(regInfo.dx)},${regInfo.dy >= 0 ? "+" : ""}${Math.round(regInfo.dy)}px`
    : null;

  return (
    <div className="flex flex-col h-full bg-slate-900 text-slate-100 select-none">
      {/* Header: legend + controls */}
      <div className="min-h-12 bg-slate-800 border-b border-slate-700 flex items-center justify-between gap-3 px-4 py-1.5 shrink-0 flex-wrap">
        <div className="flex items-center gap-3 text-xs">
          <span className="inline-flex items-center gap-1.5 text-slate-300">
            <span className="w-2.5 h-2.5 rounded-sm" style={{ background: `rgb(${COLOR_UNCHANGED.join(",")})` }} /> Unchanged
          </span>
          <span className="inline-flex items-center gap-1.5 text-red-300">
            <span className="w-2.5 h-2.5 rounded-sm bg-red-600" /> Removed · only in {baseLabel}
          </span>
          <span className="inline-flex items-center gap-1.5 text-emerald-300">
            <span className="w-2.5 h-2.5 rounded-sm bg-green-700" /> Added · only in {compareLabel}
          </span>
          {regLabel && (
            <span className="inline-flex items-center gap-1 text-[10px] text-sky-300" title="Registration warped the base layer (scale + shift) to line up with the compare layer before diffing">
              <Crosshair className="w-3 h-3" /> {regLabel}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2 text-xs flex-wrap">
          <button onClick={() => setChangesOnly((v) => !v)} className={toggleBtn(changesOnly)} title="Fade unchanged linework so changes pop">
            <Eye className="w-3.5 h-3.5 inline -mt-0.5 mr-1" />Changes only
          </button>
          <button onClick={() => setAutoAlign((v) => !v)} className={toggleBtn(autoAlign)} title="Register the two revisions (scale + shift from ink profiles) before diffing">
            <Crosshair className="w-3.5 h-3.5 inline -mt-0.5 mr-1" />Auto-align
          </button>
          <label className="flex items-center gap-1 text-[11px] text-slate-400">
            Precision
            <select
              value={tolerance}
              onChange={(e) => setTolerance(parseInt(e.target.value))}
              className="bg-slate-900 border border-slate-700 rounded px-1 py-0.5 text-slate-200"
              title="How close counterpart ink must be to count as unchanged (anti-alias tolerance)"
            >
              <option value={0}>Strict</option>
              <option value={1}>Normal</option>
              <option value={2}>Lenient</option>
            </select>
          </label>
          {pageCount > 1 && (
            <div className="flex items-center gap-1 bg-slate-900 rounded px-1">
              <button
                onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                disabled={currentPage <= 1 || loading}
                className="p-1 disabled:opacity-30 hover:text-orange-400"
                title="Previous page"
              ><ChevronLeft className="w-3.5 h-3.5" /></button>
              <span className="font-mono">{currentPage} / {pageCount}</span>
              <button
                onClick={() => setCurrentPage((p) => Math.min(pageCount, p + 1))}
                disabled={currentPage >= pageCount || loading}
                className="p-1 disabled:opacity-30 hover:text-orange-400"
                title="Next page"
              ><ChevronRight className="w-3.5 h-3.5" /></button>
            </div>
          )}
          <div className="flex items-center gap-1 bg-slate-900 rounded px-1">
            <button onClick={() => setZoom((z) => Math.max(0.05, z / 1.25))} className="p-1 hover:text-orange-400" title="Zoom out"><ZoomOut className="w-3.5 h-3.5" /></button>
            <span className="font-mono w-12 text-center" title="Ctrl + scroll to zoom">{Math.round(zoom * 100)}%</span>
            <button onClick={() => setZoom((z) => Math.min(6, z * 1.25))} className="p-1 hover:text-orange-400" title="Zoom in"><ZoomIn className="w-3.5 h-3.5" /></button>
            <button onClick={() => fitToScreen()} className="p-1 hover:text-orange-400" title="Fit the whole sheet on screen">
              <Maximize className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => panZoom.setPanMode((v) => !v)}
              className={`p-1 hover:text-orange-400 ${panZoom.panMode ? "text-orange-400" : ""}`}
              title={panZoom.panMode ? "Pan tool (drag to move) — click for cursor" : "Cursor — click for the pan/grab hand"}
            >{panZoom.panMode ? <Hand className="w-3.5 h-3.5" /> : <MousePointer2 className="w-3.5 h-3.5" />}</button>
          </div>
        </div>
      </div>

      {/* Diff canvas */}
      <div ref={scrollRef} className={`flex-1 overflow-auto bg-slate-950 relative ${panZoom.cursorClass}`} {...panZoom.panHandlers}>
        {loading && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-slate-950/80">
            <Loader2 className="w-8 h-8 animate-spin text-blue-400 mb-2" />
            <span className="text-xs font-mono text-blue-300">Rendering &amp; registering…</span>
          </div>
        )}
        {error && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center text-red-400">
            <AlertTriangle className="w-10 h-10 mb-2 opacity-60" />
            <span className="text-sm font-bold">Diff failed</span>
            <span className="text-xs font-mono mt-1 max-w-md text-center text-red-300/70">{error}</span>
          </div>
        )}
        <div className="min-w-full min-h-full w-max flex items-center justify-center p-4">
          <canvas
            ref={displayCanvasRef}
            style={{
              width: canvasSize.w ? canvasSize.w * zoom : undefined,
              height: canvasSize.h ? canvasSize.h * zoom : undefined,
              imageRendering: zoom >= 2 ? "pixelated" : "auto",
            }}
            className="bg-white shadow-2xl"
          />
        </div>
      </div>

      {/* Footer stats */}
      {stats && !loading && !error && (
        <div className="h-9 bg-slate-800 border-t border-slate-700 flex items-center px-4 text-[11px] font-mono shrink-0 gap-4">
          <span className="text-emerald-300">+ {stats.addedPixels.toLocaleString()} px added ({pct(stats.addedPixels)}%)</span>
          <span className="text-red-300">− {stats.removedPixels.toLocaleString()} px removed ({pct(stats.removedPixels)}%)</span>
          <span className="text-slate-400">≡ {stats.unchangedPixels.toLocaleString()} unchanged</span>
          {stats.addedPixels === 0 && stats.removedPixels === 0 && (
            <span className="text-sky-300">No visual differences on this page.</span>
          )}
        </div>
      )}
    </div>
  );
}
