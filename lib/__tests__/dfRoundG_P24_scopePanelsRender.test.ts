// @vitest-environment jsdom
// drafting-flow Round G, DF-P24 — the two screens, rendered:
//   * ExaminationScopePanel (request page): renders NOTHING and reads NOTHING
//     in a workspace that configured no examination data (every status,
//     every viewer — today's page); configured, it says what an issue needs
//     before anyone tries, lets the drafter pick from the list (never typed),
//     shows an in-flight request's warning, a waiver, and — before 20261266 —
//     that nothing can be recorded yet;
//   * ExaminationScopeSection (Admin → Request forms): edits the fields and
//     requirements into the page's settings (the page's own Save stores
//     them; a new requirement carries no time until that save stamps it);
//   * both are mounted where the plan puts them (source pins).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const db = vi.hoisted(() => ({ results: {} as Record<string, { data: unknown; error: unknown }>, reads: [] as string[] }));
vi.mock("@/lib/supabase", () => {
  const chain = (table: string): unknown => {
    db.reads.push(table);
    const c: Record<string, unknown> = {};
    const p: ProxyHandler<Record<string, unknown>> = {
      get(_t, prop: string) {
        if (prop === "then") return (resolve: (v: unknown) => void) => resolve(db.results[table] ?? { data: [], error: null });
        if (prop === "maybeSingle" || prop === "single") return () => Promise.resolve(db.results[`${table}:single`] ?? { data: null, error: null });
        return () => new Proxy(c, p);
      },
    };
    return new Proxy(c, p);
  };
  return { supabase: { from: (t: string) => chain(t), auth: { getSession: async () => ({ data: { session: { access_token: "tok" } } }) } } };
});

import ExaminationScopePanel from "@/components/requests/ExaminationScopePanel";
import ExaminationScopeSection from "@/components/requests/ExaminationScopeSection";
import type { OrgDraftingSettings, Ticket, TicketStatus } from "@/types/schema";

const LIB = "1b000000-0000-4000-8000-000000000001";
const SINCE = "2026-10-01T00:00:00.000Z";
const CFG = {
  requestTypes: { options: [] }, units: { options: [] }, priorities: { options: [] },
  examinationScope: {
    fields: [{ key: "exam", label: "Examination scope", options: [{ value: "rt5", label: "5% RT" }, { value: "rt100", label: "100% RT" }] }],
    requirements: [{ field: "exam", libraryId: LIB, since: SINCE }],
  },
} as unknown as OrgDraftingSettings;
const T = (over: Partial<Ticket> = {}) => ({
  id: "7e000000-0000-4000-8000-000000000001", orgId: "o1", ticketId: "REQ-1", title: "x", status: "PENDING_REVIEW", requestType: "ISO",
  requesterId: "req-1", assignedDrafterId: "d-1", assignedEngineerId: "e-1", libraryId: LIB, createdAt: "2026-10-05T00:00:00.000Z",
  deliverableRev: "1A", metadata: {}, history: [], comments: [], attachments: [], ...over,
}) as unknown as Ticket;

let host: HTMLDivElement;
let root: Root;
const fetches: Array<{ url: string; body: unknown }> = [];
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  db.results = {};
  db.reads = [];
  fetches.length = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { body?: string }) => {
    fetches.push({ url, body: init?.body ? JSON.parse(init.body) : null });
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  }));
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const render = async (el: React.ReactElement) => { await act(async () => { root.render(el); }); await act(async () => { await Promise.resolve(); }); };
const panel = (over: Record<string, unknown> = {}) => React.createElement(ExaminationScopePanel, { ticket: T(), draftingCfg: CFG, uid: "d-1", role: "Drafter", roles: ["Drafter"], capPolicy: null, issuing: false, ...over } as never);

describe("ExaminationScopePanel — unconfigured: nothing rendered, nothing read (today's page)", () => {
  it("every status x every viewer, with no configuration or a configuration with nothing to pick", async () => {
    const statuses: TicketStatus[] = ["NEW" as TicketStatus, "PENDING_ASSIGNMENT", "DRAFTING", "PENDING_REVIEW", "PENDING_IFC", "PENDING_FINAL_APPROVAL", "CLOSED", "CANCELED"];
    const cfgs = [null, { requestTypes: { options: [] } }, { examinationScope: { fields: [{ key: "a", label: "A", options: [] }], requirements: [{ field: "a", libraryId: LIB, since: SINCE }] } }];
    for (const cfg of cfgs) for (const status of statuses) for (const uid of ["req-1", "d-1", "e-1", "a-1", "q-1", null]) {
      await render(panel({ ticket: T({ status }), draftingCfg: cfg, uid, issuing: uid === "a-1" }));
      expect(host.innerHTML, `${status} ${uid}`).toBe("");
    }
    expect(db.reads).toEqual([]);
  });
});

describe("ExaminationScopePanel — configured", () => {
  it("says what an issue needs before anyone tries; the drafter picks from the list and records it", async () => {
    await render(panel());
    expect(host.querySelector('[data-testid="examination-scope-blocking"]')?.textContent).toMatch(/Needed before this request can issue: Examination scope\. Pick each below\./);
    const select = host.querySelector('select[aria-label="Examination scope"]') as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(["", "rt5", "rt100"]);
    await act(async () => { select.value = "rt5"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    const record = [...host.querySelectorAll("button")].find((b) => b.textContent === "Record")!;
    await act(async () => { record.click(); });
    expect(fetches[0]).toEqual({ url: "/api/tickets/examination-scope", body: { ticketId: "7e000000-0000-4000-8000-000000000001", values: { exam: "rt5" } } });
  });
  it("a viewer outside the flow sees it read-only (no list, no Record) — the drafter or the engineer records it", async () => {
    await render(panel({ uid: "q-1", role: "Viewer", roles: ["Viewer"] }));
    expect(host.querySelector("select")).toBeNull();
    expect(host.textContent).toMatch(/The drafter or the engineer records it here/);
  });
  it("a request filed before the requirement warns and is never told it cannot issue", async () => {
    await render(panel({ ticket: T({ createdAt: "2026-09-01T00:00:00.000Z" }) }));
    expect(host.querySelector('[data-testid="examination-scope-blocking"]')).toBeNull();
    expect(host.querySelector('[data-testid="examination-scope-warning"]')?.textContent).toMatch(/filed before the requirement was set, so it can still issue/);
  });
  it("someone who can issue it may record why it issues without it; a recorded waiver is shown", async () => {
    await render(panel({ uid: "a-1", role: "Admin", roles: ["Admin"], issuing: true }));
    const open = [...host.querySelectorAll("button")].find((b) => b.textContent === "Issue without it — record why")!;
    await act(async () => { open.click(); });
    const ta = host.querySelector("textarea") as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    await act(async () => { setter.call(ta, "Vendor report to follow"); ta.dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => { [...host.querySelectorAll("button")].find((b) => b.textContent === "Record why")!.click(); });
    expect(fetches[0].body).toEqual({ ticketId: "7e000000-0000-4000-8000-000000000001", waiver: { reason: "Vendor report to follow" } });
    db.results["ticket_examination_scopes:single"] = { data: { field_values: {}, waiver: { reason: "Vendor report to follow", byName: "Ann", at: SINCE, fields: ["exam"], rev: "1A" } }, error: null };
    await render(panel({ ticket: T({ lastModified: "x" } as never), uid: "q-1", role: "Viewer", roles: ["Viewer"] }));
    expect(host.querySelector('[data-testid="examination-scope-waived"]')?.textContent).toMatch(/Issues without Examination scope — recorded by Ann/);
  });
  it("before 20261266: says nothing can be recorded yet (and nothing is required)", async () => {
    db.results["ticket_examination_scopes:single"] = { data: null, error: { code: "42P01", message: "relation does not exist" } };
    await render(panel());
    expect(host.querySelector('[data-testid="examination-scope-not-migrated"]')?.textContent).toMatch(/database update 20261266 is not applied/);
  });
});

describe("ExaminationScopeSection — the editor", () => {
  it("adds a field and a requirement into the page's settings (no time until the page's save stamps it)", async () => {
    const patches: Array<Record<string, unknown>> = [];
    await render(React.createElement(ExaminationScopeSection, { settings: { requestTypes: { options: [] } } as never, orgId: null, onChange: (p: Record<string, unknown>) => patches.push(p) } as never));
    expect(host.textContent).toMatch(/applies only to requests filed after you save it/);
    await act(async () => { [...host.querySelectorAll("button")].find((b) => b.textContent === "Add data")!.click(); });
    expect(patches[0]).toEqual({ examinationScope: { fields: [{ key: "", label: "", options: [] }], requirements: [] } });
    await render(React.createElement(ExaminationScopeSection, { settings: CFG, orgId: null, onChange: (p: Record<string, unknown>) => patches.push(p) } as never));
    expect(host.textContent).toMatch(/applies to requests filed from/);
    await act(async () => { [...host.querySelectorAll("button")].find((b) => b.textContent === "Add requirement")!.click(); });
    const last = patches[patches.length - 1] as { examinationScope: { requirements: Array<Record<string, unknown>> } };
    expect(last.examinationScope.requirements).toEqual([{ field: "exam", libraryId: LIB, since: SINCE }, { field: "" }]);
  });
});

describe("mounted where the plan puts them", () => {
  const src = (f: string) => readFileSync(join(process.cwd(), f), "utf8");
  it("the request page mounts the panel only when the workspace configured examination data", () => {
    expect(src("app/(protected)/requests/[id]/page.tsx")).toMatch(/\{examinationScopeConfigured\(parseExaminationScopeConfig\(draftingCfg\)\) && <div [^>]*><ExaminationScopePanel ticket=\{ticket\} draftingCfg=\{draftingCfg\}/);
  });
  it("Admin → Request forms mounts the section and stamps new requirements at its own Save", () => {
    const page = src("app/(protected)/admin/requests/page.tsx");
    expect(page).toMatch(/<ExaminationScopeSection settings=\{settings\} orgId=\{activeOrgId\} onChange=/);
    expect(page).toMatch(/const data = withNormalizedOutcomeReasons\(stampExaminationScope\(settings, new Date\(\)\.toISOString\(\)\)\);/);
  });
});
