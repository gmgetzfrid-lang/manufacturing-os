"use client";

// The "show me, don't tell me" half of a citation: a slide-over that opens
// the source PDF AT THE CITED PAGE with the quoted passage highlighted in
// the text layer — so the engineer reads the actual standard and interprets
// it themselves instead of trusting a transcription.
//
// Built on the same react-pdf + self-hosted worker the document viewers use.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";
import { X, ChevronLeft, ChevronRight, ExternalLink, Loader2, AlertTriangle } from "lucide-react";
import { getSignedUrlForPath } from "@/lib/storage";

pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";

const escapeHtml = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export default function CitedPageViewer({ fileKey, page, quote, title, section, onClose }: {
  fileKey: string;
  page: number;
  quote: string | null;
  title: string;
  section?: string | null;
  onClose: () => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pageNumber, setPageNumber] = useState(page);
  const [numPages, setNumPages] = useState<number | null>(null);
  const [width, setWidth] = useState(760);

  useEffect(() => {
    let cancelled = false;
    getSignedUrlForPath(fileKey)
      .then((u) => { if (!cancelled) setUrl(u); })
      .catch((e) => { if (!cancelled) setError((e as Error).message); });
    return () => { cancelled = true; };
  }, [fileKey]);

  useEffect(() => {
    const measure = () => setWidth(Math.min(860, window.innerWidth - 48));
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const quoteNorm = useMemo(() => (quote ? normalize(quote) : ""), [quote]);

  // Highlight any text-layer item whose (normalized) text appears in the
  // quoted passage. The quote IS this page's extracted text, so the cited
  // region lights up; ambient words that echo elsewhere stay unlit thanks
  // to the length floor.
  const textRenderer = useCallback(
    ({ str }: { str: string }) => {
      const safe = escapeHtml(str);
      if (!quoteNorm || pageNumber !== page) return safe;
      const norm = normalize(str);
      if (norm.length >= 10 && quoteNorm.includes(norm)) {
        return `<mark style="background: rgba(250, 204, 21, 0.55); color: transparent; border-radius: 2px;">${safe}</mark>`;
      }
      return safe;
    },
    [quoteNorm, pageNumber, page],
  );

  return (
    <div className="fixed inset-0 z-[60] bg-black/60 flex items-stretch justify-end" onClick={onClose}>
      <div className="w-full max-w-4xl h-full bg-[var(--color-surface)] border-l border-[var(--color-border)] shadow-2xl flex flex-col"
        onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="px-4 py-3 border-b border-[var(--color-border)] flex items-center gap-3 shrink-0">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-black text-[var(--color-text)] truncate">{title.replace(/\.pdf$/i, "")}</div>
            <div className="text-[10px] text-[var(--color-text-muted)] truncate">
              {section ? `${section} · ` : ""}cited page {page}{pageNumber !== page ? ` · viewing page ${pageNumber}` : " · passage highlighted"}
            </div>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <button onClick={() => setPageNumber((p) => Math.max(1, p - 1))} disabled={pageNumber <= 1}
              className="p-1.5 rounded-lg hover:bg-[var(--color-surface-2)] disabled:opacity-40" title="Previous page">
              <ChevronLeft className="w-4 h-4" />
            </button>
            <span className="text-[11px] font-bold text-[var(--color-text-muted)] tabular-nums">
              {pageNumber}{numPages ? ` / ${numPages}` : ""}
            </span>
            <button onClick={() => setPageNumber((p) => (numPages ? Math.min(numPages, p + 1) : p + 1))}
              disabled={numPages !== null && pageNumber >= numPages}
              className="p-1.5 rounded-lg hover:bg-[var(--color-surface-2)] disabled:opacity-40" title="Next page">
              <ChevronRight className="w-4 h-4" />
            </button>
            {pageNumber !== page && (
              <button onClick={() => setPageNumber(page)}
                className="text-[10px] font-black px-2 py-1 rounded-lg border border-orange-300 text-orange-700 dark:text-orange-300 dark:border-orange-800 hover:bg-orange-500/10">
                Back to p.{page}
              </button>
            )}
            {url && (
              <a href={`${url}#page=${pageNumber}`} target="_blank" rel="noopener noreferrer"
                className="p-1.5 rounded-lg hover:bg-[var(--color-surface-2)]" title="Open the full PDF in a new tab">
                <ExternalLink className="w-4 h-4" />
              </a>
            )}
            <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-[var(--color-surface-2)]" title="Close (Esc)">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Page */}
        <div className="flex-1 overflow-auto bg-slate-200 dark:bg-slate-950 flex items-start justify-center p-4">
          {error ? (
            <div className="mt-16 text-center text-sm text-rose-600 flex items-center gap-2">
              <AlertTriangle className="w-4 h-4" /> {error}
            </div>
          ) : !url ? (
            <div className="mt-16"><Loader2 className="w-6 h-6 animate-spin text-[var(--color-text-muted)]" /></div>
          ) : (
            <Document
              file={url}
              onLoadSuccess={({ numPages: n }) => setNumPages(n)}
              onLoadError={(e) => setError(`Couldn't open the PDF: ${e.message}`)}
              loading={<div className="mt-16"><Loader2 className="w-6 h-6 animate-spin text-[var(--color-text-muted)]" /></div>}
            >
              <Page
                pageNumber={pageNumber}
                width={width}
                customTextRenderer={textRenderer}
                renderAnnotationLayer={false}
                className="shadow-xl"
                loading={<div className="py-16 text-center"><Loader2 className="w-5 h-5 animate-spin inline text-[var(--color-text-muted)]" /></div>}
              />
            </Document>
          )}
        </div>
      </div>
    </div>
  );
}
