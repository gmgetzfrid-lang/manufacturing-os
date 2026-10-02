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
//     when it was not. "Keep current" reads the consent it replaces again
//     when the first read fails, and never writes over one it still cannot
//     read (fix pass 3), so it never withdraws a standing consent it did not
//     know stood. Whether a write recorded a new consent or renewed one is
//     decided on the consent the write replaced — the marker its
//     compare-and-set was conditional on — never on an earlier read of the
//     route's own (fix pass 4): a consent released or replaced after the
//     request read it and before its write is audited as the new consent it
//     is.
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

  describe("'keep current' never writes over a consent it could not read (I-20 fix pass 3)", () => {
    /** The library marker's first `n` reads (a select of ai_features) fail. */
    function markerReadsFail(n: number) {
      let left = n;
      Object.defineProperty(admin.state.failReads, "knowledge_libraries", {
        configurable: true, enumerable: true,
        get() {
          const last = [...admin.state.calls].reverse().find((c) => c.table === "knowledge_libraries" && c.method === "select");
          if (last?.args[0] === "ai_features" && left > 0) { left--; return { message: "read timeout" }; }
          return undefined;
        },
      });
    }
    const markerWrites = () => admin.state.calls.filter((c) => c.table === "rpc:embed_build_marker_write").length;

    it("reproduction → fix: over the caller's standing, recorded consent, a marker read that fails once is read again — the consent is kept, never withdrawn, though the row write would fail", async () => {
      admin.state.tables.knowledge_libraries[0].ai_features = { embedBuild: { userId: ME, at: "2026-09-20T00:00:00Z", standing: true } };
      admin.state.tables.audit_logs = [{ id: "a-1", action: "EMBED_BUILD_CONSENT_RECORDED", resource_type: "knowledge_library", resource_id: LIB, user_id: ME, details: { stampedAt: "2026-09-20T00:00:00Z" } }];
      admin.state.failWrites.audit_logs = { message: "audit down" };
      markerReadsFail(1);
      const { POST } = await import("@/app/api/knowledge/embed/route");
      const res = await POST(req({ action: "keep-current", on: true }));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ standing: true });
      expect(marker()).toMatchObject({ userId: ME, standing: true });
    });

    it("reproduction → fix: over the caller's standing consent from before this deploy (no row), a read that fails once and a row that cannot be written say keep current is off — the consent was withdrawn", async () => {
      admin.state.tables.knowledge_libraries[0].ai_features = { embedBuild: { userId: ME, at: "2026-09-30T08:00:00Z", standing: true } };
      admin.state.failWrites.audit_logs = { message: "audit down" };
      markerReadsFail(1);
      const { POST } = await import("@/app/api/knowledge/embed/route");
      const res = await POST(req({ action: "keep-current", on: true }));
      expect(res.status).toBe(500);
      expect((await res.json()).error).toBe(
        "The standing consent was not kept: its audit row could not be written (audit down). The \"keep current\" consent you "
        + "already had on this library is off now — switch it on again once it can be recorded.",
      );
      expect(marker()).toBeUndefined();
    });

    it("a marker that cannot be read twice is not written over: 500, nothing changed, the standing consent as it was, no row", async () => {
      const was = { userId: ME, at: "2026-09-20T00:00:00Z", standing: true };
      admin.state.tables.knowledge_libraries[0].ai_features = { embedBuild: { ...was } };
      admin.state.failWrites.audit_logs = { message: "audit down" };
      markerReadsFail(2);
      const { POST } = await import("@/app/api/knowledge/embed/route");
      const res = await POST(req({ action: "keep-current", on: true }));
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body).toEqual({ error: "Couldn't read the standing consent, so nothing was changed: read timeout", standing: null });
      expect(marker()).toEqual(was);
      expect(markerWrites()).toBe(0);
      expect(consentRows()).toHaveLength(0);
    });

    it("REGRESSION: a read that fails once and then answers records a new standing consent exactly as before (one row)", async () => {
      markerReadsFail(1);
      const { POST } = await import("@/app/api/knowledge/embed/route");
      const res = await POST(req({ action: "keep-current", on: true }, REQUEST_HEADERS));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ standing: true });
      expect(consentRows()).toHaveLength(1);
      expect(consentRows()[0].details).toMatchObject({ standing: true, stampedAt: marker()!.at, renewal: null, replaced: null });
    });
  });

  describe("the audit goes by the consent the write replaced, not an earlier read (I-20 fix pass 4)", () => {
    /** Just before the request's first marker write lands, `meanwhile` runs:
     *  a release, or another member's build, after the request read the
     *  consent and before its write. */
    function beforeFirstMarkerWrite(meanwhile: () => void) {
      const real = admin.state.rpc.embed_build_marker_write;
      let first = true;
      admin.state.rpc.embed_build_marker_write = (a) => {
        if (first) { first = false; meanwhile(); }
        return real(a);
      };
    }
    const lib = () => admin.state.tables.knowledge_libraries[0];
    const release = () => { delete (lib().ai_features as Row).embedBuild; };
    const recorded = (at: string, standing = false) => {
      lib().ai_features = { embedBuild: { userId: ME, at, ...(standing ? { standing: true } : {}) } };
      admin.state.tables.audit_logs = [{ id: "a-1", action: "EMBED_BUILD_CONSENT_RECORDED", resource_type: "knowledge_library", resource_id: LIB, user_id: ME, details: { stampedAt: at } }];
    };

    it("reproduction → fix: the caller's recorded consent is released before this pass's write lands → the pass records a NEW consent, and a row is written for it (it used to be taken for a renewal: no row)", async () => {
      recorded("2026-09-20T00:00:00Z");
      beforeFirstMarkerWrite(release);
      const { POST } = await import("@/app/api/knowledge/embed/route");
      const body = await (await POST(req({}, REQUEST_HEADERS))).json();
      expect(body.backgroundNote).toBeUndefined();
      expect(marker()).toMatchObject({ userId: ME });
      expect(marker()!.at).not.toBe("2026-09-20T00:00:00Z");
      const rows = consentRows();
      expect(rows).toHaveLength(2);
      expect(rows[1].details).toMatchObject({ stampedAt: marker()!.at, standing: false, replaced: null, renewal: null, request: { action: "build" } });
    });

    it("reproduction → fix: replaced by another member's plain build before the write → the row names whose consent it replaced", async () => {
      recorded("2026-09-20T00:00:00Z");
      beforeFirstMarkerWrite(() => { lib().ai_features = { embedBuild: { userId: OTHER, at: "2026-10-02T09:00:00Z" } }; });
      const { POST } = await import("@/app/api/knowledge/embed/route");
      await POST(req({}, REQUEST_HEADERS));
      expect(marker()).toMatchObject({ userId: ME });
      expect(consentRows()).toHaveLength(2);
      expect(consentRows()[1].details).toMatchObject({ stampedAt: marker()!.at, replaced: { userId: OTHER, standing: false }, renewal: null });
    });

    it("reproduction → fix: 'keep current' over the caller's standing, recorded consent, released before the write → a new standing consent, with its row", async () => {
      recorded("2026-09-20T00:00:00Z", true);
      beforeFirstMarkerWrite(release);
      const { POST } = await import("@/app/api/knowledge/embed/route");
      const res = await POST(req({ action: "keep-current", on: true }, REQUEST_HEADERS));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ standing: true });
      expect(consentRows()).toHaveLength(2);
      expect(consentRows()[1].details).toMatchObject({ stampedAt: marker()!.at, standing: true, replaced: null, renewal: null, request: { action: "keep-current" } });
    });

    it("…and that new consent, when its row cannot be written, is withdrawn (it is not the caller's earlier one to restore)", async () => {
      recorded("2026-09-20T00:00:00Z", true);
      beforeFirstMarkerWrite(release);
      admin.state.failWrites.audit_logs = { message: "audit down" };
      const { POST } = await import("@/app/api/knowledge/embed/route");
      const res = await POST(req({ action: "keep-current", on: true }));
      expect(res.status).toBe(500);
      expect((await res.json()).error).toBe("The standing consent was not kept: its audit row could not be written (audit down).");
      expect(marker()).toBeUndefined();
    });

    it("negative control: the caller's own consent re-stamped by another pass of theirs before the write is still a renewal — no new row", async () => {
      recorded("2026-09-20T00:00:00Z");
      beforeFirstMarkerWrite(() => { lib().ai_features = { embedBuild: { userId: ME, at: "2026-10-02T09:00:00Z" } }; });
      const { POST } = await import("@/app/api/knowledge/embed/route");
      const body = await (await POST(req({}, REQUEST_HEADERS))).json();
      expect(body.backgroundNote).toBeUndefined();
      expect(marker()).toMatchObject({ userId: ME });
      expect(consentRows()).toHaveLength(1);
    });

    it("negative control: another member's standing consent recorded before the write stands — a plain build never replaces it, so no row", async () => {
      recorded("2026-09-20T00:00:00Z");
      beforeFirstMarkerWrite(() => { lib().ai_features = { embedBuild: { userId: OTHER, at: "2026-10-02T09:00:00Z", standing: true } }; });
      const { POST } = await import("@/app/api/knowledge/embed/route");
      const body = await (await POST(req({}, REQUEST_HEADERS))).json();
      expect(body.backgroundNote).toBeUndefined();
      expect(marker()).toEqual({ userId: OTHER, at: "2026-10-02T09:00:00Z", standing: true });
      expect(consentRows()).toHaveLength(1);
    });

    it("REGRESSION: with nothing in between, a renewal of a recorded consent writes no row and a first consent writes one — as before", async () => {
      recorded("2026-09-20T00:00:00Z");
      const { POST } = await import("@/app/api/knowledge/embed/route");
      await POST(req({}, REQUEST_HEADERS));
      expect(consentRows()).toHaveLength(1);
      lib().ai_features = {};
      admin.state.tables.audit_logs = [];
      await POST(req({}, REQUEST_HEADERS));
      expect(consentRows()).toHaveLength(1);
      expect(consentRows()[0].details).toMatchObject({ replaced: null, renewal: null });
    });

    it("recordEmbedBuildConsent reports the consent its write replaced — the one its compare-and-set held to, from the round that landed", async () => {
      const { recordEmbedBuildConsent } = await import("@/lib/knowledgeEmbedCore");
      recorded("2026-09-20T00:00:00Z");
      beforeFirstMarkerWrite(() => { lib().ai_features = { embedBuild: { userId: OTHER, at: "2026-10-02T09:00:00Z" } }; });
      const out = await recordEmbedBuildConsent(LIB, ME);
      expect(out).toMatchObject({ error: null, applied: true, prior: { userId: OTHER, at: "2026-10-02T09:00:00Z" } });
      // another member's standing consent: nothing written, and it is the prior named
      lib().ai_features = { embedBuild: { userId: OTHER, at: "2026-10-02T09:30:00Z", standing: true } };
      expect(await recordEmbedBuildConsent(LIB, ME)).toMatchObject({ error: null, applied: false, prior: { userId: OTHER, standing: true } });
      // nothing before
      lib().ai_features = {};
      expect(await recordEmbedBuildConsent(LIB, ME)).toEqual({ error: null, applied: true, prior: null });
      // an unreadable marker: nothing written, the prior unknown
      admin.state.failReads.knowledge_libraries = { message: "read timeout" };
      expect(await recordEmbedBuildConsent(LIB, ME)).toEqual({ error: "read timeout", applied: false, prior: undefined });
    });
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

  it("the instant listed for a build (startedAt) is the last pass's stamp — every build pass re-stamps it, so it is when the consent was last confirmed, not first recorded (I-20 fix pass 4)", async () => {
    admin.state.tables.knowledge_libraries = [{ id: LIB, org_id: ORG, name: "Standards", ai_features: {} }];
    const { POST } = await import("@/app/api/knowledge/embed/route");
    await POST(req({}, REQUEST_HEADERS));
    const first = String(marker()!.at);
    await new Promise((r) => setTimeout(r, 5));
    await POST(req({}, REQUEST_HEADERS));
    const second = String(marker()!.at);
    expect(second).not.toBe(first);
    // one row, naming the first stamp; the overview lists the second
    expect(consentRows()).toHaveLength(1);
    expect((consentRows()[0].details as Row).stampedAt).toBe(first);
    const body = await (await POST(overview())).json();
    expect(body.builds[0]).toMatchObject({ libraryId: LIB, startedAt: second });
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

// ── I-20 fix pass 5 ─────────────────────────────────────────────────────────
//
// GOV-14 (pre-existing, closed here). "Keep current" switched off took
// `standing` off with a patch that left the consent's instant as it was. A
// build pass that had read the consent before that patch, and wrote after
// it, still matched its compare (payer and instant) and wrote its own
// standing flag back: the consent stood again while the switch-off had
// answered { standing: false }, and nobody was told. Now the switch-off
// re-stamps the instant, so that write fails its compare, re-reads, and
// records the consent as the switch-off left it. The consent write also
// expects an instant its read lacked to be still absent, so an instant-less
// consent is covered the same way.
//
// GOV-14 (pre-existing, recommended): a build pass whose write did not apply
// (another member's standing consent stands) audited nonetheless — reading
// the marker back, and, were it the caller's by then (their own "keep
// current" in another tab), writing a second row naming the wrong
// `replaced`, or, that row failing, withdrawing the consent the other
// request had recorded and audited. A write that did not apply is no longer
// audited, and nothing is put back.
describe("I-20 fix pass 5 — 'keep current' off is never undone by a build pass that read the consent before it; a write that did not apply is not audited", () => {
  const lib = () => admin.state.tables.knowledge_libraries[0];
  const rowFor = (at: string) => ({ id: `a-${at}`, action: "EMBED_BUILD_CONSENT_RECORDED", resource_type: "knowledge_library", resource_id: LIB, user_id: ME, details: { stampedAt: at } });
  const consentWrites = () => admin.state.calls
    .filter((c) => c.table === "rpc:embed_build_marker_write")
    .map((c) => c.args[0] as Row)
    .filter((a) => !a.p_patch && (a.p_marker as Row | null)?.userId === ME);
  /** Just before the FIRST marker write lands, `meanwhile` runs to the end
   *  (it may be a whole request); every later write goes straight through. */
  function beforeFirstMarkerWrite(meanwhile: () => Promise<void> | void) {
    const real = admin.state.rpc.embed_build_marker_write;
    let first = true;
    admin.state.rpc.embed_build_marker_write = (async (a: Record<string, unknown>) => {
      if (first) { first = false; await meanwhile(); }
      return real(a);
    }) as unknown as typeof real;
  }

  it("reproduction → fix: 'keep current' switched off between a build pass's read of the consent and its write — standing stays off; the build pass's write fails its compare, re-reads, and records the consent as the switch-off left it", async () => {
    lib().ai_features = { embedBuild: { userId: ME, at: "2026-09-20T00:00:00Z", standing: true, lastDrainAt: "2026-09-21T00:00:00Z" } };
    admin.state.tables.audit_logs = [rowFor("2026-09-20T00:00:00Z")];
    const { POST } = await import("@/app/api/knowledge/embed/route");
    let off: { status: number; body: unknown } | null = null;
    let offAt = "";
    beforeFirstMarkerWrite(async () => {
      const res = await POST(req({ action: "keep-current", on: false }));
      off = { status: res.status, body: await res.json() };
      offAt = String(marker()!.at);
    });
    const body = await (await POST(req({}, REQUEST_HEADERS))).json();
    expect(off).toEqual({ status: 200, body: { standing: false } });
    // the switch-off stands: the consent is the caller's plain build
    expect(marker()).toMatchObject({ userId: ME });
    expect(marker()!.standing).toBeUndefined();
    expect(body.backgroundNote).toBeUndefined();
    // the build pass's first write held to the instant it read and matched nothing; it re-read and held to the switch-off's
    const writes = consentWrites();
    expect(writes.map((w) => w.p_expect_at)).toEqual(["2026-09-20T00:00:00Z", offAt]);
    expect((writes[0].p_marker as Row).standing).toBe(true);
    expect((writes[1].p_marker as Row).standing).toBeUndefined();
    expect(offAt).not.toBe("2026-09-20T00:00:00Z");
    // a renewal of a consent a row names: no new row
    expect(consentRows()).toHaveLength(1);
  });

  it("recordEmbedBuildConsent against the patch 'keep current' off now writes (standing off, instant re-stamped): it re-reads, reports the consent it actually replaced, and writes no standing flag", async () => {
    const { recordEmbedBuildConsent } = await import("@/lib/knowledgeEmbedCore");
    lib().ai_features = { embedBuild: { userId: ME, at: "2026-10-01T00:00:00Z", standing: true } };
    beforeFirstMarkerWrite(() => { lib().ai_features = { embedBuild: { userId: ME, at: "2026-10-02T10:00:00Z" } }; });
    const out = await recordEmbedBuildConsent(LIB, ME);
    expect(out.applied).toBe(true);
    expect(out.prior).toMatchObject({ userId: ME, at: "2026-10-02T10:00:00Z", standing: false });
    expect(marker()).toMatchObject({ userId: ME });
    expect(marker()!.standing).toBeUndefined();
  });

  it("an instant-less consent is covered too: the write expects the instant still absent, so the switch-off's re-stamp makes it re-read (it used to hold to the payer alone)", async () => {
    lib().ai_features = { embedBuild: { userId: ME, standing: true } };
    admin.state.tables.audit_logs = [rowFor("")];
    const { POST } = await import("@/app/api/knowledge/embed/route");
    let off: unknown = null;
    beforeFirstMarkerWrite(async () => { off = await (await POST(req({ action: "keep-current", on: false }))).json(); });
    await POST(req({}));
    expect(off).toEqual({ standing: false });
    expect(marker()).toMatchObject({ userId: ME });
    expect(marker()!.standing).toBeUndefined();
    expect(consentWrites()[0].p_expect_at).toBe("");
  });

  it("the residual this leaves, pinned: the compare sees the payer and the instant only — a patch that took `standing` off and kept the instant (the raced put-back's flag-only patch) would still be written over", async () => {
    const { recordEmbedBuildConsent } = await import("@/lib/knowledgeEmbedCore");
    lib().ai_features = { embedBuild: { userId: ME, at: "2026-10-01T00:00:00Z", standing: true } };
    beforeFirstMarkerWrite(() => { lib().ai_features = { embedBuild: { userId: ME, at: "2026-10-01T00:00:00Z" } }; });
    const out = await recordEmbedBuildConsent(LIB, ME);
    expect(out).toMatchObject({ applied: true, prior: { standing: true } });
    expect(marker()).toMatchObject({ standing: true });
  });

  it("REGRESSION (no race): 'keep current' off with passages left answers { standing: false } and keeps the consent, its payer, last run and holds — only `standing` goes and the instant is re-stamped, which is what AI settings then lists as 'last confirmed'; with nothing left it clears the consent as before", async () => {
    const was = { userId: ME, at: "2026-09-20T00:00:00Z", standing: true, lastDrainAt: "2026-09-21T00:00:00Z", blockedUntil: "2999-01-01T00:00:00Z", blockedReason: "cap", lastError: "cap reached", errorRuns: 2 };
    lib().ai_features = { decoder: "PID", embedBuild: { ...was } };
    const { POST } = await import("@/app/api/knowledge/embed/route");
    const before = Date.now();
    expect(await (await POST(req({ action: "keep-current", on: false }))).json()).toEqual({ standing: false });
    const { standing: _s, at: _a, ...kept } = was;
    void _s; void _a;
    expect(marker()).toEqual({ ...kept, at: marker()!.at });
    expect(Date.parse(String(marker()!.at))).toBeGreaterThanOrEqual(before - 1000);
    expect((lib().ai_features as Row).decoder).toBe("PID");
    expect(consentRows()).toHaveLength(0);
    const listed = await (await POST(new NextRequest("http://test/api/knowledge/embed", {
      method: "POST", headers: { authorization: "Bearer tok" }, body: JSON.stringify({ orgId: ORG, action: "key-overview" }),
    }))).json();
    expect(listed.builds[0]).toMatchObject({ libraryId: LIB, standing: false, startedAt: marker()!.at });
    // nothing left: the stamp is cleared, exactly as before
    detail = { ...detail, remaining: 0, waiting: 0, embedded: 10 };
    lib().ai_features = { embedBuild: { ...was } };
    expect(await (await POST(req({ action: "keep-current", on: false }))).json()).toEqual({ standing: false });
    expect(marker()).toBeUndefined();
  });

  it("negative control: with nothing in between, a build pass over the caller's own standing consent still carries `standing` over in one write — no re-read, no row (renewal)", async () => {
    lib().ai_features = { embedBuild: { userId: ME, at: "2026-09-20T00:00:00Z", standing: true } };
    admin.state.tables.audit_logs = [rowFor("2026-09-20T00:00:00Z")];
    const { POST } = await import("@/app/api/knowledge/embed/route");
    const body = await (await POST(req({}, REQUEST_HEADERS))).json();
    expect(body.backgroundNote).toBeUndefined();
    expect(marker()).toMatchObject({ userId: ME, standing: true });
    expect(consentWrites()).toHaveLength(1);
    expect(consentWrites()[0].p_expect_at).toBe("2026-09-20T00:00:00Z");
    expect(consentRows()).toHaveLength(1);
  });

  /** The n-th knowledge_libraries read runs `then` first: the route's library
   *  check is the 1st, the consent write's own read the 2nd — so the 3rd is
   *  the first read after the build pass's consent write was decided. */
  function onLibraryRead(nth: number, then: () => void) {
    const real = admin.state.failReads;
    let reads = 0;
    admin.state.failReads = new Proxy(real, {
      get: (t, p: string) => {
        if (p === "knowledge_libraries" && ++reads === nth) then();
        return (t as Record<string, unknown>)[p];
      },
    });
  }
  const myKeepCurrentInAnotherTab = () => {
    lib().ai_features = { embedBuild: { userId: ME, at: "2026-10-02T11:00:00Z", standing: true } };
    admin.state.tables.audit_logs!.push({ ...rowFor("2026-10-02T11:00:00Z"), details: { stampedAt: "2026-10-02T11:00:00Z", standing: true, request: { action: "keep-current" } } });
  };

  it("reproduction → fix: a build pass whose write did not apply (another member's standing consent stood) writes no row — even when the consent is the caller's by the time it would have looked (their 'keep current' in another tab, audited there)", async () => {
    lib().ai_features = { embedBuild: { userId: OTHER, at: "2026-09-01T00:00:00Z", standing: true } };
    onLibraryRead(3, myKeepCurrentInAnotherTab);
    const { POST } = await import("@/app/api/knowledge/embed/route");
    const body = await (await POST(req({}, REQUEST_HEADERS))).json();
    expect(body.backgroundNote).toBeUndefined();
    // the other tab's row only — none from this pass, which recorded nothing (it used to add one naming OTHER as `replaced`)
    expect(consentRows()).toHaveLength(1);
    expect((consentRows()[0].details as Row).request).toEqual({ action: "keep-current" });
    expect(marker()).toEqual({ userId: ME, at: "2026-10-02T11:00:00Z", standing: true });
  });

  it("reproduction → fix: …and with audit rows failing, that other request's audited consent is left standing — never withdrawn by a pass that recorded nothing", async () => {
    lib().ai_features = { embedBuild: { userId: OTHER, at: "2026-09-01T00:00:00Z", standing: true } };
    onLibraryRead(3, myKeepCurrentInAnotherTab);
    admin.state.failWrites.audit_logs = { message: "audit down" };
    const { POST } = await import("@/app/api/knowledge/embed/route");
    const body = await (await POST(req({}, REQUEST_HEADERS))).json();
    expect(body.backgroundNote).toBeUndefined();
    expect(marker()).toEqual({ userId: ME, at: "2026-10-02T11:00:00Z", standing: true });
    expect(admin.state.calls.filter((c) => c.table === "rpc:embed_build_marker_write")).toHaveLength(0);
  });

  it("negative control: a write that DID apply is audited as before — over another member's plain build, the row names it", async () => {
    lib().ai_features = { embedBuild: { userId: OTHER, at: "2026-09-01T00:00:00Z" } };
    const { POST } = await import("@/app/api/knowledge/embed/route");
    await POST(req({}, REQUEST_HEADERS));
    expect(marker()).toMatchObject({ userId: ME });
    expect(consentRows()).toHaveLength(1);
    expect((consentRows()[0].details as Row).replaced).toEqual({ userId: OTHER, standing: false });
  });
});
