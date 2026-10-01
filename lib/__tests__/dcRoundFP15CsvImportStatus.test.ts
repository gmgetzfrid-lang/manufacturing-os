// @vitest-environment jsdom
//
// document-control Round F wave 3 — P15 SURFACE REMAINDERS, second review
// fix (public-surfaces VFY-20 / DEC-44 (P15) §1): the spreadsheet import
// wrote each row's status cell verbatim, so "IFC" — or any string — still
// became a document status after the editors stopped offering it, and such a
// row scans STATUS NOT RECOGNISED and never prints into a pack once a file is
// published into it. The import now takes only a status the gates recognise
// (lib/documentStatusOptions.ts importStatusRefusal); any other row is
// refused, and the import's report says why. A blank status still imports as
// Draft, and every recognised status imports as before.
//
// Driven as rendered (jsdom) over the in-memory PostgREST
// (helpers/fakeSupabase), as dcRoundFCsvImportUnitDecode.test.ts does.

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
import { IMPORT_STATUSES, importStatusRefusal } from "@/lib/documentStatusOptions";
import { isRecognisedStatus } from "@/lib/verifyVerdict";
import type { LibraryConfig } from "@/types/schema";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  s.db = newFakeDb();
  s.db.tables.documents = [];
  s.decode.mockReset().mockResolvedValue({ results: [], note: null });
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

let mounts = 0;
async function importCsv(csv: string) {
  const library = { id: "lib1", name: "P&IDs", uniquenessKeys: ["documentNumber", "rev"], customColumns: [] } as unknown as LibraryConfig;
  // a fresh modal each time (a new key resets its steps)
  await act(async () => {
    root.render(React.createElement(CsvImportModal, { key: `m${++mounts}`, isOpen: true, onClose: () => {}, library, orgId: "o1", actorUserId: "u1" }));
  });
  const ta = host.querySelector("textarea") as HTMLTextAreaElement;
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(ta, csv);
  await act(async () => { ta.dispatchEvent(new Event("input", { bubbles: true })); });
  await click(button("Continue"));
  await click(button("Preview"));
  await click(button("Import"));
}

describe("VFY-20 (P15 second review fix) — the spreadsheet import takes only a status the gates recognise", () => {
  it("a row whose status is IFC is not imported: the report names the row and why; the other rows import", async () => {
    await importCsv("documentNumber,title,rev,status\nP-101,Pump,A,IFC\nP-102,Valve,0,Issued\nP-103,Line,0,");
    const docs = s.db.tables.documents;
    expect(docs.map((d) => [d.document_number, d.status])).toEqual([["P-102", "Issued"], ["P-103", "Draft"]]);
    expect(docs.some((d) => d.status === "IFC")).toBe(false);
    expect(host.textContent).toContain("Imported 2 document records.");
    expect(host.textContent).toContain("1 failed");
    expect(host.textContent).toContain('Row 2: Status "IFC" is not imported: it is not an issued status — the field pack does not print it and the verify page reads it as STATUS NOT RECOGNISED.');
  });

  it("any other status no gate recognises is refused too — a case variant is named", async () => {
    await importCsv("documentNumber,title,rev,status\nP-201,A,0,issued\nP-202,B,0,For Construction\nP-203,C,0,In  Review");
    expect(s.db.tables.documents).toEqual([]);
    expect(host.textContent).toContain('Row 2: Status "issued" is not one the register recognises — did you mean "Issued"?');
    expect(host.textContent).toContain('Row 3: Status "For Construction" is not one the register recognises. Use one of: Draft, In Review, Issued, Locked, Superseded, Void, Archived (a blank status imports as Draft).');
    expect(host.textContent).toContain('Row 4: Status "In  Review" is not one the register recognises — did you mean "In Review"?');
  });

  it("REGRESSION: every recognised status, and a blank or missing status column (Draft), imports exactly as before", async () => {
    const rows = IMPORT_STATUSES.map((st, i) => `Q-${i},T${i},0,${st}`).join("\n");
    await importCsv(`documentNumber,title,rev,status\n${rows}\nQ-blank,Blank,0,`);
    expect(s.db.tables.documents.map((d) => d.status)).toEqual([...IMPORT_STATUSES, "Draft"]);
    expect(host.textContent).not.toContain("failed");
    s.db.tables.documents = [];
    await importCsv("documentNumber,title\nR-1,No status column");
    expect(s.db.tables.documents.map((d) => d.status)).toEqual(["Draft"]);
  });

  it("importStatusRefusal admits exactly what the verify page recognises (and blank)", () => {
    expect([...IMPORT_STATUSES]).toEqual(["Draft", "In Review", "Issued", "Locked", "Superseded", "Void", "Archived"]);
    for (const st of IMPORT_STATUSES) {
      expect(isRecognisedStatus(st)).toBe(true);
      expect(importStatusRefusal(st)).toBeNull();
    }
    expect(importStatusRefusal("")).toBeNull();
    expect(importStatusRefusal("  ")).toBeNull();
    expect(importStatusRefusal(null)).toBeNull();
    for (const bad of ["IFC", "ifc", "Approved", "issued", "LOCKED"]) {
      expect(isRecognisedStatus(bad)).toBe(false);
      expect(importStatusRefusal(bad)).toMatch(/^Status "/);
    }
  });
});
