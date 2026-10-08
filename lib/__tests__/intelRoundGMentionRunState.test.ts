// intelligence Round G (I-23) — IRLS-14's remainder: the mention index's run
// state (mention_index_runs, 20261194).
//
// Driven through the REAL engine (lib/mentionIndexer.ts and
// lib/knowledgeIngest.ts rebuildDocumentMentions) against the in-memory
// database (./knowledgeFakeDb), as the service role:
//
//   * an ingest-time build that fails is RECORDED — where it ran (ingest),
//     when, which document, its error in plain words — and the ingest batch
//     still never sees it (it used to be swallowed by `catch {}`);
//   * a rebuild pressed on the map that stops at its time limit keeps a
//     cursor, and the next press continues after it instead of starting at
//     the first document again;
//   * regression: a successful build writes exactly the mention rows it
//     wrote before, and with mention_index_runs absent (20261194 unpasted)
//     every build, failure and rebuild behaves exactly as before the file.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { db, resetDb, rowsOf, type Row } from "./knowledgeFakeDb";

vi.mock("@/lib/supabaseAdmin", async () => ({ supabaseAdmin: (await import("./knowledgeFakeDb")).fakeAdmin }));
vi.mock("@/lib/r2", () => ({ R2_BUCKET: "bucket", r2: { send: async () => { throw new Error("no object store in this test"); } } }));
vi.mock("@/lib/knowledgeVision", async (orig) => ({ ...(await orig<typeof import("@/lib/knowledgeVision")>()), transcribePageImage: vi.fn() }));
vi.mock("@/lib/equipmentBridgeServer", () => ({ computeForKnowledgeDoc: vi.fn(async () => undefined) }));
vi.mock("@/lib/ai/usageServer", async () => (await import("./helpers/fakeUsageMeter")).fakeUsageServer());
vi.mock("@/lib/aiInstructionsServer", () => ({ loadOrgInstructionsBlock: vi.fn(async () => "") }));
vi.mock("@/lib/ai/keyVault", () => ({ openAiKey: (k: string) => k }));

import { NextRequest } from "next/server";
import { rebuildDocumentMentions } from "@/lib/knowledgeIngest";
import { backfillOrgMentions, dictionaryFingerprint } from "@/lib/mentionIndexer";
import { POST as mentionsRoute } from "@/app/api/graph/mentions/route";
import {
  startMentionRun, finishMentionRun, clearStandingFailure, readMentionRunState, parseMentionRunRow, plainBuildError, runStateMissing,
  readBackfillPlace, MENTION_RUN_COLUMNS, MENTION_RUN_MEMBER_COLUMNS, REBUILD_ALIVE_MS, BACKFILL_RESUME_MAX_MS,
  type BackfillPlace,
} from "@/lib/mentionRunState";
import { fakeAdmin } from "./knowledgeFakeDb";
import { mentionNotice, mentionRunNotes, formatRunTime } from "@/lib/graphView";
import type { MentionRunState } from "@/lib/mentionRunState";
import type { MentionCoverage } from "@/lib/orgGraph";
import type { SupabaseClient } from "@supabase/supabase-js";

const ORG = "o1";
const RUNS = "mention_index_runs";
const DOCS = ["k1", "k2", "k3", "k4", "k5"];

/** A ready knowledge document whose one page names P-101 (and k3 also V-7). */
function seedCorpus(): void {
  const docs: Row[] = DOCS.map((id) => ({ id, org_id: ORG, status: "ready", name: `${id}.pdf`, source_document_id: null }));
  const chunks: Row[] = DOCS.map((id, i) => ({
    id: `c-${id}`, org_id: ORG, document_id: id, page: 1, seq: 0,
    content: id === "k3" ? "Pump P-101 feeds vessel V-7 at the north header." : `Pump P-101 is checked on round ${i + 1}.`,
  }));
  resetDb({
    knowledge_documents: docs,
    knowledge_chunks: chunks,
    assets: [
      { id: "a-p101", org_id: ORG, tag: "P-101", archived: false },
      { id: "a-v7", org_id: ORG, tag: "V-7", archived: false },
    ],
    asset_aliases: [],
    entity_mentions: [],
  });
}

const mentionRows = () => rowsOf("entity_mentions")
  .map((m) => `${m.knowledge_document_id}:${m.asset_id}:${m.page}`).sort();
/** The documents whose chunks a build read, in order (one select per document). */
const chunkReads = () => db.ops.filter((o) => o.table === "knowledge_chunks" && o.kind === "select")
  .map((o) => o.filters.find((f) => f.col === "document_id")?.value);
const runRow = () => rowsOf(RUNS)[0];

/** A permission failure on the delete that clears a document's earlier mentions. */
function failCleanupOf(doc: string): void {
  db.hooks.push((op, filters) => op.table === "entity_mentions" && op.kind === "delete"
    && filters.some((f) => f.col === "knowledge_document_id" && f.value === doc)
    ? { error: { code: "42501", message: "permission denied for table entity_mentions" } } : undefined);
}

/** A clock for the rebuild's deadline: it advances one step per document read. */
function documentClock(): { now: number; deadlineAfter: (docs: number) => number } {
  const clock = { now: 1_000_000, deadlineAfter: (docs: number) => clock.now + docs * 10 - 5 };
  db.hooks.push((op) => { if (op.table === "knowledge_chunks" && op.kind === "select") clock.now += 10; });
  vi.spyOn(Date, "now").mockImplementation(() => clock.now);
  return clock;
}

const admin = fakeAdmin as unknown as SupabaseClient;
/** The run state's table is absent: 20261194 not pasted. */
const unpasted = () => { db.missingTables = [RUNS]; };
const runOps = () => db.ops.filter((o) => o.table === RUNS);

let logged: ReturnType<typeof vi.spyOn>;
let warned: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  seedCorpus();
  logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
  warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => { vi.restoreAllMocks(); });

describe("IRLS-14 (I-23) — reproduction on the engine as it was: a build that failed elsewhere left no trace", () => {
  it("a failed ingest-time build is recorded — where (ingest), when, which document, its error in plain words — and the batch never sees it", async () => {
    failCleanupOf("k2");
    const before = Date.now();
    await expect(rebuildDocumentMentions({ id: "k2", org_id: ORG, source_document_id: null })).resolves.toBeUndefined();
    const row = runRow();
    expect(row).toBeDefined();
    expect(row).toMatchObject({
      org_id: ORG,
      last_run_source: "ingest", last_run_document_id: "k2", last_run_outcome: "failed",
      last_failed_source: "ingest", last_failed_document_id: "k2",
      last_failed_error: "Clearing the document's earlier links failed: the database refused it (permission denied).",
    });
    expect(Date.parse(String(row.last_failed_at))).toBeGreaterThanOrEqual(before - 1000);
    expect(Date.parse(String(row.last_run_finished_at))).toBeGreaterThanOrEqual(Date.parse(String(row.last_run_started_at)));
    // The raw text stays in the server log (the indexer's own line), never on the row.
    expect(String(row.last_failed_error)).not.toMatch(/entity_mentions|permission denied for table/);
    expect(logged).toHaveBeenCalledWith("[mentionIndexer]", expect.stringMatching(/mention index cleanup: permission denied/), { knowledgeDocumentId: "k2" });
  });

  it("a rebuild that stopped at its time limit is continued by the second press, after the last document it finished", async () => {
    const clock = documentClock();
    const first = await backfillOrgMentions(ORG, undefined, clock.deadlineAfter(2));
    expect(first).toMatchObject({ documents: 2, incomplete: true, resumable: true });
    expect(chunkReads()).toEqual(["k1", "k2"]);
    expect(runRow()).toMatchObject({
      last_run_source: "map", last_run_outcome: "stopped", backfill_cursor: "k2", backfill_documents: 2, backfill_state: "time_limit",
    });
    db.ops = [];
    const second = await backfillOrgMentions(ORG, undefined, clock.deadlineAfter(10));
    // It reads k3…k5 only — never k1 and k2 again.
    expect(chunkReads()).toEqual(["k3", "k4", "k5"]);
    expect(second).toMatchObject({ documents: 3, incomplete: false, continued: true, passDocuments: 5 });
    expect("startedOver" in second).toBe(false);
    expect(runRow()).toMatchObject({
      last_run_outcome: "succeeded", backfill_cursor: null, backfill_documents: 0, backfill_state: null, backfill_dictionary: null,
    });
    // The map ends with every document's mentions, as one uninterrupted rebuild would.
    expect(mentionRows()).toEqual([
      "k1:a-p101:1", "k2:a-p101:1", "k3:a-p101:1", "k3:a-v7:1", "k4:a-p101:1", "k5:a-p101:1",
    ]);
  });
});

describe("IRLS-14 (I-23) — the ingest-time pass", () => {
  it("regression: a successful build writes exactly the mention rows it wrote before (the same with the run state absent), and is recorded as succeeded", async () => {
    unpasted();
    await rebuildDocumentMentions({ id: "k3", org_id: ORG, source_document_id: null });
    const without = mentionRows();
    expect(without).toEqual(["k3:a-p101:1", "k3:a-v7:1"]);
    expect(rowsOf(RUNS)).toEqual([]);

    seedCorpus();
    await rebuildDocumentMentions({ id: "k3", org_id: ORG, source_document_id: null });
    expect(mentionRows()).toEqual(without);
    expect(runRow()).toMatchObject({ last_run_source: "ingest", last_run_document_id: "k3", last_run_outcome: "succeeded" });
    expect(runRow().last_failed_at ?? null).toBeNull();
    expect(runRow().backfill_cursor ?? null).toBeNull();
    expect(logged).not.toHaveBeenCalled();
  });

  it("with the run state absent (20261194 unpasted) a failed build is swallowed exactly as before — nothing thrown, nothing written, said once in the log", async () => {
    unpasted();
    failCleanupOf("k2");
    await expect(rebuildDocumentMentions({ id: "k2", org_id: ORG, source_document_id: null })).resolves.toBeUndefined();
    await expect(rebuildDocumentMentions({ id: "k2", org_id: ORG, source_document_id: null })).resolves.toBeUndefined();
    expect(rowsOf(RUNS)).toEqual([]);
    // One attempt each (the start), each refused as missing — no failure write follows.
    expect(runOps().map((o) => o.kind)).toEqual(["upsert", "upsert"]);
    expect(logged.mock.calls.filter((c: unknown[]) => c[0] === "[mentionRunState]")).toEqual([]);
  });

  it("a success clears this document's own standing failure — never another document's, and never a newer one", async () => {
    failCleanupOf("k2");
    await rebuildDocumentMentions({ id: "k2", org_id: ORG, source_document_id: null });
    expect(runRow()).toMatchObject({ last_failed_document_id: "k2" });
    // Another document succeeding leaves k2's failure standing.
    await rebuildDocumentMentions({ id: "k1", org_id: ORG, source_document_id: null });
    expect(runRow()).toMatchObject({ last_run_document_id: "k1", last_run_outcome: "succeeded", last_failed_document_id: "k2" });
    // k2 itself succeeding clears it.
    db.hooks = [];
    await rebuildDocumentMentions({ id: "k2", org_id: ORG, source_document_id: null });
    expect(runRow()).toMatchObject({ last_run_outcome: "succeeded", last_failed_at: null, last_failed_error: null, last_failed_document_id: null });

    // A failure recorded after a build started is never cleared by it (the compare on its time).
    failCleanupOf("k4");
    await rebuildDocumentMentions({ id: "k4", org_id: ORG, source_document_id: null });
    const run = await startMentionRun(admin, ORG, "ingest", "k4");
    expect(run.standingFailure?.documentId).toBe("k4");
    db.tables[RUNS][0].last_failed_at = new Date(Date.now() + 1000).toISOString(); // a newer failure lands meanwhile
    expect(await clearStandingFailure(admin, run)).toBe(false);
    expect(runRow()).toMatchObject({ last_failed_document_id: "k4" });
  });

  it("a build that outruns the ingest cap still records how it ended when it settles — the batch went on without it", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    db.asyncHooks.push(async (op) => { if (op.table === "entity_mentions" && op.kind === "delete") await gate; });
    await rebuildDocumentMentions({ id: "k1", org_id: ORG, source_document_id: null }, 5);
    expect(runRow()).toMatchObject({ last_run_document_id: "k1", last_run_outcome: "running" });
    release();
    await vi.waitFor(() => expect(runRow()).toMatchObject({ last_run_outcome: "succeeded" }));
    expect(mentionRows()).toEqual(["k1:a-p101:1"]);
  });

  it("an empty equipment dictionary builds nothing and records nothing, as before", async () => {
    db.tables.assets = [];
    await rebuildDocumentMentions({ id: "k1", org_id: ORG, source_document_id: null });
    expect(rowsOf(RUNS)).toEqual([]);
    expect(runOps()).toEqual([]);
  });
});

describe("IRLS-14 (I-23) — a rebuild from the map", () => {
  it("a failed map-started build: the route answers exactly as today, the failure is recorded (map, document, plain words), and the next press retries that document first", async () => {
    db.tables.org_members = [{ id: "m1", org_id: ORG, uid: "u-ctrl", role: "Admin", roles: ["Admin"], status: "active" }];
    failCleanupOf("k3");
    const res = await mentionsRoute(new NextRequest("http://x/api/graph/mentions", {
      method: "POST", headers: { authorization: "Bearer good", "content-type": "application/json" }, body: JSON.stringify({ orgId: ORG }),
    }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "mention index cleanup: permission denied for table entity_mentions" });
    expect(runRow()).toMatchObject({
      last_run_source: "map", last_run_outcome: "failed",
      last_failed_source: "map", last_failed_document_id: "k3",
      last_failed_error: "Clearing the document's earlier links failed: the database refused it (permission denied).",
      backfill_cursor: "k2", backfill_documents: 2, backfill_state: "failed",
    });
    db.hooks = [];
    db.ops = [];
    const again = await backfillOrgMentions(ORG);
    expect(chunkReads()).toEqual(["k3", "k4", "k5"]);
    expect(again).toMatchObject({ documents: 3, incomplete: false, continued: true, passDocuments: 5 });
    // k3 rebuilt: its failure no longer stands; the rebuild is finished.
    expect(runRow()).toMatchObject({ last_run_outcome: "succeeded", last_failed_at: null, backfill_cursor: null });
  });

  it("regression: a whole rebuild with nothing stopped answers exactly the shape it answered before, and records it", async () => {
    const r = await backfillOrgMentions(ORG);
    expect(Object.keys(r).sort()).toEqual(["assetsTouched", "chunksScanned", "documents", "incomplete", "lowConfidence", "mentionsWritten"]);
    expect(r).toMatchObject({ documents: 5, incomplete: false, mentionsWritten: 6 });
    expect(chunkReads()).toEqual(DOCS);
    expect(runRow()).toMatchObject({ last_run_source: "map", last_run_outcome: "succeeded", last_run_document_id: null });
  });

  it("with the run state absent (20261194 unpasted) every press starts at the first document, and answers as before", async () => {
    unpasted();
    const clock = documentClock();
    const first = await backfillOrgMentions(ORG, undefined, clock.deadlineAfter(2));
    db.ops = [];
    const second = await backfillOrgMentions(ORG, undefined, clock.deadlineAfter(2));
    expect(chunkReads()).toEqual(["k1", "k2"]);
    for (const r of [first, second]) {
      expect(Object.keys(r).sort()).toEqual(["assetsTouched", "chunksScanned", "documents", "incomplete", "lowConfidence", "mentionsWritten"]);
      expect(r).toMatchObject({ documents: 2, incomplete: true });
    }
    expect(rowsOf(RUNS)).toEqual([]);
    expect(logged.mock.calls.filter((c: unknown[]) => c[0] === "[mentionRunState]")).toEqual([]);
  });

  it("a rebuild saves its place as it goes: one the platform kills mid-way is continued from the last save", async () => {
    // Six seconds per document: the place is saved after the second (>= 10 s).
    const clock = { now: 5_000_000 };
    vi.spyOn(Date, "now").mockImplementation(() => clock.now);
    let seenAtThird: Row | undefined;
    db.hooks.push((op, filters) => {
      if (op.table !== "knowledge_chunks" || op.kind !== "select") return;
      if (filters.some((f) => f.col === "document_id" && f.value === "k3")) seenAtThird = { ...runRow() };
      clock.now += 6_000;
    });
    await backfillOrgMentions(ORG);
    expect(seenAtThird).toMatchObject({ last_run_outcome: "running", backfill_cursor: "k2", backfill_documents: 2, backfill_state: "running" });
    // Finished: the saved place is cleared.
    expect(runRow()).toMatchObject({ last_run_outcome: "succeeded", backfill_cursor: null, backfill_documents: 0, backfill_state: null });
  });

  it("a rebuild that reads to the end clears a failure that stood before it began — never one recorded after it began", async () => {
    failCleanupOf("k9");
    db.tables.knowledge_documents.push({ id: "k9", org_id: ORG, status: "indexing", name: "k9.pdf" });
    db.tables.knowledge_chunks.push({ id: "c-k9", org_id: ORG, document_id: "k9", page: 1, seq: 0, content: "P-101" });
    await rebuildDocumentMentions({ id: "k9", org_id: ORG, source_document_id: null });
    expect(runRow()).toMatchObject({ last_failed_document_id: "k9" });
    await backfillOrgMentions(ORG);
    expect(runRow()).toMatchObject({ last_failed_at: null, last_run_outcome: "succeeded" });

    // A failure recorded while the rebuild runs stands.
    db.hooks.push((op, filters) => {
      if (op.table === "knowledge_chunks" && op.kind === "select" && filters.some((f) => f.col === "document_id" && f.value === "k5")) {
        db.tables[RUNS][0].last_failed_at = new Date(Date.now() + 60_000).toISOString();
        db.tables[RUNS][0].last_failed_source = "ingest";
        db.tables[RUNS][0].last_failed_document_id = "k9";
      }
    });
    await backfillOrgMentions(ORG);
    expect(runRow()).toMatchObject({ last_failed_document_id: "k9", last_run_outcome: "succeeded" });
  });
});

describe("IRLS-14 (I-23) — lib/mentionRunState.ts", () => {
  it("reads the member's row — the member columns only — and null when the table, a column or the read is not there; never throws", async () => {
    await rebuildDocumentMentions({ id: "k1", org_id: ORG, source_document_id: null });
    db.ops = [];
    const state = await readMentionRunState(admin, ORG);
    expect(runOps()[0].columns).toEqual(MENTION_RUN_MEMBER_COLUMNS.split(",").map((c) => c.trim()));
    // A member's read carries no knowledge-document id (20261194 grants none).
    expect(state?.lastRun).toMatchObject({ source: "ingest", outcome: "succeeded", documentId: null });
    expect(state?.lastFailure).toBeNull();
    expect(state?.backfill).toBeNull();
    expect(await readMentionRunState(admin, "other-org")).toBeNull();
    unpasted();
    expect(await readMentionRunState(admin, ORG)).toBeNull();
    db.missingTables = [];
    db.missingColumns = { [RUNS]: ["backfill_state"] };
    expect(await readMentionRunState(admin, ORG)).toBeNull();
    const broken = { from: () => { throw new TypeError("not a client"); } } as unknown as SupabaseClient;
    expect(await readMentionRunState(broken, ORG)).toBeNull();
  });

  it("a missing table is said once in the server log, however many builds meet it", async () => {
    vi.resetModules();
    const fresh = await import("@/lib/mentionRunState");
    unpasted();
    const a = await fresh.startMentionRun(admin, ORG, "ingest", "k1");
    const b = await fresh.startMentionRun(admin, ORG, "map");
    expect([a.recorded, a.installed, b.recorded, b.installed]).toEqual([false, false, false, false]);
    await fresh.finishMentionRun(admin, a, { outcome: "failed", error: new Error("mention index: x") });
    expect(runOps().map((o) => o.kind)).toEqual(["upsert", "upsert"]);   // the failure is not attempted
    expect(warned).toHaveBeenCalledTimes(1);
    expect(String(warned.mock.calls[0][0])).toMatch(/mention_index_runs is not installed \(20261194/);
  });

  it("a start the database refuses (not a missing table) still records the failure it ends in", async () => {
    db.hooks.push((op) => op.table === RUNS && op.kind === "upsert" && runOps().length === 1
      ? { error: { code: "40001", message: "could not serialize access" } } : undefined);
    failCleanupOf("k2");
    await rebuildDocumentMentions({ id: "k2", org_id: ORG, source_document_id: null });
    expect(runRow()).toMatchObject({ last_failed_source: "ingest", last_failed_document_id: "k2" });
    expect(runRow().last_run_id ?? null).toBeNull();
    expect(logged).toHaveBeenCalledWith("[mentionRunState]", "the build's start was not recorded: could not serialize access");
  });

  it("the missing-schema shapes are the four codes (and their texts naming the table) — a denial or an outage is not 'not installed'", () => {
    for (const code of ["PGRST205", "42P01", "42703", "PGRST204"]) expect(runStateMissing({ code, message: "x" }), code).toBe(true);
    expect(runStateMissing({ message: 'relation "public.mention_index_runs" does not exist' })).toBe(true);
    expect(runStateMissing({ message: "Could not find the table 'public.mention_index_runs' in the schema cache" })).toBe(true);
    expect(runStateMissing({ code: "42501", message: "permission denied for table mention_index_runs" })).toBe(false);
    expect(runStateMissing({ message: "fetch failed" })).toBe(false);
    expect(runStateMissing(null)).toBe(false);
  });

  it("a row is read whole or not at all, part by part — nothing guessed", () => {
    expect(parseMentionRunRow(null)).toBeNull();
    expect(parseMentionRunRow({ org_id: ORG, last_run_source: "elsewhere", last_run_started_at: "2026-10-07T10:00:00Z", last_run_outcome: "running" }))
      .toEqual({ lastRun: null, lastFailure: null, backfill: null });
    expect(parseMentionRunRow({ org_id: ORG, last_failed_source: "map", last_failed_at: "2026-10-07T10:00:00Z", last_failed_error: "  " })?.lastFailure)
      .toEqual({ source: "map", at: "2026-10-07T10:00:00Z", error: "The build failed and recorded no reason.", documentId: null });
    expect(parseMentionRunRow({ org_id: ORG, backfill_cursor: "k2", backfill_documents: -3 })?.backfill)
      .toEqual({ cursor: "k2", startedAt: null, documents: 0, state: null, savedAt: null, dictionary: null });
    // A member's read carries the place's state and count, never its cursor or fingerprint.
    expect(parseMentionRunRow({ org_id: ORG, backfill_state: "failed", backfill_documents: 2, backfill_started_at: "2026-10-07T10:00:00Z" })?.backfill)
      .toEqual({ cursor: null, startedAt: "2026-10-07T10:00:00Z", documents: 2, state: "failed", savedAt: null, dictionary: null });
    expect(parseMentionRunRow({ org_id: ORG, backfill_state: "paused" })?.backfill).toBeNull();
    // The columns the builders name are the columns 20261194 creates (its shape test pins the file side);
    // the member's are a subset without an id, the cursor or the fingerprint.
    const all = MENTION_RUN_COLUMNS.split(",").map((c) => c.trim());
    const member = MENTION_RUN_MEMBER_COLUMNS.split(",").map((c) => c.trim());
    expect(all).toHaveLength(17);
    expect(member).toHaveLength(12);
    for (const c of member) expect(all, c).toContain(c);
    for (const c of ["last_run_id", "last_run_document_id", "last_failed_document_id", "backfill_cursor", "backfill_dictionary"]) expect(member, c).not.toContain(c);
  });

  it("an error in plain words: the step and why, never a table, column or policy name", () => {
    expect(plainBuildError(new Error("mention index write: duplicate key value violates unique constraint \"entity_mentions_kdoc_page_uniq\"")))
      .toBe("Writing the document's links to equipment failed: a link it wrote was already there.");
    expect(plainBuildError(new Error("mention index: relation \"public.knowledge_chunks\" does not exist")))
      .toBe("Reading the document's indexed text failed: a part of the database it needs is missing (a migration has not been applied).");
    expect(plainBuildError(new Error("fetch failed"))).toBe("The build failed: the database could not be reached.");
    expect(plainBuildError(new Error("mention index write: canceling statement due to statement timeout")))
      .toBe("Writing the document's links to equipment failed: the database took too long to answer.");
    // Anything the table does not know is said as unexpected — never shown raw.
    expect(plainBuildError(new Error("mention index write: something odd on table \"entity_mentions\"")))
      .toBe("Writing the document's links to equipment failed: it stopped on an unexpected error.");
    expect(plainBuildError(new Error("Cannot find module '@/lib/mentionIndexer'"))).toBe("The build failed: it stopped on an unexpected error.");
    expect(plainBuildError({ code: "XX000", message: "internal error" })).toBe("The build failed: the database refused it unexpectedly.");
    expect(plainBuildError(new Error(`mention index write: ${"x ".repeat(400)}`)).length).toBeLessThanOrEqual(500);
  });
});

describe("IRLS-14 (I-23) — the map names the build (lib/graphView.ts mentionNotice)", () => {
  const cov = (over: Partial<MentionCoverage> = {}): MentionCoverage =>
    ({ installed: true, rows: 0, drawn: 0, unmapped: 0, capped: false, ...over });
  const NOW = Date.parse("2026-10-07T12:00:00Z");
  const FAILED_AT = "2026-10-07T10:02:00.000Z";
  const PLAIN = "Clearing the document's earlier links failed: the database refused it (permission denied).";
  const failedAt = (source: "ingest" | "map"): MentionRunState => ({
    lastRun: { source, startedAt: FAILED_AT, finishedAt: FAILED_AT, outcome: "failed", documentId: source === "ingest" ? "k2" : null },
    lastFailure: { source, at: FAILED_AT, error: PLAIN, documentId: "k2" },
    backfill: null,
  });
  const TEXTS = {
    notInstalled: "The mention index is not installed (migration 20260929_mention_engine.sql), so no document is linked to equipment by what its text says.",
    rowsNotDrawn: "3 mentions read, but none land on this map — the notes beside this one say why.",
    noEquipment: "No “mentioned in the text” links: there is no registry equipment on this map for a document to name.",
    cannotTell: "No “mentioned in the text” links on this map. Either the mention index has not been built for these documents, or it found none of this registry's equipment named in the documents you can see — the map cannot tell which. Each document is indexed when it finishes reading; an admin, document controller, manager or supervisor can rebuild the whole index from this map.",
  };

  it("regression: with no run state, a run state not installed, or a last build that succeeded (or is running), every notice is exactly what it was", () => {
    const succeeded: MentionRunState = {
      lastRun: { source: "map", startedAt: FAILED_AT, finishedAt: FAILED_AT, outcome: "succeeded", documentId: null },
      lastFailure: null, backfill: null,
    };
    // An ingest-time build that is running adds nothing (a rebuild from the map that is running is said — below).
    const running: MentionRunState = { ...succeeded, lastRun: { ...succeeded.lastRun!, source: "ingest", outcome: "running", finishedAt: null, startedAt: new Date(NOW - 60_000).toISOString() } };
    const shapes: Array<[MentionCoverage | undefined, number, unknown]> = [
      [cov({ rows: 3, drawn: 2 }), 10, null],
      [undefined, 10, null],
      [cov({ installed: false }), 10, { text: TEXTS.notInstalled, canRebuild: false }],
      [cov({ rows: 3 }), 10, { text: TEXTS.rowsNotDrawn, canRebuild: false }],
      [cov(), 0, { text: TEXTS.noEquipment, canRebuild: false }],
      [cov(), 10, { text: TEXTS.cannotTell, canRebuild: true }],
    ];
    for (const [c, eq, expected] of shapes) {
      expect(mentionNotice(c, eq)).toEqual(expected);
      for (const state of [null, undefined, succeeded, running]) {
        expect(mentionNotice(c, eq, state, NOW), JSON.stringify([c, eq, state])).toEqual(expected);
      }
    }
    expect(mentionRunNotes(succeeded, NOW)).toBeNull();
    expect(mentionRunNotes(running, NOW)).toBeNull();
  });

  it("a failed ingest-time build is named on the map: where it ran, when, and its error in plain words — with the rebuild offered", () => {
    const m = mentionNotice(cov(), 10, failedAt("ingest"), NOW)!;
    expect(m.text).toBe(`${TEXTS.cannotTell} The last mention build that failed ran at ingest (when a document finished indexing), on ${formatRunTime(FAILED_AT)}. ${PLAIN}`);
    expect(m.canRebuild).toBe(true);
    expect("canContinue" in m).toBe(false);
  });

  it("a failed build is named even where links ARE drawn — some may be missing — and beside rows the map could not place", () => {
    const drawn = mentionNotice(cov({ rows: 4, drawn: 3 }), 10, failedAt("map"), NOW)!;
    expect(drawn.text).toBe(`Some “mentioned in the text” links may be missing from this map. The last mention build that failed ran from this map (a rebuild of the whole index), on ${formatRunTime(FAILED_AT)}. ${PLAIN}`);
    expect(drawn.canRebuild).toBe(true);
    const placed = mentionNotice(cov({ rows: 3 }), 10, failedAt("ingest"), NOW)!;
    expect(placed.text.startsWith(`${TEXTS.rowsNotDrawn} The last mention build that failed ran at ingest`)).toBe(true);
  });

  it("an index that is not installed, or a map with no equipment to name, says only what it said", () => {
    expect(mentionNotice(cov({ installed: false }), 10, failedAt("ingest"), NOW)).toEqual({ text: TEXTS.notInstalled, canRebuild: false });
    expect(mentionNotice(cov(), 0, failedAt("ingest"), NOW)).toEqual({ text: TEXTS.noEquipment, canRebuild: false });
    // Fix pass (review minor): no equipment on the map means nothing is added even where rows were read.
    expect(mentionNotice(cov({ rows: 3 }), 0, failedAt("ingest"), NOW)).toEqual({ text: TEXTS.rowsNotDrawn, canRebuild: false });
    expect(mentionNotice(undefined, 10, failedAt("ingest"), NOW)).toBeNull();
  });

  it("a stopped rebuild is offered to continue — with links drawn too, so the next press is always reachable", () => {
    const stopped: MentionRunState = {
      lastRun: { source: "map", startedAt: FAILED_AT, finishedAt: FAILED_AT, outcome: "stopped", documentId: null },
      lastFailure: null,
      backfill: { cursor: null, startedAt: FAILED_AT, documents: 2, state: "time_limit", savedAt: FAILED_AT, dictionary: null },
    };
    for (const c of [cov(), cov({ rows: 5, drawn: 2 })]) {
      const m = mentionNotice(c, 10, stopped, NOW)!;
      expect(m.canContinue).toBe(true);
      expect(m.canRebuild).toBe(true);
      expect(m.text).toContain(`The last rebuild from this map (started ${formatRunTime(FAILED_AT)}) stopped at its time limit after 2 documents; the rest have not been read yet — continue it to pick up where it stopped.`);
    }
  });

  it("a build that never reported how it ended is named once it is stale — never while it may still be running", () => {
    const started = new Date(NOW - 16 * 60_000).toISOString();
    const stale: MentionRunState = {
      lastRun: { source: "ingest", startedAt: started, finishedAt: null, outcome: "running", documentId: "k1" },
      lastFailure: null, backfill: null,
    };
    expect(mentionNotice(cov(), 10, stale, NOW)!.text).toContain(`The last mention build, at ingest (when a document finished indexing), started on ${formatRunTime(started)} and never reported how it ended — it may have been cut off before it finished.`);
    expect(mentionNotice(cov(), 10, stale, NOW - 10 * 60_000)).toEqual({ text: TEXTS.cannotTell, canRebuild: true });
    expect(formatRunTime("not a time")).toBe("an unknown time");
  });
});

// ── Fix pass (review of I-23) ────────────────────────────────────────────────

describe("I-23 fix pass — a stopped rebuild is continued only with the dictionary it read with, and only while it is recent", () => {
  it("reproduction of the review's blocker: stop after 2 documents, add equipment, press again — the read starts at k1, and the press says why", async () => {
    const clock = documentClock();
    await backfillOrgMentions(ORG, undefined, clock.deadlineAfter(2));
    expect(runRow()).toMatchObject({ backfill_cursor: "k2", backfill_state: "time_limit" });
    db.tables.assets.push({ id: "a-x9", org_id: ORG, tag: "X-9", archived: false });
    db.ops = [];
    const second = await backfillOrgMentions(ORG, undefined, clock.deadlineAfter(10));
    expect(chunkReads()).toEqual(DOCS);
    expect(second).toMatchObject({ documents: 5, incomplete: false, startedOver: "equipment_changed" });
    expect("continued" in second).toBe(false);
    expect(runRow()).toMatchObject({ last_run_outcome: "succeeded", backfill_cursor: null, backfill_state: null });
  });

  it("a changed alias counts too; a press that starts over and stops overwrites the place with its own (new dictionary, its own start and count)", async () => {
    const clock = documentClock();
    await backfillOrgMentions(ORG, undefined, clock.deadlineAfter(2));
    const before = { ...runRow() };
    db.tables.asset_aliases.push({ id: "al1", org_id: ORG, asset_id: "a-p101", alias: "the north pump", origin: "human" });
    db.ops = [];
    const second = await backfillOrgMentions(ORG, undefined, clock.deadlineAfter(3));
    expect(chunkReads()).toEqual(["k1", "k2", "k3"]);
    expect(second).toMatchObject({ documents: 3, incomplete: true, resumable: true, startedOver: "equipment_changed" });
    const after = runRow();
    expect(after).toMatchObject({ backfill_cursor: "k3", backfill_documents: 3, backfill_state: "time_limit" });
    expect(after.backfill_dictionary).not.toBe(before.backfill_dictionary);
    expect(Date.parse(String(after.backfill_started_at))).toBeGreaterThanOrEqual(Date.parse(String(before.backfill_started_at)));
    // The third press, the dictionary unchanged since, continues the new place.
    db.ops = [];
    const third = await backfillOrgMentions(ORG, undefined, clock.deadlineAfter(10));
    expect(chunkReads()).toEqual(["k4", "k5"]);
    expect(third).toMatchObject({ continued: true, passDocuments: 5 });
  });

  it("a stopped rebuild that began more than BACKFILL_RESUME_MAX_MS ago is not continued", async () => {
    const clock = documentClock();
    await backfillOrgMentions(ORG, undefined, clock.deadlineAfter(2));
    db.tables[RUNS][0].backfill_started_at = new Date(Date.parse(String(runRow().backfill_started_at)) - BACKFILL_RESUME_MAX_MS - 60_000).toISOString();
    db.ops = [];
    const second = await backfillOrgMentions(ORG, undefined, clock.deadlineAfter(10));
    expect(chunkReads()).toEqual(DOCS);
    expect(second).toMatchObject({ documents: 5, startedOver: "too_old" });
  });

  it("a press claims the place from its start — 'running', nothing read yet, the dictionary's fingerprint — so the map never offers to continue while it reads", async () => {
    let atFirst: Row | undefined;
    db.hooks.push((op) => { if (op.table === "knowledge_chunks" && op.kind === "select" && !atFirst) atFirst = { ...runRow() }; });
    await backfillOrgMentions(ORG);
    expect(atFirst).toMatchObject({ last_run_outcome: "running", backfill_state: "running", backfill_cursor: null, backfill_documents: 0 });
    expect(atFirst!.backfill_dictionary).toBe(dictionaryFingerprint([
      { assetId: "a-p101", alias: "P-101", origin: "tag" }, { assetId: "a-v7", alias: "V-7", origin: "tag" },
    ]));
    const seen = parseMentionRunRow(atFirst as never);
    expect(mentionNotice({ installed: true, rows: 4, drawn: 2, unmapped: 0, capped: false }, 10, seen, Date.now())).toMatchObject({ canRebuild: false });
  });

  it("a rebuild that fails on its first document leaves nothing to continue: the map names the failure only, and the next press reads from k1", async () => {
    failCleanupOf("k1");
    await expect(backfillOrgMentions(ORG)).rejects.toThrow(/mention index cleanup/);
    expect(runRow()).toMatchObject({ backfill_state: "failed", backfill_cursor: null, backfill_documents: 0, last_failed_document_id: "k1" });
    const notice = mentionNotice({ installed: true, rows: 0, drawn: 0, unmapped: 0, capped: false }, 10, parseMentionRunRow(runRow() as never), Date.now())!;
    expect(notice.text).toContain("The last mention build that failed ran from this map");
    expect(notice.text).not.toMatch(/time limit|stopped on a failure after|continue it/);
    expect("canContinue" in notice).toBe(false);
    db.hooks = [];
    db.ops = [];
    const again = await backfillOrgMentions(ORG);
    expect(chunkReads()).toEqual(DOCS);
    expect(Object.keys(again).sort()).toEqual(["assetsTouched", "chunksScanned", "documents", "incomplete", "lowConfidence", "mentionsWritten"]);
  });

  it("the dictionary's fingerprint is its content, not its order — any asset, alias or origin changes it", () => {
    const d = [
      { assetId: "a1", alias: "P-101", origin: "tag" as const }, { assetId: "a2", alias: "north pump", origin: "human" as const },
    ];
    const fp = dictionaryFingerprint(d);
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
    expect(dictionaryFingerprint([...d].reverse())).toBe(fp);
    expect(dictionaryFingerprint([...d, { assetId: "a3", alias: "V-7", origin: "tag" }])).not.toBe(fp);
    expect(dictionaryFingerprint([d[0], { ...d[1], alias: "south pump" }])).not.toBe(fp);
    expect(dictionaryFingerprint([d[0], { ...d[1], origin: "vision" }])).not.toBe(fp);
    expect(dictionaryFingerprint([d[0], { ...d[1], assetId: "a9" }])).not.toBe(fp);
  });
});

describe("I-23 fix pass — the map says what the rebuild's place is: running, stopped at its time limit, stopped on a failure, cut off, too old", () => {
  const cov = (over: Partial<MentionCoverage> = {}): MentionCoverage =>
    ({ installed: true, rows: 0, drawn: 0, unmapped: 0, capped: false, ...over });
  const NOW = Date.parse("2026-10-07T12:00:00Z");
  const ago = (ms: number) => new Date(NOW - ms).toISOString();
  const BEGAN = ago(60 * 60_000);
  const PLAIN = "Clearing the document's earlier links failed: the database refused it (permission denied).";
  const place = (over: Partial<BackfillPlace>): BackfillPlace =>
    ({ cursor: null, startedAt: BEGAN, documents: 2, state: "time_limit", savedAt: ago(30 * 60_000), dictionary: null, ...over });
  const state = (backfill: BackfillPlace | null, extra: Partial<MentionRunState> = {}): MentionRunState =>
    ({ lastRun: null, lastFailure: null, backfill, ...extra });

  it("review blocker, case 1: a rebuild 30 s in (its place saved 20 s ago) is said as running — never 'stopped at its time limit', never offered to continue", () => {
    const run = state(place({ state: "running", savedAt: ago(20_000) }), {
      lastRun: { source: "map", startedAt: ago(30_000), finishedAt: null, outcome: "running", documentId: null },
    });
    const drawn = mentionNotice(cov({ rows: 5, drawn: 2 }), 10, run, NOW)!;
    expect(drawn.text).toBe(`Some “mentioned in the text” links may be missing from this map. A rebuild of the whole index from this map is running now (started ${formatRunTime(BEGAN)}, 2 documents read so far).`);
    expect(drawn.canRebuild).toBe(false);
    expect("canContinue" in drawn).toBe(false);
    // Where the coverage offers the rebuild anyway, the offer stays — labelled as a rebuild, not a continue.
    const none = mentionNotice(cov(), 10, run, NOW)!;
    expect(none.canRebuild).toBe(true);
    expect("canContinue" in none).toBe(false);
    expect(none.text).not.toMatch(/time limit|continue it/);
    // The first seconds of a press, before its place: the last build says it.
    const early = state(null, { lastRun: { source: "map", startedAt: ago(5_000), finishedAt: null, outcome: "running", documentId: null } });
    expect(mentionRunNotes(early, NOW)).toEqual({
      text: `A rebuild of the whole index from this map is running now (started ${formatRunTime(ago(5_000))}).`, canContinue: false, canRebuild: false,
    });
  });

  it("review blocker, case 2: a rebuild that failed on k3 says it stopped on a failure after 2 documents — never at its time limit", () => {
    const run = state(place({ state: "failed", savedAt: ago(10 * 60_000) }), {
      lastRun: { source: "map", startedAt: ago(11 * 60_000), finishedAt: ago(10 * 60_000), outcome: "failed", documentId: null },
      lastFailure: { source: "map", at: ago(10 * 60_000), error: PLAIN, documentId: null },
    });
    const m = mentionNotice(cov(), 10, run, NOW)!;
    expect(m.text).toContain(`The last mention build that failed ran from this map (a rebuild of the whole index), on ${formatRunTime(ago(10 * 60_000))}. ${PLAIN}`);
    expect(m.text).toContain(`The last rebuild from this map (started ${formatRunTime(BEGAN)}) stopped on a failure after 2 documents; continue it to try that document again and read the rest.`);
    expect(m.text).not.toMatch(/time limit/);
    expect(m).toMatchObject({ canRebuild: true, canContinue: true });
  });

  it("a place saved as reading but not since REBUILD_ALIVE_MS is a press that was cut off — offered to continue, said once", () => {
    const run = state(place({ state: "running", savedAt: ago(REBUILD_ALIVE_MS + 1_000) }), {
      lastRun: { source: "map", startedAt: ago(20 * 60_000), finishedAt: null, outcome: "running", documentId: null },
    });
    const m = mentionNotice(cov({ rows: 5, drawn: 2 }), 10, run, NOW)!;
    expect(m.text).toBe(`Some “mentioned in the text” links may be missing from this map. The last rebuild from this map (started ${formatRunTime(BEGAN)}) was cut off after 2 documents without reporting how it ended; continue it to pick up where it last saved its place.`);
    expect(m).toMatchObject({ canRebuild: true, canContinue: true });
  });

  it("a rebuild that began more than BACKFILL_RESUME_MAX_MS ago is said too old to continue — the rebuild is offered, not the continue", () => {
    const old = ago(BACKFILL_RESUME_MAX_MS + 60 * 60_000);
    const m = mentionNotice(cov({ rows: 5, drawn: 2 }), 10, state(place({ startedAt: old })), NOW)!;
    expect(m.text).toContain(`The last rebuild from this map (started ${formatRunTime(old)}) stopped after 2 documents and is too old to continue — a rebuild reads every document again.`);
    expect(m.canRebuild).toBe(true);
    expect("canContinue" in m).toBe(false);
  });

  it("readBackfillPlace: the readings, by state, save time, start time and count", () => {
    expect(readBackfillPlace(null, NOW)).toBeNull();
    expect(readBackfillPlace(place({ state: "running", savedAt: ago(1_000) }), NOW)).toEqual({ kind: "running" });
    expect(readBackfillPlace(place({ state: "running", savedAt: ago(1_000), documents: 0 }), NOW)).toEqual({ kind: "running" });
    expect(readBackfillPlace(place({ state: "running", savedAt: ago(REBUILD_ALIVE_MS + 1) }), NOW)).toEqual({ kind: "continue", why: "cut_off" });
    expect(readBackfillPlace(place({ state: "running", savedAt: null }), NOW)).toEqual({ kind: "continue", why: "cut_off" });
    expect(readBackfillPlace(place({ state: "time_limit" }), NOW)).toEqual({ kind: "continue", why: "time_limit" });
    expect(readBackfillPlace(place({ state: "failed" }), NOW)).toEqual({ kind: "continue", why: "failed" });
    expect(readBackfillPlace(place({ state: "failed", documents: 0 }), NOW)).toEqual({ kind: "none" });
    expect(readBackfillPlace(place({ startedAt: ago(BACKFILL_RESUME_MAX_MS + 1) }), NOW)).toEqual({ kind: "expired" });
    expect(readBackfillPlace(place({ startedAt: null }), NOW)).toEqual({ kind: "expired" });
  });
});

describe("I-23 fix pass — checked writes, and the cap", () => {
  it("SAF-18's census judges lib/mentionRunState.ts: every update is on a `supabase` chain routed through checkedWrite", () => {
    const text = readFileSync(join(process.cwd(), "lib/mentionRunState.ts"), "utf8");
    // The census's own statement rule (lib/__tests__/checkedWrite.test.ts writeSites).
    const sites = [...text.matchAll(/\.(update|delete)\(/g)].map((m) => {
      const at = m.index ?? 0;
      const start = Math.max(text.lastIndexOf(";", at), text.lastIndexOf("{", at)) + 1;
      const end = text.indexOf(";", at);
      return text.slice(start, end < 0 ? text.length : end);
    });
    expect(sites).toHaveLength(4);
    for (const stmt of sites) {
      expect(stmt, stmt).toContain("supabase");
      expect(stmt, stmt).toContain("checkedWrite(");
    }
  });

  it("finishMentionRun answers whether the end landed: a build superseded by a later one is false, and not logged as a refusal", async () => {
    const a = await startMentionRun(admin, ORG, "ingest", "k1");
    const b = await startMentionRun(admin, ORG, "map");
    expect(await finishMentionRun(admin, a, { outcome: "succeeded" })).toBe(false);
    expect(runRow()).toMatchObject({ last_run_id: b.runId, last_run_outcome: "running" });
    expect(await finishMentionRun(admin, b, { outcome: "succeeded" })).toBe(true);
    expect(runRow()).toMatchObject({ last_run_id: b.runId, last_run_outcome: "succeeded" });
    expect(logged.mock.calls.filter((c: unknown[]) => c[0] === "[mentionRunState]")).toEqual([]);
    // A database error on the end is logged, with its code.
    const c = await startMentionRun(admin, ORG, "map");
    db.hooks.push((op) => op.table === RUNS && op.kind === "update" ? { error: { code: "40001", message: "could not serialize access" } } : undefined);
    expect(await finishMentionRun(admin, c, { outcome: "succeeded" })).toBe(false);
    expect(logged).toHaveBeenCalledWith("[mentionRunState]", expect.stringMatching(/^the build's end was not recorded: .*\(40001\)$/));
  });

  it("review minor: the ingest pass waits no longer than its cap for the run state — a slow start, or a slow failure record, never holds the batch", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    db.asyncHooks.push(async (op) => { if (op.table === RUNS && op.kind === "upsert") await gate; });
    const held = <T,>(p: Promise<T>) => Promise.race([p.then(() => "done"), new Promise((r) => setTimeout(() => r("held"), 3_000))]);
    expect(await held(rebuildDocumentMentions({ id: "k1", org_id: ORG, source_document_id: null }, 20))).toBe("done");
    // The build itself went on beside the start.
    await vi.waitFor(() => expect(mentionRows()).toEqual(["k1:a-p101:1"]));
    // A pass that could not start (its dictionary read threw): recorded within the same cap.
    db.hooks.push((op) => { if (op.table === "assets") throw new Error("socket hang up"); });
    expect(await held(rebuildDocumentMentions({ id: "k2", org_id: ORG, source_document_id: null }, 20))).toBe("done");
    release();
    await vi.waitFor(() => expect(runRow()).toMatchObject({ last_failed_source: "ingest", last_failed_document_id: "k2" }));
    await vi.waitFor(() => expect(runRow()).toMatchObject({ last_run_document_id: "k1", last_run_outcome: "succeeded" }));
  });
});
