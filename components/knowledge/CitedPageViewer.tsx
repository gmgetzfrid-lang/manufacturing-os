"use client";

// The "show me, don't tell me" half of a citation: opens the source PDF AT
// THE CITED PAGE with the cited content marked — so the engineer reads the
// actual source and interprets it themselves instead of trusting a
// transcription. Docked in a panel or opened over the page (which dims):
// where you are in small caps, the document's name big, the page in words,
// quiet tools, the page on charcoal, and the answer's sources as one path
// of numbered stops with "Next source" as the one orange.
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
  ZoomIn, ZoomOut, Maximize2,
} from "lucide-react";
import { getSignedUrlForPath } from "@/lib/storage";
import { locateTagsOnPage, type TagPosition, type TagElsewhere } from "@/lib/knowledge";

pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";

const escapeHtml = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** A text-layer line that STRADDLES a short cited span — its tail opens the
 *  span, or its head closes it. Exact-phrase citations are often shorter
 *  than one printed line, or cross a line break, so plain containment marks
 *  nothing. 12+ shared chars keeps chance overlaps out. */
const straddles = (item: string, quote: string): boolean => {
  const max = Math.min(item.length, quote.length);
  for (let k = max; k >= 12; k--) {
    if (quote.startsWith(item.slice(item.length - k)) || quote.endsWith(item.slice(0, k))) return true;
  }
  return false;
};

/** One stop on the answer's evidence trail — everything needed to open a
 *  document at a cited page with its passage highlighted. */
export interface CitedSource {
  fileKey: string;
  page: number;
  quote: string | null;
  title: string;
  section?: string | null;
  documentId?: string;
  tags?: string[];
  /** The answer's citation number, shown on the carousel jump chip. */
  n?: number;
}

export default function CitedPageViewer({
  fileKey: fileKeyProp, page: pageProp, quote: quoteProp, title: titleProp,
  section: sectionProp, onClose, orgId, documentId: documentIdProp,
  tags: tagsProp, sources, initialIndex, embedded = false, onExpand,
}: {
  /** Docked: a button to open the viewer large (over the page). */
  onExpand?: () => void;
  /** Docked inside a panel instead of a centered modal: fills its container,
   *  no backdrop, Escape left to the host. */
  embedded?: boolean;
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
  /** The answer's FULL evidence trail. With 2+ entries the viewer grows a
   *  source carousel (Previous/Next source + numbered jump chips), and every
   *  cited passage of whichever document is open highlights on its page —
   *  an answer stitched from §4.2.4 and §4.2.5 shows BOTH, not just the
   *  one you clicked. */
  sources?: CitedSource[];
  /** Which source to open on (index into sources). */
  initialIndex?: number;
}) {
  const list = useMemo<CitedSource[]>(
    () => (sources && sources.length > 0
      ? sources
      : [{ fileKey: fileKeyProp, page: pageProp, quote: quoteProp, title: titleProp, section: sectionProp, documentId: documentIdProp, tags: tagsProp }]),
    [sources, fileKeyProp, pageProp, quoteProp, titleProp, sectionProp, documentIdProp, tagsProp],
  );
  const [idx, setIdx] = useState(() =>
    Math.min(Math.max(initialIndex ?? 0, 0), Math.max((sources?.length ?? 1) - 1, 0)));
  const activeSource = list[Math.min(idx, list.length - 1)];
  const { fileKey, page, title } = activeSource;
  const section = activeSource.section ?? null;
  const documentId = activeSource.documentId;
  const tags = activeSource.tags;
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
  // Stepping the source carousel (or a prop change) re-aims the viewer at
  // the newly active source's document AND page. Crossing into a DIFFERENT
  // file resets the page count — a stale count from the previous document
  // would cage or overrun the page arrows until the new PDF loads.
  useEffect(() => {
    setView((prev) => {
      if (prev.fileKey !== fileKey) setNumPages(null);
      return { fileKey, title, documentId };
    });
    setPageNumber(page);
  }, [fileKey, title, documentId, page]);

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
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !embedded) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, embedded]);

  // Every cited passage of the document CURRENTLY open, grouped by page —
  // not just the citation that was clicked. Paging through the document
  // lights up each cited section as you reach it.
  const viewKey = view.documentId ?? view.fileKey;
  const pageQuotes = useMemo(() => {
    // Word sets stay PER QUOTE — a union across four citations builds a
    // vocabulary big enough to light up unrelated sentences on the page,
    // and each highlight must match its own claim.
    const m = new Map<number, Array<{ norm: string; words: Set<string> }>>();
    for (const s of list) {
      if ((s.documentId ?? s.fileKey) !== viewKey || !s.quote) continue;
      const entries = m.get(s.page) ?? [];
      const norm = normalize(s.quote);
      const words = new Set<string>();
      for (const w of norm.split(" ")) { if (w.length >= 4) words.add(w); }
      entries.push({ norm, words });
      m.set(s.page, entries);
    }
    return m;
  }, [list, viewKey]);

  // ── Pointing at tags on a drawing ────────────────────────────────────
  const [marks, setMarks] = useState<TagPosition[]>([]);
  const [elsewhere, setElsewhere] = useState<TagElsewhere[]>([]);
  const [locating, setLocating] = useState(false);
  const [locateNote, setLocateNote] = useState<string | null>(null);
  const [findTag, setFindTag] = useState("");
  // The applied find term — highlighted gray in the text layer on EVERY
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
        notes.push(`Couldn't spot ${res.notVisible.join(", ")} on the sheet - it's indexed here, so try the next page or zoom in.`);
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

  const searchNorm = useMemo(() => normalize(findApplied), [findApplied]);

  // Highlight any text-layer item that belongs to a cited passage on the
  // page being viewed (yellow — ALL of this document's citations, not just
  // the clicked one), and any item matching the find box (gray). The
  // significant-words fallback handles FRAGMENTED text layers, where each
  // item is a word or two and containment never fires.
  const textRenderer = useCallback(
    ({ str }: { str: string }) => {
      const safe = escapeHtml(str);
      const norm = normalize(str);
      if (searchNorm && norm.includes(searchNorm)) {
        return `<mark style="background: rgba(100, 116, 139, 0.45); color: transparent; border-radius: 2px;">${safe}</mark>`;
      }
      const pq = pageQuotes.get(pageNumber);
      if (!pq) return safe;
      if ((norm.length >= 10 && pq.some((q) => q.norm.includes(norm)))
        || pq.some((q) => q.norm.length >= 12 && q.norm.length <= 400
          && (norm.includes(q.norm) || straddles(norm, q.norm)))) {
        return `<mark style="background: rgba(250, 204, 21, 0.55); color: transparent; border-radius: 2px;">${safe}</mark>`;
      }
      // Fragmented layer: mark items whose significant words ALL come from
      // ONE cited quote (and at least one is ≥5 chars, to keep noise out).
      const words = norm.split(" ").filter((w) => w.length >= 4);
      if (words.length > 0 && words.some((w) => w.length >= 5)
        && pq.some((q) => words.every((w) => q.words.has(w)))) {
        return `<mark style="background: rgba(250, 204, 21, 0.45); color: transparent; border-radius: 2px;">${safe}</mark>`;
      }
      return safe;
    },
    [pageQuotes, searchNorm, pageNumber],
  );

  const jumped = view.documentId !== documentId;
  const away = pageNumber !== page || jumped;
  // The state of what's on screen, in words.
  const stateLine = jumped
    ? `Jumped here from ${title.replace(/\.pdf$/i, "")} · page ${pageNumber}${numPages ? ` of ${numPages}` : ""}`
    : `Page ${page} cited${pageNumber !== page ? ` · you're on page ${pageNumber}` : marks.length > 0 ? " · tags marked" : " · passage highlighted"}${numPages ? ` · ${numPages} pages` : ""}`;
  const square = "w-9 h-9 grid place-items-center rounded-[10px] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)] disabled:opacity-40 transition-colors";
  const tool = "h-8 inline-flex items-center gap-1 px-2.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] text-[12.5px] font-bold text-[var(--color-text)] hover:bg-[var(--color-surface-2)] hover:border-[var(--color-border-strong)] disabled:opacity-40 transition-colors";
  const iconTool = "w-8 h-8 grid place-items-center rounded-lg text-[var(--color-text)] hover:bg-[var(--color-surface-2)] disabled:opacity-40 transition-colors";

  return (
    <div className={embedded
      ? "relative h-full w-full flex"
      : "fixed inset-0 z-[60] bg-[color-mix(in_srgb,var(--color-ink)_70%,transparent)] flex items-center justify-center"}
      onClick={embedded ? undefined : onClose}>
      {/* Centered proof stage: 75% of the viewport each way (full-bleed on
          phones), so the document reads like a document — not a sidebar.
          Docked (embedded) it simply fills the host panel. */}
      <div role={embedded ? undefined : "dialog"} aria-modal={embedded ? undefined : true} aria-label={embedded ? undefined : view.title}
        className={embedded
        ? "w-full h-full bg-[var(--color-surface)] flex flex-col overflow-hidden"
        : "w-[75vw] h-[75vh] max-md:w-[96vw] max-md:h-[92vh] bg-[var(--color-surface)] rounded-[20px] shadow-2xl flex flex-col overflow-hidden animate-pop"}
        onClick={(e) => e.stopPropagation()}>
        {/* Header: where you are, the document (big), the page in words. */}
        <div className="px-4 sm:px-5 pt-3 pb-3.5 shrink-0">
          <div className="flex items-center gap-1.5 min-h-9">
            <div className="min-w-0 flex-1 truncate text-[11px] font-extrabold uppercase tracking-[0.14em] text-[var(--color-text-muted)]">
              {list.length > 1 ? `Source ${idx + 1} of ${list.length}` : "Cited page"}{section ? ` · ${section}` : ""}
            </div>
            {url && (
              <a href={`${url}#page=${pageNumber}`} target="_blank" rel="noopener noreferrer"
                className={`${square} max-sm:hidden`} title="Open the full PDF in a new tab" aria-label="Open the full PDF in a new tab">
                <ExternalLink className="w-4 h-4" />
              </a>
            )}
            {onExpand && (
              <button type="button" onClick={onExpand} className={square} title="Open large" aria-label="Open large">
                <Maximize2 className="w-4 h-4" />
              </button>
            )}
            <button type="button" onClick={onClose} aria-label="Close" title={embedded ? "Close" : "Close (Esc)"}
              className="w-9 h-9 grid place-items-center rounded-[10px] bg-[var(--color-surface-2)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]">
              <X className="w-4 h-4" />
            </button>
          </div>
          <h2 className="mt-1 text-[22px] sm:text-[26px] leading-[1.1] font-black tracking-[-0.02em] text-[var(--color-text)] line-clamp-2 break-words">
            {view.title.replace(/\.pdf$/i, "")}
          </h2>
          <p className="mt-1 text-[13px] text-[var(--color-text-muted)] truncate">
            {stateLine}<span className="max-sm:hidden"> · Ctrl+scroll zooms, drag to pan</span>
          </p>
        </div>

        {/* Tools: page, zoom, back to the cited page, and find on this page.
            Find works on EVERY document: the term lights up gray in the text
            layer; on drawings the tag-locate API also marks the sheet (text
            layers on SHX exports are empty). */}
        <div className="px-3 sm:px-4 py-2 border-y border-[var(--color-border)] shrink-0 flex items-center gap-x-2 gap-y-2 flex-wrap">
          <div className="flex items-center">
            <button onClick={() => setPageNumber((p) => Math.max(1, p - 1))} disabled={pageNumber <= 1}
              className={iconTool} title="Previous page" aria-label="Previous page">
              <ChevronLeft className="w-4 h-4" />
            </button>
            <span className="px-1 text-[12.5px] font-bold text-[var(--color-text)] tabular-nums" aria-live="polite">
              {pageNumber}{numPages ? ` / ${numPages}` : ""}
            </span>
            <button onClick={() => setPageNumber((p) => (numPages ? Math.min(numPages, p + 1) : p + 1))}
              disabled={numPages !== null && pageNumber >= numPages}
              className={iconTool} title="Next page" aria-label="Next page">
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
          <span className="w-px h-5 bg-[var(--color-border)]" aria-hidden />
          <div className="flex items-center">
            <button onClick={() => setZoom((z) => Math.max(0.4, z / 1.2))}
              className={iconTool} title="Zoom out (Ctrl+scroll)" aria-label="Zoom out">
              <ZoomOut className="w-4 h-4" />
            </button>
            <button onClick={() => setZoom(1)}
              className="h-8 px-1.5 rounded-lg text-[12px] font-bold tabular-nums text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)]"
              title="Reset to fit width" aria-label="Reset zoom to fit width">
              {Math.round(zoom * 100)}%
            </button>
            <button onClick={() => setZoom((z) => Math.min(5, z * 1.2))}
              className={iconTool} title="Zoom in (Ctrl+scroll)" aria-label="Zoom in">
              <ZoomIn className="w-4 h-4" />
            </button>
          </div>
          {away && (
            <button onClick={() => {
                setMarks([]); setElsewhere([]); setLocateNote(null);
                if (view.fileKey !== fileKey) {
                  setNumPages(null);
                  setView({ fileKey, title, documentId });
                }
                setPageNumber(page);
              }}
              className={tool}>
              {jumped ? "Back to cited sheet" : `Back to p.${page}`}
            </button>
          )}
          <form className="flex items-center gap-1.5 min-w-0 flex-1 basis-56"
            onSubmit={(e) => {
              e.preventDefault();
              const t = findTag.trim();
              setFindApplied(t);
              if (t && canLocate) void locate([t.toUpperCase()], true);
            }}>
            <div className="relative min-w-0 flex-1">
              <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]" />
              <input value={findTag} onChange={(e) => setFindTag(e.target.value)}
                aria-label="Find on this page"
                placeholder="Find on this page"
                className="w-full h-8 pl-8 pr-2 rounded-lg text-[12.5px] border border-[var(--color-border)] bg-[var(--color-surface-2)] text-[var(--color-text)] placeholder:text-[var(--color-text-faint)] focus:outline-none focus:border-[var(--color-border-strong)]" />
            </div>
            <button type="submit" disabled={locating || !findTag.trim()} className={`${tool} shrink-0`}>
              {locating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Crosshair className="w-3.5 h-3.5" />}
              {locating ? "Finding…" : "Find"}
            </button>
            {findApplied && (
              <button type="button" onClick={() => { setFindApplied(""); setFindTag(""); }}
                className="h-8 px-1.5 text-[12.5px] font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text)] shrink-0">
                Clear
              </button>
            )}
          </form>
          {(marks.some((m) => m.source === "vision") || elsewhere.length > 0 || locateNote) && (
            <div className="basis-full flex items-center gap-2 flex-wrap">
              {marks.some((m) => m.source === "vision") && (
                <span className="text-[12px] text-[var(--color-text-muted)]">
                  Gray marks are approximate: this sheet was read by AI, not extracted.
                </span>
              )}
              {elsewhere.map((e) => (
                <button key={`${e.tag}-${e.documentId}-${e.page}`} onClick={() => jumpTo(e)}
                  title={e.documentName} className={tool}>
                  <Crosshair className="w-3.5 h-3.5" />
                  {e.tag} is on {e.sameDocument ? `p.${e.page}` : e.documentName.replace(/\.pdf$/i, "").slice(0, 28)}: go there
                </button>
              ))}
              {locateNote && (
                <span className="text-[12px] font-semibold text-amber-700 dark:text-amber-400 flex-1 min-w-0">{locateNote}</span>
              )}
            </div>
          )}
        </div>

        {/* Page, on charcoal like any document viewer. */}
        <div
          ref={scrollRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endPan}
          onPointerCancel={endPan}
          style={{ touchAction: "none" }}
          className={`relative flex-1 overflow-auto bg-[var(--color-ink)] p-4 ${panning ? "cursor-grabbing select-none" : "cursor-grab"}`}>
          {error ? (
            <div role="alert" className="mt-16 mx-auto max-w-sm text-center">
              <AlertTriangle className="w-5 h-5 mx-auto text-rose-300" />
              <p className="mt-2 text-[14px] font-bold text-[var(--color-ink-fg)]">This page didn&apos;t open.</p>
              <p className="mt-1 text-[13px] text-rose-200 break-words">{error}</p>
            </div>
          ) : !url ? (
            <div className="mt-16 flex items-center justify-center gap-2 text-[13.5px] text-[var(--color-ink-fg)] opacity-80" aria-busy="true">
              <Loader2 className="w-5 h-5 animate-spin" /> Getting the file…
            </div>
          ) : (
            <Document options={PDF_DOC_OPTIONS}
              file={url}
              onLoadSuccess={({ numPages: n }) => {
                setNumPages(n);
                // Fast page-arrow clicks against a stale count can leave an
                // out-of-range page — clamp instead of rendering an error.
                setPageNumber((p) => Math.min(p, n));
              }}
              onLoadError={(e) => setError(`Couldn't open the PDF: ${e.message}`)}
              loading={<div className="mt-16 flex items-center justify-center gap-2 text-[13.5px] text-[var(--color-ink-fg)] opacity-80"><Loader2 className="w-5 h-5 animate-spin" /> Opening the PDF…</div>}
            >
              {/* The wrapper hugs the rendered page exactly, so a marker at
                  (0.42, 0.18) lands where it does on paper at any zoom. */}
              <div className="relative inline-block mx-auto" style={{ display: "table" }}>
                <Page
                  pageNumber={pageNumber}
                  width={Math.round(baseWidth * zoom)}
                  customTextRenderer={textRenderer}
                  renderAnnotationLayer={false}
                  className="shadow-2xl"
                  loading={<div className="py-16 text-center text-[13.5px] text-[var(--color-ink-fg)] opacity-80"><Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Loading page {pageNumber}…</div>}
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
 w-24 h-14 rounded-md border-2 border-dashed border-[var(--color-text-muted)]" />
                      )}
                      <span className={`block rounded-[3px] ${
                        approx
                          ? "w-20 h-5 bg-[color-mix(in_srgb,var(--color-text-muted)_45%,transparent)] ring-1 ring-[var(--color-text-muted)]"
                          : "w-14 h-4 bg-amber-300/60 ring-1 ring-amber-500/70"
                      }`} />
                      <span className="absolute left-1/2 -translate-x-1/2 top-full mt-1 whitespace-nowrap
 px-1.5 py-0.5 rounded text-[11px] font-black text-[var(--color-ink-fg)] bg-[var(--color-ink)]">
                        {m.tag}{approx ? " ~" : ""}
                      </span>
                    </div>
                  );
                })}
              </div>
            </Document>
          )}
        </div>

        {/* The answer's whole evidence trail, walkable: its sources as one
            path of numbered stops. An answer stitched from three provisions
            across two documents is three obvious stops here, not a mystery
            hidden behind one superscript. */}
        {list.length > 1 && (
          <div className="px-3 sm:px-4 py-2.5 border-t border-[var(--color-border)] bg-[var(--color-surface)] shrink-0 flex items-center gap-2 sm:gap-3">
            <button type="button" onClick={() => setIdx((i) => Math.max(0, i - 1))} disabled={idx === 0}
              className="shrink-0 inline-flex items-center gap-1 h-10 px-3 rounded-xl border border-[var(--color-border)] text-[13px] font-bold text-[var(--color-text)] hover:bg-[var(--color-surface-2)] hover:border-[var(--color-border-strong)] disabled:opacity-40"
              aria-label="Previous source">
              <ChevronLeft className="w-4 h-4" /> <span className="max-sm:hidden">Previous</span>
            </button>
            <div className="flex-1 min-w-0">
              <ol className="flex items-center justify-center overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" aria-label="Sources">
                {list.map((s, i) => (
                  <li key={`${s.fileKey}-${s.page}-${i}`} className="flex items-center shrink-0" aria-current={i === idx ? "step" : undefined}>
                    {i > 0 && <span aria-hidden className={`w-3 sm:w-5 h-0.5 ${i <= idx ? "bg-[var(--color-text)]" : "bg-[var(--color-border-strong)]"}`} />}
                    <button type="button" onClick={() => setIdx(i)}
                      title={`${s.title.replace(/\.pdf$/i, "")}${s.section ? ` · ${s.section}` : ""} · p.${s.page}`}
                      aria-label={`Source ${s.n ?? i + 1}: ${s.title.replace(/\.pdf$/i, "")}, page ${s.page}`}
                      className={`w-7 h-7 rounded-full grid place-items-center text-[11px] font-black tabular-nums transition-colors ${
                        i === idx
                          ? "bg-[var(--color-text)] text-[var(--color-surface)]"
                          : "border-2 border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--color-text-muted)] hover:border-[var(--color-text)] hover:text-[var(--color-text)]"
                      }`}>
                      {s.n ?? i + 1}
                    </button>
                  </li>
                ))}
              </ol>
              <div className="mt-1 text-center text-[12px] text-[var(--color-text-muted)] truncate">
                {activeSource.title.replace(/\.pdf$/i, "").slice(0, 44)}
                {activeSource.section ? ` · ${activeSource.section}` : ""} · p.{activeSource.page}
              </div>
            </div>
            <button type="button" onClick={() => setIdx((i) => Math.min(list.length - 1, i + 1))}
              disabled={idx >= list.length - 1}
              className="shrink-0 inline-flex items-center gap-1 h-10 px-4 rounded-xl bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-[13px] font-extrabold hover:bg-[var(--color-accent-hover)] shadow-[0_10px_20px_-12px_var(--color-accent)] disabled:opacity-40 disabled:shadow-none"
              aria-label="Next source">
              <span className="max-sm:hidden">Next source</span> <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
