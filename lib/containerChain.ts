// lib/containerChain.ts
//
// THE container-chain resolver (DEC-36: one resolver, never a second copy).
//
// Policies that "attach to a library, folder or document — most specific
// DEFINED level wins" (review_control, doc_class; routing_control follows the
// same shape) resolve along ONE chain:
//
//   document → its folder → that folder's ancestors (nearest first) → library
//
// RG-3: every resolver used to read exactly ONE folder — the document's own
// collection — and jump straight to the library, so a policy set on
// "Piping / P&IDs" governed nothing under "Piping / P&IDs / Unit 12". Folders
// nest (collections.parent_id) and every folder row already carries its
// ancestor ids in `path_ids` (root first, parent last), so the walk is one
// extra read: the ancestors, ordered nearest first.
//
// Fail CLOSED on a transient failure (DEC-16 / RG-6): a PostgREST error on
// any read THROWS. "We couldn't read the policy" must never resolve as "no
// policy" — that is how a review gate or a PSM gate quietly turns itself off.
// A MISSING row (deleted / not visible) is not an error: that level simply
// defines nothing.

import { supabase } from "@/lib/supabase";

/** A column that resolves along the container chain. */
export type ChainColumn = "review_control" | "doc_class";

export interface ContainerChain<T> {
  /** The document's own value (undefined when no document id was given). */
  document: T | null | undefined;
  /** The folder the document sits in, then its ancestors, NEAREST FIRST. */
  folders: Array<{ id: string; value: T | null | undefined }>;
  /** The library's value. */
  library: T | null | undefined;
}

/** First DEFINED value along the chain, nearest level first. Pure. */
export function firstDefinedInChain<T>(
  chain: ContainerChain<T>,
  isDefined: (v: T | null | undefined) => v is T = (v): v is T => v !== null && v !== undefined,
): T | null {
  if (isDefined(chain.document)) return chain.document;
  for (const f of chain.folders) if (isDefined(f.value)) return f.value;
  if (isDefined(chain.library)) return chain.library;
  return null;
}

/** Build the folder list for a document's collection from an in-memory map
 *  of folder rows (bulk callers: the daily scan). Nearest first: the folder
 *  itself, then `path_ids` walked from the parent up to the root. A folder
 *  missing from the map contributes nothing (it defines nothing we can see). */
export function folderChainFromMap<T>(
  collectionId: string | null | undefined,
  folderMap: ReadonlyMap<string, { path_ids?: unknown; value: T | null | undefined }>,
): Array<{ id: string; value: T | null | undefined }> {
  if (!collectionId) return [];
  const self = folderMap.get(collectionId);
  const out: Array<{ id: string; value: T | null | undefined }> = [];
  if (self) out.push({ id: collectionId, value: self.value });
  const pathIds = Array.isArray(self?.path_ids) ? (self!.path_ids as string[]) : [];
  for (const id of [...pathIds].reverse()) {
    const node = folderMap.get(id);
    if (node) out.push({ id, value: node.value });
  }
  return out;
}

/**
 * Load the chain for one document from the live database. Throws on a
 * transient failure (the caller decides — enforcing callers fail closed).
 * `documentValue` lets a caller that already holds the document row (the
 * Inspector, the rev-up form) skip the document read.
 */
export async function loadContainerChain<T>(column: ChainColumn, doc: {
  id?: string | null;
  documentValue?: T | null;
  collectionId?: string | null;
  libraryId?: string | null;
}): Promise<ContainerChain<T>> {
  let document: T | null | undefined = doc.documentValue;
  if (document === undefined && doc.id) {
    const { data, error } = await supabase.from("documents").select(column).eq("id", doc.id).maybeSingle();
    if (error) throw error;
    document = ((data as Record<string, unknown> | null)?.[column] as T | null | undefined) ?? null;
  }

  const folders: Array<{ id: string; value: T | null | undefined }> = [];
  if (doc.collectionId) {
    const { data: own, error: ownErr } = await supabase
      .from("collections").select(`id, path_ids, ${column}`).eq("id", doc.collectionId).maybeSingle();
    if (ownErr) throw ownErr;
    const ownRow = own as Record<string, unknown> | null;
    if (ownRow) {
      folders.push({ id: doc.collectionId, value: (ownRow[column] as T | null | undefined) ?? null });
      const pathIds = Array.isArray(ownRow.path_ids) ? (ownRow.path_ids as string[]).filter(Boolean) : [];
      if (pathIds.length) {
        const { data: ancestors, error: ancErr } = await supabase
          .from("collections").select(`id, ${column}`).in("id", pathIds);
        if (ancErr) throw ancErr;
        const byId = new Map(((ancestors ?? []) as Array<Record<string, unknown>>).map((r) => [r.id as string, r]));
        for (const id of [...pathIds].reverse()) {
          const row = byId.get(id);
          if (row) folders.push({ id, value: (row[column] as T | null | undefined) ?? null });
        }
      }
    }
  }

  let library: T | null | undefined = null;
  if (doc.libraryId) {
    const { data: lib, error: libErr } = await supabase.from("libraries").select(column).eq("id", doc.libraryId).maybeSingle();
    if (libErr) throw libErr;
    library = ((lib as Record<string, unknown> | null)?.[column] as T | null | undefined) ?? null;
  }

  return { document, folders, library };
}
