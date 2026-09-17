// lib/managementRoles.ts
//
// WF-24 / CHAIN-3: THE one definition of the drafting workflow's management
// tier. Three subsystems used to carry their own list — the attention feed
// (which also counted DraftingSupervisor), the workflow engine and the
// capability-policy defaults — and answered "who must act on this ticket?"
// three different ways. Every consumer now reads this constant:
//
//   * lib/capabilityPolicy.ts — the shipped defaults for `ticket.manage`,
//     `ticket.reopen`, `ticket.force_close`, `admin.analytics_view` (the SQL
//     mirror in org_capability_allows_for is pinned against CAPABILITY_DEFS).
//   * lib/workflow.ts — `isManagementRole` for the engineer gate (a
//     management requester approves engineering work directly).
//   * lib/ticketAttention.ts — no longer holds a list at all: "must act" is
//     derived from the engine, so the badge and the ticket page cannot
//     disagree. `QUEUE_VIEW_ROLES` there is a VISIBILITY scope (who sees the
//     whole queue), deliberately wider than this authority tier.
//
// DraftingSupervisor is NOT management: the queue owner holds `ticket.assign`
// explicitly (lib/capabilityPolicy.ts) and nothing else — that is how the
// role was specified, and it is frozen in lib/__tests__/workflow.test.ts.
// Pure — no imports — so server routes, SQL-mirror tests and client modules
// can all read it.

export const MANAGEMENT_ROLES: readonly string[] = ["Admin", "Manager", "Supervisor"];

/** True for ONE role name in the management tier. */
export function isManagementRole(role?: string | null): boolean {
  return !!role && MANAGEMENT_ROLES.includes(role);
}

/** True when a role COLLECTION (headline + additive) holds any management role. */
export function holdsManagementRole(roles: readonly string[] | null | undefined): boolean {
  return !!roles && roles.some((r) => MANAGEMENT_ROLES.includes(r));
}
