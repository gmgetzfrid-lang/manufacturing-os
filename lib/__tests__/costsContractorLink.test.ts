// @vitest-environment jsdom
// projects Round G — J10, COST-12 dw1 / MON-7 dw1 (the Costs tab half). The
// Contractors panel links a contractor to its Known Companies record: on
// add (suggested from the name, changeable to another or to none) and later
// for an UNLINKED contractor only — a linked one shows its company and offers
// no relink. A link the registry objects to asks for the reason and goes
// again with it; an unreadable registry never blocks adding. The kind list is
// the one list (rental included).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const m = vi.hoisted(() => ({
  listAccounts: vi.fn(), listEntries: vi.fn(), listParties: vi.fn(),
  saveParty: vi.fn(), linkPartyToCompany: vi.fn(), listCompanies: vi.fn(),
  listCostDocs: vi.fn(), listLedgerOrphans: vi.fn(), listChangeOrders: vi.fn(),
  appPrompt: vi.fn(),
}));

vi.mock("@/lib/supabase", () => {
  const chain: Record<string, unknown> = {};
  const handler: ProxyHandler<Record<string, unknown>> = {
    get(_t, prop: string) {
      if (prop === "then") return (resolve: (v: unknown) => void) => resolve({ data: [], error: null });
      return () => new Proxy(chain, handler);
    },
  };
  return { supabase: { from: () => new Proxy(chain, handler) } };
});
vi.mock("@/lib/audit", () => ({ logAuditAction: vi.fn() }));
vi.mock("@/lib/notify/dispatch", () => ({ emit: vi.fn() }));
vi.mock("@/lib/storage", () => ({ uploadToPath: vi.fn(), deleteFile: vi.fn() }));
vi.mock("@/components/providers/DialogProvider", () => ({ appConfirm: vi.fn(), appPrompt: m.appPrompt }));
vi.mock("@/components/projects/cost/QuotesPanel", async () => {
  const R = await import("react");
  return { default: () => R.createElement("div", { "data-panel": "quotes" }) };
});
vi.mock("@/components/projects/cost/ChangeOrdersPanel", async () => {
  const R = await import("react");
  return { default: () => R.createElement("div", { "data-panel": "change-orders" }) };
});
vi.mock("@/lib/costs", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/costs")>();
  return { ...real, listAccounts: m.listAccounts, listEntries: m.listEntries, listParties: m.listParties, saveParty: m.saveParty, linkPartyToCompany: m.linkPartyToCompany };
});
vi.mock("@/lib/companies", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/companies")>();
  return { ...real, listCompanies: m.listCompanies };
});
vi.mock("@/lib/costDocs", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/costDocs")>();
  return { ...real, listCostDocs: m.listCostDocs, listLedgerOrphans: m.listLedgerOrphans };
});
vi.mock("@/lib/changeOrders", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/changeOrders")>();
  return { ...real, listChangeOrders: m.listChangeOrders };
});

import CostsTab from "@/components/projects/CostsTab";
import type { CostParty } from "@/lib/costs";
import type { Company } from "@/lib/companies";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const company = (id: string, name: string, status: Company["status"] = "active"): Company => ({
  id, orgId: "o1", name, kind: "contractor", trade: null, status,
  contactName: null, contactEmail: null, contactPhone: null, qualityManualDocId: null, qualityManualScore: null,
  qualityManualGaps: null, qualityManualReviewedAt: null, qualityManualPagesRead: null, qualityManualPagesTotal: null,
  notes: null, createdAt: null,
});
const party = (id: string, name: string, companyId: string | null): CostParty => ({
  id, projectId: "p1", name, kind: "contractor", trade: null, defaultRate: null, contractValue: null,
  contactName: null, contactEmail: null, status: "active", companyId,
});

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  for (const f of Object.values(m)) f.mockReset();
  m.listAccounts.mockResolvedValue([]);
  m.listEntries.mockResolvedValue([]);
  m.listParties.mockResolvedValue([party("pa", "Gulf Mechanical", null), party("pb", "Bayou Scaffold", "c2")]);
  m.listCompanies.mockResolvedValue([company("c1", "Gulf Mechanical"), company("c2", "Bayou Scaffold"), company("c9", "Apex Industrial", "do_not_use")]);
  m.listCostDocs.mockResolvedValue([]);
  m.listLedgerOrphans.mockResolvedValue({ available: false, docs: [], changeOrders: [] });
  m.listChangeOrders.mockResolvedValue([]);
  m.saveParty.mockResolvedValue({ ok: true });
  m.linkPartyToCompany.mockResolvedValue({ ok: true });
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

async function settle() { for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); }); }
async function click(el: Element | undefined | null) {
  expect(el).toBeTruthy();
  await act(async () => { el!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await settle();
}
async function setValue(el: HTMLInputElement | HTMLSelectElement, value: string) {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
}
const button = (text: string) => [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);
const panel = () => host.querySelector('[data-panel="contractors"]') as HTMLElement;

async function openContractors() {
  await act(async () => { root.render(React.createElement(CostsTab, { orgId: "o1", projectId: "p1", canManage: true, uid: "u1" })); });
  await settle();
  await click([...panel().querySelectorAll("button")].find((b) => b.textContent?.includes("Contractors")));
}

describe("COST-12 dw1 — the Contractors panel links a contractor to its Known Company", () => {
  it("a linked contractor shows its company (no relink); an unlinked one offers the link, suggested from its name", async () => {
    await openContractors();
    const linked = panel().querySelector('[data-party="pb"]')!;
    const a = linked.querySelector("a")!;
    expect(a.textContent).toBe("Known company: Bayou Scaffold");
    expect(a.getAttribute("href")).toBe("/companies/c2");
    expect(linked.textContent).not.toContain("Link to a known company");

    const unlinked = panel().querySelector('[data-party="pa"]')!;
    expect(unlinked.textContent).toContain("Unlinked");
    await click([...unlinked.querySelectorAll("button")].find((b) => b.textContent === "Link to a known company"));
    const pick = unlinked.querySelector('select[aria-label="Known company for Gulf Mechanical"]') as HTMLSelectElement;
    expect(pick.value).toBe("c1");
    expect([...pick.options].map((o) => o.textContent)).toContain("Apex Industrial — DO NOT USE");
    await click(button("Link"));
    expect(m.linkPartyToCompany).toHaveBeenCalledWith(expect.objectContaining({ orgId: "o1", partyId: "pa", companyId: "c1", overrideReason: null }));
    expect(m.listParties).toHaveBeenCalledTimes(2);   // the tab re-read after the link
  });

  it("a link the registry objects to asks why, and goes again with the reason", async () => {
    m.linkPartyToCompany
      .mockResolvedValueOnce({ ok: false, error: "\"Gulf Mechanical\" could be Apex Industrial…", needsOverride: { companyId: "c9", company: "Apex Industrial" } })
      .mockResolvedValueOnce({ ok: true });
    m.appPrompt.mockResolvedValueOnce("Different company — licence checked");
    await openContractors();
    await click(button("Link to a known company"));
    await click(button("Link"));
    expect(m.appPrompt).toHaveBeenCalledWith(expect.objectContaining({ title: "Link despite Apex Industrial?" }));
    expect(m.linkPartyToCompany).toHaveBeenLastCalledWith(expect.objectContaining({ overrideReason: "Different company — licence checked" }));
  });

  it("adding: the kind list is the one list, and the Known company follows the name unless picked", async () => {
    await openContractors();
    const kind = panel().querySelector('select[aria-label="Kind"]') as HTMLSelectElement;
    expect([...kind.options].map((o) => o.value)).toEqual(["contractor", "vendor", "rental", "internal"]);
    await setValue(panel().querySelector('input[aria-label="Contractor name"]') as HTMLInputElement, "gulf mechanical");
    const known = panel().querySelector('select[aria-label="Known company"]') as HTMLSelectElement;
    expect(known.value).toBe("c1");
    await setValue(kind, "rental");
    await click(button("Add"));
    expect(m.saveParty).toHaveBeenCalledWith(expect.objectContaining({ patch: expect.objectContaining({ name: "gulf mechanical", kind: "rental", companyId: "c1" }) }));
    // Picking "none" adds it unlinked.
    await setValue(panel().querySelector('input[aria-label="Contractor name"]') as HTMLInputElement, "Bayou Scaffold");
    await setValue(panel().querySelector('select[aria-label="Known company"]') as HTMLSelectElement, "");
    await click(button("Add"));
    expect(m.saveParty.mock.calls[1][0].patch).not.toHaveProperty("companyId");
  });

  it("an unreadable registry says so and never blocks adding — the contractor goes in unlinked", async () => {
    m.listCompanies.mockRejectedValueOnce(new Error("You don't have permission to see this."));
    await openContractors();
    expect(panel().querySelector('[role="alert"]')?.textContent).toContain("couldn't be loaded");
    expect(button("Link to a known company")).toBeUndefined();
    expect(panel().querySelector('select[aria-label="Known company"]')).toBeNull();
    await setValue(panel().querySelector('input[aria-label="Contractor name"]') as HTMLInputElement, "Gulf Mechanical");
    await click(button("Add"));
    expect(m.saveParty).toHaveBeenCalledTimes(1);
    expect(m.saveParty.mock.calls[0][0].patch).not.toHaveProperty("companyId");
  });
});
