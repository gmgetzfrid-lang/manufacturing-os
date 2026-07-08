"use client";

// PdfRevisionDiff — client-side rasterized TRUE-OVERLAY diff between two PDF
// revisions. Both pages are rendered onto an IDENTICAL pixel grid, auto-aligned,
// then every pixel is classified:
//
//   grey  = ink in BOTH revisions   (unchanged)
//   red   = ink only in the BASE    (removed)
//   green = ink only in the COMPARE (added)
//   white = paper
//
// Why the extra machinery — the naive per-pixel compare produces the classic
// "every line painted twice, once red once green" artifact whenever the two
// revisions rasterize a hair apart (changed page boxes, a shifted plot, AA
// fringes). Three defenses, in order:
//
//   1. REGISTRATION-NORMALIZED RENDERING — both pages land on one common pixel
//      grid. When their aspect ratios match (~same sheet), each render is
//      stretched to fill the grid exactly, so a letter-size print and a full-
//      size plot of the same drawing still line up. When aspects genuinely
//      differ, both are fit-centered (the noisy diff is then real signal).
//   2. AUTO-ALIGNMENT — a coarse-to-fine binary-mask cross-correlation finds
//      the residual translation (up to ±16px) and snaps the base layer onto
//      the compare layer before classifying. Kills uniform print shift.
//   3. ANTI-ALIAS TOLERANCE — ink with counterpart ink within N px (default 1)
//      counts as unchanged, so hairline rendering fringes don't read as
//      changes. Adjustable: Strict (0) / Normal (1) / Lenient (2).
//
// Strictly PDF only — a rasterized overlay, not a vector CAD differ.
// Single page at a time with paging nav.

import React, { useEffect, useRef, useState, useCallback } from "react";
import { Loader2, AlertTriangle, ChevronLeft, ChevronRight, ZoomIn, ZoomOut, Hand, MousePointer2, Crosshair, Eye } from "lucide-react";
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
type Align = { dx: number; dy: number };

const INK_THRESHOLD = 200;      // avg channel below this = ink (not paper)
const MAX_PIXELS = 12_000_000;  // raster cap (E-size @100dpi ≈ 8M)
const ALIGN_RANGE = 16;         // max auto-align translation, px

// ── Rendering ────────────────────────────────────────────────────────────────

async function loadPdf(url: string) {
  return pdfjs.getDocument(url).promise;
}

/** Render page `n` of `url` onto a WxH white canvas. `stretch` fills the grid
 *  exactly (perfect proportional registration for same-aspect sheets); otherwise
 *  the render is fit-centered with white padding. */
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

// ── Mask ops (binary Uint8Array, 1 = ink) ────────────────────────────────────

function toInkMask(img: ImageData): Uint8Array {
  const { data, width, height } = img;
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

/** Shift a mask by (dx,dy): out(x,y) = mask(x-dx, y-dy). */
function shiftMask(mask: Uint8Array, W: number, H: number, dx: number, dy: number): Uint8Array {
  if (dx === 0 && dy === 0) return mask;
  const out = new Uint8Array(W * H);
  const x0 = Math.max(0, dx), x1 = Math.min(W, W + dx);
  for (let y = Math.max(0, dy); y < Math.min(H, H + dy); y++) {
    const src = (y - dy) * W - dx;
    const dst = y * W;
    for (let x = x0; x < x1; x++) out[dst + x] = mask[src + x];
  }
  return out;
}

function overlapScore(A: Uint8Array, B: Uint8Array, W: number, H: number, dx: number, dy: number, stride: number): number {
  let s = 0;
  const yStart = Math.max(0, dy), yEnd = Math.min(H, H + dy);
  const xStart = Math.max(0, dx), xEnd = Math.min(W, W + dx);
  for (let y = yStart; y < yEnd; y += stride) {
    const rowB = y * W;
    const rowA = (y - dy) * W - dx;
    for (let x = xStart; x < xEnd; x += stride) {
      if (B[rowB + x] && A[rowA + x]) s++;
    }
  }
  return s;
}

/** Coarse-to-fine translation search: OR-pooled 4x downsample scan over ±16px,
 *  then a full-res ±3 refinement (stride-2 sampling). Applied only when it
 *  beats no-shift by >2% — a genuine layout change should NOT be "aligned away". */
function findAlignment(A: Uint8Array, B: Uint8Array, W: number, H: number): Align {
  const F = 4;
  const cw = Math.ceil(W / F), ch = Math.ceil(H / F);
  const cA = new Uint8Array(cw * ch), cB = new Uint8Array(cw * ch);
  for (let y = 0; y < H; y++) {
    const cy = (y / F) | 0;
    const rowFull = y * W, rowCoarse = cy * cw;
    for (let x = 0; x < W; x++) {
      const i = rowFull + x;
      if (A[i] || B[i]) {
        const ci = rowCoarse + ((x / F) | 0);
        if (A[i]) cA[ci] = 1;
        if (B[i]) cB[ci] = 1;
      }
    }
  }
  const range = ALIGN_RANGE / F;
  let best: Align = { dx: 0, dy: 0 };
  let bestScore = overlapScore(cA, cB, cw, ch, 0, 0, 1);
  const zeroCoarse = bestScore;
  for (let dy = -range; dy <= range; dy++) {
    for (let dx = -range; dx <= range; dx++) {
      if (dx === 0 && dy === 0) continue;
      const s = overlapScore(cA, cB, cw, ch, dx, dy, 1);
      if (s > bestScore) { bestScore = s; best = { dx, dy }; }
    }
  }
  if (bestScore <= zeroCoarse * 1.02) return { dx: 0, dy: 0 };

  // Refine at full resolution around the coarse winner.
  const cx = best.dx * F, cy = best.dy * F;
  let fine: Align = { dx: 0, dy: 0 };
  let fineScore = overlapScore(A, B, W, H, 0, 0, 2);
  const zeroFine = fineScore;
  for (let dy = cy - 3; dy <= cy + 3; dy++) {
    for (let dx = cx - 3; dx <= cx + 3; dx++) {
      if (Math.abs(dx) > ALIGN_RANGE || Math.abs(dy) > ALIGN_RANGE) continue;
      const s = overlapScore(A, B, W, H, dx, dy, 2);
      if (s > fineScore) { fineScore = s; fine = { dx, dy }; }
    }
  }
  return fineScore > zeroFine * 1.02 ? fine : { dx: 0, dy: 0 };
}

// ── Classification + paint ───────────────────────────────────────────────────

// Class codes: 0 paper, 1 unchanged, 2 removed (base only), 3 added (compare only)
function classify(shiftedA: Uint8Array, B: Uint8Array, W: number, H: number, tolerance: number):
  { classes: Uint8Array; stats: DiffStats } {
  const dilA = dilate(shiftedA, W, H, tolerance);
  const dilB = dilate(B, W, H, tolerance);
  const classes = new Uint8Array(W * H);
  let added = 0, removed = 0, unchanged = 0;
  for (let i = 0; i < classes.length; i++) {
    const a = shiftedA[i], b = B[i];
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
  const [alignInfo, setAlignInfo] = useState<Align | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const panZoom = useViewerPanZoom({
    containerRef: scrollRef,
    onZoom: (f) => setZoom((z) => Math.min(4, Math.max(0.25, Math.round(z * f * 100) / 100))),
  });

  // Caches: PDF rasters/masks survive tolerance & align toggles; the class map
  // survives changes-only recolors. Keyed so a url/page/dpi change invalidates.
  const masksRef = useRef<{ key: string; W: number; H: number; A: Uint8Array; B: Uint8Array; pageCount: number; align: Align | null } | null>(null);
  const classesRef = useRef<{ classes: Uint8Array; W: number; H: number } | null>(null);

  const computeDiff = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const renderKey = `${baseUrl}|${compareUrl}|${currentPage}|${dpi}`;
      if (!masksRef.current || masksRef.current.key !== renderKey) {
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
        const A = toInkMask(b.canvas.getContext("2d", { willReadFrequently: true })!.getImageData(0, 0, W, H));
        const B = toInkMask(c.canvas.getContext("2d", { willReadFrequently: true })!.getImageData(0, 0, W, H));
        masksRef.current = { key: renderKey, W, H, A, B, pageCount: Math.min(b.pageCount, c.pageCount), align: null };
      }
      const m = masksRef.current;
      setPageCount(m.pageCount);

      let shift: Align = { dx: 0, dy: 0 };
      if (autoAlign) {
        if (!m.align) m.align = findAlignment(m.A, m.B, m.W, m.H);
        shift = m.align;
      }
      setAlignInfo(autoAlign && (shift.dx !== 0 || shift.dy !== 0) ? shift : null);

      const shiftedA = shiftMask(m.A, m.W, m.H, shift.dx, shift.dy);
      const { classes, stats: st } = classify(shiftedA, m.B, m.W, m.H, tolerance);
      classesRef.current = { classes, W: m.W, H: m.H };

      const display = displayCanvasRef.current;
      if (!display) return;
      display.width = m.W;
      display.height = m.H;
      setCanvasSize({ w: m.W, h: m.H });
      paint(display.getContext("2d")!, classes, m.W, m.H, changesOnly);
      setStats(st);
    } catch (e) {
      setError((e as Error).message || "Diff failed");
    } finally {
      setLoading(false);
    }
    // changesOnly is intentionally NOT a dep — a toggle only repaints (below).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseUrl, compareUrl, currentPage, dpi, tolerance, autoAlign]);

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
          {alignInfo && (
            <span className="inline-flex items-center gap-1 text-[10px] text-sky-300" title="Auto-alignment shifted the base layer to register with the compare layer">
              <Crosshair className="w-3 h-3" /> aligned {alignInfo.dx >= 0 ? "+" : ""}{alignInfo.dx}, {alignInfo.dy >= 0 ? "+" : ""}{alignInfo.dy}px
            </span>
          )}
        </div>

        <div className="flex items-center gap-2 text-xs flex-wrap">
          <button onClick={() => setChangesOnly((v) => !v)} className={toggleBtn(changesOnly)} title="Fade unchanged linework so changes pop">
            <Eye className="w-3.5 h-3.5 inline -mt-0.5 mr-1" />Changes only
          </button>
          <button onClick={() => setAutoAlign((v) => !v)} className={toggleBtn(autoAlign)} title="Auto-register the two revisions (corrects print shift up to 16px)">
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
            <button onClick={() => setZoom((z) => Math.max(0.25, z - 0.25))} className="p-1 hover:text-orange-400" title="Zoom out"><ZoomOut className="w-3.5 h-3.5" /></button>
            <span className="font-mono w-12 text-center" title="Ctrl + scroll to zoom">{Math.round(zoom * 100)}%</span>
            <button onClick={() => setZoom((z) => Math.min(4, z + 0.25))} className="p-1 hover:text-orange-400" title="Zoom in"><ZoomIn className="w-3.5 h-3.5" /></button>
            <button
              onClick={() => panZoom.setPanMode((v) => !v)}
              className={`p-1 hover:text-orange-400 ${panZoom.panMode ? "text-orange-400" : ""}`}
              title={panZoom.panMode ? "Pan tool (drag to move) — click for cursor" : "Cursor — click for the pan/grab hand"}
            >{panZoom.panMode ? <Hand className="w-3.5 h-3.5" /> : <MousePointer2 className="w-3.5 h-3.5" />}</button>
          </div>
        </div>
      </div>

      {/* Diff canvas */}
      <div ref={scrollRef} className={`flex-1 overflow-auto bg-slate-950 p-4 relative ${panZoom.cursorClass}`} {...panZoom.panHandlers}>
        {loading && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-slate-950/80">
            <Loader2 className="w-8 h-8 animate-spin text-blue-400 mb-2" />
            <span className="text-xs font-mono text-blue-300">Rendering &amp; aligning…</span>
          </div>
        )}
        {error && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center text-red-400">
            <AlertTriangle className="w-10 h-10 mb-2 opacity-60" />
            <span className="text-sm font-bold">Diff failed</span>
            <span className="text-xs font-mono mt-1 max-w-md text-center text-red-300/70">{error}</span>
          </div>
        )}
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
