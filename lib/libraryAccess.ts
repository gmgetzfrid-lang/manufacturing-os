// lib/libraryAccess.ts — the library read check and the explorer's ACL
// chains, in one place (intelligence DACL-10 / DACL-9).
//
// DACL-10: the documents home hid a library with a legacy role-array model
// (readAccess / visibleTo) that existed on that one screen; the library's
// own page applied nothing, so a direct URL rendered the library — and, for a
// legacy row whose readAccess is restricted while its ACL is empty, every
// document in it. Both pages now ask the functions below:
//   · libraryReadsByRole — the home page's rule, unchanged (moved here);
//   · effectiveLibraryAcl — the library's ACL, or, for a legacy row whose ACL
//     says nothing while readAccess is restricted, the ACL the library
//     wizard would write for that readAccess (an allow of discover / read /
//     download to each listed role — lib/acl's wizard vocabulary). The
//     library page evaluates its folders and documents under it, so a legacy
//     restriction binds the contents as it binds the card, and a grant deeper
//     in the tree (a folder shared with another role) still merges in.
//
// DACL-9: the library page evaluated a document's chain from the folders the
// browser happened to receive. RLS hides a private folder the reader has no
// grant on, so its ACL silently dropped out of every chain below it and a
// chain left empty fell back to allow. folderAclChain / docAclChain report
// whether the ancestry was resolved in full; when it was not, the page
// decides on the row's chain-resolved acl_index (built by the server from
// the WHOLE chain — the drawer's save, the folder-move rebuild and the
// nightly rebuild, DEC-10) instead of the truncated chain. They also push
// the library's ACL once (buildDocChain pushed it twice).

import { aclSaysSomething } from "@/lib/acl";
import { canDiscover, canReadViaIndex, canWithAclChain, type Principal } from "@/lib/permissions";
import type { AccessControl, AclIndex, NodeVisibility, PermissionAction, Role } from "@/types/schema";

export interface LibraryAccessFields {
  readAccess?: Role[] | "ALL" | null;
  visibleTo?: Role[] | null;
  acl?: AccessControl | null;
  visibility?: NodeVisibility | null;
}

const toRoles = (v: unknown): Role[] => (Array.isArray(v) ? (v as Role[]) : []);

/** The documents home's rule (was computeCanRead in
 *  app/(protected)/documents/page.tsx): "ALL", or any held role named in
 *  readAccess or visibleTo (ADD-1: the full collection, not the headline). */
export function libraryReadsByRole(lib: Pick<LibraryAccessFields, "readAccess" | "visibleTo">, role: Role, roles: Role[] = []): boolean {
  if (lib.readAccess === "ALL") return true;
  const readList = toRoles(lib.readAccess);
  const visibleTo = toRoles(lib.visibleTo);
  const held = [role, ...roles];
  return held.some((r) => readList.includes(r) || visibleTo.includes(r));
}

/** readAccess is "ALL" (the home page's public badge). */
export function libraryIsPublicRead(lib: Pick<LibraryAccessFields, "readAccess">): boolean {
  return lib.readAccess === "ALL";
}

/** The ACL a legacy library's readAccess stands for, when its own ACL says
 *  nothing: an allow of discover / read / download to every role in
 *  readAccess ∪ visibleTo. `undefined` for "ALL" (or a missing value —
 *  the home page reads that as "ALL" too) and whenever the ACL says
 *  something (the ACL is then the model). A restricted list naming NO role
 *  (the home page shows the library to no one but controllers) stands for a
 *  private rung with no grant: a zero-rule normal ACL would say nothing
 *  (lib/acl aclSaysSomething) and leave the contents open, so the rung is
 *  marked private (hidden stays hidden) — a grant deeper in the tree still
 *  merges in, as it does under any restricted library. */
export function legacyLibraryAcl(lib: LibraryAccessFields): AccessControl | undefined {
  if (aclSaysSomething(lib.acl)) return undefined;
  if (lib.readAccess === "ALL" || lib.readAccess == null) return undefined;
  const roles = [...new Set([...toRoles(lib.readAccess), ...toRoles(lib.visibleTo)])];
  const visibility: NodeVisibility = roles.length === 0
    ? (lib.visibility === "hidden" ? "hidden" : "private")
    : (lib.visibility ?? "normal");
  return {
    inherit: true,
    visibility,
    rules: roles.map((r) => ({ effect: "allow" as const, subject: { type: "role" as const, id: r }, actions: ["discover", "read", "download"] as PermissionAction[] })),
  } as AccessControl;
}

/** The library rung the explorer evaluates under (see the header). */
export function effectiveLibraryAcl(lib: LibraryAccessFields | null | undefined): AccessControl | undefined {
  if (!lib) return undefined;
  return legacyLibraryAcl(lib) ?? (lib.acl ?? undefined);
}

interface ExplorerFolder {
  id?: string;
  pathIds?: string[];
  acl?: AccessControl;
  aclIndex?: AclIndex;
  visibility?: NodeVisibility;
}
interface ExplorerDoc {
  collectionId?: string | null;
  acl?: AccessControl;
  aclIndex?: AclIndex;
}

/** A folder's chain: the library rung, each ancestor from path_ids (root
 *  first), the folder itself. `complete` is false when an ancestor named in
 *  path_ids is not among the folders the browser received. */
export function folderAclChain(
  libraryAcl: AccessControl | undefined,
  folder: ExplorerFolder | null | undefined,
  folderMap: ReadonlyMap<string, ExplorerFolder>,
): { chain: AccessControl[]; complete: boolean } {
  const chain: AccessControl[] = [];
  let complete = true;
  if (libraryAcl) chain.push(libraryAcl);
  for (const id of folder?.pathIds ?? []) {
    const node = folderMap.get(id);
    if (!node) { complete = false; continue; }
    if (node.acl) chain.push(node.acl);
  }
  if (folder?.acl) chain.push(folder.acl);
  return { chain, complete };
}

/** A document's chain: the library rung ONCE, its folder's lineage and the
 *  folder, then the document. `complete` is false when its folder, or an
 *  ancestor of it, is not among the folders the browser received. */
export function docAclChain(
  libraryAcl: AccessControl | undefined,
  doc: ExplorerDoc | null | undefined,
  folderMap: ReadonlyMap<string, ExplorerFolder>,
): { chain: AccessControl[]; complete: boolean } {
  const chain: AccessControl[] = [];
  let complete = true;
  if (libraryAcl) chain.push(libraryAcl);
  if (doc?.collectionId) {
    const folder = folderMap.get(doc.collectionId);
    if (!folder) complete = false;
    else {
      const fc = folderAclChain(undefined, folder, folderMap);
      chain.push(...fc.chain);
      complete = fc.complete;
    }
  }
  if (doc?.acl) chain.push(doc.acl);
  return { chain, complete };
}

const EVERY_ACTION: PermissionAction[] = [
  "discover", "read", "download", "upload", "createFolder", "editMetadata", "write", "publish", "managePermissions", "admin",
];

/** May the reader see this folder in the explorer? canDiscover over the
 *  chain when it is complete; otherwise the row's chain-resolved acl_index
 *  decides (discover on a hidden / private folder, any granted action on a
 *  normal one — canDiscover's rule), and a row with no index keeps today's
 *  evaluation of what was received. */
export function explorerFolderVisible(
  principal: Principal,
  libraryAcl: AccessControl | undefined,
  folder: ExplorerFolder,
  folderMap: ReadonlyMap<string, ExplorerFolder>,
  effectiveOwnerUserId: string | null,
): boolean {
  const { chain, complete } = folderAclChain(libraryAcl, folder, folderMap);
  const visibility = folder.visibility ?? "normal";
  if (!complete) {
    const actions = visibility === "hidden" || visibility === "private" ? (["discover"] as PermissionAction[]) : EVERY_ACTION;
    const viaIndex = canReadViaIndex(folder.aclIndex ?? null, principal, actions, effectiveOwnerUserId);
    if (viaIndex !== null) return viaIndex;
  }
  return canDiscover({ principal, visibility, aclChain: chain, effectiveOwnerUserId });
}

/** May the reader see this document in the explorer? canWithAclChain(read)
 *  over the chain when it is complete; otherwise the row's chain-resolved
 *  acl_index decides read, and a row with no index keeps today's evaluation
 *  of what was received. */
export function explorerDocReadable(
  principal: Principal,
  libraryAcl: AccessControl | undefined,
  doc: ExplorerDoc,
  folderMap: ReadonlyMap<string, ExplorerFolder>,
  effectiveOwnerUserId: string | null,
): boolean {
  const { chain, complete } = docAclChain(libraryAcl, doc, folderMap);
  if (!complete) {
    const viaIndex = canReadViaIndex(doc.aclIndex ?? null, principal, ["read"], effectiveOwnerUserId);
    if (viaIndex !== null) return viaIndex;
  }
  return canWithAclChain({ principal, action: "read", aclChain: chain, defaultAllow: true, effectiveOwnerUserId });
}
