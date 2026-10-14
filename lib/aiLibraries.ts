// lib/aiLibraries.ts — SERVER-ONLY. "Never send to AI", for a whole library.
//
// The per-document carve-out (documents.ai_excluded) already existed. This
// is the same promise for a whole Document Control library: nothing in it
// is mirrored into knowledge, read by vision or the drawing reader, or
// attached to an AI review. Every door asks here. A database without the
// column (migration 20261021 not applied) excludes nothing, as before.

import type { SupabaseClient } from "@supabase/supabase-js";

export async function excludedLibraryIds(admin: SupabaseClient, orgId: string): Promise<Set<string>> {
  const { data, error } = await admin.from("libraries").select("id").eq("org_id", orgId).eq("ai_excluded", true).limit(500);
  if (error) return new Set();
  return new Set(((data as Array<{ id: string }> | null) ?? []).map((r) => r.id));
}

/** The library a document lives in: its own column, else its folder's. */
async function libraryOf(admin: SupabaseClient, orgId: string, doc: { library_id: string | null; collection_id: string | null }): Promise<string | null> {
  if (doc.library_id) return doc.library_id;
  if (!doc.collection_id) return null;
  const { data } = await admin.from("collections").select("library_id").eq("id", doc.collection_id).eq("org_id", orgId).maybeSingle();
  return (data as { library_id?: string | null } | null)?.library_id ?? null;
}

/** May this document be sent to AI? Checks the file's own hold-back and its
 *  library's never-AI switch. */
export async function documentAiBlock(admin: SupabaseClient, orgId: string, documentId: string): Promise<{ blocked: boolean; reason: string | null }> {
  const { data } = await admin.from("documents").select("library_id, collection_id, ai_excluded").eq("id", documentId).eq("org_id", orgId).maybeSingle();
  const d = data as { library_id: string | null; collection_id: string | null; ai_excluded?: boolean } | null;
  if (!d) return { blocked: false, reason: null };
  if (d.ai_excluded) return { blocked: true, reason: "This document is held back from AI." };
  const lib = await libraryOf(admin, orgId, d);
  if (lib && (await excludedLibraryIds(admin, orgId)).has(lib)) return { blocked: true, reason: "This document's library is marked never send to AI." };
  return { blocked: false, reason: null };
}

/** Every document id in a library, including ones filed in its folders
 *  with no library column of their own. */
export async function documentIdsInLibrary(admin: SupabaseClient, orgId: string, libraryId: string): Promise<string[]> {
  const ids = new Set<string>();
  for (let from = 0; from < 50_000; from += 1000) {
    const { data } = await admin.from("documents").select("id").eq("org_id", orgId).eq("library_id", libraryId).order("id").range(from, from + 999);
    const rows = (data as Array<{ id: string }> | null) ?? [];
    for (const r of rows) ids.add(r.id);
    if (rows.length < 1000) break;
  }
  const { data: folders } = await admin.from("collections").select("id").eq("org_id", orgId).eq("library_id", libraryId).limit(5000);
  const fids = ((folders as Array<{ id: string }> | null) ?? []).map((f) => f.id);
  for (let i = 0; i < fids.length; i += 100) {
    const { data } = await admin.from("documents").select("id").eq("org_id", orgId).is("library_id", null).in("collection_id", fids.slice(i, i + 100)).limit(5000);
    for (const r of (data as Array<{ id: string }> | null) ?? []) ids.add(r.id);
  }
  return [...ids];
}

/** Delete the AI's copies of everything in a library: knowledge mirrors
 *  (their chunks, page readings and embeddings cascade) and text mentions.
 *  The documents themselves are untouched. */
export async function purgeLibraryFromAi(admin: SupabaseClient, orgId: string, libraryId: string): Promise<number> {
  const docIds = await documentIdsInLibrary(admin, orgId, libraryId);
  let purged = 0;
  for (let i = 0; i < docIds.length; i += 200) {
    const slice = docIds.slice(i, i + 200);
    const { data, error } = await admin.from("knowledge_documents").delete().eq("org_id", orgId).in("source_document_id", slice).select("id");
    // A boundary reported as enforced when it is not is worse than one
    // reported as failed.
    if (error) throw new Error(`The library is marked never-AI, but its AI copies could not all be removed: ${error.message}`);
    purged += ((data as unknown[] | null) ?? []).length;
    await admin.from("entity_mentions").delete().eq("org_id", orgId).in("document_id", slice).then(() => undefined, () => undefined);
  }
  return purged;
}
