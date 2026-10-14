// lib/aiBoundaryServer.ts — SERVER-ONLY. The AI boundary (lib/aiBoundary
// aiReadability) asked at QUERY time, for any door that hands a model what a
// controlled document says (intelligence KACL-9 / KACL-10).
//
// The knowledge sync keeps mirrors of documents the AI may not read out of
// the index, but it reads the held-back set once per pass and a controller
// can hold a document back while a pass runs; superseding a drawing likewise
// leaves its mirror until the next sync. A door that reads mirrors therefore
// re-asks the boundary itself, against the documents as they are now: held
// back (ai_excluded), not current (NOT_CURRENT_STATUSES, or archived), or no
// current file. The ask route carries its own copy of this read (I-03's);
// the orchestrator's mirror hop and the drawing / locate routes call this.

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { aiReadability } from "@/lib/aiBoundary";

/** Which of these controlled documents may the AI read NOW? Org-scoped, in
 *  slices of 100 ids (each slice answers at most 100 rows, inside any
 *  PostgREST max-rows). A document not found in the org is not readable.
 *  Fails CLOSED: a read that errors makes NONE of them readable (the ask
 *  route's rule) — a caller's upload-origin results, which name no
 *  controlled document, are untouched. */
export async function aiReadableControlledIds(orgId: string, docIds: readonly string[]): Promise<Set<string>> {
  const ok = new Set<string>();
  const ids = [...new Set(docIds.filter(Boolean))];
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await supabaseAdmin
      .from("documents")
      .select("id, ai_excluded, status, archived_at, current_version_id")
      .eq("org_id", orgId)
      .in("id", ids.slice(i, i + 100));
    if (error) return new Set();
    for (const d of (data ?? []) as Array<{
      id: string; ai_excluded: boolean | null; status: string | null; archived_at: string | null; current_version_id: string | null;
    }>) {
      const verdict = aiReadability({
        id: d.id, status: d.status, archivedAt: d.archived_at,
        currentVersionId: d.current_version_id, aiExcluded: !!d.ai_excluded,
      }, true);
      if (verdict.readable) ok.add(d.id);
    }
  }
  return ok;
}
