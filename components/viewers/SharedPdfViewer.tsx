"use client";

// SharedPdfViewer: the in-page viewer on a sent link (/share/<token>).
// Draws the stamped copy page by page with pdf.js (react-pdf), fit to the
// width of the screen, with zoom. The browser's own PDF viewer is never
// used: it carries its own download and print buttons, and a view-only
// link must not offer them.
//
// Loaded only in the browser (next/dynamic, ssr: false).

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import { Loader2, Minus, Plus, X, Download, Maximize2 } from "lucide-react";
import { PDF_DOC_OPTIONS } from "@/lib/pdfjsConfig";
import { btnIcon, btnQuiet } from "@/components/admin/kit";

pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";

const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
const MAX_CANVAS_PX = 4096; // keeps a big sheet under phone canvas limits

/** One page, drawn once it comes near the screen. */
function LazyPage({ n, width, ratio, onSeen }: { n: number; width: number; ratio: number; onSeen: (n: number, visible: boolean) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(n <= 2);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) setNear(true);
      }
    }, { rootMargin: "1200px 0px" });
    const seen = new IntersectionObserver((entries) => {
      for (const e of entries) onSeen(n, e.isIntersecting);
    }, { threshold: 0.35 });
    io.observe(el); seen.observe(el);
    return () => { io.disconnect(); seen.disconnect(); };
  }, [n, onSeen]);
  const dpr = typeof window !== "undefined" ? Math.min(window.devicePixelRatio || 1, MAX_CANVAS_PX / Math.max(width, 1)) : 1;
  return (
    <div ref={ref} data-page={n} className="bg-white shadow-md mx-auto" style={{ width, minHeight: near ? undefined : Math.round(width * ratio) }}>
      {near && (
        <Page
          pageNumber={n} width={width} devicePixelRatio={dpr}
          renderAnnotationLayer={false} renderTextLayer={false}
          loading={<div style={{ width, height: Math.round(width * ratio) }} className="flex items-center justify-center"><Loader2 className="w-5 h-5 animate-spin text-[var(--color-text-faint)]" /></div>}
        />
      )}
    </div>
  );
}

export default function SharedPdfViewer({ url, title, sub, onClose, onDownload, downloading, downloadNote }: {
  /** An object URL of the stamped PDF. */
  url: string;
  title: string;
  sub?: string | null;
  onClose: () => void;
  /** Shown only when the sender allowed downloading. */
  onDownload?: () => void;
  downloading?: boolean;
  /** Said when there's no download (view only). */
  downloadNote?: string;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState(0);
  const [zoomAt, setZoomAt] = useState(2);
  const [pages, setPages] = useState(0);
  const [ratio, setRatio] = useState(1.3);
  const [err, setErr] = useState<string | null>(null);
  const [current, setCurrent] = useState(1);
  const visible = useRef(new Set<number>());

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => setFit(Math.max(200, el.clientWidth - (el.clientWidth < 640 ? 16 : 48)));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if ((e.key === "+" || e.key === "=") && !e.ctrlKey && !e.metaKey) setZoomAt((z) => Math.min(ZOOMS.length - 1, z + 1));
      else if (e.key === "-" && !e.ctrlKey && !e.metaKey) setZoomAt((z) => Math.max(0, z - 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const onSeen = useCallback((n: number, isVisible: boolean) => {
    if (isVisible) visible.current.add(n); else visible.current.delete(n);
    if (visible.current.size) setCurrent(Math.min(...visible.current));
  }, []);

  const file = useMemo(() => url, [url]);
  const width = Math.round(fit * ZOOMS[zoomAt]);
  const zoomLabel = `${Math.round(ZOOMS[zoomAt] * 100)}%`;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-[var(--color-canvas)]" role="dialog" aria-modal="true" aria-label={title}>
      <div className="shrink-0 flex items-center gap-2 px-2 sm:px-4 h-14 bg-[var(--color-surface)] border-b border-[var(--color-border)]">
        <button type="button" onClick={onClose} aria-label="Close the viewer" className={`${btnIcon} w-11 h-11`}>
          <X className="w-5 h-5" />
        </button>
        <div className="min-w-0 flex-1">
          <div className="text-reading font-medium text-[var(--color-text)] truncate">{title}</div>
          {sub && <div className="text-body text-[var(--color-text-muted)] truncate">{sub}</div>}
        </div>
        {onDownload && (
          <button type="button" onClick={onDownload} disabled={downloading} className={`${btnQuiet} h-10 max-sm:px-2.5`} aria-label="Download">
            {downloading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
            <span className="max-sm:hidden">Download</span>
          </button>
        )}
      </div>

      <div ref={scroller} className="flex-1 min-h-0 overflow-auto overscroll-contain" style={{ touchAction: "pan-x pan-y pinch-zoom" }}>
        {err ? (
          <div className="max-w-md mx-auto mt-16 px-4 text-center text-reading text-[var(--color-text)]">{err}</div>
        ) : fit > 0 && (
          <Document
            file={file}
            options={PDF_DOC_OPTIONS}
            onLoadSuccess={async (pdf) => {
              setPages(pdf.numPages);
              try {
                const p1 = await pdf.getPage(1);
                const vp = p1.getViewport({ scale: 1 });
                if (vp.width > 0) setRatio(vp.height / vp.width);
              } catch { /* keep the default shape */ }
            }}
            onLoadError={() => setErr("The document couldn't be shown. Try again, or ask the person who sent it.")}
            loading={<div className="flex items-center justify-center gap-2 py-24 text-reading text-[var(--color-text-muted)]"><Loader2 className="w-5 h-5 animate-spin" /> Opening…</div>}
          >
            <div className="py-3 sm:py-6 flex flex-col gap-3 sm:gap-5" style={{ minWidth: width + 16 }}>
              {Array.from({ length: pages }, (_, i) => (
                <LazyPage key={i} n={i + 1} width={width} ratio={ratio} onSeen={onSeen} />
              ))}
            </div>
          </Document>
        )}
      </div>

      <div className="shrink-0 flex items-center gap-2 px-3 sm:px-4 h-14 bg-[var(--color-surface)] border-t border-[var(--color-border)] pb-[env(safe-area-inset-bottom)]">
        <div className="text-body text-[var(--color-text-muted)] tabular-nums min-w-0 truncate">
          {pages > 0 ? (pages === 1 ? "1 page" : `Page ${current} of ${pages}`) : ""}
          {downloadNote && <span className="max-sm:hidden"> · {downloadNote}</span>}
        </div>
        <div className="flex-1" />
        <div className="flex items-center gap-1">
          <button type="button" aria-label="Zoom out" onClick={() => setZoomAt((z) => Math.max(0, z - 1))} disabled={zoomAt === 0} className={`${btnIcon} w-11 h-11`}>
            <Minus className="w-5 h-5" />
          </button>
          <span className="w-14 text-center text-body font-medium tabular-nums text-[var(--color-text)]">{zoomLabel}</span>
          <button type="button" aria-label="Zoom in" onClick={() => setZoomAt((z) => Math.min(ZOOMS.length - 1, z + 1))} disabled={zoomAt === ZOOMS.length - 1} className={`${btnIcon} w-11 h-11`}>
            <Plus className="w-5 h-5" />
          </button>
          <button type="button" aria-label="Fit to width" title="Fit to width" onClick={() => setZoomAt(2)} disabled={zoomAt === 2} className={`${btnIcon} w-11 h-11`}>
            <Maximize2 className="w-[18px] h-[18px]" />
          </button>
        </div>
      </div>
    </div>
  );
}
