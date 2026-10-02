// @vitest-environment jsdom
//
// intelligence Round G — I-20, HUB-6 done-when 2, the library Ask header as
// RENDERED. Org Playbooks (/admin/ai-instructions) shape every answer, and
// the header used to link them only once one existed (`instructionCount >
// 0 && …`): an org with none had no door here. Now, with none, the header
// invites the first one — a controller to teach the AI its house rules, any
// other member (the page is read-only for them) to see what it is taught.
// Nothing is shown until the count is read, so the invitation never flashes
// over a library that has playbooks — and nothing when the count could not
// be read (countActiveInstructions answers null, never 0, on a failed read).
//
// I-20 fix pass 4: the count is the org's ENABLED playbooks scoped to library
// asks or everywhere — the set the ask route sends — not every playbook the
// org holds. A 0 is therefore "none applies to this library's asks", and the
// invitation says exactly that; it used to say "No playbooks yet" over an org
// whose playbooks were disabled or scoped to codebook imports or drawings.
//
// REGRESSION: with playbooks the header reads "N standing instruction(s)
// apply" exactly as before.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const role = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
const toast = vi.hoisted(() => ({ showToast: vi.fn() }));
const dlg = vi.hoisted(() => ({ appConfirm: vi.fn(), appPrompt: vi.fn(), appAlert: vi.fn() }));
const instructions = vi.hoisted(() => ({ countActiveInstructions: vi.fn(async (): Promise<number | null> => 0) }));
const sb = vi.hoisted(() => ({ from: vi.fn((_t: string): unknown => ({})) }));
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

vi.mock("@/lib/supabase", () => ({ supabase: { from: (t: string) => sb.from(t), auth: { getSession: async () => ({ data: { session: null } }) } } }));
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
  sb.from.mockReset();
  sb.from.mockImplementation(() => ({}));
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
    expect(links[0].textContent).toBe("No playbook applies to this library's asks — teach the AI your house rules");
    // it sits in the Ask header, beside what grounds the answers
    expect(links[0].parentElement?.textContent).toMatch(/Answers come ONLY from the indexed documents, cited to the page\./);
  });

  it("a member who cannot teach the AI is shown what it is taught (the page is open to every member, read-only)", async () => {
    setRole(false);
    instructions.countActiveInstructions.mockResolvedValue(0);
    await mount();
    const links = playbookLinks();
    expect(links).toHaveLength(1);
    expect(links[0].textContent).toBe("No playbook applies to this library's asks — see what the AI is taught");
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
    instructions.countActiveInstructions.mockImplementation(() => new Promise<number | null>((r) => { resolve = r; }));
    await mount();
    expect(playbookLinks()).toHaveLength(0);
    await act(async () => { resolve(2); });
    await flush();
    expect(playbookLinks()[0].textContent).toBe("2 standing instructions apply");
  });
});

describe("HUB-6 — a count that could not be read is not 'no playbooks'", () => {
  it("reproduction → fix: countActiveInstructions answers null on a failed read (it answered 0), and the count when it reads", async () => {
    const real = await vi.importActual<typeof import("@/lib/aiInstructions")>("@/lib/aiInstructions");
    /** The count query's chain, answering `out` when awaited. */
    const chain = (out: { count: number | null; error: { message: string } | null }) => {
      const q: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in"]) q[m] = () => q;
      q.then = (resolve: (v: unknown) => void) => resolve(out);
      return q;
    };
    sb.from.mockImplementation(() => chain({ count: null, error: { message: "upstream timeout" } }));
    expect(await real.countActiveInstructions("o1", "knowledge")).toBeNull();
    sb.from.mockImplementation(() => chain({ count: 5, error: null }));
    expect(await real.countActiveInstructions("o1", "knowledge")).toBe(5);
    expect(sb.from).toHaveBeenLastCalledWith("org_ai_instructions");
    sb.from.mockImplementation(() => chain({ count: 0, error: null }));
    expect(await real.countActiveInstructions("o1", "knowledge")).toBe(0);
  });

  it("a failed count shows no invitation and no count — the header says nothing it does not know", async () => {
    setRole(true);
    instructions.countActiveInstructions.mockResolvedValue(null);
    await mount();
    expect(instructions.countActiveInstructions).toHaveBeenCalledWith("o1", "knowledge");
    expect(playbookLinks()).toHaveLength(0);
    expect(host.querySelector("[data-playbooks-empty]")).toBeNull();
    expect(host.textContent).not.toMatch(/No playbooks? (yet|applies)/);
  });
});

describe("HUB-6 (I-20 fix pass 4) — the invitation claims only what the count read: none applies to this library's asks", () => {
  type Pb = { org_id: string; scope: string; enabled: boolean; title: string; body: string };
  /** org_ai_instructions over `rows`, applying the filters the caller chains. */
  const table = (rows: Pb[]) => {
    const filters: Array<(r: Pb) => boolean> = [];
    let head = false;
    const q: Record<string, unknown> = {};
    q.select = (_c: string, o?: { head?: boolean }) => { if (o?.head) head = true; return q; };
    q.eq = (k: keyof Pb, v: unknown) => { filters.push((r) => r[k] === v); return q; };
    q.in = (k: keyof Pb, vs: unknown[]) => { filters.push((r) => vs.includes(r[k])); return q; };
    q.order = () => q;
    q.limit = () => q;
    q.then = (resolve: (v: unknown) => void) => {
      const hit = rows.filter((r) => filters.every((f) => f(r)));
      resolve(head ? { count: hit.length, error: null, data: null } : { data: hit, error: null });
    };
    return q;
  };
  const pb = (scope: string, enabled: boolean, title: string, org = "o1"): Pb => ({ org_id: org, scope, enabled, title, body: `${title} body` });

  it("an org whose playbooks are all disabled or scoped elsewhere counts 0 — exactly the set the ask route sends (none) — while the org does hold playbooks", async () => {
    const real = await vi.importActual<typeof import("@/lib/aiInstructions")>("@/lib/aiInstructions");
    const { loadOrgInstructionsBlock } = await import("@/lib/aiInstructionsServer");
    const rows = [
      pb("knowledge", false, "Cite the clause"),        // disabled
      pb("codebook", true, "Tag prefixes"),             // another feature's
      pb("equipment", true, "Title block corner"),      // another feature's
      pb("global", true, "Other org's rule", "o2"),     // another org's
    ];
    sb.from.mockImplementation(() => table(rows));
    expect(await real.countActiveInstructions("o1", "knowledge")).toBe(0);
    // the ask route sends none of them either …
    const admin = { from: () => table(rows) } as unknown as Parameters<typeof loadOrgInstructionsBlock>[0];
    expect(await loadOrgInstructionsBlock(admin, "o1", "knowledge")).toBe("");
    // … though the org holds three: "No playbooks yet" would be false here
    expect(rows.filter((r) => r.org_id === "o1")).toHaveLength(3);
  });

  it("negative control: one enabled playbook for library asks or everywhere is counted — and is what the ask route sends", async () => {
    const real = await vi.importActual<typeof import("@/lib/aiInstructions")>("@/lib/aiInstructions");
    const { loadOrgInstructionsBlock } = await import("@/lib/aiInstructionsServer");
    for (const scope of ["knowledge", "global"]) {
      const rows = [pb("knowledge", false, "Cite the clause"), pb("codebook", true, "Tag prefixes"), pb(scope, true, "Answer in metric")];
      sb.from.mockImplementation(() => table(rows));
      expect(await real.countActiveInstructions("o1", "knowledge")).toBe(1);
      const admin = { from: () => table(rows) } as unknown as Parameters<typeof loadOrgInstructionsBlock>[0];
      const block = await loadOrgInstructionsBlock(admin, "o1", "knowledge");
      expect(block).toMatch(/- Answer in metric: Answer in metric body/);
      expect(block).not.toMatch(/Cite the clause|Tag prefixes/);
    }
  });

  it("reproduction → fix: with a count of 0 the header says none applies to this library's asks — never that the org has no playbooks", async () => {
    for (const controller of [true, false]) {
      setRole(controller);
      instructions.countActiveInstructions.mockResolvedValue(0);
      await mount();
      const link = host.querySelector("[data-playbooks-empty]")!;
      expect(link.textContent).toMatch(/^No playbook applies to this library's asks — /);
      expect(host.textContent).not.toMatch(/No playbooks yet/);
      act(() => root.unmount());
      root = createRoot(host);
    }
  });
});
