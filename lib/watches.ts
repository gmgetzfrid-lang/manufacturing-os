// lib/watches.ts — the watch / follow list. TABLE: public.subscriptions
// (20260622, re-created idempotently in 20260723): one row per (user,
// resource_type, resource_id) a member follows. It is NOT billing — the org's
// billing state lives on the orgs row and is read by lib/billing.ts.
//
// Renamed from lib/subscriptions.ts (NEDGE-21, notifications Round G N15):
// the old name was one letter from the billing module (lib/subscription.ts,
// now lib/billing.ts), and that collision is how a restore came to skip this
// table as "billing state" (NEDGE-8).
//
// Generic watch/follow API. Used by WatchButton in the UI and by the
// notification fan-out helpers to find who to notify on an event.

import { supabase } from "@/lib/supabase";

export type WatchResourceType = "document" | "project" | "asset" | "library";

export interface SubscriptionRow {
  id: string;
  orgId: string;
  userId: string;
  resourceType: WatchResourceType;
  resourceId: string;
  createdAt: string;
}

export async function isWatching(
  resourceType: WatchResourceType,
  resourceId: string,
  userId: string,
): Promise<boolean> {
  const { data } = await supabase
    .from("subscriptions")
    .select("id")
    .eq("user_id", userId)
    .eq("resource_type", resourceType)
    .eq("resource_id", resourceId)
    .maybeSingle();
  return !!data;
}

export async function watch(input: {
  orgId: string;
  userId: string;
  resourceType: WatchResourceType;
  resourceId: string;
}): Promise<void> {
  await supabase.from("subscriptions").upsert({
    org_id: input.orgId,
    user_id: input.userId,
    resource_type: input.resourceType,
    resource_id: input.resourceId,
  }, { onConflict: "user_id,resource_type,resource_id" });
}

export async function unwatch(input: {
  userId: string;
  resourceType: WatchResourceType;
  resourceId: string;
}): Promise<void> {
  await supabase.from("subscriptions")
    .delete()
    .eq("user_id", input.userId)
    .eq("resource_type", input.resourceType)
    .eq("resource_id", input.resourceId);
}

export async function listFollowerIds(
  resourceType: WatchResourceType,
  resourceId: string,
): Promise<string[]> {
  const { data } = await supabase
    .from("subscriptions")
    .select("user_id")
    .eq("resource_type", resourceType)
    .eq("resource_id", resourceId);
  return ((data || []) as Array<{ user_id: string }>).map((r) => r.user_id);
}
