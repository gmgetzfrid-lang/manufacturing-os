"use client";

// PdfRevisionDiff — client-side rasterized visual diff between two PDF
// revisions. Renders each PDF to an off-screen canvas via pdfjs, then
// classifies every pixel as base-only (deleted, red), compare-only
// (added, green), both (unchanged, light gray), or neither (white).
//
// Strictly PDF only. NO CAD/DWG parsing — per the directive, this is a
// rasterized overlay, not a vector CAD differ.
//
// Trade-offs:
//   - Drawings of different physical sizes get scaled to a common
//     dimension before diffing. If the two PDFs have very different
//     aspect ratios the diff is noisy; that's a real signal, not a bug
//     (the layout itself changed).
//   - 100 DPI is a sensible default for office screens. The directive
//     calls out "optimize for large drawings" — at 150+ DPI the pixel
//     loop dominates render time. Expose `dpi` as a prop so callers
//     can tune.
//   - Single page at a time. Multi-page is page-by-page navigation.
//     Diffing every page in a doc set is a higher-level workflow.
//
// Performance:
//   - Two render passes + one pixel-pass. On an E-size sheet at
//     100 DPI (~3300x2400 px ≈ 8M pixels) the diff loop is ~50-100ms
//     in JS; render is dominated by pdfjs.
//   - No diff caching; if a user clicks Compare twice in a row they
//     pay the cost twice. Acceptable — comparison is a deliberate
//     action, not a passive view.

import React, { useEffect, useRef, useState, useCallback } from "react";
import { Loader2, AlertTriangle, ChevronLeft, ChevronRight, ZoomIn, ZoomOut, Hand, MousePointer2 } from "lucide-react";
import { pdfjs } from "react-pdf";
import { useViewerPanZoom } from "@/lib/useViewerPanZoom";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";

// Match the worker config FullScreenViewer uses. Setting this multiple
// times is idempotent — pdfjs just reads the latest value.
pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";

export interface PdfRevisionDiffProps {
  baseUrl: string;
  baseLabel: string;
  compareUrl: string;
  compareLabel: string;
  /** 1-indexed page number. Defaults to 1. Both PDFs must have this page. */
  page?: number;
  /** Rasterization DPI. 100 is a good default; 150 is sharper but slower. */
  dpi?: number;
}

type DiffStats = {
  totalInkPixels: number;
  addedPixels: number;
  removedPixels: number;
  unchangedPixels: number;
};

const INK_THRESHOLD = 200; // average channel < 200 counts as "ink" (not paper)

function isInk(r: number, g: number, b: number, a: number): boolean {
  if (a < 32) return false;            // transparent → paper
  return (r + g + b) / 3 < INK_THRESHOLD;
}

/** Render one PDF page to an off-screen canvas at the requested CSS-pixel size.
 *  Resolves the smallest CSS-pixel size so both pages can share dimensions. */
async function renderPage(
  url: string,
  pageNumber: number,
  targetWidth: number,
  targetHeight: number
): Promise<{ canvas: HTMLCanvasElement; pageCount: number }> {
  const loadingTask = pdfjs.getDocument(url);
  const pdf = await loadingTask.promise;
  const clampedPage = Math.max(1, Math.min(pageNumber, pdf.numPages));
  const page = await pdf.getPage(clampedPage);
  const baseViewport = page.getViewport({ scale: 1 });
  // Scale so the rendered page fits exactly the target box.
  const scale = Math.min(targetWidth / baseViewport.width, targetHeight / baseViewport.height);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("2D canvas context unavailable");
  // pdfjs 5.x accepts both `canvasContext` (legacy) and `canvas` (preferred).
  // Passing both keeps us compatible across the 4.x→5.x range react-pdf ships.
  await page.render({ canvasContext: ctx, viewport, canvas } as Parameters<typeof page.render>[0]).promise;
  return { canvas, pageCount: pdf.numPages };
}

/** Get the natural width/height of a PDF page at scale 1 (PDF user units). */
async function probePageSize(url: string, pageNumber: number): Promise<{ width: number; height: number; pageCount: number }> {
  const pdf = await pdfjs.getDocument(url).promise;
  const clamped = Math.max(1, Math.min(pageNumber, pdf.numPages));
  const page = await pdf.getPage(clamped);
  const v = page.getViewport({ scale: 1 });
  return { width: v.width, height: v.height, pageCount: pdf.numPages };
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
  // Natural (1:1) pixel size of the composited diff. We scale the canvas's
  // DISPLAY size by zoom (not a CSS transform) so the overflow container's
  // scroll range grows with zoom and the grab-hand can reach all of it.
  const [canvasSize, setCanvasSize] = useState({ w: 0, h: 0 });
  const scrollRef = useRef<HTMLDivElement>(null);
  const panZoom = useViewerPanZoom({
    containerRef: scrollRef,
    onZoom: (f) => setZoom((z) => Math.min(4, Math.max(0.25, Math.round(z * f * 100) / 100))),
  });

  const computeDiff = useCallback(async () => {
    setLoading(true);
    setError(null);
    setStats(null);
    try {
      // Probe both PDFs to find a common target dimension. We use the
      // larger of the two natural sizes so neither gets clipped, scaled
      // by dpi/72 (PDF user units are 1/72 inch).
      const [baseInfo, compareInfo] = await Promise.all([
        probePageSize(baseUrl, currentPage),
        probePageSize(compareUrl, currentPage),
      ]);
      const naturalW = Math.max(baseInfo.width, compareInfo.width);
      const naturalH = Math.max(baseInfo.height, compareInfo.height);
      const targetW = Math.round(naturalW * (dpi / 72));
      const targetH = Math.round(naturalH * (dpi / 72));
      setPageCount(Math.min(baseInfo.pageCount, compareInfo.pageCount));

      const [baseRender, compareRender] = await Promise.all([
        renderPage(baseUrl, currentPage, targetW, targetH),
        renderPage(compareUrl, currentPage, targetW, targetH),
      ]);

      // Read both pixel buffers. They may be slightly different sizes
      // (due to rounding) — clip to the shared box.
      const w = Math.min(baseRender.canvas.width, compareRender.canvas.width);
      const h = Math.min(baseRender.canvas.height, compareRender.canvas.height);

      const baseCtx = baseRender.canvas.getContext("2d", { willReadFrequently: true })!;
      const compareCtx = compareRender.canvas.getContext("2d", { willReadFrequently: true })!;
      const basePixels = baseCtx.getImageData(0, 0, w, h);
      const comparePixels = compareCtx.getImageData(0, 0, w, h);

      // Composite into the display canvas.
      const display = displayCanvasRef.current;
      if (!display) return;
      display.width = w;
      display.height = h;
      setCanvasSize({ w, h });
      const displayCtx = display.getContext("2d")!;
      const out = displayCtx.createImageData(w, h);

      let added = 0, removed = 0, unchanged = 0;
      const A = basePixels.data;
      const B = comparePixels.data;
      const O = out.data;
      const total = w * h * 4;
      for (let i = 0; i < total; i += 4) {
        const baseInk = isInk(A[i], A[i + 1], A[i + 2], A[i + 3]);
        const compInk = isInk(B[i], B[i + 1], B[i + 2], B[i + 3]);
        if (baseInk && compInk) {
          // Unchanged ink — render as a light gray so the user can see
          // the underlying drawing context.
          O[i] = 180; O[i + 1] = 180; O[i + 2] = 180; O[i + 3] = 255;
          unchanged++;
        } else if (baseInk && !compInk) {
          // Deleted — red
          O[i] = 220; O[i + 1] = 38; O[i + 2] = 38; O[i + 3] = 220;
          removed++;
        } else if (!baseInk && compInk) {
          // Added — green
          O[i] = 22; O[i + 1] = 163; O[i + 2] = 74; O[i + 3] = 220;
          added++;
        } else {
          // Paper background
          O[i] = 255; O[i + 1] = 255; O[i + 2] = 255; O[i + 3] = 255;
        }
      }
      displayCtx.putImageData(out, 0, 0);

      setStats({
        totalInkPixels: unchanged + added + removed,
        addedPixels: added,
        removedPixels: removed,
        unchangedPixels: unchanged,
      });
    } catch (e) {
      setError((e as Error).message || "Diff failed");
    } finally {
      setLoading(false);
    }
  }, [baseUrl, compareUrl, currentPage, dpi]);

  useEffect(() => { void computeDiff(); }, [computeDiff]);

  const pctAdded = stats && stats.totalInkPixels > 0
    ? ((stats.addedPixels / stats.totalInkPixels) * 100).toFixed(1)
    : "0.0";
  const pctRemoved = stats && stats.totalInkPixels > 0
    ? ((stats.removedPixels / stats.totalInkPixels) * 100).toFixed(1)
    : "0.0";

  return (
    <div className="flex flex-col h-full bg-slate-900 text-slate-100 select-none">
      {/* Header */}
      <div className="h-12 bg-slate-800 border-b border-slate-700 flex items-center justify-between px-4 shrink-0">
        <div className="flex items-center gap-3 text-xs">
          <span className="inline-flex items-center gap-1.5 text-red-300">
            <span className="w-2.5 h-2.5 rounded-sm bg-red-500" /> Removed in {baseLabel}
          </span>
          <span className="inline-flex items-center gap-1.5 text-emerald-300">
            <span className="w-2.5 h-2.5 rounded-sm bg-emerald-500" /> Added in {compareLabel}
          </span>
          <span className="inline-flex items-center gap-1.5 text-slate-400">
            <span className="w-2.5 h-2.5 rounded-sm bg-slate-400" /> Unchanged
          </span>
        </div>

        <div className="flex items-center gap-2 text-xs">
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
            <button
              onClick={() => setZoom((z) => Math.max(0.25, z - 0.25))}
              className="p-1 hover:text-orange-400"
              title="Zoom out"
            ><ZoomOut className="w-3.5 h-3.5" /></button>
            <span className="font-mono w-12 text-center" title="Ctrl + scroll to zoom">{Math.round(zoom * 100)}%</span>
            <button
              onClick={() => setZoom((z) => Math.min(4, z + 0.25))}
              className="p-1 hover:text-orange-400"
              title="Zoom in"
            ><ZoomIn className="w-3.5 h-3.5" /></button>
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
            <span className="text-xs font-mono text-blue-300">Computing diff…</span>
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
            imageRendering: "pixelated",
          }}
          className="bg-white shadow-2xl"
        />
      </div>

      {/* Footer stats */}
      {stats && !loading && !error && (
        <div className="h-9 bg-slate-800 border-t border-slate-700 flex items-center px-4 text-[11px] font-mono shrink-0 gap-4">
          <span className="text-emerald-300">+ {stats.addedPixels.toLocaleString()} px ({pctAdded}%)</span>
          <span className="text-red-300">− {stats.removedPixels.toLocaleString()} px ({pctRemoved}%)</span>
          <span className="text-slate-400">≡ {stats.unchangedPixels.toLocaleString()} unchanged</span>
        </div>
      )}
    </div>
  );
}
