// lib/acl.ts
// Centralized ACL evaluation for folders/files/sets/docs.
// Supports:
// - allow/deny rules
// - rule expiry
// - inheritance (parent -> child)
// - hidden nodes (blind drilling via explicit discover grants)

import type {
  AccessControl,
  AccessRule,
  PermissionAction,
  PermissionSubject,
  PermissionSubjectType,
  NodeVisibility,
  Role,
  AclIndex,
} from "@/types/schema";

export type SubjectContext = {
  uid?: string;
  role?: Role;
  teamIds?: string[];
  orgId?: string;
  now?: Date;
  /**
   * Defense-in-depth org-membership gate. ACL rules live inside an org's data
   * and address subjects by uid/role/team — but a stale rule can still name a
   * uid whose membership was revoked. RLS catches cross-tenant reads, but the
   * ACL layer should not GRANT to a non-member. When a caller knows membership
   * status, pass it: `false` drops all ALLOW grants (DENY rules still apply).
   * Omitted/`true` = unchanged behavior (backward compatible).
   */
  isActiveMember?: boolean;
};

export type AclDecision = {
  visibility: NodeVisibility;
  inherit: boolean;
  allowed: Set<PermissionAction>;
  denied: Set<PermissionAction>;
  can: (action: PermissionAction) => boolean;
  isDiscoverable: () => boolean;
};

function tsToMillis(v: unknown): number | null {
  if (!v) return null;
  if (typeof (v as { toMillis?: () => number }).toMillis === "function") {
    return (v as { toMillis: () => number }).toMillis();
  }
  if (v instanceof Date) return v.getTime();
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const parsed = Date.parse(v);
    return Number.isNaN(parsed) ? null : parsed;
  }
  if (typeof (v as { seconds?: number }).seconds === "number") {
    return (v as { seconds: number }).seconds * 1000;
  }
  return null;
}

function subjectMatches(subj: PermissionSubject, ctx: SubjectContext): boolean {
  const type: PermissionSubjectType = subj.type;
  const id = subj.id;

  switch (type) {
    case "user":
      return !!ctx.uid && ctx.uid === id;
    case "team":
      return Array.isArray(ctx.teamIds) && ctx.teamIds.includes(id);
    case "role":
      return !!ctx.role && ctx.role === (id as Role);
    case "org":
      return !!ctx.orgId && ctx.orgId === id;
    default:
      return false;
  }
}

function isRuleActive(rule: AccessRule, nowMs: number): boolean {
  const exp = tsToMillis(rule.expiresAt);
  if (exp == null) return true;
  return nowMs < exp;
}

function evaluateRules(
  rules: AccessRule[],
  ctx: SubjectContext
): { allowed: Set<PermissionAction>; denied: Set<PermissionAction> } {
  const nowMs = (ctx.now ?? new Date()).getTime();
  const allowed = new Set<PermissionAction>();
  const denied = new Set<PermissionAction>();

  for (const rule of rules ?? []) {
    if (!rule) continue;
    if (!isRuleActive(rule, nowMs)) continue;
    if (!subjectMatches(rule.subject, ctx)) continue;

    const actions = rule.actions ?? [];
    if (rule.effect === "deny") {
      for (const a of actions) denied.add(a);
    } else {
      for (const a of actions) allowed.add(a);
    }
  }

  for (const a of denied) {
    if (allowed.has(a)) allowed.delete(a);
  }

  // Defense-in-depth: a revoked member keeps no grants, even if a stale rule
  // still names their uid/role/team. Deny rules are preserved so an explicit
  // block can never be loosened by this gate.
  if (ctx.isActiveMember === false) {
    allowed.clear();
  }

  return { allowed, denied };
}

export function evaluateAcl(
  acl: AccessControl | undefined,
  ctx: SubjectContext
): AclDecision | null {
  if (!acl) return null;

  const inherit = acl.inherit !== false;
  const visibility: NodeVisibility = acl.visibility ?? "normal";

  const { allowed, denied } = evaluateRules(acl.rules ?? [], ctx);

  const can = (action: PermissionAction) => {
    if (allowed.has("admin") && !denied.has("admin")) return true;
    if (denied.has(action)) return false;
    return allowed.has(action);
  };

  const isDiscoverable = () => {
    if (visibility === "hidden" || visibility === "private") return can("discover");

    return (
      can("discover") ||
      can("read") ||
      can("download") ||
      can("upload") ||
      can("createFolder") ||
      can("editMetadata") ||
      can("write") ||
      can("managePermissions") ||
      can("admin")
    );
  };

  return {
    visibility,
    inherit,
    allowed,
    denied,
    can,
    isDiscoverable,
  };
}

export function evaluateAclChain(
  chain: Array<AccessControl | undefined>,
  ctx: SubjectContext
): AclDecision | null {
  if (!chain.some(Boolean)) return null;

  let mergedRules: AccessRule[] = [];
  let visibility: NodeVisibility = "normal";
  let inherit = true;

  for (const acl of chain) {
    if (!acl) continue;

    const nodeInherit = acl.inherit !== false;

    if (!inherit || !nodeInherit) {
      mergedRules = [];
      visibility = "normal";
    }

    mergedRules = mergedRules.concat(acl.rules ?? []);

    const nodeVisibility = acl.visibility;
    if (nodeVisibility === "hidden" || nodeVisibility === "private") visibility = nodeVisibility;
    if (nodeVisibility === "normal") visibility = "normal";

    inherit = nodeInherit;
  }

  const evaluated = evaluateAcl(
    {
      inherit,
      visibility,
      rules: mergedRules,
    },
    ctx
  );

  return evaluated;
}

export function canBlindDrill(
  decision: AclDecision | null,
  required: PermissionAction[] = ["discover", "read"]
): boolean {
  if (!decision) return false;
  if (decision.visibility !== "hidden" && decision.visibility !== "private") return false;
  return required.every((a) => decision.can(a));
}

function emptyActionMap<T>(): Record<PermissionAction, T[]> {
  return {
    discover: [],
    read: [],
    download: [],
    upload: [],
    createFolder: [],
    editMetadata: [],
    write: [],
    managePermissions: [],
    admin: [],
  };
}

function emptyBucket(): AclIndex["allow"] {
  return {
    roles: emptyActionMap<Role>(),
    users: emptyActionMap<string>(),
    teams: emptyActionMap<string>(),
    orgs: emptyActionMap<string>(),
  };
}

function addToBucket(
  bucket: AclIndex["allow"],
  subject: PermissionSubject,
  action: PermissionAction
) {
  let list: string[] | Role[];

  if (subject.type === "role") list = bucket.roles[action];
  else if (subject.type === "user") list = bucket.users[action];
  else if (subject.type === "team") list = bucket.teams ? bucket.teams[action] : [];
  else if (subject.type === "org") list = bucket.orgs ? bucket.orgs[action] : [];
  else list = [];

  if (!list.includes(subject.id as never)) list.push(subject.id as never);
}

export function buildAclIndexFromRules(rules: AccessRule[] | undefined): AclIndex | null {
  const list = Array.isArray(rules) ? rules : [];
  if (list.length === 0) return null;

  const allow = emptyBucket();
  const deny = emptyBucket();

  for (const rule of list) {
    const actions = rule.actions ?? [];
    for (const action of actions) {
      if (rule.effect === "deny") addToBucket(deny, rule.subject, action);
      else addToBucket(allow, rule.subject, action);
    }
  }

  return { allow, deny };
}

export function buildAclIndex(acl?: AccessControl): AclIndex | null {
  if (!acl || !Array.isArray(acl.rules) || acl.rules.length === 0) return null;
  return buildAclIndexFromRules(acl.rules);
}

export function buildAclIndexFromChain(chain: Array<AccessControl | undefined>): AclIndex | null {
  if (!chain.some(Boolean)) return null;

  let mergedRules: AccessRule[] = [];
  let inherit = true;

  for (const acl of chain) {
    if (!acl) continue;

    const nodeInherit = acl.inherit !== false;

    if (!inherit || !nodeInherit) {
      mergedRules = [];
    }

    mergedRules = mergedRules.concat(acl.rules ?? []);
    inherit = nodeInherit;
  }

  return buildAclIndexFromRules(mergedRules);
}
