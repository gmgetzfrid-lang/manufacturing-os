// drafting-flow Round G, DF-P5 ROSTER — GAP-112 the routing table, GAP-103 the
// parallel roster (lib/routingControl.ts, lib/ticketRoster.ts, the engine's
// roster mode and computeTransition), FRIC-5 issue-as-is, and the migrations'
// DEC-30 shape. The route is driven in dfRoundG_P5_rosterRoute.test.ts; the
// two migrations run on PostgreSQL 16 in lib/__tests__/rls/dfP5RosterRouting.test.ts.

import { describe, it, expect, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  parseRoutingControl, resolveEffectiveRoutingControl, resolveRoutingControlChain, effectiveRoutingForTicket,
  SEEDED_ROUTING, seededSlotsFor, validateRoutingDraft,
} from "@/lib/routingControl";
import {
  openRoster, applySignPlan, rosterCompletion, signatureRefusal, sha256OfStoredObject, rosterContentHash,
  filesUnderReview, resolveFill, writeRosterLedger, isMissingRosterLedger,
} from "@/lib/ticketRoster";
import * as reviewControl from "@/lib/reviewControl";
import { WorkflowEngine, slotSignPlan, currentRoster, issueReadyFor, engineerApprovalRequired, ticketResource } from "@/lib/workflow";
import { computeTransition, issueAsIsFinals, type TransitionInput } from "@/lib/ticketTransitions";
import { engineerCandidates, engineerPickRefusal } from "@/lib/ticketPage";
import type { Ticket, TicketAttachment, TicketReviewRoster } from "@/types/schema";

vi.mock("@/lib/supabase", () => ({ supabase: { from: () => { throw Object.assign(new Error("column libraries.routing_control does not exist"), { code: "42703" }); } } }));

const NOW = "2026-10-21T12:00:00.000Z";
const LIB = "1b000000-0000-4000-8000-000000000001";
const member = (uid: string, role: string, roles = [role]) => ({ uid, role, roles, email: `${uid}@x.io`, display_name: uid });
const MEMBERS = [member("req-1", "Requester"), member("d-1", "Drafter"), member("e-1", "Engineer-2"), member("e-2", "Engineer-3"),
  member("q-1", "Supervisor"), member("a-1", "Admin")];
const ctx = { members: MEMBERS, policy: null, resource: { requestType: "ISO", unit: null }, requesterId: "req-1" };
const FILES = [{ id: "a-d", name: "iso_1A.pdf", url: "orgs/o1/tickets/REQ-1/iso_1A.pdf", sha256: "f".repeat(64) }];
const TWO_SLOTS = { slots: [
  { kind: "accept", label: "Requester acceptance", mode: "blocking", fill: { identity: "requester" } },
  { kind: "check", label: "Engineering check", mode: "blocking", fill: { roles: ["Engineer"] }, independent_of: ["drafter"] },
  { kind: "told", label: "Process safety (told)", mode: "notify_only", fill: { users: ["q-1"] } },
] };
const mk = (over: Partial<Ticket> = {}): Ticket => ({
  id: "t1", orgId: "o1", ticketId: "REQ-1", title: "x", unit: null, requestType: "ISO", status: "PENDING_REVIEW",
  requesterId: "req-1", requesterRole: "Requester", assignedDrafterId: "d-1", createdAt: NOW, history: [], attachments: [],
  comments: [], watchers: [], unreadBy: [], revisionCount: 0, deliverableRev: "1A", draftIteration: 1, libraryId: LIB, ...over,
});
const opened = (control: unknown = TWO_SLOTS): TicketReviewRoster => {
  const p = parseRoutingControl(control);
  if (!p || !p.ok) throw new Error("bad control");
  const r = openRoster({ id: "r-1", control: p.control, level: "library", cycle: "1A", files: FILES, ctx, openedBy: "d-1", now: NOW });
  if (!r.ok) throw new Error(r.error);
  return r.roster;
};
const withRoster = (roster: TicketReviewRoster, over: Partial<Ticket> = {}) => mk({ metadata: { review_roster: roster }, ...over });

// ═════════════════════════════════════════════════════════════════════════════
describe("GAP-112 / DEC-36 — the routing resolver: the same cases as resolveEffectiveDocClass", () => {
  const A = { slots: [{ kind: "a", mode: "blocking", fill: { roles: ["Engineer"] } }] };
  const B = { slots: [{ kind: "b", mode: "blocking", fill: { users: ["e-1"] } }] };
  const C = { slots: [{ kind: "c", mode: "blocking", fill: { identity: "requester" } }] };
  const kind = (r: ReturnType<typeof resolveEffectiveRoutingControl>) => (r.state === "configured" ? r.control.slots[0].kind : r.state);
  it("most specific DEFINED level wins — document, then folder, then library; nothing anywhere = unconfigured", () => {
    expect(kind(resolveEffectiveRoutingControl(A, B, C))).toBe("a");
    expect(kind(resolveEffectiveRoutingControl(null, B, C))).toBe("b");
    expect(kind(resolveEffectiveRoutingControl(null, null, C))).toBe("c");
    expect(resolveEffectiveRoutingControl(null, null, null)).toEqual({ state: "unconfigured" });
    expect(resolveEffectiveRoutingControl(undefined, undefined, undefined)).toEqual({ state: "unconfigured" });
  });
  it("a folder chain is walked nearest first (one resolver: lib/containerChain.ts firstDefinedInChain); the level is reported", () => {
    const r = resolveRoutingControlChain({ document: null, folders: [{ id: "f1", value: null }, { id: "f0", value: B }], library: C });
    expect(r).toMatchObject({ state: "configured", level: "collection" });
    expect(kind(r)).toBe("b");
    expect(resolveRoutingControlChain({ document: undefined, folders: [], library: A })).toMatchObject({ state: "configured", level: "library" });
  });
  it("declared, never guessed: a junk declaration is INVALID (the route refuses with the reason), never silently 'no routing'", () => {
    for (const junk of ["p&id", [], {}, { slots: [] }, { slots: [{ kind: "x", mode: "blocking", fill: {} }] },
      { slots: [{ kind: "x", mode: "maybe", fill: { roles: ["Engineer"] } }] },
      { slots: [{ kind: "drafter", mode: "blocking", fill: { roles: ["Engineer"] } }] },
      { slots: [{ kind: "x", mode: "notify_only", fill: { roles: ["Engineer"] } }] },
      { slots: [{ kind: "x", mode: "blocking", fill: { roles: ["Engineer"] }, independent_of: ["nobody"] }] }]) {
      const r = resolveEffectiveRoutingControl(null, null, junk);
      expect(r.state, JSON.stringify(junk)).toBe("invalid");
    }
    expect(validateRoutingDraft(null)).toBeNull();
    expect(validateRoutingDraft({ slots: [] } as never)).toMatch(/no slots/);
  });
  it("fail CLOSED: a missing column is today's routing; a ticket with no library reads nothing", async () => {
    // the supabase stand-in answers 42703 (20261241 not pasted): unconfigured
    expect(await effectiveRoutingForTicket({ libraryId: LIB })).toEqual({ state: "unconfigured" });
    expect(await effectiveRoutingForTicket({ libraryId: null })).toEqual({ state: "unconfigured" });
  });
  it("a transient read failure THROWS (source pin: the loader rethrows anything but the missing-schema shapes)", () => {
    const src = readFileSync(join(process.cwd(), "lib", "routingControl.ts"), "utf8");
    expect(src).toContain("if (isMissingRoutingSchema(e)) return { state: \"unconfigured\" };");
    expect(src).toContain("throw new Error(`Couldn't read this request's routing:");
    // ONE resolver: the loader rides lib/containerChain.ts, no second walk
    expect(src).toContain('loadContainerChain<unknown>("routing_control"');
    expect(src).not.toMatch(/from\("collections"\)/);
  });
});

describe("GAP-112 / DEC-90 ruling (2) — the seed is today's behaviour, pinned against the engine", () => {
  it("the seed's slots: requester acceptance (identity, blocking) and engineering (ticket.final_approve, independent of the drafter); management override optional", () => {
    expect(SEEDED_ROUTING.slots.map((s) => [s.kind, s.mode])).toEqual([["requester_acceptance", "blocking"], ["engineering", "blocking"]]);
    expect(SEEDED_ROUTING.slots[0].fill).toEqual({ identity: "requester" });
    expect(SEEDED_ROUTING.slots[1]).toMatchObject({ fill: { capability: "ticket.final_approve" }, independent_of: ["drafter"] });
    expect(SEEDED_ROUTING.managementOverride).toEqual({ capability: "ticket.manage", optional: true });
    expect(parseRoutingControl({ slots: SEEDED_ROUTING.slots })).toMatchObject({ ok: true });
  });
  it("for an unconfigured ticket the seeded view and the state machine agree: who it waits on, and whether the engineer step applies", () => {
    const plannerTicket = mk({ status: "PENDING_REVIEW", requesterRole: "Maintenance", libraryId: null });
    const gate = engineerApprovalRequired(plannerTicket.requesterRole, null, null, plannerTicket.requesterId, ticketResource(plannerTicket));
    const seeded = seededSlotsFor(plannerTicket, gate);
    expect(seeded.map((v) => [v.kind, v.state])).toEqual([["requester_acceptance", "waiting"], ["engineering", "pending"]]);
    // the engine: the requester is offered "send for engineer approval", never a direct approve
    const acts = WorkflowEngine.getActions(plannerTicket, "Maintenance" as never, "req-1").map((a) => a.action);
    expect(acts).toContain("request_final_engineer_approval");
    expect(acts).not.toContain("approve_draft_ifc");
    // an engineer requester: the gate does not apply — the seed says so, the engine offers the approve
    const engTicket = mk({ status: "PENDING_REVIEW", requesterRole: "Engineer-2", libraryId: null });
    const g2 = engineerApprovalRequired(engTicket.requesterRole, null, null, engTicket.requesterId, ticketResource(engTicket));
    expect(seededSlotsFor(engTicket, g2)[1].state).toBe("not_required");
    expect(WorkflowEngine.getActions(engTicket, "Engineer-2" as never, "req-1").map((a) => a.action)).toContain("approve_draft_ifc");
    // at PENDING_FINAL_APPROVAL the seed waits on the engineer, as the engine does
    const fin = seededSlotsFor(mk({ status: "PENDING_FINAL_APPROVAL", assignedEngineerName: "E" }), true);
    expect(fin.map((v) => v.state)).toEqual(["done", "waiting"]);
  });
  it("REGRESSION: a ticket with no roster gets exactly today's actions at PENDING_REVIEW (no sign_slot anywhere)", () => {
    for (const [role, uid] of [["Requester", "req-1"], ["Engineer-2", "e-1"], ["Admin", "a-1"], ["Drafter", "d-1"]] as const) {
      const acts = WorkflowEngine.getActions(mk({ libraryId: LIB }), role as never, uid, undefined, { activeMemberCount: 5 });
      expect(acts.some((a) => a.action === "sign_slot"), role).toBe(false);
    }
  });
});

describe("GAP-103 — opening a roster (lib/ticketRoster.ts)", () => {
  it("resolves each slot's occupants from the active members: identity, roles (token rule), people, capability under the policy", () => {
    expect(resolveFill({ identity: "requester" }, ctx)).toEqual(["req-1"]);
    expect(resolveFill({ roles: ["Engineer"] }, ctx)).toEqual(["e-1", "e-2"]);
    expect(resolveFill({ users: ["q-1", "gone"] }, ctx)).toEqual(["q-1"]);
    expect(resolveFill({ capability: "ticket.manage" }, ctx)).toEqual(expect.arrayContaining(["a-1", "q-1"]));
  });
  it("opens one slot per routing slot, blocking ones open and notify-only ones told, all bound to one content hash", () => {
    const r = opened();
    expect(r.slots.map((s) => [s.kind, s.status, s.primaries])).toEqual([
      ["accept", "open", ["req-1"]], ["check", "open", ["e-1", "e-2"]], ["told", "told", ["q-1"]],
    ]);
    expect(r.contentHash).toBe(rosterContentHash(FILES));
    expect(r.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });
  it("a blocking slot that resolves to nobody is filled by the management tier, marked fallback — a stop never resolves to nobody", () => {
    const r = opened({ slots: [{ kind: "x", mode: "blocking", fill: { roles: ["Contractor"] } }] });
    expect(r.slots[0].fallback).toBe(true);
    expect(r.slots[0].primaries.length).toBeGreaterThan(0);
    const none = openRoster({ id: "r", control: { slots: [{ kind: "x", mode: "blocking", fill: { roles: ["Contractor"] } }] }, level: "library", cycle: null, files: FILES,
      ctx: { ...ctx, members: [member("d-1", "Drafter")] }, openedBy: null, now: NOW });
    expect(none).toMatchObject({ ok: false, code: "routing_unfillable" });
  });
  it("the files under review are the Drafts of the revision; a file from before per-file revisions falls back to the latest Draft", () => {
    const a = [{ type: "Draft", rev: "1A", status: "submitted", name: "a" }, { type: "Draft", rev: "1B", status: "submitted", name: "b" }, { type: "Source", name: "s" }] as TicketAttachment[];
    expect(filesUnderReview(a, "1B").map((f) => f.name)).toEqual(["b"]);
    expect(filesUnderReview([{ type: "Draft", status: "submitted", name: "old" } as TicketAttachment], "2A").map((f) => f.name)).toEqual(["old"]);
    expect(filesUnderReview([{ type: "Draft", status: "staged", name: "x" } as TicketAttachment], "1A")).toEqual([]);
  });
  it("EVID-12: sha256 is computed from the bytes; a missing object is not transient, a failed fetch is", async () => {
    const body = (s: string) => ({ Body: (async function* () { yield new TextEncoder().encode(s); })() });
    const ok = await sha256OfStoredObject("orgs/o1/tickets/REQ-1/a.pdf", async () => body("hello"));
    expect(ok).toEqual({ ok: true, sha256: createHash("sha256").update("hello").digest("hex") });
    expect(await sha256OfStoredObject("orgs/o1/a.pdf", async () => ({ Body: { transformToByteArray: async () => new TextEncoder().encode("hello") } })))
      .toEqual(ok);
    expect(await sha256OfStoredObject("orgs/o1/a.pdf", async () => { throw Object.assign(new Error("x"), { name: "NoSuchKey" }); }))
      .toEqual({ ok: false, transient: false, reason: "the file is not in storage" });
    expect(await sha256OfStoredObject("orgs/o1/a.pdf", async () => { throw new Error("timeout"); })).toMatchObject({ ok: false, transient: true });
    expect(await sha256OfStoredObject("https://x/a.pdf", async () => body("x"))).toMatchObject({ ok: false, transient: false });
    expect(await sha256OfStoredObject("orgs/o1/a.pdf", async () => ({ ContentLength: 10 ** 10 }))).toMatchObject({ ok: false, reason: "too large to hash in a request" });
  });
});

describe("GAP-103 / TIER-5 — signing: either order, simultaneous, auto-advance; adding a slot adds no status", () => {
  it("TIER-5 done-when 1: two required reviewers can sign in either order — each is offered their slot while the other's is open", () => {
    const r = opened();
    const t = withRoster(r);
    expect(slotSignPlan(r, t, "req-1", true, Date.parse(NOW)).fillable.map((f) => f.slot.kind)).toEqual(["accept"]);
    expect(slotSignPlan(r, t, "e-1", true, Date.parse(NOW)).fillable.map((f) => f.slot.kind)).toEqual(["check"]);
    // engineer first, then the requester
    const afterEng = applySignPlan(r, slotSignPlan(r, t, "e-1", true), { uid: "e-1", name: "E1" }, "sig-e", NOW);
    expect(rosterCompletion(afterEng).complete).toBe(false);
    expect(slotSignPlan(afterEng, withRoster(afterEng), "req-1", true).fillable.map((f) => f.slot.kind)).toEqual(["accept"]);
    const done = applySignPlan(afterEng, slotSignPlan(afterEng, withRoster(afterEng), "req-1", true), { uid: "req-1", name: "R" }, "sig-r", NOW);
    expect(rosterCompletion(done)).toEqual({ complete: true, unsatisfied: [] });
    // the other order lands at the same place
    const afterReq = applySignPlan(r, slotSignPlan(r, t, "req-1", true), { uid: "req-1", name: "R" }, "sig-r", NOW);
    const done2 = applySignPlan(afterReq, slotSignPlan(afterReq, withRoster(afterReq), "e-2", true), { uid: "e-2", name: "E2" }, "sig-e", NOW);
    expect(rosterCompletion(done2).complete).toBe(true);
  });
  it("completion CALLS lib/reviewControl.ts evaluateSlotCompletion (one slot group per blocking slot); notify-only slots require nothing", () => {
    const spy = vi.spyOn(reviewControl, "evaluateSlotCompletion");
    const r = opened();
    const res = rosterCompletion(r);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0].map((x) => x.slotGroup)).toEqual(["accept", "check"]);
    expect(res).toEqual({ complete: false, unsatisfied: ["accept", "check"] });
    spy.mockRestore();
  });
  it("DEC-37: one person filling two slots satisfies both with ONE sign-off, and the record names both", () => {
    const r = opened({ slots: [
      { kind: "assign", label: "Assigner", mode: "blocking", fill: { users: ["q-1"] } },
      { kind: "quality", label: "Quality", mode: "blocking", fill: { roles: ["Supervisor"] } },
    ] });
    const plan = slotSignPlan(r, withRoster(r), "q-1", true);
    expect(plan.fillable.map((f) => f.slot.kind)).toEqual(["assign", "quality"]);
    const signed = applySignPlan(r, plan, { uid: "q-1", name: "Q" }, "sig-q", NOW);
    expect(signed.slots.map((s) => [s.kind, s.satisfiedBy, s.signatureId])).toEqual([["assign", "q-1", "sig-q"], ["quality", "q-1", "sig-q"]]);
    expect(rosterCompletion(signed).complete).toBe(true);
  });
  it("DEC-37 / DEC-12: independence per slot — the drafter is blocked from a slot independent of the drafter (3+), with the reason named; below 3 the loop is legal", () => {
    const r = opened({ slots: [{ kind: "check", label: "Engineering check", mode: "blocking", fill: { roles: ["Drafter", "Engineer"] }, independent_of: ["drafter"] }] });
    const t = withRoster(r);
    const blocked = slotSignPlan(r, t, "d-1", true);
    expect(blocked.fillable).toEqual([]);
    expect(blocked.blocked[0].reason).toMatch(/"Engineering check" must be independent of the drafter/);
    expect(slotSignPlan(r, t, "d-1", false).fillable.map((f) => f.slot.kind)).toEqual(["check"]);
    // slot-to-slot independence: one person may not sign both
    const two = opened({ slots: [
      { kind: "a", label: "A", mode: "blocking", fill: { users: ["q-1"] } },
      { kind: "b", label: "B", mode: "blocking", fill: { users: ["q-1"] }, independent_of: ["a"] },
    ] });
    const p = slotSignPlan(two, withRoster(two), "q-1", true);
    expect(p.fillable.map((f) => f.slot.kind)).toEqual(["a"]);
    expect(p.blocked[0].reason).toMatch(/"B" must be independent of "A"/);
  });
  it("an alternate may sign only after the slot's timeout (no cron: the clock is read at evaluation)", () => {
    const r = opened({ slots: [{ kind: "check", mode: "blocking", fill: { users: ["e-1"] }, alternates: { users: ["e-2"] }, timeoutDays: 3 }] });
    const t = withRoster(r);
    expect(slotSignPlan(r, t, "e-2", true, Date.parse(NOW) + 86_400_000).fillable).toEqual([]);
    expect(slotSignPlan(r, t, "e-2", true, Date.parse(NOW) + 4 * 86_400_000).fillable.map((f) => f.via)).toEqual(["alternate"]);
  });
  it("EVID-12: a sign-off's signature must be this ticket's, the signer's own, bound to the roster's hash, given after it opened, used once", () => {
    const r = opened();
    const good = { id: "s1", org_id: "o1", resource_type: "ticket", resource_id: "t1", signer_user_id: "e-1", content_hash: r.contentHash, intent: "Reviewed", signed_at: "2026-10-21T12:05:00Z" };
    const exp = { orgId: "o1", ticketId: "t1", signerId: "e-1", roster: r };
    expect(signatureRefusal(good, exp)).toBeNull();
    expect(signatureRefusal(null, exp)).toMatch(/does not exist/);
    expect(signatureRefusal({ ...good, resource_id: "t2" }, exp)).toMatch(/something else/);
    expect(signatureRefusal({ ...good, signer_user_id: "e-2" }, exp)).toMatch(/someone else/);
    expect(signatureRefusal({ ...good, content_hash: "x" }, exp)).toMatch(/not the files under review/);
    expect(signatureRefusal({ ...good, signed_at: "2026-10-20T00:00:00Z" }, exp)).toMatch(/before this review opened/);
    expect(signatureRefusal({ ...good, intent: "Witnessed" }, exp)).toMatch(/reviews or approves/);
    const used = applySignPlan(r, slotSignPlan(r, withRoster(r), "req-1", true), { uid: "req-1", name: "R" }, "s1", NOW);
    expect(signatureRefusal(good, { ...exp, roster: used })).toMatch(/already been used/);
  });
});

describe("GAP-103 / TIER-5 / FRIC-2 — the engine in roster mode: ONE wait state", () => {
  it("TIER-5 done-when 3: a two-slot (or three-slot) roster is one status — PENDING_REVIEW — with each occupant offered sign_slot at once", () => {
    const t = withRoster(opened());
    const req = WorkflowEngine.getActions(t, "Requester" as never, "req-1", undefined, { activeMemberCount: 5 });
    const eng = WorkflowEngine.getActions(t, "Engineer-2" as never, "e-1", undefined, { userRoles: ["Engineer-2"] as never, activeMemberCount: 5 });
    for (const acts of [req, eng]) {
      const s = acts.find((a) => a.action === "sign_slot");
      expect(s).toMatchObject({ requiresSignature: true });
      expect(s?.optional).toBeUndefined();
      expect(acts.map((a) => a.action)).toContain("request_revision");
      // the serial actions are gone in roster mode
      expect(acts.map((a) => a.action)).not.toContain("request_final_engineer_approval");
      expect(acts.map((a) => a.action)).not.toContain("approve_draft_ifc");
    }
    expect(req.find((a) => a.action === "sign_slot")?.label).toBe("Sign Off — Requester acceptance");
    expect(eng.find((a) => a.action === "sign_slot")?.label).toBe("Sign Off — Engineering check");
  });
  it("FRIC-2: the requester's own slot is a separate question; the technical slot is not waiting on it", () => {
    const r = opened();
    const t = withRoster(r);
    const afterEng = applySignPlan(r, slotSignPlan(r, t, "e-1", true), { uid: "e-1", name: "E" }, "sig", NOW);
    expect(currentRoster(withRoster(afterEng))?.slots.find((s) => s.kind === "check")?.status).toBe("satisfied");
    expect(currentRoster(withRoster(afterEng))?.slots.find((s) => s.kind === "accept")?.status).toBe("open");
  });
  it("a blocked occupant sees the action disabled with the independence reason (TIER-5 / DEC-37: a missing button is not an explanation)", () => {
    const r = opened({ slots: [{ kind: "check", label: "Engineering check", mode: "blocking", fill: { roles: ["Drafter"] }, independent_of: ["drafter"] }] });
    const acts = WorkflowEngine.getActions(withRoster(r), "Drafter" as never, "d-1", undefined, { activeMemberCount: 5 });
    expect(acts.find((a) => a.action === "sign_slot")?.disabledReason).toMatch(/independent of the drafter/);
  });
  it("a requester the routing does not roster may still send it back, but is not waited on (optional); a manager likewise", () => {
    const r = opened({ slots: [{ kind: "check", mode: "blocking", fill: { roles: ["Engineer"] } }] });
    const req = WorkflowEngine.getActions(withRoster(r), "Requester" as never, "req-1");
    expect(req.find((a) => a.action === "request_revision")?.optional).toBe(true);
    expect(req.some((a) => a.action === "sign_slot")).toBe(false);
  });
  it("the roster is current only while PENDING_REVIEW and not closed", () => {
    const r = opened();
    expect(currentRoster(withRoster(r))).not.toBeNull();
    expect(currentRoster(withRoster(r, { status: "PENDING_IFC" }))).toBeNull();
    expect(currentRoster(withRoster({ ...r, closedAt: NOW }))).toBeNull();
    expect(currentRoster(mk())).toBeNull();
  });
});

const input = (over: Partial<TransitionInput> = {}): TransitionInput => ({
  actionType: "sign_slot", actionLabel: "Sign Off", actor: { uid: "e-1", email: "e@x.io", role: "Engineer-2" }, now: NOW, ...over,
});

describe("GAP-103 — computeTransition: sign, complete, open, close", () => {
  it("a sign-off that leaves a slot open writes the roster and a history line; the status stays (no new status)", () => {
    const r = opened();
    const signed = applySignPlan(r, slotSignPlan(r, withRoster(r), "e-1", true), { uid: "e-1", name: "E" }, "sig", NOW);
    const out = computeTransition(withRoster(r), input({ rosterSign: { roster: signed, complete: false, labels: ["Engineering check"] } }));
    expect(out.newStatus).toBe("PENDING_REVIEW");
    expect((out.updates.metadata as { review_roster: TicketReviewRoster }).review_roster.slots[1].status).toBe("satisfied");
    expect((out.updates.history as Array<{ action: string }>).at(-1)?.action).toBe("Signed off — Engineering check (Rev 1A)");
    expect("deliverable_rev" in out.updates).toBe(false);
  });
  it("TIER-5 done-when 2: the last sign-off issues the ticket automatically — PENDING_IFC with the issued label, the roster closed", () => {
    const r = opened();
    const full = { ...r, slots: r.slots.map((s) => (s.status === "open" ? { ...s, status: "satisfied" as const, satisfiedBy: "x", signatureId: "s" } : s)) };
    const out = computeTransition(withRoster(r), input({ rosterSign: { roster: full, complete: true, labels: ["Requester acceptance"] } }));
    expect(out.newStatus).toBe("PENDING_IFC");
    expect(out.updates.deliverable_rev).toBe("1");
    expect((out.updates.metadata as { review_roster: TicketReviewRoster }).review_roster.closedReason).toBe("complete");
    expect((out.updates.history as Array<{ action: string }>).at(-1)?.action).toMatch(/every sign-off is in; issued Rev 1$/);
  });
  it("submit_draft carrying an opened roster writes it, adds the 'Review roster opened' line, and tells every slot's people", () => {
    const r = opened();
    const t = mk({ status: "DRAFTING", deliverableRev: null, draftIteration: 0, attachments: [{ id: "a-d", type: "Draft", status: "staged", name: "iso.pdf", url: "u" } as TicketAttachment] });
    const out = computeTransition(t, input({ actionType: "submit_draft", actionLabel: "Submit", actor: { uid: "d-1", email: "d@x", role: "Drafter" }, rosterOpen: r }));
    expect(out.newStatus).toBe("PENDING_REVIEW");
    expect((out.updates.metadata as { review_roster: TicketReviewRoster }).review_roster.id).toBe("r-1");
    expect((out.updates.history as Array<{ action: string; details?: string }>).at(-1)).toMatchObject({ action: "Review roster opened", details: "Sign-offs needed (any order): Requester acceptance, Engineering check · Told: Process safety (told)" });
    expect(out.updates.unread_by).toEqual(expect.arrayContaining(["req-1", "e-1", "e-2", "q-1"]));
    expect(out.updates.unread_by).not.toContain("d-1");
  });
  it("leaving review any other way closes the roster and voids its open slots", () => {
    const r = opened();
    const out = computeTransition(withRoster(r), input({ actionType: "request_revision", actionLabel: "Request Revision", comment: "fix", actor: { uid: "e-1", email: "e@x", role: "Engineer-2" } }));
    expect(out.newStatus).toBe("REVISION_REQ");
    const closed = (out.updates.metadata as { review_roster: TicketReviewRoster }).review_roster;
    expect(closed.closedReason).toBe("request_revision");
    expect(closed.slots.map((s) => s.status)).toEqual(["void", "void", "told"]);
  });
  it("REGRESSION: with no roster and no issue-ready mark, no transition writes metadata it did not write before", () => {
    for (const actionType of ["submit_draft", "approve_draft_ifc", "engineer_approve_final", "request_revision", "approve_minor_correction"]) {
      const status = actionType === "submit_draft" ? "DRAFTING" : actionType === "engineer_approve_final" ? "PENDING_FINAL_APPROVAL" : "PENDING_REVIEW";
      const out = computeTransition(mk({ status: status as Ticket["status"] }), input({ actionType, actionLabel: "x", comment: "c" }));
      expect("metadata" in out.updates, actionType).toBe(false);
    }
  });
});

describe("FRIC-5 — issue-as-is: opt-in by the drafter, default off = today's PENDING_IFC hop", () => {
  const draft = { id: "a-d", type: "Draft", status: "submitted", rev: "1A", name: "iso_1A.pdf", url: "orgs/o1/tickets/REQ-1/iso_1A.pdf" } as TicketAttachment;
  it("DEFAULT OFF: an approval returns the request to the drafter at PENDING_IFC, exactly as today", () => {
    const out = computeTransition(mk({ attachments: [draft] }), input({ actionType: "approve_draft_ifc", actionLabel: "Approve (Issue for Construction)", actor: { uid: "e-1", email: "e@x", role: "Engineer-2" } }));
    expect(out.newStatus).toBe("PENDING_IFC");
    expect((out.updates.attachments as TicketAttachment[]).length).toBe(1);
  });
  it("the drafter marks the draft under review issue-ready (bound to its label); an approval then issues the draft as the Final — FINAL_DRAFT, no second upload", () => {
    const marked = computeTransition(mk({ attachments: [draft] }), input({ actionType: "mark_issue_ready", actionLabel: "Issue As-Is When Approved", actor: { uid: "d-1", email: "d@x", role: "Drafter" } }));
    expect(marked.updates.metadata).toEqual({ issue_ready: { rev: "1A", by: "d-1", at: NOW } });
    const t = mk({ attachments: [draft], metadata: marked.updates.metadata as Record<string, unknown> });
    expect(issueReadyFor(t)).toBe(true);
    const out = computeTransition(t, input({ actionType: "approve_draft_ifc", actionLabel: "Approve (Issue for Construction)", actor: { uid: "e-1", email: "e@x", role: "Engineer-2" } }));
    expect(out.newStatus).toBe("FINAL_DRAFT");
    const finals = (out.updates.attachments as TicketAttachment[]).filter((a) => a.type === "Final");
    expect(finals).toHaveLength(1);
    expect(finals[0]).toMatchObject({ url: draft.url, rev: "1", issuedFromDraftId: "a-d", status: "submitted" });
    expect(finals[0].id).not.toBe("a-d");
    expect(out.updates.metadata).toEqual({});
    expect((out.updates.history as Array<{ action: string }>).at(-1)?.action).toMatch(/issued as-is/);
  });
  it("a minor correction never issues as-is (the correction must be folded in): PENDING_IFC", () => {
    const t = mk({ attachments: [draft], metadata: { issue_ready: { rev: "1A" } } });
    expect(computeTransition(t, input({ actionType: "approve_minor_correction", actionLabel: "x", comment: "typo" })).newStatus).toBe("PENDING_IFC");
  });
  it("a new submission clears an earlier mark; a mark for another revision does not apply; with no labelled draft the approval falls back to PENDING_IFC", () => {
    const t = mk({ status: "REVISION_REQ", attachments: [{ ...draft, status: "staged", rev: undefined }], metadata: { issue_ready: { rev: "1A" }, keep: 1 } });
    const sub = computeTransition(t, input({ actionType: "submit_draft", actionLabel: "Submit", actor: { uid: "d-1", email: "d@x", role: "Drafter" } }));
    expect(sub.updates.metadata).toEqual({ keep: 1 });
    expect(issueReadyFor(mk({ deliverableRev: "1B", metadata: { issue_ready: { rev: "1A" } } }))).toBe(false);
    const legacy = mk({ attachments: [{ ...draft, rev: undefined }], metadata: { issue_ready: { rev: "1A" } } });
    expect(computeTransition(legacy, input({ actionType: "approve_draft_ifc", actionLabel: "x" })).newStatus).toBe("PENDING_IFC");
    expect(issueAsIsFinals(legacy, "1", NOW)).toBeNull();
  });
  it("submit_draft can carry the opt-in (the API's at-submit path)", () => {
    const t = mk({ status: "DRAFTING", deliverableRev: null, draftIteration: 0, attachments: [{ ...draft, status: "staged", rev: undefined }] });
    const sub = computeTransition(t, input({ actionType: "submit_draft", actionLabel: "Submit", issueReady: true, actor: { uid: "d-1", email: "d@x", role: "Drafter" } }));
    expect(sub.updates.metadata).toEqual({ issue_ready: { rev: "1A", by: "d-1", at: NOW } });
  });
  it("the engine offers the drafter the toggle while the draft is under review (optional), and tells the approver plainly", () => {
    const drafterActs = WorkflowEngine.getActions(mk(), "Drafter" as never, "d-1");
    expect(drafterActs.find((a) => a.action === "mark_issue_ready")).toMatchObject({ optional: true });
    const marked = mk({ metadata: { issue_ready: { rev: "1A" } } });
    expect(WorkflowEngine.getActions(marked, "Drafter" as never, "d-1").find((a) => a.action === "clear_issue_ready")).toBeTruthy();
    const eng = WorkflowEngine.getActions(marked, "Engineer-2" as never, "e-1", undefined, { requesterRoles: ["Requester"] });
    expect(eng.find((a) => a.action === "approve_draft_ifc")?.description).toMatch(/issue-ready/);
    // nobody else gets the toggle
    expect(WorkflowEngine.getActions(mk(), "Requester" as never, "req-1").some((a) => a.action === "mark_issue_ready")).toBe(false);
  });
});

describe("ROUTE-8 remainder — the engineer pick: one rule for the route and the picker", () => {
  const members = [member("e-1", "Engineer-2"), member("x-1", "Admin", ["Admin", "Engineer-1"]), member("d-1", "Drafter"), member("v-1", "Viewer")];
  it("the picker offers exactly who the route accepts — an Engineer role in the collection (headline or additive)", () => {
    expect(engineerCandidates(members, null, "ticket.final_approve", null).map((c) => c.uid).sort()).toEqual(["e-1", "x-1"]);
    expect(engineerPickRefusal(["Drafter"], null, "ticket.final_approve", "d-1", null)).toMatch(/does not hold an Engineer role/);
  });
  it("a type-scoped reviewing rule narrows both the same way", () => {
    const policy = { caps: { "ticket.final_approve": [{ when: { requestType: "ISO" }, tokens: ["Engineer-2"] }, { tokens: ["Engineer"] }] } } as never;
    const res = { requestType: "ISO", unit: null };
    expect(engineerCandidates(members, policy, "ticket.final_approve", res).map((c) => c.uid)).toEqual(["e-1"]);
    expect(engineerPickRefusal(["Admin", "Engineer-1"], policy, "ticket.final_approve", "x-1", res, "ISO")).toMatch(/outside the group this workspace allows to review ISO requests/);
  });
  it("source pin: EngineerPickerModal reads members keyset-paged and filters through the shared rule (no filter of its own)", () => {
    const src = readFileSync(join(process.cwd(), "components", "requests", "EngineerPickerModal.tsx"), "utf8");
    expect(src).toContain("const read = await loadPickerMembers(orgId);");
    expect(src).toContain("engineerCandidates(read.rows, policy, engineerPickCap(");
    expect(src).not.toContain('r.includes("Engineer")');
    expect(src).not.toContain('.from("org_members")');
  });
});

describe("the ledger writer — checked, retried once, never swallowed", () => {
  const client = (errs: Array<{ code?: string; message: string } | null>) => {
    const calls: Array<{ t: string; op: string; arg: unknown }> = [];
    const next = () => Promise.resolve({ error: errs.length ? errs.shift()! : null });
    return {
      calls,
      from: (t: string) => ({
        insert: (arg: unknown) => { calls.push({ t, op: "insert", arg }); return next(); },
        update: (arg: unknown) => ({ eq: () => ({ eq: () => { calls.push({ t, op: "update", arg }); return next(); } }) }),
      }),
    };
  };
  it("an opened roster writes its slots and one event each (told for notify-only)", async () => {
    const c = client([]);
    const r = opened();
    expect(await writeRosterLedger(c, { orgId: "o1", ticketId: "t1", roster: r, event: "opened", slots: r.slots, actor: { uid: "d-1", name: "D" } })).toBeNull();
    expect(c.calls.map((x) => `${x.t}:${x.op}`)).toEqual(["ticket_review_slots:insert", "ticket_review_slot_events:insert"]);
    expect((c.calls[1].arg as Array<{ event: string }>).map((e) => e.event)).toEqual(["opened", "opened", "told"]);
  });
  it("a failure is retried once with the same rows; a second failure is returned", async () => {
    const r = opened();
    const once = client([{ message: "blip" }]);
    expect(await writeRosterLedger(once, { orgId: "o1", ticketId: "t1", roster: r, event: "opened", slots: r.slots, actor: { uid: "d", name: null } })).toBeNull();
    const twice = client([{ message: "down" }, { message: "down" }]);
    expect(await writeRosterLedger(twice, { orgId: "o1", ticketId: "t1", roster: r, event: "opened", slots: r.slots, actor: { uid: "d", name: null } })).toBe("down");
    expect(isMissingRosterLedger({ code: "PGRST205", message: "x" })).toBe(true);
    expect(isMissingRosterLedger({ code: "42501", message: "x" })).toBe(false);
  });
});

// ── The migrations (DEC-30 shape) ────────────────────────────────────────────
const MIG = join(process.cwd(), "supabase", "migrations");
const sql = (f: string) => readFileSync(join(MIG, f), "utf8");
const code = (f: string) => sql(f).replace(/--[^\n]*/g, "");

describe("20261241 / 20261242 — DEC-30 one-paste shape, DRLS-16, nothing re-created", () => {
  for (const f of ["20261241_df_roundG_routing_control.sql", "20261242_df_roundG_ticket_roster.sql"]) {
    it(`${f}: TEMP counts-only inventory BEFORE BEGIN, one transaction, one final SELECT (check, ok, n)`, () => {
      const c = code(f);
      const temp = c.indexOf("CREATE TEMP TABLE");
      const begin = c.indexOf("\nBEGIN;");
      const commit = c.lastIndexOf("\nCOMMIT;");
      expect(temp).toBeGreaterThan(-1);
      expect(temp).toBeLessThan(begin);
      expect(c.match(/\nBEGIN;/g)).toHaveLength(1);
      expect(c.match(/\nCOMMIT;/g)).toHaveLength(1);
      const tail = c.slice(commit);
      expect(tail).toMatch(/SELECT '[^']+' AS check,/);
      expect(tail).toContain("AS ok,");
      expect(tail).toContain("NULL::text AS n");
      // COMMIT; and the one final SELECT (string literals stripped first)
      expect((tail.replace(/'(?:[^']|'')*'/g, "''").match(/;/g) ?? []).length).toBe(2);
      // counts only, never customer rows
      const inv = c.slice(temp, begin);
      expect(inv).toMatch(/COUNT\(\*\)/);
      expect(inv).not.toMatch(/SELECT\s+\*/);
    });
    it(`${f}: every SECURITY DEFINER function pins search_path and revokes EXECUTE from every client role`, () => {
      const c = code(f);
      const fns = [...c.matchAll(/CREATE OR REPLACE FUNCTION (\w+)\(\)[\s\S]*?SECURITY DEFINER SET search_path = public AS \$\$/g)].map((m) => m[1]);
      expect(fns.length).toBeGreaterThan(0);
      expect((c.replace(/'(?:[^']|'')*'/g, "''").match(/SECURITY DEFINER/g) ?? []).length).toBe(fns.length);
      for (const fn of fns) expect(c).toContain(`REVOKE ALL ON FUNCTION ${fn}() FROM PUBLIC, anon, authenticated, service_role;`);
    });
  }
  it("no function, policy or trigger defined elsewhere in the sequence is re-created here (each is NEW — no lineDiff owed)", () => {
    const mine = new Set(["20261241_df_roundG_routing_control.sql", "20261242_df_roundG_ticket_roster.sql"]);
    const others = readdirSync(MIG).filter((n) => /^\d{8}.*\.sql$/.test(n) && !mine.has(n)).map((n) => code(n)).join("\n")
      + readFileSync(join(process.cwd(), "supabase", "schema.sql"), "utf8");
    for (const f of mine) {
      const c = code(f);
      for (const m of c.matchAll(/CREATE OR REPLACE FUNCTION (\w+)/g)) expect(others, m[1]).not.toMatch(new RegExp(`FUNCTION\\s+(public\\.)?${m[1]}\\b`));
      for (const m of c.matchAll(/CREATE POLICY (\w+)/g)) expect(others, m[1]).not.toMatch(new RegExp(`POLICY\\s+"?${m[1]}\\b`));
      for (const m of c.matchAll(/CREATE TRIGGER (\w+)/g)) expect(others, m[1]).not.toMatch(new RegExp(`TRIGGER\\s+${m[1]}\\b`));
    }
  });
  it("20261241 mirrors 20261012's doc_class lines for routing_control (ADD COLUMN IF NOT EXISTS + COMMENT on the three tables) and adds no policy", () => {
    const base = sql("20261012_doc_class_and_checkin_outcomes.sql");
    const c = code("20261241_df_roundG_routing_control.sql");
    for (const t of ["libraries", "collections", "documents"]) {
      expect(base).toMatch(new RegExp(`ALTER TABLE ${t}\\s+ADD COLUMN IF NOT EXISTS doc_class TEXT;`));
      expect(c).toMatch(new RegExp(`ALTER TABLE ${t}\\s+ADD COLUMN IF NOT EXISTS routing_control JSONB;`));
      expect(c).toMatch(new RegExp(`COMMENT ON COLUMN ${t}\\.routing_control\\s+IS `));
    }
    expect(c).not.toMatch(/CREATE POLICY/);
  });
  it("DEC-35: no facility vocabulary in what DF-P5 added (QAQC / B31 / NDE / radiograph)", () => {
    for (const f of ["lib/routingControl.ts", "lib/ticketRoster.ts", "components/requests/TicketRosterPanel.tsx", "components/documents/RoutingControlSection.tsx"]) {
      expect(readFileSync(join(process.cwd(), f), "utf8")).not.toMatch(/QAQC|B31|NDE|radiograph/);
    }
  });
});
