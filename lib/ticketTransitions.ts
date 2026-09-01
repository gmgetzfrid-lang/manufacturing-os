// lib/ticketTransitions.ts
//
// Pure transition logic for the drafting workflow — extracted verbatim from the
// ticket page's executeWorkflowAction so it can be (a) unit-tested and (b)
// enforced SERVER-SIDE by /api/tickets/workflow-action. The page no longer
// computes updates itself; it sends inputs and the server recomputes them here.
//
// Behavioral contract: identical to the previous client-side computation.
// lib/__tests__/ticketTransitions.test.ts freezes it.

import type { Ticket, TicketAttachment, TicketComment, TicketHistoryEntry, TicketStatus } from "@/types/schema";

export interface TransitionActor {
  uid?: string | null;
  email?: string | null;
  role: string;
}

export interface TransitionInput {
  /** The machine action name, e.g. "approve_initial". */
  actionType: string;
  /** The human label recorded into history (canonical: from WorkflowEngine). */
  actionLabel: string;
  variant?: string;
  comment?: string | null;
  /** When the comment box was pre-filled, an unchanged comment is NOT re-posted. */
  preFilledComment?: string | null;
  category?: string | null;
  isReassigning?: boolean;
  assignment?: { id: string; name: string } | null;
  engineer?: { id: string; name: string; email: string } | null;
  redlineAttachment?: TicketAttachment | null;
  finalAttachment?: TicketAttachment | null;
  actor: TransitionActor;
  now?: string;
}

export interface TransitionResult {
  updates: Record<string, unknown>;
  historyEntry: TicketHistoryEntry;
  newStatus: TicketStatus;
  /** Recipients for the in-app/email fan-out (already excludes the actor). */
  recipients: string[];
  /** The comment this action appended to the JSONB thread (or null). The caller
   *  must mirror it into the ticket_comments table so the two stores stay in
   *  sync — computeTransition only touches the JSONB. */
  newComment: Record<string, unknown> | null;
}

/** Map a tickets DB row to the Ticket shape the engine reads. */
export function rowToTicket(row: Record<string, unknown>): Ticket {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    ticketId: row.ticket_id as string,
    title: row.title as string,
    description: row.description as string | undefined,
    unit: row.unit as string,
    requestType: row.request_type as string,
    status: row.status as Ticket["status"],
    priority: row.priority as number | undefined,
    requesterId: row.requester_id as string,
    requesterName: row.requester_name as string | undefined,
    requesterEmail: row.requester_email as string | undefined,
    requesterRole: row.requester_role as Ticket["requesterRole"],
    assignedDrafterId: row.assigned_drafter_id as string | null | undefined,
    assignedDrafterName: row.assigned_drafter_name as string | null | undefined,
    assignedEngineerId: row.assigned_engineer_id as string | null | undefined,
    assignedEngineerName: row.assigned_engineer_name as string | null | undefined,
    assignedEngineerEmail: row.assigned_engineer_email as string | null | undefined,
    attachments: (row.attachments as Ticket["attachments"]) ?? [],
    comments: (row.comments as Ticket["comments"]) ?? [],
    history: (row.history as Ticket["history"]) ?? [],
    unreadBy: (row.unread_by as string[]) ?? [],
    watchers: (row.watchers as string[]) ?? [],
    revisionCount: row.revision_count as number | undefined,
    deliverableRev: row.deliverable_rev as string | null | undefined,
    draftIteration: row.draft_iteration as number | undefined,
    createdAt: row.created_at as string,
    lastModified: row.last_modified as string | undefined,
  } as Ticket;
}

// ─── Deliverable revision scheme (pure, exported for tests) ──────────────
//
//   submit for review (cycle N, iteration i) → `${N}${letter(i)}`  e.g. 1A, 1B
//   approve                                  → `${N}`               e.g. 1
//   revision requested                       → cycle N+1, iteration resets
//
// Nobody types these; the workflow assigns them.

export function draftRevLabel(revisionCount: number | undefined, iteration: number): string {
  const cycle = (revisionCount ?? 0) + 1;
  // iteration is 1-based: 1 → A. Past Z (unlikely), wrap to AA-style.
  const n = Math.max(1, iteration);
  let letters = "";
  let rem = n;
  while (rem > 0) {
    rem -= 1;
    letters = String.fromCharCode(65 + (rem % 26)) + letters;
    rem = Math.floor(rem / 26);
  }
  return `${cycle}${letters}`;
}

export function issuedRevLabel(revisionCount: number | undefined): string {
  return String((revisionCount ?? 0) + 1);
}

/**
 * Compute the full DB update for a workflow action. Pure: no IO, no Date.now()
 * (callers may pin `now`), so it is deterministic and testable. Mirrors the
 * legacy client computation exactly.
 */
export function computeTransition(ticket: Ticket, input: TransitionInput): TransitionResult {
  const now = input.now ?? new Date().toISOString();
  const actorUid = input.actor.uid ?? undefined;
  const finalComment = input.comment ?? undefined;

  const historyEntry: TicketHistoryEntry = {
    action: input.actionLabel,
    user: input.actor.email || "Unknown",
    role: input.actor.role,
    date: now,
  } as TicketHistoryEntry;

  if (input.redlineAttachment && finalComment) {
    historyEntry.details = finalComment;
  } else if (finalComment) {
    historyEntry.details = finalComment;
  } else if (input.assignment) {
    historyEntry.details = `Assigned to ${input.assignment.name}${input.comment ? ` [Reason: ${input.comment}]` : ""}`;
  }

  if (input.actionType === "request_revision" || input.actionType === "reject" || input.actionType === "reject_final") {
    historyEntry.revisionRound = (ticket.revisionCount || 0) + 1;
  }

  const newHistory = [...(ticket.history || []), historyEntry];
  const newUnreadBy = [ticket.requesterId, ticket.assignedDrafterId].filter(
    (id): id is string => !!id && id !== actorUid,
  );

  const updates: Record<string, unknown> = {
    last_modified: now,
    history: newHistory,
    unread_by: newUnreadBy,
  };

  let newComment: Record<string, unknown> | null = null;
  if (finalComment && finalComment !== (input.preFilledComment ?? undefined)) {
    newComment = {
      id: crypto.randomUUID(),
      text: finalComment,
      user: input.actor.email || "Unknown",
      role: input.actor.role,
      date: now,
      type:
        input.variant === "destructive" || input.actionType === "request_revision"
          ? "Revision"
          : input.isReassigning
            ? "Reassignment"
            : "General",
      category: input.category || null,
      authorUid: actorUid,
    };
    updates.comments = [...(ticket.comments || []), newComment as unknown as TicketComment];
  }

  let currentAttachments = [...(ticket.attachments || [])];
  if (input.redlineAttachment) currentAttachments = [...currentAttachments, input.redlineAttachment];

  switch (input.actionType) {
    case "save_progress":
      break;
    case "approve_initial":
      updates.status = "PENDING_ASSIGNMENT";
      break;
    case "request_eng_review":
      // WF-22: the status may only advance WITH its engineer — an
      // engineerless request used to reach PENDING_ENG_TEAM where the
      // org-wide eng_review fallback governed.
      if (input.engineer) {
        updates.status = "PENDING_ENG_TEAM";
        updates.assigned_engineer_id = input.engineer.id;
        updates.assigned_engineer_name = input.engineer.name;
        updates.assigned_engineer_email = input.engineer.email;
        updates.engineer_review_requested_at = now;
        updates.engineer_review_reason = finalComment || null;
        updates.unread_by = [input.engineer.id];
      }
      break;
    case "approve_team":
      updates.status = "PENDING_ASSIGNMENT";
      break;
    case "assign":
      if (input.assignment) {
        updates.assigned_drafter_id = input.assignment.id;
        updates.assigned_drafter_name = input.assignment.name;
        updates.status = "DRAFTING";
        updates.unread_by = [input.assignment.id];
      }
      break;
    case "self_assign":
      if (actorUid && input.actor.email) {
        updates.assigned_drafter_id = actorUid;
        updates.assigned_drafter_name = input.actor.email.split("@")[0];
        updates.status = "DRAFTING";
      }
      break;
    case "submit_draft": {
      updates.status = "PENDING_REVIEW";
      // Autonomous deliverable rev: submission i of cycle N reads "N<letter>"
      // (1A, 1B, … 2A). Approval later strips the letter.
      const iteration = (ticket.draftIteration ?? 0) + 1;
      updates.draft_iteration = iteration;
      updates.deliverable_rev = draftRevLabel(ticket.revisionCount, iteration);
      historyEntry.action = `Submitted for review — Rev ${updates.deliverable_rev}`;
      currentAttachments = currentAttachments.map((a) =>
        a.status === "staged" ? { ...a, status: "submitted" as const } : a,
      );
      break;
    }
    case "approve_draft_ifc":
      updates.status = "PENDING_IFC";
      updates.deliverable_rev = issuedRevLabel(ticket.revisionCount);
      historyEntry.action = `${input.actionLabel} — issued Rev ${updates.deliverable_rev}`;
      break;
    // "Fix this typo and it's approved" — the minor-correction fast path.
    // Approves the deliverable NOW (rev letter drops) with the correction
    // noted for the drafter to fold into the issued file; no extra full
    // review cycle for a mislabel or a typo.
    case "approve_minor_correction":
      updates.status = "PENDING_IFC";
      updates.deliverable_rev = issuedRevLabel(ticket.revisionCount);
      historyEntry.action = `Approved with minor correction — issued Rev ${updates.deliverable_rev}`;
      if (ticket.assignedDrafterId) updates.unread_by = [ticket.assignedDrafterId];
      break;
    case "request_final_engineer_approval":
      // WF-22: same rule — no engineer, no status change.
      if (input.engineer) {
        updates.status = "PENDING_FINAL_APPROVAL";
        updates.assigned_engineer_id = input.engineer.id;
        updates.assigned_engineer_name = input.engineer.name;
        updates.assigned_engineer_email = input.engineer.email;
        updates.engineer_review_requested_at = now;
        updates.engineer_review_reason = finalComment || null;
        updates.unread_by = [input.engineer.id];
      }
      break;
    case "engineer_approve_final":
      updates.status = "PENDING_IFC";
      updates.engineer_approved_at = now;
      updates.deliverable_rev = issuedRevLabel(ticket.revisionCount);
      historyEntry.action = `${input.actionLabel} — issued Rev ${updates.deliverable_rev}`;
      if (ticket.assignedDrafterId) updates.unread_by = [ticket.assignedDrafterId];
      break;
    case "engineer_request_revision":
      updates.status = "REVISION_REQ";
      updates.revision_count = (ticket.revisionCount || 0) + 1;
      updates.draft_iteration = 0; // next submission starts the new cycle at A
      if (ticket.assignedDrafterId) updates.unread_by = [ticket.assignedDrafterId];
      break;
    case "engineer_return_to_requester":
      updates.status = "PENDING_REVIEW";
      if (ticket.requesterId) updates.unread_by = [ticket.requesterId];
      break;
    case "reassign_engineer":
      if (input.engineer) {
        updates.assigned_engineer_id = input.engineer.id;
        updates.assigned_engineer_name = input.engineer.name;
        updates.assigned_engineer_email = input.engineer.email;
        updates.engineer_review_requested_at = now;
        updates.unread_by = [input.engineer.id];
      }
      break;
    case "request_revision":
    case "reject":
    case "reject_final":
      updates.status = "REVISION_REQ";
      updates.revision_count = (ticket.revisionCount || 0) + 1;
      updates.draft_iteration = 0; // next submission starts the new cycle at A
      break;
    case "submit_final":
      updates.status = "FINAL_DRAFT";
      if (input.finalAttachment) currentAttachments = [...currentAttachments, input.finalAttachment];
      break;
    case "close_ticket":
    case "close_rfi":
      updates.status = "CLOSED";
      break;
    case "reopen_ticket":
      updates.status = "PENDING_REVIEW";
      break;
  }

  updates.attachments = currentAttachments;

  // Acting on a ticket makes you a participant, so you follow future activity.
  if (actorUid) updates.watchers = Array.from(new Set([...(ticket.watchers ?? []), actorUid]));

  // For meaningful transitions (ones that already notify someone), also notify
  // everyone following the ticket — minus the actor.
  if (Array.isArray(updates.unread_by) && (updates.unread_by as string[]).length > 0 && (ticket.watchers ?? []).length > 0) {
    updates.unread_by = Array.from(
      new Set([...(updates.unread_by as string[]), ...(ticket.watchers ?? [])]),
    ).filter((u) => u !== actorUid);
  }

  const newStatus = (updates.status as TicketStatus) ?? ticket.status;

  // Stamp closed_at when the ticket ENTERS a terminal state, and clear it on
  // reopen. This is the archive eligibility clock — kept distinct from
  // last_modified so a post-close comment can't reset "quiet since".
  const TERMINAL = ["CLOSED", "CANCELED"];
  const wasTerminal = TERMINAL.includes(ticket.status);
  const nowTerminal = TERMINAL.includes(newStatus);
  if (nowTerminal && !wasTerminal) updates.closed_at = new Date().toISOString();
  else if (!nowTerminal && wasTerminal) updates.closed_at = null;

  const recipients = (updates.unread_by as string[]).filter((u) => u && u !== actorUid);

  return { updates, historyEntry, newStatus, recipients, newComment };
}

// ─── Notification classification for a transition ───────────────────────────
// Mirrors the page's event/kind/subject mapping so server fan-out is identical.

export interface TransitionNotification {
  eventType: string;
  emailSubject: string;
  inAppKind: "ticket_assigned" | "ticket_status";
  inAppTitle: string;
}

export function classifyTransitionNotification(params: {
  actionType: string;
  actionLabel: string;
  ticketLabel: string;
}): TransitionNotification {
  const { actionType, actionLabel, ticketLabel } = params;
  const isEngineerAction =
    actionType === "request_final_engineer_approval" ||
    actionType === "request_eng_review" ||
    actionType === "reassign_engineer";
  const isAssignment = actionType === "assign" || actionType === "self_assign";
  const isClosed = actionType === "close_ticket" || actionType === "close_rfi";
  const isApproved =
    actionType === "approve_draft_ifc" ||
    actionType === "engineer_approve_final" ||
    actionType === "approve_minor_correction";
  const isRevision =
    actionType === "request_revision" ||
    actionType === "engineer_request_revision" ||
    actionType === "reject" ||
    actionType === "reject_final";

  const eventType = isEngineerAction
    ? "engineer_review_requested"
    : isAssignment
      ? "assignment"
      : isClosed
        ? "ticket_closed"
        : isApproved
          ? "ticket_approved"
          : isRevision
            ? "ticket_revision_requested"
            : "ticket_status_changed";

  const emailSubject = isEngineerAction
    ? `Engineer review requested: ${ticketLabel}`
    : isAssignment
      ? `You were assigned to ${ticketLabel}`
      : `${actionLabel} — ${ticketLabel}`;

  const inAppKind = isAssignment ? ("ticket_assigned" as const) : ("ticket_status" as const);
  const inAppTitle = isAssignment ? `You were assigned · ${ticketLabel}` : `${actionLabel} · ${ticketLabel}`;

  return { eventType, emailSubject, inAppKind, inAppTitle };
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
