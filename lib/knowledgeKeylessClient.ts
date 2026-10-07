// lib/knowledgeKeylessClient.ts — intelligence Round G (I-22): the library
// page's read of each document's keyless text-only count
// (knowledge_documents.vision_keyless_pages, 20261186), beside the document
// list. The list itself (listKnowledgeDocuments in lib/knowledge.ts) maps
// its rows to a fixed shape that does not carry the column, and that file is
// another package's; this read is the narrow alternative. It runs under the
// signed-in member's own RLS, on the same library and in the same order as
// the list.
//
// A database without 20261186 answers 42703 / PGRST204: nothing is shown,
// as before, and the read is not asked again in this tab. Any other failure
// shows nothing either (the count is never guessed); the next refresh asks
// again.

import { supabase } from "@/lib/supabase";
import { KEYLESS_PAGES_COLUMN, keylessCount } from "@/lib/knowledgeKeyless";

let columnAbsent = false;

const missingColumn = (e: { code?: string; message?: string } | null | undefined): boolean =>
  !!e && (e.code === "42703" || e.code === "PGRST204");

/** Each document of the library with a keyless text-only count above 0, by
 *  id. Empty when there is nothing to show, the column does not exist yet, or
 *  the read failed. */
export async function readKeylessTextPages(libraryId: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (columnAbsent) return out;
  try {
    const { data, error } = await supabase
      .from("knowledge_documents").select(`id, ${KEYLESS_PAGES_COLUMN}`).eq("library_id", libraryId)
      .order("created_at", { ascending: true });
    if (error) {
      if (missingColumn(error)) columnAbsent = true;
      return out;
    }
    for (const r of (data ?? []) as Array<Record<string, unknown>>) {
      const n = keylessCount(r[KEYLESS_PAGES_COLUMN]);
      if (n > 0 && typeof r.id === "string") out.set(r.id, n);
    }
  } catch {
    /* nothing shown — never a guessed count */
  }
  return out;
}

/** Tests only: forget that this tab found the column absent. */
export function resetKeylessColumnProbe(): void {
  columnAbsent = false;
}
