// @vitest-environment jsdom
//
// intelligence Round G — I-20, IRLS-13 done-when 2 (the orchestrator half),
// the assistant's answer surface as RENDERED: an answer whose run carried
// Reasoning Skills says "Shaped by: …", naming them, as the library Ask
// surface does; an answer with none shows nothing new (REGRESSION).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const oc = vi.hoisted(() => ({
  askOrchestrator: vi.fn(),
  executeAction: vi.fn(),
  dismissAction: vi.fn(),
  describeTool: (t: string) => t,
}));
vi.mock("@/lib/orchestratorClient", () => oc);
vi.mock("@/components/providers/RoleContext", () => ({ useRole: () => ({ activeOrgId: "o1" }) }));
vi.mock("@/components/navigation/ViewTabs", () => ({ default: () => null, INTELLIGENCE_VIEWS: [] }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => React.createElement("a", { href, ...rest }, children),
}));

import AssistantPage from "@/app/(protected)/assistant/page";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  oc.askOrchestrator.mockReset();
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const settle = async () => { for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); }); };
const reply = (over: Record<string, unknown> = {}) => ({
  answer: "No documents mention pipe supports.", steps: [], pending: [], stoppedBecause: null,
  provider: "anthropic", model: "test-model", budget: { spentUsd: 0.01, capUsd: 10 }, ...over,
});
async function askOnce() {
  await act(async () => { root.render(React.createElement(AssistantPage)); });
  await settle();
  const example = [...host.querySelectorAll("button")].find((b) => /pipe supports/.test(b.textContent ?? "")) as HTMLButtonElement;
  await act(async () => { example.click(); });
  await settle();
}

describe("IRLS-13 — the assistant's answer names the Reasoning Skills that shaped it", () => {
  it("reproduction → fix: a reply carrying `skills` shows 'Shaped by: …' with each pack's name, in order", async () => {
    oc.askOrchestrator.mockResolvedValueOnce(reply({
      skills: [
        { id: "s-rv", name: "Relief valve reasoning", builtinKey: null },
        { id: "s-std", name: "Standards first", builtinKey: "standards_first" },
      ],
    }));
    await askOnce();
    const chip = host.querySelector('[data-answer-skills="true"]');
    expect(chip?.textContent).toBe("Shaped by: Relief valve reasoning, Standards first");
    expect(host.textContent).toContain("No documents mention pipe supports.");
  });

  it("REGRESSION: a reply with no skills shows no chip, and the answer renders as before", async () => {
    oc.askOrchestrator.mockResolvedValueOnce(reply());
    await askOnce();
    expect(host.querySelector('[data-answer-skills="true"]')).toBeNull();
    expect(host.textContent).toContain("No documents mention pipe supports.");
    expect(host.textContent).toMatch(/test-model · \$0\.01 of \$10\.00 this month/);
  });
});
