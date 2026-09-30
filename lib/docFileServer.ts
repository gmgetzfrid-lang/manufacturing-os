// lib/docFileServer.ts — SERVER-ONLY. Resolve a doc-control document to the
// R2 key of its current stored file, for routes that read pages with vision
// (checklist segmentation, quality-manual review). Current version first,
// pending version as fallback — a checklist uploaded five minutes ago is
// usually still in review, and refusing to read it would be pedantry.
//
// SEC-10: every lookup here runs as the service role, which bypasses
// documents_acl_select. So the CALLER's content decision is made here,
// before any file is resolved: the app's own read decision
// (canWithAclChain, the engine the library page lists documents with) over
// the FULL chain — the library's ACL, each ancestor folder's, the
// document's folder's, then the document's own — requiring `read` or
// `download` wherever the chain carries an ACL, whatever the visibility (a
// discover-only grant is not enough — DOCACL-5; an allow-list on a normal
// document or on its folder or library binds). Only a chain with no ACL at
// all is default-open, and only for a normal document. Then the
// effective-owner cascade when that refuses (GAP-15 / DEC-7), and the
// explicit DOWNLOAD deny, which binds everyone. When the pages are served
// ONLY because the reader is a controller, the DEC-43 record
// (CONTROLLER_RESTRICTED_READ) is written, as the egress route writes it.
// The `reader` argument is required: a route cannot resolve a document's
// file without naming who is reading it.
//
// This is STRICTER than /api/storage/download-url today, which evaluates
// only the document's own ACL and only for private / hidden documents
// (intelligence KACL-5 brings the egress route to the same chain). The
// parity test in lib/__tests__/docFileServer.test.ts pins "never looser than
// the egress route" and names each case where the gate is stricter.

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { evaluateAclChain } from "@/lib/acl";
import {
  canDiscover, canWithAclChain, heldRoles, isControllerRole, type Principal,
} from "@/lib/permissions";
import { normalizeRoles } from "@/lib/roleCapabilities";
import type { AccessControl, NodeVisibility, PermissionAction, Role } from "@/types/schema";

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

/** The ACL chain ABOVE a document, in merge order: its library's ACL, each
 *  ancestor folder's (root first, from `path_ids`), then its own folder's —
 *  the order lib/aclIndexRebuild and the library page's buildDocChain use.
 *  The decision appends the document's own `acl`. */
export type ContainerAclChain = Array<AccessControl | undefined>;

/** Load the container chain for a document (or for every document in one
 *  folder). THROWS when any rung cannot be read or is missing — a gate that
 *  cannot see the library's or a folder's ACL must not guess that it grants
 *  nothing (a dropped allow-list would serve everyone). Every read is
 *  org-scoped. `libraryId` defaults to the folder's own library. */
export async function loadContainerAclChain(
  orgId: string,
  where: { libraryId?: string | null; collectionId?: string | null },
): Promise<ContainerAclChain> {
  let libraryId = where.libraryId ?? null;
  const folders: ContainerAclChain = [];
  if (where.collectionId) {
    const { data: folder, error } = await supabaseAdmin
      .from("collections").select("id, library_id, path_ids, acl")
      .eq("org_id", orgId).eq("id", where.collectionId).maybeSingle();
    if (error || !folder) throw new Error("The document's folder could not be read.");
    const f = folder as { library_id?: string | null; path_ids?: unknown; acl?: unknown };
    libraryId = libraryId ?? f.library_id ?? null;
    const pathIds = Array.isArray(f.path_ids) ? (f.path_ids as unknown[]).map(String).filter(Boolean) : [];
    if (pathIds.length > 0) {
      const { data: ancestors, error: ancErr } = await supabaseAdmin
        .from("collections").select("id, acl").eq("org_id", orgId).in("id", pathIds);
      if (ancErr) throw new Error("A folder above the document could not be read.");
      const byId = new Map(((ancestors ?? []) as Array<{ id: string; acl?: unknown }>).map((a) => [String(a.id), a]));
      for (const id of pathIds) {
        const a = byId.get(id);
        if (!a) throw new Error("A folder above the document could not be read.");
        folders.push((a.acl ?? undefined) as AccessControl | undefined);
      }
    }
    folders.push((f.acl ?? undefined) as AccessControl | undefined);
  }
  if (!libraryId) throw new Error("The document's library is unknown.");
  const { data: lib, error: libErr } = await supabaseAdmin
    .from("libraries").select("id, acl").eq("org_id", orgId).eq("id", libraryId).maybeSingle();
  if (libErr || !lib) throw new Error("The document's library could not be read.");
  return [((lib as { acl?: unknown }).acl ?? undefined) as AccessControl | undefined, ...folders];
}

type DenyBuckets = {
  users?: Record<string, string[]>;
  roles?: Record<string, string[]>;
  teams?: Record<string, string[]>;
  orgs?: Record<string, string[]>;
};

/** The same person without the controller tier — how
 *  controllerBypassDecided (lib/permissions) asks whether ONLY the tier
 *  admitted them. A controller with no other role holds no role at all
 *  (never Viewer), so an ACL naming role:Viewer cannot make the bypass look
 *  ACL-served. */
const NO_ROLE = "__no_role__" as Role;
function withoutControllerTier(p: Principal): Principal {
  const stripped = heldRoles(p).filter((r) => !isControllerRole(r));
  return { ...p, role: stripped[0] ?? NO_ROLE, roles: stripped.length > 0 ? stripped : [NO_ROLE] };
}

/** May the principal have the CONTENT? The app's read decision over the
 *  whole chain: controllers and the explicit owner short-circuit; wherever
 *  the chain carries an ACL it must grant `read` or `download`; with no ACL
 *  anywhere, a normal node is open and a private / hidden one is not. */
function mayReadContent(
  principal: Principal,
  aclChain: ContainerAclChain,
  visibility: NodeVisibility,
  ownerUid: string | null,
): boolean {
  const ask = (action: PermissionAction) => canWithAclChain({
    principal, action, aclChain, defaultAllow: visibility === "normal", effectiveOwnerUserId: ownerUid,
  });
  return ask("read") || ask("download");
}

/** The content decision for one document, pure. `containerChain` is the
 *  library → folders chain above it (loadContainerAclChain); the document's
 *  own `acl` is appended. `served`: mayReadContent. `controllerBypass`:
 *  served ONLY because of the controller tier (DEC-43). `downloadDenied`:
 *  an explicit download deny names the reader — in the chain-resolved
 *  `acl_index` (uid, a held role, a team, or the org) or in the live chain
 *  itself (current between index rebuilds). It binds controllers too, as it
 *  does at the egress route. */
export function documentContentDecision(
  principal: Principal,
  doc: DocAclRow,
  containerChain: ContainerAclChain = [],
): {
  served: boolean;
  controllerBypass: boolean;
  downloadDenied: boolean;
} {
  const aclChain: ContainerAclChain = [...containerChain, (doc.acl ?? undefined) as AccessControl | undefined];
  const visibility = visibilityOf(doc);
  const ownerUid = doc.owner_user_id ?? null;
  const served = mayReadContent(principal, aclChain, visibility, ownerUid);
  const controllerBypass = served && heldRoles(principal).some(isControllerRole)
    && !mayReadContent(withoutControllerTier(principal), aclChain, visibility, ownerUid);

  const deny = ((doc.acl_index as { deny?: DenyBuckets } | null | undefined)?.deny) ?? null;
  const roles = heldRoles(principal) as string[];
  const indexDenied = !!deny && (
    (deny.users?.download ?? []).includes(principal.uid) ||
    roles.some((r) => (deny.roles?.download ?? []).includes(r)) ||
    (principal.teamIds ?? []).some((t) => (deny.teams?.download ?? []).includes(t)) ||
    (!!principal.orgId && (deny.orgs?.download ?? []).includes(principal.orgId))
  );
  const chainDenied = evaluateAclChain(aclChain, {
    uid: principal.uid,
    role: principal.role,
    roles: heldRoles(principal),
    orgId: principal.orgId,
    teamIds: principal.teamIds,
    isActiveMember: principal.isActiveMember,
  })?.denied.has("download") ?? false;
  return { served, controllerBypass, downloadDenied: indexDenied || chainDenied };
}

/** SEC-10: keep only the rows the principal may DISCOVER — the bar a
 *  member's own client applies (canDiscover), over the same chain:
 *  `containerChain` is the library → folders chain the rows share (they are
 *  one folder's documents), each row's own `acl` appended. For service-role
 *  reads that list document titles into a model prompt. */
export function discoverableDocuments<T extends DocAclRow>(
  principal: Principal,
  rows: readonly T[],
  containerChain: ContainerAclChain = [],
): T[] {
  return rows.filter((row) => canDiscover({
    principal,
    aclChain: [...containerChain, (row.acl ?? undefined) as AccessControl | undefined],
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

  // The library → folder chain above the document: a rung that cannot be
  // read is 503, never "no ACL".
  let containerChain: ContainerAclChain;
  try {
    containerChain = await loadContainerAclChain(orgId, {
      libraryId: (doc.library_id as string | null) ?? null,
      collectionId: (doc.collection_id as string | null) ?? null,
    });
  } catch {
    return { ok: false, status: 503, error: DOC_ACCESS_UNVERIFIED };
  }

  const decision = documentContentDecision(principal, doc as DocAclRow, containerChain);
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
