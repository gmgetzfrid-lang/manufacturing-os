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
 *  42703 (Postgres) / PGRST204 (PostgREST's schema cache) NAMING the column,
 *  as missingLibraryColumn / isMissingReviewModelColumn do. An answer that
 *  names no column is never read as this one: another missing column (the
 *  library, a declaration column) must not drop a project already confirmed
 *  or blame 20261256 (DF-P8 fix pass). */
export function isMissingProjectColumn(err: Err): boolean {
  if (!err) return false;
  const code = String(err.code ?? "");
  if (code !== "42703" && code !== "PGRST204") return false;
  return /project_id/.test(String(err.message ?? ""));
}

/** The sentence a request filed with a project says before the paste. */
export const PROJECT_NOT_RECORDED_WARNING =
  "The request was filed, but its project could not be recorded yet (database update 20261256 is not applied) — link it from the request page once it is.";

/** Who may link or unlink a request (DEC-90 ruling (3) for DF-P8; GAP-114's
 *  default): its requester, a member who manages requests (ticket.manage),
 *  or someone who manages EVERY project the change touches (`managesProject`
 *  — see projectsTouched: both projects on a move). "Create project from
 *  this request" (`converted`) is management or the requester only. Pure. */
export function projectLinkAllowed(p: { isRequester: boolean; managesTickets: boolean; managesProject: boolean; converted?: boolean }): boolean {
  if (p.converted) return p.isRequester || p.managesTickets;
  return p.isRequester || p.managesTickets || p.managesProject;
}

/** The projects a link change touches: the current one (left) and the
 *  target (joined) — both on a move, one on a link or an unlink. Pure. */
export function projectsTouched(current: string | null | undefined, target: string | null | undefined): string[] {
  return [...new Set([current, target].filter((x): x is string => typeof x === "string" && x.length > 0))];
}

/** The ticket history line the link route writes (LEAK-4 / EVID-1 / PERS-2:
 *  the one history line of a project link, written by the server, never a
 *  browser read-modify-write of the array). It NAMES NO PROJECT (DF-P8 fix
 *  pass 2): ticket history is read by every reader of the request — the
 *  requester, watchers, a Contractor-only reader — and a private project's
 *  name is not theirs to read (PROJ-9: the page names the linked project only
 *  through a read under the viewer's own RLS, else "Open the linked
 *  project"). The line carries the project as a structured `projectId` and
 *  shows no name. */
export function projectLinkHistoryEntry(p: {
  kind: "linked" | "unlinked" | "converted";
  projectId: string | null;
  email: string | null;
  role: string | null;
  now: string;
}): Record<string, unknown> {
  const action = p.kind === "converted" ? "Converted to Project" : p.kind === "linked" ? "Linked to project" : "Unlinked from project";
  const details = p.kind === "converted"
    ? "A project was created from this request and the request was linked to it."
    : p.kind === "linked"
      ? "This request now belongs to a project (a reference — no file is copied)."
      : "This request no longer belongs to the project it was linked to. The request and its documents are unchanged.";
  return { action, user: p.email, role: p.role, date: p.now, details, projectId: p.projectId };
}

// ── The project register's authority (PM-8 / SEC-17, 20261102) ─────────────
//
// project_documents_insert admits is_org_controller(org) OR
// can_manage_project(project) — in a project the writer can see. The routes
// write the register reference as the service role (so the feed row can name
// its actor), which goes around that policy; so they write it ONLY when the
// policy's own answer for the person behind the change is yes (DF-P8 fix
// pass 2). Linking a request to a project is not authority over its register:
// a requester who can merely SEE a project links their request to it, and a
// project manager attaches the deliverable from the project's Documents card.

/** Said when the register reference was not written for want of authority. */
export const PROJECT_REGISTER_MANAGERS_ONLY =
  "The request's published deliverable was not put on the project's document register: only the project's managers (or Admin / Document Control) add documents to it — a project manager can attach it from the project's Documents card.";

/** A PostgREST client that can call functions AS THE CALLER (their JWT). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type RpcClient = { rpc: (fn: string, args: Record<string, unknown>) => any };

/** Would project_documents_insert admit this caller on this project? Asked
 *  AS THE CALLER through the policy's own functions (is_org_controller,
 *  can_manage_project — both read auth.uid()). true / false, or null when
 *  neither said yes and one could not be asked (never read as a yes). */
export async function callerHoldsRegisterAuthority(client: RpcClient, orgId: string, projectId: string): Promise<boolean | null> {
  let unknown = false;
  for (const [fn, args] of [["is_org_controller", { p_org: orgId }], ["can_manage_project", { p_project: projectId }]] as const) {
    try {
      const { data, error } = await client.rpc(fn, args);
      if (error) { unknown = true; continue; }
      if (data === true) return true;
    } catch {
      unknown = true;
    }
  }
  return unknown ? null : false;
}

/** The project feed's own rule for a 'doc_added' row (project_activity_insert,
 *  20261102 §3): is_org_controller(org) OR is_project_owner(project) — a
 *  narrower set than the register's (a project manager who is not the owner
 *  may add the reference but not stamp doc_added). Asked AS THE CALLER;
 *  an unanswerable check is a no (DF-P8 fix pass 3). */
export async function callerMayStampDocAdded(client: RpcClient, orgId: string, projectId: string): Promise<boolean> {
  for (const [fn, args] of [["is_org_controller", { p_org: orgId }], ["is_project_owner", { p_project: projectId }]] as const) {
    try {
      const { data, error } = await client.rpc(fn, args);
      if (!error && data === true) return true;
    } catch {
      // never read as a yes
    }
  }
  return false;
}

/** The feed type a register reference landed by someone the feed's doc_added
 *  rule does not admit is recorded under (DF-P8 fix pass 3). */
export const REQUEST_DELIVERABLE_REFERENCED = "request_deliverable_referenced";

/** The authority recorded when the request was put on THIS project
 *  (metadata.project_link.registerAuthority — metadata is workflow-owned,
 *  written only by the service role, 20261250's ticket_update_guard): true
 *  when the link was made by someone the register policy admits, or derived
 *  by the server from the project's own record (a check-in under the
 *  project's checkout session, an intake collision flagged on the project).
 *  Pure. */
export function recordedRegisterAuthority(metadata: unknown, projectId: string | null | undefined): boolean {
  if (!projectId || !metadata || typeof metadata !== "object") return false;
  const link = (metadata as { project_link?: unknown }).project_link;
  if (!link || typeof link !== "object") return false;
  const l = link as { projectId?: unknown; registerAuthority?: unknown };
  return l.projectId === projectId && l.registerAuthority === true;
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
 *  project_documents row of the shape "attach to project" writes; no bytes
 *  move), and the feed says so: doc_added only when the actor may stamp it
 *  (`actorMayStampDocAdded` — callerMayStampDocAdded), else a
 *  request_deliverable_referenced row (DF-P8 fix pass 3). A document already on the
 *  register is left exactly as it is (its source stays). Returns null when
 *  nothing needed doing or it landed, else the refusal's text.
 *  The CALLER decides authority first (callerHoldsRegisterAuthority /
 *  recordedRegisterAuthority): this writes as whatever client it is given,
 *  and the routes give it the service role only once the register policy's
 *  own answer is yes (DF-P8 fix pass 2). */
export async function referenceDeliverableInProject(sb: DbClient, p: {
  orgId: string;
  projectId: string;
  documentId: string;
  ticketId: string;
  ticketNumber: string | null;
  revisionLabel: string | null;
  actorId: string | null;
  actorName: string | null;
  actorMayStampDocAdded: boolean;
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
      type: p.actorMayStampDocAdded ? "doc_added" : REQUEST_DELIVERABLE_REFERENCED,
      body: `Deliverable of ${p.ticketNumber ?? "a drafting request"}${p.revisionLabel ? ` (Rev ${p.revisionLabel})` : ""} referenced on the project — the live controlled document, never a copy`,
      metadata: { documentId: p.documentId, ticketId: p.ticketId, ticketNumber: p.ticketNumber, revision: p.revisionLabel, via: "drafting_request" },
    });
  } catch (e) {
    return (e as Error)?.message ?? String(e);
  }
}

// ── Who an open request is with, as the project's card says it (pure) ──────

/** The person an open request waits on, by its status (DF-P8 fix pass 3):
 *  the drafter while it is being drafted or revised (and while the drafter
 *  issues it), the engineer while it is in engineering review, review or
 *  sign-off, the requester while an issued package awaits acknowledgement,
 *  and the drafting queue before anyone is assigned. Each line names the
 *  ROLE, never a bare "with", so a missing name never reads as the wrong
 *  person. null for a terminal status or a status this build does not know. */
export function requestHolderLabel(
  status: string | null | undefined,
  names: { drafter?: string | null; engineer?: string | null; requester?: string | null },
): string | null {
  const who = (role: string, name: string | null | undefined, none: string) => (name && name.trim() ? `${role}: ${name.trim()}` : none);
  switch (status) {
    case "PENDING_ASSIGNMENT": return "In the drafting queue — no drafter assigned yet";
    case "DRAFTING":
    case "REVISION_REQ":
    case "PENDING_IFC": return who("Drafter", names.drafter, "No drafter assigned");
    case "PENDING_ENG_TEAM":
    case "PENDING_REVIEW":
    case "PENDING_FINAL_APPROVAL": return who("Engineer", names.engineer, "Awaiting an engineer");
    case "FINAL_DRAFT": return who("Awaiting acknowledgement from", names.requester, "Awaiting the requester's acknowledgement");
    default: return null;
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
