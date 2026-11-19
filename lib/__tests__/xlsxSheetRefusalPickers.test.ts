// @vitest-environment jsdom
//
// Document-control XEDGE-12 — a sheet refused for its size names the
// workbook's sheets, and both importers offer them, as RENDERED:
//   - the asset importer's "Try another sheet" picker stays when the sheet
//     picked from it is empty (only a sheet that actually reads retires it),
//     and a new file never shows the last file's sheets;
//   - the template generator fills its sheet picker from a refused draft,
//     and a new upload clears it.

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
  return { supabase: { from: () => b, auth: { getSession: async () => ({ data: { session: { access_token: "t" } } }) } } };
});
vi.mock("@/lib/assets", () => ({
  listAssetTypes: vi.fn(async () => []), createAsset: vi.fn(), updateAsset: vi.fn(),
  findAssetsByTagKeys: vi.fn(async () => []), listAssetIdentities: vi.fn(async () => []),
}));
vi.mock("@/lib/codebook", async (orig) => ({ ...(await orig<typeof import("@/lib/codebook")>()), loadCodebook: vi.fn(async () => { throw new Error("none"); }) }));

import GenerateModal from "@/components/templates/GenerateModal";
import AssetCsvImportModal from "@/components/assets/AssetCsvImportModal";
import type { OutputTemplate } from "@/lib/outputTemplates";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
const fetchMock = vi.fn();
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  ot.draftDocuments.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

const settle = async () => { for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); }); };
const button = (label: RegExp) => [...host.querySelectorAll("button")].find((b) => label.test(b.textContent ?? "")) as HTMLButtonElement | undefined;
const sheetOptions = () => [...host.querySelectorAll("select option")].map((o) => o.textContent);
const reply = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
async function chooseFile(name: string) {
  const input = host.querySelector('input[type="file"]') as HTMLInputElement;
  const file = new File(["x"], name);
  Object.defineProperty(file, "arrayBuffer", { value: async () => new Uint8Array([120]).buffer });
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
  await settle();
}
async function choose(select: HTMLSelectElement, value: string) {
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await settle();
}

describe("XEDGE-12 — the asset importer offers the refused workbook's other sheets", () => {
  it("an empty sheet picked from the picker keeps it; a new file clears it", async () => {
    await act(async () => {
      root.render(React.createElement(AssetCsvImportModal, { isOpen: true, onClose: () => undefined, orgId: "o1", actorUserId: "u1" }));
    });
    fetchMock.mockResolvedValueOnce(reply(422, { error: 'Sheet "Register" spans 10,001 rows × 702 columns; the generator reads at most 5,128,192 cells per sheet.', sheetName: "Register", sheetNames: ["Register", "Empty", "Notes"] }));
    await chooseFile("reg.xlsx");
    expect(host.textContent).toMatch(/spans 10,001 rows × 702 columns/);
    expect(host.textContent).toMatch(/Try another sheet of reg\.xlsx/);
    expect(sheetOptions()).toEqual(["Register", "Empty", "Notes"]);

    fetchMock.mockResolvedValueOnce(reply(200, { headers: [], rows: [], sheetNames: ["Register", "Empty", "Notes"], sheetName: "Empty" }));
    await choose(host.querySelector("select") as HTMLSelectElement, "Empty");
    expect(JSON.parse(String(fetchMock.mock.calls[1][1].body)).sheet).toBe("Empty");
    expect(host.textContent).toMatch(/No header row and data rows were found in that sheet/);
    expect(sheetOptions()).toEqual(["Register", "Empty", "Notes"]);
    expect((host.querySelector("select") as HTMLSelectElement).value).toBe("Empty");

    // A new file clears the last file's sheets even when its own read fails
    // before any answer (the network here).
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    await chooseFile("other.xlsx");
    expect(host.textContent).toMatch(/network down/);
    expect(host.textContent).not.toMatch(/Try another sheet/);
    expect(host.querySelector("select")).toBeNull();
  });

  it("pasted CSV clears the picker too", async () => {
    await act(async () => {
      root.render(React.createElement(AssetCsvImportModal, { isOpen: true, onClose: () => undefined, orgId: "o1", actorUserId: "u1" }));
    });
    fetchMock.mockResolvedValueOnce(reply(422, { error: "too wide", sheetName: "A", sheetNames: ["A", "B"] }));
    await chooseFile("reg.xlsx");
    expect(host.textContent).toMatch(/Try another sheet/);
    const ta = host.querySelector("textarea") as HTMLTextAreaElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(ta, "tag,description\nP-1,Pump");
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { button(/^Continue/)!.click(); });
    await settle();
    await act(async () => { button(/Back/)!.click(); });
    await settle();
    expect(host.textContent).not.toMatch(/Try another sheet/);
  });
});

const template: OutputTemplate = {
  id: "tpl1", orgId: "o1", name: "Letter", description: null, kind: "docx",
  templateFileKey: "orgs/o1/output-templates/t.docx", templateFileName: "t.docx",
  exampleFiles: [], exampleText: null, instructions: null, mode: "per_row", columnMap: {}, filenamePattern: null,
  createdAt: "2026-10-01",
  placeholders: [{ tag: "name", label: "Name", kind: "data" }, { tag: "body", label: "Body", kind: "ai" }],
};

describe("XEDGE-12 — the generator fills its sheet picker from a refused draft", () => {
  it("the refusal's sheets are offered; a new upload clears them", async () => {
    await act(async () => {
      root.render(React.createElement(GenerateModal, { orgId: "o1", template, onClose: () => undefined, onGenerated: () => undefined }));
    });
    await chooseFile("d.xlsx");
    ot.draftDocuments.mockRejectedValueOnce(Object.assign(new Error('Couldn\'t read that spreadsheet: Sheet "Big" spans 10,001 rows × 702 columns.'), { sheetNames: ["Big", "Small"] }));
    await act(async () => { button(/^Draft documents/)!.click(); });
    await settle();
    expect(sheetOptions()).toEqual(["Big", "Small"]);
    await chooseFile("e.xlsx");
    expect(sheetOptions()).toEqual([]);
  });
});
