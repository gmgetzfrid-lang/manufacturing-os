// intelligence Round G (I-02) — the meaning index's build and drain.
//
//   * SEM-4 — one passage the provider refuses no longer pins a library: the
//     batch is split until the refused passage stands alone, it gets an
//     attempt and its reason, gives its lease back and waits to be offered
//     again, the rest embed; after EMBED_MAX_ATTEMPTS the queue skips it. A
//     passage refused alone is blamed only once the provider is known to
//     accept the request (a sibling embedded, or a one-line canary did), so
//     two bad passages that make up a whole batch, or a bad document longer
//     than a batch, still reach the limit and the library still completes. A
//     refusal of the KEY, or of the request itself (the canary refused too),
//     blames no passage. Every vector paid for is written even when one
//     write fails. A library whose last passages were refused says so
//     ("retrying"), never "busy".
//   * SEM-7 — the queue is a claim: two slices running at once take disjoint
//     passages (the reproduction shows the unclaimed queue paying twice).
//   * SEM-11 — every marked library is read and worked least-recently-drained
//     first; cap / error / conflict / agreement holds carry a date instead of
//     a slot; repeated failure releases; outcomes name what happened,
//     including "starved".
//   * SEM-8 — a standing consent survives 100% and keeps the index current;
//     the drain's stamp writes touch the embedBuild key alone and only the
//     stamp it read, so a Library AI save or a consent recorded mid-run is
//     never reverted or cleared.
//   * SEM-11 / DEC-59 (5) — a count the drain could not read is unknown,
//     never 0: nothing is released or completed on a failed read; a consent
//     withdrawn or replaced mid-run (another member's Rebuild) stops the run
//     before the next batch.
//   * SEM-1 — the claim hands out nothing while the library holds another
//     model's vectors.
//   * GOV-14 limb — a stamp naming no active member is released, never spent.
//   * SEM-1, AI settings' confirm (I-20 fix pass 4) — what the drain does to
//     each kind of build on a payer's key after a switch of embedding model or
//     the loss of the key, which buildFates (lib/embedKeyOverview.ts) says
//     word for word: a run under way finishes on what it read; a build with
//     passages left is held (switch) or released (loss) by the next run; a
//     "keep current" on a library already fully embedded is left as it is
//     until new passages arrive. Fix pass 5: the hold lasts at least an hour
//     and is looked at again by the next background run (the nightly
//     maintenance run or a library page-load nudge — the drain has no
//     schedule of its own, so not "every hour"); a run takes nothing, and
//     holds nothing, while every passage left is leased or waiting; an
//     unsigned agreement is held first; setting the model back ends a
//     single-model library's hold, never a mixed library's.
//   * 20261121 — the paste contract, byte fidelity against 20261014 / 20261007,
//     and the census. (The SQL itself was run against a scratch PostgreSQL 16:
//     see the finding records.)
//
// The claim / detail RPCs below are transcriptions of 20261121's SQL, pinned
// to it by the shape tests at the bottom.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { freshAdminState, installMarkerRpc, type FakeAdminState, type Row } from "./helpers/knowledgeFakeAdmin";

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
import { EMBED_MAX_ATTEMPTS, EMBEDDING_DIMENSIONS, EMBEDDING_PROVIDERS } from "@/lib/ai/embeddings";
import { buildFates } from "@/lib/embedKeyOverview";
// The CURRENT agreement version (GOV-6 bumped it; a pinned literal would go stale).
import { AGREEMENT_VERSION } from "@/lib/ai/pricing";

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
    // Nothing while the library holds a vector under another model.
    if (a.p_model != null && (state.tables.knowledge_chunks ?? []).some((c) =>
      c.library_id === a.p_library_id && c.embedding != null && c.embedding_model !== a.p_model)) {
      return { data: [], error: null };
    }
    const picked = (state.tables.knowledge_chunks ?? [])
      .filter((c) => c.org_id === a.p_org_id && c.library_id === a.p_library_id && c.embedding == null && retrievable(c)
        && Number(c.embed_attempts ?? 0) < Number(a.p_max_attempts)
        && (!c.embed_claimed_until || Date.parse(String(c.embed_claimed_until)) < now)
        && (!c.embed_retry_after || Date.parse(String(c.embed_retry_after)) < now))
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
        leased: open.filter((c) => Number(c.embed_attempts ?? 0) < max && c.embed_claimed_until && Date.parse(String(c.embed_claimed_until)) > Date.now()).length,
        waiting: open.filter((c) => Number(c.embed_attempts ?? 0) < max && c.embed_retry_after && Date.parse(String(c.embed_retry_after)) > Date.now()).length,
        remaining_chars: open.filter((c) => Number(c.embed_attempts ?? 0) < max).reduce((n, c) => n + String(c.content).length, 0),
        total_chars: pop.reduce((n, c) => n + String(c.content).length, 0),
        models,
      }],
      error: null,
    };
  };
  installMarkerRpc(state);
}

const chunk = (i: number, over: Row = {}): Row => ({
  id: `c${String(i).padStart(4, "0")}`, org_id: ORG, library_id: LIB, document_id: DOC, page: i, seq: 0, section: null,
  content: `passage ${i}`, embedding: null, embedding_model: null, embed_attempts: 0, embed_error: null, embed_claimed_until: null, embed_retry_after: null, ...over,
});

// ── the provider ────────────────────────────────────────────────────────────
const provider = vi.hoisted(() => ({
  inputs: [] as string[], mode: "ok" as "ok" | "401" | "429" | "400-all",
  /** Runs while a provider call is in flight (a Rebuild, another driver). */
  during: null as null | (() => void),
}));
function stubProvider() {
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { input: string[] };
    provider.during?.();
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
  provider.during = null;
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
    // it gives its lease back (nobody is embedding it) and waits: nobody asks
    // the provider again for it this run
    expect(poison.embed_claimed_until).toBeNull();
    expect(Date.parse(String(poison.embed_retry_after))).toBeGreaterThan(Date.now() + 100_000);
    expect(String(poison.embed_error)).toMatch(/exceeds the model's context/);
    // a sibling embedded in the same batch, so the request was known good: no canary was spent
    expect(provider.inputs).not.toContain("Embedding check.");
    // every passage but the refused one carries a vector stamped with the model, lease cleared
    for (const c of chunks().filter((x) => x !== poison)) {
      expect(c.embedding).toBeTruthy();
      expect(c).toMatchObject({ embedding_model: "voyage-3.5-lite", embed_claimed_until: null });
    }
  });
  it(`after ${EMBED_MAX_ATTEMPTS} refusals the queue skips the passage; the library reports it failed and is otherwise done`, async () => {
    admin.state.tables.knowledge_chunks = [chunk(1, { content: "POISON" }), chunk(2)];
    for (let run = 0; run < EMBED_MAX_ATTEMPTS; run++) {
      provider.inputs = [];
      await slice();
      expect(chunks()[0].embed_attempts).toBe(run + 1);              // one attempt per run, never a tight loop
      // run 1: its sibling (refused first, embedded after) proves the request good — no canary;
      // later runs: it stands alone, so one canary decides
      expect(provider.inputs.filter((t) => t === "Embedding check.")).toHaveLength(run === 0 ? 0 : 1);
      chunks()[0].embed_retry_after = "2000-01-01T00:00:00Z";        // the wait runs out between runs
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
  it("a batch the provider refuses whole AND a one-line canary refused too is the request, not the passages — nobody is blamed", async () => {
    provider.mode = "400-all";
    admin.state.tables.knowledge_chunks = Array.from({ length: 8 }, (_, i) => chunk(i + 1));
    const out = await slice();
    expect(out.error).toMatch(/input_type is not supported/);
    expect(out.error).toMatch(/refused a one-line test request as well/);
    expect(out.refused).toBe(0);
    expect(chunks().every((c) => c.embed_attempts === 0 && c.embed_claimed_until === null && c.embed_retry_after === null)).toBe(true);
  });
  const poisonSeen = () => chunks().filter((c) => String(c.content).includes("POISON"));
  const expireWaits = () => { for (const c of chunks()) if (c.embed_retry_after) c.embed_retry_after = "2000-01-01T00:00:00Z"; };
  it("two refused passages that make up a WHOLE batch are still charged (a canary proves the request good): both reach the limit and the library completes around them", async () => {
    admin.state.tables.knowledge_chunks = [chunk(1, { content: "POISON a" }), chunk(2), chunk(3, { content: "POISON b" }), chunk(4)];
    // run 1: the good passages embed beside them
    await slice();
    expect(poisonSeen().map((c) => c.embed_attempts)).toEqual([1, 1]);
    // from run 2 on the batch is JUST the two refused passages
    for (let run = 2; run <= EMBED_MAX_ATTEMPTS; run++) {
      expireWaits();
      provider.inputs = [];
      const out = await slice();
      expect(out.error).toBeNull();
      expect(out.refused).toBe(2);
      expect(provider.inputs).toEqual(["Embedding check."]);          // the canary, once — then each is blamed
      expect(poisonSeen().map((c) => c.embed_attempts)).toEqual([run, run]);
    }
    expireWaits();
    expect(await slice()).toMatchObject({ embedded: 0, refused: 0, error: null });
    expect(await loadEmbedDetail(ORG, LIB)).toMatchObject({ total: 4, embedded: 2, remaining: 0, failed: 2, leased: 0, waiting: 0 });
  });
  it("the drain over the same two: never an error run, the standing consent is never released, and the library ends 'current' with failed = 2", async () => {
    seedDrainWorld();
    admin.state.tables.knowledge_libraries = [marked(LIB, { userId: PAYER, at: "2026-09-01T00:00:00Z", standing: true })];
    admin.state.tables.knowledge_chunks = [chunk(1, { content: "POISON a" }), chunk(2), chunk(3, { content: "POISON b" })];
    const outcomes: string[] = [];
    for (let run = 0; run < MAX_ERROR_RUNS + 1; run++) {
      expireWaits();
      (admin.state.tables.knowledge_libraries[0].ai_features as { embedBuild: Row }).embedBuild.lastDrainAt = "2000-01-01T00:00:00Z";
      const out = await drainEmbedBacklog({ scopeOrgIds: null, budgetMs: 200_000 });
      outcomes.push(out.drained[0].outcome);
    }
    expect(outcomes).not.toContain("blocked");
    expect(outcomes).not.toContain("released");
    expect(outcomes.at(-1)).toBe("current");
    const m = parseEmbedBuildMarker((admin.state.tables.knowledge_libraries[0].ai_features as Row).embedBuild)!;
    expect(m).toMatchObject({ userId: PAYER, standing: true });
    expect(m.errorRuns ?? 0).toBe(0);
    expect(poisonSeen().every((c) => c.embed_attempts === EMBED_MAX_ATTEMPTS)).toBe(true);
    expect(await loadEmbedDetail(ORG, LIB)).toMatchObject({ remaining: 0, failed: 2 });
  });
  it("a refused document LONGER than one batch (the claim orders it first): every passage reaches the limit, the rest of the library embeds", async () => {
    const BAD = "0e000000-0000-4000-8000-000000000000";                // sorts before DOC
    admin.state.tables.knowledge_documents.push({ id: BAD, org_id: ORG, library_id: LIB, name: "Scanned tables", status: "ready" });
    admin.state.tables.knowledge_chunks = [
      ...Array.from({ length: 70 }, (_, i) => chunk(100 + i, { document_id: BAD, content: `POISON row ${i}` })),
      ...Array.from({ length: 10 }, (_, i) => chunk(i + 1)),
    ];
    for (let run = 1; run <= EMBED_MAX_ATTEMPTS; run++) {
      expireWaits();
      const out = await slice();
      expect(out.error).toBeNull();
      expect(poisonSeen().every((c) => c.embed_attempts === run)).toBe(true);
    }
    expireWaits();
    await slice();
    expect(await loadEmbedDetail(ORG, LIB)).toMatchObject({ total: 80, embedded: 10, remaining: 0, failed: 70 });
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
  it("the write-back is conditional (a passage another driver already embedded is not counted twice) and held to this slice's lease", () => {
    const core = repo("lib/knowledgeEmbedCore.ts");
    expect(core).toContain('return queue === "claim" ? heldBy(q.is("embedding", null), c).select("id") : q;');
    expect(core).toContain('if (queue === "claim") embedded += Array.isArray(r.data) ? r.data.length : 0;');
    expect(core).toContain('(c.embed_claimed_until ? q.eq("embed_claimed_until", c.embed_claimed_until) : q.not("embed_claimed_until", "is", null));');
    // the refusal and the give-back are held to it too
    expect(core).toContain('const { data, error } = await heldBy(supabaseAdmin.from("knowledge_chunks")');
    expect(core).toContain('await (lease ? q.eq("embed_claimed_until", lease) : q.not("embed_claimed_until", "is", null))');
  });
  it("the claim returns its lease instant, and the slice carries it", async () => {
    admin.state.tables.knowledge_chunks = [chunk(1)];
    const writes: unknown[][] = [];
    const out = await slice();
    for (const c of admin.state.calls) if (c.table === "knowledge_chunks" && c.method === "eq" && c.args[0] === "embed_claimed_until") writes.push(c.args);
    expect(out.embedded).toBe(1);
    expect(writes).toHaveLength(1);
    expect(typeof writes[0][1]).toBe("string");                        // the instant the claim set
  });
  it("reproduction → fix: a Rebuild that clears every vector and lease while a batch is in flight — the batch's old-model vectors are NOT written into the rebuilt library", async () => {
    admin.state.tables.knowledge_chunks = Array.from({ length: 5 }, (_, i) => chunk(i + 1));
    // The reset, exactly as /api/knowledge/embed "reset" writes it — which
    // also ended the payer's consent, so the drain's per-batch re-read stops
    // it before another batch (beforeBatch); the batch already in flight is
    // what this is about.
    let reset = false;
    provider.during = () => {
      for (const c of chunks()) Object.assign(c, { embedding: null, embedding_model: null, embed_attempts: 0, embed_error: null, embed_claimed_until: null, embed_retry_after: null });
      reset = true;
      provider.during = null;
    };
    const out = await slice({ batchSize: 5, beforeBatch: async () => (reset ? "the consent was withdrawn" : null) });
    expect(provider.inputs.length).toBe(5);                              // paid for (the call was already out)
    expect(out.embedded).toBe(0);                                        // …but nothing landed
    expect(chunks().every((c) => c.embedding === null && c.embedding_model === null)).toBe(true);
    // the rebuilder's first build on ANOTHER model then claims every passage (no conflict)
    const rebuilt = await slice({ connection: { ...CONN, model: "the-rebuild-model" } });
    expect(rebuilt.embedded).toBe(5);
    expect(chunks().every((c) => c.embedding_model === "the-rebuild-model")).toBe(true);
  });
  it("a newer claim by another driver (after this slice's lease lapsed) voids this slice's write: the passage is the new holder's", async () => {
    admin.state.tables.knowledge_chunks = [chunk(1)];
    const theirs = new Date(Date.now() + 90_000).toISOString();
    provider.during = () => { chunks()[0].embed_claimed_until = theirs; provider.during = null; };
    const out = await slice();
    expect(out.embedded).toBe(0);
    expect(chunks()[0]).toMatchObject({ embedding: null, embed_claimed_until: theirs });   // their lease stands
  });
  it("a refusal recorded after a Rebuild cleared the lease charges nobody", async () => {
    admin.state.tables.knowledge_chunks = [chunk(1, { content: "POISON" }), chunk(2)];
    let calls = 0;
    let reset = false;
    provider.during = () => {
      // the split's calls: whole batch refused, then [POISON] refused, then [2] embedded —
      // the Rebuild lands before the refusal is recorded
      if (++calls === 3) {
        for (const c of chunks()) Object.assign(c, { embed_claimed_until: null, embedding: null, embedding_model: null });
        reset = true;
      }
    };
    const out = await slice({ beforeBatch: async () => (reset ? "the consent was withdrawn" : null) });
    expect(out.refused).toBe(0);
    expect(chunks().find((c) => c.id === "c0001")).toMatchObject({ embed_attempts: 0, embed_error: null });
  });
});

// ── SEM-11 / SEM-8 / GOV-14 — the drain ─────────────────────────────────────
const marked = (id: string, marker: Row, org = ORG): Row => ({ id, org_id: org, ai_features: { embedBuild: marker } });
const LIBS = Array.from({ length: 8 }, (_, i) => `0b000000-0000-4000-8000-0000000000${String(i + 10)}`);

function seedDrainWorld() {
  admin.state.tables.org_members = [{ org_id: ORG, uid: PAYER, status: "active" }];
  admin.state.tables.ai_connections = [{ org_id: ORG, user_id: PAYER, provider: "anthropic", api_key: "x", embedding_provider: "voyage", embedding_model: "voyage-3.5-lite", embedding_api_key: "pa-x" }];
  admin.state.tables.ai_key_agreements = [{ org_id: ORG, user_id: PAYER, scope: "use", agreement_version: AGREEMENT_VERSION }];
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
  it("SEM-4: the last passage refused once (it waits to be offered again) → 'retrying' with the reason, never 'busy'; nothing spent", async () => {
    seedDrainWorld();
    admin.state.tables.knowledge_libraries = [marked(LIB, { userId: PAYER, at: "2026-09-01T00:00:00Z" })];
    admin.state.tables.knowledge_chunks = [
      chunk(1, { embedding: "[0]", embedding_model: "voyage-3.5-lite" }),
      chunk(2, { content: "POISON", embed_attempts: 1, embed_error: "input exceeds the model's context", embed_retry_after: new Date(Date.now() + 90_000).toISOString() }),
    ];
    expect(await loadEmbedDetail(ORG, LIB)).toMatchObject({ remaining: 1, leased: 0, waiting: 1 });
    const out = await drainEmbedBacklog({ scopeOrgIds: null, budgetMs: 200_000 });
    expect(out.drained[0]).toMatchObject({ outcome: "retrying", remaining: 1 });
    expect(out.drained[0].note).toMatch(/1 passage was refused by the embeddings provider and waits to be tried again by the next run/);
    expect(out.drained[0].note).not.toMatch(/another run/);
    expect(provider.inputs).toHaveLength(0);
    // the stamp stays for the next run
    expect(parseEmbedBuildMarker((admin.state.tables.knowledge_libraries[0].ai_features as Row).embedBuild)).toMatchObject({ userId: PAYER });
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

describe("GOV-14 limb — a failed membership read never releases a consent", () => {
  it("the read errors: nothing is spent, the stamp stays, the run says why", async () => {
    seedDrainWorld();
    admin.state.tables.knowledge_libraries = [marked(LIB, { userId: PAYER, at: "2026-09-01T00:00:00Z" })];
    admin.state.tables.knowledge_chunks = [chunk(1)];
    admin.state.failReads.org_members = { message: "timeout" };
    const out = await drainEmbedBacklog({ scopeOrgIds: null, budgetMs: 200_000 });
    expect(out.drained[0]).toMatchObject({ outcome: "blocked", note: "couldn't verify the build's consent: timeout" });
    expect((admin.state.tables.knowledge_libraries[0].ai_features as Row).embedBuild).toBeTruthy();
    expect(provider.inputs).toHaveLength(0);
  });
});

describe("DEC-59 (5) — a count the drain could not read is unknown, never 0", () => {
  it("reproduction of the old `count ?? 0`: both coverage reads fail BEFORE the run → nothing spent, the plain stamp stays, the run says why (it used to clear the stamp as 'complete')", async () => {
    seedDrainWorld();
    admin.state.tables.knowledge_libraries = [marked(LIB, { userId: PAYER, at: "2026-09-01T00:00:00Z" })];
    admin.state.tables.knowledge_chunks = [chunk(1), chunk(2)];
    admin.state.rpc.semantic_coverage_detail = () => ({ data: null, error: { message: "canceling statement due to statement timeout" } });
    admin.state.failReads.knowledge_chunks = { message: "canceling statement due to statement timeout" };
    const out = await drainEmbedBacklog({ scopeOrgIds: null, budgetMs: 200_000 });
    expect(out.drained[0]).toMatchObject({ outcome: "blocked", note: "couldn't read the library's coverage — nothing spent, the stamp stays" });
    expect((admin.state.tables.knowledge_libraries[0].ai_features as { embedBuild: Row }).embedBuild).toMatchObject({ userId: PAYER });
    expect(provider.inputs).toHaveLength(0);
  });
  it("both reads fail AFTER a successful slice → the stamp stays (blocked), never cleared as 'complete' on a guess", async () => {
    seedDrainWorld();
    admin.state.tables.knowledge_libraries = [marked(LIB, { userId: PAYER, at: "2026-09-01T00:00:00Z" })];
    admin.state.tables.knowledge_chunks = [chunk(1), chunk(2)];
    const real = admin.state.rpc.semantic_coverage_detail;
    let n = 0;
    admin.state.rpc.semantic_coverage_detail = (a) => {
      if (++n === 1) return real(a);
      admin.state.failReads.knowledge_chunks = { message: "timeout" };
      return { data: null, error: { message: "timeout" } };
    };
    const out = await drainEmbedBacklog({ scopeOrgIds: null, budgetMs: 200_000 });
    expect(out.drained[0]).toMatchObject({ outcome: "blocked", embedded: 2, note: "couldn't read the library's coverage after the run — the stamp stays" });
    expect((admin.state.tables.knowledge_libraries[0].ai_features as { embedBuild: Row }).embedBuild).toBeTruthy();
  });
  it("unembeddedCount answers null (not 0) when neither read succeeds", async () => {
    const { unembeddedCount } = await import("@/lib/knowledgeEmbedCore");
    admin.state.tables.knowledge_chunks = [chunk(1)];
    expect(await unembeddedCount(ORG, LIB)).toBe(1);
    admin.state.rpc.semantic_coverage_detail = () => ({ data: null, error: { message: "timeout" } });
    expect(await unembeddedCount(ORG, LIB)).toBe(1);                    // the plain count still answers
    admin.state.failReads.knowledge_chunks = { message: "timeout" };
    expect(await unembeddedCount(ORG, LIB)).toBeNull();
  });
});

describe("SEM-8 / SEM-11 — the consent is re-read before every batch", () => {
  const withProviderHook = (hook: (call: number) => void) => {
    const inner = fetch;
    let call = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      const res = await (inner as unknown as (u: string, i: RequestInit) => Promise<unknown>)(url, init);
      hook(++call);
      return res;
    }));
  };
  it("another member's Rebuild clears the payer's stamp mid-run: the drain stops before its next batch — nothing more on the payer's key", async () => {
    seedDrainWorld();
    admin.state.tables.knowledge_libraries = [marked(LIB, { userId: PAYER, at: "2026-09-01T00:00:00Z", standing: true })];
    admin.state.tables.knowledge_chunks = Array.from({ length: 100 }, (_, i) => chunk(i + 1));
    // the reset lands while the first batch is at the provider
    withProviderHook((call) => { if (call === 1) delete (admin.state.tables.knowledge_libraries[0].ai_features as Row).embedBuild; });
    const out = await drainEmbedBacklog({ scopeOrgIds: null, budgetMs: 200_000 });
    expect(provider.inputs).toHaveLength(64);                              // the batch in flight, and no other
    expect(out.drained[0]).toMatchObject({ outcome: "released", embedded: 64 });
    expect(out.drained[0].note).toBe("the build's consent was withdrawn or replaced during this run — stopped; nothing more is spent on it");
    expect((admin.state.tables.knowledge_libraries[0].ai_features as Row).embedBuild).toBeUndefined();   // the drain re-creates nothing
  });
  it("a stamp replaced by another member's consent mid-run: the run stops and leaves the new stamp exactly as recorded", async () => {
    seedDrainWorld();
    const B = "0d000000-0000-4000-8000-0000000000bb";
    admin.state.tables.knowledge_libraries = [marked(LIB, { userId: PAYER, at: "2026-09-01T00:00:00Z" })];
    admin.state.tables.knowledge_chunks = Array.from({ length: 100 }, (_, i) => chunk(i + 1));
    withProviderHook((call) => {
      if (call === 1) (admin.state.tables.knowledge_libraries[0].ai_features as Row).embedBuild = { userId: B, at: "2026-09-30T12:00:00Z" };
    });
    const out = await drainEmbedBacklog({ scopeOrgIds: null, budgetMs: 200_000 });
    expect(out.drained[0].outcome).toBe("released");
    expect(provider.inputs).toHaveLength(64);
    expect((admin.state.tables.knowledge_libraries[0].ai_features as Row).embedBuild).toEqual({ userId: B, at: "2026-09-30T12:00:00Z" });
  });
  it("a consent the payer renewed mid-run (a new instant) is not cleared at 100% — every stamp write is conditional on the stamp the run read", async () => {
    seedDrainWorld();
    admin.state.tables.knowledge_libraries = [marked(LIB, { userId: PAYER, at: "2026-09-01T00:00:00Z" })];
    admin.state.tables.knowledge_chunks = [chunk(1), chunk(2)];
    withProviderHook((call) => {
      if (call === 1) (admin.state.tables.knowledge_libraries[0].ai_features as Row).embedBuild = { userId: PAYER, at: "2026-09-30T12:00:00Z", standing: true };
    });
    const out = await drainEmbedBacklog({ scopeOrgIds: null, budgetMs: 200_000 });
    expect(out.drained[0].outcome).toBe("complete");
    expect((admin.state.tables.knowledge_libraries[0].ai_features as Row).embedBuild).toEqual({ userId: PAYER, at: "2026-09-30T12:00:00Z", standing: true });
  });
  it("the drain never writes the whole ai_features blob: a Library AI toggle saved mid-run survives, and every stamp write names the stamp it read", async () => {
    seedDrainWorld();
    admin.state.tables.knowledge_libraries = [{ id: LIB, org_id: ORG, ai_features: { visionAllPages: false, embedBuild: { userId: PAYER, at: "2026-09-01T00:00:00Z", standing: true } } }];
    admin.state.tables.knowledge_chunks = [chunk(1), chunk(2)];
    withProviderHook((call) => {
      if (call !== 1) return;
      // knowledge_library_save_ai_features: every toggle replaced, the stamp kept
      const lib = admin.state.tables.knowledge_libraries[0];
      lib.ai_features = { visionAllPages: true, embedBuild: (lib.ai_features as Row).embedBuild };
    });
    const out = await drainEmbedBacklog({ scopeOrgIds: null, budgetMs: 200_000 });
    expect(out.drained[0].outcome).toBe("current");
    const feats = admin.state.tables.knowledge_libraries[0].ai_features as Row;
    expect(feats.visionAllPages).toBe(true);
    expect(feats.embedBuild).toMatchObject({ userId: PAYER, standing: true, completedAt: expect.any(String) });
    expect(admin.state.calls.filter((c) => c.table === "knowledge_libraries" && c.method === "update")).toEqual([]);
    const writes = admin.state.calls.filter((c) => c.table === "rpc:embed_build_marker_write").map((c) => c.args[0] as Row);
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.every((w) => w.p_expect_user === PAYER && w.p_expect_at === "2026-09-01T00:00:00Z")).toBe(true);
  });
});

describe("SEM-1 — the claim hands out nothing while another model is in the library", () => {
  it("a driver on another model embeds nothing and spends nothing; the claim is asked with the driver's model", async () => {
    admin.state.tables.knowledge_chunks = [chunk(1, { embedding: "[0]", embedding_model: "text-embedding-3-small" }), chunk(2), chunk(3)];
    const out = await slice();
    expect(out).toMatchObject({ embedded: 0, fetchedNone: true, error: null });
    expect(provider.inputs).toHaveLength(0);
    const claim = admin.state.calls.find((c) => c.table === "rpc:embed_claim_batch")!;
    expect(claim.args[0]).toMatchObject({ p_model: "voyage-3.5-lite" });
  });
  it("another model's vectors land mid-run (a rebuild on another key): the drain stops claiming and holds the library as a model conflict", async () => {
    seedDrainWorld();
    admin.state.tables.knowledge_libraries = [marked(LIB, { userId: PAYER, at: "2026-09-01T00:00:00Z" })];
    admin.state.tables.knowledge_chunks = Array.from({ length: 100 }, (_, i) => chunk(i + 1));
    const inner = fetch;
    let call = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      const res = await (inner as unknown as (u: string, i: RequestInit) => Promise<unknown>)(url, init);
      if (++call === 1) admin.state.tables.knowledge_chunks.push(chunk(900, { embedding: "[0]", embedding_model: "text-embedding-3-small" }));
      return res;
    }));
    const out = await drainEmbedBacklog({ scopeOrgIds: null, budgetMs: 200_000 });
    expect(provider.inputs).toHaveLength(64);
    expect(out.drained[0]).toMatchObject({ outcome: "blocked", embedded: 64 });
    expect(out.drained[0].note).toMatch(/already mixes/);
    expect(parseEmbedBuildMarker((admin.state.tables.knowledge_libraries[0].ai_features as Row).embedBuild)).toMatchObject({ blockedReason: "model_conflict" });
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

describe("SEM-1, AI settings' confirm (I-20 fix pass 4) — what the drain does to each kind of build after a switch or a loss, as the confirm says", () => {
  // The payer's saved model, and another of the same provider's — both from
  // the catalogue, never spelled out here.
  const saved = () => String(admin.state.tables.ai_connections[0].embedding_model);
  const another = () => EMBEDDING_PROVIDERS.find((p) => p.id === "voyage")!.models.find((m) => m !== saved())!;
  const switchModel = () => { admin.state.tables.ai_connections[0].embedding_model = another(); };
  const loseKey = () => { admin.state.tables.ai_connections = []; };
  const stamp = () => parseEmbedBuildMarker((admin.state.tables.knowledge_libraries[0].ai_features as Row).embedBuild);
  const embeddedChunk = (i: number) => chunk(i, { embedding: "[0]", embedding_model: saved() });
  const afterProviderCall = (n: number, act: () => void) => {
    const inner = fetch;
    let call = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      const res = await (inner as unknown as (u: string, i: RequestInit) => Promise<unknown>)(url, init);
      if (++call === n) act();
      return res;
    }));
  };
  const rearm = () => { (admin.state.tables.knowledge_libraries[0].ai_features as { embedBuild: Row }).embedBuild.lastDrainAt = "2000-01-01T00:00:00Z"; };

  it("the confirm's three cases are the ones below, for a switch and for a loss", () => {
    const sw = buildFates("switch", "the-new-model");
    expect(sw.running).toMatch(/finishes that run with the setting it read when it reached the library/);
    expect(sw.embedding).toMatch(/passages still to embed — a build you started, or one kept current — is held by the next background run that finds a passage there it can take: for a model conflict, or first for the AI agreement if you have not accepted the current one\. \(A run takes none while every passage left is being embedded by another run or waits to be retried, nor while an earlier hold is still in force\.\) Such a hold lasts at least an hour; after that the next background run — the nightly one, or one started when a member opens a library in this workspace — looks at it again\. The model conflict ends once the library is rebuilt with the-new-model, or once you set your embedding model back to the one the library was built with; a library that already mixes two models stays held until it is rebuilt\./);
    expect(sw.embedding).not.toMatch(/every hour|hourly/);
    expect(sw.embedded).toMatch(/already fully embedded is left as it is: a build you started there is cleared as finished, and a “keep current” consent stays .* until new documents give it passages to embed — it is then held as above/);
    const loss = buildFates("loss");
    expect(loss.running).toMatch(/finishes that run on the key it read when it reached the library/);
    expect(loss.embedding).toMatch(/is ended \(its consent released\) by the next background run that finds a passage there it can take\. \(A run takes none while every passage left is being embedded by another run or waits to be retried, nor while an earlier hold is still in force\.\)/);
    expect(loss.embedded).toMatch(/“keep current” consent stays .* until new documents give it passages to embed — it is then ended as above/);
  });

  it("running: a run already working on a library when the key is removed, or the model switched, finishes that run on what it read — every passage, one model", async () => {
    for (const change of [loseKey, switchModel]) {
      Object.assign(admin.state, freshAdminState()); installRpcs(admin.state); provider.inputs = []; stubProvider();
      admin.state.tables.knowledge_documents = [{ id: DOC, org_id: ORG, library_id: LIB, name: "EP-5-6-2 Pipe supports", status: "ready" }];
      seedDrainWorld();
      const model = saved();
      admin.state.tables.knowledge_libraries = [marked(LIB, { userId: PAYER, at: "2026-09-01T00:00:00Z" })];
      admin.state.tables.knowledge_chunks = Array.from({ length: 100 }, (_, i) => chunk(i + 1));
      afterProviderCall(1, change);                                        // lands while the first batch is at the provider
      const out = await drainEmbedBacklog({ scopeOrgIds: null, budgetMs: 200_000 });
      expect(provider.inputs).toHaveLength(100);
      expect(out.drained[0]).toMatchObject({ outcome: "complete", embedded: 100 });
      expect(chunks().every((c) => c.embedding_model === model)).toBe(true);
    }
  });

  it("embedding (switch): a build with passages left — kept current or one the payer started — is held for a model conflict by the next run, its consent kept, nothing embedded", async () => {
    for (const standing of [true, false]) {
      seedDrainWorld();
      admin.state.tables.knowledge_libraries = [marked(LIB, { userId: PAYER, at: "2026-09-01T00:00:00Z", ...(standing ? { standing: true } : {}) })];
      admin.state.tables.knowledge_chunks = [embeddedChunk(1), chunk(2)];
      switchModel();
      provider.inputs = [];
      const out = await drainEmbedBacklog({ scopeOrgIds: null, budgetMs: 200_000 });
      expect(out.drained[0].outcome).toBe("blocked");
      expect(stamp()).toMatchObject({ userId: PAYER, standing, blockedReason: "model_conflict" });
      expect(Date.parse(stamp()!.blockedUntil!) - Date.now()).toBeGreaterThan(59 * 60_000);   // looked at again in an hour
      expect(provider.inputs).toHaveLength(0);
    }
  });

  it("embedding (loss): a build with passages left — kept current or one the payer started — is ended by the next run (its consent released)", async () => {
    for (const standing of [true, false]) {
      seedDrainWorld();
      admin.state.tables.knowledge_libraries = [marked(LIB, { userId: PAYER, at: "2026-09-01T00:00:00Z", ...(standing ? { standing: true } : {}) })];
      admin.state.tables.knowledge_chunks = [embeddedChunk(1), chunk(2)];
      loseKey();
      const out = await drainEmbedBacklog({ scopeOrgIds: null, budgetMs: 200_000 });
      expect(out.drained[0]).toMatchObject({ outcome: "released", note: "no embedding key — stamp cleared" });
      expect(stamp()).toBeNull();
    }
  });

  it("reproduction of the old wording's error: a 'keep current' on a library already fully embedded is neither held nor ended by the next run — it stays, as the confirm now says — and the run after new passages arrive holds it (switch) or ends it (loss)", async () => {
    for (const [change, then] of [[switchModel, "blocked"], [loseKey, "released"]] as const) {
      seedDrainWorld();
      admin.state.tables.knowledge_libraries = [marked(LIB, { userId: PAYER, at: "2026-09-01T00:00:00Z", standing: true })];
      admin.state.tables.knowledge_chunks = [embeddedChunk(1), embeddedChunk(2)];
      change();
      const first = await drainEmbedBacklog({ scopeOrgIds: null, budgetMs: 200_000 });
      // the old confirm: "the next background run releases them" / "held for a model conflict"
      expect(first.drained[0].outcome).toBe("current");
      expect(stamp()).toMatchObject({ userId: PAYER, standing: true });
      expect(stamp()!.blockedReason).toBeUndefined();
      // new documents give it passages to embed: the next run then holds or ends it
      admin.state.tables.knowledge_chunks.push(chunk(3));
      rearm();
      const next = await drainEmbedBacklog({ scopeOrgIds: null, budgetMs: 200_000 });
      expect(next.drained[0].outcome).toBe(then);
      if (then === "blocked") expect(stamp()).toMatchObject({ standing: true, blockedReason: "model_conflict" });
      else expect(stamp()).toBeNull();
    }
  });

  it("embedded (plain build): a build the payer started, on a library already fully embedded, is cleared as finished by the next run — after a switch or a loss alike", async () => {
    for (const change of [switchModel, loseKey]) {
      seedDrainWorld();
      admin.state.tables.knowledge_libraries = [marked(LIB, { userId: PAYER, at: "2026-09-01T00:00:00Z" })];
      admin.state.tables.knowledge_chunks = [embeddedChunk(1), embeddedChunk(2)];
      change();
      const out = await drainEmbedBacklog({ scopeOrgIds: null, budgetMs: 200_000 });
      expect(out.drained[0]).toMatchObject({ outcome: "complete" });
      expect(stamp()).toBeNull();
    }
  });

  // ── I-20 fix pass 5: the confirm's "embedding" case, word by word ─────────
  const keyReads = () => admin.state.calls.filter((c) => c.table === "ai_connections" && c.method === "select").length;
  const holdRunsOut = () => { (admin.state.tables.knowledge_libraries[0].ai_features as { embedBuild: Row }).embedBuild.blockedUntil = "2000-01-01T00:00:00Z"; };
  const run = () => drainEmbedBacklog({ scopeOrgIds: null, budgetMs: 200_000 });

  it("reproduction of the old wording's error (fix pass 5): a model-conflict hold is NOT looked at every hour — it lasts at least an hour, a run inside it skips the library without reading the key, and the first background run after it (the nightly maintenance run or a page-load nudge; the drain has no schedule of its own) looks again", async () => {
    // the drain runs from two places only: the daily maintenance cron and the library page-load nudge
    const crons = (JSON.parse(repo("vercel.json")) as { crons: Array<{ path: string; schedule: string }> }).crons;
    expect(crons.find((c) => c.path === "/api/cron/maintenance")?.schedule).toBe("0 3 * * *");
    expect(crons.some((c) => /embed/.test(c.path))).toBe(false);
    expect(repo("app/(protected)/knowledge/[id]/page.tsx")).toContain("m.nudgeEmbedDrain()");
    seedDrainWorld();
    admin.state.tables.knowledge_libraries = [marked(LIB, { userId: PAYER, at: "2026-09-01T00:00:00Z" })];
    admin.state.tables.knowledge_chunks = [embeddedChunk(1), chunk(2)];
    switchModel();
    await run();
    expect(stamp()).toMatchObject({ blockedReason: "model_conflict" });
    expect(Date.parse(stamp()!.blockedUntil!) - Date.now()).toBeGreaterThan(59 * 60_000);
    // a run while the hold is in force: skipped, no key read, nothing changed
    const reads = keyReads();
    const held = stamp();
    const within = await run();
    expect(within.drained[0]).toMatchObject({ outcome: "blocked" });
    expect(within.drained[0].note).toMatch(/^model_conflict until /);
    expect(keyReads()).toBe(reads);
    expect(stamp()).toEqual(held);
    // the hold runs out; the next run (whenever it comes) looks again — still switched, held again
    holdRunsOut();
    const after = await run();
    expect(keyReads()).toBe(reads + 1);
    expect(after.drained[0].outcome).toBe("blocked");
    expect(stamp()).toMatchObject({ blockedReason: "model_conflict" });
    expect(Date.parse(stamp()!.blockedUntil!)).toBeGreaterThan(Date.now() + 59 * 60_000);
  });

  it("reproduction of the old wording's error (fix pass 5): while every passage left is leased by another run, or waiting to be retried, a run takes none — busy / retrying, no hold written, no key read, nothing released — after a switch and after a loss", async () => {
    const future = new Date(Date.now() + 10 * 60_000).toISOString();
    for (const change of [switchModel, loseKey]) {
      for (const [left, outcome] of [[chunk(2, { embed_claimed_until: future }), "busy"], [chunk(2, { embed_attempts: 1, embed_retry_after: future }), "retrying"]] as const) {
        seedDrainWorld();
        admin.state.tables.knowledge_libraries = [marked(LIB, { userId: PAYER, at: "2026-09-01T00:00:00Z", standing: true })];
        admin.state.tables.knowledge_chunks = [embeddedChunk(1), { ...left }];
        change();
        const reads = keyReads();
        const out = await run();
        expect(out.drained[0].outcome).toBe(outcome);
        expect(keyReads()).toBe(reads);
        expect(stamp()).toMatchObject({ userId: PAYER, standing: true });
        expect(stamp()!.blockedReason).toBeUndefined();
      }
    }
  });

  it("fix pass 5: a payer who has not accepted the current AI agreement is held for that first — the model conflict is not reached until it is accepted", async () => {
    seedDrainWorld();
    admin.state.tables.ai_key_agreements = [];
    admin.state.tables.knowledge_libraries = [marked(LIB, { userId: PAYER, at: "2026-09-01T00:00:00Z" })];
    admin.state.tables.knowledge_chunks = [embeddedChunk(1), chunk(2)];
    switchModel();
    await run();
    expect(stamp()).toMatchObject({ blockedReason: "agreement" });
    expect(Date.parse(stamp()!.blockedUntil!) - Date.now()).toBeGreaterThan(59 * 60_000);
    seedDrainWorld();
    switchModel();
    holdRunsOut();
    await run();
    expect(stamp()).toMatchObject({ blockedReason: "model_conflict" });
    expect(provider.inputs).toHaveLength(0);
  });

  it("fix pass 5: setting the model back ends a single-model library's hold at the next look — a library that already mixes two models stays held whatever model is set; only a Rebuild ends it", async () => {
    seedDrainWorld();
    const model = saved();
    admin.state.tables.knowledge_libraries = [marked(LIB, { userId: PAYER, at: "2026-09-01T00:00:00Z" })];
    admin.state.tables.knowledge_chunks = [embeddedChunk(1), chunk(2)];
    switchModel();
    await run();
    expect(stamp()).toMatchObject({ blockedReason: "model_conflict" });
    admin.state.tables.ai_connections[0].embedding_model = model;      // set back
    holdRunsOut();
    const back = await run();
    expect(back.drained[0]).toMatchObject({ outcome: "complete", embedded: 1 });
    expect(chunks().every((c) => c.embedding_model === model)).toBe(true);
    // a mixed library: held under either of its models, or a third
    for (const m of [model, another(), EMBEDDING_PROVIDERS.find((p) => p.id === "voyage")!.models.find((x) => x !== model && x !== another()) ?? model]) {
      seedDrainWorld();
      admin.state.tables.knowledge_libraries = [marked(LIB, { userId: PAYER, at: "2026-09-01T00:00:00Z" })];
      admin.state.tables.knowledge_chunks = [embeddedChunk(1), chunk(2, { embedding: "[0]", embedding_model: another() }), chunk(3)];
      admin.state.tables.ai_connections[0].embedding_model = m;
      const out = await run();
      expect(out.drained[0].outcome).toBe("blocked");
      expect(stamp()).toMatchObject({ blockedReason: "model_conflict" });
      expect(out.drained[0].note).toMatch(/already mixes/);
    }
    expect(provider.inputs).toHaveLength(1);                            // only the set-back single-model library's passage
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
      "(CASE WHEN p_library_id IS NOT NULL THEN",
      "(SELECT COUNT(*) FROM knowledge_chunks e",
      "WHERE e.library_id = p_library_id",
      "AND e.embedding IS NOT NULL",
      "AND (p_model IS NULL OR e.embedding_model = p_model))",
      "ELSE",
      "(SELECT COUNT(*) FROM knowledge_chunks e",
      "WHERE e.org_id = p_org_id",
      "AND e.embedding IS NOT NULL",
      "AND (p_model IS NULL OR e.embedding_model = p_model))",
      "END)::BIGINT AS eligible",
      "AND NOT (p_library_id IS NOT NULL AND p_model IS NOT NULL AND EXISTS (",
      "SELECT 1 FROM knowledge_chunks o",
      "WHERE o.library_id = p_library_id AND o.embedding IS NOT NULL",
      "AND o.embedding_model IS DISTINCT FROM p_model))",
      "$body$",
    ]);
    // `eligible` for one library is counted by library_id ALONE (index-only
    // on knowledge_chunks_library_model_idx): no org_id predicate in that
    // branch, which no index on the model column carries (review minor)
    const lib = newFn.slice(newFn.indexOf("(CASE WHEN p_library_id IS NOT NULL THEN"), newFn.indexOf("ELSE", newFn.indexOf("(CASE WHEN p_library_id IS NOT NULL THEN")));
    expect(lib).not.toContain("org_id");
    expect(lib).toContain("WHERE e.library_id = p_library_id");
    expect(body).toContain("CREATE INDEX IF NOT EXISTS knowledge_chunks_library_model_idx\n  ON knowledge_chunks (library_id, embedding_model)\n  WHERE embedding IS NOT NULL;");
    // format() would read a % in the body as a placeholder: the only one is the SET clause's
    expect((newFn.match(/%/g) ?? []).length).toBe(1);
    // iterative scan only where pgvector knows it (0.8+), chosen from pg_extension
    expect(body).toContain("SELECT (m[1]::int, m[2]::int) >= (0, 8)");
    expect(body).toContain("CASE WHEN v_iterative THEN E'\\nSET hnsw.iterative_scan = strict_order' ELSE '' END");
    expect(body).toContain("DROP FUNCTION IF EXISTS semantic_search(UUID, UUID, vector, INT, TEXT);");
    expect(body).toContain("REVOKE ALL ON FUNCTION semantic_search(UUID, UUID, vector, INT, TEXT) FROM public, anon;");
    expect(body).toContain("GRANT EXECUTE ON FUNCTION semantic_search(UUID, UUID, vector, INT, TEXT) TO authenticated;");
  });
  it("the service role's EXECUTE is re-stated on every re-created read function (the ask route and the build call them as service_role), and the paste probes it", () => {
    for (const sig of ["semantic_search(UUID, UUID, vector, INT, TEXT)", "semantic_coverage_detail(UUID, UUID, INTEGER)", "semantic_coverage(UUID, UUID)"]) {
      expect(body).toContain(`GRANT EXECUTE ON FUNCTION ${sig} TO service_role;`);
    }
    expect(tail).toContain("AND has_function_privilege('service_role', 'semantic_search(uuid, uuid, vector, integer, text)', 'EXECUTE')");
    expect(tail).toContain("AND has_function_privilege('service_role', 'semantic_coverage_detail(uuid, uuid, integer)', 'EXECUTE')");
  });
  it("leased counts passages a driver holds; a refused passage gives its lease back and is counted as WAITING (never 'busy')", () => {
    const fn = body.slice(body.indexOf("CREATE OR REPLACE FUNCTION semantic_coverage_detail("), body.indexOf("REVOKE ALL ON FUNCTION semantic_coverage_detail"));
    expect(fn).toContain("COUNT(*) FILTER (WHERE NOT has_vec AND embed_attempts < p_max_attempts AND embed_claimed_until > now())::BIGINT,");
    expect(fn).toContain("COUNT(*) FILTER (WHERE NOT has_vec AND embed_attempts < p_max_attempts AND embed_retry_after > now())::BIGINT,");
    expect(fn).toContain("waiting         BIGINT,");
    expect(fn).toContain("c.embed_retry_after, octet_length(c.content) AS chars");
    // the return type changed: the old one is dropped first, grants re-stated after
    expect(body.indexOf("DROP FUNCTION IF EXISTS semantic_coverage_detail(UUID, UUID, INTEGER);")).toBeLessThan(body.indexOf("CREATE OR REPLACE FUNCTION semantic_coverage_detail("));
    expect(tail).toContain("AND prosrc LIKE '%embed_attempts < p_max_attempts AND embed_claimed_until > now()%'");
    expect(tail).toContain("AND prosrc LIKE '%embed_attempts < p_max_attempts AND embed_retry_after > now()%'");
    // the app gives the lease back and sets the wait when it records a refusal
    const core = repo("lib/knowledgeEmbedCore.ts");
    expect(core).toContain("embed_claimed_until: null,\n        embed_retry_after: new Date(Date.now() + REFUSAL_RETRY_SECONDS * 1000).toISOString(),");
    expect(core).toContain("waiting: Number(row.waiting ?? 0),");
  });
  it("coverage stays index-only: two covering indexes carry document_id (the column the retrievable-document filter reads), and the paste probes them", () => {
    expect(body).toContain("CREATE INDEX IF NOT EXISTS knowledge_chunks_org_lib_doc_idx\n  ON knowledge_chunks (org_id, library_id, document_id);");
    expect(body).toContain("CREATE INDEX IF NOT EXISTS knowledge_chunks_org_lib_doc_embedded_idx\n  ON knowledge_chunks (org_id, library_id, document_id)\n  WHERE embedding IS NOT NULL;");
    expect(body.indexOf("knowledge_chunks_org_lib_doc_idx")).toBeLessThan(body.indexOf("CREATE OR REPLACE FUNCTION semantic_coverage("));
    expect(tail).toContain("AND to_regclass('public.knowledge_chunks_org_lib_doc_idx') IS NOT NULL");
    expect(tail).toContain("AND to_regclass('public.knowledge_chunks_org_lib_doc_embedded_idx') IS NOT NULL");
    // what 20261011 indexed, for comparison: no document_id
    expect(strip(mig("20261011_semantic_coverage_fast.sql"))).toContain("ON knowledge_chunks (org_id, library_id)\n  WHERE embedding IS NOT NULL;");
  });
  it("the marker is written alone: embed_build_marker_write touches only the embedBuild key, conditionally; the toggles save keeps it", () => {
    const w = body.slice(body.indexOf("CREATE OR REPLACE FUNCTION embed_build_marker_write("), body.indexOf("REVOKE ALL ON FUNCTION embed_build_marker_write"));
    expect(w).toContain("LANGUAGE sql VOLATILE SECURITY INVOKER");
    expect(w).toContain("SET search_path = public");
    expect(w).toContain("WHEN p_patch THEN jsonb_set(l.ai_features, '{embedBuild}',");
    expect(w).toContain("((l.ai_features -> 'embedBuild') - p_drop) || COALESCE(p_marker, '{}'::jsonb))");
    expect(w).toContain("WHEN p_marker IS NULL THEN COALESCE(l.ai_features, '{}'::jsonb) - 'embedBuild'");
    expect(w).toContain("ELSE COALESCE(l.ai_features, '{}'::jsonb) || jsonb_build_object('embedBuild', p_marker)");
    expect(w).toContain("AND (NOT p_patch OR jsonb_typeof(l.ai_features -> 'embedBuild') = 'object')");
    // '' expects NO marker (COALESCE): a writer that read none never overwrites one recorded since
    expect(w).toContain("AND (p_expect_user IS NULL OR COALESCE(l.ai_features -> 'embedBuild' ->> 'userId', '') = p_expect_user)");
    expect(w).toContain("AND (p_expect_at IS NULL OR COALESCE(l.ai_features -> 'embedBuild' ->> 'at', '') = p_expect_at)");
    expect(tail).toContain("AND prosrc LIKE '%p_expect_user IS NULL OR COALESCE(%'");
    expect(body).toContain("REVOKE ALL ON FUNCTION embed_build_marker_write(UUID, JSONB, BOOLEAN, TEXT[], TEXT, TEXT) FROM public, anon, authenticated;");
    expect(body).toContain("GRANT EXECUTE ON FUNCTION embed_build_marker_write(UUID, JSONB, BOOLEAN, TEXT[], TEXT, TEXT) TO service_role;");
    const save = body.slice(body.indexOf("CREATE OR REPLACE FUNCTION knowledge_library_save_ai_features("), body.indexOf("REVOKE ALL ON FUNCTION knowledge_library_save_ai_features"));
    expect(save).toContain("LANGUAGE sql VOLATILE SECURITY INVOKER");
    expect(save).toContain("SET ai_features = (COALESCE(p_features, '{}'::jsonb) - 'embedBuild')");
    expect(save).toContain("|| CASE WHEN l.ai_features ? 'embedBuild'");
    expect(save).toContain("THEN jsonb_build_object('embedBuild', l.ai_features -> 'embedBuild')");
    expect(body).toContain("GRANT EXECUTE ON FUNCTION knowledge_library_save_ai_features(UUID, JSONB) TO authenticated;");
    // the app calls them with the SQL's own parameter names
    const core = repo("lib/knowledgeEmbedCore.ts");
    for (const p of ["p_library_id: libraryId,", "p_patch: isPatch,", "p_drop: isPatch ? change.drop : [],", "p_expect_user: expect?.userId ?? null,", "p_expect_at: expect?.at ?? null,"]) {
      expect(core).toContain(p);
    }
    expect(repo("lib/knowledge.ts")).toContain('supabase.rpc("knowledge_library_save_ai_features", { p_library_id: libraryId, p_features: toggles })');
  });
  it("DEC-30: the model-mismatch inventory is also emitted per library (aggregate counts, grouped by library_id)", () => {
    const inv = strip(m.slice(m.indexOf("CREATE TEMP TABLE"), m.indexOf("\nBEGIN;")));
    expect(inv).toContain("SELECT '  of those, in library ' || c.library_id::text, COUNT(*)");
    expect(inv).toContain("GROUP BY c.library_id");
  });
  it("the claim: SKIP LOCKED + lease, retrievable only, attempts under the limit, fewest attempts first, nothing while another model is in the library; service role only", () => {
    const fn = body.slice(body.indexOf("CREATE OR REPLACE FUNCTION embed_claim_batch("), body.indexOf("REVOKE ALL ON FUNCTION embed_claim_batch"));
    expect(fn).toContain("LANGUAGE sql VOLATILE SECURITY INVOKER");
    expect(fn).toContain("SET search_path = public");
    expect(fn).toContain("FOR UPDATE OF c SKIP LOCKED");
    expect(fn).toContain("AND d.status IN ('ready', 'indexing')");
    expect(fn).toContain("AND c.embed_attempts < p_max_attempts");
    expect(fn).toContain("AND (c.embed_claimed_until IS NULL OR c.embed_claimed_until < now())");
    expect(fn).toContain("AND (c.embed_retry_after IS NULL OR c.embed_retry_after < now())");
    expect(tail).toContain("AND prosrc LIKE '%c.embed_retry_after IS NULL OR c.embed_retry_after < now()%'");
    expect(fn).toContain("p_model         TEXT DEFAULT NULL");
    expect(fn).toContain("AND (p_model IS NULL OR NOT EXISTS (");
    expect(fn).toContain("AND o.embedding_model IS DISTINCT FROM p_model))");
    expect(fn).toContain("ORDER BY c.embed_attempts, c.document_id, c.page, c.seq, c.id");
    expect(body).toContain("DROP FUNCTION IF EXISTS embed_claim_batch(UUID, UUID, INTEGER, INTEGER, INTEGER);");
    // the claim returns its lease instant (every write is held to it); the
    // return type changed, so the 6-argument signature is dropped first too
    expect(fn).toContain("embed_claimed_until TIMESTAMPTZ\n)");
    expect(fn).toContain("k.embed_attempts, k.embed_claimed_until;");
    expect(body).toContain("DROP FUNCTION IF EXISTS embed_claim_batch(UUID, UUID, INTEGER, INTEGER, INTEGER, TEXT);");
    expect(body.lastIndexOf("DROP FUNCTION IF EXISTS embed_claim_batch(")).toBeLessThan(body.indexOf("CREATE OR REPLACE FUNCTION embed_claim_batch("));
    expect(tail).toContain("AND pg_get_function_result(oid) LIKE '%embed_claimed_until timestamp with time zone%'");
    expect(body).toContain("REVOKE ALL ON FUNCTION embed_claim_batch(UUID, UUID, INTEGER, INTEGER, INTEGER, TEXT) FROM public, anon, authenticated;");
    expect(body).toContain("GRANT EXECUTE ON FUNCTION embed_claim_batch(UUID, UUID, INTEGER, INTEGER, INTEGER, TEXT) TO service_role;");
    // the app asks for the same limit the SQL skips at, with the model it embeds with
    const core = repo("lib/knowledgeEmbedCore.ts");
    expect(core).toContain("p_lease_seconds: LEASE_SECONDS, p_max_attempts: EMBED_MAX_ATTEMPTS,");
    expect(core).toContain("p_model: connection.model,");
  });
  it("the columns are additive (fast default), and no function here is SECURITY DEFINER", () => {
    expect(body).toContain("ALTER TABLE knowledge_chunks ADD COLUMN IF NOT EXISTS embed_attempts INTEGER NOT NULL DEFAULT 0;");
    expect(body).toContain("ALTER TABLE knowledge_chunks ADD COLUMN IF NOT EXISTS embed_error TEXT;");
    expect(body).toContain("ALTER TABLE knowledge_chunks ADD COLUMN IF NOT EXISTS embed_claimed_until TIMESTAMPTZ;");
    expect(body).toContain("ALTER TABLE knowledge_chunks ADD COLUMN IF NOT EXISTS embed_retry_after TIMESTAMPTZ;");
    expect(body).not.toMatch(/SECURITY DEFINER/);
    expect(body).not.toMatch(/\bUPDATE knowledge_chunks SET embedding\b|DELETE FROM/);
  });
  it("census: 20261121 is the last definer of semantic_search, semantic_coverage, semantic_coverage_detail, embed_claim_batch and the two marker-safe writers", () => {
    const files = readdirSync(join(process.cwd(), "supabase", "migrations")).filter((f) => /^\d{8}.*\.sql$/.test(f)).sort();
    const last = (re: RegExp) => files.filter((f) => re.test(strip(mig(f)))).pop();
    for (const name of ["semantic_search", "semantic_coverage", "semantic_coverage_detail", "embed_claim_batch", "embed_build_marker_write", "knowledge_library_save_ai_features", "knowledge_libraries_embed_build_guard"]) {
      expect(last(new RegExp(`CREATE (OR REPLACE )?FUNCTION ${name}\\(`))).toBe(FILE);
    }
    expect(last(/CREATE TRIGGER \w+\s+BEFORE [\w ,]*\bON knowledge_libraries\b/)).toBe(FILE);
  });
  it("review fix pass 4 (SEM-8 / GOV-14 limb): only the service role changes the consent marker — a controller's direct PostgREST write of ai_features.embedBuild is refused", () => {
    // knowledge_libraries_write lets every controller UPDATE the row; the
    // marker names whose key and cap the drain spends.
    const fn = body.slice(body.indexOf("CREATE OR REPLACE FUNCTION knowledge_libraries_embed_build_guard()"), body.indexOf("DROP TRIGGER IF EXISTS trg_knowledge_libraries_embed_build_guard"));
    expect(fn).toContain("RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$");
    expect(fn).toContain("IF auth.role() IS NULL OR auth.role() = 'service_role' THEN\n    RETURN NEW;");
    expect(fn).toContain("IF TG_OP = 'UPDATE' THEN\n    v_before := OLD.ai_features -> 'embedBuild';");
    expect(fn).toContain("IF (NEW.ai_features -> 'embedBuild') IS DISTINCT FROM v_before THEN");
    expect(fn).toContain("USING ERRCODE = 'insufficient_privilege';");
    expect(body).toMatch(/CREATE TRIGGER trg_knowledge_libraries_embed_build_guard\n\s+BEFORE INSERT OR UPDATE OF ai_features ON knowledge_libraries\n\s+FOR EACH ROW EXECUTE FUNCTION knowledge_libraries_embed_build_guard\(\);/);
    // the guard lands in the same transaction as the writers it leaves open
    expect(body.indexOf("CREATE TRIGGER trg_knowledge_libraries_embed_build_guard")).toBeGreaterThan(body.indexOf("CREATE OR REPLACE FUNCTION knowledge_library_save_ai_features("));
    // the toggles save keeps the stored marker byte for byte, so it never trips the guard
    const save = body.slice(body.indexOf("CREATE OR REPLACE FUNCTION knowledge_library_save_ai_features("), body.indexOf("REVOKE ALL ON FUNCTION knowledge_library_save_ai_features"));
    expect(save).toContain("THEN jsonb_build_object('embedBuild', l.ai_features -> 'embedBuild')");
    // the marker writer stays service-role only
    expect(body).toContain("REVOKE ALL ON FUNCTION embed_build_marker_write(UUID, JSONB, BOOLEAN, TEXT[], TEXT, TEXT) FROM public, anon, authenticated;");
    // probed, with the forms pg_proc keeps verbatim; inventoried before apply
    expect(tail).toContain("SELECT 'trg_knowledge_libraries_embed_build_guard: only the service role (or a session with no request role) changes ai_features.embedBuild; search_path pinned',");
    expect(tail).toContain("AND prosrc LIKE '%auth.role() IS NULL OR auth.role() = ''service_role''%'");
    expect(tail).toContain("AND prosrc LIKE '%(NEW.ai_features -> ''embedBuild'') IS DISTINCT FROM v_before%'");
    const inv = m.slice(m.indexOf("CREATE TEMP TABLE"), m.indexOf("\nBEGIN;"));
    expect(inv).toContain("standing (\"keep current\") consents");
    expect(inv).toContain("other BEFORE INSERT / UPDATE row triggers on knowledge_libraries");
  });
});
