"use client";

// FavoriteStar — reusable star toggle for any document row.
// Reads from the useFavorites hook so toggling here updates every
// other star on the page in real time.

import React from "react";
import { Star } from "lucide-react";
import { useFavorites } from "@/lib/favorites";

interface FavoriteStarProps {
  orgId: string;
  userId: string;
  documentId: string;
  size?: number;
  className?: string;
}

export default function FavoriteStar({
  orgId, userId, documentId, size = 14, className = "",
}: FavoriteStarProps) {
  const { isFavorite, toggle } = useFavorites(orgId, userId);
  const fav = isFavorite(documentId);

  return (
    <button
      onClick={(e) => { e.stopPropagation(); void toggle(documentId); }}
      title={fav ? "Remove from favorites" : "Add to favorites"}
      className={`p-1 rounded hover:bg-amber-50 transition-colors ${className}`}
    >
      <Star
        className={fav ? "text-amber-500 fill-amber-400" : "text-slate-300 hover:text-amber-400"}
        style={{ width: size, height: size }}
      />
    </button>
  );
}
