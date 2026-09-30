// The bug this test exists for: /api/knowledge/embed's status action
// returned a shape MISSING coveredNow — the one field the panel renders —
// so the meaning-index bar showed 0% forever while the database sat at
// 100%. The status response must mirror SemanticProgress exactly.
//
// intelligence Round G (I-02) extends it: the status carries what the panel
// now says out loud — refused passages with where they are (SEM-4), passages
// another run holds (SEM-7), vectors per model and a mixed index (SEM-1), the
// caller's model conflict (SEM-3), the ledger's own price for the caller's
// model (SEM-13) and the background build's state (SEM-11); and the build
// refuses, before spending anything, to mix a second model into a library,
// to run for someone who has not accepted the agreement, or for a library of
// another org.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { freshAdminState, type Row } from "./helpers/knowledgeFakeAdmin";

const admin = vi.hoisted(() => ({ state: null as unknown as import("./helpers/knowledgeFakeAdmin").FakeAdminState }));
vi.mock("@/lib/supabaseAdmin", async () => {
  const { makeFakeAdmin: make, freshAdminState: fresh } = await import("./helpers/knowledgeFakeAdmin");
  admin.state ??= fresh();
  const proxy = new Proxy({}, { get: (_t, p: string) => (make(admin.state) as Record<string, unknown>)[p] });
  return { supabaseAdmin: proxy };
});
const principal = vi.hoisted(() => ({ isController: true as boolean, present: true as boolean }));
vi.mock("@/lib/knowledgeAccess", () => ({
  loadPrincipal: vi.fn(async () => (principal.present ? { isController: principal.isController } : null)),
}));
vi.mock("@/lib/ai/usageServer", () => ({
  getMonthUsage: vi.fn(async () => ({ spentUsd: 0 })),
  getCapUsd: vi.fn(async () => 0),
  recordAskUsage: vi.fn(async () => undefined),
}));
vi.mock("@/lib/ai/keyVault", () => ({ openAiKey: (v: unknown) => v }));

import { estimateEmbeddingCostUsd } from "@/lib/ai/embeddings";

const ORG = "0a000000-0000-4000-8000-000000000001";
const LIB = "0b000000-0000-4000-8000-000000000001";
const ME = "0d000000-0000-4000-8000-00000000000a";

let coverage: { total: number; embedded: number } = { total: 34, embedded: 34 };
let detail: Row | null = null;

beforeEach(() => {
  // The route is imported lazily below, so the mock factory may not have run.
  admin.state ??= freshAdminState();
  Object.assign(admin.state, freshAdminState());
  admin.state.user = { id: ME };
  principal.isController = true;
  principal.present = true;
  coverage = { total: 34, embedded: 34 };
  detail = null;
  admin.state.rpc.semantic_coverage = () => ({ data: [coverage], error: null });
  admin.state.rpc.semantic_coverage_detail = () => (detail ? { data: [detail], error: null } : { data: null, error: { code: "PGRST202", message: "Could not find the function" } });
  admin.state.tables.knowledge_libraries = [{ id: LIB, org_id: ORG, ai_features: {} }];
  admin.state.tables.ai_connections = [{ org_id: ORG, user_id: ME, provider: "anthropic", api_key: "k", embedding_provider: "voyage", embedding_model: "voyage-3.5-lite", embedding_api_key: "pa" }];
  admin.state.tables.ai_key_agreements = [{ org_id: ORG, user_id: ME, scope: "use", agreement_version: "2026-07-v2" }];
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("no provider call expected"); }));
});
afterEach(() => { vi.unstubAllGlobals(); });

function req(body: Record<string, unknown>) {
  return new NextRequest("http://test/api/knowledge/embed", {
    method: "POST",
    headers: { authorization: "Bearer tok" },
    body: JSON.stringify({ orgId: ORG, libraryId: LIB, ...body }),
  });
}
const statusReq = () => req({ action: "status" });

describe("embed status response mirrors SemanticProgress", () => {
  it("carries coveredNow — the field the panel actually renders", async () => {
    const { POST } = await import("@/app/api/knowledge/embed/route");
    const res = await POST(statusReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      embedded: 0,
      total: 34,
      coveredNow: 34,
      remaining: 0,
      done: true,
      error: null,
      spentThisRun: 0,
    });
  });

  it("reports partial coverage faithfully", async () => {
    coverage = { total: 34, embedded: 12 };
    const { POST } = await import("@/app/api/knowledge/embed/route");
    const body = await (await POST(statusReq())).json();
    expect(body.coveredNow).toBe(12);
    expect(body.remaining).toBe(22);
    expect(body.done).toBe(false);
  });

  it("a status read spends nothing and never touches a provider", async () => {
    const { POST } = await import("@/app/api/knowledge/embed/route");
    await POST(statusReq());
    expect(fetch).not.toHaveBeenCalled();
    expect(admin.state.calls.some((c) => ["update", "insert", "delete"].includes(c.method))).toBe(false);
  });
});

describe("Round G — what the status says out loud", () => {
  const withDetail = (over: Row = {}) => {
    detail = { total: 40, embedded: 30, remaining: 8, failed: 2, leased: 0, remaining_chars: 12_000, total_chars: 60_000, models: { "voyage-3.5-lite": 30 }, ...over };
    coverage = { total: 40, embedded: 30 };
    admin.state.tables.knowledge_chunks = [
      { id: "f1", org_id: ORG, library_id: LIB, page: 7, embedding: null, embed_attempts: 3, embed_error: "input exceeds the model's context", knowledge_documents: { name: "EP-5-6-2.pdf" } },
    ];
  };
  it("SEM-4: refused passages are counted apart from remaining (they never hold the library below done) and listed with document and page", async () => {
    withDetail({ remaining: 0 });
    const { POST } = await import("@/app/api/knowledge/embed/route");
    const body = await (await POST(statusReq())).json();
    expect(body).toMatchObject({ remaining: 0, done: true, failed: 2 });
    expect(body.failedSamples).toEqual([{ documentName: "EP-5-6-2.pdf", page: 7, error: "input exceeds the model's context" }]);
  });
  it("SEM-13: the estimate is the ledger's own function over the library's real text, for the caller's model; Voyage is marked an estimate", async () => {
    withDetail();
    const { POST } = await import("@/app/api/knowledge/embed/route");
    const body = await (await POST(statusReq())).json();
    expect(body.estimate).toEqual({
      model: "voyage-3.5-lite",
      remainingUsd: estimateEmbeddingCostUsd("voyage-3.5-lite", 12_000, 8),
      fullUsd: estimateEmbeddingCostUsd("voyage-3.5-lite", 60_000, 40),
      placeholderRate: true,
    });
    expect(body.connection).toEqual({ provider: "voyage", model: "voyage-3.5-lite" });
    expect(JSON.stringify(body)).not.toContain("\"pa\"");          // the key never leaves the server
  });
  it("SEM-1 / SEM-3: a mixed index says so; a caller whose model differs is told why Build would mix spaces", async () => {
    withDetail({ models: { "voyage-3.5-lite": 20, "voyage-3.5": 10 } });
    const { POST } = await import("@/app/api/knowledge/embed/route");
    const mixed = await (await POST(statusReq())).json();
    expect(mixed.mixed).toBe(true);
    expect(mixed.conflict).toMatch(/already mixes voyage-3.5-lite and voyage-3.5/);
    withDetail({ models: { "text-embedding-3-small": 30 } });
    const conflict = await (await POST(statusReq())).json();
    expect(conflict.mixed).toBe(false);
    expect(conflict.conflict).toMatch(/was built with text-embedding-3-small; your embeddings setting is voyage-3.5-lite/);
  });
  it("SEM-11: the background build's state — whose key, when it last ran, why it waits", async () => {
    withDetail();
    admin.state.tables.knowledge_libraries[0].ai_features = {
      embedBuild: { userId: ME, at: "2026-09-01T00:00:00Z", standing: true, lastDrainAt: "2026-09-29T00:00:00Z", blockedUntil: "2026-10-01T00:00:00.000Z", blockedReason: "cap", lastError: "monthly cap reached" },
    };
    const { POST } = await import("@/app/api/knowledge/embed/route");
    const body = await (await POST(statusReq())).json();
    expect(body.background).toEqual({
      mine: true, standing: true, startedAt: "2026-09-01T00:00:00Z", lastDrainAt: "2026-09-29T00:00:00Z",
      blockedUntil: "2026-10-01T00:00:00.000Z", blockedReason: "cap", lastError: "monthly cap reached",
    });
  });
  it("SEM-8: adding chunks to a completed library produces a visible not-covered state", async () => {
    withDetail({ remaining: 0, failed: 0 });
    coverage = { total: 30, embedded: 30 };
    const { POST } = await import("@/app/api/knowledge/embed/route");
    expect((await (await POST(statusReq())).json()).done).toBe(true);
    // ingestion adds 12 passages
    coverage = { total: 42, embedded: 30 };
    detail = { ...detail!, total: 42, remaining: 12 };
    const after = await (await POST(statusReq())).json();
    expect(after).toMatchObject({ done: false, remaining: 12, coveredNow: 30, total: 42 });
    const { meaningIndexDrift } = await import("@/lib/knowledge");
    expect(meaningIndexDrift(after)).toBe("Meaning search covers 71% of this library — 12 passages added since the last build are found by keyword only.");
  });
});

describe("Round G — the build refuses before spending anything", () => {
  it("a library of another org is 404 (every write below is keyed by its id)", async () => {
    admin.state.tables.knowledge_libraries = [{ id: LIB, org_id: "0a000000-0000-4000-8000-000000000099", ai_features: {} }];
    const { POST } = await import("@/app/api/knowledge/embed/route");
    expect((await POST(req({}))).status).toBe(404);
  });
  it("SEM-1 / SEM-3: a build whose model differs from the stamped vectors is 409 — no marker, no provider call", async () => {
    detail = { total: 10, embedded: 5, remaining: 5, failed: 0, leased: 0, remaining_chars: 100, total_chars: 200, models: { "text-embedding-3-small": 5 } };
    const { POST } = await import("@/app/api/knowledge/embed/route");
    const res = await POST(req({}));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toMatchObject({ conflict: true, stamped: ["text-embedding-3-small"], yours: "voyage-3.5-lite" });
    expect(body.error).toMatch(/Use Rebuild index to switch the whole library/);
    expect(fetch).not.toHaveBeenCalled();
    expect((admin.state.tables.knowledge_libraries[0].ai_features as Row).embedBuild).toBeUndefined();
  });
  it("an unsigned acceptable-use agreement is 428 with the text (local gate until the shared one lands)", async () => {
    admin.state.tables.ai_key_agreements = [];
    const { POST } = await import("@/app/api/knowledge/embed/route");
    const res = await POST(req({}));
    expect(res.status).toBe(428);
    const body = await res.json();
    expect(body.agreementRequired).toBe(true);
    expect(body.agreementText).toMatch(/NEVER enter/);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("non-controllers may read status but not build, retry, reset or keep current", async () => {
    principal.isController = false;
    const { POST } = await import("@/app/api/knowledge/embed/route");
    for (const action of [undefined, "reset", "retry-failed", "keep-current"]) {
      expect((await POST(req(action ? { action } : {}))).status).toBe(403);
    }
    expect((await POST(statusReq())).status).toBe(200);
  });
});

describe("Round G — the controls", () => {
  it("retry-failed requeues only passages refused EMBED_MAX_ATTEMPTS times", async () => {
    admin.state.tables.knowledge_chunks = [
      { id: "a", org_id: ORG, library_id: LIB, embedding: null, embed_attempts: 3, embed_error: "x" },
      { id: "b", org_id: ORG, library_id: LIB, embedding: null, embed_attempts: 1, embed_error: "y" },
    ];
    const { POST } = await import("@/app/api/knowledge/embed/route");
    const body = await (await POST(req({ action: "retry-failed" }))).json();
    expect(body.requeued).toBe(1);
    expect(admin.state.tables.knowledge_chunks[0]).toMatchObject({ embed_attempts: 0, embed_error: null });
    expect(admin.state.tables.knowledge_chunks[1]).toMatchObject({ embed_attempts: 1 });
  });
  it("keep-current on records the CALLER's standing consent; off withdraws it (and clears the stamp when nothing is left)", async () => {
    detail = { total: 3, embedded: 3, remaining: 0, failed: 0, leased: 0, remaining_chars: 0, total_chars: 10, models: { "voyage-3.5-lite": 3 } };
    const { POST } = await import("@/app/api/knowledge/embed/route");
    expect((await (await POST(req({ action: "keep-current", on: true }))).json()).standing).toBe(true);
    expect((admin.state.tables.knowledge_libraries[0].ai_features as { embedBuild: Row }).embedBuild).toMatchObject({ userId: ME, standing: true });
    expect((await (await POST(req({ action: "keep-current", on: false }))).json()).standing).toBe(false);
    expect((admin.state.tables.knowledge_libraries[0].ai_features as Row).embedBuild).toBeUndefined();
  });
  it("a plain build never replaces another member's standing consent; an explicit keep-current does", async () => {
    const OTHER = "0d000000-0000-4000-8000-0000000000bb";
    const { setEmbedBuildMarker } = await import("@/lib/knowledgeEmbedCore");
    admin.state.tables.knowledge_libraries[0].ai_features = { embedBuild: { userId: OTHER, at: "2026-09-01T00:00:00Z", standing: true } };
    expect(await setEmbedBuildMarker(LIB, ME)).toBeNull();
    expect((admin.state.tables.knowledge_libraries[0].ai_features as { embedBuild: Row }).embedBuild).toMatchObject({ userId: OTHER, standing: true });
    expect(await setEmbedBuildMarker(LIB, ME, { standing: true })).toBeNull();
    expect((admin.state.tables.knowledge_libraries[0].ai_features as { embedBuild: Row }).embedBuild).toMatchObject({ userId: ME, standing: true });
    // a non-standing prior consent is replaced by the new builder, as before
    admin.state.tables.knowledge_libraries[0].ai_features = { embedBuild: { userId: OTHER, at: "2026-09-01T00:00:00Z" } };
    await setEmbedBuildMarker(LIB, ME);
    expect((admin.state.tables.knowledge_libraries[0].ai_features as { embedBuild: Row }).embedBuild).toMatchObject({ userId: ME });
  });
  it("release: the payer or a controller may stop a background build; another member may not", async () => {
    admin.state.tables.knowledge_libraries[0].ai_features = { embedBuild: { userId: "0d000000-0000-4000-8000-0000000000bb", at: "2026-09-01T00:00:00Z" } };
    principal.isController = false;
    const { POST } = await import("@/app/api/knowledge/embed/route");
    expect((await POST(req({ action: "release" }))).status).toBe(403);
    principal.isController = true;
    expect((await (await POST(req({ action: "release" }))).json()).released).toBe(true);
    expect((admin.state.tables.knowledge_libraries[0].ai_features as Row).embedBuild).toBeUndefined();
  });
  it("reset clears vectors AND the refusal counters and leases (a rebuild starts clean)", async () => {
    admin.state.tables.knowledge_chunks = [{ id: "a", org_id: ORG, library_id: LIB, embedding: "[0]", embedding_model: "m", embed_attempts: 3, embed_error: "x", embed_claimed_until: "2099-01-01" }];
    const { POST } = await import("@/app/api/knowledge/embed/route");
    expect((await POST(req({ action: "reset" }))).status).toBe(200);
    expect(admin.state.tables.knowledge_chunks[0]).toMatchObject({ embedding: null, embedding_model: null, embed_attempts: 0, embed_error: null, embed_claimed_until: null });
  });
});
