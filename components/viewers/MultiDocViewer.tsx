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
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import type { DocumentRecord } from "@/types/schema";

interface DocEntry {
  doc: DocumentRecord;
  resolvedUrl: string | null;
  loading: boolean;
  error: string | null;
}

interface MultiDocViewerProps {
  docs: DocumentRecord[];
  onClose: () => void;
}

export default function MultiDocViewer({ docs, onClose }: MultiDocViewerProps) {
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

          <button
            onClick={onClose}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-white text-xs font-bold transition-colors ml-auto shrink-0"
            title="Close (Esc)"
          >
            <X className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Close</span>
          </button>
        </div>

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
