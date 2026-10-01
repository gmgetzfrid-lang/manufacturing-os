// lib/__tests__/helpers/restoreMemoryDb.ts
//
// An in-memory stand-in for the service-role Supabase client, faithful where
// the restore and export paths depend on it (admin-and-org Round G, P1): a
// write statement is atomic; `upsert` with ignoreDuplicates is ON CONFLICT
// (<target>) DO NOTHING and fails 42P10 when the target is not a declared
// key; any other declared unique key raises 23505; `count: "exact"` reports
// the rows actually written; reads filter with eq / in / not-null / is.

export type Row = Record<string, unknown>;

export const db = {
  rows: {} as Record<string, Array<Record<string, unknown>>>,
  /** Declared unique keys per table (PK first). Default: [["id"]]. */
  keys: {} as Record<string, string[][]>,
  writeError: null as null | ((table: string, op: string, rows: Array<Record<string, unknown>>) => { code: string; message: string } | null),
  readError: {} as Record<string, string>,
  writes: [] as Array<{ table: string; op: string; n: number }>,
  /** Every write statement attempted, successful or not. */
  attempts: [] as Array<{ table: string; op: string }>,
  /** Simulate a PostgREST that returns no count. */
  countless: false,
};

function keysOf(table: string): string[][] { return db.keys[table] ?? [["id"]]; }
const sameKey = (a: Row, b: Row, cols: string[]) => cols.every((c) => a[c] !== undefined && a[c] !== null && String(a[c]) === String(b[c]));

function exec(table: string, op: string, payload: unknown, opts: Record<string, unknown> | undefined, filters: Array<(r: Row) => boolean>, single: boolean) {
  const all = (db.rows[table] ??= []);
  if (op === "select") {
    if (db.readError[table]) return { data: null, error: { code: "XX000", message: db.readError[table] } };
    const out = all.filter((r) => filters.every((f) => f(r)));
    return { data: single ? (out[0] ?? null) : out, error: null, count: out.length };
  }
  if (op === "insert" || op === "upsert") {
    const rows = (Array.isArray(payload) ? payload : [payload]) as Row[];
    db.attempts.push({ table, op });
    const injected = db.writeError?.(table, op, rows);
    if (injected) return { data: null, error: injected, count: null };
    const keys = keysOf(table);
    let arbiter: string[] | null = null;
    if (op === "upsert") {
      const target = String(opts?.onConflict ?? "id").split(",").map((s) => s.trim());
      arbiter = keys.find((k) => k.length === target.length && k.every((c) => target.includes(c))) ?? null;
      if (!arbiter) return { data: null, error: { code: "42P10", message: "there is no unique or exclusion constraint matching the ON CONFLICT specification" }, count: null };
    }
    const staged: Row[] = [];
    for (const row of rows) {
      const pool = [...all, ...staged];
      if (arbiter && pool.some((r) => sameKey(r, row, arbiter!))) continue; // DO NOTHING
      const clash = keys.find((k) => pool.some((r) => sameKey(r, row, k)));
      if (clash) return { data: null, error: { code: "23505", message: `duplicate key value violates unique constraint "${table}_${clash.join("_")}_key"` }, count: null };
      staged.push({ ...row });
    }
    all.push(...staged);
    db.writes.push({ table, op, n: staged.length });
    return { data: null, error: null, count: opts?.count && !db.countless ? staged.length : null };
  }
  if (op === "update") {
    const injected = db.writeError?.(table, op, [payload as Row]);
    if (injected) return { data: null, error: injected };
    const hit = all.filter((r) => filters.every((f) => f(r)));
    for (const r of hit) Object.assign(r, payload as Row);
    db.writes.push({ table, op, n: hit.length });
    return { data: hit, error: null };
  }
  return { data: null, error: null };
}

export function from(table: string) {
  let op = "select"; let payload: unknown; let opts: Record<string, unknown> | undefined; let single = false;
  const filters: Array<(r: Row) => boolean> = [];
  const b: Record<string, unknown> = {
    select: () => b,
    insert: (rows: unknown, o?: Record<string, unknown>) => { op = "insert"; payload = rows; opts = o; return b; },
    upsert: (rows: unknown, o?: Record<string, unknown>) => { op = "upsert"; payload = rows; opts = o; return b; },
    update: (patch: unknown) => { op = "update"; payload = patch; return b; },
    eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return b; },
    in: (c: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[c])); return b; },
    not: (c: string, _o: string, _v: unknown) => { filters.push((r) => r[c] !== null && r[c] !== undefined); return b; },
    is: (c: string, v: unknown) => { filters.push((r) => (r[c] ?? null) === v); return b; },
    order: () => b, limit: () => b, range: () => b,
    maybeSingle: () => { single = true; return b; },
    single: () => { single = true; return b; },
    then: (res: (v: unknown) => void, rej: (e: unknown) => void) => {
      try { res(exec(table, op, payload, opts, filters, single)); } catch (e) { rej(e); }
    },
  };
  return b;
}

