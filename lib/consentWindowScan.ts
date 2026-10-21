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
// ticket_notice_events (20261255) is the record that survives any bell
// purge: append-only, written only by the service role.

import { computeTransition, rowToTicket } from "@/lib/ticketTransitions";
import { parseSourceDocuments, revDrift } from "@/lib/sourceDocRef";
import { currentRoster } from "@/lib/workflow";
import { resolveFill, rosterCompletion, writeRosterLedger, type OccupantContext } from "@/lib/ticketRoster";
import { loadPickerMembers } from "@/lib/ticketPickerMembers";
import { loadCapabilityPolicyStrict, type CapabilityPolicy, type CapabilityResource } from "@/lib/capabilityPolicy";
import { notifyBatchWithReason } from "@/lib/inAppNotifications";
import {
  CONSENT_REASON, CONSENT_WINDOW_ACTOR, CONSENT_WINDOW_MIGRATION, consentFloorHolds, consentRecipients, consentSatisfiedSlot, consentWindowFromRow,
  consentWindowStep, isMissingConsentColumn, isMissingConsentSchema, noticeStates, openedHistoryDetails,
  recordMoment, warnedHistoryDetails, advancedHistoryDetails, windowSchedule, type ConsentHoldReason, type ConsentWindowState,
} from "@/lib/consentWindow";
import type { TicketConsentPlan, TicketHistoryEntry, TicketReviewRoster } from "@/types/schema";

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

/** Open the window `plan` describes on the ticket's CURRENT roster — one
 *  transaction (open_consent_window). */
export async function openConsentWindow(db: Db, input: {
  ticketId: string;
  roster: Pick<TicketReviewRoster, "id">;
  plan: Extract<TicketConsentPlan, { kind: "open" }>;
  nameOf: (uid: string) => string;
  ticketLabel: string;
  now?: number;
}): Promise<{ ok: true; notified: number; closesAt: string } | { ok: false; missing: boolean; error: string }> {
  const now = input.now ?? Date.now();
  const { warnAt, closesAt } = windowSchedule(now, input.plan);
  const nowIso = new Date(now).toISOString();
  const details = openedHistoryDetails({ label: input.plan.label, recipients: input.plan.recipients, nameOf: input.nameOf, openedAt: now, warnAt, closesAt });
  try {
    const { data, error } = await db.rpc("open_consent_window", {
      p_ticket: input.ticketId,
      p_roster: input.roster.id,
      p_slot: input.plan.slot,
      p_recipients: input.plan.recipients,
      p_warn_at: new Date(warnAt).toISOString(),
      p_closes_at: new Date(closesAt).toISOString(),
      p_title: `You may object · ${input.ticketLabel}`.slice(0, 200),
      p_body: `"${input.plan.label}" goes ahead without your sign-off unless you object before ${recordMoment(closesAt)}. Open the request to object (your reason is recorded) or to sign off.`,
      p_history: historyEntry(`Consent window opened — ${input.plan.label}`, details, nowIso),
    });
    if (error) return { ok: false, missing: isMissingConsentSchema(error), error: error.message || "refused" };
    return { ok: true, notified: typeof data === "number" ? data : input.plan.recipients.length, closesAt: new Date(closesAt).toISOString() };
  } catch (e) {
    return { ok: false, missing: false, error: (e as Error)?.message ?? String(e) };
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
}): Promise<string | null> {
  const plan = input.roster.consentPlan;
  if (!plan || plan.kind === "sign_off") return null;
  const nameOf = memberNameOf(input.members);
  if (plan.kind === "open") {
    const r = await openConsentWindow(db, { ticketId: input.ticketId, roster: input.roster, plan, nameOf, ticketLabel: input.ticketLabel });
    if (r.ok) return null;
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
  const evErr = await recordNoticeEvents(db, [{
    org_id: input.orgId, ticket_id: input.ticketId, roster_id: input.roster.id, slot_kind: plan.slot, kind: "blocked",
    recipient: null, actor_id: input.actor.uid, actor_name: input.actor.name,
    details: { reason: plan.reason, escalatedTo: queue },
  }]);
  if (evErr && evErr !== "missing") console.error(`[consent-window] the block on ticket ${input.ticketId} was not recorded: ${evErr}`);
  if (queue.length > 0) {
    const { error } = await notifyBatchWithReason(queue.map((uid) => ({
      orgId: input.orgId, userId: uid, kind: "ticket_status" as const,
      title: `Nobody to ask · ${input.ticketLabel}`.slice(0, 200),
      body: `"${plan.label}" is a consent slot, but ${why}, so it waits for a sign-off. Check the routing table or the roles.`,
      link: `/requests/${input.ticketId}`, resourceType: "ticket", resourceId: input.ticketId,
      actorUserId: input.actor.uid, actorName: input.actor.name ?? undefined,
      metadata: { action: "consent_window_blocked", slot: plan.slot },
    })), db as never);
    if (error) console.error(`[consent-window] the assignment queue was not told of the block on ticket ${input.ticketId}: ${error}`);
  }
  return `"${plan.label}" waits for a sign-off: ${why}, so no consent window was opened${queue.length ? " — the assignment queue was told" : ""}.`;
}

/** EVID-9 (route limb): the people a transition did not email because their
 *  own preference turned that email off — one durable record each. Never
 *  throws; before 20261255 it records nothing (the table is not there). */
export async function recordNotEmailed(db: Db, input: {
  orgId: string;
  ticketId: string;
  action: string;
  eventType: string;
  optedOut: ReadonlyArray<{ uid: string; reason: string }>;
}): Promise<string | null> {
  if (input.optedOut.length === 0) return null;
  const err = await recordNoticeEvents(db, input.optedOut.map((o) => ({
    org_id: input.orgId, ticket_id: input.ticketId, kind: "not_emailed", recipient: o.uid,
    details: { reason: o.reason, byTheirChoice: true, action: input.action, eventType: input.eventType },
  })));
  return err === "missing" ? null : err;
}

/** Why a preference row turns an email off (null: it does not). */
export function emailPreferenceReason(p: Record<string, unknown> | undefined, eventType: string): string | null {
  if (!p) return null;
  if (p.email_enabled === false) return "they turned email off";
  if (p.digest_frequency === "never") return "they set email delivery to never";
  switch (eventType) {
    case "assignment":
    case "engineer_review_requested":
      return p.email_on_assignment === false ? "they turned assignment emails off" : null;
    case "ticket_status_changed":
    case "ticket_approved":
    case "ticket_revision_requested":
    case "ticket_closed":
      return p.email_on_status_change === false ? "they turned status-change emails off" : null;
    default:
      return null;
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
  errors: string[];
}

interface OrgCtx { members: Member[]; policy: CapabilityPolicy; sodActive: boolean }

/** A roster ledger row (ticket_review_slots, 20261242) as the window reads it. */
interface LedgerSlot { slot_kind: string; mode: string; status: string; primaries: string[] | null; independent_of: string[] | null; fallback: boolean | null }

const AUDIT_ACTION = "TICKET_CONSENT_WINDOW_ADVANCE";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The most source documents one issuing close reads; more is "not checked". */
const SOURCE_READ_CAP = 100;

/**
 * ONE step of the maintenance cron. Never throws; every failure is a line in
 * `errors`, and a ticket whose step failed is left exactly as it was for the
 * next run (no stamp without its rows; no advance without its audit row).
 */
export async function runConsentWindowScan(deps: { client: Db; now?: number; deadlineAt?: number; maxTickets?: number; pivot?: string }): Promise<ConsentScanReport> {
  const sb = deps.client;
  const now = deps.now ?? Date.now();
  const maxTickets = deps.maxTickets ?? 200;
  const report: ConsentScanReport = { schemaReady: false, scanned: 0, opened: 0, warned: 0, advanced: 0, issued: 0, held: 0, retired: 0, failed: 0, truncated: false, errors: [] };
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
    const [members, policy] = await Promise.all([loadPickerMembers(orgId, sb as never), loadCapabilityPolicyStrict(orgId, sb as never)]);
    let ctx: OrgCtx | null = null;
    if (!members.ok) say(`org ${orgId}: its members could not be read — nothing was done for its consent windows this run: ${members.error}`);
    else if (!policy.ok) say(`org ${orgId}: its permission policy could not be read — nothing was done for its consent windows this run: ${policy.error}`);
    else ctx = { members: members.rows, policy: policy.policy, sodActive: members.rows.length >= 3 };
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
  const [running, planned] = await Promise.all([
    readRotated((q) => q.not("consent_window_opened_at", "is", null).is("consent_window_expired_at", null).is("consent_window_objected_at", null)),
    readRotated((q) => q.eq("metadata->review_roster->consentPlan->>kind", "open")),
  ]);
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
      .select("slot_kind, mode, status, primaries, independent_of, fallback").eq("ticket_id", ticketId).eq("roster_id", rosterId);
    if (error) return { error: error.message || "refused" };
    return { slots: ((data as LedgerSlot[] | null) ?? []) };
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
      const allowed = new Set(consentRecipients({ primaries: ls.primaries ?? [], independentOf: ls.independent_of ?? [] }, { drafterId: ticket.assignedDrafterId, requesterId: ticket.requesterId }));
      const recipients = plan.recipients.filter((u) => allowed.has(u));
      if (recipients.length === 0) {
        report.failed += 1;
        say(`ticket ${ticket.id}: nobody the plan names may be asked (the drafter, a party the slot is independent of, or not the slot's own occupant) — no window is opened; "${plan.label}" waits for a sign-off`);
        return;
      }
      const r = await openConsentWindow(sb, { ticketId: ticket.id, roster, plan: { ...plan, recipients }, nameOf, ticketLabel, now });
      if (r.ok) report.opened += 1;
      else { report.failed += 1; say(`ticket ${ticket.id}: the consent window still could not be opened — "${plan.label}" waits for a sign-off: ${r.error}`); }
      return;
    }

    const step = consentWindowStep(state, roster, now);
    if (step === "none") return;
    const slot = roster.slots.find((s) => s.kind === state.slot)!;
    const label = slot.label || slot.kind;

    // (2) The reminder (DEC-39): the people asked plus the assignment queue,
    // recorded in the same transaction as its rows.
    if (step === "warn") {
      const queue = assignmentQueueOf({ members: ctx.members, policy: ctx.policy, resource: null, requesterId: ticket.requesterId }).filter((u) => !state.recipients.includes(u));
      const recipients = [...state.recipients, ...queue];
      const nowIso = new Date(now).toISOString();
      const { error } = await sb.rpc("record_consent_window_warning", {
        p_ticket: ticket.id,
        p_roster: roster.id,
        p_recipients: recipients,
        p_title: `Reminder: you may object · ${ticketLabel}`.slice(0, 200),
        p_body: `"${label}" goes ahead without objection when its window closes ${recordMoment(state.closesAt)}. Open the request to object or to sign off.`,
        p_history: historyEntry(`Consent window reminder — ${label}`, warnedHistoryDetails({ label, recipients: state.recipients, queue, nameOf, at: now, closesAt: state.closesAt! }), nowIso),
      });
      if (error) { report.failed += 1; say(`ticket ${ticket.id}: the reminder was not sent, so the window cannot close yet (retried next run): ${error.message}`); return; }
      report.warned += 1;
      return;
    }

    // (3) The window closed with no objection.
    await closeWindow(ticket, roster, state, slot.kind, label, ctx, nameOf);
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

  async function closeWindow(
    ticket: ReturnType<typeof rowToTicket>,
    roster: TicketReviewRoster,
    state: ConsentWindowState,
    slotKind: string,
    label: string,
    ctx: OrgCtx,
    nameOf: (uid: string) => string,
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
    const details = advancedHistoryDetails({ state, states, nameOf, closedAt: now });

    // DEC-38: a person with no delivery record was never asked — never consent.
    const undelivered = states.filter((s) => s.state === "not_delivered").map((s) => s.uid);
    const asked = states.filter((s) => s.state !== "not_delivered").map((s) => s.uid);
    const advancedRoster: TicketReviewRoster = { ...roster, slots: roster.slots.map((s) => (s.kind === slotKind && s.status === "open" ? consentSatisfiedSlot(s, nowIso) : s)) };
    // DEC-12 / DEC-37: the floor as it reads for silence (consentFloorHolds
    // stands in for rosterCompletion's floor, which never counts a window).
    const floorHolds = consentFloorHolds(advancedRoster, { sodActive: ctx.sodActive, drafterId: ticket.assignedDrafterId }, asked);
    // Would this close issue the request? Only when the roster is complete
    // AND the ledger agrees every other blocking slot is signed.
    const wouldIssue = rosterCompletion(advancedRoster).complete;
    const ledgerAgrees = ledger.slots.filter((x) => x.mode !== "notify_only" && x.slot_kind !== slotKind && x.status !== "void").every((x) => x.status === "satisfied");
    let drift: { moved: string[]; unchecked: boolean } = { moved: [], unchecked: false };
    if (undelivered.length === 0 && !floorHolds && wouldIssue && ledgerAgrees) drift = await sourceDriftOf(ticket);
    const holdReason: ConsentHoldReason | null = undelivered.length > 0 ? "undelivered"
      : floorHolds ? "producer_floor"
      : wouldIssue && !ledgerAgrees ? "record_mismatch"
      : drift.moved.length > 0 ? "source_moved"
      : drift.unchecked ? "source_unchecked"
      : null;
    const held = holdReason !== null;
    const finalRoster = held ? roster : advancedRoster;
    const complete = !held && wouldIssue;
    const heldWhy = holdReason === "undelivered" ? ` No delivery is on record for ${undelivered.map(nameOf).join(", ")}, so this is not consent: "${label}" waits for a sign-off.`
      : holdReason === "producer_floor" ? (asked.some((u) => u !== ticket.assignedDrafterId)
        ? ` The drafter signed every other sign-off on this review, so one sign-off must come from someone else: "${label}" waits for a sign-off.`
        : ` Nobody but the drafter was asked, and the drafter's silence is never a sign-off: "${label}" waits for a sign-off.`)
      : holdReason === "record_mismatch" ? ` The review's ledger does not show every other sign-off as given, so the request is not issued on silence: "${label}" waits for a sign-off.`
      : holdReason === "source_moved" ? ` The source revision has moved since this request was raised (${drift.moved.join("; ")}), and issuing over it needs a person's acknowledgement: "${label}" waits for a sign-off.`
      : holdReason === "source_unchecked" ? ` The source documents could not be checked for a newer revision, so the request is not issued on silence: "${label}" waits for a sign-off.`
      : "";

    const { updates, newStatus } = computeTransition(ticket, {
      actionType: "consent_window_advance",
      actionLabel: "Advanced without objection",
      consentAdvance: { roster: finalRoster, complete, label, details: `${details}${heldWhy}`, held, holdReason },
      actor: { uid: null, email: CONSENT_WINDOW_ACTOR, role: "System" },
      now: nowIso,
    });

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
        details: { asked: askedRows, openedAt: state.openedAt, warnedAt: state.warnedAt, closedAt: nowIso, complete, held, auditId, ...(holdReason ? { holdReason } : {}), ...(heldWhy ? { why: heldWhy.trim() } : {}) },
      },
    ];
    const recErr = await recordNoticeEvents(sb, evRows);
    if (recErr) say(`ticket ${ticketId}: the window closed (audit row ${auditId}) but its notice events were not written — the ticket's history carries the record: ${recErr}`);

    if (!held) {
      const touched = advancedRoster.slots.filter((s) => s.kind === slotKind);
      const ledgerErr = await writeRosterLedger(sb, { orgId: ticket.orgId, ticketId, roster: advancedRoster, event: "satisfied", slots: touched, actor: { uid: null, name: CONSENT_WINDOW_ACTOR } });
      if (ledgerErr) say(`ticket ${ticketId}: the roster ledger was not written for the advance (audit row ${auditId}) — reconcile from tickets.metadata.review_roster: ${ledgerErr}`);
    }

    // Tell the people with a stake (bell): the requester, the drafter, the
    // people asked and anyone the review still waits on.
    const waiting = finalRoster.slots.filter((s) => s.mode !== "notify_only" && s.status === "open").flatMap((s) => s.primaries);
    const told = [...new Set([ticket.requesterId, ticket.assignedDrafterId, ...state.recipients, ...waiting].filter((u): u is string => !!u))];
    const activeUids = new Set(ctx.members.map((m) => String(m.uid ?? "")));
    const audience = told.filter((u) => activeUids.has(u));
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
    }
  }
}
