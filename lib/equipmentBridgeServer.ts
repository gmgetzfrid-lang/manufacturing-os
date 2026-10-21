// lib/equipmentBridgeServer.ts — THE BRIDGE: AI-extracted equipment tags on
// P&IDs flow into (1) the equipment registry, (2) the document↔equipment
// RELATION (document_assets, source 'drawing'), and (3) the source
// document's own equipment column when one is mapped.
//
// Pipeline per controlled document (runs on ingest completion + on demand for
// backlogs):
//   gather   — the extracted equipment entities of every knowledge copy of
//              the document that is READY and at its CURRENT revision (BR-14:
//              merged, never last-writer-wins; GAP-309: a superseded copy
//              never feeds current state), plus each page's title-block
//              identity (kind 'self') — the SHEET ADDRESS (GAP-301)
//   locate   — which operating unit: the codebook decode of the document's
//              own number, then the library's default — either one only when
//              the Site Codebook holds that unit (CB-1); never a filename
//   translate— tag + unit → full site code (E-22 in 20 → 2030.22), re-derived
//              at apply, never read back from the stored proposal (CB-2)
//   reconcile— match each tag against the registry by the one tag grammar
//              (tagKey, GAP-310); unmatched tags become DISCOVERED assets on
//              apply (origin 'drawing', full provenance) — with or without a
//              mapped column (AREA-4 / GAP-307); a tag the Site Codebook's
//              equipment types do not know is HELD for review, never minted
//              (BR-13)
//   relate   — write a document_assets row per applied tag: source 'drawing',
//              the sheet address, the pages, who asserted it (a machine), the
//              model when a page was AI-transcribed, the revision it was read
//              from (GAP-304 / GAP-303)
//   populate — merge tags into the mapped tags-column on the source document
//              (metadata arrays; manual entries are never removed) — KEPT:
//              the library's chips render from it
//
// Invariants:
//   * Idempotent — apply skips tags already applied or dismissed unless a
//     person names them again (BR-5); re-running a sweep re-derives the same
//     rows; a relation row is refreshed, never duplicated.
//   * Additive only — the bridge never deletes a tag a human typed; a tag a
//     person removed from the column is remembered as dismissed (BR-5).
//   * Never auto-removed — a tag that no longer appears on the current
//     revision marks its relation `vanished_at` for review (GAP-309).
//   * Honest degradation — no codebook → tags still flow (no codes/units);
//     a degraded insert says what it dropped; a database without the
//     relation's vocabulary (20261170) or its provenance (20261171) says the
//     relation was not recorded and keeps today's column write — a 'drawing'
//     row is never written without who asserted it and which revision it was
//     read from (99-fix-sequencing Phase 2: GAP-303 before GAP-304).
//   * Everything audited — applied runs, discovered assets and every human
//     decision on a machine reading (dismiss, vanished review) write an
//     audit_logs row: a correction is a row, never an overwrite (GAP-303);
//     an audit row that cannot be written is reported to the caller.
//   * AI-derived data never drives a hold, an MOC or a compliance artifact:
//     nothing here writes one.

import type { SupabaseClient } from "@supabase/supabase-js";
import { loadCodebookAdmin } from "@/lib/codebookServer";
import {
  normalizeTag, splitTag, tagToCode, parseDrawingNumber, typeForTag, typeCandidatesForTag, tagKey,
  type Codebook,
} from "@/lib/codebook";
import { extractEquipmentTags } from "@/lib/drawingText";

/** One sheet a tag was read on (GAP-301): the site's sheet address from that
 *  page's own title block, or only the page when it declared none. */
export interface BridgeSheet {
  page: number;
  /** "2002-D-10001 SHT 4" — the drawing number and sheet the title block
   *  declares; null when the page declared no drawing number. */
  label: string | null;
  drawingNumber: string | null;
  sheet: string | null;
  /** The revision the title block declares on that page. */
  rev: string | null;
  /** The page's text was an AI model's transcription (GOV-9): its title
   *  block is a reading, not an identity — shown as unconfirmed. */
  aiRead: boolean;
}

export interface BridgeSuggestion {
  tag: string;              // normalized display form ("E-22")
  code: string | null;      // site code when derivable ("2030.22")
  /** PDF page numbers the tag was read on (not sheet numbers — see sheets). */
  pages: number[];
  assetId: string | null;   // existing registry match
  assetStatus: "existing" | "new";
  /** GAP-301: the sheet address of each page, from its title block. */
  sheets?: BridgeSheet[];
  /** BR-13: a NEW tag whose prefix no Site Codebook equipment type claims —
   *  held for a person, never created by a bulk or automatic apply. */
  held?: "unknown_prefix" | null;
  /** BR-9: a person rejected this tag (it stays out of every apply). */
  dismissed?: boolean;
  /** The AI model that transcribed a page the tag was read on (null: the
   *  PDF's own text layer). */
  model?: string | null;
  /** BR-5: the mapped column the Bridge wrote this tag into when it was
   *  applied (null: none was mapped). A person removing it from that column
   *  is a rejection — recorded as a dismissal, its relation removed. */
  appliedColumn?: string | null;
}

export interface BridgeConfig {
  targetColumnKey?: string;
  autoApply?: boolean;
  defaultUnitCode?: string;
  /** Discovery mode — create registry assets for unmatched tags on apply.
   *  Defaults ON: the drawings build the registry. */
  createAssets?: boolean;
  /** BR-8: who turned auto-apply on — the accountable identity an automatic
   *  apply's discovered assets carry (never the nil UUID when known). */
  autoApplyBy?: string;
  /** BR-9: the first time a person applied or dismissed in this library. An
   *  automatic apply with no mapped column waits for it (reviewed once). */
  reviewedAt?: string;
  reviewedBy?: string;
}

/** BR-9 / BR-5: a tag a person rejected, remembered across recomputes. */
export interface BridgeDismissal {
  tag: string;
  by: string | null;
  at: string;
  /** 'review': dismissed in the sweep; 'column': removed from the mapped
   *  column after the Bridge applied it. */
  via: "review" | "column";
  /** The knowledge revision (source_version_id) it was dismissed on. */
  revision: string | null;
  /** The revision on which the tag was first no longer read — a later
   *  revision that brings it back re-proposes it. */
  absentSince?: string | null;
}

/** BR-14: a knowledge copy the proposal was computed from. */
export interface BridgeSource {
  knowledgeDocumentId: string;
  status: string | null;
  sourceVersionId: string | null;
  sourceRev: string | null;
  /** True when the copy was ready, at the current revision, and read whole. */
  used: boolean;
  why?: string;
}

export type ComputeReason =
  | "computed" | "no_entities" | "upload_origin" | "no_twin" | "twin_not_ready" | "twin_stale" | "not_found";

export interface ComputeResult {
  documentId: string | null;
  suggestions: BridgeSuggestion[];
  autoApplied: boolean;
  reason: ComputeReason;
  /** The decoded unit, its source, and a code the codebook does not hold. */
  unitCode?: string | null;
  unitSource?: "document_number" | "library_default" | null;
  unitRejected?: string | null;
  /** GAP-309: relations marked vanished / back / superseded by this compute. */
  revision?: { vanished: number; reappeared: number; superseded: number; complete: boolean; skipped?: string; failed?: number };
  /** BR-11: a slab that stopped at its ceiling — the proposal is partial. */
  truncated?: boolean;
  knowledgeDocumentId?: string | null;
  /** BR-5: applied tags a person removed from their column — dismissed (via
   *  'column') by this compute, their relations removed. */
  columnDismissed?: string[];
  /** GAP-304: what this compute's relation refresh did (the backfill of tags
   *  applied before the relation existed, and the revision each row was read
   *  from) — `notRecorded` says why nothing was written. Absent when no
   *  applied tag is read on this revision. */
  relations?: RelationOutcome;
  /** The audit row recording a correction could not be written. */
  auditError?: string;
}

/** What removing 'drawing' relations did (a person's correction). */
export interface RemovalOutcome {
  /** Machine readings removed from the relation. */
  removed: number;
  /** Of them, pairs the document's own asset_tags still names: the row
   *  became the person's synced link (jsonb_sync) instead of disappearing —
   *  the resync trigger had skipped it while the drawing row held the pair. */
  keptAsPersonsLink: number;
  /** The audit row recording the correction could not be written. */
  auditError?: string;
}

export interface RelationOutcome {
  /** New 'drawing' rows. */
  written: number;
  /** 'drawing' rows refreshed (sheet, pages, revision). */
  refreshed: number;
  /** Pairs a person already linked (jsonb_sync / manual) — left as they are. */
  keptHuman: number;
  /** Why no relation was recorded (20261170 or 20261171 not applied, a
   *  refused write), or null. */
  notRecorded: string | null;
}

export interface ApplyResult {
  appliedTags: string[];
  createdAssets: number;
  codesLeftBlank: string[];
  /** AREA-4 / BR-3: discovered assets whose insert lost columns on a
   *  pre-migration database — what each one dropped. */
  degraded: Array<{ tag: string; dropped: string[] }>;
  /** Tags whose asset could not be created or resolved, with the reason. */
  failed: Array<{ tag: string; reason: string }>;
  /** BR-13: new tags held (unknown prefix) — named, never minted. */
  held: string[];
  relations: RelationOutcome;
  /** The mapped column, or null when none is mapped (discovery and the
   *  relation still ran). */
  column: string | null;
  /** BR-7: codes filled on assets that had a unit but no code. */
  codesFilled: number;
  /** The proposal row's update failed — the work above landed. */
  ledgerError?: string;
  /** The EQUIPMENT_BRIDGE_APPLIED audit row could not be written — the work
   *  above landed. */
  auditError?: string;
}

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

/** GAP-310: the registry's identity key — the one tag grammar (tagKey is
 *  the database's normalize_tag()). Exported for the awkward-input
 *  agreement table (lib/__tests__/codebook.test.ts). */
export const assetNorm = (tag: string) => tagKey(tag);

/** CB-10 (20261128): another asset already carries this site code — the
 *  unique index, or the one-holder trigger's refusal of an UPDATE. */
const siteCodeTaken = (e: { message?: string } | null | undefined) =>
  !!e && /assets_org_code_unique/.test(e.message ?? "");

type PgErr = { code?: string; message?: string } | null | undefined;
const missingColumn = (e: PgErr) =>
  !!e && (e.code === "42703" || e.code === "PGRST204" || /column [\w."]+ does not exist|could not find the .* column/i.test(e.message ?? ""));
/** A pre-migration database: the TABLE is missing (42P01 / PGRST205) —
 *  never a missing column. */
const missingTable = (e: PgErr): boolean => {
  // 42703 / PGRST204 is a missing COLUMN — on an INSERT / UPDATE its text is
  // 'column "x" of relation "y" does not exist', which the relation test
  // below would otherwise match (IRLS-12's residual: 42P01 only, never 42703).
  if (!e || e.code === "42703" || e.code === "PGRST204") return false;
  const m = e.message ?? "";
  if (/column "?[\w.]+"? of relation/i.test(m)) return false;
  return e.code === "42P01" || e.code === "PGRST205"
    || /relation "?[\w.]+"? does not exist/i.test(m)
    || /could not find the table/i.test(m);
};
const checkViolation = (e: PgErr) => !!e && e.code === "23514";
const uniqueViolation = (e: PgErr) => !!e && e.code === "23505";

const PROVENANCE_COLS = ["asserted_by", "model", "source_revision", "source_version_id", "vanished_at", "superseded_at", "presence_confirmed_on"] as const;
/** The relation's provenance (20261171) is missing: the write named one of
 *  its columns and the database does not have it. */
const missingProvenance = (e: PgErr) => missingColumn(e) && PROVENANCE_COLS.some((c) => (e?.message ?? "").includes(c));
/** Every provenance / revision-truth column (20261171) reset to what a
 *  person's link carries — used when a machine row becomes a person's. */
const HUMAN_PROVENANCE = (userId: string | null): Record<string, unknown> => ({
  asserted_by: "human", asserted_by_user: userId, model: null, source_revision: null, source_version_id: null,
  vanished_at: null, superseded_at: null, presence_confirmed_on: null,
});
const LEDGER_COLS_20261171 = ["dismissed", "sources", "applied_columns"] as const;

/** Rows per window and the ceiling of one entity slab (BR-11). */
const PAGE_ROWS = 1000;
export const ENTITY_CEILING = 20000;

// ─── Pure helpers (exported for tests) ──────────────────────────────────────

/** The title block a page declared, from the 'self' entity's raw line
 *  ("DWG 2002-D-10001 SH 4 REV B", lib/knowledgeIngest.ts). */
export function parseSelfRaw(raw: string | null | undefined): { drawingNumber: string | null; sheet: string | null; rev: string | null } {
  const s = String(raw ?? "").trim();
  const m = s.match(/^DWG\s+(\S+)(?:\s+SH\s+(\S+))?(?:\s+REV\s+(\S+))?\s*$/i);
  if (!m) return { drawingNumber: null, sheet: null, rev: null };
  return { drawingNumber: m[1], sheet: m[2] ?? null, rev: m[3] ?? null };
}

/** GAP-301 acceptance 1 — given a page's 'self' rows, the site sheet address.
 *  A sheet-addressed row (`<DWG>-SH<n>`) names the sheet; the raw line also
 *  carries the declared revision. Null label when the page declared none. */
export function sheetAddressForPage(
  page: number,
  selfRows: ReadonlyArray<{ tag: string; raw?: string | null }>,
  aiRead: boolean,
): BridgeSheet {
  let drawingNumber: string | null = null;
  let sheet: string | null = null;
  let rev: string | null = null;
  for (const r of selfRows) {
    const fromRaw = parseSelfRaw(r.raw);
    const sh = String(r.tag ?? "").match(/^(.*)-SH(\w+)$/);
    if (sh) { drawingNumber = drawingNumber ?? sh[1]; sheet = sheet ?? sh[2]; }
    else if (r.tag) drawingNumber = drawingNumber ?? String(r.tag);
    if (fromRaw.drawingNumber) drawingNumber = drawingNumber ?? fromRaw.drawingNumber;
    if (fromRaw.sheet) sheet = sheet ?? fromRaw.sheet;
    if (fromRaw.rev) rev = rev ?? fromRaw.rev;
  }
  const label = drawingNumber ? (sheet ? `${drawingNumber} SHT ${sheet}` : drawingNumber) : null;
  return { page, label, drawingNumber, sheet, rev, aiRead };
}

/** How a sheet reads to a person: the address, or the page with that fact
 *  stated; an AI-transcribed title block is marked unconfirmed (GOV-9). */
export function sheetText(s: Pick<BridgeSheet, "page" | "label" | "aiRead">): string {
  if (!s.label) return `page ${s.page} (no title block read)`;
  return s.aiRead ? `${s.label} (AI-read, unconfirmed)` : s.label;
}

/** The stored sheet_label for a relation: the distinct addresses, in page
 *  order ("2002-D-10001 SHT 4, SHT 7"), or null when no page declared one. */
export function relationSheetLabel(sheets: ReadonlyArray<BridgeSheet> | undefined): string | null {
  const labels: string[] = [];
  for (const s of [...(sheets ?? [])].sort((a, b) => a.page - b.page)) {
    if (s.label && !labels.includes(s.label)) labels.push(s.label);
  }
  if (labels.length === 0) return null;
  // Same drawing number, several sheets: "2002-D-10001 SHT 4, SHT 7".
  const out: string[] = [];
  let lastBase: string | null = null;
  for (const l of labels) {
    const m = l.match(/^(.*) SHT (\S+)$/);
    if (m && m[1] === lastBase) out.push(`SHT ${m[2]}`);
    else { out.push(l); lastBase = m ? m[1] : null; }
  }
  return out.join(", ");
}

/** BR-13: the extractor's own vocabulary re-applied at the registry boundary
 *  — the stop list, the drawing-number-middle guard and the line-number
 *  grammar of lib/drawingText.ts extractEquipmentTags. A tag it would not
 *  extract from its own text never crosses. */
export function passesExtractorGate(tag: string): boolean {
  const norm = normalizeTag(tag);
  return extractEquipmentTags(norm).some((h) => h.tag === norm);
}

/** BR-13: the Site Codebook knows prefixes once any equipment type declares
 *  one; a new tag no type claims is then held, not minted. An empty codebook
 *  has no opinion (today's behaviour: the tag is created untyped). */
export function heldForUnknownPrefix(tag: string, book: Codebook): boolean {
  const knowsPrefixes = book.equipmentTypes.some((t) => (t.meta.tagPrefixes ?? []).some((p) => p.trim().length > 0));
  if (!knowsPrefixes) return false;
  return typeCandidatesForTag(tag, book).length === 0;
}

/** CB-1: a unit code is usable only when the Site Codebook holds it. */
export function heldUnit(code: string | null | undefined, book: Codebook): string | null {
  const c = String(code ?? "").trim();
  if (!c) return null;
  return book.units.some((u) => u.code === c) ? c : null;
}

/** CB-1: which unit a controlled document is in — the codebook decode of its
 *  OWN number (never a filename or a title: those are not drawing numbers),
 *  then the library's configured default; either only when the codebook
 *  holds the unit. A decoded code it does not hold is reported, not used. */
export function locateUnit(documentNumber: string | null | undefined, defaultUnitCode: string | null | undefined, book: Codebook): {
  unitCode: string | null; source: "document_number" | "library_default" | null; rejected: string | null;
} {
  const num = String(documentNumber ?? "").trim();
  let rejected: string | null = null;
  if (num) {
    const parsed = parseDrawingNumber(num, book);
    if (parsed?.unitCode) {
      if (heldUnit(parsed.unitCode, book)) return { unitCode: parsed.unitCode, source: "document_number", rejected: null };
      rejected = parsed.unitCode;
    }
  }
  const def = heldUnit(defaultUnitCode, book);
  if (def) return { unitCode: def, source: "library_default", rejected };
  if (!rejected && defaultUnitCode && !def) rejected = String(defaultUnitCode);
  return { unitCode: null, source: null, rejected };
}

/** The tags currently in a mapped metadata column (array or comma list). */
export function columnTags(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((v) => String(v).trim()).filter(Boolean)
    : typeof value === "string" && value.trim()
      ? value.split(",").map((v) => v.trim()).filter(Boolean)
      : [];
}

/** BR-9 / BR-5: carry the dismissals across a recompute. A dismissed tag
 *  that is no longer read is marked absent on this revision; one a LATER
 *  revision brings back after it had left is re-proposed (the dismissal
 *  lapses). A tag read again on the same revision it went missing on was an
 *  extraction miss: it stays dismissed. */
export function planDismissals(input: {
  existing: ReadonlyArray<BridgeDismissal>;
  presentTags: ReadonlySet<string>;
  revision: string | null;
  now: string;
}): { dismissed: BridgeDismissal[]; lapsed: string[] } {
  const out: BridgeDismissal[] = [];
  const lapsed: string[] = [];
  for (const d of input.existing) {
    const present = input.presentTags.has(d.tag);
    if (!present) {
      out.push({ ...d, absentSince: d.absentSince ?? input.revision ?? input.now });
      continue;
    }
    if (d.absentSince && input.revision && d.absentSince !== input.revision) {
      lapsed.push(d.tag); // the tag left the sheet and a later revision brought it back
      continue;
    }
    out.push({ ...d, absentSince: null });
  }
  return { dismissed: out, lapsed };
}

/** BR-5: applied tags a person has since removed from the document's tag
 *  columns, and where every other applied tag now is.
 *
 *  The column each applied tag was written into is recorded per tag in the
 *  ledger (`applied_columns`, carried across every recompute whether or not
 *  the tag is read this time; null — none was mapped — never counts). A tag
 *  counts as removed only when it is absent from EVERY tag column the
 *  document holds (the library's tag-type columns, the mapped and the
 *  recorded column, and any array-valued metadata key), and never when the
 *  recorded column's key is gone from the document (a re-map or a dropped
 *  column, not a person's removal) — so a column re-map never reads as mass
 *  removals. A tag applied before the column was recorded is stamped with
 *  the column it is found in (the mapped one first); found in none while the
 *  document holds tag columns, it was removed; on a document holding none it
 *  is left as it is. Compared by the one tag grammar. Tags already
 *  dismissed are not re-planned. */
export function planColumnRemovals(input: {
  applied: ReadonlyArray<string>;
  dismissed: ReadonlySet<string>;
  /** tag → the column the Bridge wrote it into; absent: not recorded. */
  recordedColumn: ReadonlyMap<string, string | null>;
  mappedColumn: string | null | undefined;
  /** The library's tag-type columns (tags / multi / pill). */
  tagColumns?: ReadonlyArray<string>;
  metadata: Record<string, unknown> | null | undefined;
}): { removed: string[]; columns: Map<string, string | null> } {
  const meta = input.metadata && typeof input.metadata === "object" ? input.metadata : {};
  const holds = (k: string) => Object.prototype.hasOwnProperty.call(meta, k);
  // The tag columns the document holds (a historical tag can only have been
  // removed from one of these) …
  const tagCols = [...new Set<string>([
    ...(input.mappedColumn ? [input.mappedColumn] : []),
    ...(input.tagColumns ?? []),
    ...[...input.recordedColumn.values()].filter((c): c is string => !!c),
  ])].filter(holds);
  // … and everywhere a tag counts as still present (any array-valued key too:
  // a column the library no longer declares still holds what it holds).
  const held = [...new Set([...tagCols, ...Object.keys(meta).filter((k) => Array.isArray(meta[k]))])];
  const keysIn = new Map(held.map((k) => [k, new Set(columnTags(meta[k]).map((t) => tagKey(t)))]));
  const foundIn = (tag: string, prefer: Array<string | null | undefined>): string | null => {
    const key = tagKey(tag);
    for (const k of [...prefer.filter((p): p is string => !!p && keysIn.has(p)), ...held]) {
      if (keysIn.get(k)?.has(key)) return k;
    }
    return null;
  };
  const removed: string[] = [];
  const columns = new Map<string, string | null>();
  for (const tag of input.applied) {
    const recorded = input.recordedColumn.has(tag);
    const column = recorded ? input.recordedColumn.get(tag) ?? null : null;
    if (input.dismissed.has(tag)) { if (recorded) columns.set(tag, column); continue; }
    if (recorded && column === null) { columns.set(tag, null); continue; } // applied with no column mapped
    const where = foundIn(tag, [column, input.mappedColumn]);
    if (where) { columns.set(tag, where); continue; }
    if (recorded) {
      columns.set(tag, column);
      if (column && holds(column)) removed.push(tag); // the key is there and the tag is nowhere
      continue;
    }
    if (tagCols.length > 0) removed.push(tag);        // historical: in none of the columns it could be in
  }
  return { removed, columns };
}

/** BR-14 / GAP-309: the knowledge copies that feed the Bridge — ready, and
 *  at the document's current revision (or carrying no revision); one rule
 *  for the compute and for every apply or review that stamps a revision. */
function classifyCopies(twins: ReadonlyArray<TwinRow>, current: string | null): BridgeSource[] {
  return twins.map((t) => {
    if (t.status !== "ready") return { knowledgeDocumentId: t.id, status: t.status, sourceVersionId: t.source_version_id, sourceRev: t.source_rev, used: false, why: "not indexed yet" };
    if (current && t.source_version_id && t.source_version_id !== current) {
      return { knowledgeDocumentId: t.id, status: t.status, sourceVersionId: t.source_version_id, sourceRev: t.source_rev, used: false, why: "an earlier revision" };
    }
    return { knowledgeDocumentId: t.id, status: t.status, sourceVersionId: t.source_version_id, sourceRev: t.source_rev, used: true };
  });
}

/** The revision the used copies were read from (id and label). A copy that
 *  carries no revision id says nothing about which revision it read — the
 *  revision is then not known (null), never assumed to be the document's
 *  current one: a legacy copy holding an earlier revision's text would
 *  otherwise stamp its reading as the current revision's, and the
 *  superseded mark could never fire for it. */
function readingOf(used: ReadonlyArray<TwinRow>): { revision: string | null; versionId: string | null } {
  return {
    versionId: used.find((t) => t.source_version_id)?.source_version_id ?? null,
    revision: used.find((t) => t.source_rev)?.source_rev ?? null,
  };
}

const parseDismissals = (v: unknown): BridgeDismissal[] =>
  Array.isArray(v)
    ? (v as Array<Record<string, unknown>>).filter((d) => d && typeof d.tag === "string").map((d) => ({
        tag: String(d.tag), by: (d.by as string | null) ?? null, at: String(d.at ?? ""),
        via: d.via === "column" ? "column" : "review", revision: (d.revision as string | null) ?? null,
        absentSince: (d.absentSince as string | null) ?? null,
      }))
    : [];

// ─── Reads ──────────────────────────────────────────────────────────────────

export type Builder = PromiseLike<{ data: unknown; error: PgErr }> & { range: (a: number, b: number) => Builder };

/** Read one ordered query window by window until an empty window or the
 *  ceiling (BR-11: never one capped slab presented as whole). Each window
 *  starts where the rows read so far end — a window PostgREST cut at its
 *  max-rows (no error) skips nothing. Exported for the sheets route, whose
 *  'extracted' read follows the same rule. */
export async function readWindows<T>(make: () => Builder, ceiling: number): Promise<{ rows: T[]; error: PgErr; truncated: boolean }> {
  const rows: T[] = [];
  for (;;) {
    const from = rows.length;
    const { data, error } = await make().range(from, from + PAGE_ROWS - 1);
    if (error) return { rows, error, truncated: false };
    const batch = (data ?? []) as T[];
    rows.push(...batch);
    if (batch.length === 0) return { rows, error: null, truncated: false };
    if (rows.length >= ceiling) return { rows: rows.slice(0, ceiling), error: null, truncated: true };
  }
}

/** Read every row of one query, keyset-paged on `id` until an EMPTY page —
 *  PostgREST cuts a response at its max-rows without an error, so a short
 *  page is not proof of the end (BR-11). */
async function pageById<T extends { id: string }>(
  make: (after: string | null) => PromiseLike<{ data: unknown; error: PgErr }>,
): Promise<{ rows: T[]; error: PgErr }> {
  const rows: T[] = [];
  for (let after: string | null = null; ;) {
    const { data, error } = await make(after);
    if (error) return { rows, error };
    const batch = (data ?? []) as T[];
    if (batch.length === 0) return { rows, error: null };
    rows.push(...batch);
    const last = String(batch[batch.length - 1].id);
    if (last === after) return { rows, error: null }; // a store that ignores the keyset: stop, never loop
    after = last;
  }
}

/** A library's Bridge settings and its tag-type columns (the columns a tag
 *  can sit in: type tags / multi, or pill-style). `error` is a read that
 *  failed — an unread configuration is not an empty one (no column, discovery
 *  on): every caller refuses to act on it. */
export interface LibraryBridge { config: BridgeConfig | null; tagColumns: string[]; error: string | null }

export async function loadBridgeConfig(admin: SupabaseClient, libraryId: string): Promise<LibraryBridge> {
  if (!libraryId) return { config: null, tagColumns: [], error: null };
  let res: { data: unknown; error: PgErr } = await admin.from("libraries").select("equipment_bridge, custom_columns").eq("id", libraryId).maybeSingle();
  if (res.error && missingColumn(res.error)) {
    res = await admin.from("libraries").select("equipment_bridge").eq("id", libraryId).maybeSingle();
  }
  if (res.error) return { config: null, tagColumns: [], error: res.error.message ?? "read failed" };
  const row = (res.data ?? null) as { equipment_bridge?: unknown; custom_columns?: unknown } | null;
  const raw = row?.equipment_bridge as BridgeConfig | null | undefined;
  const cols = Array.isArray(row?.custom_columns) ? (row!.custom_columns as Array<Record<string, unknown>>) : [];
  return {
    config: raw && typeof raw === "object" ? raw : null,
    tagColumns: cols.filter((c) => c && typeof c.key === "string" && (c.type === "tags" || c.type === "multi" || c.isPill === true)).map((c) => String(c.key)),
    error: null,
  };
}

/** An automatic apply acts when a column is mapped (as it always did), or —
 *  with no column — once a person has reviewed the library (BR-9). */
export function autoApplyActs(bridge: BridgeConfig | null): boolean {
  return !!bridge?.autoApply && (!!bridge.targetColumnKey || !!bridge.reviewedAt);
}

type TwinRow = {
  id: string; status: string | null; source_version_id: string | null; source_rev: string | null;
  vision_failed_pages?: number[] | null; name?: string | null;
};

async function readTwins(admin: SupabaseClient, orgId: string, documentId: string): Promise<TwinRow[]> {
  const base = "id, status, source_version_id, source_rev, name";
  let res: { data: unknown; error: PgErr } = await admin.from("knowledge_documents").select(`${base}, vision_failed_pages`)
    .eq("org_id", orgId).eq("source_document_id", documentId);
  if (res.error && missingColumn(res.error)) {
    res = await admin.from("knowledge_documents").select(base).eq("org_id", orgId).eq("source_document_id", documentId);
  }
  return ((res.data ?? []) as TwinRow[]);
}

type EntityRow = { document_id: string; tag: string; page: number; kind: string; raw?: string | null };

// ─── Compute ────────────────────────────────────────────────────────────────

/** Ingest's entry: a knowledge document reached 'ready'. A copy of a
 *  controlled document recomputes that document from every current copy
 *  (BR-14). An upload-origin document has no controlled document to feed —
 *  said, never a silent null (BR-3); its tags reach the registry through the
 *  coverage report's sheet-only list (GAP-307). */
export async function computeForKnowledgeDoc(admin: SupabaseClient, knowledgeDocId: string): Promise<ComputeResult | null> {
  const { data: kdoc } = await admin
    .from("knowledge_documents")
    .select("id, org_id, library_id, name, source_document_id")
    .eq("id", knowledgeDocId).maybeSingle();
  if (!kdoc) return null;
  if (!kdoc.source_document_id) {
    return { documentId: null, suggestions: [], autoApplied: false, reason: "upload_origin", knowledgeDocumentId: String(kdoc.id) };
  }
  const orgId = String((kdoc as Record<string, unknown>).org_id);
  const out = await computeForDocument(admin, orgId, String(kdoc.source_document_id), { trigger: "ingest" });
  return { ...out, knowledgeDocumentId: String(kdoc.id) };
}

export async function computeForDocument(admin: SupabaseClient, orgId: string, documentId: string, opts: { trigger?: "ingest" | "sweep" } = {}): Promise<ComputeResult> {
  const empty = (reason: ComputeReason): ComputeResult => ({ documentId, suggestions: [], autoApplied: false, reason });
  const { data: srcDoc } = await admin
    .from("documents").select("id, org_id, library_id, document_number, title, name, metadata, current_version_id")
    .eq("id", documentId).eq("org_id", orgId).maybeSingle();
  if (!srcDoc) return empty("not_found");

  // ── gather: every knowledge copy that is ready AND at the current revision.
  const twins = await readTwins(admin, orgId, documentId);
  if (twins.length === 0) return empty("no_twin");
  const current = (srcDoc as { current_version_id?: string | null }).current_version_id ?? null;
  const sources = classifyCopies(twins, current);
  const used = twins.filter((t) => sources.find((s) => s.knowledgeDocumentId === t.id)?.used);
  if (used.length === 0) {
    // BR-14: a copy still indexing (or one an earlier revision left behind)
    // never downgrades a complete computation — the proposal stays as it is.
    return empty(twins.some((t) => t.status === "ready") ? "twin_stale" : "twin_not_ready");
  }
  const usedIds = used.map((t) => t.id);
  const { versionId: revision, revision: revisionLabel } = readingOf(used);

  const ents = await readWindows<EntityRow>(() => admin
    .from("knowledge_page_entities")
    .select("id, document_id, tag, page, kind, raw")
    .in("document_id", usedIds)
    .in("kind", ["equipment", "self"])
    .order("id", { ascending: true }) as unknown as Builder, ENTITY_CEILING);
  // A window that failed is not a reading: the rows read so far are a part
  // of the sheet. Nothing is written from it — the stored proposal and every
  // relation stay as they are, and the sweep counts the document as failed.
  if (ents.error) throw new Error(`The drawing's extracted equipment could not be read: ${ents.error.message ?? "read failed"}`);

  // GOV-9: which pages an AI model transcribed (their title blocks are
  // readings, never identities). A missing column (before 20261122) means
  // nothing recorded; any other failure fails toward the warning — and the
  // reading is then not complete enough to say a tag left the sheet.
  const aiPages = new Map<string, string | null>(); // `${doc}:${page}` → model
  let aiUnknown = false;
  let visionReadFailed = false;
  {
    const v = await readWindows<{ document_id: string; page: number; source_model: string | null }>(() => admin
      .from("knowledge_chunks").select("id, document_id, page, source_model")
      .in("document_id", usedIds).eq("source", "vision")
      .order("id", { ascending: true }) as unknown as Builder, ENTITY_CEILING);
    if (v.error && !missingColumn(v.error)) { aiUnknown = true; visionReadFailed = true; }
    for (const c of v.rows) aiPages.set(`${c.document_id}:${c.page}`, c.source_model ?? null);
  }
  const pageAiRead = (doc: string, page: number) => aiUnknown || aiPages.has(`${doc}:${page}`);

  // ── the sheet address of every page (GAP-301) — merged over the copies.
  const selfByPage = new Map<number, Array<{ tag: string; raw?: string | null; doc: string }>>();
  for (const e of ents.rows) {
    if (e.kind !== "self" || !Number.isFinite(e.page)) continue;
    (selfByPage.get(e.page) ?? selfByPage.set(e.page, []).get(e.page)!).push({ tag: e.tag, raw: e.raw, doc: e.document_id });
  }
  const sheetCache = new Map<number, BridgeSheet>();
  const sheetFor = (page: number, doc: string): BridgeSheet => {
    const hit = sheetCache.get(page);
    if (hit) return hit;
    const rows = selfByPage.get(page) ?? [];
    // Prefer a copy whose page was read from its text layer.
    const textRows = rows.filter((r) => !pageAiRead(r.doc, page));
    const pick = textRows.length > 0 ? textRows : rows;
    const ai = pick.length > 0 ? pick.every((r) => pageAiRead(r.doc, page)) : pageAiRead(doc, page);
    const s = sheetAddressForPage(page, pick, ai);
    sheetCache.set(page, s);
    return s;
  };

  // ── tags, merged over the copies (BR-14), through the extractor's gate (BR-13).
  const byTag = new Map<string, { pages: Set<number>; models: Set<string> }>();
  for (const e of ents.rows) {
    if (e.kind !== "equipment") continue;
    const norm = normalizeTag(String(e.tag));
    if (!splitTag(norm)) continue;           // only things shaped like real tags cross the bridge
    if (!passesExtractorGate(norm)) continue; // and only what the extractor itself would read
    const cur = byTag.get(norm) ?? { pages: new Set<number>(), models: new Set<string>() };
    if (Number.isFinite(e.page)) {
      cur.pages.add(Number(e.page));
      const model = aiPages.get(`${e.document_id}:${e.page}`);
      if (model) cur.models.add(model);
      else if (aiUnknown) cur.models.add("unknown");
    }
    byTag.set(norm, cur);
  }

  // An unread configuration is not an empty one: computed without it, the
  // proposal would lose the library's default unit, the column plan below
  // would run against no mapping, and an auto-apply would act with discovery
  // on whatever the library chose. Nothing is written; the sweep counts the
  // document failed and the next one retries.
  const lib = await loadBridgeConfig(admin, String(srcDoc.library_id ?? ""));
  if (lib.error) throw new Error(`The library's equipment-sweep settings could not be read: ${lib.error} — nothing was computed.`);
  const bridge = lib.config;
  const { data: existingRow, error: ledgerReadErr } = await readLedgerRow(admin, orgId, documentId);
  // An unread ledger is not an empty one: writing over it would forget what
  // was applied and what people dismissed.
  if (ledgerReadErr) throw new Error(`The stored proposal could not be read: ${ledgerReadErr.message ?? "read failed"}`);
  const applied: string[] = Array.isArray(existingRow?.applied) ? (existingRow!.applied as string[]) : [];
  const now = new Date().toISOString();
  const plan = planDismissals({
    existing: parseDismissals(existingRow?.dismissed),
    presentTags: new Set(byTag.keys()),
    revision,
    now,
  });
  // A lapsed dismissal is re-proposed whole: it leaves `applied` too.
  const appliedNext = applied.filter((t) => !plan.lapsed.includes(t));
  // BR-5: the column each applied tag was written into, carried across every
  // recompute in the ledger's own map (`applied_columns`, 20261171) — whether
  // or not the tag is read this time — with the suggestion's copy as the
  // fallback (before 20261171, and rows written before the map existed). A
  // tag a person removed from every tag column is a rejection, remembered as
  // a dismissal (via 'column') and taken off the relation below.
  const recordedColumn = new Map<string, string | null>();
  const ledgerColumns = existingRow?.applied_columns;
  if (ledgerColumns && typeof ledgerColumns === "object" && !Array.isArray(ledgerColumns)) {
    for (const [tag, col] of Object.entries(ledgerColumns as Record<string, unknown>)) {
      if (appliedNext.includes(tag)) recordedColumn.set(tag, typeof col === "string" && col ? col : null);
    }
  }
  for (const s of (Array.isArray(existingRow?.suggested) ? existingRow!.suggested : []) as Array<Record<string, unknown>>) {
    if (s && typeof s.tag === "string" && "appliedColumn" in s && appliedNext.includes(s.tag) && !recordedColumn.has(s.tag)) {
      recordedColumn.set(s.tag, (s.appliedColumn as string | null) ?? null);
    }
  }
  const columnPlan = planColumnRemovals({
    applied: appliedNext,
    dismissed: new Set(plan.dismissed.map((d) => d.tag)),
    recordedColumn,
    mappedColumn: bridge?.targetColumnKey ?? null,
    tagColumns: lib.tagColumns,
    metadata: (srcDoc as { metadata?: Record<string, unknown> | null }).metadata ?? null,
  });
  const columnRemoved = columnPlan.removed;
  const appliedColumns = columnPlan.columns;
  const dismissalsNext: BridgeDismissal[] = [
    ...plan.dismissed,
    ...columnRemoved.map((tag) => ({
      tag, by: null, at: now, via: "column" as const, revision,
      absentSince: byTag.has(tag) ? null : revision ?? now,
    })),
  ];
  const dismissedTags = new Set(dismissalsNext.map((d) => d.tag));

  // ── locate (CB-1) and reconcile (GAP-310).
  const book = await loadCodebookAdmin(admin, orgId);
  const unit = locateUnit(srcDoc.document_number as string | null, bridge?.defaultUnitCode, book);
  const keys = [...byTag.keys()].map(assetNorm);
  const found = new Map<string, string>(); // tag_normalized -> asset id
  for (let i = 0; i < keys.length; i += 100) {
    const { data } = await admin
      .from("assets").select("id, tag_normalized")
      .eq("org_id", orgId).in("tag_normalized", keys.slice(i, i + 100));
    for (const a of (data ?? []) as Array<{ id: string; tag_normalized: string }>) found.set(a.tag_normalized, a.id);
  }

  const suggestions: BridgeSuggestion[] = [...byTag.entries()]
    .map(([tag, info]) => {
      const pages = [...info.pages].sort((a, b) => a - b);
      const assetId = found.get(assetNorm(tag)) ?? null;
      const sheets = pages.map((p) => sheetFor(p, usedIds[0]));
      return {
        tag,
        code: tagToCode(tag, unit.unitCode, book),
        pages,
        assetId,
        assetStatus: (assetId ? "existing" : "new") as "existing" | "new",
        sheets,
        held: !assetId && heldForUnknownPrefix(tag, book) ? "unknown_prefix" as const : null,
        dismissed: dismissedTags.has(tag),
        model: [...info.models][0] ?? null,
        ...(appliedColumns.has(tag) ? { appliedColumn: appliedColumns.get(tag) ?? null } : {}),
      };
    })
    .sort((a, b) => a.tag.localeCompare(b.tag, undefined, { numeric: true }));

  // ── BR-5: a tag a person took out of its column leaves the relation too
  // (the dismissal saved below is the record of the decision; who removed the
  // chip is not known, so `by` is null). A pair the document's asset_tags
  // still names stays as the person's synced link. The relation is removed
  // BEFORE the dismissal is saved: a removal that fails throws here, nothing
  // is saved, and the next compute plans the same removal again — saved
  // first, the tag would already be dismissed and never re-planned, its
  // 'drawing' rows standing against the recorded decision.
  const removal = columnRemoved.length > 0
    ? await removeDrawingRelations(admin, orgId, documentId, columnRemoved, null, "EQUIPMENT_BRIDGE_RELATION_REMOVED", { via: "column" })
    : null;

  await upsertSuggestions(admin, orgId, documentId, suggestions, unit, {
    applied: appliedNext, dismissed: dismissalsNext, sources, appliedColumns,
  });

  let auditError: string | undefined;
  if (removal) {
    const { error: auditErr } = await admin.from("audit_logs").insert({
      action: "EQUIPMENT_BRIDGE_DISMISSED", resource_type: "document", resource_id: documentId, org_id: orgId, user_id: null,
      details: { tags: columnRemoved, via: "column", revision: revisionLabel, relationsRemoved: removal.removed, keptAsPersonsLink: removal.keptAsPersonsLink },
    });
    auditError = removal.auditError ?? (auditErr ? `The column removal's audit record could not be written: ${auditErr.message}` : undefined);
  }

  // ── relate: refresh the relation of every applied tag still read on this
  // revision (the GAP-304 backfill of tags applied before the relation
  // existed, and the revision each row was read from), then mark what this
  // revision no longer carries (GAP-309) — never a deletion. A person removes
  // a machine reading with Dismiss (or by taking its chip out of the column,
  // above), which records the decision.
  // A reading is complete when every window was read and none stopped at its
  // ceiling, the AI-vision record was readable, no page waits on AI vision,
  // and the index carries drawing entities at all (a copy indexed as prose
  // cannot say a tag left the sheet).
  const complete = !ents.error && !ents.truncated && !visionReadFailed && ents.rows.length > 0
    && used.every((t) => !(t.vision_failed_pages ?? []).length);
  const keep = suggestions.filter((s) => appliedNext.includes(s.tag) && !s.dismissed && s.assetId);
  // Its outcome is returned (and the sweep counts it): a refused or
  // unrecorded refresh is said, never dropped.
  const refreshed = keep.length > 0
    ? await syncDrawingRelations(admin, orgId, documentId, keep.map((s) => ({
        assetId: String(s.assetId), tag: s.tag, sheetLabel: relationSheetLabel(s.sheets), pages: s.pages, model: s.model ?? null,
      })), { revision: revisionLabel, versionId: revision })
    : null;
  const truth = await markRevisionTruth(admin, orgId, documentId, new Set(byTag.keys()), revision, complete);

  // GAP-314: the unit decode at create time — the document's own number,
  // decoded by the backfill's planner (document-control P13's helper), at
  // ingest. Best effort: a decode that cannot run never fails the Bridge.
  if (opts.trigger === "ingest" && srcDoc.document_number) {
    try {
      const { decodeDocumentUnitCodes } = await import("@/lib/unitCodeDecode");
      await decodeDocumentUnitCodes({ orgId, documentIds: [documentId] });
    } catch { /* recorded by the next unit-identity run; the staleness count shows it */ }
  }

  // Auto-apply when the library opted in (AREA-4: a mapped column is no
  // longer required once the library has been reviewed — BR-9).
  let autoApplied = false;
  let autoRelations: RelationOutcome | null = null;
  if (autoApplyActs(bridge) && suggestions.some((s) => !appliedNext.includes(s.tag) && !s.dismissed && !s.held)) {
    try {
      const done = await applyForDocument(admin, { orgId, documentId, userId: null });
      autoApplied = true;
      autoRelations = done.relations;
      auditError ??= done.auditError;
    } catch { /* stays pending for manual review — never breaks ingest */ }
  }
  const relations = mergeRelations(refreshed, autoRelations);
  return {
    documentId, suggestions, autoApplied,
    reason: byTag.size === 0 ? "no_entities" : "computed",
    unitCode: unit.unitCode, unitSource: unit.source, unitRejected: unit.rejected,
    revision: truth, truncated: ents.truncated,
    ...(columnRemoved.length > 0 ? { columnDismissed: columnRemoved } : {}),
    ...(relations ? { relations } : {}),
    ...(auditError ? { auditError } : {}),
  };
}

async function readLedgerRow(admin: SupabaseClient, orgId: string, documentId: string): Promise<{ data: Record<string, unknown> | null; error: PgErr }> {
  let res = await admin.from("document_equipment_suggestions").select("suggested, applied, status, dismissed, applied_columns")
    .eq("org_id", orgId).eq("document_id", documentId).maybeSingle();
  if (res.error && missingColumn(res.error)) {
    res = await admin.from("document_equipment_suggestions").select("suggested, applied, status")
      .eq("org_id", orgId).eq("document_id", documentId).maybeSingle();
  }
  return { data: (res.data as Record<string, unknown> | null) ?? null, error: res.error };
}

async function upsertSuggestions(
  admin: SupabaseClient, orgId: string, documentId: string,
  suggestions: BridgeSuggestion[],
  unit: { unitCode: string | null; source: "document_number" | "library_default" | null; rejected: string | null },
  ledger: { applied: string[]; dismissed: BridgeDismissal[]; sources: BridgeSource[]; appliedColumns: ReadonlyMap<string, string | null> },
): Promise<void> {
  // Preserve the applied history (the idempotence base) across recomputes.
  const fresh = suggestions.filter((s) => !ledger.applied.includes(s.tag) && !s.dismissed);
  const status = fresh.length > 0 ? "pending"
    : ledger.applied.length > 0 ? "applied"
    : suggestions.some((s) => s.dismissed) ? "dismissed" : "pending";
  const row: Record<string, unknown> = {
    org_id: orgId,
    document_id: documentId,
    // CB-1: the unit rides with each suggestion, with where it came from and
    // any decoded code the codebook does not hold (shown, never used).
    suggested: suggestions.map((s) => ({ ...s, unitCode: unit.unitCode, unitSource: unit.source, unitRejected: unit.rejected })),
    applied: ledger.applied,
    status,
    computed_at: new Date().toISOString(),
    dismissed: ledger.dismissed,
    sources: ledger.sources,
    // BR-5: the column each applied tag was written into — its own map, so a
    // tag missing from one reading keeps its record.
    applied_columns: Object.fromEntries([...ledger.appliedColumns].filter(([tag]) => ledger.applied.includes(tag))),
  };
  let { error } = await admin.from("document_equipment_suggestions").upsert(row, { onConflict: "org_id,document_id" });
  if (error && missingColumn(error)) {
    // Before 20261171: the ledger has no dismissed / sources / applied_columns columns.
    for (const c of LEDGER_COLS_20261171) delete row[c];
    ({ error } = await admin.from("document_equipment_suggestions").upsert(row, { onConflict: "org_id,document_id" }));
  }
  if (error) throw new Error(`The proposal could not be saved: ${error.message}`);
}

/** GAP-304: write or refresh the 'drawing' relation for these tags. A pair a
 *  person already linked is left as it is (a human assertion stands). A
 *  'drawing' row is written only WITH its provenance (GAP-303 before GAP-304,
 *  99-fix-sequencing Phase 2): on a database without 20261171 nothing is
 *  written and that is said, exactly as before 20261170 — a relation that
 *  existed before its provenance could never recover who asserted it or
 *  which revision it was read from. */
export async function syncDrawingRelations(
  admin: SupabaseClient, orgId: string, documentId: string,
  items: Array<{ assetId: string; tag: string; sheetLabel: string | null; pages: number[]; model: string | null }>,
  prov: { revision: string | null; versionId: string | null },
): Promise<RelationOutcome> {
  const out: RelationOutcome = { written: 0, refreshed: 0, keptHuman: 0, notRecorded: null };
  if (items.length === 0) return out;
  const byAsset = new Map<string, { id: string; source: string }>();
  const ids = [...new Set(items.map((i) => i.assetId))];
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await admin.from("document_assets").select("id, asset_id, source")
      .eq("org_id", orgId).eq("document_id", documentId).in("asset_id", ids.slice(i, i + 100));
    if (error) { out.notRecorded = `the relation could not be read: ${error.message ?? "error"}`; return out; }
    for (const r of (data ?? []) as Array<{ id: string; asset_id: string; source: string }>) byAsset.set(r.asset_id, { id: r.id, source: r.source });
  }
  const seen = new Set<string>();
  for (const it of items) {
    if (seen.has(it.assetId)) continue;
    seen.add(it.assetId);
    const existing = byAsset.get(it.assetId);
    if (existing && existing.source !== "drawing") { out.keptHuman++; continue; }
    const patch: Record<string, unknown> = {
      tag_text: it.tag, sheet_label: it.sheetLabel, pages: it.pages,
      asserted_by: "machine", model: it.model, source_revision: prov.revision, source_version_id: prov.versionId,
      vanished_at: null, superseded_at: null,
    };
    const err = existing
      ? (await admin.from("document_assets").update(patch).eq("id", existing.id).eq("org_id", orgId).eq("source", "drawing")).error
      : (await admin.from("document_assets").insert({
          org_id: orgId, document_id: documentId, asset_id: it.assetId, source: "drawing", ...patch,
        })).error;
    if (err && missingProvenance(err)) {
      // Before 20261171: no provenance columns — no row is written without
      // them. The column write still happens, and this is said.
      out.notRecorded = "The document↔equipment relation was not recorded: the database does not have migration 20261171 yet (a drawing link is written only with who asserted it and which revision it was read from — paste 20261170, then 20261171).";
      return out;
    }
    if (err && (checkViolation(err) || missingColumn(err))) {
      // Before 20261170: no 'drawing' vocabulary, no sheet columns. The
      // column write still happens — today's behaviour — and this is said.
      out.notRecorded = "The document↔equipment relation was not recorded: the database does not have migration 20261170 yet.";
      return out;
    }
    if (err && uniqueViolation(err)) { out.keptHuman++; continue; } // a person (or the tag sync) linked it meanwhile
    if (err) { out.notRecorded = `the relation write was refused: ${err.message ?? "error"}`; return out; }
    if (existing) out.refreshed++; else out.written++;
  }
  return out;
}

/** Two relation outcomes as one (the compute's refresh and its automatic
 *  apply): counts add up, the first reason nothing was recorded is kept. */
function mergeRelations(a: RelationOutcome | null, b: RelationOutcome | null): RelationOutcome | null {
  if (!a || !b) return a ?? b;
  return {
    written: a.written + b.written, refreshed: a.refreshed + b.refreshed, keptHuman: a.keptHuman + b.keptHuman,
    notRecorded: a.notRecorded ?? b.notRecorded,
  };
}

/** GAP-309: on a complete reading, relations whose tag this revision no
 *  longer carries are marked vanished (and un-marked when it returns); a row
 *  read from an earlier revision is marked superseded. Never deleted. A row
 *  a person confirmed is still on the sheet ("It is still there") is not
 *  re-marked on the revision they confirmed it on. A mark is counted only
 *  when its write lands. */
async function markRevisionTruth(
  admin: SupabaseClient, orgId: string, documentId: string, present: ReadonlySet<string>, versionId: string | null, complete: boolean,
): Promise<{ vanished: number; reappeared: number; superseded: number; complete: boolean; skipped?: string; failed?: number }> {
  const out: { vanished: number; reappeared: number; superseded: number; complete: boolean; skipped?: string; failed?: number } = { vanished: 0, reappeared: 0, superseded: 0, complete };
  type Row = { id: string; tag_text: string | null; vanished_at: string | null; superseded_at: string | null; source_version_id: string | null; presence_confirmed_on?: string | null };
  // Every drawing row of the document, paged (a multi-sheet set carries
  // thousands; one response is cut at PostgREST's max-rows without an error).
  const { rows, error } = await pageById<Row>((after) => {
    let q = admin.from("document_assets")
      .select("id, tag_text, vanished_at, superseded_at, source_version_id, presence_confirmed_on")
      .eq("org_id", orgId).eq("document_id", documentId).eq("source", "drawing")
      .order("id", { ascending: true }).limit(PAGE_ROWS);
    if (after) q = q.gt("id", after);
    return q;
  });
  if (error) return { ...out, skipped: missingColumn(error) ? "20261171 not applied — revision truth is not recorded yet" : (error.message ?? "read failed") };
  const presentKeys = new Set([...present].map(assetNorm));
  const now = new Date().toISOString();
  for (const r of rows) {
    const isPresent = presentKeys.has(assetNorm(r.tag_text ?? ""));
    const confirmedHere = !!versionId && r.presence_confirmed_on === versionId;
    const patch: Record<string, unknown> = {};
    let marks: Array<"vanished" | "reappeared" | "superseded"> = [];
    if (complete && !isPresent && !r.vanished_at && !confirmedHere) { patch.vanished_at = now; marks.push("vanished"); }
    if (complete && isPresent && r.vanished_at) { patch.vanished_at = null; marks.push("reappeared"); }
    if (versionId && r.source_version_id && r.source_version_id !== versionId && !r.superseded_at) { patch.superseded_at = now; marks.push("superseded"); }
    if (marks.length === 0) continue;
    const { error: updErr } = await admin.from("document_assets").update(patch).eq("id", r.id).eq("org_id", orgId).eq("source", "drawing");
    if (updErr) { out.failed = (out.failed ?? 0) + 1; marks = []; }
    for (const m of marks) out[m]++;
  }
  return out;
}

/** The document's 'drawing' rows for these tags, filtered AT THE DATABASE —
 *  never "every drawing row of the document, then filter": a multi-sheet set
 *  carries thousands and one response is cut at PostgREST's max-rows without
 *  an error, so a tag past the cut would read as not linked. The tags are
 *  resolved to their registry assets (the one tag grammar, tag_normalized)
 *  and the rows read by asset id, plus by the spelling the Bridge stored
 *  (tag_text) for a row whose asset was renamed since; each read is bounded
 *  by the pairs it names (one row per document and asset). A row matches
 *  when its asset is the tag's or its tag_text is the tag by the grammar. */
async function readDrawingRowsForTags(
  admin: SupabaseClient, orgId: string, documentId: string, tags: string[], cols: string,
): Promise<{ rows: Array<Record<string, unknown>>; error: PgErr }> {
  const keys = new Set(tags.map(assetNorm));
  const keyList = [...keys].filter(Boolean);
  const assetIds = new Set<string>();
  for (let i = 0; i < keyList.length; i += 100) {
    const { data, error } = await admin.from("assets").select("id")
      .eq("org_id", orgId).in("tag_normalized", keyList.slice(i, i + 100));
    if (error) return { rows: [], error };
    for (const a of (data ?? []) as Array<{ id: string }>) assetIds.add(String(a.id));
  }
  const byId = new Map<string, Record<string, unknown>>();
  const take = (data: unknown) => { for (const r of (data ?? []) as Array<Record<string, unknown>>) byId.set(String(r.id), r); };
  const ids = [...assetIds];
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await admin.from("document_assets").select(cols)
      .eq("org_id", orgId).eq("document_id", documentId).eq("source", "drawing").in("asset_id", ids.slice(i, i + 100));
    if (error) return { rows: [], error };
    take(data);
  }
  const spellings = [...new Set(tags.filter(Boolean))];
  for (let i = 0; i < spellings.length; i += 100) {
    const { data, error } = await admin.from("document_assets").select(cols)
      .eq("org_id", orgId).eq("document_id", documentId).eq("source", "drawing").in("tag_text", spellings.slice(i, i + 100));
    if (error) return { rows: [], error };
    take(data);
  }
  const rows = [...byId.values()].filter((r) => assetIds.has(String(r.asset_id)) || keys.has(assetNorm(String(r.tag_text ?? ""))));
  return { rows, error: null };
}

/** Remove 'drawing' relations for these tags (service role), recording what
 *  each one was — a person's correction of a machine reading. A pair the
 *  document's own asset_tags still names is not lost: while the drawing row
 *  held the pair the resync trigger's jsonb_sync insert was skipped (ON
 *  CONFLICT DO NOTHING), so the row becomes that synced link — exactly what
 *  the trigger would have written — instead of disappearing. */
async function removeDrawingRelations(
  admin: SupabaseClient, orgId: string, documentId: string, tags: string[], userId: string | null, action: string,
  opts: { onlyVanished?: boolean; via?: "review" | "column" | "vanished" } = {},
): Promise<RemovalOutcome> {
  const out: RemovalOutcome = { removed: 0, keptAsPersonsLink: 0 };
  if (tags.length === 0) return out;
  let sel = await readDrawingRowsForTags(admin, orgId, documentId, tags, "id, asset_id, tag_text, sheet_label, pages, source_revision, model, vanished_at");
  if (sel.error) {
    if (!missingColumn(sel.error)) throw new Error(`The relation could not be read: ${sel.error.message ?? "read failed"}`);
    sel = await readDrawingRowsForTags(admin, orgId, documentId, tags, "id, asset_id, tag_text");
    if (sel.error) throw new Error(`The relation could not be read: ${sel.error.message ?? "read failed"}`);
  }
  // A copy of what each row was, recorded before it changes.
  const doomed = sel.rows.filter((r) => !opts.onlyVanished || r.vanished_at).map((r) => ({ ...r }));
  if (doomed.length === 0) return out;

  // Which of these pairs a person tagged on the document (documents.asset_tags,
  // matched as documents_resync_assets matches: normalize_tag(elem->>'tag') =
  // the asset's tag_normalized; the first spelling wins).
  const personTag = new Map<string, string>(); // asset id → asset_tags spelling
  {
    const { data: doc, error: docErr } = await admin.from("documents").select("asset_tags")
      .eq("id", documentId).eq("org_id", orgId).maybeSingle();
    if (docErr && !missingColumn(docErr)) throw new Error(`The document could not be read: ${docErr.message ?? "read failed"}`);
    const elems = (Array.isArray((doc as { asset_tags?: unknown } | null)?.asset_tags) ? (doc as { asset_tags: unknown[] }).asset_tags : []) as Array<Record<string, unknown>>;
    const spellings = elems.map((e) => (e && typeof e.tag === "string" ? e.tag : "")).filter((t) => t !== "");
    if (spellings.length > 0) {
      // In batches of 100 ids: a person clearing a large tag column removes
      // hundreds at once, and one longer `.in()` overflows the request line.
      const assetIds = [...new Set(doomed.map((r) => String(r.asset_id)))];
      for (let i = 0; i < assetIds.length; i += 100) {
        const { data: assets, error: aErr } = await admin.from("assets").select("id, tag_normalized")
          .eq("org_id", orgId).in("id", assetIds.slice(i, i + 100));
        if (aErr) throw new Error(`The equipment could not be read: ${aErr.message ?? "read failed"}`);
        for (const a of (assets ?? []) as Array<{ id: string; tag_normalized: string | null }>) {
          const hit = spellings.find((t) => tagKey(t) === (a.tag_normalized ?? ""));
          if (hit) personTag.set(String(a.id), hit);
        }
      }
    }
  }

  const converted: Array<Record<string, unknown>> = [];
  const deleted: Array<Record<string, unknown>> = [];
  for (const r of doomed) {
    const spelling = personTag.get(String(r.asset_id));
    if (!spelling) { deleted.push(r); continue; }
    const base = { source: "jsonb_sync", tag_text: spelling, sheet_label: null, pages: null };
    const write = (patch: Record<string, unknown>) => admin.from("document_assets").update(patch)
      .eq("id", String(r.id)).eq("org_id", orgId).eq("source", "drawing");
    let { error } = await write({ ...base, ...HUMAN_PROVENANCE(null) });
    if (error && missingColumn(error)) ({ error } = await write(base)); // before 20261171
    if (error) throw new Error(`The relation could not be removed: ${error.message}`);
    converted.push(r);
  }
  for (let i = 0; i < deleted.length; i += 100) {
    const { error } = await admin.from("document_assets").delete()
      .in("id", deleted.slice(i, i + 100).map((r) => String(r.id))).eq("org_id", orgId).eq("source", "drawing");
    if (error) throw new Error(`The relation could not be removed: ${error.message}`);
  }
  out.removed = doomed.length;
  out.keptAsPersonsLink = converted.length;
  const describe = (r: Record<string, unknown>) => ({ tag: r.tag_text, assetId: r.asset_id, sheet: r.sheet_label ?? null, pages: r.pages ?? null, revision: r.source_revision ?? null, model: r.model ?? null });
  const { error: auditErr } = await admin.from("audit_logs").insert({
    action, resource_type: "document", resource_id: documentId, org_id: orgId, user_id: userId,
    details: {
      removed: doomed.map(describe),
      keptAsPersonsLink: converted.map((r) => ({ tag: r.tag_text, assetId: r.asset_id, as: personTag.get(String(r.asset_id)) })),
      ...(opts.via ? { via: opts.via } : {}),
    },
  });
  if (auditErr) out.auditError = `The relation was removed, but its audit record could not be written: ${auditErr.message}`;
  return out;
}

// ─── Apply ──────────────────────────────────────────────────────────────────

export async function applyForDocument(admin: SupabaseClient, input: {
  orgId: string;
  documentId: string;
  /** Null = the automatic path (post-ingest auto-apply). */
  userId: string | null;
  /** Restrict to a subset of suggested tags (review UI); omit = every tag
   *  not yet applied, not dismissed and not held. Naming a tag re-requests
   *  it explicitly — an applied, dismissed or held tag included (BR-5/9/13). */
  tags?: string[];
}): Promise<ApplyResult> {
  const { orgId, documentId } = input;
  const { data: row } = await readLedgerRow(admin, orgId, documentId);
  if (!row) throw new Error("No computed suggestions for this document — run the sweep first.");
  const suggested = (Array.isArray(row.suggested) ? row.suggested : []) as Array<BridgeSuggestion & { unitCode?: string | null }>;
  const alreadyApplied = new Set<string>(Array.isArray(row.applied) ? (row.applied as string[]) : []);
  const dismissals = parseDismissals(row.dismissed);
  const dismissedTags = new Set(dismissals.map((d) => d.tag));
  const explicit = Array.isArray(input.tags);
  // BR-5: never re-apply what was applied (or dismissed) unless named again.
  const wanted = suggested.filter((s) => explicit
    ? input.tags!.includes(s.tag)
    : !alreadyApplied.has(s.tag) && !dismissedTags.has(s.tag) && !s.dismissed && !s.held);
  const blank = (): ApplyResult => ({
    appliedTags: [], createdAssets: 0, codesLeftBlank: [], degraded: [], failed: [], held: [],
    relations: { written: 0, refreshed: 0, keptHuman: 0, notRecorded: null },
    column: null, codesFilled: 0,
  });
  if (wanted.length === 0) return blank();

  const { data: doc } = await admin
    .from("documents").select("id, library_id, metadata, created_by")
    .eq("id", documentId).eq("org_id", orgId).maybeSingle();
  if (!doc) throw new Error("Document not found");
  // An unread configuration is not "no column, discovery on": acting on it
  // would create assets a library opted out of and mark tags applied that
  // never reached the mapped column. Nothing is applied.
  const lib = await loadBridgeConfig(admin, String(doc.library_id ?? ""));
  if (lib.error) throw new Error(`The library's equipment-sweep settings could not be read: ${lib.error} — nothing was applied.`);
  const bridge = lib.config;
  const targetKey = bridge?.targetColumnKey ?? null;
  const book = await loadCodebookAdmin(admin, orgId);
  const result = blank();
  result.column = targetKey;

  // CB-2: the unit is re-checked against the codebook and the code
  // re-derived from tag + unit — the stored proposal is never trusted.
  const unitOf = (s: { unitCode?: string | null }) => heldUnit(s.unitCode ?? null, book);
  const codeOf = (s: BridgeSuggestion & { unitCode?: string | null }) => tagToCode(s.tag, unitOf(s), book);

  // Re-resolve every wanted tag against the registry now (an id in the
  // stored proposal may be stale).
  const resolved = new Map<string, { id: string; unit_code: string | null; code: string | null }>();
  {
    const keys = [...new Set(wanted.map((s) => assetNorm(s.tag)))];
    for (let i = 0; i < keys.length; i += 100) {
      const { data } = await admin.from("assets").select("id, tag_normalized, unit_code, code")
        .eq("org_id", orgId).in("tag_normalized", keys.slice(i, i + 100));
      for (const a of (data ?? []) as Array<{ id: string; tag_normalized: string; unit_code?: string | null; code?: string | null }>) {
        resolved.set(a.tag_normalized, { id: String(a.id), unit_code: a.unit_code ?? null, code: a.code ?? null });
      }
    }
  }
  for (const s of wanted) {
    const hit = resolved.get(assetNorm(s.tag));
    s.assetId = hit ? hit.id : null;
  }
  const unitBefore = new Map<string, { unit_code: string | null; code: string | null }>();
  for (const [, v] of resolved) unitBefore.set(v.id, { unit_code: v.unit_code, code: v.code });

  // ── Registry reconcile with DISCOVERY (AREA-4: independent of the column).
  const codesLeftBlank = new Set<string>();
  if (bridge?.createAssets !== false) {
    const typeIdByLabel = await ensureAssetTypes(admin, orgId, book, wanted);
    for (const s of wanted) {
      if (s.assetId) continue;
      // BR-13: an unknown prefix is never minted by a bulk or automatic
      // apply — a person names it explicitly to create it.
      if (!explicit && heldForUnknownPrefix(s.tag, book)) { result.held.push(s.tag); continue; }
      const t = typeForTag(s.tag, book);
      const unitCode = unitOf(s);
      const code = codeOf(s);
      const insert = {
        org_id: orgId,
        tag: s.tag,
        tag_normalized: assetNorm(s.tag),
        type_id: t ? typeIdByLabel.get(t.label) ?? null : null,
        description: null,
        unit_code: unitCode,
        code,
        origin: "drawing",
        discovered_from: {
          documentId, pages: s.pages, door: "drawing",
          sheets: (s.sheets ?? []).map((x) => ({ page: x.page, label: x.label, aiRead: x.aiRead })),
          auto: input.userId === null,
        },
        // BR-8: an accountable identity — the person who applied, else the
        // one who turned auto-apply on, else whoever filed the drawing.
        created_by: input.userId ?? bridge?.autoApplyBy ?? (doc as { created_by?: string | null }).created_by ?? NIL_UUID,
      };
      // Unique (org, tag_normalized) makes concurrent discovery safe: the
      // loser of a race just resolves to the winner's row.
      let { data: created, error } = await admin.from("assets").insert(insert).select("id, code").single();
      if (error && /unit_code|origin|discovered_from|column/i.test(error.message)) {
        // Pre-migration DB: retry with the base columns only — and SAY what
        // was dropped (a degraded insert is information).
        const { unit_code: _u, code: _c, origin: _o, discovered_from: _d, ...base } = insert;
        void _u; void _c; void _o; void _d;
        ({ data: created, error } = await admin.from("assets").insert(base).select("id").single());
        if (!error && created) result.degraded.push({ tag: s.tag, dropped: ["unit_code", "code", "origin", "discovered_from"] });
      } else if (error && insert.code && siteCodeTaken(error)) {
        // CB-10: the index refused the code — another insert of it (a second
        // drawing ingested in parallel) committed after 20261128's trigger
        // looked, which sees committed rows only. Land the asset without the
        // code, once.
        ({ data: created, error } = await admin.from("assets").insert({ ...insert, code: null }).select("id, code").single());
        if (!error && created) codesLeftBlank.add(s.tag);
      } else if (!error && created && insert.code && !(created as { code?: unknown }).code) {
        codesLeftBlank.add(s.tag); // the trigger dropped a code another asset carries
      }
      if (error) {
        const { data: raced } = await admin.from("assets").select("id")
          .eq("org_id", orgId).eq("tag_normalized", assetNorm(s.tag)).maybeSingle();
        if (raced) { s.assetId = String(raced.id); continue; }
        result.failed.push({ tag: s.tag, reason: error.message });
        continue; // one bad tag never sinks the batch
      }
      if (created) { s.assetId = String(created.id); result.createdAssets++; }
    }
  }

  // ── Unit backfill for MATCHED assets that had no unit (never overwriting a
  //    human's assignment), and — BR-7, an independent condition — the code
  //    for matched assets that HAD a unit but no code (derived from the
  //    asset's own filing). Each guarded by its own IS NULL.
  try {
    for (const s of wanted) {
      if (!s.assetId) continue;
      const before = unitBefore.get(String(s.assetId));
      if (!before) continue; // created just now
      const id = String(s.assetId);
      const write = async (p: Record<string, unknown>, guard: "unit_code" | "code"): Promise<{ message: string } | null> => {
        try { return (await admin.from("assets").update(p).eq("id", id).is(guard, null)).error; }
        catch (e) { return { message: String(e) }; }
      };
      const unitCode = unitOf(s);
      if (!before.unit_code && unitCode) {
        const patch: Record<string, unknown> = { unit_code: unitCode };
        const code = codeOf(s);
        if (!before.code && code) patch.code = code;
        // CB-10: a code another asset carries is refused (20261128) — the
        // filing is re-sent without it, and the tag recorded.
        const err = await write(patch, "unit_code");
        if (patch.code && siteCodeTaken(err) && !(await write({ unit_code: unitCode }, "unit_code"))) codesLeftBlank.add(s.tag);
        unitBefore.set(id, { unit_code: unitCode, code: before.code });
      } else if (before.unit_code && !before.code) {
        const code = tagToCode(s.tag, before.unit_code, book);
        if (code) {
          const err = await write({ code }, "code");
          if (!err) result.codesFilled++;
          else if (siteCodeTaken(err)) codesLeftBlank.add(s.tag);
        }
        unitBefore.set(id, { unit_code: before.unit_code, code: code ?? null });
      }
    }
  } catch { /* pre-migration DB (no unit_code column) — nothing to backfill */ }
  result.codesLeftBlank = [...codesLeftBlank];

  // ── Relate (GAP-304): the relation is the record.
  const prov = await currentReading(admin, orgId, documentId);
  result.relations = await syncDrawingRelations(admin, orgId, documentId,
    wanted.filter((s) => s.assetId).map((s) => ({
      assetId: String(s.assetId), tag: s.tag, sheetLabel: relationSheetLabel(s.sheets), pages: s.pages ?? [], model: s.model ?? null,
    })), prov);

  // ── Populate the column (when one is mapped): array-union merge, never
  //    clobbering manual tags. Kept — the drawing row's chips render from it.
  const appliedNow = wanted.filter((s) => !result.held.includes(s.tag)).map((s) => s.tag);
  if (targetKey) {
    const metadata = (doc.metadata && typeof doc.metadata === "object" ? doc.metadata : {}) as Record<string, unknown>;
    const existingTags = columnTags(metadata[targetKey]);
    const existingNorms = new Set(existingTags.map(assetNorm));
    const additions = appliedNow.filter((t) => !existingNorms.has(assetNorm(t)));
    if (additions.length > 0) {
      const next = [...existingTags, ...additions.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))];
      const { error: updErr } = await admin.from("documents")
        .update({ metadata: { ...metadata, [targetKey]: next }, updated_at: new Date().toISOString() })
        .eq("id", documentId).eq("org_id", orgId);
      if (updErr) throw new Error(updErr.message);
    }
  }

  const appliedUnion = [...new Set([...alreadyApplied, ...appliedNow])];
  // BR-5: the ledger's own map of where each applied tag was written —
  // carried across recomputes whether or not the tag is read again.
  const priorColumns = (row.applied_columns && typeof row.applied_columns === "object" && !Array.isArray(row.applied_columns))
    ? row.applied_columns as Record<string, unknown> : {};
  const appliedColumns: Record<string, string | null> = {};
  for (const [tag, col] of Object.entries(priorColumns)) {
    if (appliedUnion.includes(tag)) appliedColumns[tag] = typeof col === "string" && col ? col : null;
  }
  for (const tag of appliedNow) appliedColumns[tag] = targetKey;
  const ledger: Record<string, unknown> = {
    // The proposal as it stands after this apply: a tag named again is no
    // longer dismissed or held, a discovered tag now has its asset, and each
    // applied tag records the column it was written into (BR-5: a person
    // taking it out of that column is a rejection).
    suggested: suggested.map((s) => (appliedNow.includes(s.tag)
      ? { ...s, dismissed: false, held: null, assetStatus: s.assetId ? "existing" : s.assetStatus, appliedColumn: targetKey }
      : s)),
    applied: appliedUnion,
    status: "applied",
    applied_at: new Date().toISOString(),
    applied_by: input.userId,
    // A tag named again leaves the dismissed list (BR-9).
    dismissed: dismissals.filter((d) => !appliedNow.includes(d.tag)),
    applied_columns: appliedColumns,
  };
  let { error: ledgerErr } = await admin.from("document_equipment_suggestions").update(ledger)
    .eq("org_id", orgId).eq("document_id", documentId);
  if (ledgerErr && missingColumn(ledgerErr)) {
    for (const c of LEDGER_COLS_20261171) delete ledger[c]; // before 20261171
    ({ error: ledgerErr } = await admin.from("document_equipment_suggestions").update(ledger)
      .eq("org_id", orgId).eq("document_id", documentId));
  }
  if (ledgerErr) result.ledgerError = ledgerErr.message;
  if (input.userId) await markReviewed(admin, String(doc.library_id ?? ""), bridge, input.userId);

  // Checked: the apply created registry assets and relations — a missing
  // audit row is said to the caller, never swallowed.
  const { error: auditErr } = await admin.from("audit_logs").insert({
    action: "EQUIPMENT_BRIDGE_APPLIED",
    resource_type: "document",
    resource_id: documentId,
    org_id: orgId,
    user_id: input.userId,
    details: {
      tags: appliedNow, createdAssets: result.createdAssets, codesLeftBlank: result.codesLeftBlank,
      column: targetKey, auto: input.userId === null, degraded: result.degraded, failed: result.failed,
      held: result.held, relations: result.relations, codesFilled: result.codesFilled,
      revision: prov.revision, ledgerError: result.ledgerError ?? null,
    },
  });
  if (auditErr) result.auditError = `The tags were applied, but the audit record could not be written: ${auditErr.message}`;

  result.appliedTags = appliedNow;
  return result;
}

/** The revision the document's CURRENT copies were read from — the same
 *  selection the compute uses (ready, at the document's current revision);
 *  a stale or indexing copy never stamps a relation. */
async function currentReading(admin: SupabaseClient, orgId: string, documentId: string): Promise<{ revision: string | null; versionId: string | null }> {
  try {
    const { data: doc } = await admin.from("documents").select("current_version_id")
      .eq("id", documentId).eq("org_id", orgId).maybeSingle();
    const current = (doc as { current_version_id?: string | null } | null)?.current_version_id ?? null;
    const twins = await readTwins(admin, orgId, documentId);
    const sources = classifyCopies(twins, current);
    const used = twins.filter((t) => sources.find((s) => s.knowledgeDocumentId === t.id)?.used);
    if (used.length === 0) return { revision: null, versionId: null };
    return readingOf(used);
  } catch {
    return { revision: null, versionId: null };
  }
}

/** BR-9: the first time a person applies or dismisses in a library. */
async function markReviewed(admin: SupabaseClient, libraryId: string, bridge: BridgeConfig | null, userId: string): Promise<void> {
  if (!libraryId || bridge?.reviewedAt) return;
  await admin.from("libraries")
    .update({ equipment_bridge: { ...(bridge ?? {}), reviewedAt: new Date().toISOString(), reviewedBy: userId } })
    .eq("id", libraryId)
    .then(() => undefined, () => undefined);
}

// ─── Review actions ─────────────────────────────────────────────────────────

/** BR-9: a person rejects tags on one document. Remembered (never
 *  re-applied, re-proposed only when a later revision brings the tag back
 *  after it left); an applied tag's 'drawing' relation is removed and the
 *  decision recorded. The column is a person's surface and is left alone. */
export async function dismissForDocument(admin: SupabaseClient, input: {
  orgId: string; documentId: string; userId: string; tags: string[];
}): Promise<{ dismissed: string[]; relationsRemoved: number; keptAsPersonsLink?: number; remembered: boolean; auditError?: string }> {
  const { orgId, documentId, userId } = input;
  const tags = [...new Set(input.tags.map((t) => normalizeTag(String(t))).filter(Boolean))];
  if (tags.length === 0) return { dismissed: [], relationsRemoved: 0, remembered: true };
  const { data: row } = await readLedgerRow(admin, orgId, documentId);
  if (!row) throw new Error("No computed suggestions for this document — run the sweep first.");
  const suggested = (Array.isArray(row.suggested) ? row.suggested : []) as Array<BridgeSuggestion & { unitCode?: string | null }>;
  const known = new Set(suggested.map((s) => s.tag));
  const target = tags.filter((t) => known.has(t));
  if (target.length === 0) return { dismissed: [], relationsRemoved: 0, remembered: true };
  const reading = await currentReading(admin, orgId, documentId);
  const now = new Date().toISOString();
  const prior = parseDismissals(row.dismissed).filter((d) => !target.includes(d.tag));
  const dismissed: BridgeDismissal[] = [...prior, ...target.map((t) => ({ tag: t, by: userId, at: now, via: "review" as const, revision: reading.versionId }))];
  const applied = (Array.isArray(row.applied) ? (row.applied as string[]) : []);
  const nextSuggested = suggested.map((s) => (target.includes(s.tag) ? { ...s, dismissed: true } : s));
  const fresh = nextSuggested.filter((s) => !applied.includes(s.tag) && !s.dismissed);
  const status = fresh.length > 0 ? "pending" : applied.length > 0 ? "applied" : "dismissed";
  let remembered = true;
  let { error } = await admin.from("document_equipment_suggestions")
    .update({ suggested: nextSuggested, dismissed, status })
    .eq("org_id", orgId).eq("document_id", documentId);
  if (error && missingColumn(error)) {
    // Before 20261171 the ledger cannot remember a dismissal across a
    // recompute: the flag lives on this proposal only — said to the caller.
    remembered = false;
    ({ error } = await admin.from("document_equipment_suggestions")
      .update({ suggested: nextSuggested, status })
      .eq("org_id", orgId).eq("document_id", documentId));
  }
  if (error) throw new Error(`The dismissal could not be saved: ${error.message}`);
  const removal = await removeDrawingRelations(admin, orgId, documentId, target.filter((t) => applied.includes(t)), userId, "EQUIPMENT_BRIDGE_RELATION_REMOVED", { via: "review" });
  const relationsRemoved = removal.removed;
  const { error: auditErr } = await admin.from("audit_logs").insert({
    action: "EQUIPMENT_BRIDGE_DISMISSED", resource_type: "document", resource_id: documentId, org_id: orgId, user_id: userId,
    details: { tags: target, revision: reading.revision, relationsRemoved, keptAsPersonsLink: removal.keptAsPersonsLink, remembered },
  });
  const auditError = removal.auditError ?? (auditErr ? `The dismissal was saved, but its audit record could not be written: ${auditErr.message}` : undefined);
  const { data: doc } = await admin.from("documents").select("library_id").eq("id", documentId).eq("org_id", orgId).maybeSingle();
  if (doc?.library_id) {
    // The review mark is written only over a configuration that was read —
    // never over an unread one (which would replace the library's settings).
    const lib = await loadBridgeConfig(admin, String(doc.library_id));
    if (!lib.error) await markReviewed(admin, String(doc.library_id), lib.config, userId);
  }
  return {
    dismissed: target, relationsRemoved, remembered,
    ...(removal.keptAsPersonsLink > 0 ? { keptAsPersonsLink: removal.keptAsPersonsLink } : {}),
    ...(auditError ? { auditError } : {}),
  };
}

/** GAP-309: a person reviews relations the current revision no longer
 *  carries — 'remove' (the tag really left the sheet: the relation is
 *  removed, what it was is recorded) or 'keep' (an extraction miss: the
 *  mark is cleared and the revision it was confirmed on is kept on the row,
 *  so the Bridge does not ask again for that revision; the decision is
 *  recorded). Never automatic. */
export async function reviewVanished(admin: SupabaseClient, input: {
  orgId: string; documentId: string; userId: string; tags: string[]; decision: "remove" | "keep";
}): Promise<{ changed: number; keptAsPersonsLink?: number; auditError?: string }> {
  const { orgId, documentId, userId, decision } = input;
  const tags = [...new Set(input.tags.map((t) => normalizeTag(String(t))).filter(Boolean))];
  if (tags.length === 0) return { changed: 0 };
  // Only these tags' rows, filtered at the database (never the document's
  // every drawing row, which PostgREST would cut at its max-rows).
  const { rows: found, error } = await readDrawingRowsForTags(admin, orgId, documentId, tags, "id, asset_id, tag_text, vanished_at");
  if (error) throw new Error(missingColumn(error) ? "Revision truth needs migration 20261171." : error.message ?? "read failed");
  const rows = (found as unknown as Array<{ id: string; tag_text: string | null; vanished_at: string | null }>).filter((r) => r.vanished_at);
  if (rows.length === 0) return { changed: 0 };

  if (decision === "remove") {
    // The tag left the sheet: it is no longer an applied tag, so a later
    // revision that carries it again proposes it to a person — never
    // re-links it on its own. The ledger is written FIRST: if it cannot be,
    // nothing is removed (a removed link whose tag stayed applied would be
    // re-linked silently by a later revision).
    const { data: row, error: ledgerReadErr } = await readLedgerRow(admin, orgId, documentId);
    if (ledgerReadErr) throw new Error(`The review could not be saved: ${ledgerReadErr.message ?? "the proposal could not be read"}`);
    if (row && Array.isArray(row.applied)) {
      const gone = new Set(rows.map((r) => normalizeTag(String(r.tag_text ?? ""))));
      const goneKeys = new Set(rows.map((r) => assetNorm(String(r.tag_text ?? ""))));
      const { error: ledgerErr } = await admin.from("document_equipment_suggestions")
        .update({ applied: (row.applied as string[]).filter((t) => !gone.has(t) && !goneKeys.has(assetNorm(t))) })
        .eq("org_id", orgId).eq("document_id", documentId);
      if (ledgerErr) throw new Error(`The review could not be saved: ${ledgerErr.message}`);
    }
    const removal = await removeDrawingRelations(admin, orgId, documentId, tags, userId, "EQUIPMENT_BRIDGE_VANISHED_REMOVED", { onlyVanished: true, via: "vanished" });
    return {
      changed: removal.removed,
      ...(removal.keptAsPersonsLink > 0 ? { keptAsPersonsLink: removal.keptAsPersonsLink } : {}),
      ...(removal.auditError ? { auditError: removal.auditError } : {}),
    };
  }

  // 'keep': remembered for the revision it was confirmed on.
  const reading = await currentReading(admin, orgId, documentId);
  const { error: upd } = await admin.from("document_assets").update({ vanished_at: null, presence_confirmed_on: reading.versionId })
    .in("id", rows.map((r) => r.id)).eq("org_id", orgId).eq("source", "drawing");
  if (upd) throw new Error(`The review could not be saved: ${upd.message}`);
  const { error: auditErr } = await admin.from("audit_logs").insert({
    action: "EQUIPMENT_BRIDGE_VANISHED_KEPT", resource_type: "document", resource_id: documentId, org_id: orgId, user_id: userId,
    details: { tags: rows.map((r) => r.tag_text), vanishedAt: rows.map((r) => r.vanished_at), confirmedOn: reading.versionId, revision: reading.revision },
  });
  return {
    changed: rows.length,
    ...(auditErr ? { auditError: `The review was saved, but its audit record could not be written: ${auditErr.message}` } : {}),
  };
}

/** AREA-2 / GAP-302: a person links a pair the drawing already relates —
 *  the registry drawer's Link (or the graph's Connect) is refused 23505
 *  because the 'drawing' row holds the pair, and a person cannot write a
 *  'drawing' row. The person's assertion stands: the row becomes theirs
 *  (source 'manual', asserted by them), keeping where on the sheet it was
 *  read. Dismiss and the vanished review never remove a person's link. A
 *  pair that is already a person's link is left as it is. Recorded. */
export async function adoptDrawingRelation(admin: SupabaseClient, input: {
  orgId: string; documentId: string; assetId: string; userId: string;
}): Promise<{ adopted: boolean; already: string | null; auditError?: string }> {
  const { orgId, documentId, assetId, userId } = input;
  let sel: { data: unknown; error: PgErr } = await admin.from("document_assets")
    .select("id, source, tag_text, sheet_label, pages, source_revision, model")
    .eq("org_id", orgId).eq("document_id", documentId).eq("asset_id", assetId).maybeSingle();
  if (sel.error && missingColumn(sel.error)) {
    sel = await admin.from("document_assets").select("id, source, tag_text")
      .eq("org_id", orgId).eq("document_id", documentId).eq("asset_id", assetId).maybeSingle();
  }
  if (sel.error) throw new Error(`The link could not be read: ${sel.error.message ?? "read failed"}`);
  const row = sel.data as Record<string, unknown> | null;
  if (!row) return { adopted: false, already: null };
  if (row.source !== "drawing") return { adopted: false, already: String(row.source ?? "") };
  const write = (patch: Record<string, unknown>) => admin.from("document_assets").update(patch)
    .eq("id", String(row.id)).eq("org_id", orgId).eq("source", "drawing");
  let { error } = await write({ source: "manual", ...HUMAN_PROVENANCE(userId) });
  if (error && missingColumn(error)) ({ error } = await write({ source: "manual" })); // before 20261171
  if (error) throw new Error(`The link could not be saved: ${error.message}`);
  const { error: auditErr } = await admin.from("audit_logs").insert({
    action: "EQUIPMENT_BRIDGE_RELATION_ADOPTED", resource_type: "document", resource_id: documentId, org_id: orgId, user_id: userId,
    details: { assetId, tag: row.tag_text ?? null, sheet: row.sheet_label ?? null, pages: row.pages ?? null, revision: row.source_revision ?? null, model: row.model ?? null },
  });
  return {
    adopted: true, already: null,
    ...(auditErr ? { auditError: `The link is now yours, but its audit record could not be written: ${auditErr.message}` } : {}),
  };
}

/** What the knowledge door's relation write (20261235) came to. */
export interface KnowledgeRelationOutcome {
  /** Rows written or refreshed in knowledge_document_assets. */
  written: number;
  /** Why the links were not recorded (a database before 20261235, or a
   *  refused write) — the discovered equipment stands either way. */
  notRecorded: string | null;
}

/** The sentence a database before 20261235 gets (GAP-307 acceptance 3). */
export const KNOWLEDGE_RELATION_NEEDS_MIGRATION =
  "The equipment was discovered; which sheets of the upload carry it is recorded once migration 20261235 (knowledge_document_assets) is applied — discover again from the upload after it to record the links.";

/** GAP-307 — the knowledge door: a P&ID uploaded straight into a knowledge
 *  library (no controlled document) builds the registry. A person names the
 *  tags (from the coverage report's sheet-only list); each becomes a
 *  discovered asset with door 'knowledge' provenance. There is no controlled
 *  document, so there is no unit decode: the asset is created UNIT-LESS and
 *  reported (assetCategorize's discipline — never guessed).
 *
 *  GAP-307 acceptance 3 (I-26): each named tag — discovered now or already in
 *  the registry — is then related to the upload in its own relation,
 *  knowledge_document_assets (20261235): the sheet and pages it was read on,
 *  and document_assets' provenance (a machine reading; the model that
 *  transcribed the page; the revision the upload carried). Before 20261235
 *  (42P01 / PGRST205) the discovery is exactly today's and says the links
 *  need that file; a refused write is said, never thrown — the discovered
 *  equipment stands. */
export async function discoverFromKnowledge(admin: SupabaseClient, input: {
  orgId: string; userId: string; knowledgeDocumentId: string; tags: string[];
}): Promise<{ created: string[]; existing: string[]; held: string[]; failed: Array<{ tag: string; reason: string }>; unitless: number; relations: KnowledgeRelationOutcome; auditError?: string }> {
  const { orgId, userId, knowledgeDocumentId } = input;
  const out = {
    created: [] as string[], existing: [] as string[], held: [] as string[], failed: [] as Array<{ tag: string; reason: string }>, unitless: 0,
    relations: { written: 0, notRecorded: null } as KnowledgeRelationOutcome,
  };
  const { data: kdoc } = await admin.from("knowledge_documents").select("id, org_id, source_document_id, source_rev")
    .eq("id", knowledgeDocumentId).eq("org_id", orgId).maybeSingle();
  if (!kdoc) throw new Error("No such knowledge document in this workspace.");
  if (kdoc.source_document_id) throw new Error("This document mirrors a controlled document — apply its tags from the equipment sweep, which also records the relation.");
  const wantedTags = [...new Set(input.tags.map((t) => normalizeTag(String(t))).filter((t) => splitTag(t) && passesExtractorGate(t)))];
  if (wantedTags.length === 0) return out;
  // Only tags this document's own index carries — a person names what the
  // sheet says, never a free-typed tag through this door.
  const ents = await readWindows<{ tag: string; page: number; kind?: string; raw?: string | null }>(() => admin.from("knowledge_page_entities")
    .select("id, tag, page, kind, raw").eq("document_id", knowledgeDocumentId).in("kind", ["equipment", "self"])
    .order("id", { ascending: true }) as unknown as Builder, ENTITY_CEILING);
  const pagesByTag = new Map<string, Set<number>>();
  // GAP-301: the title block of each page — the sheet address the relation records.
  const selfByPage = new Map<number, Array<{ tag: string; raw?: string | null }>>();
  for (const e of ents.rows) {
    if (e.kind === "self") {
      const p = Number(e.page);
      if (Number.isFinite(p)) (selfByPage.get(p) ?? selfByPage.set(p, []).get(p)!).push({ tag: String(e.tag), raw: e.raw ?? null });
      continue;
    }
    const t = normalizeTag(String(e.tag));
    (pagesByTag.get(t) ?? pagesByTag.set(t, new Set()).get(t)!).add(Number(e.page));
  }
  const book = await loadCodebookAdmin(admin, orgId);
  const typeIdByLabel = await ensureAssetTypes(admin, orgId, book, wantedTags.map((tag) => ({ tag })));
  /** Every named tag that reached an asset (created now, or already there). */
  const toRelate: Array<{ assetId: string; tag: string; pages: Set<number> }> = [];
  for (const tag of wantedTags) {
    const pages = pagesByTag.get(tag);
    if (!pages) { out.failed.push({ tag, reason: "This document's index does not carry the tag." }); continue; }
    const { data: hit } = await admin.from("assets").select("id").eq("org_id", orgId).eq("tag_normalized", assetNorm(tag)).maybeSingle();
    if (hit) { out.existing.push(tag); toRelate.push({ assetId: String((hit as { id: string }).id), tag, pages }); continue; }
    const t = typeForTag(tag, book);
    const { data: made, error } = await admin.from("assets").insert({
      org_id: orgId, tag, tag_normalized: assetNorm(tag),
      type_id: t ? typeIdByLabel.get(t.label) ?? null : null,
      description: null, unit_code: null, code: null, origin: "drawing",
      discovered_from: { knowledgeDocumentId, pages: [...pages].sort((a, b) => a - b), door: "knowledge", revision: kdoc.source_rev ?? null },
      created_by: userId,
    }).select("id").single();
    if (error) {
      if (uniqueViolation(error)) {
        out.existing.push(tag);
        const { data: raced } = await admin.from("assets").select("id").eq("org_id", orgId).eq("tag_normalized", assetNorm(tag)).maybeSingle();
        if (raced) toRelate.push({ assetId: String((raced as { id: string }).id), tag, pages });
        continue;
      }
      out.failed.push({ tag, reason: error.message });
      continue;
    }
    if (made) toRelate.push({ assetId: String((made as { id: string }).id), tag, pages });
    out.created.push(tag);
    out.unitless++;
    if (!t) out.held.push(tag); // created untyped: the codebook does not know its prefix — teach it
  }
  // GAP-307 acceptance 3: the upload's own relation (20261235).
  out.relations = await relateKnowledgeUpload(admin, { orgId, knowledgeDocumentId, sourceRev: (kdoc.source_rev as string | null) ?? null }, toRelate, selfByPage);
  // Checked: discovery created registry assets — a missing audit row is
  // said to the caller, never swallowed (GAP-307 / GAP-303).
  const { error: auditErr } = await admin.from("audit_logs").insert({
    action: "EQUIPMENT_BRIDGE_DISCOVERED", resource_type: "knowledge_document", resource_id: knowledgeDocumentId, org_id: orgId, user_id: userId,
    details: {
      door: "knowledge", created: out.created, existing: out.existing, untyped: out.held, failed: out.failed, unitless: out.unitless,
      relationsWritten: out.relations.written, ...(out.relations.notRecorded ? { relationNotRecorded: out.relations.notRecorded } : {}),
    },
  });
  if (auditErr) return { ...out, auditError: `The equipment was discovered, but the audit record could not be written: ${auditErr.message}` };
  return out;
}

/** GAP-307 acceptance 3 — write the knowledge door's relation rows: one per
 *  (upload, asset), with the sheet address of the pages the tag was read on
 *  (GAP-301), a machine's assertion, the model that transcribed any of those
 *  pages (GOV-9; "unknown" when that record could not be read — never taken
 *  as the text layer) and the revision the upload carried. Service role
 *  only (no signed-in writer, 20261235). Never throws: a missing table is
 *  today's path, said; a refused write is said. Exported for its test (the
 *  merge by asset below). */
export async function relateKnowledgeUpload(
  admin: SupabaseClient,
  ctx: { orgId: string; knowledgeDocumentId: string; sourceRev: string | null },
  items: ReadonlyArray<{ assetId: string; tag: string; pages: ReadonlySet<number> }>,
  selfByPage: ReadonlyMap<number, ReadonlyArray<{ tag: string; raw?: string | null }>>,
): Promise<KnowledgeRelationOutcome> {
  if (items.length === 0) return { written: 0, notRecorded: null };
  // Which pages an AI model transcribed (20261122) — a missing column means
  // nothing recorded; any other failure fails toward the warning.
  const aiPages = new Map<number, string | null>();
  let aiUnknown = false;
  try {
    const v = await readWindows<{ page: number; source_model: string | null }>(() => admin
      .from("knowledge_chunks").select("id, page, source_model")
      .eq("document_id", ctx.knowledgeDocumentId).eq("source", "vision")
      .order("id", { ascending: true }) as unknown as Builder, ENTITY_CEILING);
    if (v.error && !missingColumn(v.error)) aiUnknown = true;
    for (const c of v.rows) aiPages.set(Number(c.page), c.source_model ?? null);
  } catch { aiUnknown = true; }
  // One row per (upload, asset): two spellings of one tag ('P-101A' and
  // 'P-101-A') reach the same asset, and an upsert that names the same
  // conflict key twice is refused whole by Postgres ("ON CONFLICT DO UPDATE
  // command cannot affect row a second time") — which would lose every other
  // tag in the batch. Merge by asset first: the pages united, the first
  // spelling kept as tag_text (I-26 review, DEC-90).
  const byAsset = new Map<string, { assetId: string; tag: string; pages: Set<number> }>();
  for (const it of items) {
    const seen = byAsset.get(it.assetId);
    if (seen) { for (const p of it.pages) seen.pages.add(p); continue; }
    byAsset.set(it.assetId, { assetId: it.assetId, tag: it.tag, pages: new Set(it.pages) });
  }
  const rows = [...byAsset.values()].map((it) => {
    const pages = [...it.pages].filter((p) => Number.isFinite(p)).sort((a, b) => a - b);
    const sheets = pages.map((p) => sheetAddressForPage(p, selfByPage.get(p) ?? [], aiUnknown || aiPages.has(p)));
    const model = aiUnknown ? "unknown" : (pages.map((p) => aiPages.get(p)).find((m) => m !== undefined) ?? null);
    return {
      org_id: ctx.orgId, knowledge_document_id: ctx.knowledgeDocumentId, asset_id: it.assetId,
      tag_text: it.tag, source: "drawing", sheet_label: relationSheetLabel(sheets), pages,
      asserted_by: "machine", asserted_by_user: null,
      model: model === null && pages.some((p) => aiPages.has(p)) ? "unknown" : model,
      source_revision: ctx.sourceRev, source_version_id: null,
    };
  });
  try {
    const { data, error } = await admin.from("knowledge_document_assets")
      .upsert(rows, { onConflict: "knowledge_document_id,asset_id" }).select("id");
    if (error) {
      if (missingTable(error)) return { written: 0, notRecorded: KNOWLEDGE_RELATION_NEEDS_MIGRATION };
      return { written: 0, notRecorded: `The equipment was discovered, but which sheets of the upload carry it could not be recorded: ${error.message ?? "the write was refused"}.` };
    }
    return { written: ((data as unknown[] | null) ?? []).length, notRecorded: null };
  } catch (e) {
    return { written: 0, notRecorded: `The equipment was discovered, but which sheets of the upload carry it could not be recorded: ${(e as Error)?.message ?? String(e)}.` };
  }
}

/** Find-or-create asset_types matching the codebook equipment-type labels
 *  needed by this batch — discovery builds the type list too. */
async function ensureAssetTypes(
  admin: SupabaseClient, orgId: string, book: Codebook,
  wanted: Array<{ tag: string }>,
): Promise<Map<string, string>> {
  const neededLabels = new Set<string>();
  for (const s of wanted) {
    const t = typeForTag(s.tag, book);
    if (t) neededLabels.add(t.label);
  }
  const map = new Map<string, string>();
  if (neededLabels.size === 0) return map;
  const { data: existing } = await admin.from("asset_types").select("id, name").eq("org_id", orgId);
  for (const t of (existing ?? []) as Array<{ id: string; name: string }>) map.set(t.name, String(t.id));
  for (const label of neededLabels) {
    if (map.has(label)) continue;
    const { data: created } = await admin.from("asset_types")
      .insert({ org_id: orgId, name: label, sort_order: 99 }).select("id").single();
    if (created) map.set(label, String(created.id));
    else {
      // Unique(org,name) race: someone else created it between our read and write.
      const { data: raced } = await admin.from("asset_types").select("id")
        .eq("org_id", orgId).eq("name", label).maybeSingle();
      if (raced) map.set(label, String(raced.id));
    }
  }
  return map;
}
