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
  ZoomIn, ZoomOut,
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
  // Reading a page is spatial work: zoom rides Ctrl+scroll, movement rides a
  // grab-and-drag — never the scrollbar two-step.
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const [baseWidth, setBaseWidth] = useState(760);
  const [zoom, setZoom] = useState(1);
  const [panning, setPanning] = useState(false);
  const dragRef = React.useRef<{ x: number; y: number; sl: number; st: number; moved: boolean } | null>(null);
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

  // Fit-to-width baseline: the page fills the modal at 100%; zoom multiplies.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => setBaseWidth(Math.max(280, el.clientWidth - 48));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Ctrl/Cmd + scroll = zoom (native listener — React's is passive, and
  // preventDefault must stop the browser's own page zoom). Plain scroll
  // still scrolls.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      setZoom((z) => Math.min(5, Math.max(0.4, z * (e.deltaY < 0 ? 1.12 : 1 / 1.12))));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // Grab-and-drag panning (mouse AND one finger), pinch-to-zoom (two
  // fingers). touch-action is disabled on the container so the browser
  // never fights these gestures with its own scrolling/zooming — which is
  // exactly what made mobile feel finicky. A 4px threshold keeps ordinary
  // taps (buttons, jump chips) working.
  const pointersRef = React.useRef(new Map<number, { x: number; y: number }>());
  const pinchRef = React.useRef<{ dist: number; zoom: number } | null>(null);
  const pinchDist = () => {
    const pts = [...pointersRef.current.values()];
    return pts.length >= 2 ? Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) : 0;
  };
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button, a, input")) return;
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    e.currentTarget.setPointerCapture(e.pointerId);
    if (pointersRef.current.size === 2) {
      // Second finger down: switch from pan to pinch.
      dragRef.current = null;
      pinchRef.current = { dist: pinchDist(), zoom };
      return;
    }
    const el = scrollRef.current;
    if (!el) return;
    dragRef.current = { x: e.clientX, y: e.clientY, sl: el.scrollLeft, st: el.scrollTop, moved: false };
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (pointersRef.current.has(e.pointerId)) {
      pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }
    if (pinchRef.current && pointersRef.current.size >= 2) {
      const d0 = pinchRef.current.dist;
      const d1 = pinchDist();
      if (d0 > 0 && d1 > 0) {
        setZoom(Math.min(5, Math.max(0.4, pinchRef.current.zoom * (d1 / d0))));
      }
      return;
    }
    const d = dragRef.current;
    const el = scrollRef.current;
    if (!d || !el) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < 4) return;
    if (!d.moved) { d.moved = true; setPanning(true); }
    el.scrollLeft = d.sl - dx;
    el.scrollTop = d.st - dy;
  };
  const endPan = (e: React.PointerEvent<HTMLDivElement>) => {
    pointersRef.current.delete(e.pointerId);
    if (pointersRef.current.size < 2) pinchRef.current = null;
    if (pointersRef.current.size === 0) { dragRef.current = null; setPanning(false); }
  };

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
  // The applied find term — highlighted sky in the text layer on EVERY
  // document (the tag-locate API additionally marks drawings).
  const [findApplied, setFindApplied] = useState("");
  // A tag to point at as soon as a jump lands on its page.
  const [pendingFind, setPendingFind] = useState<string | null>(null);
  const canLocate = !!orgId && !!view.documentId;

  // ── Tracing a pipe run — the highlighter stroke ──────────────────────

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

  // Significant words of the quote — the fallback matcher for FRAGMENTED
  // text layers, where each item is a word or two and the old ≥10-char
  // containment test never fired, so "highlighted" pages showed nothing.
  const quoteWords = useMemo(() => {
    const set = new Set<string>();
    if (quote) for (const w of normalize(quote).split(" ")) { if (w.length >= 4) set.add(w); }
    return set;
  }, [quote]);
  const searchNorm = useMemo(() => normalize(findApplied), [findApplied]);

  // Highlight any text-layer item that belongs to the quoted passage
  // (yellow), and any item matching the find box (sky) — the find works on
  // EVERY document, not just drawings with a tag index.
  const textRenderer = useCallback(
    ({ str }: { str: string }) => {
      const safe = escapeHtml(str);
      const norm = normalize(str);
      if (searchNorm && norm.includes(searchNorm)) {
        return `<mark style="background: rgba(56, 189, 248, 0.55); color: transparent; border-radius: 2px;">${safe}</mark>`;
      }
      if (!quoteNorm || pageNumber !== page) return safe;
      if (norm.length >= 10 && quoteNorm.includes(norm)) {
        return `<mark style="background: rgba(250, 204, 21, 0.55); color: transparent; border-radius: 2px;">${safe}</mark>`;
      }
      // Fragmented layer: mark items whose significant words ALL come from
      // the quote (and at least one is ≥5 chars, to keep ambient noise out).
      const words = norm.split(" ").filter((w) => w.length >= 4);
      if (words.length > 0 && words.some((w) => w.length >= 5) && words.every((w) => quoteWords.has(w))) {
        return `<mark style="background: rgba(250, 204, 21, 0.45); color: transparent; border-radius: 2px;">${safe}</mark>`;
      }
      return safe;
    },
    [quoteNorm, quoteWords, searchNorm, pageNumber, page],
  );

  return (
    <div className="fixed inset-0 z-[60] bg-black/70 backdrop-blur-[2px] flex items-center justify-center" onClick={onClose}>
      {/* Centered proof stage: 75% of the viewport each way (full-bleed on
          phones), so the document reads like a document — not a sidebar. */}
      <div className="w-[75vw] h-[75vh] max-md:w-[96vw] max-md:h-[92vh] bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl shadow-2xl flex flex-col overflow-hidden animate-pop"
        onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="px-3 sm:px-4 py-2.5 sm:py-3 border-b border-[var(--color-border)] flex items-center gap-2 sm:gap-3 flex-wrap shrink-0">
          <div className="min-w-0 flex-1 basis-40">
            <div className="text-sm font-black text-[var(--color-text)] truncate">{view.title.replace(/\.pdf$/i, "")}</div>
            <div className="text-[10px] text-[var(--color-text-muted)] truncate">
              {view.documentId !== documentId
                ? `jumped here from ${title.replace(/\.pdf$/i, "")}`
                : `${section ? `${section} · ` : ""}cited page ${page}${
                    pageNumber !== page ? ` · viewing page ${pageNumber}`
                    : marks.length > 0 ? " · tags marked" : " · passage highlighted"}`}
              {" · Ctrl+scroll zooms · drag to pan"}
            </div>
          </div>
          <div className="flex items-center gap-1 sm:gap-1.5 flex-wrap justify-end max-w-full">
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
            <span className="w-px h-4 bg-[var(--color-border)] mx-0.5" />
            <button onClick={() => setZoom((z) => Math.max(0.4, z / 1.2))}
              className="p-1.5 rounded-lg hover:bg-[var(--color-surface-2)]" title="Zoom out (Ctrl+scroll)">
              <ZoomOut className="w-4 h-4" />
            </button>
            <button onClick={() => setZoom(1)}
              className="text-[10px] font-black tabular-nums px-1 rounded-lg hover:bg-[var(--color-surface-2)] text-[var(--color-text-muted)]"
              title="Reset to fit width">
              {Math.round(zoom * 100)}%
            </button>
            <button onClick={() => setZoom((z) => Math.min(5, z * 1.2))}
              className="p-1.5 rounded-lg hover:bg-[var(--color-surface-2)]" title="Zoom in (Ctrl+scroll)">
              <ZoomIn className="w-4 h-4" />
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
                className="p-1.5 rounded-lg hover:bg-[var(--color-surface-2)] hidden sm:block" title="Open the full PDF in a new tab">
                <ExternalLink className="w-4 h-4" />
              </a>
            )}
            <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-[var(--color-surface-2)]" title="Close (Esc)">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Find on this page — works on EVERY document: the term lights up
            sky-blue in the text layer; on drawings the tag-locate API also
            marks the sheet (text layers on SHX exports are empty). */}
        {(
          <div className="px-4 py-2 border-b border-[var(--color-border)] shrink-0 flex items-center gap-2 flex-wrap">
            <form className="flex items-center gap-1.5 min-w-0"
              onSubmit={(e) => {
                e.preventDefault();
                const t = findTag.trim();
                setFindApplied(t);
                if (t && canLocate) void locate([t.toUpperCase()], true);
              }}>
              <div className="relative min-w-0">
                <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]" />
                <input value={findTag} onChange={(e) => setFindTag(e.target.value)}
                  placeholder="Find on this page (a value, tag, phrase…)"
                  className="w-56 max-w-[55vw] pl-7 pr-2 py-1 rounded-lg text-[11px] font-mono border border-[var(--color-border)] bg-[var(--color-surface-2)] text-[var(--color-text)]" />
              </div>
              <button type="submit" disabled={locating || !findTag.trim()}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-black border border-[var(--color-border)] hover:bg-[var(--color-surface-2)] disabled:opacity-40 shrink-0">
                {locating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Crosshair className="w-3.5 h-3.5" />}
                Find
              </button>
              {findApplied && (
                <button type="button" onClick={() => { setFindApplied(""); setFindTag(""); }}
                  className="text-[10px] font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text)] shrink-0">
                  Clear
                </button>
              )}
            </form>
            {marks.some((m) => m.source === "vision") && (
              <span className="text-[10px] text-sky-700 dark:text-sky-400">
                Blue swipes are approximate — this sheet was read by AI, not extracted.
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
        <div
          ref={scrollRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endPan}
          onPointerCancel={endPan}
          style={{ touchAction: "none" }}
          className={`flex-1 overflow-auto bg-slate-200 dark:bg-slate-950 p-4 ${panning ? "cursor-grabbing select-none" : "cursor-grab"}`}>
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
              <div className="relative inline-block mx-auto" style={{ display: "table" }}>
                <Page
                  pageNumber={pageNumber}
                  width={Math.round(baseWidth * zoom)}
                  customTextRenderer={textRenderer}
                  renderAnnotationLayer={false}
                  className="shadow-xl"
                  loading={<div className="py-16 text-center"><Loader2 className="w-5 h-5 animate-spin inline text-[var(--color-text-muted)]" /></div>}
                />
                {/* A marker is a HIGHLIGHTER SWIPE over the tag, not a vague
                    ring around a neighborhood: engineers mark up drawings by
                    swiping the label, and a swipe reads as "this text" while
                    a big circle reads as "somewhere in here". Vision-located
                    marks get a wider swipe and a dashed tolerance box —
                    honest about being approximate without being a blob. */}
                {marks.map((m) => {
                  const approx = m.source !== "text";
                  return (
                    <div key={m.tag}
                      className="absolute pointer-events-none -translate-x-1/2 -translate-y-1/2"
                      style={{ left: `${m.nx * 100}%`, top: `${m.ny * 100}%` }}>
                      {approx && (
                        <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2
                          w-24 h-14 rounded-md border-2 border-dashed border-sky-500/70" />
                      )}
                      <span className={`block rounded-[3px] ${
                        approx
                          ? "w-20 h-5 bg-sky-400/45 ring-1 ring-sky-500/60"
                          : "w-14 h-4 bg-yellow-300/60 ring-1 ring-amber-500/70"
                      }`} />
                      <span className="absolute left-1/2 -translate-x-1/2 top-full mt-1 whitespace-nowrap
                        px-1.5 py-0.5 rounded text-[10px] font-black text-white bg-slate-900/85">
                        {m.tag}{approx ? " ~" : ""}
                      </span>
                    </div>
                  );
                })}
              </div>
            </Document>
          )}
        </div>
      </div>
    </div>
  );
}
