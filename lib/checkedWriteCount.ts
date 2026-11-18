// lib/checkedWriteCount.ts — a write that asks for its COUNT, read the way
// checkedWrite reads one that asks for its rows (projects-tab SAF-22, J15e;
// DEC-90's J15 rulings).
//
// checkedWrite (lib/checkedWrite.ts) needs the matched rows back
// (`.select("id")`). A bulk delete that may remove hundreds of thousands of
// rows — the admin purge — must not fetch every id to learn whether it
// matched: it asks PostgREST for `{ count: "exact" }` instead. `counted`
// hands that answer to checkedWrite as one placeholder row when the count is
// above zero (none when it is zero), and keeps the count and the database's
// own error, whole, in `kept`:
//
//   const kept = countKept();
//   const w = await checkedWrite(counted(sb.from("t").delete({ count: "exact" }).lt("created_at", cut), kept));
//   if (kept.error) …                    // the database's words, as before
//   const removed = kept.count;          // what the delete matched (null if not reported)
//
// The verdict's `ids` are NOT row ids here — only whether anything matched.

export interface CountKept {
  /** The number of rows the write matched; null when the answer carried none. */
  count: number | null;
  /** The database's own error, whole. */
  error: { message: string; code?: string | null } | null;
}

export function countKept(): CountKept {
  return { count: null, error: null };
}

export function counted(
  q: PromiseLike<{ count?: number | null; error: { message: string; code?: string | null } | null }>,
  kept: CountKept,
): Promise<{ data: Array<{ id: string }>; error: { message: string; code?: string | null } | null }> {
  return Promise.resolve(q).then(
    (r) => {
      kept.count = typeof r.count === "number" ? r.count : null;
      kept.error = r.error ?? null;
      return { data: (kept.count ?? 0) > 0 ? [{ id: `${kept.count} row(s)` }] : [], error: kept.error };
    },
    (e: unknown) => {
      kept.error = { message: e instanceof Error ? e.message : String(e) };
      throw e;
    },
  );
}
