// @vitest-environment jsdom
//
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
// Driven against an in-memory PostgREST chain mock (vi.hoisted state + Proxy)
// that behaves like the real thing where it matters: timestamptz columns come
// back as `…+00:00` (to_json of a timestamptz), a bulk insert / upsert sends
// the UNION of its rows' keys with NULL for a missing key, and NOT NULL
// columns refuse a NULL. jsdom supplies DOMParser for the XML-driven test.

import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, unknown>;
const db = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  writes: [] as Array<{ table: string; method: string; payload: unknown; filters: Array<[string, string, unknown]> }>,
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  rpcImpl: null as null | ((fn: string, args: Record<string, unknown>) => { data: unknown; error: unknown }),
  failInsert: null as null | ((table: string, row: Row) => string | null),
  failUpdate: null as null | ((table: string, payload: Row) => string | null),
  failSelect: null as null | ((table: string, columns: string) => string | null),
  nextId: 1,
}));

/** PostgREST's rendering of a timestamptz (to_json, UTC session): "…+00:00". */
const TS_COLUMNS = new Set(["planned_at", "planned_start_at", "actual_at", "actual_start_at", "updated_at", "baseline_start_at", "baseline_finish_at", "baseline_set_at"]);
function pgTimestamptz(v: unknown): unknown {
  if (typeof v !== "string") return v;
  const t = Date.parse(v);
  if (!Number.isFinite(t)) return v;
  const iso = new Date(t).toISOString(); // 2026-06-02T00:00:00.000Z
  const [whole, frac] = iso.slice(0, -1).split(".");
  const f = (frac ?? "").replace(/0+$/, "");
  return `${whole}${f ? `.${f}` : ""}+00:00`;
}
function asStored(table: string, r: Row): Row {
  if (table !== "milestones") return r;
  const out: Row = {};
  for (const [k, v] of Object.entries(r)) out[k] = TS_COLUMNS.has(k) ? pgTimestamptz(v) : v;
  return out;
}
/** NOT NULL columns of milestones a write can present as NULL. */
const MILESTONE_NOT_NULL = ["org_id", "name", "weight", "planned_at", "status", "source", "created_by", "percent_complete", "is_summary", "depends_on", "attributes"];

function builder(table: string) {
  const state = { op: "select" as "select" | "insert" | "upsert" | "update", payload: null as unknown, filters: [] as Array<[string, string, unknown]>, range: null as null | [number, number], single: false, upsertOpts: null as unknown, columns: "*" };
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
      const selErr = db.failSelect?.(table, state.columns);
      if (selErr) return { data: null, error: { message: selErr } };
      let out = t.filter(match);
      if (state.range) out = out.slice(state.range[0], state.range[1] + 1);
      return { data: state.single ? (out[0] ?? null) : out, error: null };
    }
    if (state.op === "insert" || state.op === "upsert") {
      const sent = (Array.isArray(state.payload) ? state.payload : [state.payload]) as Row[];
      db.writes.push({ table, method: state.op, payload: sent, filters: [] });
      for (const r of sent) { const err = db.failInsert?.(table, r); if (err) return { data: null, error: { message: err } }; }
      // A bulk (array) write: the union of every row's keys, NULL where a row lacks one.
      const keys = Array.isArray(state.payload) ? Array.from(new Set(sent.flatMap((r) => Object.keys(r)))) : null;
      const list = sent.map((r) => asStored(table, keys ? Object.fromEntries(keys.map((k) => [k, k in r ? r[k] : null])) : r));
      if (table === "milestones") {
        for (const r of list) for (const c of MILESTONE_NOT_NULL) {
          if (c in r && r[c] === null) return { data: null, error: { code: "23502", message: `null value in column "${c}" of relation "milestones" violates not-null constraint` } };
        }
      }
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
    for (const r of target) Object.assign(r, asStored(table, state.payload as Row));
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
          case "select": if (state.op === "select" && typeof args[0] === "string") state.columns = args[0]; break;
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

import { importMilestonesFromParsed, applyMilestoneMoves, updateMilestone, setBaseline, clearBaseline, MoveConflictError, type ImportPlan as ImportPlanT } from "@/lib/milestones";
import { parseScheduleFile } from "@/lib/scheduleParsers";
import { shiftForStart, shiftAfterMove, filterMilestones, EMPTY_FILTER } from "@/lib/scheduleFilter";
import type { Milestone } from "@/types/schema";
import { countPastBaseline } from "@/components/projects/MovePreviewSheet";
import { planChangeCount, progressChangeLabel, structureSummary, rekeyedSummary, positionAdoptedSummary, positionRepeatedSummary } from "@/components/projects/ScheduleImportModal";
import { isImmutableTable, isSkippedTable } from "@/lib/dataRestore";

const ORG = "org-1", PROJECT = "proj-1", USER = "user-1";
const scope = { orgId: ORG, projectId: PROJECT, source: "csv" as const, createdBy: USER };
const milestones = () => db.tables.milestones ?? [];
const byName = (n: string) => milestones().find((r) => r.name === n)!;

beforeEach(() => {
  db.tables = {}; db.writes = []; db.rpcCalls = []; db.rpcImpl = null; db.failInsert = null; db.failUpdate = null; db.failSelect = null; db.nextId = 1;
  audited.length = 0;
});

const fileA = ["Task Name,Start,Finish,% Complete", "Mobilize,2026-01-01,2026-01-02,0", "Scaffold,2026-01-03,2026-01-05,0", "Hydrotest,2026-01-06,2026-01-06,0"].join("\n");
const rowsOf = (csv: string, name = "punch.csv") => parseScheduleFile(name, csv).rows;

/** A database that lacks some columns, refusing the way PostgREST does: the
 *  error names the FIRST missing column of the select list / the payload. */
function lackColumns(isMissing: (col: string) => boolean) {
  const first = (cols: string[]) => cols.find(isMissing);
  db.failSelect = (t, cols) => {
    const c = t === "milestones" ? first(cols.split(",").map((x) => x.trim())) : undefined;
    return c ? `column milestones.${c} does not exist` : null;
  };
  db.failInsert = (t, r) => {
    const c = t === "milestones" ? first(Object.keys(r)) : undefined;
    return c ? `column "${c}" of relation "milestones" does not exist` : null;
  };
  db.failUpdate = (t, r) => {
    const c = t === "milestones" ? first(Object.keys(r)) : undefined;
    return c ? `column "${c}" of relation "milestones" does not exist` : null;
  };
}

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

describe("SCH-2 · the plan compares what PostgREST really returns, over every plan column", () => {
  // Keyed rows with real start / finish times, a work column and an extra column.
  const keyed = (n: number, over: (i: number) => Partial<Record<"start" | "finish" | "pct" | "work" | "area", string>> = () => ({})) => [
    "ID,Name,Start,Finish,% Complete,Work,Area",
    ...Array.from({ length: n }, (_, i) => {
      const o = over(i);
      return `${i + 1},Task ${i + 1},${o.start ?? "2026-06-01T08:00:00"},${o.finish ?? "2026-06-01T17:00:00"},${o.pct ?? "0"},${o.work ?? "8 hrs"},${o.area ?? "Unit 1"}`;
    }),
  ].join("\n");

  it("an identical 400-row re-import is Unchanged 400 and issues NO write, although the stored timestamps read back as +00:00", async () => {
    const first = await importMilestonesFromParsed({ ...scope, rows: rowsOf(keyed(400)) });
    expect(first.inserted).toBe(400);
    expect(byName("Task 1").planned_at).toBe("2026-06-01T17:00:00+00:00"); // the mock renders timestamptz like PostgREST
    db.writes = [];
    const again = await importMilestonesFromParsed({ ...scope, rows: rowsOf(keyed(400)) });
    expect(again.plan).toMatchObject({ added: 0, changed: 0, unchanged: 400, notInFile: 0 });
    expect(again.plan!.structure).toEqual({ rows: 0, onlyStructure: 0, parents: 0, linksAdded: 0, linksRemoved: 0 });
    expect(db.writes.filter((w) => w.table === "milestones")).toEqual([]);
  });

  it("a change in ANY plan column is a change: work hours, an extra column (attributes), the start instant", async () => {
    await importMilestonesFromParsed({ ...scope, rows: rowsOf(keyed(4)) });
    const res = await importMilestonesFromParsed({
      ...scope,
      rows: rowsOf(keyed(4, (i) => (i === 0 ? { work: "16 hrs" } : i === 1 ? { area: "Unit 2" } : i === 2 ? { start: "2026-06-01T09:00:00" } : {}))),
    });
    expect(res.plan).toMatchObject({ changed: 3, unchanged: 1 });
    expect(byName("Task 1").duration_hours).toBe(16);
    expect((byName("Task 2").attributes as Row).area).toBe("Unit 2");
    expect(byName("Task 3").planned_start_at).toBe("2026-06-01T09:00:00+00:00");
  });

  it("an existing row's hand-set shift is not re-derived on re-import; a start that moves into the other band re-labels it", async () => {
    await importMilestonesFromParsed({ ...scope, rows: rowsOf(keyed(2)) });
    expect(byName("Task 1").shift).toBe("day");
    byName("Task 1").shift = "swing";                   // corrected by hand in the app
    db.writes = [];
    const same = await importMilestonesFromParsed({ ...scope, rows: rowsOf(keyed(2)) });
    expect(same.plan).toMatchObject({ changed: 0, unchanged: 2 });
    expect(db.writes.filter((w) => w.table === "milestones")).toEqual([]);
    expect(byName("Task 1").shift).toBe("swing");
    await importMilestonesFromParsed({ ...scope, rows: rowsOf(keyed(2, (i) => (i === 1 ? { start: "2026-06-01T19:00:00", finish: "2026-06-02T05:00:00" } : {}))) });
    expect(byName("Task 2").shift).toBe("night");
    expect(byName("Task 1").shift).toBe("swing");
  });

  it("a mid-job re-import mixing protected rows and rows that take the file's progress stays CHUNKED — one request per key set, never per-row", async () => {
    await importMilestonesFromParsed({ ...scope, rows: rowsOf(keyed(400)) });
    // The crew recorded progress on the first 150 rows.
    milestones().slice(0, 150).forEach((r) => Object.assign(r, { percent_complete: 60, status: "in_progress" }));
    db.writes = [];
    const next = keyed(400, () => ({ finish: "2026-06-02T17:00:00", pct: "10" })); // every finish moved, the file says 10 %
    const res = await importMilestonesFromParsed({ ...scope, rows: rowsOf(next) });
    expect(res.errors).toEqual([]);
    expect(res.updated).toBe(400);
    const w = db.writes.filter((x) => x.table === "milestones");
    expect(w.every((x) => x.method === "upsert")).toBe(true);           // no per-row update fallback
    expect(w.map((x) => (x.payload as Row[]).length)).toEqual([200, 50, 150]); // 250 taking the file's progress, 150 protected
    for (const x of w) {
      const keySets = new Set((x.payload as Row[]).map((r) => Object.keys(r).sort().join(",")));
      expect(keySets.size).toBe(1);                                    // one key set per request
    }
    expect(byName("Task 1")).toMatchObject({ percent_complete: 60, status: "in_progress", planned_at: "2026-06-02T17:00:00+00:00" });
    expect(byName("Task 400")).toMatchObject({ percent_complete: 10, status: "in_progress" });
  });

  it("new rows with and without a % value are inserted in separate requests (a blank cell never sends status NULL)", async () => {
    const csv = ["ID,Name,Finish,% Complete", "1,A,2026-06-01,50", "2,B,2026-06-02,", "3,C,2026-06-03,0"].join("\n");
    const res = await importMilestonesFromParsed({ ...scope, rows: rowsOf(csv) });
    expect(res.errors).toEqual([]);
    expect(res.inserted).toBe(3);
    expect(db.writes.filter((w) => w.table === "milestones").map((w) => [w.method, (w.payload as Row[]).length])).toEqual([["insert", 2], ["insert", 1]]);
    expect(byName("A")).toMatchObject({ percent_complete: 50, status: "in_progress" });
    expect("status" in byName("B")).toBe(false); // the column default applies
  });

  it("the plan counts structure changes — a predecessor the file drops, including one added in the app — and the button count includes structure-only rows", async () => {
    const linked = ["ID,Task Name,Start,Finish,Predecessors", "1,Design,2026-01-01,2026-01-05,", "2,Build,2026-01-06,2026-01-10,1", "3,Test,2026-01-11,2026-01-12,"].join("\n");
    await importMilestonesFromParsed({ ...scope, source: "msproject", rows: rowsOf(linked, "plan.csv") });
    byName("Test").depends_on = [byName("Build").id];     // a link a planner added in the app
    const unlinked = ["ID,Task Name,Start,Finish,Predecessors", "1,Design,2026-01-01,2026-01-05,", "2,Build,2026-01-06,2026-01-10,", "3,Test,2026-01-11,2026-01-12,"].join("\n");
    const res = await importMilestonesFromParsed({ ...scope, source: "msproject", rows: rowsOf(unlinked, "plan.csv"), dryRun: true });
    expect(res.plan).toMatchObject({ added: 0, changed: 0, unchanged: 3 });
    expect(res.plan!.structure).toEqual({ rows: 2, onlyStructure: 2, parents: 0, linksAdded: 0, linksRemoved: 2 });
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

describe("SCH-3 · rows imported by POSITION before content keys: a unique name is adopted and re-keyed, a repeated one never", () => {
  // What the pre-Round-G parser + importer stored for a keyless file: its
  // position, `msp-row:<index>` (a "Task Name" header is an MS Project CSV) or
  // `csv-row:<index>` (generic CSV), date-only starts at 00:00Z labelled
  // 'night' — read back as PostgREST renders them.
  const legacyRow = (i: number, name: string, start: string, finish: string, tag = "msp"): Row => ({
    id: `old${i}`, org_id: ORG, project_id: PROJECT, document_id: null, source: "csv", external_ref: `${tag}-row:${i}`,
    name, description: null, weight: 1, outline_level: null, wbs: null, is_summary: false, shift: "night",
    work_order_ref: null, responsible_party: null, responsible_kind: null, responsible_org: null, location: null,
    duration_hours: null, attributes: {}, status: "planned", percent_complete: 0, actual_at: null, actual_start_at: null,
    planned_at: `${finish}T00:00:00+00:00`, planned_start_at: `${start}T00:00:00+00:00`, parent_id: null, depends_on: [],
    created_by: "someone", created_by_name: "Earlier import",
  });
  const seedLegacy = (lines = fileA.split("\n").slice(1), tag = "msp") => {
    db.tables.milestones = lines.map((l, i) => { const [name, start, finish] = l.split(","); return legacyRow(i, name, start, finish, tag); });
  };

  it("an unchanged re-import reads Unchanged 3 / Added 0, re-keys every row in place and keeps ids, provenance and the crew's progress", async () => {
    seedLegacy();
    Object.assign(milestones()[1], { percent_complete: 60, status: "in_progress", actual_start_at: "2026-01-03T00:00:00+00:00" }); // Scaffold
    const dry = await importMilestonesFromParsed({ ...scope, rows: rowsOf(fileA), dryRun: true });
    expect(dry.plan).toMatchObject({ added: 0, changed: 0, unchanged: 3, notInFile: 0, rekeyed: 3, rekeyedOnly: 3, positionAdopted: 3, positionAdoptedNames: ["Mobilize", "Scaffold", "Hydrotest"], positionRepeated: 0 });
    expect(planChangeCount(dry.plan!)).toBe(3); // the button never reads "Import 0 changes" while keys will be written

    const res = await importMilestonesFromParsed({ ...scope, rows: rowsOf(fileA) });
    expect(res.errors).toEqual([]);
    expect(res).toMatchObject({ inserted: 0, updated: 3 });
    expect(milestones().map((r) => r.id)).toEqual(["old0", "old1", "old2"]);
    expect(milestones().every((r) => /^msp-key:[0-9a-f]{8}$/.test(String(r.external_ref)))).toBe(true);
    expect(byName("Scaffold")).toMatchObject({ percent_complete: 60, status: "in_progress", created_by: "someone", shift: "night" });

    // From now on the rows match on their content keys directly: nothing to write.
    db.writes = [];
    const again = await importMilestonesFromParsed({ ...scope, rows: rowsOf(fileA) });
    expect(again.plan).toMatchObject({ added: 0, changed: 0, unchanged: 3, notInFile: 0, rekeyed: 0, rekeyedOnly: 0 });
    expect(db.writes.filter((w) => w.table === "milestones")).toEqual([]);
  });

  it("a unique name is adopted even when its dates moved: the file's dates are written, the crew's progress is kept", async () => {
    seedLegacy();
    Object.assign(milestones()[1], { percent_complete: 60, status: "in_progress" }); // Scaffold
    const moved = fileA.replace("Scaffold,2026-01-03,2026-01-05,0", "Scaffold,2026-01-03,2026-01-09,0");
    const res = await importMilestonesFromParsed({ ...scope, rows: rowsOf(moved) });
    expect(res.plan).toMatchObject({ added: 0, changed: 1, unchanged: 2, notInFile: 0, rekeyed: 3, positionAdopted: 3 });
    expect(res.plan!.localProgressAtRisk.map((r) => [r.name, r.localPercent, r.filePercent])).toEqual([["Scaffold", 60, 0]]);
    expect(byName("Scaffold")).toMatchObject({ id: "old1", planned_at: "2026-01-09T00:00:00+00:00", percent_complete: 60, status: "in_progress" });
  });

  it("a generic CSV (csv-row:) with a repeated name: never adopted — both file rows added, both earlier rows kept with their own progress, and the plan says why", async () => {
    seedLegacy(["Inspect,2026-01-01,2026-01-02", "Inspect,2026-01-01,2026-01-02"], "csv");
    Object.assign(milestones()[1], { percent_complete: 100, status: "completed" });
    const twice = ["Name,Start,Finish", "Inspect,2026-01-01,2026-01-02", "Inspect,2026-01-01,2026-01-02"].join("\n");
    const res = await importMilestonesFromParsed({ ...scope, rows: rowsOf(twice) });
    expect(res.plan).toMatchObject({ added: 2, notInFile: 2, rekeyed: 0, positionAdopted: 0, positionRepeated: 2, positionRepeatedNames: ["Inspect", "Inspect"] });
    expect(milestones().slice(0, 2).map((r) => [r.id, r.external_ref, r.status])).toEqual([["old0", "csv-row:0", "planned"], ["old1", "csv-row:1", "completed"]]);
  });

  it("a name that differs only in case or surrounding space still matches (and the new spelling is a change)", async () => {
    seedLegacy(["  mobilize ,2026-01-01,2026-01-02"]);
    const res = await importMilestonesFromParsed({ ...scope, rows: rowsOf(["Task Name,Start,Finish", "Mobilize,2026-01-01,2026-01-02"].join("\n")) });
    expect(res.plan).toMatchObject({ added: 0, changed: 1, rekeyed: 1, rekeyedOnly: 0 });
    expect(milestones()).toHaveLength(1);
    expect(milestones()[0]).toMatchObject({ id: "old0", name: "Mobilize" });
  });
});

describe("SCH-3 · position rows the OLD importer stored (in any browser zone): adopted only by a name unique on both sides — no completion ever moves between tasks", () => {
  /** The pre-Round-G coerceIso, run in the importing browser's zone: ISO and
   *  date-only slash dates exactly, every other form through new Date(). */
  const legacyReading = (value: string, zone: string): string => {
    const v = value.replace(/^"|"$/g, "").trim();
    if (/^\d{4}-\d{2}-\d{2}T/.test(v)) return /(?:Z|[+-]\d{2}:?\d{2})$/i.test(v) ? v : `${v}Z`;
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return `${v}T00:00:00Z`;
    const m1 = v.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
    if (m1) return `${m1[1]}T${m1[2]}:${m1[3]}:${m1[4] ?? "00"}Z`;
    const m2 = v.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
    if (m2) return `${Number(m2[3]) < 100 ? 2000 + Number(m2[3]) : m2[3]}-${m2[1].padStart(2, "0")}-${m2[2].padStart(2, "0")}T00:00:00Z`;
    const tz = process.env.TZ;
    try { process.env.TZ = zone; return new Date(v).toISOString(); } finally { process.env.TZ = tz; }
  };
  const header = "Task Name,Start,Finish,% Complete";
  const lines = [
    "Mobilize,6/15/2026 8:00 AM,6/15/2026 5:00 PM,",
    "Scaffold,Mon 6/15/26,Wed 6/17/26,",
    'Hydrotest,"June 18, 2026 7:00 PM","June 19, 2026 5:00 AM",',
  ];
  const splitLine = (l: string) => l.match(/("[^"]*"|[^,]+)/g)!;
  const seedOld = (zone: string, from = lines, over: (i: number) => Row = () => ({})) => {
    db.tables.milestones = from.map((l, i) => {
      const [name, start, finish] = splitLine(l);
      return {
        id: `old${i}`, org_id: ORG, project_id: PROJECT, document_id: null, source: "csv", external_ref: `msp-row:${i}`,
        name, description: null, weight: 1, outline_level: null, wbs: null, is_summary: false, shift: null,
        work_order_ref: null, responsible_party: null, responsible_kind: null, responsible_org: null, location: null,
        duration_hours: null, attributes: {}, status: "planned", percent_complete: 0, actual_at: null, actual_start_at: null,
        planned_at: pgTimestamptz(legacyReading(finish, zone)), planned_start_at: pgTimestamptz(legacyReading(start, zone)),
        parent_id: null, depends_on: [], created_by: "someone", created_by_name: "Earlier import", ...over(i),
      } as Row;
    });
  };
  const file = (from = lines) => parseScheduleFile("punch.csv", [header, ...from].join("\n"), { dateConvention: "mdy" }).rows;
  const done = { status: "completed", percent_complete: 100 };
  /** Every old row: [id, still keyed by position?, status] — a completion moving shows here. */
  const oldRows = () => milestones().filter((r) => String(r.id).startsWith("old")).map((r) => [r.id, String(r.external_ref).startsWith("msp-row:"), r.status]);

  for (const zone of ["America/Chicago", "Asia/Kolkata", "UTC"]) {
    it(`unique names from a ${zone} browser: all adopted whatever the offset, the file's dates written, progress kept; the next re-import writes nothing`, async () => {
      seedOld(zone);
      Object.assign(byName("Scaffold"), { percent_complete: 60, status: "in_progress" });
      const res = await importMilestonesFromParsed({ ...scope, rows: file() });
      expect(res.errors).toEqual([]);
      expect(res.plan).toMatchObject({ added: 0, notInFile: 0, rekeyed: 3, positionAdopted: 3, positionAdoptedNames: ["Mobilize", "Scaffold", "Hydrotest"], positionRepeated: 0 });
      expect(milestones().map((r) => r.id)).toEqual(["old0", "old1", "old2"]);
      expect(byName("Mobilize")).toMatchObject({ planned_start_at: "2026-06-15T08:00:00+00:00", planned_at: "2026-06-15T17:00:00+00:00" });
      expect(byName("Scaffold")).toMatchObject({ percent_complete: 60, status: "in_progress", created_by: "someone" });
      db.writes = [];
      const again = await importMilestonesFromParsed({ ...scope, rows: file() });
      expect(again.plan).toMatchObject({ added: 0, changed: 0, unchanged: 3, rekeyed: 0, positionAdopted: 0 });
      expect(db.writes.filter((w) => w.table === "milestones")).toEqual([]);
    });
  }

  it("the panel names every adoption (first 20, then a count)", () => {
    const names = Array.from({ length: 23 }, (_, i) => `T${i + 1}`);
    expect(positionAdoptedSummary({ positionAdopted: 23, positionAdoptedNames: names.slice(0, 20) })).toBe(
      `23 tasks imported earlier by row position are matched by name — each name occurs once on the board and once in this file — and keep their progress; the planned dates are taken from the file: ${names.slice(0, 20).join(", ")}, and 3 more.`);
  });

  it("walkdowns at 8 AM (completed) and 1 PM, Chicago: the repeated name is never adopted — both added, the completion stays on its own old row; the unique tasks are adopted", async () => {
    const f = ["Walkdown,6/15/2026 8:00 AM,6/15/2026 9:00 AM,", "Walkdown,6/15/2026 1:00 PM,6/15/2026 2:00 PM,", "Mobilize,6/14/2026 7:00 AM,6/14/2026 5:00 PM,", "Demob,6/19/2026 7:00 AM,6/19/2026 5:00 PM,"];
    seedOld("America/Chicago", f, (i) => (i === 0 ? done : {}));
    const res = await importMilestonesFromParsed({ ...scope, rows: file(f) });
    expect(res.plan).toMatchObject({ added: 2, notInFile: 2, rekeyed: 2, positionAdopted: 2, positionRepeated: 2, positionRepeatedNames: ["Walkdown", "Walkdown"] });
    expect(positionRepeatedSummary(res.plan!)).toBe("2 tasks repeat a name (Walkdown) — their earlier rows are kept, not matched; review before importing. This file's tasks of those names are added.");
    expect(oldRows()).toEqual([["old0", true, "completed"], ["old1", true, "planned"], ["old2", false, "planned"], ["old3", false, "planned"]]);
    expect(milestones().filter((r) => r.name === "Walkdown" && !String(r.id).startsWith("old")).map((r) => r.status ?? "planned")).toEqual(["planned", "planned"]);
  });

  it("30-minute 'Line check' every 8 h from Los Angeles in January: none adopted, the three completions stay on their own old rows", async () => {
    const f: string[] = [];
    for (const d of [12, 13]) for (const [a, b] of [["6:00 AM", "6:30 AM"], ["2:00 PM", "2:30 PM"], ["10:00 PM", "10:30 PM"]]) f.push(`Line check,1/${d}/2026 ${a},1/${d}/2026 ${b},`);
    seedOld("America/Los_Angeles", f, (i) => (i < 3 ? done : {}));
    const res = await importMilestonesFromParsed({ ...scope, rows: file(f) });
    expect(res.plan).toMatchObject({ added: 6, notInFile: 6, rekeyed: 0, positionRepeated: 6 });
    expect(oldRows().map((r) => r[2])).toEqual(["completed", "completed", "completed", "planned", "planned", "planned"]);
  });

  it("hourly 'QC check' in Berlin: none adopted, the 10 AM completion stays on its own old row", async () => {
    const f = ["QC check,6/15/2026 8:00 AM,6/15/2026 9:00 AM,", "QC check,6/15/2026 9:00 AM,6/15/2026 10:00 AM,", "QC check,6/15/2026 10:00 AM,6/15/2026 11:00 AM,", "Mobilize,6/14/2026 7:00 AM,6/14/2026 5:00 PM,"];
    seedOld("Europe/Berlin", f, (i) => (i === 2 ? done : {}));
    const res = await importMilestonesFromParsed({ ...scope, rows: file(f) });
    expect(res.plan).toMatchObject({ added: 3, rekeyed: 1, positionAdopted: 1, positionRepeated: 3 });
    expect(oldRows()).toEqual([["old0", true, "planned"], ["old1", true, "planned"], ["old2", true, "completed"], ["old3", false, "planned"]]);
  });

  it("'Inspect' moved from 8 AM to 6 PM (a unique name): the same task — adopted with the file's dates; its completion stays, and the at-risk list shows it when the file's % differs", async () => {
    const before = ["Inspect,6/15/2026 8:00 AM,6/15/2026 9:00 AM,", "Mobilize,6/14/2026 7:00 AM,6/14/2026 5:00 PM,"];
    seedOld("UTC", before, (i) => (i === 0 ? { ...done, actual_at: "2026-06-15T09:00:00+00:00" } : {}));
    const after = ["Inspect,6/15/2026 6:00 PM,6/15/2026 7:00 PM,0", "Mobilize,6/14/2026 7:00 AM,6/14/2026 5:00 PM,0"];
    const res = await importMilestonesFromParsed({ ...scope, rows: file(after) });
    expect(res.plan).toMatchObject({ added: 0, notInFile: 0, changed: 1, positionAdopted: 2, positionAdoptedNames: ["Inspect", "Mobilize"] });
    expect(res.plan!.localProgressAtRisk.map((r) => [r.name, r.localPercent, r.localStatus, r.filePercent])).toEqual([["Inspect", 100, "completed", 0]]);
    expect(byName("Inspect")).toMatchObject({ id: "old0", status: "completed", percent_complete: 100, planned_start_at: "2026-06-15T18:00:00+00:00" });
  });

  it("A1 (Chicago legacy): one other task legitimately moved +5 h — the 1 PM walkdown does not take the completed 8 AM row; the moved task is adopted", async () => {
    const old = ["Walkdown,6/15/2026 8:00 AM,6/15/2026 9:00 AM,", "Walkdown,6/15/2026 1:00 PM,6/15/2026 2:00 PM,", "Mobilize,6/14/2026 7:00 AM,6/14/2026 5:00 PM,"];
    const now = [old[0], old[1], "Mobilize,6/14/2026 12:00 PM,6/14/2026 10:00 PM,"];
    seedOld("America/Chicago", old, (i) => (i === 0 ? done : {}));
    const res = await importMilestonesFromParsed({ ...scope, rows: file(now) });
    expect(res.plan).toMatchObject({ added: 2, notInFile: 2, positionAdopted: 1, positionAdoptedNames: ["Mobilize"], positionRepeated: 2 });
    expect(oldRows()).toEqual([["old0", true, "completed"], ["old1", true, "planned"], ["old2", false, "planned"]]);
    expect(byName("Mobilize").planned_start_at).toBe("2026-06-14T12:00:00+00:00");
  });

  it("A2 (UTC legacy): three tasks moved +2 h — the 10 AM walkdown does not take the 8 AM row, and the unchanged Demob is adopted, not duplicated", async () => {
    const old = ["Walkdown,6/15/2026 8:00 AM,6/15/2026 9:00 AM,", "Walkdown,6/15/2026 10:00 AM,6/15/2026 11:00 AM,",
      "Pour,6/16/2026 6:00 AM,6/16/2026 2:00 PM,", "Cure,6/17/2026 6:00 AM,6/17/2026 2:00 PM,", "Strip,6/18/2026 6:00 AM,6/18/2026 2:00 PM,", "Demob,6/19/2026 7:00 AM,6/19/2026 5:00 PM,"];
    const now = [old[0], old[1], "Pour,6/16/2026 8:00 AM,6/16/2026 4:00 PM,", "Cure,6/17/2026 8:00 AM,6/17/2026 4:00 PM,", "Strip,6/18/2026 8:00 AM,6/18/2026 4:00 PM,", old[5]];
    seedOld("UTC", old, (i) => (i === 0 ? done : {}));
    const res = await importMilestonesFromParsed({ ...scope, rows: file(now) });
    expect(res.plan).toMatchObject({ added: 2, notInFile: 2, positionAdopted: 4, positionAdoptedNames: ["Pour", "Cure", "Strip", "Demob"], positionRepeated: 2 });
    expect(oldRows()[0]).toEqual(["old0", true, "completed"]);
    expect(milestones().filter((r) => r.name === "Demob")).toHaveLength(1);
  });

  it("A3 (Chicago legacy, date-only milestones stored at 00:00Z beside timed tasks): every unique task adopted, the walkdowns added, no completion moves", async () => {
    const f = ["Kickoff,6/10/2026,6/10/2026,", "Design freeze,6/12/2026,6/12/2026,", "Handover,6/30/2026,6/30/2026,",
      "Walkdown,6/15/2026 8:00 AM,6/15/2026 9:00 AM,", "Walkdown,6/15/2026 1:00 PM,6/15/2026 2:00 PM,", "Pour,6/16/2026 7:00 AM,6/16/2026 3:00 PM,"];
    seedOld("America/Chicago", f, (i) => (i === 3 ? done : i === 5 ? { status: "in_progress", percent_complete: 40 } : {}));
    const res = await importMilestonesFromParsed({ ...scope, rows: file(f) });
    expect(res.plan).toMatchObject({ added: 2, notInFile: 2, positionAdopted: 4, positionAdoptedNames: ["Kickoff", "Design freeze", "Handover", "Pour"], positionRepeated: 2 });
    expect(oldRows()).toEqual([["old0", false, "planned"], ["old1", false, "planned"], ["old2", false, "planned"], ["old3", true, "completed"], ["old4", true, "planned"], ["old5", false, "in_progress"]]);
    expect(byName("Pour")).toMatchObject({ percent_complete: 40, planned_start_at: "2026-06-16T07:00:00+00:00" });
  });

  it("A5 (UTC legacy, a +1 h reschedule after the UK change, hourly checks after it): the rescheduled task is adopted as itself, the checks are added, the completion stays", async () => {
    const old = ["Mobilize,3/16/2026 7:00 AM,3/16/2026 5:00 PM,", "Scaffold,3/18/2026 7:00 AM,3/18/2026 5:00 PM,", "Pour,3/20/2026 7:00 AM,3/20/2026 5:00 PM,",
      "Hydrotest,4/1/2026 7:00 AM,4/1/2026 5:00 PM,", "QC check,4/2/2026 8:00 AM,4/2/2026 9:00 AM,", "QC check,4/2/2026 9:00 AM,4/2/2026 10:00 AM,"];
    const now = [...old.slice(0, 3), "Hydrotest,4/1/2026 8:00 AM,4/1/2026 6:00 PM,", old[4], old[5]];
    seedOld("UTC", old, (i) => (i === 4 ? done : {}));
    const res = await importMilestonesFromParsed({ ...scope, rows: file(now) });
    expect(res.plan).toMatchObject({ added: 2, notInFile: 2, positionAdopted: 4, positionRepeated: 2 });
    expect(oldRows().slice(4)).toEqual([["old4", true, "completed"], ["old5", true, "planned"]]);
    expect(byName("Hydrotest").planned_start_at).toBe("2026-04-01T08:00:00+00:00");
  });

  it("an earlier CONTENT-keyed row matches exactly only: 5 h off, it is not adopted", async () => {
    seedOld("America/Chicago", lines.slice(0, 1));
    milestones()[0].external_ref = "msp-key:0badc0de";
    const res = await importMilestonesFromParsed({ ...scope, rows: file(lines.slice(0, 1)), dryRun: true });
    expect(res.plan).toMatchObject({ added: 1, rekeyed: 0, notInFile: 1, positionAdopted: 0, positionRepeated: 0 });
  });

  it("linear: 5,000 rows, most sharing a handful of names (4,990 identical + 10 unique), plan in well under a second", async () => {
    const f = [...Array.from({ length: 4990 }, () => "Touch-up paint,6/30/2026,6/30/2026,"), ...Array.from({ length: 10 }, (_, i) => `Unique ${i},6/${10 + i}/2026,6/${10 + i}/2026,`)];
    seedOld("UTC", f);
    const rows = file(f);
    const t0 = performance.now();
    const res = await importMilestonesFromParsed({ ...scope, rows, dryRun: true });
    const ms = performance.now() - t0;
    expect(res.plan).toMatchObject({ added: 4990, positionAdopted: 10, positionRepeated: 4990, notInFile: 4990 });
    expect(ms).toBeLessThan(1000);
    // The plan's own time is the guard above; seeding and parsing 5,000 rows
    // around it is fixture work, so the test's overall timeout is generous —
    // under a loaded machine the 5 s default timed out on the fixture alone.
  }, 30_000);
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
    expect(res.errors).toEqual(["Row 8: A value isn't in the expected format — nothing was changed."]);   // REL-3
  });

  it("a database without 20261097 drops import_batch_id alone and keeps the hierarchy fields", async () => {
    let hits = 0;
    db.failInsert = (t, r) => (t === "milestones" && "import_batch_id" in r ? (hits++, "column \"import_batch_id\" does not exist") : null);
    const res = await importMilestonesFromParsed({ ...scope, rows: rowsOf(fileA) });
    expect(res.inserted).toBe(3);
    expect(hits).toBe(1);
    expect(byName("Scaffold")).toMatchObject({ planned_start_at: "2026-01-03T00:00:00+00:00", shift: null }); // a date-only start is not night work
    expect("import_batch_id" in byName("Scaffold")).toBe(false);
  });
});

describe("SCH-14 / SCH-16 · an older database: the existing-row read drops each missing migration's columns on its own and the degrade paths run", () => {
  it("without 20260715 (no depends_on): the rows land, the hierarchy is wired, the links are dropped with a heads-up, and a re-import does not count links it cannot write", async () => {
    db.failSelect = (t, cols) => (t === "milestones" && /\bdepends_on\b/.test(cols) ? "column milestones.depends_on does not exist" : null);
    db.failUpdate = (t, p) => (t === "milestones" && "depends_on" in p ? "column \"depends_on\" of relation \"milestones\" does not exist" : null);
    const linked = ["ID,Task Name,Start,Finish,Outline Level,Predecessors", "1,Phase,2026-01-01,2026-01-10,1,", "2,Design,2026-01-01,2026-01-05,2,", "3,Build,2026-01-06,2026-01-10,2,2"].join("\n");
    const res = await importMilestonesFromParsed({ ...scope, source: "msproject", rows: rowsOf(linked, "plan.csv") });
    expect(res.inserted).toBe(3);
    expect(byName("Build").parent_id).toBe(byName("Phase").id);
    expect("depends_on" in byName("Build")).toBe(false);
    expect(res.errors).toEqual([expect.stringMatching(/^Heads up: migration 20260715_milestone_dependencies\.sql hasn't been applied/)]);
    const again = await importMilestonesFromParsed({ ...scope, source: "msproject", rows: rowsOf(linked, "plan.csv"), dryRun: true });
    expect(again.plan).toMatchObject({ added: 0, changed: 0, unchanged: 3 });
    expect(again.plan!.structure).toEqual({ rows: 0, onlyStructure: 0, parents: 0, linksAdded: 0, linksRemoved: 0 });
  });

  it("without any of 20260703 / 20260705 / 20260715 / 20260731 (a pre-hierarchy database): the rows land with the legacy columns only, each missing migration that this file needed is named, and a re-import compares only what the database has", async () => {
    const LEGACY = new Set(["id", "org_id", "project_id", "document_id", "source", "name", "description", "weight", "planned_at", "status", "actual_at", "external_ref", "created_by", "created_by_name", "updated_at", "updated_by"]);
    lackColumns((c) => !LEGACY.has(c));
    const res = await importMilestonesFromParsed({ ...scope, rows: rowsOf(fileA) });
    expect(res.inserted).toBe(3);
    // fileA carries a % column (20260731) and no rich columns (20260705 is not mentioned).
    expect(res.errors).toEqual([
      expect.stringMatching(/^Heads up: migration 20260731_milestone_percent_complete\.sql hasn't been applied/),
      expect.stringMatching(/^Heads up: hierarchy migration 20260703_milestones_hierarchy\.sql hasn't been applied/),
    ]);
    expect(Object.keys(byName("Scaffold")).every((k) => LEGACY.has(k))).toBe(true);
    db.writes = [];
    const again = await importMilestonesFromParsed({ ...scope, rows: rowsOf(fileA) });
    expect(again.plan).toMatchObject({ added: 0, changed: 0, unchanged: 3 });
    expect(db.writes.filter((w) => w.table === "milestones")).toEqual([]);
  });

  it("without ONLY 20260705 (rich columns): the hierarchy it has is kept — start, outline level, parent — the rich columns are dropped, and the heads-up names 20260705, not 20260703", async () => {
    const RICH = new Set(["work_order_ref", "responsible_party", "responsible_kind", "responsible_org", "location", "duration_hours", "attributes"]);
    lackColumns((c) => RICH.has(c));
    const csv = ["ID,Task Name,Start,Finish,Outline Level,Work,Resource Names", "1,Phase,2026-01-01 08:00,2026-01-10 17:00,1,,", "2,Weld,2026-01-01 08:00,2026-01-05 17:00,2,40 hrs,Crew A"].join("\n");
    const res = await importMilestonesFromParsed({ ...scope, source: "msproject", rows: rowsOf(csv, "plan.csv") });
    expect(res.inserted).toBe(2);
    expect(res.errors).toEqual([expect.stringMatching(/^Heads up: migration 20260705_milestones_execution_richdata\.sql hasn't been applied/)]);
    expect(byName("Weld")).toMatchObject({ parent_id: byName("Phase").id, outline_level: 2, planned_start_at: "2026-01-01T08:00:00+00:00", shift: "day" });
    expect(Object.keys(byName("Weld")).some((k) => RICH.has(k))).toBe(false);
    db.writes = [];
    const again = await importMilestonesFromParsed({ ...scope, source: "msproject", rows: rowsOf(csv, "plan.csv") });
    expect(again.plan).toMatchObject({ added: 0, changed: 0, unchanged: 2 });
    expect(again.plan!.structure.rows).toBe(0);
    expect(db.writes.filter((w) => w.table === "milestones")).toEqual([]);
  });

  it("without ONLY 20260731 (percent_complete): progress lands as status, the hierarchy is kept, the heads-up names 20260731, and a re-import still protects the crew's status", async () => {
    lackColumns((c) => c === "percent_complete");
    const csv = ["ID,Task Name,Start,Finish,Outline Level,% Complete", "1,Phase,2026-01-01,2026-01-10,1,0", "2,Weld,2026-01-01,2026-01-05,2,50"].join("\n");
    const res = await importMilestonesFromParsed({ ...scope, source: "msproject", rows: rowsOf(csv, "plan.csv") });
    expect(res.inserted).toBe(2);
    expect(res.errors).toEqual([expect.stringMatching(/^Heads up: migration 20260731_milestone_percent_complete\.sql hasn't been applied/)]);
    expect(byName("Weld")).toMatchObject({ status: "in_progress", parent_id: byName("Phase").id, planned_start_at: "2026-01-01T00:00:00+00:00", actual_start_at: "2026-01-01T00:00:00+00:00" });
    expect("percent_complete" in byName("Weld")).toBe(false);
    byName("Phase").status = "in_progress"; // the crew started it in the app
    db.writes = [];
    const again = await importMilestonesFromParsed({ ...scope, source: "msproject", rows: rowsOf(csv, "plan.csv") });
    expect(again.plan).toMatchObject({ added: 0, changed: 0, unchanged: 2 });
    expect(again.plan!.localProgressAtRisk.map((r) => r.name)).toEqual(["Phase"]);
    expect(db.writes.filter((w) => w.table === "milestones")).toEqual([]);
  });

  it("any other read failure still stops the import before a write", async () => {
    db.failSelect = (t) => (t === "milestones" ? "permission denied for table milestones" : null);
    const res = await importMilestonesFromParsed({ ...scope, rows: rowsOf(fileA) });
    expect(res.errors).toEqual(["Could not read the existing schedule: You don't have permission to see this. Nothing was written."]);   // REL-3
    expect(db.writes).toEqual([]);
  });
});

describe("SCHED-9 · a date-only start is not night work", () => {
  it("a new row whose start has no time of day gets no label; a start with a time does (CSV and direct rows)", async () => {
    const csv = ["ID,Name,Start,Finish", "1,Date only,2026-06-01,2026-06-02", "2,Morning,2026-06-01 08:00,2026-06-01 17:00", "3,Evening,6/13/2026 7:00 PM,6/14/2026 5:00 AM", "4,Slash date only,6/13/2026,6/14/2026"].join("\n");
    await importMilestonesFromParsed({ ...scope, rows: rowsOf(csv) });
    expect(["Date only", "Morning", "Evening", "Slash date only"].map((n) => byName(n).shift)).toEqual([null, "day", "night", null]);
    // A caller that passes rows directly: a bare YYYY-MM-DD start reads the same way.
    await importMilestonesFromParsed({ ...scope, source: "manual", rows: [
      { name: "Direct date", plannedAt: "2026-06-02", plannedStartAt: "2026-06-01", externalRef: "ai:1" },
      { name: "Direct time", plannedAt: "2026-06-02T17:00:00Z", plannedStartAt: "2026-06-02T08:00:00Z", externalRef: "ai:2" },
    ] });
    expect(byName("Direct date").shift).toBeNull();
    expect(byName("Direct time").shift).toBe("day");
  });

  it("a date-only re-import keeps a label set in the app (no band to read), and writes nothing", async () => {
    const csv = ["ID,Name,Start,Finish", "1,Date only,2026-06-01,2026-06-02"].join("\n");
    await importMilestonesFromParsed({ ...scope, rows: rowsOf(csv) });
    byName("Date only").shift = "day";
    db.writes = [];
    const again = await importMilestonesFromParsed({ ...scope, rows: rowsOf(csv) });
    expect(again.plan).toMatchObject({ changed: 0, unchanged: 1 });
    expect(db.writes.filter((w) => w.table === "milestones")).toEqual([]);
    expect(byName("Date only").shift).toBe("day");
  });

  it("MS Project XML carries a time of day: 08:00 is day (the positive path stays pinned)", async () => {
    const xml = `<?xml version="1.0"?><Project xmlns="http://schemas.microsoft.com/project"><SaveDate>2026-01-01T00:00:00</SaveDate><Tasks>
      <Task><UID>1</UID><Name>Morning pour</Name><Start>2026-06-01T08:00:00</Start><Finish>2026-06-01T17:00:00</Finish><OutlineLevel>1</OutlineLevel></Task>
    </Tasks></Project>`;
    await importMilestonesFromParsed({ ...scope, source: "msproject", rows: parseScheduleFile("plan.xml", xml).rows });
    expect(byName("Morning pour").shift).toBe("day");
  });
});

describe("SCHED-9 · shift is one UTC reading, and follows a start only when it moves into the other band", () => {
  it("offset-less MS Project XML imported from a UTC+5:30 browser: 08:00 → day, 19:00 → night (parse AND import under the zone)", async () => {
    const xml = `<?xml version="1.0"?><Project xmlns="http://schemas.microsoft.com/project"><SaveDate>2026-01-01T00:00:00</SaveDate><Tasks>
      <Task><UID>1</UID><Name>Day job</Name><Start>2026-06-01T08:00:00</Start><Finish>2026-06-01T17:00:00</Finish><OutlineLevel>1</OutlineLevel></Task>
      <Task><UID>2</UID><Name>Night job</Name><Start>2026-06-01T19:00:00</Start><Finish>2026-06-02T05:00:00</Finish><OutlineLevel>1</OutlineLevel></Task>
    </Tasks></Project>`;
    const tz = process.env.TZ;
    try {
      process.env.TZ = "Asia/Kolkata";
      // Read as browser-local, 19:00 would be 13:30Z here — a "day" label.
      expect(new Date("2026-06-01T19:00:00").getUTCHours()).toBe(13);
      const parsed = parseScheduleFile("plan.xml", xml);
      expect(parsed.rows.map((r) => r.plannedStartAt)).toEqual(["2026-06-01T08:00:00Z", "2026-06-01T19:00:00Z"]);
      await importMilestonesFromParsed({ ...scope, source: "msproject", rows: parsed.rows });
    } finally { process.env.TZ = tz; }
    expect(byName("Day job").shift).toBe("day");
    expect(byName("Night job").shift).toBe("night");
  });

  it("updateMilestone re-labels a day / night row whose start moves into the other band, keeps swing, defers to an explicit shift", async () => {
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

  it("an unlabelled manual row dragged a day stays unlabelled; a hand-set 'day' at 05:00 moved by whole days stays 'day'", async () => {
    db.tables.milestones = [
      // createMilestone stores a date-only task at 00:00Z, no shift
      { id: "m", org_id: ORG, project_id: PROJECT, name: "Manual", planned_at: "2026-06-02T00:00:00+00:00", planned_start_at: "2026-06-01T00:00:00+00:00", shift: null, status: "planned", weight: 1, source: "manual", created_by: USER },
      { id: "h", org_id: ORG, project_id: PROJECT, name: "Hand-set", planned_at: "2026-06-01T15:00:00+00:00", planned_start_at: "2026-06-01T05:00:00+00:00", shift: "day", status: "planned", weight: 1, source: "manual", created_by: USER },
    ];
    await updateMilestone({ id: "m", patch: { plannedStartAt: "2026-06-02T00:00:00Z", plannedAt: "2026-06-03T00:00:00Z" }, updatedBy: USER });
    await updateMilestone({ id: "h", patch: { plannedStartAt: "2026-06-03T05:00:00Z", plannedAt: "2026-06-03T15:00:00Z" }, updatedBy: USER });
    expect(milestones()[0].shift).toBeNull();
    expect(milestones()[1].shift).toBe("day");
    const updates = db.writes.filter((w) => w.method === "update").map((w) => w.payload as Row);
    expect(updates.every((u) => !("shift" in u))).toBe(true); // nothing to re-label, so the column is not written
  });

  it("shiftAfterMove is the one rule (the RPC's CASE mirrors it)", () => {
    expect(shiftAfterMove(null, "2026-06-01T00:00:00Z", "2026-06-02T00:00:00Z")).toBeNull();
    expect(shiftAfterMove("swing", "2026-06-01T08:00:00Z", "2026-06-01T19:00:00Z")).toBe("swing");
    expect(shiftAfterMove("day", "2026-06-01T05:00:00Z", "2026-06-02T05:00:00Z")).toBe("day");
    expect(shiftAfterMove("day", "2026-06-01T08:00:00Z", "2026-06-01T19:00:00Z")).toBe("night");
    expect(shiftAfterMove("night", "2026-06-01T19:00:00+00:00", "2026-06-02T09:00:00Z")).toBe("day");
    expect(shiftAfterMove("day", null, "2026-06-01T19:00:00Z")).toBe("day"); // no prior start: not recomputed
  });

  it("the filter reads the stored label only — an unlabelled date-only row is not night work", () => {
    const mk = (over: Partial<Milestone>): Milestone => ({ orgId: ORG, name: "m", weight: 1, plannedAt: "2026-06-02T05:00:00Z", status: "planned", source: "manual", createdBy: USER, ...over });
    const rows = [
      mk({ id: "n", plannedStartAt: "2026-06-01T19:00:00Z", shift: "night" }),
      mk({ id: "u", plannedStartAt: "2026-06-01T00:00:00Z", shift: null }),
      mk({ id: "s", plannedStartAt: "2026-06-01T08:00:00Z", shift: "swing" }),
    ];
    expect([...filterMilestones(rows, { ...EMPTY_FILTER, shifts: ["night"] })]).toEqual(["n"]);
    expect([...filterMilestones(rows, { ...EMPTY_FILTER, shifts: ["day"] })]).toEqual([]);
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
      // b's caller-supplied lock below matches the row as read (the pre-read
      // refuses a stale view whole — PT SCH-7, J6b); an "unmatched" from the
      // RPC is the row changing in the instant between that read and the write.
      { id: "b", org_id: ORG, project_id: PROJECT, name: "B", planned_at: "2026-06-05T17:00:00Z", planned_start_at: "2026-06-04T08:00:00Z", updated_at: "2026-04-30T00:00:00+00:00", status: "in_progress" },
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
    const res = await applyMilestoneMoves({ ...actor, moves, onUnmatched: "return" });
    expect(db.rpcCalls[0].fn).toBe("apply_milestone_moves");
    expect((db.rpcCalls[0].args.p_moves as Row[]).map((m) => m.expected_updated_at)).toEqual(["2026-05-01T00:00:00+00:00", "2026-04-30T00:00:00+00:00"]);
    expect(res).toMatchObject({ matched: ["a"], unmatched: ["b"], count: 1, via: "rpc" });
    expect(res.auditError).toBeUndefined();
  });

  it("by default a rejected move is an ERROR, never a silent success: MoveConflictError after the trail is written, with both lists", async () => {
    seed();
    db.rpcImpl = () => ({ data: { count: 1, matched: ["a"], unmatched: ["b"] }, error: null });
    const err = await applyMilestoneMoves({ ...actor, moves }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(MoveConflictError);
    expect((err as Error).message).toBe("1 task was changed by someone else and was not moved (the other 1 moved). Reload the schedule and try again.");
    expect((err as MoveConflictError).result).toMatchObject({ matched: ["a"], unmatched: ["b"], count: 1 });
    // The move that matched is recorded like any other.
    expect((db.tables.milestone_notes ?? []).map((n) => n.milestone_id)).toEqual(["a"]);
    expect((db.tables.audit_logs ?? [])[0]).toMatchObject({ action: "MILESTONES_RESCHEDULED", details: { count: 1, unmatched: 1 } });
    // Nothing rejected: no error.
    seed(); db.rpcImpl = () => ({ data: { count: 2, matched: ["a", "b"], unmatched: [] }, error: null });
    await expect(applyMilestoneMoves({ ...actor, moves })).resolves.toMatchObject({ unmatched: [] });
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
    expect(res.auditError).toBe("audit: You don't have permission to do this — nothing was changed.");   // REL-3
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
    expect(milestones()[0].planned_at).toBe("2026-06-05T17:00:00+00:00");
    expect(milestones()[0].shift).toBeUndefined(); // an unlabelled row stays unlabelled (SCHED-9)
  });

  it("the pre-read failing never turns the lock off: nothing moves, with or without the caller's lock values (the imported-row and stale checks need the read — J6b)", async () => {
    seed();
    db.failSelect = (t) => (t === "milestones" ? "permission denied for table milestones" : null);
    db.rpcImpl = () => ({ data: { count: 2, matched: ["a", "b"], unmatched: [] }, error: null });
    await expect(applyMilestoneMoves({ ...actor, moves })).rejects.toThrow(/Could not read the tasks before moving them \(You don.t have permission to see this\.\) — nothing was moved/);
    expect(db.rpcCalls).toEqual([]);

    const locked = moves.map((m) => ({ ...m, expectedUpdatedAt: "2026-05-01T00:00:00+00:00" }));
    await expect(applyMilestoneMoves({ ...actor, moves: locked })).rejects.toThrow(/Could not read the tasks before moving them \(You don.t have permission to see this\.\) — nothing was moved/);
    expect(db.rpcCalls).toEqual([]);
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

describe("SCH-2 / SCH-16 · the review panel's numbers", () => {
  const plan = (over: Partial<ImportPlanT> = {}): ImportPlanT => ({
    added: 0, changed: 0, unchanged: 3, notInFile: 0, notInFileNames: [], localProgressAtRisk: [],
    structure: { rows: 0, onlyStructure: 0, parents: 0, linksAdded: 0, linksRemoved: 0 }, rekeyed: 0, rekeyedOnly: 0,
    positionAdopted: 0, positionAdoptedNames: [], positionRepeated: 0, positionRepeatedNames: [], rowCap: 5000, ...over,
  });
  it("a file that only removes a predecessor does not read 'Import 0 changes'", () => {
    expect(planChangeCount(plan())).toBe(0);
    expect(planChangeCount(plan({ added: 1, changed: 2, structure: { rows: 3, onlyStructure: 2, parents: 1, linksAdded: 0, linksRemoved: 2 } }))).toBe(5);
    expect(structureSummary({ rows: 3, onlyStructure: 2, parents: 1, linksAdded: 0, linksRemoved: 2 })).toBe("1 parent changed, 2 links removed");
  });
  it("rows that only need their new key count toward the button, and the panel says what re-keying means", () => {
    expect(planChangeCount(plan({ unchanged: 3, rekeyed: 3, rekeyedOnly: 3 }))).toBe(3);
    expect(rekeyedSummary({ rekeyed: 2 })).toBe("2 tasks imported earlier will be re-keyed — they keep their progress and history. A task matched on its earlier content key matches on name and dates exactly: if its name or dates changed in the file, it is added, and the earlier one is listed as not in this file.");
  });
  it("progress at risk is worded by direction, never as a 'reset' when the file is higher", () => {
    expect(progressChangeLabel(60, 80)).toBe("60% on the board → 80% in the file (higher)");
    expect(progressChangeLabel(60, 0)).toBe("60% on the board → 0% in the file (lower)");
  });
});

describe("SCHED-3 · the move sheet's baseline line reads the change set it is handed", () => {
  it("counts every row in the set that would finish past its baseline — a cascaded dependent counts even when the dragged task has none", () => {
    const rows = [
      { plannedAt: "2026-06-10T17:00:00Z", baselineFinishAt: null },                       // the dragged task: no baseline
      { plannedAt: "2026-06-12T17:00:00Z", baselineFinishAt: "2026-06-11T17:00:00+00:00" }, // its FS dependent, pushed past
      { plannedAt: "2026-06-12T17:00:00Z", baselineFinishAt: "2026-06-12T17:00:00+00:00" }, // exactly on it: not past
    ];
    expect(countPastBaseline(rows)).toBe(1);
    expect(countPastBaseline([])).toBe(0);
  });
});

describe("SURF-8 · baseline history is RPC-written, so restore never blind-imports it", () => {
  it("milestone_baseline_history is immutable and skipped (kept in the backup for review)", () => {
    expect(isImmutableTable("milestone_baseline_history")).toBe(true);
    expect(isSkippedTable("milestone_baseline_history")).toBe(true);
  });
});
