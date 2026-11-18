// lib/checkedWriteAnswer.ts — PostgREST's own answer, kept beside
// checkedWrite's verdict (projects-tab SAF-18, the J15 checked-write sweep;
// DEC-90's rulings 3 and 4).
//
// checkedWrite (lib/checkedWrite.ts) reduces a write's answer to a verdict:
// its matched ids, a typed refusal (zero rows), or a db failure whose error
// is translated into plain language. Some sites need more than the verdict:
//   * a surface that already showed the database's own sentence keeps it
//     (ruling 3 — the verdict decides, the words stay as they were);
//   * a pre-migration classification (isMissing… on code AND message) must
//     see the full error, not only checkedWrite's pgCode (ruling 4);
//   * a site that reads back more than the id (a hold row, a branch row,
//     the share links it revoked) uses the rows it wrote.
// `answered` hands the builder's answer to checkedWrite UNCHANGED and keeps
// a copy in `kept` — nothing about the write itself changes:
//
//   const kept = keptAnswer();
//   const w = await checkedWrite(answered(supabase.from("t").update(patch).eq("id", id).select("id"), kept));
//   if (kept.error) throw new Error(kept.error.message);   // the database's words, as before
//   if (!w.ok) throw new Error(CHECKED_WRITE_REFUSED);      // zero rows: the typed refusal
//
// A builder that REJECTS (a mock, or a fetch layer that throws) keeps its
// message as the error and still rejects, so checkedWrite reports it failed.

import type { PostgrestError } from "@supabase/supabase-js";
import { userFacingError } from "@/lib/userFacingError";

export interface KeptAnswer {
  /** The rows (or row) the write answered with; null before it answered. */
  data: unknown;
  /** The database's own error, whole (code, message, details, hint). */
  error: PostgrestError | null;
}

export function keptAnswer(): KeptAnswer {
  return { data: null, error: null };
}

export function answered<R extends { data: unknown; error: unknown }>(q: PromiseLike<R>, kept: KeptAnswer): Promise<R> {
  return Promise.resolve(q).then(
    (r) => {
      kept.data = r.data ?? null;
      kept.error = (r.error ?? null) as PostgrestError | null;
      return r;
    },
    (e: unknown) => {
      kept.error = { message: e instanceof Error ? e.message : String(e), code: "", details: "", hint: "" } as unknown as PostgrestError;
      throw e;
    },
  );
}

/** What a reorder whose writes did not all land says (a collection's pages,
 *  a folder's siblings): how many were not saved and, when some were, that
 *  the rest were — never "nothing was changed", since the other positions
 *  (and a drag's move across parents before the reorder) may have landed.
 *  `dbError`: the first database error among them, worded in the REASON
 *  form (lib/userFacingError, embedded) in place of the permission /
 *  conflict guess. */
export function reorderNotSaved(missed: number, total: number, what: string, dbError?: { message: string; code?: string | null } | null): string {
  const why = dbError
    ? userFacingError(dbError, { embed: true, context: "reorder" })
    : "you may not have permission to reorder these, or someone else changed them first.";
  return `${missed} of ${total} ${what} were not saved — ${why}` +
    (missed < total ? " The others were saved." : "") +
    " Reload to see the order as it stands.";
}
