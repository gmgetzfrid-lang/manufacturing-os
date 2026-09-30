// intelligence Round G (I-06) — the ingest engine, driven end to end over
// real PDFs (pdf-lib → unpdf, the production text path) against an
// in-memory database (knowledgeFakeDb.ts).
//
//   ING-2  one driver at a time: the claim, the waiting loser, the drain's
//          skip, the TTL, and a duplicate key that is contention not failure
//   ING-1  compare-and-set at commit: a row re-pointed under a batch keeps
//          what it says, and the batch's rows are withdrawn
//   ING-3 / DWG-1  the range's entities are cleared even when the re-read
//          finds nothing; a shorter revision keeps nothing past its end
//   ING-8  the entity ladder: bisect on timeout, stop on a real failure,
//          skip only a missing table
//   ING-6  a failed vision page is recorded, blocks 'ready', is retried,
//          and a retry that cannot run (no key) or fails again says so on
//          the row — the document stays 'indexing' and retrievable, never
//          'error' — and backs off instead of hammering the provider
//   ING-11 empty pages accumulate on the row; GOV-9 each chunk says how its
//          text was obtained
//   ING-9  the drain refuses a non-PDF the same way the route does
//   ING-3  a new index generation's first batch clears everything the last
//          one left; ING-7 the carry never touches a drawing sheet

import { describe, it, expect, vi, beforeEach } from "vitest";
import { db, resetDb, rowsOf, type Row } from "./knowledgeFakeDb";
import { makePdf, drawingSheet, prosePage, type PageSpec } from "./knowledgePdfFixtures";

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
vi.mock("@/lib/knowledgeVision", () => ({
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
vi.mock("@/lib/ai/usageServer", () => ({
  getMonthUsage: vi.fn(async () => ({ spentUsd: 0 })),
  getCapUsd: vi.fn(async () => 0),
  recordAskUsage: vi.fn(async () => undefined),
}));
vi.mock("@/lib/aiInstructionsServer", () => ({ loadOrgInstructionsBlock: vi.fn(async () => "") }));
vi.mock("@/lib/ai/keyVault", () => ({ openAiKey: (k: string) => k }));

import {
  ingestKnowledgeDocBatch, drainKnowledgeIngestQueue, claimIngestLease, resetKnowledgeIndex,
  INGEST_LEASE_TTL_MS, VISION_RETRY_BACKOFF_MS, visionRetryMessage, type VisionContext,
} from "@/lib/knowledgeIngest";

const DOC = "kd-1";
const baseDoc = (over: Row = {}): Row => ({
  id: DOC, org_id: "o1", library_id: "kl-1", name: "025-PID-0101.pdf", file_key: "orgs/o1/knowledge/kl-1/a.pdf",
  status: "pending", pages_indexed: 0, page_count: null, last_section: null, created_by: "u1", created_at: "2026-09-01",
  source_id: null, source_document_id: null, source_version_id: null, source_rev: null,
  vision_pages: 0, empty_pages: 0, vision_failed_pages: [], vision_partial_accepted: false, chunk_version: null,
  vision_retry_after: null, ingest_claimed_by: null, ingest_claimed_at: null, error: null,
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

beforeEach(() => {
  r2.objects.clear(); r2.deleted = [];
  vision.calls = []; vision.impl = null;
});

describe("ING-2 — one driver at a time", () => {
  it("two drivers racing one document: exactly one works, the other is busy, nothing errors", async () => {
    const doc = await seed([drawingSheet(1, ["V-101", "P-201A", "E-301"]), prosePage("bolting"), prosePage("gasket")]);
    const [a, b] = await Promise.all([ingestKnowledgeDocBatch(asArg(doc)), ingestKnowledgeDocBatch(asArg(doc))]);
    const winners = [a, b].filter((r) => !r.busy);
    expect(winners).toHaveLength(1);
    expect([a, b].filter((r) => r.busy)).toHaveLength(1);
    expect(winners[0].done).toBe(true);
    const row = docRow();
    expect(row.status).toBe("ready");
    expect(row.error).toBeNull();
    expect(row.ingest_claimed_by).toBeNull();           // released by the commit
    // One copy of the text, not two.
    const keys = rowsOf("knowledge_chunks").map((c) => `${c.page}/${c.seq}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("the claim is atomic, frees itself after the TTL, and is gone for a deleted row", async () => {
    await seed([prosePage("bolting")]);
    const t0 = Date.parse("2026-09-30T12:00:00Z");
    expect((await claimIngestLease(DOC, "A", t0)).kind).toBe("claimed");
    expect((await claimIngestLease(DOC, "B", t0 + 1000)).kind).toBe("busy");
    expect((await claimIngestLease(DOC, "B", t0 + INGEST_LEASE_TTL_MS - 1)).kind).toBe("busy");
    // A driver the platform killed never released; five minutes on, the
    // document is free again.
    const late = await claimIngestLease(DOC, "B", t0 + INGEST_LEASE_TTL_MS + 1);
    expect(late.kind).toBe("claimed");
    expect(docRow().ingest_claimed_by).toBe("B");
    expect((await claimIngestLease("nope", "C")).kind).toBe("gone");
  });

  it("a batch that finds the claim held does no work at all", async () => {
    const doc = await seed([prosePage("bolting")], { ingest_claimed_by: "other", ingest_claimed_at: new Date().toISOString() });
    const res = await ingestKnowledgeDocBatch(asArg(doc));
    expect(res.busy).toBe(true);
    expect(res.done).toBe(false);
    expect(rowsOf("knowledge_chunks")).toHaveLength(0);
    expect(docRow().ingest_claimed_by).toBe("other");
    expect(docRow().status).toBe("pending");
  });

  it("the drain skips a row someone holds the claim on", async () => {
    await seed([prosePage("bolting")], { status: "indexing", ingest_claimed_by: "browser", ingest_claimed_at: new Date().toISOString() });
    const out = await drainKnowledgeIngestQueue({ maxPages: 100, deadlineMs: Date.now() + 30_000 });
    expect(out.docsTouched).toBe(0);
    expect(rowsOf("knowledge_chunks")).toHaveLength(0);
    expect(docRow().status).toBe("indexing");
    expect(docRow().ingest_claimed_by).toBe("browser");
  });

  it("the drain takes a stale claim over and finishes the document", async () => {
    const stale = new Date(Date.now() - INGEST_LEASE_TTL_MS - 60_000).toISOString();
    await seed([prosePage("bolting"), prosePage("gaskets")], { status: "indexing", ingest_claimed_by: "killed", ingest_claimed_at: stale });
    const out = await drainKnowledgeIngestQueue({ maxPages: 100, deadlineMs: Date.now() + 30_000 });
    expect(out.completed).toBe(1);
    expect(docRow().status).toBe("ready");
    expect(docRow().ingest_claimed_by).toBeNull();
  });

  it("a duplicate key is contention, not failure: the batch withdraws its rows and the document is not errored", async () => {
    // The interleaving the finding traced: A clears the range, B clears it,
    // A inserts, B inserts — B meets A's rows on the unique (document, page,
    // seq) index. Modelled deterministically: another writer's row lands in
    // the range between this batch's clear and its insert. It used to throw
    // "chunk insert failed: duplicate key…" and the route marked the whole
    // document 'error'.
    const doc = await seed([prosePage("bolting"), prosePage("gaskets")]);
    db.hooks.push((op) => {
      if (op.table !== "knowledge_chunks" || op.kind !== "insert" || rowsOf("knowledge_chunks").some((c) => c.id === "theirs")) return;
      db.tables.knowledge_chunks.push({ id: "theirs", document_id: DOC, org_id: "o1", library_id: "kl-1", page: 1, seq: 0, content: "the other writer" });
    });
    const res = await ingestKnowledgeDocBatch(asArg(doc));
    expect(res).toMatchObject({ superseded: true, done: false, busy: false });
    expect(docRow()).toMatchObject({ status: "pending", error: null, pages_indexed: 0, ingest_claimed_by: null });
    // Only this batch's own rows are withdrawn — never the other writer's.
    expect(rowsOf("knowledge_chunks").map((c) => c.id)).toEqual(["theirs"]);
  });

  it("unclaimed (pre-20261122) drivers racing: the row ends consistent and never errored", async () => {
    const doc = await seed([prosePage("bolting"), prosePage("gaskets")]);
    const legacyCols = ["ingest_claimed_by", "ingest_claimed_at", "empty_pages", "vision_failed_pages", "vision_partial_accepted", "chunk_version", "vision_retry_after"];
    db.missingColumns.knowledge_documents = legacyCols;
    const legacy = Object.fromEntries(Object.entries(doc).filter(([k]) => !legacyCols.includes(k)));
    db.tables.knowledge_documents = [legacy];
    const results = await Promise.all([ingestKnowledgeDocBatch(asArg(legacy)), ingestKnowledgeDocBatch(asArg(legacy))]);
    expect(results.some((r) => r.done)).toBe(true);
    expect(docRow()).toMatchObject({ status: "ready", error: null, pages_indexed: 2 });
    const keys = rowsOf("knowledge_chunks").map((c) => `${c.page}/${c.seq}`);
    expect(keys.length).toBeGreaterThan(0);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("ING-1 — compare-and-set at commit", () => {
  it("a rev-up that lands mid-batch: the batch withdraws its rows and the row keeps saying 'stale'", async () => {
    const doc = await seed([drawingSheet(1, ["V-101", "P-201A", "E-301"]), prosePage("bolting")],
      { source_document_id: "dc-1", source_version_id: "ver-3", source_rev: "3" });
    // A writer that does NOT take the claim (a pre-lease sync, a hand edit)
    // re-points the row at Rev 4 while the batch is writing Rev 3's chunks.
    let fired = false;
    db.hooks.push((op) => {
      if (fired || op.table !== "knowledge_chunks" || op.kind !== "insert") return;
      fired = true;
      Object.assign(docRow(), {
        file_key: "orgs/o1/dc/rev4.pdf", source_version_id: "ver-4", source_rev: "4",
        pages_indexed: 0, page_count: null, status: "stale", error: null,
      });
    });
    const res = await ingestKnowledgeDocBatch(asArg(doc));
    expect(res.superseded).toBe(true);
    expect(res.done).toBe(false);
    const row = docRow();
    expect(row).toMatchObject({ status: "stale", pages_indexed: 0, source_rev: "4", file_key: "orgs/o1/dc/rev4.pdf" });
    // Nothing Rev 3 wrote survives under the Rev 4 row.
    expect(rowsOf("knowledge_chunks")).toHaveLength(0);
    expect(rowsOf("knowledge_page_entities")).toHaveLength(0);
  });

  it("a same-file reset (a rebuild, a library re-index) never lands under a batch holding the claim — it waits its turn", async () => {
    const doc = await seed([prosePage("bolting"), prosePage("gaskets")]);
    let reset: Awaited<ReturnType<typeof resetKnowledgeIndex>> | null = null;
    db.hooks.push((op) => {
      if (reset || op.table !== "knowledge_chunks" || op.kind !== "insert") return;
      void resetKnowledgeIndex([DOC]).then((r) => { reset = r; });
    });
    const res = await ingestKnowledgeDocBatch(asArg(doc));
    await new Promise((r) => setTimeout(r, 0));
    expect(reset).toEqual({ reset: [], busy: [DOC], errors: [] });
    expect(res.done).toBe(true);
    expect(docRow()).toMatchObject({ status: "ready" });
  });

  it("a rev-up that lands while a batch writes the OLD revision re-points the row at once; the batch's commit misses and withdraws", async () => {
    const doc = await seed([drawingSheet(1, ["V-101", "P-201A", "E-301"]), prosePage("bolting")],
      { source_document_id: "dc-1", source_version_id: "ver-3", source_rev: "3" });
    // The whole refresh runs, start to finish, just before the batch's
    // commit: exactly the moment the old code let it stamp Rev 3 'ready'.
    let reset: Awaited<ReturnType<typeof resetKnowledgeIndex>> | null = null;
    let running = false;
    db.asyncHooks.push(async (op, filters) => {
      if (running || reset || op.table !== "knowledge_documents" || op.kind !== "update") return;
      if (!filters.some((f) => f.col === "pages_indexed")) return;   // the batch's compare-and-set
      running = true;
      reset = await resetKnowledgeIndex([DOC], {
        purgeLineTraces: true, supersedeBusy: true,
        rowUpdate: () => ({ file_key: "orgs/o1/dc/rev4.pdf", source_version_id: "ver-4", source_rev: "4" }),
      });
      running = false;
    });
    const res = await ingestKnowledgeDocBatch(asArg(doc));
    expect(reset).toEqual({ reset: [DOC], busy: [], errors: [] });
    expect(res).toMatchObject({ superseded: true, done: false });
    // The row names Rev 4, queued; nothing of Rev 3 is under it; the claim
    // the superseded batch held is released.
    expect(docRow()).toMatchObject({
      status: "stale", pages_indexed: 0, file_key: "orgs/o1/dc/rev4.pdf", source_version_id: "ver-4", source_rev: "4",
      ingest_claimed_by: null,
    });
    expect(rowsOf("knowledge_chunks")).toHaveLength(0);
    expect(rowsOf("knowledge_page_entities")).toHaveLength(0);
  });

  it("a deleted row mid-batch is superseded, not an error", async () => {
    const doc = await seed([prosePage("bolting")]);
    db.hooks.push((op) => {
      if (op.table === "knowledge_chunks" && op.kind === "insert") db.tables.knowledge_documents = [];
    });
    const res = await ingestKnowledgeDocBatch(asArg(doc));
    expect(res.superseded).toBe(true);
    expect(rowsOf("knowledge_chunks")).toHaveLength(0);
  });
});

describe("ING-3 / DWG-1 — no superseded tags survive a re-read", () => {
  it("a re-read that extracts nothing still clears the range's old entities", async () => {
    const doc = await seed([null, null], { status: "stale" });
    db.tables.knowledge_page_entities = [1, 2].map((p) => ({
      id: `old-${p}`, document_id: DOC, org_id: "o1", library_id: "kl-1", page: p, kind: "equipment", tag: "V-1402",
    }));
    // No vision context: SHX pages come back textless and tagless.
    const res = await ingestKnowledgeDocBatch(asArg(doc));
    expect(res.done).toBe(true);
    expect(rowsOf("knowledge_page_entities")).toHaveLength(0);
  });

  it("a revision with fewer sheets keeps nothing past its last page", async () => {
    const doc = await seed([drawingSheet(1, ["V-101", "P-201A", "E-301"]), drawingSheet(2, ["V-102", "P-202A", "E-302"])], { status: "stale" });
    db.tables.knowledge_page_entities = [3, 4].map((p) => ({ id: `old-${p}`, document_id: DOC, org_id: "o1", library_id: "kl-1", page: p, kind: "equipment", tag: `V-9${p}` }));
    db.tables.knowledge_chunks = [{ id: "old-c", document_id: DOC, org_id: "o1", library_id: "kl-1", page: 3, seq: 0, content: "old sheet 3" }];
    const res = await ingestKnowledgeDocBatch(asArg(doc));
    expect(res.done).toBe(true);
    expect(res.pageCount).toBe(2);
    expect(rowsOf("knowledge_page_entities").every((e) => Number(e.page) <= 2)).toBe(true);
    expect(rowsOf("knowledge_page_entities").map((e) => e.tag)).toEqual(expect.arrayContaining(["V-101", "V-102"]));
    expect(rowsOf("knowledge_chunks").every((c) => Number(c.page) <= 2)).toBe(true);
  });

  it("a new index generation's first batch clears everything the last one left — even past its own page range", async () => {
    // An interrupted reset left the row queued with old rows still under it,
    // on pages this first batch (1–50) never reaches.
    const pages: PageSpec[] = Array.from({ length: 53 }, (_, i) => prosePage(`topic ${i}`));
    const doc = await seed(pages, { status: "stale" });
    db.tables.knowledge_chunks = [51, 52].map((p) => ({ id: `old-c${p}`, document_id: DOC, org_id: "o1", library_id: "kl-1", page: p, seq: 0, content: `rev 3 page ${p}` }));
    db.tables.knowledge_page_entities = [{ id: "old-e51", document_id: DOC, org_id: "o1", library_id: "kl-1", page: 51, kind: "equipment", tag: "V-1402" }];
    const res = await ingestKnowledgeDocBatch(asArg(doc));
    expect(res.resumeAt).toBe(50);
    expect(rowsOf("knowledge_chunks").some((c) => String(c.id).startsWith("old-"))).toBe(false);
    expect(rowsOf("knowledge_page_entities").some((e) => e.id === "old-e51")).toBe(false);
  });

  it("a failed range clear stops the batch before pages_indexed moves", async () => {
    const doc = await seed([drawingSheet(1, ["V-101", "P-201A", "E-301"])]);
    db.hooks.push((op) => op.table === "knowledge_page_entities" && op.kind === "delete"
      ? { error: { code: "57014", message: "canceling statement due to statement timeout" } } : undefined);
    await expect(ingestKnowledgeDocBatch(asArg(doc))).rejects.toThrow(/entity cleanup failed/);
    expect(docRow()).toMatchObject({ pages_indexed: 0, status: "pending", ingest_claimed_by: null });
  });
});

describe("ING-8 — the entity insert ladder", () => {
  const tagged = () => seed([drawingSheet(1, ["V-101", "P-201A", "E-301"]), drawingSheet(2, ["V-102", "P-202A", "E-302"])]);

  it("a statement timeout halves and retries; every tag lands and the batch commits", async () => {
    const doc = await tagged();
    db.hooks.push((op) => op.table === "knowledge_page_entities" && op.kind === "insert" && (op.payload as Row[]).length > 3
      ? { error: { code: "57014", message: "canceling statement due to statement timeout" } } : undefined);
    const res = await ingestKnowledgeDocBatch(asArg(doc));
    expect(res.done).toBe(true);
    expect(rowsOf("knowledge_page_entities").filter((e) => e.kind === "equipment").map((e) => e.tag).sort())
      .toEqual(["E-301", "E-302", "P-201A", "P-202A", "V-101", "V-102"]);
  });

  it("any other failure throws: pages_indexed does not advance and the document is not 'ready'", async () => {
    const doc = await tagged();
    db.hooks.push((op) => op.table === "knowledge_page_entities" && op.kind === "insert"
      ? { error: { code: "08006", message: "connection reset by peer" } } : undefined);
    await expect(ingestKnowledgeDocBatch(asArg(doc))).rejects.toThrow(/entity insert failed: connection reset/);
    expect(docRow()).toMatchObject({ pages_indexed: 0, status: "pending" });
  });

  it("only a genuinely missing table skips the tag layer", async () => {
    const doc = await tagged();
    db.missingTables = ["knowledge_page_entities"];
    const res = await ingestKnowledgeDocBatch(asArg(doc));
    expect(res.done).toBe(true);
    expect(docRow().status).toBe("ready");
  });
});

describe("ING-6 — a failed vision page is never silently 'read'", () => {
  it("records the page, holds 'ready', retries it on the next pass, then completes", async () => {
    const doc = await seed([null, null, prosePage("bolting")]);
    let failPage2 = true;
    vision.impl = async (page) => {
      if (page === 2 && failPage2) throw new Error("provider 529 overloaded");
      return { text: transcript(page), usage: { inputTokens: 10, outputTokens: 10 }, model: "vision-tier" };
    };
    const first = await ingestKnowledgeDocBatch(asArg(doc), visionCtx());
    expect(first.visionFailedPages).toEqual([2]);
    expect(first.visionError).toMatch(/529/);
    expect(first.done).toBe(false);
    expect(first.resumeAt).toBe(3);
    // pagesIndexed keeps its meaning (the resume point — what clients stall-
    // detect on); pagesReadable is the failure-adjusted count.
    expect(first.pagesIndexed).toBe(3);
    expect(first.pagesReadable).toBe(2);                  // 3 reached, 1 waiting on a retry
    expect(docRow()).toMatchObject({ status: "indexing", pages_indexed: 3, vision_failed_pages: [2], vision_pages: 1 });

    failPage2 = false;
    const second = await ingestKnowledgeDocBatch(asArg(docRow()), visionCtx());
    expect(second.done).toBe(true);
    expect(second.visionFailedPages).toEqual([]);
    expect(docRow()).toMatchObject({ status: "ready", vision_failed_pages: [], vision_pages: 2 });
    expect(rowsOf("knowledge_page_entities").some((e) => e.page === 2 && e.tag === "V-102")).toBe(true);
    // Page 2 was empty after the failed read and holds text now.
    expect(docRow().empty_pages).toBe(0);
  });

  // A document whose main pass is through, with page 1 waiting on AI vision
  // and page 2 indexed — what Ask retrieves while the retry is pending.
  const awaitingRetry = async (over: Row = {}) => {
    const doc = await seed([null, prosePage("bolting")], {
      status: "indexing", pages_indexed: 2, page_count: 2, vision_failed_pages: [1], ...over,
    });
    db.tables.knowledge_chunks = [{ id: "c-2", document_id: DOC, org_id: "o1", library_id: "kl-1", page: 2, seq: 0, content: "bolting text" }];
    return doc;
  };
  // knowledge_search / semantic_search return documents in ('ready','indexing').
  const retrievable = () => ["ready", "indexing"].includes(String(docRow().status)) && rowsOf("knowledge_chunks").length > 0;

  it("a retry pass in which every page fails again backs off and says so — the document stays 'indexing' and retrievable", async () => {
    const doc = await awaitingRetry();
    vision.impl = async () => { throw new Error("provider 529 overloaded"); };
    const t0 = Date.now();
    const res = await ingestKnowledgeDocBatch(asArg(doc), visionCtx());
    expect(res).toMatchObject({ visionRetryBlocked: true, done: false, busy: false, superseded: false });
    expect(res.visionRetryMessage).toBe(visionRetryMessage([1], "provider 529 overloaded"));
    expect(Date.parse(res.visionRetryAfter!)).toBeGreaterThanOrEqual(t0 + VISION_RETRY_BACKOFF_MS);
    expect(docRow()).toMatchObject({
      status: "indexing", error: res.visionRetryMessage, vision_failed_pages: [1], pages_indexed: 2,
      vision_retry_after: res.visionRetryAfter, ingest_claimed_by: null,
    });
    expect(retrievable()).toBe(true);

    // The next batch — any driver, key or not — does not ask the provider
    // again while the back-off holds, and downloads nothing.
    vision.calls = [];
    r2.objects.clear();
    const again = await ingestKnowledgeDocBatch(asArg(docRow()), visionCtx());
    expect(again).toMatchObject({ visionRetryBlocked: true, visionRetryMessage: res.visionRetryMessage, visionRetryAfter: res.visionRetryAfter });
    expect(vision.calls).toEqual([]);
    expect(docRow().status).toBe("indexing");

    // Once it runs out, the page is retried and the document completes.
    r2.objects.set(doc.file_key as string, await makePdf([null, prosePage("bolting")]));
    docRow().vision_retry_after = new Date(Date.now() - 1000).toISOString();
    vision.impl = async (page) => ({ text: transcript(page), usage: { inputTokens: 1, outputTokens: 1 }, model: "vision-tier" });
    const done = await ingestKnowledgeDocBatch(asArg(docRow()), visionCtx());
    expect(done.done).toBe(true);
    expect(docRow()).toMatchObject({ status: "ready", error: null, vision_failed_pages: [], vision_retry_after: null });
  });

  it("a keyless driver (a controller's tab without a key) leaves the document 'indexing' and retrievable, with the reason on the row", async () => {
    const doc = await awaitingRetry();
    r2.objects.clear();                                   // proves nothing is downloaded
    const res = await ingestKnowledgeDocBatch(asArg(doc));
    expect(res).toMatchObject({ visionRetryBlocked: true, done: false, visionRetryAfter: null });
    expect(res.visionRetryMessage).toMatch(/AI vision could not read 1 page \(p\. 1\), and retrying needs an AI key with budget left\. The rest of the document is searchable meanwhile\./);
    expect(docRow()).toMatchObject({ status: "indexing", error: res.visionRetryMessage, pages_indexed: 2, ingest_claimed_by: null });
    // Stamped "now": it holds no one back, and files the document behind
    // fresh work in the cron's queue.
    expect(Date.parse(String(docRow().vision_retry_after))).toBeLessThanOrEqual(Date.now());
    expect(retrievable()).toBe(true);
    expect(rowsOf("knowledge_chunks").map((c) => c.id)).toEqual(["c-2"]);
  });

  it("the cron drain without a sponsored key does the same — never 'error', never billed", async () => {
    await awaitingRetry();
    r2.objects.clear();
    const out = await drainKnowledgeIngestQueue({ maxPages: 100, deadlineMs: Date.now() + 30_000 });
    expect(out.errors).toEqual([]);
    expect(docRow()).toMatchObject({ status: "indexing", vision_failed_pages: [1] });
    expect(String(docRow().error)).toMatch(/retrying needs an AI key/);
    expect(vision.calls).toEqual([]);
    expect(retrievable()).toBe(true);
  });

  it("documents waiting on a vision retry can never hold the head of the cron's queue", async () => {
    // Twenty older documents parked on a retry (stamped), one fresh upload.
    const pdf = await makePdf([null, prosePage("bolting")]);
    const parked = Array.from({ length: 20 }, (_, i) => baseDoc({
      id: `kd-p${i}`, created_at: `2026-08-${String(i + 1).padStart(2, "0")}`, file_key: `orgs/o1/knowledge/kl-1/p${i}.pdf`,
      status: "indexing", pages_indexed: 2, page_count: 2, vision_failed_pages: [1],
      vision_retry_after: new Date(Date.now() - 60_000).toISOString(),
    }));
    const fresh = baseDoc({ id: "kd-new", created_at: "2026-09-29", file_key: "orgs/o1/knowledge/kl-1/new.pdf" });
    r2.objects.set("orgs/o1/knowledge/kl-1/new.pdf", await makePdf([prosePage("bolting")]));
    parked.forEach((d) => r2.objects.set(d.file_key as string, pdf));
    resetDb({ knowledge_documents: [...parked, fresh], knowledge_chunks: [], knowledge_page_entities: [], entity_mentions: [] });
    const out = await drainKnowledgeIngestQueue({ maxPages: 100, deadlineMs: Date.now() + 30_000 });
    expect(out.completed).toBe(1);
    expect(rowsOf("knowledge_documents").find((d) => d.id === "kd-new")!.status).toBe("ready");
    expect(rowsOf("knowledge_documents").filter((d) => d.status === "error")).toHaveLength(0);
  });

  it("an accepted partial index is 'ready' with the unread pages still listed", async () => {
    const doc = await seed([null], { status: "indexing", pages_indexed: 1, page_count: 1, vision_failed_pages: [1], vision_partial_accepted: true });
    const res = await ingestKnowledgeDocBatch(asArg(doc));
    expect(res.done).toBe(true);
    expect(docRow()).toMatchObject({ status: "ready", vision_failed_pages: [1] });
  });
});

describe("ING-9 — the cron drain refuses a non-PDF exactly as the route does", () => {
  const XLSX = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00, ...new Array(200).fill(0x41)]);

  it("an upload whose tab closed before its first batch: row and object removed, audited, the importer named", async () => {
    const doc = baseDoc({ file_key: "orgs/o1/knowledge/kl-1/list.pdf", name: "equipment-list.pdf" });
    resetDb({ knowledge_documents: [doc], knowledge_chunks: [], knowledge_page_entities: [], audit_logs: [] });
    r2.objects.set("orgs/o1/knowledge/kl-1/list.pdf", XLSX);
    const out = await drainKnowledgeIngestQueue({ maxPages: 100, deadlineMs: Date.now() + 30_000 });
    expect(out.errors.join(" ")).toMatch(/Only PDF files can be indexed — "equipment-list\.pdf" is not a PDF \(it looks like an Excel or Word file\)\. To load an equipment list, open Operating areas and use Import CSV/);
    expect(out.errors.join(" ")).not.toMatch(/Invalid PDF structure/);
    expect(rowsOf("knowledge_documents")).toHaveLength(0);
    expect(r2.deleted).toEqual(["orgs/o1/knowledge/kl-1/list.pdf"]);
    expect(rowsOf("audit_logs")).toEqual([expect.objectContaining({ action: "KNOWLEDGE_DOC_REJECTED", user_id: null })]);
  });

  it("a mirrored controlled file is marked with the message, never deleted", async () => {
    const doc = baseDoc({ file_key: "orgs/o1/dc/list.pdf", source_id: "src-1", source_document_id: "dc-1" });
    resetDb({ knowledge_documents: [doc], knowledge_chunks: [], knowledge_page_entities: [], audit_logs: [] });
    r2.objects.set("orgs/o1/dc/list.pdf", XLSX);
    await drainKnowledgeIngestQueue({ maxPages: 100, deadlineMs: Date.now() + 30_000 });
    expect(r2.deleted).toEqual([]);
    expect(docRow()).toMatchObject({ status: "error" });
    expect(String(docRow().error)).toMatch(/^Only PDF files can be indexed/);
  });
});

describe("ING-11 / GOV-9 — the row's counters and each chunk's provenance", () => {
  it("empty pages accumulate across batches on the row", async () => {
    const pages: PageSpec[] = Array.from({ length: 53 }, (_, i) => (i % 2 === 0 ? null : prosePage(`topic ${i}`)));
    const doc = await seed(pages);
    const a = await ingestKnowledgeDocBatch(asArg(doc));
    expect(a.done).toBe(false);
    expect(a.emptyPagesTotal).toBe(25);
    const b = await ingestKnowledgeDocBatch(asArg(docRow()));
    expect(b.done).toBe(true);
    expect(b.emptyPages).toBe(2);
    expect(b.emptyPagesTotal).toBe(27);
    expect(docRow().empty_pages).toBe(27);
  });

  it("ING-12: a re-index restarts every counter at page 0 — even after the drawing rebuild's own reset, which does not zero them", async () => {
    // Exactly the fields app/api/knowledge/drawing/route.ts's rebuild writes
    // today (I-07 moves it onto resetKnowledgeIndex): vision_pages untouched.
    const doc = await seed([null, null, prosePage("bolting")], {
      status: "stale", pages_indexed: 0, page_count: null, last_section: null, error: null,
      vision_pages: 40, empty_pages: 12, vision_failed_pages: [3], vision_partial_accepted: true,
    });
    // Rebuilt with no key: the SHX sheets come back textless.
    const res = await ingestKnowledgeDocBatch(asArg(doc));
    expect(res.done).toBe(true);
    expect(docRow()).toMatchObject({ status: "ready", vision_pages: 0, empty_pages: 2, vision_failed_pages: [], vision_partial_accepted: false });
  });

  it("chunks say 'vision' with the model that read them, or 'text'", async () => {
    const doc = await seed([null, prosePage("bolting")]);
    vision.impl = async (page) => ({ text: transcript(page), usage: { inputTokens: 1, outputTokens: 1 }, model: "vision-tier" });
    await ingestKnowledgeDocBatch(asArg(doc), visionCtx());
    const byPage = (p: number) => rowsOf("knowledge_chunks").filter((c) => c.page === p);
    expect(byPage(1).length).toBeGreaterThan(0);
    for (const c of byPage(1)) expect(c).toMatchObject({ source: "vision", source_model: "vision-tier" });
    for (const c of byPage(2)) expect(c).toMatchObject({ source: "text", source_model: null });
  });

  it("a database without the provenance columns still indexes", async () => {
    const doc = await seed([prosePage("bolting")]);
    db.missingColumns.knowledge_chunks = ["source", "source_model"];
    const res = await ingestKnowledgeDocBatch(asArg(doc));
    expect(res.done).toBe(true);
    expect(rowsOf("knowledge_chunks").length).toBeGreaterThan(0);
  });
});

describe("ING-4 / ING-7 — chunker 2 through the engine", () => {
  const TORQUE_TRANSCRIPT = [
    "DRAWING NO: 025-STD-0003", "SHEET: 1 OF 1", "REV: 2",
    "The following torques apply to flanged joints in this service and shall be verified.",
    "TABLE 3 — BOLT TORQUE", "Size | Torque | Notes", '1/2" | 45 ft-lb | dry', '3/4" | 100 ft-lb | dry', '1" | 175 ft-lb | dry',
    "Torques shall be applied in a star pattern in three passes.",
  ].join("\n");
  const library = (chunk_version: number) => { db.tables.knowledge_libraries = [{ id: "kl-1", org_id: "o1", chunk_version }]; };
  // A provision that straddles the page break — the finding's own example.
  const STRADDLE_A: PageSpec = [
    "Welding of low alloy piping shall follow the qualified procedure for the joint.",
    "Preheat shall be maintained at not less than 175F for P-No. 5 materials over",
  ];
  const STRADDLE_B: PageSpec = [
    "1/2 in. nominal thickness, except where the procedure qualification permits a lower value.",
    "Interpass temperature shall not exceed 600F for these materials in any pass.",
  ];
  const WHOLE = "Preheat shall be maintained at not less than 175F for P-No. 5 materials over 1/2 in. nominal thickness, except where the procedure qualification permits a lower value.";
  const contents = () => rowsOf("knowledge_chunks").map((c) => String(c.content));

  it("a vision-read table is ONE chunk with its rows on separate lines; the document is stamped chunker 2", async () => {
    const doc = await seed([null]);
    library(2);
    vision.impl = async () => ({ text: TORQUE_TRANSCRIPT, usage: { inputTokens: 1, outputTokens: 1 }, model: "vision-tier" });
    const res = await ingestKnowledgeDocBatch(asArg(doc), visionCtx());
    expect(res.done).toBe(true);
    const table = contents().filter((c) => c.includes("BOLT TORQUE"));
    expect(table).toHaveLength(1);
    expect(table[0].split("\n")).toEqual([
      "TABLE 3 — BOLT TORQUE", "Size | Torque | Notes", '1/2" | 45 ft-lb | dry', '3/4" | 100 ft-lb | dry', '1" | 175 ft-lb | dry',
    ]);
    expect(docRow().chunk_version).toBe(2);
  });

  it("chunker 1 (every library's default) is unchanged: the same page is one flattened chunk", async () => {
    const doc = await seed([null]);
    library(1);
    vision.impl = async () => ({ text: TORQUE_TRANSCRIPT, usage: { inputTokens: 1, outputTokens: 1 }, model: "vision-tier" });
    await ingestKnowledgeDocBatch(asArg(doc), visionCtx());
    expect(contents().every((c) => !c.includes("\n"))).toBe(true);
    expect(contents().some((c) => c.includes('TABLE 3 — BOLT TORQUE Size | Torque | Notes 1/2" | 45 ft-lb | dry'))).toBe(true);
    expect(docRow().chunk_version).toBe(1);
  });

  it("a sentence straddling a page break appears intact in one chunk under chunker 2 — and in none under chunker 1", async () => {
    let doc = await seed([STRADDLE_A, STRADDLE_B]);
    library(2);
    await ingestKnowledgeDocBatch(asArg(doc));
    const carried = contents().find((c) => c.includes(WHOLE));
    expect(carried).toBeTruthy();
    expect(carried!.startsWith("[cont. from p. 1] Preheat shall be maintained")).toBe(true);
    expect(rowsOf("knowledge_chunks").find((c) => String(c.content) === carried)?.page).toBe(2);

    doc = await seed([STRADDLE_A, STRADDLE_B]);
    library(1);
    await ingestKnowledgeDocBatch(asArg(doc));
    expect(contents().some((c) => c.includes(WHOLE))).toBe(false);
  });

  it("the carried sentence crosses a batch boundary too (read back from the stored last chunk of page 50)", async () => {
    const pages: PageSpec[] = Array.from({ length: 49 }, (_, i) => prosePage(`topic ${i}`));
    pages.push(STRADDLE_A, STRADDLE_B);
    const doc = await seed(pages);
    library(2);
    const first = await ingestKnowledgeDocBatch(asArg(doc));
    expect(first.resumeAt).toBe(50);
    const second = await ingestKnowledgeDocBatch(asArg(docRow()));
    expect(second.done).toBe(true);
    const onPage51 = rowsOf("knowledge_chunks").filter((c) => c.page === 51).map((c) => String(c.content));
    expect(onPage51.some((c) => c.startsWith("[cont. from p. 50]") && c.includes(WHOLE))).toBe(true);
  });

  it("a drawing set carries nothing from sheet to sheet under chunker 2 (vision transcripts and text-layer sheets alike)", async () => {
    // Vision-read SHX sheets: each transcript is a title block and a tag list.
    let doc = await seed([null, null, null]);
    library(2);
    vision.impl = async (page) => ({ text: transcript(page), usage: { inputTokens: 1, outputTokens: 1 }, model: "vision-tier" });
    await ingestKnowledgeDocBatch(asArg(doc), visionCtx());
    expect(docRow().status).toBe("ready");
    expect(contents().some((c) => c.includes("[cont."))).toBe(false);
    for (const sheet of [2, 3]) {
      const onSheet = rowsOf("knowledge_chunks").filter((c) => c.page === sheet).map((c) => String(c.content)).join("\n");
      expect(onSheet).toContain(`V-${100 + sheet}`);
      expect(onSheet).not.toContain(`V-${100 + sheet - 1}`);        // not the previous sheet's tags
      expect(onSheet).not.toContain(`SHEET: ${sheet - 1} OF 3`);    // nor its title block
    }

    // A sheet whose foot is a note that reads like an unfinished sentence is
    // still a sheet: it declared a title block, so nothing leaves it.
    doc = await seed([null, null]);
    library(2);
    vision.impl = async (page) => ({
      text: `${transcript(page)}Notes: All piping shall be hydrotested. Pump P-${200 + page}A discharge continues to the unit header on`,
      usage: { inputTokens: 1, outputTokens: 1 }, model: "vision-tier",
    });
    await ingestKnowledgeDocBatch(asArg(doc), visionCtx());
    expect(contents().some((c) => c.includes("[cont."))).toBe(false);

    // Text-layer sheets (the tags ARE text).
    doc = await seed([drawingSheet(1, ["V-101", "P-201A", "E-301"]), drawingSheet(2, ["V-102", "P-202A", "E-302"])]);
    library(2);
    await ingestKnowledgeDocBatch(asArg(doc));
    expect(contents().some((c) => c.includes("[cont."))).toBe(false);
    expect(rowsOf("knowledge_chunks").filter((c) => c.page === 2).map((c) => String(c.content)).join(" ")).not.toContain("V-101");
  });

  it("a carry is never carried on: a short page that only continues a sentence passes nothing further", async () => {
    const SHORT_B: PageSpec = ["1/2 in. nominal thickness, except where the procedure qualification permits"];
    const PAGE_C: PageSpec = ["a lower value. Interpass temperature shall not exceed 600F for these materials in any pass."];
    const doc = await seed([STRADDLE_A, SHORT_B, PAGE_C]);
    library(2);
    await ingestKnowledgeDocBatch(asArg(doc));
    const markers = contents().map((c) => (c.match(/\[cont\. from p\. \d+\]/g) ?? []).length);
    expect(Math.max(...markers)).toBeLessThanOrEqual(1);
    expect(contents().some((c) => c.includes("[cont. from p. 2] [cont. from p. 1]"))).toBe(false);
  });

  it("a document keeps the chunker it started with when its library switches mid-way", async () => {
    const doc = await seed([STRADDLE_A, STRADDLE_B], { status: "indexing", pages_indexed: 1, page_count: 2, chunk_version: 1 });
    library(2);
    await ingestKnowledgeDocBatch(asArg(doc));
    expect(docRow().chunk_version).toBe(1);
    expect(contents().some((c) => c.startsWith("[cont."))).toBe(false);
  });
});
