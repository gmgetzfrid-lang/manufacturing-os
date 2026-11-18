// @vitest-environment jsdom
//
// projects-joint J15c CHECKED-WRITE SWEEP (projects-tab SAF-18) — the
// Projects surface's own UPDATEs, rendered: EditProjectModal's second write
// (purpose / goals / Summary of Work), the project wizard's details write,
// and the change-order panel's budget-line assignment before an approval.
// Each now reads its matched rows (lib/checkedWrite.ts): a write that
// row-level security filtered to zero rows — no error, nothing changed — is
// said like an error, and nothing after it (an audit row, a navigation, the
// money decision) claims it landed. The ordinary path is unchanged.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const ui = vi.hoisted(() => ({
  refused: new Set<string>(),
  updates: [] as Array<{ table: string; payload: unknown }>,
  audits: [] as Array<Record<string, unknown>>,
  push: vi.fn(),
  listChangeOrders: vi.fn(),
  decideChangeOrder: vi.fn(),
  appConfirm: vi.fn(),
}));
vi.mock("@/lib/supabase", () => {
  const chain = (table: string): unknown => {
    const methods: string[] = []; const args: unknown[][] = [];
    const h: ProxyHandler<object> = {
      get(_t, prop: string) {
        if (prop === "then") {
          return (resolve: (v: unknown) => void) => {
            if (methods[0] === "update") {
              ui.updates.push({ table, payload: args[0][0] });
              // PostgREST answers `.select("id")` with the rows it matched — none when RLS hid them
              return resolve({ data: ui.refused.has(table) ? [] : [{ id: `${table}-1` }], error: null });
            }
            if (methods[0] === "insert") return resolve({ data: [], error: null });
            const single = methods.includes("maybeSingle") || methods.includes("single");
            if (table === "projects" && single) return resolve({ data: { purpose: "", goals: [], success_criteria: "", sow_document_id: null }, error: null });
            return resolve({ data: single ? null : [], error: null });
          };
        }
        return (...a: unknown[]) => { methods.push(prop); args.push(a); return new Proxy({}, h); };
      },
    };
    return new Proxy({}, h);
  };
  return { supabase: { from: (t: string) => chain(t), auth: { getSession: async () => ({ data: { session: null } }) } } };
});
vi.mock("@/lib/audit", () => ({ logAuditAction: vi.fn(async (e: Record<string, unknown>) => { ui.audits.push(e); return { ok: true, error: null }; }) }));
vi.mock("@/lib/notify/dispatch", () => ({ emit: vi.fn() }));
vi.mock("@/lib/projects", () => ({
  createProject: vi.fn(async () => ({ id: "p-new" })),
  updateProjectMeta: vi.fn(async () => undefined),
}));
vi.mock("@/lib/projectSnapshot", () => ({ invalidateProjectSnapshot: vi.fn() }));
vi.mock("@/lib/turnover", () => ({ seedTurnoverItems: vi.fn(async () => ({ ok: true, added: 0 })) }));
vi.mock("@/lib/companies", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/companies")>()),
  listCompanies: vi.fn(async () => []),
  listBarredCompanies: vi.fn(async () => []),
}));
vi.mock("@/lib/changeOrders", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/changeOrders")>()),
  listChangeOrders: (...a: unknown[]) => ui.listChangeOrders(...a),
  decideChangeOrder: (...a: unknown[]) => ui.decideChangeOrder(...a),
}));
vi.mock("@/components/ui/ChartKit", () => ({ Donut: () => null }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: ui.push, back: vi.fn() }), useParams: () => ({}) }));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => React.createElement("a", { href }, children),
}));
vi.mock("@/components/providers/RoleContext", () => ({ useRole: () => ({}) }));
vi.mock("@/components/providers/DialogProvider", () => ({
  appAlert: vi.fn(async () => undefined),
  appConfirm: (...a: unknown[]) => ui.appConfirm(...a),
  appPrompt: vi.fn(async () => null),
}));

import EditProjectModal from "@/components/projects/EditProjectModal";
import ProjectWizard from "@/components/projects/ProjectWizard";
import ChangeOrdersPanel from "@/components/projects/cost/ChangeOrdersPanel";
import { CHECKED_WRITE_REFUSED } from "@/lib/checkedWrite";
import type { ChangeOrder } from "@/lib/changeOrders";
import type { Project } from "@/types/schema";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  ui.refused = new Set(); ui.updates = []; ui.audits = [];
  ui.push.mockReset(); ui.listChangeOrders.mockReset(); ui.decideChangeOrder.mockReset();
  ui.appConfirm.mockReset().mockResolvedValue(true);
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); document.body.innerHTML = ""; });

const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const setValue = async (el: HTMLInputElement | HTMLTextAreaElement, v: string) => {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => { Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); });
};
const button = (label: string) =>
  [...document.querySelectorAll("button")].find((b) => b.textContent?.trim().startsWith(label)) as HTMLButtonElement;
const click = async (b: Element) => { await act(async () => { b.dispatchEvent(new MouseEvent("click", { bubbles: true })); }); await settle(); };

describe("EditProjectModal — the purpose / goals / Summary of Work write", () => {
  const project = { id: "p1", orgId: "o1", name: "TA", description: "Turnaround", visibility: "public" } as unknown as Project;
  const openAndEditPurpose = async (onSaved = vi.fn()) => {
    await act(async () => { root.render(h(EditProjectModal, { project, actorUserId: "u1", onClose: vi.fn(), onSaved })); });
    await settle();
    const purpose = [...host.querySelectorAll("label")].find((l) => l.textContent?.startsWith("Purpose"))!.querySelector("textarea")!;
    await setValue(purpose, "Replace the E-301 circuits");
    await click(button("Save changes"));
    return onSaved;
  };

  it("a write that matched no row is said in the dialog, and no PROJECT_UPDATED row claims it", async () => {
    ui.refused.add("projects");
    const onSaved = await openAndEditPurpose();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(
      "Name, description, MOC, target date and visibility were saved, but purpose / goals / Summary of Work were not: the database did not change them (you may not be allowed to, or someone else changed the project first). Save changes retries just those.",
    );
    expect(host.querySelector('[role="alert"]')?.textContent).not.toContain("Nothing was changed");
    expect(ui.audits).toEqual([]);
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("regression: a write that lands is audited and closes as before", async () => {
    const onSaved = await openAndEditPurpose();
    expect(ui.updates.filter((u) => u.table === "projects")).toHaveLength(1);
    expect(ui.audits.map((a) => a.action)).toEqual(["PROJECT_UPDATED"]);
    expect(onSaved).toHaveBeenCalledTimes(1);
  });
});

describe("ProjectWizard — the details write after the project is created", () => {
  const createFromBasics = async () => {
    await act(async () => { root.render(h(ProjectWizard, { orgId: "o1", actorUserId: "u1", onClose: vi.fn(), onCreated: vi.fn() })); });
    await settle();
    await setValue(document.querySelector('input[placeholder="2026 Q1 Turnaround — Unit 300"]') as HTMLInputElement, "Unit 300");
    await setValue(document.querySelector("textarea") as HTMLTextAreaElement, "Replace E-301 circuits");
    await click(button("Create project"));
  };

  it("a details write that matched no row is a failed step — listed with the refusal, and the wizard does not move on", async () => {
    ui.refused.add("projects");
    await createFromBasics();
    const alert = document.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("The project was created, but");
    expect(alert?.textContent).toContain(CHECKED_WRITE_REFUSED);
    expect(ui.push).not.toHaveBeenCalled();
  });

  it("regression: a details write that lands goes to the new project as before", async () => {
    await createFromBasics();
    expect(ui.updates.filter((u) => u.table === "projects")).toHaveLength(1);
    expect(ui.push).toHaveBeenCalledWith("/projects/p-new");
  });
});

describe("ChangeOrdersPanel — the budget-line assignment before an approval", () => {
  const proposed = (): ChangeOrder => ({
    id: "c9", orgId: "o1", projectId: "p1", costAccountId: null, partyId: null, coNumber: "CO-120", title: "More pipe",
    description: null, amount: 900, reasonCode: "field_condition", status: "proposed", decidedAt: null, decidedBy: null,
    decidedByName: null, decisionNote: null, createdBy: "u-owner", createdByName: "own", createdAt: null,
    postedEntryId: null, postedEntryStatus: null, selfDecided: false,
  });
  const approve = async (setErr: (m: string | null) => void) => {
    ui.listChangeOrders.mockResolvedValue([proposed()]);
    ui.decideChangeOrder.mockResolvedValue({ warning: null });
    await act(async () => {
      root.render(h(ChangeOrdersPanel, {
        orgId: "o1", projectId: "p1", canManage: true, actor: { uid: "u-owner", email: "owner@x.test" },
        accounts: [{ id: "a2", name: "Piping", code: "200" } as never], parties: [], onMoneyMoved: () => undefined, setErr,
      }));
    });
    await settle();
    const pick = host.querySelector("select") as HTMLSelectElement;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(pick, "a2"); pick.dispatchEvent(new Event("change", { bubbles: true })); });
    await click([...host.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes("Approve"))!);
  };

  it("an assignment that matched no row (decided meanwhile, or refused) stops the approval, in words — decideChangeOrder is never called", async () => {
    ui.refused.add("change_orders");
    const setErr = vi.fn();
    await approve(setErr);
    expect(ui.updates).toEqual([{ table: "change_orders", payload: { cost_account_id: "a2" } }]);
    expect(setErr).toHaveBeenLastCalledWith(CHECKED_WRITE_REFUSED);
    expect(ui.decideChangeOrder).not.toHaveBeenCalled();
  });

  it("regression: an assignment that lands goes on to the decision, bound to the line the confirm named", async () => {
    await approve(vi.fn());
    expect(ui.decideChangeOrder).toHaveBeenCalledTimes(1);
    expect(ui.decideChangeOrder.mock.calls[0][0]).toMatchObject({ decision: "approved", shownAmount: 900, shownAccountId: "a2" });
  });
});
