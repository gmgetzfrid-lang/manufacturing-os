// lib/__tests__/storageOrphansRecheck.test.ts
//
// intelligence ILIFE-6 criterion 3 (admin-and-org Round G, P3): the orphan
// purge re-checks every candidate key just before its DeleteObjects batch.
//
// The reference scan reads every key column page by page (keyset since A&O
// P2), and counts each table after its pages. One write pattern still hides a
// reference from it: a row already read is deleted while a row naming the key
// lands behind the cursor — the pages miss the new row and the count balances.
// The stand-in below models exactly that: rows marked `hiddenFromScan` are
// invisible to the scan's ordered page reads and to its counts (a balanced
// write), and visible to every other read — the re-check's one-statement
// `.in()` per plain column and its containment read per key for the
// JSON-embedded columns. A key named at re-check time is kept; a re-check
// that cannot read stops the purge before that batch with nothing in it
// deleted; a key nothing names is still deleted, as before.
//
// Review fix pass: the stand-in serialises a `.contains()` value the way
// postgrest-js does (an ARRAY becomes a Postgres array literal, `{…}`) and
// reads it back as jsonb, refusing what is not JSON with 22P02 — the first
// version stored the raw JS value, so it never saw that every array probe
// failed against PostgREST and the purge deleted nothing. Its `.or()` reads
// the logic-tree syntax (quoted values, backslash escapes). The last block
// drives the real supabase-js client through a stub fetch that answers like
// PostgREST, and pins the exact URL of every probe.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({
  rows: {} as Record<string, Array<Record<string, unknown>>>,
  hiddenFromScan: new Set<string>(),
  /** table → error message for its re-check reads (`.in` or `.contains`). */
  recheckErrors: {} as Record<string, string>,
  /** Fail the `.in` read whose key list contains this key. */
  failInWith: null as string | null,
  listing: [] as Array<{ Key: string; Size: number; LastModified: Date }>,
  deleted: [] as string[][],
  reads: [] as Array<{ table: string; kind: "page" | "count" | "in" | "contains" | "or" }>,
  /** Called on every re-check read (`in`, `or`, `contains`) — the deadline tests advance a clock here. */
  onRecheckRead: null as null | ((kind: "in" | "or" | "contains") => void),
  /** Called on every DeleteObjects send. */
  onDelete: null as null | (() => void),
}));

/** Postgres jsonb @> for the shapes the probes use. */
function containsJson(hay: unknown, needle: unknown): boolean {
  if (Array.isArray(needle)) return Array.isArray(hay) && needle.every((n) => hay.some((h) => containsJson(h, n)));
  if (needle && typeof needle === "object") {
    if (!hay || typeof hay !== "object" || Array.isArray(hay)) return false;
    return Object.entries(needle as Row).every(([k, v]) => containsJson((hay as Row)[k], v));
  }
  return hay === needle;
}

/** What PostgREST does with a `cs` value against a jsonb column: read the
 *  text as JSON, or refuse with 22P02. */
function jsonbLiteral(text: string): { ok: true; value: unknown } | { ok: false } {
  try { return { ok: true, value: JSON.parse(text) }; } catch { return { ok: false }; }
}
const INVALID_JSON = { code: "22P02", message: "invalid input syntax for type json" };

/** postgrest-js's `.contains()` serialisation (dist/index.mjs, `contains`). */
function containsWire(v: unknown): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return `{${v.join(",")}}`;
  return JSON.stringify(v);
}

/** Split a PostgREST list at its top-level commas: a double-quoted value may
 *  hold commas (and backslash-escaped `"` / `\\`); so may a `{…}` / `(…)`. */
function splitTop(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      cur += c;
      if (c === "\\") { cur += s[++i] ?? ""; continue; }
      if (c === '"') quoted = false;
      continue;
    }
    if (c === '"') { quoted = true; cur += c; continue; }
    if (c === "(" || c === "{" || c === "[") depth++;
    if (c === ")" || c === "}" || c === "]") depth--;
    if (c === "," && depth === 0) { out.push(cur); cur = ""; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

/** A logic-tree value as PostgREST reads it: a "…" value unquoted with its
 *  backslash escapes undone; anything else verbatim. */
function unquote(v: string): string {
  if (!(v.startsWith('"') && v.endsWith('"') && v.length >= 2)) return v;
  let out = "";
  const body = v.slice(1, -1);
  for (let i = 0; i < body.length; i++) out += body[i] === "\\" ? (body[++i] ?? "") : body[i];
  return out;
}

/** `col.cs.<value>,col.cs.<value>` → its terms (the only operator the probes use). */
function orTerms(filters: string): Array<{ col: string; op: string; value: string }> {
  return splitTop(filters).map((t) => {
    const a = t.indexOf(".");
    const b = t.indexOf(".", a + 1);
    return { col: t.slice(0, a), op: t.slice(a + 1, b), value: unquote(t.slice(b + 1)) };
  });
}

function chain(table: string) {
  let cols: string | null = null;
  let head = false;
  let ordered = false;
  let gt: unknown = null;
  let lim: number | null = null;
  let inFilter: { col: string; vals: unknown[] } | null = null;
  let contains: { col: string; val: unknown } | null = null;
  let orFilter: string | null = null;
  const visible = (scan: boolean) => (state.rows[table] ?? []).filter((r) => !(scan && state.hiddenFromScan.has(`${table}:${String(r.id)}`)));
  const run = () => {
    if (inFilter) {
      state.reads.push({ table, kind: "in" });
      state.onRecheckRead?.("in");
      if (state.recheckErrors[table] || (state.failInWith && inFilter.vals.includes(state.failInWith))) {
        return { data: null, error: { message: state.recheckErrors[table] ?? "statement timeout" }, count: null };
      }
      const hit = visible(false).filter((r) => inFilter!.vals.includes(r[inFilter!.col]));
      return { data: hit.map((r) => ({ [cols!]: r[cols!] })), error: null, count: hit.length };
    }
    if (contains) {
      state.reads.push({ table, kind: "contains" });
      state.onRecheckRead?.("contains");
      if (state.recheckErrors[table]) return { data: null, error: { message: state.recheckErrors[table] } };
      const lit = jsonbLiteral(containsWire(contains.val));
      if (!lit.ok) return { data: null, error: INVALID_JSON };
      const hit = visible(false).filter((r) => containsJson(r[contains!.col], lit.value));
      return { data: hit.slice(0, lim ?? hit.length).map((r) => ({ id: r.id })), error: null };
    }
    if (orFilter !== null) {
      state.reads.push({ table, kind: "or" });
      state.onRecheckRead?.("or");
      if (state.recheckErrors[table]) return { data: null, error: { message: state.recheckErrors[table] } };
      const terms = orTerms(orFilter).map((t) => ({ ...t, lit: jsonbLiteral(t.value) }));
      if (terms.some((t) => t.op !== "cs" || !t.lit.ok)) return { data: null, error: INVALID_JSON };
      const hit = visible(false).filter((r) => terms.some((t) => t.lit.ok && containsJson(r[t.col], t.lit.value)));
      return { data: hit.slice(0, lim ?? hit.length).map((r) => ({ id: r.id })), error: null };
    }
    if (head) { state.reads.push({ table, kind: "count" }); return { data: null, error: null, count: visible(true).length }; }
    state.reads.push({ table, kind: "page" });
    let out = visible(ordered).sort((a, b) => String(a.id).localeCompare(String(b.id)));
    if (gt !== null) out = out.filter((r) => String(r.id) > String(gt));
    if (lim !== null) out = out.slice(0, lim);
    return { data: out, error: null };
  };
  const b: Record<string, unknown> = {
    select: (c: string, o?: { head?: boolean }) => { cols = c; head = o?.head === true; return b; },
    order: () => { ordered = true; return b; },
    gt: (_c: string, v: unknown) => { gt = v; return b; },
    limit: (n: number) => { lim = n; return b; },
    in: (c: string, vals: unknown[]) => { inFilter = { col: c, vals }; return b; },
    contains: (c: string, v: unknown) => { contains = { col: c, val: v }; return b; },
    or: (f: string) => { orFilter = f; return b; },
    eq: () => b,
    then: (res: (v: unknown) => void) => res(run()),
  };
  return b;
}
const sb = { from: (t: string) => chain(t) } as never;

vi.mock("@/lib/r2", () => ({
  r2: {
    send: vi.fn(async (cmd: { input: Record<string, unknown> }) => {
      if (cmd.input.Delete) {
        state.onDelete?.();
        state.deleted.push((cmd.input.Delete as { Objects: Array<{ Key: string }> }).Objects.map((o) => o.Key));
        return { Errors: [] };
      }
      return { Contents: state.listing, IsTruncated: false };
    }),
  },
  R2_BUCKET: "b",
}));

import { deleteOrphans, recheckStillNamed, JSON_KEY_PROBES } from "@/lib/storageOrphans";
import { JSON_KEY_COLUMNS, STORAGE_KEY_SOURCES, keysOf } from "@/lib/storageKeyRegistry";

const ORG = "88888888-8888-4888-8888-888888888888";
const k = (p: string) => `orgs/${ORG}/${p}`;
const old = new Date(Date.now() - 30 * 86_400_000);
const object = (key: string) => ({ Key: key, Size: 10, LastModified: old });

beforeEach(() => {
  state.rows = {};
  state.hiddenFromScan = new Set();
  state.recheckErrors = {};
  state.failInWith = null;
  state.listing = [];
  state.deleted = [];
  state.reads = [];
  state.onRecheckRead = null;
  state.onDelete = null;
  vi.restoreAllMocks();
});

describe("ILIFE-6 c. 3 — deleteOrphans re-checks each candidate just before its DeleteObjects batch", () => {
  it("a plain-column reference the scan missed (a mirror that landed behind its cursor) is kept; the true orphan is still deleted", async () => {
    state.rows.knowledge_documents = [{ id: "kd-late", file_key: k("libraries/l/P-1.pdf") }];
    state.hiddenFromScan.add("knowledge_documents:kd-late");
    state.listing = [object(k("libraries/l/P-1.pdf")), object(k("stray/old.bin"))];
    const out = await deleteOrphans(sb, ORG);
    expect(state.deleted).toEqual([[k("stray/old.bin")]]);
    expect(out).toMatchObject({ deleted: 1, freedBytes: 10, kept: 1, errors: [] });
  });

  for (const [label, table, row] of [
    ["a ticket attachment", "tickets", (key: string) => ({ id: "t-late", attachments: [{ url: key, size: "1 MB" }] })],
    ["the workspace logo", "org_configurations", (key: string) => ({ id: "cfg-late", key: "branding", data: { logoPath: key } })],
    ["a template example (key)", "output_templates", (key: string) => ({ id: "ot-late", example_files: [{ key, name: "x.docx" }] })],
    ["a template example (url)", "output_templates", (key: string) => ({ id: "ot-late", example_files: [{ url: key }] })],
    ["a library background", "libraries", (key: string) => ({ id: "lib-late", page_config: { background: { type: "image", imagePath: key } } })],
    ["a folder background", "collections", (key: string) => ({ id: "col-late", page_config: { background: { imagePath: key } } })],
  ] as const) {
    it(`a JSON-embedded reference the scan missed — ${label} — is kept by its containment read`, async () => {
      const key = k(`json/${table}.bin`);
      const r = row(key);
      state.rows[table] = [r];
      state.hiddenFromScan.add(`${table}:${String(r.id)}`);
      state.listing = [object(key)];
      const out = await deleteOrphans(sb, ORG);
      expect(state.deleted).toEqual([]);
      expect(out).toMatchObject({ deleted: 0, kept: 1, errors: [] });
    });
  }

  it("a plain re-check read that fails stops the purge before that batch: nothing in it is deleted, and the error says so", async () => {
    state.listing = [object(k("a.bin")), object(k("b.bin"))];
    state.recheckErrors.cost_documents = "permission denied";
    const out = await deleteOrphans(sb, ORG);
    expect(state.deleted).toEqual([]);
    expect(out.deleted).toBe(0);
    expect(out.errors).toEqual([expect.stringMatching(/cost_documents\.file_url.*permission denied.*The purge stopped before this batch; nothing in it was deleted\./)]);
  });

  it("a containment read that fails does the same", async () => {
    state.listing = [object(k("a.bin"))];
    state.recheckErrors.tickets = "canceling statement due to statement timeout";
    const out = await deleteOrphans(sb, ORG);
    expect(state.deleted).toEqual([]);
    expect(out.errors[0]).toMatch(/tickets\.attachments still references .*a\.bin \(canceling statement due to statement timeout\); refusing to delete\. The purge stopped before this batch/);
  });

  it("a failure in the second batch leaves the first batch's deletions — and stops before the second", async () => {
    state.listing = Array.from({ length: 501 }, (_, i) => object(k(`orphan-${String(i).padStart(3, "0")}.bin`)));
    // the scan lists largest first, then by size ties in listing order; the 501st key lands in batch 2
    state.failInWith = k("orphan-500.bin");
    const out = await deleteOrphans(sb, ORG);
    expect(state.deleted).toHaveLength(1);
    expect(state.deleted[0]).toHaveLength(500);
    expect(state.deleted[0]).not.toContain(k("orphan-500.bin"));
    expect(out).toMatchObject({ deleted: 500 });
    expect(out.errors).toHaveLength(1);
  });

  it("no regression: keys nothing names are deleted as before, and a key outside the prefix is never sent", async () => {
    state.listing = [object(k("x.bin")), object(k("y.bin")), object("orgs/99999999-9999-4999-8999-999999999999/z.bin")];
    const out = await deleteOrphans(sb, ORG);
    expect(state.deleted).toEqual([[k("x.bin"), k("y.bin")]]);
    expect(out).toMatchObject({ deleted: 2, kept: 0, errors: [] });
  });

  it("the re-check runs after the scan and before the delete: one .in() per plain column, ONE batched containment statement per JSON column, no per-key read when nothing matches", async () => {
    state.listing = Array.from({ length: 10 }, (_, i) => object(k(`x-${i}.bin`)));
    await deleteOrphans(sb, ORG);
    const firstRecheck = state.reads.findIndex((r) => r.kind === "in");
    expect(firstRecheck).toBeGreaterThan(state.reads.map((r) => r.kind).lastIndexOf("count"));
    expect(state.reads.filter((r) => r.kind === "or").map((r) => r.table).sort()).toEqual(
      Object.values(JSON_KEY_PROBES).map((p) => p[0].table).sort(),
    );
    expect(state.reads.filter((r) => r.kind === "contains")).toHaveLength(0);
    expect(state.deleted.flat()).toHaveLength(10);
  });

  it("a match in a batched statement is resolved key by key: only the named key is kept, its neighbours still go", async () => {
    const named = k("json/named.bin");
    state.rows.tickets = [{ id: "t-late", attachments: [{ url: named }] }];
    state.hiddenFromScan.add("tickets:t-late");
    state.listing = [object(k("json/a.bin")), object(named), object(k("json/b.bin"))];
    const out = await deleteOrphans(sb, ORG);
    expect(out).toMatchObject({ deleted: 2, kept: 1, errors: [] });
    expect(state.deleted.flat().sort()).toEqual([k("json/a.bin"), k("json/b.bin")]);
    // one per-key read per candidate of the matching chunk, on tickets only
    expect(state.reads.filter((r) => r.kind === "contains").every((r) => r.table === "tickets")).toBe(true);
  });

  it("a long batch is split into statements under the URL budget, and every candidate is still asked", async () => {
    const long = (i: number) => k(`libraries/${"l".repeat(60)}/${String(i).padStart(4, "0")}-${"n".repeat(80)}.pdf`);
    state.listing = Array.from({ length: 120 }, (_, i) => object(long(i)));
    const named = long(97);
    state.rows.collections = [{ id: "col-late", page_config: { background: { imagePath: named } } }];
    state.hiddenFromScan.add("collections:col-late");
    const out = await deleteOrphans(sb, ORG);
    expect(state.reads.filter((r) => r.kind === "or" && r.table === "collections").length).toBeGreaterThan(1);
    expect(out).toMatchObject({ deleted: 119, kept: 1, errors: [] });
    expect(state.deleted.flat()).not.toContain(named);
  });

  it("the old wire form is what failed: an ARRAY handed to .contains() reaches PostgREST as `{[object Object]}` and is refused 22P02", async () => {
    const { data, error } = await (sb as unknown as { from: (t: string) => { select: (c: string) => { contains: (c: string, v: unknown) => { limit: (n: number) => Promise<{ data: unknown; error: { code?: string } | null }> } } } })
      .from("tickets").select("id").contains("attachments", [{ url: k("x.bin") }]).limit(1);
    expect(data).toBeNull();
    expect(error).toMatchObject({ code: "22P02" });
  });
});

describe("ILIFE-6 c. 3 — the probes cover the registry's JSON-embedded columns, in the extractors' own shapes", () => {
  it("one probe set per JSON_KEY_COLUMNS entry, no more", () => {
    expect(Object.keys(JSON_KEY_PROBES).sort()).toEqual(Object.keys(JSON_KEY_COLUMNS).sort());
  });

  it("each probe's shape is a value the registry's extractor reads the key back from", () => {
    const KEY = k("probe/check.bin");
    for (const [column, probes] of Object.entries(JSON_KEY_PROBES)) {
      for (const probe of probes) {
        expect(`${probe.table}.${probe.column}`, column).toBe(column);
        const sources = STORAGE_KEY_SOURCES.filter((s) => s.table === probe.table && s.keyColumns.includes(probe.column));
        expect(sources.length, column).toBeGreaterThan(0);
        const row: Row = { id: "r", [probe.column]: probe.shape(KEY), ...(probe.table === "org_configurations" ? { key: "branding" } : {}) };
        const found = sources.flatMap((s) => keysOf(s, row).map((x) => x.path));
        expect(found, `${column} ${JSON.stringify(probe.shape(KEY))}`).toContain(KEY);
      }
    }
  });

  it("recheckStillNamed answers the named keys and nothing else", async () => {
    state.rows.cost_documents = [{ id: "cd", file_url: k("q.pdf") }];
    state.rows.tickets = [{ id: "t", attachments: [{ url: k("att.pdf") }] }];
    const named = await recheckStillNamed(sb, [k("q.pdf"), k("att.pdf"), k("free.bin")]);
    expect([...named].sort()).toEqual([k("att.pdf"), k("q.pdf")]);
  });
});

describe("ILIFE-6 c. 3 review fix — the purge stops at a batch boundary before the route's time limit", () => {
  it("a deadline already past: nothing is checked or deleted, and the answer says to run it again", async () => {
    state.listing = [object(k("a.bin")), object(k("b.bin"))];
    const out = await deleteOrphans(sb, ORG, { deadline: Date.now() - 1 });
    expect(state.deleted).toEqual([]);
    expect(state.reads.filter((r) => r.kind === "in" || r.kind === "or")).toEqual([]);
    expect(out).toMatchObject({ deleted: 0, kept: 0 });
    expect(out.errors).toEqual(["Stopped at the time limit: 2 orphaned file(s) were not checked or deleted this time. Run the purge again to continue."]);
  });

  it("a batch that would overrun is not started: the first batch's deletions stand and are reported", async () => {
    let clock = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    const deadline = clock + 60_000;
    state.listing = Array.from({ length: 501 }, (_, i) => object(k(`orphan-${String(i).padStart(3, "0")}.bin`)));
    state.onDelete = () => { clock += 40_000; }; // batch 1 took 40 s; 40 s more would pass the deadline
    const out = await deleteOrphans(sb, ORG, { deadline });
    expect(state.deleted).toHaveLength(1);
    expect(out).toMatchObject({ deleted: 500, freedBytes: 5000 });
    expect(out.errors).toEqual(["Stopped at the time limit: 1 orphaned file(s) were not checked or deleted this time. Run the purge again to continue."]);
  });

  it("a deadline that passes DURING a batch's re-check deletes nothing in that batch", async () => {
    let clock = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    const deadline = clock + 60_000;
    state.listing = [object(k("a.bin")), object(k("b.bin"))];
    // the plain-column reads run past the deadline: no JSON statement is started after it
    state.onRecheckRead = (kind) => { if (kind === "in") clock += 61_000; };
    const out = await deleteOrphans(sb, ORG, { deadline });
    expect(state.deleted).toEqual([]);
    expect(out.deleted).toBe(0);
    expect(state.reads.filter((r) => r.kind === "or")).toEqual([]);
    expect(out.errors).toEqual(["Stopped at the time limit: 2 orphaned file(s) were not checked or deleted this time. Run the purge again to continue."]);
  });

  it("with no deadline given, the purge budgets itself within the orphans route's maxDuration", async () => {
    const { ORPHAN_PURGE_BUDGET_MS } = await import("@/lib/storageOrphans");
    const route = readFileSync(resolve(__dirname, "../../app/api/admin/orphans/route.ts"), "utf8");
    const maxDuration = Number(/export const maxDuration = (\d+)/.exec(route)?.[1]);
    expect(maxDuration).toBeGreaterThan(0);
    expect(ORPHAN_PURGE_BUDGET_MS).toBeLessThanOrEqual((maxDuration - 30) * 1000);
    expect(route).toMatch(/deleteOrphans\(actor\.admin, orgId\)/);
  });
});

// ── The real client on the wire ──────────────────────────────────────────────
//
// supabase-js builds the requests; a stub fetch answers like PostgREST: a
// `cs` value (plain or inside `or=(…)`) is read as jsonb or refused 22P02,
// `in.(…)` and logic-tree values are unquoted as PostgREST unquotes them,
// keyset pages and exact counts are honoured. No stand-in builder anywhere.

describe("ILIFE-6 c. 3 review fix — the re-check against the real query builder", () => {
  type Db = Record<string, Array<Record<string, unknown>>>;
  function postgrest(db: Db, urls: string[]) {
    const respond = (status: number, body: unknown, headers: Record<string, string> = {}) =>
      new Response(body === null ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      urls.push(url.pathname.replace(/^\/rest\/v1\//, "") + "?" + [...url.searchParams].map(([a, b]) => `${a}=${b}`).join("&"));
      const table = url.pathname.replace(/^\/rest\/v1\//, "");
      let rows = [...(db[table] ?? [])];
      for (const [param, raw] of url.searchParams) {
        if (param === "select" || param === "order" || param === "limit") continue;
        if (param === "or") {
          const terms = orTerms(raw.slice(1, -1)).map((t) => ({ ...t, lit: jsonbLiteral(t.value) }));
          if (terms.some((t) => t.op !== "cs" || !t.lit.ok)) return respond(400, INVALID_JSON);
          rows = rows.filter((r) => terms.some((t) => t.lit.ok && containsJson(r[t.col], t.lit.value)));
          continue;
        }
        const dot = raw.indexOf(".");
        const op = raw.slice(0, dot);
        const value = raw.slice(dot + 1);
        if (op === "cs") {
          const lit = jsonbLiteral(value);
          if (!lit.ok) return respond(400, INVALID_JSON);
          rows = rows.filter((r) => containsJson(r[param], lit.value));
        } else if (op === "in") {
          const vals = splitTop(value.slice(1, -1)).map(unquote);
          rows = rows.filter((r) => vals.includes(String(r[param])));
        } else if (op === "gt") {
          rows = rows.filter((r) => String(r[param]) > value);
        } else {
          return respond(400, { code: "PGRST100", message: `unhandled operator ${op}` });
        }
      }
      if (url.searchParams.get("order")?.startsWith("id.")) rows.sort((a, b) => String(a.id).localeCompare(String(b.id)));
      const total = rows.length;
      const limit = url.searchParams.get("limit");
      if (limit) rows = rows.slice(0, Number(limit));
      const range = { "content-range": total === 0 ? "*/0" : `0-${rows.length - 1}/${total}` };
      if (init?.method === "HEAD") return respond(200, null, range);
      return respond(200, rows, range);
    }) as typeof fetch;
  }
  const client = (db: Db, urls: string[]) =>
    createClient("http://db.test", "service", {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: postgrest(db, urls) },
    });
  const X = k("x.bin");

  it("each JSON column is asked in ONE statement whose `or` terms carry the probe as quoted JSON — the exact URLs", async () => {
    const urls: string[] = [];
    await recheckStillNamed(client({}, urls), [X]);
    const json = urls.filter((u) => u.includes("&or="));
    const q = (s: string) => `"${s.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
    expect(json.sort()).toEqual([
      `collections?select=id&or=(page_config.cs.${q(JSON.stringify({ background: { imagePath: X } }))})&limit=1`,
      `libraries?select=id&or=(page_config.cs.${q(JSON.stringify({ background: { imagePath: X } }))})&limit=1`,
      `org_configurations?select=id&or=(data.cs.${q(JSON.stringify({ logoPath: X }))})&limit=1`,
      `output_templates?select=id&or=(example_files.cs.${q(`[{"key":"${X}"}]`)},example_files.cs.${q(`[{"url":"${X}"}]`)})&limit=1`,
      `tickets?select=id&or=(attachments.cs.${q(`[{"url":"${X}"}]`)})&limit=1`,
    ]);
    // spelled out once, for the record: what the tickets probe looks like on the wire
    expect(json).toContain(`tickets?select=id&or=(attachments.cs."[{\\"url\\":\\"orgs/${ORG}/x.bin\\"}]")&limit=1`);
    expect(urls.join("\n")).not.toContain("[object Object]");
  });

  it("a matching statement is resolved by exact per-key reads — `attachments=cs.[{\"url\":…}]`, `example_files=cs.[{\"key\":…}]`", async () => {
    const urls: string[] = [];
    const db: Db = {
      tickets: [{ id: "t1", attachments: [{ url: X, size: "1 MB" }] }],
      output_templates: [{ id: "o1", example_files: [{ key: k("ex.docx"), name: "ex.docx" }] }],
    };
    const named = await recheckStillNamed(client(db, urls), [X, k("ex.docx"), k("free.bin")]);
    expect([...named].sort()).toEqual([k("ex.docx"), X]);
    expect(urls).toContain(`tickets?select=id&attachments=cs.[{"url":"orgs/${ORG}/x.bin"}]&limit=1`);
    expect(urls).toContain(`output_templates?select=id&example_files=cs.[{"key":"orgs/${ORG}/ex.docx"}]&limit=1`);
    expect(urls.join("\n")).not.toContain("[object Object]");
  });

  it("a key with a comma, a parenthesis and a quote survives the logic-tree quoting", async () => {
    const odd = k('quotes/Pump "A", rev (2).pdf');
    const db: Db = { tickets: [{ id: "t1", attachments: [{ url: odd }] }] };
    const named = await recheckStillNamed(client(db, []), [odd, k("free.bin")]);
    expect([...named]).toEqual([odd]);
  });

  it("no regression, against the real builder: keys nothing names are deleted, a JSON-named one is kept", async () => {
    const urls: string[] = [];
    const db: Db = { tickets: [{ id: "t1", attachments: [{ url: k("att.pdf") }] }] };
    state.listing = [object(k("x.bin")), object(k("y.bin")), object(k("att.pdf")), object("orgs/99999999-9999-4999-8999-999999999999/z.bin")];
    // the scan (keyset pages + counts) runs through the real client too; the
    // ticket row lands only after it, as the balanced write does
    const sbReal = client(db, urls);
    const ticket = db.tickets;
    db.tickets = [];
    const realFrom = sbReal.from.bind(sbReal);
    let scanDone = false;
    (sbReal as unknown as { from: (t: string) => unknown }).from = (t: string) => {
      if (!scanDone && urls.some((u) => u.startsWith("cost_documents?") && u.includes("=in."))) { scanDone = true; db.tickets = ticket; }
      return realFrom(t);
    };
    const out = await deleteOrphans(sbReal as never, ORG);
    expect(out).toMatchObject({ deleted: 2, kept: 1, errors: [] });
    expect(state.deleted.flat().sort()).toEqual([k("x.bin"), k("y.bin")]);
  });

  it("negative control: the old array probe, sent by the real builder, is the `{[object Object]}` PostgREST refuses", async () => {
    const urls: string[] = [];
    const { error } = await client({}, urls).from("tickets").select("id").contains("attachments", [{ url: X }] as unknown as string).limit(1);
    expect(urls[0]).toBe("tickets?select=id&attachments=cs.{[object Object]}&limit=1");
    expect(error).toMatchObject({ code: "22P02" });
  });
});
