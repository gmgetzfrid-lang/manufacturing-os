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

import { supabase } from "@/lib/supabase";

export type ResourceType = "ticket" | "document" | "project" | "asset" | "library";
export interface ResourceRef {
  type: ResourceType;
  id: string;
}

/** Everyone following a resource: generic subscriptions ∪ (tickets) watchers. */
export async function resolveFollowers(resource: ResourceRef): Promise<string[]> {
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

  return Array.from(ids);
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
