// lib/ticketProject.ts
//
// drafting-flow Round G, DF-P8 PROJECTS — GAP-114 / DEC-40: a drafting
// request names its project BY REFERENCE (tickets.project_id, 20261256).
// Server-side helpers shared by /api/tickets/create, /api/tickets/project-link
// and /api/tickets/handback. Nothing here copies a file or creates a
// project-local document record: a deliverable reaches the project as a
// project_documents REFERENCE to the controlled document, resolved live.
//
// Every write here is checked (SAF-18): a refusal is returned as text for the
// caller to say, never a silent success.

type Err = { code?: string | null; message?: string | null } | null | undefined;

/** A minimal PostgREST client shape (the service role in the routes). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type DbClient = { from: (table: string) => any };

/** A project in one of these statuses takes no new request link. */
export const PROJECT_LINK_CLOSED: ReadonlySet<string> = new Set(["completed", "cancelled", "archived"]);

/** tickets.project_id is not in the database yet (20261256 not pasted):
 *  42703 (Postgres) / PGRST204 (PostgREST's schema cache), naming the
 *  column — or naming nothing, as a body-less answer does. */
export function isMissingProjectColumn(err: Err): boolean {
  if (!err) return false;
  const code = String(err.code ?? "");
  if (code !== "42703" && code !== "PGRST204") return false;
  const msg = String(err.message ?? "");
  return msg === "" || /project_id/.test(msg);
}

/** The sentence a request filed with a project says before the paste. */
export const PROJECT_NOT_RECORDED_WARNING =
  "The request was filed, but its project could not be recorded yet (database update 20261256 is not applied) — link it from the request page once it is.";

/** Who may link or unlink a request (DEC-90 ruling (3) for DF-P8; GAP-114's
 *  default): its requester, a member who manages requests (ticket.manage),
 *  or someone who manages the project in question. Pure. */
export function projectLinkAllowed(p: { isRequester: boolean; managesTickets: boolean; managesProject: boolean }): boolean {
  return p.isRequester || p.managesTickets || p.managesProject;
}

/** The ticket history line the link route writes (LEAK-4 / EVID-1 / PERS-2:
 *  the one history line of a project link, written by the server, never a
 *  browser read-modify-write of the array). */
export function projectLinkHistoryEntry(p: {
  kind: "linked" | "unlinked" | "converted";
  projectName: string | null;
  email: string | null;
  role: string | null;
  now: string;
}): Record<string, unknown> {
  const name = p.projectName?.trim() || "a project";
  const action = p.kind === "converted" ? "Converted to Project" : p.kind === "linked" ? "Linked to project" : "Unlinked from project";
  const details = p.kind === "converted"
    ? `Project "${name}" was created from this request and linked to it.`
    : p.kind === "linked"
      ? `This request now belongs to project "${name}" (a reference — no file is copied).`
      : `This request no longer belongs to project "${name}". The request and its documents are unchanged.`;
  return { action, user: p.email, role: p.role, date: p.now, details };
}

/** One project feed row, written as the service role (the database's author
 *  stamp passes the service role's own actor through). Returns the refusal's
 *  text, or null when it landed. */
export async function recordProjectActivity(sb: DbClient, row: {
  projectId: string;
  orgId: string;
  userId: string | null;
  userName: string | null;
  type: string;
  body: string;
  metadata: Record<string, unknown>;
}): Promise<string | null> {
  try {
    const { error } = await sb.from("project_activity").insert({
      project_id: row.projectId, org_id: row.orgId, user_id: row.userId, user_name: row.userName,
      type: row.type, body: row.body, metadata: row.metadata,
    });
    return error ? (error.message || "the project feed refused the row") : null;
  } catch (e) {
    return (e as Error)?.message ?? String(e);
  }
}

/** GAP-114 "deliverable → project documents" / PROJ-1's project half: a
 *  published deliverable of a request that belongs to a project is put on the
 *  project's register as a REFERENCE to the controlled document (DEC-40 — a
 *  project_documents row, the same row "attach to project" writes; no bytes
 *  move), and the feed says so (doc_added). A document already on the
 *  register is left exactly as it is (its source stays). Returns null when
 *  nothing needed doing or it landed, else the refusal's text. */
export async function referenceDeliverableInProject(sb: DbClient, p: {
  orgId: string;
  projectId: string;
  documentId: string;
  ticketId: string;
  ticketNumber: string | null;
  revisionLabel: string | null;
  actorId: string | null;
  actorName: string | null;
}): Promise<string | null> {
  try {
    const now = new Date().toISOString();
    const { data, error } = await sb.from("project_documents").upsert(
      { org_id: p.orgId, project_id: p.projectId, document_id: p.documentId, source: "manual", last_seen_at: now },
      { onConflict: "project_id,document_id", ignoreDuplicates: true },
    ).select("id");
    if (error) return error.message || "the project register refused the reference";
    if (!Array.isArray(data) || data.length === 0) return null; // already on the register
    return await recordProjectActivity(sb, {
      projectId: p.projectId, orgId: p.orgId, userId: p.actorId, userName: p.actorName,
      type: "doc_added",
      body: `Deliverable of ${p.ticketNumber ?? "a drafting request"}${p.revisionLabel ? ` (Rev ${p.revisionLabel})` : ""} referenced on the project — the live controlled document, never a copy`,
      metadata: { documentId: p.documentId, ticketId: p.ticketId, ticketNumber: p.ticketNumber, revision: p.revisionLabel, via: "drafting_request" },
    });
  } catch (e) {
    return (e as Error)?.message ?? String(e);
  }
}

// ── The project's view of a request's deliverable (pure, browser-safe) ──────

/** How a request's deliverable reads on the project (GAP-114 acceptance 2 /
 *  4; DEC-40): a live reference to the controlled document — current, or
 *  marked superseded / not current — or, for a member who cannot read the
 *  library, that a deliverable exists and cannot be opened (never hidden,
 *  never opened). */
export type DeliverableReference =
  | { kind: "none" }
  | { kind: "not_in_register" }
  | { kind: "published"; canOpen: true; documentId: string; libraryId: string | null; label: string; current: boolean; note: string }
  | { kind: "published"; canOpen: false; documentId: string; label: string; current: null; note: string };

export function deliverableReference(
  state: { state?: unknown; document_id?: unknown; version_id?: unknown; revision_label?: unknown; in_review?: unknown } | null,
  doc: { id: string; document_number?: string | null; rev?: string | null; status?: string | null; library_id?: string | null; current_version_id?: string | null; archived_at?: string | null } | null,
  notCurrentStatuses: ReadonlySet<string>,
): DeliverableReference {
  if (!state || typeof state !== "object") return { kind: "none" };
  if (state.state === "not_in_register") return { kind: "not_in_register" };
  if (state.state !== "published" || typeof state.document_id !== "string" || !state.document_id) return { kind: "none" };
  const rev = typeof state.revision_label === "string" && state.revision_label ? state.revision_label : null;
  const revText = rev ? `Rev ${rev}` : "A revision";
  if (!doc) {
    return {
      kind: "published", canOpen: false, documentId: state.document_id, current: null,
      label: `${revText} was published`,
      note: "You do not have access to its library — the deliverable exists, but only members who can read that library can open it.",
    };
  }
  const label = `${doc.document_number || "Document"} ${revText}`;
  if (doc.archived_at || notCurrentStatuses.has(doc.status ?? "")) {
    return { kind: "published", canOpen: true, documentId: doc.id, libraryId: doc.library_id ?? null, label, current: false, note: `Not current — the document is ${doc.archived_at ? "archived" : (doc.status ?? "").toLowerCase()}.` };
  }
  if (typeof state.version_id === "string" && doc.current_version_id && doc.current_version_id !== state.version_id) {
    return { kind: "published", canOpen: true, documentId: doc.id, libraryId: doc.library_id ?? null, label, current: false, note: `Superseded — the register is now at Rev ${doc.rev ?? "—"}.` };
  }
  return { kind: "published", canOpen: true, documentId: doc.id, libraryId: doc.library_id ?? null, label, current: true, note: state.in_review === true ? "In document review." : "Current revision." };
}
