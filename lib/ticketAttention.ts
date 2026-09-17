// lib/ticketAttention.ts
//
// Single source of truth for "does this ticket need MY action right now?".
//
// This logic used to be copy-pasted into two places — the attention hook
// (hooks/useTicketNotifications.ts, which feeds the sidebar badge, the header
// bell, and the /inbox cockpit) and the Drafting Request Portal
// (app/(protected)/requests/page.tsx) — and then, once centralised here, it
// was still a PARALLEL TABLE of role × status that drifted from the workflow
// engine: a DraftingSupervisor's badge counted every PENDING_REVIEW and
// PENDING_FINAL_APPROVAL ticket while the ticket page showed "View Only — No
// Actions Available" (WF-24 / CHAIN-3), so the badge could never clear.
//
// WF-24: "must act" is now DERIVED FROM THE ENGINE. A ticket needs the
// viewer's action exactly when lib/workflow.ts offers them a live action that
// is not marked `optional` (overrides, reassignment, cancellation, reopen,
// attaching a file) and not disabled by separation of duties. The badge, the
// portal's row markers and the ticket page's buttons therefore agree for
// every role/status combination by construction — there is no second table
// to keep in sync. The management tier itself is defined once, in
// lib/managementRoles.ts.
//
// Two different questions, deliberately: routing (lib/ticketRouting.ts) says
// who is TOLD when a ticket lands in a queue; this says who must ACT. A
// supervisor is told about a PENDING_IFC package (so they can chase the
// drafter) but the engine offers them nothing there, so it is not their
// action item — it is a bell row, not a badge count.

import type { Role, Ticket } from "@/types/schema";
import { WorkflowEngine } from "@/lib/workflow";
import type { CapabilityPolicy } from "@/lib/capabilityPolicy";
import { MANAGEMENT_ROLES } from "@/lib/managementRoles";

/** VISIBILITY scope, not authority: the roles that see the whole request
 *  queue (the supervisor board, the org-wide attention fetch). Wider than the
 *  management tier by exactly the queue owner, who runs assignment without
 *  holding the override tier. */
export const QUEUE_VIEW_ROLES: readonly Role[] = [...MANAGEMENT_ROLES, "DraftingSupervisor"] as Role[];

/** True if the collection holds a role that sees the whole queue. */
export function isQueueViewer(roles: readonly Role[]): boolean {
  return roles.some((r) => QUEUE_VIEW_ROLES.includes(r));
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
  /** The org's capability policy when the caller has loaded it; absent, the
   *  shipped defaults apply — the same fallback the ticket page uses before
   *  its policy arrives, so the two never disagree for longer than a load. */
  policy?: CapabilityPolicy | null;
  /** The org's active member count, when known (separation-of-duties
   *  disables an action the viewer cannot take; absent = not applied). */
  activeMemberCount?: number;
}

/**
 * Whether `ticket` is waiting on an action from the viewer described by `ctx`:
 * the workflow engine offers them at least one action that is neither
 * `optional` nor disabled. Identity (requester / assigned drafter / assigned
 * engineer), the claim pool, the co-review pool and the management gates all
 * come from the engine — this function holds no role table of its own.
 */
export function isActionRequired(ticket: Ticket, ctx: AttentionContext): boolean {
  const { uid, roles } = ctx;
  if (!uid) return false;
  if (ticket.status === "CLOSED" || ticket.status === "CANCELED") return false;
  const headline = (roles[0] ?? "Viewer") as Role;
  const actions = WorkflowEngine.getActions(ticket, headline, uid, ctx.policy ?? undefined, {
    userRoles: roles.length > 0 ? [...roles] : undefined,
    activeMemberCount: ctx.activeMemberCount,
  });
  return actions.some((a) => !a.optional && !a.disabledReason);
}

/** Short human label for WHY a ticket needs attention, given its status.
 *  Used by the bell / inbox to describe an action-required row. */
export function attentionLabel(status: string): string {
  switch (status) {
    case "PENDING_ASSIGNMENT": return "Needs a drafter assigned";
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
