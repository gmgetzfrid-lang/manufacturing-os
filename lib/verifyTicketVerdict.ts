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
//   withdrawn            the request was CANCELED, or it ended (CLOSED) with
//                        no issued deliverable on it — drafting-flow EDGE-2:
//                        never current, whatever the rev arithmetic says
//   unknown              the copy names no revision (a file from before
//                        per-file revisions, a source file), the ticket
//                        carries no revision record for it, or the ticket is
//                        an archived stub — "cannot confirm"
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
const ISSUED_LINE = /\bissued Rev (\d+)\b/;
const cycleOf = (rev: string): number => parseInt(rev, 10);
export const isIssuedTicketRev = (rev: string | null | undefined): rev is string => typeof rev === "string" && /^\d+$/.test(rev);

/** The highest issued number the ticket's history records, or null when no
 *  approval ever issued a deliverable (WF-21: the evidence a reopen needs). */
export function lastIssuedFromHistory(history: unknown): string | null {
  if (!Array.isArray(history)) return null;
  let best: number | null = null;
  for (const h of history) {
    const m = ISSUED_LINE.exec(String((h as { action?: unknown } | null)?.action ?? ""));
    if (m) { const n = parseInt(m[1], 10); if (best === null || n > best) best = n; }
  }
  return best === null ? null : String(best);
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

  // EDGE-2: a request that was withdrawn, or that ended without an issued
  // deliverable on it, never answers current, superseded or draft — the
  // whole request is off. (A CLOSED request whose label is an issued number
  // closed on that issue: it keeps the ordinary ladder below.)
  if (status === "CANCELED" || (terminal && !isIssuedTicketRev(currentRev))) {
    return {
      verdict: "withdrawn",
      currentRev,
      latestIssuedRev: isIssuedTicketRev(currentRev) ? currentRev : null,
      inReview: false,
    };
  }

  // WF-21: reopened = no label on the row, a live status, and EVIDENCE that
  // a deliverable was once issued (the approval's history line).
  const issuedBefore = !currentRev ? lastIssuedFromHistory(row.history) : null;
  const reopened = !currentRev && !!issuedBefore && !!status && !terminal;
  const inReview = (!!currentRev && !isIssuedTicketRev(currentRev)) || reopened;
  // The latest ISSUED number: the current rev itself when issued, else the
  // cycle before the one now in review (2A in review → latest issue is 1);
  // on a reopened ticket, the last issue its history records.
  const latestIssued = currentRev
    ? isIssuedTicketRev(currentRev)
      ? currentRev
      : cycleOf(currentRev) > 1 ? String(cycleOf(currentRev) - 1) : null
    : reopened ? issuedBefore : null;

  let verdict: TicketVerdict;
  if (!printedRev || (!currentRev && !reopened)) {
    verdict = "unknown";
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
    // Printed an issued number but nothing has ever been issued — stale data.
    verdict = "draft_copy";
  } else {
    verdict = "unknown";
  }
  return { verdict, currentRev, latestIssuedRev: latestIssued, inReview };
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
