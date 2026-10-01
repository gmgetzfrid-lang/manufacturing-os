// @vitest-environment jsdom
//
// intelligence Round G — I-05 PR-6, the template Generate dialog as RENDERED.
//   When the server stops a draft batch early it says why (`stopped`: the
//   cap, or a draft it could not read) and names every row it left out
//   (`skippedRows`). The dialog shows both — a left-out row is never silent —
//   and the batch can always move on, even when the only row of a slice was
//   left out (no documents to review yet).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const ot = vi.hoisted(() => ({
  uploadTemplateFile: vi.fn(async () => ({ key: "orgs/o1/output-data/d.xlsx", name: "d.xlsx" })),
  draftDocuments: vi.fn(),
  renderDocuments: vi.fn(),
  fileDocumentsToLibrary: vi.fn(),
}));
vi.mock("@/lib/outputTemplates", () => ot);
vi.mock("@/components/providers/ToastProvider", () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock("@/components/providers/RoleContext", () => ({ useRole: () => ({ uid: "u1", userEmail: "u1@x" }) }));
vi.mock("@/lib/supabase", () => {
  const b: Record<string, unknown> = {};
  for (const m of ["select", "eq", "order"]) b[m] = () => b;
  b.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: [] }).then(res);
  return { supabase: { from: () => b } };
});

import GenerateModal from "@/components/templates/GenerateModal";
import type { OutputTemplate } from "@/lib/outputTemplates";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const template: OutputTemplate = {
  id: "tpl1", orgId: "o1", name: "Letter", description: null, kind: "docx",
  templateFileKey: "orgs/o1/output-templates/t.docx", templateFileName: "t.docx",
  exampleFiles: [], exampleText: null, instructions: null, mode: "per_row", columnMap: {}, filenamePattern: null,
  createdAt: "2026-10-01",
  placeholders: [{ tag: "name", label: "Name", kind: "data" }, { tag: "body", label: "Body", kind: "ai" }],
};

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  ot.draftDocuments.mockReset();
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const settle = async () => { for (let i = 0; i < 3; i++) await act(async () => { await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); }); };
const button = (label: RegExp) => [...host.querySelectorAll("button")].find((b) => label.test(b.textContent ?? "")) as HTMLButtonElement | undefined;

async function openAndDraft() {
  await act(async () => {
    root.render(React.createElement(GenerateModal, { orgId: "o1", template, onClose: () => undefined, onGenerated: () => undefined }));
  });
  const input = host.querySelector('input[type="file"]') as HTMLInputElement;
  Object.defineProperty(input, "files", { value: [new File(["x"], "d.xlsx")], configurable: true });
  await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
  await settle();
  await act(async () => { button(/^Draft documents/)!.click(); });
  await settle();
}

describe("PR-6 — the dialog says why a batch stopped and names every row left out", () => {
  it("documents drafted before an unreadable row are shown, the row is named with its reason, and the batch continues from the server's offset", async () => {
    ot.draftDocuments.mockResolvedValueOnce({
      documents: [{ values: { name: "A", body: "b1" }, filename: "A.docx", sourceRow: 1 }],
      skippedRows: [{ row: 2, reason: "the reply's JSON did not parse (a reply cut off at its length limit does this)" }],
      stopped: "The AI's draft for row 2 couldn't be read — the reply's JSON did not parse. Row 2 was left out — no document with blank AI sections was made; the rows drafted before it are kept, and the next batch starts after it.",
      nextOffset: 2, rowCount: 3, estCostUsd: 0.01,
    });
    await openAndDraft();
    expect(host.textContent).toMatch(/Drafting stopped part-way\./);
    expect(host.textContent).toMatch(/Left out — no document was made for this row:/);
    expect(host.textContent).toMatch(/Row 2: the reply's JSON did not parse/);
    expect(host.textContent).toMatch(/1 document drafted/);
    // rows left are counted from where the server says the next batch starts, not from the documents
    const next = button(/Draft the next batch/);
    expect(next?.textContent).toMatch(/\(1 rows left\)/);
    ot.draftDocuments.mockResolvedValueOnce({ documents: [{ values: { name: "C", body: "b3" }, filename: "C.docx", sourceRow: 3 }], nextOffset: null, rowCount: 3 });
    await act(async () => { next!.click(); });
    await settle();
    expect(ot.draftDocuments).toHaveBeenLastCalledWith(expect.objectContaining({ rowOffset: 2 }));
    // the left-out row stays named after the next batch; the stop note is cleared
    expect(host.textContent).toMatch(/Row 2: the reply's JSON did not parse/);
    expect(host.textContent).not.toMatch(/Drafting stopped part-way/);
    expect(host.textContent).toMatch(/2 documents drafted/);
  });

  it("a slice whose only row was left out still offers the next batch (there is nothing to review yet)", async () => {
    ot.draftDocuments.mockResolvedValueOnce({
      documents: [], skippedRows: [{ row: 1, reason: "the reply held no JSON object" }],
      stopped: "The AI's draft for row 1 couldn't be read — the reply held no JSON object. Row 1 was left out.",
      nextOffset: 1, rowCount: 3,
    });
    await openAndDraft();
    expect(host.textContent).toMatch(/Row 1: the reply held no JSON object/);
    const next = button(/Draft the next batch/);
    expect(next?.textContent).toMatch(/\(2 rows left\)/);
    ot.draftDocuments.mockResolvedValueOnce({ documents: [], nextOffset: null, rowCount: 3 });
    await act(async () => { next!.click(); });
    await settle();
    expect(ot.draftDocuments).toHaveBeenLastCalledWith(expect.objectContaining({ rowOffset: 1 }));
  });

  it("a cap stop part-way is said too", async () => {
    ot.draftDocuments.mockResolvedValueOnce({
      documents: [{ values: { name: "A", body: "b1" }, filename: "A.docx", sourceRow: 1 }],
      stopped: "Monthly AI budget reached ($10.00 of $10.00).", nextOffset: 1, rowCount: 3,
    });
    await openAndDraft();
    expect(host.textContent).toMatch(/Drafting stopped part-way\. Monthly AI budget reached/);
    expect(host.textContent).not.toMatch(/Left out/);
  });
});
