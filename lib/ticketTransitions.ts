// lib/ticketTransitions.ts
//
// Pure transition logic for the drafting workflow — extracted verbatim from the
// ticket page's executeWorkflowAction so it can be (a) unit-tested and (b)
// enforced SERVER-SIDE by /api/tickets/workflow-action. The page no longer
// computes updates itself; it sends inputs and the server recomputes them here.
//
// Behavioral contract: identical to the previous client-side computation.
// lib/__tests__/ticketTransitions.test.ts freezes it.

import type { Ticket, TicketAttachment, TicketComment, TicketHistoryEntry, TicketOutcome, TicketStatus } from "@/types/schema";
import { lastIssuedFromHistory } from "@/lib/verifyTicketVerdict";
import { defaultOutcome } from "@/lib/ticketOutcome";

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
  /** WF-9: the file an `attach_file` action adds (bytes already in storage;
   *  the ticket row's attachments/history write is what rides the route). */
  attachment?: TicketAttachment | null;
  /** LEAK-9 / GAP-107 (DF-P3): how the request ended, for the actions that
   *  end one (close_ticket, close_rfi, cancel_request) — validated by the
   *  workflow route against lib/ticketOutcome.ts. Absent → defaultOutcome(). */
  outcome?: TicketOutcome | null;
  /** DCW-1 / GAP-105 and DCW-7 / FRIC-3 (DF-P4): what triage sets with
   *  `assign` / `request_eng_review` at PENDING_ASSIGNMENT — the library the
   *  request targets (the route has checked it is a library of the ticket's
   *  org) and the unit (the route has resolved it against the org's list,
   *  lib/ticketCreate.ts unitOptionsFor). Ignored for any other action or
   *  status. Neither is ever required. */
  triage?: { library?: { id: string; name: string } | null; unit?: string | null } | null;
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

/** Map a tickets DB row to the Ticket shape the engine reads.
 *  PERS-5 (DF-P4): no `as Ticket` cast — the object literal is checked
 *  against the type, so a required field added to Ticket and not mapped here
 *  is a compile error, and every column a server reader takes through this
 *  mapper is mapped (the archive stamps, closed_at, updated_at, the search
 *  keywords, the library). PERS-6: `unit` is NULL when unknown. */
export function rowToTicket(row: Record<string, unknown>): Ticket {
  const ticket: Ticket = {
    id: row.id as string,
    orgId: row.org_id as string,
    ticketId: row.ticket_id as string,
    title: row.title as string,
    description: row.description as string | undefined,
    unit: typeof row.unit === "string" ? row.unit : null,
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
    // DRAFT-2: the engineering-review stamps were never mapped, so every
    // server-side reader saw undefined — the "engineering first" gate reads
    // engineerReviewRequestedAt to know the review has happened.
    engineerReviewRequestedAt: row.engineer_review_requested_at as string | null | undefined,
    engineerApprovedAt: row.engineer_approved_at as string | null | undefined,
    engineerReviewReason: row.engineer_review_reason as string | null | undefined,
    attachments: (row.attachments as Ticket["attachments"]) ?? [],
    comments: (row.comments as Ticket["comments"]) ?? [],
    history: (row.history as Ticket["history"]) ?? [],
    // The JSONB bag: source_document (the intent bridge, the hand-back),
    // moc, checkin, deliverable. Without it every server-side reader of
    // ticket.metadata saw undefined.
    metadata: (row.metadata as Record<string, unknown> | null) ?? undefined,
    unreadBy: (row.unread_by as string[]) ?? [],
    watchers: (row.watchers as string[]) ?? [],
    revisionCount: row.revision_count as number | undefined,
    deliverableRev: row.deliverable_rev as string | null | undefined,
    draftIteration: row.draft_iteration as number | undefined,
    // DF-P3 (GAP-106 / GAP-107): the SLA clock and how the request ended.
    targetCompletionAt: row.target_completion_at as string | null | undefined,
    slaBreachWarnedAt: row.sla_breach_warned_at as string | null | undefined,
    slaBreachedAt: row.sla_breached_at as string | null | undefined,
    outcome: (row.outcome as Ticket["outcome"]) ?? null,
    // GAP-105 / DCW-1 (DF-P4): the library the request targets (null before
    // 20261208 is pasted, or when none is known yet).
    libraryId: typeof row.library_id === "string" ? row.library_id : null,
    searchKeywords: Array.isArray(row.search_keywords) ? (row.search_keywords as string[]) : undefined,
    closedAt: row.closed_at as string | null | undefined,
    archivedAt: row.archived_at as string | null | undefined,
    archiveId: row.archive_id as string | null | undefined,
    createdAt: row.created_at as string,
    lastModified: row.last_modified as string | undefined,
    updatedAt: row.updated_at as string | undefined,
  };
  return ticket;
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
 * drafting-flow SM-5 / LEAK-7: the label an issuing action writes, checked
 * against the ticket's own history. When the cycle's label (issuedRevLabel)
 * was ALREADY issued ("… — issued Rev N", the line every approval writes) —
 * a ticket reopened before Round E kept its revision_count, so its next
 * approval would issue the same Rev N a second time and both packages would
 * scan "current" — the issue is RE-CYCLED to the next number (revision_count
 * moves to match, so the cycle and the label agree), with a history note
 * saying so. Never refused: refusing would block a legitimate approval on a
 * legacy row.
 *
 * Trust boundary: any org member may append a history entry in their own
 * name (20261166's ticket_update_guard allows it), so only an EXACT
 * collision re-cycles, and a line above revision_count + 1 is ignored
 * (lastIssuedFromHistory's cap) — a forged "issued Rev 9" never makes the
 * service-role route write revision_count 9 / Rev 10. A forged line naming
 * the cycle's own label can still skip one number; the guard refusing a
 * client-appended "issued Rev" entry closes that (a migration, proposed).
 */
export function issueLabelFor(ticket: Pick<Ticket, "revisionCount" | "history">): {
  label: string;
  /** The revision_count to write when the label was re-cycled; null otherwise. */
  revisionCount: number | null;
  /** The label the cycle alone would have issued, when it was already issued. */
  recycledFrom: string | null;
} {
  const label = issuedRevLabel(ticket.revisionCount);
  // Capped at revision_count + 1 (= label): the trusted maximum is the label
  // itself exactly when the label was already issued.
  const last = lastIssuedFromHistory(ticket.history, ticket.revisionCount ?? 0);
  if (last !== label) return { label, revisionCount: null, recycledFrom: null };
  const next = parseInt(label, 10) + 1;
  return { label: String(next), revisionCount: next - 1, recycledFrom: label };
}

// ─── Per-file revision (public-surfaces PHYS-2, drafting-flow DF-P10) ─────
//
// A printed or downloaded ticket file carries the revision of THAT file, not
// the ticket's live `deliverable_rev`: attachments accumulate across cycles,
// so a Rev 1 Final is still listed after Rev 2 issues, and stamping it with
// the ticket's label made its QR certify a superseded print as current. The
// label is stamped here, server-side (the route runs this function), and a
// client's own `rev` on a file it asks the route to append is never kept.
//
//   a Draft    — its review label when it is submitted (submit_draft: "1A");
//   a Final    — the issued number in force when it joins while the issued
//                file is the current deliverable (PENDING_IFC, FINAL_DRAFT —
//                submit_final's file, or one added there); a Final that joins
//                at any other status is recorded `rev: null` with the cycle
//                it joined in (`revCycle`: revision_count then) and takes the
//                label of the issue that closes THAT cycle (approve_draft_ifc,
//                approve_minor_correction, engineer_approve_final). A cycle
//                that ends in a request for revision, a reject or a reopen
//                bumps revision_count, so a Final from a rejected round is
//                never stamped by a later issue nobody reviewed it under: it
//                keeps `rev: null` and prints "cannot confirm";
//   any other  — `rev: null` (a source or reference file is no deliverable).
//
// A file recorded before this rule has no `rev` key at all and is never
// stamped after the fact: nothing on the row says which cycle it belonged
// to, so it prints "cannot confirm which printing" with no ?r= on its QR.

/** The statuses at which the ticket's issued label names the file being issued. */
const ISSUED_FILE_STATUSES: ReadonlySet<string> = new Set(["PENDING_IFC", "FINAL_DRAFT"]);
const isIssuedRevLabel = (rev: unknown): rev is string => typeof rev === "string" && /^\d+$/.test(rev);

/** The revision a file joining the ticket now is (server truth; `null` when none applies yet). */
export function joiningFileRev(ticket: Pick<Ticket, "status" | "deliverableRev">, file: Pick<TicketAttachment, "type">): string | null {
  if (file.type === "Final" && ISSUED_FILE_STATUSES.has(ticket.status) && isIssuedRevLabel(ticket.deliverableRev)) {
    return ticket.deliverableRev;
  }
  return null;
}

/** The server-decided revision fields of a file joining the ticket now:
 *  `rev` (joiningFileRev) and, for a Final waiting for its issue, the cycle
 *  it joined in. Whatever `rev` / `revCycle` the client sent is replaced. */
export function joiningFileFields(
  ticket: Pick<Ticket, "status" | "deliverableRev" | "revisionCount">,
  file: Pick<TicketAttachment, "type">,
): Pick<TicketAttachment, "rev" | "revCycle"> {
  const rev = joiningFileRev(ticket, file);
  return { rev, revCycle: rev === null && file.type === "Final" ? (ticket.revisionCount ?? 0) : undefined };
}

/** At an issue closing cycle `cycle` (the ticket's revision_count before the
 *  issue): every Final recorded `rev: null` that joined IN that cycle takes
 *  the issued label. A Final from an earlier, rejected round (another
 *  revCycle, or none), a file with a label, or one recorded before per-file
 *  revisions (no key) is left exactly as it is. */
export function stampIssuedFinals(files: TicketAttachment[], label: string, cycle: number): TicketAttachment[] {
  return files.map((a) => (a.type === "Final" && a.rev === null && a.revCycle === cycle ? { ...a, rev: label } : a));
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

  if (input.actionType === "reassign_drafter" && input.assignment) {
    // WF-18: the audit line names the new drafter AND carries the reason.
    historyEntry.details = `Reassigned to ${input.assignment.name}${finalComment ? ` [Reason: ${finalComment}]` : ""}`;
  } else if (input.actionType === "attach_file" && input.attachment) {
    historyEntry.action = "File Uploaded";
    historyEntry.details = `Uploaded ${input.attachment.type} file: ${input.attachment.name}`;
  } else if (input.redlineAttachment && finalComment) {
    historyEntry.details = finalComment;
  } else if (finalComment) {
    historyEntry.details = finalComment;
  } else if (input.assignment) {
    historyEntry.details = `Assigned to ${input.assignment.name}${input.comment ? ` [Reason: ${input.comment}]` : ""}`;
  }

  // SM-6 / ROUTE-1 (DF-P3): a revision with NO drafter to do it goes back to
  // the assignment queue — the state that exists to hold a ticket nobody
  // owns — instead of REVISION_REQ, where nobody's queue showed it. "Return
  // with Questions" from engineering review is the usual case (no drafter has
  // been assigned yet); a ticket whose drafter left (EDGE-4) is the other.
  // An engineering scope review is not a deliverable round, so it does not
  // advance the revision cycle; every other revision does, as before.
  const isRevision = input.actionType === "request_revision" || input.actionType === "reject"
    || input.actionType === "reject_final" || input.actionType === "engineer_request_revision";
  const revisionToQueue = isRevision && !ticket.assignedDrafterId;
  const revisionRound = isRevision && ticket.status !== "PENDING_ENG_TEAM";
  if (revisionRound && input.actionType !== "engineer_request_revision") {
    historyEntry.revisionRound = (ticket.revisionCount || 0) + 1;
  }

  const newHistory = [...(ticket.history || []), historyEntry];
  // notifications PROD-4 done-when 3 (drafting-flow DF-P9): the default
  // audience is everyone with a stake the comment route already tells —
  // requester, drafter AND the assigned engineer (app/api/tickets/comment
  // involved set). An engineer assigned for review used to be told once and
  // then dropped from every later transition until they acted, so the
  // person the ticket was blocked on stopped hearing about it. De-duplicated
  // (one person can hold two parts); the actor is never told of their own act.
  const newUnreadBy = Array.from(new Set([ticket.requesterId, ticket.assignedDrafterId, ticket.assignedEngineerId].filter(
    (id): id is string => !!id && id !== actorUid,
  )));

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
          : input.isReassigning || input.actionType === "reassign_drafter"
            ? "Reassignment"
            : "General",
      category: input.category || null,
      authorUid: actorUid,
    };
    updates.comments = [...(ticket.comments || []), newComment as unknown as TicketComment];
  }

  let currentAttachments = [...(ticket.attachments || [])];
  // PHYS-2: a redline is a reference file, never a deliverable revision.
  if (input.redlineAttachment) currentAttachments = [...currentAttachments, { ...input.redlineAttachment, rev: null, revCycle: undefined }];

  // WF-9: set only by thread ACTIVITY (attach_file) — the people the activity
  // tells, as opposed to the readers a transition resets `unread_by` to.
  let activityRecipients: string[] | null = null;

  // SM-5 / LEAK-7: the issuing actions write a label the history has never
  // issued (issueLabelFor); a re-cycle moves revision_count with it and says
  // so on the issue's own history line.
  const issueRev = () => {
    const issue = issueLabelFor(ticket);
    updates.deliverable_rev = issue.label;
    if (issue.revisionCount !== null) {
      updates.revision_count = issue.revisionCount;
      const note = `Rev ${issue.recycledFrom} was already issued on this ticket — issued as Rev ${issue.label} instead, so no two packages share a label.`;
      historyEntry.details = historyEntry.details ? `${historyEntry.details} [${note}]` : note;
    }
  };

  switch (input.actionType) {
    case "save_progress":
      break;
    // (approve_initial is gone with the NEW / PENDING_ENG_INITIAL stage —
    // DEC-14; approve_team is the only writer of PENDING_ASSIGNMENT.)
    case "attach_file":
      // WF-9: the attachment rides the same compare-and-set write as every
      // transition; the status does not move. It is ACTIVITY, so it ADDS
      // readers and never removes them: the default reset above would have
      // wiped the WF-19 queue pool and the assigned engineer out of
      // `unread_by` (the inbox's "unread activity" list, the portal dot and
      // the badge count all read that column) the moment anyone attached a
      // file. Everyone with a stake is told — requester, drafter, engineer
      // and followers, minus the actor (the comment route's set) — and a
      // reader whose earlier alert is merely outstanding keeps the marker
      // without being re-told.
      // PHYS-2: the file's revision is decided here, never taken from the client.
      if (input.attachment) currentAttachments = [...currentAttachments, { ...input.attachment, ...joiningFileFields(ticket, input.attachment) }];
      activityRecipients = Array.from(
        new Set(
          [ticket.requesterId, ticket.assignedDrafterId, ticket.assignedEngineerId, ...(ticket.watchers ?? [])].filter(
            (id): id is string => !!id && id !== actorUid,
          ),
        ),
      );
      updates.unread_by = Array.from(new Set([...(ticket.unreadBy ?? []), ...activityRecipients])).filter(
        (u) => u !== actorUid,
      );
      break;
    case "cancel_request":
      // DEC-14: a terminal exit off the main flow, with the reason in the
      // comment thread and the history line. LEAK-9 / GAP-107 (DF-P3): and
      // its category, typed, on the row.
      updates.status = "CANCELED";
      updates.outcome = input.outcome ?? defaultOutcome(input.actionType, ticket.status);
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
        // SM-6 (DF-P3): a revision that lost its drafter is re-owned AS a
        // revision; every other assignment starts drafting.
        updates.status = ticket.status === "REVISION_REQ" ? "REVISION_REQ" : "DRAFTING";
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
    case "reassign_drafter":
      // WF-18: the status stays where it is; only the drafter slot changes,
      // and the new assignee is the one told.
      if (input.assignment) {
        updates.assigned_drafter_id = input.assignment.id;
        updates.assigned_drafter_name = input.assignment.name;
        updates.unread_by = [input.assignment.id];
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
      // PHYS-2: a Draft submitted now IS this review label.
      currentAttachments = currentAttachments.map((a) =>
        a.status === "staged"
          ? a.type === "Draft"
            ? { ...a, status: "submitted" as const, rev: updates.deliverable_rev as string }
            : { ...a, status: "submitted" as const }
          : a,
      );
      break;
    }
    case "approve_draft_ifc":
      updates.status = "PENDING_IFC";
      issueRev(); // SM-5: never a label the history already issued
      historyEntry.action = `${input.actionLabel} — issued Rev ${updates.deliverable_rev}`;
      currentAttachments = stampIssuedFinals(currentAttachments, updates.deliverable_rev as string, ticket.revisionCount ?? 0); // PHYS-2
      break;
    // "Fix this typo and it's approved" — the minor-correction fast path.
    // Approves the deliverable NOW (rev letter drops) with the correction
    // noted for the drafter to fold into the issued file; no extra full
    // review cycle for a mislabel or a typo.
    case "approve_minor_correction":
      updates.status = "PENDING_IFC";
      issueRev(); // SM-5: never a label the history already issued
      historyEntry.action = `Approved with minor correction — issued Rev ${updates.deliverable_rev}`;
      currentAttachments = stampIssuedFinals(currentAttachments, updates.deliverable_rev as string, ticket.revisionCount ?? 0); // PHYS-2
      // WF-21 / DEC-15: at the engineer sign-off stage this IS the engineer's
      // approval — stamp it, or the sign-off indicator stays "pending" forever.
      if (ticket.status === "PENDING_FINAL_APPROVAL") updates.engineer_approved_at = now;
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
      issueRev(); // SM-5: never a label the history already issued
      historyEntry.action = `${input.actionLabel} — issued Rev ${updates.deliverable_rev}`;
      currentAttachments = stampIssuedFinals(currentAttachments, updates.deliverable_rev as string, ticket.revisionCount ?? 0); // PHYS-2
      if (ticket.assignedDrafterId) updates.unread_by = [ticket.assignedDrafterId];
      break;
    case "engineer_request_revision":
      updates.status = revisionToQueue ? "PENDING_ASSIGNMENT" : "REVISION_REQ";
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
      updates.status = revisionToQueue ? "PENDING_ASSIGNMENT" : "REVISION_REQ";
      if (revisionRound) {
        updates.revision_count = (ticket.revisionCount || 0) + 1;
        updates.draft_iteration = 0; // next submission starts the new cycle at A
      }
      break;
    case "submit_final":
      updates.status = "FINAL_DRAFT";
      // PHYS-2: the issued package is the label in force (PENDING_IFC), stamped here.
      if (input.finalAttachment) currentAttachments = [...currentAttachments, { ...input.finalAttachment, ...joiningFileFields(ticket, input.finalAttachment) }];
      break;
    case "close_ticket":
    case "close_rfi":
      updates.status = "CLOSED";
      // LEAK-9 / GAP-107 (DF-P3): how it ended — "completed" for the
      // requester's acknowledgement and an answered RFI, nothing recorded for
      // a force close that names none (lib/ticketOutcome.ts defaultOutcome).
      updates.outcome = input.outcome ?? defaultOutcome(input.actionType, ticket.status);
      break;
    case "reopen_ticket":
      // WF-21 / DEC-15: a reopen starts a NEW revision cycle. Without this
      // the next approval re-issued the same label (Rev 2 twice for two
      // different packages) and /api/verify-ticket called the superseded
      // print "current" while the drawing was back under review.
      updates.status = "PENDING_REVIEW";
      updates.revision_count = (ticket.revisionCount || 0) + 1;
      updates.draft_iteration = 0;
      updates.deliverable_rev = null;
      // A reopened request has not ended (LEAK-9).
      updates.outcome = null;
      break;
  }

  // DCW-1 / DCW-7 (DF-P4): triage records the library and the unit with the
  // assignment (or the engineering flag) — on the same compare-and-set write,
  // with a history line of their own naming what changed. Setting the unit
  // retires the intake's "unknown / not on the list / not checked" marks
  // (DEC-101 item 1: "triage assigns").
  if (input.triage && ticket.status === "PENDING_ASSIGNMENT" && updates.status !== undefined
      && (input.actionType === "assign" || input.actionType === "request_eng_review")) {
    const parts: string[] = [];
    const lib = input.triage.library;
    if (lib?.id && lib.id !== (ticket.libraryId ?? null)) {
      updates.library_id = lib.id;
      parts.push(`Library: ${lib.name}${ticket.libraryId ? " (changed)" : ""}`);
    }
    const unit = input.triage.unit?.trim() || null;
    const meta = (ticket.metadata ?? {}) as Record<string, unknown>;
    const marked = meta.unit_unknown === true || meta.unit_unlisted === true || meta.unit_unchecked != null;
    if (unit && (unit !== (ticket.unit ?? null) || marked)) {
      updates.unit = unit;
      const rest = { ...meta };
      delete rest.unit_unknown;
      delete rest.unit_unlisted;
      delete rest.unit_unchecked;
      updates.metadata = rest;
      parts.push(`Unit: ${unit} (was ${ticket.unit ? ticket.unit : "unknown"})`);
    }
    if (parts.length > 0) {
      (updates.history as TicketHistoryEntry[]).push({
        action: "Triage details set",
        user: input.actor.email || "Unknown",
        role: input.actor.role,
        date: now,
        details: parts.join(" · "),
      } as TicketHistoryEntry);
    }
  }

  updates.attachments = currentAttachments;

  // Acting on a ticket makes you a participant, so you follow future activity.
  if (actorUid) updates.watchers = Array.from(new Set([...(ticket.watchers ?? []), actorUid]));

  // Every transition also notifies everyone following the ticket — minus the
  // actor. ROUTE-6 (DF-P3): unconditionally. The union used to run only when
  // the transition already told someone, so a transition whose only personal
  // stakeholder was the actor (a Drafter picking up their own request) told
  // its followers nothing.
  if (Array.isArray(updates.unread_by) && (ticket.watchers ?? []).length > 0) {
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

  const recipients = (activityRecipients ?? (updates.unread_by as string[])).filter((u) => u && u !== actorUid);

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
  const isAssignment = actionType === "assign" || actionType === "self_assign" || actionType === "reassign_drafter";
  const isClosed = actionType === "close_ticket" || actionType === "close_rfi" || actionType === "cancel_request";
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
