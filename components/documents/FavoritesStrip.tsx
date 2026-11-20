"use client";

// FavoritesStrip — "My Favorites" section at the top of a library.
// Auto-hides when the user has no favorites in this library.

import React from "react";
import { Star } from "lucide-react";
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

  // One slim row: the label, then each favorite as a drawing number you
  // can open, with its star to take it off.
  return (
    <div className="flex items-center gap-3 px-4 sm:px-5 min-h-11 py-1 border-b border-[var(--color-border)] last:border-b-0">
      <span className="shrink-0 inline-flex items-center gap-1.5 text-[13px] font-semibold text-[var(--color-text-muted)]">
        <Star className="w-3.5 h-3.5" /> Favorites <span className="tabular-nums font-normal">{favs.length}</span>
      </span>
      <div className="flex items-center gap-1 overflow-x-auto min-w-0 [scrollbar-width:none]">
        {favs.map((d) => (
          <span key={d.id} className="shrink-0 inline-flex items-center rounded-md hover:bg-[var(--color-surface-2)]">
            <button type="button" onClick={() => onOpenDoc?.(d.id)} title={d.title ? `${d.documentNumber}: ${d.title}` : d.documentNumber}
              className="h-8 pl-2 pr-1 inline-flex items-center gap-1.5 font-display text-[15px] font-semibold tabular-nums text-[var(--color-accent-text)] hover:underline underline-offset-2">
              {d.documentNumber}
              {d.rev && <span className="font-sans text-[13px] font-normal text-[var(--color-text-muted)]">rev {d.rev}</span>}
            </button>
            <button type="button" onClick={() => void toggle(d.id)} aria-label={`Remove ${d.documentNumber} from favorites`} title="Remove from favorites"
              className="w-7 h-8 grid place-items-center rounded-md text-[var(--state-held)] hover:bg-[var(--color-surface-2)]">
              <Star className="w-3.5 h-3.5 fill-current" />
            </button>
          </span>
        ))}
      </div>
    </div>
  );
}
