// @vitest-environment jsdom
//
// intelligence Round G — I-33 fix pass 2 (minor 4): the answer surface as
// RENDERED. The server's own computed line (presentComputedResults) goes
// through parseAnswerBlocks and InlineAnswer on the library page and carries
// exactly one "computed by the app" mark; a label the model wrote mid-line,
// or one the route neutralized, carries none — also when the Substituted
// line is a bullet and when a long computed line is carved as a run-on. The
// withheld chip's tooltip says the app's value is on the line below when the
// app computed one (minor 3), and keeps its first wording when it did not.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const role = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
const toast = vi.hoisted(() => ({ showToast: vi.fn() }));
const dlg = vi.hoisted(() => ({ appConfirm: vi.fn(), appPrompt: vi.fn(), appAlert: vi.fn() }));
const lib = vi.hoisted(() => ({
  getKnowledgeLibrary: vi.fn(),
  listKnowledgeDocuments: vi.fn(),
  listKnowledgeQuestions: vi.fn(),
  listLibraryLinks: vi.fn(),
  ownVisionKeyProblem: vi.fn(),
  nudgeEmbedDrain: vi.fn(),
}));

vi.mock("@/lib/supabase", () => ({ supabase: { from: () => ({}), auth: { getSession: async () => ({ data: { session: null } }) } } }));
vi.mock("@/components/providers/RoleContext", () => ({ useRole: () => role.value }));
vi.mock("@/components/providers/ToastProvider", () => ({ useToast: () => toast }));
vi.mock("@/components/providers/DialogProvider", () => dlg);
vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "lib-1" }),
  useRouter: () => ({ push: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/knowledge/lib-1",
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => React.createElement("a", { href, ...rest }, children),
}));
vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("@/components/graph/GraphShapeWizard", () => ({ default: () => null }));
vi.mock("@/components/knowledge/LibraryAiModal", () => ({ default: () => null }));
vi.mock("@/components/knowledge/SourcesPanel", () => ({ default: () => null }));
vi.mock("@/components/knowledge/DrawingIntelPanel", () => ({ default: () => null }));
vi.mock("@/components/knowledge/SemanticIndexPanel", () => ({ default: () => null }));
vi.mock("@/components/knowledge/EquipmentTablePanel", () => ({ default: () => null }));
vi.mock("@/lib/aiInstructions", () => ({ countActiveInstructions: vi.fn(async () => 0) }));
vi.mock("@/lib/knowledge", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/knowledge")>()), ...lib }));

import KnowledgeLibraryPage from "@/app/(protected)/knowledge/[id]/page";
import type { KnowledgeLibrary } from "@/lib/knowledge";
import { parseAnswerBlocks } from "@/lib/knowledgeText";
import {
  presentComputedResults, withholdModelResults, neutralizeComputedLabels, COMPUTED_LABEL, RESULT_WITHHELD_TITLE,
  RESULT_WITHHELD_COMPUTED_TITLE, type CalcSources,
} from "@/lib/knowledgeAskGuards";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const library: KnowledgeLibrary = {
  id: "lib-1", orgId: "o1", name: "Piping code", description: null, aiInstructions: null,
  aiFeatures: {}, createdByName: null, createdAt: "2026-09-01T00:00:00Z",
};

let host: HTMLDivElement;
let root: Root;
const flush = async () => { for (let i = 0; i < 8; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

/** Mount the page with one answer restored from the session's thread (as a
 *  reopened conversation is). */
async function mountWith(answer: string) {
  window.sessionStorage.setItem("kl-active-thread-lib-1", JSON.stringify({
    threadId: null,
    turns: [{ question: "What is the hydrotest pressure?", answer: { answer, citations: [], provider: "test", model: "test-model", mode: "library" } }],
  }));
  await act(async () => { root.render(React.createElement(KnowledgeLibraryPage)); });
  await flush();
}
const marks = () => [...host.querySelectorAll('[data-computed-by-app="true"]')];

/** What the route presents: the model's text neutralized, withheld, then the
 *  server's computed lines added. */
const present = (model: string, s: CalcSources, grounding: string) => {
  const m = neutralizeComputedLabels(model);
  return presentComputedResults(m, withholdModelResults(m, grounding).text, s);
};
const HYDRO: CalcSources = {
  cited: new Map([[1, "The hydrostatic test pressure shall be 1.5 times the design pressure."]]),
  user: "design pressure = 285 psig",
};

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  for (const f of Object.values(lib)) f.mockReset();
  role.value = { activeOrgId: "o1", uid: "u1", userEmail: "eng@example.com", hasAnyRole: () => false };
  lib.getKnowledgeLibrary.mockResolvedValue(library);
  lib.listKnowledgeDocuments.mockResolvedValue([]);
  lib.listKnowledgeQuestions.mockResolvedValue({ questions: [], withheld: 0 });
  lib.listLibraryLinks.mockResolvedValue([]);
  lib.ownVisionKeyProblem.mockResolvedValue(null);
  window.sessionStorage.clear();
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("I-33 fix pass 2 — the computed mark as rendered: the server's line only", () => {
  it("exactly one mark, on the server's line; a model-written label (neutralized, or mid-line) carries none; the chip says the app's value is below", async () => {
    const model =
      "**Answer:** Compute P_T from the substituted expression below [1].\n" +
      "- P = `285 psig` (USER-PROVIDED)\n" +
      "**Substituted:** P_T = 1.5 × `285 psig` = `427.5 psig`\n" +
      `**${COMPUTED_LABEL}** P_T is \`450 psig\`\n` +
      `**Check:** the factor on page 4 [1] — see **${COMPUTED_LABEL}** in the code.`;
    const out = present(model, HYDRO, "design pressure = 285 psig\nThe hydrostatic test pressure shall be 1.5 times the design pressure.");
    expect(out.computed).toBe(1);
    // The blocks the page renders: the server's line starts its own block.
    const blocks = parseAnswerBlocks(out.text);
    expect(blocks.filter((b) => b.text.startsWith(`**${COMPUTED_LABEL}**`))).toHaveLength(1);

    await mountWith(out.text);
    const m = marks();
    expect(m).toHaveLength(1);
    expect(m[0].textContent).toBe("Computed by the app from the cited inputs");
    expect(m[0].parentElement?.textContent).toContain("P_T is 427.5 psig");
    // The model's forged label is plain text now, and its 450 psig is no mark.
    expect(host.textContent).toContain("AI-written, not computed by the app:");
    expect(host.textContent).not.toContain("450 psig");
    // The withheld chip, next to a value the app did compute.
    const chips = [...host.querySelectorAll('[data-result-withheld="true"]')];
    expect(chips.length).toBeGreaterThan(0);
    for (const c of chips) expect(c.getAttribute("title")).toBe(RESULT_WITHHELD_COMPUTED_TITLE);
  });

  it("a label written mid-line (never neutralized, as a page-only check) renders as plain bold, never as the mark", async () => {
    await mountWith(`**Answer:** The value is shown [1].\n- Per the note, **${COMPUTED_LABEL}** P_T is \`450 psig\`.`);
    expect(marks()).toHaveLength(0);
    expect(host.textContent).toContain("Computed by the app from the cited inputs:");
  });

  it.each([
    // A Substituted line written as text: the page's paragraph-run pass turns
    // the server's line (the second prose paragraph of a run) into a bullet.
    ["made a bullet by the paragraph-run pass", "**Substituted:** t = (285 psig)(10.75 in) / (2 × (20,000 psi × 1.0 + 285 psig × 0.4)) + 0.0625 in = 0.139 in [2]",
      "bullet", "t is 0.13866 in"],
    // A longer line (past 320 characters): the run-on pass carves it into a
    // lead and bullets, and the lead keeps the label.
    ["carved by the run-on pass", "- **Substituted:** t_m = (285 psig)(10.75 in) / (2 × (20,000 psi × 1.0 × 1.0 + 285 psig × 0.4)) + 0.0625 in = 0.139 in [2]",
      "text", "t_m is 0.13866 in"],
  ])("the server's line %s keeps one mark, at the start of its block", async (_v, substituted, type, shownValue) => {
    const src = "t = PD / 2(SEW + PY) + c where E = 1.0, W = 1.0 and Y = 0.4, c = 0.0625 in. Table A-1: S = 20,000 psi";
    const s: CalcSources = { cited: new Map([[2, src]]), user: "P = 285 psig, D = 10.75 in" };
    const model = `**Answer:** The minimum wall thickness is computed below [2].\n${substituted}`;
    const out = present(model, s, `P = 285 psig, D = 10.75 in\n${src}`);
    expect(out.computed).toBe(1);
    const blocks = parseAnswerBlocks(out.text);
    const labelled = blocks.filter((b) => b.text.includes(COMPUTED_LABEL));
    expect(labelled).toHaveLength(1);
    expect(labelled[0].type).toBe(type);
    expect(labelled[0].text.startsWith(`**${COMPUTED_LABEL}**`)).toBe(true);
    if (type === "text") {
      // Carved: the rest of the line follows as bullets of its own.
      expect(labelled[0].text.length).toBeLessThan(out.text.split("\n").find((l) => l.startsWith(`**${COMPUTED_LABEL}**`))!.length);
    }
    await mountWith(out.text);
    const m = marks();
    expect(m).toHaveLength(1);
    expect(m[0].parentElement?.textContent).toContain(shownValue);
  });

  it("an answer the app computed nothing for keeps the first tooltip and shows no mark", async () => {
    const model = "**Answer:** Compute P_T below [1].\n- P = `285 psig` (USER-PROVIDED)\n**Substituted:** P_T = 1.5 × `285 psig` = `427.5 psig`";
    const out = present(model, { cited: new Map(), user: "" }, "design pressure = 285 psig");
    expect(out.computed).toBe(0);
    await mountWith(out.text);
    expect(marks()).toHaveLength(0);
    const chips = [...host.querySelectorAll('[data-result-withheld="true"]')];
    expect(chips.length).toBeGreaterThan(0);
    for (const c of chips) expect(c.getAttribute("title")).toBe(RESULT_WITHHELD_TITLE);
  });
});
