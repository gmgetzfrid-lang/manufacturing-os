// intelligence Round G — I-18 (GOV-13 done-when 3, ORCH-7): /api/orchestrator
// reserves every round of its loop before the round is made, folds every
// round's tokens into the run's ONE metering row, and limits a person's
// runs in flight.
//
// Driven through the real route, the real loop and the REAL meter
// (lib/ai/usageServer: reserveWithinCap / settleUsage / releaseUsage /
// getMonthUsage) over an in-memory ledger that yields between statements as
// a real round trip does, so concurrent runs interleave; everything else is
// the in-memory PostgREST stand-in (./knowledgeFakeDb). The provider is
// scripted (and can be held, to keep calls in flight).
//
//   REGRESSION  an org under its cap with a working key: the same answer,
//               keys and budget, and ONE orchestrator row carrying every
//               round's tokens — nothing left reserved
//   ORCH-7      of N runs started at once at the cap boundary at most one
//               reaches the provider; the rest are refused (402) before any
//               call; a fourth run while three are in flight is 429 —
//               whether the three are waiting on the provider or sit
//               between rounds running a tool (a run's row stays a
//               reservation, carrying what it has spent, until it ends)
//   GOV-13      a round whose worst case no longer fits stops the run there
//               (its spend metered, the stop said) — no further call

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { resetDb, db as fakeDb } from "./knowledgeFakeDb";
import { AGREEMENT_VERSION, estimateCostUsd } from "@/lib/ai/pricing";

type Row = Record<string, unknown>;
const net = vi.hoisted(() => ({
  script: [] as string[],
  usage: [] as Array<{ inputTokens: number; outputTokens: number }>,
  calls: 0,
  /** When set, a provider call waits for it (a call kept in flight). */
  hold: null as null | Promise<void>,
  waiting: 0,
  log: [] as string[],
}));
const ledger = vi.hoisted(() => ({
  tables: { ai_usage_events: [] as Row[], ai_usage_limits: [] as Row[] } as Record<string, Row[]>,
  seq: 0,
  reserved: [] as number[],
}));

vi.mock("@/lib/supabaseAdmin", async () => {
  const { fakeAdmin } = await import("./knowledgeFakeDb");
  /** The two ledger tables: what lib/ai/usageServer reads and writes. */
  function ledgerTable(table: string) {
    const filters: Array<(r: Row) => boolean> = [];
    let action: "select" | "insert" | "update" | "delete" = "select";
    let payload: Row | null = null;
    let range: [number, number] | null = null;
    let limit: number | null = null;
    let single = false;
    let returning = false;
    let wantCount = false;
    const orders: Array<{ col: string; asc: boolean }> = [];
    const exec = () => {
      const rows = (ledger.tables[table] ??= []);
      if (action === "insert") {
        const row: Row = { id: `ev-${String(++ledger.seq).padStart(4, "0")}`, created_at: new Date(Date.now() + ledger.seq).toISOString(), ...payload };
        rows.push(row);
        if (table === "ai_usage_events" && row.input_tokens === null) {
          ledger.reserved.push(Number(row.est_cost_usd));
          net.log.push("reserve");
        }
        const out = returning ? { id: row.id } : null;
        return { data: single ? out : out ? [out] : null, error: null };
      }
      const hit = rows.filter((r) => filters.every((f) => f(r)));
      if (action === "update") { for (const r of hit) Object.assign(r, payload); return { data: null, error: null }; }
      if (action === "delete") { ledger.tables[table] = rows.filter((r) => !hit.includes(r)); return { data: null, error: null }; }
      let out = [...hit];
      for (const o of [...orders].reverse()) out.sort((a, b) => (String(a[o.col]) < String(b[o.col]) ? -1 : String(a[o.col]) > String(b[o.col]) ? 1 : 0) * (o.asc ? 1 : -1));
      if (range) out = out.slice(range[0], range[1] + 1);
      if (limit !== null) out = out.slice(0, limit);
      return { data: single ? (out[0] ?? null) : out, error: null, ...(wantCount ? { count: hit.length } : {}) };
    };
    const b: Record<string, unknown> = {
      select: (_c?: string, o?: { count?: string }) => { if (action !== "select") returning = true; if (o?.count === "exact") wantCount = true; return b; },
      insert: (p: Row) => { action = "insert"; payload = p; return b; },
      update: (p: Row) => { action = "update"; payload = p; return b; },
      delete: () => { action = "delete"; return b; },
      eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return b; },
      is: (c: string, v: unknown) => { filters.push((r) => (r[c] ?? null) === v); return b; },
      gte: (c: string, v: string) => { filters.push((r) => String(r[c]) >= v); return b; },
      gt: (c: string, v: string) => { filters.push((r) => String(r[c]) > v); return b; },
      order: (col: string, o?: { ascending?: boolean }) => { orders.push({ col, asc: o?.ascending !== false }); return b; },
      range: (a: number, z: number) => { range = [a, z]; return b; },
      limit: (n: number) => { limit = n; return b; },
      single: () => { single = true; return b; },
      maybeSingle: () => { single = true; return b; },
      // a real round trip: yield, so runs started together interleave
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
        new Promise((r) => setTimeout(r, 0)).then(exec).then(res, rej),
    };
    return b;
  }
  return {
    supabaseAdmin: {
      from: (t: string) => (t === "ai_usage_events" || t === "ai_usage_limits" ? ledgerTable(t) : fakeAdmin.from(t)),
      rpc: async (fn: string) => ({ data: null, error: { code: "PGRST202", message: `Could not find the function public.${fn}` } }),
      auth: { getUser: async (token: string) => ({ data: { user: { id: token } }, error: null }) },
    },
  };
});
vi.mock("@/lib/ai/providerCall", () => ({
  callAiModel: vi.fn(async () => {
    const i = net.calls++;
    net.log.push("call");
    if (net.hold) { net.waiting++; await net.hold; net.waiting--; }
    return { text: net.script[Math.min(i, net.script.length - 1)] ?? "Done.", usage: net.usage[Math.min(i, net.usage.length - 1)] ?? { inputTokens: 1, outputTokens: 1 } };
  }),
  AiCallError: class AiCallError extends Error { status = 502; },
}));
vi.mock("@/lib/ai/keyVault", () => ({ openAiKey: (k: string) => k }));
vi.mock("@/lib/aiInstructionsServer", () => ({ loadOrgInstructionsBlock: vi.fn(async () => "") }));
vi.mock("@/lib/answerSkillsServer", () => ({
  loadAnswerSkills: vi.fn(async () => ({ block: "", skills: [] })),
  loadAnswerSkillsBlock: vi.fn(async () => ""),
}));
vi.mock("@/lib/audit", () => ({ logAuditAction: vi.fn(async () => {}), logRevisionEvent: vi.fn(async () => {}), logHoldEvent: vi.fn(async () => {}) }));

import { POST } from "@/app/api/orchestrator/route";

const ORG = "o1";
const MODEL = "test-model";
const ask = async (who = "u-1") => {
  const res = await POST(new NextRequest("http://test/api/orchestrator", {
    method: "POST",
    headers: { authorization: `Bearer ${who}`, "content-type": "application/json" },
    body: JSON.stringify({ orgId: ORG, question: "Do we have any standards about pipe supports?" }),
  }));
  return { status: res.status, body: await res.json() as Row };
};
const events = () => ledger.tables.ai_usage_events;

function seed(capUsd: number, people = ["u-1"]) {
  resetDb({
    org_members: people.map((uid) => ({ org_id: ORG, uid, role: "Engineer", roles: ["Engineer"], status: "active", display_name: uid, email: `${uid}@x` })),
    team_members: [], teams: [], collections: [], libraries: [], documents: [], knowledge_documents: [],
    ai_connections: people.map((uid) => ({ org_id: ORG, user_id: uid, provider: "anthropic", model: MODEL, api_key: "sealed" })),
    ai_key_agreements: people.map((uid, i) => ({ id: `ag${i}`, org_id: ORG, user_id: uid, scope: "use", agreement_version: AGREEMENT_VERSION })),
    audit_logs: [], orchestrator_proposals: [], assets: [],
  });
  ledger.tables = { ai_usage_events: [], ai_usage_limits: [{ id: "cap", org_id: ORG, user_id: null, monthly_cap_usd: capUsd }] };
  ledger.reserved = [];
}

beforeEach(() => {
  net.script = ["No documents mention pipe supports."];
  net.usage = [];
  net.calls = 0;
  net.hold = null;
  net.waiting = 0;
  net.log = [];
  seed(1000);
});

describe("REGRESSION — an org under its cap with a working key: the same answer, and ONE metering row per run", () => {
  it("a two-round run answers as before; every round was reserved before it was made; one orchestrator row carries both rounds' tokens, nothing left reserved", async () => {
    // round 1 names a tool that does not exist (a correction round); round 2 answers
    net.script = ['{"tool_name": "no_such_tool", "parameters": {}}', "No documents mention pipe supports."];
    net.usage = [{ inputTokens: 1200, outputTokens: 40 }, { inputTokens: 1500, outputTokens: 60 }];
    const { status, body } = await ask();
    expect(status).toBe(200);
    expect(body.answer).toBe("No documents mention pipe supports.");
    expect(Object.keys(body).sort()).toEqual(["answer", "budget", "model", "pending", "provider", "steps", "stoppedBecause"]);
    expect(body.stoppedBecause).toBeNull();
    // reserve → call, reserve → call: never a call without its reservation first
    expect(net.log).toEqual(["reserve", "call", "reserve", "call"]);
    expect(events()).toHaveLength(1);
    expect(events()[0]).toMatchObject({
      op: "orchestrator", provider: "anthropic", model: MODEL, ok: true, user_id: "u-1", org_id: ORG,
      input_tokens: 2700, output_tokens: 100,
      est_cost_usd: estimateCostUsd(MODEL, { inputTokens: 2700, outputTokens: 100 }),
    });
    expect(body.budget).toEqual({ spentUsd: Math.round(estimateCostUsd(MODEL, { inputTokens: 2700, outputTokens: 100 }) * 100) / 100, capUsd: 1000 });
  });
});

describe("ORCH-7 — concurrent runs cannot all pass the same check", () => {
  it("six runs started at once at the cap boundary: at most ONE reaches the provider; the rest are refused (402) before any call, and leave nothing reserved", async () => {
    // Learn one round's worst case, then leave room for one and a half.
    await ask();
    const worst = ledger.reserved[0];
    expect(worst).toBeGreaterThan(0);
    seed(worst * 1.5);
    net.calls = 0;
    let release!: () => void;
    net.hold = new Promise<void>((r) => { release = r; });
    let answered = 0;
    const N = 6;
    const runs = Array.from({ length: N }, () => ask().then((r) => { answered++; return r; }));
    // free the held call once every run has either reached the provider or been refused
    await new Promise<void>((done) => {
      const tick = () => (answered + net.waiting >= N ? done() : setTimeout(tick, 5));
      tick();
    });
    expect(net.waiting).toBeLessThanOrEqual(1);
    release();
    const results = await Promise.all(runs);
    expect(net.calls).toBeLessThanOrEqual(1);
    const refused = results.filter((r) => r.status === 402);
    expect(refused).toHaveLength(N - net.calls);
    // the reservation's own sentence: its worst case does not fit what is
    // left, or the reservations made before it already reach the cap
    for (const r of refused) {
      expect(String(r.body.error)).toMatch(/This call could cost up to \$[\d.]+ and \$[\d.]+ is left of your \$[\d.]+ monthly AI cap, so it was not made\.|Monthly AI budget reached \(\$[\d.]+ of \$[\d.]+\)\./);
    }
    // the one that ran is metered once; nothing else is left on the ledger
    expect(events()).toHaveLength(net.calls);
    expect(events().every((e) => e.input_tokens !== null)).toBe(true);
  });

  it("a person with three runs in flight is refused a fourth (429), before any call; once one finishes, the next is admitted", async () => {
    let release!: () => void;
    net.hold = new Promise<void>((r) => { release = r; });
    const first = [ask(), ask(), ask()];
    await new Promise<void>((done) => { const t = () => (net.waiting >= 3 ? done() : setTimeout(t, 5)); t(); });
    const fourth = await ask();
    expect(fourth.status).toBe(429);
    expect(String(fourth.body.error)).toMatch(/You already have 3 of these running — wait for one to finish\./);
    expect(net.calls).toBe(3);
    release();
    expect((await Promise.all(first)).map((r) => r.status)).toEqual([200, 200, 200]);
    net.hold = null;
    expect((await ask()).status).toBe(200);
    // three runs and the one after: four rows, none still reserved
    expect(events()).toHaveLength(4);
    expect(events().every((e) => e.input_tokens !== null)).toBe(true);
  });

  it("three runs sitting BETWEEN rounds (their first round settled, a tool running) still count: a fourth is refused (429) before any call", async () => {
    // was (I-18 before this fix pass): each run's row was settled after its
    // first round, so a run running its tools held no reservation and the
    // limit counted only calls waiting on the provider — a fourth, fifth
    // and sixth run were admitted
    net.script = [
      ...Array.from({ length: 3 }, () => '{"tool_name": "query_equipment_by_unit", "parameters": {"unit_name": "U1"}}'),
      "No equipment is registered in U1.",
    ];
    const ROUND1 = { inputTokens: 900, outputTokens: 30 };
    net.usage = [ROUND1, ROUND1, ROUND1, { inputTokens: 1000, outputTokens: 40 }];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let between = 0;
    fakeDb.asyncHooks.push(async (op) => {
      if (op.table === "assets") { between++; await gate; }
    });
    const first = [ask(), ask(), ask()];
    await new Promise<void>((done) => { const t = () => (between >= 3 ? done() : setTimeout(t, 5)); t(); });
    // every run has made its first round and is running its tool: no call
    // at the provider, and each run's row is still a reservation carrying
    // its first round's real cost (not its worst case)
    expect(net.calls).toBe(3);
    expect(net.waiting).toBe(0);
    expect(events()).toHaveLength(3);
    for (const e of events()) {
      expect(e).toMatchObject({ op: "orchestrator", input_tokens: null, output_tokens: null, est_cost_usd: estimateCostUsd(MODEL, ROUND1) });
    }
    const fourth = await ask();
    expect(fourth.status).toBe(429);
    expect(String(fourth.body.error)).toMatch(/You already have 3 of these running — wait for one to finish\./);
    expect(net.calls).toBe(3);
    release();
    const done = await Promise.all(first);
    expect(done.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(done.map((r) => r.body.answer)).toEqual(Array(3).fill("No equipment is registered in U1."));
    // finished runs no longer count: the next is admitted
    expect((await ask()).status).toBe(200);
    // three two-round runs and the one after: four rows, each settled with
    // every round's tokens, none still reserved
    expect(events()).toHaveLength(4);
    expect(events().every((e) => e.input_tokens !== null)).toBe(true);
    expect(events().filter((e) => e.input_tokens === ROUND1.inputTokens + 1000)).toHaveLength(3);
  });

  it("another person's runs are not counted against yours", async () => {
    seed(1000, ["u-1", "u-2"]);
    let release!: () => void;
    net.hold = new Promise<void>((r) => { release = r; });
    const theirs = [ask("u-2"), ask("u-2"), ask("u-2")];
    await new Promise<void>((done) => { const t = () => (net.waiting >= 3 ? done() : setTimeout(t, 5)); t(); });
    net.hold = null;
    expect((await ask("u-1")).status).toBe(200);
    release();
    await Promise.all(theirs);
  });
});

describe("GOV-13 — the loop re-checks headroom between rounds: a round that no longer fits is never made", () => {
  it("round one fits; what it spent leaves no room for round two: the run stops there (200, said), round two is never called, round one is metered", async () => {
    await ask();
    const worst = ledger.reserved[0];
    seed(worst * 1.2);
    net.calls = 0;
    net.log = [];
    net.script = ['{"tool_name": "no_such_tool", "parameters": {}}', "never reached"];
    // round one's real cost: about half its worst case
    const half = { inputTokens: 1, outputTokens: 1 };
    for (let t = 1; estimateCostUsd(MODEL, half) < worst * 0.5; t++) half.inputTokens = t * 1000;
    net.usage = [half];
    const { status, body } = await ask();
    expect(status).toBe(200);
    expect(net.calls).toBe(1);
    expect(body.stoppedBecause).toBe("the monthly AI cap");
    expect(String(body.answer)).toMatch(/^I stopped before the next step: This call could cost up to/);
    expect(events()).toHaveLength(1);
    expect(events()[0]).toMatchObject({ op: "orchestrator", ok: false, input_tokens: half.inputTokens, output_tokens: half.outputTokens });
  });
});
