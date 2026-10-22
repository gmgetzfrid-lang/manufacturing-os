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
vi.mock("@/components/providers/DialogProvider", () => ({ appConfirm: vi.fn(async () => true), appAlert: vi.fn(async () => {}), appPrompt: vi.fn(async () => null) }));
vi.mock("@/lib/eSignatures", () => ({ recordSignature: vi.fn(async () => ({ id: "sig-1" })) }));
vi.mock("@/lib/reviewControl", () => ({ effectiveReviewControlForDocument: vi.fn(async () => null), expandReviewers: vi.fn(async () => ({ primaries: [] })) }));
vi.mock("@/components/signatures/SignatureCeremony", () => ({ default: () => null }));

import { parseRoutingControl, validateRoutingDraft, notifyExaminationOptInAllowed, preauthorizationOptInAllowed, type RoutingControl } from "@/lib/routingControl";
import { controlToDraft, draftToControl, notifyExaminationOptInFor, preauthOptInFor, assuranceOptInFor, NOTIFY_EXAMINATION_HINT } from "@/components/documents/RoutingControlSection";
import { isAssuranceSlot, isNotifyExaminationSlot, holdExaminationRecord, holdExaminationOf } from "@/lib/assuranceExamination";
import { preauthEligibleSlots } from "@/lib/ticketPreauthorization";
import NotifyHoldExamination, { HOLD_RECORD_NOT_STORED, NO_SOURCE_TO_HOLD } from "@/components/requests/NotifyHoldExamination";
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
    expect(NOTIFY_EXAMINATION_HINT).not.toMatch(/make it|switch|convert|must sign off/i);
    // REGRESSION: a notify-only slot never ticked writes nothing new
    const plain: RoutingControl = { slots: [{ kind: "watch", mode: "notify_only", fill: { users: ["q-2"] } }] };
    expect(draftToControl(controlToDraft(plain))).toEqual(plain);
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

// ─── rendered ────────────────────────────────────────────────────────────────
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  db.results = {}; db.reads = []; db.calls = [];
  holdsMock.openHold.mockReset();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });
const el = React.createElement as unknown as (t: unknown, p: Record<string, unknown>) => React.ReactElement;
const flush = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const renderHold = async (t: Ticket, uid: string) => { await act(async () => { root.render(el(NotifyHoldExamination, { ticket: t, orgId: "o1", uid, userName: "Quinn" })); }); await flush(); };
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

describe("NotifyHoldExamination — with an opted-in notify-only slot", () => {
  it("shows each hold placed from this request with its record; another request's hold is not shown", async () => {
    const other = holdRow({ id: "h-2", examination: { ...(holdRow().examination as object), ticketId: "t-other" } });
    db.results.document_holds = { data: [holdRow(), other], error: null };
    await renderHold(ticket(rosterOf([SIGN, WATCH])), "s-1");
    const list = q("notify-hold-list")!;
    expect(list.querySelectorAll("li")).toHaveLength(1);
    expect(list.textContent).toContain("Inspection notice");
    expect(list.textContent).toContain("weld map disagrees");
    expect(list.textContent).toContain("Examined 1 of 2 files: iso_1A_sh2.pdf");
    // read as the viewer, on the source document, only holds with a record
    const eqs = db.calls.filter((c) => c.table === "document_holds" && c.method === "eq").map((c) => c.args);
    expect(eqs).toContainEqual(["document_id", "doc-1"]);
    expect(db.calls.some((c) => c.table === "document_holds" && c.method === "not" && c.args[0] === "examination")).toBe(true);
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
  it("before 20261267 the read names the column (42703): the panel says records are kept from that update — never an error", async () => {
    db.results.document_holds = { data: null, error: { code: "42703", message: "column document_holds.examination does not exist" } };
    await renderHold(ticket(rosterOf([SIGN, WATCH])), "s-1");
    expect(q("notify-hold-not-migrated")).not.toBeNull();
  });
});
