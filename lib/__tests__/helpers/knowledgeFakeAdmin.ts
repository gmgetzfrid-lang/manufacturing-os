// An in-memory stand-in for the SERVICE-ROLE supabase client, for the
// knowledge memory and meaning-index route tests (intelligence Round G, I-02).
// It exists to prove what the app code does with answers — it is not a
// database and it bypasses no policy (the service role bypasses RLS anyway).
//
// Supports: from(table).select(cols, { count, head }) / insert / update /
// delete, eq / neq / in / is / not(col, "is", null) / gte / lt / ilike /
// textSearch (substring) / order / limit / range, maybeSingle / single, the
// `.select()` after a write (returning), and rpc(name, args) through a
// per-test handler. `failReads` / `failWrites` make a table answer an error;
// every call is recorded for assertions.

export type Row = Record<string, unknown>;

export interface FakeAdminState {
  user: { id: string } | null;
  tables: Record<string, Row[]>;
  calls: Array<{ table: string; method: string; args: unknown[] }>;
  failReads: Record<string, { code?: string; message: string }>;
  failWrites: Record<string, { code?: string; message: string }>;
  rpc: Record<string, (args: Record<string, unknown>) => { data: unknown; error: { code?: string; message: string } | null }>;
  seq: number;
}

export const freshAdminState = (): FakeAdminState => ({
  user: null, tables: {}, calls: [], failReads: {}, failWrites: {}, rpc: {}, seq: 0,
});

type Filter = (r: Row) => boolean;

const get = (r: Row, col: string): unknown => {
  // "ai_features->embedBuild" style JSON path (one level) — enough for the drain.
  const m = col.match(/^(\w+)->(\w+)$/);
  if (m) {
    const base = r[m[1]] as Record<string, unknown> | null | undefined;
    return base ? base[m[2]] : undefined;
  }
  return r[col];
};

export function makeFakeAdmin(state: FakeAdminState) {
  function builder(table: string) {
    let op: "select" | "insert" | "update" | "delete" = "select";
    let payload: Row[] = [];
    let patch: Row = {};
    let returning = false;
    let head = false;
    const filters: Filter[] = [];
    const orders: Array<{ col: string; asc: boolean }> = [];
    let lim: number | null = null;
    let rng: [number, number] | null = null;
    const rows = () => (state.tables[table] ??= []);
    const matched = () => rows().filter((r) => filters.every((f) => f(r)));

    const run = (): { data: unknown; error: unknown; count?: number } => {
      // Each failure hook is read exactly once per statement (a test may
      // count reads to fail the n-th write).
      if (op !== "select") { const fw = state.failWrites[table]; if (fw) return { data: null, error: fw }; }
      if (op === "select") { const fr = state.failReads[table]; if (fr) return { data: null, error: fr }; }
      if (op === "insert") {
        const out = payload.map((p) => ({ id: p.id ?? `${table}-${++state.seq}`, ...p }));
        rows().push(...out);
        return { data: returning ? out : null, error: null };
      }
      if (op === "update") {
        const hit = matched();
        for (const r of hit) Object.assign(r, patch);
        return { data: returning ? hit.map((r) => ({ ...r })) : null, error: null };
      }
      if (op === "delete") {
        const hit = matched();
        state.tables[table] = rows().filter((r) => !hit.includes(r));
        return { data: returning ? hit : null, error: null };
      }
      let out = matched();
      const count = out.length;
      if (head) return { data: null, error: null, count };
      for (const o of [...orders].reverse()) {
        out = [...out].sort((a, b) => {
          const x = String(get(a, o.col) ?? ""), y = String(get(b, o.col) ?? "");
          return o.asc ? x.localeCompare(y) : y.localeCompare(x);
        });
      }
      if (rng) out = out.slice(rng[0], rng[1] + 1);
      if (lim != null) out = out.slice(0, lim);
      return { data: out.map((r) => ({ ...r })), error: null, count };
    };

    const self: Record<string, unknown> = new Proxy({}, {
      get(_t, prop: string) {
        if (prop === "then") {
          return (resolve: (v: unknown) => void) => resolve(run());
        }
        return (...args: unknown[]) => {
          state.calls.push({ table, method: prop, args });
          switch (prop) {
            case "select": {
              if (op !== "select") returning = true;
              if ((args[1] as { head?: boolean } | undefined)?.head) head = true;
              return self;
            }
            case "insert": op = "insert"; payload = Array.isArray(args[0]) ? (args[0] as Row[]) : [args[0] as Row]; return self;
            case "update": op = "update"; patch = args[0] as Row; return self;
            case "delete": op = "delete"; return self;
            case "eq": { const [k, v] = args as [string, unknown]; filters.push((r) => get(r, k) === v); return self; }
            case "neq": { const [k, v] = args as [string, unknown]; filters.push((r) => get(r, k) !== v); return self; }
            case "in": { const [k, v] = args as [string, unknown[]]; filters.push((r) => v.includes(get(r, k))); return self; }
            case "is": { const [k, v] = args as [string, unknown]; filters.push((r) => (v === null ? get(r, k) == null : get(r, k) === v)); return self; }
            case "not": {
              const [k, o, v] = args as [string, string, unknown];
              if (o === "is" && v === null) filters.push((r) => get(r, k) != null);
              else filters.push((r) => get(r, k) !== v);
              return self;
            }
            case "gte": { const [k, v] = args as [string, number]; filters.push((r) => Number(get(r, k)) >= v); return self; }
            case "lt": { const [k, v] = args as [string, number]; filters.push((r) => Number(get(r, k)) < v); return self; }
            case "ilike": {
              const [k, p] = args as [string, string];
              const re = new RegExp(`^${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*")}$`, "i");
              filters.push((r) => re.test(String(get(r, k) ?? "")));
              return self;
            }
            case "textSearch": {
              const q = String(args[1]).toLowerCase();
              filters.push((r) => String(r.question ?? "").toLowerCase().includes(q) || String(r.answer ?? "").toLowerCase().includes(q));
              return self;
            }
            case "order": { const [col, o] = args as [string, { ascending?: boolean } | undefined]; orders.push({ col, asc: o?.ascending !== false }); return self; }
            case "limit": lim = Number(args[0]); return self;
            case "range": rng = [Number(args[0]), Number(args[1])]; return self;
            case "maybeSingle":
            case "single": {
              const res = run();
              const data = Array.isArray(res.data) ? (res.data[0] ?? null) : res.data;
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
    auth: {
      getUser: async () => (state.user
        ? { data: { user: state.user }, error: null }
        : { data: { user: null }, error: { message: "bad token" } }),
    },
    from: (t: string) => builder(t),
    rpc: async (name: string, args: Record<string, unknown>) => {
      state.calls.push({ table: `rpc:${name}`, method: "rpc", args: [args] });
      const h = state.rpc[name];
      if (!h) return { data: null, error: { code: "PGRST202", message: `Could not find the function public.${name}` } };
      return h(args);
    },
  };
}

/** 20261121's embed_build_marker_write, transcribed: the embedBuild key of
 *  knowledge_libraries.ai_features is set, merged into or cleared ALONE —
 *  every other key of the row is left exactly as it is — and only while the
 *  stored marker still names p_expect_user / was recorded at p_expect_at.
 *  Pinned to the SQL by the shape tests in embedDrain.test.ts. */
export function installMarkerRpc(state: FakeAdminState) {
  state.rpc.embed_build_marker_write = (a) => {
    const lib = (state.tables.knowledge_libraries ?? []).find((l) => l.id === a.p_library_id);
    if (!lib) return { data: false, error: null };
    const feats = (lib.ai_features ?? {}) as Row;
    const cur = feats.embedBuild && typeof feats.embedBuild === "object" ? feats.embedBuild as Row : null;
    if (a.p_patch && !cur) return { data: false, error: null };
    if (a.p_expect_user != null && cur?.userId !== a.p_expect_user) return { data: false, error: null };
    if (a.p_expect_at != null && cur?.at !== a.p_expect_at) return { data: false, error: null };
    if (a.p_patch) {
      const next: Row = { ...cur };
      for (const k of (a.p_drop as string[] | null) ?? []) delete next[k];
      feats.embedBuild = { ...next, ...((a.p_marker as Row | null) ?? {}) };
    } else if (a.p_marker == null) {
      delete feats.embedBuild;
    } else {
      feats.embedBuild = a.p_marker;
    }
    lib.ai_features = feats;          // the same object: other keys untouched
    return { data: true, error: null };
  };
}
