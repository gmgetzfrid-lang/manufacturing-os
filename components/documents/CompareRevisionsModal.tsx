"use client";

// CompareRevisionsModal — pick any two revisions of a document and view the
// true-overlay diff (grey unchanged · red removed · green added).
//
// The pickers list ONLY revisions whose binary is still on the server: rows
// shed to the cold archive (archived_at / no file_url) and in-review drafts
// are excluded. Defaults to comparing the latest revision against the one
// before it; either slot can be repointed, and ⇄ swaps them.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { X, Loader2, AlertTriangle, ArrowLeftRight, GitCompare, Archive } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { resolveFileUrl } from "@/lib/storage";
import type { DocumentRecord } from "@/types/schema";
import PdfRevisionDiff from "@/components/viewers/PdfRevisionDiff";

interface VersionOption {
  id: string;
  revisionLabel: string;
  createdAt: string | null;
  fileUrl: string;
}

interface CompareRevisionsModalProps {
  isOpen: boolean;
  onClose: () => void;
  doc: DocumentRecord;
  /** Optional preselected pair (e.g. from the history panel's per-row Compare). */
  initialBaseVersionId?: string;
  initialCompareVersionId?: string;
}

export default function CompareRevisionsModal({
  isOpen, onClose, doc, initialBaseVersionId, initialCompareVersionId,
}: CompareRevisionsModalProps) {
  const [versions, setVersions] = useState<VersionOption[]>([]);
  const [offloadedCount, setOffloadedCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [baseId, setBaseId] = useState<string | null>(null);
  const [compareId, setCompareId] = useState<string | null>(null);
  const [urls, setUrls] = useState<{ base: string; compare: string } | null>(null);

  // Load the eligible revision list (newest first).
  useEffect(() => {
    if (!isOpen || !doc.id) return;
    let alive = true;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const { data, error: qErr } = await supabase
          .from("document_versions")
          .select("id, revision_label, created_at, file_url, archived_at, review_state")
          .eq("record_id", doc.id)
          .or("review_state.is.null,review_state.eq.approved")
          .order("created_at", { ascending: false });
        if (qErr) throw new Error(qErr.message);
        const rows = (data ?? []) as Array<Record<string, unknown>>;
        const eligible: VersionOption[] = rows
          .filter((r) => !!r.file_url && !r.archived_at)
          .map((r) => ({
            id: r.id as string,
            revisionLabel: (r.revision_label as string) || "—",
            createdAt: (r.created_at as string) ?? null,
            fileUrl: r.file_url as string,
          }));
        if (!alive) return;
        setVersions(eligible);
        setOffloadedCount(rows.length - eligible.length);
        // Defaults: latest vs the one before it (or the caller's explicit pair,
        // when both are still eligible).
        const has = (id?: string | null) => !!id && eligible.some((v) => v.id === id);
        const cmp = has(initialCompareVersionId) ? initialCompareVersionId! : eligible[0]?.id ?? null;
        const base = has(initialBaseVersionId) && initialBaseVersionId !== cmp
          ? initialBaseVersionId!
          : eligible.find((v) => v.id !== cmp)?.id ?? null;
        setCompareId(cmp);
        setBaseId(base);
      } catch (e) {
        if (alive) setError((e as Error).message);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [isOpen, doc.id, initialBaseVersionId, initialCompareVersionId]);

  const baseVersion = useMemo(() => versions.find((v) => v.id === baseId) ?? null, [versions, baseId]);
  const compareVersion = useMemo(() => versions.find((v) => v.id === compareId) ?? null, [versions, compareId]);

  // Resolve storage paths to fetchable URLs whenever the pair changes.
  useEffect(() => {
    if (!isOpen || !baseVersion || !compareVersion) { setUrls(null); return; }
    let alive = true;
    (async () => {
      setUrls(null);
      try {
        const [b, c] = await Promise.all([
          resolveFileUrl(baseVersion.fileUrl),
          resolveFileUrl(compareVersion.fileUrl),
        ]);
        if (!alive) return;
        if (!b || !c) { setError("Could not resolve one of the revision files."); return; }
        setError(null);
        setUrls({ base: b, compare: c });
      } catch (e) {
        if (alive) setError((e as Error).message);
      }
    })();
    return () => { alive = false; };
  }, [isOpen, baseVersion, compareVersion]);

  const pick = useCallback((slot: "base" | "compare", id: string) => {
    if (slot === "base") {
      setBaseId(id);
      if (id === compareId) setCompareId(versions.find((v) => v.id !== id)?.id ?? null);
    } else {
      setCompareId(id);
      if (id === baseId) setBaseId(versions.find((v) => v.id !== id)?.id ?? null);
    }
  }, [baseId, compareId, versions]);

  const swap = () => { const b = baseId; setBaseId(compareId); setCompareId(b); };

  // Escape closes the compare — capture phase + stopPropagation so the
  // Inspector drawer (which also listens for Escape on window) stays open.
  useEffect(() => {
    if (!isOpen) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); onClose(); }
    };
    window.addEventListener("keydown", h, { capture: true });
    return () => window.removeEventListener("keydown", h, { capture: true });
  }, [isOpen, onClose]);

  if (!isOpen || typeof document === "undefined") return null;

  const optionLabel = (v: VersionOption) =>
    `Rev ${v.revisionLabel}${v.id === doc.currentVersionId ? " · current" : ""}${v.createdAt ? ` · ${v.createdAt.slice(0, 10)}` : ""}`;

  const selectCls = "bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-xs text-slate-100 outline-none focus:border-orange-400 max-w-[220px]";

  // PORTAL to <body>: this modal is opened from inside the Inspector drawer,
  // whose slide-in transform makes it the containing block for fixed
  // positioning — without the portal, "fixed inset-0" fills the ~640px drawer
  // instead of the screen.
  return createPortal(
    <div className="fixed inset-0 z-[220] bg-slate-900/80 backdrop-blur-sm animate-in fade-in flex flex-col p-4">
      <div className="flex-1 min-h-0 bg-slate-900 border border-slate-700 rounded-2xl overflow-hidden flex flex-col shadow-2xl animate-in fade-in zoom-in-95">
        {/* Title + version pickers */}
        <div className="px-4 py-2.5 flex items-center justify-between gap-3 bg-slate-800 border-b border-slate-700 shrink-0 flex-wrap">
          <div className="flex items-center gap-2 text-xs min-w-0">
            <GitCompare className="w-4 h-4 text-orange-400 shrink-0" />
            <span className="font-black text-slate-200 uppercase tracking-widest shrink-0">Compare revisions</span>
            <span className="text-slate-500 truncate">{doc.documentNumber || doc.title || doc.name}</span>
          </div>

          <div className="flex items-center gap-2 text-xs">
            <label className="flex items-center gap-1.5">
              <span className="text-red-300 font-bold">Base</span>
              <select value={baseId ?? ""} onChange={(e) => pick("base", e.target.value)} className={selectCls} disabled={loading}>
                {versions.map((v) => <option key={v.id} value={v.id}>{optionLabel(v)}</option>)}
              </select>
            </label>
            <button onClick={swap} disabled={!baseId || !compareId} className="p-1.5 rounded-lg text-slate-300 hover:text-orange-300 hover:bg-slate-700 disabled:opacity-40" title="Swap base and compare">
              <ArrowLeftRight className="w-4 h-4" />
            </button>
            <label className="flex items-center gap-1.5">
              <span className="text-emerald-300 font-bold">Compare</span>
              <select value={compareId ?? ""} onChange={(e) => pick("compare", e.target.value)} className={selectCls} disabled={loading}>
                {versions.map((v) => <option key={v.id} value={v.id}>{optionLabel(v)}</option>)}
              </select>
            </label>
            {offloadedCount > 0 && (
              <span className="inline-flex items-center gap-1 text-[10px] text-slate-400" title="Revisions shed to the cold archive (or without a server file) can't be compared until restored">
                <Archive className="w-3 h-3" /> {offloadedCount} archived off-server excluded
              </span>
            )}
            <button onClick={onClose} className="p-1.5 rounded-md text-slate-400 hover:text-white hover:bg-slate-700" title="Close">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 min-h-0 relative">
          {loading ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center text-slate-400">
              <Loader2 className="w-8 h-8 animate-spin text-orange-400 mb-2" />
              <span className="text-xs font-mono">Loading revisions…</span>
            </div>
          ) : error ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center text-red-400">
              <AlertTriangle className="w-10 h-10 mb-2 opacity-60" />
              <span className="text-sm font-bold">Could not load revisions</span>
              <span className="text-xs font-mono mt-1 max-w-md text-center text-red-300/70">{error}</span>
            </div>
          ) : versions.length < 2 ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center text-slate-400 px-8 text-center">
              <GitCompare className="w-10 h-10 mb-3 opacity-40" />
              <span className="text-sm font-bold text-slate-300">Need two revisions on the server to compare</span>
              <span className="text-xs mt-1 max-w-md">
                {versions.length === 1 ? "Only one revision is available. " : "No revisions with files are available. "}
                {offloadedCount > 0 && `${offloadedCount} older revision${offloadedCount === 1 ? " was" : "s were"} archived off the server for space — restore from the offline archive to compare against them.`}
              </span>
            </div>
          ) : !baseVersion || !compareVersion || !urls ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center text-slate-400">
              <Loader2 className="w-8 h-8 animate-spin text-orange-400 mb-2" />
              <span className="text-xs font-mono">Resolving files…</span>
            </div>
          ) : (
            <PdfRevisionDiff
              key={`${baseVersion.id}|${compareVersion.id}`}
              baseUrl={urls.base}
              baseLabel={`Rev ${baseVersion.revisionLabel}`}
              compareUrl={urls.compare}
              compareLabel={`Rev ${compareVersion.revisionLabel}`}
            />
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
