// lib/serverDocDelete.ts — SERVER-ONLY. Permanent document deletion in
// small statements.
//
// The browser used to delete selected documents one row at a time and
// ignored every error, so a 200-document delete crawled, half-failed
// silently, and the screen claimed success. Here: legal holds are checked
// against the DB (held records are reported, never deleted), rows go in
// slices — each delete cascades through revisions, links, activity and the
// rest — and a time budget keeps one call inside the serverless limit. The
// caller repeats with `remaining` until it's empty. Stored files are left to
// the admin orphan scan, exactly as the single-document path always did.

import type { SupabaseClient } from "@supabase/supabase-js";

// Ids travel in the request URL; ~100 uuids keeps it well under the API
// gateway's URL limit (a 439-row select-all overflowed it).
const READ_SLICE = 100;
const DELETE_SLICE = 25;

export interface HeldDoc { id: string; label: string }

export interface DocDeleteResult {
  deleted: string[];
  held: HeldDoc[];
  /** Ids not reached before the deadline — call again with these. */
  remaining: string[];
}

export async function deleteDocumentRows(
  admin: SupabaseClient, orgId: string, ids: string[], deadlineMs: number,
): Promise<DocDeleteResult> {
  const rows: Array<{ id: string; legal_hold: boolean | null; document_number: string | null; title: string | null; name: string | null }> = [];
  for (let i = 0; i < ids.length; i += READ_SLICE) {
    const { data, error } = await admin.from("documents")
      .select("id, legal_hold, document_number, title, name")
      .eq("org_id", orgId).in("id", ids.slice(i, i + READ_SLICE));
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as typeof rows));
  }
  const held = rows.filter((r) => r.legal_hold)
    .map((r) => ({ id: r.id, label: r.document_number || r.title || r.name || "a record" }));
  const todo = rows.filter((r) => !r.legal_hold).map((r) => r.id);
  const deleted: string[] = [];
  let i = 0;
  for (; i < todo.length && Date.now() < deadlineMs; i += DELETE_SLICE) {
    const slice = todo.slice(i, i + DELETE_SLICE);
    await deleteSlice(admin, slice);
    deleted.push(...slice);
  }
  return { deleted, held, remaining: todo.slice(i) };
}

/** documents and document_versions point at each other (current_version_id
 *  one way, record_id the other) with no cascade, so a bare document delete
 *  is refused by the database — the reason "Delete" did nothing. Same order
 *  as the single-document path: detach the pointer, drop the revisions,
 *  then the documents. */
async function deleteSlice(admin: SupabaseClient, ids: string[]): Promise<void> {
  const { data: vers, error: vErr } = await admin.from("document_versions")
    .select("id").in("record_id", ids).limit(5000);
  if (vErr) throw new Error(`Couldn't read revisions: ${vErr.message}`);
  const versionIds = ((vers ?? []) as Array<{ id: string }>).map((v) => v.id);

  const { error: e1 } = await admin.from("documents").update({ current_version_id: null }).in("id", ids);
  if (e1) throw new Error(`Couldn't detach current revisions: ${e1.message}`);

  // Other records that merely POINT at these revisions (a work package's
  // pinned revision, a branch's divergence point) let go of them. Best
  // effort: on a DB without those tables there is nothing to release.
  for (let k = 0; k < versionIds.length; k += READ_SLICE) {
    const chunk = versionIds.slice(k, k + READ_SLICE);
    await admin.from("work_package_documents").update({ pinned_version_id: null })
      .in("pinned_version_id", chunk).then(() => undefined, () => undefined);
    await admin.from("revision_branches").update({ diverged_from_version_id: null })
      .in("diverged_from_version_id", chunk).then(() => undefined, () => undefined);
  }

  // All of a document's revisions go in ONE statement — they reference
  // each other (supersedes / reverted-from), which is fine when every row
  // in the chain leaves together.
  const { error: e2 } = await admin.from("document_versions").delete().in("record_id", ids);
  if (e2) throw new Error(`Couldn't delete revisions: ${e2.message}`);
  const { error: e3 } = await admin.from("documents").delete().in("id", ids);
  if (e3) throw new Error(`Couldn't delete documents: ${e3.message}`);
}

/** Every live document filed directly in any of these folders (ids only). */
export async function docIdsInFolders(
  admin: SupabaseClient, orgId: string, folderIds: string[], cap = 20000,
): Promise<Array<{ id: string; legal_hold: boolean }>> {
  const out: Array<{ id: string; legal_hold: boolean }> = [];
  for (let i = 0; i < folderIds.length && out.length < cap; i += READ_SLICE) {
    for (let from = 0; out.length < cap; from += 1000) {
      const { data, error } = await admin.from("documents")
        .select("id, legal_hold").eq("org_id", orgId)
        .in("collection_id", folderIds.slice(i, i + READ_SLICE))
        .order("id").range(from, from + 999);
      if (error) throw new Error(error.message);
      const page = (data ?? []) as Array<{ id: string; legal_hold: boolean | null }>;
      out.push(...page.map((r) => ({ id: r.id, legal_hold: !!r.legal_hold })));
      if (page.length < 1000) break;
    }
  }
  return out;
}
