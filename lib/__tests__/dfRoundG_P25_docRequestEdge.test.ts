// drafting-flow Round G, DF-P25 — PROJ-7 done-when 1, the edge limb (DEC-90
// ruling (5) for DF-P25, under DEC-67): the document ↔ request edge in
// lib/orgGraph.ts, drawn from tickets.metadata.source_document.id ONLY where
// that id names a document of the same workspace the reader can read — the
// reader's own read of `documents` (RLS), never the JSON alone — capped and
// reported like every edge source. Requests stay folded into the project
// class (no new node type). A map with no such request is byte-identical.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { GraphFakeDb, Row } from "./helpers/graphFakeDb";

const db = vi.hoisted(() => ({
  tables: {}, missingTables: new Set<string>(), missingColumns: {}, readError: {}, hidden: {},
  refuseWrites: new Set<string>(), writeError: {}, rpc: {}, calls: [], seq: 0,
}) as unknown as GraphFakeDb);

vi.mock("@/lib/supabase", async () => {
  const { makeGraphFake } = await import("./helpers/graphFakeDb");
  return { supabase: makeGraphFake(db) };
});

import { buildOrgGraph, assembleOrgGraph, emptyGraphRows, GRAPH_CAPS } from "@/lib/orgGraph";

const ORG = "org-1";
const D1 = "11111111-1111-4111-8111-111111111111";
const D2 = "22222222-2222-4222-8222-222222222222";
const D_OTHER = "33333333-3333-4333-8333-333333333333";
const o = <T extends Row>(r: T): T & { org_id: string } => ({ org_id: ORG, ...r });

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

const doc = (id: string, n: string) => o({
  id, document_number: n, title: null, library_id: "L1", unit_id: null, unit_code: null, plant_id: null, system_id: null,
  sheet_number: null, sheet_total: null, updated_at: "2026-09-01",
});
const ticket = (id: string, sourceId: unknown, extra: Row = {}) => o({
  id, ticket_id: `KE-${id}`, title: `Request ${id}`, status: "DRAFTING", archived_at: null, project_id: null,
  metadata: sourceId === undefined ? {} : { source_document: { id: sourceId, number: "X" } }, ...extra,
});

function world(tickets: Row[]): Record<string, Row[]> {
  return {
    codebook_entries: [], plants: [], units: [], systems: [],
    libraries: [o({ id: "L1", name: "P&IDs" })], projects: [],
    documents: [doc(D1, "PID-1"), doc(D2, "PID-2"), { ...doc(D_OTHER, "PID-X"), org_id: "org-2" }],
    assets: [], plot_plans: [],
    document_assets: [], project_documents: [], document_related_resources: [], document_supersessions: [],
    entity_mentions: [], process_flows: [], knowledge_documents: [], knowledge_libraries: [],
    tickets,
  } as Record<string, Row[]>;
}

beforeEach(() => reset(world([])));

describe("PROJ-7 edge limb (DF-P25) — the document ↔ request edge, from a readable source document only", () => {
  it("a request naming a readable document of this workspace is drawn as a project-class node with a 'project' edge from that document", async () => {
    reset(world([ticket("t1", D1)]));
    const g = await buildOrgGraph(ORG);
    const n = g.nodes.find((x) => x.id === "req:t1")!;
    expect(n).toMatchObject({ type: "project", label: "KE-t1 · Request t1", href: "/requests/t1" });
    expect(g.edges).toContainEqual(expect.objectContaining({ a: `doc:${D1}`, b: "req:t1", type: "project", note: "Drafting request on this document" }));
  });

  it("never from the JSON alone: another workspace's document, a document the reader cannot read (RLS), a deleted one, a malformed id, an archived request — nothing drawn, nothing counted", async () => {
    reset(world([
      ticket("t-other", D_OTHER),
      ticket("t-hidden", D2),
      ticket("t-gone", "44444444-4444-4444-8444-444444444444"),
      ticket("t-bad", "not-a-uuid"),
      ticket("t-num", 42),
      ticket("t-arch", D1, { archived_at: "2026-09-01" }),
      ticket("t-none", undefined),
    ]));
    db.hidden = { documents: (r) => r.id === D2 };
    const g = await buildOrgGraph(ORG);
    expect(g.nodes.some((x) => x.id.startsWith("req:"))).toBe(false);
    expect(g.edges.some((e) => e.b.startsWith("req:"))).toBe(false);
    expect(g.truncations.join(" ")).not.toMatch(/request/i);
  });

  it("the documents are read back as the reader, in this workspace (pageIn on documents), only for the ids requests name", async () => {
    reset(world([ticket("t1", D1)]));
    await buildOrgGraph(ORG);
    const docReads = db.calls.filter((c) => c.table === "documents" && c.method === "in");
    expect(docReads.some((c) => c.args[0] === "id" && JSON.stringify(c.args[1]) === JSON.stringify([D1]))).toBe(true);
  });

  it("a request with both a project and a source document is one node with both edges", async () => {
    reset({ ...world([ticket("t1", D1, { project_id: "p1" })]), projects: [o({ id: "p1", name: "Turnaround", status: "active" })] });
    const g = await buildOrgGraph(ORG);
    expect(g.nodes.filter((x) => x.id === "req:t1")).toHaveLength(1);
    expect(g.edges).toContainEqual(expect.objectContaining({ a: "proj:p1", b: "req:t1" }));
    expect(g.edges).toContainEqual(expect.objectContaining({ a: `doc:${D1}`, b: "req:t1" }));
  });

  it("a failing read is said as a note and draws nothing; the map still builds", async () => {
    reset(world([ticket("t1", D1)]));
    db.readError = { tickets: { code: "XX000", message: "boom" } };
    const g = await buildOrgGraph(ORG);
    expect(g.truncations.join(" ")).toMatch(/Drafting requests on documents could not be loaded/);
    expect(g.nodes.some((x) => x.id === "req:t1")).toBe(false);
  });

  it("REVIEW FIX: a readable source document left OFF the map (beyond the documents cap) draws no request node — never an unlinked orphan — and the edge is counted, not drawn", async () => {
    // assembled directly: the request names a document the rows do not carry
    const direct = assembleOrgGraph({ ...emptyGraphRows(), documents: [doc(D2, "PID-2")], documentRequests: [{ id: "t1", ticket_id: "KE-t1", title: "Request t1", status: "DRAFTING", document_id: D1 }] } as never);
    expect(direct.nodes.some((x) => x.id === "req:t1")).toBe(false);
    expect(direct.edges.some((e) => e.b === "req:t1")).toBe(false);
    // end to end: D1 is the oldest of DOC_CAP + 1 documents, so the capped read leaves it off the map; it still reads back
    const filler = Array.from({ length: GRAPH_CAPS.DOC_CAP }, (_, i) => ({ ...doc(`f${String(i).padStart(5, "0")}-0000-4000-8000-000000000000`, `F-${i}`), updated_at: "2026-10-01" }));
    reset({ ...world([ticket("t1", D1)]), documents: [{ ...doc(D1, "PID-1"), updated_at: "2020-01-01" }, ...filler] });
    const g = await buildOrgGraph(ORG);
    expect(g.nodes.some((x) => x.id === `doc:${D1}`)).toBe(false);
    expect(g.nodes.some((x) => x.id === "req:t1")).toBe(false);
    expect(g.nodes.filter((x) => x.type === "project" && x.degree === 0 && x.id.startsWith("req:"))).toEqual([]);
  });

  it("REVIEW FIX 2: where the closing prune does NOT apply (a scope keeps a member with a boundary stub), a request whose document is off the map is still never made — the edge is counted as leading off the map, not drawn as a stub on an orphan request", () => {
    // A scope in which the request would be a member: without the docsOnMap
    // guard the request node is made, its edge to the absent document becomes
    // a boundary stub (outside = 1), and the prune keeps it — an orphan.
    const scope = { ref: { kind: "unit", id: "u1" }, label: "Unit 1", complete: true, inScope: (id: string) => id.startsWith("req:"), keep: new Set<string>() };
    const g = assembleOrgGraph(
      { ...emptyGraphRows(), documents: [doc(D2, "PID-2")], documentRequests: [{ id: "t1", ticket_id: "KE-t1", title: "Request t1", status: "DRAFTING", document_id: D1 }] } as never,
      { scope } as never,
    );
    expect(g.nodes.some((x) => x.id === "req:t1")).toBe(false);
    expect(g.edges.some((e) => e.b === "req:t1")).toBe(false);
    expect(g.truncations.join(" ")).not.toMatch(/lead.* out of Unit 1/);
    expect(g.truncations.join(" ")).toMatch(/1 link leads to equipment, documents or units not on this map/);
    // REGRESSION: the same request with its document on the map is drawn, edge and all
    const on = assembleOrgGraph(
      { ...emptyGraphRows(), documents: [doc(D1, "PID-1")], documentRequests: [{ id: "t1", ticket_id: "KE-t1", title: "Request t1", status: "DRAFTING", document_id: D1 }] } as never,
    );
    expect(on.nodes.some((x) => x.id === "req:t1")).toBe(true);
    expect(on.edges).toContainEqual(expect.objectContaining({ a: `doc:${D1}`, b: "req:t1", type: "project" }));
  });

  it("REGRESSION: a map with no such request is byte-identical (no rows key, no note) — assembled directly and end to end", async () => {
    const base = { ...emptyGraphRows(), documents: [doc(D1, "PID-1")] } as never;
    expect(JSON.stringify(assembleOrgGraph({ ...(base as object), documentRequests: [] } as never))).toBe(JSON.stringify(assembleOrgGraph(base)));
    reset(world([ticket("t-none", undefined)]));
    const withTicket = await buildOrgGraph(ORG);
    reset(world([]));
    const without = await buildOrgGraph(ORG);
    expect(JSON.stringify(withTicket)).toBe(JSON.stringify(without));
  });

  it("the read is the client entry's only, keyset-paged and capped like every link table (source pins)", () => {
    const g = readFileSync(join(process.cwd(), "lib/orgGraph.ts"), "utf8");
    expect(g).toContain("const documentRequests = gate === null ? await readDocumentRequests(orgId, notes) : [];");
    expect(g).toContain(`pageRows<Row>("tickets", "id, ticket_id, title, status, archived_at, source_document_id:metadata->source_document->>id", orgId, EDGE_CAP,`);
    expect(g).toContain('cappedNote("Document request links", r)');
    expect(g).toContain('pageIn<{ id: string }>("documents", "id", orgId, "id", docIds, docIds.length + 1)');
  });
});
