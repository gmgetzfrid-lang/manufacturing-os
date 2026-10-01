// intelligence Round G (I-13) — graph assembly: honest reads, one unit node
// per real unit, direction, and the guard test 99-fix-sequencing names
// ("each edge is a row somewhere").
//
// buildOrgGraph is driven end to end over an in-memory, filter-aware
// PostgREST stand-in (helpers/graphFakeDb.ts: keyset paging, ordering, RLS-
// hidden rows, missing tables/columns, failing reads, RPCs); the pure
// assembler (assembleOrgGraph) is driven directly for the rules that do not
// need I/O. Findings: GM-2, GM-3, GM-4, GM-6, GM-8, GM-10, GM-13, GPV-2,
// GPV-3, GPV-6, GPV-14, FLOW-8, WIRE-3, AREA-10, GAP-305 (graph half), and
// IRLS-14's lib/orgGraph.ts half (mentionCoverage).

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

import {
  buildOrgGraph, assembleOrgGraph, emptyGraphRows, GRAPH_CAPS,
  type OrgGraph, type GraphRows, type GraphEdge,
} from "@/lib/orgGraph";
import { computeInsights } from "@/lib/graphInsights";

const ORG = "org-1";

function reset(tables: Record<string, Row[]>) {
  db.tables = tables;
  db.missingTables = new Set();
  db.missingColumns = {};
  db.readError = {};
  db.hidden = {};
  db.refuseWrites = new Set();
  db.writeError = {};
  db.rpc = {};
  db.calls = [];
  db.seq = 0;
}

const o = <T extends Row>(r: T): T & { org_id: string } => ({ org_id: ORG, ...r });

/** A small plant: Crude Unit is codebook unit 20 AND an operational unit
 *  (u1, code U100) mapped to it; one drawing filed to u1; one exchanger
 *  filed to codebook unit 20. */
function plant(over: Partial<Record<string, Row[]>> = {}): Record<string, Row[]> {
  return {
    codebook_entries: [
      o({ id: "cb20", kind: "unit", code: "20", label: "Crude Unit", sort: 0, meta: {} }),
      o({ id: "cb30", kind: "unit", code: "30", label: "Coker", sort: 1, meta: {} }),
    ],
    plants: [o({ id: "p1", name: "Refinery", code: "BR", archived: false })],
    units: [o({ id: "u1", name: "Crude Unit", code: "U100", plant_id: "p1", codebook_code: "20", archived: false })],
    systems: [],
    libraries: [o({ id: "L1", name: "P&IDs" })],
    projects: [],
    documents: [o({
      id: "d1", document_number: "2002-D-10001", title: "Crude charge", library_id: "L1",
      unit_id: "u1", unit_code: null, plant_id: null, system_id: null, sheet_number: null, sheet_total: null,
      updated_at: "2026-09-01",
    })],
    assets: [o({ id: "a1", tag: "E-22", description: "Exchanger", unit_code: "20", unit_id: null, archived: false })],
    plot_plans: [],
    document_assets: [], project_documents: [], document_related_resources: [], document_supersessions: [],
    entity_mentions: [], process_flows: [], knowledge_documents: [], knowledge_libraries: [],
    ...over,
  } as Record<string, Row[]>;
}

/** Shortest hop count between two nodes over the drawn edges (Infinity if none). */
function hops(g: OrgGraph, from: string, to: string): number {
  const adj = new Map<string, string[]>();
  for (const e of g.edges) {
    (adj.get(e.a) ?? adj.set(e.a, []).get(e.a)!).push(e.b);
    (adj.get(e.b) ?? adj.set(e.b, []).get(e.b)!).push(e.a);
  }
  const seen = new Map([[from, 0]]);
  const q = [from];
  while (q.length) {
    const cur = q.shift()!;
    if (cur === to) return seen.get(cur)!;
    for (const n of adj.get(cur) ?? []) if (!seen.has(n)) { seen.set(n, seen.get(cur)! + 1); q.push(n); }
  }
  return Infinity;
}

const ids = (g: OrgGraph) => g.nodes.map((n) => n.id).sort();
const node = (g: OrgGraph, id: string) => g.nodes.find((n) => n.id === id);

beforeEach(() => reset(plant()));

describe("GAP-305 / GM-2 / GPV-3 / WIRE-3 / AREA-10 — one node per real unit", () => {
  it("a mapped operational unit IS its codebook unit: one node, and the drawing and the exchanger are two hops apart", async () => {
    const g = await buildOrgGraph(ORG);
    expect(ids(g)).toContain("cbunit:20");
    expect(ids(g)).not.toContain("unit:u1");
    expect(g.nodes.filter((n) => n.label === "Crude Unit")).toHaveLength(1);
    // documents.unit_id → the mapped row → cbunit:20 ← assets.unit_code
    expect(hops(g, "doc:d1", "asset:a1")).toBe(2);
    // a cbunit node at depth 1 reaches the documents scoped to it (GPV-3)
    expect(hops(g, "cbunit:20", "doc:d1")).toBe(1);
    const unit = node(g, "cbunit:20")!;
    expect(unit.unitId).toBe("u1");
    expect(unit.plantId).toBe("p1");
    // and the unit hangs from its plant (a `unit:` identity survives in a real org — WIRE-3)
    expect(g.edges).toContainEqual({ a: "cbunit:20", b: "plant:p1", type: "unit" });
  });

  it("the decode's column joins a document to the codebook unit with no operational unit at all", async () => {
    reset(plant({
      units: [],
      documents: [o({ id: "d2", document_number: "2002-D-20001", title: null, library_id: "L1", unit_id: null, unit_code: "20", sheet_number: null, sheet_total: null, updated_at: "2026-09-02" })],
    }));
    const g = await buildOrgGraph(ORG);
    expect(g.edges).toContainEqual({ a: "doc:d2", b: "cbunit:20", type: "unit" });
    expect(hops(g, "doc:d2", "asset:a1")).toBe(2);
    expect(node(g, "doc:d2")!.unitCode).toBe("20");
  });

  it("an UNMAPPED operational unit is its own node (a configured unit the codebook does not hold), linking to where it is mapped", async () => {
    reset(plant({ units: [o({ id: "u9", name: "Tank Farm", code: "U900", plant_id: "p1", codebook_code: null, archived: false })] }));
    const g = await buildOrgGraph(ORG);
    const u = node(g, "unit:u9")!;
    expect(u).toBeDefined();
    expect(u.unitCode).toBeNull();
    expect(u.unitId).toBe("u9");
    expect(u.href).toBe("/admin/scope");
  });

  it("a decoded unit that disagrees with the operational unit draws both ties and says so", async () => {
    reset(plant({
      documents: [o({ id: "d1", document_number: "3002-D-1", title: null, library_id: "L1", unit_id: "u1", unit_code: "30", sheet_number: null, sheet_total: null, updated_at: "2026-09-01" })],
    }));
    const g = await buildOrgGraph(ORG);
    expect(g.edges).toContainEqual({ a: "doc:d1", b: "cbunit:30", type: "unit" });
    expect(g.edges).toContainEqual({ a: "doc:d1", b: "cbunit:20", type: "unit" });
    expect(g.truncations.join("\n")).toMatch(/decoded unit \(drawing number\) and the operational unit differ for 1 document/);
  });

  it("before 20261138 the graph still builds (legacy columns) and says what it cannot draw", async () => {
    db.missingColumns = { documents: ["unit_code"], units: ["codebook_code"] };
    const g = await buildOrgGraph(ORG);
    expect(g.truncations.join("\n")).toMatch(/unit-identity migration \(20261138\) is not applied/);
    expect(ids(g)).toContain("doc:d1");
    expect(ids(g)).toContain("unit:u1"); // no mapping yet — the old two families, said
  });
});

describe("GM-10 — plants and systems are drawn from documents.plant_id / system_id", () => {
  it("a system is folded into the unit class and hangs from its (mapped) unit; plant- and system-filed paper is tied", async () => {
    reset(plant({
      systems: [o({ id: "s1", name: "Overhead System", code: "OH", unit_id: "u1", plant_id: "p1", archived: false })],
      documents: [
        o({ id: "dS", document_number: "OH-1", title: null, library_id: "L1", unit_id: null, unit_code: null, plant_id: null, system_id: "s1", sheet_number: null, sheet_total: null, updated_at: "2026-09-03" }),
        o({ id: "dP", document_number: "STD-1", title: null, library_id: "L1", unit_id: null, unit_code: null, plant_id: "p1", system_id: null, sheet_number: null, sheet_total: null, updated_at: "2026-09-04" }),
      ],
    }));
    const g = await buildOrgGraph(ORG);
    const sys = node(g, "system:s1")!;
    expect(sys.type).toBe("unit");
    expect(sys.unitCode).toBe("20");
    expect(g.edges).toContainEqual({ a: "system:s1", b: "cbunit:20", type: "unit" });
    expect(g.edges).toContainEqual({ a: "doc:dS", b: "system:s1", type: "unit" });
    expect(g.edges).toContainEqual({ a: "doc:dP", b: "plant:p1", type: "unit" });
    // neither is an orphan any more
    const ins = computeInsights(g.nodes, g.edges);
    expect(ins.orphans.map((n) => n.id)).not.toContain("doc:dS");
    expect(ins.orphans.map((n) => n.id)).not.toContain("doc:dP");
  });
});

describe("GPV-2 — a node carries its structural scoping keys", () => {
  it("documents and assets keep unitCode / unitId / plantId / systemId / libraryId / typeId / sheetNumber from the rows read", async () => {
    reset(plant({
      documents: [o({ id: "d1", document_number: "2002-D-10001", title: "t", library_id: "L1", unit_id: "u1", unit_code: null, plant_id: "p1", system_id: null, sheet_number: 4, sheet_total: 9, updated_at: "2026-09-01" })],
      assets: [o({ id: "a1", tag: "E-22", description: null, unit_code: "20", unit_id: null, plant_id: "p1", system_id: null, type_id: "t30", library_id: "L1", archived: false })],
    }));
    const g = await buildOrgGraph(ORG);
    expect(node(g, "doc:d1")).toMatchObject({ unitCode: "20", unitId: "u1", plantId: "p1", libraryId: "L1", sheetNumber: 4 });
    expect(node(g, "asset:a1")).toMatchObject({ unitCode: "20", unitId: "u1", plantId: "p1", typeId: "t30", libraryId: "L1" });
    // and the assets select carries the scope FKs and the type
    const sel = db.calls.find((c) => c.table === "assets" && c.method === "select")!;
    expect(String(sel.args[0])).toMatch(/plant_id, system_id, type_id/);
  });
});

describe("GPV-14 — a unit's pinned libraries and its bound knowledge library are drawn", () => {
  it("meta.links → cbunit → library (pinned, folder named); meta.knowledgeLibraryId → cbunit → knowledge library", async () => {
    reset(plant({
      codebook_entries: [o({
        id: "cb20", kind: "unit", code: "20", label: "Crude Unit", sort: 0,
        meta: {
          links: [
            { id: "k1", label: "P&IDs", libraryId: "L1", libraryName: "P&IDs", folderId: "f-20", folderName: "Unit 20" },
          ],
          knowledgeLibraryId: "KL1",
        },
      })],
      knowledge_libraries: [o({ id: "KL1", name: "Crude Unit shelf" })],
    }));
    const g = await buildOrgGraph(ORG);
    const pinned = g.edges.find((e) => e.a === "cbunit:20" && e.b === "lib:L1")!;
    expect(pinned).toMatchObject({ type: "library", via: "pinned" });
    expect(pinned.note).toContain("Unit 20");
    const shelf = g.edges.find((e) => e.a === "cbunit:20" && e.b === "klib:KL1")!;
    expect(shelf).toMatchObject({ type: "library", via: "knowledge" });
    expect(node(g, "klib:KL1")).toMatchObject({ type: "library", sub: "Knowledge library", href: "/knowledge/KL1" });
    // a filing edge carries no `via` — the three statements are told apart
    expect(g.edges.find((e) => e.a === "doc:d1" && e.b === "lib:L1")!.via).toBeUndefined();
  });
});

describe("FLOW-8 / GM-8 — direction survives assembly", () => {
  it("A→B and B→A are two flow edges, each keeping its direction; a proposed flow is counted, not dropped silently", async () => {
    reset(plant({
      assets: [
        o({ id: "a1", tag: "T-401", description: null, unit_code: "20", unit_id: null, archived: false }),
        o({ id: "a2", tag: "P-402", description: null, unit_code: "20", unit_id: null, archived: false }),
      ],
      process_flows: [
        o({ id: "f1", from_kind: "asset", from_ref: "a1", to_kind: "asset", to_ref: "a2", status: "confirmed" }),
        o({ id: "f2", from_kind: "asset", from_ref: "a2", to_kind: "asset", to_ref: "a1", status: "confirmed" }),
        o({ id: "f3", from_kind: "unit", from_ref: "20", to_kind: "unit", to_ref: "30", status: "proposed" }),
      ],
    }));
    const g = await buildOrgGraph(ORG);
    const flows = g.edges.filter((e) => e.type === "flow");
    expect(flows).toHaveLength(2);
    expect(flows).toContainEqual({ a: "asset:a1", b: "asset:a2", type: "flow" });
    expect(flows).toContainEqual({ a: "asset:a2", b: "asset:a1", type: "flow" });
    expect(g.truncations.join("\n")).toMatch(/1 process flow is proposed and awaiting review — not drawn/);
  });

  it("supersession is directional too; symmetric types still dedupe as a pair", () => {
    const rows: GraphRows = {
      ...emptyGraphRows(),
      libraries: [{ id: "L1", name: "L" }],
      documents: ["x", "y"].map((id) => ({ id, document_number: id, title: null, library_id: "L1", unit_id: null, sheet_number: null, sheet_total: null })),
      supersessions: [{ superseded_doc_id: "x", replacement_doc_id: "y" }, { superseded_doc_id: "y", replacement_doc_id: "x" }],
      related: [{ document_id: "x", target_document_id: "y", kind: "document" }, { document_id: "y", target_document_id: "x", kind: "document" }],
    };
    const g = assembleOrgGraph(rows);
    expect(g.edges.filter((e) => e.type === "supersession")).toHaveLength(2);
    expect(g.edges.filter((e) => e.type === "related")).toHaveLength(1);
  });
});

describe("GM-4 — a failed optional read is said, a missing pre-migration table is not an error", () => {
  it("a non-42P01 error on the equipment read becomes a visible note (the map does not pretend there is no equipment)", async () => {
    db.readError = { assets: { code: "57014", message: "canceling statement due to statement timeout" } };
    const g = await buildOrgGraph(ORG);
    expect(g.truncations.join("\n")).toMatch(/Equipment could not be loaded \(canceling statement due to statement timeout\) — the map is incomplete\./);
    expect(g.nodes.some((n) => n.type === "asset")).toBe(false);
  });

  it("units, plants, plot plans and the codebook say so too; a table that does not exist yet is silent", async () => {
    db.readError = { plot_plans: { message: "JWT expired" }, units: { message: "boom" }, codebook_entries: { message: "nope" } };
    db.missingTables = new Set(["process_flows", "entity_mentions"]);
    const g = await buildOrgGraph(ORG);
    const t = g.truncations.join("\n");
    expect(t).toMatch(/Plot plans could not be loaded \(JWT expired\)/);
    expect(t).toMatch(/Operational units could not be loaded \(boom\)/);
    expect(t).toMatch(/Site Codebook units could not be loaded \(nope\)/);
    expect(t).not.toMatch(/process flows? could not/i);
    expect(g.mentionCoverage).toMatchObject({ installed: false, rows: 0, drawn: 0 });
  });

  it("a real error on a link table is fatal, as before (the documents and libraries reads too)", async () => {
    db.readError = { document_supersessions: { message: "permission denied" } };
    await expect(buildOrgGraph(ORG)).rejects.toThrow(/document_supersessions: permission denied/);
  });
});

describe("GM-3 / GPV-6 — ordered reads, true caps, counted losses", () => {
  it("an org beyond ASSET_CAP: the first N BY TAG are drawn, and the links to the rest are counted by name", async () => {
    const N = GRAPH_CAPS.ASSET_CAP + 5;
    const assets = Array.from({ length: N }, (_, i) => o({
      id: `a${String(i).padStart(5, "0")}`, tag: `E-${String(N - i).padStart(5, "0")}`, description: null,
      unit_code: null, unit_id: null, archived: false,
    }));
    // the five assets past the cap BY TAG are a00000..a00004 (highest tags)
    reset(plant({
      assets,
      document_assets: ["a00000", "a00001", "a00002", "a00003", "a00004", "a00010"].map((aid, i) => o({ id: `da${i}`, document_id: "d1", asset_id: aid })),
    }));
    const g = await buildOrgGraph(ORG);
    expect(g.nodes.filter((n) => n.type === "asset")).toHaveLength(GRAPH_CAPS.ASSET_CAP);
    expect(ids(g)).not.toContain("asset:a00000");
    expect(ids(g)).toContain("asset:a00010");
    const t = g.truncations.join("\n");
    expect(t).toContain(`Showing the first ${GRAPH_CAPS.ASSET_CAP.toLocaleString("en-US")} equipment items by tag.`);
    expect(t).toMatch(/5 links lead to equipment, documents or units not on this map .* 5 equipment-tag\./);
    expect(g.severed).toBe(5);
    expect(t).not.toMatch(/densest web/);
    // the assets read is ordered, and capped with one extra row to know
    const order = db.calls.filter((c) => c.table === "assets" && c.method === "order").map((c) => c.args[0]);
    expect(order).toEqual(["tag", "id"]);
    expect(db.calls.find((c) => c.table === "assets" && c.method === "limit")!.args[0]).toBe(GRAPH_CAPS.ASSET_CAP + 1);
  });

  it("exactly ASSET_CAP assets is not a cap (no false notice)", async () => {
    const assets = Array.from({ length: GRAPH_CAPS.ASSET_CAP }, (_, i) => o({ id: `a${i}`, tag: `E-${i}`, description: null, unit_code: null, unit_id: null, archived: false }));
    reset(plant({ assets }));
    const g = await buildOrgGraph(ORG);
    expect(g.truncations.join("\n")).not.toMatch(/equipment items by tag/);
  });

  it("libraries, projects and plot plans are ordered by name and their caps are reported", async () => {
    const many = (prefix: string) => Array.from({ length: GRAPH_CAPS.LIST_CAP + 2 }, (_, i) => o({ id: `${prefix}${i}`, name: `${prefix} ${String(i).padStart(4, "0")}`, status: null, markers: [] }));
    reset(plant({ libraries: many("L"), projects: many("P"), plot_plans: many("Q") }));
    const g = await buildOrgGraph(ORG);
    const t = g.truncations.join("\n");
    expect(t).toContain("Showing the first 300 libraries by name.");
    expect(t).toContain("Showing the first 300 projects by name.");
    expect(t).toContain("Showing the first 300 plot plans by name.");
    for (const table of ["libraries", "projects", "plot_plans"]) {
      expect(db.calls.find((c) => c.table === table && c.method === "order")!.args[0]).toBe("name");
    }
  });

  it("link tables are paged in keyset order (id ascending, gt the last id) — never an unordered OFFSET", async () => {
    const rows = Array.from({ length: GRAPH_CAPS.EDGE_PAGE + 10 }, (_, i) => o({ id: `da${String(i).padStart(5, "0")}`, document_id: "d1", asset_id: "a1" }));
    reset(plant({ document_assets: rows }));
    await buildOrgGraph(ORG);
    const calls = db.calls.filter((c) => c.table === "document_assets");
    expect(calls.some((c) => c.method === "range")).toBe(false);
    expect(calls.filter((c) => c.method === "order").every((c) => c.args[0] === "id")).toBe(true);
    expect(calls.find((c) => c.method === "gt")!.args).toEqual(["id", `da${String(GRAPH_CAPS.EDGE_PAGE - 1).padStart(5, "0")}`]);
  });
});

describe("GM-13 / FLOW-9 (orgGraph half) — every capped pull is said; the mirror map can only tell the truth", () => {
  it("capped supersessions, curated links and flows each produce a truncation naming what was read of how many", async () => {
    const n = GRAPH_CAPS.EDGE_CAP + 3;
    const sup = Array.from({ length: n }, (_, i) => o({ id: `s${String(i).padStart(6, "0")}`, superseded_doc_id: `x${i}`, replacement_doc_id: `y${i}` }));
    const rel = Array.from({ length: n }, (_, i) => o({ id: `r${String(i).padStart(6, "0")}`, document_id: `x${i}`, target_document_id: `y${i}`, kind: "document" }));
    const flo = Array.from({ length: n }, (_, i) => o({ id: `f${String(i).padStart(6, "0")}`, from_kind: "asset", from_ref: `x${i}`, to_kind: "asset", to_ref: `y${i}`, status: "confirmed" }));
    reset(plant({ document_supersessions: sup, document_related_resources: rel, process_flows: flo }));
    const g = await buildOrgGraph(ORG);
    const t = g.truncations.join("\n");
    expect(t).toContain("Supersession (revision lineage) links capped — 8,000 of 8,003 read; the rest are not drawn.");
    expect(t).toContain("Curated document links capped — 8,000 of 8,003 read; the rest are not drawn.");
    expect(t).toContain("Process flows capped — 8,000 of 8,003 read; the rest are not drawn.");
  });

  it("every mirror a mention points through is resolved — a mirrored CONTROLLED document is never announced as library-only", async () => {
    // 6,000 mirrors: the old .limit(5000) dropped the last thousand and
    // called their mentions "library-only".
    const kdocs = Array.from({ length: 6000 }, (_, i) => o({ id: `k${String(i).padStart(5, "0")}`, source_document_id: i === 5999 ? "d1" : `dx${i}` }));
    reset(plant({
      knowledge_documents: [...kdocs, o({ id: "kLIB", source_document_id: null })],
      entity_mentions: [
        o({ id: "m1", asset_id: "a1", document_id: null, knowledge_document_id: "k05999" }),
        o({ id: "m2", asset_id: "a1", document_id: null, knowledge_document_id: "kLIB" }),
      ],
    }));
    const g = await buildOrgGraph(ORG);
    expect(g.edges).toContainEqual({ a: "doc:d1", b: "asset:a1", type: "mention" });
    expect(g.truncations.join("\n")).toMatch(/^1 mention come from library-only documents/m);
    expect(g.mentionCoverage).toMatchObject({ installed: true, rows: 2, drawn: 1, unmapped: 1, capped: false });
  });
});

describe("pageIn — chunked, waved IN reads lose nothing", () => {
  it("1,200 mentions through 1,200 distinct mirrors (8 chunks, 2 waves) are all resolved and drawn", async () => {
    const n = 1200;
    const docs = Array.from({ length: n }, (_, i) => o({
      id: `dm${String(i).padStart(5, "0")}`, document_number: `M-${i}`, title: null, library_id: "L1", unit_id: null, unit_code: null,
      sheet_number: null, sheet_total: null, updated_at: "2026-09-01",
    }));
    reset(plant({
      documents: docs,
      knowledge_documents: docs.map((d, i) => o({ id: `km${String(i).padStart(5, "0")}`, source_document_id: d.id })),
      entity_mentions: docs.map((_, i) => o({ id: `mm${String(i).padStart(5, "0")}`, asset_id: "a1", document_id: null, knowledge_document_id: `km${String(i).padStart(5, "0")}` })),
    }));
    const g = await buildOrgGraph(ORG);
    expect(g.mentionCoverage).toMatchObject({ rows: n, drawn: n, unmapped: 0 });
    expect(g.truncations.join("\n")).not.toMatch(/could not resolve|library-only/);
    const inCalls = db.calls.filter((c) => c.table === "knowledge_documents" && c.method === "in");
    expect(inCalls).toHaveLength(Math.ceil(n / 150));
    expect(inCalls.every((c) => (c.args[1] as unknown[]).length <= 150)).toBe(true);
  });
});

describe("GM-6 — the reader's ACL is reported, not presented as a fact about the plant", () => {
  const twoDocs = () => plant({
    documents: [
      o({ id: "d1", document_number: "2002-D-10001", title: null, library_id: "L1", unit_id: "u1", unit_code: null, sheet_number: null, sheet_total: null, updated_at: "2026-09-01", visibility: "normal" }),
      o({ id: "dR", document_number: "2002-D-99", title: null, library_id: "L1", unit_id: null, unit_code: null, sheet_number: null, sheet_total: null, updated_at: "2026-09-02", visibility: "private" }),
    ],
    assets: [
      o({ id: "a1", tag: "E-22", description: null, unit_code: "20", unit_id: null, archived: false }),
      o({ id: "a2", tag: "V-7", description: null, unit_code: null, unit_id: null, archived: false }),
    ],
    document_assets: [o({ id: "da1", document_id: "dR", asset_id: "a2" })],
  });

  it("a controller and a granted-nothing member assemble different graphs, and only the member's says so", async () => {
    // controller: sees both documents
    reset(twoDocs());
    db.rpc = { documents_total_for_org: () => ({ data: 2, error: null }) };
    const controller = await buildOrgGraph(ORG);
    expect(controller.access).toEqual({ documentsVisible: 2, documentsTotal: 2, outsideAccess: 0, documentsDrawn: 2, scoped: false });
    expect(controller.truncations.join("\n")).not.toMatch(/outside your access/);
    const cIns = computeInsights(controller.nodes, controller.edges, { access: controller.access });

    // member: the restricted drawing is hidden by documents RLS
    reset(twoDocs());
    db.rpc = { documents_total_for_org: () => ({ data: 2, error: null }) };
    db.hidden = { documents: (r) => r.visibility === "private" };
    const member = await buildOrgGraph(ORG);
    expect(member.access).toEqual({ documentsVisible: 1, documentsTotal: 2, outsideAccess: 1, documentsDrawn: 1, scoped: false });
    expect(member.truncations.join("\n")).toMatch(/1 document in this org is outside your access and not on this map — orphans, hubs and bridges are computed on what you can see\./);
    const mIns = computeInsights(member.nodes, member.edges, { access: member.access });

    // the difference is real (V-7 is an orphan only for the member) and surfaced
    expect(cIns.orphans.map((n) => n.id)).not.toContain("asset:a2");
    expect(mIns.orphans.map((n) => n.id)).toContain("asset:a2");
    expect(mIns.basis).toMatchObject({ viewerScoped: true, outsideAccess: 1 });
    expect(mIns.basis.note).toMatch(/1 more is outside your access/);
    expect(cIns.basis.note).toBe("Computed on the documents on this map; none of the org's documents are hidden from you.");
    expect(cIns.basis.note).not.toMatch(/every document in the org/);
  });

  it("an org-wide map past the document cap never claims to cover every document — the basis says how many are drawn", async () => {
    const N = GRAPH_CAPS.DOC_CAP + 20;
    const documents = Array.from({ length: N }, (_, i) => o({
      id: `d${String(i).padStart(5, "0")}`, document_number: `N-${i}`, title: null, library_id: "L1", unit_id: null, unit_code: null,
      sheet_number: null, sheet_total: null, updated_at: `2026-09-${String(1 + (i % 28)).padStart(2, "0")}`,
    }));
    reset(plant({ documents }));
    db.rpc = { documents_total_for_org: () => ({ data: N, error: null }) };
    const g = await buildOrgGraph(ORG);
    expect(g.access).toEqual({ documentsVisible: N, documentsTotal: N, outsideAccess: 0, documentsDrawn: GRAPH_CAPS.DOC_CAP, scoped: false });
    const note = computeInsights(g.nodes, g.edges, { access: g.access }).basis.note;
    expect(note).toBe(`Computed on the documents on this map; none of the org's documents are hidden from you, but only ${GRAPH_CAPS.DOC_CAP.toLocaleString("en-US")} of ${N.toLocaleString("en-US")} are drawn (a cap).`);
    expect(note).not.toMatch(/every document in the org/);
  });

  it("before 20261138 (no count function) the graph makes no claim", async () => {
    const g = await buildOrgGraph(ORG);
    expect(g.access).toMatchObject({ documentsTotal: null, outsideAccess: null });
    expect(g.truncations.join("\n")).not.toMatch(/outside your access/);
  });
});

describe("the guard test — each edge is a row somewhere (99-fix-sequencing: never infer the unit edge at assembly)", () => {
  /** The row behind an edge, looked up independently of the assembler. */
  function sourceOf(e: GraphEdge, rows: GraphRows): string | null {
    const raw = (id: string) => id.slice(id.indexOf(":") + 1);
    const unitNode = (unitId: string) => {
      const u = rows.units.find((x) => x.id === unitId);
      return u?.codebook_code && rows.codebookUnits.some((c) => c.code === u.codebook_code) ? `cbunit:${u.codebook_code}` : `unit:${unitId}`;
    };
    const ends = new Set([e.a, e.b]);
    const has = (a: string, b: string) => ends.has(a) && ends.has(b);
    switch (e.type) {
      case "tag": return rows.docAssets.some((r) => has(`doc:${r.document_id}`, `asset:${r.asset_id}`)) ? "document_assets" : null;
      case "mention": return rows.mentions.some((m) => {
        const d = m.document_id ?? (m.knowledge_document_id ? rows.mirrorOf.get(m.knowledge_document_id) : null);
        return d ? has(`doc:${d}`, `asset:${m.asset_id}`) : false;
      }) ? "entity_mentions" : null;
      case "project": return rows.projectDocs.some((r) => has(`proj:${r.project_id}`, `doc:${r.document_id}`)) ? "project_documents" : null;
      case "related": return rows.related.some((r) => r.target_document_id && has(`doc:${r.document_id}`, `doc:${r.target_document_id}`)) ? "document_related_resources" : null;
      case "supersession": return rows.supersessions.some((r) => e.a === `doc:${r.superseded_doc_id}` && e.b === `doc:${r.replacement_doc_id}`) ? "document_supersessions" : null;
      case "flow": return rows.flows.some((f) => f.status === "confirmed"
        && e.a === (f.from_kind === "asset" ? `asset:${f.from_ref}` : `cbunit:${f.from_ref}`)
        && e.b === (f.to_kind === "asset" ? `asset:${f.to_ref}` : `cbunit:${f.to_ref}`)) ? "process_flows" : null;
      case "plot": return rows.plotPlans.some((p) => (p.markers as Array<{ assetId?: string }>).some((m) => has(`plot:${p.id}`, `asset:${m.assetId}`))) ? "plot_plans.markers" : null;
      case "library":
        if (rows.documents.some((d) => has(`doc:${d.id}`, `lib:${d.library_id}`))) return "documents.library_id";
        if (rows.codebookUnits.some((u) => (u.meta?.links ?? []).some((l) => has(`cbunit:${u.code}`, `lib:${l.libraryId}`)))) return "codebook meta.links";
        if (rows.codebookUnits.some((u) => u.meta?.knowledgeLibraryId && has(`cbunit:${u.code}`, `klib:${u.meta.knowledgeLibraryId}`))) return "codebook meta.knowledgeLibraryId";
        return null;
      case "unit": {
        for (const d of rows.documents) {
          if (d.unit_code && has(`doc:${d.id}`, `cbunit:${d.unit_code}`)) return "documents.unit_code";
          if (d.unit_id && has(`doc:${d.id}`, unitNode(d.unit_id))) return "documents.unit_id";
          if (d.system_id && has(`doc:${d.id}`, `system:${d.system_id}`)) return "documents.system_id";
          if (d.plant_id && has(`doc:${d.id}`, `plant:${d.plant_id}`)) return "documents.plant_id";
        }
        for (const a of rows.assets) {
          if (a.unit_code && has(`asset:${a.id}`, `cbunit:${a.unit_code}`)) return "assets.unit_code";
          if (a.unit_id && has(`asset:${a.id}`, unitNode(a.unit_id))) return "assets.unit_id";
          if (a.system_id && has(`asset:${a.id}`, `system:${a.system_id}`)) return "assets.system_id";
          if (a.plant_id && has(`asset:${a.id}`, `plant:${a.plant_id}`)) return "assets.plant_id";
        }
        for (const s of rows.systems) if (has(`system:${s.id}`, unitNode(s.unit_id))) return "systems.unit_id";
        for (const u of rows.units) if (has(unitNode(u.id), `plant:${u.plant_id}`)) return "units.plant_id";
        return null;
      }
      default: return raw(e.a) && null;
    }
  }

  it("every edge of a busy graph maps back to the row that states it", () => {
    const rows: GraphRows = {
      ...emptyGraphRows(),
      codebookUnits: [
        { code: "20", label: "Crude Unit", meta: { links: [{ id: "k", label: "P&IDs", libraryId: "L1", libraryName: "P&IDs" }], knowledgeLibraryId: "KL1" } },
        { code: "30", label: "Coker", meta: {} },
      ],
      units: [
        { id: "u1", name: "Crude", code: "U100", plant_id: "p1", codebook_code: "20" },
        { id: "u2", name: "Tank Farm", code: "U900", plant_id: "p1", codebook_code: null },
      ],
      plants: [{ id: "p1", name: "Refinery", code: null }],
      systems: [{ id: "s1", name: "Overhead", code: null, unit_id: "u1", plant_id: "p1" }],
      libraries: [{ id: "L1", name: "P&IDs" }],
      knowledgeLibraries: [{ id: "KL1", name: "Shelf" }],
      projects: [{ id: "j1", name: "TA-26", status: "active" }],
      plotPlans: [{ id: "q1", name: "Site", markers: [{ assetId: "a1" }] }],
      documents: [
        { id: "d1", document_number: "2002-D-1", title: null, library_id: "L1", unit_id: "u1", unit_code: "20", plant_id: "p1", system_id: "s1", sheet_number: null, sheet_total: null },
        { id: "d2", document_number: "2002-D-2", title: null, library_id: "L1", unit_id: "u2", unit_code: null, sheet_number: null, sheet_total: null },
        // a number that WOULD decode to unit 20 — but no unit_code row says so
        { id: "d3", document_number: "2002-D-10001", title: null, library_id: "L1", unit_id: null, unit_code: null, sheet_number: null, sheet_total: null },
      ],
      assets: [
        { id: "a1", tag: "E-22", description: null, unit_code: "20", unit_id: "u1", system_id: "s1", plant_id: "p1" },
        { id: "a2", tag: "P-5", description: null, unit_code: "30", unit_id: null },
      ],
      docAssets: [{ document_id: "d1", asset_id: "a1" }],
      projectDocs: [{ project_id: "j1", document_id: "d2" }],
      related: [{ document_id: "d1", target_document_id: "d2", kind: "document" }],
      supersessions: [{ superseded_doc_id: "d2", replacement_doc_id: "d1" }],
      mentions: [{ asset_id: "a2", document_id: null, knowledge_document_id: "k1" }],
      mirrorOf: new Map([["k1", "d2"]]),
      flows: [
        { from_kind: "asset", from_ref: "a1", to_kind: "asset", to_ref: "a2", status: "confirmed" },
        { from_kind: "unit", from_ref: "20", to_kind: "unit", to_ref: "30", status: "confirmed" },
      ],
    };
    const g = assembleOrgGraph(rows);
    expect(g.edges.length).toBeGreaterThan(15);
    for (const e of g.edges) expect(sourceOf(e, rows), `${e.a} —${e.type}→ ${e.b}`).not.toBeNull();
    // the decodable-but-undecoded drawing has NO unit tie: assembly never parses a number
    expect(g.edges.some((e) => e.type === "unit" && (e.a === "doc:d3" || e.b === "doc:d3"))).toBe(false);
  });

  it("the assembly does not import the decoder (lib/orgGraph.ts never calls parseDrawingNumber)", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("lib/orgGraph.ts", "utf8").replace(/\/\/[^\n]*/g, "");
    expect(src).not.toMatch(/parseDrawingNumber|decodeDrawingNumber/);
  });
});
