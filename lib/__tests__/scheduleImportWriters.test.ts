// projects Round G — the schedule writers (J6a SCHEDULE-IMPORT):
//
//   PT SCH-2 / SCH-3 / SCH-14 / SCH-16 (GAP-403's engine half) — the importer
//     plans before it writes, preserves local progress by default, keys rows
//     on the parser's stable refs, sets structure to exactly what the file
//     says for the rows it carries, writes in chunks, and refuses the row cap.
//   PC SCHED-9  — shift follows a moved start (updateMilestone).
//   PC SCHED-11 / PT SCH-7 (client half) — applyMilestoneMoves carries the
//     expected updated_at, surfaces unmatched ids, writes per-row reschedule
//     breadcrumbs, and treats the audit insert as a CHECKED write.
//   PC SCHED-3  — setBaseline / clearBaseline are one RPC call each, with the
//     legacy path only when the RPC is absent (and audited even then).
//
// Driven against an in-memory PostgREST chain mock (vi.hoisted state + Proxy).

import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, unknown>;
const db = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  writes: [] as Array<{ table: string; method: string; payload: unknown; filters: Array<[string, string, unknown]> }>,
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  rpcImpl: null as null | ((fn: string, args: Record<string, unknown>) => { data: unknown; error: unknown }),
  failInsert: null as null | ((table: string, row: Row) => string | null),
  failUpdate: null as null | ((table: string, payload: Row) => string | null),
  nextId: 1,
}));

function builder(table: string) {
  const state = { op: "select" as "select" | "insert" | "upsert" | "update", payload: null as unknown, filters: [] as Array<[string, string, unknown]>, range: null as null | [number, number], single: false, upsertOpts: null as unknown };
  const match = (r: Row) => state.filters.every(([col, op, val]) => {
    switch (op) {
      case "eq": return r[col] === val;
      case "in": return (val as unknown[]).includes(r[col]);
      case "is": return val === null ? r[col] == null : r[col] === val;
      case "not-is": return !(val === null ? r[col] == null : r[col] === val);
      default: return true;
    }
  });
  const exec = () => {
    const t = (db.tables[table] ??= []);
    if (state.op === "select") {
      let out = t.filter(match);
      if (state.range) out = out.slice(state.range[0], state.range[1] + 1);
      return { data: state.single ? (out[0] ?? null) : out, error: null };
    }
    if (state.op === "insert" || state.op === "upsert") {
      const list = (Array.isArray(state.payload) ? state.payload : [state.payload]) as Row[];
      db.writes.push({ table, method: state.op, payload: list, filters: [] });
      for (const r of list) { const err = db.failInsert?.(table, r); if (err) return { data: null, error: { message: err } }; }
      const out: Row[] = [];
      for (const r of list) {
        const existing = state.op === "upsert" && r.id ? t.find((x) => x.id === r.id) : undefined;
        if (existing) { Object.assign(existing, r); out.push(existing); continue; }
        const row = { id: `m${db.nextId++}`, ...r };
        t.push(row); out.push(row);
      }
      return { data: state.single ? out[0] : out, error: null };
    }
    // update
    db.writes.push({ table, method: "update", payload: state.payload, filters: state.filters.slice() });
    const err = db.failUpdate?.(table, state.payload as Row);
    if (err) return { data: null, error: { message: err } };
    const target = t.filter(match);
    for (const r of target) Object.assign(r, state.payload as Row);
    return { data: state.single ? (target[0] ?? null) : target, error: null };
  };
  const proxy: unknown = new Proxy({}, {
    get(_t, prop: string) {
      if (prop === "then") return (resolve: (v: unknown) => void) => resolve(exec());
      return (...args: unknown[]) => {
        switch (prop) {
          case "insert": state.op = "insert"; state.payload = args[0]; break;
          case "upsert": state.op = "upsert"; state.payload = args[0]; state.upsertOpts = args[1]; break;
          case "update": state.op = "update"; state.payload = args[0]; break;
          case "eq": state.filters.push([args[0] as string, "eq", args[1]]); break;
          case "in": state.filters.push([args[0] as string, "in", args[1]]); break;
          case "is": state.filters.push([args[0] as string, "is", args[1]]); break;
          case "not": state.filters.push([args[0] as string, `not-${args[1] as string}`, args[2]]); break;
          case "range": state.range = [args[0] as number, args[1] as number]; break;
          case "maybeSingle": case "single": state.single = true; return Promise.resolve(exec());
          default: break; // select / order / other modifiers
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
    rpc: async (fn: string, args: Record<string, unknown>) => {
      db.rpcCalls.push({ fn, args });
      return db.rpcImpl ? db.rpcImpl(fn, args) : { data: null, error: null };
    },
  },
}));
const audited = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock("@/lib/audit", () => ({
  logAuditAction: vi.fn(async (e: Record<string, unknown>) => { audited.push(e); }),
  logMilestoneEvent: vi.fn(async () => {}),
}));

import { importMilestonesFromParsed, applyMilestoneMoves, updateMilestone, setBaseline, clearBaseline } from "@/lib/milestones";
import { parseScheduleFile } from "@/lib/scheduleParsers";
import { shiftForStart, filterMilestones, EMPTY_FILTER } from "@/lib/scheduleFilter";
import type { Milestone } from "@/types/schema";

const ORG = "org-1", PROJECT = "proj-1", USER = "user-1";
const scope = { orgId: ORG, projectId: PROJECT, source: "csv" as const, createdBy: USER };
const milestones = () => db.tables.milestones ?? [];
const byName = (n: string) => milestones().find((r) => r.name === n)!;

beforeEach(() => {
  db.tables = {}; db.writes = []; db.rpcCalls = []; db.rpcImpl = null; db.failInsert = null; db.failUpdate = null; db.nextId = 1;
  audited.length = 0;
});

const fileA = ["Task Name,Start,Finish,% Complete", "Mobilize,2026-01-01,2026-01-02,0", "Scaffold,2026-01-03,2026-01-05,0", "Hydrotest,2026-01-06,2026-01-06,0"].join("\n");
const rowsOf = (csv: string, name = "punch.csv") => parseScheduleFile(name, csv).rows;

describe("SCH-2 · re-import preserves locally recorded progress by default", () => {
  it("first import lands the file's progress; a zero-progress re-import leaves the crew's 60% and in_progress alone", async () => {
    const first = await importMilestonesFromParsed({ ...scope, rows: rowsOf(fileA) });
    expect(first.inserted).toBe(3);
    expect(first.plan).toMatchObject({ added: 3, changed: 0, unchanged: 0, notInFile: 0, localProgressAtRisk: [] });
    // The crew logs progress in the app.
    Object.assign(byName("Scaffold"), { percent_complete: 60, status: "in_progress", actual_start_at: "2026-01-03T00:00:00Z" });
    Object.assign(byName("Mobilize"), { percent_complete: 100, status: "completed", actual_at: "2026-01-02T00:00:00Z" });

    db.writes = [];
    const again = await importMilestonesFromParsed({ ...scope, rows: rowsOf(fileA) });
    expect(again.inserted).toBe(0);
    expect(again.plan).toMatchObject({ added: 0, changed: 0, unchanged: 3, notInFile: 0 });
    expect(again.plan!.localProgressAtRisk.map((r) => [r.name, r.localPercent, r.localStatus, r.filePercent])).toEqual([
      ["Mobilize", 100, "completed", 0], ["Scaffold", 60, "in_progress", 0],
    ]);
    expect(byName("Scaffold")).toMatchObject({ percent_complete: 60, status: "in_progress", actual_start_at: "2026-01-03T00:00:00Z" });
    expect(byName("Mobilize")).toMatchObject({ percent_complete: 100, status: "completed" });
    // Nothing was written at all: every row was unchanged.
    expect(db.writes.filter((w) => w.table === "milestones").length).toBe(0);
  });

  it("a file with NO progress column never touches progress, even on opt-in", async () => {
    await importMilestonesFromParsed({ ...scope, rows: rowsOf(fileA) });
    Object.assign(byName("Scaffold"), { percent_complete: 60, status: "in_progress" });
    const noPct = ["Task Name,Start,Finish", "Mobilize,2026-01-01,2026-01-02", "Scaffold,2026-01-03,2026-01-09", "Hydrotest,2026-01-06,2026-01-06"].join("\n");
    const res = await importMilestonesFromParsed({ ...scope, rows: rowsOf(noPct), overwriteProgress: true });
    // Scaffold's finish moved (2026-01-09) → its content key changed → it is a NEW row; the old one is "not in file", untouched.
    expect(res.plan).toMatchObject({ added: 1, notInFile: 1, localProgressAtRisk: [] });
    expect(byName("Scaffold")).toMatchObject({ percent_complete: 60, status: "in_progress" });
  });

  it("with the explicit opt-in the file's progress replaces the local values (and the plan said so)", async () => {
    await importMilestonesFromParsed({ ...scope, rows: rowsOf(fileA) });
    Object.assign(byName("Scaffold"), { percent_complete: 60, status: "in_progress" });
    const res = await importMilestonesFromParsed({ ...scope, rows: rowsOf(fileA), overwriteProgress: true });
    expect(res.plan).toMatchObject({ changed: 1, unchanged: 2 });
    expect(res.plan!.localProgressAtRisk.map((r) => r.name)).toEqual(["Scaffold"]);
    expect(res.updated).toBe(1);
    expect(byName("Scaffold")).toMatchObject({ percent_complete: 0, status: "planned", actual_start_at: null });
  });

  it("dryRun returns the plan and writes nothing", async () => {
    const res = await importMilestonesFromParsed({ ...scope, rows: rowsOf(fileA), dryRun: true });
    expect(res.plan).toMatchObject({ added: 3, changed: 0, unchanged: 0, notInFile: 0 });
    expect(res.inserted).toBe(0);
    expect(milestones()).toEqual([]);
    expect(db.writes).toEqual([]);
  });
});

describe("SCH-3 · a row inserted at the top leaves every other row's identity AND progress intact (GAP-403 acceptance 1)", () => {
  it("re-import after a top insert: 1 added, 3 unchanged, no row overwritten with its neighbour", async () => {
    await importMilestonesFromParsed({ ...scope, rows: rowsOf(fileA) });
    Object.assign(byName("Hydrotest"), { percent_complete: 100, status: "completed" });
    const idsBefore = new Map(milestones().map((r) => [String(r.name), r.id]));
    const withTop = ["Task Name,Start,Finish,% Complete", "Permit,2025-12-30,2025-12-31,0", ...fileA.split("\n").slice(1)].join("\n");
    const res = await importMilestonesFromParsed({ ...scope, rows: rowsOf(withTop) });
    expect(res.plan).toMatchObject({ added: 1, changed: 0, unchanged: 3, notInFile: 0 });
    expect(res.inserted).toBe(1);
    expect(res.updated).toBe(0);
    for (const [name, id] of idsBefore) expect(byName(name).id).toBe(id);
    expect(byName("Hydrotest")).toMatchObject({ percent_complete: 100, status: "completed" });
    expect(String(byName("Permit").external_ref)).toMatch(/^msp-key:[0-9a-f]{8}$/);
  });

  it("rows the file no longer carries are reported as not-in-file and left untouched — never deleted", async () => {
    await importMilestonesFromParsed({ ...scope, rows: rowsOf(fileA) });
    const filtered = ["Task Name,Start,Finish,% Complete", "Mobilize,2026-01-01,2026-01-02,0"].join("\n");
    const res = await importMilestonesFromParsed({ ...scope, rows: rowsOf(filtered) });
    expect(res.plan).toMatchObject({ added: 0, unchanged: 1, notInFile: 2, notInFileNames: ["Scaffold", "Hydrotest"] });
    expect(milestones().length).toBe(3);
  });
});

describe("SCH-16 · structure is set to exactly what the file says for the rows it carries", () => {
  const linked = ["ID,Task Name,Start,Finish,Outline Level,Predecessors", "1,Phase,2026-01-01,2026-01-10,1,", "2,Design,2026-01-01,2026-01-05,2,", "3,Build,2026-01-06,2026-01-10,2,2"].join("\n");
  it("removing a predecessor upstream and re-importing clears it locally; un-parenting clears the local parent", async () => {
    await importMilestonesFromParsed({ ...scope, source: "msproject", rows: rowsOf(linked, "plan.csv") });
    expect(byName("Build").depends_on).toEqual([byName("Design").id]);
    expect(byName("Build").parent_id).toBe(byName("Phase").id);
    expect(byName("Design").parent_id).toBe(byName("Phase").id);

    const unlinked = ["ID,Task Name,Start,Finish,Outline Level,Predecessors", "1,Phase,2026-01-01,2026-01-10,1,", "2,Design,2026-01-01,2026-01-05,2,", "3,Build,2026-01-06,2026-01-10,1,"].join("\n");
    db.writes = [];
    await importMilestonesFromParsed({ ...scope, source: "msproject", rows: rowsOf(unlinked, "plan.csv") });
    expect(byName("Build").depends_on).toEqual([]);
    expect(byName("Build").parent_id).toBeNull();
    expect(byName("Design").parent_id).toBe(byName("Phase").id); // untouched: nothing changed for it
    const structureWrites = db.writes.filter((w) => w.method === "update" && "parent_id" in (w.payload as Row));
    expect(structureWrites.length).toBe(1); // only the row whose structure changed
  });
});

describe("SCH-14 · caps, chunks, progress and cancel", () => {
  it("refuses more than the row cap with the limit named and writes nothing", async () => {
    const rows = Array.from({ length: 5001 }, (_, i) => ({ name: `T${i}`, plannedAt: "2026-01-01", externalRef: `csv:${i}` }));
    const res = await importMilestonesFromParsed({ ...scope, rows });
    expect(res.errors[0]).toMatch(/5,001 rows; the import limit is 5,000 rows per file/);
    expect(res.inserted).toBe(0);
    expect(milestones()).toEqual([]);
  });

  it("1,000 new rows land in 5 chunked inserts (not 1,000 round trips), with progress reported", async () => {
    const rows = Array.from({ length: 1000 }, (_, i) => ({ name: `T${i}`, plannedAt: "2026-01-01", externalRef: `csv:${i}` }));
    const progress: number[] = [];
    const res = await importMilestonesFromParsed({ ...scope, rows, onProgress: (p) => progress.push(p.done) });
    expect(res.inserted).toBe(1000);
    expect(db.writes.filter((w) => w.table === "milestones" && w.method === "insert").length).toBe(5);
    expect(progress).toEqual([0, 200, 400, 600, 800, 1000]);
    expect(milestones().every((r) => r.import_batch_id === res.batchId)).toBe(true);
  });

  it("cancel between chunks stops the import; rows written so far carry the batch id and the result says so", async () => {
    const rows = Array.from({ length: 450 }, (_, i) => ({ name: `T${i}`, plannedAt: "2026-01-01", externalRef: `csv:${i}` }));
    const ctl = new AbortController();
    const res = await importMilestonesFromParsed({ ...scope, rows, signal: ctl.signal, onProgress: (p) => { if (p.done >= 200) ctl.abort(); } });
    expect(res.cancelled).toBe(true);
    expect(res.inserted).toBe(200);
    expect(res.errors[0]).toMatch(new RegExp(`cancelled after 200 of 450 rows.*batch ${res.batchId}`));
    expect(milestones().length).toBe(200);
  });

  it("a bad row inside a chunk is isolated per row instead of sinking the chunk", async () => {
    db.failInsert = (t, r) => (t === "milestones" && r.name === "T7" ? "invalid input syntax for type timestamp" : null);
    const rows = Array.from({ length: 10 }, (_, i) => ({ name: `T${i}`, plannedAt: "2026-01-01", externalRef: `csv:${i}` }));
    const res = await importMilestonesFromParsed({ ...scope, rows });
    expect(res.inserted).toBe(9);
    expect(res.errors).toEqual(["Row 8: invalid input syntax for type timestamp"]);
  });

  it("a database without 20261097 drops import_batch_id alone and keeps the hierarchy fields", async () => {
    let hits = 0;
    db.failInsert = (t, r) => (t === "milestones" && "import_batch_id" in r ? (hits++, "column \"import_batch_id\" does not exist") : null);
    const res = await importMilestonesFromParsed({ ...scope, rows: rowsOf(fileA) });
    expect(res.inserted).toBe(3);
    expect(hits).toBe(1);
    expect(byName("Scaffold")).toMatchObject({ planned_start_at: "2026-01-03T00:00:00Z", shift: "night" });
    expect("import_batch_id" in byName("Scaffold")).toBe(false);
  });
});

describe("SCHED-9 · shift is one UTC reading, recomputed when a start moves", () => {
  it("the importer labels 08:00 day and 19:00 night regardless of the importer's zone", async () => {
    const xmlRows = [
      { name: "Day job", plannedAt: "2026-06-01T17:00:00Z", plannedStartAt: "2026-06-01T08:00:00Z", externalRef: "msp-uid:1" },
      { name: "Night job", plannedAt: "2026-06-02T05:00:00Z", plannedStartAt: "2026-06-01T19:00:00Z", externalRef: "msp-uid:2" },
    ];
    const tz = process.env.TZ;
    try {
      process.env.TZ = "Asia/Kolkata";
      await importMilestonesFromParsed({ ...scope, source: "msproject", rows: xmlRows });
    } finally { process.env.TZ = tz; }
    expect(byName("Day job").shift).toBe("day");
    expect(byName("Night job").shift).toBe("night");
  });

  it("updateMilestone re-labels a start that crosses 18:00, keeps a hand-set swing, and defers to an explicit shift", async () => {
    db.tables.milestones = [
      { id: "a", org_id: ORG, project_id: PROJECT, name: "A", planned_at: "2026-06-01T17:00:00Z", planned_start_at: "2026-06-01T08:00:00Z", shift: "day", status: "planned", weight: 1, source: "manual", created_by: USER },
      { id: "b", org_id: ORG, project_id: PROJECT, name: "B", planned_at: "2026-06-01T17:00:00Z", planned_start_at: "2026-06-01T08:00:00Z", shift: "swing", status: "planned", weight: 1, source: "manual", created_by: USER },
    ];
    await updateMilestone({ id: "a", patch: { plannedStartAt: "2026-06-01T19:00:00Z" }, updatedBy: USER });
    expect(milestones()[0].shift).toBe("night");
    await updateMilestone({ id: "b", patch: { plannedStartAt: "2026-06-01T19:00:00Z" }, updatedBy: USER });
    expect(milestones()[1].shift).toBe("swing");
    await updateMilestone({ id: "a", patch: { plannedStartAt: "2026-06-01T09:00:00Z", shift: "night" }, updatedBy: USER });
    expect(milestones()[0].shift).toBe("night");
  });

  it("the filter classifies an unlabelled row from its start", () => {
    const mk = (over: Partial<Milestone>): Milestone => ({ orgId: ORG, name: "m", weight: 1, plannedAt: "2026-06-02T05:00:00Z", status: "planned", source: "manual", createdBy: USER, ...over });
    const rows = [mk({ id: "n", plannedStartAt: "2026-06-01T19:00:00Z", shift: null }), mk({ id: "d", plannedStartAt: "2026-06-01T08:00:00Z", shift: null }), mk({ id: "s", plannedStartAt: "2026-06-01T08:00:00Z", shift: "swing" })];
    expect([...filterMilestones(rows, { ...EMPTY_FILTER, shifts: ["night"] })]).toEqual(["n"]);
    expect([...filterMilestones(rows, { ...EMPTY_FILTER, shifts: ["swing"] })]).toEqual(["s"]);
    expect(shiftForStart("2026-06-01T17:59:00Z")).toBe("day");
    expect(shiftForStart("2026-06-01T18:00:00Z")).toBe("night");
    expect(shiftForStart(null)).toBeNull();
  });
});

describe("SCH-7 / SCHED-11 · applyMilestoneMoves", () => {
  const seed = () => {
    db.tables.milestones = [
      { id: "a", org_id: ORG, project_id: PROJECT, name: "A", planned_at: "2026-06-03T17:00:00Z", planned_start_at: "2026-06-01T08:00:00Z", updated_at: "2026-05-01T00:00:00+00:00", status: "planned" },
      { id: "b", org_id: ORG, project_id: PROJECT, name: "B", planned_at: "2026-06-05T17:00:00Z", planned_start_at: "2026-06-04T08:00:00Z", updated_at: "2026-05-02T00:00:00+00:00", status: "in_progress" },
    ];
  };
  const moves = [
    { id: "a", plannedStartAt: "2026-06-03T08:00:00Z", plannedAt: "2026-06-05T17:00:00Z" },
    { id: "b", plannedStartAt: "2026-06-06T08:00:00Z", plannedAt: "2026-06-07T17:00:00Z", expectedUpdatedAt: "2026-04-30T00:00:00+00:00" },
  ];
  const actor = { orgId: ORG, projectId: PROJECT, actorUserId: USER, actorUserName: "Sam", actorUserEmail: "sam@x" };

  it("passes each row's expected updated_at (the caller's, else the row as read) and surfaces the RPC's unmatched ids", async () => {
    seed();
    db.rpcImpl = () => ({ data: { count: 1, matched: ["a"], unmatched: ["b"] }, error: null });
    const res = await applyMilestoneMoves({ ...actor, moves });
    expect(db.rpcCalls[0].fn).toBe("apply_milestone_moves");
    expect((db.rpcCalls[0].args.p_moves as Row[]).map((m) => m.expected_updated_at)).toEqual(["2026-05-01T00:00:00+00:00", "2026-04-30T00:00:00+00:00"]);
    expect(res).toMatchObject({ matched: ["a"], unmatched: ["b"], count: 1, via: "rpc" });
    expect(res.auditError).toBeUndefined();
  });

  it("writes a 'reschedule' breadcrumb per moved row (updateMilestone's shape) and a checked audit row with before/after dates", async () => {
    seed();
    db.rpcImpl = () => ({ data: { count: 2, matched: ["a", "b"], unmatched: [] }, error: null });
    await applyMilestoneMoves({ ...actor, moves });
    const notes = db.tables.milestone_notes ?? [];
    expect(notes.map((n) => [n.milestone_id, n.kind, n.status_at, n.created_by_name])).toEqual([["a", "reschedule", "planned", "Sam"], ["b", "reschedule", "in_progress", "Sam"]]);
    expect(notes[0].body).toMatch(/^Finish \+2 days → /);
    const audit = (db.tables.audit_logs ?? [])[0];
    expect(audit).toMatchObject({ action: "MILESTONES_RESCHEDULED", resource_id: PROJECT, org_id: ORG, user_id: USER });
    const details = audit.details as Row;
    expect(details).toMatchObject({ count: 2, requested: 2, unmatched: 0, shown: 2, total: 2, truncated: false });
    expect(details.moves).toEqual([
      { id: "a", before: { start: "2026-06-01T08:00:00Z", finish: "2026-06-03T17:00:00Z" }, after: { start: "2026-06-03T08:00:00Z", finish: "2026-06-05T17:00:00Z" } },
      { id: "b", before: { start: "2026-06-04T08:00:00Z", finish: "2026-06-05T17:00:00Z" }, after: { start: "2026-06-06T08:00:00Z", finish: "2026-06-07T17:00:00Z" } },
    ]);
  });

  it("a refused audit insert is retried once and then SURFACED, never swallowed; 'showing 50 of N' is explicit", async () => {
    db.tables.milestones = Array.from({ length: 60 }, (_, i) => ({ id: `m${i}`, org_id: ORG, project_id: PROJECT, name: `T${i}`, planned_at: "2026-06-03T17:00:00Z", planned_start_at: null, updated_at: null, status: "planned" }));
    const many = Array.from({ length: 60 }, (_, i) => ({ id: `m${i}`, plannedStartAt: "2026-06-04T08:00:00Z", plannedAt: "2026-06-04T17:00:00Z" }));
    db.rpcImpl = () => ({ data: { count: 60, matched: many.map((m) => m.id), unmatched: [] }, error: null });
    let attempts = 0;
    db.failInsert = (t) => (t === "audit_logs" ? (attempts++, "new row violates row-level security policy") : null);
    const res = await applyMilestoneMoves({ ...actor, moves: many });
    expect(attempts).toBe(2);
    expect(res.auditError).toBe("audit: new row violates row-level security policy");
    // and the payload shape it tried to write
    const tried = db.writes.filter((w) => w.table === "audit_logs").at(-1)!.payload as Row[];
    expect((tried[0].details as Row)).toMatchObject({ shown: 50, total: 60, truncated: true });
  });

  it("accepts the 20260907 INT result and falls back to per-row writes when the RPC is absent", async () => {
    seed();
    db.rpcImpl = () => ({ data: 2, error: null });
    const legacyShape = await applyMilestoneMoves({ ...actor, moves });
    expect(legacyShape).toMatchObject({ matched: ["a", "b"], unmatched: [], count: 2, via: "rpc" });

    seed(); db.rpcCalls = [];
    db.rpcImpl = () => ({ data: null, error: { code: "PGRST202", message: "Could not find the function public.apply_milestone_moves" } });
    const fallback = await applyMilestoneMoves({ ...actor, moves });
    expect(fallback).toMatchObject({ matched: ["a", "b"], via: "rows" });
    expect(milestones()[0].planned_at).toBe("2026-06-05T17:00:00Z");
    expect(milestones()[0].shift).toBe("day"); // updateMilestone recomputed it from 08:00
  });
});

describe("SCHED-3 · baseline is one RPC call each; the legacy path only when the RPC is absent, and audited even then", () => {
  it("setBaseline calls set_project_baseline and returns its count + history id", async () => {
    db.rpcImpl = () => ({ data: { count: 12, previous_rows: 12, history_id: "h1" }, error: null });
    const res = await setBaseline({ orgId: ORG, projectId: PROJECT, actorUserId: USER });
    expect(db.rpcCalls).toEqual([{ fn: "set_project_baseline", args: { p_org: ORG, p_project: PROJECT } }]);
    expect(res).toEqual({ ok: true, count: 12, via: "rpc", historyId: "h1" });
    expect(db.writes).toEqual([]);
    expect(audited).toEqual([]); // the RPC audits itself
  });

  it("a refusal (42501) from the RPC is returned as-is, not retried through the legacy path", async () => {
    db.rpcImpl = () => ({ data: null, error: { code: "42501", message: "You do not have schedule-editing rights on this project" } });
    const res = await setBaseline({ orgId: ORG, projectId: PROJECT, actorUserId: USER });
    expect(res).toEqual({ ok: false, count: 0, error: "You do not have schedule-editing rights on this project", via: "rpc" });
    expect(db.writes).toEqual([]);
  });

  it("legacy path (RPC absent): per-row writes, and a partial result is reported as partial", async () => {
    db.tables.milestones = [
      { id: "a", org_id: ORG, project_id: PROJECT, planned_at: "2026-06-03T17:00:00Z", planned_start_at: null },
      { id: "b", org_id: ORG, project_id: PROJECT, planned_at: "2026-06-05T17:00:00Z", planned_start_at: "2026-06-04T08:00:00Z" },
    ];
    db.rpcImpl = () => ({ data: null, error: { code: "PGRST202", message: "Could not find the function public.set_project_baseline" } });
    db.failUpdate = (_t, p) => (p.baseline_finish_at === "2026-06-05T17:00:00Z" ? "boom" : null);
    const res = await setBaseline({ orgId: ORG, projectId: PROJECT, actorUserId: USER, actorUserEmail: "sam@x" });
    expect(res).toMatchObject({ ok: false, count: 1, via: "legacy" });
    expect(res.error).toMatch(/Baseline applied to 1 of 2 tasks — boom/);
    expect(audited[0]).toMatchObject({ action: "SCHEDULE_BASELINED", details: { count: 1, requested: 2, partial: true } });
  });

  it("clearBaseline calls clear_project_baseline; the legacy path is audited", async () => {
    db.rpcImpl = () => ({ data: { count: 3, previous_rows: 3, history_id: "h2" }, error: null });
    expect(await clearBaseline({ orgId: ORG, projectId: PROJECT, actorUserId: USER })).toEqual({ ok: true, count: 3, via: "rpc" });

    db.tables.milestones = [{ id: "a", org_id: ORG, project_id: PROJECT, baseline_finish_at: "x" }];
    db.rpcImpl = () => ({ data: null, error: { code: "PGRST202", message: "Could not find the function public.clear_project_baseline" } });
    const legacy = await clearBaseline({ orgId: ORG, projectId: PROJECT, actorUserId: USER });
    expect(legacy).toEqual({ ok: true, count: 1, via: "legacy" });
    expect(milestones()[0].baseline_finish_at).toBeNull();
    expect(audited.at(-1)).toMatchObject({ action: "SCHEDULE_BASELINE_CLEARED", details: { count: 1 } });
  });
});
