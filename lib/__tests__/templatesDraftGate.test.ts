// intelligence Round G — I-05: /api/templates/generate, the draft action.
//
//   GOV-11 / PR-12  drafting runs behind lib/ai/aiGates: the signed
//                   agreement (428 with the text to sign), own key, cap
//   GOV-13          each document's call is reserved before and settled after
//   PR-6            a reply that is not the requested fields fails THAT row —
//                   never a document with blank AI sections: the rows drafted
//                   before it are kept (paid for), the row is named in
//                   skippedRows, the next slice starts after it (a row that
//                   always fails cannot hold the batch); a provider failure
//                   part-way keeps the rows before it too, and the next
//                   slice starts AT the failed row; a field the model
//                   wrote as "" is kept

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

type Row = Record<string, unknown>;
const db = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  seq: 0,
}));
const ai = vi.hoisted(() => ({ replies: [] as string[], calls: 0, failOn: 0 as number, failStatus: 504 }));
const sheet = vi.hoisted(() => ({ rows: [{ Name: "A" }, { Name: "B" }, { Name: "C" }] as Array<Record<string, string>> }));

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
  parseWorkbook: vi.fn(() => ({ headers: ["Name"], rows: sheet.rows, sheetNames: ["S"] })),
}));
vi.mock("@/lib/ai/providerCall", async (orig) => {
  const real = await orig<typeof import("@/lib/ai/providerCall")>();
  return {
    ...real,
    callAiModel: vi.fn(async () => {
      ai.calls += 1;
      // the provider fails on the Nth call (a timeout, a 429, a 5xx)
      if (ai.failOn === ai.calls) throw new real.AiCallError("Anthropic timed out — try again", ai.failStatus);
      return { text: ai.replies.shift() ?? "{}", webSources: [], liveWeb: false, usage: { inputTokens: 1000, outputTokens: 200 } };
    }),
  };
});

import { POST } from "@/app/api/templates/generate/route";
import { AGREEMENT_VERSION } from "@/lib/ai/pricing";

const draft = async (extra: Row = {}) => {
  const r = await POST(new NextRequest("https://app/api/templates/generate", {
    method: "POST",
    headers: { authorization: "Bearer t", "content-type": "application/json" },
    body: JSON.stringify({ orgId: "orgA", templateId: "tpl1", action: "draft", sourceFileKey: "orgs/orgA/output-data/d.xlsx", ...extra }),
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
    ai_connections: [{ org_id: "orgA", user_id: "u1", provider: "anthropic", model: "chat-model", api_key: "sk-ant-x" }],
    ai_key_agreements: [{ org_id: "orgA", user_id: "u1", scope: "use", agreement_version: AGREEMENT_VERSION }],
    ai_usage_events: [],
    ai_usage_limits: [],
  };
  ai.replies = [];
  ai.calls = 0;
  ai.failOn = 0;
  ai.failStatus = 504;
  sheet.rows = [{ Name: "A" }, { Name: "B" }, { Name: "C" }];
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
    expect(String(r.json.error)).toMatch(/It resets on the 1st/);
    expect(ai.calls).toBe(0);
  });

  it("a $0 cap is a LOCK: the 402 says AI is locked and who raises it — never that it resets on the 1st (GOV-3)", async () => {
    db.tables.ai_usage_limits = [{ org_id: "orgA", user_id: "u1", monthly_cap_usd: 0 }];
    const r = await draft();
    expect(r.status).toBe(402);
    expect(String(r.json.error)).toMatch(/Your monthly AI cap is set to \$0, so AI is locked for you/);
    expect(String(r.json.error)).toMatch(/Who manages AI caps: an Admin, unless your workspace granted it to others/);
    expect(String(r.json.error)).not.toMatch(/resets on the 1st/);
    expect(ai.calls).toBe(0);
    expect(ledger()).toHaveLength(0);
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
    // The fixture's model is unlisted, so it prices at the $5/$25 frontier
    // fallback: a document's worst case is ~$0.077 (3,000 output tokens at
    // $25/M plus its prompt) and its settled cost $0.01: with $0.08 left the
    // first fits, and after it settles the second does not.
    db.tables.ai_usage_events = [{ id: "s", created_at: new Date().toISOString(), org_id: "orgA", user_id: "u1", op: "knowledgeAsk", input_tokens: 1, output_tokens: 1, est_cost_usd: 9.92, ok: true }];
    ai.replies = ['{"body":"b1","closing":"c1"}', '{"body":"b2","closing":"c2"}'];
    const r = await draft();
    expect(r.status).toBe(200);
    expect(r.json.documents as Row[]).toHaveLength(1);
    expect(r.json.nextOffset).toBe(1);
    expect(String(r.json.stopped)).toMatch(/could cost up to|budget reached/);
  });
});

describe("PR-6 — an unreadable draft fails its row, never blanks it, and never throws away what was paid for", () => {
  it("a reply whose JSON does not parse: the rows before it come back, the row is named and left out, the next slice starts after it", async () => {
    ai.replies = ['{"body":"b1","closing":"c1"}', '{"body":"b2","closing":'];
    const r = await draft();
    expect(r.status).toBe(200);
    // row 1 was drafted and paid for — kept
    expect((r.json.documents as Array<{ values: Row; sourceRow: number }>).map((d) => [d.sourceRow, d.values.body])).toEqual([[1, "b1"]]);
    // row 2 produced no document — never one with blank AI sections — and is named
    expect(r.json.skippedRows).toEqual([{ row: 2, reason: "the reply's JSON did not parse (a reply cut off at its length limit does this)" }]);
    expect(String(r.json.stopped)).toMatch(/draft for row 2 couldn't be read — the reply's JSON did not parse/);
    expect(String(r.json.stopped)).toMatch(/Row 2 was left out — no document with blank AI sections was made/);
    // the slice stopped at the failing row; the next one starts AFTER it
    expect(ai.calls).toBe(2);
    expect(r.json.nextOffset).toBe(2);
    // the failed call was still metered (its tokens were spent), as a failed draft
    expect(ledger().map((x) => x.ok)).toEqual([true, false]);
    expect(ledger()[1]).toMatchObject({ input_tokens: 1000, output_tokens: 200 });
  });

  it("a row that is unreadable on EVERY try cannot hold the batch: each slice moves past it and pays only for new rows", async () => {
    // 25-row slices over 30 rows; row 20's reply is always cut off.
    sheet.rows = Array.from({ length: 30 }, (_, i) => ({ Name: `R${i + 1}` }));
    const ok = (n: number) => `{"body":"b${n}","closing":"c${n}"}`;
    ai.replies = [...Array.from({ length: 19 }, (_, i) => ok(i + 1)), '{"body":"b20","closing":'];
    const first = await draft();
    expect((first.json.documents as Row[])).toHaveLength(19);
    expect(first.json.nextOffset).toBe(20);
    expect((first.json.skippedRows as Row[]).map((x) => x.row)).toEqual([20]);
    expect(ai.calls).toBe(20);
    // the next slice starts at row 21 — rows 1-19 are not drafted (or paid for) again
    ai.replies = Array.from({ length: 10 }, (_, i) => ok(i + 21));
    const second = await draft({ rowOffset: first.json.nextOffset });
    expect((second.json.documents as Array<{ sourceRow: number }>).map((d) => d.sourceRow)).toEqual([21, 22, 23, 24, 25, 26, 27, 28, 29, 30]);
    expect(second.json.nextOffset).toBeNull();
    expect(ai.calls).toBe(30);
    expect(ledger()).toHaveLength(30);
  });

  it("a provider failure part-way (a timeout on row 12 of a slice) keeps rows 1-11 and the next slice starts AT row 12 — nothing paid is drafted twice", async () => {
    sheet.rows = Array.from({ length: 30 }, (_, i) => ({ Name: `R${i + 1}` }));
    const ok = (n: number) => `{"body":"b${n}","closing":"c${n}"}`;
    ai.replies = Array.from({ length: 11 }, (_, i) => ok(i + 1));
    ai.failOn = 12;
    const first = await draft();
    expect(first.status).toBe(200);
    expect((first.json.documents as Array<{ sourceRow: number }>).map((d) => d.sourceRow)).toEqual(Array.from({ length: 11 }, (_, i) => i + 1));
    expect(first.json.nextOffset).toBe(11);
    expect(first.json.skippedRows).toBeUndefined(); // nothing was skipped: row 12 is retried, not left out
    expect(String(first.json.stopped)).toBe("The AI provider failed on row 12: Anthropic timed out — try again. The rows drafted before it are kept; the next batch starts at row 12.");
    // the failed call was settled as a failed, zero-token row; the eleven paid rows stand
    expect(ledger().map((x) => x.ok)).toEqual([...Array(11).fill(true), false]);
    // the next slice drafts from row 12 on — rows 1-11 are not paid for again
    ai.failOn = 0;
    ai.replies = Array.from({ length: 19 }, (_, i) => ok(i + 12));
    const second = await draft({ rowOffset: first.json.nextOffset });
    expect((second.json.documents as Array<{ sourceRow: number }>)[0].sourceRow).toBe(12);
    expect(ai.calls).toBe(12 + 19);
  });

  it("a provider failure on the slice's FIRST row answers with its error — nothing was drafted to keep", async () => {
    ai.failOn = 1;
    ai.failStatus = 429;
    const r = await draft();
    expect(r.status).toBe(429);
    expect(String(r.json.error)).toMatch(/timed out/);
  });

  it("a failing FIRST row still moves the batch on: no documents, the row named, nextOffset past it", async () => {
    ai.replies = ["Sorry, I can't help with that."];
    const r = await draft();
    expect(r.status).toBe(200);
    expect(r.json.documents).toEqual([]);
    expect(r.json.skippedRows).toEqual([{ row: 1, reason: "the reply held no JSON object" }]);
    expect(r.json.nextOffset).toBe(1);
  });

  it("a reply with no JSON object, or one that leaves a field out, fails its row too", async () => {
    ai.replies = ["Sorry, I can't help with that."];
    expect(String((await draft()).json.stopped)).toMatch(/row 1 couldn't be read — the reply held no JSON object/);
    ai.replies = ['{"body":"b1"}'];
    expect(String((await draft()).json.stopped)).toMatch(/the reply left out closing/);
  });

  it("the summary document (one call) answers 502 naming it — nothing blank, nothing else paid for", async () => {
    db.tables.output_templates[0].mode = "summary";
    ai.replies = ['{"body":"b1","closing":'];
    const r = await draft();
    expect(r.status).toBe(502);
    expect(String(r.json.error)).toMatch(/draft for the summary document couldn't be read/);
    expect(String(r.json.error)).toMatch(/nothing was left blank/);
    expect(ai.calls).toBe(1);
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
