// intelligence Round G (I-22) — GOV-5 residual, the status half: the embed
// route's status carries the drain's recorded headroom wait to the
// meaning-index panel (`background.headroomWaitAt` / `headroomNote`), and
// only when the drain recorded one — every other status keeps the exact
// shape lib/__tests__/embedStatusShape.test.ts pins.
//
// The harness is embedStatusShape.test.ts's (copied: that file is I-02's).

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
vi.mock("@/lib/knowledgeAccess", () => ({ loadPrincipal: vi.fn(async () => ({ isController: true })) }));
vi.mock("@/lib/ai/usageServer", () => ({
  getMonthUsage: vi.fn(async () => ({ spentUsd: 0 })),
  getCapUsd: vi.fn(async () => 0),
  recordAskUsage: vi.fn(async () => undefined),
}));
vi.mock("@/lib/ai/keyVault", () => ({ openAiKey: (v: unknown) => v }));

import { AGREEMENT_VERSION } from "@/lib/ai/pricing";

const ORG = "0a000000-0000-4000-8000-000000000001";
const LIB = "0b000000-0000-4000-8000-000000000001";
const ME = "0d000000-0000-4000-8000-00000000000a";

beforeEach(() => {
  admin.state ??= freshAdminState();
  Object.assign(admin.state, freshAdminState());
  admin.state.user = { id: ME };
  admin.state.rpc.semantic_coverage = () => ({ data: [{ total: 40, embedded: 30 }], error: null });
  admin.state.rpc.semantic_coverage_detail = () => ({
    data: [{ total: 40, embedded: 30, remaining: 10, failed: 0, leased: 0, waiting: 0, remaining_chars: 12_000, total_chars: 60_000, models: { "voyage-3.5-lite": 30 } }],
    error: null,
  });
  admin.state.tables.ai_connections = [{ org_id: ORG, user_id: ME, provider: "anthropic", api_key: "k", embedding_provider: "voyage", embedding_model: "voyage-3.5-lite", embedding_api_key: "pa" }];
  admin.state.tables.ai_key_agreements = [{ org_id: ORG, user_id: ME, scope: "use", agreement_version: AGREEMENT_VERSION }];
  installMarkerRpc(admin.state);
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("no provider call expected"); }));
});
afterEach(() => { vi.unstubAllGlobals(); });

const status = async (embedBuild: Row) => {
  admin.state.tables.knowledge_libraries = [{ id: LIB, org_id: ORG, ai_features: { embedBuild } }];
  const { POST } = await import("@/app/api/knowledge/embed/route");
  const res = await POST(new NextRequest("http://test/api/knowledge/embed", {
    method: "POST", headers: { authorization: "Bearer tok" },
    body: JSON.stringify({ orgId: ORG, libraryId: LIB, action: "status" }),
  }));
  expect(res.status).toBe(200);
  return res.json() as Promise<{ background: Record<string, unknown> | null; remaining: number }>;
};

describe("GOV-5 residual (I-22) — the status says what the drain recorded", () => {
  it("a recorded headroom wait rides background, beside the fields it always had", async () => {
    const body = await status({
      userId: ME, at: "2026-09-01T00:00:00Z", standing: true, lastDrainAt: "2026-10-07T03:00:00Z",
      headroomWaitAt: "2026-10-07T03:00:05Z", headroomNote: "This call could cost up to $0.11 and $0.06 is left of your $10.00 monthly AI cap.",
    });
    expect(body.background).toEqual({
      mine: true, standing: true, startedAt: "2026-09-01T00:00:00Z", lastDrainAt: "2026-10-07T03:00:00Z",
      blockedUntil: null, blockedReason: null, lastError: null,
      headroomWaitAt: "2026-10-07T03:00:05Z", headroomNote: "This call could cost up to $0.11 and $0.06 is left of your $10.00 monthly AI cap.",
    });
    expect(body.remaining).toBe(10);
  });

  it("REGRESSION: with nothing recorded the background object is exactly what it was", async () => {
    const body = await status({ userId: ME, at: "2026-09-01T00:00:00Z", standing: true, lastDrainAt: "2026-09-29T00:00:00Z", blockedUntil: "2026-10-01T00:00:00.000Z", blockedReason: "cap", lastError: "monthly cap reached" });
    expect(body.background).toEqual({
      mine: true, standing: true, startedAt: "2026-09-01T00:00:00Z", lastDrainAt: "2026-09-29T00:00:00Z",
      blockedUntil: "2026-10-01T00:00:00.000Z", blockedReason: "cap", lastError: "monthly cap reached",
    });
  });
});
