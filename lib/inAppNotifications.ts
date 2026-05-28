// lib/inAppNotifications.ts
//
// Helpers for the in-app notification feed (bell icon). One row per
// (recipient, event) in the notifications table (see 20260621
// migration). Distinct from lib/notifications.ts which queues email
// delivery — many actions write to both.

import { supabase } from "@/lib/supabase";

export type NotificationKind =
  | "ticket_comment"          // someone commented on a ticket the user is involved in
  | "ticket_mention"          // user was @-mentioned in a ticket comment
  | "ticket_status"           // ticket workflow advanced / closed / reopened
  | "ticket_assigned"         // user was assigned as drafter / engineer reviewer
  | "checkout_conflict"       // another user opened a checkout on a doc this user has open
  | "checkout_handoff"        // someone left a handoff note on a checkout the user is in
  | "checkout_message"        // chat-style message
  | "project_member"          // added / removed from a project
  | "project_status"          // project status changed
  | "hold_opened"             // a hold was opened on a doc the user owns / is on the project for
  | "hold_released"           // a hold was released
  | "markup_request"          // someone asked the user for markups
  | "doc_superseded";         // a doc the user has open was superseded

export interface NotificationInput {
  orgId: string;
  userId: string;             // recipient
  kind: NotificationKind;
  title: string;
  body?: string;
  link?: string;              // app-relative href to open the resource
  resourceType?: string;
  resourceId?: string;
  actorUserId?: string;
  actorName?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Insert one notification row. Fire-and-forget by design — callers
 * shouldn't block their main flow on the bell-icon write. Errors are
 * logged but never re-raised.
 */
export async function notify(input: NotificationInput): Promise<void> {
  try {
    const { error } = await supabase.from("notifications").insert({
      org_id: input.orgId,
      user_id: input.userId,
      kind: input.kind,
      title: input.title,
      body: input.body ?? null,
      link: input.link ?? null,
      resource_type: input.resourceType ?? null,
      resource_id: input.resourceId ?? null,
      actor_user_id: input.actorUserId ?? null,
      actor_name: input.actorName ?? null,
      metadata: input.metadata ?? null,
    });
    if (error) console.warn("[notify] insert failed", error.message);
  } catch (e) {
    console.warn("[notify] insert threw", e);
  }
}

/**
 * Fan-out helper. Skips the actor automatically (so I don't notify
 * myself), dedupes recipients, and parallelises the inserts.
 */
export async function notifyMany(input: {
  orgId: string;
  userIds: string[];
  actorUserId?: string;
  kind: NotificationKind;
  title: string;
  body?: string;
  link?: string;
  resourceType?: string;
  resourceId?: string;
  actorName?: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const recipients = Array.from(new Set(
    input.userIds.filter((u) => u && u !== input.actorUserId),
  ));
  if (recipients.length === 0) return;
  await Promise.all(
    recipients.map((uid) =>
      notify({
        orgId: input.orgId,
        userId: uid,
        kind: input.kind,
        title: input.title,
        body: input.body,
        link: input.link,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        actorUserId: input.actorUserId,
        actorName: input.actorName,
        metadata: input.metadata,
      }),
    ),
  );
}

export interface NotificationRow {
  id: string;
  orgId: string;
  userId: string;
  kind: NotificationKind;
  title: string;
  body: string | null;
  link: string | null;
  resourceType: string | null;
  resourceId: string | null;
  actorUserId: string | null;
  actorName: string | null;
  metadata: Record<string, unknown> | null;
  readAt: string | null;
  createdAt: string;
}

export async function listMyNotifications(opts?: { limit?: number; onlyUnread?: boolean }): Promise<NotificationRow[]> {
  let q = supabase
    .from("notifications")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(opts?.limit ?? 50);
  if (opts?.onlyUnread) q = q.is("read_at", null);
  const { data, error } = await q;
  if (error) throw error;
  return (data || []).map(rowToNotification);
}

export async function countUnread(): Promise<number> {
  const { count, error } = await supabase
    .from("notifications")
    .select("*", { count: "exact", head: true })
    .is("read_at", null);
  if (error) throw error;
  return count ?? 0;
}

export async function markRead(id: string): Promise<void> {
  await supabase.from("notifications").update({ read_at: new Date().toISOString() }).eq("id", id);
}

export async function markAllRead(): Promise<void> {
  await supabase.from("notifications").update({ read_at: new Date().toISOString() }).is("read_at", null);
}

function rowToNotification(r: Record<string, unknown>): NotificationRow {
  return {
    id: r.id as string,
    orgId: r.org_id as string,
    userId: r.user_id as string,
    kind: r.kind as NotificationKind,
    title: r.title as string,
    body: (r.body as string | null) ?? null,
    link: (r.link as string | null) ?? null,
    resourceType: (r.resource_type as string | null) ?? null,
    resourceId: (r.resource_id as string | null) ?? null,
    actorUserId: (r.actor_user_id as string | null) ?? null,
    actorName: (r.actor_name as string | null) ?? null,
    metadata: (r.metadata as Record<string, unknown> | null) ?? null,
    readAt: (r.read_at as string | null) ?? null,
    createdAt: r.created_at as string,
  };
}
