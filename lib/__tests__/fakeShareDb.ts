// A small stand-in for the database the /api/share routes talk to: tables
// of rows and the query shapes those routes use (select / insert / update,
// eq, in, overlaps, or, order, limit, single, maybeSingle, rpc). Not a test
// file itself; the share tests import it.
//
// `legacy: true` plays a database where 20261123_controlled_links.sql has
// not been run: selecting or writing any of its columns fails the way
// PostgREST does.

type Row = Record<string, unknown>;

const NEW_SHARE_COLS = ["items", "document_ids", "recipient", "allow_download", "code_hash", "code_failures"];

export function createFakeDb() {
  const tables: Record<string, Row[]> = {};
  const state = { legacy: false, seq: 0, rpcs: [] as Array<{ fn: string; args: unknown }> };

  function missing(table: string, cols: string[]) {
    if (!state.legacy) return null;
    const bad = cols.find((c) => (table === "document_shares" && NEW_SHARE_COLS.includes(c)) || (table === "download_audits" && c === "source"));
    return bad ? { code: "42703", message: `column ${table}.${bad} does not exist` } : null;
  }

  function from(table: string) {
    let op: "select" | "insert" | "update" = "select";
    let payload: Row | Row[] | null = null;
    let err: { code: string; message: string } | null = null;
    let limitN: number | null = null;
    const filters: Array<(r: Row) => boolean> = [];
    const rows = () => (tables[table] ??= []);

    const run = (): { data: Row[] | null; error: { code: string; message: string } | null } => {
      if (err) return { data: null, error: err };
      if (op === "insert") {
        const list = (Array.isArray(payload) ? payload : [payload!]).map((r) => ({ id: `row${++state.seq}`, created_at: new Date(Date.now() + state.seq).toISOString(), ...r }));
        rows().push(...list);
        return { data: list.map((r) => ({ ...r })), error: null };
      }
      let hit = rows().filter((r) => filters.every((f) => f(r)));
      if (op === "update") {
        for (const r of hit) Object.assign(r, payload);
        return { data: hit.map((r) => ({ ...r })), error: null };
      }
      if (limitN !== null) hit = hit.slice(0, limitN);
      return { data: hit.map((r) => ({ ...r })), error: null };
    };

    const q = {
      select(cols?: string) {
        if (op === "select") err = err ?? missing(table, (cols ?? "").split(",").map((c) => c.trim()));
        return q;
      },
      insert(p: Row | Row[]) {
        op = "insert"; payload = p;
        err = missing(table, Object.keys(Array.isArray(p) ? p[0] ?? {} : p));
        return q;
      },
      update(p: Row) {
        op = "update"; payload = p;
        err = missing(table, Object.keys(p));
        return q;
      },
      eq(k: string, v: unknown) { filters.push((r) => r[k] === v); return q; },
      in(k: string, vs: unknown[]) { filters.push((r) => vs.includes(r[k])); return q; },
      overlaps(k: string, vs: unknown[]) {
        err = err ?? missing(table, [k]);
        filters.push((r) => Array.isArray(r[k]) && (r[k] as unknown[]).some((x) => vs.includes(x)));
        return q;
      },
      or() { return q; },
      order() { return q; },
      limit(n: number) { limitN = n; return q; },
      async maybeSingle() { const r = run(); return { data: r.data?.[0] ?? null, error: r.error }; },
      async single() { const r = run(); return { data: r.data?.[0] ?? null, error: r.error ?? (r.data?.length ? null : { code: "PGRST116", message: "no rows" }) }; },
      then<T>(ok: (v: ReturnType<typeof run>) => T, bad?: (e: unknown) => T) { return Promise.resolve(run()).then(ok, bad); },
    };
    return q;
  }

  const client = {
    from,
    async rpc(fn: string, args: Record<string, unknown>) {
      state.rpcs.push({ fn, args });
      if (fn === "bump_share_access") {
        const r = (tables.document_shares ?? []).find((x) => x.id === args.p_share);
        if (r) { r.access_count = Number(r.access_count ?? 0) + 1; r.access_last_at = new Date().toISOString(); }
      }
      return { data: null, error: null };
    },
  };

  return { tables, state, client };
}
