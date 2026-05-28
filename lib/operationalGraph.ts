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

import { supabase } from "@/lib/supabase";
import type { Plant, Unit, PlantSystem } from "@/types/schema";

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

export async function listUnits(orgId: string, opts?: { plantId?: string; includeArchived?: boolean }): Promise<Unit[]> {
  let q = supabase.from("units").select("*").eq("org_id", orgId).order("name", { ascending: true });
  if (opts?.plantId) q = q.eq("plant_id", opts.plantId);
  if (!opts?.includeArchived) q = q.eq("archived", false);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return ((data as UnitRow[]) ?? []).map(unitRow);
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
  units: Array<{ unit: Unit; systems: PlantSystem[] }>;
}

/** Single-call read of the full Plant→Unit→System tree for an org.
 *  Excludes archived rows by default. Three parallel queries — the
 *  call sites are admin/scope UIs where total row count is small
 *  (refineries typically have <10 plants, <50 units, <200 systems). */
export async function getScopeTree(orgId: string, opts?: { includeArchived?: boolean }): Promise<ScopeNode[]> {
  const [plants, units, systems] = await Promise.all([
    listPlants(orgId, opts),
    listUnits(orgId, opts),
    listSystems(orgId, opts),
  ]);

  const unitsByPlant = new Map<string, Unit[]>();
  for (const u of units) {
    const arr = unitsByPlant.get(u.plantId) ?? [];
    arr.push(u);
    unitsByPlant.set(u.plantId, arr);
  }
  const systemsByUnit = new Map<string, PlantSystem[]>();
  for (const s of systems) {
    const arr = systemsByUnit.get(s.unitId) ?? [];
    arr.push(s);
    systemsByUnit.set(s.unitId, arr);
  }

  return plants.map((plant) => ({
    plant,
    units: (unitsByPlant.get(plant.id!) ?? []).map((unit) => ({
      unit,
      systems: systemsByUnit.get(unit.id!) ?? [],
    })),
  }));
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
