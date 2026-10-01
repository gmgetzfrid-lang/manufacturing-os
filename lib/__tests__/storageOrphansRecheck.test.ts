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

import { describe, it, expect, vi, beforeEach } from "vitest";

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
  reads: [] as Array<{ table: string; kind: "page" | "count" | "in" | "contains" }>,
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

function chain(table: string) {
  let cols: string | null = null;
  let head = false;
  let ordered = false;
  let gt: unknown = null;
  let lim: number | null = null;
  let inFilter: { col: string; vals: unknown[] } | null = null;
  let contains: { col: string; val: unknown } | null = null;
  const visible = (scan: boolean) => (state.rows[table] ?? []).filter((r) => !(scan && state.hiddenFromScan.has(`${table}:${String(r.id)}`)));
  const run = () => {
    if (inFilter) {
      state.reads.push({ table, kind: "in" });
      if (state.recheckErrors[table] || (state.failInWith && inFilter.vals.includes(state.failInWith))) {
        return { data: null, error: { message: state.recheckErrors[table] ?? "statement timeout" }, count: null };
      }
      const hit = visible(false).filter((r) => inFilter!.vals.includes(r[inFilter!.col]));
      return { data: hit.map((r) => ({ [cols!]: r[cols!] })), error: null, count: hit.length };
    }
    if (contains) {
      state.reads.push({ table, kind: "contains" });
      if (state.recheckErrors[table]) return { data: null, error: { message: state.recheckErrors[table] } };
      const hit = visible(false).filter((r) => containsJson(r[contains!.col], contains!.val));
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

  it("the re-check runs after the scan and before the delete, one .in() per plain column and a containment read per key per JSON probe", async () => {
    state.listing = [object(k("x.bin"))];
    await deleteOrphans(sb, ORG);
    const firstRecheck = state.reads.findIndex((r) => r.kind === "in");
    expect(firstRecheck).toBeGreaterThan(state.reads.map((r) => r.kind).lastIndexOf("count"));
    const probes = Object.values(JSON_KEY_PROBES).flat().length;
    expect(state.reads.filter((r) => r.kind === "contains")).toHaveLength(probes);
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
