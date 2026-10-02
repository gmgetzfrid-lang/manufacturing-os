// @vitest-environment jsdom
//
// intelligence Round G — I-20, HUB-6 done-when 2, the library Ask header as
// RENDERED. Org Playbooks (/admin/ai-instructions) shape every answer, and
// the header used to link them only once one existed (`instructionCount >
// 0 && …`): an org with none had no door here. Now, with none, the header
// invites the first one — a controller to teach the AI its house rules, any
// other member (the page is read-only for them) to see what it is taught.
// Nothing is shown until the count is read, so the invitation never flashes
// over a library that has playbooks.
//
// REGRESSION: with playbooks the header reads "N standing instruction(s)
// apply" exactly as before.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const role = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
const toast = vi.hoisted(() => ({ showToast: vi.fn() }));
const dlg = vi.hoisted(() => ({ appConfirm: vi.fn(), appPrompt: vi.fn(), appAlert: vi.fn() }));
const instructions = vi.hoisted(() => ({ countActiveInstructions: vi.fn(async () => 0) }));
const lib = vi.hoisted(() => ({
  getKnowledgeLibrary: vi.fn(),
  listKnowledgeDocuments: vi.fn(),
  listKnowledgeQuestions: vi.fn(),
  listLibraryLinks: vi.fn(),
  ingestKnowledgeDocument: vi.fn(),
  addKnowledgeDocument: vi.fn(),
  acceptPartialIndex: vi.fn(),
  planTableAwareReindex: vi.fn(),
  runTableAwareReindex: vi.fn(),
  ownVisionKeyProblem: vi.fn(),
  rebuildDrawingIndex: vi.fn(),
  deleteKnowledgeDocument: vi.fn(),
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
vi.mock("@/lib/aiInstructions", () => instructions);
vi.mock("@/lib/knowledge", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/knowledge")>()), ...lib }));

import KnowledgeLibraryPage from "@/app/(protected)/knowledge/[id]/page";
import type { KnowledgeLibrary } from "@/lib/knowledge";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const library: KnowledgeLibrary = {
  id: "lib-1", orgId: "o1", name: "Standards", description: null, aiInstructions: null,
  aiFeatures: {}, createdByName: null, createdAt: "2026-09-01T00:00:00Z",
};

let host: HTMLDivElement;
let root: Root;
const flush = async () => { for (let i = 0; i < 8; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

function setRole(controller: boolean) {
  role.value = {
    activeOrgId: "o1", uid: "u1", userEmail: "member@example.com",
    hasAnyRole: (rs: string[]) => controller && rs.some((r) => r === "DocCtrl"),
  };
}
async function mount() {
  await act(async () => { root.render(React.createElement(KnowledgeLibraryPage)); });
  await flush();
}
const playbookLinks = () => [...host.querySelectorAll('a[href="/admin/ai-instructions"]')] as HTMLAnchorElement[];

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  for (const f of Object.values(lib)) f.mockReset();
  instructions.countActiveInstructions.mockReset();
  lib.getKnowledgeLibrary.mockResolvedValue(library);
  lib.listKnowledgeDocuments.mockResolvedValue([]);
  lib.listKnowledgeQuestions.mockResolvedValue({ questions: [], withheld: 0 });
  lib.listLibraryLinks.mockResolvedValue([]);
  lib.ownVisionKeyProblem.mockResolvedValue(null);
  window.sessionStorage.clear();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("HUB-6 done-when 2 — the library Ask header points at playbooks even with none", () => {
  it("reproduction → fix: with no playbook a controller is invited to write the first one (the door is never hidden)", async () => {
    setRole(true);
    instructions.countActiveInstructions.mockResolvedValue(0);
    await mount();
    expect(instructions.countActiveInstructions).toHaveBeenCalledWith("o1", "knowledge");
    const links = playbookLinks();
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute("data-playbooks-empty")).toBe("true");
    expect(links[0].textContent).toBe("No playbooks yet — teach the AI your house rules");
    // it sits in the Ask header, beside what grounds the answers
    expect(links[0].parentElement?.textContent).toMatch(/Answers come ONLY from the indexed documents, cited to the page\./);
  });

  it("a member who cannot teach the AI is shown what it is taught (the page is open to every member, read-only)", async () => {
    setRole(false);
    instructions.countActiveInstructions.mockResolvedValue(0);
    await mount();
    const links = playbookLinks();
    expect(links).toHaveLength(1);
    expect(links[0].textContent).toBe("No playbooks yet — see what the AI is taught");
  });

  it("REGRESSION: with playbooks the header reads 'N standing instruction(s) apply', as before, and no invitation", async () => {
    setRole(true);
    instructions.countActiveInstructions.mockResolvedValue(3);
    await mount();
    let links = playbookLinks();
    expect(links).toHaveLength(1);
    expect(links[0].textContent).toBe("3 standing instructions apply");
    expect(host.querySelector("[data-playbooks-empty]")).toBeNull();
    act(() => root.unmount());
    root = createRoot(host);
    instructions.countActiveInstructions.mockResolvedValue(1);
    await mount();
    links = playbookLinks();
    expect(links[0].textContent).toBe("1 standing instruction apply");
  });

  it("nothing is shown until the count is read — the invitation never flashes over a library that has playbooks", async () => {
    setRole(true);
    let resolve: (n: number) => void = () => undefined;
    instructions.countActiveInstructions.mockImplementation(() => new Promise<number>((r) => { resolve = r; }));
    await mount();
    expect(playbookLinks()).toHaveLength(0);
    await act(async () => { resolve(2); });
    await flush();
    expect(playbookLinks()[0].textContent).toBe("2 standing instructions apply");
  });
});
