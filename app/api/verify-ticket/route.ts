// GET /api/verify-ticket?t=<uuid>&r=<rev>
//
// The endpoint behind the QR stamped on drafting-portal deliverables.
// UNAUTHENTICATED by design — same contract as /api/verify: a contractor
// holding a print a PM handed them scans it with a phone, no account.
// Exposure is minimal and deliberate:
//   * The ticket ID is an unguessable UUID that only appears ON a copy the
//     org itself issued.
//   * The response carries revision-status facts only, field for field:
//     ticketNumber, title, printedRev, currentRev, latestIssuedRev,
//     inReview, verdict, checkedAt — no files, no URLs, no people, and
//     (drafting-flow AUTHZ-12, the integrator's ruling) not the internal
//     workflow status, the unit or the last-activity time. A QR keeps
//     answering these facts for as long as the ticket exists; an archived
//     ticket answers "cannot confirm" with the revision facts withheld.
//
// Answers the PM-forgot-to-forward problem: "a revision happened on the
// ticket behind the scenes — is the deliverable in my hand still the
// latest issue?" The verdict — current / revision_in_progress / superseded /
// draft_copy / withdrawn / unknown — is drafting-flow's and lives in
// lib/verifyTicketVerdict.ts (EDGE-2: a canceled request, or one that ended
// on a review label with no issue anywhere, is "withdrawn", never current; a
// closed ticket with no issued label answers "cannot confirm"; WF-21 /
// DEC-15 and EDGE-2: a reopened ticket, or one sent back for rework on its
// issued label, reads revision_in_progress, never current). The rev on the
// QR is the printed FILE's own revision (PHYS-2), not the ticket's.
//
// The door (public-surfaces PS-VERIFY; the verdict above is drafting-flow's):
// every answered scan leaves a verify_scans row and counts toward a generous
// per-IP cap (VFY-12), every answer is Cache-Control: no-store (VFY-13), and
// the select names only the columns the verdict or the response reads
// (VFY-14 done-when 3, "used in the verdict": revision_count is selected
// because the verdict reads it — it caps which history "issued Rev N" lines
// count as an issue, since any member may append history in their own name
// — and it is never returned).

import { NextRequest } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { checkVerifyRate, clientIp, verifyJson, verifyRateLimitedResponse } from "@/lib/verifyRateLimit";
import { recordVerifyScan } from "@/lib/verifyScanLog";
import { TICKET_REV_RE, ticketVerdict, type VerifyTicketRowFacts } from "@/lib/verifyTicketVerdict";

// A revision verdict is never prerendered or cached (VFY-13; OFF-1 dw3).
export const dynamic = "force-dynamic";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "";
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(req: NextRequest) {
  if (!supabaseUrl || !serviceRoleKey) {
    return verifyJson({ error: "Verification unavailable" }, 503);
  }
  const ticketId = req.nextUrl.searchParams.get("t") ?? "";
  const printedRev = (req.nextUrl.searchParams.get("r") ?? "").toUpperCase().trim();
  const sb = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });
  const ip = clientIp(req);
  const userAgent = req.headers.get("user-agent");
  const scan = (verdict: string) =>
    recordVerifyScan(sb, { endpoint: "verify-ticket", targetId: ticketId, verdict, ip, userAgent });

  const rate = await checkVerifyRate(sb, { ip });
  if (rate.limited) return verifyRateLimitedResponse(rate);

  if (!UUID_RE.test(ticketId) || (printedRev && !TICKET_REV_RE.test(printedRev))) {
    await scan("invalid");
    return verifyJson({ error: "Invalid code" }, 400);
  }

  const { data: row, error: rowErr } = await sb
    .from("tickets")
    .select("id, ticket_id, title, status, deliverable_rev, history, revision_count, archived_at")
    .eq("id", ticketId)
    .maybeSingle();
  if (rowErr) {
    // An unreadable ticket is an outage, not an unknown code: the scan row
    // says 'error' (never 'unknown' — VFY-12's evidence must not read an
    // outage as enumeration) and the field page says "try again".
    await scan("error");
    return verifyJson({ error: "Verification unavailable — try again" }, 503);
  }
  if (!row) {
    await scan("unknown");
    return verifyJson({ error: "Unknown ticket" }, 404);
  }

  const t = row as VerifyTicketRowFacts & { id: string; ticket_id: string | null; title: string | null };
  const v = ticketVerdict(t, printedRev);

  await scan(v.verdict);

  return verifyJson({
    ticketNumber: t.ticket_id ?? null,
    title: t.title ?? null,
    printedRev: printedRev || null,
    currentRev: v.currentRev,
    latestIssuedRev: v.latestIssuedRev,
    inReview: v.inReview,
    verdict: v.verdict,
    checkedAt: new Date().toISOString(),
  });
}
