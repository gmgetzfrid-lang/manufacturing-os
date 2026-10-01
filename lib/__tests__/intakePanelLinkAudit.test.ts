// @vitest-environment jsdom
//
// projects Round G (J13 records reconcile, review fix pass) — committed
// pins for projects-and-cost INTK-12's IntakePanel half, driven through the
// rendered panel rather than read from its source:
//   * done-when 3: the document-link insert reads back its id
//     (insert → select → single) and INTAKE_LINK_CREATED's resource_id is
//     that id — never the project, never token material;
//   * done-when 4: both audit inserts (create and revoke) check { error } and
//     the failure reaches the user; a clean audit says nothing of failure.
// The revoke's missing zero-row read-back is projects-and-cost INTK-17 and
// is deliberately NOT pinned here.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

type Res = { data: unknown; error: null | { code?: string; message: string } };
const db = vi.hoisted(() => ({
  /** `${table}.${firstMethod}` → the result that chain resolves to. */
  byOp: {} as Record<string, Res>,
  calls: [] as Array<{ table: string; op: string; method: string; args: unknown[] }>,
  inserts: [] as Array<{ table: string; row: Record<string, unknown> }>,
}));
const dlg = vi.hoisted(() => ({ appPrompt: vi.fn(), appConfirm: vi.fn(), appAlert: vi.fn() }));

vi.mock("@/lib/supabase", () => {
  const chain = (table: string): unknown => {
    let op = "";
    const h: ProxyHandler<object> = {
      get(_t, prop: string) {
        if (prop === "then") {
          const res = db.byOp[`${table}.${op}`] ?? { data: [], error: null };
          return (resolve: (v: unknown) => void) => resolve(res);
        }
        return (...args: unknown[]) => {
          if (!op) op = prop;
          db.calls.push({ table, op, method: prop, args });
          if (prop === "insert") db.inserts.push({ table, row: args[0] as Record<string, unknown> });
          return new Proxy({}, h);
        };
      },
    };
    return new Proxy({}, h);
  };
  return { supabase: { from: (t: string) => chain(t), auth: { getSession: async () => ({ data: { session: null } }) } } };
});
vi.mock("@/components/providers/DialogProvider", () => dlg);
// The approve / adopt machinery is not exercised here.
vi.mock("@/lib/reviewControl", () => ({
  finalizeReviewedRevision: vi.fn(), finalizeReasonMessage: vi.fn(() => ""),
  effectiveReviewControlForDocument: vi.fn(), listDraftRoster: vi.fn(async () => []), openReviewRoster: vi.fn(),
}));
vi.mock("@/lib/docClass", () => ({ effectiveDocClassForDocument: vi.fn() }));
vi.mock("@/lib/checklists", () => ({ describeProjectSweep: vi.fn(() => null) }));
vi.mock("@/lib/transitionIn", () => ({ flagCollisionToDrafting: vi.fn() }));
vi.mock("@/components/projects/TransitionInPanel", () => ({ default: () => null }));

import IntakePanel from "@/components/projects/IntakePanel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  for (const f of Object.values(dlg)) f.mockReset();
  db.byOp = {}; db.calls = []; db.inserts = [];
  db.byOp["projects.select"] = { data: { intake_library_id: "lib1", intake_collection_id: null }, error: null };
  db.byOp["libraries.select"] = { data: [{ id: "lib1", name: "Intake" }], error: null };
  db.byOp["project_intake_links.select"] = { data: [], error: null };
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const render = async () => {
  await act(async () => {
    root.render(React.createElement(IntakePanel, { orgId: "o1", projectId: "p1", canManage: true, uid: "u1", userEmail: "u1@example.com" }));
  });
  await settle();
};
const setInput = async (el: HTMLInputElement, v: string) => {
  const proto = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!;
  await act(async () => { proto.set!.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); });
};
const auditRows = () => db.inserts.filter((i) => i.table === "audit_logs");
const createLink = async () => {
  await setInput(host.querySelector('input[placeholder^="Company name"]') as HTMLInputElement, "Gulf Mechanical");
  const create = [...host.querySelectorAll("button")].find((b) => /Create link/.test(b.textContent ?? ""))!;
  await act(async () => { create.click(); }); await settle();
};

describe("INTK-12 dw3 / dw4 — IntakePanel's link creation", () => {
  it("the insert reads back its id; INTAKE_LINK_CREATED names that id, not the project and no token; a failed audit insert is shown", async () => {
    db.byOp["project_intake_links.insert"] = { data: { id: "link-9" }, error: null };
    db.byOp["audit_logs.insert"] = { data: null, error: { message: "audit denied" } };
    await render();
    await createLink();
    const ins = db.inserts.filter((i) => i.table === "project_intake_links");
    expect(ins).toHaveLength(1);
    expect(typeof ins[0].row.expires_at).toBe("string");
    const chain = db.calls.filter((c) => c.table === "project_intake_links" && c.op === "insert").map((c) => c.method);
    expect(chain).toEqual(["insert", "select", "single"]);
    const audit = auditRows();
    expect(audit).toHaveLength(1);
    expect(audit[0].row).toMatchObject({ action: "INTAKE_LINK_CREATED", resource_type: "project_intake_link", resource_id: "link-9" });
    expect(audit[0].row.resource_id).not.toBe("p1");
    const token = String(ins[0].row.token);
    expect(token.length).toBeGreaterThan(8);
    expect(JSON.stringify(audit[0].row)).not.toContain(token.slice(0, 8));
    expect(host.textContent).toContain("Link created, but its audit record failed: audit denied");
  });

  it("a clean audit insert reports no failure", async () => {
    db.byOp["project_intake_links.insert"] = { data: { id: "link-9" }, error: null };
    db.byOp["audit_logs.insert"] = { data: null, error: null };
    await render();
    await createLink();
    expect(auditRows()).toHaveLength(1);
    expect(host.textContent).not.toContain("audit record failed");
    expect(host.textContent).toContain("Link created — copy it below now");
  });
});

describe("INTK-12 dw4 — IntakePanel's revoke", () => {
  const live = { id: "L1", token_prefix: "abc123", company_name: "Bayline", contact_email: null, allow_auto_supersede: false,
    expires_at: new Date(Date.now() + 5 * 86_400_000).toISOString(), revoked_at: null, submission_count: 0, last_used_at: null, assigned_doc_ids: [] };
  const revoke = () => [...host.querySelectorAll<HTMLButtonElement>("li button")].find((b) => /Revoke/.test(b.textContent ?? ""))!;

  it("writes revoked_at and audits INTAKE_LINK_REVOKED by the link id; a failed audit insert is shown", async () => {
    db.byOp["project_intake_links.select"] = { data: [live], error: null };
    db.byOp["project_intake_links.update"] = { data: null, error: null };
    db.byOp["audit_logs.insert"] = { data: null, error: { message: "audit denied" } };
    dlg.appConfirm.mockResolvedValue(true);
    await render();
    await act(async () => { revoke().click(); }); await settle();
    const upd = db.calls.filter((c) => c.table === "project_intake_links" && c.op === "update");
    expect(Object.keys(upd[0].args[0] as object)).toEqual(["revoked_at"]);
    const audit = auditRows();
    expect(audit).toHaveLength(1);
    expect(audit[0].row).toMatchObject({ action: "INTAKE_LINK_REVOKED", resource_type: "project_intake_link", resource_id: "L1" });
    expect(host.textContent).toContain("The link was revoked, but its audit record failed: audit denied");
  });

  it("a refused update is shown and audits nothing", async () => {
    db.byOp["project_intake_links.select"] = { data: [live], error: null };
    db.byOp["project_intake_links.update"] = { data: null, error: { message: "permission denied" } };
    dlg.appConfirm.mockResolvedValue(true);
    await render();
    await act(async () => { revoke().click(); }); await settle();
    expect(auditRows()).toHaveLength(0);
    expect(host.textContent).toContain("Couldn't revoke: permission denied");
  });
});
