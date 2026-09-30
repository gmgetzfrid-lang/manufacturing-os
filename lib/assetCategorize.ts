// lib/assetCategorize.ts — the bridge the registry was missing.
//
// The Site Codebook already KNOWS the org's equipment taxonomy — the import
// wizard read their numbering documents and stored equipment types with tag
// prefixes ("E" → Exchanger). But the registry groups by its own asset_types
// table, so imported knowledge never categorized a single asset and the unit
// hub filled up with "Uncategorized". This module closes that loop:
//
//   plan  — pure: decode every uncategorized tag through the codebook and
//           say exactly what would change (testable, previewable)
//   apply — create the missing asset_types (named by the codebook) and
//           assign type_id per asset
//
// Anything the codebook can't decode is REPORTED, not guessed — the fix is
// teaching the codebook the missing prefix, which then fixes every future
// asset too.

import { supabase } from "@/lib/supabase";
import { typeForTag, codeToTag, tagToCode, tagKey, type Codebook, type CodebookEntry } from "@/lib/codebook";
import { createAssetType, updateAsset, type Asset, type AssetType } from "@/lib/assets";

export interface CategorizationPlan {
  /** tag → codebook type label, for assets currently uncategorized. */
  assignments: Array<{ assetId: string; tag: string; typeName: string }>;
  /** Assets with no operating area whose SITE CODE names one (2030.22 →
   *  unit 20) — the numbering system filing the plant by itself. */
  unitAssignments: Array<{ assetId: string; tag: string; unitCode: string }>;
  /** BR-4: assets filed to a unit with NO site code, whose code the codebook
   *  can derive (E-22 in unit 20 → 2030.22). Fill-blank only — a code that
   *  exists is never rewritten here (that is the identity review's job). */
  codeAssignments: Array<{ assetId: string; tag: string; code: string }>;
  /** Codebook labels with no matching asset_types row yet. */
  typesToCreate: string[];
  /** Uncategorized tags the codebook has no prefix for. */
  unmatched: string[];
  alreadyCategorized: number;
}

/** Pure planning: what would auto-categorize do, exactly. */
export function planCategorization(
  assets: Asset[],
  types: AssetType[],
  book: Codebook,
): CategorizationPlan {
  const typeByName = new Map(types.map((t) => [t.name.toLowerCase(), t]));
  const assignments: CategorizationPlan["assignments"] = [];
  const unitAssignments: CategorizationPlan["unitAssignments"] = [];
  const codeAssignments: CategorizationPlan["codeAssignments"] = [];
  const unmatched: string[] = [];
  const typesToCreate = new Set<string>();
  let alreadyCategorized = 0;

  for (const a of assets) {
    // Unit filing: the site code carries the unit ("2030.22" → 20). An
    // asset without an operating area whose code decodes gets filed.
    if (!a.unit_code && a.code) {
      const decoded = codeToTag(a.code, book);
      if (decoded?.unitCode) {
        unitAssignments.push({ assetId: a.id, tag: a.tag, unitCode: decoded.unitCode });
      }
    }
    // BR-4: a unit is known and the code is blank → the codebook derives it.
    if (a.unit_code && !a.code) {
      const derived = tagToCode(a.tag, a.unit_code, book);
      if (derived) codeAssignments.push({ assetId: a.id, tag: a.tag, code: derived });
    }
    if (a.type_id) { alreadyCategorized += 1; continue; }
    const entry = typeForTag(a.tag, book);
    if (!entry || !entry.label.trim()) { unmatched.push(a.tag); continue; }
    const label = entry.label.trim();
    if (!typeByName.has(label.toLowerCase())) typesToCreate.add(label);
    assignments.push({ assetId: a.id, tag: a.tag, typeName: label });
  }
  return {
    assignments,
    unitAssignments,
    codeAssignments,
    typesToCreate: [...typesToCreate].sort(),
    unmatched,
    alreadyCategorized,
  };
}

export interface CategorizationResult {
  categorized: number;
  filedToUnits: number;
  /** BR-4: blank site codes filled from the codebook. */
  codesDerived: number;
  createdTypes: number;
  unmatched: string[];
  failed: number;
}

/** Execute a plan: create missing categories (codebook-named), then assign.
 *  Per-asset failures are counted, never fatal — one bad row must not stop
 *  a five-hundred-asset sweep. */
export async function applyCategorization(
  orgId: string,
  userId: string,
  plan: CategorizationPlan,
  existingTypes: AssetType[],
): Promise<CategorizationResult> {
  const typeIdByName = new Map(existingTypes.map((t) => [t.name.toLowerCase(), t.id]));
  let createdTypes = 0;
  for (const name of plan.typesToCreate) {
    if (typeIdByName.has(name.toLowerCase())) continue;
    try {
      const t = await createAssetType({ orgId, name, sortOrder: existingTypes.length + createdTypes });
      typeIdByName.set(name.toLowerCase(), t.id);
      createdTypes += 1;
    } catch {
      // A concurrent sweep created it — re-read the name.
      const { data } = await supabase.from("asset_types")
        .select("id, name").eq("org_id", orgId).ilike("name", name).limit(1);
      const row = (data as Array<{ id: string; name: string }> | null)?.[0];
      if (row) typeIdByName.set(name.toLowerCase(), row.id);
    }
  }

  let categorized = 0;
  let failed = 0;
  for (const a of plan.assignments) {
    const typeId = typeIdByName.get(a.typeName.toLowerCase());
    if (!typeId) { failed += 1; continue; }
    try {
      await updateAsset(a.assetId, { type_id: typeId }, userId);
      categorized += 1;
    } catch { failed += 1; }
  }
  let filedToUnits = 0;
  for (const u of plan.unitAssignments) {
    try {
      await updateAsset(u.assetId, { unit_code: u.unitCode }, userId);
      filedToUnits += 1;
    } catch { failed += 1; }
  }
  let codesDerived = 0;
  for (const c of plan.codeAssignments ?? []) {
    try {
      await updateAsset(c.assetId, { code: c.code }, userId);
      codesDerived += 1;
    } catch { failed += 1; }
  }
  return { categorized, filedToUnits, codesDerived, createdTypes, unmatched: plan.unmatched, failed };
}

// ─── Identity review (AREA-11 / CB-6) ─────────────────────────────────────
//
// A site code carries its unit inside it (2530.22 → unit 25), so assets.code
// and assets.unit_code are two spellings of one fact, and both are frozen at
// the moment they were derived. Nothing here writes: the plan says what
// disagrees with the codebook AS IT STANDS, and a person accepts per asset
// (never a silent rewrite — the CB-6 decision).

type IdentityFields = Pick<Asset, "id" | "tag" | "unit_code" | "code">;

/** AREA-11: the unit a stored site code names, when it contradicts the
 *  asset's filing. Null when they agree, when either is blank, or when the
 *  codebook cannot place the code (no opinion is not a conflict). */
export function codeUnitConflict(a: IdentityFields, book: Codebook): { codeUnit: string; unitCode: string } | null {
  if (!a.code || !a.unit_code) return null;
  const decoded = codeToTag(a.code, book);
  if (!decoded) return null;
  return decoded.unitCode !== a.unit_code ? { codeUnit: decoded.unitCode, unitCode: a.unit_code } : null;
}

export interface IdentityReviewRow {
  assetId: string;
  tag: string;
  unitCode: string | null;
  code: string | null;
  /** code_names_other_unit — AREA-11: the code says one unit, the filing another.
   *  code_rederives — CB-6: the codebook as it stands derives a different code
   *  (a padding, type-code or prefix edit since the code was written). */
  kind: "code_names_other_unit" | "code_rederives";
  /** The unit the stored code names (code_names_other_unit). */
  codeUnit: string | null;
  /** What the current codebook derives for (tag, unit_code); null = it cannot. */
  derivedCode: string | null;
}

/** The re-decode plan: every asset whose stored identity disagrees with the
 *  codebook as it stands. Pure. Blank codes are the categorizer's fill-blank
 *  job (codeAssignments), not a disagreement. */
export function planIdentityReview(assets: ReadonlyArray<IdentityFields>, book: Codebook): IdentityReviewRow[] {
  const out: IdentityReviewRow[] = [];
  for (const a of assets) {
    if (!a.unit_code || !a.code) continue;
    const derived = tagToCode(a.tag, a.unit_code, book);
    const conflict = codeUnitConflict(a, book);
    if (conflict) {
      out.push({ assetId: a.id, tag: a.tag, unitCode: a.unit_code, code: a.code, kind: "code_names_other_unit", codeUnit: conflict.codeUnit, derivedCode: derived });
    } else if (derived && derived !== a.code) {
      out.push({ assetId: a.id, tag: a.tag, unitCode: a.unit_code, code: a.code, kind: "code_rederives", codeUnit: null, derivedCode: derived });
    }
  }
  return out;
}

/** CB-10: site codes STORED on more than one asset of the org — what keeps
 *  the unique index (assets_org_code_unique, 20261128) from being created,
 *  and what a person resolves first. Blank codes are not identities. */
export function sharedSiteCodes(
  assets: ReadonlyArray<Pick<Asset, "id" | "tag" | "code">>,
): Array<{ code: string; assets: Array<{ id: string; tag: string }> }> {
  const byCode = new Map<string, Array<{ id: string; tag: string }>>();
  for (const a of assets) {
    const c = (a.code ?? "").trim() ? a.code! : null;
    if (!c) continue;
    byCode.set(c, [...(byCode.get(c) ?? []), { id: a.id, tag: a.tag }]);
  }
  return [...byCode.entries()].filter(([, list]) => list.length > 1)
    .map(([code, list]) => ({ code, assets: list }))
    .sort((x, y) => x.code.localeCompare(y.code, undefined, { numeric: true }));
}

/** CB-6 / CB-7: before a codebook edit is saved — how many assets carry a
 *  code the CURRENT rule derived that the EDITED rule would derive
 *  differently (or not at all). The edit never rewrites them; the count is
 *  the warning, the identity review is the remedy. */
export function rederivationImpact(
  assets: ReadonlyArray<IdentityFields>,
  before: Codebook,
  after: Codebook,
): { changed: number; examples: Array<{ tag: string; from: string; to: string | null }> } {
  let changed = 0;
  const examples: Array<{ tag: string; from: string; to: string | null }> = [];
  for (const a of assets) {
    if (!a.unit_code || !a.code) continue;
    const was = tagToCode(a.tag, a.unit_code, before);
    if (!was || was !== a.code) continue; // not derived under the current rule
    const next = tagToCode(a.tag, a.unit_code, after);
    if (next === was) continue;
    changed += 1;
    if (examples.length < 3) examples.push({ tag: a.tag, from: was, to: next });
  }
  return { changed, examples };
}

/** CB-5: how many registry assets reference a codebook entry — a unit by
 *  filing (unit_code) or by a code that decodes to it; an equipment type by
 *  the tags it types or a code carrying its type code. */
export function entryAssetReferences(
  entry: Pick<CodebookEntry, "id" | "kind" | "code">,
  assets: ReadonlyArray<IdentityFields>,
  book: Codebook,
): number {
  let n = 0;
  for (const a of assets) {
    const decoded = a.code ? codeToTag(a.code, book) : null;
    if (entry.kind === "unit") {
      if (a.unit_code === entry.code || decoded?.unitCode === entry.code) n += 1;
    } else if (entry.kind === "equipment_type") {
      if (typeForTag(a.tag, book)?.id === entry.id || decoded?.typeCode === entry.code) n += 1;
    }
  }
  return n;
}

// ─── Master-list import (BR-4 / AREA-7 / BR-6) ────────────────────────────

export interface ImportRowInput {
  /** 1-based spreadsheet row (the header is row 1). */
  row: number;
  tag: string;
  description?: string;
  location?: string;
  typeName?: string;
  /** A codebook unit, by code ("20") or by name ("Crude Unit"). */
  unit?: string;
  /** A site code ("2030.22"). */
  code?: string;
}

export type ImportMode = "create_only" | "create_and_update";

export interface ImportRowPlan {
  row: number;
  tag: string;
  action: "create" | "update" | "skip" | "error";
  existingId: string | null;
  /** Where the row lands: the operating area (null = unassigned). */
  unitCode: string | null;
  code: string | null;
  typeId: string | null;
  /** What the row will write (update: only the cells the file supplies). */
  patch: Partial<Pick<Asset, "description" | "location" | "type_id" | "unit_code" | "code">>;
  notes: string[];
  error: string | null;
}

export interface ImportPlan {
  rows: ImportRowPlan[];
  creates: number;
  updates: number;
  skipped: number;
  errors: number;
  /** Rows that land in an operating area. */
  filed: number;
  /** Rows whose tag already exists in the registry. */
  existing: number;
}

/** Resolve a unit cell against the codebook: code first ("20"), then name
 *  ("Crude Unit", case-insensitive). Never guesses. */
export function resolveUnitCell(cell: string | undefined, book: Codebook): { unitCode: string | null; unknown: string | null } {
  const v = String(cell ?? "").trim();
  if (!v) return { unitCode: null, unknown: null };
  const byCode = book.units.find((u) => u.code.trim() === v);
  if (byCode) return { unitCode: byCode.code, unknown: null };
  const byLabel = book.units.find((u) => u.label.trim().toLowerCase() === v.toLowerCase());
  if (byLabel) return { unitCode: byLabel.code, unknown: null };
  return { unitCode: null, unknown: v };
}

/** Plan a master-list import row by row, before anything is written: which
 *  rows create, which update an existing tag (BR-6), which operating area
 *  each lands in (BR-4 / AREA-7 — from the unit column, or decoded from the
 *  site code when only the code is given), which site code it carries
 *  (given, or derived once the unit is known). Pure. */
export function planAssetImport(
  input: ReadonlyArray<ImportRowInput>,
  ctx: {
    book: Codebook;
    types: ReadonlyArray<Pick<AssetType, "id" | "name">>;
    /** Existing registry rows by tag key (tagKey). */
    existing: ReadonlyMap<string, Pick<Asset, "id" | "unit_code" | "code">>;
    mode: ImportMode;
  },
): ImportPlan {
  const typeByName = new Map(ctx.types.map((t) => [t.name.trim().toLowerCase(), t.id]));
  const firstRowByKey = new Map<string, number>();
  const rows: ImportRowPlan[] = [];
  for (const r of input) {
    const tag = String(r.tag ?? "").trim();
    const base: ImportRowPlan = { row: r.row, tag, action: "error", existingId: null, unitCode: null, code: null, typeId: null, patch: {}, notes: [], error: null };
    const key = tagKey(tag);
    if (!key) { rows.push({ ...base, error: "Missing tag" }); continue; }
    const dup = firstRowByKey.get(key);
    if (dup !== undefined) { rows.push({ ...base, error: `Same tag as row ${dup} — one row per asset` }); continue; }
    firstRowByKey.set(key, r.row);

    const notes: string[] = [];
    const unitCell = resolveUnitCell(r.unit, ctx.book);
    if (unitCell.unknown) notes.push(`Unit "${unitCell.unknown}" is not in the Site Codebook — left unassigned.`);
    const givenCode = String(r.code ?? "").trim() || null;
    const decoded = givenCode ? codeToTag(givenCode, ctx.book) : null;
    if (givenCode && !decoded) notes.push(`Site code ${givenCode} does not decode through the codebook — kept as given.`);
    let unitCode = unitCell.unitCode;
    if (!unitCode && decoded) {
      unitCode = decoded.unitCode;
      notes.push(`Unit ${unitCode} read from the site code.`);
    } else if (unitCode && decoded && decoded.unitCode !== unitCode) {
      notes.push(`Site code ${givenCode} names unit ${decoded.unitCode}, the unit column says ${unitCode} — both kept; resolve it under Identity review.`);
    }
    const derived = !givenCode && unitCode ? tagToCode(tag, unitCode, ctx.book) : null;
    if (derived) notes.push(`Site code ${derived} derived from the codebook.`);
    const typeName = String(r.typeName ?? "").trim();
    const typeId = typeName ? (typeByName.get(typeName.toLowerCase()) ?? null) : null;
    if (typeName && !typeId) notes.push(`Type "${typeName}" is not a category yet — left uncategorized.`);

    const existing = ctx.existing.get(key) ?? null;
    const description = String(r.description ?? "").trim() || undefined;
    const location = String(r.location ?? "").trim() || undefined;
    if (!existing) {
      rows.push({
        ...base, action: "create", unitCode, code: givenCode ?? derived, typeId, notes,
        patch: { description, location, type_id: typeId ?? undefined, unit_code: unitCode ?? undefined, code: givenCode ?? derived ?? undefined },
      });
      continue;
    }
    if (ctx.mode === "create_only") {
      rows.push({ ...base, action: "skip", existingId: existing.id, unitCode: existing.unit_code ?? null, code: existing.code ?? null, notes: ["Already in the registry — skipped (create-only)."] });
      continue;
    }
    // Update: only the cells the file supplies; a DERIVED code fills a blank
    // and never overwrites a code that exists (that is the identity review).
    const patch: ImportRowPlan["patch"] = {};
    if (description !== undefined) patch.description = description;
    if (location !== undefined) patch.location = location;
    if (typeId) patch.type_id = typeId;
    if (unitCode) patch.unit_code = unitCode;
    if (givenCode) patch.code = givenCode;
    else if (derived && !existing.code) patch.code = derived;
    const nextUnit = patch.unit_code ?? existing.unit_code ?? null;
    const nextCode = patch.code ?? existing.code ?? null;
    if (!givenCode && existing.code && unitCode && unitCode !== existing.unit_code) {
      notes.push(`Its existing site code ${existing.code} was kept — review it under Identity review.`);
    }
    if (Object.keys(patch).length === 0) {
      rows.push({ ...base, action: "skip", existingId: existing.id, unitCode: nextUnit, code: nextCode, notes: [...notes, "Nothing in this row changes the existing asset."] });
      continue;
    }
    rows.push({ ...base, action: "update", existingId: existing.id, unitCode: nextUnit, code: nextCode, typeId, patch, notes });
  }
  return {
    rows,
    creates: rows.filter((r) => r.action === "create").length,
    updates: rows.filter((r) => r.action === "update").length,
    skipped: rows.filter((r) => r.action === "skip").length,
    errors: rows.filter((r) => r.action === "error").length,
    filed: rows.filter((r) => (r.action === "create" || r.action === "update") && r.unitCode).length,
    existing: rows.filter((r) => r.existingId !== null).length,
  };
}

/** AREA-7: every asset whose tag starts with a prefix, by the one grammar
 *  ("E" or "e-" matches E-22 and E-101, never EA-1 unless asked for "EA").
 *  The bulk-file path of the unassigned panel. */
export function assetsMatchingTagPrefix<T extends Pick<Asset, "id" | "tag">>(assets: ReadonlyArray<T>, prefix: string): T[] {
  const want = tagKey(prefix);
  if (!want) return [];
  const letters = /^[a-z]+$/.test(want);
  return assets.filter((a) => {
    const k = tagKey(a.tag);
    if (!k.startsWith(want)) return false;
    // A letters-only prefix is a whole tag prefix: "e" must not take "ea1".
    return letters ? /^\d/.test(k.slice(want.length)) : true;
  });
}
