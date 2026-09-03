// lib/capabilityPolicy.ts
//
// THE CAPABILITY POLICY LAYER — org-configurable "who may perform which
// action" for the parts of the app that aren't content (content permissions
// live on each node's ACL). Covers every drafting-request workflow
// transition plus holds, force-release, and admin surfaces.
//
// Design contract:
//   * DEFAULTS exactly reproduce the historical hardcoded behavior — an org
//     that never edits the policy sees zero change.
//   * The policy maps capability id -> allowed role tokens. Tokens are role
//     names, plus "Engineer" (matches every Engineer-N tier — the tiers were
//     never enforced anywhere and remain a labeling convention) and "*"
//     (every active member).
//   * IDENTITY-based rights are NOT configurable by design: a ticket's
//     requester, assigned drafter, and assigned engineer always keep their
//     own-ticket actions. Policy governs ROLE-based authority only.
//   * Enforced where it matters: the workflow-action API route re-derives
//     actions server-side with the org's policy, so a tampered client
//     changes nothing.
//   * Saves are guardrailed (critical capabilities must keep Admin) and
//     audited with before/after.
//   * DEC-13 stage 2 (DRAFT-1 / WF-13 / GAP-1): a capability entry may be a
//     list of RULES, each `{ tokens, when? }`. A rule with a `when` clause
//     applies only to a matching RESOURCE (request type, unit, library,
//     discipline) and, when it matches, its tokens REPLACE the base list —
//     that is how "ASBUILT may only be approved by DocCtrl" is said. An entry
//     with no `when` (or the legacy bare `string[]`) behaves exactly as
//     before, and a caller that passes no resource sees only the base list,
//     so every unconfigured org is byte-identical to today. The four
//     evaluators — getActions, holds, the simulator and the SQL
//     org_capability_allows_for — read the SAME shape with the SAME rule.

import { supabase } from "@/lib/supabase";

export type CapabilityId =
  | "ticket.manage"            // management override tier (approve anywhere, force close)
  | "ticket.initial_review"
  | "ticket.eng_review"
  | "ticket.assign"
  | "ticket.self_assign"
  | "ticket.draft_work"
  | "ticket.requester_review"
  | "ticket.direct_approve"
  | "ticket.final_approve"
  | "ticket.reopen"
  | "ticket.force_close"
  | "ticket.reassign_engineer"
  | "holds.open"
  | "holds.release"
  | "checkout.force_release"
  | "admin.analytics_view"
  | "admin.archive_view";

export interface CapabilityDef {
  id: CapabilityId;
  area: string;
  label: string;
  description: string;
  defaultRoles: string[];
  /** Admin can never be removed from a critical capability. */
  critical?: boolean;
}

const MGMT = ["Admin", "Manager", "Supervisor"];

export const CAPABILITY_DEFS: CapabilityDef[] = [
  { id: "ticket.manage", area: "Requests", label: "Management override", critical: true,
    description: "The management tier: co-approve at any review stage, override assigned reviewers, force-close.",
    defaultRoles: MGMT },
  { id: "ticket.initial_review", area: "Requests", label: "Initial review (approve / flag / reject)",
    description: "Act on brand-new requests before assignment.", defaultRoles: [...MGMT, "Engineer"] },
  { id: "ticket.eng_review", area: "Requests", label: "Engineering scope review",
    description: "Complete an engineering review when no specific engineer is assigned (the assigned engineer always can).",
    defaultRoles: ["Engineer"] },
  { id: "ticket.assign", area: "Requests", label: "Assign drafters",
    description: "Run the assignment queue.", defaultRoles: [...MGMT, "DraftingSupervisor"] },
  { id: "ticket.self_assign", area: "Requests", label: "Self-assign drafting work",
    description: "Pick up unassigned tickets from the queue — the pull model, on by default (DRAFT-5). Clear this list to make assignment supervisor-only; an 'engineering first' request type is never picked up before its review.",
    defaultRoles: ["Drafter"] },
  { id: "ticket.draft_work", area: "Requests", label: "Do drafting work",
    description: "Save progress, submit drafts, issue IFC (the assigned drafter always can).", defaultRoles: ["Drafter"] },
  { id: "ticket.requester_review", area: "Requests", label: "Requester review",
    description: "Review returned drafts as a requester (the ticket's own requester always can).", defaultRoles: ["Requester"] },
  { id: "ticket.direct_approve", area: "Requests", label: "Direct engineering approval",
    description: "Approve a draft to IFC without being the requester.", defaultRoles: ["Engineer"] },
  { id: "ticket.final_approve", area: "Requests", label: "Final engineering approval",
    description: "Sign off at the final-approval stage when unassigned (the assigned engineer always can).",
    defaultRoles: ["Engineer"] },
  { id: "ticket.reopen", area: "Requests", label: "Reopen closed tickets",
    description: "Resurrect a closed ticket (its requester always can).", defaultRoles: MGMT },
  { id: "ticket.force_close", area: "Requests", label: "Force close", critical: true,
    description: "Close a ticket from any state.", defaultRoles: MGMT },
  { id: "ticket.reassign_engineer", area: "Requests", label: "Reassign engineer reviewer", critical: true,
    description: "Swap the assigned engineer at final approval.", defaultRoles: ["Admin"] },
  { id: "holds.open", area: "Holds", label: "Place a hold",
    description: "Open a do-not-advance hold on a document.", defaultRoles: ["*"] },
  { id: "holds.release", area: "Holds", label: "Release a hold",
    description: "Release an open hold.", defaultRoles: ["*"] },
  { id: "checkout.force_release", area: "Checkouts", label: "Force-release a checkout", critical: true,
    description: "Release another user's active checkout. Enforced at the database, which reads this policy — widen or narrow freely.",
    defaultRoles: ["Admin", "DocCtrl"] },
  { id: "admin.analytics_view", area: "Metrics", label: "Analytics dashboards",
    description: "Open /admin/analytics.", defaultRoles: [...MGMT, "DocCtrl"] },
  { id: "admin.archive_view", area: "Metrics", label: "Archive browser",
    description: "Open /admin/archive-view.", defaultRoles: ["Admin", "DocCtrl"] },
];

/** A per-PERSON delegation of one capability — temporary (expiresAt) or
 *  standing (null). Grants are ADDITIVE ONLY: they can extend a person's
 *  authority beyond their role, never reduce anyone else's, and they ride
 *  the same evaluator as roles — no parallel system to collide with. */
export interface UserGrant {
  cap: CapabilityId;
  uid: string;
  /** ISO datetime after which the grant is dead; null = until revoked. */
  expiresAt?: string | null;
  note?: string | null;
  grantedBy?: string | null;
  grantedAt?: string | null;
}

/** The RESOURCE a capability is evaluated against (DEC-13 stage 2). Every
 *  field is optional; a caller with nothing to say passes nothing and gets
 *  the base list. Keys are matched by name on both sides (TS and SQL), so a
 *  `when` clause naming any other key is ignored by both evaluators (and
 *  refused at save by validateCapabilityPolicy). */
export interface CapabilityResource {
  requestType?: string | null;
  unit?: string | null;
  libraryId?: string | null;
  discipline?: string | null;
}

/** The resource keys a `when` clause may condition on — the ONLY keys either
 *  evaluator reads. Extend here and in org_capability_allows_for together. */
export const RESOURCE_KEYS = ["requestType", "unit", "libraryId", "discipline"] as const;
export type ResourceKey = (typeof RESOURCE_KEYS)[number];

/** `when`: every listed key must match (AND across keys, OR within a list).
 *  A clause with no non-empty list is unconditional. */
export type CapabilityRuleWhen = Partial<Record<ResourceKey, string[]>>;

export interface CapabilityRule {
  tokens: string[];
  when?: CapabilityRuleWhen;
}

/** A stored capability entry: the legacy bare token list, or a rule list. */
export type CapabilityEntry = string[] | CapabilityRule[];

export interface CapabilityPolicy {
  /** capability -> allowed role tokens or rules (absent key = shipped default). */
  caps?: Partial<Record<CapabilityId, CapabilityEntry>>;
  /** per-person delegations, additive on top of role authority. A grant has
   *  no resource scope: it confers the capability everywhere (WF-13 row 6). */
  grants?: UserGrant[];
}

const DEFAULTS: Record<CapabilityId, string[]> = Object.fromEntries(
  CAPABILITY_DEFS.map((d) => [d.id, d.defaultRoles]),
) as Record<CapabilityId, string[]>;

export function defaultCapabilityPolicy(): Record<CapabilityId, string[]> {
  return { ...DEFAULTS };
}

/** "Engineer" matches every Engineer-N tier; "*" matches any role. */
export function roleTokenMatches(token: string, role: string): boolean {
  if (token === "*") return true;
  if (token === "Engineer") return role.includes("Engineer");
  return token === role;
}

/** Is a user grant currently live? */
export function grantActive(g: UserGrant, now: Date = new Date()): boolean {
  return !g.expiresAt || Date.parse(g.expiresAt) > now.getTime();
}

// ── Rules and resources (DEC-13 stage 2) ───────────────────────────────────

export function isRuleArray(entry: CapabilityEntry | undefined): entry is CapabilityRule[] {
  return Array.isArray(entry) && entry.length > 0 && typeof entry[0] === "object" && entry[0] !== null;
}

/** Does this rule condition on anything? Empty / absent lists don't count. */
export function ruleIsConditional(rule: CapabilityRule): boolean {
  return RESOURCE_KEYS.some((k) => (rule.when?.[k]?.length ?? 0) > 0);
}

/** A conditional rule matches when EVERY key it lists finds the resource's
 *  value in its list. A missing resource value never matches — so a caller
 *  that passes nothing can only ever see the base list. */
export function ruleMatches(rule: CapabilityRule, resource: CapabilityResource | null | undefined): boolean {
  if (!ruleIsConditional(rule)) return false;
  for (const k of RESOURCE_KEYS) {
    const list = rule.when?.[k];
    if (!list || list.length === 0) continue;
    const v = resource?.[k];
    if (!v || !list.includes(v)) return false;
  }
  return true;
}

/** The tokens of the first conditional rule matching `resource`, or null when
 *  no rule is scoped to it — callers use null to mean "nothing type-specific
 *  is configured here" (the requester-identity path and pick validation). */
export function scopedTokensFor(
  policy: CapabilityPolicy | null | undefined,
  cap: CapabilityId,
  resource: CapabilityResource | null | undefined,
): string[] | null {
  const entry = policy?.caps?.[cap];
  if (!isRuleArray(entry) || !resource) return null;
  const hit = entry.find((r) => ruleMatches(r, resource));
  return hit ? hit.tokens : null;
}

/** The unconditional tokens: the bare list, the first rule with no `when`,
 *  or the shipped default. */
export function baseTokensFor(policy: CapabilityPolicy | null | undefined, cap: CapabilityId): string[] {
  const entry = policy?.caps?.[cap];
  if (entry === undefined) return DEFAULTS[cap] ?? [];
  if (isRuleArray(entry)) {
    const base = entry.find((r) => !ruleIsConditional(r));
    return base ? base.tokens : DEFAULTS[cap] ?? [];
  }
  return entry as string[];
}

/** The effective token list for one evaluation: a matching scoped rule
 *  REPLACES the base list; otherwise the base list. */
export function tokensFor(
  policy: CapabilityPolicy | null | undefined,
  cap: CapabilityId,
  resource?: CapabilityResource | null,
): string[] {
  return scopedTokensFor(policy, cap, resource) ?? baseTokensFor(policy, cap);
}

/** Do any of the held roles satisfy this token list? */
export function heldMatchesTokens(tokens: readonly string[], held: readonly string[]): boolean {
  return held.some((r) => tokens.some((t) => roleTokenMatches(t, r)));
}

/** Human-readable `when` (for validation messages and the impact preview). */
export function describeWhen(when: CapabilityRuleWhen | undefined): string {
  const parts = RESOURCE_KEYS
    .filter((k) => (when?.[k]?.length ?? 0) > 0)
    .map((k) => `${k} ∈ {${(when?.[k] ?? []).join(", ")}}`);
  return parts.length > 0 ? parts.join(" and ") : "always";
}

/** The single authority check: role tokens first, then any live per-person
 *  grant for `uid`. Identity-based rights are handled by callers. `resource`
 *  (DEC-13) selects a type/unit/library-scoped rule when the org configured
 *  one; absent, only the base list is consulted. */
export function policyAllows(
  policy: CapabilityPolicy | null | undefined,
  cap: CapabilityId,
  role?: string | null,
  extraRoles?: string[] | null,
  uid?: string | null,
  resource?: CapabilityResource | null,
): boolean {
  const list = tokensFor(policy, cap, resource);
  const held = [role, ...(extraRoles ?? [])].filter((r): r is string => !!r);
  if (heldMatchesTokens(list, held)) return true;
  if (uid && policy?.grants) {
    return policy.grants.some((g) => g.cap === cap && g.uid === uid && grantActive(g));
  }
  return false;
}

/** Parse one stored entry: a bare string list, or a list of `{tokens, when?}`
 *  rules. Unknown `when` keys are dropped (the SQL evaluator ignores them
 *  too); a rule without a usable `tokens` list is dropped; a rule list with
 *  nothing usable left yields undefined (= shipped default). */
export function normalizeCapabilityEntry(v: unknown): CapabilityEntry | undefined {
  if (!Array.isArray(v)) return undefined;
  if (v.every((x) => typeof x === "string")) return v as string[];
  const rules: CapabilityRule[] = [];
  for (const x of v) {
    if (!x || typeof x !== "object") continue;
    const tokens = (x as { tokens?: unknown }).tokens;
    if (!Array.isArray(tokens) || !tokens.every((t) => typeof t === "string")) continue;
    const rawWhen = (x as { when?: unknown }).when;
    const when: CapabilityRuleWhen = {};
    if (rawWhen && typeof rawWhen === "object") {
      for (const k of RESOURCE_KEYS) {
        const list = (rawWhen as Record<string, unknown>)[k];
        if (Array.isArray(list) && list.every((t) => typeof t === "string") && list.length > 0) when[k] = list as string[];
      }
    }
    rules.push(Object.keys(when).length > 0 ? { tokens: tokens as string[], when } : { tokens: tokens as string[] });
  }
  return rules.length > 0 ? rules : undefined;
}

// ── Load (cached) ──────────────────────────────────────────────────────────

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { at: number; policy: CapabilityPolicy }>();
export function __resetCapabilityPolicyCache(): void { cache.clear(); }

/** `client` lets server routes pass their own (service-role) client — the
 *  shared browser client has no session in a route handler. */
export async function loadCapabilityPolicy(
  orgId: string,
  client?: Pick<typeof supabase, "from">,
): Promise<CapabilityPolicy> {
  const hit = cache.get(orgId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.policy;
  try {
    const { data, error } = await (client ?? supabase)
      .from("org_configurations")
      .select("data")
      .eq("org_id", orgId)
      .eq("key", "capability_policy")
      .maybeSingle();
    // A read ERROR is not "no policy stored": returning defaults is correct
    // for one call, but caching them for the TTL would let an org's stored
    // narrowing vanish for a minute after any transient failure (WF-1
    // done-when 2). Fail closed to defaults WITHOUT caching.
    if (error) return {};
    // The column is `data` — reading `value` (which does not exist) errored on
    // every call, so the catch below returned {} and the entire capability
    // layer was inert (DB-1). Both this read and the SQL org_capability_allows
    // must use `data`, or the two layers disagree about which column is real.
    const raw = (data?.data as Record<string, unknown> | null) ?? {};
    // Two stored shapes: canonical {caps, grants}, and the legacy flat
    // {capId: roles[]} from before per-person grants existed.
    const rawCaps = (raw.caps as Record<string, unknown> | undefined) ?? raw;
    const caps: CapabilityPolicy["caps"] = {};
    for (const def of CAPABILITY_DEFS) {
      const entry = normalizeCapabilityEntry(rawCaps[def.id]);
      if (entry !== undefined) caps[def.id] = entry;
    }
    const validIds = new Set(CAPABILITY_DEFS.map((d) => d.id as string));
    const grants = (Array.isArray(raw.grants) ? (raw.grants as UserGrant[]) : [])
      .filter((g) => g && typeof g.uid === "string" && validIds.has(g.cap as string));
    const policy: CapabilityPolicy = { caps, grants };
    cache.set(orgId, { at: Date.now(), policy });
    return policy;
  } catch {
    return {}; // defaults apply
  }
}

// ── Save (guardrailed + audited) ───────────────────────────────────────────

/** Returns a human-readable error, or null when the policy is safe. */
export function validateCapabilityPolicy(policy: CapabilityPolicy): string | null {
  for (const def of CAPABILITY_DEFS) {
    const v = policy.caps?.[def.id];
    if (v === undefined) continue;
    if (!Array.isArray(v)) return `${def.label}: invalid value`;
    // Every list that can become THE list — the base and each scoped rule —
    // must keep Admin on a critical capability: a scoped rule replaces the
    // base wholesale, so it is a second door the rail has to cover.
    const lists: Array<{ tokens: unknown; where: string }> = isRuleArray(v)
      ? v.map((r, i) => ({ tokens: r?.tokens, where: ruleIsConditional(r) ? ` (rule ${i + 1}: ${describeWhen(r.when)})` : "" }))
      : [{ tokens: v, where: "" }];
    for (const { tokens, where } of lists) {
      if (!Array.isArray(tokens) || !tokens.every((t) => typeof t === "string")) return `${def.label}: invalid value${where}`;
      if (def.critical && !tokens.includes("Admin") && !tokens.includes("*")) {
        return `${def.label}${where}: Admin cannot be removed from a critical capability — that's the rail that keeps the org recoverable.`;
      }
    }
    if (isRuleArray(v)) {
      for (const r of v) {
        for (const k of Object.keys(r.when ?? {})) {
          if (!(RESOURCE_KEYS as readonly string[]).includes(k)) return `${def.label}: a rule conditions on an unknown resource key "${k}"`;
        }
      }
    }
  }
  const validIds = new Set(CAPABILITY_DEFS.map((d) => d.id as string));
  for (const g of policy.grants ?? []) {
    if (!validIds.has(g.cap as string)) return `Unknown capability in a personal grant: ${String(g.cap)}`;
    if (!g.uid) return "A personal grant is missing its person.";
    if (g.expiresAt && Number.isNaN(Date.parse(g.expiresAt))) return "A personal grant has an invalid expiry date.";
  }
  return null;
}

export async function saveCapabilityPolicy(input: {
  orgId: string;
  policy: CapabilityPolicy;
  actorUserId: string;
  actorEmail?: string | null;
}): Promise<void> {
  const err = validateCapabilityPolicy(input.policy);
  if (err) throw new Error(err);
  const before = await loadCapabilityPolicy(input.orgId);
  const { error } = await supabase
    .from("org_configurations")
    .upsert(
      { org_id: input.orgId, key: "capability_policy", data: input.policy, updated_at: new Date().toISOString() },
      { onConflict: "org_id,key" },
    );
  if (error) throw new Error(error.message);
  cache.delete(input.orgId);
  // Full before/after audit — a permission change is the one edit an IT
  // department must always be able to reconstruct.
  await supabase.from("audit_logs").insert({
    action: "CAPABILITY_POLICY_CHANGED",
    resource_type: "org_configuration",
    resource_id: input.orgId,
    org_id: input.orgId,
    user_id: input.actorUserId,
    user_email: input.actorEmail ?? null,
    details: { before, after: input.policy },
  }).then(() => undefined, () => undefined);
}

// ── Per-person delegation (read-modify-write on grants only) ───────────────

/** Delegate one capability to one person — temporary (expiresAt) or until
 *  revoked. Replaces any existing grant for the same (person, capability),
 *  so re-granting just updates the expiry. Roles/caps are untouched. */
export async function addUserGrant(input: {
  orgId: string;
  uid: string;
  cap: CapabilityId;
  expiresAt?: string | null;
  note?: string | null;
  actorUserId: string;
  actorEmail?: string | null;
}): Promise<void> {
  const current = await loadCapabilityPolicy(input.orgId);
  const grants = (current.grants ?? []).filter((g) => !(g.uid === input.uid && g.cap === input.cap));
  grants.push({
    cap: input.cap, uid: input.uid,
    expiresAt: input.expiresAt ?? null, note: input.note ?? null,
    grantedBy: input.actorUserId, grantedAt: new Date().toISOString(),
  });
  await saveCapabilityPolicy({
    orgId: input.orgId,
    policy: { caps: current.caps ?? {}, grants },
    actorUserId: input.actorUserId,
    actorEmail: input.actorEmail,
  });
}

/** Revoke one person's grant of one capability. */
export async function revokeUserGrant(input: {
  orgId: string;
  uid: string;
  cap: CapabilityId;
  actorUserId: string;
  actorEmail?: string | null;
}): Promise<void> {
  const current = await loadCapabilityPolicy(input.orgId);
  const grants = (current.grants ?? []).filter((g) => !(g.uid === input.uid && g.cap === input.cap));
  await saveCapabilityPolicy({
    orgId: input.orgId,
    policy: { caps: current.caps ?? {}, grants },
    actorUserId: input.actorUserId,
    actorEmail: input.actorEmail,
  });
}

/** All of one person's grants (live and expired — the UI labels expiry). */
export function grantsForUser(policy: CapabilityPolicy | null | undefined, uid: string): UserGrant[] {
  return (policy?.grants ?? []).filter((g) => g.uid === uid);
}
