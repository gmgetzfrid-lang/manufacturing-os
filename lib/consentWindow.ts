// lib/consentWindow.ts
//
// drafting-flow Round G, DF-P7 CONSENT — GAP-109 (engineering review without
// a stop: the consent window) on GAP-113 (the availability record: proving it
// was asked). DEC-38 (no delivery record, no silent advance), DEC-39 (warn
// before expiry; the record lives on the ticket; an empty set blocks).
//
// PURE and client-safe (types only): the workflow engine, the workflow route,
// the maintenance cron's step (lib/consentWindowScan.ts) and the request
// page's card all read the same rules from here.
//
// WHERE A WINDOW CAN EXIST (DEC-90 rulings for DF-P7 — fail-safe, no
// regression):
//   (1) Only on a routing slot a workspace EXPLICITLY configures as
//       `consent_window` (lib/routingControl.ts). Notify-only slots are never
//       windows. The seed and every unconfigured workspace keep today's
//       blocking behaviour exactly — they have no roster, so no slot, so no
//       window. Fix pass 3: the slot must also carry the post-DF-P7 opt-in
//       (`consent_confirmed`, stamped when a controller saves the table
//       under the consent-window label — lib/routingControl.ts
//       setRoutingControl). A consent_window slot stored while the editor
//       said it "waits like a sign-off" still waits like one, said.
//   (2) Never on the highest work class: a request whose engineering
//       requirement holds (DEC-33's engineered lane — lib/workflow.ts
//       engineeringGateRequired, or an engineering-first type) never gets a
//       window; its consent slot waits as a sign-off, said. Checked when the
//       window is planned (the submission) AND again when it closes (fix
//       pass 3 — the requester's CURRENT roles, the org's current policy and
//       engineering-first types, the ticket's column): a request that became
//       engineered work while the window ran is held ("engineered"). Never on a slot
//       that IS the engineering sign-off (filled by an engineering
//       capability, or the gate slot the roster appended): refused when the
//       routing table is saved (validateRoutingDraft), and a stored one waits
//       as a sign-off.
//   (3) One window per review: a table with more than one consent slot
//       opens none (each waits as a sign-off, said).
//   (4) An empty recipient set never advances (DEC-39): a consent slot whose
//       own fill named nobody (the roster stood the management tier in —
//       `fallback`) is BLOCKED — it waits as a sign-off and the assignment
//       queue is told (the "ack_unsatisfiable" polarity). The record says so
//       only once the bell landed (DEC-90 ruling (1), final fix pass).
//   (4a) DEC-12 / DEC-37 (fix pass): the people asked are never the
//       assigned drafter (the producer's own silence is never a check) and
//       never a party the slot declares itself independent of (`drafter`,
//       `requester`) — consentRecipients. When nobody else is left the slot
//       is BLOCKED exactly as in (4). open_consent_window (20261255) refuses
//       the same people, reading the service-written roster ledger.
//   (4b) DEC-37 slot-to-slot (fix pass 2): nor anyone who signed, or can
//       still sign, a slot this one must be independent of (or that must be
//       independent of it) — consentConflictedPeople. Their silence would
//       let one person stand for both slots. Applied whatever the org's
//       size, like (4a): silence is never a second look. The close re-reads
//       it and holds ("independence") when nobody independent was told.
//   (5) Before 20261255 is pasted there are no window columns: every consent
//       slot waits as a sign-off — today's path, said.
//
// THE CLOCK. The window opens only when open_consent_window (20261255) has
// written the notification rows AND stamped the ticket in ONE transaction —
// no rows, no timestamp, no clock (DEC-38). Length: `window_days` WORKING
// days on the slot (default 3), warning at `warn_fraction` of it (default
// 2/3). At least one warning goes out before expiry (DEC-39): a window is
// never expired before its warning has been out CONSENT_WARN_LEAD_MS.
//
// THE THREE STATES (GAP-113): never delivered (no delivered event — blocks,
// it is never consent), delivered and unopened (read_at null), opened
// (read_at set — the recipient's own act since EVID-13, DF-P1). A delivered
// notice whose bell row is gone was read and then cleared: the purge and a
// member's own delete take only READ rows (app/api/admin/purge/route.ts,
// 20261161).

import type { TicketConsentPlan, TicketConsentWindowMark, TicketReviewRoster, TicketReviewSlot } from "@/types/schema";

/** The migration that carries the window's columns, RPCs and record. */
export const CONSENT_WINDOW_MIGRATION = "20261255";
/** GAP-109 decision (the plan's proposed default): 3 working days. */
export const CONSENT_WINDOW_DEFAULT_DAYS = 3;
/** GAP-109 decision (the plan's proposed default): warn at two thirds. */
export const CONSENT_WINDOW_DEFAULT_WARN_FRACTION = 2 / 3;
export const CONSENT_WINDOW_MIN_DAYS = 1;
export const CONSENT_WINDOW_MAX_DAYS = 30;
export const CONSENT_WARN_FRACTION_MIN = 0.1;
export const CONSENT_WARN_FRACTION_MAX = 0.9;
/** DEC-39: a window never expires sooner than this after its warning. */
export const CONSENT_WARN_LEAD_MS = 24 * 60 * 60 * 1000;
/** The machine actor on everything the clock writes (DEC-87 §2). */
export const CONSENT_WINDOW_ACTOR = "system:consent-window";
/** The capabilities that ARE the engineering sign-off (lib/ticketRoster.ts
 *  ENGINEERING_CAPABILITIES — pinned equal by a test; this module cannot
 *  import that one, which hashes with node:crypto). */
export const CONSENT_REFUSED_CAPABILITIES: readonly string[] = ["ticket.final_approve", "ticket.eng_review"];

// DEC-90 ruling (1) at the DF-P7 final fix pass: no reason claims that anyone
// was told. Whether the assignment queue heard is recorded on the blocked
// notice event (its `escalatedTo` names exactly who the bell reached) and
// said only once the bell landed.
export const CONSENT_REASON = {
  notPasted: `consent windows need database update ${CONSENT_WINDOW_MIGRATION} — until an Admin applies it, this waits for a sign-off as before`,
  multiple: "this routing table has more than one consent slot, and a review runs one consent window at most — each waits for a sign-off",
  engineeringSlot: "a consent window never stands in for the engineering sign-off — it waits for a sign-off",
  engineered: "this request is engineered work (an engineer's sign-off is required), and a consent window never applies to it — it waits for a sign-off",
  nobody: "its routing named nobody who could be asked (the management tier was rostered instead), so no window was opened — it waits for a sign-off",
  onlyParties: "the only people its routing names are the drafter or a party it must be independent of, and their silence is never consent, so no window was opened — it waits for a sign-off",
  noLongerAskable: "nobody it could ask is still an active member who may be asked, so no window was opened — it waits for a sign-off",
  // DEC-90 ruling (3) at the DF-P7 final fix pass: a declaration whose
  // e-signature could not be read when the request was submitted proves
  // nothing either way — the slot waits as an ordinary sign-off.
  declarationUnchecked: "this request's like-in-kind declaration could not be checked when it was submitted (the declaration decides whether an engineer must sign), so no consent window was opened — it waits for a sign-off",
  unconfirmed: "this consent slot was saved before consent windows existed (the routing editor then said it waits like a sign-off), so it still waits for a sign-off — a document controller re-saves the routing table to turn the consent window on",
} as const;

/** Why a window that closed with no objection still did not advance (the
 *  close is HELD: the slot waits for a sign-off). */
export type ConsentHoldReason = NonNullable<TicketConsentWindowMark["heldReason"]>;

/** The history headline a HELD close writes, by its reason (never the
 *  drafter-floor wording for a hold that has nothing to do with it). */
export function consentHeldAction(label: string, reason: ConsentHoldReason | null | undefined): string {
  switch (reason) {
    case "undelivered": return `Consent window closed — "${label}" is not consented: not everyone asked has a delivery on record, so it waits for a sign-off`;
    case "producer_floor": return `Consent window closed with no objection — "${label}" still needs a sign-off from someone other than the drafter`;
    case "source_moved": return `Consent window closed with no objection — "${label}" waits for a sign-off: a source document moved since the request was raised, and a person must acknowledge it before it issues`;
    case "source_unchecked": return `Consent window closed with no objection — "${label}" waits for a sign-off: the source documents could not be checked, so it does not issue on silence`;
    case "record_mismatch": return `Consent window closed with no objection — "${label}" waits for a sign-off: the review's ledger does not agree with the request's roster, so it does not issue on silence`;
    case "independence": return `Consent window closed with no objection — "${label}" waits for a sign-off: everyone told also signs (or can sign) a sign-off it must be independent of, so their silence is not a second look`;
    case "no_longer_member": return `Consent window closed — "${label}" waits for a sign-off: nobody told who could have objected is still an active member, so silence is not consent`;
    case "engineered": return `Consent window closed — "${label}" waits for a sign-off: this request is now engineered work (an engineer's sign-off is required), and a consent window never applies to it`;
    default: return `Consent window closed with no objection — "${label}" still waits for a sign-off`;
  }
}

/**
 * DEC-12 / DEC-37 (fix pass): the people a consent slot may ask — its
 * primaries, never the assigned drafter (the producer's silence is not a
 * check, whatever the org's size), and never the requester when the slot
 * declares itself independent of the requester. Sorted. Pure; the planner,
 * the cron's retry and (in SQL) open_consent_window apply the same rule.
 */
export function consentRecipients(
  slot: Pick<TicketReviewSlot, "primaries" | "independentOf">,
  parties: { drafterId?: string | null; requesterId?: string | null },
  conflicted?: ReadonlySet<string> | null,
): string[] {
  const out = new Set(slot.primaries.filter((u) => typeof u === "string" && !!u));
  if (parties.drafterId) out.delete(parties.drafterId);
  if (parties.requesterId && (slot.independentOf ?? []).includes("requester")) out.delete(parties.requesterId);
  for (const u of conflicted ?? []) out.delete(u);
  return [...out].sort();
}

/** A slot as the independence rule reads it — the roster's own slot, or a
 *  roster ledger row (ticket_review_slots, 20261242) mapped onto it. */
export type IndependenceSlot = Pick<TicketReviewSlot, "kind" | "mode" | "status" | "primaries" | "alternates" | "overriders" | "independentOf"> & { satisfiedBy?: string | null; via?: TicketReviewSlot["via"] };

/** DEC-37 slot-to-slot (fix pass 2): the slot kinds a consent slot must be
 *  independent of — the ones it names (the drafter and requester legs are
 *  consentRecipients' own), and the ones that name it. Pure. */
export function consentConflictKinds(slots: ReadonlyArray<Pick<IndependenceSlot, "kind" | "independentOf">>, slotKind: string): string[] {
  const self = slots.find((s) => s.kind === slotKind);
  const out = new Set<string>();
  for (const k of self?.independentOf ?? []) if (k !== "drafter" && k !== "requester" && k !== slotKind) out.add(k);
  for (const s of slots) if (s.kind !== slotKind && (s.independentOf ?? []).includes(slotKind)) out.add(s.kind);
  return [...out].sort();
}

/**
 * DEC-37 slot-to-slot (fix pass 2): the people whose silence on consent slot
 * `slotKind` would let one person stand for two slots that must be
 * independent — whoever SIGNED a conflicting slot (consentConflictKinds), and
 * whoever can still sign one that is open (its primaries, alternates and
 * overriders: they may sign it after the window closes, and slotSignPlan
 * cannot see a silence, which has no signer). Fail-safe: a person left out
 * is simply not asked, and a window nobody independent was told never
 * advances (the close holds it — "independence"). Pure.
 */
export function consentConflictedPeople(slots: ReadonlyArray<IndependenceSlot>, slotKind: string): Set<string> {
  const kinds = new Set(consentConflictKinds(slots, slotKind));
  const out = new Set<string>();
  for (const s of slots) {
    if (!kinds.has(s.kind)) continue;
    if (s.status === "satisfied" && s.via !== "consent" && s.satisfiedBy) out.add(s.satisfiedBy);
    if (s.status === "open") for (const u of [...(s.primaries ?? []), ...(s.alternates ?? []), ...(s.overriders ?? [])]) if (u) out.add(u);
  }
  return out;
}

/** A roster ledger row (ticket_review_slots, 20261242) as the independence
 *  rule reads it. */
export function ledgerIndependenceSlot(row: {
  slot_kind: string; mode: string; status: string; primaries?: string[] | null; alternates?: string[] | null; overriders?: string[] | null;
  independent_of?: string[] | null; satisfied_by?: string | null; satisfied_via?: string | null;
}): IndependenceSlot {
  return {
    kind: row.slot_kind,
    mode: row.mode as TicketReviewSlot["mode"],
    status: row.status as TicketReviewSlot["status"],
    primaries: row.primaries ?? [],
    alternates: row.alternates ?? [],
    overriders: row.overriders ?? [],
    independentOf: row.independent_of ?? [],
    satisfiedBy: row.satisfied_by ?? null,
    via: (row.satisfied_via ?? null) as TicketReviewSlot["via"],
  };
}

/** The routing slot's window (validated by lib/routingControl.ts), or the
 *  defaults. */
export function windowConfigOf(slot: { windowDays?: number | null; warnFraction?: number | null; window_days?: number; warn_fraction?: number }): { windowDays: number; warnFraction: number } {
  const d = slot.windowDays ?? slot.window_days;
  const f = slot.warnFraction ?? slot.warn_fraction;
  return {
    windowDays: typeof d === "number" && Number.isInteger(d) && d >= CONSENT_WINDOW_MIN_DAYS && d <= CONSENT_WINDOW_MAX_DAYS ? d : CONSENT_WINDOW_DEFAULT_DAYS,
    warnFraction: typeof f === "number" && f >= CONSENT_WARN_FRACTION_MIN && f <= CONSENT_WARN_FRACTION_MAX ? f : CONSENT_WINDOW_DEFAULT_WARN_FRACTION,
  };
}

const DAY_MS = 86_400_000;

/** `days` working days (Monday–Friday, UTC) after `startMs`, at the same
 *  time of day. A start on a weekend counts from the next Monday. */
export function addWorkingDays(startMs: number, days: number): number {
  let t = startMs;
  let left = Math.max(0, Math.floor(days));
  while ([0, 6].includes(new Date(t).getUTCDay())) t += DAY_MS;
  while (left > 0) {
    t += DAY_MS;
    if (![0, 6].includes(new Date(t).getUTCDay())) left -= 1;
  }
  return t;
}

/** When the window warns and when it closes, from when it opened. */
export function windowSchedule(openedAtMs: number, cfg: { windowDays: number; warnFraction: number }): { warnAt: number; closesAt: number } {
  const closesAt = addWorkingDays(openedAtMs, cfg.windowDays);
  const warnAt = openedAtMs + Math.round((closesAt - openedAtMs) * cfg.warnFraction);
  return { warnAt, closesAt };
}

/**
 * What a roster that just opened does about its consent slot(s) — decided
 * BEFORE the submission's compare-and-set and carried on the roster
 * (`consentPlan`), so the history line, the route and the cron's retry all
 * read one decision. Null: the roster has no consent slot (nothing changes).
 *   * `open` — ask the slot's own occupants (its primaries less the drafter
 *     and any party the slot is independent of — consentRecipients — frozen
 *     now).
 *   * `sign_off` — the slot waits for a sign-off, for `reason`.
 *   * `blocked` — nobody could be asked: waits for a sign-off, escalated.
 *   * `opened` — never planned here: the cron and the route mark an `open`
 *     plan `opened` once its window opened (DEC-90 ruling (4)).
 */
export function planConsentWindow(
  roster: Pick<TicketReviewRoster, "slots">,
  ctx: {
    engineeringRequired: boolean; columns: boolean; drafterId?: string | null; requesterId?: string | null;
    /** DEC-90 ruling (3) (DF-P7 final fix pass): the route could not read the
     *  declaration's e-signature (lib/reviewModel.ts
     *  declarationSignatureStands — 'unchecked'): no window is planned. */
    declarationUnchecked?: boolean;
  },
): TicketConsentPlan | null {
  const consent = roster.slots.filter((s) => s.mode === "consent_window");
  if (consent.length === 0) return null;
  const one = consent.length === 1 ? consent[0] : null;
  const label = one ? (one.label || one.kind) : null;
  // Fix pass 3: a slot stored before the consent-window label existed was
  // chosen as "waits like a sign-off" — it keeps that meaning until a
  // controller re-saves it (DEC-90, fail-safe). DEC-90 rulings (4) and (5)
  // (merge-time fix pass): checked FIRST — before the "columns missing"
  // branch (its reason never blames the paste) and before every other
  // reason — so a review whose consent slots are all unconfirmed is today's
  // review exactly: the route writes no plan and the history no note
  // (isUnconfirmedConsentPlan).
  if (consent.every((s) => s.consentConfirmed !== true)) return { kind: "sign_off", slot: one?.kind ?? null, label, reason: CONSENT_REASON.unconfirmed };
  if (!ctx.columns) return { kind: "sign_off", slot: one?.kind ?? null, label, reason: CONSENT_REASON.notPasted };
  if (!one) return { kind: "sign_off", slot: null, label: null, reason: CONSENT_REASON.multiple };
  if (one.engineering) return { kind: "sign_off", slot: one.kind, label: label!, reason: CONSENT_REASON.engineeringSlot };
  if (ctx.engineeringRequired) return { kind: "sign_off", slot: one.kind, label: label!, reason: CONSENT_REASON.engineered };
  if (ctx.declarationUnchecked) return { kind: "sign_off", slot: one.kind, label: label!, reason: CONSENT_REASON.declarationUnchecked };
  if (one.fallback || one.primaries.length === 0) return { kind: "blocked", slot: one.kind, label: label!, reason: CONSENT_REASON.nobody };
  const recipients = consentRecipients(one, { drafterId: ctx.drafterId, requesterId: ctx.requesterId }, consentConflictedPeople(roster.slots, one.kind));
  if (recipients.length === 0) return { kind: "blocked", slot: one.kind, label: label!, reason: CONSENT_REASON.onlyParties };
  const cfg = windowConfigOf(one);
  return { kind: "open", slot: one.kind, label: label!, recipients, windowDays: cfg.windowDays, warnFraction: cfg.warnFraction };
}

/** DEC-90 ruling (5) (DF-P7 merge-time fix pass): a plan that only says the
 *  consent slot was never confirmed — the route attaches no such plan to
 *  the roster, the history line adds no note for it, and the response says
 *  nothing: an existing unconfirmed consent slot reviews byte-for-byte as
 *  today. */
export function isUnconfirmedConsentPlan(plan: TicketConsentPlan | null | undefined): boolean {
  return !!plan && plan.kind === "sign_off" && plan.reason === CONSENT_REASON.unconfirmed;
}

/** The sentence a roster's history line adds for its consent plan. */
export function consentPlanNote(plan: TicketConsentPlan | null | undefined): string | null {
  if (!plan) return null;
  if (plan.kind === "open" || plan.kind === "opened") return `"${plan.label}" may object within ${plan.windowDays} working day${plan.windowDays === 1 ? "" : "s"} — the window opens once every one of them has been told`;
  return plan.label ? `"${plan.label}": ${plan.reason}` : `Consent slots: ${plan.reason}`;
}

/** The window mirror on a ticket's roster (open, closed or not yet), or null
 *  — what the request page mounts the card on. Read from the roster even
 *  once it closed, so the record stays on the page. */
export function consentWindowMarker(ticket: { metadata?: Record<string, unknown> | null }): TicketConsentWindowMark | null {
  const r = (ticket.metadata as Record<string, unknown> | null | undefined)?.review_roster as TicketReviewRoster | undefined;
  const w = r && typeof r === "object" ? r.consentWindow : null;
  if (!w || typeof w !== "object" || typeof w.slot !== "string" || typeof w.openedAt !== "string" || !Array.isArray(w.recipients)) return null;
  return w;
}

/** Is the roster's window running — opened, not objected to, not expired,
 *  and its slot still waiting? */
export function windowRunning(roster: Pick<TicketReviewRoster, "consentWindow" | "slots" | "closedAt"> | null | undefined): boolean {
  const w = roster?.consentWindow;
  if (!roster || !w || roster.closedAt || w.objectedAt || w.expiredAt) return false;
  return roster.slots.some((s) => s.kind === w.slot && s.mode === "consent_window" && s.status === "open");
}

/** May `uid` object to the running window? (one of the people asked) */
export function mayObject(roster: Pick<TicketReviewRoster, "consentWindow" | "slots" | "closedAt"> | null | undefined, uid: string | null | undefined): boolean {
  return !!uid && windowRunning(roster) && roster!.consentWindow!.recipients.includes(uid);
}

/** The window as the ticket row records it (20261255's columns), or null
 *  when the columns are not there (not pasted — today's path). */
export interface ConsentWindowState {
  openedAt: string | null;
  recipients: string[];
  slot: string | null;
  rosterId: string | null;
  warnAt: string | null;
  closesAt: string | null;
  warnedAt: string | null;
  expiredAt: string | null;
  objectedAt: string | null;
  objectedBy: string | null;
}

export const CONSENT_WINDOW_COLUMNS = [
  "consent_window_opened_at", "consent_window_recipients", "consent_window_slot", "consent_window_roster",
  "consent_window_warn_at", "consent_window_closes_at", "consent_window_warned_at", "consent_window_expired_at",
  "consent_window_objected_at", "consent_window_objected_by",
] as const;

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

export function consentWindowFromRow(row: Record<string, unknown>): ConsentWindowState | null {
  if (!Object.prototype.hasOwnProperty.call(row, "consent_window_opened_at")) return null;
  return {
    openedAt: str(row.consent_window_opened_at),
    recipients: Array.isArray(row.consent_window_recipients) ? (row.consent_window_recipients as unknown[]).filter((u): u is string => typeof u === "string") : [],
    slot: str(row.consent_window_slot),
    rosterId: str(row.consent_window_roster),
    warnAt: str(row.consent_window_warn_at),
    closesAt: str(row.consent_window_closes_at),
    warnedAt: str(row.consent_window_warned_at),
    expiredAt: str(row.consent_window_expired_at),
    objectedAt: str(row.consent_window_objected_at),
    objectedBy: str(row.consent_window_objected_by),
  };
}

/** True when a 42703 / PGRST204 names one of 20261255's columns (not pasted). */
export function isMissingConsentColumn(err: { code?: string | null; message?: string | null } | null | undefined): boolean {
  if (!err) return false;
  const code = String(err.code ?? "");
  if (code !== "42703" && code !== "PGRST204") return false;
  return /consent_window_/.test(String(err.message ?? ""));
}

/** True when the error says 20261255's RPC or table is not there yet
 *  (PGRST202 / 42883 / 42P01 / PGRST205 naming it). */
export function isMissingConsentSchema(err: { code?: string | null; message?: string | null } | null | undefined): boolean {
  if (!err) return false;
  const code = String(err.code ?? "");
  const msg = String(err.message ?? "");
  if (code === "PGRST202" || code === "42883") return /consent_window/.test(msg);
  if (code === "42P01" || code === "PGRST205") return /ticket_notice_events/.test(msg);
  return isMissingConsentColumn(err);
}

/** What the clock does now for a window the row records. */
export type ConsentStep = "none" | "warn" | "expire";

export function consentWindowStep(
  state: ConsentWindowState,
  roster: Pick<TicketReviewRoster, "id" | "slots" | "closedAt"> | null,
  now: number,
): ConsentStep {
  if (!state.openedAt || state.expiredAt || state.objectedAt || !state.slot || !state.warnAt || !state.closesAt) return "none";
  if (!roster || roster.closedAt || roster.id !== state.rosterId) return "none";
  if (!roster.slots.some((s) => s.kind === state.slot && s.mode === "consent_window" && s.status === "open")) return "none";
  if (!state.warnedAt) return now >= Date.parse(state.warnAt) ? "warn" : "none";
  if (now >= Date.parse(state.closesAt) && now >= Date.parse(state.warnedAt) + CONSENT_WARN_LEAD_MS) return "expire";
  return "none";
}

export type NoticeState = "not_delivered" | "unopened" | "opened";

/** GAP-113's three states, per person asked. `delivered` maps a recipient to
 *  the notification id their "delivered" event names; `rows` maps a
 *  notification id to its read_at (a row that no longer exists is absent). */
export function noticeStates(
  recipients: readonly string[],
  delivered: ReadonlyMap<string, string>,
  rows: ReadonlyMap<string, string | null>,
): Array<{ uid: string; state: NoticeState; openedAt: string | null; cleared: boolean }> {
  return recipients.map((uid) => {
    const id = delivered.get(uid);
    if (!id) return { uid, state: "not_delivered" as const, openedAt: null, cleared: false };
    if (!rows.has(id)) return { uid, state: "opened" as const, openedAt: null, cleared: true };
    const at = rows.get(id) ?? null;
    return at ? { uid, state: "opened" as const, openedAt: at, cleared: false } : { uid, state: "unopened" as const, openedAt: null, cleared: false };
  });
}

/** A moment as the history reads it: UTC, to the minute. */
export const recordMoment = (iso: string | number | null | undefined): string => {
  if (iso === null || iso === undefined) return "—";
  const t = typeof iso === "number" ? iso : Date.parse(iso);
  return Number.isFinite(t) ? `${new Date(t).toISOString().slice(0, 16).replace("T", " ")} UTC` : String(iso);
};

const listNames = (uids: readonly string[], nameOf: (uid: string) => string): string => uids.map(nameOf).join(", ") || "nobody";

/** The history line open_consent_window appends (it names everyone asked). */
export function openedHistoryDetails(input: { label: string; recipients: readonly string[]; nameOf: (uid: string) => string; openedAt: number; warnAt: number; closesAt: number }): string {
  const n = input.recipients.length;
  return `Asked ${listNames(input.recipients, input.nameOf)} (${n} ${n === 1 ? "person" : "people"}) on ${recordMoment(input.openedAt)} to object if "${input.label}" should not go ahead. A reminder goes out ${recordMoment(input.warnAt)}; the window closes ${recordMoment(input.closesAt)}. If nobody objects, the sign-off is recorded as given without objection.`;
}

/** The history line record_consent_window_warning appends. */
export function warnedHistoryDetails(input: { label: string; recipients: readonly string[]; queue: readonly string[]; nameOf: (uid: string) => string; at: number; closesAt: string }): string {
  return `Reminded ${listNames(input.recipients, input.nameOf)}${input.queue.length ? ` and the assignment queue (${listNames(input.queue, input.nameOf)})` : ""} on ${recordMoment(input.at)} that "${input.label}" advances without objection when the window closes ${recordMoment(input.closesAt)}.`;
}

/** The DEC-39 record: "advanced without objection", naming everyone asked,
 *  when, whether each opened the notice, when they were warned and when the
 *  window closed — from the ticket's own history, no notifications table. */
export function advancedHistoryDetails(input: {
  state: Pick<ConsentWindowState, "openedAt" | "warnedAt" | "closesAt">;
  states: ReadonlyArray<{ uid: string; state: NoticeState; openedAt: string | null; cleared: boolean }>;
  nameOf: (uid: string) => string;
  closedAt: number;
}): string {
  const asked = input.states.map((s) => s.uid);
  const opened = input.states.filter((s) => s.state === "opened").map((s) => `${input.nameOf(s.uid)} (${s.openedAt ? `opened ${recordMoment(s.openedAt)}` : "opened; the notice was later cleared"})`);
  const unopened = input.states.filter((s) => s.state === "unopened").map((s) => input.nameOf(s.uid));
  return [
    `Asked ${listNames(asked, input.nameOf)} on ${recordMoment(input.state.openedAt)}; reminded ${recordMoment(input.state.warnedAt)}; the window closed ${recordMoment(input.closedAt)} (due ${recordMoment(input.state.closesAt)}) with no objection.`,
    `Seen, no objection: ${opened.join(", ") || "nobody"}.`,
    `Told, not opened: ${unopened.join(", ") || "nobody"}.`,
  ].join(" ");
}

/** The slot a consent advance satisfies, as the roster records it. */
export function consentSatisfiedSlot(slot: TicketReviewSlot, now: string): TicketReviewSlot {
  return { ...slot, status: "satisfied", satisfiedBy: null, satisfiedByName: "No objection (consent window)", satisfiedAt: now, signatureId: null, via: "consent" };
}

/**
 * DEC-12 / DEC-37 producer-versus-checker floor, as it reads for a consent
 * advance (it stands in for rosterCompletion's floor on the close, which
 * would never count a window's slot — it has no signer). Held when:
 *   * the ONLY person who signed any blocking slot is the drafter — silence
 *     is not a second person over the drafter's own sign-off (slotSignPlan
 *     holds one slot open for the same reason); or
 *   * nobody other than the drafter was asked AND told (`asked`: the
 *     recipients with a delivery on record) — a window only the drafter
 *     could have objected to is the drafter approving their own work. This
 *     limb holds whatever the org's size: below the threshold the drafter
 *     may SIGN their own work, but their silence is never a sign-off.
 * A roster on which nobody signed at all is not held when someone other
 * than the drafter was asked and told: they had the window to object (the
 * recipients never include the drafter — consentRecipients). Pure.
 */
export function consentFloorHolds(
  roster: Pick<TicketReviewRoster, "slots">,
  floor: { sodActive: boolean; drafterId: string | null | undefined },
  asked: readonly string[],
): boolean {
  const drafter = floor.drafterId ?? null;
  if (!asked.some((u) => !!u && u !== drafter)) return true;
  if (!floor.sodActive || !drafter) return false;
  // DF-P22: a standing pre-authorization is no more a second person than
  // silence is (lib/workflow.ts rosterLacksIndependentSignOff, the same rule).
  const signed = roster.slots.filter((s) => s.mode !== "notify_only" && s.status === "satisfied" && s.via !== "consent" && s.via !== "preauthorization" && !!s.satisfiedBy);
  if (signed.length > 0 && signed.every((s) => s.satisfiedBy === drafter)) return true;
  // Fix pass 2 — the two floors agree: a slot only the drafter can sign
  // would be refused for good after a silent close (slotSignPlan's floor,
  // lib/workflow.ts rosterLacksIndependentSignOff, never counts a silence:
  // it has no signer), so the review would sit with every way forward
  // refused. The window's slot waits for a real sign-off instead, and the
  // drafter's sign-off then completes the review as it always did.
  return drafterOnlyOpenSlot(roster, drafter) !== null;
}

/** The first open blocking slot (other than a satisfied one) that only the
 *  drafter can sign — every primary, alternate and overrider is the drafter
 *  — or null. Pure. */
export function drafterOnlyOpenSlot(roster: Pick<TicketReviewRoster, "slots">, drafterId: string | null | undefined): TicketReviewSlot | null {
  if (!drafterId) return null;
  return roster.slots.find((s) => {
    if (s.mode === "notify_only" || s.status !== "open") return false;
    const occupants = [...s.primaries, ...(s.alternates ?? []), ...(s.overriders ?? [])].filter((u) => !!u);
    return occupants.length > 0 && occupants.every((u) => u === drafterId);
  }) ?? null;
}

/** DEC-37 slot-to-slot (fix pass 2): the close holds when everyone told
 *  (other than the drafter) is a person whose silence the slot may not take
 *  (consentConflictedPeople). Pure. */
export function consentIndependenceHolds(asked: readonly string[], drafterId: string | null | undefined, conflicted: ReadonlySet<string>): boolean {
  const others = asked.filter((u) => !!u && u !== drafterId);
  return others.length > 0 && others.every((u) => conflicted.has(u));
}

/** FRIC-5 × GAP-109 (fix pass 3): the key the window's opening history line
 *  carries when its notice named the drafter's issue-as-is mark —
 *  `{ rev, at }` of the mark it named. */
export const CONSENT_ISSUE_AS_IS_KEY = "consentIssueAsIs";

/** The drafter's issue-as-is mark on the draft under review (FRIC-5 —
 *  lib/workflow.ts issueReadyFor's rule: bound to the label it was made on),
 *  or null. Pure. */
export function issueAsIsMarkOf(ticket: { metadata?: Record<string, unknown> | null; deliverableRev?: string | null }): { rev: string; at: string | null } | null {
  const mark = (ticket.metadata as Record<string, unknown> | null | undefined)?.issue_ready as { rev?: unknown; at?: unknown } | undefined;
  if (!ticket.deliverableRev || typeof mark?.rev !== "string" || mark.rev !== ticket.deliverableRev) return null;
  return { rev: mark.rev, at: typeof mark.at === "string" ? mark.at : null };
}

/**
 * FRIC-5 × GAP-109 (fix pass 3): did the notice that opened this window name
 * the issue-as-is mark the ticket carries NOW? Read from the window's own
 * opening history line (open_consent_window stamps it with the window's
 * opened_at, by the machine actor) — the mark it named must be this mark
 * (same label, same moment). A silent close issues the draft as the final
 * package only then: nobody asked may have consented to an issue-as-is they
 * were never told of (the reviewer's own sign-off carries ISSUE_AS_IS_NOTE).
 * Fail-safe: anything unreadable answers false. Pure.
 */
export function issueAsIsNamedAtOpen(
  ticket: { history?: ReadonlyArray<unknown> | null; metadata?: Record<string, unknown> | null; deliverableRev?: string | null },
  openedAt: string | null | undefined,
): boolean {
  const mark = issueAsIsMarkOf(ticket);
  if (!mark || !openedAt) return false;
  const t = Date.parse(openedAt);
  if (!Number.isFinite(t)) return false;
  for (const h of ticket.history ?? []) {
    if (!h || typeof h !== "object") continue;
    const e = h as Record<string, unknown>;
    const rec = e[CONSENT_ISSUE_AS_IS_KEY] as { rev?: unknown; at?: unknown } | undefined;
    if (!rec || typeof rec !== "object" || e.user !== CONSENT_WINDOW_ACTOR) continue;
    if (Date.parse(String(e.date ?? "")) !== t) continue;
    if (rec.rev === mark.rev && (typeof rec.at === "string" ? rec.at : null) === mark.at) return true;
  }
  return false;
}
