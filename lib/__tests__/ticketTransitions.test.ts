// lib/__tests__/ticketTransitions.test.ts
//
// Freezes computeTransition — the pure function the server-side enforcement
// route uses to recompute every workflow update. This must stay behaviorally
// identical to the legacy client-side computation it replaced.

import { describe, it, expect } from "vitest";
import { computeTransition, classifyTransitionNotification, rowToTicket } from "@/lib/ticketTransitions";
import type { Ticket, TicketAttachment } from "@/types/schema";

const NOW = "2026-06-15T12:00:00.000Z";

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
    requesterRole: "Viewer",
    attachments: [],
    comments: [],
    history: [],
    unreadBy: [],
    watchers: [],
    createdAt: NOW,
    ...over,
  } as Ticket;
}

const actor = { uid: "u-admin", email: "admin@x.com", role: "Admin" };

describe("computeTransition — core behaviors", () => {
  it("assign: sets drafter, moves to DRAFTING, notifies exactly the assignee", () => {
    const { updates, newStatus, recipients } = computeTransition(mk(), {
      actionType: "assign", actionLabel: "Assign Drafter",
      assignment: { id: "u-draft", name: "Hector" }, actor, now: NOW,
    });
    expect(newStatus).toBe("DRAFTING");
    expect(updates.assigned_drafter_id).toBe("u-draft");
    expect(updates.assigned_drafter_name).toBe("Hector");
    expect(recipients).toEqual(["u-draft"]);
    expect(updates.last_modified).toBe(NOW);
  });

  it("request_eng_review: routes to the picked engineer with reason", () => {
    const { updates, newStatus, recipients } = computeTransition(mk(), {
      actionType: "request_eng_review", actionLabel: "Flag for Engineering Review",
      comment: "check the nozzle loads",
      engineer: { id: "u-eng", name: "Brady", email: "b@x.com" }, actor, now: NOW,
    });
    expect(newStatus).toBe("PENDING_ENG_TEAM");
    expect(updates.assigned_engineer_id).toBe("u-eng");
    expect(updates.engineer_review_reason).toBe("check the nozzle loads");
    expect(updates.engineer_review_requested_at).toBe(NOW);
    expect(recipients).toEqual(["u-eng"]);
  });

  it("self_assign: actor becomes the drafter", () => {
    const { updates, newStatus } = computeTransition(mk(), {
      actionType: "self_assign", actionLabel: "Pick Up Ticket",
      actor: { uid: "u-draft", email: "hector@x.com", role: "Drafter" }, now: NOW,
    });
    expect(newStatus).toBe("DRAFTING");
    expect(updates.assigned_drafter_id).toBe("u-draft");
    expect(updates.assigned_drafter_name).toBe("hector");
  });

  it("submit_draft: staged attachments flip to submitted; revision label after round 1", () => {
    const staged: TicketAttachment = { id: "a1", name: "d.pdf", url: "u", type: "Draft", status: "staged" } as TicketAttachment;
    const t = mk({ status: "DRAFTING", assignedDrafterId: "u-draft", attachments: [staged], revisionCount: 2 });
    const { updates, historyEntry, newStatus } = computeTransition(t, {
      actionType: "submit_draft", actionLabel: "Submit Draft for Review",
      actor: { uid: "u-draft", email: "h@x.com", role: "Drafter" }, now: NOW,
    });
    expect(newStatus).toBe("PENDING_REVIEW");
    expect((updates.attachments as TicketAttachment[])[0].status).toBe("submitted");
    expect(historyEntry.action).toBe("Submitted Revision 2");
  });

  it("revision actions bump revision_count and record the round in history", () => {
    const t = mk({ status: "PENDING_REVIEW", revisionCount: 1 });
    const { updates, historyEntry, newStatus } = computeTransition(t, {
      actionType: "request_revision", actionLabel: "Request Revision",
      comment: "fix dims", variant: "warning", actor, now: NOW,
    });
    expect(newStatus).toBe("REVISION_REQ");
    expect(updates.revision_count).toBe(2);
    expect(historyEntry.revisionRound).toBe(2);
  });

  it("engineer_approve_final: stamps approval and hands back to the drafter", () => {
    const t = mk({ status: "PENDING_FINAL_APPROVAL", assignedDrafterId: "u-draft", assignedEngineerId: "u-eng" });
    const { updates, newStatus, recipients } = computeTransition(t, {
      actionType: "engineer_approve_final", actionLabel: "Approve as Engineer",
      actor: { uid: "u-eng", email: "b@x.com", role: "Engineer-1" }, now: NOW,
    });
    expect(newStatus).toBe("PENDING_IFC");
    expect(updates.engineer_approved_at).toBe(NOW);
    expect(recipients).toEqual(["u-draft"]);
  });

  it("close + reopen round-trip statuses", () => {
    expect(computeTransition(mk({ status: "FINAL_DRAFT" }), { actionType: "close_ticket", actionLabel: "Close", actor, now: NOW }).newStatus).toBe("CLOSED");
    expect(computeTransition(mk({ status: "CLOSED" }), { actionType: "reopen_ticket", actionLabel: "Reopen", comment: "missed sheet", actor, now: NOW }).newStatus).toBe("PENDING_REVIEW");
  });

  it("save_progress changes no status", () => {
    const t = mk({ status: "DRAFTING" });
    const { updates, newStatus } = computeTransition(t, { actionType: "save_progress", actionLabel: "Save Progress", actor, now: NOW });
    expect(newStatus).toBe("DRAFTING");
    expect(updates.status).toBeUndefined();
  });
});

describe("computeTransition — comments, watchers, fan-out", () => {
  it("a comment is appended once (and not when it equals the pre-filled text)", () => {
    const withComment = computeTransition(mk(), {
      actionType: "approve_initial", actionLabel: "Approve", comment: "looks good", actor, now: NOW,
    });
    expect((withComment.updates.comments as unknown[]).length).toBe(1);

    const preFilled = computeTransition(mk(), {
      actionType: "approve_initial", actionLabel: "Approve",
      comment: "template text", preFilledComment: "template text", actor, now: NOW,
    });
    expect(preFilled.updates.comments).toBeUndefined();
  });

  it("exposes newComment so the caller can mirror it into ticket_comments", () => {
    const withComment = computeTransition(mk(), {
      actionType: "approve_initial", actionLabel: "Approve", comment: "looks good", actor, now: NOW,
    });
    expect(withComment.newComment).toMatchObject({ text: "looks good", type: "General" });
    // No comment text → nothing to mirror.
    const none = computeTransition(mk(), { actionType: "save_progress", actionLabel: "Save", actor, now: NOW });
    expect(none.newComment).toBeNull();
  });

  it("destructive/revision comments are typed Revision; reassignment typed Reassignment", () => {
    const rev = computeTransition(mk({ status: "PENDING_REVIEW" }), {
      actionType: "request_revision", actionLabel: "Request Revision", comment: "redo", variant: "warning", actor, now: NOW,
    });
    expect((rev.updates.comments as Array<{ type: string }>)[0].type).toBe("Revision");

    const reassign = computeTransition(mk({ status: "DRAFTING" }), {
      actionType: "assign", actionLabel: "Reassign", comment: "load balancing",
      assignment: { id: "u2", name: "Sam" }, isReassigning: true, actor, now: NOW,
    });
    expect((reassign.updates.comments as Array<{ type: string }>)[0].type).toBe("Reassignment");
  });

  it("the actor becomes a watcher; existing watchers are kept", () => {
    const t = mk({ watchers: ["u-req"] });
    const { updates } = computeTransition(t, { actionType: "approve_initial", actionLabel: "Approve", actor, now: NOW });
    expect(updates.watchers).toEqual(expect.arrayContaining(["u-req", "u-admin"]));
  });

  it("meaningful transitions fan out to watchers, never to the actor", () => {
    const t = mk({ watchers: ["u-watcher", "u-admin"], assignedDrafterId: "u-draft" });
    const { recipients } = computeTransition(t, {
      actionType: "assign", actionLabel: "Assign", assignment: { id: "u-draft2", name: "S" }, actor, now: NOW,
    });
    expect(recipients).toEqual(expect.arrayContaining(["u-draft2", "u-watcher"]));
    expect(recipients).not.toContain("u-admin");
  });

  it("redline attachment is appended; final attachment lands on submit_final", () => {
    const red: TicketAttachment = { id: "r1", name: "REDLINE.pdf", url: "u", type: "Reference", status: "submitted" } as TicketAttachment;
    const r = computeTransition(mk({ status: "PENDING_REVIEW" }), {
      actionType: "request_revision", actionLabel: "Request Revision", comment: "see redlines",
      variant: "destructive", redlineAttachment: red, actor, now: NOW,
    });
    expect((r.updates.attachments as TicketAttachment[]).map((a) => a.id)).toContain("r1");

    const fin: TicketAttachment = { id: "f1", name: "IFC.pdf", url: "u", type: "Final", status: "submitted" } as TicketAttachment;
    const f = computeTransition(mk({ status: "PENDING_IFC", assignedDrafterId: "u-d" }), {
      actionType: "submit_final", actionLabel: "Issue IFC", finalAttachment: fin,
      actor: { uid: "u-d", email: "d@x.com", role: "Drafter" }, now: NOW,
    });
    expect(f.newStatus).toBe("FINAL_DRAFT");
    expect((f.updates.attachments as TicketAttachment[]).map((a) => a.id)).toContain("f1");
  });
});

describe("classifyTransitionNotification", () => {
  it("maps actions to the same event types and titles the client used", () => {
    expect(classifyTransitionNotification({ actionType: "assign", actionLabel: "Assign Drafter", ticketLabel: "T" }))
      .toEqual({ eventType: "assignment", emailSubject: "You were assigned to T", inAppKind: "ticket_assigned", inAppTitle: "You were assigned · T" });
    expect(classifyTransitionNotification({ actionType: "request_eng_review", actionLabel: "Flag", ticketLabel: "T" }).eventType)
      .toBe("engineer_review_requested");
    expect(classifyTransitionNotification({ actionType: "close_ticket", actionLabel: "Close", ticketLabel: "T" }).eventType)
      .toBe("ticket_closed");
    expect(classifyTransitionNotification({ actionType: "engineer_approve_final", actionLabel: "Approve", ticketLabel: "T" }).eventType)
      .toBe("ticket_approved");
    expect(classifyTransitionNotification({ actionType: "reject", actionLabel: "Reject", ticketLabel: "T" }).eventType)
      .toBe("ticket_revision_requested");
    expect(classifyTransitionNotification({ actionType: "approve_initial", actionLabel: "Approve Request", ticketLabel: "T" }).eventType)
      .toBe("ticket_status_changed");
  });
});

describe("rowToTicket", () => {
  it("maps snake_case rows to the Ticket shape with safe defaults", () => {
    const t = rowToTicket({ id: "x", org_id: "o", ticket_id: "KE-DDRT-26-0001", title: "T", status: "DRAFTING", requester_id: "r" });
    expect(t.ticketId).toBe("KE-DDRT-26-0001");
    expect(t.attachments).toEqual([]);
    expect(t.watchers).toEqual([]);
    expect(t.unreadBy).toEqual([]);
  });
});
