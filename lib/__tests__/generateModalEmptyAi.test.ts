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
// I-20 fix pass 4: a field the AI left empty in several documents (an
// optional field empty in every row) can be left blank in all of them with
// one tick — per field, never a tick that releases every field. The tick
// writes each document's own override, so it reaches only the documents
// drafted when it is ticked; the per-document tick still works, and Download
// and File stay refused until every empty AI field is filled or overridden.
//
// I-20 fix pass 5: a tick lasts only while its field is empty. A value
// typed into the field ends it (keepBlankAfterEdit), so a field filled in
// and then cleared again is refused until it is ticked again — whether the
// tick was a document's own or the batch's. Unticking a field's batch tick
// takes the tick off that field in every document where it is still empty,
// a tick set on one document included, and the dialog says so.
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

import GenerateModal, {
  emptyAiFields, documentsBlockedByEmptyAi, emptyAiFieldsAcrossBatch, setKeepBlankAcrossBatch, keepBlankAfterEdit,
} from "@/components/templates/GenerateModal";
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

async function openAndDraft(
  documents: Array<{ values: Record<string, string>; filename: string; sourceRow?: number }>,
  more?: { nextOffset: number; rowCount: number },
) {
  ot.draftDocuments.mockResolvedValueOnce({ documents, nextOffset: more?.nextOffset ?? null, rowCount: more?.rowCount ?? documents.length, estCostUsd: 0.01 });
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

describe("PR-6 (I-20 fix pass 4) — one field left blank in every document where the AI wrote nothing: one tick per field", () => {
  const batchBox = (tag: string) => host.querySelector(`[data-empty-ai-batch-field="${tag}"] input[type="checkbox"]`) as HTMLInputElement | null;
  const three = (closing = "") => [
    { values: { name: "Acme", body: "Please find attached.", closing }, filename: "Acme.docx", sourceRow: 1 },
    { values: { name: "Brix", body: "As discussed.", closing }, filename: "Brix.docx", sourceRow: 2 },
    { values: { name: "Cole", body: "For review.", closing }, filename: "Cole.docx", sourceRow: 3 },
  ];

  it("pure: the fields empty in more than one document, and the batch tick writes that field's override on exactly those documents", () => {
    const docs = [
      { values: { body: "", closing: "" }, filename: "a" },
      { values: { body: "", closing: "x" }, filename: "b" },
      { values: { body: "y", closing: "" }, filename: "c" },
      { values: { body: "z", closing: "w" }, filename: "d" },
    ];
    expect(emptyAiFieldsAcrossBatch(docs, ["body", "closing"])).toEqual([{ tag: "body", indexes: [0, 1] }, { tag: "closing", indexes: [0, 2] }]);
    // a field empty in one document only has no batch tick (the per-document tick is the same)
    expect(emptyAiFieldsAcrossBatch(docs.slice(1), ["body", "closing"])).toEqual([]);
    const kept = setKeepBlankAcrossBatch({}, docs, "closing", true);
    expect(kept).toEqual({ "0|closing": true, "2|closing": true });
    // per field: body still blocks documents 0 and 1
    expect(documentsBlockedByEmptyAi(docs, ["body", "closing"], kept)).toEqual([{ index: 0, tags: ["body"] }, { index: 1, tags: ["body"] }]);
    // untick takes those overrides back; another field's overrides are left as they were
    expect(setKeepBlankAcrossBatch({ ...kept, "1|body": true }, docs, "closing", false)).toEqual({ "0|closing": false, "2|closing": false, "1|body": true });
  });

  it("reproduction → fix: an optional AI field empty in every row is left blank in all of them with ONE tick — no document expanded — and the blanks go through as written", async () => {
    await openAndDraft(three());
    expect(button(/^Download 3 documents/)!.disabled).toBe(true);
    const label = host.querySelector('[data-empty-ai-batch-field="closing"]')!;
    expect(label.textContent).toMatch(/Leave \{closing\} blank in all 3 documents where the AI wrote nothing/);
    expect(batchBox("closing")!.checked).toBe(false);
    await click(batchBox("closing")!);
    expect(batchBox("closing")!.checked).toBe(true);
    expect(host.querySelector("[data-empty-ai-blocked]")).toBeNull();
    for (const f of ["Acme.docx", "Brix.docx", "Cole.docx"]) {
      expect(rowButton(f).querySelector("[data-empty-ai-kept]")?.textContent).toMatch(/left blank on purpose/);
    }
    // the per-document tick reads the same override
    expect((host.querySelector('[data-empty-ai-field="closing"] input[type="checkbox"]') as HTMLInputElement).checked).toBe(true);
    const download = button(/^Download 3 documents/)!;
    expect(download.disabled).toBe(false);
    await click(download);
    expect(ot.renderDocuments).toHaveBeenCalledWith(expect.objectContaining({
      documents: three().map((d) => ({ values: d.values, filename: d.filename })),
    }));
  });

  it("negative control — per field, never a global bypass: leaving one field blank across the batch does not release another field's empty documents", async () => {
    await openAndDraft([
      { values: { name: "Acme", body: "", closing: "" }, filename: "Acme.docx", sourceRow: 1 },
      { values: { name: "Brix", body: "", closing: "" }, filename: "Brix.docx", sourceRow: 2 },
    ]);
    // one tick per field, and no other control
    expect([...host.querySelectorAll("[data-empty-ai-batch-field]")].map((l) => l.getAttribute("data-empty-ai-batch-field"))).toEqual(["body", "closing"]);
    expect(host.querySelectorAll('[data-empty-ai-batch] input[type="checkbox"]')).toHaveLength(2);
    await click(batchBox("closing")!);
    expect(host.querySelector("[data-empty-ai-blocked]")!.textContent).toMatch(/2 documents have 2 empty AI-written fields\./);
    expect(button(/^Download 2 documents/)!.disabled).toBe(true);
    const select = [...host.querySelectorAll("select")].find((sel) => [...sel.options].some((o) => o.value === "L1")) as HTMLSelectElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
    await act(async () => { setter.call(select, "L1"); select.dispatchEvent(new Event("change", { bubbles: true })); });
    await settle();
    expect(button(/^File 2 into library/)!.disabled).toBe(true);
    expect(ot.renderDocuments).not.toHaveBeenCalled();
    expect(ot.fileDocumentsToLibrary).not.toHaveBeenCalled();
    // the second field's own tick releases them
    await click(batchBox("body")!);
    expect(host.querySelector("[data-empty-ai-blocked]")).toBeNull();
    expect(button(/^Download 2 documents/)!.disabled).toBe(false);
  });

  it("the tick reaches only the documents drafted when it was ticked: the next batch's empty field is refused again, until it is ticked again", async () => {
    await openAndDraft(three().slice(0, 2), { nextOffset: 2, rowCount: 3 });
    await click(batchBox("closing")!);
    expect(button(/^Download 2 documents/)!.disabled).toBe(false);
    ot.draftDocuments.mockResolvedValueOnce({ documents: [three()[2]], nextOffset: null, rowCount: 3, estCostUsd: 0.01 });
    await click(button(/^Draft the next batch/)!);
    expect(button(/^Download 3 documents/)!.disabled).toBe(true);
    expect(host.querySelector("[data-empty-ai-blocked]")!.textContent).toMatch(/1 document has an empty AI-written field\./);
    expect(rowButton("Cole.docx").querySelector("[data-empty-ai]")).not.toBeNull();
    expect(batchBox("closing")!.checked).toBe(false);
    expect(host.querySelector('[data-empty-ai-batch-field="closing"]')!.textContent).toMatch(/all 3 documents/);
    await click(batchBox("closing")!);
    expect(button(/^Download 3 documents/)!.disabled).toBe(false);
  });

  it("unticking takes the overrides back (Download refused again); a document's own tick still works; a field empty in one document offers no batch tick", async () => {
    await openAndDraft(three());
    await click(batchBox("closing")!);
    await click(batchBox("closing")!);
    expect(batchBox("closing")!.checked).toBe(false);
    expect(button(/^Download 3 documents/)!.disabled).toBe(true);
    expect(host.querySelector("[data-empty-ai-blocked]")!.textContent).toMatch(/3 documents have 3 empty AI-written fields\./);
    // the first document is open: its own tick releases it alone
    await click(host.querySelector('[data-empty-ai-field="closing"] input[type="checkbox"]') as HTMLElement);
    expect(host.querySelector("[data-empty-ai-blocked]")!.textContent).toMatch(/2 documents have 2 empty AI-written fields\./);
    expect(batchBox("closing")!.checked).toBe(false);
    act(() => root.unmount());
    root = createRoot(host);
    await openAndDraft([three()[0], { ...three("Thanks")[1] }]);
    expect(host.querySelector("[data-empty-ai-batch]")).toBeNull();
    expect(button(/^Download 2 documents/)!.disabled).toBe(true);
  });

  it("REGRESSION: every AI field written — no batch tick is offered", async () => {
    await openAndDraft(three("Regards"));
    expect(host.querySelector("[data-empty-ai-batch]")).toBeNull();
    expect(button(/^Download 3 documents/)!.disabled).toBe(false);
  });
});

describe("PR-6 (I-20 fix pass 5) — a tick lasts only while its field is empty; unticking a field's batch tick takes off every tick of that field on the documents where it is still empty", () => {
  const batchBox = (tag: string) => host.querySelector(`[data-empty-ai-batch-field="${tag}"] input[type="checkbox"]`) as HTMLInputElement | null;
  const ownBox = (tag: string) => host.querySelector(`[data-empty-ai-field="${tag}"] input[type="checkbox"]`) as HTMLInputElement | null;
  const three = () => [
    { values: { name: "Acme", body: "Please find attached.", closing: "" }, filename: "Acme.docx", sourceRow: 1 },
    { values: { name: "Brix", body: "As discussed.", closing: "" }, filename: "Brix.docx", sourceRow: 2 },
    { values: { name: "Cole", body: "For review.", closing: "" }, filename: "Cole.docx", sourceRow: 3 },
  ];
  /** Type into the open document's field `tag` (an AI field: a textarea). */
  async function type(tag: string, value: string) {
    const label = [...host.querySelectorAll("label")].find((l) => l.querySelector("span")?.textContent?.startsWith(tag) && l.querySelector("textarea"));
    const area = label!.querySelector("textarea") as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    await act(async () => { setter.call(area, value); area.dispatchEvent(new Event("input", { bubbles: true })); });
    await settle();
  }
  const open = async (filename: string) => {
    const row = rowButton(filename);
    if (!row.parentElement!.querySelector('[data-empty-ai-field], textarea')) await click(row);
  };
  async function chooseLibrary() {
    const select = [...host.querySelectorAll("select")].find((sel) => [...sel.options].some((o) => o.value === "L1")) as HTMLSelectElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
    await act(async () => { setter.call(select, "L1"); select.dispatchEvent(new Event("change", { bubbles: true })); });
    await settle();
  }

  it("pure: a value typed into a field ends that document's tick for it, and only that one; whitespace ends nothing; unchanged state is returned as is", () => {
    const kb = { "0|closing": true, "1|closing": true, "0|body": true };
    expect(keepBlankAfterEdit(kb, 1, "closing", "Thanks")).toEqual({ "0|closing": true, "0|body": true });
    expect(keepBlankAfterEdit(kb, 1, "closing", "   ")).toBe(kb);
    expect(keepBlankAfterEdit(kb, 2, "closing", "Thanks")).toBe(kb);
    expect(keepBlankAfterEdit(kb, 0, "name", "Acme")).toBe(kb);
  });

  it("reproduction → fix (the reviewer's sequence): three empty, the batch tick, document 2 filled in, the tick taken off, documents 1 and 3 filled in, document 2 cleared — Download and File are refused until document 2 is ticked again", async () => {
    await openAndDraft(three());
    await click(batchBox("closing")!);
    expect(button(/^Download 3 documents/)!.disabled).toBe(false);
    await open("Brix.docx");
    await type("closing", "Thanks");
    // still offered for the two documents where it is empty, and still read as ticked there
    expect(host.querySelector('[data-empty-ai-batch-field="closing"]')!.textContent).toMatch(/all 2 documents/);
    expect(batchBox("closing")!.checked).toBe(true);
    await click(batchBox("closing")!);
    expect(button(/^Download 3 documents/)!.disabled).toBe(true);
    await open("Acme.docx");
    await type("closing", "Regards");
    await open("Cole.docx");
    await type("closing", "Best");
    expect(button(/^Download 3 documents/)!.disabled).toBe(false);
    await open("Brix.docx");
    await type("closing", "");
    // document 2's field is empty again and carries no tick: refused (it used to keep the batch tick and go through)
    expect(button(/^Download 3 documents/)!.disabled).toBe(true);
    expect(host.querySelector("[data-empty-ai-blocked]")!.textContent).toMatch(/1 document has an empty AI-written field\./);
    expect(rowButton("Brix.docx").querySelector("[data-empty-ai]")?.textContent).toMatch(/1 empty AI field$/);
    expect(ownBox("closing")!.checked).toBe(false);
    await chooseLibrary();
    expect(button(/^File 3 into library/)!.disabled).toBe(true);
    expect(ot.renderDocuments).not.toHaveBeenCalled();
    expect(ot.fileDocumentsToLibrary).not.toHaveBeenCalled();
    // ticked again, it goes through as written
    await click(ownBox("closing")!);
    expect(button(/^Download 3 documents/)!.disabled).toBe(false);
    await click(button(/^Download 3 documents/)!);
    expect(ot.renderDocuments).toHaveBeenCalledWith(expect.objectContaining({
      documents: [
        { values: { name: "Acme", body: "Please find attached.", closing: "Regards" }, filename: "Acme.docx" },
        { values: { name: "Brix", body: "As discussed.", closing: "" }, filename: "Brix.docx" },
        { values: { name: "Cole", body: "For review.", closing: "Best" }, filename: "Cole.docx" },
      ],
    }));
  });

  it("reproduction → fix: a document's own tick, then the field filled in, then cleared again — refused, the tick reads unticked", async () => {
    await openAndDraft([{ values: { name: "Acme", body: "Text", closing: "" }, filename: "Acme.docx", sourceRow: 1 }]);
    await click(ownBox("closing")!);
    expect(button(/^Download 1 document$/)!.disabled).toBe(false);
    await type("closing", "Regards");
    await type("closing", "");
    expect(ownBox("closing")!.checked).toBe(false);
    expect(button(/^Download 1 document$/)!.disabled).toBe(true);
    expect(host.querySelector("[data-empty-ai-blocked]")).not.toBeNull();
  });

  it("negative control: editing anything else leaves a tick alone — another field of the same document, the file name, whitespace in the ticked field itself", async () => {
    await openAndDraft([{ values: { name: "Acme", body: "", closing: "" }, filename: "Acme.docx", sourceRow: 1 }]);
    await click(ownBox("closing")!);
    await type("body", "Written by the reviewer.");
    const name = host.querySelector("input.font-mono") as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => { setter.call(name, "Acme-final.docx"); name.dispatchEvent(new Event("input", { bubbles: true })); });
    await settle();
    await type("closing", "   ");
    expect(ownBox("closing")!.checked).toBe(true);
    expect(button(/^Download 1 document$/)!.disabled).toBe(false);
  });

  it("unticking a field's batch tick takes off every tick of that field where it is still empty — one set on a single document included — and the dialog says so", async () => {
    await openAndDraft(three());
    // the first document is open: its own tick first, then the batch tick, then untick
    await click(ownBox("closing")!);
    await click(batchBox("closing")!);
    await click(batchBox("closing")!);
    expect(ownBox("closing")!.checked).toBe(false);
    expect(host.querySelector("[data-empty-ai-blocked]")!.textContent).toMatch(/3 documents have 3 empty AI-written fields\./);
    expect(host.querySelector("[data-empty-ai-batch-untick]")!.textContent).toMatch(/Unticking one takes “Leave it blank” off that field in every document where it is still\s+empty, a tick set on a single document included\. Typing into a field ends its tick: cleared\s+again, it needs ticking again\./);
  });
});
