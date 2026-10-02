// intelligence Round G (I-06) — POST /api/knowledge/ingest, driven through
// the route with a real PDF, the real engine and the in-memory database.
//
//   ING-9  the bytes decide: a renamed spreadsheet is refused on its first
//          batch with a message naming the importer; an upload leaves no row
//          and no object behind (the refusal audited first); a mirrored file
//          is marked, never deleted. A file with no header in its first KB is
//          refused only if pdf.js cannot open it either
//   ING-1  a batch a rev-up superseded that then fails never stamps 'error'
//          on the new revision; an acceptance cannot land on it either
//   ING-2  the loser waits for the claim instead of erroring the document
//   ING-6  failed vision pages are said on the response; a retry that cannot
//          run answers 409 with the reason and never errors the document; a
//          controller can accept the partial index explicitly (audited
//          first, under the claim, so a retry in flight cannot undo it; the
//          Bridge and the mention pass follow, as for any 'ready' document)
//   ING-4  the per-library re-index: a dry run first, the intent audited
//          before anything is reset, bounded, resumable, never twice
//   ING-13 (I-06b) the re-index refuses, before it audits or resets
//          anything, a caller who fails the vision test (lib/ai/aiGates)
//          when the run would re-read AI-vision pages or the library reads
//          every page with AI vision; its leftovers come back structured
//   ADD-1  the controller gate reads the role collection

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { db, resetDb, rowsOf, type Row } from "./knowledgeFakeDb";
import { makePdf, prosePage, drawingSheet } from "./knowledgePdfFixtures";

const r2 = vi.hoisted(() => ({ objects: new Map<string, Uint8Array>(), deleted: [] as string[] }));
vi.mock("@/lib/supabaseAdmin", async () => ({ supabaseAdmin: (await import("./knowledgeFakeDb")).fakeAdmin }));
vi.mock("@/lib/r2", () => ({
  R2_BUCKET: "bucket",
  r2: {
    send: async (cmd: { constructor: { name: string }; input: { Key: string; Range?: string } }) => {
      if (cmd.constructor.name === "DeleteObjectCommand") { r2.deleted.push(cmd.input.Key); return {}; }
      const bytes = r2.objects.get(cmd.input.Key);
      if (!bytes) throw new Error(`NoSuchKey ${cmd.input.Key}`);
      const m = /bytes=(\d+)-(\d+)/.exec(cmd.input.Range ?? "");
      return { Body: m ? bytes.slice(Number(m[1]), Number(m[2]) + 1) : bytes };
    },
  },
}));
vi.mock("@/lib/knowledgeVision", () => ({ transcribePageImage: vi.fn() }));
vi.mock("unpdf", async (orig) => ({
  ...(await orig<typeof import("unpdf")>()),
  renderPageAsImage: vi.fn(async () => new Uint8Array([137, 80, 78, 71]).buffer),
}));
vi.mock("@/lib/equipmentBridgeServer", () => ({ computeForKnowledgeDoc: vi.fn(async () => undefined) }));
vi.mock("@/lib/mentionIndexer", () => ({ loadAliasDictionary: vi.fn(async () => []), indexDocumentMentions: vi.fn(async () => undefined) }));
// The real module underneath (capReached, capIsLocked … for lib/ai/aiGates,
// which the re-index's vision gate runs — ING-13); the ledger reads stubbed.
vi.mock("@/lib/ai/usageServer", async (orig) => ({
  ...(await orig<typeof import("@/lib/ai/usageServer")>()),
  getMonthUsage: vi.fn(async () => ({ spentUsd: 0 })), getCapUsd: vi.fn(async () => 0), recordAskUsage: vi.fn(),
}));
vi.mock("@/lib/aiInstructionsServer", () => ({ loadOrgInstructionsBlock: vi.fn(async () => "") }));
vi.mock("@/lib/ai/keyVault", () => ({ openAiKey: (k: string) => k }));

import { POST } from "@/app/api/knowledge/ingest/route";
import {
  sniffBytes, reindexLibraryChunks, resetKnowledgeIndex, ingestFailureMessage, ingestFailureBackoffMs, visionRetryMessage,
} from "@/lib/knowledgeIngest";
import { computeForKnowledgeDoc } from "@/lib/equipmentBridgeServer";
import { transcribePageImage } from "@/lib/knowledgeVision";
import { getMonthUsage, getCapUsd } from "@/lib/ai/usageServer";
import { AGREEMENT_VERSION } from "@/lib/ai/pricing";

const DOC = "kd-9";
const post = (body: unknown, token = "good") => POST(new NextRequest("http://x/api/knowledge/ingest", {
  method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body),
}));
const KEY = "orgs/o1/knowledge/kl-1/1700000000-equipment-list.pdf";
const docRow = (over: Row = {}): Row => ({
  id: DOC, org_id: "o1", library_id: "kl-1", name: "equipment-list.pdf", file_key: KEY, status: "pending",
  pages_indexed: 0, page_count: null, last_section: null, created_by: "u-ctrl", created_at: "2026-09-30", error: null,
  source_id: null, source_document_id: null, source_version_id: null, source_rev: null,
  vision_pages: 0, empty_pages: 0, vision_failed_pages: [], vision_partial_accepted: false, chunk_version: null,
  vision_retry_after: null, vision_retry_tried: [], ingest_failures: 0, ingest_claimed_by: null, ingest_claimed_at: null, ...over,
});
const seed = (doc: Row, members: Row[] = [{ org_id: "o1", uid: "u-ctrl", role: "Viewer", roles: ["Viewer", "DocCtrl"], status: "active" }]) =>
  resetDb({
    knowledge_documents: [doc], knowledge_chunks: [], knowledge_page_entities: [], org_members: members,
    knowledge_libraries: [{ id: "kl-1", org_id: "o1", ai_features: {} }], ai_connections: [], audit_logs: [],
    // GOV-11 (I-05): page vision also needs the signed agreement — the
    // member here has accepted the current version.
    ai_key_agreements: [{ id: "ag-1", org_id: "o1", user_id: "u-ctrl", scope: "use", agreement_version: AGREEMENT_VERSION }],
  });
const XLSX_HEAD = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00, ...new Array(200).fill(0x41)]);

beforeEach(() => { r2.objects.clear(); r2.deleted = []; });

describe("ING-9 — the server checks the bytes before pdf.js", () => {
  it("classifies by leading bytes", () => {
    expect(sniffBytes(new TextEncoder().encode("%PDF-1.7\n..."))).toBe("pdf");
    expect(sniffBytes(new TextEncoder().encode("﻿junk%PDF-1.4"))).toBe("pdf");
    expect(sniffBytes(XLSX_HEAD)).toBe("office");
    expect(sniffBytes(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]))).toBe("office");
    expect(sniffBytes(new TextEncoder().encode("tag,description,unit\nV-101,Drum,2010\n"))).toBe("text");
    expect(sniffBytes(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]))).toBe("image");
  });

  it("a renamed spreadsheet upload is refused with the importer named, and leaves nothing behind", async () => {
    seed(docRow());
    r2.objects.set(KEY, XLSX_HEAD);
    const res = await post({ documentId: DOC });
    expect(res.status).toBe(415);
    const body = await res.json();
    expect(body.error).toMatch(/^Only PDF files can be indexed — "equipment-list.pdf" is not a PDF \(it looks like an Excel or Word file\)/);
    expect(body.error).toMatch(/open Operating areas and use Import CSV — it takes \.xlsx, \.xls and \.csv/);
    expect(body.error).not.toMatch(/Invalid PDF structure/);
    expect(rowsOf("knowledge_documents")).toHaveLength(0);
    expect(r2.deleted).toEqual([KEY]);
    expect(rowsOf("audit_logs").map((a) => a.action)).toEqual(["KNOWLEDGE_DOC_REJECTED"]);
  });

  it("a mirrored controlled file is marked with the message, never deleted (the object is doc control's)", async () => {
    seed(docRow({ source_id: "src-1", source_document_id: "dc-1", file_key: "orgs/o1/dc/list.pdf" }));
    r2.objects.set("orgs/o1/dc/list.pdf", XLSX_HEAD);
    const res = await post({ documentId: DOC });
    expect(res.status).toBe(415);
    expect(r2.deleted).toEqual([]);
    expect(rowsOf("knowledge_documents")[0]).toMatchObject({ status: "error" });
    expect(String(rowsOf("knowledge_documents")[0].error)).toMatch(/^Only PDF files can be indexed/);
  });

  it("a real PDF passes the sniff and indexes", async () => {
    seed(docRow());
    r2.objects.set(KEY, await makePdf([prosePage("bolting")]));
    const res = await post({ documentId: DOC });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ done: true, busy: false, emptyPagesTotal: 0 });
    expect(rowsOf("knowledge_documents")[0].status).toBe("ready");
  });

  it("a PDF behind a long preamble (no header in its first KB) is still a PDF: pdf.js opens it, and it indexes", async () => {
    seed(docRow());
    const pdf = await makePdf([prosePage("bolting")]);
    const preamble = new TextEncoder().encode("X-Scanner: mail gateway preamble line\r\n".repeat(60));
    const bytes = new Uint8Array(preamble.length + pdf.length);
    bytes.set(preamble); bytes.set(pdf, preamble.length);
    expect(sniffBytes(bytes.subarray(0, 1024))).toBe("text");
    r2.objects.set(KEY, bytes);
    const res = await post({ documentId: DOC });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ done: true });
    expect(rowsOf("knowledge_documents")[0].status).toBe("ready");
    expect(r2.deleted).toEqual([]);
  });

  it("a CSV renamed .pdf (no header, and pdf.js cannot open it) is refused once pdf.js has tried — nothing left behind", async () => {
    seed(docRow());
    r2.objects.set(KEY, new TextEncoder().encode("tag,description,unit\nV-101,Drum,2010\n".repeat(20)));
    const res = await post({ documentId: DOC });
    expect(res.status).toBe(415);
    expect((await res.json()).error).toMatch(/is not a PDF \(it looks like a text or CSV file\)\. To load an equipment list/);
    expect(rowsOf("knowledge_documents")).toHaveLength(0);
    expect(r2.deleted).toEqual([KEY]);
    expect(rowsOf("audit_logs").map((a) => a.action)).toEqual(["KNOWLEDGE_DOC_REJECTED"]);
  });

  it("a damaged file that does carry the PDF header is an indexing failure, not a refusal: nothing is deleted", async () => {
    seed(docRow());
    r2.objects.set(KEY, new TextEncoder().encode("%PDF-1.7\n" + "garbage ".repeat(200)));
    const res = await post({ documentId: DOC });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toMatch(/^Indexing failed: /);
    // No retry can mend a damaged file (ING-8): straight to 'error'.
    expect(body.retryAfter).toBeNull();
    expect(rowsOf("knowledge_documents")[0]).toMatchObject({ status: "error", vision_retry_after: null });
    expect(r2.deleted).toEqual([]);
  });

  it("a refusal that cannot be audited deletes nothing", async () => {
    seed(docRow());
    r2.objects.set(KEY, XLSX_HEAD);
    db.hooks.push((op) => op.table === "audit_logs" && op.kind === "insert"
      ? { error: { code: "42501", message: "permission denied for table audit_logs" } } : undefined);
    const res = await post({ documentId: DOC });
    expect(res.status).toBe(415);
    expect((await res.json()).error).toMatch(/The refusal could not be recorded, so the upload was kept: permission denied/);
    expect(rowsOf("knowledge_documents")).toHaveLength(1);
    expect(r2.deleted).toEqual([]);
  });
});

describe("ING-1 — a failure or an acceptance never lands on a re-pointed revision", () => {
  const REV3 = { source_id: "src-1", source_document_id: "dc-1", source_version_id: "ver-3", source_rev: "3", file_key: "orgs/o1/dc/rev3.pdf" };
  const REV4 = { file_key: "orgs/o1/dc/rev4.pdf", source_version_id: "ver-4", source_rev: "4" };
  const supersede = () => resetKnowledgeIndex([DOC], {
    purgeLineTraces: true, supersedeBusy: true,
    expect: () => ({ source_version_id: "ver-3" }), rowUpdate: () => REV4,
  });

  it("the route: a Rev 3 batch superseded mid-flight that then fails answers 502 — and the Rev 4 row is not marked 'error'", async () => {
    seed(docRow({ ...REV3, status: "stale" }));
    r2.objects.set(REV3.file_key, await makePdf([drawingSheet(1, ["V-101", "P-201A", "E-301"])]));
    let reset: Awaited<ReturnType<typeof resetKnowledgeIndex>> | null = null;
    db.asyncHooks.push(async (op) => {
      if (reset || op.table !== "knowledge_page_entities" || op.kind !== "insert") return;
      reset = await supersede();
    });
    db.hooks.push((op) => op.table === "knowledge_page_entities" && op.kind === "insert"
      ? { error: { code: "08006", message: "connection reset by peer" } } : undefined);
    const res = await post({ documentId: DOC });
    expect(res.status).toBe(502);
    expect(reset).toEqual({ reset: [DOC], busy: [], errors: [] });
    expect(rowsOf("knowledge_documents")[0]).toMatchObject({ status: "stale", error: null, pages_indexed: 0, ...REV4, ingest_claimed_by: null });
    expect(rowsOf("knowledge_chunks")).toHaveLength(0);
  });

  it("accept-partial: a rev-up that re-points the row under the acceptance wins — Rev 4 is never 'ready' with nothing indexed", async () => {
    seed(docRow({ ...REV3, status: "indexing", pages_indexed: 3, page_count: 3, vision_failed_pages: [2] }));
    vi.mocked(computeForKnowledgeDoc).mockClear();
    db.tables.knowledge_chunks = [1, 3].map((p) => ({ id: `c${p}`, document_id: DOC, org_id: "o1", library_id: "kl-1", page: p, seq: 0, content: `rev 3 page ${p}` }));
    let reset: Awaited<ReturnType<typeof resetKnowledgeIndex>> | null = null;
    db.asyncHooks.push(async (op) => {
      if (reset || op.table !== "knowledge_documents" || op.kind !== "update" || (op.payload as Row).vision_partial_accepted !== true) return;
      reset = await supersede();
    });
    const res = await post({ documentId: DOC, action: "accept-partial" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/changed while it was being accepted/);
    expect(reset).toEqual({ reset: [DOC], busy: [], errors: [] });
    expect(rowsOf("knowledge_documents")[0]).toMatchObject({
      status: "stale", pages_indexed: 0, vision_partial_accepted: false, ...REV4, ingest_claimed_by: null,
    });
    expect(vi.mocked(computeForKnowledgeDoc)).not.toHaveBeenCalled();
    // The decision was recorded first, naming the file it was about.
    expect(rowsOf("audit_logs")).toEqual([expect.objectContaining({
      action: "KNOWLEDGE_DOC_PARTIAL_ACCEPTED", details: expect.objectContaining({ fileKey: REV3.file_key, sourceVersionId: "ver-3" }),
    })]);
  });
});

describe("ING-8 — a failed batch is retried automatically, and says when", () => {
  const sheets = [drawingSheet(1, ["V-101", "P-201A", "E-301"]), drawingSheet(2, ["V-102", "P-202A", "E-302"])];

  it("a transient failure answers 502 with when it is retried; the document stays 'indexing' and searchable", async () => {
    seed(docRow({ status: "indexing", pages_indexed: 1, page_count: 2 }));
    db.tables.knowledge_chunks = [{ id: "c1", document_id: DOC, org_id: "o1", library_id: "kl-1", page: 1, seq: 0, content: "sheet 1" }];
    r2.objects.set(KEY, await makePdf(sheets));
    db.hooks.push((op) => op.table === "knowledge_page_entities" && op.kind === "insert"
      ? { error: { code: "08006", message: "connection reset by peer" } } : undefined);
    const res = await post({ documentId: DOC });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toMatch(/^Indexing failed: entity insert failed: connection reset by peer/);
    expect(Date.parse(body.retryAfter)).toBeGreaterThan(Date.now());
    expect(rowsOf("knowledge_documents")[0]).toMatchObject({ status: "indexing", pages_indexed: 1, ingest_failures: 1, vision_retry_after: body.retryAfter });
    expect(rowsOf("knowledge_chunks").map((c) => c.id)).toEqual(["c1"]);

    // The next POST inside the back-off: 409 with the reason, nothing done.
    db.hooks = [];
    const again = await post({ documentId: DOC });
    expect(again.status).toBe(409);
    const blocked = await again.json();
    expect(blocked).toMatchObject({ failureRetryBlocked: true, failureRetryAfter: body.retryAfter });
    expect(blocked.error).toMatch(/^entity insert failed: connection reset by peer — attempt 1 of 3\. Indexing is tried again automatically on the next indexing pass/);
    expect(rowsOf("knowledge_documents")[0]).toMatchObject({ status: "indexing", pages_indexed: 1, ingest_claimed_by: null });
  });
});

describe("ING-8 — a person's explicit re-run (retryNow)", () => {
  const sheets = [drawingSheet(1, ["V-101", "P-201A", "E-301"]), drawingSheet(2, ["V-102", "P-202A", "E-302"])];
  const inBackoff = async (over: Row = {}) => {
    seed(docRow({
      status: "indexing", pages_indexed: 1, page_count: 2, ingest_failures: 1,
      error: "entity insert failed: connection reset by peer — attempt 1 of 3.",
      vision_retry_after: new Date(Date.now() + 600_000).toISOString(), ...over,
    }));
    db.tables.knowledge_chunks = [{ id: "c1", document_id: DOC, org_id: "o1", library_id: "kl-1", page: 1, seq: 0, content: "sheet 1" }];
    r2.objects.set(KEY, await makePdf(sheets));
  };

  it("inside the back-off the indicator's plain POST waits; Resume's retryNow runs the batch at once, audited first", async () => {
    await inBackoff();
    const plain = await post({ documentId: DOC });
    expect(plain.status).toBe(409);
    expect(rowsOf("audit_logs")).toEqual([]);

    const res = await post({ documentId: DOC, retryNow: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ done: true, failureRetryBlocked: false });
    expect(rowsOf("audit_logs").map((a) => a.action)).toEqual(["KNOWLEDGE_DOC_RETRY_NOW", "KNOWLEDGE_DOC_INDEXED"]);
    expect(rowsOf("audit_logs")[0]).toMatchObject({
      resource_id: DOC, user_id: "u-ctrl", org_id: "o1",
      details: expect.objectContaining({ failures: 1, fileKey: KEY, lastError: expect.stringMatching(/^entity insert failed/) }),
    });
    expect(rowsOf("knowledge_documents")[0]).toMatchObject({ status: "ready", ingest_failures: 0, error: null, vision_retry_after: null });
  });

  it("a re-run that cannot be recorded runs nothing", async () => {
    await inBackoff();
    db.hooks.push((op) => op.table === "audit_logs" && op.kind === "insert"
      ? { error: { code: "42501", message: "permission denied for table audit_logs" } } : undefined);
    const res = await post({ documentId: DOC, retryNow: true });
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/The re-run could not be recorded, so nothing was run: permission denied/);
    expect(rowsOf("knowledge_documents")[0]).toMatchObject({ status: "indexing", pages_indexed: 1, ingest_failures: 1, ingest_claimed_by: null });
  });

  // The main pass is through and page 1 waits on AI vision; the person
  // re-running it has a key.
  const atRetryStage = async (over: Row) => {
    seed(docRow({ status: "indexing", pages_indexed: 2, page_count: 2, vision_failed_pages: [1], ...over }));
    db.tables.knowledge_chunks = [{ id: "c2", document_id: DOC, org_id: "o1", library_id: "kl-1", page: 2, seq: 0, content: "sheet 2" }];
    db.tables.ai_connections = [{ org_id: "o1", user_id: "u-ctrl", provider: "anthropic", model: "user-model", api_key: "k" }];
    r2.objects.set(KEY, await makePdf([null, drawingSheet(2, ["V-102", "P-202A", "E-302"])]));
    vi.mocked(transcribePageImage).mockReset();
    vi.mocked(transcribePageImage).mockImplementation(async () => ({
      text: "DRAWING NO: 025-PID-0101\nSHEET: 1 OF 2\nREV: 4\nV-101 SUCTION DRUM\nP-201A CHARGE PUMP\nE-301 FEED EXCHANGER\n",
      usage: { inputTokens: 1, outputTokens: 1 }, model: "user-model",
    }));
  };

  it("a failed vision-retry batch: Resume's retryNow performs the retry, audited first — never recorded and then refused", async () => {
    // The reviewer's probe R1: the retry batch read page 1, then its chunk
    // insert failed, and markIngestFailed stamped the back-off on the column
    // the vision-retry gate reads. The re-run used to be audited, then
    // answered 409 by that gate with no vision call.
    await atRetryStage({
      ingest_failures: 1,
      error: ingestFailureMessage("chunk insert failed: connection reset by peer", 1, ingestFailureBackoffMs(1), true),
      vision_retry_after: new Date(Date.now() + 600_000).toISOString(),
    });
    const plain = await post({ documentId: DOC });
    expect(plain.status).toBe(409);
    expect(await plain.json()).toMatchObject({ failureRetryBlocked: true, visionRetryBlocked: false });
    expect(vi.mocked(transcribePageImage)).not.toHaveBeenCalled();
    expect(rowsOf("audit_logs")).toEqual([]);

    const res = await post({ documentId: DOC, retryNow: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ done: true, visionRetryBlocked: false, failureRetryBlocked: false, visionFailedPages: [] });
    expect(vi.mocked(transcribePageImage)).toHaveBeenCalledTimes(1);
    expect(rowsOf("audit_logs").map((a) => a.action)).toEqual(["KNOWLEDGE_DOC_RETRY_NOW", "KNOWLEDGE_DOC_INDEXED"]);
    expect(rowsOf("knowledge_documents")[0]).toMatchObject({ status: "ready", ingest_failures: 0, error: null, vision_retry_after: null, vision_failed_pages: [] });
  });

  it("a vision retry's own back-off is not a failed batch's: retryNow records nothing and answers 409 with the vision reason", async () => {
    // A retry pass that read nothing (no page left this round) keeps an
    // earlier failure's count but writes the vision retry's reason and its
    // round back-off. That stamp is not the failed batch's: nothing is let
    // through, so nothing is recorded.
    const reason = visionRetryMessage([1], "provider 529 overloaded");
    await atRetryStage({ ingest_failures: 1, error: reason, vision_retry_after: new Date(Date.now() + 1_800_000).toISOString() });
    const res = await post({ documentId: DOC, retryNow: true });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ visionRetryBlocked: true, failureRetryBlocked: false, error: reason });
    expect(rowsOf("audit_logs")).toEqual([]);
    expect(vi.mocked(transcribePageImage)).not.toHaveBeenCalled();
    expect(rowsOf("knowledge_documents")[0]).toMatchObject({ status: "indexing", ingest_failures: 1, ingest_claimed_by: null });
  });

  it("a controller with no usable key re-running a failed vision-retry batch: 409 with the reason, nothing recorded, and the failure's record stays on the row", async () => {
    // The reviewer's probe K1: the re-run was audited, then the engine parked
    // it — the keyless message over the failure's cause, its back-off erased
    // to now — and answered 409: recorded, and then refused.
    const until = new Date(Date.now() + 600_000).toISOString();
    const error = ingestFailureMessage("chunk insert failed: connection reset by peer", 1, ingestFailureBackoffMs(1), true);
    await atRetryStage({ ingest_failures: 1, error, vision_retry_after: until });
    const failureRecord = { status: "indexing", ingest_failures: 1, error, vision_retry_after: until, vision_failed_pages: [1], ingest_claimed_by: null };

    // No AI key at all.
    db.tables.ai_connections = [];
    const keyless = await post({ documentId: DOC, retryNow: true });
    expect(keyless.status).toBe(409);
    const kb = await keyless.json();
    expect(kb).toMatchObject({ failureRetryBlocked: true, visionRetryBlocked: false, failureRetryAfter: until });
    expect(kb.error).toBe(visionRetryMessage([1], null));
    expect(kb.visionSkipReason).toMatch(/^Add your AI key in AI settings/);
    expect(rowsOf("audit_logs")).toEqual([]);
    expect(rowsOf("knowledge_documents")[0]).toMatchObject(failureRecord);

    // A key, at its monthly cap: the same.
    db.tables.ai_connections = [{ org_id: "o1", user_id: "u-ctrl", provider: "anthropic", model: "user-model", api_key: "k" }];
    vi.mocked(getCapUsd).mockResolvedValueOnce(5);
    vi.mocked(getMonthUsage).mockResolvedValueOnce({ spentUsd: 5 } as Awaited<ReturnType<typeof getMonthUsage>>);
    const capped = await post({ documentId: DOC, retryNow: true });
    expect(capped.status).toBe(409);
    const cb = await capped.json();
    expect(cb).toMatchObject({ failureRetryBlocked: true, failureRetryAfter: until });
    expect(cb.visionSkipReason).toMatch(/^Monthly AI budget reached/);
    expect(rowsOf("audit_logs")).toEqual([]);
    expect(rowsOf("knowledge_documents")[0]).toMatchObject(failureRecord);
    expect(vi.mocked(transcribePageImage)).not.toHaveBeenCalled();
  });

  it("a re-run that meets `busy` is not recorded while it waits: only the batch that takes the claim records it, then runs", async () => {
    await inBackoff({ ingest_claimed_by: "ingest:other-tab", ingest_claimed_at: new Date().toISOString() });
    let recordedWhileBusy: number | null = null;
    // The other tab's batch lets go shortly after this POST arrives.
    setTimeout(() => {
      recordedWhileBusy = rowsOf("audit_logs").length;
      Object.assign(rowsOf("knowledge_documents")[0], { ingest_claimed_by: null, ingest_claimed_at: null });
    }, 200);
    const res = await post({ documentId: DOC, retryNow: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ done: true, busy: false });
    expect(recordedWhileBusy).toBe(0);
    expect(rowsOf("audit_logs").map((a) => a.action)).toEqual(["KNOWLEDGE_DOC_RETRY_NOW", "KNOWLEDGE_DOC_INDEXED"]);
  }, 20_000);

  it("with no back-off in force it is an ordinary batch — nothing is recorded — and it stays a controller's action", async () => {
    await inBackoff({ ingest_failures: 0, error: null, vision_retry_after: null });
    const viewer = await post({ documentId: DOC, retryNow: true }, "viewer");
    expect(viewer.status).toBe(403);
    const res = await post({ documentId: DOC, retryNow: true });
    expect(res.status).toBe(200);
    expect(rowsOf("audit_logs").map((a) => a.action)).toEqual(["KNOWLEDGE_DOC_INDEXED"]);
  });
});

describe("ING-2 — the loser waits", () => {
  it("a POST that finds the claim held waits for it, then does the batch", async () => {
    seed(docRow({ status: "indexing", ingest_claimed_by: "ingest:other-tab", ingest_claimed_at: new Date().toISOString() }));
    r2.objects.set(KEY, await makePdf([prosePage("bolting")]));
    // The other tab's batch finishes shortly after this POST arrives.
    setTimeout(() => { Object.assign(rowsOf("knowledge_documents")[0], { ingest_claimed_by: null, ingest_claimed_at: null }); }, 200);
    const res = await post({ documentId: DOC });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ done: true, busy: false });
    expect(rowsOf("knowledge_documents")[0]).toMatchObject({ status: "ready", error: null });
  }, 20_000);
});

describe("ING-6 — failed vision pages on the response, and the explicit way out", () => {
  it("accept-partial: a controller makes the document ready with the unread pages still listed, audited", async () => {
    seed(docRow({ status: "indexing", pages_indexed: 3, page_count: 3, vision_failed_pages: [2] }));
    const res = await post({ documentId: DOC, action: "accept-partial" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, acceptedPages: [2] });
    expect(rowsOf("knowledge_documents")[0]).toMatchObject({ status: "ready", vision_partial_accepted: true, vision_failed_pages: [2] });
    expect(rowsOf("audit_logs").map((a) => a.action)).toEqual(["KNOWLEDGE_DOC_PARTIAL_ACCEPTED", "KNOWLEDGE_DOC_INDEXED"]);
  });

  it("a keyless controller's POST on a document awaiting a vision retry: 409 with the reason; the document stays 'indexing' and searchable", async () => {
    // Controller B has no AI key; the app-shell indicator drives every
    // 'indexing' document. It used to throw, and the route wrote 'error' —
    // dropping the whole document out of Ask.
    seed(docRow({ status: "indexing", pages_indexed: 2, page_count: 2, vision_failed_pages: [1] }));
    db.tables.knowledge_chunks = [{ id: "c-2", document_id: DOC, org_id: "o1", library_id: "kl-1", page: 2, seq: 0, content: "bolting text" }];
    const res = await post({ documentId: DOC });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/AI vision could not read 1 page \(p\. 1\), and retrying needs an AI key/);
    expect(body).toMatchObject({ visionRetryBlocked: true, done: false });
    expect(rowsOf("knowledge_documents")[0]).toMatchObject({ status: "indexing", pages_indexed: 2, ingest_claimed_by: null });
    expect(String(rowsOf("knowledge_documents")[0].error)).toBe(body.error);
    expect(rowsOf("knowledge_chunks")).toHaveLength(1);
  });

  it("accept-partial takes the claim: refused while a retry batch holds it, and nothing is written", async () => {
    seed(docRow({
      status: "indexing", pages_indexed: 3, page_count: 3, vision_failed_pages: [2],
      ingest_claimed_by: "ingest:retry", ingest_claimed_at: new Date().toISOString(),
    }));
    const res = await post({ documentId: DOC, action: "accept-partial" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/being indexed right now/);
    expect(rowsOf("knowledge_documents")[0]).toMatchObject({ status: "indexing", vision_partial_accepted: false, ingest_claimed_by: "ingest:retry" });
    expect(rowsOf("audit_logs")).toHaveLength(0);
  });

  it("an accepted partial index is not undone by a batch that runs afterwards; its mentions are rebuilt and it feeds the Bridge", async () => {
    seed(docRow({ status: "indexing", pages_indexed: 3, page_count: 3, vision_failed_pages: [2], vision_retry_after: new Date(Date.now() + 60_000).toISOString() }));
    const { loadAliasDictionary, indexDocumentMentions } = await import("@/lib/mentionIndexer");
    vi.mocked(loadAliasDictionary).mockResolvedValueOnce([{ assetId: "a1", alias: "V-101", origin: "tag" }]);
    vi.mocked(computeForKnowledgeDoc).mockClear();
    const res = await post({ documentId: DOC, action: "accept-partial" });
    expect(res.status).toBe(200);
    // The equipment Bridge, as for a document the engine completed.
    await vi.waitFor(() => expect(vi.mocked(computeForKnowledgeDoc)).toHaveBeenCalledWith(expect.anything(), DOC));
    expect(rowsOf("knowledge_documents")[0]).toMatchObject({
      status: "ready", vision_partial_accepted: true, vision_retry_after: null, ingest_claimed_by: null,
    });
    expect(vi.mocked(indexDocumentMentions)).toHaveBeenCalledWith("o1", DOC, [{ assetId: "a1", alias: "V-101", origin: "tag" }], null);
    // A late driver finds it 'ready' and writes nothing back.
    r2.objects.set(KEY, await makePdf([prosePage("a"), null, prosePage("c")]));
    const late = await post({ documentId: DOC });
    expect(await late.json()).toMatchObject({ done: true });
    expect(rowsOf("knowledge_documents")[0]).toMatchObject({ status: "ready", vision_partial_accepted: true });
  });

  it("an acceptance that cannot be audited changes nothing", async () => {
    seed(docRow({ status: "indexing", pages_indexed: 3, page_count: 3, vision_failed_pages: [2] }));
    db.hooks.push((op) => op.table === "audit_logs" && op.kind === "insert"
      ? { error: { code: "42501", message: "permission denied for table audit_logs" } } : undefined);
    const res = await post({ documentId: DOC, action: "accept-partial" });
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/could not be recorded, so nothing was changed/);
    expect(rowsOf("knowledge_documents")[0]).toMatchObject({ status: "indexing", vision_partial_accepted: false, ingest_claimed_by: null });
  });

  it("accept-partial on a document already accepted is refused: no second audit row, no second Bridge pass", async () => {
    seed(docRow({ status: "indexing", pages_indexed: 3, page_count: 3, vision_failed_pages: [2] }));
    expect((await post({ documentId: DOC, action: "accept-partial" })).status).toBe(200);
    vi.mocked(computeForKnowledgeDoc).mockClear();
    const again = await post({ documentId: DOC, action: "accept-partial" });
    expect(again.status).toBe(409);
    expect((await again.json()).error).toMatch(/already accepted/);
    expect(rowsOf("audit_logs").map((a) => a.action)).toEqual(["KNOWLEDGE_DOC_PARTIAL_ACCEPTED", "KNOWLEDGE_DOC_INDEXED"]);
    await new Promise((r) => setTimeout(r, 10));
    expect(vi.mocked(computeForKnowledgeDoc)).not.toHaveBeenCalled();
    expect(rowsOf("knowledge_documents")[0]).toMatchObject({ status: "ready", vision_partial_accepted: true, ingest_claimed_by: null });
  });

  it("accept-partial refuses when nothing waits, or indexing has not finished", async () => {
    seed(docRow({ status: "indexing", pages_indexed: 3, page_count: 3 }));
    expect((await post({ documentId: DOC, action: "accept-partial" })).status).toBe(409);
    seed(docRow({ status: "indexing", pages_indexed: 1, page_count: 3, vision_failed_pages: [1] }));
    expect((await post({ documentId: DOC, action: "accept-partial" })).status).toBe(409);
  });

  it("a member without a controller role in the collection is refused", async () => {
    seed(docRow({ pages_indexed: 3, page_count: 3, vision_failed_pages: [2] }), [{ org_id: "o1", uid: "u-viewer", role: "Viewer", roles: ["Viewer"], status: "active" }]);
    const res = await post({ documentId: DOC, action: "accept-partial" }, "viewer");
    expect(res.status).toBe(403);
    expect(rowsOf("knowledge_documents")[0].vision_partial_accepted).toBe(false);
  });

  it("on a database without 20261122 the note does not promise a retry: the page was indexed with its text layer only", async () => {
    seed(docRow());
    const legacyCols = ["ingest_claimed_by", "ingest_claimed_at", "empty_pages", "vision_failed_pages", "vision_partial_accepted", "chunk_version", "vision_retry_after", "vision_retry_tried", "ingest_failures"];
    db.missingColumns.knowledge_documents = legacyCols;
    db.tables.knowledge_documents = [Object.fromEntries(Object.entries(docRow()).filter(([k]) => !legacyCols.includes(k)))];
    r2.objects.set(KEY, await makePdf([null, prosePage("bolting")]));
    db.tables.ai_connections = [{ org_id: "o1", user_id: "u-ctrl", provider: "anthropic", model: "m", api_key: "k" }];
    const { transcribePageImage } = await import("@/lib/knowledgeVision");
    vi.mocked(transcribePageImage).mockRejectedValueOnce(new Error("provider 529 overloaded"));
    const body = await (await post({ documentId: DOC })).json();
    expect(body).toMatchObject({ legacy: true, visionFailedPages: [1] });
    expect(body.visionSkipReason).toMatch(/1 page could not be read by AI vision \(provider 529 overloaded\) — indexed with the text layer only: this database cannot hold them for a retry/);
    expect(body.visionSkipReason).not.toMatch(/retried automatically/);
  });

  it("the response says how many pages AI vision could not read", async () => {
    seed(docRow());
    r2.objects.set(KEY, await makePdf([null, prosePage("bolting")]));
    db.tables.ai_connections = [{ org_id: "o1", user_id: "u-ctrl", provider: "anthropic", model: "m", api_key: "k" }];
    const { transcribePageImage } = await import("@/lib/knowledgeVision");
    vi.mocked(transcribePageImage).mockRejectedValueOnce(new Error("provider 529 overloaded"));
    const res = await post({ documentId: DOC });
    const body = await res.json();
    expect(body).toMatchObject({ done: false, visionFailedPages: [1] });
    expect(body.visionSkipReason).toMatch(/1 page could not be read by AI vision \(provider 529 overloaded\) — retried automatically/);
    expect(rowsOf("knowledge_documents")[0]).toMatchObject({ status: "indexing", vision_failed_pages: [1] });
  });
});

describe("ING-4 / ING-7 — 'Re-index with table-aware chunking' is an explicit per-library action", () => {
  // The library's documents hold AI-vision pages, so the run re-reads them:
  // the controller running it has a key the ingest path can read with — a
  // saved connection on an allowed provider, the signed agreement (seed),
  // under the monthly cap (ING-13; a keyless controller is refused below).
  const library = () => {
    seed(docRow({ status: "ready", pages_indexed: 3, page_count: 3, vision_pages: 2, chunk_version: 1 }));
    db.tables.knowledge_documents.push(docRow({ id: "kd-10", status: "ready", pages_indexed: 1, page_count: 1, vision_pages: 1 }));
    db.tables.knowledge_libraries = [{ id: "kl-1", org_id: "o1", name: "Standards", chunk_version: 1 }];
    db.tables.knowledge_chunks = [{ id: "c1", document_id: DOC, org_id: "o1", library_id: "kl-1", page: 1, seq: 0, content: "old" }];
    db.tables.entity_mentions = [];
    db.tables.ai_connections = [{ org_id: "o1", user_id: "u-ctrl", provider: "anthropic", model: "m", api_key: "k" }];
  };
  beforeEach(() => { vi.mocked(getCapUsd).mockImplementation(async () => 10); });
  afterEach(() => { vi.mocked(getCapUsd).mockImplementation(async () => 0); });

  it("a dry run says what the re-index would reset and re-bill — before anything is changed", async () => {
    library();
    const res = await post({ action: "reindex", libraryId: "kl-1", chunker: 2, dryRun: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, dryRun: true, chunker: 2, documents: 2, toReset: 2, visionPagesToReread: 3, keylessHolds: true });
    expect(db.tables.knowledge_libraries[0].chunk_version).toBe(1);
    expect(rowsOf("knowledge_chunks")).toHaveLength(1);
    expect(rowsOf("knowledge_documents").every((d) => d.status === "ready")).toBe(true);
    expect(rowsOf("audit_logs")).toHaveLength(0);
  });

  it("a controller switches the library to chunker 2: the intent is audited first, then every document resets", async () => {
    library();
    const res = await post({ action: "reindex", libraryId: "kl-1", chunker: 2 });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, chunker: 2, reset: 2, busy: 0, toReset: 2, visionPagesToReread: 3, remaining: 0 });
    expect(db.tables.knowledge_libraries[0].chunk_version).toBe(2);
    expect(rowsOf("knowledge_chunks")).toHaveLength(0);
    for (const d of rowsOf("knowledge_documents")) {
      expect(d).toMatchObject({ status: "stale", pages_indexed: 0, vision_pages: 0, chunk_version: null });
    }
    expect(rowsOf("audit_logs")).toEqual([expect.objectContaining({
      action: "KNOWLEDGE_LIBRARY_REINDEXED",
      details: expect.objectContaining({ chunker: 2, toReset: 2, visionPagesToReread: 3 }),
    })]);
    // The audit row precedes the first change of any kind.
    const at = (pred: (o: (typeof db.ops)[number]) => boolean) => db.ops.findIndex(pred);
    const audit = at((o) => o.table === "audit_logs" && o.kind === "insert");
    const flip = at((o) => o.table === "knowledge_libraries" && o.kind === "update");
    const firstReset = at((o) => o.table === "knowledge_documents" && o.kind === "update");
    expect(audit).toBeGreaterThan(-1);
    expect(audit).toBeLessThan(flip);
    expect(flip).toBeLessThan(firstReset);

    // Run again: every document is already queued for chunker 2 — nothing
    // is reset twice, nothing re-billed.
    const again = await (await post({ action: "reindex", libraryId: "kl-1", chunker: 2 })).json();
    expect(again).toMatchObject({ reset: 0, toReset: 0, visionPagesToReread: 0, remaining: 0 });
  });

  it("a run that cannot record its intent changes nothing", async () => {
    library();
    db.hooks.push((op) => op.table === "audit_logs" && op.kind === "insert"
      ? { error: { code: "42501", message: "permission denied for table audit_logs" } } : undefined);
    const res = await post({ action: "reindex", libraryId: "kl-1", chunker: 2 });
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/could not be recorded, so nothing was changed/);
    expect(db.tables.knowledge_libraries[0].chunk_version).toBe(1);
    expect(rowsOf("knowledge_chunks")).toHaveLength(1);
  });

  it("a document mid-batch is reported busy, not reset under its batch — and the next run picks it up", async () => {
    library();
    Object.assign(rowsOf("knowledge_documents")[1], { status: "indexing", ingest_claimed_by: "ingest:x", ingest_claimed_at: new Date().toISOString() });
    const body = await (await post({ action: "reindex", libraryId: "kl-1", chunker: 2 })).json();
    expect(body).toMatchObject({ reset: 1, busy: 1, remaining: 1 });
    expect(rowsOf("knowledge_documents")[1]).toMatchObject({ status: "indexing", pages_indexed: 1 });
    Object.assign(rowsOf("knowledge_documents")[1], { ingest_claimed_by: null, ingest_claimed_at: null });
    const next = await (await post({ action: "reindex", libraryId: "kl-1", chunker: 2 })).json();
    expect(next).toMatchObject({ reset: 1, busy: 0, toReset: 1, visionPagesToReread: 1, remaining: 0 });
    expect(rowsOf("knowledge_documents")[1]).toMatchObject({ status: "stale", pages_indexed: 0 });
  });

  it("bounded by a deadline: it stops between documents and says how many remain", async () => {
    library();
    const out = await reindexLibraryChunks("kl-1", 2, { deadlineMs: Date.now() - 1 });
    expect(out).toMatchObject({ toReset: 2, remaining: 2, reset: [] });
    expect(db.tables.knowledge_libraries[0].chunk_version).toBe(2);
    expect(rowsOf("knowledge_documents").every((d) => d.status === "ready")).toBe(true);
    const rest = await reindexLibraryChunks("kl-1", 2, {});
    expect(rest).toMatchObject({ toReset: 2, remaining: 0 });
    expect(rest.reset).toHaveLength(2);
  });

  it("refuses a non-controller, an unknown chunker and an unknown library", async () => {
    library();
    db.tables.org_members.push({ org_id: "o1", uid: "u-viewer", role: "Viewer", roles: ["Viewer"], status: "active" });
    expect((await post({ action: "reindex", libraryId: "kl-1", chunker: 2 }, "viewer")).status).toBe(403);
    expect((await post({ action: "reindex", libraryId: "kl-1", chunker: 3 })).status).toBe(400);
    expect((await post({ action: "reindex", libraryId: "nope", chunker: 2 })).status).toBe(404);
    expect(db.tables.knowledge_libraries[0].chunk_version).toBe(1);
    expect(rowsOf("knowledge_chunks")).toHaveLength(1);
  });

  it("a database without 20261122 is told which migration to apply", async () => {
    library();
    db.missingColumns.knowledge_libraries = ["chunk_version"];
    const res = await post({ action: "reindex", libraryId: "kl-1", chunker: 2 });
    expect(res.status).toBe(424);
    expect((await res.json()).error).toMatch(/needs migration 20261122_intel_roundG_ingest_integrity\.sql/);
    expect(rowsOf("knowledge_chunks")).toHaveLength(1);
  });
});

describe("ING-13 (I-06b) — the re-index's vision gate is the server's, before anything is audited or reset", () => {
  // One document, read last time with AI vision on two of its pages (the dry
  // run counts them), in a library that may or may not read every page.
  const library = (over: { visionPages?: number; visionAllPages?: boolean } = {}) => {
    seed(docRow({ status: "ready", pages_indexed: 3, page_count: 3, vision_pages: over.visionPages ?? 2, chunk_version: 1 }));
    db.tables.knowledge_libraries = [{
      id: "kl-1", org_id: "o1", name: "P&IDs", chunk_version: 1,
      ai_features: over.visionAllPages ? { visionAllPages: true } : {},
    }];
    db.tables.knowledge_chunks = [{ id: "c1", document_id: DOC, org_id: "o1", library_id: "kl-1", page: 1, seq: 0, content: "old" }];
    db.tables.entity_mentions = [];
  };
  const keyed = () => { db.tables.ai_connections = [{ org_id: "o1", user_id: "u-ctrl", provider: "anthropic", model: "m", api_key: "k" }]; };
  const reindex = () => post({ action: "reindex", libraryId: "kl-1", chunker: 2 });
  /** Nothing audited, the library's choice and every document as they were. */
  const untouched = () => {
    expect(rowsOf("audit_logs")).toEqual([]);
    expect(db.tables.knowledge_libraries[0].chunk_version).toBe(1);
    expect(rowsOf("knowledge_chunks")).toHaveLength(1);
    expect(rowsOf("knowledge_documents")[0]).toMatchObject({ status: "ready", pages_indexed: 3, chunk_version: 1 });
    expect(db.ops.some((o) => o.table === "knowledge_documents" && o.kind === "update")).toBe(false);
  };
  beforeEach(() => { vi.mocked(getCapUsd).mockImplementation(async () => 10); });
  afterEach(() => {
    vi.mocked(getCapUsd).mockImplementation(async () => 0);
    vi.mocked(getMonthUsage).mockImplementation(async () => ({ spentUsd: 0 }) as Awaited<ReturnType<typeof getMonthUsage>>);
  });

  it("the record's reproduction: a keyless controller's run that would re-read AI-vision pages answers 409 — nothing audited, nothing reset", async () => {
    library();
    const res = await reindex();
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toMatchObject({ visionRequired: true, gateStatus: 412, toReset: 1, visionPagesToReread: 2 });
    expect(body.error).toMatch(/^Nothing was reset\. This re-index reads 2 pages AI vision read before again, /);
    expect(body.error).toMatch(/Add your Claude or OpenAI key in AI settings first/);
    untouched();
  });

  it("a library that reads every page with AI vision is refused for a keyless controller even with no AI-vision page counted", async () => {
    library({ visionPages: 0, visionAllPages: true });
    const res = await reindex();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/^Nothing was reset\. This library reads every page with AI vision, /);
    untouched();
  });

  it("a library AI vision does not read: the keyless controller's run goes ahead exactly as before", async () => {
    library({ visionPages: 0 });
    const res = await reindex();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, reset: 1, toReset: 1, visionPagesToReread: 0, remaining: 0 });
    expect(rowsOf("knowledge_documents")[0]).toMatchObject({ status: "stale", pages_indexed: 0 });
    expect(rowsOf("audit_logs").map((a) => a.action)).toEqual(["KNOWLEDGE_LIBRARY_REINDEXED"]);
  });

  it("a controller whose key can read runs it — audited first, then reset", async () => {
    library(); keyed();
    const res = await reindex();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, reset: 1, visionPagesToReread: 2, remaining: 0 });
    expect(rowsOf("audit_logs").map((a) => a.action)).toEqual(["KNOWLEDGE_LIBRARY_REINDEXED"]);
    expect(rowsOf("knowledge_documents")[0]).toMatchObject({ status: "stale", pages_indexed: 0 });
  });

  it("a key at its monthly cap, or locked at $0, is refused with the cap's own sentence", async () => {
    library(); keyed();
    vi.mocked(getMonthUsage).mockImplementation(async () => ({ spentUsd: 10 }) as Awaited<ReturnType<typeof getMonthUsage>>);
    let res = await reindex();
    expect(res.status).toBe(409);
    let body = await res.json();
    expect(body).toMatchObject({ visionRequired: true, gateStatus: 402 });
    expect(body.error).toMatch(/Monthly AI budget reached \(\$10\.00 of \$10\.00\)/);
    untouched();

    vi.mocked(getMonthUsage).mockImplementation(async () => ({ spentUsd: 0 }) as Awaited<ReturnType<typeof getMonthUsage>>);
    vi.mocked(getCapUsd).mockImplementation(async () => Number.MIN_VALUE);
    res = await reindex();
    expect(res.status).toBe(409);
    body = await res.json();
    expect(body).toMatchObject({ gateStatus: 402, locked: true });
    expect(body.error).toMatch(/Your monthly AI cap is set to \$0, so AI is locked for you/);
    untouched();
  });

  it("an unsigned agreement is refused, carrying the agreement to sign so a client can prompt", async () => {
    library(); keyed();
    db.tables.ai_key_agreements = [];
    const res = await reindex();
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toMatchObject({ gateStatus: 428, agreementRequired: true, agreementVersion: AGREEMENT_VERSION });
    expect(String(body.agreementText)).not.toBe("");
    expect(body.error).toMatch(/Accept the AI acceptable-use agreement first/);
    untouched();
  });

  it("a ledger that cannot be read refuses the run (GOV-4) — never a 500, nothing reset", async () => {
    library(); keyed();
    const { AiUsageUnavailableError } = await import("@/lib/ai/usageServer");
    vi.mocked(getCapUsd).mockImplementation(async () => { throw new AiUsageUnavailableError("statement timeout"); });
    const res = await reindex();
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toMatchObject({ gateStatus: 503 });
    expect(body.error).toMatch(/AI usage can't be read right now/);
    untouched();
  });

  it("the dry run changes nothing and answers as before, whoever asks — and says whether a keyless driver would hold the AI-vision pages (20261162)", async () => {
    library();
    const res = await post({ action: "reindex", libraryId: "kl-1", chunker: 2, dryRun: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, dryRun: true, chunker: 2, documents: 1, toReset: 1, visionPagesToReread: 2, keylessHolds: true });
    untouched();
    // A database without 20261162: a keyless driver indexes them text-only, and the plan says so.
    db.missingColumns.knowledge_documents = ["vision_owed_pages"];
    const before = await (await post({ action: "reindex", libraryId: "kl-1", chunker: 2, dryRun: true })).json();
    expect(before).toMatchObject({ toReset: 1, visionPagesToReread: 2, keylessHolds: false });
    untouched();
  });

  it("a document reset with part of its old index left comes back structured, by id, beside errors (which keep the message for an older client)", async () => {
    library(); keyed();
    db.hooks.push((op) => op.table === "knowledge_chunks" && op.kind === "delete"
      ? { error: { code: "57014", message: "canceling statement due to statement timeout" } } : undefined);
    const res = await reindex();
    expect(res.status).toBe(207);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, reset: 1, remaining: 0 });
    expect(body.leftovers).toEqual([{
      documentId: DOC,
      left: ["chunks: canceling statement due to statement timeout"],
      message: `${DOC}: chunks: canceling statement due to statement timeout (the row is queued; the re-index's first batch clears what is left)`,
    }]);
    expect(body.errors).toEqual([body.leftovers[0].message]);
  });

  // Review fix pass: the hold reaches the existing corpus, and the answer of
  // a batch with no vision context says where the held pages are.
  const WAITS = "1 page waits for AI vision on the document — it is not marked ready until that page is read or the partial index is accepted.";
  /** A three-page document (its middle page has no text layer) the last
   *  generation read page 2 of with AI vision; `provenance` false: indexed
   *  before chunks said how their text was read (every chunk 'text'). */
  const readBefore = async (provenance: boolean) => {
    seed(docRow({ status: "ready", pages_indexed: 3, page_count: 3, vision_pages: 1, chunk_version: 1, vision_owed_pages: [] }));
    db.tables.knowledge_libraries = [{ id: "kl-1", org_id: "o1", name: "P&IDs", chunk_version: 1, ai_features: {} }];
    db.tables.knowledge_chunks = [1, 2, 3].map((page) => ({
      id: `c${page}`, document_id: DOC, org_id: "o1", library_id: "kl-1", page, seq: 0, content: `page ${page}`,
      source: provenance && page === 2 ? "vision" : "text",
    }));
    db.tables.entity_mentions = [];
    r2.objects.set(KEY, await makePdf([prosePage("scope"), null, prosePage("bolting")]));
  };

  it("the review's reproduction: a keyed controller re-indexes a library indexed before chunks said how they were read; a keyless driver then holds the page that needs AI vision — never 'ready' text-only — and its answer says the page waits", async () => {
    await readBefore(false);
    keyed();
    expect((await reindex()).status).toBe(200);
    expect(rowsOf("knowledge_documents")[0]).toMatchObject({ status: "stale", vision_owed_pages: [0] });

    // A keyless colleague's app-shell indicator reaches the document first.
    db.tables.ai_connections = [];
    const reads = vi.mocked(transcribePageImage).mock.calls.length;
    const res = await post({ documentId: DOC });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ done: false, visionFailedPages: [2], visionHeldPages: 1, visionPages: 0 });
    expect(body.visionSkipReason).toBe(`Add your AI key in AI settings to read pages that have no text layer. ${WAITS}`);
    expect(body.visionSkipReason).not.toMatch(/retried automatically|could not be read by AI vision/);
    expect(rowsOf("knowledge_documents")[0]).toMatchObject({ status: "indexing", vision_failed_pages: [2], error: null });
    expect(vi.mocked(transcribePageImage).mock.calls.length).toBe(reads);
  });

  it("a member at their monthly cap: the page held for AI vision is said to wait — never 'indexed from its text layer only', never 'retried automatically'", async () => {
    await readBefore(true);
    await resetKnowledgeIndex([DOC]);
    expect(rowsOf("knowledge_documents")[0].vision_owed_pages).toEqual([2]);
    keyed();
    vi.mocked(getMonthUsage).mockImplementation(async () => ({ spentUsd: 10 }) as Awaited<ReturnType<typeof getMonthUsage>>);
    const body = await (await post({ documentId: DOC })).json();
    expect(body).toMatchObject({ done: false, visionFailedPages: [2], visionHeldPages: 1 });
    expect(body.visionSkipReason).toBe(
      "Monthly AI budget reached ($10.00 of $10.00) — 1 page was held for AI vision; any other page without a text layer "
      + `was indexed from its text layer only. ${WAITS}`,
    );
    expect(body.visionSkipReason).not.toMatch(/retried automatically/);
    expect(rowsOf("knowledge_documents")[0]).toMatchObject({ status: "indexing", vision_failed_pages: [2] });
  });
});
