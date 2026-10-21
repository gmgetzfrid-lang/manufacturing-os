// drafting-flow Round G, DF-P7 CONSENT — the merge-time fix pass (DEC-90
// rulings (2), (3), (5) and (6) for the independent review). The user's top
// rule: no regression — every flow that works today works exactly as
// before, each pinned here.
//
//   (2) validateRoutingDraft / setRoutingControl refuse a consent window on a
//       slot filled by an engineering capability ONLY when that slot is new
//       or changed versus the stored table; an untouched stored slot passes
//       (it waits as a sign-off anyway).
//   (3) confirmConsentSlots stamps the opt-in ONLY on a consent slot the
//       editor touched — an untouched pre-DF-P7 consent slot is never opted
//       into silence by an unrelated edit.
//   (5) an unconfirmed consent slot's roster history and metadata are
//       byte-identical to today's (no note, no consentPlan, no window fields).
//   (6) the export strips details.reason from ticket_notice_events
//       'not_emailed' rows and touches nothing else.
// Ruling (1) is pinned in consentWindowScan.test.ts, (4) in
// dfRoundG_P7_consentRoute.test.ts, the export end to end in
// dfRoundG_P7_exportPrivacy.test.ts.

import { describe, it, expect, vi, beforeEach } from "vitest";

const store = vi.hoisted(() => ({
  rows: {} as Record<string, Array<Record<string, unknown>>>,
  writes: [] as Array<{ table: string; patch: Record<string, unknown> }>,
  readError: null as null | { code?: string; message: string },
}));
vi.mock("@/lib/supabase", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/supabase")>();
  const from = (table: string) => {
    let id: unknown = null;
    let patch: Record<string, unknown> | null = null;
    const b: Record<string, unknown> = {
      select: () => b,
      update: (p: Record<string, unknown>) => { patch = p; return b; },
      eq: (_k: string, v: unknown) => { id = v; return b; },
      maybeSingle: async () => {
        if (store.readError) return { data: null, error: store.readError };
        return { data: (store.rows[table] ?? []).find((r) => r.id === id) ?? null, error: null };
      },
      then: (resolve: (v: unknown) => void) => {
        const row = (store.rows[table] ?? []).find((r) => r.id === id);
        if (patch && row) { store.writes.push({ table, patch }); Object.assign(row, patch); return resolve({ data: [{ id }], error: null }); }
        return resolve({ data: [], error: null });
      },
    };
    return b;
  };
  return { ...real, supabase: { from } };
});

import { validateRoutingDraft, confirmConsentSlots, touchedSlotKinds, setRoutingControl, parseRoutingControl, type RoutingControl } from "@/lib/routingControl";
import { draftToControl, controlToDraft } from "@/components/documents/RoutingControlSection";
import { openRoster } from "@/lib/ticketRoster";
import { computeTransition } from "@/lib/ticketTransitions";
import { planConsentWindow, CONSENT_REASON } from "@/lib/consentWindow";
import { transformExportRow, redactRow, EXPORT_ROW_TRANSFORMS, ORG_SCOPED_TABLES } from "@/lib/exportTables";
import type { Ticket, TicketReviewRoster } from "@/types/schema";

// A table stored BEFORE DF-P7: its consent slot is filled by the engineering
// capability and carries no opt-in (the editor then said "waits like a
// sign-off"). Saving it worked before DF-P7.
const PRE_P7: RoutingControl = { slots: [
  { kind: "accept", label: "Requester acceptance", mode: "blocking", fill: { identity: "requester" } },
  { kind: "eng", label: "Engineering", mode: "consent_window", fill: { capability: "ticket.final_approve" } },
  { kind: "ops", label: "Operations", mode: "consent_window", fill: { users: ["o-1"] } },
] };
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const relabel = (c: RoutingControl, kind: string, label: string): RoutingControl => ({ slots: c.slots.map((s) => (s.kind === kind ? { ...s, label } : s)) });

beforeEach(() => { store.rows = {}; store.writes = []; store.readError = null; });

describe("DEC-90 ruling (2) — REGRESSION: a save that works today is never refused", () => {
  it("editing an unrelated slot's label on a table whose stored consent slot is filled by the engineering capability passes", () => {
    expect(validateRoutingDraft(relabel(clone(PRE_P7), "accept", "Acceptance by the requester"), clone(PRE_P7))).toBeNull();
    // saved unchanged too
    expect(validateRoutingDraft(clone(PRE_P7), clone(PRE_P7))).toBeNull();
  });
  it("the rule still holds for a NEW or CHANGED engineering-filled consent slot", () => {
    const err = /cannot stand in for the engineering sign-off/;
    expect(validateRoutingDraft(relabel(clone(PRE_P7), "eng", "Eng check"), clone(PRE_P7))).toMatch(err);
    expect(validateRoutingDraft(clone(PRE_P7), null)).toMatch(err);
    const added: RoutingControl = { slots: [...clone(PRE_P7).slots.filter((s) => s.kind !== "eng"), { kind: "eng2", mode: "consent_window", fill: { capability: "ticket.eng_review" } }] };
    expect(validateRoutingDraft(added, clone(PRE_P7))).toMatch(err);
    // a blocking slot switched to consent on the engineering capability is a change
    const stored: RoutingControl = { slots: [{ ...PRE_P7.slots[0] }, { kind: "eng", mode: "blocking", fill: { capability: "ticket.final_approve" } }] };
    expect(validateRoutingDraft({ slots: [{ ...PRE_P7.slots[0] }, { kind: "eng", mode: "consent_window", fill: { capability: "ticket.final_approve" } }] }, stored)).toMatch(err);
    // no stored table given: every slot is new (the shape the editor's preview used before)
    expect(validateRoutingDraft(clone(PRE_P7))).toMatch(err);
  });
  it("setRoutingControl: the unrelated label edit SAVES exactly as before — the written table is the draft itself (no opt-in stamped on the untouched slots)", async () => {
    store.rows.libraries = [{ id: "lib-1", routing_control: clone(PRE_P7) }];
    const draft = relabel(clone(PRE_P7), "accept", "Acceptance by the requester");
    await expect(setRoutingControl({ level: "library", id: "lib-1", control: draft })).resolves.toBeUndefined();
    expect(store.writes).toHaveLength(1);
    expect(store.writes[0].patch.routing_control).toEqual(draft);
  });
  it("setRoutingControl: a changed engineering-filled consent slot is refused, nothing written", async () => {
    store.rows.libraries = [{ id: "lib-1", routing_control: clone(PRE_P7) }];
    await expect(setRoutingControl({ level: "library", id: "lib-1", control: relabel(clone(PRE_P7), "eng", "Eng") })).rejects.toThrow(/can't be saved: slot "eng"/);
    expect(store.writes).toEqual([]);
  });
  it("setRoutingControl: clearing a level (inherit) writes NULL without reading, as before", async () => {
    store.rows.libraries = [{ id: "lib-1", routing_control: clone(PRE_P7) }];
    store.readError = { code: "08006", message: "connection lost" };
    await setRoutingControl({ level: "library", id: "lib-1", control: null });
    expect(store.writes).toEqual([{ table: "libraries", patch: { routing_control: null } }]);
  });
  it("setRoutingControl: a stored table that cannot be read is never guessed at — not saved, said", async () => {
    store.rows.libraries = [{ id: "lib-1", routing_control: clone(PRE_P7) }];
    store.readError = { code: "08006", message: "connection lost" };
    await expect(setRoutingControl({ level: "library", id: "lib-1", control: relabel(clone(PRE_P7), "accept", "A") })).rejects.toThrow(/could not be read to compare with/);
    expect(store.writes).toEqual([]);
  });
});

describe("DEC-90 ruling (3) — fail-safe opt-in: only a consent slot the editor touched is stamped", () => {
  it("an unrelated edit never opts an untouched pre-DF-P7 consent slot into silence", () => {
    const saved = confirmConsentSlots(relabel(clone(PRE_P7), "accept", "A"), clone(PRE_P7))!;
    expect(saved.slots.find((s) => s.kind === "ops")!.consent_confirmed).toBeUndefined();
    expect(saved.slots.find((s) => s.kind === "eng")!.consent_confirmed).toBeUndefined();
  });
  it("a consent slot the editor changed, or added, is stamped; an untouched confirmed one stays confirmed; another mode never carries it", () => {
    const stored: RoutingControl = { slots: [...clone(PRE_P7).slots, { kind: "qa", mode: "consent_window", fill: { users: ["q-1"] }, consent_confirmed: true }] };
    const draft: RoutingControl = { slots: [
      { ...PRE_P7.slots[0], consent_confirmed: true } as never,
      { kind: "ops", label: "Operations", mode: "consent_window", fill: { users: ["o-1", "o-2"] } }, // changed
      { kind: "qa", mode: "consent_window", fill: { users: ["q-1"] } }, // untouched, confirmed before (the editor drops the flag)
      { kind: "new", mode: "consent_window", fill: { users: ["n-1"] } }, // added
    ] };
    const saved = confirmConsentSlots(draft, stored)!;
    expect(saved.slots.map((s) => [s.kind, s.consent_confirmed ?? null])).toEqual([["accept", null], ["ops", true], ["qa", true], ["new", true]]);
  });
  it("setRoutingControl writes the untouched pre-DF-P7 consent slot without the opt-in, and the changed one with it", async () => {
    store.rows.libraries = [{ id: "lib-1", routing_control: clone(PRE_P7) }];
    const draft: RoutingControl = { slots: clone(PRE_P7).slots.map((s) => (s.kind === "ops" ? { ...s, window_days: 5 } : s)) };
    await setRoutingControl({ level: "library", id: "lib-1", control: draft });
    const written = store.writes[0].patch.routing_control as RoutingControl;
    expect(written.slots.find((s) => s.kind === "ops")).toMatchObject({ window_days: 5, consent_confirmed: true });
    expect(written.slots.find((s) => s.kind === "eng")!.consent_confirmed).toBeUndefined();
  });
  it("the editor's round trip (stored → draft → stored) touches nothing — its window settings are kept, never dropped", () => {
    const stored: RoutingControl = { slots: [
      { kind: "accept", label: "Requester acceptance", mode: "blocking", fill: { identity: "requester" }, independent_of: ["drafter"] },
      { kind: "ops", label: "Operations", mode: "consent_window", fill: { users: ["o-1"] }, window_days: 5, warn_fraction: 0.5, consent_confirmed: true },
      { kind: "old", mode: "consent_window", fill: { roles: ["Operator"] }, alternates: { roles: ["Lead"] }, timeoutDays: 2 },
    ] };
    const parsed = parseRoutingControl(stored);
    const roundTrip = draftToControl(controlToDraft(parsed && parsed.ok ? parsed.control : stored));
    expect(touchedSlotKinds(roundTrip, stored).size).toBe(0);
    expect(roundTrip.slots.find((s) => s.kind === "ops")).toMatchObject({ window_days: 5, warn_fraction: 0.5 });
    expect(confirmConsentSlots(roundTrip, stored)!.slots.map((s) => s.consent_confirmed ?? null)).toEqual([null, true, null]);
    // a kept window is dropped when the editor switches the slot to another mode (only a consent slot has one)
    const asBlocking = controlToDraft(parsed && parsed.ok ? parsed.control : stored).map((d) => (d.kind === "ops" ? { ...d, mode: "blocking" as const } : d));
    const c = draftToControl(asBlocking);
    expect("window_days" in c.slots.find((s) => s.kind === "ops")!).toBe(false);
    expect(validateRoutingDraft(c, stored)).toBeNull();
  });
});

describe("DEC-90 ruling (5) — an existing unconfirmed consent slot: history and metadata byte-identical to today", () => {
  const ctx = { members: [{ uid: "o-1", role: "Viewer" }, { uid: "req", role: "Viewer" }], policy: null, resource: null, requesterId: "req" };
  const table = (consent: Record<string, unknown>) => ({ slots: [{ kind: "accept", label: "Requester acceptance", mode: "blocking", fill: { identity: "requester" } }, { kind: "ops", label: "Operations", fill: { users: ["o-1"] }, ...consent }] }) as never;
  const submitWith = (r: TicketReviewRoster) => {
    const t = { id: "t1", orgId: "o1", ticketId: "REQ-1", title: "x", requestType: "ISO", status: "DRAFTING", requesterId: "req", assignedDrafterId: "d-1",
      attachments: [], comments: [], history: [], watchers: [], unreadBy: [], deliverableRev: "1A", revisionCount: 0, metadata: {} } as unknown as Ticket;
    return computeTransition(t, { actionType: "submit_draft", actionLabel: "Submit", rosterOpen: r, actor: { uid: "d-1", email: "d@x", role: "Drafter" }, now: "2026-10-19T09:00:00Z" }).updates;
  };
  it("the roster the unconfirmed consent slot opens is today's (the same slot a blocking one opens, but its mode); no plan; the line names only the sign-offs", () => {
    const consent = openRoster({ id: "r", control: table({ mode: "consent_window" }), level: "library", cycle: "1A", files: [], ctx, openedBy: "d", now: "2026-10-19T09:00:00Z" });
    const blocking = openRoster({ id: "r", control: table({ mode: "blocking" }), level: "library", cycle: "1A", files: [], ctx, openedBy: "d", now: "2026-10-19T09:00:00Z" });
    expect(consent.ok && blocking.ok).toBe(true);
    if (!consent.ok || !blocking.ok) return;
    const ops = consent.roster.slots.find((s) => s.kind === "ops")!;
    expect({ ...ops, mode: "blocking" }).toEqual(blocking.roster.slots.find((s) => s.kind === "ops"));
    // the route plans 'unconfirmed' and attaches nothing; even a roster that carries it writes nothing of it
    const plan = planConsentWindow(consent.roster, { engineeringRequired: false, columns: true });
    expect(plan).toMatchObject({ kind: "sign_off", reason: CONSENT_REASON.unconfirmed });
    const plain = submitWith(consent.roster);
    const carried = submitWith({ ...consent.roster, consentPlan: plan! });
    expect(JSON.stringify(carried.metadata)).toBe(JSON.stringify(plain.metadata));
    expect(JSON.stringify(carried.history)).toBe(JSON.stringify(plain.history));
    expect("consentPlan" in ((carried.metadata as { review_roster: TicketReviewRoster }).review_roster)).toBe(false);
    const line = (carried.history as Array<{ action: string; details?: string }>).find((h) => h.action === "Review roster opened")!;
    expect(line.details).toBe("Sign-offs needed (any order): Requester acceptance, Operations");
  });
  it("REGRESSION: a confirmed slot's plan is still written and noted", () => {
    const opened = openRoster({ id: "r", control: table({ mode: "consent_window", consent_confirmed: true }), level: "library", cycle: "1A", files: [], ctx, openedBy: "d", now: "2026-10-19T09:00:00Z" });
    if (!opened.ok) throw new Error("not opened");
    const plan = planConsentWindow(opened.roster, { engineeringRequired: false, columns: true })!;
    expect(plan.kind).toBe("open");
    const u = submitWith({ ...opened.roster, consentPlan: plan });
    expect((u.metadata as { review_roster: TicketReviewRoster }).review_roster.consentPlan).toEqual(plan);
    expect((u.history as Array<{ action: string; details?: string }>).find((h) => h.action === "Review roster opened")!.details).toMatch(/"Operations" may object within 3 working days/);
  });
});

describe("DEC-90 ruling (6) — the export strips a not_emailed row's private reason, and nothing else", () => {
  it("a not_emailed row loses details.reason (the rest of the row and of details kept); other kinds are the same object", () => {
    const row = { id: "e1", org_id: "o1", kind: "not_emailed", recipient: "u-1", details: { reason: "their own preference", event: "assignment", phase: "opened" } };
    expect(transformExportRow("ticket_notice_events", row)).toEqual({ id: "e1", org_id: "o1", kind: "not_emailed", recipient: "u-1", details: { event: "assignment", phase: "opened" } });
    expect(row.details.reason).toBe("their own preference"); // pure — the source row is not mutated
    const delivered = { id: "e2", kind: "delivered", details: { reason: "window_opened" } };
    expect(transformExportRow("ticket_notice_events", delivered)).toBe(delivered);
    const blocked = { id: "e3", kind: "blocked", details: { reason: "window_never_opened" } };
    expect(transformExportRow("ticket_notice_events", blocked)).toBe(blocked);
    const noReason = { id: "e4", kind: "not_emailed", details: { event: "assignment" } };
    expect(transformExportRow("ticket_notice_events", noReason)).toBe(noReason);
  });
  it("every other exported table passes through as the very same object (its export bytes unchanged)", () => {
    expect(Object.keys(EXPORT_ROW_TRANSFORMS)).toEqual(["ticket_notice_events"]);
    const look = { id: "x", kind: "not_emailed", details: { reason: "kept" } };
    for (const t of ORG_SCOPED_TABLES) {
      if (t === "ticket_notice_events") continue;
      const r = redactRow(t, { ...look });
      expect(transformExportRow(t, r)).toBe(r);
    }
  });
});
