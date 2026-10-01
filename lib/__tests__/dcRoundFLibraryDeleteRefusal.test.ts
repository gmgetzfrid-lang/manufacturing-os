// @vitest-environment jsdom
//
// document-control Round F wave 3 — P14 RECORDS & REVIEW REMAINDERS, final
// review: DRLS-14's library door on /admin/libraries. A library delete
// cascades to its documents, so 20261149's evidence guard (DEC-44 (P14))
// refuses it when a document it holds carries a person's confirmation,
// acknowledgment or sign-off. The page said only "Failed to delete library."
// — it now shows the database's sentence, as /documents does ("Delete failed:
// …"), and a delete that matched no row (RLS's silent refusal) is a refusal,
// never a library dropped from the screen that is still in the database.
//
// Driven as rendered (jsdom) against the in-memory PostgREST.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { newFakeDb, makeFakeSupabase, type FakeDb } from "./helpers/fakeSupabase";

const s = vi.hoisted(() => ({
  db: null as unknown as FakeDb,
  appAlert: vi.fn(async (..._a: unknown[]) => undefined),
}));

vi.mock("@/lib/supabase", () => ({ get supabase() { return makeFakeSupabase(s.db); } }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/components/providers/RoleContext", () => ({
  useRole: () => ({ activeRole: "DocCtrl", hasAnyRole: () => true, activeOrgId: "o1", uid: "ctl1" }),
}));
vi.mock("@/components/providers/DialogProvider", () => ({ appAlert: (...a: unknown[]) => s.appAlert(...a) }));
vi.mock("@/lib/ownership", () => ({ setOwner: vi.fn(async () => undefined) }));
vi.mock("@/app/(protected)/admin/libraries/LibraryWizard", () => ({ default: () => null }));
vi.mock("@/app/(protected)/admin/libraries/DeleteSafetyModal", () => ({
  default: (p: { isOpen: boolean; onConfirm: () => Promise<void> }) =>
    p.isOpen ? React.createElement("button", { onClick: () => void p.onConfirm() }, "Confirm delete") : null,
}));

import LibraryAdminPage from "@/app/(protected)/admin/libraries/page";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** 20261149's sentence for a library holding P-101 (one signed sign-off). */
const GUARD = "P-101 carries the record of who confirmed, acknowledged or approved it (0 distribution confirmation(s), 0 read-and-understood acknowledgment(s) or waiver(s), 1 review sign-off(s)), so it cannot be deleted. Archive it instead: archiving keeps the record.";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  s.db = newFakeDb();
  s.db.tables.libraries = [
    { id: "L1", org_id: "o1", name: "P&IDs", created_at: "2026-09-01T00:00:00Z" },
    { id: "L2", org_id: "o1", name: "Specs", created_at: "2026-08-01T00:00:00Z" },
  ];
  s.appAlert.mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

const tick = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const buttons = (label: string) => Array.from(host.querySelectorAll("button")).filter((b) => b.textContent?.trim() === label);
const click = async (el: Element) => { await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); }); await tick(); };
const shown = () => Array.from(host.querySelectorAll("div.text-lg")).map((d) => d.textContent);

async function deleteFirstLibrary() {
  await act(async () => { root.render(React.createElement(LibraryAdminPage)); });
  await tick();
  expect(shown()).toEqual(["P&IDs", "Specs"]);
  await click(buttons("Delete")[0]);
  await click(buttons("Confirm delete")[0]);
}

describe("DRLS-14 (P14 final review) — /admin/libraries says why a library was not deleted", () => {
  it("refused by the evidence guard: the database's sentence is shown, and the library stays", async () => {
    s.db.deleteErrors = { libraries: { code: "23001", message: GUARD } };
    await deleteFirstLibrary();
    expect(s.appAlert).toHaveBeenCalledTimes(1);
    expect(s.appAlert).toHaveBeenCalledWith({ message: `Delete failed: ${GUARD}`, tone: "danger" });
    expect(shown()).toEqual(["P&IDs", "Specs"]);
    expect(s.db.tables.libraries.map((l) => l.id)).toEqual(["L1", "L2"]);
  });

  it("a delete that matched no row (RLS's silent refusal) is a refusal — never a library dropped from the screen that is still there", async () => {
    s.db.refuseWrites.add("libraries");
    await deleteFirstLibrary();
    expect(s.appAlert).toHaveBeenCalledWith({
      message: "Delete failed: the database deleted nothing (you may not have permission to delete this library); nothing was changed.",
      tone: "danger",
    });
    expect(shown()).toEqual(["P&IDs", "Specs"]);
    // one checked statement: delete … eq(id) … select("id") — the returned rows are what it counts
    const calls = s.db.calls.filter((c) => c.table === "libraries").map((c) => c.method);
    expect(calls.slice(-3)).toEqual(["delete", "eq", "select"]);
  });

  it("regression — a delete that lands removes the library, says nothing, and closes the confirmation", async () => {
    await deleteFirstLibrary();
    expect(s.appAlert).not.toHaveBeenCalled();
    expect(shown()).toEqual(["Specs"]);
    expect(s.db.tables.libraries.map((l) => l.id)).toEqual(["L2"]);
    expect(buttons("Confirm delete")).toEqual([]);
  });
});
