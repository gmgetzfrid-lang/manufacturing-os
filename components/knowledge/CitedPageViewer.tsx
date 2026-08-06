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
  Highlighter,
} from "lucide-react";
import { getSignedUrlForPath } from "@/lib/storage";
import { locateTagsOnPage, traceLineOnPage, type TagPosition, type TagElsewhere } from "@/lib/knowledge";

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

  // ── Tracing a pipe run — the highlighter stroke ──────────────────────
  const [trace, setTrace] = useState<{
    from: string; to: string; points: Array<{ nx: number; ny: number }>;
    method: "raster" | "vision" | "none"; turns?: number | null;
  } | null>(null);
  const [tracing, setTracing] = useState(false);
  const [traceNote, setTraceNote] = useState<string | null>(null);
  // Seed the trace inputs with the answer's own tags — the usual ask is
  // "show me the run the answer just described", not a fresh pair.
  const [traceFrom, setTraceFrom] = useState(() => tags?.[0] ?? "");
  const [traceTo, setTraceTo] = useState(() => tags?.[1] ?? "");
  // A different citation opens with different tags; re-seed rather than
  // leaving the previous answer's pair sitting in the boxes.
  useEffect(() => {
    setTraceFrom(tags?.[0] ?? "");
    setTraceTo(tags?.[1] ?? "");
  }, [tags]);

  /** What the vectorizer saw, when asked to show its work. */
  const [lineWork, setLineWork] = useState<{
    lines: Array<{ x1: number; y1: number; x2: number; y2: number }>;
    segments: number;
    diagnostics: { nodes: number; startCandidates: number; goalCandidates: number };
  } | null>(null);

  const runTrace = useCallback(async (from: string, to: string, debug = false) => {
    if (!orgId || !view.documentId || !from || !to) return;
    setTracing(true);
    setTraceNote(null);
    if (debug) setLineWork(null);
    try {
      const res = await traceLineOnPage({
        orgId, documentId: view.documentId, page: pageNumber, fromTag: from, toTag: to, debug,
      });
      if (res.found) {
        setTrace({ from, to, points: res.points, method: res.method, turns: res.turns });
        setTraceNote(res.note);
      } else {
        setTrace(null);
        setTraceNote(res.note ?? "Couldn't follow that line on this sheet.");
      }
      if (res.debug) {
        setLineWork({
          lines: res.debug.lineWork,
          segments: res.debug.segments,
          diagnostics: res.debug.diagnostics,
        });
      }
    } catch (e) {
      setTrace(null);
      setTraceNote((e as Error).message);
    } finally {
      setTracing(false);
    }
  }, [orgId, view.documentId, pageNumber]);

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
    // A trace belongs to exactly one sheet face — never carry it across.
    setTrace(null);
    setTraceNote(null);
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
                    : trace ? ` · ${trace.from} → ${trace.to} traced`
                    : marks.length > 0 ? " · tags marked" : " · passage highlighted"}`}
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
                  setTrace(null); setTraceNote(null);
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
            {/* Trace a pipe run — the drawing's yellow highlighter. */}
            <form className="flex items-center gap-1.5"
              onSubmit={(e) => {
                e.preventDefault();
                const from = traceFrom.trim().toUpperCase();
                const to = traceTo.trim().toUpperCase();
                if (from && to) {
                  void runTrace(from, to);
                  // Ring both ends too, so the stroke visibly connects them.
                  void locate([from, to], false);
                }
              }}>
              <input value={traceFrom} onChange={(e) => setTraceFrom(e.target.value)}
                placeholder="From (P-32)"
                className="w-24 px-2 py-1 rounded-lg text-[11px] font-mono border border-[var(--color-border)] bg-[var(--color-surface-2)] text-[var(--color-text)]" />
              <span className="text-[10px] text-[var(--color-text-muted)]">→</span>
              <input value={traceTo} onChange={(e) => setTraceTo(e.target.value)}
                placeholder="To (X-32)"
                className="w-24 px-2 py-1 rounded-lg text-[11px] font-mono border border-[var(--color-border)] bg-[var(--color-surface-2)] text-[var(--color-text)]" />
              <button type="submit" disabled={tracing || !traceFrom.trim() || !traceTo.trim()}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-black border border-amber-300 dark:border-amber-800 text-amber-800 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/30 hover:bg-amber-100 disabled:opacity-40 transition-colors">
                {tracing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Highlighter className="w-3.5 h-3.5" />}
                Trace line
              </button>
            </form>
            {/* Show the vectorized line-work. If the yellow route looks wrong,
                this answers WHY in one glance: either the tracer found your
                pipes and chose badly, or it never saw them at all. */}
            <button
              onClick={() => {
                if (lineWork) { setLineWork(null); return; }
                const f = traceFrom.trim().toUpperCase(), t = traceTo.trim().toUpperCase();
                if (f && t) void runTrace(f, t, true);
              }}
              disabled={tracing || !traceFrom.trim() || !traceTo.trim()}
              className="text-[10px] font-black text-[var(--color-text-muted)] hover:text-[var(--color-text)] underline disabled:opacity-40">
              {lineWork ? "hide line-work" : "show line-work"}
            </button>
            {trace && (
              <button onClick={() => { setTrace(null); setTraceNote(null); }}
                className="text-[10px] font-black text-[var(--color-text-muted)] hover:text-[var(--color-text)] underline">
                clear trace
              </button>
            )}
            {lineWork && (
              <span className="text-[10px] text-cyan-700 dark:text-cyan-400">
                {lineWork.segments.toLocaleString()} strokes · {lineWork.diagnostics.nodes.toLocaleString()} junctions ·
                {" "}{lineWork.diagnostics.startCandidates}/{lineWork.diagnostics.goalCandidates} pipe ends near the two tags
              </span>
            )}
            {marks.length > 0 && (
              <button onClick={() => { setMarks([]); setLocateNote(null); }}
                className="text-[10px] font-black text-[var(--color-text-muted)] hover:text-[var(--color-text)] underline">
                clear {marks.length} marker{marks.length === 1 ? "" : "s"}
              </button>
            )}
            {traceNote && (
              <span className="text-[10px] text-amber-700 dark:text-amber-400">{traceNote}</span>
            )}
            {trace && (
              // A followed line and a guessed line must never look alike on a
              // drawing someone might isolate a pipe from.
              trace.method === "raster" ? (
                <span className="text-[10px] text-emerald-700 dark:text-emerald-400">
                  Followed the drawn line {trace.from} → {trace.to}
                  {typeof trace.turns === "number" && <> · {trace.turns} turn{trace.turns === 1 ? "" : "s"}</>}
                  {" "}· still confirm the line number before isolation work.
                </span>
              ) : (
                <span className="text-[10px] text-amber-700 dark:text-amber-400">
                  <b>Estimated, not followed.</b> The line-work couldn&apos;t be read on this sheet, so this
                  is the model&apos;s guess at {trace.from} → {trace.to} — treat it as a hint, not a route.
                </span>
              )
            )}
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
                {/* What the vectorizer extracted, drawn over the page. Cyan
                    where it thinks pipe is; if your line has no cyan on it,
                    the tracer never saw it and no amount of search tuning
                    would have helped. */}
                {lineWork && (
                  <svg className="absolute inset-0 w-full h-full pointer-events-none"
                    viewBox="0 0 100 100" preserveAspectRatio="none">
                    {lineWork.lines.map((l, i) => (
                      <line key={i}
                        x1={(l.x1 * 100).toFixed(3)} y1={(l.y1 * 100).toFixed(3)}
                        x2={(l.x2 * 100).toFixed(3)} y2={(l.y2 * 100).toFixed(3)}
                        stroke="rgba(6, 182, 212, 0.75)" strokeWidth={2}
                        vectorEffect="non-scaling-stroke" />
                    ))}
                  </svg>
                )}
                {/* The highlighter stroke: wide, translucent, over the page —
                    forgiving of waypoint error the way a real highlighter is
                    forgiving of a shaky hand. non-scaling-stroke keeps the
                    width honest even though the viewBox stretches. */}
                {trace && trace.points.length >= 2 && (
                  <svg
                    className="absolute inset-0 w-full h-full pointer-events-none"
                    viewBox="0 0 100 100"
                    preserveAspectRatio="none"
                  >
                    <polyline
                      points={trace.points.map((p) => `${(p.nx * 100).toFixed(2)},${(p.ny * 100).toFixed(2)}`).join(" ")}
                      fill="none"
                      // A followed route can be drawn tight over the actual
                      // line-work; an estimate has to stay wide and vague,
                      // because a crisp stroke in the wrong place is a lie.
                      stroke={trace.method === "raster"
                        ? "rgba(250, 204, 21, 0.55)"
                        : "rgba(251, 146, 60, 0.35)"}
                      strokeWidth={trace.method === "raster" ? 9 : 16}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeDasharray={trace.method === "raster" ? undefined : "14 10"}
                      vectorEffect="non-scaling-stroke"
                    />
                  </svg>
                )}
                {trace && trace.points.length >= 2 && [trace.points[0], trace.points[trace.points.length - 1]].map((p, i) => (
                  <div key={`trace-end-${i}`}
                    className="absolute pointer-events-none -translate-x-1/2 -translate-y-1/2"
                    style={{ left: `${p.nx * 100}%`, top: `${p.ny * 100}%` }}>
                    <span className={`block w-3 h-3 rounded-full border-2 border-white shadow ${
                      trace.method === "raster" ? "bg-amber-500" : "bg-orange-400"}`} />
                  </div>
                ))}
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
