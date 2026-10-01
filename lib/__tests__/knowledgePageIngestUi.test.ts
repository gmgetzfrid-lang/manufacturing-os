// @vitest-environment jsdom
//
// intelligence Round G, I-02b (2026-10-01) — the knowledge library page as
// RENDERED catches up with the ingest claim (I-06, DEC-58):
//
//   * ING-6 — a controller can accept the partial index (the route's
//     accept-partial action) where the route would take it, and only there;
//     a document still `indexing` (or queued) shows the reason on its row,
//     not only once it is `error`; the pages AI vision could not read stay
//     listed, before and after an acceptance.
//   * ING-8 — Resume is a person's re-run: it passes `retryNow`; the page's
//     automatic loop never does.
//   * ING-4 / ING-7 — "Re-index with table-aware chunking": the dry run
//     first, then a confirmation that says what it counts and what it leaves
//     out (the library drops out of Ask until each document is re-indexed),
//     then the run.
//   * ING-9 — the browser refuses a renamed spreadsheet before anything is
//     uploaded, naming where it belongs.
//   * ING-11 — "N of M pages had no extractable text".
//
// Review fix pass (2026-10-01): the per-row counters show only where the
// current index stands behind them — never on a row "Re-index all" reset,
// which keeps the last generation's counts until its first batch commits —
// and an inflated vision count is clamped; a Resume another loop in the tab
// already owns is said, not reported "indexed"; a re-index that stops
// part-way says what it already reset; a database without 20261122 is never
// offered the table-aware re-index.
//
// Review fix pass 2 (2026-10-01): in a library AI vision reads, the re-index
// first checks the clicking person's own key — the page's own loop indexes
// what it resets, on that key, at once — and stops before anything is reset
// when it cannot read; the confirmation says AI vision re-reads a page only
// on a usable key, and, for a read-every-page library, that the nightly run
// never indexes a document with no uploader key. A document reset with
// leftovers is counted as reset, never "could not be"; a document that
// really could not be reset is said with what is left to run.
//
// Integration (2026-10-01): the confirmation and the key refusal quote the
// route's AI-vision count as is — never one built from the page's own
// document list, which is capped at the row limit and goes stale — so a
// short or stale list never makes the page quote less than the route
// counted.

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
vi.mock("@/lib/aiInstructions", () => ({ countActiveInstructions: vi.fn(async () => 0) }));
vi.mock("@/lib/knowledge", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/knowledge")>()), ...lib }));

import KnowledgeLibraryPage from "@/app/(protected)/knowledge/[id]/page";
import { tableAwareReindexMessage, tableAwareReindexKeyRefusal, type KnowledgeDocument, type KnowledgeLibrary } from "@/lib/knowledge";

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
const PARKED = "AI vision could not read 2 pages (p. 3, 7): provider 529 overloaded. They are tried again automatically on the next indexing pass, no sooner than about 30 minutes from now. The rest of the document is searchable meanwhile. If they stay unreadable, ask an admin to accept the partial index.";
const FAILED = "Indexing failed: connection reset by peer — attempt 1 of 3. Indexing is tried again automatically on the next indexing pass.";
const docs = (): KnowledgeDocument[] => [
  // Parked at the end of the main pass: the acceptance is open.
  doc({ id: "parked", name: "025-PID-0101.pdf", status: "indexing", visionFailedPages: [3, 7], error: PARKED,
    visionPages: 12 }),
  // Pages already listed, but the main pass has not reached the end: no acceptance yet.
  doc({ id: "midway", name: "025-PID-0102.pdf", status: "indexing", pageCount: 40, pagesIndexed: 20, visionFailedPages: [2] }),
  // A failed first batch waiting out its back-off: queued, with the reason.
  doc({ id: "failed", name: "spec.pdf", status: "pending", pagesIndexed: 0, pageCount: null, error: FAILED }),
  // At the bound: the old 'error' line, unchanged.
  doc({ id: "errored", name: "broken.pdf", status: "error", error: "indexing failed 3 times in a row; re-run it once the cause is fixed" }),
  // An accepted partial index keeps its unread pages listed.
  doc({ id: "accepted", name: "025-PID-0103.pdf", status: "ready", visionFailedPages: [5, 9], visionPartialAccepted: true }),
  // A scanned standard read with no key.
  doc({ id: "scanned", name: "API-650.pdf", status: "ready", pageCount: 900, pagesIndexed: 900, emptyPages: 34 }),
];

let host: HTMLDivElement;
let root: Root;
const flush = async () => { for (let i = 0; i < 8; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const byText = (sel: string, text: RegExp, within: ParentNode = host) =>
  [...within.querySelectorAll(sel)].find((el) => text.test(el.textContent ?? "")) as HTMLElement | undefined;
const rowOf = (name: string) => [...host.querySelectorAll("li")].find((li) => li.textContent?.includes(name)) as HTMLElement;

function setRole(controller: boolean) {
  role.value = {
    activeOrgId: "o1", uid: "u1", userEmail: "dc@example.com",
    hasAnyRole: (rs: string[]) => controller && rs.some((r) => r === "DocCtrl"),
  };
}

async function mount(list: KnowledgeDocument[] = docs()) {
  lib.listKnowledgeDocuments.mockResolvedValue(list);
  await act(async () => { root.render(React.createElement(KnowledgeLibraryPage)); });
  await flush();
  // The document list is collapsed by default — open it.
  await act(async () => { byText("button", /^Documents \(/)!.click(); });
  await flush();
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  for (const f of Object.values(lib)) f.mockReset();
  toast.showToast.mockReset();
  dlg.appConfirm.mockReset();
  lib.getKnowledgeLibrary.mockResolvedValue(library);
  lib.listKnowledgeQuestions.mockResolvedValue({ questions: [], withheld: 0 });
  lib.listLibraryLinks.mockResolvedValue([]);
  lib.ingestKnowledgeDocument.mockResolvedValue("indexed");
  lib.ownVisionKeyProblem.mockResolvedValue(null);
  window.sessionStorage.clear();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("ING-6 / ING-8 — a document still indexing shows its reason; the partial index can be accepted", () => {
  it("the reason on an 'indexing' row and on a queued row is shown — the 'error' row keeps its own line", async () => {
    setRole(true);
    await mount();
    expect(rowOf("025-PID-0101.pdf").querySelector('[data-doc-held="true"]')?.textContent).toContain(PARKED);
    expect(rowOf("025-PID-0101.pdf").textContent).toMatch(/Indexing 40 \/ 40 pages…/);
    expect(rowOf("spec.pdf").querySelector('[data-doc-held="true"]')?.textContent).toContain(FAILED);
    expect(rowOf("spec.pdf").textContent).toMatch(/Waiting to index/);
    expect(rowOf("broken.pdf").querySelector('[data-doc-held="true"]')).toBeNull();
    expect(rowOf("broken.pdf").textContent).toMatch(/Indexing failed — indexing failed 3 times in a row/);
    expect(rowOf("025-PID-0102.pdf").querySelector('[data-doc-held="true"]')).toBeNull();
  });

  it("the pages AI vision could not read stay listed — waiting, and after an acceptance", async () => {
    setRole(false);
    await mount();
    expect(rowOf("025-PID-0101.pdf").querySelector('[data-vision-failed="true"]')?.textContent)
      .toBe("2 pages AI vision could not read yet (p. 3, 7)");
    expect(rowOf("025-PID-0101.pdf").textContent).toMatch(/12 pages read by AI vision/);
    expect(rowOf("025-PID-0103.pdf").querySelector('[data-vision-failed="true"]')?.textContent)
      .toBe("2 pages accepted unread — AI vision could not read p. 5, 9");
  });

  it("the acceptance is offered to a controller only where the route takes it: the main pass at the end, pages waiting, not yet accepted", async () => {
    setRole(true);
    await mount();
    expect(byText("button", /Accept partial index/, rowOf("025-PID-0101.pdf"))).toBeTruthy();
    expect(byText("button", /Accept partial index/, rowOf("025-PID-0102.pdf"))).toBeUndefined(); // midway
    expect(byText("button", /Accept partial index/, rowOf("025-PID-0103.pdf"))).toBeUndefined(); // accepted
    expect(byText("button", /Accept partial index/, rowOf("spec.pdf"))).toBeUndefined();
  });

  it("a member who is not a controller sees the reason and the counts but no acceptance, no Resume, no re-index", async () => {
    setRole(false);
    await mount();
    expect(rowOf("025-PID-0101.pdf").querySelector('[data-doc-held="true"]')).toBeTruthy();
    expect(byText("button", /Accept partial index/)).toBeUndefined();
    expect(host.querySelector('button[title="Resume indexing"]')).toBeNull();
    expect(byText("button", /Re-index with table-aware chunking/)).toBeUndefined();
  });

  it("accepting asks first, naming the pages and the audit record, then posts the route's action and says what happened", async () => {
    setRole(true);
    await mount();
    dlg.appConfirm.mockResolvedValue(true);
    lib.acceptPartialIndex.mockResolvedValue({ acceptedPages: [3, 7] });
    await act(async () => { byText("button", /Accept partial index/, rowOf("025-PID-0101.pdf"))!.click(); });
    await flush();
    const ask = dlg.appConfirm.mock.calls[0][0] as { title: string; message: string };
    expect(ask.title).toBe("Accept the partial index?");
    expect(ask.message).toContain('AI vision could not read 2 pages of "025-PID-0101.pdf" (p. 3, 7)');
    expect(ask.message).toContain("recorded in the audit log");
    expect(lib.acceptPartialIndex).toHaveBeenCalledWith("parked");
    expect(toast.showToast).toHaveBeenCalledWith({ type: "success", title: "025-PID-0101.pdf is ready — 2 pages accepted unread." });
  });

  it("a cancelled acceptance posts nothing; a refused one says the route's reason", async () => {
    setRole(true);
    await mount();
    dlg.appConfirm.mockResolvedValueOnce(false);
    await act(async () => { byText("button", /Accept partial index/, rowOf("025-PID-0101.pdf"))!.click(); });
    await flush();
    expect(lib.acceptPartialIndex).not.toHaveBeenCalled();
    dlg.appConfirm.mockResolvedValueOnce(true);
    lib.acceptPartialIndex.mockRejectedValueOnce(new Error("This document is being indexed right now — try again in a moment."));
    await act(async () => { byText("button", /Accept partial index/, rowOf("025-PID-0101.pdf"))!.click(); });
    await flush();
    expect(toast.showToast).toHaveBeenCalledWith({ type: "error", title: "This document is being indexed right now — try again in a moment." });
  });

  it("Resume passes retryNow (a person's re-run); the page's automatic loop never does", async () => {
    setRole(true);
    await mount();
    // The automatic loop drove the queued documents on mount — without retryNow.
    const auto = lib.ingestKnowledgeDocument.mock.calls.map((c) => c as unknown[]);
    expect(auto.length).toBeGreaterThan(0);
    for (const c of auto) expect(c[2]).toBeUndefined();
    lib.ingestKnowledgeDocument.mockClear();
    await act(async () => { (rowOf("spec.pdf").querySelector('button[title="Resume indexing"]') as HTMLElement).click(); });
    await flush();
    const resumed = lib.ingestKnowledgeDocument.mock.calls.find((c) => c[0] === "failed") as unknown[];
    expect(resumed?.[2]).toEqual({ retryNow: true });
    expect(toast.showToast).toHaveBeenCalledWith({ type: "success", title: "spec.pdf indexed." });
  });

  it("a Resume on a document another loop in this tab already owns says so — never 'indexed'", async () => {
    setRole(true);
    await mount();
    lib.ingestKnowledgeDocument.mockResolvedValue("already-active");
    toast.showToast.mockClear();
    await act(async () => { (rowOf("spec.pdf").querySelector('button[title="Resume indexing"]') as HTMLElement).click(); });
    await flush();
    expect(toast.showToast).toHaveBeenCalledWith({
      type: "info", title: "spec.pdf is already being indexed in this tab — try Resume again when it finishes.",
    });
    expect(toast.showToast).not.toHaveBeenCalledWith(expect.objectContaining({ type: "success" }));
  });
});

describe("the per-row counters show only what the current index stands behind", () => {
  it("a row 'Re-index all' reset (the rebuild's exact fields) shows no counter from the last generation", async () => {
    setRole(true);
    // app/api/knowledge/drawing/route.ts writes status 'stale', pages_indexed
    // 0, page_count null, last_section null, error null — nothing else.
    await mount([doc({
      id: "reset", name: "rebuilt.pdf", status: "stale", pagesIndexed: 0, pageCount: null, error: null,
      visionPages: 1240, emptyPages: 34, visionFailedPages: [5, 9], visionPartialAccepted: true,
    })]);
    const row = rowOf("rebuilt.pdf");
    expect(row.textContent).toMatch(/New revision published — waiting to re-index/);
    expect(row.textContent).not.toMatch(/read by AI vision/);
    expect(row.querySelector('[data-vision-failed="true"]')).toBeNull();
    expect(row.querySelector('[data-empty-pages="true"]')).toBeNull();
    expect(row.textContent).not.toMatch(/1240|34 of|accepted unread/);
    expect(byText("button", /Accept partial index/, row)).toBeUndefined();
  });

  it("a vision count inflated past the page count is clamped; an empty count larger than the pages behind it is left out", async () => {
    setRole(false);
    await mount([
      doc({ id: "inflated", name: "API-650.pdf", status: "ready", pageCount: 900, pagesIndexed: 900, visionPages: 1240 }),
      doc({ id: "early", name: "early.pdf", status: "indexing", pageCount: 900, pagesIndexed: 10, emptyPages: 34, visionPages: 3 }),
    ]);
    expect(rowOf("API-650.pdf").textContent).toMatch(/900 pages read by AI vision/);
    expect(rowOf("API-650.pdf").textContent).not.toMatch(/1240/);
    expect(rowOf("early.pdf").querySelector('[data-empty-pages="true"]')).toBeNull();
    expect(rowOf("early.pdf").textContent).toMatch(/3 pages read by AI vision/);
  });
});

describe("ING-11 — the empty-page count on the document list", () => {
  it("a ready document says N of M pages had no extractable text", async () => {
    setRole(false);
    await mount();
    expect(rowOf("API-650.pdf").querySelector('[data-empty-pages="true"]')?.textContent).toBe("34 of 900 pages had no extractable text");
    expect(rowOf("025-PID-0103.pdf").querySelector('[data-empty-pages="true"]')).toBeNull();
  });

  it("a document still indexing counts against the pages indexed so far", async () => {
    setRole(false);
    await mount([doc({ id: "half", name: "half.pdf", status: "indexing", pageCount: 900, pagesIndexed: 100, emptyPages: 7 })]);
    expect(rowOf("half.pdf").querySelector('[data-empty-pages="true"]')?.textContent).toBe("7 of 100 pages indexed so far had no extractable text");
  });
});

describe("ING-4 / ING-7 — Re-index with table-aware chunking", () => {
  // The route counts 52 AI-vision pages; docs() on the page holds only 12
  // (the "parked" row). The page quotes the route's 52, never its own list.
  const plan = { documents: 6, toReset: 4, visionPagesToReread: 52 };

  it("the dry run comes first; the confirmation is the full message — counts and the Ask outage; then the run", async () => {
    setRole(true);
    await mount();
    lib.planTableAwareReindex.mockResolvedValue(plan);
    lib.runTableAwareReindex.mockResolvedValue({ reset: 4, busy: 0, errors: [], leftovers: [], remaining: 0, stopped: null });
    dlg.appConfirm.mockResolvedValue(true);
    await act(async () => { byText("button", /Re-index with table-aware chunking/)!.click(); });
    await flush();
    expect(lib.planTableAwareReindex).toHaveBeenCalledWith("lib-1");
    // 52 AI-vision pages: the person's own key is checked before anything is asked.
    expect(lib.ownVisionKeyProblem).toHaveBeenCalledWith("o1");
    const ask = dlg.appConfirm.mock.calls[0][0] as { title: string; message: string };
    expect(ask.title).toBe("Re-index with table-aware chunking?");
    expect(ask.message).toBe(tableAwareReindexMessage(plan));
    expect(ask.message).toContain("The dry run counts 52 pages of them as read by AI vision before.");
    expect(ask.message).toMatch(/drops out of Ask/);
    expect(lib.runTableAwareReindex).toHaveBeenCalledWith("lib-1");
    expect(toast.showToast).toHaveBeenCalledWith({
      type: "success", title: "4 documents reset for table-aware chunking — re-indexing starts now.",
    });
  });

  it("cancelled after the dry run, nothing is reset", async () => {
    setRole(true);
    await mount();
    lib.planTableAwareReindex.mockResolvedValue(plan);
    dlg.appConfirm.mockResolvedValue(false);
    await act(async () => { byText("button", /Re-index with table-aware chunking/)!.click(); });
    await flush();
    expect(lib.runTableAwareReindex).not.toHaveBeenCalled();
  });

  it("documents a run found busy are said, with the way to finish", async () => {
    setRole(true);
    await mount();
    lib.planTableAwareReindex.mockResolvedValue(plan);
    lib.runTableAwareReindex.mockResolvedValue({ reset: 3, busy: 1, errors: [], leftovers: [], remaining: 1, stopped: null });
    dlg.appConfirm.mockResolvedValue(true);
    await act(async () => { byText("button", /Re-index with table-aware chunking/)!.click(); });
    await flush();
    expect(toast.showToast).toHaveBeenCalledWith({
      type: "warning",
      title: "3 documents reset for table-aware chunking — re-indexing starts now. 1 could not be reset right now (being indexed) — run it again to finish.",
    });
  });

  it("a run that could reset nothing (every document mid-batch) says so — never 're-indexing starts now'", async () => {
    setRole(true);
    await mount();
    lib.planTableAwareReindex.mockResolvedValue(plan);
    lib.runTableAwareReindex.mockResolvedValue({ reset: 0, busy: 4, errors: [], leftovers: [], remaining: 4, stopped: null });
    dlg.appConfirm.mockResolvedValue(true);
    await act(async () => { byText("button", /Re-index with table-aware chunking/)!.click(); });
    await flush();
    expect(toast.showToast).toHaveBeenCalledWith({
      type: "warning",
      title: "No document could be reset — 4 are being indexed right now. Run it again in a few minutes.",
    });
  });

  it("a database without the migration answers the dry run with the reason, and nothing is asked", async () => {
    setRole(true);
    await mount();
    lib.planTableAwareReindex.mockRejectedValue(new Error("Choosing a chunker needs migration 20261122_intel_roundG_ingest_integrity.sql — apply it first."));
    await act(async () => { byText("button", /Re-index with table-aware chunking/)!.click(); });
    await flush();
    expect(dlg.appConfirm).not.toHaveBeenCalled();
    expect(toast.showToast).toHaveBeenCalledWith({ type: "error", title: expect.stringMatching(/needs migration 20261122/) });
  });

  it("a run that stops part-way says how many it already reset, and why it stopped", async () => {
    setRole(true);
    await mount();
    lib.planTableAwareReindex.mockResolvedValue(plan);
    lib.runTableAwareReindex.mockResolvedValue({
      reset: 3, busy: 0, errors: [], leftovers: [], remaining: 1,
      stopped: "The re-index could not be recorded, so nothing was changed: insert failed",
    });
    dlg.appConfirm.mockResolvedValue(true);
    await act(async () => { byText("button", /Re-index with table-aware chunking/)!.click(); });
    await flush();
    expect(toast.showToast).toHaveBeenCalledWith({
      type: "error",
      title: "3 documents reset for table-aware chunking, then the run stopped: The re-index could not be recorded, so nothing was changed: insert failed — 1 still to reset; run it again to finish.",
    });
  });

  it("a person whose own key cannot read is stopped before anything is reset — the confirmation is never asked", async () => {
    setRole(true);
    await mount();
    lib.planTableAwareReindex.mockResolvedValue(plan);
    const problem = "you have no AI key saved — add yours in AI settings first";
    lib.ownVisionKeyProblem.mockResolvedValue(problem);
    dlg.appConfirm.mockResolvedValue(true);
    await act(async () => { byText("button", /Re-index with table-aware chunking/)!.click(); });
    await flush();
    expect(lib.ownVisionKeyProblem).toHaveBeenCalledWith("o1");
    expect(dlg.appConfirm).not.toHaveBeenCalled();
    expect(lib.runTableAwareReindex).not.toHaveBeenCalled();
    expect(toast.showToast).toHaveBeenCalledWith({ type: "error", title: tableAwareReindexKeyRefusal(plan, problem, { visionAllPages: false }) });
    expect(toast.showToast).toHaveBeenCalledWith({ type: "error", title: expect.stringContaining("The dry run counts 52 pages of this library as read by AI vision") });
  });

  it("a key check that cannot be made stops it too — nothing is reset", async () => {
    setRole(true);
    await mount();
    lib.planTableAwareReindex.mockResolvedValue(plan);
    lib.ownVisionKeyProblem.mockRejectedValue(new Error("Couldn't load AI usage (HTTP 500)"));
    dlg.appConfirm.mockResolvedValue(true);
    await act(async () => { byText("button", /Re-index with table-aware chunking/)!.click(); });
    await flush();
    expect(dlg.appConfirm).not.toHaveBeenCalled();
    expect(lib.runTableAwareReindex).not.toHaveBeenCalled();
    expect(toast.showToast).toHaveBeenCalledWith({
      type: "error", title: "Nothing was reset: your AI key could not be checked — Couldn't load AI usage (HTTP 500)",
    });
  });

  it("no AI-vision page in a library that does not read every page: no key is asked for", async () => {
    setRole(true);
    await mount();
    const textOnly = { documents: 6, toReset: 4, visionPagesToReread: 0 };
    lib.planTableAwareReindex.mockResolvedValue(textOnly);
    lib.runTableAwareReindex.mockResolvedValue({ reset: 4, busy: 0, errors: [], leftovers: [], remaining: 0, stopped: null });
    dlg.appConfirm.mockResolvedValue(true);
    await act(async () => { byText("button", /Re-index with table-aware chunking/)!.click(); });
    await flush();
    expect(lib.ownVisionKeyProblem).not.toHaveBeenCalled();
    expect((dlg.appConfirm.mock.calls[0][0] as { message: string }).message).toBe(tableAwareReindexMessage(textOnly));
    expect(lib.runTableAwareReindex).toHaveBeenCalledWith("lib-1");
  });

  it("a read-every-page library checks the key even with no vision page counted, and the confirmation says the nightly run skips documents with no uploader key", async () => {
    setRole(true);
    lib.getKnowledgeLibrary.mockResolvedValue({ ...library, aiFeatures: { visionAllPages: true } });
    await mount();
    const counted = { documents: 6, toReset: 4, visionPagesToReread: 0 };
    lib.planTableAwareReindex.mockResolvedValue(counted);
    lib.runTableAwareReindex.mockResolvedValue({ reset: 4, busy: 0, errors: [], leftovers: [], remaining: 0, stopped: null });
    dlg.appConfirm.mockResolvedValue(true);
    await act(async () => { byText("button", /Re-index with table-aware chunking/)!.click(); });
    await flush();
    expect(lib.ownVisionKeyProblem).toHaveBeenCalledWith("o1");
    const message = (dlg.appConfirm.mock.calls[0][0] as { message: string }).message;
    expect(message).toBe(tableAwareReindexMessage(counted, { visionAllPages: true }));
    expect(message).toMatch(/never indexes a document whose uploader has no AI key with budget left and a signed AI agreement/);
    expect(message).toMatch(/any Admin or Doc Control member with the app open and no usable key of their own indexes them text-only/);
  });

  it("a short document list (the page's list is capped at the row limit) still quotes the route's number", async () => {
    setRole(true);
    // The page holds two documents; the route paged through 3,000 of them.
    await mount([
      doc({ id: "a", name: "a.pdf", visionPages: 12 }),
      doc({ id: "b", name: "b.pdf", visionPages: 300 }),           // even one inflated past its 40 pages
    ]);
    const big = { documents: 3000, toReset: 2900, visionPagesToReread: 41000 };
    lib.planTableAwareReindex.mockResolvedValue(big);
    dlg.appConfirm.mockResolvedValue(false);
    await act(async () => { byText("button", /Re-index with table-aware chunking/)!.click(); });
    await flush();
    const message = (dlg.appConfirm.mock.calls[0][0] as { message: string }).message;
    expect(message).toBe(tableAwareReindexMessage(big));
    expect(message).toContain("2900 of 3000 documents");
    expect(message).toContain("The dry run counts 41000 pages of them as read by AI vision before.");
    expect(message).not.toMatch(/counts (52|312) pages/);
  });

  it("a stale document list that shows no AI-vision page still quotes the route's count, and still asks for the key", async () => {
    setRole(true);
    // Since the list was read, another driver indexed pages with AI vision.
    await mount([doc({ id: "a", name: "a.pdf", visionPages: 0 })]);
    const live = { documents: 1, toReset: 1, visionPagesToReread: 9 };
    lib.planTableAwareReindex.mockResolvedValue(live);
    dlg.appConfirm.mockResolvedValue(false);
    await act(async () => { byText("button", /Re-index with table-aware chunking/)!.click(); });
    await flush();
    expect(lib.ownVisionKeyProblem).toHaveBeenCalledWith("o1");
    const message = (dlg.appConfirm.mock.calls[0][0] as { message: string }).message;
    expect(message).toBe(tableAwareReindexMessage(live));
    expect(message).toContain("The dry run counts 9 pages of them as read by AI vision before.");
    expect(message).not.toContain("No page of those documents is counted");

    // And with a key that cannot read, the refusal quotes the same count.
    toast.showToast.mockReset();
    dlg.appConfirm.mockReset();
    const problem = "you have no AI key saved — add yours in AI settings first";
    lib.ownVisionKeyProblem.mockResolvedValue(problem);
    await act(async () => { byText("button", /Re-index with table-aware chunking/)!.click(); });
    await flush();
    expect(dlg.appConfirm).not.toHaveBeenCalled();
    expect(lib.runTableAwareReindex).not.toHaveBeenCalled();
    expect(toast.showToast).toHaveBeenCalledWith({ type: "error", title: tableAwareReindexKeyRefusal(live, problem, { visionAllPages: false }) });
    expect(toast.showToast).toHaveBeenCalledWith({ type: "error", title: expect.stringContaining("The dry run counts 9 pages of this library as read by AI vision") });
  });

  it("a document reset whose old passages could not all be deleted counts as reset — the toast never says it could not be", async () => {
    setRole(true);
    await mount();
    lib.planTableAwareReindex.mockResolvedValue(plan);
    const left = "d-9: chunks: timeout (the row is queued; the re-index's first batch clears what is left)";
    lib.runTableAwareReindex.mockResolvedValue({ reset: 4, busy: 0, errors: [], leftovers: [left], remaining: 0, stopped: null });
    dlg.appConfirm.mockResolvedValue(true);
    await act(async () => { byText("button", /Re-index with table-aware chunking/)!.click(); });
    await flush();
    expect(toast.showToast).toHaveBeenCalledWith({
      type: "warning",
      title: `4 documents reset for table-aware chunking — re-indexing starts now. For 1 of them the old passages could not all be deleted yet: ${left}`,
    });
    expect(toast.showToast).not.toHaveBeenCalledWith(expect.objectContaining({ title: expect.stringMatching(/could not be reset|could not be:/) }));
  });

  it("a document that really could not be reset is said, with what is left to run and how many are busy", async () => {
    setRole(true);
    await mount();
    lib.planTableAwareReindex.mockResolvedValue(plan);
    lib.runTableAwareReindex.mockResolvedValue({ reset: 2, busy: 1, errors: ["d-9: row: timeout"], leftovers: [], remaining: 2, stopped: null });
    dlg.appConfirm.mockResolvedValue(true);
    await act(async () => { byText("button", /Re-index with table-aware chunking/)!.click(); });
    await flush();
    expect(toast.showToast).toHaveBeenCalledWith({
      type: "error",
      title: "2 documents reset for table-aware chunking; 1 could not be reset: d-9: row: timeout. 2 still to reset (1 being indexed right now) — run it again to finish.",
    });
  });

  it("never offered on a database without 20261122 (no chunk_version column), where it could only answer 424", async () => {
    setRole(true);
    await mount([doc({ id: "a", name: "a.pdf", chunkVersion: undefined }), doc({ id: "b", name: "b.pdf", chunkVersion: undefined })]);
    expect(byText("button", /Re-index with table-aware chunking/)).toBeUndefined();
    expect(byText("button", /Re-index all/)).toBeTruthy();
  });

  it("not offered once every indexed document is on table-aware chunking", async () => {
    setRole(true);
    await mount([doc({ id: "a", name: "a.pdf", chunkVersion: 2 }), doc({ id: "b", name: "b.pdf", status: "pending", pagesIndexed: 0, chunkVersion: null })]);
    expect(byText("button", /Re-index with table-aware chunking/)).toBeUndefined();
    expect(byText("button", /Re-index all/)).toBeTruthy();
  });
});

describe("ING-9 — the browser-side PDF check runs before anything is uploaded", () => {
  const XLSX_HEAD = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00, 0x08, 0x00]);
  async function drop(file: File) {
    const input = host.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
    await flush();
  }

  it("a spreadsheet by name is refused naming the importer", async () => {
    setRole(true);
    await mount([]);
    await drop(new File([XLSX_HEAD], "equipment-list.xlsx"));
    expect(lib.addKnowledgeDocument).not.toHaveBeenCalled();
    expect(toast.showToast).toHaveBeenCalledWith({
      type: "error",
      title: expect.stringContaining('"equipment-list.xlsx" is not a PDF (it looks like an Excel or Word file). To load an equipment list, open Operating areas and use Import CSV'),
    });
  });

  it("a spreadsheet renamed .pdf is refused by its bytes — nothing is uploaded", async () => {
    setRole(true);
    await mount([]);
    await drop(new File([XLSX_HEAD], "equipment-list.pdf", { type: "application/pdf" }));
    expect(lib.addKnowledgeDocument).not.toHaveBeenCalled();
    expect(toast.showToast).toHaveBeenCalledWith({
      type: "error",
      title: expect.stringContaining('Only PDF files can be indexed — "equipment-list.pdf" is not a PDF (it looks like an Excel or Word file)'),
    });
  });

  it("a real PDF goes on to the upload", async () => {
    setRole(true);
    await mount([]);
    lib.addKnowledgeDocument.mockResolvedValue(doc({ id: "new" }));
    await drop(new File([new TextEncoder().encode("%PDF-1.7\n%âãÏÓ\n")], "spec.pdf", { type: "application/pdf" }));
    expect(lib.addKnowledgeDocument).toHaveBeenCalledTimes(1);
    expect((lib.addKnowledgeDocument.mock.calls[0][0] as { file: File }).file.name).toBe("spec.pdf");
  });

  it("a head with no header and no other format's signature goes on too — the server decides (pdf.js opens a late header)", async () => {
    setRole(true);
    await mount([]);
    lib.addKnowledgeDocument.mockResolvedValue(doc({ id: "new" }));
    await drop(new File([new TextEncoder().encode("X-Scanner-Preamble: 2460 bytes\n")], "scan.pdf"));
    expect(lib.addKnowledgeDocument).toHaveBeenCalledTimes(1);
  });
});
