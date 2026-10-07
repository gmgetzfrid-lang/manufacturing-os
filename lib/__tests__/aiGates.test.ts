// intelligence Round G — I-05: lib/ai/aiGates.ts, the ONE gate stack, and
// lib/ai/governedCall.ts built on it (GOV-11 / PR-12 / GOV-13 / GOV-3 / GOV-4).
//
//   own key → allowlist (per key kind) → agreement → cap over every op →
//   a reservation per call, settled to the provider's counts.

import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, unknown>;
const db = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  errors: {} as Record<string, { code?: string; message: string } | undefined>,
  seq: 0,
}));
const ai = vi.hoisted(() => ({
  calls: [] as Array<Record<string, unknown>>,
  next: null as null | { text: string; usage: { inputTokens: number; outputTokens: number } } | Error,
}));

vi.mock("@/lib/supabaseAdmin", () => {
  function builder(table: string) {
    const filters: Array<(r: Row) => boolean> = [];
    let action: "select" | "insert" | "update" | "delete" = "select";
    let payload: Row | null = null;
    let range: [number, number] | null = null;
    let one = false;
    const exec = () => {
      const err = db.errors[`${table}:${action}`];
      if (err) return { data: null, error: err };
      const rows = (db.tables[table] ??= []);
      if (action === "insert") {
        const row = { id: `r${++db.seq}`, created_at: new Date(Date.now() + db.seq).toISOString(), ...payload };
        rows.push(row);
        return { data: one ? { id: row.id } : [row], error: null };
      }
      const hit = rows.filter((r) => filters.every((f) => f(r)));
      if (action === "update") { for (const r of hit) Object.assign(r, payload); return { data: null, error: null }; }
      if (action === "delete") { db.tables[table] = rows.filter((r) => !hit.includes(r)); return { data: null, error: null }; }
      const out = range ? hit.slice(range[0], range[1] + 1) : hit;
      return { data: one ? (out[0] ?? null) : out, error: null };
    };
    const b: Record<string, unknown> = {
      select: () => b,
      insert: (p: Row) => { action = "insert"; payload = p; return b; },
      update: (p: Row) => { action = "update"; payload = p; return b; },
      delete: () => { action = "delete"; return b; },
      eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return b; },
      is: (c: string, v: unknown) => { filters.push((r) => (r[c] ?? null) === v); return b; },
      gte: (c: string, v: string) => { filters.push((r) => String(r[c]) >= v); return b; },
      gt: (c: string, v: string) => { filters.push((r) => String(r[c]) > v); return b; },
      order: () => b,
      range: (a: number, z: number) => { range = [a, z]; return b; },
      limit: () => b,
      single: () => { one = true; return b; },
      maybeSingle: () => { one = true; return b; },
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(exec()).then(res, rej),
    };
    return b;
  }
  return { supabaseAdmin: { from: (t: string) => builder(t) } };
});
vi.mock("@/lib/ai/providerCall", () => ({
  callAiModel: vi.fn(async (input: Record<string, unknown>) => {
    ai.calls.push(input);
    if (ai.next instanceof Error) throw ai.next;
    return { text: ai.next?.text ?? "OK", webSources: [], liveWeb: false, usage: ai.next?.usage ?? { inputTokens: 1000, outputTokens: 100 } };
  }),
}));
vi.mock("@/lib/aiInstructionsServer", () => ({ loadOrgInstructionsBlock: vi.fn(async () => "") }));

import { assertAiGates, NO_KEY_MESSAGE, NO_EMBEDDING_KEY_MESSAGE } from "@/lib/ai/aiGates";
import { governedAiCall, GovernedCallError } from "@/lib/ai/governedCall";
import { AiUsageUnavailableError, UNPRICED_CALL_USD } from "@/lib/ai/usageServer";
import { AGREEMENT_VERSION } from "@/lib/ai/pricing";

const ORG = "o1", ME = "u1";
const signed = () => ({ org_id: ORG, user_id: ME, scope: "use", agreement_version: AGREEMENT_VERSION });
const spent = (usd: number, op = "knowledgeVision"): Row => ({
  id: `s${++db.seq}`, created_at: new Date().toISOString(), org_id: ORG, user_id: ME, op, model: "chat-model",
  input_tokens: 10, output_tokens: 1, est_cost_usd: usd, ok: true,
});

beforeEach(() => {
  db.seq = 0;
  db.errors = {};
  db.tables = {
    ai_connections: [{ org_id: ORG, user_id: ME, provider: "anthropic", model: "chat-model", api_key: "sk-ant-plain",
      embedding_provider: "voyage", embedding_model: "embed-model", embedding_api_key: "pa-voyage" }],
    ai_key_agreements: [signed()],
    ai_usage_events: [],
    ai_usage_limits: [],
  };
  ai.calls = [];
  ai.next = null;
});

const refusal = async (p: Promise<unknown>) => {
  const e = await p.then(() => null, (x) => x);
  expect(e, "expected a refusal").toBeInstanceOf(GovernedCallError);
  return e as GovernedCallError;
};

describe("aiGates — the five gates, in order", () => {
  it("1/2: no key, or a key for a provider outside the chat allowlist → 412 before anything else is read", async () => {
    db.tables.ai_connections = [];
    expect((await refusal(assertAiGates({ orgId: ORG, userId: ME, op: "x" }))).status).toBe(412);
    db.tables.ai_connections = [{ org_id: ORG, user_id: ME, provider: "gemini", model: "g", api_key: "k" }];
    const e = await refusal(assertAiGates({ orgId: ORG, userId: ME, op: "x" }));
    expect(e.status).toBe(412);
    expect(e.message).toBe(NO_KEY_MESSAGE);
  });

  it("2: the embeddings key is gated by the EMBEDDINGS allowlist, and opened for the caller", async () => {
    const pass = await assertAiGates({ orgId: ORG, userId: ME, op: "knowledgeEmbed", key: "embedding" });
    expect(pass.connection).toEqual({ provider: "voyage", model: "embed-model", apiKey: "pa-voyage" });
    db.tables.ai_connections = [{ org_id: ORG, user_id: ME, provider: "anthropic", model: "m", api_key: "k", embedding_provider: "cohere", embedding_model: "c", embedding_api_key: "x" }];
    const e = await refusal(assertAiGates({ orgId: ORG, userId: ME, op: "knowledgeEmbed", key: "embedding" }));
    expect(e.status).toBe(412);
    expect(e.message).toBe(NO_EMBEDDING_KEY_MESSAGE);
  });

  it("2: a caller-supplied key (a test before saving) is allowlisted too", async () => {
    const e = await refusal(assertAiGates({ orgId: ORG, userId: ME, op: "connectionTest", requireAgreement: false, connection: { provider: "gemini", model: "g", apiKey: "k" } }));
    expect(e.status).toBe(412);
    const pass = await assertAiGates({ orgId: ORG, userId: ME, op: "connectionTest", requireAgreement: false, connection: { provider: "openai", model: "chat-model-3", apiKey: "sk-new" } });
    expect(pass.connection.apiKey).toBe("sk-new");
  });

  it("3: unsigned (or signed an older version) → 428 carrying the text to sign, which names every vendor", async () => {
    db.tables.ai_key_agreements = [{ ...signed(), agreement_version: "2026-07-v2" }];
    const e = await refusal(assertAiGates({ orgId: ORG, userId: ME, op: "flowRead" }));
    expect(e.status).toBe(428);
    expect(e.details?.agreementRequired).toBe(true);
    expect(e.details?.agreementVersion).toBe(AGREEMENT_VERSION);
    expect(String(e.details?.agreementText)).toMatch(/Voyage AI/);
    // the embeddings key's gate asks for the agreement too, naming its vendor's paragraph
    const emb = await refusal(assertAiGates({ orgId: ORG, userId: ME, op: "knowledgeEmbed", key: "embedding" }));
    expect(String(emb.details?.agreementText)).toMatch(/Your meaning index is built by Voyage AI/);
  });

  it("3: the documented exemption — a liveness probe with requireAgreement:false passes unsigned", async () => {
    db.tables.ai_key_agreements = [];
    await expect(assertAiGates({ orgId: ORG, userId: ME, op: "connectionTest", requireAgreement: false })).resolves.toBeTruthy();
  });

  it("4: every op counts — a month of vision indexing at the cap refuses a flow read (402)", async () => {
    db.tables.ai_usage_events = [spent(10)];
    const e = await refusal(assertAiGates({ orgId: ORG, userId: ME, op: "flowRead" }));
    expect(e.status).toBe(402);
    expect(e.message).toMatch(/Monthly AI budget reached \(\$10\.00 of \$10\.00\)/);
  });

  it("4: a $0 cap locks — refused at $0 spent (GOV-3: POST capUsd 0, then a governed call is refused with 402)", async () => {
    db.tables.ai_usage_limits = [{ org_id: ORG, user_id: null, monthly_cap_usd: 0 }];
    const e = await refusal(governedAiCall({ orgId: ORG, userId: ME, op: "graphShape", system: "s", user: "u" }));
    expect(e.status).toBe(402);
    expect(e.message).toMatch(/set to \$0/);
    expect(ai.calls).toHaveLength(0);
  });

  it("4: a ledger read error → 503 and no provider call (GOV-4: a mocked ledger error produces a refused governed call)", async () => {
    db.errors["ai_usage_events:select"] = { message: "connection reset" };
    const e = await refusal(governedAiCall({ orgId: ORG, userId: ME, op: "graphShape", system: "s", user: "u" }));
    expect(e).toBeInstanceOf(AiUsageUnavailableError);
    expect(e.status).toBe(503);
    expect(ai.calls).toHaveLength(0);
  });

  it("4: a row recorded without a cost counts at UNPRICED_CALL_USD — never $0, never a month-long lock (GOV-4)", async () => {
    const unpriced = () => ({ ...spent(0), id: `np${++db.seq}`, est_cost_usd: null, input_tokens: null, output_tokens: null });
    db.tables.ai_usage_events = [unpriced()];
    // one stale-schema-cache row: the member keeps working, the month reads $1.00 more
    const pass = await assertAiGates({ orgId: ORG, userId: ME, op: "x" });
    expect(pass.month.unpricedCalls).toBe(1);
    expect(pass.month.spentUsd).toBe(UNPRICED_CALL_USD);
    expect(UNPRICED_CALL_USD).toBe(1);
    // ...and a governed call still goes through and is reserved beside it
    await expect(governedAiCall({ orgId: ORG, userId: ME, op: "graphShape", system: "s", user: "u", maxTokens: 800 })).resolves.toMatchObject({ text: "OK" });
    // enough of them fill the cap like any spend — 402, not 503
    db.tables.ai_usage_events = Array.from({ length: 10 }, unpriced);
    const e = await refusal(assertAiGates({ orgId: ORG, userId: ME, op: "x" }));
    expect(e.status).toBe(402);
    expect(e.message).not.toMatch(/20260916/);
  });
});

describe("governedAiCall — one call, reserved before, settled after (GOV-13)", () => {
  it("meters the provider's counts on success, under the call's op, with nothing left reserved", async () => {
    ai.next = { text: "fine", usage: { inputTokens: 2000, outputTokens: 500 } };
    const out = await governedAiCall({ orgId: ORG, userId: ME, op: "graphShape", system: "sys", user: "hello", maxTokens: 800 });
    expect(out.text).toBe("fine");
    expect(ai.calls[0]).toMatchObject({ provider: "anthropic", model: "chat-model", apiKey: "sk-ant-plain", maxTokens: 800 });
    const rows = db.tables.ai_usage_events;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ op: "graphShape", input_tokens: 2000, output_tokens: 500, ok: true });
    expect(Number(rows[0].est_cost_usd)).toBeCloseTo(0.0225, 6); // 2000×$5/M + 500×$25/M (an unlisted model prices at the frontier fallback)
  });

  it("a provider failure is metered as a failed call (ok:false, $0) and the error still surfaces", async () => {
    ai.next = new Error("provider exploded");
    await expect(governedAiCall({ orgId: ORG, userId: ME, op: "graphShape", system: "s", user: "u" })).rejects.toThrow("provider exploded");
    expect(db.tables.ai_usage_events).toHaveLength(1);
    expect(db.tables.ai_usage_events[0]).toMatchObject({ ok: false, input_tokens: 0, output_tokens: 0, est_cost_usd: 0 });
  });

  it("a call whose worst case does not fit the headroom is refused before the provider is called", async () => {
    db.tables.ai_usage_events = [spent(9.99)];
    const e = await refusal(governedAiCall({ orgId: ORG, userId: ME, op: "checklistAssess", system: "s".repeat(30_000), user: "u", maxTokens: 4000 }));
    expect(e.status).toBe(402);
    expect(e.message).toMatch(/could cost up to/);
    expect(ai.calls).toHaveLength(0);
    expect(db.tables.ai_usage_events).toHaveLength(1); // the reservation was released
  });

  it("images are priced into the reservation (a page image is never free)", async () => {
    db.tables.ai_usage_events = [spent(9.97)];
    const img = { base64: "x", mediaType: "image/png" };
    // text alone fits at $0.03 of headroom; ten pages at 1,600 tokens each do not
    await expect(governedAiCall({ orgId: ORG, userId: ME, op: "qualityManualReview", system: "s", user: "u", maxTokens: 100 })).resolves.toBeTruthy();
    db.tables.ai_usage_events = [spent(9.97)];
    const e = await refusal(governedAiCall({ orgId: ORG, userId: ME, op: "qualityManualReview", system: "s", user: "u", maxTokens: 100, images: Array(10).fill(img) }));
    expect(e.status).toBe(402);
  });

  it("no regression under the cap: an ordinary member with ordinary spend gets the answer", async () => {
    db.tables.ai_usage_events = [spent(1.2, "knowledgeAsk"), spent(0.4, "knowledgeEmbed"), spent(2, "orchestrator")];
    await expect(governedAiCall({ orgId: ORG, userId: ME, op: "skillAssist", system: "s", user: "u", maxTokens: 900 })).resolves.toMatchObject({ text: "OK" });
  });
});
