// lib/notificationReconcileServer.ts
//
// The server half of the attention feed's reconcile pass (notifications
// Round G, N4 — NEDGE-18, TRAIL-9, DEC-81 §2). Server-only: it runs on the
// service-role client POST /api/notifications/reconcile hands it, after the
// route has verified the caller and their active membership of the org.
//
// For each id the feed sent, it reads the row back as the CALLER's own,
// unread, not yet superseded row in that org — anything else is ignored — and
// re-checks the row's condition against the database (lib/notificationReconcile.ts
// reconcileClassOf names the check). A row is retired only when its check
// reads, and reads "gone"; a check that cannot be read keeps the row (a failed
// read proves nothing — the DF-P1 rule). Retiring writes ONE thing:
// metadata.superseded_at, guarded on the row still being the caller's, unread
// and unsuperseded; read_at is never touched (EVID-13). The service role
// passes trg_notifications_read_at_only (20261161), so the mark lands before
// and after that paste.
//
// What "gone" means, per class (every read scoped to the org):
//   workflow       the ticket's status is no longer the alert's recorded
//                  status, or the ticket is not in the workspace any more;
//                  an SLA notice (lib/ticketSla.ts SLA_NOTICE_ACTIONS) only
//                  once the ticket is CLOSED / CANCELED or gone
//                  (workflowAlertGone — DF-P3 fix pass 3, EDGE-7)
//   hold           a hold_opened row on a document: no open hold on it (an aging
//                  nudge, metadata.staleHoldId: that hold is released)
//   branch         the branch (metadata.branchId) is resolved
//   stale_checkout the escalated session (metadata.staleSessionId) has ended
//   ack            the recipient has no pending acknowledgment on the
//                  document — neither a read-&-understood roster row
//                  (document_acknowledgments, status 'pending') nor a
//                  distribution confirmation that still binds (unacknowledged,
//                  for the document's current version, the document not
//                  retired — lib/distributionAcks.ts ackStillBinds' rule)
//   review         the recipient has no pending sign-off on the document's
//                  draft in review (document_review_signoffs 'pending' for
//                  documents.pending_version_id) — checked only for a row
//                  the roster provably wrote (rosterWrote below), tying the
//                  notice's actor to the roster's and its time to the stamp
//                  the writer put on the recipient's roster row in the same
//                  call: openReviewRoster (its title; actor = the roster's
//                  assigned_by, at its assigned_at; with no actor, at the
//                  assigned_at of a row opened by nobody), the reminder scan
//                  (no actor, its title, at the notified_at it stamps after
//                  the notice — or, for every earlier reminder, any time
//                  after the recipient's roster row was opened) and
//                  invalidateDraftSignoffs (no actor, its title, on the row
//                  it turns 'invalidated'); an actor-less row with any other
//                  title (a legacy intake notice) is not the roster's.
//                  updated_at is never evidence on a live row
//                  — every sign-off and alternate activation moves it. A row
//                  with no such evidence — the check-in panel's "Change
//                  proposed to …" notice, whose actor is the person checking
//                  in — is kept, as is any row younger than
//                  REVIEW_RECONCILE_GRACE_MS (a voided approval's notice
//                  precedes the new draft's roster).
//   recert         the library's next recertification is no longer due
//                  (lib/accessRecert.ts recertStatusFor: 'current' or 'none')
//   ack_escalation an ack_overdue copy: NOBODY owes an acknowledgment on the
//                  document any more (no pending roster row, no binding
//                  distribution confirmation, whoever the assignee)
//   review_escalation a review_overdue copy: the document has no draft in
//                  review (documents.pending_version_id is null); never the
//                  cron's review-health nudge (reconcileClassOf leaves it out)

import {
  reconcileClassOf, workflowAlertGone, RECONCILE_MAX_IDS, REVIEW_NOTICE_TITLES, REVIEW_RECONCILE_GRACE_MS,
  REVIEW_ROSTER_WINDOW_MS, type ReconcileAnswer, type ReconcileClass,
} from "@/lib/notificationReconcile";
import { recertStatusFor } from "@/lib/accessRecert";
import { SLA_NOTICE_ACTIONS } from "@/lib/ticketSla";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ReconcileDb = { from: (table: string) => any };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (s: unknown): s is string => typeof s === "string" && UUID_RE.test(s);

interface Row {
  id: string;
  kind: string;
  resource_type: string | null;
  resource_id: string | null;
  metadata: Record<string, unknown> | null;
  created_at?: string | null;
  actor_user_id?: string | null;
  title?: string | null;
}

/** A recipient's sign-off roster row, as the review check reads it. */
export interface RosterStamp {
  status: string | null;
  assigned_by: string | null;
  assigned_at: string | null;
  notified_at: string | null;
  updated_at: string | null;
}

const ms = (t: string | null | undefined) => (t ? Date.parse(t) : NaN);
const near = (t: string | null | undefined, created: number) => {
  const at = ms(t);
  return Number.isFinite(at) && Math.abs(at - created) <= REVIEW_ROSTER_WINDOW_MS;
};

/** Whether a review_requested / review_invalidated row is provably the
 *  notice a sign-off roster's writer sent (lib/reviewControl.ts), from the
 *  recipient's roster rows on that document:
 *    * a notice WITH an actor: openReviewRoster's — a review_requested
 *      under its title ("Review requested: …"), whose actor opened the
 *      roster (assigned_by), written at its assigned_at. The check-in
 *      panel's notice ("Change proposed to …") never matches — not even
 *      when the person checking in is the roster's opener, within minutes
 *      of opening it (fourth review fix: the title closes the one shape the
 *      actor-and-time rule left open);
 *    * a notice with NO actor is the roster's only when it is the known
 *      server writer's for its kind — it carries that writer's title
 *      (REVIEW_NOTICE_TITLES) and lies at the stamp that writer puts on
 *      the recipient's row:
 *        - openReviewRoster with no actor ("Review requested: …"): a row
 *          opened by nobody (assigned_by null), at its assigned_at;
 *        - the reminder scan ("Reminder — review …"): at the notified_at
 *          it stamps just after the notice, or at any time since the
 *          recipient's row was opened (assigned_at − the window) — every
 *          reminder the scan wrote, not only the latest: each scan moves
 *          notified_at forward, so the day-5 reminder lies near neither
 *          assigned_at (day 0) nor notified_at (day 10);
 *        - invalidateDraftSignoffs' review_invalidated ("Re-review needed:
 *          …"): the row it turns 'invalidated', at the updated_at it
 *          stamps (an invalidated row moves no further).
 *      An actor-less row with any other title — a legacy intake notice
 *      ("Intake submission awaiting review: …", filed under
 *      review_requested until 20261191), a future producer — is not the
 *      roster's, whatever its time, and stays until read. The check-in
 *      panel's "Change proposed to …" notice always carries the person
 *      checking in as its actor (components/documents/CheckInPanel.tsx).
 *  updated_at on a live row is never evidence: each sign-off, invalidation
 *  and alternate activation moves it. Exported for the tests. */
export function rosterWrote(row: Pick<Row, "kind" | "created_at" | "actor_user_id" | "title">, roster: RosterStamp[]): boolean {
  const created = ms(row.created_at);
  if (!Number.isFinite(created)) return false;
  const actor = row.actor_user_id ?? null;
  const title = typeof row.title === "string" ? row.title : "";
  if (actor !== null) {
    return row.kind === "review_requested" && title.startsWith(REVIEW_NOTICE_TITLES.roster)
      && roster.some((s) => s.assigned_by === actor && near(s.assigned_at, created));
  }
  if (row.kind === "review_requested" && title.startsWith(REVIEW_NOTICE_TITLES.reminder)) {
    return roster.some((s) => {
      if (near(s.notified_at, created)) return true;
      const opened = ms(s.assigned_at);
      return Number.isFinite(opened) && created >= opened - REVIEW_ROSTER_WINDOW_MS;
    });
  }
  if (row.kind === "review_requested" && title.startsWith(REVIEW_NOTICE_TITLES.roster)) {
    return roster.some((s) => (s.assigned_by ?? null) === null && near(s.assigned_at, created));
  }
  if (row.kind === "review_invalidated" && title.startsWith(REVIEW_NOTICE_TITLES.invalidated)) {
    return roster.some((s) => s.status === "invalidated" && near(s.updated_at, created));
  }
  return false;
}

type Read<T> = { ok: true; data: T } | { ok: false };

async function read<T>(q: PromiseLike<{ data: unknown; error: unknown }>): Promise<Read<T[]>> {
  try {
    const { data, error } = await q;
    if (error) return { ok: false };
    return { ok: true, data: ((data as T[] | null) ?? []) };
  } catch {
    return { ok: false };
  }
}

const uniq = <T,>(xs: T[]): T[] => Array.from(new Set(xs));

/** The checks, one batched read per class. Answers, per row id, true (gone —
 *  retire), false (live — keep) or null (unreadable — keep). */
async function evaluate(db: ReconcileDb, orgId: string, uid: string, rows: Array<Row & { cls: ReconcileClass }>, nowMs: number): Promise<Map<string, boolean | null>> {
  const verdict = new Map<string, boolean | null>();
  const of = (cls: ReconcileClass) => rows.filter((r) => r.cls === cls);

  // workflow — the ticket's live status
  const wf = of("workflow");
  if (wf.length > 0) {
    const ids = uniq(wf.map((r) => r.resource_id as string).filter(isUuid));
    const res = ids.length > 0
      ? await read<{ id: string; status: string }>(db.from("tickets").select("id, status").eq("org_id", orgId).in("id", ids))
      : { ok: true as const, data: [] };
    const status = new Map(res.ok ? res.data.map((t) => [t.id, t.status]) : []);
    for (const r of wf) {
      // A resource id that is not a ticket id at all proves nothing.
      if (!res.ok || !isUuid(r.resource_id)) { verdict.set(r.id, null); continue; }
      verdict.set(r.id, workflowAlertGone(r.metadata, status.get(r.resource_id), SLA_NOTICE_ACTIONS));
    }
  }

  // hold — any open hold on the document; an aging nudge, its own hold
  const holds = of("hold");
  if (holds.length > 0) {
    const docIds = uniq(holds.map((r) => r.resource_id as string).filter(isUuid));
    const res = docIds.length > 0
      ? await read<{ id: string; document_id: string }>(db.from("document_holds").select("id, document_id").eq("org_id", orgId).in("document_id", docIds).is("released_at", null))
      : { ok: true as const, data: [] };
    const openDocs = new Set(res.ok ? res.data.map((h) => h.document_id) : []);
    const openHolds = new Set(res.ok ? res.data.map((h) => h.id) : []);
    for (const r of holds) {
      if (!res.ok || !isUuid(r.resource_id)) { verdict.set(r.id, null); continue; }
      const staleHoldId = r.metadata?.staleHoldId;
      verdict.set(r.id, typeof staleHoldId === "string" ? !openHolds.has(staleHoldId) : !openDocs.has(r.resource_id));
    }
  }

  // branch — resolved_at
  const branches = of("branch");
  if (branches.length > 0) {
    const ids = uniq(branches.map((r) => r.metadata?.branchId as string).filter(isUuid));
    const res = ids.length > 0
      ? await read<{ id: string; resolved_at: string | null }>(db.from("revision_branches").select("id, resolved_at").eq("org_id", orgId).in("id", ids))
      : { ok: true as const, data: [] };
    const resolved = new Map(res.ok ? res.data.map((b) => [b.id, b.resolved_at != null]) : []);
    for (const r of branches) {
      const id = r.metadata?.branchId as string;
      // A branch the read does not return is not proven resolved.
      verdict.set(r.id, !res.ok || !resolved.has(id) ? null : resolved.get(id)!);
    }
  }

  // stale_checkout — the escalated session's status
  const escalations = of("stale_checkout");
  if (escalations.length > 0) {
    const ids = uniq(escalations.map((r) => r.metadata?.staleSessionId as string).filter(isUuid));
    const res = ids.length > 0
      ? await read<{ id: string; status: string }>(db.from("checkout_sessions").select("id, status").eq("org_id", orgId).in("id", ids))
      : { ok: true as const, data: [] };
    const status = new Map(res.ok ? res.data.map((s) => [s.id, s.status]) : []);
    for (const r of escalations) {
      const id = r.metadata?.staleSessionId as string;
      verdict.set(r.id, !res.ok || !status.has(id) ? null : status.get(id) !== "active");
    }
  }

  // ack — a pending roster row, or a distribution confirmation that binds
  const acks = of("ack");
  if (acks.length > 0) {
    const docIds = uniq(acks.map((r) => r.resource_id as string).filter(isUuid));
    const [roster, dist, docs] = docIds.length > 0
      ? await Promise.all([
          read<{ document_id: string }>(db.from("document_acknowledgments").select("document_id").eq("org_id", orgId).eq("assignee_user_id", uid).eq("status", "pending").in("document_id", docIds)),
          read<{ document_id: string; version_id: string | null }>(db.from("distribution_acks").select("document_id, version_id").eq("org_id", orgId).eq("recipient_user_id", uid).is("acknowledged_at", null).in("document_id", docIds)),
          read<{ id: string; current_version_id: string | null; status: string | null }>(db.from("documents").select("id, current_version_id, status").eq("org_id", orgId).in("id", docIds)),
        ])
      : [{ ok: true as const, data: [] }, { ok: true as const, data: [] }, { ok: true as const, data: [] }];
    const readable = roster.ok && dist.ok && docs.ok;
    const owed = new Set<string>();
    if (readable) {
      for (const a of roster.data) owed.add(a.document_id);
      const docById = new Map(docs.data.map((d) => [d.id, d]));
      for (const a of dist.data) {
        const d = docById.get(a.document_id);
        // lib/distributionAcks.ts ackStillBinds: the current version, on a
        // document that is not retired.
        if (!d) continue;
        const status = String(d.status ?? "");
        if (status === "Superseded" || status === "Void" || status === "Archived") continue;
        if (String(a.version_id ?? "") === String(d.current_version_id ?? "")) owed.add(a.document_id);
      }
    }
    for (const r of acks) {
      if (!readable || !isUuid(r.resource_id)) { verdict.set(r.id, null); continue; }
      verdict.set(r.id, !owed.has(r.resource_id));
    }
  }

  // review — a pending sign-off on the draft in review, for a row the
  // roster provably wrote (see the header)
  const reviews = of("review");
  if (reviews.length > 0) {
    type Signoff = RosterStamp & { document_id: string; document_version_id: string | null };
    const docIds = uniq(reviews.map((r) => r.resource_id as string).filter(isUuid));
    const [signoffs, docs] = docIds.length > 0
      ? await Promise.all([
          read<Signoff>(db.from("document_review_signoffs").select("document_id, document_version_id, status, assigned_by, assigned_at, notified_at, updated_at").eq("org_id", orgId).eq("reviewer_user_id", uid).in("document_id", docIds)),
          read<{ id: string; pending_version_id: string | null }>(db.from("documents").select("id, pending_version_id").eq("org_id", orgId).in("id", docIds)),
        ])
      : [{ ok: true as const, data: [] as Signoff[] }, { ok: true as const, data: [] }];
    const readable = signoffs.ok && docs.ok;
    const owed = new Set<string>();
    const rosterByDoc = new Map<string, Signoff[]>();
    if (readable) {
      const draft = new Map(docs.data.map((d) => [d.id, d.pending_version_id]));
      for (const s of signoffs.data) {
        rosterByDoc.set(s.document_id, [...(rosterByDoc.get(s.document_id) ?? []), s]);
        const pending = draft.get(s.document_id);
        if (s.status === "pending" && pending && s.document_version_id === pending) owed.add(s.document_id);
      }
    }
    for (const r of reviews) {
      if (!readable || !isUuid(r.resource_id)) { verdict.set(r.id, null); continue; }
      const created = ms(r.created_at);
      // Too young (or no creation time to judge by): kept — never "gone".
      if (!Number.isFinite(created) || nowMs - created < REVIEW_RECONCILE_GRACE_MS) { verdict.set(r.id, false); continue; }
      // Not provably a roster's notice (the check-in panel's proposed change): kept.
      if (!rosterWrote(r, rosterByDoc.get(r.resource_id) ?? [])) { verdict.set(r.id, false); continue; }
      verdict.set(r.id, !owed.has(r.resource_id));
    }
  }

  // recert — the library's next recertification date
  const recerts = of("recert");
  if (recerts.length > 0) {
    const ids = uniq(recerts.map((r) => r.resource_id as string).filter(isUuid));
    const res = ids.length > 0
      ? await read<{ id: string; next_recertification_date: string | null }>(db.from("libraries").select("id, next_recertification_date").eq("org_id", orgId).in("id", ids))
      : { ok: true as const, data: [] };
    const next = new Map(res.ok ? res.data.map((l) => [l.id, l.next_recertification_date]) : []);
    for (const r of recerts) {
      if (!res.ok || !isUuid(r.resource_id) || !next.has(r.resource_id)) { verdict.set(r.id, null); continue; }
      const s = recertStatusFor(next.get(r.resource_id) ?? null);
      verdict.set(r.id, s === "current" || s === "none");
    }
  }

  // ack_escalation — anyone still owing on the document
  const ackEsc = of("ack_escalation");
  if (ackEsc.length > 0) {
    const docIds = uniq(ackEsc.map((r) => r.resource_id as string).filter(isUuid));
    const [roster, dist, docs] = docIds.length > 0
      ? await Promise.all([
          read<{ document_id: string }>(db.from("document_acknowledgments").select("document_id").eq("org_id", orgId).eq("status", "pending").in("document_id", docIds)),
          read<{ document_id: string; version_id: string | null }>(db.from("distribution_acks").select("document_id, version_id").eq("org_id", orgId).is("acknowledged_at", null).in("document_id", docIds)),
          read<{ id: string; current_version_id: string | null; status: string | null }>(db.from("documents").select("id, current_version_id, status").eq("org_id", orgId).in("id", docIds)),
        ])
      : [{ ok: true as const, data: [] }, { ok: true as const, data: [] }, { ok: true as const, data: [] }];
    const readable = roster.ok && dist.ok && docs.ok;
    const owed = new Set<string>();
    if (readable) {
      for (const a of roster.data) owed.add(a.document_id);
      const docById = new Map(docs.data.map((d) => [d.id, d]));
      for (const a of dist.data) {
        const d = docById.get(a.document_id);
        if (!d) continue;
        const status = String(d.status ?? "");
        if (status === "Superseded" || status === "Void" || status === "Archived") continue;
        if (String(a.version_id ?? "") === String(d.current_version_id ?? "")) owed.add(a.document_id);
      }
    }
    for (const r of ackEsc) {
      if (!readable || !isUuid(r.resource_id)) { verdict.set(r.id, null); continue; }
      verdict.set(r.id, !owed.has(r.resource_id));
    }
  }

  // review_escalation — a draft still in review on the document
  const reviewEsc = of("review_escalation");
  if (reviewEsc.length > 0) {
    const docIds = uniq(reviewEsc.map((r) => r.resource_id as string).filter(isUuid));
    const res = docIds.length > 0
      ? await read<{ id: string; pending_version_id: string | null }>(db.from("documents").select("id, pending_version_id").eq("org_id", orgId).in("id", docIds))
      : { ok: true as const, data: [] };
    const draft = new Map(res.ok ? res.data.map((d) => [d.id, d.pending_version_id]) : []);
    for (const r of reviewEsc) {
      // A document the read does not return is not proven to have no draft.
      if (!res.ok || !isUuid(r.resource_id) || !draft.has(r.resource_id)) { verdict.set(r.id, null); continue; }
      verdict.set(r.id, draft.get(r.resource_id) == null);
    }
  }

  return verdict;
}

/** Retire the caller's rows (of those sent) whose condition is gone. */
export async function retireStaleAlerts(
  db: ReconcileDb,
  input: { orgId: string; uid: string; ids: string[]; now?: Date },
): Promise<ReconcileAnswer & { error?: string }> {
  const ids = uniq(input.ids.filter(isUuid)).slice(0, RECONCILE_MAX_IDS);
  if (ids.length === 0) return { retired: [], kept: 0, failed: 0 };
  const rowsRes = await read<Row>(
    db.from("notifications")
      .select("id, kind, resource_type, resource_id, metadata, created_at, actor_user_id, title")
      .eq("org_id", input.orgId)
      .eq("user_id", input.uid)
      .is("read_at", null)
      .is("metadata->>superseded_at", null)
      .in("id", ids),
  );
  if (!rowsRes.ok) return { retired: [], kept: 0, failed: ids.length, error: "The notifications could not be read." };
  const rows: Array<Row & { cls: ReconcileClass }> = [];
  let kept = 0;
  for (const r of rowsRes.data) {
    const cls = reconcileClassOf({ kind: r.kind, resourceType: r.resource_type, resourceId: r.resource_id, metadata: r.metadata });
    if (cls) rows.push({ ...r, cls }); else kept += 1;
  }
  const now = input.now ?? new Date();
  const verdict = await evaluate(db, input.orgId, input.uid, rows, now.getTime());
  const supersededAt = now.toISOString();
  const retired: string[] = [];
  let failed = 0;
  for (const r of rows) {
    const v = verdict.get(r.id);
    if (v === null || v === undefined) { failed += 1; continue; }
    if (!v) { kept += 1; continue; }
    try {
      const { data, error } = await db.from("notifications")
        .update({ metadata: { ...(r.metadata ?? {}), superseded_at: supersededAt } })
        .eq("id", r.id)
        .eq("user_id", input.uid)
        .eq("org_id", input.orgId)
        .is("read_at", null)
        .is("metadata->>superseded_at", null)
        .select("id");
      if (error) { failed += 1; continue; }
      // Zero rows: read or superseded meanwhile — nothing to retire.
      if (((data as unknown[] | null) ?? []).length > 0) retired.push(r.id); else kept += 1;
    } catch {
      failed += 1;
    }
  }
  return { retired, kept, failed };
}
