"use client";

// MultiDocViewer — the combined "Reference Book".
//
// Renders many documents as ONE continuous, smoothly-scrolling stack of real
// PDF pages (react-pdf canvases — no nested iframes, so there's no per-page
// scroll stutter). As you scroll, the active sheet drives a floating
// equipment-tag ribbon, and a column-agnostic Tag Search jumps you straight to
// the sheet carrying a given tag. Full markup is one click away per sheet via
// the single-document editor.
//
// LAYOUT: a true full-bleed PDF surface with all chrome as overlays — a compact
// auto-hiding top toolbar, a slide-over sidebar (page thumbnails + contents),
// and a collapsible tag ribbon. Pages render fit-to-width by default (no max
// cap) so a wide refinery P&ID truly fills the screen; fit-page, zoom, rotate
// and a real browser-fullscreen toggle round out the viewer controls.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  X, BookOpen, ChevronLeft, ChevronRight, Loader2, FileText, Menu,
  Download, Printer, ShieldCheck, ShieldAlert, Library, Briefcase,
  Search, Pen, ZoomIn, ZoomOut, Camera, Pin, Layers, Plus, Check, Send,
  Maximize2, Minimize2, RotateCw, MoreHorizontal, PanelLeftClose,
} from "lucide-react";
import { Document, Page, pdfjs } from "react-pdf";
import { supabase } from "@/lib/supabase";
import type { DocumentRecord } from "@/types/schema";
import { downloadDocumentPdf, printDocumentPdf, determineControlState } from "@/lib/downloads";
import { stampPdf } from "@/lib/stamping";
import { PDFDocument } from "pdf-lib";
import BulkCheckoutToProjectModal from "@/components/documents/BulkCheckoutToProjectModal";
import FullScreenViewer from "@/components/viewers/FullScreenViewer";
import EquipmentTagsStrip from "@/components/assets/EquipmentTagsStrip";
import { collectTagGroups, rankTags, type TagColumnDef } from "@/lib/documentTags";
import { bakeMarkupIntoPdf } from "@/lib/markupExport";
import { stashDraft, type DraftHandoffFile } from "@/lib/draftHandoff";
import { appAlert } from "@/components/providers/DialogProvider";
import { useRouter } from "next/navigation";

// Same self-hosted worker the single viewer uses (copied to /public on prebuild).
pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";

interface DocEntry {
  doc: DocumentRecord;
  resolvedUrl: string | null;
  loading: boolean;
  error: string | null;
}

// Resolve a column key to a doc's display text — mirrors the library table's
// renderDocCell (built-ins from top-level fields, custom keys from metadata) so
// a thumbnail's label matches exactly what the table shows.
function cellText(doc: DocumentRecord, key: string): string {
  if (key === "title") return doc.title || doc.name || "";
  if (key === "documentNumber") return doc.documentNumber || "";
  if (key === "rev") return doc.rev || "";
  if (key === "status") return doc.status || "";
  if (key === "updatedAt") {
    const v = doc.updatedAt as unknown;
    try {
      if (v && typeof (v as { toDate?: () => Date }).toDate === "function") return (v as { toDate: () => Date }).toDate().toLocaleDateString();
      if (typeof v === "string" || typeof v === "number") return new Date(v).toLocaleDateString();
    } catch { /* ignore */ }
    return "";
  }
  const v = (doc.metadata ?? {})[key];
  return Array.isArray(v) ? v.join(", ") : v == null ? "" : String(v);
}

// Lazy page-thumbnail — only parses + renders its PDF once scrolled near the
// sidebar viewport, so a big book's Pages panel stays cheap to open.
function PageThumb({ url, width }: { url: string | null; width: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [show, setShow] = useState(() => typeof IntersectionObserver === "undefined");
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (es) => { if (es.some((e) => e.isIntersecting)) { setShow(true); io.disconnect(); } },
      { rootMargin: "400px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  const h = Math.round(width * 1.3);
  return (
    <div ref={ref} className="w-full bg-white overflow-hidden" style={{ minHeight: h }}>
      {show && url ? (
        <Document file={url} loading={<div className="animate-pulse bg-slate-800/60" style={{ height: h }} />} error={<div className="flex items-center justify-center text-slate-600" style={{ height: h }}><FileText className="w-5 h-5 opacity-30" /></div>}>
          <Page pageNumber={1} width={width} renderTextLayer={false} renderAnnotationLayer={false} loading={<div className="animate-pulse bg-slate-800/60" style={{ height: h }} />} />
        </Document>
      ) : (
        <div className="animate-pulse bg-slate-800/40" style={{ height: h }} />
      )}
    </div>
  );
}

interface MultiDocViewerProps {
  docs: DocumentRecord[];
  onClose: () => void;
  currentUserId?: string;
  currentUserEmail?: string;
  orgId?: string;
  userRole?: string;
  /** The library's columns — drives the dynamic tag ribbon + tag search. */
  customColumns?: TagColumnDef[];
  /** First two VISIBLE table columns — drives each thumbnail's two-line label so
   *  it matches what the library table shows. */
  labelColumns?: { key: string; label: string }[];
}

export default function MultiDocViewer({ docs, onClose, currentUserId, currentUserEmail, orgId, userRole, customColumns, labelColumns }: MultiDocViewerProps) {
  const router = useRouter();
  const [bookBusy, setBookBusy] = useState(false);
  const [docBusy, setDocBusy] = useState(false);
  const [downloadConfirm, setDownloadConfirm] = useState<null | { type: "download" | "print" | "book"; }>(null);
  const [editingDoc, setEditingDoc] = useState<DocumentRecord | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [showBulkCheckout, setShowBulkCheckout] = useState(false);
  const [entries, setEntries] = useState<DocEntry[]>(() =>
    docs.map((doc) => ({ doc, resolvedUrl: null, loading: true, error: null }))
  );
  const [activeIdx, setActiveIdx] = useState(0);
  // Thumbnail rail — a push panel (default open) so thumbnails are the primary
  // way to navigate; collapse it for a pure full-bleed page.
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [tagsBarOpen, setTagsBarOpen] = useState(false);

  // Continuous-render state.
  const [pageCounts, setPageCounts] = useState<Record<number, number>>({});
  const [mounted, setMounted] = useState<Set<number>>(() => new Set([0]));
  const [zoom, setZoom] = useState(1);

  // Pages render fit-to-width from the live container size (no hard cap) so a
  // wide P&ID fills the screen; zoom multiplies on top, rotate spins 90°.
  const [containerSize, setContainerSize] = useState({ w: 1024, h: 768 });
  const [rotation, setRotation] = useState(0);

  // Chrome: auto-hiding overlay toolbar + true (browser) fullscreen.
  const [chromeVisible, setChromeVisible] = useState(true);
  const [pinChrome, setPinChrome] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Tag search.
  const [search, setSearch] = useState("");
  const [searchMsg, setSearchMsg] = useState<string | null>(null);
  const [flashIdx, setFlashIdx] = useState<number | null>(null);
  // Autocomplete dropdown.
  const [showSuggest, setShowSuggest] = useState(false);
  const [suggestIdx, setSuggestIdx] = useState(-1);
  // Focus set — a temporary subset of sheets the user pins in to review.
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [focusMode, setFocusMode] = useState(false);
  const [pendingScroll, setPendingScroll] = useState<{ idx: number; flash: boolean } | null>(null);
  // Markups persisted per sheet (docId → normalized fabric page states), so
  // annotating several sheets in one session never loses work.
  const [markupStore, setMarkupStore] = useState<Record<string, Record<number, object>>>({});
  const [sendingDraft, setSendingDraft] = useState(false);
  // Marked-up sheets render their BAKED PDF in the book so annotations are
  // visible IN CONTEXT the moment you close the editor (docId → blob URL).
  const [bakedUrls, setBakedUrls] = useState<Record<string, string>>({});
  const [bakingIds, setBakingIds] = useState<Set<string>>(() => new Set());
  const bakedUrlsRef = useRef<Record<string, string>>({});

  const rootRef = useRef<HTMLDivElement>(null);
  const sectionRefs = useRef<(HTMLDivElement | null)[]>([]);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const lastScrollTop = useRef(0);

  // Load versions + resolve presigned URLs for all docs
  useEffect(() => {
    let alive = true;
    const load = async () => {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      for (let i = 0; i < docs.length; i++) {
        const doc = docs[i];
        try {
          let fileUrl: string | null = null;
          if (doc.currentVersionId) {
            const { data } = await supabase.from("document_versions").select("file_url").eq("id", doc.currentVersionId).single();
            if (data?.file_url) fileUrl = data.file_url;
          }
          if (!fileUrl) {
            const { data } = await supabase.from("document_versions").select("file_url").eq("record_id", doc.id).order("created_at", { ascending: false }).limit(1);
            if (data && data.length > 0) fileUrl = data[0].file_url;
          }
          let resolvedUrl: string | null = null;
          if (fileUrl) {
            if (fileUrl.startsWith("http://") || fileUrl.startsWith("https://")) {
              resolvedUrl = fileUrl;
            } else if (token) {
              const res = await fetch(`/api/storage/download-url?path=${encodeURIComponent(fileUrl)}&expiresIn=3600`, { headers: { authorization: `Bearer ${token}` } });
              if (res.ok) { const { url } = await res.json(); resolvedUrl = url; }
            }
          }
          if (!alive) return;
          setEntries((prev) => { const next = [...prev]; next[i] = { doc, resolvedUrl, loading: false, error: null }; return next; });
        } catch {
          if (!alive) return;
          setEntries((prev) => { const next = [...prev]; next[i] = { ...next[i], loading: false, error: "Failed to load document" }; return next; });
        }
      }
    };
    load();
    return () => { alive = false; };
  }, [docs]);

  // Measure the live container so pages fit the viewport (then ×zoom).
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((obs) => {
      const r = obs[0]?.contentRect;
      if (r && r.width > 0) setContainerSize({ w: Math.round(r.width), h: Math.round(r.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Derived render width: fit-to-width fills whatever space is left after the
  // thumbnail rail (no cap — wide P&IDs go full-bleed); zoom multiplies on top.
  const effectiveRot = ((rotation % 360) + 360) % 360;
  const renderWidth = useMemo(() => {
    const availW = Math.max(280, containerSize.w - 24);
    return Math.max(200, Math.round(availW * zoom));
  }, [containerSize, zoom]);

  // Lazy-mount each doc's <Document> as it nears the viewport — keeps a large
  // book scalable (we don't fetch+parse every PDF up front) while staying smooth.
  useEffect(() => {
    const root = scrollContainerRef.current;
    if (!root || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (obs) => {
        const toAdd: number[] = [];
        for (const e of obs) {
          if (e.isIntersecting) {
            const idx = sectionRefs.current.indexOf(e.target as HTMLDivElement);
            if (idx >= 0) toAdd.push(idx);
          }
        }
        if (toAdd.length) {
          setMounted((prev) => {
            let changed = false;
            const next = new Set(prev);
            for (const i of toAdd) if (!next.has(i)) { next.add(i); changed = true; }
            return changed ? next : prev;
          });
        }
      },
      { root, rootMargin: "1400px 0px", threshold: 0 },
    );
    sectionRefs.current.forEach((el) => el && io.observe(el));
    return () => io.disconnect();
  }, [entries.length]);

  // Active sheet = the one whose top has passed a line ~35% down the viewport.
  // The same rAF-throttled handler drives chrome auto-hide (hide on scroll-down,
  // reveal on scroll-up) so reading a P&ID is pure canvas.
  useEffect(() => {
    const c = scrollContainerRef.current;
    if (!c) return;
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const mark = c.scrollTop + c.clientHeight * 0.35;
        let best = -1;
        let firstVisible = -1;
        for (let i = 0; i < sectionRefs.current.length; i++) {
          const el = sectionRefs.current[i];
          if (!el || el.offsetParent === null) continue; // skip sheets hidden by focus mode
          if (firstVisible < 0) firstVisible = i;
          if (el.offsetTop <= mark) best = i; else break;
        }
        const next = best >= 0 ? best : firstVisible;
        if (next >= 0) setActiveIdx((prev) => (prev === next ? prev : next));
        // Chrome auto-hide on scroll (unless pinned).
        const st = c.scrollTop;
        if (!pinChrome) {
          if (st > lastScrollTop.current + 6 && st > 140) setChromeVisible(false);
          else if (st < lastScrollTop.current - 6) setChromeVisible(true);
        }
        lastScrollTop.current = st;
      });
    };
    c.addEventListener("scroll", onScroll, { passive: true });
    return () => { c.removeEventListener("scroll", onScroll); if (raf) cancelAnimationFrame(raf); };
  }, [entries.length, pinChrome]);

  // Reveal the toolbar when the pointer nears the top edge; pinning keeps it up.
  const revealChrome = useCallback((y: number) => {
    if (y <= 76) { setChromeVisible(true); }
  }, []);
  useEffect(() => { if (pinChrome) setChromeVisible(true); }, [pinChrome]);

  // True browser fullscreen (escapes the tab chrome — "operate like a PDF viewer").
  const toggleFullscreen = useCallback(async () => {
    try {
      if (!document.fullscreenElement) await rootRef.current?.requestFullscreen?.();
      else await document.exitFullscreen?.();
    } catch { /* fullscreen denied — ignore */ }
  }, []);
  useEffect(() => {
    const onFs = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  // ── Focus set: a temporary subset of sheets to review without scrolling
  // past the rest. `picked` holds doc ids; focus mode hides everything else. ──
  const focusActive = focusMode && picked.size > 0;
  const isVisible = useCallback(
    (entryIdx: number) => !focusActive || picked.has(entries[entryIdx]?.doc.id ?? ""),
    [focusActive, picked, entries],
  );
  const visibleIdxs = useMemo(
    () => entries.map((_, i) => i).filter((i) => !focusActive || picked.has(entries[i].doc.id ?? "")),
    [entries, focusActive, picked],
  );
  const togglePick = useCallback((entryIdx: number) => {
    const id = entries[entryIdx]?.doc.id;
    if (!id) return;
    setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  }, [entries]);

  // Per-sheet searchable terms: tags + sheet#/doc#/name/rev + EVERY metadata
  // value — one clean, ranked, versatile result list (not just tags).
  const searchEntries = useMemo(() => entries.map((e, idx) => {
    const tags = collectTagGroups(e.doc.metadata as Record<string, unknown> | undefined, customColumns).flatMap((g) => g.tags);
    const meta = e.doc.metadata
      ? Object.values(e.doc.metadata).flatMap((v) => (Array.isArray(v) ? v.map(String) : v == null ? [] : [String(v)]))
      : [];
    const terms = Array.from(new Set([
      e.doc.documentNumber, e.doc.title, e.doc.name,
      e.doc.sheetNumber != null ? `Sheet ${e.doc.sheetNumber}` : null,
      e.doc.rev ? `Rev ${e.doc.rev}` : null,
      ...tags, ...meta,
    ].filter(Boolean) as string[]));
    return { idx, terms };
  }), [entries, customColumns]);

  // Rank every sheet by its best-matching term (typo-tolerant), capped + clean.
  const results = useMemo(() => {
    const q = search.trim();
    if (!q) return [] as Array<{ idx: number; score: number; matched: string }>;
    const scored: Array<{ idx: number; score: number; matched: string }> = [];
    for (const se of searchEntries) {
      const best = rankTags(q, se.terms, 1)[0];
      if (best) scored.push({ idx: se.idx, score: best.score, matched: best.tag });
    }
    scored.sort((a, b) => a.score - b.score || a.idx - b.idx);
    return scored.slice(0, 8);
  }, [search, searchEntries]);

  const flash = useCallback((idx: number) => {
    setFlashIdx(idx);
    setTimeout(() => setFlashIdx((f) => (f === idx ? null : f)), 1700);
  }, []);

  // Jump to a sheet. `addToFocus` brings a hidden sheet into the focus set
  // first (used by search "add"); the scroll is deferred until it's visible.
  const goToSheet = useCallback((entryIdx: number, opts?: { addToFocus?: boolean; flash?: boolean }) => {
    if (entryIdx < 0 || entryIdx >= entries.length) return;
    const id = entries[entryIdx]?.doc.id;
    setMounted((m) => (m.has(entryIdx) ? m : new Set(m).add(entryIdx)));
    if (opts?.addToFocus && id) setPicked((p) => (p.has(id) ? p : new Set(p).add(id)));
    setShowSuggest(false);
    setPendingScroll({ idx: entryIdx, flash: !!opts?.flash });
  }, [entries]);

  // Deferred scroll — runs after any focus change makes the target visible, so
  // "add to focus + jump" lands correctly.
  useEffect(() => {
    if (!pendingScroll) return;
    const { idx, flash: doFlash } = pendingScroll;
    const el = sectionRefs.current[idx];
    const c = scrollContainerRef.current;
    if (el && c && el.offsetParent !== null) {
      c.scrollTo({ top: Math.max(0, el.offsetTop - 4), behavior: "smooth" });
      setActiveIdx(idx);
      if (doFlash) flash(idx);
    }
    setPendingScroll(null);
  }, [pendingScroll, picked, focusMode, flash]);

  // Step to the next/previous VISIBLE sheet (skips ones hidden by focus mode).
  const step = useCallback((dir: number) => {
    const pos = visibleIdxs.indexOf(activeIdx);
    if (pos < 0) { if (visibleIdxs.length) goToSheet(visibleIdxs[0], { flash: false }); return; }
    const nextPos = pos + dir;
    if (nextPos >= 0 && nextPos < visibleIdxs.length) goToSheet(visibleIdxs[nextPos], { flash: false });
  }, [visibleIdxs, activeIdx, goToSheet]);

  // Enter focus mode (and land on its first sheet so the view isn't blank).
  const toggleFocus = useCallback(() => {
    if (!focusMode && picked.size > 0) {
      const first = entries.findIndex((e) => picked.has(e.doc.id ?? ""));
      if (first >= 0) setPendingScroll({ idx: first, flash: false });
    }
    setFocusMode((v) => !v);
  }, [focusMode, picked, entries]);

  // Enter: jump to the best-ranked sheet across tags + sheet#/name + all metadata.
  const runSearch = useCallback(() => {
    const q = search.trim();
    if (!q) { setSearchMsg(null); return; }
    if (results.length === 0) { setSearchMsg("No match"); return; }
    setSearchMsg(`${results.length} match${results.length === 1 ? "" : "es"}`);
    goToSheet(results[0].idx, { addToFocus: focusActive, flash: true });
  }, [search, results, goToSheet, focusActive]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === "Escape") { if (document.fullscreenElement) return; onClose(); }
      if (e.key === "ArrowRight" || e.key === "ArrowDown") step(1);
      if (e.key === "ArrowLeft" || e.key === "ArrowUp") step(-1);
      if (e.key === "f" || e.key === "F") void toggleFullscreen();
      if (e.key === "b" || e.key === "B") setSidebarOpen((v) => !v);
    },
    [onClose, step, toggleFullscreen]
  );

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  // A sheet is "marked up" once a saved page holds at least one object.
  const isMarkedUp = useCallback((docId: string | null | undefined) => {
    if (!docId) return false;
    const st = markupStore[docId];
    return !!st && Object.values(st).some((p) => ((p as { objects?: unknown[] }).objects?.length ?? 0) > 0);
  }, [markupStore]);
  const markedUpIds = useMemo(
    () => entries.map((e) => e.doc.id).filter((id): id is string => isMarkedUp(id)),
    [entries, isMarkedUp],
  );

  // Re-bake a sheet's PDF with its markups for in-book display. No markups → drop
  // the baked copy so the clean original shows again.
  const rebakeDoc = useCallback(async (docId: string, states: Record<number, object>) => {
    const entry = entries.find((e) => e.doc.id === docId);
    if (!entry?.resolvedUrl) return;
    const hasContent = Object.values(states).some((p) => ((p as { objects?: unknown[] }).objects?.length ?? 0) > 0);
    if (!hasContent) {
      setBakedUrls((prev) => {
        const next = { ...prev };
        if (next[docId]) URL.revokeObjectURL(next[docId]);
        delete next[docId];
        return next;
      });
      return;
    }
    setBakingIds((s) => new Set(s).add(docId));
    try {
      const res = await fetch(entry.resolvedUrl);
      const bytes = new Uint8Array(await res.arrayBuffer());
      const baked = await bakeMarkupIntoPdf(bytes, states);
      const url = URL.createObjectURL(new Blob([baked as BlobPart], { type: "application/pdf" }));
      setBakedUrls((prev) => {
        const next = { ...prev };
        if (next[docId]) URL.revokeObjectURL(next[docId]);
        next[docId] = url;
        return next;
      });
    } catch (e) {
      console.error("Re-bake for in-book display failed", e);
    } finally {
      setBakingIds((s) => { const n = new Set(s); n.delete(docId); return n; });
    }
  }, [entries]);

  // Track blob URLs in a ref so we can revoke them all on unmount (no leaks).
  useEffect(() => { bakedUrlsRef.current = bakedUrls; }, [bakedUrls]);
  useEffect(() => () => { Object.values(bakedUrlsRef.current).forEach((u) => URL.revokeObjectURL(u)); }, []);

  const activeEntry = entries[activeIdx];
  const activeControlState = activeEntry?.doc && currentUserId ? determineControlState(activeEntry.doc, currentUserId) : "uncontrolled";
  const activeControlled = activeControlState === "controlled";
  const activeTagGroups = activeEntry?.doc ? collectTagGroups(activeEntry.doc.metadata as Record<string, unknown> | undefined, customColumns) : [];

  // Single-document download / print for the currently focused doc
  const runDocAction = async (type: "download" | "print") => {
    if (!activeEntry?.resolvedUrl || !currentUserId) return;
    setDocBusy(true);
    setActionError(null);
    try {
      const ctx = { doc: activeEntry.doc, fileUrl: activeEntry.resolvedUrl, userId: currentUserId, userEmail: currentUserEmail ?? null, userLabel: currentUserEmail ?? null };
      if (type === "download") await downloadDocumentPdf(ctx);
      else await printDocumentPdf(ctx);
      setDownloadConfirm(null);
    } catch (e) {
      setActionError((e as Error).message || "Action failed");
    } finally {
      setDocBusy(false);
    }
  };

  // Merge every resolved PDF into a single stamped (uncontrolled) PDF.
  const downloadBookMerged = async () => {
    if (!currentUserId) return;
    const ready = entries.filter((e) => e.resolvedUrl);
    if (ready.length === 0) return;
    setBookBusy(true);
    setActionError(null);
    try {
      const merged = await PDFDocument.create();
      const now = new Date();
      const expiresAt = new Date(now.getTime() + 24 * 3600 * 1000);
      for (const entry of ready) {
        try {
          const stamped = await stampPdf(entry.resolvedUrl!, {
            userLabel: currentUserEmail ?? undefined,
            email: currentUserEmail ?? undefined,
            timestamp: now,
            expiresAt,
            watermarkText: `UNCONTROLLED — ${entry.doc.documentNumber || "DOC"} Rev ${entry.doc.rev || "-"}`,
          });
          const buf = await stamped.arrayBuffer();
          const src = await PDFDocument.load(buf);
          const copied = await merged.copyPages(src, src.getPageIndices());
          copied.forEach((p) => merged.addPage(p));
        } catch (e) {
          console.error("Failed to add doc to book", entry.doc.documentNumber, e);
        }
      }
      const bytes = await merged.save();
      const blob = new Blob([bytes as BlobPart], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `Reference_Book_${ready.length}_docs_UNCONTROLLED.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      const rows = ready.map((e) => ({
        org_id: e.doc.orgId ?? null,
        document_id: e.doc.id ?? null,
        user_id: currentUserId,
        user_email: currentUserEmail ?? null,
        created_at: now.toISOString(),
        expires_at: expiresAt.toISOString(),
        watermark_policy_id: null,
      }));
      try { await supabase.from("download_audits").insert(rows); } catch (e) { console.error(e); }
      setDownloadConfirm(null);
    } catch (e) {
      setActionError((e as Error).message || "Book download failed");
    } finally {
      setBookBusy(false);
    }
  };

  const requestDocDownload = () => {
    if (!activeEntry?.resolvedUrl || !currentUserId) return;
    if (activeControlled) void runDocAction("download");
    else setDownloadConfirm({ type: "download" });
  };
  const requestDocPrint = () => {
    if (!activeEntry?.resolvedUrl || !currentUserId) return;
    if (activeControlled) void runDocAction("print");
    else setDownloadConfirm({ type: "print" });
  };
  const requestBookDownload = () => setDownloadConfirm({ type: "book" });

  // Bake every marked-up sheet's annotations into its PDF, stash them, and open
  // a NEW drafting request with all of them pre-attached — so you can mark up a
  // few sheets and send them together, markups included.
  const sendMarkupsToDrafting = async () => {
    if (markedUpIds.length === 0 || sendingDraft) return;
    setSendingDraft(true);
    try {
      const files: DraftHandoffFile[] = [];
      for (const id of markedUpIds) {
        const entry = entries.find((e) => e.doc.id === id);
        if (!entry?.resolvedUrl || !markupStore[id]) continue;
        const res = await fetch(entry.resolvedUrl);
        if (!res.ok) continue;
        const bytes = new Uint8Array(await res.arrayBuffer());
        const baked = await bakeMarkupIntoPdf(bytes, markupStore[id]);
        const stem = `${entry.doc.documentNumber || entry.doc.title || "sheet"}${entry.doc.rev ? `_Rev${entry.doc.rev}` : ""}_markup`.replace(/[^\w.\-]+/g, "_");
        files.push({ name: `${stem}.pdf`, blob: new Blob([baked as BlobPart], { type: "application/pdf" }), docId: id, docNumber: entry.doc.documentNumber });
      }
      if (files.length === 0) {
        setSendingDraft(false);
        await appAlert("Couldn't prepare any marked-up sheets.");
        return;
      }
      // Rich prefill so the requester only adds their notes: doc number · rev ·
      // sheet · title per sheet, plus a shared Unit if they all belong to one.
      const docsForFiles = files
        .map((f) => entries.find((e) => e.doc.id === f.docId)?.doc)
        .filter((d): d is DocumentRecord => !!d);
      const metaVal = (d: DocumentRecord, re: RegExp): string | null => {
        const m = (d.metadata ?? {}) as Record<string, unknown>;
        for (const [kk, vv] of Object.entries(m)) if (re.test(kk) && vv != null && vv !== "") return String(vv);
        return null;
      };
      const sheetOf = (d: DocumentRecord) => (d.sheetNumber != null ? String(d.sheetNumber) : metaVal(d, /sheet/i));
      const unitOf = (d: DocumentRecord) => metaVal(d, /\bunit\b|\barea\b/i);
      const units = Array.from(new Set(docsForFiles.map(unitOf).filter((u): u is string => !!u)));
      const unit = units.length === 1 ? units[0] : "";
      const lines = docsForFiles.map((d) => {
        const sheet = sheetOf(d);
        return `• ${d.documentNumber || d.title || "Document"}${d.rev ? ` Rev ${d.rev}` : ""}${sheet ? ` · Sheet ${sheet}` : ""}${d.title ? ` — ${d.title}` : ""}`;
      });
      const description = [
        "Marked-up sheets, attached as Source files:",
        ...lines,
        unit ? `\nUnit: ${unit}` : "",
        "\nWhat needs to change:\n- ",
      ].filter(Boolean).join("\n");

      const key = await stashDraft(files);
      const params = new URLSearchParams({
        title: `Markups: ${files.length} sheet${files.length === 1 ? "" : "s"}${unit ? ` · Unit ${unit}` : ""}`,
        description,
        draft: key,
      });
      if (unit) params.set("unit", unit);
      router.push(`/requests/new?${params.toString()}`);
    } catch (e) {
      console.error("Send markups to drafting failed", e);
      setSendingDraft(false);
      await appAlert(`Couldn't prepare markups: ${(e as Error).message || "unknown error"}`);
    }
  };

  const showChrome = chromeVisible || pinChrome || moreOpen || showSuggest || !!downloadConfirm;
  const iconBtn = "p-1.5 rounded-lg hover:bg-white/10 text-slate-300 hover:text-white disabled:opacity-30 disabled:hover:bg-transparent transition-colors";

  return (
    <div
      ref={rootRef}
      className="fixed inset-0 z-[85] bg-slate-950 animate-in fade-in duration-200 flex"
      onMouseMove={(e) => revealChrome(e.clientY)}
    >
      {/* ── THUMBNAIL RAIL (push panel; never overlaps the page) ── */}
      <div className={`${sidebarOpen ? "w-52" : "w-0"} shrink-0 bg-slate-900 border-r border-slate-800 overflow-hidden transition-[width] duration-200 flex flex-col`}>
        <div className="px-3 py-2.5 border-b border-slate-800 flex items-center gap-2 shrink-0">
          <BookOpen className="w-4 h-4 text-orange-400 shrink-0" />
          <span className="text-sm font-bold text-white truncate">Reference Book</span>
          <span className="text-[10px] font-black bg-orange-500 text-white px-1.5 py-0.5 rounded-full">{docs.length}</span>
          <button onClick={() => setSidebarOpen(false)} className="ml-auto p-1 rounded text-slate-400 hover:text-white hover:bg-slate-800" title="Hide thumbnails (B)"><PanelLeftClose className="w-4 h-4" /></button>
        </div>
        {/* Focus controls — review just the sheets you pin. */}
        <div className="px-3 py-2 flex items-center gap-2 shrink-0 border-b border-slate-800/60">
          <button
            onClick={toggleFocus}
            disabled={picked.size === 0}
            title={picked.size === 0 ? "Pin sheets below, then focus on just those" : focusActive ? "Show all sheets" : "Show only your pinned sheets"}
            className={`flex-1 inline-flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg text-[11px] font-bold transition-colors disabled:opacity-40 ${focusActive ? "bg-orange-600 text-white" : "bg-slate-800 text-slate-300 hover:text-white"}`}
          >
            <Layers className="w-3.5 h-3.5" /> {focusActive ? "Focused" : "Focus"}{picked.size > 0 ? ` (${picked.size})` : ""}
          </button>
          {picked.size > 0 && (
            <button onClick={() => { setPicked(new Set()); setFocusMode(false); }} title="Clear pinned set" className="px-2 py-1.5 rounded-lg text-[11px] font-bold text-slate-400 hover:text-white hover:bg-slate-800">Clear</button>
          )}
        </div>
        {/* Thumbnails — the one and only nav, labelled with the first two visible
            table columns. */}
        <div className="flex-1 overflow-y-auto custom-scrollbar p-2 space-y-2">
          {entries.map((entry, idx) => {
            const id = entry.doc.id ?? "";
            const isPicked = picked.has(id);
            const lines = (labelColumns && labelColumns.length ? labelColumns : [{ key: "documentNumber", label: "" }, { key: "title", label: "" }])
              .slice(0, 2).map((c) => cellText(entry.doc, c.key)).filter(Boolean);
            return (
              <div key={id} className={`relative group rounded-lg overflow-hidden border-2 transition-colors ${activeIdx === idx ? "border-orange-500" : "border-slate-700 hover:border-slate-500"} ${focusActive && !isPicked ? "opacity-40" : ""}`}>
                <button onClick={() => goToSheet(idx, { flash: true, addToFocus: !isVisible(idx) })} className="block w-full text-left" title={lines.join(" · ")}>
                  <PageThumb url={entry.resolvedUrl} width={188} />
                  <div className="px-2 py-1.5 bg-slate-950/90">
                    <div className="text-[11px] font-mono font-bold text-slate-100 truncate">{lines[0] || `Sheet ${idx + 1}`}</div>
                    {lines[1] && <div className="text-[10px] text-slate-400 truncate leading-snug">{lines[1]}</div>}
                    {entry.loading && <div className="flex items-center gap-1 mt-0.5"><Loader2 className="w-2.5 h-2.5 animate-spin text-orange-500" /><span className="text-[9px] text-slate-600">Loading…</span></div>}
                  </div>
                </button>
                <div className="absolute top-1 left-1 w-4 h-4 rounded-full bg-orange-500 flex items-center justify-center text-[8px] font-black text-white shadow pointer-events-none">{idx + 1}</div>
                <button onClick={() => togglePick(idx)} title={isPicked ? "Remove from focus set" : "Pin to focus set"} className={`absolute top-1 right-1 p-1 rounded-md transition-opacity ${isPicked ? "text-orange-400 bg-slate-950/70" : "text-slate-200 bg-slate-950/50 opacity-0 group-hover:opacity-100"}`}>
                  <Pin className={`w-3 h-3 ${isPicked ? "fill-orange-400" : ""}`} />
                </button>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── MAIN (PDF fills whatever space the rail leaves) ── */}
      <div className="relative flex-1 min-w-0">
        {/* ── FULL-BLEED PAGE STACK ── */}
        <div ref={scrollContainerRef} className="absolute inset-0 overflow-y-auto bg-slate-950">
        {/* Spacer so the first sheet clears the floating toolbar when shown. */}
        <div className="h-12 shrink-0" />
        {entries.map((entry, idx) => (
          <div key={entry.doc.id} ref={(el) => { sectionRefs.current[idx] = el; }} style={{ display: isVisible(idx) ? undefined : "none" }} className={`flex flex-col ${flashIdx === idx ? "ring-4 ring-orange-500/70 ring-inset" : ""}`}>
            {/* Slim, translucent per-sheet header — keeps Markup + pin reachable
                without eating the page. Rides just below the toolbar when it's
                shown, slides to the very top when the toolbar hides. */}
            <div className="sticky z-10 bg-slate-900/80 backdrop-blur-sm border-y border-slate-800/80 px-4 py-1.5 flex items-center gap-3 transition-[top] duration-200" style={{ top: showChrome ? 52 : 0 }}>
              <div className="w-5 h-5 rounded-full bg-orange-500 flex items-center justify-center text-[9px] font-black text-white shrink-0">{idx + 1}</div>
              <span className="text-[11px] font-mono font-bold text-orange-400 shrink-0">{entry.doc.documentNumber || "—"}</span>
              <span className="text-[11px] text-slate-300 font-medium truncate">{entry.doc.title || entry.doc.name}</span>
              <div className="ml-auto flex items-center gap-2 shrink-0">
                <span className="text-[10px] text-slate-500 hidden sm:inline">Rev {entry.doc.rev || "—"}</span>
                <span className="text-[10px] text-slate-600 bg-slate-800 px-1.5 py-0.5 rounded hidden md:inline">{entry.doc.status || "—"}</span>
                {bakingIds.has(entry.doc.id ?? "") && (
                  <span className="text-[10px] text-emerald-300 inline-flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> applying…</span>
                )}
                <button
                  onClick={() => togglePick(idx)}
                  title={picked.has(entry.doc.id ?? "") ? "Remove from focus set" : "Add to focus set — review just the sheets you need"}
                  className={`text-[10px] font-bold inline-flex items-center gap-1 px-2 py-0.5 rounded-md border transition-colors ${picked.has(entry.doc.id ?? "") ? "bg-orange-500/20 border-orange-500/50 text-orange-300" : "bg-slate-800 border-slate-700 text-slate-300 hover:text-white"}`}
                >
                  <Pin className={`w-3 h-3 ${picked.has(entry.doc.id ?? "") ? "fill-orange-400" : ""}`} /> {picked.has(entry.doc.id ?? "") ? "Focused" : "Focus"}
                </button>
                <button
                  onClick={() => setEditingDoc(entry.doc)}
                  title={isMarkedUp(entry.doc.id) ? "Edit this sheet's saved markups" : "Mark up this sheet (pen, highlight, shapes, stamps) + equipment tags"}
                  className={`text-[10px] font-bold inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-white ${isMarkedUp(entry.doc.id) ? "bg-emerald-600 hover:bg-emerald-500" : "bg-orange-600 hover:bg-orange-500"}`}
                >
                  <Pen className="w-3 h-3" /> {isMarkedUp(entry.doc.id) ? "Marked up" : "Markup"}
                </button>
              </div>
            </div>

            {/* Pages — real canvases at fit-width (no cap), no nested scroll. */}
            <div className="flex flex-col items-center gap-3 py-3 px-1 min-h-[40vh]">
              {entry.loading ? (
                <div className="flex flex-col items-center justify-center gap-4 text-slate-500 py-20">
                  <Loader2 className="w-10 h-10 animate-spin text-orange-500" />
                  <span className="text-sm font-mono text-orange-400/70 animate-pulse">Loading {entry.doc.documentNumber || "document"}…</span>
                </div>
              ) : entry.error || !entry.resolvedUrl ? (
                <div className="flex flex-col items-center justify-center gap-3 text-slate-600 py-20">
                  <FileText className="w-16 h-16 opacity-20" />
                  <span className="text-sm font-medium">{entry.error || "No file available for this document"}</span>
                </div>
              ) : mounted.has(idx) ? (
                <Document
                  file={bakedUrls[entry.doc.id ?? ""] ?? entry.resolvedUrl}
                  onLoadSuccess={({ numPages }) => setPageCounts((c) => (c[idx] === numPages ? c : { ...c, [idx]: numPages }))}
                  loading={<div className="flex items-center justify-center py-20"><Loader2 className="w-8 h-8 animate-spin text-orange-500" /></div>}
                  error={<div className="flex flex-col items-center gap-2 text-slate-600 py-20"><FileText className="w-12 h-12 opacity-20" /><span className="text-xs">Couldn’t render this PDF</span></div>}
                  className="flex flex-col items-center gap-3"
                >
                  {Array.from({ length: pageCounts[idx] ?? 0 }).map((_, p) => (
                    <div key={p} className="shadow-xl shadow-black/40 bg-white">
                      <Page
                        pageNumber={p + 1}
                        width={renderWidth}
                        rotate={effectiveRot}
                        renderTextLayer={false}
                        renderAnnotationLayer={false}
                        loading={<div className="bg-slate-800 animate-pulse" style={{ width: renderWidth, height: Math.round(renderWidth * 1.3) }} />}
                      />
                    </div>
                  ))}
                </Document>
              ) : (
                // Not yet mounted (offscreen) — a light placeholder keeps layout stable.
                <div className="bg-slate-900/40 rounded-lg flex items-center justify-center text-slate-700" style={{ width: renderWidth, height: Math.round(renderWidth * 1.3) }}>
                  <FileText className="w-10 h-10 opacity-20" />
                </div>
              )}
            </div>
          </div>
        ))}
        <div className="h-16 bg-slate-950" />
      </div>

      {/* ── Hover reveal strip at the very top (when chrome is hidden) ── */}
      {!showChrome && (
        <div className="absolute top-0 inset-x-0 h-3 z-40" onMouseEnter={() => setChromeVisible(true)} />
      )}

      {/* ── FLOATING TOP TOOLBAR (overlay, auto-hides) ── */}
      <div className={`absolute top-0 inset-x-0 z-50 transition-transform duration-200 ${showChrome ? "translate-y-0" : "-translate-y-full"}`}>
        <div className="m-2 rounded-xl bg-slate-900/90 backdrop-blur border border-slate-700/80 shadow-2xl shadow-black/40 px-2 py-1.5 flex items-center gap-2">
          <button onClick={() => setSidebarOpen((v) => !v)} className={iconBtn} title="Pages & contents (B)"><Menu className="w-4 h-4" /></button>
          <div className="hidden sm:flex items-center gap-1.5 min-w-0">
            <BookOpen className="w-4 h-4 text-orange-400 shrink-0" />
            <span className="text-xs font-bold text-white truncate max-w-[140px]">Reference Book</span>
            <span className="shrink-0 text-[10px] font-black bg-orange-500 text-white px-1.5 py-0.5 rounded-full">{docs.length}</span>
          </div>

          <div className="w-px h-5 bg-slate-700 hidden sm:block" />

          {/* Page nav */}
          <div className="flex items-center gap-0.5 shrink-0">
            <button onClick={() => step(-1)} disabled={visibleIdxs.indexOf(activeIdx) <= 0} className={iconBtn} title="Previous sheet (↑)"><ChevronLeft className="w-4 h-4" /></button>
            <span className="text-[11px] text-slate-400 px-1 font-mono whitespace-nowrap">{Math.max(1, visibleIdxs.indexOf(activeIdx) + 1)} / {visibleIdxs.length}</span>
            <button onClick={() => step(1)} disabled={visibleIdxs.indexOf(activeIdx) >= visibleIdxs.length - 1} className={iconBtn} title="Next sheet (↓)"><ChevronRight className="w-4 h-4" /></button>
          </div>

          {/* Tag search */}
          <div className="relative min-w-0 flex-1 max-w-sm">
            <div className="flex items-center gap-1.5 bg-slate-950/70 border border-slate-600 rounded-lg px-2.5 py-1.5 shadow-inner transition-all focus-within:border-orange-500 focus-within:ring-2 focus-within:ring-orange-500/30">
              <Search className="w-4 h-4 text-orange-400 shrink-0" />
              <input
                ref={searchInputRef}
                value={search}
                onChange={(e) => { setSearch(e.target.value); setSearchMsg(null); setShowSuggest(true); setSuggestIdx(-1); }}
                onFocus={() => { setChromeVisible(true); if (search) setShowSuggest(true); }}
                onBlur={() => setTimeout(() => setShowSuggest(false), 120)}
                onKeyDown={(e) => {
                  if (e.key === "ArrowDown") { e.preventDefault(); if (results.length) { setShowSuggest(true); setSuggestIdx((i) => Math.min(results.length - 1, i + 1)); } }
                  else if (e.key === "ArrowUp") { e.preventDefault(); setSuggestIdx((i) => Math.max(-1, i - 1)); }
                  else if (e.key === "Enter") {
                    e.preventDefault();
                    if (showSuggest && suggestIdx >= 0 && results[suggestIdx]) goToSheet(results[suggestIdx].idx, { addToFocus: focusActive, flash: true });
                    else runSearch();
                  } else if (e.key === "Escape") {
                    setShowSuggest(false);
                  }
                }}
                placeholder="Find a sheet, tag, #…"
                className="bg-transparent text-xs font-medium text-white placeholder:text-slate-400 outline-none w-full min-w-0"
                title="Search anything — equipment tag, sheet #, document name or any metadata. Typo-tolerant (P-34 = p34). Enter jumps; + pins a sheet to your focus set."
              />
              {searchMsg && <span className={`text-[10px] font-bold shrink-0 ${searchMsg === "No match" ? "text-rose-400" : "text-emerald-400"}`}>{searchMsg}</span>}
              {search ? (
                <button onMouseDown={(e) => { e.preventDefault(); setSearch(""); setSearchMsg(null); setShowSuggest(false); searchInputRef.current?.focus(); }} title="Clear" className="shrink-0 p-0.5 text-slate-400 hover:text-white"><X className="w-3.5 h-3.5" /></button>
              ) : (
                <kbd className="hidden lg:inline shrink-0 text-[9px] font-bold text-slate-400 border border-slate-600 rounded px-1 py-px">↵</kbd>
              )}
            </div>

            {showSuggest && results.length > 0 && (
              <div className="absolute top-full left-0 right-0 mt-1 z-50 bg-slate-900 border border-slate-700 rounded-lg shadow-2xl shadow-black/50 overflow-hidden py-1 max-h-80 overflow-y-auto">
                {results.map((r, i) => {
                  const e = entries[r.idx];
                  const id = e?.doc.id ?? "";
                  const isPicked = picked.has(id);
                  return (
                    <div key={r.idx} onMouseEnter={() => setSuggestIdx(i)} className={`flex items-stretch transition-colors ${i === suggestIdx ? "bg-orange-500/20" : "hover:bg-slate-800"}`}>
                      <button
                        onMouseDown={(ev) => { ev.preventDefault(); goToSheet(r.idx, { addToFocus: focusActive, flash: true }); }}
                        className="flex-1 min-w-0 text-left px-3 py-1.5"
                      >
                        <div className="flex items-center gap-2 text-xs">
                          <span className="font-mono font-bold text-white truncate">{e?.doc.documentNumber || `Sheet ${r.idx + 1}`}</span>
                          <span className="text-[10px] text-slate-400 truncate">{e?.doc.title || e?.doc.name}</span>
                        </div>
                        <div className="text-[10px] text-orange-300/80 truncate">matched “{r.matched}”</div>
                      </button>
                      <button
                        onMouseDown={(ev) => { ev.preventDefault(); togglePick(r.idx); }}
                        title={isPicked ? "Remove from focus set" : "Add this sheet to your focus set"}
                        className={`shrink-0 px-2.5 flex items-center border-l border-slate-800 transition-colors ${isPicked ? "text-orange-400" : "text-slate-500 hover:text-white"}`}
                      >
                        {isPicked ? <Check className="w-3.5 h-3.5" /> : <Plus className="w-3.5 h-3.5" />}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Zoom / fit-width / rotate cluster */}
          <div className="hidden md:flex items-center gap-0.5 bg-slate-800/80 rounded-lg px-1 py-0.5 shrink-0">
            <button onClick={() => setZoom((z) => Math.max(0.4, Math.round((z - 0.15) * 100) / 100))} className={iconBtn} title="Zoom out"><ZoomOut className="w-4 h-4" /></button>
            <button onClick={() => setZoom(1)} className={`${iconBtn} ${zoom === 1 ? "text-orange-300" : ""}`} title="Fit to width — reset zoom to 100%"><span className="text-[11px] font-mono w-9 text-center inline-block">{Math.round(zoom * 100)}%</span></button>
            <button onClick={() => setZoom((z) => Math.min(3, Math.round((z + 0.15) * 100) / 100))} className={iconBtn} title="Zoom in"><ZoomIn className="w-4 h-4" /></button>
            <div className="w-px h-4 bg-slate-700 mx-0.5" />
            <button onClick={() => setRotation((r) => r + 90)} className={iconBtn} title="Rotate 90°"><RotateCw className="w-4 h-4" /></button>
          </div>

          {/* Focus toggle */}
          {picked.size > 0 && (
            <button onClick={toggleFocus} title={focusActive ? "Show all sheets" : "Show only your pinned sheets"} className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-bold shrink-0 transition-colors ${focusActive ? "bg-orange-600 text-white" : "bg-slate-800 text-slate-200 hover:bg-slate-700"}`}>
              <Layers className="w-3.5 h-3.5" /> {focusActive ? "Focused" : "Focus"} {picked.size}
            </button>
          )}

          {activeEntry?.doc && currentUserId && (
            <span className={`hidden xl:inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-[10px] font-bold shrink-0 ${activeControlled ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/30" : "bg-amber-500/10 text-amber-400 border border-amber-500/30"}`}>
              {activeControlled ? <ShieldCheck className="w-3 h-3" /> : <ShieldAlert className="w-3 h-3" />}
              {activeControlled ? "Controlled" : "Uncontrolled"}
            </span>
          )}

          {markedUpIds.length > 0 && (
            <button onClick={() => void sendMarkupsToDrafting()} disabled={sendingDraft} title="Send all marked-up sheets (with your markups baked in) to one new drafting request" className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-[11px] font-bold disabled:opacity-50 shrink-0">
              {sendingDraft ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
              <span className="hidden lg:inline">Send Markups</span> ({markedUpIds.length})
            </button>
          )}

          {/* Overflow menu — the less-frequent actions, tucked away. */}
          <div className="relative shrink-0 ml-auto">
            <button onClick={() => setMoreOpen((v) => !v)} className={`${iconBtn} ${moreOpen ? "bg-white/10 text-white" : ""}`} title="More actions"><MoreHorizontal className="w-4 h-4" /></button>
            {moreOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setMoreOpen(false)} />
                <div className="absolute top-full right-0 mt-1 z-50 w-52 bg-slate-900 border border-slate-700 rounded-xl shadow-2xl shadow-black/60 py-1.5">
                  <button onClick={() => { setMoreOpen(false); requestDocDownload(); }} disabled={!activeEntry?.resolvedUrl || !currentUserId || docBusy} className="w-full px-3 py-2 text-left text-xs font-medium text-slate-200 hover:bg-slate-800 flex items-center gap-2.5 disabled:opacity-40"><Download className="w-3.5 h-3.5 text-slate-400" /> Download this sheet</button>
                  <button onClick={() => { setMoreOpen(false); requestDocPrint(); }} disabled={!activeEntry?.resolvedUrl || !currentUserId || docBusy} className="w-full px-3 py-2 text-left text-xs font-medium text-slate-200 hover:bg-slate-800 flex items-center gap-2.5 disabled:opacity-40"><Printer className="w-3.5 h-3.5 text-slate-400" /> Print this sheet</button>
                  <div className="my-1 border-t border-slate-800" />
                  <button onClick={() => { setMoreOpen(false); setShowBulkCheckout(true); }} disabled={!currentUserId || docs.length === 0} className="w-full px-3 py-2 text-left text-xs font-medium text-slate-200 hover:bg-slate-800 flex items-center gap-2.5 disabled:opacity-40"><Briefcase className="w-3.5 h-3.5 text-indigo-400" /> Checkout all to project</button>
                  <button onClick={() => { setMoreOpen(false); requestBookDownload(); }} disabled={bookBusy || !currentUserId} className="w-full px-3 py-2 text-left text-xs font-medium text-slate-200 hover:bg-slate-800 flex items-center gap-2.5 disabled:opacity-40">{bookBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin text-orange-400" /> : <Library className="w-3.5 h-3.5 text-orange-400" />} Download merged book</button>
                  <div className="my-1 border-t border-slate-800" />
                  <button onClick={() => { setPinChrome((v) => !v); }} className="w-full px-3 py-2 text-left text-xs font-medium text-slate-200 hover:bg-slate-800 flex items-center gap-2.5"><Pin className={`w-3.5 h-3.5 ${pinChrome ? "fill-orange-400 text-orange-400" : "text-slate-400"}`} /> {pinChrome ? "Unpin toolbar" : "Keep toolbar visible"}</button>
                </div>
              </>
            )}
          </div>

          <button onClick={() => void toggleFullscreen()} className={iconBtn} title={isFullscreen ? "Exit full screen (F)" : "Full screen (F)"}>
            {isFullscreen ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
          </button>
          <button onClick={onClose} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-white text-xs font-bold transition-colors shrink-0" title="Close (Esc)">
            <X className="w-3.5 h-3.5" /> <span className="hidden sm:inline">Close</span>
          </button>
        </div>
      </div>

      {/* ── FLOATING TAG RIBBON (collapsible overlay) ── */}
      {orgId && activeEntry?.doc && activeTagGroups.length > 0 && (
        tagsBarOpen ? (
          <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-40 max-w-[90vw] w-auto bg-slate-900/90 backdrop-blur border border-slate-700 rounded-xl shadow-2xl shadow-black/50 px-3 py-1.5 flex items-center gap-2">
            <span className="text-[9px] font-black uppercase tracking-widest text-slate-500 shrink-0 hidden sm:inline">Tags · sheet {activeIdx + 1}</span>
            <div className="min-w-0">
              <EquipmentTagsStrip metadata={activeEntry.doc.metadata as Record<string, unknown>} customColumns={customColumns} orgId={orgId} userId={currentUserId} canManage={false} variant="ribbon" />
            </div>
            <button onClick={() => setTagsBarOpen(false)} title="Hide tag bar" className="shrink-0 p-1 rounded text-white/50 hover:text-white hover:bg-white/10"><X className="w-3.5 h-3.5" /></button>
          </div>
        ) : (
          <button onClick={() => setTagsBarOpen(true)} className="absolute bottom-3 left-1/2 -translate-x-1/2 z-40 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-slate-900/90 backdrop-blur border border-slate-700 text-white/80 hover:text-white text-[11px] font-bold shadow-xl" title="Show equipment tags for this sheet">
            <Camera className="w-3.5 h-3.5" /> Tags · sheet {activeIdx + 1}
          </button>
        )
      )}

      {/* Single-doc full-screen editor (markup + equipment tags). */}
      {editingDoc && (() => {
        const entry = entries.find((e) => e.doc.id === editingDoc.id);
        if (!entry?.resolvedUrl) return null;
        return (
          <FullScreenViewer
            key={editingDoc.id ?? "doc"}
            isOpen
            onClose={() => setEditingDoc(null)}
            url={entry.resolvedUrl}
            title={editingDoc.title || editingDoc.name || ""}
            docNumber={editingDoc.documentNumber || ""}
            rev={editingDoc.rev || ""}
            document={editingDoc}
            userRole={userRole}
            currentUserId={currentUserId}
            currentUserEmail={currentUserEmail}
            orgId={orgId}
            customColumns={customColumns}
            initialPageStates={markupStore[editingDoc.id ?? ""]}
            onCommit={async (states) => {
              const id = editingDoc.id ?? "";
              setMarkupStore((prev) => ({ ...prev, [id]: states }));
              await rebakeDoc(id, states);
              // Let the book render the baked sheet behind the editor before it closes.
              await new Promise((r) => setTimeout(r, 250));
            }}
          />
        );
      })()}

      {showBulkCheckout && orgId && currentUserId && (
        <BulkCheckoutToProjectModal
          isOpen={showBulkCheckout}
          onClose={() => setShowBulkCheckout(false)}
          docs={docs}
          orgId={orgId}
          actorUserId={currentUserId}
          actorEmail={currentUserEmail}
          actorRole={userRole || ""}
          onSuccess={() => { setShowBulkCheckout(false); onClose(); }}
        />
      )}

      {/* Uncontrolled confirmation modal */}
      {downloadConfirm && (
        <div className="fixed inset-0 z-[120] bg-slate-900/70 backdrop-blur-sm flex items-start sm:items-center justify-center overflow-y-auto p-6">
          <div className="w-full max-w-md rounded-2xl bg-white shadow-2xl border border-slate-200 overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center gap-3">
              <div className="p-2 bg-amber-100 rounded-lg"><ShieldAlert className="w-5 h-5 text-amber-700" /></div>
              <div>
                <div className="text-sm font-black text-slate-900">Uncontrolled Copy</div>
                <div className="text-xs text-slate-500">{downloadConfirm.type === "book" ? "Reference books are always uncontrolled." : "You don't have this document checked out."}</div>
              </div>
            </div>
            <div className="px-6 py-4 text-sm text-slate-700 space-y-3">
              <p>
                {downloadConfirm.type === "book" ? (
                  <>Every page of every document in this book will be stamped with a diagonal &quot;UNCONTROLLED — FOR REVIEW ONLY&quot; watermark and a footer with your email and the timestamp. All documents will be logged to the audit trail.</>
                ) : (
                  <>Every page will be stamped with a diagonal &quot;UNCONTROLLED — FOR REVIEW ONLY&quot; watermark plus a footer with your email and the timestamp. The action will be logged.</>
                )}
              </p>
              {actionError && <p className="text-xs text-red-600 font-mono bg-red-50 border border-red-200 rounded-lg p-2">{actionError}</p>}
            </div>
            <div className="px-6 py-3 bg-slate-50 border-t border-slate-200 flex items-center justify-end gap-2">
              <button onClick={() => { setDownloadConfirm(null); setActionError(null); }} disabled={docBusy || bookBusy} className="px-3 py-2 rounded-lg text-xs font-bold text-slate-700 bg-white border border-slate-200 hover:bg-slate-100 disabled:opacity-50">Cancel</button>
              <button
                onClick={() => { if (downloadConfirm.type === "book") void downloadBookMerged(); else void runDocAction(downloadConfirm.type); }}
                disabled={docBusy || bookBusy}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold text-white bg-amber-600 hover:bg-amber-700 disabled:opacity-60"
              >
                {(docBusy || bookBusy) && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                {downloadConfirm.type === "book" ? "Download stamped book" : downloadConfirm.type === "download" ? "Download stamped copy" : "Print stamped copy"}
              </button>
            </div>
          </div>
        </div>
      )}
      </div>
    </div>
  );
}
