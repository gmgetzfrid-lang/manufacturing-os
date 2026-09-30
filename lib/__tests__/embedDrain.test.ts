// intelligence Round G (I-02) — the meaning index's build and drain.
//
//   * SEM-4 — one passage the provider refuses no longer pins a library: the
//     batch is split until the refused passage stands alone, it gets an
//     attempt and its reason, the rest embed; after EMBED_MAX_ATTEMPTS the
//     queue skips it. A refusal of the KEY blames no passage. Every vector
//     paid for is written even when one write fails.
//   * SEM-7 — the queue is a claim: two slices running at once take disjoint
//     passages (the reproduction shows the unclaimed queue paying twice).
//   * SEM-11 — every marked library is read and worked least-recently-drained
//     first; cap / error / conflict / agreement holds carry a date instead of
//     a slot; repeated failure releases; outcomes name what happened,
//     including "starved".
//   * SEM-8 — a standing consent survives 100% and keeps the index current.
//   * GOV-14 limb — a stamp naming no active member is released, never spent.
//   * 20261121 — the paste contract, byte fidelity against 20261014 / 20261007,
//     and the census. (The SQL itself was run against a scratch PostgreSQL 16:
//     see the finding records.)
//
// The claim / detail RPCs below are transcriptions of 20261121's SQL, pinned
// to it by the shape tests at the bottom.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { freshAdminState, type FakeAdminState, type Row } from "./helpers/knowledgeFakeAdmin";

const admin = vi.hoisted(() => ({ state: null as unknown as import("./helpers/knowledgeFakeAdmin").FakeAdminState }));
vi.mock("@/lib/supabaseAdmin", async () => {
  const { makeFakeAdmin: make, freshAdminState: fresh } = await import("./helpers/knowledgeFakeAdmin");
  admin.state = fresh();
  const proxy = new Proxy({}, { get: (_t, p: string) => (make(admin.state) as Record<string, unknown>)[p] });
  return { supabaseAdmin: proxy };
});
const usage = vi.hoisted(() => ({ spent: 0, cap: 0, recorded: [] as Array<Record<string, unknown>> }));
vi.mock("@/lib/ai/usageServer", () => ({
  getMonthUsage: vi.fn(async () => ({ spentUsd: usage.spent })),
  getCapUsd: vi.fn(async () => usage.cap),
  recordAskUsage: vi.fn(async (r: Record<string, unknown>) => { usage.recorded.push(r); }),
}));
vi.mock("@/lib/ai/keyVault", () => ({ openAiKey: (v: unknown) => v }));

import { embedLibrarySlice, parseEmbedBuildMarker, loadEmbedDetail } from "@/lib/knowledgeEmbedCore";
import { drainEmbedBacklog, orderDrainQueue, nextMonthStartIso, errorBackoffMs, MAX_ERROR_RUNS } from "@/lib/knowledgeEmbedDrain";
import { EMBED_MAX_ATTEMPTS, EMBEDDING_DIMENSIONS } from "@/lib/ai/embeddings";

const repo = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const mig = (f: string) => repo(join("supabase", "migrations", f));
const strip = (sql: string) => sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, "");
function lineDiff(a: string, b: string) {
  const A = a.split("\n").map((l) => l.trim()).filter(Boolean);
  const B = b.split("\n").map((l) => l.trim()).filter(Boolean);
  return { onlyInA: A.filter((l) => !B.includes(l)), onlyInB: B.filter((l) => !A.includes(l)) };
}

const ORG = "0a000000-0000-4000-8000-000000000001";
const LIB = "0b000000-0000-4000-8000-000000000001";
const PAYER = "0d000000-0000-4000-8000-00000000000a";
const DOC = "0e000000-0000-4000-8000-000000000001";
const ERRDOC = "0e000000-0000-4000-8000-000000000002";
const CONN = { provider: "voyage" as const, model: "voyage-3.5-lite", apiKey: "pa-x" };

// ── 20261121 transcribed: the claim and the detail ──────────────────────────
function installRpcs(state: FakeAdminState) {
  const docs = () => new Map((state.tables.knowledge_documents ?? []).map((d) => [d.id as string, d]));
  const retrievable = (c: Row) => ["ready", "indexing"].includes(String(docs().get(c.document_id as string)?.status));
  state.rpc.embed_claim_batch = (a) => {
    const now = Date.now();
    const picked = (state.tables.knowledge_chunks ?? [])
      .filter((c) => c.org_id === a.p_org_id && c.library_id === a.p_library_id && c.embedding == null && retrievable(c)
        && Number(c.embed_attempts ?? 0) < Number(a.p_max_attempts)
        && (!c.embed_claimed_until || Date.parse(String(c.embed_claimed_until)) < now))
      .sort((x, y) => Number(x.embed_attempts ?? 0) - Number(y.embed_attempts ?? 0)
        || String(x.document_id).localeCompare(String(y.document_id)) || Number(x.page) - Number(y.page) || String(x.id).localeCompare(String(y.id)))
      .slice(0, Math.max(1, Math.min(Number(a.p_limit), 96)));
    for (const c of picked) c.embed_claimed_until = new Date(now + Number(a.p_lease_seconds) * 1000).toISOString();
    return { data: picked.map((c) => ({ ...c, document_name: docs().get(c.document_id as string)?.name ?? null })), error: null };
  };
  state.rpc.semantic_coverage_detail = (a) => {
    const all = (state.tables.knowledge_chunks ?? []).filter((c) => c.org_id === a.p_org_id && c.library_id === a.p_library_id);
    const pop = all.filter(retrievable);
    const max = Number(a.p_max_attempts);
    const models: Record<string, number> = {};
    for (const c of all) if (c.embedding != null) models[String(c.embedding_model ?? "(unrecorded)")] = (models[String(c.embedding_model ?? "(unrecorded)")] ?? 0) + 1;
    const open = pop.filter((c) => c.embedding == null);
    return {
      data: [{
        total: pop.length,
        embedded: pop.filter((c) => c.embedding != null).length,
        remaining: open.filter((c) => Number(c.embed_attempts ?? 0) < max).length,
        failed: open.filter((c) => Number(c.embed_attempts ?? 0) >= max).length,
        leased: open.filter((c) => c.embed_claimed_until && Date.parse(String(c.embed_claimed_until)) > Date.now()).length,
        remaining_chars: open.filter((c) => Number(c.embed_attempts ?? 0) < max).reduce((n, c) => n + String(c.content).length, 0),
        total_chars: pop.reduce((n, c) => n + String(c.content).length, 0),
        models,
      }],
      error: null,
    };
  };
}

const chunk = (i: number, over: Row = {}): Row => ({
  id: `c${String(i).padStart(4, "0")}`, org_id: ORG, library_id: LIB, document_id: DOC, page: i, seq: 0, section: null,
  content: `passage ${i}`, embedding: null, embedding_model: null, embed_attempts: 0, embed_error: null, embed_claimed_until: null, ...over,
});

// ── the provider ────────────────────────────────────────────────────────────
const provider = vi.hoisted(() => ({ inputs: [] as string[], mode: "ok" as "ok" | "401" | "429" | "400-all" }));
function stubProvider() {
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { input: string[] };
    const reply = (status: number, payload: unknown) => ({ ok: status < 300, status, json: async () => payload, text: async () => JSON.stringify(payload) });
    if (provider.mode === "401") return reply(401, { detail: "invalid key" });
    if (provider.mode === "429") return reply(429, { detail: "slow down" });
    if (provider.mode === "400-all") return reply(400, { detail: "input_type is not supported" });
    if (body.input.some((t) => t.includes("POISON"))) return reply(400, { detail: "input exceeds the model's context" });
    provider.inputs.push(...body.input);
    return reply(200, {
      data: body.input.map((_t, index) => ({ index, embedding: Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0.01) })),
      usage: { total_tokens: body.input.length * 10 },
    });
  }));
}

beforeEach(() => {
  Object.assign(admin.state, freshAdminState());
  installRpcs(admin.state);
  admin.state.tables.knowledge_documents = [
    { id: DOC, org_id: ORG, library_id: LIB, name: "EP-5-6-2 Pipe supports", status: "ready" },
    { id: ERRDOC, org_id: ORG, library_id: LIB, name: "Broken upload", status: "error" },
  ];
  provider.inputs = [];
  provider.mode = "ok";
  usage.spent = 0; usage.cap = 0; usage.recorded = [];
  stubProvider();
});
afterEach(() => { vi.unstubAllGlobals(); });

const slice = (over: Partial<Parameters<typeof embedLibrarySlice>[0]> = {}) => embedLibrarySlice({
  orgId: ORG, libraryId: LIB, connection: CONN, batchSize: 64, budgetMs: 30_000, hardStopMs: 40_000, ...over,
});
const chunks = () => admin.state.tables.knowledge_chunks;

// ── SEM-4 ───────────────────────────────────────────────────────────────────
describe("SEM-4 — a refused passage never pins the library", () => {
  it("reproduction: the unclaimed queue (pre-20261121) stops on the refused batch and makes no progress, run after run", async () => {
    delete admin.state.rpc.embed_claim_batch;             // the function doesn't exist yet
    admin.state.tables.knowledge_chunks = [chunk(1), chunk(2, { content: "POISON table row" }), chunk(3)];
    for (let run = 0; run < 3; run++) {
      const out = await slice();
      expect(out.queue).toBe("legacy");
      expect(out.embedded).toBe(0);
      expect(out.error).toMatch(/embedding call failed \(400\)/);
    }
    expect(chunks().filter((c) => c.embedding != null)).toHaveLength(0);
  });
  it("the claim path splits the batch: every other passage embeds, the refused one gets an attempt and its reason", async () => {
    admin.state.tables.knowledge_chunks = Array.from({ length: 10 }, (_, i) => chunk(i + 1, i === 6 ? { content: "POISON table row" } : {}));
    const out = await slice();
    expect(out.queue).toBe("claim");
    expect(out.error).toBeNull();
    expect(out.embedded).toBe(9);
    expect(out.refused).toBe(1);
    const poison = chunks().find((c) => String(c.content).includes("POISON"))!;
    expect(poison).toMatchObject({ embedding: null, embed_attempts: 1 });
    // it keeps its lease: nobody asks the provider again this run
    expect(Date.parse(String(poison.embed_claimed_until))).toBeGreaterThan(Date.now());
    expect(String(poison.embed_error)).toMatch(/exceeds the model's context/);
    // every passage but the refused one carries a vector stamped with the model, lease cleared
    for (const c of chunks().filter((x) => x !== poison)) {
      expect(c.embedding).toBeTruthy();
      expect(c).toMatchObject({ embedding_model: "voyage-3.5-lite", embed_claimed_until: null });
    }
  });
  it(`after ${EMBED_MAX_ATTEMPTS} refusals the queue skips the passage; the library reports it failed and is otherwise done`, async () => {
    admin.state.tables.knowledge_chunks = [chunk(1, { content: "POISON" }), chunk(2)];
    for (let run = 0; run < EMBED_MAX_ATTEMPTS; run++) {
      await slice();
      expect(chunks()[0].embed_attempts).toBe(run + 1);              // one attempt per run, never a tight loop
      chunks()[0].embed_claimed_until = "2000-01-01T00:00:00Z";      // the lease runs out between runs
    }
    expect(chunks()[0].embed_attempts).toBe(EMBED_MAX_ATTEMPTS);
    const again = await slice();
    expect(again.embedded).toBe(0);
    expect(again.refused).toBe(0);
    const detail = (await loadEmbedDetail(ORG, LIB))!;
    expect(detail).toMatchObject({ total: 2, embedded: 1, remaining: 0, failed: 1 });
  });
  it("a refusal of the KEY blames no passage: no attempt recorded, the slice stops with the provider's reason, leases given back", async () => {
    provider.mode = "401";
    admin.state.tables.knowledge_chunks = [chunk(1), chunk(2), chunk(3)];
    const out = await slice();
    expect(out.error).toMatch(/rejected the embeddings key/);
    expect(chunks().every((c) => c.embed_attempts === 0 && c.embed_claimed_until === null)).toBe(true);
  });
  it("a batch the provider refuses whole (every split fails, nothing embeds) is the request, not the passages — nobody is blamed", async () => {
    provider.mode = "400-all";
    admin.state.tables.knowledge_chunks = Array.from({ length: 8 }, (_, i) => chunk(i + 1));
    const out = await slice();
    expect(out.error).toMatch(/input_type is not supported/);
    expect(out.refused).toBe(0);
    expect(chunks().every((c) => c.embed_attempts === 0)).toBe(true);
  });
  it("a write that fails does not abandon the other vectors already paid for", async () => {
    admin.state.tables.knowledge_chunks = Array.from({ length: 5 }, (_, i) => chunk(i + 1));
    // one row's UPDATE errors (a trigger / a transient failure)
    const real = admin.state.failWrites;
    let n = 0;
    admin.state.failWrites = new Proxy(real, {
      get: (t, p: string) => (p === "knowledge_chunks" && ++n === 3 ? { message: "write refused" } : (t as Record<string, unknown>)[p]),
    });
    const out = await slice();
    expect(out.error).toBe("write refused");
    expect(chunks().filter((c) => c.embedding != null)).toHaveLength(4);
  });
  it("chunks of a document that is not ready / indexing are never claimed or paid for (SEM-5)", async () => {
    admin.state.tables.knowledge_chunks = [chunk(1), chunk(2, { document_id: ERRDOC })];
    await slice();
    expect(chunks().find((c) => c.document_id === ERRDOC)!.embedding).toBeNull();
    expect(provider.inputs.some((t) => t.includes("Broken upload"))).toBe(false);
  });
});

// ── SEM-7 ───────────────────────────────────────────────────────────────────
describe("SEM-7 — two drivers at once take disjoint passages", () => {
  it("reproduction: the unclaimed queue sends the same passages twice when two slices overlap", async () => {
    delete admin.state.rpc.embed_claim_batch;
    admin.state.tables.knowledge_chunks = Array.from({ length: 6 }, (_, i) => chunk(i + 1));
    await Promise.all([slice(), slice()]);
    expect(provider.inputs.length).toBe(12);                          // every passage billed twice
  });
  it("the claim leases each batch: two overlapping slices embed every passage exactly once", async () => {
    admin.state.tables.knowledge_chunks = Array.from({ length: 40 }, (_, i) => chunk(i + 1));
    const [a, b] = await Promise.all([slice({ batchSize: 8 }), slice({ batchSize: 8 })]);
    expect(provider.inputs.length).toBe(40);
    expect(new Set(provider.inputs).size).toBe(40);
    expect(a.embedded + b.embedded).toBe(40);
  });
  it("a 429 is pacing: the slice reports rateLimited and gives its batch back to the queue", async () => {
    provider.mode = "429";
    admin.state.tables.knowledge_chunks = [chunk(1), chunk(2)];
    const out = await slice();
    expect(out.rateLimited).toBe(true);
    expect(out.error).toBeNull();
    expect(chunks().every((c) => c.embed_claimed_until === null && c.embed_attempts === 0)).toBe(true);
  });
  it("the write-back is conditional (a passage another driver already embedded is not counted twice)", () => {
    const core = repo("lib/knowledgeEmbedCore.ts");
    expect(core).toContain('return queue === "claim" ? q.is("embedding", null).select("id") : q;');
    expect(core).toContain('if (queue === "claim") embedded += Array.isArray(r.data) ? r.data.length : 0;');
  });
});

// ── SEM-11 / SEM-8 / GOV-14 — the drain ─────────────────────────────────────
const marked = (id: string, marker: Row, org = ORG): Row => ({ id, org_id: org, ai_features: { embedBuild: marker } });
const LIBS = Array.from({ length: 8 }, (_, i) => `0b000000-0000-4000-8000-0000000000${String(i + 10)}`);

function seedDrainWorld() {
  admin.state.tables.org_members = [{ org_id: ORG, uid: PAYER, status: "active" }];
  admin.state.tables.ai_connections = [{ org_id: ORG, user_id: PAYER, provider: "anthropic", api_key: "x", embedding_provider: "voyage", embedding_model: "voyage-3.5-lite", embedding_api_key: "pa-x" }];
  admin.state.tables.ai_key_agreements = [{ org_id: ORG, user_id: PAYER, scope: "use", agreement_version: "2026-07-v2" }];
}

describe("SEM-11 — no library starves another; every hold has a date", () => {
  it("reproduction: the old drain read `.limit(6)` with no order — the seventh marked library was never selected", () => {
    const now = repo("lib/knowledgeEmbedDrain.ts");
    expect(now).not.toMatch(/\.limit\(6\)/);
    expect(now).toContain('.order("id", { ascending: true })');
    expect(now).toContain(".range(from, from + MARKER_PAGE - 1);");
  });
  it("the queue is least-recently-drained first; never-drained leads", () => {
    const q = orderDrainQueue([
      { id: "b", marker: { lastDrainAt: "2026-09-29T00:00:00Z" } },
      { id: "a", marker: { lastDrainAt: "2026-09-30T00:00:00Z" } },
      { id: "c", marker: {} },
    ]);
    expect(q.map((x) => x.id)).toEqual(["c", "b", "a"]);
  });
  it("six capped libraries hold with a date (the 1st) and the seventh is drained in the same run", async () => {
    seedDrainWorld();
    usage.cap = 10;
    usage.spent = 0;
    const capped = LIBS.slice(0, 6);
    admin.state.tables.knowledge_libraries = [
      ...capped.map((id, i) => marked(id, { userId: PAYER, at: "2026-09-01T00:00:00Z", lastDrainAt: `2026-09-0${i + 1}T00:00:00Z` })),
      marked(LIBS[6], { userId: PAYER, at: "2026-09-01T00:00:00Z", lastDrainAt: "2026-09-20T00:00:00Z" }),
    ];
    admin.state.tables.knowledge_chunks = [...LIBS.slice(0, 7).map((lib, i) => chunk(i + 1, { library_id: lib }))];
    admin.state.tables.knowledge_documents[0].library_id = null;
    // the cap is reached for the first six only
    let calls = 0;
    const { getMonthUsage } = await import("@/lib/ai/usageServer");
    vi.mocked(getMonthUsage).mockImplementation(async () => ({ spentUsd: ++calls <= 6 ? 50 : 0 }) as never);
    const out = await drainEmbedBacklog({ scopeOrgIds: null, budgetMs: 200_000 });
    const byLib = new Map(out.drained.map((d) => [d.libraryId, d]));
    for (const id of capped) {
      expect(byLib.get(id)!.outcome).toBe("blocked");
      const m = parseEmbedBuildMarker((admin.state.tables.knowledge_libraries.find((l) => l.id === id)!.ai_features as Row).embedBuild)!;
      expect(m).toMatchObject({ blockedReason: "cap", blockedUntil: nextMonthStartIso(Date.now()), userId: PAYER });
    }
    expect(byLib.get(LIBS[6])!.outcome).toBe("complete");
    // the next run does not spend a slot on the held six
    vi.mocked(getMonthUsage).mockImplementation(async () => ({ spentUsd: 0 }) as never);
    const again = await drainEmbedBacklog({ scopeOrgIds: null, budgetMs: 200_000 });
    expect(again.drained.filter((d) => capped.includes(d.libraryId)).every((d) => d.outcome === "blocked")).toBe(true);
    vi.mocked(getMonthUsage).mockImplementation(async () => ({ spentUsd: usage.spent }) as never);
  });
  it("a failing library backs off (15 min, doubling) and is released after MAX_ERROR_RUNS runs", async () => {
    seedDrainWorld();
    provider.mode = "401";
    admin.state.tables.knowledge_libraries = [marked(LIB, { userId: PAYER, at: "2026-09-01T00:00:00Z" })];
    admin.state.tables.knowledge_chunks = [chunk(1)];
    const first = await drainEmbedBacklog({ scopeOrgIds: null, budgetMs: 200_000 });
    expect(first.drained[0]).toMatchObject({ outcome: "blocked" });
    let m = parseEmbedBuildMarker((admin.state.tables.knowledge_libraries[0].ai_features as Row).embedBuild)!;
    expect(m).toMatchObject({ blockedReason: "error", errorRuns: 1 });
    expect(Date.parse(m.blockedUntil!) - Date.now()).toBeGreaterThan(14 * 60_000);
    expect(errorBackoffMs(1)).toBe(15 * 60_000);
    expect(errorBackoffMs(3)).toBe(60 * 60_000);
    expect(errorBackoffMs(20)).toBe(24 * 3_600_000);
    // still held: no spend
    const held = await drainEmbedBacklog({ scopeOrgIds: null, budgetMs: 200_000 });
    expect(held.drained[0].outcome).toBe("blocked");
    // runs 2..MAX with the hold expired each time
    for (let run = 2; run <= MAX_ERROR_RUNS; run++) {
      (admin.state.tables.knowledge_libraries[0].ai_features as { embedBuild: Row }).embedBuild.blockedUntil = "2000-01-01T00:00:00Z";
      const out = await drainEmbedBacklog({ scopeOrgIds: null, budgetMs: 200_000 });
      if (run < MAX_ERROR_RUNS) expect(out.drained[0].outcome).toBe("blocked");
      else {
        expect(out.drained[0].outcome).toBe("released");
        expect(out.drained[0].note).toMatch(new RegExp(`released after ${MAX_ERROR_RUNS} failed runs`));
      }
    }
    m = parseEmbedBuildMarker((admin.state.tables.knowledge_libraries[0].ai_features as Row).embedBuild)!;
    expect(m).toBeNull();
  });
  it("a library the budget never reached is reported starved (not silently skipped)", async () => {
    seedDrainWorld();
    admin.state.tables.knowledge_libraries = LIBS.slice(0, 3).map((id) => marked(id, { userId: PAYER, at: "2026-09-01T00:00:00Z" }));
    const out = await drainEmbedBacklog({ scopeOrgIds: null, budgetMs: 10_000 });
    expect(out.drained.map((d) => d.outcome)).toEqual(["starved", "starved", "starved"]);
  });
  it("a user-triggered run skips a library drained moments ago (a burst of nudges is one drain)", async () => {
    seedDrainWorld();
    admin.state.tables.knowledge_libraries = [marked(LIB, { userId: PAYER, at: "2026-09-01T00:00:00Z", lastDrainAt: new Date().toISOString() })];
    admin.state.tables.knowledge_chunks = [chunk(1)];
    const out = await drainEmbedBacklog({ scopeOrgIds: [ORG], budgetMs: 200_000, minIntervalMs: 120_000 });
    expect(out.drained[0].outcome).toBe("recent");
    expect(provider.inputs).toHaveLength(0);
  });
  it("every remaining passage leased by another run → busy, no spend", async () => {
    seedDrainWorld();
    admin.state.tables.knowledge_libraries = [marked(LIB, { userId: PAYER, at: "2026-09-01T00:00:00Z" })];
    admin.state.tables.knowledge_chunks = [chunk(1, { embed_claimed_until: new Date(Date.now() + 60_000).toISOString() })];
    const out = await drainEmbedBacklog({ scopeOrgIds: null, budgetMs: 200_000 });
    expect(out.drained[0].outcome).toBe("busy");
    expect(provider.inputs).toHaveLength(0);
  });
});

describe("GOV-14 limb — a consent that names nobody is released, never spent", () => {
  it("a non-uuid userId, or one that is not an active member of the library's org, releases the stamp before any key is read", async () => {
    seedDrainWorld();
    admin.state.tables.knowledge_libraries = [
      marked(LIBS[0], { userId: "x,monthly_cap_usd.gte.0", at: "2026-09-01T00:00:00Z" }),
      marked(LIBS[1], { userId: "0d000000-0000-4000-8000-0000000000ff", at: "2026-09-01T00:00:00Z" }),
    ];
    admin.state.tables.knowledge_chunks = [chunk(1, { library_id: LIBS[0] }), chunk(2, { library_id: LIBS[1] })];
    const out = await drainEmbedBacklog({ scopeOrgIds: null, budgetMs: 200_000 });
    expect(out.drained.map((d) => d.outcome)).toEqual(["released", "released"]);
    expect(admin.state.calls.some((c) => c.table === "ai_connections")).toBe(false);
    expect(admin.state.tables.knowledge_libraries.every((l) => !(l.ai_features as Row).embedBuild)).toBe(true);
  });
});

describe("SEM-8 — a standing consent keeps the index current", () => {
  it("at 100% a standing stamp stays (outcome current); a plain one clears (complete)", async () => {
    seedDrainWorld();
    admin.state.tables.knowledge_libraries = [
      marked(LIBS[0], { userId: PAYER, at: "2026-09-01T00:00:00Z", standing: true }),
      marked(LIBS[1], { userId: PAYER, at: "2026-09-01T00:00:00Z" }),
    ];
    admin.state.tables.knowledge_chunks = [];
    const out = await drainEmbedBacklog({ scopeOrgIds: null, budgetMs: 200_000 });
    expect(out.drained.map((d) => [d.libraryId, d.outcome])).toEqual([[LIBS[0], "current"], [LIBS[1], "complete"]]);
    expect((admin.state.tables.knowledge_libraries[0].ai_features as Row).embedBuild).toBeTruthy();
    expect((admin.state.tables.knowledge_libraries[1].ai_features as Row).embedBuild).toBeUndefined();
  });
  it("passages added later are embedded by the next run on the same consent — no button pressed", async () => {
    seedDrainWorld();
    admin.state.tables.knowledge_libraries = [marked(LIB, { userId: PAYER, at: "2026-09-01T00:00:00Z", standing: true })];
    admin.state.tables.knowledge_chunks = [chunk(1, { embedding: "[0]", embedding_model: "voyage-3.5-lite" })];
    await drainEmbedBacklog({ scopeOrgIds: null, budgetMs: 200_000 });
    admin.state.tables.knowledge_chunks.push(chunk(2), chunk(3));          // ingestion adds passages
    (admin.state.tables.knowledge_libraries[0].ai_features as { embedBuild: Row }).embedBuild.lastDrainAt = "2000-01-01T00:00:00Z";
    const out = await drainEmbedBacklog({ scopeOrgIds: null, budgetMs: 200_000 });
    expect(out.drained[0]).toMatchObject({ outcome: "current", embedded: 2 });
    expect(chunks().every((c) => c.embedding != null)).toBe(true);
    expect(usage.recorded.at(-1)).toMatchObject({ userId: PAYER, op: "knowledgeEmbed" });
  });
});

describe("SEM-1 / SEM-3 — the drain never mixes two models into one library", () => {
  it("the payer's saved model differs from the index → held (model_conflict), nothing embedded", async () => {
    seedDrainWorld();
    admin.state.tables.ai_connections[0].embedding_model = "voyage-3.5";
    admin.state.tables.knowledge_libraries = [marked(LIB, { userId: PAYER, at: "2026-09-01T00:00:00Z" })];
    admin.state.tables.knowledge_chunks = [chunk(1, { embedding: "[0]", embedding_model: "voyage-3.5-lite" }), chunk(2)];
    const out = await drainEmbedBacklog({ scopeOrgIds: null, budgetMs: 200_000 });
    expect(out.drained[0].outcome).toBe("blocked");
    expect(out.drained[0].note).toMatch(/built with voyage-3.5-lite; your embeddings setting is voyage-3.5/);
    expect(provider.inputs).toHaveLength(0);
  });
  it("an unsigned agreement holds the build (local gate until the shared one lands)", async () => {
    seedDrainWorld();
    admin.state.tables.ai_key_agreements = [];
    admin.state.tables.knowledge_libraries = [marked(LIB, { userId: PAYER, at: "2026-09-01T00:00:00Z" })];
    admin.state.tables.knowledge_chunks = [chunk(1)];
    const out = await drainEmbedBacklog({ scopeOrgIds: null, budgetMs: 200_000 });
    expect(out.drained[0]).toMatchObject({ outcome: "blocked" });
    expect(out.drained[0].note).toMatch(/acceptable-use agreement/);
    expect(provider.inputs).toHaveLength(0);
  });
});

describe("the embed-drain route throttles user triggers; the cron path is unchanged", () => {
  const route = repo("app/api/cron/embed-drain/route.ts");
  it("a user bearer passes minIntervalMs; the CRON_SECRET path does not", () => {
    expect(route).toContain("...(scopeOrgIds ? { minIntervalMs: USER_TRIGGER_MIN_INTERVAL_MS } : {}),");
    expect(route).toContain("const USER_TRIGGER_MIN_INTERVAL_MS = 120_000;");
    expect(repo("app/api/cron/maintenance/route.ts")).toContain("const drainOut = await drainEmbedBacklog({ scopeOrgIds: null, budgetMs: 100_000 });");
  });
  it("the page-load nudge is debounced per tab", () => {
    const k = repo("lib/knowledge.ts");
    expect(k).toContain("const NUDGE_DEBOUNCE_MS = 10 * 60_000;");
    expect(k).toContain("if (now - last < NUDGE_DEBOUNCE_MS) return;");
  });
});

// ── 20261121 ────────────────────────────────────────────────────────────────
describe("20261121 — the paste contract, byte fidelity, the census", () => {
  const FILE = "20261121_intel_roundG_semantic_layer.sql";
  const m = mig(FILE);
  const tx = m.slice(m.indexOf("\nBEGIN;"), m.indexOf("\nCOMMIT;"));
  const body = strip(tx);
  const tail = m.slice(m.indexOf("\nCOMMIT;") + "\nCOMMIT;".length);

  it("one paste: TEMP inventory (aggregates) before BEGIN, one transaction, ONE final SELECT with (check, ok, n)", () => {
    expect(m.indexOf("CREATE TEMP TABLE IF NOT EXISTS _intel_g21_before AS")).toBeLessThan(m.indexOf("\nBEGIN;"));
    expect((m.match(/\nBEGIN;/g) ?? []).length).toBe(1);
    expect((m.match(/\nCOMMIT;/g) ?? []).length).toBe(1);
    const statements = strip(tail).split(/;\s*$/m).map((s) => s.trim()).filter(Boolean);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatch(/^SELECT 'knowledge_chunks carries embed_attempts/);
    expect(statements[0]).toContain(`AS "check",`);
    expect(statements[0]).toContain("NULL::text AS n");
    expect(statements[0]).toContain("SELECT 'inventory (before): ' || what, NULL, n::text FROM _intel_g21_before");
    expect(tail).not.toMatch(/LIKE '[^']*::[^']*'/);
    const inv = strip(m.slice(m.indexOf("CREATE TEMP TABLE"), m.indexOf("\nBEGIN;")));
    expect(inv).not.toMatch(/SELECT \*|embedding_api_key|api_key/);
  });
  it("semantic_coverage = 20261014 with the retrievable-document predicate added (SEM-5)", () => {
    const grab = (t: string) => {
      const s = strip(t);
      const i = s.lastIndexOf("CREATE OR REPLACE FUNCTION semantic_coverage(");
      return s.slice(i, s.indexOf("$$;", s.indexOf("AS $$", i)) + 3);
    };
    const d = lineDiff(grab(mig("20261014_coverage_timeout_headroom.sql")), grab(tx));
    expect(d.onlyInA).toEqual(["AND (p_library_id IS NULL OR library_id = p_library_id))::BIGINT,"]);
    expect(d.onlyInB).toEqual([
      "AND document_id IN (SELECT d.id FROM knowledge_documents d WHERE d.org_id = p_org_id AND d.status IN ('ready', 'indexing')))::BIGINT,",
      "AND document_id IN (SELECT d.id FROM knowledge_documents d WHERE d.org_id = p_org_id AND d.status IN ('ready', 'indexing'))",
    ]);
  });
  it("semantic_search = 20261007 plus ef_search, the eligible count and the mixed-library refusal — nothing of the old body lost but the header and the dollar tags", () => {
    const old = strip(mig("20261007_rag_hardening.sql"));
    const i = old.indexOf("CREATE OR REPLACE FUNCTION semantic_search(");
    const oldFn = old.slice(i, old.indexOf("$$;", old.indexOf("AS $$", i)) + 3);
    const j = body.indexOf("CREATE FUNCTION semantic_search(");
    const newFn = body.slice(j, body.indexOf("$body$\n$fn$", j) + "$body$".length);
    const d = lineDiff(oldFn, newFn);
    expect(d.onlyInA).toEqual([
      "CREATE OR REPLACE FUNCTION semantic_search(",
      "similarity    REAL",
      "AS $$",
      "(1 - (c.embedding <=> p_embedding))::REAL AS similarity",
      "$$;",
    ]);
    expect(d.onlyInB).toEqual([
      "CREATE FUNCTION semantic_search(",
      "similarity    REAL,",
      "eligible      BIGINT",
      "SET hnsw.ef_search = 200%s",
      "AS $body$",
      "(1 - (c.embedding <=> p_embedding))::REAL AS similarity,",
      "(SELECT COUNT(*) FROM knowledge_chunks e",
      "WHERE e.org_id = p_org_id",
      "AND (p_library_id IS NULL OR e.library_id = p_library_id)",
      "AND e.embedding IS NOT NULL",
      "AND (p_model IS NULL OR e.embedding_model = p_model))::BIGINT AS eligible",
      "AND NOT (p_library_id IS NOT NULL AND p_model IS NOT NULL AND EXISTS (",
      "SELECT 1 FROM knowledge_chunks o",
      "WHERE o.library_id = p_library_id AND o.embedding IS NOT NULL",
      "AND o.embedding_model IS DISTINCT FROM p_model))",
      "$body$",
    ]);
    // iterative scan only where pgvector knows it (0.8+), chosen from pg_extension
    expect(body).toContain("SELECT (m[1]::int, m[2]::int) >= (0, 8)");
    expect(body).toContain("CASE WHEN v_iterative THEN E'\\nSET hnsw.iterative_scan = strict_order' ELSE '' END");
    expect(body).toContain("DROP FUNCTION IF EXISTS semantic_search(UUID, UUID, vector, INT, TEXT);");
    expect(body).toContain("REVOKE ALL ON FUNCTION semantic_search(UUID, UUID, vector, INT, TEXT) FROM public, anon;");
    expect(body).toContain("GRANT EXECUTE ON FUNCTION semantic_search(UUID, UUID, vector, INT, TEXT) TO authenticated;");
  });
  it("the claim: SKIP LOCKED + lease, retrievable only, attempts under the limit, fewest attempts first; service role only", () => {
    const fn = body.slice(body.indexOf("CREATE OR REPLACE FUNCTION embed_claim_batch("), body.indexOf("REVOKE ALL ON FUNCTION embed_claim_batch"));
    expect(fn).toContain("LANGUAGE sql VOLATILE SECURITY INVOKER");
    expect(fn).toContain("SET search_path = public");
    expect(fn).toContain("FOR UPDATE OF c SKIP LOCKED");
    expect(fn).toContain("AND d.status IN ('ready', 'indexing')");
    expect(fn).toContain("AND c.embed_attempts < p_max_attempts");
    expect(fn).toContain("AND (c.embed_claimed_until IS NULL OR c.embed_claimed_until < now())");
    expect(fn).toContain("ORDER BY c.embed_attempts, c.document_id, c.page, c.seq, c.id");
    expect(body).toContain("REVOKE ALL ON FUNCTION embed_claim_batch(UUID, UUID, INTEGER, INTEGER, INTEGER) FROM public, anon, authenticated;");
    expect(body).toContain("GRANT EXECUTE ON FUNCTION embed_claim_batch(UUID, UUID, INTEGER, INTEGER, INTEGER) TO service_role;");
    // the app asks for the same limit the SQL skips at
    expect(repo("lib/knowledgeEmbedCore.ts")).toContain("p_lease_seconds: LEASE_SECONDS, p_max_attempts: EMBED_MAX_ATTEMPTS,");
  });
  it("the columns are additive (fast default), and no function here is SECURITY DEFINER", () => {
    expect(body).toContain("ALTER TABLE knowledge_chunks ADD COLUMN IF NOT EXISTS embed_attempts INTEGER NOT NULL DEFAULT 0;");
    expect(body).toContain("ALTER TABLE knowledge_chunks ADD COLUMN IF NOT EXISTS embed_error TEXT;");
    expect(body).toContain("ALTER TABLE knowledge_chunks ADD COLUMN IF NOT EXISTS embed_claimed_until TIMESTAMPTZ;");
    expect(body).not.toMatch(/SECURITY DEFINER/);
    expect(body).not.toMatch(/\bUPDATE knowledge_chunks SET embedding\b|DELETE FROM/);
  });
  it("census: 20261121 is the last definer of semantic_search, semantic_coverage, semantic_coverage_detail and embed_claim_batch", () => {
    const files = readdirSync(join(process.cwd(), "supabase", "migrations")).filter((f) => /^\d{8}.*\.sql$/.test(f)).sort();
    const last = (re: RegExp) => files.filter((f) => re.test(strip(mig(f)))).pop();
    for (const name of ["semantic_search", "semantic_coverage", "semantic_coverage_detail", "embed_claim_batch"]) {
      expect(last(new RegExp(`CREATE (OR REPLACE )?FUNCTION ${name}\\(`))).toBe(FILE);
    }
  });
});
