// A small in-memory stand-in for the supabase-js query builder, for tests
// that drive real data-layer functions end to end (intelligence Round G,
// I-10). Supports the subset the registry / codebook / search modules use:
// select (incl. head counts), eq / neq / in / is / ilike / or (col.op.value
// terms), textSearch (substring over string columns), order, limit, range,
// maybeSingle / single, insert / update / delete / upsert with returning
// selects, unique keys (23505) and an RLS switch that makes a table's writes
// affect zero rows (PostgREST's silent refusal) or refuse an insert (42501).
// Not a database — it exists to prove what the app code does with answers.

export type Row = Record<string, unknown>;

export interface FakeDb {
  tables: Record<string, Row[]>;
  /** table → column tuples that must be unique (23505 on violation); a
   *  named entry reports that constraint name, as Postgres does. */
  unique: Record<string, Array<string[] | { cols: string[]; name: string; where?: (r: Row) => boolean }>>;
  /** tables whose UPDATE/DELETE silently affect zero rows and INSERT fails 42501. */
  refuseWrites: Set<string>;
  /** Every call, for assertions on query shape. */
  calls: Array<{ table: string; method: string; args: unknown[] }>;
  /** Max rows a plain select returns (PostgREST max-rows); undefined = no cap. */
  maxRows?: number;
  seq: number;
}

export function newFakeDb(): FakeDb {
  return { tables: {}, unique: {}, refuseWrites: new Set(), calls: [], seq: 0 };
}

type Filter = (r: Row) => boolean;

function likeToRegex(pattern: string): RegExp {
  const esc = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*").replace(/_/g, ".");
  return new RegExp(`^${esc}$`, "i");
}

function orTerm(term: string): Filter {
  // col.op.value — value may itself contain dots (a site code "2030.22").
  const m = term.match(/^([a-z_]+)\.(eq|ilike|like|in|is)\.(.*)$/i);
  if (!m) return () => false;
  const [, col, op, raw] = m;
  if (op === "eq") return (r) => String(r[col] ?? "") === raw;
  if (op === "ilike" || op === "like") { const re = likeToRegex(raw); return (r) => re.test(String(r[col] ?? "")); }
  if (op === "is") return (r) => (raw === "null" ? r[col] == null : String(r[col]) === raw);
  const vals = raw.replace(/^\(|\)$/g, "").split(",").map((v) => v.replace(/^"|"$/g, ""));
  return (r) => vals.includes(String(r[col]));
}

function splitOr(expr: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = "";
  for (const ch of expr) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

export function makeFakeSupabase(db: FakeDb) {
  function builder(table: string) {
    let op: "select" | "insert" | "update" | "delete" | "upsert" = "select";
    let payload: Row[] = [];
    let patch: Row = {};
    let upsertOn: string[] = [];
    let returning = false;
    let head = false;
    let wantCount = false;
    const filters: Filter[] = [];
    const orderBy: Array<{ col: string; asc: boolean }> = [];
    let lim: number | null = null;
    let rng: [number, number] | null = null;

    const rowsOf = () => (db.tables[table] ??= []);
    const matches = () => rowsOf().filter((r) => filters.every((f) => f(r)));
    const uniqueViolation = (candidate: Row, except?: Row) => {
      for (const spec of db.unique[table] ?? []) {
        const cols = Array.isArray(spec) ? spec : spec.cols;
        const where = Array.isArray(spec) ? undefined : spec.where;
        const name = Array.isArray(spec) ? `${table}_${cols.join("_")}_key` : spec.name;
        if (cols.some((c) => candidate[c] == null)) continue;
        if (where && !where(candidate)) continue;
        const clash = rowsOf().find((r) => r !== except && (!where || where(r)) && cols.every((c) => r[c] === candidate[c]));
        if (clash) return { code: "23505", message: `duplicate key value violates unique constraint "${name}"` };
      }
      return null;
    };

    const run = (): { data: unknown; error: unknown; count?: number } => {
      if (op === "insert" || op === "upsert") {
        if (db.refuseWrites.has(table)) return { data: null, error: { code: "42501", message: "new row violates row-level security policy" } };
        const out: Row[] = [];
        for (const p of payload) {
          const row: Row = { id: p.id ?? `${table}-${++db.seq}`, ...p };
          if (op === "upsert" && upsertOn.length > 0) {
            const existing = rowsOf().find((r) => upsertOn.every((c) => r[c] === row[c]));
            if (existing) { Object.assign(existing, p); out.push(existing); continue; }
          }
          const v = uniqueViolation(row);
          if (v) return { data: null, error: v };
          rowsOf().push(row);
          out.push(row);
        }
        return { data: returning ? out : null, error: null };
      }
      if (op === "update") {
        if (db.refuseWrites.has(table)) return { data: returning ? [] : null, error: null };
        const hit = matches();
        for (const r of hit) {
          const next = { ...r, ...patch };
          const v = uniqueViolation(next, r);
          if (v) return { data: null, error: v };
        }
        for (const r of hit) Object.assign(r, patch);
        return { data: returning ? hit : null, error: null };
      }
      if (op === "delete") {
        if (db.refuseWrites.has(table)) return { data: returning ? [] : null, error: null };
        const hit = matches();
        db.tables[table] = rowsOf().filter((r) => !hit.includes(r));
        return { data: returning ? hit : null, error: null };
      }
      let rows = matches();
      const count = rows.length;
      if (head) return { data: null, error: null, count };
      for (const o of [...orderBy].reverse()) {
        rows = [...rows].sort((a, b) => {
          const x = String(a[o.col] ?? ""), y = String(b[o.col] ?? "");
          return o.asc ? x.localeCompare(y) : y.localeCompare(x);
        });
      }
      if (rng) rows = rows.slice(rng[0], rng[1] + 1);
      if (lim != null) rows = rows.slice(0, lim);
      if (db.maxRows != null) rows = rows.slice(0, db.maxRows);
      return { data: rows, error: null, count: wantCount ? count : undefined };
    };

    const api: Record<string, (...a: never[]) => unknown> = {};
    const self = new Proxy(api, {
      get(_t, prop: string) {
        if (prop === "then") {
          return (resolve: (v: unknown) => void, reject?: (e: unknown) => void) => {
            try { resolve(run()); } catch (e) { reject?.(e); }
          };
        }
        return (...args: unknown[]) => {
          db.calls.push({ table, method: prop, args });
          switch (prop) {
            case "select": {
              if (op !== "select") returning = true;
              const o = args[1] as { head?: boolean; count?: string } | undefined;
              if (o?.head) head = true;
              if (o?.count) wantCount = true;
              return self;
            }
            case "insert": op = "insert"; payload = Array.isArray(args[0]) ? (args[0] as Row[]) : [args[0] as Row]; return self;
            case "upsert": {
              op = "upsert"; payload = Array.isArray(args[0]) ? (args[0] as Row[]) : [args[0] as Row];
              upsertOn = String((args[1] as { onConflict?: string } | undefined)?.onConflict ?? "").split(",").map((s) => s.trim()).filter(Boolean);
              return self;
            }
            case "update": op = "update"; patch = args[0] as Row; return self;
            case "delete": op = "delete"; return self;
            case "eq": { const [k, v] = args as [string, unknown]; filters.push((r) => r[k] === v); return self; }
            case "neq": { const [k, v] = args as [string, unknown]; filters.push((r) => r[k] !== v); return self; }
            case "in": { const [k, v] = args as [string, unknown[]]; filters.push((r) => v.includes(r[k])); return self; }
            case "is": { const [k, v] = args as [string, unknown]; filters.push((r) => (v === null ? r[k] == null : r[k] === v)); return self; }
            case "ilike": { const [k, p] = args as [string, string]; const re = likeToRegex(p); filters.push((r) => re.test(String(r[k] ?? ""))); return self; }
            case "or": { const terms = splitOr(String(args[0])).map(orTerm); filters.push((r) => terms.some((t) => t(r))); return self; }
            case "textSearch": {
              const q = String(args[1]).toLowerCase().replace(/[&|!:*()']/g, " ").trim();
              filters.push((r) => Object.values(r).some((v) => typeof v === "string" && q.length > 0 && v.toLowerCase().includes(q)));
              return self;
            }
            case "order": { const [col, o] = args as [string, { ascending?: boolean } | undefined]; orderBy.push({ col, asc: o?.ascending !== false }); return self; }
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
    });
    return self;
  }
  return {
    from: (t: string) => builder(t),
    auth: { getSession: async () => ({ data: { session: { access_token: "t" } } }) },
  };
}
