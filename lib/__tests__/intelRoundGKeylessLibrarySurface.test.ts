// @vitest-environment jsdom
//
// intelligence Round G (I-22) — the library surface, as RENDERED:
//
//   * ING-13 / ING-6 (DEC-58 as ruled under DEC-90 A18): a document row says
//     "N pages indexed from their text layer only (no AI key)" when the
//     engine counted pages a batch with no AI key committed text-only
//     (knowledge_documents.vision_keyless_pages, 20261186), read beside the
//     document list. A database without the column shows exactly what it
//     showed before.
//   * GOV-5 residual: the meaning-index panel says "Waiting for AI budget
//     headroom — retried each run" when the embed drain's last run stopped
//     because the next batch did not fit what is left of the payer's cap
//     (recorded on the build marker; no hold).

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
  ingestKnowledgeDocument: vi.fn(),
  nudgeEmbedDrain: vi.fn(),
  semanticStatus: vi.fn(),
}));
/** The browser client's answer to the keyless count read. */
const keyless = vi.hoisted(() => ({
  answer: { data: [] as unknown[] | null, error: null as null | { code: string; message: string } },
  reads: [] as Array<{ table: string; columns: string; eq: [string, unknown] | null }>,
}));

vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: (table: string) => ({
      select: (columns: string) => {
        const read = { table, columns, eq: null as [string, unknown] | null };
        keyless.reads.push(read);
        const chain = {
          eq: (c: string, v: unknown) => { read.eq = [c, v]; return chain; },
          order: () => Promise.resolve(keyless.answer),
        };
        return chain;
      },
    }),
    auth: { getSession: async () => ({ data: { session: null } }) },
  },
}));
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
vi.mock("@/components/knowledge/EquipmentTablePanel", () => ({ default: () => null }));
vi.mock("@/lib/aiInstructions", () => ({ countActiveInstructions: vi.fn(async () => 0) }));
vi.mock("@/lib/knowledge", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/knowledge")>()), ...lib }));

import KnowledgeLibraryPage from "@/app/(protected)/knowledge/[id]/page";
import SemanticIndexPanel from "@/components/knowledge/SemanticIndexPanel";
import { resetKeylessColumnProbe } from "@/lib/knowledgeKeylessClient";
import type { KnowledgeDocument, KnowledgeLibrary, SemanticProgress } from "@/lib/knowledge";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const library: KnowledgeLibrary = {
  id: "lib-1", orgId: "o1", name: "P&IDs — Unit 20", description: null, aiInstructions: null,
  aiFeatures: {}, createdByName: null, createdAt: "2026-09-01T00:00:00Z",
};
const doc = (over: Partial<KnowledgeDocument>): KnowledgeDocument => ({
  id: "d", libraryId: "lib-1", name: "doc.pdf", fileKey: "k", fileSize: 1, pageCount: 40, pagesIndexed: 40,
  status: "ready", error: null, createdByName: null, createdAt: "2026-09-01T00:00:00Z",
  sourceId: null, sourceDocumentId: null, sourceRev: null, visionPages: 0,
  emptyPages: 0, visionFailedPages: [], visionPartialAccepted: false, chunkVersion: 1,
  ...over,
});
const docs = (): KnowledgeDocument[] => [
  // Indexed with no AI key: 3 SHX sheets committed text-only (empty).
  doc({ id: "keyless", name: "025-PID-0201.pdf", pageCount: 12, pagesIndexed: 12, emptyPages: 3 }),
  // A keyless org's prose document that needed no AI vision.
  doc({ id: "plain", name: "Bolting standard.pdf", pageCount: 20, pagesIndexed: 20 }),
  // Read with a key.
  doc({ id: "keyed", name: "025-PID-0202.pdf", pageCount: 6, pagesIndexed: 6, visionPages: 4 }),
  // Reset and waiting: no counter of the last generation shows.
  doc({ id: "reset", name: "025-PID-0203.pdf", status: "stale", pageCount: null, pagesIndexed: 0 }),
];

let host: HTMLDivElement;
let root: Root;
const flush = async () => { for (let i = 0; i < 8; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const byText = (sel: string, text: RegExp, within: ParentNode = host) =>
  [...within.querySelectorAll(sel)].find((el) => text.test(el.textContent ?? "")) as HTMLElement | undefined;
const rowOf = (name: string) => [...host.querySelectorAll("li")].find((li) => li.textContent?.includes(name)) as HTMLElement;

async function mountPage() {
  lib.listKnowledgeDocuments.mockResolvedValue(docs());
  await act(async () => { root.render(React.createElement(KnowledgeLibraryPage)); });
  await flush();
  await act(async () => { byText("button", /^Documents \(/)!.click(); });
  await flush();
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  for (const f of Object.values(lib)) f.mockReset();
  keyless.reads = [];
  keyless.answer = { data: [], error: null };
  resetKeylessColumnProbe();
  role.value = { activeOrgId: "o1", uid: "u1", userEmail: "v@example.com", hasAnyRole: () => false };
  lib.getKnowledgeLibrary.mockResolvedValue(library);
  lib.listKnowledgeQuestions.mockResolvedValue({ questions: [], withheld: 0 });
  lib.listLibraryLinks.mockResolvedValue([]);
  lib.semanticStatus.mockRejectedValue(new Error("not under test here"));
  window.sessionStorage.clear();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("I-22 — the library page marks a document indexed without an AI key", () => {
  it("'N pages indexed from their text layer only (no AI key)' on the row the engine counted — and nowhere else", async () => {
    keyless.answer = {
      data: [
        { id: "keyless", vision_keyless_pages: 3 }, { id: "plain", vision_keyless_pages: 0 },
        { id: "keyed", vision_keyless_pages: 0 }, { id: "reset", vision_keyless_pages: 2 },
      ],
      error: null,
    };
    await mountPage();
    expect(rowOf("025-PID-0201.pdf").querySelector('[data-keyless-pages="true"]')?.textContent)
      .toBe("3 pages indexed from their text layer only (no AI key)");
    // The row's other counters are as before.
    expect(rowOf("025-PID-0201.pdf").textContent).toMatch(/3 of 12 pages had no extractable text/);
    expect(rowOf("Bolting standard.pdf").querySelector('[data-keyless-pages="true"]')).toBeNull();
    expect(rowOf("025-PID-0202.pdf").querySelector('[data-keyless-pages="true"]')).toBeNull();
    expect(rowOf("025-PID-0202.pdf").textContent).toMatch(/4 pages read by AI vision/);
    // A reset row shows no counter of the last generation (ING-12's rule).
    expect(rowOf("025-PID-0203.pdf").querySelector('[data-keyless-pages="true"]')).toBeNull();
    // The read is the member's own, of this library.
    expect(keyless.reads[0]).toEqual({ table: "knowledge_documents", columns: "id, vision_keyless_pages", eq: ["library_id", "lib-1"] });
  });

  it("REGRESSION: a database without 20261186 (42703) shows every row exactly as before, and the tab stops asking", async () => {
    keyless.answer = { data: null, error: { code: "42703", message: 'column knowledge_documents.vision_keyless_pages does not exist' } };
    await mountPage();
    expect(host.querySelector('[data-keyless-pages="true"]')).toBeNull();
    expect(rowOf("025-PID-0201.pdf").textContent).toMatch(/3 of 12 pages had no extractable text/);
    expect(rowOf("025-PID-0202.pdf").textContent).toMatch(/4 pages read by AI vision/);
    expect(rowOf("Bolting standard.pdf").textContent).not.toMatch(/pages? (read by AI vision|had no extractable text|indexed from)/);
    const reads = keyless.reads.length;
    expect(reads).toBe(1);
    // The page opened again in this tab does not ask again.
    keyless.answer = { data: [{ id: "keyless", vision_keyless_pages: 3 }], error: null };
    act(() => root.unmount());
    root = createRoot(host);
    await mountPage();
    expect(keyless.reads.length).toBe(reads);
    expect(host.querySelector('[data-keyless-pages="true"]')).toBeNull();
  });

  it("any other failure of that read shows nothing — never a guessed count", async () => {
    keyless.answer = { data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } };
    await mountPage();
    expect(host.querySelector('[data-keyless-pages="true"]')).toBeNull();
    expect(rowOf("025-PID-0202.pdf").textContent).toMatch(/4 pages read by AI vision/);
  });
});

describe("GOV-5 residual (I-22) — the meaning-index panel says a background build is waiting for budget headroom", () => {
  const status = (background: Record<string, unknown> | null, remaining = 40): SemanticProgress => ({
    total: 100, coveredNow: 100 - remaining, embedded: 0, remaining, done: remaining === 0, error: null, spentThisRun: 0,
    failed: 0, busy: 0, waiting: 0, models: {}, mixed: false, connection: null, conflict: null, estimate: null,
    background: background as SemanticProgress["background"],
  } as unknown as SemanticProgress);
  const BG = {
    mine: false, standing: true, startedAt: "2026-09-01T00:00:00Z", lastDrainAt: "2026-10-07T03:00:00Z",
    blockedUntil: null, blockedReason: null, lastError: null,
  };
  async function mountPanel(s: SemanticProgress) {
    lib.semanticStatus.mockResolvedValue(s);
    await act(async () => { root.render(React.createElement(SemanticIndexPanel, { orgId: "o1", libraryId: "lib-1", isController: false })); });
    await flush();
  }

  it("the drain's recorded no-fit stop is said, with the reservation's sentence — no hold line", async () => {
    await mountPanel(status({
      ...BG, headroomWaitAt: "2026-10-07T03:00:05Z",
      headroomNote: "the payer's $10.00 monthly AI cap has $0.06 left; one batch could cost up to $0.11",
    }));
    const line = host.querySelector('[data-headroom-wait="true"]');
    expect(line?.textContent).toBe("Waiting for AI budget headroom — retried each run: the payer's $10.00 monthly AI cap has $0.06 left; one batch could cost up to $0.11");
    expect(host.textContent).not.toMatch(/Waiting until/);
  });

  it("REGRESSION: a background build with nothing recorded shows exactly what it showed before; a dated hold keeps its own line", async () => {
    await mountPanel(status(BG));
    expect(host.querySelector('[data-headroom-wait="true"]')).toBeNull();
    expect(host.textContent).toMatch(/Kept current in the background/);

    act(() => root.unmount());
    root = createRoot(host);
    await mountPanel(status({ ...BG, blockedUntil: "2999-01-01T00:00:00Z", blockedReason: "cap", lastError: "monthly cap reached", headroomWaitAt: "2026-10-07T03:00:05Z" }));
    expect(host.querySelector('[data-headroom-wait="true"]')).toBeNull();
    expect(host.textContent).toMatch(/Waiting until .* — the monthly AI budget is reached; it resets on the 1st: monthly cap reached/);
  });

  it("nothing left to embed: no wait is said", async () => {
    await mountPanel(status({ ...BG, headroomWaitAt: "2026-10-07T03:00:05Z" }, 0));
    expect(host.querySelector('[data-headroom-wait="true"]')).toBeNull();
  });
});
