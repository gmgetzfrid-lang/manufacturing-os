// @vitest-environment jsdom
//
// intelligence Round G (I-11) — the asset hub reads the RELATION (WIRE-1 /
// BR-2 / WIRE-8's asset-hub criterion), RENDERED.
//
// /assets/<tag> rendered with Supabase stood in by the in-memory database:
//   * a drawing the Bridge read the tag on (document_assets, source
//     'drawing') is listed, with its sheet address and a "read from drawing"
//     mark (GAP-301 / GAP-303) — before, the hub asked only
//     documents.asset_tags and said "No controlled documents";
//   * a document tagged by hand (asset_tags + its jsonb_sync row) is listed
//     once, unmarked; an archived one is not;
//   * an UNREGISTERED tag still lists the documents whose asset_tags name it
//     (the containment read is kept — nothing listed before disappears);
//   * sheets the tag was read on but not linked yet come from
//     /api/equipment/sheets (GM-14), labelled as such.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { newFakeDb, type FakeDb } from "./helpers/fakeSupabase";

const s = vi.hoisted(() => ({
  db: null as unknown as FakeDb,
  tag: "E-22",
  asset: null as null | { id: string; tag: string; description: string | null; location: string | null },
  extracted: [] as unknown[],
}));

vi.mock("next/navigation", () => ({ useParams: () => ({ tag: s.tag }), useRouter: () => ({ replace: vi.fn(), push: vi.fn() }) }));
vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => React.createElement("a", { href, ...rest }, children) }));
vi.mock("@/components/providers/RoleContext", () => ({
  useRole: () => ({ activeOrgId: "o1", hasAnyRole: () => true, uid: "u1", userEmail: "u1@x", booted: true, loading: false }),
}));
vi.mock("@/lib/supabase", async () => {
  const { makeFakeSupabase: make, newFakeDb: fresh } = await import("./helpers/fakeSupabase");
  s.db = fresh();
  const client = new Proxy({}, {
    get: (_t, p: string) => (p === "auth"
      ? { getSession: async () => ({ data: { session: { access_token: "t" } } }) }
      : (make(s.db) as Record<string, unknown>)[p]),
  });
  return { supabase: client };
});
vi.mock("@/lib/assets", () => ({
  getAssetByTag: async () => s.asset,
  listAssetPhotos: async () => [],
}));
vi.mock("@/components/assets/AliasPanel", () => ({ default: () => null }));
vi.mock("@/components/assets/MentionsPanel", () => ({ default: () => null }));

import AssetHubPage from "@/app/(protected)/assets/[tag]/page";

let container: HTMLDivElement;
let root: Root;

async function render() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root.render(React.createElement(AssetHubPage)); });
  for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

beforeEach(() => {
  Object.assign(s.db, newFakeDb());
  s.db.tables = {
    documents: [
      { id: "d1", org_id: "o1", document_number: "2002-D-10001", title: "Crude charge", rev: "B", status: "Issued", library_id: "lib1", asset_tags: [] },
      { id: "d2", org_id: "o1", document_number: "DS-22", title: "Datasheet", rev: "0", status: "Issued", library_id: "lib1", asset_tags: [{ tag: "E-22" }] },
      { id: "d3", org_id: "o1", document_number: "OLD-1", title: "Old", rev: "A", status: "Archived", library_id: "lib1", asset_tags: [] },
      { id: "d5", org_id: "o1", document_number: "Q-SHEET", title: "Q", rev: "0", status: "Issued", library_id: "lib1", asset_tags: [{ tag: "Q-1" }] },
    ],
    document_assets: [
      { id: "r1", org_id: "o1", document_id: "d1", asset_id: "a-e22", tag_text: "E-22", source: "drawing", sheet_label: "2002-D-10001 SHT 4", pages: [1], asserted_by: "machine", model: null, source_revision: "B", vanished_at: null, superseded_at: null },
      { id: "r2", org_id: "o1", document_id: "d2", asset_id: "a-e22", tag_text: "E-22", source: "jsonb_sync", sheet_label: null, pages: null, asserted_by: "human" },
      { id: "r3", org_id: "o1", document_id: "d3", asset_id: "a-e22", tag_text: "E-22", source: "drawing", sheet_label: null },
    ],
    document_holds: [],
  };
  s.tag = "E-22";
  s.asset = { id: "a-e22", tag: "E-22", description: "Charge exchanger", location: null };
  s.extracted = [];
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ extracted: s.extracted }) })));
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("the asset hub lists what the relation links (WIRE-1 / BR-2)", () => {
  it("a drawing the Bridge read the tag on is listed with its sheet and a 'read from drawing' mark; the hand-tagged one once; the archived one not", async () => {
    await render();
    const text = container.textContent ?? "";
    expect(text).toContain("2002-D-10001");
    expect(text).toContain("2002-D-10001 SHT 4");
    expect(text).toContain("read from drawing");
    expect(text).toContain("DS-22");
    expect(text).not.toContain("OLD-1");
    expect(text).not.toContain("No controlled documents are tagged");
    const items = [...container.querySelectorAll("li")].map((li) => li.textContent ?? "");
    expect(items.filter((t) => t.includes("DS-22"))).toHaveLength(1);
    expect(items.find((t) => t.includes("DS-22"))).not.toContain("read from drawing");
    // The stat counts both.
    expect(text).toMatch(/Controlled documents\s*2/);
  });

  it("a link the current revision no longer carries is marked, not hidden (GAP-309)", async () => {
    (s.db.tables.document_assets[0] as Record<string, unknown>).vanished_at = "2026-10-01T00:00:00Z";
    await render();
    expect(container.textContent).toContain("not on current rev");
  });

  it("an UNREGISTERED tag still lists the documents whose asset_tags name it (nothing listed before disappears)", async () => {
    s.tag = "Q-1";
    s.asset = null;
    await render();
    expect(container.textContent).toContain("Q-SHEET");
    expect(container.textContent).toContain("Unregistered tag");
  });

  it("sheets read but not linked yet come from /api/equipment/sheets, labelled as proposals", async () => {
    s.extracted = [{ knowledgeDocumentId: "k-up", documentId: null, name: "upload.pdf", libraryId: null, pages: [7], sheets: ["page 7 (no title block read)"] }];
    await render();
    expect(container.textContent).toContain("Also read on (not linked yet)");
    expect(container.textContent).toContain("knowledge upload — see the coverage report");
    expect((fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0]).toBe("/api/equipment/sheets?orgId=o1&tag=E-22");
  });
});
