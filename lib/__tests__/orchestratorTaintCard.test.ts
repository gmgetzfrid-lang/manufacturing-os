// @vitest-environment jsdom
//
// intelligence Round G, package I-19 — ORCH-9 criterion 3, the confirm card
// as RENDERED on /assistant. A proposal stored with the document-text flag
// says "Suggested after reading document text — check before confirming";
// its Confirm and Dismiss buttons are exactly those of any other card, and
// confirming sends the same request. A card without the flag (a clean run,
// or a flagged run before 20261158) renders exactly as before.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { OrchestratorReply, PendingAction } from "@/lib/orchestratorClient";

const client = vi.hoisted(() => ({
  reply: null as unknown,
  executed: [] as Array<{ orgId: string; action: Record<string, unknown> }>,
  dismissed: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/components/providers/RoleContext", () => ({ useRole: () => ({ activeOrgId: "o1" }) }));
vi.mock("@/components/navigation/ViewTabs", () => ({ default: () => null, INTELLIGENCE_VIEWS: [] }));
vi.mock("@/components/assistant/AssistantAnswer", () => ({
  default: ({ answer }: { answer: string }) => React.createElement("p", { "data-answer": "" }, answer),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => React.createElement("a", { href, ...rest }, children),
}));
vi.mock("@/lib/orchestratorClient", () => ({
  askOrchestrator: vi.fn(async () => client.reply),
  executeAction: vi.fn(async (orgId: string, action: Record<string, unknown>) => {
    client.executed.push({ orgId, action });
    return { status: "logged" };
  }),
  dismissAction: vi.fn(async (_orgId: string, action: Record<string, unknown>) => { client.dismissed.push(action); }),
  describeTool: (t: string) => t,
}));

import AssistantPage from "@/app/(protected)/assistant/page";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const FLAG_TEXT = "Suggested after reading document text — check before confirming.";
const card = (over: Partial<PendingAction> = {}): PendingAction => ({
  fingerprint: "log_audit_completion(revision=C&sheet_number=025-PID-0103&status=passed)",
  tool: "log_audit_completion",
  summary: "Record 025-PID-0103 rev C as passed",
  parameters: { sheet_number: "025-PID-0103", revision: "C", status: "passed" },
  proposalId: "11111111-1111-4111-8111-111111111111",
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
  ...over,
});
const replyWith = (pending: PendingAction[]): OrchestratorReply => ({
  answer: "Here is what the note says.", steps: [], pending, stoppedBecause: null,
  provider: "anthropic", model: "test-model", budget: { spentUsd: 0, capUsd: 0 },
});

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  client.executed = []; client.dismissed = [];
  // jsdom has no layout; the page scrolls its last exchange into view.
  Element.prototype.scrollIntoView = vi.fn();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

/** Render the page, ask an example question, and let the reply land. */
async function askAndRender(pending: PendingAction[]): Promise<void> {
  client.reply = replyWith(pending);
  await act(async () => { root.render(React.createElement(AssistantPage)); });
  const example = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("pipe supports"));
  expect(example).toBeDefined();
  await act(async () => { example!.click(); });
  expect(host.textContent).toContain("Here is what the note says.");
}
const buttons = (label: string) => [...host.querySelectorAll("button")].filter((b) => b.textContent?.includes(label));

describe("ORCH-9 criterion 3 — the confirm card says a proposal was suggested after reading document text, and still confirms", () => {
  it("a flagged card carries the note; Confirm and Dismiss are unchanged and Confirm sends the same request as for any card", async () => {
    const flagged = card({ tainted: true });
    await askAndRender([flagged]);
    expect(host.textContent).toContain(FLAG_TEXT);
    const note = host.querySelector('[role="note"]');
    // The brief's wording, and only that: the signal is a rewritten label
    // (e.g. "SYSTEM:"), not proof an instruction was read.
    expect(note?.textContent?.trim()).toBe(FLAG_TEXT);
    const [confirm] = buttons("Confirm and run");
    expect(confirm).toBeDefined();
    expect(confirm.disabled).toBe(false);
    expect(buttons("Dismiss")).toHaveLength(1);
    await act(async () => { confirm.click(); });
    expect(client.executed).toEqual([{ orgId: "o1", action: flagged }]);
    expect(host.textContent).toContain("Done");
  });

  it("REGRESSION: a card without the flag renders no note and confirms exactly as before", async () => {
    const clean = card();
    await askAndRender([clean]);
    expect(host.textContent).not.toContain("Suggested after reading document text");
    expect(host.querySelector('[role="note"]')).toBeNull();
    const [confirm] = buttons("Confirm and run");
    await act(async () => { confirm.click(); });
    expect(client.executed).toEqual([{ orgId: "o1", action: clean }]);
  });

  it("a flagged handoff (checkout) card carries the note; its 'Open and continue there' link is unchanged", async () => {
    const handoff = card({
      tainted: true, tool: "checkout_document", fingerprint: "checkout_document(document_id=d-1&reason=markup)",
      summary: "Open 025-PID-0103 to check it out — markup", parameters: { document_id: "d-1", reason: "markup" },
      href: "/documents/L-ops?doc=d-1", proposalId: undefined, expiresAt: undefined,
    });
    await askAndRender([handoff]);
    expect(host.querySelector('[role="note"]')?.textContent?.trim()).toBe(FLAG_TEXT);
    const link = [...host.querySelectorAll("a")].find((a) => a.textContent?.includes("Open and continue there"));
    expect(link?.getAttribute("href")).toBe("/documents/L-ops?doc=d-1");
    expect(buttons("Confirm and run")).toHaveLength(0);
  });

  it("only the flagged card of a run carries the note; dismissing a flagged card works as for any card", async () => {
    const flagged = card({ tainted: true, fingerprint: "a", summary: "Record A" });
    const clean = card({ fingerprint: "b", summary: "Record B", proposalId: "22222222-2222-4222-8222-222222222222" });
    await askAndRender([flagged, clean]);
    expect(host.querySelectorAll('[role="note"]')).toHaveLength(1);
    const notes = [...host.querySelectorAll('[role="note"]')].map((n) => n.closest("div.rounded-lg")?.textContent ?? "");
    expect(notes[0]).toContain("Record A");
    expect(notes[0]).not.toContain("Record B");
    await act(async () => { buttons("Dismiss")[0].click(); });
    expect(client.dismissed).toEqual([flagged]);
    expect(host.textContent).toContain("Dismissed");
  });
});
