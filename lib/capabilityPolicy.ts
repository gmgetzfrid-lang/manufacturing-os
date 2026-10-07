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
//     projects Round G (QUAL-4, 20261136) adds ONE resource key, projectId,
//     so a rule can name a single project: that is how "this project's
//     Safety lead signs its quality records" is said (quality.sign_off —
//     the one capability a rule may scope to a project, PROJECT_SCOPED_CAPS).

import { supabase } from "@/lib/supabase";
import { MANAGEMENT_ROLES } from "@/lib/managementRoles";
import { isControllerRole } from "@/lib/permissions";
import type { Role } from "@/types/schema";

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
  | "admin.archive_view"
  | "admin.audit_view"
  | "transmittal.issue"         // TRX-1: issue / void / revoke / record receipt (drafting stays open)
  | "quality.sign_off"          // QUAL-4: write + sign off a project's checklists / turnover / punch, per project
  | "ai.manage_caps";           // GOV-10: set the org-default and per-person monthly AI caps

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
  // ROLE-5: Auditor's admission to the audit log used to be a hardcoded set on
  // the page; it is now this capability, read by the admin gate AND by the
  // audit_logs SELECT overlay at the database (20261063) — widen or narrow
  // freely, delegate it to a person with a grant.
  { id: "admin.audit_view", area: "Admin", label: "Audit log",
    description: "Open /admin/audit — the org-level authority trail. Enforced at the database, which reads this policy.",
    defaultRoles: [...MGMT, "DocCtrl", "Auditor"] },
  // TRX-1 (document-control Round F wave 2): transmit authority. Every member
  // may DRAFT a transmittal; issuing one is the org formally sending documents
  // to an outside party, so the issue transition, voiding, revoking the portal
  // link and recording a receipt on the recipient's behalf read this
  // capability. The default is the list the database and the email route
  // named until now (is_org_controller: Admin / DocCtrl). Enforced at the
  // database (trg_transmittals_guard, 20261133), which evaluates it once per
  // item's LIBRARY (DEC-13) — a library-scoped rule decides who may transmit
  // from that library.
  { id: "transmittal.issue", area: "Transmittals", label: "Issue transmittals",
    description: "Issue a drafted transmittal to its recipient, void it, revoke its portal link and record a receipt on the recipient's behalf. Every member may draft. Enforced at the database, which reads this policy per item library.",
    defaultRoles: ["Admin", "DocCtrl"] },
  // QUAL-4 (projects Round G, J2b): who ELSE may record and sign off a
  // project's quality decisions — checklists, turnover, punch. Its standing
  // holders are not tokens: the controllers (Admin / DocCtrl — the four
  // quality write policies' is_org_controller clause) and the project OWNER
  // (the owner disjunct, identity) always can, whatever this row says, so
  // the default grants nobody beyond them and the permissions grid never
  // shows a controller cell that unticks nothing. A discipline reviewer is
  // GRANTED it — org-wide, or for one project by a rule scoped on projectId
  // (DEC-13) — never named in code (DEC-35), and never by widening
  // project_members.role. Enforced at the database (20261136: the write
  // policies, the separation-of-duties rail and the signed sign-off), which
  // evaluates it per project.
  { id: "quality.sign_off", area: "Quality", label: "Sign off quality records",
    description: "Grants more people what Admin, Document Control and the project owner can always do, whatever this row says: record decisions on a project's checklists, turnover package and punch list, complete a checklist and accept or waive turnover with an e-signature. Tick a role to grant it on every project it can see; a rule scoped to a project grants one project only. The author of a checklist (or the creator of a turnover item) cannot sign it off while another eligible signer exists. Enforced at the database, which reads this policy per project.",
    defaultRoles: [] },
  // GOV-10 (intelligence Round G): spend authority. Members spend their OWN
  // provider keys under a monthly cap; who may set the workspace default and
  // each person's cap is this capability, read by /api/ai/usage — never a
  // role list. Default Admin only: Doc Control no longer raises caps unless
  // an Admin grants it. CRITICAL: a change to this row is Admin's (the
  // policy route, and the 20261137 write guard against a direct write) and
  // Admin is never removed from it — otherwise a Doc Controller could set
  // the row to [DocCtrl] from the console, become its sole holder and raise
  // their own cap with no Admin involved. Nobody raises their OWN cap while
  // another active member holds it (the route refuses), and every change
  // notifies the other holders.
  { id: "ai.manage_caps", area: "AI", label: "Manage AI spend caps", critical: true,
    description: "Set the workspace's default monthly AI cap and any person's own cap ($0 locks AI for them). Raising your own cap takes another holder while one exists. Admin always keeps it, and only an Admin changes who holds it. Every change is audited and notifies the other holders.",
    defaultRoles: ["Admin"] },
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
  /** QUAL-4 (20261136): the project a quality.sign_off decision is about. */
  projectId?: string | null;
}

/** The resource keys a `when` clause may condition on — the ONLY keys either
 *  evaluator reads. Extend here and in org_capability_allows_for together
 *  (projectId: 20261136, which re-created the evaluator with it). */
export const RESOURCE_KEYS = ["requestType", "unit", "libraryId", "discipline", "projectId"] as const;
export type ResourceKey = (typeof RESOURCE_KEYS)[number];

/** The capabilities a rule may scope to ONE project (QUAL-4, 20261136) —
 *  the only ones any evaluator is ever handed a projectId for. A projectId
 *  condition on any other capability is refused at save
 *  (validateCapabilityPolicy): it could never match there, and the SQL
 *  evaluator before 20261136 (20261132) reads four keys, not five, so it
 *  would read such a rule as UNCONDITIONAL — its tokens would become the
 *  base list of a capability the database enforces with it (holds,
 *  force-release, the audit trail, transmittal.issue): a widening wherever
 *  they name more than the base list. A quality.sign_off rule is harmless
 *  under 20261132: no policy or function consults that capability until
 *  20261136 re-creates the evaluator and the policies that read it, in one
 *  transaction. The policy route still refuses to store a project-scoped
 *  rule until the live database proves it reads the key
 *  (app/api/admin/capability-policy/route.ts). */
export const PROJECT_SCOPED_CAPS: ReadonlySet<CapabilityId> = new Set<CapabilityId>(["quality.sign_off"]);

/** Does the policy carry a rule conditioned on a project? (The policy route
 *  probes the live evaluator before storing one.) */
export function policyHasProjectScopedRule(policy: CapabilityPolicy | null | undefined): boolean {
  return Object.values(policy?.caps ?? {}).some((entry) =>
    isRuleArray(entry) && entry.some((r) => (r?.when?.projectId?.length ?? 0) > 0));
}

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

export type QualitySignOffVia = "controller" | "owner" | "capability";

/** ORG-14: the TypeScript mirror of quality_signer_eligible (20261136) — who
 *  the four quality write policies admit on ONE project, for a member already
 *  known to be ACTIVE in the project's org (the simulator lists only active
 *  members): a controller (Admin / DocCtrl anywhere in the collection —
 *  is_org_controller_for), the project's owner, or a holder of
 *  quality.sign_off FOR THAT PROJECT (policyAllows with resource
 *  { projectId } — a rule scoped to the project, the base list, or a live
 *  personal grant) who can also see the project (quality_signoff_granted_for:
 *  not private, or the owner, a controller or a project member). The
 *  database decides; this is what the View-as simulator says it decides. */
export function qualitySignOffEligible(input: {
  policy: CapabilityPolicy | null | undefined;
  uid: string;
  /** The FULL held collection (headline included). */
  roles: readonly string[];
  project: { id: string; ownerUserId: string | null; visibility?: string | null; memberIds?: readonly string[] };
}): { eligible: boolean; via: QualitySignOffVia | null } {
  const { policy, uid, roles, project } = input;
  if (roles.some((r) => isControllerRole(r as Role))) return { eligible: true, via: "controller" };
  if (project.ownerUserId && project.ownerUserId === uid) return { eligible: true, via: "owner" };
  const sees = project.visibility !== "private" || (project.memberIds ?? []).includes(uid);
  const granted = policyAllows(policy, "quality.sign_off", roles[0] ?? null, [...roles], uid, { projectId: project.id });
  return sees && granted ? { eligible: true, via: "capability" } : { eligible: false, via: null };
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
//
// WF-10 (admin-and-org Round G, P9): no server-side AUTHORITY decision reads
// through this cache any more. The workflow route (drafting-flow AUTHZ-7),
// the admin gate (lib/adminGate.ts), the transmittal issue rail
// (lib/transmittals.ts) and the AI-cap route (app/api/ai/usage) all read
// through loadCapabilityPolicyStrict — fresh on every decision, never cached
// — so a revoked grant, a narrowed role list or a removed member (whose
// grants revoke_member strips from the stored row, and whose membership every
// route re-reads) is refused on the very next server-side decision, on every
// instance. A census test (aoRoundGP9PermissionsConsole.test.ts) keeps the
// cached loader out of app/api and the server-only lib modules. What remains
// cached is the BROWSER's copy, which only draws controls;
// invalidateCapabilityPolicy(orgId) drops it in the tab that changed the
// policy, a grant or a membership (the policy route's callers do; the members
// page is admin-and-org P8's to call it after a removal or role change).

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

export interface LoadedCapabilityPolicy {
  policy: CapabilityPolicy;
  version: string | null;
  /** ALOG-1 / DEC-89 item 3 (ratified, DEC-90 A26): the stored policy could
   *  not be read and there was no last good entry to serve. `policy` is then
   *  `{}` — the SHIPPED DEFAULTS — which only a non-authoritative reader may
   *  show, LABELLED as defaults; an authority check refuses (lib/holds.ts
   *  assertHoldCapability), and the console says it could not read the
   *  policy (CapabilityPolicyEditor, ViewAsSimulator, PermissionsExplorer).
   *  The read error's text. Absent on a good read — "nothing stored" is a
   *  good read (version null, no marker): that IS the org's policy. */
  unreadable?: string;
  /** AUTHZ-7 done-when 3: the refresh failed and the LAST GOOD entry for this
   *  org was served instead of the defaults. `staleError` is the read error. */
  stale?: boolean;
  staleError?: string;
}

/** The strict (fail-closed) admin-gate loader reads the SAME shape with the
 *  SAME rule as the cached one — one parser, two names. */
export const normalizeStoredPolicy = parseStoredCapabilityPolicy;

/** SURF-9 / WF-20: the FAIL-CLOSED loader for the admin gate. Unlike
 *  `loadCapabilityPolicy` (which answers "defaults" on a read error so a
 *  transient failure never blocks a workflow action) this one reports the
 *  error, so a gate that cannot read the policy DENIES instead of admitting
 *  on the shipped defaults. Never cached: a gate decision is always fresh. */
export async function loadCapabilityPolicyStrict(
  orgId: string,
  client: Pick<typeof supabase, "from">,
): Promise<{ ok: true; policy: CapabilityPolicy; version: string | null } | { ok: false; error: string }> {
  try {
    // drafting-flow AUTHZ-7: the workflow route reads through this loader and
    // names the version it decided under in its audit row (WF-10), so the
    // row's updated_at rides along (null = nothing stored).
    const { data, error } = await client
      .from("org_configurations")
      .select("data, updated_at")
      .eq("org_id", orgId)
      .eq("key", "capability_policy")
      .maybeSingle();
    if (error) return { ok: false, error: error.message || "policy read failed" };
    const version = typeof (data as { updated_at?: unknown } | null)?.updated_at === "string" ? (data as { updated_at: string }).updated_at : null;
    return { ok: true, policy: normalizeStoredPolicy(data?.data), version };
  } catch (e) {
    return { ok: false, error: (e as Error)?.message || "policy read threw" };
  }
}

/** `client` lets server routes pass their own (service-role) client — the
 *  shared browser client has no session in a route handler. Returns the
 *  policy with the version stamp it was read at (null = nothing stored).
 *
 *  A failed read (DEC-89 item 3, ratified by DEC-90 A26 — authority
 *  decisions fail closed; drafting-flow AUTHZ-7 done-when 3, ALOG-1
 *  done-when 2): the LAST GOOD entry for the org is served, marked `stale`;
 *  with none, the answer is marked `unreadable` and its `policy` is `{}` —
 *  the shipped defaults, for a non-authoritative reader to show LABELLED as
 *  defaults. An authority check reads the marker and refuses. A failure is
 *  never cached, and a stale entry keeps its old timestamp, so the next call
 *  reads again. Every server-side authority decision reads through
 *  loadCapabilityPolicyStrict instead (fresh, never cached — WF-10). */
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
  // A read ERROR is not "no policy stored", and it is never cached: caching
  // the defaults would let an org's stored narrowing vanish for the TTL
  // after any transient failure (WF-1 done-when 2). The last good entry is
  // the org's policy as last read; with none, the caller is told.
  const failed = (message: string): LoadedCapabilityPolicy => (hit
    ? { policy: hit.policy, version: hit.version, stale: true, staleError: message }
    : { policy: {}, version: null, unreadable: message });
  try {
    const { data, error } = await (client ?? supabase)
      .from("org_configurations")
      .select("data, updated_at")
      .eq("org_id", orgId)
      .eq("key", "capability_policy")
      .maybeSingle();
    if (error) return failed(error.message || "the capability policy could not be read");
    // The column is `data` — reading `value` (which does not exist) errored on
    // every call, so the catch below returned {} and the entire capability
    // layer was inert (DB-1). Both this read and the SQL org_capability_allows
    // must use `data`, or the two layers disagree about which column is real.
    const policy = parseStoredCapabilityPolicy(data?.data);
    const version = typeof data?.updated_at === "string" ? data.updated_at : null;
    if (!sessionless) cache.set(orgId, { at: Date.now(), policy, version });
    return { policy, version };
  } catch (e) {
    return failed((e as Error)?.message || "the capability policy read threw");
  }
}

/** The policy alone — for NON-AUTHORITATIVE readers only: the affordance
 *  surfaces that decide which controls to draw while a server route, a
 *  strict gate or the database decides (ALOG-1's census: the requests and
 *  transmittals pages, HoldStrip, InspectorPanel, CheckoutStatusCell, the
 *  ticket-notification hook, /admin/holds, and the hold-notification
 *  audience in lib/holds.ts). Its contract on a failed read is DEC-89's for
 *  such a reader: the last good entry, else the shipped defaults. A caller
 *  that DECIDES authority, or that presents the policy as the org's, reads
 *  loadCapabilityPolicyEntry and its `unreadable` / `stale` markers (or the
 *  strict loader) instead. */
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
        // QUAL-4: only a capability evaluated per project may be scoped to
        // one (PROJECT_SCOPED_CAPS). Anywhere else the rule never matches —
        // and the database's evaluator before 20261136 would read it as
        // unconditional, widening the capability for everyone it names.
        if ((r.when?.projectId?.length ?? 0) > 0 && !PROJECT_SCOPED_CAPS.has(def.id)) {
          const scoped = CAPABILITY_DEFS.filter((d) => PROJECT_SCOPED_CAPS.has(d.id)).map((d) => `"${d.label}"`).join(", ");
          return `${def.label}: a rule cannot be scoped to a project — only ${scoped} is decided per project. Anywhere else the rule would never match, and a database without 20261136 would read it as unconditional — applying it everywhere.`;
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
 *  only — grants are owned by the server and preserved across a save.
 *  ALOG-12: a `save` carries the `version` (org_configurations.updated_at,
 *  null = nothing was stored) the grid was LOADED at; the route refuses it
 *  with 409 `policy_changed` when the stored row has moved on since, instead
 *  of overwriting another admin's change. A save without the key (a bundle
 *  from before this change, mid-deploy) keeps the route's own
 *  compare-and-set only. */
export type CapabilityPolicyChange =
  | { op: "save"; orgId: string; caps: NonNullable<CapabilityPolicy["caps"]>; version?: string | null }
  | { op: "grant"; orgId: string; uid: string; cap: CapabilityId; expiresAt?: string | null; note?: string | null }
  | { op: "revoke"; orgId: string; uid: string; cap: CapabilityId };

/** The route's 409 code when the stored policy moved on under a write. */
export const POLICY_CHANGED = "policy_changed";

/** A refused policy write, with the route's status and code (ALOG-12: the
 *  editor reloads on `policy_changed`). */
export class CapabilityPolicyChangeError extends Error {
  readonly status: number;
  readonly code: string | null;
  constructor(message: string, status: number, code: string | null) {
    super(message);
    this.name = "CapabilityPolicyChangeError";
    this.status = status;
    this.code = code;
  }
}

/** Two version stamps name the same stored row: the same text, or the same
 *  instant (PostgREST's "+00:00" and an ISO "Z" spell one timestamptz). */
export function samePolicyVersion(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = a ?? null, y = b ?? null;
  if (x === y) return true;
  if (x === null || y === null) return false;
  const tx = Date.parse(x), ty = Date.parse(y);
  return !Number.isNaN(tx) && tx === ty;
}

async function postPolicyChange(change: CapabilityPolicyChange): Promise<{ policy: CapabilityPolicy; version: string | null }> {
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;
  if (!token) throw new Error("Not signed in");
  const res = await fetch(CAPABILITY_POLICY_ROUTE, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(change),
  });
  const json = (await res.json().catch(() => ({}))) as { error?: string; code?: string; policy?: CapabilityPolicy; version?: string };
  if (!res.ok) throw new CapabilityPolicyChangeError(json.error || `Policy change failed (${res.status})`, res.status, json.code ?? null);
  cache.delete(change.orgId);
  return { policy: json.policy ?? {}, version: typeof json.version === "string" ? json.version : null };
}

/** Save the role grid. `policy.grants` is ignored: grants are changed only
 *  through addUserGrant / revokeUserGrant and preserved by the server. The
 *  actor is derived from the session on the server; the actor fields are
 *  kept for call-site compatibility. ALOG-12: pass the `version` the grid
 *  was loaded at; the answer is the version the save wrote. */
export async function saveCapabilityPolicy(input: {
  orgId: string;
  policy: CapabilityPolicy;
  actorUserId: string;
  actorEmail?: string | null;
  version?: string | null;
}): Promise<{ version: string | null }> {
  const err = validateCapabilityPolicy({ caps: input.policy.caps });
  if (err) throw new Error(err);
  const change: CapabilityPolicyChange = { op: "save", orgId: input.orgId, caps: input.policy.caps ?? {} };
  if (input.version !== undefined) change.version = input.version;
  const out = await postPolicyChange(change);
  return { version: out.version };
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
