// projects-joint J15c CHECKED-WRITE SWEEP (projects-tab SAF-18; DEC-90's
// rulings for the sweep) — the projects / admin batch.
//
// Every update / delete in lib/milestones.ts, lib/projects.ts,
// lib/projectReport.ts, lib/companies.ts, lib/teams.ts and
// lib/accessRecert.ts now reads its matched rows (lib/checkedWrite.ts). Each
// converted function is driven here against an in-memory PostgREST double
// whose UPDATE / DELETE answers the rows it matched — and, like row-level
// security, answers NO rows (and no error) for a row the policy hides:
//
//   * a person's decision (DEC-90 class a): zero rows is the refusal
//     (CHECKED_WRITE_REFUSED) to the caller, and no audit row, feed row,
//     note or notice follows it;
//   * bookkeeping after a person's act (class b): never fails the act, is
//     logged, never taken as written;
//   * a legitimate no-op (class c): stays a success.
//
// And the ordinary path is the same as before: the same writes, the same
// audit rows, the same return shape.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Row = Record<string, unknown>;
type Err = { message: string; code?: string };
const db = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  /** Row-level security's quiet refusal: an UPDATE / DELETE matches nothing it returns true for. */
  hides: null as null | ((table: string, op: "update" | "delete", row: Row) => boolean),
  /** A database error for this write (or read). */
  fails: null as null | ((table: string, op: string, payload: unknown) => Err | null),
  writes: [] as Array<{ table: string; op: string; payload: unknown; matched: number }>,
  rpc: {} as Record<string, { data: unknown; error: Err | null }>,
  audits: [] as Row[],
  milestoneEvents: [] as Row[],
  notices: [] as Row[],
  emits: [] as Row[],
  nextId: 1,
}));

function builder(table: string) {
  const st = {
    op: "select" as "select" | "insert" | "upsert" | "update" | "delete",
    payload: null as unknown, filters: [] as Array<[string, string, unknown]>, single: false, head: false,
  };
  const match = (r: Row) => st.filters.every(([col, op, val]) => {
    if (op === "eq") return String(r[col]) === String(val);
    if (op === "in") return (val as unknown[]).map(String).includes(String(r[col]));
    if (op === "is") return val === null ? r[col] == null : r[col] === val;
    if (op === "not-is") return !(val === null ? r[col] == null : r[col] === val);
    return true;
  });
  const exec = () => {
    const t = (db.tables[table] ??= []);
    const err = db.fails?.(table, st.op, st.payload) ?? null;
    if (err) {
      if (st.op !== "select") db.writes.push({ table, op: st.op, payload: st.payload, matched: 0 });
      return { data: null, error: err, count: null };
    }
    if (st.op === "select") {
      const out = t.filter(match);
      if (st.head) return { data: null, error: null, count: out.length };
      return { data: st.single ? (out[0] ?? null) : out, error: null, count: null };
    }
    if (st.op === "insert" || st.op === "upsert") {
      const sent = (Array.isArray(st.payload) ? st.payload : [st.payload]) as Row[];
      const out = sent.map((r) => {
        const existing = st.op === "upsert" && r.id ? t.find((x) => x.id === r.id) : undefined;
        if (existing) { Object.assign(existing, r); return existing; }
        const row = { id: `n${db.nextId++}`, ...r };
        t.push(row);
        return row;
      });
      db.writes.push({ table, op: st.op, payload: st.payload, matched: out.length });
      return { data: st.single ? out[0] : out, error: null, count: null };
    }
    const target = t.filter(match).filter((r) => !db.hides?.(table, st.op as "update" | "delete", r));
    db.writes.push({ table, op: st.op, payload: st.payload, matched: target.length });
    if (st.op === "update") for (const r of target) Object.assign(r, st.payload as Row);
    else db.tables[table] = t.filter((r) => !target.includes(r));
    return { data: st.single ? (target[0] ?? null) : target.map((r) => ({ ...r })), error: null, count: null };
  };
  const proxy: unknown = new Proxy({}, {
    get(_t, prop: string) {
      if (prop === "then") return (resolve: (v: unknown) => void, reject?: (e: unknown) => void) => { try { resolve(exec()); } catch (e) { reject?.(e); } };
      return (...args: unknown[]) => {
        switch (prop) {
          // a snapshot: a caller may reuse (and change) the object for a retry
          case "insert": case "upsert": case "update": st.op = prop; st.payload = JSON.parse(JSON.stringify(args[0])); break;
          case "delete": st.op = "delete"; break;
          case "select": if ((args[1] as { head?: boolean } | undefined)?.head) st.head = true; break;
          case "eq": st.filters.push([String(args[0]), "eq", args[1]]); break;
          case "in": st.filters.push([String(args[0]), "in", args[1]]); break;
          case "is": st.filters.push([String(args[0]), "is", args[1]]); break;
          case "not": st.filters.push([String(args[0]), `not-${String(args[1])}`, args[2]]); break;
          case "maybeSingle": case "single": st.single = true; break;
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
    rpc: async (fn: string) => db.rpc[fn] ?? { data: null, error: { code: "PGRST202", message: `Could not find the function public.${fn} in the schema cache` } },
    auth: { getSession: async () => ({ data: { session: null } }) },
  },
}));
vi.mock("@/lib/audit", () => ({
  logAuditAction: vi.fn(async (e: Row) => { db.audits.push(e); return { ok: true, error: null }; }),
  logMilestoneEvent: vi.fn(async (e: Row) => { db.milestoneEvents.push(e); return { ok: true, error: null }; }),
  logCheckoutEvent: vi.fn(async () => ({ error: null })),
}));
vi.mock("@/lib/notify/dispatch", () => ({ emit: vi.fn(async (p: Row) => { db.emits.push(p); }) }));
vi.mock("@/lib/notify/recipients", () => ({ projectVisibleAmong: vi.fn(async (_o: string, _p: string, ids: string[]) => ids) }));
vi.mock("@/lib/inAppNotifications", () => ({
  notify: vi.fn(async (n: Row) => { db.notices.push(n); return true; }),
  notifyMany: vi.fn(async () => undefined),
  notifyBatchChecked: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/lib/watches", () => ({ listFollowerIds: vi.fn(async () => []) }));
vi.mock("@/lib/checkoutEpisodes", () => ({
  ensureActiveEpisode: vi.fn(async () => null),
  postEpisodeSystemMessage: vi.fn(async () => undefined),
  reconcileDocumentCheckoutState: vi.fn(async () => undefined),
  isMissingOutcomeSchema: () => false,
}));
vi.mock("@/lib/complianceNotify", () => ({
  notifyCompliance: vi.fn(async () => true),
  loadScanRetryPlan: vi.fn(async () => ({ only: () => () => true })),
}));
vi.mock("@/lib/ownership", () => ({ getOrgControllers: vi.fn(async () => ["ctl"]) }));

import { CHECKED_WRITE_REFUSED } from "@/lib/checkedWrite";
import {
  updateMilestone, setMilestoneStatus, setMilestoneProgress, importGhostMilestones, importMilestonesFromParsed,
  rebaseSchedule, groupTasksUnderParent, setTaskDuration, setBaseline,
} from "@/lib/milestones";
import {
  releaseAllCheckoutsForProject, attachCheckoutToProject, removeMember, deleteProject, transferOwnership,
  updateMember, updateProjectMeta, bulkCheckoutToProject,
} from "@/lib/projects";
import { saveLessonsLearned } from "@/lib/projectReport";
import { saveCompany, confirmQualityManual } from "@/lib/companies";
import { deleteTeam, removeTeamMember } from "@/lib/teams";
import { scanAccessRecerts } from "@/lib/accessRecert";

const writesTo = (table: string, op?: string) => db.writes.filter((w) => w.table === table && (!op || w.op === op));
const refuse = (table: string, op: "update" | "delete", pick: (r: Row) => boolean = () => true) => {
  db.hides = (t, o, r) => t === table && o === op && pick(r);
};
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  db.tables = {}; db.hides = null; db.fails = null; db.writes = []; db.rpc = {};
  db.audits = []; db.milestoneEvents = []; db.notices = []; db.emits = []; db.nextId = 1;
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => { warn.mockRestore(); });

// ── lib/milestones.ts ───────────────────────────────────────────────────

const milestone = (id: string, extra: Row = {}): Row => ({
  id, org_id: "o1", project_id: "p1", document_id: null, parent_id: null, name: `Task ${id}`, description: null,
  weight: 1, percent_complete: 0, planned_at: "2026-06-10T00:00:00Z", planned_start_at: "2026-06-08T00:00:00Z",
  actual_at: null, actual_start_at: null, first_completed_at: null, status: "planned", is_summary: false, source: "manual",
  external_ref: null, depends_on: [], attributes: {}, updated_at: "2026-06-01T00:00:00Z", baseline_finish_at: null,
  responsible_user_id: null, shift: null, ...extra,
});

describe("lib/milestones.ts — a person's schedule edits (class a)", () => {
  beforeEach(() => { db.tables.milestones = [milestone("m1")]; db.tables.projects = [{ id: "p1", org_id: "o1", name: "TA", owner_user_id: "own" }]; });

  it("updateMilestone: the saved row comes back and is audited as before; a refused edit throws CHECKED_WRITE_REFUSED and audits nothing", async () => {
    const m = await updateMilestone({ id: "m1", patch: { description: "Scaffold first" }, updatedBy: "u1" });
    expect(m.id).toBe("m1");
    expect(m.description).toBe("Scaffold first");
    expect(db.milestoneEvents.map((e) => e.type)).toEqual(["MILESTONE_UPDATED"]);
    refuse("milestones", "update");
    await expect(updateMilestone({ id: "m1", patch: { description: "again" }, updatedBy: "u1" })).rejects.toThrow(CHECKED_WRITE_REFUSED);
    expect(db.milestoneEvents).toHaveLength(1);
  });

  it("updateMilestone: a database error keeps the sentence the page showed before", async () => {
    db.fails = (t, op) => (t === "milestones" && op === "update" ? { message: 'new row violates row-level security policy for table "milestones"', code: "42501" } : null);
    await expect(updateMilestone({ id: "m1", patch: { description: "x" }, updatedBy: "u1" })).rejects.toThrow(/permission/i);
    expect(db.milestoneEvents).toEqual([]);
  });

  it("setMilestoneStatus: completes as before (note + MILESTONE_COMPLETED); refused — no note, no audit, no notice", async () => {
    const m = await setMilestoneStatus({ id: "m1", status: "completed", actorUserId: "u1" });
    expect(m.status).toBe("completed");
    expect(writesTo("milestone_notes", "insert")).toHaveLength(1);
    expect(db.milestoneEvents.map((e) => e.type)).toEqual(["MILESTONE_COMPLETED"]);
    db.writes = []; db.milestoneEvents = []; db.emits = [];
    refuse("milestones", "update");
    await expect(setMilestoneStatus({ id: "m1", status: "blocked", statusReason: "parts", actorUserId: "u1" })).rejects.toThrow(CHECKED_WRITE_REFUSED);
    expect(writesTo("milestone_notes")).toEqual([]);
    expect(db.milestoneEvents).toEqual([]);
    await new Promise((r) => setTimeout(r, 0));
    expect(db.emits).toEqual([]);
  });

  it("setMilestoneProgress: as before when it lands; refused — no note, no audit", async () => {
    const m = await setMilestoneProgress({ id: "m1", percentComplete: 40, actorUserId: "u1" });
    expect(m.percentComplete).toBe(40);
    expect(db.milestoneEvents.map((e) => e.type)).toEqual(["MILESTONE_UPDATED"]);
    db.writes = []; db.milestoneEvents = [];
    refuse("milestones", "update");
    await expect(setMilestoneProgress({ id: "m1", percentComplete: 60, actorUserId: "u1" })).rejects.toThrow(CHECKED_WRITE_REFUSED);
    expect(writesTo("milestone_notes")).toEqual([]);
    expect(db.milestoneEvents).toEqual([]);
  });

  it("importGhostMilestones: a re-imported row is counted updated only when the update matched it", async () => {
    db.tables.milestones = [milestone("m1", { source: "p6", external_ref: "A100" })];
    const csv = "name,planned_at,external_ref\nPump swap,2026-07-01,A100";
    const ok = await importGhostMilestones({ orgId: "o1", projectId: "p1", source: "p6", csv, createdBy: "u1" });
    expect(ok).toMatchObject({ updated: 1, errors: [] });
    refuse("milestones", "update");
    const no = await importGhostMilestones({ orgId: "o1", projectId: "p1", source: "p6", csv, createdBy: "u1" });
    expect(no.updated).toBe(0);
    expect(no.errors).toEqual(["Row 2: not changed (you may not be allowed to, or someone else changed it first)"]);
  });

  it("rebaseSchedule: a task the update did not match is reported left unchanged (never counted shifted) — the audit row carries only what moved", async () => {
    db.tables.milestones = [milestone("m1"), milestone("m2", { planned_at: "2026-06-12T00:00:00Z", planned_start_at: "2026-06-11T00:00:00Z" })];
    refuse("milestones", "update", (r) => r.id === "m2");
    const res = await rebaseSchedule({ orgId: "o1", projectId: "p1", newStartIso: "2026-06-15T00:00:00Z", actorUserId: "u1" });
    expect(res.shiftedCount).toBe(1);
    expect(res.errors).toEqual(["1 task were left unchanged — someone else edited it during the rebase, or you can't change it. Re-check those dates."]);
    expect(db.audits.find((a) => a.action === "SCHEDULE_REBASED")?.details).toMatchObject({ shiftedCount: 1 });
    // ordinary: both move, no message
    db.hides = null; db.audits = [];
    const all = await rebaseSchedule({ orgId: "o1", projectId: "p1", newStartIso: "2026-06-22T00:00:00Z", actorUserId: "u1" });
    expect(all).toMatchObject({ shiftedCount: 2, errors: [] });
  });

  it("groupTasksUnderParent: a child the update did not match is an error and is not counted in the TASKS_GROUPED row", async () => {
    db.tables.milestones = [milestone("par", { is_summary: true }), milestone("c1"), milestone("c2")];
    refuse("milestones", "update", (r) => r.id === "c2");
    const res = await groupTasksUnderParent({ orgId: "o1", projectId: "p1", parentId: "par", childIds: ["c1", "c2"], actorUserId: "u1" });
    expect(res.childCount).toBe(1);
    expect(res.errors).toEqual(["c2: not changed (you may not be allowed to, or someone else changed it first)"]);
    expect(db.audits.find((a) => a.action === "TASKS_GROUPED")?.details).toMatchObject({ childCount: 1 });
    db.hides = null;
    const ok = await groupTasksUnderParent({ orgId: "o1", projectId: "p1", parentId: "par", childIds: ["c1", "c2"], actorUserId: "u1" });
    expect(ok).toMatchObject({ childCount: 2, errors: [] });
  });

  it("setTaskDuration: refused in words when the update matched nothing (no reflow follows); ok as before when it lands", async () => {
    refuse("milestones", "update");
    expect(await setTaskDuration({ id: "m1", days: 3, actorUserId: "u1" })).toEqual({ ok: false, error: CHECKED_WRITE_REFUSED });
    expect(writesTo("milestones", "update")).toHaveLength(1);
    db.hides = null;
    expect(await setTaskDuration({ id: "m1", days: 3, actorUserId: "u1" })).toEqual({ ok: true });
  });

  it("setTaskDuration (class b): a summary the envelope could not move never fails the call — it is logged, not taken as moved", async () => {
    db.tables.milestones = [
      milestone("par", { is_summary: true, planned_start_at: "2026-06-09T00:00:00Z", planned_at: "2026-06-10T00:00:00Z" }),
      milestone("m1", { parent_id: "par" }),
    ];
    refuse("milestones", "update", (r) => r.id === "par");
    expect(await setTaskDuration({ id: "m1", days: 5, actorUserId: "u1" })).toEqual({ ok: true });
    expect(warn.mock.calls.map((c: unknown[]) => String(c[0]))).toContain(`[milestones] summary par was not re-enveloped after a duration change: ${CHECKED_WRITE_REFUSED}`);
  });

  it("setBaseline (legacy, before 20261099): a row the update did not match is not counted; the result says so", async () => {
    db.tables.milestones = [milestone("m1"), milestone("m2")];
    refuse("milestones", "update", (r) => r.id === "m2");
    const res = await setBaseline({ orgId: "o1", projectId: "p1", actorUserId: "u1" });
    expect(res).toMatchObject({ ok: false, count: 1, via: "legacy", error: "Baseline applied to 1 of 2 tasks — a task was not changed (you may not be allowed to, or someone else changed it first)" });
    expect(db.audits.find((a) => a.action === "SCHEDULE_BASELINED")?.details).toMatchObject({ count: 1, requested: 2, partial: true });
    db.hides = null;
    expect(await setBaseline({ orgId: "o1", projectId: "p1", actorUserId: "u1" })).toMatchObject({ ok: true, count: 2, via: "legacy" });
  });
});

describe("lib/milestones.ts — importMilestonesFromParsed's per-row and structure writes", () => {
  const row = (ref: string, extra: Row = {}) => ({ name: `Task ${ref}`, plannedAt: "2026-07-01T00:00:00Z", externalRef: ref, ...extra });

  it("the per-row fallback counts a row updated only when the update matched it", async () => {
    db.tables.milestones = [milestone("m1", { source: "p6", external_ref: "A1" }), milestone("m2", { source: "p6", external_ref: "A2" })];
    // the chunk upsert fails (not a schema error) → each row is written on its own
    db.fails = (t, op) => (t === "milestones" && op === "upsert" ? { message: "deadlock detected", code: "40P01" } : null);
    refuse("milestones", "update", (r) => r.id === "m2");
    const res = await importMilestonesFromParsed({ orgId: "o1", projectId: "p1", source: "p6", rows: [row("A1"), row("A2")] as never, createdBy: "u1" });
    expect(res.updated).toBe(1);
    expect(res.errors.some((e) => e.endsWith(": not changed (you may not be allowed to, or someone else changed it first)"))).toBe(true);
  });

  it("a structure write the update did not match is reported, never silent", async () => {
    db.tables.milestones = [milestone("m1", { source: "p6", external_ref: "P" }), milestone("m2", { source: "p6", external_ref: "C" })];
    refuse("milestones", "update", (r) => r.id === "m2");
    const res = await importMilestonesFromParsed({ orgId: "o1", projectId: "p1", source: "p6", rows: [row("P"), row("C", { parentExternalRef: "P" })] as never, createdBy: "u1" });
    expect(res.errors).toContain("Structure for m2: not changed (you may not be allowed to, or someone else changed it first)");
  });
});

// ── lib/projects.ts ─────────────────────────────────────────────────────

const seedProject = () => {
  db.tables.projects = [{ id: "p1", org_id: "o1", name: "TA", owner_user_id: "own", status: "active" }];
  db.tables.org_members = [{ org_id: "o1", uid: "own", role: "Engineer", roles: ["Engineer"], status: "active" }];
};

describe("lib/projects.ts", () => {
  beforeEach(seedProject);

  it("releaseAllCheckoutsForProject: another holder's session the update did not match is reported still held, with the refusal — never dropped, never CHECK_IN", async () => {
    db.tables.checkout_sessions = [
      { id: "s-own", document_id: "d1", org_id: "o1", user_id: "own", user_name: "Owner", project_id: "p1", status: "active" },
      { id: "s-ann", document_id: "d2", org_id: "o1", user_id: "ann", user_name: "ann", project_id: "p1", status: "active" },
    ];
    refuse("checkout_sessions", "update", (r) => r.id === "s-ann");
    const out = await releaseAllCheckoutsForProject({ projectId: "p1", reason: "closed", actorUserId: "own" });
    expect(out.releasedSessionIds).toEqual(["s-own"]);
    expect(out.stillHeld).toEqual([{ sessionId: "s-ann", documentId: "d2", userId: "ann", userName: "ann", reason: "The release was not applied: the database did not change it (you may not be allowed to, or someone else changed it first)." }]);
    expect(db.audits.filter((a) => a.action === "CHECK_IN").map((a) => a.resourceId)).toEqual(["d1"]);
  });

  it("releaseAllCheckoutsForProject (class c): a holder who checked in between the read and the release is not reported still held", async () => {
    db.tables.checkout_sessions = [
      { id: "s-own", document_id: "d1", org_id: "o1", user_id: "own", user_name: "Owner", project_id: "p1", status: "active" },
      { id: "s-ann", document_id: "d2", org_id: "o1", user_id: "ann", user_name: "ann", project_id: "p1", status: "active" },
    ];
    // ann checks in just before the release's UPDATE reaches her session
    db.hides = (t, o, r) => {
      if (t !== "checkout_sessions" || o !== "update" || r.id !== "s-ann") return false;
      r.status = "checked_in";
      return true;
    };
    const out = await releaseAllCheckoutsForProject({ projectId: "p1", reason: "closed", actorUserId: "own" });
    expect(out).toEqual({ released: 1, releasedSessionIds: ["s-own"], stillHeld: [] });
    expect(db.audits.filter((a) => a.action === "CHECK_IN").map((a) => a.resourceId)).toEqual(["d1"]);
  });

  it("releaseAllCheckoutsForProject (class c): the actor's own session already checked in meanwhile is no error — only what came back is released", async () => {
    db.tables.checkout_sessions = [{ id: "s-own", document_id: "d1", org_id: "o1", user_id: "own", user_name: "Owner", project_id: "p1", status: "active" }];
    refuse("checkout_sessions", "update");
    const out = await releaseAllCheckoutsForProject({ projectId: "p1", reason: "closed", actorUserId: "own" });
    expect(out).toEqual({ released: 0, releasedSessionIds: [], stillHeld: [] });
    expect(db.audits).toEqual([]);
  });

  it("attachCheckoutToProject: refused — thrown, and no checkout_added feed row", async () => {
    db.tables.checkout_sessions = [{ id: "s1", project_id: null }];
    refuse("checkout_sessions", "update");
    await expect(attachCheckoutToProject({ checkoutSessionId: "s1", projectId: "p1", orgId: "o1", actorUserId: "own" })).rejects.toThrow(CHECKED_WRITE_REFUSED);
    expect(writesTo("project_activity")).toEqual([]);
    db.hides = null;
    await attachCheckoutToProject({ checkoutSessionId: "s1", projectId: "p1", orgId: "o1", actorUserId: "own" });
    expect(writesTo("project_activity", "insert")).toHaveLength(1);
  });

  it("removeMember: refused — thrown; no feed row, no PROJECT_MEMBER_REMOVED, no notice to the person", async () => {
    db.tables.project_members = [{ id: "pm1", project_id: "p1", user_id: "bob", role: "collaborator" }];
    refuse("project_members", "delete");
    await expect(removeMember({ projectId: "p1", orgId: "o1", userId: "bob", actorUserId: "own" })).rejects.toThrow(CHECKED_WRITE_REFUSED);
    expect(writesTo("project_activity")).toEqual([]);
    expect(db.audits).toEqual([]);
    expect(db.notices).toEqual([]);
    db.hides = null;
    await removeMember({ projectId: "p1", orgId: "o1", userId: "bob", actorUserId: "own" });
    expect(db.audits.map((a) => a.action)).toEqual(["PROJECT_MEMBER_REMOVED"]);
    expect(db.notices).toHaveLength(1);
  });

  it("deleteProject before 20261103: schedule tasks the DELETE did not remove are audited and returned as a warning — the deletion that landed is never thrown over", async () => {
    db.tables.milestones = [milestone("m1"), milestone("m2")];
    refuse("milestones", "delete");
    const out = await deleteProject({ projectId: "p1", actorUserId: "own" });
    expect(db.tables.projects).toEqual([]);
    expect(out.warning).toBe("The project was deleted, but not all of its 2 schedule task(s) were: the database removed 0 of 2 (you may not be allowed to delete them, or someone else changed them first). The tasks left no longer belong to a project — ask an Admin or Document Control to remove them.");
    expect(db.audits.find((a) => a.action === "PROJECT_DELETED")?.details).toMatchObject({ scheduleError: "the database removed 0 of 2 (you may not be allowed to delete them, or someone else changed them first)" });
  });

  it("deleteProject before 20261103: a schedule delete the database errors on still throws, as before", async () => {
    db.tables.milestones = [milestone("m1")];
    db.fails = (t, op) => (t === "milestones" && op === "delete" ? { message: "canceling statement due to statement timeout", code: "57014" } : null);
    await expect(deleteProject({ projectId: "p1", actorUserId: "own" })).rejects.toThrow(/^The project was deleted, but its 1 schedule task\(s\) were not: /);
  });

  it("the project page shows the delete's warning after it leaves the deleted project", () => {
    const page = readFileSync(join(process.cwd(), "app/(protected)/projects/[id]/page.tsx"), "utf8");
    expect(page).toContain('router.push("/projects");\n      // SAF-18 (J15c): the project is gone; what did not go with it is said after leaving its page.\n      if (out.warning) void appAlert({ message: out.warning, tone: "danger" });');
  });

  it("deleteProject before 20261103: the ordinary path deletes the project, then its schedule, audited without an error", async () => {
    db.tables.milestones = [milestone("m1"), milestone("m2")];
    const out = await deleteProject({ projectId: "p1", actorUserId: "own" });
    expect(out).toMatchObject({ counts: expect.any(Object) });
    expect(out).not.toHaveProperty("warning");
    expect(db.tables.milestones).toEqual([]);
    expect(db.audits.find((a) => a.action === "PROJECT_DELETED")?.details).not.toHaveProperty("scheduleError");
  });

  it("transferOwnership before 20261102: a refused demotion of the previous owner is told apart from the no-op", async () => {
    db.tables.org_members.push({ org_id: "o1", uid: "new", role: "Engineer", status: "active" });
    db.tables.project_members = [{ id: "pm-own", project_id: "p1", user_id: "own", role: "owner" }];
    refuse("project_members", "update");
    await expect(transferOwnership({ projectId: "p1", newOwnerUserId: "new", actorUserId: "own" }))
      .rejects.toThrow("Ownership moved, but the previous owner's roster row was not updated: the database did not change it (you may not be allowed to, or someone else changed it first). Reload the project to check its team.");
    expect(db.audits).toEqual([]);
  });

  it("transferOwnership before 20261102: a previous owner with no 'owner' roster row is the no-op — the transfer is audited as before", async () => {
    db.tables.org_members.push({ org_id: "o1", uid: "new", role: "Engineer", status: "active" });
    db.tables.project_members = [];
    await transferOwnership({ projectId: "p1", newOwnerUserId: "new", actorUserId: "own" });
    expect(db.audits.map((a) => a.action)).toEqual(["PROJECT_OWNERSHIP_TRANSFERRED"]);
  });

  it("updateMember: refused — thrown in words; lands as before", async () => {
    db.tables.project_members = [{ id: "pm1", project_id: "p1", user_id: "bob", role: "collaborator", responsibility: null }];
    refuse("project_members", "update");
    await expect(updateMember({ projectId: "p1", userId: "bob", responsibility: "Welding", actorUserId: "own" })).rejects.toThrow(CHECKED_WRITE_REFUSED);
    db.hides = null;
    await updateMember({ projectId: "p1", userId: "bob", responsibility: "Welding", actorUserId: "own" });
    expect(db.tables.project_members[0].responsibility).toBe("Welding");
  });

  it("updateProjectMeta: refused — thrown; no feed row and no PROJECT_UPDATED", async () => {
    refuse("projects", "update");
    await expect(updateProjectMeta({ projectId: "p1", patch: { name: "TA 2027" }, actorUserId: "own" })).rejects.toThrow(CHECKED_WRITE_REFUSED);
    expect(writesTo("project_activity")).toEqual([]);
    expect(db.audits).toEqual([]);
    db.hides = null;
    await updateProjectMeta({ projectId: "p1", patch: { name: "TA 2027" }, actorUserId: "own" });
    expect(db.audits.map((a) => a.action)).toEqual(["PROJECT_UPDATED"]);
  });

  it("bulkCheckoutToProject (class b): a documents pointer the update did not match is logged; the checkout still counts", async () => {
    db.tables.documents = [{ id: "d1" }];
    refuse("documents", "update");
    const res = await bulkCheckoutToProject({ orgId: "o1", docs: [{ id: "d1", libraryId: "L" }], actorUserId: "own", actorEmail: "own@x" });
    expect(res).toMatchObject({ checkedOutCount: 1, skipped: [] });
    expect(writesTo("checkout_sessions", "insert")).toHaveLength(1);
    expect(warn.mock.calls.map((c: unknown[]) => String(c[0]))).toContain(`[bulkCheckout] the checkout pointer on document d1 was not written: ${CHECKED_WRITE_REFUSED}`);
  });
});

// ── lib/projectReport.ts, lib/companies.ts, lib/teams.ts, lib/accessRecert.ts ──

describe("lib/projectReport.ts — saveLessonsLearned", () => {
  it("refused — { ok: false } with the refusal, and no PROJECT_LESSONS_SAVED row; lands as before", async () => {
    db.tables.projects = [{ id: "p1", lessons_learned: null }];
    refuse("projects", "update");
    expect(await saveLessonsLearned({ orgId: "o1", projectId: "p1", text: "Order valves early", actorId: "u1" })).toEqual({ ok: false, error: CHECKED_WRITE_REFUSED });
    expect(writesTo("audit_logs")).toEqual([]);
    db.hides = null;
    expect(await saveLessonsLearned({ orgId: "o1", projectId: "p1", text: "Order valves early", actorId: "u1" })).toEqual({ ok: true });
    expect(writesTo("audit_logs", "insert")).toHaveLength(1);
  });
});

describe("lib/companies.ts", () => {
  beforeEach(() => { db.tables.companies = [{ id: "c1", org_id: "o1", name: "Gulf", kind: "contractor", status: "active" }]; });

  it("saveCompany (edit): refused — thrown, no COMPANY_UPDATED; lands and returns the saved company as before", async () => {
    refuse("companies", "update");
    await expect(saveCompany({ orgId: "o1", id: "c1", name: "Gulf Mech", kind: "contractor", actorId: "u1" })).rejects.toThrow(CHECKED_WRITE_REFUSED);
    expect(db.audits).toEqual([]);
    db.hides = null;
    const c = await saveCompany({ orgId: "o1", id: "c1", name: "Gulf Mech", kind: "contractor", actorId: "u1" });
    expect(c).toMatchObject({ id: "c1", name: "Gulf Mech" });
    expect(db.audits.map((a) => a.action)).toEqual(["COMPANY_UPDATED"]);
  });

  it("confirmQualityManual: refused — thrown, no COMPANY_QM_CONFIRMED; the pre-20261096 retry still sees the full error and lands", async () => {
    const input = { orgId: "o1", companyId: "c1", documentId: "d1", score: 80, gaps: [], actorId: "u1", pagesRead: 3, pagesTotal: 4 };
    refuse("companies", "update");
    await expect(confirmQualityManual(input)).rejects.toThrow(CHECKED_WRITE_REFUSED);
    expect(db.audits).toEqual([]);
    db.hides = null;
    db.fails = (t, op, payload) => (t === "companies" && op === "update" && "quality_manual_pages_read" in (payload as Row)
      ? { code: "PGRST204", message: "Could not find the 'quality_manual_pages_read' column of 'companies' in the schema cache" } : null);
    await confirmQualityManual(input);
    expect(writesTo("companies", "update").map((w) => "quality_manual_pages_read" in (w.payload as Row))).toEqual([true, true, false]);
    expect(db.audits.map((a) => a.action)).toEqual(["COMPANY_QM_CONFIRMED"]);
  });
});

describe("lib/teams.ts", () => {
  beforeEach(() => {
    db.tables.libraries = [{ id: "l1", name: "Drawings", org_id: "o1", owner_team_id: "t1" }];
    db.tables.teams = [{ id: "t1" }];
  });

  it("deleteTeam: a library release the update did not match stops the delete — no OWNER_TEAM_CLEARED, no TEAM_DELETED", async () => {
    refuse("libraries", "update");
    await expect(deleteTeam("t1", { orgId: "o1", actorId: "a" })).rejects.toThrow(/^Team not deleted: library "Drawings" is still owned by it and could not be released \(the database did not change it — you may not be allowed to, or someone else changed it first\)\.$/);
    expect(writesTo("teams")).toEqual([]);
    expect(db.audits).toEqual([]);
  });

  it("deleteTeam: a team delete that matched nothing is refused — no TEAM_DELETED; the ordinary path audits as before", async () => {
    refuse("teams", "delete");
    await expect(deleteTeam("t1", { orgId: "o1", actorId: "a" })).rejects.toThrow(`Team not deleted: ${CHECKED_WRITE_REFUSED}`);
    expect(db.audits.map((a) => a.action)).toEqual(["OWNER_TEAM_CLEARED"]);
    db.hides = null; db.audits = [];
    await deleteTeam("t1", { orgId: "o1", actorId: "a" });
    expect(db.audits.map((a) => a.action)).toEqual(["TEAM_DELETED"]);
  });

  it("removeTeamMember: a delete that matched nothing is refused; lands and audits as before", async () => {
    db.tables.team_members = [{ team_id: "t1", uid: "bob" }];
    refuse("team_members", "delete");
    await expect(removeTeamMember("t1", "bob", { orgId: "o1", actorId: "a" })).rejects.toThrow("The member could not be removed from the team (not found or not permitted).");
    expect(db.audits).toEqual([]);
    db.hides = null;
    await removeTeamMember("t1", "bob", { orgId: "o1", actorId: "a" });
    expect(db.audits.map((a) => a.action)).toEqual(["TEAM_MEMBER_REMOVED"]);
  });
});

describe("lib/accessRecert.ts — the scan's notice stamp (class b)", () => {
  it("a stamp the update did not match is logged and never fails the scan; a stamp that lands is written as before", async () => {
    db.tables.libraries = [{ id: "l1", name: "Drawings", org_id: "o1", next_recertification_date: "2026-01-01", recert_notified_at: null, owner_user_id: "own" }];
    refuse("libraries", "update");
    expect(await scanAccessRecerts("o1")).toBe(1);
    expect(warn.mock.calls.map((c: unknown[]) => String(c[0]))).toContain(`[accessRecert] the notice stamp on library l1 was not written: ${CHECKED_WRITE_REFUSED}`);
    expect(db.tables.libraries[0].recert_notified_at).toBeNull();
    db.hides = null;
    expect(await scanAccessRecerts("o1")).toBe(1);
    expect(db.tables.libraries[0].recert_notified_at).toEqual(expect.any(String));
  });
});

// ── the census, per file ────────────────────────────────────────────────

/** lib/__tests__/checkedWrite.test.ts's own writeSites, verbatim. */
function writeSites(text: string): Array<{ line: number; checked: boolean }> {
  const out: Array<{ line: number; checked: boolean }> = [];
  for (const m of text.matchAll(/\.(update|delete)\(/g)) {
    const at = m.index ?? 0;
    const start = Math.max(text.lastIndexOf(";", at), text.lastIndexOf("{", at)) + 1;
    const end = text.indexOf(";", at);
    const stmt = text.slice(start, end < 0 ? text.length : end);
    if (!stmt.includes("supabase")) continue;
    const after = text.slice(end < 0 ? text.length : end, (end < 0 ? text.length : end) + 400);
    const countChecked = /\.select\("id"\)/.test(stmt + after.slice(0, 200)) && /\.length\b/.test(after);
    out.push({ line: text.slice(0, at).split("\n").length, checked: stmt.includes("checkedWrite(") || countChecked });
  }
  return out;
}

describe("census — J15c's files carry no unchecked update / delete (SAF-18)", () => {
  const FILES: Record<string, number> = {
    // file → write sites measured at this package (every one checked)
    "lib/milestones.ts": 17, "lib/projects.ts": 12, "lib/projectReport.ts": 1, "lib/companies.ts": 3,
    "lib/teams.ts": 6, "lib/accessRecert.ts": 5, "components/projects/EditProjectModal.tsx": 1,
    "components/projects/IntakePanel.tsx": 8, "components/projects/ProjectWizard.tsx": 1,
    "components/projects/cost/ChangeOrdersPanel.tsx": 1, "app/api/intake/upload/route.ts": 15,
    "app/api/projects/cost-docs/route.ts": 1,
  };
  for (const [f, n] of Object.entries(FILES)) {
    it(`${f}: ${n} write sites, none unchecked`, () => {
      const sites = writeSites(readFileSync(join(process.cwd(), f), "utf8"));
      expect(sites.length).toBeGreaterThan(0);
      expect(sites.filter((s) => !s.checked).map((s) => `L${s.line}`)).toEqual([]);
    });
  }
});
