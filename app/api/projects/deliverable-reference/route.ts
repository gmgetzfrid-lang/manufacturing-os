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
//   4. the caller is the one who COMPLETED it, just now (J21 fix pass — the
//      route is tied to the act, never to the revision's lasting state, so it
//      is no standing, replayable door): the promote's own release stamp
//      (document_versions.released_at, written in the promote) is at most
//      FINALIZER_WINDOW_MS old, AND the promote names the caller — the
//      document's updated_by (finalize_reviewed_promote writes auth.uid();
//      the three-step path the actor) or the caller's own
//      REVISION_PUBLISHED_AFTER_REVIEW row for this version. Else nothing
//      owed ("not_finalizer");
//   5. the request is in the same workspace and names a project
//      (tickets.project_id, 20261256) — none, or the column not pasted
//      (42703 / PGRST204): nothing owed, today's path. The caller's read of
//      the request is asked (AUTHZ-13's ticketReadScope, as
//      /api/tickets/project-link asks it): a caller outside it gets an
//      answer with no detail, and nothing is recorded on the request;
//   6. a deliberate detach is never undone: a detach of this document from
//      this project dated after the promote (the register record's
//      PROJECT_DOCUMENT_DETACHED row, 20261262, or the Documents card's
//      doc_removed feed row) → nothing owed ("detached_since");
//   7. the register policy's own answer (DF-P8 fix pass 2 / 3; PM-8 /
//      SEC-17, 20261102 project_documents_insert): the authority recorded
//      when the request was put on THIS project
//      (metadata.project_link.registerAuthority — recordedRegisterAuthority),
//      else the FINALIZER's own (is_org_controller / can_manage_project,
//      asked AS THE CALLER — callerHoldsRegisterAuthority). No: nothing is
//      written; unknown: nothing is written;
//   8. referenceDeliverableInProject as the service role: an
//      ignoreDuplicates upsert (a document already on the register is left
//      exactly as it is) and the feed row (doc_added only for an actor the
//      feed's own rule admits — callerMayStampDocAdded — else
//      request_deliverable_referenced).
// A reference NOT written for a reason other than "nothing owed" is RECORDED
// on the request's audit trail (TICKET_DELIVERABLE_REFERENCE_NOT_WRITTEN,
// checked; its own failure is logged; user_role NULL — DEC-91: the route
// admits by membership, so no role is the one acted under) and SAID in
// `warning` (DEC-90 ruling (1) for J21: record / retry, said). A refused write
// answers 503 so the page retries once; a refusal for want of authority
// answers 200 (no retry can change it). The review itself is never touched
// here.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { callerScopedClient } from "@/lib/serverAuth";
import { ticketReadScope } from "@/lib/ticketReadScope";
import {
  callerHoldsRegisterAuthority, callerMayStampDocAdded, isMissingProjectColumn, recordedRegisterAuthority,
  referenceDeliverableInProject, PROJECT_REGISTER_MANAGERS_ONLY,
} from "@/lib/ticketProject";

export const runtime = "nodejs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const bad = (error: string, status: number) => NextResponse.json({ ok: false, error }, { status });
const nothingOwed = (skipped: string) => NextResponse.json({ ok: true, referenced: false, skipped });
/** The answer to a caller who cannot read the request: no detail (AUTHZ-13). */
const opaque = () => NextResponse.json({ ok: true });

/** How long after the promote its finalizer's page may ask (step 4). The page
 *  asks at once and retries once after 2 s; the window absorbs a slow network
 *  and a browser clock that is off (the three-step path stamps released_at
 *  from the browser). */
export const FINALIZER_WINDOW_MS = 10 * 60 * 1000;

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
    .select("id, org_id, record_id, revision_label, related_ticket_id, released_at").eq("id", versionId).maybeSingle();
  if (verErr) return bad("The document register could not be read — try again in a moment", 503);
  const v = ver as { id: string; org_id: string | null; record_id: string; revision_label: string | null; related_ticket_id: string | null; released_at?: string | null } | null;
  if (!v || v.record_id !== documentId || !v.org_id) return bad("That revision was not found", 404);

  // 1. an active member of the version's workspace
  const { data: member, error: memErr } = await supabaseAdmin.from("org_members")
    .select("uid, email, role, roles").eq("org_id", v.org_id).eq("uid", caller.id).eq("status", "active").maybeSingle();
  if (memErr) return bad("Your membership could not be confirmed — try again in a moment", 503);
  if (!member) return bad("Forbidden: not an active member of this workspace", 403);
  const m = member as { uid: string; email: string | null; role: string | null; roles: string[] | null };
  if (!v.related_ticket_id) return nothingOwed("not_from_request");

  // 3. the review completed: this version is the controlled revision now
  const { data: doc, error: docErr } = await supabaseAdmin.from("documents")
    .select("id, org_id, current_version_id, updated_by").eq("id", documentId).maybeSingle();
  if (docErr) return bad("The document could not be read — try again in a moment", 503);
  const d = doc as { id: string; org_id: string | null; current_version_id: string | null; updated_by?: string | null } | null;
  if (!d || d.org_id !== v.org_id) return bad("That revision was not found", 404);
  if (d.current_version_id !== v.id) return nothingOwed("not_current");

  // 4. the caller completed the review, just now — the act, not the state
  const releasedMs = v.released_at ? Date.parse(v.released_at) : NaN;
  if (!Number.isFinite(releasedMs) || Math.abs(Date.now() - releasedMs) > FINALIZER_WINDOW_MS) return nothingOwed("not_finalizer");
  if (d.updated_by !== caller.id) {
    const { data: own, error: ownErr } = await supabaseAdmin.from("audit_logs").select("id")
      .eq("action", "REVISION_PUBLISHED_AFTER_REVIEW").eq("resource_type", "document").eq("resource_id", documentId)
      .eq("user_id", caller.id).eq("details->>versionId", versionId).limit(1);
    if (ownErr) return bad("Whether you completed this review could not be confirmed — try again in a moment", 503);
    if (!Array.isArray(own) || own.length === 0) return nothingOwed("not_finalizer");
  }
  const sinceIso = new Date(releasedMs).toISOString();

  // 5. the request, the caller's read of it, and its project
  const { data: tk, error: tkErr } = await supabaseAdmin.from("tickets")
    .select("id, org_id, ticket_id, project_id, metadata, requester_id, assigned_drafter_id, assigned_engineer_id, watchers").eq("id", v.related_ticket_id).maybeSingle();
  if (tkErr) {
    if (isMissingProjectColumn(tkErr)) return nothingOwed("not_migrated");
    return bad("The drafting request could not be read — try again in a moment", 503);
  }
  const t = tk as {
    id: string; org_id: string; ticket_id: string | null; project_id: string | null; metadata: Record<string, unknown> | null;
    requester_id: string | null; assigned_drafter_id: string | null; assigned_engineer_id: string | null; watchers: string[] | null;
  } | null;
  if (!t || t.org_id !== v.org_id) return nothingOwed("not_from_request");
  const scope = await ticketReadScope(supabaseAdmin, m, caller.id, {
    id: t.id, requesterId: t.requester_id, assignedDrafterId: t.assigned_drafter_id, assignedEngineerId: t.assigned_engineer_id, watchers: t.watchers,
  });
  if (scope === "unknown") return bad("Whether you can see the drafting request could not be confirmed — try again in a moment", 503);
  const reads = scope === "in";
  if (typeof t.project_id !== "string" || !t.project_id) return reads ? nothingOwed("no_project") : opaque();
  const projectId = t.project_id;
  const actorName = m.email || caller.email || null;

  // 6. a deliberate detach since the promote is never undone
  const [detachRec, detachFeed] = await Promise.all([
    supabaseAdmin.from("audit_logs").select("id")
      .eq("action", "PROJECT_DOCUMENT_DETACHED").eq("resource_type", "project").eq("resource_id", projectId)
      .eq("details->>documentId", documentId).gte("timestamp", sinceIso).limit(1),
    supabaseAdmin.from("project_activity").select("id")
      .eq("project_id", projectId).eq("type", "doc_removed").eq("metadata->>documentId", documentId).gte("created_at", sinceIso).limit(1),
  ]);
  if (detachRec.error || detachFeed.error) return bad("The project's register history could not be read — try again in a moment", 503);
  if ((Array.isArray(detachRec.data) && detachRec.data.length > 0) || (Array.isArray(detachFeed.data) && detachFeed.data.length > 0)) {
    return reads ? nothingOwed("detached_since") : opaque();
  }

  /** Recorded on the request's audit trail — only for a caller who can read
   *  the request; checked; its own failure is logged. */
  const recordNotWritten = async (reason: string, error?: string) => {
    if (!reads) {
      console.warn(`[deliverable-reference] ${t.id}: the reference was not written (${reason}); the finalizer cannot read the request, so nothing is recorded on it`);
      return;
    }
    const { error: aErr } = await supabaseAdmin.from("audit_logs").insert({
      action: "TICKET_DELIVERABLE_REFERENCE_NOT_WRITTEN", resource_type: "ticket", resource_id: t.id, org_id: t.org_id,
      user_id: caller.id, user_email: actorName, user_role: null,
      details: { documentId, versionId, projectId, reason, via: "review_completed", ...(error ? { error } : {}) },
    });
    if (aErr) console.error(`[deliverable-reference] ${t.id}: the record that the reference was not written (${reason}) could not be written: ${aErr.message}`);
  };

  // 7. the register policy's own answer for the person behind it
  const callerClient = callerScopedClient(req);
  let may: boolean | null = recordedRegisterAuthority(t.metadata, projectId);
  if (!may) may = "error" in callerClient ? null : await callerHoldsRegisterAuthority(callerClient, t.org_id, projectId);
  if (may !== true) {
    const warning = may === null ? REGISTER_AUTHORITY_UNCONFIRMED : PROJECT_REGISTER_MANAGERS_ONLY;
    await recordNotWritten(may === null ? "authority_unconfirmed" : "no_register_authority");
    console.warn(`[deliverable-reference] ${t.id}: ${warning}`);
    return reads ? NextResponse.json({ ok: true, referenced: false, warning }) : opaque();
  }

  // 8. the reference (DEC-40) and its feed row
  const stamp = "error" in callerClient ? false : await callerMayStampDocAdded(callerClient, t.org_id, projectId);
  const { data: before, error: beforeErr } = await supabaseAdmin.from("project_documents").select("id").eq("project_id", projectId).eq("document_id", documentId).maybeSingle();
  // A failed read is "unknown", never "not there": `referenced` is then left out.
  const wasThere: boolean | undefined = beforeErr ? undefined : !!before;
  const refErr = await referenceDeliverableInProject(supabaseAdmin, {
    orgId: t.org_id, projectId, documentId, ticketId: t.id, ticketNumber: t.ticket_id ?? null,
    revisionLabel: v.revision_label ?? null, actorId: caller.id, actorName, actorMayStampDocAdded: stamp,
  });
  if (refErr) {
    // Was the register row written and only its feed row refused?
    const { data: after, error: afterErr } = await supabaseAdmin.from("project_documents").select("id").eq("project_id", projectId).eq("document_id", documentId).maybeSingle();
    if (afterErr) {
      // Unknown whether the row landed: said, never recorded as refused.
      const warning = `Whether the reviewed deliverable is on its request's project register could not be confirmed (${refErr}) — check the project's Documents card.`;
      console.warn(`[deliverable-reference] ${t.id}: ${warning} (re-read: ${afterErr.message})`);
      return reads ? NextResponse.json({ ok: true, warning }) : opaque();
    }
    if (after) {
      const warning = `The reviewed deliverable was put on its request's project register, but the project's feed was not told: ${refErr}`;
      console.warn(`[deliverable-reference] ${t.id}: ${warning}`);
      return reads ? NextResponse.json({ ok: true, ...(wasThere === undefined ? {} : { referenced: !wasThere }), warning }) : opaque();
    }
    await recordNotWritten("write_refused", refErr);
    console.error(`[deliverable-reference] ${t.id}: the register reference was not written: ${refErr}`);
    if (!reads) return NextResponse.json({ ok: false }, { status: 503 });
    return NextResponse.json({ ok: false, referenced: false, error: refErr, warning: `The reviewed deliverable was not put on its request's project register: ${refErr} — a project manager can attach it from the project's Documents card.` }, { status: 503 });
  }
  if (!reads) return opaque();
  if (wasThere === undefined) return NextResponse.json({ ok: true });
  return wasThere ? nothingOwed("already_referenced") : NextResponse.json({ ok: true, referenced: true });
}
