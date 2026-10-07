// intelligence Round G — I-05: the one cap and meter (lib/ai/usageServer.ts).
//
//   GOV-1 / GOV-5 / ORCH-5 / SEM-2  every op counts toward the month — the
//                                   rollup no longer filters to knowledgeAsk
//   GOV-4   a ledger (or cap) read error refuses (503), never reads as $0;
//           rows written without a cost count at UNPRICED_CALL_USD — never
//           $0, never a lock; the ledger is paged until the exact count (a
//           max-rows setting below the page size never truncates the sum)
//   GOV-3   a stored $0 cap LOCKS — for capReached() outright, and for every
//           legacy `cap > 0 && spent >= cap` gate as soon as anything is spent
//   GOV-14  getCapUsd binds the user id as a value; nothing is spliced into a
//           filter string
//   GOV-13 / ORCH-7  reserve-then-verify: concurrent calls see each other's
//           reservations, at most one of N racing calls at the cap proceeds,
//           a reservation is settled to the real figures or released

import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, unknown>;
const db = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  errors: {} as Record<string, { code?: string; message: string } | undefined>,
  calls: [] as Array<{ table: string; op: string; args: unknown[] }>,
  seq: 0,
  clock: 0,
  /** PostgREST's max-rows: a response never carries more rows than this. */
  maxRows: Infinity,
  /** Simulate a response without `count` (the read must still page to the end). */
  noCount: false,
  /** Runs before each statement (a test changes the ledger between two pages). */
  beforeExec: null as null | ((table: string, action: string) => void),
}));

vi.mock("@/lib/supabaseAdmin", () => {
  function builder(table: string) {
    const filters: Array<(r: Row) => boolean> = [];
    let action: "select" | "insert" | "update" | "delete" = "select";
    let payload: Row | null = null;
    let range: [number, number] | null = null;
    let limit: number | null = null;
    let single = false;
    let wantCount = false;
    const orders: Array<{ col: string; asc: boolean }> = [];
    const exec = () => {
      const err = db.errors[`${table}:${action}`];
      if (err) return { data: null, error: err };
      const rows = (db.tables[table] ??= []);
      if (action === "insert") {
        const row = { id: `r${String(++db.seq).padStart(4, "0")}`, created_at: new Date(Date.now() + ++db.clock).toISOString(), ...payload };
        rows.push(row);
        return { data: single ? { id: row.id } : [row], error: null };
      }
      const hit = rows.filter((r) => filters.every((f) => f(r)));
      if (action === "update") { for (const r of hit) Object.assign(r, payload); return { data: null, error: null }; }
      if (action === "delete") { db.tables[table] = rows.filter((r) => !hit.includes(r)); return { data: null, error: null }; }
      let out = [...hit];
      for (const o of [...orders].reverse()) out.sort((a, b) => (String(a[o.col]) < String(b[o.col]) ? -1 : String(a[o.col]) > String(b[o.col]) ? 1 : 0) * (o.asc ? 1 : -1));
      const total = out.length;
      if (range) out = out.slice(range[0], range[1] + 1);
      if (limit !== null) out = out.slice(0, limit);
      out = out.slice(0, db.maxRows);
      return { data: out, error: null, count: wantCount && !db.noCount ? total : null };
    };
    const b: Record<string, unknown> = {
      select: (...args: unknown[]) => {
        db.calls.push({ table, op: "select", args });
        if ((args[1] as { count?: string } | undefined)?.count === "exact") wantCount = true;
        return b;
      },
      insert: (p: Row) => { action = "insert"; payload = p; db.calls.push({ table, op: "insert", args: [p] }); return b; },
      update: (p: Row) => { action = "update"; payload = p; db.calls.push({ table, op: "update", args: [p] }); return b; },
      delete: () => { action = "delete"; db.calls.push({ table, op: "delete", args: [] }); return b; },
      eq: (c: string, v: unknown) => { db.calls.push({ table, op: "eq", args: [c, v] }); filters.push((r) => r[c] === v); return b; },
      is: (c: string, v: unknown) => { db.calls.push({ table, op: "is", args: [c, v] }); filters.push((r) => (r[c] ?? null) === v); return b; },
      gte: (c: string, v: string) => { db.calls.push({ table, op: "gte", args: [c, v] }); filters.push((r) => String(r[c]) >= v); return b; },
      gt: (c: string, v: string) => { db.calls.push({ table, op: "gt", args: [c, v] }); filters.push((r) => String(r[c]) > v); return b; },
      or: (...args: unknown[]) => { db.calls.push({ table, op: "or", args }); return b; },
      order: (col: string, o?: { ascending?: boolean }) => { orders.push({ col, asc: o?.ascending !== false }); return b; },
      range: (a: number, z: number) => { range = [a, z]; return b; },
      limit: (n: number) => { limit = n; return b; },
      single: () => { single = true; return b; },
      maybeSingle: () => { single = true; return b; },
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve().then(() => {
        db.beforeExec?.(table, action);
        return exec();
      }).then(res, rej),
    };
    return b;
  }
  return { supabaseAdmin: { from: (t: string) => builder(t) } };
});

import {
  getMonthUsage, getMonthUsageByUser, getCapUsd, rollupUsage, capReached, capIsLocked, displayCapUsd,
  reserveWithinCap, settleUsage, releaseUsage, reservationVerdict, recordAskUsage,
  AiUsageUnavailableError, LOCKED_CAP_USD, DEFAULT_MONTHLY_CAP_USD, UNPRICED_CALL_USD, monthStartIso, type UsageRow,
} from "@/lib/ai/usageServer";
import { GovernedCallError } from "@/lib/ai/governedCall";

const NOW = new Date().toISOString();
const row = (over: Partial<UsageRow> & Row): Row => ({
  id: `u${String(++db.seq).padStart(4, "0")}`, created_at: NOW, org_id: "o1", user_id: "u1", op: "knowledgeAsk", model: "chat-model",
  input_tokens: 1000, output_tokens: 100, est_cost_usd: 0.01, ok: true, ...over,
});

beforeEach(() => {
  db.tables = { ai_usage_events: [], ai_usage_limits: [] };
  db.errors = {};
  db.calls = [];
  db.seq = 0;
  db.clock = 0;
  db.maxRows = Infinity;
  db.noCount = false;
  db.beforeExec = null;
});

describe("GOV-1 / SEM-2 / ORCH-5 / GOV-5 — every op counts toward the month", () => {
  it("the rollup equals the sum of knowledgeAsk + knowledgeVision + knowledgeEmbed + flowRead (and orchestrator)", async () => {
    db.tables.ai_usage_events = [
      row({ op: "knowledgeAsk", est_cost_usd: 0.25 }),
      row({ op: "knowledgeVision", est_cost_usd: 1.5 }),
      row({ op: "knowledgeEmbed", est_cost_usd: 0.4, output_tokens: 0 }),
      row({ op: "flowRead", est_cost_usd: 2 }),
      row({ op: "orchestrator", est_cost_usd: 3 }),
      row({ op: "knowledgeAsk", est_cost_usd: 9, user_id: "someone-else" }),
    ];
    const m = await getMonthUsage("o1", "u1");
    expect(m.spentUsd).toBe(7.15);
    expect(m.calls).toBe(5);
    expect(m.asks).toBe(1);
    expect(m.byOp.knowledgeEmbed).toEqual({ spentUsd: 0.4, calls: 1, inputTokens: 1000, outputTokens: 0 });
    // tokens per line (an embedding token is not a chat token), summing to the month's
    expect(m.byOp.knowledgeAsk).toMatchObject({ inputTokens: 1000, outputTokens: 100 });
    expect(Object.values(m.byOp).reduce((n, l) => n + l.inputTokens + l.outputTokens, 0)).toBe(m.inputTokens + m.outputTokens);
    expect(m.byOp.orchestrator.spentUsd).toBe(3);
    // the read carries no op filter at all
    expect(db.calls.some((c) => c.op === "eq" && c.args[0] === "op")).toBe(false);
  });

  it("a knowledgeEmbed row alone moves the number getMonthUsage returns, and can trip the cap", async () => {
    db.tables.ai_usage_events = [row({ op: "knowledgeEmbed", est_cost_usd: 10.5, output_tokens: 0 })];
    const m = await getMonthUsage("o1", "u1");
    expect(m.spentUsd).toBe(10.5);
    expect(capReached(m.spentUsd, DEFAULT_MONTHLY_CAP_USD)).toBe(true);
    // the legacy route shape trips too
    const cap = DEFAULT_MONTHLY_CAP_USD;
    expect(cap > 0 && m.spentUsd >= cap).toBe(true);
  });

  it("an orchestrator row appears in the rolled-up spend and trips the cap (ORCH-5)", async () => {
    db.tables.ai_usage_events = [row({ op: "orchestrator", est_cost_usd: 12 })];
    expect((await getMonthUsage("o1", "u1")).spentUsd).toBe(12);
  });

  it("the team view (getMonthUsageByUser) drops the same filter — every member's every op", async () => {
    db.tables.ai_usage_events = [
      row({ op: "knowledgeVision", est_cost_usd: 1 }),
      row({ op: "drawingLocate", est_cost_usd: 2, user_id: "u2" }),
      row({ op: "knowledgeAsk", est_cost_usd: 0.5, user_id: "u2" }),
    ];
    const team = await getMonthUsageByUser("o1");
    expect(team.get("u1")?.spentUsd).toBe(1);
    expect(team.get("u2")?.spentUsd).toBe(2.5);
    expect(team.get("u2")?.byOp.drawingLocate.spentUsd).toBe(2);
  });

  it("only the current UTC month is read", async () => {
    db.tables.ai_usage_events = [row({ created_at: "2020-01-01T00:00:00.000Z", est_cost_usd: 50 }), row({ est_cost_usd: 1 })];
    expect((await getMonthUsage("o1", "u1")).spentUsd).toBe(1);
    expect(monthStartIso(new Date("2026-10-17T12:00:00Z"))).toBe("2026-10-01T00:00:00.000Z");
  });

  it("the ledger is paged past the 1,000-row cap — a partial sum is not headroom", async () => {
    db.tables.ai_usage_events = Array.from({ length: 2345 }, () => row({ op: "knowledgeEmbed", est_cost_usd: 0.01 }));
    const m = await getMonthUsage("o1", "u1");
    expect(m.calls).toBe(2345);
    expect(m.spentUsd).toBe(23.45);
  });

  it("a max-rows setting below the page size never truncates the sum: a short page is not taken as the last", async () => {
    // A project whose PostgREST max-rows is 500, a member with 800 rows.
    db.maxRows = 500;
    db.tables.ai_usage_events = Array.from({ length: 800 }, () => row({ op: "knowledgeAsk", est_cost_usd: 0.01 }));
    const m = await getMonthUsage("o1", "u1");
    expect(m.calls).toBe(800);
    expect(m.spentUsd).toBe(8);
    // the read asks for the exact count, and stops once a read's count says
    // it holds every row that read matched — paged by key (GOV-15): the
    // first 500 rows are all one instant, so the read goes on through that
    // instant by id (the other 300), then past it (none; every row here
    // shares one instant)
    const selects = db.calls.filter((c) => c.table === "ai_usage_events" && c.op === "select");
    expect(selects.every((c) => (c.args[1] as { count?: string } | undefined)?.count === "exact")).toBe(true);
    expect(selects).toHaveLength(3);
  });

  it("GOV-15: paged by key, not offset — a reservation released or inserted between two pages never skips a row or counts one twice", async () => {
    // 1,500 rows, each at its own instant; PostgREST's max-rows is 1,000.
    const base = Date.parse(monthStartIso()) + 60_000;
    const seed = () => {
      db.calls = [];
      db.tables.ai_usage_events = Array.from({ length: 1500 }, (_, i) => row({
        id: `k${String(i).padStart(5, "0")}`, created_at: new Date(base + i * 1000).toISOString(), est_cost_usd: 0.01,
      }));
    };
    /** Change the ledger between the first page and the next. */
    const betweenPages = (change: () => void) => {
      let selects = 0;
      db.beforeExec = (table, action) => {
        if (table === "ai_usage_events" && action === "select" && ++selects === 2) change();
      };
    };
    db.maxRows = 1000;

    // An early reservation is released after page 1: an offset page would
    // then start one row late and skip k01000.
    seed();
    betweenPages(() => { db.tables.ai_usage_events = db.tables.ai_usage_events.filter((r) => r.id !== "k00005"); });
    let month = (await getMonthUsageByUser("o1")).get("u1")!;
    expect(month.calls).toBe(1500);          // k00005 was read before it went; k01000 is not skipped
    expect(month.spentUsd).toBe(15);

    // A row from a transaction that began before the cursor lands after
    // page 1: an offset page would start one row early and read k00999
    // twice. By key it sorts before the cursor and is read once at most.
    seed();
    betweenPages(() => {
      db.tables.ai_usage_events.push(row({ id: "late", created_at: new Date(base + 10_500).toISOString(), est_cost_usd: 0.01 }));
    });
    month = (await getMonthUsageByUser("o1")).get("u1")!;
    expect(month.calls).toBe(1500);
    expect(month.spentUsd).toBe(15);

    // the keyset reads: the month from its first instant, then from the
    // instant of page 1's last row (k00999, read again on page 2, counted
    // once) — one statement a page, bound filters only, no .or() string
    const starts = db.calls.filter((c) => c.table === "ai_usage_events" && (c.op === "gte" || c.op === "gt"));
    expect(starts.map((c) => [c.op, ...c.args])).toEqual([
      ["gte", "created_at", monthStartIso()],
      ["gte", "created_at", new Date(base + 999 * 1000).toISOString()],
    ]);
    expect(db.calls.filter((c) => c.table === "ai_usage_events" && c.op === "select")).toHaveLength(2);
    expect(db.calls.some((c) => c.table === "ai_usage_events" && c.op === "or")).toBe(false);
  });

  it("GOV-15: the read ceiling is 100,000 ROWS, at about one statement per 1,000 — a month of distinct instants past 50,000 rows is summed, never refused", async () => {
    // was (I-18 before this pass): a same-instant probe after every page
    // spent one of the 100 reads on nothing, so 50,500 rows at distinct
    // instants threw "more than 100000 rows" and every gated call was 503
    const base = Date.parse(monthStartIso()) + 60_000;
    const N = 60_500;
    db.maxRows = 1000;
    db.tables.ai_usage_events = Array.from({ length: N }, (_, i) => row({
      id: `d${String(i).padStart(6, "0")}`, created_at: new Date(base + i * 10).toISOString(), op: "knowledgeEmbed", est_cost_usd: 0.0001,
    }));
    const m = await getMonthUsage("o1", "u1");
    expect(m.calls).toBe(N);
    expect(m.spentUsd).toBe(6.05);
    const selects = db.calls.filter((c) => c.table === "ai_usage_events" && c.op === "select").length;
    // each page re-reads its last row: 999 new rows a statement
    expect(selects).toBe(Math.ceil((N - 1) / 999));
    expect(selects).toBeLessThanOrEqual(Math.ceil(N / 1000) + 1);
  }, 30_000);

  it("GOV-15: exactly 100,000 rows at distinct instants are summed; one more is refused as soon as a count says so, in one statement", async () => {
    const base = Date.parse(monthStartIso()) + 60_000;
    db.maxRows = 1000;
    const seed = (n: number) => {
      db.calls = [];
      db.tables.ai_usage_events = Array.from({ length: n }, (_, i) => row({
        id: `c${String(i).padStart(6, "0")}`, created_at: new Date(base + i * 10).toISOString(), op: "knowledgeEmbed", est_cost_usd: 0.0001,
      }));
    };
    seed(100_000);
    const m = await getMonthUsage("o1", "u1");
    expect(m.calls).toBe(100_000);
    expect(db.calls.filter((c) => c.table === "ai_usage_events" && c.op === "select").length).toBeLessThanOrEqual(101);

    seed(100_001);
    await expect(getMonthUsage("o1", "u1")).rejects.toThrow("the usage ledger holds more than 100000 rows this month");
    expect(db.calls.filter((c) => c.table === "ai_usage_events" && c.op === "select")).toHaveLength(1);
  }, 60_000);

  it("GOV-15: a page that is all one instant is read on through that instant by id, then past it — every row once", async () => {
    // 2,500 rows at one instant between 10 rows before it and 10 after
    const base = Date.parse(monthStartIso()) + 60_000;
    db.maxRows = 1000;
    const at = (ms: number) => new Date(base + ms).toISOString();
    db.tables.ai_usage_events = [
      ...Array.from({ length: 10 }, (_, i) => row({ id: `a${String(i).padStart(4, "0")}`, created_at: at(i), est_cost_usd: 0.01 })),
      ...Array.from({ length: 2500 }, (_, i) => row({ id: `m${String(i).padStart(4, "0")}`, created_at: at(500), est_cost_usd: 0.01 })),
      ...Array.from({ length: 10 }, (_, i) => row({ id: `z${String(i).padStart(4, "0")}`, created_at: at(1000 + i), est_cost_usd: 0.01 })),
    ];
    const m = await getMonthUsage("o1", "u1");
    expect(m.calls).toBe(2520);
    expect(m.spentUsd).toBe(25.2);
    const starts = db.calls.filter((c) => c.table === "ai_usage_events" && (c.op === "gte" || c.op === "gt"))
      .map((c) => `${c.op} ${String(c.args[0])}`);
    // the month; the instant (all one page); its later ids twice; past it
    expect(starts).toEqual(["gte created_at", "gte created_at", "gt id", "gt id", "gt created_at"]);
  });

  it("without a count it still reads until a page comes back empty", async () => {
    db.maxRows = 300;
    db.noCount = true;
    db.tables.ai_usage_events = Array.from({ length: 700 }, () => row({ est_cost_usd: 0.01 }));
    expect((await getMonthUsage("o1", "u1")).calls).toBe(700);
  });

  it("asks and avgPromptTokens describe knowledge questions only; failures are not calls", () => {
    const m = rollupUsage([
      row({ op: "knowledgeAsk", input_tokens: 1000 }) as UsageRow,
      row({ op: "knowledgeAsk", input_tokens: 3000 }) as UsageRow,
      row({ op: "flowRead", input_tokens: 90000 }) as UsageRow,
      row({ op: "knowledgeAsk", ok: false, input_tokens: 0, output_tokens: 0, est_cost_usd: 0 }) as UsageRow,
    ]);
    expect(m.asks).toBe(2);
    expect(m.calls).toBe(3);
    expect(m.avgPromptTokens).toBe(2000);
  });
});

describe("GOV-4 — the gate fails CLOSED", () => {
  it("a ledger read error throws AiUsageUnavailableError (503) — never an empty, $0 ledger", async () => {
    db.errors["ai_usage_events:select"] = { code: "57014", message: "canceling statement due to statement timeout" };
    const err = await getMonthUsage("o1", "u1").catch((e) => e);
    expect(err).toBeInstanceOf(AiUsageUnavailableError);
    // the class every route already maps onto its response
    expect(err).toBeInstanceOf(GovernedCallError);
    expect((err as GovernedCallError).status).toBe(503);
    expect((err as Error).message).toMatch(/statement timeout/);
    await expect(getMonthUsageByUser("o1")).rejects.toBeInstanceOf(AiUsageUnavailableError);
  });

  it("rows written without a cost (recordAskUsage's fallback) count at UNPRICED_CALL_USD — not $0, and not a lock", async () => {
    // $1.00: a frontier-rate call with a 120,000-token prompt and a 16,000-token reply
    expect(UNPRICED_CALL_USD).toBe(1);
    db.tables.ai_usage_events = [row({ input_tokens: null, output_tokens: null, est_cost_usd: null, model: null, op: "flowRead" })];
    const m = await getMonthUsage("o1", "u1");
    expect(m.unpricedCalls).toBe(1);
    expect(m.spentUsd).toBe(1);
    expect(m.byOp.flowRead.spentUsd).toBe(1);
    expect(m.calls).toBe(1);
    // a reservation that fits beside it proceeds — the month is not refused (GOV-4 done-when 2)
    const r = await reserveWithinCap({ orgId: "o1", userId: "u1", op: "graphShape", provider: "anthropic", model: "m", worstCaseUsd: 0.01, capUsd: 10 });
    expect(r.reservedUsd).toBe(0.01);
    // one that does not fit is refused like any other spend (402), naming no migration
    const err = await reserveWithinCap({ orgId: "o1", userId: "u1", op: "graphShape", provider: "anthropic", model: "m", worstCaseUsd: 9.5, capUsd: 10 }).catch((e) => e);
    expect((err as GovernedCallError).status).toBe(402);
    expect((err as Error).message).not.toMatch(/20260916/);
    // a failed call written by the fallback is not counted (nothing was billed)
    expect(rollupUsage([row({ input_tokens: null, output_tokens: null, est_cost_usd: null, ok: false }) as UsageRow]).spentUsd).toBe(0);
  });

  it("tokens without a cost are priced, never zero (an unknown model prices as frontier)", () => {
    const m = rollupUsage([row({ est_cost_usd: null, model: "mystery-model", input_tokens: 1_000_000, output_tokens: 0 }) as UsageRow]);
    expect(m.spentUsd).toBe(5);
    expect(m.unpricedCalls).toBe(0);
  });

  it("a caps read error throws too; only a missing table (pre-migration) means the $10 default", async () => {
    db.errors["ai_usage_limits:select"] = { code: "08006", message: "connection failure" };
    await expect(getCapUsd("o1", "u1")).rejects.toBeInstanceOf(AiUsageUnavailableError);
    db.errors["ai_usage_limits:select"] = { code: "42P01", message: 'relation "ai_usage_limits" does not exist' };
    expect(await getCapUsd("o1", "u1")).toBe(DEFAULT_MONTHLY_CAP_USD);
  });

  it("a metering write against a stale schema cache still lands its base row (and that row reads as unpriced)", async () => {
    db.errors["ai_usage_events:insert"] = { code: "PGRST204", message: "Could not find the 'est_cost_usd' column of 'ai_usage_events' in the schema cache" };
    await recordAskUsage({ orgId: "o1", userId: "u1", provider: "anthropic", model: "m", usage: { inputTokens: 1, outputTokens: 1 }, ok: true, op: "flowRead" });
    const inserts = db.calls.filter((c) => c.table === "ai_usage_events" && c.op === "insert");
    expect(inserts).toHaveLength(2);
    expect(inserts[1].args[0]).not.toHaveProperty("est_cost_usd");
    expect(rollupUsage([inserts[1].args[0] as UsageRow]).unpricedCalls).toBe(1);
  });
});

describe("GOV-3 — a $0 cap locks", () => {
  it("getCapUsd returns LOCKED_CAP_USD for a stored 0 — personal override or org default", async () => {
    db.tables.ai_usage_limits = [{ org_id: "o1", user_id: null, monthly_cap_usd: 0 }];
    expect(await getCapUsd("o1", "u1")).toBe(LOCKED_CAP_USD);
    db.tables.ai_usage_limits = [{ org_id: "o1", user_id: null, monthly_cap_usd: 25 }, { org_id: "o1", user_id: "u1", monthly_cap_usd: "0" }];
    expect(await getCapUsd("o1", "u1")).toBe(LOCKED_CAP_USD);
    expect(await getCapUsd("o1", "u2")).toBe(25);
  });

  it("capReached refuses a locked cap at $0 spent; the legacy `cap > 0 && spent >= cap` gate refuses once anything is spent", () => {
    expect(capIsLocked(LOCKED_CAP_USD)).toBe(true);
    expect(capReached(0, LOCKED_CAP_USD)).toBe(true);
    expect(capReached(0, 10)).toBe(false);
    const legacy = (spent: number, cap: number) => cap > 0 && spent >= cap;
    expect(legacy(0.000001, LOCKED_CAP_USD)).toBe(true);
    // what a stored 0 USED to do through that gate: uncap everything
    expect(legacy(9999, 0)).toBe(false);
    expect(LOCKED_CAP_USD.toFixed(2)).toBe("0.00");
    expect(displayCapUsd(LOCKED_CAP_USD)).toBe(0);
    expect(displayCapUsd(10)).toBe(10);
  });

  it("every legacy `cap > 0 && spent >= cap` gate refuses a locked member at $0 spent — no first call slips through", async () => {
    db.tables.ai_usage_limits = [{ org_id: "o1", user_id: "u1", monthly_cap_usd: 0 }];
    const [month, cap] = await Promise.all([getMonthUsage("o1", "u1"), getCapUsd("o1", "u1")]);
    expect(month.calls).toBe(0);
    expect(cap > 0 && month.spentUsd >= cap).toBe(true);
    expect(month.spentUsd.toFixed(2)).toBe("0.00");
    // an unlocked member with nothing spent still reads exactly 0
    expect((await getMonthUsage("o1", "u2")).spentUsd).toBe(0);
  });

  it("a locked member's reservation is refused (402) before any ledger write", async () => {
    const err = await reserveWithinCap({ orgId: "o1", userId: "u1", op: "graphShape", provider: "anthropic", model: "m", worstCaseUsd: 0.001, capUsd: LOCKED_CAP_USD }).catch((e) => e);
    expect((err as GovernedCallError).status).toBe(402);
    expect((err as Error).message).toMatch(/set to \$0/);
    expect(db.tables.ai_usage_events).toHaveLength(0);
  });
});

describe("GOV-14 — the cap read binds the user id; nothing is spliced into a filter string", () => {
  it("no .or() filter string; the user id travels as an eq value", async () => {
    const hostile = "x,monthly_cap_usd.gte.0";
    db.tables.ai_usage_limits = [{ org_id: "o1", user_id: null, monthly_cap_usd: 7 }, { org_id: "o1", user_id: "victim", monthly_cap_usd: 500 }];
    expect(await getCapUsd("o1", hostile)).toBe(7);
    expect(db.calls.some((c) => c.op === "or")).toBe(false);
    expect(db.calls.some((c) => c.op === "eq" && c.args[0] === "user_id" && c.args[1] === hostile)).toBe(true);
    expect(db.calls.some((c) => c.op === "is" && c.args[0] === "user_id" && c.args[1] === null)).toBe(true);
  });
});

describe("GOV-13 / ORCH-7 — reserve, then call", () => {
  const reserve = (worstCaseUsd: number, capUsd = 10, extra: Partial<Parameters<typeof reserveWithinCap>[0]> = {}) =>
    reserveWithinCap({ orgId: "o1", userId: "u1", op: "orchestrator", provider: "anthropic", model: "chat-model", worstCaseUsd, capUsd, ...extra });

  it("a call whose worst case fits is reserved; the reservation counts toward the month until settled", async () => {
    db.tables.ai_usage_events = [row({ est_cost_usd: 4 })];
    const r = await reserve(1.5);
    expect(r.reservedUsd).toBe(1.5);
    const during = await getMonthUsage("o1", "u1");
    expect(during.spentUsd).toBe(5.5);
    expect(during.reservedUsd).toBe(1.5);
    expect(during.calls).toBe(1); // a reservation is not a call yet
    await settleUsage(r.id, { model: "chat-model", usage: { inputTokens: 100_000, outputTokens: 10_000 }, ok: true });
    const after = await getMonthUsage("o1", "u1");
    expect(after.reservedUsd).toBe(0);
    expect(after.spentUsd).toBe(4.75); // 0.5 + 0.25 at the $5/$25 frontier fallback (an unlisted model)
    expect(after.calls).toBe(2);
  });

  it("a call starting at $9.99 of $10 is refused when its worst case does not fit — no maxTokens past the headroom", async () => {
    db.tables.ai_usage_events = [row({ est_cost_usd: 9.99 })];
    const err = await reserve(0.05).catch((e) => e);
    expect((err as GovernedCallError).status).toBe(402);
    expect((err as Error).message).toMatch(/could cost up to \$0\.05 and \$0\.01 is left of your \$10\.00/);
    expect(db.tables.ai_usage_events).toHaveLength(1); // released
  });

  it("N simultaneous runs at the cap boundary: at most one proceeds (ORCH-7)", async () => {
    db.tables.ai_usage_events = [row({ est_cost_usd: 9 })];
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => reserve(0.8)));
    const ok = results.filter((r) => r.status === "fulfilled");
    expect(ok).toHaveLength(1);
    for (const r of results) if (r.status === "rejected") expect((r.reason as GovernedCallError).status).toBe(402);
    // the losers' reservations are gone; the winner's stands
    expect(db.tables.ai_usage_events.filter((r) => r.input_tokens === null)).toHaveLength(1);
  });

  it("the verdict judges a reservation against the ones made BEFORE it (the earlier racer proceeds, the later one sees it)", () => {
    const rows = [
      row({ est_cost_usd: 9 }) as UsageRow,
      row({ id: "a", created_at: "2026-10-01T00:00:00.001Z", input_tokens: null, output_tokens: null, est_cost_usd: 0.8 }) as UsageRow,
      row({ id: "b", created_at: "2026-10-01T00:00:00.002Z", input_tokens: null, output_tokens: null, est_cost_usd: 0.8 }) as UsageRow,
    ];
    expect(reservationVerdict(rows, { id: "a", reservedUsd: 0.8 }, 10).ok).toBe(true);
    const b = reservationVerdict(rows, { id: "b", reservedUsd: 0.8 }, 10);
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.spentBeforeUsd).toBe(9.8);
  });

  it("a per-user in-flight limit answers 429 for the run beyond it", async () => {
    await reserve(0.01, 10, { maxInFlight: 2 });
    await reserve(0.01, 10, { maxInFlight: 2 });
    const err = await reserve(0.01, 10, { maxInFlight: 2 }).catch((e) => e);
    expect((err as GovernedCallError).status).toBe(429);
    expect(db.tables.ai_usage_events).toHaveLength(2);
  });

  it("a ledger read failure after reserving releases the reservation and refuses (503)", async () => {
    const first = reserve(0.01);
    db.errors["ai_usage_events:select"] = { message: "timeout" };
    await expect(first).rejects.toBeInstanceOf(AiUsageUnavailableError);
    expect(db.tables.ai_usage_events).toHaveLength(0);
  });

  it("a reservation that cannot be written refuses (503) — no unreserved call", async () => {
    db.errors["ai_usage_events:insert"] = { message: "permission denied" };
    await expect(reserve(0.01)).rejects.toBeInstanceOf(AiUsageUnavailableError);
  });

  it("releaseUsage drops a reservation for a call that was never made", async () => {
    const r = await reserve(0.5);
    await releaseUsage(r.id);
    expect((await getMonthUsage("o1", "u1")).spentUsd).toBe(0);
  });
});
