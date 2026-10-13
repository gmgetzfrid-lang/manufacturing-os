// lib/libraryDeleteImpact.ts — SERVER-ONLY (called with the service client).
//
// admin-and-org ALOG-3 (Round G, P8): what deleting a library destroys. A
// library DELETE cascades — collections, documents and document_sets name it
// NOT NULL … ON DELETE CASCADE, and document_versions / document_holds name
// their document the same way — so one statement removes every folder, every
// document record and every revision under it. The confirmation used to say
// documents "may become orphaned"; it now shows these counts, read before
// the delete, and the delete route records them in the audit row.
//
// Every read is checked and paged: a count that could not be read is a
// failure (the route then refuses the delete), never a zero shown to the
// person about to confirm it.
//
// Fix pass: the per-document counts run CONCURRENCY id-chunks at a time (a
// bounded pool, not one chunk after another), so a library of tens of
// thousands of documents is counted in a fraction of the serial time; the
// delete route also declares maxDuration. The first chunk that fails stops
// the pool and the whole count fails.

import type { SupabaseClient } from "@supabase/supabase-js";

export interface LibraryDeleteImpact {
  /** Folders (collections) in the library. */
  folders: number;
  /** Document records in the library. */
  documents: number;
  /** Revision rows (document_versions) of those documents. */
  revisions: number;
  /** Holds (stop-work signals) still open on those documents. */
  openHolds: number;
  /** Documents under legal hold — the database refuses the delete while any is. */
  legalHolds: number;
  /** Requests (tickets) raised from one of those documents; they are kept, the link is lost. */
  requests: number;
}

export type LibraryDeleteImpactResult =
  | { ok: true; impact: LibraryDeleteImpact }
  | { ok: false; error: string };

const PAGE = 1000;
const CHUNK = 150;
/** How many id-chunks are counted at once (each chunk is three head counts). */
export const LIBRARY_DELETE_COUNT_CONCURRENCY = 6;

type CountRes = { count: number | null; error: { message?: string } | null };

/** The three counts a confirmation is checked against: if any of them moved
 *  between the preview and the delete, the person confirmed something else. */
export const CONFIRMED_COUNT_KEYS = ["folders", "documents", "revisions"] as const;

export function impactChanged(seen: Partial<LibraryDeleteImpact> | null | undefined, now: LibraryDeleteImpact): boolean {
  if (!seen || typeof seen !== "object") return false;
  return CONFIRMED_COUNT_KEYS.some((k) => typeof seen[k] === "number" && seen[k] !== now[k]);
}

export async function countLibraryDeleteImpact(sb: SupabaseClient, orgId: string, libraryId: string): Promise<LibraryDeleteImpactResult> {
  try {
    // The documents (ids + legal hold), paged past PostgREST's row cap.
    const docs: Array<{ id: string; legal_hold: boolean | null }> = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await sb.from("documents").select("id, legal_hold")
        .eq("org_id", orgId).eq("library_id", libraryId).order("id", { ascending: true }).range(from, from + PAGE - 1);
      if (error) return { ok: false, error: `documents: ${error.message ?? "read failed"}` };
      const batch = (data ?? []) as Array<{ id: string; legal_hold: boolean | null }>;
      docs.push(...batch);
      if (batch.length < PAGE) break;
    }
    const folders = (await sb.from("collections").select("id", { count: "exact", head: true }).eq("library_id", libraryId)) as unknown as CountRes;
    if (folders.error || typeof folders.count !== "number") return { ok: false, error: `folders: ${folders.error?.message ?? "no count returned"}` };

    let revisions = 0, openHolds = 0, requests = 0;
    const ids = docs.map((d) => d.id);
    const chunks: string[][] = [];
    for (let i = 0; i < ids.length; i += CHUNK) chunks.push(ids.slice(i, i + CHUNK));
    const pool = { next: 0, failure: null as string | null };
    const countChunk = async (chunk: string[]): Promise<string | null> => {
      const [v, h, t] = (await Promise.all([
        sb.from("document_versions").select("id", { count: "exact", head: true }).in("record_id", chunk),
        sb.from("document_holds").select("id", { count: "exact", head: true }).in("document_id", chunk).is("released_at", null),
        sb.from("tickets").select("id", { count: "exact", head: true }).eq("org_id", orgId).in("metadata->source_document->>id", chunk),
      ])) as unknown as CountRes[];
      if (v.error || typeof v.count !== "number") return `revisions: ${v.error?.message ?? "no count returned"}`;
      if (h.error || typeof h.count !== "number") return `holds: ${h.error?.message ?? "no count returned"}`;
      if (t.error || typeof t.count !== "number") return `requests: ${t.error?.message ?? "no count returned"}`;
      revisions += v.count;
      openHolds += h.count;
      requests += t.count;
      return null;
    };
    const worker = async () => {
      while (pool.failure === null && pool.next < chunks.length) {
        const problem = await countChunk(chunks[pool.next++]);
        if (problem && pool.failure === null) pool.failure = problem;
      }
    };
    await Promise.all(Array.from({ length: Math.min(LIBRARY_DELETE_COUNT_CONCURRENCY, chunks.length) }, worker));
    if (pool.failure !== null) return { ok: false, error: pool.failure };
    return {
      ok: true,
      impact: {
        folders: folders.count,
        documents: docs.length,
        revisions,
        openHolds,
        legalHolds: docs.filter((d) => d.legal_hold === true).length,
        requests,
      },
    };
  } catch (e) {
    return { ok: false, error: (e as Error)?.message ?? String(e) };
  }
}
