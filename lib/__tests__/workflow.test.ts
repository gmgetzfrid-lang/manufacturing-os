// lib/__tests__/workflow.test.ts
//
// Freezes the drafting-workflow state machine. This is the contract the
// server-side enforcement work must preserve — any change to who can do what,
// at which status, must show up here as an intentional diff.

import { describe, it, expect } from "vitest";
import { WorkflowEngine, isEngineerRole, isManagementRole, requiresEngineerApproval } from "@/lib/workflow";
import type { Ticket, Role } from "@/types/schema";

function mk(over: Partial<Ticket> = {}): Ticket {
  return {
    id: "t-1",
    orgId: "org-1",
    ticketId: "KE-DDRT-26-0001",
    title: "Test ticket",
    unit: "U-100",
    requestType: "ISO",
    status: "PENDING_ASSIGNMENT",
    requesterId: "user-requester",
    requesterRole: "Viewer",
    attachments: [],
    comments: [],
    history: [],
    unreadBy: [],
    createdAt: new Date().toISOString(),
    ...over,
  } as Ticket;
}

const actionsOf = (t: Ticket, role: Role, uid?: string) =>
  WorkflowEngine.getActions(t, role, uid).map((a) => a.action).sort();

describe("role helpers", () => {
  it("classifies engineer levels", () => {
    expect(isEngineerRole("Engineer-1")).toBe(true);
    expect(isEngineerRole("Engineer-4")).toBe(true);
    expect(isEngineerRole("Drafter")).toBe(false);
    expect(isEngineerRole(undefined)).toBe(false);
  });

  it("classifies management", () => {
    expect(isManagementRole("Admin")).toBe(true);
    expect(isManagementRole("Manager")).toBe(true);
    expect(isManagementRole("Supervisor")).toBe(true);
    expect(isManagementRole("DraftingSupervisor")).toBe(false); // handled explicitly, not via management
    expect(isManagementRole("Engineer-1")).toBe(false);
  });

  it("engineer approval requirement by requester role", () => {
    expect(requiresEngineerApproval("Viewer")).toBe(true);
    expect(requiresEngineerApproval("Requester")).toBe(true);
    expect(requiresEngineerApproval("Engineer-2")).toBe(false);
    expect(requiresEngineerApproval("Admin")).toBe(false);
    expect(requiresEngineerApproval("DocCtrl")).toBe(false);
    expect(requiresEngineerApproval(undefined)).toBe(true);
  });
});

describe("getInitialStatus — assignment-first routing", () => {
  it("every request type and requester role starts at PENDING_ASSIGNMENT", () => {
    const types = ["ISO", "RFI", "MOC", "INSPECTION", "ASBUILT"] as const;
    const roles: Role[] = ["Viewer", "Requester", "Engineer-1", "Admin", "Drafter"];
    for (const ty of types) {
      for (const r of roles) {
        expect(WorkflowEngine.getInitialStatus(ty as never, r)).toBe("PENDING_ASSIGNMENT");
      }
    }
  });
});

describe("PENDING_ASSIGNMENT — the entry queue", () => {
  const t = mk({ status: "PENDING_ASSIGNMENT" });

  it("Admin can assign, flag for engineering review, or force close", () => {
    expect(actionsOf(t, "Admin")).toEqual(["assign", "close_ticket", "request_eng_review"].sort());
  });

  it("DraftingSupervisor can assign and flag (the queue owner)", () => {
    expect(actionsOf(t, "DraftingSupervisor")).toEqual(["assign", "request_eng_review"].sort());
  });

  it("the flag action requires picking a specific engineer + a comment", () => {
    const flag = WorkflowEngine.getActions(t, "Admin").find((a) => a.action === "request_eng_review");
    expect(flag?.requiresEngineerPick).toBe(true);
    expect(flag?.requiresComment).toBe(true);
  });

  it("Drafter can self-assign (pick up from the pool)", () => {
    expect(actionsOf(t, "Drafter")).toEqual(["self_assign"]);
  });

  it("Viewer gets no workflow actions", () => {
    expect(actionsOf(t, "Viewer")).toEqual([]);
  });

  it("Engineers get no assignment actions (assignment is not their queue)", () => {
    expect(actionsOf(t, "Engineer-2")).toEqual([]);
  });
});

describe("PENDING_ENG_TEAM — scoped engineering review", () => {
  it("the assigned engineer can complete or return", () => {
    const t = mk({ status: "PENDING_ENG_TEAM", assignedEngineerId: "eng-1" });
    expect(actionsOf(t, "Engineer-1", "eng-1")).toEqual(["approve_team", "reject"].sort());
  });

  it("a DIFFERENT engineer cannot act when one is assigned", () => {
    const t = mk({ status: "PENDING_ENG_TEAM", assignedEngineerId: "eng-1" });
    expect(actionsOf(t, "Engineer-3", "someone-else")).toEqual([]);
  });

  it("management can still override", () => {
    const t = mk({ status: "PENDING_ENG_TEAM", assignedEngineerId: "eng-1" });
    expect(actionsOf(t, "Admin", "admin-1")).toContain("approve_team");
  });

  it("any engineer can act when nobody is assigned", () => {
    const t = mk({ status: "PENDING_ENG_TEAM" });
    expect(actionsOf(t, "Engineer-3", "someone-else")).toContain("approve_team");
  });
});

describe("DRAFTING — the assigned drafter's stage", () => {
  it("assigned drafter can stage files; submit only once a Draft file exists", () => {
    const noDraft = mk({ status: "DRAFTING", assignedDrafterId: "d-1" });
    expect(actionsOf(noDraft, "Drafter", "d-1")).toEqual(["save_progress"]);

    const withDraft = mk({
      status: "DRAFTING",
      assignedDrafterId: "d-1",
      attachments: [{ id: "a1", name: "x.pdf", url: "u", type: "Draft", status: "staged" } as never],
    });
    expect(actionsOf(withDraft, "Drafter", "d-1")).toEqual(["save_progress", "submit_draft"].sort());
  });

  it("RFIs can be answered & closed by the drafter", () => {
    const rfi = mk({ status: "DRAFTING", requestType: "RFI", assignedDrafterId: "d-1" });
    expect(actionsOf(rfi, "Drafter", "d-1")).toContain("close_rfi");
  });
});

describe("PENDING_REVIEW — the engineer-approval fork", () => {
  it("a Viewer requester must route to an engineer (cannot self-approve)", () => {
    const t = mk({ status: "PENDING_REVIEW", requesterId: "u-1", requesterRole: "Viewer" });
    const acts = actionsOf(t, "Viewer", "u-1");
    expect(acts).toContain("request_final_engineer_approval");
    expect(acts).not.toContain("approve_draft_ifc");
  });

  it("an Engineer requester approves straight to IFC", () => {
    const t = mk({ status: "PENDING_REVIEW", requesterId: "u-1", requesterRole: "Engineer-2" });
    const acts = actionsOf(t, "Engineer-2", "u-1");
    expect(acts).toContain("approve_draft_ifc");
    expect(acts).not.toContain("request_final_engineer_approval");
  });

  it("a non-requester engineer can co-review and approve", () => {
    const t = mk({ status: "PENDING_REVIEW", requesterId: "u-1", requesterRole: "Viewer" });
    expect(actionsOf(t, "Engineer-1", "eng-9")).toContain("approve_draft_ifc");
  });

  it("minor-correction fast approve exists ONLY for actors who could approve directly (WF-3)", () => {
    const t = mk({ status: "PENDING_REVIEW", requesterId: "u-1", requesterRole: "Viewer" });
    // WF-3 closure: a Viewer-tier requester cannot self-approve, so their
    // minor-correction fast path must be gone too — it was a one-click bypass
    // of the entire engineer sign-off gate. Their only forward path routes
    // through an engineer.
    expect(actionsOf(t, "Viewer", "u-1")).not.toContain("approve_minor_correction");
    expect(actionsOf(t, "Viewer", "u-1")).toContain("request_final_engineer_approval");
    // Direct approvers keep the fast path, and it still requires the note.
    expect(actionsOf(t, "Engineer-1", "eng-9")).toContain("approve_minor_correction");
    expect(actionsOf(t, "Admin", "a-1")).toContain("approve_minor_correction");

    const act = WorkflowEngine.getActions(t, "Engineer-1", "eng-9").find((a) => a.action === "approve_minor_correction");
    expect(act?.requiresComment).toBe(true);

    // An ENGINEER requester keeps the fast path (they could approve directly).
    const engReq = mk({ status: "PENDING_REVIEW", requesterId: "u-1", requesterRole: "Engineer-2" });
    expect(actionsOf(engReq, "Engineer-2", "u-1")).toContain("approve_minor_correction");
  });
});

describe("PENDING_FINAL_APPROVAL — engineer sign-off", () => {
  const t = mk({ status: "PENDING_FINAL_APPROVAL", assignedEngineerId: "eng-1" });

  it("the assigned engineer can approve, minor-correct, send back to drafter, or return to requester", () => {
    expect(actionsOf(t, "Engineer-1", "eng-1")).toEqual(
      ["engineer_approve_final", "approve_minor_correction", "engineer_request_revision", "engineer_return_to_requester"].sort(),
    );
  });

  it("a different engineer cannot act", () => {
    expect(actionsOf(t, "Engineer-2", "other")).toEqual([]);
  });

  it("Admin additionally gets the reassign-engineer override", () => {
    expect(actionsOf(t, "Admin", "admin-1")).toContain("reassign_engineer");
  });
});

describe("closure & resurrection", () => {
  it("requester acknowledges & closes at FINAL_DRAFT", () => {
    const t = mk({ status: "FINAL_DRAFT", requesterId: "u-1" });
    expect(actionsOf(t, "Viewer", "u-1")).toEqual(["close_ticket", "reject_final"].sort());
  });

  it("CLOSED offers reopen to management and the requester — and nothing else", () => {
    const t = mk({ status: "CLOSED", requesterId: "u-1" });
    expect(actionsOf(t, "Admin", "a-1")).toEqual(["reopen_ticket"]);
    expect(actionsOf(t, "Viewer", "u-1")).toEqual(["reopen_ticket"]);
    expect(actionsOf(t, "Drafter", "d-1")).toEqual([]);
  });

  it("management force-close exists on open tickets, never duplicated", () => {
    const t = mk({ status: "DRAFTING", assignedDrafterId: "d-1" });
    const acts = WorkflowEngine.getActions(t, "Admin", "a-1").filter((a) => a.action === "close_ticket");
    expect(acts).toHaveLength(1);
  });
});

// ─── Phase 4: the workflow-context findings ──────────────────────────────

const ctxActionsOf = (
  t: Ticket,
  role: Role,
  uid: string | undefined,
  ctx: Parameters<typeof WorkflowEngine.getActions>[4],
) => WorkflowEngine.getActions(t, role, uid, undefined, ctx);

describe("WF-7 — additive role collection carries full authority", () => {
  it("a Viewer-headline member whose collection includes Drafter can self-assign", () => {
    const t = mk({ status: "PENDING_ASSIGNMENT" });
    // Headline alone: no actions.
    expect(actionsOf(t, "Viewer", "x-1")).toEqual([]);
    // Same person, additive Drafter role: identical to a Drafter headline.
    const acts = ctxActionsOf(t, "Viewer", "x-1", { userRoles: ["Viewer", "Drafter"] }).map((a) => a.action);
    expect(acts).toContain("self_assign");
  });

  it("an additive Engineer role satisfies the engineer-in-the-loop gate (isEng is collection-aware)", () => {
    // Ticket filed under a Viewer-tier requester role, so the engineer gate is
    // demanded — but the person reviewing now holds an additive Engineer role,
    // which satisfies it exactly as an Engineer headline would.
    const t = mk({ status: "PENDING_REVIEW", requesterId: "u-1", requesterRole: "Viewer" });
    const acts = ctxActionsOf(t, "Requester", "u-1", { userRoles: ["Requester", "Engineer-2"] }).map((a) => a.action);
    expect(acts).toContain("approve_draft_ifc");
    expect(acts).not.toContain("request_final_engineer_approval");
  });

  it("an additive DraftingSupervisor role grants the assignment queue", () => {
    const t = mk({ status: "PENDING_ASSIGNMENT" });
    const acts = ctxActionsOf(t, "Viewer", "x-1", { userRoles: ["Viewer", "DraftingSupervisor"] }).map((a) => a.action);
    expect(acts).toContain("assign");
  });
});

describe("WF-8 — role capabilities are ticket-scoped, not org-wide substitution", () => {
  it("a Requester-role member canNOT act as reviewer on someone ELSE's ticket", () => {
    const t = mk({ status: "PENDING_REVIEW", requesterId: "u-1", requesterRole: "Viewer" });
    expect(actionsOf(t, "Requester", "someone-else")).toEqual([]);
  });

  it("a Requester-role member CAN substitute only when the ticket has no requester", () => {
    const t = mk({ status: "PENDING_REVIEW", requesterId: "", requesterRole: "Viewer" });
    const acts = actionsOf(t, "Requester", "someone-else");
    expect(acts).toContain("request_final_engineer_approval");
  });

  it("a Drafter canNOT issue the IFC package on another drafter's ticket", () => {
    const t = mk({ status: "PENDING_IFC", assignedDrafterId: "d-1" });
    expect(actionsOf(t, "Drafter", "d-2")).toEqual([]);
  });

  it("a Drafter CAN work an unassigned drafting-stage ticket", () => {
    const t = mk({ status: "PENDING_IFC", assignedDrafterId: null });
    expect(actionsOf(t, "Drafter", "d-2")).toContain("submit_final");
  });
});

describe("GAP-2/DEC-12 — separation of duties binds at >= 3 active members", () => {
  it("the assigned drafter reviewing their own deliverable is DISABLED (not hidden) at 3+", () => {
    // Engineer requester who is ALSO the assigned drafter — producer as checker.
    const t = mk({ status: "PENDING_REVIEW", requesterId: "u-1", requesterRole: "Engineer-2", assignedDrafterId: "u-1" });
    const acts = ctxActionsOf(t, "Engineer-2", "u-1", { activeMemberCount: 3 });
    const approve = acts.find((a) => a.action === "approve_draft_ifc");
    expect(approve).toBeDefined(); // visible —
    expect(approve?.disabledReason).toMatch(/second person/i); // — but blocked, with the reason.
    expect(acts.find((a) => a.action === "approve_minor_correction")?.disabledReason).toMatch(/second person/i);
    // The revision path stays open: independence blocks approval, not feedback.
    expect(acts.find((a) => a.action === "request_revision")?.disabledReason).toBeUndefined();
  });

  it("a TWO-person org keeps the single-person loop (no exclusions)", () => {
    const t = mk({ status: "PENDING_REVIEW", requesterId: "u-1", requesterRole: "Engineer-2", assignedDrafterId: "u-1" });
    const acts = ctxActionsOf(t, "Engineer-2", "u-1", { activeMemberCount: 2 });
    expect(acts.find((a) => a.action === "approve_draft_ifc")?.disabledReason).toBeUndefined();
  });

  it("self-assigning your own request is disabled at 3+, open at 2", () => {
    const t = mk({ status: "PENDING_ASSIGNMENT", requesterId: "d-1" });
    const at3 = ctxActionsOf(t, "Drafter", "d-1", { activeMemberCount: 3 }).find((a) => a.action === "self_assign");
    expect(at3?.disabledReason).toMatch(/second person/i);
    const at2 = ctxActionsOf(t, "Drafter", "d-1", { activeMemberCount: 2 }).find((a) => a.action === "self_assign");
    expect(at2).toBeDefined();
    expect(at2?.disabledReason).toBeUndefined();
    // Another drafter picking it up is never blocked.
    const other = ctxActionsOf(t, "Drafter", "d-2", { activeMemberCount: 3 }).find((a) => a.action === "self_assign");
    expect(other?.disabledReason).toBeUndefined();
  });

  it("the drafter-as-requester cannot acknowledge-close their own final at 3+", () => {
    const t = mk({ status: "FINAL_DRAFT", requesterId: "d-1", assignedDrafterId: "d-1" });
    const close = ctxActionsOf(t, "Drafter", "d-1", { activeMemberCount: 3 }).find((a) => a.action === "close_ticket");
    expect(close?.disabledReason).toMatch(/second person/i);
  });

  it("engineer final approval by the producing drafter is disabled at 3+", () => {
    const t = mk({ status: "PENDING_FINAL_APPROVAL", assignedEngineerId: "e-1", assignedDrafterId: "e-1" });
    const acts = ctxActionsOf(t, "Engineer-1", "e-1", { activeMemberCount: 3 });
    expect(acts.find((a) => a.action === "engineer_approve_final")?.disabledReason).toMatch(/second person/i);
    // Send-back paths stay open.
    expect(acts.find((a) => a.action === "engineer_request_revision")?.disabledReason).toBeUndefined();
  });

  it("absent context (legacy callers) reproduces prior behavior — no exclusions", () => {
    const t = mk({ status: "PENDING_REVIEW", requesterId: "u-1", requesterRole: "Engineer-2", assignedDrafterId: "u-1" });
    const approve = WorkflowEngine.getActions(t, "Engineer-2", "u-1").find((a) => a.action === "approve_draft_ifc");
    expect(approve?.disabledReason).toBeUndefined();
  });
});

describe("WF-15 — close-without-review is a property of the configured type", () => {
  it("defaults to RFI only", () => {
    const rfi = mk({ status: "DRAFTING", requestType: "RFI", assignedDrafterId: "d-1" });
    expect(actionsOf(rfi, "Drafter", "d-1")).toContain("close_rfi");
    const iso = mk({ status: "DRAFTING", requestType: "ISO", assignedDrafterId: "d-1" });
    expect(actionsOf(iso, "Drafter", "d-1")).not.toContain("close_rfi");
  });

  it("the configured list REPLACES the default — an org can grant it to other types and revoke RFI", () => {
    const fieldq = mk({ status: "DRAFTING", requestType: "FIELDQ", assignedDrafterId: "d-1" });
    const acts = ctxActionsOf(fieldq, "Drafter", "d-1", { closeWithoutReviewTypes: ["FIELDQ"] }).map((a) => a.action);
    expect(acts).toContain("close_rfi");

    const rfi = mk({ status: "DRAFTING", requestType: "RFI", assignedDrafterId: "d-1" });
    const rfiActs = ctxActionsOf(rfi, "Drafter", "d-1", { closeWithoutReviewTypes: ["FIELDQ"] }).map((a) => a.action);
    expect(rfiActs).not.toContain("close_rfi");
  });
});
