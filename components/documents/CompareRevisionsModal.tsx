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
import dynamic from "next/dynamic";
import { vDim, vPanel, vKicker, vTitle, vIcon, vClose } from "@/components/viewers/viewerChrome";
import { humanDate } from "@/components/documents/StatusTag";
import { friendlyError } from "@/lib/friendlyError";
// react-pdf is heavy; load the diff engine only when a compare opens.
const PdfRevisionDiff = dynamic(() => import("@/components/viewers/PdfRevisionDiff"), { ssr: false });

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
          .select("id, revision_label, created_at, file_url, archived_at, review_state, is_branch")
          .eq("record_id", doc.id)
          .or("review_state.is.null,review_state.eq.approved")
          .order("created_at", { ascending: false });
        if (qErr) throw new Error(qErr.message);
        const rows = (data ?? []) as Array<Record<string, unknown>>;
        const eligible: VersionOption[] = rows
          .filter((r) => !!r.file_url && !r.archived_at)
          .map((r) => ({
            id: r.id as string,
            revisionLabel: `${(r.revision_label as string) || "-"}${r.is_branch ? " (side copy - never issued)" : ""}`,
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
        if (alive) setError(friendlyError(e));
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
        if (alive) setError(friendlyError(e));
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
    `Rev ${v.revisionLabel}${v.id === doc.currentVersionId ? " · current" : ""}${v.createdAt ? ` · ${humanDate(v.createdAt)}` : ""}`;

  const selectCls = "h-9 bg-[var(--color-ink-2)] border border-[var(--color-border)] rounded-lg px-2 text-body font-medium text-[var(--color-text)] outline-none focus:border-[var(--color-border-strong)] max-w-[220px]";

  // PORTAL to <body>: this modal is opened from inside the Inspector drawer,
  // whose slide-in transform makes it the containing block for fixed
  // positioning — without the portal, "fixed inset-0" fills the ~640px drawer
  // instead of the screen.
  return createPortal(
    <div className="fixed inset-0 z-[220]">
      <div className={vDim} onClick={onClose} />
      <div className={vPanel} role="dialog" aria-modal="true" aria-label="Compare revisions">
        {/* Which drawing, then the two revisions */}
        <div className="px-4 sm:px-5 pt-3.5 pb-3 flex items-start gap-3 shrink-0">
          <div className="min-w-0 flex-1">
            <div className={vKicker}>Compare revisions</div>
            <div className={vTitle}>{doc.documentNumber || doc.title || doc.name}</div>
          </div>
          <button aria-label="Close" onClick={onClose} className={vClose} title="Close">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="px-4 sm:px-5 pb-3 flex items-center gap-2 flex-wrap shrink-0 border-b border-[var(--color-border)]">
          <label className="flex items-center gap-1.5 text-body">
            <span className="text-rose-300 font-medium">Base</span>
            <select value={baseId ?? ""} onChange={(e) => pick("base", e.target.value)} className={selectCls} disabled={loading}>
              {versions.map((v) => <option key={v.id} value={v.id}>{optionLabel(v)}</option>)}
            </select>
          </label>
          <button onClick={swap} disabled={!baseId || !compareId} className={vIcon} title="Swap base and compare" aria-label="Swap base and compare">
            <ArrowLeftRight className="w-4 h-4" />
          </button>
          <label className="flex items-center gap-1.5 text-body">
            <span className="text-emerald-300 font-medium">Compare</span>
            <select value={compareId ?? ""} onChange={(e) => pick("compare", e.target.value)} className={selectCls} disabled={loading}>
              {versions.map((v) => <option key={v.id} value={v.id}>{optionLabel(v)}</option>)}
            </select>
          </label>
          {offloadedCount > 0 && (
            <span className="inline-flex items-center gap-1 text-body text-[var(--color-text-muted)]">
              <Archive className="w-3.5 h-3.5" /> {offloadedCount} older revision{offloadedCount === 1 ? " is" : "s are"} in the offline archive, not shown
            </span>
          )}
        </div>

        {/* Body */}
        <div className="flex-1 min-h-0 relative">
          {loading ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center text-[var(--color-text-muted)]">
              <Loader2 className="w-8 h-8 animate-spin text-[var(--color-text-muted)] mb-2" />
              <span className="text-body">Loading revisions…</span>
            </div>
          ) : error ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center text-rose-300">
              <AlertTriangle className="w-10 h-10 mb-2 opacity-60" />
              <span className="text-body font-medium">The revisions didn&apos;t load.</span>
              <span className="text-body mt-1 max-w-md text-center text-[var(--color-text-muted)]">{error}</span>
            </div>
          ) : versions.length < 2 ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center text-[var(--color-text-muted)] px-8 text-center">
              <GitCompare className="w-10 h-10 mb-3 opacity-40" />
              <span className="text-body font-medium text-[var(--color-text)]">Need two revisions on the server to compare</span>
              <span className="text-body mt-1 max-w-md">
                {versions.length === 1 ? "Only one revision is available. " : "No revisions with files are available. "}
                {offloadedCount > 0 && `${offloadedCount} older revision${offloadedCount === 1 ? " was" : "s were"} archived off the server for space: restore from the offline archive to compare against them.`}
              </span>
            </div>
          ) : !baseVersion || !compareVersion || !urls ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center text-[var(--color-text-muted)]">
              <Loader2 className="w-8 h-8 animate-spin text-[var(--color-text-muted)] mb-2" />
              <span className="text-body">Opening the files…</span>
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
