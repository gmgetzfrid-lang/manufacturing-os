// drafting-flow Round G, DF-P26 — GAP-115 / GAP-109 mechanism 3,
// EXCEPTION-ONLY REVIEW (DEC-90 ruling (1) for DF-P26): the pure rules and
// the reads (lib/exceptionOnlyReview.ts), the routing opt-in
// (lib/routingControl.ts exception_only — parser, editor validation, the
// editor's draft round trip), the roster's frozen flag (lib/ticketRoster.ts
// openRoster), completion over a rule-satisfied slot, and the DEC-12 floor
// in its three homes never counting one.

import { describe, it, expect } from "vitest";
import {
  isExceptionOnlySlot, planExceptionRule, applyExceptionRule, ruleSatisfiedSlots, exceptionsOnRecord, reopenRuleSatisfied,
  waitsOnLiveSecondPerson, exceptionRuleAtOpen, exceptionOnlyReady, readWaiverOnRecord, readSourceMoved, ruleOpenNote, ruleReopenNote,
  RULE_SATISFIED_NAME,
} from "@/lib/exceptionOnlyReview";
import { parseRoutingControl, validateRoutingDraft, exceptionOnlyOptInAllowed, type RoutingControl } from "@/lib/routingControl";
import { openRoster, rosterCompletion, applySignPlan } from "@/lib/ticketRoster";
import { rosterLacksIndependentSignOff, slotSignPlan, ruleUpgradeNeeded, WorkflowEngine, RULE_UPGRADE_OPTIONAL_NOTE, RULE_UPGRADE_NEEDED_NOTE } from "@/lib/workflow";
import { isActionRequired } from "@/lib/ticketAttention";
import { computeTransition } from "@/lib/ticketTransitions";
import { consentFloorHolds } from "@/lib/consentWindow";
import { preauthLeavesNoSecondPerson } from "@/lib/ticketPreauthorization";
import { controlToDraft, draftToControl, exceptionOptInFor, withSlotMode, EXCEPTION_ONLY_HINT } from "@/components/documents/RoutingControlSection";
import { slotStateText, RULE_SATISFIED_TEXT, exceptionReopenConfirmation, ruleUpgradeButtonText } from "@/components/requests/TicketRosterPanel";
import type { Role, Ticket, TicketReviewRoster, TicketReviewSlot, TicketStatus } from "@/types/schema";

const T = { requesterId: "req", assignedDrafterId: "d-1" } as Pick<Ticket, "requesterId" | "assignedDrafterId">;
const NOW = Date.parse("2026-10-22T08:00:00Z");
const slot = (over: Partial<TicketReviewSlot> & { kind: string }): TicketReviewSlot => ({
  id: `r:${over.kind}`, label: over.kind.toUpperCase(), mode: "blocking", primaries: [], alternates: [], overriders: [], independentOf: [],
  timeoutDays: null, fallback: false, status: "open", ...over,
});
const roster = (slots: TicketReviewSlot[]): TicketReviewRoster => ({ v: 1, id: "R1", openedAt: "2026-10-22T07:00:00Z", openedBy: "d-1", level: "library", cycle: "1A", contentHash: "h", files: [], slots });
const EO = slot({ kind: "doc", primaries: ["c-1"], exceptionOnly: true });
const LIVE = slot({ kind: "lead", primaries: ["l-1"] });

describe("the opt-in on a routing slot (lib/routingControl.ts)", () => {
  const base = (over: Record<string, unknown>) => ({ slots: [{ kind: "lead", mode: "blocking", fill: { roles: ["Manager"] } }, { kind: "doc", mode: "blocking", fill: { roles: ["DocCtrl"] }, ...over }] });
  it("kept on a plain blocking slot; dropped silently (never refused) anywhere else", () => {
    const keep = parseRoutingControl(base({ exception_only: true }));
    expect(keep && keep.ok && keep.control.slots[1].exception_only).toBe(true);
    for (const over of [
      { mode: "consent_window", exception_only: true },
      { mode: "notify_only", exception_only: true },
      { fill: { capability: "ticket.final_approve" }, exception_only: true },
      { fill: { identity: "requester" }, exception_only: true },
      { records_examination: true, exception_only: true },
      { accepts_preauthorization: true, exception_only: true },
      { exception_only: "yes" },
    ]) {
      const p = parseRoutingControl(base(over));
      expect(p && p.ok, JSON.stringify(over)).toBe(true);
      expect(p && p.ok && p.control.slots[1].exception_only, JSON.stringify(over)).toBeUndefined();
    }
  });
  it("REGRESSION: a table without the opt-in parses exactly as before (no key added)", () => {
    const raw = base({});
    const p = parseRoutingControl(raw);
    expect(p && p.ok && JSON.stringify(p.control)).toBe(JSON.stringify(raw));
  });
  it("the editor refuses a save that writes a misplaced one, with the reason", () => {
    expect(validateRoutingDraft(base({ exception_only: true }) as RoutingControl)).toBeNull();
    expect(validateRoutingDraft(base({ mode: "consent_window", exception_only: true }) as RoutingControl)).toMatch(/only a "must sign off" slot can be exception-only/);
    expect(validateRoutingDraft(base({ fill: { capability: "ticket.final_approve" }, exception_only: true }) as RoutingControl)).toMatch(/engineering sign-off is never satisfied by a rule/);
    expect(validateRoutingDraft(base({ records_examination: true, exception_only: true }) as RoutingControl)).toMatch(/assurance check/);
    expect(validateRoutingDraft(base({ accepts_preauthorization: true, exception_only: true }) as RoutingControl)).toMatch(/choose one/);
    expect(validateRoutingDraft(base({ fill: { identity: "requester" }, exception_only: true }) as RoutingControl)).toMatch(/requester's own acceptance/);
    expect(validateRoutingDraft(base({ exception_only: 1 }) as unknown as RoutingControl)).toMatch(/on or off/);
    expect(exceptionOnlyOptInAllowed({ mode: "blocking", fill: { roles: ["X"] } })).toBe(true);
  });
  it("the editor: offered where it can ride, round-trips, dropped on a mode change or when the slot accepts a pre-authorization", () => {
    const control: RoutingControl = { slots: [{ kind: "lead", mode: "blocking", fill: { roles: ["Manager"] } }, { kind: "doc", mode: "blocking", fill: { roles: ["DocCtrl"] }, exception_only: true }] };
    const drafts = controlToDraft(control);
    expect(drafts[1].exceptionOnly).toBe(true);
    expect(exceptionOptInFor(drafts[1])).toBe("offer");
    expect(draftToControl(drafts)).toEqual(control);
    expect(draftToControl([drafts[0], { ...drafts[1], acceptsPreauthorization: true }]).slots[1].exception_only).toBeUndefined();
    expect(withSlotMode(drafts[1], "consent_window").exceptionOnly).toBeUndefined();
    expect(EXCEPTION_ONLY_HINT).toMatch(/Never on engineered work, and never the last sign-off a review waits on/);
    // REGRESSION: a table that never set it round-trips with no key
    const plain: RoutingControl = { slots: [{ kind: "lead", mode: "blocking", fill: { roles: ["Manager"] } }] };
    expect(draftToControl(controlToDraft(plain))).toEqual(plain);
  });
  it("openRoster freezes the flag on the slot (only where kept); every other slot is stored exactly as before", () => {
    const ctx = { members: [{ uid: "m-1", role: "Manager", roles: ["Manager"], status: "active" }, { uid: "c-1", role: "DocCtrl", roles: ["DocCtrl"], status: "active" }], policy: undefined, resource: undefined, requesterId: "req" } as never;
    const p = parseRoutingControl({ slots: [{ kind: "lead", mode: "blocking", fill: { roles: ["Manager"] } }, { kind: "doc", mode: "blocking", fill: { roles: ["DocCtrl"] }, exception_only: true }] });
    const opened = openRoster({ id: "R", control: (p as { control: RoutingControl }).control, level: "library", cycle: "1A", files: [], ctx, openedBy: "d-1", now: "2026-10-22T07:00:00Z" });
    expect(opened.ok && opened.roster.slots[1].exceptionOnly).toBe(true);
    expect(opened.ok && "exceptionOnly" in opened.roster.slots[0]).toBe(false);
  });
});

describe("limb 1 — which slots the rule may satisfy when a review opens (pure)", () => {
  it("an exception-only slot beside a live sign-off by someone other than the drafter: satisfied", () => {
    expect(planExceptionRule(roster([EO, LIVE]), { ticket: T, sodActive: true, engineered: false, now: NOW })).toEqual(["doc"]);
  });
  it("NEVER on engineered work", () => {
    expect(planExceptionRule(roster([EO, LIVE]), { ticket: T, sodActive: true, engineered: true, now: NOW })).toEqual([]);
  });
  it("NEVER the last sign-off a review waits on (alone, or with only a consent window or a pre-authorization slot beside it)", () => {
    expect(planExceptionRule(roster([EO]), { ticket: T, sodActive: true, engineered: false, now: NOW })).toEqual([]);
    expect(planExceptionRule(roster([EO, slot({ kind: "ops", mode: "consent_window", primaries: ["o-1"] })]), { ticket: T, sodActive: true, engineered: false, now: NOW })).toEqual([]);
    expect(planExceptionRule(roster([EO, slot({ kind: "pa", primaries: ["p-1"], acceptsPreauthorization: true })]), { ticket: T, sodActive: true, engineered: false, now: NOW })).toEqual([]);
  });
  it("NEVER the DEC-12 second person: beside a sign-off only the drafter can give, it waits; below the threshold the drafter counts", () => {
    const drafterOnly = slot({ kind: "self", primaries: ["d-1"] });
    expect(planExceptionRule(roster([EO, drafterOnly]), { ticket: T, sodActive: true, engineered: false, now: NOW })).toEqual([]);
    expect(planExceptionRule(roster([EO, drafterOnly]), { ticket: T, sodActive: false, engineered: false, now: NOW })).toEqual(["doc"]);
  });
  it("two exception-only slots and one live: both; two exception-only slots alone: only one (the other stays live)", () => {
    const EO2 = slot({ kind: "doc2", primaries: ["c-2"], exceptionOnly: true });
    expect(planExceptionRule(roster([EO, EO2, LIVE]), { ticket: T, sodActive: true, engineered: false, now: NOW })).toEqual(["doc", "doc2"]);
    expect(planExceptionRule(roster([EO, EO2]), { ticket: T, sodActive: true, engineered: false, now: NOW })).toEqual(["doc"]);
  });
  it("a frozen flag on an engineering, assurance, pre-authorization or requester slot is never acted on", () => {
    for (const over of [{ engineering: true }, { recordsExamination: true as const }, { acceptsPreauthorization: true as const }, { primaries: ["req"] }]) {
      expect(isExceptionOnlySlot({ ...EO, ...over }, T), JSON.stringify(over)).toBe(false);
    }
    expect(isExceptionOnlySlot(EO, T)).toBe(true);
  });
  it("applyExceptionRule: a recorded system act — no signer, no signature, the rule named", () => {
    const r = applyExceptionRule(roster([EO, LIVE]), ["doc"], "2026-10-22T08:00:00.000Z");
    expect(r.slots[0]).toMatchObject({ status: "satisfied", via: "rule", satisfiedBy: null, signatureId: null, satisfiedByName: RULE_SATISFIED_NAME });
    expect(ruleSatisfiedSlots(r).map((s) => s.kind)).toEqual(["doc"]);
    expect(ruleOpenNote(["DOC"])).toMatch(/^Satisfied by rule \(exception-only review — no exception on record\): DOC\./);
  });
  it("completion counts a rule-satisfied slot; the producer floor in its three homes never counts it as anyone's sign-off", () => {
    const r = applyExceptionRule(roster([EO, slot({ kind: "lead", primaries: ["d-1", "l-1"] })]), ["doc"], "2026-10-22T08:00:00.000Z");
    // the drafter signing the remaining slot would complete — the floor refuses it: the rule is not a second person
    expect(rosterLacksIndependentSignOff(r, "d-1", ["lead"])).toBe(true);
    expect(slotSignPlan(r, T, "d-1", true, NOW).fillable).toEqual([]);
    const signedByDrafter: TicketReviewRoster = { ...r, slots: r.slots.map((s) => (s.kind === "lead" ? { ...s, status: "satisfied" as const, satisfiedBy: "d-1", signatureId: "s", via: "primary" as const } : s)) };
    expect(rosterCompletion(signedByDrafter, { sodActive: true, drafterId: "d-1" }).complete).toBe(false);
    const signedByLead: TicketReviewRoster = { ...r, slots: r.slots.map((s) => (s.kind === "lead" ? { ...s, status: "satisfied" as const, satisfiedBy: "l-1", signatureId: "s", via: "primary" as const } : s)) };
    expect(rosterCompletion(signedByLead, { sodActive: true, drafterId: "d-1" }).complete).toBe(true);
    // Even a rule satisfaction that (wrongly) named a signer is never counted:
    const viaRuleWithSigner: TicketReviewRoster = { ...r, slots: r.slots.map((s) => (s.kind === "doc" ? { ...s, satisfiedBy: "l-1" } : s)) };
    // consentFloorHolds: the only real sign-off is the drafter's → it holds
    const drafterSignedRest: TicketReviewRoster = { ...viaRuleWithSigner, slots: viaRuleWithSigner.slots.map((s) => (s.kind === "lead" ? { ...s, status: "satisfied" as const, satisfiedBy: "d-1", signatureId: "s", via: "primary" as const } : s)) };
    expect(consentFloorHolds(drafterSignedRest, { sodActive: true, drafterId: "d-1" }, ["o-1"])).toBe(true);
    expect(rosterLacksIndependentSignOff(viaRuleWithSigner, "d-1", ["lead"])).toBe(true);
    expect(preauthLeavesNoSecondPerson({ ...viaRuleWithSigner, slots: viaRuleWithSigner.slots.map((s) => (s.kind === "lead" ? { ...s, primaries: ["d-1"] } : s)) }, { requesterId: "req", assignedDrafterId: "d-1" }, true, NOW)).toBe(true);
  });
  it("waitsOnLiveSecondPerson: a primary the engine offers the slot; never an overrider", () => {
    expect(waitsOnLiveSecondPerson(roster([slot({ kind: "x", overriders: ["o-9"] })]), T, true, NOW)).toBe(false);
    expect(waitsOnLiveSecondPerson(roster([LIVE]), T, true, NOW)).toBe(true);
  });
});

describe("limb 2 — the exceptions on record and the re-open (pure)", () => {
  it("each kind of fact, never a free-text guess", () => {
    const signed = roster([EO, { ...LIVE, status: "satisfied", via: "override", satisfiedBy: "m-1", signatureId: "s" }]);
    const ex = exceptionsOnRecord({ driftLabels: ["P-100 raised on Rev 2, now Rev 3"], roster: signed, waiver: true, declarationUnverified: "missing", engineered: true });
    expect(ex.map((e) => e.kind)).toEqual(["source_moved", "override", "waiver", "declaration", "engineered"]);
    // DF-P26 review fix: a declaration whose signature merely could not be READ is a retry for the
    // caller (503), never an exception on record — it does not re-open the rule's slot for good
    expect(exceptionsOnRecord({ driftLabels: [], roster: roster([EO, LIVE]), waiver: false, declarationUnverified: "unchecked", engineered: false })).toEqual([]);
    expect(exceptionsOnRecord({ driftLabels: [], roster: roster([EO, LIVE]), waiver: false, declarationUnverified: null, engineered: false })).toEqual([]);
    expect(exceptionsOnRecord({ driftLabels: [], roster: roster([EO]), waiver: false, declarationUnverified: "missing", engineered: false })[0].text).toMatch(/signature is not on record/);
  });
  it("reopenRuleSatisfied: the rule's slots go back to open (satisfaction cleared, the exceptions named); every other slot untouched", () => {
    const r = applyExceptionRule(roster([EO, { ...LIVE, status: "satisfied", via: "primary", satisfiedBy: "l-1", signatureId: "s" }]), ["doc"], "2026-10-22T08:00:00.000Z");
    const re = reopenRuleSatisfied(r, ["a waiver of required examination data is recorded"], "2026-10-22T09:00:00.000Z");
    expect(re.slots[0]).toMatchObject({ status: "open", exceptionReopened: { at: "2026-10-22T09:00:00.000Z", exceptions: ["a waiver of required examination data is recorded"] } });
    expect(re.slots[0].via).toBeUndefined();
    expect(re.slots[0].satisfiedAt).toBeUndefined();
    expect(re.slots[1]).toEqual(r.slots[1]);
    expect(rosterCompletion(re).complete).toBe(false);
    expect(ruleReopenNote(["DOC"], ["x"])).toBe("Re-opened for its reviewer: DOC — exception-only review no longer stands because x. The request does not issue until it is signed.");
  });
  it("the roster panel names the rule, never a signer; a re-opened slot says why it waits", () => {
    const r = applyExceptionRule(roster([EO, LIVE]), ["doc"], "2026-10-22T08:00:00.000Z");
    expect(slotStateText(r.slots[0], new Map())).toMatch(new RegExp(`^${RULE_SATISFIED_TEXT.replace(/[()]/g, "\\$&")}`));
    expect(slotStateText(r.slots[0], new Map())).not.toMatch(/Signed by/);
    const re = reopenRuleSatisfied(r, ["x happened"], "2026-10-22T09:00:00.000Z");
    expect(slotStateText(re.slots[0], new Map())).toBe("Re-opened for its reviewer: x happened. Waiting on any one of 1 person");
    // REGRESSION: an ordinary satisfied slot reads exactly as before
    expect(slotStateText({ ...LIVE, status: "satisfied", satisfiedBy: "l-1", via: "primary" }, new Map([["l-1", "Lee"]]))).toBe("Signed by Lee");
  });
});

type Row = Record<string, unknown>;
function fakeDb(tables: Record<string, Row[]>, opts: { rpc?: { data: unknown; error: unknown } | "throw"; errors?: Record<string, { code?: string; message: string }> } = {}) {
  const reads: string[] = [];
  const db = {
    rpc: async () => { if (opts.rpc === "throw") throw new Error("boom"); return opts.rpc ?? { data: true, error: null }; },
    from(t: string) {
      reads.push(t);
      const filters: Array<(r: Row) => boolean> = [];
      const b: Record<string, unknown> = {
        select: () => b,
        eq: (k: string, v: unknown) => { filters.push((r) => r[k] === v); return b; },
        in: (k: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[k])); return b; },
        maybeSingle: async () => (opts.errors?.[t] ? { data: null, error: opts.errors[t] } : { data: (tables[t] ?? []).filter((r) => filters.every((f) => f(r)))[0] ?? null, error: null }),
        then: (resolve: (v: unknown) => void) => resolve(opts.errors?.[t] ? { data: null, error: opts.errors[t] } : { data: (tables[t] ?? []).filter((r) => filters.every((f) => f(r))), error: null }),
      };
      return b;
    },
  };
  return { db, reads };
}
const DOC = "d0c00000-0000-4000-8000-000000000001";
const ticket = (meta: Row = {}): Ticket => ({ id: "t1", orgId: "o1", requesterId: "req", assignedDrafterId: "d-1", metadata: meta } as unknown as Ticket);

describe("the reads (fail-safe: anything unreadable applies nothing)", () => {
  it("exceptionOnlyReady: true only when the function answers true", async () => {
    expect(await exceptionOnlyReady(fakeDb({}).db)).toBe(true);
    expect(await exceptionOnlyReady(fakeDb({}, { rpc: { data: null, error: { code: "PGRST202", message: "missing" } } }).db)).toBe(false);
    expect(await exceptionOnlyReady(fakeDb({}, { rpc: "throw" }).db)).toBe(false);
    expect(await exceptionOnlyReady({ from: () => null })).toBe(false);
  });
  it("readWaiverOnRecord: a waiver object; none; before 20261266 none; another error is unreadable", async () => {
    expect(await readWaiverOnRecord(fakeDb({ ticket_examination_scopes: [{ ticket_id: "t1", waiver: { reason: "r" } }] }).db, "t1")).toEqual({ ok: true, waiver: true });
    expect(await readWaiverOnRecord(fakeDb({ ticket_examination_scopes: [{ ticket_id: "t1", waiver: null }] }).db, "t1")).toEqual({ ok: true, waiver: false });
    expect(await readWaiverOnRecord(fakeDb({}, { errors: { ticket_examination_scopes: { code: "42P01", message: "x" } } }).db, "t1")).toEqual({ ok: true, waiver: false });
    expect((await readWaiverOnRecord(fakeDb({}, { errors: { ticket_examination_scopes: { code: "08006", message: "down" } } }).db, "t1")).ok).toBe(false);
  });
  it("readSourceMoved: a moved source labelled; none named reads nothing", async () => {
    const t = ticket({ source_document: { id: DOC, document_number: "P-100", rev: "2" } });
    expect(await readSourceMoved(fakeDb({ documents: [{ id: DOC, org_id: "o1", rev: "3", current_version_id: null, document_number: "P-100" }] }).db, t)).toEqual({ ok: true, labels: ["P-100 raised on Rev 2, now Rev 3"] });
    expect(await readSourceMoved(fakeDb({ documents: [{ id: DOC, org_id: "o1", rev: "2", current_version_id: null, document_number: "P-100" }] }).db, t)).toEqual({ ok: true, labels: [] });
    const none = fakeDb({});
    expect(await readSourceMoved(none.db, ticket())).toEqual({ ok: true, labels: [] });
    expect(none.reads).toEqual([]);
  });
  it("exceptionRuleAtOpen: applied when nothing is on record; each reason otherwise, the roster untouched", async () => {
    const r = roster([EO, LIVE]);
    const t = ticket({ source_document: { id: DOC, rev: "2" } });
    const docs = { documents: [{ id: DOC, org_id: "o1", rev: "2", current_version_id: null }] };
    const ok = await exceptionRuleAtOpen(fakeDb(docs).db, { roster: r, ticket: t, ticketId: "t1", sodActive: true, engineered: false, now: NOW });
    expect(ok).toMatchObject({ applied: true, kinds: ["doc"], labels: ["DOC"] });
    const cases: Array<[ReturnType<typeof fakeDb>["db"], boolean, string]> = [
      [fakeDb(docs).db, true, "engineered"],
      [fakeDb(docs, { rpc: { data: null, error: { code: "PGRST202", message: "missing" } } }).db, false, "not_migrated"],
      [fakeDb({ documents: [{ id: DOC, org_id: "o1", rev: "3", current_version_id: null }] }).db, false, "source_moved"],
      [fakeDb(docs, { errors: { documents: { message: "down" } } }).db, false, "unchecked"],
      [fakeDb({ ...docs, ticket_examination_scopes: [{ ticket_id: "t1", waiver: { reason: "r" } }] }).db, false, "waiver"],
      [fakeDb(docs, { errors: { ticket_examination_scopes: { code: "08006", message: "down" } } }).db, false, "unchecked"],
    ];
    for (const [db, engineered, reason] of cases) {
      const res = await exceptionRuleAtOpen(db, { roster: r, ticket: t, ticketId: "t1", sodActive: true, engineered, now: NOW });
      expect(res, reason).toMatchObject({ applied: false, reason });
      expect(res.roster, reason).toBe(r);
    }
    expect(await exceptionRuleAtOpen(fakeDb(docs).db, { roster: roster([EO]), ticket: t, ticketId: "t1", sodActive: true, engineered: false, now: NOW })).toMatchObject({ applied: false, reason: "no_live_sign_off" });
  });
  it("DF-P26 fix pass 4: whether the request is engineered work UNKNOWN (engineeredUnchecked) — nothing applied, reason \"unchecked\", nothing read; a known engineered request still says \"engineered\"", async () => {
    const r = roster([EO, LIVE]);
    const t = ticket({ source_document: { id: DOC, rev: "2" } });
    const f = fakeDb({ documents: [{ id: DOC, org_id: "o1", rev: "2", current_version_id: null }] });
    const res = await exceptionRuleAtOpen(f.db, { roster: r, ticket: t, ticketId: "t1", sodActive: true, engineered: false, engineeredUnchecked: true, now: NOW });
    expect(res).toMatchObject({ applied: false, reason: "unchecked", kinds: ["doc"] });
    expect(res.roster).toBe(r);
    expect(f.reads).toEqual([]);
    expect(await exceptionRuleAtOpen(f.db, { roster: r, ticket: t, ticketId: "t1", sodActive: true, engineered: true, engineeredUnchecked: true, now: NOW })).toMatchObject({ applied: false, reason: "engineered" });
  });
});

describe("DF-P26 review fix — a slot the rule satisfied stays signable by its own occupants (no deadlock behind the DEC-12 floor)", () => {
  // Separation of duties active; drafter d-1. Slot A is exception-only (primary x-1, overrider o-1);
  // slot B has primaries d-1 and y-1. At open y-1 was live, so the rule satisfied A. Then y-1 left
  // (no longer offered anything — modelled by removing them from B).
  const A = slot({ kind: "a", primaries: ["x-1"], overriders: ["o-1"], exceptionOnly: true });
  const B = slot({ kind: "b", primaries: ["d-1", "y-1"] });
  const atOpen = applyExceptionRule(roster([A, B]), ["a"], "2026-10-22T08:00:00.000Z");
  const afterLeave: TicketReviewRoster = { ...atOpen, slots: atOpen.slots.map((x) => (x.kind === "b" ? { ...x, primaries: ["d-1"] } : x)) };
  it("the drafter alone is held by the floor (the rule is never the second person)", () => {
    const d = slotSignPlan(afterLeave, T, "d-1", true, NOW);
    expect(d.fillable).toEqual([]);
    expect(d.blocked.map((b) => b.slot.kind)).toEqual(["b"]);
  });
  it("the rule's slot's primary may sign it (a person's sign-off upgrades the rule's); an overrider may not", () => {
    const x = slotSignPlan(afterLeave, T, "x-1", true, NOW);
    expect(x.fillable.map((f) => [f.slot.kind, f.via])).toEqual([["a", "primary"]]);
    expect(slotSignPlan(afterLeave, T, "o-1", true, NOW).fillable).toEqual([]);
    const upgraded = applySignPlan(afterLeave, x, { uid: "x-1", name: "X" }, "sig-x", "2026-10-22T09:00:00.000Z");
    expect(upgraded.slots[0]).toMatchObject({ status: "satisfied", via: "primary", satisfiedBy: "x-1", signatureId: "sig-x" });
    expect(ruleSatisfiedSlots(upgraded)).toEqual([]);
    // ... and the drafter can now complete B: someone else has signed
    const d = slotSignPlan(upgraded, T, "d-1", true, NOW);
    expect(d.fillable.map((f) => f.slot.kind)).toEqual(["b"]);
    expect(rosterCompletion(applySignPlan(upgraded, d, { uid: "d-1", name: "D" }, "sig-d", "2026-10-22T10:00:00.000Z"), { sodActive: true, drafterId: "d-1" }).complete).toBe(true);
  });
  it("REGRESSION: a slot satisfied by anyone else (a person, consent, a pre-authorization) is never offered again", () => {
    for (const via of ["primary", "consent", "preauthorization", "override"] as const) {
      const r = roster([{ ...A, status: "satisfied", via, satisfiedBy: via === "consent" ? null : "z-1", signatureId: via === "consent" ? null : "s" }, B]);
      expect(slotSignPlan(r, T, "x-1", true, NOW).fillable, via).toEqual([]);
    }
  });
});

describe("DF-P26 fix pass 2 — the rule's slot is never DEMANDED of the reviewer it excused (engine, attention, panel)", () => {
  const ticketWith = (r: TicketReviewRoster, status: TicketStatus = "PENDING_REVIEW"): Ticket => ({
    id: "t1", orgId: "o1", ticketId: "REQ-1", title: "x", requestType: "ISO", status, requesterId: "req", requesterRole: "Manager" as Role,
    assignedDrafterId: "d-1", attachments: [], comments: [], history: [], watchers: [], unreadBy: [], createdAt: "2026-10-01",
    deliverableRev: "1A", revisionCount: 0, metadata: { review_roster: r },
  } as unknown as Ticket);
  const ctx = { activeMemberCount: 5, reviewRouted: true, now: NOW };
  const acts = (r: TicketReviewRoster, uid: string) => WorkflowEngine.getActions(ticketWith(r), "Viewer", uid, undefined, ctx);
  const required = (r: TicketReviewRoster, uid: string) => isActionRequired(ticketWith(r), { uid, roles: ["Viewer"], activeMemberCount: 5 } as never);
  // The reviewer's reproduction: doc {primaries c-1, exception-only} and lead {primaries l-1}; the rule satisfied doc.
  // doc also names the drafter d-1 as a primary and a-1 as an alternate (window opens after 1 day).
  const DOC = slot({ kind: "doc", primaries: ["c-1", "d-1"], alternates: ["a-1"], timeoutDays: 1, exceptionOnly: true });
  const ruled = applyExceptionRule(roster([DOC, LIVE]), ["doc"], "2026-10-22T08:00:00.000Z");
  const late = { ...ruled, openedAt: "2026-10-19T07:00:00Z" };

  it("the rule's slot's primary: a sign-off is OFFERED (the upgrade) but optional, as is a revision — not action-required", () => {
    expect(ruleUpgradeNeeded(ruled, T, true)).toBe(false);
    const a = acts(ruled, "c-1");
    const sign = a.find((x) => x.action === "sign_slot")!;
    expect(sign).toMatchObject({ label: "Sign Off — DOC", optional: true });
    expect(sign.description).toContain(RULE_UPGRADE_OPTIONAL_NOTE);
    expect(a.find((x) => x.action === "request_revision")).toMatchObject({ optional: true });
    expect(required(ruled, "c-1")).toBe(false);
  });
  it("the drafter (a primary of the rule's slot too) is never offered the rule's slot — their sign-off is never the second person", () => {
    expect(slotSignPlan(ruled, T, "d-1", true, NOW).fillable.map((f) => f.slot.kind)).toEqual([]);
    expect(acts(ruled, "d-1").some((x) => x.action === "sign_slot" && !x.disabledReason)).toBe(false);
  });
  it("an alternate: nothing before the alternate window opens; after it, the optional upgrade only", () => {
    expect(acts(ruled, "a-1").some((x) => x.action === "sign_slot")).toBe(false);
    expect(required(ruled, "a-1")).toBe(false);
    expect(acts(late, "a-1").find((x) => x.action === "sign_slot")).toMatchObject({ optional: true });
    expect(isActionRequired(ticketWith(late), { uid: "a-1", roles: ["Viewer"], activeMemberCount: 5 } as never)).toBe(false);
  });
  it("the live slot's reviewer is still badged (the review waits on them)", () => {
    expect(acts(ruled, "l-1").find((x) => x.action === "sign_slot")!.optional).toBeUndefined();
    expect(required(ruled, "l-1")).toBe(true);
  });
  it("DF-P26 fix pass 3: an upgrade an independence reason forbids is simply not offered — no disabled sign-off, no required revision, not action-required", () => {
    // R is independent of A; c-1 signed A, so c-1 cannot sign R — and R was satisfied by the rule at open
    const R = slot({ kind: "doc", primaries: ["c-1"], exceptionOnly: true, independentOf: ["a"] });
    const A = slot({ kind: "a", primaries: ["c-1"], status: "satisfied", satisfiedBy: "c-1", signatureId: "s-a", via: "primary", satisfiedAt: "2026-10-22T07:30:00Z" });
    const r = applyExceptionRule(roster([R, A, LIVE]), ["doc"], "2026-10-22T08:00:00.000Z");
    expect(slotSignPlan(r, T, "c-1", true, NOW)).toEqual({ fillable: [], blocked: [] });
    const a = acts(r, "c-1");
    expect(a.some((x) => x.action === "sign_slot")).toBe(false);
    expect(a.some((x) => x.action === "request_revision" && !x.optional)).toBe(false);
    expect(required(r, "c-1")).toBe(false);
    // the requester leg: the rule's slot independent of the requester, the requester among its people
    const RQ = slot({ kind: "doc", primaries: ["req", "c-1"], exceptionOnly: true, independentOf: ["requester"] });
    const rq = applyExceptionRule(roster([RQ, LIVE]), ["doc"], "2026-10-22T08:00:00.000Z");
    expect(slotSignPlan(rq, T, "req", true, NOW)).toEqual({ fillable: [], blocked: [] });
    // REGRESSION: an OPEN slot an independence reason blocks is still shown, disabled, with its reason
    const open = roster([slot({ kind: "doc", primaries: ["c-1"], independentOf: ["a"] }), A, LIVE]);
    expect(slotSignPlan(open, T, "c-1", true, NOW).blocked.map((b) => b.slot.kind)).toEqual(["doc"]);
    expect(acts(open, "c-1").find((x) => x.action === "sign_slot")!.disabledReason).toMatch(/Needs a second person/);
  });
  it("below the DEC-12 threshold the rule's slot is offered to nobody (the upgrade exists only for the floor)", () => {
    expect(slotSignPlan(ruled, T, "c-1", false, NOW).fillable).toEqual([]);
  });
  it("NEEDED only where the floor would otherwise leave nobody named able to complete — then required, and said", () => {
    // only the drafter is named on the open slot: without the upgrade the review cannot complete
    const stuck: TicketReviewRoster = { ...ruled, slots: ruled.slots.map((x) => (x.kind === "lead" ? { ...x, primaries: ["d-1"] } : x)) };
    expect(ruleUpgradeNeeded(stuck, T, true)).toBe(true);
    const sign = acts(stuck, "c-1").find((x) => x.action === "sign_slot")!;
    expect(sign.optional).toBeUndefined();
    expect(sign.description).toContain(RULE_UPGRADE_NEEDED_NOTE);
    expect(required(stuck, "c-1")).toBe(true);
    // ... not when someone else has already signed, nor below the threshold, nor with no drafter
    const signedOther: TicketReviewRoster = { ...stuck, slots: [...stuck.slots, slot({ kind: "x", primaries: ["z-1"], status: "satisfied", satisfiedBy: "z-1", signatureId: "s", via: "primary" })] };
    expect(ruleUpgradeNeeded(signedOther, T, true)).toBe(false);
    expect(ruleUpgradeNeeded(stuck, T, false)).toBe(false);
    expect(ruleUpgradeNeeded(stuck, { assignedDrafterId: null }, true)).toBe(false);
    // ... nor on a roster the rule never touched
    expect(ruleUpgradeNeeded(roster([slot({ kind: "lead", primaries: ["d-1"] })]), T, true)).toBe(false);
  });
  it("the panel labels it as an optional 'sign it yourself' upgrade, or as needed", () => {
    expect(ruleUpgradeButtonText(["DOC"], false)).toBe("Sign it yourself (optional) — DOC");
    expect(ruleUpgradeButtonText(["DOC"], true)).toMatch(/^Sign off — DOC \(needed/);
  });
  it("the dry run's re-open is told before the e-signature is minted", () => {
    expect(exceptionReopenConfirmation(["DOC"], ["a waiver of required examination data is recorded"]))
      .toBe("Your sign-off will be recorded, but DOC will be re-opened for its reviewer because a waiver of required examination data is recorded. The request will not issue yet.");
    expect(exceptionReopenConfirmation(["DOC"], undefined)).toMatch(/because an exception is now on record\. The request will not issue yet\.$/);
  });
  it("the roster-opened line: the rule's slot is not 'needed', and its people are neither unread nor told", () => {
    const t = { ...ticketWith(ruled, "DRAFTING"), metadata: {} } as Ticket;
    const { updates, recipients } = computeTransition(t, { actionType: "submit_draft", actionLabel: "Submit", rosterOpen: ruled, actor: { uid: "d-1", email: "d@x", role: "Drafter" }, now: "2026-10-22T08:00:00Z" });
    const line = (updates.history as Array<{ action: string; details?: string }>).find((h) => h.action === "Review roster opened")!;
    expect(line.details).toMatch(/^Sign-offs needed \(any order\): LEAD(?! ?,)/);
    expect(line.details).not.toMatch(/DOC/);
    expect(updates.unread_by).toEqual(["req", "l-1"]); // the requester, as the base transition tells them
    expect(recipients).toEqual(["req", "l-1"]);
    // REGRESSION: a roster the rule never touched lists and tells everyone, as before
    const plain = roster([DOC, LIVE]);
    const out = computeTransition(t, { actionType: "submit_draft", actionLabel: "Submit", rosterOpen: plain, actor: { uid: "d-1", email: "d@x", role: "Drafter" }, now: "2026-10-22T08:00:00Z" });
    expect((out.updates.history as Array<{ action: string; details?: string }>).find((h) => h.action === "Review roster opened")!.details).toMatch(/^Sign-offs needed \(any order\): DOC, LEAD/);
    expect(out.updates.unread_by).toEqual(["req", "c-1", "l-1"]);
  });
});
