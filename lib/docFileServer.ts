// lib/docFileServer.ts — SERVER-ONLY. Resolve a doc-control document to the
// R2 key of its current stored file, for routes that read pages with vision
// (checklist segmentation, quality-manual review). Current version first,
// pending version as fallback — a checklist uploaded five minutes ago is
// usually still in review, and refusing to read it would be pedantry.
//
// SEC-10: every lookup here runs as the service role, which bypasses
// documents_acl_select. So the CALLER's content decision is made here,
// before any file is resolved, exactly as the bytes egress
// (app/api/storage/download-url) makes it: canServeContent for a private /
// hidden node (a discover-only grant is not enough — DOCACL-5), the
// effective-owner cascade when that refuses (GAP-15 / DEC-7), and the
// explicit DOWNLOAD deny in acl_index, which binds everyone. When the pages
// are served ONLY because the reader is a controller, the DEC-43 record
// (CONTROLLER_RESTRICTED_READ) is written, as the egress route writes it.
// The `reader` argument is required: a route cannot resolve a document's
// file without naming who is reading it.

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  canDiscover, canServeContent, controllerBypassDecided, heldRoles, type Principal,
} from "@/lib/permissions";
import { normalizeRoles } from "@/lib/roleCapabilities";
import type { AccessControl, NodeVisibility, Role } from "@/types/schema";

export interface ResolvedDocFile {
  documentId: string;
  label: string;
  fileKey: string;
  fileType: string | null;
}

/** Who is reading, and what for. `channel` is written on the DEC-43 row
 *  ("checklist_segment", "quality_manual", …). `labelOnly`: the route uses
 *  the document's label and never its pages — no bytes are served, so a
 *  controller bypass leaves no CONTROLLER_RESTRICTED_READ row. */
export interface DocumentReader {
  uid: string;
  email?: string | null;
  channel: string;
  labelOnly?: boolean;
}

export type DocFileResolution =
  | { ok: true; file: ResolvedDocFile }
  | { ok: false; status: 403 | 404 | 503; error: string };

/** The ACL-bearing columns of a `documents` row. */
export interface DocAclRow {
  visibility?: string | null;
  acl?: unknown;
  acl_index?: unknown;
  owner_user_id?: string | null;
}

export const DOC_READ_DENIED = "You don't have access to read that document.";
export const DOC_NO_FILE = "That document has no stored file to read.";
export const DOC_ACCESS_UNVERIFIED = "Couldn't verify your access to that document — try again.";

function visibilityOf(row: DocAclRow): NodeVisibility {
  return row.visibility === "private" || row.visibility === "hidden" ? row.visibility : "normal";
}

/** The principal the ACL engine evaluates the reader as — the shape
 *  download-url builds (headline + additive collection, team ids, active).
 *  `null` = not an active member of the org. Throws on a lookup error: a
 *  gate that cannot see the membership must not guess. */
export async function loadReaderPrincipal(orgId: string, uid: string): Promise<Principal | null> {
  const [{ data: mem, error: memErr }, { data: teams, error: teamErr }] = await Promise.all([
    supabaseAdmin.from("org_members").select("role, roles")
      .eq("org_id", orgId).eq("uid", uid).eq("status", "active").maybeSingle(),
    supabaseAdmin.from("team_members").select("team_id").eq("uid", uid),
  ]);
  if (memErr || teamErr) throw new Error("The reader's membership could not be read.");
  if (!mem) return null;
  const m = mem as { role?: string | null; roles?: unknown };
  return {
    uid,
    role: (m.role as Role) ?? "Viewer",
    roles: normalizeRoles(m.roles, m.role),
    orgId,
    teamIds: ((teams ?? []) as Array<{ team_id: string }>).map((t) => String(t.team_id)),
    isActiveMember: true,
  };
}

type DenyBuckets = { users?: Record<string, string[]>; roles?: Record<string, string[]>; teams?: Record<string, string[]> };

/** The content decision for one document, pure. `served`: canServeContent
 *  (controllers and the explicit owner short-circuit; a normal node is
 *  default-open). `controllerBypass`: served ONLY because of the controller
 *  tier (DEC-43). `downloadDenied`: an explicit download deny in the
 *  chain-resolved acl_index names the reader's uid, a held role or a team —
 *  it binds controllers too, as it does at the egress route. */
export function documentContentDecision(principal: Principal, doc: DocAclRow): {
  served: boolean;
  controllerBypass: boolean;
  downloadDenied: boolean;
} {
  const check = {
    principal,
    aclChain: [(doc.acl ?? undefined) as AccessControl | undefined],
    visibility: visibilityOf(doc),
    effectiveOwnerUserId: doc.owner_user_id ?? null,
  };
  const served = canServeContent(check);
  const deny = ((doc.acl_index as { deny?: DenyBuckets } | null | undefined)?.deny) ?? null;
  const roles = heldRoles(principal) as string[];
  const downloadDenied = !!deny && (
    (deny.users?.download ?? []).includes(principal.uid) ||
    roles.some((r) => (deny.roles?.download ?? []).includes(r)) ||
    (principal.teamIds ?? []).some((t) => (deny.teams?.download ?? []).includes(t))
  );
  return { served, controllerBypass: served && controllerBypassDecided(check), downloadDenied };
}

/** SEC-10: keep only the rows the principal may DISCOVER — the bar a
 *  member's own client (node_visible) would have applied. For service-role
 *  reads that list document titles into a model prompt. */
export function discoverableDocuments<T extends DocAclRow>(principal: Principal, rows: readonly T[]): T[] {
  return rows.filter((row) => canDiscover({
    principal,
    aclChain: [(row.acl ?? undefined) as AccessControl | undefined],
    visibility: visibilityOf(row),
    effectiveOwnerUserId: row.owner_user_id ?? null,
  }));
}

export async function resolveDocumentFile(
  orgId: string,
  documentId: string,
  reader: DocumentReader,
): Promise<DocFileResolution> {
  let principal: Principal | null;
  try { principal = await loadReaderPrincipal(orgId, reader.uid); }
  catch { return { ok: false, status: 503, error: DOC_ACCESS_UNVERIFIED }; }
  if (!principal) return { ok: false, status: 403, error: DOC_READ_DENIED };

  const { data: doc, error: docErr } = await supabaseAdmin
    .from("documents")
    .select("id, document_number, title, name, current_version_id, pending_version_id, visibility, acl, acl_index, owner_user_id, collection_id, library_id")
    .eq("org_id", orgId).eq("id", documentId).maybeSingle();
  if (docErr) return { ok: false, status: 503, error: DOC_ACCESS_UNVERIFIED };
  if (!doc) return { ok: false, status: 404, error: DOC_NO_FILE };

  const decision = documentContentDecision(principal, doc as DocAclRow);
  if (decision.downloadDenied) return { ok: false, status: 403, error: DOC_READ_DENIED };
  // The folder / library / team cascade, asked of the same DB function the
  // egress route and the publish guard use. `true` only — a lookup error is
  // never ownership.
  const isEffectiveOwner = async (): Promise<boolean> => {
    const { data } = await supabaseAdmin.rpc("user_is_effective_owner", {
      p_doc_owner: (doc.owner_user_id as string | null) ?? null,
      p_collection: (doc.collection_id as string | null) ?? null,
      p_library: (doc.library_id as string | null) ?? null,
      p_uid: reader.uid,
    });
    return data === true;
  };
  if (!decision.served && !(await isEffectiveOwner())) {
    return { ok: false, status: 403, error: DOC_READ_DENIED };
  }

  const versionId = (doc.current_version_id as string | null) ?? (doc.pending_version_id as string | null);
  if (!versionId) return { ok: false, status: 404, error: DOC_NO_FILE };
  // org_id re-checked on the version too: the pointer columns are
  // member-writable, so a forged cross-org version id must never resolve.
  const { data: ver } = await supabaseAdmin
    .from("document_versions").select("file_url, file_type")
    .eq("id", versionId).eq("org_id", orgId).maybeSingle();
  if (!ver?.file_url) return { ok: false, status: 404, error: DOC_NO_FILE };

  // DOCACL-3 / DEC-43: pages served ONLY because the reader is a controller
  // are recorded, as the egress route records bytes — unless ownership would
  // have served them anyway (a cascade lookup error records the read rather
  // than skipping it). Best-effort: a failed insert never blocks the rail.
  if (decision.controllerBypass && !reader.labelOnly && !(await isEffectiveOwner())) {
    await supabaseAdmin.from("audit_logs").insert({
      action: "CONTROLLER_RESTRICTED_READ",
      resource_type: "document",
      resource_id: String(doc.id),
      org_id: orgId,
      user_id: reader.uid,
      user_email: reader.email ?? null,
      details: { path: String(ver.file_url), visibility: visibilityOf(doc as DocAclRow), roles: principal.roles, channel: reader.channel },
    }).then(() => undefined, () => undefined);
  }

  return {
    ok: true,
    file: {
      documentId: String(doc.id),
      label: String(doc.document_number || doc.title || doc.name || "Document"),
      fileKey: String(ver.file_url),
      fileType: (ver.file_type as string | null) ?? null,
    },
  };
}
