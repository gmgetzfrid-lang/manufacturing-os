// lib/ticketAttention.ts
//
// Single source of truth for "does this ticket need MY action right now?".
//
// This logic used to be copy-pasted into two places — the attention hook
// (hooks/useTicketNotifications.ts, which feeds the sidebar badge, the header
// bell, and the /inbox cockpit) and the Drafting Request Portal
// (app/(protected)/requests/page.tsx). The two copies drifted: notably the
// portal never treated PENDING_IFC as action-required for a supervisor, even
// though lib/ticketRouting.ts ROUTES the "issue the IFC" alert to exactly that
// role. The result was a supervisor getting pinged about an IFC in the bell
// while the portal showed the same ticket with no "action needed" marker.
//
// Centralising the rule here keeps the badge count, the portal's row badges,
// and the routing policy consistent by construction.

import type { Role, Ticket } from "@/types/schema";

/** Roles that own the workflow at the supervisory level. These are the people
 *  who must act on assignment / review / approval / IFC gates. Kept in sync
 *  with the supervisor-targeted routing in lib/ticketRouting.ts. */
export const MANAGEMENT_ROLES: readonly Role[] = [
  "Admin",
  "Manager",
  "Supervisor",
  "DraftingSupervisor",
] as const;

/** True if the collection holds any supervisory/management role. */
export function isManagementRole(roles: readonly Role[]): boolean {
  return roles.some((r) => MANAGEMENT_ROLES.includes(r));
}

/** True if the collection holds any engineering role (Engineer-1..4). */
export function isEngineerRole(roles: readonly Role[]): boolean {
  return roles.some((r) => r.startsWith("Engineer"));
}

export interface AttentionContext {
  /** The viewer's user id. */
  uid: string | null | undefined;
  /** The viewer's full additive role collection for the active org. */
  roles: readonly Role[];
}

/**
 * Whether `ticket` is waiting on an action from the viewer described by `ctx`.
 *
 * The rule is the union of every hat the viewer can wear:
 *   • the assigned drafter      → DRAFTING / REVISION_REQ / PENDING_IFC
 *   • the requester             → PENDING_REVIEW / FINAL_DRAFT
 *   • the assigned engineer     → PENDING_ENG_TEAM / PENDING_FINAL_APPROVAL
 *   • any drafter (claim pool)  → PENDING_ASSIGNMENT
 *   • management / supervisor   → PENDING_ASSIGNMENT, PENDING_ENG_INITIAL,
 *                                 PENDING_REVIEW, PENDING_FINAL_APPROVAL,
 *                                 PENDING_IFC  ← matches supervisor routing
 *   • any engineer              → PENDING_ENG_INITIAL, unclaimed
 *                                 PENDING_ENG_TEAM / PENDING_FINAL_APPROVAL,
 *                                 PENDING_REVIEW
 *   • DocCtrl                   → FINAL_DRAFT / PENDING_IFC
 */
export function isActionRequired(ticket: Ticket, ctx: AttentionContext): boolean {
  const { uid, roles } = ctx;
  if (!uid) return false;
  const status = ticket.status;

  // Personal assignments — independent of role.
  if (ticket.assignedDrafterId === uid) {
    if (status === "DRAFTING" || status === "REVISION_REQ" || status === "PENDING_IFC") return true;
  }
  if (ticket.requesterId === uid) {
    if (status === "PENDING_REVIEW" || status === "FINAL_DRAFT") return true;
  }
  if (ticket.assignedEngineerId === uid) {
    if (status === "PENDING_ENG_TEAM" || status === "PENDING_FINAL_APPROVAL") return true;
  }

  // The claim pool: any drafter can pick up an unassigned request.
  if (roles.includes("Drafter") && status === "PENDING_ASSIGNMENT") return true;

  // Supervisors / management own the workflow gates — including PENDING_IFC,
  // which lib/ticketRouting.ts routes to the DraftingSupervisor (falling back
  // to Admins). This is the line the portal was previously missing.
  if (isManagementRole(roles)) {
    if (
      status === "PENDING_ASSIGNMENT" ||
      status === "PENDING_ENG_INITIAL" ||
      status === "PENDING_REVIEW" ||
      status === "PENDING_FINAL_APPROVAL" ||
      status === "PENDING_IFC"
    ) {
      return true;
    }
  }

  // Engineers act on the review/approval gates. Team & final-approval only
  // count while still unclaimed, so a reviewed ticket stops nagging the rest
  // of the engineering pool.
  if (isEngineerRole(roles)) {
    if (status === "PENDING_ENG_INITIAL") return true;
    if (status === "PENDING_ENG_TEAM" && !ticket.assignedEngineerId) return true;
    if (status === "PENDING_FINAL_APPROVAL" && !ticket.assignedEngineerId) return true;
    if (status === "PENDING_REVIEW") return true;
  }

  if (roles.includes("DocCtrl")) {
    if (status === "FINAL_DRAFT" || status === "PENDING_IFC") return true;
  }

  return false;
}

/** Short human label for WHY a ticket needs attention, given its status.
 *  Used by the bell / inbox to describe an action-required row. */
export function attentionLabel(status: string): string {
  switch (status) {
    case "PENDING_ASSIGNMENT": return "Needs a drafter assigned";
    case "PENDING_ENG_INITIAL":
    case "PENDING_ENG_TEAM": return "Engineering review";
    case "PENDING_REVIEW": return "Needs review";
    case "PENDING_FINAL_APPROVAL": return "Needs engineer sign-off";
    case "DRAFTING":
    case "REVISION_REQ": return "Drafting in progress";
    case "PENDING_IFC": return "Issue the IFC package";
    case "FINAL_DRAFT": return "Acknowledge & close";
    default: return "Needs your attention";
  }
}
