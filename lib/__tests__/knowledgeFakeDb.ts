// An in-memory stand-in for the Supabase service-role client, just rich
// enough to drive lib/knowledgeIngest.ts, lib/knowledgeSourceSync.ts and
// /api/knowledge/ingest end to end (intelligence Round G, I-06 tests).
//
// It honours what those files depend on: filters (eq / neq / in / gt / gte /
// lt / lte / is / not-is / or), order + range + limit, `.select()` after a
// write returning the affected rows, statement atomicity (a failed insert
// writes nothing), the unique (document_id, page, seq) index on
// knowledge_chunks (23505), the foreign keys onto knowledge_documents
// (23503 on insert, CASCADE on delete), and a database that has NOT applied
// a migration yet (missingColumns → PGRST204, missingTables → 42P01).
// `hooks` run before each statement: a test uses them to inject a failure or
// to act as a second writer at an exact point in a batch.

export type Row = Record<string, unknown>;
export type DbErr = { code: string; message: string };
export type Op = {
  table: string;
  kind: "select" | "insert" | "update" | "delete";
  payload?: Row | Row[];
  returning: boolean;
  columns: string[] | "*";
};
type Filter = (r: Row) => boolean;

export const db = {
  tables: {} as Record<string, Row[]>,
  missingColumns: {} as Record<string, string[]>,
  missingTables: [] as string[],
  hooks: [] as Array<(op: Op, filters: FilterSpec[]) => { error: DbErr } | void>,
  ops: [] as Array<Op & { filters: FilterSpec[] }>,
  seq: 0,
};

export type FilterSpec = { col: string; op: string; value: unknown };

const UNIQUE: Record<string, string[][]> = {
  knowledge_chunks: [["document_id", "page", "seq"]],
};
/** child table → [column, parent table] with ON DELETE CASCADE. */
const CASCADES: Array<[string, string, string]> = [
  ["knowledge_chunks", "document_id", "knowledge_documents"],
  ["knowledge_page_entities", "document_id", "knowledge_documents"],
  ["entity_mentions", "knowledge_document_id", "knowledge_documents"],
  ["knowledge_line_traces", "document_id", "knowledge_documents"],
];

export function resetDb(tables: Record<string, Row[]> = {}): void {
  db.tables = JSON.parse(JSON.stringify(tables));
  db.missingColumns = {};
  db.missingTables = [];
  db.hooks = [];
  db.ops = [];
  db.seq = 0;
}

export const rowsOf = (t: string): Row[] => db.tables[t] ?? [];

const cmp = (a: unknown, b: unknown): number => {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b));
};

function matches(spec: FilterSpec): Filter {
  const { col, op, value } = spec;
  switch (op) {
    case "eq": return (r) => r[col] !== null && r[col] !== undefined && r[col] === value;
    case "neq": return (r) => r[col] !== value;
    case "in": return (r) => (value as unknown[]).includes(r[col]);
    case "gt": return (r) => r[col] != null && cmp(r[col], value) > 0;
    case "gte": return (r) => r[col] != null && cmp(r[col], value) >= 0;
    case "lt": return (r) => r[col] != null && cmp(r[col], value) < 0;
    case "lte": return (r) => r[col] != null && cmp(r[col], value) <= 0;
    case "is": return (r) => (value === null ? r[col] == null : r[col] === value);
    case "notis": return (r) => (value === null ? r[col] != null : r[col] !== value);
    case "or": {
      const parts = String(value).split(/,(?=[a-z_]+\.)/).map((p) => {
        const [c, o, ...rest] = p.split(".");
        let v: unknown = rest.join(".");
        if (typeof v === "string" && v.startsWith("\"") && v.endsWith("\"")) v = v.slice(1, -1);
        if (o === "is" && v === "null") v = null;
        return matches({ col: c, op: o, value: v });
      });
      return (r) => parts.some((f) => f(r));
    }
    default: throw new Error(`fake db: unsupported filter ${op}`);
  }
}

const orColumns = (v: unknown) => String(v).split(/,(?=[a-z_]+\.)/).map((p) => p.split(".")[0]);

function missingColumnError(table: string, col: string): DbErr {
  return { code: "PGRST204", message: `Could not find the '${col}' column of '${table}' in the schema cache` };
}

function project(r: Row, columns: string[] | "*"): Row {
  if (columns === "*") return { ...r };
  const out: Row = {};
  for (const c of columns) out[c] = r[c] ?? null;
  return out;
}

class Builder implements PromiseLike<{ data: unknown; error: DbErr | null; count?: number }> {
  private filters: FilterSpec[] = [];
  private orders: Array<[string, boolean]> = [];
  private rangeSpec: [number, number] | null = null;
  private limitN: number | null = null;
  private op: Op;
  private singleMode: "one" | "maybe" | null = null;
  constructor(table: string) {
    this.op = { table, kind: "select", returning: false, columns: "*" };
  }
  select(cols = "*") {
    const columns = cols.trim() === "*" ? "*" : cols.split(",").map((c) => c.trim()).filter(Boolean);
    if (this.op.kind === "select") this.op.columns = columns;
    else { this.op.returning = true; this.op.columns = columns; }
    return this;
  }
  insert(rows: Row | Row[]) { this.op.kind = "insert"; this.op.payload = rows; return this; }
  update(patch: Row) { this.op.kind = "update"; this.op.payload = patch; return this; }
  delete() { this.op.kind = "delete"; return this; }
  eq(col: string, value: unknown) { this.filters.push({ col, op: "eq", value }); return this; }
  neq(col: string, value: unknown) { this.filters.push({ col, op: "neq", value }); return this; }
  in(col: string, value: unknown[]) { this.filters.push({ col, op: "in", value }); return this; }
  gt(col: string, value: unknown) { this.filters.push({ col, op: "gt", value }); return this; }
  gte(col: string, value: unknown) { this.filters.push({ col, op: "gte", value }); return this; }
  lt(col: string, value: unknown) { this.filters.push({ col, op: "lt", value }); return this; }
  lte(col: string, value: unknown) { this.filters.push({ col, op: "lte", value }); return this; }
  is(col: string, value: unknown) { this.filters.push({ col, op: "is", value }); return this; }
  not(col: string, op: string, value: unknown) {
    if (op !== "is") throw new Error("fake db: not() supports is only");
    this.filters.push({ col, op: "notis", value }); return this;
  }
  or(expr: string) { this.filters.push({ col: "", op: "or", value: expr }); return this; }
  order(col: string, opts?: { ascending?: boolean }) { this.orders.push([col, opts?.ascending !== false]); return this; }
  range(from: number, to: number) { this.rangeSpec = [from, to]; return this; }
  limit(n: number) { this.limitN = n; return this; }
  maybeSingle() { this.singleMode = "maybe"; return this; }
  single() { this.singleMode = "one"; return this; }

  private run(): { data: unknown; error: DbErr | null } {
    const { table } = this.op;
    db.ops.push({ ...this.op, filters: [...this.filters] });
    for (const h of db.hooks) {
      const out = h(this.op, this.filters);
      if (out && out.error) return { data: null, error: out.error };
    }
    if (db.missingTables.includes(table)) {
      return { data: null, error: { code: "42P01", message: `relation "public.${table}" does not exist` } };
    }
    const missing = db.missingColumns[table] ?? [];
    const named = new Set<string>();
    for (const f of this.filters) {
      if (f.op === "or") orColumns(f.value).forEach((c) => named.add(c)); else named.add(f.col);
    }
    if (this.op.columns !== "*") this.op.columns.forEach((c) => named.add(c));
    const payloads = this.op.payload === undefined ? [] : Array.isArray(this.op.payload) ? this.op.payload : [this.op.payload];
    for (const p of payloads) Object.keys(p).forEach((c) => named.add(c));
    for (const c of named) if (missing.includes(c)) return { data: null, error: missingColumnError(table, c) };

    const all = (db.tables[table] ??= []);
    const pred = (r: Row) => this.filters.every((f) => matches(f)(r));
    const strip = (r: Row) => Object.fromEntries(Object.entries(r).filter(([k]) => !missing.includes(k)));

    if (this.op.kind === "insert") {
      const incoming: Row[] = payloads.map((p) => ({ id: (p.id as string) ?? `${table}-${++db.seq}`, ...p }));
      for (const [child, col, parent] of CASCADES) {
        if (child !== table) continue;
        for (const r of incoming) {
          if (r[col] != null && !(db.tables[parent] ?? []).some((p) => p.id === r[col])) {
            return { data: null, error: { code: "23503", message: `insert or update on table "${table}" violates foreign key constraint` } };
          }
        }
      }
      for (const key of UNIQUE[table] ?? []) {
        const seen = new Set(all.map((r) => key.map((k) => r[k]).join("|")));
        for (const r of incoming) {
          const k = key.map((c) => r[c]).join("|");
          if (seen.has(k)) return { data: null, error: { code: "23505", message: `duplicate key value violates unique constraint "${table}_uniq"` } };
          seen.add(k);
        }
      }
      all.push(...incoming.map(strip));
      return { data: this.op.returning ? incoming.map((r) => project(r, this.op.columns)) : null, error: null };
    }
    if (this.op.kind === "update") {
      const hit = all.filter(pred);
      for (const r of hit) Object.assign(r, this.op.payload as Row);
      return { data: this.op.returning ? hit.map((r) => project(r, this.op.columns)) : null, error: null };
    }
    if (this.op.kind === "delete") {
      const hit = all.filter(pred);
      db.tables[table] = all.filter((r) => !pred(r));
      // ON DELETE CASCADE onto the derived tables.
      for (const [child, col, parent] of CASCADES) {
        if (parent !== table) continue;
        const ids = new Set(hit.map((r) => r.id));
        db.tables[child] = (db.tables[child] ?? []).filter((r) => !ids.has(r[col]));
      }
      return { data: this.op.returning ? hit.map((r) => project(r, this.op.columns)) : null, error: null };
    }
    let out = all.filter(pred);
    for (const [col, asc] of [...this.orders].reverse()) {
      out = [...out].sort((a, b) => (asc ? 1 : -1) * cmp(a[col], b[col]));
    }
    if (this.rangeSpec) out = out.slice(this.rangeSpec[0], this.rangeSpec[1] + 1);
    if (this.limitN !== null) out = out.slice(0, this.limitN);
    const data = out.map((r) => project(r, this.op.columns));
    if (this.singleMode === "maybe") return { data: data[0] ?? null, error: null };
    if (this.singleMode === "one") return data.length === 1 ? { data: data[0], error: null } : { data: null, error: { code: "PGRST116", message: "not one row" } };
    return { data, error: null };
  }

  then<A = { data: unknown; error: DbErr | null }, B = never>(
    onfulfilled?: ((value: { data: unknown; error: DbErr | null }) => A | PromiseLike<A>) | null,
    onrejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    // A real round trip is asynchronous: yield first, so two drivers
    // awaiting in parallel interleave statement by statement.
    return Promise.resolve().then(() => this.run()).then(onfulfilled, onrejected);
  }
}

export const fakeAdmin = {
  from: (table: string) => new Builder(table),
  auth: {
    getUser: async (token: string) => token === "good"
      ? { data: { user: { id: "u-ctrl" } }, error: null }
      : token === "viewer"
        ? { data: { user: { id: "u-viewer" } }, error: null }
        : { data: { user: null }, error: { message: "bad token" } },
  },
};
