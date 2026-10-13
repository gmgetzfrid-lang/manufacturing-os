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
//                        never current, whatever the rev arithmetic says
//   unknown              the copy names no revision (a file from before
//                        per-file revisions, a source file), the ticket
//                        carries no revision record for it (closed before
//                        revisions were recorded, an RFI closed with no label), or the ticket is
//                        an archived stub — "cannot confirm"
//
// A CLOSED ticket with an issue on it — its issued label, or the history
// line of one after a reopen or a force close — keeps the ordinary ladder:
// the last issue reads current, older issues superseded. A live issued label
// is IN FORCE only where the workflow leaves one on an issued package
// (PENDING_IFC after an approval, FINAL_DRAFT after submit_final); at every
// other live status the drawing is being re-worked and the last issue reads
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
// it is N; NO label means nothing was issued since the row was last
// reopened (every issue writes a label; only reopen_ticket nulls one, and it
// bumps revision_count), so the last issue is at most revision_count. A line
// above that bound is ignored too. What a forged line can still do is a line
// AT or below the bound, which the row cannot tell from a real issue (on a
// row with no label: only where revision_count was bumped by cycles that
// issued nothing — a reject or return before any issue, a reopen of a
// request closed without one, a reject after a reopen): the guard limb
// refusing client-appended "issued Rev" entries (proposed under SM-5)
// closes it.

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
 *  issued label N. With NO label, `revisionCount` itself (when given): every
 *  issue writes a label, and only reopen_ticket nulls one — AND bumps
 *  revision_count after the issue. A real issue N is written at
 *  revision_count N − 1 (or sets it to N − 1 on an SM-5 re-cycle), so every
 *  real issue line on a row with no label has N ≤ revision_count. null with
 *  no label and no count (only the cycle cap, if any, applies). */
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

/** The verdict for a print of `printedRev` (already upper-cased and trimmed;
 *  "" when the QR names no revision) against the ticket as it stands. */
export function ticketVerdict(row: VerifyTicketRowFacts, printedRev: string): TicketVerdictResult {
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
  // The EVIDENCE of an issue: the history line every approval writes, under
  // the cycle cap and the label's own bound (the trust boundary above).
  const issuedInHistory = issueOnRecord(row.history, row.revision_count, currentRev);
  // A history issue line the label's bound set aside: forged, or a ticket
  // reopened before Round E whose real Rev N collides with its review label
  // N<letters> (LEAK-7) — the row cannot tell which, so a print of it is
  // "cannot confirm", never a "review draft" verdict.
  const issueLineSetAside = issuedInHistory !== lastIssuedFromHistory(row.history, row.revision_count);

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
    // CLOSED. Closed on an issue (issued label), or closed after one (a
    // reopen nulls the label; a force close can land on a review label): the
    // last issue is the one in force, an older print superseded.
    latestIssued = issuedLabel ? currentRev : letterLabel ? issueBeforeLetter : issuedInHistory;
    inReview = false;
    if (!latestIssued) {
      // EDGE-2: ended on a review label with no issue anywhere — the request
      // used the revision scheme and issued nothing: withdrawn. With no label
      // and no issue line (closed before revisions were recorded —
      // 20260827 — or an RFI closed by close_rfi with no label) nothing proves either way:
      // "cannot confirm", never a false "withdrawn".
      if (letterLabel) withdrawn = true;
      else noRecord = true;
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
 *  confirm". `undefined` when there is no public origin or no ticket id
 *  (DEC-64 §2: no origin, no QR). */
export function ticketVerifyUrl(origin: string, ticketRowId: string | null | undefined, rev: string | null | undefined): string | undefined {
  if (!origin || !ticketRowId) return undefined;
  const r = typeof rev === "string" && TICKET_REV_RE.test(rev) ? rev : null;
  return `${origin}/verify-ticket/${ticketRowId}${r ? `?r=${encodeURIComponent(r)}` : ""}`;
}
