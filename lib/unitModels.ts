// lib/unitModels.ts
//
// OPERATING AREAS / 3D MODELS — the data layer for laser-scan models on
// units. Same doc-control DNA as everything else: a model is an identity,
// every uploaded file is a VERSION on a supersede chain, the current
// pointer moves atomically, nothing is ever silently overwritten, and every
// mutation lands in audit_logs. Management is Admin/DocCtrl only — the UI
// gates it AND the 20260904 RLS policies enforce it at the database.

import { supabase } from "@/lib/supabase";

export interface UnitModel {
  id: string;
  orgId: string;
  unitId: string;
  name: string;
  description: string | null;
  modelKind: "point_cloud" | "mesh" | "bim";
  status: "active" | "archived";
  currentVersionId: string | null;
  createdByName: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UnitModelVersion {
  id: string;
  modelId: string;
  versionNo: number;
  copcKey: string | null;
  copcSize: number | null;
  pointCount: number | null;
  sourceKey: string | null;
  sourceName: string | null;
  sourceFormat: string | null;
  sourceSize: number | null;
  capturedAt: string | null;
  changeNote: string | null;
  createdByName: string | null;
  createdAt: string;
  supersededAt: string | null;
}

export interface AreaUnit {
  id: string;
  name: string;
  code: string | null;
  description: string | null;
  plantId: string;
  plantName: string;
  modelCount: number;
  latestCapturedAt: string | null;
}

function mapModel(r: Record<string, unknown>): UnitModel {
  return {
    id: String(r.id),
    orgId: String(r.org_id),
    unitId: String(r.unit_id),
    name: String(r.name),
    description: (r.description as string | null) ?? null,
    modelKind: (r.model_kind as UnitModel["modelKind"]) ?? "point_cloud",
    status: (r.status as UnitModel["status"]) ?? "active",
    currentVersionId: (r.current_version_id as string | null) ?? null,
    createdByName: (r.created_by_name as string | null) ?? null,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

function mapVersion(r: Record<string, unknown>): UnitModelVersion {
  return {
    id: String(r.id),
    modelId: String(r.model_id),
    versionNo: Number(r.version_no),
    copcKey: (r.copc_key as string | null) ?? null,
    copcSize: r.copc_size == null ? null : Number(r.copc_size),
    pointCount: r.point_count == null ? null : Number(r.point_count),
    sourceKey: (r.source_key as string | null) ?? null,
    sourceName: (r.source_name as string | null) ?? null,
    sourceFormat: (r.source_format as string | null) ?? null,
    sourceSize: r.source_size == null ? null : Number(r.source_size),
    capturedAt: (r.captured_at as string | null) ?? null,
    changeNote: (r.change_note as string | null) ?? null,
    createdByName: (r.created_by_name as string | null) ?? null,
    createdAt: String(r.created_at),
    supersededAt: (r.superseded_at as string | null) ?? null,
  };
}

async function audit(action: string, orgId: string, resourceId: string, actor: Actor, details: Record<string, unknown>) {
  await supabase.from("audit_logs").insert({
    action, resource_type: "unit_model", resource_id: resourceId,
    org_id: orgId, user_id: actor.uid, user_email: actor.email,
    details,
  }).then(() => undefined, () => undefined);
}

export interface Actor { uid: string; email: string | null; }

/** Units grouped for the Operating Areas list, with model counts and the
 *  freshest capture date (how current is our picture of this unit?). */
export async function listAreaUnits(orgId: string): Promise<AreaUnit[]> {
  const [{ data: units }, { data: plants }, { data: models }, { data: versions }] = await Promise.all([
    supabase.from("units").select("id, name, code, description, plant_id")
      .eq("org_id", orgId).eq("archived", false).order("name"),
    supabase.from("plants").select("id, name").eq("org_id", orgId),
    supabase.from("unit_models").select("id, unit_id, current_version_id")
      .eq("org_id", orgId).eq("status", "active"),
    supabase.from("unit_model_versions").select("id, model_id, captured_at")
      .eq("org_id", orgId).is("superseded_at", null),
  ]);
  const plantName = new Map((((plants ?? []) as Array<{ id: string; name: string }>)).map((p) => [p.id, p.name]));
  const modelRows = ((models ?? []) as Array<Record<string, unknown>>);
  const capturedByVersion = new Map((((versions ?? []) as Array<Record<string, unknown>>)).map((v) => [String(v.id), (v.captured_at as string | null) ?? null]));
  const byUnit = new Map<string, { count: number; latest: string | null }>();
  for (const m of modelRows) {
    const u = String(m.unit_id);
    const prev = byUnit.get(u) ?? { count: 0, latest: null };
    prev.count += 1;
    const cap = m.current_version_id ? (capturedByVersion.get(String(m.current_version_id)) ?? null) : null;
    if (cap && (!prev.latest || cap > prev.latest)) prev.latest = cap;
    byUnit.set(u, prev);
  }
  return (((units ?? []) as Array<Record<string, unknown>>)).map((u) => ({
    id: String(u.id),
    name: String(u.name),
    code: (u.code as string | null) ?? null,
    description: (u.description as string | null) ?? null,
    plantId: String(u.plant_id),
    plantName: plantName.get(String(u.plant_id)) ?? "Plant",
    modelCount: byUnit.get(String(u.id))?.count ?? 0,
    latestCapturedAt: byUnit.get(String(u.id))?.latest ?? null,
  }));
}

export async function listModels(orgId: string, unitId: string, includeArchived = false): Promise<UnitModel[]> {
  let q = supabase.from("unit_models").select("*").eq("org_id", orgId).eq("unit_id", unitId)
    .order("created_at", { ascending: true });
  if (!includeArchived) q = q.eq("status", "active");
  const { data } = await q;
  return (((data ?? []) as Array<Record<string, unknown>>)).map(mapModel);
}

export async function listVersions(modelId: string): Promise<UnitModelVersion[]> {
  const { data } = await supabase.from("unit_model_versions").select("*")
    .eq("model_id", modelId).order("version_no", { ascending: false });
  return (((data ?? []) as Array<Record<string, unknown>>)).map(mapVersion);
}

export interface NewVersionFiles {
  copcKey: string | null;
  copcSize: number | null;
  pointCount: number | null;
  sourceKey: string | null;
  sourceName: string | null;
  sourceFormat: string | null;
  sourceSize: number | null;
  capturedAt: string | null; // YYYY-MM-DD
  changeNote: string | null;
}

/** Create a model with its first version in one motion. */
export async function createModel(input: {
  orgId: string; unitId: string; name: string; description: string | null;
  files: NewVersionFiles; actor: Actor;
}): Promise<{ ok: boolean; modelId?: string; error?: string }> {
  const nowIso = new Date().toISOString();
  const { data: model, error } = await supabase.from("unit_models").insert({
    org_id: input.orgId, unit_id: input.unitId,
    name: input.name.trim(), description: input.description?.trim() || null,
    created_by: input.actor.uid, created_by_name: input.actor.email?.split("@")[0] ?? null,
    updated_at: nowIso,
  }).select("id").single();
  if (error || !model) return { ok: false, error: error?.message ?? "Couldn't create the model." };
  const modelId = String(model.id);

  const res = await addVersion({ orgId: input.orgId, modelId, files: input.files, actor: input.actor, _skipAudit: true });
  if (!res.ok) {
    // Don't leave a fileless shell behind.
    await supabase.from("unit_models").delete().eq("id", modelId);
    return { ok: false, error: res.error };
  }
  await audit("UNIT_MODEL_CREATED", input.orgId, modelId, input.actor, {
    unitId: input.unitId, name: input.name.trim(),
    sourceName: input.files.sourceName, capturedAt: input.files.capturedAt,
  });
  return { ok: true, modelId };
}

/** Add a new version: next number, supersedes the previous current. */
export async function addVersion(input: {
  orgId: string; modelId: string; files: NewVersionFiles; actor: Actor;
  _skipAudit?: boolean;
}): Promise<{ ok: boolean; versionId?: string; error?: string }> {
  const nowIso = new Date().toISOString();
  const { data: model } = await supabase.from("unit_models")
    .select("id, current_version_id, name").eq("id", input.modelId).maybeSingle();
  if (!model) return { ok: false, error: "Model not found." };

  const { data: prev } = await supabase.from("unit_model_versions")
    .select("version_no").eq("model_id", input.modelId)
    .order("version_no", { ascending: false }).limit(1);
  const versionNo = ((prev?.[0]?.version_no as number | undefined) ?? 0) + 1;

  const { data: ver, error } = await supabase.from("unit_model_versions").insert({
    org_id: input.orgId, model_id: input.modelId, version_no: versionNo,
    copc_key: input.files.copcKey, copc_size: input.files.copcSize,
    point_count: input.files.pointCount,
    source_key: input.files.sourceKey, source_name: input.files.sourceName,
    source_format: input.files.sourceFormat, source_size: input.files.sourceSize,
    captured_at: input.files.capturedAt, change_note: input.files.changeNote,
    created_by: input.actor.uid, created_by_name: input.actor.email?.split("@")[0] ?? null,
  }).select("id").single();
  if (error || !ver) return { ok: false, error: error?.message ?? "Couldn't record the version." };
  const versionId = String(ver.id);

  const prevCurrent = (model.current_version_id as string | null) ?? null;
  await supabase.from("unit_models")
    .update({ current_version_id: versionId, updated_at: nowIso })
    .eq("id", input.modelId);
  if (prevCurrent) {
    await supabase.from("unit_model_versions")
      .update({ superseded_at: nowIso, superseded_by: input.actor.uid })
      .eq("id", prevCurrent);
  }
  if (!input._skipAudit) {
    await audit("UNIT_MODEL_VERSION_ADDED", input.orgId, input.modelId, input.actor, {
      modelName: model.name, versionNo, versionId,
      supersededVersionId: prevCurrent,
      sourceName: input.files.sourceName, capturedAt: input.files.capturedAt,
      changeNote: input.files.changeNote,
    });
  }
  return { ok: true, versionId };
}

/** Point the model back at an earlier version (rollback). The chain stays
 *  intact — nothing is deleted, the move itself is audited. */
export async function restoreVersion(input: {
  orgId: string; modelId: string; versionId: string; actor: Actor;
}): Promise<{ ok: boolean; error?: string }> {
  const nowIso = new Date().toISOString();
  const { data: model } = await supabase.from("unit_models")
    .select("id, name, current_version_id").eq("id", input.modelId).maybeSingle();
  if (!model) return { ok: false, error: "Model not found." };
  const { data: target } = await supabase.from("unit_model_versions")
    .select("id, version_no").eq("id", input.versionId).eq("model_id", input.modelId).maybeSingle();
  if (!target) return { ok: false, error: "Version not found on this model." };

  const prevCurrent = (model.current_version_id as string | null) ?? null;
  const { error } = await supabase.from("unit_models")
    .update({ current_version_id: input.versionId, updated_at: nowIso })
    .eq("id", input.modelId);
  if (error) return { ok: false, error: error.message };
  await supabase.from("unit_model_versions")
    .update({ superseded_at: null, superseded_by: null }).eq("id", input.versionId);
  if (prevCurrent && prevCurrent !== input.versionId) {
    await supabase.from("unit_model_versions")
      .update({ superseded_at: nowIso, superseded_by: input.actor.uid })
      .eq("id", prevCurrent);
  }
  await audit("UNIT_MODEL_VERSION_RESTORED", input.orgId, input.modelId, input.actor, {
    modelName: model.name, restoredVersionId: input.versionId,
    restoredVersionNo: target.version_no, supersededVersionId: prevCurrent,
  });
  return { ok: true };
}

export async function updateModelMeta(input: {
  orgId: string; modelId: string; name: string; description: string | null; actor: Actor;
}): Promise<{ ok: boolean; error?: string }> {
  const { data: before } = await supabase.from("unit_models")
    .select("name, description").eq("id", input.modelId).maybeSingle();
  const { error } = await supabase.from("unit_models")
    .update({ name: input.name.trim(), description: input.description?.trim() || null, updated_at: new Date().toISOString() })
    .eq("id", input.modelId);
  if (error) return { ok: false, error: error.message };
  await audit("UNIT_MODEL_UPDATED", input.orgId, input.modelId, input.actor, {
    before: { name: before?.name, description: before?.description },
    after: { name: input.name.trim(), description: input.description?.trim() || null },
  });
  return { ok: true };
}

export async function archiveModel(input: {
  orgId: string; modelId: string; actor: Actor;
}): Promise<{ ok: boolean; error?: string }> {
  const { data: before } = await supabase.from("unit_models")
    .select("name").eq("id", input.modelId).maybeSingle();
  const { error } = await supabase.from("unit_models")
    .update({ status: "archived", updated_at: new Date().toISOString() })
    .eq("id", input.modelId);
  if (error) return { ok: false, error: error.message };
  await audit("UNIT_MODEL_ARCHIVED", input.orgId, input.modelId, input.actor, {
    modelName: before?.name ?? null,
  });
  return { ok: true };
}

/** Plants for the add-unit form. */
export async function listPlants(orgId: string): Promise<Array<{ id: string; name: string }>> {
  const { data } = await supabase.from("plants").select("id, name")
    .eq("org_id", orgId).eq("archived", false).order("name");
  return ((data ?? []) as Array<{ id: string; name: string }>);
}

/** Create a unit directly from Operating Areas — same shared registry the
 *  Equipment section uses (one source of truth), just reachable from the
 *  place people actually think in units. Creates the plant on the fly when
 *  the org doesn't have one yet (or the user names a new one). */
export async function createAreaUnit(input: {
  orgId: string;
  plantId: string | null;
  newPlantName: string | null;
  name: string;
  code: string | null;
  description: string | null;
  actor: Actor;
}): Promise<{ ok: boolean; unitId?: string; error?: string }> {
  let plantId = input.plantId;
  if (!plantId) {
    const plantName = input.newPlantName?.trim();
    if (!plantName) return { ok: false, error: "Pick a plant or name a new one." };
    const { data: plant, error: pErr } = await supabase.from("plants").insert({
      org_id: input.orgId, name: plantName, created_by: input.actor.uid,
    }).select("id").single();
    if (pErr || !plant) return { ok: false, error: pErr?.message ?? "Couldn't create the plant." };
    plantId = String(plant.id);
  }
  const { data: unit, error } = await supabase.from("units").insert({
    org_id: input.orgId, plant_id: plantId,
    name: input.name.trim(), code: input.code?.trim() || null,
    description: input.description?.trim() || null,
    created_by: input.actor.uid,
  }).select("id").single();
  if (error || !unit) return { ok: false, error: error?.message ?? "Couldn't create the unit." };
  const unitId = String(unit.id);
  await audit("UNIT_CREATED", input.orgId, unitId, input.actor, {
    name: input.name.trim(), code: input.code?.trim() || null,
    plantId, newPlant: input.plantId ? null : input.newPlantName?.trim(),
    via: "operating_areas",
  });
  return { ok: true, unitId };
}

/** R2 keys for model files. */
export function makeModelStorageKey(orgId: string, unitId: string, kind: "copc" | "source", filename: string) {
  const safe = filename.replace(/[^\w.\-]+/g, "_").slice(0, 120) || "model";
  return `orgs/${orgId}/unit-models/${unitId}/${kind}/${crypto.randomUUID()}-${safe}`;
}

/** What kind of scan file is this? Drives the "renderable vs custody" split
 *  in the uploader. Renderable: COPC (octree streaming), plain LAS (ranged
 *  random sampling — seekable fixed-size records), PTS (ranged text
 *  sampling). NOT renderable: RCS/RCP (Autodesk closed), E57 (complex
 *  packed binary), plain LAZ (needs the converter — chunk decode without
 *  the COPC octree isn't worth the fragility). */
export function classifyScanFile(name: string): { format: string; renderable: boolean } {
  const lower = name.toLowerCase();
  if (lower.endsWith(".copc.laz")) return { format: "copc", renderable: true };
  if (lower.endsWith(".las")) return { format: "las", renderable: true };
  if (lower.endsWith(".pts")) return { format: "pts", renderable: true };
  if (lower.endsWith(".laz")) return { format: "laz", renderable: false };
  if (lower.endsWith(".rcs")) return { format: "rcs", renderable: false };
  if (lower.endsWith(".rcp")) return { format: "rcp", renderable: false };
  if (lower.endsWith(".e57")) return { format: "e57", renderable: false };
  const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : "bin";
  return { format: ext, renderable: false };
}

/** Which loader the 3D viewer should use for a stored render key. */
export function renderKindForKey(key: string | null): "copc" | "las" | "pts" | null {
  if (!key) return null;
  const lower = key.toLowerCase();
  if (lower.endsWith(".copc.laz")) return "copc";
  if (lower.endsWith(".las")) return "las";
  if (lower.endsWith(".pts")) return "pts";
  return null;
}
