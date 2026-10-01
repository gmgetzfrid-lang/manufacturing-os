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
// `in_progress`. A failed send frees the next attempt; a claim with no
// outcome row after it (the process died mid-send, or the outcome row could
// not be written) keeps answering `in_progress` — the system never risks
// a second email, and the portal shows the outcome whatever happens.
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

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { memberHoldsAny } from "@/lib/roleHeld";
import { intakeOutcomeEmail, type IntakeOutcome } from "@/lib/intakeOutcomeNotice";

export const runtime = "nodejs";

const bad = (error: string, status: number) => NextResponse.json({ error }, { status });
const CLAIMED = "INTAKE_OUTCOME_NOTICE_CLAIMED";
const NOTIFIED = "INTAKE_OUTCOME_NOTIFIED";
const FAILED = "INTAKE_OUTCOME_NOTICE_FAILED";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(req: NextRequest) {
  let body: { orgId?: string; versionId?: string };
  try { body = await req.json(); } catch { return bad("Bad JSON", 400); }
  const orgId = String(body.orgId ?? "").trim();
  const versionId = String(body.versionId ?? "").trim();
  if (!UUID_RE.test(orgId) || !UUID_RE.test(versionId)) return bad("orgId and versionId required", 400);

  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return bad("Not signed in", 401);
  const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
  if (userErr || !userData?.user) return bad("Not signed in", 401);
  const userId = userData.user.id;

  const { data: member, error: memberErr } = await supabaseAdmin
    .from("org_members").select("role, roles, status").eq("org_id", orgId).eq("uid", userId).maybeSingle();
  if (memberErr) return bad("Your membership could not be checked — try again.", 503);
  const m = member as { role?: string; roles?: string[] | null; status?: string } | null;
  if (!m || m.status !== "active") return bad("Not a member of this workspace.", 403);

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

  // One notice per submission: what this version's notice has done so far.
  const { data: prior, error: priorErr } = await supabaseAdmin.from("audit_logs").select("action")
    .eq("org_id", orgId).in("action", [NOTIFIED, CLAIMED, FAILED]).eq("resource_id", v.record_id ?? versionId)
    .contains("details", { versionId }).limit(1000);
  if (priorErr) return bad("Whether the contractor was already told could not be checked — nothing was sent; try again.", 503);
  const done = ((prior ?? []) as Array<{ action?: string }>).map((r) => r.action);
  if (done.includes(NOTIFIED)) return NextResponse.json({ sent: false, reason: "already" });
  const claims = done.filter((a) => a === CLAIMED).length;
  // A claim with no outcome after it: a send is under way (or died mid-way) — never a second email.
  if (claims > done.filter((a) => a === FAILED).length) return NextResponse.json({ sent: false, reason: "in_progress" });

  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) return NextResponse.json({ sent: false, reason: "not_configured" });
  const fromEmail = process.env.RESEND_FROM_EMAIL || "notifications@manufacturing-os.app";

  let docLabel = "your submission";
  if (v.record_id) {
    const { data: doc } = await supabaseAdmin.from("documents").select("document_number, title, name").eq("id", v.record_id).maybeSingle();
    const d = doc as { document_number?: string | null; title?: string | null; name?: string | null } | null;
    const n = (d?.document_number ?? "").trim();
    const t = (d?.title ?? d?.name ?? "").trim();
    if (n || t) docLabel = [n, t].filter(Boolean).join(" — ");
  }
  const mail = intakeOutcomeEmail({
    outcome, company: l.company_name ?? null, projectName: p?.name ?? null,
    document: docLabel, revision: v.revision_label ?? null, reason: v.review_note ?? null,
  });

  // The claim, before the send: one caller per attempt (20261157's unique
  // index); the loser sends nothing.
  const attempt = claims + 1;
  const { error: claimErr } = await supabaseAdmin.from("audit_logs").insert({
    action: CLAIMED, resource_type: "document", resource_id: v.record_id ?? versionId,
    org_id: orgId, user_id: userId, user_email: userData.user.email ?? null,
    details: { versionId, attempt, projectId: l.project_id, linkId: l.id, outcome },
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
      body: JSON.stringify({ from: fromEmail, to, subject: mail.subject, text: mail.text }),
    });
    if (!resp.ok) sendError = `Resend ${resp.status}: ${(await resp.text()).slice(0, 300)}`;
  } catch (e) {
    sendError = (e as Error)?.message ?? String(e);
  }

  const { error: auditErr } = await supabaseAdmin.from("audit_logs").insert({
    action: sendError ? FAILED : NOTIFIED,
    resource_type: "document", resource_id: v.record_id ?? versionId,
    org_id: orgId, user_id: userId, user_email: userData.user.email ?? null,
    details: { versionId, attempt, projectId: l.project_id, linkId: l.id, company: l.company_name ?? null, outcome, ...(sendError ? { error: sendError } : {}) },
  });
  if (auditErr) console.error(`[intake/outcome-notice] audit row for ${versionId} failed: ${auditErr.message}`);
  if (sendError) {
    console.error(`[intake/outcome-notice] ${versionId}: ${sendError}`);
    return NextResponse.json({ sent: false, reason: "send_failed" }, { status: 502 });
  }
  return NextResponse.json({ sent: true, outcome });
}
