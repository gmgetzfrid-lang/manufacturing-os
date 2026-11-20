"use client";

// FavoritesStrip — "My Favorites" section at the top of a library.
// Auto-hides when the user has no favorites in this library.

import React from "react";
import { Star, FileText } from "lucide-react";
import { useFavorites } from "@/lib/favorites";

interface LibraryDoc {
  id: string;
  documentNumber: string;
  title: string;
  rev?: string;
  status?: string;
}

interface FavoritesStripProps {
  orgId: string;
  userId: string;
  libraryDocs: LibraryDoc[];
  onOpenDoc?: (docId: string) => void;
}

export default function FavoritesStrip({
  orgId, userId, libraryDocs, onOpenDoc,
}: FavoritesStripProps) {
  const { favoriteIds, toggle } = useFavorites(orgId, userId);
  const favs = libraryDocs.filter((d) => favoriteIds.has(d.id));

  if (favs.length === 0) return null;

  return (
    <div className="px-4 sm:px-5 py-3.5 border-b border-[var(--color-border)] last:border-b-0">
      <div className="flex items-center gap-2 mb-2">
        <Star className="w-3.5 h-3.5 text-[var(--color-text-muted)]" />
        <span className="text-[11px] font-extrabold uppercase tracking-[0.14em] text-[var(--color-text-muted)]">
          My favorites
        </span>
        <span className="text-[11px] text-[var(--color-text-faint)]">· {favs.length}</span>
      </div>
      <div className="flex gap-2 overflow-x-auto pb-0.5 -mx-0.5 px-0.5">
        {favs.map((d) => (
          <button
            key={d.id}
            onClick={() => onOpenDoc?.(d.id)}
            className="shrink-0 max-w-[14rem] text-left rounded-xl bg-[var(--color-surface-2)] hover:bg-[var(--color-border)] transition-colors px-3 py-2 group"
          >
            <div className="flex items-center gap-1.5 mb-0.5">
              <FileText className="w-3 h-3 text-[var(--color-text-muted)] shrink-0" />
              <span className="text-[11px] font-bold text-[var(--color-text)] truncate">{d.documentNumber}</span>
              {d.rev && <span className="text-[11px] text-[var(--color-text-faint)] shrink-0">Rev {d.rev}</span>}
              <button
                onClick={(e) => { e.stopPropagation(); void toggle(d.id); }}
                className="ml-auto opacity-60 group-hover:opacity-100"
                title="Remove from favorites"
              >
                <Star className="w-3 h-3 text-amber-500 fill-amber-400" />
              </button>
            </div>
            <div className="text-[11px] text-[var(--color-text-muted)] truncate">{d.title}</div>
          </button>
        ))}
      </div>
    </div>
  );
}
