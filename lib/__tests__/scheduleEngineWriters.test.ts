// lib/__tests__/scheduleEngineWriters.test.ts
//
// projects Round G — J6b SCHEDULE-ENGINE, the lib/milestones.ts writers:
//
//   PT SCH-13 — imported rows: what the scheduling tool owns (dates, links,
//     place in the outline, planned fields) is locked below the UI —
//     updateMilestone, applyMilestoneMoves, setTaskDuration and
//     groupTasksUnderParent refuse it; status / progress / who did the work
//     stay editable.
//   PT SCH-9  — a new dependency is checked for loops over EVERY milestone of
//     the project, read from the database, and the loop is named.
//   PT SCH-18 / SCH-7 — applyMilestoneMoves reads back each moved row's new
//     updated_at: the lock an Undo of that move sends.
//   PT SCH-17 — deleting a phase promotes its children, removes every link to
//     it, records the prior structure, and stops on a refused step.
//   PT SCH-12 — setTaskDuration does its arithmetic in UTC.
//   PT SAF-7  — every captured baseline is listed for drift, newest first.
//
// Driven against an in-memory PostgREST chain mock (vi.hoisted + Proxy).

import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, unknown>;
const db = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  writes: [] as Array<{ table: string; method: string; payload: unknown; filters: Array<[string, string, unknown]> }>,
  rpcImpl: null as null | ((fn: string, args: Record<string, unknown>) => { data: unknown; error: unknown }),
  failUpdate: null as null | ((table: string, payload: Row, filters: Array<[string, string, unknown]>) => string | null),
  failSelect: null as null | ((table: string) => { message: string; code?: string } | null),
  clock: 0,
}));

function builder(table: string) {
  const state = { op: "select" as "select" | "insert" | "update" | "delete", payload: null as unknown, filters: [] as Array<[string, string, unknown]>, single: false, limit: null as number | null, order: null as null | [string, boolean] };
  const match = (r: Row) => state.filters.every(([col, op, val]) => {
    switch (op) {
      case "eq": return r[col] === val;
      case "in": return (val as unknown[]).includes(r[col]);
      case "contains": return Array.isArray(r[col]) && (val as unknown[]).every((v) => (r[col] as unknown[]).includes(v));
      default: return true;
    }
  });
  const exec = () => {
    const t = (db.tables[table] ??= []);
    if (state.op === "select") {
      const err = db.failSelect?.(table);
      if (err) return { data: null, error: err };
      let out = t.filter(match);
      if (state.order) { const [c, asc] = state.order; out = out.slice().sort((a, b) => (String(a[c]) < String(b[c]) ? -1 : 1) * (asc ? 1 : -1)); }
      if (state.limit != null) out = out.slice(0, state.limit);
      return { data: state.single ? (out[0] ?? null) : out, error: null };
    }
    if (state.op === "insert") {
      const rows = (Array.isArray(state.payload) ? state.payload : [state.payload]) as Row[];
      db.writes.push({ table, method: "insert", payload: rows, filters: [] });
      const out = rows.map((r) => ({ id: r.id ?? `n${t.length + 1}`, ...r }));
      t.push(...out);
      return { data: state.single ? out[0] : out, error: null };
    }
    if (state.op === "delete") {
      db.writes.push({ table, method: "delete", payload: null, filters: state.filters.slice() });
      db.tables[table] = t.filter((r) => !match(r));
      return { data: null, error: null };
    }
    db.writes.push({ table, method: "update", payload: state.payload, filters: state.filters.slice() });
    const err = db.failUpdate?.(table, state.payload as Row, state.filters);
    if (err) return { data: null, error: { message: err } };
    const target = t.filter(match);
    for (const r of target) Object.assign(r, state.payload as Row, table === "milestones" && "planned_at" in (state.payload as Row) ? {} : {});
    return { data: state.single ? (target[0] ?? null) : target, error: null };
  };
  const proxy: unknown = new Proxy({}, {
    get(_t, prop: string) {
      if (prop === "then") return (resolve: (v: unknown) => void) => resolve(exec());
      return (...args: unknown[]) => {
        switch (prop) {
          case "insert": state.op = "insert"; state.payload = args[0]; break;
          case "update": state.op = "update"; state.payload = args[0]; break;
          case "delete": state.op = "delete"; break;
          case "eq": state.filters.push([args[0] as string, "eq", args[1]]); break;
          case "in": state.filters.push([args[0] as string, "in", args[1]]); break;
          case "contains": state.filters.push([args[0] as string, "contains", args[1]]); break;
          case "order": state.order = [args[0] as string, (args[1] as { ascending?: boolean } | undefined)?.ascending !== false]; break;
          case "limit": state.limit = args[0] as number; break;
          case "maybeSingle": case "single": state.single = true; return Promise.resolve(exec());
          default: break;
        }
        return proxy;
      };
    },
  });
  return proxy;
}

vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: (t: string) => builder(t),
    rpc: async (fn: string, args: Record<string, unknown>) => (db.rpcImpl ? db.rpcImpl(fn, args) : { data: null, error: null }),
  },
}));
const audited = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock("@/lib/audit", () => ({
  logAuditAction: vi.fn(async (e: Record<string, unknown>) => { audited.push(e); }),
  logMilestoneEvent: vi.fn(async (e: Record<string, unknown>) => { audited.push(e); }),
}));

import {
  updateMilestone, applyMilestoneMoves, setTaskDuration, groupTasksUnderParent, deleteMilestone,
  planMilestoneDelete, listBaselineCaptures, currentBaselineSummary,
  ImportedRowLockedError, DependencyCycleError,
} from "@/lib/milestones";
import type { Milestone } from "@/types/schema";

const ORG = "org1", PROJECT = "prj1", USER = "u1";
const ms = () => db.tables.milestones ?? [];
const row = (o: Row): Row => ({ org_id: ORG, project_id: PROJECT, status: "planned", source: "manual", depends_on: [], ...o });

beforeEach(() => {
  db.tables = {}; db.writes = []; db.rpcImpl = null; db.failUpdate = null; db.failSelect = null;
  audited.length = 0;
});

describe("SCH-13 · an imported row's plan is locked below the UI; its progress is not", () => {
  const seed = () => {
    db.tables.milestones = [
      row({ id: "imp", name: "Hydrotest", source: "p6", planned_at: "2026-06-05T17:00:00+00:00", planned_start_at: "2026-06-05T08:00:00+00:00", attributes: { source_links: "" }, weight: 1 }),
      row({ id: "man", name: "Punch walk", planned_at: "2026-06-06T00:00:00+00:00", planned_start_at: null }),
    ];
  };
  it("updateMilestone refuses a changed date on an imported row (nothing written) and names the tool", async () => {
    seed();
    const err = await updateMilestone({ id: "imp", patch: { plannedAt: "2026-06-09T17:00:00Z" }, updatedBy: USER }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(ImportedRowLockedError);
    expect((err as Error).message).toMatch(/“Hydrotest” comes from Primavera P6: its finish is set there and the next import writes it back/);
    expect(db.writes.filter((w) => w.method === "update")).toEqual([]);
  });
  it("an edit form that sends every field unchanged, plus a change to who actually did the work, saves only the latter", async () => {
    seed();
    await updateMilestone({
      id: "imp",
      patch: { name: "Hydrotest", plannedAt: "2026-06-05T17:00:00.000Z", plannedStartAt: "2026-06-05T08:00:00Z", weight: 1, actualParty: "Night crew" },
      updatedBy: USER,
    });
    const upd = db.writes.find((w) => w.method === "update")!.payload as Row;
    expect(upd.actual_party).toBe("Night crew");
    expect(Object.keys(upd).filter((k) => ["name", "planned_at", "planned_start_at", "weight"].includes(k))).toEqual([]);
  });
  it("a manual row is edited as before", async () => {
    seed();
    await updateMilestone({ id: "man", patch: { plannedAt: "2026-06-08T00:00:00Z" }, updatedBy: USER });
    expect((db.writes.find((w) => w.method === "update")!.payload as Row).planned_at).toBe("2026-06-08T00:00:00Z");
  });
  it("applyMilestoneMoves refuses a batch that touches an imported row — nothing is moved", async () => {
    seed();
    let rpcCalled = false;
    db.rpcImpl = () => { rpcCalled = true; return { data: { count: 2, matched: ["imp", "man"], unmatched: [] }, error: null }; };
    const err = await applyMilestoneMoves({
      orgId: ORG, projectId: PROJECT, actorUserId: USER,
      moves: [{ id: "man", plannedStartAt: "2026-06-07T00:00:00Z", plannedAt: "2026-06-07T00:00:00Z" }, { id: "imp", plannedStartAt: "2026-06-06T08:00:00Z", plannedAt: "2026-06-06T17:00:00Z" }],
    }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(ImportedRowLockedError);
    expect((err as ImportedRowLockedError).ids).toEqual(["imp"]);
    expect(rpcCalled).toBe(false);
  });
  it("setTaskDuration and groupTasksUnderParent refuse imported rows before any write", async () => {
    seed();
    const dur = await setTaskDuration({ id: "imp", days: 3, actorUserId: USER });
    expect(dur.ok).toBe(false);
    expect(dur.error).toMatch(/comes from Primavera P6/);
    const grp = await groupTasksUnderParent({ orgId: ORG, projectId: PROJECT, parentName: "New phase", childIds: ["man", "imp"], actorUserId: USER });
    expect(grp.errors[0]).toMatch(/1 selected task comes from Primavera P6 \(“Hydrotest”\).*Nothing was grouped/);
    expect(db.writes).toEqual([]); // no parent created, nothing re-parented
  });
});

describe("SCH-9 · a new link is checked for loops over the WHOLE project, from the database", () => {
  it("a loop through a row the board may be hiding is refused and named; a forward link saves", async () => {
    db.tables.milestones = [
      row({ id: "a", name: "Fit-up", planned_at: "2026-06-01T00:00:00Z" }),
      row({ id: "b", name: "Weld (imported)", source: "msproject", planned_at: "2026-06-02T00:00:00Z", depends_on: ["a"] }),
      row({ id: "c", name: "NDE", planned_at: "2026-06-03T00:00:00Z", depends_on: ["b"] }),
    ];
    const err = await updateMilestone({ id: "a", patch: { dependsOn: ["c"] }, updatedBy: USER }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(DependencyCycleError);
    expect((err as Error).message).toMatch(/That link would make a loop: Fit-up → Weld \(imported\) → NDE → Fit-up/);
    expect(db.writes).toEqual([]);
    await updateMilestone({ id: "c", patch: { dependsOn: ["b", "a"] }, updatedBy: USER });
    expect(ms().find((r) => r.id === "c")!.depends_on).toEqual(["b", "a"]);
  });
});

describe("SCH-18 / SCH-7 · a move reports each row's new updated_at (its Undo's lock)", () => {
  it("reads back the moved rows' updated_at after the RPC", async () => {
    db.tables.milestones = [row({ id: "a", name: "A", planned_at: "2026-06-03T17:00:00Z", planned_start_at: "2026-06-01T08:00:00Z", updated_at: "2026-05-01T00:00:00+00:00" })];
    db.rpcImpl = () => {
      Object.assign(ms()[0], { planned_at: "2026-06-04T17:00:00Z", updated_at: "2026-06-30T12:00:00.123+00:00" });
      return { data: { count: 1, matched: ["a"], unmatched: [] }, error: null };
    };
    const res = await applyMilestoneMoves({ orgId: ORG, projectId: PROJECT, actorUserId: USER, moves: [{ id: "a", plannedStartAt: "2026-06-02T08:00:00Z", plannedAt: "2026-06-04T17:00:00Z", expectedUpdatedAt: "2026-05-01T00:00:00+00:00" }] });
    expect(res.updatedAt).toEqual({ a: "2026-06-30T12:00:00.123+00:00" });
  });
});

describe("SCH-17 · deleting a phase never orphans its subtree", () => {
  const seed = () => {
    db.tables.milestones = [
      row({ id: "root", name: "Unit 200", parent_id: null, planned_at: "2026-06-10T00:00:00Z" }),
      row({ id: "P", name: "Phase 1", parent_id: "root", planned_at: "2026-06-05T00:00:00Z" }),
      row({ id: "k1", name: "Step 1", parent_id: "P", planned_at: "2026-06-02T00:00:00Z" }),
      row({ id: "k2", name: "Step 2", parent_id: "P", planned_at: "2026-06-03T00:00:00Z" }),
      row({ id: "g1", name: "Sub-step", parent_id: "k2", planned_at: "2026-06-03T00:00:00Z" }),
      row({ id: "x", name: "Handover", parent_id: "root", planned_at: "2026-06-08T00:00:00Z", depends_on: ["P", "k1"] }),
    ];
  };
  it("the plan the confirm states: children, all descendants, where they go, the links that go", () => {
    seed();
    const list = ms().map((r) => ({ id: r.id as string, name: r.name as string, parentId: r.parent_id as string | null, dependsOn: r.depends_on as string[] }));
    expect(planMilestoneDelete(list, "P")).toEqual({
      children: [{ id: "k1", name: "Step 1" }, { id: "k2", name: "Step 2" }],
      descendants: 3, newParentId: "root", dependents: [{ id: "x", name: "Handover" }],
    });
  });
  it("children move up to the phase's parent, the link to it is removed, the audit row records the prior structure", async () => {
    seed();
    const res = await deleteMilestone("P", USER);
    expect(res).toEqual({ reparented: 2, unlinked: 1 });
    expect(ms().find((r) => r.id === "P")).toBeUndefined();
    expect(ms().find((r) => r.id === "k1")!.parent_id).toBe("root");
    expect(ms().find((r) => r.id === "k2")!.parent_id).toBe("root");
    expect(ms().find((r) => r.id === "g1")!.parent_id).toBe("k2");   // grandchildren keep their parent
    expect(ms().find((r) => r.id === "x")!.depends_on).toEqual(["k1"]); // no dangling id
    const a = audited.find((e) => e.type === "MILESTONE_DELETED")!;
    expect(a.details).toMatchObject({
      priorParentId: "root", childrenMovedTo: "root", childCount: 2,
      children: [{ id: "k1", name: "Step 1" }, { id: "k2", name: "Step 2" }],
      dependents: [{ id: "x", name: "Handover", dependsOnBefore: ["P", "k1"] }],
    });
  });
  it("a refused re-parent stops the delete — the phase is still there", async () => {
    seed();
    db.failUpdate = (_t, p) => ("parent_id" in p ? "permission denied" : null);
    await expect(deleteMilestone("P", USER)).rejects.toThrow(/Could not move the 2 sub-tasks up a level \(permission denied\) — nothing was deleted/);
    expect(ms().find((r) => r.id === "P")).toBeDefined();
    expect(db.writes.filter((w) => w.method === "delete")).toEqual([]);
  });
});

describe("SCH-12 · setTaskDuration in UTC", () => {
  for (const zone of ["America/Los_Angeles", "Pacific/Auckland"]) {
    it(`${zone}: a 3-day task ending 2 Nov starts 31 Oct 00:00Z`, async () => {
      const tz = process.env.TZ;
      try {
        process.env.TZ = zone;
        db.tables.milestones = [row({ id: "t", name: "T", planned_at: "2026-11-02T00:00:00Z", parent_id: null })];
        const res = await setTaskDuration({ id: "t", days: 3, actorUserId: USER });
        expect(res.ok).toBe(true);
        expect(ms()[0].planned_start_at).toBe("2026-10-31T00:00:00.000Z");
      } finally { process.env.TZ = tz; }
    });
  }
});

describe("SAF-7 · every captured baseline is available for drift, newest first", () => {
  const mk = (o: Partial<Milestone>): Milestone => ({ orgId: ORG, name: "t", weight: 1, plannedAt: "2026-06-10T00:00:00Z", status: "planned", source: "manual", createdBy: USER, ...o });
  const live = [
    mk({ id: "a", baselineFinishAt: "2026-06-10T00:00:00Z", baselineSetAt: "2026-06-01T09:00:00Z" }),
    mk({ id: "b", baselineFinishAt: "2026-06-12T00:00:00Z", baselineSetAt: "2026-06-01T09:00:00Z" }),
    mk({ id: "c" }),
  ];
  it("the live baseline's summary names when it was set and over how many tasks (the re-baseline confirm)", () => {
    expect(currentBaselineSummary(live)).toEqual({ setAt: "2026-06-01T09:00:00Z", rowCount: 2 });
    expect(currentBaselineSummary([mk({ id: "z" })])).toBeNull();
  });
  it("the live capture, then each one kept in milestone_baseline_history", async () => {
    db.tables.milestone_baseline_history = [
      { id: "h1", org_id: ORG, project_id: PROJECT, taken_at: "2026-06-01T09:00:00Z", reason: "rebaseline", row_count: 2,
        rows: [{ id: "a", baseline_finish_at: "2026-04-01T00:00:00Z", baseline_set_at: "2026-03-01T08:00:00Z" }, { id: "b", baseline_finish_at: "2026-04-03T00:00:00Z", baseline_set_at: "2026-03-01T08:00:00Z" }] },
      { id: "h0", org_id: ORG, project_id: PROJECT, taken_at: "2026-02-01T09:00:00Z", reason: "clear", row_count: 1,
        rows: [{ id: "a", baseline_finish_at: "2026-03-01T00:00:00Z", baseline_set_at: "2026-01-10T08:00:00Z" }] },
      { id: "other", org_id: ORG, project_id: "elsewhere", taken_at: "2026-06-02T00:00:00Z", reason: "clear", row_count: 1, rows: [] },
    ];
    const res = await listBaselineCaptures({ orgId: ORG, projectId: PROJECT, milestones: live });
    expect(res.captures.map((c) => [c.id, c.setAt, c.retiredBy, c.rowCount])).toEqual([
      ["current", "2026-06-01T09:00:00Z", null, 2],
      ["h1", "2026-03-01T08:00:00Z", "rebaseline", 2],
      ["h0", "2026-01-10T08:00:00Z", "clear", 1],
    ]);
    expect(res.captures[1].finishById.get("a")).toBe("2026-04-01T00:00:00Z");
  });
  it("a database without the history table says so; any other failure is an error, never 'no history'", async () => {
    db.failSelect = (t) => (t === "milestone_baseline_history" ? { code: "42P01", message: "relation \"milestone_baseline_history\" does not exist" } : null);
    expect(await listBaselineCaptures({ orgId: ORG, projectId: PROJECT, milestones: live })).toMatchObject({ historyUnavailable: true });
    db.failSelect = (t) => (t === "milestone_baseline_history" ? { message: "permission denied for table milestone_baseline_history" } : null);
    const res = await listBaselineCaptures({ orgId: ORG, projectId: PROJECT, milestones: live });
    expect(res.error).toMatch(/permission denied/);
    expect(res.captures.map((c) => c.id)).toEqual(["current"]);
  });
});
