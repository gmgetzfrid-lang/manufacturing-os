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
