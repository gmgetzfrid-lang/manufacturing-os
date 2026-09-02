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
 *  `is_org_controller` (role IN (...) OR roles && ARRAY[...]). */
export function isControllerPrincipal(p: Pick<Principal, "role" | "roles">): boolean {
  return heldRoles(p).some(isControllerRole);
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
 * publish|admin allow via user, role, or team grants.
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
  const has = (m: Record<string, string[]> | undefined, act: string, id: string) =>
    Array.isArray(m?.[act]) && (m[act] as string[]).includes(id);
  const deniedPublish =
    has(idx.deny?.users, "publish", uid) ||
    roles.some((r) => has(idx.deny?.roles, "publish", r)) ||
    teams.some((t) => has(idx.deny?.teams, "publish", t));
  if (deniedPublish) return false;
  const allowActs = ["publish", "admin"];
  return allowActs.some((a) =>
    has(idx.allow?.users, a, uid) ||
    roles.some((r) => has(idx.allow?.roles, a, r)) ||
    teams.some((t) => has(idx.allow?.teams, a, t)),
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

// canBlindDrillAccess and filterDiscoverable were removed under DEC-11: both
// were exported with zero callers, pure, and trivially restorable from git.
// The blind-drill capability itself lives on in lib/acl.ts (canBlindDrill)
// and is exercised through canDiscover above.
