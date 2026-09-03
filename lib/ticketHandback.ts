// lib/ticketHandback.ts
//
// GAP-6 / DEC-22: the drafting → document-control hand-back, as pure helpers.
// A ticket that was raised against a controlled document and produced a Final
// deliverable can be published as the document's next revision by whoever
// holds PUBLISH authority on that document's library — never by whoever can
// close tickets. These helpers pre-seed the existing rev-up flow (the file,
// the issue purpose per DEC-26, the MOC position captured at check-in per
// LIFE-5, a change log naming the ticket) and record the outcome on the
// ticket. They never publish anything themselves: `revUpDocument` does.

import type { DocumentVersion, Ticket, TicketAttachment } from "@/types/schema";

export type MocOrigin = { status: "completed" | "in_progress" | "none"; number: string | null };

export type DeliverableState =
  | { state: "published"; version_id: string; revision_label: string; document_id: string; published_at: string; published_by: string; in_review?: boolean }
  | { state: "not_in_register"; document_id: string; register_rev: string | null; noted_at: string };

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** Tolerant timestamp → ms (ISO string, Date, Firestore-style {seconds} / toDate()). */
export function toMillis(v: unknown): number {
  if (!v) return 0;
  if (v instanceof Date) return v.getTime();
  if (typeof v === "string" || typeof v === "number") { const t = new Date(v).getTime(); return Number.isFinite(t) ? t : 0; }
  const r = asRecord(v);
  if (r && typeof r.toDate === "function") { try { return (r.toDate as () => Date)().getTime(); } catch { return 0; } }
  if (r && typeof r.seconds === "number") return r.seconds * 1000;
  return 0;
}

/** The deliverable: the LATEST `Final` attachment (submit_final appends; the
 *  newest is the one the ticket is closing on). */
export function latestFinalAttachment(attachments?: TicketAttachment[] | null): TicketAttachment | null {
  const finals = (attachments ?? []).filter((a) => a && a.type === "Final" && typeof a.url === "string" && a.url.length > 0);
  if (finals.length === 0) return null;
  return [...finals].sort((a, b) => toMillis(b.uploadedAt) - toMillis(a.uploadedAt))[0];
}

/** LIFE-5: the MOC position the check-in captured (`metadata.moc`), or null
 *  when the ticket did not come from a check-in that asked. */
export function mocOriginOf(metadata: Record<string, unknown> | null | undefined): MocOrigin | null {
  const moc = asRecord(metadata?.moc);
  if (!moc) return null;
  const status = moc.status;
  if (status !== "completed" && status !== "in_progress" && status !== "none") return null;
  const number = typeof moc.number === "string" && moc.number.trim() ? moc.number.trim() : null;
  return { status, number: status === "none" ? null : number };
}

/** What the hand-back pre-seeds into the rev-up flow. */
export function handbackPreset(ticket: Pick<Ticket, "ticketId" | "title" | "requestType" | "metadata">): {
  issueType?: DocumentVersion["issueType"];
  issueTypeNote?: string;
  mocOrigin: MocOrigin | null;
  changeLog: string;
} {
  const label = ticket.ticketId ? `request ${ticket.ticketId}` : "the drafting request";
  const isAsBuilt = String(ticket.requestType ?? "").toUpperCase() === "ASBUILT";
  return {
    // DEC-26: an as-built ticket's revision is an As-Built — visibly, overridable.
    issueType: isAsBuilt ? "As-Built" : undefined,
    issueTypeNote: isAsBuilt ? `Defaulted to As-Built because ${label} is an as-built request — change it if that's wrong.` : undefined,
    mocOrigin: mocOriginOf(ticket.metadata),
    changeLog: `Deliverable of drafting ${label}${ticket.title ? ` — ${ticket.title}` : ""}.`,
  };
}

/** The recorded outcome on the ticket, if any. */
export function deliverableStateOf(metadata: Record<string, unknown> | null | undefined): DeliverableState | null {
  const d = asRecord(metadata?.deliverable);
  if (!d) return null;
  if (d.state === "published" && typeof d.version_id === "string") return d as unknown as DeliverableState;
  if (d.state === "not_in_register" && typeof d.document_id === "string") return d as unknown as DeliverableState;
  return null;
}

/** Merge the published outcome into the ticket's metadata (never replaces the bag). */
export function publishedDeliverable(
  metadata: Record<string, unknown> | null | undefined,
  o: { versionId: string; revisionLabel: string; documentId: string; publishedBy: string; now?: string },
): Record<string, unknown> {
  const deliverable: DeliverableState = {
    state: "published", version_id: o.versionId, revision_label: o.revisionLabel, document_id: o.documentId,
    published_at: o.now ?? new Date().toISOString(), published_by: o.publishedBy,
  };
  return { ...(metadata ?? {}), deliverable };
}

/** LIFE-1 done-when 1 / GAP-6 acceptance 5: closing a ticket that has a source
 *  document and produced no revision leaves a VISIBLE, QUERYABLE state. Returns
 *  the merged metadata to write, or null when nothing needs recording (no
 *  source document, or the deliverable was already published). */
export function noteDeliverableNotInRegister(
  metadata: Record<string, unknown> | null | undefined,
  o: { documentId: string; registerRev: string | null; now?: string },
): Record<string, unknown> | null {
  const current = deliverableStateOf(metadata);
  if (current?.state === "published") return null;
  const deliverable: DeliverableState = {
    state: "not_in_register", document_id: o.documentId, register_rev: o.registerRev, noted_at: o.now ?? new Date().toISOString(),
  };
  return { ...(metadata ?? {}), deliverable };
}
