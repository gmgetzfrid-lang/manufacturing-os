// lib/ticketQueueRead.ts
//
// drafting-flow Round G, DF-P14 QUEUE READ AND STATUS-LABEL REMAINDERS —
// ROUTE-12 (the integrator's ruling under DEC-90: the queue's scope reads
// page until a short page, ordered, and a failed page fails the read
// visibly — never a short or empty queue shown as complete).
//
// The request queue (app/(protected)/requests/page.tsx) used to ask for its
// whole scope in ONE request. PostgREST answers every request with at most
// the project's max-rows (1000 by default, set per project) and nothing
// marks the answer short, so above that the least recently modified requests
// — the stalled ones — vanished from the list, the Needs-me lens and every
// count, while the attention badge still counted them. The read's `error`
// was not read either: a refused read showed "No matching tickets found".
//
// So each scope read is KEYSET-PAGED, the pattern of the drafter picker's
// member read (lib/ticketPickerMembers.ts): ordered by `last_modified` DESC
// (the queue's order, NULLs first as PostgreSQL puts them for DESC) with `id`
// DESC breaking ties, each page asking for the rows strictly after the last
// row it received — so a page the server shortened to its own max-rows never
// skips anyone, whatever that limit is. The first page carries an exact
// count. The read stops at the end: the count reached, or a page that adds
// nobody. A page shorter than asked is NEVER taken as the end on its own
// (fix pass): a server whose max-rows is below the page size shortens every
// page, so with no count (an old server, a proxy that drops Content-Range)
// the read carries on until a page adds nobody — one request more than the
// rows need, never a silently short list. A failed page fails the WHOLE read
// (`ok: false`), never a partial list presented as whole.
//
// Bounded: at most QUEUE_READ_CEILING rows (the whole history of a large
// workspace is not held in a browser tab). A read that stops there, or ends
// with fewer rows than its count (requests changed while it was read), says
// so: `complete: false` with `total` — the page states "N of M".
//
// Read only; the caller reads as the signed-in member (RLS decides).

/** Rows asked for per page — Supabase's default max-rows. A server whose
 *  max-rows is lower returns fewer; the keyset carries on from the last row
 *  it did return. */
export const QUEUE_PAGE = 1000;

/** The most rows one scope read holds (10 pages). Past it the list says it
 *  shows N of M rather than holding a workspace's whole history. */
export const QUEUE_READ_CEILING = 10_000;

type Row = Record<string, unknown>;
type PageAnswer = { data: unknown; error: { message?: string } | null; count?: number | null };

/** The PostgREST builder surface the reader drives (supabase-js's filter
 *  builder satisfies it). */
export interface QueueQuery extends PromiseLike<PageAnswer> {
  order(column: string, opts: { ascending: boolean }): QueueQuery;
  limit(n: number): QueueQuery;
  or(filters: string): QueueQuery;
}

/** Starts a FRESH query for the scope: its select (with the exact count when
 *  `counted`) and its filters — no order, no limit (the reader adds them). */
export type QueueScopeBuild = (counted: boolean) => QueueQuery;

export type QueueReadResult =
  | {
      ok: true;
      rows: Row[];
      /** The exact count the first page reported, or null when none came back. */
      total: number | null;
      /** Every row of the scope is in `rows`: the count reached, or — with no
       *  count — read until a page added nobody. */
      complete: boolean;
      /** The read stopped at the ceiling. */
      capped: boolean;
    }
  | { ok: false; error: string };

/** A PostgREST logic-tree value, double-quoted (a timestamp carries `:` and
 *  `.`, reserved inside `or=(…)`). */
const quoted = (v: string) => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** Every row of one queue scope, newest-modified first, keyset-paged. */
export async function readQueueScope(
  build: QueueScopeBuild,
  opts: { pageSize?: number; ceiling?: number } = {},
): Promise<QueueReadResult> {
  const pageSize = Math.max(1, opts.pageSize ?? QUEUE_PAGE);
  const ceiling = Math.max(1, opts.ceiling ?? QUEUE_READ_CEILING);
  const rows: Row[] = [];
  const seen = new Set<string>();
  let total: number | null = null;
  // The last row received: its last_modified (null = the NULLs-first region)
  // and its id.
  let cursor: { lm: string | null; id: string } | null = null;
  let capped = false;
  let stalled = false;
  try {
    for (;;) {
      let q = build(cursor === null);
      if (cursor !== null) {
        if (cursor.lm === null) {
          // Still among the NULL last_modified rows (DESC puts them first):
          // the rest of them after this id, then every row that has one.
          q = q.or(`and(last_modified.is.null,id.lt.${quoted(cursor.id)}),last_modified.not.is.null`);
        } else {
          q = q.or(`last_modified.lt.${quoted(cursor.lm)},and(last_modified.eq.${quoted(cursor.lm)},id.lt.${quoted(cursor.id)})`);
        }
      }
      const ask = Math.min(pageSize, ceiling - rows.length);
      const { data, error, count } = await q
        .order("last_modified", { ascending: false })
        .order("id", { ascending: false })
        .limit(ask);
      if (error) return { ok: false, error: error.message || "the request list could not be read" };
      if (cursor === null && typeof count === "number") total = count;
      const page = (Array.isArray(data) ? data : []) as Row[];
      let added = 0;
      for (const r of page) {
        const id = typeof r.id === "string" ? r.id : "";
        // Each request once: a server that ignored the keyset cannot loop the
        // read or list anyone twice.
        if (!id || seen.has(id)) continue;
        seen.add(id);
        rows.push(r);
        added++;
      }
      if (added === 0) {
        // A page that came back with rows yet added nobody: the server did
        // not honour the keyset — the read cannot say it holds everyone.
        if (page.length > 0) stalled = true;
        break;
      }
      if (total !== null && rows.length >= total) break;
      if (rows.length >= ceiling) { capped = true; break; }
      const tail = page[page.length - 1];
      const tailId = typeof tail?.id === "string" ? tail.id : "";
      if (!tailId) break;
      const tailLm = tail.last_modified;
      cursor = { lm: typeof tailLm === "string" && tailLm ? tailLm : null, id: tailId };
    }
    return { ok: true, rows, total, complete: !capped && !stalled && (total === null || rows.length >= total), capped };
  } catch (e) {
    return { ok: false, error: (e as Error)?.message || "the request list could not be read" };
  }
}
