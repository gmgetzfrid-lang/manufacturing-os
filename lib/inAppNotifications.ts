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
  | "doc_superseded"          // a doc the user has open / follows was superseded: a new revision was published (one meaning since N9 — PROD-13 / TAX-13)
  | "doc_recalled"            // your downloaded copy of a document is out of date, or the document was retired — destroy old prints (lib/staleCopies.ts; was doc_superseded + metadata.recall)
  | "doc_retired"             // a document you WATCH was retired (superseded / voided / archived) — an FYI, not a recall: the copy holders get doc_recalled (lib/staleCopies.ts recallRetiredDocument — PROD-17, N15)
  | "doc_upstream_changed"    // a document connected to work you have checked out was revised (lib/revisionImpact.ts; was doc_superseded)
  | "package_doc_stale"       // a document pinned in your work package moved past its pin (lib/workPackages.ts; was doc_superseded + metadata.workPackageId)
  | "package_doc_retired"     // a document pinned in your work package was superseded / voided (lib/postPublish.ts; was doc_superseded + metadata.retirement)
  | "checkout_released"       // LEGACY rows only (TAX-17, N15): what the stale-checkout escalation was written as before N15 (20261206 re-files those rows); nothing writes it now
  | "checkout_stale_escalation" // (to Admin/DocCtrl) a checkout has been held for weeks — review it (the maintenance cron's stale-checkout escalation; was checkout_released — TAX-17)
  | "checkout_force_released" // your checkout was force-released by someone else (lib/checkoutEpisodes.ts; was checkout_released)
  | "checkout_force_released_fyi" // a document you WATCH was force-released — the watchers' FYI beside the holder's notice (lib/checkoutEpisodes.ts — PROD-17, N15)
  | "checkout_auto_released"  // your ad-hoc checkout expired and was released automatically (lib/projects.ts; was checkout_released + metadata.autoReleasedSessionId)
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
  | "review_requested"        // you're asked to review & sign off an in-review draft before it publishes (one meaning since N9: the intake notices have their own kinds)
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
  | "intake_quote"               // a contractor submitted a quote through a project's intake link (app/api/intake/upload/route.ts; was review_requested — DEC-90 A13)
  | "intake_submission"          // a contractor submission awaits review, or the intake digest of folded submissions (app/api/intake/upload/route.ts, lib/intakeRateLimit.ts; was review_requested — DEC-90 A13)
  | "transmittal_issued"         // a controlled copy of a document you own / a library you follow was issued to an outside party (lib/transmittals.ts — PROD-12)
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
  /** document-control DIST-20 (P39): the row's id, chosen by the writer
   *  (newNotificationId) so it knows which bell row its notice landed as —
   *  the notice record names it (document_notice_events.notification_id).
   *  Optional and additive: a writer that leaves it out gets the column's
   *  default, exactly as before. A retry of the same input never writes a
   *  second copy: the primary key refuses it, and that refusal is the row
   *  already there (notifyWithReason). */
  id?: string;
}

/** A fresh id for a bell row (DIST-20): a v4 UUID from the platform's
 *  crypto (Node 18+ and every browser), from Math.random only where none is
 *  present. */
export function newNotificationId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    return (ch === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/**
 * Insert one notification row. Fire-and-forget by design — callers
 * shouldn't block their main flow on the bell-icon write. Errors are
 * logged but never re-raised: a failed signal never rolls back the action
 * it reports (lib/postPublish.ts). It answers whether the row was written
 * (DELIV-7 dw1, notifications Round G N6), so a caller that carries an
 * obligation can say so; a caller that ignores the answer is unchanged.
 */
export async function notify(input: NotificationInput): Promise<boolean> {
  return notifyChecked(input);
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

/**
 * document-control DIST-20 (P39): notifyChecked(), answering the id of the
 * bell row that landed (null when it did not) — the row is written under
 * `input.id`, or under a fresh id (newNotificationId) when the input names
 * none. Additive: notifyChecked() and every caller of it are unchanged.
 */
export async function notifyCheckedId(input: NotificationInput, client?: NotifyClient): Promise<string | null> {
  const r = await notifyWithReason({ ...input, id: input.id ?? newNotificationId() }, client);
  return r.ok ? r.id ?? null : null;
}

/** notifyChecked(), answering the refusal's reason as well — for a server
 *  writer that logs it (the transmittal portal's issuer notice, TRX-15).
 *  DIST-20 (P39): when the input names its row's `id`, a landed answer
 *  carries it back (`id`), and a primary-key refusal of THAT id
 *  (23505 on notifications_pkey) is the row an earlier attempt already
 *  wrote — answered as landed, never a second copy and never a false
 *  dead letter. Without an `id` nothing differs from before. */
export async function notifyWithReason(input: NotificationInput, client?: NotifyClient): Promise<{ ok: boolean; error?: string; id?: string }> {
  try {
    const db: NotifyClient = client ?? supabase;
    const { error } = await db.from("notifications").insert(notificationRow(input));
    if (error) {
      const code = String((error as { code?: unknown }).code ?? "");
      if (input.id && code === "23505" && /notifications_pkey/.test(String(error.message ?? ""))) return { ok: true, id: input.id };
      console.warn("[notify] insert failed", error.message);
      return { ok: false, error: error.message };
    }
    return input.id ? { ok: true, id: input.id } : { ok: true };
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
    // DIST-20 (P39): the writer's own id for the row, only when it names one
    ...(input.id ? { id: input.id } : {}),
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
 * myself), dedupes recipients, and parallelises the inserts. Answers how
 * many rows landed and how many were refused (DELIV-7 dw1) — never throws.
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
}): Promise<{ sent: number; failed: number }> {
  const recipients = Array.from(new Set(
    input.userIds.filter((u) => u && u !== input.actorUserId),
  ));
  if (recipients.length === 0) return { sent: 0, failed: 0 };
  const landed = await Promise.all(
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
  const sent = landed.filter(Boolean).length;
  return { sent, failed: landed.length - sent };
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

/** The bell's page size: the attention feed loads the newest this many
 *  unread rows, then older pages on request (TAX-6 / DELIV-10). */
export const NOTIFICATION_PAGE_SIZE = 50;

/** A position in a newest-first notification list: the (created_at, id) of
 *  its last row. Rows written in one statement share created_at (now()), so
 *  created_at alone is not a unique position — the id breaks the tie. */
export interface NotificationCursor { createdAt: string; id: string }

/** The PostgREST filter for "strictly after `c` in (created_at desc, id desc)
 *  order": created_at < c, or the same created_at and a smaller id. Values are
 *  double-quoted — a timestamp carries '.' and ':' — and an embedded quote is
 *  escaped. */
function afterCursorFilter(c: NotificationCursor): string {
  const v = (x: string) => `"${x.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  return `created_at.lt.${v(c.createdAt)},and(created_at.eq.${v(c.createdAt)},id.lt.${v(c.id)})`;
}

export async function listMyNotifications(
  opts?: {
    limit?: number;
    onlyUnread?: boolean;
    orgId?: string | null;
    /** Only rows after this position, newest first — the next page after a
     *  page whose oldest row is the cursor (TAX-6 dw2, DELIV-10 dw2). A bare
     *  created_at string is read as "created strictly before it" (a row that
     *  shares it is skipped — pass the composite cursor). */
    before?: NotificationCursor | string | null;
  },
): Promise<NotificationRow[]> {
  let q = supabase
    .from("notifications")
    .select("*")
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(opts?.limit ?? NOTIFICATION_PAGE_SIZE);
  if (typeof opts?.before === "string" && opts.before) q = q.lt("created_at", opts.before);
  else if (opts?.before && typeof opts.before === "object") q = q.or(afterCursorFilter(opts.before));
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

/** The badge's number (PROD-7 dw1, TAX-6 dw1, TRAIL-7 dw1, DELIV-10 dw1): an
 *  exact head count of my unread, unsuperseded rows in the workspace —
 *  independent of how many rows the feed has loaded. */
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

/** One unread row below the feed's loaded window: enough to tally it into
 *  its section and the action count, and to send it for reconcile. */
export interface UnreadBeyondRow {
  id: string;
  kind: string;
  resourceType: string | null;
  resourceId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

/** My unread rows BEYOND the rows the feed loaded — newest first, after the
 *  loaded window's last row (`after`, the same (created_at, id) keyset the
 *  pages use, so no row lands in both the window and the tally), at most
 *  `cap` — so the per-section badges and the action count include the rows
 *  below the page (TAX-6 dw1, TRAIL-7 dw1) without loading them, and the
 *  reconcile pass can check the action rows among them. `after` null reads
 *  from the top. Throws on a refused read. */
export async function listUnreadKindsBeyond(
  orgId: string, after: NotificationCursor | null, cap: number,
): Promise<UnreadBeyondRow[]> {
  let q = supabase
    .from("notifications")
    .select("id, kind, resource_type, resource_id, metadata, created_at")
    .eq("org_id", orgId)
    .is("read_at", null)
    .is("metadata->>superseded_at", null);
  if (after) q = q.or(afterCursorFilter(after));
  const { data, error } = await q
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(Math.max(0, cap));
  if (error) throw error;
  return ((data as Array<Record<string, unknown>> | null) ?? []).map((r) => ({
    id: r.id as string,
    kind: r.kind as string,
    resourceType: (r.resource_type as string | null) ?? null,
    resourceId: (r.resource_id as string | null) ?? null,
    metadata: (r.metadata as Record<string, unknown> | null) ?? null,
    createdAt: r.created_at as string,
  }));
}

// The three "mark read" writes are CHECKED (notifications Round G, N11 — the
// N3 → N4 hand-off; SAF-18): each reads `{ error }` and throws on a refusal,
// so a refused update (a session that lapsed, a rail that refused the row)
// is never reported as done. markRead / markManyRead also read back the rows
// the update reached (the recipient's own rows — the read policy allows the
// RETURNING) and treat a row it did not reach as a refusal: row-level
// security filters a refused update to zero rows with no error. markAllRead
// cannot: "nothing was unread" is a legitimate zero. The attention hook
// catches a row's refusal and says it (status.markError); "Mark all read"
// callers catch and say it too.

/** What a refused mark-read throws. */
function markReadRefused(error: { message?: string }): Error {
  return new Error(`Marking read was refused: ${error.message ?? "unknown error"}`);
}

export async function markRead(id: string): Promise<void> {
  const { data: hit, error } = await supabase.from("notifications").update({ read_at: new Date().toISOString() }).eq("id", id).select("id");
  if (error) throw markReadRefused(error);
  if (!hit || hit.length === 0) throw markReadRefused({ message: "the notification was not marked (not yours, or no longer there)" });
}

/** Mark several notification rows read in one round-trip. No-op for an empty
 *  list. Throws on a refusal, or when the update reached fewer rows than
 *  were asked. */
export async function markManyRead(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const { data: hit, error } = await supabase.from("notifications").update({ read_at: new Date().toISOString() }).in("id", ids).select("id");
  if (error) throw markReadRefused(error);
  if (!hit || hit.length < new Set(ids).size) throw markReadRefused({ message: `${(hit ?? []).length} of ${new Set(ids).size} notifications were marked` });
}

/** Mark every unread notification read. Pass the active workspace's orgId to
 *  clear only that workspace — without it, a user who belongs to several
 *  workspaces would clear the bell for all of them at once. Throws on a
 *  refusal. */
export async function markAllRead(orgId?: string | null): Promise<void> {
  let q = supabase.from("notifications").update({ read_at: new Date().toISOString() }).is("read_at", null);
  if (orgId) q = q.eq("org_id", orgId);
  const { error } = await q;
  if (error) throw markReadRefused(error);
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
