// POST /api/projects/deliverable-reference  { orgId, documentId, versionId }
//
// drafting-flow PROJ-1 (projects-joint J21; GAP-114; DEC-40 — reference, never
// copy). A drafting request's deliverable published INTO document review
// becomes the controlled revision when that review completes
// (lib/reviewControl.ts finalizeReviewedRevision, in the finalizer's browser).
// The finalizer's page then asks this route — started, never awaited by the
// publish (lib/reviewDeliverableReference.ts) — to put the document on the
// request's project register: the SAME project_documents reference, by the
// SAME register policy, that DF-P8's /api/tickets/handback writes for a
// deliverable published outside review (lib/ticketProject.ts
// referenceDeliverableInProject). Nothing is trusted from the body beyond
// the three ids:
//   1. the caller is authenticated and an ACTIVE member of the version's
//      workspace (else 401 / 403);
//   2. the version is read as the service role: in that workspace, of that
//      document, carrying a request (`related_ticket_id`, written by the
//      publish path — 20261049 / DF-P15) — no request: nothing owed;
//   3. the review COMPLETED: the document's current_version_id is this
//      version (else nothing owed — a review still open, or rejected);
//   4. the request is in the same workspace and names a project
//      (tickets.project_id, 20261256) — none, or the column not pasted
//      (42703 / PGRST204): nothing owed, today's path;
//   5. the register policy's own answer (DF-P8 fix pass 2 / 3; PM-8 /
//      SEC-17, 20261102 project_documents_insert): the authority recorded
//      when the request was put on THIS project
//      (metadata.project_link.registerAuthority — recordedRegisterAuthority),
//      else the FINALIZER's own (is_org_controller / can_manage_project,
//      asked AS THE CALLER — callerHoldsRegisterAuthority). No: nothing is
//      written; unknown: nothing is written;
//   6. referenceDeliverableInProject as the service role: an
//      ignoreDuplicates upsert (a document already on the register is left
//      exactly as it is) and the feed row (doc_added only for an actor the
//      feed's own rule admits — callerMayStampDocAdded — else
//      request_deliverable_referenced).
// A reference NOT written for a reason other than "nothing owed" is RECORDED
// on the request's audit trail (TICKET_DELIVERABLE_REFERENCE_NOT_WRITTEN,
// checked; its own failure is logged) and SAID in `warning` (DEC-90 ruling (1)
// for J21: record / retry, said). A refused write answers 503 so the page
// retries once; a refusal for want of authority answers 200 (no retry can
// change it). The review itself is never touched here.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { callerScopedClient } from "@/lib/serverAuth";
import {
  callerHoldsRegisterAuthority, callerMayStampDocAdded, isMissingProjectColumn, recordedRegisterAuthority,
  referenceDeliverableInProject, PROJECT_REGISTER_MANAGERS_ONLY,
} from "@/lib/ticketProject";

export const runtime = "nodejs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const bad = (error: string, status: number) => NextResponse.json({ ok: false, error }, { status });
const nothingOwed = (skipped: string) => NextResponse.json({ ok: true, referenced: false, skipped });

/** The warning when the finalizer's authority could not be confirmed. */
export const REGISTER_AUTHORITY_UNCONFIRMED =
  "The reviewed deliverable was not put on its request's project register: your authority over the register could not be confirmed — a project manager can attach it from the project's Documents card.";

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return bad("Unauthorized", 401);
  const { data: { user: caller }, error: authError } = await supabaseAdmin.auth.getUser(authHeader.slice(7));
  if (authError || !caller) return bad("Unauthorized", 401);

  let body: { orgId?: unknown; documentId?: unknown; versionId?: unknown };
  try { body = await req.json(); } catch { return bad("Invalid JSON body", 400); }
  const documentId = typeof body.documentId === "string" ? body.documentId : "";
  const versionId = typeof body.versionId === "string" ? body.versionId : "";
  if (!UUID.test(documentId) || !UUID.test(versionId)) return bad("documentId and versionId are required", 400);

  // 2. the version — the publish path's provenance, never the body's word
  const { data: ver, error: verErr } = await supabaseAdmin.from("document_versions")
    .select("id, org_id, record_id, revision_label, related_ticket_id").eq("id", versionId).maybeSingle();
  if (verErr) return bad("The document register could not be read — try again in a moment", 503);
  const v = ver as { id: string; org_id: string | null; record_id: string; revision_label: string | null; related_ticket_id: string | null } | null;
  if (!v || v.record_id !== documentId || !v.org_id) return bad("That revision was not found", 404);

  // 1. an active member of the version's workspace
  const { data: member, error: memErr } = await supabaseAdmin.from("org_members")
    .select("uid, email, role").eq("org_id", v.org_id).eq("uid", caller.id).eq("status", "active").maybeSingle();
  if (memErr) return bad("Your membership could not be confirmed — try again in a moment", 503);
  if (!member) return bad("Forbidden: not an active member of this workspace", 403);
  if (!v.related_ticket_id) return nothingOwed("not_from_request");

  // 3. the review completed: this version is the controlled revision now
  const { data: doc, error: docErr } = await supabaseAdmin.from("documents")
    .select("id, org_id, current_version_id").eq("id", documentId).maybeSingle();
  if (docErr) return bad("The document could not be read — try again in a moment", 503);
  const d = doc as { id: string; org_id: string | null; current_version_id: string | null } | null;
  if (!d || d.org_id !== v.org_id) return bad("That revision was not found", 404);
  if (d.current_version_id !== v.id) return nothingOwed("not_current");

  // 4. the request and its project
  const { data: tk, error: tkErr } = await supabaseAdmin.from("tickets")
    .select("id, org_id, ticket_id, project_id, metadata").eq("id", v.related_ticket_id).maybeSingle();
  if (tkErr) {
    if (isMissingProjectColumn(tkErr)) return nothingOwed("not_migrated");
    return bad("The drafting request could not be read — try again in a moment", 503);
  }
  const t = tk as { id: string; org_id: string; ticket_id: string | null; project_id: string | null; metadata: Record<string, unknown> | null } | null;
  if (!t || t.org_id !== v.org_id) return nothingOwed("not_from_request");
  if (typeof t.project_id !== "string" || !t.project_id) return nothingOwed("no_project");
  const projectId = t.project_id;
  const actorName = (member.email as string | null) || caller.email || null;

  /** Recorded on the request's audit trail — checked; its own failure is logged. */
  const recordNotWritten = async (reason: string, error?: string) => {
    const { error: aErr } = await supabaseAdmin.from("audit_logs").insert({
      action: "TICKET_DELIVERABLE_REFERENCE_NOT_WRITTEN", resource_type: "ticket", resource_id: t.id, org_id: t.org_id,
      user_id: caller.id, user_email: actorName, user_role: (member.role as string | null) ?? null,
      details: { documentId, versionId, projectId, reason, via: "review_completed", ...(error ? { error } : {}) },
    });
    if (aErr) console.error(`[deliverable-reference] ${t.id}: the record that the reference was not written (${reason}) could not be written: ${aErr.message}`);
  };

  // 5. the register policy's own answer for the person behind it
  const callerClient = callerScopedClient(req);
  let may: boolean | null = recordedRegisterAuthority(t.metadata, projectId);
  if (!may) may = "error" in callerClient ? null : await callerHoldsRegisterAuthority(callerClient, t.org_id, projectId);
  if (may !== true) {
    const warning = may === null ? REGISTER_AUTHORITY_UNCONFIRMED : PROJECT_REGISTER_MANAGERS_ONLY;
    await recordNotWritten(may === null ? "authority_unconfirmed" : "no_register_authority");
    console.warn(`[deliverable-reference] ${t.id}: ${warning}`);
    return NextResponse.json({ ok: true, referenced: false, warning });
  }

  // 6. the reference (DEC-40) and its feed row
  const stamp = "error" in callerClient ? false : await callerMayStampDocAdded(callerClient, t.org_id, projectId);
  const { data: before } = await supabaseAdmin.from("project_documents").select("id").eq("project_id", projectId).eq("document_id", documentId).maybeSingle();
  const refErr = await referenceDeliverableInProject(supabaseAdmin, {
    orgId: t.org_id, projectId, documentId, ticketId: t.id, ticketNumber: t.ticket_id ?? null,
    revisionLabel: v.revision_label ?? null, actorId: caller.id, actorName, actorMayStampDocAdded: stamp,
  });
  if (refErr) {
    // Was the register row written and only its feed row refused?
    const { data: after } = await supabaseAdmin.from("project_documents").select("id").eq("project_id", projectId).eq("document_id", documentId).maybeSingle();
    if (after) {
      const warning = `The reviewed deliverable was put on its request's project register, but the project's feed was not told: ${refErr}`;
      console.warn(`[deliverable-reference] ${t.id}: ${warning}`);
      return NextResponse.json({ ok: true, referenced: !before, warning });
    }
    await recordNotWritten("write_refused", refErr);
    console.error(`[deliverable-reference] ${t.id}: the register reference was not written: ${refErr}`);
    return NextResponse.json({ ok: false, referenced: false, error: refErr, warning: `The reviewed deliverable was not put on its request's project register: ${refErr} — a project manager can attach it from the project's Documents card.` }, { status: 503 });
  }
  return before ? nothingOwed("already_referenced") : NextResponse.json({ ok: true, referenced: true });
}
