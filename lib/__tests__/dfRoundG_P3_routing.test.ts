// drafting-flow Round G, DF-P3 ROUTING — the workflow route and engine half.
//
//   LEAK-1 / ROUTE-5  routing runs on EVERY entry into a routed status
//                     (PENDING_ASSIGNMENT, PENDING_IFC + the originating
//                     engineer, a revision nobody drafts), and a transition
//                     that tells nobody is visible (audit
//                     `recipientsResolved`, and a log line when the
//                     active-members filter empties the audience).
//   ROUTE-1 / SM-6    a revision with no drafter returns to the assignment
//                     queue (never a REVISION_REQ nobody's queue shows); a
//                     drafterless REVISION_REQ / DRAFTING offers `assign`.
//   ROUTE-6           watchers are told on every transition, and the stale
//                     queue alerts are retired even when nobody is told.
//   LEAK-9 / GAP-107  close / cancel record a typed outcome.
//   REGRESSION FIRST  every legitimate flow still lands as before.
//
// Route tests drive the real handler against a Proxy-chain supabaseAdmin (the
// sweepRoundD3 / sweepRoundE_A pattern).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { WorkflowEngine, type WorkflowContext } from "@/lib/workflow";
import { __resetCapabilityPolicyCache, type CapabilityPolicy } from "@/lib/capabilityPolicy";
import { computeTransition } from "@/lib/ticketTransitions";
import { isActionRequired } from "@/lib/ticketAttention";
import { summarizeOutcomes, defaultOutcome, outcomesFor, CANCEL_OUTCOMES, TICKET_OUTCOMES } from "@/lib/ticketOutcome";
import type { Ticket, Role, TicketAttachment, TicketStatus } from "@/types/schema";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const NOW = "2026-10-13T12:00:00.000Z";
const ticket = (over: Partial<Ticket> = {}): Ticket => ({
  id: "t1", orgId: "o1", ticketId: "REQ-1", title: "Pump iso", unit: "U-100", requestType: "ISO",
  status: "DRAFTING", requesterId: "req-1", requesterRole: "Requester", assignedDrafterId: "d-1", assignedEngineerId: null,
  attachments: [], comments: [], history: [], unreadBy: [], watchers: [], revisionCount: 0, createdAt: NOW,
  ...over,
} as unknown as Ticket);
const acts = (t: Ticket, role: string, uid?: string, policy?: CapabilityPolicy, ctx?: WorkflowContext) =>
  WorkflowEngine.getActions(t, role as Role, uid, policy, { userRoles: [role] as Role[], ...ctx });
const names = (t: Ticket, role: string, uid?: string) => acts(t, role, uid).map((a) => a.action);
const admin = { uid: "a-1", email: "a@x.io", role: "Admin" };
const eng = { uid: "e-1", email: "e@x.io", role: "Engineer-2" };
const file: TicketAttachment = { id: "f-1", name: "final.pdf", url: "orgs/o1/tickets/REQ-1/final.pdf", type: "Final", status: "submitted" } as TicketAttachment;

// ── the route harness ────────────────────────────────────────────────────────
const state = vi.hoisted(() => ({
  user: null as null | { id: string; email?: string },
  rows: {} as Record<string, Array<Record<string, unknown>>>,
  calls: [] as Array<{ table: string; method: string; args: unknown[] }>,
  /** Answer the next tickets UPDATE whose payload carries this key with this error. */
  failUpdateWith: null as null | { key: string; error: { code: string; message: string } },
}));
function chain(table: string) {
  const filters: Array<[string, unknown]> = [];
  let head = false;
  let payload: unknown = undefined;
  let failing: null | { code: string; message: string } = null;
  const rows = () => (state.rows[table] ?? []).filter((r) => filters.every(([k, v]) => r[k] === v)).map((r) => ({ ...r }));
  const c: Record<string, unknown> = {};
  const h: ProxyHandler<Record<string, unknown>> = {
    get(_t, prop: string) {
      if (prop === "then") return (resolve: (v: unknown) => void) => {
        if (failing) return resolve({ data: null, error: failing });
        if (head) return resolve({ data: null, error: null, count: rows().length });
        if (payload !== undefined && (state.rows[table] ?? []).length === 0 && filters.length === 0) return resolve({ data: [], error: null });
        return resolve({ data: rows(), error: null, count: rows().length });
      };
      return (...args: unknown[]) => {
        state.calls.push({ table, method: prop, args });
        if (prop === "select" && (args[1] as { head?: boolean } | undefined)?.head) head = true;
        if (prop === "insert" || prop === "update" || prop === "upsert") payload = args[0];
        if (prop === "update" && table === "tickets" && state.failUpdateWith && state.failUpdateWith.key in (args[0] as Record<string, unknown>)) {
          failing = state.failUpdateWith.error;
          state.failUpdateWith = null;
        }
        if (prop === "eq") filters.push([String(args[0]), args[1]]);
        if (prop === "maybeSingle" || prop === "single") {
          if (failing) return Promise.resolve({ data: null, error: failing });
          return Promise.resolve({ data: rows()[0] ?? null, error: null });
        }
        return new Proxy(c, h);
      };
    },
  };
  return new Proxy(c, h);
}
vi.mock("@/lib/supabaseAdmin", () => ({
  supabaseAdmin: {
    auth: {
      getUser: vi.fn(async () => state.user ? { data: { user: state.user }, error: null } : { data: { user: null }, error: { message: "bad" } }),
      admin: { getUserById: vi.fn(async () => ({ data: { user: null }, error: { message: "n/a" } })) },
    },
    from: (t: string) => chain(t),
    rpc: vi.fn(async () => ({ error: { code: "PGRST202", message: "Could not find the function" } })),
  },
}));
vi.mock("@/lib/supabase", () => ({ supabase: { from: (t: string) => chain(t) } }));
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), after: vi.fn() }));
vi.mock("@/lib/r2", () => ({ r2: { send: vi.fn(async () => ({ ContentLength: 2048, ETag: '"etag-1"' })) }, R2_BUCKET: "test-bucket" }));
import { POST as workflowAction } from "@/app/api/tickets/workflow-action/route";

const req = (body: unknown) => new NextRequest("http://x/api/tickets/workflow-action", {
  method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" }, body: JSON.stringify(body),
});
const post = (body: unknown) => workflowAction(req(body));
const member = (uid: string, role: string, roles = [role]) => ({ org_id: "o1", uid, role, roles, email: `${uid}@x.io`, display_name: uid, status: "active" });
const LM = "2026-10-13T00:00:00.000Z";
const ticketRow = (over: Record<string, unknown> = {}) => ({
  id: "t1", org_id: "o1", ticket_id: "REQ-1", title: "x", status: "DRAFTING", request_type: "ISO", unit: "U-100",
  requester_id: "req-1", requester_role: "Requester", assigned_drafter_id: "d-1", assigned_engineer_id: null,
  attachments: [], comments: [], history: [], watchers: [], unread_by: [], revision_count: 0, last_modified: LM, ...over,
});
const updateOf = (table: string) => state.calls.filter((c) => c.table === table && c.method === "update").map((c) => c.args[0] as Record<string, unknown>);
const insertsOf = (table: string) => state.calls.filter((c) => c.table === table && c.method === "insert").flatMap((c) => (Array.isArray(c.args[0]) ? c.args[0] : [c.args[0]]) as Array<Record<string, unknown>>);
const auditOf = (action: string) => insertsOf("audit_logs").find((r) => r.action === action) as { details: Record<string, unknown> } | undefined;
const ORG = [member("req-1", "Requester"), member("d-1", "Drafter"), member("d-2", "Drafter"), member("e-1", "Engineer-2"),
  member("a-1", "Admin"), member("sup-1", "DraftingSupervisor")];

beforeEach(() => {
  __resetCapabilityPolicyCache();
  state.user = null; state.rows = {}; state.calls = []; state.failUpdateWith = null;
  delete process.env.CRON_SECRET;
});

// ═════════════════════════════════════════════════════════════════════════════
describe("ROUTE-1 / SM-6 — a revision with no drafter returns to the assignment queue", () => {
  it("'Return with Questions' from engineering review (no drafter yet) → PENDING_ASSIGNMENT; a scope review is not a deliverable round", () => {
    const t = ticket({ status: "PENDING_ENG_TEAM", assignedDrafterId: null, assignedEngineerId: "e-1", revisionCount: 0 });
    const r = computeTransition(t, { actionType: "reject", actionLabel: "Return with Questions", comment: "which line?", variant: "destructive", actor: eng, now: NOW });
    expect(r.newStatus).toBe("PENDING_ASSIGNMENT");
    expect(r.updates.revision_count).toBeUndefined();
    expect(r.historyEntry.revisionRound).toBeUndefined();
    expect(r.recipients).toEqual(["req-1"]); // the requester is told; the route adds the queue (below)
  });
  it("every revision of a ticket whose drafter is gone goes to the queue too — and still opens a new cycle", () => {
    for (const [status, actionType] of [["FINAL_DRAFT", "reject_final"], ["PENDING_REVIEW", "request_revision"], ["PENDING_FINAL_APPROVAL", "engineer_request_revision"]] as const) {
      const r = computeTransition(ticket({ status, assignedDrafterId: null, revisionCount: 1, assignedEngineerId: "e-1" }),
        { actionType, actionLabel: "x", comment: "redo", actor: admin, now: NOW });
      expect(r.newStatus, actionType).toBe("PENDING_ASSIGNMENT");
      expect(r.updates.revision_count, actionType).toBe(2);
    }
  });
  it("REGRESSION: with a drafter, every revision lands in REVISION_REQ exactly as before", () => {
    for (const [status, actionType] of [["FINAL_DRAFT", "reject_final"], ["PENDING_REVIEW", "request_revision"], ["PENDING_FINAL_APPROVAL", "engineer_request_revision"]] as const) {
      const r = computeTransition(ticket({ status, assignedDrafterId: "d-1", revisionCount: 1, draftIteration: 2 }),
        { actionType, actionLabel: "x", comment: "redo", actor: admin, now: NOW });
      expect(r.newStatus, actionType).toBe("REVISION_REQ");
      expect(r.updates).toMatchObject({ revision_count: 2, draft_iteration: 0 });
    }
  });
  it("SM-6 done-when 2/3: a drafterless REVISION_REQ or DRAFTING offers `assign` to the queue owners, as their action item", () => {
    for (const status of ["REVISION_REQ", "DRAFTING"] as const) {
      const t = ticket({ status, assignedDrafterId: null });
      for (const role of ["Admin", "DraftingSupervisor", "Manager"]) {
        const a = acts(t, role, `${role}-x`).find((x) => x.action === "assign");
        expect(a, `${status} ${role}`).toBeDefined();
        expect(a!.optional).toBeUndefined();
        expect(isActionRequired(t, { uid: `${role}-x`, roles: [role as Role] }), `${status} ${role}`).toBe(true);
      }
      expect(names(t, "Requester", "req-1")).not.toContain("assign");
      // ROUTE-1 done-when 1: the drafting pool keeps its claim on it too
      expect(isActionRequired(t, { uid: "d-9", roles: ["Drafter"] })).toBe(true);
    }
    // REGRESSION: with a drafter, no assign at those statuses
    expect(names(ticket({ status: "DRAFTING" }), "Admin", "a-1")).not.toContain("assign");
  });
  it("assigning a drafter to a drafterless revision keeps it a revision", () => {
    const r = computeTransition(ticket({ status: "REVISION_REQ", assignedDrafterId: null }),
      { actionType: "assign", actionLabel: "Assign Drafter", assignment: { id: "d-2", name: "d-2" }, actor: admin, now: NOW });
    expect(r.newStatus).toBe("REVISION_REQ");
    expect(r.updates.assigned_drafter_id).toBe("d-2");
    // REGRESSION: from the queue, assignment starts drafting
    expect(computeTransition(ticket({ status: "PENDING_ASSIGNMENT", assignedDrafterId: null }),
      { actionType: "assign", actionLabel: "Assign Drafter", assignment: { id: "d-2", name: "d-2" }, actor: admin, now: NOW }).newStatus).toBe("DRAFTING");
  });
  it("SM-6 done-when 4: every status × (drafter assigned / not) leaves someone a non-force-close action (CANCELED is terminal by DEC-14 / DEC-84)", () => {
    const people: Array<[string, string]> = [["Requester", "req-1"], ["Drafter", "d-1"], ["Drafter", "d-9"], ["Admin", "a-1"],
      ["DraftingSupervisor", "sup-1"], ["Engineer-2", "e-1"]];
    const statuses: TicketStatus[] = ["PENDING_ENG_TEAM", "PENDING_ASSIGNMENT", "DRAFTING", "REVISION_REQ", "PENDING_REVIEW", "PENDING_IFC", "FINAL_DRAFT", "PENDING_FINAL_APPROVAL", "CLOSED"];
    for (const status of statuses) {
      for (const drafter of ["d-1", null]) {
        const t = ticket({ status, assignedDrafterId: drafter, assignedEngineerId: "e-1", attachments: [] });
        const someone = people.some(([role, uid]) => acts(t, role, uid).some((a) => a.label !== "Force Close (Admin)" && !a.disabledReason && a.action !== "attach_file"));
        expect(someone, `${status} drafter=${drafter}`).toBe(true);
      }
    }
  });
  it("route: Return with Questions → PENDING_ASSIGNMENT, the queue told (and in unread_by), the revision count untouched", async () => {
    state.user = { id: "e-1" };
    state.rows.org_members = ORG;
    state.rows.tickets = [ticketRow({ status: "PENDING_ENG_TEAM", assigned_drafter_id: null, assigned_engineer_id: "e-1", engineer_review_requested_at: LM })];
    const res = await post({ ticketId: "t1", actionType: "reject", comment: "which line?" });
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("PENDING_ASSIGNMENT");
    const [upd] = updateOf("tickets");
    expect(upd.status).toBe("PENDING_ASSIGNMENT");
    expect(upd.revision_count).toBeUndefined();
    expect((upd.unread_by as string[]).sort()).toEqual(["req-1", "sup-1"]);
    expect(insertsOf("notifications").map((n) => n.user_id).sort()).toEqual(["req-1", "sup-1"]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe("LEAK-1 / ROUTE-5 — every entry into a routed status tells that status's pool", () => {
  it("route: approve → PENDING_IFC tells the supervisor pool and the originating engineer (not only the drafter)", async () => {
    state.user = { id: "req-1" };
    state.rows.org_members = [...ORG, member("e-2", "Engineer-3")];
    state.rows.tickets = [ticketRow({ status: "PENDING_REVIEW", assigned_engineer_id: "e-2", requester_role: "Manager",
      attachments: [{ id: "dr", name: "d.pdf", url: "orgs/o1/tickets/REQ-1/d.pdf", type: "Draft", status: "submitted" }] })];
    state.rows.org_members = state.rows.org_members.map((m) => (m.uid === "req-1" ? member("req-1", "Manager") : m));
    const res = await post({ ticketId: "t1", actionType: "approve_draft_ifc" });
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("PENDING_IFC");
    const [upd] = updateOf("tickets");
    expect((upd.unread_by as string[]).sort()).toEqual(["d-1", "e-2", "sup-1"]);
    expect(insertsOf("notifications").map((n) => n.user_id).sort()).toEqual(["d-1", "e-2", "sup-1"]);
    expect(insertsOf("email_notifications").map((e) => e.to_user_id).sort()).toEqual(["d-1", "e-2", "sup-1"]);
    expect(auditOf("TICKET_APPROVE_DRAFT_IFC")!.details.recipientsResolved).toBe(3);
    expect(auditOf("TICKET_APPROVE_DRAFT_IFC")!.details.notified).toBeUndefined();
  });
  it("route: a status change that stays inside a routed status, or never enters one, does not re-notify the pool", async () => {
    state.user = { id: "d-1" };
    state.rows.org_members = ORG;
    state.rows.tickets = [ticketRow({ status: "PENDING_IFC" })];
    expect((await post({ ticketId: "t1", actionType: "save_progress" })).status).toBe(200);
    expect(insertsOf("notifications").map((n) => n.user_id)).toEqual(["req-1"]);
  });
  it("source: the route asks the routing policy for the NEW status, with the drafter and engineer the ticket will have", () => {
    const r = src("app/api/tickets/workflow-action/route.ts");
    expect(r).toContain("if (newStatus !== ticket.status && isRoutedStatus(newStatus, { assignedDrafterId: drafterAfter })) {");
    expect(r).not.toContain('resolveTicketRecipients(ticket.orgId, "PENDING_ASSIGNMENT"');
  });
  it("LEAK-1 done-when 2: every waiting status reaches its waiting party — the transition's named person, or the routed pool", async () => {
    // (status the transition enters, action, the party that must be told)
    const cases: Array<[string, Record<string, unknown>, Record<string, unknown>, string, string]> = [
      ["PENDING_ASSIGNMENT", { status: "PENDING_ENG_TEAM", assigned_drafter_id: null, assigned_engineer_id: "e-1" }, { actionType: "approve_team" }, "e-1", "sup-1"],
      ["PENDING_ENG_TEAM", { status: "PENDING_ASSIGNMENT", assigned_drafter_id: null }, { actionType: "request_eng_review", comment: "scope?", engineer: { id: "e-1", name: "e", email: "e@x.io" } }, "sup-1", "e-1"],
      ["DRAFTING", { status: "PENDING_ASSIGNMENT", assigned_drafter_id: null }, { actionType: "assign", assignment: { id: "d-2", name: "x" } }, "sup-1", "d-2"],
      ["PENDING_REVIEW", { status: "DRAFTING", attachments: [{ id: "dr", name: "d.pdf", url: "orgs/o1/tickets/REQ-1/d.pdf", type: "Draft", status: "staged" }] }, { actionType: "submit_draft" }, "d-1", "req-1"],
      ["REVISION_REQ", { status: "PENDING_REVIEW" }, { actionType: "request_revision", comment: "fix" }, "req-1", "d-1"],
      ["FINAL_DRAFT", { status: "PENDING_IFC" }, { actionType: "submit_final", finalAttachment: file }, "d-1", "req-1"],
    ];
    for (const [to, row, body, actor, party] of cases) {
      state.calls = [];
      state.user = { id: actor };
      state.rows.org_members = ORG;
      state.rows.tickets = [ticketRow(row)];
      const res = await post({ ticketId: "t1", ...body });
      expect(res.status, `${to}: ${await res.clone().text()}`).toBe(200);
      expect((await res.json()).status, to).toBe(to);
      expect(insertsOf("notifications").map((n) => n.user_id), to).toContain(party);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe("ROUTE-6 — followers hear every transition; the queue's alerts retire even when nobody is told", () => {
  it("computeTransition: a Drafter picking up their own request still tells the people following it", () => {
    const t = ticket({ status: "PENDING_ASSIGNMENT", requesterId: "d-1", assignedDrafterId: null, watchers: ["sup-1"] });
    const r = computeTransition(t, { actionType: "self_assign", actionLabel: "Pick Up Ticket", actor: { uid: "d-1", email: "d@x.io", role: "Drafter" }, now: NOW });
    expect(r.recipients).toEqual(["sup-1"]);
    expect(r.updates.unread_by).toEqual(["sup-1"]);
  });
  it("…and the actor is never told about their own action", () => {
    const t = ticket({ status: "PENDING_ASSIGNMENT", requesterId: "d-1", assignedDrafterId: null, watchers: ["d-1"] });
    const r = computeTransition(t, { actionType: "self_assign", actionLabel: "Pick Up Ticket", actor: { uid: "d-1", email: "d@x.io", role: "Drafter" }, now: NOW });
    expect(r.recipients).toEqual([]);
  });
  it("route: a self-assignment that tells nobody still retires the queue's 'needs a drafter' alerts, and the audit row says nobody was told", async () => {
    state.user = { id: "d-1" };
    state.rows.org_members = [member("d-1", "Drafter"), member("sup-1", "DraftingSupervisor")]; // 2 members: no SoD block
    state.rows.tickets = [ticketRow({ status: "PENDING_ASSIGNMENT", requester_id: "d-1", assigned_drafter_id: null })];
    state.rows.notifications = [{ id: "n1", org_id: "o1", resource_id: "t1", user_id: "sup-1", read_at: null, metadata: { action: "approve_team", status: "PENDING_ASSIGNMENT" } }];
    const res = await post({ ticketId: "t1", actionType: "self_assign" });
    expect(res.status).toBe(200);
    expect(insertsOf("notifications")).toEqual([]);
    const superseded = updateOf("notifications");
    expect(superseded).toHaveLength(1);
    expect((superseded[0].metadata as Record<string, unknown>).superseded_by).toBe("self_assign");
    expect(auditOf("TICKET_SELF_ASSIGN")!.details.recipientsResolved).toBe(0);
  });
  it("LEAK-1 done-when 3: a transition whose only recipients are inactive members tells nobody, and SAYS so (log names how many the active filter removed)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      state.user = { id: "d-1" };
      // the requester has been suspended
      state.rows.org_members = ORG.map((m) => (m.uid === "req-1" ? { ...m, status: "suspended" } : m));
      state.rows.tickets = [ticketRow({ status: "DRAFTING", attachments: [{ id: "dr", name: "d.pdf", url: "orgs/o1/tickets/REQ-1/d.pdf", type: "Draft", status: "staged" }] })];
      const res = await post({ ticketId: "t1", actionType: "submit_draft" });
      expect(res.status, await res.clone().text()).toBe(200);
      expect((await res.json()).status).toBe("PENDING_REVIEW");
      expect(insertsOf("notifications")).toEqual([]);
      // the trail says how many it RESOLVED to (before the filter), never "notified"
      expect(auditOf("TICKET_SUBMIT_DRAFT")!.details).toMatchObject({ recipientsResolved: 1 });
      expect(warn.mock.calls.map((c) => String(c[0])).join("\n")).toMatch(/submit_draft on ticket t1 \(now PENDING_REVIEW\) has nobody to tell — the active-members filter removed all 1 recipient\(s\)/);
    } finally {
      warn.mockRestore();
    }
  });
  // Fix pass 3: the SLA clock's "Overdue" / "Due soon" rows (lib/ticketSla.ts,
  // metadata.action sla_breach / sla_warning) say "this request is late", not
  // "act on state X": a transition that leaves the request open leaves it as
  // late as it was, so only an exit (CLOSED / CANCELED) retires them.
  const slaRows = () => [
    { id: "n-wf", org_id: "o1", resource_id: "t1", user_id: "sup-1", read_at: null, metadata: { action: "assign", status: "DRAFTING" } },
    { id: "n-breach", org_id: "o1", resource_id: "t1", user_id: "sup-1", read_at: null, metadata: { action: "sla_breach", sla: "breach", status: "DRAFTING" } },
    { id: "n-warn", org_id: "o1", resource_id: "t1", user_id: "req-1", read_at: null, metadata: { action: "sla_warning", sla: "warn", status: "DRAFTING" } },
  ];
  const supersededActions = () => updateOf("notifications").map((u) => (u.metadata as Record<string, unknown>).action).sort();
  it("an open-to-open transition (save_progress, reassign_drafter) on an overdue request retires the workflow alerts but KEEPS the SLA 'Overdue' / 'Due soon' rows", async () => {
    for (const [actor, body] of [["d-1", { actionType: "save_progress" }], ["a-1", { actionType: "reassign_drafter", comment: "leave", assignment: { id: "d-2", name: "x" } }]] as const) {
      state.calls = [];
      state.user = { id: actor };
      state.rows.org_members = ORG;
      state.rows.tickets = [ticketRow({ status: "DRAFTING", sla_breached_at: LM })];
      state.rows.notifications = slaRows();
      const res = await post({ ticketId: "t1", ...body });
      expect(res.status, body.actionType).toBe(200);
      expect(supersededActions(), body.actionType).toEqual(["assign"]);
    }
  });
  it("an exit (close / cancel) retires the SLA rows too — the request is no longer late", async () => {
    for (const [status, actor, body] of [
      ["FINAL_DRAFT", "req-1", { actionType: "close_ticket" }],
      ["DRAFTING", "req-1", { actionType: "cancel_request", comment: "not needed" }],
    ] as const) {
      state.calls = [];
      state.user = { id: actor };
      state.rows.org_members = ORG;
      state.rows.tickets = [ticketRow({ status, sla_breached_at: LM })];
      state.rows.notifications = slaRows();
      const res = await post({ ticketId: "t1", ...body });
      expect(res.status, body.actionType).toBe(200);
      expect(supersededActions(), body.actionType).toEqual(["assign", "sla_breach", "sla_warning"]);
    }
  });
  it("thread activity with nobody to tell does nothing (no supersede — an attachment does not retire workflow alerts)", async () => {
    state.user = { id: "req-1" };
    state.rows.org_members = ORG;
    state.rows.tickets = [ticketRow({ status: "PENDING_ASSIGNMENT", assigned_drafter_id: null })];
    state.rows.notifications = [{ id: "n1", org_id: "o1", resource_id: "t1", user_id: "sup-1", read_at: null, metadata: { action: "approve_team" } }];
    const res = await post({ ticketId: "t1", actionType: "attach_file", attachment: { ...file, id: "f-2", url: "orgs/o1/tickets/REQ-1/ref.pdf", type: "Reference" } });
    expect(res.status).toBe(200);
    expect(updateOf("notifications")).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe("LEAK-9 / GAP-107 — how a request ended is a typed fact", () => {
  it("the vocabulary is the ratified five; a cancel is never 'completed'", () => {
    expect([...TICKET_OUTCOMES]).toEqual(["completed", "withdrawn", "duplicate", "handled_out_of_band", "rejected"]);
    expect(CANCEL_OUTCOMES).not.toContain("completed");
    expect(outcomesFor("cancel_request")).toBe(CANCEL_OUTCOMES);
    expect(outcomesFor("close_ticket")).toBe(TICKET_OUTCOMES);
    expect(outcomesFor("save_progress")).toBeNull();
  });
  it("defaults: an acknowledgement or an answered RFI completed; a cancel that names no category and a force close record nothing (never a guessed leak)", () => {
    expect(defaultOutcome("close_ticket", "FINAL_DRAFT")).toBe("completed");
    expect(defaultOutcome("close_rfi", "DRAFTING")).toBe("completed");
    expect(defaultOutcome("cancel_request", "DRAFTING")).toBeNull();
    expect(computeTransition(ticket({ status: "DRAFTING" }), { actionType: "cancel_request", actionLabel: "Cancel Request", comment: "dup", actor: admin, now: NOW }).updates.outcome).toBeNull();
    expect(defaultOutcome("close_ticket", "DRAFTING")).toBeNull();
  });
  it("computeTransition stamps it on close / cancel, and a reopen clears it", () => {
    expect(computeTransition(ticket({ status: "FINAL_DRAFT" }), { actionType: "close_ticket", actionLabel: "Acknowledge & Close", actor: { uid: "req-1", email: "r@x.io", role: "Requester" }, now: NOW }).updates.outcome).toBe("completed");
    expect(computeTransition(ticket({ status: "DRAFTING" }), { actionType: "close_ticket", actionLabel: "Force Close (Admin)", actor: admin, now: NOW }).updates.outcome).toBeNull();
    expect(computeTransition(ticket({ status: "DRAFTING" }), { actionType: "close_ticket", actionLabel: "Force Close (Admin)", outcome: "handled_out_of_band", actor: admin, now: NOW }).updates.outcome).toBe("handled_out_of_band");
    expect(computeTransition(ticket({ status: "PENDING_ASSIGNMENT" }), { actionType: "cancel_request", actionLabel: "Cancel Request", comment: "dup of REQ-0", outcome: "duplicate", actor: admin, now: NOW }).updates.outcome).toBe("duplicate");
    expect(computeTransition(ticket({ status: "CLOSED" }), { actionType: "reopen_ticket", actionLabel: "Reopen Ticket", comment: "x", actor: admin, now: NOW }).updates.outcome).toBeNull();
    // no other action writes it
    expect("outcome" in computeTransition(ticket(), { actionType: "save_progress", actionLabel: "Save", actor: { uid: "d-1", email: "d@x.io", role: "Drafter" }, now: NOW }).updates).toBe(false);
  });
  it("the engine marks cancel_request as requiring its category", () => {
    const a = acts(ticket({ status: "PENDING_ASSIGNMENT", assignedDrafterId: null }), "Requester", "req-1").find((x) => x.action === "cancel_request")!;
    expect(a.requiresOutcome).toBe(true);
    expect(a.outcomes).toEqual(CANCEL_OUTCOMES);
    expect(a.requiresComment).toBe(true);
  });
  it("route: a cancel with its category records it, in the row and in the audit row", async () => {
    state.user = { id: "req-1" };
    state.rows.org_members = ORG;
    state.rows.tickets = [ticketRow({ status: "PENDING_ASSIGNMENT", assigned_drafter_id: null })];
    const res = await post({ ticketId: "t1", actionType: "cancel_request", comment: "filed twice", outcome: "duplicate" });
    expect(res.status).toBe(200);
    expect(updateOf("tickets")[0]).toMatchObject({ status: "CANCELED", outcome: "duplicate" });
    expect(auditOf("TICKET_CANCEL_REQUEST")!.details).toMatchObject({ outcomeIntended: "duplicate" });
    expect(auditOf("TICKET_CANCEL_REQUEST")!.details.outcome).toBeUndefined();
    expect(auditOf("TICKET_CANCEL_REQUEST")!.details.outcomeDefaulted).toBeUndefined();
    expect(insertsOf("audit_logs").some((r) => String(r.action).endsWith("_OUTCOME_NOT_STORED"))).toBe(false);
  });
  it("REGRESSION: a cancel from today's page (no category) still works — its outcome is NOT recorded (never a guessed 'withdrawn' the leak rate would count), and the audit row says no category was named", async () => {
    state.user = { id: "req-1" };
    state.rows.org_members = ORG;
    state.rows.tickets = [ticketRow({ status: "DRAFTING" })];
    const res = await post({ ticketId: "t1", actionType: "cancel_request", comment: "not needed any more" });
    expect(res.status).toBe(200);
    expect(updateOf("tickets")[0]).toMatchObject({ status: "CANCELED", outcome: null });
    expect(auditOf("TICKET_CANCEL_REQUEST")!.details).toMatchObject({ outcomeIntended: null, outcomeDefaulted: true });
    // …and the leak rate does not count it
    expect(summarizeOutcomes([{ status: "CANCELED", outcome: null, requestType: "ISO" }])).toMatchObject({ leakRate: null, byOutcome: { withdrawn: 0, unrecorded: 1 } });
  });
  it("route: an outcome the action cannot record is refused with nothing written", async () => {
    for (const [status, body] of [
      ["PENDING_ASSIGNMENT", { actionType: "cancel_request", comment: "x", outcome: "completed" }],
      ["PENDING_ASSIGNMENT", { actionType: "cancel_request", comment: "x", outcome: "abandoned" }],
      ["DRAFTING", { actionType: "save_progress", outcome: "withdrawn" }],
    ] as const) {
      state.calls = [];
      state.user = { id: status === "DRAFTING" ? "d-1" : "req-1" };
      state.rows.org_members = ORG;
      state.rows.tickets = [ticketRow({ status, ...(status === "PENDING_ASSIGNMENT" ? { assigned_drafter_id: null } : {}) })];
      const res = await post({ ticketId: "t1", ...body });
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect((await res.json()).code).toBe("outcome_invalid");
      expect(updateOf("tickets")).toEqual([]);
      expect(insertsOf("audit_logs")).toEqual([]);
    }
  });
  it("REGRESSION + before 20261195: the acknowledgement closes even when the column is not there yet (retried without it)", async () => {
    state.user = { id: "req-1" };
    state.rows.org_members = ORG;
    state.rows.tickets = [ticketRow({ status: "FINAL_DRAFT" })];
    state.failUpdateWith = { key: "outcome", error: { code: "PGRST204", message: "Could not find the 'outcome' column of 'tickets' in the schema cache" } };
    const res = await post({ ticketId: "t1", actionType: "close_ticket" });
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("CLOSED");
    const ups = updateOf("tickets");
    expect(ups).toHaveLength(2);
    expect(ups[1].status).toBe("CLOSED");
    expect("outcome" in ups[1]).toBe(false);
    expect(insertsOf("audit_logs").some((r) => String(r.action).endsWith("_NOT_APPLIED"))).toBe(false);
    // DEC-29: the attempt row names the outcome as INTENDED, and a follow-up
    // row says it was not stored, naming the attempt
    const attempt = insertsOf("audit_logs").find((r) => r.action === "TICKET_CLOSE_TICKET")!;
    expect((attempt.details as Record<string, unknown>).outcomeIntended).toBe("completed");
    expect((attempt.details as Record<string, unknown>).outcome).toBeUndefined();
    const notStored = insertsOf("audit_logs").find((r) => r.action === "TICKET_CLOSE_TICKET_OUTCOME_NOT_STORED")!;
    expect(notStored).toBeDefined();
    expect(notStored.details).toMatchObject({ attempt: attempt.id, outcomeIntended: "completed" });
  });
  it("summarizeOutcomes: the leak rate per request type (GAP-107 acceptance 2)", () => {
    const s = summarizeOutcomes([
      { status: "CLOSED", outcome: "completed", requestType: "ISO" },
      { status: "CANCELED", outcome: "withdrawn", requestType: "ISO" },
      { status: "CANCELED", outcome: "handled_out_of_band", requestType: "MOC" },
      { status: "CANCELED", outcome: "duplicate", requestType: "MOC" },
      { status: "CLOSED", outcome: null, requestType: "MOC" },
      { status: "DRAFTING", outcome: null, requestType: "ISO" },
    ]);
    expect(s.ended).toBe(5);
    expect(s.byOutcome).toMatchObject({ completed: 1, withdrawn: 1, handled_out_of_band: 1, duplicate: 1, unrecorded: 1 });
    expect(s.leakRate).toBe(0.5);
    expect(s.byType).toEqual([
      { requestType: "MOC", ended: 3, leaked: 1, leakRate: 0.5, notMeasured: false, uncategorizedCancels: 0 },
      { requestType: "ISO", ended: 2, leaked: 1, leakRate: 0.5, notMeasured: false, uncategorizedCancels: 0 },
    ]);
    expect(summarizeOutcomes([]).leakRate).toBeNull();
  });
  it("/admin/analytics shows it, read-only, from the rows its gated route already returns", () => {
    const p = src("app/(protected)/admin/analytics/page.tsx");
    expect(p).toContain("summarizeOutcomes(tickets.map((t) => ({ status: t.status, outcome: t.outcome ?? null, requestType: t.requestType })))");
    expect(p).toContain("outcome: r.outcome ?? null,");
    // fix pass 3: the block is components/requests/RequestOutcomes.tsx (rendered in dfRoundG_P3_outcomesRender.test.ts)
    expect(p).toContain("<RequestOutcomes summary={outcomes} />");
    const block = src("components/requests/RequestOutcomes.tsx");
    expect(block).toContain('How Requests Ended');
    // it is all time, and says so (the range control belongs to the volume chart), and names the row cap
    expect(block).toContain('(all time — not the Request Volume range)');
    expect(block).toContain('the page loads at most the server&rsquo;s row limit');
    expect(block).toContain('cancels that named no category; none of them is in the leak rate');
    expect(src("app/api/admin/analytics/route.ts")).toContain('asCaller.from("tickets").select("*").eq("org_id", orgId)');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe("REGRESSION FIRST — every legitimate flow still lands where it did", () => {
  const flow: Array<[string, string, Record<string, unknown>, Record<string, unknown>, TicketStatus]> = [
    ["assign", "a-1", { status: "PENDING_ASSIGNMENT", assigned_drafter_id: null }, { assignment: { id: "d-2", name: "x" } }, "DRAFTING"],
    ["self_assign", "d-2", { status: "PENDING_ASSIGNMENT", assigned_drafter_id: null }, {}, "DRAFTING"],
    ["request_eng_review", "sup-1", { status: "PENDING_ASSIGNMENT", assigned_drafter_id: null }, { comment: "scope", engineer: { id: "e-1", name: "e", email: "e@x.io" } }, "PENDING_ENG_TEAM"],
    ["approve_team", "e-1", { status: "PENDING_ENG_TEAM", assigned_drafter_id: null, assigned_engineer_id: "e-1" }, {}, "PENDING_ASSIGNMENT"],
    ["save_progress", "d-1", { status: "DRAFTING" }, {}, "DRAFTING"],
    ["submit_draft", "d-1", { status: "DRAFTING", attachments: [{ id: "dr", name: "d.pdf", url: "orgs/o1/tickets/REQ-1/d.pdf", type: "Draft", status: "staged" }] }, {}, "PENDING_REVIEW"],
    ["request_revision", "req-1", { status: "PENDING_REVIEW" }, { comment: "fix" }, "REVISION_REQ"],
    ["request_final_engineer_approval", "req-1", { status: "PENDING_REVIEW" }, { comment: "check", engineer: { id: "e-1", name: "e", email: "e@x.io" } }, "PENDING_FINAL_APPROVAL"],
    ["engineer_approve_final", "e-1", { status: "PENDING_FINAL_APPROVAL", assigned_engineer_id: "e-1" }, {}, "PENDING_IFC"],
    ["engineer_return_to_requester", "e-1", { status: "PENDING_FINAL_APPROVAL", assigned_engineer_id: "e-1" }, { comment: "?" }, "PENDING_REVIEW"],
    ["submit_final", "d-1", { status: "PENDING_IFC" }, { finalAttachment: file }, "FINAL_DRAFT"],
    ["close_ticket", "req-1", { status: "FINAL_DRAFT" }, {}, "CLOSED"],
    ["reject_final", "req-1", { status: "FINAL_DRAFT" }, { comment: "wrong" }, "REVISION_REQ"],
    ["cancel_request", "req-1", { status: "PENDING_ASSIGNMENT", assigned_drafter_id: null }, { comment: "no longer needed" }, "CANCELED"],
    ["reassign_drafter", "a-1", { status: "DRAFTING" }, { comment: "leave", assignment: { id: "d-2", name: "x" } }, "DRAFTING"],
    ["reopen_ticket", "a-1", { status: "CLOSED" }, { comment: "again" }, "PENDING_REVIEW"],
  ];
  for (const [actionType, actor, row, body, to] of flow) {
    it(`${actionType} → ${to}`, async () => {
      state.user = { id: actor };
      state.rows.org_members = ORG;
      state.rows.tickets = [ticketRow(row)];
      const res = await post({ ticketId: "t1", actionType, ...body });
      expect(res.status, await res.clone().text()).toBe(200);
      expect((await res.json()).status).toBe(to);
      expect(updateOf("tickets")[0].status ?? row.status).toBe(to);
    });
  }
});
