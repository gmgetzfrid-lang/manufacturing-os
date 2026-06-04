// lib/favorites.ts
//
// Per-user document favorites. Each star toggle adds/removes a row
// in document_favorites. The useFavorites hook is the only thing
// components should consume — it handles loading, caching, and
// optimistic updates.

import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/lib/supabase";

export async function listFavoriteDocIds(orgId: string, userId: string): Promise<string[]> {
  const { data, error } = await supabase
    .from("document_favorites")
    .select("document_id")
    .eq("org_id", orgId)
    .eq("user_id", userId);
  if (error) throw new Error(error.message);
  return (data as Array<{ document_id: string }>).map((r) => r.document_id);
}

export async function favoriteDoc(orgId: string, userId: string, documentId: string): Promise<void> {
  const { error } = await supabase.from("document_favorites").upsert({
    org_id: orgId,
    user_id: userId,
    document_id: documentId,
  });
  if (error) throw new Error(error.message);
}

export async function unfavoriteDoc(userId: string, documentId: string): Promise<void> {
  const { error } = await supabase
    .from("document_favorites")
    .delete()
    .eq("user_id", userId)
    .eq("document_id", documentId);
  if (error) throw new Error(error.message);
}

export function useFavorites(orgId: string | null | undefined, userId: string | null | undefined) {
  const [favoriteIds, setFavoriteIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!orgId || !userId) return;
    let alive = true;
    void (async () => {
      setLoading(true);
      try {
        const ids = await listFavoriteDocIds(orgId, userId);
        if (alive) setFavoriteIds(new Set(ids));
      } catch (e) {
        console.warn("Favorites load failed:", e);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [orgId, userId]);

  const toggle = useCallback(async (documentId: string) => {
    if (!orgId || !userId) return;
    const isFav = favoriteIds.has(documentId);
    // Optimistic update
    setFavoriteIds((prev) => {
      const next = new Set(prev);
      if (isFav) next.delete(documentId);
      else next.add(documentId);
      return next;
    });
    try {
      if (isFav) await unfavoriteDoc(userId, documentId);
      else await favoriteDoc(orgId, userId, documentId);
    } catch (e) {
      // Revert on failure
      setFavoriteIds((prev) => {
        const next = new Set(prev);
        if (isFav) next.add(documentId);
        else next.delete(documentId);
        return next;
      });
      console.warn("Favorite toggle failed:", e);
    }
  }, [orgId, userId, favoriteIds]);

  const isFavorite = useCallback((docId: string) => favoriteIds.has(docId), [favoriteIds]);

  return { favoriteIds, isFavorite, toggle, loading };
}
