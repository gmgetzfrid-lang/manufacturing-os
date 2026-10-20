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
//     download to each listed role, and to the write / admin roles the
//     wizard also lets read — lib/acl's wizard vocabulary). The library page
//     evaluates its folders and documents under it, so a legacy restriction
//     binds the contents as it binds the card, and a grant deeper in the
//     tree (a folder shared with another role) still merges in. Review fix:
//     the AI seam (lib/knowledgeAccess loadDcLandscape) and the bytes door
//     (lib/docFileServer loadContainerAclChain) take the library rung from
//     effectiveLibraryAclFromRow too — one library check on both pages and
//     at every door that reads a document's content for someone.
//
// I-31 (DEC-90 R6; DACL-10 criterion 1's database half): migration 20261228
// writes each legacy library's lists into libraries.acl as EXACTLY the rung
// legacyLibraryAcl returns for it (same roles, same order, same visibility,
// discover / read / download), so after that paste the ACL says something on
// every such row and effectiveLibraryAcl returns it — the same object — with
// no change for any reader that takes the rung; since the I-31 merge that
// includes the ticket triage picker and the workflow-action library check
// (lib/ticketLibrary, intelligence DACL-13 R1). What does move is the
// database's LISTING of a private / hidden row in a written library: once
// its acl_index is built or rebuilt after the paste (at once on upload,
// folder create, move or drawer save; an existing row at the latest at the
// next nightly rebuild) it is listed to the roles the lists name — a row the
// rung already lets them read here (DACL-13 R2, accepted; rows below a
// non-inheriting node do not widen). legacyLibraryAcl stays as the FALLBACK
// (DEC-90's I-31 ruling (2)): before the paste it decides every legacy
// library, after it none, and it still binds a library whose ACL is later
// saved with nothing in it while its lists restrict. Its deletion (and the
// documents home card's move to the ACL) is the integrator's, once the
// 20261228 paste-back reads 0 such libraries (DEC-31).
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
import type { AccessControl, AclIndex, LibraryConfig, NodeVisibility, PermissionAction, Role } from "@/types/schema";

export interface LibraryAccessFields {
  readAccess?: Role[] | "ALL" | null;
  visibleTo?: Role[] | null;
  /** The upload / admin roles (libraries.write_access / admin_access): the
   *  wizard grants them read too (LibraryWizard handleSubmit). */
  writeAccess?: Role[] | null;
  adminAccess?: Role[] | null;
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
 *  readAccess ∪ visibleTo ∪ writeAccess ∪ adminAccess (the wizard lets its
 *  upload and admin roles read — review fix: a write role outside the read
 *  list kept the documents it saw before). `undefined` for "ALL" (or a
 *  missing value — the home page reads that as "ALL" too) and whenever the
 *  ACL says something (the ACL is then the model). A restricted list naming
 *  NO role (the home page shows the library to no one but controllers)
 *  stands for a private rung with no grant: a zero-rule normal ACL would say
 *  nothing (lib/acl aclSaysSomething) and leave the contents open, so the
 *  rung is marked private (hidden stays hidden) — a grant deeper in the tree
 *  still merges in, as it does under any restricted library. */
export function legacyLibraryAcl(lib: LibraryAccessFields): AccessControl | undefined {
  if (aclSaysSomething(lib.acl)) return undefined;
  if (lib.readAccess === "ALL" || lib.readAccess == null) return undefined;
  const roles = [...new Set([
    ...toRoles(lib.readAccess), ...toRoles(lib.visibleTo), ...toRoles(lib.writeAccess), ...toRoles(lib.adminAccess),
  ])];
  const visibility: NodeVisibility = roles.length === 0
    ? (lib.visibility === "hidden" ? "hidden" : "private")
    : (lib.visibility ?? "normal");
  return {
    inherit: true,
    visibility,
    rules: roles.map((r) => ({ effect: "allow" as const, subject: { type: "role" as const, id: r }, actions: ["discover", "read", "download"] as PermissionAction[] })),
  } as AccessControl;
}

/** The actions the library wizard grants its upload roles
 *  (LibraryWizard handleSubmit) — one allow rule per role, exactly these. */
const WIZARD_UPLOAD_ACTIONS: readonly PermissionAction[] = ["upload", "createFolder", "editMetadata", "write", "download", "read", "discover"];

/** ALOG-13 (I-31): the roles the library wizard's upload picker opens with
 *  on an edit. The wizard no longer writes libraries.write_access on a NEW
 *  library (nothing reads it for one whose ACL the wizard writes; an edit
 *  keeps it in step — wizardListColumnsFromAcl), so the picker is
 *  seeded from what the wizard DID write: the role subjects of the ACL's
 *  allow rules carrying exactly the wizard's upload actions, with no expiry
 *  (a drawer-made rule — another action set, or an expiry — is not the
 *  picker's and is never re-emitted as one, which would widen it). A library
 *  whose ACL carries no such rule — a legacy library, a Save-As library born
 *  with no ACL — keeps today's seed, its write_access column (undefined when
 *  that is unset, so the caller's default applies, as before). For every
 *  library the wizard saved before this change the two are the same list in
 *  the same order (the wizard wrote write_access and these rules from one
 *  array). */
export function wizardUploadRolesSeed(lib: { acl?: AccessControl | null; writeAccess?: Role[] | null } | null | undefined): Role[] | undefined {
  if (!lib) return undefined;
  const fromAcl = wizardRoleSubjects(lib.acl, WIZARD_UPLOAD_ACTIONS);
  if (fromAcl.length > 0) return fromAcl;
  return lib.writeAccess ?? undefined;
}

/** The actions the library wizard grants its admin roles (LibraryWizard
 *  handleSubmit) — one allow rule per role, exactly these. */
const WIZARD_ADMIN_ACTIONS: readonly PermissionAction[] = ["admin", "managePermissions"];

function wizardRoleSubjects(acl: AccessControl | null | undefined, actions: readonly PermissionAction[]): Role[] {
  const rules = Array.isArray(acl?.rules) ? acl!.rules : [];
  const out: Role[] = [];
  for (const r of rules) {
    if (!r || r.effect !== "allow" || r.subject?.type !== "role" || typeof r.subject.id !== "string") continue;
    if (r.expiresAt != null) continue;
    const acts = Array.isArray(r.actions) ? r.actions : [];
    const exact = acts.length === actions.length && actions.every((a) => acts.includes(a));
    if (exact && !out.includes(r.subject.id as Role)) out.push(r.subject.id as Role);
  }
  return out;
}

/** ALOG-13 (I-31 second review fix): the write_access / admin_access a wizard
 *  EDIT writes, derived from the wizard's own ACL (pass the wizard's form
 *  ACL, not the drawer-merged one): the role subjects of its upload rules and
 *  of its admin rules — the same lists, in the same order, the wizard wrote
 *  to the columns before I-31 (one array fed both). A new library does not
 *  write them (nothing reads them for it: its ACL always says something, and
 *  a NULL column is no role). An edited library keeps them in step with the
 *  ACL until legacyLibraryAcl is deleted, because that fallback still reads
 *  them if the ACL is later saved with nothing in it — a frozen pre-I-31
 *  value there would hand a role the wizard since removed its read back. */
export function wizardListColumnsFromAcl(acl: AccessControl | null | undefined): { write_access: Role[]; admin_access: Role[] } {
  return { write_access: wizardRoleSubjects(acl, WIZARD_UPLOAD_ACTIONS), admin_access: wizardRoleSubjects(acl, WIZARD_ADMIN_ACTIONS) };
}

/** The library rung the explorer evaluates under (see the header). */
export function effectiveLibraryAcl(lib: LibraryAccessFields | null | undefined): AccessControl | undefined {
  if (!lib) return undefined;
  return legacyLibraryAcl(lib) ?? (lib.acl ?? undefined);
}

/** The columns a server read of `libraries` selects for the library rung. */
export const LIBRARY_RUNG_COLUMNS = "acl, visibility, read_access, visible_to, write_access, admin_access";

/** effectiveLibraryAcl over a raw `libraries` row (the server's reads —
 *  lib/knowledgeAccess loadDcLandscape, lib/docFileServer
 *  loadContainerAclChain). read_access is JSONB: the string "ALL" or a role
 *  array; NULL reads as "ALL" (the home page's rule), so a NULL never
 *  synthesizes a rung. Any OTHER value — a JSON string other than "ALL", an
 *  object, a number (a hand-edited legacy row) — is restricted, naming no
 *  role: the pages' reading (the documents home's libraryReadsByRole and the
 *  library page's `read_access ?? "ALL"` both hide such a library), so a
 *  malformed list restricts at the server too, never opens it (I-12 review
 *  fix: it read as no rung — open at the AI seam and the bytes door). */
export function effectiveLibraryAclFromRow(row: Record<string, unknown> | null | undefined): AccessControl | undefined {
  if (!row) return undefined;
  return effectiveLibraryAcl(libraryAccessFieldsFromRow(row));
}

/** A raw `libraries` row (LIBRARY_RUNG_COLUMNS) read as the rung's fields,
 *  by effectiveLibraryAclFromRow's rules (above) — exported so a reader that
 *  keeps the fields on its own row shape (lib/ticketLibrary LibraryChoiceRow,
 *  DACL-13 R1) decides by exactly the same reading. */
export function libraryAccessFieldsFromRow(row: Record<string, unknown>): LibraryAccessFields {
  const ra = row.read_access;
  return {
    readAccess: ra === "ALL" ? "ALL" : ra == null ? null : Array.isArray(ra) ? (ra as Role[]) : [],
    visibleTo: toRoles(row.visible_to),
    writeAccess: toRoles(row.write_access),
    adminAccess: toRoles(row.admin_access),
    acl: (row.acl as AccessControl | null | undefined) ?? null,
    visibility: (row.visibility as NodeVisibility | null | undefined) ?? null,
  };
}

/** DACL-10 done-when 2 (review fix): may the reader see THIS library at all
 *  — the library page's "You don't have access" state? The explorer's own
 *  evaluation of the library rung (canDiscover over effectiveLibraryAcl,
 *  with the reader's role collection, teams and uid — so a team or user
 *  grant in the Permissions drawer counts), never the legacy role arrays
 *  alone. The library's owner and controllers see it (canDiscover's
 *  short-circuits) — the owner only when the caller passes `ownerUserId`,
 *  which the library page reads with the row (LIBRARY_PAGE_COLUMNS /
 *  libraryConfigFromRow; I-12 second review fix: the page never loaded it,
 *  so a legacy-restricted library hid its contents from its own owner).
 *  The team-supervisor rung of the ownership cascade resolves database-side
 *  only (as on base). `null` principal (SESS-6: no role known) sees nothing. */
export function explorerLibraryVisible(
  principal: Principal | null,
  lib: (LibraryAccessFields & { ownerUserId?: string | null }) | null | undefined,
): boolean {
  if (!principal || !lib) return false;
  const rung = effectiveLibraryAcl(lib);
  return canDiscover({
    principal,
    visibility: lib.visibility ?? "normal",
    aclChain: rung ? [rung] : [],
    effectiveOwnerUserId: lib.ownerUserId ?? null,
  });
}

/** The columns the library page reads for its library (the select("*")
 *  fallback carries them too). owner_user_id and visibility are read so the
 *  ownership short-circuit and the library rung's visibility hold on the page
 *  as they do at the AI seam and the bytes door (I-12 second review fix). */
export const LIBRARY_PAGE_COLUMNS =
  "id,org_id,name,description,type,custom_columns,column_label_overrides,uniqueness_keys,write_access,admin_access,read_access,visible_to,folder_security,default_new_visibility,default_new_acl,acl,acl_index,column_widths,color,icon,cover_image_url,cover_tint,home_config,page_config,owner_user_id,visibility";

/** A `libraries` row (LIBRARY_PAGE_COLUMNS, or select("*")) as the library
 *  page's LibraryConfig — the page's mapping, with the owner and the
 *  library's visibility carried (a database without either column maps them
 *  to "no owner" / unset, as before). */
export function libraryConfigFromRow(data: Record<string, unknown> & { id?: unknown }): LibraryConfig {
  const d = data as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  return {
    id: d.id, orgId: d.org_id, name: d.name, description: d.description,
    type: d.type, customColumns: d.custom_columns ?? [],
    columnLabelOverrides: d.column_label_overrides ?? {},
    uniquenessKeys: Array.isArray(d.uniqueness_keys) ? d.uniqueness_keys : undefined,
    writeAccess: d.write_access ?? [], adminAccess: d.admin_access ?? [],
    readAccess: d.read_access ?? "ALL", visibleTo: d.visible_to ?? [],
    folderSecurity: d.folder_security ?? "Inherited",
    defaultNewVisibility: d.default_new_visibility,
    defaultNewAcl: d.default_new_acl, acl: d.acl,
    aclIndex: d.acl_index ?? undefined,
    ownerUserId: d.owner_user_id ?? null,
    visibility: d.visibility ?? undefined,
    color: d.color ?? undefined, icon: d.icon ?? undefined,
    coverImageUrl: d.cover_image_url ?? undefined, coverTint: d.cover_tint ?? undefined,
    homeConfig: d.home_config ?? undefined,
    pageConfig: d.page_config ?? undefined,
  } as LibraryConfig;
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
