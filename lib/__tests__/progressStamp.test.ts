// What the saves stamp: a second "done" keeps the finish time; a change
// filed under an earlier shift is stamped then, not now.

import { describe, it, expect, vi, beforeEach } from "vitest";

const state: { cur: Record<string, unknown>; updates: Record<string, unknown>[]; rpc: { data?: unknown; error?: { code: string } | null } } = { cur: {}, updates: [], rpc: { data: "ok", error: null } };
const row = { id: "m1", org_id: "o", project_id: "p", name: "Remove components", status: "completed", percent_complete: 100, weight: 1, source: "manual", created_by: "u" };
const chain = (table: string) => {
  const q: Record<string, unknown> = {};
  let upd: Record<string, unknown> | null = null;
  q.select = () => q; q.eq = () => q; q.insert = () => q;
  q.update = (u: Record<string, unknown>) => { upd = u; state.updates.push(u); return q; };
  q.maybeSingle = async () => ({ data: state.cur, error: null });
  q.single = async () => ({ data: table === "milestones" ? { ...row, ...(upd ?? {}) } : { id: "n", org_id: "o", milestone_id: "m1", kind: "status", created_at: new Date().toISOString() }, error: null });
  return q;
};
vi.mock("@/lib/supabase", () => ({ supabase: { from: (t: string) => chain(t), rpc: async () => state.rpc } }));
vi.mock("@/lib/audit", () => ({ logMilestoneEvent: async () => {}, logAuditAction: async () => {} }));

import { setMilestoneStatus, setMilestoneProgress, creditProgressTo } from "@/lib/milestones";

const actor = { actorUserId: "u" };
beforeEach(() => { state.updates = []; state.rpc = { data: "ok", error: null }; });

describe("a second Done keeps when it was done", () => {
  it("by status", async () => {
    state.cur = { status: "completed", actual_start_at: "2026-10-26T20:00:00Z", first_completed_at: "2026-10-26T23:58:00Z", percent_complete: 100 };
    await setMilestoneStatus({ id: "m1", status: "completed", ...actor });
    expect(state.updates[0]).not.toHaveProperty("actual_at");
    expect(state.updates[0].percent_complete).toBe(100);
  });
  it("by %", async () => {
    state.cur = { status: "completed", actual_start_at: null, first_completed_at: "2026-10-26T23:58:00Z" };
    await setMilestoneProgress({ id: "m1", percentComplete: 100, ...actor });
    expect(state.updates[0]).not.toHaveProperty("actual_at");
  });
  it("finishing an open step still stamps it", async () => {
    state.cur = { status: "in_progress", actual_start_at: "2026-10-26T20:00:00Z", first_completed_at: null };
    await setMilestoneProgress({ id: "m1", percentComplete: 100, ...actor });
    expect(typeof state.updates[0].actual_at).toBe("string");
  });
});

describe("filed under an earlier shift", () => {
  const then = "2026-10-27T00:59:00.000Z";
  it("done then: the finish is stamped then", async () => {
    state.cur = { status: "in_progress", actual_start_at: "2026-10-26T20:00:00Z", first_completed_at: null };
    await setMilestoneProgress({ id: "m1", percentComplete: 100, at: then, ...actor });
    expect(state.updates[0].actual_at).toBe(then);
    expect(state.updates[0].first_completed_at).toBe(then);
  });
  it("started then: the start is stamped then", async () => {
    state.cur = { status: "planned", actual_start_at: null, first_completed_at: null, percent_complete: 0 };
    await setMilestoneStatus({ id: "m1", status: "in_progress", percentComplete: 30, at: then, ...actor });
    expect(state.updates[0].actual_start_at).toBe(then);
  });
  it("re-marking a done step Done for an earlier shift moves the finish there", async () => {
    state.cur = { status: "completed", actual_start_at: "2026-10-26T20:00:00Z", first_completed_at: "2026-10-27T20:27:00Z" };
    await setMilestoneProgress({ id: "m1", percentComplete: 100, at: then, ...actor });
    expect(state.updates[0].actual_at).toBe(then);
  });
  it("the database call: missing function and other answers say so", async () => {
    expect(await creditProgressTo("m1", Date.parse(then))).toBe("ok");
    state.rpc = { data: "changed", error: null };
    expect(await creditProgressTo("m1", Date.parse(then))).toBe("changed");
    state.rpc = { data: null, error: { code: "PGRST202" } };
    expect(await creditProgressTo("m1", Date.parse(then))).toBe("missing");
    state.rpc = { data: null, error: { code: "42501" } };
    expect(await creditProgressTo("m1", Date.parse(then))).toBe("error");
  });
});
