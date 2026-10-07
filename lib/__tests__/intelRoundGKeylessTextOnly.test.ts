// intelligence Round G (I-22) — KEYLESS TEXT-ONLY RECORD: a page an ingest
// batch with no AI key commits from its text layer, where a batch with a key
// would read it with AI vision, is counted on the row
// (knowledge_documents.vision_keyless_pages, 20261186). DEC-58 as ruled
// under DEC-90 A18: keyless completion is text-only WITH the marker — a
// keyless org's page is never held.
//
// Driven end to end over real PDFs (pdf-lib → unpdf, the production text
// path) against the in-memory database, as lib/__tests__/ingestLock.test.ts
// does. Covers ING-13 done-when 2's two remaining cases (a rev-up and a
// same-file reset of a document last indexed keyless), ING-6's keyless
// first-index limb, and the regression rule: a batch with a key, and a
// keyless org's document that needs no AI vision, behave exactly as before.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { db, resetDb, rowsOf, type Row } from "./knowledgeFakeDb";
import { makePdf, drawingSheet, prosePage, type PageSpec } from "./knowledgePdfFixtures";
import { resetMeter } from "./helpers/fakeUsageMeter";

const r2 = vi.hoisted(() => ({ objects: new Map<string, Uint8Array>(), deleted: [] as string[] }));
const vision = vi.hoisted(() => ({
  calls: [] as number[],
  impl: null as null | ((page: number) => Promise<{ text: string; usage: { inputTokens: number; outputTokens: number }; model: string }>),
}));

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
vi.mock("@/lib/knowledgeVision", async (orig) => ({
  ...(await orig<typeof import("@/lib/knowledgeVision")>()),
  transcribePageImage: vi.fn(async (input: { page: number }) => {
    vision.calls.push(input.page);
    if (!vision.impl) throw new Error("no vision in this test");
    return vision.impl(input.page);
  }),
}));
vi.mock("unpdf", async (orig) => ({
  ...(await orig<typeof import("unpdf")>()),
  renderPageAsImage: vi.fn(async () => new Uint8Array([137, 80, 78, 71]).buffer),
}));
vi.mock("@/lib/equipmentBridgeServer", () => ({ computeForKnowledgeDoc: vi.fn(async () => undefined) }));
vi.mock("@/lib/ai/usageServer", async () => (await import("./helpers/fakeUsageMeter")).fakeUsageServer());
vi.mock("@/lib/aiInstructionsServer", () => ({ loadOrgInstructionsBlock: vi.fn(async () => "") }));
vi.mock("@/lib/ai/keyVault", () => ({ openAiKey: (k: string) => k }));

import { ingestKnowledgeDocBatch, drainKnowledgeIngestQueue, resetKnowledgeIndex, type VisionContext } from "@/lib/knowledgeIngest";

const DOC = "kd-1";
const baseDoc = (over: Row = {}): Row => ({
  id: DOC, org_id: "o1", library_id: "kl-1", name: "025-PID-0101.pdf", file_key: "orgs/o1/knowledge/kl-1/a.pdf",
  status: "pending", pages_indexed: 0, page_count: null, last_section: null, created_by: "u1", created_at: "2026-09-01",
  source_id: null, source_document_id: null, source_version_id: null, source_rev: null,
  vision_pages: 0, empty_pages: 0, vision_failed_pages: [], vision_partial_accepted: false, chunk_version: null,
  vision_retry_after: null, vision_retry_tried: [], ingest_failures: 0, ingest_claimed_by: null, ingest_claimed_at: null, error: null,
  vision_owed_pages: [],
  // 20261186 (DEFAULT 0 on every row, a new upload's included).
  vision_keyless_pages: 0,
  ...over,
});
const docRow = () => rowsOf("knowledge_documents").find((r) => r.id === DOC)!;
const asArg = (r: Row) => r as unknown as Parameters<typeof ingestKnowledgeDocBatch>[0];

async function seed(pages: PageSpec[], over: Row = {}) {
  const bytes = await makePdf(pages);
  const doc = baseDoc(over);
  r2.objects.set(doc.file_key as string, bytes);
  resetDb({ knowledge_documents: [doc], knowledge_chunks: [], knowledge_page_entities: [], entity_mentions: [], knowledge_line_traces: [] });
  return doc;
}

const visionCtx = (budgetPages = 4): VisionContext => ({
  provider: "anthropic", model: "user-model", apiKey: "k", budgetPages, onUsage: () => undefined,
});
const transcript = (page: number) =>
  `DRAWING NO: 025-PID-0101\nSHEET: ${page} OF 3\nREV: 4\nV-${100 + page} SUCTION DRUM\nP-${200 + page}A CHARGE PUMP\nE-${300 + page} FEED EXCHANGER\n`;
const readsAll = () => { vision.impl = async (page) => ({ text: transcript(page), usage: { inputTokens: 1, outputTokens: 1 }, model: "vision-tier" }); };

/** What a batch leaves behind, for a before/after comparison. */
const footprint = () => ({
  row: (({ status, pages_indexed, page_count, vision_pages, empty_pages, vision_failed_pages, error }) =>
    ({ status, pages_indexed, page_count, vision_pages, empty_pages, vision_failed_pages, error }))(docRow() as Record<string, unknown>),
  chunks: rowsOf("knowledge_chunks").map((c) => `${c.page}/${c.seq}/${c.source}/${c.content}`).sort(),
  entities: rowsOf("knowledge_page_entities").map((e) => `${e.page}/${e.kind}/${e.tag}`).sort(),
  visionCalls: [...vision.calls],
});

// Three sheets: a drawing whose text layer carries its tags, a sheet with no
// text layer at all (an SHX plot, a scan), and a prose page.
const PAGES: PageSpec[] = [drawingSheet(1, ["V-101", "P-201A", "E-301"]), null, prosePage("bolting")];

beforeEach(() => {
  r2.objects.clear(); r2.deleted = [];
  vision.calls = []; vision.impl = null;
  resetMeter();
});

describe("I-22 — a keyless batch counts, on the row, the pages it commits text-only that a key would read with AI vision", () => {
  it("ING-6 keyless first-index limb: a fresh upload indexed with no AI key completes text-only, as before — and the row says one page went without AI vision", async () => {
    const doc = await seed(PAGES);
    const res = await ingestKnowledgeDocBatch(asArg(doc));
    expect(res).toMatchObject({ done: true, visionFailedPages: [], visionHeldPages: 0, visionPages: 0 });
    expect(docRow()).toMatchObject({
      status: "ready", vision_pages: 0, vision_failed_pages: [], empty_pages: 1, error: null,
      vision_keyless_pages: 1,
    });
    expect(vision.calls).toEqual([]);
    // Never held (DEC-58): pages 1 and 3 indexed, the textless page committed empty.
    expect([...new Set(rowsOf("knowledge_chunks").map((c) => c.page))].sort()).toEqual([1, 3]);
  });

  it("ING-13 case 1 — a REV-UP of a document last indexed keyless: the reset starts the count at 0, owes nothing, and the keyless batch completes the new file text-only WITH the count", async () => {
    // Rev 3, indexed keyless: its textless sheet counted, every chunk 'text'.
    await seed(PAGES, {
      status: "ready", pages_indexed: 3, page_count: 3, chunk_version: 1, empty_pages: 1, vision_keyless_pages: 1,
      source_document_id: "dc-1", source_version_id: "ver-3", source_rev: "3",
    });
    db.tables.knowledge_chunks = [
      { id: "c1", document_id: DOC, org_id: "o1", library_id: "kl-1", page: 1, seq: 0, content: "sheet 1", source: "text" },
      { id: "c3", document_id: DOC, org_id: "o1", library_id: "kl-1", page: 3, seq: 0, content: "bolting", source: "text" },
    ];
    // Rev 4 inserts a prose page and moves the textless sheet to page 3; it
    // adds a second textless sheet at page 5.
    const REV4 = "orgs/o1/dc/rev4.pdf";
    r2.objects.set(REV4, await makePdf([drawingSheet(1, ["V-101", "P-201A", "E-301"]), prosePage("gaskets"), null, prosePage("bolting"), null]));
    const reset = await resetKnowledgeIndex([DOC], {
      purgeLineTraces: true, supersedeBusy: true,
      expect: () => ({ source_version_id: "ver-3" }),
      rowUpdate: () => ({ file_key: REV4, source_version_id: "ver-4", source_rev: "4" }),
    });
    expect(reset).toEqual({ reset: [DOC], busy: [], errors: [] });
    // RESET_ROW starts the count at 0; nothing is owed (no AI vision ever read it).
    expect(docRow()).toMatchObject({ status: "stale", file_key: REV4, vision_keyless_pages: 0, vision_owed_pages: [] });

    // The cron drain reaches a mirror keyless (a mirror has no uploader).
    const res = await ingestKnowledgeDocBatch(asArg(docRow()));
    expect(res).toMatchObject({ done: true, visionFailedPages: [], visionHeldPages: 0, visionPages: 0 });
    expect(docRow()).toMatchObject({
      status: "ready", file_key: REV4, vision_pages: 0, vision_failed_pages: [], empty_pages: 2, error: null,
      vision_keyless_pages: 2,
    });
    expect(vision.calls).toEqual([]);
  });

  it("ING-13 case 2 — a SAME-FILE reset (the table-aware re-index, the drawing rebuild) of a document last indexed keyless: the count restarts and the keyless batch sets it again, never held", async () => {
    await seed(PAGES, { status: "ready", pages_indexed: 3, page_count: 3, chunk_version: 1, empty_pages: 1, vision_keyless_pages: 1 });
    db.tables.knowledge_chunks = [
      { id: "c1", document_id: DOC, org_id: "o1", library_id: "kl-1", page: 1, seq: 0, content: "sheet 1", source: "text" },
      { id: "c3", document_id: DOC, org_id: "o1", library_id: "kl-1", page: 3, seq: 0, content: "bolting", source: "text" },
    ];
    const reset = await resetKnowledgeIndex([DOC]);
    expect(reset).toEqual({ reset: [DOC], busy: [], errors: [] });
    expect(docRow()).toMatchObject({ status: "stale", pages_indexed: 0, vision_keyless_pages: 0, vision_owed_pages: [] });
    const res = await ingestKnowledgeDocBatch(asArg(docRow()));
    expect(res).toMatchObject({ done: true, visionFailedPages: [] });
    expect(docRow()).toMatchObject({ status: "ready", vision_pages: 0, vision_failed_pages: [], vision_keyless_pages: 1 });
  });

  it("a later keyed regeneration lowers it: the reset starts at 0, the key reads the page with AI vision, and the count stays 0", async () => {
    await seed(PAGES, { status: "ready", pages_indexed: 3, page_count: 3, chunk_version: 1, empty_pages: 1, vision_keyless_pages: 1 });
    await resetKnowledgeIndex([DOC]);
    readsAll();
    const res = await ingestKnowledgeDocBatch(asArg(docRow()), visionCtx());
    expect(res).toMatchObject({ done: true, visionPages: 1 });
    expect(vision.calls).toEqual([2]);
    expect(docRow()).toMatchObject({ status: "ready", vision_pages: 1, vision_keyless_pages: 0 });
  });

  it("a generation's first batch restarts the count even with no reset before it (a row a rebuild re-queued its own way)", async () => {
    // pages_indexed 0 is a new generation however the row got there; a stale
    // count from the last one never carries into it.
    const doc = await seed(PAGES, { status: "stale", pages_indexed: 0, vision_keyless_pages: 7 });
    readsAll();
    await ingestKnowledgeDocBatch(asArg(doc), visionCtx());
    expect(docRow()).toMatchObject({ status: "ready", vision_keyless_pages: 0 });
  });

  it("a batch that continues a generation adds to the count it found — and a keyed batch adds nothing", async () => {
    // Page 1 committed by an earlier batch; this one commits pages 2–3.
    const doc = await seed(PAGES, { status: "indexing", pages_indexed: 1, page_count: 3, chunk_version: 1, vision_keyless_pages: 4 });
    await ingestKnowledgeDocBatch(asArg(doc));
    expect(docRow()).toMatchObject({ status: "ready", pages_indexed: 3, vision_keyless_pages: 5 });

    const keyed = await seed(PAGES, { status: "indexing", pages_indexed: 1, page_count: 3, chunk_version: 1, vision_keyless_pages: 4 });
    readsAll();
    await ingestKnowledgeDocBatch(asArg(keyed), visionCtx());
    expect(vision.calls).toEqual([2]);
    expect(docRow()).toMatchObject({ status: "ready", pages_indexed: 3, vision_pages: 1, vision_keyless_pages: 4 });
  });

  it("a page held for AI vision is listed, not counted: a reason someone can fix (GOV-11 / GOV-4 / GOV-5), or a page the document owes AI vision (ING-13)", async () => {
    const doc = await seed(PAGES);
    const held = await ingestKnowledgeDocBatch(asArg(doc), undefined, undefined, { noVisionReason: "Accept the AI acceptable-use agreement first." });
    expect(held).toMatchObject({ done: false, visionFailedPages: [2], visionHeldPages: 1 });
    expect(docRow()).toMatchObject({ status: "indexing", vision_failed_pages: [2], vision_keyless_pages: 0 });

    const owed = await seed(PAGES, { vision_owed_pages: [2] });
    const res = await ingestKnowledgeDocBatch(asArg(owed));
    expect(res).toMatchObject({ visionFailedPages: [2], visionHeldPages: 1 });
    expect(docRow()).toMatchObject({ vision_failed_pages: [2], vision_keyless_pages: 0 });
  });

  it("in a library that reads every page with AI vision, a keyless batch counts every page it commits from its text layer (a key would read each one)", async () => {
    const doc = await seed(PAGES);
    const res = await ingestKnowledgeDocBatch(asArg(doc), undefined, undefined, { visionAllPages: true });
    expect(res).toMatchObject({ done: true, visionFailedPages: [] });
    expect(docRow()).toMatchObject({ status: "ready", vision_keyless_pages: 3 });
  });

  it("the nightly drain with no sponsored key: the document completes text-only with the count — never parked, never billed", async () => {
    await seed(PAGES, { created_by: "u-nokey" });
    db.tables.knowledge_libraries = [{ id: "kl-1", org_id: "o1", ai_features: {} }];
    db.tables.ai_connections = [];
    const out = await drainKnowledgeIngestQueue({ maxPages: 100, deadlineMs: Date.now() + 30_000 });
    expect(out.errors).toEqual([]);
    expect(out.completed).toBe(1);
    expect(docRow()).toMatchObject({ status: "ready", vision_failed_pages: [], vision_keyless_pages: 1, error: null });
    expect(vision.calls).toEqual([]);
  });
});

describe("I-22 — REGRESSION: what works today works exactly the same", () => {
  it("a batch WITH a key: the same reads, the same row, the same chunks and tags as on a database without the column — and the count stays 0", async () => {
    let doc = await seed(PAGES);
    readsAll();
    const withCol = await ingestKnowledgeDocBatch(asArg(doc), visionCtx());
    const a = footprint();
    expect(docRow().vision_keyless_pages).toBe(0);

    doc = await seed(PAGES);
    delete db.tables.knowledge_documents[0].vision_keyless_pages;
    db.missingColumns.knowledge_documents = ["vision_keyless_pages"];
    vision.calls = [];
    const without = await ingestKnowledgeDocBatch(asArg(doc), visionCtx());
    const b = footprint();
    expect(withCol).toEqual(without);
    expect(a).toEqual(b);
    expect(a.visionCalls).toEqual([2]);
    expect(a.row).toMatchObject({ status: "ready", vision_pages: 1, vision_failed_pages: [] });
  });

  it("a keyless org's document that needs no AI vision: completes exactly as before, and the count stays 0", async () => {
    const plain: PageSpec[] = [drawingSheet(1, ["V-101", "P-201A", "E-301"]), prosePage("bolting"), prosePage("gaskets")];
    let doc = await seed(plain);
    const withCol = await ingestKnowledgeDocBatch(asArg(doc));
    const a = footprint();
    expect(docRow()).toMatchObject({ status: "ready", vision_keyless_pages: 0, empty_pages: 0 });

    doc = await seed(plain);
    delete db.tables.knowledge_documents[0].vision_keyless_pages;
    db.missingColumns.knowledge_documents = ["vision_keyless_pages"];
    const without = await ingestKnowledgeDocBatch(asArg(doc));
    expect(withCol).toEqual(without);
    expect(a).toEqual(footprint());
  });

  it("a database without 20261186: the keyless batch completes text-only exactly as before, and nothing names the column", async () => {
    const doc = await seed(PAGES);
    delete db.tables.knowledge_documents[0].vision_keyless_pages;
    db.missingColumns.knowledge_documents = ["vision_keyless_pages"];
    const res = await ingestKnowledgeDocBatch(asArg(doc));
    expect(res).toMatchObject({ done: true, visionFailedPages: [] });
    expect(docRow()).toMatchObject({ status: "ready", vision_pages: 0, vision_failed_pages: [], empty_pages: 1 });
    expect("vision_keyless_pages" in docRow()).toBe(false);
    const named = db.ops.filter((o) => JSON.stringify(o).includes("vision_keyless_pages"));
    expect(named).toEqual([]);
  });

  it("a database without 20261186: the one reset resets exactly as before (the claimed row does not carry it)", async () => {
    await seed(PAGES, { status: "ready", pages_indexed: 3, page_count: 3, vision_pages: 0 });
    delete db.tables.knowledge_documents[0].vision_keyless_pages;
    db.missingColumns.knowledge_documents = ["vision_keyless_pages"];
    const reset = await resetKnowledgeIndex([DOC]);
    expect(reset).toEqual({ reset: [DOC], busy: [], errors: [] });
    expect(docRow()).toMatchObject({ status: "stale", pages_indexed: 0, vision_pages: 0 });
    expect("vision_keyless_pages" in docRow()).toBe(false);
  });

  it("a database with neither 20261122 nor 20261186 (the legacy, unclaimed path): the reset's ladder strips the new column too, and resets", async () => {
    await seed(PAGES, { status: "ready", pages_indexed: 3, page_count: 3 });
    const legacyCols = ["ingest_claimed_by", "ingest_claimed_at", "empty_pages", "vision_failed_pages", "vision_partial_accepted",
      "chunk_version", "vision_retry_after", "vision_retry_tried", "ingest_failures", "vision_owed_pages", "vision_keyless_pages"];
    db.missingColumns.knowledge_documents = legacyCols;
    db.tables.knowledge_documents = [Object.fromEntries(Object.entries(db.tables.knowledge_documents[0]).filter(([k]) => !legacyCols.includes(k)))];
    const reset = await resetKnowledgeIndex([DOC], { expect: () => ({ file_key: "orgs/o1/knowledge/kl-1/a.pdf" }) });
    expect(reset).toEqual({ reset: [DOC], busy: [], errors: [] });
    expect(docRow()).toMatchObject({ status: "stale", pages_indexed: 0 });
    // …and the unclaimed batch indexes it, as before.
    const res = await ingestKnowledgeDocBatch(asArg(docRow()));
    expect(res).toMatchObject({ done: true, legacy: true });
    expect(docRow().status).toBe("ready");
  });
});
