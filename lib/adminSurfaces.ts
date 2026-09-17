// lib/adminSurfaces.ts
//
// SURF-9 / WF-20: THE admin-surface registry — one place that says who may
// ENTER each /admin/* surface, evaluated by one server-side gate
// (lib/adminGate.ts, served by /api/admin/gate) that the admin layout asks
// before it renders any admin page. Before this, every page carried its own
// bespoke client expression, two of them read the capability policy in the
// browser and failed OPEN on a load error, and nothing on the server knew
// which surface a member was allowed into.
//
// The ENTRY rule mirrors what each page did on 2026-09-17 (DEC-17: no
// surface changes who may open it as a side-effect of consolidating), with
// ONE deliberate narrowing, stated in SURF-9's resolution: /admin/storage
// never gated entry itself (only its writes), so any member could open it
// and see a stats error; its entry is its stats API's set. Two pages that
// redirected a non-controller (/admin/libraries, /admin/requests) now show
// the gate's denial screen instead — the same admission, a different answer.
//   * `entry: string[]` — the role collection must hold one of these
//     (deny-if-none, by the FULL collection — heldRoles / memberHoldsAny);
//   * `entry: "*"`     — any ACTIVE member may open it; the page itself
//     renders read-only and gates its writes by `writes`;
//   * `cap`            — a capability-policy decision: role tokens, then a
//     live per-person grant (policyAllows with uid). Three surfaces.
// `writes` is documentation pinned by test against the page's own constant:
// the authority the page's actions need, enforced by the page and by its
// API routes / RLS — NOT by the entry gate.
//
// Pure — no imports beyond the policy evaluator — so the layout, the gate
// route and the tests all read the same table.

import { policyAllows, type CapabilityId, type CapabilityPolicy } from "@/lib/capabilityPolicy";
import { memberHoldsAny } from "@/lib/roleHeld";

export interface AdminSurface {
  /** Stable key = the first path segment after /admin/. */
  key: string;
  path: `/admin/${string}`;
  label: string;
  /** Who may open the surface: a role set, any active member, or the `cap`. */
  entry: string[] | "*";
  /** Set when entry is decided by the capability policy (grants honoured). */
  cap?: CapabilityId;
  /** The page's action authority (documentation; pinned to its source). */
  writes?: string[];
  /** Shown on the denial screen. */
  denied: string;
}

const CONTROLLERS = ["Admin", "DocCtrl"];
const CHANGE = "An Admin can change this under Admin → Permissions → Action permissions.";

export const ADMIN_SURFACES: readonly AdminSurface[] = [
  { key: "branding", path: "/admin/branding", label: "Branding", entry: ["Admin"],
    denied: "Only Admins can manage workspace branding." },
  { key: "users", path: "/admin/users", label: "Users", entry: ["Admin", "Manager", "DocCtrl"], writes: ["Admin", "Manager"],
    denied: "Only Admin, Manager or Document Control can open the member roster." },
  { key: "teams", path: "/admin/teams", label: "Teams", entry: ["Admin", "Manager"], writes: CONTROLLERS,
    denied: "Only Admins and Managers can manage teams." },
  { key: "libraries", path: "/admin/libraries", label: "Library config", entry: CONTROLLERS,
    denied: "Only an Admin or Document Controller can configure libraries." },
  { key: "requests", path: "/admin/requests", label: "Request forms", entry: CONTROLLERS,
    denied: "Only an Admin or Document Controller can configure request forms." },
  { key: "permissions", path: "/admin/permissions", label: "Permissions", entry: "*", writes: CONTROLLERS,
    denied: "You must be an active member to view permissions." },
  { key: "settings", path: "/admin/settings", label: "Workspace settings", entry: ["Admin"],
    denied: "Workspace settings are limited to Admins." },
  { key: "codebook", path: "/admin/codebook", label: "Site codebook", entry: "*", writes: CONTROLLERS,
    denied: "You must be an active member to view the codebook." },
  { key: "audit", path: "/admin/audit", label: "Audit log", entry: ["Admin", "Manager", "Supervisor", "DocCtrl", "Auditor"], cap: "admin.audit_view",
    denied: `The audit log is limited to management, document control and auditors. ${CHANGE}` },
  { key: "scope", path: "/admin/scope", label: "Operational scope", entry: "*", writes: ["Admin", "Manager", "Supervisor", "DocCtrl"],
    denied: "You must be an active member to view the operational scope." },
  { key: "holds", path: "/admin/holds", label: "Holds", entry: "*", writes: ["Admin", "Manager", "Supervisor", "DocCtrl"],
    denied: "You must be an active member to view holds." },
  { key: "assets", path: "/admin/assets", label: "Operating areas", entry: "*", writes: ["Admin", "DocCtrl", "Manager", "Supervisor"],
    denied: "You must be an active member to browse the equipment registry." },
  { key: "storage", path: "/admin/storage", label: "Storage & Backup", entry: ["Admin", "Manager", "DocCtrl"], writes: CONTROLLERS,
    denied: "Storage & Backup is limited to Admin, Manager and Document Control." },
  { key: "archive-view", path: "/admin/archive-view", label: "Archive browser", entry: CONTROLLERS, cap: "admin.archive_view",
    denied: `The backup viewer is limited to Admin and Document Control. ${CHANGE}` },
  { key: "data-export", path: "/admin/data-export", label: "Data export", entry: "*", writes: ["Admin", "Manager", "DocCtrl"],
    denied: "You must be an active member to view data exports." },
  { key: "restore", path: "/admin/restore", label: "Restore", entry: ["Admin"],
    denied: "Restore is limited to Admins." },
  { key: "billing", path: "/admin/billing", label: "Billing", entry: "*", writes: ["Admin", "Manager"],
    denied: "You must be an active member to view billing." },
  { key: "proposed-links", path: "/admin/proposed-links", label: "Proposed links", entry: "*", writes: ["Admin", "DocCtrl", "Manager", "Supervisor"],
    denied: "You must be an active member to view proposed links." },
  { key: "analytics", path: "/admin/analytics", label: "Analytics", entry: ["Admin", "Manager", "Supervisor", "DocCtrl"], cap: "admin.analytics_view",
    denied: `Analytics is limited to management and document control. ${CHANGE}` },
  { key: "ai-instructions", path: "/admin/ai-instructions", label: "AI instructions", entry: "*", writes: CONTROLLERS,
    denied: "You must be an active member to view AI instructions." },
];

export function adminSurface(key: string): AdminSurface | null {
  return ADMIN_SURFACES.find((s) => s.key === key) ?? null;
}

/** The surface a pathname belongs to, or null (unknown → the gate denies). */
export function adminSurfaceForPath(pathname: string | null | undefined): AdminSurface | null {
  const m = /^\/admin\/([^/?#]+)/.exec(pathname ?? "");
  return m ? adminSurface(m[1]) : null;
}

/** The single entry decision. `held` is the FULL role collection of an
 *  ACTIVE member (an empty collection is never admitted — fail closed);
 *  `policy` is required for a capability surface and is consulted with
 *  `uid` so a per-person grant counts. */
export function adminSurfaceAllows(
  surface: AdminSurface,
  held: readonly string[],
  policy: CapabilityPolicy | null | undefined,
  uid: string | null | undefined,
): boolean {
  const roles = held.filter((r) => typeof r === "string" && r.trim().length > 0);
  if (roles.length === 0) return false;
  if (surface.cap) {
    return policyAllows(policy, surface.cap, roles[0], roles, uid ?? undefined);
  }
  if (surface.entry === "*") return true;
  return memberHoldsAny({ roles }, surface.entry);
}
