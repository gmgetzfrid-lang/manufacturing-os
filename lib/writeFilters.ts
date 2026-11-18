// lib/writeFilters.ts — a guarded write's filters, built inside the one
// statement that is handed to checkedWrite (projects-tab SAF-22, J15e).
//
// Routes built a compare-and-set as `let q = …update(…); q = v ? q.eq(…) :
// q.is(…, null); await q.select("id")`, which splits the write over several
// statements. These helpers keep the whole write — its filters included —
// inside the call to checkedWrite, so the census in
// lib/__tests__/checkedWrite.test.ts reads it as checked:
//
//   await checkedWrite(eqOrNull(sb.from("t").update(p).eq("id", id), "last_modified", lm).select("id"));
//   await checkedWrite(withFilters(sb.from("t").update(p).eq("id", id), (q) => (scoped ? q.eq("org_id", org) : q)).select("id"));
//
// The filters sent are exactly the ones the `let` form sent, in the same order.

/** The two filter methods the guard uses (structural: the generated builder
 *  types are too deep to constrain a generic on). */
type Guardable = { eq: (column: string, value: string) => unknown; is: (column: string, value: null) => unknown };

/** `.eq(column, value)`, or `.is(column, null)` when the value read was null
 *  or empty (PostgREST's `eq.null` never matches). */
export function eqOrNull<Q>(q: Q, column: string, value: string | null | undefined): Q {
  const g = q as unknown as Guardable;
  return (value ? g.eq(column, value) : g.is(column, null)) as Q;
}

/** The builder, narrowed by `f` (the conditional filters a `let q` added). */
export function withFilters<Q>(q: Q, f: (q: Q) => Q): Q {
  return f(q);
}
