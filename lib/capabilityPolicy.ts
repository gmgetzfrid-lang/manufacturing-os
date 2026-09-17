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
//     audited with before/after — ON THE SERVER (WF-11): the browser posts
//     every policy and grant change to /api/admin/capability-policy, and a
//     database trigger (20261056) holds the same rails against a direct
//     write. The server-side cache is short-lived and invalidated on write
//     (WF-10); a workflow decision admitted by a personal grant names the
//     grant in its audit row (WF-16).
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
import { MANAGEMENT_ROLES } from "@/lib/managementRoles";

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
  | "ticket.engineer_gate_exempt" // DEC-13 stage 3: whose OWN requests need no engineer sign-off
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
  /** DEC-11 / WF-17: the capability is KEPT but no live status consults its
   *  base list — the editor renders the row greyed with `dormantNote` as the
   *  tooltip, never as a live-looking control (a decorative control is the
   *  exact failure the permissions console was built to remove). */
  dormant?: boolean;
  dormantNote?: string;
}

// WF-24 / CHAIN-3: the management tier is defined ONCE (lib/managementRoles.ts).
const MGMT = [...MANAGEMENT_ROLES];

export const CAPABILITY_DEFS: CapabilityDef[] = [
  { id: "ticket.manage", area: "Requests", label: "Management override", critical: true,
    description: "The management tier: co-approve at any review stage, override assigned reviewers, force-close.",
    defaultRoles: MGMT },
  { id: "ticket.initial_review", area: "Requests", label: "Initial review (approve / flag / reject)",
    description: "Act on brand-new requests before assignment.", defaultRoles: [...MGMT, "Engineer"],
    dormant: true,
    dormantNote: "Dormant: every request is born in the assignment queue (DEC-14 retired the NEW / PENDING_ENG_INITIAL stages), so no status consults this list. Kept for a future \"return to unassigned engineer pool\" action (DEC-11)." },
  { id: "ticket.eng_review", area: "Requests", label: "Engineering scope review",
    description: "Complete an engineering review when no specific engineer is assigned (the assigned engineer always can).",
    defaultRoles: ["Engineer"],
    dormant: true,
    dormantNote: "Dormant base list: a review is only ever requested WITH a named engineer (WF-22), who then acts by identity. A request-type override on this row still governs who may be PICKED as the reviewer (DEC-13)." },
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
    defaultRoles: ["Engineer"],
    dormant: true,
    dormantNote: "Dormant base list: final approval is only ever requested WITH a named engineer (WF-22), who then acts by identity. A request-type override on this row still governs who may be PICKED as the reviewer (DEC-13)." },
  { id: "ticket.reopen", area: "Requests", label: "Reopen closed tickets",
    description: "Resurrect a closed ticket (its requester always can).", defaultRoles: MGMT },
  { id: "ticket.force_close", area: "Requests", label: "Force close", critical: true,
    description: "Close a ticket from any state.", defaultRoles: MGMT },
  { id: "ticket.reassign_engineer", area: "Requests", label: "Reassign engineer reviewer", critical: true,
    description: "Swap the assigned engineer at final approval.", defaultRoles: ["Admin"] },
  { id: "ticket.engineer_gate_exempt", area: "Requests", label: "Approve own request without an engineer",
    description: "Requesters holding one of these roles approve their own draft to IFC directly; everyone else's approval routes through a picked engineer (DEC-13 stage 3). Judged against BOTH the role stamped at filing AND the requester's current roles — an engineer is required if either says so (DEC-16).",
    defaultRoles: [...MGMT, "Engineer", "DocCtrl"] },
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
//
// WF-10: two TTLs and a version stamp. The BROWSER keeps a policy for a
// minute — it only draws buttons from it; authority is decided on the
// server. A SERVER caller (one that passes its own client) keeps an entry for
// SERVER_CACHE_TTL_MS, and the policy route drops its own instance's entry on
// every write. The bound that holds everywhere is the TTL, not the drop: on
// Vercel each App Router route is its own serverless function, so the instance serving
// /api/tickets/workflow-action never shares this Map with the one that served
// the write. The residual window is exactly this:
// any instance holds a stale entry for at most SERVER_CACHE_TTL_MS after a write
// (a cold instance reads fresh), and a write that bypasses the route (SQL
// editor, a controller's direct PATCH — audited by the 20261056 trigger) is
// seen within the same bound. Each entry carries the row's
// `updated_at` as its VERSION so an authority decision can name the policy
// version it was made under (the workflow route's audit row does).

const BROWSER_CACHE_TTL_MS = 60_000;
/** How long a server process may act on a policy it has already read. */
export const SERVER_CACHE_TTL_MS = 5_000;
interface PolicyCacheEntry { at: number; policy: CapabilityPolicy; version: string | null }
const cache = new Map<string, PolicyCacheEntry>();
export function __resetCapabilityPolicyCache(): void { cache.clear(); }
/** Drop one org's entry from THIS instance's cache — the policy route calls
 *  this after every write; other instances age theirs out (SERVER_CACHE_TTL_MS). */
export function invalidateCapabilityPolicy(orgId: string): void { cache.delete(orgId); }

/** Parse a stored `org_configurations.data` blob into a policy. Two stored
 *  shapes: canonical {caps, grants}, and the legacy flat {capId: roles[]}
 *  from before per-person grants existed. Unknown capability ids and grants
 *  without a person are dropped before evaluation. */
export function parseStoredCapabilityPolicy(stored: unknown): CapabilityPolicy {
  const raw = (stored && typeof stored === "object" ? stored : {}) as Record<string, unknown>;
  const rawCaps = (raw.caps as Record<string, unknown> | undefined) ?? raw;
  const caps: CapabilityPolicy["caps"] = {};
  for (const def of CAPABILITY_DEFS) {
    const entry = normalizeCapabilityEntry(rawCaps[def.id]);
    if (entry !== undefined) caps[def.id] = entry;
  }
  const validIds = new Set(CAPABILITY_DEFS.map((d) => d.id as string));
  const grants = (Array.isArray(raw.grants) ? (raw.grants as UserGrant[]) : [])
    .filter((g) => g && typeof g.uid === "string" && validIds.has(g.cap as string));
  return { caps, grants };
}

export interface LoadedCapabilityPolicy { policy: CapabilityPolicy; version: string | null }

/** `client` lets server routes pass their own (service-role) client — the
 *  shared browser client has no session in a route handler. Returns the
 *  policy with the version stamp it was read at (null = nothing stored, or
 *  the read failed and the shipped defaults apply for this call only). */
export async function loadCapabilityPolicyEntry(
  orgId: string,
  client?: Pick<typeof supabase, "from">,
): Promise<LoadedCapabilityPolicy> {
  const ttl = client ? SERVER_CACHE_TTL_MS : BROWSER_CACHE_TTL_MS;
  const hit = cache.get(orgId);
  if (hit && Date.now() - hit.at < ttl) return { policy: hit.policy, version: hit.version };
  // WF-10 done-when 3: on the server the shared browser singleton has no
  // session, so a call that forgot its client reads NOTHING under RLS. That
  // is an empty policy for this call — never a cached one that would disable
  // every stored narrowing and grant org-wide for the TTL.
  const sessionless = !client && typeof window === "undefined";
  try {
    const { data, error } = await (client ?? supabase)
      .from("org_configurations")
      .select("data, updated_at")
      .eq("org_id", orgId)
      .eq("key", "capability_policy")
      .maybeSingle();
    // A read ERROR is not "no policy stored": returning defaults is correct
    // for one call, but caching them for the TTL would let an org's stored
    // narrowing vanish for a minute after any transient failure (WF-1
    // done-when 2). Fail closed to defaults WITHOUT caching.
    if (error) return { policy: {}, version: null };
    // The column is `data` — reading `value` (which does not exist) errored on
    // every call, so the catch below returned {} and the entire capability
    // layer was inert (DB-1). Both this read and the SQL org_capability_allows
    // must use `data`, or the two layers disagree about which column is real.
    const policy = parseStoredCapabilityPolicy(data?.data);
    const version = typeof data?.updated_at === "string" ? data.updated_at : null;
    if (!sessionless) cache.set(orgId, { at: Date.now(), policy, version });
    return { policy, version };
  } catch {
    return { policy: {}, version: null }; // defaults apply
  }
}

export async function loadCapabilityPolicy(
  orgId: string,
  client?: Pick<typeof supabase, "from">,
): Promise<CapabilityPolicy> {
  return (await loadCapabilityPolicyEntry(orgId, client)).policy;
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

// WF-11: every write goes through POST /api/admin/capability-policy. The
// server authenticates the caller, checks active membership and the
// controller tier by the role COLLECTION, re-runs validateCapabilityPolicy
// with the service-role client, requires Admin for a change to a critical
// capability and for ANY grant change, refuses a self-grant, prunes expired
// grants (WF-16), writes the before/after audit row and invalidates its own
// cache (WF-10). The 20261056 trigger holds the same rails against a direct
// write that skips the route. These helpers are the browser's only way in;
// the rail below runs first only so the editor can say why before a
// round-trip.

export const CAPABILITY_POLICY_ROUTE = "/api/admin/capability-policy";

/** The three writes the policy route accepts. `save` carries the role grid
 *  only — grants are owned by the server and preserved across a save. */
export type CapabilityPolicyChange =
  | { op: "save"; orgId: string; caps: NonNullable<CapabilityPolicy["caps"]> }
  | { op: "grant"; orgId: string; uid: string; cap: CapabilityId; expiresAt?: string | null; note?: string | null }
  | { op: "revoke"; orgId: string; uid: string; cap: CapabilityId };

async function postPolicyChange(change: CapabilityPolicyChange): Promise<CapabilityPolicy> {
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;
  if (!token) throw new Error("Not signed in");
  const res = await fetch(CAPABILITY_POLICY_ROUTE, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(change),
  });
  const json = (await res.json().catch(() => ({}))) as { error?: string; policy?: CapabilityPolicy };
  if (!res.ok) throw new Error(json.error || `Policy change failed (${res.status})`);
  cache.delete(change.orgId);
  return json.policy ?? {};
}

/** Save the role grid. `policy.grants` is ignored: grants are changed only
 *  through addUserGrant / revokeUserGrant and preserved by the server. The
 *  actor is derived from the session on the server; the actor fields are
 *  kept for call-site compatibility. */
export async function saveCapabilityPolicy(input: {
  orgId: string;
  policy: CapabilityPolicy;
  actorUserId: string;
  actorEmail?: string | null;
}): Promise<void> {
  const err = validateCapabilityPolicy({ caps: input.policy.caps });
  if (err) throw new Error(err);
  await postPolicyChange({ op: "save", orgId: input.orgId, caps: input.policy.caps ?? {} });
}

// ── Per-person delegation (server-side read-modify-write on grants only) ───

/** Delegate one capability to one person — temporary (expiresAt) or until
 *  revoked. Replaces any existing grant for the same (person, capability),
 *  so re-granting just updates the expiry. Roles/caps are untouched. Admin
 *  only; a self-grant is refused; the grant is stamped by the server. */
export async function addUserGrant(input: {
  orgId: string;
  uid: string;
  cap: CapabilityId;
  expiresAt?: string | null;
  note?: string | null;
  actorUserId: string;
  actorEmail?: string | null;
}): Promise<void> {
  await postPolicyChange({
    op: "grant", orgId: input.orgId, uid: input.uid, cap: input.cap,
    expiresAt: input.expiresAt ?? null, note: input.note ?? null,
  });
}

/** Revoke one person's grant of one capability (Admin only). */
export async function revokeUserGrant(input: {
  orgId: string;
  uid: string;
  cap: CapabilityId;
  actorUserId: string;
  actorEmail?: string | null;
}): Promise<void> {
  await postPolicyChange({ op: "revoke", orgId: input.orgId, uid: input.uid, cap: input.cap });
}

/** All of one person's grants (live and expired — the UI labels expiry). */
export function grantsForUser(policy: CapabilityPolicy | null | undefined, uid: string): UserGrant[] {
  return (policy?.grants ?? []).filter((g) => g.uid === uid);
}
