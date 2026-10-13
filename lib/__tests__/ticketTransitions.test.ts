// lib/__tests__/ticketTransitions.test.ts
//
// Freezes computeTransition — the pure function the server-side enforcement
// route uses to recompute every workflow update. This must stay behaviorally
// identical to the legacy client-side computation it replaced.

import { describe, it, expect } from "vitest";
import { computeTransition, classifyTransitionNotification, rowToTicket, draftRevLabel, issuedRevLabel, joiningFileRev, stampIssuedFinals, issueLabelFor } from "@/lib/ticketTransitions";
import type { Ticket, TicketAttachment, TicketHistoryEntry } from "@/types/schema";

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

  it("WF-22: request_eng_review WITHOUT an engineer does not advance the status", () => {
    const t = mk();
    const { updates, newStatus } = computeTransition(t, {
      actionType: "request_eng_review", actionLabel: "Flag for Engineering Review",
      comment: "check the nozzle loads", actor, now: NOW,
    });
    // An engineerless request used to reach PENDING_ENG_TEAM where the
    // org-wide fallback governed — now the ticket stays put.
    expect(newStatus).toBe(t.status);
    expect(updates.status).toBeUndefined();
    expect(updates.assigned_engineer_id).toBeUndefined();
  });

  it("WF-22: request_final_engineer_approval WITHOUT an engineer does not advance the status", () => {
    const t = mk({ status: "PENDING_REVIEW", assignedDrafterId: "u-draft" });
    const { updates, newStatus } = computeTransition(t, {
      actionType: "request_final_engineer_approval", actionLabel: "Send for Engineer Final Approval",
      comment: "please sign off", actor: { uid: "u-req", email: "r@x.com", role: "Viewer" }, now: NOW,
    });
    expect(newStatus).toBe("PENDING_REVIEW");
    expect(updates.status).toBeUndefined();
    expect(updates.assigned_engineer_id).toBeUndefined();
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

  it("submit_draft: staged attachments flip to submitted; deliverable rev assigned", () => {
    const staged: TicketAttachment = { id: "a1", name: "d.pdf", url: "u", type: "Draft", status: "staged" } as TicketAttachment;
    const t = mk({ status: "DRAFTING", assignedDrafterId: "u-draft", attachments: [staged], revisionCount: 2 });
    const { updates, historyEntry, newStatus } = computeTransition(t, {
      actionType: "submit_draft", actionLabel: "Submit Draft for Review",
      actor: { uid: "u-draft", email: "h@x.com", role: "Drafter" }, now: NOW,
    });
    expect(newStatus).toBe("PENDING_REVIEW");
    expect((updates.attachments as TicketAttachment[])[0].status).toBe("submitted");
    // revisionCount 2 → third cycle, first submission of it → 3A
    expect(updates.deliverable_rev).toBe("3A");
    expect(updates.draft_iteration).toBe(1);
    expect(historyEntry.action).toBe("Submitted for review — Rev 3A");
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

  it("close + reopen round-trip statuses; reopen starts a new revision cycle (DEC-15)", () => {
    expect(computeTransition(mk({ status: "FINAL_DRAFT" }), { actionType: "close_ticket", actionLabel: "Close", actor, now: NOW }).newStatus).toBe("CLOSED");
    const reopened = computeTransition(mk({ status: "CLOSED", revisionCount: 1, draftIteration: 1, deliverableRev: "2" }), { actionType: "reopen_ticket", actionLabel: "Reopen", comment: "missed sheet", actor, now: NOW });
    expect(reopened.newStatus).toBe("PENDING_REVIEW");
    expect(reopened.updates.revision_count).toBe(2);
    expect(reopened.updates.draft_iteration).toBe(0);
    expect(reopened.updates.deliverable_rev).toBeNull();
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
      actionType: "approve_team", actionLabel: "Approve", comment: "looks good", actor, now: NOW,
    });
    expect((withComment.updates.comments as unknown[]).length).toBe(1);

    const preFilled = computeTransition(mk(), {
      actionType: "approve_team", actionLabel: "Approve",
      comment: "template text", preFilledComment: "template text", actor, now: NOW,
    });
    expect(preFilled.updates.comments).toBeUndefined();
  });

  it("exposes newComment so the caller can mirror it into ticket_comments", () => {
    const withComment = computeTransition(mk(), {
      actionType: "approve_team", actionLabel: "Approve", comment: "looks good", actor, now: NOW,
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
    const { updates } = computeTransition(t, { actionType: "approve_team", actionLabel: "Approve", actor, now: NOW });
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

describe("deliverable revision scheme — 1A → 1 → 2A → 2", () => {
  it("draftRevLabel: cycle from revisionCount, letter from iteration (AA-wrap)", () => {
    expect(draftRevLabel(undefined, 1)).toBe("1A");
    expect(draftRevLabel(0, 2)).toBe("1B");
    expect(draftRevLabel(1, 1)).toBe("2A");
    expect(draftRevLabel(2, 3)).toBe("3C");
    expect(draftRevLabel(0, 26)).toBe("1Z");
    expect(draftRevLabel(0, 27)).toBe("1AA");
  });

  it("issuedRevLabel strips the letter: cycle number only", () => {
    expect(issuedRevLabel(undefined)).toBe("1");
    expect(issuedRevLabel(0)).toBe("1");
    expect(issuedRevLabel(3)).toBe("4");
  });

  it("full lifecycle: first submit is 1A, approve issues 1, next cycle submits 2A and issues 2", () => {
    const drafter = { uid: "u-draft", email: "h@x.com", role: "Drafter" };

    // 1) First submission → 1A
    const s1 = computeTransition(mk({ status: "DRAFTING", assignedDrafterId: "u-draft" }), {
      actionType: "submit_draft", actionLabel: "Submit Draft for Review", actor: drafter, now: NOW,
    });
    expect(s1.updates.deliverable_rev).toBe("1A");

    // 2) Approve → issued Rev 1 (letter drops)
    const a1 = computeTransition(
      mk({ status: "PENDING_REVIEW", assignedDrafterId: "u-draft", draftIteration: 1, deliverableRev: "1A" }),
      { actionType: "approve_draft_ifc", actionLabel: "Approve (Issue for Construction)", actor, now: NOW },
    );
    expect(a1.updates.deliverable_rev).toBe("1");
    expect(a1.historyEntry.action).toContain("issued Rev 1");

    // 3) Revision requested → cycle bumps, letter counter resets
    const r1 = computeTransition(
      mk({ status: "PENDING_REVIEW", draftIteration: 1, deliverableRev: "1A" }),
      { actionType: "request_revision", actionLabel: "Request Revision", comment: "fix dims", variant: "warning", actor, now: NOW },
    );
    expect(r1.updates.revision_count).toBe(1);
    expect(r1.updates.draft_iteration).toBe(0);

    // 4) Resubmit in cycle 2 → 2A
    const s2 = computeTransition(
      mk({ status: "REVISION_REQ", assignedDrafterId: "u-draft", revisionCount: 1, draftIteration: 0 }),
      { actionType: "submit_draft", actionLabel: "Submit Draft for Review", actor: drafter, now: NOW },
    );
    expect(s2.updates.deliverable_rev).toBe("2A");

    // 5) Approve again → issued Rev 2
    const a2 = computeTransition(
      mk({ status: "PENDING_REVIEW", revisionCount: 1, draftIteration: 1, deliverableRev: "2A" }),
      { actionType: "engineer_approve_final", actionLabel: "Approve as Engineer", actor: { uid: "u-eng", email: "e@x.com", role: "Engineer-1" }, now: NOW },
    );
    expect(a2.updates.deliverable_rev).toBe("2");
  });

  it("resubmitting within the same cycle advances the letter: 1A then 1B", () => {
    const drafter = { uid: "u-draft", email: "h@x.com", role: "Drafter" };
    const s = computeTransition(
      mk({ status: "DRAFTING", assignedDrafterId: "u-draft", draftIteration: 1, deliverableRev: "1A" }),
      { actionType: "submit_draft", actionLabel: "Submit Draft for Review", actor: drafter, now: NOW },
    );
    expect(s.updates.deliverable_rev).toBe("1B");
    expect(s.updates.draft_iteration).toBe(2);
  });

  it("approve_minor_correction: issues NOW, notes go to the drafter, notifies as approval", () => {
    const t = mk({ status: "PENDING_REVIEW", assignedDrafterId: "u-draft", draftIteration: 1, deliverableRev: "1A" });
    const { updates, newStatus, historyEntry, recipients } = computeTransition(t, {
      actionType: "approve_minor_correction", actionLabel: "Approve with Minor Correction",
      comment: "Title block says U-200, should be U-100", actor, now: NOW,
    });
    expect(newStatus).toBe("PENDING_IFC");
    expect(updates.deliverable_rev).toBe("1");
    expect(historyEntry.action).toBe("Approved with minor correction — issued Rev 1");
    expect(recipients).toContain("u-draft");
    expect((updates.comments as Array<{ text: string }>)[0].text).toContain("U-200");
    expect(
      classifyTransitionNotification({ actionType: "approve_minor_correction", actionLabel: "Approve with Minor Correction", ticketLabel: "T" }).eventType,
    ).toBe("ticket_approved");
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
    expect(classifyTransitionNotification({ actionType: "approve_team", actionLabel: "Engineering Review Complete", ticketLabel: "T" }).eventType)
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

// ─── public-surfaces PHYS-2 (drafting-flow DF-P10): every file carries its OWN revision ───
describe("PHYS-2 — per-file revision, stamped server-side", () => {
  const drafter = { uid: "u-d", email: "d@x.com", role: "Drafter" };
  const att = (over: Partial<TicketAttachment>): TicketAttachment =>
    ({ id: "x", name: "x.pdf", url: "orgs/o/tickets/T/x.pdf", type: "Final", status: "submitted", ...over }) as TicketAttachment;
  const files = (r: { updates: Record<string, unknown> }) => r.updates.attachments as TicketAttachment[];

  it("submit_draft stamps the review label onto the Draft(s) it submits — not onto other staged files, not onto earlier drafts", () => {
    const t = mk({
      status: "DRAFTING", assignedDrafterId: "u-d", revisionCount: 1, draftIteration: 0,
      attachments: [
        att({ id: "old", type: "Draft", status: "submitted", rev: "1A" }),
        att({ id: "d1", type: "Draft", status: "staged" }),
        att({ id: "ref", type: "Reference", status: "staged", rev: null }),
      ],
    });
    const r = computeTransition(t, { actionType: "submit_draft", actionLabel: "Submit Draft for Review", actor: drafter, now: NOW });
    expect(r.updates.deliverable_rev).toBe("2A");
    const byId = Object.fromEntries(files(r).map((a) => [a.id, a]));
    expect(byId.d1).toMatchObject({ status: "submitted", rev: "2A" });
    expect(byId.old.rev).toBe("1A");            // an earlier draft keeps its own label
    expect(byId.ref).toMatchObject({ status: "submitted", rev: null }); // a reference file is no deliverable
  });

  it("submit_final stamps the issued label in force onto the package — whatever rev the client sent", () => {
    const fin = att({ id: "f2", rev: "9" }); // a forged label from the browser
    const r = computeTransition(mk({ status: "PENDING_IFC", assignedDrafterId: "u-d", deliverableRev: "2", revisionCount: 1 }), {
      actionType: "submit_final", actionLabel: "Issue IFC", finalAttachment: fin, actor: drafter, now: NOW,
    });
    expect(files(r).find((a) => a.id === "f2")!.rev).toBe("2");
    // a legacy row at PENDING_IFC without an issued label cannot name the file's revision
    const legacy = computeTransition(mk({ status: "PENDING_IFC", assignedDrafterId: "u-d", deliverableRev: null }), {
      actionType: "submit_final", actionLabel: "Issue IFC", finalAttachment: att({ id: "f3", rev: "1" }), actor: drafter, now: NOW,
    });
    expect(files(legacy).find((a) => a.id === "f3")!.rev).toBeNull();
  });

  it("attach_file: a Final added where the issued file is current takes that label; anywhere else it waits (null); never the client's", () => {
    const at = (status: Ticket["status"], deliverableRev: string | null, a: TicketAttachment) =>
      files(computeTransition(mk({ status, deliverableRev, assignedDrafterId: "u-d" }), { actionType: "attach_file", actionLabel: "Add File", attachment: a, actor: drafter, now: NOW }))
        .find((x) => x.id === a.id)!;
    expect(at("FINAL_DRAFT", "1", att({ id: "a1", status: "staged", rev: "7" })).rev).toBe("1");
    expect(at("PENDING_IFC", "1", att({ id: "a2", status: "staged" })).rev).toBe("1");
    expect(at("REVISION_REQ", "1", att({ id: "a3", status: "staged", rev: "1" })).rev).toBeNull(); // next cycle's work
    expect(at("DRAFTING", null, att({ id: "a4", status: "staged" })).rev).toBeNull();
    expect(at("FINAL_DRAFT", "1", att({ id: "a5", type: "Draft", status: "staged", rev: "1" })).rev).toBeNull(); // a draft is labelled at submit
    expect(at("FINAL_DRAFT", "1", att({ id: "a6", type: "Source", status: "submitted", rev: "1" })).rev).toBeNull();
  });

  it("a redline is a reference file: its rev is null whatever the client sent", () => {
    const r = computeTransition(mk({ status: "PENDING_REVIEW" }), {
      actionType: "request_revision", actionLabel: "Request Revision", comment: "see redlines", variant: "destructive",
      redlineAttachment: att({ id: "r1", type: "Reference", rev: "3" }), actor, now: NOW,
    });
    expect(files(r).find((a) => a.id === "r1")!.rev).toBeNull();
  });

  it("each issuing action stamps the new label onto the Finals waiting for it (rev null) — never onto a labelled Final or one recorded before per-file revisions", () => {
    const eng = { uid: "e-1", email: "e@x.io", role: "Engineer-2" };
    const cases: Array<[string, Ticket["status"], typeof actor]> = [
      ["approve_draft_ifc", "PENDING_REVIEW", actor],
      ["approve_minor_correction", "PENDING_REVIEW", actor],
      ["engineer_approve_final", "PENDING_FINAL_APPROVAL", eng],
    ];
    for (const [actionType, status, who] of cases) {
      const t = mk({
        status, revisionCount: 1, draftIteration: 1, deliverableRev: "2A", assignedEngineerId: "e-1", assignedDrafterId: "u-d",
        attachments: [
          att({ id: "f1", rev: "1" }),                 // Rev 1's package
          att({ id: "legacy" }),                       // recorded before per-file revisions (no key)
          att({ id: "waiting", status: "staged", rev: null }), // added since, awaiting this issue
          att({ id: "dr", type: "Draft", rev: "2A" }),
        ],
      });
      const r = computeTransition(t, { actionType, actionLabel: actionType, comment: "ok", actor: who, now: NOW });
      expect(r.updates.deliverable_rev, actionType).toBe("2");
      const byId = Object.fromEntries(files(r).map((a) => [a.id, a]));
      expect(byId.waiting.rev, actionType).toBe("2");
      expect(byId.f1.rev, actionType).toBe("1");
      expect("rev" in byId.legacy, actionType).toBe(false);
      expect(byId.dr.rev, actionType).toBe("2A"); // the draft stays a draft: it scans "review draft — Rev 2 issued from it"
    }
  });

  it("helpers: joiningFileRev / stampIssuedFinals", () => {
    expect(joiningFileRev({ status: "FINAL_DRAFT", deliverableRev: "3" }, { type: "Final" })).toBe("3");
    expect(joiningFileRev({ status: "FINAL_DRAFT", deliverableRev: "3A" }, { type: "Final" })).toBeNull();
    expect(joiningFileRev({ status: "CLOSED", deliverableRev: "3" }, { type: "Final" })).toBeNull();
    const out = stampIssuedFinals([att({ id: "a", rev: null }), att({ id: "b" }), att({ id: "c", type: "Reference", rev: null })], "4");
    expect(out.map((a) => a.rev)).toEqual(["4", undefined, null]);
  });

  it("the walk: Rev 1's package keeps Rev 1 after Rev 2 issues (the file the PM prints names its own revision)", () => {
    const admin = actor;
    let t = mk({ status: "PENDING_IFC", assignedDrafterId: "u-d", revisionCount: 0, deliverableRev: "1" });
    const apply = (r: ReturnType<typeof computeTransition>) => {
      t = { ...t, status: r.newStatus, attachments: r.updates.attachments as TicketAttachment[],
        revisionCount: (r.updates.revision_count as number | undefined) ?? t.revisionCount,
        deliverableRev: "deliverable_rev" in r.updates ? (r.updates.deliverable_rev as string | null) : t.deliverableRev,
        draftIteration: (r.updates.draft_iteration as number | undefined) ?? t.draftIteration } as Ticket;
    };
    apply(computeTransition(t, { actionType: "submit_final", actionLabel: "Issue IFC", finalAttachment: att({ id: "rev1" }), actor: drafter, now: NOW }));
    apply(computeTransition(t, { actionType: "close_ticket", actionLabel: "Acknowledge & Close", actor: admin, now: NOW }));
    apply(computeTransition(t, { actionType: "reopen_ticket", actionLabel: "Reopen Ticket", comment: "missed a nozzle", actor: admin, now: NOW }));
    t = { ...t, attachments: [...t.attachments!, att({ id: "d2", type: "Draft", status: "staged" })] } as Ticket;
    apply(computeTransition({ ...t, status: "DRAFTING" } as Ticket, { actionType: "submit_draft", actionLabel: "Submit Draft for Review", actor: drafter, now: NOW }));
    apply(computeTransition(t, { actionType: "approve_draft_ifc", actionLabel: "Approve", actor: admin, now: NOW }));
    apply(computeTransition(t, { actionType: "submit_final", actionLabel: "Issue IFC", finalAttachment: att({ id: "rev2" }), actor: drafter, now: NOW }));
    expect(t.deliverableRev).toBe("2");
    const byId = Object.fromEntries(t.attachments!.map((a) => [a.id, a]));
    expect(byId.rev1.rev).toBe("1");
    expect(byId.rev2.rev).toBe("2");
    expect(byId.d2.rev).toBe("2A");
  });
});

// ─── drafting-flow SM-5 / LEAK-7 (DF-P10): an issuing action never re-issues a label ───
describe("SM-5 — an issued label is never written twice: re-cycled from the history", () => {
  const issuedLine = (n: number) => ({ action: `Approve (Issue for Construction) — issued Rev ${n}`, user: "r@x.com", role: "Requester", date: NOW });
  const reviewer = { uid: "u-req", email: "r@x.com", role: "Requester" };
  // A ticket reopened BEFORE Round E (LEAK-7 population (a)): the old reopen
  // kept revision_count 0 and the issued label "1"; the history issued Rev 1.
  const legacy = (over: Partial<Ticket> = {}) => mk({
    status: "PENDING_REVIEW", revisionCount: 0, deliverableRev: "1", assignedDrafterId: "u-d",
    history: [issuedLine(1) as TicketHistoryEntry, { action: "Reopen Ticket", user: "r@x.com", role: "Requester", date: NOW } as TicketHistoryEntry],
    attachments: [{ id: "f-old", name: "v1.pdf", url: "orgs/o/tickets/T/v1.pdf", type: "Final", status: "submitted", rev: "1" } as TicketAttachment,
      { id: "f-new", name: "v2.pdf", url: "orgs/o/tickets/T/v2.pdf", type: "Final", status: "submitted", rev: null } as TicketAttachment],
    ...over,
  });

  for (const [actionType, actionLabel, status] of [
    ["approve_draft_ifc", "Approve (Issue for Construction)", "PENDING_REVIEW"],
    ["approve_minor_correction", "Approve with Minor Correction", "PENDING_REVIEW"],
    ["engineer_approve_final", "Engineer Approve", "PENDING_FINAL_APPROVAL"],
  ] as const) {
    it(`${actionType} on a legacy row whose history issued Rev 1 issues Rev 2 — never Rev 1 again`, () => {
      const r = computeTransition(legacy({ status }), { actionType, actionLabel, actor: reviewer, now: NOW });
      expect(r.updates.deliverable_rev).toBe("2");
      expect(r.updates.revision_count).toBe(1); // the cycle moves with the label
      expect(r.historyEntry.action).toMatch(/issued Rev 2$/);
      expect(r.historyEntry.details).toMatch(/Rev 1 was already issued on this ticket — issued as Rev 2 instead/);
      // the package waiting for this issue takes Rev 2; the old package keeps Rev 1
      const files = Object.fromEntries((r.updates.attachments as TicketAttachment[]).map((a) => [a.id, a.rev]));
      expect(files).toEqual({ "f-old": "1", "f-new": "2" });
    });
  }

  it("a reviewer comment is kept, with the re-cycle note beside it", () => {
    const r = computeTransition(legacy(), { actionType: "approve_draft_ifc", actionLabel: "Approve (Issue for Construction)", comment: "Looks good", actor: reviewer, now: NOW });
    expect(r.historyEntry.details).toBe("Looks good [Rev 1 was already issued on this ticket — issued as Rev 2 instead, so no two packages share a label.]");
  });

  it("trust boundary: only an EXACT collision re-cycles; a history line above revision_count + 1 (a member's own append) is ignored", () => {
    const forged = (n: number) => ({ action: `note — issued Rev ${n}`, user: "member@x.com", role: "Viewer", date: NOW }) as TicketHistoryEntry;
    // a forged higher number never moves the label or revision_count
    expect(issueLabelFor({ revisionCount: 1, history: [issuedLine(1), forged(3)] as TicketHistoryEntry[] })).toEqual({ label: "2", revisionCount: null, recycledFrom: null });
    expect(issueLabelFor({ revisionCount: 0, history: [forged(9)] })).toEqual({ label: "1", revisionCount: null, recycledFrom: null });
    // the legacy collision still re-cycles by exactly one
    expect(issueLabelFor({ revisionCount: 0, history: [issuedLine(1), forged(9)] as TicketHistoryEntry[] })).toEqual({ label: "2", revisionCount: 1, recycledFrom: "1" });
    // through the route's pure core: no revision_count 9, no Rev 10
    const r = computeTransition(mk({ status: "PENDING_REVIEW", revisionCount: 0, deliverableRev: "1A", history: [forged(9)] }), {
      actionType: "approve_draft_ifc", actionLabel: "Approve (Issue for Construction)", actor: reviewer, now: NOW,
    });
    expect(r.updates.deliverable_rev).toBe("1");
    expect("revision_count" in r.updates).toBe(false);
    expect(r.historyEntry.details).toBeUndefined();
  });

  it("the ordinary path is untouched: a label the history never issued is written as before, with no revision_count write and no note", () => {
    expect(issueLabelFor({ revisionCount: 1, history: [issuedLine(1)] as TicketHistoryEntry[] })).toEqual({ label: "2", revisionCount: null, recycledFrom: null });
    expect(issueLabelFor({ revisionCount: 0, history: [] })).toEqual({ label: "1", revisionCount: null, recycledFrom: null });
    const r = computeTransition(mk({ status: "PENDING_REVIEW", revisionCount: 1, deliverableRev: "2A", history: [issuedLine(1) as TicketHistoryEntry] }), {
      actionType: "approve_draft_ifc", actionLabel: "Approve (Issue for Construction)", actor: reviewer, now: NOW,
    });
    expect(r.updates.deliverable_rev).toBe("2");
    expect("revision_count" in r.updates).toBe(false);
    expect(r.historyEntry.details).toBeUndefined();
  });
});
