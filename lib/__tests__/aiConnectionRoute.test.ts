// intelligence Round G — I-05: /api/ai/connection.
//
//   GOV-7   every live call (test, embeddings test, verify-on-save) is gated
//           on the cap and metered under `connectionTest`; a capped member
//           cannot test, but may still verify a NEW key on save (de minimis,
//           five an hour) — never a LOCKED ($0) member, whom GOV-3 allows no
//           spend on any gate; the saved key is tested on the saved model
//   GOV-11  the agreement is waived for these probes only (no org content)
//   GOV-6   the embeddings key is held to ALLOWED_EMBEDDING_PROVIDERS
//   GOV-12  a production server without EXPORT_ENCRYPTION_KEY refuses to
//           store a key BEFORE spending a verify call; a plaintext row is
//           re-sealed on its next save; the GET reports unsealed keys

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

type Row = Record<string, unknown>;
const db = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  errors: {} as Record<string, { code?: string; message: string } | undefined>,
  seq: 0,
}));
const ai = vi.hoisted(() => ({
  chat: [] as Array<Record<string, unknown>>,
  embed: [] as Array<Record<string, unknown>>,
  fail: null as Error | null,
}));

vi.mock("@/lib/supabaseAdmin", () => {
  function builder(table: string) {
    const filters: Array<(r: Row) => boolean> = [];
    let action: "select" | "insert" | "update" | "delete" = "select";
    let payload: Row | null = null;
    let range: [number, number] | null = null;
    let one = false;
    let head = false;
    const likeRe = (p: string) => new RegExp(`^${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*")}$`);
    const exec = () => {
      const err = db.errors[`${table}:${action}`];
      if (err) return { data: null, error: err, count: null };
      const rows = (db.tables[table] ??= []);
      if (action === "insert") {
        const row = { id: `r${++db.seq}`, created_at: new Date(Date.now() + db.seq).toISOString(), ...payload };
        rows.push(row);
        return { data: one ? { id: row.id } : [row], error: null };
      }
      const hit = rows.filter((r) => filters.every((f) => f(r)));
      if (action === "update") { for (const r of hit) Object.assign(r, payload); return { data: null, error: null }; }
      if (action === "delete") { db.tables[table] = rows.filter((r) => !hit.includes(r)); return { data: null, error: null }; }
      if (head) return { data: null, error: null, count: hit.length };
      const out = range ? hit.slice(range[0], range[1] + 1) : hit;
      return { data: one ? (out[0] ?? null) : out, error: null, count: out.length };
    };
    const b: Record<string, unknown> = {
      select: (_c?: string, o?: { head?: boolean }) => { if (o?.head) head = true; return b; },
      insert: (p: Row) => { action = "insert"; payload = p; return b; },
      update: (p: Row) => { action = "update"; payload = p; return b; },
      delete: () => { action = "delete"; return b; },
      eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return b; },
      is: (c: string, v: unknown) => { filters.push((r) => (r[c] ?? null) === v); return b; },
      not: (c: string, op: string, v: unknown) => {
        if (op === "is") filters.push((r) => (r[c] ?? null) !== v);
        else if (op === "like") filters.push((r) => r[c] != null && !likeRe(String(v)).test(String(r[c])));
        return b;
      },
      gte: (c: string, v: string) => { filters.push((r) => String(r[c]) >= v); return b; },
      order: () => b,
      range: (a: number, z: number) => { range = [a, z]; return b; },
      limit: () => b,
      single: () => { one = true; return b; },
      maybeSingle: () => { one = true; return b; },
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(exec()).then(res, rej),
    };
    return b;
  }
  return {
    supabaseAdmin: {
      auth: { getUser: vi.fn(async (t: string) => ({ data: { user: t === "bad" ? null : { id: t } }, error: null })) },
      from: (t: string) => builder(t),
    },
  };
});
vi.mock("@/lib/ai/providerCall", async (orig) => {
  const real = await orig<typeof import("@/lib/ai/providerCall")>();
  return {
    ...real,
    callAiModel: vi.fn(async (input: Record<string, unknown>) => {
      ai.chat.push(input);
      if (ai.fail) throw ai.fail;
      return { text: "OK", webSources: [], liveWeb: false, usage: { inputTokens: 20, outputTokens: 2 } };
    }),
  };
});
vi.mock("@/lib/ai/embeddings", async (orig) => {
  const real = await orig<typeof import("@/lib/ai/embeddings")>();
  return {
    ...real,
    embedPassages: vi.fn(async (input: Record<string, unknown>) => {
      ai.embed.push(input);
      if (ai.fail) throw ai.fail;
      return { vectors: [[0]], usage: { inputTokens: 3, outputTokens: 0 } };
    }),
  };
});

import { GET, POST } from "@/app/api/ai/connection/route";

const ORG = "o1", ME = "u-me", CTRL = "u-ctrl";
const HEX = "b".repeat(64);
const req = (method: "GET" | "POST", body?: Row, who = ME) => new NextRequest(
  method === "GET" ? `https://app/api/ai/connection?orgId=${ORG}` : "https://app/api/ai/connection",
  { method, headers: { authorization: `Bearer ${who}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) },
);
const post = async (body: Row, who = ME) => { const r = await POST(req("POST", { orgId: ORG, ...body }, who)); return { status: r.status, json: await r.json() as Row }; };
const ledger = () => db.tables.ai_usage_events;
let savedKey: string | undefined;

beforeEach(() => {
  savedKey = process.env.EXPORT_ENCRYPTION_KEY;
  process.env.EXPORT_ENCRYPTION_KEY = HEX;
  db.seq = 0;
  db.errors = {};
  db.tables = {
    org_members: [
      { org_id: ORG, uid: ME, role: "Engineer", roles: ["Engineer"], status: "active", display_name: "Me" },
      { org_id: ORG, uid: CTRL, role: "Manager", roles: ["Manager", "DocCtrl"], status: "active", display_name: "Ctl" },
    ],
    ai_connections: [{ id: "c1", org_id: ORG, user_id: ME, provider: "anthropic", model: "claude-sonnet-4", api_key: "sk-ant-legacy-plain", key_last4: "lain", updated_at: "x",
      embedding_provider: "voyage", embedding_model: "voyage-3.5-lite", embedding_api_key: "pa-plain", embedding_key_last4: "lain" }],
    ai_key_agreements: [],
    ai_usage_events: [],
    ai_usage_limits: [],
    audit_logs: [],
  };
  ai.chat = []; ai.embed = []; ai.fail = null;
});
afterEach(() => {
  if (savedKey === undefined) delete process.env.EXPORT_ENCRYPTION_KEY; else process.env.EXPORT_ENCRYPTION_KEY = savedKey;
  vi.unstubAllEnvs();
});

describe("GOV-7 — tests are gated and metered", () => {
  it("a test of the saved key writes a connectionTest row with the provider's counts (no agreement needed — a probe)", async () => {
    const r = await post({ action: "test" });
    expect(r.status).toBe(200);
    expect(ledger()).toHaveLength(1);
    expect(ledger()[0]).toMatchObject({ op: "connectionTest", user_id: ME, input_tokens: 20, output_tokens: 2, ok: true, provider: "anthropic" });
    // the probe sends no org content
    expect(ai.chat[0]).toMatchObject({ system: "You are a connection test. Reply with exactly: OK", user: "Connection test." });
  });

  it("the saved key is tested on the SAVED model — a body model is ignored", async () => {
    await post({ action: "test", model: "claude-opus-5" });
    expect(ai.chat[0].model).toBe("claude-sonnet-4");
  });

  it("a member at their cap cannot run a test (402, no provider call, nothing left reserved)", async () => {
    db.tables.ai_usage_events = [{ id: "s1", created_at: new Date().toISOString(), org_id: ORG, user_id: ME, op: "knowledgeVision", input_tokens: 1, output_tokens: 1, est_cost_usd: 10, ok: true }];
    const r = await post({ action: "test" });
    expect(r.status).toBe(402);
    expect(ai.chat).toHaveLength(0);
    expect(ledger()).toHaveLength(1);
  });

  it("the embeddings test is metered too, and a locked ($0) member is refused", async () => {
    expect((await post({ action: "embedding-test" })).status).toBe(200);
    expect(ledger()[0]).toMatchObject({ op: "connectionTest", provider: "voyage", model: "voyage-3.5-lite", input_tokens: 3 });
    db.tables.ai_usage_limits = [{ org_id: ORG, user_id: ME, monthly_cap_usd: 0 }];
    expect((await post({ action: "embedding-test" })).status).toBe(402);
    expect(ai.embed).toHaveLength(1);
  });

  it("a failed probe is metered as a failed call and the provider's message surfaces", async () => {
    ai.fail = Object.assign(new Error("invalid x-api-key"), { status: 401 });
    const r = await post({ action: "test" });
    expect(r.status).toBe(401);
    expect(ledger()[0]).toMatchObject({ op: "connectionTest", ok: false, est_cost_usd: 0 });
  });

  it("at the cap a NEW key is still verified on save (de minimis, metered) — at most five an hour", async () => {
    db.tables.ai_usage_events = [{ id: "s1", created_at: new Date().toISOString(), org_id: ORG, user_id: ME, op: "orchestrator", input_tokens: 1, output_tokens: 1, est_cost_usd: 50, ok: true }];
    const ok = await post({ provider: "anthropic", model: "claude-sonnet-4", apiKey: "sk-ant-new-key-1" });
    expect(ok.status).toBe(200);
    expect(ledger().filter((r) => r.op === "connectionTest")).toHaveLength(1);
    for (let i = 2; i <= 5; i++) expect((await post({ provider: "anthropic", model: "claude-sonnet-4", apiKey: `sk-ant-new-key-${i}` })).status).toBe(200);
    const sixth = await post({ provider: "anthropic", model: "claude-sonnet-4", apiKey: "sk-ant-new-key-6" });
    expect(sixth.status).toBe(429);
    expect(String(sixth.json.error)).toMatch(/five|5 times an hour/);
    expect(ai.chat).toHaveLength(5);
  });

  it("a LOCKED ($0) member gets no de-minimis exemption: a new key is neither checked nor saved (GOV-3 — zero spend on every gate)", async () => {
    db.tables.ai_usage_limits = [{ org_id: ORG, user_id: ME, monthly_cap_usd: 0 }];
    const chat = await post({ provider: "anthropic", model: "claude-sonnet-4", apiKey: "sk-ant-new-key-1" });
    expect(chat.status).toBe(402);
    expect(String(chat.json.error)).toMatch(/set to \$0.*can't be checked while AI is locked for you, so it was not saved/);
    const emb = await post({ action: "embedding", embeddingProvider: "voyage", embeddingModel: "voyage-3.5-lite", embeddingApiKey: "pa-new-key" });
    expect(emb.status).toBe(402);
    // no provider call, no metering row, and the stored key is the old one
    expect(ai.chat).toHaveLength(0);
    expect(ai.embed).toHaveLength(0);
    expect(ledger()).toHaveLength(0);
    expect(db.tables.ai_connections[0]).toMatchObject({ api_key: "sk-ant-legacy-plain", embedding_api_key: "pa-plain" });
    // a plain test says only the lock (no "not saved" — nothing was being saved)
    const test = await post({ action: "test" });
    expect(test.status).toBe(402);
    expect(String(test.json.error)).not.toMatch(/not saved/);
  });
});

describe("GOV-6 — the embeddings key is held to the embeddings allowlist", () => {
  it("a provider outside ALLOWED_EMBEDDING_PROVIDERS is refused at save and at test, before any call", async () => {
    expect((await post({ action: "embedding", embeddingProvider: "cohere", embeddingApiKey: "k" })).status).toBe(400);
    expect((await post({ action: "embedding-test", embeddingProvider: "cohere", embeddingApiKey: "k" })).status).toBe(400);
    expect(ai.embed).toHaveLength(0);
  });
  it("a chat key outside ALLOWED_PROVIDERS is refused (403) at save and at test", async () => {
    expect((await post({ provider: "gemini", model: "g", apiKey: "AIza-x" })).status).toBe(403);
    expect((await post({ action: "test", provider: "gemini", model: "g", apiKey: "AIza-x" })).status).toBe(403);
    expect(ai.chat).toHaveLength(0);
  });
});

describe("GOV-12 — keys at rest", () => {
  it("production without EXPORT_ENCRYPTION_KEY: saving a key is refused (503) before the verify call is spent", async () => {
    delete process.env.EXPORT_ENCRYPTION_KEY;
    vi.stubEnv("NODE_ENV", "production");
    const r = await post({ provider: "anthropic", model: "claude-sonnet-4", apiKey: "sk-ant-brand-new" });
    expect(r.status).toBe(503);
    expect(String(r.json.error)).toMatch(/EXPORT_ENCRYPTION_KEY/);
    expect(ai.chat).toHaveLength(0);
    expect(db.tables.ai_connections[0].api_key).toBe("sk-ant-legacy-plain");
    const e = await post({ action: "embedding", embeddingProvider: "voyage", embeddingApiKey: "pa-new" });
    expect(e.status).toBe(503);
    expect(ai.embed).toHaveLength(0);
  });

  it("production without the key: the existing plaintext key still works (a test still runs)", async () => {
    delete process.env.EXPORT_ENCRYPTION_KEY;
    vi.stubEnv("NODE_ENV", "production");
    expect((await post({ action: "test" })).status).toBe(200);
    expect(ai.chat[0].apiKey).toBe("sk-ant-legacy-plain");
  });

  it("a new key is stored sealed; a model-only save re-seals a legacy plaintext key (chat and embeddings)", async () => {
    expect((await post({ provider: "anthropic", model: "claude-haiku-4-5" })).status).toBe(200);
    const row = db.tables.ai_connections[0];
    expect(String(row.api_key).startsWith("encv1:")).toBe(true);
    expect(row.model).toBe("claude-haiku-4-5");
    expect((await post({ action: "embedding", embeddingProvider: "voyage", embeddingModel: "voyage-3.5" })).status).toBe(200);
    expect(String(row.embedding_api_key).startsWith("encv1:")).toBe(true);
    // and it still opens to the same key for the next call
    expect((await post({ action: "test" })).status).toBe(200);
    expect(ai.chat.at(-1)?.apiKey).toBe("sk-ant-legacy-plain");
  });

  it("the GET reports storage: encrypted or not, the member's own unsealed keys, and (controllers) the org's", async () => {
    db.tables.ai_connections.push({ id: "c2", org_id: ORG, user_id: CTRL, provider: "openai", model: "gpt-4o", api_key: "encv1:abc", embedding_api_key: null });
    const mine = await (await GET(req("GET"))).json() as { keyStorage: Row };
    expect(mine.keyStorage).toEqual({ encrypted: true, plaintextRefused: false, yoursUnsealed: 2 });
    const ctl = await (await GET(req("GET", undefined, CTRL))).json() as { keyStorage: Row; canManageOrg: boolean };
    expect(ctl.canManageOrg).toBe(true); // DocCtrl held as an additional role
    expect(ctl.keyStorage).toMatchObject({ yoursUnsealed: 0, orgUnsealed: 2 });
    // the masked view never carries a key
    expect(JSON.stringify(mine)).not.toMatch(/sk-ant|pa-plain|encv1/);
  });
});
