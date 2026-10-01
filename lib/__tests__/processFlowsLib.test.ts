// intelligence Round G (I-09) — lib/processFlows.ts, the client side of the
// plant's flow topology: the hand-drawn flow reports what the database made
// of it (FLOW-2), every decision and removal is a CHECKED write (FLOW-3), the
// review list reads every flow newest first in pages (FLOW-9), a missing
// table is "not installed" and a missing column is an error (IRLS-12 limb),
// every asset end is validated against the registry (IRLS-7 / FLOW-6), and
// the reader's confidence is data, never a default (PR-7).

import { describe, it, expect, vi, beforeEach } from "vitest";

type Res = { data: unknown; error: null | { code?: string; message: string }; count?: number };
const db = vi.hoisted(() => ({
  queue: {} as Record<string, Res[]>,
  calls: [] as Array<{ table: string; method: string; args: unknown[] }>,
}));
vi.mock("@/lib/supabase", () => {
  const chain = (table: string): unknown => {
    const h: ProxyHandler<object> = {
      get(_t, prop: string) {
        if (prop === "then") {
          const res = (db.queue[table] ?? []).shift() ?? { data: [], error: null };
          return (resolve: (v: unknown) => void) => resolve(res);
        }
        return (...args: unknown[]) => {
          db.calls.push({ table, method: prop, args });
          if (prop === "maybeSingle") {
            const res = (db.queue[table] ?? []).shift() ?? { data: null, error: null };
            return Promise.resolve(res);
          }
          return new Proxy({}, h);
        };
      },
    };
    return new Proxy({}, h);
  };
  return { supabase: { from: (t: string) => chain(t) } };
});

import {
  createManualFlow, decideFlow, deleteFlow, listProcessFlowsPaged, listProcessFlows, resolveAssetEndpoints,
  countAssetFlows, flowConfidence, isLowConfidence, FlowProposedNotice, flowWriteMessage,
  FLOW_DECIDE_REFUSED, FLOW_DELETE_REFUSED, FLOW_PROPOSED_MESSAGE, FLOW_PAGE, FLOW_READ_CAP,
} from "@/lib/processFlows";

const push = (table: string, ...res: Res[]) => { (db.queue[table] ??= []).push(...res); };
const callsOf = (table: string, method: string) => db.calls.filter((c) => c.table === table && c.method === method);
const input = { orgId: "o1", fromKind: "asset" as const, fromRef: "a1", toKind: "asset" as const, toRef: "a2", userId: "u1", userName: "u1@x.io" };

beforeEach(() => { db.queue = {}; db.calls = []; });

describe("createManualFlow — FLOW-2: the database decides confirmed or proposed, and the caller is told", () => {
  it("a controller's flow lands confirmed (regression pin: hand-drawn flows by a controller work as today)", async () => {
    push("process_flows", { data: { id: "f1", status: "confirmed" }, error: null });
    await expect(createManualFlow(input)).resolves.toBe("confirmed");
    expect(callsOf("process_flows", "insert")[0].args[0]).toMatchObject({ status: "confirmed", origin: "manual", from_ref: "a1", to_ref: "a2" });
  });
  it("a member's flow comes back proposed: a FlowProposedNotice says a controller confirms it (the graph must not draw it as the map)", async () => {
    push("process_flows", { data: { id: "f1", status: "proposed" }, error: null });
    const e = await createManualFlow(input).catch((x) => x);
    expect(e).toBeInstanceOf(FlowProposedNotice);
    expect(e.message).toBe(FLOW_PROPOSED_MESSAGE);
    expect(e.landed).toBe("proposed");
  });
  it("a duplicate pair is a no-op ('exists'); a guard refusal reads as a sentence", async () => {
    push("process_flows", { data: null, error: { code: "23505", message: "duplicate key" } });
    await expect(createManualFlow(input)).resolves.toBe("exists");
    push("process_flows", { data: null, error: { code: "23503", message: "process_flows_endpoint: unit U100 is not a Site Codebook unit — a flow ends at registry equipment or a Site Codebook unit" } });
    await expect(createManualFlow({ ...input, fromKind: "unit", fromRef: "U100" })).rejects.toThrow(/^Unit U100 is not a Site Codebook unit/);
  });
  it("an RLS refusal names who may", () => {
    expect(flowWriteMessage({ code: "42501", message: "new row violates row-level security policy" })).toMatch(/only a document controller/);
  });
});

describe("decideFlow / deleteFlow — FLOW-3: a write RLS filtered out is an error, never a silent success", () => {
  it("a decision that changed no row throws FLOW_DECIDE_REFUSED; one that did returns", async () => {
    push("process_flows", { data: [], error: null });
    await expect(decideFlow("f1", true, { userId: "u1" })).rejects.toThrow(FLOW_DECIDE_REFUSED);
    push("process_flows", { data: [{ id: "f1" }], error: null });
    await expect(decideFlow("f1", true, { userId: "u1" })).resolves.toBeUndefined();
    expect(callsOf("process_flows", "select").length).toBeGreaterThanOrEqual(2);
  });
  it("the guard's 42501 is the person's sentence", async () => {
    push("process_flows", { data: null, error: { code: "42501", message: "process_flows_decide: only a document controller confirms, dismisses or reopens a flow" } });
    await expect(decideFlow("f1", false, { userId: "u1" })).rejects.toThrow("Only a document controller confirms, dismisses or reopens a flow.");
  });
  it("a removal that changed no row throws FLOW_DELETE_REFUSED", async () => {
    push("process_flows", { data: [], error: null });
    await expect(deleteFlow("f1")).rejects.toThrow(FLOW_DELETE_REFUSED);
    push("process_flows", { data: [{ id: "f1" }], error: null });
    await expect(deleteFlow("f1")).resolves.toBeUndefined();
  });
});

describe("listProcessFlowsPaged — FLOW-9: newest first, paged, the cap said", () => {
  it("reads page after page, newest first, until a short page", async () => {
    const page = (n: number, from: number) => Array.from({ length: n }, (_, i) => ({ id: `f${from + i}`, status: "proposed" }));
    push("process_flows", { data: page(FLOW_PAGE, 0), error: null }, { data: page(FLOW_PAGE, FLOW_PAGE), error: null }, { data: page(3, 2 * FLOW_PAGE), error: null });
    const r = await listProcessFlowsPaged("o1");
    expect(r?.flows).toHaveLength(2 * FLOW_PAGE + 3);
    expect(r?.truncated).toBe(false);
    const orders = callsOf("process_flows", "order").slice(0, 2).map((c) => c.args);
    expect(orders).toEqual([["created_at", { ascending: false }], ["id", { ascending: false }]]);
    expect(callsOf("process_flows", "range").map((c) => c.args)).toEqual([[0, 999], [1000, 1999], [2000, 2999]]);
    expect(callsOf("process_flows", "neq")[0].args).toEqual(["status", "dismissed"]);
  });
  it("past the read cap it says so", async () => {
    for (let i = 0; i < FLOW_READ_CAP / FLOW_PAGE; i++) push("process_flows", { data: Array.from({ length: FLOW_PAGE }, (_, j) => ({ id: `${i}-${j}` })), error: null });
    const r = await listProcessFlowsPaged("o1");
    expect(r?.truncated).toBe(true);
    expect(r?.flows).toHaveLength(FLOW_READ_CAP);
  });
  it("IRLS-12 limb: a missing TABLE is null ('not installed'); a missing COLUMN is an error, never 'not installed'", async () => {
    push("process_flows", { data: null, error: { code: "42P01", message: 'relation "process_flows" does not exist' } });
    await expect(listProcessFlows("o1")).resolves.toBeNull();
    push("process_flows", { data: null, error: { code: "PGRST205", message: "Could not find the table 'public.process_flows' in the schema cache" } });
    await expect(listProcessFlows("o1")).resolves.toBeNull();
    push("process_flows", { data: null, error: { code: "42703", message: "column process_flows.x does not exist" } });
    await expect(listProcessFlows("o1")).rejects.toThrow(/column/);
  });
});

describe("resolveAssetEndpoints — IRLS-7 / FLOW-6: an end that names deleted equipment is shown as gone", () => {
  const A = "aaaaaaaa-0000-0000-0000-000000000001", B = "aaaaaaaa-0000-0000-0000-000000000002", GONE = "aaaaaaaa-0000-0000-0000-0000000000ff";
  it("known, looked up (archived marked), gone, and a ref that is not even a uuid", async () => {
    push("assets", { data: [{ id: B, tag: "E-201", archived: true, unit_code: null }], error: null });
    const m = await resolveAssetEndpoints([A, B, GONE, "U100"], new Map([[A, { tag: "V-101", unit_code: "20" }]]));
    expect(m?.get(A)).toEqual({ state: "ok", tag: "V-101", archived: false, unitCode: "20" });
    expect(m?.get(B)).toEqual({ state: "ok", tag: "E-201", archived: true, unitCode: null });
    expect(m?.get(GONE)).toEqual({ state: "missing" });
    expect(m?.get("U100")).toEqual({ state: "missing" });
    expect(callsOf("assets", "in")[0].args).toEqual(["id", [B, GONE]]);
  });
  it("a registry read that fails is null — 'could not check', never 'gone'", async () => {
    push("assets", { data: null, error: { message: "down" } });
    await expect(resolveAssetEndpoints([B])).resolves.toBeNull();
  });
});

describe("countAssetFlows — what deleting or archiving equipment does to its flows (FLOW-6)", () => {
  it("counts both ends; an unreadable count is null, never 0", async () => {
    push("process_flows", { data: null, error: null, count: 3 });
    await expect(countAssetFlows("o1", "a1")).resolves.toBe(3);
    expect(callsOf("process_flows", "or")[0].args[0]).toBe("and(from_kind.eq.asset,from_ref.eq.a1),and(to_kind.eq.asset,to_ref.eq.a1)");
    push("process_flows", { data: null, error: { message: "down" } });
    await expect(countAssetFlows("o1", "a1")).resolves.toBeNull();
  });
});

describe("confidence — PR-7", () => {
  it("unknown stays unknown; only an AI proposal can be low-confidence", () => {
    expect(flowConfidence({ evidence: null })).toBeNull();
    expect(flowConfidence({ evidence: { confidence: 0.73 } })).toBe(0.73);
    expect(isLowConfidence({ origin: "ai", evidence: { confidence: null } })).toBe(true);
    expect(isLowConfidence({ origin: "ai", evidence: { confidence: 0.49 } })).toBe(true);
    expect(isLowConfidence({ origin: "ai", evidence: { confidence: 0.5 } })).toBe(false);
    expect(isLowConfidence({ origin: "manual", evidence: null })).toBe(false);
  });
});
