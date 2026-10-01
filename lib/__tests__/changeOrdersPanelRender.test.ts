// @vitest-environment jsdom
//
// projects Round G — J3 MONEY-LEDGER verification fix: the change-orders
// panel as RENDERED. listChangeOrders throws on a failed read (REL-2 — the
// COs or their linked entries); the panel says so with a retry instead of
// the "No change orders" empty state, stays quiet only when the table is
// absent (pre-migration), and names approved COs whose money is not on the
// ledger beside the approved total (COST-4: the same rule as the budget).
// Third / fourth verification passes: Approve hands decideChangeOrder the
// amount and the budget line the confirm showed (`shownAmount`,
// `shownAccountId`), so the decision binds to both.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const co = vi.hoisted(() => ({ listChangeOrders: vi.fn(), decideChangeOrder: vi.fn() }));
const dlg = vi.hoisted(() => ({ appConfirm: vi.fn(), appPrompt: vi.fn() }));

const db = vi.hoisted(() => ({ next: { data: [] as unknown, error: null as unknown } }));
vi.mock("@/lib/supabase", () => {
  // every chain resolves to db.next — enough for the REAL listChangeOrders
  const chain = (): unknown => new Proxy({}, {
    get(_t, prop: string) {
      if (prop === "then") return (resolve: (v: unknown) => void) => resolve(db.next);
      return () => chain();
    },
  });
  return { supabase: { from: () => chain() } };
});
vi.mock("@/lib/audit", () => ({ logAuditAction: vi.fn() }));
vi.mock("@/lib/notify/dispatch", () => ({ emit: vi.fn() }));
vi.mock("@/components/providers/DialogProvider", () => ({ appConfirm: dlg.appConfirm, appPrompt: dlg.appPrompt }));
vi.mock("@/components/ui/ChartKit", () => ({ Donut: () => null }));
vi.mock("@/lib/changeOrders", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/changeOrders")>();
  return { ...real, listChangeOrders: co.listChangeOrders, decideChangeOrder: co.decideChangeOrder };
});

import ChangeOrdersPanel from "@/components/projects/cost/ChangeOrdersPanel";
import type { ChangeOrder } from "@/lib/changeOrders";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const coOf = (over: Partial<ChangeOrder>): ChangeOrder => ({
  id: "c1", orgId: "o1", projectId: "p1", costAccountId: "a1", partyId: null, coNumber: "CO-001", title: "More pipe",
  description: null, amount: 500, reasonCode: "field_condition", status: "approved", decidedAt: null, decidedBy: "u-ctl",
  decidedByName: "ctl", decisionNote: null, createdBy: "u-owner", createdByName: "own", createdAt: null,
  postedEntryId: "e1", postedEntryStatus: "posted", selfDecided: false, ...over,
});

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  co.listChangeOrders.mockReset();
  co.decideChangeOrder.mockReset();
  dlg.appConfirm.mockReset();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

async function renderPanel() {
  await act(async () => {
    root.render(React.createElement(ChangeOrdersPanel, {
      orgId: "o1", projectId: "p1", canManage: true, actor: { uid: "u-owner", email: "owner@x.test" },
      accounts: [], parties: [], onMoneyMoved: () => undefined, setErr: () => undefined,
    }));
  });
  await act(async () => { await Promise.resolve(); });
}

describe("ChangeOrdersPanel — a failed read is said out loud (REL-2), never an empty panel", () => {
  it("a failed read renders an alert with the reason and a Retry, not the empty state", async () => {
    co.listChangeOrders.mockRejectedValueOnce(new Error("Couldn't read the change orders' cost entries: statement timeout"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await renderPanel();
    errSpy.mockRestore();
    const alert = host.querySelector('[role="alert"]');
    // REL-3: driver text that reached the panel is translated at the screen; the lead-in stays
    expect(alert?.textContent).toMatch(/Couldn't load the change orders \(Couldn't read the change orders' cost entries: The database took too long to answer — try again\.\)/);
    expect(host.textContent).not.toMatch(/No change orders/);
    // Retry reloads
    co.listChangeOrders.mockResolvedValueOnce([]);
    const retry = [...host.querySelectorAll("button")].find((b) => b.textContent === "Retry");
    await act(async () => { retry?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await act(async () => { await Promise.resolve(); });
    expect(co.listChangeOrders).toHaveBeenCalledTimes(2);
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.textContent).toMatch(/No change orders/);
  });

  it("an absent table (pre-migration) keeps the panel quiet", async () => {
    co.listChangeOrders.mockRejectedValueOnce(new Error("Could not find the table 'public.change_orders' in the schema cache"));
    await renderPanel();
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.textContent).toMatch(/No change orders/);
  });

  it("REL-3 (review fix): through the REAL listChangeOrders — whose error carries the translated sentence and the driver CODE — an absent table (42P01 / PGRST205) still keeps the panel quiet; a refused read is said in plain words", async () => {
    const real = await vi.importActual<typeof import("@/lib/changeOrders")>("@/lib/changeOrders");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      for (const error of [
        { message: 'relation "public.change_orders" does not exist', code: "42P01" },
        { message: "Could not find the table 'public.change_orders' in the schema cache", code: "PGRST205" },
      ]) {
        db.next = { data: null, error };
        co.listChangeOrders.mockImplementationOnce(real.listChangeOrders);
        act(() => root.unmount());
        root = createRoot(host);
        await renderPanel();
        expect(host.querySelector('[role="alert"]'), error.code).toBeNull();
        expect(host.textContent).toMatch(/No change orders/);
      }
      db.next = { data: null, error: { message: "permission denied for table change_orders", code: "42501" } };
      co.listChangeOrders.mockImplementationOnce(real.listChangeOrders);
      act(() => root.unmount());
      root = createRoot(host);
      await renderPanel();
      const alert = host.querySelector('[role="alert"]');
      expect(alert?.textContent).toMatch(/Couldn't load the change orders \(You don't have permission to see this\.\)/);
      expect(alert?.textContent).not.toMatch(/change_orders|permission denied for/);
    } finally {
      errSpy.mockRestore();
      db.next = { data: [], error: null };
    }
  });

  it("COST-4: approved COs whose entry is not posted are named beside the approved total, which excludes them", async () => {
    co.listChangeOrders.mockResolvedValueOnce([
      coOf({ id: "c1", amount: 500 }),
      coOf({ id: "c2", coNumber: "CO-002", amount: 20_000, postedEntryId: "e2", postedEntryStatus: "void" }),
    ]);
    await renderPanel();
    expect(host.textContent).toMatch(/1 approved · \$500(\.00)? total change/);
    expect(host.textContent).toMatch(/1 approved not on the ledger \(not in the budget\)/);
  });

  it("Approve passes the amount and the budget line the confirm showed (shownAmount, shownAccountId — the decision binds to both)", async () => {
    co.listChangeOrders.mockResolvedValue([coOf({ id: "c9", coNumber: "CO-120", amount: 900, status: "proposed", decidedBy: null, postedEntryId: null, postedEntryStatus: null })]);
    dlg.appConfirm.mockResolvedValue(true);
    co.decideChangeOrder.mockResolvedValue({ warning: null });
    await renderPanel();
    const approve = [...host.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes("Approve"));
    await act(async () => { approve?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await act(async () => { await Promise.resolve(); });
    expect(dlg.appConfirm.mock.calls[0][0].message).toMatch(/Approve CO-120 for \$900/);
    expect(co.decideChangeOrder).toHaveBeenCalledTimes(1);
    expect(co.decideChangeOrder.mock.calls[0][0]).toMatchObject({ decision: "approved", shownAmount: 900, shownAccountId: "a1" });
  });
});
