"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  X,
  BookOpen,
  ChevronLeft,
  ChevronRight,
  Loader2,
  FileText,
  Menu,
  ExternalLink,
  Download,
  Printer,
  ShieldCheck,
  ShieldAlert,
  Library,
  Briefcase,
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import type { DocumentRecord } from "@/types/schema";
import { downloadDocumentPdf, printDocumentPdf, determineControlState } from "@/lib/downloads";
import { stampPdf } from "@/lib/stamping";
import { PDFDocument } from "pdf-lib";
import BulkCheckoutToProjectModal from "@/components/documents/BulkCheckoutToProjectModal";
import FullScreenViewer from "@/components/viewers/FullScreenViewer";

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
}

export default function MultiDocViewer({ docs, onClose, currentUserId, currentUserEmail, orgId, userRole }: MultiDocViewerProps) {
  const [bookBusy, setBookBusy] = useState(false);
  const [docBusy, setDocBusy] = useState(false);
  const [downloadConfirm, setDownloadConfirm] = useState<null | { type: "download" | "print" | "book"; }>(null);
  // When set, render the single-doc FullScreenViewer on top of the
  // book so the user can mark up + tag equipment for that one document.
  const [editingDoc, setEditingDoc] = useState<DocumentRecord | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [showBulkCheckout, setShowBulkCheckout] = useState(false);
  const [entries, setEntries] = useState<DocEntry[]>(() =>
    docs.map((doc) => ({ doc, resolvedUrl: null, loading: true, error: null }))
  );
  const [activeIdx, setActiveIdx] = useState(0);
  const [tocOpen, setTocOpen] = useState(true);
  const sectionRefs = useRef<(HTMLDivElement | null)[]>([]);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Load versions + resolve presigned URLs for all docs
  useEffect(() => {
    let alive = true;

    const load = async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const token = session?.access_token;

      for (let i = 0; i < docs.length; i++) {
        const doc = docs[i];
        try {
          let fileUrl: string | null = null;

          // 1. Try current version
          if (doc.currentVersionId) {
            const { data } = await supabase
              .from("document_versions")
              .select("file_url")
              .eq("id", doc.currentVersionId)
              .single();
            if (data?.file_url) fileUrl = data.file_url;
          }

          // 2. Fall back to latest version by record
          if (!fileUrl) {
            const { data } = await supabase
              .from("document_versions")
              .select("file_url")
              .eq("record_id", doc.id)
              .order("created_at", { ascending: false })
              .limit(1);
            if (data && data.length > 0) fileUrl = data[0].file_url;
          }

          // 3. Resolve storage path → presigned URL
          let resolvedUrl: string | null = null;
          if (fileUrl) {
            if (fileUrl.startsWith("http://") || fileUrl.startsWith("https://")) {
              resolvedUrl = fileUrl;
            } else if (token) {
              const res = await fetch(
                `/api/storage/download-url?path=${encodeURIComponent(fileUrl)}&expiresIn=3600`,
                { headers: { authorization: `Bearer ${token}` } }
              );
              if (res.ok) {
                const { url } = await res.json();
                resolvedUrl = url;
              }
            }
          }

          if (!alive) return;
          setEntries((prev) => {
            const next = [...prev];
            next[i] = { doc, resolvedUrl, loading: false, error: null };
            return next;
          });
        } catch {
          if (!alive) return;
          setEntries((prev) => {
            const next = [...prev];
            next[i] = { ...next[i], loading: false, error: "Failed to load document" };
            return next;
          });
        }
      }
    };

    load();
    return () => {
      alive = false;
    };
  }, [docs]);

  // Track which section is visible for TOC highlighting
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const idx = sectionRefs.current.indexOf(entry.target as HTMLDivElement);
            if (idx >= 0) setActiveIdx(idx);
          }
        }
      },
      { root: container, threshold: 0.3 }
    );

    sectionRefs.current.forEach((el) => {
      if (el) observer.observe(el);
    });

    return () => observer.disconnect();
  }, [entries.length]);

  const scrollTo = useCallback((idx: number) => {
    setActiveIdx(idx);
    sectionRefs.current[idx]?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowRight" || e.key === "ArrowDown")
        scrollTo(Math.min(docs.length - 1, activeIdx + 1));
      if (e.key === "ArrowLeft" || e.key === "ArrowUp") scrollTo(Math.max(0, activeIdx - 1));
    },
    [onClose, activeIdx, docs.length, scrollTo]
  );

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  const activeEntry = entries[activeIdx];
  const activeControlState = activeEntry?.doc && currentUserId
    ? determineControlState(activeEntry.doc, currentUserId)
    : "uncontrolled";
  const activeControlled = activeControlState === "controlled";

  // Single-document download / print for the currently focused doc
  const runDocAction = async (type: "download" | "print") => {
    if (!activeEntry?.resolvedUrl || !currentUserId) return;
    setDocBusy(true);
    setActionError(null);
    try {
      const ctx = {
        doc: activeEntry.doc,
        fileUrl: activeEntry.resolvedUrl,
        userId: currentUserId,
        userEmail: currentUserEmail ?? null,
        userLabel: currentUserEmail ?? null,
      };
      if (type === "download") await downloadDocumentPdf(ctx);
      else await printDocumentPdf(ctx);
      setDownloadConfirm(null);
    } catch (e) {
      setActionError((e as Error).message || "Action failed");
    } finally {
      setDocBusy(false);
    }
  };

  // Merge every resolved PDF in the book into a single stamped (uncontrolled)
  // PDF. The book is always treated as uncontrolled — covering many documents
  // at once, no single checkout grants control over the collection.
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

      // Audit one row per document so the book download is traceable per asset.
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
      <div
        className={`${
          tocOpen ? "w-56" : "w-0"
        } shrink-0 bg-slate-900 border-r border-slate-800 flex flex-col overflow-hidden transition-all duration-200`}
      >
        <div className="px-4 py-3.5 border-b border-slate-800 flex items-center gap-2 shrink-0">
          <BookOpen className="w-4 h-4 text-orange-400 shrink-0" />
          <span className="text-sm font-bold text-white truncate">Reference Book</span>
          <span className="ml-auto shrink-0 text-xs font-black bg-orange-500 text-white px-2 py-0.5 rounded-full">
            {docs.length}
          </span>
        </div>
        <div className="flex-1 overflow-y-auto py-2 custom-scrollbar">
          {entries.map((entry, idx) => (
            <button
              key={entry.doc.id}
              onClick={() => scrollTo(idx)}
              className={`w-full text-left px-3 py-2.5 flex items-start gap-2.5 transition-colors border-l-2 ${
                activeIdx === idx
                  ? "bg-orange-500/10 border-orange-500 text-orange-300"
                  : "border-transparent text-slate-400 hover:bg-slate-800/60 hover:text-slate-200"
              }`}
            >
              <div
                className={`w-5 h-5 rounded-full shrink-0 flex items-center justify-center text-[9px] font-black mt-0.5 transition-colors ${
                  activeIdx === idx ? "bg-orange-500 text-white" : "bg-slate-700 text-slate-400"
                }`}
              >
                {idx + 1}
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-[10px] font-mono font-bold truncate">
                  {entry.doc.documentNumber || "—"}
                </div>
                <div className="text-[10px] text-slate-500 truncate leading-snug mt-0.5">
                  {entry.doc.title || entry.doc.name}
                </div>
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
          <button
            onClick={() => setTocOpen((v) => !v)}
            className="p-1.5 rounded-lg hover:bg-slate-700 text-slate-400 hover:text-white transition-colors"
            title="Toggle table of contents"
          >
            <Menu className="w-4 h-4" />
          </button>

          <div className="w-px h-5 bg-slate-700" />

          <div className="flex items-center gap-1">
            <button
              onClick={() => scrollTo(Math.max(0, activeIdx - 1))}
              disabled={activeIdx === 0}
              className="p-1.5 rounded-lg hover:bg-slate-700 text-slate-400 hover:text-white disabled:opacity-30 transition-colors"
              title="Previous document"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <span className="text-xs text-slate-400 px-1.5 font-mono">
              {activeIdx + 1} / {docs.length}
            </span>
            <button
              onClick={() => scrollTo(Math.min(docs.length - 1, activeIdx + 1))}
              disabled={activeIdx === docs.length - 1}
              className="p-1.5 rounded-lg hover:bg-slate-700 text-slate-400 hover:text-white disabled:opacity-30 transition-colors"
              title="Next document"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>

          {/* Active doc info */}
          {entries[activeIdx] && (
            <div className="flex items-center gap-2 flex-1 min-w-0 ml-1">
              <span className="text-[11px] font-mono font-bold text-orange-400 bg-orange-950/40 px-2 py-0.5 rounded border border-orange-900/30 whitespace-nowrap">
                {entries[activeIdx].doc.documentNumber || "—"}
              </span>
              <span className="text-xs text-slate-400 truncate hidden sm:block">
                {entries[activeIdx].doc.title || entries[activeIdx].doc.name}
              </span>
              <span className="text-[10px] text-slate-600 whitespace-nowrap">
                Rev {entries[activeIdx].doc.rev || "—"}
              </span>
            </div>
          )}

          <div className="ml-auto flex items-center gap-2 shrink-0">
            {activeEntry?.doc && currentUserId && (
              <span className={`hidden md:inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-[10px] font-bold ${
                activeControlled
                  ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/30"
                  : "bg-amber-500/10 text-amber-400 border border-amber-500/30"
              }`}>
                {activeControlled ? <ShieldCheck className="w-3 h-3" /> : <ShieldAlert className="w-3 h-3" />}
                {activeControlled ? "Controlled" : "Uncontrolled"}
              </span>
            )}
            <button
              onClick={requestDocDownload}
              disabled={!activeEntry?.resolvedUrl || !currentUserId || docBusy}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-[11px] font-bold disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              title="Download current document"
            >
              <Download className="w-3.5 h-3.5" /> Download
            </button>
            <button
              onClick={requestDocPrint}
              disabled={!activeEntry?.resolvedUrl || !currentUserId || docBusy}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-[11px] font-bold disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              title="Print current document"
            >
              <Printer className="w-3.5 h-3.5" /> Print
            </button>
            <button
              onClick={() => setShowBulkCheckout(true)}
              disabled={!currentUserId || docs.length === 0}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-[11px] font-bold disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              title="Check out every document in this book to a project"
            >
              <Briefcase className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Checkout All to Project</span>
            </button>
            <button
              onClick={requestBookDownload}
              disabled={bookBusy || !currentUserId}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-orange-600 hover:bg-orange-500 text-white text-[11px] font-bold disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              title="Download merged stamped book of all documents"
            >
              {bookBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Library className="w-3.5 h-3.5" />}
              <span className="hidden sm:inline">Download Book</span>
            </button>
            <button
              onClick={onClose}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-white text-xs font-bold transition-colors"
              title="Close (Esc)"
            >
              <X className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Close</span>
            </button>
          </div>
        </div>

        {/* Single-doc full-screen editor (markup + equipment tags).
            Opens on top of the book when the user clicks "Edit / Tag"
            on a section header. */}
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
            />
          );
        })()}

        {/* Bulk-checkout-to-project modal */}
        {showBulkCheckout && orgId && currentUserId && (
          <BulkCheckoutToProjectModal
            isOpen={showBulkCheckout}
            onClose={() => setShowBulkCheckout(false)}
            docs={docs}
            orgId={orgId}
            actorUserId={currentUserId}
            actorEmail={currentUserEmail}
            actorRole={userRole || ""}
            onSuccess={() => {
              setShowBulkCheckout(false);
              // The bulk modal navigates to the new project itself.
              onClose();
            }}
          />
        )}

        {/* Uncontrolled confirmation modal */}
        {downloadConfirm && (
          <div className="fixed inset-0 z-[120] bg-slate-900/70 backdrop-blur-sm flex items-start sm:items-center justify-center overflow-y-auto p-6">
            <div className="w-full max-w-md rounded-2xl bg-white shadow-2xl border border-slate-200 overflow-hidden">
              <div className="px-6 py-4 border-b border-slate-200 flex items-center gap-3">
                <div className="p-2 bg-amber-100 rounded-lg">
                  <ShieldAlert className="w-5 h-5 text-amber-700" />
                </div>
                <div>
                  <div className="text-sm font-black text-slate-900">Uncontrolled Copy</div>
                  <div className="text-xs text-slate-500">
                    {downloadConfirm.type === "book"
                      ? "Reference books are always uncontrolled."
                      : "You don't have this document checked out."}
                  </div>
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
                {actionError && (
                  <p className="text-xs text-red-600 font-mono bg-red-50 border border-red-200 rounded-lg p-2">{actionError}</p>
                )}
              </div>
              <div className="px-6 py-3 bg-slate-50 border-t border-slate-200 flex items-center justify-end gap-2">
                <button
                  onClick={() => { setDownloadConfirm(null); setActionError(null); }}
                  disabled={docBusy || bookBusy}
                  className="px-3 py-2 rounded-lg text-xs font-bold text-slate-700 bg-white border border-slate-200 hover:bg-slate-100 disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={() => {
                    if (downloadConfirm.type === "book") void downloadBookMerged();
                    else void runDocAction(downloadConfirm.type);
                  }}
                  disabled={docBusy || bookBusy}
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold text-white bg-amber-600 hover:bg-amber-700 disabled:opacity-60"
                >
                  {(docBusy || bookBusy) && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  {downloadConfirm.type === "book" ? "Download stamped book" :
                   downloadConfirm.type === "download" ? "Download stamped copy" : "Print stamped copy"}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Scrollable document sections */}
        <div ref={scrollContainerRef} className="flex-1 overflow-y-auto">
          {entries.map((entry, idx) => (
            <div
              key={entry.doc.id}
              ref={(el) => {
                sectionRefs.current[idx] = el;
              }}
              className="flex flex-col border-b border-slate-800"
            >
              {/* Section divider header */}
              <div className="sticky top-0 z-10 bg-slate-900/95 backdrop-blur border-b border-slate-800 px-5 py-2 flex items-center gap-3">
                <div className="w-6 h-6 rounded-full bg-orange-500 flex items-center justify-center text-[10px] font-black text-white shrink-0">
                  {idx + 1}
                </div>
                <span className="text-xs font-mono font-bold text-orange-400">
                  {entry.doc.documentNumber || "—"}
                </span>
                <span className="text-xs text-slate-300 font-medium truncate">
                  {entry.doc.title || entry.doc.name}
                </span>
                <div className="ml-auto flex items-center gap-2 shrink-0">
                  <span className="text-[10px] text-slate-500">Rev {entry.doc.rev || "—"}</span>
                  <span className="text-[10px] text-slate-600 bg-slate-800 px-1.5 py-0.5 rounded">
                    {entry.doc.status || "—"}
                  </span>
                  {/* Launch in single-doc full-screen viewer for markup +
                      equipment tags. Carrying both stacks into the book
                      would be a multi-day port; this gives the user the
                      same capability one doc at a time. */}
                  <button
                    onClick={() => setEditingDoc(entry.doc)}
                    title="Open this doc in the full-screen editor (markup tools + equipment tags)"
                    className="text-[10px] font-bold inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-orange-600 hover:bg-orange-500 text-white"
                  >
                    Edit / Tag
                  </button>
                </div>
              </div>

              {/* PDF viewport — 90vh so you know there's more below */}
              <div className="h-[90vh] bg-slate-950 relative">
                {entry.loading ? (
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 text-slate-500">
                    <Loader2 className="w-10 h-10 animate-spin text-orange-500" />
                    <span className="text-sm font-mono text-orange-400/70 animate-pulse">
                      Loading {entry.doc.documentNumber || "document"}…
                    </span>
                  </div>
                ) : entry.error || !entry.resolvedUrl ? (
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-slate-600">
                    <FileText className="w-16 h-16 opacity-20" />
                    <span className="text-sm font-medium">
                      {entry.error || "No file available for this document"}
                    </span>
                  </div>
                ) : (
                  <>
                    <iframe
                      src={`${entry.resolvedUrl}#toolbar=0&navpanes=0&scrollbar=1&zoom=page-fit`}
                      className="w-full h-full border-none"
                      title={entry.doc.documentNumber || entry.doc.title || "Document"}
                    />
                    {/* Open in full screen link */}
                    <a
                      href={entry.resolvedUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="absolute top-2 right-2 flex items-center gap-1 px-2 py-1 bg-slate-900/70 hover:bg-slate-800 text-slate-400 hover:text-white rounded text-[10px] font-bold transition-colors backdrop-blur"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <ExternalLink className="w-3 h-3" />
                      Raw
                    </a>
                  </>
                )}
              </div>
            </div>
          ))}

          {/* Bottom padding so last doc clears the screen */}
          <div className="h-16 bg-slate-950" />
        </div>
      </div>
    </div>
  );
}
