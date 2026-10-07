// intelligence Round G (I-22) — GOV-5 residual: when the embed drain stops a
// run because the next batch's worst case does not fit what is left of the
// payer's monthly AI cap (not reached — I-18 fix pass 3: no hold, the run's
// report only), the run's outcome is recorded where the library surface can
// read it: on the library's build marker (ai_features.embedBuild), as
// `headroomWaitAt` and a note built from the refusal's figures in the THIRD
// person ("the payer's $10.00 monthly AI cap has … left") — never
// blockedUntil, so it holds nothing back. The next run that reaches the
// library clears it. The note is never the reservation's own sentence ("…
// left of your $10.00 monthly AI cap"): the panel that shows it is read by
// every member of the library, not only the payer.
//
// Before this, nothing durable recorded the outcome: drainEmbedBacklog
// returned it in `drained[].note`, the maintenance cron kept only a count
// (`result.embedDrain = { libraries, embedded }`) and the nudge route
// answered it to a browser that never reads it.
//
// The drain harness is lib/__tests__/embedDrain.test.ts's (I-16 owns that
// file; this one copies what it needs).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { freshAdminState, installMarkerRpc, type FakeAdminState, type Row } from "./helpers/knowledgeFakeAdmin";
import { meter, resetMeter } from "./helpers/fakeUsageMeter";

const admin = vi.hoisted(() => ({ state: null as unknown as import("./helpers/knowledgeFakeAdmin").FakeAdminState }));
vi.mock("@/lib/supabaseAdmin", async () => {
  const { makeFakeAdmin: make, freshAdminState: fresh } = await import("./helpers/knowledgeFakeAdmin");
  admin.state = fresh();
  const proxy = new Proxy({}, { get: (_t, p: string) => (make(admin.state) as Record<string, unknown>)[p] });
  return { supabaseAdmin: proxy };
});
const usage = vi.hoisted(() => ({ spent: 0, cap: 0 }));
vi.mock("@/lib/ai/usageServer", async () => {
  const { reserveWithinCap, settleUsage, releaseUsage } = (await import("./helpers/fakeUsageMeter")).fakeUsageServer();
  return {
    getMonthUsage: vi.fn(async () => ({ spentUsd: usage.spent })),
    getCapUsd: vi.fn(async () => usage.cap),
    recordAskUsage: vi.fn(async () => undefined),
    reserveWithinCap, settleUsage, releaseUsage,
  };
});
vi.mock("@/lib/ai/keyVault", () => ({ openAiKey: (v: unknown) => v }));

import { parseEmbedBuildMarker } from "@/lib/knowledgeEmbedCore";
import { drainEmbedBacklog } from "@/lib/knowledgeEmbedDrain";
import { EMBEDDING_DIMENSIONS } from "@/lib/ai/embeddings";
import { AGREEMENT_VERSION, worstCaseCostUsd } from "@/lib/ai/pricing";
import { headroomWaitLine, headroomWaitNote } from "@/lib/knowledgeKeyless";

const ORG = "0a000000-0000-4000-8000-000000000001";
const LIB = "0b000000-0000-4000-8000-000000000001";
const PAYER = "0d000000-0000-4000-8000-00000000000a";
const DOC = "0e000000-0000-4000-8000-000000000001";
const MODEL = "voyage-3.5-lite";
const AT = "2026-09-01T00:00:00Z";

function installRpcs(state: FakeAdminState) {
  const docs = () => new Map((state.tables.knowledge_documents ?? []).map((d) => [d.id as string, d]));
  state.rpc.embed_claim_batch = (a) => {
    const now = Date.now();
    const picked = (state.tables.knowledge_chunks ?? [])
      .filter((c) => c.library_id === a.p_library_id && c.embedding == null
        && (!c.embed_claimed_until || Date.parse(String(c.embed_claimed_until)) < now))
      .sort((x, y) => String(x.id).localeCompare(String(y.id)))
      .slice(0, Math.max(1, Math.min(Number(a.p_limit), 96)));
    for (const c of picked) c.embed_claimed_until = new Date(now + Number(a.p_lease_seconds) * 1000).toISOString();
    return { data: picked.map((c) => ({ ...c, document_name: docs().get(c.document_id as string)?.name ?? null })), error: null };
  };
  state.rpc.semantic_coverage_detail = (a) => {
    const all = (state.tables.knowledge_chunks ?? []).filter((c) => c.library_id === a.p_library_id);
    const open = all.filter((c) => c.embedding == null);
    const models: Record<string, number> = {};
    for (const c of all) if (c.embedding != null) models[String(c.embedding_model)] = (models[String(c.embedding_model)] ?? 0) + 1;
    return {
      data: [{
        total: all.length, embedded: all.length - open.length, remaining: open.length, failed: 0,
        leased: open.filter((c) => c.embed_claimed_until && Date.parse(String(c.embed_claimed_until)) > Date.now()).length,
        waiting: 0, remaining_chars: open.reduce((n, c) => n + String(c.content).length, 0),
        total_chars: all.reduce((n, c) => n + String(c.content).length, 0), models,
      }],
      error: null,
    };
  };
  installMarkerRpc(state);
}

const BODY = "x".repeat(3_000);
const chunk = (i: number): Row => ({
  id: `c${String(i).padStart(4, "0")}`, org_id: ORG, library_id: LIB, document_id: DOC, page: 1, seq: i, section: null,
  content: BODY, embedding: null, embedding_model: null, embed_attempts: 0, embed_error: null, embed_claimed_until: null, embed_retry_after: null,
});
const passage = `EP-5-6-2 Pipe supports — p.1\n${BODY}`;
const BATCH_WORST = Math.round(worstCaseCostUsd(MODEL, { inputChars: 64 * passage.length + "Embedding check.".length, maxTokens: 0 }) * 1e6) / 1e6;

const provider = vi.hoisted(() => ({ inputs: [] as string[] }));
beforeEach(() => {
  Object.assign(admin.state, freshAdminState());
  installRpcs(admin.state);
  admin.state.tables.knowledge_documents = [{ id: DOC, org_id: ORG, library_id: LIB, name: "EP-5-6-2 Pipe supports", status: "ready" }];
  admin.state.tables.org_members = [{ org_id: ORG, uid: PAYER, status: "active" }];
  admin.state.tables.ai_connections = [{ org_id: ORG, user_id: PAYER, provider: "anthropic", api_key: "x", embedding_provider: "voyage", embedding_model: MODEL, embedding_api_key: "pa-x" }];
  admin.state.tables.ai_key_agreements = [{ org_id: ORG, user_id: PAYER, scope: "use", agreement_version: AGREEMENT_VERSION }];
  admin.state.tables.knowledge_libraries = [{ id: LIB, org_id: ORG, ai_features: { embedBuild: { userId: PAYER, at: AT, standing: true } } }];
  admin.state.tables.knowledge_chunks = Array.from({ length: 100 }, (_, i) => chunk(i + 1));
  provider.inputs = [];
  usage.spent = 0; usage.cap = 0;
  resetMeter();
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { input: string[] };
    provider.inputs.push(...body.input);
    return {
      ok: true, status: 200, text: async () => "",
      json: async () => ({ data: body.input.map((_t, index) => ({ index, embedding: Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0.01) })), usage: { total_tokens: body.input.length * 10 } }),
    };
  }));
});
afterEach(() => { vi.unstubAllGlobals(); });

const markerOf = () => parseEmbedBuildMarker((admin.state.tables.knowledge_libraries[0].ai_features as Row).embedBuild)!;
const rearm = () => { (admin.state.tables.knowledge_libraries[0].ai_features as { embedBuild: Row }).embedBuild.lastDrainAt = "2000-01-01T00:00:00Z"; };
const run = () => drainEmbedBacklog({ scopeOrgIds: null, budgetMs: 200_000 });
const markerWrites = () => admin.state.calls.filter((c) => c.table === "rpc:embed_build_marker_write").map((c) => c.args[0] as Row);

describe("GOV-5 residual (I-22) — the embed drain records a stop for budget headroom where the library surface reads it, with no hold", () => {
  it("a payer under the cap whose headroom fits no batch: the run's outcome is on the build marker — headroomWaitAt and the payer's figures in the third person — and nothing is held", async () => {
    usage.cap = 10; usage.spent = 9.5;
    const SPENT = 10 - BATCH_WORST / 2;
    meter.spent = SPENT;
    const out = await run();
    expect(provider.inputs).toEqual([]);
    expect(out.drained[0]).toMatchObject({ outcome: "blocked", embedded: 0 });
    expect(out.drained[0].note).toMatch(/^the next batch did not fit what is left of the payer's monthly AI cap, which is not reached/);
    const m = markerOf();
    // Not a hold: no date the drain would skip on, no "cap reached".
    expect([m.blockedReason, m.blockedUntil, m.lastError]).toEqual([undefined, undefined, undefined]);
    expect(Date.parse(String(m.headroomWaitAt))).toBeGreaterThan(Date.now() - 60_000);
    // The refusal the drain met is the reservation's own, worded to the payer…
    const refused = meter.asked.filter((a) => a.refused === "does not fit");
    expect(refused.length).toBe(1);
    expect(refused[0].worstCaseUsd).toBe(BATCH_WORST);
    expect(out.drained[0].note).toMatch(/is left of your \$10\.00 monthly AI cap, so it was not made\.$/);
    // …but what the marker records — and every member's panel shows — is
    // the payer's figures in the third person, from that refusal's details.
    expect(m.headroomNote).toBe(headroomWaitNote({ spentUsd: SPENT, capUsd: 10, reservedUsd: BATCH_WORST }));
    expect(m.headroomNote).toMatch(/^the payer's \$10\.00 monthly AI cap has \$\d+\.\d+ left, and the next batch could cost up to \$\d+\.\d+\.$/);
    expect(m.headroomNote).not.toMatch(/\byour\b/i);
    expect(m).toMatchObject({ userId: PAYER, standing: true });
    // Written only on the stamp this run read.
    expect(markerWrites().every((w) => w.p_expect_user === PAYER && w.p_expect_at === AT)).toBe(true);
    // The library surface's line, from that record.
    expect(headroomWaitLine(m, 100, Date.now())).toBe("Waiting for AI budget headroom — retried each run");
  });

  it("…and the next run is not held back by it: it looks again, and once a batch fits it embeds and the record is cleared", async () => {
    usage.cap = 10; usage.spent = 9.5;
    meter.spent = 10 - BATCH_WORST / 2;
    await run();
    expect(markerOf().headroomWaitAt).toBeTruthy();
    // Headroom comes back (another call settled below its worst case).
    meter.spent = 0; usage.spent = 0;
    rearm();
    const out = await run();
    expect(out.drained[0]).toMatchObject({ outcome: "current", embedded: 100, remaining: 0 });
    const m = markerOf();
    expect(m.headroomWaitAt).toBeUndefined();
    expect(m.headroomNote).toBeUndefined();
    expect(headroomWaitLine(m, 0, Date.now())).toBeNull();
  });

  it("a later run stopped for another reason no longer says it waits for headroom (the record is the LATEST run's)", async () => {
    usage.cap = 10; usage.spent = 9.5;
    meter.spent = 10 - BATCH_WORST / 2;
    await run();
    expect(markerOf().headroomWaitAt).toBeTruthy();
    // The payer's agreement lapses: the next run holds for it, and the
    // panel shows that hold, never the stale wait.
    admin.state.tables.ai_key_agreements = [];
    rearm();
    await run();
    const m = markerOf();
    expect(m.blockedReason).toBe("agreement");
    expect(m.headroomWaitAt).toBeUndefined();
  });

  it("REGRESSION: a run that never met a no-fit stop writes the marker exactly as before (no extra field, no drop)", async () => {
    const out = await run();
    expect(out.drained[0]).toMatchObject({ outcome: "current", embedded: 100 });
    const writes = markerWrites();
    expect(writes.length).toBeGreaterThan(0);
    for (const w of writes) {
      expect(w.p_drop).toEqual([]);
      expect(JSON.stringify(w.p_marker ?? {})).not.toMatch(/headroom/);
    }
    expect(markerOf().headroomWaitAt).toBeUndefined();
  });
});
