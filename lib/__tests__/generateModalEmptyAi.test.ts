// @vitest-environment jsdom
//
// intelligence Round G — I-20, PR-6 done-when 3, the template Generate
// dialog as RENDERED. A drafted document whose AI-written field came back
// genuinely empty (missing, or whitespace) is marked on its row, and nothing
// is made from it — downloaded or filed into document control — until that
// field is filled in or explicitly ticked "Leave it blank", field by field.
// The server never refuses an empty field (some AI fields are optional);
// the reviewer decides.
//
// REGRESSION: a batch whose AI fields are all written renders exactly as
// before — no mark, no refusal, the Download button sends the reviewed values.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const ot = vi.hoisted(() => ({
  uploadTemplateFile: vi.fn(async () => ({ key: "orgs/o1/output-data/d.xlsx", name: "d.xlsx" })),
  draftDocuments: vi.fn(),
  renderDocuments: vi.fn(async () => undefined),
  fileDocumentsToLibrary: vi.fn(async () => ({ filed: 0, errors: [] as string[] })),
}));
const toast = vi.hoisted(() => ({ showToast: vi.fn() }));
vi.mock("@/lib/outputTemplates", () => ot);
vi.mock("@/components/providers/ToastProvider", () => ({ useToast: () => toast }));
vi.mock("@/components/providers/RoleContext", () => ({ useRole: () => ({ uid: "u1", userEmail: "u1@x" }) }));
vi.mock("@/lib/supabase", () => {
  const b: Record<string, unknown> = {};
  for (const m of ["select", "eq", "order"]) b[m] = () => b;
  b.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: [{ id: "L1", name: "Correspondence" }] }).then(res);
  return { supabase: { from: () => b } };
});

import GenerateModal, { emptyAiFields, documentsBlockedByEmptyAi } from "@/components/templates/GenerateModal";
import type { OutputTemplate } from "@/lib/outputTemplates";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const template: OutputTemplate = {
  id: "tpl1", orgId: "o1", name: "Letter", description: null, kind: "docx",
  templateFileKey: "orgs/o1/output-templates/t.docx", templateFileName: "t.docx",
  exampleFiles: [], exampleText: null, instructions: null, mode: "per_row", columnMap: {}, filenamePattern: null,
  createdAt: "2026-10-01",
  placeholders: [
    { tag: "name", label: "Name", kind: "data" },
    { tag: "body", label: "Body", kind: "ai" },
    { tag: "closing", label: "Closing", kind: "ai" },
  ],
};

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  ot.draftDocuments.mockReset();
  ot.renderDocuments.mockClear();
  ot.fileDocumentsToLibrary.mockClear();
  toast.showToast.mockReset();
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const settle = async () => { for (let i = 0; i < 3; i++) await act(async () => { await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); }); };
const button = (label: RegExp) => [...host.querySelectorAll("button")].find((b) => label.test(b.textContent ?? "")) as HTMLButtonElement | undefined;
const click = async (el: HTMLElement) => { await act(async () => { el.click(); }); await settle(); };

async function openAndDraft(documents: Array<{ values: Record<string, string>; filename: string; sourceRow?: number }>) {
  ot.draftDocuments.mockResolvedValueOnce({ documents, nextOffset: null, rowCount: documents.length, estCostUsd: 0.01 });
  await act(async () => {
    root.render(React.createElement(GenerateModal, { orgId: "o1", template, onClose: () => undefined, onGenerated: () => undefined }));
  });
  await settle();
  const input = host.querySelector('input[type="file"]') as HTMLInputElement;
  Object.defineProperty(input, "files", { value: [new File(["x"], "d.xlsx")], configurable: true });
  await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
  await settle();
  await click(button(/^Draft documents/)!);
}
const rowButton = (filename: string) => [...host.querySelectorAll("li > button")].find((b) => b.textContent?.includes(filename)) as HTMLButtonElement;

describe("PR-6 — the pure reading of an empty AI field", () => {
  it("missing or whitespace-only AI fields are empty; data fields are never counted", () => {
    const aiTags = ["body", "closing"];
    expect(emptyAiFields({ values: { name: "", body: "Text", closing: "Regards" }, filename: "a" }, aiTags)).toEqual([]);
    expect(emptyAiFields({ values: { name: "A", body: "  \n ", closing: "Regards" }, filename: "a" }, aiTags)).toEqual(["body"]);
    expect(emptyAiFields({ values: { name: "A", body: "" }, filename: "a" }, aiTags)).toEqual(["body", "closing"]);
  });
  it("a field explicitly left blank no longer blocks its document — only that field, only that document", () => {
    const docs = [
      { values: { body: "", closing: "" }, filename: "a" },
      { values: { body: "", closing: "x" }, filename: "b" },
    ];
    expect(documentsBlockedByEmptyAi(docs, ["body", "closing"], {})).toEqual([{ index: 0, tags: ["body", "closing"] }, { index: 1, tags: ["body"] }]);
    expect(documentsBlockedByEmptyAi(docs, ["body", "closing"], { "0|body": true })).toEqual([{ index: 0, tags: ["closing"] }, { index: 1, tags: ["body"] }]);
    expect(documentsBlockedByEmptyAi(docs, ["body", "closing"], { "0|body": true, "0|closing": true, "1|body": true })).toEqual([]);
  });
});

describe("PR-6 done-when 3 — a document with an empty AI field is not made without an explicit per-field override", () => {
  it("REGRESSION: every AI field written → no mark, no refusal; Download sends the reviewed values exactly as before", async () => {
    await openAndDraft([
      { values: { name: "Acme", body: "Please find attached.", closing: "Regards" }, filename: "Acme.docx", sourceRow: 1 },
      { values: { name: "Brix", body: "As discussed.", closing: "Thanks" }, filename: "Brix.docx", sourceRow: 2 },
    ]);
    expect(host.querySelector("[data-empty-ai]")).toBeNull();
    expect(host.querySelector("[data-empty-ai-blocked]")).toBeNull();
    const download = button(/^Download 2 documents/)!;
    expect(download.disabled).toBe(false);
    await click(download);
    expect(ot.renderDocuments).toHaveBeenCalledTimes(1);
    expect(ot.renderDocuments).toHaveBeenCalledWith(expect.objectContaining({
      documents: [
        { values: { name: "Acme", body: "Please find attached.", closing: "Regards" }, filename: "Acme.docx" },
        { values: { name: "Brix", body: "As discussed.", closing: "Thanks" }, filename: "Brix.docx" },
      ],
    }));
  });

  it("reproduction → fix: a genuinely empty AI field is marked on its collapsed row, and Download and File are refused until it is dealt with", async () => {
    await openAndDraft([
      { values: { name: "Acme", body: "Please find attached.", closing: "Regards" }, filename: "Acme.docx", sourceRow: 1 },
      { values: { name: "Brix", body: "   ", closing: "Thanks" }, filename: "Brix.docx", sourceRow: 2 },
    ]);
    // visible without expanding the document
    expect(rowButton("Brix.docx").querySelector("[data-empty-ai]")?.textContent).toMatch(/1 empty AI field$/);
    expect(rowButton("Acme.docx").querySelector("[data-empty-ai]")).toBeNull();
    const alert = host.querySelector("[data-empty-ai-blocked]")!;
    expect(alert.textContent).toMatch(/1 document has an empty AI-written field\./);
    expect(alert.textContent).toMatch(/a blank section is\s+never put into a document unless you say so/);
    expect(button(/^Download 2 documents/)!.disabled).toBe(true);
    // choosing a library to file into is refused the same way
    const select = [...host.querySelectorAll("select")].find((s) => [...s.options].some((o) => o.value === "L1")) as HTMLSelectElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
    await act(async () => { setter.call(select, "L1"); select.dispatchEvent(new Event("change", { bubbles: true })); });
    await settle();
    expect(button(/^File 2 into library/)!.disabled).toBe(true);
    expect(ot.renderDocuments).not.toHaveBeenCalled();
    expect(ot.fileDocumentsToLibrary).not.toHaveBeenCalled();
  });

  it("'Show the first one' opens the document; the field says the AI wrote nothing; ticking 'Leave it blank' is the override, and the blank goes through as written", async () => {
    await openAndDraft([
      { values: { name: "Acme", body: "Please find attached.", closing: "Regards" }, filename: "Acme.docx", sourceRow: 1 },
      { values: { name: "Brix", body: "", closing: "Thanks" }, filename: "Brix.docx", sourceRow: 2 },
    ]);
    await click(button(/Show the first one \(Brix\.docx\)/)!);
    const field = host.querySelector('[data-empty-ai-field="body"]') as HTMLElement;
    expect(field.textContent).toMatch(/The AI wrote nothing here\./);
    const box = field.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(box.checked).toBe(false);
    await click(box);
    expect(box.checked).toBe(true);
    expect(host.querySelector("[data-empty-ai-blocked]")).toBeNull();
    expect(rowButton("Brix.docx").querySelector("[data-empty-ai-kept]")?.textContent).toMatch(/left blank on purpose/);
    const download = button(/^Download 2 documents/)!;
    expect(download.disabled).toBe(false);
    await click(download);
    expect(ot.renderDocuments).toHaveBeenCalledWith(expect.objectContaining({
      documents: expect.arrayContaining([{ values: { name: "Brix", body: "", closing: "Thanks" }, filename: "Brix.docx" }]),
    }));
  });

  it("the override is per field: leaving one empty field blank does not release the document's other empty field", async () => {
    await openAndDraft([{ values: { name: "Acme", body: "", closing: "" }, filename: "Acme.docx", sourceRow: 1 }]);
    expect(rowButton("Acme.docx").querySelector("[data-empty-ai]")?.textContent).toMatch(/2 empty AI fields$/);
    expect(host.querySelector("[data-empty-ai-blocked]")!.textContent).toMatch(/1 document has 2 empty AI-written fields\./);
    // the first document is open by default
    await click(host.querySelector('[data-empty-ai-field="body"] input[type="checkbox"]') as HTMLElement);
    expect(rowButton("Acme.docx").querySelector("[data-empty-ai]")?.textContent).toMatch(/1 empty AI field$/);
    expect(button(/^Download 1 document$/)!.disabled).toBe(true);
  });

  it("filling the field in releases the document — no override needed", async () => {
    await openAndDraft([{ values: { name: "Acme", body: "", closing: "Regards" }, filename: "Acme.docx", sourceRow: 1 }]);
    const area = [...host.querySelectorAll("textarea")].find((t) => (t as HTMLTextAreaElement).value === "") as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    await act(async () => { setter.call(area, "Written by the reviewer."); area.dispatchEvent(new Event("input", { bubbles: true })); });
    await settle();
    expect(host.querySelector("[data-empty-ai-blocked]")).toBeNull();
    expect(host.querySelector('[data-empty-ai-field="body"]')).toBeNull();
    await click(button(/^Download 1 document$/)!);
    expect(ot.renderDocuments).toHaveBeenCalledWith(expect.objectContaining({
      documents: [{ values: { name: "Acme", body: "Written by the reviewer.", closing: "Regards" }, filename: "Acme.docx" }],
    }));
  });

  it("an AI field the draft left out entirely is shown (so it can be filled in or left blank), never silently absent", async () => {
    await openAndDraft([{ values: { name: "Acme", body: "Text" }, filename: "Acme.docx", sourceRow: 1 }]);
    expect(host.querySelector('[data-empty-ai-field="closing"]')).not.toBeNull();
    expect(button(/^Download 1 document$/)!.disabled).toBe(true);
  });
});
