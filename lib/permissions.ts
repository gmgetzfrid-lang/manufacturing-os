import type {
  AccessControl,
  PermissionAction,
  Role,
  NodeVisibility,
} from "@/types/schema";
import { evaluateAclChain, canBlindDrill } from "@/lib/acl";

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

export function canBlindDrillAccess(params: {
  principal: Principal;
  aclChain?: (AccessControl | undefined)[];
}): boolean {
  const { principal, aclChain = [] } = params;
  const decision = evaluateAclChain(aclChain, {
    uid: principal.uid,
    role: principal.role,
    orgId: principal.orgId,
    teamIds: principal.teamIds,
    isActiveMember: principal.isActiveMember,
  });

  return canBlindDrill(decision);
}

export function filterDiscoverable<T extends { acl?: AccessControl; visibility?: NodeVisibility }>(
  items: T[],
  principal: Principal,
  aclChainForItem: (item: T) => (AccessControl | undefined)[]
): T[] {
  return items.filter((item) =>
    canDiscover({
      principal,
      visibility: item.visibility ?? "normal",
      aclChain: aclChainForItem(item),
    })
  );
}
