// lib/bridgeCoverage.ts — GAP-308: the coverage report. How you know the
// import was right, and the to-do list for when it was not.
//
// Four questions, the morning after an import or a sweep, per operating unit
// and org-wide:
//   agree      — equipment in the registry that a readable sheet carries
//                (a document↔equipment relation, or a tag extracted from a
//                current indexed copy), with no unit disagreement;
//   list-only  — equipment in the registry on NO sheet (in the master list,
//                on no drawing);
//   sheet-only — tags read off a sheet that match NO registry asset (on a
//                drawing, in no list) — from either door: a controlled
//                document's indexed copy, or a P&ID uploaded straight into a
//                knowledge library (GAP-307: those can be discovered from here);
//   disagree   — equipment whose unit differs from the decoded unit of a
//                drawing it appears on (documents.unit_code, the decode the
//                codebook writes — never decoded here).
// Each bucket is a WORKING LIST (rows a person acts on), not a number. The
// report is re-derived on every read from the rows themselves — never a
// stored snapshot that drifts. "Partially imported" is a legitimate state
// the report holds honestly.
//
// Reads run with the service role (knowledge_page_entities is service-role
// only, GM-14) and are filtered per caller: a controlled document — and every
// indexed copy of it — is included only when the caller can read it (the
// route passes lib/knowledgeAccess's readableControlledDocIds; fails closed).
// A copy at an earlier revision than its document never counts (GAP-309).

import type { SupabaseClient } from "@supabase/supabase-js";
import { loadCodebookAdmin } from "@/lib/codebookServer";
import { normalizeTag, splitTag, tagKey } from "@/lib/codebook";
import { passesExtractorGate } from "@/lib/equipmentBridgeServer";

export interface CoverageAsset {
  id: string; tag: string; tag_normalized: string; unit_code: string | null; code: string | null; origin: string | null;
}
export interface CoverageRelation {
  document_id: string; asset_id: string; source: string; sheet_label: string | null;
  /** The AI model that transcribed the page the label was read off (GOV-9);
   *  null / absent: the PDF's own text layer, or not recorded. */
  model?: string | null;
}
export interface CoverageDocument {
  id: string; document_number: string | null; title: string | null; library_id: string | null; unit_code: string | null;
}
export interface CoverageSheetTag {
  knowledgeDocumentId: string;
  /** The controlled document the copy mirrors; null for a knowledge upload. */
  documentId: string | null;
  name: string;
  tag: string;
  page: number;
}

export interface CoverageInput {
  assets: CoverageAsset[];
  relations: CoverageRelation[];
  documents: CoverageDocument[];
  sheetTags: CoverageSheetTag[];
  units: Array<{ code: string; label: string }>;
  unitCode?: string | null;
  notes?: string[];
  truncated?: boolean;
}

export interface CoverageWhere {
  documentId: string | null;
  knowledgeDocumentId: string | null;
  name: string;
  /** A sheet address from the relation, or the pages the tag was read on. */
  sheet: string | null;
  /** GOV-9: the sheet address was read off an AI transcription — shown
   *  unconfirmed wherever it is shown. */
  aiRead?: boolean;
  pages: number[];
  via: "relation" | "extracted";
  door: "controlled" | "knowledge";
  libraryId: string | null;
}

export interface CoverageReport {
  scope: { unitCode: string | null; label: string | null };
  totals: { assets: number; onSheet: number; onNoSheet: number; sheetTagsWithoutAsset: number; disagree: number };
  agree: Array<{ assetId: string; tag: string; unitCode: string | null; where: CoverageWhere[] }>;
  listOnly: Array<{ assetId: string; tag: string; unitCode: string | null; origin: string | null }>;
  sheetOnly: Array<{ tag: string; unitHint: string | null; where: CoverageWhere[] }>;
  disagree: Array<{ assetId: string; tag: string; assetUnit: string; drawingUnits: string[]; where: CoverageWhere[] }>;
  notes: string[];
  truncated: boolean;
}

const MAX_LIST = 500;

/** Pure: the four working lists from the rows (re-derived on every read). */
export function buildCoverage(input: CoverageInput): CoverageReport {
  const unit = input.unitCode ?? null;
  const notes = [...(input.notes ?? [])];
  const docs = new Map(input.documents.map((d) => [d.id, d]));
  const assetsAll = input.assets;
  const byKey = new Map(assetsAll.map((a) => [a.tag_normalized || tagKey(a.tag), a]));

  const whereFor = new Map<string, CoverageWhere[]>(); // asset id → where
  const push = (assetId: string, w: CoverageWhere) => {
    const list = whereFor.get(assetId) ?? whereFor.set(assetId, []).get(assetId)!;
    const dup = list.find((x) => x.documentId && x.documentId === w.documentId && x.via === w.via
      || (!x.documentId && x.knowledgeDocumentId === w.knowledgeDocumentId && x.via === w.via));
    if (dup) { dup.pages = [...new Set([...dup.pages, ...w.pages])].sort((a, b) => a - b); return; }
    list.push(w);
  };
  for (const r of input.relations) {
    const d = docs.get(r.document_id);
    if (!d) continue; // not readable to the caller (or gone)
    push(r.asset_id, {
      documentId: r.document_id, knowledgeDocumentId: null, name: d.document_number || d.title || "Untitled",
      sheet: r.sheet_label, aiRead: !!r.model, pages: [], via: "relation", door: "controlled", libraryId: d.library_id,
    });
  }
  const sheetOnly = new Map<string, { tag: string; where: CoverageWhere[]; units: Set<string> }>();
  for (const t of input.sheetTags) {
    const norm = normalizeTag(t.tag);
    if (!splitTag(norm) || !passesExtractorGate(norm)) continue;
    const doc = t.documentId ? docs.get(t.documentId) : undefined;
    if (t.documentId && !doc) continue; // the copy of a document the caller cannot read
    const w: CoverageWhere = {
      documentId: t.documentId, knowledgeDocumentId: t.knowledgeDocumentId,
      name: doc ? (doc.document_number || doc.title || t.name) : t.name,
      sheet: null, pages: [t.page], via: "extracted", door: t.documentId ? "controlled" : "knowledge",
      libraryId: doc?.library_id ?? null,
    };
    const asset = byKey.get(tagKey(norm));
    if (asset) { push(asset.id, w); continue; }
    const cur = sheetOnly.get(norm) ?? sheetOnly.set(norm, { tag: norm, where: [], units: new Set() }).get(norm)!;
    const dup = cur.where.find((x) => x.knowledgeDocumentId === w.knowledgeDocumentId);
    if (dup) dup.pages = [...new Set([...dup.pages, t.page])].sort((a, b) => a - b);
    else cur.where.push(w);
    if (doc?.unit_code) cur.units.add(doc.unit_code);
  }

  const inScope = (a: CoverageAsset) => !unit || a.unit_code === unit;
  const scoped = assetsAll.filter(inScope);
  const agree: CoverageReport["agree"] = [];
  const listOnly: CoverageReport["listOnly"] = [];
  const disagree: CoverageReport["disagree"] = [];
  for (const a of scoped) {
    const where = whereFor.get(a.id) ?? [];
    if (where.length === 0) { listOnly.push({ assetId: a.id, tag: a.tag, unitCode: a.unit_code, origin: a.origin }); continue; }
    const drawingUnits = [...new Set(where
      .map((w) => (w.documentId ? docs.get(w.documentId)?.unit_code ?? null : null))
      .filter((u): u is string => !!u))];
    if (a.unit_code && drawingUnits.some((u) => u !== a.unit_code)) {
      disagree.push({ assetId: a.id, tag: a.tag, assetUnit: a.unit_code, drawingUnits, where });
    } else {
      agree.push({ assetId: a.id, tag: a.tag, unitCode: a.unit_code, where });
    }
  }
  const sheetOnlyList = [...sheetOnly.values()]
    .filter((s) => !unit || s.units.has(unit))
    .map((s) => ({ tag: s.tag, unitHint: s.units.size === 1 ? [...s.units][0] : null, where: s.where }));
  if (unit && [...sheetOnly.values()].some((s) => s.where.some((w) => w.door === "knowledge"))) {
    notes.push("Tags on sheets uploaded straight into a knowledge library have no decoded unit, so they are listed org-wide only.");
  }
  const byTag = <T extends { tag: string }>(xs: T[]) => xs.sort((x, y) => x.tag.localeCompare(y.tag, undefined, { numeric: true }));
  const cap = <T,>(xs: T[], what: string): T[] => {
    if (xs.length > MAX_LIST) notes.push(`${what}: showing the first ${MAX_LIST} of ${xs.length}.`);
    return xs.slice(0, MAX_LIST);
  };
  const label = unit ? (input.units.find((u) => u.code === unit)?.label ?? null) : null;
  return {
    scope: { unitCode: unit, label },
    totals: {
      assets: scoped.length,
      onSheet: agree.length + disagree.length,
      onNoSheet: listOnly.length,
      sheetTagsWithoutAsset: sheetOnlyList.length,
      disagree: disagree.length,
    },
    agree: cap(byTag(agree), "Agree"),
    listOnly: cap(byTag(listOnly), "In the list, on no sheet"),
    sheetOnly: cap(byTag(sheetOnlyList), "On a sheet, in no list"),
    disagree: cap(byTag(disagree), "Disagree"),
    notes,
    truncated: !!input.truncated,
  };
}

type PgErr = { code?: string; message?: string } | null;
const missingColumn = (e: PgErr) => !!e && (e.code === "42703" || e.code === "PGRST204" || /column [\w."]+ does not exist/i.test(e.message ?? ""));

/** Keyset pages over `id` until an empty window or the ceiling. */
async function pageAll<T extends { id: string }>(
  make: (after: string | null) => PromiseLike<{ data: unknown; error: PgErr }>, ceiling: number,
): Promise<{ rows: T[]; error: PgErr; truncated: boolean }> {
  const rows: T[] = [];
  for (let after: string | null = null; ;) {
    const { data, error } = await make(after);
    if (error) return { rows, error, truncated: false };
    const batch = (data ?? []) as T[];
    if (batch.length === 0) return { rows, error: null, truncated: false };
    rows.push(...batch);
    if (rows.length >= ceiling) return { rows: rows.slice(0, ceiling), error: null, truncated: true };
    after = batch[batch.length - 1].id;
  }
}

export const COVERAGE_CEILING = 50_000;

/** Server: read the rows for one org (service role, filtered per caller)
 *  and build the report. `canRead` answers which controlled documents the
 *  caller may read — the route passes readableControlledDocIds. */
export async function loadCoverage(admin: SupabaseClient, orgId: string, opts: {
  unitCode: string | null;
  canRead: (documentIds: string[]) => Promise<Set<string>>;
}): Promise<CoverageReport> {
  const notes: string[] = [];
  let truncated = false;
  const book = await loadCodebookAdmin(admin, orgId);

  const assets = await pageAll<CoverageAsset & { archived?: boolean }>((after) => {
    let q = admin.from("assets").select("id, tag, tag_normalized, unit_code, code, origin, archived")
      .eq("org_id", orgId).eq("archived", false).order("id", { ascending: true }).limit(1000);
    if (after) q = q.gt("id", after);
    return q;
  }, COVERAGE_CEILING);
  if (assets.error) throw new Error(`the registry could not be read: ${assets.error.message}`);
  truncated ||= assets.truncated;

  // Every indexed copy, ready, with what it mirrors.
  const copies = await pageAll<{ id: string; name: string | null; source_document_id: string | null; source_version_id: string | null; status: string | null }>((after) => {
    let q = admin.from("knowledge_documents").select("id, name, source_document_id, source_version_id, status")
      .eq("org_id", orgId).eq("status", "ready").order("id", { ascending: true }).limit(1000);
    if (after) q = q.gt("id", after);
    return q;
  }, COVERAGE_CEILING);
  if (copies.error) throw new Error(`the indexed documents could not be read: ${copies.error.message}`);

  // The relation (every source), org-wide.
  // With the transcribing model (20261171, GOV-9), the sheet label
  // (20261170), or neither — a missing column is dropped one step at a time.
  type Rel = CoverageRelation & { id: string };
  const readRel = (cols: string) => pageAll<Rel>((after) => {
    let q = admin.from("document_assets").select(cols)
      .eq("org_id", orgId).order("id", { ascending: true }).limit(1000);
    if (after) q = q.gt("id", after);
    return q;
  }, COVERAGE_CEILING);
  let rel = await readRel("id, document_id, asset_id, source, sheet_label, model");
  if (rel.error && missingColumn(rel.error)) rel = await readRel("id, document_id, asset_id, source, sheet_label");
  if (rel.error && missingColumn(rel.error)) rel = await readRel("id, document_id, asset_id, source");
  if (rel.error) throw new Error(`the document↔equipment relation could not be read: ${rel.error.message}`);
  truncated ||= rel.truncated;

  // Controlled documents involved, filtered to what the caller may read.
  const docIds = [...new Set([
    ...rel.rows.map((r) => r.document_id),
    ...copies.rows.map((c) => c.source_document_id).filter((x): x is string => !!x),
  ])];
  const readable = await opts.canRead(docIds);
  const documents: Array<CoverageDocument & { current_version_id?: string | null }> = [];
  const ids = docIds.filter((id) => readable.has(id));
  for (let i = 0; i < ids.length; i += 100) {
    const slice = ids.slice(i, i + 100);
    let res: { data: unknown; error: PgErr } = await admin.from("documents").select("id, document_number, title, library_id, unit_code, current_version_id, status")
      .eq("org_id", orgId).in("id", slice);
    if (res.error && missingColumn(res.error)) {
      res = await admin.from("documents").select("id, document_number, title, library_id, current_version_id, status")
        .eq("org_id", orgId).in("id", slice);
      if (!notes.some((n) => n.includes("20261138"))) notes.push("Drawing units are not decoded yet (migration 20261138), so nothing can disagree.");
    }
    if (res.error) throw new Error(`the documents could not be read: ${res.error.message ?? "error"}`);
    for (const d of (res.data ?? []) as Array<Record<string, unknown>>) {
      if (d.status === "Archived") continue;
      documents.push({
        id: String(d.id), document_number: (d.document_number as string | null) ?? null, title: (d.title as string | null) ?? null,
        library_id: (d.library_id as string | null) ?? null, unit_code: (d.unit_code as string | null) ?? null,
        current_version_id: (d.current_version_id as string | null) ?? null,
      });
    }
  }
  const docById = new Map(documents.map((d) => [d.id, d]));

  // Copies that count: an upload (org-wide, DEC-83), or the CURRENT copy of a
  // readable document (GAP-309: an earlier revision's copy never counts).
  const counted = copies.rows.filter((c) => {
    if (!c.source_document_id) return true;
    const d = docById.get(c.source_document_id);
    if (!d) return false;
    return !d.current_version_id || !c.source_version_id || d.current_version_id === c.source_version_id;
  });
  const copyById = new Map(counted.map((c) => [c.id, c]));
  const sheetTags: CoverageSheetTag[] = [];
  let entityRows = 0;
  const copyIds = counted.map((c) => c.id);
  for (let i = 0; i < copyIds.length && !truncated; i += 100) {
    const slice = copyIds.slice(i, i + 100);
    const ents = await pageAll<{ id: string; document_id: string; tag: string; page: number }>((after) => {
      let q = admin.from("knowledge_page_entities").select("id, document_id, tag, page")
        .in("document_id", slice).in("kind", ["equipment"]).order("id", { ascending: true }).limit(1000);
      if (after) q = q.gt("id", after);
      return q;
    }, COVERAGE_CEILING - entityRows);
    if (ents.error) throw new Error(`the extracted tags could not be read: ${ents.error.message}`);
    entityRows += ents.rows.length;
    if (ents.truncated) truncated = true;
    for (const e of ents.rows) {
      const c = copyById.get(e.document_id);
      if (!c) continue;
      sheetTags.push({ knowledgeDocumentId: c.id, documentId: c.source_document_id, name: c.name ?? "Untitled", tag: e.tag, page: Number(e.page) });
    }
  }
  if (truncated) notes.push(`The report stopped at ${COVERAGE_CEILING.toLocaleString()} rows of one kind — it is partial; narrow it to one unit.`);
  const unreadable = docIds.length - ids.length;
  if (unreadable > 0) notes.push(`${unreadable} document${unreadable === 1 ? " you cannot read is" : "s you cannot read are"} left out.`);

  return buildCoverage({
    assets: assets.rows,
    relations: rel.rows.map((r) => ({
      document_id: r.document_id, asset_id: r.asset_id, source: r.source,
      sheet_label: (r as { sheet_label?: string | null }).sheet_label ?? null, model: (r as { model?: string | null }).model ?? null,
    })),
    documents,
    sheetTags,
    units: book.units.map((u) => ({ code: u.code, label: u.label })),
    unitCode: opts.unitCode,
    notes,
    truncated,
  });
}
