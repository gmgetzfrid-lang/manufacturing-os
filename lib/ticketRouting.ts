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
//   * Engineer initial-review states target engineers; assignment
//     states target DraftingSupervisors; drafting states target the
//     specific drafter who was assigned.
//
// This module is the single seam — every "who needs to know?" call
// from the requests flow should go through here so the policy stays
// in one file.

import { supabase } from "@/lib/supabase";
import type { OrgDraftingSettings, Role, TicketStatus } from "@/types/schema";

interface MemberLite {
  uid: string;
  role: Role;
  name?: string | null;
  email?: string | null;
}

/** Pull every active member of an org along with their role + names.
 *  One round-trip; callers can then filter in-memory. */
export async function listActiveMembers(orgId: string): Promise<MemberLite[]> {
  const { data, error } = await supabase
    .from("org_members")
    .select("uid, role, name, email")
    .eq("org_id", orgId)
    .eq("status", "active");
  if (error) return [];
  return ((data ?? []) as Array<{ uid: string; role: string; name?: string | null; email?: string | null }>)
    .map((m) => ({ uid: m.uid, role: m.role as Role, name: m.name, email: m.email }));
}

/** Read the org's drafting routing policy from org_configurations. Defaults
 *  to "Admins step aside once a DraftingSupervisor exists" when unset. */
async function getRoutingConfig(
  orgId: string,
): Promise<{ adminsAlsoReceiveWhenSupervisorSet: boolean }> {
  const { data } = await supabase
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
 *  PENDING_ENG_INITIAL → engineers (any Engineer-N) + fallback Admin
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
): Promise<MemberLite[]> {
  const [members, routing] = await Promise.all([
    listActiveMembers(orgId),
    getRoutingConfig(orgId),
  ]);
  const byRole = (r: Role) => members.filter((m) => m.role === r);
  const engineerRoles: Role[] = ["Engineer-1", "Engineer-2", "Engineer-3", "Engineer-4"];
  const admins = byRole("Admin");

  const fallbackToAdmins = (primary: MemberLite[]): MemberLite[] =>
    primary.length > 0 ? primary : admins;

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
    case "PENDING_ENG_INITIAL":
      pool = fallbackToAdmins(members.filter((m) => engineerRoles.includes(m.role)));
      break;
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
