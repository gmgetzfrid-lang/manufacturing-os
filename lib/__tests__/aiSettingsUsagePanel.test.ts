// @vitest-environment jsdom
//
// intelligence Round G — I-05: the AI settings meter as RENDERED.
//   GOV-3   "Cap reached" / "locked" copy matches what the server enforces —
//           a $0 cap reads LOCKED, never "Cap reached" over an uncapped key
//   GOV-10  the cap editor appears only for a holder of ai.manage_caps; the
//           copy names who can raise a cap
//   GOV-4   an unreadable meter is an alert with a retry, not a vanished panel;
//           calls recorded without a cost are said, with the figure the
//           server counts each at
//   GOV-1   "Where it went" names each feature's spend
//   GOV-12  the key-storage notice names EXPORT_ENCRYPTION_KEY

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const kn = vi.hoisted(() => ({ getAiUsage: vi.fn(), setAiCap: vi.fn(async () => undefined) }));
const toast = vi.hoisted(() => ({ showToast: vi.fn() }));
vi.mock("@/lib/knowledge", () => ({
  getAiConnections: vi.fn(), saveAiConnection: vi.fn(), testAiConnection: vi.fn(), removeAiConnection: vi.fn(),
  saveEmbeddingKey: vi.fn(), removeEmbeddingKey: vi.fn(), testEmbeddingKey: vi.fn(),
  getAiUsage: kn.getAiUsage, setAiCap: kn.setAiCap,
}));
vi.mock("@/components/providers/ToastProvider", () => ({ useToast: () => toast }));
// usageServer is server-only; its constant is read here to hold the copy to it.
vi.mock("@/lib/supabaseAdmin", () => ({ supabaseAdmin: {} }));
vi.mock("@/components/providers/DialogProvider", () => ({ appConfirm: vi.fn(async () => true) }));

import { UsagePanel, KeyStorageNotice, opBreakdown, UNPRICED_CALL_DISPLAY_USD } from "@/components/knowledge/AiSettingsModal";
import { UNPRICED_CALL_USD } from "@/lib/ai/usageServer";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const base = {
  spentUsd: 0, capUsd: 10, percent: 0, inputTokens: 0, outputTokens: 0, asks: 0, avgPromptTokens: 0,
  monthLabel: "October 2026", calls: 0, byOp: {}, locked: false, canManageCaps: false,
};

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  kn.getAiUsage.mockReset();
  toast.showToast.mockReset();
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

async function render(el: React.ReactElement) {
  await act(async () => { root.render(el); });
  await act(async () => { await Promise.resolve(); });
}

describe("UsagePanel", () => {
  it("GOV-3: a $0 cap reads LOCKED and says who can lift it — it never says 'Cap reached' over an uncapped key", async () => {
    kn.getAiUsage.mockResolvedValueOnce({ ...base, capUsd: 0, percent: 100, locked: true });
    await render(React.createElement(UsagePanel, { orgId: "o1" }));
    expect(host.textContent).toMatch(/Locked · \$0\.00 spent/);
    expect(host.textContent).toMatch(/Your monthly cap is \$0 — AI is locked for you until someone who manages AI caps/);
    expect(host.textContent).not.toMatch(/unless an Admin raises the cap/);
  });

  it("GOV-3: at 100% of a real cap it says the server locks AI calls, naming who can raise it", async () => {
    kn.getAiUsage.mockResolvedValueOnce({ ...base, spentUsd: 10.2, percent: 100 });
    await render(React.createElement(UsagePanel, { orgId: "o1" }));
    expect(host.textContent).toMatch(/Cap reached — AI calls are locked until the 1st, unless someone who manages AI caps/);
  });

  it("GOV-1: 'Where it went' names each feature's spend, largest first", async () => {
    kn.getAiUsage.mockResolvedValueOnce({
      ...base, spentUsd: 4, percent: 40, calls: 7,
      byOp: { knowledgeAsk: { spentUsd: 0.5, calls: 5 }, knowledgeVision: { spentUsd: 3, calls: 1 }, knowledgeEmbed: { spentUsd: 0.5, calls: 1 } },
    });
    await render(React.createElement(UsagePanel, { orgId: "o1" }));
    expect(host.textContent).toMatch(/Where it went: Vision indexing \$3\.00 · Questions \$0\.50 · Meaning index \$0\.50/);
    expect(host.textContent).toMatch(/7 AI calls in all/);
  });

  it("GOV-10: the team table is read-only without ai.manage_caps; the editor appears for a holder", async () => {
    const team = [{ userId: "u2", name: "Eve", spentUsd: 1, asks: 1, calls: 2, inputTokens: 1, outputTokens: 1, capUsd: 0, locked: true, hasOverride: true, byOp: {} }];
    kn.getAiUsage.mockResolvedValueOnce({ ...base, orgCapUsd: 10, team, canManageCaps: false });
    await render(React.createElement(UsagePanel, { orgId: "o1" }));
    expect(host.querySelector("select")).toBeNull();
    expect([...host.querySelectorAll("button")].some((b) => b.textContent === "Set")).toBe(false);
    expect(host.textContent).toMatch(/locked/);
    expect(host.textContent).toMatch(/Manage AI spend caps/);

    kn.getAiUsage.mockResolvedValueOnce({ ...base, orgCapUsd: 10, team, canManageCaps: true });
    await act(async () => { root.unmount(); });
    root = createRoot(host);
    await render(React.createElement(UsagePanel, { orgId: "o1" }));
    expect(host.querySelector("select")).not.toBeNull();
    expect([...host.querySelectorAll("option")].some((o) => o.textContent === "$0 lock")).toBe(true);
    expect([...host.querySelectorAll("button")].some((b) => b.textContent === "Set")).toBe(true);
  });

  it("GOV-10: a holder who follows the default and raises it is told their own cap stays where it was", async () => {
    const team = [{ userId: "u1", name: "Ada", spentUsd: 10, asks: 1, calls: 2, inputTokens: 1, outputTokens: 1, capUsd: 10, locked: false, hasOverride: false, byOp: {} }];
    kn.getAiUsage.mockResolvedValue({ ...base, spentUsd: 10, percent: 100, orgCapUsd: 10, team, canManageCaps: true, selfFollowsDefault: true });
    await render(React.createElement(UsagePanel, { orgId: "o1" }));
    const input = host.querySelector("input") as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => { setter.call(input, "500"); input.dispatchEvent(new Event("input", { bubbles: true })); });
    const set = [...host.querySelectorAll("button")].find((b) => b.textContent === "Set")!;
    await act(async () => { set.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await act(async () => { await Promise.resolve(); });
    expect(kn.setAiCap).toHaveBeenCalledWith("o1", 500);
    expect(String(toast.showToast.mock.calls.at(-1)?.[0]?.title)).toMatch(/Default monthly cap set to \$500\.00 per person\. Your own cap stays at \$10\.00 — nobody raises their own cap/);
    kn.getAiUsage.mockReset();
  });

  it("GOV-4: calls recorded without a cost are said, with the figure the server counts each at", async () => {
    expect(UNPRICED_CALL_DISPLAY_USD).toBe(UNPRICED_CALL_USD);
    kn.getAiUsage.mockResolvedValueOnce({ ...base, spentUsd: 2, percent: 20, calls: 2, unpricedCalls: 2 });
    await render(React.createElement(UsagePanel, { orgId: "o1" }));
    expect(host.textContent).toMatch(/2 AI calls were recorded without a cost this month; each is counted at \$1\.00/);
    expect(host.textContent).not.toMatch(/20260916/);
  });

  it("GOV-4: an unreadable meter is an alert with the server's sentence and a Retry", async () => {
    kn.getAiUsage.mockRejectedValueOnce(new Error("AI usage can't be read right now, so AI calls are refused until it can (couldn't read the usage ledger: timeout)."));
    await render(React.createElement(UsagePanel, { orgId: "o1" }));
    expect(host.querySelector('[role="alert"]')?.textContent).toMatch(/refused until it can/);
    kn.getAiUsage.mockResolvedValueOnce({ ...base });
    const retry = [...host.querySelectorAll("button")].find((b) => b.textContent === "Retry");
    await act(async () => { retry?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await act(async () => { await Promise.resolve(); });
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });
});

describe("KeyStorageNotice (GOV-12)", () => {
  it("names the server setting when keys are not encrypted, and counts the org's unsealed keys for a controller", async () => {
    await render(React.createElement(KeyStorageNotice, { storage: { encrypted: false, plaintextRefused: true, yoursUnsealed: 0, orgUnsealed: 3 } }));
    expect(host.textContent).toMatch(/no EXPORT_ENCRYPTION_KEY, so it refuses to save AI keys/);
    expect(host.textContent).toMatch(/3 stored AI keys are not encrypted at rest/);
  });
  it("says keys are encrypted when they are", async () => {
    await render(React.createElement(KeyStorageNotice, { storage: { encrypted: true, plaintextRefused: true, yoursUnsealed: 0 } }));
    expect(host.textContent).toMatch(/encrypted at rest with the server's EXPORT_ENCRYPTION_KEY/);
  });
});

describe("opBreakdown", () => {
  it("merges lines that share a name, drops zeros, unknown ops show as themselves", () => {
    expect(opBreakdown({ checklistSegment: { spentUsd: 1, calls: 1 }, checklistAssess: { spentUsd: 2, calls: 1 }, x: { spentUsd: 0, calls: 1 }, brandNew: { spentUsd: 0.5, calls: 1 } }))
      .toEqual([{ label: "Checklists", spentUsd: 3 }, { label: "brandNew", spentUsd: 0.5 }]);
  });
});
