// lib/__tests__/aoRoundGP14RestoreBusinessKeys.test.ts
//
// admin-and-org Round G, package P14 (export / restore remainders).
//
//   intelligence ILIFE-10 criteria 1-2  the restore pre-filters on the real
//                  business unique keys of process_flows, proposed_links and
//                  entity_mentions (RESTORE_BUSINESS_KEYS): a backup row whose
//                  business key a live row of THIS workspace holds is kept
//                  here as it is (counted existing), never refused 23505; on
//                  an is_explicit conflict the live row is kept and the
//                  backup's explicit link is reported as not applied, per
//                  table and key (DEC-90's recorded default); the preview
//                  counts the same rows the write does.
//   intelligence ILIFE-11 criteria 1/3  a knowledge_chunks chunk reports the
//                  libraries whose restored passages had a vector in the
//                  backup and hold none here (meaningIndex), and the run sums
//                  them for the page's "meaning index needs a rebuild" prompt.
//   intelligence ILIFE-15  (measured and fixed by the integrator at the P14
//                  merge) a backup taken before the vector omission carries
//                  the vector inline on every chunk: a 500-row slice was
//                  measured at about 8.5 MB, over the platform's 4.5 MB
//                  request cap; the chunked restore now cuts a slice early
//                  at RESTORE_CHUNK_BYTES, and a slice that fits is exactly
//                  the 500-row slice it always was.
//
// The routes run for real against the in-memory engine (./helpers/
// restoreMemoryDb): a declared second unique key raises 23505, as Postgres's
// unique index does.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { db, type Row } from "./helpers/restoreMemoryDb";

vi.mock("@/lib/serverAuth", async () => {
  const mem = await import("./helpers/restoreMemoryDb");
  return {
    authorizeOrgRole: vi.fn(async (_req: unknown, orgId: string) => ({
      userId: "admin-1", email: "admin@x.io", orgId, role: "Admin", roles: ["Admin"], admin: { from: mem.from },
    })),
  };
});

import { POST as applyTable } from "@/app/api/admin/restore/apply-table/route";
import { POST as beginRoute } from "@/app/api/admin/restore/begin/route";
import {
  RESTORE_BUSINESS_KEYS, EXPLICIT_LINK_NOT_APPLIED, DECISION_NOT_APPLIED, planRestore, runChunkedRestore, previewChunkedRestore,
  businessKeyReadBatches,
  meaningIndexRebuildList, MEANING_INDEX_REBUILD_NOTE,
  RESTORE_CHUNK_ROWS, RESTORE_CHUNK_BYTES, restoreSlices,
  type RestorePost, type RestoreEnvelopeLike,
} from "@/lib/dataRestore";
import { censusSchema } from "./helpers/schemaKeys";

const ORG = "org-1";
const OTHER = "victim-org";
const post = (path: string, body: unknown) =>
  new NextRequest(`https://app${path}?orgId=${ORG}`, {
    method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" }, body: JSON.stringify(body),
  });
async function chunk(table: string, rows: Row[], preview = false) {
  const res = await applyTable(post("/api/admin/restore/apply-table", {
    table, rows, idRemap: { orgId: { "backup-org": ORG }, uid: {} }, manifest: { orgId: "backup-org" }, ...(preview ? { preview: true } : {}),
  }));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}
const rowsOf = (t: string) => db.rows[t] ?? [];
const audits = (action: string) => rowsOf("audit_logs").filter((r) => r.action === action);
const routePost: RestorePost = async (path, body) => {
  const req = new NextRequest(`https://app${path}`, {
    method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const handler = path.startsWith("/api/admin/restore/begin") ? beginRoute : applyTable;
  const res = await handler(req);
  return { ok: res.ok, status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null };
};
const planFor = (envelope: RestoreEnvelopeLike) => planRestore(envelope, { orgId: ORG, orgName: "Acme", members: [] });

beforeEach(() => {
  db.rows = { orgs: [{ id: ORG, name: "Acme" }, { id: OTHER, name: "Victim" }], org_members: [] };
  db.keys = {
    entity_mentions: [["id"], ["asset_id", "knowledge_document_id", "page"]],
    process_flows: [["id"], ["org_id", "from_kind", "from_ref", "to_kind", "to_ref"]],
    proposed_links: [["id"], ["document_id", "target_document_id", "proposer"]],
  };
  db.writeError = null;
  db.readError = {};
  db.writes = [];
  db.attempts = [];
  db.countless = false;
  db.fks = {};
  db.maxRows = 1000;
  db.generated = {};
  db.authUsers = null;
  db.rows.assets = [{ id: "a1", org_id: ORG }, { id: "a2", org_id: ORG }];
  db.rows.knowledge_documents = [{ id: "k1", org_id: ORG }];
  db.rows.documents = [{ id: "d1", org_id: ORG }, { id: "d2", org_id: ORG }];
});

// ── the registry, pinned to the migrations ──────────────────────────────────
describe("ILIFE-10 — RESTORE_BUSINESS_KEYS names each table's real business key", () => {
  const migrations = readdirSync(join(process.cwd(), "supabase/migrations")).filter((f) => f.endsWith(".sql"))
    .map((f) => readFileSync(join(process.cwd(), "supabase/migrations", f), "utf8")).join("\n");
  it("names exactly the three tables criterion 1 names", () => {
    expect(Object.keys(RESTORE_BUSINESS_KEYS).sort()).toEqual(["entity_mentions", "process_flows", "proposed_links"]);
  });
  it("each key is a unique key the migrations declare, and every column it reads is real", () => {
    expect(migrations).toMatch(/UNIQUE \(org_id, from_kind, from_ref, to_kind, to_ref\)/);
    expect(migrations).toMatch(/proposed_links_pair_idx\s+ON proposed_links \(document_id, target_document_id, proposer\)/);
    expect(migrations).toMatch(/entity_mentions_kdoc_page_uniq\s+ON entity_mentions \(asset_id, knowledge_document_id, page\)/);
    expect(migrations).toMatch(/entity_mentions_doc_page_uniq\s+ON entity_mentions \(asset_id, document_id, page\)\s+WHERE knowledge_document_id IS NULL/);
    expect(migrations).toMatch(/entity_mentions_unique_idx\s+ON entity_mentions \(asset_id, COALESCE\(knowledge_document_id, document_id\), page\)/);
    const schema = censusSchema();
    // P14 fix pass: the read is narrowed on every column of the row's key (both shapes of a mention's key)
    const shapes: Row[] = [{ knowledge_document_id: "k" }, { knowledge_document_id: null, document_id: "d" }];
    for (const [table, bk] of Object.entries(RESTORE_BUSINESS_KEYS)) {
      const narrowed = new Set(shapes.flatMap((r) => [...bk.narrowBy(r)]));
      for (const c of ["id", "org_id", ...narrowed, ...bk.columns]) {
        expect(schema.get(table)?.columns.has(c), `${table}.${c}`).toBe(true);
      }
      for (const c of narrowed) expect(bk.columns, `${table} reads back ${c}`).toContain(c);
    }
    expect(RESTORE_BUSINESS_KEYS.process_flows.narrowBy({})).toEqual(["from_kind", "from_ref", "to_kind", "to_ref"]);
    expect(RESTORE_BUSINESS_KEYS.proposed_links.narrowBy({})).toEqual(["document_id", "target_document_id", "proposer"]);
    expect(RESTORE_BUSINESS_KEYS.entity_mentions.narrowBy({ knowledge_document_id: "k" })).toEqual(["asset_id", "knowledge_document_id", "page"]);
    expect(RESTORE_BUSINESS_KEYS.entity_mentions.narrowBy({ knowledge_document_id: null, document_id: "d" })).toEqual(["asset_id", "document_id", "page"]);
  });
  it("a mention's key is its knowledge document when it has one, else its controlled document (20261126's two indexes)", () => {
    const k = RESTORE_BUSINESS_KEYS.entity_mentions.keyOf;
    expect(k({ asset_id: "a", knowledge_document_id: "x", document_id: "d", page: 1 })).toBe(k({ asset_id: "a", knowledge_document_id: "x", document_id: null, page: 1 }));
    expect(k({ asset_id: "a", knowledge_document_id: null, document_id: "x", page: 1 })).not.toBe(k({ asset_id: "a", knowledge_document_id: "x", page: 1 }));
    expect(k({ asset_id: "a", page: 1 })).toBeNull();
  });
});

// ── the write ───────────────────────────────────────────────────────────────
describe("ILIFE-10 criterion 2 — a restore into a workspace that re-indexed mentions keeps every live row and reports what it did not apply", () => {
  it("is_explicit conflict: the live (not explicit) row is kept EXACTLY as it is; the backup's explicit link is reported not applied", async () => {
    db.rows.entity_mentions = [{ id: "m-live", org_id: ORG, asset_id: "a1", knowledge_document_id: "k1", page: 1, is_explicit: false, origin: "tag" }];
    const before = JSON.stringify(rowsOf("entity_mentions"));
    const r = await chunk("entity_mentions", [
      { id: "m-human", org_id: "backup-org", asset_id: "a1", knowledge_document_id: "k1", page: 1, is_explicit: true, origin: "human" },
      { id: "m-new", org_id: "backup-org", asset_id: "a1", knowledge_document_id: "k1", page: 2, is_explicit: true, origin: "human" },
    ]);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, inserted: 1, existing: 1 });
    expect(r.body.refused).toBeUndefined();
    expect(r.body.notApplied).toEqual([
      expect.objectContaining({ id: "m-human", code: EXPLICIT_LINK_NOT_APPLIED, message: expect.stringMatching(/explicit link was not applied.*m-live.*kept as it is/) }),
    ]);
    // the live row is untouched; the backup's explicit row on a NEW key lands with is_explicit
    expect(JSON.stringify(rowsOf("entity_mentions").filter((m) => m.id === "m-live"))).toBe(JSON.stringify(JSON.parse(before)));
    expect(rowsOf("entity_mentions").find((m) => m.id === "m-new")).toMatchObject({ is_explicit: true, org_id: ORG });
    expect(rowsOf("entity_mentions").find((m) => m.id === "m-human")).toBeUndefined();
    expect(audits("RESTORE_CHUNK")[0].details).toMatchObject({
      table: "entity_mentions", inserted: 1, existing: 1,
      notApplied: [expect.objectContaining({ id: "m-human", code: EXPLICIT_LINK_NOT_APPLIED })],
    });
  });

  it("a live explicit row beside a backup row that is not explicit, or both explicit: kept, nothing to report", async () => {
    db.rows.entity_mentions = [
      { id: "m-live-1", org_id: ORG, asset_id: "a1", knowledge_document_id: "k1", page: 1, is_explicit: true },
      { id: "m-live-2", org_id: ORG, asset_id: "a1", knowledge_document_id: "k1", page: 2, is_explicit: true },
    ];
    const r = await chunk("entity_mentions", [
      { id: "m-b1", asset_id: "a1", knowledge_document_id: "k1", page: 1, is_explicit: false },
      { id: "m-b2", asset_id: "a1", knowledge_document_id: "k1", page: 2, is_explicit: true },
    ]);
    expect(r.body).toMatchObject({ ok: true, inserted: 0, existing: 2 });
    expect(r.body.notApplied).toBeUndefined();
    expect(rowsOf("entity_mentions").map((m) => m.is_explicit)).toEqual([true, true]);
  });

  it("a mention with no knowledge document is matched on its controlled document", async () => {
    db.rows.entity_mentions = [{ id: "m-live", org_id: ORG, asset_id: "a1", knowledge_document_id: null, document_id: "d1", page: 3, is_explicit: false }];
    db.keys.entity_mentions = [["id"]]; // the partial index cannot be modelled; the pre-filter must catch it alone
    const r = await chunk("entity_mentions", [{ id: "m-b", asset_id: "a1", knowledge_document_id: null, document_id: "d1", page: 3, is_explicit: true }]);
    expect(r.body).toMatchObject({ ok: true, inserted: 0, existing: 1, notApplied: [expect.objectContaining({ id: "m-b", code: EXPLICIT_LINK_NOT_APPLIED })] });
    expect(rowsOf("entity_mentions")).toHaveLength(1);
  });

  it("a process flow re-drawn by hand since the backup is kept; a confirmed backup flow whose live twin is proposed is reported", async () => {
    db.rows.process_flows = [
      { id: "f-live", org_id: ORG, from_kind: "asset", from_ref: "a1", to_kind: "asset", to_ref: "a2", status: "proposed", origin: "ai" },
    ];
    const r = await chunk("process_flows", [
      { id: "f-old", org_id: "backup-org", from_kind: "asset", from_ref: "a1", to_kind: "asset", to_ref: "a2", status: "confirmed", origin: "manual" },
      { id: "f-new", org_id: "backup-org", from_kind: "asset", from_ref: "a2", to_kind: "asset", to_ref: "a1", status: "confirmed", origin: "manual" },
    ]);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, inserted: 1, existing: 1 });
    expect(r.body.notApplied).toEqual([expect.objectContaining({ id: "f-old", code: DECISION_NOT_APPLIED, message: expect.stringMatching(/"confirmed".*f-live.*"proposed"/) })]);
    expect(rowsOf("process_flows").find((f) => f.id === "f-live")?.status).toBe("proposed");
  });

  it("a proposed link the proposer regenerated since the backup is kept; a pending backup proposal is not reported", async () => {
    db.rows.proposed_links = [{ id: "p-live", org_id: ORG, document_id: "d1", target_document_id: "d2", proposer: "tag", status: "pending" }];
    const r = await chunk("proposed_links", [{ id: "p-old", org_id: "backup-org", document_id: "d1", target_document_id: "d2", proposer: "tag", status: "pending" }]);
    expect(r.body).toMatchObject({ ok: true, inserted: 0, existing: 1 });
    expect(r.body.notApplied).toBeUndefined();
    expect(r.body.refused).toBeUndefined();
  });

  it("only THIS workspace's rows are read: a live row of another workspace under the same key is not 'already here'", async () => {
    db.rows.process_flows = [{ id: "f-theirs", org_id: OTHER, from_kind: "unit", from_ref: "U1", to_kind: "unit", to_ref: "U2", status: "confirmed" }];
    const r = await chunk("process_flows", [{ id: "f-mine", from_kind: "unit", from_ref: "U1", to_kind: "unit", to_ref: "U2", status: "confirmed" }]);
    expect(r.body).toMatchObject({ ok: true, inserted: 1 });
    expect(r.body.existing).toBeUndefined();
  });

  it("the live read pages past a server row cap (keyset by id until an empty page)", async () => {
    db.maxRows = 2;
    db.rows.entity_mentions = Array.from({ length: 5 }, (_, i) => ({ id: `m-live-${i}`, org_id: ORG, asset_id: "a1", knowledge_document_id: "k1", page: i + 1, is_explicit: false }));
    const r = await chunk("entity_mentions", Array.from({ length: 5 }, (_, i) => ({ id: `m-b-${i}`, asset_id: "a1", knowledge_document_id: "k1", page: i + 1, is_explicit: true })));
    expect(r.body).toMatchObject({ ok: true, inserted: 0, existing: 5 });
    expect((r.body.notApplied as unknown[]).length).toBe(5);
  });

  it("an unreadable live read stops the chunk before any write (fail closed)", async () => {
    db.readError.entity_mentions = "permission denied";
    const r = await chunk("entity_mentions", [{ id: "m-b", asset_id: "a1", knowledge_document_id: "k1", page: 1 }]);
    expect(r.status).toBe(500);
    expect(String(r.body.error)).toMatch(/Could not check the entity_mentions rows this workspace already holds under the same key/);
    expect(db.attempts.filter((a) => a.table === "entity_mentions")).toEqual([]);
  });

  it("regression: with no live duplicate the rows land exactly as before, and a re-run of the same backup is all 'existing'", async () => {
    const rows = [
      { id: "m1", asset_id: "a1", knowledge_document_id: "k1", page: 1, is_explicit: true },
      { id: "m2", asset_id: "a2", knowledge_document_id: "k1", page: 1, is_explicit: false },
    ];
    const first = await chunk("entity_mentions", rows);
    expect(first.body).toMatchObject({ ok: true, inserted: 2 });
    expect(first.body.notApplied).toBeUndefined();
    const again = await chunk("entity_mentions", rows);
    expect(again.body).toMatchObject({ ok: true, inserted: 0, existing: 2 });
    expect(again.body.notApplied).toBeUndefined(); // same rows: nothing differs
    expect(rowsOf("entity_mentions").map((m) => m.id)).toEqual(["m1", "m2"]);
  });
});

// ── P14 fix pass (review minor): the live read is narrowed on every key column ─
// It was narrowed by asset_id alone, so each chunk re-read a hub asset's whole
// live mention set (1,000 rows a request), growing as the restore wrote it.
describe("ILIFE-10 (P14 fix pass) — the business-key read narrows on every key column, so a hub asset is not re-read whole for each chunk", () => {
  /** Counts the select statements on `table` (the memory database looks
   *  readError up once for a read that does not fail). */
  const countSelects = (table: string) => {
    const counter = { n: 0 };
    db.readError = new Proxy({} as Record<string, string>, { get: (_t, k) => { if (k === table) counter.n++; return undefined; } });
    return counter;
  };

  it("a hub asset with 2,000 live mentions: each 100-row chunk reads a couple of statements, flat as the restore grows (was: the whole set, 20+ pages under a 100-row cap, every chunk)", async () => {
    db.maxRows = 100; // a server row cap below the page size
    const kdocs = Array.from({ length: 200 }, (_, i) => `k-${String(i).padStart(4, "0")}`);
    const fresh = Array.from({ length: 300 }, (_, i) => `kb-${String(i).padStart(4, "0")}`);
    db.rows.assets.push({ id: "hub", org_id: ORG });
    db.rows.knowledge_documents = [...kdocs, ...fresh].map((id) => ({ id, org_id: ORG }));
    db.rows.entity_mentions = kdocs.flatMap((k, i) => Array.from({ length: 10 }, (_, p) => ({
      id: `m-live-${String(i * 10 + p).padStart(5, "0")}`, org_id: ORG, asset_id: "hub", knowledge_document_id: k, page: p + 1, is_explicit: false,
    })));
    expect(rowsOf("entity_mentions")).toHaveLength(2000);
    const perChunk: number[] = [];
    for (let c = 0; c < 3; c++) {
      // 95 new mentions of the hub on knowledge documents restored since; 5 the workspace already holds (re-indexed)
      const rows: Row[] = [
        ...Array.from({ length: 95 }, (_, j) => ({ id: `m-b-${c}-${j}`, asset_id: "hub", knowledge_document_id: fresh[c * 95 + j], page: 1 + (j % 4), is_explicit: false })),
        ...Array.from({ length: 5 }, (_, j) => ({ id: `m-re-${c}-${j}`, asset_id: "hub", knowledge_document_id: kdocs[c * 5 + j], page: 2, is_explicit: true })),
      ];
      const selects = countSelects("entity_mentions");
      const r = await chunk("entity_mentions", rows);
      db.readError = {};
      expect(r.status, `chunk ${c}`).toBe(200);
      expect(r.body, `chunk ${c}`).toMatchObject({ ok: true, inserted: 95, existing: 5 });
      expect((r.body.notApplied as unknown[]).length, `chunk ${c}`).toBe(5);
      perChunk.push(selects.n);
    }
    // one batch: a page and the empty page that ends it (narrowed by asset_id alone it was 21, 22, 23 — the hub's whole set, growing)
    expect(perChunk).toEqual([2, 2, 2]);
    expect(rowsOf("entity_mentions")).toHaveLength(2000 + 3 * 95);
  });

  it("the batches keep every row's values and fit the URL budget; a row past the budget or the row cap starts a new batch", () => {
    const rows: Row[] = Array.from({ length: 250 }, (_, i) => ({ a: `asset-${i % 7}`, k: `${"x".repeat(40)}-${i}`, p: i % 9 }));
    const cols = ["a", "k", "p"];
    const batches = businessKeyReadBatches(rows, cols, 1500, 100);
    expect(batches.length).toBeGreaterThan(2);
    for (const b of batches) {
      const size = b.reduce<number>((sum, values) => sum + values.reduce<number>((s2, v) => s2 + encodeURIComponent(String(v)).length + 3, 0), 0);
      expect(size).toBeLessThanOrEqual(1500);
    }
    for (const r of rows) {
      expect(batches.some((b) => cols.every((c, i) => b[i].includes(r[c] as string | number))), JSON.stringify(r)).toBe(true);
    }
    // the row cap alone: short values, 250 rows → three batches of at most 100
    const small = businessKeyReadBatches(rows.map((r, i) => ({ a: "h", k: i, p: 1 })), cols, 1e9, 100);
    expect(small.map((b) => b[1].length)).toEqual([100, 100, 50]);
    expect(businessKeyReadBatches([], cols)).toEqual([]);
  });
});

describe("ILIFE-10 — before and after agree: the preview counts a business-key row as existing; the run sums what was not applied", () => {
  it("preview, run totals, per-table outcome", async () => {
    db.rows.entity_mentions = [{ id: "m-live", org_id: ORG, asset_id: "a1", knowledge_document_id: "k1", page: 1, is_explicit: false }];
    const env: RestoreEnvelopeLike = {
      manifest: { orgId: "backup-org" },
      tables: {
        entity_mentions: [
          { id: "m-human", org_id: "backup-org", asset_id: "a1", knowledge_document_id: "k1", page: 1, is_explicit: true },
          { id: "m-new", org_id: "backup-org", asset_id: "a1", knowledge_document_id: "k1", page: 9, is_explicit: false },
        ],
      },
    };
    const check = await previewChunkedRestore({ orgId: ORG, envelope: env, plan: planFor(env), post: routePost });
    expect(check.tables.entity_mentions).toEqual({ rows: 2, existing: 1, heldElsewhere: 0, wouldInsert: 1 });
    const result = await runChunkedRestore({ orgId: ORG, envelope: env, plan: planFor(env), orgNameChoice: "current", post: routePost });
    expect(result).toMatchObject({ totalInserted: 1, totalExisting: 1, totalRefused: 0, totalNotApplied: 1, stoppedAt: null });
    expect(result.tables[0].notApplied).toEqual([expect.objectContaining({ id: "m-human", code: EXPLICIT_LINK_NOT_APPLIED })]);
  });
});

// ── ILIFE-11: which restored libraries need a meaning-index Build ───────────
describe("ILIFE-11 criteria 1/3 — the restore names each restored library whose passages had vectors", () => {
  beforeEach(() => {
    db.rows.knowledge_libraries = [{ id: "lib-a", org_id: ORG, name: "Standards" }, { id: "lib-b", org_id: ORG, name: "P&IDs" }];
    db.rows.knowledge_documents = [{ id: "kd1", org_id: ORG }, { id: "kd2", org_id: ORG }];
  });
  const chunkRow = (id: string, lib: string, extra: Row = {}) => ({ id, org_id: "backup-org", library_id: lib, document_id: lib === "lib-a" ? "kd1" : "kd2", seq: 0, content: "text", ...extra });

  it("chunks exported without their vector (embedding_model set) are counted per library; a never-embedded chunk and an old backup's chunk that carries its vector are not", async () => {
    const r = await chunk("knowledge_chunks", [
      chunkRow("c1", "lib-a", { embedding_model: "provider-model-x" }),
      chunkRow("c2", "lib-a", { embedding_model: "provider-model-x" }),
      chunkRow("c3", "lib-b", { embedding_model: "provider-model-x" }),
      chunkRow("c4", "lib-b", { embedding_model: null }),                                 // never embedded
      chunkRow("c5", "lib-b", { embedding_model: "provider-model-x", embedding: "[0.1,0.2]" }), // a pre-change backup: the vector comes back
    ]);
    expect(r.status).toBe(200);
    expect(r.body.meaningIndex).toEqual({ "lib-a": 2, "lib-b": 1 });
    expect(audits("RESTORE_CHUNK")[0].details).toMatchObject({ meaningIndex: { "lib-a": 2, "lib-b": 1 } });
  });

  it("a chunk already here with its vector is not counted (a same-workspace repair restore)", async () => {
    db.rows.knowledge_chunks = [{ id: "c1", org_id: ORG, library_id: "lib-a", document_id: "kd1", embedding_model: "m", embedding: "[1]" }];
    const r = await chunk("knowledge_chunks", [chunkRow("c1", "lib-a", { embedding_model: "m" })]);
    expect(r.body).toMatchObject({ ok: true, inserted: 0, existing: 1 });
    expect(r.body.meaningIndex).toBeUndefined();
  });

  it("an unreadable check is said, and the chunk still lands (informational, never a failed restore)", async () => {
    let writes = 0;
    db.writeError = (table, op) => { if (table === "knowledge_chunks" && op === "upsert") writes++; return null; };
    // fail only the read AFTER the write
    const orig = db.readError;
    db.readError = new Proxy(orig, { get: (t, k) => (k === "knowledge_chunks" && writes > 0 ? "statement timeout" : (t as Record<string, string>)[k as string]) });
    const r = await chunk("knowledge_chunks", [chunkRow("c1", "lib-a", { embedding_model: "m" })]);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, inserted: 1, meaningIndexUnchecked: "statement timeout" });
    expect(rowsOf("knowledge_chunks").map((c) => c.id)).toEqual(["c1"]);
  });

  it("the run sums them; the page lists each library by its backup name, most passages first, with the Build-on-your-own-key note", async () => {
    const env: RestoreEnvelopeLike = {
      manifest: { orgId: "backup-org" },
      tables: {
        knowledge_chunks: [
          chunkRow("c1", "lib-a", { embedding_model: "m" }), chunkRow("c2", "lib-b", { embedding_model: "m" }), chunkRow("c3", "lib-b", { embedding_model: "m" }),
        ],
      },
    };
    const result = await runChunkedRestore({ orgId: ORG, envelope: env, plan: planFor(env), orgNameChoice: "current", post: routePost });
    expect(result.meaningIndexRebuild).toEqual({ "lib-a": 1, "lib-b": 2 });
    expect(result.meaningIndexUnchecked).toEqual([]);
    const named = { tables: { knowledge_libraries: [{ id: "lib-a", name: "Standards" }, { id: "lib-b", name: "P&IDs" }] } };
    expect(meaningIndexRebuildList(result, named)).toEqual([
      { libraryId: "lib-b", name: "P&IDs", passages: 2 },
      { libraryId: "lib-a", name: "Standards", passages: 1 },
    ]);
    expect(meaningIndexRebuildList(result, null)[0].name).toBe("lib-b"); // unnamed: the id
    expect(MEANING_INDEX_REBUILD_NOTE).toMatch(/own embedding key/);
    expect(MEANING_INDEX_REBUILD_NOTE).toMatch(/Nothing re-embeds them automatically/);
  });

  it("a restore with no knowledge chunks reports no rebuild (regression: the result's new fields are empty)", async () => {
    const env: RestoreEnvelopeLike = { manifest: { orgId: "backup-org" }, tables: { notes: [{ id: "n1", org_id: "backup-org" }] } };
    const result = await runChunkedRestore({ orgId: ORG, envelope: env, plan: planFor(env), orgNameChoice: "current", post: routePost });
    expect(result).toMatchObject({ totalInserted: 1, totalNotApplied: 0, meaningIndexRebuild: {}, meaningIndexUnchecked: [] });
  });
});

// ── ILIFE-15: a pre-omission backup's inline vectors, measured ──────────────
describe("ILIFE-15 — a backup taken before the vector omission restores within the request budget (measured)", () => {
  /** The hosting platform's request-body cap, at its lower reading (4.5 MB). */
  const PLATFORM_BODY_CAP = 4_500_000;
  const utf8 = new TextEncoder();
  const bytesOf = (body: unknown) => utf8.encode(JSON.stringify(body)).byteLength;
  // deterministic synthetic data, realistic sizes: ~1,400-1,560-character passages (lib/knowledgeText.ts
  // chunkPageText's target and overlap), their tsvector, and the vector as PostgREST writes it
  let seed = 7; // mulberry32
  const rnd = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  let serial = 0;
  const gauss = () => { let x = 0; for (let i = 0; i < 6; i++) x += rnd(); return (x - 3) / Math.sqrt(0.5); };
  const hex = (n: number) => Array.from({ length: n }, () => Math.floor(rnd() * 16).toString(16)).join("");
  const uuid = () => `${(serial++).toString(16).padStart(8, "0")}-${hex(4)}-4${hex(3)}-8${hex(3)}-${hex(12)}`;
  const WORDS = "pump suction drum valve pressure relief flange gasket bolt torque inspection weld procedure hydrotest nozzle vessel shell tray column reboiler condenser exchanger tube bundle baffle impeller casing seal bearing vibration alarm interlock setpoint transmitter isolation blind drain vent manifold header isometric support hanger insulation coating corrosion allowance thickness carbon stainless alloy schedule rating".split(" ");
  const passage = () => { let t = ""; while (t.length < 1560) t += `${WORDS[Math.floor(rnd() * WORDS.length)]}${rnd() < 0.1 ? ". " : " "}`; return t.slice(0, 1400 + Math.floor(rnd() * 160)); };
  const tsv = (t: string) => {
    const at = new Map<string, number[]>();
    t.toLowerCase().split(/[^a-z]+/).filter(Boolean).forEach((w, i) => at.set(w, [...(at.get(w) ?? []), i + 1]));
    return [...at].map(([w, p]) => `'${w}':${p.join(",")}`).join(" ");
  };
  // pgvector's text form: float4 values, at most 9 significant digits each
  const vectorText = (dims: number) => `[${Array.from({ length: dims }, () => String(Number(Math.fround(gauss() / Math.sqrt(dims)).toPrecision(9)))).join(",")}]`;
  const vectorJson = (dims: number) => Array.from({ length: dims }, () => gauss() / Math.sqrt(dims));
  const BACKUP_ORG = "backup-org";
  const backupChunks = (n: number, vector: (() => unknown) | null, lib = "lib-old", doc = "kd-old"): Row[] => Array.from({ length: n }, (_, i) => {
    const content = passage();
    return {
      id: uuid(), org_id: BACKUP_ORG, library_id: lib, document_id: doc, page: 1 + (i % 40), seq: i % 7, section: "4.2 Suction drum",
      content, tsv: tsv(content), embedding: vector ? vector() : null, embedding_model: vector ? "provider-model-x" : null,
      embed_attempts: 1, embed_error: null, embed_claimed_until: null, embed_retry_after: null, source: "text", source_model: null,
    };
  });
  // a workspace's member map, as /begin answers it (60 people)
  const idRemap = { orgId: { [BACKUP_ORG]: ORG }, uid: Object.fromEntries(Array.from({ length: 60 }, () => [uuid(), uuid()])) };
  const envelopeOf = (tables: Record<string, Row[]>): RestoreEnvelopeLike => ({ manifest: { orgId: BACKUP_ORG, orgName: "Acme Refining" }, tables });
  const recording = () => {
    const sent: Array<{ preview: boolean; table: string; rows: Row[]; bytes: number }> = [];
    const post: RestorePost = async (path, body) => {
      if (path.startsWith("/api/admin/restore/begin")) return { ok: true, status: 200, body: { idRemap } };
      const b = body as { table: string; rows: Row[]; preview?: boolean };
      sent.push({ preview: b.preview === true, table: b.table, rows: b.rows, bytes: bytesOf(body) });
      return { ok: true, status: 200, body: b.preview ? { rows: b.rows.length, wouldInsert: b.rows.length } : { ok: true, inserted: b.rows.length } };
    };
    return { sent, post };
  };
  /** What the 500-rows-per-request path (before ILIFE-15) sent: the heaviest slice. */
  const oldHeaviestSlice = (table: string, rows: Row[]) => {
    let max = 0;
    for (let i = 0; i < rows.length; i += RESTORE_CHUNK_ROWS) max = Math.max(max, bytesOf({ table, rows: rows.slice(i, i + RESTORE_CHUNK_ROWS), idRemap, manifest: { orgId: BACKUP_ORG, orgName: "Acme Refining" } }));
    return max;
  };

  it("measured: 3,000 chunks carrying the 1,024-number vector (the schema's vector(1024), as PostgREST writes it) — a 500-row slice was about 8.5 MB, nearly twice the 4.5 MB cap; now every request is within RESTORE_CHUNK_BYTES and every row is sent once, in order", async () => {
    const rows = backupChunks(3000, () => vectorText(1024));
    const perRow = rows.reduce((n, r) => n + bytesOf(r), 0) / rows.length;
    expect(perRow).toBeGreaterThan(16_000); // ≈17 KB a row, the vector ≈13 KB of it
    expect(perRow).toBeLessThan(18_500);
    const before = oldHeaviestSlice("knowledge_chunks", rows);
    expect(before).toBeGreaterThan(8_000_000); // ≈8.5 MB
    expect(before).toBeLessThan(9_000_000);
    expect(before).toBeGreaterThan(PLATFORM_BODY_CAP); // the platform refused it before the route ran: the restore stopped here
    const { sent, post } = recording();
    const env = envelopeOf({ knowledge_chunks: rows });
    const result = await runChunkedRestore({ orgId: ORG, envelope: env, plan: planFor(env), orgNameChoice: "current", post });
    const applied = sent.filter((x) => !x.preview);
    expect(Math.max(...applied.map((x) => x.bytes))).toBeLessThanOrEqual(RESTORE_CHUNK_BYTES);
    expect(RESTORE_CHUNK_BYTES).toBeLessThan(PLATFORM_BODY_CAP);
    expect(applied.length).toBeGreaterThanOrEqual(13); // ≈234 rows a request
    expect(applied.flatMap((x) => x.rows.map((r) => r.id))).toEqual(rows.map((r) => r.id));
    expect(applied.every((x) => x.rows.every((r) => typeof r.embedding === "string"))).toBe(true); // the vector still goes back, as before
    expect(result).toMatchObject({ totalInserted: 3000, stoppedAt: null, notAttempted: [] });
  }, 60_000);

  it("measured: 1,536-number vectors, as text and as JSON float arrays (about 12.1 and 17.9 MB a 500-row slice) — every request fits", async () => {
    for (const vector of [() => vectorText(1536), () => vectorJson(1536)]) {
      const rows = backupChunks(1000, vector);
      expect(oldHeaviestSlice("knowledge_chunks", rows)).toBeGreaterThan(11_000_000);
      const { sent, post } = recording();
      const env = envelopeOf({ knowledge_chunks: rows });
      const result = await runChunkedRestore({ orgId: ORG, envelope: env, plan: planFor(env), orgNameChoice: "current", post });
      expect(Math.max(...sent.map((x) => x.bytes))).toBeLessThanOrEqual(RESTORE_CHUNK_BYTES);
      expect(result).toMatchObject({ totalInserted: 1000, stoppedAt: null });
    }
  }, 60_000);

  it("regression: a backup taken since the omission (no vector, ≈3 KB a chunk, ≈1.5 MB a 500-row slice) sends exactly the 500-row slices it always did — the check and the apply", async () => {
    const rows = backupChunks(1200, null);
    expect(oldHeaviestSlice("knowledge_chunks", rows)).toBeLessThan(2_000_000);
    const notes = Array.from({ length: 501 }, (_, i) => ({ id: `n-${i}`, org_id: BACKUP_ORG, body: "a note" }));
    const { sent, post } = recording();
    const env = envelopeOf({ knowledge_chunks: rows, notes });
    const plan = planFor(env);
    await previewChunkedRestore({ orgId: ORG, envelope: env, plan, post });
    await runChunkedRestore({ orgId: ORG, envelope: env, plan, orgNameChoice: "current", post });
    const sizes = (preview: boolean, table: string) => sent.filter((x) => x.preview === preview && x.table === table).map((x) => x.rows.length);
    for (const preview of [true, false]) {
      expect(sizes(preview, "knowledge_chunks")).toEqual([500, 500, 200]);
      expect(sizes(preview, "notes")).toEqual([500, 1]);
    }
    // the slices are the very slices rows.slice(i, i + 500) gave
    expect(sent.filter((x) => !x.preview && x.table === "knowledge_chunks").map((x) => x.rows)).toEqual([rows.slice(0, 500), rows.slice(500, 1000), rows.slice(1000)]);
  }, 60_000);

  it("restoreSlices: cut at the row cap or before the byte budget, measured exactly; a row past the budget alone is sent alone", () => {
    const body = (slice: Row[]) => ({ table: "t", rows: slice });
    const rows = [{ v: "a".repeat(40) }, { v: "é".repeat(20) }, { v: "b".repeat(200) }, { v: "c".repeat(10) }, { v: "d".repeat(10) }];
    const slices = restoreSlices(rows, body, 3, 120);
    expect(slices).toEqual([[rows[0], rows[1]], [rows[2]], [rows[3], rows[4]]]);
    for (const s of slices.filter((x) => x !== slices[1])) expect(bytesOf(body(s))).toBeLessThanOrEqual(120); // "é" counted as 2 bytes
    expect(bytesOf(body([rows[0], rows[1]]))).toBe(bytesOf(body([])) + bytesOf(rows[0]) + 1 + bytesOf(rows[1]));
    expect(restoreSlices(rows, body, 2, 10_000).map((s) => s.length)).toEqual([2, 2, 1]);
    expect(restoreSlices([], body)).toEqual([]);
  });

  it("through the real route: an old backup's 700 chunks land in byte-sized slices with their vectors, every count summed, every slice audited", async () => {
    db.rows.knowledge_libraries = [{ id: "lib-old", org_id: ORG, name: "Standards" }];
    db.rows.knowledge_documents = [{ id: "kd-old", org_id: ORG }];
    const rows = backupChunks(700, () => vectorText(1024));
    const env = envelopeOf({ knowledge_chunks: rows });
    const bodies: number[] = [];
    const measured: RestorePost = async (path, body) => { if (path.startsWith("/api/admin/restore/apply-table")) bodies.push(bytesOf(body)); return routePost(path, body); };
    const result = await runChunkedRestore({ orgId: ORG, envelope: env, plan: planFor(env), orgNameChoice: "current", post: measured });
    expect(result).toMatchObject({ totalInserted: 700, totalRefused: 0, stoppedAt: null });
    expect(bodies.length).toBe(audits("RESTORE_CHUNK").length);
    expect(bodies.length).toBeGreaterThanOrEqual(3);
    expect(Math.max(...bodies)).toBeLessThanOrEqual(RESTORE_CHUNK_BYTES);
    expect(rowsOf("knowledge_chunks")).toHaveLength(700);
    expect(rowsOf("knowledge_chunks").every((c) => c.org_id === ORG && typeof c.embedding === "string")).toBe(true);
    expect(result.meaningIndexRebuild).toEqual({}); // they carried their vectors back: nothing to rebuild
  }, 60_000);
});
