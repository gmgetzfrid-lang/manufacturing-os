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
//       window.
//   (2) Never on the highest work class: a request whose engineering
//       requirement holds (DEC-33's engineered lane — lib/workflow.ts
//       engineeringGateRequired, or an engineering-first type) never gets a
//       window; its consent slot waits as a sign-off, said. Never on a slot
//       that IS the engineering sign-off (filled by an engineering
//       capability, or the gate slot the roster appended): refused when the
//       routing table is saved (validateRoutingDraft), and a stored one waits
//       as a sign-off.
//   (3) One window per review: a table with more than one consent slot
//       opens none (each waits as a sign-off, said).
//   (4) An empty recipient set never advances (DEC-39): a consent slot whose
//       own fill named nobody (the roster stood the management tier in —
//       `fallback`) is BLOCKED — it waits as a sign-off and the assignment
//       queue is told (the "ack_unsatisfiable" polarity).
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

export const CONSENT_REASON = {
  notPasted: `consent windows need database update ${CONSENT_WINDOW_MIGRATION} — until an Admin applies it, this waits for a sign-off as before`,
  multiple: "this routing table has more than one consent slot, and a review runs one consent window at most — each waits for a sign-off",
  engineeringSlot: "a consent window never stands in for the engineering sign-off — it waits for a sign-off",
  engineered: "this request is engineered work (an engineer's sign-off is required), and a consent window never applies to it — it waits for a sign-off",
  nobody: "its routing named nobody who could be asked (the management tier was rostered instead), so no window was opened — it waits for a sign-off, and the assignment queue was told",
} as const;

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
 *   * `open` — ask the slot's own occupants (its primaries, frozen now).
 *   * `sign_off` — the slot waits for a sign-off, for `reason`.
 *   * `blocked` — nobody could be asked: waits for a sign-off, escalated.
 */
export function planConsentWindow(
  roster: Pick<TicketReviewRoster, "slots">,
  ctx: { engineeringRequired: boolean; columns: boolean },
): TicketConsentPlan | null {
  const consent = roster.slots.filter((s) => s.mode === "consent_window");
  if (consent.length === 0) return null;
  const one = consent.length === 1 ? consent[0] : null;
  const label = one ? (one.label || one.kind) : null;
  if (!ctx.columns) return { kind: "sign_off", slot: one?.kind ?? null, label, reason: CONSENT_REASON.notPasted };
  if (!one) return { kind: "sign_off", slot: null, label: null, reason: CONSENT_REASON.multiple };
  if (one.engineering) return { kind: "sign_off", slot: one.kind, label: label!, reason: CONSENT_REASON.engineeringSlot };
  if (ctx.engineeringRequired) return { kind: "sign_off", slot: one.kind, label: label!, reason: CONSENT_REASON.engineered };
  if (one.fallback || one.primaries.length === 0) return { kind: "blocked", slot: one.kind, label: label!, reason: CONSENT_REASON.nobody };
  const cfg = windowConfigOf(one);
  return { kind: "open", slot: one.kind, label: label!, recipients: [...one.primaries].sort(), windowDays: cfg.windowDays, warnFraction: cfg.warnFraction };
}

/** The sentence a roster's history line adds for its consent plan. */
export function consentPlanNote(plan: TicketConsentPlan | null | undefined): string | null {
  if (!plan) return null;
  if (plan.kind === "open") return `"${plan.label}" may object within ${plan.windowDays} working day${plan.windowDays === 1 ? "" : "s"} — the window opens once every one of them has been told`;
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
 * advance: silence is not a check, so the advance is held when the ONLY
 * person who signed any blocking slot is the drafter (the floor then wants a
 * second person, exactly as slotSignPlan holds one slot open for one). A
 * roster on which nobody signed at all (every blocking slot a window) is not
 * the drafter approving their own work, and is not held. Pure.
 */
export function consentFloorHolds(
  roster: Pick<TicketReviewRoster, "slots">,
  floor: { sodActive: boolean; drafterId: string | null | undefined },
): boolean {
  if (!floor.sodActive || !floor.drafterId) return false;
  const signed = roster.slots.filter((s) => s.mode !== "notify_only" && s.status === "satisfied" && s.via !== "consent" && !!s.satisfiedBy);
  return signed.length > 0 && signed.every((s) => s.satisfiedBy === floor.drafterId);
}
