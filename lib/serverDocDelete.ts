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
    const { error } = await admin.from("documents").delete().in("id", slice);
    if (error) throw new Error(`Couldn't delete documents: ${error.message}`);
    deleted.push(...slice);
  }
  return { deleted, held, remaining: todo.slice(i) };
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
