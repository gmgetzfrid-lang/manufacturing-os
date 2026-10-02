// lib/notify/recipients.ts
//
// Unified recipient resolution for the notification dispatcher. This is the
// single place that turns "who should hear about this" into a list of user
// ids, folding together EVERY follow/subscribe mechanism in the app:
//   • generic subscriptions table (documents / projects / assets / libraries / tickets)
//   • tickets.watchers array (back-compat, read through the same path)
//   • role pools (additive roles[])
//   • project membership (implicit follow)
//
// This finally powers the fan-out the subscriptions table was built for — the
// `listFollowerIds` that was previously dead.
//
// Membership (NEDGE-3, notifications Round G N5): only an ACTIVE member of
// the event's org is a recipient. The role pool always asked for status =
// 'active'; the follow stores and the project roster did not, so a suspended
// member, a restore's 'inactive' placeholder or a removed member kept every
// watch. dispatch.ts resolveRecipients filters the final set once, centrally
// (activeMembersOf); resolveFollowers applies the same filter itself as a
// defence in depth, for any caller that reads followers directly.

import { supabase } from "@/lib/supabase";

export type ResourceType = "ticket" | "document" | "project" | "asset" | "library";
export interface ResourceRef {
  type: ResourceType;
  id: string;
}

/** How many uids one membership read carries (a long `in.(…)` list is a
 *  long URL; the DIST-15 precedent chunks it). */
const MEMBERSHIP_CHUNK = 150;

/** The subset of `uids` that are ACTIVE members of `orgId`, in input order
 *  (NEDGE-3). Not a member of the org, suspended, invited or inactive: out.
 *  A read that FAILS keeps the input unchanged and logs: a transient error
 *  must never silently drop a compliance notice, and the database refuses a
 *  browser's row for a non-member anyway (20261160) while the read policy
 *  hides it from one (20261161). */
export async function activeMembersOf(orgId: string, uids: string[]): Promise<string[]> {
  const want = Array.from(new Set(uids.filter(Boolean)));
  if (!orgId || want.length === 0) return [];
  const active = new Set<string>();
  for (let i = 0; i < want.length; i += MEMBERSHIP_CHUNK) {
    const { data, error } = await supabase
      .from("org_members")
      .select("uid")
      .eq("org_id", orgId)
      .eq("status", "active")
      .in("uid", want.slice(i, i + MEMBERSHIP_CHUNK));
    if (error) {
      console.warn("[notify] active-membership read failed — recipients not filtered", error.message);
      return want;
    }
    ((data as Array<{ uid: string }> | null) ?? []).forEach((m) => active.add(m.uid));
  }
  return want.filter((u) => active.has(u));
}

/** Everyone following a resource: generic subscriptions ∪ (tickets) watchers,
 *  limited to active members of `orgId`. */
export async function resolveFollowers(resource: ResourceRef, orgId: string): Promise<string[]> {
  const ids = new Set<string>();

  const { data: subs } = await supabase
    .from("subscriptions")
    .select("user_id")
    .eq("resource_type", resource.type)
    .eq("resource_id", resource.id);
  ((subs as Array<{ user_id: string }> | null) ?? []).forEach((r) => ids.add(r.user_id));

  // Tickets carry their own watchers array; read it through the same resolver
  // so the two follow stores look like one to every caller.
  if (resource.type === "ticket") {
    const { data: t } = await supabase
      .from("tickets")
      .select("watchers")
      .eq("id", resource.id)
      .maybeSingle();
    ((t?.watchers as string[] | null) ?? []).forEach((u) => ids.add(u));
  }

  return activeMembersOf(orgId, Array.from(ids));
}

/** Active org members whose role — headline OR additive collection — is in `roles`. */
export async function resolveRoleRecipients(orgId: string, roles: string[]): Promise<string[]> {
  if (!orgId || roles.length === 0) return [];
  const { data } = await supabase
    .from("org_members")
    .select("uid, role, roles")
    .eq("org_id", orgId)
    .eq("status", "active");
  const want = new Set(roles);
  const out = new Set<string>();
  ((data as Array<{ uid: string; role: string | null; roles: string[] | null }> | null) ?? []).forEach((m) => {
    const held = m.roles && m.roles.length > 0 ? m.roles : m.role ? [m.role] : [];
    if (held.some((r) => want.has(r))) out.add(m.uid);
  });
  return Array.from(out);
}

/** Members of a project — implicit followers of project-scoped events. */
export async function resolveProjectMembers(projectId: string): Promise<string[]> {
  if (!projectId) return [];
  const { data } = await supabase
    .from("project_members")
    .select("user_id")
    .eq("project_id", projectId);
  return ((data as Array<{ user_id: string }> | null) ?? []).map((r) => r.user_id);
}
