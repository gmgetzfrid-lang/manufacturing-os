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
      <span className="shrink-0 inline-flex items-center gap-2 text-[14px] font-semibold text-[var(--color-heading)]">
        <span className="ui-icon-tile is-sm" aria-hidden><Star className="w-4 h-4" /></span>
        Favorites <span className="ui-count">{favs.length}</span>
      </span>
      <div className="flex items-center gap-1.5 overflow-x-auto min-w-0 [scrollbar-width:none]">
        {favs.map((d) => (
          // A pill per favorite: press the number to open it, the star inside
          // the pill takes it off.
          <span key={d.id} className="ui-tag shrink-0 !h-8 !pr-0.5 !gap-1">
            <button type="button" onClick={() => onOpenDoc?.(d.id)} title={d.title ? `Open ${d.documentNumber}: ${d.title}` : `Open ${d.documentNumber}`}
              className="inline-flex items-center gap-1.5 text-[15px] tabular-nums hover:underline underline-offset-2">
              {d.documentNumber}
              {d.rev && <span className="font-sans text-[13px] font-normal opacity-80">rev {d.rev}</span>}
            </button>
            <button type="button" onClick={() => void toggle(d.id)} aria-label={`Remove ${d.documentNumber} from favorites`} title="Remove from favorites"
              className="w-7 h-7 grid place-items-center rounded text-[var(--state-held)] hover:bg-[var(--color-surface)]">
              <Star className="w-3.5 h-3.5 fill-current" />
            </button>
          </span>
        ))}
      </div>
    </div>
  );
}
