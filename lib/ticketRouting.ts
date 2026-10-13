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
//   * The ROUTED statuses — the ones whose waiting party is a POOL, not one
//     named person — are told on EVERY entry, not only at creation
//     (drafting-flow LEAK-1, Round G DF-P3):
//       PENDING_ASSIGNMENT          → the assignment queue's owners;
//       PENDING_IFC                 → the queue's owners (they chase the
//                                     issue) + the originating engineer;
//       REVISION_REQ with no drafter → the queue's owners (nobody else can
//                                     re-own it; DF-P3 makes the state
//                                     unreachable — a revision with no
//                                     drafter returns to PENDING_ASSIGNMENT
//                                     — and this is the backstop).
//     Every other waiting status names ONE person (the assigned drafter, the
//     assigned engineer, the requester), whom lib/ticketTransitions.ts puts
//     in the transition's own fan-out (`unread_by`). (The engineer
//     initial-review entry stage is gone — DEC-14.)
//
// This module is the single seam — every "who needs to know?" call
// from the requests flow should go through here so the policy stays
// in one file. Its callers: the three creation paths (the queue at birth),
// the workflow route on every ENTRY into a routed status
// (app/api/tickets/workflow-action/route.ts — passing its own service-role
// client, because the shared browser client has no session inside a route
// handler), and the SLA clock (lib/ticketSla.ts, one step of the maintenance
// cron), which reads the same pools through loadRoutingContext / routedPool /
// queuePool. Ticket FOLLOWERS (`tickets.watchers`) are folded in by the two
// ticket routes themselves (the transition's `unread_by`, the comment
// route's merge) — no ticket notice walks lib/notify's follower resolver.
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

type MemberRow = { uid: string; role: string; roles?: string[] | null; display_name?: string | null; email?: string | null };
const toLite = (m: MemberRow): MemberLite =>
  ({ uid: m.uid, role: m.role as Role, roles: heldRoles(m) as Role[], name: m.display_name, email: m.email });

/** Pull every active member of an org along with their role + names.
 *  One round-trip; callers can then filter in-memory. */
export async function listActiveMembers(orgId: string, client: RoutingClient = supabase): Promise<MemberLite[]> {
  const { data, error } = await client
    .from("org_members")
    .select("uid, role, roles, display_name, email")
    .eq("org_id", orgId)
    .eq("status", "active");
  if (error) { console.warn("[ticketRouting] listActiveMembers failed:", error.message); return []; }
  return ((data ?? []) as MemberRow[]).map(toLite);
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

/** An org's routing inputs, read once (the SLA scan reuses them across
 *  every ticket of the org). */
export interface RoutingContext {
  ok: true;
  members: MemberLite[];
  routing: { adminsAlsoReceiveWhenSupervisorSet: boolean };
}

/** Like listActiveMembers + the routing config, but a failed member read is
 *  REPORTED (ok: false), never an empty org — a caller that escalates must
 *  not read "nobody to tell" out of an outage. */
export async function loadRoutingContext(
  orgId: string, client: RoutingClient = supabase,
): Promise<RoutingContext | { ok: false; error: string }> {
  const { data, error } = await client
    .from("org_members")
    .select("uid, role, roles, display_name, email")
    .eq("org_id", orgId)
    .eq("status", "active");
  if (error) return { ok: false, error: error.message || "member read failed" };
  const routing = await getRoutingConfig(orgId, client);
  return { ok: true, members: ((data ?? []) as MemberRow[]).map(toLite), routing };
}

/** The ticket context a status's pool may need (PENDING_IFC names the
 *  originating engineer; REVISION_REQ routes only when nobody drafts it). */
export interface RoutingTicketContext {
  assignedDrafterId?: string | null;
  assignedEngineerId?: string | null;
}

/** The assignment queue's owners: DraftingSupervisor holders, falling back
 *  to Admins when the org has none. Once a supervisor exists, Admins are
 *  normally dropped so they aren't pestered with every request — unless the
 *  org toggled on `adminsAlsoReceiveWhenSupervisorSet`, in which case both
 *  are notified. Uids, deduped. */
export function queuePool(ctx: Pick<RoutingContext, "members" | "routing">): string[] {
  // ADD-1: a role pool is everyone HOLDING the role, not everyone whose headline it is.
  const byRole = (r: Role) => ctx.members.filter((m) => m.roles.includes(r));
  const admins = byRole("Admin");
  const supervisors = byRole("DraftingSupervisor");
  const pool = supervisors.length === 0 ? admins : ctx.routing.adminsAlsoReceiveWhenSupervisorSet ? [...supervisors, ...admins] : supervisors;
  return Array.from(new Set(pool.map((m) => m.uid).filter(Boolean)));
}

/** Whether entering `status` routes to a pool (see the header). */
export function isRoutedStatus(status: TicketStatus | string, ticket?: RoutingTicketContext): boolean {
  if (status === "PENDING_ASSIGNMENT" || status === "PENDING_IFC") return true;
  return status === "REVISION_REQ" && !ticket?.assignedDrafterId;
}

/** The pool `status` routes to, as uids (deduped, the actor dropped). Pure. */
export function routedPool(
  ctx: Pick<RoutingContext, "members" | "routing">,
  status: TicketStatus | string,
  actorUserId?: string,
  ticket?: RoutingTicketContext,
): string[] {
  let pool: string[] = [];
  switch (status) {
    case "PENDING_ASSIGNMENT":
      pool = queuePool(ctx);
      break;
    case "PENDING_IFC": {
      // The originating engineer joins when they are still an active member.
      const eng = ticket?.assignedEngineerId && ctx.members.some((m) => m.uid === ticket.assignedEngineerId)
        ? [ticket.assignedEngineerId] : [];
      pool = [...queuePool(ctx), ...eng];
      break;
    }
    case "REVISION_REQ":
      pool = ticket?.assignedDrafterId ? [] : queuePool(ctx);
      break;
    default:
      pool = [];
  }
  return Array.from(new Set(pool)).filter((u) => !!u && u !== actorUserId);
}

/** Resolve the set of users who should be notified when a ticket
 *  enters a given status. Policy:
 *
 *  PENDING_ASSIGNMENT          → DraftingSupervisor + fallback Admin
 *  PENDING_IFC                 → DraftingSupervisor (+ fallback Admin)
 *                                + the originating engineer (ticket.assignedEngineerId)
 *  REVISION_REQ, no drafter    → DraftingSupervisor + fallback Admin
 *  (everything else)           → nobody here: the transition names its one
 *                                waiting person itself (lib/ticketTransitions.ts)
 *
 *  Returns DEDUPED members, the actor excluded.
 */
export async function resolveTicketRecipients(
  orgId: string,
  status: TicketStatus,
  actorUserId?: string,
  client: RoutingClient = supabase,
  ticket?: RoutingTicketContext,
): Promise<MemberLite[]> {
  const [members, routing] = await Promise.all([
    listActiveMembers(orgId, client),
    getRoutingConfig(orgId, client),
  ]);
  const uids = routedPool({ members, routing }, status, actorUserId, ticket);
  const byUid = new Map(members.map((m) => [m.uid, m]));
  return uids.map((u) => byUid.get(u)).filter((m): m is MemberLite => !!m);
}
