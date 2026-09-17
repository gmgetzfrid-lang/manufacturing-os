// lib/__tests__/ticketAttention.test.ts
//
// Freezes the single source of truth for "does this ticket need MY action?".
// The sidebar badge, the header bell, the /inbox cockpit, and the Drafting
// Request Portal all share this rule (lib/ticketAttention.ts). WF-24 /
// CHAIN-3: the rule is DERIVED FROM THE WORKFLOW ENGINE — a ticket needs the
// viewer's action exactly when lib/workflow.ts offers them a live,
// non-optional action — so these expectations guard the two surfaces from
// drifting apart again (a DraftingSupervisor's badge once counted tickets the
// page showed as "View Only — No Actions Available").

import { describe, it, expect } from "vitest";
import { isActionRequired, isQueueViewer, isEngineerRole, QUEUE_VIEW_ROLES, type AttentionContext } from "@/lib/ticketAttention";
import { MANAGEMENT_ROLES, holdsManagementRole } from "@/lib/managementRoles";
import { WorkflowEngine, type WorkflowContext } from "@/lib/workflow";
import type { Ticket, Role, TicketStatus } from "@/types/schema";

function mk(over: Partial<Ticket> = {}): Ticket {
  return {
    id: "t-1",
    orgId: "org-1",
    ticketId: "KE-DDRT-26-0001",
    title: "Pump iso",
    unit: "U-100",
    requestType: "ISO",
    status: "PENDING_ASSIGNMENT",
    requesterId: "u-req",
    createdAt: "2026-06-15T12:00:00.000Z",
    ...over,
  } as Ticket;
}

const ctx = (roles: Role[], uid: string | null = "me") => ({ uid, roles });

describe("role predicates", () => {
  it("the management tier is defined once (lib/managementRoles.ts) and does NOT include the queue owner", () => {
    expect(MANAGEMENT_ROLES).toEqual(["Admin", "Manager", "Supervisor"]);
    expect(holdsManagementRole(["Viewer", "Manager"])).toBe(true);
    expect(holdsManagementRole(["DraftingSupervisor"])).toBe(false);
    expect(holdsManagementRole(["Drafter"])).toBe(false);
  });
  it("the queue-VIEW scope is the tier plus the DraftingSupervisor (visibility, not authority)", () => {
    expect(QUEUE_VIEW_ROLES).toEqual(["Admin", "Manager", "Supervisor", "DraftingSupervisor"]);
    expect(isQueueViewer(["DraftingSupervisor"])).toBe(true);
    expect(isQueueViewer(["Admin"])).toBe(true);
    expect(isQueueViewer(["Viewer", "Manager"])).toBe(true);
    expect(isQueueViewer(["Drafter"])).toBe(false);
  });
  it("recognises any engineer level", () => {
    expect(isEngineerRole(["Engineer-1"])).toBe(true);
    expect(isEngineerRole(["Engineer-4"])).toBe(true);
    expect(isEngineerRole(["Drafter"])).toBe(false);
  });
});

describe("WF-24 — the badge and the ticket page agree: attention is the engine's non-optional, non-disabled actions", () => {
  const roles: Role[] = ["Admin", "Manager", "Supervisor", "DraftingSupervisor", "Engineer-2", "Drafter", "Requester", "DocCtrl", "Viewer"];
  const statuses: TicketStatus[] = ["PENDING_ASSIGNMENT", "PENDING_ENG_TEAM", "DRAFTING", "REVISION_REQ", "PENDING_REVIEW", "PENDING_FINAL_APPROVAL", "PENDING_IFC", "FINAL_DRAFT", "CLOSED", "CANCELED"];
  const variants = [
    mk({}),
    mk({ assignedDrafterId: "d-other", assignedEngineerId: "e-other" }),
    mk({ requesterId: "me" }),
    mk({ assignedDrafterId: "me" }),
    mk({ assignedEngineerId: "me" }),
    mk({ requesterId: "" }),
  ];
  // The ticket page evaluates the engine under the org's type-level flags and
  // member count as well as the policy; the badge must take the SAME inputs
  // (a matrix fed only {uid, roles} could not see an engineering-first type
  // disabling pick-up — the badge flagged what the page showed disabled).
  const pageContexts: Array<Omit<WorkflowContext, "userRoles" | "requesterRoles">> = [
    {},
    { engineeringFirstTypes: ["ISO"] },
    { closeWithoutReviewTypes: ["ISO"] },
    { activeMemberCount: 3 },
    { engineeringFirstTypes: ["ISO"], closeWithoutReviewTypes: ["ISO"], activeMemberCount: 3 },
  ];
  it("for every role × status × identity × page context, the badge is true exactly when the page offers a live action", () => {
    for (const role of roles) for (const status of statuses) for (const v of variants) for (const pc of pageContexts) {
      const t = { ...v, status };
      const page = WorkflowEngine.getActions(t, role, "me", undefined, { userRoles: [role], ...pc })
        .some((a) => !a.optional && !a.disabledReason);
      const attention: AttentionContext = { uid: "me", roles: [role], ...pc };
      expect(isActionRequired(t, attention), `${role} @ ${status} ${JSON.stringify(pc)} (${JSON.stringify({ r: v.requesterId, d: v.assignedDrafterId, e: v.assignedEngineerId })})`).toBe(page);
    }
  });
  it("DRAFT-2: an engineering-first type — the Drafter is NOT flagged in the queue (pick-up disabled on the page); the queue owner still is (flag for engineering review is live)", () => {
    const t = mk({ status: "PENDING_ASSIGNMENT", requestType: "ISO" });
    expect(isActionRequired(t, ctx(["Drafter"]))).toBe(true);
    expect(isActionRequired(t, { uid: "me", roles: ["Drafter"], engineeringFirstTypes: ["ISO"] })).toBe(false);
    expect(isActionRequired(t, { uid: "me", roles: ["DraftingSupervisor"], engineeringFirstTypes: ["ISO"] })).toBe(true);
    // a different type is untouched
    expect(isActionRequired(t, { uid: "me", roles: ["Drafter"], engineeringFirstTypes: ["PID"] })).toBe(true);
  });
  it("a DraftingSupervisor is flagged in the queue they own and NOWHERE the page shows them view-only", () => {
    expect(isActionRequired(mk({ status: "PENDING_ASSIGNMENT" }), ctx(["DraftingSupervisor"]))).toBe(true);
    for (const status of ["PENDING_REVIEW", "PENDING_FINAL_APPROVAL", "PENDING_IFC", "PENDING_ENG_TEAM", "FINAL_DRAFT"] as TicketStatus[]) {
      expect(isActionRequired(mk({ status, assignedDrafterId: "d1", assignedEngineerId: "e1" }), ctx(["DraftingSupervisor"])), status).toBe(false);
    }
  });
  it("the org's own policy is honoured: a supervisor-only assignment queue stops flagging drafters", () => {
    const t = mk({ status: "PENDING_ASSIGNMENT" });
    expect(isActionRequired(t, ctx(["Drafter"]))).toBe(true);
    expect(isActionRequired(t, { uid: "me", roles: ["Drafter"], policy: { caps: { "ticket.self_assign": [] } } })).toBe(false);
  });
  it("a separation-of-duties block is not an action item: the drafter-as-requester at 3+ is not flagged to approve", () => {
    const t = mk({ status: "PENDING_REVIEW", requesterId: "me", requesterRole: "Engineer-2", assignedDrafterId: "me" });
    // request_revision stays live for them, so the ticket still needs them.
    expect(isActionRequired(t, { uid: "me", roles: ["Engineer-2"], activeMemberCount: 3 })).toBe(true);
    const fd = mk({ status: "FINAL_DRAFT", requesterId: "me", assignedDrafterId: "me" });
    // close_ticket is disabled; reject_final is live — still their item.
    expect(isActionRequired(fd, { uid: "me", roles: ["Drafter"], activeMemberCount: 3 })).toBe(true);
  });
});

describe("supervisor / admin attention", () => {
  it("management is flagged in the queue; at review only when there is no requester to act (co-review is on the requester's behalf); NOT at PENDING_IFC (the drafter's bench — the page offers nothing there)", () => {
    expect(isActionRequired(mk({ status: "PENDING_ASSIGNMENT" }), ctx(["Admin"]))).toBe(true);
    expect(isActionRequired(mk({ status: "PENDING_REVIEW" }), ctx(["Admin"]))).toBe(false);
    expect(isActionRequired(mk({ status: "PENDING_REVIEW", requesterId: "" }), ctx(["Admin"]))).toBe(true);
    expect(isActionRequired(mk({ status: "PENDING_IFC", assignedDrafterId: "someone-else" }), ctx(["Admin"]))).toBe(false);
    expect(isActionRequired(mk({ status: "PENDING_IFC", assignedDrafterId: "someone-else" }), ctx(["DraftingSupervisor"]))).toBe(false);
  });
  it("final approval: management is on the hook only while no engineer holds it (otherwise their arm is an override)", () => {
    expect(isActionRequired(mk({ status: "PENDING_FINAL_APPROVAL" }), ctx(["Admin"]))).toBe(true);
    expect(isActionRequired(mk({ status: "PENDING_FINAL_APPROVAL", assignedEngineerId: "eng-x" }), ctx(["Admin"]))).toBe(false);
    expect(isActionRequired(mk({ status: "PENDING_ENG_TEAM", assignedEngineerId: "eng-x" }), ctx(["Manager"]))).toBe(false);
  });
  it("does NOT flag DRAFTING — that's the drafter's bench, not the supervisor's", () => {
    expect(isActionRequired(mk({ status: "DRAFTING", assignedDrafterId: "d1" }), ctx(["Admin"]))).toBe(false);
  });
  it("force close, reassignment and cancellation are overrides, never action items", () => {
    const t = mk({ status: "DRAFTING", assignedDrafterId: "d1", assignedEngineerId: "e1" });
    expect(isActionRequired(t, ctx(["Admin"]))).toBe(false);
    expect(isActionRequired(mk({ status: "DRAFTING", assignedDrafterId: "d1", requesterId: "me" }), ctx(["Requester"]))).toBe(false);
  });
});

describe("personal-assignment attention", () => {
  it("flags the assigned drafter on their in-flight states", () => {
    const states: TicketStatus[] = ["DRAFTING", "REVISION_REQ", "PENDING_IFC"];
    for (const status of states) {
      expect(isActionRequired(mk({ status, assignedDrafterId: "me" }), ctx(["Drafter"]))).toBe(true);
    }
  });
  it("does not flag a drafter for someone else's in-flight ticket", () => {
    expect(isActionRequired(mk({ status: "DRAFTING", assignedDrafterId: "other" }), ctx(["Drafter"]))).toBe(false);
  });
  it("offers the unassigned pool to any drafter", () => {
    expect(isActionRequired(mk({ status: "PENDING_ASSIGNMENT" }), ctx(["Drafter"]))).toBe(true);
  });
  it("flags the requester to review then acknowledge", () => {
    expect(isActionRequired(mk({ status: "PENDING_REVIEW", requesterId: "me" }), ctx(["Requester"]))).toBe(true);
    expect(isActionRequired(mk({ status: "FINAL_DRAFT", requesterId: "me" }), ctx(["Requester"]))).toBe(true);
  });
  it("a co-reviewer acting on the requester's behalf is optional: PENDING_REVIEW and FINAL_DRAFT are the requester's items, not every engineer's and manager's", () => {
    for (const status of ["PENDING_REVIEW", "FINAL_DRAFT"] as TicketStatus[]) {
      expect(isActionRequired(mk({ status, requesterId: "other" }), ctx(["Engineer-2"])), status).toBe(false);
      expect(isActionRequired(mk({ status, requesterId: "other" }), ctx(["Manager"])), status).toBe(false);
    }
  });
});

describe("engineer attention", () => {
  it("flags the open team / approval gates; co-review only where no requester can act", () => {
    expect(isActionRequired(mk({ status: "PENDING_ENG_TEAM" }), ctx(["Engineer-2"]))).toBe(true);
    expect(isActionRequired(mk({ status: "PENDING_REVIEW" }), ctx(["Engineer-2"]))).toBe(false);
    expect(isActionRequired(mk({ status: "PENDING_REVIEW", requesterId: "" }), ctx(["Engineer-2"]))).toBe(true);
  });
  it("stops nagging the pool once another engineer claims the ticket", () => {
    expect(isActionRequired(mk({ status: "PENDING_ENG_TEAM", assignedEngineerId: "eng-x" }), ctx(["Engineer-2"]))).toBe(false);
  });
  it("still flags the engineer who owns the claimed ticket", () => {
    expect(isActionRequired(mk({ status: "PENDING_FINAL_APPROVAL", assignedEngineerId: "me" }), ctx(["Engineer-2"]))).toBe(true);
  });
});

describe("guards", () => {
  it("returns false without a uid", () => {
    expect(isActionRequired(mk({ status: "PENDING_IFC" }), ctx(["Admin"], null))).toBe(false);
  });
  it("a plain viewer is never on the hook", () => {
    const states: TicketStatus[] = ["PENDING_ASSIGNMENT", "PENDING_IFC", "PENDING_REVIEW", "DRAFTING"];
    for (const status of states) {
      expect(isActionRequired(mk({ status }), ctx(["Viewer"]))).toBe(false);
    }
  });
  it("terminal tickets are never action items, whoever looks", () => {
    expect(isActionRequired(mk({ status: "CLOSED", requesterId: "me" }), ctx(["Admin"]))).toBe(false);
    expect(isActionRequired(mk({ status: "CANCELED", requesterId: "me" }), ctx(["Admin"]))).toBe(false);
  });
});
