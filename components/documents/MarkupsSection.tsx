"use client";

// MarkupsSection — GAP-7 acceptance 3: a markup that exists is discoverable
// from the document without anyone having downloaded anything. Lists every
// stored markup on the document (all revisions, all authors) and opens the
// viewer seeded with it — the author edits their own; anyone else views.

import React, { useCallback, useEffect, useState } from "react";
import { PenLine, RefreshCw } from "lucide-react";
import { listMarkupsForDocument, type DocumentMarkup } from "@/lib/markups";
import type { DocumentVersion } from "@/types/schema";

export default function MarkupsSection({
  documentId, versions, currentUserId, onOpenMarkup, refreshKey,
}: {
  documentId: string;
  /** Known versions, to label a markup with its revision. */
  versions?: DocumentVersion[];
  currentUserId?: string | null;
  onOpenMarkup?: (m: DocumentMarkup) => void;
  /** Bump to reload (the page bumps it after the viewer commits). */
  refreshKey?: number;
}) {
  const [rows, setRows] = useState<DocumentMarkup[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const load = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    let alive = true;
    listMarkupsForDocument(documentId)
      .then((next) => { if (alive) { setRows(next); setError(null); } })
      .catch((e: unknown) => { if (alive) { setError((e as Error).message); setRows([]); } });
    return () => { alive = false; };
  }, [documentId, refreshKey, reloadKey]);

  const revOf = (versionId: string) => versions?.find((v) => v.id === versionId)?.revisionLabel ?? null;

  if (rows === null) return <div className="text-xs text-[var(--color-text-muted)] italic py-1">Loading…</div>;
  if (error) return <div className="text-xs text-rose-600 py-1">Markups could not be loaded: {error}</div>;
  if (rows.length === 0) return <div className="text-xs text-[var(--color-text-muted)] italic py-1">No markups on this document yet. Draw in the viewer — it is kept per revision, per person.</div>;

  return (
    <ul className="space-y-1.5">
      {rows.map((m) => {
        const rev = revOf(m.versionId);
        const mine = !!currentUserId && m.userId === currentUserId;
        return (
          <li key={m.id} className="flex items-center justify-between gap-2 text-[11px]">
            <div className="min-w-0">
              <div className="text-[var(--color-text)] truncate">
                <PenLine className="w-3 h-3 inline mr-1 text-[var(--color-text-muted)]" />
                <span className="font-bold">{mine ? "Your markup" : `${m.userName ?? "A member"}'s markup`}</span>
                {rev ? <span className="text-[var(--color-text-muted)]"> · Rev {rev}</span> : null}
                <span className="text-[var(--color-text-muted)]"> · {m.pageCount} page{m.pageCount === 1 ? "" : "s"} marked</span>
              </div>
              <div className="text-[var(--color-text-faint)]">Updated {m.updatedAt ? new Date(m.updatedAt).toLocaleString() : "—"}</div>
            </div>
            {onOpenMarkup && (
              <button
                type="button"
                onClick={() => onOpenMarkup(m)}
                className="shrink-0 text-[10px] font-bold text-blue-600 hover:text-blue-800 border border-blue-200 bg-blue-50 rounded-md px-2 py-1"
              >
                {mine ? "Open & continue" : "View"}
              </button>
            )}
          </li>
        );
      })}
      <li>
        <button type="button" onClick={load} className="text-[10px] text-[var(--color-text-muted)] hover:text-[var(--color-text)] inline-flex items-center gap-1">
          <RefreshCw className="w-3 h-3" /> Refresh
        </button>
      </li>
    </ul>
  );
}
