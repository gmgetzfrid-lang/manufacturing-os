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
//   ING-9  the drain refuses a non-PDF the same way the route does — and
//          refuses nothing on a row re-pointed since the file was checked
//   ING-1  a batch a rev-up superseded that then fails for real stamps
//          nothing on the new revision and leaves none of its rows; the
//          drain counts a vision retry's re-read pages as progress (ING-6)
//   ING-3  a new index generation's first batch clears everything the last
//          one left; ING-7 the carry never touches a drawing sheet

import { describe, it, expect, vi, beforeEach } from "vitest";
import { db, resetDb, rowsOf, type Op, type Row } from "./knowledgeFakeDb";
import { makePdf, drawingSheet, prosePage, type PageSpec } from "./knowledgePdfFixtures";
import { meter, resetMeter } from "./helpers/fakeUsageMeter";

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
// The ledger stand-in (GOV-13 / GOV-5): the drain reserves every page's AI
// vision call against the uploader's cap; cap 0 = no cap here, as before.
vi.mock("@/lib/ai/usageServer", async () => (await import("./helpers/fakeUsageMeter")).fakeUsageServer());
vi.mock("@/lib/aiInstructionsServer", () => ({ loadOrgInstructionsBlock: vi.fn(async () => "") }));
vi.mock("@/lib/ai/keyVault", () => ({ openAiKey: (k: string) => k }));

import {
  ingestKnowledgeDocBatch, drainKnowledgeIngestQueue, claimIngestLease, resetKnowledgeIndex,
  INGEST_LEASE_TTL_MS, VISION_RETRY_BACKOFF_MS, visionRetryMessage, type VisionContext,
  INGEST_FAILURE_MAX_ATTEMPTS, ingestFailureBackoffMs, markIngestFailed, failureBackoffUntil, ingestFailureMessage,
  IngestBatchError, refuseNonPdf, OWES_EVERY_VISION_PAGE, visionPageWorstCaseUsd, VISION_PAGE_MAX_TOKENS,
} from "@/lib/knowledgeIngest";
import { AGREEMENT_VERSION, estimateCostUsd } from "@/lib/ai/pricing";
import { indexDocumentMentions, withoutCarriedSentence } from "@/lib/mentionIndexer";

const DOC = "kd-1";
const baseDoc = (over: Row = {}): Row => ({
  id: DOC, org_id: "o1", library_id: "kl-1", name: "025-PID-0101.pdf", file_key: "orgs/o1/knowledge/kl-1/a.pdf",
  status: "pending", pages_indexed: 0, page_count: null, last_section: null, created_by: "u1", created_at: "2026-09-01",
  source_id: null, source_document_id: null, source_version_id: null, source_rev: null,
  vision_pages: 0, empty_pages: 0, vision_failed_pages: [], vision_partial_accepted: false, chunk_version: null,
  vision_retry_after: null, vision_retry_tried: [], ingest_failures: 0, ingest_claimed_by: null, ingest_claimed_at: null, error: null,
  ...over,
});
const docRow = () => rowsOf("knowledge_documents").find((r) => r.id === DOC)!;
const pageListOf = (v: unknown) => [...(v as number[])].sort((a, b) => a - b);
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
  resetMeter();
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
    // How long that claim can still stand — the whole TTL for a fresh one.
    expect(res.retryAfterMs).toBeGreaterThan(INGEST_LEASE_TTL_MS - 5_000);
    expect(res.retryAfterMs).toBeLessThanOrEqual(INGEST_LEASE_TTL_MS);
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
    const legacyCols = ["ingest_claimed_by", "ingest_claimed_at", "empty_pages", "vision_failed_pages", "vision_partial_accepted", "chunk_version", "vision_retry_after", "vision_retry_tried", "ingest_failures"];
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

describe("ING-1 — a superseded batch's failure never lands on the new revision", () => {
  const REV4 = { file_key: "orgs/o1/dc/rev4.pdf", source_version_id: "ver-4", source_rev: "4" };
  const mirrorAtRev3 = () => seed([drawingSheet(1, ["V-101", "P-201A", "E-301"]), drawingSheet(2, ["V-102", "P-202A", "E-302"])], {
    status: "stale", source_id: "src-1", source_document_id: "dc-1", source_version_id: "ver-3", source_rev: "3",
  });
  const entityInsertFails = () => db.hooks.push((op) => op.table === "knowledge_page_entities" && op.kind === "insert"
    ? { error: { code: "08006", message: "connection reset by peer" } } : undefined);

  it("the cron drain: a Rev 3 batch superseded mid-flight hits a real failure — the Rev 4 row stays queued, not 'error', with none of Rev 3's rows", async () => {
    await mirrorAtRev3();
    // The rev-up lands just before the batch writes its chunks; its entity
    // insert then fails on a transient error.
    let reset: Awaited<ReturnType<typeof resetKnowledgeIndex>> | null = null;
    db.asyncHooks.push(async (op) => {
      if (reset || op.table !== "knowledge_chunks" || op.kind !== "insert") return;
      reset = await resetKnowledgeIndex([DOC], {
        purgeLineTraces: true, supersedeBusy: true,
        expect: () => ({ source_version_id: "ver-3" }), rowUpdate: () => REV4,
      });
    });
    entityInsertFails();
    const out = await drainKnowledgeIngestQueue({ maxPages: 100, deadlineMs: Date.now() + 30_000 });
    expect(reset).toEqual({ reset: [DOC], busy: [], errors: [] });
    expect(out.errors.join(" ")).toMatch(/entity insert failed: connection reset by peer/);
    // It used to write {status:'error'} onto the Rev 4 row by id alone —
    // out of Ask and out of every queue until a person re-ran it.
    expect(docRow()).toMatchObject({ status: "stale", error: null, pages_indexed: 0, ...REV4, ingest_claimed_by: null });
    // …and the Rev 3 chunks it wrote after the reset are withdrawn with it.
    expect(rowsOf("knowledge_chunks")).toHaveLength(0);
    expect(rowsOf("knowledge_page_entities")).toHaveLength(0);
  });

  it("a real failure on the row the batch read is recorded on that document, with the message — and retried, not parked", async () => {
    await mirrorAtRev3();
    entityInsertFails();
    const out = await drainKnowledgeIngestQueue({ maxPages: 100, deadlineMs: Date.now() + 30_000 });
    expect(out.errors).toHaveLength(1);
    // Nothing indexed yet: it stays queued ('stale'), counted, backing off.
    expect(docRow()).toMatchObject({ status: "stale", source_version_id: "ver-3", pages_indexed: 0, ingest_failures: 1 });
    // It says when honestly: no sooner than the back-off, and on the next
    // indexing pass — an open controller tab, or the nightly cron.
    expect(String(docRow().error)).toMatch(/^entity insert failed: connection reset by peer — attempt 1 of 3\. Indexing is tried again automatically on the next indexing pass \(while an Admin or Doc Control member has the app open, or the nightly maintenance run where the library can be indexed unattended\), no sooner than about 10 minutes from now\.$/);
    expect(Date.parse(String(docRow().vision_retry_after))).toBeGreaterThan(Date.now());
    // A failed batch writes nothing: its chunks went with it.
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

  // knowledge_search / semantic_search return documents in ('ready','indexing').
  const retrievable = () => ["ready", "indexing"].includes(String(docRow().status)) && rowsOf("knowledge_chunks").length > 0;
  /** A document being indexed: its first two sheets indexed and searchable,
   *  the third still to read. */
  const midway = async () => {
    await seed([drawingSheet(1, ["V-101", "P-201A", "E-301"]), drawingSheet(2, ["V-102", "P-202A", "E-302"]), drawingSheet(3, ["V-103", "P-203A", "E-303"])], {
      status: "indexing", pages_indexed: 2, page_count: 3,
    });
    db.tables.knowledge_chunks = [1, 2].map((p) => ({ id: `c${p}`, document_id: DOC, org_id: "o1", library_id: "kl-1", page: p, seq: 0, content: `sheet ${p}` }));
  };
  const backoffLapses = () => { docRow().vision_retry_after = new Date(Date.now() - 1000).toISOString(); };

  it("a transient entity failure leaves the document retrievable, and a later drain run completes it", async () => {
    await midway();
    let failing = true;
    db.hooks.push((op) => failing && op.table === "knowledge_page_entities" && op.kind === "insert"
      ? { error: { code: "08006", message: "connection reset by peer" } } : undefined);
    const first = await drainKnowledgeIngestQueue({ maxPages: 100, deadlineMs: Date.now() + 30_000 });
    expect(first.errors.join(" ")).toMatch(/entity insert failed: connection reset by peer/);
    // It used to be 'error' — out of Ask, out of every queue — until a person
    // re-ran it. Now it stays 'indexing' (its first two sheets in Ask), with
    // the failure, the count and a back-off on the row.
    expect(docRow()).toMatchObject({ status: "indexing", pages_indexed: 2, ingest_failures: 1, ingest_claimed_by: null });
    expect(String(docRow().error)).toMatch(/^entity insert failed: connection reset by peer — attempt 1 of 3\. Indexing is tried again automatically on the next indexing pass \(.*nightly maintenance run where the library can be indexed unattended\), no sooner than about 10 minutes from now\. The pages indexed so far stay searchable meanwhile\.$/);
    expect(Date.parse(String(docRow().vision_retry_after))).toBeGreaterThanOrEqual(Date.now() + ingestFailureBackoffMs(1) - 5_000);
    expect(retrievable()).toBe(true);

    // A run inside the back-off does nothing (no download, no write).
    failing = false;
    const before = JSON.stringify(docRow());
    r2.objects.clear();
    const second = await drainKnowledgeIngestQueue({ maxPages: 100, deadlineMs: Date.now() + 30_000 });
    expect(second).toMatchObject({ pagesIndexed: 0, completed: 0, errors: [] });
    expect(JSON.stringify(docRow())).toBe(before);

    // Once it lapses, the next run finishes the document and clears the record.
    r2.objects.set(String(docRow().file_key), await makePdf([drawingSheet(1, ["V-101", "P-201A", "E-301"]), drawingSheet(2, ["V-102", "P-202A", "E-302"]), drawingSheet(3, ["V-103", "P-203A", "E-303"])]));
    backoffLapses();
    const third = await drainKnowledgeIngestQueue({ maxPages: 100, deadlineMs: Date.now() + 30_000 });
    expect(third).toMatchObject({ completed: 1, errors: [] });
    expect(docRow()).toMatchObject({ status: "ready", error: null, ingest_failures: 0, vision_retry_after: null, pages_indexed: 3 });
    expect(rowsOf("knowledge_page_entities").some((e) => e.page === 3 && e.tag === "V-103")).toBe(true);
  });

  it("the interactive driver honours the back-off too: nothing is downloaded, and the reason comes back", async () => {
    await midway();
    Object.assign(docRow(), {
      ingest_failures: 1, error: "entity insert failed: connection reset by peer — attempt 1 of 3. Indexing is tried again automatically on the next indexing pass, no sooner than about 10 minutes from now.",
      vision_retry_after: new Date(Date.now() + 600_000).toISOString(),
    });
    r2.objects.clear();
    const res = await ingestKnowledgeDocBatch(asArg(docRow()));
    expect(res).toMatchObject({ failureRetryBlocked: true, done: false, busy: false, superseded: false });
    expect(res.failureRetryMessage).toMatch(/^entity insert failed/);
    expect(res.failureRetryAfter).toBe(docRow().vision_retry_after);
    expect(docRow()).toMatchObject({ status: "indexing", ingest_claimed_by: null, ingest_failures: 1 });
  });

  it("a failure that keeps failing is retried a bounded number of times, then the document is 'error' for a person", async () => {
    await midway();
    db.hooks.push((op) => op.table === "knowledge_page_entities" && op.kind === "insert"
      ? { error: { code: "08006", message: "connection reset by peer" } } : undefined);
    for (let attempt = 1; attempt <= INGEST_FAILURE_MAX_ATTEMPTS; attempt++) {
      if (attempt > 1) backoffLapses();
      await drainKnowledgeIngestQueue({ maxPages: 100, deadlineMs: Date.now() + 30_000 });
      expect(docRow().ingest_failures).toBe(attempt);
      expect(docRow().status).toBe(attempt < INGEST_FAILURE_MAX_ATTEMPTS ? "indexing" : "error");
    }
    expect(String(docRow().error)).toMatch(/^entity insert failed: connection reset by peer — indexing failed 3 times in a row; re-run it once the cause is fixed\.$/);
    expect(docRow().vision_retry_after).toBeNull();
    // An 'error' document is out of every automatic queue: nothing retries it.
    const after = await drainKnowledgeIngestQueue({ maxPages: 100, deadlineMs: Date.now() + 30_000 });
    expect(after.docsTouched).toBe(0);
  });

  it("a committed batch clears an earlier failure's count", async () => {
    await midway();
    Object.assign(docRow(), { ingest_failures: 2, error: "earlier", vision_retry_after: new Date(Date.now() - 1000).toISOString() });
    const res = await ingestKnowledgeDocBatch(asArg(docRow()));
    expect(res.done).toBe(true);
    expect(docRow()).toMatchObject({ status: "ready", ingest_failures: 0, error: null, vision_retry_after: null });
  });

  // The bound is real only if nothing but work clears the count (review fix
  // pass 4: a no-op commit and a keyless park used to zero it, so a failure
  // that persists was retried — and its vision pages re-billed — without end).
  const attempt2 = "entity insert failed: connection reset by peer — attempt 2 of 3. Indexing is tried again automatically on the next indexing pass, no sooner than about 30 minutes from now.";

  it("a batch that stops for time before its first page did nothing: the failure's count, message and back-off stay, and the next failure is the third", async () => {
    // The reviewer's probe: a lapsed back-off, and the next page needs AI
    // vision with 10 s left — the cron drain's tail, or the route after a
    // busy wait. The page is never started.
    await seed([drawingSheet(1, ["V-101", "P-201A", "E-301"]), drawingSheet(2, ["V-102", "P-202A", "E-302"]), null], {
      status: "indexing", pages_indexed: 2, page_count: 3,
    });
    db.tables.knowledge_chunks = [1, 2].map((p) => ({ id: `c${p}`, document_id: DOC, org_id: "o1", library_id: "kl-1", page: p, seq: 0, content: `sheet ${p}` }));
    const lapsed = new Date(Date.now() - 1000).toISOString();
    Object.assign(docRow(), { ingest_failures: 2, error: attempt2, vision_retry_after: lapsed });
    vision.impl = async (page) => ({ text: transcript(page), usage: { inputTokens: 1, outputTokens: 1 }, model: "vision-tier" });
    const res = await ingestKnowledgeDocBatch(asArg(docRow()), visionCtx(), Date.now() + 10_000);
    expect(res).toMatchObject({ stoppedForTime: true, resumeAt: 2, done: false, visionPages: 0 });
    expect(vision.calls).toEqual([]);
    // It used to commit ingest_failures 0 and error null: the record gone,
    // and the bound restarted, with no retry having run.
    expect(docRow()).toMatchObject({
      status: "indexing", pages_indexed: 2, ingest_failures: 2, error: attempt2, vision_retry_after: lapsed, ingest_claimed_by: null,
    });
    // So the next real failure is the third in a row: 'error', for a person.
    db.hooks.push((op) => op.table === "knowledge_page_entities" && op.kind === "insert"
      ? { error: { code: "08006", message: "connection reset by peer" } } : undefined);
    const failed = await ingestKnowledgeDocBatch(asArg(docRow()), visionCtx()).then(() => null, (e: unknown) => e);
    expect(failed).toBeInstanceOf(Error);
    expect(await markIngestFailed(asArg(docRow()), failed)).toMatchObject({ marked: true, retryAfter: null });
    expect(docRow()).toMatchObject({ status: "error", ingest_failures: 3, vision_retry_after: null });
  });

  it("a driver without a key parking the document between failed retry batches never resets the count: the third failure is 'error', after three vision reads", async () => {
    // The reviewer's other probe: a document at its vision-retry stage whose
    // chunk insert fails every time, driven alternately by a controller with
    // a key and a tab without one. It used to go on for ever — every with-key
    // attempt re-billing the page, every keyless park zeroing the count.
    await seed([null, prosePage("bolting")], { status: "indexing", pages_indexed: 2, page_count: 2, vision_failed_pages: [1] });
    db.tables.knowledge_chunks = [{ id: "c-2", document_id: DOC, org_id: "o1", library_id: "kl-1", page: 2, seq: 0, content: "bolting text" }];
    vision.impl = async (page) => ({ text: transcript(page), usage: { inputTokens: 1, outputTokens: 1 }, model: "vision-tier" });
    db.hooks.push((op) => op.table === "knowledge_chunks" && op.kind === "insert"
      ? { error: { code: "08006", message: "connection reset by peer" } } : undefined);
    for (let attempt = 1; attempt <= INGEST_FAILURE_MAX_ATTEMPTS; attempt++) {
      const failed = await ingestKnowledgeDocBatch(asArg(docRow()), visionCtx()).then(() => null, (e: unknown) => e);
      expect(String((failed as Error).message)).toMatch(/chunk insert failed: connection reset by peer/);
      await markIngestFailed(asArg(docRow()), failed);
      expect(docRow().ingest_failures).toBe(attempt);
      if (attempt === INGEST_FAILURE_MAX_ATTEMPTS) break;
      backoffLapses();
      // The keyless tab: it says why on the row — and keeps the count.
      const parked = await ingestKnowledgeDocBatch(asArg(docRow()));
      expect(parked.visionRetryBlocked).toBe(true);
      expect(docRow()).toMatchObject({ status: "indexing", ingest_failures: attempt });
      expect(String(docRow().error)).toMatch(/retrying needs an AI key/);
    }
    expect(vision.calls).toEqual([1, 1, 1]);
    expect(docRow()).toMatchObject({ status: "error", ingest_failures: 3, vision_retry_after: null });
  });

  it("a retry pass with no page left to try this round parks without clearing a failed batch's count", async () => {
    await seed([null, prosePage("bolting")], {
      status: "indexing", pages_indexed: 2, page_count: 2, vision_failed_pages: [1], vision_retry_tried: [1],
      ingest_failures: 1, error: "chunk insert failed: connection reset by peer — attempt 1 of 3.", vision_retry_after: new Date(Date.now() - 1000).toISOString(),
    });
    vision.impl = async (page) => ({ text: transcript(page), usage: { inputTokens: 1, outputTokens: 1 }, model: "vision-tier" });
    const res = await ingestKnowledgeDocBatch(asArg(docRow()), visionCtx());
    expect(res.visionRetryBlocked).toBe(true);
    expect(vision.calls).toEqual([]);
    expect(docRow()).toMatchObject({ ingest_failures: 1, vision_retry_tried: [], status: "indexing" });
    // The stamp it wrote is the vision retry's round back-off, and the row
    // now carries the vision retry's reason: it is reported as that — never
    // as the failed batch's back-off, which it is not (review fix pass 5).
    expect(Date.parse(String(docRow().vision_retry_after))).toBeGreaterThan(Date.now());
    expect(failureBackoffUntil(docRow())).toBeNull();
    const next = await ingestKnowledgeDocBatch(asArg(docRow()), visionCtx());
    expect(next).toMatchObject({ visionRetryBlocked: true, failureRetryBlocked: false, visionRetryMessage: docRow().error });
    // A person's re-run is for a failed batch's back-off only: a vision
    // retry's own is not skipped (the route records nothing for it).
    const rerun = await ingestKnowledgeDocBatch(asArg(docRow()), visionCtx(), undefined, { retryNow: true });
    expect(rerun).toMatchObject({ visionRetryBlocked: true, failureRetryBlocked: false });
    expect(vision.calls).toEqual([]);
  });

  it("a person's explicit re-run (retryNow) skips the back-off; no automatic driver does", async () => {
    await midway();
    const until = new Date(Date.now() + 600_000).toISOString();
    Object.assign(docRow(), { ingest_failures: 1, error: "entity insert failed: connection reset by peer — attempt 1 of 3.", vision_retry_after: until });
    expect(failureBackoffUntil(docRow())).toBe(until);
    const blocked = await ingestKnowledgeDocBatch(asArg(docRow()));
    expect(blocked).toMatchObject({ failureRetryBlocked: true, failureRetryAfter: until });
    const res = await ingestKnowledgeDocBatch(asArg(docRow()), undefined, undefined, { retryNow: true });
    expect(res.done).toBe(true);
    expect(docRow()).toMatchObject({ status: "ready", ingest_failures: 0, error: null, vision_retry_after: null });
  });

  it("a person's re-run of a failed vision-retry batch (retryNow) performs the retry: the failure's back-off shares the vision column and holds it at neither gate", async () => {
    // The reviewer's probe P1: the main pass is through, the retry batch read
    // page 1 and then its chunk insert failed. markIngestFailed stamped the
    // ING-8 back-off on vision_retry_after — the column the vision-retry
    // gate reads. The re-run used to be audited by the route and then
    // refused by that second gate, with no vision call.
    const until = new Date(Date.now() + ingestFailureBackoffMs(1)).toISOString();
    await seed([null, prosePage("bolting")], {
      status: "indexing", pages_indexed: 2, page_count: 2, vision_failed_pages: [1], ingest_failures: 1,
      error: ingestFailureMessage("chunk insert failed: connection reset by peer", 1, ingestFailureBackoffMs(1), true),
      vision_retry_after: until,
    });
    db.tables.knowledge_chunks = [{ id: "c-2", document_id: DOC, org_id: "o1", library_id: "kl-1", page: 2, seq: 0, content: "bolting text" }];
    vision.impl = async (page) => ({ text: transcript(page), usage: { inputTokens: 1, outputTokens: 1 }, model: "vision-tier" });
    expect(failureBackoffUntil(docRow())).toBe(until);
    // Every automatic driver waits it out, as the failed batch's back-off.
    const waits = await ingestKnowledgeDocBatch(asArg(docRow()), visionCtx());
    expect(waits).toMatchObject({ failureRetryBlocked: true, visionRetryBlocked: false, failureRetryAfter: until });
    expect(vision.calls).toEqual([]);
    // The person's re-run reads the page now and completes the document.
    const res = await ingestKnowledgeDocBatch(asArg(docRow()), visionCtx(), undefined, { retryNow: true });
    expect(res).toMatchObject({ done: true, visionRetryBlocked: false, failureRetryBlocked: false, visionFailedPages: [] });
    expect(vision.calls).toEqual([1]);
    expect(docRow()).toMatchObject({ status: "ready", ingest_failures: 0, error: null, vision_retry_after: null, vision_failed_pages: [] });
    expect(rowsOf("knowledge_page_entities").some((e) => e.page === 1 && e.tag === "V-101")).toBe(true);
  });

  /** A failed vision-retry batch: page 1 waits on AI vision, and the retry
   *  batch that read it failed at its chunk insert (the ING-8 back-off on
   *  vision_retry_after). */
  const failedRetryBatch = async () => {
    const until = new Date(Date.now() + ingestFailureBackoffMs(1)).toISOString();
    const error = ingestFailureMessage("chunk insert failed: connection reset by peer", 1, ingestFailureBackoffMs(1), true);
    await seed([null, prosePage("bolting")], {
      status: "indexing", pages_indexed: 2, page_count: 2, vision_failed_pages: [1], ingest_failures: 1, error, vision_retry_after: until,
    });
    db.tables.knowledge_chunks = [{ id: "c-2", document_id: DOC, org_id: "o1", library_id: "kl-1", page: 2, seq: 0, content: "bolting text" }];
    return { until, error };
  };

  it("a person's re-run with no key that can read the waiting pages is refused and writes nothing: the failure's record stays, and nothing is recorded", async () => {
    // The reviewer's probe K1, at the engine: a controller with no AI key (or
    // at the monthly cap — the route then builds no vision context either)
    // re-runs a failed vision-retry batch. The engine used to let it past
    // both gates and park it: the keyless message over the failure's cause,
    // the back-off erased to now — after the route had recorded the re-run.
    const { until, error } = await failedRetryBatch();
    r2.objects.clear();                                   // proves nothing is downloaded
    const recorded: string[] = [];
    const res = await ingestKnowledgeDocBatch(asArg(docRow()), undefined, undefined, {
      retryNow: true, onRetryNow: async (_row, at) => { recorded.push(at); return null; },
    });
    expect(res).toMatchObject({ failureRetryBlocked: true, visionRetryBlocked: false, failureRetryAfter: until, done: false });
    expect(res.failureRetryMessage).toBe(visionRetryMessage([1], null));
    expect(recorded).toEqual([]);
    expect(docRow()).toMatchObject({
      status: "indexing", error, vision_retry_after: until, ingest_failures: 1, vision_failed_pages: [1], ingest_claimed_by: null,
    });
    expect(failureBackoffUntil(docRow())).toBe(until);
  });

  it("a re-run is recorded only when it is performed: never while another driver holds the claim, and a record that fails runs nothing", async () => {
    const { until, error } = await failedRetryBatch();
    vision.impl = async (page) => ({ text: transcript(page), usage: { inputTokens: 1, outputTokens: 1 }, model: "vision-tier" });
    const recorded: Array<{ at: string; error: unknown }> = [];
    let refuse: string | null = null;
    const opts = {
      retryNow: true,
      onRetryNow: async (row: Row, at: string) => { recorded.push({ at, error: row.error }); return refuse; },
    };
    // Another driver holds the claim: `busy`, and nothing is recorded.
    Object.assign(docRow(), { ingest_claimed_by: "ingest:other-tab", ingest_claimed_at: new Date().toISOString() });
    const busy = await ingestKnowledgeDocBatch(asArg(docRow()), visionCtx(), undefined, opts);
    expect(busy.busy).toBe(true);
    expect(recorded).toEqual([]);
    // The claim is free, but the record cannot be written: nothing runs.
    Object.assign(docRow(), { ingest_claimed_by: null, ingest_claimed_at: null });
    refuse = "permission denied for table audit_logs";
    const unrecorded = await ingestKnowledgeDocBatch(asArg(docRow()), visionCtx(), undefined, opts);
    expect(unrecorded).toMatchObject({ retryNowError: refuse, done: false, failureRetryBlocked: false, visionRetryBlocked: false });
    expect(vision.calls).toEqual([]);
    expect(docRow()).toMatchObject({ status: "indexing", error, vision_retry_after: until, ingest_failures: 1, ingest_claimed_by: null });
    // An empty answer is not a record either: it refuses too (integration, I-06 merge).
    refuse = "";
    const blank = await ingestKnowledgeDocBatch(asArg(docRow()), visionCtx(), undefined, opts);
    expect(blank).toMatchObject({ retryNowError: "the record failed", done: false });
    expect(vision.calls).toEqual([]);
    // Recorded once, with the row as claimed, and then performed.
    refuse = null;
    recorded.length = 0;
    const res = await ingestKnowledgeDocBatch(asArg(docRow()), visionCtx(), undefined, opts);
    expect(recorded).toEqual([{ at: until, error }]);
    expect(res).toMatchObject({ done: true, retryNowError: null });
    expect(vision.calls).toEqual([1]);
    expect(docRow()).toMatchObject({ status: "ready", ingest_failures: 0, error: null, vision_retry_after: null });
  });

  it("a long cause never pushes the attempt count or the cadence out of the stored message", async () => {
    // A withdrawal note can make the cause run to hundreds of characters;
    // the row's error holds 500. The cause is cut (and marked), never what
    // the person is told to expect — and never mid-pair of a surrogate.
    // The cut falls between the two halves of a surrogate pair (a symbol a
    // provider or a file name can carry): it moves back to keep the pair whole.
    const tool = "\u{1F527}";
    const cause = `chunk insert failed: ${"x".repeat(156)}${tool.repeat(62)}; and rows this batch wrote could not be withdrawn: 30 knowledge_chunks rows — the document was re-queued for a full re-index`;
    expect(cause.length).toBeGreaterThan(400);
    const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    await midway();
    expect(await markIngestFailed(asArg(docRow()), new Error(cause))).toMatchObject({ marked: true });
    const stored = String(docRow().error);
    expect(stored.length).toBeLessThanOrEqual(500);
    expect(stored).toMatch(/^chunk insert failed: x{156}(?:\uD83D\uDD27){6}… — attempt 1 of 3\. Indexing is tried again automatically on the next indexing pass \(.*\), no sooner than about 10 minutes from now\. The pages indexed so far stay searchable meanwhile\.$/);
    expect(stored).not.toMatch(lone);
    // …so the back-off still holds while the message is the failure's.
    expect(failureBackoffUntil(docRow())).toBe(docRow().vision_retry_after);
    // A short cause is stored whole, exactly as before.
    expect(ingestFailureMessage("entity insert failed: boom", 2, ingestFailureBackoffMs(2), false))
      .toBe("entity insert failed: boom — attempt 2 of 3. Indexing is tried again automatically on the next indexing pass (while an Admin or Doc Control member has the app open, or the nightly maintenance run where the library can be indexed unattended), no sooner than about 30 minutes from now.");
    // At the bound, the instruction to re-run survives the same way.
    Object.assign(docRow(), { ingest_failures: 2, vision_retry_after: null });
    await markIngestFailed(asArg(docRow()), new Error(`entity insert failed: ${"x".repeat(405)}${tool.repeat(40)} and more`));
    const atBound = String(docRow().error);
    expect(docRow()).toMatchObject({ status: "error", ingest_failures: 3 });
    expect(atBound.length).toBeLessThanOrEqual(500);
    expect(atBound).toMatch(/^entity insert failed: x{405}… — indexing failed 3 times in a row; re-run it once the cause is fixed\.$/);
    expect(atBound).not.toMatch(lone);
    // The vision retry's reason keeps its cadence and its way out too.
    const vmsg = visionRetryMessage([1, 2, 3], `provider 529 overloaded: ${"y".repeat(400)}`);
    expect(vmsg.length).toBeLessThanOrEqual(500);
    expect(vmsg).toMatch(/^AI vision could not read 3 pages \(p\. 1, 2, 3\): provider 529 overloaded: y+…\. They are tried again automatically .*no sooner than about 30 minutes from now\. .*ask an admin to accept the partial index\.$/);

    // The messages written whole are cut surrogate-safe too: a cut at 500
    // that splits a pair leaves a lone surrogate, which Postgres refuses in
    // the JSON body — the failure would never be recorded, and every driver
    // would retry it without bound. Each cause below has a pair at 499/500.
    const straddling = `${"x".repeat(499)}${tool}${"z".repeat(40)}`;
    expect(straddling.slice(0, 500)).toMatch(lone);
    // A damaged PDF (permanent): straight to 'error', with its cause.
    Object.assign(docRow(), { status: "indexing", ingest_failures: 0, error: null, vision_retry_after: null });
    const read = { fileKey: String(docRow().file_key), sourceVersionId: null, pagesIndexed: 2, status: "indexing", failures: 0 };
    expect(await markIngestFailed(asArg(docRow()), new IngestBatchError(straddling, read, true))).toMatchObject({ marked: true });
    expect(docRow()).toMatchObject({ status: "error", ingest_failures: 1 });
    expect(String(docRow().error)).toBe(`${"x".repeat(499)}…`);
    // A database without 20261122 (nowhere to count): 'error' with the cause.
    const legacyCols = ["ingest_claimed_by", "ingest_claimed_at", "empty_pages", "vision_failed_pages", "vision_partial_accepted", "chunk_version", "vision_retry_after", "vision_retry_tried", "ingest_failures"];
    const legacy = Object.fromEntries(Object.entries({ ...docRow(), status: "indexing", error: null }).filter(([k]) => !legacyCols.includes(k)));
    db.tables.knowledge_documents = [{ ...legacy }];
    db.missingColumns.knowledge_documents = legacyCols;
    expect(await markIngestFailed(asArg(legacy), new Error(straddling))).toMatchObject({ marked: true });
    expect(docRow()).toMatchObject({ status: "error" });
    expect(String(docRow().error)).toBe(`${"x".repeat(499)}…`);
    // A mirrored file that is not a PDF: marked with the refusal, whose
    // file name puts a pair across the cut.
    db.missingColumns = {};
    const prefix = 'Only PDF files can be indexed — "';
    const name = `${"n".repeat(499 - prefix.length)}${tool}.xlsx`;
    expect(`${prefix}${name}`.slice(0, 500)).toMatch(lone);
    db.tables.knowledge_documents = [baseDoc({ name, source_id: "src-1", source_document_id: "dc-1", file_key: "orgs/o1/dc/list.xlsx" })];
    expect(await refuseNonPdf(docRow(), "office", null)).toMatchObject({ superseded: false, error: null });
    expect(docRow()).toMatchObject({ status: "error" });
    expect(String(docRow().error)).toBe(`${prefix}${"n".repeat(499 - prefix.length)}`);
  });

  it("a failure record another writer cleared holds nothing back: the drawing rebuild's own reset nulls the message, and the rebuilt index runs", async () => {
    // What app/api/knowledge/drawing/route.ts writes today (I-07's file):
    // status, pages_indexed, page_count, last_section and error — not the
    // count, not the back-off.
    await seed([drawingSheet(1, ["V-101", "P-201A", "E-301"]), drawingSheet(2, ["V-102", "P-202A", "E-302"])], {
      status: "stale", pages_indexed: 0, page_count: null, last_section: null, error: null,
      ingest_failures: 2, vision_retry_after: new Date(Date.now() + 600_000).toISOString(),
    });
    expect(failureBackoffUntil(docRow())).toBeNull();
    const res = await ingestKnowledgeDocBatch(asArg(docRow()));
    expect(res).toMatchObject({ done: true, failureRetryBlocked: false });
    expect(docRow()).toMatchObject({ status: "ready", ingest_failures: 0, vision_retry_after: null });
  });

  it("a failed library read never picks the chunker: the batch stops (and is retried) rather than stamping chunker 1", async () => {
    const doc = await tagged();
    db.tables.knowledge_libraries = [{ id: "kl-1", org_id: "o1", chunk_version: 2 }];
    db.hooks.push((op) => op.table === "knowledge_libraries" && op.kind === "select"
      ? { error: { code: "57014", message: "canceling statement due to statement timeout" } } : undefined);
    await expect(ingestKnowledgeDocBatch(asArg(doc))).rejects.toThrow(/library chunker could not be read: canceling statement/);
    expect(docRow()).toMatchObject({ pages_indexed: 0, chunk_version: null, status: "pending" });
    expect(rowsOf("knowledge_chunks")).toHaveLength(0);
    // Only a database without the column falls back to chunker 1.
    db.hooks = [];
    db.missingColumns.knowledge_libraries = ["chunk_version"];
    const res = await ingestKnowledgeDocBatch(asArg(docRow()));
    expect(res.done).toBe(true);
    expect(docRow().chunk_version).toBe(1);
  });
});

describe("ING-1 — a withdrawal that fails is said, never dropped", () => {
  const withdrawalFails = () => db.hooks.push((op, filters) =>
    op.kind === "delete" && (op.table === "knowledge_chunks" || op.table === "knowledge_page_entities") && filters.some((f) => f.op === "in" && f.col === "id")
      ? { error: { code: "57014", message: "canceling statement due to statement timeout" } } : undefined);

  it("claimed: a superseded batch whose withdrawal fails reports it (and retries each delete once); the re-pointed row is never errored", async () => {
    const doc = await seed([drawingSheet(1, ["V-101", "P-201A", "E-301"]), prosePage("bolting")],
      { source_document_id: "dc-1", source_version_id: "ver-3", source_rev: "3" });
    let fired = false;
    db.hooks.push((op) => {
      if (fired || op.table !== "knowledge_chunks" || op.kind !== "insert") return;
      fired = true;
      Object.assign(docRow(), { file_key: "orgs/o1/dc/rev4.pdf", source_version_id: "ver-4", source_rev: "4", pages_indexed: 0, page_count: null, status: "stale" });
    });
    withdrawalFails();
    await expect(ingestKnowledgeDocBatch(asArg(doc))).rejects.toThrow(/rows this batch wrote could not be withdrawn: \d+ knowledge_chunks rows: canceling statement/);
    // Each failed delete was tried twice.
    const withdrawals = db.ops.filter((o) => o.kind === "delete" && o.table === "knowledge_chunks" && o.filters.some((f) => f.op === "in"));
    expect(withdrawals).toHaveLength(2);
    expect(docRow()).toMatchObject({ status: "stale", error: null, source_version_id: "ver-4", ingest_claimed_by: null });
    // The Rev 4 generation's first batch clears what the withdrawal left.
    db.hooks = [];
    r2.objects.set("orgs/o1/dc/rev4.pdf", await makePdf([prosePage("rev 4 only")]));
    const next = await ingestKnowledgeDocBatch(asArg(docRow()));
    expect(next.done).toBe(true);
    expect(rowsOf("knowledge_chunks").every((c) => !String(c.content).includes("bolting"))).toBe(true);
    expect(rowsOf("knowledge_page_entities")).toHaveLength(0);
  });

  it("unclaimed (pre-20261122): a row re-pointed at a new file whose withdrawal failed is re-queued for a full re-index", async () => {
    const doc = await seed([drawingSheet(1, ["V-101", "P-201A", "E-301"]), prosePage("bolting")],
      { source_document_id: "dc-1", source_version_id: "ver-3", source_rev: "3" });
    const legacyCols = ["ingest_claimed_by", "ingest_claimed_at", "empty_pages", "vision_failed_pages", "vision_partial_accepted", "chunk_version", "vision_retry_after", "vision_retry_tried", "ingest_failures"];
    db.missingColumns.knowledge_documents = legacyCols;
    const legacy = Object.fromEntries(Object.entries(doc).filter(([k]) => !legacyCols.includes(k)));
    db.tables.knowledge_documents = [{ ...legacy }];
    // Rev 4's first batch already read page 1 when the Rev 3 batch commits.
    let fired = false;
    db.hooks.push((op) => {
      if (fired || op.table !== "knowledge_documents" || op.kind !== "update" || !("page_count" in (op.payload as Row))) return;
      fired = true;
      Object.assign(docRow(), { file_key: "orgs/o1/dc/rev4.pdf", source_version_id: "ver-4", source_rev: "4", pages_indexed: 1, page_count: 1, status: "indexing" });
    });
    withdrawalFails();
    await expect(ingestKnowledgeDocBatch(asArg(legacy))).rejects.toThrow(/could not be withdrawn: .* — the document was re-queued for a full re-index/);
    expect(docRow()).toMatchObject({ status: "stale", pages_indexed: 0, file_key: "orgs/o1/dc/rev4.pdf", error: null });
    expect(rowsOf("knowledge_chunks")).toHaveLength(0);
    expect(rowsOf("knowledge_page_entities")).toHaveLength(0);
  });
});

describe("ING-1 — the legacy re-queue lands only on the row it checked", () => {
  it("unclaimed (pre-20261122): a new-file batch that commits between the check and the re-queue keeps its pages", async () => {
    const doc = await seed([drawingSheet(1, ["V-101", "P-201A", "E-301"]), prosePage("bolting")],
      { source_document_id: "dc-1", source_version_id: "ver-3", source_rev: "3" });
    const legacyCols = ["ingest_claimed_by", "ingest_claimed_at", "empty_pages", "vision_failed_pages", "vision_partial_accepted", "chunk_version", "vision_retry_after", "vision_retry_tried", "ingest_failures"];
    db.missingColumns.knowledge_documents = legacyCols;
    const legacy = Object.fromEntries(Object.entries(doc).filter(([k]) => !legacyCols.includes(k)));
    db.tables.knowledge_documents = [{ ...legacy }];
    let repointed = false;
    let committed = false;
    db.hooks.push((op) => {
      // Rev 4's first batch has read page 1 when the Rev 3 batch commits…
      if (!repointed && op.table === "knowledge_documents" && op.kind === "update" && "page_count" in (op.payload as Row)) {
        repointed = true;
        Object.assign(docRow(), { file_key: "orgs/o1/dc/rev4.pdf", source_version_id: "ver-4", source_rev: "4", pages_indexed: 1, page_count: 2, status: "indexing" });
        return;
      }
      // …and its second batch commits page 2 just as the re-queue starts.
      if (repointed && !committed && op.table === "knowledge_documents" && op.kind === "update" && "ingest_claimed_by" in (op.payload as Row)) {
        committed = true;
        db.tables.knowledge_chunks.push({ id: "rev4-p2", document_id: DOC, org_id: "o1", library_id: "kl-1", page: 2, seq: 0, content: "rev 4 page 2" });
        Object.assign(docRow(), { pages_indexed: 2 });
      }
    });
    db.hooks.push((op, filters) =>
      op.kind === "delete" && (op.table === "knowledge_chunks" || op.table === "knowledge_page_entities") && filters.some((f) => f.op === "in" && f.col === "id")
        ? { error: { code: "57014", message: "canceling statement due to statement timeout" } } : undefined);
    await expect(ingestKnowledgeDocBatch(asArg(legacy))).rejects.toThrow(/could not be withdrawn: .* — it could not be re-queued \(another driver moved it first\)/);
    expect(committed).toBe(true);
    // Before, the re-queue reset the row and deleted every chunk under the
    // new batch's commit — Rev 4 pages recorded with nothing indexed.
    expect(docRow()).toMatchObject({ file_key: "orgs/o1/dc/rev4.pdf", pages_indexed: 2, status: "indexing" });
    expect(rowsOf("knowledge_chunks").some((c) => c.id === "rev4-p2")).toBe(true);
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

  it("a keyless driver that finds its own reason already on the row gives the claim back and writes nothing else", async () => {
    const doc = await awaitingRetry();
    r2.objects.clear();
    await ingestKnowledgeDocBatch(asArg(doc));            // the first park says why
    const said = { error: docRow().error, vision_retry_after: docRow().vision_retry_after };
    db.ops = [];
    const again = await ingestKnowledgeDocBatch(asArg(docRow()));
    expect(again).toMatchObject({ visionRetryBlocked: true, visionRetryMessage: said.error, visionRetryAfter: null });
    // The app-shell indicator asks every two minutes from every open tab:
    // only the claim and its release reach the row.
    const writes = db.ops.filter((o) => o.table === "knowledge_documents" && o.kind === "update");
    expect(writes.map((w) => Object.keys(w.payload as Row).sort())).toEqual([
      ["ingest_claimed_at", "ingest_claimed_by"], ["ingest_claimed_at", "ingest_claimed_by"],
    ]);
    expect(docRow()).toMatchObject({ ...said, status: "indexing", ingest_claimed_by: null });
  });

  it("a keyless park whose stamp is half an hour old or more is written again, to now: its place in the cron's queue moves behind fresh work", async () => {
    const old = new Date(Date.now() - VISION_RETRY_BACKOFF_MS - 60_000).toISOString();
    await awaitingRetry({ error: visionRetryMessage([1], null), vision_retry_after: old });
    r2.objects.clear();
    const t0 = Date.now();
    const res = await ingestKnowledgeDocBatch(asArg(docRow()));
    expect(res).toMatchObject({ visionRetryBlocked: true, visionRetryAfter: null });
    expect(Date.parse(String(docRow().vision_retry_after))).toBeGreaterThanOrEqual(t0);
    expect(docRow()).toMatchObject({ status: "indexing", error: visionRetryMessage([1], null), ingest_claimed_by: null });
  });

  it("twenty keyless-parked documents never keep the nightly drain from a lapsed failed batch: it is retried on the next run", async () => {
    // The reviewer's probe P2: documents parked on failed vision pages with
    // no sponsored key (the uploader's AI cap reached), each carrying its
    // own reason and the stamp of its first park, and another document whose
    // ING-8 back-off lapsed an hour ago. The keyless skip used to keep those
    // first stamps for good, so every nightly run took the same twenty, and
    // the failure was never retried.
    const parkedPdf = await makePdf([null, prosePage("bolting")]);
    const parked = Array.from({ length: 20 }, (_, i) => baseDoc({
      id: `kd-p${i}`, created_at: `2026-08-${String(i + 1).padStart(2, "0")}`, file_key: `orgs/o1/knowledge/kl-1/p${i}.pdf`,
      status: "indexing", pages_indexed: 2, page_count: 2, vision_failed_pages: [1],
      error: visionRetryMessage([1], null), vision_retry_after: `2026-09-0${1 + (i % 9)}T00:00:00.000Z`,
    }));
    parked.forEach((d) => r2.objects.set(d.file_key as string, parkedPdf));
    const lapsed = new Date(Date.now() - 3_600_000).toISOString();
    const failed = baseDoc({
      id: "kd-failed", created_at: "2026-07-01", file_key: "orgs/o1/knowledge/kl-1/f.pdf",
      status: "indexing", pages_indexed: 1, page_count: 2, ingest_failures: 1,
      error: ingestFailureMessage("entity insert failed: connection reset by peer", 1, ingestFailureBackoffMs(1), true),
      vision_retry_after: lapsed,
    });
    r2.objects.set("orgs/o1/knowledge/kl-1/f.pdf", await makePdf([prosePage("a"), prosePage("b")]));
    resetDb({
      knowledge_documents: [...parked, failed], knowledge_chunks: [], knowledge_page_entities: [], entity_mentions: [],
      knowledge_line_traces: [], knowledge_libraries: [{ id: "kl-1", org_id: "o1", ai_features: {} }], ai_connections: [],
    });
    const failedRow = () => rowsOf("knowledge_documents").find((d) => d.id === "kd-failed")!;
    const parkedStamps = () => rowsOf("knowledge_documents").filter((d) => String(d.id).startsWith("kd-p")).map((d) => Date.parse(String(d.vision_retry_after)));

    // The first run takes the twenty oldest stamps — the parked rows — and
    // files each one behind the failure: its stamp moves to now.
    const t0 = Date.now();
    await drainKnowledgeIngestQueue({ maxPages: 500, deadlineMs: Date.now() + 30_000 });
    expect(parkedStamps().every((t) => t >= t0)).toBe(true);
    expect(failedRow()).toMatchObject({ pages_indexed: 1, ingest_failures: 1 });

    // The next run reaches the failure first, and completes it.
    const second = await drainKnowledgeIngestQueue({ maxPages: 500, deadlineMs: Date.now() + 30_000 });
    expect(second.completed).toBe(1);
    expect(failedRow()).toMatchObject({ status: "ready", pages_indexed: 2, ingest_failures: 0, error: null, vision_retry_after: null });
    expect(vision.calls).toEqual([]);
    expect(rowsOf("knowledge_documents").filter((d) => d.status === "error")).toHaveLength(0);
  });

  /** A document whose failed batch's back-off lapsed an hour ago (ING-8),
   *  its second page still to index. */
  const lapsedFailure = async () => {
    r2.objects.set("orgs/o1/knowledge/kl-1/f.pdf", await makePdf([prosePage("a"), prosePage("b")]));
    return baseDoc({
      id: "kd-failed", created_at: "2026-07-01", file_key: "orgs/o1/knowledge/kl-1/f.pdf",
      status: "indexing", pages_indexed: 1, page_count: 2, ingest_failures: 1,
      error: ingestFailureMessage("entity insert failed: connection reset by peer", 1, ingestFailureBackoffMs(1), true),
      vision_retry_after: new Date(Date.now() - 3_600_000).toISOString(),
    });
  };

  it("twenty unsponsored documents in a read-every-page library never keep the nightly drain from a lapsed failed batch", async () => {
    // The reviewer's probe D1: mirrors carry no uploader, so no sponsored key
    // ever reads them, and a library marked "read every page with vision"
    // must not be indexed text-only. The drain skipped each one untouched;
    // never stamped, they sorted first (NULLS FIRST) — twenty of them, in any
    // org, took the whole twenty-row queue every night.
    const mirrors = Array.from({ length: 20 }, (_, i) => baseDoc({
      id: `kd-m${i}`, library_id: "kl-all", created_by: null, created_at: `2026-08-${String(i + 1).padStart(2, "0")}`,
      file_key: `orgs/o1/dc/m${i}.pdf`, source_id: "src-1", source_document_id: `dc-${i}`, source_version_id: `ver-${i}`,
    }));
    const failed = await lapsedFailure();
    const libraries = [{ id: "kl-1", org_id: "o1", ai_features: {} }, { id: "kl-all", org_id: "o1", ai_features: { visionAllPages: true } }];
    resetDb({
      knowledge_documents: [...mirrors, failed], knowledge_chunks: [], knowledge_page_entities: [], entity_mentions: [], knowledge_line_traces: [],
      knowledge_libraries: libraries, ai_connections: [],
    });
    const row = (id: string) => rowsOf("knowledge_documents").find((d) => d.id === id)!;

    // The first run takes the twenty never-stamped mirrors: none can be
    // worked on, and each is filed behind what lapsed before now.
    const t0 = Date.now();
    const first = await drainKnowledgeIngestQueue({ maxPages: 500, deadlineMs: Date.now() + 30_000 });
    expect(first).toMatchObject({ docsTouched: 0, errors: [] });
    expect(mirrors.every((m) => row(m.id as string).status === "pending" && Date.parse(String(row(m.id as string).vision_retry_after)) >= t0)).toBe(true);
    expect(row("kd-failed")).toMatchObject({ pages_indexed: 1, ingest_failures: 1 });

    // The next run reaches the failure first, and completes it. Nothing was
    // downloaded for a mirror (none of their files exists here).
    const second = await drainKnowledgeIngestQueue({ maxPages: 500, deadlineMs: Date.now() + 30_000 });
    expect(second).toMatchObject({ completed: 1, errors: [] });
    expect(row("kd-failed")).toMatchObject({ status: "ready", pages_indexed: 2, ingest_failures: 0, error: null, vision_retry_after: null });
    expect(vision.calls).toEqual([]);

    // A row there whose failed batch is still backing off keeps its back-off:
    // a stamp in force already files it behind now, and is never shortened.
    const until = new Date(Date.now() + 600_000).toISOString();
    resetDb({
      knowledge_documents: [baseDoc({
        id: "kd-hold", library_id: "kl-all", created_by: null, status: "indexing", pages_indexed: 1, page_count: 2, ingest_failures: 1,
        error: ingestFailureMessage("entity insert failed: boom", 1, ingestFailureBackoffMs(1), true), vision_retry_after: until,
      })],
      knowledge_libraries: libraries, ai_connections: [],
    });
    await drainKnowledgeIngestQueue({ maxPages: 500, deadlineMs: Date.now() + 30_000 });
    expect(row("kd-hold").vision_retry_after).toBe(until);
    expect(db.ops.filter((o) => o.table === "knowledge_documents" && o.kind === "update")).toEqual([]);
  });

  it("the bound on the nightly retry: a lapsed failure behind N rows stamped before it lapsed comes up on run ⌊N / 20⌋ + 1", async () => {
    // The reviewer's probe D2: forty keyless-parked documents, every stamp
    // older than the failure's lapse. Each run re-stamps the twenty at the
    // head; the failure comes up on the third run — not the second.
    const parkedPdf = await makePdf([null, prosePage("bolting")]);
    const parked = Array.from({ length: 40 }, (_, i) => baseDoc({
      id: `kd-p${i}`, created_at: "2026-08-01", file_key: `orgs/o1/knowledge/kl-1/p${i}.pdf`,
      status: "indexing", pages_indexed: 2, page_count: 2, vision_failed_pages: [1],
      error: visionRetryMessage([1], null), vision_retry_after: `2026-09-${String(1 + (i % 28)).padStart(2, "0")}T00:00:00.000Z`,
    }));
    parked.forEach((d) => r2.objects.set(d.file_key as string, parkedPdf));
    const failed = await lapsedFailure();
    resetDb({
      knowledge_documents: [...parked, failed], knowledge_chunks: [], knowledge_page_entities: [], entity_mentions: [],
      knowledge_line_traces: [], knowledge_libraries: [{ id: "kl-1", org_id: "o1", ai_features: {} }], ai_connections: [],
    });
    const failedRow = () => rowsOf("knowledge_documents").find((d) => d.id === "kd-failed")!;
    for (const run of [1, 2]) {
      await drainKnowledgeIngestQueue({ maxPages: 500, deadlineMs: Date.now() + 30_000 });
      expect({ run, ...failedRow() }).toMatchObject({ run, pages_indexed: 1, ingest_failures: 1 });
    }
    const third = await drainKnowledgeIngestQueue({ maxPages: 500, deadlineMs: Date.now() + 30_000 });
    expect(third.completed).toBe(1);
    expect(failedRow()).toMatchObject({ status: "ready", pages_indexed: 2, ingest_failures: 0 });
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

  it("the cron drain keeps going while vision retries succeed: a retry batch's re-read pages are its progress", async () => {
    // Twenty sheets whose vision reads all failed, now readable. Each retry
    // batch reads four (the per-batch budget) and leaves the resume point
    // where it was — the drain used to read that as "stuck" and stop after
    // one batch: four pages a day.
    const failed = Array.from({ length: 20 }, (_, i) => i + 1);
    await seed(Array.from({ length: 20 }, () => null), {
      status: "indexing", pages_indexed: 20, page_count: 20, vision_failed_pages: failed,
    });
    db.tables.knowledge_libraries = [{ id: "kl-1", org_id: "o1", ai_features: {} }];
    db.tables.ai_connections = [{ org_id: "o1", user_id: "u1", provider: "anthropic", model: "m", api_key: "k" }];
    db.tables.ai_key_agreements = [{ id: "ag-1", org_id: "o1", user_id: "u1", scope: "use", agreement_version: AGREEMENT_VERSION }];
    vision.impl = async (page) => ({ text: transcript(page), usage: { inputTokens: 1, outputTokens: 1 }, model: "vision-tier" });
    const out = await drainKnowledgeIngestQueue({ maxPages: 100, deadlineMs: Date.now() + 120_000 });
    expect(out).toMatchObject({ completed: 1, pagesIndexed: 20, errors: [] });
    expect(vision.calls).toHaveLength(20);
    expect(docRow()).toMatchObject({ status: "ready", vision_failed_pages: [], error: null });
  });

  it("pages that fail every time never starve the ones behind them: the queue rotates, and it backs off only after every page's try", async () => {
    // Eight failed sheets. 1–4 fail every time (the image is too large for
    // the provider); 5–8 would read fine. The retry pass used to walk the
    // list in page order within its four-page budget, park when all four
    // failed, and after the back-off try 1–4 again — 5–8 were never tried.
    const eight = Array.from({ length: 8 }, (_, i) => i + 1);
    await seed(Array.from({ length: 8 }, () => null), {
      status: "indexing", pages_indexed: 8, page_count: 8, vision_failed_pages: eight,
    });
    vision.impl = async (page) => {
      if (page <= 4) throw new Error("400 image exceeds 5 MB maximum");
      return { text: transcript(page), usage: { inputTokens: 1, outputTokens: 1 }, model: "vision-tier" };
    };
    // First batch: tries 1–4, all fail — they go to the back, and it does NOT
    // back off: 5–8 have not had their try this round.
    const a = await ingestKnowledgeDocBatch(asArg(docRow()), visionCtx());
    expect(vision.calls).toEqual([1, 2, 3, 4]);
    expect(a).toMatchObject({ visionRetryBlocked: false, visionRetryAttempts: 4, done: false });
    expect(docRow()).toMatchObject({
      status: "indexing", vision_failed_pages: [5, 6, 7, 8, 1, 2, 3, 4], vision_retry_tried: [1, 2, 3, 4], vision_retry_after: null,
    });
    // Second batch: 5–8, least recently tried, read. The round is complete:
    // the commit records the reads AND starts the back-off for 1–4.
    const b = await ingestKnowledgeDocBatch(asArg(docRow()), visionCtx());
    expect(vision.calls).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(b.visionFailedPages).toEqual([1, 2, 3, 4]);
    expect(b.visionRetryMessage).toBe(visionRetryMessage([1, 2, 3, 4], "the provider refused the last retry"));
    expect(docRow()).toMatchObject({ status: "indexing", vision_failed_pages: [1, 2, 3, 4], vision_retry_tried: [] });
    expect(String(docRow().error)).toMatch(/AI vision could not read 4 pages \(p\. 1, 2, 3, 4\): the provider refused the last retry\. They are tried again automatically/);
    expect(Date.parse(String(docRow().vision_retry_after))).toBeGreaterThan(Date.now());
    for (const p of [5, 6, 7, 8]) expect(rowsOf("knowledge_page_entities").some((e) => e.page === p && e.tag === `V-${100 + p}`)).toBe(true);
    // Inside the back-off nothing is asked of the provider.
    const c = await ingestKnowledgeDocBatch(asArg(docRow()), visionCtx());
    expect(c.visionRetryBlocked).toBe(true);
    expect(vision.calls).toHaveLength(8);
    // After it, 1–4 get their next try; they fail again, and it backs off.
    docRow().vision_retry_after = new Date(Date.now() - 1000).toISOString();
    const d = await ingestKnowledgeDocBatch(asArg(docRow()), visionCtx());
    expect(vision.calls.slice(8)).toEqual([1, 2, 3, 4]);
    expect(d).toMatchObject({ visionRetryBlocked: true });
    expect(docRow()).toMatchObject({ vision_failed_pages: [1, 2, 3, 4], vision_retry_tried: [], status: "indexing" });
  });

  it("the cron drain walks a whole round in one run: the pages behind the failing ones are read, and only those that fail stay listed", async () => {
    const eight = Array.from({ length: 8 }, (_, i) => i + 1);
    await seed(Array.from({ length: 8 }, () => null), {
      status: "indexing", pages_indexed: 8, page_count: 8, vision_failed_pages: eight,
    });
    db.tables.knowledge_libraries = [{ id: "kl-1", org_id: "o1", ai_features: {} }];
    db.tables.ai_connections = [{ org_id: "o1", user_id: "u1", provider: "anthropic", model: "m", api_key: "k" }];
    db.tables.ai_key_agreements = [{ id: "ag-1", org_id: "o1", user_id: "u1", scope: "use", agreement_version: AGREEMENT_VERSION }];
    vision.impl = async (page) => {
      if (page <= 4) throw new Error("400 image exceeds 5 MB maximum");
      return { text: transcript(page), usage: { inputTokens: 1, outputTokens: 1 }, model: "vision-tier" };
    };
    const out = await drainKnowledgeIngestQueue({ maxPages: 100, deadlineMs: Date.now() + 120_000 });
    expect(out).toMatchObject({ pagesIndexed: 4, completed: 0, errors: [] });
    expect([...vision.calls].sort((x, y) => x - y)).toEqual(eight);
    expect(pageListOf(docRow().vision_failed_pages)).toEqual([1, 2, 3, 4]);
    expect(docRow().status).toBe("indexing");
  });

  it("the parked message offers only what the app can do today", () => {
    for (const m of [visionRetryMessage([1, 2], "provider 529 overloaded"), visionRetryMessage([1], null)]) {
      expect(m).toMatch(/ask an admin to accept the partial index\.$/);
      expect(m).not.toMatch(/Or accept the partial index/);
    }
  });

  it("an accepted partial index is 'ready' with the unread pages still listed", async () => {
    const doc = await seed([null], { status: "indexing", pages_indexed: 1, page_count: 1, vision_failed_pages: [1], vision_partial_accepted: true });
    const res = await ingestKnowledgeDocBatch(asArg(doc));
    expect(res.done).toBe(true);
    expect(docRow()).toMatchObject({ status: "ready", vision_failed_pages: [1] });
  });
});

describe("ING-13 (I-06b) — a keyless batch never consumes, text-only, a page AI vision read in the last index generation", () => {
  // Three sheets; sheet 2 has no text layer (an SHX plot, a scan) and was
  // read by AI vision in the last generation — its chunk says so (GOV-9).
  // The row carries 20261162's column (vision_owed_pages).
  const pages: PageSpec[] = [drawingSheet(1, ["V-101", "P-201A", "E-301"]), null, prosePage("bolting")];
  const lastGeneration = async (over: Row = {}) => {
    const doc = await seed(pages, {
      status: "ready", pages_indexed: 3, page_count: 3, vision_pages: 1, chunk_version: 1, vision_owed_pages: [], ...over,
    });
    db.tables.knowledge_chunks = [
      { id: "c1", document_id: DOC, org_id: "o1", library_id: "kl-1", page: 1, seq: 0, content: "sheet 1", source: "text" },
      { id: "c2", document_id: DOC, org_id: "o1", library_id: "kl-1", page: 2, seq: 0, content: transcript(2), source: "vision", source_model: "m" },
      { id: "c3", document_id: DOC, org_id: "o1", library_id: "kl-1", page: 3, seq: 0, content: "bolting", source: "text" },
    ];
    return doc;
  };
  const readsAll = () => { vision.impl = async (page) => ({ text: transcript(page), usage: { inputTokens: 1, outputTokens: 1 }, model: "vision-tier" }); };

  it("the record's reproduction: after a reset, a keyless batch holds the page AI vision read — listed, the document 'indexing', never 'ready' text-only — and a key reads it back", async () => {
    await lastGeneration();
    const reset = await resetKnowledgeIndex([DOC]);
    expect(reset).toEqual({ reset: [DOC], busy: [], errors: [] });
    // The reset recorded what the last generation read with AI vision.
    expect(docRow()).toMatchObject({ status: "stale", pages_indexed: 0, vision_pages: 0, vision_owed_pages: [2] });

    // A keyless driver (another controller's tab, the cron without a sponsor).
    const res = await ingestKnowledgeDocBatch(asArg(docRow()));
    expect(res).toMatchObject({ done: false, pagesIndexed: 3, visionFailedPages: [2], pagesReadable: 2, visionPages: 0 });
    expect(docRow()).toMatchObject({ status: "indexing", vision_failed_pages: [2], vision_pages: 0, error: null });
    expect(vision.calls).toEqual([]);
    // Pages 1 and 3 are indexed and searchable meanwhile.
    expect(rowsOf("knowledge_chunks").map((c) => c.page).sort()).toEqual([1, 3]);

    // The next keyless batch parks it with the plain reason, never 'error'.
    const parked = await ingestKnowledgeDocBatch(asArg(docRow()));
    expect(parked).toMatchObject({ visionRetryBlocked: true, done: false });
    expect(parked.visionRetryMessage).toBe(visionRetryMessage([2], null));
    expect(docRow()).toMatchObject({ status: "indexing", error: visionRetryMessage([2], null) });

    // A driver with a key reads it back and the document completes.
    readsAll();
    const keyed = await ingestKnowledgeDocBatch(asArg(docRow()), visionCtx());
    expect(keyed.done).toBe(true);
    expect(vision.calls).toEqual([2]);
    expect(docRow()).toMatchObject({ status: "ready", vision_failed_pages: [], vision_pages: 1, error: null });
    expect(rowsOf("knowledge_page_entities").some((e) => e.page === 2 && e.tag === "V-102")).toBe(true);
  });

  it("a keyed re-index reads exactly the pages a first index reads, and completes as before", async () => {
    // The last generation read sheet 1 too (the library once read every
    // page with AI vision); this one does not, so it is not read again.
    await lastGeneration();
    db.tables.knowledge_chunks[0].source = "vision";
    await resetKnowledgeIndex([DOC]);
    expect(docRow().vision_owed_pages).toEqual([1, 2]);
    readsAll();
    const res = await ingestKnowledgeDocBatch(asArg(docRow()), visionCtx());
    expect(res).toMatchObject({ done: true, visionPages: 1, visionFailedPages: [] });
    expect(vision.calls).toEqual([2]);

    // …the same pages a first index of the same file reads.
    await seed(pages, { vision_owed_pages: [] });
    vision.calls = [];
    const fresh = await ingestKnowledgeDocBatch(asArg(docRow()), visionCtx());
    expect(fresh).toMatchObject({ done: true, visionPages: 1 });
    expect(vision.calls).toEqual([2]);
  });

  it("a document no AI vision ever read (a keyless org's) still completes text-only after a reset, as before", async () => {
    await lastGeneration({ vision_pages: 0 });
    db.tables.knowledge_chunks = db.tables.knowledge_chunks.filter((c) => c.page !== 2);
    await resetKnowledgeIndex([DOC]);
    expect(docRow().vision_owed_pages).toEqual([]);
    const res = await ingestKnowledgeDocBatch(asArg(docRow()));
    expect(res).toMatchObject({ done: true, visionFailedPages: [] });
    expect(docRow()).toMatchObject({ status: "ready", vision_failed_pages: [], empty_pages: 1 });
  });

  it("the owed pages are the last generation's AI reads, its pages still waiting, and an earlier reset's pages not reached yet", async () => {
    // Mid-way through a regeneration: page 1 read back by AI vision, page 2
    // waiting on it, page 3 owed by the reset before and not reached yet
    // (page 1 was owed too, and is read now — its chunk says so).
    await lastGeneration({ status: "indexing", pages_indexed: 2, vision_failed_pages: [2], vision_owed_pages: [1, 3] });
    db.tables.knowledge_chunks = [
      { id: "c1", document_id: DOC, org_id: "o1", library_id: "kl-1", page: 1, seq: 0, content: transcript(1), source: "vision" },
      { id: "c2", document_id: DOC, org_id: "o1", library_id: "kl-1", page: 2, seq: 0, content: "", source: "text" },
    ];
    await resetKnowledgeIndex([DOC]);
    expect(docRow().vision_owed_pages).toEqual([1, 2, 3]);
  });

  it("a reset that cannot read which pages AI vision read resets nothing for that document, and says so", async () => {
    await lastGeneration();
    db.hooks.push((op, filters) => op.table === "knowledge_chunks" && op.kind === "select" && filters.some((f) => f.col === "source")
      ? { error: { code: "57014", message: "canceling statement due to statement timeout" } } : undefined);
    const reset = await resetKnowledgeIndex([DOC]);
    expect(reset.reset).toEqual([]);
    expect(reset.errors).toEqual([`${DOC}: the pages AI vision read could not be listed, so nothing was reset: canceling statement due to statement timeout`]);
    expect(docRow()).toMatchObject({ status: "ready", pages_indexed: 3, ingest_claimed_by: null });
    expect(rowsOf("knowledge_chunks")).toHaveLength(3);
  });

  it("…and on a rev-up, the old sheet's cached line traces survive it too: they are listed before anything is deleted (fix pass 3)", async () => {
    // The reset used to purge the traces (step 1) before it read the owed
    // pages: a read that failed then reported "nothing was reset" with the
    // traces already gone. (The line tracer is retired and 20261007 drops
    // its table; a database that still has it loses nothing here either.)
    const doc = await lastGeneration({ source_document_id: "dc-1", source_version_id: "ver-3", source_rev: "3" });
    db.tables.knowledge_line_traces = [{ id: "t1", document_id: DOC, org_id: "o1", page: 2, from_tag: "V-102", to_tag: "P-202A" }];
    db.hooks.push((op, filters) => op.table === "knowledge_chunks" && op.kind === "select" && filters.some((f) => f.col === "source")
      ? { error: { code: "57014", message: "canceling statement due to statement timeout" } } : undefined);
    const reset = await resetKnowledgeIndex([DOC], {
      purgeLineTraces: true, supersedeBusy: true,
      expect: () => ({ source_version_id: "ver-3" }),
      rowUpdate: () => ({ file_key: "orgs/o1/dc/rev4.pdf", source_version_id: "ver-4", source_rev: "4" }),
    });
    expect(reset.reset).toEqual([]);
    expect(reset.errors).toEqual([`${DOC}: the pages AI vision read could not be listed, so nothing was reset: canceling statement due to statement timeout`]);
    expect(rowsOf("knowledge_line_traces")).toEqual([{ id: "t1", document_id: DOC, org_id: "o1", page: 2, from_tag: "V-102", to_tag: "P-202A" }]);
    expect(db.ops.some((o) => o.kind === "delete")).toBe(false);
    expect(docRow()).toMatchObject({
      status: "ready", pages_indexed: 3, vision_pages: 1, vision_owed_pages: [], ingest_claimed_by: null,
      file_key: doc.file_key, source_version_id: "ver-3", source_rev: "3",
    });
    expect(rowsOf("knowledge_chunks")).toHaveLength(3);
  });

  it("the cron drain without a sponsored key holds the page too: never 'ready' text-only, never billed", async () => {
    await lastGeneration({ created_by: "u-nokey" });
    db.tables.knowledge_libraries = [{ id: "kl-1", org_id: "o1", ai_features: {} }];
    db.tables.ai_connections = [];
    await resetKnowledgeIndex([DOC]);
    const out = await drainKnowledgeIngestQueue({ maxPages: 100, deadlineMs: Date.now() + 30_000 });
    expect(out.errors).toEqual([]);
    expect(out.completed).toBe(0);
    expect(docRow()).toMatchObject({ status: "indexing", vision_failed_pages: [2], pages_indexed: 3 });
    expect(String(docRow().error)).toMatch(/retrying needs an AI key/);
    expect(vision.calls).toEqual([]);
  });

  it("a database without 20261162 resets and indexes exactly as before: the keyless batch commits the page text-only", async () => {
    await lastGeneration();
    delete db.tables.knowledge_documents[0].vision_owed_pages;
    db.missingColumns.knowledge_documents = ["vision_owed_pages"];
    const reset = await resetKnowledgeIndex([DOC]);
    expect(reset).toEqual({ reset: [DOC], busy: [], errors: [] });
    const res = await ingestKnowledgeDocBatch(asArg(docRow()));
    expect(res).toMatchObject({ done: true, visionFailedPages: [] });
    expect(docRow()).toMatchObject({ status: "ready", vision_failed_pages: [], vision_pages: 0 });
  });

  it("a document indexed before chunks said how their text was read (every chunk 'text', as 20261122 left them) owes every page that needs AI vision: the reset says so, and a keyless batch holds the textless page", async () => {
    // The review's reproduction: the row counts a page AI vision read, but
    // no chunk names it — the owed list used to come back empty, and the
    // keyless batch took the document to 'ready' text-only.
    await lastGeneration();
    db.tables.knowledge_chunks[1].source = "text";
    const reset = await resetKnowledgeIndex([DOC]);
    expect(reset).toEqual({ reset: [DOC], busy: [], errors: [] });
    expect(docRow()).toMatchObject({ status: "stale", vision_pages: 0, vision_owed_pages: [OWES_EVERY_VISION_PAGE] });
    expect(OWES_EVERY_VISION_PAGE).toBe(0);                  // no real page is page 0

    const res = await ingestKnowledgeDocBatch(asArg(docRow()));
    // Only the page that needs AI vision is held: sheet 1 (a text layer
    // with its tags) and the prose page index from their text layer.
    expect(res).toMatchObject({ done: false, pagesIndexed: 3, visionFailedPages: [2], visionHeldPages: 1, visionPages: 0 });
    expect(docRow()).toMatchObject({ status: "indexing", vision_failed_pages: [2], error: null });
    expect(rowsOf("knowledge_chunks").map((c) => c.page).sort()).toEqual([1, 3]);
    expect(vision.calls).toEqual([]);

    // A key reads it back, and the document completes.
    readsAll();
    const keyed = await ingestKnowledgeDocBatch(asArg(docRow()), visionCtx());
    expect(keyed.done).toBe(true);
    expect(vision.calls).toEqual([2]);
    expect(docRow()).toMatchObject({ status: "ready", vision_failed_pages: [], vision_pages: 1 });
  });

  it("an earlier reset's 'every page that needs AI vision' is still owed by a reset before this generation reached its last page — and only then", async () => {
    // Reset again one page into a keyless regeneration (a rev-up, say):
    // pages 2 and 3 were never reached, so they are still owed.
    await lastGeneration({
      status: "indexing", pages_indexed: 1, page_count: 3, vision_pages: 0, vision_owed_pages: [OWES_EVERY_VISION_PAGE],
    });
    db.tables.knowledge_chunks = [db.tables.knowledge_chunks[0]];
    await resetKnowledgeIndex([DOC]);
    expect(docRow().vision_owed_pages).toEqual([OWES_EVERY_VISION_PAGE]);

    // A generation that reached its last page holds what it owes on
    // vision_failed_pages: those pages, and nothing more, are owed.
    await lastGeneration({
      status: "indexing", pages_indexed: 3, page_count: 3, vision_pages: 0,
      vision_failed_pages: [2], vision_owed_pages: [OWES_EVERY_VISION_PAGE],
    });
    db.tables.knowledge_chunks = db.tables.knowledge_chunks.filter((c) => c.page !== 2);
    await resetKnowledgeIndex([DOC]);
    expect(docRow().vision_owed_pages).toEqual([2]);
  });

  it("a keyless batch holds an owed page only where a driver with a key would read it with AI vision now — a page with a full text layer is indexed from it, and no keyed retry bills it", async () => {
    // The last generation read sheet 1 with AI vision too (the library once
    // read every page); it has a text layer with its tags, which a driver
    // with a key would index from now — so a keyless one does too.
    await lastGeneration();
    db.tables.knowledge_chunks[0].source = "vision";
    await resetKnowledgeIndex([DOC]);
    expect(docRow().vision_owed_pages).toEqual([1, 2]);
    const res = await ingestKnowledgeDocBatch(asArg(docRow()));
    expect(res).toMatchObject({ visionFailedPages: [2], visionHeldPages: 1 });
    expect(rowsOf("knowledge_chunks").filter((c) => c.page === 1).map((c) => c.source)).toEqual(["text"]);
    // The keyed driver that comes next reads exactly what a keyed run reads.
    readsAll();
    const keyed = await ingestKnowledgeDocBatch(asArg(docRow()), visionCtx());
    expect(keyed.done).toBe(true);
    expect(vision.calls).toEqual([2]);
  });

  it("…and in a library that reads every page with AI vision, every owed page is held, as a driver with a key would read each one", async () => {
    await lastGeneration();
    db.tables.knowledge_chunks[0].source = "vision";
    await resetKnowledgeIndex([DOC]);
    const res = await ingestKnowledgeDocBatch(asArg(docRow()), undefined, undefined, { visionAllPages: true });
    expect(res).toMatchObject({ done: false, visionFailedPages: [1, 2], visionHeldPages: 2 });
    // The prose page was never read by AI vision: it owes nothing.
    expect(rowsOf("knowledge_chunks").some((c) => c.page === 3)).toBe(true);
  });

  it("a rev-up that inserts a sheet before the one AI vision read: the reset owes the new file every page that needs AI vision — the old numbers name nothing in it — and a keyless batch holds the moved sheet (review fix pass 2)", async () => {
    // The review's reproduction. Rev 3: [sheet 1, the SHX sheet AI vision
    // read (page 2), prose]. Rev 4 inserts a prose page, so the SHX sheet
    // is page 3 now; owing "page 2" held the prose page's number, and the
    // keyless batch took Rev 4 to 'ready' with the SHX sheet empty.
    await lastGeneration({ source_document_id: "dc-1", source_version_id: "ver-3", source_rev: "3" });
    const REV4 = "orgs/o1/dc/rev4.pdf";
    r2.objects.set(REV4, await makePdf([drawingSheet(1, ["V-101", "P-201A", "E-301"]), prosePage("gaskets"), null, prosePage("bolting")]));
    const reset = await resetKnowledgeIndex([DOC], {
      purgeLineTraces: true, supersedeBusy: true,
      expect: () => ({ source_version_id: "ver-3" }),
      rowUpdate: () => ({ file_key: REV4, source_version_id: "ver-4", source_rev: "4" }),
    });
    expect(reset).toEqual({ reset: [DOC], busy: [], errors: [] });
    expect(docRow()).toMatchObject({ status: "stale", file_key: REV4, source_rev: "4", vision_owed_pages: [OWES_EVERY_VISION_PAGE] });

    // A keyless driver (the cron drain: a mirror has no uploader).
    const res = await ingestKnowledgeDocBatch(asArg(docRow()));
    expect(res).toMatchObject({ done: false, pagesIndexed: 4, visionFailedPages: [3], visionHeldPages: 1, visionPages: 0 });
    expect(docRow()).toMatchObject({ status: "indexing", vision_failed_pages: [3], error: null });
    expect([...new Set(rowsOf("knowledge_chunks").map((c) => c.page as number))].sort((a, b) => a - b)).toEqual([1, 2, 4]);
    expect(vision.calls).toEqual([]);

    // A key reads the moved sheet — exactly what a keyed driver reads first.
    readsAll();
    const keyed = await ingestKnowledgeDocBatch(asArg(docRow()), visionCtx());
    expect(keyed.done).toBe(true);
    expect(vision.calls).toEqual([3]);
    expect(docRow()).toMatchObject({ status: "ready", vision_failed_pages: [], vision_pages: 1 });
  });

  it("any reset that re-points the row at another file owes the same; one that keeps the file keeps the page numbers; a re-pointed document AI vision never read owes nothing (review fix pass 2)", async () => {
    const REV4 = "orgs/o1/dc/rev4.pdf";
    // A new file_key without purgeLineTraces (any other re-pointing caller).
    await lastGeneration();
    await resetKnowledgeIndex([DOC], { rowUpdate: () => ({ file_key: REV4 }) });
    expect(docRow()).toMatchObject({ file_key: REV4, vision_owed_pages: [OWES_EVERY_VISION_PAGE] });

    // The same file named again (no change of file): page 2 is page 2.
    const doc = await lastGeneration();
    await resetKnowledgeIndex([DOC], { rowUpdate: () => ({ file_key: doc.file_key, source_rev: "3" }) });
    expect(docRow().vision_owed_pages).toEqual([2]);

    // A rev-up of a document no AI vision ever read (a keyless org's).
    await lastGeneration({ vision_pages: 0 });
    db.tables.knowledge_chunks = db.tables.knowledge_chunks.filter((c) => c.page !== 2);
    await resetKnowledgeIndex([DOC], { purgeLineTraces: true, supersedeBusy: true, rowUpdate: () => ({ file_key: REV4 }) });
    expect(docRow()).toMatchObject({ file_key: REV4, vision_owed_pages: [] });
  });
});

describe("ING-13 / ING-6 (I-06b) — the drain's fileBehind stamps only a row no one holds, still as the drain read it", () => {
  // An unsponsored mirror in a read-every-page library: the drain cannot
  // work on it, so it files it behind what lapsed before now (fileBehind).
  const unsponsored = (over: Row = {}) => {
    resetDb({
      knowledge_documents: [baseDoc({
        library_id: "kl-all", created_by: null, file_key: "orgs/o1/dc/rev3.pdf",
        source_id: "src-1", source_document_id: "dc-1", source_version_id: "ver-3", ...over,
      })],
      knowledge_libraries: [{ id: "kl-all", org_id: "o1", ai_features: { visionAllPages: true } }],
      ai_connections: [], knowledge_chunks: [], knowledge_page_entities: [], entity_mentions: [], knowledge_line_traces: [],
    });
  };
  /** fileBehind's write: the stamp alone. */
  const isStamp = (op: Op) => op.table === "knowledge_documents" && op.kind === "update" &&
    Object.keys(op.payload as Row).join() === "vision_retry_after";
  /** Act as another writer at the instant between the drain's read and its stamp. */
  const beforeStamp = (act: (row: Row) => void) => db.hooks.push((op) => { if (isStamp(op)) act(docRow()); });
  const drain = () => drainKnowledgeIngestQueue({ maxPages: 100, deadlineMs: Date.now() + 30_000 });

  it("an unclaimed row is filed behind: its stamp moves to the run's time", async () => {
    unsponsored();
    const t0 = Date.now();
    const out = await drain();
    expect(out).toMatchObject({ docsTouched: 0, errors: [] });
    expect(Date.parse(String(docRow().vision_retry_after))).toBeGreaterThanOrEqual(t0);
    expect(db.ops.filter(isStamp)).toHaveLength(1);
  });

  it("a row someone claims after the drain read it is left exactly as the claimant holds it (the claim-free filter)", async () => {
    unsponsored();
    const at = new Date().toISOString();
    beforeStamp((row) => { row.ingest_claimed_by = "ingest:browser"; row.ingest_claimed_at = at; });
    const out = await drain();
    expect(out.errors).toEqual([]);
    expect(db.ops.filter(isStamp)).toHaveLength(1);                 // tried…
    expect(docRow()).toMatchObject({ vision_retry_after: null, ingest_claimed_by: "ingest:browser", ingest_claimed_at: at });
  });

  it("a claim older than the TTL holds no one: the stamp lands", async () => {
    unsponsored();
    beforeStamp((row) => { row.ingest_claimed_by = "killed"; row.ingest_claimed_at = new Date(Date.now() - INGEST_LEASE_TTL_MS - 60_000).toISOString(); });
    const t0 = Date.now();
    await drain();
    expect(Date.parse(String(docRow().vision_retry_after))).toBeGreaterThanOrEqual(t0);
  });

  it("a stamp another writer moved after the drain read it is kept — never overwritten (the compare-and-set on the stamp)", async () => {
    // Never stamped when read; a park writes its own stamp first.
    unsponsored();
    const parked = new Date(Date.now() - 5_000).toISOString();
    beforeStamp((row) => { row.vision_retry_after = parked; });
    expect((await drain()).errors).toEqual([]);
    expect(docRow().vision_retry_after).toBe(parked);

    // Stamped (and lapsed) when read; another writer re-stamps it first.
    const lapsed = new Date(Date.now() - 3_600_000).toISOString();
    unsponsored({ vision_retry_after: lapsed });
    const other = new Date(Date.now() - 1_000).toISOString();
    beforeStamp((row) => { row.vision_retry_after = other; });
    expect((await drain()).errors).toEqual([]);
    expect(docRow().vision_retry_after).toBe(other);
  });

  it("a row a rev-up re-pointed after the drain read it is left alone (the compare-and-set on file_key)", async () => {
    unsponsored();
    beforeStamp((row) => { Object.assign(row, { file_key: "orgs/o1/dc/rev4.pdf", source_version_id: "ver-4", status: "stale" }); });
    expect((await drain()).errors).toEqual([]);
    expect(docRow()).toMatchObject({ file_key: "orgs/o1/dc/rev4.pdf", vision_retry_after: null });
  });

  it("a stamp that cannot be written is reported in the run's errors, and the run goes on", async () => {
    unsponsored();
    db.hooks.push((op) => isStamp(op) ? { error: { code: "57014", message: "canceling statement due to statement timeout" } } : undefined);
    const out = await drain();
    expect(out.errors).toEqual([
      "025-PID-0101.pdf: could not move it behind newer work in the queue: canceling statement due to statement timeout",
    ]);
    expect(docRow().vision_retry_after).toBeNull();
  });

  it("a database without 20261122: no stamp is ever tried (nowhere to write it) — the row is skipped and the run goes on", async () => {
    const legacyCols = ["ingest_claimed_by", "ingest_claimed_at", "empty_pages", "vision_failed_pages", "vision_partial_accepted", "chunk_version", "vision_retry_after", "vision_retry_tried", "ingest_failures"];
    unsponsored();
    db.tables.knowledge_documents = db.tables.knowledge_documents.map((d) => Object.fromEntries(Object.entries(d).filter(([k]) => !legacyCols.includes(k))));
    db.missingColumns.knowledge_documents = legacyCols;
    const out = await drain();
    expect(out).toMatchObject({ docsTouched: 0, completed: 0, errors: [] });
    expect(db.ops.filter((o) => o.table === "knowledge_documents" && o.kind === "update")).toEqual([]);
    expect(docRow()).toMatchObject({ status: "pending", pages_indexed: 0 });
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

  it("a mirror re-pointed at a new revision after its file was checked is not refused: the new revision stays queued", async () => {
    const doc = baseDoc({ file_key: "orgs/o1/dc/list.pdf", source_id: "src-1", source_document_id: "dc-1", source_version_id: "ver-3" });
    resetDb({ knowledge_documents: [doc], knowledge_chunks: [], knowledge_page_entities: [], audit_logs: [] });
    r2.objects.set("orgs/o1/dc/list.pdf", XLSX);
    // A sync re-points the row between the check and the refusal.
    db.hooks.push((op) => {
      if (op.table !== "knowledge_documents" || op.kind !== "update") return;
      const p = op.payload as Row;
      if (!("ingest_claimed_by" in p) || p.ingest_claimed_by !== null || "status" in p) return;   // the batch's release
      Object.assign(docRow(), { file_key: "orgs/o1/dc/list-rev4.pdf", source_version_id: "ver-4", status: "stale" });
    });
    const out = await drainKnowledgeIngestQueue({ maxPages: 100, deadlineMs: Date.now() + 30_000 });
    expect(out.errors).toEqual([]);
    expect(docRow()).toMatchObject({ status: "stale", error: null, source_version_id: "ver-4" });
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

  it("ING-7's mention handoff (I-06b): a tag named in the sentence carried onto the next page is counted on the page it is written on, not again on the next", async () => {
    // Page 1 ends mid-sentence naming E-101; chunker 2 carries it onto
    // page 2, which names P-205 itself.
    const A: PageSpec = [
      "Welding of low alloy piping shall follow the qualified procedure for the joint.",
      "Preheat for exchanger E-101 shall be maintained at not less than 175F for P-No. 5 materials over",
    ];
    const B: PageSpec = [
      "1/2 in. nominal thickness, except where the procedure qualification permits a lower value.",
      "Pump P-205 is excluded from this requirement in every service listed here.",
    ];
    const doc = await seed([A, B]);
    library(2);
    await ingestKnowledgeDocBatch(asArg(doc));
    const page2 = rowsOf("knowledge_chunks").filter((c) => c.page === 2).map((c) => String(c.content)).join(" ");
    expect(page2.startsWith("[cont. from p. 1] Preheat for exchanger E-101")).toBe(true);
    const dict = [
      { assetId: "a-e101", alias: "E-101", origin: "tag" as const },
      { assetId: "a-p205", alias: "P-205", origin: "tag" as const },
    ];
    await indexDocumentMentions("o1", DOC, dict);
    const pagesOf = (asset: string) => rowsOf("entity_mentions").filter((m) => m.asset_id === asset).map((m) => m.page).sort();
    expect(pagesOf("a-e101")).toEqual([1]);
    expect(pagesOf("a-p205")).toEqual([2]);
  });

  it("the carried sentence is cut exactly — page N's own words, read back as the ingest does — or only the marker when they cannot be matched", () => {
    const pageN = "Bolting is per the table. Torque for flange (B-7, 3/4 in.) studs at 175F shall be";
    const carriedChunk = "[cont. from p. 3] Torque for flange (B-7, 3/4 in.) studs at 175F shall be checked twice. Gasket G-2 is new.";
    expect(withoutCarriedSentence(carriedChunk, (n) => (n === 3 ? pageN : undefined)).trim()).toBe("checked twice. Gasket G-2 is new.");
    // Page N's chunk not at hand: the marker goes, the words stay (as before).
    expect(withoutCarriedSentence(carriedChunk, () => undefined)).toBe(carriedChunk.slice("[cont. from p. 3] ".length));
    // A chunk with no carry is untouched.
    expect(withoutCarriedSentence("Gasket G-2 is new.", () => pageN)).toBe("Gasket G-2 is new.");
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

describe("GOV-5 / GOV-13 (I-18) — the ingest drain re-checks the uploader's headroom before EVERY page, and meters as it goes", () => {
  // The drain reads textless pages with AI vision on the uploader's key
  // (loadSponsorVision). It used to check the uploader's cap once per
  // document and meter once, after the document's last batch: a sponsor
  // under the cap at the start could be taken any distance past it in one
  // run, a run killed mid-document recorded nothing, and a sponsor AT the
  // cap had their pages consumed text-only — the document 'ready' with
  // those pages unread. Now every page's call is reserved against the cap
  // first (visionCallMeter), each call settles into the document's ONE
  // knowledgeVision row as it is made, and a refusal holds the page with
  // the reason on the row.
  const VISION_OUT = { inputTokens: 2_000, outputTokens: 3_000 };
  const DOC_NAME = "025-PID-0101.pdf";
  const sponsored = async (pages: PageSpec[], ai: Row = {}) => {
    const doc = await seed(pages);
    db.tables.knowledge_libraries = [{ id: "kl-1", org_id: "o1", ai_features: ai }];
    db.tables.ai_connections = [{ org_id: "o1", user_id: "u1", provider: "anthropic", model: "m", api_key: "k" }];
    db.tables.ai_key_agreements = [{ id: "ag-1", org_id: "o1", user_id: "u1", scope: "use", agreement_version: AGREEMENT_VERSION }];
    vision.impl = async (page) => ({ text: transcript(page), usage: VISION_OUT, model: "vision-tier" });
    return doc;
  };
  const drain = () => drainKnowledgeIngestQueue({ maxPages: 100, deadlineMs: Date.now() + 120_000 });
  /** One page's worst case, as the drain prices it. */
  const WORST = visionPageWorstCaseUsd({ provider: "anthropic", model: "m", instructions: "" }, DOC_NAME);
  /** What one call costs once its figures are in. */
  const CALL = estimateCostUsd("vision-tier", VISION_OUT);
  const visionRows = () => meter.rows.filter((r) => r.op === "knowledgeVision");

  it("a page's worst case is priced on the transcription's own output ceiling", async () => {
    const vision = await import("@/lib/knowledgeVision");
    const src = (await import("node:fs")).readFileSync("lib/knowledgeVision.ts", "utf8");
    expect(src).toContain(`maxTokens: ${VISION_PAGE_MAX_TOKENS},`);
    expect(vision.VISION_MODEL.anthropic).toBeTruthy();
    expect(WORST).toBeGreaterThan(CALL);
  });

  it("a sponsor at 100% of the cap: ZERO AI vision calls from the drain — the pages that need vision are held (never consumed text-only) and the row says why", async () => {
    await sponsored([null, prosePage("bolting"), null]);
    meter.cap = 10; meter.spent = 10;
    const out = await drain();
    expect(vision.calls).toEqual([]);
    expect(meter.asked).toEqual([]);                    // refused at the first check: nothing even reserved
    expect(out.errors).toEqual([]);
    // was: status 'ready', pages 1 and 3 indexed as empty, nothing to read them once the cap reset
    expect(docRow()).toMatchObject({ status: "indexing" });
    expect(pageListOf(docRow().vision_failed_pages)).toEqual([1, 3]);
    expect(String(docRow().error)).toMatch(/can't be retried for you now: The uploader's monthly AI cap is reached \(\$10\.00 of \$10\.00\), so pages without a text layer are held for AI vision — they are read once it resets on the 1st or is raised/);
    // the rest of the document is searchable meanwhile
    expect(rowsOf("knowledge_chunks").some((c) => c.page === 2)).toBe(true);
    expect(meter.rows).toEqual([]);
  });

  it("a sponsor locked at $0: zero calls — the reservation is refused before the first page, and the row says the lock", async () => {
    await sponsored([null, prosePage("bolting")]);
    meter.cap = Number.MIN_VALUE;                        // getCapUsd's answer for a stored 0
    await drain();
    expect(vision.calls).toEqual([]);
    expect(meter.asked.map((a) => a.refused)).toContain("locked");
    expect(docRow()).toMatchObject({ status: "indexing", vision_failed_pages: [1] });
    expect(String(docRow().error)).toMatch(/the uploader's monthly AI cap is set to \$0 \(AI is locked for them\)/);
    expect(meter.rows).toEqual([]);
  });

  it("a sponsor UNDER the cap with less headroom than one page could cost: zero calls — the page waits with the reason, and no reservation is left standing", async () => {
    await sponsored([null, prosePage("bolting")]);
    meter.cap = 10; meter.spent = 10 - WORST / 2;        // under the cap: the first check passes
    await drain();
    expect(vision.calls).toEqual([]);
    expect(meter.asked.length).toBeGreaterThan(0);
    expect(meter.asked.every((a) => a.refused === "does not fit")).toBe(true);
    expect(docRow()).toMatchObject({ status: "indexing", vision_failed_pages: [1] });
    expect(String(docRow().error)).toMatch(/AI vision could not read 1 page \(p\. 1\): the uploader's \$10\.00 monthly AI cap has \$\d+\.\d\d left; one page could cost up to \$\d+\.\d\d\. They are tried again automatically/);
    expect(meter.rows).toEqual([]);
  });

  it("headroom for two pages: the drain reads two and the third page's reservation is refused in the SAME run — the cap is re-checked before every call", async () => {
    await sponsored([null, null, null]);
    // page 1: 0 + WORST fits; page 2: CALL + WORST fits; page 3: 2·CALL + WORST does not
    meter.cap = 10; meter.spent = 10 - (2 * CALL + WORST - 0.001);
    await drain();
    expect(vision.calls).toEqual([1, 2]);
    expect(pageListOf(docRow().vision_failed_pages)).toEqual([3]);
    expect(docRow().status).toBe("indexing");
    // the two calls, in the document's ONE row
    expect(visionRows()).toHaveLength(1);
    expect(visionRows()[0]).toMatchObject({
      userId: "u1", reserved: false, ok: true, model: "vision-tier",
      inputTokens: 2 * VISION_OUT.inputTokens, outputTokens: 2 * VISION_OUT.outputTokens,
    });
    expect(meter.spent + visionRows()[0].costUsd).toBeLessThanOrEqual(meter.cap);
  });

  it("metered as it goes: the first page's figures are in the row before the second call is made (a cron killed mid-document has recorded what it spent)", async () => {
    await sponsored([null, null]);
    meter.cap = 10;
    const seenAtPage2: Array<{ reserved: boolean; inputTokens: number | null }> = [];
    vision.impl = async (page) => {
      if (page === 2) for (const r of visionRows()) seenAtPage2.push({ reserved: r.reserved, inputTokens: r.inputTokens });
      return { text: transcript(page), usage: VISION_OUT, model: "vision-tier" };
    };
    await drain();
    // at the second call: the document's row, settled to page 1's figures,
    // and the second call's own reservation beside it
    expect(seenAtPage2).toEqual([
      { reserved: false, inputTokens: VISION_OUT.inputTokens },
      { reserved: true, inputTokens: null },
    ]);
    // after: one row, both calls, nothing left reserved
    expect(visionRows()).toEqual([expect.objectContaining({ reserved: false, inputTokens: 2 * VISION_OUT.inputTokens })]);
  });

  it("REGRESSION — an uploader under the cap: the same pages read, the document 'ready', and ONE knowledgeVision row carrying every call's tokens (nothing left reserved, nothing metered twice)", async () => {
    await sponsored([null, prosePage("bolting"), null]);
    meter.cap = 10;
    const out = await drain();
    expect(out).toMatchObject({ completed: 1, errors: [] });
    expect(vision.calls).toEqual([1, 3]);
    expect(docRow()).toMatchObject({ status: "ready", vision_failed_pages: [], error: null });
    expect(meter.asked.every((a) => a.refused === null)).toBe(true);
    expect(visionRows()).toEqual([expect.objectContaining({
      orgId: "o1", userId: "u1", provider: "anthropic", model: "vision-tier", reserved: false, ok: true,
      inputTokens: 2 * VISION_OUT.inputTokens, outputTokens: 2 * VISION_OUT.outputTokens,
      costUsd: estimateCostUsd("vision-tier", { inputTokens: 2 * VISION_OUT.inputTokens, outputTokens: 2 * VISION_OUT.outputTokens }),
    })]);
    expect(meter.recorded).toEqual([]);
  });

  it("a read-every-page library whose uploader is at the cap: nothing is read or indexed, the document waits in the queue, and the row says why", async () => {
    await sponsored([null, prosePage("bolting")], { visionAllPages: true });
    meter.cap = 10; meter.spent = 12.5;
    const t0 = Date.now();
    const out = await drain();
    expect(out).toMatchObject({ docsTouched: 0, errors: [] });
    expect(vision.calls).toEqual([]);
    expect(rowsOf("knowledge_chunks")).toHaveLength(0);
    expect(docRow().status).toBe("pending");
    expect(Date.parse(String(docRow().vision_retry_after))).toBeGreaterThanOrEqual(t0);
    expect(docRow().error).toBe(
      "This library reads every page with AI vision, so the document waits in the queue: the uploader's monthly AI cap is reached ($12.50 of $10.00). " +
      "It is indexed once it resets on the 1st or is raised, or when a controller with budget indexes it.");
  });
});
