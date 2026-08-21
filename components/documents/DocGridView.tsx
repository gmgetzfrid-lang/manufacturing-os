"use client";

// The library's non-table document layouts — Explorer's "List / Medium icons /
// Large icons" counterparts. One component renders all three because they
// share everything but geometry:
//   list   → dense single-line rows (small thumb, number, title, rev, status)
//   grid   → medium tiles with a first-page preview
//   thumbs → large preview tiles
// Selection, focus, drag, double-click-to-open, and right-click behave
// EXACTLY like the details table — the page owns that logic and passes it in,
// so switching views never changes what a gesture means.

import React from "react";
import DocThumb from "@/components/documents/DocThumb";
import { stateStyle, documentState } from "@/lib/stateColors";
import { Lock } from "lucide-react";
import type { DocumentRecord } from "@/types/schema";

export type DocViewLayout = "list" | "grid" | "thumbs";

interface DocGridViewProps {
  docs: DocumentRecord[];
  layout: DocViewLayout;
  selectedIds: ReadonlySet<string>;
  focusedId?: string | null;
  draggable?: boolean;
  onItemClick: (id: string, e: React.MouseEvent) => void;
  onItemDoubleClick: (doc: DocumentRecord) => void;
  onItemContextMenu?: (doc: DocumentRecord, e: React.MouseEvent) => void;
  onItemDragStart?: (doc: DocumentRecord, e: React.DragEvent) => void;
  /** Click on the empty background clears the selection (Explorer behavior). */
  onBackgroundClick?: () => void;
}

function StatusPill({ status }: { status?: string }) {
  if (!status) return null;
  return (
    <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded border ${stateStyle(documentState(status)).pill}`}>
      {status}
    </span>
  );
}

export default function DocGridView({
  docs,
  layout,
  selectedIds,
  focusedId,
  draggable,
  onItemClick,
  onItemDoubleClick,
  onItemContextMenu,
  onItemDragStart,
  onBackgroundClick,
}: DocGridViewProps) {
  const thumbWidth = layout === "thumbs" ? 190 : layout === "grid" ? 116 : 30;

  const itemShell = (doc: DocumentRecord, selected: boolean, focused: boolean) =>
    `${selected
      ? "bg-blue-50/80 border-blue-300 ring-1 ring-blue-200"
      : focused
        ? "bg-[var(--color-surface-2)] border-[var(--color-border-strong)]"
        : "bg-[var(--color-surface)] border-[var(--color-border)] hover:border-[var(--color-border-strong)] hover:bg-slate-50/60"
    } border cursor-pointer transition-colors select-none`;

  const commonHandlers = (doc: DocumentRecord) => ({
    draggable: !!draggable,
    onClick: (e: React.MouseEvent) => onItemClick(doc.id!, e),
    onDoubleClick: () => onItemDoubleClick(doc),
    onContextMenu: onItemContextMenu
      ? (e: React.MouseEvent) => { e.preventDefault(); onItemContextMenu(doc, e); }
      : undefined,
    onDragStart: onItemDragStart ? (e: React.DragEvent) => onItemDragStart(doc, e) : undefined,
  });

  if (layout === "list") {
    return (
      <div
        className="p-2 space-y-0.5"
        onClick={(e) => { if (e.target === e.currentTarget) onBackgroundClick?.(); }}
      >
        {docs.map((doc) => {
          const selected = selectedIds.has(doc.id!);
          const focused = focusedId === doc.id;
          return (
            <div
              key={doc.id}
              data-doc-item={doc.id}
              {...commonHandlers(doc)}
              className={`${itemShell(doc, selected, focused)} rounded-lg px-2 py-1 flex items-center gap-2.5`}
            >
              <DocThumb documentId={doc.id} width={thumbWidth} rounded="rounded" />
              <span className="font-mono text-xs font-bold text-[var(--color-text)] truncate max-w-[16ch] shrink-0">
                {doc.documentNumber || "—"}
              </span>
              <span className="text-xs text-[var(--color-text)] truncate flex-1">
                {doc.title || doc.name || "Untitled"}
              </span>
              {doc.rev && (
                <span className="text-[10px] font-bold bg-[var(--color-surface-2)] text-[var(--color-text-muted)] px-1.5 py-0.5 rounded shrink-0">
                  Rev {doc.rev}
                </span>
              )}
              <StatusPill status={doc.status} />
              {doc.checkedOutBy && (
                <Lock className="w-3 h-3 text-blue-500 shrink-0" aria-label="Checked out" />
              )}
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div
      className="p-3 grid gap-3"
      style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${layout === "thumbs" ? 210 : 136}px, 1fr))` }}
      onClick={(e) => { if (e.target === e.currentTarget) onBackgroundClick?.(); }}
    >
      {docs.map((doc) => {
        const selected = selectedIds.has(doc.id!);
        const focused = focusedId === doc.id;
        return (
          <div
            key={doc.id}
            data-doc-item={doc.id}
            {...commonHandlers(doc)}
            className={`${itemShell(doc, selected, focused)} rounded-xl p-2.5 flex flex-col items-center gap-2 relative`}
            title={doc.title || doc.name || undefined}
          >
            {doc.checkedOutBy && (
              <span className="absolute top-1.5 right-1.5 p-1 rounded-md bg-blue-50 border border-blue-200" title={`Checked out${doc.checkedOutByName ? ` · ${doc.checkedOutByName}` : ""}`}>
                <Lock className="w-3 h-3 text-blue-600" />
              </span>
            )}
            <DocThumb documentId={doc.id} width={thumbWidth} className="pointer-events-none" />
            <div className="w-full text-center min-w-0">
              <div className="font-mono text-[11px] font-bold text-[var(--color-text)] truncate">
                {doc.documentNumber || doc.title || doc.name || "—"}
              </div>
              {doc.documentNumber && (doc.title || doc.name) && (
                <div className="text-[10px] text-[var(--color-text-muted)] truncate mt-0.5">
                  {doc.title || doc.name}
                </div>
              )}
              <div className="flex items-center justify-center gap-1.5 mt-1.5">
                {doc.rev && (
                  <span className="text-[9px] font-bold bg-[var(--color-surface-2)] text-[var(--color-text-muted)] px-1 py-0.5 rounded">
                    Rev {doc.rev}
                  </span>
                )}
                <StatusPill status={doc.status} />
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
