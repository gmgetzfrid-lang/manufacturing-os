// intelligence Round G — I-05: /api/templates/generate, the draft action.
//
//   GOV-11 / PR-12  drafting runs behind lib/ai/aiGates: the signed
//                   agreement (428 with the text to sign), own key, cap
//   GOV-13          each document's call is reserved before and settled after
//   PR-6            a reply that is not the requested fields FAILS the batch,
//                   naming the row — never a document with blank AI sections;
//                   a field the model wrote as "" is kept

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

type Row = Record<string, unknown>;
const db = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  seq: 0,
}));
const ai = vi.hoisted(() => ({ replies: [] as string[], calls: 0 }));

vi.mock("@/lib/supabaseAdmin", () => {
  function builder(table: string) {
    const filters: Array<(r: Row) => boolean> = [];
    let action: "select" | "insert" | "update" | "delete" = "select";
    let payload: Row | null = null;
    let range: [number, number] | null = null;
    let one = false;
    const exec = () => {
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
      auth: { getUser: vi.fn(async () => ({ data: { user: { id: "u1", email: "u1@x" } }, error: null })) },
      from: (t: string) => builder(t),
    },
  };
});
vi.mock("@/lib/knowledgeAccess", () => ({
  loadPrincipal: vi.fn(async () => ({ uid: "u1", orgId: "orgA", role: "Engineer", isController: false, teamIds: [] })),
}));
vi.mock("@/lib/r2Bytes", () => ({ fetchBytes: vi.fn(async () => Buffer.from([])) }));
vi.mock("@/lib/xlsxData", () => ({
  parseWorkbook: vi.fn(() => ({ headers: ["Name"], rows: [{ Name: "A" }, { Name: "B" }, { Name: "C" }], sheetNames: ["S"] })),
}));
vi.mock("@/lib/ai/providerCall", async (orig) => {
  const real = await orig<typeof import("@/lib/ai/providerCall")>();
  return {
    ...real,
    callAiModel: vi.fn(async () => {
      ai.calls += 1;
      return { text: ai.replies.shift() ?? "{}", webSources: [], liveWeb: false, usage: { inputTokens: 1000, outputTokens: 200 } };
    }),
  };
});

import { POST } from "@/app/api/templates/generate/route";
import { AGREEMENT_VERSION } from "@/lib/ai/pricing";

const draft = async () => {
  const r = await POST(new NextRequest("https://app/api/templates/generate", {
    method: "POST",
    headers: { authorization: "Bearer t", "content-type": "application/json" },
    body: JSON.stringify({ orgId: "orgA", templateId: "tpl1", action: "draft", sourceFileKey: "orgs/orgA/output-data/d.xlsx" }),
  }));
  return { status: r.status, json: await r.json() as Row };
};
const ledger = () => db.tables.ai_usage_events;

beforeEach(() => {
  db.seq = 0;
  db.tables = {
    output_templates: [{
      id: "tpl1", org_id: "orgA", name: "Letter", kind: "docx", template_file_key: "orgs/orgA/output-templates/t.docx",
      example_text: "", instructions: null, mode: "per_row", column_map: { name: "Name" }, filename_pattern: null,
      placeholders: [
        { tag: "name", label: "Name", kind: "data" },
        { tag: "body", label: "Body", kind: "ai" },
        { tag: "closing", label: "Closing", kind: "ai" },
      ],
    }],
    ai_connections: [{ org_id: "orgA", user_id: "u1", provider: "anthropic", model: "claude-sonnet-4", api_key: "sk-ant-x" }],
    ai_key_agreements: [{ org_id: "orgA", user_id: "u1", scope: "use", agreement_version: AGREEMENT_VERSION }],
    ai_usage_events: [],
    ai_usage_limits: [],
  };
  ai.replies = [];
  ai.calls = 0;
});

describe("GOV-11 / PR-12 — drafting is gated like every other AI call", () => {
  it("an unsigned member gets 428 with the agreement text, and nothing is sent to the provider", async () => {
    db.tables.ai_key_agreements = [];
    const r = await draft();
    expect(r.status).toBe(428);
    expect(r.json.agreementRequired).toBe(true);
    expect(String(r.json.agreementText)).toMatch(/NEVER enter/);
    expect(ai.calls).toBe(0);
  });

  it("no key → the template's own 412 sentence", async () => {
    db.tables.ai_connections = [];
    const r = await draft();
    expect(r.status).toBe(412);
    expect(String(r.json.error)).toMatch(/needs your own API key/);
  });

  it("at the cap → 402 naming who can raise it; every op counts (vision spend fills the cap here)", async () => {
    db.tables.ai_usage_events = [{ id: "s", created_at: new Date().toISOString(), org_id: "orgA", user_id: "u1", op: "knowledgeVision", input_tokens: 1, output_tokens: 1, est_cost_usd: 10, ok: true }];
    const r = await draft();
    expect(r.status).toBe(402);
    expect(String(r.json.error)).toMatch(/someone who manages AI caps/);
    expect(ai.calls).toBe(0);
  });
});

describe("GOV-13 — each document reserved, then settled", () => {
  it("three rows, three settled templateDraft rows with the provider's counts; nothing left reserved", async () => {
    ai.replies = ['{"body":"b1","closing":"c1"}', '{"body":"b2","closing":"c2"}', '{"body":"b3","closing":"c3"}'];
    const r = await draft();
    expect(r.status).toBe(200);
    expect((r.json.documents as Row[]).map((d) => (d.values as Row).body)).toEqual(["b1", "b2", "b3"]);
    expect(ledger()).toHaveLength(3);
    for (const row of ledger()) expect(row).toMatchObject({ op: "templateDraft", input_tokens: 1000, output_tokens: 200, ok: true });
  });

  it("the cap stops the batch part-way: the drafted rows come back, the next slice starts at the stopped row", async () => {
    // A document's worst case is ~$0.046 (3,000 output tokens at $15/M plus
    // its prompt) and its settled cost $0.006: with $0.049 left the first
    // fits, and after it settles the second does not.
    db.tables.ai_usage_events = [{ id: "s", created_at: new Date().toISOString(), org_id: "orgA", user_id: "u1", op: "knowledgeAsk", input_tokens: 1, output_tokens: 1, est_cost_usd: 9.951, ok: true }];
    ai.replies = ['{"body":"b1","closing":"c1"}', '{"body":"b2","closing":"c2"}'];
    const r = await draft();
    expect(r.status).toBe(200);
    expect(r.json.documents as Row[]).toHaveLength(1);
    expect(r.json.nextOffset).toBe(1);
    expect(String(r.json.stopped)).toMatch(/could cost up to|budget reached/);
  });
});

describe("PR-6 — an unreadable draft fails, it never blanks", () => {
  it("a reply whose JSON does not parse fails the batch, naming the row — no documents, nothing blank", async () => {
    ai.replies = ['{"body":"b1","closing":"c1"}', '{"body":"b2","closing":'];
    const r = await draft();
    expect(r.status).toBe(502);
    expect(String(r.json.error)).toMatch(/draft for row 2 couldn't be read — the reply's JSON did not parse/);
    expect(String(r.json.error)).toMatch(/nothing was left blank/);
    expect(r.json.documents).toBeUndefined();
    // the failed call was still metered (its tokens were spent), as a failed draft
    expect(ledger().map((x) => x.ok)).toEqual([true, false]);
    expect(ledger()[1]).toMatchObject({ input_tokens: 1000, output_tokens: 200 });
  });

  it("a reply with no JSON object, or one that leaves a field out, fails too", async () => {
    ai.replies = ["Sorry, I can't help with that."];
    expect(String((await draft()).json.error)).toMatch(/row 1 couldn't be read — the reply held no JSON object/);
    ai.replies = ['{"body":"b1"}'];
    expect(String((await draft()).json.error)).toMatch(/the reply left out closing/);
  });

  it("a field the model wrote as \"\" is its answer and is kept; prose around the object is tolerated", async () => {
    ai.replies = ['Here you go: {"body":"b1","closing":""} — done', '{"body":"b2","closing":null}', '```json\n{"body":"b3","closing":"c3"}\n```'];
    const r = await draft();
    expect(r.status).toBe(200);
    const docs = r.json.documents as Array<{ values: Row }>;
    expect(docs[0].values).toMatchObject({ name: "A", body: "b1", closing: "" });
    expect(docs[1].values.closing).toBe("");
    expect(docs[2].values.closing).toBe("c3");
  });
});
