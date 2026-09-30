// intelligence Round G (I-06) — POST /api/knowledge/ingest, driven through
// the route with a real PDF, the real engine and the in-memory database.
//
//   ING-9  the bytes decide: a renamed spreadsheet is refused on its first
//          batch with a message naming the importer; an upload leaves no row
//          and no object behind; a mirrored file is marked, never deleted
//   ING-2  the loser waits for the claim instead of erroring the document
//   ING-6  failed vision pages are said on the response; a controller can
//          accept the partial index explicitly (audited)
//   ADD-1  the controller gate reads the role collection

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { db, resetDb, rowsOf, type Row } from "./knowledgeFakeDb";
import { makePdf, prosePage } from "./knowledgePdfFixtures";

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
vi.mock("@/lib/equipmentBridgeServer", () => ({ computeForKnowledgeDoc: vi.fn(async () => undefined) }));
vi.mock("@/lib/mentionIndexer", () => ({ loadAliasDictionary: vi.fn(async () => []), indexDocumentMentions: vi.fn() }));
vi.mock("@/lib/ai/usageServer", () => ({ getMonthUsage: vi.fn(async () => ({ spentUsd: 0 })), getCapUsd: vi.fn(async () => 0), recordAskUsage: vi.fn() }));
vi.mock("@/lib/aiInstructionsServer", () => ({ loadOrgInstructionsBlock: vi.fn(async () => "") }));
vi.mock("@/lib/ai/keyVault", () => ({ openAiKey: (k: string) => k }));

import { POST } from "@/app/api/knowledge/ingest/route";
import { sniffBytes } from "@/lib/knowledgeIngest";

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
  ingest_claimed_by: null, ingest_claimed_at: null, ...over,
});
const seed = (doc: Row, members: Row[] = [{ org_id: "o1", uid: "u-ctrl", role: "Viewer", roles: ["Viewer", "DocCtrl"], status: "active" }]) =>
  resetDb({
    knowledge_documents: [doc], knowledge_chunks: [], knowledge_page_entities: [], org_members: members,
    knowledge_libraries: [{ id: "kl-1", org_id: "o1", ai_features: {} }], ai_connections: [], audit_logs: [],
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
