// @vitest-environment jsdom
//
// projects-tab REL-10 (J5 CHARTS fix pass) — the Costs tab as RENDERED when
// its FIRST load fails. accounts and entries start as empty arrays, and the
// charts draw the EXAMPLE picture for a project with no accounts and no
// entries — so before this fix a transient read failure on first open showed
// the error banner with the watermarked example (and "No budget lines or
// entries yet") beneath it, on a project that may hold millions. The picture
// now draws only from a successful read; a failed first load says so, with a
// retry, and a later successful read draws the real picture.

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
vi.mock("@/components/projects/cost/QuotesPanel", () => ({ default: () => null }));
vi.mock("@/components/projects/cost/ChangeOrdersPanel", () => ({ default: () => null }));
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
import type { CostAccount } from "@/lib/costs";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const account: CostAccount = {
  id: "a1", projectId: "p1", code: "01-100", name: "Piping", costType: "subcontract",
  budget: 2_000_000, currency: "USD", partyId: null, wbsMilestoneId: null, status: "active",
};

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

describe("REL-10 · a failed FIRST load never brings the example back", () => {
  it("the first read rejects: the banner, a stated placeholder with a retry — no example picture", async () => {
    reads.listAccounts.mockRejectedValueOnce(new Error("Couldn't read the cost accounts: network error"));
    await act(async () => {
      root.render(React.createElement(CostsTab, { orgId: "o1", projectId: "p1", canManage: true, uid: "u1" }));
    });
    await settle();

    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Couldn't read the cost accounts: network error");
    const placeholder = host.querySelector('[data-empty="cost-picture"]');
    expect(placeholder?.textContent).toContain("couldn't be read");
    // The example frame and its figures are nowhere on the page.
    expect(host.textContent).not.toMatch(/example/i);
    expect(host.textContent).not.toContain("No budget lines or entries yet");
    expect(host.querySelector('[data-mark="watermark"]')).toBeNull();
    expect(host.querySelector("svg[role=img]")).toBeNull();

    // Retry: the read succeeds and the real picture replaces the placeholder.
    reads.listAccounts.mockResolvedValueOnce([account]);
    const retry = [...host.querySelectorAll("button")].find((b) => b.textContent === "Try again");
    expect(retry).toBeTruthy();
    await act(async () => { retry!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await settle();
    expect(host.querySelector('[data-empty="cost-picture"]')).toBeNull();
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.textContent).toContain("Burn by budget line");
    expect(host.textContent).toContain("01-100 Piping");
    expect(host.textContent).not.toMatch(/example/i);
  });

  it("a successful first read of an empty project still shows the example (the one place it belongs)", async () => {
    reads.listAccounts.mockResolvedValueOnce([]);
    await act(async () => {
      root.render(React.createElement(CostsTab, { orgId: "o1", projectId: "p1", canManage: true, uid: "u1" }));
    });
    await settle();
    expect(host.querySelector('[data-empty="cost-picture"]')).toBeNull();
    expect(host.textContent).toContain("No budget lines or entries yet");
    expect(host.querySelectorAll('[data-mark="watermark"]').length).toBeGreaterThanOrEqual(2);
  });
});
