// intelligence Round G, I-20 — /api/knowledge/embed, the payer's side.
//
//   GOV-14 done-when 3 — a background consent records the request that
//     stamped it. A build pass that stamps the caller as the payer where they
//     were not, and "keep current" switched on, write one
//     EMBED_BUILD_CONSENT_RECORDED row naming the request (its id, address
//     and client) and the stamp's own instant. A pass that only renews the
//     caller's consent writes nothing new. A consent whose row cannot be
//     written is put back as it was: the drain never spends on a consent no
//     audit row explains.
//   GOV-14 done-when 4 / SEM-1 done-when 2 — `key-overview`: every
//     background build on the CALLER's key across the workspace (the list AI
//     settings shows, each with a Stop), and with `models` each library's
//     vectors per embedding model (what the switch confirm names). It names
//     no library the caller does not already read, writes nothing and spends
//     nothing.
//
// REGRESSION: a build pass answers exactly as before (its response carries
// no new field when the consent is audited), status / release / reset are
// untouched, and a request without a library is still refused unless it is
// the overview.

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

import { AGREEMENT_VERSION } from "@/lib/ai/pricing";
import { EMBEDDING_PROVIDERS } from "@/lib/ai/embeddings";

const ORG = "0a000000-0000-4000-8000-000000000001";
const LIB = "0b000000-0000-4000-8000-000000000001";
const LIB2 = "0b000000-0000-4000-8000-000000000002";
const LIB3 = "0b000000-0000-4000-8000-000000000003";
const ME = "0d000000-0000-4000-8000-00000000000a";
const OTHER = "0d000000-0000-4000-8000-0000000000bb";
// Model names come from the catalogue, never spelled out here.
const VOYAGE = EMBEDDING_PROVIDERS.find((p) => p.id === "voyage")!.models;
const OPENAI = EMBEDDING_PROVIDERS.find((p) => p.id === "openai")!.models;

/** A library with passages left to embed, all of them waiting out a refusal —
 *  so a build pass stamps its consent, embeds nothing, and leaves the stamp. */
let detail: Row;
beforeEach(() => {
  admin.state ??= freshAdminState();
  Object.assign(admin.state, freshAdminState());
  admin.state.user = { id: ME };
  principal.isController = true;
  principal.present = true;
  detail = { total: 10, embedded: 9, remaining: 1, failed: 0, leased: 0, waiting: 1, remaining_chars: 10, total_chars: 100, models: { [VOYAGE[0]]: 9 } };
  admin.state.rpc.semantic_coverage = () => ({ data: [{ total: 10, embedded: 9 }], error: null });
  admin.state.rpc.semantic_coverage_detail = () => ({ data: [detail], error: null });
  admin.state.rpc.embed_claim_batch = () => ({ data: [], error: null });
  admin.state.tables.knowledge_libraries = [{ id: LIB, org_id: ORG, name: "Standards", ai_features: {} }];
  admin.state.tables.ai_connections = [{ org_id: ORG, user_id: ME, provider: "anthropic", api_key: "k", embedding_provider: "voyage", embedding_model: VOYAGE[0], embedding_api_key: "pa" }];
  admin.state.tables.ai_key_agreements = [{ org_id: ORG, user_id: ME, scope: "use", agreement_version: AGREEMENT_VERSION }];
  admin.state.tables.audit_logs = [];
  installMarkerRpc(admin.state);
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("no provider call expected"); }));
});
afterEach(() => { vi.unstubAllGlobals(); });

function req(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return new NextRequest("http://test/api/knowledge/embed", {
    method: "POST",
    headers: { authorization: "Bearer tok", ...headers },
    body: JSON.stringify({ orgId: ORG, libraryId: LIB, ...body }),
  });
}
const marker = () => (admin.state.tables.knowledge_libraries[0].ai_features as { embedBuild?: Row }).embedBuild;
const consentRows = () => (admin.state.tables.audit_logs ?? []).filter((r) => r.action === "EMBED_BUILD_CONSENT_RECORDED");
const REQUEST_HEADERS = { "x-vercel-id": "iad1::abc-123", "x-forwarded-for": "203.0.113.7, 10.0.0.1", "user-agent": "Mozilla/5.0 test" };

describe("GOV-14 done-when 3 — a recorded background consent names the request that stamped it", () => {
  it("reproduction → fix: the first build pass stamps the caller and writes ONE audit row naming the request and the stamp's instant", async () => {
    const { POST } = await import("@/app/api/knowledge/embed/route");
    const res = await POST(req({}, REQUEST_HEADERS));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.error).toBeNull();
    expect(body.backgroundNote).toBeUndefined();
    expect(marker()).toMatchObject({ userId: ME });
    const rows = consentRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      resource_type: "knowledge_library", resource_id: LIB, org_id: ORG, user_id: ME,
      details: {
        libraryId: LIB, stampedAt: marker()!.at, standing: false, replaced: null,
        request: { route: "/api/knowledge/embed", action: "build", requestId: "iad1::abc-123", ip: "203.0.113.7", userAgent: "Mozilla/5.0 test" },
      },
    });
  });

  it("a pass that only renews the caller's own consent writes nothing new (the build loop calls the route once per batch)", async () => {
    const { POST } = await import("@/app/api/knowledge/embed/route");
    await POST(req({}, REQUEST_HEADERS));
    await POST(req({}, REQUEST_HEADERS));
    await POST(req({}, REQUEST_HEADERS));
    expect(consentRows()).toHaveLength(1);
    expect(marker()).toMatchObject({ userId: ME });
  });

  it("a request with no request id of its own still gets one (generated), never a blank", async () => {
    const { POST } = await import("@/app/api/knowledge/embed/route");
    await POST(req({}));
    const request = (consentRows()[0].details as { request: Row }).request;
    expect(String(request.requestId)).toMatch(/^[0-9a-f-]{36}$/);
    expect(request.ip).toBeNull();
  });

  it("replacing another member's plain build names whose consent it replaced", async () => {
    admin.state.tables.knowledge_libraries[0].ai_features = { embedBuild: { userId: OTHER, at: "2026-09-01T00:00:00Z" } };
    const { POST } = await import("@/app/api/knowledge/embed/route");
    await POST(req({}, REQUEST_HEADERS));
    expect(marker()).toMatchObject({ userId: ME });
    expect((consentRows()[0].details as Row).replaced).toEqual({ userId: OTHER, standing: false });
  });

  it("another member's standing consent stands (a plain build never replaces it): nothing of the caller's was recorded, so no row", async () => {
    admin.state.tables.knowledge_libraries[0].ai_features = { embedBuild: { userId: OTHER, at: "2026-09-01T00:00:00Z", standing: true } };
    const { POST } = await import("@/app/api/knowledge/embed/route");
    const body = await (await POST(req({}, REQUEST_HEADERS))).json();
    expect(body.backgroundNote).toBeUndefined();
    expect(marker()).toMatchObject({ userId: OTHER, standing: true });
    expect(consentRows()).toHaveLength(0);
  });

  it("keep current switched on writes a row with standing: true — and turning it on again over a standing consent writes nothing new", async () => {
    const { POST } = await import("@/app/api/knowledge/embed/route");
    expect((await (await POST(req({ action: "keep-current", on: true }, REQUEST_HEADERS))).json()).standing).toBe(true);
    expect(consentRows()).toHaveLength(1);
    expect(consentRows()[0].details).toMatchObject({ standing: true, stampedAt: marker()!.at, request: { action: "keep-current", requestId: "iad1::abc-123" } });
    expect((await (await POST(req({ action: "keep-current", on: true }, REQUEST_HEADERS))).json()).standing).toBe(true);
    expect(consentRows()).toHaveLength(1);
  });

  it("keep current over the caller's own plain build is a new consent (standing), audited", async () => {
    const { POST } = await import("@/app/api/knowledge/embed/route");
    await POST(req({}, REQUEST_HEADERS));
    await POST(req({ action: "keep-current", on: true }, REQUEST_HEADERS));
    expect(consentRows().map((r) => (r.details as Row).standing)).toEqual([false, true]);
  });

  it("a build pass whose audit row cannot be written withdraws the consent it recorded and says so — the build in this tab goes on", async () => {
    admin.state.failWrites.audit_logs = { code: "42501", message: "permission denied for table audit_logs" };
    const { POST } = await import("@/app/api/knowledge/embed/route");
    const res = await POST(req({}, REQUEST_HEADERS));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.error).toBeNull();
    expect(body.backgroundNote).toMatch(/The background continuation could not be recorded \(its audit row could not be written \(permission denied for table audit_logs\)\) — keep this page open/);
    expect(marker()).toBeUndefined();
    // the drain has nothing to spend on
    const { drainEmbedBacklog } = await import("@/lib/knowledgeEmbedDrain");
    admin.state.tables.org_members = [{ org_id: ORG, uid: ME, status: "active" }];
    expect((await drainEmbedBacklog({ scopeOrgIds: null, budgetMs: 200_000 })).drained).toEqual([]);
  });

  it("…and a pass that replaced another member's plain build leaves no consent of the caller's (nothing pays without a row)", async () => {
    admin.state.tables.knowledge_libraries[0].ai_features = { embedBuild: { userId: OTHER, at: "2026-09-01T00:00:00Z" } };
    admin.state.failWrites.audit_logs = { message: "audit down" };
    const { POST } = await import("@/app/api/knowledge/embed/route");
    await POST(req({}));
    expect(marker()).toBeUndefined();
  });

  it("keep current whose audit row cannot be written is refused (500) and the caller's plain consent is put back as it was", async () => {
    const { POST } = await import("@/app/api/knowledge/embed/route");
    await POST(req({}));                                  // the caller's plain build, audited
    expect(marker()).toMatchObject({ userId: ME });
    expect(marker()!.standing).toBeUndefined();
    admin.state.failWrites.audit_logs = { message: "audit down" };
    const res = await POST(req({ action: "keep-current", on: true }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toMatchObject({ standing: null });
    expect(body.error).toMatch(/The standing consent was not kept: its audit row could not be written \(audit down\)\./);
    expect(marker()).toMatchObject({ userId: ME });
    expect(marker()!.standing).toBeUndefined();
  });

  it("keep current with no consent before, unaudited, leaves no consent at all", async () => {
    admin.state.failWrites.audit_logs = { message: "audit down" };
    const { POST } = await import("@/app/api/knowledge/embed/route");
    expect((await POST(req({ action: "keep-current", on: true }))).status).toBe(500);
    expect(marker()).toBeUndefined();
  });

  it("REGRESSION: status, release and reset write no consent row", async () => {
    admin.state.tables.knowledge_libraries[0].ai_features = { embedBuild: { userId: ME, at: "2026-09-01T00:00:00Z" } };
    const { POST } = await import("@/app/api/knowledge/embed/route");
    await POST(req({ action: "status" }));
    await POST(req({ action: "release" }));
    await POST(req({ action: "reset" }));
    expect(consentRows()).toHaveLength(0);
  });
});

describe("GOV-14 done-when 4 / SEM-1 — key-overview: the builds on MY key, and each library's vectors per model", () => {
  const overview = (body: Record<string, unknown> = {}) => new NextRequest("http://test/api/knowledge/embed", {
    method: "POST",
    headers: { authorization: "Bearer tok" },
    body: JSON.stringify({ orgId: ORG, action: "key-overview", ...body }),
  });
  beforeEach(() => {
    admin.state.tables.knowledge_libraries = [
      { id: LIB, org_id: ORG, name: "Standards", ai_features: { embedBuild: { userId: ME, at: "2026-09-01T00:00:00Z", lastDrainAt: "2026-09-02T00:00:00Z" } } },
      { id: LIB2, org_id: ORG, name: "P&IDs", ai_features: { visionAllPages: true, embedBuild: { userId: ME, at: "2026-09-03T00:00:00Z", standing: true, blockedUntil: "2026-10-01T00:00:00Z", blockedReason: "cap" } } },
      { id: LIB3, org_id: ORG, name: "Vendor manuals", ai_features: { embedBuild: { userId: OTHER, at: "2026-09-04T00:00:00Z" } } },
      { id: "0b000000-0000-4000-8000-000000000004", org_id: ORG, name: "Forged", ai_features: { embedBuild: { userId: "not-a-uuid", at: "x" } } },
      { id: "0b000000-0000-4000-8000-000000000099", org_id: "0a000000-0000-4000-8000-000000000099", name: "Another org", ai_features: { embedBuild: { userId: ME, at: "2026-09-05T00:00:00Z" } } },
    ];
  });

  it("lists every build on the caller's key in this workspace — never another member's, a forged marker, or another org's library — and writes nothing", async () => {
    const { POST } = await import("@/app/api/knowledge/embed/route");
    const res = await POST(overview());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.indexes).toBeUndefined();
    expect(body.builds).toEqual([
      { libraryId: LIB, libraryName: "Standards", standing: false, startedAt: "2026-09-01T00:00:00Z", lastDrainAt: "2026-09-02T00:00:00Z", blockedUntil: null, blockedReason: null, lastError: null, completedAt: null },
      { libraryId: LIB2, libraryName: "P&IDs", standing: true, startedAt: "2026-09-03T00:00:00Z", lastDrainAt: null, blockedUntil: "2026-10-01T00:00:00Z", blockedReason: "cap", lastError: null, completedAt: null },
    ]);
    expect(admin.state.calls.some((c) => ["update", "insert", "delete"].includes(c.method) || c.table === "rpc:embed_build_marker_write")).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("with models: each library's vectors per model; a library whose read fails is null (unknown), never 'no vectors'", async () => {
    admin.state.rpc.semantic_coverage_detail = (a) => {
      if (a.p_library_id === LIB) return { data: [{ ...detail, models: { [VOYAGE[0]]: 9 } }], error: null };
      if (a.p_library_id === LIB2) return { data: [{ ...detail, models: { [OPENAI[0]]: 4 } }], error: null };
      if (a.p_library_id === LIB3) return { data: [{ ...detail, models: {} }], error: null };
      return { data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } };
    };
    const { POST } = await import("@/app/api/knowledge/embed/route");
    const body = await (await POST(overview({ models: true }))).json();
    expect(body.builds).toHaveLength(2);
    expect(body.indexes).toEqual([
      { libraryId: LIB, libraryName: "Standards", models: { [VOYAGE[0]]: 9 } },
      { libraryId: LIB2, libraryName: "P&IDs", models: { [OPENAI[0]]: 4 } },
      { libraryId: LIB3, libraryName: "Vendor manuals", models: {} },
      { libraryId: "0b000000-0000-4000-8000-000000000004", libraryName: "Forged", models: null },
    ]);
  });

  it("a libraries read that fails is a 500 that says so — never an empty list ('nothing running')", async () => {
    admin.state.failReads.knowledge_libraries = { message: "connection reset" };
    const { POST } = await import("@/app/api/knowledge/embed/route");
    const res = await POST(overview());
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/Couldn't read this workspace's libraries, so the background builds on your key can't be listed: connection reset/);
  });

  it("a non-member is refused; any member (not only a controller) may read their own key's builds", async () => {
    principal.present = false;
    const { POST } = await import("@/app/api/knowledge/embed/route");
    expect((await POST(overview())).status).toBe(403);
    principal.present = true;
    principal.isController = false;
    expect((await POST(overview())).status).toBe(200);
  });

  it("REGRESSION: any other action without a library is still refused (400)", async () => {
    const { POST } = await import("@/app/api/knowledge/embed/route");
    const res = await POST(new NextRequest("http://test/api/knowledge/embed", {
      method: "POST", headers: { authorization: "Bearer tok" }, body: JSON.stringify({ orgId: ORG, action: "status" }),
    }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("orgId and libraryId are required");
  });
});
