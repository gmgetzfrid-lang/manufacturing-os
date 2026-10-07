// lib/inAppNotifications.ts
//
// Helpers for the in-app notification feed (bell icon). One row per
// (recipient, event) in the notifications table (see 20260621
// migration). Distinct from lib/notifications.ts which queues email
// delivery — many actions write to both.

import { supabase } from "@/lib/supabase";

// Every kind is classified — section, action, compliance, icon, group — in
// lib/notificationKinds.ts KIND_META; a kind added here without an entry there
// is a `tsc` error. A kind leaves this union only when nothing writes it:
// grep app/, lib/, components/ AND supabase/migrations (functions, triggers)
// first — ack_*, review_*, legal_hold_* are legally significant.
export type NotificationKind =
  | "ticket_comment"          // someone commented on a ticket the user is involved in
  | "ticket_mention"          // user was @-mentioned in a ticket comment
  | "ticket_status"           // ticket workflow advanced / closed / reopened
  | "ticket_assigned"         // user was assigned as drafter / engineer reviewer
  | "checkout_conflict"       // another user opened a checkout on a doc this user has open
  | "checkout_handoff"        // someone left a handoff note on a checkout the user is in
  | "checkout_message"        // chat-style message
  | "revision_published_over_checkout" // a publisher rev'd-up/superseded while you held the checkout (it stayed open)
  | "library_doc_added"       // subscribed library got new document(s)
  | "library_doc_revised"     // subscribed library had a document rev-up
  | "project_member"          // added / removed from a project
  | "project_status"          // project status changed
  | "project_comment"         // a comment on a project you're on / watching
  | "hold_opened"             // a hold was opened on a doc the user owns / is on the project for
  | "hold_released"           // a hold was released
  | "markup_request"          // a markup request on a document: you were asked for markups, or markups were shared to its thread
  | "doc_superseded"          // a doc the user has open was superseded
  | "checkout_released"       // the user's checkout was force-released / auto-expired
  | "overlap_advisory"        // two people hold live edit intents on the same doc
  | "branch_open"             // an unreconciled revision branch was opened
  | "branch_resolved"         // a revision branch was merged / withdrawn
  | "provenance_flag"         // your own publish landed without a work trail (private, gentle)
  // (task_overdue_digest, morning_digest, task_nudge, task_reminder were removed
  //  in notifications Round G, N2: the scratchpad that wrote them was deleted
  //  (CLEAN-2), and no producer anywhere — app, lib, components, scripts, SQL —
  //  writes them (PROD-8 / OS-7 / NEDGE-13). A legacy row of one still renders,
  //  bell-only.)
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
  | "effective_now"              // a revision with a future effective date is now in force
  | "retention_eligible"         // (to Admin/DocCtrl) a record has passed its retention and can be disposed
  | "legal_hold_placed"          // (to Admin/DocCtrl + owner) a legal hold was placed on a record
  | "legal_hold_released"        // (to Admin/DocCtrl + owner) a legal hold was released
  | "access_recert_due"          // (to owner/Admin/DocCtrl) a library's access needs recertification
  | "orchestrator_message"       // a colleague sent this via the document-controller assistant
  | "security_export"            // (to other Admins/DocCtrl) a full workspace export was run
  | "member_revoked"             // (to controllers) a member was suspended/removed; lists what became unowned (GAP-5)
  | "library_unowned"            // (to controllers) a library was created unowned through the Save-As door (OWN-22)
  | "storage_alert"              // (to Admin/DocCtrl) the workspace is over 70% / 90% of its set quota (lib/storageAlerts.ts)
  | "storage_platform_r2"        // (to Admin/DocCtrl) file storage is near the plan ceiling (lib/storageUsage.ts)
  | "storage_platform_db"        // (to Admin/DocCtrl) the database is near the plan ceiling (lib/storageUsage.ts)
  | "ai_cap_changed"             // a monthly AI spend cap was changed, put back or held (app/api/ai/usage/route.ts)
  | "change_order_status"        // a change order on a project you're on was proposed, approved or rejected (lib/changeOrders.ts — PROD-6)
  | "milestone_assigned"         // you were made responsible for a schedule task (lib/milestones.ts — PROD-11)
  | "milestone_slipped"          // (to the project owner) a move pushed baselined tasks past their baseline (lib/milestones.ts — PROD-11)
  | "access_request_pending"     // (to Admin/DocCtrl) someone asked to join the workspace (app/api/auth/request-access — PROD-2)
  | "transmittal_unstampable";   // (to the issuer) the portal refused to stamp an issued PDF (TRX-15, app/api/transmittal/route.ts)

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
  await notifyChecked(input);
}

/** A client to write the row with instead of the shared one: a service-role
 *  route's or the cron's (TAX-11 done-when 2 — a server writer that holds its
 *  own client takes the typed insert too, rather than a raw one). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type NotifyClient = { from: (table: string) => any };

/**
 * notify(), answering whether the row was written (true) or refused / threw
 * (false — logged, never re-raised). The same typed insert; for a caller that
 * counts deliveries (the storage watchdogs) and must count only real ones.
 * `client` (optional): write with that client — the shared one otherwise.
 */
export async function notifyChecked(input: NotificationInput, client?: NotifyClient): Promise<boolean> {
  return (await notifyWithReason(input, client)).ok;
}

/** notifyChecked(), answering the refusal's reason as well — for a server
 *  writer that logs it (the transmittal portal's issuer notice, TRX-15). */
export async function notifyWithReason(input: NotificationInput, client?: NotifyClient): Promise<{ ok: boolean; error?: string }> {
  try {
    const db: NotifyClient = client ?? supabase;
    const { error } = await db.from("notifications").insert(notificationRow(input));
    if (error) { console.warn("[notify] insert failed", error.message); return { ok: false, error: error.message }; }
    return { ok: true };
  } catch (e) {
    console.warn("[notify] insert threw", e);
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** The typed insert's row: one place maps a NotificationInput to the table. */
function notificationRow(input: NotificationInput): Record<string, unknown> {
  return {
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
  };
}

/**
 * notifyChecked() for many rows in ONE insert statement on the given client
 * (the shared one otherwise). Answers how many rows LANDED — 0 on a refusal
 * (logged, never re-raised). For a writer that tells many people at once
 * (the checkout sweep's holders, the export alert, the folded intake digest
 * — TAX-11): one statement, never an unbounded burst of single-row requests
 * whose failures would each be swallowed (N8's review fix).
 */
export async function notifyBatchChecked(inputs: NotificationInput[], client?: NotifyClient): Promise<number> {
  return (await notifyBatchWithReason(inputs, client)).landed;
}

/**
 * notifyBatchChecked(), answering the refusal's text as well — for a writer
 * that records it (the export alert's run diagnostics, the folded digest's
 * error). `landed` is the count the DATABASE answers for the statement
 * (`count: "exact"`), not the rows sent: a signed-in writer's row for a
 * recipient who is not an active member is skipped by the insert rail
 * (20261160 rule 5 — RETURN NULL, the statement still succeeds), and a
 * skipped row is not counted. The count rides the insert itself, never a
 * read-back: `.select()` after the insert is a RETURNING, which the own-rows
 * SELECT policy (20261161) refuses for a row addressed to someone else — the
 * browser sweep's whole statement would fail. A client that answers no count
 * (none does in production: PostgREST counts every insert asked to) is taken
 * at the statement's word — every row sent.
 */
export async function notifyBatchWithReason(inputs: NotificationInput[], client?: NotifyClient): Promise<{ landed: number; error?: string }> {
  if (inputs.length === 0) return { landed: 0 };
  try {
    const db: NotifyClient = client ?? supabase;
    const rows = inputs.map(notificationRow);
    const { error, count } = await db.from("notifications").insert(rows, { count: "exact" });
    if (error) { console.warn("[notify] batch insert failed", error.message); return { landed: 0, error: error.message }; }
    return { landed: typeof count === "number" ? count : rows.length };
  } catch (e) {
    console.warn("[notify] batch insert threw", e);
    return { landed: 0, error: e instanceof Error ? e.message : String(e) };
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
  // drafting-flow EVID-13: a workflow alert the ticket has moved past is
  // MARKED superseded by the workflow route (metadata.superseded_at) and keeps
  // read_at for the recipient's own act — so "unread" leaves superseded rows
  // out, or they would fill the bell's window and push live rows off it.
  if (opts?.onlyUnread) q = q.is("read_at", null).is("metadata->>superseded_at", null);
  const { data, error } = await q;
  if (error) throw error;
  return (data || []).map(rowToNotification);
}

export async function countUnread(orgId?: string | null): Promise<number> {
  let q = supabase
    .from("notifications")
    .select("*", { count: "exact", head: true })
    .is("read_at", null)
    .is("metadata->>superseded_at", null);
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

/** Mark every unread notification read. Pass the active workspace's orgId to
 *  clear only that workspace — without it, a user who belongs to several
 *  workspaces would clear the bell for all of them at once. */
export async function markAllRead(orgId?: string | null): Promise<void> {
  let q = supabase.from("notifications").update({ read_at: new Date().toISOString() }).is("read_at", null);
  if (orgId) q = q.eq("org_id", orgId);
  await q;
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
