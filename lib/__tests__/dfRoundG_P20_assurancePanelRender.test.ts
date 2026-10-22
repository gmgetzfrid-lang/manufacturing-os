// @vitest-environment jsdom
//
// drafting-flow Round G, DF-P20 ASSURANCE EXAMINATION RECORD — the roster
// panel as rendered (DEC-90 rulings (2), (3) and (5) for DF-P20): an
// assurance reviewer is asked in place what they examined (every file by
// default, a note — required for a veto, so a veto is still one step); each
// assurance sign-off shows its record (the hash shortened with a copy button,
// the files, the note); one signed before DF-P20 says "Examination not
// recorded", never an error; a closed round's veto stays readable. A roster
// with no assurance slot, and every request with none, reads nothing new and
// shows nothing new — pinned across every status and viewer.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Ticket, TicketReviewRoster, TicketReviewSlot, TicketStatus } from "@/types/schema";

const db = vi.hoisted(() => ({
  results: {} as Record<string, { data: unknown; error: null | { code?: string; message: string } }>,
  // when set, a read answers only once this settles (a read in flight)
  hold: null as null | Promise<void>,
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
        if (prop === "then") return (resolve: (v: unknown) => void) => { if (db.hold) void db.hold.then(() => resolve(res())); else resolve(res()); };
        if (prop === "maybeSingle" || prop === "single") return () => Promise.resolve({ data: null, error: null });
        return (...args: unknown[]) => { db.calls.push({ table, method: prop, args }); return new Proxy(c, p); };
      },
    };
    return new Proxy(c, p);
  };
  return { supabase: { from: (t: string) => chain(t), auth: { getSession: async () => ({ data: { session: { access_token: "tok" } } }) } } };
});
const dlg = vi.hoisted(() => ({ confirm: vi.fn(async () => true) }));
vi.mock("@/components/providers/DialogProvider", () => ({ appConfirm: dlg.confirm, appAlert: vi.fn(async () => {}), appPrompt: vi.fn(async () => null) }));
vi.mock("@/lib/eSignatures", () => ({ recordSignature: vi.fn(async () => ({ id: "sig-1" })) }));
vi.mock("@/lib/reviewControl", () => ({ effectiveReviewControlForDocument: vi.fn(async () => null), expandReviewers: vi.fn(async () => ({ primaries: [] })) }));
// The ceremony: shows the statement it was given and signs on a click.
vi.mock("@/components/signatures/SignatureCeremony", () => ({
  default: (p: { defaultStatement: string; onSign: (i: string, s: string) => void }) =>
    React.createElement("button", { "data-testid": "ceremony", "data-statement": p.defaultStatement, onClick: () => p.onSign("Reviewed", p.defaultStatement) }, "sign"),
}));

import { readFileSync } from "node:fs";
import { join } from "node:path";
import TicketRosterPanel, { rosterSignStatement, examinationBody, REVISION_CATEGORIES } from "@/components/requests/TicketRosterPanel";
import { EXAMINATION_NOT_RECORDED } from "@/lib/assuranceExamination";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  db.results = {}; db.reads = []; db.calls = []; db.hold = null;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const el = React.createElement as unknown as (t: unknown, p: Record<string, unknown>) => React.ReactElement;
const flush = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const render = async (t: Ticket, uid: string) => { await act(async () => { root.render(el(TicketRosterPanel, { ticket: t, orgId: "o1", uid, activeMemberCount: 5 })); }); await flush(); };
const q = (id: string) => host.querySelector(`[data-testid="${id}"]`);
const button = (re: RegExp) => [...host.querySelectorAll("button")].find((b) => re.test(b.textContent ?? ""))!;

const NOW = "2026-10-21T12:00:00.000Z";
const HASH = "ab12cd34ef56".padEnd(64, "0");
const slot = (over: Partial<TicketReviewSlot>): TicketReviewSlot => ({ id: "r-1:x", kind: "x", label: "X", mode: "blocking", primaries: [], alternates: [], overriders: [], independentOf: [], timeoutDays: null, fallback: false, status: "open", ...over });
const ACCEPT = slot({ id: "r-1:accept", kind: "accept", label: "Requester acceptance", primaries: ["req-1"] });
const CHECK = slot({ id: "r-1:check", kind: "check", label: "Engineering check", primaries: ["e-1"], engineering: true });
// DF-P20 fix pass 2: opted in by the routing table's controller (never inferred).
const ASSURE = slot({ id: "r-1:assure", kind: "assure", label: "Inspection check", primaries: ["q-1"], independentOf: ["drafter"], recordsExamination: true });
const WATCH = slot({ id: "r-1:watch", kind: "watch", label: "Inspection notice", mode: "notify_only", primaries: ["q-2"], status: "told" });
const FILES = [
  { id: "a-d", name: "iso_1A.pdf", url: "k/a", sha256: "f".repeat(64) },
  { id: "a-e", name: "iso_1A_sh2.pdf", url: "k/b", sha256: "e".repeat(64) },
];
const rosterOf = (slots: TicketReviewSlot[], over: Partial<TicketReviewRoster> = {}): TicketReviewRoster => ({
  v: 1, id: "r-1", openedAt: NOW, openedBy: "d-1", level: "library", cycle: "1A", contentHash: HASH, files: FILES, slots, ...over,
});
const ticket = (roster: TicketReviewRoster | null, status: TicketStatus = "PENDING_REVIEW"): Ticket => ({
  id: "t1", orgId: "o1", ticketId: "REQ-1", title: "x", unit: null, requestType: "ISO", status,
  requesterId: "req-1", requesterRole: "Requester", requesterName: "Rita", assignedDrafterId: "d-1", createdAt: NOW,
  history: [], attachments: [], comments: [], watchers: [], unreadBy: [], deliverableRev: "1A", libraryId: null,
  metadata: roster ? { review_roster: roster } : {},
} as unknown as Ticket);
const record = (over: Record<string, unknown> = {}) => ({ v: 1, act: "sign_off", contentHash: HASH, cycle: "1A", files: [{ id: "a-e", name: "iso_1A_sh2.pdf", sha256: "e".repeat(64) }], ofFiles: 2, allFiles: false, note: "weld map checked", ...over });
const ev = (over: Record<string, unknown>) => ({ id: "ev-1", roster_id: "r-1", slot_kind: "assure", event: "satisfied", actor_id: "q-1", actor_name: "Quinn", content_hash: HASH, created_at: NOW, details: { via: "primary" }, ...over });
const fetchBodies = () => {
  const bodies: Array<Record<string, unknown>> = [];
  vi.stubGlobal("fetch", vi.fn(async (_u: string, init: { body: string }) => { bodies.push(JSON.parse(init.body)); return new Response(JSON.stringify({ ok: true }), { status: 200 }); }));
  return bodies;
};

describe("the assurance reviewer is asked in place what they examined", () => {
  it("every file ticked by default, a note, and a 'Request revision' beside the one sign-off", async () => {
    await render(ticket(rosterOf([ACCEPT, CHECK, ASSURE, WATCH])), "q-1");
    const form = q("examination-form")!;
    expect(form).not.toBeNull();
    const boxes = [...form.querySelectorAll('input[type="checkbox"]')] as HTMLInputElement[];
    expect(boxes.map((b) => b.checked)).toEqual([true, true]);
    expect(form.textContent).toContain("iso_1A.pdf");
    expect(form.textContent).toContain(HASH.slice(0, 12));
    expect(q("examination-veto")).not.toBeNull();
    expect(button(/Sign off — Inspection check/)).toBeTruthy();
  });

  it("a veto with no note is refused in place — nothing sent; with a note it is ONE post: the note as the comment and on the record", async () => {
    const bodies = fetchBodies();
    await render(ticket(rosterOf([ACCEPT, CHECK, ASSURE])), "q-1");
    await act(async () => { (q("examination-veto") as HTMLButtonElement).click(); });
    expect(bodies).toEqual([]);
    expect(host.querySelector('[role="alert"]')!.textContent).toMatch(/Say why you are requesting a revision/);
    const ta = q("examination-note-input") as HTMLTextAreaElement;
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      set.call(ta, "  dimension missing on sheet 2 ");
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    });
    // narrow to the second file
    await act(async () => { ((q("examination-form")!.querySelectorAll('input[type="checkbox"]')[0]) as HTMLInputElement).click(); });
    await act(async () => { (q("examination-veto") as HTMLButtonElement).click(); });
    await flush();
    expect(bodies).toEqual([{ ticketId: "t1", actionType: "request_revision", comment: "dimension missing on sheet 2", category: "Drafting Error", examination: { files: ["a-e"], note: "dimension missing on sheet 2" } }]);
  });

  it("fix pass (review minor 6): the in-place revision request carries the reason category the page's Request Revision asks, from the same list; the redline route is named", async () => {
    const bodies = fetchBodies();
    await render(ticket(rosterOf([ACCEPT, CHECK, ASSURE])), "q-1");
    const sel = q("examination-veto-category") as HTMLSelectElement;
    expect([...sel.options].map((o) => o.value)).toEqual([...REVISION_CATEGORIES]);
    await act(async () => { sel.value = "Standards Violation"; sel.dispatchEvent(new Event("change", { bubbles: true })); });
    const ta = q("examination-note-input") as HTMLTextAreaElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(ta, "wrong line class");
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { (q("examination-veto") as HTMLButtonElement).click(); });
    await flush();
    expect(bodies[0]).toMatchObject({ actionType: "request_revision", comment: "wrong line class", category: "Standards Violation" });
    expect(q("examination-veto-redline")!.textContent).toMatch(/page.s Request Revision/);
  });

  it("the panel's categories are the request page's REVISION_REASONS, in order (drift pin)", () => {
    const src = readFileSync(join(process.cwd(), "app", "(protected)", "requests", "[id]", "page.tsx"), "utf8");
    const m = src.match(/const REVISION_REASONS = \[([\s\S]*?)\];/);
    expect(m).not.toBeNull();
    const page = [...m![1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
    expect(page).toEqual([...REVISION_CATEGORIES]);
  });

  it("the sign-off: the dry run and the post carry the record (every file left ticked → the full list, a chosen 'all' — fix pass 2; blank note → null); the signed statement is exactly as before when nothing was narrowed", async () => {
    const bodies = fetchBodies();
    await render(ticket(rosterOf([ACCEPT, CHECK, ASSURE])), "q-1");
    await act(async () => { button(/Sign off — Inspection check/).click(); });
    await flush();
    expect(bodies[0]).toMatchObject({ actionType: "sign_slot", dryRun: true, examination: { files: ["a-d", "a-e"], note: null } });
    const ceremony = q("ceremony") as HTMLButtonElement;
    expect(ceremony.getAttribute("data-statement")).toBe(rosterSignStatement({ userName: null, ticketLabel: "REQ-1", roster: rosterOf([]), labels: ["Inspection check"], issueReady: false }));
    await act(async () => { ceremony.click(); });
    await flush();
    expect(bodies[1]).toMatchObject({ actionType: "sign_slot", signatureId: "sig-1", examination: { files: ["a-d", "a-e"], note: null } });
  });

  it("narrowed: the signed statement says which files were examined", async () => {
    fetchBodies();
    await render(ticket(rosterOf([ACCEPT, CHECK, ASSURE])), "q-1");
    await act(async () => { ((q("examination-form")!.querySelectorAll('input[type="checkbox"]')[1]) as HTMLInputElement).click(); });
    await act(async () => { button(/Sign off — Inspection check/).click(); });
    await flush();
    expect(q("ceremony")!.getAttribute("data-statement")).toContain("(iso_1A.pdf, iso_1A_sh2.pdf), having examined iso_1A.pdf, and sign off as Inspection check");
  });

  it("fix pass 2 (review minor 5): an occupant whose assurance slot is blocked (separation of duties) gets only the revision request — no file checklist, no sign-off wording — and sends no file list", async () => {
    const bodies = fetchBodies();
    const mine = { ...ASSURE, primaries: ["d-1", "q-1"] };
    await render(ticket(rosterOf([ACCEPT, CHECK, mine])), "d-1");
    const form = q("examination-form")!;
    expect(form.getAttribute("data-signs")).toBe("no");
    expect(form.querySelector("legend")!.textContent).toBe("Request a revision");
    expect(q("examination-files-pick")).toBeNull();
    expect(form.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
    expect(form.textContent).toContain("Note — required to request a revision");
    expect(form.textContent).not.toMatch(/optional with a sign-off/);
    expect([...host.querySelectorAll("button")].some((b) => /Sign off — Inspection check/.test(b.textContent ?? ""))).toBe(false);
    const ta = q("examination-note-input") as HTMLTextAreaElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(ta, "tag wrong");
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { (q("examination-veto") as HTMLButtonElement).click(); });
    await flush();
    expect(bodies).toEqual([{ ticketId: "t1", actionType: "request_revision", comment: "tag wrong", category: "Drafting Error", examination: { note: "tag wrong" } }]);
  });

  it("unticking every file is refused in place, not sent", async () => {
    const bodies = fetchBodies();
    await render(ticket(rosterOf([ACCEPT, CHECK, ASSURE])), "q-1");
    for (const i of [0, 1]) await act(async () => { ((q("examination-form")!.querySelectorAll('input[type="checkbox"]')[i]) as HTMLInputElement).click(); });
    await act(async () => { button(/Sign off — Inspection check/).click(); });
    expect(bodies).toEqual([]);
    expect(host.querySelector('[role="alert"]')!.textContent).toMatch(/Mark at least one file you examined/);
  });
});

describe("each assurance event shows its record (ruling (5)); one from before DF-P20 says so, never an error (ruling (3))", () => {
  it("a signed assurance slot: the hash shortened with a copy button (the full value copied), the files examined, the note", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    db.results.ticket_review_slot_events = { data: [ev({ details: { via: "primary", examination: record() } })], error: null };
    const signed = { ...ASSURE, status: "satisfied" as const, satisfiedBy: "q-1", satisfiedByName: "Quinn", satisfiedAt: NOW, signatureId: "s", via: "primary" as const };
    await render(ticket(rosterOf([ACCEPT, CHECK, signed])), "x-9");
    expect(db.reads).toContain("ticket_review_slot_events");
    const rec = q("examination-record")!;
    expect(q("examination-hash")!.textContent).toBe(`${HASH.slice(0, 12)}…`);
    expect(q("examination-files")!.textContent).toBe("Examined 1 of 2 files: iso_1A_sh2.pdf");
    expect(q("examination-note")!.textContent).toBe("Note: weld map checked");
    await act(async () => { button(/^Copy$/).click(); });
    expect(writeText).toHaveBeenCalledWith(HASH);
    expect(rec.textContent).toContain("Copied");
  });

  it("fix pass (review minor 5): right after a sign-off the re-read is in flight — the slot just signed never shows 'Examination not recorded' before its record arrives", async () => {
    db.results.ticket_review_slot_events = { data: [], error: null };
    await render(ticket(rosterOf([ACCEPT, CHECK, ASSURE])), "x-9");
    expect(db.reads).toContain("ticket_review_slot_events");
    // the sign-off lands; the refreshed ticket re-keys the read, which is slow
    let release!: () => void;
    db.hold = new Promise<void>((r) => { release = r; });
    db.results.ticket_review_slot_events = { data: [ev({ details: { via: "primary", examination: record() } })], error: null };
    const signed = { ...ASSURE, status: "satisfied" as const, satisfiedBy: "q-1", satisfiedAt: NOW, signatureId: "s", via: "primary" as const };
    await render(ticket(rosterOf([ACCEPT, CHECK, signed])), "x-9");
    expect(q("examination-not-recorded")).toBeNull();
    expect(q("examination-record")).toBeNull();
    await act(async () => { release(); db.hold = null; });
    await flush();
    expect(q("examination-not-recorded")).toBeNull();
    expect(q("examination-record")).not.toBeNull();
  });

  it("fix pass (review blocker): a veto note shortened from a long comment says so", async () => {
    db.results.ticket_review_slot_events = { data: [ev({ id: "v1", event: "voided", details: { reason: "request_revision", examination: record({ act: "veto", note: "long reason", noteTruncated: true }) } })], error: null };
    const closed = rosterOf([ACCEPT, CHECK, { ...ASSURE, status: "void" }], { closedAt: NOW, closedReason: "request_revision" });
    await render(ticket(closed, "REVISION_REQ"), "d-1");
    expect(q("examination-note")!.textContent).toBe("Note: long reason… (shortened — the full reason is the revision request's comment)");
  });

  it("a sign-off written before DF-P20 ({ via } only) reads 'Examination not recorded'", async () => {
    db.results.ticket_review_slot_events = { data: [ev({})], error: null };
    const signed = { ...ASSURE, status: "satisfied" as const, satisfiedBy: "q-1", satisfiedAt: NOW, signatureId: "s", via: "primary" as const };
    await render(ticket(rosterOf([ACCEPT, CHECK, signed])), "x-9");
    expect(q("examination-not-recorded")!.textContent).toBe(EXAMINATION_NOT_RECORDED);
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it("a ledger that cannot be read is said quietly (no alert); a ledger not there (42P01) shows nothing new", async () => {
    const signed = { ...ASSURE, status: "satisfied" as const, satisfiedBy: "q-1", satisfiedAt: NOW, signatureId: "s", via: "primary" as const };
    db.results.ticket_review_slot_events = { data: null, error: { code: "08006", message: "connection lost" } };
    await render(ticket(rosterOf([ACCEPT, CHECK, signed])), "x-9");
    expect(q("examination-unreadable")).not.toBeNull();
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it("a closed round's veto stays readable after the roster closed (REVISION_REQ): who sent it back, what they examined, why", async () => {
    db.results.ticket_review_slot_events = { data: [ev({ id: "v1", event: "voided", details: { reason: "request_revision", examination: record({ act: "veto", note: "dimension missing" }) } })], error: null };
    const closed = rosterOf([ACCEPT, CHECK, { ...ASSURE, status: "void" }], { closedAt: NOW, closedReason: "request_revision" });
    await render(ticket(closed, "REVISION_REQ"), "d-1");
    const hist = q("examination-history")!;
    expect(hist.textContent).toContain("Inspection check");
    expect(hist.textContent).toContain("revision requested by Quinn");
    expect(hist.textContent).toContain("Note: dimension missing");
  });

  it("examinationBody: every file → the full list (fix pass 2: chosen, not defaulted); a blank note → null", () => {
    expect(examinationBody(null, "  ", ["a", "b"])).toEqual({ files: ["a", "b"], note: null });
    expect(examinationBody(["a"], " n ", ["a", "b"])).toEqual({ files: ["a"], note: "n" });
  });

  it("fix pass 2 (review minor 1): a record made with no file list (the page's Request Revision) reads 'Files under review … the reviewer was not asked', never 'Examined'", async () => {
    db.results.ticket_review_slot_events = { data: [ev({ id: "v1", event: "voided", details: { reason: "request_revision", examination: record({ act: "veto", note: "why", allFiles: true, defaulted: true, files: [{ id: "a-d", name: "iso_1A.pdf", sha256: null }, { id: "a-e", name: "iso_1A_sh2.pdf", sha256: null }] }) } })], error: null };
    const closed = rosterOf([ACCEPT, CHECK, { ...ASSURE, status: "void" }], { closedAt: NOW, closedReason: "request_revision" });
    await render(ticket(closed, "REVISION_REQ"), "d-1");
    expect(q("examination-files")!.textContent).toBe("Files under review: all 2 (not narrowed — the reviewer was not asked): iso_1A.pdf, iso_1A_sh2.pdf");
  });

  it("fix pass 2 (review minor 4): an earlier round reads by the label the record carries once a new round's roster replaced it; a record without one falls back to the slot's key", async () => {
    db.results.ticket_review_slot_events = { data: [
      ev({ id: "v1", roster_id: "r-0", event: "voided", details: { reason: "request_revision", examination: record({ act: "veto", note: "dimension missing", slotLabel: "Inspection check" }) } }),
      ev({ id: "v0", roster_id: "r-00", slot_kind: "older", event: "voided", details: { reason: "request_revision", examination: record({ act: "veto", note: "earlier" }) } }),
    ], error: null };
    // round 1B is under review: roster r-1, the 1A roster r-0 is gone
    await render(ticket(rosterOf([ACCEPT, CHECK, ASSURE])), "x-9");
    const items = [...q("examination-history")!.querySelectorAll("li")].map((li) => li.querySelector("span")!.textContent);
    expect(items).toEqual(["Inspection check", "older"]);
  });
});

describe("REGRESSION — no assurance slot: nothing new is read or shown, every status and viewer", () => {
  const STATUSES: TicketStatus[] = ["PENDING_ENG_TEAM", "PENDING_ASSIGNMENT", "DRAFTING", "REVISION_REQ", "PENDING_REVIEW", "PENDING_IFC", "FINAL_DRAFT", "PENDING_FINAL_APPROVAL", "CLOSED", "CANCELED"];
  const VIEWERS = ["req-1", "d-1", "e-1", "a-1", "x-9"];
  it("a roster of the requester's acceptance and the engineering approval (open or closed), and a request with no roster: no ledger read, no examination markup", async () => {
    const plain = rosterOf([ACCEPT, { ...CHECK, status: "satisfied", satisfiedBy: "e-1", satisfiedAt: NOW, signatureId: "s", via: "primary" }]);
    for (const status of STATUSES) {
      for (const uid of VIEWERS) {
        for (const r of [plain, { ...plain, closedAt: NOW }, null]) {
          db.reads = [];
          await render(ticket(r, status), uid);
          expect(db.reads, `${status} ${uid}`).not.toContain("ticket_review_slot_events");
          expect(host.innerHTML, `${status} ${uid}`).not.toMatch(/data-testid="examination-/);
        }
      }
    }
  });
  it("fix pass 2 (review major): a blocking check WITHOUT the controller's opt-in — the configured rosters at the deploy — reads nothing new and shows its occupant nothing new, signed or open", async () => {
    const UNFLAGGED = { ...ASSURE, recordsExamination: undefined };
    const LEAD = slot({ id: "r-1:lead", kind: "lead", label: "Lead check", primaries: ["q-1", "q-3"] });
    const signed = { ...UNFLAGGED, status: "satisfied" as const, satisfiedBy: "q-1", satisfiedAt: NOW, signatureId: "s", via: "primary" as const };
    for (const r of [rosterOf([ACCEPT, CHECK, UNFLAGGED, LEAD]), rosterOf([ACCEPT, CHECK, signed, LEAD])]) {
      for (const uid of ["q-1", "q-3", "x-9"]) {
        db.reads = [];
        await render(ticket(r), uid);
        expect(db.reads, uid).not.toContain("ticket_review_slot_events");
        expect(host.innerHTML, uid).not.toMatch(/data-testid="examination-/);
      }
    }
  });

  it("a viewer who holds no assurance slot on an assured roster sees the roster as before — no form, no 'Request revision' of the panel's", async () => {
    for (const uid of ["req-1", "e-1", "d-1", "x-9"]) {
      await render(ticket(rosterOf([ACCEPT, CHECK, ASSURE, WATCH])), uid);
      expect(q("examination-form"), uid).toBeNull();
      expect(q("examination-veto"), uid).toBeNull();
    }
  });
  it("fix pass (review major 3): a consent-window slot is not an assurance slot — open, its occupant sees no form; advanced by silence, nothing is read and nothing reads 'Examination not recorded'", async () => {
    const CONSENT = slot({ id: "r-1:consent", kind: "consent", label: "Operations consent", mode: "consent_window", primaries: ["c-1"] });
    for (const s2 of [CONSENT, { ...CONSENT, status: "satisfied" as const, satisfiedAt: NOW, via: "consent" as const }]) {
      for (const uid of ["c-1", "x-9", "d-1"]) {
        db.reads = [];
        await render(ticket(rosterOf([ACCEPT, CHECK, s2])), uid);
        expect(db.reads, uid).not.toContain("ticket_review_slot_events");
        expect(host.innerHTML, uid).not.toMatch(/data-testid="examination-/);
      }
    }
  });

  it("the notify-only slot's occupant has no form (no sign-off, no veto of the panel's) — told, as before", async () => {
    await render(ticket(rosterOf([ACCEPT, CHECK, ASSURE, WATCH])), "q-2");
    expect(q("examination-form")).toBeNull();
    expect(host.textContent).toContain("Told — 1 person");
  });
});
