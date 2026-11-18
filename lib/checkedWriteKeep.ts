// lib/checkedWriteKeep.ts — checkedWrite's verdict, with the raw answer kept
// beside it (projects-joint J15c CHECKED-WRITE SWEEP, SAF-18; DEC-90 rulings
// 3 and 4).
//
// lib/checkedWrite.ts turns a write's answer into a verdict — ok, refused
// (zero rows) or db — and translates the error. Some callers need more than
// the verdict: the row an edit returned (`.select("*")`), or the database's
// own error in full, for the sentence the surface already showed and for a
// pre-migration fallback that classifies by code AND message. `answered`
// hands the builder to checkedWrite unchanged and keeps what it answered:
//
//   const kept: Kept = {};
//   const w = await checkedWrite(answered(supabase.from("t").update(p).eq("id", id).select("id"), kept));
//   if (!w.ok) throw new Error(w.code === "db" && kept.r?.error ? ownSentence(kept.r.error) : w.error);
//
// The census in lib/__tests__/checkedWrite.test.ts reads `checkedWrite(` in
// the statement, so the write stays inside that call.

/** What a supabase write builder answers. */
export type WriteAnswer = { data: unknown; error: { message: string; code?: string | null } | null };
/** Where `answered` keeps the answer (unset when the request threw). */
export type Kept = { r?: WriteAnswer };

/** The first row a checked write returned (an array answer, or one row). */
export function firstRow<T>(kept: Kept): T {
  const d = kept.r?.data;
  return (Array.isArray(d) ? d[0] : d) as T;
}

/** Pass a write builder to checkedWrite and keep its raw answer in `keep`.
 *  (Adopted through Promise.resolve, so any thenable — a builder, or a test
 *  double whose `then` returns nothing — is awaited the way `await` would.) */
export function answered<A extends WriteAnswer>(q: PromiseLike<A>, keep: Kept): Promise<A> {
  keep.r = undefined;
  return Promise.resolve(q).then((r) => { keep.r = r; return r; });
}
