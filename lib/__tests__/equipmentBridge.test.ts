// intelligence Round G (I-11) — THE BRIDGE & THE MEMORY, the library half.
//
// Driven end to end against the in-memory stand-in (helpers/fakeSupabase):
//   * GAP-301 / BR-10 — the sheet address: kind 'self' rows → "2002-D-10001
//     SHT 4" on every suggestion, the revision it was read from, an AI-read
//     title block marked unconfirmed (GOV-9's sheet-address limb).
//   * GAP-304 / WIRE-1 / BR-2 — apply writes a document_assets row (source
//     'drawing', sheet, pages, provenance) AND keeps the metadata column
//     write; re-running is idempotent; a degraded insert says what it
//     dropped; a database without 20261170 / 20261171 keeps today's behaviour
//     and says so.
//   * GAP-302 — a 'drawing' row survives an unrelated asset_tags edit
//     (documents_resync_assets transcribed and pinned to its SQL).
//   * AREA-4 / BR-3 / GAP-307 — discovery with no column mapped; an upload-
//     origin knowledge document is said, and its tags enter through the
//     knowledge door, unit-less and reported.
//   * BR-5 / BR-9 / BR-13 / BR-14 / BR-7 / BR-8 / CB-1 / CB-2 / GAP-309.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { newFakeDb, makeFakeSupabase, type FakeDb, type Row } from "./helpers/fakeSupabase";

const decode = vi.hoisted(() => ({ calls: [] as Array<{ orgId: string; documentIds: string[] }> }));
vi.mock("@/lib/unitCodeDecode", () => ({
  decodeDocumentUnitCodes: async (input: { orgId: string; documentIds: string[] }) => {
    decode.calls.push(input);
    return { results: [], notApplied: false };
  },
}));
// lib/codebook.ts imports the browser client at module load; the Bridge only
// uses its pure codec, so the client is a stand-in that is never called.
vi.mock("@/lib/supabase", () => ({ supabase: {} }));

import {
  computeForDocument, computeForKnowledgeDoc, applyForDocument, dismissForDocument, reviewVanished,
  discoverFromKnowledge, parseSelfRaw, sheetAddressForPage, sheetText, relationSheetLabel,
  passesExtractorGate, heldForUnknownPrefix, locateUnit, planDismissals, autoApplyActs,
  type BridgeSuggestion,
} from "@/lib/equipmentBridgeServer";
import { EMPTY_CODEBOOK, tagKey, normalizeTag, type Codebook, type CodebookEntry } from "@/lib/codebook";

const repo = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

let db: FakeDb;
const admin = () => makeFakeSupabase(db) as unknown as SupabaseClient;

const entry = (kind: CodebookEntry["kind"], code: string, label: string, tagPrefixes?: string[]): Row =>
  ({ id: `${kind}-${code}`, org_id: "o1", kind, code, label, meta: tagPrefixes ? { tagPrefixes } : {}, sort: 0, origin: "manual" });

const SEGMENTS = [
  { kind: "unit", digits: 2 }, { kind: "drawing_type", digits: 2 }, { kind: "size", letters: 1 },
  { kind: "iterable" }, { kind: "sheet" },
];

/** The refinery as taught: units 20/25, types V·D / E / P, drawings like
 *  2002-D-10001 SHT 4. */
function seed(opts: { bridge?: Record<string, unknown>; documentNumber?: string | null; twins?: Row[]; entities?: Row[] } = {}) {
  db.tables = {
    codebook_entries: [
      entry("unit", "20", "Crude Unit"), entry("unit", "25", "DHT"),
      entry("equipment_type", "10", "Vessels", ["V", "D"]),
      entry("equipment_type", "30", "Exchangers", ["E"]),
      entry("equipment_type", "50", "Pumps", ["P"]),
      entry("drawing_type", "02", "P&ID"),
    ],
    codebook_config: [{ org_id: "o1", drawing_number: { segments: SEGMENTS }, iterable_rule: { mirrorsTag: true, padTo: 0 } }],
    libraries: [{ id: "lib1", org_id: "o1", equipment_bridge: opts.bridge ?? { targetColumnKey: "equipment" } }],
    documents: [{
      id: "d1", org_id: "o1", library_id: "lib1", document_number: opts.documentNumber === undefined ? "2002-D-10001" : opts.documentNumber,
      title: "Crude charge P&ID", name: "2024-Vessel-List.pdf", metadata: {}, current_version_id: "v2", created_by: "u-uploader", status: "Issued",
    }],
    knowledge_documents: opts.twins ?? [{
      id: "k1", org_id: "o1", library_id: "kl1", name: "2024-Vessel-List.pdf", source_document_id: "d1",
      status: "ready", source_version_id: "v2", source_rev: "B", vision_failed_pages: [],
    }],
    knowledge_page_entities: opts.entities ?? [
      { id: "e01", document_id: "k1", page: 1, kind: "equipment", tag: "E-22", raw: "E-22" },
      { id: "e02", document_id: "k1", page: 1, kind: "equipment", tag: "V-101", raw: "V-101" },
      { id: "e03", document_id: "k1", page: 2, kind: "equipment", tag: "V-101", raw: "V-101" },
      { id: "e04", document_id: "k1", page: 2, kind: "equipment", tag: "P-7", raw: "P-7" },
      { id: "e05", document_id: "k1", page: 1, kind: "self", tag: "2002-D-10001", raw: "DWG 2002-D-10001 SH 4 REV B" },
      { id: "e06", document_id: "k1", page: 1, kind: "self", tag: "2002-D-10001-SH4", raw: "DWG 2002-D-10001 SH 4 REV B" },
      { id: "e07", document_id: "k1", page: 2, kind: "self", tag: "2002-D-10001-SH5", raw: "DWG 2002-D-10001 SH 5 REV B" },
    ],
    // Page 2's text was an AI model's transcription (GOV-9, 20261122).
    knowledge_chunks: [{ id: "c1", document_id: "k1", page: 2, source: "vision", source_model: "vision-model-x" }],
    assets: [
      { id: "a-e22", org_id: "o1", tag: "E-22", tag_normalized: "e22", unit_code: "20", code: "2030.22", archived: false, origin: "manual" },
      // BR-7: filed to a unit by hand, no site code yet.
      { id: "a-v101", org_id: "o1", tag: "V-101", tag_normalized: "v101", unit_code: "20", code: null, archived: false, origin: "manual" },
    ],
    asset_types: [],
    document_equipment_suggestions: [],
    document_assets: [],
    audit_logs: [],
  };
  db.unique = { assets: [["org_id", "tag_normalized"]], document_assets: [["document_id", "asset_id"]] };
}

const ledger = () => db.tables.document_equipment_suggestions[0] as Row & { suggested: Array<BridgeSuggestion & Row>; applied: string[] };
const relations = () => db.tables.document_assets as Row[];
const audit = (action: string) => (db.tables.audit_logs ?? []).filter((l) => l.action === action);

beforeEach(() => {
  db = newFakeDb();
  decode.calls = [];
});

// ─── Pure helpers ───────────────────────────────────────────────────────────

describe("GAP-301 — the sheet address, from the title block (kind 'self')", () => {
  it("given a page's self rows the system returns the site sheet address and the revision it declares", () => {
    expect(parseSelfRaw("DWG 2002-D-10001 SH 4 REV B")).toEqual({ drawingNumber: "2002-D-10001", sheet: "4", rev: "B" });
    expect(parseSelfRaw("DWG 2002-D-10001")).toEqual({ drawingNumber: "2002-D-10001", sheet: null, rev: null });
    expect(parseSelfRaw("not a title block")).toEqual({ drawingNumber: null, sheet: null, rev: null });
    const s = sheetAddressForPage(1, [
      { tag: "2002-D-10001", raw: "DWG 2002-D-10001 SH 4 REV B" },
      { tag: "2002-D-10001-SH4", raw: "DWG 2002-D-10001 SH 4 REV B" },
    ], false);
    expect(s).toEqual({ page: 1, label: "2002-D-10001 SHT 4", drawingNumber: "2002-D-10001", sheet: "4", rev: "B", aiRead: false });
    // A page that declared nothing is a page, and says so (BR-10).
    expect(sheetText(sheetAddressForPage(3, [], false))).toBe("page 3 (no title block read)");
  });
  it("GOV-9: a title block read off an AI transcription is shown as unconfirmed, never as an identity", () => {
    const s = sheetAddressForPage(2, [{ tag: "2002-D-10001-SH5", raw: "DWG 2002-D-10001 SH 5 REV B" }], true);
    expect(sheetText(s)).toBe("2002-D-10001 SHT 5 (AI-read, unconfirmed)");
  });
  it("the stored sheet_label names every sheet once, in page order", () => {
    expect(relationSheetLabel([
      { page: 2, label: "2002-D-10001 SHT 5", drawingNumber: "2002-D-10001", sheet: "5", rev: "B", aiRead: true },
      { page: 1, label: "2002-D-10001 SHT 4", drawingNumber: "2002-D-10001", sheet: "4", rev: "B", aiRead: false },
    ])).toBe("2002-D-10001 SHT 4, SHT 5");
    expect(relationSheetLabel([{ page: 1, label: null, drawingNumber: null, sheet: null, rev: null, aiRead: false }])).toBeNull();
  });
});

describe("BR-13 — the extractor's vocabulary at the registry boundary, and the codebook's prefixes", () => {
  it("re-applies the extractor's stop list and drawing-number guard", () => {
    expect(passesExtractorGate("E-22")).toBe(true);
    expect(passesExtractorGate("NO-12")).toBe(false);   // stop-listed prefix
    expect(passesExtractorGate("SHT-4")).toBe(false);
    expect(passesExtractorGate("REV-3")).toBe(false);
  });
  it("holds a NEW tag whose prefix no equipment type claims — once the codebook knows prefixes at all", () => {
    const book: Codebook = { ...EMPTY_CODEBOOK, equipmentTypes: [{ id: "t", kind: "equipment_type", code: "30", label: "Exchangers", meta: { tagPrefixes: ["E"] }, sort: 0, origin: "manual" }] };
    expect(heldForUnknownPrefix("CL-150", book)).toBe(true);
    expect(heldForUnknownPrefix("E-22", book)).toBe(false);
    expect(heldForUnknownPrefix("CL-150", EMPTY_CODEBOOK)).toBe(false); // no opinion: today's behaviour
  });
});

describe("CB-1 — the unit comes from the document's own number, held by the codebook, never a filename", () => {
  const book: Codebook = {
    ...EMPTY_CODEBOOK,
    units: [{ id: "u", kind: "unit", code: "20", label: "Crude Unit", meta: {}, sort: 0, origin: "manual" }],
    drawingTypes: [{ id: "dt", kind: "drawing_type", code: "02", label: "P&ID", meta: {}, sort: 0, origin: "manual" }],
    drawingNumber: { segments: SEGMENTS as Codebook["drawingNumber"] extends infer T ? T extends { segments: infer S } ? S : never : never },
  };
  it("decodes the document number to a unit the codebook holds", () => {
    expect(locateUnit("2002-D-10001", null, book)).toEqual({ unitCode: "20", source: "document_number", rejected: null });
  });
  it("reports a decoded unit the codebook does not hold and files to no unit (or to a held library default)", () => {
    expect(locateUnit("1202-D-1", null, book)).toEqual({ unitCode: null, source: null, rejected: "12" });
    expect(locateUnit("1202-D-1", "20", book)).toEqual({ unitCode: "20", source: "library_default", rejected: "12" });
    expect(locateUnit(null, "77", book)).toEqual({ unitCode: null, source: null, rejected: "77" });
  });
  it("a blank number never falls through to a filename", () => {
    // The verifier's own case: "2024-Vessel-List.pdf" decodes to unit 20 —
    // locateUnit is never handed it.
    expect(locateUnit("", null, book)).toEqual({ unitCode: null, source: null, rejected: null });
    expect(repo("lib/equipmentBridgeServer.ts")).not.toMatch(/numberCandidates/);
  });
});

describe("BR-9 — dismissals are remembered; a later revision that brings a tag back re-proposes it", () => {
  const d = { tag: "CL-150", by: "u1", at: "t0", via: "review" as const, revision: "v1" };
  it("a tag still read stays dismissed; a tag no longer read is marked absent on this revision", () => {
    expect(planDismissals({ existing: [d], presentTags: new Set(["CL-150"]), revision: "v1", now: "t1" }))
      .toEqual({ dismissed: [{ ...d, absentSince: null }], lapsed: [] });
    expect(planDismissals({ existing: [d], presentTags: new Set(), revision: "v2", now: "t1" }).dismissed[0].absentSince).toBe("v2");
  });
  it("brought back by a LATER revision → re-proposed; read again on the revision it went missing on → still dismissed", () => {
    const absent = { ...d, absentSince: "v2" };
    expect(planDismissals({ existing: [absent], presentTags: new Set(["CL-150"]), revision: "v3", now: "t1" }).lapsed).toEqual(["CL-150"]);
    expect(planDismissals({ existing: [absent], presentTags: new Set(["CL-150"]), revision: "v2", now: "t1" }))
      .toEqual({ dismissed: [{ ...d, absentSince: null }], lapsed: [] });
  });
  it("auto-apply acts with a mapped column (as before), or with none once a person reviewed the library", () => {
    expect(autoApplyActs({ autoApply: true, targetColumnKey: "equipment" })).toBe(true);
    expect(autoApplyActs({ autoApply: true })).toBe(false);
    expect(autoApplyActs({ autoApply: true, reviewedAt: "t" })).toBe(true);
    expect(autoApplyActs({ autoApply: false, targetColumnKey: "equipment" })).toBe(false);
  });
});

// ─── Compute ────────────────────────────────────────────────────────────────

describe("compute — the sheet address on every suggestion, the unit from the number, the revision recorded", () => {
  it("GAP-301 end to end: kind 'self' rows → each suggestion carries its sheets; an AI-transcribed page is marked", async () => {
    seed();
    const r = await computeForDocument(admin(), "o1", "d1");
    expect(r.reason).toBe("computed");
    const v101 = r.suggestions.find((s) => s.tag === "V-101")!;
    expect(v101.pages).toEqual([1, 2]);
    expect(v101.sheets!.map((s) => [s.label, s.rev, s.aiRead])).toEqual([
      ["2002-D-10001 SHT 4", "B", false],
      ["2002-D-10001 SHT 5", "B", true],
    ]);
    expect(v101.model).toBe("vision-model-x");
    expect(r.suggestions.find((s) => s.tag === "E-22")!.model).toBeNull();
    // Stored on the proposal, with the unit and where it came from.
    const stored = ledger().suggested.find((s) => s.tag === "P-7")!;
    expect(stored).toMatchObject({ unitCode: "20", unitSource: "document_number", unitRejected: null, code: "2050.7", assetStatus: "new" });
    // The proposal records which copy it came from and its revision (BR-14 / GAP-301 acceptance 3).
    expect(ledger().sources).toEqual([{ knowledgeDocumentId: "k1", status: "ready", sourceVersionId: "v2", sourceRev: "B", used: true }]);
  });

  it("CB-1: a blank document number is NOT decoded from the filename '2024-Vessel-List.pdf' (which would read unit 20)", async () => {
    seed({ documentNumber: null, bridge: { targetColumnKey: "equipment" } });
    const r = await computeForDocument(admin(), "o1", "d1");
    expect(r.unitCode).toBeNull();
    expect(r.suggestions.every((s) => s.code === null)).toBe(true);
    seed({ documentNumber: null, bridge: { targetColumnKey: "equipment", defaultUnitCode: "25" } });
    expect((await computeForDocument(admin(), "o1", "d1")).unitCode).toBe("25");
    seed({ documentNumber: "1202-D-1", bridge: {} });
    const rej = await computeForDocument(admin(), "o1", "d1");
    expect(rej).toMatchObject({ unitCode: null, unitRejected: "12" });
  });

  it("BR-3: an upload-origin knowledge document is said, distinguishable from 'swept, nothing found'", async () => {
    seed();
    db.tables.knowledge_documents.push({ id: "k-up", org_id: "o1", library_id: "kl1", name: "upload.pdf", source_document_id: null, status: "ready" });
    expect(await computeForKnowledgeDoc(admin(), "k-up")).toMatchObject({ reason: "upload_origin", documentId: null, knowledgeDocumentId: "k-up" });
    db.tables.knowledge_page_entities = [];
    expect((await computeForDocument(admin(), "o1", "d1")).reason).toBe("no_entities");
  });

  it("GAP-314: at ingest the Bridge decodes the document's own unit through document-control's helper; a sweep does not", async () => {
    seed();
    await computeForKnowledgeDoc(admin(), "k1");
    expect(decode.calls).toEqual([{ orgId: "o1", documentIds: ["d1"] }]);
    await computeForDocument(admin(), "o1", "d1", { trigger: "sweep" });
    expect(decode.calls).toHaveLength(1);
  });
});

describe("BR-14 — copies of one document are merged; a copy still indexing never downgrades a complete computation", () => {
  const twinRows = (k2: Partial<Row>): Row[] => [
    { id: "k1", org_id: "o1", name: "a.pdf", source_document_id: "d1", status: "ready", source_version_id: "v2", source_rev: "B", vision_failed_pages: [] },
    { id: "k2", org_id: "o1", name: "b.pdf", source_document_id: "d1", status: "indexing", source_version_id: "v2", source_rev: "B", vision_failed_pages: [], ...k2 },
  ];
  it("reproduction → fix: the indexing copy's 1 tag never replaces the ready copy's 3; once ready, the tags are UNIONED", async () => {
    seed({ twins: twinRows({}) });
    db.tables.knowledge_page_entities.push({ id: "e90", document_id: "k2", page: 1, kind: "equipment", tag: "H-9", raw: "H-9" });
    const first = await computeForDocument(admin(), "o1", "d1");
    expect(first.suggestions.map((s) => s.tag).sort()).toEqual(["E-22", "P-7", "V-101"]);
    db.tables.knowledge_documents.find((k) => k.id === "k2")!.status = "ready";
    const merged = await computeForDocument(admin(), "o1", "d1");
    expect(merged.suggestions.map((s) => s.tag).sort()).toEqual(["E-22", "H-9", "P-7", "V-101"]);
    expect((ledger().sources as Array<{ knowledgeDocumentId: string; used: boolean }>).map((s) => [s.knowledgeDocumentId, s.used])).toEqual([["k1", true], ["k2", true]]);
  });
  it("with only a copy still indexing, the stored proposal is left exactly as it was", async () => {
    seed();
    await computeForDocument(admin(), "o1", "d1");
    const before = JSON.stringify(ledger());
    db.tables.knowledge_documents[0].status = "indexing";
    expect((await computeForDocument(admin(), "o1", "d1")).reason).toBe("twin_not_ready");
    expect(JSON.stringify(ledger())).toBe(before);
  });
  it("GAP-309: a copy at an earlier revision than its document never feeds the proposal", async () => {
    seed();
    db.tables.knowledge_documents[0].source_version_id = "v1";
    expect((await computeForDocument(admin(), "o1", "d1")).reason).toBe("twin_stale");
    expect(db.tables.document_equipment_suggestions).toHaveLength(0);
  });
});

describe("BR-13 — a tag the codebook does not know is held, never minted by a bulk or automatic apply", () => {
  it("held on the proposal; Apply all skips it; naming it creates it", async () => {
    seed();
    db.tables.knowledge_page_entities.push({ id: "e50", document_id: "k1", page: 1, kind: "equipment", tag: "CL-150", raw: "CL-150" });
    db.tables.knowledge_page_entities.push({ id: "e51", document_id: "k1", page: 1, kind: "equipment", tag: "NO-12", raw: "NO-12" }); // a pre-stop-list row
    const r = await computeForDocument(admin(), "o1", "d1");
    expect(r.suggestions.find((s) => s.tag === "CL-150")!.held).toBe("unknown_prefix");
    expect(r.suggestions.find((s) => s.tag === "NO-12")).toBeUndefined();
    const all = await applyForDocument(admin(), { orgId: "o1", documentId: "d1", userId: "u1" });
    expect(all.appliedTags).not.toContain("CL-150");
    expect(db.tables.assets.find((a) => a.tag === "CL-150")).toBeUndefined();
    const named = await applyForDocument(admin(), { orgId: "o1", documentId: "d1", userId: "u1", tags: ["CL-150"] });
    expect(named.createdAssets).toBe(1);
    expect(db.tables.assets.find((a) => a.tag === "CL-150")).toMatchObject({ origin: "drawing", type_id: null });
  });
});

// ─── Apply ──────────────────────────────────────────────────────────────────

describe("GAP-304 / WIRE-1 / BR-2 — apply writes the relation, keeps the column, and is idempotent", () => {
  it("reproduction → fix: after apply a document_assets row exists for (document, asset), source 'drawing', with the sheet and provenance", async () => {
    seed();
    await computeForDocument(admin(), "o1", "d1");
    const r = await applyForDocument(admin(), { orgId: "o1", documentId: "d1", userId: "u1" });
    expect(r.relations).toMatchObject({ written: 3, refreshed: 0, keptHuman: 0, notRecorded: null });
    const created = db.tables.assets.find((a) => a.tag === "P-7")!;
    const row = relations().find((x) => x.document_id === "d1" && x.asset_id === created.id)!;
    expect(row).toMatchObject({
      org_id: "o1", source: "drawing", tag_text: "P-7", sheet_label: "2002-D-10001 SHT 5", pages: [2],
      asserted_by: "machine", model: "vision-model-x", source_revision: "B", source_version_id: "v2",
    });
    expect(relations().find((x) => x.asset_id === "a-v101")).toMatchObject({ sheet_label: "2002-D-10001 SHT 4, SHT 5", pages: [1, 2] });
    // KEPT: the metadata column write (the chips render from it).
    expect(db.tables.documents[0].metadata).toEqual({ equipment: ["E-22", "P-7", "V-101"] });
  });

  it("re-running the sweep and the apply is idempotent — one row per pair, the column unchanged, nothing re-created", async () => {
    seed();
    await computeForDocument(admin(), "o1", "d1");
    await applyForDocument(admin(), { orgId: "o1", documentId: "d1", userId: "u1" });
    const snapshot = JSON.stringify({ rel: relations().map((r) => [r.document_id, r.asset_id, r.source]), assets: db.tables.assets.length, meta: db.tables.documents[0].metadata });
    await computeForDocument(admin(), "o1", "d1");
    const again = await applyForDocument(admin(), { orgId: "o1", documentId: "d1", userId: "u1" });
    expect(again.appliedTags).toEqual([]);
    await computeForDocument(admin(), "o1", "d1");
    expect(JSON.stringify({ rel: relations().map((r) => [r.document_id, r.asset_id, r.source]), assets: db.tables.assets.length, meta: db.tables.documents[0].metadata })).toBe(snapshot);
  });

  it("AREA-4: with NO column mapped, discovery still creates the assets and the relation is written — nothing throws", async () => {
    seed({ bridge: {} });
    await computeForDocument(admin(), "o1", "d1");
    const r = await applyForDocument(admin(), { orgId: "o1", documentId: "d1", userId: "u1" });
    expect(r.column).toBeNull();
    expect(r.createdAssets).toBe(1);
    expect(relations().filter((x) => x.source === "drawing")).toHaveLength(3);
    expect(db.tables.documents[0].metadata).toEqual({});
  });

  it("a degraded insert (a database before the registry columns) reports what it dropped", async () => {
    seed();
    await computeForDocument(admin(), "o1", "d1");
    db.beforeInsert = {
      assets: (row) => {
        if ("unit_code" in row) throw { code: "42703", message: 'column "unit_code" of relation "assets" does not exist' };
        return row;
      },
    };
    const r = await applyForDocument(admin(), { orgId: "o1", documentId: "d1", userId: "u1" });
    expect(r.degraded).toEqual([{ tag: "P-7", dropped: ["unit_code", "code", "origin", "discovered_from"] }]);
    expect(audit("EQUIPMENT_BRIDGE_APPLIED")[0].details).toMatchObject({ degraded: [{ tag: "P-7" }] });
  });

  it("before 20261170 the 'drawing' row is refused by the old CHECK: the relation is NOT recorded, said, and the column write still lands (today's behaviour)", async () => {
    seed();
    await computeForDocument(admin(), "o1", "d1");
    db.beforeInsert = {
      document_assets: (row) => {
        if (row.source === "drawing") throw { code: "23514", message: 'new row for relation "document_assets" violates check constraint "document_assets_source_check"' };
        return row;
      },
    };
    const r = await applyForDocument(admin(), { orgId: "o1", documentId: "d1", userId: "u1" });
    expect(r.relations.notRecorded).toMatch(/migration 20261170/);
    expect(relations()).toHaveLength(0);
    expect(db.tables.documents[0].metadata).toEqual({ equipment: ["E-22", "P-7", "V-101"] });
  });

  it("before 20261171 the provenance columns are dropped and the row still lands (said)", async () => {
    seed();
    await computeForDocument(admin(), "o1", "d1");
    db.beforeInsert = {
      document_assets: (row) => {
        if ("asserted_by" in row) throw { code: "42703", message: 'column "asserted_by" of relation "document_assets" does not exist' };
        return row;
      },
    };
    const r = await applyForDocument(admin(), { orgId: "o1", documentId: "d1", userId: "u1" });
    expect(r.relations).toMatchObject({ written: 3, provenanceDropped: true, notRecorded: null });
    expect(relations()[0]).not.toHaveProperty("asserted_by");
    expect(relations()[0]).toHaveProperty("sheet_label");
  });

  it("a pair a person already linked is left as it is — a human assertion stands", async () => {
    seed();
    db.tables.document_assets.push({ id: "m1", org_id: "o1", document_id: "d1", asset_id: "a-e22", tag_text: "E-22", source: "manual" });
    await computeForDocument(admin(), "o1", "d1");
    const r = await applyForDocument(admin(), { orgId: "o1", documentId: "d1", userId: "u1" });
    expect(r.relations.keptHuman).toBe(1);
    expect(relations().find((x) => x.id === "m1")).toEqual({ id: "m1", org_id: "o1", document_id: "d1", asset_id: "a-e22", tag_text: "E-22", source: "manual" });
  });
});

describe("GAP-302 — a 'drawing' row survives an unrelated asset_tags edit (documents_resync_assets, transcribed)", () => {
  /** documents_resync_assets (20260609, re-created byte-for-byte in 20261170):
   *  DELETE the document's jsonb_sync rows, then insert one per distinct tag
   *  that names an asset, ON CONFLICT (document_id, asset_id) DO NOTHING. */
  function resync(doc: { id: string; org_id: string; asset_tags: Array<{ tag?: string }> | null }) {
    db.tables.document_assets = relations().filter((r) => !(r.document_id === doc.id && r.source === "jsonb_sync"));
    const tags = [...new Set((doc.asset_tags ?? []).map((e) => e.tag ?? "").filter((t) => t !== ""))];
    for (const t of tags) {
      const a = db.tables.assets.find((x) => x.org_id === doc.org_id && x.tag_normalized === tagKey(t));
      if (!a) continue;
      if (relations().some((r) => r.document_id === doc.id && r.asset_id === a.id)) continue; // ON CONFLICT DO NOTHING
      relations().push({ id: `sync-${a.id}`, org_id: doc.org_id, document_id: doc.id, asset_id: a.id, tag_text: t, source: "jsonb_sync" });
    }
  }
  it("the transcription is the SQL's", () => {
    const sql = repo("supabase/migrations/20261170_intel_roundG_document_assets_source.sql");
    expect(sql).toContain("DELETE FROM document_assets\n   WHERE document_id = NEW.id AND source = 'jsonb_sync';");
    expect(sql).toContain("ON CONFLICT (document_id, asset_id) DO NOTHING;");
    expect(sql).toContain("AND a.tag_normalized = normalize_tag(tag_record.tag_text)");
  });
  it("after the Bridge applies, a person edits asset_tags (another tag, then the same tag, then clears it) — the drawing rows stay", async () => {
    seed();
    await computeForDocument(admin(), "o1", "d1");
    await applyForDocument(admin(), { orgId: "o1", documentId: "d1", userId: "u1" });
    const drawing = () => relations().filter((r) => r.source === "drawing").map((r) => r.asset_id).sort();
    const before = drawing();
    expect(before).toHaveLength(3);
    db.tables.assets.push({ id: "a-h9", org_id: "o1", tag: "H-9", tag_normalized: "h9", archived: false });
    resync({ id: "d1", org_id: "o1", asset_tags: [{ tag: "H-9" }] });           // unrelated tag
    expect(drawing()).toEqual(before);
    expect(relations().filter((r) => r.source === "jsonb_sync").map((r) => r.asset_id)).toEqual(["a-h9"]);
    resync({ id: "d1", org_id: "o1", asset_tags: [{ tag: "E-22" }, { tag: "H-9" }] }); // the same pair as a drawing row
    expect(drawing()).toEqual(before);
    expect(relations().filter((r) => r.asset_id === "a-e22")).toHaveLength(1);
    resync({ id: "d1", org_id: "o1", asset_tags: [] });                          // cleared
    expect(drawing()).toEqual(before);
  });
});

describe("BR-5 — a tag a person removed from the column is never re-added by a later auto-apply", () => {
  it("reproduction → fix: apply, delete CL chip by hand, re-index with auto-apply on — the column keeps the deletion", async () => {
    seed({ bridge: { targetColumnKey: "equipment", autoApply: true, autoApplyBy: "u-admin" } });
    await computeForDocument(admin(), "o1", "d1"); // auto-applies (column mapped)
    expect(db.tables.documents[0].metadata).toEqual({ equipment: ["E-22", "P-7", "V-101"] });
    db.tables.documents[0].metadata = { equipment: ["E-22", "V-101"] };       // a person removed P-7
    await computeForDocument(admin(), "o1", "d1");                            // the re-index's recompute
    expect(db.tables.documents[0].metadata).toEqual({ equipment: ["E-22", "V-101"] });
    // Named again by a person, it is applied again.
    await applyForDocument(admin(), { orgId: "o1", documentId: "d1", userId: "u1", tags: ["P-7"] });
    expect(db.tables.documents[0].metadata).toEqual({ equipment: ["E-22", "V-101", "P-7"] });
  });
});

describe("BR-7 / CB-2 / BR-8 — codes re-derived, filled independently, and an accountable creator", () => {
  it("BR-7: an asset with a unit but no code gets the code its own filing derives; filing a unit-less asset fills both", async () => {
    seed();
    db.tables.assets.push({ id: "a-p7", org_id: "o1", tag: "P-7", tag_normalized: "p7", unit_code: null, code: null, archived: false });
    await computeForDocument(admin(), "o1", "d1");
    const r = await applyForDocument(admin(), { orgId: "o1", documentId: "d1", userId: "u1" });
    expect(db.tables.assets.find((a) => a.id === "a-v101")).toMatchObject({ unit_code: "20", code: "2010.101" });
    expect(db.tables.assets.find((a) => a.id === "a-p7")).toMatchObject({ unit_code: "20", code: "2050.7" });
    expect(db.tables.assets.find((a) => a.id === "a-e22")).toMatchObject({ unit_code: "20", code: "2030.22" }); // untouched
    expect(r.codesFilled).toBe(1);
  });
  it("CB-2: a forged code and an unknown unit on the stored proposal are never written — re-derived from tag + a held unit", async () => {
    seed();
    db.tables.document_equipment_suggestions = [{
      org_id: "o1", document_id: "d1", applied: [], dismissed: [],
      suggested: [
        { tag: "P-8", code: "9999.1", pages: [1], assetId: null, assetStatus: "new", unitCode: "20" },
        { tag: "P-9", code: "7750.9", pages: [1], assetId: null, assetStatus: "new", unitCode: "77" },
      ],
    }];
    await applyForDocument(admin(), { orgId: "o1", documentId: "d1", userId: "u1" });
    expect(db.tables.assets.find((a) => a.tag === "P-8")).toMatchObject({ unit_code: "20", code: "2050.8" });
    expect(db.tables.assets.find((a) => a.tag === "P-9")).toMatchObject({ unit_code: null, code: null });
  });
  it("BR-8: an automatic apply's discovered asset names the person who turned auto-apply on (else who filed the drawing) — never the nil UUID when known", async () => {
    seed({ bridge: { targetColumnKey: "equipment", autoApply: true, autoApplyBy: "u-admin" } });
    await computeForDocument(admin(), "o1", "d1");
    expect(db.tables.assets.find((a) => a.tag === "P-7")).toMatchObject({ created_by: "u-admin", origin: "drawing" });
    expect((db.tables.assets.find((a) => a.tag === "P-7")!.discovered_from as Row)).toMatchObject({ documentId: "d1", door: "drawing", auto: true });
    seed({ bridge: { targetColumnKey: "equipment", autoApply: true } });
    await computeForDocument(admin(), "o1", "d1");
    expect(db.tables.assets.find((a) => a.tag === "P-7")!.created_by).toBe("u-uploader");
  });
  it("auto-apply with no column waits for a person's first review (reviewed once), then acts", async () => {
    seed({ bridge: { autoApply: true, autoApplyBy: "u-admin" } });
    await computeForDocument(admin(), "o1", "d1");
    expect(db.tables.assets.find((a) => a.tag === "P-7")).toBeUndefined();
    await dismissForDocument(admin(), { orgId: "o1", documentId: "d1", userId: "u1", tags: ["E-22"] });
    expect((db.tables.libraries[0].equipment_bridge as Row).reviewedAt).toBeTruthy();
    await computeForDocument(admin(), "o1", "d1");
    expect(db.tables.assets.find((a) => a.tag === "P-7")).toBeTruthy();
  });
});

describe("BR-9 — partial review: pick tags, apply them, dismiss the rest; a dismissal is remembered", () => {
  it("dismissing an applied tag removes its drawing relation, records the decision, and keeps it out of every later apply", async () => {
    seed();
    await computeForDocument(admin(), "o1", "d1");
    await applyForDocument(admin(), { orgId: "o1", documentId: "d1", userId: "u1", tags: ["E-22", "P-7"] });
    expect(ledger().applied.sort()).toEqual(["E-22", "P-7"]);
    const d = await dismissForDocument(admin(), { orgId: "o1", documentId: "d1", userId: "u1", tags: ["P-7"] });
    expect(d).toMatchObject({ dismissed: ["P-7"], relationsRemoved: 1, remembered: true });
    expect(relations().map((r) => r.tag_text).sort()).toEqual(["E-22"]);
    expect(audit("EQUIPMENT_BRIDGE_DISMISSED")).toHaveLength(1);
    expect(audit("EQUIPMENT_BRIDGE_RELATION_REMOVED")[0].details).toMatchObject({ removed: [{ tag: "P-7", sheet: "2002-D-10001 SHT 5", revision: "B" }] });
    // A recompute keeps it dismissed; Apply all applies only V-101.
    await computeForDocument(admin(), "o1", "d1");
    expect(ledger().suggested.find((s) => s.tag === "P-7")!.dismissed).toBe(true);
    const all = await applyForDocument(admin(), { orgId: "o1", documentId: "d1", userId: "u1" });
    expect(all.appliedTags).toEqual(["V-101"]);
    expect(relations().some((r) => r.tag_text === "P-7")).toBe(false);
  });
  it("status 'dismissed' is written when every proposed tag is dismissed", async () => {
    seed();
    await computeForDocument(admin(), "o1", "d1");
    await dismissForDocument(admin(), { orgId: "o1", documentId: "d1", userId: "u1", tags: ["E-22", "V-101", "P-7"] });
    expect(ledger().status).toBe("dismissed");
  });
  it("before 20261171 the ledger cannot remember it across a recompute — said, not silently dropped", async () => {
    seed();
    await computeForDocument(admin(), "o1", "d1");
    db.beforeUpdate = {
      document_equipment_suggestions: (next) => {
        if ("dismissed" in next && Array.isArray(next.dismissed) && (next.dismissed as unknown[]).length > 0) {
          throw { code: "42703", message: 'column "dismissed" of relation "document_equipment_suggestions" does not exist' };
        }
        return next;
      },
    };
    const d = await dismissForDocument(admin(), { orgId: "o1", documentId: "d1", userId: "u1", tags: ["P-7"] });
    expect(d.remembered).toBe(false);
  });
});

describe("GAP-309 — revision truth: a tag that leaves the sheet is a reviewable delta, never a deletion", () => {
  async function appliedAll() {
    seed();
    await computeForDocument(admin(), "o1", "d1");
    await applyForDocument(admin(), { orgId: "o1", documentId: "d1", userId: "u1" });
  }
  it("rev C no longer shows P-7: its relation is marked vanished (kept), the others refreshed to rev C", async () => {
    await appliedAll();
    db.tables.documents[0].current_version_id = "v3";
    Object.assign(db.tables.knowledge_documents[0], { source_version_id: "v3", source_rev: "C" });
    db.tables.knowledge_page_entities = db.tables.knowledge_page_entities.filter((e) => e.tag !== "P-7");
    const r = await computeForDocument(admin(), "o1", "d1");
    expect(r.revision).toMatchObject({ vanished: 1, complete: true });
    const p7 = relations().find((x) => x.tag_text === "P-7")!;
    expect(p7.vanished_at).toBeTruthy();
    expect(p7.superseded_at).toBeTruthy();        // read from rev B, no longer current
    expect(relations().find((x) => x.tag_text === "E-22")).toMatchObject({ source_revision: "C", source_version_id: "v3", vanished_at: null, superseded_at: null });
    expect(relations()).toHaveLength(3);          // never deleted
  });
  it("an incomplete reading (pages waiting on AI vision) never marks anything vanished", async () => {
    await appliedAll();
    db.tables.knowledge_page_entities = db.tables.knowledge_page_entities.filter((e) => e.tag !== "P-7");
    db.tables.knowledge_documents[0].vision_failed_pages = [2];
    const r = await computeForDocument(admin(), "o1", "d1");
    expect(r.revision).toMatchObject({ vanished: 0, complete: false });
    expect(relations().every((x) => !x.vanished_at)).toBe(true);
  });
  it("review: 'it left the sheet' removes the link and records it (and a later return is proposed, not re-linked); 'it is still there' clears the mark", async () => {
    await appliedAll();
    db.tables.knowledge_page_entities = db.tables.knowledge_page_entities.filter((e) => e.tag !== "P-7" && e.tag !== "E-22");
    await computeForDocument(admin(), "o1", "d1");
    expect(await reviewVanished(admin(), { orgId: "o1", documentId: "d1", userId: "u1", tags: ["P-7"], decision: "remove" })).toEqual({ changed: 1 });
    expect(relations().some((x) => x.tag_text === "P-7")).toBe(false);
    expect(audit("EQUIPMENT_BRIDGE_VANISHED_REMOVED")).toHaveLength(1);
    expect(ledger().applied).not.toContain("P-7");
    expect(await reviewVanished(admin(), { orgId: "o1", documentId: "d1", userId: "u1", tags: ["E-22"], decision: "keep" })).toEqual({ changed: 1 });
    expect(relations().find((x) => x.tag_text === "E-22")!.vanished_at).toBeNull();
    expect(audit("EQUIPMENT_BRIDGE_VANISHED_KEPT")).toHaveLength(1);
    // A tag that is not marked vanished cannot be removed through this door.
    expect(await reviewVanished(admin(), { orgId: "o1", documentId: "d1", userId: "u1", tags: ["V-101"], decision: "remove" })).toEqual({ changed: 0 });
  });
});

describe("GAP-307 — the knowledge door: a P&ID uploaded to a knowledge library builds the registry, unit-less and reported", () => {
  function upload() {
    seed();
    db.tables.knowledge_documents.push({ id: "k-up", org_id: "o1", library_id: "kl1", name: "upload.pdf", source_document_id: null, status: "ready", source_rev: null });
    db.tables.knowledge_page_entities.push(
      { id: "u1", document_id: "k-up", page: 3, kind: "equipment", tag: "P-44", raw: "P-44" },
      { id: "u2", document_id: "k-up", page: 3, kind: "equipment", tag: "E-22", raw: "E-22" },
      { id: "u3", document_id: "k-up", page: 4, kind: "equipment", tag: "ZZ-1", raw: "ZZ-1" },
    );
  }
  it("named tags on the document become discovered assets with door 'knowledge' provenance; an existing one is counted", async () => {
    upload();
    const r = await discoverFromKnowledge(admin(), { orgId: "o1", userId: "u1", knowledgeDocumentId: "k-up", tags: ["P-44", "E-22", "ZZ-1", "Q-1"] });
    expect(r).toMatchObject({ created: ["P-44", "ZZ-1"], existing: ["E-22"], held: ["ZZ-1"], unitless: 2 });
    expect(r.failed).toEqual([{ tag: "Q-1", reason: "This document's index does not carry the tag." }]);
    expect(db.tables.assets.find((a) => a.tag === "P-44")).toMatchObject({
      unit_code: null, code: null, origin: "drawing", created_by: "u1",
      discovered_from: { knowledgeDocumentId: "k-up", pages: [3], door: "knowledge" },
    });
    expect(audit("EQUIPMENT_BRIDGE_DISCOVERED")[0].details).toMatchObject({ door: "knowledge", unitless: 2 });
  });
  it("a copy of a controlled document is refused here — its tags go through the sweep, which records the relation", async () => {
    upload();
    await expect(discoverFromKnowledge(admin(), { orgId: "o1", userId: "u1", knowledgeDocumentId: "k1", tags: ["P-7"] }))
      .rejects.toThrow(/apply its tags from the equipment sweep/);
  });
});

describe("GAP-310 — the Bridge's key is the one tag grammar (an import, not a copy)", () => {
  it("assetNorm is tagKey", () => {
    const src = repo("lib/equipmentBridgeServer.ts");
    expect(src).toMatch(/const assetNorm = \(tag: string\) => tagKey\(tag\);/);
    expect(src).not.toMatch(/toLowerCase\(\)\.replace\(\/\[\^a-z0-9\]\+\/g/);
  });
  it("lib/linkProposerServer.ts decides 'reached via an alias' by tagKey — 'North Furnace' and 'NORTH-FURNACE' are one alias", () => {
    const src = repo("lib/linkProposerServer.ts");
    expect(src).toMatch(/const viaKey = tagKey\(l\.tag_text \?\? ""\);/);
    expect(src).toMatch(/aliases\.find\(\(a\) => tagKey\(a\) === viaKey\)/);
    expect(src).not.toMatch(/normalizeTag\(a\) === viaTag/);
    expect(tagKey("North Furnace")).toBe(tagKey("NORTH-FURNACE"));
    expect(normalizeTag("North Furnace")).not.toBe(normalizeTag("NORTH-FURNACE"));
  });
});
