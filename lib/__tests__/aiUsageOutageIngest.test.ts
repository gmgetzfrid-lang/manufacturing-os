// intelligence Round G — I-05 GOV-4: a ledger that cannot be read refuses
// the AI step, never the work around it.
//
// getMonthUsage / getCapUsd throw AiUsageUnavailableError (503) instead of
// reading as $0 / $10. The ingest paths' vision is optional — no key or no
// headroom has always meant text-only indexing — so an unreadable ledger must
// mean the same there:
//   - /api/knowledge/ingest indexes the text layer and says why vision was
//     withheld (it used to answer a bare 500 and index nothing);
//   - the maintenance cron's ingest drain indexes text-only (or files a
//     read-every-page library behind) and goes on to the next document (it
//     used to end the whole run, for every org);
//   - /api/codebook/import (AI-only) answers the 503 sentence, not a 500.
// GOV-11 / GOV-4 (fix pass 7): a reason the member can fix — an agreement
// that is unsigned or cannot be read, a ledger that cannot be read — never
// CONSUMES a page that needs vision: it is held on the row (and a
// read-every-page library is not indexed at all), on both drivers, and read
// once the reason is gone.
// Driven over real PDFs and the real engine against the in-memory database.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { db, resetDb, rowsOf, type Row } from "./knowledgeFakeDb";
import { makePdf, prosePage, drawingSheet } from "./knowledgePdfFixtures";
import { GovernedCallError, isAiUsageUnavailable } from "@/lib/ai/gateError";

const r2 = vi.hoisted(() => ({ objects: new Map<string, Uint8Array>() }));
const ledger = vi.hoisted(() => ({ down: true }));
vi.mock("@/lib/supabaseAdmin", async () => ({ supabaseAdmin: (await import("./knowledgeFakeDb")).fakeAdmin }));
vi.mock("@/lib/r2", () => ({
  R2_BUCKET: "bucket",
  r2: {
    send: async (cmd: { constructor: { name: string }; input: { Key: string; Range?: string } }) => {
      if (cmd.constructor.name === "DeleteObjectCommand") return {};
      const bytes = r2.objects.get(cmd.input.Key);
      if (!bytes) throw new Error(`NoSuchKey ${cmd.input.Key}`);
      const m = /bytes=(\d+)-(\d+)/.exec(cmd.input.Range ?? "");
      return { Body: m ? bytes.slice(Number(m[1]), Number(m[2]) + 1) : bytes };
    },
  },
}));
vi.mock("@/lib/knowledgeVision", () => ({ transcribePageImage: vi.fn(async () => { throw new Error("no vision in this test"); }) }));
vi.mock("unpdf", async (orig) => ({
  ...(await orig<typeof import("unpdf")>()),
  renderPageAsImage: vi.fn(async () => new Uint8Array([137, 80, 78, 71]).buffer),
}));
vi.mock("@/lib/equipmentBridgeServer", () => ({ computeForKnowledgeDoc: vi.fn(async () => undefined) }));
vi.mock("@/lib/mentionIndexer", () => ({ loadAliasDictionary: vi.fn(async () => []), indexDocumentMentions: vi.fn(async () => undefined) }));
vi.mock("@/lib/aiInstructionsServer", () => ({ loadOrgInstructionsBlock: vi.fn(async () => "") }));
vi.mock("@/lib/ai/keyVault", () => ({ openAiKey: (k: string) => k }));
vi.mock("@/lib/ai/providerCall", async (orig) => ({
  ...(await orig<typeof import("@/lib/ai/providerCall")>()),
  callAiModel: vi.fn(async () => { throw new Error("no provider call in this test"); }),
}));
// The ledger is down: both reads throw the 503 refusal (the real class's
// shape — a GovernedCallError flagged usageUnavailable).
vi.mock("@/lib/ai/usageServer", async () => {
  const { GovernedCallError: G } = await import("@/lib/ai/gateError");
  const down = () => new G("AI usage can't be read right now, so AI calls are refused until it can (couldn't read the usage ledger: statement timeout).", 503, { usageUnavailable: true });
  return {
    getMonthUsage: vi.fn(async () => { if (ledger.down) throw down(); return { spentUsd: 0 }; }),
    getCapUsd: vi.fn(async () => { if (ledger.down) throw down(); return 10; }),
    recordAskUsage: vi.fn(async () => undefined),
  };
});

import { POST as ingestPOST } from "@/app/api/knowledge/ingest/route";
import { POST as codebookPOST } from "@/app/api/codebook/import/route";
import { drainKnowledgeIngestQueue, visionRetryMessage } from "@/lib/knowledgeIngest";
import { transcribePageImage } from "@/lib/knowledgeVision";
import { callAiModel } from "@/lib/ai/providerCall";
import { AGREEMENT_VERSION } from "@/lib/ai/pricing";

const KEY = (id: string) => `orgs/o1/knowledge/kl-1/${id}.pdf`;
const docRow = (id: string, over: Row = {}): Row => ({
  id, org_id: "o1", library_id: "kl-1", name: `${id}.pdf`, file_key: KEY(id), status: "pending",
  pages_indexed: 0, page_count: null, last_section: null, created_by: "u-ctrl", created_at: "2026-09-30", error: null,
  source_id: null, source_document_id: null, source_version_id: null, source_rev: null,
  vision_pages: 0, empty_pages: 0, vision_failed_pages: [], vision_partial_accepted: false, chunk_version: null,
  vision_retry_after: null, vision_retry_tried: [], ingest_failures: 0, ingest_claimed_by: null, ingest_claimed_at: null, ...over,
});
const seed = (docs: Row[], aiFeatures: Row = {}) => resetDb({
  knowledge_documents: docs, knowledge_chunks: [], knowledge_page_entities: [], entity_mentions: [], knowledge_line_traces: [],
  org_members: [{ org_id: "o1", uid: "u-ctrl", role: "Admin", roles: ["Admin"], status: "active" }],
  knowledge_libraries: [{ id: "kl-1", org_id: "o1", ai_features: aiFeatures }],
  ai_connections: [{ org_id: "o1", user_id: "u-ctrl", provider: "anthropic", model: "user-model", api_key: "k" }],
  ai_key_agreements: [{ id: "ag-1", org_id: "o1", user_id: "u-ctrl", scope: "use", agreement_version: AGREEMENT_VERSION }],
  audit_logs: [],
});
const docOf = (id: string) => rowsOf("knowledge_documents").find((r) => r.id === id)!;

beforeEach(() => {
  r2.objects.clear();
  ledger.down = true;
  vi.mocked(transcribePageImage).mockClear();
  vi.mocked(callAiModel).mockClear();
});

describe("GOV-4 — an unreadable ledger skips the AI step, never the indexing", () => {
  it("the interactive ingest route indexes the text layer and says why vision was withheld (was: a bare 500, nothing indexed)", async () => {
    seed([docRow("kd-1")]);
    r2.objects.set(KEY("kd-1"), await makePdf([prosePage("bolting"), drawingSheet(1, ["V-101", "P-201A"])]));
    const res = await ingestPOST(new NextRequest("http://x/api/knowledge/ingest", {
      method: "POST", headers: { authorization: "Bearer good", "content-type": "application/json" }, body: JSON.stringify({ documentId: "kd-1" }),
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.done).toBe(true);
    expect(body.visionSkipReason).toMatch(/^AI usage can't be read right now, so pages without a text layer are held for AI vision\.$/);
    expect(body.visionSkipReason).not.toMatch(/automatically/);
    expect(vi.mocked(transcribePageImage)).not.toHaveBeenCalled();
    expect(rowsOf("knowledge_chunks").length).toBeGreaterThan(0);
    expect(docOf("kd-1").status).toBe("ready");
  });

  it("the cron's ingest drain indexes text-only and goes on to the next document — the run is not ended for everyone", async () => {
    seed([docRow("kd-1", { created_at: "2026-09-01" }), docRow("kd-2", { created_at: "2026-09-02" })]);
    r2.objects.set(KEY("kd-1"), await makePdf([prosePage("bolting")]));
    r2.objects.set(KEY("kd-2"), await makePdf([prosePage("gaskets")]));
    const out = await drainKnowledgeIngestQueue({ maxPages: 100, deadlineMs: Date.now() + 30_000 });
    expect(out.errors).toEqual([]);
    expect(out.completed).toBe(2);
    expect(docOf("kd-1").status).toBe("ready");
    expect(docOf("kd-2").status).toBe("ready");
    expect(vi.mocked(transcribePageImage)).not.toHaveBeenCalled();
  });

  it("a read-every-page library is filed behind, not consumed text-only, and the drain does not throw", async () => {
    seed([docRow("kd-1")], { visionAllPages: true });
    r2.objects.set(KEY("kd-1"), await makePdf([drawingSheet(1, ["V-101", "P-201A"])]));
    const out = await drainKnowledgeIngestQueue({ maxPages: 100, deadlineMs: Date.now() + 30_000 });
    expect(out.errors).toEqual([]);
    expect(out.docsTouched).toBe(0);
    expect(rowsOf("knowledge_chunks")).toHaveLength(0);
    expect(docOf("kd-1").status).toBe("pending");
  });

  it("only the usage-unavailable refusal is absorbed — any other error still surfaces", () => {
    expect(isAiUsageUnavailable(new GovernedCallError("x", 503, { usageUnavailable: true }))).toBe(true);
    expect(isAiUsageUnavailable(new GovernedCallError("locked", 402, { locked: true }))).toBe(false);
    expect(isAiUsageUnavailable(new GovernedCallError("no key", 412))).toBe(false);
    expect(isAiUsageUnavailable(new Error("statement timeout"))).toBe(false);
    expect(isAiUsageUnavailable(null)).toBe(false);
  });
});

describe("GOV-11 — the interactive ingest route sends page images only for a member who accepted the agreement", () => {
  const ingest = () => ingestPOST(new NextRequest("http://x/api/knowledge/ingest", {
    method: "POST", headers: { authorization: "Bearer good", "content-type": "application/json" }, body: JSON.stringify({ documentId: "kd-1" }),
  }));

  it("unsigned (or signed an older version): the text layer indexes, vision is skipped with the reason, no page image leaves", async () => {
    ledger.down = false;
    for (const agreements of [[], [{ id: "ag-0", org_id: "o1", user_id: "u-ctrl", scope: "use", agreement_version: "2026-07-v2" }]]) {
      seed([docRow("kd-1")]);
      db.tables.ai_key_agreements = agreements;
      r2.objects.set(KEY("kd-1"), await makePdf([prosePage("bolting"), null]));
      vi.mocked(transcribePageImage).mockClear();
      const res = await ingest();
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.visionSkipReason).toMatch(/^Accept the AI acceptable-use agreement to read pages that have no text layer/);
      expect(vi.mocked(transcribePageImage)).not.toHaveBeenCalled();
      expect(rowsOf("knowledge_chunks").length).toBeGreaterThan(0);
      // …and the textless page is HELD for vision, never consumed (fix pass 7)
      expect(body).toMatchObject({ done: false, visionFailedPages: [2] });
      expect(docOf("kd-1")).toMatchObject({ status: "indexing", vision_failed_pages: [2], vision_pages: 0 });
    }
  });

  it("an acceptance record that cannot be read is never taken as signed", async () => {
    ledger.down = false;
    seed([docRow("kd-1")]);
    db.hooks.push((op) => (op.table === "ai_key_agreements" ? { error: { code: "57014", message: "canceling statement due to statement timeout" } } : undefined));
    r2.objects.set(KEY("kd-1"), await makePdf([prosePage("bolting"), null]));
    vi.mocked(transcribePageImage).mockClear();
    const body = await (await ingest()).json();
    expect(body.visionSkipReason).toMatch(/agreement can't be checked right now/);
    expect(vi.mocked(transcribePageImage)).not.toHaveBeenCalled();
  });

  it("signed at the current version: the textless page is read with vision", async () => {
    ledger.down = false;
    seed([docRow("kd-1")]);
    r2.objects.set(KEY("kd-1"), await makePdf([prosePage("bolting"), null]));
    vi.mocked(transcribePageImage).mockClear();
    const body = await (await ingest()).json();
    // (this suite's provider refuses every page — the reason is that, not the agreement)
    expect(String(body.visionSkipReason ?? "")).not.toMatch(/agreement/);
    expect(vi.mocked(transcribePageImage)).toHaveBeenCalled();
  });

  it("a document waiting on AI vision: a member with a working key who has not accepted is told to accept — in the 409 and on the row — never to add the key they saved", async () => {
    // The vision-retry stage: the main pass is through, page 1 waits on AI
    // vision. The engine parks it for want of a vision context; it used to
    // say "retrying needs an AI key with budget left … Add one in AI
    // settings" whatever the route's reason was.
    const atRetryStage = async () => {
      seed([docRow("kd-1", { status: "indexing", pages_indexed: 2, page_count: 2, vision_failed_pages: [1] })]);
      db.tables.knowledge_chunks = [{ id: "c-2", document_id: "kd-1", org_id: "o1", library_id: "kl-1", page: 2, seq: 0, content: "bolting text" }];
      r2.objects.set(KEY("kd-1"), await makePdf([null, prosePage("bolting")]));
      vi.mocked(transcribePageImage).mockClear();
    };
    ledger.down = false;
    await atRetryStage();
    db.tables.ai_key_agreements = [];
    const res = await ingest();
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.visionRetryBlocked).toBe(true);
    expect(body.visionSkipReason).toMatch(/^Accept the AI acceptable-use agreement/);
    expect(body.error).toBe(visionRetryMessage([1], null, "Accept the AI acceptable-use agreement to read pages that have no text layer — they are sent " +
      "to your AI provider as images (ask any question in Knowledge to be prompted)."));
    expect(body.error).toMatch(/^AI vision could not read 1 page \(p\. 1\), and it can't be retried for you now: Accept the AI acceptable-use agreement to read pages/);
    expect(body.error).not.toMatch(/AI key|AI settings/);
    expect(docOf("kd-1")).toMatchObject({ status: "indexing", error: body.error, vision_failed_pages: [1] });
    expect(vi.mocked(transcribePageImage)).not.toHaveBeenCalled();

    // A ledger that cannot be read is named the same way (GOV-4).
    await atRetryStage();
    ledger.down = true;
    const down = await (await ingest()).json();
    expect(down.error).toMatch(/can't be retried for you now: AI usage can't be read right now/);
    expect(docOf("kd-1").error).toBe(down.error);

    // No key at all: the engine's own sentence still fits, and is kept.
    await atRetryStage();
    ledger.down = false;
    db.tables.ai_connections = [];
    const keyless = await (await ingest()).json();
    expect(keyless.error).toBe(visionRetryMessage([1], null));
    expect(keyless.visionSkipReason).toMatch(/^Add your AI key in AI settings/);
  });

  it("the route's reason is cut to fit the row's error, never the way out that follows it", () => {
    const pages = Array.from({ length: 30 }, (_, i) => i + 1);
    const m = visionRetryMessage(pages, null, `Accept the agreement. ${"x".repeat(900)}`);
    expect(m.length).toBeLessThanOrEqual(500);
    expect(m).toMatch(/^AI vision could not read 30 pages \(p\. 1, 2, .*, …\), and they can't be retried for you now: Accept the agreement\. x+… The rest of the document is searchable meanwhile\. If they stay unread, ask an admin to accept the partial index\.$/);
    // a cause (the provider's refusal) still wins over the route's reason
    expect(visionRetryMessage([1], "provider 529 overloaded", "Accept the agreement.")).toBe(visionRetryMessage([1], "provider 529 overloaded"));
  });
});

describe("GOV-11 / GOV-4 — a page that needs vision is never consumed text-only for a reason the member can fix (the seventh review)", () => {
  const ingest = () => ingestPOST(new NextRequest("http://x/api/knowledge/ingest", {
    method: "POST", headers: { authorization: "Bearer good", "content-type": "application/json" }, body: JSON.stringify({ documentId: "kd-1" }),
  }));
  const signedV2 = [{ id: "ag-0", org_id: "o1", user_id: "u-ctrl", scope: "use", agreement_version: "2026-07-v2" }];
  const readable = (page: number) => ({
    text: `SHEET ${page} PROCESS AND INSTRUMENT DIAGRAM\nV-${100 + page} SEPARATOR DRUM\nP-${200 + page}A FEED PUMP\nSEE DWG 025-PID-0102`,
    usage: { inputTokens: 10, outputTokens: 10 }, model: "vision-tier",
  });

  it("the review's scenario: a read-every-page library, a member with a key who signed only the previous version — nothing is indexed, 428 with the agreement, the row stays queued (the drain refuses the same document)", async () => {
    ledger.down = false;
    seed([docRow("kd-1")], { visionAllPages: true });
    db.tables.ai_key_agreements = signedV2;
    r2.objects.set(KEY("kd-1"), await makePdf([drawingSheet(1, ["V-101", "P-201A"]), null]));
    const before = { ...docOf("kd-1") };
    const res = await ingest();
    expect(res.status).toBe(428);
    const body = await res.json();
    expect(body).toMatchObject({ done: false, heldForVision: true, agreementRequired: true, agreementVersion: AGREEMENT_VERSION });
    expect(String(body.agreementText)).toMatch(/\S/);
    expect(body.error).toMatch(/^This library reads every page with AI vision, so nothing was indexed and the document stays queued — accept the AI acceptable-use agreement first/);
    expect(body.visionSkipReason).toBe(body.error);
    expect(vi.mocked(transcribePageImage)).not.toHaveBeenCalled();
    // was: 200 done, status 'ready', vision_pages 0, empty_pages 1 — the drawings indexed as empty pages for good
    expect(rowsOf("knowledge_chunks")).toHaveLength(0);
    expect(rowsOf("knowledge_page_entities")).toHaveLength(0);
    expect(docOf("kd-1")).toEqual(before);
    // the drain, same seed, same unsigned uploader: refuses it too
    const out = await drainKnowledgeIngestQueue({ maxPages: 100, deadlineMs: Date.now() + 30_000 });
    expect(out.docsTouched).toBe(0);
    expect(docOf("kd-1").status).toBe("pending");
    expect(rowsOf("knowledge_chunks")).toHaveLength(0);
  });

  it("…and so does an acceptance or a ledger that cannot be read (409, nothing indexed); a key at its cap is the engine's own case, as before", async () => {
    ledger.down = false;
    seed([docRow("kd-1")], { visionAllPages: true });
    db.hooks.push((op) => (op.table === "ai_key_agreements" ? { error: { code: "57014", message: "canceling statement due to statement timeout" } } : undefined));
    r2.objects.set(KEY("kd-1"), await makePdf([drawingSheet(1, ["V-101", "P-201A"]), null]));
    const unreadable = await ingest();
    expect(unreadable.status).toBe(409);
    const ub = await unreadable.json();
    expect(ub.error).toMatch(/nothing was indexed and the document stays queued — your AI acceptable-use agreement can't be checked right now\./);
    expect(ub.agreementRequired).toBeUndefined();
    expect(rowsOf("knowledge_chunks")).toHaveLength(0);

    seed([docRow("kd-1")], { visionAllPages: true });
    ledger.down = true;
    const down = await ingest();
    expect(down.status).toBe(409);
    expect((await down.json()).error).toMatch(/stays queued — AI usage can't be read right now\./);
    expect(rowsOf("knowledge_chunks")).toHaveLength(0);
    expect(docOf("kd-1").status).toBe("pending");
    expect(vi.mocked(transcribePageImage)).not.toHaveBeenCalled();
  });

  it("a textless page for a member who has not accepted stays in vision_failed_pages — the document is never 'ready' without it — and is read once they accept", async () => {
    ledger.down = false;
    seed([docRow("kd-1")]);
    db.tables.ai_key_agreements = signedV2;
    r2.objects.set(KEY("kd-1"), await makePdf([prosePage("bolting"), null]));
    // The main pass: the prose page indexes, the textless page is held.
    const first = await ingest();
    expect(first.status).toBe(200);
    const fb = await first.json();
    expect(fb).toMatchObject({ done: false, visionFailedPages: [2], visionPages: 0 });
    expect(fb.visionSkipReason).toMatch(/^Accept the AI acceptable-use agreement to read pages that have no text layer .* 1 page waits for AI vision on the document — it is not marked ready until that page is read or the partial index is accepted\.$/);
    expect(docOf("kd-1")).toMatchObject({ status: "indexing", pages_indexed: 2, page_count: 2, vision_failed_pages: [2], vision_pages: 0 });
    expect(rowsOf("knowledge_chunks").every((c) => c.page === 1)).toBe(true);
    // The next pass reaches the retry stage: refused with the agreement — on the row and in the 409, with what to accept.
    const second = await ingest();
    expect(second.status).toBe(409);
    const sb = await second.json();
    expect(sb).toMatchObject({ visionRetryBlocked: true, agreementRequired: true, agreementVersion: AGREEMENT_VERSION });
    expect(sb.error).toMatch(/^AI vision could not read 1 page \(p\. 2\), and it can't be retried for you now: Accept the AI acceptable-use agreement/);
    expect(docOf("kd-1")).toMatchObject({ status: "indexing", error: sb.error, vision_failed_pages: [2] });
    expect(vi.mocked(transcribePageImage)).not.toHaveBeenCalled();
    // They accept: the next pass reads the page, and only then is the document ready.
    db.tables.ai_key_agreements = [{ id: "ag-1", org_id: "o1", user_id: "u-ctrl", scope: "use", agreement_version: AGREEMENT_VERSION }];
    vi.mocked(transcribePageImage).mockResolvedValueOnce(readable(2) as Awaited<ReturnType<typeof transcribePageImage>>);
    const third = await ingest();
    expect(third.status).toBe(200);
    expect(await third.json()).toMatchObject({ done: true, visionFailedPages: [] });
    expect(vi.mocked(transcribePageImage)).toHaveBeenCalledTimes(1);
    expect(docOf("kd-1")).toMatchObject({ status: "ready", vision_pages: 1, vision_failed_pages: [], error: null });
    expect(rowsOf("knowledge_chunks").some((c) => c.page === 2 && c.source === "vision")).toBe(true);
  });

  it("an outage holds the page the same way (GOV-4) — and a member with no key, or at the cap, still indexes text-only, said without promising a later read", async () => {
    seed([docRow("kd-1")]);
    r2.objects.set(KEY("kd-1"), await makePdf([prosePage("bolting"), null]));
    const down = await (await ingest()).json();
    expect(down).toMatchObject({ done: false, visionFailedPages: [2] });
    expect(down.visionSkipReason).toMatch(/^AI usage can't be read right now, so pages without a text layer are held for AI vision\. 1 page waits for AI vision/);
    expect(docOf("kd-1")).toMatchObject({ status: "indexing", vision_failed_pages: [2] });

    ledger.down = false;
    seed([docRow("kd-1")]);
    db.tables.ai_connections = [];
    const keyless = await (await ingest()).json();
    expect(keyless).toMatchObject({ done: true, visionFailedPages: [] });
    expect(docOf("kd-1").status).toBe("ready");

    seed([docRow("kd-1")]);
    const usage = await import("@/lib/ai/usageServer");
    vi.mocked(usage.getMonthUsage).mockResolvedValueOnce({ spentUsd: 10 } as Awaited<ReturnType<typeof usage.getMonthUsage>>);
    const capped = await (await ingest()).json();
    expect(capped).toMatchObject({ done: true });
    expect(capped.visionSkipReason).toBe("Monthly AI budget reached ($10.00 of $10.00) — pages without a text layer were indexed from their text layer only.");
  });

  it("the drain holds the page for an uploader with a key who has not accepted, and names that on the row — its next pass no longer rewrites it with 'Add one in AI settings'", async () => {
    ledger.down = false;
    // The main pass: held, not consumed (was: 'ready' with the page empty).
    seed([docRow("kd-1")]);
    db.tables.ai_key_agreements = signedV2;
    r2.objects.set(KEY("kd-1"), await makePdf([prosePage("bolting"), null]));
    const out = await drainKnowledgeIngestQueue({ maxPages: 100, deadlineMs: Date.now() + 30_000 });
    expect(out.errors).toEqual([]);
    expect(out.completed).toBe(0);
    expect(docOf("kd-1")).toMatchObject({ status: "indexing", vision_failed_pages: [2] });
    const parked = String(docOf("kd-1").error);
    expect(parked).toMatch(/^AI vision could not read 1 page \(p\. 2\), and it can't be retried for you now: The uploader has not accepted the current AI acceptable-use agreement/);
    expect(parked).not.toMatch(/AI key|AI settings/);
    expect(parked.length).toBeLessThanOrEqual(500);

    // The review's sequence: the interactive route parks it with its reason,
    // then the drain runs — the row keeps naming the agreement.
    seed([docRow("kd-1", { status: "indexing", pages_indexed: 2, page_count: 2, vision_failed_pages: [1] })]);
    db.tables.ai_key_agreements = [];
    r2.objects.set(KEY("kd-1"), await makePdf([null, prosePage("bolting")]));
    expect((await ingest()).status).toBe(409);
    expect(String(docOf("kd-1").error)).toMatch(/can't be retried for you now: Accept the AI acceptable-use agreement/);
    await drainKnowledgeIngestQueue({ maxPages: 100, deadlineMs: Date.now() + 30_000 });
    expect(String(docOf("kd-1").error)).toMatch(/can't be retried for you now: The uploader has not accepted the current AI acceptable-use agreement/);
    expect(String(docOf("kd-1").error)).not.toMatch(/Add one in AI settings/);
    // An outage is named too.
    seed([docRow("kd-1", { status: "indexing", pages_indexed: 2, page_count: 2, vision_failed_pages: [1] })]);
    ledger.down = true;
    await drainKnowledgeIngestQueue({ maxPages: 100, deadlineMs: Date.now() + 30_000 });
    expect(String(docOf("kd-1").error)).toMatch(/can't be retried for you now: AI usage can't be read right now/);
    expect(vi.mocked(transcribePageImage)).not.toHaveBeenCalled();
  });
});

describe("GOV-4 — the codebook import answers the ledger's 503 sentence, not a 500", () => {
  it("an unreadable ledger refuses the import call before the provider, with its own status and words", async () => {
    seed([]);
    const res = await codebookPOST(new NextRequest("http://x/api/codebook/import", {
      method: "POST", headers: { authorization: "Bearer good", "content-type": "application/json" },
      body: JSON.stringify({ orgId: "o1", text: "UNIT 02 = Crude unit\nP = pumps" }),
    }));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/AI usage can't be read right now/);
    expect(vi.mocked(callAiModel)).not.toHaveBeenCalled();
    expect(db.ops.some((o) => o.table === "ai_usage_events")).toBe(false);
  });
});
