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
  | "revision_published_over_checkout" // a publisher rev'd-up/superseded while you held the checkout (it stayed open)
  | "project_member"          // added / removed from a project
  | "project_status"          // project status changed
  | "hold_opened"             // a hold was opened on a doc the user owns / is on the project for
  | "hold_released"           // a hold was released
  | "markup_request"          // someone asked the user for markups
  | "doc_superseded"          // a doc the user has open was superseded
  | "task_overdue_digest"     // legacy digest — your scratchpad has overdue tasks
  | "morning_digest"          // composed daily digest: overdue + today + aging dateless
  | "task_nudge"              // someone sent you a scratchpad task as a heads-up
  | "request_pending_approval" // a new drafting request needs approval / assignment
  | "review_due"              // a controlled document is due (or overdue) for periodic review
  | "owner_assigned"          // you were made the owner of a document / folder / library
  | "owner_behind"            // (to Admin/DocCtrl) an owned document is overdue past the grace window
  | "deletion_requested"      // (to Admin/DocCtrl) an owner asked to delete a controlled document
  | "ack_requested"           // you must read & acknowledge an issued revision
  | "ack_complete"            // (to owner) every assignee has acknowledged a revision
  | "ack_overdue"             // (to owner/Admin/DocCtrl) an assignee is long overdue to acknowledge
  | "ack_unsatisfiable"       // (to owner/Admin/DocCtrl) an ack policy resolved to nobody / has gaps
  | "review_requested"        // you're asked to review & sign off an in-review draft before it publishes
  | "review_signed"           // (to owner/publisher) a reviewer signed off on the draft
  | "review_invalidated"      // the draft you approved changed — your sign-off was voided, please re-review
  | "review_complete"         // (to owner/publisher) all reviewers signed — the rev can publish
  | "review_overdue"          // (to owner/Admin/DocCtrl) a review sign-off is long overdue
  | "review_alternate_activated" // an alternate reviewer was activated (timeout / primary out)
  | "effective_now";             // a revision with a future effective date is now in force

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

export async function listMyNotifications(
  opts?: { limit?: number; onlyUnread?: boolean; orgId?: string | null },
): Promise<NotificationRow[]> {
  let q = supabase
    .from("notifications")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(opts?.limit ?? 50);
  // Scope to the active workspace. Without this the bell counts notifications
  // from EVERY org the user belongs to, so the badge can show items the
  // current workspace's portal will never list. RLS already restricts to the
  // user; this restricts to the workspace they're actually looking at.
  if (opts?.orgId) q = q.eq("org_id", opts.orgId);
  if (opts?.onlyUnread) q = q.is("read_at", null);
  const { data, error } = await q;
  if (error) throw error;
  return (data || []).map(rowToNotification);
}

export async function countUnread(orgId?: string | null): Promise<number> {
  let q = supabase
    .from("notifications")
    .select("*", { count: "exact", head: true })
    .is("read_at", null);
  if (orgId) q = q.eq("org_id", orgId);
  const { count, error } = await q;
  if (error) throw error;
  return count ?? 0;
}

export async function markRead(id: string): Promise<void> {
  await supabase.from("notifications").update({ read_at: new Date().toISOString() }).eq("id", id);
}

/** Mark several notification rows read in one round-trip. No-op for an empty
 *  list. Used by the attention hook to auto-clear stale workflow alerts. */
export async function markManyRead(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await supabase.from("notifications").update({ read_at: new Date().toISOString() }).in("id", ids);
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
