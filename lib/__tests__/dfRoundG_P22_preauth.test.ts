// drafting-flow Round G, DF-P22 — GAP-109 mechanism 2: STANDING
// PRE-AUTHORIZATION (DEC-90 ruling (2) for DF-P22). A named person's own
// revocable, scoped, expiring, e-signed pre-consent; it satisfies only a slot
// that person would otherwise sign, that the workspace opted in, never an
// engineering slot, an assurance slot or a slot on an engineered request, and
// never the last open sign-off. Default off — an unconfigured workspace's
// review is untouched (no read is even made).

import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  preauthorizationStatement, preauthDraftRefusal, preauthStanding, preauthCovers, preauthSignatureRefusal, preauthSignatureStands,
  preauthEligibleSlots, planPreauthorizations, applyPreauthorizations, preauthHistoryEntry, preauthLatestDay, preauthExpiryFromDay,
  isMissingPreauthTable, PREAUTH_SIGNATURE_INTENT, PREAUTH_SIGNATURE_RESOURCE, PREAUTH_ACTOR, PREAUTH_AUDIT, PREAUTH_MAX_DAYS, type Preauthorization,
} from "@/lib/ticketPreauthorization";
import { applyStandingPreauthorizations } from "@/lib/ticketPreauthorizationApply";
import { parseRoutingControl, validateRoutingDraft, preauthorizationOptInAllowed } from "@/lib/routingControl";
import { openRoster, rosterCompletion } from "@/lib/ticketRoster";
import { draftToControl, controlToDraft, preauthOptInFor } from "@/components/documents/RoutingControlSection";
import type { TicketReviewRoster, TicketReviewSlot } from "@/types/schema";

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-22T12:00:00Z");
const LIB = "aaaaaaaa-0000-4000-8000-000000000001";
const P1 = "bbbbbbbb-0000-4000-8000-000000000001";
const P2 = "bbbbbbbb-0000-4000-8000-000000000002";
const SIG1 = "cccccccc-0000-4000-8000-000000000001";
const SIG2 = "cccccccc-0000-4000-8000-000000000002";

const slot = (over: Partial<TicketReviewSlot> & { kind: string }): TicketReviewSlot => ({
  id: `r:${over.kind}`, label: over.kind, mode: "blocking", primaries: [], alternates: [], overriders: [], independentOf: [],
  timeoutDays: null, fallback: false, status: "open", ...over,
});
const roster = (slots: TicketReviewSlot[]): TicketReviewRoster => ({
  v: 1, id: "r1", openedAt: "2026-10-22T11:00:00Z", openedBy: "d-1", level: "library", cycle: "1A", contentHash: "h", files: [], slots,
});
const qa = (over: Partial<TicketReviewSlot> = {}) => slot({ kind: "qa", label: "QA", primaries: ["q-1"], acceptsPreauthorization: true, ...over });
const accept = (over: Partial<TicketReviewSlot> = {}) => slot({ kind: "accept", label: "Acceptance", primaries: ["req"], ...over });
const pa = (over: Partial<Preauthorization> = {}): Preauthorization => ({
  id: P1, orgId: "o1", grantorId: "q-1", grantorName: "Quinn", libraryId: null, requestType: "ISO", workClass: null,
  statement: "s", signatureId: SIG1, createdAt: "2026-10-01T00:00:00Z", expiresAt: "2027-01-01T00:00:00Z",
  revokedAt: null, revokedBy: null, revokeReason: null, ...over,
});
const tk = { orgId: "o1", requesterId: "req", assignedDrafterId: "d-1", libraryId: LIB, requestType: "ISO", workClass: "Like-in-kind" };
const plan = (r: TicketReviewRoster, over: Partial<Parameters<typeof planPreauthorizations>[0]> = {}) => planPreauthorizations({
  roster: r, ticket: tk, engineered: false, preauths: [pa()], signed: new Set([P1, P2]), activeMembers: new Set(["q-1", "q-2", "req", "d-1"]), sodActive: true, now: NOW, ...over,
});

describe("the record — what a person signs and what the route checks", () => {
  it("the statement names the scope, the expiry day, where it acts and where it never does; panel and route compose the same words", () => {
    const s = preauthorizationStatement({ libraryId: LIB, libraryName: "Piping", requestType: "ISO", workClass: null, expiresAt: "2027-01-01T23:59:59.000Z" });
    expect(s).toBe("I give my standing pre-authorization, until 2027-01-01 (UTC), for my sign-off on requests in the library \"Piping\", of the request type \"ISO\" — only on a review slot my workspace has set to accept a standing pre-authorization and that I would otherwise sign, and never on engineered work, an engineering sign-off or an assurance check. Each request that uses it names it, and I may revoke it at any time.");
    expect(PREAUTH_SIGNATURE_INTENT).toBe("Acknowledged");
    expect(PREAUTH_SIGNATURE_RESOURCE).toBe("ticket_preauthorization");
  });
  it("a draft must be scoped and must expire within 365 days (and at least an hour away)", () => {
    expect(preauthDraftRefusal({ expiresAt: "2027-01-01T00:00:00Z" }, NOW)).toMatch(/at least one/);
    expect(preauthDraftRefusal({ requestType: "ISO" }, NOW)).toMatch(/always ends/);
    expect(preauthDraftRefusal({ requestType: "ISO", expiresAt: new Date(NOW + 30 * 60_000).toISOString() }, NOW)).toMatch(/at least an hour/);
    expect(preauthDraftRefusal({ requestType: "ISO", expiresAt: new Date(NOW + 366 * DAY).toISOString() }, NOW)).toMatch(/at most 365 days/);
    expect(preauthDraftRefusal({ libraryId: "not-a-uuid", expiresAt: "2027-01-01T00:00:00Z" }, NOW)).toMatch(/not one this workspace has/);
    expect(preauthDraftRefusal({ workClass: "Like-in-kind", expiresAt: preauthExpiryFromDay(preauthLatestDay(NOW)) }, NOW)).toBeNull();
    expect(PREAUTH_MAX_DAYS).toBe(365);
  });
  it("the signature must be this record's, by its grantor, an acknowledgement of exactly this statement, fresh", () => {
    const ctx = { orgId: "o1", id: P1, grantorId: "q-1", statement: "S", now: NOW };
    const good = { id: SIG1, org_id: "o1", resource_type: PREAUTH_SIGNATURE_RESOURCE, resource_id: P1, signer_user_id: "q-1", intent: "Acknowledged", statement: "S", signed_at: new Date(NOW - 60_000).toISOString() };
    expect(preauthSignatureRefusal(good, ctx)).toBeNull();
    expect(preauthSignatureRefusal(null, ctx)).toMatch(/not found/);
    expect(preauthSignatureRefusal({ ...good, org_id: "o2" }, ctx)).toMatch(/another workspace/);
    expect(preauthSignatureRefusal({ ...good, resource_type: "ticket" }, ctx)).toMatch(/something else/);
    expect(preauthSignatureRefusal({ ...good, signer_user_id: "x" }, ctx)).toMatch(/Only the person/);
    expect(preauthSignatureRefusal({ ...good, intent: "Approved" }, ctx)).toMatch(/acknowledgement/);
    expect(preauthSignatureRefusal({ ...good, statement: "S2" }, ctx)).toMatch(/changed after it was signed/);
    expect(preauthSignatureRefusal({ ...good, signed_at: new Date(NOW - 20 * 60_000).toISOString() }, ctx)).toMatch(/expired/);
    expect(preauthSignatureStands(good, { id: P1, orgId: "o1", grantorId: "q-1", signatureId: SIG1, statement: "S" })).toBe(true);
    expect(preauthSignatureStands({ ...good, signer_user_id: "x" }, { id: P1, orgId: "o1", grantorId: "q-1", signatureId: SIG1, statement: "S" })).toBe(false);
  });
  it("standing: not revoked, not expired, never longer than 365 days; covers: every named dimension equal, at least one named", () => {
    expect(preauthStanding(pa(), NOW)).toBe(true);
    expect(preauthStanding(pa({ revokedAt: "2026-10-20T00:00:00Z" }), NOW)).toBe(false);
    expect(preauthStanding(pa({ expiresAt: "2026-10-22T11:00:00Z" }), NOW)).toBe(false);
    expect(preauthStanding(pa({ createdAt: "2026-01-01T00:00:00Z", expiresAt: "2027-06-01T00:00:00Z" }), NOW)).toBe(false);
    expect(preauthCovers(pa(), tk)).toBe(true);
    expect(preauthCovers(pa({ libraryId: LIB }), tk)).toBe(true);
    expect(preauthCovers(pa({ libraryId: "other" }), tk)).toBe(false);
    expect(preauthCovers(pa({ requestType: "P&ID" }), tk)).toBe(false);
    expect(preauthCovers(pa({ requestType: null, workClass: "Like-in-kind" }), tk)).toBe(true);
    expect(preauthCovers(pa({ requestType: null, workClass: "New design" }), tk)).toBe(false);
    expect(preauthCovers(pa({ requestType: null }), tk)).toBe(false);
    expect(preauthCovers(pa({ orgId: "o2" }), tk)).toBe(false);
  });
});

describe("where it acts — only an opted-in, blocking, non-engineering, non-assurance slot the person would sign; never the last sign-off", () => {
  it("applies to the opted-in slot while another sign-off stays open; the review is not complete", () => {
    const r = roster([accept(), qa()]);
    const apps = plan(r);
    expect(apps.map((a) => [a.slot.kind, a.preauth.id])).toEqual([["qa", P1]]);
    const next = applyPreauthorizations(r, apps, new Date(NOW).toISOString(), () => "Quinn");
    expect(next.slots.find((s) => s.kind === "qa")).toMatchObject({ status: "satisfied", satisfiedBy: "q-1", satisfiedByName: "Quinn (standing pre-authorization)", signatureId: SIG1, via: "preauthorization", preauthorizationId: P1 });
    expect(rosterCompletion(next).complete).toBe(false);
  });
  it("NEVER the last open sign-off: a roster whose only open blocking slot is opted in is left waiting", () => {
    expect(plan(roster([accept({ status: "satisfied", satisfiedBy: "req", signatureId: "s" }), qa()]))).toEqual([]);
    expect(plan(roster([qa()]))).toEqual([]);
    // two opted-in slots, nothing else: one applied, the other kept for a person
    const two = plan(roster([qa(), qa({ kind: "qa2", label: "QA 2", primaries: ["q-2"] })]), { preauths: [pa(), pa({ id: P2, grantorId: "q-2", signatureId: SIG2 })] });
    expect(two.map((a) => a.slot.kind)).toEqual(["qa"]);
  });
  it("never on engineered work, an engineering slot, an assurance slot, a consent window, a notice, or a slot not opted in", () => {
    expect(plan(roster([accept(), qa()]), { engineered: true })).toEqual([]);
    for (const over of [{ engineering: true }, { recordsExamination: true as const }, { mode: "consent_window" as const }, { mode: "notify_only" as const, status: "told" as const }, { acceptsPreauthorization: undefined }]) {
      expect(plan(roster([accept(), qa(over as Partial<TicketReviewSlot>)])), JSON.stringify(over)).toEqual([]);
    }
    expect(preauthEligibleSlots(roster([accept(), qa()])).map((s) => s.kind)).toEqual(["qa"]);
  });
  it("only a person who would otherwise sign it: a primary (or an alternate once its window opened), never an overrider, never the drafter, never someone outside the slot", () => {
    expect(plan(roster([accept(), qa({ primaries: ["x"], overriders: ["q-1"] })]))).toEqual([]);
    expect(plan(roster([accept(), qa({ primaries: ["x"], alternates: ["q-1"], timeoutDays: 30 })]))).toEqual([]);
    expect(plan(roster([accept(), qa({ primaries: ["x"], alternates: ["q-1"], timeoutDays: 1 })]), { now: NOW + 2 * DAY }).map((a) => a.slot.kind)).toEqual(["qa"]);
    expect(plan(roster([accept(), qa({ primaries: ["d-1"] })]), { preauths: [pa({ grantorId: "d-1" })] })).toEqual([]);
    expect(plan(roster([accept(), qa({ primaries: ["x"] })]))).toEqual([]);
  });
  it("DEC-37: an independence leg the person fails is respected (the requester on a slot independent of the requester; a person who signed a slot it must be independent of)", () => {
    expect(plan(roster([slot({ kind: "other", primaries: ["z"] }), qa({ primaries: ["req"], independentOf: ["requester"] })]), { preauths: [pa({ grantorId: "req" })] })).toEqual([]);
    const signedOther = roster([slot({ kind: "other", primaries: ["q-1"], status: "satisfied", satisfiedBy: "q-1", signatureId: "s" }), accept(), qa({ independentOf: ["other"] })]);
    expect(plan(signedOther)).toEqual([]);
  });
  it("a record that is revoked, expired, unsigned, out of scope, or whose person left is never used", () => {
    const r = roster([accept(), qa()]);
    expect(plan(r, { preauths: [pa({ revokedAt: "2026-10-21T00:00:00Z" })] })).toEqual([]);
    expect(plan(r, { preauths: [pa({ expiresAt: "2026-10-22T00:00:00Z" })] })).toEqual([]);
    expect(plan(r, { signed: new Set() })).toEqual([]);
    expect(plan(r, { preauths: [pa({ requestType: "P&ID" })] })).toEqual([]);
    expect(plan(r, { activeMembers: new Set(["req", "d-1"]) })).toEqual([]);
  });
  it("the history line names each record, its scope and dates, and says it never issues the request", () => {
    const r = roster([accept(), qa()]);
    const h = preauthHistoryEntry(plan(r), new Date(NOW).toISOString(), () => "Quinn");
    expect(h.action).toBe("Standing pre-authorization applied");
    expect(h.user).toBe(PREAUTH_ACTOR);
    expect(h.details).toContain(`"QA" — signed off by Quinn's standing pre-authorization ${P1} (recorded 2026-10-01, expires 2027-01-01; requests of the request type "ISO")`);
    expect(h.details).toContain("never issues a request");
    expect(h.preauthorizations).toEqual([{ id: P1, slot: "qa", grantor: "q-1" }]);
  });
});

describe("the routing opt-in — explicit, never inferred, dropped where it cannot ride", () => {
  it("kept only on a blocking slot not filled by the requester alone, not by an engineering capability, not an assurance check", () => {
    const parsed = parseRoutingControl({ slots: [
      { kind: "qa", mode: "blocking", fill: { roles: ["QA"] }, accepts_preauthorization: true },
      { kind: "acc", mode: "blocking", fill: { identity: "requester" }, accepts_preauthorization: true },
      { kind: "eng", mode: "blocking", fill: { capability: "ticket.final_approve" }, accepts_preauthorization: true },
      { kind: "asr", mode: "blocking", fill: { roles: ["QA"] }, records_examination: true, accepts_preauthorization: true },
      { kind: "ops", mode: "consent_window", fill: { roles: ["Ops"] }, accepts_preauthorization: true },
      { kind: "note", mode: "notify_only", fill: { roles: ["Ops"] }, accepts_preauthorization: true },
    ] });
    expect(parsed && parsed.ok).toBe(true);
    const slots = parsed && parsed.ok ? parsed.control.slots : [];
    expect(slots.filter((s) => s.accepts_preauthorization).map((s) => s.kind)).toEqual(["qa"]);
    expect(preauthorizationOptInAllowed({ mode: "blocking", fill: { roles: ["QA"] } })).toBe(true);
  });
  it("REGRESSION: a table without the opt-in parses byte-for-byte as before (no key appears)", () => {
    const t = { slots: [{ kind: "qa", mode: "blocking", fill: { roles: ["QA"] } }] };
    const p = parseRoutingControl(t);
    expect(p && p.ok && p.control).toEqual({ slots: [{ kind: "qa", mode: "blocking", fill: { roles: ["QA"] } }] });
  });
  it("the editor refuses a save that writes a misplaced opt-in, with the reason", () => {
    expect(validateRoutingDraft({ slots: [{ kind: "eng", mode: "blocking", fill: { capability: "ticket.final_approve" }, accepts_preauthorization: true }] } as never)).toMatch(/never stands in for the engineering sign-off/);
    expect(validateRoutingDraft({ slots: [{ kind: "qa", mode: "blocking", fill: { roles: ["QA"] }, records_examination: true, accepts_preauthorization: true }] } as never)).toMatch(/assurance check/);
    expect(validateRoutingDraft({ slots: [{ kind: "acc", mode: "blocking", fill: { identity: "requester" }, accepts_preauthorization: true }, { kind: "qa", mode: "blocking", fill: { roles: ["QA"] } }] } as never)).toMatch(/requester's own acceptance/);
    expect(validateRoutingDraft({ slots: [{ kind: "qa", mode: "blocking", fill: { roles: ["QA"] }, accepts_preauthorization: true }] } as never)).toBeNull();
  });
  it("the editor carries it through a save (round trip), offers it only where it can ride, and drops it when the slot becomes an assurance check", () => {
    const stored = { slots: [{ kind: "qa", label: "QA", mode: "blocking" as const, fill: { roles: ["QA"] }, independent_of: ["drafter"], accepts_preauthorization: true as const }] };
    const draft = controlToDraft(stored);
    expect(draft[0].acceptsPreauthorization).toBe(true);
    expect(preauthOptInFor(draft[0])).toBe("offer");
    expect(draftToControl(draft)).toEqual(stored);
    expect(draftToControl([{ ...draft[0], recordsExamination: true }]).slots[0]).not.toHaveProperty("accepts_preauthorization");
    expect(preauthOptInFor({ ...draft[0], mode: "consent_window" })).toBe("none");
    // REGRESSION: a slot that never had it gains nothing
    const plain = controlToDraft({ slots: [{ kind: "qa", mode: "blocking", fill: { roles: ["QA"] } }] });
    expect(draftToControl(plain).slots[0]).not.toHaveProperty("accepts_preauthorization");
  });
  it("openRoster freezes the opt-in on the roster slot; a slot without it is stored exactly as before", () => {
    const opened = openRoster({
      id: "r", control: { slots: [{ kind: "accept", mode: "blocking", fill: { identity: "requester" } }, { kind: "qa", mode: "blocking", fill: { users: ["q-1"] }, accepts_preauthorization: true }] },
      level: "library", cycle: "1A", files: [], ctx: { members: [{ uid: "q-1", role: "Viewer" }, { uid: "req", role: "Viewer" }], policy: null, resource: null, requesterId: "req" },
      openedBy: "d", now: "2026-10-22T11:00:00Z",
    });
    expect(opened.ok && opened.roster.slots.find((s) => s.kind === "qa")).toMatchObject({ acceptsPreauthorization: true });
    expect(opened.ok && "acceptsPreauthorization" in opened.roster.slots.find((s) => s.kind === "accept")!).toBe(false);
  });
});

// ── the server half (lib/ticketPreauthorizationApply.ts) ────────────────────
type Row = Record<string, unknown>;
const db = { tables: {} as Record<string, Row[]>, calls: [] as Array<{ table: string; method: string; args?: unknown }>, errors: {} as Record<string, { code?: string; message: string }> };
function builder(table: string) {
  const filters: Array<(r: Row) => boolean> = [];
  let op: "select" | "insert" | "update" = "select";
  let payload: unknown = null;
  db.calls.push({ table, method: "from" });
  const matched = () => (db.tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
  const b: Record<string, unknown> = {
    select: () => b,
    eq: (k: string, v: unknown) => { filters.push((r) => r[k] === v); return b; },
    is: (k: string, v: unknown) => { filters.push((r) => (r[k] ?? null) === v); return b; },
    in: (k: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[k])); return b; },
    gt: (k: string, v: string) => { filters.push((r) => String(r[k]) > v); return b; },
    insert: (rows: unknown) => { op = "insert"; payload = rows; db.calls.push({ table, method: "insert", args: rows }); return b; },
    update: (p: unknown) => { op = "update"; payload = p; db.calls.push({ table, method: "update", args: p }); return b; },
    maybeSingle: async () => (db.errors[table] ? { data: null, error: db.errors[table] } : { data: matched()[0] ?? null, error: null }),
    then: (resolve: (v: unknown) => void) => {
      const err = db.errors[`${table}:${op}`] ?? (op === "select" ? db.errors[table] : undefined);
      if (err) return resolve({ data: null, error: err });
      if (op === "insert") { const rows = (Array.isArray(payload) ? payload : [payload]) as Row[]; db.tables[table] = [...(db.tables[table] ?? []), ...rows]; return resolve({ data: null, error: null, count: rows.length }); }
      if (op === "update") { const mm = matched(); for (const r of mm) Object.assign(r, payload as Row); return resolve({ data: mm.map((r) => ({ id: r.id })), error: null }); }
      return resolve({ data: matched(), error: null });
    },
  };
  return b;
}
const client = { from: (t: string) => builder(t) };
const members = ["q-1", "q-2", "req", "d-1"].map((uid) => ({ uid, display_name: uid.toUpperCase(), email: `${uid}@x.io` }));
const record = (over: Row = {}): Row => ({ id: P1, org_id: "o1", grantor_id: "q-1", grantor_name: "Quinn", library_id: null, request_type: "ISO", work_class: null, statement: "S", signature_id: SIG1, created_at: "2026-10-01T00:00:00Z", expires_at: "2027-01-01T00:00:00Z", revoked_at: null, revoked_by: null, revoke_reason: null, ...over });
const sig = { id: SIG1, org_id: "o1", resource_type: PREAUTH_SIGNATURE_RESOURCE, resource_id: P1, signer_user_id: "q-1", intent: "Acknowledged", statement: "S" };
const seed = (r: TicketReviewRoster) => {
  db.tables = {
    tickets: [{ id: "t1", org_id: "o1", status: "PENDING_REVIEW", last_modified: "2026-10-22T11:00:00Z", metadata: { review_roster: r }, history: [{ action: "Submitted" }], unread_by: ["req", "q-1"], requester_id: "req", assigned_drafter_id: "d-1", library_id: LIB, request_type: "ISO", work_class: null, archived_at: null }],
    ticket_preauthorizations: [record()], e_signatures: [sig], audit_logs: [],
    ticket_review_slots: [{ id: "l1", roster_id: "r1", slot_kind: "qa" }, { id: "l2", roster_id: "r1", slot_kind: "accept" }], ticket_review_slot_events: [], notifications: [],
  };
  db.calls = []; db.errors = {};
};
const apply = (r: TicketReviewRoster, engineered = false) => applyStandingPreauthorizations(client, { ticketId: "t1", orgId: "o1", roster: r, engineered, members, ticketLabel: "REQ-1 Gasket", now: NOW });

describe("applying it after the submission landed — audit first, then the compare-and-set; default off", () => {
  beforeEach(() => seed(roster([accept(), qa()])));
  it("REGRESSION: no opted-in slot (an unconfigured workspace), or engineered work — no read at all, nothing written", async () => {
    seed(roster([accept(), slot({ kind: "qa", primaries: ["q-1"] })]));
    expect(await apply(roster([accept(), slot({ kind: "qa", primaries: ["q-1"] })]))).toEqual({ applied: [], note: null });
    expect(db.calls).toEqual([]);
    seed(roster([accept(), qa()]));
    expect(await apply(roster([accept(), qa()]), true)).toEqual({ applied: [], note: null });
    expect(db.calls).toEqual([]);
  });
  it("applies: the audit row (system actor, naming the record) BEFORE the ticket write; the roster slot, the history line, unread_by; then the ledger and the person's bell", async () => {
    const r = roster([accept(), qa()]);
    const out = await apply(r);
    expect(out.applied).toEqual([{ slot: "qa", label: "QA", preauthorizationId: P1, grantorId: "q-1" }]);
    const order = db.calls.filter((c) => (c.table === "audit_logs" && c.method === "insert") || (c.table === "tickets" && c.method === "update")).map((c) => c.table);
    expect(order).toEqual(["audit_logs", "tickets"]);
    expect(db.tables.audit_logs[0]).toMatchObject({ action: PREAUTH_AUDIT.applied, user_id: null, user_email: PREAUTH_ACTOR, user_role: "system",
      details: { recordedBeforeApply: true, applied: [{ slot: "qa", preauthorizationId: P1, grantorId: "q-1", signatureId: SIG1 }] } });
    const t = db.tables.tickets[0];
    const rr = (t.metadata as { review_roster: TicketReviewRoster }).review_roster;
    expect(rr.slots.find((s) => s.kind === "qa")).toMatchObject({ status: "satisfied", via: "preauthorization", preauthorizationId: P1, signatureId: SIG1, satisfiedBy: "q-1" });
    expect(rr.slots.find((s) => s.kind === "accept")).toMatchObject({ status: "open" });
    expect(t.status).toBe("PENDING_REVIEW");
    expect((t.history as Row[]).at(-1)).toMatchObject({ action: "Standing pre-authorization applied", user: PREAUTH_ACTOR });
    expect(t.unread_by).toEqual(["req"]);
    expect(t.last_modified).toBe(new Date(NOW).toISOString());
    expect(db.tables.ticket_review_slots.find((x) => x.slot_kind === "qa")).toMatchObject({ status: "satisfied", satisfied_via: "preauthorization", satisfied_by: "q-1", signature_id: SIG1 });
    expect(db.tables.notifications).toHaveLength(1);
    expect(db.tables.notifications[0]).toMatchObject({ user_id: "q-1", kind: "ticket_status" });
  });
  it("the request changed first (the compare-and-set missed): a _NOT_APPLIED row, nothing else — the slot waits for its sign-off", async () => {
    const r = roster([accept(), qa()]);
    db.tables.tickets[0].last_modified = "2026-10-22T11:59:00Z";
    const realFrom = client.from;
    // the re-read sees one last_modified; a person's write lands before the CAS
    let reads = 0;
    const racing = { from: (t: string) => { const b = realFrom(t) as Record<string, unknown>; if (t === "tickets") { const ms = b.maybeSingle as () => Promise<unknown>; b.maybeSingle = async () => { const v = (await ms()) as { data: Row | null; error: unknown }; reads += 1; const snapshot = v.data ? { ...v.data } : null; db.tables.tickets[0].last_modified = "2026-10-22T11:59:30Z"; return { ...v, data: snapshot }; }; } return b; } };
    const out = await applyStandingPreauthorizations(racing, { ticketId: "t1", orgId: "o1", roster: r, engineered: false, members, ticketLabel: "x", now: NOW });
    expect(reads).toBe(1);
    expect(out.applied).toEqual([]);
    expect(out.note).toMatch(/the request changed first/);
    expect(db.tables.audit_logs.map((a) => a.action)).toEqual([PREAUTH_AUDIT.applied, `${PREAUTH_AUDIT.applied}_NOT_APPLIED`]);
    expect(((db.tables.tickets[0].metadata as { review_roster: TicketReviewRoster }).review_roster).slots.find((s) => s.kind === "qa")!.status).toBe("open");
    expect(db.tables.notifications).toEqual([]);
  });
  it("before 20261264 (the table is missing): nothing applied, no note — today's review", async () => {
    db.errors.ticket_preauthorizations = { code: "42P01", message: 'relation "public.ticket_preauthorizations" does not exist' };
    expect(await apply(roster([accept(), qa()]))).toEqual({ applied: [], note: null });
    expect(db.tables.audit_logs).toEqual([]);
    expect(isMissingPreauthTable(db.errors.ticket_preauthorizations)).toBe(true);
  });
  it("a read that fails, a signature that does not stand, or a revoked record — nothing applied", async () => {
    db.errors.e_signatures = { code: "57014", message: "timeout" };
    expect((await apply(roster([accept(), qa()]))).applied).toEqual([]);
    seed(roster([accept(), qa()]));
    db.tables.e_signatures = [{ ...sig, statement: "something else" }];
    expect((await apply(roster([accept(), qa()]))).applied).toEqual([]);
    seed(roster([accept(), qa()]));
    db.tables.ticket_preauthorizations = [record({ revoked_at: "2026-10-21T00:00:00Z", revoked_by: "q-1" })];
    expect((await apply(roster([accept(), qa()]))).applied).toEqual([]);
    expect(db.tables.audit_logs).toEqual([]);
  });
});

describe("the workflow route's hunk (minimal, after the submission landed) — source pins", () => {
  const route = readFileSync(join(process.cwd(), "app/api/tickets/workflow-action/route.ts"), "utf8");
  it("one call, only when the roster has an eligible slot, after the consent window step, with the route's engineered-lane answer", () => {
    expect(route.match(/applyStandingPreauthorizations\(/g)).toHaveLength(1);
    expect(route).toContain("if (rosterOpen && newStatus === \"PENDING_REVIEW\" && preauthEligibleSlots(rosterOpen).length > 0) {");
    expect(route.indexOf("consentWarning = await afterRosterOpened(")).toBeLessThan(route.indexOf("const pa = await applyStandingPreauthorizations("));
    expect(route).toContain("let rosterEngineered = true;");
    expect(route).toContain("rosterEngineered = engineeringGate.required || declarationUnverified !== null;");
    expect(route).toContain("engineered: rosterEngineered,");
  });
});
