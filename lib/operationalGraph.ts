// lib/operationalGraph.ts
//
// Phase 1 completion — CRUD + read helpers for the operational entity
// graph (Plant → Unit → System) introduced in migrations
// 20260606_operational_entity_graph.sql and the normalization join
// tables (document_assets, project_documents) introduced in
// 20260609_phase1_normalization.sql.
//
// Why one module: these tables are intentionally co-located in the
// data model and almost always used together. Splitting into three
// files would create import-graph noise without semantic value.
//
// No business logic lives here — this is the data-access seam.
// Authorization is enforced by RLS (org-member-all) plus app-level
// role checks in the callers (only Admin/Manager creates a Plant).
//
// ONE UNIT IDENTITY (GAP-305, intelligence Round G I-13). The operational
// `units` table (a configured operating unit) and the Site Codebook unit (a
// decoded code — what the registry files equipment by) are both kept and
// JOINED as data: units.codebook_code maps a codebook code to at most one
// units row (20261138). The unit-identity backfill (planUnitIdentity here,
// run by POST /api/admin/unit-identity) writes the two derived columns the
// join needs: documents.unit_code = the drawing-number decode (never a
// guess — a number that does not decode is reported) and assets.unit_id =
// the mapping's projection of assets.unit_code, FILLED where it is empty
// (a value already there is never rewritten — a disagreement is counted).

import { supabase } from "@/lib/supabase";
import type { Plant, Unit, PlantSystem } from "@/types/schema";
import { parseDrawingNumber, explainDrawingNumberMiss, type Codebook } from "@/lib/codebook";
import { isMissingColumn, pageRows, pageIn } from "@/lib/orgGraph";

// ─── Row shapes (snake_case from Postgres) ──────────────────────

interface PlantRow {
  id: string;
  org_id: string;
  name: string;
  code: string | null;
  description: string | null;
  location: string | null;
  metadata: Record<string, unknown> | null;
  archived: boolean;
  created_at: string;
  created_by: string;
  updated_at: string | null;
  updated_by: string | null;
}

interface UnitRow {
  id: string;
  org_id: string;
  plant_id: string;
  name: string;
  code: string | null;
  /** 20261138 — the Site Codebook unit this operational unit IS (or null). */
  codebook_code?: string | null;
  description: string | null;
  metadata: Record<string, unknown> | null;
  archived: boolean;
  created_at: string;
  created_by: string;
  updated_at: string | null;
  updated_by: string | null;
}

interface SystemRow {
  id: string;
  org_id: string;
  unit_id: string;
  plant_id: string;
  name: string;
  code: string | null;
  description: string | null;
  metadata: Record<string, unknown> | null;
  archived: boolean;
  created_at: string;
  created_by: string;
  updated_at: string | null;
  updated_by: string | null;
}

// ─── Row → Type mappers ────────────────────────────────────────

function plantRow(r: PlantRow): Plant {
  return {
    id: r.id, orgId: r.org_id, name: r.name, code: r.code,
    description: r.description, location: r.location,
    metadata: r.metadata ?? undefined, archived: r.archived,
    createdAt: r.created_at, createdBy: r.created_by,
    updatedAt: r.updated_at ?? undefined, updatedBy: r.updated_by ?? undefined,
  };
}

function unitRow(r: UnitRow): Unit {
  return {
    id: r.id, orgId: r.org_id, plantId: r.plant_id, name: r.name, code: r.code,
    description: r.description, metadata: r.metadata ?? undefined,
    archived: r.archived, createdAt: r.created_at, createdBy: r.created_by,
    updatedAt: r.updated_at ?? undefined, updatedBy: r.updated_by ?? undefined,
  };
}

function systemRow(r: SystemRow): PlantSystem {
  return {
    id: r.id, orgId: r.org_id, unitId: r.unit_id, plantId: r.plant_id,
    name: r.name, code: r.code, description: r.description,
    metadata: r.metadata ?? undefined, archived: r.archived,
    createdAt: r.created_at, createdBy: r.created_by,
    updatedAt: r.updated_at ?? undefined, updatedBy: r.updated_by ?? undefined,
  };
}

// ─── Plants ─────────────────────────────────────────────────────

export async function listPlants(orgId: string, opts?: { includeArchived?: boolean }): Promise<Plant[]> {
  let q = supabase.from("plants").select("*").eq("org_id", orgId).order("name", { ascending: true });
  if (!opts?.includeArchived) q = q.eq("archived", false);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return ((data as PlantRow[]) ?? []).map(plantRow);
}

export async function createPlant(input: {
  orgId: string; name: string; code?: string; description?: string;
  location?: string; createdBy: string;
}): Promise<Plant> {
  const { data, error } = await supabase.from("plants").insert({
    org_id: input.orgId, name: input.name.trim(),
    code: input.code?.trim() || null,
    description: input.description?.trim() || null,
    location: input.location?.trim() || null,
    created_by: input.createdBy, updated_by: input.createdBy,
  }).select("*").single();
  if (error) throw new Error(error.message);
  return plantRow(data as PlantRow);
}

export async function updatePlant(id: string, patch: Partial<Pick<Plant, "name" | "code" | "description" | "location" | "archived">>, updatedBy: string): Promise<void> {
  const update: Record<string, unknown> = {
    ...patch, updated_by: updatedBy, updated_at: new Date().toISOString(),
  };
  const { error } = await supabase.from("plants").update(update).eq("id", id);
  if (error) throw new Error(error.message);
}

export async function archivePlant(id: string, updatedBy: string): Promise<void> {
  return updatePlant(id, { archived: true }, updatedBy);
}

// ─── Units ──────────────────────────────────────────────────────

async function listUnitRows(orgId: string, opts?: { plantId?: string; includeArchived?: boolean }): Promise<UnitRow[]> {
  let q = supabase.from("units").select("*").eq("org_id", orgId).order("name", { ascending: true });
  if (opts?.plantId) q = q.eq("plant_id", opts.plantId);
  if (!opts?.includeArchived) q = q.eq("archived", false);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data as UnitRow[]) ?? [];
}

export async function listUnits(orgId: string, opts?: { plantId?: string; includeArchived?: boolean }): Promise<Unit[]> {
  return (await listUnitRows(orgId, opts)).map(unitRow);
}

/** GAP-305 — map an operational unit to the Site Codebook unit it is (or
 *  unmap it with null). Checked: a refusal or a code already mapped to
 *  another unit (UNIQUE per org, 20261138) is an error, never a green save.
 *  The database decides who may (20261138's units_codebook_code_guard: the
 *  Operational scope writer tier — a browser check alone is not a rail) and
 *  releases an archived unit's code, so the value is read back. */
export async function setUnitCodebookCode(unitId: string, codebookCode: string | null, updatedBy: string): Promise<void> {
  const code = codebookCode?.trim() || null;
  const { data, error } = await supabase.from("units")
    .update({ codebook_code: code, updated_by: updatedBy, updated_at: new Date().toISOString() })
    .eq("id", unitId).select("id, codebook_code");
  if (error) {
    if (error.code === "23505" || /units_org_codebook_code_uniq/.test(error.message)) {
      throw new Error(`Site Codebook unit ${code} is already mapped to another operational unit — unmap it there first.`);
    }
    if (error.code === "42501" || /units_codebook_code_scope_writers/.test(error.message)) {
      throw new Error("Not saved — only the roles that edit the operational scope can map a unit to the Site Codebook.");
    }
    if (isMissingColumn(error)) throw new Error("The unit-identity migration (20261138) is not applied yet — the mapping cannot be saved.");
    throw new Error(error.message);
  }
  if (!data || data.length === 0) throw new Error("Not saved — the mapping was refused.");
  const saved = ((data[0] as { codebook_code?: string | null }).codebook_code ?? null);
  if (saved !== code) throw new Error("Not saved — an archived unit holds no Site Codebook unit (restore it first).");
}

/** A Site Codebook unit and the operational unit that holds it. */
export interface CodebookMappingHolder {
  code: string;
  unitId: string;
  unitName: string;
  plantId: string | null;
  plantName: string | null;
  /** The unit hangs from an ARCHIVED plant: archiving a plant does not
   *  archive its units, so the unit keeps its code but is not on the scope
   *  tree unless archived rows are shown. */
  plantArchived: boolean;
}

/** GAP-305 — every Site Codebook unit held by an operational unit, read
 *  directly from units (codebook_code set, the unit not archived — an
 *  archived unit holds none), under ANY plant. The scope tree alone misses a
 *  unit under an archived plant, and the picker would offer its code as free
 *  (the save then fails on the UNIQUE mapping). [] before 20261138. */
export async function listCodebookMappings(orgId: string): Promise<CodebookMappingHolder[]> {
  const r = await pageRows<{ id: string; name: string; plant_id: string | null; codebook_code: string | null }>(
    "units", "id, name, plant_id, codebook_code", orgId, 100_000,
    (q) => q.eq("archived", false).not("codebook_code", "is", null));
  if (r.error) {
    if (isMissingColumn(r.error)) return [];
    throw new Error(r.error.message);
  }
  const plantIds = [...new Set(r.rows.map((u) => u.plant_id).filter((p): p is string => !!p))];
  const plants = await pageIn<{ id: string; name: string; archived: boolean | null }>(
    "plants", "id, name, archived", orgId, "id", plantIds, plantIds.length + 1);
  if (plants.error) throw new Error(plants.error.message);
  const plantOf = new Map(plants.rows.map((p) => [String(p.id), p]));
  return r.rows
    .filter((u) => (u.codebook_code ?? "").trim() !== "")
    .map((u) => {
      const p = u.plant_id ? plantOf.get(u.plant_id) : undefined;
      return {
        code: (u.codebook_code ?? "").trim(), unitId: u.id, unitName: u.name,
        plantId: u.plant_id ?? null, plantName: p?.name ?? null, plantArchived: !!p?.archived,
      };
    });
}

export async function createUnit(input: {
  orgId: string; plantId: string; name: string; code?: string;
  description?: string; createdBy: string;
}): Promise<Unit> {
  const { data, error } = await supabase.from("units").insert({
    org_id: input.orgId, plant_id: input.plantId, name: input.name.trim(),
    code: input.code?.trim() || null, description: input.description?.trim() || null,
    created_by: input.createdBy, updated_by: input.createdBy,
  }).select("*").single();
  if (error) throw new Error(error.message);
  return unitRow(data as UnitRow);
}

export async function updateUnit(id: string, patch: Partial<Pick<Unit, "name" | "code" | "description" | "archived">>, updatedBy: string): Promise<void> {
  const update: Record<string, unknown> = {
    ...patch, updated_by: updatedBy, updated_at: new Date().toISOString(),
  };
  const { error } = await supabase.from("units").update(update).eq("id", id);
  if (error) throw new Error(error.message);
}

export async function archiveUnit(id: string, updatedBy: string): Promise<void> {
  return updateUnit(id, { archived: true }, updatedBy);
}

// ─── Systems ────────────────────────────────────────────────────

export async function listSystems(orgId: string, opts?: { unitId?: string; plantId?: string; includeArchived?: boolean }): Promise<PlantSystem[]> {
  let q = supabase.from("systems").select("*").eq("org_id", orgId).order("name", { ascending: true });
  if (opts?.unitId) q = q.eq("unit_id", opts.unitId);
  if (opts?.plantId) q = q.eq("plant_id", opts.plantId);
  if (!opts?.includeArchived) q = q.eq("archived", false);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return ((data as SystemRow[]) ?? []).map(systemRow);
}

export async function createSystem(input: {
  orgId: string; unitId: string; plantId: string; name: string; code?: string;
  description?: string; createdBy: string;
}): Promise<PlantSystem> {
  const { data, error } = await supabase.from("systems").insert({
    org_id: input.orgId, unit_id: input.unitId, plant_id: input.plantId,
    name: input.name.trim(), code: input.code?.trim() || null,
    description: input.description?.trim() || null,
    created_by: input.createdBy, updated_by: input.createdBy,
  }).select("*").single();
  if (error) throw new Error(error.message);
  return systemRow(data as SystemRow);
}

export async function updateSystem(id: string, patch: Partial<Pick<PlantSystem, "name" | "code" | "description" | "archived">>, updatedBy: string): Promise<void> {
  const update: Record<string, unknown> = {
    ...patch, updated_by: updatedBy, updated_at: new Date().toISOString(),
  };
  const { error } = await supabase.from("systems").update(update).eq("id", id);
  if (error) throw new Error(error.message);
}

export async function archiveSystem(id: string, updatedBy: string): Promise<void> {
  return updateSystem(id, { archived: true }, updatedBy);
}

// ─── Scope tree ─────────────────────────────────────────────────

export interface ScopeNode {
  plant: Plant;
  /** codebookCode — the Site Codebook unit this operational unit is mapped
   *  to (GAP-305), null when unmapped or before 20261138. */
  units: Array<{ unit: Unit; systems: PlantSystem[]; codebookCode: string | null }>;
}

/** Single-call read of the full Plant→Unit→System tree for an org.
 *  Excludes archived rows by default. Three parallel queries — the
 *  call sites are admin/scope UIs where total row count is small
 *  (refineries typically have <10 plants, <50 units, <200 systems). */
export async function getScopeTree(orgId: string, opts?: { includeArchived?: boolean }): Promise<ScopeNode[]> {
  const [plants, unitRows, systems] = await Promise.all([
    listPlants(orgId, opts),
    listUnitRows(orgId, opts),
    listSystems(orgId, opts),
  ]);

  const unitsByPlant = new Map<string, Array<{ unit: Unit; codebookCode: string | null }>>();
  for (const r of unitRows) {
    const arr = unitsByPlant.get(r.plant_id) ?? [];
    arr.push({ unit: unitRow(r), codebookCode: r.codebook_code ?? null });
    unitsByPlant.set(r.plant_id, arr);
  }
  const systemsByUnit = new Map<string, PlantSystem[]>();
  for (const s of systems) {
    const arr = systemsByUnit.get(s.unitId) ?? [];
    arr.push(s);
    systemsByUnit.set(s.unitId, arr);
  }

  return plants.map((plant) => ({
    plant,
    units: (unitsByPlant.get(plant.id!) ?? []).map(({ unit, codebookCode }) => ({
      unit,
      systems: systemsByUnit.get(unit.id!) ?? [],
      codebookCode,
    })),
  }));
}

// ─── Unit identity backfill (GAP-305) ───────────────────────────

export interface UnitIdentityDoc {
  id: string; document_number: string | null; unit_code: string | null; unit_id: string | null;
  /** documents.visibility — NULL / 'normal' is open to every active member
   *  (node_visible); anything else is restricted (controllers, the owner, an
   *  ACL grant). The report names a restricted document's number only to a
   *  caller who sees every document (DEC-44). */
  visibility?: string | null;
}
export interface UnitIdentityAsset { id: string; unit_code: string | null; unit_id: string | null }
export interface UnitMappingRow { id: string; codebook_code: string | null }

/** What one backfill run found and did — counts, and sample numbers for the
 *  ones that do not decode (never a guess). */
export interface UnitIdentityReport {
  dryRun: boolean;
  documents: {
    scanned: number;
    /** decode to a unit the Site Codebook holds. */
    decoded: number;
    /** unit_code writes planned (set, changed or cleared). */
    toWrite: number;
    /** of those, decodes that no longer hold (cleared). */
    toClear: number;
    written: number;
    /** planned, but the document's number changed (or it was deleted) after
     *  the read — the write re-checks the number and left it as it is. */
    changed: number;
    refused: number;
    noNumber: number;
    /** `unlisted`: restricted documents among `count` whose numbers are not
     *  listed — the caller is not a controller, and the decode reads every
     *  document with the service role, so the report names only what any
     *  member may see. */
    notDecoding: { count: number; samples: Array<{ number: string; reason: string }>; unlisted: number };
    /** decode, but the number format has no unit segment. */
    noUnitSegment: number;
    /** decode to a unit code the Site Codebook does not hold. `codes` comes
     *  from the documents the caller may see; `unlisted` counts the rest. */
    unknownUnit: { count: number; codes: Array<{ code: string; count: number }>; unlisted: number };
    /** DEC-30: the document's operational unit (documents.unit_id) is mapped
     *  to a different codebook unit than the one its number decodes to (both
     *  are kept; nothing is rewritten) — 20261138's re-paste counts the same. */
    disagreeWithUnitId: number;
    /** the document decodes, but its operational unit is not mapped to the
     *  Site Codebook, so the two cannot be compared. */
    unitIdUnmapped: number;
  };
  /** assets.unit_id is FILLED, never rewritten: `toSet` empty values the
   *  filing maps; `disagreeWithFiling` hold a different operational unit
   *  than the filing maps to (both kept — counted, as for documents);
   *  `keptWithoutFiling` hold a unit while the filing maps to none (no
   *  unit_code, or its codebook unit is not mapped) — kept. */
  assets: {
    scanned: number; toSet: number; disagreeWithFiling: number; keptWithoutFiling: number; written: number;
    /** planned, but after the read the item's unit_id was set (or its filing
     *  changed, or it was deleted) — the fill re-checks and left it as it is. */
    changed: number;
    refused: number;
  };
  mapping: { operationalUnits: number; mapped: number; codebookUnitsUnmapped: string[] };
  /** Writes still to do after this call (an apply works through at most a
   *  budget per call — POST /api/admin/unit-identity; the panel calls again
   *  until it is 0). Always 0 on a preview. */
  remaining: number;
  notes: string[];
}

export interface UnitIdentityPlan {
  /** documents.unit_code value (null = clear) → document ids. */
  docWrites: Map<string | null, string[]>;
  /** assets.unit_id value → asset ids (only ever an empty unit_id filled). */
  assetWrites: Map<string, string[]>;
  report: UnitIdentityReport;
}

const MAX_SAMPLES = 50;

/** node_visible's open arm: NULL / 'normal' visibility is readable by every
 *  active member; anything else is restricted. */
export function isOpenVisibility(visibility: string | null | undefined): boolean {
  return visibility === null || visibility === undefined || visibility === "normal";
}

/** Pure: decode every document number with the org's own codebook and
 *  project every asset's filing through the mapping. Rules:
 *   * documents.unit_code = the decoded unit when it is one the codebook
 *     holds; otherwise null — a number that does not decode, decodes with no
 *     unit segment, or decodes to an unknown unit is REPORTED, never guessed;
 *   * with no drawing-number format (or no units) in the codebook nothing is
 *     written to documents at all — an empty book is "no opinion", and a
 *     codebook that failed to load must never clear the decodes;
 *   * the report lists a document's number (or its unknown unit code) only
 *     when the caller may read that document: every number for a caller who
 *     sees every document (`seesRestricted` — the controller tier), otherwise
 *     only open-visibility documents; the rest are counted as `unlisted`;
 *   * assets.unit_id = the operational unit mapped to assets.unit_code, set
 *     ONLY where unit_id is empty. A value already there — set by hand, by an
 *     import, or by an earlier pass under an older mapping — is never
 *     re-pointed or cleared (nothing records what it was): a value that
 *     disagrees with the filing is counted, as a document's disagreement is;
 *   * documents.unit_id is never written (a configured scope, not a decode). */
export function planUnitIdentity(input: {
  docs: UnitIdentityDoc[]; assets: UnitIdentityAsset[]; units: UnitMappingRow[]; book: Codebook; dryRun: boolean;
  /** The caller sees every document (the controller tier — is_org_controller). */
  seesRestricted?: boolean;
}): UnitIdentityPlan {
  const { docs, assets, units, book } = input;
  const seesRestricted = input.seesRestricted === true;
  const notes: string[] = [];
  const rowOfCode = new Map<string, string>();
  const codeOfRow = new Map<string, string>();
  for (const u of units) {
    const c = (u.codebook_code ?? "").trim();
    if (!c || rowOfCode.has(c)) continue;
    rowOfCode.set(c, u.id);
    codeOfRow.set(u.id, c);
  }
  const knownUnits = new Set(book.units.map((u) => u.code));

  const docWrites = new Map<string | null, string[]>();
  const push = <K,>(m: Map<K, string[]>, k: K, id: string) => { const a = m.get(k) ?? []; a.push(id); m.set(k, a); };
  const d = {
    scanned: docs.length, decoded: 0, toWrite: 0, toClear: 0, written: 0, changed: 0, refused: 0, noNumber: 0,
    notDecoding: { count: 0, samples: [] as Array<{ number: string; reason: string }>, unlisted: 0 },
    noUnitSegment: 0,
    unknownUnit: { count: 0, codes: [] as Array<{ code: string; count: number }>, unlisted: 0 },
    disagreeWithUnitId: 0, unitIdUnmapped: 0,
  };
  const unknown = new Map<string, number>();
  const canDecode = !!book.drawingNumber && book.drawingNumber.segments.length > 0 && book.units.length > 0;
  if (!canDecode) {
    notes.push(!book.drawingNumber
      ? "The Site Codebook has no drawing-number format, so no document number can be decoded — nothing was written to documents (Admin → Site Codebook)."
      : "The Site Codebook has no units, so no decoded number can name one — nothing was written to documents.");
  }
  let unknownTotal = 0;
  for (const doc of docs) {
    const number = (doc.document_number ?? "").trim();
    const listable = seesRestricted || isOpenVisibility(doc.visibility);
    let target: string | null = null;
    if (!number) {
      d.noNumber += 1;
    } else if (canDecode) {
      const parsed = parseDrawingNumber(number, book);
      if (!parsed) {
        d.notDecoding.count += 1;
        if (!listable) d.notDecoding.unlisted += 1;
        else if (d.notDecoding.samples.length < MAX_SAMPLES) {
          d.notDecoding.samples.push({ number, reason: explainDrawingNumberMiss(number, book) ?? "Doesn't match the segments." });
        }
      } else if (!parsed.unitCode) {
        d.noUnitSegment += 1;
      } else if (!knownUnits.has(parsed.unitCode)) {
        unknownTotal += 1;
        if (!listable) d.unknownUnit.unlisted += 1;
        else unknown.set(parsed.unitCode, (unknown.get(parsed.unitCode) ?? 0) + 1);
      } else {
        target = parsed.unitCode;
        d.decoded += 1;
        if (doc.unit_id) {
          const rowCode = codeOfRow.get(doc.unit_id);
          if (!rowCode) d.unitIdUnmapped += 1;
          else if (rowCode !== target) d.disagreeWithUnitId += 1;
        }
      }
    }
    if (!canDecode) continue; // never clear on an empty book
    if ((doc.unit_code ?? null) !== target) {
      push(docWrites, target, doc.id);
      d.toWrite += 1;
      if (target === null) d.toClear += 1;
    }
  }
  d.unknownUnit.count = unknownTotal;
  d.unknownUnit.codes = [...unknown.entries()].sort((x, y) => y[1] - x[1]).map(([code, count]) => ({ code, count }));

  const assetWrites = new Map<string, string[]>();
  const a = { scanned: assets.length, toSet: 0, disagreeWithFiling: 0, keptWithoutFiling: 0, written: 0, changed: 0, refused: 0 };
  for (const asset of assets) {
    const target = asset.unit_code ? rowOfCode.get(asset.unit_code) ?? null : null;
    const current = asset.unit_id ?? null;
    if (current === target) continue;
    if (current === null) {
      // Only an EMPTY unit_id is filled (target is non-null here).
      push(assetWrites, target as string, asset.id); a.toSet += 1;
    } else if (target === null) {
      // Held while the filing maps to no operational unit: kept.
      a.keptWithoutFiling += 1;
    } else {
      // Held, and the filing maps elsewhere: both kept, the disagreement
      // counted — a hand-set or imported value is never overwritten.
      a.disagreeWithFiling += 1;
    }
  }

  const mapped = new Set(rowOfCode.keys());
  return {
    docWrites, assetWrites,
    report: {
      dryRun: input.dryRun,
      documents: d,
      assets: a,
      mapping: {
        operationalUnits: units.length,
        mapped: mapped.size,
        codebookUnitsUnmapped: book.units.map((u) => u.code).filter((c) => !mapped.has(c)),
      },
      remaining: 0,
      notes,
    },
  };
}

/** Rows one apply call writes at most (POST /api/admin/unit-identity); the
 *  rest is the report's `remaining`, for the next call. */
export const UNIT_IDENTITY_WRITE_BUDGET = 4000;

/** An apply works through a bounded batch per call; the panel calls again
 *  while writes remain and the last call made progress, at most this often. */
export const UNIT_IDENTITY_MAX_ROUNDS = 100;

/** Run the backfill on the server (service role — the decode is the one
 *  writer of documents.unit_code). `dryRun` reports without writing. An
 *  apply loops over the route's bounded batches (each call plans afresh, so
 *  a round writes only what is still missing) until nothing remains, a
 *  round lands nothing (the rest is refused), or UNIT_IDENTITY_MAX_ROUNDS.
 *  The result keeps the first round's plan (what the whole pass found),
 *  sums what was written and what changed under it (a changed row is planned
 *  afresh from the next read, never again as it was), and takes the last
 *  round's refusals and remainder (a refused row is planned again by the next
 *  round, so summing would count it twice). A round that fails after earlier
 *  rounds says how much landed. */
export async function runUnitIdentityBackfill(orgId: string, opts: { dryRun: boolean }): Promise<UnitIdentityReport> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Not signed in.");
  const once = async (): Promise<UnitIdentityReport> => {
    const res = await fetch("/api/admin/unit-identity", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ orgId, dryRun: opts.dryRun }),
    });
    const body = (await res.json().catch(() => ({}))) as { error?: string } & Partial<UnitIdentityReport>;
    if (!res.ok) {
      // No JSON error: the platform stopped the call (a timeout) — writes that
      // landed before it stopped are kept, so never say "did not run".
      throw new Error(body.error || (opts.dryRun
        ? `The preview did not finish (${res.status}).`
        : `The decode was interrupted (${res.status}) — writes that landed are kept; run "Decode and write" again to finish (it writes only what is still missing).`));
    }
    return body as UnitIdentityReport;
  };
  if (opts.dryRun) return once();

  const first = await once();
  let last = first;
  let docsWritten = first.documents.written, assetsWritten = first.assets.written;
  let docsChanged = first.documents.changed ?? 0, assetsChanged = first.assets.changed ?? 0;
  const notes = [...first.notes];
  const progressed = (r: UnitIdentityReport) => r.documents.written + r.assets.written > 0;
  let rounds = 1;
  while (last.remaining > 0 && progressed(last) && rounds < UNIT_IDENTITY_MAX_ROUNDS) {
    try {
      last = await once();
    } catch (e) {
      throw new Error(`${(e as Error).message} ${docsWritten + assetsWritten} write(s) landed in the earlier round(s).`);
    }
    rounds += 1;
    docsWritten += last.documents.written;
    assetsWritten += last.assets.written;
    docsChanged += last.documents.changed ?? 0;
    assetsChanged += last.assets.changed ?? 0;
    for (const n of last.notes) if (!notes.includes(n)) notes.push(n);
  }
  if (last.remaining > 0 && progressed(last)) {
    notes.push(`Stopped after ${rounds} rounds with ${last.remaining} write(s) still to do — run "Decode and write" again to continue.`);
  }
  return {
    ...first,
    documents: { ...first.documents, written: docsWritten, changed: docsChanged, refused: last.documents.refused },
    assets: { ...first.assets, written: assetsWritten, changed: assetsChanged, refused: last.assets.refused },
    remaining: last.remaining,
    notes,
  };
}

// ─── Join-table reads (document_assets, project_documents) ──────
//
// The join tables are populated automatically by triggers from
// existing write surfaces (see 20260609_phase1_normalization.sql).
// Callers should treat them as read-only views; manual writes are
// allowed via linkDocumentToAsset / linkDocumentToProject below for
// the rare case of a relationship that doesn't have an underlying
// JSONB tag or checkout.

export interface DocumentAssetLink {
  documentId: string;
  assetId: string;
  tagText: string | null;
  source: "jsonb_sync" | "manual";
}

export async function getDocumentsForAsset(assetId: string): Promise<DocumentAssetLink[]> {
  const { data, error } = await supabase
    .from("document_assets")
    .select("document_id, asset_id, tag_text, source")
    .eq("asset_id", assetId);
  if (error) throw new Error(error.message);
  return ((data as Array<{ document_id: string; asset_id: string; tag_text: string | null; source: "jsonb_sync" | "manual" }>) ?? [])
    .map((r) => ({ documentId: r.document_id, assetId: r.asset_id, tagText: r.tag_text, source: r.source }));
}

export interface AssetDocumentRow {
  documentId: string;
  documentNumber: string | null;
  title: string | null;
  libraryId: string;
  tagText: string | null;
}

/** Hydrated variant — returns enough document metadata to render a
 *  click-through list without N+1 round-trips. */
export async function getDocumentsForAssetHydrated(assetId: string): Promise<AssetDocumentRow[]> {
  const links = await getDocumentsForAsset(assetId);
  if (links.length === 0) return [];
  const ids = links.map((l) => l.documentId);
  const { data, error } = await supabase
    .from("documents")
    .select("id, document_number, title, library_id")
    .in("id", ids);
  if (error) throw new Error(error.message);
  const byId = new Map<string, { document_number: string | null; title: string | null; library_id: string }>();
  for (const r of (data as Array<{ id: string; document_number: string | null; title: string | null; library_id: string }>) ?? []) {
    byId.set(r.id, { document_number: r.document_number, title: r.title, library_id: r.library_id });
  }
  return links
    .map((l) => {
      const d = byId.get(l.documentId);
      if (!d) return null;
      return {
        documentId: l.documentId,
        documentNumber: d.document_number,
        title: d.title,
        libraryId: d.library_id,
        tagText: l.tagText,
      };
    })
    .filter((x): x is AssetDocumentRow => x !== null);
}

/** Every document that references ANY of the given assets, hydrated — the
 *  unit hub's "files on this unit's equipment" list in two round-trips
 *  (batched) instead of one per asset. */
export async function getDocumentsForAssetsHydrated(
  assetIds: string[],
): Promise<Array<AssetDocumentRow & { assetId: string }>> {
  if (assetIds.length === 0) return [];
  const links: Array<{ document_id: string; asset_id: string; tag_text: string | null }> = [];
  for (let i = 0; i < assetIds.length; i += 150) {
    const { data, error } = await supabase
      .from("document_assets")
      .select("document_id, asset_id, tag_text")
      .in("asset_id", assetIds.slice(i, i + 150));
    if (error) throw new Error(error.message);
    links.push(...((data as typeof links) ?? []));
  }
  if (links.length === 0) return [];
  const docIds = [...new Set(links.map((l) => l.document_id))];
  const byId = new Map<string, { document_number: string | null; title: string | null; library_id: string }>();
  for (let i = 0; i < docIds.length; i += 150) {
    const { data, error } = await supabase
      .from("documents")
      .select("id, document_number, title, library_id")
      .in("id", docIds.slice(i, i + 150));
    if (error) throw new Error(error.message);
    for (const r of (data as Array<{ id: string; document_number: string | null; title: string | null; library_id: string }>) ?? []) {
      byId.set(r.id, { document_number: r.document_number, title: r.title, library_id: r.library_id });
    }
  }
  return links
    .map((l) => {
      const d = byId.get(l.document_id);
      if (!d) return null;
      return {
        documentId: l.document_id,
        assetId: l.asset_id,
        documentNumber: d.document_number,
        title: d.title,
        libraryId: d.library_id,
        tagText: l.tag_text,
      };
    })
    .filter((x): x is AssetDocumentRow & { assetId: string } => x !== null);
}

export async function getAssetsForDocument(documentId: string): Promise<DocumentAssetLink[]> {
  const { data, error } = await supabase
    .from("document_assets")
    .select("document_id, asset_id, tag_text, source")
    .eq("document_id", documentId);
  if (error) throw new Error(error.message);
  return ((data as Array<{ document_id: string; asset_id: string; tag_text: string | null; source: "jsonb_sync" | "manual" }>) ?? [])
    .map((r) => ({ documentId: r.document_id, assetId: r.asset_id, tagText: r.tag_text, source: r.source }));
}

/** Manual link — for relationships that don't have a JSONB tag. The
 *  trigger-managed jsonb_sync rows will not delete this row when the
 *  underlying JSONB changes. */
export async function linkDocumentToAsset(orgId: string, documentId: string, assetId: string): Promise<void> {
  const { error } = await supabase.from("document_assets").upsert({
    org_id: orgId, document_id: documentId, asset_id: assetId, source: "manual",
  }, { onConflict: "document_id,asset_id" });
  if (error) throw new Error(error.message);
}

export async function unlinkDocumentFromAsset(documentId: string, assetId: string): Promise<void> {
  const { error } = await supabase
    .from("document_assets")
    .delete()
    .eq("document_id", documentId)
    .eq("asset_id", assetId);
  if (error) throw new Error(error.message);
}

export interface ProjectDocumentLink {
  projectId: string;
  documentId: string;
  firstSeenAt: string;
  lastSeenAt: string;
  source: "checkout" | "manual";
}

export async function getDocumentsForProject(projectId: string): Promise<ProjectDocumentLink[]> {
  const { data, error } = await supabase
    .from("project_documents")
    .select("project_id, document_id, first_seen_at, last_seen_at, source")
    .eq("project_id", projectId)
    .order("last_seen_at", { ascending: false });
  if (error) throw new Error(error.message);
  return ((data as Array<{ project_id: string; document_id: string; first_seen_at: string; last_seen_at: string; source: "checkout" | "manual" }>) ?? [])
    .map((r) => ({ projectId: r.project_id, documentId: r.document_id, firstSeenAt: r.first_seen_at, lastSeenAt: r.last_seen_at, source: r.source }));
}

export async function linkDocumentToProject(orgId: string, projectId: string, documentId: string): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await supabase.from("project_documents").upsert({
    org_id: orgId, project_id: projectId, document_id: documentId,
    first_seen_at: now, last_seen_at: now, source: "manual",
  }, { onConflict: "project_id,document_id" });
  if (error) throw new Error(error.message);
}

export async function unlinkDocumentFromProject(projectId: string, documentId: string): Promise<void> {
  const { error } = await supabase
    .from("project_documents")
    .delete()
    .eq("project_id", projectId)
    .eq("document_id", documentId);
  if (error) throw new Error(error.message);
}
