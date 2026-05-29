// lib/subscriptions.ts
//
// Generic watch/follow API. Backed by the `subscriptions` table
// (20260622 migration). Used by WatchButton in the UI and by the
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
