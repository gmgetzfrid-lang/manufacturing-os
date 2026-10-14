// lib/verifyTicketVerdict.ts
//
// The verdict behind the QR stamped on a drafting-portal deliverable
// (/api/verify-ticket, /verify-ticket/[ticketId]) and the link that QR
// carries. Pure, so the route and the ticket page share one definition and
// the tests drive it without a database. The verdict is drafting-flow's; the
// door around it (no-store, the scan log, the per-IP cap, the select) is
// public-surfaces PS-VERIFY's and lives in the route.
//
// Verdicts:
//   current              the printed rev IS the latest issued deliverable of a
//                        live or properly closed request
//   revision_in_progress the printed rev is the latest issue, but a newer
//                        revision is being drafted / reviewed right now
//   superseded           a newer revision has been ISSUED — do not use
//   draft_copy           the printed rev is a review draft (1A / 2B) that was
//                        never an issued deliverable
//   withdrawn            the request was CANCELED, or it ended (CLOSED) on a
//                        review label with no issue anywhere — neither on the
//                        row nor in its history — drafting-flow EDGE-2:
//                        never current, whatever the rev arithmetic says.
//                        With no ?r= on the QR only CANCELED answers
//                        withdrawn; a CLOSED row answers "cannot confirm".
//   unknown              the copy names no revision (a file from before
//                        per-file revisions, a source file), the ticket
//                        carries no revision record for it (a CLOSED row with
//                        no label: closed before revisions were recorded, an
//                        RFI closed with no label, or reopened and closed
//                        again), a CLOSED review label whose history has an
//                        issue line the label sets aside (forged, or a
//                        pre-Round-E collision), or the ticket is an archived
//                        stub — "cannot confirm"
//
// A CLOSED ticket closed on its issued label, or force-closed on a review
// label after an issue the history proves within the label's bound, keeps
// the ordinary ladder: the last issue reads current, older issues
// superseded. A CLOSED ticket with NO label answers "cannot confirm" (the
// integrator's ruling, DEC-90 fail-safe; base behaviour), because a history
// line is the only evidence it could offer and any member may append one.
// A live issued label is IN FORCE only where the workflow leaves one on an
// issued package (PENDING_IFC after an approval, FINAL_DRAFT after
// submit_final); at every other live status the drawing is being re-worked and the last issue reads
// revision_in_progress — sent back on its label (reject_final →
// REVISION_REQ), or a ticket reopened before Round E that kept its label
// while a new revision is under review (LEAK-7 population (a): an issued
// label at PENDING_REVIEW / PENDING_FINAL_APPROVAL, which the workflow never
// writes — review statuses carry letter labels).
//
// WF-21 / DEC-15: a REOPENED ticket starts a new revision cycle — the
// workflow nulls deliverable_rev and bumps revision_count, so the row no
// longer carries a label to compare against. The last issued number is then
// read from the EVIDENCE of an issue — the history line every approval
// writes ("… — issued Rev N") — and the ticket is back under review: a print
// of the last issue reads revision_in_progress, an older one superseded —
// never "current" while the drawing is being re-worked. A cycle count alone
// is NOT evidence: a reject before any issue bumps revision_count too.
//
// AUTHZ-12 (the integrator's ruling, DEC-90 practice): a scanned QR keeps
// answering forever, for revision-status facts only. The public answer names
// the ticket number and title, the printed and current revisions, whether a
// revision is in review, and the verdict. The internal workflow status, the
// unit and the last-activity time are not in it; an archived ticket answers
// "cannot confirm" with no revision facts at all.
//
// Trust boundary (SM-5 / PHYS-2): any org member may append a history entry
// in their own name (20261166's ticket_update_guard allows it), so an
// "issued Rev N" line is evidence only up to the cycle the server-guarded
// revision_count allows: a real issue N happens at revision_count N − 1 and
// revision_count never goes down, so a line above revision_count + 1 was
// not written by an approval and is ignored. The row's own label proves a
// tighter bound (issueOnRecord): a review label N<letters> means issue N has
// not happened, so the last issue is at most N − 1; an issued label N means
// it is N; NO label bounds the last issue at revision_count. That last bound
// rests on "an issue writes a label, and only reopen_ticket nulls one (and
// bumps revision_count)", which holds wherever the deliverable_rev column
// exists. It does not hold on the workflow route's pre-migration retry
// (app/api/tickets/workflow-action/route.ts, the PGRST204 / 42703 branch
// before 20260827): that write drops deliverable_rev and draft_iteration but
// keeps the "issued Rev N" history line and revision_count, so a real issue
// lands on a row with no label. The bound then sets the real line aside and
// the answer fails safe — "cannot confirm", never green. A line above the
// bound is ignored too. What a forged line can still do is a line AT or
// below the bound, which the row cannot tell from a real issue: under a
// review label, a member-appended "issued Rev K" at or below the label's
// bound can supersede a real earlier issue (Rev 1 issued at revision_count
// 0; reject_final → 1; 2A submitted and rejected → 2; 3A submitted; a member
// appends "issued Rev 2" → the real Rev 1 reads superseded, its copy
// stamped SUPERSEDED by Rev 2); on a live row with no label, only where
// revision_count was bumped by cycles that issued nothing. A CLOSED row with
// no label answers "cannot confirm" whatever its history says (the
// integrator's ruling, ticketVerdict below).
//
// The guard limb (drafting-flow DF-P12, 20261221): ticket_update_guard
// refuses a client-appended "issued Rev N" entry, and the row records from
// which index of its history on every such line is the workflow's own
// (tickets.history_guarded_from, stamped by the guard at the row's first write
// after the paste). An issue line at or after that index is PROVEN
// (provenIssueFromHistory). Every real issue is a higher number than every
// real issue before it (lib/ticketTransitions.ts issueLabelFor re-cycles a
// label the history already issued), so once a ticket has a proven issue it
// is the last issue, and an older line claiming a higher number is provably
// not an approval's. For such a ticket the fail-safe "cannot confirm" rules
// that exist only because a line might be forged are lifted (the integrator's
// DEC-90 ruling: history the server did not write is never trusted — and here
// the server provably wrote it). A ticket with no proven issue — every ticket
// before the paste, or one whose issues all predate it — reads exactly as
// before (a database without the column answers as before the paste).
//
// Identity on the QR (SM-5 done-when 3, LEAK-7 (b); DF-P12): a print's QR
// also carries the FILE's id (?a=). When it does, the file must be on the
// ticket, once, carrying the printed revision; otherwise the print cannot be
// confirmed. A label the history issued TWICE (a pre-Round-E re-issue, LEAK-7
// (b)) cannot be told apart by label: a print naming it without a confirmed
// identity answers "cannot confirm", never green. Neither rule ever makes an
// answer greener: only current / revision_in_progress are demoted.

export type TicketVerdict =
  | "current"
  | "revision_in_progress"
  | "superseded"
  | "draft_copy"
  | "withdrawn"
  | "unknown";

/** The ticket columns the verdict reads. */
export interface VerifyTicketRowFacts {
  status: string | null;
  deliverable_rev: string | null;
  history: unknown;
  archived_at?: string | null;
  /** The server-guarded cycle count — caps which history lines count as an
   *  issue (the trust boundary above). Absent: no cap (an older caller). */
  revision_count?: number | null;
  /** 20261221 (DF-P12): the index in `history` from which every "issued Rev
   *  N" line is the workflow's own. Absent (no column yet, an older caller)
   *  or null (nothing proven on this row): today's reading. */
  history_guarded_from?: number | null;
  /** The ticket's files — read only when the QR names one (?a=, SM-5
   *  done-when 3). */
  attachments?: unknown;
}

export interface TicketVerdictResult {
  verdict: TicketVerdict;
  /** The row's live label (null when the facts are withheld — an archived stub). */
  currentRev: string | null;
  latestIssuedRev: string | null;
  inReview: boolean;
}

/** A rev a QR may carry: a cycle number, optionally a review letter run. */
export const TICKET_REV_RE = /^\d+[A-Z]{0,3}$/;

const TERMINAL = new Set(["CLOSED", "CANCELED"]);
/** Every live workflow status at which an issued label is being re-worked.
 *  The workflow leaves an issued label in force only at PENDING_IFC and
 *  FINAL_DRAFT; an issued label at a review status (PENDING_REVIEW,
 *  PENDING_FINAL_APPROVAL) exists only on a LEAK-7 (a) row. */
const REWORK = new Set(["REVISION_REQ", "DRAFTING", "PENDING_REVIEW", "PENDING_FINAL_APPROVAL", "PENDING_ENG_TEAM", "PENDING_ASSIGNMENT"]);
const ISSUED_LINE = /\bissued Rev (\d+)\b/;
const cycleOf = (rev: string): number => parseInt(rev, 10);
export const isIssuedTicketRev = (rev: string | null | undefined): rev is string => typeof rev === "string" && /^\d+$/.test(rev);

/** The highest issued number the ticket's history records, or null when no
 *  approval ever issued a deliverable (WF-21: the evidence a reopen needs).
 *  With `revisionCount`, a line above revisionCount + 1 is ignored: no
 *  approval could have written it (the trust boundary above). */
export function lastIssuedFromHistory(history: unknown, revisionCount?: number | null): string | null {
  if (!Array.isArray(history)) return null;
  const cap = typeof revisionCount === "number" && Number.isFinite(revisionCount) ? revisionCount + 1 : null;
  let best: number | null = null;
  for (const h of history) {
    const m = ISSUED_LINE.exec(String((h as { action?: unknown } | null)?.action ?? ""));
    if (m) {
      const n = parseInt(m[1], 10);
      if (cap !== null && n > cap) continue;
      if (best === null || n > best) best = n;
    }
  }
  return best === null ? null : String(best);
}

/** The bound the row's own label puts on the last issue: N − 1 under a
 *  review label N<letters> (0 = nothing can have been issued), N under an
 *  issued label N. With NO label, `revisionCount` itself (when given): where
 *  the deliverable_rev column exists, an issue writes a label and only
 *  reopen_ticket nulls one — AND bumps revision_count after the issue. A
 *  real issue N is written at revision_count N − 1 (or sets it to N − 1 on
 *  an SM-5 re-cycle), so every real issue line on such a row has
 *  N ≤ revision_count. The workflow route's pre-migration retry (no
 *  deliverable_rev column) writes the issue line with no label; the bound
 *  then sets that real line aside and the verdict fails safe to "cannot
 *  confirm". null with no label and no count (only the cycle cap, if any,
 *  applies). */
export function issueBoundFromLabel(rev: string | null | undefined, revisionCount?: number | null): number | null {
  if (typeof rev !== "string" || !TICKET_REV_RE.test(rev)) {
    return typeof revisionCount === "number" && Number.isFinite(revisionCount) ? revisionCount : null;
  }
  return isIssuedTicketRev(rev) ? cycleOf(rev) : cycleOf(rev) - 1;
}

/** The last issue the history proves, under BOTH trust caps: the cycle cap
 *  (revision_count + 1) and the row's label — or, with no label, the row's
 *  revision_count (issueBoundFromLabel). null when no issue line survives
 *  them. The verdict and the copy standing read this; the SM-5 re-cycle does
 *  not (it must see a legacy collision AT the label). */
export function issueOnRecord(history: unknown, revisionCount: number | null | undefined, deliverableRev: string | null | undefined): string | null {
  const fromHistory = lastIssuedFromHistory(history, revisionCount);
  if (fromHistory === null) return null;
  const bound = issueBoundFromLabel(deliverableRev, revisionCount);
  if (bound === null) return fromHistory;
  const n = Math.min(parseInt(fromHistory, 10), bound);
  return n >= 1 ? String(n) : null;
}

/** DF-P12 (20261221): the last issue the WORKFLOW provably wrote — the
 *  highest "issued Rev N" line at or after `guardedFrom` (the guard refuses a
 *  client-appended one from there on). null when the row has no index, no
 *  line there, or a line above the trust caps (revision_count + 1, the
 *  label's bound) — an inconsistency is never read as proof; the caller then
 *  reads the row as before the paste. */
export function provenIssueFromHistory(
  history: unknown,
  guardedFrom: number | null | undefined,
  revisionCount: number | null | undefined,
  deliverableRev: string | null | undefined,
): string | null {
  if (!Array.isArray(history) || typeof guardedFrom !== "number" || !Number.isInteger(guardedFrom) || guardedFrom < 0) return null;
  let best: number | null = null;
  for (let i = guardedFrom; i < history.length; i += 1) {
    const m = ISSUED_LINE.exec(String((history[i] as { action?: unknown } | null)?.action ?? ""));
    if (m) {
      const n = parseInt(m[1], 10);
      if (best === null || n > best) best = n;
    }
  }
  if (best === null || best < 1) return null;
  if (typeof revisionCount === "number" && Number.isFinite(revisionCount) && best > revisionCount + 1) return null;
  const bound = issueBoundFromLabel(deliverableRev, revisionCount);
  if (bound !== null && best > bound) return null;
  return String(best);
}

/** The last issue the verdict and the copy stamp read: the proven one when
 *  the row has it (DF-P12), else the bounded history (issueOnRecord). */
export function issueInForce(
  history: unknown,
  revisionCount: number | null | undefined,
  deliverableRev: string | null | undefined,
  guardedFrom?: number | null,
): string | null {
  return provenIssueFromHistory(history, guardedFrom, revisionCount, deliverableRev) ?? issueOnRecord(history, revisionCount, deliverableRev);
}

/** LEAK-7 (b): does the history issue label `rev` more than once (lines
 *  within revision_count + 1 when the count is known)? Two packages then
 *  share the label, and a print naming it cannot be told apart by label. */
export function issuedMoreThanOnce(history: unknown, revisionCount: number | null | undefined, rev: string): boolean {
  if (!Array.isArray(history) || !isIssuedTicketRev(rev)) return false;
  const want = parseInt(rev, 10);
  if (typeof revisionCount === "number" && Number.isFinite(revisionCount) && want > revisionCount + 1) return false;
  let seen = 0;
  for (const h of history) {
    const m = ISSUED_LINE.exec(String((h as { action?: unknown } | null)?.action ?? ""));
    if (m && parseInt(m[1], 10) === want) seen += 1;
  }
  return seen > 1;
}

/** An attachment id a QR may carry (?a=): ticket files are ids the app mints
 *  (crypto.randomUUID); anything else is refused at the door. */
export const TICKET_ATTACHMENT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** SM-5 done-when 3: is the printed file this ticket's, once, carrying the
 *  printed revision? */
function printedFileConfirmed(attachments: unknown, attachmentId: string, printedRev: string): boolean {
  if (!Array.isArray(attachments)) return false;
  const named = attachments.filter((a) => (a as { id?: unknown } | null)?.id === attachmentId);
  if (named.length !== 1) return false;
  const rev = (named[0] as { rev?: unknown }).rev;
  return typeof rev === "string" && rev.trim().toUpperCase() === printedRev;
}

/** The verdict for a print of `printedRev` (already upper-cased and trimmed;
 *  "" when the QR names no revision) against the ticket as it stands.
 *  `printedAttachmentId` is the file id the QR names (?a=; "" or absent when
 *  it names none — every print made before DF-P12). */
export function ticketVerdict(row: VerifyTicketRowFacts, printedRev: string, printedAttachmentId?: string): TicketVerdictResult {
  // An archived ticket is a content-shed stub: its history went to the
  // archive bundle, so the database can no longer say what was issued.
  if (row.archived_at) {
    return { verdict: "unknown", currentRev: null, latestIssuedRev: null, inReview: false };
  }

  const currentRev = row.deliverable_rev;
  const status = row.status ?? null;
  const terminal = !!status && TERMINAL.has(status);
  const issuedLabel = isIssuedTicketRev(currentRev);
  const letterLabel = !!currentRev && !issuedLabel;
  // DF-P12: the last issue the workflow provably wrote (20261221's index),
  // when the row has one — then it IS the last issue, whatever older lines
  // claim (the trust boundary above).
  const proven = provenIssueFromHistory(row.history, row.history_guarded_from, row.revision_count, currentRev);
  // The EVIDENCE of an issue: the history line every approval writes, under
  // the cycle cap and the label's own bound (the trust boundary above).
  const issuedInHistory = proven ?? issueOnRecord(row.history, row.revision_count, currentRev);
  // A history issue line the label's bound set aside: forged, or a ticket
  // reopened before Round E whose real Rev N collides with its review label
  // N<letters> (LEAK-7) — the row cannot tell which, so a print of it is
  // "cannot confirm", never a "review draft" verdict. Never with a proven
  // issue: a line the bound sets aside is then provably not an approval's.
  const issueLineSetAside = !proven && issuedInHistory !== lastIssuedFromHistory(row.history, row.revision_count);

  // EDGE-2: a CANCELED request is withdrawn whatever the rev arithmetic —
  // never current, superseded or draft, even for a QR with no revision.
  if (status === "CANCELED") {
    return { verdict: "withdrawn", currentRev, latestIssuedRev: issuedLabel ? currentRev : issuedInHistory, inReview: false };
  }

  // The last issue before a review label (2A in review → Rev 1): the history
  // when the row has one (a reject before any issue bumps the cycle too, so
  // cycle − 1 alone would report a phantom issue); cycle − 1 only for a row
  // that carries no history at all.
  const hasHistory = Array.isArray(row.history) && row.history.length > 0;
  const issueBeforeLetter = letterLabel
    ? hasHistory
      ? issuedInHistory
      : cycleOf(currentRev) > 1 ? String(cycleOf(currentRev) - 1) : null
    : null;

  let latestIssued: string | null;
  let inReview: boolean;
  let noRecord = false; // the ticket holds no revision record to compare against
  let withdrawn = false;
  if (terminal) {
    // CLOSED. Closed on an issue (issued label), or force-closed on a review
    // label after one: the last issue is the one in force, an older print
    // superseded.
    //
    // A CLOSED row with NO label answers "cannot confirm", as base did (the
    // integrator's ruling under DEC-90, fail-safe; EDGE-2 done-when 2's
    // CLOSED reading): its only evidence of an issue would be a history line,
    // and any member may append one while revision_count can be bumped by
    // cycles that issued nothing, so no bound the row carries separates a
    // real "issued Rev N" from a forged one. DF-P12 (20261221): once the
    // guard makes "issued Rev" lines server-only, an issue line at or after
    // the row's index is proven — a CLOSED row with no label whose last issue
    // is proven reads the ladder on it (current for that issue, superseded
    // for older); with no proven issue it stays "cannot confirm".
    latestIssued = issuedLabel ? currentRev : letterLabel ? issueBeforeLetter : null;
    inReview = false;
    if (!currentRev && proven) {
      // Reopened and closed again (or force-closed) after a PROVEN issue:
      // that issue is the last one, and nothing newer was issued.
      latestIssued = proven;
    } else if (!currentRev) {
      // No label: closed before revisions were recorded (20260827), an RFI
      // closed by close_rfi, or reopened and closed again — cannot confirm,
      // naming no issue.
      noRecord = true;
      latestIssued = null;
    } else if (letterLabel && issueLineSetAside) {
      // A review label with a history issue line its bound set aside: a
      // forged line, or a real issue of a ticket reopened before Round E
      // whose Rev N collides with its label N<letters> (LEAK-7 (a)). The row
      // cannot tell which, so it is neither withdrawn nor current: cannot
      // confirm, naming no issue.
      noRecord = true;
      latestIssued = null;
    } else if (!latestIssued) {
      // EDGE-2: ended on a review label with no issue anywhere — neither on
      // the row nor in its history: the request used the revision scheme
      // and issued nothing: withdrawn.
      withdrawn = true;
    }
  } else if (issuedLabel) {
    // A live issued label. In force only at PENDING_IFC / FINAL_DRAFT. Sent
    // back for rework (reject_final → REVISION_REQ keeps the label and bumps
    // the cycle), or reopened before Round E with the label kept while a new
    // revision is reviewed (PENDING_REVIEW / PENDING_FINAL_APPROVAL — LEAK-7
    // (a)): the issue is still the latest, but the drawing is being
    // re-worked — never "current".
    latestIssued = currentRev;
    inReview = REWORK.has(status ?? "");
  } else if (letterLabel) {
    latestIssued = issueBeforeLetter;
    inReview = true;
  } else if (issuedInHistory && !!status) {
    // WF-21: reopened = no label on the row, a live status, and EVIDENCE
    // that a deliverable was once issued (the approval's history line).
    latestIssued = issuedInHistory;
    inReview = true;
  } else {
    latestIssued = null;
    inReview = false;
    noRecord = true;
  }

  let verdict: TicketVerdict;
  if (!printedRev || noRecord) {
    verdict = "unknown";
  } else if (withdrawn) {
    verdict = "withdrawn";
  } else if (!isIssuedTicketRev(printedRev)) {
    // A letter rev (1A) on paper was a review draft — never an issued deliverable.
    verdict = "draft_copy";
  } else if (latestIssued && cycleOf(printedRev) < cycleOf(latestIssued)) {
    verdict = "superseded";
  } else if (inReview && latestIssued && printedRev === latestIssued) {
    verdict = "revision_in_progress";
  } else if (latestIssued && printedRev === latestIssued) {
    verdict = "current";
  } else if (inReview && !latestIssued) {
    // Printed an issued number but nothing has ever been issued — stale data;
    // "cannot confirm" when an issue line was set aside by the label's bound.
    verdict = issueLineSetAside ? "unknown" : "draft_copy";
  } else {
    verdict = "unknown";
  }

  // DF-P12 (EDGE-2's observation; decided fail-safe under DEC-90): a CLOSED
  // ticket still carrying issued label N whose cycle has moved past it
  // (revision_count >= N — reject_final, or a request for revision, sent the
  // package back after the issue) and that closed with no new issue: the
  // requester rejected that package, and a close (a Force Close) is not an
  // approval of it. Its print is neither green nor red — "cannot confirm".
  // Base answered green. Older prints stay superseded.
  if (verdict === "current" && terminal && issuedLabel
      && typeof row.revision_count === "number" && Number.isFinite(row.revision_count)
      && row.revision_count >= cycleOf(currentRev)) {
    verdict = "unknown";
  }

  // SM-5 done-when 3 / LEAK-7 (b) (DF-P12): the printed file's identity.
  // Only a green or amber "latest issue" answer is demoted — never a red one.
  if (verdict === "current" || verdict === "revision_in_progress") {
    const named = typeof printedAttachmentId === "string" && printedAttachmentId !== "";
    const confirmed = named && printedFileConfirmed(row.attachments, printedAttachmentId, printedRev);
    if (named && !confirmed) {
      // The QR names a file that is not this ticket's, is named twice, or
      // carries another revision: cannot confirm which printing this is.
      verdict = "unknown";
    } else if (!confirmed && !proven && issuedMoreThanOnce(row.history, row.revision_count, printedRev)) {
      // A label issued twice (LEAK-7 (b)): two packages share it, and a print
      // naming only the label cannot be told apart.
      verdict = "unknown";
    }
  }
  return { verdict, currentRev, latestIssuedRev: latestIssued, inReview };
}

/** The right-hand cell of the landing page's facts card (EDGE-2 done-when 2):
 *  the coarse state the verdict carries, never a label that contradicts the
 *  headline — a withdrawn or unconfirmable copy shows no "Latest issue". */
export function ticketFactsState(r: Pick<TicketVerdictResult, "verdict" | "currentRev" | "latestIssuedRev" | "inReview">): { label: string; value: string } {
  if (r.verdict === "withdrawn") return { label: "Request", value: "Withdrawn" };
  if (r.verdict === "unknown") return { label: "Revision status", value: "Cannot confirm" };
  if (r.inReview) {
    const inReviewRev = ticketRevInReview(r);
    return { label: "In review now", value: inReviewRev ? `Rev ${inReviewRev}` : "New revision" };
  }
  return { label: "Latest issue", value: `Rev ${r.latestIssuedRev ?? r.currentRev ?? "?"}` };
}

/** The review label being worked, when the row names one — not the issued
 *  label a reworked ticket still carries (reject_final keeps it). */
export function ticketRevInReview(r: Pick<TicketVerdictResult, "currentRev" | "latestIssuedRev" | "inReview">): string | null {
  return r.inReview && r.currentRev && !isIssuedTicketRev(r.currentRev) ? r.currentRev : null;
}

/** The QR link for a print of one ticket file. `rev` is the FILE's own
 *  revision (TicketAttachment.rev — PHYS-2), never the ticket's live label;
 *  with none, the link carries no `?r=` and the scan answers "cannot
 *  confirm". `attachmentId` is the FILE's id (SM-5 done-when 3, DF-P12):
 *  the scan checks it against the ticket's files, so two prints of one label
 *  are told apart; an id the app did not mint is left off. `undefined` when
 *  there is no public origin or no ticket id (DEC-64 §2: no origin, no QR). */
export function ticketVerifyUrl(origin: string, ticketRowId: string | null | undefined, rev: string | null | undefined, attachmentId?: string | null): string | undefined {
  if (!origin || !ticketRowId) return undefined;
  const qs = new URLSearchParams();
  if (typeof rev === "string" && TICKET_REV_RE.test(rev)) qs.set("r", rev);
  if (typeof attachmentId === "string" && TICKET_ATTACHMENT_ID_RE.test(attachmentId)) qs.set("a", attachmentId);
  const q = qs.toString();
  return `${origin}/verify-ticket/${ticketRowId}${q ? `?${q}` : ""}`;
}
