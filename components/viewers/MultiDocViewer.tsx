"use client";

// MultiDocViewer — the combined "Reference Book".
//
// Renders many documents as ONE continuous, smoothly-scrolling stack of real
// PDF pages (react-pdf canvases — no nested iframes, so there's no per-page
// scroll stutter). As you scroll, the active sheet drives a floating
// equipment-tag ribbon, and a column-agnostic Tag Search jumps you straight to
// the sheet carrying a given tag. Full markup is one click away per sheet via
// the single-document editor.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  X, BookOpen, ChevronLeft, ChevronRight, Loader2, FileText, Menu,
  Download, Printer, ShieldCheck, ShieldAlert, Library, Briefcase,
  Search, Pen, ZoomIn, ZoomOut, Camera, ArrowDown, ArrowUp,
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
import { buildTagSearchIndex, indexMatches, collectTagGroups, type TagColumnDef } from "@/lib/documentTags";

// Same self-hosted worker the single viewer uses (copied to /public on prebuild).
pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";

interface DocEntry {
  doc: DocumentRecord;
  resolvedUrl: string | null;
  loading: boolean;
  error: string | null;
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
}

export default function MultiDocViewer({ docs, onClose, currentUserId, currentUserEmail, orgId, userRole, customColumns }: MultiDocViewerProps) {
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
  const [tocOpen, setTocOpen] = useState(true);
  const [tagsBarOpen, setTagsBarOpen] = useState(true);

  // Continuous-render state.
  const [pageCounts, setPageCounts] = useState<Record<number, number>>({});
  const [mounted, setMounted] = useState<Set<number>>(() => new Set([0]));
  const [pageWidth, setPageWidth] = useState(820);
  const [zoom, setZoom] = useState(1);

  // Tag search.
  const [search, setSearch] = useState("");
  const [searchMsg, setSearchMsg] = useState<string | null>(null);
  const [flashIdx, setFlashIdx] = useState<number | null>(null);

  const sectionRefs = useRef<(HTMLDivElement | null)[]>([]);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

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

  // Measure available width so pages fit the viewport (then ×zoom).
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((obs) => {
      const w = obs[0]?.contentRect.width ?? 0;
      if (w > 0) setPageWidth(Math.max(320, Math.min(1100, Math.round(w - 48))));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

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
  // A rAF-throttled scroll handler is robust for very tall sections (where
  // IntersectionObserver ratios never get high).
  useEffect(() => {
    const c = scrollContainerRef.current;
    if (!c) return;
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const mark = c.scrollTop + c.clientHeight * 0.35;
        let best = 0;
        for (let i = 0; i < sectionRefs.current.length; i++) {
          const el = sectionRefs.current[i];
          if (!el) continue;
          if (el.offsetTop <= mark) best = i; else break;
        }
        setActiveIdx((prev) => (prev === best ? prev : best));
      });
    };
    c.addEventListener("scroll", onScroll, { passive: true });
    return () => { c.removeEventListener("scroll", onScroll); if (raf) cancelAnimationFrame(raf); };
  }, [entries.length]);

  const scrollToSection = useCallback((idx: number) => {
    const el = sectionRefs.current[idx];
    const c = scrollContainerRef.current;
    if (el && c) c.scrollTo({ top: Math.max(0, el.offsetTop - 4), behavior: "smooth" });
    setActiveIdx(idx);
    setMounted((m) => (m.has(idx) ? m : new Set(m).add(idx)));
  }, []);

  // Per-doc search index over EVERY column value (+ doc number/title).
  const searchIndices = useMemo(
    () => entries.map((e) => buildTagSearchIndex(
      e.doc.metadata as Record<string, unknown> | undefined,
      customColumns,
      [e.doc.documentNumber, e.doc.title, e.doc.name],
    )),
    [entries, customColumns],
  );

  const flash = useCallback((idx: number) => {
    setFlashIdx(idx);
    setTimeout(() => setFlashIdx((f) => (f === idx ? null : f)), 1700);
  }, []);

  const runSearch = useCallback((dir: number) => {
    const q = search.trim();
    if (!q) { setSearchMsg(null); return; }
    const matches: number[] = [];
    searchIndices.forEach((ix, i) => { if (indexMatches(ix, q)) matches.push(i); });
    if (matches.length === 0) { setSearchMsg("No match"); return; }
    let target = dir > 0 ? matches.find((i) => i > activeIdx) : [...matches].reverse().find((i) => i < activeIdx);
    if (target === undefined) target = dir > 0 ? matches[0] : matches[matches.length - 1];
    setSearchMsg(`${matches.indexOf(target) + 1} of ${matches.length}`);
    scrollToSection(target);
    flash(target);
  }, [search, searchIndices, activeIdx, scrollToSection, flash]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowRight" || e.key === "ArrowDown") scrollToSection(Math.min(docs.length - 1, activeIdx + 1));
      if (e.key === "ArrowLeft" || e.key === "ArrowUp") scrollToSection(Math.max(0, activeIdx - 1));
    },
    [onClose, activeIdx, docs.length, scrollToSection]
  );

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

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

  return (
    <div className="fixed inset-0 z-[85] flex bg-slate-950 animate-in fade-in duration-200">
      {/* SIDEBAR TOC */}
      <div className={`${tocOpen ? "w-56" : "w-0"} shrink-0 bg-slate-900 border-r border-slate-800 flex flex-col overflow-hidden transition-all duration-200`}>
        <div className="px-4 py-3.5 border-b border-slate-800 flex items-center gap-2 shrink-0">
          <BookOpen className="w-4 h-4 text-orange-400 shrink-0" />
          <span className="text-sm font-bold text-white truncate">Reference Book</span>
          <span className="ml-auto shrink-0 text-xs font-black bg-orange-500 text-white px-2 py-0.5 rounded-full">{docs.length}</span>
        </div>
        <div className="flex-1 overflow-y-auto py-2 custom-scrollbar">
          {entries.map((entry, idx) => (
            <button
              key={entry.doc.id}
              onClick={() => scrollToSection(idx)}
              className={`w-full text-left px-3 py-2.5 flex items-start gap-2.5 transition-colors border-l-2 ${
                activeIdx === idx ? "bg-orange-500/10 border-orange-500 text-orange-300" : "border-transparent text-slate-400 hover:bg-slate-800/60 hover:text-slate-200"
              }`}
            >
              <div className={`w-5 h-5 rounded-full shrink-0 flex items-center justify-center text-[9px] font-black mt-0.5 transition-colors ${activeIdx === idx ? "bg-orange-500 text-white" : "bg-slate-700 text-slate-400"}`}>
                {idx + 1}
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-[10px] font-mono font-bold truncate">{entry.doc.documentNumber || "—"}</div>
                <div className="text-[10px] text-slate-500 truncate leading-snug mt-0.5">{entry.doc.title || entry.doc.name}</div>
                {entry.loading && (
                  <div className="flex items-center gap-1 mt-1">
                    <Loader2 className="w-2.5 h-2.5 animate-spin text-orange-500" />
                    <span className="text-[9px] text-slate-600">Loading…</span>
                  </div>
                )}
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* MAIN AREA */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Header bar */}
        <div className="bg-slate-900 border-b border-slate-800 px-4 py-2.5 flex items-center gap-3 shrink-0">
          <button onClick={() => setTocOpen((v) => !v)} className="p-1.5 rounded-lg hover:bg-slate-700 text-slate-400 hover:text-white transition-colors" title="Toggle table of contents">
            <Menu className="w-4 h-4" />
          </button>
          <div className="w-px h-5 bg-slate-700" />
          <div className="flex items-center gap-1">
            <button onClick={() => scrollToSection(Math.max(0, activeIdx - 1))} disabled={activeIdx === 0} className="p-1.5 rounded-lg hover:bg-slate-700 text-slate-400 hover:text-white disabled:opacity-30 transition-colors" title="Previous sheet">
              <ChevronLeft className="w-4 h-4" />
            </button>
            <span className="text-xs text-slate-400 px-1.5 font-mono">{activeIdx + 1} / {docs.length}</span>
            <button onClick={() => scrollToSection(Math.min(docs.length - 1, activeIdx + 1))} disabled={activeIdx === docs.length - 1} className="p-1.5 rounded-lg hover:bg-slate-700 text-slate-400 hover:text-white disabled:opacity-30 transition-colors" title="Next sheet">
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>

          {/* Tag search — jumps to the sheet carrying a matching tag/value. */}
          <div className="flex items-center gap-1.5 bg-slate-950/70 border border-slate-600 rounded-lg px-2.5 py-1.5 min-w-0 flex-1 max-w-sm shadow-inner transition-all focus-within:border-orange-500 focus-within:ring-2 focus-within:ring-orange-500/30">
            <Search className="w-4 h-4 text-orange-400 shrink-0" />
            <input
              ref={searchInputRef}
              value={search}
              onChange={(e) => { setSearch(e.target.value); setSearchMsg(null); }}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); runSearch(e.shiftKey ? -1 : 1); } }}
              placeholder="Find a tag…"
              className="bg-transparent text-xs font-medium text-white placeholder:text-slate-400 outline-none w-full min-w-0"
              title="Search any tag / column value across the book, then press Enter to jump to that sheet"
            />
            {searchMsg && <span className={`text-[10px] font-bold shrink-0 ${searchMsg === "No match" ? "text-rose-400" : "text-emerald-400"}`}>{searchMsg}</span>}
            {search ? (
              <div className="flex items-center shrink-0">
                <button onClick={() => runSearch(-1)} title="Previous match (Shift+Enter)" className="p-0.5 text-slate-400 hover:text-white"><ArrowUp className="w-3 h-3" /></button>
                <button onClick={() => runSearch(1)} title="Next match (Enter)" className="p-0.5 text-slate-400 hover:text-white"><ArrowDown className="w-3 h-3" /></button>
              </div>
            ) : (
              <kbd className="hidden lg:inline shrink-0 text-[9px] font-bold text-slate-400 border border-slate-600 rounded px-1 py-px">↵</kbd>
            )}
          </div>

          {/* Zoom */}
          <div className="hidden md:flex items-center bg-slate-800 rounded-lg px-1.5 py-1 text-xs font-mono text-slate-300 shrink-0">
            <button onClick={() => setZoom((z) => Math.max(0.5, Math.round((z - 0.15) * 100) / 100))} className="p-1 hover:text-white" title="Zoom out"><ZoomOut className="w-4 h-4" /></button>
            <span className="mx-1.5 w-9 text-center">{Math.round(zoom * 100)}%</span>
            <button onClick={() => setZoom((z) => Math.min(2.5, Math.round((z + 0.15) * 100) / 100))} className="p-1 hover:text-white" title="Zoom in"><ZoomIn className="w-4 h-4" /></button>
          </div>

          <div className="ml-auto flex items-center gap-2 shrink-0">
            {activeEntry?.doc && currentUserId && (
              <span className={`hidden lg:inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-[10px] font-bold ${activeControlled ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/30" : "bg-amber-500/10 text-amber-400 border border-amber-500/30"}`}>
                {activeControlled ? <ShieldCheck className="w-3 h-3" /> : <ShieldAlert className="w-3 h-3" />}
                {activeControlled ? "Controlled" : "Uncontrolled"}
              </span>
            )}
            <button onClick={requestDocDownload} disabled={!activeEntry?.resolvedUrl || !currentUserId || docBusy} className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-[11px] font-bold disabled:opacity-40 disabled:cursor-not-allowed transition-colors" title="Download current sheet">
              <Download className="w-3.5 h-3.5" /> <span className="hidden xl:inline">Download</span>
            </button>
            <button onClick={requestDocPrint} disabled={!activeEntry?.resolvedUrl || !currentUserId || docBusy} className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-[11px] font-bold disabled:opacity-40 disabled:cursor-not-allowed transition-colors" title="Print current sheet">
              <Printer className="w-3.5 h-3.5" /> <span className="hidden xl:inline">Print</span>
            </button>
            <button onClick={() => setShowBulkCheckout(true)} disabled={!currentUserId || docs.length === 0} className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-[11px] font-bold disabled:opacity-40 disabled:cursor-not-allowed transition-colors" title="Check out every document in this book to a project">
              <Briefcase className="w-3.5 h-3.5" /> <span className="hidden lg:inline">Checkout All</span>
            </button>
            <button onClick={requestBookDownload} disabled={bookBusy || !currentUserId} className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-orange-600 hover:bg-orange-500 text-white text-[11px] font-bold disabled:opacity-40 disabled:cursor-not-allowed transition-colors" title="Download merged stamped book">
              {bookBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Library className="w-3.5 h-3.5" />}
              <span className="hidden lg:inline">Download Book</span>
            </button>
            <button onClick={onClose} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-white text-xs font-bold transition-colors" title="Close (Esc)">
              <X className="w-3.5 h-3.5" /> <span className="hidden sm:inline">Close</span>
            </button>
          </div>
        </div>

        {/* Equipment-tag ribbon for the active sheet — updates as you scroll. */}
        {orgId && activeEntry?.doc && activeTagGroups.length > 0 && tagsBarOpen && (
          <div className="bg-slate-900/80 border-b border-slate-800 px-4 py-1.5 flex items-center gap-2 shrink-0">
            <span className="text-[9px] font-black uppercase tracking-widest text-slate-500 shrink-0 hidden sm:inline">Tags · sheet {activeIdx + 1}</span>
            <div className="flex-1 min-w-0">
              <EquipmentTagsStrip
                metadata={activeEntry.doc.metadata as Record<string, unknown>}
                customColumns={customColumns}
                orgId={orgId}
                userId={currentUserId}
                canManage={false}
                variant="ribbon"
              />
            </div>
            <button onClick={() => setTagsBarOpen(false)} title="Hide tag bar" className="shrink-0 p-1 rounded text-white/50 hover:text-white hover:bg-white/10 text-[10px] font-bold">✕</button>
          </div>
        )}
        {orgId && activeEntry?.doc && activeTagGroups.length > 0 && !tagsBarOpen && (
          <button onClick={() => setTagsBarOpen(true)} className="self-start ml-4 mt-1.5 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-slate-800 border border-slate-700 text-white/80 hover:text-white text-[11px] font-bold shrink-0" title="Show equipment tag bar">
            <Camera className="w-3.5 h-3.5" /> Tags
          </button>
        )}

        {/* Single-doc full-screen editor (markup + equipment tags). */}
        {editingDoc && (() => {
          const entry = entries.find((e) => e.doc.id === editingDoc.id);
          if (!entry?.resolvedUrl) return null;
          return (
            <FullScreenViewer
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

        {/* Continuous, smoothly-scrolling page stack */}
        <div ref={scrollContainerRef} className="relative flex-1 overflow-y-auto bg-slate-950">
          {entries.map((entry, idx) => (
            <div key={entry.doc.id} ref={(el) => { sectionRefs.current[idx] = el; }} className={`flex flex-col border-b border-slate-800 ${flashIdx === idx ? "ring-4 ring-orange-500/70 ring-inset" : ""}`}>
              {/* Sticky section header */}
              <div className="sticky top-0 z-10 bg-slate-900/95 backdrop-blur border-b border-slate-800 px-5 py-2 flex items-center gap-3">
                <div className="w-6 h-6 rounded-full bg-orange-500 flex items-center justify-center text-[10px] font-black text-white shrink-0">{idx + 1}</div>
                <span className="text-xs font-mono font-bold text-orange-400">{entry.doc.documentNumber || "—"}</span>
                <span className="text-xs text-slate-300 font-medium truncate">{entry.doc.title || entry.doc.name}</span>
                <div className="ml-auto flex items-center gap-2 shrink-0">
                  <span className="text-[10px] text-slate-500">Rev {entry.doc.rev || "—"}</span>
                  <span className="text-[10px] text-slate-600 bg-slate-800 px-1.5 py-0.5 rounded">{entry.doc.status || "—"}</span>
                  {/* Full markup + equipment tags for this sheet, in the editor. */}
                  <button
                    onClick={() => setEditingDoc(entry.doc)}
                    title="Mark up this sheet (pen, highlight, shapes, stamps) + equipment tags"
                    className="text-[10px] font-bold inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-orange-600 hover:bg-orange-500 text-white"
                  >
                    <Pen className="w-3 h-3" /> Markup
                  </button>
                </div>
              </div>

              {/* Pages — real canvases, no nested scroll */}
              <div className="flex flex-col items-center gap-4 py-5 px-2 min-h-[40vh]">
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
                    file={entry.resolvedUrl}
                    onLoadSuccess={({ numPages }) => setPageCounts((c) => (c[idx] === numPages ? c : { ...c, [idx]: numPages }))}
                    loading={<div className="flex items-center justify-center py-20"><Loader2 className="w-8 h-8 animate-spin text-orange-500" /></div>}
                    error={<div className="flex flex-col items-center gap-2 text-slate-600 py-20"><FileText className="w-12 h-12 opacity-20" /><span className="text-xs">Couldn’t render this PDF</span></div>}
                    className="flex flex-col items-center gap-4"
                  >
                    {Array.from({ length: pageCounts[idx] ?? 0 }).map((_, p) => (
                      <div key={p} className="shadow-xl shadow-black/40 bg-white">
                        <Page
                          pageNumber={p + 1}
                          width={Math.round(pageWidth * zoom)}
                          renderTextLayer={false}
                          renderAnnotationLayer={false}
                          loading={<div className="bg-slate-800 animate-pulse" style={{ width: Math.round(pageWidth * zoom), height: Math.round(pageWidth * zoom * 1.3) }} />}
                        />
                      </div>
                    ))}
                  </Document>
                ) : (
                  // Not yet mounted (offscreen) — a light placeholder keeps layout stable.
                  <div className="bg-slate-900/40 rounded-lg flex items-center justify-center text-slate-700" style={{ width: Math.round(pageWidth * zoom), height: Math.round(pageWidth * zoom * 1.3) }}>
                    <FileText className="w-10 h-10 opacity-20" />
                  </div>
                )}
              </div>
            </div>
          ))}
          <div className="h-16 bg-slate-950" />
        </div>
      </div>
    </div>
  );
}
