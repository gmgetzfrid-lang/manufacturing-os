// @vitest-environment jsdom
//
// projects Round G — J20: projects-tab SEC-22 limb (c), the Intake tab's half.
// 20261214's rail on projects.intake_library_id / intake_collection_id
// refuses a signed-in write that would move where live links file (42501,
// with a sentence a person can act on). The Intake tab writes the library
// only while it is unset (createLink), and a refusal must be SAID in the
// database's words — never swallowed, never a link created behind it. A first
// set the rail admits creates the link exactly as before (regression).
// Rendered (jsdom), the harness of intakePanelLinkAudit.test.ts.

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
// projects Round G J14 (INTK-18): the panel reads the controller tier from the role collection.
vi.mock("@/components/providers/RoleContext", () => ({ useRole: () => ({ hasAnyRole: () => false }) }));
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
const createLink = async () => {
  await setInput(host.querySelector('input[placeholder^="Company name"]') as HTMLInputElement, "Gulf Mechanical");
  const pick = host.querySelector("select") as HTMLSelectElement | null;
  if (pick && [...pick.options].some((o) => o.value === "lib1")) {
    const proto = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!;
    await act(async () => { proto.set!.call(pick, "lib1"); pick.dispatchEvent(new Event("change", { bubbles: true })); });
  }
  const create = [...host.querySelectorAll("button")].find((b) => /Create link/.test(b.textContent ?? ""))!;
  await act(async () => { create.click(); }); await settle();
};

const RAIL = "While this project has live contractor links, only an Admin or Document Control can change where they file (the project's intake library and folder) — revoke the links first, or ask one of them; nothing was changed. (SEC-22, 20261214)";
const notice = () => host.querySelector('[role="alert"], [role="status"]');

describe("projects-tab SEC-22 limb (c) (J20) — the Intake tab says the intake pointers' rail in its own words", () => {
  it("a refused intake-library write is said — the rail's sentence after 'Couldn't set the intake library:' — as an error, and no link is created behind it", async () => {
    db.byOp["projects.select"] = { data: { intake_library_id: null, intake_collection_id: null }, error: null };
    db.byOp["projects.update"] = { data: null, error: { code: "42501", message: RAIL } };
    await render();
    await createLink();
    const upd = db.calls.filter((c) => c.table === "projects" && c.method === "update");
    expect(upd).toHaveLength(1);
    expect(upd[0].args[0]).toEqual({ intake_library_id: "lib1" });
    expect(notice()?.getAttribute("role")).toBe("alert");
    expect(notice()?.textContent).toBe(`Couldn't set the intake library: ${RAIL}`);
    expect(db.inserts.filter((i) => i.table === "project_intake_links")).toEqual([]);
  });

  it("the other refusals of the rail read the same way (a library of another workspace; a folder outside the library)", async () => {
    for (const message of [
      "The intake library must be a library of this workspace; nothing was changed. (SEC-22, 20261214)",
      "The intake folder must be a folder of the project's intake library; nothing was changed. (SEC-22, 20261214)",
    ]) {
      act(() => root.unmount()); root = createRoot(host); db.calls = []; db.inserts = [];
      db.byOp["projects.select"] = { data: { intake_library_id: null, intake_collection_id: null }, error: null };
      db.byOp["projects.update"] = { data: null, error: { code: "42501", message } };
      await render();
      await createLink();
      expect(notice()?.textContent).toBe(`Couldn't set the intake library: ${message}`);
      expect(db.inserts.filter((i) => i.table === "project_intake_links")).toEqual([]);
    }
  });

  it("regression: a first set the rail admits creates the link exactly as before", async () => {
    db.byOp["projects.select"] = { data: { intake_library_id: null, intake_collection_id: null }, error: null };
    db.byOp["projects.update"] = { data: null, error: null };
    db.byOp["project_intake_links.insert"] = { data: { id: "link-9" }, error: null };
    db.byOp["audit_logs.insert"] = { data: null, error: null };
    await render();
    await createLink();
    expect(db.inserts.filter((i) => i.table === "project_intake_links")).toHaveLength(1);
    expect(notice()?.getAttribute("role")).toBe("status");
    expect(notice()?.textContent).toMatch(/^Link created — copy it below now/);
  });

  it("regression: with the library already set the Intake tab never writes it (the rail's move limb is never met from here)", async () => {
    db.byOp["project_intake_links.insert"] = { data: { id: "link-9" }, error: null };
    db.byOp["audit_logs.insert"] = { data: null, error: null };
    await render();
    await createLink();
    expect(db.calls.filter((c) => c.table === "projects" && c.method === "update")).toEqual([]);
    expect(db.inserts.filter((i) => i.table === "project_intake_links")).toHaveLength(1);
  });
});
