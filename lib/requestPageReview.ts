// lib/requestPageReview.ts
//
// drafting-flow Round G, DF-P18 REVIEW-MODEL REQUEST-PAGE FOLLOW-UPS — the
// pure rules behind what the request page (app/(protected)/requests/[id])
// newly shows, so each is pinned by a test and every one of them answers
// "today's screen" for an unconfigured workspace (DEC-90 ruling (1) for
// DF-P18):
//   * the triage class selects (TIER-2 dw2, TIER-4 dw1/dw3, GAP-101) —
//     only at PENDING_ASSIGNMENT, only once 20261250 is pasted, only for a
//     list the workspace configured;
//   * the source-drift labels the page passes into getActions (HAND-7 dw3);
//   * the at-submit "issue as-is when approved" choice (FRIC-5) — only for
//     the person the ticket's own toggle is offered to, default off;
//   * a consent window that was not opened, said on the page and in the
//     history from the notice record DF-P7 already writes (GAP-113
//     acceptance 1).

import type { Ticket, TicketReviewRoster, TicketStatus } from "@/types/schema";
import { hasReviewModelColumns, type ReviewClassEntry } from "@/lib/reviewModel";
import type { SourceDrift } from "@/components/requests/SourceDriftBanner";
import { CONSENT_REASON, recordMoment } from "@/lib/consentWindow";

// ── The class at triage (TIER-2 dw2, TIER-4 dw1 / dw3, GAP-101) ──────────

/** Which class selects the triage dialog shows — none at all for an
 *  unconfigured workspace, a request outside triage, or a request the
 *  20261250 columns cannot speak for (before the paste the route would only
 *  say the class was not recorded). */
export function triageClassSelects(
  ticket: Pick<Ticket, "status" | "engineeringRequired">,
  workOptions: readonly ReviewClassEntry[],
  codeOptions: readonly ReviewClassEntry[],
): { work: boolean; code: boolean } {
  if (ticket.status !== ("PENDING_ASSIGNMENT" as TicketStatus) || !hasReviewModelColumns(ticket)) return { work: false, code: false };
  return { work: workOptions.length > 0, code: codeOptions.length > 0 };
}

/** What the triage action sends: only a class picked (an empty choice is "no
 *  change" — triage never clears a class, and a class the list no longer
 *  names is never sent back). */
export function classTriagePayload(
  choice: { workClass?: string | null; codeClass?: string | null },
  offered: { work: boolean; code: boolean },
): { workClass?: string; codeClass?: string } {
  const out: { workClass?: string; codeClass?: string } = {};
  const w = typeof choice.workClass === "string" ? choice.workClass.trim() : "";
  const c = typeof choice.codeClass === "string" ? choice.codeClass.trim() : "";
  if (offered.work && w) out.workClass = w;
  if (offered.code && c) out.codeClass = c;
  return out;
}

// ── The moved source (HAND-7 dw3) ────────────────────────────────────────

/** The drift labels getActions reads (WorkflowContext.sourceDrift), in the
 *  words the workflow route uses for the same move. */
export function sourceDriftLabels(drifts: readonly SourceDrift[]): string[] {
  return drifts.map(({ ref, currentRev }) => `${ref.documentNumber || ref.title || "a source document"}${ref.rev ? ` raised on Rev ${ref.rev}` : ""}, now Rev ${currentRev ?? "—"}`);
}

/** The confirmation an approval over a moved source asks for (the page's
 *  dialog; the route refuses the approval without the acknowledgement). */
export function sourceDriftConfirmation(labels: readonly string[]): string {
  return `The source revision has moved since this request was raised (${labels.join("; ")}). The draft may have been made over a superseded revision. Approve anyway? Your acknowledgement is recorded in the request's history and audit trail.`;
}

/** DF-P18 fix pass (review, blocker): the moved sources a workflow-route
 *  refusal names (409 `source_drift_unacknowledged`, its `moved` labels) —
 *  the route read them as the service role, so the page and the roster
 *  panel ask from these even when their own RLS-limited read of the source
 *  documents found nothing (an approver under a document ACL, a read still
 *  in flight or failed). null for any other body; a refusal without labels
 *  still asks, naming "a source document". */
export function sourceDriftRefusalLabels(body: unknown): string[] | null {
  const j = (body && typeof body === "object" ? body : {}) as { code?: unknown; moved?: unknown };
  if (j.code !== "source_drift_unacknowledged") return null;
  const moved = Array.isArray(j.moved) ? j.moved.filter((x): x is string => typeof x === "string" && !!x.trim()).slice(0, 20) : [];
  return moved.length ? moved : ["a source document"];
}

// ── Issue as-is at submit (FRIC-5) ───────────────────────────────────────

/** Is the at-submit "issue as-is when approved" choice offered to this
 *  viewer? Exactly where the ticket's own toggle (mark_issue_ready) is
 *  offered — the request's assigned drafter — and only beside a Submit the
 *  engine offers them. Default off; nothing is sent unless it is ticked. */
export function issueReadyAtSubmitOffered(
  ticket: Pick<Ticket, "assignedDrafterId">,
  uid: string | null | undefined,
  actions: ReadonlyArray<{ action: string; disabledReason?: string }>,
): boolean {
  if (!uid || ticket.assignedDrafterId !== uid) return false;
  return actions.some((a) => a.action === "submit_draft" && !a.disabledReason);
}

// ── A consent window that was not opened (GAP-113 acceptance 1) ──────────

/** One `blocked` row of the request's notice record (ticket_notice_events,
 *  20261255), as the page reads it. */
export interface ConsentBlockRow {
  created_at: string;
  /** The roster the row was written for (every DF-P7 writer sets it). */
  roster_id?: string | null;
  slot_kind: string | null;
  actor_name?: string | null;
  details: Record<string, unknown> | null;
}

/** Why the consent window was not opened (or did not advance), in words,
 *  from what DF-P7 recorded — never more than the row says. */
export function consentBlockReason(row: ConsentBlockRow, slotLabel?: string | null): string {
  const d = row.details ?? {};
  const label = `"${slotLabel || row.slot_kind || "The consent slot"}"`;
  const reason = typeof d.reason === "string" ? d.reason : "";
  const err = typeof d.error === "string" && d.error.trim() ? ` (${d.error.trim().slice(0, 200)})` : "";
  if (reason === "window_not_opened") {
    return `${label}: the consent window could not be opened — the people it asks could not all be told${err}. Nothing advances on silence; it waits for a sign-off${d.retriedByMaintenance === true ? " and is tried again at the next maintenance run" : ""}.`;
  }
  if (reason === "window_never_opened") {
    const why = typeof d.why === "string" && d.why.trim() ? d.why.trim() : CONSENT_REASON.noLongerAskable;
    return `${label}: the planned consent window was never opened — ${why}.`;
  }
  if (reason === "no_longer_member") {
    return `${label}: the window closed, but nobody who could object is still a member — it waits for a sign-off.`;
  }
  if (reason) return `${label}: no consent window was opened — ${reason}.`;
  return `${label}: no consent window was opened — it waits for a sign-off.`;
}

/** DF-P18 fix pass (review, major): was the consent window on this slot
 *  opened after all — the plan marked `opened` (the maintenance run's retry
 *  landed, DEC-90 ruling (4) DF-P7) or the roster carrying its window mark?
 *  (pure) */
export function consentWindowOpenedFor(
  roster: Pick<TicketReviewRoster, "consentPlan" | "consentWindow"> | null | undefined,
  slot: string | null,
): boolean {
  if (!roster) return false;
  const plan = roster.consentPlan;
  if (plan && plan.kind === "opened" && (slot === null || plan.slot === slot)) return true;
  const w = roster.consentWindow;
  return !!w && (slot === null || w.slot === slot);
}

/** DF-P18 fix pass 2 (review, major): why a recorded block no longer holds,
 *  or null while it still does — the failed open the maintenance run later
 *  opened (`opened_later`), the consent slot since signed (`signed`: its
 *  status `satisfied`), or the review itself over (`closed`: the roster
 *  closed, or the request is no longer in review — `ticketStatus` given and
 *  not `PENDING_REVIEW`, where lib/workflow.ts currentRoster stops reading
 *  it). Each block says "it waits for a sign-off" or that the window did not
 *  run; none of that is true after any of these. (pure) */
export type ConsentBlockSuperseded = "opened_later" | "signed" | "closed";
export function consentBlockSupersededBy(
  row: Pick<ConsentBlockRow, "slot_kind" | "details">,
  roster: Pick<TicketReviewRoster, "consentPlan" | "consentWindow" | "slots" | "closedAt"> | null | undefined,
  ticketStatus?: string | null,
): ConsentBlockSuperseded | null {
  if (row.details?.reason === "window_not_opened" && consentWindowOpenedFor(roster, row.slot_kind)) return "opened_later";
  const slot = roster && Array.isArray(roster.slots) && row.slot_kind ? roster.slots.find((s) => s.kind === row.slot_kind) : undefined;
  if (slot && slot.status === "satisfied") return "signed";
  if ((roster && roster.closedAt) || (typeof ticketStatus === "string" && ticketStatus && ticketStatus !== "PENDING_REVIEW")) return "closed";
  return null;
}

/** DF-P18 fix pass (review, major): the rows that still say something true
 *  about THIS roster — rows of an earlier roster (a resubmission opened a new
 *  one) are dropped, and a block that no longer holds
 *  (consentBlockSupersededBy: opened later, the slot signed, the review
 *  closed — fix pass 2) does not stand. Oldest first. (pure) */
export function currentConsentBlockRows(
  rows: readonly ConsentBlockRow[],
  roster: Pick<TicketReviewRoster, "id" | "consentPlan" | "consentWindow" | "slots" | "closedAt"> | null | undefined,
  ticketStatus?: string | null,
): { rows: ConsentBlockRow[]; standing: ConsentBlockRow[] } {
  const rosterId = roster && typeof roster.id === "string" && roster.id ? roster.id : null;
  const mine = rows
    .filter((r) => !rosterId || r.roster_id === rosterId)
    .slice()
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  const standing = mine.filter((r) => consentBlockSupersededBy(r, roster, ticketStatus) === null);
  return { rows: mine, standing };
}

/** DF-P18 fix pass 2 (review, minor): the Audit Log label for a recorded
 *  block, by its reason — a `no_longer_member` row is a window that WAS
 *  opened and ran to its close (lib/consentWindowScan.ts), never "not
 *  opened". (pure) */
export function consentBlockActionLabel(row: Pick<ConsentBlockRow, "details">): string {
  return row.details?.reason === "no_longer_member"
    ? "Consent window closed — nobody left who could object"
    : "Consent window not opened";
}

const SUPERSEDED_MARK: Record<ConsentBlockSuperseded, { tag: string; sentence: string }> = {
  opened_later: { tag: "opened later", sentence: "The maintenance run opened the window later; this no longer holds." },
  signed: { tag: "signed later", sentence: "The slot was signed later; this no longer holds." },
  closed: { tag: "review closed", sentence: "The review has closed; this no longer holds." },
};

/** The history entries the Audit Log tab shows for those rows (read-only;
 *  merged by date with the request's own history — never written to it).
 *  A block that no longer holds says so and why (DF-P18 fix passes:
 *  opened later, signed later, review closed) — it was true when recorded.
 *  Each entry is labelled by its reason (consentBlockActionLabel). */
export function consentBlockHistoryEntries(
  rows: readonly ConsentBlockRow[],
  labelOf?: (slot: string | null) => string | null,
  roster?: Pick<TicketReviewRoster, "consentPlan" | "consentWindow" | "slots" | "closedAt"> | null,
  ticketStatus?: string | null,
): Array<{ action: string; user: string; date: string; details: string }> {
  return rows.map((r) => {
    const by = consentBlockSupersededBy(r, roster, ticketStatus);
    const mark = by ? SUPERSEDED_MARK[by] : null;
    return {
      action: `${consentBlockActionLabel(r)}${mark ? ` (${mark.tag})` : ""}`,
      user: (typeof r.actor_name === "string" && r.actor_name.trim()) || "System",
      date: r.created_at,
      details: `${consentBlockReason(r, labelOf?.(r.slot_kind) ?? null)}${mark ? ` ${mark.sentence}` : ""} (recorded ${recordMoment(r.created_at)})`,
    };
  });
}
