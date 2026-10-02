// Drafting-flow Round G, package DF-P0 (records only — no application code).
//
// DF-P0 re-verifies the drafting-flow findings that earlier rounds already
// landed elsewhere (roles-and-permissions WF-3 / WF-5 / WF-6 / WF-7 / WF-14 /
// WF-17 / DEC-14 / LIFE-1, and the EDGE-11 invariants) and closes the ones
// whose done-when holds on the merged tree. Where a done-when asks for a test
// the earlier round did not write — a computeTransition outcome rather than an
// action name, a route harness rather than a source pin — the test lives here.
// Every assertion pins behaviour that is ALREADY on HEAD and names the finding
// whose done-when it satisfies.
//
// Route tests drive the real handlers against a Proxy-chain supabaseAdmin
// (the sweepRoundD3 / sweepRoundE_A pattern) so refusals and the
// compare-and-set legs are observed, not inferred.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { WorkflowEngine, requiresEngineerApproval, type WorkflowAction, type WorkflowContext } from "@/lib/workflow";
import { __resetCapabilityPolicyCache } from "@/lib/capabilityPolicy";
import { computeTransition, rowToTicket, type TransitionInput } from "@/lib/ticketTransitions";
import { isActionRequired } from "@/lib/ticketAttention";
import { ALL_ROLES, type Role, type Ticket, type TicketAttachment, type TicketStatus } from "@/types/schema";

const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

const NOW = "2026-10-02T12:00:00.000Z";
const LM = "2026-10-02T00:00:00.000Z";
const DRAFT = { id: "a-d", name: "iso_1A.pdf", url: "orgs/o1/tickets/REQ-1/iso_1A.pdf", type: "Draft", status: "submitted" } as TicketAttachment;
const FINAL = { id: "a-f", name: "iso_IFC.pdf", url: "orgs/o1/tickets/REQ-1/iso_IFC.pdf", type: "Final", status: "submitted" } as TicketAttachment;

const mkTicket = (over: Partial<Ticket> = {}): Ticket => ({
  id: "t1", orgId: "o1", ticketId: "REQ-1", title: "Pump iso", unit: "U-100", requestType: "ISO",
  status: "PENDING_REVIEW", requesterId: "req", requesterRole: "Viewer", assignedDrafterId: "drf", assignedEngineerId: null,
  attachments: [DRAFT], comments: [], history: [], unreadBy: [], watchers: [], revisionCount: 0, createdAt: NOW,
  ...over,
} as unknown as Ticket);

const names = (acts: WorkflowAction[]) => acts.map((a) => a.action);

/** Every input an offered action could need, so computeTransition sees the
 *  move the route would apply (engineer picks, assignments, files, a note). */
function inputFor(a: Pick<WorkflowAction, "action" | "label" | "variant">, actor: { uid: string; role: string }): TransitionInput {
  return {
    actionType: a.action,
    actionLabel: a.label,
    variant: a.variant,
    comment: "note for the record",
    engineer: { id: "eng-new", name: "New Engineer", email: "eng-new@x.io" },
    assignment: { id: "drf-new", name: "New Drafter" },
    finalAttachment: FINAL,
    attachment: { ...DRAFT, id: "a-extra", type: "Reference" } as TicketAttachment,
    actor: { uid: actor.uid, email: `${actor.uid}@x.io`, role: actor.role },
    now: NOW,
  };
}

/** Requester roles the engineer gate binds under the shipped defaults. */
const GATED = ALL_ROLES.filter((r) => requiresEngineerApproval(r));

// ── the route harness (sweepRoundE_A's Proxy chain, with a settable rpc) ──────
const state = vi.hoisted(() => ({
  user: null as null | { id: string; email?: string },
  rows: {} as Record<string, Array<Record<string, unknown>>>,
  calls: [] as Array<{ table: string; method: string; args: unknown[] }>,
  onCall: null as null | ((table: string, method: string, args: unknown[]) => void),
  rpcResult: { data: null, error: { code: "PGRST202", message: "Could not find the function" } } as {
    data: unknown;
    error: null | { code?: string; message: string };
  },
}));
function chain(table: string) {
  const filters: Array<[string, unknown]> = [];
  let head = false;
  let payload: unknown = undefined;
  const rows = () => (state.rows[table] ?? []).filter((r) => filters.every(([k, v]) => r[k] === v)).map((r) => ({ ...r }));
  const c: Record<string, unknown> = {};
  const h: ProxyHandler<Record<string, unknown>> = {
    get(_t, prop: string) {
      if (prop === "then") return (resolve: (v: unknown) => void) => {
        if (head) return resolve({ data: null, error: null, count: rows().length });
        if (payload !== undefined && (state.rows[table] ?? []).length === 0 && filters.length === 0) return resolve({ data: [], error: null });
        return resolve({ data: rows(), error: null, count: rows().length });
      };
      return (...args: unknown[]) => {
        state.calls.push({ table, method: prop, args });
        state.onCall?.(table, prop, args);
        if (prop === "select" && (args[1] as { head?: boolean } | undefined)?.head) head = true;
        if (prop === "insert" || prop === "update" || prop === "upsert") payload = args[0];
        if (prop === "eq") filters.push([String(args[0]), args[1]]);
        if (prop === "maybeSingle" || prop === "single") return Promise.resolve({ data: rows()[0] ?? null, error: null });
        return new Proxy(c, h);
      };
    },
  };
  return new Proxy(c, h);
}
vi.mock("@/lib/supabaseAdmin", () => ({
  supabaseAdmin: {
    auth: { getUser: vi.fn(async () => state.user ? { data: { user: state.user }, error: null } : { data: { user: null }, error: { message: "bad" } }) },
    from: (t: string) => chain(t),
    rpc: vi.fn(async (...args: unknown[]) => {
      state.calls.push({ table: "rpc", method: String(args[0]), args });
      return state.rpcResult;
    }),
  },
}));
vi.mock("@/lib/supabase", () => ({ supabase: { from: (t: string) => chain(t) } }));
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ from: (t: string) => chain(t) }) }));
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), after: vi.fn() }));
import { POST as workflowAction } from "@/app/api/tickets/workflow-action/route";
import { POST as commentPost } from "@/app/api/tickets/comment/route";

const req = (path: string, body: unknown) => new NextRequest(`http://x${path}`, {
  method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" }, body: JSON.stringify(body),
});
const post = (body: unknown) => workflowAction(req("/api/tickets/workflow-action", body));
const member = (uid: string, role: string, roles = [role]) => ({ org_id: "o1", uid, role, roles, email: `${uid}@x.io`, display_name: uid, status: "active" });
const ticketRow = (over: Record<string, unknown> = {}) => ({
  id: "t1", org_id: "o1", ticket_id: "REQ-1", title: "x", status: "DRAFTING", request_type: "ISO", unit: "U-100",
  requester_id: "req-1", requester_role: "Requester", assigned_drafter_id: "d-1", assigned_engineer_id: null,
  attachments: [], comments: [], history: [], watchers: [], unread_by: [], revision_count: 0, last_modified: LM, ...over,
});
const updateOf = (table: string) => state.calls.filter((c) => c.table === table && c.method === "update").map((c) => c.args[0] as Record<string, unknown>);
const insertsOf = (table: string) => state.calls.filter((c) => c.table === table && c.method === "insert").flatMap((c) => (Array.isArray(c.args[0]) ? c.args[0] : [c.args[0]]) as Array<Record<string, unknown>>);
const callIndex = (table: string, method: string) => state.calls.findIndex((c) => c.table === table && c.method === method);
const legsAfter = (i: number, table: string) => state.calls.slice(i + 1).filter((c) => c.table === table && c.method === "eq").map((c) => c.args as [string, unknown]);
const casLegs = () => {
  const i = state.calls.findIndex((c) => c.table === "tickets" && c.method === "update");
  return state.calls.slice(i + 1).filter((c) => c.table === "tickets" && c.method === "eq").map((c) => c.args as [string, unknown]);
};

beforeEach(() => {
  __resetCapabilityPolicyCache();
  state.user = null; state.rows = {}; state.calls = []; state.onCall = null;
  state.rpcResult = { data: null, error: { code: "PGRST202", message: "Could not find the function" } };
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://x.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "svc";
  delete process.env.CRON_SECRET;
});

// ═════════════════════════════════════════════════════════════════════════════
describe("AUTHZ-1 / SM-1 — the minor-correction bypass is closed by OUTCOME, not just by action name", () => {
  it("for every requester role the engineer gate binds, nothing the requester is offered at PENDING_REVIEW lands on PENDING_IFC; their one forward path carries the note to PENDING_FINAL_APPROVAL", () => {
    expect(GATED).toContain("Viewer");
    for (const r of GATED) {
      const t = mkTicket({ requesterRole: r });
      const contexts: Array<WorkflowContext | undefined> = [undefined, { requesterRoles: [r] }, { requesterRoles: [r], activeMemberCount: 3 }];
      for (const ctx of contexts) {
        const offered = WorkflowEngine.getActions(t, r, "req", undefined, { userRoles: [r], ...ctx }).filter((a) => !a.disabledReason);
        for (const a of offered) {
          expect(computeTransition(t, inputFor(a, { uid: "req", role: r })).newStatus, `${r} / ${a.action}`).not.toBe("PENDING_IFC");
        }
        expect(names(offered), r).not.toContain("approve_minor_correction");
        const send = offered.find((a) => a.action === "request_final_engineer_approval");
        expect(send, r).toBeDefined();
        const res = computeTransition(t, inputFor(send!, { uid: "req", role: r }));
        expect(res.newStatus).toBe("PENDING_FINAL_APPROVAL");
        expect(res.updates.engineer_review_reason).toBe("note for the record");
        expect(res.newComment?.text).toBe("note for the record");
      }
    }
  });

  it("matrix: on a ticket raised under a gated role, every transition to PENDING_IFC (from PENDING_REVIEW or PENDING_FINAL_APPROVAL) belongs to an actor who satisfies the engineer requirement — a gate-exempt collection or the assigned engineer — and the sign-off stage stamps engineer_approved_at", () => {
    let exemptReached = 0;
    for (const r of GATED) {
      for (const status of ["PENDING_REVIEW", "PENDING_FINAL_APPROVAL"] as const) {
        const t = mkTicket({ status, requesterRole: r, assignedEngineerId: status === "PENDING_FINAL_APPROVAL" ? "eng" : null });
        for (const actorRole of ALL_ROLES) {
          for (const uid of ["req", "drf", "eng", "stranger"]) {
            for (const collection of [[actorRole], [actorRole, "Engineer-2"]] as Role[][]) {
              const acts = WorkflowEngine.getActions(t, actorRole, uid, undefined, { userRoles: collection, requesterRoles: [r] })
                .filter((a) => !a.disabledReason);
              for (const a of acts) {
                const res = computeTransition(t, inputFor(a, { uid, role: actorRole }));
                if (res.newStatus !== "PENDING_IFC") continue;
                const exempt = !requiresEngineerApproval(actorRole, collection);
                const assignedEngineer = status === "PENDING_FINAL_APPROVAL" && uid === "eng";
                expect(exempt || assignedEngineer, `${r} ticket @${status}: ${collection.join("+")} as ${uid} → ${a.action}`).toBe(true);
                if (exempt) exemptReached++;
                if (status === "PENDING_FINAL_APPROVAL") expect(res.updates.engineer_approved_at, `${a.action} at sign-off`).toBe(NOW);
              }
            }
          }
        }
      }
    }
    // not vacuous: qualified actors do reach the issue state
    expect(exemptReached).toBeGreaterThan(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe("AUTHZ-3 — a forged requester_role snapshot does not waive the engineer gate", () => {
  it("engine: the snapshot alone would waive it; with the requester's CURRENT collection (DEC-16, what the route supplies) the action set routes to an engineer", () => {
    const t = mkTicket({ status: "PENDING_REVIEW", requesterRole: "Engineer-4" as Role });
    expect(names(WorkflowEngine.getActions(t, "Requester", "req", undefined, { userRoles: ["Requester"] }))).toContain("approve_draft_ifc");
    const live = names(WorkflowEngine.getActions(t, "Requester", "req", undefined, { userRoles: ["Requester"], requesterRoles: ["Requester"] }));
    expect(live).toContain("request_final_engineer_approval");
    expect(live).not.toContain("approve_draft_ifc");
    expect(live).not.toContain("approve_minor_correction");
  });

  it("route: a ticket row stamped requester_role 'Engineer-4' for a member who holds Requester — direct approval and the minor-correction path are 403 with nothing written; the engineer route is accepted", async () => {
    state.user = { id: "req-1" };
    state.rows.org_members = [member("req-1", "Requester"), member("d-1", "Drafter"), member("e-1", "Engineer-2")];
    state.rows.tickets = [ticketRow({ status: "PENDING_REVIEW", requester_role: "Engineer-4", attachments: [DRAFT] })];
    const direct = await post({ ticketId: "t1", actionType: "approve_draft_ifc" });
    expect(direct.status).toBe(403);
    const minor = await post({ ticketId: "t1", actionType: "approve_minor_correction", comment: "fix the tag" });
    expect(minor.status).toBe(403);
    expect(updateOf("tickets")).toHaveLength(0);
    const sent = await post({ ticketId: "t1", actionType: "request_final_engineer_approval", comment: "please check FE-201", engineer: { id: "e-1", name: "Eng", email: "e-1@x.io" } });
    expect(sent.status).toBe(200);
    expect((await sent.json()).status).toBe("PENDING_FINAL_APPROVAL");
    expect(updateOf("tickets")[0]).toMatchObject({ status: "PENDING_FINAL_APPROVAL", assigned_engineer_id: "e-1" });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe("AUTHZ-9 — a secondary Engineer role buys the engineering-review actions", () => {
  it("a DraftingSupervisor whose collection adds Engineer-3 gets approve_team / co-review / final sign-off that the headline alone does not; the route threads org_members.roles", async () => {
    const eng = { userRoles: ["DraftingSupervisor", "Engineer-3"] as Role[] };
    const headline = { userRoles: ["DraftingSupervisor"] as Role[] };
    const team = mkTicket({ status: "PENDING_ENG_TEAM", assignedEngineerId: null });
    expect(names(WorkflowEngine.getActions(team, "DraftingSupervisor", "sup", undefined, headline))).not.toContain("approve_team");
    expect(names(WorkflowEngine.getActions(team, "DraftingSupervisor", "sup", undefined, eng))).toContain("approve_team");
    const review = mkTicket({ status: "PENDING_REVIEW", requesterRole: "Viewer" });
    expect(names(WorkflowEngine.getActions(review, "DraftingSupervisor", "sup", undefined, headline))).not.toContain("approve_draft_ifc");
    expect(names(WorkflowEngine.getActions(review, "DraftingSupervisor", "sup", undefined, eng))).toContain("approve_draft_ifc");
    const final = mkTicket({ status: "PENDING_FINAL_APPROVAL", assignedEngineerId: null });
    expect(names(WorkflowEngine.getActions(final, "DraftingSupervisor", "sup", undefined, headline))).not.toContain("engineer_approve_final");
    expect(names(WorkflowEngine.getActions(final, "DraftingSupervisor", "sup", undefined, eng))).toContain("engineer_approve_final");

    state.user = { id: "sup-1" };
    state.rows.org_members = [member("sup-1", "DraftingSupervisor", ["DraftingSupervisor", "Engineer-3"]), member("req-1", "Requester"), member("d-1", "Drafter")];
    state.rows.tickets = [ticketRow({ status: "PENDING_ENG_TEAM", assigned_engineer_id: null, assigned_drafter_id: null })];
    const res = await post({ ticketId: "t1", actionType: "approve_team" });
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("PENDING_ASSIGNMENT");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
const STATUS_UNION: TicketStatus[] = (() => {
  const s = src("types/schema.ts");
  const at = s.indexOf("export type TicketStatus =");
  return Array.from(s.slice(at, s.indexOf(";", at)).matchAll(/"([A-Z_]+)"/g)).map((m) => m[1] as TicketStatus);
})();
const ticketAt = (status: TicketStatus) => mkTicket({
  status,
  assignedDrafterId: status === "PENDING_ASSIGNMENT" ? null : "drf",
  assignedEngineerId: status === "PENDING_ENG_TEAM" || status === "PENDING_FINAL_APPROVAL" ? "eng" : null,
});
function offeredAt(status: TicketStatus): Array<{ a: WorkflowAction; uid: string; role: Role }> {
  const out: Array<{ a: WorkflowAction; uid: string; role: Role }> = [];
  for (const role of ALL_ROLES) {
    for (const uid of ["req", "drf", "eng", "stranger"]) {
      for (const a of WorkflowEngine.getActions(ticketAt(status), role, uid, undefined, { userRoles: [role] })) {
        if (!a.disabledReason) out.push({ a, uid, role });
      }
    }
  }
  return out;
}

describe("SM-8 / SM-10 — every TicketStatus is reachable; CANCELED is the DEC-14 terminal; the retired stage is gone", () => {
  it("the union is exactly the live statuses (NEW / PENDING_ENG_INITIAL retired, the column default flipped by 20261053)", () => {
    expect(STATUS_UNION.length).toBe(10);
    expect(STATUS_UNION).toContain("CANCELED");
    expect(STATUS_UNION).not.toContain("NEW" as TicketStatus);
    expect(STATUS_UNION).not.toContain("PENDING_ENG_INITIAL" as TicketStatus);
    expect(WorkflowEngine.getInitialStatus()).toBe("PENDING_ASSIGNMENT");
    expect(src("supabase/migrations/20261053_rp_roundE_dead_statuses.sql")).toContain("ALTER TABLE tickets ALTER COLUMN status SET DEFAULT 'PENDING_ASSIGNMENT';");
  });

  it("walking the engine from the initial status reaches every value of TicketStatus", () => {
    const seen = new Set<TicketStatus>([WorkflowEngine.getInitialStatus()]);
    const queue: TicketStatus[] = [WorkflowEngine.getInitialStatus()];
    while (queue.length > 0) {
      const from = queue.shift()!;
      for (const { a, uid, role } of offeredAt(from)) {
        const to = computeTransition(ticketAt(from), inputFor(a, { uid, role })).newStatus;
        if (!seen.has(to)) { seen.add(to); queue.push(to); }
      }
    }
    expect([...seen].sort()).toEqual([...STATUS_UNION].sort());
  });

  it("every status but CANCELED offers someone an action (CLOSED offers reopen); CANCELED offers nobody anything — terminal by DEC-14, a withdrawn request is refiled, not resurrected", () => {
    for (const status of STATUS_UNION) {
      const offered = offeredAt(status);
      if (status === "CANCELED") expect(offered, status).toEqual([]);
      else expect(offered.length, status).toBeGreaterThan(0);
    }
    expect(offeredAt("CLOSED").map((o) => o.a.action)).toContain("reopen_ticket");
    // a cancellation is reachable by the requester identity from the queue and from drafting
    for (const status of ["PENDING_ASSIGNMENT", "DRAFTING"] as const) {
      const byRequester = WorkflowEngine.getActions(ticketAt(status), "Requester", "req", undefined, { userRoles: ["Requester"] });
      expect(names(byRequester), status).toContain("cancel_request");
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe("ROUTE-2 — every (Role × TicketStatus): the attention badge is the engine's live-action set", () => {
  it("under the default policy, for every role in ALL_ROLES, every TicketStatus and every identity, isActionRequired is true exactly when getActions offers a non-optional, non-disabled action; DocCtrl is not flagged at FINAL_DRAFT / PENDING_IFC", () => {
    let flagged = 0;
    for (const role of ALL_ROLES) {
      for (const status of STATUS_UNION) {
        for (const uid of ["req", "drf", "eng", "stranger"]) {
          const t = ticketAt(status);
          const required = isActionRequired(t, { uid, roles: [role] });
          const live = WorkflowEngine.getActions(t, role, uid, undefined, { userRoles: [role] }).filter((a) => !a.optional && !a.disabledReason);
          expect(required, `${role} @${status} as ${uid}`).toBe(live.length > 0);
          if (required) flagged++;
        }
      }
    }
    expect(flagged).toBeGreaterThan(0);
    for (const status of ["FINAL_DRAFT", "PENDING_IFC"] as const) {
      expect(isActionRequired(ticketAt(status), { uid: "stranger", roles: ["DocCtrl"] }), status).toBe(false);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe("SM-12 — the drafter pick is role-checked like the engineer pick", () => {
  it("route: assigning a Viewer as drafter is a 400 with nothing written; a Drafter (headline or additive) is accepted", async () => {
    state.user = { id: "a-1" };
    state.rows.org_members = [member("a-1", "Admin"), member("req-1", "Requester"), member("v-1", "Viewer"), member("v-2", "Viewer", ["Viewer", "Drafter"]), member("d-1", "Drafter")];
    state.rows.tickets = [ticketRow({ status: "PENDING_ASSIGNMENT", assigned_drafter_id: null })];
    const viewer = await post({ ticketId: "t1", actionType: "assign", assignment: { id: "v-1", name: "Vic" } });
    expect(viewer.status).toBe(400);
    expect((await viewer.json()).error).toMatch(/does not hold drafting authority/);
    expect(updateOf("tickets")).toHaveLength(0);
    expect(insertsOf("audit_logs")).toHaveLength(0);
    for (const id of ["v-2", "d-1"]) {
      state.calls = [];
      const ok = await post({ ticketId: "t1", actionType: "assign", assignment: { id, name: id } });
      expect(ok.status, id).toBe(200);
      expect(updateOf("tickets")[0]).toMatchObject({ status: "DRAFTING", assigned_drafter_id: id });
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe("LEAK-8 / SM-13 — submit_final without a deliverable is refused by the route", () => {
  it("route: a direct POST of submit_final with no finalAttachment (absent, null, or URL-less) is a 400 — no write, no audit row, the ticket stays at PENDING_IFC; with the Final file it lands on FINAL_DRAFT", async () => {
    state.user = { id: "d-1" };
    state.rows.org_members = [member("d-1", "Drafter"), member("req-1", "Requester")];
    state.rows.tickets = [ticketRow({ status: "PENDING_IFC", attachments: [DRAFT] })];
    for (const extra of [{}, { finalAttachment: null }, { finalAttachment: { ...FINAL, url: "" } }]) {
      const res = await post({ ticketId: "t1", actionType: "submit_final", ...extra });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/requires the deliverable file/);
    }
    expect(updateOf("tickets")).toHaveLength(0);
    expect(insertsOf("audit_logs")).toHaveLength(0);
    expect(state.rows.tickets[0].status).toBe("PENDING_IFC");
    const ok = await post({ ticketId: "t1", actionType: "submit_final", finalAttachment: FINAL });
    expect(ok.status).toBe(200);
    expect((await ok.json()).status).toBe("FINAL_DRAFT");
    expect((updateOf("tickets")[0].attachments as TicketAttachment[]).map((a) => a.id)).toEqual(["a-d", "a-f"]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe("SM-11 — rowToTicket carries metadata, so the ticket ⇄ intent bridge runs", () => {
  it("rowToTicket round-trips the metadata bag (and absent stays absent)", () => {
    const metadata = { source_document: { id: "doc-1", documentNumber: "P-100", rev: "3" }, moc: { status: "none" }, checkin: { episodeId: "ep-1" } };
    expect(rowToTicket({ id: "t", metadata }).metadata).toEqual(metadata);
    expect(rowToTicket({ id: "t", metadata: null }).metadata).toBeUndefined();
    expect(rowToTicket({ id: "t" }).metadata).toBeUndefined();
  });

  it("route: entering DRAFTING on a ticket with metadata.source_document upserts the drafter's source:'ticket' intent; closing the ticket deletes it", async () => {
    state.user = { id: "a-1" };
    state.rows.org_members = [member("a-1", "Admin"), member("req-1", "Requester"), member("d-1", "Drafter")];
    state.rows.tickets = [ticketRow({ status: "PENDING_ASSIGNMENT", assigned_drafter_id: null, metadata: { source_document: { id: "doc-1", documentNumber: "P-100" } } })];
    expect((await post({ ticketId: "t1", actionType: "assign", assignment: { id: "d-1", name: "Hector" } })).status).toBe(200);
    const up = callIndex("document_intents", "upsert");
    expect(up).toBeGreaterThan(callIndex("tickets", "update"));
    expect(state.calls[up].args[0]).toMatchObject({ document_id: "doc-1", user_id: "d-1", kind: "edit", source: "ticket", ticket_id: "t1" });

    state.calls = []; state.user = { id: "req-1" };
    state.rows.tickets = [ticketRow({ status: "FINAL_DRAFT", attachments: [FINAL], metadata: { source_document: { id: "doc-1", documentNumber: "P-100" } } })];
    const closed = await post({ ticketId: "t1", actionType: "close_ticket" });
    expect(closed.status).toBe(200);
    expect((await closed.json()).status).toBe("CLOSED");
    const del = callIndex("document_intents", "delete");
    expect(del).toBeGreaterThan(callIndex("tickets", "update"));
    expect(legsAfter(del, "document_intents")).toEqual([["document_id", "doc-1"], ["ticket_id", "t1"], ["source", "ticket"]]);
    expect(callIndex("document_intents", "upsert")).toBe(-1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe("EDGE-11 — the load-bearing invariants carry regression tests", () => {
  it("CAS: a save_progress applies on (id, status, last_modified) and stamps a fresh last_modified; the second of two concurrent saves — the first landed between its read and its write — is a 409 with no audit row", async () => {
    state.user = { id: "d-1" };
    state.rows.org_members = [member("d-1", "Drafter"), member("req-1", "Requester")];
    state.rows.tickets = [ticketRow({ status: "DRAFTING" })];
    const first = await post({ ticketId: "t1", actionType: "save_progress" });
    expect(first.status).toBe(200);
    expect(casLegs()).toEqual(expect.arrayContaining([["id", "t1"], ["status", "DRAFTING"], ["last_modified", LM]]));
    const stamped = updateOf("tickets")[0].last_modified;
    expect(typeof stamped).toBe("string");
    expect(stamped).not.toBe(LM);
    expect(insertsOf("audit_logs").map((a) => a.action)).toContain("TICKET_SAVE_PROGRESS");

    state.calls = [];
    state.onCall = (table, method) => { if (table === "tickets" && method === "update") state.rows.tickets[0].last_modified = "2026-10-02T00:00:01.000Z"; };
    const second = await post({ ticketId: "t1", actionType: "save_progress" });
    expect(second.status).toBe(409);
    expect((await second.json()).conflict).toBe(true);
    expect(insertsOf("audit_logs")).toHaveLength(0);
  });

  it("comment RPC fallback is PGRST202-only: an error raised INSIDE post_ticket_comment surfaces as a 500 and nothing is written; a genuinely absent function falls back to the legacy single-statement write", async () => {
    state.user = { id: "req-1" };
    state.rows.org_members = [member("req-1", "Requester"), member("d-1", "Drafter")];
    state.rows.tickets = [ticketRow()];
    state.rpcResult = { data: null, error: { code: "P0001", message: "tickets: comment rejected inside the function" } };
    const raised = await commentPost(req("/api/tickets/comment", { ticketId: "t1", text: "hello" }));
    expect(raised.status).toBe(500);
    expect((await raised.json()).error).toMatch(/rejected inside the function/);
    expect(state.calls.some((c) => c.table === "rpc" && c.method === "post_ticket_comment")).toBe(true);
    expect(updateOf("tickets")).toHaveLength(0);

    state.calls = [];
    state.rpcResult = { data: null, error: { code: "PGRST202", message: "Could not find the function public.post_ticket_comment" } };
    const absent = await commentPost(req("/api/tickets/comment", { ticketId: "t1", text: "hello again" }));
    expect(absent.status).toBe(200);
    const [legacy] = updateOf("tickets");
    expect((legacy.comments as Array<{ text: string }>).map((c) => c.text)).toEqual(["hello again"]);
  });

  it("the other invariants are where EDGE-11 names them (source pins): RPC numbering with a row lock, all-or-nothing archive capture, the archived-stub gate", () => {
    const numbering = src("supabase/migrations/20260724_ticket_numbering.sql");
    expect(numbering).toMatch(/SECURITY DEFINER\s+SET search_path = public/);
    expect(numbering).toContain("ON CONFLICT (org_id, year)");
    expect(numbering).toContain("DO UPDATE SET next_seq = ticket_number_counters.next_seq + 1");
    expect(src("app/api/admin/ticket-shed/route.ts")).toContain("Only commit the ticket to the");
    expect(src("app/api/admin/ticket-shed/commit/route.ts")).toContain('.is("archived_at", null)');
    expect(src("app/api/tickets/workflow-action/route.ts")).toContain("This ticket is archived; restore it from its archive before acting on it.");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe("PERS-8 — my_org_ids() is pinned by a migration, not only in schema.sql", () => {
  it("20261020 ALTERs my_org_ids() to search_path = public; the schema.sql body it pins is SECURITY DEFINER", () => {
    const pin = src("supabase/migrations/20261020_pin_search_path.sql");
    expect(pin).toContain("'my_org_ids()',");
    expect(pin).toMatch(/ALTER FUNCTION %s SET search_path = public/);
    const schema = src("supabase/schema.sql");
    const at = schema.indexOf("CREATE OR REPLACE FUNCTION my_org_ids()");
    expect(at).toBeGreaterThan(-1);
    expect(schema.slice(at, at + 200)).toContain("SECURITY DEFINER");
  });
});
