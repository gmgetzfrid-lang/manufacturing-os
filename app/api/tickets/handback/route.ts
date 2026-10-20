// POST /api/tickets/handback
//
// GAP-6 / DEC-22: record on a drafting ticket that its Final deliverable was
// published as a revision of the ticket's source document. The publish itself
// already happened through `revUpDocument` — the ONLY publish path, with every
// guard and post-publish side effect — so this route records an outcome and
// trusts nothing in the body: the named version must exist in the ticket's
// org, belong to the ticket's source document, and carry
// `related_ticket_id = ticket` (the provenance 20261049 writes). Anything else
// is refused.
//
// drafting-flow DCW-4 (DF-P15): a request with NO source document but a
// target library (GAP-105) hands back through "Publish as a new document in
// <library>" — createDocumentWithFile({ …, relatedTicketId }), the new-
// document path, which records the ticket on the new document's first
// version. This route accepts that version too: in the ticket's org,
// carrying `related_ticket_id = ticket`, of a document that is in the
// ticket's library (in its org). A request with a source document is
// unchanged: only a version of that document is accepted.
//
// Body: { ticketId, versionId }

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { rowToTicket } from "@/lib/ticketTransitions";
import { parseSourceDocument } from "@/lib/sourceDocRef";
import { publishedDeliverable } from "@/lib/ticketHandback";
import type { TicketHistoryEntry } from "@/types/schema";

export const runtime = "nodejs";

interface Body { ticketId?: unknown; versionId?: unknown }

const bad = (error: string, status: number) => NextResponse.json({ error }, { status });

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return bad("Unauthorized", 401);
  const { data: { user: caller }, error: authError } = await supabaseAdmin.auth.getUser(authHeader.slice(7));
  if (authError || !caller) return bad("Unauthorized", 401);

  let body: Body;
  try { body = (await req.json()) as Body; } catch { return bad("Invalid JSON body", 400); }
  const ticketId = typeof body.ticketId === "string" ? body.ticketId : "";
  const versionId = typeof body.versionId === "string" ? body.versionId : "";
  if (!ticketId || !versionId) return bad("ticketId and versionId are required", 400);

  const { data: row } = await supabaseAdmin.from("tickets").select("*").eq("id", ticketId).maybeSingle();
  if (!row) return bad("Ticket not found", 404);
  const ticket = rowToTicket(row as Record<string, unknown>);

  const { data: member } = await supabaseAdmin
    .from("org_members").select("uid, email, role")
    .eq("org_id", ticket.orgId).eq("uid", caller.id).eq("status", "active").maybeSingle();
  if (!member) return bad("Forbidden: not an active member of this workspace", 403);

  const src = parseSourceDocument(ticket.metadata);
  // DCW-4 (DF-P15): no source document — the ticket's library is the target.
  const libraryId = !src?.id ? (ticket.libraryId ?? null) : null;
  if (!src?.id && !libraryId) return bad("This request was not raised against a controlled document and names no target library", 400);

  // The proof: a version row of the SOURCE document (or, for a library-only
  // request, of a document in its library), in this org, carrying this ticket
  // as its provenance. The publish path wrote it; nothing here can.
  const { data: version, error: versionErr } = await supabaseAdmin
    .from("document_versions")
    .select("id, org_id, record_id, revision_label, related_ticket_id, review_state, created_by")
    .eq("id", versionId).maybeSingle();
  if (versionErr && libraryId) return bad("The document register could not be read to confirm the deliverable — try again in a moment", 503);
  const v = version as {
    id: string; org_id: string | null; record_id: string; revision_label: string;
    related_ticket_id: string | null; review_state: string | null; created_by: string | null;
  } | null;
  if (!v || v.org_id !== ticket.orgId || v.related_ticket_id !== ticketId || (src?.id ? v.record_id !== src.id : false)) {
    return bad("That revision is not this request's deliverable", 409);
  }
  // A library-only request: the version's document must be in the ticket's
  // library, in its org, and its number names it on the request.
  let newDoc: { id: string; document_number: string | null; status: string | null } | null = null;
  if (libraryId) {
    const { data: docRow, error: docErr } = await supabaseAdmin
      .from("documents").select("id, document_number, status, library_id, org_id")
      .eq("id", v.record_id).maybeSingle();
    if (docErr) return bad("The document register could not be read to confirm the deliverable — try again in a moment", 503);
    const d = docRow as { id: string; document_number: string | null; status: string | null; library_id: string | null; org_id: string | null } | null;
    if (!d || d.org_id !== ticket.orgId || d.library_id !== libraryId) {
      return bad("That revision is not this request's deliverable", 409);
    }
    newDoc = { id: d.id, document_number: d.document_number, status: d.status };
  }

  const now = new Date().toISOString();
  const callerEmail = (member.email as string | null) || caller.email || "Unknown";
  const inReview = v.review_state === "in_review";
  const documentId = src?.id ?? v.record_id;
  const metadata = publishedDeliverable(ticket.metadata, {
    versionId: v.id, revisionLabel: v.revision_label, documentId, publishedBy: caller.id, now,
  });
  if (inReview) (metadata.deliverable as Record<string, unknown>).in_review = true;
  // DCW-4 (DF-P15): a new document filed as a Draft is in the register but
  // not issued — said on the request, never "published" bare.
  const filedAsDraft = !!newDoc && newDoc.status === "Draft";
  if (newDoc) {
    (metadata.deliverable as Record<string, unknown>).library_id = libraryId;
    (metadata.deliverable as Record<string, unknown>).new_document = true;
    if (filedAsDraft) (metadata.deliverable as Record<string, unknown>).filed_as_draft = true;
  }
  const docLabel = src?.documentNumber || newDoc?.document_number || (src?.id ? "the source document" : "the new document");
  const entry: TicketHistoryEntry = {
    action: inReview
      ? "Deliverable submitted for document review"
      : filedAsDraft ? "Deliverable filed in the register as a Draft" : "Deliverable published to the register",
    user: callerEmail,
    role: (member.role as TicketHistoryEntry["role"]) ?? undefined,
    date: now,
    details: inReview
      ? `Draft ${v.revision_label} of ${docLabel} opened for reviewer sign-off from this request's Final deliverable.`
      : newDoc
        ? filedAsDraft
          ? `${docLabel} created as a new document (Draft, not issued) from this request's Final deliverable.`
          : `${docLabel} Rev ${v.revision_label} — published as a new document from this request's Final deliverable.`
        : `Rev ${v.revision_label} of ${docLabel} — published from this request's Final deliverable.`,
  };
  const history = [...(ticket.history ?? []), entry];

  let q = supabaseAdmin.from("tickets").update({ metadata, history, last_modified: now }).eq("id", ticketId);
  // SM-9 / EDGE-15 (DF-P4): a row with no token compare-and-sets on the null
  // itself (the workflow route's leg since DF-P1) — the first writer stamps
  // it and a concurrent second matches no row (409) — never a write with no
  // compare-and-set at all.
  q = ticket.lastModified ? q.eq("last_modified", String(ticket.lastModified)) : q.is("last_modified", null);
  const { data: updated, error: updErr } = await q.select("id").maybeSingle();
  if (updErr) return bad(updErr.message, 500);
  if (!updated) return NextResponse.json({ error: "The ticket changed while you were acting — refresh and try again", conflict: true }, { status: 409 });

  // Audit — server-written; a failure here is reported, not swallowed.
  const { error: auditErr } = await supabaseAdmin.from("audit_logs").insert({
    action: inReview ? "TICKET_HANDBACK_REVIEW_OPENED" : "TICKET_HANDBACK_PUBLISHED",
    resource_id: ticketId,
    resource_type: "ticket",
    org_id: ticket.orgId,
    user_id: caller.id,
    user_email: callerEmail,
    user_role: (member.role as string | null) ?? null,
    details: { versionId: v.id, revisionLabel: v.revision_label, documentId, documentNumber: src?.documentNumber ?? newDoc?.document_number ?? null, inReview, ...(newDoc ? { newDocument: true, libraryId, initialStatus: newDoc.status } : {}) },
  });
  if (auditErr) return NextResponse.json({ ok: true, metadata, history, warning: `Recorded, but the audit row failed: ${auditErr.message}` });

  // Tell the requester (and whoever follows the ticket): the loop closed.
  // NEDGE-15 (notifications Round G, N6): emit() is written against the
  // shared client, which in a route handler is the anon key with no session
  // — its membership read returned nothing and the notice reached nobody. It
  // runs bound to the service role for this request only
  // (lib/serverClientScope.ts, as the cron and the intake door do), so the
  // active members it names get the bell row and the email; a suspended one
  // gets neither (NEDGE-3). A failure is logged, never fails the record.
  try {
    const [{ emit }, { runWithServerClient }] = await Promise.all([
      import("@/lib/notify/dispatch"), import("@/lib/serverClientScope"),
    ]);
    const involved = [ticket.requesterId, ticket.assignedDrafterId, ticket.assignedEngineerId, ...(ticket.watchers ?? [])]
      .filter((u): u is string => typeof u === "string" && u.length > 0);
    await runWithServerClient(supabaseAdmin, () => emit({
      orgId: ticket.orgId, category: "status", kind: "ticket_status",
      title: inReview
        ? `${ticket.ticketId}: deliverable submitted for document review`
        : filedAsDraft ? `${ticket.ticketId}: deliverable filed as a Draft document` : `${ticket.ticketId}: deliverable published as Rev ${v.revision_label}`,
      body: entry.details,
      link: `/requests/${ticketId}`,
      resource: { type: "ticket", id: ticketId },
      actorUserId: caller.id, actorName: callerEmail.split("@")[0],
      audience: { involved },
    }));
  } catch (e) {
    console.warn("[handback] the notice could not be sent (the handback is recorded):", (e as Error).message);
  }

  return NextResponse.json({ ok: true, metadata, history });
}
