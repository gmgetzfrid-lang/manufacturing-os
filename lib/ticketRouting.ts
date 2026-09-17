// lib/ticketRouting.ts
//
// Routing layer for drafting requests. Answers the question "who
// should be told when a request lands in this status?"
//
// The model the user wants:
//
//   * Drafting requests should target a named role — DraftingSupervisor
//     — instead of being broadcast to every Admin in the workspace.
//   * Workspaces that haven't set up a DraftingSupervisor still need
//     SOMEONE to act, so we fall back to Admins.
//   * Assignment states target DraftingSupervisors; drafting states
//     target the specific drafter who was assigned. (The engineer
//     initial-review entry stage is gone — DEC-14.)
//
// This module is the single seam — every "who needs to know?" call
// from the requests flow should go through here so the policy stays
// in one file. WF-19: the workflow route calls it on every RE-entry
// into the assignment queue (engineering review complete), not only at
// creation — passing its own service-role client, because the shared
// browser client has no session inside a route handler.
//
// "Who is TOLD" (this file) is deliberately narrower than "who CAN act"
// (lib/workflow.ts): everyone routed here holds `ticket.assign` under the
// shipped defaults, but not every holder is pestered — Admins step aside
// once a DraftingSupervisor exists. lib/__tests__/sweepRoundE_A.test.ts
// pins that inclusion.

import { supabase } from "@/lib/supabase";
import type { OrgDraftingSettings, Role, TicketStatus } from "@/types/schema";
import { heldRoles } from "@/lib/roleHeld";

/** The client a caller may substitute for the shared browser client
 *  (server routes pass supabaseAdmin — the browser client has no session
 *  in a route handler, so under RLS it would resolve nobody). */
export type RoutingClient = Pick<typeof supabase, "from">;

interface MemberLite {
  uid: string;
  /** Headline (display). Authority is `roles`. */
  role: Role;
  /** ADD-1: every role held — headline plus additive; routing pools read this. */
  roles: Role[];
  name?: string | null;
  email?: string | null;
}

/** Pull every active member of an org along with their role + names.
 *  One round-trip; callers can then filter in-memory. */
export async function listActiveMembers(orgId: string, client: RoutingClient = supabase): Promise<MemberLite[]> {
  const { data, error } = await client
    .from("org_members")
    .select("uid, role, roles, display_name, email")
    .eq("org_id", orgId)
    .eq("status", "active");
  if (error) { console.warn("[ticketRouting] listActiveMembers failed:", error.message); return []; }
  return ((data ?? []) as Array<{ uid: string; role: string; roles?: string[] | null; display_name?: string | null; email?: string | null }>)
    .map((m) => ({ uid: m.uid, role: m.role as Role, roles: heldRoles(m) as Role[], name: m.display_name, email: m.email }));
}

/** Read the org's drafting routing policy from org_configurations. Defaults
 *  to "Admins step aside once a DraftingSupervisor exists" when unset. */
async function getRoutingConfig(
  orgId: string,
  client: RoutingClient = supabase,
): Promise<{ adminsAlsoReceiveWhenSupervisorSet: boolean }> {
  const { data } = await client
    .from("org_configurations")
    .select("data")
    .eq("org_id", orgId)
    .eq("key", "drafting")
    .maybeSingle();
  const routing = (data?.data as OrgDraftingSettings | undefined)?.routing;
  return { adminsAlsoReceiveWhenSupervisorSet: !!routing?.adminsAlsoReceiveWhenSupervisorSet };
}

/** Resolve the set of users who should be notified when a ticket
 *  enters a given status. Policy:
 *
 *  PENDING_ASSIGNMENT  → DraftingSupervisor + fallback Admin
 *  PENDING_DRAFTING    → caller passes assignee separately; nobody else
 *  PENDING_IFC         → DraftingSupervisor + originating engineer
 *  (everything else)   → nobody by default
 *
 *  Returns DEDUPED uids. Caller can exclude the actor before fanout
 *  with notifyMany's built-in actor filter.
 */
export async function resolveTicketRecipients(
  orgId: string,
  status: TicketStatus,
  actorUserId?: string,
  client: RoutingClient = supabase,
): Promise<MemberLite[]> {
  const [members, routing] = await Promise.all([
    listActiveMembers(orgId, client),
    getRoutingConfig(orgId, client),
  ]);
  // ADD-1: a role pool is everyone HOLDING the role, not everyone whose headline it is.
  const byRole = (r: Role) => members.filter((m) => m.roles.includes(r));
  const admins = byRole("Admin");

  // DraftingSupervisor-targeted states. With no supervisor in the org, Admins
  // are the fallback. Once a supervisor exists, Admins are normally dropped so
  // they aren't pestered with every request — unless the org toggled on
  // `adminsAlsoReceiveWhenSupervisorSet`, in which case both are notified.
  const supervisorTargeted = (): MemberLite[] => {
    const supervisors = byRole("DraftingSupervisor");
    if (supervisors.length === 0) return admins;
    return routing.adminsAlsoReceiveWhenSupervisorSet ? [...supervisors, ...admins] : supervisors;
  };

  let pool: MemberLite[] = [];
  switch (status) {
    case "PENDING_ASSIGNMENT":
    case "PENDING_IFC":
      pool = supervisorTargeted();
      break;
    default:
      pool = [];
  }

  // Dedup + drop actor.
  const seen = new Set<string>();
  return pool.filter((m) => {
    if (!m.uid || seen.has(m.uid)) return false;
    if (actorUserId && m.uid === actorUserId) return false;
    seen.add(m.uid);
    return true;
  });
}
