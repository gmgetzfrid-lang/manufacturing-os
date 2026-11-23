"use client";

// PdfRevisionDiff — client-side rasterized TRUE-OVERLAY diff between two PDF
// revisions. Both pages are rendered onto an IDENTICAL pixel grid, REGISTERED
// (scale + translation), then fused per pixel:
//
//   grey  = ink in BOTH revisions   (unchanged — the overlays fuse)
//   red   = ink only in the BASE    (removed)
//   green = ink only in the COMPARE (added)
//   white = paper
//
// Two things make this look right on real drawings:
//
// 1. REGISTRATION. Two revisions of the same sheet almost never rasterize on
//    the same pixels — replots move the margins, page boxes change, prints
//    differ in scale — and without correction every unchanged line paints
//    twice (red + green) instead of fusing to grey. Ink projection profiles
//    (per-column / per-row ink totals) are matched by normalized
//    cross-correlation over a 90–110% scale range and shifts up to ±12% of
//    the sheet, independently per axis; the base layer is then WARPED onto
//    the compare grid. Applied only when it clearly beats the identity — a
//    real layout change is never "registered away".
//
// 2. INTENSITY RESIDUALS, not binary masks. Everything stays grayscale
//    (0..255 ink darkness), preserving anti-aliasing, and a pixel's
//    "removed" amount is its base ink MINUS the darkest compare ink within
//    the tolerance radius (and symmetrically for "added"). A line that
//    exists in both revisions but sits half a pixel off produces near-zero
//    residual — no fringe speckle — while genuinely deleted/added linework
//    produces a full-strength residual. Sub-noise residuals are floored to
//    zero. Tolerance radius: Strict ±1 px · Normal ±2 px · Lenient ±5 px.
//
// The view opens FIT-TO-SCREEN (whole sheet visible) with zoom/pan/ctrl-
// scroll and a Fit button, plus an eye toggle that hides unchanged linework
// so only the changes show. Strictly PDF — a rasterized overlay, not a
// vector CAD differ. Single page at a time with paging nav.

import React, { useEffect, useRef, useState, useCallback } from "react";
import { Loader2, AlertTriangle, ChevronLeft, ChevronRight, ZoomIn, ZoomOut, Hand, MousePointer2, Crosshair, Eye, EyeOff, Maximize } from "lucide-react";
import { pdfjs } from "react-pdf";
import { PDFJS_VERBOSITY } from "@/lib/pdfjsConfig";
import { useViewerPanZoom } from "@/lib/useViewerPanZoom";
import { vIcon, vTool, vGroup } from "@/components/viewers/viewerChrome";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";

import { friendlyError } from "@/lib/friendlyError";
// Match the worker config FullScreenViewer uses (idempotent).
pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";

export interface PdfRevisionDiffProps {
  baseUrl: string;
  baseLabel: string;
  compareUrl: string;
  compareLabel: string;
  /** 1-indexed page number. Defaults to 1. */
  page?: number;
  /** Rasterization DPI. 144 keeps linework crisp; capped by MAX_PIXELS. */
  dpi?: number;
}

type PdfDoc = Awaited<ReturnType<typeof pdfjs.getDocument>["promise"]>;
type DiffStats = { addedPixels: number; removedPixels: number; unchangedPixels: number; totalInkPixels: number };
/** Base→grid transform: x' = sx·x + dx, y' = sy·y + dy. */
type Registration = { sx: number; sy: number; dx: number; dy: number };
type Channels = { grey: Uint8Array; red: Uint8Array; green: Uint8Array; W: number; H: number };

const MAX_PIXELS = 14_000_000;   // raster cap (D-size @144dpi ≈ 18M → downscaled)
const RESIDUAL_FLOOR = 28;       // residuals below this are anti-alias noise → 0
const COUNT_THRESHOLD = 96;      // a pixel counts as changed/unchanged in stats above this
const TOLERANCE_RADII = [1, 2, 5] as const; // Strict / Normal / Lenient (px)

// ── Rendering ────────────────────────────────────────────────────────────────

/** Render page `n` onto a WxH white canvas. `stretch` fills the grid exactly
 *  (proportional registration for same-aspect sheets); otherwise the render is
 *  fit-centered with white padding. */
async function renderNormalized(pdf: PdfDoc, n: number, W: number, H: number, stretch: boolean): Promise<HTMLCanvasElement> {
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
  return out;
}

async function probe(pdf: PdfDoc, n: number): Promise<{ w: number; h: number; pageCount: number }> {
  const clamped = Math.max(1, Math.min(n, pdf.numPages));
  const p = await pdf.getPage(clamped);
  const v = p.getViewport({ scale: 1 });
  return { w: v.width, h: v.height, pageCount: pdf.numPages };
}

/** Warp a rendered page by an axis-aligned transform onto a fresh white canvas.
 *  Canvas-level warp (not array-level) so anti-aliasing stays smooth. */
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

// ── Ink intensity ────────────────────────────────────────────────────────────

/** Per-pixel ink darkness 0 (paper) … 255 (solid ink), alpha-weighted.
 *  Grayscale — anti-aliased edges keep their partial coverage. */
function toIntensity(canvas: HTMLCanvasElement): Uint8Array {
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const I = new Uint8Array(width * height);
  for (let p = 0, i = 0; p < I.length; p++, i += 4) {
    const dark = 255 - (data[i] + data[i + 1] + data[i + 2]) / 3;
    I[p] = ((dark * data[i + 3]) / 255) | 0;
  }
  return I;
}

/** Grayscale dilation: each pixel becomes the max over a (2r+1)² window,
 *  built from r separable 3×3 max passes. */
function dilateMax(src: Uint8Array, W: number, H: number, r: number): Uint8Array {
  let cur = src;
  for (let pass = 0; pass < r; pass++) {
    const hx = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
      const row = y * W;
      for (let x = 0; x < W; x++) {
        const i = row + x;
        let m = cur[i];
        if (x > 0 && cur[i - 1] > m) m = cur[i - 1];
        if (x < W - 1 && cur[i + 1] > m) m = cur[i + 1];
        hx[i] = m;
      }
    }
    const vy = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
      const row = y * W;
      for (let x = 0; x < W; x++) {
        const i = row + x;
        let m = hx[i];
        if (y > 0 && hx[i - W] > m) m = hx[i - W];
        if (y < H - 1 && hx[i + W] > m) m = hx[i + W];
        vy[i] = m;
      }
    }
    cur = vy;
  }
  return cur;
}

// ── Profile registration ─────────────────────────────────────────────────────

/** Ink projection profiles: per-column and per-row intensity totals, box-smoothed. */
function profiles(I: Uint8Array, W: number, H: number): { col: Float32Array; row: Float32Array } {
  const col = new Float32Array(W);
  const row = new Float32Array(H);
  for (let y = 0; y < H; y++) {
    const base = y * W;
    for (let x = 0; x < W; x++) {
      const v = I[base + x];
      if (v) { col[x] += v; row[y] += v; }
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
function findRegistration(IA: Uint8Array, IB: Uint8Array, W: number, H: number): Registration {
  const pa = profiles(IA, W, H);
  const pb = profiles(IB, W, H);
  const rx = registerAxis(pa.col, pb.col);
  const ry = registerAxis(pa.row, pb.row);
  const sx = rx.ncc > rx.zero + 0.01 ? rx.s : 1;
  const dx = rx.ncc > rx.zero + 0.01 ? rx.d : 0;
  const sy = ry.ncc > ry.zero + 0.01 ? ry.s : 1;
  const dy = ry.ncc > ry.zero + 0.01 ? ry.d : 0;
  return { sx, sy, dx, dy };
}

const isIdentity = (r: Registration) => r.sx === 1 && r.sy === 1 && r.dx === 0 && r.dy === 0;

// ── Compose + paint ──────────────────────────────────────────────────────────

/** Fuse two intensity fields into grey/red/green channels.
 *
 *  removed = base ink with no compare ink within the tolerance radius
 *  added   = compare ink with no base ink within the tolerance radius
 *  grey    = matched ink (present in both, within tolerance)
 *
 *  All grayscale — an anti-aliased edge that ALMOST matches produces a tiny
 *  residual, floored to zero, instead of a full-strength speckle. */
function compose(IA: Uint8Array, IB: Uint8Array, W: number, H: number, radius: number):
  { channels: Channels; stats: DiffStats } {
  const DA = dilateMax(IA, W, H, radius);
  const DB = dilateMax(IB, W, H, radius);
  const n = W * H;
  const grey = new Uint8Array(n), red = new Uint8Array(n), green = new Uint8Array(n);
  let added = 0, removed = 0, unchanged = 0;
  for (let i = 0; i < n; i++) {
    const a = IA[i], b = IB[i];
    if (!a && !b) continue;
    const da = DA[i], db = DB[i];
    const gA = a < db ? a : db;      // base ink matched by nearby compare ink
    const gB = b < da ? b : da;      // compare ink matched by nearby base ink
    const g = gA > gB ? gA : gB;
    let rr = a - db; if (rr < RESIDUAL_FLOOR) rr = 0;
    let gr = b - da; if (gr < RESIDUAL_FLOOR) gr = 0;
    grey[i] = g; red[i] = rr; green[i] = gr;
    if (rr >= COUNT_THRESHOLD) removed++;
    else if (gr >= COUNT_THRESHOLD) added++;
    else if (g >= COUNT_THRESHOLD) unchanged++;
  }
  return {
    channels: { grey, red, green, W, H },
    stats: { addedPixels: added, removedPixels: removed, unchangedPixels: unchanged, totalInkPixels: added + removed + unchanged },
  };
}

const COLOR_UNCHANGED: [number, number, number] = [148, 148, 148]; // grey — same ink in both
const COLOR_REMOVED: [number, number, number] = [220, 38, 38];     // red — base only
const COLOR_ADDED: [number, number, number] = [21, 128, 61];       // green — compare only
/** In changes-only mode unchanged linework is knocked down to a whisper. */
const CHANGES_ONLY_GREY = 0.12;

function paint(ctx: CanvasRenderingContext2D, ch: Channels, changesOnly: boolean) {
  const { grey, red, green, W, H } = ch;
  const img = ctx.createImageData(W, H);
  const O = img.data;
  const gf = changesOnly ? CHANGES_ONLY_GREY : 1;
  for (let p = 0, i = 0; p < grey.length; p++, i += 4) {
    let r = 255, g = 255, b = 255;
    const gv = grey[p] * gf;
    if (gv > 0) {
      const t = gv / 255;
      r += (COLOR_UNCHANGED[0] - r) * t; g += (COLOR_UNCHANGED[1] - g) * t; b += (COLOR_UNCHANGED[2] - b) * t;
    }
    const rv = red[p];
    if (rv > 0) {
      const t = rv / 255;
      r += (COLOR_REMOVED[0] - r) * t; g += (COLOR_REMOVED[1] - g) * t; b += (COLOR_REMOVED[2] - b) * t;
    }
    const av = green[p];
    if (av > 0) {
      const t = av / 255;
      r += (COLOR_ADDED[0] - r) * t; g += (COLOR_ADDED[1] - g) * t; b += (COLOR_ADDED[2] - b) * t;
    }
    O[i] = r; O[i + 1] = g; O[i + 2] = b; O[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

// ── Component ────────────────────────────────────────────────────────────────

interface RasterCache {
  key: string;
  W: number; H: number;
  pageCount: number;
  /** Kept only until the registration decision is made, then released. */
  baseCanvas: HTMLCanvasElement | null;
  IA0: Uint8Array;              // base intensity, unregistered
  IB: Uint8Array;               // compare intensity
  reg: Registration | null;     // computed lazily on first auto-align
  IAreg: Uint8Array | null;     // base intensity after warp
}

export default function PdfRevisionDiff({
  baseUrl, baseLabel, compareUrl, compareLabel,
  page = 1, dpi = 144,
}: PdfRevisionDiffProps) {
  const displayCanvasRef = useRef<HTMLCanvasElement>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<DiffStats | null>(null);
  const [zoom, setZoom] = useState(1);
  const [currentPage, setCurrentPage] = useState(page);
  const [pageCount, setPageCount] = useState(1);
  const [canvasSize, setCanvasSize] = useState({ w: 0, h: 0 });
  const [tolerance, setTolerance] = useState(1);        // index into TOLERANCE_RADII
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
  const channelsRef = useRef<Channels | null>(null);

  // One parsed PDF per URL for the life of the component — page turns and
  // re-composes reuse it instead of re-fetching/re-parsing.
  const docCacheRef = useRef<Map<string, Promise<PdfDoc>>>(new Map());
  const getDoc = useCallback((url: string): Promise<PdfDoc> => {
    let p = docCacheRef.current.get(url);
    if (!p) {
      p = pdfjs.getDocument({ url, verbosity: PDFJS_VERBOSITY }).promise;
      docCacheRef.current.set(url, p);
    }
    return p;
  }, []);
  useEffect(() => {
    const cache = docCacheRef.current;
    return () => {
      cache.forEach((p) => { p.then((d) => d.destroy()).catch(() => { /* already gone */ }); });
      cache.clear();
    };
  }, []);

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
        const [basePdf, cmpPdf] = await Promise.all([getDoc(baseUrl), getDoc(compareUrl)]);
        const [bi, ci] = await Promise.all([probe(basePdf, currentPage), probe(cmpPdf, currentPage)]);
        // One common grid. Stretch-normalize when the sheets share an aspect
        // ratio (same drawing at different print sizes still registers).
        const aspectClose = Math.abs(bi.w / bi.h - ci.w / ci.h) / Math.max(bi.w / bi.h, ci.w / ci.h) < 0.02;
        const naturalW = Math.max(bi.w, ci.w), naturalH = Math.max(bi.h, ci.h);
        let W = Math.round(naturalW * (dpi / 72)), H = Math.round(naturalH * (dpi / 72));
        if (W * H > MAX_PIXELS) {
          const f = Math.sqrt(MAX_PIXELS / (W * H));
          W = Math.max(1, Math.floor(W * f)); H = Math.max(1, Math.floor(H * f));
        }
        const [bCanvas, cCanvas] = await Promise.all([
          renderNormalized(basePdf, currentPage, W, H, aspectClose),
          renderNormalized(cmpPdf, currentPage, W, H, aspectClose),
        ]);
        rasterRef.current = {
          key: renderKey, W, H,
          pageCount: Math.min(bi.pageCount, ci.pageCount),
          baseCanvas: bCanvas,
          IA0: toIntensity(bCanvas),
          IB: toIntensity(cCanvas),
          reg: null,
          IAreg: null,
        };
        channelsRef.current = null;
      }
      const m = rasterRef.current;
      setPageCount(m.pageCount);

      // Registration: estimate once per pair/page, warp the BASE onto the grid.
      let IA = m.IA0;
      let applied: Registration | null = null;
      if (autoAlign) {
        if (!m.reg) {
          m.reg = findRegistration(m.IA0, m.IB, m.W, m.H);
          if (!isIdentity(m.reg) && m.baseCanvas) {
            m.IAreg = toIntensity(warpCanvas(m.baseCanvas, m.W, m.H, m.reg));
          }
          m.baseCanvas = null; // release the big bitmap — intensities are all we need now
        }
        if (!isIdentity(m.reg)) {
          IA = m.IAreg ?? m.IA0;
          applied = m.reg;
        }
      }
      setRegInfo(applied);

      const { channels, stats: st } = compose(IA, m.IB, m.W, m.H, TOLERANCE_RADII[tolerance] ?? 2);
      channelsRef.current = channels;

      const display = displayCanvasRef.current;
      if (!display) return;
      display.width = m.W;
      display.height = m.H;
      setCanvasSize({ w: m.W, h: m.H });
      paint(display.getContext("2d")!, channels, changesOnly);
      setStats(st);

      // First sight of a new pair/page → show the whole sheet (after layout).
      if (fittedKeyRef.current !== m.key) {
        fittedKeyRef.current = m.key;
        requestAnimationFrame(() => fitToScreen(m.W, m.H));
      }
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setLoading(false);
    }
    // changesOnly is intentionally NOT a dep — a toggle only repaints (below).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseUrl, compareUrl, currentPage, dpi, tolerance, autoAlign, fitToScreen, getDoc]);

  useEffect(() => { void computeDiff(); }, [computeDiff]);

  // The eye toggle is a pure recolor of the cached channels — no re-render.
  useEffect(() => {
    const ch = channelsRef.current;
    const display = displayCanvasRef.current;
    if (!ch || !display || loading) return;
    paint(display.getContext("2d")!, ch, changesOnly);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [changesOnly]);

  // The arrow keys turn the page (left goes back a page).
  useEffect(() => {
    if (pageCount <= 1) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
      if (e.key === "ArrowLeft") setCurrentPage((p) => Math.max(1, p - 1));
      else if (e.key === "ArrowRight") setCurrentPage((p) => Math.min(pageCount, p + 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pageCount]);

  const pct = (n: number) => stats && stats.totalInkPixels > 0 ? ((n / stats.totalInkPixels) * 100).toFixed(1) : "0.0";

  // A switch on the charcoal: quiet, or a white pill while on (never orange).
  const toggleBtn = (active: boolean) =>
    `inline-flex items-center gap-1.5 h-9 px-3 shrink-0 rounded-[10px] text-[13px] font-semibold transition-colors ${active
      ? "bg-[var(--color-ink-fg)] text-[var(--color-ink)]"
      : "bg-[var(--color-ink-2)] text-[var(--color-text)] hover:bg-[var(--color-ink-line)]"}`;

  const regLabel = regInfo
    ? `registered ${regInfo.sx !== 1 || regInfo.sy !== 1 ? `${(regInfo.sx * 100).toFixed(1)}%/${(regInfo.sy * 100).toFixed(1)}% ` : ""}${regInfo.dx >= 0 ? "+" : ""}${Math.round(regInfo.dx)},${regInfo.dy >= 0 ? "+" : ""}${Math.round(regInfo.dy)}px`
    : null;

  const swatch = (rgb: [number, number, number]) => (
    <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: `rgb(${rgb.join(",")})` }} aria-hidden="true" />
  );

  return (
    <div className="surface-charcoal flex flex-col h-full bg-[var(--color-ink)] text-[var(--color-text)] select-none">
      {/* Header: what the colors mean, then the controls */}
      <div className="min-h-12 border-b border-[var(--color-border)] flex items-center justify-between gap-3 px-4 py-2 shrink-0 flex-wrap">
        <div className="flex items-center gap-x-4 gap-y-1 text-[13px] flex-wrap text-[var(--color-text)]">
          <span className="inline-flex items-center gap-1.5">{swatch(COLOR_UNCHANGED)} Unchanged</span>
          <span className="inline-flex items-center gap-1.5">{swatch(COLOR_REMOVED)} Removed · only in {baseLabel}</span>
          <span className="inline-flex items-center gap-1.5">{swatch(COLOR_ADDED)} Added · only in {compareLabel}</span>
          {regLabel && (
            <span className="inline-flex items-center gap-1 text-[13px] text-[var(--color-text-muted)]" title="Registration warped the base layer (scale + shift) to line up with the compare layer before diffing">
              <Crosshair className="w-3 h-3" /> {regLabel}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {/* The eye: hide unchanged linework, see only the changes. */}
          <button
            type="button"
            onClick={() => setChangesOnly((v) => !v)}
            aria-pressed={changesOnly}
            className={toggleBtn(changesOnly)}
            title={changesOnly
              ? "Showing changes only - unchanged linework is hidden. Click to show everything."
              : "Hide unchanged (grey) linework and see only what changed"}
          >
            {changesOnly ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            Changes only
          </button>
          <button type="button" onClick={() => setAutoAlign((v) => !v)} aria-pressed={autoAlign} className={toggleBtn(autoAlign)} title="Register the two revisions (scale + shift from ink profiles) before diffing">
            <Crosshair className="w-4 h-4" />Auto-align
          </button>
          <label className="flex items-center gap-1.5 text-[13px] font-semibold text-[var(--color-text-muted)]">
            Precision
            <select
              value={tolerance}
              onChange={(e) => setTolerance(parseInt(e.target.value))}
              className="h-9 rounded-[10px] bg-[var(--color-ink-2)] border border-[var(--color-ink-line)] px-2 text-[13px] font-semibold normal-case tracking-normal text-[var(--color-text)]"
              title="How far counterpart ink may sit and still count as unchanged (±1 / ±2 / ±5 px)"
            >
              <option value={0}>Strict</option>
              <option value={1}>Normal</option>
              <option value={2}>Lenient</option>
            </select>
          </label>
          {pageCount > 1 && (
            <div className={vGroup}>
              <button
                type="button"
                onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                disabled={currentPage <= 1 || loading}
                className={vIcon}
                title="Previous page (Left arrow)"
                aria-label="Previous page"
              ><ChevronLeft className="w-4 h-4" /></button>
              <span className="px-1 min-w-[3rem] text-center" aria-live="polite">{currentPage} / {pageCount}</span>
              <button
                type="button"
                onClick={() => setCurrentPage((p) => Math.min(pageCount, p + 1))}
                disabled={currentPage >= pageCount || loading}
                className={vIcon}
                title="Next page (Right arrow)"
                aria-label="Next page"
              ><ChevronRight className="w-4 h-4" /></button>
            </div>
          )}
          <div className={vGroup}>
            <button type="button" onClick={() => setZoom((z) => Math.max(0.05, z / 1.25))} className={vIcon} title="Zoom out" aria-label="Zoom out"><ZoomOut className="w-4 h-4" /></button>
            <span className="w-12 text-center" title="Ctrl + scroll to zoom">{Math.round(zoom * 100)}%</span>
            <button type="button" onClick={() => setZoom((z) => Math.min(6, z * 1.25))} className={vIcon} title="Zoom in" aria-label="Zoom in"><ZoomIn className="w-4 h-4" /></button>
            <button type="button" onClick={() => fitToScreen()} className={vIcon} title="Fit the whole sheet on screen" aria-label="Fit the whole sheet on screen">
              <Maximize className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={() => panZoom.setPanMode((v) => !v)}
              className={vTool(panZoom.panMode, "w-9 h-9")}
              aria-pressed={panZoom.panMode}
              aria-label="Pan tool"
              title={panZoom.panMode ? "Pan tool (drag to move) - click for cursor" : "Cursor - click for the pan/grab hand"}
            >{panZoom.panMode ? <Hand className="w-4 h-4" /> : <MousePointer2 className="w-4 h-4" />}</button>
          </div>
        </div>
      </div>

      {/* Diff canvas */}
      <div ref={scrollRef} className={`flex-1 overflow-auto bg-[var(--color-surface)] relative ${panZoom.cursorClass}`} style={{ touchAction: "pan-x pan-y" }} {...panZoom.panHandlers}>
        {loading && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-[color-mix(in_srgb,var(--color-ink)_80%,transparent)]">
            <Loader2 className="w-8 h-8 animate-spin text-[var(--color-text-muted)] mb-2" />
            <span className="text-[13px] text-[var(--color-text)]">Lining up the two revisions…</span>
          </div>
        )}
        {error && (
          <div role="alert" className="absolute inset-0 z-10 flex flex-col items-center justify-center px-6 text-center">
            <AlertTriangle className="w-9 h-9 mb-2 text-rose-400" />
            <span className="text-[14px] font-bold text-[var(--color-text)]">Couldn&apos;t compare these revisions</span>
            <span className="text-[13px] mt-1 max-w-md text-[var(--color-text-muted)]">{error}</span>
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
            className="bg-white shadow-2xl shadow-black/40"
          />
        </div>
      </div>

      {/* Footer: how much changed on this page */}
      {stats && !loading && !error && (
        <div className="min-h-9 border-t border-[var(--color-border)] flex items-center flex-wrap px-4 py-1.5 text-[13px] tabular-nums shrink-0 gap-x-5 gap-y-0.5 text-[var(--color-text-muted)]">
          <span className="inline-flex items-center gap-1.5">{swatch(COLOR_ADDED)} {stats.addedPixels.toLocaleString()} px added ({pct(stats.addedPixels)}%)</span>
          <span className="inline-flex items-center gap-1.5">{swatch(COLOR_REMOVED)} {stats.removedPixels.toLocaleString()} px removed ({pct(stats.removedPixels)}%)</span>
          <span className="inline-flex items-center gap-1.5">{swatch(COLOR_UNCHANGED)} {stats.unchangedPixels.toLocaleString()} unchanged</span>
          {stats.addedPixels === 0 && stats.removedPixels === 0 && (
            <span className="font-semibold text-emerald-300">No differences on this page.</span>
          )}
        </div>
      )}
    </div>
  );
}
