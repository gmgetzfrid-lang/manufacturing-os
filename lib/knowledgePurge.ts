// lib/knowledgePurge.ts — SERVER-ONLY. Delete knowledge documents, or a
// whole knowledge library, without one giant statement.
//
// Deleting a library used to be a single browser-side DELETE that cascaded
// through every document, chunk (each with a vector-index entry), page
// entity, question and chat thread in one transaction — past the database
// statement timeout on any real library, so it failed with a bare 500.
// Here the work is cut into small slices, each its own statement, inside a
// time budget; the caller calls again until `done`. Uploaded PDFs are
// removed from storage too (they never used to be). PDFs mirrored from
// document control belong to the controlled document and are never touched.

import type { SupabaseClient } from "@supabase/supabase-js";
import { DeleteObjectsCommand } from "@aws-sdk/client-s3";
import { r2, R2_BUCKET } from "@/lib/r2";

const DOC_SLICE = 20;
const ROW_SLICE = 500;

/** Delete rows of `table` matching a filter, a slice of ids at a time. */
async function deleteInSlices(
  admin: SupabaseClient, table: string, column: string, values: string[], deadline: number,
): Promise<boolean> {
  while (Date.now() < deadline) {
    const { data, error } = await admin.from(table).select("id").in(column, values).limit(ROW_SLICE);
    if (error) throw new Error(`${table}: ${error.message}`);
    const ids = ((data ?? []) as Array<{ id: string }>).map((r) => r.id);
    if (ids.length === 0) return true;
    const del = await admin.from(table).delete().in("id", ids);
    if (del.error) throw new Error(`${table}: ${del.error.message}`);
  }
  return false;
}

async function removeStoredFiles(keys: string[]): Promise<void> {
  for (let i = 0; i < keys.length; i += 500) {
    try {
      await r2.send(new DeleteObjectsCommand({
        Bucket: R2_BUCKET,
        Delete: { Objects: keys.slice(i, i + 500).map((Key) => ({ Key })), Quiet: true },
      }));
    } catch { /* the admin orphan scan reclaims anything left behind */ }
  }
}

export interface PurgeResult {
  done: boolean;
  removedDocuments: number;
  remainingDocuments: number;
}

/** One bounded pass. `documentIds` set = remove just those documents;
 *  unset = remove the whole library. */
export async function purgeKnowledge(admin: SupabaseClient, opts: {
  orgId: string; libraryId: string; documentIds?: string[]; deadlineMs: number;
}): Promise<PurgeResult> {
  const { orgId, libraryId, deadlineMs } = opts;
  const wholeLibrary = !opts.documentIds;
  let q = admin.from("knowledge_documents").select("id, file_key, source_document_id")
    .eq("org_id", orgId).eq("library_id", libraryId);
  if (opts.documentIds) q = q.in("id", opts.documentIds.slice(0, 2000));
  const { data: docRows, error } = await q.limit(5000);
  if (error) throw new Error(error.message);
  const docs = (docRows ?? []) as Array<{ id: string; file_key: string | null; source_document_id: string | null }>;

  let removed = 0;
  const ownPrefix = `orgs/${orgId}/knowledge/`;
  for (let i = 0; i < docs.length; i += DOC_SLICE) {
    if (Date.now() > deadlineMs) break;
    const slice = docs.slice(i, i + DOC_SLICE);
    const ids = slice.map((d) => d.id);
    // Heavy children first, in small statements, so the final document
    // delete has almost nothing left to cascade.
    if (!(await deleteInSlices(admin, "knowledge_page_entities", "document_id", ids, deadlineMs))) break;
    if (!(await deleteInSlices(admin, "knowledge_chunks", "document_id", ids, deadlineMs))) break;
    await admin.from("entity_mentions").delete().eq("org_id", orgId).in("knowledge_document_id", ids)
      .then(() => undefined, () => undefined);
    const keys = slice
      .filter((d) => !d.source_document_id && d.file_key?.startsWith(ownPrefix))
      .map((d) => d.file_key as string);
    const del = await admin.from("knowledge_documents").delete().in("id", ids);
    if (del.error) throw new Error(`knowledge_documents: ${del.error.message}`);
    await removeStoredFiles(keys);
    removed += ids.length;
  }
  const remaining = docs.length - removed;
  if (remaining > 0 || !wholeLibrary) {
    return { done: remaining === 0, removedDocuments: removed, remainingDocuments: remaining };
  }

  // Whole library: its documents are gone — now the rest of what it owns.
  if (!(await deleteInSlices(admin, "knowledge_questions", "library_id", [libraryId], deadlineMs))) {
    return { done: false, removedDocuments: removed, remainingDocuments: 0 };
  }
  // Conversations held in this library (their messages cascade per thread).
  while (Date.now() < deadlineMs) {
    const { data: threads } = await admin.from("chat_threads").select("id").eq("library_id", libraryId).limit(25);
    const tids = ((threads ?? []) as Array<{ id: string }>).map((t) => t.id);
    if (tids.length === 0) break;
    await admin.from("chat_threads").delete().in("id", tids);
  }
  if (Date.now() > deadlineMs) return { done: false, removedDocuments: removed, remainingDocuments: 0 };
  await admin.from("knowledge_sources").delete().eq("library_id", libraryId);
  await admin.from("knowledge_library_links").delete().or(`library_id.eq.${libraryId},linked_library_id.eq.${libraryId}`);
  const lib = await admin.from("knowledge_libraries").delete().eq("id", libraryId).eq("org_id", orgId);
  if (lib.error) throw new Error(`knowledge_libraries: ${lib.error.message}`);
  return { done: true, removedDocuments: removed, remainingDocuments: 0 };
}
