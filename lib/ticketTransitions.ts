// lib/ticketTransitions.ts
//
// Pure transition logic for the drafting workflow — extracted verbatim from the
// ticket page's executeWorkflowAction so it can be (a) unit-tested and (b)
// enforced SERVER-SIDE by /api/tickets/workflow-action. The page no longer
// computes updates itself; it sends inputs and the server recomputes them here.
//
// Behavioral contract: identical to the previous client-side computation.
// lib/__tests__/ticketTransitions.test.ts freezes it.

import type { Ticket, TicketAttachment, TicketComment, TicketHistoryEntry, TicketOutcome, TicketReviewRoster, TicketStatus } from "@/types/schema";
import { currentRoster, issueReadyFor, rosterEngineerApprovedAt, ISSUE_MARK_ACTIONS, slotBlocks, slotAlternatesActive } from "@/lib/workflow";
import { lastIssuedFromHistory } from "@/lib/verifyTicketVerdict";
import { defaultOutcome } from "@/lib/ticketOutcome";
import { reviewModelFieldsFromRow, ENGINEERING_OVERRIDE_NOTE, isDeclaredLikeInKind } from "@/lib/reviewModel";
import { consentPlanNote, consentHeldAction, type ConsentHoldReason } from "@/lib/consentWindow";

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
  /** FRIC-5 (DF-P5): `submit_draft` — the drafter marks the draft issue-ready
   *  as they submit it (the last approval issues it as the final package). */
  issueReady?: boolean;
  /** GAP-103 (DF-P5): the roster the route opened for a draft entering
   *  PENDING_REVIEW in a routed library (lib/ticketRoster.ts openRoster). */
  rosterOpen?: TicketReviewRoster | null;
  /** GAP-103 (DF-P5): `sign_slot` — the roster with the actor's slots
   *  satisfied, whether every blocking slot now is, and the slots' labels. */
  rosterSign?: { roster: TicketReviewRoster; complete: boolean; labels: string[] } | null;
  /** SM-3 (DF-P6): the action is a management OVERRIDE of the engineering
   *  sign-off (lib/workflow.ts WorkflowAction.engineeringOverride) — its
   *  history line says so, and it never stamps engineer_approved_at. */
  engineeringOverride?: boolean;
  /** DF-P6 fix pass 4 (review, minor 5): a management issue at
   *  PENDING_FINAL_APPROVAL of a request that does NOT require engineering
   *  review (lib/workflow.ts WorkflowAction.withoutEngineerSignOff) — never
   *  stamps engineer_approved_at, and carries no override marker. */
  withoutEngineerSignOff?: boolean;
  /** GAP-101 / TIER-4 (DF-P6): the work class / code class triage records
   *  with `assign`, `request_eng_review` or `flag_engineering` at
   *  PENDING_ASSIGNMENT — options of the workspace's own lists, checked by
   *  the route. An option marked `engineering` raises the requirement. */
  reviewClass?: {
    workClass?: { value: string; label: string; engineering?: boolean } | null;
    codeClass?: { value: string; label: string; engineering?: boolean } | null;
  } | null;
  /** GAP-111 / DEC-33 (DF-P6): the ticket carries 20261250's columns, so the
   *  transition may write engineering_required (only ever true). False /
   *  absent before the paste: nothing is written for it. */
  reviewModelColumns?: boolean;
  /** DF-P6 fix pass 2 (review, minor 7): this request_eng_review is the
   *  request type's MANDATORY engineering-first loop (DRAFT-2 — the type
   *  cannot be assigned without it). On a declared like-in-kind request it
   *  does not raise engineering_required: the loop is the type's, not a
   *  finding that the work is engineered (DEC-90 ruling (8) — no added wait
   *  for a declared request). Set by the route. */
  engineeringFirstLoop?: boolean;
  /** HAND-7 done-when 3 (DF-P6): an issuing approval over a moved source —
   *  the moved documents as a person reads them, and whether the approver
   *  acknowledged it (null: the page did not ask — recorded as such). */
  sourceDrift?: { labels: string[]; acknowledged: boolean | null } | null;
  /** GAP-109 (DF-P7): `object_consent_window` — one of the people asked
   *  stops the running window (the route offered it through the engine). */
  consentObjection?: boolean;
  /** GAP-109 (DF-P7): `consent_window_advance` — the maintenance cron's
   *  recorded system act when a window closes with no objection
   *  (lib/consentWindowScan.ts): the roster with the window's slot satisfied
   *  via "consent", whether every blocking slot now is, the slot's label and
   *  the DEC-39 history details naming everyone asked. `held`: the window
   *  closed but did not advance — the slot stays open, waiting for a
   *  sign-off — for `holdReason` (no delivery record, the producer floor,
   *  a moved or unreadable source, a ledger that disagrees), which words the
   *  history headline (lib/consentWindow.ts consentHeldAction). */
  consentAdvance?: { roster: TicketReviewRoster; complete: boolean; label: string; details: string; held?: boolean; holdReason?: ConsentHoldReason | null } | null;
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
    // GAP-110 / GAP-111 / GAP-101 (DF-P6, 20261250): undefined while the
    // columns are not in the database (the engine's seed then decides) —
    // the one mapper every Ticket builder shares (lib/reviewModel.ts).
    ...reviewModelFieldsFromRow(row),
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

/** FRIC-5 (DF-P5): the Final(s) an issue-as-is approval records — each
 *  Draft of the revision under review, as the issued package (same bytes,
 *  same storage key, a new id, the issued label). null when no Draft carries
 *  that revision (a file from before per-file revisions): the approval then
 *  returns the request to the drafter, as before. */
export function issueAsIsFinals(ticket: Pick<Ticket, "attachments" | "deliverableRev">, label: string, now: string): TicketAttachment[] | null {
  const under = ticket.deliverableRev;
  if (!under) return null;
  const drafts = (ticket.attachments ?? []).filter((a) => a?.type === "Draft" && a.rev === under && a.status !== "staged");
  if (drafts.length === 0) return null;
  return drafts.map((d) => ({
    ...d, id: crypto.randomUUID(), type: "Final" as const, status: "submitted" as const, rev: label,
    revCycle: undefined, issuedFromDraftId: d.id, uploadedAt: now,
  }));
}

/** TIER-5 / FRIC-2 (DF-P5 fix pass 4): after a PARTIAL sign-off, who the
 *  ticket no longer waits on — the occupants of every slot now satisfied,
 *  less anyone an open blocking slot still waits on, less today's
 *  participants (requester, drafter, assigned engineer) and the signer.
 *  Fix pass 5: an open blocking slot whose alternate window has opened
 *  (lib/workflow.ts slotAlternatesActive — slotSignPlan's own rule) still
 *  waits on its alternates too, so they are kept.
 *  They leave `unread_by`, and the route retires their action alerts. */
export function rosterPartialReleased(
  roster: Pick<TicketReviewRoster, "slots" | "openedAt">,
  ticket: Pick<Ticket, "requesterId" | "assignedDrafterId" | "assignedEngineerId">,
  actorUid: string | null | undefined,
  now: number = Date.now(),
): string[] {
  const keep = new Set<string>([
    ...roster.slots.filter((x) => slotBlocks(x) && x.status === "open")
      .flatMap((x) => [...x.primaries, ...(slotAlternatesActive(roster, x, now) ? x.alternates : [])]),
    ...[ticket.requesterId, ticket.assignedDrafterId, ticket.assignedEngineerId, actorUid].filter((u): u is string => !!u),
  ]);
  return Array.from(new Set(roster.slots.filter((x) => x.status === "satisfied").flatMap((x) => x.primaries))).filter((u) => !!u && !keep.has(u));
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

  // FRIC-5 (DF-P5): an approval of a draft its drafter marked issue-ready
  // issues it as the final package — FINAL_DRAFT, the Draft recorded as the
  // Final — instead of returning the request for a second upload. Without
  // the mark (the default) nothing here runs.
  const asIsIssue = () => {
    if (!issueReadyFor(ticket)) return;
    const finals = issueAsIsFinals(ticket, updates.deliverable_rev as string, now);
    const meta = { ...(((updates.metadata as Record<string, unknown> | undefined) ?? ticket.metadata ?? {}) as Record<string, unknown>) };
    delete meta.issue_ready;
    updates.metadata = meta;
    if (!finals) {
      historyEntry.details = `${historyEntry.details ? `${historyEntry.details} ` : ""}[Marked issue-ready, but no draft carries Rev ${ticket.deliverableRev} — the drafter issues the final package]`;
      return;
    }
    updates.status = "FINAL_DRAFT";
    currentAttachments = [...currentAttachments, ...finals];
    historyEntry.action = `${historyEntry.action} — issued as-is (the approved draft is the final package)`;
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
        // GAP-111 / DEC-33 (DF-P6): flagging for engineering BINDS the issue
        // point — the requirement is set, for good (approve_team below
        // leaves it; the database refuses the way back). Fix pass 2 (minor
        // 7): not the engineering-first type's mandatory loop on a declared
        // request — that review is the type's, and adds no wait at issue.
        // Fix pass 3 (review, major): and only on a request FILED under the
        // review model (review_model_filed true) — a pre-paste row's scope
        // review behaves exactly as it does today (DEC-90 ruling (2)), never
        // moving an in-flight ticket's lane; flag_engineering stays the
        // explicit way to bind a legacy row.
        if (input.reviewModelColumns && ticket.reviewModelFiled === true
          && !(input.engineeringFirstLoop && ticket.engineeringRequired === false && isDeclaredLikeInKind(ticket))) {
          updates.engineering_required = true;
        }
      }
      break;
    case "flag_engineering":
      // GAP-111 (DF-P6): the assigner's late flag — no status change, no
      // restart; the deliverable now issues only with an engineer's
      // sign-off. Its reason is the history line's details (the comment).
      if (input.reviewModelColumns) updates.engineering_required = true;
      historyEntry.action = "Engineering sign-off required — flagged";
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
      // FRIC-5 (DF-P5): the issue-as-is mark is bound to the label it was
      // made on — set for this submission when asked, and an earlier mark
      // is cleared by any new submission. Nothing is written otherwise.
      {
        const meta = (ticket.metadata ?? {}) as Record<string, unknown>;
        if (input.issueReady) {
          updates.metadata = { ...meta, issue_ready: { rev: updates.deliverable_rev, by: actorUid ?? null, at: now } };
          historyEntry.details = `${historyEntry.details ? `${historyEntry.details} ` : ""}[Issue as-is when approved]`;
        } else if (Object.prototype.hasOwnProperty.call(meta, "issue_ready")) {
          const rest = { ...meta };
          delete rest.issue_ready;
          updates.metadata = rest;
        }
      }
      break;
    }
    case "mark_issue_ready":
      // FRIC-5 (DF-P5): the drafter's opt-in on the draft under review.
      updates.metadata = { ...((ticket.metadata ?? {}) as Record<string, unknown>), issue_ready: { rev: ticket.deliverableRev ?? null, by: actorUid ?? null, at: now } };
      historyEntry.action = `Marked issue-ready — Rev ${ticket.deliverableRev ?? "—"} is issued as the final package when approved`;
      // UI-4 / DF-P5 fix pass 2: not a status change — only the reviewers
      // whose approval the mark changes are told (issueMarkAudience); every
      // existing unread marker is kept, nobody else is added.
      activityRecipients = issueMarkAudience(ticket).filter((u) => u !== actorUid);
      updates.unread_by = Array.from(new Set([...(ticket.unreadBy ?? []), ...activityRecipients])).filter((u) => u !== actorUid);
      break;
    case "clear_issue_ready": {
      const rest = { ...((ticket.metadata ?? {}) as Record<string, unknown>) };
      delete rest.issue_ready;
      updates.metadata = rest;
      historyEntry.action = "Issue-as-is withdrawn — the approval returns the request to the drafter";
      activityRecipients = issueMarkAudience(ticket).filter((u) => u !== actorUid);
      updates.unread_by = Array.from(new Set([...(ticket.unreadBy ?? []), ...activityRecipients])).filter((u) => u !== actorUid);
      break;
    }
    case "sign_slot":
      // GAP-103 (DF-P5): the actor's slots are satisfied on the roster the
      // ticket carries; the last blocking slot issues the ticket exactly as
      // a direct approval does (and as-is when the drafter marked it).
      if (input.rosterSign) {
        const { roster, complete, labels } = input.rosterSign;
        updates.metadata = { ...((ticket.metadata ?? {}) as Record<string, unknown>), review_roster: complete ? { ...roster, closedAt: now, closedReason: "complete" } : roster };
        historyEntry.action = `Signed off — ${labels.join(", ")}${ticket.deliverableRev ? ` (Rev ${ticket.deliverableRev})` : ""}`;
        if (complete) {
          updates.status = "PENDING_IFC";
          // The engineering slot's sign-off is the ticket's engineering
          // approval, as engineer_approve_final records it on the serial path.
          const engAt = rosterEngineerApprovedAt(roster);
          if (engAt) updates.engineer_approved_at = engAt;
          issueRev();
          historyEntry.action = `${historyEntry.action} — every sign-off is in; issued Rev ${updates.deliverable_rev}`;
          currentAttachments = stampIssuedFinals(currentAttachments, updates.deliverable_rev as string, ticket.revisionCount ?? 0); // PHYS-2
          asIsIssue();
        } else {
          // TIER-5 / FRIC-2 (DF-P5 fix pass 3): a PARTIAL sign-off is not a
          // hand-off — the ticket still waits on every open blocking slot,
          // so their occupants keep their unread marker (and are told of the
          // sign-off), as do the existing markers and today's participants.
          // The route keeps their "review opened" alerts (no supersede).
          // DF-P5 fix pass 4: the co-occupants of a slot now SATISFIED are
          // waited on no more — they leave unread_by (rosterPartialReleased),
          // and the route retires their action alerts with the signer's.
          const waiting = roster.slots.filter((x) => slotBlocks(x) && x.status === "open").flatMap((x) => x.primaries);
          const released = new Set(rosterPartialReleased(roster, ticket, actorUid, Date.parse(now)));
          updates.unread_by = Array.from(new Set([...(ticket.unreadBy ?? []).filter((u) => !released.has(u)), ...newUnreadBy, ...waiting])).filter((u) => !!u && u !== actorUid);
        }
      }
      break;
    case "object_consent_window": {
      // GAP-109 (DF-P7): an objection stops the window for good — the slot
      // waits for a sign-off, the objector's reason is the history line's
      // details, and the stop is stamped on the ticket (workflow-owned
      // columns, 20261255) and on the roster's mirror together.
      const open = currentRoster(ticket);
      const w = open?.consentWindow;
      if (input.consentObjection && open && w) {
        const label = open.slots.find((x) => x.kind === w.slot)?.label || w.slot;
        const meta = ((updates.metadata as Record<string, unknown> | undefined) ?? ticket.metadata ?? {}) as Record<string, unknown>;
        updates.metadata = { ...meta, review_roster: { ...open, consentWindow: { ...w, objectedAt: now, objectedBy: actorUid ?? null } } };
        updates.consent_window_objected_at = now;
        updates.consent_window_objected_by = actorUid ?? null;
        historyEntry.action = `Objected — "${label}" will not advance without objection; it waits for a sign-off`;
        // Fix pass 2: an objection is not a hand-off — the request still
        // waits on every open blocking slot, the window's own included (its
        // occupants' sign-off is now required), so their unread markers stay
        // and they are told (recipients follow unread_by), as a partial
        // sign-off and the consent advance keep them.
        const waiting = open.slots.filter((x) => slotBlocks(x) && x.status === "open").flatMap((x) => x.primaries);
        updates.unread_by = Array.from(new Set([...(ticket.unreadBy ?? []), ...newUnreadBy, ...waiting])).filter((u) => !!u && u !== actorUid);
      }
      break;
    }
    case "consent_window_advance":
      // GAP-109 / DEC-39 (DF-P7): the window closed with no objection — a
      // recorded SYSTEM act, written by the maintenance cron (no person
      // signed). The history names everyone asked, when, whether each opened
      // the notice, when they were reminded and when the window closed. The
      // last blocking slot issues the ticket through the same issue limb a
      // sign-off uses (the cron adds the routed pool and the intent clearing;
      // the copy recall and the email are recorded residuals).
      if (input.consentAdvance) {
        const { roster, complete, label, details, held, holdReason } = input.consentAdvance;
        const w = roster.consentWindow ? { ...roster.consentWindow, expiredAt: now, ...(held ? { heldReason: holdReason ?? null } : {}) } : null;
        const next = { ...roster, consentWindow: w };
        updates.metadata = { ...((ticket.metadata ?? {}) as Record<string, unknown>), review_roster: complete ? { ...next, closedAt: now, closedReason: "complete" } : next };
        updates.consent_window_expired_at = now;
        historyEntry.details = details;
        if (held) {
          historyEntry.action = consentHeldAction(label, holdReason);
        } else {
          historyEntry.action = `Advanced without objection — ${label}${ticket.deliverableRev ? ` (Rev ${ticket.deliverableRev})` : ""}`;
        }
        if (complete && !held) {
          updates.status = "PENDING_IFC";
          const engAt = rosterEngineerApprovedAt(roster);
          if (engAt) updates.engineer_approved_at = engAt;
          issueRev();
          historyEntry.action = `${historyEntry.action} — every sign-off is in; issued Rev ${updates.deliverable_rev}`;
          currentAttachments = stampIssuedFinals(currentAttachments, updates.deliverable_rev as string, ticket.revisionCount ?? 0); // PHYS-2
          asIsIssue();
        } else {
          const waiting = roster.slots.filter((x) => slotBlocks(x) && x.status === "open").flatMap((x) => x.primaries);
          updates.unread_by = Array.from(new Set([...(ticket.unreadBy ?? []), ...newUnreadBy, ...waiting])).filter((u) => !!u && u !== actorUid);
        }
      }
      break;
    case "approve_draft_ifc":
      updates.status = "PENDING_IFC";
      issueRev(); // SM-5: never a label the history already issued
      historyEntry.action = `${input.actionLabel} — issued Rev ${updates.deliverable_rev}`;
      currentAttachments = stampIssuedFinals(currentAttachments, updates.deliverable_rev as string, ticket.revisionCount ?? 0); // PHYS-2
      asIsIssue(); // FRIC-5: only when the drafter marked it
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
      // SM-3 (DF-P6): never for a management override — an engineering
      // sign-off nobody with an Engineer role gave is not stamped.
      // Fix pass 4 (review, minor 5): nor for a management issue of a
      // request that does not require one (withoutEngineerSignOff).
      if (ticket.status === "PENDING_FINAL_APPROVAL" && !input.engineeringOverride && !input.withoutEngineerSignOff) updates.engineer_approved_at = now;
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
      asIsIssue(); // FRIC-5: only when the drafter marked it
      if (updates.status === "FINAL_DRAFT" && ticket.requesterId && ticket.requesterId !== actorUid) {
        // The issued package now waits on the requester's acknowledgement.
        updates.unread_by = Array.from(new Set([...(updates.unread_by as string[]), ticket.requesterId]));
      }
      break;
    case "override_engineer_final":
      // SM-3 (DF-P6, DEC-90 ruling (3)): management issues without the
      // engineer's sign-off — engineer_approve_final's effect WITHOUT
      // engineer_approved_at; the history line names it an override (only
      // when the engine marked it one — fix pass 4, review minor 5: on a
      // request that does not require engineering it is a neutral issue).
      updates.status = "PENDING_IFC";
      issueRev(); // SM-5: never a label the history already issued
      historyEntry.action = `${input.actionLabel} — issued Rev ${updates.deliverable_rev}`;
      currentAttachments = stampIssuedFinals(currentAttachments, updates.deliverable_rev as string, ticket.revisionCount ?? 0); // PHYS-2
      if (ticket.assignedDrafterId) updates.unread_by = [ticket.assignedDrafterId];
      asIsIssue(); // FRIC-5: only when the drafter marked it
      if (updates.status === "FINAL_DRAFT" && ticket.requesterId && ticket.requesterId !== actorUid) {
        updates.unread_by = Array.from(new Set([...(updates.unread_by as string[]), ticket.requesterId]));
      }
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

  // SM-3 (DF-P6): an override of the engineering sign-off says so on its own
  // history line — the line every reader of the ticket sees.
  if (input.engineeringOverride && updates.status !== undefined && updates.status !== ticket.status) {
    const note = ENGINEERING_OVERRIDE_NOTE;
    historyEntry.details = historyEntry.details ? `${historyEntry.details} [${note}]` : note;
    // DF-P6 fix pass (review, issue 7): the request carries the override, so
    // the engineer card and the seeded roster say "issued by management
    // override — no engineer sign-off" instead of a sign-off still pending
    // (lib/reviewModel.ts engineeringOverrideOf).
    const meta = ((updates.metadata as Record<string, unknown> | undefined) ?? ticket.metadata ?? {}) as Record<string, unknown>;
    updates.metadata = { ...meta, engineering_override: { by: input.actor.email || actorUid || null, uid: actorUid ?? null, at: now, action: input.actionType } };
    // DF-P6 fix pass 5 (review, minor): a standing "not required" mark from
    // an earlier cycle is no longer the latest word.
    if (meta.engineering_sign_off !== undefined && meta.engineering_sign_off !== null) {
      (updates.metadata as Record<string, unknown>).engineering_sign_off = null;
    }
  } else if (
    (updates.status === "PENDING_IFC" || (updates.status === "FINAL_DRAFT" && ticket.status !== "PENDING_IFC"))
    && ticket.status !== updates.status
  ) {
    // The DF-P6 merge (the integrator, review minor): an issue lands in
    // PENDING_IFC, or straight in FINAL_DRAFT when the drafter marked it
    // issue-as-is (asIsIssue) — both are issues; the drafter's own
    // PENDING_IFC → FINAL_DRAFT submission is not, so it keeps every mark.
    // DF-P6 fix pass 2 (review, minor 6): an issue that was NOT an override
    // (a later cycle approved by its requester or signed by an engineer)
    // clears a standing override marker — null, so neither the card nor the
    // seeded roster reads the old override (nor its history line) as the
    // latest word.
    const meta = ((updates.metadata as Record<string, unknown> | undefined) ?? ticket.metadata ?? {}) as Record<string, unknown>;
    const standing = meta.engineering_override !== undefined
      ? meta.engineering_override !== null
      : (ticket.history ?? []).some((h) => typeof (h as { details?: unknown }).details === "string" && String((h as { details?: unknown }).details).includes(ENGINEERING_OVERRIDE_NOTE));
    if (standing) {
      updates.metadata = { ...meta, engineering_override: null };
    }
    // DF-P6 fix pass 5 (review, minor): a management issue at final approval
    // of a request that does NOT require engineering (withoutEngineerSignOff)
    // stamps no engineer_approved_at and is no override — so the request
    // says why no sign-off is shown: the engineer card and the seeded roster
    // read "not required" (lib/reviewModel.ts engineeringSignOffNotRequiredOf)
    // instead of a sign-off still pending. Any other issue clears a mark an
    // earlier cycle left.
    const metaNow = ((updates.metadata as Record<string, unknown> | undefined) ?? ticket.metadata ?? {}) as Record<string, unknown>;
    if (input.withoutEngineerSignOff && ticket.status === "PENDING_FINAL_APPROVAL") {
      updates.metadata = { ...metaNow, engineering_sign_off: { notRequired: true, by: input.actor.email || actorUid || null, uid: actorUid ?? null, at: now, action: input.actionType } };
    } else if (metaNow.engineering_sign_off !== undefined && metaNow.engineering_sign_off !== null) {
      updates.metadata = { ...metaNow, engineering_sign_off: null };
    }
  }
  // HAND-7 done-when 3 (DF-P6): an approval over a moved source names what
  // moved and whether the approver acknowledged it.
  if (input.sourceDrift && input.sourceDrift.labels.length > 0) {
    const what = input.sourceDrift.labels.join("; ");
    const note = input.sourceDrift.acknowledged === true
      ? `Approved over a moved source, acknowledged by the approver: ${what}`
      : `Approved over a moved source, not acknowledged (the page did not ask): ${what}`;
    historyEntry.details = historyEntry.details ? `${historyEntry.details} [${note}]` : note;
  }

  // GAP-103 (DF-P5): a draft entering PENDING_REVIEW in a routed library
  // carries the roster the route opened (one parallel wait); everyone the
  // roster names — the occupants of every slot, notify-only slots included —
  // is told. Leaving PENDING_REVIEW any other way (a revision, a cancel, a
  // force close) closes the roster: its open slots are void.
  if (input.rosterOpen && updates.status === "PENDING_REVIEW") {
    const r = input.rosterOpen;
    const meta = ((updates.metadata as Record<string, unknown> | undefined) ?? ticket.metadata ?? {}) as Record<string, unknown>;
    updates.metadata = { ...meta, review_roster: r };
    const blocking = r.slots.filter((x) => x.mode !== "notify_only").map((x) => x.label || x.kind);
    const told = r.slots.filter((x) => x.mode === "notify_only").map((x) => x.label || x.kind);
    newHistory.push({
      action: "Review roster opened",
      user: input.actor.email || "Unknown",
      role: input.actor.role,
      date: now,
      details: `Sign-offs needed (any order): ${blocking.join(", ")}${told.length ? ` · Told: ${told.join(", ")}` : ""}${r.engineeringGateAdded ? " · Engineering sign-off added: this workspace requires an engineer for this request, and the routing table names none" : ""}${r.consentPlan ? ` · ${consentPlanNote(r.consentPlan)}` : ""}`,
    } as TicketHistoryEntry);
    const named = r.slots.flatMap((x) => x.primaries);
    updates.unread_by = Array.from(new Set([...((updates.unread_by as string[] | undefined) ?? []), ...named])).filter((u) => u && u !== actorUid);
  } else {
    const open = currentRoster(ticket);
    if (open && updates.status !== undefined && updates.status !== "PENDING_REVIEW" && input.actionType !== "sign_slot" && input.actionType !== "consent_window_advance") {
      const meta = ((updates.metadata as Record<string, unknown> | undefined) ?? ticket.metadata ?? {}) as Record<string, unknown>;
      updates.metadata = {
        ...meta,
        review_roster: {
          ...open,
          closedAt: now,
          closedReason: input.actionType,
          slots: open.slots.map((x) => (x.status === "open" ? { ...x, status: "void" as const } : x)),
        },
      };
    }
  }

  // DCW-1 / DCW-7 (DF-P4): triage records the library and the unit with the
  // assignment (or the engineering flag) — on the same compare-and-set write,
  // with a history line of their own naming what changed. Setting the unit
  // retires the intake's "unknown / not on the list / not checked" marks
  // (DEC-101 item 1: "triage assigns").
  // GAP-101 / TIER-4 (DF-P6): triage records the work class and the code
  // class — at the assignment queue, with the assignment, the engineering
  // review flag or the binding flag, on the same compare-and-set write. A
  // class the workspace marked `engineering` raises the requirement (never
  // lowers it). Each change is named on a history line of its own.
  if (input.reviewClass && input.reviewModelColumns && ticket.status === "PENDING_ASSIGNMENT"
      && (input.actionType === "assign" || input.actionType === "request_eng_review" || input.actionType === "flag_engineering")
      && (input.actionType === "flag_engineering" || updates.status !== undefined)) {
    const parts: string[] = [];
    const wc = input.reviewClass.workClass;
    const cc = input.reviewClass.codeClass;
    if (wc && wc.value !== (ticket.workClass ?? null)) { updates.work_class = wc.value; parts.push(`Work class: ${wc.label}`); }
    if (cc && cc.value !== (ticket.codeClass ?? null)) { updates.code_class = cc.value; parts.push(`Code class: ${cc.label}`); }
    if ((wc?.engineering || cc?.engineering) && ticket.engineeringRequired !== true) {
      updates.engineering_required = true;
      parts.push(`Engineering sign-off required by the ${wc?.engineering ? "work" : "code"} class`);
    }
    if (parts.length > 0) {
      (updates.history as TicketHistoryEntry[]).push({
        action: "Review class set",
        user: input.actor.email || "Unknown",
        role: input.actor.role,
        date: now,
        details: parts.join(" · "),
      } as TicketHistoryEntry);
    }
  }

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
  // (The issue-as-is mark / withdrawal is not a transition: its readers are
  // the current reviewers only — issueMarkAudience.)
  if (Array.isArray(updates.unread_by) && (ticket.watchers ?? []).length > 0 && !ISSUE_MARK_ACTIONS.has(input.actionType)) {
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

/**
 * UI-4 / FRIC-5 (DF-P5 fix pass 2): who hears that the drafter marked (or
 * withdrew) issue-as-is — the people whose approval it changes, and nobody
 * else: on a routed review, the occupants of every still-open blocking slot;
 * on the serial path, the requester in PENDING_REVIEW and the assigned
 * engineer in PENDING_FINAL_APPROVAL. Never the watchers, never an email
 * (the route sends a bell row only). Pure.
 */
export function issueMarkAudience(ticket: Pick<Ticket, "status" | "metadata" | "requesterId" | "assignedEngineerId">): string[] {
  const roster = currentRoster(ticket);
  const ids = roster
    ? roster.slots.filter((s) => slotBlocks(s) && s.status === "open").flatMap((s) => s.primaries)
    : ticket.status === "PENDING_REVIEW"
      ? [ticket.requesterId]
      : ticket.status === "PENDING_FINAL_APPROVAL"
        ? [ticket.assignedEngineerId]
        : [];
  return Array.from(new Set(ids.filter((u): u is string => typeof u === "string" && u.length > 0)));
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
  /** DF-P5 fix pass 2: the sign-off that COMPLETED a review roster (the
   *  ticket issued) — an approval, notified as one. */
  rosterCompleted?: boolean;
}): TransitionNotification {
  const { actionType, actionLabel, ticketLabel } = params;
  const rosterApproval = actionType === "sign_slot" && params.rosterCompleted === true;
  const isEngineerAction =
    actionType === "request_final_engineer_approval" ||
    actionType === "request_eng_review" ||
    actionType === "reassign_engineer";
  const isAssignment = actionType === "assign" || actionType === "self_assign" || actionType === "reassign_drafter";
  const isClosed = actionType === "close_ticket" || actionType === "close_rfi" || actionType === "cancel_request";
  const isApproved =
    actionType === "approve_draft_ifc" ||
    actionType === "engineer_approve_final" ||
    actionType === "override_engineer_final" ||
    actionType === "approve_minor_correction" ||
    rosterApproval;
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

  // A completing sign-off is named for what it did — every sign-off is in
  // and the request is approved — not for the last signer's slot.
  const label = rosterApproval ? "Review complete — approved" : actionLabel;
  const emailSubject = isEngineerAction
    ? `Engineer review requested: ${ticketLabel}`
    : isAssignment
      ? `You were assigned to ${ticketLabel}`
      : `${label} — ${ticketLabel}`;

  const inAppKind = isAssignment ? ("ticket_assigned" as const) : ("ticket_status" as const);
  const inAppTitle = isAssignment ? `You were assigned · ${ticketLabel}` : `${label} · ${ticketLabel}`;

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
