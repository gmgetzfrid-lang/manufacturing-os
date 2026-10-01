// An in-memory, filter-aware PostgREST stand-in for the graph-assembly, scope
// and unit-identity tests (intelligence Round G, I-13).
//
// It honours what lib/orgGraph.ts, lib/scope.ts and /api/admin/unit-identity
// depend on: select (columns parsed only to raise a missing-column error;
// `{ count: "exact", head: true }` answers a count), eq / neq / in / gt /
// not(col, "is", null) / contains (array column), order (several keys,
// ascending, nullsFirst) + limit + range — filter, then sort, then window, as
// PostgREST does — maybeSingle / single, update(...).select() returning the
// rows that landed, insert, and rpc. A database that has not applied a
// migration is `missingTables` (42P01) / `missingColumns` (42703); a failing
// read is `readError`; RLS is `hidden` (rows a reader cannot see are absent
// from reads AND counts); `refuseWrites` makes an UPDATE match zero rows.
// Every call is recorded in `calls`. Not a database — it exists to prove what
// the app code does with the answers.

export type Row = Record<string, unknown>;
export type PgErr = { code?: string; message: string };

export interface GraphFakeDb {
  tables: Record<string, Row[]>;
  missingTables: Set<string>;
  missingColumns: Record<string, string[]>;
  readError: Record<string, PgErr>;
  hidden: Record<string, (r: Row) => boolean>;
  refuseWrites: Set<string>;
  writeError: Record<string, PgErr>;
  rpc: Record<string, (args: Record<string, unknown>) => { data: unknown; error: PgErr | null }>;
  calls: Array<{ table: string; method: string; args: unknown[] }>;
  seq: number;
}

export function newGraphFakeDb(): GraphFakeDb {
  return {
    tables: {}, missingTables: new Set(), missingColumns: {}, readError: {}, hidden: {},
    refuseWrites: new Set(), writeError: {}, rpc: {}, calls: [], seq: 0,
  };
}

export function resetGraphFakeDb(db: GraphFakeDb, tables: Record<string, Row[]> = {}): void {
  db.tables = tables;
  db.missingTables = new Set();
  db.missingColumns = {};
  db.readError = {};
  db.hidden = {};
  db.refuseWrites = new Set();
  db.writeError = {};
  db.rpc = {};
  db.calls = [];
  db.seq = 0;
}

type Filter = (r: Row) => boolean;

function cmp(x: unknown, y: unknown): number {
  if (typeof x === "number" && typeof y === "number") return x - y;
  const a = String(x), b = String(y);
  return a < b ? -1 : a > b ? 1 : 0;
}

export function makeGraphFake(db: GraphFakeDb) {
  function builder(table: string) {
    let op: "select" | "update" | "insert" = "select";
    let cols = "*";
    let head = false;
    let wantCount = false;
    let returning = false;
    let patch: Row = {};
    let payload: Row[] = [];
    const filters: Filter[] = [];
    const filterCols: string[] = [];
    const orderBy: Array<{ col: string; asc: boolean; nullsFirst: boolean }> = [];
    let lim: number | null = null;
    let rng: [number, number] | null = null;

    const visible = () => (db.tables[table] ?? []).filter((r) => !(db.hidden[table]?.(r)));
    const matches = () => visible().filter((r) => filters.every((f) => f(r)));

    const readFail = (): PgErr | null => {
      if (db.missingTables.has(table)) return { code: "42P01", message: `relation "public.${table}" does not exist` };
      if (db.readError[table]) return db.readError[table];
      const missing = db.missingColumns[table] ?? [];
      const named = [...(cols === "*" ? [] : cols.split(",").map((c) => c.trim())), ...filterCols];
      for (const c of named) {
        if (missing.includes(c)) return { code: "42703", message: `column ${table}.${c} does not exist` };
      }
      return null;
    };

    const run = (): { data: unknown; error: PgErr | null; count?: number | null } => {
      if (op === "update") {
        if (db.missingTables.has(table)) return { data: null, error: { code: "42P01", message: `relation "public.${table}" does not exist` } };
        for (const k of Object.keys(patch)) {
          if ((db.missingColumns[table] ?? []).includes(k)) return { data: null, error: { code: "42703", message: `column ${table}.${k} does not exist` } };
        }
        if (db.writeError[table]) return { data: null, error: db.writeError[table] };
        const hit = db.refuseWrites.has(table) ? [] : matches();
        for (const r of hit) Object.assign(r, patch);
        return { data: returning ? hit.map((r) => ({ ...r })) : null, error: null };
      }
      if (op === "insert") {
        if (db.writeError[table]) return { data: null, error: db.writeError[table] };
        const rows = payload.map((p) => ({ id: p.id ?? `${table}-${++db.seq}`, ...p }));
        (db.tables[table] ??= []).push(...rows);
        return { data: returning ? rows : null, error: null };
      }
      const err = readFail();
      if (err) return { data: null, error: err };
      let rows = matches();
      const count = rows.length;
      if (head) return { data: null, error: null, count };
      if (orderBy.length > 0) {
        rows = [...rows].sort((a, b) => {
          for (const o of orderBy) {
            const x = a[o.col], y = b[o.col];
            const xn = x === null || x === undefined, yn = y === null || y === undefined;
            if (xn || yn) {
              if (xn && yn) continue;
              return xn === o.nullsFirst ? -1 : 1;
            }
            const c = cmp(x, y);
            if (c !== 0) return o.asc ? c : -c;
          }
          return 0;
        });
      }
      if (rng) rows = rows.slice(rng[0], rng[1] + 1);
      if (lim !== null) rows = rows.slice(0, lim);
      // Project the selected columns, as PostgREST does (a legacy select
      // must not see a column it did not name).
      const names = cols === "*" ? null : cols.split(",").map((c) => c.trim()).filter(Boolean);
      const project = (r: Row): Row => {
        if (!names || names.some((n) => !/^[a-z_][a-z0-9_]*$/i.test(n))) return { ...r };
        const out: Row = {};
        for (const n of names) out[n] = r[n] ?? null;
        return out;
      };
      return { data: rows.map(project), error: null, count: wantCount ? count : undefined };
    };

    const self: Record<string, unknown> = new Proxy({}, {
      get(_t, prop: string) {
        if (prop === "then") {
          return (resolve: (v: unknown) => void, reject?: (e: unknown) => void) => {
            try { resolve(run()); } catch (e) { reject?.(e); }
          };
        }
        return (...args: unknown[]) => {
          db.calls.push({ table, method: prop, args });
          if (["eq", "neq", "in", "gt", "not", "contains", "order"].includes(prop)) filterCols.push(String(args[0]));
          switch (prop) {
            case "select": {
              if (op !== "select") { returning = true; return self; }
              cols = String(args[0] ?? "*");
              const o = args[1] as { head?: boolean; count?: string } | undefined;
              if (o?.head) head = true;
              if (o?.count) wantCount = true;
              return self;
            }
            case "update": op = "update"; patch = args[0] as Row; return self;
            case "insert": op = "insert"; payload = Array.isArray(args[0]) ? (args[0] as Row[]) : [args[0] as Row]; return self;
            case "eq": { const [k, v] = args as [string, unknown]; filters.push((r) => r[k] === v); return self; }
            case "neq": { const [k, v] = args as [string, unknown]; filters.push((r) => r[k] !== v); return self; }
            case "in": { const [k, v] = args as [string, unknown[]]; const s = new Set(v); filters.push((r) => s.has(r[k])); return self; }
            case "gt": { const [k, v] = args as [string, unknown]; filters.push((r) => r[k] !== null && r[k] !== undefined && cmp(r[k], v) > 0); return self; }
            case "not": {
              const [k, o, v] = args as [string, string, unknown];
              if (o === "is" && v === null) filters.push((r) => r[k] !== null && r[k] !== undefined);
              return self;
            }
            case "contains": {
              const [k, v] = args as [string, unknown[]];
              filters.push((r) => Array.isArray(r[k]) && v.every((x) => (r[k] as unknown[]).includes(x)));
              return self;
            }
            case "order": {
              const [col, o] = args as [string, { ascending?: boolean; nullsFirst?: boolean } | undefined];
              const asc = o?.ascending !== false;
              orderBy.push({ col, asc, nullsFirst: o?.nullsFirst ?? !asc });
              return self;
            }
            case "limit": lim = Number(args[0]); return self;
            case "range": rng = [Number(args[0]), Number(args[1])]; return self;
            case "maybeSingle":
            case "single": {
              const res = run();
              const data = Array.isArray(res.data) ? (res.data[0] ?? null) : res.data;
              if (prop === "single" && !data && !res.error) return Promise.resolve({ data: null, error: { code: "PGRST116", message: "no rows" } });
              return Promise.resolve({ data, error: res.error });
            }
            default:
              return self;
          }
        };
      },
    }) as Record<string, unknown>;
    return self;
  }
  return {
    from: (t: string) => builder(t),
    rpc: (name: string, args: Record<string, unknown>) => {
      db.calls.push({ table: `rpc:${name}`, method: "rpc", args: [args] });
      const f = db.rpc[name];
      return Promise.resolve(f ? f(args) : { data: null, error: { code: "PGRST202", message: `Could not find the function public.${name}` } });
    },
    auth: {
      getSession: async () => ({ data: { session: { access_token: "t" } } }),
      getUser: async () => ({ data: { user: null }, error: { message: "no" } }),
    },
  };
}
