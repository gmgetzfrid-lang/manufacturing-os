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
}));
vi.mock("@/lib/supabase", () => {
  const chain = (table: string): unknown => {
    db.reads.push(table);
    const res = () => db.results[table] ?? { data: [], error: null };
    const c: Record<string, unknown> = {};
    const p: ProxyHandler<Record<string, unknown>> = {
      get(_t, prop: string) {
        if (prop === "then") return (resolve: (v: unknown) => void) => resolve(res());
        if (prop === "maybeSingle" || prop === "single") return () => Promise.resolve({ data: Array.isArray(res().data) ? (res().data as unknown[])[0] ?? null : res().data, error: res().error });
        return () => new Proxy(c, p);
      },
    };
    return new Proxy(c, p);
  };
  return { supabase: { from: (t: string) => chain(t), auth: { getSession: async () => ({ data: { session: { access_token: "tok" } } }) } } };
});
vi.mock("@/lib/search", () => ({ lookupTag: vi.fn(async () => []) }));

import TriageClassSelects from "@/components/requests/TriageClassSelects";
import DeclarationCard from "@/components/requests/DeclarationCard";
import ConsentBlockNotice from "@/components/requests/ConsentBlockNotice";
import ReviewClassesSection from "@/components/requests/ReviewClassesSection";
import type { OrgDraftingSettings, Ticket } from "@/types/schema";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  db.results = {}; db.reads = [];
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
    db.results.ticket_notice_events = { data: [{ created_at: "2026-10-21T09:00:00Z", slot_kind: "ops", actor_name: "x", details: { reason: "window_not_opened", error: "insert failed" } }], error: null };
    const onRows = vi.fn();
    await render(el(ConsentBlockNotice, { ticketId: "t1", roster: { id: "r1", slots: [{ kind: "ops", label: "Operations", mode: "consent_window" }] } as never, onRows }));
    expect(host.querySelector('[data-testid="consent-block-notice"]')?.textContent).toMatch(/"Operations": the consent window could not be opened — the people it asks could not all be told \(insert failed\)/);
    expect(onRows).toHaveBeenLastCalledWith([expect.objectContaining({ slot_kind: "ops" })]);
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
