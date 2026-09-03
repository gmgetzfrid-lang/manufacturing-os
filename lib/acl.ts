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
  /** Headline role (legacy callers). */
  role?: Role;
  /** CHAIN-1: the FULL held collection. A role subject — allow OR deny —
   *  matches if ANY held role equals it. Without this, a deny naming
   *  `Auditor` stopped matching the moment the auditor was also given
   *  `Requester` (the headline moved), so adding a role REMOVED a
   *  restriction. Callers that pass only `role` keep prior behavior. */
  roles?: Role[];
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
    case "role": {
      if (ctx.role && ctx.role === (id as Role)) return true;
      return Array.isArray(ctx.roles) && ctx.roles.includes(id as Role);
    }
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
    // OWN-8 / DEC-8: an explicit deny of THIS action wins over an admin
    // allow — the SQL evaluators (user_can_publish_on_library,
    // can_manage_node) apply the same order.
    if (denied.has(action)) return false;
    if (allowed.has("admin") && !denied.has("admin")) return true;
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
      can("publish") ||
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
    publish: [],
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

/** Build the flat allow/deny index from a rule list.
 *
 *  When `nowMs` is supplied, rules whose `expiresAt` has passed are dropped —
 *  so an expired grant does not bake into the index and keep authorizing
 *  forever (OWN-7). When it is OMITTED, no expiry filter runs and the output
 *  is byte-identical to before this parameter existed, so every existing call
 *  site is unchanged. The expiry-aware form is used by the nightly rebuild
 *  (DEC-10). Note the index still carries no expiry field, so the raw
 *  evaluator remains the source of truth for expiry between rebuilds — this
 *  narrows the stale-grant window, it does not remove it. */
export function buildAclIndexFromRules(rules: AccessRule[] | undefined, nowMs?: number): AclIndex | null {
  const list0 = Array.isArray(rules) ? rules : [];
  const list = nowMs == null ? list0 : list0.filter((r) => isRuleActive(r, nowMs));
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

export function buildAclIndex(acl?: AccessControl, nowMs?: number): AclIndex | null {
  if (!acl || !Array.isArray(acl.rules) || acl.rules.length === 0) return null;
  return buildAclIndexFromRules(acl.rules, nowMs);
}

/** The library wizard's complete rule vocabulary: every save re-derives
 *  allow-rules over these actions for role subjects (view/write/admin role
 *  lists) and, when view access is "Everyone", one org-subject allow of
 *  discover/read/download. The wizard OWNS that slice — its output on each
 *  save is the full, current statement of it. */
const WIZARD_ACTIONS = new Set<string>([
  "discover", "read", "download",
  "upload", "createFolder", "editMetadata", "write",
  "admin", "managePermissions",
]);

/** True for a rule the wizard re-emits (and therefore owns): an ALLOW for a
 *  role or org subject whose actions all fall inside the wizard vocabulary.
 *  Denies of any subject, user/team rules, and allows carrying actions the
 *  wizard cannot express (e.g. publish) are drawer-owned and must survive. */
function isWizardOwnedRule(r: AccessRule | null | undefined): boolean {
  if (!r || r.effect !== "allow") return false;
  const t = r.subject?.type;
  if (t !== "role" && t !== "org") return false;
  const actions = Array.isArray(r.actions) ? r.actions : [];
  return actions.length > 0 && actions.every((a) => WIZARD_ACTIONS.has(a as string));
}

/** Merge a wizard-rebuilt library ACL with the drawer-added grants the wizard
 *  does not manage (DB-5). Rebuilding `acl` from the wizard form alone
 *  silently drops the permission drawer's grants; preserving everything the
 *  wizard didn't just emit re-applies the wizard's own PREVIOUS output, so a
 *  restricting edit (Everyone → role list) would fail open by resurrecting
 *  the old org-wide allow. The split is by ownership: rules the wizard
 *  re-emits (isWizardOwnedRule) are replaced by this save's output; every
 *  other rule — user/team grants, ALL deny rules, and role/org allows with
 *  actions outside the wizard vocabulary (publish grants) — is preserved
 *  verbatim, deduplicated. So a metadata edit never revokes a granular grant,
 *  and a restricting edit actually restricts. */
export function mergeWizardLibraryAcl(
  wizardAcl: AccessControl | null | undefined,
  existingRules: AccessRule[] | null | undefined,
): AccessControl | null {
  const preserved = (existingRules ?? []).filter((r) => r != null && !isWizardOwnedRule(r));
  const combined = [...(wizardAcl?.rules ?? []), ...preserved];
  // Dedupe by value — earlier buggy merges could have accumulated identical
  // copies (the preserved half re-adding a rule the wizard also emitted).
  const seen = new Set<string>();
  const rules = combined.filter((r) => {
    const key = JSON.stringify(sortValueForRule(r));
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (wizardAcl) return { ...wizardAcl, rules };
  if (rules.length) return { inherit: true, visibility: "normal", rules };
  return null;
}

function sortValueForRule(v: unknown): unknown {
  if (Array.isArray(v)) return [...v].map(sortValueForRule).sort();
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return Object.keys(o).sort().reduce<Record<string, unknown>>((acc, k) => { acc[k] = sortValueForRule(o[k]); return acc; }, {});
  }
  return v;
}

export function buildAclIndexFromChain(chain: Array<AccessControl | undefined>, nowMs?: number): AclIndex | null {
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

  return buildAclIndexFromRules(mergedRules, nowMs);
}
