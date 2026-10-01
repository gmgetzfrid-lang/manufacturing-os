// intelligence Round G (I-13) — GAP-306: a scope is a resolved id set, and
// it scopes the ASSEMBLY. The headline case: a unit whose equipment and
// paper fall outside the org-wide caps (assets ordered by tag, documents by
// recency) is invisible on the org-wide map and COMPLETE on its own map,
// with every link that leaves it counted as a stub on the node it leaves.
// Driven over helpers/graphFakeDb.ts (keyset paging, RLS-hidden rows).

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

import { buildOrgGraph, GRAPH_CAPS } from "@/lib/orgGraph";
import { computeInsights } from "@/lib/graphInsights";
import { resolveScope, parseScopeParam, formatScopeParam, scopeMembership, RESOLVE_CAP, type ResolvedScope } from "@/lib/scope";

const ORG = "org-1";
const o = <T extends Row>(r: T): T & { org_id: string } => ({ org_id: ORG, ...r });
const pad = (n: number, w = 4) => String(n).padStart(w, "0");

function reset(tables: Record<string, Row[]>) {
  db.tables = tables;
  db.missingTables = new Set(); db.missingColumns = {}; db.readError = {}; db.hidden = {};
  db.refuseWrites = new Set(); db.writeError = {}; db.rpc = {}; db.calls = []; db.seq = 0;
}

const doc = (id: string, over: Row = {}) => o({
  id, document_number: id.toUpperCase(), title: null, library_id: "L30", unit_id: null, unit_code: null,
  plant_id: null, system_id: null, collection_id: null, sheet_number: null, sheet_total: null,
  updated_at: "2026-09-15", ...over,
});
const asset = (id: string, tag: string, over: Row = {}) => o({
  id, tag, description: null, unit_code: "30", unit_id: null, plant_id: null, system_id: null,
  type_id: null, library_id: null, archived: false, ...over,
});

/** A big plant. Unit 30 alone exceeds both caps; Crude Unit (20) sorts
 *  after the asset cap (Z- tags) and before nothing on recency (2020 paper),
 *  so the org-wide map shows none of it. */
function bigPlant(): Record<string, Row[]> {
  const assets: Row[] = [];
  for (let i = 0; i < GRAPH_CAPS.ASSET_CAP + 50; i++) assets.push(asset(`a30-${pad(i)}`, `A-${pad(i)}`));
  for (let i = 0; i < 50; i++) assets.push(asset(`a20-${pad(i)}`, `Z-${pad(i, 2)}`, { unit_code: "20" }));
  const documents: Row[] = [];
  for (let i = 0; i < GRAPH_CAPS.DOC_CAP + 100; i++) documents.push(doc(`d30-${pad(i)}`, { unit_code: "30", updated_at: `2026-09-${String(10 + (i % 18)).padStart(2, "0")}` }));
  const old = { updated_at: "2020-01-01" };
  for (let i = 0; i < 10; i++) documents.push(doc(`dDec-${i}`, { unit_code: "20", ...old }));             // decoded
  for (let i = 0; i < 10; i++) documents.push(doc(`dFil-${i}`, { unit_id: "u20", ...old }));              // operational scope
  for (let i = 0; i < 5; i++) documents.push(doc(`dPin-${i}`, { library_id: "L20", collection_id: "f20", ...old }));  // pinned folder
  for (let i = 0; i < 5; i++) documents.push(doc(`dSub-${i}`, { library_id: "L20", collection_id: "f20b", ...old })); // its subfolder
  for (let i = 0; i < 10; i++) documents.push(doc(`dGov-${i}`, old));                                      // governs unit-20 equipment
  documents.push(doc("dOther", { library_id: "L20", collection_id: "fX", ...old }));                     // same library, NOT the pinned folder
  const document_assets: Row[] = [];
  for (let i = 0; i < 10; i++) document_assets.push(o({ id: `da-g${i}`, document_id: `dGov-${i}`, asset_id: `a20-${pad(i)}` }));
  // dGov-0 also governs a unit-30 exchanger: a boundary, not a member
  document_assets.push(o({ id: "da-x", document_id: "dGov-0", asset_id: "a30-0007" }));
  return {
    codebook_entries: [
      o({ id: "cb20", kind: "unit", code: "20", label: "Crude Unit", sort: 0, meta: {
        links: [{ id: "k1", label: "P&IDs", libraryId: "L20", libraryName: "Unit P&IDs", folderId: "f2000000-0000-4000-8000-000000000000", folderName: "Unit 20" }],
      } }),
      o({ id: "cb30", kind: "unit", code: "30", label: "Coker", sort: 1, meta: {} }),
    ],
    plants: [o({ id: "p1", name: "Refinery", code: null, archived: false })],
    units: [o({ id: "u20", name: "Crude", code: "U100", plant_id: "p1", codebook_code: "20", archived: false })],
    systems: [],
    collections: [
      o({ id: "f20", path_ids: ["f2000000-0000-4000-8000-000000000000"] }),
      o({ id: "f20b", path_ids: ["f2000000-0000-4000-8000-000000000000", "f20"] }),
      o({ id: "fX", path_ids: [] }),
    ],
    libraries: [o({ id: "L30", name: "Coker paper" }), o({ id: "L20", name: "Unit P&IDs" })],
    projects: [], plot_plans: [],
    documents, assets, document_assets,
    project_documents: [], document_related_resources: [], document_supersessions: [],
    entity_mentions: [], process_flows: [
      o({ id: "fl1", from_kind: "asset", from_ref: "a20-0001", to_kind: "asset", to_ref: "a30-0001", status: "confirmed" }),
    ],
    knowledge_documents: [], knowledge_libraries: [],
  };
}

// The pinned folder id in meta is a uuid (the resolver validates it); map
// the fixture's short folder ids onto it for path_ids.
function fixFolderIds(t: Record<string, Row[]>) {
  const F = "f2000000-0000-4000-8000-000000000000";
  t.collections.unshift(o({ id: F, path_ids: [] }));
  for (const d of t.documents) if (d.collection_id === "f20") d.collection_id = F;
  for (const c of t.collections) if (c.id === "f20") c.path_ids = [F];
  return t;
}

beforeEach(() => reset(fixFolderIds(bigPlant())));

describe("the scope key", () => {
  it("round-trips unit:<code> and refuses anything else", () => {
    expect(parseScopeParam("unit:20")).toEqual({ kind: "unit", code: "20" });
    expect(formatScopeParam({ kind: "unit", code: "20" })).toBe("unit:20");
    for (const bad of [null, "", "unit:", "plant:1", "unit:a b", "unit:<x>"]) expect(parseScopeParam(bad)).toBeNull();
  });
});

describe("resolveScope — containment, not hops", () => {
  it("collects the unit's equipment and paper by every persisted rule, and nothing one step past them", async () => {
    const s = await resolveScope(ORG, { kind: "unit", code: "20" });
    expect(s).toMatchObject({ label: "Crude Unit", found: true, unitCodes: ["20"], unitIds: ["u20"], plantIds: ["p1"], complete: true });
    expect(s.assets).toHaveLength(50);
    expect(s.assets.every((a) => a.startsWith("a20-"))).toBe(true);
    const docs = new Set(s.documents);
    for (const p of ["dDec-", "dFil-", "dPin-", "dSub-", "dGov-"]) {
      for (let i = 0; i < (p === "dPin-" || p === "dSub-" ? 5 : 10); i++) expect(docs.has(`${p}${i}`), `${p}${i}`).toBe(true);
    }
    expect(docs.has("dOther")).toBe(false);           // same library, another folder
    expect(docs.has("d30-0000")).toBe(false);
    expect(s.why).toEqual({ decoded: 10, filed: 10, pinned: 10, governing: 10 });
    expect(s.libraries).toEqual(["L20"]);
    // the unit-30 exchanger dGov-0 also governs is NOT pulled in
    expect(s.assets).not.toContain("a30-0007");
  });

  it("documents that only MENTION the unit's equipment, through an indexed copy, are in", async () => {
    const t = fixFolderIds(bigPlant());
    t.documents.push(doc("dMent", { updated_at: "2020-01-01" }));
    t.knowledge_documents.push(o({ id: "k1", source_document_id: "dMent" }));
    t.entity_mentions.push(o({ id: "m1", asset_id: "a20-0003", document_id: null, knowledge_document_id: "k1" }));
    reset(t);
    const s = await resolveScope(ORG, { kind: "unit", code: "20" });
    expect(s.documents).toContain("dMent");
  });

  it("a failed read marks the scope incomplete and says which rule", async () => {
    db.readError = { document_assets: { message: "statement timeout" } };
    const s = await resolveScope(ORG, { kind: "unit", code: "20" });
    expect(s.complete).toBe(false);
    expect(s.truncations.join("\n")).toMatch(/Documents tagged to its equipment could not be read \(statement timeout\) — this scope is incomplete\./);
  });

  it("before 20261138 the decode and the mapping are simply absent — said, not fatal", async () => {
    db.missingColumns = { documents: ["unit_code"], units: ["codebook_code"] };
    const s = await resolveScope(ORG, { kind: "unit", code: "20" });
    expect(s.complete).toBe(true);
    expect(s.unitIds).toEqual([]);
    expect(s.truncations.join("\n")).toMatch(/20261138\) is not applied/);
    expect(s.documents).toContain("dGov-1"); // the relation still places paper
  });

  it("a pinned folder with more subfolders than the cap marks the scope incomplete and says so (never a silent cut)", async () => {
    const t = fixFolderIds(bigPlant());
    const F = "f2000000-0000-4000-8000-000000000000";
    for (let i = 0; i <= RESOLVE_CAP; i++) t.collections.push(o({ id: `deep-${pad(i, 5)}`, path_ids: [F] }));
    reset(t);
    const s = await resolveScope(ORG, { kind: "unit", code: "20" });
    expect(s.complete).toBe(false);
    expect(s.truncations.join("\n")).toMatch(/Its pinned folders: more than 10,000 subfolders — this scope is incomplete\./);
  });

  it("an unknown unit resolves to nothing, and says so", async () => {
    const s = await resolveScope(ORG, { kind: "unit", code: "99" });
    expect(s.found).toBe(false);
    expect(s.assets).toEqual([]);
    expect(s.truncations.join("\n")).toMatch(/Unit 99 is not in the Site Codebook/);
  });
});

describe("GAP-306 acceptance 4 — scoped assembly is complete for a unit that exceeds the org-wide caps", () => {
  it("the org-wide map shows none of Crude Unit; its own map shows all of it, and only it", async () => {
    const orgWide = await buildOrgGraph(ORG);
    const owIds = new Set(orgWide.nodes.map((n) => n.id));
    expect([...owIds].filter((id) => id.startsWith("asset:a20-"))).toHaveLength(0);
    expect(owIds.has("doc:dDec-0")).toBe(false);
    expect(orgWide.truncations.join("\n")).toMatch(/equipment items by tag/);

    const g = await buildOrgGraph(ORG, { scope: { kind: "unit", code: "20" } });
    const ids = new Set(g.nodes.map((n) => n.id));
    expect([...ids].filter((id) => id.startsWith("asset:"))).toHaveLength(50);
    expect([...ids].filter((id) => id.startsWith("doc:"))).toHaveLength(40);
    expect([...ids].some((id) => id.startsWith("asset:a30-") || id.startsWith("doc:d30-") || id === "cbunit:30")).toBe(false);
    expect(ids.has("cbunit:20")).toBe(true);
    expect(ids.has("plant:p1")).toBe(true);
    expect(g.scope).toMatchObject({ ref: { kind: "unit", code: "20" }, label: "Crude Unit", complete: true });
    // no cap notice — the unit fits
    expect(g.truncations.join("\n")).not.toMatch(/most recently updated|equipment items by tag/);
  });

  it("links that leave the unit are stubs on the node they leave from — never silently hidden", async () => {
    const g = await buildOrgGraph(ORG, { scope: { kind: "unit", code: "20" } });
    const byId = new Map(g.nodes.map((n) => [n.id, n]));
    expect(byId.get("doc:dGov-0")!.outside).toBe(1);      // tagged to a unit-30 exchanger
    expect(byId.get("asset:a20-0001")!.outside).toBe(1);  // feeds a unit-30 pump
    expect(g.scope!.boundary).toBe(2);
    expect(g.truncations.join("\n")).toMatch(/2 links lead out of Crude Unit — each node shows how many leave from it\./);
    expect(g.severed).toBe(0);
  });

  it("a document the relation names but the reader cannot open is said, not drawn", async () => {
    db.hidden = { documents: (r) => r.id === "dGov-9" };
    const g = await buildOrgGraph(ORG, { scope: { kind: "unit", code: "20" } });
    expect(g.nodes.some((n) => n.id === "doc:dGov-9")).toBe(false);
    expect(g.truncations.join("\n")).toMatch(/1 document linked to Crude Unit's equipment is outside your access — not drawn\./);
    // GM-6: the scope knows a floor (the relation named it), never the whole —
    // so it makes no total or outside-access claim
    expect(g.access).toEqual({ documentsVisible: 39, documentsTotal: null, outsideAccess: null, documentsDrawn: 39, scoped: true });
  });

  it("a private drawing DECODED to the unit never enters the reader's resolution — the scoped graph claims no count and the basis never says 'all'", async () => {
    const t = fixFolderIds(bigPlant());
    for (let i = 0; i < 12; i++) t.documents.push(doc(`dPriv-${i}`, { unit_code: "20", visibility: "private", updated_at: "2020-01-01" }));
    reset(t);
    // controller: sees them
    const controller = await buildOrgGraph(ORG, { scope: { kind: "unit", code: "20" } });
    expect(controller.nodes.filter((n) => n.id.startsWith("doc:dPriv-"))).toHaveLength(12);
    // granted-nothing member: documents RLS hides them from every read, resolution included
    db.hidden = { documents: (r) => r.visibility === "private" };
    db.rpc = { documents_total_for_org: () => ({ data: 9999, error: null }) };
    const g = await buildOrgGraph(ORG, { scope: { kind: "unit", code: "20" } });
    expect(g.nodes.some((n) => n.id.startsWith("doc:dPriv-"))).toBe(false);
    expect(g.access).toEqual({ documentsVisible: 40, documentsTotal: null, outsideAccess: null, documentsDrawn: 40, scoped: true });
    expect(g.truncations.join("\n")).not.toMatch(/outside your access/); // the scope cannot know these 12
    const note = computeInsights(g.nodes, g.edges, { access: g.access }).basis.note;
    expect(note).toMatch(/^Computed on the documents in this scope that you can see — documents outside your access are not in it/);
    expect(note).not.toMatch(/every document in the org|none of the org's documents are hidden/);
  });

  it("mention coverage: a unit with paper but no filed equipment, on an org without the mention index, reads 'not installed'", async () => {
    const t = fixFolderIds(bigPlant());
    t.assets = t.assets.filter((a) => a.unit_code !== "20");
    t.document_assets = [];
    t.process_flows = [];
    reset(t);
    db.missingTables = new Set(["entity_mentions"]);
    const g = await buildOrgGraph(ORG, { scope: { kind: "unit", code: "20" } });
    expect(g.nodes.some((n) => n.type === "asset")).toBe(false);
    expect(g.nodes.some((n) => n.type === "document")).toBe(true);
    expect(g.mentionCoverage).toMatchObject({ installed: false, rows: 0 });
    db.missingTables = new Set();
    const ok = await buildOrgGraph(ORG, { scope: { kind: "unit", code: "20" } });
    expect(ok.mentionCoverage).toMatchObject({ installed: true });
  });

  it("a pre-resolved scope is accepted as is (the operating area can resolve once and hand it over)", async () => {
    const s: ResolvedScope = await resolveScope(ORG, { kind: "unit", code: "20" });
    const g = await buildOrgGraph(ORG, { scope: s });
    expect(g.nodes.filter((n) => n.type === "asset")).toHaveLength(50);
    const member = scopeMembership(s);
    expect(member("asset:a20-0000")).toBe(true);
    expect(member("asset:a30-0000")).toBe(false);
    expect(member("cbunit:20")).toBe(true);
    expect(member("lib:L20")).toBe(true);
    expect(member("proj:x")).toBe(false);
  });

  it("the scoped map reads the site structure past PostgREST's max-rows: a unit with 1,005 systems draws every one", async () => {
    const t = fixFolderIds(bigPlant());
    t.systems = Array.from({ length: 1005 }, (_, i) => o({ id: `s${pad(i)}`, name: `Sys ${i}`, code: null, unit_id: "u20", plant_id: "p1", archived: false }));
    reset(t);
    const g = await buildOrgGraph(ORG, { scope: { kind: "unit", code: "20" } });
    expect(g.nodes.filter((n) => n.id.startsWith("system:"))).toHaveLength(1005);
    expect(g.edges.filter((e) => e.a.startsWith("system:") && e.b === "cbunit:20")).toHaveLength(1005);
    // no request asked for more rows than one response carries
    for (const c of db.calls) if (c.method === "limit") expect(Number(c.args[0])).toBeLessThanOrEqual(1000);
  });
});
