"use client";

// The "show me, don't tell me" half of a citation: a slide-over that opens
// the source PDF AT THE CITED PAGE with the cited content marked — so the
// engineer reads the actual source and interprets it themselves instead of
// trusting a transcription.
//
// Two kinds of source need two kinds of marking:
//
//   PROSE (standards, specs) — highlight the quoted passage in the PDF's
//     own text layer. Exact, free, instant.
//   DRAWINGS (P&IDs) — there IS no usable text layer on an AutoCAD SHX
//     export, so highlighting finds nothing and the sheet just opens with
//     the engineer hunting an E-size page by eye. Instead we POINT: a ring
//     over each tag the answer is about, positioned from stored coordinates
//     (exact, from ingest) or located on demand by the model (approximate,
//     and labeled that way). Plus a find box for any other tag.
//
// Built on the same react-pdf + self-hosted worker the document viewers use.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import { PDF_DOC_OPTIONS } from "@/lib/pdfjsConfig";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";
import {
  X, ChevronLeft, ChevronRight, ExternalLink, Loader2, AlertTriangle, Crosshair, Search,
} from "lucide-react";
import { getSignedUrlForPath } from "@/lib/storage";
import { locateTagsOnPage, type TagPosition, type TagElsewhere } from "@/lib/knowledge";

pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";

const escapeHtml = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export default function CitedPageViewer({
  fileKey, page, quote, title, section, onClose, orgId, documentId, tags,
}: {
  fileKey: string;
  page: number;
  quote: string | null;
  title: string;
  section?: string | null;
  onClose: () => void;
  /** Drawing pointing needs all three; without them the viewer behaves
   *  exactly as it always has. */
  orgId?: string;
  documentId?: string;
  /** Tags the answer is about — marked on the sheet as soon as it opens. */
  tags?: string[];
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pageNumber, setPageNumber] = useState(page);
  const [numPages, setNumPages] = useState<number | null>(null);
  const [width, setWidth] = useState(760);
  // The sheet currently on screen. Starts as the cited one; a jump chip can
  // swap it for a sibling sheet where the wanted tag actually lives.
  const [view, setView] = useState({ fileKey, title, documentId });
  useEffect(() => { setView({ fileKey, title, documentId }); }, [fileKey, title, documentId]);

  useEffect(() => {
    let cancelled = false;
    setUrl(null);
    getSignedUrlForPath(view.fileKey)
      .then((u) => { if (!cancelled) setUrl(u); })
      .catch((e) => { if (!cancelled) setError((e as Error).message); });
    return () => { cancelled = true; };
  }, [view.fileKey]);

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

  // ── Pointing at tags on a drawing ────────────────────────────────────
  const [marks, setMarks] = useState<TagPosition[]>([]);
  const [elsewhere, setElsewhere] = useState<TagElsewhere[]>([]);
  const [locating, setLocating] = useState(false);
  const [locateNote, setLocateNote] = useState<string | null>(null);
  const [findTag, setFindTag] = useState("");
  // A tag to point at as soon as a jump lands on its page.
  const [pendingFind, setPendingFind] = useState<string | null>(null);
  const canLocate = !!orgId && !!view.documentId;

  const locate = useCallback(async (wanted: string[], announce: boolean) => {
    if (!orgId || !view.documentId || wanted.length === 0) return;
    setLocating(true);
    if (announce) setLocateNote(null);
    try {
      const res = await locateTagsOnPage({
        orgId, documentId: view.documentId, page: pageNumber, tags: wanted,
      });
      setMarks((prev) => {
        const byTag = new Map(prev.map((m) => [m.tag, m]));
        for (const p of res.positions) byTag.set(p.tag, p);
        return [...byTag.values()];
      });
      setElsewhere(res.elsewhere ?? []);
      // Say WHICH kind of nothing happened — "not in this library at all"
      // and "the model couldn't see it" send you to different next steps.
      // ("It's on another sheet" isn't a note — it's the jump chips below.)
      const notes: string[] = [];
      if (res.skipped) notes.push(res.skipped);
      if (res.notOnPage?.length) notes.push(`Not in this drawing set: ${res.notOnPage.join(", ")}.`);
      if (res.notVisible?.length) {
        notes.push(`Couldn't spot ${res.notVisible.join(", ")} on the sheet — it's indexed here, so try the next page or zoom in.`);
      }
      setLocateNote(notes.length > 0 ? notes.join(" ") : null);
    } catch (e) {
      setLocateNote((e as Error).message);
    } finally {
      setLocating(false);
    }
  }, [orgId, view.documentId, pageNumber]);

  // Mark the answer's tags as soon as the cited page is open.
  useEffect(() => {
    setMarks([]);
    setLocateNote(null);
    setElsewhere([]);
    if (canLocate && view.documentId === documentId && pageNumber === page && (tags?.length ?? 0) > 0) {
      void locate(tags!, false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canLocate, view.documentId, documentId, pageNumber, page, tags]);

  // After a jump lands, point at the tag that prompted it.
  useEffect(() => {
    if (!pendingFind) return;
    const tag = pendingFind;
    setPendingFind(null);
    void locate([tag], true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingFind, pageNumber, view.documentId]);

  /** Go where the tag is — another page of this sheet, or a sibling sheet. */
  const jumpTo = (e: TagElsewhere) => {
    setMarks([]); setElsewhere([]); setLocateNote(null);
    if (e.fileKey !== view.fileKey) {
      setNumPages(null);
      setView({ fileKey: e.fileKey, title: e.documentName, documentId: e.documentId });
    }
    setPageNumber(e.page);
    setPendingFind(e.tag);
  };

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
            <div className="text-sm font-black text-[var(--color-text)] truncate">{view.title.replace(/\.pdf$/i, "")}</div>
            <div className="text-[10px] text-[var(--color-text-muted)] truncate">
              {view.documentId !== documentId
                ? `jumped here from ${title.replace(/\.pdf$/i, "")}`
                : `${section ? `${section} · ` : ""}cited page ${page}${
                    pageNumber !== page ? ` · viewing page ${pageNumber}`
                    : marks.length > 0 ? " · tags ringed" : " · passage highlighted"}`}
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
            {(pageNumber !== page || view.documentId !== documentId) && (
              <button onClick={() => {
                  setMarks([]); setElsewhere([]); setLocateNote(null);
                  if (view.fileKey !== fileKey) {
                    setNumPages(null);
                    setView({ fileKey, title, documentId });
                  }
                  setPageNumber(page);
                }}
                className="text-[10px] font-black px-2 py-1 rounded-lg border border-orange-300 text-orange-700 dark:text-orange-300 dark:border-orange-800 hover:bg-orange-500/10">
                {view.documentId !== documentId ? "Back to cited sheet" : `Back to p.${page}`}
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

        {/* Find a tag on this sheet — the drawing equivalent of Ctrl-F,
            which does nothing on an SHX export because there's no text. */}
        {canLocate && (
          <div className="px-4 py-2 border-b border-[var(--color-border)] shrink-0 flex items-center gap-2 flex-wrap">
            <form className="flex items-center gap-1.5"
              onSubmit={(e) => { e.preventDefault(); const t = findTag.trim().toUpperCase(); if (t) void locate([t], true); }}>
              <div className="relative">
                <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]" />
                <input value={findTag} onChange={(e) => setFindTag(e.target.value)}
                  placeholder="Find a tag on this sheet (V-3, P-101A…)"
                  className="w-64 pl-7 pr-2 py-1 rounded-lg text-[11px] font-mono border border-[var(--color-border)] bg-[var(--color-surface-2)] text-[var(--color-text)]" />
              </div>
              <button type="submit" disabled={locating || !findTag.trim()}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-black border border-[var(--color-border)] hover:bg-[var(--color-surface-2)] disabled:opacity-40">
                {locating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Crosshair className="w-3.5 h-3.5" />}
                Point at it
              </button>
            </form>
            {marks.length > 0 && (
              <button onClick={() => { setMarks([]); setLocateNote(null); }}
                className="text-[10px] font-black text-[var(--color-text-muted)] hover:text-[var(--color-text)] underline">
                clear {marks.length} marker{marks.length === 1 ? "" : "s"}
              </button>
            )}
            {marks.some((m) => m.source === "vision") && (
              <span className="text-[10px] text-sky-700 dark:text-sky-400">
                Blue rings are approximate — this sheet was read by AI, not extracted.
              </span>
            )}
            {elsewhere.map((e) => (
              <button key={`${e.tag}-${e.documentId}-${e.page}`} onClick={() => jumpTo(e)}
                title={e.documentName}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[10px] font-black border border-sky-300 dark:border-sky-800 text-sky-800 dark:text-sky-300 bg-sky-50 dark:bg-sky-950/30 hover:bg-sky-100 transition-colors">
                <Crosshair className="w-3 h-3" />
                {e.tag} is on {e.sameDocument ? `p.${e.page}` : e.documentName.replace(/\.pdf$/i, "").slice(0, 28)} — jump
              </button>
            ))}
            {locateNote && (
              <span className="text-[10px] text-amber-700 dark:text-amber-400 flex-1 min-w-0">{locateNote}</span>
            )}
          </div>
        )}

        {/* Page */}
        <div className="flex-1 overflow-auto bg-slate-200 dark:bg-slate-950 flex items-start justify-center p-4">
          {error ? (
            <div className="mt-16 text-center text-sm text-rose-600 flex items-center gap-2">
              <AlertTriangle className="w-4 h-4" /> {error}
            </div>
          ) : !url ? (
            <div className="mt-16"><Loader2 className="w-6 h-6 animate-spin text-[var(--color-text-muted)]" /></div>
          ) : (
            <Document options={PDF_DOC_OPTIONS}
              file={url}
              onLoadSuccess={({ numPages: n }) => setNumPages(n)}
              onLoadError={(e) => setError(`Couldn't open the PDF: ${e.message}`)}
              loading={<div className="mt-16"><Loader2 className="w-6 h-6 animate-spin text-[var(--color-text-muted)]" /></div>}
            >
              {/* The wrapper hugs the rendered page exactly, so a marker at
                  (0.42, 0.18) lands where it does on paper at any zoom. */}
              <div className="relative inline-block">
                <Page
                  pageNumber={pageNumber}
                  width={width}
                  customTextRenderer={textRenderer}
                  renderAnnotationLayer={false}
                  className="shadow-xl"
                  loading={<div className="py-16 text-center"><Loader2 className="w-5 h-5 animate-spin inline text-[var(--color-text-muted)]" /></div>}
                />
                {marks.map((m) => (
                  <div key={m.tag}
                    className="absolute pointer-events-none -translate-x-1/2 -translate-y-1/2"
                    style={{ left: `${m.nx * 100}%`, top: `${m.ny * 100}%` }}>
                    <span className={`block rounded-full border-[3px] animate-pulse ${
                      m.source === "text"
                        ? "w-12 h-12 border-orange-500 bg-orange-400/20"
                        : "w-20 h-20 border-sky-500 bg-sky-400/15"
                    }`} />
                    <span className="absolute left-1/2 -translate-x-1/2 top-full mt-0.5 whitespace-nowrap
                      px-1.5 py-0.5 rounded text-[10px] font-black text-white bg-slate-900/85">
                      {m.tag}{m.source === "vision" ? " ~" : ""}
                    </span>
                  </div>
                ))}
              </div>
            </Document>
          )}
        </div>
      </div>
    </div>
  );
}
