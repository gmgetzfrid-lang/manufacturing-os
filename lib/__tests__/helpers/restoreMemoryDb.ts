// lib/__tests__/helpers/restoreMemoryDb.ts
//
// An in-memory stand-in for the service-role Supabase client, faithful where
// the restore and export paths depend on it (admin-and-org Round G, P1): a
// write statement is atomic; `upsert` with ignoreDuplicates is ON CONFLICT
// (<target>) DO NOTHING and fails 42P10 when the target is not a declared
// key; any other declared unique key raises 23505; a declared foreign key
// raises 23503 when a written row names a parent id no row holds (checked at
// the end of the statement, as Postgres's RI triggers are, so a row may name
// another row of the same statement); `count: "exact"` reports the rows
// actually written; reads filter with eq / in / not-null / is, honour
// `range`, and are cut at `maxRows` like PostgREST's max-rows setting.
// Fix pass 2: a write carrying any value for a GENERATED ALWAYS column is
// refused 428C9 (as Postgres refuses it — not a row-level code), and, with
// `authUsers` set, `users` behaves like users.id REFERENCES auth.users: a
// profile for a uid that is no sign-in account is refused 23503. Fix pass 5:
// `lt` filters (a guarded update), and `update(...).select()` answers the
// rows it changed. Admin-and-org P2 fix pass (ILIFE-6, the export's keyset
// paging): `gt` filters, and `order` / `limit` are honoured (they were
// no-ops) — sorted by each order column in turn, nulls last, before `range`,
// `limit` and the max-rows cut. Its second review fix pass (composite-key
// keyset): `or(...)` filters in PostgREST's logic-tree syntax — terms
// `col.eq.v` / `col.gt.v` / `col.lt.v`, nested `and(...)` / `or(...)`, and
// double-quoted values with backslash escapes.

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
  /** Declared foreign keys per table: `column` names an `id` of `parent`. */
  fks: {} as Record<string, Array<{ column: string; parent: string }>>,
  /** PostgREST's max-rows: a read returns at most this many rows. */
  maxRows: 1000,
  /** Columns the database computes, per table: a write naming one is refused 428C9. */
  generated: {} as Record<string, string[]>,
  /** The deployment's sign-in accounts; when set, a `users` row for any other id is refused 23503. */
  authUsers: null as Set<string> | null,
};

function keysOf(table: string): string[][] { return db.keys[table] ?? [["id"]]; }
const sameKey = (a: Row, b: Row, cols: string[]) => cols.every((c) => a[c] !== undefined && a[c] !== null && String(a[c]) === String(b[c]));

/** Postgres-like ascending comparison: numbers numerically, everything else as text, nulls last. */
function cmp(a: unknown, b: unknown): number {
  const an = a === null || a === undefined; const bn = b === null || b === undefined;
  if (an || bn) return an === bn ? 0 : an ? 1 : -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  const as = String(a); const bs = String(b);
  return as < bs ? -1 : as > bs ? 1 : 0;
}

/** Split a logic-tree list on its top-level commas (not inside parentheses or quotes). */
function splitTerms(src: string): string[] {
  const out: string[] = []; let depth = 0; let quoted = false; let cur = "";
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      cur += ch;
      if (ch === "\\") { cur += src[++i] ?? ""; continue; }
      if (ch === '"') quoted = false;
      continue;
    }
    if (ch === '"') { quoted = true; cur += ch; continue; }
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}
const unquote = (v: string) => (v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1).replace(/\\(.)/g, "$1") : v);
/** One PostgREST logic-tree term as a row predicate. */
function logicTerm(term: string): (r: Row) => boolean {
  const group = /^(and|or)\(([\s\S]*)\)$/.exec(term);
  if (group) {
    const parts = splitTerms(group[2]).map(logicTerm);
    return group[1] === "and" ? (r) => parts.every((f) => f(r)) : (r) => parts.some((f) => f(r));
  }
  const m = /^([^.]+)\.(eq|gt|lt)\.([\s\S]*)$/.exec(term);
  if (!m) throw new Error(`restoreMemoryDb: unsupported or() term ${term}`);
  const [, col, op, raw] = m;
  const v = unquote(raw);
  return (r) => {
    const x = r[col];
    if (x === null || x === undefined) return false;
    const c = cmp(typeof x === "number" ? x : String(x), typeof x === "number" ? Number(v) : v);
    return op === "eq" ? c === 0 : op === "gt" ? c > 0 : c < 0;
  };
}

function exec(table: string, op: string, payload: unknown, opts: Record<string, unknown> | undefined, filters: Array<(r: Row) => boolean>, single: boolean, range: [number, number] | null, orders: Array<{ col: string; asc: boolean }> = [], limit: number | null = null) {
  const all = (db.rows[table] ??= []);
  if (op === "select") {
    if (db.readError[table]) return { data: null, error: { code: "XX000", message: db.readError[table] } };
    const matched = all.filter((r) => filters.every((f) => f(r)));
    const sorted = orders.length === 0 ? matched : [...matched].sort((x, y) => {
      for (const o of orders) { const c = cmp(x[o.col], y[o.col]); if (c !== 0) return o.asc ? c : -c; }
      return 0;
    });
    const ranged = range ? sorted.slice(range[0], range[1] + 1) : sorted;
    const out = (limit !== null ? ranged.slice(0, limit) : ranged).slice(0, db.maxRows);
    return { data: single ? (out[0] ?? null) : out, error: null, count: matched.length };
  }
  if (op === "insert" || op === "upsert") {
    const rows = (Array.isArray(payload) ? payload : [payload]) as Row[];
    db.attempts.push({ table, op });
    const injected = db.writeError?.(table, op, rows);
    if (injected) return { data: null, error: injected, count: null };
    for (const c of db.generated[table] ?? []) {
      if (rows.some((r) => r[c] !== undefined)) {
        return { data: null, error: { code: "428C9", message: `cannot insert a non-DEFAULT value into column "${c}"` }, count: null };
      }
    }
    if (table === "users" && db.authUsers && rows.some((r) => !db.authUsers!.has(String(r.id)))) {
      return { data: null, error: { code: "23503", message: 'insert or update on table "users" violates foreign key constraint "users_id_fkey"' }, count: null };
    }
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
    for (const fk of db.fks[table] ?? []) {
      const parentRows = fk.parent === table ? [...all, ...staged] : (db.rows[fk.parent] ?? []);
      const orphan = staged.find((r) => r[fk.column] !== null && r[fk.column] !== undefined && !parentRows.some((p) => p.id === r[fk.column]));
      if (orphan) {
        return { data: null, error: { code: "23503", message: `insert or update on table "${table}" violates foreign key constraint "${table}_${fk.column}_fkey"` }, count: null };
      }
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
  let range: [number, number] | null = null;
  let limit: number | null = null;
  const orders: Array<{ col: string; asc: boolean }> = [];
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
    lt: (c: string, v: unknown) => { filters.push((r) => typeof r[c] === "number" && typeof v === "number" && (r[c] as number) < v); return b; },
    gt: (c: string, v: unknown) => { filters.push((r) => r[c] !== null && r[c] !== undefined && cmp(r[c], v) > 0); return b; },
    or: (expr: string) => { const fs = splitTerms(expr).map(logicTerm); filters.push((r) => fs.some((f) => f(r))); return b; },
    order: (c: string, o?: { ascending?: boolean }) => { orders.push({ col: c, asc: o?.ascending !== false }); return b; },
    limit: (n: number) => { limit = n; return b; },
    range: (from: number, to: number) => { range = [from, to]; return b; },
    maybeSingle: () => { single = true; return b; },
    single: () => { single = true; return b; },
    then: (res: (v: unknown) => void, rej: (e: unknown) => void) => {
      try { res(exec(table, op, payload, opts, filters, single, range, orders, limit)); } catch (e) { rej(e); }
    },
  };
  return b;
}

