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
   *  opener, or none, and its time the stamp that writer put on the
   *  recipient's roster row — for an actor-less review_requested, any time
   *  since that row was opened), and any row younger than
   *  REVIEW_RECONCILE_GRACE_MS (the voided-approval notice is written before
   *  the new roster is). */
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
 *  (lib/notificationReconcileServer.ts rosterWrote). An actor-less
 *  review_requested needs only to be written no earlier than this before
 *  the recipient's roster row was opened (every reminder, not only the one
 *  whose notified_at is current). lib/reviewControl.ts stamps the roster row
 *  and writes the notice in the same call; the assigned_at of a
 *  browser-opened roster is the browser's clock, hence the margin. */
export const REVIEW_ROSTER_WINDOW_MS = 10 * 60_000;

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
