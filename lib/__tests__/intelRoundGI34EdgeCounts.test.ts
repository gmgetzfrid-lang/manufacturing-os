// intelligence Round G I-34 DOCUMENT EDGE READ RAILS — DACL-11 done-when 2:
// the existence-only surfaces (the impact panel's counts, the org graph's
// degree and its "links leading off the map" / "N more this way" counts)
// count only nodes the caller can see, and a reader who can see everything
// gets today's numbers.
//
// Both surfaces read with the caller's own client (lib/supabase), so what
// they count is what the caller's RLS returns. They are driven here over the
// filter-aware PostgREST stand-in (helpers/graphFakeDb.ts), whose `hidden`
// map is RLS: documents RLS hides a private drawing from a member it does not
// grant; the read rails (20261120 / 20261126 / 20261170, and 20261261 for
// document_supersessions) hide every link row naming it.
//
//   * The impact panel resolves every listed node through `documents` (and
//     projects / work packages) under the caller's RLS, so its counts never
//     included a hidden drawing — with or without the rails (pinned).
//   * The graph draws an edge only between two nodes on the map, and a node's
//     degree counts drawn edges only — never a hidden node (pinned). What a
//     hidden node DID reach is the count of links "leading off the map" (and,
//     in a unit scope, the boundary stub on the visible node): a supersession
//     row naming a hidden drawing came back member-wide until 20261261 and
//     was counted there. With the rail it is not returned, so it is not
//     counted; a controller (who reads every document) sees today's map.
//   The app is unchanged by I-34: the rail is the fix, these pin the surfaces.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { GraphFakeDb, Row } from "./helpers/graphFakeDb";

const db = vi.hoisted(() => ({
  tables: {}, missingTables: new Set<string>(), missingColumns: {}, readError: {}, hidden: {},
  refuseWrites: new Set<string>(), writeError: {}, rpc: {}, calls: [], seq: 0,
}) as unknown as GraphFakeDb);

vi.mock("@/lib/supabase", async () => {
  const { makeGraphFake } = await import("./helpers/graphFakeDb");
  return { supabase: makeGraphFake(db) };
});

import { buildOrgGraph, assembleOrgGraph, emptyGraphRows, type GraphRows, type OrgGraph } from "@/lib/orgGraph";
import { getDocumentImpact } from "@/lib/impact";

const ORG = "org-1";
const o = <T extends Row>(r: T): T & { org_id: string } => ({ org_id: ORG, ...r });
const docRow = (id: string, visibility: string, updated: string) => o({
  id, document_number: `P-${id}`, title: id, name: `${id}.pdf`, rev: "1", library_id: "L1", status: "Issued",
  checked_out_by_name: null, current_version_id: null, visibility,
  unit_id: null, unit_code: null, plant_id: null, system_id: null, sheet_number: null, sheet_total: null,
  updated_at: updated,
});

/** d1 (open, the one being changed), d2 (open), dP (private — Engineer only). */
function seed() {
  db.tables = {
    codebook_entries: [], plants: [], units: [], systems: [], plot_plans: [], process_flows: [],
    libraries: [o({ id: "L1", name: "P&IDs" })],
    projects: [], knowledge_documents: [], knowledge_libraries: [],
    documents: [docRow("d1", "normal", "2026-10-03"), docRow("d2", "normal", "2026-10-02"), docRow("dP", "private", "2026-10-01")],
    assets: [o({ id: "a1", tag: "E-204", description: null, unit_code: null, unit_id: null, archived: false })],
    document_assets: [
      o({ id: "da1", document_id: "d1", asset_id: "a1", tag_text: "E-204", source: "manual" }),
      o({ id: "da2", document_id: "d2", asset_id: "a1", tag_text: "E-204", source: "manual" }),
      o({ id: "daP", document_id: "dP", asset_id: "a1", tag_text: "E-204", source: "manual" }),
    ],
    project_documents: [],
    document_related_resources: [o({ id: "r1", document_id: "d1", target_document_id: "dP", kind: "document" })],
    document_supersessions: [
      o({ id: "s1", superseded_doc_id: "d1", replacement_doc_id: "d2" }),
      o({ id: "s2", superseded_doc_id: "d1", replacement_doc_id: "dP" }),
    ],
    entity_mentions: [o({ id: "m1", asset_id: "a1", document_id: "dP", knowledge_document_id: null })],
    document_holds: [], revision_branches: [], work_package_documents: [], distribution_acks: [], tickets: [],
  } as Record<string, Row[]>;
  db.missingTables = new Set();
  db.missingColumns = {};
  db.readError = {};
  db.refuseWrites = new Set();
  db.writeError = {};
  db.rpc = {};
  db.calls = [];
  db.seq = 0;
}

const PRIVATE = new Set(["dP"]);
const names = (r: Row, cols: string[]) => cols.some((c) => PRIVATE.has(String(r[c])));

/** What the caller's RLS hides. A controller: nothing. A Viewer: the private
 *  drawing, and every link row a read rail ties to it — with or without
 *  20261261's rail on document_supersessions. */
function asReader(kind: "controller" | "viewerNoRails" | "viewerBefore" | "viewerAfter") {
  if (kind === "controller") { db.hidden = {}; return; }
  if (kind === "viewerNoRails") { db.hidden = { documents: (r) => r.visibility === "private" }; return; }
  db.hidden = {
    documents: (r) => r.visibility === "private",
    document_assets: (r) => names(r, ["document_id"]),                                   // 20261170
    project_documents: (r) => names(r, ["document_id"]),                                 // 20261170
    document_related_resources: (r) => names(r, ["document_id", "target_document_id"]),  // 20261126
    entity_mentions: (r) => names(r, ["document_id"]),                                   // 20261120
    ...(kind === "viewerAfter"
      ? { document_supersessions: (r: Row) => names(r, ["superseded_doc_id", "replacement_doc_id"]) } // 20261261
      : {}),
  };
}

const node = (g: OrgGraph, id: string) => g.nodes.find((n) => n.id === id);

beforeEach(seed);

describe("I-34 / DACL-11 — the impact panel counts only documents the caller can see", () => {
  it("a Viewer's panel lists the open sibling only — before and after the rails; a controller's lists both, exactly as today", async () => {
    // with no rail at all the link rows still name dP, but the sibling list
    // is resolved through documents under the reader's RLS
    asReader("viewerNoRails");
    const before = await getDocumentImpact("d1", ORG);
    expect(before.siblingDocs.map((d) => d.id)).toEqual(["d2"]);
    asReader("viewerAfter");
    const after = await getDocumentImpact("d1", ORG);
    expect(after.siblingDocs.map((d) => d.id)).toEqual(["d2"]);
    expect(after.assets).toEqual([{ id: "a1", tag: "E-204" }]);
    asReader("controller");
    const all = await getDocumentImpact("d1", ORG);
    expect(all.siblingDocs.map((d) => d.id).sort()).toEqual(["d2", "dP"]);
    expect(all.siblingDocs.find((d) => d.id === "dP")?.sharedTags).toEqual(["E-204"]);
  });
});

describe("I-34 / DACL-11 — the org graph's degree and edge counts include no hidden node", () => {
  it("a controller sees today's map: both lineage rows drawn, the curated link and the mention drawn, nothing counted off the map", async () => {
    asReader("controller");
    const g = await buildOrgGraph(ORG);
    expect(g.edges.filter((e) => e.type === "supersession")).toEqual([
      { a: "doc:d1", b: "doc:d2", type: "supersession" },
      { a: "doc:d1", b: "doc:dP", type: "supersession" },
    ]);
    expect(g.severed).toBe(0);
    expect(node(g, "doc:dP")).toBeDefined();
    // d1: library, tag, two lineage edges, the curated link to dP
    expect(node(g, "doc:d1")!.degree).toBe(5);
  });

  it("before 20261261 a Viewer's map counted the lineage row to the hidden drawing as a link leading off the map (the leak); its degree never counted it", async () => {
    asReader("viewerBefore");
    const g = await buildOrgGraph(ORG);
    expect(node(g, "doc:dP")).toBeUndefined();
    expect(g.severed).toBe(1);
    expect(g.truncations.join("\n")).toMatch(/1 link leads to equipment, documents or units not on this map .* — 1 supersession\./);
    // d1: library, tag, the lineage edge to d2 — never the hidden one
    expect(node(g, "doc:d1")!.degree).toBe(3);
  });

  it("with 20261261's rail the row is not returned, so nothing hidden is counted — the same degree, no off-map link", async () => {
    asReader("viewerAfter");
    const g = await buildOrgGraph(ORG);
    expect(node(g, "doc:dP")).toBeUndefined();
    expect(g.severed).toBe(0);
    expect(g.truncations.join("\n")).not.toMatch(/supersession/);
    expect(node(g, "doc:d1")!.degree).toBe(3);
    expect(g.edges.filter((e) => e.type === "supersession")).toEqual([{ a: "doc:d1", b: "doc:d2", type: "supersession" }]);
  });

  it("in a unit scope the boundary stub ('N more this way') on the visible drawing counts a hidden replacement only while the row is returned", () => {
    const base: GraphRows = {
      ...emptyGraphRows(),
      libraries: [{ id: "L1", name: "L" }],
      documents: ["d1"].map((id) => ({ id, document_number: id, title: null, library_id: "L1", unit_id: null, sheet_number: null, sheet_total: null })),
    };
    const scope = {
      ref: { kind: "unit" as const, code: "20" }, label: "Unit 20", complete: true,
      inScope: (id: string) => id === "doc:d1" || id === "lib:L1",
      keep: new Set<string>(),
    };
    const withRow = assembleOrgGraph({ ...base, supersessions: [{ superseded_doc_id: "d1", replacement_doc_id: "dP" }] }, { scope } as never);
    expect(withRow.nodes.find((n) => n.id === "doc:d1")!.outside).toBe(1);
    const railed = assembleOrgGraph({ ...base, supersessions: [] }, { scope } as never);
    expect(railed.nodes.find((n) => n.id === "doc:d1")!.outside).toBeUndefined();
    expect(railed.nodes.find((n) => n.id === "doc:d1")!.degree).toBe(withRow.nodes.find((n) => n.id === "doc:d1")!.degree);
  });
});
