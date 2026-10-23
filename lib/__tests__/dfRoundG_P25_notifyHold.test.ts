// @vitest-environment jsdom
//
// drafting-flow Round G, DF-P25 — GAP-102 ruling (2), the notify-only limb
// (DEC-90 ruling (6) for DF-P25). A notify-only slot a document controller
// opts in (`records_examination`) is told, never waited on; its people's stop
// is a document hold on the request's source document that records what they
// examined IN THE HOLD'S OWN INSERT (document_holds.examination, 20261267 —
// openHold, pinned in holds.test.ts). Pinned here:
//   * the parser keeps the opt-in on a notify-only slot (and still drops it
//     on a consent window, the requester alone, an engineering capability);
//     the editor offers it there and writes it back; the roster carries it;
//   * such a slot is NEVER an assurance sign-off slot, never accepts a
//     standing pre-authorization — sign-offs, vetoes and the ledger are
//     untouched;
//   * the record built for a hold, and read back only for its own request;
//   * the panel: renders and reads NOTHING without such a slot (the roster
//     panel exactly as before); with one, shows the holds' records, offers
//     the slot's own people the hold form, places the hold with the record,
//     says when the database could not store the record, and names the case
//     of a request with no source document.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Ticket, TicketReviewRoster, TicketReviewSlot } from "@/types/schema";

const db = vi.hoisted(() => ({
  results: {} as Record<string, { data: unknown; error: null | { code?: string; message: string } }>,
  reads: [] as string[],
  calls: [] as Array<{ table: string; method: string; args: unknown[] }>,
}));
vi.mock("@/lib/supabase", () => {
  const chain = (table: string): unknown => {
    db.reads.push(table);
    const res = () => db.results[table] ?? { data: [], error: null };
    const c: Record<string, unknown> = {};
    const p: ProxyHandler<Record<string, unknown>> = {
      get(_t, prop: string) {
        if (prop === "then") return (resolve: (v: unknown) => void) => resolve(res());
        if (prop === "maybeSingle" || prop === "single") return () => Promise.resolve({ data: null, error: null });
        return (...args: unknown[]) => { db.calls.push({ table, method: prop, args }); return new Proxy(c, p); };
      },
    };
    return new Proxy(c, p);
  };
  return { supabase: { from: (t: string) => chain(t), auth: { getSession: async () => ({ data: { session: { access_token: "tok" } } }) } } };
});
const holdsMock = vi.hoisted(() => ({ openHold: vi.fn() }));
vi.mock("@/lib/holds", async (orig) => ({ ...(await orig<typeof import("@/lib/holds")>()), openHold: holdsMock.openHold }));
const capMock = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("@/lib/capabilityPolicy", async (orig) => ({ ...(await orig<typeof import("@/lib/capabilityPolicy")>()), loadCapabilityPolicyEntry: capMock.load }));
vi.mock("@/components/providers/DialogProvider", () => ({ appConfirm: vi.fn(async () => true), appAlert: vi.fn(async () => {}), appPrompt: vi.fn(async () => null) }));
vi.mock("@/lib/eSignatures", () => ({ recordSignature: vi.fn(async () => ({ id: "sig-1" })) }));
vi.mock("@/lib/reviewControl", () => ({ effectiveReviewControlForDocument: vi.fn(async () => null), expandReviewers: vi.fn(async () => ({ primaries: [] })) }));
vi.mock("@/components/signatures/SignatureCeremony", () => ({ default: () => null }));

import { parseRoutingControl, validateRoutingDraft, notifyExaminationOptInAllowed, preauthorizationOptInAllowed, type RoutingControl } from "@/lib/routingControl";
import { controlToDraft, draftToControl, notifyExaminationOptInFor, preauthOptInFor, assuranceOptInFor, NOTIFY_EXAMINATION_HINT, withSlotMode } from "@/components/documents/RoutingControlSection";
import { isAssuranceSlot, isNotifyExaminationSlot, holdExaminationRecord, holdExaminationOf, holdOpenerInSlot, rosterOccupancy, examinedFilesText, examinationOf, jsonbTextBytes, HOLD_EXAMINATION_BUDGET_BYTES, HOLD_EXAMINATION_MAX_BYTES } from "@/lib/assuranceExamination";
import { preauthEligibleSlots } from "@/lib/ticketPreauthorization";
import NotifyHoldExamination, { HOLD_RECORD_NOT_STORED, HOLD_RECORD_TOO_LARGE, HOLD_WITHOUT_RECORD_DOES_NOT_STOP_REQUEST, HOLD_NOT_PERMITTED, HOLD_STOPS_REQUEST, notifyHoldFormIntro, NOTIFY_HOLDS_HEADING, NOTIFY_HOLD_BUTTON, NO_FILES_UNDER_REVIEW, holdPermissionUncheckedText, NO_SOURCE_TO_HOLD, NOTIFY_HOLD_READ_LIMIT, NOTIFY_HOLDS_MORE, notSlotHoldsText, uncheckedHoldsText, slotStopHolder } from "@/components/requests/NotifyHoldExamination";
import TicketRosterPanel from "@/components/requests/TicketRosterPanel";

const NOW = "2026-10-22T12:00:00.000Z";
const HASH = "ab12cd34ef56".padEnd(64, "0");
const slot = (over: Partial<TicketReviewSlot>): TicketReviewSlot => ({ id: "r-1:x", kind: "x", label: "X", mode: "blocking", primaries: [], alternates: [], overriders: [], independentOf: [], timeoutDays: null, fallback: false, status: "open", ...over });
const SIGN = slot({ id: "r-1:sign", kind: "sign", label: "Design check", primaries: ["s-1"] });
const WATCH = slot({ id: "r-1:watch", kind: "watch", label: "Inspection notice", mode: "notify_only", primaries: ["q-2"], status: "told", recordsExamination: true });
const WATCH_PLAIN = slot({ ...WATCH, recordsExamination: undefined });
const FILES = [
  { id: "a-d", name: "iso_1A.pdf", url: "k/a", sha256: "f".repeat(64) },
  { id: "a-e", name: "iso_1A_sh2.pdf", url: "k/b", sha256: "e".repeat(64) },
];
const rosterOf = (slots: TicketReviewSlot[], over: Partial<TicketReviewRoster> = {}): TicketReviewRoster =>
  ({ v: 1, id: "r-1", openedAt: NOW, openedBy: "d-1", level: "library", cycle: "1A", contentHash: HASH, files: FILES, slots, ...over } as TicketReviewRoster);
const SOURCE = { id: "doc-1", number: "P-100", title: "P&ID" };
const ticket = (roster: TicketReviewRoster | null, opts: { source?: boolean; status?: string } = {}): Ticket => ({
  id: "t1", orgId: "o1", ticketId: "REQ-1", title: "x", unit: null, requestType: "ISO", status: opts.status ?? "PENDING_REVIEW",
  requesterId: "req-1", requesterRole: "Requester", requesterName: "Rita", assignedDrafterId: "d-1", createdAt: NOW,
  history: [], attachments: [], comments: [], watchers: [], unreadBy: [], deliverableRev: "1A", libraryId: null,
  metadata: { ...(roster ? { review_roster: roster } : {}), ...(opts.source === false ? {} : { source_document: SOURCE }) },
} as unknown as Ticket);

describe("the opt-in on a notify-only slot — parser, editor, roster", () => {
  const table = (over: Record<string, unknown>) => ({ slots: [{ kind: "sign", mode: "blocking", fill: { roles: ["Viewer"] } }, { kind: "watch", mode: "notify_only", fill: { users: ["q-2"] }, ...over }] });
  const watchOf = (raw: unknown) => { const p = parseRoutingControl(raw); return p && p.ok ? p.control.slots[1] : p; };
  it("kept on a notify-only slot; dropped (never refused) on the requester alone or an engineering capability; absent stores nothing", () => {
    expect(watchOf(table({ records_examination: true }))).toMatchObject({ mode: "notify_only", records_examination: true });
    for (const fill of [{ identity: "requester" }, { capability: "ticket.final_approve" }, { capability: "ticket.eng_review" }]) {
      const p = parseRoutingControl(table({ fill, records_examination: true }));
      expect(p && p.ok).toBe(true);
      expect((p as { ok: true; control: RoutingControl }).control.slots[1]).not.toHaveProperty("records_examination");
    }
    expect(watchOf(table({}))).not.toHaveProperty("records_examination");
    expect(notifyExaminationOptInAllowed({ mode: "blocking", fill: { roles: ["Viewer"] } })).toBe(false);
    expect(notifyExaminationOptInAllowed({ mode: "consent_window", fill: { roles: ["Viewer"] } })).toBe(false);
  });
  it("never a standing pre-authorization slot (the preauth opt-in stays blocking-only)", () => {
    expect(preauthorizationOptInAllowed({ mode: "notify_only", fill: { users: ["q-2"] } })).toBe(false);
    const p = parseRoutingControl(table({ records_examination: true, accepts_preauthorization: true }));
    expect((p as { ok: true; control: RoutingControl }).control.slots[1]).not.toHaveProperty("accepts_preauthorization");
  });
  it("the editor offers it on a notify-only slot with its own hint (no sign-off, no wait), round-trips it, and never offers the preauth box there", () => {
    const drafts = controlToDraft({ slots: [{ kind: "watch", label: "Inspection notice", mode: "notify_only", fill: { users: ["q-2"] }, records_examination: true }] });
    expect(drafts[0].recordsExamination).toBe(true);
    expect(notifyExaminationOptInFor(drafts[0])).toBe("offer");
    expect(assuranceOptInFor(drafts[0])).toBe("none");
    expect(preauthOptInFor(drafts[0])).toBe("none");
    expect(draftToControl(drafts).slots[0]).toMatchObject({ mode: "notify_only", records_examination: true });
    expect(validateRoutingDraft({ slots: [{ kind: "sign", mode: "blocking", fill: { roles: ["Viewer"] } }, ...draftToControl(drafts).slots] })).toBeNull();
    expect(NOTIFY_EXAMINATION_HINT).toMatch(/no sign-off is added/);
    // REVIEW FIX 2: the controller is told the slot's people need permission to place holds
    expect(NOTIFY_EXAMINATION_HINT).toMatch(/need permission to place holds \(Admin → Permissions → Action permissions, Place a hold\)/);
    expect(NOTIFY_EXAMINATION_HINT).not.toMatch(/make it|switch|convert|must sign off/i);
    // REVIEW FIX 5, superseded by DF-P26 (GAP-116 — the hold now stops the request on every issuing path):
    // the hint says what the hold stops — the document AND the request — and that releasing it lets the request go on
    expect(NOTIFY_EXAMINATION_HINT).toMatch(/a hold that records what they examined stops the request too: while it is in force the review cannot complete and the deliverable cannot be issued/);
    expect(NOTIFY_EXAMINATION_HINT).toMatch(/Releasing the hold lets the request go on\./);
    // DF-P26 review fix: the request-stop claim is qualified — a hold placed without its record stops the document only
    expect(NOTIFY_EXAMINATION_HINT).toMatch(/a hold placed without that record — before the database update 20261267, or when the record is too large — stops work on the document only/);
    expect(NOTIFY_EXAMINATION_HINT).not.toMatch(/does not stop the request|can still complete/i);
    // REGRESSION: a notify-only slot never ticked writes nothing new
    const plain: RoutingControl = { slots: [{ kind: "watch", mode: "notify_only", fill: { users: ["q-2"] } }] };
    expect(draftToControl(controlToDraft(plain))).toEqual(plain);
  });
  it("REVIEW FIX 4: a mode change drops the opt-in — never carried between a notify-only stop and an assurance sign-off unchosen", () => {
    const [watch] = controlToDraft({ slots: [{ kind: "qa", label: "Quality", mode: "notify_only", fill: { roles: ["Viewer"] }, records_examination: true }] });
    expect(watch.recordsExamination).toBe(true);
    // notify-only → must sign off: NOT an assurance slot unless ticked again
    const blocking = withSlotMode(watch, "blocking");
    expect(blocking.mode).toBe("blocking");
    expect(blocking).not.toHaveProperty("recordsExamination");
    expect(draftToControl([blocking]).slots[0]).not.toHaveProperty("records_examination");
    expect(assuranceOptInFor(blocking)).toBe("offer"); // offered, unticked
    // must sign off (assurance) → notify-only: NOT a hold-recording slot unless ticked again
    const [sign] = controlToDraft({ slots: [{ kind: "qa", mode: "blocking", fill: { roles: ["Viewer"] }, records_examination: true }] });
    const told = withSlotMode(sign, "notify_only");
    expect(told).not.toHaveProperty("recordsExamination");
    expect(draftToControl([told]).slots[0]).not.toHaveProperty("records_examination");
    // the same mode: nothing changes (the very object)
    expect(withSlotMode(watch, "notify_only")).toBe(watch);
    // nothing else on the slot is touched
    expect({ ...blocking, mode: watch.mode }).toEqual((({ recordsExamination: _r, ...rest }) => rest)(watch));
  });
  it("such a slot is never an assurance sign-off slot, never eligible for a pre-authorization; a plain notify-only slot is not one either", () => {
    const t = ticket(rosterOf([SIGN, WATCH]));
    expect(isAssuranceSlot(WATCH, t)).toBe(false);
    expect(isNotifyExaminationSlot(WATCH, t)).toBe(true);
    expect(isNotifyExaminationSlot(WATCH_PLAIN, t)).toBe(false);
    expect(isNotifyExaminationSlot({ ...WATCH, engineering: true }, t)).toBe(false);
    expect(preauthEligibleSlots(rosterOf([SIGN, WATCH])).map((s) => s.kind)).toEqual([]);
  });
});

describe("the record a hold carries", () => {
  it("names the request, the round, the slot, the files (every file by default) and a REQUIRED note (else the hold's description)", () => {
    const r = holdExaminationRecord(rosterOf([WATCH]), "t1", WATCH, { files: ["a-e"], note: "weld map disagrees" });
    expect(r).toMatchObject({ ok: true, record: { stop: "hold", ticketId: "t1", rosterId: "r-1", slotKind: "watch", slotLabel: "Inspection notice", contentHash: HASH, allFiles: false, note: "weld map disagrees" } });
    expect(holdExaminationRecord(rosterOf([WATCH]), "t1", WATCH, {}, "from the hold description")).toMatchObject({ ok: true, record: { note: "from the hold description", allFiles: true } });
    expect(holdExaminationRecord(rosterOf([WATCH]), "t1", WATCH, {})).toEqual({ ok: false, error: "A hold must say why — add a note of what you found." });
    expect(holdExaminationRecord(rosterOf([WATCH]), "t1", WATCH, { files: ["nope"], note: "x" }).ok).toBe(false);
  });
  it("is read back only for its own request (another request's hold, a plain hold, junk → null)", () => {
    const rec = (holdExaminationRecord(rosterOf([WATCH]), "t1", WATCH, { note: "n" }) as { ok: true; record: unknown }).record;
    expect(holdExaminationOf(rec, "t1")).toMatchObject({ slotKind: "watch", note: "n" });
    expect(holdExaminationOf(rec, "t2")).toBeNull();
    for (const junk of [null, "x", [1], { note: "n" }]) expect(holdExaminationOf(junk, "t1")).toBeNull();
  });
});

describe("REVIEW FIX 4 — a hold's record always fits its column (DEC-90 ruling (8): the bookkeeping never blocks the stop)", () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `att-${i}`, name: `PROJ-2026-UNIT-400-ISO-${String(i).padStart(4, "0")}-sheet-${i % 7}-of-7_rev1A.pdf`, url: `k/${i}`, sha256: (i % 16).toString(16).repeat(64) }));
  const NOTE = "Nozzle N3 orientation differs from the vendor datasheet; weld map sheet numbering skips — ".repeat(20).slice(0, 2000).trim();
  it("measures as Postgres prints a jsonb (a space after ':' and ','; UTF-8 bytes)", () => {
    expect(jsonbTextBytes({ a: 1, b: [1, 2], c: null })).toBe('{"a": 1, "b": [1, 2], "c": null}'.length);
    expect(jsonbTextBytes({ n: "é€😀" })).toBe('{"n": ""}'.length + 2 + 3 + 4);
    expect(jsonbTextBytes({ s: "q\"\n" })).toBe(String.raw`{"s": "q\"\n"}`.length); // escaped as JSON escapes
    expect(HOLD_EXAMINATION_BUDGET_BYTES).toBeLessThan(HOLD_EXAMINATION_MAX_BYTES);
  });
  it("REGRESSION: a record within the budget is exactly as before — every file named, no new keys", () => {
    const r = holdExaminationRecord(rosterOf([WATCH], { files: many(20) }), "t1", WATCH, { note: "n" });
    expect(r.ok).toBe(true);
    const rec = (r as unknown as { ok: true; record: Record<string, unknown> }).record;
    expect((rec.files as unknown[]).length).toBe(20);
    expect(rec).not.toHaveProperty("filesTruncated");
    expect(rec).not.toHaveProperty("examinedFiles");
  });
  it("a 320-file round with a 2000-character note (every file, the default selection): the record names the first files while they fit, says how many were examined, keeps the hash and the note — and fits the CHECK", () => {
    const files = many(320);
    const untrimmed = jsonbTextBytes({ files: files.map((f) => ({ id: f.id, name: f.name, sha256: f.sha256 })) });
    expect(untrimmed).toBeGreaterThan(HOLD_EXAMINATION_MAX_BYTES); // the reviewer's scenario: the full list would be refused
    const r = holdExaminationRecord(rosterOf([WATCH], { files }), "t1", WATCH, { files: files.map((f) => f.id), note: NOTE });
    expect(r.ok).toBe(true);
    const rec = (r as unknown as { ok: true; record: Parameters<typeof examinedFilesText>[0] & Record<string, unknown> }).record;
    expect(jsonbTextBytes(rec)).toBeLessThanOrEqual(HOLD_EXAMINATION_BUDGET_BYTES);
    expect(rec).toMatchObject({ filesTruncated: true, examinedFiles: 320, ofFiles: 320, allFiles: true, contentHash: HASH, note: NOTE, stop: "hold", ticketId: "t1" });
    const named = (rec.files as Array<{ id: string }>);
    expect(named.length).toBeGreaterThan(0);
    expect(named.length).toBeLessThan(320);
    expect(named.map((f) => f.id)).toEqual(files.slice(0, named.length).map((f) => f.id)); // the roster's order, from the first
    // one more file would not have fit
    expect(jsonbTextBytes({ ...rec, files: [...named, { id: files[named.length].id, name: files[named.length].name, sha256: files[named.length].sha256 }] })).toBeGreaterThan(HOLD_EXAMINATION_BUDGET_BYTES);
    // read back and said honestly
    const back = holdExaminationOf(rec, "t1")!;
    expect(back).toMatchObject({ filesTruncated: true, examinedFiles: 320 });
    expect(examinedFilesText(back)).toMatch(new RegExp(`^Examined all 320 files: .*\\(only the first ${named.length} named — the record's size is bounded\\)$`));
  });
  it("a narrowed pick over the budget says 'N of M' with N the files examined, not the files named", () => {
    const files = many(400);
    const pick = files.slice(0, 350).map((f) => f.id);
    const rec = (holdExaminationRecord(rosterOf([WATCH], { files }), "t1", WATCH, { files: pick, note: "n" }) as { ok: true; record: Parameters<typeof examinedFilesText>[0] }).record;
    expect(rec).toMatchObject({ filesTruncated: true, examinedFiles: 350, allFiles: false, ofFiles: 400 });
    expect(examinedFilesText(rec)).toMatch(/^Examined 350 of 400 files: /);
  });
  it("a reader never trusts a marker that does not add up (no count, a count below the files named)", () => {
    const base = { contentHash: "h", files: [{ id: "a", name: "a.pdf", sha256: null }], ofFiles: 3, allFiles: false };
    expect(examinationOf({ examination: { ...base, filesTruncated: true } })).not.toHaveProperty("filesTruncated");
    expect(examinationOf({ examination: { ...base, filesTruncated: true, examinedFiles: 0 } })).not.toHaveProperty("filesTruncated");
    expect(examinedFilesText(examinationOf({ examination: base })!)).toBe("Examined 1 of 3 files: a.pdf");
  });
});

// ─── rendered ────────────────────────────────────────────────────────────────
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  db.results = {}; db.reads = []; db.calls = [];
  holdsMock.openHold.mockReset();
  capMock.load.mockReset();
  capMock.load.mockResolvedValue({ policy: {}, version: null });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });
const el = React.createElement as unknown as (t: unknown, p: Record<string, unknown>) => React.ReactElement;
const flush = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const renderHold = async (t: Ticket, uid: string, role: string = "Engineer", roles: string[] = []) => { await act(async () => { root.render(el(NotifyHoldExamination, { ticket: t, orgId: "o1", uid, userName: "Quinn", role, roles })); }); await flush(); };
const q = (id: string) => host.querySelector(`[data-testid="${id}"]`);
const holdRow = (over: Record<string, unknown> = {}) => ({
  id: "h-1", reason: "Other", notes: "weld map", opened_by: "q-2", opened_by_name: "Quinn", opened_at: NOW, released_at: null,
  examination: (holdExaminationRecord(rosterOf([WATCH]), "t1", WATCH, { files: ["a-e"], note: "weld map disagrees" }) as { ok: true; record: unknown }).record, ...over,
});

describe("NotifyHoldExamination — renders and reads nothing without an opted-in notify-only slot", () => {
  it.each([
    ["no roster", null],
    ["a roster with a plain notify-only slot", rosterOf([SIGN, WATCH_PLAIN])],
    ["a roster with only sign-off slots", rosterOf([SIGN])],
  ])("%s → no markup, no read", async (_n, roster) => {
    await renderHold(ticket(roster as TicketReviewRoster | null), "q-2");
    expect(host.innerHTML).toBe("");
    expect(db.reads).toEqual([]);
  });
  it("REGRESSION through the roster panel: a roster with a plain notify-only slot never reads document_holds and shows no hold section", async () => {
    await act(async () => { root.render(el(TicketRosterPanel, { ticket: ticket(rosterOf([SIGN, WATCH_PLAIN])), orgId: "o1", uid: "q-2", activeMemberCount: 5 })); });
    await flush();
    expect(db.reads).not.toContain("document_holds");
    expect(q("notify-hold-examination")).toBeNull();
  });
});

describe("who placed the hold — a record is a slot's stop only when its opener is one of that slot's people (review fix)", () => {
  const rec = { rosterId: "r-1", slotKind: "watch" };
  const occ = rosterOccupancy(rosterOf([SIGN, { ...WATCH, alternates: ["q-alt"] }]));
  it("a primary or an alternate of the named notify-only slot in the named round → slot", () => {
    expect(holdOpenerInSlot("q-2", rec, occ)).toBe("slot");
    expect(holdOpenerInSlot("q-alt", rec, occ)).toBe("slot");
  });
  it("anyone else, a blocking slot's person naming their own slot, or a record naming no round or slot → not_slot", () => {
    expect(holdOpenerInSlot("s-1", rec, occ)).toBe("not_slot");
    expect(holdOpenerInSlot("s-1", { rosterId: "r-1", slotKind: "sign" }, occ)).toBe("not_slot");
    expect(holdOpenerInSlot("q-2", { rosterId: "r-1", slotKind: "nope" }, occ)).toBe("not_slot");
    expect(holdOpenerInSlot("q-2", { rosterId: null, slotKind: "watch" }, occ)).toBe("not_slot");
    expect(holdOpenerInSlot(null, rec, occ)).toBe("not_slot");
  });
  it("a round neither on record nor in the ledger rows given → unknown (never shown)", () => {
    expect(holdOpenerInSlot("q-2", { rosterId: "r-0", slotKind: "watch" }, occ)).toBe("unknown");
  });
});

describe("NotifyHoldExamination — with an opted-in notify-only slot", () => {
  it("REVIEW FIX: a record on a hold placed by someone outside the slot it names (a forged 'Quality' stop) is never shown as that slot's stop — only counted", async () => {
    const forged = holdRow({ id: "h-f", opened_by: "s-1", opened_by_name: "QA Lead", examination: { ...(holdRow().examination as object), slotLabel: "Quality", note: "Examined, found nothing" } });
    db.results.document_holds = { data: [forged], error: null };
    await renderHold(ticket(rosterOf([SIGN, WATCH])), "s-1");
    expect(q("notify-hold-list")).toBeNull();
    expect(host.textContent).not.toContain("Examined, found nothing");
    expect(host.textContent).not.toContain("QA Lead");
    expect(q("notify-hold-not-slot")!.textContent).toBe(notSlotHoldsText(1));
  });
  it("an earlier round's record is checked against the roster ledger: its slot's person → shown; the ledger unreadable → counted as unchecked, not shown", async () => {
    const earlier = holdRow({ id: "h-0", examination: { ...(holdRow().examination as object), rosterId: "r-0", note: "round one finding" } });
    db.results.document_holds = { data: [earlier], error: null };
    db.results.ticket_review_slots = { data: [{ roster_id: "r-0", slot_kind: "watch", label: "Round-one inspection", mode: "notify_only", primaries: ["q-2"], alternates: [] }], error: null };
    await renderHold(ticket(rosterOf([SIGN, WATCH])), "s-1");
    expect(q("notify-hold-list")!.textContent).toContain("round one finding");
    // the slot is named as that round named it, not by the record's own claim
    expect(q("notify-hold-list")!.textContent).toContain("Round-one inspection");
    const ins = db.calls.filter((c) => c.table === "ticket_review_slots" && c.method === "in").map((c) => c.args);
    expect(ins).toEqual([["roster_id", ["r-0"]]]);
    act(() => root.unmount());
    root = createRoot(host);
    db.results.ticket_review_slots = { data: null, error: { code: "42P01", message: "relation does not exist" } };
    await renderHold(ticket(rosterOf([SIGN, WATCH])), "s-1");
    expect(q("notify-hold-list")).toBeNull();
    expect(host.textContent).not.toContain("round one finding");
    expect(q("notify-hold-unchecked")!.textContent).toBe(uncheckedHoldsText(1));
  });
  it("REVIEW FIX: the read is filtered to this request in the query and capped at the limit + 1; a full page says more exist", async () => {
    const many = Array.from({ length: NOTIFY_HOLD_READ_LIMIT + 1 }, (_, i) => holdRow({ id: `h-${i}` }));
    db.results.document_holds = { data: many, error: null };
    await renderHold(ticket(rosterOf([SIGN, WATCH])), "s-1");
    expect(db.calls).toContainEqual({ table: "document_holds", method: "eq", args: ["examination->>ticketId", "t1"] });
    expect(db.calls).toContainEqual({ table: "document_holds", method: "limit", args: [NOTIFY_HOLD_READ_LIMIT + 1] });
    expect(q("notify-hold-list")!.querySelectorAll("li")).toHaveLength(NOTIFY_HOLD_READ_LIMIT);
    expect(q("notify-hold-more")!.textContent).toBe(NOTIFY_HOLDS_MORE);
  });
  it("the slot's own person's record is headed by the slot's label on the roster, never by a label the record claims", async () => {
    db.results.document_holds = { data: [holdRow({ examination: { ...(holdRow().examination as object), slotLabel: "Quality" } })], error: null };
    await renderHold(ticket(rosterOf([SIGN, WATCH])), "s-1");
    expect(q("notify-hold-list")!.textContent).toContain("Inspection notice");
    expect(q("notify-hold-list")!.textContent).not.toContain("Quality");
  });
  it("REVIEW FIX 3: a slot's stop is headed with the opener's name from the member list — never the opened_by_name the hold's writer typed; the member list unreadable → the slot's people, unnamed", async () => {
    db.results.document_holds = { data: [holdRow({ opened_by_name: "Plant Manager" })], error: null };
    db.results.org_members = { data: [{ uid: "q-2", display_name: "Quinn Q", email: "quinn@plant.test" }], error: null };
    await renderHold(ticket(rosterOf([SIGN, WATCH])), "s-1");
    expect(q("notify-hold-list")!.textContent).toContain("held by Quinn Q");
    expect(host.textContent).not.toContain("Plant Manager");
    // the member read names only the openers of the records read, in this workspace
    expect(db.calls).toContainEqual({ table: "org_members", method: "in", args: ["uid", ["q-2"]] });
    expect(db.calls).toContainEqual({ table: "org_members", method: "eq", args: ["org_id", "o1"] });
    // opened_by_name is not even read
    const sel = db.calls.find((c) => c.table === "document_holds" && c.method === "select")!.args[0] as string;
    expect(sel).not.toContain("opened_by_name");
    act(() => root.unmount());
    root = createRoot(host);
    db.results.org_members = { data: null, error: { code: "42501", message: "permission denied" } };
    await renderHold(ticket(rosterOf([SIGN, WATCH])), "s-1");
    expect(q("notify-hold-list")!.textContent).toContain("held by a member of Inspection notice");
    expect(host.textContent).not.toContain("Plant Manager");
  });
  it("slotStopHolder: the member list's name, else the slot's people unnamed (pure)", () => {
    expect(slotStopHolder("q-2", new Map([["q-2", "Quinn Q"]]), "Inspection notice")).toBe("Quinn Q");
    expect(slotStopHolder("q-2", new Map(), "Inspection notice")).toBe("a member of Inspection notice");
    expect(slotStopHolder("q-2", new Map(), "")).toBe("a member of this slot");
  });
  it("a page that did not fill says nothing more", async () => {
    db.results.document_holds = { data: [holdRow()], error: null };
    await renderHold(ticket(rosterOf([SIGN, WATCH])), "s-1");
    expect(q("notify-hold-more")).toBeNull();
  });
  it("shows each hold placed from this request with its record; another request's hold is not shown", async () => {
    const other = holdRow({ id: "h-2", examination: { ...(holdRow().examination as object), ticketId: "t-other" } });
    db.results.document_holds = { data: [holdRow(), other], error: null };
    await renderHold(ticket(rosterOf([SIGN, WATCH])), "s-1");
    const list = q("notify-hold-list")!;
    expect(list.querySelectorAll("li")).toHaveLength(1);
    expect(list.textContent).toContain("Inspection notice");
    expect(list.textContent).toContain("weld map disagrees");
    expect(list.textContent).toContain("Examined 1 of 2 files: iso_1A_sh2.pdf");
    // read as the viewer, on the source document, filtered to THIS request in the query
    const eqs = db.calls.filter((c) => c.table === "document_holds" && c.method === "eq").map((c) => c.args);
    expect(eqs).toContainEqual(["document_id", "doc-1"]);
    expect(eqs).toContainEqual(["examination->>ticketId", "t1"]);
    // the record names the roster on record: no ledger read
    expect(db.reads).not.toContain("ticket_review_slots");
    expect(q("notify-hold-not-slot")).toBeNull();
    // not one of the slot's people: no form
    expect(q("notify-hold-form")).toBeNull();
  });
  it("the slot's own person gets the form; placing the hold sends the record in openHold's insert (every file by default, the note)", async () => {
    holdsMock.openHold.mockResolvedValue({ id: "h-9" });
    await renderHold(ticket(rosterOf([SIGN, WATCH])), "q-2");
    expect(q("notify-hold-form")).not.toBeNull();
    const ta = host.querySelector('textarea[aria-label="What you found"]') as HTMLTextAreaElement;
    const desc = host.querySelector('input[aria-label="Hold description"]') as HTMLInputElement;
    const setValue = (node: HTMLInputElement | HTMLTextAreaElement, v: string) => {
      const proto = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(node, v);
      node.dispatchEvent(new Event("input", { bubbles: true }));
    };
    await act(async () => { setValue(ta, "nozzle orientation differs from the datasheet"); setValue(desc, "nozzle orientation"); });
    await act(async () => { (q("notify-hold-place") as HTMLButtonElement).click(); });
    await flush();
    expect(holdsMock.openHold).toHaveBeenCalledTimes(1);
    const arg = holdsMock.openHold.mock.calls[0][0];
    expect(arg).toMatchObject({ orgId: "o1", documentId: "doc-1", reason: "Other", notes: "nozzle orientation", openedBy: "q-2", openedByName: "Quinn" });
    expect(arg.examination).toMatchObject({ stop: "hold", ticketId: "t1", slotKind: "watch", allFiles: true, ofFiles: 2, note: "nozzle orientation differs from the datasheet" });
    expect(arg).not.toHaveProperty("originTicketId");
    expect(host.textContent).toContain("Hold placed, with what you examined.");
  });
  it("REVIEW FIX 5 as superseded by DF-P26 (GAP-116): the panel says the hold stops work on the document AND this request, until it is released", async () => {
    await renderHold(ticket(rosterOf([SIGN, WATCH])), "q-2");
    expect(q("notify-hold-intro")!.textContent).toBe(notifyHoldFormIntro("Inspection notice", "P-100"));
    expect(q("notify-hold-intro")!.textContent).toContain(HOLD_STOPS_REQUEST);
    expect(HOLD_STOPS_REQUEST).toMatch(/A hold that records what you examined also stops this request: while it is in force the review cannot complete and the deliverable cannot be issued\. Releasing the hold lets the request go on\./);
    expect(HOLD_STOPS_REQUEST).not.toMatch(/It also stops this request/);
    expect(HOLD_STOPS_REQUEST).toMatch(/no new revision of it is published, and it is not transmitted or shared, until the hold is released/);
    expect(q("notify-hold-intro")!.textContent).not.toMatch(/does not stop this request|can still complete/);
    expect(q("notify-hold-place")!.textContent).toBe(NOTIFY_HOLD_BUTTON);
    expect(NOTIFY_HOLD_BUTTON).toBe("Place a hold on the document");
    expect(q("notify-hold-examination")!.textContent).toContain(NOTIFY_HOLDS_HEADING);
    // no visible sentence promises a stop of the request or its review
    const visible = host.textContent ?? "";
    expect(visible).not.toMatch(/Stop it with a hold|To stop it, place|Stops by the people told|stop this review with a hold/);
    expect(HOLD_NOT_PERMITTED).not.toMatch(/stop this review|stop it with a hold/i);
    expect(HOLD_NOT_PERMITTED).toMatch(/To stop this request, raise it with the assignment queue\./);
  });
  it("a hold placed before 20261267 (no column): the hold stands and the panel says the record was not stored", async () => {
    holdsMock.openHold.mockResolvedValue({ id: "h-9", examinationNotRecorded: true });
    await renderHold(ticket(rosterOf([SIGN, WATCH])), "q-2");
    const ta = host.querySelector('textarea[aria-label="What you found"]') as HTMLTextAreaElement;
    const desc = host.querySelector('input[aria-label="Hold description"]') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(ta, "found it"); ta.dispatchEvent(new Event("input", { bubbles: true }));
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(desc, "d"); desc.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { (q("notify-hold-place") as HTMLButtonElement).click(); });
    await flush();
    expect(host.textContent).toContain(HOLD_RECORD_NOT_STORED);
    // DF-P26 review fix: a hold without its record names no request — the panel says it does not stop the request
    expect(HOLD_RECORD_NOT_STORED).toContain(HOLD_WITHOUT_RECORD_DOES_NOT_STOP_REQUEST);
    expect(host.textContent).toContain("Without that record this hold stops work on the document only — it does not stop this request; raise it with the assignment queue to stop the request.");
  });
  it("REVIEW FIX 4: a record the database refused for size: the hold stands and the panel says so (not the missing-update sentence)", async () => {
    holdsMock.openHold.mockResolvedValue({ id: "h-9", examinationNotRecorded: true, examinationTooLarge: true });
    await renderHold(ticket(rosterOf([SIGN, WATCH])), "q-2");
    const ta = host.querySelector('textarea[aria-label="What you found"]') as HTMLTextAreaElement;
    const desc = host.querySelector('input[aria-label="Hold description"]') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(ta, "found it"); ta.dispatchEvent(new Event("input", { bubbles: true }));
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(desc, "d"); desc.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { (q("notify-hold-place") as HTMLButtonElement).click(); });
    await flush();
    expect(host.textContent).toContain(HOLD_RECORD_TOO_LARGE);
    expect(host.textContent).not.toContain(HOLD_RECORD_NOT_STORED);
    // DF-P26 review fix: the size branch says the same — the request is not stopped
    expect(HOLD_RECORD_TOO_LARGE).toContain(HOLD_WITHOUT_RECORD_DOES_NOT_STOP_REQUEST);
    expect(host.textContent).toContain("it does not stop this request; raise it with the assignment queue to stop the request.");
  });
  it("an empty note is refused in place — nothing placed", async () => {
    await renderHold(ticket(rosterOf([SIGN, WATCH])), "q-2");
    await act(async () => { (q("notify-hold-place") as HTMLButtonElement).click(); });
    await flush();
    expect(holdsMock.openHold).not.toHaveBeenCalled();
    expect(host.textContent).toContain("A hold must say why");
  });
  it("a request with no source document: the slot's person is told there is nothing to hold; nothing is read", async () => {
    await renderHold(ticket(rosterOf([SIGN, WATCH]), { source: false }), "q-2");
    expect(q("notify-hold-no-source")!.textContent).toBe(NO_SOURCE_TO_HOLD);
    expect(db.reads).toEqual([]);
  });
  it("REVIEW FIX 2: an occupant whose role may not place holds (a read-only role, or holds.open narrowed away from them) gets no form — a plain note naming where an Admin allows it; nothing can be placed", async () => {
    await renderHold(ticket(rosterOf([SIGN, WATCH])), "q-2", "Viewer");
    expect(q("notify-hold-form")).toBeNull();
    expect(q("notify-hold-place")).toBeNull();
    expect(q("notify-hold-not-permitted")!.textContent).toBe(HOLD_NOT_PERMITTED);
    expect(HOLD_NOT_PERMITTED).toMatch(/Admin → Permissions → Action permissions \(Place a hold\)/);
    act(() => root.unmount());
    root = createRoot(host);
    capMock.load.mockResolvedValue({ policy: { caps: { "holds.open": ["Admin"] } }, version: "v2" });
    await renderHold(ticket(rosterOf([SIGN, WATCH])), "q-2", "Engineer");
    expect(q("notify-hold-form")).toBeNull();
    expect(q("notify-hold-not-permitted")!.textContent).toBe(HOLD_NOT_PERMITTED);
    // a per-person grant of holds.open lights the form, as openHold's check would let it through
    act(() => root.unmount());
    root = createRoot(host);
    capMock.load.mockResolvedValue({ policy: { caps: { "holds.open": ["Admin"] }, grants: [{ uid: "q-2", cap: "holds.open" }] }, version: "v3" });
    await renderHold(ticket(rosterOf([SIGN, WATCH])), "q-2", "Engineer");
    expect(q("notify-hold-not-permitted")).toBeNull();
    expect(q("notify-hold-form")).not.toBeNull();
  });
  it("REVIEW FIX 2: when whether the occupant may place holds cannot be read, no form (fail closed) — the reason and Try again, which re-reads", async () => {
    capMock.load.mockResolvedValueOnce({ policy: {}, version: null, unreadable: "the permissions could not be read" });
    await renderHold(ticket(rosterOf([SIGN, WATCH])), "q-2");
    expect(q("notify-hold-form")).toBeNull();
    expect(q("notify-hold-permission-unchecked")!.textContent).toContain(holdPermissionUncheckedText("the permissions could not be read"));
    await act(async () => { (q("notify-hold-permission-unchecked")!.querySelector("button") as HTMLButtonElement).click(); });
    await flush();
    expect(capMock.load).toHaveBeenCalledTimes(2);
    expect(q("notify-hold-form")).not.toBeNull();
  });
  it("REVIEW FIX 2: the roster panel forwards the viewer's role and collection — a read-only viewer gets the note, the same occupant as an Engineer gets the form", async () => {
    await act(async () => { root.render(el(TicketRosterPanel, { ticket: ticket(rosterOf([SIGN, WATCH])), orgId: "o1", uid: "q-2", role: "Engineer", roles: ["Engineer", "Viewer"], activeMemberCount: 5 })); });
    await flush();
    expect(q("notify-hold-form")).toBeNull();
    expect(q("notify-hold-not-permitted")).not.toBeNull();
    act(() => root.unmount());
    root = createRoot(host);
    await act(async () => { root.render(el(TicketRosterPanel, { ticket: ticket(rosterOf([SIGN, WATCH])), orgId: "o1", uid: "q-2", role: "Engineer", roles: ["Engineer"], activeMemberCount: 5 })); });
    await flush();
    expect(q("notify-hold-not-permitted")).toBeNull();
    expect(q("notify-hold-form")).not.toBeNull();
  });
  it("REVIEW FIX 2: the permission is read only for an occupant who would be offered the form — never for someone outside the slot", async () => {
    db.results.document_holds = { data: [holdRow()], error: null };
    await renderHold(ticket(rosterOf([SIGN, WATCH])), "s-1");
    expect(capMock.load).not.toHaveBeenCalled();
    expect(q("notify-hold-not-permitted")).toBeNull();
  });
  it("REVIEW FIX 2: a round with no files under review says so and the hold can still be placed — the note alone is the record", async () => {
    holdsMock.openHold.mockResolvedValue({ id: "h-9" });
    await renderHold(ticket(rosterOf([SIGN, WATCH], { files: [] })), "q-2");
    expect(q("notify-hold-no-files")!.textContent).toBe(NO_FILES_UNDER_REVIEW);
    const btn = q("notify-hold-place") as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    const ta = host.querySelector('textarea[aria-label="What you found"]') as HTMLTextAreaElement;
    const desc = host.querySelector('input[aria-label="Hold description"]') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(ta, "described scope is wrong"); ta.dispatchEvent(new Event("input", { bubbles: true }));
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(desc, "scope"); desc.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { btn.click(); });
    await flush();
    expect(holdsMock.openHold).toHaveBeenCalledTimes(1);
    const rec = holdsMock.openHold.mock.calls[0][0].examination;
    expect(rec).toMatchObject({ stop: "hold", files: [], ofFiles: 0, note: "described scope is wrong" });
    expect(examinedFilesText(rec)).toBe("No files were under review");
  });
  it("before 20261267 the read names the column (42703): the panel says records are kept from that update — never an error", async () => {
    db.results.document_holds = { data: null, error: { code: "42703", message: "column document_holds.examination does not exist" } };
    await renderHold(ticket(rosterOf([SIGN, WATCH])), "s-1");
    expect(q("notify-hold-not-migrated")).not.toBeNull();
  });
});
