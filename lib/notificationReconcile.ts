// lib/notificationReconcile.ts
//
// Retiring a bell row whose condition is gone (notifications Round G, N4 —
// NEDGE-18, TRAIL-9, DEC-81 §2). A row is retired by MARKING it
// metadata.superseded_at — never read_at, which is the recipient's own act of
// opening it (drafting-flow EVID-13) — and the unread list and the badge count
// leave a superseded row out (lib/inAppNotifications.ts).
//
// The mark is written on the server: since 20261161 a recipient may change
// only read_at on their own row (trg_notifications_read_at_only), so the
// attention feed's browser-side mark was refused and a moot row kept its place
// in the unread window (NEDGE-18). The feed now sends the ids of its candidate
// rows to POST /api/notifications/reconcile, which re-checks each one against
// the database on the service role and marks only those whose condition is
// gone (lib/notificationReconcileServer.ts). The browser writes no metadata.
//
// This module is shared: the classification below is read by the feed (which
// rows to send) and by the route (which check each row gets). It imports no
// client (only the kind registry), so the route can use it too; the browser call is the one function
// at the end, which reads the session lazily.

import { kindMeta } from "@/lib/notificationKinds";
import { isTerminalTicketStatus } from "@/lib/ticketShed";

/** The conditions a row can be retired on. */
export type ReconcileClass =
  /** A ticket workflow alert ("the ticket is in state X — act"): retired once
   *  the ticket has left state X or is no longer live in the workspace. */
  | "workflow"
  /** hold_opened on a document: retired once the hold is released (TRAIL-9
   *  dw1). A hold_opened row about any other resource is never reconciled. */
  | "hold"
  /** branch_open: retired once the branch is resolved (TRAIL-9 dw2; the
   *  DocCtrl copies too — DEC-81 Risk). */
  | "branch"
  /** checkout_released, the maintenance cron's stale-checkout escalation to
   *  the controllers: retired once that checkout session has ended (DEC-81
   *  Risk — "clear a controller copy when its session ends"). */
  | "stale_checkout"
  /** ack_requested: retired once the recipient owes no acknowledgment on the
   *  document (DEC-81 §2 — the obligation is discharged). */
  | "ack"
  /** review_requested / review_invalidated: retired once the recipient owes
   *  no sign-off on the document's draft in review (DEC-81 §2) — and only a
   *  row the server can tie to a sign-off roster: the kind alone is not
   *  proof, because the check-in panel's "Change proposed to …" notice to a
   *  document's owner is a review_requested row with no roster behind it
   *  (components/documents/CheckInPanel.tsx). lib/notificationReconcileServer.ts
   *  keeps any row with no roster evidence (its actor must be the roster's
   *  opener at its assigned_at, under openReviewRoster's title; an actor-less
   *  row must carry the title of the one server writer that sends it with
   *  no actor — REVIEW_NOTICE_TITLES — and lie at the stamp that writer put on the recipient's roster row, a
   *  reminder at any time since that row was opened), and any row younger
   *  than REVIEW_RECONCILE_GRACE_MS (the voided-approval notice is written
   *  before the new roster is). A legacy intake notice (metadata.intake —
   *  filed under review_requested until 20261191 re-files it) is never
   *  reconciled: no roster stands behind it. */
  | "review"
  /** access_recert_due: retired once the library's recertification is no
   *  longer due (DEC-81 §2). */
  | "recert"
  /** ack_overdue, the escalation copy to the owner and controllers: retired
   *  once NOBODY owes an acknowledgment on the document any more (DEC-81 §2). */
  | "ack_escalation"
  /** review_overdue, the escalation copy to the owner and controllers: retired
   *  once the document has no draft in review (DEC-81 §2). NOT the
   *  maintenance cron's daily review-health nudge (metadata.reviewHealth /
   *  reviewHealthDay — lib/intakeRateLimit.ts nudgeReviewHealth): its example
   *  document is one whose draft is orphaned, so "no draft in review" is the
   *  condition it reports, never its discharge. That row stays until read. */
  | "review_escalation";

/** The columns of a notification row the classification reads. */
export interface ReconcilableRow {
  kind: string;
  resourceType: string | null;
  resourceId: string | null;
  metadata: Record<string, unknown> | null;
}

/** Which condition retires this row — or null: nothing retires it (it stays
 *  until its recipient reads it, as every row did before). */
export function reconcileClassOf(row: ReconcilableRow): ReconcileClass | null {
  const meta = row.metadata ?? null;
  // The workflow alert, exactly as the feed has always recognised it
  // (DF-P1): a resource, a recorded status, a recorded action.
  if (row.resourceId && meta && typeof meta.status === "string" && meta.action != null) return "workflow";
  switch (row.kind) {
    case "hold_opened":
      // The check reads document_holds by document id: a row about anything
      // but a document (a legacy row, another producer, a future
      // project-scoped hold) would read "no open hold" and be retired while
      // its hold still stands — so it is left alone (it stays until read).
      return row.resourceId && row.resourceType === "document" ? "hold" : null;
    case "branch_open":
      return meta && typeof meta.branchId === "string" && meta.branchId ? "branch" : null;
    case "checkout_released":
      return meta && typeof meta.staleSessionId === "string" && meta.staleSessionId ? "stale_checkout" : null;
    case "ack_requested":
      return row.resourceId && row.resourceType === "document" ? "ack" : null;
    case "review_requested":
    case "review_invalidated":
      // A legacy intake notice (a contractor submission awaiting review, filed
      // under review_requested before 20261191 re-filed it as intake_*) has no
      // sign-off roster behind it: owing no sign-off is not its discharge.
      if (meta && meta.intake != null) return null;
      return row.resourceId && row.resourceType === "document" ? "review" : null;
    case "access_recert_due":
      return row.resourceId && row.resourceType === "library" ? "recert" : null;
    case "ack_overdue":
      return row.resourceId && row.resourceType === "document" ? "ack_escalation" : null;
    case "review_overdue":
      // The review-health nudge reuses this kind; nothing on its example
      // document says it is resolved (it repeats daily until the counts are 0).
      if (meta && (meta.reviewHealth != null || meta.reviewHealthDay != null)) return null;
      return row.resourceId && row.resourceType === "document" ? "review_escalation" : null;
    default:
      return null;
  }
}

/** Whether a notification row asks its recipient to act — the ONE place
 *  the feed's counts, the badges and the toast read it (DEC-81 §2, DEC-90
 *  A11: no action flag that cannot clear). The kind decides
 *  (KIND_META.actionRequired), except for a row of an action kind that
 *  nothing clears: the maintenance cron's daily review-health nudge reuses
 *  review_overdue (metadata.reviewHealth / reviewHealthDay), and
 *  reconcileClassOf leaves it out, so it reads as FYI and stays until read.
 *  A legacy kind no union declares is FYI. */
export function isActionRow(row: { kind: string; metadata?: Record<string, unknown> | null }): boolean {
  if (!(kindMeta(row.kind)?.actionRequired ?? false)) return false;
  const meta = row.metadata ?? null;
  if (row.kind === "review_overdue" && meta && (meta.reviewHealth != null || meta.reviewHealthDay != null)) return false;
  return true;
}

/** The most ids one request may carry (the feed sends its loaded window's
 *  candidates first, then those among the rows below the window). */
export const RECONCILE_MAX_IDS = 200;

/** A review_requested / review_invalidated row younger than this is never
 *  retired: invalidateDraftSignoffs (lib/reviewControl.ts) tells a prior
 *  signer their approval was voided BEFORE the new draft's roster is written,
 *  so in that gap the recipient owes nothing yet and the notice would read
 *  "discharged". */
export const REVIEW_RECONCILE_GRACE_MS = 2 * 60_000;

/** How close the stamp a roster's writer put on the recipient's sign-off
 *  row (assigned_at for openReviewRoster, notified_at for the reminder scan,
 *  updated_at only on the row invalidateDraftSignoffs turned 'invalidated')
 *  must lie to a review row's created_at for the row to count as that
 *  roster's notice — with the notice's actor matching the roster's opener
 *  (lib/notificationReconcileServer.ts rosterWrote). An actor-less row
 *  must also carry its writer's title (REVIEW_NOTICE_TITLES); the cron's
 *  reminder needs only to be written no earlier than this before the
 *  recipient's roster row was opened (every reminder, not only the one
 *  whose notified_at is current). lib/reviewControl.ts stamps the roster row
 *  and writes the notice in the same call; the assigned_at of a
 *  browser-opened roster is the browser's clock, hence the margin. */
export const REVIEW_ROSTER_WINDOW_MS = 10 * 60_000;

/** The titles lib/reviewControl.ts gives the sign-off notices it writes —
 *  among them the only server writers of an actor-less review_requested /
 *  review_invalidated. rosterWrote (lib/notificationReconcileServer.ts) ties
 *  an actor-less row to a roster only when it carries its writer's title, so
 *  an actor-less row from any other source (a legacy intake notice, a future
 *  producer) is not treated as the roster's and stays until read. The census
 *  in lib/__tests__/notificationReconcile.test.ts pins these against the
 *  producer's source, so a retitled notice fails a test instead of silently
 *  ceasing to clear. */
export const REVIEW_NOTICE_TITLES = {
  /** openReviewRoster: with its actor (the roster's assigned_by), or with
   *  none (assigned_by null), at the roster row's assigned_at. The title is
   *  required of an actor-bearing notice too, so the check-in panel's
   *  "Change proposed to …" by the roster's own opener never matches. */
  roster: "Review requested: ",
  /** scanReviews, the cron's reminder: at the notified_at it stamps, or any
   *  time since the recipient's roster row was opened (every reminder). */
  reminder: "Reminder — review ",
  /** invalidateDraftSignoffs: at the updated_at of the row it turns 'invalidated'. */
  invalidated: "Re-review needed: ",
} as const;

/** Whether a ticket workflow alert is moot, given its ticket's live status
 *  (undefined: the ticket is not in the workspace, or not readable as the
 *  caller). An alert says "the ticket is in state X — act": it is moot once
 *  the ticket left X. An SLA notice ("Due soon" / "Overdue" — its
 *  metadata.action is in lib/ticketSla.ts SLA_NOTICE_ACTIONS, passed in by
 *  the caller so this module stays free of the routing client) says the
 *  request is LATE, which an open-to-open move does not change: only an exit
 *  (CLOSED / CANCELED) or the ticket's absence retires it — the workflow
 *  route's own supersede rule (drafting-flow DF-P3 fix pass 3, EDGE-7). Both
 *  the feed (which rows it hides and sends) and the server's check read
 *  this. */
export function workflowAlertGone(
  meta: Record<string, unknown> | null,
  liveStatus: string | undefined,
  slaNoticeActions: ReadonlySet<string>,
): boolean {
  if (liveStatus === undefined) return true;
  if (slaNoticeActions.has(String(meta?.action ?? ""))) return isTerminalTicketStatus(liveStatus);
  return liveStatus !== meta?.status;
}

/** How far a mark's superseded_at may lie from the browser's clock around
 *  the request and still be read as the reconcile pass's own (RT-8). A
 *  browser clock further off only costs a refetch — never a missed change. */
export const RECONCILE_MARK_SKEW_MS = 5 * 60_000;

/** The server's superseded_at: Date#toISOString (lib/notificationReconcileServer.ts). */
const MARK_STAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** A notification row as the feed held it when it sent it for reconcile. */
export interface HeldNotification {
  kind: string;
  resourceType: string | null;
  resourceId: string | null;
  metadata: Record<string, unknown> | null;
  title?: string;
  body?: string | null;
  link?: string | null;
  actorUserId?: string | null;
}

function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as object).filter((k) => (a as Record<string, unknown>)[k] !== undefined).sort();
  const kb = Object.keys(b as object).filter((k) => (b as Record<string, unknown>)[k] !== undefined).sort();
  if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false;
  return ka.every((k) => sameJson((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/** RT-8: whether a realtime UPDATE's new row differs from the row the feed
 *  held ONLY by the reconcile pass's own mark — read_at still null,
 *  metadata.superseded_at newly set to a server timestamp of the
 *  toISOString shape within RECONCILE_MARK_SKEW_MS of the request, and every
 *  other metadata key, and every column the feed held, unchanged. The
 *  workflow route's mark (it adds superseded_by), a recipient's mark-read
 *  (read_at) or any other edit is not — the feed refetches for those. A
 *  column the payload does not carry is not compared; read_at and metadata
 *  must be there. Answers false when nothing was held (fail-safe: a
 *  refetch). */
export function isReconcileMark(
  next: Record<string, unknown> | null | undefined,
  held: HeldNotification | undefined,
  window: { from: number; to: number },
): boolean {
  if (!next || !held) return false;
  if (!("read_at" in next) || next.read_at !== null) return false;
  const meta = next.metadata;
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return false;
  const { superseded_at: stamp, ...rest } = meta as Record<string, unknown>;
  if (typeof stamp !== "string" || !MARK_STAMP_RE.test(stamp)) return false;
  const at = Date.parse(stamp);
  if (!Number.isFinite(at) || at < window.from - RECONCILE_MARK_SKEW_MS || at > window.to + RECONCILE_MARK_SKEW_MS) return false;
  if (held.metadata && typeof held.metadata.superseded_at !== "undefined") return false;
  if (!sameJson(rest, held.metadata ?? {})) return false;
  const cols: Array<[string, unknown]> = [
    ["kind", held.kind], ["resource_type", held.resourceType], ["resource_id", held.resourceId],
    ["title", held.title], ["body", held.body], ["link", held.link], ["actor_user_id", held.actorUserId],
  ];
  for (const [col, was] of cols) {
    if (was === undefined || !(col in next)) continue;
    if ((next[col] ?? null) !== (was ?? null)) return false;
  }
  return true;
}

/** What the route answers. */
export interface ReconcileAnswer {
  /** The rows marked superseded by this call. */
  retired: string[];
  /** Rows checked and still live (kept unread). */
  kept: number;
  /** Rows whose mark was refused or whose check could not be read (kept). */
  failed: number;
}

/** Ask the server to retire the given rows of mine whose condition is gone.
 *  Answers the ids it retired — [] when it could not be asked (no session,
 *  offline, a route that is not deployed): nothing is retired then, and every
 *  row keeps showing, which is the fail-safe side. Never throws. */
export async function requestReconcile(orgId: string, ids: string[]): Promise<ReconcileAnswer | null> {
  if (!orgId || ids.length === 0) return { retired: [], kept: 0, failed: 0 };
  try {
    const { supabase } = await import("@/lib/supabase");
    const auth = (supabase as { auth?: { getSession?: () => Promise<{ data: { session: { access_token?: string } | null } }> } }).auth;
    if (!auth?.getSession) return null;
    const { data: { session } } = await auth.getSession();
    const token = session?.access_token;
    if (!token) return null;
    const res = await fetch("/api/notifications/reconcile", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ orgId, ids: ids.slice(0, RECONCILE_MAX_IDS) }),
    });
    if (!res.ok) {
      console.warn("[notifications] the reconcile pass was refused", res.status);
      return null;
    }
    const body = (await res.json()) as Partial<ReconcileAnswer>;
    return {
      retired: Array.isArray(body.retired) ? body.retired.filter((x): x is string => typeof x === "string") : [],
      kept: typeof body.kept === "number" ? body.kept : 0,
      failed: typeof body.failed === "number" ? body.failed : 0,
    };
  } catch (e) {
    console.warn("[notifications] the reconcile pass could not run", e);
    return null;
  }
}
