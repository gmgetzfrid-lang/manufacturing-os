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
//          and a retry that cannot succeed says so
//   ING-11 empty pages accumulate on the row; GOV-9 each chunk says how its
//          text was obtained

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
  INGEST_LEASE_TTL_MS, visionRetryMessage, type VisionContext,
} from "@/lib/knowledgeIngest";

const DOC = "kd-1";
const baseDoc = (over: Row = {}): Row => ({
  id: DOC, org_id: "o1", library_id: "kl-1", name: "025-PID-0101.pdf", file_key: "orgs/o1/knowledge/kl-1/a.pdf",
  status: "pending", pages_indexed: 0, page_count: null, last_section: null, created_by: "u1", created_at: "2026-09-01",
  source_id: null, source_document_id: null, source_version_id: null, source_rev: null,
  vision_pages: 0, empty_pages: 0, vision_failed_pages: [], vision_partial_accepted: false, chunk_version: null,
  ingest_claimed_by: null, ingest_claimed_at: null, error: null,
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
    const legacyCols = ["ingest_claimed_by", "ingest_claimed_at", "empty_pages", "vision_failed_pages", "vision_partial_accepted", "chunk_version"];
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

  it("the rev-up refresh never lands under a batch holding the claim — it is deferred", async () => {
    const doc = await seed([prosePage("bolting"), prosePage("gaskets")], { source_document_id: "dc-1", source_version_id: "ver-3" });
    let reset: Awaited<ReturnType<typeof resetKnowledgeIndex>> | null = null;
    db.hooks.push((op) => {
      if (reset || op.table !== "knowledge_chunks" || op.kind !== "insert") return;
      // The sync runs while the batch is mid-write.
      void resetKnowledgeIndex([DOC], { rowUpdate: () => ({ file_key: "rev4.pdf", source_version_id: "ver-4" }) })
        .then((r) => { reset = r; });
    });
    const res = await ingestKnowledgeDocBatch(asArg(doc));
    await new Promise((r) => setTimeout(r, 0));
    expect(reset).toEqual({ reset: [], busy: [DOC], errors: [] });
    expect(res.done).toBe(true);
    expect(docRow()).toMatchObject({ status: "ready", source_version_id: "ver-3" });
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
    expect(first.pagesIndexed).toBe(2);                   // 3 reached, 1 waiting on a retry
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

  it("a retry pass in which every page fails again says so instead of parking the document", async () => {
    const doc = await seed([null, prosePage("bolting")], { status: "indexing", pages_indexed: 2, page_count: 2, vision_failed_pages: [1] });
    vision.impl = async () => { throw new Error("provider 500"); };
    await expect(ingestKnowledgeDocBatch(asArg(doc), visionCtx())).rejects.toThrow(
      visionRetryMessage([1], "provider 500"),
    );
    expect(docRow().ingest_claimed_by).toBeNull();
  });

  it("a retry with no AI key names what is needed", async () => {
    const doc = await seed([null], { status: "indexing", pages_indexed: 1, page_count: 1, vision_failed_pages: [1] });
    await expect(ingestKnowledgeDocBatch(asArg(doc))).rejects.toThrow(/retrying needs an AI key/);
  });

  it("an accepted partial index is 'ready' with the unread pages still listed", async () => {
    const doc = await seed([null], { status: "indexing", pages_indexed: 1, page_count: 1, vision_failed_pages: [1], vision_partial_accepted: true });
    const res = await ingestKnowledgeDocBatch(asArg(doc));
    expect(res.done).toBe(true);
    expect(docRow()).toMatchObject({ status: "ready", vision_failed_pages: [1] });
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

  it("a document keeps the chunker it started with when its library switches mid-way", async () => {
    const doc = await seed([STRADDLE_A, STRADDLE_B], { status: "indexing", pages_indexed: 1, page_count: 2, chunk_version: 1 });
    library(2);
    await ingestKnowledgeDocBatch(asArg(doc));
    expect(docRow().chunk_version).toBe(1);
    expect(contents().some((c) => c.startsWith("[cont."))).toBe(false);
  });
});
