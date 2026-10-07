// intelligence Round G — I-18 (GOV-13): /api/knowledge/embed, the
// browser-driven meaning-index build, reserves every batch its slice claims
// before the batch is sent, and meters the request as it goes.
//
// It read the month once and then embedded batch after batch for up to the
// slice's budget, metering once at the end: two tabs (or a tab and the
// background drain) each spent the same headroom, and a pass the platform
// killed recorded nothing. Driven through the real route and the real slice
// (lib/knowledgeEmbedCore) over the in-memory admin; the ledger is the
// reservation stand-in (./helpers/fakeUsageMeter); the provider is a stub.
//
//   REGRESSION  a member under the cap: the batch embedded, the answer as
//               before (spentThisRun, no error), and ONE knowledgeEmbed row
//               with the request's tokens — nothing left reserved
//   GOV-13      a batch whose worst case no longer fits is sent nowhere: no
//               provider call, the passages go back to the queue untouched,
//               and the refusal is the answer's error (the build loop stops);
//               a later batch's figures are written into the request's row
//               BEFORE its own reservation is given back (fix pass 3)

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { freshAdminState, installMarkerRpc, type Row } from "./helpers/knowledgeFakeAdmin";
import { meter, resetMeter } from "./helpers/fakeUsageMeter";

const admin = vi.hoisted(() => ({ state: null as unknown as import("./helpers/knowledgeFakeAdmin").FakeAdminState }));
vi.mock("@/lib/supabaseAdmin", async () => {
  const { makeFakeAdmin: make, freshAdminState: fresh } = await import("./helpers/knowledgeFakeAdmin");
  admin.state ??= fresh();
  const proxy = new Proxy({}, { get: (_t, p: string) => (make(admin.state) as Record<string, unknown>)[p] });
  return { supabaseAdmin: proxy };
});
vi.mock("@/lib/knowledgeAccess", () => ({ loadPrincipal: vi.fn(async () => ({ isController: true })) }));
vi.mock("@/lib/ai/usageServer", async () => (await import("./helpers/fakeUsageMeter")).fakeUsageServer());
vi.mock("@/lib/ai/keyVault", () => ({ openAiKey: (v: unknown) => v }));

import { AGREEMENT_VERSION, estimateCostUsd } from "@/lib/ai/pricing";
import { EMBEDDING_PROVIDERS, EMBEDDING_DIMENSIONS } from "@/lib/ai/embeddings";
import { POST } from "@/app/api/knowledge/embed/route";

const ORG = "0a000000-0000-4000-8000-000000000001";
const LIB = "0b000000-0000-4000-8000-000000000001";
const DOC = "0e000000-0000-4000-8000-000000000001";
const ME = "0d000000-0000-4000-8000-00000000000a";
// Model names come from the catalogue, never spelled out here.
const MODEL = EMBEDDING_PROVIDERS.find((p) => p.id === "voyage")!.models[0];
const PASSAGES = 12;

const calls = { n: 0 };
beforeEach(() => {
  admin.state ??= freshAdminState();
  Object.assign(admin.state, freshAdminState());
  admin.state.user = { id: ME };
  resetMeter({ cap: 10 });
  calls.n = 0;
  const chunks = () => admin.state.tables.knowledge_chunks;
  admin.state.tables.knowledge_documents = [{ id: DOC, org_id: ORG, library_id: LIB, name: "EP-5-6-2 Pipe supports", status: "ready" }];
  admin.state.tables.knowledge_chunks = Array.from({ length: PASSAGES }, (_, i) => ({
    id: `c${String(i + 1).padStart(3, "0")}`, org_id: ORG, library_id: LIB, document_id: DOC, page: i + 1, seq: 0, section: null,
    content: `passage ${i + 1} `.repeat(40), embedding: null, embedding_model: null, embed_attempts: 0,
    embed_error: null, embed_claimed_until: null, embed_retry_after: null,
  }));
  admin.state.tables.knowledge_libraries = [{ id: LIB, org_id: ORG, name: "Standards", ai_features: {} }];
  admin.state.tables.ai_connections = [{ org_id: ORG, user_id: ME, provider: "anthropic", api_key: "k", embedding_provider: "voyage", embedding_model: MODEL, embedding_api_key: "pa" }];
  admin.state.tables.ai_key_agreements = [{ org_id: ORG, user_id: ME, scope: "use", agreement_version: AGREEMENT_VERSION }];
  admin.state.tables.audit_logs = [];
  const open = () => chunks().filter((c) => c.embedding == null);
  admin.state.rpc.semantic_coverage = () => ({ data: [{ total: chunks().length, embedded: chunks().length - open().length }], error: null });
  admin.state.rpc.semantic_coverage_detail = () => ({
    data: [{
      total: chunks().length, embedded: chunks().length - open().length, remaining: open().length, failed: 0,
      leased: open().filter((c) => c.embed_claimed_until && Date.parse(String(c.embed_claimed_until)) > Date.now()).length,
      waiting: 0, remaining_chars: 0, total_chars: 0,
      models: chunks().some((c) => c.embedding != null) ? { [MODEL]: chunks().length - open().length } : {},
    }],
    error: null,
  });
  // The claim (20261121, simplified): unleased passages without a vector, leased for this slice.
  admin.state.rpc.embed_claim_batch = (a) => {
    const lease = new Date(Date.now() + Number(a.p_lease_seconds) * 1000).toISOString();
    const picked = open().filter((c) => !c.embed_claimed_until || Date.parse(String(c.embed_claimed_until)) < Date.now())
      .slice(0, Number(a.p_limit));
    for (const c of picked) c.embed_claimed_until = lease;
    return { data: picked.map((c) => ({ ...c, document_name: "EP-5-6-2 Pipe supports" })), error: null };
  };
  installMarkerRpc(admin.state);
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    calls.n++;
    const body = JSON.parse(String(init.body)) as { input: string[] };
    const payload = {
      data: body.input.map((_t, index) => ({ index, embedding: Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0.01) })),
      usage: { total_tokens: body.input.length * 10 },
    };
    return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) };
  }));
});
afterEach(() => { vi.unstubAllGlobals(); });

const build = async (over: Row = {}) => {
  const res = await POST(new NextRequest("http://test/api/knowledge/embed", {
    method: "POST", headers: { authorization: "Bearer tok" }, body: JSON.stringify({ orgId: ORG, libraryId: LIB, ...over }),
  }));
  return { status: res.status, body: await res.json() as Row };
};
const embedRows = () => meter.rows.filter((r) => r.op === "knowledgeEmbed");

describe("GOV-13 (I-18) — /api/knowledge/embed reserves every batch before it is sent, and meters as it goes", () => {
  it("REGRESSION — a member under the cap: every passage embedded, the answer as before, and ONE knowledgeEmbed row with the request's tokens", async () => {
    const { status, body } = await build();
    expect(status).toBe(200);
    expect(body).toMatchObject({ embedded: PASSAGES, remaining: 0, done: true, error: null });
    const tokens = PASSAGES * 10;
    expect(body.spentThisRun).toBe(estimateCostUsd(MODEL, { inputTokens: tokens, outputTokens: 0 }));
    expect(meter.asked.length).toBeGreaterThan(0);
    expect(meter.asked.every((a) => a.refused === null)).toBe(true);
    expect(embedRows()).toEqual([expect.objectContaining({
      orgId: ORG, userId: ME, provider: "voyage", model: MODEL, reserved: false, ok: true, inputTokens: tokens, outputTokens: 0,
      costUsd: estimateCostUsd(MODEL, { inputTokens: tokens, outputTokens: 0 }),
    })]);
    expect(meter.recorded).toEqual([]);
  });

  it("a batch whose worst case no longer fits is sent nowhere: no provider call, the passages back in the queue untouched, the refusal as the answer's error", async () => {
    meter.spent = 10 - 1e-6;                             // under the cap: the route's first check passes
    const { status, body } = await build();
    expect(status).toBe(200);
    expect(calls.n).toBe(0);
    expect(body).toMatchObject({ embedded: 0, done: false });
    expect(String(body.error)).toMatch(/^This call could cost up to \$\d+\.\d\d and \$0\.00 is left of your \$10\.00 monthly AI cap, so it was not made\.$/);
    const chunks = admin.state.tables.knowledge_chunks;
    expect(chunks.every((c) => c.embedding == null && c.embed_claimed_until == null && Number(c.embed_attempts) === 0)).toBe(true);
    expect(meter.rows).toEqual([]);
  });

  it("I-18 fix pass 3: each later batch's figures are written into the request's row BEFORE its reservation is given back, and only once the write landed", async () => {
    // was: release:ev-2 then settle:ev-1 — between the two statements the
    // batch's spend was on no row of the ledger
    const { body } = await build({ batch: 5 });             // 12 passages: batches of 5, 5 and 2
    expect(body).toMatchObject({ embedded: PASSAGES, done: true, error: null });
    expect(meter.log).toEqual([
      "reserve:ev-1", "settle:ev-1",
      "reserve:ev-2", "settle:ev-1", "release:ev-2",
      "reserve:ev-3", "settle:ev-1", "release:ev-3",
      "settle:ev-1",                                          // the request's own, at the end
    ]);
    expect(embedRows()).toEqual([expect.objectContaining({ id: "ev-1", reserved: false, inputTokens: PASSAGES * 10 })]);
  });

  it("a member AT the cap is refused by the first check, as before (402) — nothing reserved, no provider call", async () => {
    meter.spent = 10;
    const { status, body } = await build();
    expect(status).toBe(402);
    expect(String(body.error)).toMatch(/^Monthly AI budget reached — \$10\.00 of \$10\.00\./);
    expect(calls.n).toBe(0);
    expect(meter.asked).toEqual([]);
  });
});
