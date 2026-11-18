// projects-joint J15b CHECKED-WRITE SWEEP (SAF-18) — the knowledge engine's
// update / delete sites, through the real code and the in-memory database
// (./knowledgeFakeDb). Each converted site: a zero-row match is reported
// (or, for a class (c) site, stays a no-op success), a database error keeps
// the database's own sentence, and the success path writes what it wrote.
//
//   ING-14   the source sync: a stale-mirror drop or a REMOVE delete that
//            fails leaves the library never-synced (last_synced_at null), so
//            the next run reaches it first; one that lands, or matches
//            nothing, stamps as before — and a mirror is counted removed
//            only when its row went.
//   reindex  a library update that matched nothing (the library was
//            deleted) is refused before any document is reset.
//   GOV-13   settleUsage answers false for a reservation row that is gone,
//            so a folded reservation stands (over-counted, never under).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { db, resetDb, rowsOf, type Row, type Op } from "./knowledgeFakeDb";

vi.mock("@/lib/supabaseAdmin", async () => ({ supabaseAdmin: (await import("./knowledgeFakeDb")).fakeAdmin }));
vi.mock("@/lib/r2", () => ({ R2_BUCKET: "bucket", r2: { send: async () => { throw new Error("NoSuchKey"); } } }));
vi.mock("@/lib/knowledgeVision", () => ({ transcribePageImage: vi.fn() }));
vi.mock("@/lib/equipmentBridgeServer", () => ({ computeForKnowledgeDoc: vi.fn(async () => undefined) }));
vi.mock("@/lib/ai/usageServer", async () => ({
  ...(await import("./helpers/fakeUsageMeter")).fakeUsageServer(),
  getMonthUsage: vi.fn(), getCapUsd: vi.fn(), recordAskUsage: vi.fn(),
}));
vi.mock("@/lib/aiInstructionsServer", () => ({ loadOrgInstructionsBlock: vi.fn(async () => "") }));
vi.mock("@/lib/ai/keyVault", () => ({ openAiKey: (k: string) => k }));

import { syncKnowledgeLibrarySources } from "@/lib/knowledgeSourceSync";
import {
  reindexLibraryChunks, resetKnowledgeIndex, claimIngestLease, releaseIngestLease, markIngestFailed,
} from "@/lib/knowledgeIngest";
import { indexDocumentMentions } from "@/lib/mentionIndexer";

const TIMEOUT = { code: "57014", message: "canceling statement due to statement timeout" };
const fail = (table: string, kind: Op["kind"], when: (op: Op, f: Array<{ col: string; value: unknown }>) => boolean = () => true, err = TIMEOUT) =>
  db.hooks.push((op, filters) => (op.table === table && op.kind === kind && when(op, filters) ? { error: err } : undefined));
/** A second writer that removes the row just before the statement runs —
 *  the statement then matches nothing. */
const vanishFirst = (table: string, kind: Op["kind"], id: string) =>
  db.hooks.push((op, filters) => {
    if (op.table === table && op.kind === kind && filters.some((f) => f.col === "id" && f.value === id)) {
      db.tables[table] = (db.tables[table] ?? []).filter((r) => r.id !== id);
    }
  });

beforeEach(() => { vi.spyOn(console, "error").mockImplementation(() => undefined); });
afterEach(() => { vi.restoreAllMocks(); });

// ── ING-14 — the source sync ─────────────────────────────────────────────
const MIRROR = "kd-1";
const syncWorld = (over: { version?: Row; archived?: boolean } = {}): Record<string, Row[]> => ({
  knowledge_sources: [{ id: "src-1", org_id: "o1", library_id: "kl-1", source_type: "library", source_id: "lib-dc", source_name: "Piping", last_synced_at: "2026-11-01T00:00:00.000Z" }],
  libraries: [{ id: "lib-dc", org_id: "o1", name: "Piping", acl: null, visibility: null, owner_user_id: null, owner_team_id: null }],
  collections: [], teams: [],
  documents: [{
    id: "dc-1", org_id: "o1", library_id: "lib-dc", collection_id: null, name: "025-PID-0101", title: "Crude P&ID",
    document_number: "025-PID-0101", status: "Released", archived_at: over.archived ? "2026-11-10T00:00:00.000Z" : null,
    current_version_id: "ver-3", ai_excluded: false,
  }],
  document_versions: [over.version ?? { id: "ver-3", file_url: "orgs/o1/dc/rev3.pdf", file_type: "application/pdf", revision_label: "3", size: 10 }],
  knowledge_documents: [{
    id: MIRROR, org_id: "o1", library_id: "kl-1", name: "025-PID-0101 — Crude P&ID", file_key: "orgs/o1/dc/rev3.pdf",
    status: "ready", pages_indexed: 1, page_count: 1, source_id: "src-1", source_document_id: "dc-1", source_version_id: "ver-3", source_rev: "3",
    ingest_claimed_by: null, ingest_claimed_at: null,
  }],
  knowledge_chunks: [], knowledge_page_entities: [], entity_mentions: [], knowledge_line_traces: [],
});
/** The current revision is a native CAD file: the PDF mirror is stale. */
const CAD = { id: "ver-3", file_url: "orgs/o1/dc/rev3.dwg", file_type: "application/acad", revision_label: "3", size: 10 };
const stamp = () => rowsOf("knowledge_sources")[0].last_synced_at;
const mirrorThere = () => rowsOf("knowledge_documents").some((r) => r.id === MIRROR);

describe("ING-14 — a stale-mirror drop (SAF-18 class (c))", () => {
  it("lands: the mirror is gone, counted once, and the library is stamped as synced", async () => {
    resetDb(syncWorld({ version: CAD }));
    const out = await syncKnowledgeLibrarySources("kl-1");
    expect(out).toMatchObject({ removed: 1, errors: [] });
    expect(mirrorThere()).toBe(false);
    expect(typeof stamp()).toBe("string");
    expect(stamp()).not.toBe("2026-11-01T00:00:00.000Z");
  });
  it("is refused by the database: the row is still there, the error is said in the database's words, nothing is counted removed, and last_synced_at is null (the next run comes here first)", async () => {
    resetDb(syncWorld({ version: CAD }));
    fail("knowledge_documents", "delete");
    const out = await syncKnowledgeLibrarySources("kl-1");
    expect(mirrorThere()).toBe(true);
    expect(out.removed).toBe(0);
    expect(out.errors).toEqual([`stale mirror 025-PID-0101 — Crude P&ID: ${TIMEOUT.message}`]);
    expect(stamp()).toBeNull();
  });
  it("matches nothing (another pass removed it first): no failure, nothing counted removed, stamped as before", async () => {
    resetDb(syncWorld({ version: CAD }));
    vanishFirst("knowledge_documents", "delete", MIRROR);
    const out = await syncKnowledgeLibrarySources("kl-1");
    expect(out).toMatchObject({ removed: 0, errors: [] });
    expect(typeof stamp()).toBe("string");
  });
});

describe("ING-14 — the REMOVE delete (a controlled document that left the sources)", () => {
  it("lands: removed once, stamped", async () => {
    resetDb(syncWorld({ archived: true }));
    const out = await syncKnowledgeLibrarySources("kl-1");
    expect(out).toMatchObject({ removed: 1, errors: [] });
    expect(mirrorThere()).toBe(false);
    expect(typeof stamp()).toBe("string");
  });
  it("is refused by the database: the row stays, `remove: <the database's sentence>`, not counted, and last_synced_at is null", async () => {
    resetDb(syncWorld({ archived: true }));
    fail("knowledge_documents", "delete");
    const out = await syncKnowledgeLibrarySources("kl-1");
    expect(mirrorThere()).toBe(true);
    expect(out.removed).toBe(0);
    expect(out.errors).toEqual([`remove: ${TIMEOUT.message}`]);
    expect(stamp()).toBeNull();
  });
  it("matches nothing: not counted removed, no failure, stamped", async () => {
    resetDb(syncWorld({ archived: true }));
    vanishFirst("knowledge_documents", "delete", MIRROR);
    const out = await syncKnowledgeLibrarySources("kl-1");
    expect(out).toMatchObject({ removed: 0, errors: [] });
    expect(typeof stamp()).toBe("string");
  });
});

describe("the sync's bookkeeping writes (SAF-18 classes (b) and (c))", () => {
  it("a display-name refresh that does not land is logged and never blocks the reconcile", async () => {
    const world = syncWorld({ archived: true });
    world.knowledge_sources[0].source_name = "Old name";
    resetDb(world);
    fail("knowledge_sources", "update", (op) => (op.payload as Row).source_name !== undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const out = await syncKnowledgeLibrarySources("kl-1");
    expect(out).toMatchObject({ removed: 1, errors: [] });
    expect(warn).toHaveBeenCalledWith("[knowledgeSourceSync] a source's display name could not be refreshed (non-blocking)", expect.objectContaining({ sourceId: "src-1" }));
  });
  it("the rotation stamp: an error is said in the database's words; a database without the column (pre-20261122) says nothing", async () => {
    resetDb(syncWorld());
    fail("knowledge_sources", "update", (op) => "last_synced_at" in (op.payload as Row));
    expect((await syncKnowledgeLibrarySources("kl-1")).errors).toEqual([`last synced: ${TIMEOUT.message}`]);
    resetDb(syncWorld());
    db.missingColumns.knowledge_sources = ["last_synced_at"];
    expect((await syncKnowledgeLibrarySources("kl-1")).errors).toEqual([]);
  });
});

// ── The re-index's library choice (a controller's decision) ─────────────
const libWorld = (): Record<string, Row[]> => ({
  knowledge_libraries: [{ id: "kl-1", org_id: "o1", name: "Specs", chunk_version: 1 }],
  knowledge_documents: [{
    id: "kd-1", org_id: "o1", library_id: "kl-1", name: "spec.pdf", file_key: "orgs/o1/spec.pdf", status: "ready",
    pages_indexed: 3, page_count: 3, vision_pages: 0, chunk_version: 1, ingest_claimed_by: null, ingest_claimed_at: null,
  }],
  knowledge_chunks: [1, 2, 3].map((p) => ({ id: `c${p}`, document_id: "kd-1", org_id: "o1", library_id: "kl-1", page: p, seq: 0, content: `page ${p}` })),
  knowledge_page_entities: [], entity_mentions: [], knowledge_line_traces: [],
});

describe("reindexLibraryChunks — a library update that matched nothing resets nothing", () => {
  it("the library was deleted after its documents were read: refused, naming the library; every document and chunk stands", async () => {
    resetDb(libWorld());
    db.hooks.push((op) => { if (op.table === "knowledge_libraries" && op.kind === "update") db.tables.knowledge_libraries = []; });
    await expect(reindexLibraryChunks("kl-1", 2)).rejects.toThrow("library: knowledge library kl-1 no longer exists (it was deleted), so its chunker was not recorded and nothing was reset.");
    expect(rowsOf("knowledge_documents")[0]).toMatchObject({ status: "ready", pages_indexed: 3 });
    expect(rowsOf("knowledge_chunks")).toHaveLength(3);
  });
  it("success is unchanged: the choice is recorded, then the document is reset", async () => {
    resetDb(libWorld());
    const out = await reindexLibraryChunks("kl-1", 2);
    expect(out).toMatchObject({ reset: ["kd-1"], errors: [], remaining: 0 });
    expect(rowsOf("knowledge_libraries")[0].chunk_version).toBe(2);
    expect(rowsOf("knowledge_documents")[0]).toMatchObject({ status: "stale", pages_indexed: 0 });
    expect(rowsOf("knowledge_chunks")).toHaveLength(0);
  });
  it("a database error keeps its words, and a database without the column still names the migration", async () => {
    resetDb(libWorld());
    fail("knowledge_libraries", "update");
    await expect(reindexLibraryChunks("kl-1", 2)).rejects.toThrow(`library: ${TIMEOUT.message}`);
    resetDb(libWorld());
    db.hooks.push((op) => (op.table === "knowledge_libraries" && op.kind === "update"
      ? { error: { code: "PGRST204", message: "Could not find the 'chunk_version' column of 'knowledge_libraries' in the schema cache" } } : undefined));
    await expect(reindexLibraryChunks("kl-1", 2)).rejects.toThrow(/needs migration 20261122/);
  });
});

// ── The claim, its release and the failure write ─────────────────────────
describe("the ingest claim and its release", () => {
  it("claim: a held claim reads busy, a gone row reads gone, a database error keeps its words, a pre-20261122 database reads unlocked", async () => {
    resetDb(libWorld());
    expect((await claimIngestLease("kd-1", "a")).kind).toBe("claimed");
    expect((await claimIngestLease("kd-1", "b")).kind).toBe("busy");
    expect((await claimIngestLease("kd-none", "b")).kind).toBe("gone");
    resetDb(libWorld());
    fail("knowledge_documents", "update");
    await expect(claimIngestLease("kd-1", "a")).rejects.toThrow(`ingest claim failed: ${TIMEOUT.message}`);
    resetDb(libWorld());
    db.missingColumns.knowledge_documents = ["ingest_claimed_by", "ingest_claimed_at"];
    expect((await claimIngestLease("kd-1", "a")).kind).toBe("unlocked");
  });
  it("release (class (c)): a claim no longer ours matches nothing — true, as before; a database error answers false", async () => {
    resetDb(libWorld());
    await claimIngestLease("kd-1", "a");
    expect(await releaseIngestLease("kd-1", "someone-else")).toBe(true);
    expect(rowsOf("knowledge_documents")[0].ingest_claimed_by).toBe("a");
    expect(await releaseIngestLease("kd-1", "a")).toBe(true);
    expect(rowsOf("knowledge_documents")[0].ingest_claimed_by).toBeNull();
    fail("knowledge_documents", "update");
    expect(await releaseIngestLease("kd-1", "a")).toBe(false);
  });
});

describe("markIngestFailed — the compare-and-set", () => {
  const doc = { id: "kd-1", file_key: "orgs/o1/spec.pdf", pages_indexed: 3, status: "indexing", ingest_failures: 0 };
  it("lands on the row as read; a row that moved is left alone (marked false, no error); a database error is said in its words", async () => {
    resetDb(libWorld());
    rowsOf("knowledge_documents")[0].ingest_failures = 0;
    rowsOf("knowledge_documents")[0].status = "indexing";
    const ok = await markIngestFailed(doc, new Error("boom"), Date.parse("2026-11-18T00:00:00Z"));
    expect(ok).toMatchObject({ marked: true, error: null });
    expect(rowsOf("knowledge_documents")[0]).toMatchObject({ ingest_failures: 1, status: "indexing" });
    const moved = await markIngestFailed({ ...doc, file_key: "orgs/o1/other.pdf" }, new Error("boom"));
    expect(moved).toEqual({ marked: false, retryAfter: null, error: null });
    fail("knowledge_documents", "update");
    expect(await markIngestFailed({ ...doc, ingest_failures: 1 }, new Error("boom"))).toEqual({ marked: false, retryAfter: null, error: TIMEOUT.message });
  });
});

// ── The shared reset's deletes (class (c)) ───────────────────────────────
describe("resetKnowledgeIndex — the derived-index deletes", () => {
  it("a document with nothing indexed yet clears nothing: reset, no error", async () => {
    const world = libWorld();
    world.knowledge_chunks = [];
    resetDb(world);
    const out = await resetKnowledgeIndex(["kd-1"]);
    expect(out).toEqual({ reset: ["kd-1"], busy: [], errors: [] });
  });
  it("a delete that fails is reported in the database's words, as a leftover (the row is already queued)", async () => {
    resetDb(libWorld());
    fail("knowledge_chunks", "delete");
    const out = await resetKnowledgeIndex(["kd-1"]);
    expect(out.reset).toEqual(["kd-1"]);
    expect(out.leftovers?.[0].left).toEqual([`chunks: ${TIMEOUT.message}`]);
    expect(rowsOf("knowledge_documents")[0].status).toBe("stale");
  });
  it("a rev-up whose line-trace purge fails resets nothing and says so in the database's words", async () => {
    resetDb(libWorld());
    fail("knowledge_line_traces", "delete");
    const out = await resetKnowledgeIndex(["kd-1"], { purgeLineTraces: true });
    expect(out).toMatchObject({ reset: [], errors: [`kd-1: line traces: ${TIMEOUT.message}`] });
    expect(rowsOf("knowledge_documents")[0].status).toBe("ready");
    expect(rowsOf("knowledge_chunks")).toHaveLength(3);
  });
  it("the row's compare-and-set that matches nothing (the caller's reading is stale) leaves it busy, untouched", async () => {
    resetDb(libWorld());
    const out = await resetKnowledgeIndex(["kd-1"], { expect: () => ({ file_key: "orgs/o1/other.pdf" }) });
    expect(out).toMatchObject({ reset: [], busy: ["kd-1"], errors: [] });
    expect(rowsOf("knowledge_chunks")).toHaveLength(3);
  });
});

// ── The mention pass's clear-before-rewrite (class (c)) ──────────────────
describe("indexDocumentMentions — the machine-mention clear", () => {
  const world = (): Record<string, Row[]> => ({
    knowledge_documents: [{ id: "kd-1", org_id: "o1" }],
    knowledge_chunks: [{ id: "c1", org_id: "o1", document_id: "kd-1", page: 1, seq: 0, content: "Vessel V-101 feeds the column." }],
    entity_mentions: [],
  });
  const dict = [{ assetId: "a1", alias: "V-101", origin: "tag" as const }];
  it("a document with no machine mentions yet clears nothing and writes its mention", async () => {
    resetDb(world());
    const out = await indexDocumentMentions("o1", "kd-1", dict);
    expect(out.mentionsWritten).toBe(1);
    expect(rowsOf("entity_mentions")).toHaveLength(1);
  });
  it("a clear the database refuses stops the pass, logged and thrown in the database's words", async () => {
    resetDb(world());
    fail("entity_mentions", "delete");
    await expect(indexDocumentMentions("o1", "kd-1", dict)).rejects.toThrow(`mention index cleanup: ${TIMEOUT.message}`);
    expect(console.error).toHaveBeenCalledWith("[mentionIndexer]", `mention index cleanup: ${TIMEOUT.message}`, { knowledgeDocumentId: "kd-1" });
    expect(rowsOf("entity_mentions")).toHaveLength(0);
  });
});

// ── GOV-13 — the usage ledger (the real lib/ai/usageServer) ─────────────
describe("usageServer — settle and release (the real module over the in-memory database)", () => {
  const real = () => vi.importActual<typeof import("@/lib/ai/usageServer")>("@/lib/ai/usageServer");
  const reservation = (): Row => ({ id: "ev-1", user_id: "u1", org_id: "o1", op: "knowledgeVision", provider: "openai", model: "m", ok: true, est_cost_usd: 0.5, input_tokens: null, output_tokens: null });
  it("settleUsage: a row that is there carries the figures (true); a row that is gone answers false — the folded reservation stands; an error answers false", async () => {
    const { settleUsage } = await real();
    resetDb({ ai_usage_events: [reservation()] });
    expect(await settleUsage("ev-1", { model: "m", usage: { inputTokens: 10, outputTokens: 5 }, ok: true })).toBe(true);
    expect(rowsOf("ai_usage_events")[0]).toMatchObject({ input_tokens: 10, output_tokens: 5, ok: true });
    resetDb({ ai_usage_events: [] });
    expect(await settleUsage("ev-1", { model: "m", usage: { inputTokens: 10, outputTokens: 5 }, ok: true })).toBe(false);
    resetDb({ ai_usage_events: [reservation()] });
    fail("ai_usage_events", "update");
    expect(await settleUsage("ev-1", { model: "m", usage: { inputTokens: 10, outputTokens: 5 }, ok: true })).toBe(false);
  });
  it("releaseUsage: a delete that lands or matches nothing writes nothing more; a failed delete zeroes the row; a zeroing that fails too is logged", async () => {
    const { releaseUsage } = await real();
    resetDb({ ai_usage_events: [reservation()] });
    await releaseUsage("ev-1");
    expect(rowsOf("ai_usage_events")).toHaveLength(0);
    expect(db.ops.filter((o) => o.kind === "update")).toHaveLength(0);
    resetDb({ ai_usage_events: [] });
    await releaseUsage("ev-1");
    expect(db.ops.map((o) => o.kind)).toEqual(["delete"]);
    resetDb({ ai_usage_events: [reservation()] });
    fail("ai_usage_events", "delete");
    await releaseUsage("ev-1");
    expect(rowsOf("ai_usage_events")[0]).toMatchObject({ ok: false, est_cost_usd: 0, input_tokens: 0, output_tokens: 0 });
    resetDb({ ai_usage_events: [reservation()] });
    fail("ai_usage_events", "delete");
    fail("ai_usage_events", "update");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await releaseUsage("ev-1");
    expect(warn).toHaveBeenCalledWith("[usage] a reservation could not be released or zeroed — it may stay counted", expect.objectContaining({ id: "ev-1" }));
  });
});
