// intelligence Round G, I-20 — /api/knowledge/embed, the payer's side.
//
//   GOV-14 done-when 3 — a background consent records the request that
//     stamped it. A build pass that stamps the caller as the payer where they
//     were not, and "keep current" switched on, write one
//     EMBED_BUILD_CONSENT_RECORDED row naming the request (an id generated
//     by the route, which it also logs; the platform id, marked unverified
//     off Vercel) and the instant of the stamp it recorded — never the
//     member's address or client string: audit_logs is read by every active
//     member, and an address is controller-only (DEC-46). A pass that renews
//     the caller's consent writes nothing new once a row names that payer on
//     that library; a renewal of a consent no row names (one stamped before
//     this deploy) writes its first row. A consent whose row cannot be
//     written is put back — withdrawn, or restored as the caller's earlier
//     consent was when a row names it or the lookup failed — a withdrawn
//     standing "keep current" is said to be off, and a put-back raced by
//     another pass of the caller's is read again, never reported as done
//     when it was not.
//   GOV-14 done-when 4 / SEM-1 done-when 2 — `key-overview`: every
//     background build on the CALLER's key across the workspace (the list AI
//     settings shows, each with a Stop), and with `models` each library's
//     vectors per embedding model (what the switch confirm names). It names
//     no library the caller does not already read, writes nothing and spends
//     nothing. The list's Stop sends `onlyMine`: a consent that no longer
//     names the caller is not stopped (409).
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
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

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
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
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
        request: {
          route: "/api/knowledge/embed", action: "build",
          platformRequestId: "iad1::abc-123", headersFrom: "unverified",
        },
        renewal: null,
      },
    });
    // the request id is the route's own, never a header the caller chose
    const request = (rows[0].details as { request: Row }).request;
    expect(String(request.requestId)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(request.requestId).not.toBe("iad1::abc-123");
    // …and it is logged with the library, payer and action, so the row and a log line name the same request
    expect(info).toHaveBeenCalledWith("[embed] consent recorded", {
      requestId: request.requestId, platformRequestId: "iad1::abc-123", libraryId: LIB, userId: ME, action: "build",
    });
    info.mockRestore();
  });

  it("reproduction → fix (DEC-46): the row — which every active member can read — carries no address and no client string, whatever the request sent", async () => {
    const { POST } = await import("@/app/api/knowledge/embed/route");
    for (const vercel of ["", "1"]) {
      vi.stubEnv("VERCEL", vercel);
      admin.state.tables.knowledge_libraries[0].ai_features = {};
      admin.state.tables.audit_logs = [];
      await POST(req({}, REQUEST_HEADERS));
      await POST(req({ action: "keep-current", on: true }, REQUEST_HEADERS));
      expect(consentRows()).toHaveLength(2);
      for (const row of consentRows()) {
        expect(Object.keys((row.details as { request: Row }).request).sort()).toEqual(["action", "headersFrom", "platformRequestId", "requestId", "route"]);
        const text = JSON.stringify(row);
        expect(text).not.toMatch(/203\.0\.113\.7|10\.0\.0\.1|Mozilla|forwardedFor|userAgent/);
      }
    }
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
    expect(request.platformRequestId).toBeNull();
    expect(request).not.toHaveProperty("forwardedFor");
  });

  it("off Vercel the platform id is recorded as unverified (it passes through from the caller); on Vercel as the platform edge's, and a client's x-request-id is not taken for the platform's id", async () => {
    const { POST } = await import("@/app/api/knowledge/embed/route");
    vi.stubEnv("VERCEL", "");
    await POST(req({}, { "x-request-id": "forged-id", "x-forwarded-for": "198.51.100.1" }));
    let request = (consentRows()[0].details as { request: Row }).request;
    expect(request).toMatchObject({ platformRequestId: "forged-id", headersFrom: "unverified" });
    expect(request.requestId).not.toBe("forged-id");
    admin.state.tables.knowledge_libraries[0].ai_features = {};
    admin.state.tables.audit_logs = [];
    vi.stubEnv("VERCEL", "1");
    await POST(req({}, { "x-request-id": "forged-id", "x-forwarded-for": "203.0.113.7" }));
    request = (consentRows()[0].details as { request: Row }).request;
    expect(request).toMatchObject({ platformRequestId: null, headersFrom: "platform-edge" });
    admin.state.tables.knowledge_libraries[0].ai_features = {};
    admin.state.tables.audit_logs = [];
    await POST(req({}, REQUEST_HEADERS));
    request = (consentRows()[0].details as { request: Row }).request;
    expect(request).toMatchObject({ platformRequestId: "iad1::abc-123", headersFrom: "platform-edge" });
  });

  it("a consent stamped before this deploy (no row names it) gets its first row on its next pass — and only one", async () => {
    admin.state.tables.knowledge_libraries[0].ai_features = { embedBuild: { userId: ME, at: "2026-09-30T08:00:00Z", standing: true } };
    const { POST } = await import("@/app/api/knowledge/embed/route");
    const body = await (await POST(req({}, REQUEST_HEADERS))).json();
    expect(body.backgroundNote).toBeUndefined();
    expect(marker()).toMatchObject({ userId: ME, standing: true });
    expect(consentRows()).toHaveLength(1);
    expect(consentRows()[0].details).toMatchObject({
      stampedAt: marker()!.at, standing: true, replaced: null,
      renewal: { previousStampedAt: "2026-09-30T08:00:00Z", earlierRow: "none" },
      request: { action: "build" },
    });
    await POST(req({}, REQUEST_HEADERS));
    await POST(req({ action: "keep-current", on: true }, REQUEST_HEADERS));
    expect(consentRows()).toHaveLength(1);
  });

  it("…and a standing consent from before this deploy gets its row when 'keep current' is pressed again", async () => {
    admin.state.tables.knowledge_libraries[0].ai_features = { embedBuild: { userId: ME, at: "2026-09-30T08:00:00Z", standing: true } };
    const { POST } = await import("@/app/api/knowledge/embed/route");
    expect((await (await POST(req({ action: "keep-current", on: true }, REQUEST_HEADERS))).json()).standing).toBe(true);
    expect(consentRows()).toHaveLength(1);
    expect(consentRows()[0].details).toMatchObject({
      standing: true, renewal: { previousStampedAt: "2026-09-30T08:00:00Z", earlierRow: "none" }, request: { action: "keep-current" },
    });
  });

  it("…and a consent from before this deploy whose first row cannot be written is withdrawn, not left spending — and a standing one is said to be off", async () => {
    admin.state.tables.knowledge_libraries[0].ai_features = { embedBuild: { userId: ME, at: "2026-09-30T08:00:00Z", standing: true } };
    admin.state.failWrites.audit_logs = { message: "audit down" };
    const { POST } = await import("@/app/api/knowledge/embed/route");
    const body = await (await POST(req({}))).json();
    expect(body.backgroundNote).toMatch(/could not be recorded \(its audit row could not be written \(audit down\)\) — keep this page open/);
    // reproduction → fix: the payer is told keep-current was switched off, never left to assume it is on
    expect(body.backgroundNote).toMatch(/Your "keep current" consent on this library is off now: switch it on again in the meaning-index panel once it can be recorded\./);
    expect(marker()).toBeUndefined();
  });

  it("…a plain consent from before this deploy, withdrawn the same way, says nothing about keep current", async () => {
    admin.state.tables.knowledge_libraries[0].ai_features = { embedBuild: { userId: ME, at: "2026-09-30T08:00:00Z" } };
    admin.state.failWrites.audit_logs = { message: "audit down" };
    const { POST } = await import("@/app/api/knowledge/embed/route");
    const body = await (await POST(req({}))).json();
    expect(body.backgroundNote).toMatch(/keep this page open until the build finishes\.$/);
    expect(body.backgroundNote).not.toMatch(/keep current/);
    expect(marker()).toBeUndefined();
  });

  it("reproduction → fix: a standing consent whose row lookup AND row write fail is put back exactly as it was — a failed read never withdraws keep current", async () => {
    const was = { userId: ME, at: "2026-09-20T00:00:00Z", standing: true, lastDrainAt: "2026-09-21T00:00:00Z", blockedUntil: "2999-01-01T00:00:00Z", blockedReason: "cap", lastError: "cap reached" };
    admin.state.tables.knowledge_libraries[0].ai_features = { embedBuild: { ...was } };
    admin.state.failReads.audit_logs = { message: "lookup down" };
    admin.state.failWrites.audit_logs = { message: "audit down" };
    const { POST } = await import("@/app/api/knowledge/embed/route");
    const res = await POST(req({}));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(marker()).toEqual(was);
    expect(body.backgroundNote).toBe(
      "This pass's consent could not be recorded (its audit row could not be written (audit down)), so your earlier consent on "
      + "this library was put back as it was before this pass (whether an audit row names it could not be checked); the "
      + "background build continues under it as before.",
    );
    expect(body.backgroundNote).not.toMatch(/off now|keep this page open/);
  });

  it("…and 'keep current' over the caller's standing consent, with the lookup and the write failing, answers that it stands as before", async () => {
    const was = { userId: ME, at: "2026-09-20T00:00:00Z", standing: true };
    admin.state.tables.knowledge_libraries[0].ai_features = { embedBuild: { ...was } };
    admin.state.failReads.audit_logs = { message: "lookup down" };
    admin.state.failWrites.audit_logs = { message: "audit down" };
    const { POST } = await import("@/app/api/knowledge/embed/route");
    const res = await POST(req({ action: "keep-current", on: true }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toMatchObject({ standing: null });
    expect(body.error).toBe(
      "The standing consent could not be recorded again: its audit row could not be written (audit down). Your \"keep current\" "
      + "consent on this library stands as it was before (whether an audit row names it could not be checked).",
    );
    expect(marker()).toEqual(was);
  });

  it("…and 'keep current' pressed over the caller's standing consent from before this deploy (no row), unaudited, withdraws it and says keep current is off", async () => {
    admin.state.tables.knowledge_libraries[0].ai_features = { embedBuild: { userId: ME, at: "2026-09-30T08:00:00Z", standing: true } };
    admin.state.failWrites.audit_logs = { message: "audit down" };
    const { POST } = await import("@/app/api/knowledge/embed/route");
    const res = await POST(req({ action: "keep-current", on: true }));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe(
      "The standing consent was not kept: its audit row could not be written (audit down). The \"keep current\" consent you "
      + "already had on this library is off now — switch it on again once it can be recorded.",
    );
    expect(marker()).toBeUndefined();
  });

  it("a renewal whose row lookup fails writes the row anyway (a second row is harmless, a missing one is not)", async () => {
    admin.state.tables.knowledge_libraries[0].ai_features = { embedBuild: { userId: ME, at: "2026-09-30T08:00:00Z" } };
    admin.state.failReads.audit_logs = { message: "lookup down" };
    const { POST } = await import("@/app/api/knowledge/embed/route");
    await POST(req({}));
    expect(consentRows()).toHaveLength(1);
    expect((consentRows()[0].details as Row).renewal).toEqual({ previousStampedAt: "2026-09-30T08:00:00Z", earlierRow: "lookup failed" });
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
    expect(consentRows()[0].details).toMatchObject({ standing: true, stampedAt: marker()!.at, renewal: null, request: { action: "keep-current", platformRequestId: "iad1::abc-123" } });
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
    expect(body.backgroundNote).not.toMatch(/keep current/);
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

  it("keep current over the caller's recorded consent, unaudited, puts that consent back exactly as it was — its instant and its holds too", async () => {
    const was = { userId: ME, at: "2026-09-20T00:00:00Z", lastDrainAt: "2026-09-21T00:00:00Z", blockedUntil: "2999-01-01T00:00:00Z", blockedReason: "cap", lastError: "cap reached", errorRuns: 2 };
    admin.state.tables.knowledge_libraries[0].ai_features = { embedBuild: { ...was } };
    admin.state.tables.audit_logs = [{ id: "a-1", action: "EMBED_BUILD_CONSENT_RECORDED", resource_type: "knowledge_library", resource_id: LIB, user_id: ME, details: { stampedAt: "2026-09-19T00:00:00Z" } }];
    admin.state.failWrites.audit_logs = { message: "audit down" };
    const { POST } = await import("@/app/api/knowledge/embed/route");
    const res = await POST(req({ action: "keep-current", on: true }));
    expect(res.status).toBe(500);
    expect(marker()).toEqual(was);
  });

  it("keep current over the caller's consent from before this deploy (no row), unaudited, withdraws it — no row names it", async () => {
    admin.state.tables.knowledge_libraries[0].ai_features = { embedBuild: { userId: ME, at: "2026-09-20T00:00:00Z" } };
    admin.state.failWrites.audit_logs = { message: "audit down" };
    const { POST } = await import("@/app/api/knowledge/embed/route");
    expect((await POST(req({ action: "keep-current", on: true }))).status).toBe(500);
    expect(marker()).toBeUndefined();
  });

  it("keep current with no consent before, unaudited, leaves no consent at all", async () => {
    admin.state.failWrites.audit_logs = { message: "audit down" };
    const { POST } = await import("@/app/api/knowledge/embed/route");
    expect((await POST(req({ action: "keep-current", on: true }))).status).toBe(500);
    expect(marker()).toBeUndefined();
  });

  describe("a put-back raced by another pass of the caller's (a second tab) is read again — never reported done when it was not", () => {
    /** The audit insert fails; while it does, `meanwhile` runs — the other tab's pass. */
    function auditFailsWhile(meanwhile: () => void) {
      Object.defineProperty(admin.state.failWrites, "audit_logs", {
        configurable: true, enumerable: true,
        get() { meanwhile(); return { message: "audit down" }; },
      });
    }
    const restamp = (at: string, extra: Row = {}) => {
      const lib = admin.state.tables.knowledge_libraries[0];
      lib.ai_features = { ...(lib.ai_features as Row), embedBuild: { ...((lib.ai_features as { embedBuild?: Row }).embedBuild ?? {}), userId: ME, at, ...extra } };
    };

    it("re-stamped by the other pass WITHOUT a row → withdrawn on the second try (expecting the new stamp), and the failure is said", async () => {
      auditFailsWhile(() => restamp("2026-10-02T09:00:00.000Z"));
      const { POST } = await import("@/app/api/knowledge/embed/route");
      const body = await (await POST(req({}))).json();
      expect(body.backgroundNote).toMatch(/could not be recorded \(its audit row could not be written \(audit down\)\) — keep this page open/);
      expect(marker()).toBeUndefined();
    });

    it("re-stamped by the other pass, which recorded its own row at that stamp → the consent stands, explained, and nothing false is said", async () => {
      auditFailsWhile(() => {
        restamp("2026-10-02T09:00:00.000Z");
        admin.state.tables.audit_logs.push({ id: "b-1", action: "EMBED_BUILD_CONSENT_RECORDED", resource_type: "knowledge_library", resource_id: LIB, user_id: ME, details: { stampedAt: "2026-10-02T09:00:00.000Z" } });
      });
      const { POST } = await import("@/app/api/knowledge/embed/route");
      const body = await (await POST(req({}))).json();
      expect(body.backgroundNote).toBeUndefined();
      expect(marker()).toMatchObject({ userId: ME, at: "2026-10-02T09:00:00.000Z" });
    });

    it("an older row of the caller's on this library (an earlier build) does not explain the re-stamped consent → withdrawn", async () => {
      admin.state.tables.audit_logs = [{ id: "old", action: "EMBED_BUILD_CONSENT_RECORDED", resource_type: "knowledge_library", resource_id: LIB, user_id: ME, details: { stampedAt: "2026-01-01T00:00:00Z" } }];
      auditFailsWhile(() => restamp("2026-10-02T09:00:00.000Z"));
      const { POST } = await import("@/app/api/knowledge/embed/route");
      await POST(req({}));
      expect(marker()).toBeUndefined();
    });

    it("a consent that keeps being re-stamped is said to stand — never 'withdrawn'", async () => {
      const real = admin.state.rpc.embed_build_marker_write;
      let n = 0;
      auditFailsWhile(() => {
        admin.state.rpc.embed_build_marker_write = (a) => { restamp(`2026-10-02T09:00:0${++n}.000Z`); return real(a); };
      });
      const { POST } = await import("@/app/api/knowledge/embed/route");
      const body = await (await POST(req({}))).json();
      expect(body.backgroundNote).toMatch(/its audit row could not be written \(audit down\), and it could not be withdrawn \(it kept changing — stop it under Background builds on your key in AI settings, or on the library's panel\)/);
      expect(marker()).toMatchObject({ userId: ME });
    });

    it("keep current over the caller's recorded plain consent, re-stamped meanwhile with the standing flag carried → the flag is taken off again", async () => {
      admin.state.tables.knowledge_libraries[0].ai_features = { embedBuild: { userId: ME, at: "2026-09-20T00:00:00Z" } };
      admin.state.tables.audit_logs = [{ id: "a-1", action: "EMBED_BUILD_CONSENT_RECORDED", resource_type: "knowledge_library", resource_id: LIB, user_id: ME, details: { stampedAt: "2026-09-20T00:00:00Z" } }];
      auditFailsWhile(() => restamp("2026-10-02T09:00:00.000Z", { standing: true }));
      const { POST } = await import("@/app/api/knowledge/embed/route");
      const res = await POST(req({ action: "keep-current", on: true }));
      expect(res.status).toBe(500);
      expect((await res.json()).error).toMatch(/^The standing consent was not kept: its audit row could not be written \(audit down\)\.$/);
      expect(marker()).toEqual({ userId: ME, at: "2026-10-02T09:00:00.000Z" });
    });
  });

  describe("GOV-14 done-when 4 — the Stop in AI settings' list stops a build only while it is on the caller's key (onlyMine)", () => {
    it("reproduction → fix: a controller's Stop on a stale row — another member's build replaced the listed consent — stops nothing (409)", async () => {
      admin.state.tables.knowledge_libraries[0].ai_features = { embedBuild: { userId: OTHER, at: "2026-10-02T09:00:00Z" } };
      const { POST } = await import("@/app/api/knowledge/embed/route");
      const res = await POST(req({ action: "release", onlyMine: true }));
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body).toMatchObject({ released: false, changed: true });
      expect(body.error).toBe("This background build no longer runs on your key — another member's build replaced it after the list was read — so nothing was stopped.");
      expect(marker()).toEqual({ userId: OTHER, at: "2026-10-02T09:00:00Z" });
    });

    it("…and a non-controller's stale row is told the same (409), not 'only the member whose key pays'", async () => {
      principal.isController = false;
      admin.state.tables.knowledge_libraries[0].ai_features = { embedBuild: { userId: OTHER, at: "2026-10-02T09:00:00Z", standing: true } };
      const { POST } = await import("@/app/api/knowledge/embed/route");
      const res = await POST(req({ action: "release", onlyMine: true }));
      expect(res.status).toBe(409);
      expect(marker()).toMatchObject({ userId: OTHER, standing: true });
    });

    it("the caller's own consent is stopped — re-stamped since the list was read or not", async () => {
      admin.state.tables.knowledge_libraries[0].ai_features = { embedBuild: { userId: ME, at: "2026-10-02T09:30:00Z", standing: true } };
      const { POST } = await import("@/app/api/knowledge/embed/route");
      const res = await POST(req({ action: "release", onlyMine: true }));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ released: true });
      expect(marker()).toBeUndefined();
    });

    it("nothing running any more is { released: false }, as before", async () => {
      const { POST } = await import("@/app/api/knowledge/embed/route");
      expect(await (await POST(req({ action: "release", onlyMine: true }))).json()).toEqual({ released: false });
    });

    it("REGRESSION: the library panel's release (no onlyMine) still lets a controller stop another member's build", async () => {
      admin.state.tables.knowledge_libraries[0].ai_features = { embedBuild: { userId: OTHER, at: "2026-10-02T09:00:00Z" } };
      const { POST } = await import("@/app/api/knowledge/embed/route");
      const res = await POST(req({ action: "release" }));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ released: true });
      expect(marker()).toBeUndefined();
    });
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
