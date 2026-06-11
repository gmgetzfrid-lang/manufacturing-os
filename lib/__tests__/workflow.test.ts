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
});

describe("PENDING_FINAL_APPROVAL — engineer sign-off", () => {
  const t = mk({ status: "PENDING_FINAL_APPROVAL", assignedEngineerId: "eng-1" });

  it("the assigned engineer can approve, send back to drafter, or return to requester", () => {
    expect(actionsOf(t, "Engineer-1", "eng-1")).toEqual(
      ["engineer_approve_final", "engineer_request_revision", "engineer_return_to_requester"].sort(),
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
