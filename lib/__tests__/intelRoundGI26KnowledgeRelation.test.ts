// intelligence Round G I-26 — GAP-307 acceptance 3: a knowledge upload gets a
// relation of its own (knowledge_document_assets, 20261235).
//
//   * the knowledge door (discoverFromKnowledge) relates every named tag that
//     reached an asset — discovered now or already in the registry — to the
//     upload, with the sheet address of its pages (GAP-301) and document_
//     assets' provenance (a machine's reading; the transcribing model, GOV-9;
//     the revision the upload carried); a repeat is one row per pair;
//   * REGRESSION: before 20261235 (42P01 / PGRST205) the discovery is exactly
//     today's — the same assets, the same audit row — and says the links need
//     that file; a refused write is said, never thrown;
//   * the coverage report reads the relation for an upload (via 'relation',
//     door 'knowledge') and folds the upload's extracted rows into it; with no
//     relation (before 20261235, or a failed read — said) the upload's sheets
//     are the extracted working list, as before.
// The runtime policy and refusals are on the replayed PostgreSQL 16:
// lib/__tests__/rls/intelI26BridgeRemainders.test.ts.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { newFakeDb, makeFakeSupabase, type FakeDb, type Row } from "./helpers/fakeSupabase";

vi.mock("@/lib/unitCodeDecode", () => ({ decodeDocumentUnitCodes: async () => ({ results: [], notApplied: false }) }));
vi.mock("@/lib/supabase", () => ({ supabase: {} }));

import { discoverFromKnowledge, KNOWLEDGE_RELATION_NEEDS_MIGRATION } from "@/lib/equipmentBridgeServer";
import { buildCoverage, loadCoverage, type CoverageInput } from "@/lib/bridgeCoverage";

let db: FakeDb;
const admin = () => makeFakeSupabase(db) as unknown as SupabaseClient;
const rel = () => (db.tables.knowledge_document_assets ?? []) as Row[];
const audit = (action: string) => (db.tables.audit_logs ?? []).filter((l) => l.action === action);

function seed() {
  db.tables = {
    codebook_entries: [
      { id: "et-p", org_id: "o1", kind: "equipment_type", code: "50", label: "Pumps", meta: { tagPrefixes: ["P"] }, sort: 0, origin: "manual" },
      { id: "et-e", org_id: "o1", kind: "equipment_type", code: "30", label: "Exchangers", meta: { tagPrefixes: ["E"] }, sort: 0, origin: "manual" },
    ],
    codebook_config: [],
    knowledge_documents: [
      { id: "k-up", org_id: "o1", library_id: "kl1", name: "upload.pdf", source_document_id: null, status: "ready", source_rev: "C" },
    ],
    knowledge_page_entities: [
      { id: "u1", document_id: "k-up", page: 3, kind: "equipment", tag: "P-44", raw: "P-44" },
      { id: "u2", document_id: "k-up", page: 3, kind: "equipment", tag: "E-22", raw: "E-22" },
      { id: "u3", document_id: "k-up", page: 4, kind: "equipment", tag: "E-22", raw: "E-22" },
      { id: "u4", document_id: "k-up", page: 3, kind: "self", tag: "25-PID-0101-SH3", raw: "DWG 25-PID-0101 SH 3 REV C" },
      { id: "u5", document_id: "k-up", page: 4, kind: "self", tag: "25-PID-0101-SH4", raw: "DWG 25-PID-0101 SH 4 REV C" },
    ],
    // page 4 was transcribed by an AI model (20261122)
    knowledge_chunks: [{ id: "c4", document_id: "k-up", page: 4, source: "vision", source_model: "vision-model-x" }],
    assets: [{ id: "a-e22", org_id: "o1", tag: "E-22", tag_normalized: "e22", unit_code: "20", code: null, archived: false, origin: "manual" }],
    asset_types: [],
    knowledge_document_assets: [],
    audit_logs: [],
  };
  db.unique = { assets: [["org_id", "tag_normalized"]], knowledge_document_assets: [["knowledge_document_id", "asset_id"]] };
}

beforeEach(() => { db = newFakeDb(); seed(); });

describe("GAP-307 acceptance 3 — the knowledge door writes the upload's own relation", () => {
  it("a discovered tag and one already in the registry are each related to the upload: sheet, pages, a machine's reading, the model, the revision", async () => {
    const r = await discoverFromKnowledge(admin(), { orgId: "o1", userId: "u1", knowledgeDocumentId: "k-up", tags: ["P-44", "E-22"] });
    expect(r).toMatchObject({ created: ["P-44"], existing: ["E-22"], relations: { written: 2, notRecorded: null } });
    const p44 = db.tables.assets.find((a) => a.tag === "P-44")!;
    const byAsset = new Map(rel().map((x) => [x.asset_id, x]));
    expect(byAsset.get(p44.id)).toMatchObject({
      org_id: "o1", knowledge_document_id: "k-up", tag_text: "P-44", source: "drawing", asserted_by: "machine",
      sheet_label: "25-PID-0101 SHT 3", pages: [3], model: null, source_revision: "C",
    });
    // E-22 is on page 3 (text layer) and page 4 (an AI transcription): the model is named
    expect(byAsset.get("a-e22")).toMatchObject({ sheet_label: "25-PID-0101 SHT 3, SHT 4", pages: [3, 4], model: "vision-model-x", asserted_by: "machine" });
    expect(audit("EQUIPMENT_BRIDGE_DISCOVERED")[0].details).toMatchObject({ door: "knowledge", relationsWritten: 2 });
  });

  it("discovering again keeps one row per pair (the upsert refreshes it)", async () => {
    await discoverFromKnowledge(admin(), { orgId: "o1", userId: "u1", knowledgeDocumentId: "k-up", tags: ["P-44", "E-22"] });
    const again = await discoverFromKnowledge(admin(), { orgId: "o1", userId: "u1", knowledgeDocumentId: "k-up", tags: ["P-44", "E-22"] });
    expect(again).toMatchObject({ created: [], existing: ["P-44", "E-22"] });
    expect(rel()).toHaveLength(2);
  });

  it("an unreadable AI-vision record fails toward the warning: the model reads 'unknown', never the text layer", async () => {
    db.selectErrors = { knowledge_chunks: { code: "57014", message: "canceling statement due to statement timeout" } };
    await discoverFromKnowledge(admin(), { orgId: "o1", userId: "u1", knowledgeDocumentId: "k-up", tags: ["P-44"] });
    expect(rel()[0]).toMatchObject({ model: "unknown" });
  });

  it("REGRESSION — before 20261235 the discovery is today's (same assets, same audit row) and says the links need that file; nothing throws", async () => {
    db.beforeInsert = { knowledge_document_assets: () => { throw { code: "42P01", message: 'relation "public.knowledge_document_assets" does not exist' }; } };
    const r = await discoverFromKnowledge(admin(), { orgId: "o1", userId: "u1", knowledgeDocumentId: "k-up", tags: ["P-44", "E-22"] });
    expect(r).toMatchObject({ created: ["P-44"], existing: ["E-22"], held: [], unitless: 1 });
    expect(r.relations).toEqual({ written: 0, notRecorded: KNOWLEDGE_RELATION_NEEDS_MIGRATION });
    expect(db.tables.assets.find((a) => a.tag === "P-44")).toMatchObject({
      unit_code: null, origin: "drawing", discovered_from: { knowledgeDocumentId: "k-up", pages: [3], door: "knowledge" },
    });
    expect(audit("EQUIPMENT_BRIDGE_DISCOVERED")).toHaveLength(1);
    // PostgREST's own name for a table it cannot find
    db.beforeInsert = { knowledge_document_assets: () => { throw { code: "PGRST205", message: "Could not find the table 'public.knowledge_document_assets' in the schema cache" }; } };
    const r2 = await discoverFromKnowledge(admin(), { orgId: "o1", userId: "u1", knowledgeDocumentId: "k-up", tags: ["P-44"] });
    expect(r2.relations.notRecorded).toBe(KNOWLEDGE_RELATION_NEEDS_MIGRATION);
  });

  it("REGRESSION (review, IRLS-12 residual): a missing COLUMN on the relation's write (42703, INSERT-shaped 'column \"x\" of relation \"y\" does not exist') is said as the real error — never 'recorded once migration 20261235 is applied'", async () => {
    const msg = 'column "sheet_label" of relation "knowledge_document_assets" does not exist';
    for (const err of [{ code: "42703", message: msg }, { message: msg }, { code: "PGRST204", message: "Could not find the 'sheet_label' column of 'knowledge_document_assets' in the schema cache" }]) {
      db.beforeInsert = { knowledge_document_assets: () => { throw err; } };
      const r = await discoverFromKnowledge(admin(), { orgId: "o1", userId: "u1", knowledgeDocumentId: "k-up", tags: ["P-44"] });
      expect(r.relations.written).toBe(0);
      expect(r.relations.notRecorded).not.toBe(KNOWLEDGE_RELATION_NEEDS_MIGRATION);
      expect(r.relations.notRecorded).toMatch(/could not be recorded: /);
    }
  });

  it("a refused relation write is said with the database's reason; the discovered equipment stands", async () => {
    db.beforeInsert = { knowledge_document_assets: () => { throw { code: "23503", message: "knowledge_document_assets: the asset is not in this workspace" }; } };
    const r = await discoverFromKnowledge(admin(), { orgId: "o1", userId: "u1", knowledgeDocumentId: "k-up", tags: ["P-44"] });
    expect(r.created).toEqual(["P-44"]);
    expect(r.relations.written).toBe(0);
    expect(r.relations.notRecorded).toMatch(/could not be recorded: knowledge_document_assets: the asset is not in this workspace/);
    expect(db.tables.assets.some((a) => a.tag === "P-44")).toBe(true);
  });
});

describe("GAP-307 acceptance 3 — the coverage report reads the upload's relation", () => {
  const base: CoverageInput = {
    assets: [{ id: "a-e22", tag: "E-22", tag_normalized: "e22", unit_code: null, code: null, origin: "drawing" }],
    relations: [], documents: [],
    sheetTags: [
      { knowledgeDocumentId: "k-up", documentId: null, name: "upload.pdf", tag: "E-22", page: 3 },
      { knowledgeDocumentId: "k-up", documentId: null, name: "upload.pdf", tag: "E-22", page: 5 },
      { knowledgeDocumentId: "k-up", documentId: null, name: "upload.pdf", tag: "K-9", page: 5 },
    ],
    units: [],
  };
  it("with the relation: one 'relation' place on the upload, its extracted pages folded in, the sheet and its AI-read mark carried", () => {
    const r = buildCoverage({ ...base, knowledgeRelations: [{ knowledge_document_id: "k-up", asset_id: "a-e22", name: "upload.pdf", sheet_label: "25-PID-0101 SHT 3", pages: [3], model: "vision-model-x" }] });
    expect(r.agree).toHaveLength(1);
    expect(r.agree[0].where).toEqual([{
      documentId: null, knowledgeDocumentId: "k-up", name: "upload.pdf", sheet: "25-PID-0101 SHT 3", aiRead: true,
      pages: [3, 5], via: "relation", door: "knowledge", libraryId: null,
    }]);
    expect(r.sheetOnly.map((s) => s.tag)).toEqual(["K-9"]);
  });
  it("REGRESSION — with no relation the upload's sheets are the extracted working list, exactly as before", () => {
    const r = buildCoverage(base);
    expect(r.agree[0].where).toEqual([{
      documentId: null, knowledgeDocumentId: "k-up", name: "upload.pdf", sheet: null, pages: [3, 5], via: "extracted", door: "knowledge", libraryId: null,
    }]);
  });

  function loadSeed() {
    db.tables = {
      codebook_entries: [], codebook_config: [],
      assets: [{ id: "a-e22", org_id: "o1", tag: "E-22", tag_normalized: "e22", unit_code: null, code: null, origin: "drawing", archived: false }],
      knowledge_documents: [
        { id: "k-up", org_id: "o1", name: "upload.pdf", source_document_id: null, source_version_id: null, status: "ready" },
        { id: "k-mirror", org_id: "o1", name: "mirror.pdf", source_document_id: "d-hid", source_version_id: null, status: "ready" },
      ],
      document_assets: [], documents: [],
      knowledge_page_entities: [{ id: "e1", document_id: "k-up", page: 3, kind: "equipment", tag: "E-22" }],
      knowledge_document_assets: [
        { id: "r1", org_id: "o1", knowledge_document_id: "k-up", asset_id: "a-e22", sheet_label: "SHT 3", pages: [3], model: null },
        // a mirror's row never counts here: only an upload's (DEC-83)
        { id: "r2", org_id: "o1", knowledge_document_id: "k-mirror", asset_id: "a-e22", sheet_label: "SECRET SHT", pages: [1], model: null },
      ],
    };
  }
  it("loadCoverage reads knowledge_document_assets for the uploads that count (never a mirror's row)", async () => {
    loadSeed();
    const r = await loadCoverage(admin(), "o1", { unitCode: null, canRead: async () => new Set() });
    expect(r.agree[0].where).toEqual([expect.objectContaining({ via: "relation", door: "knowledge", sheet: "SHT 3", pages: [3] })]);
    expect(JSON.stringify(r)).not.toContain("SECRET SHT");
  });
  it("REGRESSION — before 20261235 (42P01) nothing is said and the working list stands; any other failed read is said and the working list stands", async () => {
    loadSeed();
    db.selectErrors = { knowledge_document_assets: { code: "42P01", message: 'relation "public.knowledge_document_assets" does not exist' } };
    const before = await loadCoverage(admin(), "o1", { unitCode: null, canRead: async () => new Set() });
    expect(before.agree[0].where).toEqual([expect.objectContaining({ via: "extracted", door: "knowledge", pages: [3] })]);
    expect(before.notes.join(" ")).not.toMatch(/links could not be read/);
    db.selectErrors = { knowledge_document_assets: { code: "57014", message: "statement timeout" } };
    const failed = await loadCoverage(admin(), "o1", { unitCode: null, canRead: async () => new Set() });
    expect(failed.agree[0].where).toEqual([expect.objectContaining({ via: "extracted" })]);
    expect(failed.notes.join(" ")).toMatch(/The knowledge uploads' links could not be read \(statement timeout\)/);
    // a missing COLUMN (42703) is a real error, never "before 20261235"
    db.selectErrors = { knowledge_document_assets: { code: "42703", message: "column knowledge_document_assets.sheet_label does not exist" } };
    const drifted = await loadCoverage(admin(), "o1", { unitCode: null, canRead: async () => new Set() });
    expect(drifted.notes.join(" ")).toMatch(/The knowledge uploads' links could not be read \(column knowledge_document_assets\.sheet_label does not exist\)/);
  });
});
