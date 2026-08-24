import type {
  AccessControl,
  PermissionAction,
  Role,
  NodeVisibility,
} from "@/types/schema";
import { evaluateAclChain } from "@/lib/acl";

export interface Principal {
  uid: string;
  role: Role;
  orgId?: string;
  teamIds?: string[];
  /** Defense-in-depth: when known to be false, ACL grants are dropped. */
  isActiveMember?: boolean;
}

export function isControllerRole(role: Role) {
  return role === "Admin" || role === "DocCtrl";
}

export function canWithAclChain(params: {
  principal: Principal;
  action: PermissionAction;
  aclChain?: (AccessControl | undefined)[];
  defaultAllow?: boolean;
}): boolean {
  const { principal, action, aclChain = [], defaultAllow = true } = params;

  if (isControllerRole(principal.role)) return true;

  const decision = evaluateAclChain(aclChain, {
    uid: principal.uid,
    role: principal.role,
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
  const role = p.role as string;
  const teams = p.teamIds ?? [];
  const has = (m: Record<string, string[]> | undefined, act: string, id: string) =>
    Array.isArray(m?.[act]) && (m[act] as string[]).includes(id);
  const deniedPublish =
    has(idx.deny?.users, "publish", uid) ||
    has(idx.deny?.roles, "publish", role) ||
    teams.some((t) => has(idx.deny?.teams, "publish", t));
  if (deniedPublish) return false;
  const allowActs = ["publish", "admin"];
  return allowActs.some((a) =>
    has(idx.allow?.users, a, uid) ||
    has(idx.allow?.roles, a, role) ||
    teams.some((t) => has(idx.allow?.teams, a, t)),
  );
}

export function canPublishOnLibrary(params: {
  principal: Principal;
  libraryAcl?: AccessControl;
}): boolean {
  if (isControllerRole(params.principal.role)) return true;
  const decision = evaluateAclChain([params.libraryAcl], {
    uid: params.principal.uid,
    role: params.principal.role,
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
}): boolean {
  const { principal, aclChain = [], visibility = "normal" } = params;

  if (isControllerRole(principal.role)) return true;

  const decision = evaluateAclChain(aclChain, {
    uid: principal.uid,
    role: principal.role,
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
