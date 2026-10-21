// intelligence Round G I-32 merge — GOV-16 (opened by I-32; ruled by the
// integrator at the I-32 merge, 2026-10-21, DEC-90: resolved in the same
// pass). An adopted pair — a person's link (source 'manual', asserted_by
// 'human', model cleared) that keeps the sheet address the equipment sweep
// read — read as plain fact on ⌘K (lib/search.ts lookupTag →
// lib/globalSearch.ts) and in the coverage report (lib/bridgeCoverage.ts →
// components/assets/CoverageReport.tsx). Both now read the row through
// lib/relationProvenance.ts sheetReadingOf and word it with sheetMarkOf —
// "read by the equipment sweep, unconfirmed" — exactly as the org graph and
// the asset hub do.
//
//   * the adopted pair's sheet carries the sweep mark on ⌘K and in the
//     coverage report;
//   * an AI-read machine reading keeps "(AI-read, unconfirmed)";
//   * every other search result and coverage row is byte-identical to what
//     the pre-ruling code produced (the old wording is re-stated here, and
//     the outputs compared as JSON).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { newFakeDb, type FakeDb } from "./helpers/fakeSupabase";

const db = vi.hoisted(() => ({ ref: null as unknown as FakeDb }));
vi.mock("@/lib/supabase", async () => {
  const { makeFakeSupabase, newFakeDb: fresh } = await import("./helpers/fakeSupabase");
  db.ref = fresh();
  const proxy = new Proxy({}, { get: (_t, p: string) => (makeFakeSupabase(db.ref) as Record<string, unknown>)[p] });
  return { supabase: proxy };
});
vi.mock("next/link", () => ({ default: () => null }));

import { lookupTag } from "@/lib/search";
import { globalSearch } from "@/lib/globalSearch";
import { buildCoverage, type CoverageInput, type CoverageWhere } from "@/lib/bridgeCoverage";
import { whereText } from "@/components/assets/CoverageReport";
import { AI_READ_MARK, SWEEP_SHEET_MARK } from "@/lib/relationProvenance";

// ─── ⌘K ─────────────────────────────────────────────────────────────────────

/** The five kinds of relation row a lookup can meet, one document each. */
const LINKS = {
  aiRead: { source: "drawing", sheet_label: "PID-1 SHT 4", model: "vision-x" },       // a machine's AI-read reading
  textLayer: { source: "drawing", sheet_label: "PID-2 SHT 1", model: null },          // a machine's text-layer reading
  adopted: { source: "manual", sheet_label: "PID-3 SHT 7", model: null },             // a person adopted the sweep's pair
  manual: { source: "manual", sheet_label: null, model: null },                       // a person's plain link
  tagSync: { source: "jsonb_sync", sheet_label: null, model: null },                  // the person's own tags
} as const;
const DOCS = Object.keys(LINKS) as Array<keyof typeof LINKS>;

beforeEach(() => {
  Object.assign(db.ref, newFakeDb());
  db.ref.tables = {
    assets: [{ id: "a-fv", org_id: "o1", tag: "FV-2201", tag_normalized: "fv2201", description: "Feed valve", unit_code: "20", code: null, archived: false }],
    asset_aliases: [],
    codebook_entries: [{ id: "u20", org_id: "o1", kind: "unit", code: "20", label: "Crude Unit" }],
    document_assets: DOCS.map((k, i) => ({ id: `da${i}`, org_id: "o1", document_id: k, asset_id: "a-fv", ...LINKS[k] })),
    documents: DOCS.map((k, i) => ({
      id: k, org_id: "o1", library_id: "lib", document_number: `PID-${i + 1}`, title: `Drawing ${k}`, status: "Released", updated_at: `2026-09-0${i + 1}`,
      asset_tags: k === "tagSync" ? [{ tag: "FV-2201" }] : [],
    })),
    tickets: [], projects: [], notes: [], transmittals: [],
  };
});

/** The ⌘K subtitle as the code before the ruling wrote it (GAP-311 / GOV-9 / GAP-303). */
const oldSubtitle = (tag: string, d: { sheetLabel?: string | null; aiRead?: boolean; fromDrawing?: boolean; personTagged?: boolean; title: string | null; document_number: string | null }) =>
  `${tag} appears on ${d.sheetLabel ? `${d.sheetLabel}${d.aiRead ? " (AI-read, unconfirmed)" : ""}` : "this drawing"}${
    d.fromDrawing ? (d.personTagged ? " (tagged, and read from the drawing)" : " (read from the drawing)") : ""}${d.title && d.document_number ? ` · ${d.title}` : ""}`;

describe("GOV-16 — ⌘K: an adopted pair's sheet is the sweep's, unconfirmed", () => {
  it("the adopted pair's subtitle carries 'read by the equipment sweep, unconfirmed'; the AI-read reading keeps its own mark", async () => {
    const [hit] = await lookupTag("o1", "FV-2201", { documentsPerAsset: 5 });
    const byId = Object.fromEntries(hit.documents.map((d) => [d.id, d]));
    expect(byId.adopted).toMatchObject({ sheetLabel: "PID-3 SHT 7", fromDrawing: false, aiRead: false, sheetUnconfirmed: true });
    const docs = (await globalSearch({ orgId: "o1", query: "FV-2201" })).filter((h) => h.exact && h.kind === "document");
    const sub = Object.fromEntries(docs.map((h) => [h.id, h.subtitle]));
    // Reproduction: before the ruling it read "FV-2201 appears on PID-3 SHT 7 · Drawing adopted" — a plain fact.
    expect(sub.adopted).toBe(`FV-2201 appears on PID-3 SHT 7 (${SWEEP_SHEET_MARK}) · Drawing adopted`);
    expect(sub.aiRead).toBe(`FV-2201 appears on PID-1 SHT 4 (${AI_READ_MARK}) (read from the drawing) · Drawing aiRead`);
  });

  it("REGRESSION PIN: every other lookup document and every other ⌘K hit is byte-identical to the pre-ruling output", async () => {
    const all = [...db.ref.tables.document_assets];
    // ⌘K lists three drawings per asset: every kind of row is put through it, three at a time.
    for (const kinds of [["aiRead", "textLayer", "adopted"], ["manual", "tagSync", "aiRead"]]) {
      db.ref.tables.document_assets = all.filter((r) => kinds.includes(String(r.document_id)));
      const [hit] = await lookupTag("o1", "FV-2201");
      for (const d of hit.documents.filter((x) => x.id !== "adopted")) expect(d).not.toHaveProperty("sheetUnconfirmed");
      const docHits = (await globalSearch({ orgId: "o1", query: "FV-2201" })).filter((h) => h.exact && h.kind === "document");
      expect(docHits.map((h) => h.id).sort()).toEqual([...kinds].sort());
      for (const h of docHits) {
        const d = hit.documents.find((x) => x.id === h.id)!;
        const old = oldSubtitle("FV-2201", d);
        if (h.id === "adopted") {
          // the adopted hit differs ONLY by its sheet's mark
          expect(h.subtitle).toBe(old.replace("PID-3 SHT 7", `PID-3 SHT 7 (${SWEEP_SHEET_MARK})`));
        } else {
          expect(JSON.stringify(h)).toBe(JSON.stringify({ ...h, subtitle: old }));
        }
      }
    }
  });

  it("before 20261171 (no `model` column) an adopted pair still reads as the sweep's; a 'drawing' row stays the drawing's", async () => {
    db.ref.selectErrors = { document_assets: (cols) => (cols.includes("model") ? { code: "42703", message: "column document_assets.model does not exist" } : null) };
    const [hit] = await lookupTag("o1", "FV-2201", { documentsPerAsset: 5 });
    const byId = Object.fromEntries(hit.documents.map((d) => [d.id, d]));
    expect(byId.adopted).toMatchObject({ sheetUnconfirmed: true });
    expect(byId.textLayer).not.toHaveProperty("sheetUnconfirmed");
    expect(byId.aiRead).not.toHaveProperty("sheetUnconfirmed");
  });
});

// ─── The coverage report ────────────────────────────────────────────────────

const asset = (id: string, tag: string) => ({ id, tag, tag_normalized: tag.toLowerCase().replace(/[^a-z0-9]/g, ""), unit_code: "20", code: null, origin: "manual" });
const COVERAGE: CoverageInput = {
  assets: [asset("a1", "E-22"), asset("a2", "V-101")],
  relations: [
    { document_id: "d1", asset_id: "a1", source: "drawing", sheet_label: "PID-1 SHT 4", model: "vision-x" },
    { document_id: "d2", asset_id: "a1", source: "drawing", sheet_label: "PID-2 SHT 1", model: null },
    { document_id: "d3", asset_id: "a1", source: "manual", sheet_label: "PID-3 SHT 7", model: null },
    { document_id: "d4", asset_id: "a2", source: "manual", sheet_label: null, model: null },
    { document_id: "d5", asset_id: "a2", source: "jsonb_sync", sheet_label: null },
  ],
  documents: ["d1", "d2", "d3", "d4", "d5"].map((id, i) => ({ id, document_number: `PID-${i + 1}`, title: null, library_id: "lib", unit_code: "20" })),
  sheetTags: [{ knowledgeDocumentId: "k9", documentId: null, name: "upload.pdf", tag: "K-5", page: 2 }],
  knowledgeRelations: [{ knowledge_document_id: "k1", asset_id: "a2", name: "kup.pdf", sheet_label: "UP SHT 2", pages: [2], model: null }],
  units: [{ code: "20", label: "Crude Unit" }],
};

/** whereText as the code before the ruling wrote it. */
const oldWhereText = (w: CoverageWhere) => {
  const at = w.sheet ? (w.aiRead ? `${w.sheet} (AI-read, unconfirmed)` : w.sheet)
    : (w.pages.length > 0 ? `page${w.pages.length === 1 ? "" : "s"} ${w.pages.join(", ")}` : null);
  const door = w.door === "knowledge" ? (w.via === "relation" ? " (knowledge upload · linked)" : " (knowledge upload)")
    : w.via === "extracted" ? " (read, not applied)" : "";
  return `${w.name}${at ? ` · ${at}` : ""}${door}`;
};

describe("GOV-16 — the coverage report: an adopted pair's sheet is the sweep's, unconfirmed", () => {
  const report = buildCoverage(COVERAGE);
  const all = [...report.agree.flatMap((r) => r.where), ...report.sheetOnly.flatMap((r) => r.where), ...report.disagree.flatMap((r) => r.where)];

  it("the adopted pair's row says 'read by the equipment sweep, unconfirmed'; the AI-read row keeps its own mark", () => {
    const adopted = all.find((w) => w.documentId === "d3")!;
    expect(adopted).toMatchObject({ sheet: "PID-3 SHT 7", aiRead: false, sheetUnconfirmed: true });
    // Reproduction: before the ruling it read "PID-3 · PID-3 SHT 7" — a plain fact.
    expect(whereText(adopted)).toBe(`PID-3 · PID-3 SHT 7 (${SWEEP_SHEET_MARK})`);
    expect(whereText(all.find((w) => w.documentId === "d1")!)).toBe(`PID-1 · PID-1 SHT 4 (${AI_READ_MARK})`);
  });

  it("REGRESSION PIN: every other row — machine readings, plain links, tag-sync rows, knowledge uploads, extracted tags — is byte-identical, in data and in words", () => {
    const others = all.filter((w) => w.documentId !== "d3");
    expect(others.length).toBeGreaterThanOrEqual(6);
    for (const w of others) {
      expect(w).not.toHaveProperty("sheetUnconfirmed");
      expect(whereText(w)).toBe(oldWhereText(w));
    }
    // the report as a whole differs from the pre-ruling one ONLY by the adopted row's flag
    const strip = JSON.parse(JSON.stringify(report), (k, v) => (k === "sheetUnconfirmed" ? undefined : v));
    expect(JSON.stringify(report).length - JSON.stringify(strip).length).toBe(',"sheetUnconfirmed":true'.length);
  });
});
