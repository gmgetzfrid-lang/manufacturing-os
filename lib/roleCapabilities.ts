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

/** Highest-ranked role in the collection — the headline / RLS-facing role.
 *  Falls back to "Viewer" for an empty collection. */
export function primaryRole(roles: Role[]): Role {
  if (roles.length === 0) return "Viewer";
  return [...roles].sort((a, b) => (ROLE_RANK[b] ?? 0) - (ROLE_RANK[a] ?? 0))[0];
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
