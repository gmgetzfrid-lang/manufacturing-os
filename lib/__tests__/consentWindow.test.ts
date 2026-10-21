// drafting-flow Round G, DF-P7 CONSENT — GAP-109 on GAP-113 (DEC-38, DEC-39):
// the pure rules (lib/consentWindow.ts), the routing slot's window
// (lib/routingControl.ts), the engine's objection and optional sign-off
// (lib/workflow.ts) and the two transitions (lib/ticketTransitions.ts).
//
// DEC-38 acceptance, at this layer: a window that never opened (the
// notification insert failed, so open_consent_window wrote nothing) has no
// opened_at, so the clock never warns, never expires and never advances.
// DEC-39: an empty recipient set never advances (blocked, escalated); the
// ticket's own history answers the regulator with no reference to the
// notifications table.

import { describe, it, expect } from "vitest";
import {
  planConsentWindow, consentPlanNote, addWorkingDays, windowSchedule, windowConfigOf, consentWindowStep, noticeStates,
  advancedHistoryDetails, openedHistoryDetails, consentFloorHolds, consentSatisfiedSlot, consentWindowFromRow,
  consentRecipients, consentHeldAction, consentConflictKinds, consentConflictedPeople, consentIndependenceHolds, drafterOnlyOpenSlot, ledgerIndependenceSlot,
  consentWindowMarker, windowRunning, mayObject, isMissingConsentColumn, isMissingConsentSchema,
  CONSENT_ISSUE_AS_IS_KEY, issueAsIsMarkOf, issueAsIsNamedAtOpen,
  CONSENT_REASON, CONSENT_WINDOW_DEFAULT_DAYS, CONSENT_WINDOW_DEFAULT_WARN_FRACTION, CONSENT_WARN_LEAD_MS,
  CONSENT_REFUSED_CAPABILITIES, CONSENT_WINDOW_COLUMNS, type ConsentWindowState,
} from "@/lib/consentWindow";
import { parseRoutingControl, validateRoutingDraft, MODE_LABEL, confirmConsentSlots } from "@/lib/routingControl";
import { ENGINEERING_CAPABILITIES, openRoster, rosterCompletion } from "@/lib/ticketRoster";
import { WorkflowEngine, currentRoster, slotSignPlan } from "@/lib/workflow";
import { isActionRequired } from "@/lib/ticketAttention";
import { computeTransition } from "@/lib/ticketTransitions";
import type { Role, Ticket, TicketReviewRoster, TicketReviewSlot, TicketStatus } from "@/types/schema";

const slot = (over: Partial<TicketReviewSlot> & { kind: string }): TicketReviewSlot => ({
  id: `r:${over.kind}`, label: over.kind, mode: "blocking", primaries: [], alternates: [], overriders: [],
  independentOf: [], timeoutDays: null, fallback: false, status: "open", ...over,
});
const roster = (slots: TicketReviewSlot[], over: Partial<TicketReviewRoster> = {}): TicketReviewRoster => ({
  v: 1, id: "11111111-1111-4111-8111-111111111111", openedAt: "2026-10-19T09:00:00.000Z", openedBy: "d-1", level: "library",
  cycle: "1A", contentHash: "h", files: [], slots, ...over,
});
const consent = (over: Partial<TicketReviewSlot> = {}) => slot({ kind: "ops", label: "Operations", mode: "consent_window", primaries: ["o-1", "o-2"], consentConfirmed: true, ...over });

describe("planConsentWindow — where a window can exist (DEC-90 rulings for DF-P7)", () => {
  const cols = { engineeringRequired: false, columns: true };
  it("no consent slot: nothing to plan (every roster without one is exactly today's)", () => {
    expect(planConsentWindow(roster([slot({ kind: "a", primaries: ["x"] })]), cols)).toBeNull();
    expect(planConsentWindow(roster([slot({ kind: "n", mode: "notify_only", primaries: ["x"], status: "told" })]), cols)).toBeNull();
  });
  it("opens on a configured consent slot, asking its own occupants (frozen), with the default window (3 working days, warn at 2/3)", () => {
    const p = planConsentWindow(roster([slot({ kind: "a", primaries: ["r"] }), consent()]), cols);
    expect(p).toEqual({ kind: "open", slot: "ops", label: "Operations", recipients: ["o-1", "o-2"], windowDays: 3, warnFraction: 2 / 3 });
    expect(CONSENT_WINDOW_DEFAULT_DAYS).toBe(3);
    expect(CONSENT_WINDOW_DEFAULT_WARN_FRACTION).toBeCloseTo(0.6667, 3);
    expect(consentPlanNote(p)).toMatch(/may object within 3 working days/);
  });
  it("NEVER on the highest work class: an engineered request's consent slot waits for a sign-off", () => {
    expect(planConsentWindow(roster([consent()]), { engineeringRequired: true, columns: true })).toMatchObject({ kind: "sign_off", reason: CONSENT_REASON.engineered });
  });
  it("NEVER as the engineering sign-off (a slot filled by an engineering capability)", () => {
    expect(planConsentWindow(roster([consent({ engineering: true })]), cols)).toMatchObject({ kind: "sign_off", reason: CONSENT_REASON.engineeringSlot });
  });
  it("DEC-39: a slot whose own fill named nobody (the management fallback) is BLOCKED — never a window", () => {
    expect(planConsentWindow(roster([consent({ fallback: true, primaries: ["mgr"] })]), cols)).toMatchObject({ kind: "blocked", reason: CONSENT_REASON.nobody });
    expect(planConsentWindow(roster([consent({ primaries: [] })]), cols)).toMatchObject({ kind: "blocked" });
  });
  it("one window per review: two consent slots open none", () => {
    expect(planConsentWindow(roster([consent(), consent({ kind: "qa", label: "QA" })]), cols)).toMatchObject({ kind: "sign_off", reason: CONSENT_REASON.multiple });
  });
  it("before 20261255 (no columns): waits for a sign-off, said", () => {
    expect(planConsentWindow(roster([consent()]), { engineeringRequired: false, columns: false })).toMatchObject({ kind: "sign_off", reason: CONSENT_REASON.notPasted });
  });
  // DF-P7 fix pass (review blocker): DEC-12 / DEC-37 hold whatever the table declares.
  const parties = { ...cols, drafterId: "d-1", requesterId: "req" };
  it("DEC-12: the drafter as the slot's ONLY occupant is never asked — BLOCKED (escalated), never a window their own silence satisfies", () => {
    const p = planConsentWindow(roster([consent({ primaries: ["d-1"], independentOf: ["drafter"] })]), parties);
    expect(p).toMatchObject({ kind: "blocked", slot: "ops", reason: CONSENT_REASON.onlyParties });
    // with no independence declared, the drafter's silence is still never a check
    expect(planConsentWindow(roster([consent({ primaries: ["d-1"] })]), parties)).toMatchObject({ kind: "blocked", reason: CONSENT_REASON.onlyParties });
  });
  it("independent_of ['drafter'] with the drafter among the primaries: the window asks only the others", () => {
    const p = planConsentWindow(roster([consent({ primaries: ["d-1", "x-1"], independentOf: ["drafter"] })]), parties);
    expect(p).toMatchObject({ kind: "open", recipients: ["x-1"] });
  });
  it("independent_of ['requester']: the requester's silence never approves their own request", () => {
    expect(planConsentWindow(roster([consent({ primaries: ["req"], independentOf: ["requester"] })]), parties)).toMatchObject({ kind: "blocked", reason: CONSENT_REASON.onlyParties });
    expect(planConsentWindow(roster([consent({ primaries: ["req", "o-1"], independentOf: ["requester"] })]), parties)).toMatchObject({ kind: "open", recipients: ["o-1"] });
    // without the declaration the requester may be asked (they are not the producer)
    expect(planConsentWindow(roster([consent({ primaries: ["req", "o-1"] })]), parties)).toMatchObject({ kind: "open", recipients: ["o-1", "req"] });
  });
  it("consentRecipients is the one rule (sorted, de-duplicated)", () => {
    expect(consentRecipients({ primaries: ["o-2", "d-1", "o-1", "o-2"], independentOf: [] }, { drafterId: "d-1", requesterId: "req" })).toEqual(["o-1", "o-2"]);
    expect(consentRecipients({ primaries: ["req"], independentOf: ["requester"] }, { drafterId: null, requesterId: "req" })).toEqual([]);
  });
});

describe("the clock — working days, the warning fraction, the lead before expiry", () => {
  it("addWorkingDays skips Saturday and Sunday; a weekend start counts from Monday", () => {
    const fri = Date.parse("2026-10-23T09:00:00Z"); // Friday
    expect(new Date(addWorkingDays(fri, 1)).toISOString()).toBe("2026-10-26T09:00:00.000Z"); // Monday
    expect(new Date(addWorkingDays(fri, 3)).toISOString()).toBe("2026-10-28T09:00:00.000Z");
    const sat = Date.parse("2026-10-24T09:00:00Z");
    expect(new Date(addWorkingDays(sat, 1)).toISOString()).toBe("2026-10-27T09:00:00.000Z");
  });
  it("windowSchedule warns at the configured fraction of the window and closes at its end", () => {
    const mon = Date.parse("2026-10-19T09:00:00Z");
    const { warnAt, closesAt } = windowSchedule(mon, { windowDays: 3, warnFraction: 2 / 3 });
    expect(new Date(closesAt).toISOString()).toBe("2026-10-22T09:00:00.000Z");
    expect(warnAt - mon).toBe(Math.round((closesAt - mon) * (2 / 3)));
  });
  it("windowConfigOf takes a valid slot setting and refuses to guess on a bad one (the defaults)", () => {
    expect(windowConfigOf({ window_days: 5, warn_fraction: 0.5 })).toEqual({ windowDays: 5, warnFraction: 0.5 });
    expect(windowConfigOf({ windowDays: 0, warnFraction: 2 })).toEqual({ windowDays: 3, warnFraction: 2 / 3 });
  });
  const state = (over: Partial<ConsentWindowState> = {}): ConsentWindowState => ({
    openedAt: "2026-10-19T09:00:00.000Z", recipients: ["o-1"], slot: "ops", rosterId: roster([]).id,
    warnAt: "2026-10-21T09:00:00.000Z", closesAt: "2026-10-22T09:00:00.000Z", warnedAt: null, expiredAt: null, objectedAt: null, objectedBy: null, ...over,
  });
  const r = roster([consent({ primaries: ["o-1"] })]);
  it("DEC-38: a window that never opened (no opened_at — the insert failed, nothing was written) never warns, expires or advances", () => {
    for (const t of [Date.parse("2026-10-21T10:00:00Z"), Date.parse("2027-01-01T00:00:00Z")]) {
      expect(consentWindowStep(state({ openedAt: null, warnAt: null, closesAt: null, slot: null, recipients: [] }), r, t)).toBe("none");
    }
  });
  it("DEC-39: warns at warn_at; never expires before its warning has been out CONSENT_WARN_LEAD_MS", () => {
    expect(consentWindowStep(state(), r, Date.parse("2026-10-21T08:59:00Z"))).toBe("none");
    expect(consentWindowStep(state(), r, Date.parse("2026-10-21T09:00:00Z"))).toBe("warn");
    // past the close but never warned: the warning goes first
    expect(consentWindowStep(state(), r, Date.parse("2026-10-23T00:00:00Z"))).toBe("warn");
    const warned = state({ warnedAt: "2026-10-22T08:00:00.000Z" });
    expect(consentWindowStep(warned, r, Date.parse("2026-10-22T10:00:00Z"))).toBe("none");
    expect(consentWindowStep(warned, r, Date.parse("2026-10-22T08:00:00Z") + CONSENT_WARN_LEAD_MS)).toBe("expire");
  });
  it("an objection, an expiry, another review or a slot already signed stops the clock", () => {
    const t = Date.parse("2026-12-01T00:00:00Z");
    expect(consentWindowStep(state({ warnedAt: "2026-10-21T09:00:00Z", objectedAt: "2026-10-21T10:00:00Z" }), r, t)).toBe("none");
    expect(consentWindowStep(state({ warnedAt: "2026-10-21T09:00:00Z", expiredAt: "2026-10-23T09:00:00Z" }), r, t)).toBe("none");
    expect(consentWindowStep(state({ warnedAt: "2026-10-21T09:00:00Z", rosterId: "other" }), r, t)).toBe("none");
    expect(consentWindowStep(state({ warnedAt: "2026-10-21T09:00:00Z" }), roster([consent({ primaries: ["o-1"], status: "satisfied" })]), t)).toBe("none");
  });
});

describe("GAP-113 — the three states, and the record on the ticket", () => {
  it("never delivered / delivered unopened / opened — and a delivered notice whose bell row is gone was read, then cleared", () => {
    const delivered = new Map([["a", "n-a"], ["b", "n-b"], ["c", "n-c"]]);
    const rows = new Map<string, string | null>([["n-a", "2026-10-20T10:00:00Z"], ["n-b", null]]);
    expect(noticeStates(["a", "b", "c", "d"], delivered, rows)).toEqual([
      { uid: "a", state: "opened", openedAt: "2026-10-20T10:00:00Z", cleared: false },
      { uid: "b", state: "unopened", openedAt: null, cleared: false },
      { uid: "c", state: "opened", openedAt: null, cleared: true },
      { uid: "d", state: "not_delivered", openedAt: null, cleared: false },
    ]);
  });
  it("DEC-39: the history answers who was asked, when, whether each opened it, when they were warned and when it closed — with no reference to the notifications table", () => {
    const nameOf = (u: string) => ({ a: "Ann", b: "Bo" } as Record<string, string>)[u] ?? u;
    const d = advancedHistoryDetails({
      state: { openedAt: "2026-10-19T09:00:00Z", warnedAt: "2026-10-21T09:00:00Z", closesAt: "2026-10-22T09:00:00Z" },
      states: [{ uid: "a", state: "opened", openedAt: "2026-10-20T10:00:00Z", cleared: false }, { uid: "b", state: "unopened", openedAt: null, cleared: false }],
      nameOf, closedAt: Date.parse("2026-10-23T03:00:00Z"),
    });
    expect(d).toContain("Asked Ann, Bo on 2026-10-19 09:00 UTC");
    expect(d).toContain("reminded 2026-10-21 09:00 UTC");
    expect(d).toContain("the window closed 2026-10-23 03:00 UTC");
    expect(d).toContain("Seen, no objection: Ann (opened 2026-10-20 10:00 UTC)");
    expect(d).toContain("Told, not opened: Bo.");
    expect(d).not.toMatch(/notification/i);
    const o = openedHistoryDetails({ label: "Operations", recipients: ["a", "b"], nameOf, openedAt: Date.parse("2026-10-19T09:00:00Z"), warnAt: Date.parse("2026-10-21T09:00:00Z"), closesAt: Date.parse("2026-10-22T09:00:00Z") });
    expect(o).toMatch(/^Asked Ann, Bo \(2 people\)/);
  });
  it("consentWindowFromRow reads the ten columns, and is null when they are not there (not pasted — today's path)", () => {
    expect(consentWindowFromRow({ id: "t" })).toBeNull();
    const row: Record<string, unknown> = Object.fromEntries(CONSENT_WINDOW_COLUMNS.map((c) => [c, null]));
    expect(consentWindowFromRow({ ...row, consent_window_recipients: ["a"], consent_window_opened_at: "x" })).toMatchObject({ openedAt: "x", recipients: ["a"] });
    expect(CONSENT_WINDOW_COLUMNS).toHaveLength(10);
  });
  it("the not-pasted errors are recognised by the names they carry, and nothing else is", () => {
    expect(isMissingConsentColumn({ code: "42703", message: "column tickets.consent_window_opened_at does not exist" })).toBe(true);
    expect(isMissingConsentColumn({ code: "42703", message: "column tickets.other does not exist" })).toBe(false);
    expect(isMissingConsentSchema({ code: "PGRST202", message: "Could not find the function public.open_consent_window" })).toBe(true);
    expect(isMissingConsentSchema({ code: "PGRST205", message: "Could not find the table 'public.ticket_notice_events' in the schema cache" })).toBe(true);
    expect(isMissingConsentSchema({ code: "P0001", message: "consent window: not every person asked could be told" })).toBe(false);
  });
});

describe("routing_control — the slot's window, and the configuration refused (DEC-90 ruling (1))", () => {
  const base = { slots: [{ kind: "accept", mode: "blocking", fill: { identity: "requester" } }] };
  it("a consent slot may carry window_days (1–30) and warn_fraction (0.1–0.9); any other slot may not", () => {
    const ok = parseRoutingControl({ slots: [...base.slots, { kind: "ops", mode: "consent_window", fill: { users: ["u"] }, window_days: 5, warn_fraction: 0.5 }] });
    expect(ok && ok.ok && ok.control.slots[1]).toMatchObject({ window_days: 5, warn_fraction: 0.5 });
    for (const bad of [{ window_days: 0 }, { window_days: 31 }, { window_days: 2.5 }, { warn_fraction: 1 }, { warn_fraction: 0 }]) {
      const p = parseRoutingControl({ slots: [...base.slots, { kind: "ops", mode: "consent_window", fill: { users: ["u"] }, ...bad }] });
      expect(p && !p.ok, JSON.stringify(bad)).toBe(true);
    }
    const onBlocking = parseRoutingControl({ slots: [{ kind: "a", mode: "blocking", fill: { users: ["u"] }, window_days: 3 }] });
    expect(onBlocking && !onBlocking.ok && onBlocking.error).toMatch(/only a consent-window slot/);
  });
  it("REGRESSION: a stored table without the new keys parses exactly as before", () => {
    const t = { slots: [...base.slots, { kind: "ops", mode: "consent_window", fill: { roles: ["Operator"] } }] };
    const p = parseRoutingControl(t);
    expect(p && p.ok && p.control.slots[1]).toEqual({ kind: "ops", mode: "consent_window", fill: { roles: ["Operator"] } });
  });
  it("a NEW table putting a consent window on the engineering sign-off is refused with the reason; a stored one is still valid (it waits as a sign-off)", () => {
    for (const cap of ENGINEERING_CAPABILITIES) {
      const t = { slots: [{ kind: "eng", mode: "consent_window", fill: { capability: cap } }] } as never;
      expect(validateRoutingDraft(t)).toMatch(/cannot stand in for the engineering sign-off/);
      expect((parseRoutingControl(t) as { ok: boolean }).ok).toBe(true);
    }
    expect([...CONSENT_REFUSED_CAPABILITIES].sort()).toEqual([...ENGINEERING_CAPABILITIES].sort());
    expect(MODE_LABEL.consent_window).toMatch(/never on engineered work/);
  });
  it("openRoster freezes the slot's window on the roster slot (later edits never rewrite a running window)", () => {
    const opened = openRoster({
      id: "r", control: { slots: [{ kind: "accept", mode: "blocking", fill: { identity: "requester" } }, { kind: "ops", mode: "consent_window", fill: { users: ["o-1"] }, window_days: 5 }] },
      level: "library", cycle: "1A", files: [], ctx: { members: [{ uid: "o-1", role: "Viewer" }, { uid: "req", role: "Viewer" }], policy: null, resource: null, requesterId: "req" },
      openedBy: "d", now: "2026-10-19T09:00:00Z",
    });
    expect(opened.ok && opened.roster.slots.find((s) => s.kind === "ops")).toMatchObject({ windowDays: 5, warnFraction: 2 / 3, mode: "consent_window", status: "open" });
    expect(opened.ok && "windowDays" in opened.roster.slots.find((s) => s.kind === "accept")!).toBe(false);
  });
});

// ── the engine ──────────────────────────────────────────────────────────────
const ticketWith = (r: TicketReviewRoster | null, status: TicketStatus = "PENDING_REVIEW"): Ticket => ({
  id: "t1", orgId: "o1", ticketId: "REQ-1", title: "x", requestType: "ISO", status, requesterId: "req", requesterRole: "Manager" as Role,
  assignedDrafterId: "d-1", attachments: [], comments: [], history: [], watchers: [], unreadBy: [], createdAt: "2026-10-01",
  deliverableRev: "1A", revisionCount: 0, metadata: r ? { review_roster: r } : {},
} as unknown as Ticket);
const window = { slot: "ops", openedAt: "2026-10-19T09:00:00Z", warnAt: "2026-10-21T09:00:00Z", closesAt: "2026-10-22T09:00:00Z", recipients: ["o-1", "o-2"] };
const ctx = { activeMemberCount: 5 };

describe("the engine — the objection, and no badge while a window runs", () => {
  it("a person asked is offered the objection (comment required, optional) and their sign-off is optional — not action-required", () => {
    const r = roster([slot({ kind: "accept", primaries: ["req"] }), consent({ primaries: ["o-1", "o-2"] })], { consentWindow: window });
    const t = ticketWith(r);
    const acts = WorkflowEngine.getActions(t, "Viewer", "o-1", undefined, ctx);
    const object = acts.find((a) => a.action === "object_consent_window")!;
    expect(object).toMatchObject({ requiresComment: true, optional: true });
    expect(acts.find((a) => a.action === "sign_slot")).toMatchObject({ optional: true });
    expect(acts.find((a) => a.action === "request_revision")).toMatchObject({ optional: true });
    expect(isActionRequired(t, { uid: "o-1", roles: ["Viewer"], activeMemberCount: 5 } as never)).toBe(false);
    // the requester's own slot is a sign-off as before (not a window)
    expect(WorkflowEngine.getActions(t, "Viewer", "req", undefined, ctx).find((a) => a.action === "sign_slot")!.optional).toBeUndefined();
    // nobody else may object
    expect(WorkflowEngine.getActions(t, "Viewer", "req", undefined, ctx).some((a) => a.action === "object_consent_window")).toBe(false);
  });
  it("REGRESSION: with no window (not opened, objected, expired) the consent slot is a plain sign-off — badged, no objection", () => {
    for (const w of [undefined, { ...window, objectedAt: "2026-10-20T00:00:00Z" }, { ...window, expiredAt: "2026-10-23T00:00:00Z" }]) {
      const r = roster([consent({ primaries: ["o-1"] })], w ? { consentWindow: w } : {});
      const acts = WorkflowEngine.getActions(ticketWith(r), "Viewer", "o-1", undefined, ctx);
      expect(acts.some((a) => a.action === "object_consent_window")).toBe(false);
      expect(acts.find((a) => a.action === "sign_slot")!.optional).toBeUndefined();
      expect(acts.find((a) => a.action === "request_revision")!.optional).toBeUndefined();
    }
  });
  it("REGRESSION: a seeded (unconfigured) ticket offers no consent action at any status, for any role", () => {
    const statuses: TicketStatus[] = ["PENDING_ASSIGNMENT", "PENDING_ENG_TEAM", "DRAFTING", "REVISION_REQ", "PENDING_REVIEW", "PENDING_FINAL_APPROVAL", "PENDING_IFC", "FINAL_DRAFT", "CLOSED", "CANCELED"];
    for (const s of statuses) for (const role of ["Admin", "Manager", "Drafter", "Engineer-2", "Viewer"] as Role[]) for (const uid of ["req", "d-1", "x"]) {
      const acts = WorkflowEngine.getActions(ticketWith(null, s), role, uid, undefined, ctx);
      expect(acts.some((a) => a.action === "object_consent_window"), `${s}/${role}/${uid}`).toBe(false);
    }
  });
  it("windowRunning / mayObject / consentWindowMarker read the mirror; a closed roster has no running window but keeps its record", () => {
    const r = roster([consent()], { consentWindow: window });
    expect(windowRunning(r)).toBe(true);
    expect(mayObject(r, "o-2")).toBe(true);
    expect(mayObject(r, "x")).toBe(false);
    const closed = { ...r, closedAt: "2026-10-23T00:00:00Z" };
    expect(windowRunning(closed)).toBe(false);
    expect(consentWindowMarker({ metadata: { review_roster: closed } })).toMatchObject({ slot: "ops" });
    expect(consentWindowMarker({ metadata: {} })).toBeNull();
  });
});

// ── the transitions ─────────────────────────────────────────────────────────
describe("computeTransition — the objection and the advance", () => {
  const actor = { uid: "o-1", email: "o1@x.io", role: "Viewer" };
  it("object_consent_window stamps the objection on the columns and the mirror, with the reason as the history details; the status does not move", () => {
    const r = roster([consent()], { consentWindow: window });
    const { updates, newStatus } = computeTransition(ticketWith(r), { actionType: "object_consent_window", actionLabel: "Object", comment: "The valve rating changed", consentObjection: true, actor, now: "2026-10-20T10:00:00.000Z" });
    expect(newStatus).toBe("PENDING_REVIEW");
    expect(updates.consent_window_objected_at).toBe("2026-10-20T10:00:00.000Z");
    expect(updates.consent_window_objected_by).toBe("o-1");
    expect(((updates.metadata as Record<string, unknown>).review_roster as TicketReviewRoster).consentWindow).toMatchObject({ objectedAt: "2026-10-20T10:00:00.000Z", objectedBy: "o-1" });
    const h = (updates.history as Array<{ action: string; details?: string }>).at(-1)!;
    expect(h.action).toMatch(/^Objected — "Operations" will not advance/);
    expect(h.details).toBe("The valve rating changed");
    expect(windowRunning(currentRoster({ status: "PENDING_REVIEW", metadata: updates.metadata as Record<string, unknown> }))).toBe(false);
  });
  const system = { uid: null, email: "system:consent-window", role: "System" };
  it("the advance that satisfies the LAST blocking slot issues the ticket as a sign-off does — a recorded system act naming everyone asked", () => {
    const r = roster([slot({ kind: "accept", primaries: ["req"], status: "satisfied", satisfiedBy: "req", satisfiedAt: "2026-10-19T10:00:00Z", signatureId: "s", via: "primary" }), consent()], { consentWindow: window });
    const advanced = { ...r, slots: r.slots.map((s) => (s.kind === "ops" ? consentSatisfiedSlot(s, "2026-10-23T03:00:00.000Z") : s)) };
    const { updates, newStatus } = computeTransition(ticketWith(r), {
      actionType: "consent_window_advance", actionLabel: "Advanced without objection",
      consentAdvance: { roster: advanced, complete: true, label: "Operations", details: "Asked Ann, Bo on …" }, actor: system, now: "2026-10-23T03:00:00.000Z",
    });
    expect(newStatus).toBe("PENDING_IFC");
    expect(updates.deliverable_rev).toBe("1");
    expect(updates.consent_window_expired_at).toBe("2026-10-23T03:00:00.000Z");
    const rr = (updates.metadata as Record<string, unknown>).review_roster as TicketReviewRoster;
    expect(rr.closedReason).toBe("complete");
    expect(rr.slots.find((s) => s.kind === "ops")).toMatchObject({ status: "satisfied", via: "consent", satisfiedBy: null, signatureId: null });
    expect(rr.consentWindow?.expiredAt).toBe("2026-10-23T03:00:00.000Z");
    const h = (updates.history as Array<{ action: string; details?: string; user?: string }>).at(-1)!;
    expect(h.action).toMatch(/^Advanced without objection — Operations \(Rev 1A\) — every sign-off is in; issued Rev 1/);
    expect(h.user).toBe("system:consent-window");
    expect(h.details).toBe("Asked Ann, Bo on …");
    expect("watchers" in updates).toBe(false);
  });
  it("an advance that leaves other sign-offs open does not move the status, and a HELD close only records the window's end", () => {
    const r = roster([slot({ kind: "accept", primaries: ["req"] }), consent()], { consentWindow: window });
    const advanced = { ...r, slots: r.slots.map((s) => (s.kind === "ops" ? consentSatisfiedSlot(s, "2026-10-23T03:00:00.000Z") : s)) };
    const partial = computeTransition(ticketWith(r), { actionType: "consent_window_advance", actionLabel: "x", consentAdvance: { roster: advanced, complete: false, label: "Operations", details: "d" }, actor: system, now: "2026-10-23T03:00:00.000Z" });
    expect(partial.newStatus).toBe("PENDING_REVIEW");
    expect(partial.updates.unread_by).toEqual(expect.arrayContaining(["req"]));
    const held = computeTransition(ticketWith(r), { actionType: "consent_window_advance", actionLabel: "x", consentAdvance: { roster: r, complete: false, label: "Operations", details: "d", held: true }, actor: system, now: "2026-10-23T03:00:00.000Z" });
    expect(held.newStatus).toBe("PENDING_REVIEW");
    expect(((held.updates.metadata as Record<string, unknown>).review_roster as TicketReviewRoster).slots.find((s) => s.kind === "ops")!.status).toBe("open");
    // a hold with no reason never claims the drafter floor
    expect((held.updates.history as Array<{ action: string }>).at(-1)!.action).not.toMatch(/other than the drafter/);
    const floor = computeTransition(ticketWith(r), { actionType: "consent_window_advance", actionLabel: "x", consentAdvance: { roster: r, complete: false, label: "Operations", details: "d", held: true, holdReason: "producer_floor" }, actor: system, now: "2026-10-23T03:00:00.000Z" });
    expect((floor.updates.history as Array<{ action: string }>).at(-1)!.action).toMatch(/still needs a sign-off from someone other than the drafter/);
    expect(((floor.updates.metadata as Record<string, unknown>).review_roster as TicketReviewRoster).consentWindow?.heldReason).toBe("producer_floor");
  });
  it("a close HELD because a recipient has no delivery record says so — never the drafter-floor headline", () => {
    const r = roster([slot({ kind: "accept", primaries: ["req"] }), consent()], { consentWindow: window });
    const held = computeTransition(ticketWith(r), { actionType: "consent_window_advance", actionLabel: "x", consentAdvance: { roster: r, complete: false, label: "Operations", details: "d", held: true, holdReason: "undelivered" }, actor: system, now: "2026-10-23T03:00:00.000Z" });
    const action = (held.updates.history as Array<{ action: string }>).at(-1)!.action;
    expect(action).toMatch(/not everyone asked has a delivery on record/);
    expect(action).not.toMatch(/drafter/);
    for (const reason of ["source_moved", "source_unchecked", "record_mismatch"] as const) expect(consentHeldAction("Ops", reason)).not.toMatch(/drafter/);
    expect(consentHeldAction("Ops", "source_moved")).toMatch(/a source document moved/);
  });
  it("the roster-opened history line says what the consent slot does", () => {
    const r = roster([slot({ kind: "accept", primaries: ["req"] }), consent()], { consentPlan: { kind: "sign_off", slot: "ops", label: "Operations", reason: CONSENT_REASON.engineered } });
    const t = { ...ticketWith(null, "DRAFTING"), attachments: [] } as Ticket;
    const { updates } = computeTransition(t, { actionType: "submit_draft", actionLabel: "Submit", rosterOpen: r, actor: { uid: "d-1", email: "d@x", role: "Drafter" }, now: "2026-10-19T09:00:00Z" });
    const line = (updates.history as Array<{ action: string; details?: string }>).find((h) => h.action === "Review roster opened")!;
    expect(line.details).toContain(`"Operations": ${CONSENT_REASON.engineered}`);
  });
});

describe("rosterCompletion — a slot a window satisfied counts; a satisfied slot with no signature and no window still does not", () => {
  it("the window's slot plus a later human sign-off completes the review", () => {
    const signed = slot({ kind: "accept", primaries: ["req"], status: "satisfied", satisfiedBy: "req", satisfiedAt: "x", signatureId: "s", via: "primary" });
    expect(rosterCompletion(roster([signed, consentSatisfiedSlot(consent(), "x")])).complete).toBe(true);
    expect(rosterCompletion(roster([slot({ kind: "accept", primaries: ["req"] }), consentSatisfiedSlot(consent(), "x")])).complete).toBe(false);
    // the forgery shape (RG-1): satisfied, no signature, not a window — never complete
    expect(rosterCompletion(roster([slot({ kind: "a", status: "satisfied", satisfiedBy: "x", satisfiedAt: "x", signatureId: null, via: "primary" })])).complete).toBe(false);
  });
});

describe("DEC-12 floor, as it reads for silence", () => {
  it("held when the drafter is the only person who signed; not held when nobody signed at all, or someone else signed", () => {
    const f = { sodActive: true, drafterId: "d-1" };
    const asked = ["o-1", "o-2"];
    const signedBy = (u: string) => slot({ kind: "a", primaries: [u], status: "satisfied", satisfiedBy: u, satisfiedAt: "x", signatureId: "s", via: "primary" });
    const done = consentSatisfiedSlot(consent(), "x");
    expect(consentFloorHolds(roster([signedBy("d-1"), done]), f, asked)).toBe(true);
    expect(consentFloorHolds(roster([done]), f, asked)).toBe(false);
    expect(consentFloorHolds(roster([signedBy("e-1"), done]), f, asked)).toBe(false);
    expect(consentFloorHolds(roster([signedBy("d-1"), done]), { sodActive: false, drafterId: "d-1" }, asked)).toBe(false);
  });
  it("DF-P7 fix pass: held whenever nobody but the drafter was asked and told — whatever the org's size, signed or not", () => {
    const done = consentSatisfiedSlot(consent({ primaries: ["d-1"] }), "x");
    expect(consentFloorHolds(roster([done]), { sodActive: true, drafterId: "d-1" }, ["d-1"])).toBe(true);
    expect(consentFloorHolds(roster([done]), { sodActive: false, drafterId: "d-1" }, ["d-1"])).toBe(true);
    expect(consentFloorHolds(roster([done]), { sodActive: true, drafterId: "d-1" }, [])).toBe(true);
    expect(consentFloorHolds(roster([done]), { sodActive: true, drafterId: "d-1" }, ["d-1", "o-1"])).toBe(false);
  });
});

// ── DF-P7 fix pass 2 ────────────────────────────────────────────────────────
describe("DEC-37 slot-to-slot (fix pass 2): a consent slot's silence never stands for a slot it must be independent of", () => {
  const cols = { engineeringRequired: false, columns: true, drafterId: "d-1", requesterId: "req" };
  const checker = (over: Partial<TicketReviewSlot> = {}) => slot({ kind: "checker", label: "Checker", primaries: ["b"], ...over });
  const approver = (over: Partial<TicketReviewSlot> = {}) => consent({ kind: "approver", label: "Approver", primaries: ["b", "c"], independentOf: ["checker"], ...over });
  it("the review's reproduction: B can sign the checker, so B is never asked on an approver independent of the checker — only C is", () => {
    const plan = planConsentWindow(roster([checker(), approver()]), cols);
    expect(plan).toMatchObject({ kind: "open", slot: "approver", recipients: ["c"] });
  });
  it("B the approver's ONLY occupant: BLOCKED (escalated) — never a window B's silence satisfies", () => {
    const plan = planConsentWindow(roster([checker(), approver({ primaries: ["b"] })]), cols);
    expect(plan).toMatchObject({ kind: "blocked", reason: CONSENT_REASON.onlyParties });
  });
  it("read from the other side: a slot that declares itself independent of the consent slot", () => {
    const plan = planConsentWindow(roster([checker({ independentOf: ["approver"] }), approver({ independentOf: [] })]), cols);
    expect(plan).toMatchObject({ kind: "open", recipients: ["c"] });
  });
  it("a slot with no independence declared asks every occupant as before (REGRESSION)", () => {
    const plan = planConsentWindow(roster([checker(), approver({ independentOf: [] })]), cols);
    expect(plan).toMatchObject({ kind: "open", recipients: ["b", "c"] });
  });
  it("consentConflictedPeople: whoever SIGNED a conflicting slot, and whoever can still sign an open one (primaries, alternates, overriders); a consent-satisfied slot names nobody", () => {
    const slots = [
      checker({ status: "satisfied", satisfiedBy: "b", via: "primary", signatureId: "s", satisfiedAt: "x" }),
      slot({ kind: "lead", primaries: ["p"], alternates: ["q"], overriders: ["m"], independentOf: ["approver"] }),
      slot({ kind: "other", primaries: ["z"] }),
      approver({ independentOf: ["checker"] }),
    ];
    expect(consentConflictKinds(slots, "approver")).toEqual(["checker", "lead"]);
    expect([...consentConflictedPeople(slots, "approver")].sort()).toEqual(["b", "m", "p", "q"]);
    const consented = [checker({ status: "satisfied", satisfiedBy: null, via: "consent", satisfiedAt: "x" }), approver()];
    expect([...consentConflictedPeople(consented, "approver")]).toEqual([]);
  });
  it("ledgerIndependenceSlot maps a ticket_review_slots row onto the same rule (the close and the retry read the ledger)", () => {
    const ls = [
      ledgerIndependenceSlot({ slot_kind: "checker", mode: "blocking", status: "satisfied", primaries: ["b"], independent_of: [], satisfied_by: "b", satisfied_via: "primary" }),
      ledgerIndependenceSlot({ slot_kind: "approver", mode: "consent_window", status: "open", primaries: ["b", "c"], independent_of: ["checker"] }),
    ];
    expect([...consentConflictedPeople(ls, "approver")]).toEqual(["b"]);
  });
  it("consentIndependenceHolds: held when everyone told (but the drafter) is conflicted; not when one independent person was told", () => {
    expect(consentIndependenceHolds(["b"], "d-1", new Set(["b"]))).toBe(true);
    expect(consentIndependenceHolds(["b", "d-1"], "d-1", new Set(["b"]))).toBe(true);
    expect(consentIndependenceHolds(["b", "c"], "d-1", new Set(["b"]))).toBe(false);
    expect(consentIndependenceHolds([], "d-1", new Set(["b"]))).toBe(false); // the floor's own limb holds this one
    expect(consentHeldAction("Approver", "independence")).toMatch(/must be independent of, so their silence is not a second look/);
  });
});

describe("the two floors agree (fix pass 2): a silent close never leaves a slot only the drafter can sign", () => {
  // The review's reproduction: requester_acceptance filled by the requester,
  // who is also the drafter D; a consent 'peer' slot asking P1 and P2.
  const acceptance = (over: Partial<TicketReviewSlot> = {}) => slot({ kind: "requester_acceptance", label: "Requester acceptance", primaries: ["d-1"], ...over });
  const peer = (over: Partial<TicketReviewSlot> = {}) => consent({ kind: "peer", label: "Peer check", primaries: ["p-1", "p-2"], ...over });
  const floor = { sodActive: true, drafterId: "d-1" };
  const ticket = { requesterId: "d-1", assignedDrafterId: "d-1" };
  it("drafterOnlyOpenSlot names a slot every occupant of which is the drafter; an overrider or a second primary is someone else", () => {
    expect(drafterOnlyOpenSlot(roster([acceptance(), peer()]), "d-1")?.kind).toBe("requester_acceptance");
    expect(drafterOnlyOpenSlot(roster([acceptance({ overriders: ["m-1"] }), peer()]), "d-1")).toBeNull();
    expect(drafterOnlyOpenSlot(roster([acceptance({ primaries: ["d-1", "x-1"] }), peer()]), "d-1")).toBeNull();
    expect(drafterOnlyOpenSlot(roster([acceptance({ status: "satisfied", satisfiedBy: "d-1" }), peer()]), "d-1")).toBeNull();
  });
  it("close BEFORE the drafter signs: HELD (producer floor) — the peer slot waits for P1 or P2; D then signs, and P1's sign-off completes", () => {
    const advanced = roster([acceptance(), consentSatisfiedSlot(peer(), "x")]);
    expect(consentFloorHolds(advanced, floor, ["p-1", "p-2"])).toBe(true);
    // what an advance WOULD have done: D refused for good on the only slot left
    const stuck = slotSignPlan(advanced, ticket, "d-1", true);
    expect(stuck.fillable).toEqual([]);
    expect(stuck.blocked.map((b) => b.reason).join(" ")).toMatch(/Needs a second person/);
    // the held roster instead: D signs the acceptance (the review still waits on the peer slot) …
    const held = roster([acceptance(), peer()]);
    const plan = slotSignPlan(held, ticket, "d-1", true);
    expect(plan.fillable.map((f) => f.slot.kind)).toEqual(["requester_acceptance"]);
    // … and P1 signs the peer slot: an independent sign-off completes the review
    const after = roster([acceptance({ status: "satisfied", satisfiedBy: "d-1", satisfiedAt: "x", signatureId: "s1", via: "primary" }), peer()]);
    expect(slotSignPlan(after, ticket, "p-1", true).fillable.map((f) => f.slot.kind)).toEqual(["peer"]);
  });
  it("close AFTER the drafter signed: HELD as well (the drafter signed every other sign-off) — one rule, both orders", () => {
    const advanced = roster([acceptance({ status: "satisfied", satisfiedBy: "d-1", satisfiedAt: "x", signatureId: "s1", via: "primary" }), consentSatisfiedSlot(peer(), "x")]);
    expect(consentFloorHolds(advanced, floor, ["p-1", "p-2"])).toBe(true);
  });
  it("below the separation-of-duties threshold, or with someone else able to sign the slot, the close is not held by this limb (REGRESSION)", () => {
    expect(consentFloorHolds(roster([acceptance(), consentSatisfiedSlot(peer(), "x")]), { sodActive: false, drafterId: "d-1" }, ["p-1"])).toBe(false);
    expect(consentFloorHolds(roster([acceptance({ primaries: ["d-1", "x-1"] }), consentSatisfiedSlot(peer(), "x")]), floor, ["p-1"])).toBe(false);
  });
});

describe("the objection keeps the people the request still waits on (fix pass 2)", () => {
  it("unread_by keeps every open blocking slot's occupants (the window's own included) and the existing markers; the objector drops out; they are the recipients", () => {
    const r = roster([slot({ kind: "rev", label: "Reviewer", primaries: ["r-1"] }), consent({ primaries: ["o-1", "o-2"] })], { consentWindow: window });
    const t = { ...ticketWith(r), unreadBy: ["r-1", "o-1", "o-2", "w-9"] } as Ticket;
    const { updates, recipients } = computeTransition(t, { actionType: "object_consent_window", actionLabel: "Object", comment: "No", consentObjection: true, actor: { uid: "o-1", email: "o1@x.io", role: "Viewer" }, now: "2026-10-20T10:00:00.000Z" });
    const unread = updates.unread_by as string[];
    expect(unread).toEqual(expect.arrayContaining(["r-1", "o-2", "w-9", "req", "d-1"]));
    expect(unread).not.toContain("o-1");
    expect(recipients).toEqual(expect.arrayContaining(["r-1", "o-2"]));
  });
});

// ── DF-P7 fix pass 3 ────────────────────────────────────────────────────────
describe("fix pass 3 — a consent slot stored before DF-P7 keeps waiting like a sign-off until a controller re-saves it", () => {
  const cols = { engineeringRequired: false, columns: true };
  it("a consent slot without the opt-in plans a sign-off, said (the editor told its controller it waits like a sign-off)", () => {
    const p = planConsentWindow(roster([consent({ consentConfirmed: undefined })]), cols);
    expect(p).toMatchObject({ kind: "sign_off", slot: "ops", reason: CONSENT_REASON.unconfirmed });
    expect(CONSENT_REASON.unconfirmed).toMatch(/re-saves the routing table/);
    expect(planConsentWindow(roster([consent({ consentConfirmed: false, primaries: [] })]), cols)).toMatchObject({ kind: "sign_off", reason: CONSENT_REASON.unconfirmed });
    // The engineered refusals still win (their reason is the stronger one).
    expect(planConsentWindow(roster([consent({ consentConfirmed: undefined })]), { engineeringRequired: true, columns: true })).toMatchObject({ reason: CONSENT_REASON.engineered });
    expect(planConsentWindow(roster([consent()]), cols)).toMatchObject({ kind: "open" });
  });
  it("parseRoutingControl keeps consent_confirmed only on a consent-window slot; a save (confirmConsentSlots) stamps every consent slot and strips it elsewhere", () => {
    const p = parseRoutingControl({ slots: [
      { kind: "ops", mode: "consent_window", fill: { users: ["u"] }, consent_confirmed: true },
      { kind: "acc", mode: "blocking", fill: { users: ["u"] }, consent_confirmed: true },
      { kind: "qa", mode: "consent_window", fill: { users: ["u"] }, consent_confirmed: "yes" },
    ] });
    expect(p && p.ok && p.control.slots.map((s) => s.consent_confirmed ?? null)).toEqual([true, null, null]);
    const saved = confirmConsentSlots({ slots: [
      { kind: "ops", mode: "consent_window", fill: { users: ["u"] } },
      { kind: "acc", mode: "blocking", fill: { users: ["u"] }, consent_confirmed: true } as never,
    ] });
    expect(saved!.slots).toEqual([
      { kind: "ops", mode: "consent_window", fill: { users: ["u"] }, consent_confirmed: true },
      { kind: "acc", mode: "blocking", fill: { users: ["u"] } },
    ]);
    expect(confirmConsentSlots(null)).toBeNull();
  });
  it("openRoster carries the opt-in onto the roster slot (true only when the stored slot has it)", () => {
    const open = (extra: Record<string, unknown>) => openRoster({
      id: "r", control: { slots: [{ kind: "accept", mode: "blocking", fill: { identity: "requester" } }, { kind: "ops", mode: "consent_window", fill: { users: ["o-1"] }, ...extra }] } as never,
      level: "library", cycle: "1A", files: [], ctx: { members: [{ uid: "o-1", role: "Viewer" }, { uid: "req", role: "Viewer" }], policy: null, resource: null, requesterId: "req" },
      openedBy: "d", now: "2026-10-19T09:00:00Z",
    });
    const a = open({ consent_confirmed: true });
    const b = open({});
    expect(a.ok && a.roster.slots.find((s) => s.kind === "ops")!.consentConfirmed).toBe(true);
    expect(b.ok && b.roster.slots.find((s) => s.kind === "ops")!.consentConfirmed).toBe(false);
    expect(b.ok && "consentConfirmed" in b.roster.slots.find((s) => s.kind === "accept")!).toBe(false);
  });
});

describe("fix pass 3 — FRIC-5: silence issues as-is only on a mark the people asked were told of", () => {
  const system = { uid: null, email: "system:consent-window", role: "System" };
  const draft = [{ id: "a-d", name: "x.pdf", url: "orgs/o1/x.pdf", type: "Draft", rev: "1A", status: "submitted" }];
  const marked = (r: TicketReviewRoster, history: unknown[] = []) => ({ ...ticketWith(r), attachments: draft, history, metadata: { review_roster: r, issue_ready: { rev: "1A", by: "d-1", at: "2026-10-19T08:00:00.000Z" } } } as unknown as Ticket);
  it("the engine does not offer 'Issue As-Is When Approved' while a window runs (it is a sign-off in progress); it does before the window and after it closed", () => {
    const running = roster([slot({ kind: "accept", primaries: ["req"] }), consent()], { consentWindow: window });
    const has = (r: TicketReviewRoster | null) => WorkflowEngine.getActions(ticketWith(r), "Drafter", "d-1", undefined, ctx).some((a) => a.action === "mark_issue_ready");
    expect(has(running)).toBe(false);
    expect(has(roster([slot({ kind: "accept", primaries: ["req"] }), consent()]))).toBe(true);
    expect(has(roster([slot({ kind: "accept", primaries: ["req"] }), consent()], { consentWindow: { ...window, objectedAt: "2026-10-20T00:00:00Z" } }))).toBe(true);
  });
  it("issueAsIsNamedAtOpen: true only for the window's own opening line (machine actor, opened_at) naming THIS mark", () => {
    const r = roster([consent()], { consentWindow: window });
    const line = (over: Record<string, unknown> = {}) => ({ action: "Consent window opened — Operations", user: "system:consent-window", date: "2026-10-19T09:00:00.000000+00:00", [CONSENT_ISSUE_AS_IS_KEY]: { rev: "1A", at: "2026-10-19T08:00:00.000Z" }, ...over });
    expect(issueAsIsNamedAtOpen(marked(r, [line()]), "2026-10-19T09:00:00+00:00")).toBe(true);
    expect(issueAsIsNamedAtOpen(marked(r, [line({ [CONSENT_ISSUE_AS_IS_KEY]: undefined })]), window.openedAt)).toBe(false);
    expect(issueAsIsNamedAtOpen(marked(r, [line({ user: "d-1" })]), window.openedAt)).toBe(false);
    expect(issueAsIsNamedAtOpen(marked(r, [line({ date: "2026-10-18T09:00:00Z" })]), window.openedAt)).toBe(false);
    expect(issueAsIsNamedAtOpen(marked(r, [line({ [CONSENT_ISSUE_AS_IS_KEY]: { rev: "1A", at: "2026-10-20T00:00:00.000Z" } })]), window.openedAt)).toBe(false);
    expect(issueAsIsNamedAtOpen({ ...ticketWith(r), history: [line()] } as never, window.openedAt)).toBe(false);
    expect(issueAsIsNamedAtOpen(marked(r, [line()]), null)).toBe(false);
    expect(issueAsIsMarkOf(marked(r))).toEqual({ rev: "1A", at: "2026-10-19T08:00:00.000Z" });
    expect(issueAsIsMarkOf({ metadata: { issue_ready: { rev: "1" } }, deliverableRev: "1A" })).toBeNull();
  });
  it("an issuing close WITHOUT the notice naming the mark takes the PENDING_IFC hop and withdraws the mark, said", () => {
    const r = roster([slot({ kind: "accept", primaries: ["req"], status: "satisfied", satisfiedBy: "req", satisfiedAt: "2026-10-19T10:00:00Z", signatureId: "s", via: "primary" }), consent()], { consentWindow: window });
    const advanced = { ...r, slots: r.slots.map((s) => (s.kind === "ops" ? consentSatisfiedSlot(s, "2026-10-23T03:00:00.000Z") : s)) };
    const { updates, newStatus } = computeTransition(marked(r), { actionType: "consent_window_advance", actionLabel: "x", consentAdvance: { roster: advanced, complete: true, label: "Operations", details: "d" }, actor: system, now: "2026-10-23T03:00:00.000Z" });
    expect(newStatus).toBe("PENDING_IFC");
    expect("issue_ready" in (updates.metadata as Record<string, unknown>)).toBe(false);
    const h = (updates.history as Array<{ action: string; details?: string }>).at(-1)!;
    expect(h.details).toMatch(/notice did not name it/);
    expect(h.action).not.toMatch(/issued as-is/);
  });
  it("…and WITH it, the draft is issued as the final package (FINAL_DRAFT), as an approval with the note in front of the reviewer does", () => {
    const r = roster([slot({ kind: "accept", primaries: ["req"], status: "satisfied", satisfiedBy: "req", satisfiedAt: "2026-10-19T10:00:00Z", signatureId: "s", via: "primary" }), consent()], { consentWindow: window });
    const advanced = { ...r, slots: r.slots.map((s) => (s.kind === "ops" ? consentSatisfiedSlot(s, "2026-10-23T03:00:00.000Z") : s)) };
    const { newStatus, updates } = computeTransition(marked(r), { actionType: "consent_window_advance", actionLabel: "x", consentAdvance: { roster: advanced, complete: true, label: "Operations", details: "d", issueAsIs: true }, actor: system, now: "2026-10-23T03:00:00.000Z" });
    expect(newStatus).toBe("FINAL_DRAFT");
    expect((updates.history as Array<{ action: string }>).at(-1)!.action).toMatch(/issued as-is/);
  });
  it("the hold reasons fix pass 3 adds are worded by their own headline", () => {
    expect(consentHeldAction("Operations", "no_longer_member")).toMatch(/still an active member/);
    expect(consentHeldAction("Operations", "engineered")).toMatch(/engineered work/);
  });
});
