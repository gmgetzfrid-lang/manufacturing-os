// @vitest-environment jsdom
//
// projects-tab REL-10 / REL-2 (J5 CHARTS fix passes) — the Costs tab as
// RENDERED when its FIRST load fails. Every list starts as an empty array,
// and the charts draw the EXAMPLE picture for a project with no accounts and
// no entries — so a transient read failure on first open showed the error
// banner with the watermarked example (and "No budget lines or entries yet")
// beneath it. The second review found the rest of the tab did the same: the
// stat strip read Budget / Committed / Spent / Available $0.00 and the
// accounts table said "No cost accounts yet … Create the first one above" on
// a project that may hold millions — the new-project empty state REL-2 rules
// out. Nothing that draws from the read renders until one succeeds; a failed
// first load says so once, with a retry. A later failed refresh keeps the
// last good read on screen. The tab's bars wear the S-curve's series colours
// (CHART-2: Spent is categorical slot 1, Committed slot 2).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const reads = vi.hoisted(() => ({
  listAccounts: vi.fn(), listEntries: vi.fn(), listParties: vi.fn(),
  listCostDocs: vi.fn(), listLedgerOrphans: vi.fn(), listChangeOrders: vi.fn(),
}));

vi.mock("@/lib/supabase", () => {
  // The milestone read: from("milestones").select(…).eq(…).order(…) → { data, error }.
  const chain: Record<string, unknown> = {};
  const handler: ProxyHandler<Record<string, unknown>> = {
    get(_t, prop: string) {
      if (prop === "then") {
        return (resolve: (v: unknown) => void) => resolve({ data: [], error: null });
      }
      return () => new Proxy(chain, handler);
    },
  };
  return { supabase: { from: () => new Proxy(chain, handler) } };
});
vi.mock("@/lib/audit", () => ({ logAuditAction: vi.fn() }));
vi.mock("@/lib/notify/dispatch", () => ({ emit: vi.fn() }));
vi.mock("@/lib/storage", () => ({ uploadToPath: vi.fn(), deleteFile: vi.fn() }));
vi.mock("@/components/providers/DialogProvider", () => ({ appConfirm: vi.fn(), appPrompt: vi.fn() }));
// The two panels render a marker (and QuotesPanel a button that fires its
// onChanged, i.e. a refresh) so the test can see whether they are drawn.
vi.mock("@/components/projects/cost/QuotesPanel", async () => {
  const R = await import("react");
  return {
    default: ({ onChanged }: { onChanged: () => void }) =>
      R.createElement("button", { type: "button", "data-panel": "quotes", onClick: onChanged }, "quotes panel"),
  };
});
vi.mock("@/components/projects/cost/ChangeOrdersPanel", async () => {
  const R = await import("react");
  return { default: () => R.createElement("div", { "data-panel": "change-orders" }) };
});
vi.mock("@/lib/costs", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/costs")>();
  return { ...real, listAccounts: reads.listAccounts, listEntries: reads.listEntries, listParties: reads.listParties };
});
vi.mock("@/lib/costDocs", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/costDocs")>();
  return { ...real, listCostDocs: reads.listCostDocs, listLedgerOrphans: reads.listLedgerOrphans };
});
vi.mock("@/lib/changeOrders", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/changeOrders")>();
  return { ...real, listChangeOrders: reads.listChangeOrders };
});

import CostsTab from "@/components/projects/CostsTab";
import type { CostAccount, CostEntry } from "@/lib/costs";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const account: CostAccount = {
  id: "a1", projectId: "p1", code: "01-100", name: "Piping", costType: "subcontract",
  budget: 2_000_000, currency: "USD", partyId: null, wbsMilestoneId: null, status: "active",
};

const entry = (over: Partial<CostEntry>): CostEntry => ({
  id: "e1", costAccountId: "a1", projectId: "p1", partyId: null, entryType: "actual", amount: 0,
  entryDate: "2026-06-01", description: null, reference: null, status: "posted", sourceDocumentId: null, ...over,
});

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  // jsdom has no layout: the tab scrolls its error banner into view (UX-8).
  Element.prototype.scrollIntoView = vi.fn();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  for (const f of Object.values(reads)) f.mockReset();
  reads.listEntries.mockResolvedValue([]);
  reads.listParties.mockResolvedValue([]);
  reads.listCostDocs.mockResolvedValue([]);
  reads.listLedgerOrphans.mockResolvedValue({ available: false, docs: [], changeOrders: [] });
  reads.listChangeOrders.mockResolvedValue([]);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

async function settle() {
  for (let i = 0; i < 3; i++) await act(async () => { await Promise.resolve(); });
}

async function mount() {
  await act(async () => {
    root.render(React.createElement(CostsTab, { orgId: "o1", projectId: "p1", canManage: true, uid: "u1" }));
  });
  await settle();
}

async function click(el: Element | undefined | null) {
  expect(el).toBeTruthy();
  await act(async () => { el!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await settle();
}

const button = (text: string) => [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);

describe("REL-10 / REL-2 · a failed FIRST load shows a failure state — never an empty project", () => {
  it("the first read rejects: the banner and one stated failure panel with a retry — no example, no $0 tiles, no invitation to start over", async () => {
    reads.listAccounts.mockRejectedValueOnce(new Error("Couldn't read the cost accounts: network error"));
    await mount();

    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Couldn't read the cost accounts: network error");
    const failure = host.querySelector('[data-empty="cost-data"]');
    expect(failure?.textContent).toContain("couldn't be read");
    // REL-10: the example frame and its figures are nowhere on the page.
    expect(host.textContent).not.toMatch(/example/i);
    expect(host.textContent).not.toContain("No budget lines or entries yet");
    expect(host.querySelector('[data-mark="watermark"]')).toBeNull();
    expect(host.querySelector("svg[role=img]")).toBeNull();
    // REL-2: none of the new-project empty state — no money figure at all, no
    // "No cost accounts yet … Create the first one", no New account button,
    // and no panel that draws from the read.
    expect(host.textContent).not.toMatch(/\$\s?\d/);
    expect(host.textContent).not.toMatch(/Available|uncommitted|Budget burn/);
    expect(host.textContent).not.toContain("No cost accounts yet");
    expect(host.textContent).not.toContain("Create the first one");
    expect(button("New account")).toBeUndefined();
    expect(host.querySelector('[data-panel="quotes"]')).toBeNull();
    expect(host.querySelector('[data-panel="change-orders"]')).toBeNull();
    expect(host.textContent).not.toContain("Contractors & vendors");

    // Retry: the read succeeds and the real tab replaces the failure panel.
    reads.listAccounts.mockResolvedValueOnce([account]);
    await click(button("Try again"));
    expect(host.querySelector('[data-empty="cost-data"]')).toBeNull();
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.textContent).toContain("Burn by budget line");
    expect(host.textContent).toContain("01-100 Piping");
    expect(host.textContent).toContain("$2,000,000");
    expect(host.querySelector('[data-panel="quotes"]')).not.toBeNull();
    expect(host.querySelector('[data-panel="change-orders"]')).not.toBeNull();
    expect(button("New account")).toBeTruthy();
    expect(host.textContent).not.toMatch(/example/i);
  });

  it("a failed refresh AFTER a good read keeps the last good figures on screen, under the banner", async () => {
    reads.listAccounts.mockResolvedValueOnce([account]);
    await mount();
    expect(host.textContent).toContain("$2,000,000");

    reads.listAccounts.mockRejectedValueOnce(new Error("Couldn't read the cost accounts: timeout"));
    await click(host.querySelector('[data-panel="quotes"]'));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("timeout");
    expect(host.querySelector('[data-empty="cost-data"]')).toBeNull();
    expect(host.textContent).toContain("$2,000,000");
    expect(host.textContent).toContain("01-100 Piping");
  });

  it("a successful first read of an empty project still shows the example (the one place it belongs)", async () => {
    reads.listAccounts.mockResolvedValueOnce([]);
    await mount();
    expect(host.querySelector('[data-empty="cost-data"]')).toBeNull();
    expect(host.textContent).toContain("No budget lines or entries yet");
    expect(host.textContent).toContain("No cost accounts yet");
    expect(host.querySelectorAll('[data-mark="watermark"]').length).toBeGreaterThanOrEqual(2);
  });
});

describe("CHART-2 · the tab's bars wear the S-curve's series colours", () => {
  it("the budget burn bar and each account's bar draw Spent in slot 1 and Committed in slot 2 — never the brand accent or gradient", async () => {
    reads.listAccounts.mockResolvedValueOnce([account]);
    reads.listEntries.mockResolvedValueOnce([
      entry({ id: "c1", entryType: "commitment", amount: 900_000 }),
      entry({ id: "x1", entryType: "actual", amount: 300_000 }),
    ]);
    await mount();

    const bars = [...host.querySelectorAll<HTMLElement>('div[data-series="spent"], div[data-series="committed"]')];
    const spent = bars.filter((b) => b.dataset.series === "spent");
    const committed = bars.filter((b) => b.dataset.series === "committed");
    // The burn bar's Spent and Committed, and the account row's Spent.
    expect(spent).toHaveLength(2);
    expect(committed).toHaveLength(1);
    for (const b of spent) expect(b.style.background).toBe("var(--viz-cat-1)");
    expect(committed[0].style.background).toBe("var(--viz-cat-2)");
    for (const b of bars) expect(b.className).not.toMatch(/brand-gradient|color-accent/);
    // The S-curve below draws the same two slots for the same two series.
    expect(host.querySelector('svg [data-series="spent"]')?.getAttribute("stroke")).toBe("var(--viz-cat-1)");
    expect(host.querySelector('svg [data-series="committed"]')?.getAttribute("stroke")).toBe("var(--viz-cat-2)");
  });

  it("the burn list and the accounts table agree on every line: the same currency, the same scale, the same flag", async () => {
    // REL-11 (third review): the list printed a CAD line in the project's
    // first currency and scaled every bar to the biggest spender, while the
    // table below prints the line's own currency and scales to its budget.
    // Fourth review: a line over budget on exposure alone read "over budget"
    // in the table and "over-committed" in the list; a line 1% through its
    // budget drew 1% in the table and 2% in the list; and a legacy line with
    // no currency printed in the project's first currency (CAD here) though
    // the rollup counts it as USD.
    reads.listAccounts.mockResolvedValueOnce([
      { ...account, id: "a2", code: "01-200", name: "Scaffolding", budget: 42_000, currency: "CAD" },
      { ...account, budget: 190_000 },
      { ...account, id: "a3", code: "01-300", name: "Legacy", budget: 30_000, currency: null },
      { ...account, id: "a4", code: "01-400", name: "Tiny", budget: 100_000, currency: "CAD" },
      { ...account, id: "a5", code: "01-500", name: "Exposure", budget: 100_000, currency: "CAD" },
    ]);
    reads.listEntries.mockResolvedValueOnce([
      entry({ id: "x1", amount: 50_000 }),
      entry({ id: "x2", costAccountId: "a2", amount: 45_000 }),
      entry({ id: "x3", costAccountId: "a3", amount: 12_000 }),
      entry({ id: "x4", costAccountId: "a4", amount: 1_000 }),
      // $60k invoiced by party B, an $80k commitment to party A with nothing
      // invoiced against it: exposure $140k on a $100k budget, spent $60k.
      entry({ id: "x5", costAccountId: "a5", partyId: "pB", amount: 60_000 }),
      entry({ id: "c5", costAccountId: "a5", partyId: "pA", entryType: "commitment", amount: 80_000 }),
    ]);
    await mount();
    const tableRow = (name: string) =>
      [...host.querySelectorAll("button")].find((b) => b.querySelector("span.font-bold")?.textContent === name)!;
    const listRow = (label: string) => host.querySelector<HTMLElement>(`[title^="${label} · "]`)!;
    const cases: Array<[string, string, string, number, boolean]> = [
      // name, list label, money, bar width %, over budget
      ["Piping", "01-100 Piping", "$50,000", (50_000 / 190_000) * 100, false],
      ["Scaffolding", "01-200 Scaffolding", "CA$45,000", 100, true],
      ["Legacy", "01-300 Legacy", "$12,000", 40, false],
      ["Tiny", "01-400 Tiny", "CA$1,000.00", 1, false],
      ["Exposure", "01-500 Exposure", "CA$60,000", 60, true],
    ];
    for (const [name, label, money, pct, over] of cases) {
      const t = tableRow(name), l = listRow(label);
      expect(t.textContent).toContain(money);
      expect(l.getAttribute("title")).toBe(`${label} · ${money}`);
      const tableW = parseFloat(t.querySelector<HTMLElement>('div[data-series="spent"]')!.style.width);
      const listW = parseFloat(l.querySelector<HTMLElement>('[data-bar="value"]')!.style.width);
      expect(tableW).toBeCloseTo(pct, 6);
      expect(listW).toBeCloseTo(tableW, 6);
      // One flag word per state, in both places.
      expect(t.textContent!.includes("over budget")).toBe(over);
      expect(l.textContent!.includes("over budget")).toBe(over);
      expect(l.textContent).not.toContain("over-committed");
    }
    expect(listRow("01-200 Scaffolding").textContent).toContain("of CA$42,000 budget");
    expect(listRow("01-100 Piping").textContent).not.toContain("CA$");
    expect(tableRow("Legacy").textContent).not.toContain("CA$");
    expect(listRow("01-300 Legacy").textContent).not.toContain("CA$");
    // The mixed-currency banner counts the legacy line as USD, as both print it.
    expect(host.textContent).toContain("Accounts use mixed currencies (CAD, USD)");
  });

  it("over budget, Spent turns rose on both bars (the alarm wins over the series colour)", async () => {
    reads.listAccounts.mockResolvedValueOnce([account]);
    reads.listEntries.mockResolvedValueOnce([entry({ id: "x1", entryType: "actual", amount: 2_400_000 })]);
    await mount();
    const spent = [...host.querySelectorAll<HTMLElement>('div[data-series="spent"]')];
    expect(spent).toHaveLength(2);
    for (const b of spent) {
      expect(b.className).toContain("bg-rose-500");
      expect(b.style.background).toBe("");
    }
  });
});
