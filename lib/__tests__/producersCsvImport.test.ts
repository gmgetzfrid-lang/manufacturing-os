// @vitest-environment jsdom
//
// notifications Round G — N8 PRODUCERS-FREE, PROD-5: the CSV import tells
// the library's followers, as the staged upload does — through the ONE
// helper both insert paths are to use (lib/libraryNotify.ts), once per batch
// that inserted rows, never for a batch that inserted none. Driven as
// rendered over the in-memory PostgREST; the helper is captured.
//
// REGRESSION FIRST: the import itself is unchanged — the rows land, the
// report reads as before, onImported fires with the count.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { newFakeDb, makeFakeSupabase, type FakeDb } from "./helpers/fakeSupabase";

const s = vi.hoisted(() => ({
  db: null as unknown as FakeDb,
  notified: [] as Array<Record<string, unknown>>,
  imported: [] as number[],
}));

vi.mock("@/lib/supabase", () => ({ get supabase() { return makeFakeSupabase(s.db); } }));
vi.mock("@/lib/unitCodeClient", () => ({ requestUnitCodeDecode: async () => ({ results: [], note: null }) }));
vi.mock("@/lib/knowledge", () => ({ nudgeKnowledgeSources: vi.fn() }));
vi.mock("@/lib/libraryNotify", () => ({
  notifyLibraryDocsAdded: vi.fn(async (p: Record<string, unknown>) => { s.notified.push(p); }),
}));

import CsvImportModal from "@/components/documents/CsvImportModal";
import type { LibraryConfig } from "@/types/schema";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  s.db = newFakeDb();
  s.db.tables.documents = [];
  s.notified = [];
  s.imported = [];
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

async function importCsv(csv: string, extra: Record<string, unknown> = {}) {
  const library = { id: "lib1", name: "P&IDs", uniquenessKeys: ["documentNumber", "rev"], customColumns: [] } as unknown as LibraryConfig;
  await act(async () => {
    root.render(React.createElement(CsvImportModal, {
      isOpen: true, onClose: () => {}, library, orgId: "o1", actorUserId: "u1", onImported: (n: number) => { s.imported.push(n); }, ...extra,
    }));
  });
  const ta = host.querySelector("textarea") as HTMLTextAreaElement;
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(ta, csv);
  await act(async () => { ta.dispatchEvent(new Event("input", { bubbles: true })); });
  await click(button("Continue"));
  await click(button("Preview"));
  await click(button("Import"));
}

describe("PROD-5 — a CSV import notifies the library's followers, once per batch", () => {
  it("dw1: after a successful batch — the count, the first row's number, the signed-in actor and their name", async () => {
    await importCsv("documentNumber,title,rev\nP-101,Pump,0\nP-102,Valve,0", { actorName: "dc@acme.test" });
    expect(s.db.tables.documents).toHaveLength(2);           // REGRESSION: the rows land
    expect(s.imported).toEqual([2]);                         // REGRESSION: onImported, with the count
    expect(s.notified).toEqual([{ orgId: "o1", libraryId: "lib1", count: 2, firstLabel: "P-101", actorUserId: "u1", actorName: "dc@acme.test" }]);
  });

  it("only the rows that landed count; a batch that inserted nothing notifies nobody", async () => {
    s.db.refuseWrites.add("documents");
    await importCsv("documentNumber,title,rev\nP-201,Pump,0");
    expect(s.db.tables.documents).toHaveLength(0);
    expect(s.notified).toEqual([]);
    expect(s.imported).toEqual([]);
  });

  it("dw2: the import's notice goes through the shared helper (a third insert path has one call to make)", async () => {
    const { readFileSync } = await import("node:fs");
    const modal = readFileSync("components/documents/CsvImportModal.tsx", "utf8");
    expect(modal).toContain('import { notifyLibraryDocsAdded } from "@/lib/libraryNotify";');
    expect(modal).not.toMatch(/notify\/dispatch|\bemit\(/);
  });
});
