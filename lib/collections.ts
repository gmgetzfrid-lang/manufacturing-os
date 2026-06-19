// lib/collections.ts
//
// Data access for curated collections (Phase 2 of the documents
// library upgrade). A curated collection is a named, ordered grouping
// of documents — admin-created ones surface as "playbooks" at the top
// of a library; user-scoped ones are personal pin sets.

import { supabase } from "@/lib/supabase";

export interface CuratedCollection {
  id: string;
  org_id: string;
  library_id: string | null;
  /** Folder (collections.id) this book is pinned to. null/undefined = library
   *  root. Optional so rows read before the migration still type-check. */
  folder_id?: string | null;
  name: string;
  description: string | null;
  icon: string | null;
  color: string | null;
  scope: "org" | "user";
  owner_user_id: string | null;
  sort_order: number | null;
  pinned: boolean;
  created_by: string;
  created_at: string;
  updated_by?: string | null;
  updated_at?: string | null;
}

export interface CuratedCollectionItem {
  collection_id: string;
  document_id: string;
  sort_order: number;
  notes: string | null;
  added_by: string | null;
  added_at: string;
}

// A book lives in ONE folder (collections.id); null = the library root. The
// list is scoped to the directory you're browsing so a book curated inside a
// folder doesn't bleed across the whole library.
export async function listCollections(params: {
  orgId: string;
  libraryId: string;
  userId: string;
  /** Current folder being viewed. null/undefined = library root. */
  folderId?: string | null;
}): Promise<CuratedCollection[]> {
  const folderId = params.folderId ?? null;
  const build = (scoped: boolean) => {
    let q = supabase
      .from("curated_collections")
      .select("*")
      .eq("org_id", params.orgId)
      .eq("library_id", params.libraryId)
      .or(`scope.eq.org,owner_user_id.eq.${params.userId}`);
    if (scoped) q = folderId ? q.eq("folder_id", folderId) : q.is("folder_id", null);
    return q
      .order("sort_order", { ascending: true, nullsFirst: false })
      .order("created_at", { ascending: false });
  };

  let { data, error } = await build(true);
  // Pre-migration safety: if folder_id doesn't exist yet, fall back to the old
  // library-wide list so the strip never breaks.
  if (error && isMissingFolderColumn(error)) ({ data, error } = await build(false));
  if (error) throw new Error(error.message);
  return (data as CuratedCollection[]) ?? [];
}

/** True when an error is "column curated_collections.folder_id does not exist"
 *  (Postgres 42703 / PostgREST schema-cache miss) — i.e. the migration hasn't
 *  been applied yet. */
function isMissingFolderColumn(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  return error.code === "42703" || error.code === "PGRST204" || /folder_id/i.test(error.message ?? "");
}

export async function createCollection(input: {
  orgId: string;
  libraryId: string;
  name: string;
  description?: string;
  icon?: string;
  color?: string;
  scope: "org" | "user";
  ownerUserId?: string;
  pinned?: boolean;
  createdBy: string;
  /** Folder to pin this book to. null/undefined = library root. */
  folderId?: string | null;
}): Promise<CuratedCollection> {
  const base = {
    org_id: input.orgId,
    library_id: input.libraryId,
    name: input.name,
    description: input.description ?? null,
    icon: input.icon ?? null,
    color: input.color ?? null,
    scope: input.scope,
    owner_user_id: input.scope === "user" ? input.ownerUserId : null,
    pinned: input.pinned ?? true,
    created_by: input.createdBy,
    updated_by: input.createdBy,
  };
  const row = { ...base, folder_id: input.folderId ?? null };

  let { data, error } = await supabase.from("curated_collections").insert(row).select("*").single();
  // Pre-migration safety: retry without folder_id if the column isn't there yet.
  if (error && isMissingFolderColumn(error)) {
    ({ data, error } = await supabase.from("curated_collections").insert(base).select("*").single());
  }
  if (error) throw new Error(error.message);
  return data as CuratedCollection;
}

export async function updateCollection(
  id: string,
  patch: Partial<Pick<CuratedCollection, "name" | "description" | "icon" | "color" | "pinned" | "sort_order" | "folder_id">>,
  updatedBy: string
): Promise<void> {
  const payload: Record<string, unknown> = { ...patch, updated_by: updatedBy, updated_at: new Date().toISOString() };
  let { error } = await supabase.from("curated_collections").update(payload).eq("id", id);
  // Pre-migration safety: retry without folder_id if the column isn't there yet.
  if (error && isMissingFolderColumn(error)) {
    delete payload.folder_id;
    ({ error } = await supabase.from("curated_collections").update(payload).eq("id", id));
  }
  if (error) throw new Error(error.message);
}

export async function deleteCollection(id: string): Promise<void> {
  const { error } = await supabase.from("curated_collections").delete().eq("id", id);
  if (error) throw new Error(error.message);
}

export async function listItems(collectionId: string): Promise<CuratedCollectionItem[]> {
  const { data, error } = await supabase
    .from("curated_collection_items")
    .select("*")
    .eq("collection_id", collectionId)
    .order("sort_order", { ascending: true });
  if (error) throw new Error(error.message);
  return (data as CuratedCollectionItem[]) ?? [];
}

/** Ordered document ids for several collections at once. Used by the
 *  collections strip so each "book" card knows its page count and can open
 *  straight into the multi-doc book viewer. Best-effort: returns {} on error. */
export async function listItemsForCollections(
  collectionIds: string[]
): Promise<Record<string, string[]>> {
  if (collectionIds.length === 0) return {};
  const { data, error } = await supabase
    .from("curated_collection_items")
    .select("collection_id, document_id, sort_order")
    .in("collection_id", collectionIds)
    .order("sort_order", { ascending: true });
  if (error) return {};
  const map: Record<string, string[]> = {};
  for (const row of (data ?? []) as Array<{ collection_id: string; document_id: string }>) {
    (map[row.collection_id] ||= []).push(row.document_id);
  }
  return map;
}

export async function addItem(input: {
  collectionId: string;
  documentId: string;
  notes?: string;
  addedBy: string;
}): Promise<void> {
  // Compute next sort_order = max + 1
  const { data: existing } = await supabase
    .from("curated_collection_items")
    .select("sort_order")
    .eq("collection_id", input.collectionId)
    .order("sort_order", { ascending: false })
    .limit(1);
  const nextOrder = existing && existing[0] ? (existing[0] as { sort_order: number }).sort_order + 1 : 0;

  const { error } = await supabase.from("curated_collection_items").upsert({
    collection_id: input.collectionId,
    document_id: input.documentId,
    sort_order: nextOrder,
    notes: input.notes ?? null,
    added_by: input.addedBy,
  });
  if (error) throw new Error(error.message);
}

export async function removeItem(collectionId: string, documentId: string): Promise<void> {
  const { error } = await supabase
    .from("curated_collection_items")
    .delete()
    .eq("collection_id", collectionId)
    .eq("document_id", documentId);
  if (error) throw new Error(error.message);
}

export async function reorderItems(collectionId: string, orderedDocIds: string[]): Promise<void> {
  // Bulk update sort_order
  const updates = orderedDocIds.map((docId, idx) =>
    supabase
      .from("curated_collection_items")
      .update({ sort_order: idx })
      .eq("collection_id", collectionId)
      .eq("document_id", docId)
  );
  await Promise.all(updates);
}

export async function updateItemNotes(
  collectionId: string,
  documentId: string,
  notes: string
): Promise<void> {
  const { error } = await supabase
    .from("curated_collection_items")
    .update({ notes })
    .eq("collection_id", collectionId)
    .eq("document_id", documentId);
  if (error) throw new Error(error.message);
}
