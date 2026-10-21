// lib/fetchAllRows.ts — read EVERY row of a query, not the first 1,000.
//
// The database API returns at most 1,000 rows per request unless asked for
// a range, and says nothing when it stops. A sync that read "the library's
// documents" in one request quietly saw only the first 1,000 — and, worse,
// compared two such samples to decide what to remove. This pages through a
// query in a stable order (callers must .order() on a unique column, e.g.
// id) until a short page says it's done.

export const PAGE_ROWS = 1000;

/** `page(from, to)` runs the query for that inclusive row range. */
export async function fetchAllRows<T>(
  page: (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>,
  cap = 200_000,
): Promise<{ rows: T[]; error: string | null }> {
  const rows: T[] = [];
  for (let from = 0; from < cap; from += PAGE_ROWS) {
    const { data, error } = await page(from, from + PAGE_ROWS - 1);
    if (error) return { rows, error: error.message };
    const got = (data ?? []) as T[];
    rows.push(...got);
    if (got.length < PAGE_ROWS) break;
  }
  return { rows, error: null };
}
