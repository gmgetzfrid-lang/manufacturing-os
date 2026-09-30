// lib/checkedWrite.ts — a write that cannot silently fail (GAP-402, narrow).
//
// supabase-js resolves with `{ error }` rather than throwing, and PostgREST
// answers an UPDATE / DELETE that row-level security filtered to zero rows
// with `{ data: null, error: null }` — success with nothing changed. Every
// decision path that destructured `{ error }` alone therefore reported
// success, wrote an audit row claiming the decision happened, and left the
// database saying otherwise (projects-tab SAF-3; OWN-14 found the same shape
// on ownership). The fix is one helper, adopted at every decision write:
//
//   const w = await checkedWrite(supabase.from("t").update(patch).eq("id", id).select("id"));
//   if (!w.ok) return { ok: false, error: w.error };   // NO audit row
//   await audit(...);                                   // only after a confirmed match
//
// The caller appends `.select("id")` (so the match count comes back) and the
// helper requires a non-empty result. Two typed failures, never raw Postgres
// text thrown at a user:
//   * refused — zero rows matched: no permission, or someone else changed
//     the row first (an optimistic `.eq("updated_at", …)` guard also lands here);
//   * db — the database returned an error; the two shapes every Projects
//     surface meets — a pending migration and a permission denial — are
//     translated to plain language, the rest carry the message (UX-10 /
//     REL-3 ask for no raw string at the top of the page — the surface
//     decides what to render from `code`). A pending migration reaches the
//     client in PostgREST's schema-cache shapes (PGRST204 unknown column,
//     PGRST205 unknown table), not only as raw Postgres 42P01 / 42703 — the
//     same set lib/checkoutEpisodes.ts and lib/branches.ts treat as missing.
//
// The same rule applies to inserts: `.insert(rows).select("id")` returns the
// rows that landed, and a refused insert is an error, not an empty success.
// lib/__tests__/checkedWrite.test.ts censuses lib/checklists.ts and
// lib/turnover.ts for any update/delete that bypasses this helper.

export const CHECKED_WRITE_REFUSED =
  "Nothing was changed — you don't have permission to do this, or someone else changed it first. Reload and try again.";

export type CheckedWriteFailure = { ok: false; code: "refused" | "db"; error: string; pgCode?: string };
export type CheckedWriteResult = { ok: true; ids: string[] } | CheckedWriteFailure;

interface PgErrorLike { message: string; code?: string | null }

/** Missing table / column: raw Postgres (42P01 undefined_table, 42703
 *  undefined_column) or PostgREST's schema cache (PGRST204 column, PGRST205
 *  table) — the shapes a write or read meets before its migration lands. */
const MISSING_SCHEMA_CODES = new Set(["42P01", "42703", "PGRST204", "PGRST205"]);

/** Plain language for the two error shapes the Projects area meets most,
 *  the raw message for the rest (never thrown, always returned). */
export function describeWriteError(err: PgErrorLike): string {
  const code = err.code ?? "";
  const msg = err.message ?? "";
  if (MISSING_SCHEMA_CODES.has(code)
    || /relation "[^"]+" does not exist/i.test(msg)
    || /column "[^"]+"( of relation "[^"]+")? does not exist/i.test(msg)
    || /in the schema cache/i.test(msg)) {
    return "This needs the latest database migration applied — nothing was changed.";
  }
  if (code === "42501" || /row-level security/i.test(msg)) {
    return "You don't have permission to do this — nothing was changed.";
  }
  return msg || "The write failed — nothing was changed.";
}

/**
 * Run a write that ends in `.select("id")` and require at least one matched
 * row. Resolves to `{ ok: true, ids }` or a typed failure; never throws.
 */
export async function checkedWrite(
  q: PromiseLike<{ data: unknown; error: PgErrorLike | null }>,
): Promise<CheckedWriteResult> {
  let res: { data: unknown; error: PgErrorLike | null };
  try {
    res = await q;
  } catch (e) {
    return { ok: false, code: "db", error: describeWriteError({ message: (e as Error)?.message ?? String(e) }) };
  }
  if (res.error) {
    return { ok: false, code: "db", error: describeWriteError(res.error), pgCode: res.error.code ?? undefined };
  }
  const rows = Array.isArray(res.data) ? (res.data as Array<Record<string, unknown>>) : res.data ? [res.data as Record<string, unknown>] : [];
  if (rows.length === 0) return { ok: false, code: "refused", error: CHECKED_WRITE_REFUSED };
  return { ok: true, ids: rows.map((r) => String(r.id)) };
}
