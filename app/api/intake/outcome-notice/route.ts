// POST /api/intake/outcome-notice — tell the contractor how their submission
// was decided (projects-tab SAF-9, projects Round G J12).
//
// A contractor's portal shows the outcome and the reviewer's reason on their
// next visit (20261105 / the resolve route); this route ALSO emails the
// contact the org entered on the link (`project_intake_links.contact_email`
// — DEC-56: email only an address the org typed, never one the door
// collected), on approval and on rejection alike.
//
// Authority: the caller must be an active member who may decide the
// submission — an org controller (Admin / DocCtrl, held additively) or the
// project's owner, the people the Intake tab offers Approve / Reject to.
// The outcome is read from the DATABASE (the version's review_state and its
// reason), never from the request, so a caller cannot make the door say
// something that did not happen. One notice per submission: a second call
// for the same version answers `already` and sends nothing. The send is
// CLAIMED first — an INTAKE_OUTCOME_NOTICE_CLAIMED audit row carrying the
// version and the attempt number, unique per (org, version, attempt) by
// 20261157's index — so two concurrent calls (a double-click, a decision in
// two tabs) send ONE email: the second claim is refused and answers
// `in_progress`. A failed send frees the next attempt. The provider is given
// SEND_TIMEOUT_MS to answer (a hang is a failed send, recorded, never a
// claim left open by a function killed at its limit). A claim with no
// outcome row after it is a send under way — `in_progress` — until it is
// STALE_CLAIM_MS old: by then the function that made it is long dead
// (maxDuration), so the attempt is recorded as failed ("never finished")
// and the next one goes. The one case that can mean a second email: the
// provider accepted the send and the function died before writing the
// outcome row — rarer than a contractor never told, which is the failure
// this route exists to prevent. The portal shows the outcome whatever
// happens.
//
// Delivery: the app's server email path — Resend, through the same
// RESEND_API_KEY / RESEND_FROM_EMAIL the queue drain
// (/api/notifications/send-queued) uses. The queue itself is per-member
// (email_notifications.to_user_id is NOT NULL and the preferences gate keys
// on it), and a contractor is not a member, so the notice is sent here and
// its outcome is the audit row: INTAKE_OUTCOME_NOTIFIED (sent) or
// INTAKE_OUTCOME_NOTICE_FAILED (the provider refused it — the portal still
// shows the outcome). With email not configured nothing is sent and the
// answer says so.
//
// A QUOTE's award or decline (projects-tab MON-10, projects Round G J14)
// takes the same path, never a second one: `POST {orgId, costDocumentId}`
// tells the contact the org entered on the QUOTE link the quote came
// through (`cost_documents.intake_link_id` → `project_intake_links`, DEC-56)
// whether the quote was selected — the outcome read from
// `cost_documents.status` (`awarded` / `declined`; anything else is 409),
// one notice per quote, claimed, sent and recorded exactly as a
// submission's notice is (the same three audit actions, typed `cost` on the
// quote's id so they follow its project; the claim's `details.versionId` is
// the decided record's id — the quote's here — so 20261157's claim index
// keeps one email per attempt). The email says only what the portal says
// (selected or not): never the price, never the internal decline reason. A
// quote filed by hand (no link) has no contractor contact: 404, nothing sent.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { memberHoldsAny } from "@/lib/roleHeld";
import {
  intakeOutcomeEmail, quoteOutcomeEmail, OUTCOME_SEND_TIMEOUT_MS as SEND_TIMEOUT_MS, OUTCOME_STALE_CLAIM_MS as STALE_CLAIM_MS,
  type IntakeOutcome, type QuoteOutcome,
} from "@/lib/intakeOutcomeNotice";

export const runtime = "nodejs";
/** The reads, one claim, one provider call (at most SEND_TIMEOUT_MS) and one
 *  outcome row fit well inside this. */
export const maxDuration = 30;

const bad = (error: string, status: number) => NextResponse.json({ error }, { status });
const CLAIMED = "INTAKE_OUTCOME_NOTICE_CLAIMED";
const NOTIFIED = "INTAKE_OUTCOME_NOTIFIED";
const FAILED = "INTAKE_OUTCOME_NOTICE_FAILED";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(req: NextRequest) {
  let body: { orgId?: string; versionId?: string; costDocumentId?: string };
  try { body = await req.json(); } catch { return bad("Bad JSON", 400); }
  const orgId = String(body.orgId ?? "").trim();
  // MON-10: a quote's decision names the cost document instead of a version.
  const costDocumentId = body.costDocumentId == null ? null : String(body.costDocumentId).trim();
  if (costDocumentId !== null && body.versionId == null) {
    if (!UUID_RE.test(orgId) || !UUID_RE.test(costDocumentId)) return bad("orgId and costDocumentId required", 400);
    return quoteNotice(req, orgId, costDocumentId);
  }
  const versionId = String(body.versionId ?? "").trim();
  if (!UUID_RE.test(orgId) || !UUID_RE.test(versionId)) return bad("orgId and versionId required", 400);

  const who = await callerOf(req, orgId);
  if (who instanceof NextResponse) return who;
  const { userId, email, member: m } = who;

  // The submission as stored — the outcome is the database's, not the caller's.
  const { data: ver, error: verErr } = await supabaseAdmin.from("document_versions")
    .select("id, record_id, intake_link_id, review_state, review_note, released_at, revision_label")
    .eq("id", versionId).maybeSingle();
  if (verErr) return bad("The submission could not be read — try again.", 503);
  const v = ver as { id: string; record_id: string | null; intake_link_id: string | null; review_state: string | null; review_note?: string | null; released_at: string | null; revision_label?: string | null } | null;
  if (!v || !v.intake_link_id) return bad("No contractor submission with that id.", 404);

  const { data: link, error: linkErr } = await supabaseAdmin.from("project_intake_links")
    .select("id, org_id, project_id, company_name, contact_email").eq("id", v.intake_link_id).maybeSingle();
  if (linkErr) return bad("The submission's link could not be read — try again.", 503);
  const l = link as { id: string; org_id: string; project_id: string; company_name: string | null; contact_email: string | null } | null;
  if (!l || l.org_id !== orgId) return bad("No contractor submission with that id.", 404);

  const { data: project, error: projectErr } = await supabaseAdmin.from("projects")
    .select("id, name, owner_user_id").eq("id", l.project_id).eq("org_id", orgId).maybeSingle();
  if (projectErr) return bad("The project could not be read — try again.", 503);
  const p = project as { id: string; name: string | null; owner_user_id: string | null } | null;
  // ADD-1: authority by the role COLLECTION, never the headline alone.
  const mayDecide = memberHoldsAny(m, ["Admin", "DocCtrl"]) || (!!p && String(p.owner_user_id ?? "") === userId);
  if (!mayDecide) return bad("Only the project owner or a document controller can notify a contractor of a decision.", 403);

  const outcome: IntakeOutcome | null =
    v.review_state === "rejected" ? "rejected"
      : v.review_state === "approved" || (v.review_state == null && v.released_at != null) ? "approved"
        : null;
  if (!outcome) return bad("This submission has not been decided yet — nothing was sent.", 409);

  const to = (l.contact_email ?? "").trim();
  if (!to) return NextResponse.json({ sent: false, reason: "no_contact" });

  // One notice per submission (the claim → send → record sequence below,
  // shared with a quote's notice — MON-10).
  return claimSendRecord({
    orgId, userId, email, key: versionId,
    resourceType: "document", resourceId: v.record_id ?? versionId, to,
    details: { projectId: l.project_id, linkId: l.id, company: l.company_name ?? null, outcome },
    claimDetails: { projectId: l.project_id, linkId: l.id, outcome },
    mail: async () => {
      let docLabel = "your submission";
      if (v.record_id) {
        const { data: doc } = await supabaseAdmin.from("documents").select("document_number, title, name").eq("id", v.record_id).maybeSingle();
        const d = doc as { document_number?: string | null; title?: string | null; name?: string | null } | null;
        const n = (d?.document_number ?? "").trim();
        const t = (d?.title ?? d?.name ?? "").trim();
        if (n || t) docLabel = [n, t].filter(Boolean).join(" — ");
      }
      return intakeOutcomeEmail({
        outcome, company: l.company_name ?? null, projectName: p?.name ?? null,
        document: docLabel, revision: v.revision_label ?? null, reason: v.review_note ?? null,
      });
    },
    outcome,
  });
}

type Member = { role?: string; roles?: string[] | null; status?: string };

/** The signed-in caller and their membership of `orgId`: a bearer token,
 *  its user, and an ACTIVE membership (503 when it cannot be read). */
async function callerOf(req: NextRequest, orgId: string): Promise<NextResponse | { userId: string; email: string | null; member: Member }> {
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return bad("Not signed in", 401);
  const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
  if (userErr || !userData?.user) return bad("Not signed in", 401);
  const { data: member, error: memberErr } = await supabaseAdmin
    .from("org_members").select("role, roles, status").eq("org_id", orgId).eq("uid", userData.user.id).maybeSingle();
  if (memberErr) return bad("Your membership could not be checked — try again.", 503);
  const m = member as Member | null;
  if (!m || m.status !== "active") return bad("Not a member of this workspace.", 403);
  return { userId: userData.user.id, email: userData.user.email ?? null, member: m };
}

/**
 * MON-10 (projects Round G J14): the contractor's notice of a QUOTE's award
 * or decline, through this route's own claim → send → record sequence (the
 * header above). Who may send it: the people who may award or decline it —
 * an org controller held additively, or the project's owner (the Costs tab
 * offers Award and Decline to exactly them).
 */
async function quoteNotice(req: NextRequest, orgId: string, costDocumentId: string): Promise<NextResponse> {
  const who = await callerOf(req, orgId);
  if (who instanceof NextResponse) return who;
  const { userId, email, member: m } = who;

  // The quote as stored — the outcome is the database's, not the caller's.
  const { data: docRow, error: docErr } = await supabaseAdmin.from("cost_documents")
    .select("id, org_id, project_id, kind, status, vendor_name, rfq_group, intake_link_id").eq("id", costDocumentId).maybeSingle();
  if (docErr) return bad("The quote could not be read — try again.", 503);
  const d = docRow as { id: string; org_id: string; project_id: string; kind: string | null; status: string | null; vendor_name: string | null; rfq_group: string | null; intake_link_id: string | null } | null;
  if (!d || d.org_id !== orgId || d.kind !== "quote" || !d.intake_link_id) return bad("No contractor quote with that id.", 404);

  const { data: link, error: linkErr } = await supabaseAdmin.from("project_intake_links")
    .select("id, org_id, project_id, company_name, contact_email").eq("id", d.intake_link_id).maybeSingle();
  if (linkErr) return bad("The quote's link could not be read — try again.", 503);
  const l = link as { id: string; org_id: string; project_id: string; company_name: string | null; contact_email: string | null } | null;
  if (!l || l.org_id !== orgId) return bad("No contractor quote with that id.", 404);

  const { data: project, error: projectErr } = await supabaseAdmin.from("projects")
    .select("id, name, owner_user_id").eq("id", d.project_id).eq("org_id", orgId).maybeSingle();
  if (projectErr) return bad("The project could not be read — try again.", 503);
  const p = project as { id: string; name: string | null; owner_user_id: string | null } | null;
  // ADD-1: authority by the role COLLECTION, never the headline alone.
  const mayDecide = memberHoldsAny(m, ["Admin", "DocCtrl"]) || (!!p && String(p.owner_user_id ?? "") === userId);
  if (!mayDecide) return bad("Only the project owner or a document controller can notify a contractor of a decision.", 403);

  const outcome: QuoteOutcome | null = d.status === "awarded" ? "awarded" : d.status === "declined" ? "declined" : null;
  // `reason: "undecided"` lets the Costs tab ask about every rival an award
  // may have declined and skip the ones it did not (still open).
  if (!outcome) return NextResponse.json({ error: "This quote has not been awarded or declined — nothing was sent.", reason: "undecided" }, { status: 409 });

  const to = (l.contact_email ?? "").trim();
  if (!to) return NextResponse.json({ sent: false, reason: "no_contact" });

  return claimSendRecord({
    orgId, userId, email, key: costDocumentId, resourceType: "cost", resourceId: costDocumentId, to,
    details: { costDocumentId, projectId: d.project_id, linkId: l.id, company: l.company_name ?? null, outcome },
    claimDetails: { costDocumentId, projectId: d.project_id, linkId: l.id, outcome },
    mail: async () => quoteOutcomeEmail({
      outcome, company: l.company_name ?? null, projectName: p?.name ?? null, vendorName: d.vendor_name, rfqGroup: d.rfq_group,
    }),
    outcome,
  });
}

/** One notice per decided record: what it has done so far, a stale claim
 *  closed, the claim, the send, the outcome row — the submission's sequence
 *  above, for a record keyed by `key` (written as `details.versionId`, the
 *  key 20261157's claim index reads). */
async function claimSendRecord(n: {
  orgId: string; userId: string; email: string | null; key: string;
  resourceType: string; resourceId: string; to: string;
  details: Record<string, unknown>; claimDetails: Record<string, unknown>;
  mail: () => Promise<{ subject: string; text: string }>; outcome: string;
}): Promise<NextResponse> {
  const { orgId, userId, key } = n;
  const { data: prior, error: priorErr } = await supabaseAdmin.from("audit_logs").select("action, details, timestamp")
    .eq("org_id", orgId).in("action", [NOTIFIED, CLAIMED, FAILED]).eq("resource_id", n.resourceId)
    .contains("details", { versionId: key }).limit(1000);
  if (priorErr) return bad("Whether the contractor was already told could not be checked — nothing was sent; try again.", 503);
  const done = (prior ?? []) as Array<{ action?: string; details?: { attempt?: unknown } | null; timestamp?: string | null }>;
  if (done.some((r) => r.action === NOTIFIED)) return NextResponse.json({ sent: false, reason: "already" });
  const attemptOf = (r: (typeof done)[number]) => {
    const v = Number(r.details?.attempt);
    return Number.isInteger(v) && v > 0 ? v : 0;
  };
  const settled = new Set(done.filter((r) => r.action === FAILED).map(attemptOf));
  const claimRows = done.filter((r) => r.action === CLAIMED);
  const open = claimRows.filter((r) => !settled.has(attemptOf(r)));
  const claimedAt = (r: (typeof done)[number]) => Date.parse(r.timestamp ?? "");
  // A claim with no outcome after it: a send under way — never a second
  // email — unless it is stale (its function is long dead; see above). A
  // claim whose time cannot be read counts as under way.
  if (open.some((r) => !(Date.now() - claimedAt(r) >= STALE_CLAIM_MS))) {
    return NextResponse.json({ sent: false, reason: "in_progress" });
  }

  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) return NextResponse.json({ sent: false, reason: "not_configured" });
  const fromEmail = process.env.RESEND_FROM_EMAIL || "notifications@manufacturing-os.app";
  const mail = await n.mail();

  // A stale claim's attempt is recorded as failed — the send died — so the
  // trail says what happened to it, and it never counts as under way again.
  for (const r of open) {
    const { error: staleErr } = await supabaseAdmin.from("audit_logs").insert({
      action: FAILED, resource_type: n.resourceType, resource_id: n.resourceId,
      org_id: orgId, user_id: userId, user_email: n.email,
      details: {
        versionId: key, attempt: attemptOf(r), ...n.details,
        error: `The send claimed at ${r.timestamp} never finished (no outcome after ${STALE_CLAIM_MS / 60_000} minutes) — treated as failed.`,
        stale: true,
      },
    });
    if (staleErr) return bad("A stalled earlier notice could not be closed on the record — nothing was sent; try again.", 503);
  }

  // The claim, before the send: one caller per attempt (20261157's unique
  // index); the loser sends nothing.
  const attempt = Math.max(0, ...claimRows.map(attemptOf)) + 1;
  const { error: claimErr } = await supabaseAdmin.from("audit_logs").insert({
    action: CLAIMED, resource_type: n.resourceType, resource_id: n.resourceId,
    org_id: orgId, user_id: userId, user_email: n.email,
    details: { versionId: key, attempt, ...n.claimDetails },
  });
  if (claimErr) {
    if ((claimErr as { code?: string | null }).code === "23505") return NextResponse.json({ sent: false, reason: "in_progress" });
    return bad("The notice could not be recorded before sending — nothing was sent; try again.", 503);
  }

  let sendError: string | null = null;
  try {
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${resendKey}` },
      body: JSON.stringify({ from: fromEmail, to: n.to, subject: mail.subject, text: mail.text }),
      // A hang is a failed send — recorded below, freeing the next attempt —
      // never a claim left open by a function killed at its limit.
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (!resp.ok) sendError = `Resend ${resp.status}: ${(await resp.text()).slice(0, 300)}`;
  } catch (e) {
    const name = (e as { name?: string } | null)?.name;
    sendError = name === "TimeoutError" || name === "AbortError"
      ? `Resend did not answer within ${SEND_TIMEOUT_MS / 1000} s — the send was abandoned.`
      : (e as Error)?.message ?? String(e);
  }

  const { error: auditErr } = await supabaseAdmin.from("audit_logs").insert({
    action: sendError ? FAILED : NOTIFIED,
    resource_type: n.resourceType, resource_id: n.resourceId,
    org_id: orgId, user_id: userId, user_email: n.email,
    details: { versionId: key, attempt, ...n.details, ...(sendError ? { error: sendError } : {}) },
  });
  if (auditErr) console.error(`[intake/outcome-notice] audit row for ${key} failed: ${auditErr.message}`);
  if (sendError) {
    console.error(`[intake/outcome-notice] ${key}: ${sendError}`);
    return NextResponse.json({ sent: false, reason: "send_failed" }, { status: 502 });
  }
  return NextResponse.json({ sent: true, outcome: n.outcome });
}
