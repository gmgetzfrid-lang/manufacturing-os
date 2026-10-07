// lib/ticketReadScope.ts
//
// drafting-flow AUTHZ-13 (DEC-44 (DF-P1) item 1): the Contractor-only read
// scope, asked by the service-role routes that write a ticket on the caller's
// behalf.
//
// Migration 20261166 narrows what a member every one of whose held roles is
// Contractor can read: the tickets they requested, are the drafter or engineer
// on, follow (`watchers`), or were mentioned on (`ticket_comments`). The
// database decides that for the caller's own session. A route running under
// the service role skips row-level security, and `auth.uid()` is NULL there,
// so it cannot ask the database. If such a route let a Contractor-only member
// follow or comment on any ticket, that member would land in `watchers`, and
// `watchers` is one of the scope's own legs, so the narrowing would be undone.
// /api/tickets/watch, /api/tickets/comment and /api/tickets/workflow-action
// (whose transitions add the actor to `watchers`) ask this module first and
// refuse a ticket outside the scope, with the same "not found" an RLS read
// gives.
//
// The predicate mirrors the SQL exactly:
//   * Contractor-only = every role the member holds is Contractor, where
//     "holds" is `heldRoles()` — the headline UNION the `roles` collection,
//     trimmed, blanks dropped — and at least one role is held. That is how
//     the rest of the codebase reads a member's authority (`heldRoles()`,
//     `is_org_controller`), so a Manager whose `roles` drifted to
//     `{Contractor}` still holds Manager and keeps the org read. The SQL
//     (`contractor_only_org_ids()` and the paste's inventory, 20261166) spells
//     the same rule over `ARRAY[m.role] || COALESCE(m.roles, '{}')`: drop
//     NULL and blank entries, compare the trimmed rest to 'Contractor', and
//     answer false when nothing is left. The two must stay identical: a
//     looser test here than in the database would re-open the bypass for a
//     member the database narrows, and a stricter one would refuse a member
//     the database lets read the ticket.
//   * the legs: requester, drafter, engineer, watcher, mentioned on a comment
//     row that is not deleted (the `ticket_comments` copy, as the SQL's
//     ticket_mentions_me reads it: deleting the comment withdraws the
//     mention). An edited comment keeps the mentions it was posted with:
//     the comment PATCH does not rewrite `mentioned_uids` in either copy.

import type { SupabaseClient } from "@supabase/supabase-js";
import { heldRoles } from "@/lib/roleHeld";

const CONTRACTOR = "Contractor";

/** True when every role the member holds (headline ∪ collection) is
 *  Contractor and they hold at least one, decided as 20261166 decides it in
 *  the database. */
export function isContractorOnly(member: { role?: unknown; roles?: unknown } | null | undefined): boolean {
  const held = heldRoles(member);
  return held.length > 0 && held.every((r) => r === CONTRACTOR);
}

export interface ScopedTicket {
  id: string;
  requesterId?: string | null;
  assignedDrafterId?: string | null;
  assignedEngineerId?: string | null;
  watchers?: string[] | null;
}

/**
 * May this member reach this ticket through a service-role route?
 *   * "in": not Contractor-only (the org-wide read stands), or a leg holds;
 *   * "out": Contractor-only and no leg holds (answer as if the ticket did
 *     not exist);
 *   * "unknown": the mention lookup failed. The caller refuses (503) and
 *     writes nothing.
 */
export async function ticketReadScope(
  client: Pick<SupabaseClient, "from">,
  member: { role?: unknown; roles?: unknown } | null | undefined,
  uid: string,
  ticket: ScopedTicket,
): Promise<"in" | "out" | "unknown"> {
  if (!isContractorOnly(member)) return "in";
  if (ticket.requesterId === uid || ticket.assignedDrafterId === uid || ticket.assignedEngineerId === uid) return "in";
  if (Array.isArray(ticket.watchers) && ticket.watchers.includes(uid)) return "in";
  const { data, error } = await client
    .from("ticket_comments")
    .select("id")
    .eq("ticket_id", ticket.id)
    .contains("mentioned_uids", [uid])
    .is("deleted_at", null)
    .limit(1);
  if (error) return "unknown";
  return (data ?? []).length > 0 ? "in" : "out";
}
