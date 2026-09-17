// GET /api/verify-ticket?t=<uuid>&r=<rev>
//
// The endpoint behind the QR stamped on drafting-portal deliverables.
// UNAUTHENTICATED by design — same contract as /api/verify: a contractor
// holding a print a PM handed them scans it with a phone, no account.
// Exposure is minimal and deliberate:
//   * The ticket ID is an unguessable UUID that only appears ON a copy the
//     org itself issued.
//   * The response contains ONLY revision-status facts (ticket number,
//     title, printed rev vs current rev) — no files, no URLs, no people.
//
// Answers the PM-forgot-to-forward problem: "a revision happened on the
// ticket behind the scenes — is the deliverable in my hand still the
// latest issue?"
//
// Verdicts:
//   current              printed rev IS the latest issued deliverable
//   revision_in_progress printed rev is the latest issue, but a newer
//                        revision is being drafted/reviewed right now
//   superseded           a newer revision has been ISSUED — do not use
//   draft_copy           the printed rev is a review draft (1A/2B) that was
//                        never an issued deliverable
//   unknown              ticket predates rev tracking / no rev on the QR
//
// WF-21 / DEC-15: a REOPENED ticket starts a new revision cycle — the
// workflow nulls deliverable_rev and bumps revision_count, so the row no
// longer carries a label to compare against. The last issued number is then
// read from the EVIDENCE of an issue — the history line every approval
// writes ("… — issued Rev N") — and the ticket is back under review: a print
// of the last issue reads revision_in_progress, an older one superseded —
// never "current" while the drawing is being re-worked. Only a live
// (non-terminal) status counts: a ticket closed again without a new issue
// stays unknown. A cycle count alone is NOT evidence: a reject before any
// issue bumps revision_count too, and such a ticket never issued anything.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "";
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REV_RE = /^\d+[A-Z]{0,3}$/;

const cycleOf = (rev: string): number => parseInt(rev, 10);
const isIssued = (rev: string): boolean => /^\d+$/.test(rev);
const TERMINAL = new Set(["CLOSED", "CANCELED"]);
const ISSUED_LINE = /\bissued Rev (\d+)\b/;
/** The highest issued number the ticket's history records, or null when no
 *  approval ever issued a deliverable (WF-21: the evidence a reopen needs). */
function lastIssuedFromHistory(history: unknown): string | null {
  if (!Array.isArray(history)) return null;
  let best: number | null = null;
  for (const h of history) {
    const m = ISSUED_LINE.exec(String((h as { action?: unknown } | null)?.action ?? ""));
    if (m) { const n = parseInt(m[1], 10); if (best === null || n > best) best = n; }
  }
  return best === null ? null : String(best);
}

export async function GET(req: NextRequest) {
  if (!supabaseUrl || !serviceRoleKey) {
    return NextResponse.json({ error: "Verification unavailable" }, { status: 503 });
  }
  const ticketId = req.nextUrl.searchParams.get("t") ?? "";
  const printedRev = (req.nextUrl.searchParams.get("r") ?? "").toUpperCase().trim();
  if (!UUID_RE.test(ticketId) || (printedRev && !REV_RE.test(printedRev))) {
    return NextResponse.json({ error: "Invalid code" }, { status: 400 });
  }

  const sb = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

  const { data: row } = await sb
    .from("tickets")
    .select("id, ticket_id, title, unit, status, deliverable_rev, revision_count, last_modified, history")
    .eq("id", ticketId)
    .maybeSingle();
  if (!row) return NextResponse.json({ error: "Unknown ticket" }, { status: 404 });

  const t = row as {
    id: string; ticket_id: string | null; title: string | null; unit: string | null;
    status: string | null; deliverable_rev: string | null; revision_count: number | null;
    last_modified: string | null; history: unknown;
  };

  const currentRev = t.deliverable_rev;
  // WF-21: reopened = no label on the row, a live status, and EVIDENCE that
  // a deliverable was once issued (the approval's history line). A bumped
  // cycle count alone never counts — a rejected, never-issued ticket has one.
  const issuedBefore = !currentRev ? lastIssuedFromHistory(t.history) : null;
  const reopened = !currentRev && !!issuedBefore && !!t.status && !TERMINAL.has(t.status);
  const inReview = (!!currentRev && !isIssued(currentRev)) || reopened;
  // The latest ISSUED number: the current rev itself when issued, else the
  // cycle before the one now in review (2A in review → latest issue is 1);
  // on a reopened ticket, the last issue its history records (see the header).
  const latestIssued = currentRev
    ? isIssued(currentRev)
      ? currentRev
      : cycleOf(currentRev) > 1 ? String(cycleOf(currentRev) - 1) : null
    : reopened ? issuedBefore : null;

  let verdict: "current" | "revision_in_progress" | "superseded" | "draft_copy" | "unknown";
  if (!printedRev || (!currentRev && !reopened)) {
    verdict = "unknown";
  } else if (!isIssued(printedRev)) {
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

  return NextResponse.json({
    ticketNumber: t.ticket_id ?? null,
    title: t.title ?? null,
    unit: t.unit ?? null,
    printedRev: printedRev || null,
    currentRev,
    latestIssuedRev: latestIssued,
    inReview,
    ticketStatus: t.status ?? null,
    lastActivityAt: t.last_modified ?? null,
    verdict,
    checkedAt: new Date().toISOString(),
  });
}
