// @vitest-environment jsdom
//
// admin-and-org Round G, P8 review fix — ALOG-3's second door. The library
// tile menu on /documents deleted straight from the browser: no counts, no
// audit row before 20261204 was pasted, and a confirmation that said the
// documents "will be orphaned" (the cascade deletes them). It now opens the
// same counted confirmation as /admin/libraries (DeleteSafetyModal, rendered
// for real here) and deletes through /api/admin/libraries/delete (run for
// real: fetch is routed to its handler), which deletes as the caller and
// records LIBRARY_DELETED with the counts.
//
// Driven as rendered (jsdom) against the in-memory PostgREST.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { newFakeDb, makeFakeSupabase, type FakeDb } from "./helpers/fakeSupabase";

const s = vi.hoisted(() => ({
  db: null as unknown as FakeDb,
  appAlert: vi.fn(async (..._a: unknown[]) => undefined),
  appConfirm: vi.fn(async (..._a: unknown[]) => true),
  // one stable object: the page refetches whenever `roles` changes identity
  role: { activeRole: "DocCtrl", roles: ["DocCtrl"], hasAnyRole: (rs: string[]) => rs.includes("DocCtrl"), userEmail: "ctl@x.io", activeOrgId: "o1", uid: "ctl1" },
}));

vi.mock("@/lib/supabase", () => ({ get supabase() { return makeFakeSupabase(s.db); } }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => React.createElement("a", { href, ...rest }, children),
}));
vi.mock("@/components/providers/RoleContext", () => ({
  useRole: () => s.role,
}));
vi.mock("@/components/providers/DialogProvider", () => ({
  appAlert: (...a: unknown[]) => s.appAlert(...a),
  appConfirm: (...a: unknown[]) => s.appConfirm(...a),
}));
vi.mock("@/lib/search", () => ({ searchDocuments: vi.fn(async () => []) }));
vi.mock("@/components/ui/RouteLoader", () => ({ default: () => null }));
vi.mock("@/components/documents/NodeCover", () => ({ default: () => null }));
vi.mock("@/components/documents/CustomizeNodeModal", () => ({ default: () => null }));
vi.mock("@/components/navigation/ViewTabs", () => ({ default: () => null, DOCUMENT_VIEWS: [] }));
vi.mock("@/lib/adminGate", () => ({
  authorizeAdminSurface: async () => ({ userId: "ctl1", email: "ctl@x.io", orgId: "o1", role: "DocCtrl", roles: ["DocCtrl"], admin: makeFakeSupabase(s.db), surface: {}, admittedRole: "DocCtrl" }),
}));
vi.mock("@/lib/serverAuth", () => ({ callerScopedClient: () => makeFakeSupabase(s.db) }));

import DocumentsHomePage from "@/app/(protected)/documents/page";
import { POST as deleteRoute } from "@/app/api/admin/libraries/delete/route";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
const routeCalls: Array<Record<string, unknown>> = [];
beforeEach(() => {
  s.db = newFakeDb();
  s.db.tables.orgs = [{ id: "o1", name: "Plant" }];
  s.db.tables.libraries = [
    { id: "L1", org_id: "o1", name: "Piping Isometrics", read_access: "ALL", created_at: "2026-09-01T00:00:00Z" },
    { id: "L2", org_id: "o1", name: "Specs", read_access: "ALL", created_at: "2026-08-01T00:00:00Z" },
  ];
  s.db.tables.collections = [{ id: "c1", library_id: "L1" }, { id: "c2", library_id: "L1" }, { id: "c3", library_id: "L2" }];
  s.db.tables.documents = [
    { id: "d1", org_id: "o1", library_id: "L1", legal_hold: false },
    { id: "d2", org_id: "o1", library_id: "L1", legal_hold: false },
    { id: "d3", org_id: "o1", library_id: "L2", legal_hold: false },
  ];
  s.db.tables.document_versions = [{ id: "v1", record_id: "d1" }, { id: "v2", record_id: "d1" }, { id: "v3", record_id: "d2" }, { id: "v4", record_id: "d3" }];
  s.db.tables.document_holds = [{ id: "h1", document_id: "d2", released_at: null }];
  s.db.tables.tickets = [];
  s.appAlert.mockClear();
  s.appConfirm.mockClear();
  routeCalls.length = 0;
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    routeCalls.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    return deleteRoute(new NextRequest(`http://localhost${url}`, init as ConstructorParameters<typeof NextRequest>[1]));
  });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const flush = async () => { for (let i = 0; i < 8; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const click = async (el: Element | undefined | null) => { expect(el).toBeTruthy(); await act(async () => { el!.dispatchEvent(new MouseEvent("click", { bubbles: true })); }); await flush(); };
const button = (re: RegExp) => [...host.querySelectorAll("button")].find((b) => re.test((b.textContent ?? "").trim())) as HTMLButtonElement | undefined;
const tiles = () => [...host.querySelectorAll("div.text-lg")].map((d) => d.textContent);
const audits = (action: string) => (s.db.tables.audit_logs ?? []).filter((r) => r.action === action);
async function type(value: string) {
  const input = host.querySelector("input[placeholder='Type library name here...']") as HTMLInputElement;
  expect(input).toBeTruthy();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await flush();
}

async function openDeleteForFirstLibrary() {
  await act(async () => { root.render(React.createElement(DocumentsHomePage)); });
  await flush();
  expect(tiles()).toEqual(["Piping Isometrics", "Specs"]);
  await click(host.querySelectorAll("button[title='Library admin']")[0]);
  await click(button(/^Delete library$/));
}

describe("ALOG-3 (review fix) — the /documents tile menu deletes a library through the counted, recorded door", () => {
  it("the confirmation shows the real counts and the cascade, never 'orphaned'; no browser confirm, no delete before the person confirms", async () => {
    await openDeleteForFirstLibrary();
    expect(s.appConfirm).not.toHaveBeenCalled();
    expect(routeCalls).toEqual([{ orgId: "o1", libraryId: "L1", preview: true }]);
    const impact = host.querySelector("[data-testid='library-delete-impact']");
    expect(impact?.textContent).toContain("2 document records");
    expect(impact?.textContent).toContain("3 revisions");
    expect(impact?.textContent).toContain("2 folders");
    expect(impact?.textContent).toContain("1 open hold");
    expect(host.textContent).toContain("the delete cascades");
    expect(host.textContent).not.toMatch(/will be orphaned/);
    expect(s.db.tables.libraries.map((l) => l.id)).toEqual(["L1", "L2"]);
    // the name must be typed before the delete is allowed
    expect(button(/I understand, delete this library/)?.disabled).toBe(true);
  });

  it("confirming deletes as the caller and writes LIBRARY_DELETED with the counts (before 20261204 is pasted, the route's row is the record)", async () => {
    await openDeleteForFirstLibrary();
    await type("Piping Isometrics");
    await click(button(/I understand, delete this library/));
    expect(routeCalls[1]).toEqual({ orgId: "o1", libraryId: "L1", expected: { folders: 2, documents: 2, revisions: 3, openHolds: 1, legalHolds: 0, requests: 0 } });
    expect(s.db.tables.libraries.map((l) => l.id)).toEqual(["L2"]);
    const rows = audits("LIBRARY_DELETED");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ resource_type: "library", resource_id: "L1", org_id: "o1", user_id: "ctl1", user_role: "DocCtrl" });
    expect(rows[0].details).toEqual({ name: "Piping Isometrics", via: "app", countedBeforeDelete: true, folders: 2, documents: 2, revisions: 3, openHolds: 1, legalHolds: 0, requests: 0 });
    expect(s.appAlert).not.toHaveBeenCalled();
    expect(tiles()).toEqual(["Specs"]);
    expect(host.querySelector("[data-testid='library-delete-impact']")).toBeNull();
  });

  it("a delete the database refuses shows its sentence, keeps the library, and writes no audit row", async () => {
    s.db.deleteErrors = { libraries: { code: "23001", message: "D-1 is under legal hold" } };
    await openDeleteForFirstLibrary();
    await type("Piping Isometrics");
    await click(button(/I understand, delete this library/));
    expect(s.appAlert).toHaveBeenCalledWith({ message: "Delete failed: D-1 is under legal hold", tone: "danger" });
    expect(s.db.tables.libraries.map((l) => l.id)).toEqual(["L1", "L2"]);
    expect(tiles()).toEqual(["Piping Isometrics", "Specs"]);
    expect(audits("LIBRARY_DELETED")).toEqual([]);
  });

  it("counts that cannot be read refuse the delete: the confirm stays disabled even with the name typed", async () => {
    s.db.selectErrors = { collections: { message: "boom" } };
    await openDeleteForFirstLibrary();
    expect(host.textContent).toMatch(/Couldn.t count what this deletion would remove/);
    await type("Piping Isometrics");
    expect(button(/I understand, delete this library/)?.disabled).toBe(true);
    expect(routeCalls).toHaveLength(1);
    expect(s.db.tables.libraries.map((l) => l.id)).toEqual(["L1", "L2"]);
  });

  it("no direct browser delete of a library is left on the page", () => {
    const page = readFileSync(join(process.cwd(), "app/(protected)/documents/page.tsx"), "utf8");
    expect(page).not.toContain('from("libraries").delete()');
    expect(page).not.toMatch(/will be orphaned/);
    expect(page).toContain('import { postLibraryDelete, libraryDeleteError } from "@/lib/libraryDeleteClient";');
  });
});
