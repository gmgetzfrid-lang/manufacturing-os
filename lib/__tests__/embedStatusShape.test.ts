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
// another org. The fix pass adds: refused passages' document names reach
// controllers only; a Rebuild ends another member's background consent
// first, so the drain never re-embeds a whole library on a key whose owner
// consented to something else; and saving Library AI setup never erases the
// standing consent that shares its JSON column. The second fix pass adds: a
// Rebuild reports backgroundCleared only when its conditional clear changed
// the row (a consent renewed in between is read again; one that keeps moving
// is a 409 with no vector touched); a failed coverage read is a transient
// 503, never "needs migration 20260930"; and passages the provider refused
// are reported as waiting — never as a background build embedding them.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { freshAdminState, installMarkerRpc, type Row } from "./helpers/knowledgeFakeAdmin";

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
// The browser client, for saveLibraryAiFeatures (lib/knowledge.ts).
const browser = vi.hoisted(() => ({ state: null as unknown as import("./helpers/knowledgeFakeAdmin").FakeAdminState }));
vi.mock("@/lib/supabase", async () => {
  const { makeFakeAdmin: make, freshAdminState: fresh } = await import("./helpers/knowledgeFakeAdmin");
  browser.state ??= fresh();
  const proxy = new Proxy({}, {
    get: (_t, p: string) => (p === "auth"
      ? { getSession: async () => ({ data: { session: { access_token: "tok" } } }) }
      : (make(browser.state) as Record<string, unknown>)[p]),
  });
  return { supabase: proxy };
});

import { estimateEmbeddingCostUsd } from "@/lib/ai/embeddings";
// The CURRENT agreement version (GOV-6 bumped it; a pinned literal would go stale).
import { AGREEMENT_VERSION } from "@/lib/ai/pricing";

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
  admin.state.tables.ai_key_agreements = [{ org_id: ORG, user_id: ME, scope: "use", agreement_version: AGREEMENT_VERSION }];
  installMarkerRpc(admin.state);            // 20261121 applied (one test below takes it away)
  browser.state ??= freshAdminState();
  Object.assign(browser.state, freshAdminState());
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
  it("SEM-13: the estimate is the ledger's own function over the library's real text, for the caller's model; a Voyage model the price table names is a real rate, not a placeholder", async () => {
    withDetail();
    const { POST } = await import("@/app/api/knowledge/embed/route");
    const body = await (await POST(statusReq())).json();
    expect(body.estimate).toEqual({
      model: "voyage-3.5-lite",
      remainingUsd: estimateEmbeddingCostUsd("voyage-3.5-lite", 12_000, 8),
      fullUsd: estimateEmbeddingCostUsd("voyage-3.5-lite", 60_000, 40),
      placeholderRate: false,
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
    expect(meaningIndexDrift(after)).toBe("Meaning search covers 71% of this library — 12 passages don't carry a meaning vector yet and are found by keyword only.");
  });
  it("refused passages' names go to controllers only — a non-controller gets the count, and the service-role name read never runs for them", async () => {
    withDetail({ remaining: 0 });
    principal.isController = false;
    const { POST } = await import("@/app/api/knowledge/embed/route");
    const body = await (await POST(statusReq())).json();
    expect(body.failed).toBe(2);
    expect(body.failedSamples).toEqual([]);
    expect(JSON.stringify(body)).not.toContain("EP-5-6-2");
    expect(admin.state.calls.some((c) => c.table === "knowledge_chunks" && c.method === "select" && String(c.args[0]).includes("knowledge_documents(name)"))).toBe(false);
    principal.isController = true;
    expect((await (await POST(statusReq())).json()).failedSamples).toHaveLength(1);
  });
});

describe("a failed coverage read is not a missing migration", () => {
  it("a statement timeout (or any other failure) is a transient 503 that never mentions a migration; only a missing function is the 424", async () => {
    const { POST } = await import("@/app/api/knowledge/embed/route");
    admin.state.rpc.semantic_coverage = () => ({ data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } });
    const busy = await POST(statusReq());
    expect(busy.status).toBe(503);
    const body = await busy.json();
    expect(body.error).toMatch(/Couldn't read the meaning index's coverage just now \(canceling statement due to statement timeout\)/);
    expect(body.error).not.toMatch(/migration/i);
    delete admin.state.rpc.semantic_coverage;                        // → PGRST202, the function is missing
    const missing = await POST(statusReq());
    expect(missing.status).toBe(424);
    expect((await missing.json()).error).toMatch(/needs migration 20260930/);
  });
});

describe("SEM-4 — refused passages wait; they are never 'being embedded'", () => {
  it("the status reports them as waiting (not busy), and a build that finds only them does not blame a stale schema cache", async () => {
    detail = { total: 10, embedded: 9, remaining: 1, failed: 0, leased: 0, waiting: 1, remaining_chars: 10, total_chars: 100, models: { "voyage-3.5-lite": 9 } };
    coverage = { total: 10, embedded: 9 };
    admin.state.rpc.embed_claim_batch = () => ({ data: [], error: null });
    const { POST } = await import("@/app/api/knowledge/embed/route");
    const status = await (await POST(statusReq())).json();
    expect(status).toMatchObject({ remaining: 1, busy: 0, waiting: 1, done: false });
    const build = await (await POST(req({}))).json();
    expect(build.error).toBeNull();
    expect(build).toMatchObject({ waiting: 1, busy: 0, remaining: 1, done: false });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("the browser build stops at once (no waiting on a build that is not running) and the panel says the passages were refused and will be retried", async () => {
    const replies = [{ embedded: 0, total: 10, coveredNow: 9, remaining: 1, done: false, error: null, spentThisRun: 0, busy: 0, waiting: 1, refused: 0 }];
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      calls.push(url);
      return { ok: true, status: 200, json: async () => replies[0] };
    }));
    const { buildSemanticIndex } = await import("@/lib/knowledge");
    const started = Date.now();
    const final = await buildSemanticIndex(ORG, LIB);
    expect(calls).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(final).toMatchObject({ waiting: 1, busy: 0 });
    const { readFileSync } = await import("node:fs");
    const panel = readFileSync("components/knowledge/SemanticIndexPanel.tsx", "utf8");
    expect(panel).toContain("} else if ((final.waiting ?? 0) > 0 && (final.busy ?? 0) + (final.waiting ?? 0) >= final.remaining) {");
    expect(panel).toContain("refused by the embeddings provider and will be retried ");
    // the "background build is embedding" line is reached only past it
    expect(panel.indexOf("(final.waiting ?? 0) > 0 && (final.busy ?? 0)")).toBeLessThan(panel.indexOf("The background build is embedding the remaining"));
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
  it("the claim hands out nothing because another model's vectors landed first: the build names the model conflict, not a stale schema cache", async () => {
    let n = 0;
    admin.state.rpc.semantic_coverage_detail = () => ({
      data: [{ total: 10, embedded: n++ === 0 ? 0 : 3, remaining: n === 1 ? 10 : 7, failed: 0, leased: 0, remaining_chars: 100, total_chars: 200,
        models: n === 1 ? {} : { "text-embedding-3-small": 3 } }],
      error: null,
    });
    admin.state.rpc.embed_claim_batch = () => ({ data: [], error: null });
    const { POST } = await import("@/app/api/knowledge/embed/route");
    const body = await (await POST(req({}))).json();
    expect(body.error).toMatch(/was built with text-embedding-3-small; your embeddings setting is voyage-3.5-lite/);
    expect(body.error).not.toMatch(/schema cache/);
    expect(fetch).not.toHaveBeenCalled();
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
  it("before 20261121 (no marker function) the marker writes fall back to the whole-blob write and still keep every toggle", async () => {
    delete admin.state.rpc.embed_build_marker_write;
    admin.state.tables.knowledge_libraries[0].ai_features = { decoder: "PID", embedBuild: { userId: ME, at: "2026-09-01T00:00:00Z" } };
    const { setEmbedBuildMarker, patchEmbedBuildMarker } = await import("@/lib/knowledgeEmbedCore");
    expect(await patchEmbedBuildMarker(LIB, { lastDrainAt: "2026-09-30T00:00:00Z" }, { userId: ME, at: "2026-09-01T00:00:00Z" })).toBeNull();
    expect(admin.state.tables.knowledge_libraries[0].ai_features).toEqual({ decoder: "PID", embedBuild: { userId: ME, at: "2026-09-01T00:00:00Z", lastDrainAt: "2026-09-30T00:00:00Z" } });
    // an expectation that no longer holds changes nothing
    expect(await setEmbedBuildMarker(LIB, null, { expect: { userId: ME, at: "1999-01-01T00:00:00Z" } })).toBeNull();
    expect((admin.state.tables.knowledge_libraries[0].ai_features as Row).embedBuild).toBeTruthy();
    expect(await setEmbedBuildMarker(LIB, null)).toBeNull();
    expect(admin.state.tables.knowledge_libraries[0].ai_features).toEqual({ decoder: "PID" });
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
  it("a Rebuild ends ANOTHER member's standing consent first — the drain then spends nothing on their key (SEM-8 / SEM-11)", async () => {
    const A = "0d000000-0000-4000-8000-0000000000bb";
    admin.state.tables.org_members = [{ org_id: ORG, uid: A, status: "active" }, { org_id: ORG, uid: ME, status: "active" }];
    admin.state.tables.ai_connections.push({ org_id: ORG, user_id: A, provider: "anthropic", api_key: "k", embedding_provider: "voyage", embedding_model: "voyage-3.5-lite", embedding_api_key: "pa-A" });
    admin.state.tables.ai_key_agreements.push({ org_id: ORG, user_id: A, scope: "use", agreement_version: AGREEMENT_VERSION });
    admin.state.tables.knowledge_libraries[0].ai_features = { visionAllPages: true, embedBuild: { userId: A, at: "2026-09-01T00:00:00Z", standing: true } };
    admin.state.tables.knowledge_chunks = Array.from({ length: 5 }, (_, i) => ({ id: `c${i}`, org_id: ORG, library_id: LIB, embedding: "[0]", embedding_model: "voyage-3.5-lite", embed_attempts: 0 }));
    const { POST } = await import("@/app/api/knowledge/embed/route");
    const res = await (await POST(req({ action: "reset" }))).json();
    expect(res.backgroundCleared).toBe(true);
    const feats = admin.state.tables.knowledge_libraries[0].ai_features as Row;
    expect(feats.embedBuild).toBeUndefined();
    expect(feats.visionAllPages).toBe(true);                               // the toggles are untouched
    // the next drain has nothing to continue on A's key
    const { drainEmbedBacklog } = await import("@/lib/knowledgeEmbedDrain");
    const out = await drainEmbedBacklog({ scopeOrgIds: null, budgetMs: 200_000 });
    expect(out.drained).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("a Rebuild keeps the CALLER's own consent (they pay for both), and ends another member's plain background build too", async () => {
    const { POST } = await import("@/app/api/knowledge/embed/route");
    admin.state.tables.knowledge_libraries[0].ai_features = { embedBuild: { userId: ME, at: "2026-09-01T00:00:00Z", standing: true } };
    expect((await (await POST(req({ action: "reset" }))).json()).backgroundCleared).toBe(false);
    expect((admin.state.tables.knowledge_libraries[0].ai_features as { embedBuild: Row }).embedBuild).toMatchObject({ userId: ME, standing: true });
    admin.state.tables.knowledge_libraries[0].ai_features = { embedBuild: { userId: "0d000000-0000-4000-8000-0000000000bb", at: "2026-09-01T00:00:00Z" } };
    expect((await (await POST(req({ action: "reset" }))).json()).backgroundCleared).toBe(true);
    expect((admin.state.tables.knowledge_libraries[0].ai_features as Row).embedBuild).toBeUndefined();
  });
  it("the panel's Rebuild dialog says so before it runs", async () => {
    const { readFileSync } = await import("node:fs");
    const panel = readFileSync("components/knowledge/SemanticIndexPanel.tsx", "utf8");
    expect(panel).toContain("const others = status?.background && !status.background.mine ? status.background : null;");
    expect(panel).toContain("It also ends another member's consent to keep this index current on their key");
    expect(panel).toContain("It also stops the background build running on another member's key");
  });
  it("reset clears vectors AND the refusal counters, leases and waits (a rebuild starts clean)", async () => {
    admin.state.tables.knowledge_chunks = [{ id: "a", org_id: ORG, library_id: LIB, embedding: "[0]", embedding_model: "m", embed_attempts: 3, embed_error: "x", embed_claimed_until: "2099-01-01", embed_retry_after: "2099-01-01" }];
    const { POST } = await import("@/app/api/knowledge/embed/route");
    expect((await POST(req({ action: "reset" }))).status).toBe(200);
    expect(admin.state.tables.knowledge_chunks[0]).toMatchObject({ embedding: null, embedding_model: null, embed_attempts: 0, embed_error: null, embed_claimed_until: null, embed_retry_after: null });
  });
  const OTHER = "0d000000-0000-4000-8000-0000000000bb";
  /** embed_build_marker_write, with the other member acting between the
   *  route's read and its clear: `moves` times, their consent is renewed (a
   *  new instant) just before the write is evaluated. */
  const renewBeforeClear = (moves: number) => {
    const real = admin.state.rpc.embed_build_marker_write;
    let n = 0;
    admin.state.rpc.embed_build_marker_write = (a) => {
      if (a.p_marker == null && !a.p_patch && n++ < moves) {
        (admin.state.tables.knowledge_libraries[0].ai_features as { embedBuild: Row }).embedBuild =
          { userId: OTHER, at: `2026-09-30T12:00:0${n}Z`, standing: true };
      }
      return real(a);
    };
  };
  it("reproduction: the marker writer said 'success' for a conditional clear that changed nothing — now the write reports it was not applied", async () => {
    admin.state.tables.knowledge_libraries[0].ai_features = { embedBuild: { userId: OTHER, at: "2026-09-30T12:00:05Z", standing: true } };
    const { setEmbedBuildMarker, clearEmbedBuildMarkerIf } = await import("@/lib/knowledgeEmbedCore");
    // the old signature: no error, so the caller took it as done
    expect(await setEmbedBuildMarker(LIB, null, { expect: { userId: OTHER, at: "2026-09-01T00:00:00Z" } })).toBeNull();
    expect((admin.state.tables.knowledge_libraries[0].ai_features as Row).embedBuild).toBeTruthy();
    // the checked clear says what happened
    expect(await clearEmbedBuildMarkerIf(LIB, { userId: OTHER, at: "2026-09-01T00:00:00Z" })).toEqual({ error: null, applied: false });
    expect(await clearEmbedBuildMarkerIf(LIB, { userId: OTHER, at: "2026-09-30T12:00:05Z" })).toEqual({ error: null, applied: true });
    expect((admin.state.tables.knowledge_libraries[0].ai_features as Row).embedBuild).toBeUndefined();
    // and before 20261121 (the whole-blob fallback) the same
    delete admin.state.rpc.embed_build_marker_write;
    admin.state.tables.knowledge_libraries[0].ai_features = { embedBuild: { userId: OTHER, at: "2026-09-30T12:00:05Z" } };
    expect(await clearEmbedBuildMarkerIf(LIB, { userId: OTHER, at: "2026-09-01T00:00:00Z" })).toEqual({ error: null, applied: false });
    expect(await clearEmbedBuildMarkerIf(LIB, { userId: OTHER, at: "2026-09-30T12:00:05Z" })).toEqual({ error: null, applied: true });
  });
  it("a Rebuild whose clear matched nothing (the other member renewed their consent in between) reads it again and clears THAT one — backgroundCleared only when a row changed", async () => {
    admin.state.tables.knowledge_libraries[0].ai_features = { embedBuild: { userId: OTHER, at: "2026-09-01T00:00:00Z", standing: true } };
    admin.state.tables.knowledge_chunks = [{ id: "a", org_id: ORG, library_id: LIB, embedding: "[0]", embedding_model: "m", embed_attempts: 0 }];
    renewBeforeClear(1);
    const { POST } = await import("@/app/api/knowledge/embed/route");
    const res = await POST(req({ action: "reset" }));
    expect(res.status).toBe(200);
    expect((await res.json()).backgroundCleared).toBe(true);
    expect((admin.state.tables.knowledge_libraries[0].ai_features as Row).embedBuild).toBeUndefined();
    const clears = admin.state.calls.filter((c) => c.table === "rpc:embed_build_marker_write").map((c) => (c.args[0] as Row).p_expect_at);
    expect(clears).toEqual(["2026-09-01T00:00:00Z", "2026-09-30T12:00:01Z"]);   // the renewed instant, read again
    expect(admin.state.tables.knowledge_chunks[0].embedding).toBeNull();
  });
  it("a consent that keeps moving refuses the Rebuild (409) BEFORE any vector is cleared — their renewed consent is left exactly as they recorded it", async () => {
    admin.state.tables.knowledge_libraries[0].ai_features = { embedBuild: { userId: OTHER, at: "2026-09-01T00:00:00Z", standing: true } };
    admin.state.tables.knowledge_chunks = [{ id: "a", org_id: ORG, library_id: LIB, embedding: "[0]", embedding_model: "m", embed_attempts: 0 }];
    renewBeforeClear(5);
    const { POST } = await import("@/app/api/knowledge/embed/route");
    const res = await POST(req({ action: "reset" }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/changed while the rebuild was starting, so nothing was cleared/);
    expect(admin.state.tables.knowledge_chunks[0].embedding).toBe("[0]");
    expect((admin.state.tables.knowledge_libraries[0].ai_features as { embedBuild: Row }).embedBuild).toMatchObject({ userId: OTHER, standing: true });
  });
  it("a Rebuild that cannot read the marker refuses (500) before any vector is cleared", async () => {
    admin.state.tables.knowledge_chunks = [{ id: "a", org_id: ORG, library_id: LIB, embedding: "[0]", embedding_model: "m", embed_attempts: 0 }];
    const { POST } = await import("@/app/api/knowledge/embed/route");
    // the route's own library check reads knowledge_libraries once before the marker read
    const real = admin.state.failReads;
    let reads = 0;
    admin.state.failReads = new Proxy(real, {
      get: (t, p: string) => (p === "knowledge_libraries" && ++reads === 2 ? { message: "timeout" } : (t as Record<string, unknown>)[p]),
    });
    const res = await POST(req({ action: "reset" }));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/Couldn't read the background build before the rebuild: timeout/);
    expect(admin.state.tables.knowledge_chunks[0].embedding).toBe("[0]");
  });
});

describe("review fix pass 3 — a consent write that did not land is never reported as done", () => {
  const OTHER = "0d000000-0000-4000-8000-0000000000bb";
  const feats = () => admin.state.tables.knowledge_libraries[0].ai_features as { embedBuild?: Row };
  /** Another member acts between the route's read and its write: before the
   *  first write matching `when`, their consent is recorded as `marker`. */
  let instant = 0;                                                  // every renewal a new instant
  const actFirst = (when: (a: Row) => boolean, marker: Row, times = 1) => {
    const real = admin.state.rpc.embed_build_marker_write;
    let n = 0;
    admin.state.rpc.embed_build_marker_write = (a) => {
      if (when(a) && n++ < times) feats().embedBuild = { ...marker, at: `2026-09-30T12:00:${String(++instant % 60).padStart(2, "0")}Z` };
      return real(a);
    };
  };
  beforeEach(() => { instant = 0; });
  const setsMe = (a: Row) => !a.p_patch && (a.p_marker as Row | null)?.userId === ME;

  it("a plain build that read NO marker never overwrites a standing consent recorded before its write lands", async () => {
    feats().embedBuild = undefined;
    actFirst(setsMe, { userId: OTHER, standing: true });
    const { setEmbedBuildMarker } = await import("@/lib/knowledgeEmbedCore");
    expect(await setEmbedBuildMarker(LIB, ME)).toBeNull();
    // their standing consent stands; the build is continued on it (the rule a plain build follows)
    expect(feats().embedBuild).toMatchObject({ userId: OTHER, standing: true });
    // the first write expected NO marker ('' — the SQL's COALESCE), and so changed nothing
    const writes = admin.state.calls.filter((c) => c.table === "rpc:embed_build_marker_write").map((c) => c.args[0] as Row);
    expect(writes[0]).toMatchObject({ p_expect_user: "", p_expect_at: null });
    expect(writes).toHaveLength(1);                                  // the re-read found a standing consent: nothing more to write
  });
  it("…a plain consent recorded in between is read again and replaced by the builder, conditionally on THAT one", async () => {
    feats().embedBuild = undefined;
    actFirst(setsMe, { userId: OTHER });
    const { setEmbedBuildMarker } = await import("@/lib/knowledgeEmbedCore");
    expect(await setEmbedBuildMarker(LIB, ME)).toBeNull();
    expect(feats().embedBuild).toMatchObject({ userId: ME });
    const writes = admin.state.calls.filter((c) => c.table === "rpc:embed_build_marker_write").map((c) => c.args[0] as Row);
    expect(writes.map((w) => w.p_expect_user)).toEqual(["", OTHER]);
    expect(writes[1].p_expect_at).toBe("2026-09-30T12:00:01Z");
  });
  it("…and a consent that keeps moving is said (the route then tells the builder to keep the page open)", async () => {
    feats().embedBuild = undefined;
    actFirst(setsMe, { userId: OTHER }, 5);
    const { setEmbedBuildMarker } = await import("@/lib/knowledgeEmbedCore");
    expect(await setEmbedBuildMarker(LIB, ME)).toMatch(/consent changed while this one was being recorded/);
    expect(feats().embedBuild).toMatchObject({ userId: OTHER });
  });
  it("the whole-blob fallback (before 20261121) applies the same test: expecting no marker, it writes nothing over one", async () => {
    delete admin.state.rpc.embed_build_marker_write;
    feats().embedBuild = { userId: OTHER, at: "2026-09-01T00:00:00Z", standing: true };
    const { clearEmbedBuildMarkerIf, NO_MARKER } = await import("@/lib/knowledgeEmbedCore");
    expect(await clearEmbedBuildMarkerIf(LIB, NO_MARKER)).toEqual({ error: null, applied: false });
    expect(feats().embedBuild).toMatchObject({ userId: OTHER });
  });
  it("reproduction → fix: 'Stop it' whose conditional clear matched nothing (the payer restarted the build in between) is a 409 — never 'Background build stopped'", async () => {
    feats().embedBuild = { userId: OTHER, at: "2026-09-01T00:00:00Z" };
    actFirst((a) => !a.p_patch && a.p_marker == null, { userId: OTHER });
    const { POST } = await import("@/app/api/knowledge/embed/route");
    const res = await POST(req({ action: "release" }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toMatchObject({ released: false, changed: true });
    expect(body.error).toMatch(/nothing was stopped/);
    expect(feats().embedBuild).toMatchObject({ userId: OTHER, at: "2026-09-30T12:00:01Z" });   // the new consent stands
    // and the panel's toast is driven by that refusal (apiPost throws on a non-2xx)
    const { readFileSync } = await import("node:fs");
    expect(readFileSync("lib/knowledge.ts", "utf8")).toContain("if (!res.ok || !data) {");
  });
  it("keep-current off whose conditional write matched nothing is a 409 — the renewed consent is left as recorded (both the patch and the clear)", async () => {
    const { POST } = await import("@/app/api/knowledge/embed/route");
    // passages left → the standing flag is patched off
    detail = { total: 3, embedded: 1, remaining: 2, failed: 0, leased: 0, waiting: 0, remaining_chars: 0, total_chars: 10, models: { "voyage-3.5-lite": 1 } };
    feats().embedBuild = { userId: ME, at: "2026-09-01T00:00:00Z", standing: true };
    actFirst((a) => a.p_patch === true, { userId: ME, standing: true });
    let res = await POST(req({ action: "keep-current", on: false }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ changed: true });
    expect(feats().embedBuild).toMatchObject({ userId: ME, standing: true });
    // nothing left → the stamp is cleared
    admin.state.rpc.embed_build_marker_write = undefined as never;
    installMarkerRpc(admin.state);
    detail = { total: 3, embedded: 3, remaining: 0, failed: 0, leased: 0, waiting: 0, remaining_chars: 0, total_chars: 10, models: { "voyage-3.5-lite": 3 } };
    actFirst((a) => !a.p_patch && a.p_marker == null, { userId: ME, standing: true });
    res = await POST(req({ action: "keep-current", on: false }));
    expect(res.status).toBe(409);
    expect(feats().embedBuild).toMatchObject({ userId: ME, standing: true });
    // unmoved, it withdraws as before
    admin.state.rpc.embed_build_marker_write = undefined as never;
    installMarkerRpc(admin.state);
    res = await POST(req({ action: "keep-current", on: false }));
    expect((await res.json()).standing).toBe(false);
    expect(feats().embedBuild).toBeUndefined();
  });
  it("reproduction → fix: another driver claims the tail between the build's first read and its claim — the build reports it busy, never 'run NOTIFY pgrst'", async () => {
    coverage = { total: 40, embedded: 10 };
    detail = { total: 40, embedded: 10, remaining: 30, failed: 0, leased: 0, waiting: 0, remaining_chars: 300, total_chars: 400, models: { "voyage-3.5-lite": 10 } };
    // the drain (a page-load nudge) takes all 30 just before this slice asks
    admin.state.rpc.embed_claim_batch = () => {
      detail = { ...(detail as Row), leased: 30 };
      return { data: [], error: null };
    };
    const { POST } = await import("@/app/api/knowledge/embed/route");
    const body = await (await POST(req({}))).json();
    expect(body.error).toBeNull();
    expect(body).toMatchObject({ busy: 30, remaining: 30, done: false });
    // a genuinely empty claim over passages nobody holds still names the stale cache
    detail = { total: 40, embedded: 10, remaining: 30, failed: 0, leased: 0, waiting: 0, remaining_chars: 300, total_chars: 400, models: { "voyage-3.5-lite": 10 } };
    admin.state.rpc.embed_claim_batch = () => ({ data: [], error: null });
    const stale = await (await POST(req({}))).json();
    expect(stale.error).toMatch(/30 passages lack vectors but none could be fetched/);
    expect(stale.error).toContain("NOTIFY pgrst");
  });
});

describe("review fix pass 4 — an unreadable consent is never reported stopped or withdrawn (DEC-59 (5))", () => {
  const OTHER = "0d000000-0000-4000-8000-0000000000bb";
  const feats = () => admin.state.tables.knowledge_libraries[0].ai_features as { embedBuild?: Row };
  /** The route's own library check reads knowledge_libraries first; the
   *  n-th read after it (the marker read) answers an error. */
  const failMarkerRead = (nth = 2) => {
    const real = admin.state.failReads;
    let reads = 0;
    admin.state.failReads = new Proxy(real, {
      get: (t, p: string) => (p === "knowledge_libraries" && ++reads === nth ? { message: "statement timeout" } : (t as Record<string, unknown>)[p]),
    });
  };
  const markerWrites = () => admin.state.calls.filter((c) => c.table === "rpc:embed_build_marker_write");

  it("reproduction → fix: 'Stop it' whose marker read FAILS is a 500 — never { released: false } — and the consent is untouched", async () => {
    feats().embedBuild = { userId: OTHER, at: "2026-09-01T00:00:00Z", standing: true };
    failMarkerRead();
    const { POST } = await import("@/app/api/knowledge/embed/route");
    const res = await POST(req({ action: "release" }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/Couldn't read the background build, so nothing was stopped: statement timeout/);
    expect(body).not.toHaveProperty("released");
    expect(markerWrites()).toHaveLength(0);
    expect(feats().embedBuild).toMatchObject({ userId: OTHER, standing: true });
  });
  it("reproduction → fix: keep-current OFF whose marker read FAILS is a 500 — never { standing: false } — and the consent is untouched", async () => {
    feats().embedBuild = { userId: ME, at: "2026-09-01T00:00:00Z", standing: true };
    failMarkerRead();
    const { POST } = await import("@/app/api/knowledge/embed/route");
    const res = await POST(req({ action: "keep-current", on: false }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/Couldn't read the standing consent, so nothing was withdrawn: statement timeout/);
    expect(body.standing).toBeNull();
    expect(markerWrites()).toHaveLength(0);
    expect(feats().embedBuild).toMatchObject({ userId: ME, standing: true });
  });
  it("a readable library with no marker still answers { released: false } / { standing: false } (nothing was running)", async () => {
    feats().embedBuild = undefined;
    const { POST } = await import("@/app/api/knowledge/embed/route");
    expect(await (await POST(req({ action: "release" }))).json()).toEqual({ released: false });
    expect(await (await POST(req({ action: "keep-current", on: false }))).json()).toEqual({ standing: false });
  });
  it("the panel's toast is the route's answer: { released: false } is never 'stopped'; a flag other than the one asked for is an error", async () => {
    const { releaseOutcome, keepCurrentOutcome, retryOutcome } = await import("@/lib/knowledge");
    expect(releaseOutcome({ released: true })).toEqual({ type: "success", title: "Background build stopped." });
    expect(releaseOutcome({ released: false })).toEqual({ type: "info", title: "No background build was running any more — nothing was stopped." });
    expect(releaseOutcome({} as { released?: boolean }).type).toBe("error");
    expect(keepCurrentOutcome({ standing: true }, true).type).toBe("success");
    expect(keepCurrentOutcome({ standing: false }, false)).toEqual({ type: "success", title: "No longer kept current in the background." });
    expect(keepCurrentOutcome({ standing: null }, false)).toEqual({ type: "error", title: "The standing consent was not withdrawn — it may still be spending; look at it again." });
    expect(keepCurrentOutcome({ standing: true }, false).type).toBe("error");
    expect(keepCurrentOutcome({ standing: false }, true).type).toBe("error");
    // the same for "Try them again": a requeue of none queued nothing
    expect(retryOutcome({ requeued: 3 })).toEqual({ type: "success", title: "Queued 3 refused passages for another try." });
    expect(retryOutcome({ requeued: 0 }).type).toBe("info");
    expect(retryOutcome({} as { requeued?: number }).type).toBe("error");
    const { readFileSync } = await import("node:fs");
    const panel = readFileSync("components/knowledge/SemanticIndexPanel.tsx", "utf8");
    const act = panel.slice(panel.indexOf("const act = async"), panel.indexOf("// A panel that renders NOTHING"));
    expect(act).toContain("showToast(outcome(out));");
    expect(act).not.toContain('type: "success"');
    expect(panel).toContain("void act(() => releaseBackgroundBuild(orgId, libraryId), releaseOutcome)");
    expect(panel).toContain("void act(() => setKeepIndexCurrent(orgId, libraryId, asked), (out) => keepCurrentOutcome(out, asked));");
    expect(panel).toContain("void act(() => retryFailedPassages(orgId, libraryId), retryOutcome)");
    expect(panel).not.toContain('"Background build stopped."');
  });
});

describe("SEM-8 — saving Library AI setup never erases the standing consent", () => {
  const LIBROW = () => ({ id: LIB, org_id: ORG, ai_features: { visionAllPages: false, decoder: "PID", embedBuild: { userId: ME, at: "2026-09-01T00:00:00Z", standing: true } } as Row });
  it("with 20261121: one RPC replaces the toggles and keeps embedBuild (transcribed from the SQL); a refused save is an error", async () => {
    browser.state.tables.knowledge_libraries = [LIBROW()];
    browser.state.rpc.knowledge_library_save_ai_features = (a) => {
      const lib = browser.state.tables.knowledge_libraries.find((l) => l.id === a.p_library_id);
      if (!lib) return { data: false, error: null };
      const cur = lib.ai_features as Row;
      const next: Row = { ...(a.p_features as Row) };
      delete next.embedBuild;
      lib.ai_features = "embedBuild" in cur ? { ...next, embedBuild: cur.embedBuild } : next;
      return { data: true, error: null };
    };
    const { saveLibraryAiFeatures } = await import("@/lib/knowledge");
    // the modal sends only its toggles — and a stray embedBuild is never taken from a caller
    await saveLibraryAiFeatures(LIB, { clarifyFacets: true, visionAllPages: true, embedBuild: { userId: "x" } } as never);
    expect(browser.state.tables.knowledge_libraries[0].ai_features).toEqual({
      clarifyFacets: true, visionAllPages: true, embedBuild: { userId: ME, at: "2026-09-01T00:00:00Z", standing: true },
    });
    const sent = browser.state.calls.find((c) => c.table === "rpc:knowledge_library_save_ai_features")!.args[0] as Row;
    expect(sent.p_features).toEqual({ clarifyFacets: true, visionAllPages: true });
    expect(browser.state.calls.some((c) => c.table === "knowledge_libraries" && c.method === "update")).toBe(false);
    browser.state.rpc.knowledge_library_save_ai_features = () => ({ data: false, error: null });
    await expect(saveLibraryAiFeatures(LIB, { clarifyFacets: false })).rejects.toThrow(/was not saved/);
  });
  it("before 20261121: the marker is read and carried over; a save that changed no row is an error", async () => {
    browser.state.tables.knowledge_libraries = [LIBROW()];
    const { saveLibraryAiFeatures } = await import("@/lib/knowledge");
    await saveLibraryAiFeatures(LIB, { visionAllPages: true });
    expect(browser.state.tables.knowledge_libraries[0].ai_features).toEqual({
      visionAllPages: true, embedBuild: { userId: ME, at: "2026-09-01T00:00:00Z", standing: true },
    });
    browser.state.tables.knowledge_libraries = [];
    await expect(saveLibraryAiFeatures(LIB, { visionAllPages: true })).rejects.toThrow(/was not saved/);
  });
  it("after a save the drain still finds the standing consent (the checkbox stays ticked)", async () => {
    browser.state.tables.knowledge_libraries = [LIBROW()];
    browser.state.rpc.knowledge_library_save_ai_features = (a) => {
      const lib = browser.state.tables.knowledge_libraries[0];
      lib.ai_features = { ...(a.p_features as Row), embedBuild: (lib.ai_features as Row).embedBuild };
      return { data: true, error: null };
    };
    const { saveLibraryAiFeatures } = await import("@/lib/knowledge");
    await saveLibraryAiFeatures(LIB, { visionAllPages: true });
    const { parseEmbedBuildMarker } = await import("@/lib/knowledgeEmbedCore");
    expect(parseEmbedBuildMarker((browser.state.tables.knowledge_libraries[0].ai_features as Row).embedBuild)).toMatchObject({ userId: ME, standing: true, valid: true });
  });
});
