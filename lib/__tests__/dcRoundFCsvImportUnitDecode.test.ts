// @vitest-environment jsdom
//
// document-control Round F wave 2 — P13 STATUS-TRANSITION, third review fix
// (intelligence GAP-314, its document-control half): the CSV import decodes
// the unit codes of the rows IT inserted — the ids its inserts returned —
// never every document in the library that carries an imported number. A
// library keyed on number + rev already holding P-101 Rev A, importing P-101
// Rev B, decodes (and counts) one document, not two. A decode with no
// opinion (the Site Codebook cannot decode, or 20261138 is not applied:
// no results, no note) shows nothing.
//
// Driven as rendered (jsdom) over the in-memory PostgREST
// (helpers/fakeSupabase); the decode client is mocked to capture the ids.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { newFakeDb, makeFakeSupabase, type FakeDb } from "./helpers/fakeSupabase";

const s = vi.hoisted(() => ({
  db: null as unknown as FakeDb,
  decode: vi.fn(),
}));

vi.mock("@/lib/supabase", () => ({ get supabase() { return makeFakeSupabase(s.db); } }));
vi.mock("@/lib/unitCodeClient", () => ({ requestUnitCodeDecode: (...a: unknown[]) => s.decode(...a) }));
vi.mock("@/lib/knowledge", () => ({ nudgeKnowledgeSources: vi.fn() }));

import CsvImportModal from "@/components/documents/CsvImportModal";
import type { LibraryConfig } from "@/types/schema";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  s.db = newFakeDb();
  s.db.tables.documents = [
    { id: "old-a", org_id: "o1", library_id: "lib1", document_number: "P-101", rev: "A", title: "Pump", status: "Issued", uniqueness_key: "P-101|A" },
  ];
  s.decode.mockReset().mockImplementation(async (_org: string, ids: string[]) => ({
    results: ids.map((id) => ({ documentId: id, unitCode: "20", outcome: "decoded", reason: null })), note: null,
  }));
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const button = (label: string) => {
  const b = Array.from(host.querySelectorAll("button")).find((x) => x.textContent?.includes(label));
  if (!b) throw new Error(`no button "${label}"`);
  return b as HTMLButtonElement;
};
const click = (el: Element) => act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); });

async function importCsv(csv: string) {
  const library = { id: "lib1", name: "P&IDs", uniquenessKeys: ["documentNumber", "rev"], customColumns: [] } as unknown as LibraryConfig;
  await act(async () => {
    root.render(React.createElement(CsvImportModal, { isOpen: true, onClose: () => {}, library, orgId: "o1", actorUserId: "u1" }));
  });
  const ta = host.querySelector("textarea") as HTMLTextAreaElement;
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(ta, csv);
  await act(async () => { ta.dispatchEvent(new Event("input", { bubbles: true })); });
  await click(button("Continue"));
  await click(button("Preview"));
  await click(button("Import"));
}

describe("GAP-314 (P13 third review fix) — the CSV import decodes the rows it inserted, by the ids its inserts returned", () => {
  it("a library keyed on number + rev already holds P-101 Rev A; importing P-101 Rev B decodes ONE document (the new one), and says 1 decoded", async () => {
    await importCsv("documentNumber,title,rev,status\nP-101,Pump,B,Issued");
    const docs = s.db.tables.documents;
    expect(docs).toHaveLength(2);
    const added = docs.find((d) => d.rev === "B")!;
    expect(s.decode).toHaveBeenCalledTimes(1);
    expect(s.decode.mock.calls[0][1]).toEqual([added.id]); // never "old-a"
    expect(s.decode.mock.calls[0][2]).toBe("csv_import");
    expect(host.querySelector('[data-testid="csv-unit-codes"]')?.textContent).toMatch(/Unit codes: 1 decoded from their numbers/);
    // the ids came from the inserts: no read-back by number
    expect(s.db.calls.some((c) => c.table === "documents" && c.method === "in")).toBe(false);
  });

  it("no opinion (no results, no note): nothing about unit codes is shown", async () => {
    s.decode.mockResolvedValueOnce({ results: [], note: null });
    await importCsv("documentNumber,title,rev\nP-202,Valve,0");
    expect(s.decode).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain("Imported 1 document record.");
    expect(host.querySelector('[data-testid="csv-unit-codes"]')).toBeNull();
  });
});
