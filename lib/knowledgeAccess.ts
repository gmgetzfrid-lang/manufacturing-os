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
// truth) — never a parallel re-implementation.

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { evaluateAclChain } from "@/lib/acl";
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

/** Load the principal (role + teams) the ACL engine evaluates against. */
export async function loadPrincipal(orgId: string, uid: string): Promise<KnowledgePrincipal | null> {
  const [{ data: member }, { data: teams }] = await Promise.all([
    supabaseAdmin.from("org_members").select("role, roles")
      .eq("org_id", orgId).eq("uid", uid).eq("status", "active").maybeSingle(),
    supabaseAdmin.from("team_members").select("team_id").eq("uid", uid),
  ]);
  if (!member) return null;
  const roles = new Set<string>([member.role as string, ...((member.roles as string[]) ?? [])]);
  return {
    uid,
    orgId,
    role: (member.role as Role) ?? ("Viewer" as Role),
    roles: [...roles].filter(Boolean) as Role[],
    isController: roles.has("Admin") || roles.has("DocCtrl"),
    teamIds: (teams ?? []).map((t) => t.team_id as string),
  };
}

type ContainerNode = {
  acl: AccessControl | null;
  visibility: NodeVisibility | null;
  parent_id?: string | null;
};

/** Read-decision for one node given its ancestor ACL chain. Default-allow
 *  (matching the app's screens) EXCEPT hidden nodes, which need an explicit
 *  grant to surface. */
function chainReadable(
  chain: Array<AccessControl | null | undefined>,
  visibility: NodeVisibility | null | undefined,
  principal: KnowledgePrincipal,
): boolean {
  if (principal.isController) return true;
  const decision = evaluateAclChain(
    chain.map((a) => a ?? undefined),
    {
      uid: principal.uid,
      role: principal.role,
      roles: principal.roles,
      orgId: principal.orgId,
      teamIds: principal.teamIds,
      isActiveMember: true,
    },
  );
  if (decision) {
    if (visibility === "hidden") return decision.can("read") || decision.isDiscoverable();
    return decision.can("read");
  }
  return visibility !== "hidden";
}

/** The document-control landscape needed for chain evaluation, fetched once
 *  per request. */
export async function loadDcLandscape(orgId: string): Promise<{
  libraries: Map<string, ContainerNode & { name: string }>;
  folders: Map<string, ContainerNode & { name: string; library_id: string; path_names: string[] }>;
}> {
  // collections is select("*") so the trash filter works before AND after
  // migration 20261011 (naming deleted_at explicitly would 42703 pre-migration).
  const [libsRes, foldersRes] = await Promise.all([
    supabaseAdmin.from("libraries").select("id, name, acl, visibility").eq("org_id", orgId),
    supabaseAdmin.from("collections").select("*").eq("org_id", orgId),
  ]);
  const libraries = new Map<string, ContainerNode & { name: string }>();
  for (const l of libsRes.data ?? []) {
    libraries.set(l.id as string, {
      name: (l.name as string) ?? "Library",
      acl: (l.acl as AccessControl) ?? null,
      visibility: (l.visibility as NodeVisibility) ?? null,
    });
  }
  const folders = new Map<string, ContainerNode & { name: string; library_id: string; path_names: string[] }>();
  for (const c of foldersRes.data ?? []) {
    if ((c as Record<string, unknown>).deleted_at) continue; // in the 30-day trash
    folders.set(c.id as string, {
      name: (c.name as string) ?? "Folder",
      library_id: c.library_id as string,
      parent_id: (c.parent_id as string | null) ?? null,
      acl: (c.acl as AccessControl) ?? null,
      visibility: (c.visibility as NodeVisibility) ?? null,
      path_names: (c.path_names as string[]) ?? [],
    });
  }
  return { libraries, folders };
}

/** Build the ACL chain for a folder: library ACL, then ancestors top-down,
 *  then the folder itself. Cycle-guarded. */
function folderChain(
  folderId: string,
  landscape: Awaited<ReturnType<typeof loadDcLandscape>>,
): { chain: Array<AccessControl | null>; visibility: NodeVisibility | null } | null {
  const folder = landscape.folders.get(folderId);
  if (!folder) return null;
  const lineage: Array<AccessControl | null> = [];
  let cur: string | null = folderId;
  const seen = new Set<string>();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const node = landscape.folders.get(cur);
    if (!node) break;
    lineage.unshift(node.acl);
    cur = node.parent_id ?? null;
  }
  const lib = landscape.libraries.get(folder.library_id);
  return { chain: [lib?.acl ?? null, ...lineage], visibility: folder.visibility };
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
    return chainReadable([lib.acl], lib.visibility, principal);
  }
  const fc = folderChain(id, landscape);
  if (!fc) return false;
  return chainReadable(fc.chain, fc.visibility, principal);
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
};

/** Which of these CONTROLLED documents can this principal read? Evaluates
 *  the full chain (library → folder lineage → document) per doc. */
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
    const { data } = await supabaseAdmin
      .from("documents")
      .select("id, library_id, collection_id, acl, visibility, is_private, scope, created_by")
      .in("id", docIds.slice(i, i + 100));
    docs.push(...((data ?? []) as DocAclRow[]));
  }

  for (const doc of docs) {
    // Private drafts belong to their creator alone.
    if ((doc.is_private || doc.scope === "private") && doc.created_by !== principal.uid) continue;
    const lib = doc.library_id ? landscape.libraries.get(doc.library_id) : null;
    const fc = doc.collection_id ? folderChain(doc.collection_id, landscape) : null;
    const chain = [lib?.acl ?? null, ...(fc?.chain.slice(1) ?? []), doc.acl];
    if (chainReadable(chain, doc.visibility, principal)) readable.add(doc.id);
  }
  return readable;
}
