// @vitest-environment jsdom
//
// drafting-flow Round G, DF-P18 — the new controls as RENDERED, each pinned
// to DEC-90 ruling (1) for DF-P18: an unconfigured workspace sees exactly
// today's screen (no select, no flag, no notice, no checkbox), and the
// control appears only where configuration asks for it.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const db = vi.hoisted(() => ({
  results: {} as Record<string, { data: unknown; error: null | { code?: string; message: string } }>,
  reads: [] as string[],
  // DF-P18 fix pass: a table whose read never answers (the loading state).
  hang: [] as string[],
}));
vi.mock("@/lib/supabase", () => {
  const chain = (table: string): unknown => {
    db.reads.push(table);
    const res = () => db.results[table] ?? { data: [], error: null };
    const c: Record<string, unknown> = {};
    const p: ProxyHandler<Record<string, unknown>> = {
      get(_t, prop: string) {
        if (prop === "then") return (resolve: (v: unknown) => void) => { if (!db.hang.includes(table)) resolve(res()); };
        if (prop === "maybeSingle" || prop === "single") return () => Promise.resolve({ data: Array.isArray(res().data) ? (res().data as unknown[])[0] ?? null : res().data, error: res().error });
        return () => new Proxy(c, p);
      },
    };
    return new Proxy(c, p);
  };
  return { supabase: { from: (t: string) => chain(t), auth: { getSession: async () => ({ data: { session: { access_token: "tok" } } }) } } };
});
vi.mock("@/lib/search", () => ({ lookupTag: vi.fn(async () => []) }));
// DF-P18 fix pass (review blocker): the roster panel's dry run, rendered.
const dlg = vi.hoisted(() => ({ confirm: vi.fn(async () => true) }));
vi.mock("@/components/providers/DialogProvider", () => ({ appConfirm: dlg.confirm, appAlert: vi.fn(async () => {}), appPrompt: vi.fn(async () => null) }));
vi.mock("@/lib/eSignatures", () => ({ recordSignature: vi.fn(async () => ({ id: "sig-1" })) }));
vi.mock("@/lib/reviewControl", () => ({ effectiveReviewControlForDocument: vi.fn(async () => null), expandReviewers: vi.fn(async () => ({ primaries: [] })) }));
vi.mock("@/components/signatures/SignatureCeremony", () => ({ default: () => React.createElement("div", { "data-testid": "ceremony" }) }));

import TriageClassSelects from "@/components/requests/TriageClassSelects";
import DeclarationCard from "@/components/requests/DeclarationCard";
import ConsentBlockNotice from "@/components/requests/ConsentBlockNotice";
import ReviewClassesSection from "@/components/requests/ReviewClassesSection";
import TicketRosterPanel from "@/components/requests/TicketRosterPanel";
import type { OrgDraftingSettings, Ticket } from "@/types/schema";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  db.results = {}; db.reads = []; db.hang = [];
  dlg.confirm.mockReset(); dlg.confirm.mockResolvedValue(true);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });
const el = React.createElement as unknown as (t: unknown, p: Record<string, unknown>) => React.ReactElement;
const render = async (node: React.ReactElement) => { await act(async () => { root.render(node); }); await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

const TICKET = {
  id: "t1", orgId: "o1", ticketId: "R-1", title: "x", status: "DRAFTING", requestType: "ISO", unit: null,
  requesterId: "req", assignedDrafterId: "d", attachments: [], history: [], metadata: {}, engineeringRequired: undefined,
} as unknown as Ticket;

describe("TriageClassSelects", () => {
  it("REGRESSION: nothing renders for an unconfigured workspace", async () => {
    await render(el(TriageClassSelects, { offered: { work: false, code: false }, workOptions: [], codeOptions: [], current: {}, value: { workClass: "", codeClass: "" }, onChange: () => {} }));
    expect(host.innerHTML).toBe("");
  });
  it("one select per configured list, defaulting to No change", async () => {
    await render(el(TriageClassSelects, { offered: { work: true, code: false }, workOptions: [{ value: "pipe", label: "Piping", engineering: true }], codeOptions: [], current: { workClass: null }, value: { workClass: "", codeClass: "" }, onChange: () => {} }));
    const sel = host.querySelector('[data-testid="triage-work-class"]') as HTMLSelectElement;
    expect(sel).not.toBeNull();
    expect(sel.value).toBe("");
    expect(host.querySelector('[data-testid="triage-code-class"]')).toBeNull();
    expect(sel.textContent).toMatch(/Piping — requires engineering/);
  });
});

describe("DeclarationCard — the equipment control (GAP-312, ruling (4))", () => {
  it("REGRESSION: a viewer who may not edit sees the card exactly as before (nothing, for a ticket with nothing to say)", async () => {
    await render(el(DeclarationCard, { ticket: TICKET }));
    expect(host.innerHTML).toBe("");
  });
  it("a participant gets 'Add equipment'", async () => {
    await render(el(DeclarationCard, { ticket: TICKET, canEditEquipment: true }));
    expect(host.querySelector('[data-testid="equipment-add"]')).not.toBeNull();
  });
  it("before 20261251 the control says the list is not available", async () => {
    db.results.ticket_equipment = { data: null, error: { code: "42P01", message: 'relation "ticket_equipment" does not exist' } };
    await render(el(DeclarationCard, { ticket: TICKET, canEditEquipment: true }));
    expect(host.querySelector('[data-testid="equipment-add"]')).toBeNull();
    expect(host.querySelector('[data-testid="equipment-not-available"]')?.textContent).toMatch(/not available yet/);
  });
  it("DF-P18 fix pass (review minor): while the equipment read is in flight, a participant of an unconfigured request sees nothing (no empty card)", async () => {
    db.hang = ["ticket_equipment"];
    await render(el(DeclarationCard, { ticket: TICKET, canEditEquipment: true }));
    expect(host.innerHTML).toBe("");
  });
  it("DF-P18 fix pass (review minor): exactly what an UNCONFIGURED workspace's participant sees once the read answers — the card holding only 'Add equipment' (ruling (4) adds this control in every workspace); before 20261251, only the not-available sentence", async () => {
    await render(el(DeclarationCard, { ticket: TICKET, canEditEquipment: true }));
    const card = host.querySelector('[data-testid="declaration-card"]')!;
    expect(card).not.toBeNull();
    expect(card.querySelector('[data-testid="engineering-line"]')).toBeNull();
    expect(card.querySelector('[data-testid="review-classes"]')).toBeNull();
    expect(card.querySelector('[data-testid="request-equipment"]')).toBeNull();
    expect(card.querySelector('[role="alert"]')).toBeNull();
    expect(card.children).toHaveLength(1);
    expect(card.textContent).toBe("Add equipment");
    db.results.ticket_equipment = { data: null, error: { code: "42P01", message: 'relation "ticket_equipment" does not exist' } };
    act(() => root.unmount());
    root = createRoot(host);
    await render(el(DeclarationCard, { ticket: TICKET, canEditEquipment: true }));
    const before = host.querySelector('[data-testid="declaration-card"]')!;
    expect(before.children).toHaveLength(1);
    expect(before.textContent).toMatch(/^The equipment list is not available yet \(database update 20261251 is not applied\)/);
  });
  it("a listed tag offers Correct to a participant, not to anyone else", async () => {
    db.results.ticket_equipment = { data: [{ id: "e1", tag: "P-1O1", asset_id: null }], error: null };
    await render(el(DeclarationCard, { ticket: TICKET, canEditEquipment: true }));
    expect(host.querySelector('[data-testid="equipment-correct"]')).not.toBeNull();
    await render(el(DeclarationCard, { ticket: TICKET }));
    expect(host.querySelector('[data-testid="equipment-correct"]')).toBeNull();
    expect(host.textContent).toMatch(/P-1O1/);
  });
});

describe("ConsentBlockNotice (GAP-113 acceptance 1, ruling (6))", () => {
  it("REGRESSION: a request with no consent slot renders nothing and reads nothing", async () => {
    await render(el(ConsentBlockNotice, { ticketId: "t1", roster: { slots: [{ kind: "check", mode: "blocking" }] } as never }));
    expect(host.innerHTML).toBe("");
    expect(db.reads).not.toContain("ticket_notice_events");
  });
  it("a failed open is said, in words, with the slot's label; the rows go to the page's history", async () => {
    db.results.ticket_notice_events = { data: [{ created_at: "2026-10-21T09:00:00Z", roster_id: "r1", slot_kind: "ops", actor_name: "x", details: { reason: "window_not_opened", error: "insert failed" } }], error: null };
    const onRows = vi.fn();
    await render(el(ConsentBlockNotice, { ticketId: "t1", roster: { id: "r1", slots: [{ kind: "ops", label: "Operations", mode: "consent_window" }] } as never, onRows }));
    expect(host.querySelector('[data-testid="consent-block-notice"]')?.textContent).toMatch(/"Operations": the consent window could not be opened — the people it asks could not all be told \(insert failed\)/);
    expect(onRows).toHaveBeenLastCalledWith([expect.objectContaining({ slot_kind: "ops" })]);
  });
  it("DF-P18 fix pass (review major): a failed open the maintenance run later opened is no longer said (the history keeps it, marked 'opened later'); another roster's blocks are dropped; read newest first, this roster only", async () => {
    const notOpened = { created_at: "2026-10-21T09:00:00Z", roster_id: "r1", slot_kind: "ops", actor_name: "x", details: { reason: "window_not_opened", error: "insert failed", retriedByMaintenance: true } };
    const oldRoster = { created_at: "2026-10-20T09:00:00Z", roster_id: "r0", slot_kind: "ops", actor_name: "x", details: { reason: "no_longer_member" } };
    db.results.ticket_notice_events = { data: [notOpened, oldRoster], error: null };
    const onRows = vi.fn();
    const slots = [{ kind: "ops", label: "Operations", mode: "consent_window" }];
    const plan = { slot: "ops", label: "Operations", recipients: ["a"], windowDays: 3, warnFraction: 0.5 };
    // Still not opened: said (and the earlier roster's row is not).
    await render(el(ConsentBlockNotice, { ticketId: "t1", roster: { id: "r1", slots, consentPlan: { kind: "open", ...plan } } as never, onRows }));
    const notice = host.querySelector('[data-testid="consent-block-notice"]')!;
    expect(notice.textContent).toMatch(/could not be opened/);
    expect(notice.textContent).not.toMatch(/nobody who could object/);
    expect(onRows).toHaveBeenLastCalledWith([expect.objectContaining({ roster_id: "r1" })]);
    // The maintenance run opened it: the notice clears, the history says so.
    const opened = { id: "r1", slots, consentPlan: { kind: "opened", ...plan } };
    await render(el(ConsentBlockNotice, { ticketId: "t1", roster: opened as never, onRows }));
    expect(host.innerHTML).toBe("");
    const { consentBlockHistoryEntries } = await import("@/lib/requestPageReview");
    const [entry] = consentBlockHistoryEntries([notOpened], () => "Operations", opened as never);
    expect(entry.action).toBe("Consent window not opened (opened later)");
    expect(entry.details).toMatch(/The maintenance run opened the window later; this no longer holds\./);
    // The query: this roster, newest first before the cap.
    const src = (await import("node:fs")).readFileSync((await import("node:path")).join(process.cwd(), "components", "requests", "ConsentBlockNotice.tsx"), "utf8");
    expect(src).toContain('if (rosterId) q = q.eq("roster_id", rosterId);');
    expect(src).toContain('.order("created_at", { ascending: false })');
  });
  it("DF-P18 fix pass 2 (review major): once the consent slot is signed, or the roster has closed and the request moved on, the notice says nothing; the history marks why", async () => {
    const blocked = { created_at: "2026-10-21T09:00:00Z", roster_id: "r1", slot_kind: "ops", actor_name: "x", details: { reason: "window_never_opened", why: "nobody may be asked" } };
    db.results.ticket_notice_events = { data: [blocked], error: null };
    const slot = { kind: "ops", label: "Operations", mode: "consent_window", status: "open" };
    // Still waiting: said.
    await render(el(ConsentBlockNotice, { ticketId: "t1", roster: { id: "r1", slots: [slot] } as never, ticketStatus: "PENDING_REVIEW" }));
    expect(host.querySelector('[data-testid="consent-block-notice"]')?.textContent).toMatch(/never opened — nobody may be asked/);
    // A reviewer signed the slot: nothing said.
    await render(el(ConsentBlockNotice, { ticketId: "t1", roster: { id: "r1", slots: [{ ...slot, status: "satisfied" }] } as never, ticketStatus: "PENDING_REVIEW" }));
    expect(host.innerHTML).toBe("");
    // The roster completed and the request moved on: nothing said.
    const closed = { id: "r1", slots: [{ ...slot, status: "satisfied" }], closedAt: "2026-10-22T00:00:00Z" };
    await render(el(ConsentBlockNotice, { ticketId: "t1", roster: closed as never, ticketStatus: "FINAL_DRAFT" }));
    expect(host.innerHTML).toBe("");
    // A closed roster with the slot never signed (e.g. the request was sent back): nothing said either.
    await render(el(ConsentBlockNotice, { ticketId: "t1", roster: { id: "r1", slots: [slot], closedAt: "2026-10-22T00:00:00Z" } as never, ticketStatus: "DRAFTING" }));
    expect(host.innerHTML).toBe("");
    const { consentBlockHistoryEntries } = await import("@/lib/requestPageReview");
    expect(consentBlockHistoryEntries([blocked], () => "Operations", closed as never, "FINAL_DRAFT")[0].action).toBe("Consent window not opened (signed later)");
    // The page passes the request's status to the notice and the history.
    const page = (await import("node:fs")).readFileSync((await import("node:path")).join(process.cwd(), "app", "(protected)", "requests", "[id]", "page.tsx"), "utf8");
    expect(page).toContain("ticketStatus={ticket.status} onRows={setConsentBlockRows}");
    expect(page).toContain("rosterRecord, ticket.status)]");
  });
  it("before 20261255 (no table) nothing is said", async () => {
    db.results.ticket_notice_events = { data: null, error: { code: "42P01", message: 'relation "ticket_notice_events" does not exist' } };
    await render(el(ConsentBlockNotice, { ticketId: "t1", roster: { id: "r1", slots: [{ kind: "ops", mode: "consent_window" }] } as never }));
    expect(host.innerHTML).toBe("");
  });
});

describe("ReviewClassesSection — the flags on a work class (TIER-7 / TIER-6)", () => {
  it("ticking 'Minor correction' and 'Needs MOC' writes the flags and keeps the rest; a code class shows neither", async () => {
    const onChange = vi.fn();
    const settings = { workClasses: { options: [{ value: "a", label: "A", engineering: true }] }, codeClasses: { options: [{ value: "c", label: "C" }] } } as unknown as OrgDraftingSettings;
    await render(el(ReviewClassesSection, { settings, onChange }));
    const work = host.querySelector('[data-testid="review-classes-workClasses"]')!;
    const code = host.querySelector('[data-testid="review-classes-codeClasses"]')!;
    expect(code.querySelector('[data-testid="review-class-minor-correction"]')).toBeNull();
    await act(async () => { (work.querySelector('[data-testid="review-class-minor-correction"]') as HTMLInputElement).click(); });
    expect(onChange).toHaveBeenLastCalledWith({ workClasses: { options: [{ value: "a", label: "A", engineering: true, minorCorrection: true }] } });
    await act(async () => { (work.querySelector('[data-testid="review-class-moc"]') as HTMLInputElement).click(); });
    expect(onChange).toHaveBeenLastCalledWith({ workClasses: { options: [{ value: "a", label: "A", engineering: true, moc: true }] } });
  });
});

describe("TicketRosterPanel — a moved source only the route can see (DF-P18 fix pass, review blocker)", () => {
  const NOW = "2026-10-21T12:00:00.000Z";
  const roster = {
    v: 1, id: "r-1", openedAt: NOW, openedBy: "d-1", level: "library", cycle: "1A", contentHash: "h".repeat(64),
    files: [{ id: "a-d", name: "iso_1A.pdf", url: "u", sha256: "f".repeat(64) }],
    slots: [{ id: "r-1:accept", kind: "accept", label: "Requester acceptance", mode: "blocking", primaries: ["req-1"], alternates: [], overriders: [], independentOf: [], timeoutDays: null, fallback: false, status: "open" }],
  };
  const ticket = { ...TICKET, status: "PENDING_REVIEW", requesterId: "req-1", assignedDrafterId: "d-1", libraryId: null, metadata: { review_roster: roster } } as unknown as Ticket;
  const LABEL = "P-101 raised on Rev 3, now Rev 4";
  afterEach(() => { vi.unstubAllGlobals(); });
  it("the panel had no labels (the page could not read the sheet): the dry run's 409 names the move, the viewer is asked from those labels, and the dry run is sent once more with the acknowledgement — the ceremony opens", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
      const b = JSON.parse(init.body) as Record<string, unknown>;
      bodies.push(b);
      if (b.sourceDriftAcknowledged === true) return new Response(JSON.stringify({ ok: true, dryRun: true }), { status: 200 });
      return new Response(JSON.stringify({ error: "moved", code: "source_drift_unacknowledged", moved: [LABEL] }), { status: 409 });
    });
    vi.stubGlobal("fetch", fetchMock);
    await render(el(TicketRosterPanel, { ticket, orgId: "o1", uid: "req-1", activeMemberCount: 5 }));
    expect(host.querySelector('[data-testid="roster-source-drift"]')).toBeNull(); // nothing known yet
    const btn = [...host.querySelectorAll("button")].find((b) => /Sign off/.test(b.textContent ?? ""))!;
    await act(async () => { btn.click(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toMatchObject({ actionType: "sign_slot", dryRun: true });
    expect(bodies[0].sourceDriftAcknowledged).toBeUndefined();
    expect(bodies[1]).toMatchObject({ actionType: "sign_slot", dryRun: true, sourceDriftAcknowledged: true });
    expect(dlg.confirm).toHaveBeenCalledTimes(1);
    expect(String((dlg.confirm.mock.calls[0] as unknown as [{ message: string }])[0].message)).toContain(LABEL);
    expect(host.querySelector('[data-testid="ceremony"]')).not.toBeNull();
    const ack = host.querySelector('[data-testid="roster-source-drift"] input') as HTMLInputElement;
    expect(ack.checked).toBe(true);
    expect(host.querySelector('[data-testid="roster-source-drift"]')!.textContent).toContain(LABEL);
  });
  it("declining the acknowledgement sends nothing more and opens no ceremony", async () => {
    dlg.confirm.mockResolvedValue(false);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: "moved", code: "source_drift_unacknowledged", moved: [LABEL] }), { status: 409 }));
    vi.stubGlobal("fetch", fetchMock);
    await render(el(TicketRosterPanel, { ticket, orgId: "o1", uid: "req-1", activeMemberCount: 5 }));
    const btn = [...host.querySelectorAll("button")].find((b) => /Sign off/.test(b.textContent ?? ""))!;
    await act(async () => { btn.click(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[data-testid="ceremony"]')).toBeNull();
  });
  it("REGRESSION: an unmoved source — one dry run, no question, the ceremony opens", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, dryRun: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await render(el(TicketRosterPanel, { ticket, orgId: "o1", uid: "req-1", activeMemberCount: 5 }));
    const btn = [...host.querySelectorAll("button")].find((b) => /Sign off/.test(b.textContent ?? ""))!;
    await act(async () => { btn.click(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(dlg.confirm).not.toHaveBeenCalled();
    expect(host.querySelector('[data-testid="ceremony"]')).not.toBeNull();
  });
});
