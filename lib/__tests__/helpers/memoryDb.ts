// An in-memory PostgREST stand-in for the quality data-layer tests.
//
// Reads resolve from `state.tables[table]` filtered by the eq / is / in /
// not-null filters the chain collected; writes (insert / update / delete)
// mutate the table and answer `.select("id")` with the rows that landed —
// so a checked write sees the real match count. `state.refuse` makes every
// write match ZERO rows (what PostgREST returns under an RLS denial:
// { data: [], error: null }), `state.writeError` makes it error, and
// `state.readError[table]` makes a read error — the three shapes GAP-402 /
// QUAL-8 / UX-10 turn on. Every call is recorded in `state.calls`.
// `.rpc(fn, args)` answers from `state.rpc[fn]`; a function with no entry is
// MISSING (PostgREST's PGRST202), the shape a pending migration presents.

export const IS_NULL = Symbol("is-null");
export const NOT_NULL = Symbol("not-null");

export interface MemoryState {
  tables: Record<string, Array<Record<string, unknown>>>;
  calls: Array<{ table: string; method: string; args: unknown[] }>;
  /** Every write that reached the database, in order. */
  writes: Array<{ table: string; method: string; payload: unknown; filters: Array<[string, unknown]>; matched: number }>;
  /** true = every write matches zero rows; a list = only those tables. */
  refuse: boolean | string[];
  writeError: { message: string; code?: string } | null;
  /** A write error for one table only (e.g. a table or column a pending
   *  migration has not created yet, while the rest of the schema is live). */
  tableWriteError?: Record<string, { message: string; code?: string }>;
  readError: Record<string, { message: string; code?: string }>;
  /** Called after each read of `table` resolves — a hook for "someone else
   *  changed the row between the read and the write". */
  onRead?: (table: string) => void;
  /** Called with the rows a write landed on — a stand-in for a database
   *  trigger (e.g. 20261091's completion-basis rail) in a test that needs
   *  to show what the lib does with the value the database recorded. */
  afterWrite?: (table: string, method: string, rows: Array<Record<string, unknown>>) => void;
  /** Database functions by name (QUAL-4's quality_signoff_status, …); an
   *  absent one answers as not deployed yet (PGRST202). */
  rpc?: Record<string, (args: Record<string, unknown>) => { data: unknown; error: { message: string; code?: string } | null }>;
  nextId: number;
}

export const freshState = (): MemoryState => ({
  tables: {}, calls: [], writes: [], refuse: false, writeError: null, readError: {}, nextId: 1,
});

export function resetState(s: MemoryState) {
  s.tables = {}; s.calls = []; s.writes = []; s.refuse = false; s.writeError = null; s.tableWriteError = undefined; s.readError = {}; s.onRead = undefined; s.afterWrite = undefined; s.rpc = undefined; s.nextId = 1;
}

type Filter = [string, unknown];
const matches = (r: Record<string, unknown>, filters: Filter[]) =>
  filters.every(([k, v]) => {
    if (v === IS_NULL) return r[k] == null;
    if (v === NOT_NULL) return r[k] != null;
    if (v instanceof Set) return v.has(r[k]);
    return r[k] === v;
  });

/** A thenable that also answers .single() / .maybeSingle() — what a
 *  `.insert(...).select("id, org_id").single()` chain needs. */
function result(res: { data: unknown; error: unknown }) {
  const rows = Array.isArray(res.data) ? (res.data as unknown[]) : [];
  const one = () => Promise.resolve({ data: res.error ? null : rows[0] ?? null, error: res.error });
  return {
    then: (resolve: (v: unknown) => void, reject?: (e: unknown) => void) => Promise.resolve(res).then(resolve, reject),
    single: one,
    maybeSingle: one,
  };
}

export function makeSupabase(state: MemoryState) {
  function chain(table: string) {
    const filters: Filter[] = [];
    let pending: { method: string; payload: unknown } | null = null;
    const rows = () => (state.tables[table] ?? []).filter((r) => matches(r, filters));

    const applyWrite = () => {
      const w = pending!;
      pending = null;
      const writeError = state.writeError ?? state.tableWriteError?.[table] ?? null;
      if (writeError) {
        state.writes.push({ table, method: w.method, payload: w.payload, filters: [...filters], matched: 0 });
        return { data: null, error: writeError };
      }
      if (state.refuse === true || (Array.isArray(state.refuse) && state.refuse.includes(table))) {
        state.writes.push({ table, method: w.method, payload: w.payload, filters: [...filters], matched: 0 });
        return { data: [], error: null };
      }
      let landed: Array<Record<string, unknown>> = [];
      if (w.method === "insert") {
        const list = Array.isArray(w.payload) ? (w.payload as Array<Record<string, unknown>>) : [w.payload as Record<string, unknown>];
        landed = list.map((r) => ({ ...r, id: r.id ?? `${table}-${state.nextId++}` }));
        state.tables[table] = [...(state.tables[table] ?? []), ...landed];
      } else if (w.method === "update") {
        landed = rows();
        for (const r of landed) Object.assign(r, w.payload as Record<string, unknown>);
      } else if (w.method === "delete") {
        landed = rows();
        state.tables[table] = (state.tables[table] ?? []).filter((r) => !landed.includes(r));
      }
      state.writes.push({ table, method: w.method, payload: w.payload, filters: [...filters], matched: landed.length });
      state.afterWrite?.(table, w.method, landed);
      return { data: landed.map((r) => ({ ...r })), error: null };
    };

    const c: Record<string, unknown> = {};
    const h: ProxyHandler<Record<string, unknown>> = {
      get(_t, prop: string) {
        if (prop === "then") {
          return (resolve: (v: unknown) => void, reject?: (e: unknown) => void) => {
            const err = state.readError[table];
            const out = pending ? applyWrite() : err ? { data: null, error: err } : { data: rows().map((r) => ({ ...r })), error: null };
            if (!pending) state.onRead?.(table);
            return Promise.resolve(out).then(resolve, reject);
          };
        }
        return (...args: unknown[]) => {
          state.calls.push({ table, method: prop, args });
          if (prop === "insert" || prop === "update" || prop === "delete") { pending = { method: prop, payload: args[0] }; return new Proxy(c, h); }
          if (prop === "eq") filters.push([String(args[0]), args[1]]);
          if (prop === "is") filters.push([String(args[0]), args[1] === null ? IS_NULL : args[1]]);
          if (prop === "in") filters.push([String(args[0]), new Set(args[1] as unknown[])]);
          if (prop === "not" && args[1] === "is" && args[2] === null) filters.push([String(args[0]), NOT_NULL]);
          if (prop === "select" && pending) return result(applyWrite());
          if (prop === "maybeSingle" || prop === "single") {
            const err = state.readError[table];
            return Promise.resolve(err ? { data: null, error: err } : { data: rows()[0] ? { ...rows()[0] } : null, error: null });
          }
          return new Proxy(c, h);
        };
      },
    };
    return new Proxy(c, h);
  }
  return {
    from: (t: string) => chain(t),
    rpc: (fn: string, args: Record<string, unknown> = {}) => {
      state.calls.push({ table: `rpc:${fn}`, method: "rpc", args: [args] });
      const handler = state.rpc?.[fn];
      return Promise.resolve(handler
        ? handler(args)
        : { data: null, error: { code: "PGRST202", message: `Could not find the function public.${fn} in the schema cache` } });
    },
    auth: { getSession: async () => ({ data: { session: null } }) },
  };
}
