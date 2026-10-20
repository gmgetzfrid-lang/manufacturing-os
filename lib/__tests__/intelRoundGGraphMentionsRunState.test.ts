// intelligence Round G (I-15) — IRLS-16: POST /api/graph/mentions
// { orgId, documentId } re-indexes one knowledge document; since I-15 that
// build is recorded in the mention index's run state (mention_index_runs,
// 20261194; lib/mentionRunState.ts) exactly as the ingest-time pass records
// its own (lib/knowledgeIngest.ts rebuildDocumentMentions), with source 'map'.
//
// Driven through the REAL route, engine and run-state writer against the
// in-memory database (./knowledgeFakeDb), as the service role:
//   * a failed per-document rebuild is RECORDED (map, the document, plain
//     words) and the route still answers the same 500 it answered before;
//   * a success clears that document's standing failure — and never another
//     document's;
//   * with mention_index_runs absent (20261194 unpasted) the route answers
//     exactly as before and writes nothing.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { db, resetDb, rowsOf, type Row } from "./knowledgeFakeDb";

vi.mock("@/lib/supabaseAdmin", async () => ({ supabaseAdmin: (await import("./knowledgeFakeDb")).fakeAdmin }));

import { NextRequest } from "next/server";
import { POST as mentionsRoute } from "@/app/api/graph/mentions/route";

const ORG = "o1";
const RUNS = "mention_index_runs";
const DOCS = ["k1", "k2", "k3"];

function seed(): void {
  const docs: Row[] = DOCS.map((id) => ({ id, org_id: ORG, status: "ready", name: `${id}.pdf`, source_document_id: null }));
  const chunks: Row[] = DOCS.map((id) => ({
    id: `c-${id}`, org_id: ORG, document_id: id, page: 1, seq: 0, content: `Pump P-101 is checked on the ${id} round.`,
  }));
  resetDb({
    knowledge_documents: docs,
    knowledge_chunks: chunks,
    assets: [{ id: "a-p101", org_id: ORG, tag: "P-101", archived: false }],
    asset_aliases: [],
    entity_mentions: [],
    org_members: [{ id: "m1", org_id: ORG, uid: "u-ctrl", role: "Admin", roles: ["Admin"], status: "active" }],
  });
}

/** A permission failure on the delete that clears the document's earlier mentions. */
function failCleanupOf(doc: string): void {
  db.hooks.push((op, filters) => op.table === "entity_mentions" && op.kind === "delete"
    && filters.some((f) => f.col === "knowledge_document_id" && f.value === doc)
    ? { error: { code: "42501", message: "permission denied for table entity_mentions" } } : undefined);
}

const post = (body: Record<string, unknown>) => mentionsRoute(new NextRequest("http://x/api/graph/mentions", {
  method: "POST", headers: { authorization: "Bearer good", "content-type": "application/json" }, body: JSON.stringify(body),
}));
const runRow = () => rowsOf(RUNS)[0];
const runOps = () => db.ops.filter((o) => o.table === RUNS);
const standing = (documentId: string, at = "2026-10-19T08:00:00.000Z"): Row => ({
  org_id: ORG, last_run_id: "old", last_run_source: "ingest", last_run_document_id: documentId,
  last_run_started_at: at, last_run_finished_at: at, last_run_outcome: "failed",
  last_failed_at: at, last_failed_source: "ingest", last_failed_document_id: documentId,
  last_failed_error: "Clearing the document's earlier links failed: the database refused it (permission denied).",
  backfill_cursor: null, backfill_started_at: null, backfill_documents: null, backfill_state: null,
  backfill_saved_at: null, backfill_dictionary: null,
});

beforeEach(() => {
  seed();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => { vi.restoreAllMocks(); });

describe("IRLS-16 — reproduction: on the base the per-document branch recorded nothing", () => {
  it("the route's documentId branch is wrapped in the run state, as rebuildDocumentMentions is", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("app/api/graph/mentions/route.ts", "utf8");
    const branch = src.slice(src.indexOf("if (body.documentId)"), src.indexOf("const result = await backfillOrgMentions"));
    expect(branch).toMatch(/startMentionRun\(supabaseAdmin, orgId, "map", documentId\)/);
    expect(branch).toMatch(/if \(run\.standingFailure\?\.documentId === documentId\) await clearStandingFailure\(supabaseAdmin, run\);/);
    expect(branch).toMatch(/finishMentionRun\(supabaseAdmin, run, \{ outcome: "succeeded" \}\)/);
    expect(branch).toMatch(/finishMentionRun\(supabaseAdmin, await started, \{ outcome: "failed", error: e \}\);\s*throw e;/);
  });
});

describe("IRLS-16 — a per-document rebuild is recorded", () => {
  it("a failed rebuild is recorded (map, the document, plain words) and the route answers the same 500 as before", async () => {
    failCleanupOf("k2");
    const res = await post({ orgId: ORG, documentId: "k2" });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "mention index cleanup: permission denied for table entity_mentions" });
    expect(runRow()).toMatchObject({
      org_id: ORG,
      last_run_source: "map", last_run_document_id: "k2", last_run_outcome: "failed",
      last_failed_source: "map", last_failed_document_id: "k2",
      last_failed_error: "Clearing the document's earlier links failed: the database refused it (permission denied).",
    });
  });

  it("a success clears THAT document's standing failure and records the build", async () => {
    db.tables[RUNS] = [standing("k2")];
    const res = await post({ orgId: ORG, documentId: "k2" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ documents: 1, incomplete: false });
    expect(runRow()).toMatchObject({
      last_run_source: "map", last_run_document_id: "k2", last_run_outcome: "succeeded",
      last_failed_at: null, last_failed_document_id: null, last_failed_error: null,
    });
    expect(rowsOf("entity_mentions").map((m) => m.knowledge_document_id)).toEqual(["k2"]);
  });

  it("a success never clears ANOTHER document's failure", async () => {
    db.tables[RUNS] = [standing("k3")];
    await post({ orgId: ORG, documentId: "k2" });
    expect(runRow()).toMatchObject({ last_run_outcome: "succeeded", last_failed_document_id: "k3" });
  });

  it("an unknown document is still 404 and records nothing", async () => {
    const res = await post({ orgId: ORG, documentId: "nope" });
    expect(res.status).toBe(404);
    expect(runOps()).toEqual([]);
  });
});

describe("IRLS-16 — regression: with mention_index_runs absent (20261194 unpasted) the route answers exactly as before", () => {
  it("a success answers the same body and writes nothing to the run state", async () => {
    const before = await (await post({ orgId: ORG, documentId: "k2" })).json();
    seed();
    db.missingTables = [RUNS];
    const res = await post({ orgId: ORG, documentId: "k2" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(before);
    expect(rowsOf(RUNS)).toEqual([]);
  });

  it("a failure answers the same 500 and records nothing", async () => {
    db.missingTables = [RUNS];
    failCleanupOf("k2");
    const res = await post({ orgId: ORG, documentId: "k2" });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "mention index cleanup: permission denied for table entity_mentions" });
    expect(rowsOf(RUNS)).toEqual([]);
  });
});
