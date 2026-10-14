import type {
  AccessControl,
  PermissionAction,
  Role,
  NodeVisibility,
} from "@/types/schema";
import { evaluateAclChain } from "@/lib/acl";

export interface Principal {
  uid: string;
  /** The headline (highest-ranked) role — kept for display and for the
   *  legacy single-role callers. Authority reads `roles` when present. */
  role: Role;
  /** OWN-3 / CHAIN-1: the member's FULL additive role collection. When
   *  supplied, every role-shaped decision (controller tier, ACL role
   *  subjects — allow AND deny) evaluates against all of them, so a role is
   *  worth the same whether it is the headline or an additive one, and a
   *  restriction binds whether or not something higher-ranked sits above it. */
  roles?: Role[];
  orgId?: string;
  teamIds?: string[];
  /** Defense-in-depth: when known to be false, ACL grants are dropped. */
  isActiveMember?: boolean;
}

export function isControllerRole(role: Role) {
  return role === "Admin" || role === "DocCtrl";
}

/** Every role the principal holds: headline ∪ additive collection, deduped.
 *  Never empty — the headline is always present. */
export function heldRoles(p: Pick<Principal, "role" | "roles">): Role[] {
  const out: Role[] = [];
  for (const r of [p.role, ...(p.roles ?? [])]) {
    if (r && !out.includes(r)) out.push(r);
  }
  return out;
}

/** OWN-3/DEC-2: the controller tier is a property of the COLLECTION — a
 *  DocCtrl who also holds Manager (headline `Manager`, since Manager
 *  outranks DocCtrl) is still a controller. Mirrors the database's
 *  `is_org_controller` (role IN (...) OR roles && ARRAY[...]).
 *  SESS-6: the client's headline is `null` until a membership resolves
 *  (RoleContext), and its collection is then empty — so "no role known" is
 *  never a controller. The same answer as heldRoles(p).some(isControllerRole)
 *  for every real headline; Principal.role itself stays a Role. */
export function isControllerPrincipal(p: Pick<Principal, "roles"> & { role: Role | null }): boolean {
  return (p.role !== null && isControllerRole(p.role)) || (p.roles ?? []).some(isControllerRole);
}

export function canWithAclChain(params: {
  principal: Principal;
  action: PermissionAction;
  aclChain?: (AccessControl | undefined)[];
  defaultAllow?: boolean;
  /** GAP-15/DEC-7: the node's effective owner — ownership carries read
   *  access, matching the DB's node_visible ownership branch. Only the
   *  read/discover-shaped checks should pass this; write-shaped authority
   *  keeps its own rules. */
  effectiveOwnerUserId?: string | null;
}): boolean {
  const { principal, action, aclChain = [], defaultAllow = true } = params;

  if (isControllerPrincipal(principal)) return true;
  if (params.effectiveOwnerUserId && principal.uid
      && params.effectiveOwnerUserId === principal.uid
      && (action === "read" || action === "discover")) return true;

  const decision = evaluateAclChain(aclChain, {
    uid: principal.uid,
    role: principal.role,
    roles: heldRoles(principal),
    orgId: principal.orgId,
    teamIds: principal.teamIds,
    isActiveMember: principal.isActiveMember,
  });

  if (!decision) return defaultAllow;
  return decision.can(action);
}

/**
 * May this principal PUBLISH document revisions (rev-up / supersede / revert) on
 * a given library?
 *
 *   - Admin and DocCtrl may publish on every library (the broad controller tier;
 *     unchanged behavior).
 *   - Anyone else may publish ONLY where the LIBRARY's own ACL grants them the
 *     "publish" action — e.g. a Drafting Supervisor on the drawings library, but
 *     never on procedures. Absent a grant it is denied: publishing is privileged
 *     and never default-allows.
 *
 * We evaluate ONLY the library's ACL on purpose: the authority is scoped to the
 * library, so folder/document rules must neither widen nor narrow it. This pure
 * helper is the single source of truth, used by the publish button, the lib
 * mutators, and mirrored by the DB publish-guard trigger.
 */
/**
 * Evaluate publish authority from the DENORMALIZED acl_index — the exact
 * column the DB's user_can_publish_on_library() reads. Returns null when the
 * index is absent (caller falls back to the raw-ACL evaluator). Preferring
 * the index keeps app-side and DB-side authority reading the SAME source, so
 * a writer that updates only one column can no longer fork security.
 * Semantics mirror the SQL: an explicit publish deny wins; then any
 * publish|admin allow via user, role, team, or org grants.
 */
export function canPublishViaIndex(
  idx: import("@/types/schema").AclIndex | null | undefined,
  p: Principal,
): boolean | null {
  if (!idx || (!idx.allow && !idx.deny)) return null;
  if (p.isActiveMember === false) return false;
  const uid = p.uid;
  // CHAIN-1 / ADD-1: role subjects match ANY held role — a deny naming an
  // additively-held role binds, and an allow naming one grants.
  const roles = heldRoles(p) as string[];
  const teams = p.teamIds ?? [];
  // OWN-18: an org-subject rule ("everyone in the org") is a first-class
  // subject in the drawer, the raw evaluator and can_manage_node — so the
  // publish evaluators honour the `orgs` bucket too (allow AND deny, keyed by
  // the org id), exactly as user_can_publish_on_library does.
  const org = p.orgId ?? null;
  const has = (m: Record<string, string[]> | undefined, act: string, id: string) =>
    Array.isArray(m?.[act]) && (m[act] as string[]).includes(id);
  const deniedPublish =
    has(idx.deny?.users, "publish", uid) ||
    roles.some((r) => has(idx.deny?.roles, "publish", r)) ||
    teams.some((t) => has(idx.deny?.teams, "publish", t)) ||
    (!!org && has(idx.deny?.orgs, "publish", org));
  if (deniedPublish) return false;
  // OWN-8 / DEC-8: an 'admin' allow grants publish only when 'admin' is not
  // itself explicitly denied (user / ANY held role / team / org) — mirrors
  // user_can_publish_on_library's v_admin_denied.
  const deniedAdmin =
    has(idx.deny?.users, "admin", uid) ||
    roles.some((r) => has(idx.deny?.roles, "admin", r)) ||
    teams.some((t) => has(idx.deny?.teams, "admin", t)) ||
    (!!org && has(idx.deny?.orgs, "admin", org));
  const allowActs = deniedAdmin ? ["publish"] : ["publish", "admin"];
  return allowActs.some((a) =>
    has(idx.allow?.users, a, uid) ||
    roles.some((r) => has(idx.allow?.roles, a, r)) ||
    teams.some((t) => has(idx.allow?.teams, a, t)) ||
    (!!org && has(idx.allow?.orgs, a, org)),
  );
}

export function canPublishOnLibrary(params: {
  principal: Principal;
  libraryAcl?: AccessControl;
}): boolean {
  if (isControllerPrincipal(params.principal)) return true;
  const decision = evaluateAclChain([params.libraryAcl], {
    uid: params.principal.uid,
    role: params.principal.role,
    roles: heldRoles(params.principal),
    orgId: params.principal.orgId,
    teamIds: params.principal.teamIds,
    isActiveMember: params.principal.isActiveMember,
  });
  return decision ? decision.can("publish") : false;
}

export function canDiscover(params: {
  principal: Principal;
  aclChain?: (AccessControl | undefined)[];
  visibility?: NodeVisibility;
  /** GAP-15/DEC-7: the node's EFFECTIVE owner (document → folder → library
   *  cascade, resolved by the caller from the data it has). Ownership carries
   *  read access — the DB's node_visible now grants the owner SELECT, and
   *  this mirror must not re-hide rows the database deliberately returned. */
  effectiveOwnerUserId?: string | null;
}): boolean {
  const { principal, aclChain = [], visibility = "normal" } = params;

  if (isControllerPrincipal(principal)) return true;
  if (params.effectiveOwnerUserId && principal.uid
      && params.effectiveOwnerUserId === principal.uid) return true;

  const decision = evaluateAclChain(aclChain, {
    uid: principal.uid,
    role: principal.role,
    roles: heldRoles(principal),
    orgId: principal.orgId,
    teamIds: principal.teamIds,
    isActiveMember: principal.isActiveMember,
  });

  if (!decision) return visibility !== "hidden" && visibility !== "private";

  if (visibility === "hidden" || visibility === "private") {
    return decision.can("discover");
  }

  return decision.isDiscoverable();
}

/** IEDGE-12: THE read predicate — may this principal read a node's CONTENT,
 *  given the full ACL chain above it (library → folder lineage → the node)?
 *  One function, asked by every door that hands out what a document says:
 *  the knowledge seam (lib/knowledgeAccess chainReadable — the AI's ask,
 *  orchestrator, drawing, locate, share serving), the bytes door
 *  (canServeContent → /api/storage/download-url) and the service-role page
 *  reader (lib/docFileServer).
 *
 *   - a controller (by the role collection, DEC-2 / DEC-43) and the node's
 *     effective owner (GAP-15 / DEC-7) read;
 *   - wherever the chain says something (lib/acl aclSaysSomething: a rule,
 *     or a hidden / private node), one of `actions` must be granted — and an
 *     explicit deny of it wins (DEC-8). A discover-only grant is never a read
 *     (DOCACL-5, KACL-3), whatever the visibility;
 *   - a chain that says nothing is default-open for a NORMAL node only — a
 *     hidden or private one with no ACL anywhere is controllers' and the
 *     owner's alone (KACL-11; canDiscover's fallback).
 *
 *  `actions` is what counts as reading: the AI seam asks `read`; the bytes
 *  door asks `read` or `download` (a download grant hands over the file). */
export function canReadNode(params: {
  principal: Principal;
  aclChain?: (AccessControl | null | undefined)[];
  visibility?: NodeVisibility | null;
  effectiveOwnerUserId?: string | null;
  actions?: readonly PermissionAction[];
}): boolean {
  const { principal, aclChain = [], actions = ["read"] } = params;
  const visibility: NodeVisibility = params.visibility === "hidden" || params.visibility === "private"
    ? params.visibility : "normal";
  if (isControllerPrincipal(principal)) return true;
  if (params.effectiveOwnerUserId && principal.uid && params.effectiveOwnerUserId === principal.uid) return true;
  const decision = evaluateAclChain(aclChain.map((a) => a ?? undefined), {
    uid: principal.uid,
    role: principal.role,
    roles: heldRoles(principal),
    orgId: principal.orgId,
    teamIds: principal.teamIds,
    isActiveMember: principal.isActiveMember,
  });
  if (!decision) return visibility === "normal";
  return actions.some((a) => decision.can(a));
}

/** DACL-9: the same read question asked of a row's chain-resolved
 *  `acl_index` (built from the FULL library → folder → node chain by the
 *  drawer's save, the folder-move rebuild and the nightly rebuild — DEC-10),
 *  for a reader whose browser could not see every ancestor (RLS hides a
 *  private folder the reader has no grant on, so its ACL is not on the page).
 *  `null` when the row carries no index — the caller decides what that means.
 *  Mirrors evaluateAcl's can(): an explicit deny of the action naming the
 *  reader (uid, any held role, a team, the org) wins; then an allow of the
 *  action, or of `admin` while `admin` itself is not denied; an index with
 *  no entry for the reader grants nothing. Controllers and the effective
 *  owner short-circuit as in canReadNode. */
export function canReadViaIndex(
  idx: import("@/types/schema").AclIndex | null | undefined,
  p: Principal,
  actions: readonly PermissionAction[] = ["read"],
  effectiveOwnerUserId?: string | null,
): boolean | null {
  if (isControllerPrincipal(p)) return true;
  if (effectiveOwnerUserId && p.uid && effectiveOwnerUserId === p.uid) return true;
  if (!idx || (!idx.allow && !idx.deny)) return null;
  type Lists = Record<string, string[]> | undefined;
  // An index that names nobody at all carries no rule (buildAclIndexFromRules
  // writes none for zero rules) — unknown, not "denied to everyone".
  const anyEntry = (bucket: Record<string, Lists> | undefined) => !!bucket
    && Object.values(bucket).some((m) => !!m && Object.values(m).some((l) => Array.isArray(l) && l.length > 0));
  if (!anyEntry(idx.allow as unknown as Record<string, Lists>) && !anyEntry(idx.deny as unknown as Record<string, Lists>)) return null;
  if (p.isActiveMember === false) return false;
  const roles = heldRoles(p) as string[];
  const teams = p.teamIds ?? [];
  const org = p.orgId ?? null;
  const has = (m: Lists, act: string, id: string) =>
    Array.isArray(m?.[act]) && (m[act] as string[]).includes(id);
  const names = (bucket: { users?: Lists; roles?: Lists; teams?: Lists; orgs?: Lists } | undefined, act: string) => !!bucket && (
    has(bucket.users, act, p.uid) ||
    roles.some((r) => has(bucket.roles, act, r)) ||
    teams.some((t) => has(bucket.teams, act, t)) ||
    (!!org && has(bucket.orgs, act, org))
  );
  const adminDenied = names(idx.deny, "admin");
  return actions.some((a) => {
    if (names(idx.deny, a)) return false;
    if (!adminDenied && names(idx.allow, "admin")) return true;
    return names(idx.allow, a);
  });
}

/** DOCACL-5 / KACL-5: may this principal be handed the CONTENT (a signed
 *  URL)? `discover` means "may know it exists" — never "may open it".
 *  canReadNode over the FULL chain, asking `read` or `download`, on EVERY
 *  visibility: an allow-list or a deny on a normal document, or on its folder
 *  or library, binds the bytes door exactly as it binds the AI seam and the
 *  library page (until KACL-5 a normal node was default-open here and only
 *  the document's own ACL was read). The route's explicit download-deny
 *  check still applies on top. */
export function canServeContent(params: {
  principal: Principal;
  aclChain?: (AccessControl | null | undefined)[];
  visibility?: NodeVisibility | null;
  effectiveOwnerUserId?: string | null;
}): boolean {
  return canReadNode({ ...params, actions: ["read", "download"] });
}

/** DOCACL-3 / DEC-43: did the CONTROLLER bypass decide this content read?
 *  True when the principal is a controller (Admin / DocCtrl by collection)
 *  AND the same person stripped of the controller roles would NOT be served
 *  the bytes — i.e. the node is restricted against them and only the
 *  recovery rail let them through. Controllers are unscoped by design; the
 *  mitigation is that such reads are AUDITED at the bytes-egress point
 *  (app/api/storage/download-url). Pure: one extra evaluation, no I/O. */
export function controllerBypassDecided(params: {
  principal: Principal;
  aclChain?: (AccessControl | undefined)[];
  visibility?: NodeVisibility;
  effectiveOwnerUserId?: string | null;
}): boolean {
  const { principal } = params;
  if (!isControllerPrincipal(principal)) return false;
  const stripped = heldRoles(principal).filter((r) => !isControllerRole(r));
  // A controller with NO other role is evaluated as holding no role at all —
  // never as a Viewer, or an ACL that grants role:Viewer would make the
  // bypass look ACL-served. The sentinel matches no role token; "*" and
  // uid / team subjects still evaluate as they would for anyone.
  const NO_ROLE = "__no_role__" as Role;
  const asMember: Principal = {
    ...principal,
    role: stripped[0] ?? NO_ROLE,
    roles: stripped.length > 0 ? stripped : [NO_ROLE],
  };
  return !canServeContent({ ...params, principal: asMember });
}

// canBlindDrillAccess and filterDiscoverable were removed under DEC-11: both
// were exported with zero callers, pure, and trivially restorable from git.
// The blind-drill capability itself lives on in lib/acl.ts (canBlindDrill)
// and is exercised through canDiscover above.
