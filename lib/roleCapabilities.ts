// lib/roleCapabilities.ts
//
// Additive role model. A member holds a COLLECTION of roles; their effective
// permissions are the UNION of what each role grants. This module is the single
// source of truth for "what does a role let you do" and powers:
//
//   * the smart role picker in Team Management (only offer a role if it grants
//     a capability the member doesn't already have — never an empty add), and
//   * the `primaryRole` headline (highest-ranked role) that we keep mirrored
//     into org_members.role so the existing single-role checks + RLS keep
//     working unchanged while additive checks roll out surface by surface.
//
// Capabilities are intentionally coarse and are derived from the role gates
// that already exist in the app today (requests portal, admin pages, routing).
// Adding finer capabilities later is purely additive here.
//
// ⚠ PICKER-ONLY (DEC-11). This `Capability` vocabulary is the role picker's
// DESCRIPTIVE layer — nothing evaluates it to authorize an action. Authority
// lives in the capability policy (lib/capabilityPolicy.ts), the content ACL
// (lib/acl.ts), and the role gates in routes/RLS. Do not wire an enforcement
// decision to these strings.

import type { Role } from "@/types/schema";
import { ALL_ROLES } from "@/types/schema";

export type Capability =
  | "view_requests"        // see the org-wide requests queue / metrics
  | "create_requests"      // file a drafting request
  | "assign_drafters"      // approve & assign incoming requests
  | "route_requests"       // be the notification target for new requests
  | "approve_engineering"  // engineer initial/team review sign-off
  | "draft_work"           // claim & produce drafts
  | "doc_control"          // issue-for-construction / final document control
  | "manage_users"         // add/remove members, change roles
  | "manage_org_config"    // edit org/drafting configuration
  | "audit";               // read audit trails

export const CAPABILITY_LABELS: Record<Capability, string> = {
  view_requests: "View the requests queue",
  create_requests: "Create drafting requests",
  assign_drafters: "Approve & assign requests",
  route_requests: "Receive incoming requests (routing target)",
  approve_engineering: "Engineering review sign-off",
  draft_work: "Claim & produce drafts",
  doc_control: "Document control (IFC / final issue)",
  manage_users: "Manage members & roles",
  manage_org_config: "Manage org & drafting settings",
  audit: "View audit trails",
};

// Role → the capabilities it grants. Derived from the role checks already in
// the codebase. Engineer levels share one capability on purpose (the level is a
// sub-hierarchy, not a distinct permission).
export const ROLE_CAPABILITIES: Record<Role, Capability[]> = {
  Admin: ["manage_users", "manage_org_config", "assign_drafters", "view_requests", "create_requests"],
  Manager: ["manage_users", "assign_drafters", "view_requests", "create_requests"],
  Supervisor: ["assign_drafters", "view_requests", "create_requests"],
  DraftingSupervisor: ["assign_drafters", "route_requests", "view_requests", "create_requests"],
  DocCtrl: ["doc_control", "manage_org_config", "view_requests", "create_requests"],
  "Engineer-1": ["approve_engineering", "view_requests", "create_requests"],
  "Engineer-2": ["approve_engineering", "view_requests", "create_requests"],
  "Engineer-3": ["approve_engineering", "view_requests", "create_requests"],
  "Engineer-4": ["approve_engineering", "view_requests", "create_requests"],
  Drafter: ["draft_work", "create_requests"],
  Requester: ["create_requests"],
  Accounting: ["create_requests"],
  Safety: ["create_requests"],
  HR: ["create_requests"],
  Maintenance: ["create_requests"],
  Operations: ["create_requests"],
  Contractor: ["create_requests"],
  Auditor: ["audit", "view_requests"],
  Viewer: [],
};

// Headline ranking. The highest-ranked role in a member's collection becomes
// their `primaryRole` — mirrored into org_members.role so legacy single-role
// checks and the database RLS policies (which read `role`) reflect the most
// powerful role the member holds, with no RLS changes required.
const ROLE_RANK: Record<Role, number> = {
  Admin: 100,
  Manager: 90,
  Supervisor: 80,
  DraftingSupervisor: 75,
  DocCtrl: 70,
  "Engineer-4": 64,
  "Engineer-3": 63,
  "Engineer-2": 62,
  "Engineer-1": 61,
  Drafter: 50,
  Requester: 40,
  Operations: 35,
  Maintenance: 34,
  Safety: 33,
  HR: 32,
  Accounting: 31,
  Contractor: 30,
  Auditor: 20,
  Viewer: 10,
};

/** Union of capabilities granted by a set of roles. */
export function capabilitiesFor(roles: Role[]): Set<Capability> {
  const caps = new Set<Capability>();
  for (const r of roles) {
    for (const c of ROLE_CAPABILITIES[r] ?? []) caps.add(c);
  }
  return caps;
}

/** Capabilities `role` would add on top of what `current` already grants.
 *  Empty array → adding it is a no-op (the picker hides/disables it). */
export function capabilitiesAdded(role: Role, current: Role[]): Capability[] {
  const have = capabilitiesFor(current);
  return (ROLE_CAPABILITIES[role] ?? []).filter((c) => !have.has(c));
}

/** Roles worth adding to `current`: not already held, and grant at least one
 *  new capability. The "don't let me add something useless" guardrail. */
export function addableRoles(current: Role[]): Role[] {
  return ALL_ROLES.filter((r) => !current.includes(r) && capabilitiesAdded(r, current).length > 0);
}

/** Highest-ranked role in the collection — the DISPLAY headline and the value
 *  mirrored into the legacy `org_members.role` column (kept in sync at the
 *  database by 20261046's trigger). ADD-3: this is NEVER an authority or
 *  applicability test — rank is not relevance (a ["Requester","Engineer-2"]
 *  member is an engineer for approval purposes, whatever the headline).
 *  Use `hasAnyRole` / `heldRoles` / `relevantRequesterRole` for decisions.
 *  Falls back to "Viewer" for an empty collection. */
export function primaryRole(roles: Role[]): Role {
  if (roles.length === 0) return "Viewer";
  return [...roles].sort((a, b) => (ROLE_RANK[b] ?? 0) - (ROLE_RANK[a] ?? 0))[0];
}

/** ADD-3: the role a request should be stamped with for APPROVAL ROUTING —
 *  chosen by relevance, not rank. An engineer tier held anywhere in the
 *  collection makes the requester an engineer (they approve their own
 *  request directly); otherwise a management / DocCtrl role; otherwise the
 *  headline. */
export function relevantRequesterRole(roles: readonly Role[], headline?: Role | null): Role {
  const eng = roles.filter((r) => r.startsWith("Engineer")).sort((a, b) => (ROLE_RANK[b] ?? 0) - (ROLE_RANK[a] ?? 0))[0];
  if (eng) return eng;
  const mgmt = roles.filter((r) => ["Admin", "Manager", "Supervisor", "DraftingSupervisor", "DocCtrl"].includes(r))
    .sort((a, b) => (ROLE_RANK[b] ?? 0) - (ROLE_RANK[a] ?? 0))[0];
  if (mgmt) return mgmt;
  return headline ?? (roles.length ? primaryRole([...roles]) : "Viewer");
}

/** Numeric rank of a role (higher = more capable). Read-only view of the
 *  same table `primaryRole` sorts by, for callers that need to ORDER
 *  memberships by capability (e.g. the workspace self-heal picker). */
export function roleRank(role: Role): number {
  return ROLE_RANK[role] ?? 0;
}

/** Normalize whatever is stored (roles array and/or legacy single role) into a
 *  deduped collection. Tolerates the pre-migration shape where only `role`
 *  exists. */
export function normalizeRoles(rolesArr: unknown, legacyRole: unknown): Role[] {
  const out: Role[] = [];
  const push = (v: unknown) => {
    if (typeof v === "string" && (ALL_ROLES as string[]).includes(v) && !out.includes(v as Role)) {
      out.push(v as Role);
    }
  };
  if (Array.isArray(rolesArr)) rolesArr.forEach(push);
  push(legacyRole);
  return out;
}

// ─── Display-only role notes (DEC-3 / DEC-4) ─────────────────────────────
// PICKER-ONLY, like everything else in this module. Nothing evaluates these
// to authorize an action; they exist so the pickers stop offering strings
// that grant nothing beyond Requester without telling the admin so.

/** DEC-3: the five capability-dead department roles. Deprecated, NOT
 *  deleted — role identity is a bare string inside customer JSON with no
 *  version field, so removing one from ALL_ROLES would silently orphan every
 *  stored ACL rule that names it. Rendered greyed with a "use a team" hint;
 *  still selectable; still a valid ACL subject. This is an EXPLICIT list on
 *  purpose: "grants nothing new" would also catch Contractor, which is
 *  load-bearing as a RESTRICTION (reduced navigation) and must never be
 *  marked dormant. */
export const DORMANT_ROLES: readonly Role[] = ["Accounting", "Safety", "HR", "Maintenance", "Operations"];

export function isDormantRole(role: string): boolean {
  return (DORMANT_ROLES as readonly string[]).includes(role);
}

export const DORMANT_ROLE_NOTE =
  "Use a team instead — this role grants nothing beyond Requester.";

/** DEC-4: the four Engineer tiers are labels with IDENTICAL authority — every
 *  check is "role contains Engineer" and the capability policy's `Engineer`
 *  token matches all four. Kept as customer-visible seniority; documented as
 *  equivalent so nobody assigns a tier expecting a power difference. */
export const ENGINEER_TIER_ROLES: readonly Role[] = ["Engineer-1", "Engineer-2", "Engineer-3", "Engineer-4"];

export const ENGINEER_TIER_NOTE =
  "Engineering tiers are labels — all four grant identical authority. Use a capability grant to differentiate.";

/** The display note a picker should attach to a role, or null. */
export function roleDisplayNote(role: string): string | null {
  if (isDormantRole(role)) return DORMANT_ROLE_NOTE;
  if ((ENGINEER_TIER_ROLES as readonly string[]).includes(role)) return ENGINEER_TIER_NOTE;
  return null;
}
