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
//     the project, read from the database, and the loop is named; so is a
//     grouping under an existing phase (sixth review pass), which can close a
//     loop through the phase without adding a link.
//   PT SCH-18 / SCH-7 — applyMilestoneMoves reads back each moved row's new
//     updated_at: the lock an Undo of that move sends.
//   PT SCH-17 — deleting a phase promotes its children, removes every link to
//     it, records the prior structure — all or nothing: through the
//     delete_milestone_keep_subtree RPC (20261107), or, without it, the
//     DELETE first and checked. A delete RLS filters to 0 rows changes
//     nothing and writes no MILESTONE_DELETED row.
//   PT SCH-12 — setTaskDuration does its arithmetic in UTC.
//   PT SAF-7  — every captured baseline is listed for drift, newest first.
//
// Driven against an in-memory PostgREST chain mock (vi.hoisted + Proxy).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";

type Row = Record<string, unknown>;
const db = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  writes: [] as Array<{ table: string; method: string; payload: unknown; filters: Array<[string, string, unknown]> }>,
  rpcImpl: null as null | ((fn: string, args: Record<string, unknown>) => { data: unknown; error: unknown }),
  failUpdate: null as null | ((table: string, payload: Row, filters: Array<[string, string, unknown]>) => string | null),
  failSelect: null as null | ((table: string) => { message: string; code?: string } | null),
  // Row-level security on DELETE: false = the policy filters the row out
  // (PostgREST then deletes nothing and returns no error).
  deleteAllowed: null as null | ((table: string, row: Row) => boolean),
  // Row-level security on UPDATE: false = the row is filtered out (0 rows
  // updated, no error — what PostgREST answers).
  updateAllowed: null as null | ((table: string, row: Row) => boolean),
  clock: 0,
}));

function builder(table: string) {
  const state = { op: "select" as "select" | "insert" | "update" | "delete", payload: null as unknown, filters: [] as Array<[string, string, unknown]>, single: false, limit: null as number | null, order: null as null | [string, boolean], range: null as null | [number, number] };
  const match = (r: Row) => state.filters.every(([col, op, val]) => {
    switch (op) {
      case "eq": return r[col] === val;
      case "in": return (val as unknown[]).includes(r[col]);
      case "contains": {
        // JSONB containment: the value arrives as JSON text (see JSONB_COLS).
        const want = typeof val === "string" ? (JSON.parse(val) as unknown[]) : (val as unknown[]);
        return Array.isArray(r[col]) && want.every((v) => (r[col] as unknown[]).includes(v));
      }
      default: return true;
    }
  });
  // PostgREST's wire format: postgrest-js sends an ARRAY `contains` value as a
  // Postgres array literal (cs.{a,b}) — against a JSONB column that is not
  // JSON and the read fails 22P02. Only a JSON string (cs.["a"]) is valid there.
  const JSONB_COLS = new Set(["depends_on"]);
  const badJsonb = () => state.filters.find(([col, op, val]) => op === "contains" && JSONB_COLS.has(col) && typeof val !== "string");
  const exec = () => {
    const t = (db.tables[table] ??= []);
    if (state.op === "select") {
      const err = db.failSelect?.(table);
      if (err) return { data: null, error: err };
      if (badJsonb()) return { data: null, error: { code: "22P02", message: "invalid input syntax for type json" } };
      let out = t.filter(match);
      if (state.order) { const [c, asc] = state.order; out = out.slice().sort((a, b) => (String(a[c]) < String(b[c]) ? -1 : 1) * (asc ? 1 : -1)); }
      if (state.limit != null) out = out.slice(0, state.limit);
      // PostgREST's default row cap: an unranged read returns at most 1,000 rows.
      out = state.range ? out.slice(state.range[0], state.range[1] + 1) : out.slice(0, 1000);
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
      const removed = t.filter((r) => match(r) && (db.deleteAllowed ? db.deleteAllowed(table, r) : true));
      db.tables[table] = t.filter((r) => !removed.includes(r));
      // milestones.parent_id REFERENCES milestones(id) ON DELETE SET NULL.
      if (table === "milestones") for (const r of db.tables[table]) if (removed.some((x) => x.id === r.parent_id)) r.parent_id = null;
      // With .select() PostgREST returns the deleted rows — none when RLS filtered them.
      return { data: removed, error: null };
    }
    db.writes.push({ table, method: "update", payload: state.payload, filters: state.filters.slice() });
    const err = db.failUpdate?.(table, state.payload as Row, state.filters);
    if (err) return { data: null, error: { message: err } };
    const target = t.filter((r) => match(r) && (db.updateAllowed ? db.updateAllowed(table, r) : true));
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
          case "range": state.range = [args[0] as number, args[1] as number]; break;
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
  planMilestoneDelete, listBaselineCaptures, currentBaselineSummary, baselineHistoryAvailable,
  ImportedRowLockedError, DependencyCycleError, MoveConflictError, MilestoneDeleteRefusedError,
} from "@/lib/milestones";
import { computeTreeMove, reflowNodesFromMilestones } from "@/lib/scheduleReflow";
import type { Milestone } from "@/types/schema";

const ORG = "org1", PROJECT = "prj1", USER = "u1";
const ms = () => db.tables.milestones ?? [];
const row = (o: Row): Row => ({ org_id: ORG, project_id: PROJECT, status: "planned", source: "manual", depends_on: [], ...o });

beforeEach(() => {
  db.tables = {}; db.writes = []; db.rpcImpl = null; db.failUpdate = null; db.failSelect = null; db.deleteAllowed = null; db.updateAllowed = null;
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

// PT SCH-13 (review): the engine re-enveloped imported PARENTS, so every move in
// a project holding an imported summary whose stored span differs from its
// children's — or a manual task under an imported phase — was refused whole.
// Driven end to end: the board's engine computes the change set, the writer
// writes it.
describe("SCH-13 · manual moves in a project with imported summaries are written", () => {
  const seed = () => {
    db.tables.milestones = [
      row({ id: "IP", name: "Unit 100 (MSP summary)", source: "msproject", is_summary: true, parent_id: null, planned_start_at: "2026-03-01T08:00:00.000Z", planned_at: "2026-03-10T17:00:00.000Z", updated_at: "2026-02-01T00:00:00+00:00" }),
      row({ id: "i1", name: "Imported one", source: "msproject", parent_id: "IP", planned_start_at: "2026-03-01T08:00:00.000Z", planned_at: "2026-03-05T17:00:00.000Z", updated_at: "2026-02-01T00:00:00+00:00" }),
      row({ id: "i2", name: "Imported two", source: "msproject", parent_id: "IP", planned_start_at: "2026-03-06T08:00:00.000Z", planned_at: "2026-03-09T17:00:00.000Z", updated_at: "2026-02-01T00:00:00+00:00" }),
      row({ id: "mc", name: "Manual under the imported phase", parent_id: "IP", planned_start_at: "2026-03-08T08:00:00.000Z", planned_at: "2026-03-09T17:00:00.000Z", updated_at: "2026-02-02T00:00:00+00:00" }),
      row({ id: "m", name: "Unrelated manual task", parent_id: null, planned_start_at: "2026-04-01T08:00:00.000Z", planned_at: "2026-04-02T17:00:00.000Z", updated_at: "2026-02-03T00:00:00+00:00" }),
    ];
  };
  const asMilestones = (): Milestone[] => ms().map((r) => ({
    id: r.id as string, orgId: ORG, projectId: PROJECT, name: r.name as string, weight: 1, status: "planned", createdBy: USER,
    source: r.source as Milestone["source"], parentId: (r.parent_id as string | null) ?? null, isSummary: !!r.is_summary,
    plannedStartAt: r.planned_start_at as string, plannedAt: r.planned_at as string, updatedAt: r.updated_at as string,
  }));
  const write = async (id: string, days: number) => {
    const list = asMilestones();
    const changes = computeTreeMove(reflowNodesFromMilestones(list), id, days);
    const stamp = new Map(list.map((m) => [m.id, m.updatedAt as string]));
    let sent: Row[] = [];
    db.rpcImpl = (_fn, args) => { sent = args.p_moves as Row[]; return { data: { count: sent.length, matched: sent.map((x) => x.id), unmatched: [] }, error: null }; };
    const res = await applyMilestoneMoves({ orgId: ORG, projectId: PROJECT, actorUserId: USER, moves: changes.map((c) => ({ ...c, expectedUpdatedAt: stamp.get(c.id) })) });
    return { res, sent };
  };
  it("dragging an unrelated manual task beside a mismatched imported summary is written (was: refused, “1 of these tasks comes from MS Project”)", async () => {
    seed();
    const { res, sent } = await write("m", 2);
    expect(sent.map((x) => x.id)).toEqual(["m"]);
    expect(res).toMatchObject({ matched: ["m"], unmatched: [] });
  });
  it("moving a manual task under an imported phase past the phase's finish is written; the phase is not", async () => {
    seed();
    const { res, sent } = await write("mc", 5);
    expect(sent.map((x) => x.id)).toEqual(["mc"]);
    expect(sent[0]).toMatchObject({ start: "2026-03-13T08:00:00.000Z", finish: "2026-03-14T17:00:00.000Z" });
    expect(res.matched).toEqual(["mc"]);
  });
  it("setTaskDuration under an imported phase writes the task and never the imported phase (the lock applyMilestoneMoves enforces)", async () => {
    seed();
    const res = await setTaskDuration({ id: "mc", days: 12, actorUserId: USER }); // starts 02-26, before the phase
    expect(res.ok).toBe(true);
    const updated = db.writes.filter((w) => w.method === "update").map((w) => w.filters.find(([c]) => c === "id")?.[2]);
    expect(updated).toEqual(["mc"]);
    expect(ms().find((r) => r.id === "IP")!.planned_start_at).toBe("2026-03-01T08:00:00.000Z");
  });
  it("grouping under an imported phase is refused before any write — it would not follow tasks added here", async () => {
    seed();
    const grp = await groupTasksUnderParent({ orgId: ORG, projectId: PROJECT, parentId: "IP", childIds: ["m"], actorUserId: USER });
    expect(grp.errors[0]).toMatch(/“Unit 100 \(MSP summary\)” comes from MS Project: its dates are set there .*Nothing was grouped/);
    expect(grp.childCount).toBe(0);
    expect(db.writes).toEqual([]);
  });
});

// PT SCH-7 (review): the lock used to leave a batch half-applied — the RPC
// moved the rows that matched and skipped the stale ones, breaking the
// cascade's links. A row already stale when the batch is read is now caught
// BEFORE the write, and the whole batch is refused.
describe("SCH-7 · a stale view is refused whole, before anything is written", () => {
  const seed = () => {
    db.tables.milestones = [
      row({ id: "a", name: "Weld", planned_at: "2026-06-03T17:00:00Z", planned_start_at: "2026-06-01T08:00:00Z", updated_at: "2026-05-01T00:00:00+00:00" }),
      row({ id: "b", name: "NDE", planned_at: "2026-06-05T17:00:00Z", planned_start_at: "2026-06-04T08:00:00Z", updated_at: "2026-05-09T10:00:00.123456+00:00" }),
    ];
  };
  const moves = [
    { id: "a", plannedStartAt: "2026-06-02T08:00:00Z", plannedAt: "2026-06-04T17:00:00Z", expectedUpdatedAt: "2026-05-01T00:00:00+00:00" },
    { id: "b", plannedStartAt: "2026-06-05T08:00:00Z", plannedAt: "2026-06-06T17:00:00Z", expectedUpdatedAt: "2026-05-02T00:00:00+00:00" }, // a colleague saved since
  ];
  it("returns every stale row in `unmatched`, `refused` set, nothing matched — and the RPC is never called", async () => {
    seed();
    let rpcCalled = false;
    db.rpcImpl = () => { rpcCalled = true; return { data: { count: 1, matched: ["a"], unmatched: ["b"] }, error: null }; };
    const res = await applyMilestoneMoves({ orgId: ORG, projectId: PROJECT, actorUserId: USER, moves, onUnmatched: "return" });
    expect(res).toMatchObject({ matched: [], unmatched: ["b"], count: 0, refused: true });
    expect(rpcCalled).toBe(false);
    expect(db.writes).toEqual([]); // no breadcrumb, no audit row: nothing moved
  });
  it("by default it throws, and says nothing was moved", async () => {
    seed();
    const err = await applyMilestoneMoves({ orgId: ORG, projectId: PROJECT, actorUserId: USER, moves }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(MoveConflictError);
    expect((err as Error).message).toBe("1 task was changed or removed by someone else since the schedule loaded — nothing was moved. Reload the schedule and try again.");
  });
  it("the same instant written differently is not stale; a row that is gone is", async () => {
    seed();
    db.rpcImpl = (_fn, args) => ({ data: { count: (args.p_moves as Row[]).length, matched: (args.p_moves as Row[]).map((x) => x.id), unmatched: [] }, error: null });
    const same = [moves[0], { ...moves[1], expectedUpdatedAt: "2026-05-09T10:00:00.123456Z" }];
    await expect(applyMilestoneMoves({ orgId: ORG, projectId: PROJECT, actorUserId: USER, moves: same })).resolves.toMatchObject({ matched: ["a", "b"] });
    seed();
    db.tables.milestones = ms().filter((r) => r.id !== "b");
    const gone = await applyMilestoneMoves({ orgId: ORG, projectId: PROJECT, actorUserId: USER, moves: same, onUnmatched: "return" });
    expect(gone).toMatchObject({ matched: [], unmatched: ["b"], refused: true });
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
  it("only the links an edit ADDS are judged: a task inside a loop an old import left can still lose an unrelated link", async () => {
    db.tables.milestones = [
      row({ id: "A", name: "Fit-up", planned_at: "2026-06-01T00:00:00Z", depends_on: ["B", "C"] }),
      row({ id: "B", name: "Weld", planned_at: "2026-06-02T00:00:00Z", depends_on: ["A"] }), // the stored loop A ↔ B
      row({ id: "C", name: "Stage", planned_at: "2026-05-30T00:00:00Z" }),
      row({ id: "D", name: "NDE", planned_at: "2026-06-03T00:00:00Z", depends_on: ["B"] }),
    ];
    await updateMilestone({ id: "A", patch: { dependsOn: ["B"] }, updatedBy: USER }); // removing C used to be refused
    expect(ms().find((r) => r.id === "A")!.depends_on).toEqual(["B"]);
    // …but a link the edit adds is still checked: D waits on B, which waits on A.
    await expect(updateMilestone({ id: "A", patch: { dependsOn: ["B", "D"] }, updatedBy: USER })).rejects.toThrow(/That link would make a loop: Fit-up → Weld → NDE → Fit-up/);
  });
  it("on a 2,500-row project the loop through row #2,400 is still caught (the read is paged past the 1,000-row cap)", async () => {
    const filler = Array.from({ length: 2497 }, (_, i) => row({ id: `f${String(i).padStart(4, "0")}`, name: `F${i}`, planned_at: "2026-06-01T00:00:00Z" }));
    db.tables.milestones = [
      ...filler,
      row({ id: "za", name: "Start", planned_at: "2026-06-01T00:00:00Z" }),
      row({ id: "zb", name: "Middle", planned_at: "2026-06-02T00:00:00Z", depends_on: ["za"] }),
      row({ id: "zc", name: "End", planned_at: "2026-06-03T00:00:00Z", depends_on: ["zb"] }),
    ];
    await expect(updateMilestone({ id: "za", patch: { dependsOn: ["zc"] }, updatedBy: USER })).rejects.toThrow(/Start → Middle → End → Start/);
  });
  it("a loop through a PHASE is refused too: a task inside a phase may not wait for the phase's own successor (fifth review pass)", async () => {
    db.tables.milestones = [
      row({ id: "Q", name: "Spool 12", is_summary: true, parent_id: null, planned_at: "2026-06-09T00:00:00Z" }),
      row({ id: "Y", name: "Weld", parent_id: "Q", planned_at: "2026-06-09T00:00:00Z" }),
      row({ id: "Z", name: "Hydrotest", parent_id: null, planned_at: "2026-06-21T00:00:00Z", depends_on: ["Q"] }),
    ];
    const err = await updateMilestone({ id: "Y", patch: { dependsOn: ["Z"] }, updatedBy: USER }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(DependencyCycleError); // was saved: the check walked task-level links only
    expect((err as Error).message).toMatch(/That link would make a loop: Weld → Spool 12 → Hydrotest → Weld/);
    expect(db.writes.filter((w) => w.method === "update")).toEqual([]);
  });
});

// PT SCH-4 / SCH-9 (sixth review pass): grouping under an EXISTING phase
// re-parented the tasks with no loop check, so it could close a loop through
// the phase without adding a link — and every move reaching it was then
// refused — or put a phase inside its own sub-task.
describe("SCH-4 / SCH-9 · grouping under an existing phase is checked for loops, over the whole project, before any write", () => {
  // The reviewer's probe: manual phase "Mechanical" holds a fit-up; Hydrotest
  // waits for Mechanical; a punch rework task waits for Hydrotest.
  const seed = (extra: Row[] = []) => {
    db.tables.milestones = [
      row({ id: "P", name: "Mechanical", is_summary: true, parent_id: null, planned_start_at: "2026-06-01T00:00:00Z", planned_at: "2026-06-05T00:00:00Z" }),
      row({ id: "p1", name: "Spool fit-up", parent_id: "P", planned_start_at: "2026-06-01T00:00:00Z", planned_at: "2026-06-05T00:00:00Z" }),
      row({ id: "X", name: "Hydrotest", parent_id: null, planned_start_at: "2026-06-08T00:00:00Z", planned_at: "2026-06-09T00:00:00Z", depends_on: ["P"] }),
      row({ id: "t", name: "Punch rework", parent_id: null, planned_start_at: "2026-06-10T00:00:00Z", planned_at: "2026-06-11T00:00:00Z", depends_on: ["X"] }),
      ...extra,
    ];
  };
  const updates = () => db.writes.filter((w) => w.method === "update" || w.method === "insert");

  it("the probe: putting the rework task under Mechanical would close a loop through the phase — refused, named, nothing written", async () => {
    seed();
    const grp = await groupTasksUnderParent({ orgId: ORG, projectId: PROJECT, parentId: "P", childIds: ["t"], actorUserId: USER });
    expect(grp.errors).toEqual([
      "Grouping under “Mechanical” would close a loop in the links: “Punch rework” → (its phase) “Mechanical” → “Hydrotest” → “Punch rework”. A task cannot (even indirectly) wait for itself, and every move that reached it would be refused. Nothing was grouped — remove one of these links first, or pick another parent.",
    ]); // was: grouped, and every later drag in Mechanical refused
    expect(grp.childCount).toBe(0);
    expect(updates()).toEqual([]);
    expect(ms().find((r) => r.id === "t")!.parent_id).toBeNull();
    expect(audited.some((a) => a.action === "TASKS_GROUPED")).toBe(false);
  });

  it("a phase grouped under its own sub-task is refused (it would sit inside itself)", async () => {
    seed([row({ id: "Q", name: "Insulation", is_summary: true, parent_id: "p1", planned_at: "2026-06-04T00:00:00Z" })]);
    const grp = await groupTasksUnderParent({ orgId: ORG, projectId: PROJECT, parentId: "Q", childIds: ["P"], actorUserId: USER });
    expect(grp.errors[0]).toBe("“Insulation” sits inside “Mechanical”, one of the selected tasks — grouping “Mechanical” under it would put “Mechanical” inside itself. Nothing was grouped; pick a parent outside the selected tasks.");
    expect(updates()).toEqual([]);
  });

  it("a grouping that closes nothing is written; a selected row that IS the target stays where it is", async () => {
    seed([row({ id: "Q", name: "Insulation", is_summary: true, parent_id: null, planned_at: "2026-06-04T00:00:00Z" })]);
    const grp = await groupTasksUnderParent({ orgId: ORG, projectId: PROJECT, parentId: "Q", childIds: ["t", "Q"], actorUserId: USER });
    expect(grp.errors).toEqual([]);
    expect(grp.childCount).toBe(1);
    expect(ms().find((r) => r.id === "t")!.parent_id).toBe("Q");
    expect(ms().find((r) => r.id === "Q")!.parent_id).toBeNull();
  });

  it("on a 2,500-row project the loop through rows past #1,000 is still caught (the read is paged)", async () => {
    const filler = Array.from({ length: 2497 }, (_, i) => row({ id: `f${String(i).padStart(4, "0")}`, name: `F${i}`, planned_at: "2026-06-01T00:00:00Z" }));
    db.tables.milestones = [
      ...filler,
      row({ id: "zP", name: "Mechanical", is_summary: true, parent_id: null, planned_at: "2026-06-05T00:00:00Z" }),
      row({ id: "zX", name: "Hydrotest", parent_id: null, planned_at: "2026-06-09T00:00:00Z", depends_on: ["zP"] }),
      row({ id: "zt", name: "Punch rework", parent_id: null, planned_at: "2026-06-11T00:00:00Z", depends_on: ["zX"] }),
    ];
    const grp = await groupTasksUnderParent({ orgId: ORG, projectId: PROJECT, parentId: "zP", childIds: ["zt"], actorUserId: USER });
    expect(grp.errors[0]).toMatch(/“Punch rework” → \(its phase\) “Mechanical” → “Hydrotest” → “Punch rework”/);
    expect(updates()).toEqual([]);
  });

  it("a failed read of the project refuses the grouping — nothing written", async () => {
    seed([row({ id: "Q", name: "Insulation", is_summary: true, parent_id: null, planned_at: "2026-06-04T00:00:00Z" })]);
    let n = 0;
    db.failSelect = (table) => (table === "milestones" && ++n === 3 ? { message: "statement timeout" } : null); // the selected rows, the parent, then the project
    const grp = await groupTasksUnderParent({ orgId: ORG, projectId: PROJECT, parentId: "Q", childIds: ["t"], actorUserId: USER });
    expect(grp.errors).toEqual(["Couldn't check the grouping for loops (The database took too long to answer — try again.). Nothing was grouped."]);   // REL-3: a sentence, never the driver text
    expect(updates()).toEqual([]);
  });

  // Review (seventh pass) probe: a loop already in the data — t1 linked to
  // its own phase P, downstream of u through t2 — refused grouping u under
  // an unrelated phase R, "would leave a loop", though the regroup neither
  // closes nor touches it.
  it("a loop already in the data that the regroup does not close does not refuse it; one it closes still does", async () => {
    const stale = (): Row[] => [
      row({ id: "P", name: "Mechanical", is_summary: true, parent_id: null, planned_start_at: "2026-06-01T00:00:00Z", planned_at: "2026-06-05T00:00:00Z" }),
      row({ id: "t1", name: "Fit-up", parent_id: "P", planned_start_at: "2026-06-01T00:00:00Z", planned_at: "2026-06-02T00:00:00Z", depends_on: ["P"] }),
      row({ id: "t2", name: "Weld-out", parent_id: "P", planned_start_at: "2026-06-03T00:00:00Z", planned_at: "2026-06-05T00:00:00Z", depends_on: ["u"] }),
      row({ id: "u", name: "Delivery", parent_id: null, planned_start_at: "2026-05-28T00:00:00Z", planned_at: "2026-05-29T00:00:00Z" }),
      row({ id: "R", name: "Logistics", is_summary: true, parent_id: null, planned_start_at: "2026-05-25T00:00:00Z", planned_at: "2026-05-29T00:00:00Z" }),
    ];
    db.tables.milestones = stale();
    const grp = await groupTasksUnderParent({ orgId: ORG, projectId: PROJECT, parentId: "R", childIds: ["u"], actorUserId: USER });
    expect(grp.errors).toEqual([]); // was: "Grouping under “Logistics” would leave a loop in the links: “Fit-up” → (its phase) “Mechanical” → “Fit-up” …"
    expect(grp.childCount).toBe(1);
    expect(ms().find((r) => r.id === "u")!.parent_id).toBe("R");
    // With the same stale loop in the data, a regroup that closes a NEW one is still refused, and names the new one.
    db.writes = [];
    db.tables.milestones = [...stale(), row({ id: "X", name: "Hydrotest", parent_id: null, planned_start_at: "2026-06-08T00:00:00Z", planned_at: "2026-06-09T00:00:00Z", depends_on: ["P"] }),
      row({ id: "t", name: "Punch rework", parent_id: null, planned_start_at: "2026-06-10T00:00:00Z", planned_at: "2026-06-11T00:00:00Z", depends_on: ["X"] })];
    const bad = await groupTasksUnderParent({ orgId: ORG, projectId: PROJECT, parentId: "P", childIds: ["t"], actorUserId: USER });
    expect(bad.errors[0]).toMatch(/^Grouping under “Mechanical” would close a loop in the links: “Punch rework” → \(its phase\) “Mechanical” → “Hydrotest” → “Punch rework”\./);
    expect(updates()).toEqual([]);
  });

  it("a NEW parent needs no check (no links, only the selected tasks): the rework task is grouped", async () => {
    seed();
    const grp = await groupTasksUnderParent({ orgId: ORG, projectId: PROJECT, parentName: "Rework", childIds: ["t"], actorUserId: USER });
    expect(grp.errors).toEqual([]);
    expect(grp.childCount).toBe(1);
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
  const src = () => readFileSync(join(process.cwd(), "lib/milestones.ts"), "utf8");
  const missing = () => { db.rpcImpl = (fn) => (fn === "delete_milestone_keep_subtree" ? { data: null, error: { code: "PGRST202", message: "Could not find the function public.delete_milestone_keep_subtree(p_id) in the schema cache" } } : { data: null, error: null }); };
  const deletedAudit = () => audited.filter((e) => e.type === "MILESTONE_DELETED");

  describe("through delete_milestone_keep_subtree (20261107: one transaction, the DELETE checked)", () => {
    it("calls the RPC with the id; the audit row records the structure it reports; the client writes nothing itself", async () => {
      seed();
      const calls: Array<[string, Record<string, unknown>]> = [];
      db.rpcImpl = (fn, args) => {
        calls.push([fn, args]);
        return { data: { deleted: true, reparented: 2, unlinked: 1, prior_parent_id: "root", new_parent_id: "root",
          children: [{ id: "k1", name: "Step 1" }, { id: "k2", name: "Step 2" }],
          dependents: [{ id: "x", name: "Handover", depends_on_before: ["P", "k1"] }] }, error: null };
      };
      expect(await deleteMilestone("P", USER)).toEqual({ reparented: 2, unlinked: 1 });
      expect(calls).toEqual([["delete_milestone_keep_subtree", { p_id: "P" }]]);
      expect(db.writes).toEqual([]);
      expect(deletedAudit()[0].details).toMatchObject({
        priorParentId: "root", childrenMovedTo: "root", childCount: 2,
        children: [{ id: "k1", name: "Step 1" }, { id: "k2", name: "Step 2" }],
        dependents: [{ id: "x", name: "Handover", dependsOnBefore: ["P", "k1"] }], dependentCount: 1,
      });
    });
    it("a delete the guard refuses (42501, rolled back in the database) — the message says nothing changed; no audit row", async () => {
      seed();
      db.rpcImpl = () => ({ data: null, error: { code: "42501", message: "You cannot delete this task — nothing was changed" } });
      const err = await deleteMilestone("P", USER).then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(MilestoneDeleteRefusedError);
      expect((err as Error).message).toMatch(/^“Phase 1” was not deleted — you do not have the right to delete it .* Nothing was changed\.$/);
      expect(db.writes).toEqual([]);
      expect(deletedAudit()).toEqual([]);
    });
    it("a permission error that names the function is a refusal, never 'not deployed' — no fallback delete runs", async () => {
      seed();
      db.rpcImpl = () => ({ data: null, error: { code: "42501", message: "permission denied for function delete_milestone_keep_subtree" } });
      await expect(deleteMilestone("P", USER)).rejects.toBeInstanceOf(MilestoneDeleteRefusedError);
      expect(db.writes).toEqual([]);
    });
    it("already gone: nothing to do, no audit row; no answer at all is an error, never a success", async () => {
      seed();
      db.rpcImpl = () => ({ data: { deleted: false, reparented: 0, unlinked: 0, children: [], dependents: [] }, error: null });
      expect(await deleteMilestone("P", USER)).toEqual({ reparented: 0, unlinked: 0 });
      expect(deletedAudit()).toEqual([]);
      db.rpcImpl = () => ({ data: null, error: null });
      await expect(deleteMilestone("P", USER)).rejects.toThrow(/gave no answer — reload the schedule/);
      expect(deletedAudit()).toEqual([]);
    });
  });

  describe("without 20261107: the DELETE runs first and is checked", () => {
    it("children move up to the phase's parent, the link to it is removed, the audit row records the prior structure", async () => {
      seed(); missing();
      const res = await deleteMilestone("P", USER);
      expect(res).toEqual({ reparented: 2, unlinked: 1 });
      expect(db.writes[0]).toMatchObject({ table: "milestones", method: "delete", filters: [["id", "eq", "P"]] }); // the delete is the FIRST write
      expect(ms().find((r) => r.id === "P")).toBeUndefined();
      expect(ms().find((r) => r.id === "k1")!.parent_id).toBe("root");
      expect(ms().find((r) => r.id === "k2")!.parent_id).toBe("root");
      expect(ms().find((r) => r.id === "g1")!.parent_id).toBe("k2");   // grandchildren keep their parent
      expect(ms().find((r) => r.id === "x")!.depends_on).toEqual(["k1"]); // no dangling id
      const a = deletedAudit()[0];
      expect(a.details).toMatchObject({
        priorParentId: "root", childrenMovedTo: "root", childCount: 2,
        children: [{ id: "k1", name: "Step 1" }, { id: "k2", name: "Step 2" }],
        dependents: [{ id: "x", name: "Handover", dependsOnBefore: ["P", "k1"] }],
      });
      expect((a.details as Record<string, unknown>).incomplete).toBeUndefined();
    });
    it("REVIEW BLOCKER: a delete RLS filters to 0 rows changes NOTHING — children, links as they were; no MILESTONE_DELETED row", async () => {
      seed(); missing();
      db.deleteAllowed = (t, r) => !(t === "milestones" && r.id === "P"); // milestones_delete_guard refuses this caller
      const err = await deleteMilestone("P", USER).then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(MilestoneDeleteRefusedError);
      expect((err as Error).message).toMatch(/Nothing was changed\.$/);
      expect(ms().find((r) => r.id === "P")).toBeDefined();
      expect(ms().find((r) => r.id === "k1")!.parent_id).toBe("P");
      expect(ms().find((r) => r.id === "k2")!.parent_id).toBe("P");
      expect(ms().find((r) => r.id === "x")!.depends_on).toEqual(["P", "k1"]);
      expect(db.writes.filter((w) => w.method === "update")).toEqual([]);
      expect(deletedAudit()).toEqual([]);
    });
    it("a top-level phase: its children are left at the top level (the foreign key detached them); only the links are written", async () => {
      seed(); missing();
      db.tables.milestones.find((r) => r.id === "P")!.parent_id = null;
      expect(await deleteMilestone("P", USER)).toEqual({ reparented: 2, unlinked: 1 });
      expect(ms().find((r) => r.id === "k1")!.parent_id).toBeNull();
      expect(db.writes.filter((w) => w.method === "update" && "parent_id" in (w.payload as Row))).toEqual([]);
    });
    it("an unlink that matches 0 rows (RLS, or the task is gone) is named, and neither counted nor audited as unlinked", async () => {
      seed(); missing();
      db.updateAllowed = (t, r) => !(t === "milestones" && r.id === "x");
      await expect(deleteMilestone("P", USER)).rejects.toThrow(/^“Phase 1” was deleted, but the link from “Handover” was not removed \(the task could not be changed, or is gone\) — if it is still there it names the deleted task; remove it in that task's links\.$/);
      expect(ms().find((r) => r.id === "P")).toBeUndefined();
      expect(ms().find((r) => r.id === "k1")!.parent_id).toBe("root"); // the re-parent still went
      expect(ms().find((r) => r.id === "x")!.depends_on).toEqual(["P", "k1"]);
      const a = deletedAudit()[0].details as Record<string, unknown>;
      expect(a.dependents).toEqual([]);
      expect(a.dependentCount).toBe(0);
      expect(a.incomplete).toEqual([expect.stringMatching(/^the link from “Handover” was not removed/)]);
      // Every unlink asks for the row back.
      expect(src()).toMatch(/\.update\(\{ depends_on: next, updated_at: now, updated_by: actorUserId \}\)\s*\.eq\("id", d\.id\)\s*\.select\("id"\)/);
    });
    it("REVIEW BLOCKER (third pass): the dependents read sends JSON for the JSONB depends_on column — the wire format PostgREST accepts", async () => {
      // What the real client puts on the wire (postgrest-js, the version the app ships).
      const urls: string[] = [];
      const client = createClient("http://db.test", "anon", {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        global: { fetch: (async (u: RequestInfo | URL) => { urls.push(String(u)); return new Response("[]", { status: 200, headers: { "content-type": "application/json" } }); }) as typeof fetch },
      });
      const id = "8f2a3c4e-1111-2222-3333-444455556666";
      await client.from("milestones").select("id, name, depends_on").contains("depends_on", JSON.stringify([id])).eq("project_id", "p");
      await client.from("milestones").select("id, name, depends_on").contains("depends_on", [id]).eq("project_id", "p");
      const q = urls.map((u) => decodeURIComponent(new URL(u).search));
      expect(q[0]).toContain(`depends_on=cs.["${id}"]`); // valid JSON: depends_on @> '["<id>"]'
      expect(q[1]).toContain(`depends_on=cs.{${id}}`);   // an array literal — 22P02 against JSONB
      // …and lib/milestones.ts sends the JSON form (the mock above refuses the other with 22P02).
      expect(src()).toMatch(/\.contains\("depends_on", JSON\.stringify\(\[id\]\)\)/);
      expect(src()).not.toMatch(/\.contains\("depends_on", \[/);
    });
    it("a step that fails AFTER the delete says what already happened, and the audit row is still written (with what is incomplete)", async () => {
      seed(); missing();
      db.failUpdate = (_t, p) => ("parent_id" in p ? "permission denied" : null);
      await expect(deleteMilestone("P", USER)).rejects.toThrow(/^“Phase 1” was deleted, but its 2 sub-tasks could not be moved up a level \(permission denied\) — they are at the top level now\.$/);
      expect(ms().find((r) => r.id === "P")).toBeUndefined();
      expect(ms().find((r) => r.id === "x")!.depends_on).toEqual(["k1"]); // the links still went
      const a = deletedAudit()[0];
      expect((a.details as Record<string, unknown>).incomplete).toEqual(["its 2 sub-tasks could not be moved up a level (permission denied) — they are at the top level now"]);
    });
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
  it("baselineHistoryAvailable: true when replaced baselines are kept, false without 20261099, null when it cannot tell (the confirm's 'kept' promise)", async () => {
    db.tables.milestone_baseline_history = [];
    expect(await baselineHistoryAvailable({ orgId: ORG, projectId: PROJECT })).toBe(true);
    db.failSelect = (t) => (t === "milestone_baseline_history" ? { code: "42P01", message: "relation \"milestone_baseline_history\" does not exist" } : null);
    expect(await baselineHistoryAvailable({ orgId: ORG, projectId: PROJECT })).toBe(false);
    db.failSelect = (t) => (t === "milestone_baseline_history" ? { message: "network error" } : null);
    expect(await baselineHistoryAvailable({ orgId: ORG, projectId: PROJECT })).toBeNull();
  });
  it("a database without the history table says so; any other failure is an error, never 'no history'", async () => {
    db.failSelect = (t) => (t === "milestone_baseline_history" ? { code: "42P01", message: "relation \"milestone_baseline_history\" does not exist" } : null);
    expect(await listBaselineCaptures({ orgId: ORG, projectId: PROJECT, milestones: live })).toMatchObject({ historyUnavailable: true });
    db.failSelect = (t) => (t === "milestone_baseline_history" ? { message: "permission denied for table milestone_baseline_history" } : null);
    const res = await listBaselineCaptures({ orgId: ORG, projectId: PROJECT, milestones: live });
    expect(res.error).toBe("You don't have permission to see this.");   // REL-3
    expect(res.captures.map((c) => c.id)).toEqual(["current"]);
  });
});
