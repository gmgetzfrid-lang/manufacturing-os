// @vitest-environment jsdom
//
// intelligence Round G — I-05: the AI settings meter as RENDERED.
//   GOV-3   "Cap reached" / "locked" copy matches what the server enforces —
//           a $0 cap reads LOCKED, never "Cap reached" over an uncapped key
//   GOV-10  the cap editor appears only for a holder of ai.manage_caps; the
//           copy names who can raise a cap (and tells a sole holder their own
//           raise goes through, recorded); what happened to the setter's own
//           cap is read from the server's answer to the save, never inferred
//           from what the panel read when it opened
//   GOV-4   an unreadable meter is an alert with a retry, not a vanished panel;
//           calls recorded without a cost are said, with the figure the
//           server counts each at
//   GOV-1   "Where it went" names each feature's spend
//   GOV-12  the key-storage notice names EXPORT_ENCRYPTION_KEY

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const kn = vi.hoisted(() => ({ getAiUsage: vi.fn(), setAiCap: vi.fn(async (): Promise<Record<string, unknown>> => ({ ok: true })) }));
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

import { UsagePanel, KeyStorageNotice, opBreakdown, tokenLine, UNPRICED_CALL_DISPLAY_USD } from "@/components/knowledge/AiSettingsModal";
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
  kn.setAiCap.mockReset();
  kn.setAiCap.mockResolvedValue({ ok: true });
  toast.showToast.mockReset();
});

/** Type `value` into the default-cap input and press Set. */
async function setDefaultCap(value: string) {
  const input = host.querySelector("input") as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => { setter.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
  const set = [...host.querySelectorAll("button")].find((b) => b.textContent === "Set")!;
  await act(async () => { set.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await act(async () => { await Promise.resolve(); });
}
const lastToast = () => String(toast.showToast.mock.calls.at(-1)?.[0]?.title);
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
    kn.setAiCap.mockResolvedValueOnce({ ok: true, capUsd: 500, locked: false, selfHeldAtUsd: 10 });
    await render(React.createElement(UsagePanel, { orgId: "o1" }));
    await setDefaultCap("500");
    expect(kn.setAiCap).toHaveBeenCalledWith("o1", 500);
    expect(lastToast()).toMatch(/Default monthly cap set to \$500\.00 per person\. Your own cap stays at \$10\.00 — nobody raises their own cap/);
    kn.getAiUsage.mockReset();
  });

  it("GOV-10: a SOLE holder is told the default raise includes their own cap, and that it is recorded — not sent to a person who doesn't exist", async () => {
    const team = [{ userId: "u1", name: "Ada", spentUsd: 10, asks: 1, calls: 2, inputTokens: 1, outputTokens: 1, capUsd: 10, locked: false, hasOverride: false, byOp: {} }];
    kn.getAiUsage.mockResolvedValue({ ...base, spentUsd: 10, percent: 100, orgCapUsd: 10, team, canManageCaps: true, selfFollowsDefault: true, soleCapsHolder: true });
    await render(React.createElement(UsagePanel, { orgId: "o1" }));
    expect(host.textContent).toMatch(/You're the only person who manages AI caps here, so you can raise your own/);
    expect(host.textContent).not.toMatch(/Nobody can raise their own cap/);
    kn.setAiCap.mockResolvedValueOnce({ ok: true, capUsd: 50, locked: false, soleHolder: true });
    await setDefaultCap("50");
    const title = lastToast();
    expect(title).toMatch(/Default monthly cap set to \$50\.00 per person, yours included — you're the only person who manages AI caps here/);
    expect(title).not.toMatch(/another person who manages AI caps has to/);
    kn.getAiUsage.mockReset();
  });

  it("GOV-10: the toast follows the SERVER's answer, not the roster the panel read — a holder granted since the panel opened means the setter was held", async () => {
    const team = [{ userId: "u1", name: "Ada", spentUsd: 10, asks: 1, calls: 2, inputTokens: 1, outputTokens: 1, capUsd: 10, locked: false, hasOverride: false, byOp: {} }];
    // the panel opened when Ada was the sole holder; a second Admin was granted the capability since
    kn.getAiUsage.mockResolvedValue({ ...base, spentUsd: 10, percent: 100, orgCapUsd: 10, team, canManageCaps: true, selfFollowsDefault: true, soleCapsHolder: true });
    kn.setAiCap.mockResolvedValueOnce({ ok: true, capUsd: 20, locked: false, selfHeldAtUsd: 10 });
    await render(React.createElement(UsagePanel, { orgId: "o1" }));
    await setDefaultCap("20");
    expect(lastToast()).toMatch(/Default monthly cap set to \$20\.00 per person\. Your own cap stays at \$10\.00/);
    expect(lastToast()).not.toMatch(/yours included/);
    kn.getAiUsage.mockReset();
  });

  it("GOV-10: …and the other way — the roster read failed (soleCapsHolder unknown), the server raised a sole holder's own cap with the default: the toast says so", async () => {
    const team = [{ userId: "u1", name: "Ada", spentUsd: 10, asks: 1, calls: 2, inputTokens: 1, outputTokens: 1, capUsd: 10, locked: false, hasOverride: false, byOp: {} }];
    kn.getAiUsage.mockResolvedValue({ ...base, spentUsd: 10, percent: 100, orgCapUsd: 10, team, canManageCaps: true, selfFollowsDefault: true });
    kn.setAiCap.mockResolvedValueOnce({ ok: true, capUsd: 20, locked: false, soleHolder: true });
    await render(React.createElement(UsagePanel, { orgId: "o1" }));
    await setDefaultCap("20");
    expect(lastToast()).toMatch(/per person, yours included — you're the only person who manages AI caps here/);
    expect(lastToast()).not.toMatch(/Your own cap stays/);
    // a setter with an override of their own: neither held nor raised — the plain sentence
    kn.setAiCap.mockResolvedValueOnce({ ok: true, capUsd: 30, locked: false });
    await setDefaultCap("30");
    expect(lastToast()).toBe("Default monthly cap set to $30.00 per person.");
    kn.getAiUsage.mockReset();
  });

  it("GOV-10: a sole holder who raises their OWN per-person cap is told it went through and is recorded", async () => {
    const team = [{ userId: "u1", name: "Ada", spentUsd: 10, asks: 1, calls: 2, inputTokens: 1, outputTokens: 1, capUsd: 10, locked: false, hasOverride: false, byOp: {} }];
    kn.getAiUsage.mockResolvedValue({ ...base, orgCapUsd: 10, team, canManageCaps: true, soleCapsHolder: true });
    kn.setAiCap.mockResolvedValueOnce({ ok: true, capUsd: 50, locked: false, soleHolder: true });
    await render(React.createElement(UsagePanel, { orgId: "o1" }));
    const select = host.querySelector("select") as HTMLSelectElement;
    const option = [...select.options].find((o) => o.value === "50")!;
    await act(async () => { select.value = option.value; select.dispatchEvent(new Event("change", { bubbles: true })); });
    await act(async () => { await Promise.resolve(); });
    expect(kn.setAiCap).toHaveBeenCalledWith("o1", 50, "u1");
    expect(lastToast()).toMatch(/Ada's monthly cap set to \$50\. You're the only person who manages AI caps here, so your own raise went through — it is recorded in the audit log\./);
    kn.getAiUsage.mockReset();
  });

  it("GOV-10: a refused save is said in the server's words and the panel re-reads what is stored (a 409 can follow a change that landed)", async () => {
    const team = [{ userId: "u1", name: "Ada", spentUsd: 10, asks: 1, calls: 2, inputTokens: 1, outputTokens: 1, capUsd: 10, locked: false, hasOverride: false, byOp: {} }];
    kn.getAiUsage.mockResolvedValue({ ...base, spentUsd: 10, percent: 100, orgCapUsd: 10, team, canManageCaps: true, selfFollowsDefault: true });
    await render(React.createElement(UsagePanel, { orgId: "o1" }));
    const reads = kn.getAiUsage.mock.calls.length;
    kn.setAiCap.mockRejectedValueOnce(new Error("The default monthly cap is now $100, but your own cap rose to $100 while it was being saved — another cap change landed at the same time — so it was put back at $10."));
    await setDefaultCap("100");
    expect(toast.showToast.mock.calls.at(-1)?.[0]).toMatchObject({ type: "error" });
    expect(lastToast()).toMatch(/so it was put back at \$10/);
    await act(async () => { await Promise.resolve(); });
    expect(kn.getAiUsage.mock.calls.length).toBeGreaterThan(reads);
    kn.getAiUsage.mockReset();
  });

  it("GOV-1: the token line is chat tokens — the meaning index's embedding tokens are counted apart, never extrapolated with them (the review's figures)", async () => {
    // $1.00 of embeddings bought 50M tokens; $5.00 of questions bought 1M; cap $10.
    kn.getAiUsage.mockResolvedValueOnce({
      ...base, spentUsd: 6, percent: 60, capUsd: 10, inputTokens: 50_900_000, outputTokens: 100_000, asks: 40, calls: 41,
      byOp: {
        knowledgeAsk: { spentUsd: 5, calls: 40, inputTokens: 900_000, outputTokens: 100_000 },
        knowledgeEmbed: { spentUsd: 1, calls: 1, inputTokens: 50_000_000, outputTokens: 0 },
      },
    });
    await render(React.createElement(UsagePanel, { orgId: "o1" }));
    // 1M so far; the $4 left buys ~0.8M more at $5 per 1M — never "51.0M of ~85.0M"
    expect(host.textContent).toMatch(/1\.0M of ~1\.8M tokens/);
    expect(host.textContent).toMatch(/50\.0M meaning-index tokens/);
    expect(host.textContent).not.toMatch(/85\.0M/);
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

describe("tokenLine (GOV-1: a token is not one price)", () => {
  const u = { inputTokens: 0, outputTokens: 0, spentUsd: 0, capUsd: 10, locked: false, byOp: {} };
  it("with no embedding spend it is the month's tokens over the whole cap, as before", () => {
    expect(tokenLine({ ...u, inputTokens: 18_000, outputTokens: 2_000, spentUsd: 1, byOp: { knowledgeAsk: { spentUsd: 1, calls: 3, inputTokens: 18_000, outputTokens: 2_000 } } }))
      .toEqual({ chatTokens: 20_000, embeddingTokens: 0, estChatTokenBudget: 200_000 });
  });
  it("embedding tokens are taken out of the figure and its rate; what is left of the cap is spent at the chat rate", () => {
    expect(tokenLine({
      ...u, inputTokens: 50_900_000, outputTokens: 100_000, spentUsd: 6,
      byOp: { knowledgeAsk: { spentUsd: 5, calls: 1, inputTokens: 900_000, outputTokens: 100_000 }, knowledgeEmbed: { spentUsd: 1, calls: 1, inputTokens: 50_000_000, outputTokens: 0 } },
    })).toEqual({ chatTokens: 1_000_000, embeddingTokens: 50_000_000, estChatTokenBudget: 1_800_000 });
  });
  it("no estimate when it can't be made honestly: a lock, no chat spend, or a meaning-index line without its tokens (an older server)", () => {
    expect(tokenLine({ ...u, capUsd: 0, locked: true, inputTokens: 10, spentUsd: 1, byOp: { knowledgeAsk: { spentUsd: 1, calls: 1, inputTokens: 10, outputTokens: 0 } } }).estChatTokenBudget).toBeNull();
    expect(tokenLine({ ...u, inputTokens: 5_000, spentUsd: 0.1, byOp: { knowledgeEmbed: { spentUsd: 0.1, calls: 1, inputTokens: 5_000, outputTokens: 0 } } }))
      .toEqual({ chatTokens: 0, embeddingTokens: 5_000, estChatTokenBudget: null });
    expect(tokenLine({ ...u, inputTokens: 51_000_000, spentUsd: 6, byOp: { knowledgeAsk: { spentUsd: 5, calls: 1 }, knowledgeEmbed: { spentUsd: 1, calls: 1 } } }))
      .toEqual({ chatTokens: 51_000_000, embeddingTokens: 0, estChatTokenBudget: null });
  });
});

describe("opBreakdown", () => {
  it("merges lines that share a name, drops zeros, unknown ops show as themselves", () => {
    expect(opBreakdown({ checklistSegment: { spentUsd: 1, calls: 1 }, checklistAssess: { spentUsd: 2, calls: 1 }, x: { spentUsd: 0, calls: 1 }, brandNew: { spentUsd: 0.5, calls: 1 } }))
      .toEqual([{ label: "Checklists", spentUsd: 3 }, { label: "brandNew", spentUsd: 0.5 }]);
  });
});
