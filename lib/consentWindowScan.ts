// lib/consentWindowScan.ts
//
// drafting-flow Round G, DF-P7 CONSENT — the server half of GAP-109 / GAP-113
// (DEC-38, DEC-39). Server-only (it reaches lib/ticketRoster.ts, which hashes
// with node:crypto). The rules are lib/consentWindow.ts's; this file does the
// writes, each checked:
//
//   * openConsentWindow — the ONE call that opens a window:
//     open_consent_window (20261255, SECURITY DEFINER, service role only)
//     inserts a notification row per person asked AND a "delivered" notice
//     event naming it AND stamps the ticket (columns + the roster's mirror +
//     a history line naming everyone asked) in ONE transaction. No rows, no
//     timestamp, no clock (DEC-38). Any refusal leaves the ticket exactly as
//     it was: the slot waits for a sign-off, and the caller says so.
//   * afterRosterOpened — the workflow route's step once a submission's
//     compare-and-set has landed: opens the window the roster planned, or —
//     for a slot whose routing named nobody — records the block and tells the
//     assignment queue (DEC-39: an empty set never advances; it escalates).
//   * recordNotEmailed — EVID-9's route limb: a person a transition did not
//     email because their own preference turned it off gets a durable
//     "not emailed by their choice" record, not silence.
//   * runConsentWindowScan — ONE step of app/api/cron/maintenance/route.ts
//     (no new cron entry): retries a window the route could not open, sends
//     the reminder at the configured fraction (record_consent_window_warning,
//     the same one-transaction shape), and closes an expired window — the
//     auto-advance is a recorded SYSTEM act (audit row first, then the
//     compare-and-set, then the notice events and the ledger), written into
//     the ticket's own history naming everyone asked.
//
// FIX PASS (DF-P7 review): the window trusts the service-written roster
// ledger (ticket_review_slots, 20261242), never the member-writable
// metadata alone — the retry and the close read the ledger's slot (open,
// consent_window, its primaries) and the close issues only when the ledger
// agrees every other sign-off is in. An issuing close runs the route's
// source-revision check first (lib/sourceDocRef.ts revDrift): a moved or
// unreadable source holds it for a person. A running window whose slot was
// signed or whose review was replaced is retired (its expiry stamped), and
// each run reads from a random point of the id space, so no resident set of
// rows can starve the rest.
//
// FIX PASS 2 (DF-P7 review): the people asked are never anyone who signed,
// or can still sign, a slot the window's slot must be independent of
// (DEC-37 slot-to-slot — consentConflictedPeople), and a close with nobody
// independent told holds ("independence"). The close also holds while a
// slot only the drafter can sign is open (the producer floor would refuse
// the drafter for good after a silent close). The open and the reminder are
// emailed to whoever's preferences allow it (the same rule the route uses —
// emailPreferenceOf), each person's channel is named in the history line,
// and a person not emailed gets a not_emailed record. An issuing close tells
// the PENDING_IFC pool (LEAK-1) and clears the request's document intents
// when it lands at FINAL_DRAFT, as the route does. A retry with nobody left
// to ask records the block, tells the assignment queue once and stops.
//
// FIX PASS 3 (DF-P7 review): the close counts only people who are STILL
// active members — a recipient suspended or removed during the window
// could not object, so their silence is not counted, and a close with
// nobody else left holds ("no_longer_member"), recorded as a block and told
// to the assignment queue. The close re-checks the engineered lane with the
// requester's current roles, the org's current policy and its
// engineering-first types ("engineered"). An issuing close issues the draft
// as-is (FRIC-5) only when the window's opening notice named the mark —
// otherwise it takes the PENDING_IFC hop and withdraws the mark, said. A
// planned window open_consent_window refuses for good (22023 / 55000 /
// 23505) is marked blocked once instead of retried on every run.
//
// MERGE-TIME FIX PASS (DEC-90 ruling (1)): the retry and the close re-read
// the request's EFFECTIVE routing slot (lib/routingControl.ts
// ticketReviewRouting, bound to the service role) and open or close nothing
// unless that slot is a consent-window slot carrying the opt-in
// (consent_confirmed === true) and is not filled by an engineering
// capability (CONSENT_REFUSED_CAPABILITIES) — a forged metadata plan, or a
// table changed since the roster opened, can never open or close a window.
//
// ticket_notice_events (20261255) is the record that survives any bell
// purge: append-only, written only by the service role.

import { computeTransition, rowToTicket, escapeHtml } from "@/lib/ticketTransitions";
import { parseSourceDocuments, parseSourceDocument, revDrift } from "@/lib/sourceDocRef";
import { ticketReviewRouting } from "@/lib/routingControl";
import { currentRoster, ticketResource, engineeringGateRequired, ISSUE_AS_IS_NOTE } from "@/lib/workflow";
import { isDeclaredLikeInKind, declarationSignatureStands, type DeclarationSignatureRow } from "@/lib/reviewModel";
import { heldRoles } from "@/lib/roleHeld";
import { flaggedRequestTypes } from "@/lib/requestTypes";
import { resolveTicketRecipients, isRoutedStatus } from "@/lib/ticketRouting";
import { wrapEmailBody } from "@/lib/emailRender";
import { isPreferenceExempt } from "@/lib/notificationPrefs";
import { resolveFill, rosterCompletion, writeRosterLedger, type OccupantContext } from "@/lib/ticketRoster";
import { loadPickerMembers } from "@/lib/ticketPickerMembers";
import { loadCapabilityPolicyStrict, type CapabilityPolicy, type CapabilityResource } from "@/lib/capabilityPolicy";
import { notifyBatchWithReason } from "@/lib/inAppNotifications";
import {
  CONSENT_REASON, CONSENT_WINDOW_ACTOR, CONSENT_WINDOW_MIGRATION, consentFloorHolds, consentRecipients, consentSatisfiedSlot, consentWindowFromRow,
  consentWindowStep, isMissingConsentColumn, isMissingConsentSchema, noticeStates, openedHistoryDetails,
  consentConflictedPeople, consentIndependenceHolds, ledgerIndependenceSlot, drafterOnlyOpenSlot,
  recordMoment, warnedHistoryDetails, advancedHistoryDetails, windowSchedule, type ConsentHoldReason, type ConsentWindowState,
  CONSENT_ISSUE_AS_IS_KEY, issueAsIsMarkOf, issueAsIsNamedAtOpen, CONSENT_REFUSED_CAPABILITIES,
} from "@/lib/consentWindow";
import type { TicketConsentPlan, TicketHistoryEntry, TicketReviewRoster, TicketStatus } from "@/types/schema";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = { from: (t: string) => any; rpc: (fn: string, args?: Record<string, unknown>) => any };

type Member = Record<string, unknown>;

/** A member as a record names them: their display name, else their email's
 *  local part, else a short id (never blank). */
export function memberNameOf(members: ReadonlyArray<Member>): (uid: string) => string {
  const byUid = new Map(members.map((m) => [String(m.uid ?? ""), m] as const));
  return (uid: string) => {
    const m = byUid.get(uid);
    const dn = typeof m?.display_name === "string" ? m.display_name.trim() : "";
    if (dn) return dn;
    const em = typeof m?.email === "string" ? m.email.split("@")[0] : "";
    return em || `member ${uid.slice(0, 8)}`;
  };
}

/** Who "the assigner" is (DEC-39): whoever runs the assignment queue — the
 *  members `ticket.assign` names under the org's policy for this request. */
export function assignmentQueueOf(ctx: OccupantContext): string[] {
  return resolveFill({ capability: "ticket.assign" }, ctx);
}

/** A history entry the database appends (it re-dates it with its own clock).
 *  The actor is the machine, never a person (DEC-87 §2). */
const historyEntry = (action: string, details: string, now: string): Pick<TicketHistoryEntry, "action" | "user" | "date" | "details"> & { role: string } =>
  ({ action, user: CONSENT_WINDOW_ACTOR, role: "System", date: now, details });

/** FRIC-5 × GAP-109 (fix pass 3): what a consent notice adds when the
 *  drafter marked the draft issue-as-is — the reviewer's own sign-off
 *  statement carries ISSUE_AS_IS_NOTE; the people a window asks are told
 *  the same, since their silence is that approval. */
export const CONSENT_ISSUE_AS_IS_NOTE = `${ISSUE_AS_IS_NOTE} If nobody objects, the window's close is that approval: the draft is issued as the final package.`;

/** open_consent_window refusals no retry can change (fix pass 3): a person
 *  it may not ask (22023), a review that is not the one open or a slot that
 *  is not an open consent slot (55000), a window already open (23505). Any
 *  other failure (a network error, 40001, 57014, …) is retried. */
export const CONSENT_OPEN_PERMANENT_CODES: ReadonlySet<string> = new Set(["22023", "55000", "23505"]);

/** Append ticket_notice_events rows, checked and retried once. null when they
 *  landed; "missing" before 20261255; otherwise the error. */
export async function recordNoticeEvents(db: Db, rows: Array<Record<string, unknown>>): Promise<string | null> {
  if (rows.length === 0) return null;
  const attempt = async (): Promise<string | null> => {
    try {
      const { error } = await db.from("ticket_notice_events").insert(rows);
      if (!error) return null;
      if (isMissingConsentSchema(error)) return "missing";
      return error.message || "insert refused";
    } catch (e) {
      return (e as Error)?.message ?? String(e);
    }
  };
  const first = await attempt();
  if (first === null || first === "missing") return first;
  return attempt();
}

/** The email event a consent notice is queued as: a request for the
 *  person's sign-off is work routed to them, so their assignment-email
 *  switch governs it (DEC-44 (DF-P7-consent) item 15). */
export const CONSENT_EMAIL_EVENT = "assignment";

/** Who of the people a consent notice reaches is emailed too, and why each
 *  of the others is not — decided BEFORE the notice is written, so its
 *  history line names each person's channel. */
export interface ConsentEmailPlan {
  emails: Array<{ uid: string; email: string }>;
  notEmailed: Array<{ uid: string; reason: string; byTheirChoice: boolean }>;
}

/** Read the preferences of the people a consent notice reaches and decide
 *  each person's email (emailPreferenceOf — the route's own rule). A failed
 *  read emails nobody (it cannot tell who opted out) and says so per person. */
export async function planConsentEmails(db: Db, input: { recipients: readonly string[]; members: ReadonlyArray<Member> }): Promise<ConsentEmailPlan> {
  const plan: ConsentEmailPlan = { emails: [], notEmailed: [] };
  const uids = [...new Set(input.recipients)];
  if (uids.length === 0) return plan;
  const emailOf = new Map<string, string>();
  for (const m of input.members) if (typeof m.uid === "string" && typeof m.email === "string" && m.email.trim()) emailOf.set(m.uid, m.email.trim());
  let prefs: Array<Record<string, unknown>> = [];
  try {
    const { data, error } = await db.from("notification_preferences").select("*").in("user_id", uids);
    if (error) throw new Error(error.message || "refused");
    prefs = (data as Array<Record<string, unknown>> | null) ?? [];
  } catch (e) {
    const why = `their email preferences could not be read (${(e as Error)?.message ?? String(e)}), so no email was sent`;
    return { emails: [], notEmailed: uids.map((uid) => ({ uid, reason: why, byTheirChoice: false })) };
  }
  const prefOf = new Map(prefs.map((p) => [String(p.user_id ?? ""), p] as const));
  for (const uid of uids) {
    const email = emailOf.get(uid);
    if (!email) { plan.notEmailed.push({ uid, reason: "no email address is on record for them", byTheirChoice: false }); continue; }
    const d = emailPreferenceOf(prefOf.get(uid), CONSENT_EMAIL_EVENT);
    if (d.wants) plan.emails.push({ uid, email });
    else plan.notEmailed.push({ uid, reason: d.reason ?? "their email preferences", byTheirChoice: true });
  }
  return plan;
}

/** The sentence a consent notice's history line adds: how each person was
 *  told (GAP-113 — a person told only in the app is named as such).
 *  DEC-90 ruling (2) (DF-P7 final fix pass — privacy): any reader of the
 *  ticket reads its history, so a person not emailed by THEIR OWN choice is
 *  named with the channel only ("in the app only: Alice") — the reason a
 *  preference gives lives only in their person-scoped not_emailed row
 *  (ticket_notice_events, readable by that person alone). A cause that is
 *  not a preference (no address on record, a queue that refused, a
 *  preference read that failed) is still named, as before. */
export function consentChannelNote(plan: ConsentEmailPlan, nameOf: (uid: string) => string): string {
  const emailed = plan.emails.map((e) => nameOf(e.uid));
  const not = plan.notEmailed.map((n) => (n.byTheirChoice ? nameOf(n.uid) : `${nameOf(n.uid)} (${n.reason})`));
  return ` Each was told in the app${emailed.length ? `; by email as well: ${emailed.join(", ")}` : ""}${not.length ? `; in the app only: ${not.join(", ")}` : ""}.`;
}

/** Queue the emails a consent notice's plan names (once its notice landed),
 *  and record a not_emailed row for everyone not emailed — by their choice,
 *  for want of an address, or because the queue refused. Never throws;
 *  answers the first error (null when everything was written). */
export async function queueConsentEmails(db: Db, input: {
  orgId: string; ticketId: string; rosterId: string; slotKind: string | null; phase: "opened" | "warned";
  plan: ConsentEmailPlan; subject: string; text: string; origin?: string | null;
}): Promise<string | null> {
  const notEmailed = [...input.plan.notEmailed];
  let queueErr: string | null = null;
  if (input.plan.emails.length > 0) {
    let orgName: string | null = null;
    try {
      const { data } = await db.from("orgs").select("name").eq("id", input.orgId).maybeSingle();
      orgName = ((data as { name?: string | null } | null)?.name ?? null);
    } catch { /* the footer goes without the workspace's name */ }
    const origin = (input.origin ?? "").replace(/\/+$/, "");
    const link = `${origin}/requests/${input.ticketId}`;
    const composed = `${input.text}\n\n${link}`;
    let body: { bodyText: string; bodyHtml: string } | null = null;
    try { body = wrapEmailBody({ text: composed, orgName, origin: origin || null }); } catch { body = null; }
    const rows = input.plan.emails.map((e) => ({
      org_id: input.orgId, to_user_id: e.uid, to_email: e.email, subject: input.subject.slice(0, 200),
      body_text: body ? body.bodyText : composed,
      body_html: body ? body.bodyHtml : `<p style="white-space:pre-wrap">${escapeHtml(composed)}</p>`,
      resource_type: "ticket", resource_id: input.ticketId, event_type: CONSENT_EMAIL_EVENT,
      metadata: { action: `consent_window_${input.phase}`, status: "PENDING_REVIEW", consentWindow: { roster: input.rosterId, slot: input.slotKind }, ...(body ? { rendered: true } : {}) },
      status: "queued",
    }));
    try {
      const { error } = await db.from("email_notifications").insert(rows);
      if (error) queueErr = error.message || "refused";
    } catch (e) {
      queueErr = (e as Error)?.message ?? String(e);
    }
    if (queueErr) for (const e of input.plan.emails) notEmailed.push({ uid: e.uid, reason: `the email could not be queued (${queueErr})`, byTheirChoice: false });
  }
  const recErr = await recordNotEmailed(db, {
    orgId: input.orgId, ticketId: input.ticketId, action: `consent_window_${input.phase}`, eventType: CONSENT_EMAIL_EVENT,
    optedOut: notEmailed, rosterId: input.rosterId, slotKind: input.slotKind,
  });
  return queueErr ? `the emails were not queued: ${queueErr}` : recErr ? `the not-emailed record was not written: ${recErr}` : null;
}

/** Open the window `plan` describes on the ticket's CURRENT roster — one
 *  transaction (open_consent_window). Then the emails (fix pass 2): the
 *  history line names each person's channel, decided before the call. */
export async function openConsentWindow(db: Db, input: {
  ticketId: string;
  orgId: string;
  roster: Pick<TicketReviewRoster, "id">;
  plan: Extract<TicketConsentPlan, { kind: "open" }>;
  nameOf: (uid: string) => string;
  ticketLabel: string;
  members: ReadonlyArray<Member>;
  origin?: string | null;
  now?: number;
  /** FRIC-5 (fix pass 3): the drafter's issue-as-is mark on the draft under
   *  review as the caller read it (lib/consentWindow.ts issueAsIsMarkOf) —
   *  named in the notice, the history line and its CONSENT_ISSUE_AS_IS_KEY,
   *  which is what lets the close issue as-is. */
  issueAsIs?: { rev: string; at: string | null } | null;
}): Promise<{ ok: true; notified: number; closesAt: string; emailError: string | null; planMarkError: string | null } | { ok: false; missing: boolean; error: string; code: string | null }> {
  const now = input.now ?? Date.now();
  const { warnAt, closesAt } = windowSchedule(now, input.plan);
  const nowIso = new Date(now).toISOString();
  const emailPlan = await planConsentEmails(db, { recipients: input.plan.recipients, members: input.members });
  const asIs = input.issueAsIs ? ` ${CONSENT_ISSUE_AS_IS_NOTE}` : "";
  const details = `${openedHistoryDetails({ label: input.plan.label, recipients: input.plan.recipients, nameOf: input.nameOf, openedAt: now, warnAt, closesAt })}${asIs}${consentChannelNote(emailPlan, input.nameOf)}`;
  const title = `You may object · ${input.ticketLabel}`.slice(0, 200);
  const body = `"${input.plan.label}" goes ahead without your sign-off unless you object before ${recordMoment(closesAt)}.${asIs} Open the request to object (your reason is recorded) or to sign off.`;
  try {
    const { data, error } = await db.rpc("open_consent_window", {
      p_ticket: input.ticketId,
      p_roster: input.roster.id,
      p_slot: input.plan.slot,
      p_recipients: input.plan.recipients,
      p_warn_at: new Date(warnAt).toISOString(),
      p_closes_at: new Date(closesAt).toISOString(),
      p_title: title,
      p_body: body,
      p_history: {
        ...historyEntry(`Consent window opened — ${input.plan.label}`, details, nowIso),
        ...(input.issueAsIs ? { [CONSENT_ISSUE_AS_IS_KEY]: { rev: input.issueAsIs.rev, at: input.issueAsIs.at } } : {}),
      },
    });
    if (error) return { ok: false, missing: isMissingConsentSchema(error), error: error.message || "refused", code: typeof error.code === "string" && error.code ? error.code : null };
    // DEC-90 ruling (4): the plan is marked opened, so the cron's "still to
    // open" read stops returning this review. Best-effort — a mark that did
    // not land is retried by the cron (it re-marks any plan whose window is
    // already open on its roster).
    const planMarkError = await markConsentPlanOpened(db, { ticketId: input.ticketId, rosterId: input.roster.id });
    const emailError = await queueConsentEmails(db, {
      orgId: input.orgId, ticketId: input.ticketId, rosterId: input.roster.id, slotKind: input.plan.slot, phase: "opened",
      plan: emailPlan, subject: title, text: body, origin: input.origin,
    });
    return { ok: true, notified: typeof data === "number" ? data : input.plan.recipients.length, closesAt: new Date(closesAt).toISOString(), emailError, planMarkError };
  } catch (e) {
    return { ok: false, missing: false, error: (e as Error)?.message ?? String(e), code: null };
  }
}

/**
 * DEC-90 ruling (4) (DF-P7 final fix pass — scale): mark a review's `open`
 * consent plan `opened` once its window is open on that same roster, so the
 * maintenance cron's planned-set read (consentPlan.kind = 'open') returns
 * only reviews that still need an open. An app-side compare-and-set: the
 * ticket is re-read and written only while its last_modified is still the
 * one read, its window columns name this roster, and the plan is still
 * `open` on it. last_modified is NOT changed (nobody's own write is turned
 * into a conflict by this bookkeeping); a write that raced it simply keeps
 * the plan `open`, and the next run re-marks it. Never throws; null when
 * the plan is marked or there is nothing to mark, else the error.
 */
export async function markConsentPlanOpened(db: Db, input: { ticketId: string; rosterId: string }): Promise<string | null> {
  try {
    const { data, error } = await db.from("tickets").select("id, metadata, last_modified, consent_window_roster").eq("id", input.ticketId).maybeSingle();
    if (error) return error.message || "the request could not be read";
    const row = data as { metadata?: Record<string, unknown> | null; last_modified?: string | null; consent_window_roster?: string | null } | null;
    if (!row || row.consent_window_roster !== input.rosterId) return null;
    const meta = (row.metadata && typeof row.metadata === "object" ? row.metadata : {}) as Record<string, unknown>;
    const roster = meta.review_roster as TicketReviewRoster | undefined;
    const plan = roster?.consentPlan;
    if (!roster || roster.id !== input.rosterId || !plan || plan.kind !== "open") return null;
    const opened: TicketConsentPlan = { ...plan, kind: "opened" };
    let q = db.from("tickets").update({ metadata: { ...meta, review_roster: { ...roster, consentPlan: opened } } })
      .eq("id", input.ticketId).eq("consent_window_roster", input.rosterId);
    q = row.last_modified ? q.eq("last_modified", row.last_modified) : q.is("last_modified", null);
    const { error: uErr } = await q.select("id");
    return uErr ? (uErr.message || "the mark was refused") : null;
  } catch (e) {
    return (e as Error)?.message ?? String(e);
  }
}

/**
 * The workflow route, once a submission that opened a roster has landed:
 * act on the roster's consent plan. Never throws; answers the sentence the
 * response should carry (null when there is nothing to say).
 */
export async function afterRosterOpened(db: Db, input: {
  ticketId: string;
  orgId: string;
  ticketLabel: string;
  roster: TicketReviewRoster;
  members: ReadonlyArray<Member>;
  policy: CapabilityPolicy | null | undefined;
  resource: CapabilityResource | null;
  requesterId: string | null | undefined;
  actor: { uid: string; name: string | null };
  /** The absolute origin email links are built on (the route's). */
  origin?: string | null;
  /** FRIC-5 (fix pass 3): the issue-as-is mark the submission left on the
   *  draft (lib/consentWindow.ts issueAsIsMarkOf), named in the notice. */
  issueAsIs?: { rev: string; at: string | null } | null;
}): Promise<string | null> {
  const plan = input.roster.consentPlan;
  if (!plan || plan.kind === "sign_off" || plan.kind === "opened") return null;
  const nameOf = memberNameOf(input.members);
  if (plan.kind === "open") {
    const r = await openConsentWindow(db, { ticketId: input.ticketId, orgId: input.orgId, roster: input.roster, plan, nameOf, ticketLabel: input.ticketLabel, members: input.members, origin: input.origin, issueAsIs: input.issueAsIs ?? null });
    if (r.ok) {
      if (r.emailError) console.error(`[consent-window] the window on ticket ${input.ticketId} opened (everyone asked was told in the app), but ${r.emailError}`);
      if (r.planMarkError) console.error(`[consent-window] the window on ticket ${input.ticketId} opened, but its plan was not marked opened (the maintenance run marks it): ${r.planMarkError}`);
      return null;
    }
    console.error(`[consent-window] the window on ticket ${input.ticketId} (roster ${input.roster.id}) was not opened — "${plan.label}" waits for a sign-off; the maintenance run retries it: ${r.error}`);
    // The refusal is recorded on the ticket's notice record (it outlives the
    // response), not only said in the answer. Not before 20261255 (no table).
    if (!r.missing) {
      const evErr = await recordNoticeEvents(db, [{
        org_id: input.orgId, ticket_id: input.ticketId, roster_id: input.roster.id, slot_kind: plan.slot, kind: "blocked",
        recipient: null, actor_id: input.actor.uid, actor_name: input.actor.name,
        details: { reason: "window_not_opened", error: r.error, recipients: plan.recipients, retriedByMaintenance: true },
      }]);
      if (evErr && evErr !== "missing") console.error(`[consent-window] the failed open on ticket ${input.ticketId} was not recorded: ${evErr}`);
    }
    return r.missing
      ? `"${plan.label}" waits for a sign-off: consent windows need database update ${CONSENT_WINDOW_MIGRATION}.`
      : `"${plan.label}" waits for a sign-off for now: the people it asks could not all be told (${r.error}), so no consent window was opened — nothing advances on silence. It is tried again at the next maintenance run.`;
  }
  // blocked — DEC-39: an empty set never advances; the assignment queue hears.
  const why = plan.reason === CONSENT_REASON.onlyParties
    ? "the only people its routing names are the drafter or a party it must be independent of, and their silence is never consent"
    : "its routing named nobody who could be asked";
  const queue = assignmentQueueOf({ members: input.members, policy: input.policy, resource: input.resource, requesterId: input.requesterId }).filter((u) => u !== input.actor.uid);
  // DEC-90 ruling (1): the bell first, then the record of who actually heard
  // (escalatedTo names only people whose bell row landed) — nothing says
  // the queue was told unless it was.
  let bellError: string | null = null;
  if (queue.length > 0) {
    const { error } = await notifyBatchWithReason(queue.map((uid) => ({
      orgId: input.orgId, userId: uid, kind: "ticket_status" as const,
      title: `Nobody to ask · ${input.ticketLabel}`.slice(0, 200),
      body: `"${plan.label}" is a consent slot, but ${why}, so it waits for a sign-off. Check the routing table or the roles.`,
      link: `/requests/${input.ticketId}`, resourceType: "ticket", resourceId: input.ticketId,
      actorUserId: input.actor.uid, actorName: input.actor.name ?? undefined,
      metadata: { action: "consent_window_blocked", slot: plan.slot },
    })), db as never);
    if (error) { bellError = error; console.error(`[consent-window] the assignment queue was not told of the block on ticket ${input.ticketId}: ${error}`); }
  }
  const told = queue.length > 0 && !bellError;
  const evErr = await recordNoticeEvents(db, [{
    org_id: input.orgId, ticket_id: input.ticketId, roster_id: input.roster.id, slot_kind: plan.slot, kind: "blocked",
    recipient: null, actor_id: input.actor.uid, actor_name: input.actor.name,
    details: { reason: plan.reason, escalatedTo: told ? queue : [], ...(bellError ? { notTold: queue, escalationError: bellError } : {}) },
  }]);
  if (evErr && evErr !== "missing") console.error(`[consent-window] the block on ticket ${input.ticketId} was not recorded: ${evErr}`);
  return `"${plan.label}" waits for a sign-off: ${why}, so no consent window was opened${told ? " — the assignment queue was told" : ""}.`;
}

/** EVID-9 (route limb): the people a transition did not email because their
 *  own preference turned that email off — one durable record each. Never
 *  throws; before 20261255 it records nothing (the table is not there). */
export async function recordNotEmailed(db: Db, input: {
  orgId: string;
  ticketId: string;
  action: string;
  eventType: string;
  /** `byTheirChoice` defaults to true (a preference); false for a person
   *  not emailed for another reason (no address, a refused queue). */
  optedOut: ReadonlyArray<{ uid: string; reason: string; byTheirChoice?: boolean }>;
  rosterId?: string | null;
  slotKind?: string | null;
}): Promise<string | null> {
  if (input.optedOut.length === 0) return null;
  const err = await recordNoticeEvents(db, input.optedOut.map((o) => ({
    org_id: input.orgId, ticket_id: input.ticketId, kind: "not_emailed", recipient: o.uid,
    ...(input.rosterId ? { roster_id: input.rosterId } : {}), ...(input.slotKind ? { slot_kind: input.slotKind } : {}),
    details: { reason: o.reason, byTheirChoice: o.byTheirChoice ?? true, action: input.action, eventType: input.eventType },
  })));
  return err === "missing" ? null : err;
}

/** The per-event email switches a preference row carries, and how a record
 *  words each one turned off (lib/notificationPrefs.ts shouldSendForEvent's
 *  cases — a test pins the two equal). */
const EVENT_EMAIL_SWITCH: Record<string, { key: string; reason: string }> = {
  comment_mention: { key: "email_on_mention", reason: "they turned mention emails off" },
  assignment: { key: "email_on_assignment", reason: "they turned assignment emails off" },
  engineer_review_requested: { key: "email_on_assignment", reason: "they turned assignment emails off" },
  ticket_status_changed: { key: "email_on_status_change", reason: "they turned status-change emails off" },
  ticket_approved: { key: "email_on_status_change", reason: "they turned status-change emails off" },
  ticket_revision_requested: { key: "email_on_status_change", reason: "they turned status-change emails off" },
  ticket_closed: { key: "email_on_status_change", reason: "they turned status-change emails off" },
  watcher_activity: { key: "email_on_watched_activity", reason: "they turned emails about requests they watch off" },
  sla_warning: { key: "email_on_sla_warning", reason: "they turned SLA-warning emails off" },
};

/**
 * EVID-9 (fix pass 2): ONE rule for whether a member's preference row (none =
 * the defaults) wants an email of `eventType`, and — when it does not — the
 * reason, worded for the record. `wants` is false exactly when `reason` is
 * set, so a "not emailed by their choice" row is written only for a real
 * preference. The workflow route's fan-out and the consent notices both
 * read it; a test pins `wants` to lib/notificationPrefs.ts
 * emailAllowedByPrefs over every event type. Pure.
 */
export function emailPreferenceOf(p: Record<string, unknown> | null | undefined, eventType: string): { wants: boolean; reason: string | null } {
  if (isPreferenceExempt(eventType) || !p) return { wants: true, reason: null };
  if (p.email_enabled === false) return { wants: false, reason: "they turned email off" };
  if (p.digest_frequency === "never") return { wants: false, reason: "they set email delivery to never" };
  const sw = EVENT_EMAIL_SWITCH[eventType];
  if (sw && p[sw.key] === false) return { wants: false, reason: sw.reason };
  return { wants: true, reason: null };
}

/** Why a preference row turns an email off (null: it does not). */
export function emailPreferenceReason(p: Record<string, unknown> | undefined, eventType: string): string | null {
  return emailPreferenceOf(p, eventType).reason;
}

/** The machine actor the copy recall names on a consent issue (DF-P22). */
export const CONSENT_RECALL_ACTOR = CONSENT_WINDOW_ACTOR;

/**
 * DF-P22 (public-surfaces PHYS-18 on a consent-completed issue — the DF-P7
 * hand-off): the ticket arm of the stale-copy recall
 * (lib/staleCopies.ts getTicketCopyRecall / nudgeStaleTicketHolders), run
 * as the workflow route runs it after an issuing sign-off — bound to the
 * service role for this call only (lib/serverClientScope.ts: the recall
 * writes its audit row and its notices through the shared client) — but by
 * the recorded system actor (`system:consent-window`, no uid). A record that
 * could not be read is recorded as such and tells nobody (the recall's own
 * `unavailable` rule). Never throws; null when it ran, else why not.
 */
export async function recallCopiesAfterConsentIssue(db: Db, input: {
  ticket: { id: string; orgId: string; status: string; deliverableRev: string; history: unknown; revisionCount: number | null; historyGuardedFrom: number | null; attachments: unknown };
  ticketNumber: string | null;
}): Promise<string | null> {
  try {
    const [{ getTicketCopyRecall, nudgeStaleTicketHolders }, { runWithServerClient }] = await Promise.all([
      import("@/lib/staleCopies"), import("@/lib/serverClientScope"),
    ]);
    await runWithServerClient(db as never, async () => {
      const recall = await getTicketCopyRecall(input.ticket, db as unknown as Parameters<typeof getTicketCopyRecall>[1]);
      if (!recall.unavailable && recall.holders.length === 0) return 0;
      return nudgeStaleTicketHolders({
        orgId: input.ticket.orgId, ticketId: input.ticket.id, ticketNumber: input.ticketNumber,
        latestIssuedRev: recall.latestIssuedRev, holders: recall.holders,
        actorUserId: null, systemActor: CONSENT_RECALL_ACTOR, actorName: CONSENT_RECALL_ACTOR,
        source: "auto", unavailable: recall.unavailable,
      });
    });
    return null;
  } catch (e) {
    return (e as Error)?.message ?? String(e);
  }
}

// ─── The maintenance cron's step ────────────────────────────────────────────

export interface ConsentScanReport {
  /** False until 20261255 is pasted: nothing is read or written. */
  schemaReady: boolean;
  scanned: number;
  opened: number;
  warned: number;
  advanced: number;
  issued: number;
  held: number;
  /** Running windows whose slot was signed, or whose review was replaced or
   *  closed, stamped expired so they stop being read (fix pass). */
  retired: number;
  failed: number;
  truncated: boolean;
  /** DEC-90 ruling (4) (DF-P7 final fix pass): how many rows each set's read
   *  returned this run, and whether that set had more than the read cap —
   *  so a truncated set is visible in the cron's result, not only a flag. */
  sets: { running: { read: number; more: boolean }; planned: { read: number; more: boolean } };
  errors: string[];
}

/** `engineeringFirstTypes` null: the org's request types could not be read
 *  (the close then cannot re-check the engineered lane and waits a run). */
interface OrgCtx { members: Member[]; policy: CapabilityPolicy; sodActive: boolean; engineeringFirstTypes: string[] | null }

/** A roster ledger row (ticket_review_slots, 20261242) as the window reads it. */
interface LedgerSlot {
  slot_kind: string; mode: string; status: string; primaries: string[] | null; alternates?: string[] | null; overriders?: string[] | null;
  independent_of: string[] | null; fallback: boolean | null; satisfied_by?: string | null; satisfied_via?: string | null;
}

const AUDIT_ACTION = "TICKET_CONSENT_WINDOW_ADVANCE";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The most source documents one issuing close reads; more is "not checked". */
const SOURCE_READ_CAP = 100;

/**
 * ONE step of the maintenance cron. Never throws; every failure is a line in
 * `errors`, and a ticket whose step failed is left exactly as it was for the
 * next run (no stamp without its rows; no advance without its audit row).
 */
export async function runConsentWindowScan(deps: { client: Db; now?: number; deadlineAt?: number; maxTickets?: number; pivot?: string; origin?: string | null }): Promise<ConsentScanReport> {
  const sb = deps.client;
  const now = deps.now ?? Date.now();
  const maxTickets = deps.maxTickets ?? 200;
  const report: ConsentScanReport = { schemaReady: false, scanned: 0, opened: 0, warned: 0, advanced: 0, issued: 0, held: 0, retired: 0, failed: 0, truncated: false,
    sets: { running: { read: 0, more: false }, planned: { read: 0, more: false } }, errors: [] };
  const say = (line: string) => report.errors.push(`consent-window: ${line}`);
  const pastDeadline = () => deps.deadlineAt !== undefined && Date.now() >= deps.deadlineAt;

  const { error: probeErr } = await sb.from("tickets").select("consent_window_opened_at").limit(1);
  if (probeErr) {
    if (isMissingConsentColumn(probeErr)) say(`not run — consent windows start when ${CONSENT_WINDOW_MIGRATION} is pasted; until then every consent slot waits for a sign-off, as before`);
    else say(`not run — whether consent windows are in the database could not be read: ${probeErr.message}`);
    return report;
  }
  report.schemaReady = true;

  const orgs = new Map<string, OrgCtx | null>();
  const orgOf = async (orgId: string): Promise<OrgCtx | null> => {
    if (orgs.has(orgId)) return orgs.get(orgId) ?? null;
    const [members, policy, cfg] = await Promise.all([
      loadPickerMembers(orgId, sb as never),
      loadCapabilityPolicyStrict(orgId, sb as never),
      // DRAFT-2: the engineering-first request types (the route's gate too).
      (async (): Promise<string[] | null> => {
        try {
          const { data, error } = await sb.from("org_configurations").select("data").eq("org_id", orgId).eq("key", "drafting").maybeSingle();
          if (error) return null;
          return flaggedRequestTypes((data as { data?: unknown } | null)?.data, "engineeringFirst");
        } catch { return null; }
      })(),
    ]);
    let ctx: OrgCtx | null = null;
    if (!members.ok) say(`org ${orgId}: its members could not be read — nothing was done for its consent windows this run: ${members.error}`);
    else if (!policy.ok) say(`org ${orgId}: its permission policy could not be read — nothing was done for its consent windows this run: ${policy.error}`);
    else ctx = { members: members.rows, policy: policy.policy, sodActive: members.rows.length >= 3, engineeringFirstTypes: cfg };
    orgs.set(orgId, ctx);
    return ctx;
  };

  // Each run reads from a random point of the id space and wraps round (no
  // cursor to keep): rows that stay in a set for a long time (a planned
  // window already open, a window waiting on other sign-offs) can never hold
  // the first places of every run and starve the rest (fix pass).
  const pivot = deps.pivot ?? crypto.randomUUID();
  const base = () => sb.from("tickets").select("*").eq("status", "PENDING_REVIEW").is("archived_at", null);
  const readRotated = async (narrow: (q: ReturnType<typeof base>) => ReturnType<typeof base>): Promise<{ rows: Array<Record<string, unknown>>; more: boolean; error: string | null }> => {
    const { data: a, error: aErr } = await narrow(base()).gte("id", pivot).order("id").limit(maxTickets + 1);
    if (aErr) return { rows: [], more: false, error: aErr.message };
    const first = (a as Array<Record<string, unknown>> | null) ?? [];
    if (first.length > maxTickets) return { rows: first.slice(0, maxTickets), more: true, error: null };
    const { data: b, error: bErr } = await narrow(base()).lt("id", pivot).order("id").limit(maxTickets + 1 - first.length);
    if (bErr) return { rows: first, more: false, error: bErr.message };
    const all = [...first, ...((b as Array<Record<string, unknown>> | null) ?? [])];
    return { rows: all.slice(0, maxTickets), more: all.length > maxTickets, error: null };
  };
  // The planned set is the reviews whose plan is still `open` — a window
  // that opened is marked `opened` (markConsentPlanOpened, DEC-90 ruling
  // (4)), so the set holds only reviews that still need an open.
  const [running, planned] = await Promise.all([
    readRotated((q) => q.not("consent_window_opened_at", "is", null).is("consent_window_expired_at", null).is("consent_window_objected_at", null)),
    readRotated((q) => q.eq("metadata->review_roster->consentPlan->>kind", "open")),
  ]);
  report.sets = { running: { read: running.rows.length, more: running.more }, planned: { read: planned.rows.length, more: planned.more } };
  if (running.error) say(`the running windows could not be read — none was reminded or closed this run: ${running.error}`);
  if (planned.error) say(`the windows still to open could not be read — none was retried this run: ${planned.error}`);
  const rows = new Map<string, Record<string, unknown>>();
  for (const r of [...running.rows, ...planned.rows]) rows.set(String(r.id), r);
  if (running.more || planned.more) report.truncated = true;

  for (const row of rows.values()) {
    if (pastDeadline()) { report.truncated = true; break; }
    report.scanned += 1;
    try {
      await handleTicket(row);
    } catch (e) {
      report.failed += 1;
      say(`ticket ${String(row.id)}: ${(e as Error)?.message ?? String(e)} — left as it was for the next run`);
    }
  }
  return report;

  /** The roster's ledger rows (service-written — the authority a forged
   *  metadata roster cannot change), or the error. */
  async function ledgerOf(ticketId: string, rosterId: string): Promise<{ slots: LedgerSlot[] } | { error: string }> {
    const { data, error } = await sb.from("ticket_review_slots")
      .select("slot_kind, mode, status, primaries, alternates, overriders, independent_of, fallback, satisfied_by, satisfied_via").eq("ticket_id", ticketId).eq("roster_id", rosterId);
    if (error) return { error: error.message || "refused" };
    return { slots: ((data as LedgerSlot[] | null) ?? []) };
  }

  /** DEC-90 ruling (1) (merge-time fix pass): does the request's EFFECTIVE
   *  routing table, read now, still make `slotKind` a confirmed consent
   *  slot that is not the engineering sign-off? `transient`: the routing
   *  could not be read (proves nothing — nothing is done, retried). */
  async function routingConfirms(ticket: ReturnType<typeof rowToTicket>, slotKind: string): Promise<{ ok: true } | { ok: false; transient: boolean; why: string }> {
    let routing: Awaited<ReturnType<typeof ticketReviewRouting>>["routing"];
    try {
      // Loaded here, as the workflow route loads it (registering the scoped
      // client at module load would bind every importer of this module).
      const { runWithServerClient } = await import("@/lib/serverClientScope");
      routing = (await runWithServerClient(sb, () => ticketReviewRouting({
        id: ticket.id!, orgId: ticket.orgId, libraryId: ticket.libraryId ?? null, sourceDocumentId: parseSourceDocument(ticket.metadata)?.id ?? null,
      }))).routing;
    } catch (e) {
      return { ok: false, transient: true, why: `the request's routing table could not be read (${(e as Error)?.message ?? String(e)})` };
    }
    if (routing.state === "unconfigured") return { ok: false, transient: false, why: "no routing table applies to the request any more" };
    if (routing.state === "invalid") return { ok: false, transient: false, why: `the routing table on the request's ${routing.level} can't be used (${routing.error})` };
    const rs = routing.control.slots.find((x) => x.kind === slotKind);
    if (!rs || rs.mode !== "consent_window") return { ok: false, transient: false, why: "the routing table no longer makes it a consent slot" };
    if (rs.consent_confirmed !== true) return { ok: false, transient: false, why: "the routing table has not confirmed it as a consent window (it was saved when the editor said it waits like a sign-off)" };
    if (rs.fill.capability && CONSENT_REFUSED_CAPABILITIES.includes(rs.fill.capability)) return { ok: false, transient: false, why: "the routing table fills it with the engineering sign-off, which silence never stands in for" };
    return { ok: true };
  }

  async function handleTicket(row: Record<string, unknown>): Promise<void> {
    const ticket = rowToTicket(row);
    const state = consentWindowFromRow(row);
    const roster = currentRoster(ticket);
    if (!state || !ticket.id) return;
    const plan = roster?.consentPlan;

    // (0) A window left running by a review that moved on — its slot was
    // signed by a person, or the review was replaced (a revision and a
    // resubmission) or closed — is retired: its expiry is stamped, so it is
    // never reminded or closed and stops taking a place in every run. (A
    // replacement review with its own window still to open is retried below
    // instead — open_consent_window resets the columns.)
    const running = !!state.openedAt && !state.expiredAt && !state.objectedAt;
    const stale = running && (!roster || !!roster.closedAt || roster.id !== state.rosterId
      || !roster.slots.some((s) => s.kind === state.slot && s.mode === "consent_window" && s.status === "open"));
    if (stale && !(roster && plan?.kind === "open" && state.rosterId !== roster.id)) {
      const { data: done, error } = await sb.from("tickets").update({ consent_window_expired_at: new Date(now).toISOString() })
        .eq("id", ticket.id).eq("consent_window_roster", state.rosterId).is("consent_window_expired_at", null).is("consent_window_objected_at", null).select("id");
      if (error) { report.failed += 1; say(`ticket ${ticket.id}: a window its review no longer waits on could not be retired (retried next run): ${error.message}`); return; }
      if (Array.isArray(done) && done.length > 0) report.retired += 1;
      return;
    }
    if (!roster) return;
    // DEC-90 ruling (4): a plan still `open` whose window already opened on
    // this roster (the route's or an earlier run's mark did not land) is
    // marked now, so it leaves the planned set; the window itself is
    // reminded or closed below exactly as before.
    if (plan?.kind === "open" && state.openedAt && state.rosterId === roster.id) {
      const markErr = await markConsentPlanOpened(sb, { ticketId: ticket.id, rosterId: roster.id });
      if (markErr) say(`ticket ${ticket.id}: its consent plan could not be marked opened (retried next run): ${markErr}`);
    }
    const ctx = await orgOf(ticket.orgId);
    if (!ctx) return;
    const nameOf = memberNameOf(ctx.members);
    const ticketLabel = `${ticket.ticketId || ""} ${ticket.title || ""}`.trim() || "a drafting request";

    // (1) A window the route planned but could not open — retried here,
    // asking only who the LEDGER's slot names (never the metadata's plan
    // alone), less the drafter and any party the slot is independent of.
    if (plan?.kind === "open" && state.rosterId !== roster.id) {
      if (!roster.slots.some((s) => s.kind === plan.slot && s.status === "open")) return;
      const ledger = await ledgerOf(ticket.id, roster.id);
      if ("error" in ledger) { report.failed += 1; say(`ticket ${ticket.id}: the review's ledger could not be read — the consent window was not retried: ${ledger.error}`); return; }
      const ls = ledger.slots.find((x) => x.slot_kind === plan.slot);
      if (!ls || ls.mode !== "consent_window" || ls.status !== "open" || ls.fallback) {
        report.failed += 1;
        say(`ticket ${ticket.id}: the review's ledger does not show "${plan.label}" as an open consent slot — no window is opened; it waits for a sign-off`);
        return;
      }
      // DEC-90 ruling (1) (merge-time fix pass): the effective routing slot,
      // read now — confirmed, and never the engineering sign-off — or no
      // window. A routing read that fails is retried; a slot the table does
      // not confirm is blocked once (the plan marked, the queue told).
      const confirmed = await routingConfirms(ticket, plan.slot);
      if (!confirmed.ok) {
        if (confirmed.transient) { report.failed += 1; say(`ticket ${ticket.id}: ${confirmed.why} — the consent window was not retried; "${plan.label}" waits for a sign-off`); return; }
        await blockPlannedWindow(ticket, roster, plan, ctx, row, { reason: `${confirmed.why}, so no window was opened — it waits for a sign-off`, refusal: { code: "routing_unconfirmed", error: confirmed.why } });
        return;
      }
      // DF-P22 (the DF-P7 final fix pass residual; DEC-90 ruling (3)): the
      // retry re-reads the engineered lane exactly as the close does — the
      // ticket's column, the requester's current roles under the current
      // policy, the engineering-first types, and a like-in-kind
      // declaration's e-signature (lib/reviewModel.ts
      // declarationSignatureStands, as the route reads it at submission). A
      // declaration known not to stand makes this engineered work: no window
      // is opened, the plan becomes a sign-off (said), and nobody is asked
      // to object to something silence could never advance. A read that
      // fails proves nothing: not retried this run (a recorded line).
      const lane = await engineeredLaneNow(ticket, ctx);
      if (lane.state === "unreadable") { report.failed += 1; say(`ticket ${ticket.id}: ${lane.why} — the consent window was not retried (retried next run); "${plan.label}" waits for a sign-off`); return; }
      if (lane.state === "engineered") {
        await blockPlannedWindow(ticket, roster, plan, ctx, row, {
          reason: CONSENT_REASON.engineered,
          refusal: { code: lane.declarationMissing ? "declaration_unverified" : "engineered", error: lane.declarationMissing ? "the like-in-kind declaration's e-signature does not stand" : "the request is engineered work" },
        }, { signOff: true });
        return;
      }
      // DEC-37 slot-to-slot (fix pass 2): nor anyone who signed, or can
      // still sign, a slot this one must be independent of — read from the
      // ledger (and the roster: either one names them). Only people still
      // active members are asked (open_consent_window refuses the whole set
      // otherwise, on every run).
      const conflicted = new Set([
        ...consentConflictedPeople(ledger.slots.map(ledgerIndependenceSlot), plan.slot),
        ...consentConflictedPeople(roster.slots, plan.slot),
      ]);
      const allowed = new Set(consentRecipients({ primaries: ls.primaries ?? [], independentOf: ls.independent_of ?? [] }, { drafterId: ticket.assignedDrafterId, requesterId: ticket.requesterId }, conflicted));
      const active = new Set(ctx.members.map((m) => String(m.uid ?? "")));
      const recipients = plan.recipients.filter((u) => allowed.has(u) && active.has(u));
      if (recipients.length === 0) {
        await blockPlannedWindow(ticket, roster, plan, ctx, row);
        return;
      }
      const r = await openConsentWindow(sb, { ticketId: ticket.id, orgId: ticket.orgId, roster, plan: { ...plan, recipients }, nameOf, ticketLabel, members: ctx.members, origin: deps.origin, now, issueAsIs: issueAsIsMarkOf(ticket) });
      if (r.ok) {
        report.opened += 1;
        if (r.emailError) say(`ticket ${ticket.id}: the consent window opened (everyone asked was told in the app), but ${r.emailError}`);
        if (r.planMarkError) say(`ticket ${ticket.id}: the consent window opened, but its plan was not marked opened (retried next run): ${r.planMarkError}`);
      } else if (!r.missing && r.code && CONSENT_OPEN_PERMANENT_CODES.has(r.code)) {
        // Fix pass 3: a refusal no retry can change — blocked once, told
        // once, never read again (the slot waits for a sign-off).
        await blockPlannedWindow(ticket, roster, plan, ctx, row, { reason: `the database refused to open its window (${r.error}), so no window was opened — it waits for a sign-off`, refusal: { code: r.code, error: r.error } });
      } else { report.failed += 1; say(`ticket ${ticket.id}: the consent window still could not be opened — "${plan.label}" waits for a sign-off: ${r.error}`); }
      return;
    }

    const step = consentWindowStep(state, roster, now);
    if (step === "none") return;
    const slot = roster.slots.find((s) => s.kind === state.slot)!;
    const label = slot.label || slot.kind;

    // (2) The reminder (DEC-39): the people asked plus the assignment queue,
    // recorded in the same transaction as its rows.
    if (step === "warn") {
      // The assigner, resolved for THIS request (its request type and unit),
      // as the route's block escalation resolves it (fix pass 2).
      const queue = assignmentQueueOf({ members: ctx.members, policy: ctx.policy, resource: ticketResource(ticket), requesterId: ticket.requesterId }).filter((u) => !state.recipients.includes(u));
      const recipients = [...state.recipients, ...queue];
      const nowIso = new Date(now).toISOString();
      const title = `Reminder: you may object · ${ticketLabel}`.slice(0, 200);
      // FRIC-5 (fix pass 3): the reminder repeats the issue-as-is note when
      // the opening notice named the mark (and the mark still stands).
      const asIs = issueAsIsNamedAtOpen(ticket, state.openedAt) ? ` ${CONSENT_ISSUE_AS_IS_NOTE}` : "";
      const body = `"${label}" goes ahead without objection when its window closes ${recordMoment(state.closesAt)}.${asIs} Open the request to object or to sign off.`;
      const emailPlan = await planConsentEmails(sb, { recipients, members: ctx.members });
      const { error } = await sb.rpc("record_consent_window_warning", {
        p_ticket: ticket.id,
        p_roster: roster.id,
        p_recipients: recipients,
        p_title: title,
        p_body: body,
        p_history: historyEntry(`Consent window reminder — ${label}`, `${warnedHistoryDetails({ label, recipients: state.recipients, queue, nameOf, at: now, closesAt: state.closesAt! })}${asIs}${consentChannelNote(emailPlan, nameOf)}`, nowIso),
      });
      if (error) { report.failed += 1; say(`ticket ${ticket.id}: the reminder was not sent, so the window cannot close yet (retried next run): ${error.message}`); return; }
      report.warned += 1;
      const emailErr = await queueConsentEmails(sb, { orgId: ticket.orgId, ticketId: ticket.id, rosterId: roster.id, slotKind: state.slot, phase: "warned", plan: emailPlan, subject: title, text: body, origin: deps.origin });
      if (emailErr) say(`ticket ${ticket.id}: the reminder went out in the app, but ${emailErr}`);
      return;
    }

    // (3) The window closed with no objection.
    await closeWindow(ticket, roster, state, slot.kind, label, ctx, nameOf, row);
  }

  /** A planned window nobody can be asked on any more (everyone it named
   *  left the org, or must stay independent of the slot): recorded as a
   *  block, the assignment queue told ONCE, and the plan marked "blocked" on
   *  the roster (compare-and-set) so later runs stop retrying it. The slot
   *  waits for a sign-off, as any blocked consent slot does (DEC-39). */
  async function blockPlannedWindow(
    ticket: ReturnType<typeof rowToTicket>,
    roster: TicketReviewRoster,
    plan: Extract<TicketConsentPlan, { kind: "open" }>,
    ctx: OrgCtx,
    row: Record<string, unknown>,
    /** Fix pass 3: a permanent refusal of open_consent_window, worded. */
    why?: { reason: string; refusal: { code: string; error: string } },
    /** DF-P22: the request turned out to be engineered work — the plan
     *  becomes an ordinary sign-off (as planConsentWindow plans one for
     *  engineered work at submission): the assignment queue is not told,
     *  because nothing is blocked; the slot simply waits for a sign-off. */
    opts?: { signOff?: boolean },
  ): Promise<void> {
    const ticketId = ticket.id!;
    const nowIso = new Date(now).toISOString();
    const reason = why?.reason ?? CONSENT_REASON.noLongerAskable;
    const blocked: TicketConsentPlan = opts?.signOff
      ? { kind: "sign_off", slot: plan.slot, label: plan.label, reason }
      : { kind: "blocked", slot: plan.slot, label: plan.label, reason };
    const meta = ((row.metadata as Record<string, unknown> | null) ?? {}) as Record<string, unknown>;
    let q = sb.from("tickets").update({ metadata: { ...meta, review_roster: { ...roster, consentPlan: blocked } }, last_modified: nowIso })
      .eq("id", ticketId).eq("status", "PENDING_REVIEW");
    q = ticket.lastModified ? q.eq("last_modified", String(ticket.lastModified)) : q.is("last_modified", null);
    const { data: landed, error } = await q.select("id");
    if (error || !Array.isArray(landed) || landed.length === 0) {
      report.failed += 1;
      say(`ticket ${ticketId}: ${why ? `the consent window for "${plan.label}" was refused for good (${why.refusal.error})` : `nobody "${plan.label}" names may still be asked`}, and the block could not be recorded (${error ? error.message : "the request changed first"}) — retried next run; it waits for a sign-off`);
      return;
    }
    if (opts?.signOff) {
      // DF-P22: engineered work waits for a sign-off; nobody is escalated.
      say(`ticket ${ticketId}: "${plan.label}" — ${reason}; no window is opened (${why?.refusal.error ?? "engineered work"})`);
      const evErr = await recordNoticeEvents(sb, [{
        org_id: ticket.orgId, ticket_id: ticketId, roster_id: roster.id, slot_kind: plan.slot, kind: "blocked",
        recipient: null, actor_name: CONSENT_WINDOW_ACTOR,
        details: { reason: "window_never_opened", why: reason, planned: plan.recipients, escalatedTo: [], ...(why ? { refusal: why.refusal } : {}) },
      }]);
      if (evErr && evErr !== "missing") say(`ticket ${ticketId}: the sign-off plan was not recorded on the notice record: ${evErr}`);
      return;
    }
    report.failed += 1;
    const queue = assignmentQueueOf({ members: ctx.members, policy: ctx.policy, resource: ticketResource(ticket), requesterId: ticket.requesterId });
    // DEC-90 ruling (1): the bell first; the line and the notice event say
    // the queue was told only when its bell rows landed.
    let bellError: string | null = null;
    if (queue.length > 0) {
      const ticketLabel = `${ticket.ticketId || ""} ${ticket.title || ""}`.trim() || "a drafting request";
      const { error: bellErr } = await notifyBatchWithReason(queue.map((uid) => ({
        orgId: ticket.orgId, userId: uid, kind: "ticket_status" as const,
        title: `Nobody to ask · ${ticketLabel}`.slice(0, 200),
        body: `"${plan.label}" is a consent slot, but ${reason}. Check the routing table or the roles.`,
        link: `/requests/${ticketId}`, resourceType: "ticket", resourceId: ticketId,
        actorName: "System",
        metadata: { action: "consent_window_blocked", slot: plan.slot },
      })), sb as never);
      if (bellErr) { bellError = bellErr; say(`ticket ${ticketId}: the assignment queue was not told of the block: ${bellErr}`); }
    }
    const told = queue.length > 0 && !bellError;
    say(`ticket ${ticketId}: ${why ? `the consent window for "${plan.label}" was refused for good (${why.refusal.error}) — it is not tried again` : `nobody "${plan.label}" names may still be asked`} — no window is opened; it waits for a sign-off${told ? " and the assignment queue was told" : ""}`);
    const evErr = await recordNoticeEvents(sb, [{
      org_id: ticket.orgId, ticket_id: ticketId, roster_id: roster.id, slot_kind: plan.slot, kind: "blocked",
      recipient: null, actor_name: CONSENT_WINDOW_ACTOR,
      details: { reason: "window_never_opened", why: reason, planned: plan.recipients, escalatedTo: told ? queue : [], ...(bellError ? { notTold: queue, escalationError: bellError } : {}), ...(why ? { refusal: why.refusal } : {}) },
    }]);
    if (evErr && evErr !== "missing") say(`ticket ${ticketId}: the block was not recorded on the notice record: ${evErr}`);
  }

  /** HAND-7 (DF-P6) as the route runs it before an issuing approval: has a
   *  source document moved since the request was raised? A read that fails
   *  (or more sources than one read takes) proves nothing — "unchecked". */
  async function sourceDriftOf(ticket: ReturnType<typeof rowToTicket>): Promise<{ moved: string[]; unchecked: boolean }> {
    const refs = parseSourceDocuments(ticket.metadata).filter((r) => UUID_RE.test(r.id));
    if (refs.length === 0) return { moved: [], unchecked: false };
    if (refs.length > SOURCE_READ_CAP) return { moved: [], unchecked: true };
    const { data, error } = await sb.from("documents").select("id, rev, current_version_id, document_number")
      .eq("org_id", ticket.orgId).in("id", refs.map((r) => r.id));
    if (error) return { moved: [], unchecked: true };
    const live = new Map(((data as Array<{ id: string; rev: string | null; current_version_id: string | null; document_number: string | null }> | null) ?? []).map((d) => [d.id, d]));
    const moved: string[] = [];
    for (const ref of refs) {
      const d = live.get(ref.id);
      if (!d) continue;
      if (revDrift({ versionId: ref.versionId, rev: ref.rev }, { versionId: d.current_version_id, rev: d.rev }) === "drifted") {
        moved.push(`${ref.documentNumber || d.document_number || "a source document"}${ref.rev ? ` raised on Rev ${ref.rev}` : ""}, now Rev ${d.rev ?? "—"}`);
      }
    }
    return { moved, unchecked: false };
  }

  /**
   * DEC-90 ruling (1) at the close (DF-P7 fix pass 3) and ruling (3) (final
   * fix pass), shared by the close and — DF-P22 — the cron's retry of a
   * planned open: is this request engineered work NOW? Read as the route
   * reads it at submission: the ticket's column, the requester's CURRENT
   * roles (DEC-16; a requester no longer active holds nothing), the org's
   * current policy and engineering-first types, and — for a declared
   * like-in-kind request — the declaration's e-signature, judged by
   * lib/reviewModel.ts declarationSignatureStands (a signature known not to
   * stand is UNDECLARED work: engineered). Types or a signature that cannot
   * be read prove nothing ("unreadable"). An undeclared request never reads
   * e_signatures.
   */
  async function engineeredLaneNow(ticket: ReturnType<typeof rowToTicket>, ctx: OrgCtx): Promise<{ state: "engineered" | "not_engineered"; declarationMissing: boolean } | { state: "unreadable"; why: string }> {
    if (ctx.engineeringFirstTypes === null) {
      return { state: "unreadable", why: "the workspace's request types could not be read, so whether this request is engineered work is unknown" };
    }
    let declarationMissing = false;
    if (ticket.engineeringRequired === false && isDeclaredLikeInKind(ticket)) {
      const sigId = ticket.likeInKindSignatureId ?? "";
      let dsig: DeclarationSignatureRow | null = null;
      if (UUID_RE.test(sigId)) {
        const { data, error } = await sb.from("e_signatures").select("id, org_id, resource_type, resource_id, signer_user_id").eq("id", sigId).maybeSingle();
        if (error) return { state: "unreadable", why: `the like-in-kind declaration's signature could not be read, so whether this request is engineered work is unknown: ${error.message}` };
        dsig = (data as DeclarationSignatureRow | null) ?? null;
      }
      declarationMissing = !declarationSignatureStands(dsig, { id: ticket.id!, orgId: ticket.orgId, likeInKindDeclaredBy: ticket.likeInKindDeclaredBy });
    }
    const requesterMember = ticket.requesterId ? ctx.members.find((m) => m.uid === ticket.requesterId) ?? null : null;
    const engineered = declarationMissing || ticket.engineeringRequired === true
      || engineeringGateRequired(ticket, heldRoles(requesterMember as { role?: unknown; roles?: unknown } | null), ctx.policy)
      || ctx.engineeringFirstTypes.includes(ticket.requestType);
    return { state: engineered ? "engineered" : "not_engineered", declarationMissing };
  }

  async function closeWindow(
    ticket: ReturnType<typeof rowToTicket>,
    roster: TicketReviewRoster,
    state: ConsentWindowState,
    slotKind: string,
    label: string,
    ctx: OrgCtx,
    nameOf: (uid: string) => string,
    row: Record<string, unknown>,
  ): Promise<void> {
    const ticketId = ticket.id!;
    // The ledger first: the window's slot must be an open consent slot there
    // (the service-written record — a forged metadata roster cannot open,
    // close or complete a window).
    const ledger = await ledgerOf(ticketId, roster.id);
    if ("error" in ledger) { report.failed += 1; say(`ticket ${ticketId}: the review's ledger could not be read — the window was not closed (retried next run): ${ledger.error}`); return; }
    const ls = ledger.slots.find((x) => x.slot_kind === slotKind);
    if (!ls || ls.mode !== "consent_window" || ls.status !== "open") {
      report.failed += 1;
      say(`ticket ${ticketId}: the review's ledger does not show "${label}" as an open consent slot — the window was not closed; it waits for a sign-off`);
      return;
    }
    // DEC-90 ruling (1) (merge-time fix pass): the effective routing slot,
    // read now — a window closes on silence only while the table still
    // confirms the slot as a consent window that is not the engineering
    // sign-off. Otherwise it is not closed (nothing written); it waits for a
    // sign-off.
    const confirmed = await routingConfirms(ticket, slotKind);
    if (!confirmed.ok) {
      report.failed += 1;
      say(`ticket ${ticketId}: ${confirmed.why} — the window was not closed${confirmed.transient ? " (retried next run)" : ""}; "${label}" waits for a sign-off`);
      return;
    }
    // DEC-90 ruling (1) at the close (fix pass 3) and ruling (3) (final fix
    // pass): never on engineered work — re-read now (engineeredLaneNow, the
    // one rule the retry shares). A read that fails proves nothing: the
    // close waits a run.
    const lane = await engineeredLaneNow(ticket, ctx);
    if (lane.state === "unreadable") {
      report.failed += 1;
      say(`ticket ${ticketId}: ${lane.why} — the window was not closed (retried next run)`);
      return;
    }
    const declarationMissing = lane.declarationMissing;
    const engineered = lane.state === "engineered";
    // The record of delivery: the "delivered" events open_consent_window wrote.
    const { data: evs, error: evErr } = await sb.from("ticket_notice_events")
      .select("recipient, notification_id").eq("ticket_id", ticketId).eq("roster_id", roster.id).eq("kind", "delivered");
    if (evErr) { report.failed += 1; say(`ticket ${ticketId}: the delivery record could not be read — the window was not closed (retried next run): ${evErr.message}`); return; }
    const delivered = new Map<string, string>();
    for (const e of (evs as Array<{ recipient?: string | null; notification_id?: string | null }> | null) ?? []) {
      if (e.recipient && e.notification_id) delivered.set(e.recipient, e.notification_id);
    }
    const ids = [...delivered.values()];
    const readAt = new Map<string, string | null>();
    if (ids.length > 0) {
      const { data: notes, error: nErr } = await sb.from("notifications").select("id, read_at").in("id", ids);
      if (nErr) { report.failed += 1; say(`ticket ${ticketId}: whether the people asked opened their notice could not be read — the window was not closed (retried next run): ${nErr.message}`); return; }
      for (const n of (notes as Array<{ id: string; read_at: string | null }> | null) ?? []) readAt.set(n.id, n.read_at ?? null);
    }
    const states = noticeStates(state.recipients, delivered, readAt);
    const nowIso = new Date(now).toISOString();
    const activeUids = new Set(ctx.members.map((m) => String(m.uid ?? "")));

    // DEC-38: a person with no delivery record was never asked — never consent.
    const undelivered = states.filter((s) => s.state === "not_delivered").map((s) => s.uid);
    const asked = states.filter((s) => s.state !== "not_delivered").map((s) => s.uid);
    // Fix pass 3: a person told who is no longer an active member (suspended
    // or removed during the window) could not object — their silence is not
    // counted, and the record says so.
    const askedActive = asked.filter((u) => activeUids.has(u));
    const departed = asked.filter((u) => !activeUids.has(u));
    const details = `${advancedHistoryDetails({ state, states, nameOf, closedAt: now })}${departed.length ? ` No longer an active member, so their silence is not counted: ${departed.map(nameOf).join(", ")}.` : ""}`;
    const advancedRoster: TicketReviewRoster = { ...roster, slots: roster.slots.map((s) => (s.kind === slotKind && s.status === "open" ? consentSatisfiedSlot(s, nowIso) : s)) };
    // DEC-12 / DEC-37: the floor as it reads for silence (consentFloorHolds
    // stands in for rosterCompletion's floor, which never counts a window).
    const floorHolds = consentFloorHolds(advancedRoster, { sodActive: ctx.sodActive, drafterId: ticket.assignedDrafterId }, asked);
    // DEC-37 slot-to-slot (fix pass 2): someone told must be independent of
    // every slot this one must be independent of — read from the ledger and
    // the roster (either one naming a person is enough to hold).
    const conflicted = new Set([
      ...consentConflictedPeople(ledger.slots.map(ledgerIndependenceSlot), slotKind),
      ...consentConflictedPeople(roster.slots, slotKind),
    ]);
    const independenceHolds = consentIndependenceHolds(asked, ticket.assignedDrafterId, conflicted);
    // Fix pass 3: the same two floors over the people STILL active — a
    // window whose only independent people told have left holds.
    const noLongerMember = !floorHolds && !independenceHolds
      && (consentFloorHolds(advancedRoster, { sodActive: ctx.sodActive, drafterId: ticket.assignedDrafterId }, askedActive)
        || consentIndependenceHolds(askedActive, ticket.assignedDrafterId, conflicted));
    const onlyDrafterSlot = ctx.sodActive ? drafterOnlyOpenSlot(advancedRoster, ticket.assignedDrafterId) : null;
    // Would this close issue the request? Only when the roster is complete
    // AND the ledger agrees every other blocking slot is signed.
    const wouldIssue = rosterCompletion(advancedRoster).complete;
    const ledgerAgrees = ledger.slots.filter((x) => x.mode !== "notify_only" && x.slot_kind !== slotKind && x.status !== "void").every((x) => x.status === "satisfied");
    let drift: { moved: string[]; unchecked: boolean } = { moved: [], unchecked: false };
    if (undelivered.length === 0 && !engineered && !floorHolds && !independenceHolds && !noLongerMember && wouldIssue && ledgerAgrees) drift = await sourceDriftOf(ticket);
    const holdReason: ConsentHoldReason | null = undelivered.length > 0 ? "undelivered"
      : engineered ? "engineered"
      : floorHolds ? "producer_floor"
      : independenceHolds ? "independence"
      : noLongerMember ? "no_longer_member"
      : wouldIssue && !ledgerAgrees ? "record_mismatch"
      : drift.moved.length > 0 ? "source_moved"
      : drift.unchecked ? "source_unchecked"
      : null;
    const held = holdReason !== null;
    const finalRoster = held ? roster : advancedRoster;
    const complete = !held && wouldIssue;
    const heldWhy = holdReason === "undelivered" ? ` No delivery is on record for ${undelivered.map(nameOf).join(", ")}, so this is not consent: "${label}" waits for a sign-off.`
      : holdReason === "producer_floor" ? (!asked.some((u) => u !== ticket.assignedDrafterId)
        ? ` Nobody but the drafter was asked, and the drafter's silence is never a sign-off: "${label}" waits for a sign-off.`
        : onlyDrafterSlot
          ? ` "${onlyDrafterSlot.label || onlyDrafterSlot.kind}" can be signed only by the drafter, and at least one sign-off must come from someone else, so silence does not stand for it: "${label}" waits for a sign-off.`
          : ` The drafter signed every other sign-off on this review, so one sign-off must come from someone else: "${label}" waits for a sign-off.`)
      : holdReason === "independence" ? ` Everyone told also signs, or can sign, a sign-off "${label}" must be independent of (${asked.filter((u) => u !== ticket.assignedDrafterId).map(nameOf).join(", ")}), so their silence is not a second look: "${label}" waits for a sign-off.`
      : holdReason === "engineered" ? ` This request is now engineered work (an engineer's sign-off is required), and a consent window never applies to it: "${label}" waits for a sign-off.`
      : holdReason === "no_longer_member" ? ` Nobody told who could have objected is still an active member (${departed.map(nameOf).join(", ") || "nobody"} left the workspace or was suspended), so silence is not consent: "${label}" waits for a sign-off.`
      : holdReason === "record_mismatch" ? ` The review's ledger does not show every other sign-off as given, so the request is not issued on silence: "${label}" waits for a sign-off.`
      : holdReason === "source_moved" ? ` The source revision has moved since this request was raised (${drift.moved.join("; ")}), and issuing over it needs a person's acknowledgement: "${label}" waits for a sign-off.`
      : holdReason === "source_unchecked" ? ` The source documents could not be checked for a newer revision, so the request is not issued on silence: "${label}" waits for a sign-off.`
      : "";

    // FRIC-5 (fix pass 3): issue as-is only on a mark the opening notice
    // named — otherwise the PENDING_IFC hop, and the mark withdrawn, said.
    const issueAsIs = complete && issueAsIsNamedAtOpen(ticket, state.openedAt);
    const marked = !!issueAsIsMarkOf(ticket);
    const { updates, newStatus } = computeTransition(ticket, {
      actionType: "consent_window_advance",
      actionLabel: "Advanced without objection",
      consentAdvance: { roster: finalRoster, complete, label, details: `${details}${heldWhy}`, held, holdReason, issueAsIs },
      actor: { uid: null, email: CONSENT_WINDOW_ACTOR, role: "System" },
      now: nowIso,
    });
    // WF-19 / LEAK-1 (fix pass 2): an issuing close ENTERS a routed status
    // (PENDING_IFC) — its pool (the issue queue and the originating
    // engineer) joins unread_by and the bell, exactly as the route adds it
    // when a sign-off completes the review. A failed read tells nobody more
    // (as the route's), said.
    let pool: string[] = [];
    if (complete && newStatus !== ticket.status && isRoutedStatus(String(newStatus), { assignedDrafterId: ticket.assignedDrafterId })) {
      try {
        pool = (await resolveTicketRecipients(ticket.orgId, newStatus as TicketStatus, undefined, sb as never, { assignedDrafterId: ticket.assignedDrafterId, assignedEngineerId: ticket.assignedEngineerId }))
          .map((m) => m.uid).filter((u) => !!u);
        if (pool.length > 0) updates.unread_by = Array.from(new Set([...((updates.unread_by as string[] | undefined) ?? []), ...pool]));
      } catch (e) {
        say(`ticket ${ticketId}: the issue queue for ${String(newStatus)} could not be resolved — it is not badged or told of this issue: ${(e as Error)?.message ?? String(e)}`);
      }
    }

    // The audit row FIRST (a recorded system act), then the compare-and-set.
    const auditId = crypto.randomUUID();
    const askedRows = states.map((s) => ({ uid: s.uid, name: nameOf(s.uid), notice: s.state, openedAt: s.openedAt, cleared: s.cleared }));
    const auditRow = {
      id: auditId, action: AUDIT_ACTION, resource_type: "ticket", resource_id: ticketId, org_id: ticket.orgId,
      user_id: null, user_email: CONSENT_WINDOW_ACTOR, user_role: "system",
      details: {
        from: ticket.status, to: newStatus, rosterId: roster.id, slot: slotKind, label, asked: askedRows,
        openedAt: state.openedAt, warnedAt: state.warnedAt, closesAt: state.closesAt, closedAt: nowIso,
        complete, held, ...(holdReason ? { holdReason } : {}),
        ...(undelivered.length ? { undelivered } : {}), ...(floorHolds ? { producerFloor: true } : {}),
        ...(independenceHolds ? { independence: { conflicted: [...conflicted].sort() } } : {}),
        ...(departed.length ? { noLongerMembers: departed } : {}),
        ...(engineered ? { engineered: true } : {}),
        ...(declarationMissing ? { declarationUnverified: "missing" } : {}),
        ...(complete && marked ? { issueAsIs: { marked, namedAtOpen: issueAsIs } } : {}),
        // HAND-7 (DF-P6), as the route records it: what moved, or that the
        // source was not checked (only an issuing close checks it).
        ...(drift.moved.length ? { sourceDrift: { moved: drift.moved, acknowledged: false } } : {}),
        ...(drift.unchecked ? { sourceDriftUnchecked: true } : {}),
        deliverable_rev: (updates.deliverable_rev as string | undefined) ?? ticket.deliverableRev ?? null,
        recordedBeforeApply: true,
      },
    };
    const { error: aErr } = await sb.from("audit_logs").insert(auditRow);
    if (aErr && (aErr as { code?: string }).code !== "23505") { report.failed += 1; say(`ticket ${ticketId}: the audit row could not be written, so the window was not closed (retried next run): ${aErr.message}`); return; }

    let q = sb.from("tickets").update(updates).eq("id", ticketId).eq("status", "PENDING_REVIEW")
      .is("consent_window_objected_at", null).is("consent_window_expired_at", null);
    q = ticket.lastModified ? q.eq("last_modified", String(ticket.lastModified)) : q.is("last_modified", null);
    const { data: landed, error: uErr } = await q.select("id");
    if (uErr || !Array.isArray(landed) || landed.length === 0) {
      report.failed += 1;
      const reason = uErr ? uErr.message : "the request changed first (an objection, a sign-off or a revision)";
      say(`ticket ${ticketId}: the window was not closed — ${reason}`);
      const { error: naErr } = await sb.from("audit_logs").insert({ ...auditRow, id: crypto.randomUUID(), action: `${AUDIT_ACTION}_NOT_APPLIED`, details: { attempt: auditId, reason: uErr ? "write_failed" : "conflict", ...(uErr ? { error: uErr.message } : {}) } });
      if (naErr) say(`ticket ${ticketId}: could not record that the close was not applied: ${naErr.message}`);
      return;
    }
    if (held) report.held += 1; else report.advanced += 1;
    if (complete) report.issued += 1;

    // The durable record (survives any bell purge): one "expired" event per
    // person asked, then the advance (or the hold) naming them all.
    const evRows: Array<Record<string, unknown>> = [
      ...states.map((s) => ({
        org_id: ticket.orgId, ticket_id: ticketId, roster_id: roster.id, slot_kind: slotKind, kind: "expired",
        recipient: s.uid, notification_id: delivered.get(s.uid) ?? null, actor_name: CONSENT_WINDOW_ACTOR,
        details: { notice: s.state, openedAt: s.openedAt, cleared: s.cleared, warnedAt: state.warnedAt, closedAt: nowIso },
      })),
      {
        org_id: ticket.orgId, ticket_id: ticketId, roster_id: roster.id, slot_kind: slotKind, kind: held ? "expired" : "advanced",
        recipient: null, actor_name: CONSENT_WINDOW_ACTOR,
        details: { asked: askedRows, openedAt: state.openedAt, warnedAt: state.warnedAt, closedAt: nowIso, complete, held, auditId, ...(holdReason ? { holdReason } : {}), ...(heldWhy ? { why: heldWhy.trim() } : {}), ...(departed.length ? { noLongerMembers: departed } : {}) },
      },
    ];
    // Fix pass 3: nobody left who could object — a block, escalated to the
    // assignment queue (DEC-39: an empty set never advances; it escalates).
    const escalate = holdReason === "no_longer_member"
      ? assignmentQueueOf({ members: ctx.members, policy: ctx.policy, resource: ticketResource(ticket), requesterId: ticket.requesterId })
      : [];
    const recErr = await recordNoticeEvents(sb, evRows);
    if (recErr) say(`ticket ${ticketId}: the window closed (audit row ${auditId}) but its notice events were not written — the ticket's history carries the record: ${recErr}`);

    // The ticket ⇄ intent bridge (fix pass 2): an issue-as-is lands at
    // FINAL_DRAFT, where the route clears the request's document intents
    // wholesale. Best-effort, said.
    if (complete && String(newStatus) === "FINAL_DRAFT") {
      const sheetIds = parseSourceDocuments(ticket.metadata).map((d) => d.id);
      for (let i = 0; i < sheetIds.length; i += SOURCE_READ_CAP) {
        const { error: iErr } = await sb.from("document_intents").delete().in("document_id", sheetIds.slice(i, i + SOURCE_READ_CAP)).eq("ticket_id", ticketId).eq("source", "ticket");
        if (iErr) { say(`ticket ${ticketId}: the request issued, but its document intents were not cleared (they lapse at their expiry): ${iErr.message}`); break; }
      }
    }

    if (!held) {
      const touched = advancedRoster.slots.filter((s) => s.kind === slotKind);
      const ledgerErr = await writeRosterLedger(sb, { orgId: ticket.orgId, ticketId, roster: advancedRoster, event: "satisfied", slots: touched, actor: { uid: null, name: CONSENT_WINDOW_ACTOR } });
      if (ledgerErr) say(`ticket ${ticketId}: the roster ledger was not written for the advance (audit row ${auditId}) — reconcile from tickets.metadata.review_roster: ${ledgerErr}`);
    }

    // Tell the people with a stake (bell): the requester, the drafter, the
    // people asked and anyone the review still waits on.
    const waiting = finalRoster.slots.filter((s) => s.mode !== "notify_only" && s.status === "open").flatMap((s) => s.primaries);
    const told = [...new Set([ticket.requesterId, ticket.assignedDrafterId, ...state.recipients, ...waiting, ...pool, ...escalate].filter((u): u is string => !!u))];
    const audience = told.filter((u) => activeUids.has(u));
    let bellLanded = false;
    if (audience.length > 0) {
      const ticketLabel = `${ticket.ticketId || ""} ${ticket.title || ""}`.trim();
      const { error: bellErr } = await notifyBatchWithReason(audience.map((uid) => ({
        orgId: ticket.orgId, userId: uid, kind: "ticket_status" as const,
        title: `${held ? "Consent window closed" : "Advanced without objection"} · ${ticketLabel}`.slice(0, 200),
        body: held ? `"${label}" still waits for a sign-off.${heldWhy}` : complete ? `Nobody objected to "${label}" — every sign-off is in; issued Rev ${String(updates.deliverable_rev ?? "")}.` : `Nobody objected to "${label}" — the review waits on the remaining sign-offs.`,
        link: `/requests/${ticketId}`, resourceType: "ticket", resourceId: ticketId,
        actorName: "System",
        metadata: { action: "consent_window_advance", status: String(newStatus) },
      })), sb as never);
      if (bellErr) say(`ticket ${ticketId}: the window closed but the bell rows were not written: ${bellErr}`);
      bellLanded = !bellErr;
    }
    // DF-P22 (PHYS-18 on a consent-completed issue — the DF-P7 hand-off;
    // DEC-44 (DF-P7-consent) item 12(a)): an issuing close supersedes the
    // copies people took of the earlier package, exactly as the route's
    // issuing sign-off does (recallSupersededTicketCopies) — run by the
    // recorded system actor (no person acted). Best-effort and after the
    // advance: nothing here can undo or delay the issue.
    if (complete && typeof updates.deliverable_rev === "string" && updates.deliverable_rev) {
      const recallErr = await recallCopiesAfterConsentIssue(sb, {
        ticket: {
          id: ticketId, orgId: ticket.orgId, status: String(newStatus), deliverableRev: updates.deliverable_rev,
          history: (updates.history as unknown) ?? ticket.history, revisionCount: ((updates.revision_count as number | undefined) ?? ticket.revisionCount) ?? null,
          historyGuardedFrom: typeof row.history_guarded_from === "number" ? row.history_guarded_from : null,
          attachments: (updates.attachments as unknown) ?? ticket.attachments,
        },
        ticketNumber: ticket.ticketId ?? null,
      });
      if (recallErr) say(`ticket ${ticketId}: the request issued (audit row ${auditId}), but the recall of superseded copies did not run: ${recallErr}`);
    }
    // DEC-90 ruling (1): the block's notice event is written after the bell
    // and names only the assignment-queue members whose bell row landed.
    if (holdReason === "no_longer_member") {
      const escalatedTo = bellLanded ? escalate.filter((u) => audience.includes(u)) : [];
      const blkErr = await recordNoticeEvents(sb, [{
        org_id: ticket.orgId, ticket_id: ticketId, roster_id: roster.id, slot_kind: slotKind, kind: "blocked",
        recipient: null, actor_name: CONSENT_WINDOW_ACTOR,
        details: { reason: "no_longer_member", noLongerMembers: departed, escalatedTo, ...(escalate.length > escalatedTo.length ? { notTold: escalate.filter((u) => !escalatedTo.includes(u)) } : {}), auditId },
      }]);
      if (blkErr) say(`ticket ${ticketId}: the block (nobody left who could object) was not recorded on the notice record: ${blkErr}`);
    }
  }
}
