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
//     them; a new requirement carries no time until the database stamps it
//     at that save — 20261266, second fix pass);
//   * second fix pass: the requester picks values while the request is
//     still with the drafter (GAP-102 acceptance 1), never once it is under
//     review; an issued request's data is read-only (no list, no waiver);
//   * both are mounted where the plan puts them (source pins).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const db = vi.hoisted(() => ({ results: {} as Record<string, { data: unknown; error: unknown }>, reads: [] as string[], mayWaive: false }));
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
/** The writes the panel sent (its GET — may this viewer waive? — left out). */
const posts = () => fetches.filter((f) => f.body !== null);
const gets = () => fetches.filter((f) => f.body === null);
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  db.results = {};
  db.reads = [];
  db.mayWaive = false;
  fetches.length = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { body?: string }) => {
    fetches.push({ url, body: init?.body ? JSON.parse(init.body) : null });
    if (!init?.body) return { ok: true, status: 200, json: async () => ({ mayWaive: db.mayWaive }) };
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  }));
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const render = async (el: React.ReactElement) => { await act(async () => { root.render(el); }); for (let i = 0; i < 3; i++) await act(async () => { await Promise.resolve(); }); };
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
    expect(fetches).toEqual([]);
  });
});

describe("ExaminationScopePanel — configured", () => {
  it("says what an issue needs before anyone tries; the drafter picks from the list and records it", async () => {
    await render(panel({ ticket: T({ status: "DRAFTING" }) }));
    expect(host.querySelector('[data-testid="examination-scope-blocking"]')?.textContent).toMatch(/Needed before this request can issue: Examination scope\. Pick each below\./);
    const select = host.querySelector('select[aria-label="Examination scope"]') as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(["", "rt5", "rt100"]);
    await act(async () => { select.value = "rt5"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    const record = [...host.querySelectorAll("button")].find((b) => b.textContent === "Record")!;
    await act(async () => { record.click(); });
    expect(posts()[0]).toEqual({ url: "/api/tickets/examination-scope", body: { ticketId: "7e000000-0000-4000-8000-000000000001", values: { exam: "rt5" } } });
  });
  it("a viewer outside the flow sees it read-only (no list, no Record) — the drafter or the engineer records it (in review: its engineer of record)", async () => {
    await render(panel({ ticket: T({ status: "DRAFTING" }), uid: "q-1", role: "Viewer", roles: ["Viewer"] }));
    expect(host.querySelector("select")).toBeNull();
    expect(host.textContent).toMatch(/The drafter or the engineer records it here/);
    await render(panel({ uid: "q-1", role: "Viewer", roles: ["Viewer"] }));
    expect(host.querySelector("select")).toBeNull();
    expect(host.textContent).toMatch(/Its engineer of record records it here/);
  });
  it("a request filed before the requirement warns and is never told it cannot issue", async () => {
    await render(panel({ ticket: T({ createdAt: "2026-09-01T00:00:00.000Z" }) }));
    expect(host.querySelector('[data-testid="examination-scope-blocking"]')).toBeNull();
    expect(host.querySelector('[data-testid="examination-scope-warning"]')?.textContent).toMatch(/filed before the requirement was set, so it can still issue/);
  });
  it("someone who can issue it may record why it issues without it; a recorded waiver is shown", async () => {
    db.mayWaive = true;
    await render(panel({ uid: "a-1", role: "Admin", roles: ["Admin"], issuing: true }));
    expect(gets()[0].url).toBe("/api/tickets/examination-scope?ticketId=7e000000-0000-4000-8000-000000000001");
    const open = [...host.querySelectorAll("button")].find((b) => b.textContent === "Issue without it — record why")!;
    await act(async () => { open.click(); });
    const ta = host.querySelector("textarea") as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    await act(async () => { setter.call(ta, "Vendor report to follow"); ta.dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => { [...host.querySelectorAll("button")].find((b) => b.textContent === "Record why")!.click(); });
    expect(posts()[0].body).toEqual({ ticketId: "7e000000-0000-4000-8000-000000000001", waiver: { reason: "Vendor report to follow" } });
    db.results["ticket_examination_scopes:single"] = { data: { field_values: {}, waiver: { reason: "Vendor report to follow", byName: "Ann", at: SINCE, fields: ["exam"], rev: "1A" } }, error: null };
    await render(panel({ ticket: T({ lastModified: "x" } as never), uid: "q-1", role: "Viewer", roles: ["Viewer"] }));
    expect(host.querySelector('[data-testid="examination-scope-waived"]')?.textContent).toMatch(/Issues without Examination scope — recorded by Ann/);
  });
  it("second fix pass: the requester picks values while the request is with the drafter (a like-in-kind request's engineer records what they specified) — not once it is under review", async () => {
    const lik = T({ status: "DRAFTING", engineeringRequired: false, assignedEngineerId: null } as never);
    await render(panel({ ticket: lik, uid: "req-1", role: "Requester", roles: ["Requester"] }));
    expect(host.querySelector('select[aria-label="Examination scope"]')).not.toBeNull();
    await render(panel({ ticket: T({ status: "PENDING_REVIEW", engineeringRequired: false, assignedEngineerId: null } as never), uid: "req-1", role: "Requester", roles: ["Requester"] }));
    expect(host.querySelector("select")).toBeNull();
  });
  it("second fix pass / merge-time fix pass (ruling 4(b)): an issued request — a recorded value is read-only, no waiver, no 'needed before it can issue'; a missing one may be completed", async () => {
    for (const status of ["PENDING_IFC", "FINAL_DRAFT"] as TicketStatus[]) {
      db.mayWaive = true;
      db.results["ticket_examination_scopes:single"] = { data: { field_values: { exam: { value: "rt5", by: "e-1", at: SINCE } }, waiver: null }, error: null };
      await render(panel({ ticket: T({ status }), issuing: true }));
      expect(host.querySelector("select"), status).toBeNull();
      expect(host.querySelector('[data-testid="examination-scope-blocking"]'), status).toBeNull();
      expect(host.querySelector('[data-testid="examination-scope-issued"]')?.textContent, status).toMatch(/part of the issued record/);
      expect([...host.querySelectorAll("button")].some((b) => /record why|Withdraw/i.test(b.textContent ?? "")), status).toBe(false);
      expect(gets(), status).toEqual([]);
      db.results["ticket_examination_scopes:single"] = { data: { field_values: {}, waiver: null }, error: null };
      await render(panel({ ticket: T({ status, lastModified: status } as never), issuing: true }));
      const sel = host.querySelector('select[aria-label="Examination scope"]') as HTMLSelectElement;
      expect([...sel.options].map((o) => o.value), status).toEqual(["", "rt5", "rt100"]);
    }
  });
  it("merge-time fix pass (ruling 4(b)): a value completed after issue says so", async () => {
    db.results["ticket_examination_scopes:single"] = { data: { field_values: { exam: { value: "rt5", by: "d-1", at: SINCE, afterIssue: { rev: "1A" } } }, waiver: null }, error: null };
    await render(panel({ ticket: T({ status: "PENDING_IFC" }) }));
    expect(host.querySelector('[data-testid="examination-scope-after-issue"]')?.textContent).toBe("(completed after issue)");
  });
  it("merge-time fix pass (ruling 4(a)): in review the engineer of record has the list; the drafter does not", async () => {
    db.results["ticket_examination_scopes:single"] = { data: { field_values: { exam: { value: "rt5", by: "d-1", at: SINCE } }, waiver: null }, error: null };
    await render(panel({ uid: "e-1", role: "Engineer-2", roles: ["Engineer-2"] }));
    expect(host.querySelector('select[aria-label="Examination scope"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="examination-scope-in-review"]')?.textContent).toMatch(/only the engineer of record changes this data now/);
    await render(panel({ ticket: T({ lastModified: "y" } as never), uid: "d-1" }));
    expect(host.querySelector("select")).toBeNull();
  });
  it("merge-time fix pass (ruling 1): the requester has no list for a value someone else recorded; for their own, the list with its clear", async () => {
    const lik = { status: "DRAFTING", engineeringRequired: false, assignedEngineerId: null };
    db.results["ticket_examination_scopes:single"] = { data: { field_values: { exam: { value: "rt5", by: "d-1", at: SINCE } }, waiver: null }, error: null };
    await render(panel({ ticket: T(lik as never), uid: "req-1", role: "Requester", roles: ["Requester"] }));
    expect(host.querySelector("select")).toBeNull();
    db.results["ticket_examination_scopes:single"] = { data: { field_values: { exam: { value: "rt5", by: "req-1", at: SINCE } }, waiver: null }, error: null };
    await render(panel({ ticket: T({ ...lik, lastModified: "z" } as never), uid: "req-1", role: "Requester", roles: ["Requester"] }));
    const sel = host.querySelector('select[aria-label="Examination scope"]') as HTMLSelectElement;
    expect([...sel.options].map((o) => o.value)).toEqual(["", "rt5", "rt100"]);
  });
  it("merge-time fix pass (item 7): the waiver control shows only when the route says this viewer may — never on the page's own engine alone; the route is not asked of a viewer the page offers no issuing act", async () => {
    db.mayWaive = false;
    await render(panel({ uid: "s-1", issuing: true }));
    expect(gets()).toHaveLength(1);
    expect([...host.querySelectorAll("button")].some((b) => /record why/i.test(b.textContent ?? ""))).toBe(false);
    fetches.length = 0;
    db.mayWaive = true;
    await render(panel({ ticket: T({ lastModified: "w" } as never), uid: "s-1", issuing: false }));
    expect(gets()).toEqual([]);
    expect([...host.querySelectorAll("button")].some((b) => /record why/i.test(b.textContent ?? ""))).toBe(false);
  });
  it("before 20261266: says nothing can be recorded yet (and nothing is required)", async () => {
    db.results["ticket_examination_scopes:single"] = { data: null, error: { code: "42P01", message: "relation does not exist" } };
    await render(panel());
    expect(host.querySelector('[data-testid="examination-scope-not-migrated"]')?.textContent).toMatch(/database update 20261266 is not applied/);
  });
});

describe("ExaminationScopeSection — the editor", () => {
  it("a workspace with no requirement reads nothing more on the page (the library choices load only once a requirement exists)", async () => {
    await render(React.createElement(ExaminationScopeSection, { settings: { requestTypes: { options: [] } } as never, orgId: "o1", onChange: () => {} } as never));
    expect(db.reads).toEqual([]);
    await render(React.createElement(ExaminationScopeSection, { settings: CFG, orgId: "o1", onChange: () => {} } as never));
    expect(db.reads).toEqual(["libraries"]);
  });
  it("adds a field and a requirement into the page's settings (no time until the page's save stamps it)", async () => {
    const patches: Array<Record<string, unknown>> = [];
    await render(React.createElement(ExaminationScopeSection, { settings: { requestTypes: { options: [] } } as never, orgId: null, onChange: (p: Record<string, unknown>) => patches.push(p) } as never));
    expect(host.textContent).toMatch(/applies only to requests filed at least 15 minutes after you save it/);
    await act(async () => { [...host.querySelectorAll("button")].find((b) => b.textContent === "Add data")!.click(); });
    expect(patches[0]).toEqual({ examinationScope: { fields: [{ key: "", label: "", options: [] }], requirements: [] } });
    await render(React.createElement(ExaminationScopeSection, { settings: CFG, orgId: null, onChange: (p: Record<string, unknown>) => patches.push(p) } as never));
    expect(host.textContent).toMatch(/applies to requests filed from/);
    await act(async () => { [...host.querySelectorAll("button")].find((b) => b.textContent === "Add requirement")!.click(); });
    const last = patches[patches.length - 1] as { examinationScope: { requirements: Array<Record<string, unknown>> } };
    expect(last.examinationScope.requirements).toEqual([{ field: "exam", libraryId: LIB, since: SINCE }, { field: "" }]);
  });
});

describe("ExaminationScopeSection — merge-time fix pass (ruling 3): the parser's own rule, shown inline", () => {
  const withScope = (fields: unknown[], requirements: unknown[] = []) => ({ requestTypes: { options: [] }, examinationScope: { fields, requirements } }) as never;
  it("a key outside the rule, over 60 characters, a duplicate or a blank — and a requirement on data that would be dropped — each shown at its row", async () => {
    const opts = [{ value: "a", label: "a" }];
    await render(React.createElement(ExaminationScopeSection, { settings: withScope([
      { key: "ok", label: "OK", options: opts },
      { key: "-bad", label: "Bad", options: opts },
      { key: "x".repeat(61), label: "Long", options: opts },
      { key: "ok", label: "Dup", options: opts },
      { key: "  ", label: "Blank", options: opts },
    ], [{ field: "ok", libraryId: LIB, since: SINCE }, { field: "-bad", libraryId: LIB }, { field: "ok" }]), orgId: null, onChange: () => {} } as never));
    const rows = [...host.querySelectorAll('[data-testid="examination-scope-field"]')];
    const problemOf = (el: Element) => [...el.querySelectorAll('[data-testid="examination-scope-problem"]')].map((p) => p.textContent);
    expect(problemOf(rows[0])).toEqual([]);
    expect(problemOf(rows[1])[0]).toMatch(/starts with a letter or a digit/);
    expect(problemOf(rows[2])[0]).toMatch(/longer than 60 characters/);
    expect(problemOf(rows[3])[0]).toMatch(/already uses the key "ok"/);
    expect(problemOf(rows[4])[0]).toMatch(/Give this data a key/);
    const reqs = [...host.querySelectorAll('[data-testid="examination-scope-requirement"]')];
    expect(problemOf(reqs[0])).toEqual([]);
    expect(problemOf(reqs[1])[0]).toMatch(/is not data configured above/);
    expect(problemOf(reqs[2])[0]).toMatch(/Pick a work class, a library, or both/);
    expect(host.querySelector('[data-testid="examination-scope-problems"]')?.textContent).toMatch(/6 entries below need fixing — Save Changes won.t save/);
  });
  it("merge-time fix pass 2: a key named like an Object.prototype property is refused inline", async () => {
    const opts = [{ value: "a", label: "a" }];
    await render(React.createElement(ExaminationScopeSection, { settings: withScope([{ key: "constructor", label: "C", options: opts }, { key: "toString", label: "T", options: opts }], [{ field: "constructor", libraryId: LIB }]), orgId: null, onChange: () => {} } as never));
    const rows = [...host.querySelectorAll('[data-testid="examination-scope-field"]')];
    for (const [i, key] of [[0, "constructor"], [1, "toString"]] as const) {
      expect(rows[i].querySelector('[data-testid="examination-scope-problem"]')?.textContent, key).toBe(`"${key}" can't be used as a key (it is a name the system reserves) — choose another.`);
    }
    expect(host.querySelector('[data-testid="examination-scope-requirement"] [data-testid="examination-scope-problem"]')?.textContent).toMatch(/is not data configured above/);
  });
  it("nothing to fix: no problem shown (and none at all without the key)", async () => {
    await render(React.createElement(ExaminationScopeSection, { settings: CFG, orgId: null, onChange: () => {} } as never));
    expect(host.querySelector('[data-testid="examination-scope-problem"], [data-testid="examination-scope-problems"]')).toBeNull();
    await render(React.createElement(ExaminationScopeSection, { settings: { requestTypes: { options: [] } } as never, orgId: null, onChange: () => {} } as never));
    expect(host.querySelector('[data-testid="examination-scope-problem"], [data-testid="examination-scope-problems"]')).toBeNull();
  });
});

describe("mounted where the plan puts them", () => {
  const src = (f: string) => readFileSync(join(process.cwd(), f), "utf8");
  it("the request page mounts the panel only when the workspace configured examination data", () => {
    expect(src("app/(protected)/requests/[id]/page.tsx")).toMatch(/\{examinationScopeConfigured\(parseExaminationScopeConfig\(draftingCfg\)\) && <div [^>]*><ExaminationScopePanel ticket=\{ticket\} draftingCfg=\{draftingCfg\}/);
  });
  it("Admin → Request forms mounts the section; its Save is ONE upsert and the page computes no time (the database stamps it — second fix pass)", () => {
    const page = src("app/(protected)/admin/requests/page.tsx");
    expect(page).toMatch(/<ExaminationScopeSection settings=\{settings\} orgId=\{activeOrgId\} onChange=/);
    expect(page).toMatch(/let data = withNormalizedOutcomeReasons\(settings\);/);
    const save = page.slice(page.indexOf("const handleSave"), page.indexOf("setSaving(false)", page.indexOf("const handleSave")));
    expect(save.match(/\.upsert\(/g)?.length).toBe(1);
    expect(save).not.toMatch(/since:|readServerClock|toISOString\(\)|Date\.now\(\)|new Date\(/);
  });
});
