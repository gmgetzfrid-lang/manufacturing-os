"use client";

import React, { useMemo, useState } from "react";
import { X, CheckCircle2 } from "lucide-react";
import type { LibraryCollection } from "@/types/schema";
import FolderTree from "@/components/documents/FolderTree";

export default function MoveModal(props: {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (targetId: string | null) => void;
  collections: LibraryCollection[];
  currentId?: string | null;
  title?: string;
  allowRoot?: boolean;
}) {
  const { isOpen, onClose, onConfirm, collections, currentId, title, allowRoot = true } = props;
  const [selected, setSelected] = useState<string | null>(null);

  const filtered = useMemo(() => {
    if (!currentId) return collections;
    return collections.filter((c) => c.id !== currentId && !(c.pathIds || []).includes(currentId));
  }, [collections, currentId]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[80] flex items-start sm:items-center justify-center overflow-y-auto bg-slate-900/60 backdrop-blur-sm animate-in fade-in p-4">
      <div className="w-full max-w-3xl rounded-2xl bg-[var(--color-surface)] shadow-2xl border border-[var(--color-border)] overflow-hidden animate-in fade-in zoom-in-95">
        <div className="px-6 py-4 border-b border-[var(--color-border)] bg-[var(--color-surface-2)] flex items-center justify-between">
          <div>
            <div className="text-sm font-bold text-[var(--color-text)]">{title || "Move"}</div>
            <div className="text-xs text-[var(--color-text-muted)]">Select a destination folder.</div>
          </div>
          <button
            onClick={onClose}
            className="h-9 w-9 inline-flex items-center justify-center rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-2)]"
          >
            <X className="h-4 w-4 text-[var(--color-text-muted)]" />
          </button>
        </div>

        <div className="p-6">
          <FolderTree
            collections={filtered}
            currentFolderId={selected ?? undefined}
            onSelect={(id) => setSelected(id)}
            showRoot={allowRoot}
            rootLabel="Root"
          />
        </div>

        <div className="px-6 py-4 border-t border-[var(--color-border)] bg-[var(--color-surface-2)] flex items-center justify-end gap-2">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] text-sm font-bold text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"
          >
            Cancel
          </button>
          <button
            onClick={() => onConfirm(selected ?? null)}
            className="px-4 py-2 rounded-lg bg-slate-900 text-white text-sm font-bold hover:bg-slate-800 inline-flex items-center gap-2"
          >
            <CheckCircle2 className="h-4 w-4" />
            Move here
          </button>
        </div>
      </div>
    </div>
  );
}
