// intelligence Round G (I-11) — GAP-308: the coverage report.
//
// Four working lists — agree / in the list on no sheet / on a sheet in no
// list / disagree — per unit and org-wide, re-derived from the rows on every
// read; a controlled document the caller cannot read (and its copies) never
// counts; a copy at an earlier revision never counts (GAP-309); tags from a
// knowledge upload are listed with door 'knowledge' (GAP-307).

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { newFakeDb, makeFakeSupabase, type FakeDb, type Row } from "./helpers/fakeSupabase";

vi.mock("@/lib/supabase", () => ({ supabase: {} }));

import { buildCoverage, loadCoverage, type CoverageInput } from "@/lib/bridgeCoverage";

const asset = (id: string, tag: string, unit: string | null, origin = "manual") =>
  ({ id, tag, tag_normalized: tag.toLowerCase().replace(/[^a-z0-9]/g, ""), unit_code: unit, code: null, origin });

const INPUT: CoverageInput = {
  assets: [asset("a1", "E-22", "20"), asset("a2", "V-101", "20"), asset("a3", "P-7", "20", "drawing"), asset("a4", "H-9", "25")],
  relations: [
    { document_id: "d1", asset_id: "a1", source: "drawing", sheet_label: "2002-D-10001 SHT 4" },
    { document_id: "d-hidden", asset_id: "a2", source: "manual", sheet_label: null },
  ],
  documents: [
    { id: "d1", document_number: "2002-D-10001", title: null, library_id: "lib1", unit_code: "20" },
    { id: "d2", document_number: "2502-D-1", title: null, library_id: "lib1", unit_code: "25" },
  ],
  sheetTags: [
    { knowledgeDocumentId: "k2", documentId: "d2", name: "2502-D-1.pdf", tag: "V-101", page: 3 }, // V-101 filed 20, drawing decodes 25
    { knowledgeDocumentId: "k2", documentId: "d2", name: "2502-D-1.pdf", tag: "K-5", page: 1 },
    { knowledgeDocumentId: "k-up", documentId: null, name: "upload.pdf", tag: "K-5", page: 9 },
    { knowledgeDocumentId: "k-up", documentId: null, name: "upload.pdf", tag: "NO-12", page: 9 },   // never equipment
    { knowledgeDocumentId: "k-hid", documentId: "d-hidden", name: "hidden.pdf", tag: "Z-1", page: 1 }, // not readable
  ],
  units: [{ code: "20", label: "Crude Unit" }, { code: "25", label: "DHT" }],
};

describe("buildCoverage — the four working lists", () => {
  it("org-wide: totals and every bucket is a list of rows to act on", () => {
    const r = buildCoverage(INPUT);
    expect(r.totals).toEqual({ assets: 4, onSheet: 2, onNoSheet: 2, sheetTagsWithoutAsset: 1, disagree: 1 });
    expect(r.agree.map((a) => a.tag)).toEqual(["E-22"]);
    expect(r.agree[0].where).toEqual([expect.objectContaining({ documentId: "d1", sheet: "2002-D-10001 SHT 4", via: "relation", door: "controlled" })]);
    expect(r.listOnly.map((a) => a.tag)).toEqual(["H-9", "P-7"]);
    expect(r.disagree).toEqual([expect.objectContaining({ tag: "V-101", assetUnit: "20", drawingUnits: ["25"] })]);
    expect(r.sheetOnly).toEqual([expect.objectContaining({
      tag: "K-5",
      where: [
        expect.objectContaining({ knowledgeDocumentId: "k2", door: "controlled", pages: [1] }),
        expect.objectContaining({ knowledgeDocumentId: "k-up", door: "knowledge", pages: [9], documentId: null }),
      ],
    })]);
  });
  it("an unreadable document's relation and copy never count (V-101's hidden link, Z-1)", () => {
    const r = buildCoverage(INPUT);
    expect(r.sheetOnly.some((s) => s.tag === "Z-1")).toBe(false);
    expect(r.disagree[0].where.every((w) => w.documentId !== "d-hidden")).toBe(true);
  });
  it("per unit: the unit's equipment, and the sheet-only tags of drawings decoded to it — knowledge uploads said to be org-wide only", () => {
    const r = buildCoverage({ ...INPUT, unitCode: "25" });
    expect(r.scope).toEqual({ unitCode: "25", label: "DHT" });
    expect(r.totals.assets).toBe(1);
    expect(r.listOnly.map((a) => a.tag)).toEqual(["H-9"]);
    expect(r.sheetOnly.map((s) => [s.tag, s.unitHint])).toEqual([["K-5", "25"]]);
    expect(r.notes.join(" ")).toMatch(/listed org-wide only/);
  });
  it("is re-derived — the same rows give the same report; a new relation moves an asset from list-only to agree", () => {
    const a = buildCoverage(INPUT);
    expect(buildCoverage(INPUT)).toEqual(a);
    const b = buildCoverage({ ...INPUT, relations: [...INPUT.relations, { document_id: "d1", asset_id: "a3", source: "drawing", sheet_label: "2002-D-10001 SHT 4" }] });
    expect(b.listOnly.map((x) => x.tag)).toEqual(["H-9"]);
    expect(b.agree.map((x) => x.tag)).toEqual(["E-22", "P-7"]);
  });
});

describe("loadCoverage — read with the service role, filtered per caller", () => {
  let db: FakeDb;
  beforeEach(() => {
    db = newFakeDb();
    db.tables = {
      codebook_entries: [{ id: "u20", org_id: "o1", kind: "unit", code: "20", label: "Crude Unit", meta: {}, sort: 0 }],
      codebook_config: [],
      assets: [
        { id: "a1", org_id: "o1", tag: "E-22", tag_normalized: "e22", unit_code: "20", code: null, origin: "manual", archived: false },
        { id: "a9", org_id: "o1", tag: "E-99", tag_normalized: "e99", unit_code: "20", code: null, origin: "manual", archived: true },
      ],
      knowledge_documents: [
        { id: "k1", org_id: "o1", name: "a.pdf", source_document_id: "d1", source_version_id: "v2", status: "ready" },
        { id: "k-old", org_id: "o1", name: "a-old.pdf", source_document_id: "d1", source_version_id: "v1", status: "ready" },
        { id: "k-hid", org_id: "o1", name: "h.pdf", source_document_id: "d-hid", source_version_id: null, status: "ready" },
        { id: "k-up", org_id: "o1", name: "up.pdf", source_document_id: null, source_version_id: null, status: "ready" },
      ],
      document_assets: [{ id: "r1", org_id: "o1", document_id: "d1", asset_id: "a1", source: "drawing", sheet_label: "SHT 4" }],
      documents: [
        { id: "d1", org_id: "o1", document_number: "2002-D-1", title: null, library_id: "lib1", unit_code: "20", current_version_id: "v2", status: "Issued" },
        { id: "d-hid", org_id: "o1", document_number: "SECRET", title: null, library_id: "lib1", unit_code: "20", current_version_id: null, status: "Issued" },
      ],
      knowledge_page_entities: [
        { id: "e1", document_id: "k1", page: 1, kind: "equipment", tag: "E-22" },
        { id: "e2", document_id: "k-old", page: 1, kind: "equipment", tag: "X-1" },   // an earlier revision's copy
        { id: "e3", document_id: "k-hid", page: 1, kind: "equipment", tag: "Y-1" },   // a document the caller cannot read
        { id: "e4", document_id: "k-up", page: 2, kind: "equipment", tag: "K-5" },
        { id: "e5", document_id: "k1", page: 1, kind: "self", tag: "2002-D-1" },        // never read as a tag
      ],
    };
  });
  it("only the current copy of a readable document and knowledge uploads count; archived equipment is not listed", async () => {
    const report = await loadCoverage(makeFakeSupabase(db) as unknown as SupabaseClient, "o1", {
      unitCode: null, canRead: async (ids) => new Set(ids.filter((i) => i !== "d-hid")),
    });
    expect(report.totals).toMatchObject({ assets: 1, onSheet: 1, onNoSheet: 0, sheetTagsWithoutAsset: 1 });
    expect(report.sheetOnly.map((s) => [s.tag, s.where[0].door])).toEqual([["K-5", "knowledge"]]);
    expect(report.notes.join(" ")).toMatch(/1 document you cannot read is left out/);
  });
  it("a caller who can read nothing controlled still sees the knowledge uploads — and no relation", async () => {
    const report = await loadCoverage(makeFakeSupabase(db) as unknown as SupabaseClient, "o1", { unitCode: null, canRead: async () => new Set() });
    expect(report.agree).toEqual([]);
    expect(report.listOnly.map((a) => a.tag)).toEqual(["E-22"]);
    expect(report.sheetOnly.map((s) => s.tag).sort()).toEqual(["K-5"]);
  });
  it("names its kinds when it reads the entity index (the census rule)", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("lib/bridgeCoverage.ts", "utf8");
    expect(src).toMatch(/from\("knowledge_page_entities"\)\.select\("id, document_id, tag, page"\)\s*\n\s*\.in\("document_id", slice\)\.in\("kind", \["equipment"\]\)/);
  });
});

describe("the report is reachable from the sweep, and mounts on its own", () => {
  it("EquipmentSweepModal opens CoverageReport; the component POSTs action 'coverage' and 'discover'", async () => {
    const { readFileSync } = await import("node:fs");
    const modal = readFileSync("components/documents/EquipmentSweepModal.tsx", "utf8");
    expect(modal).toMatch(/<CoverageReport orgId=\{orgId\}/);
    const comp = readFileSync("components/assets/CoverageReport.tsx", "utf8");
    expect(comp).toMatch(/action: "coverage"/);
    expect(comp).toMatch(/action: "discover"/);
    void ({} as Row);
  });
});
