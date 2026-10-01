// @vitest-environment jsdom
//
// document-control Round F wave 3 — P15 SURFACE REMAINDERS (public-surfaces
// VFY-20 / DEC-44 (P15) §1): the spreadsheet import writes each row's status
// cell. The second review fix refused every row whose status no gate
// recognises — which broke imports that work on 4dd0df7 (a legacy register's
// "ISSUED" / "issued", a library's own "Approved" / "For Construction"). The
// third review fix keeps every such import working
// (lib/documentStatusOptions.ts importStatusFor): a case or spacing variant
// of a recognised status is imported in the register's spelling and the
// report says so; any other value — "IFC" included — is imported as written,
// with a per-row warning that it reads STATUS NOT RECOGNISED and is not
// printed. A blank status still imports as Draft, and every recognised status
// imports as before, with no note.
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
import { IMPORT_STATUSES, importStatusFor } from "@/lib/documentStatusOptions";
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

describe("VFY-20 / DEC-44 (P15) §1 (third review fix) — every spreadsheet import that works today still works", () => {
  it("REGRESSION PIN: a library's own status (\"For Construction\", \"Approved\", \"IFA\") imports as written, with a STATUS NOT RECOGNISED warning per row", async () => {
    await importCsv("documentNumber,title,rev,status\nP-201,A,0,For Construction\nP-202,B,0,Approved\nP-203,C,0,IFA\nP-204,D,0,Issued");
    expect(s.db.tables.documents.map((d) => [d.document_number, d.status])).toEqual([
      ["P-201", "For Construction"], ["P-202", "Approved"], ["P-203", "IFA"], ["P-204", "Issued"],
    ]);
    expect(host.textContent).toContain("Imported 4 document records.");
    expect(host.textContent).not.toContain("failed");
    const notes = host.querySelector('[data-testid="csv-status-notes"]')?.textContent ?? "";
    expect(notes).toContain("3 imported with a status note");
    expect(notes).toContain('Row 2: Status "For Construction" was imported as written, but it is not one the register recognises: the verify page reads it as STATUS NOT RECOGNISED and the field pack does not print it. To change that, set one of: Draft, In Review, Issued, Locked, Superseded, Void, Archived.');
    expect(notes).toContain('Row 3: Status "Approved" was imported as written');
    expect(notes).toContain('Row 4: Status "IFA" was imported as written');
    expect(notes).not.toContain("Row 5");
  });

  it("REGRESSION PIN: a case or spacing variant (\"issued\", \"ISSUED\", \"DRAFT\", \"In  Review\") is imported in the register's spelling, and the report says so", async () => {
    await importCsv("documentNumber,title,rev,status\nP-301,A,0,issued\nP-302,B,0,ISSUED\nP-303,C,0,DRAFT\nP-304,D,0,In  Review\nP-305,E,0, superseded ");
    expect(s.db.tables.documents.map((d) => [d.document_number, d.status])).toEqual([
      ["P-301", "Issued"], ["P-302", "Issued"], ["P-303", "Draft"], ["P-304", "In Review"], ["P-305", "Superseded"],
    ]);
    expect(host.textContent).toContain("Imported 5 document records.");
    expect(host.textContent).not.toContain("failed");
    const notes = host.querySelector('[data-testid="csv-status-notes"]')?.textContent ?? "";
    expect(notes).toContain('Row 2: Status "issued" was imported as "Issued", the register\'s spelling.');
    expect(notes).toContain('Row 3: Status "ISSUED" was imported as "Issued"');
    expect(notes).toContain('Row 4: Status "DRAFT" was imported as "Draft"');
    expect(notes).toContain('Row 5: Status "In  Review" was imported as "In Review"');
    expect(notes).toContain('Row 6: Status "superseded" was imported as "Superseded"');
  });

  it("IFC (DEC-44 (P15)) imports as before, warned: not an issued status, not printed, how to put it in force — never respelled to Issued", async () => {
    await importCsv("documentNumber,title,rev,status\nP-101,Pump,A,IFC\nP-102,Valve,0,Issued\nP-103,Line,0,\nP-104,Tank,0,ifc");
    expect(s.db.tables.documents.map((d) => [d.document_number, d.status])).toEqual([
      ["P-101", "IFC"], ["P-102", "Issued"], ["P-103", "Draft"], ["P-104", "ifc"],
    ]);
    expect(host.textContent).toContain("Imported 4 document records.");
    expect(host.textContent).not.toContain("failed");
    const notes = host.querySelector('[data-testid="csv-status-notes"]')?.textContent ?? "";
    expect(notes).toContain("2 imported with a status note");
    expect(notes).toContain('Row 2: Status "IFC" was imported as written, but it is not an issued status (DEC-44 (P15) — no editor offers it): the verify page reads it as STATUS NOT RECOGNISED and the field pack does not print it. To put the document in force, set it to Issued in the metadata editor once its revision is reviewed.');
    expect(notes).toContain('Row 5: Status "ifc" was imported as written, but it is not an issued status');
  });

  it("REGRESSION: every recognised status, and a blank or missing status column (Draft), imports exactly as before — with no note", async () => {
    const rows = IMPORT_STATUSES.map((st, i) => `Q-${i},T${i},0,${st}`).join("\n");
    await importCsv(`documentNumber,title,rev,status\n${rows}\nQ-blank,Blank,0,`);
    expect(s.db.tables.documents.map((d) => d.status)).toEqual([...IMPORT_STATUSES, "Draft"]);
    expect(host.textContent).not.toContain("failed");
    expect(host.querySelector('[data-testid="csv-status-notes"]')).toBeNull();
    s.db.tables.documents = [];
    await importCsv("documentNumber,title\nR-1,No status column");
    expect(s.db.tables.documents.map((d) => d.status)).toEqual(["Draft"]);
    expect(host.querySelector('[data-testid="csv-status-notes"]')).toBeNull();
  });

  it("importStatusFor: recognised → as written; blank → Draft; a variant → the register's spelling; anything else → as written (trimmed) with a warning — never refused", () => {
    expect([...IMPORT_STATUSES]).toEqual(["Draft", "In Review", "Issued", "Locked", "Superseded", "Void", "Archived"]);
    for (const st of IMPORT_STATUSES) {
      expect(isRecognisedStatus(st)).toBe(true);
      expect(importStatusFor(st)).toEqual({ status: st, note: null });
    }
    for (const blank of ["", "  ", null, undefined]) expect(importStatusFor(blank)).toEqual({ status: "Draft", note: null });
    expect(importStatusFor("  Issued ")).toEqual({ status: "Issued", note: null });
    for (const [variant, canonical] of [["issued", "Issued"], ["LOCKED", "Locked"], ["in review", "In Review"], ["In\tReview", "In Review"], ["vOiD", "Void"]]) {
      expect(importStatusFor(variant).status).toBe(canonical);
      expect(importStatusFor(variant).note).toMatch(/was imported as ".+", the register's spelling\.$/);
    }
    for (const other of ["IFC", "ifc", "Approved", "For Construction", "IFA", "Issued-For-Construction"]) {
      const r = importStatusFor(other);
      expect(isRecognisedStatus(other)).toBe(false);
      expect(r.status).toBe(other);
      expect(r.note).toMatch(/was imported as written, but .*STATUS NOT RECOGNISED and the field pack does not print it/);
    }
    // never respelled into force: no unrecognised value becomes Issued / Locked
    expect(importStatusFor("IFC").status).toBe("IFC");
  });
});
