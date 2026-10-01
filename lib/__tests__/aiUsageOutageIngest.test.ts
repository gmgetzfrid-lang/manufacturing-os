// intelligence Round G — I-05 GOV-4: a ledger that cannot be read refuses
// the AI step, never the work around it.
//
// getMonthUsage / getCapUsd throw AiUsageUnavailableError (503) instead of
// reading as $0 / $10. The ingest paths' vision is optional — no key or no
// headroom has always meant text-only indexing — so an unreadable ledger must
// mean the same there:
//   - /api/knowledge/ingest indexes the text layer and says why vision was
//     skipped (it used to answer a bare 500 and index nothing);
//   - the maintenance cron's ingest drain indexes text-only (or files a
//     read-every-page library behind) and goes on to the next document (it
//     used to end the whole run, for every org);
//   - /api/codebook/import (AI-only) answers the 503 sentence, not a 500.
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
import { drainKnowledgeIngestQueue } from "@/lib/knowledgeIngest";
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
  it("the interactive ingest route indexes the text layer and says why vision was skipped (was: a bare 500, nothing indexed)", async () => {
    seed([docRow("kd-1")]);
    r2.objects.set(KEY("kd-1"), await makePdf([prosePage("bolting"), drawingSheet(1, ["V-101", "P-201A"])]));
    const res = await ingestPOST(new NextRequest("http://x/api/knowledge/ingest", {
      method: "POST", headers: { authorization: "Bearer good", "content-type": "application/json" }, body: JSON.stringify({ documentId: "kd-1" }),
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.done).toBe(true);
    expect(body.visionSkipReason).toMatch(/^AI usage can't be read right now, so pages without a text layer were skipped/);
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
