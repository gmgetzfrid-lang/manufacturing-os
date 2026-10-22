// @vitest-environment jsdom
// drafting-flow Round G, DF-P22 — the two screens:
//   * SlaEscalationSection (Admin → Request forms): DF-P22 fix pass — only an
//     Admin edits it, through its own Save (/api/admin/sla-escalation, PUT);
//     everyone else the page admits sees it read-only; it is never part of
//     the page's Save; a Contractor role is never offered.
//   * PreauthorizationPanel (profile): lists the viewer's own records, signs
//     exactly the statement the route checks, posts the record, revokes;
//     before 20261264 it says it is not available and records nothing.
//   * Both are mounted where the brief's hand-offs put them (source pins).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const db = vi.hoisted(() => ({ results: {} as Record<string, { data: unknown; error: null }> }));
vi.mock("@/lib/supabase", () => {
  const chain = (table: string): unknown => {
    const res = () => db.results[table] ?? { data: [], error: null };
    const c: Record<string, unknown> = {};
    const p: ProxyHandler<Record<string, unknown>> = {
      get(_t, prop: string) {
        if (prop === "then") return (resolve: (v: unknown) => void) => resolve(res());
        if (prop === "maybeSingle" || prop === "single") return () => Promise.resolve(db.results[`${table}:single`] ?? { data: null, error: null });
        return () => new Proxy(c, p);
      },
    };
    return new Proxy(c, p);
  };
  return { supabase: { from: (t: string) => chain(t), auth: { getSession: async () => ({ data: { session: { access_token: "tok" } } }) } } };
});
const sig = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>> }));
vi.mock("@/lib/eSignatures", () => ({ recordSignature: vi.fn(async (input: Record<string, unknown>) => { sig.calls.push(input); return { id: "cccccccc-0000-4000-8000-000000000001" }; }) }));
vi.mock("@/components/signatures/SignatureCeremony", () => ({
  default: (p: { defaultStatement: string; onSign: (i: string, s: string) => void }) =>
    React.createElement("button", { "data-testid": "ceremony", "data-statement": p.defaultStatement, onClick: () => p.onSign("Acknowledged", p.defaultStatement) }, "sign"),
}));
vi.mock("@/components/providers/RoleContext", () => ({ useRole: () => ({ uid: "u-1", userEmail: "q@x.io", activeOrgId: "o-1", member: { displayName: "Quinn" } }) }));

import SlaEscalationSection from "@/components/requests/SlaEscalationSection";
import PreauthorizationPanel from "@/components/requests/PreauthorizationPanel";
import { preauthorizationStatement, preauthExpiryFromDay, PREAUTH_REVOCATION_SCOPE } from "@/lib/ticketPreauthorization";

let host: HTMLDivElement;
let root: Root;
const fetches: Array<{ url: string; method: string; body: unknown }> = [];
let listAnswer: { status: number; body: unknown } = { status: 200, body: { ok: true, admin: false, records: [] } };
let escAnswer: { status: number; body: unknown } = { status: 200, body: { config: null, error: null, canEdit: true } };
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  db.results = {};
  fetches.length = 0;
  sig.calls.length = 0;
  listAnswer = { status: 200, body: { ok: true, admin: false, records: [] } };
  escAnswer = { status: 200, body: { config: null, error: null, canEdit: true } };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    fetches.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body) : null });
    if ((init?.method ?? "GET") === "GET" && url.startsWith("/api/admin/sla-escalation")) return { ok: escAnswer.status < 400, status: escAnswer.status, json: async () => escAnswer.body };
    if ((init?.method ?? "GET") === "GET") return { ok: listAnswer.status < 400, status: listAnswer.status, json: async () => listAnswer.body };
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  }));
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const el = React.createElement as unknown as (t: unknown, p: Record<string, unknown>) => React.ReactElement;
const flush = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const select = async (label: string, value: string) => {
  const s = host.querySelector(`[aria-label="${label}"]`) as HTMLSelectElement | HTMLInputElement;
  await act(async () => {
    const proto = s instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(s, value);
    s.dispatchEvent(new Event(s instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
};

describe("SlaEscalationSection", () => {
  const draw = async () => { await act(async () => { root.render(el(SlaEscalationSection, { orgId: "o-1" })); }); await flush(); };
  const saveBtn = () => [...host.querySelectorAll("button")].find((b) => /Save escalation/.test(b.textContent ?? "")) as HTMLButtonElement | undefined;
  it("an Admin: off by default, nothing sent until they choose and press its own Save; a role, a period, then off again", async () => {
    await draw();
    expect((host.querySelector('[aria-label="Escalation contact kind"]') as HTMLSelectElement).value).toBe("none");
    expect(saveBtn()!.disabled).toBe(true);
    await select("Escalation contact kind", "role");
    await select("Escalation role", "DraftingSupervisor");
    await select("Escalation period days", "5");
    expect(fetches.filter((f) => f.method === "PUT")).toEqual([]);
    expect(saveBtn()!.disabled).toBe(false);
    await act(async () => { saveBtn()!.click(); });
    await flush();
    expect(fetches.filter((f) => f.method === "PUT").at(-1)).toMatchObject({ url: "/api/admin/sla-escalation", body: { orgId: "o-1", config: { contact: { kind: "role", role: "DraftingSupervisor" }, periodDays: 5 } } });
    expect(host.textContent).toMatch(/on the audit trail/);
    await select("Escalation contact kind", "none");
    await act(async () => { saveBtn()!.click(); });
    await flush();
    expect(fetches.filter((f) => f.method === "PUT").at(-1)!.body).toEqual({ orgId: "o-1", config: null });
  });
  it("a Contractor role is never offered", async () => {
    escAnswer = { status: 200, body: { config: { contact: { kind: "role", role: "Admin" }, periodDays: 2 }, error: null, canEdit: true } };
    await draw();
    const opts = [...(host.querySelector('[aria-label="Escalation role"]') as HTMLSelectElement).options].map((o) => o.value);
    expect(opts).toContain("Admin");
    expect(opts).not.toContain("Contractor");
  });
  it("anyone else the page admits (a drafting supervisor) sees it read-only — no control, no Save", async () => {
    escAnswer = { status: 200, body: { config: { contact: { kind: "role", role: "Admin" }, periodDays: 2 }, error: null, canEdit: false } };
    await draw();
    expect(host.querySelector('[aria-label="Escalation contact kind"]')).toBeNull();
    expect(saveBtn()).toBeUndefined();
    expect(host.querySelector('[data-testid="sla-escalation-readonly"]')!.textContent).toMatch(/everyone holding Admin, after 2 day\(s\).*Only an Admin can change this/);
  });
  it("a stored value it cannot use says so (nobody escalated)", async () => {
    escAnswer = { status: 200, body: { config: null, error: "the escalation period is a whole number of days from 1 to 30", canEdit: true } };
    await draw();
    expect(host.textContent).toMatch(/can.t be used/);
  });
  it("a refused save shows the route's reason", async () => {
    await draw();
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { method?: string }) => (init?.method === "PUT"
      ? { ok: false, status: 403, json: async () => ({ error: "Only an Admin can change who hears about overdue requests" }) }
      : { ok: true, status: 200, json: async () => escAnswer.body })));
    await select("Escalation contact kind", "role");
    await act(async () => { saveBtn()!.click(); });
    await flush();
    expect(host.textContent).toMatch(/Only an Admin can change who hears/);
  });
});

describe("PreauthorizationPanel", () => {
  it("signs exactly the statement the route composes, then posts the record for the viewer", async () => {
    db.results.libraries = { data: [{ id: "aaaaaaaa-0000-4000-8000-000000000001", name: "Piping" }], error: null };
    await act(async () => { root.render(el(PreauthorizationPanel, {})); });
    await flush();
    expect(host.textContent).toMatch(/You have none/);
    await select("Library", "aaaaaaaa-0000-4000-8000-000000000001");
    const day = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
    await select("Expires", day);
    const btn = [...host.querySelectorAll("button")].find((b) => /Sign and record/.test(b.textContent ?? ""))!;
    expect(btn.disabled).toBe(false);
    await act(async () => { btn.click(); });
    const ceremony = host.querySelector('[data-testid="ceremony"]') as HTMLButtonElement;
    const expected = preauthorizationStatement({ libraryId: "aaaaaaaa-0000-4000-8000-000000000001", libraryName: "Piping", requestType: null, workClass: null, expiresAt: preauthExpiryFromDay(day) });
    expect(ceremony.getAttribute("data-statement")).toBe(expected);
    await act(async () => { ceremony.click(); });
    await flush();
    expect(sig.calls[0]).toMatchObject({ resourceType: "ticket_preauthorization", intent: "Acknowledged", statement: expected });
    const post = fetches.find((f) => f.method === "POST")!;
    expect(post.body).toMatchObject({ orgId: "o-1", libraryId: "aaaaaaaa-0000-4000-8000-000000000001", expiresAt: preauthExpiryFromDay(day), signatureId: "cccccccc-0000-4000-8000-000000000001" });
    expect((post.body as { id: string }).id).toBe(sig.calls[0].resourceId);
  });
  it("the button stays off until it is scoped and has an expiry", async () => {
    await act(async () => { root.render(el(PreauthorizationPanel, {})); });
    await flush();
    const btn = [...host.querySelectorAll("button")].find((b) => /Sign and record/.test(b.textContent ?? ""))!;
    expect(btn.disabled).toBe(true);
  });
  it("before 20261264: says it is not available and offers nothing to record", async () => {
    listAnswer = { status: 503, body: { error: "Standing pre-authorizations are not available yet (database update 20261264 is not applied).", code: "not_migrated" } };
    await act(async () => { root.render(el(PreauthorizationPanel, {})); });
    await flush();
    expect(host.textContent).toMatch(/not available yet/);
    expect([...host.querySelectorAll("button")].some((b) => /Sign and record/.test(b.textContent ?? ""))).toBe(false);
  });
  it("a standing record of the viewer's can be revoked", async () => {
    listAnswer = { status: 200, body: { ok: true, admin: false, records: [{ id: "p-1", orgId: "o-1", grantorId: "u-1", grantorName: "Quinn", libraryId: null, requestType: "ISO", workClass: null, statement: "s", signatureId: "x", createdAt: "2026-10-01T00:00:00Z", expiresAt: new Date(Date.now() + 86_400_000 * 10).toISOString(), revokedAt: null, revokedBy: null, revokeReason: null }] } };
    await act(async () => { root.render(el(PreauthorizationPanel, {})); });
    await flush();
    const revoke = [...host.querySelectorAll("button")].find((b) => /Revoke/.test(b.textContent ?? ""))!;
    await act(async () => { revoke.click(); });
    await flush();
    expect(fetches.find((f) => f.method === "PATCH")!.body).toEqual({ orgId: "o-1", id: "p-1", action: "revoke" });
    // merge-time fix pass: what revoking means is said after it, as the ruling words it
    expect(host.querySelector('[role="status"]')!.textContent).toBe(PREAUTH_REVOCATION_SCOPE);
  });
  it("merge-time fix pass: the panel says what revoking means and that a record lives only while its grantor stays an active member", async () => {
    await act(async () => { root.render(el(PreauthorizationPanel, {})); });
    await flush();
    expect(host.textContent).toContain(PREAUTH_REVOCATION_SCOPE);
    expect(host.textContent).toMatch(/in force only while you stay an active member of this workspace \(if your membership lapses, it is never used again\)/);
  });
  it("merge-time fix pass: the Admin list shows a lapsed grantor's record as not in force — and an Admin can still revoke it", async () => {
    const future = new Date(Date.now() + 86_400_000 * 10).toISOString();
    const rec = (id: string, grantorMembership: string) => ({ id, orgId: "o-1", grantorId: `g-${id}`, grantorName: `G ${id}`, libraryId: null, requestType: "ISO", workClass: null, statement: "s", signatureId: "x", createdAt: "2026-10-01T00:00:00Z", expiresAt: future, revokedAt: null, revokedBy: null, revokeReason: null, grantorMembership });
    listAnswer = { status: 200, body: { ok: true, admin: true, records: [rec("p-1", "lapsed"), rec("p-2", "continuous"), rec("p-3", "unproven")] } };
    await act(async () => { root.render(el(PreauthorizationPanel, {})); });
    await flush();
    const items = [...host.querySelectorAll("li")].map((li) => li.textContent ?? "");
    expect(items[0]).toContain("not in force — grantor's membership lapsed");
    expect(items[1]).not.toContain("not in force");
    expect(items[2]).toContain("not in force — grantor's membership could not be confirmed continuous");
    expect([...host.querySelectorAll("li")][0].querySelector("button")!.textContent).toMatch(/Revoke/);
  });
});

describe("where they are mounted", () => {
  it("the profile page mounts the panel; Admin → Request forms mounts the escalation section with its own Save, never the page's", () => {
    const profile = readFileSync(join(process.cwd(), "app/(protected)/profile/page.tsx"), "utf8");
    expect(profile).toContain("<PreauthorizationPanel />");
    const admin = readFileSync(join(process.cwd(), "app/(protected)/admin/requests/page.tsx"), "utf8");
    expect(admin).toContain("<SlaEscalationSection orgId={activeOrgId} />");
    expect(admin).not.toMatch(/slaEscalation/);
  });
});
