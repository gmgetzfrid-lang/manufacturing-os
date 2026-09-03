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
  if (!src?.id) return bad("This request was not raised against a controlled document", 400);

  // The proof: a version row of the SOURCE document, in this org, carrying this
  // ticket as its provenance. The publish path wrote it; nothing here can.
  const { data: version } = await supabaseAdmin
    .from("document_versions")
    .select("id, org_id, record_id, revision_label, related_ticket_id, review_state, created_by")
    .eq("id", versionId).maybeSingle();
  const v = version as {
    id: string; org_id: string | null; record_id: string; revision_label: string;
    related_ticket_id: string | null; review_state: string | null; created_by: string | null;
  } | null;
  if (!v || v.org_id !== ticket.orgId || v.record_id !== src.id || v.related_ticket_id !== ticketId) {
    return bad("That revision is not this request's deliverable", 409);
  }

  const now = new Date().toISOString();
  const callerEmail = (member.email as string | null) || caller.email || "Unknown";
  const inReview = v.review_state === "in_review";
  const metadata = publishedDeliverable(ticket.metadata, {
    versionId: v.id, revisionLabel: v.revision_label, documentId: src.id, publishedBy: caller.id, now,
  });
  if (inReview) (metadata.deliverable as Record<string, unknown>).in_review = true;
  const docLabel = src.documentNumber || "the source document";
  const entry: TicketHistoryEntry = {
    action: inReview ? "Deliverable submitted for document review" : "Deliverable published to the register",
    user: callerEmail,
    role: (member.role as TicketHistoryEntry["role"]) ?? undefined,
    date: now,
    details: inReview
      ? `Draft ${v.revision_label} of ${docLabel} opened for reviewer sign-off from this request's Final deliverable.`
      : `Rev ${v.revision_label} of ${docLabel} — published from this request's Final deliverable.`,
  };
  const history = [...(ticket.history ?? []), entry];

  let q = supabaseAdmin.from("tickets").update({ metadata, history, last_modified: now }).eq("id", ticketId);
  if (ticket.lastModified) q = q.eq("last_modified", String(ticket.lastModified));
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
    details: { versionId: v.id, revisionLabel: v.revision_label, documentId: src.id, documentNumber: src.documentNumber ?? null, inReview },
  });
  if (auditErr) return NextResponse.json({ ok: true, metadata, history, warning: `Recorded, but the audit row failed: ${auditErr.message}` });

  // Tell the requester (and whoever follows the ticket): the loop closed.
  try {
    const { emit } = await import("@/lib/notify/dispatch");
    const involved = [ticket.requesterId, ticket.assignedDrafterId, ticket.assignedEngineerId, ...(ticket.watchers ?? [])]
      .filter((u): u is string => typeof u === "string" && u.length > 0);
    await emit({
      orgId: ticket.orgId, category: "status", kind: "ticket_status",
      title: inReview ? `${ticket.ticketId}: deliverable submitted for document review` : `${ticket.ticketId}: deliverable published as Rev ${v.revision_label}`,
      body: entry.details,
      link: `/requests/${ticketId}`,
      resource: { type: "ticket", id: ticketId },
      actorUserId: caller.id, actorName: callerEmail.split("@")[0],
      audience: { involved },
    });
  } catch { /* the record is written; notification is best-effort */ }

  return NextResponse.json({ ok: true, metadata, history });
}
