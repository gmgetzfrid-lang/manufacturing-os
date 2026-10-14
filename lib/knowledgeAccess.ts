// lib/knowledgeAccess.ts — SERVER-ONLY. The ACL seam between knowledge
// libraries and document control.
//
// Source-linked knowledge documents mirror CONTROLLED documents, which carry
// per-node ACLs (library → folder chain → document, with deny/expiry/hidden
// semantics). Anything that reads linked content on behalf of a user runs
// through here:
//
//   - the ask route: retrieval excludes chunks of documents the ASKER can't
//     read — two people can ask the same question and correctly get
//     different answers;
//   - the sources API: the browse picker only offers containers the caller
//     can read, and adding a source re-verifies server-side.
//
// Evaluation uses the same lib/acl engine the app's screens use (single ACL
// truth) — never a parallel re-implementation. The read decision itself is
// lib/permissions canReadNode (IEDGE-12), the predicate the bytes door asks
// too.
//
// KACL-12: the seam FAILS CLOSED on its own reads. loadPrincipal answers no
// principal when the caller's teams cannot be read (a team deny is never
// dropped); loadDcLandscape throws DcLandscapeUnreadableError when the
// libraries, folders or teams cannot be read, and pages the container reads
// until a short page (a row cap never truncates the folder ACLs); and a
// document or folder whose library or folder is absent from the landscape is
// unreadable to everyone but a controller (its chain is never evaluated with
// a rung missing).

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { canReadNode } from "@/lib/permissions";
import { resolveEffectiveOwner, type TeamSupervisor } from "@/lib/ownership";
import type { AccessControl, NodeVisibility, Role } from "@/types/schema";

export interface KnowledgePrincipal {
  uid: string;
  orgId: string;
  role: Role;
  /** CHAIN-1: the full held collection — ACL role subjects (allow and deny)
   *  evaluate against all of them, not just the headline. */
  roles: Role[];
  isController: boolean;
  teamIds: string[];
}

/** Load the principal (role + teams) the ACL engine evaluates against.
 *  `null` — refused by every caller — for a non-member or an unreadable
 *  membership, AND (KACL-12) for a non-controller whose teams cannot be read:
 *  a principal built without its teams would match no TEAM deny, so a
 *  document denied to the caller's team would read as open. A controller's
 *  teams decide nothing (every evaluator short-circuits the controller tier,
 *  DEC-2 / DEC-43), so a controller still loads, with no teams. */
export async function loadPrincipal(orgId: string, uid: string): Promise<KnowledgePrincipal | null> {
  const [{ data: member, error: memberErr }, { data: teams, error: teamsErr }] = await Promise.all([
    supabaseAdmin.from("org_members").select("role, roles")
      .eq("org_id", orgId).eq("uid", uid).eq("status", "active").maybeSingle(),
    supabaseAdmin.from("team_members").select("team_id").eq("uid", uid),
  ]);
  if (memberErr || !member) return null;
  const roles = new Set<string>([member.role as string, ...((member.roles as string[]) ?? [])]);
  if (teamsErr && !(roles.has("Admin") || roles.has("DocCtrl"))) return null;
  return {
    uid,
    orgId,
    role: (member.role as Role) ?? ("Viewer" as Role),
    roles: [...roles].filter(Boolean) as Role[],
    isController: roles.has("Admin") || roles.has("DocCtrl"),
    teamIds: teamsErr ? [] : (teams ?? []).map((t) => t.team_id as string),
  };
}

type ContainerNode = {
  acl: AccessControl | null;
  visibility: NodeVisibility | null;
  parent_id?: string | null;
  /** DEL-2: ownership carries read access (document → folder lineage →
   *  library → team supervisor), the cascade node_visible applies. */
  owner_user_id?: string | null;
};

/** Read-decision for one node given its ancestor ACL chain: lib/permissions
 *  canReadNode asking `read` (IEDGE-12 — the one predicate). A controller and
 *  the effective owner read (DEL-2; loadPrincipal only returns ACTIVE
 *  members, so a departed owner never reaches here); wherever the chain says
 *  something, `read` must be granted — on a HIDDEN node too: a discover-only
 *  grant lets a person know the document exists, never lets the AI read it
 *  (KACL-3; canBlindDrill's both-of semantics); with no ACL anywhere only a
 *  NORMAL node is open — hidden AND private ones are not (KACL-11, matching
 *  canDiscover). Exported so a caller judging one node asks the same
 *  question the seam asks. */
export function chainReadable(
  chain: Array<AccessControl | null | undefined>,
  visibility: NodeVisibility | null | undefined,
  principal: KnowledgePrincipal,
  effectiveOwnerUid?: string | null,
): boolean {
  if (principal.isController) return true;
  return canReadNode({
    principal: {
      uid: principal.uid,
      role: principal.role,
      roles: principal.roles,
      orgId: principal.orgId,
      teamIds: principal.teamIds,
      isActiveMember: true,
    },
    aclChain: chain,
    visibility: visibility ?? null,
    effectiveOwnerUserId: effectiveOwnerUid ?? null,
    actions: ["read"],
  });
}

/** KACL-12: the landscape could not be read in full — a libraries, folders
 *  or teams read failed. Every caller fails closed on it: the readable set is
 *  never computed from a partial landscape (readableControlledDocIds lets it
 *  propagate to its callers, which drop everything controlled), and the
 *  direct callers answer 503 or skip the library. */
export class DcLandscapeUnreadableError extends Error {
  constructor(readonly what: "libraries" | "folders" | "teams", detail: string) {
    super(`The document ${what === "folders" ? "folders" : what} (and their access rules) could not be read: ${detail}`);
    this.name = "DcLandscapeUnreadableError";
  }
}

/** Rows per container read. Each read pages by `id` until a short page, so a
 *  PostgREST max-rows below an org's folder count never truncates the
 *  landscape (KACL-12 done-when 4). */
export const DC_LANDSCAPE_PAGE = 1000;

async function readAllPages(
  table: "libraries" | "collections" | "teams",
  columns: string,
  orgId: string,
): Promise<Array<Record<string, unknown>>> {
  const what = table === "collections" ? "folders" : table;
  const out: Array<Record<string, unknown>> = [];
  for (let from = 0; ; from += DC_LANDSCAPE_PAGE) {
    const { data, error } = await supabaseAdmin
      .from(table).select(columns).eq("org_id", orgId)
      .order("id", { ascending: true })
      .range(from, from + DC_LANDSCAPE_PAGE - 1);
    if (error) throw new DcLandscapeUnreadableError(what, error.message ?? String(error));
    const rows = (data ?? []) as unknown as Array<Record<string, unknown>>;
    out.push(...rows);
    if (rows.length < DC_LANDSCAPE_PAGE) return out;
  }
}

type LandscapeFolder = ContainerNode & { name: string; library_id: string; path_names: string[] };

/** The document-control landscape needed for chain evaluation, fetched once
 *  per request. THROWS DcLandscapeUnreadableError when any of its reads fails
 *  (KACL-12): a map missing a library or a folder would evaluate a chain
 *  without that rung's ACL. */
export async function loadDcLandscape(orgId: string): Promise<{
  libraries: Map<string, ContainerNode & { name: string; owner_team_id?: string | null }>;
  /** Live folders — the containers a picker may offer. */
  folders: Map<string, LandscapeFolder>;
  /** Folders in the 30-day trash. Never offered as containers, but their ACL
   *  still rides the chain of whatever sits below them (a document whose
   *  folder is in the trash is judged under that folder's rules, never
   *  without them). Optional so a hand-built landscape needs no entry. */
  trashedFolders?: Map<string, LandscapeFolder>;
  /** team id → supervisor, the last rung of the ownership cascade (the
   *  shape the one resolver takes — OWN-16). */
  teamSupervisors: Map<string, TeamSupervisor>;
}> {
  // collections is select("*") so the trash filter works before AND after
  // migration 20261011 (naming deleted_at explicitly would 42703 pre-migration).
  const [libRows, folderRows, teamRows] = await Promise.all([
    readAllPages("libraries", "id, name, acl, visibility, owner_user_id, owner_team_id", orgId),
    readAllPages("collections", "*", orgId),
    readAllPages("teams", "id, supervisor_user_id", orgId),
  ]);
  const libraries = new Map<string, ContainerNode & { name: string; owner_team_id?: string | null }>();
  for (const l of libRows) {
    libraries.set(l.id as string, {
      name: (l.name as string) ?? "Library",
      acl: (l.acl as AccessControl) ?? null,
      visibility: (l.visibility as NodeVisibility) ?? null,
      owner_user_id: (l.owner_user_id as string | null) ?? null,
      owner_team_id: (l.owner_team_id as string | null) ?? null,
    });
  }
  const teamSupervisors = new Map<string, TeamSupervisor>();
  for (const t of teamRows) {
    if (t.supervisor_user_id) teamSupervisors.set(t.id as string, { userId: t.supervisor_user_id as string });
  }
  const folders = new Map<string, LandscapeFolder>();
  const trashedFolders = new Map<string, LandscapeFolder>();
  for (const c of folderRows) {
    const node: LandscapeFolder = {
      name: (c.name as string) ?? "Folder",
      library_id: c.library_id as string,
      parent_id: (c.parent_id as string | null) ?? null,
      acl: (c.acl as AccessControl) ?? null,
      visibility: (c.visibility as NodeVisibility) ?? null,
      owner_user_id: (c.owner_user_id as string | null) ?? null,
      path_names: (c.path_names as string[]) ?? [],
    };
    // In the 30-day trash: not a container anyone is offered, but its ACL
    // stays on the chain below it.
    if (c.deleted_at) trashedFolders.set(c.id as string, node);
    else folders.set(c.id as string, node);
  }
  return { libraries, folders, trashedFolders, teamSupervisors };
}

/** DEL-2: the effective owner of a node — document owner, else the nearest
 *  owning folder up the lineage, else the library owner, else the owning
 *  team's supervisor. The lineage walk picks the folder rung; the chain
 *  itself is the ONE resolver (OWN-16), which mirrors user_is_effective_owner. */
export function effectiveOwnerFor(
  docOwner: string | null | undefined,
  folderId: string | null | undefined,
  libraryId: string | null | undefined,
  landscape: Pick<Awaited<ReturnType<typeof loadDcLandscape>>, "libraries" | "folders" | "trashedFolders" | "teamSupervisors">,
): string | null {
  let folderOwner: string | null = null;
  let cur = folderId ?? null;
  const seen = new Set<string>();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const f = landscape.folders.get(cur) ?? landscape.trashedFolders?.get(cur);
    if (!f) break;
    if (f.owner_user_id) { folderOwner = f.owner_user_id; break; }
    cur = f.parent_id ?? null;
  }
  const lib = libraryId ? landscape.libraries.get(libraryId) : undefined;
  return resolveEffectiveOwner(
    docOwner ? { owner_user_id: docOwner } : null,
    folderOwner ? { owner_user_id: folderOwner } : null,
    lib ? { owner_user_id: lib.owner_user_id ?? null, owner_team_id: lib.owner_team_id ?? null } : null,
    null,
    landscape.teamSupervisors,
  ).userId;
}

/** A folder by id, live or in the trash — for chain resolution only. */
function anyFolder(
  id: string,
  landscape: Awaited<ReturnType<typeof loadDcLandscape>>,
): LandscapeFolder | undefined {
  return landscape.folders.get(id) ?? landscape.trashedFolders?.get(id);
}

/** Build the ACL chain for a folder: library ACL, then ancestors top-down,
 *  then the folder itself. Cycle-guarded. `null` — the chain cannot be
 *  evaluated, so nothing below it is readable to a non-controller — when the
 *  folder, any ancestor its parent pointers name, or its library is absent
 *  from the landscape (KACL-12 done-when 3: a chain is never evaluated with a
 *  rung missing; before, the walk stopped at the gap and the library's ACL
 *  fell back to "none", dropping their rules). A parent cycle stops the walk
 *  where it closes, as before. */
function folderChain(
  folderId: string,
  landscape: Awaited<ReturnType<typeof loadDcLandscape>>,
): { chain: Array<AccessControl | null>; visibility: NodeVisibility | null } | null {
  const folder = anyFolder(folderId, landscape);
  if (!folder) return null;
  const lineage: Array<AccessControl | null> = [];
  let cur: string | null = folderId;
  const seen = new Set<string>();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const node = anyFolder(cur, landscape);
    if (!node) return null;
    lineage.unshift(node.acl);
    cur = node.parent_id ?? null;
  }
  const lib = landscape.libraries.get(folder.library_id);
  if (!lib) return null;
  return { chain: [lib.acl ?? null, ...lineage], visibility: folder.visibility };
}

/** Is one doc-control container (library or folder) readable? */
export function containerReadable(
  kind: "library" | "folder",
  id: string,
  principal: KnowledgePrincipal,
  landscape: Awaited<ReturnType<typeof loadDcLandscape>>,
): boolean {
  if (kind === "library") {
    const lib = landscape.libraries.get(id);
    if (!lib) return false;
    return chainReadable([lib.acl], lib.visibility, principal, effectiveOwnerFor(null, null, id, landscape));
  }
  // A folder in the trash is never offered as a container.
  const folder = landscape.folders.get(id);
  if (!folder) return false;
  const fc = folderChain(id, landscape);
  // A rung missing (its library, or an ancestor its parent pointers name):
  // unreadable to everyone but a controller (DEC-43).
  if (!fc) return principal.isController;
  return chainReadable(fc.chain, fc.visibility, principal, effectiveOwnerFor(null, id, folder.library_id, landscape));
}

/** All folder ids in the subtree rooted at folderId (inclusive). */
export function folderSubtree(
  folderId: string,
  landscape: Awaited<ReturnType<typeof loadDcLandscape>>,
): Set<string> {
  const children = new Map<string, string[]>();
  for (const [id, f] of landscape.folders) {
    if (!f.parent_id) continue;
    const list = children.get(f.parent_id) ?? [];
    list.push(id);
    children.set(f.parent_id, list);
  }
  const out = new Set<string>();
  const stack = [folderId];
  while (stack.length) {
    const cur = stack.pop() as string;
    if (out.has(cur)) continue;
    out.add(cur);
    for (const child of children.get(cur) ?? []) stack.push(child);
  }
  return out;
}

type DocAclRow = {
  id: string;
  library_id: string | null;
  collection_id: string | null;
  acl: AccessControl | null;
  visibility: NodeVisibility | null;
  is_private: boolean | null;
  scope: string | null;
  created_by: string | null;
  owner_user_id?: string | null;
};

/** The ACL chain above one controlled document (its library's ACL, then its
 *  folder lineage), or `null` when a rung it names is absent from the
 *  landscape — its library, its folder, or an ancestor (KACL-12 done-when 3:
 *  never evaluated without that rung). A document in no folder needs only
 *  its library. */
function documentContainerChain(
  doc: Pick<DocAclRow, "library_id" | "collection_id">,
  landscape: Awaited<ReturnType<typeof loadDcLandscape>>,
): Array<AccessControl | null> | null {
  if (doc.collection_id) {
    const fc = folderChain(doc.collection_id, landscape);
    if (!fc) return null;
    const folder = anyFolder(doc.collection_id, landscape);
    // The document's own library, when it names one, must be there too.
    if (doc.library_id && doc.library_id !== folder?.library_id) {
      const own = landscape.libraries.get(doc.library_id);
      if (!own) return null;
      return [own.acl ?? null, ...fc.chain.slice(1)];
    }
    return fc.chain;
  }
  const lib = doc.library_id ? landscape.libraries.get(doc.library_id) : undefined;
  if (!lib) return null;
  return [lib.acl ?? null];
}

/** Which of these CONTROLLED documents can this principal read? Evaluates
 *  the full chain (library → folder lineage → document) per doc.
 *
 *  KACL-12: THROWS DcLandscapeUnreadableError when the landscape cannot be
 *  read in full — every caller already fails closed on a throw (the orchestrator's tools
 *  and chips, the ask route, drawing, locate, share serving and listing,
 *  the history filter, /api/flows/browse). A document whose library or
 *  folder is absent from the landscape is not readable. */
export async function readableControlledDocIds(
  principal: KnowledgePrincipal,
  docIds: string[],
): Promise<Set<string>> {
  const readable = new Set<string>();
  if (docIds.length === 0) return readable;
  if (principal.isController) return new Set(docIds);

  const landscape = await loadDcLandscape(principal.orgId);
  const docs: DocAclRow[] = [];
  for (let i = 0; i < docIds.length; i += 100) {
    // A failed read of the documents' own rows reads as "no rows": nothing
    // in that slice is readable (closed), as before.
    const { data } = await supabaseAdmin
      .from("documents")
      .select("id, library_id, collection_id, acl, visibility, is_private, scope, created_by, owner_user_id")
      .in("id", docIds.slice(i, i + 100));
    docs.push(...((data ?? []) as DocAclRow[]));
  }

  for (const doc of docs) {
    // Private drafts belong to their creator alone.
    if ((doc.is_private || doc.scope === "private") && doc.created_by !== principal.uid) continue;
    const above = documentContainerChain(doc, landscape);
    if (!above) continue;
    const chain = [...above, doc.acl];
    const owner = effectiveOwnerFor(doc.owner_user_id, doc.collection_id, doc.library_id, landscape);
    if (chainReadable(chain, doc.visibility, principal, owner)) readable.add(doc.id);
  }
  return readable;
}
