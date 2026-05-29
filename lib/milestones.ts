// lib/milestones.ts
//
// Phase 7 — Lightweight Scheduling Layer.
//
// Milestones are dated checkpoints with a planned date, an actual
// date, and a weight. They can be scoped to a project, a document,
// or both. The directive is explicit about what this is NOT: not a
// CPM engine, no dependency edges, no Primavera replacement. The
// API surface here reflects that — CRUD, complete/miss/block
// transitions, basic earned-value rollup, and a CSV-paste import
// path for ghost rows.
//
// Auto-completion from linked events (release of linked_revision,
// closure of linked_ticket) is NOT implemented in this lib. The
// directive emphasizes "controlled implementation" — users mark
// milestones complete deliberately. Future automation can wire in
// as a separate enhancement.

import { supabase } from "@/lib/supabase";
import { logMilestoneEvent } from "@/lib/audit";
import type {
  Milestone, MilestoneStatus, MilestoneSource,
} from "@/types/schema";

interface MilestoneRow {
  id: string;
  org_id: string;
  project_id: string | null;
  document_id: string | null;
  parent_id: string | null;
  name: string;
  description: string | null;
  weight: number;
  planned_at: string;
  planned_start_at: string | null;
  actual_at: string | null;
  actual_start_at: string | null;
  status: MilestoneStatus;
  is_summary: boolean;
  outline_level: number | null;
  wbs: string | null;
  shift: "day" | "night" | "swing" | null;
  linked_revision_label: string | null;
  linked_ticket_id: string | null;
  source: MilestoneSource;
  external_ref: string | null;
  created_at: string;
  created_by: string;
  created_by_name: string | null;
  updated_at: string | null;
  updated_by: string | null;
  completed_by: string | null;
  completed_by_name: string | null;
  status_reason: string | null;
}

function rowToMilestone(r: MilestoneRow): Milestone {
  return {
    id: r.id,
    orgId: r.org_id,
    projectId: r.project_id,
    documentId: r.document_id,
    parentId: r.parent_id,
    name: r.name,
    description: r.description,
    weight: Number(r.weight),
    plannedAt: r.planned_at,
    plannedStartAt: r.planned_start_at,
    actualAt: r.actual_at,
    actualStartAt: r.actual_start_at,
    status: r.status,
    isSummary: r.is_summary ?? false,
    outlineLevel: r.outline_level,
    wbs: r.wbs,
    shift: r.shift,
    linkedRevisionLabel: r.linked_revision_label,
    linkedTicketId: r.linked_ticket_id,
    source: r.source,
    externalRef: r.external_ref,
    createdAt: r.created_at,
    createdBy: r.created_by,
    createdByName: r.created_by_name,
    updatedAt: r.updated_at ?? undefined,
    updatedBy: r.updated_by ?? undefined,
    completedBy: r.completed_by,
    completedByName: r.completed_by_name,
    statusReason: r.status_reason,
  };
}

function pickResource(m: { projectId?: string | null; documentId?: string | null; id?: string }) {
  if (m.documentId) return { resourceType: "document" as const, resourceId: m.documentId };
  if (m.projectId)  return { resourceType: "project"  as const, resourceId: m.projectId };
  return { resourceType: "milestone" as const, resourceId: m.id ?? "" };
}

// ─── Mutations ──────────────────────────────────────────────────

export interface CreateMilestoneInput {
  orgId: string;
  projectId?: string | null;
  documentId?: string | null;
  name: string;
  description?: string;
  weight?: number;
  plannedAt: string;             // ISO
  linkedRevisionLabel?: string;
  linkedTicketId?: string;
  source?: MilestoneSource;
  externalRef?: string;
  createdBy: string;
  createdByName?: string;
  createdByEmail?: string;
  createdByRole?: string;
}

export async function createMilestone(input: CreateMilestoneInput): Promise<Milestone> {
  if (!input.name.trim()) throw new Error("Milestone name is required.");
  if (!input.projectId && !input.documentId) {
    throw new Error("Milestone must belong to a project or document.");
  }
  const { data, error } = await supabase
    .from("milestones")
    .insert({
      org_id: input.orgId,
      project_id: input.projectId ?? null,
      document_id: input.documentId ?? null,
      name: input.name.trim(),
      description: input.description?.trim() || null,
      weight: input.weight ?? 1,
      planned_at: input.plannedAt,
      linked_revision_label: input.linkedRevisionLabel?.trim() || null,
      linked_ticket_id: input.linkedTicketId ?? null,
      source: input.source ?? "manual",
      external_ref: input.externalRef ?? null,
      created_by: input.createdBy,
      created_by_name: input.createdByName ?? null,
    })
    .select("*")
    .single();

  if (error || !data) throw new Error(error?.message ?? "Failed to create milestone");
  const row = data as MilestoneRow;
  const m = rowToMilestone(row);

  const res = pickResource(m);
  await logMilestoneEvent({
    orgId: input.orgId,
    milestoneId: row.id,
    resourceType: res.resourceType,
    resourceId: res.resourceId,
    userId: input.createdBy,
    userEmail: input.createdByEmail,
    userRole: input.createdByRole,
    type: "MILESTONE_CREATED",
    name: row.name,
    details: { plannedAt: row.planned_at, weight: row.weight, source: row.source },
  });

  return m;
}

export interface UpdateMilestoneInput {
  id: string;
  patch: Partial<Pick<Milestone, "name" | "description" | "weight" | "plannedAt" | "linkedRevisionLabel" | "linkedTicketId">>;
  updatedBy: string;
  updatedByName?: string;
  updatedByEmail?: string;
  updatedByRole?: string;
}

export async function updateMilestone(input: UpdateMilestoneInput): Promise<Milestone> {
  const update: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
    updated_by: input.updatedBy,
  };
  if ("name" in input.patch && input.patch.name !== undefined)                      update.name = input.patch.name.trim();
  if ("description" in input.patch)                                                  update.description = input.patch.description?.trim() ?? null;
  if ("weight" in input.patch && input.patch.weight !== undefined)                  update.weight = input.patch.weight;
  if ("plannedAt" in input.patch && input.patch.plannedAt !== undefined)            update.planned_at = input.patch.plannedAt;
  if ("linkedRevisionLabel" in input.patch)                                          update.linked_revision_label = input.patch.linkedRevisionLabel?.toString().trim() || null;
  if ("linkedTicketId" in input.patch)                                               update.linked_ticket_id = input.patch.linkedTicketId ?? null;

  const { data, error } = await supabase.from("milestones").update(update).eq("id", input.id).select("*").single();
  if (error || !data) throw new Error(error?.message ?? "Failed to update milestone");
  const m = rowToMilestone(data as MilestoneRow);

  const res = pickResource(m);
  await logMilestoneEvent({
    orgId: m.orgId,
    milestoneId: m.id!,
    resourceType: res.resourceType,
    resourceId: res.resourceId,
    userId: input.updatedBy,
    userEmail: input.updatedByEmail,
    userRole: input.updatedByRole,
    type: "MILESTONE_UPDATED",
    name: m.name,
    details: { patch: input.patch },
  });

  return m;
}

export interface SetMilestoneStatusInput {
  id: string;
  status: MilestoneStatus;
  statusReason?: string;
  actorUserId: string;
  actorUserName?: string;
  actorUserEmail?: string;
  actorUserRole?: string;
}

/** Transition status. Setting 'completed' stamps actual_at and the
 *  completer; setting back from completed clears actual_at. */
export async function setMilestoneStatus(input: SetMilestoneStatusInput): Promise<Milestone> {
  const now = new Date().toISOString();
  const update: Record<string, unknown> = {
    status: input.status,
    status_reason: input.statusReason?.trim() || null,
    updated_at: now,
    updated_by: input.actorUserId,
  };
  if (input.status === "completed") {
    update.actual_at = now;
    update.completed_by = input.actorUserId;
    update.completed_by_name = input.actorUserName ?? null;
  } else {
    update.actual_at = null;
    update.completed_by = null;
    update.completed_by_name = null;
  }

  const { data, error } = await supabase.from("milestones").update(update).eq("id", input.id).select("*").single();
  if (error || !data) throw new Error(error?.message ?? "Failed to update milestone status");
  const m = rowToMilestone(data as MilestoneRow);

  const res = pickResource(m);
  const auditType =
    input.status === "completed" ? "MILESTONE_COMPLETED" :
    input.status === "missed"    ? "MILESTONE_MISSED"    :
    input.status === "blocked"   ? "MILESTONE_BLOCKED"   :
    "MILESTONE_UPDATED";

  await logMilestoneEvent({
    orgId: m.orgId,
    milestoneId: m.id!,
    resourceType: res.resourceType,
    resourceId: res.resourceId,
    userId: input.actorUserId,
    userEmail: input.actorUserEmail,
    userRole: input.actorUserRole,
    type: auditType,
    name: m.name,
    details: { newStatus: input.status, statusReason: input.statusReason, plannedAt: m.plannedAt, actualAt: m.actualAt },
  });

  return m;
}

export async function deleteMilestone(id: string, actorUserId: string): Promise<void> {
  const { data: row, error: readErr } = await supabase.from("milestones").select("*").eq("id", id).maybeSingle();
  if (readErr) throw new Error(readErr.message);
  if (!row) return;
  const m = rowToMilestone(row as MilestoneRow);

  const { error: delErr } = await supabase.from("milestones").delete().eq("id", id);
  if (delErr) throw new Error(delErr.message);

  const res = pickResource(m);
  await logMilestoneEvent({
    orgId: m.orgId,
    milestoneId: m.id!,
    resourceType: res.resourceType,
    resourceId: res.resourceId,
    userId: actorUserId,
    type: "MILESTONE_DELETED",
    name: m.name,
  });
}

// ─── Reads ──────────────────────────────────────────────────────

export interface ListMilestonesParams {
  orgId: string;
  projectId?: string;
  documentId?: string;
  /** Include imported (P6/MSProject/CSV) rows. Defaults true. */
  includeGhost?: boolean;
}

export async function listMilestones(params: ListMilestonesParams): Promise<Milestone[]> {
  const { orgId, projectId, documentId, includeGhost = true } = params;
  let q = supabase.from("milestones").select("*").eq("org_id", orgId).order("planned_at", { ascending: true });
  if (projectId) q = q.eq("project_id", projectId);
  if (documentId) q = q.eq("document_id", documentId);
  if (!includeGhost) q = q.eq("source", "manual");
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return ((data as MilestoneRow[]) ?? []).map(rowToMilestone);
}

// ─── Earned-value rollup ────────────────────────────────────────
//
// Time-based EVM. We don't have cost, so SPI is the only index.
//
//   planned_value  = sum of weights of milestones whose planned_at <= now
//   earned_value   = sum of weights of milestones with status='completed'
//                    AND actual_at <= now (or planned_at as a fallback)
//   total_weight   = sum of all milestone weights
//   SPI            = earned_value / planned_value          (1.0 = on schedule)
//   percent_planned = planned_value / total_weight
//   percent_earned  = earned_value  / total_weight
//
// Forecast finish: if SPI > 0 and there's a known planned end date,
// estimated finish = original end + (remaining_work / SPI - remaining_work)
// expressed in days. We compute the latest planned_at as the
// "planned end."
//
// All quantities exclude ghost rows by default — they're reference
// data, not commitments — but the caller can include them.

export interface ScheduleMetrics {
  totalWeight: number;
  plannedValue: number;
  earnedValue: number;
  /** earned / planned. 1.0 = on schedule. < 1 = behind. */
  spi: number;
  percentEarned: number;       // 0..1
  percentPlanned: number;      // 0..1
  /** Latest planned_at across all included milestones (ISO), or null. */
  plannedEndAt: string | null;
  /** Forecast finish date if SPI < 1 and a planned end exists. ISO or null. */
  forecastEndAt: string | null;
  /** Count of milestones in each status. */
  byStatus: Record<MilestoneStatus, number>;
}

export function computeScheduleMetrics(milestones: Milestone[], opts?: { now?: Date }): ScheduleMetrics {
  const now = opts?.now ?? new Date();
  let totalWeight = 0;
  let plannedValue = 0;
  let earnedValue = 0;
  let plannedEndMs = -Infinity;
  const byStatus: Record<MilestoneStatus, number> = {
    planned: 0, in_progress: 0, completed: 0, missed: 0, blocked: 0,
  };

  for (const m of milestones) {
    const w = m.weight;
    totalWeight += w;
    byStatus[m.status]++;
    const plannedMs = new Date(m.plannedAt as string).getTime();
    if (plannedMs > plannedEndMs) plannedEndMs = plannedMs;
    if (plannedMs <= now.getTime()) plannedValue += w;
    if (m.status === "completed") {
      const actualMs = m.actualAt ? new Date(m.actualAt as string).getTime() : plannedMs;
      if (actualMs <= now.getTime()) earnedValue += w;
    }
  }

  const spi = plannedValue > 0 ? earnedValue / plannedValue : 1;
  const percentEarned  = totalWeight > 0 ? earnedValue  / totalWeight : 0;
  const percentPlanned = totalWeight > 0 ? plannedValue / totalWeight : 0;
  const plannedEndAt = plannedEndMs > -Infinity ? new Date(plannedEndMs).toISOString() : null;

  // Forecast: if behind (SPI < 1), the remaining work will take
  // longer in proportion. Naive but useful first-order signal.
  let forecastEndAt: string | null = null;
  if (plannedEndAt && spi > 0 && spi < 1) {
    const plannedDurationMs = plannedEndMs - now.getTime();
    if (plannedDurationMs > 0) {
      const stretchMs = plannedDurationMs * (1 / spi - 1);
      forecastEndAt = new Date(plannedEndMs + stretchMs).toISOString();
    } else {
      // Project already past planned end; forecast = now + remaining-work guess.
      const remaining = totalWeight - earnedValue;
      const earnedRatePerMs = earnedValue / Math.max(1, now.getTime() - new Date(milestones[0]?.createdAt as string ?? now.toISOString()).getTime());
      if (earnedRatePerMs > 0) {
        forecastEndAt = new Date(now.getTime() + remaining / earnedRatePerMs).toISOString();
      }
    }
  }

  return { totalWeight, plannedValue, earnedValue, spi, percentEarned, percentPlanned, plannedEndAt, forecastEndAt, byStatus };
}

// ─── Ghost overlay import ────────────────────────────────────────
//
// One-way import only — the directive forbids bidirectional P6 sync
// in this phase. Accepts CSV with a header row. Recognized columns:
//
//   name              required
//   planned_at        required, ISO 8601 or YYYY-MM-DD
//   weight            optional, default 1
//   description       optional
//   external_ref      optional, used to de-dupe re-imports
//
// Source is set to whatever the caller passed (p6 / msproject / csv).
// Rows with the same external_ref overwrite on re-import; rows
// without external_ref always insert as new.

export interface ImportGhostMilestonesInput {
  orgId: string;
  projectId?: string | null;
  documentId?: string | null;
  source: Exclude<MilestoneSource, "manual">;
  csv: string;
  createdBy: string;
  createdByName?: string;
}

export interface ImportResult {
  inserted: number;
  updated: number;
  skipped: number;
  errors: string[];
}

export async function importGhostMilestones(input: ImportGhostMilestonesInput): Promise<ImportResult> {
  const result: ImportResult = { inserted: 0, updated: 0, skipped: 0, errors: [] };
  const lines = input.csv.trim().split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) {
    result.errors.push("CSV needs a header row and at least one data row.");
    return result;
  }

  const header = parseCsvLine(lines[0]).map((h) => h.toLowerCase().trim());
  const idx = {
    name:         header.indexOf("name"),
    planned_at:   header.indexOf("planned_at"),
    weight:       header.indexOf("weight"),
    description:  header.indexOf("description"),
    external_ref: header.indexOf("external_ref"),
  };
  if (idx.name < 0 || idx.planned_at < 0) {
    result.errors.push('CSV must include "name" and "planned_at" columns.');
    return result;
  }

  for (let i = 1; i < lines.length; i++) {
    const fields = parseCsvLine(lines[i]);
    const name = fields[idx.name]?.trim();
    const plannedRaw = fields[idx.planned_at]?.trim();
    if (!name || !plannedRaw) { result.skipped++; continue; }

    // Coerce common date formats to ISO.
    let plannedIso = plannedRaw;
    if (/^\d{4}-\d{2}-\d{2}$/.test(plannedRaw)) plannedIso = `${plannedRaw}T00:00:00Z`;

    const weight = idx.weight >= 0 ? Number(fields[idx.weight]?.trim() || "1") : 1;
    const description = idx.description >= 0 ? fields[idx.description]?.trim() || null : null;
    const externalRef = idx.external_ref >= 0 ? fields[idx.external_ref]?.trim() || null : null;

    try {
      // Upsert on (org, source, external_ref) if external_ref provided.
      if (externalRef) {
        const { data: existing } = await supabase
          .from("milestones")
          .select("id")
          .eq("org_id", input.orgId)
          .eq("source", input.source)
          .eq("external_ref", externalRef)
          .maybeSingle();
        if (existing) {
          const { error } = await supabase.from("milestones").update({
            name, description, weight: isNaN(weight) ? 1 : weight,
            planned_at: plannedIso, updated_at: new Date().toISOString(),
            updated_by: input.createdBy,
          }).eq("id", (existing as { id: string }).id);
          if (error) { result.errors.push(`Row ${i+1}: ${error.message}`); }
          else result.updated++;
          continue;
        }
      }
      const { error } = await supabase.from("milestones").insert({
        org_id: input.orgId,
        project_id: input.projectId ?? null,
        document_id: input.documentId ?? null,
        name, description, weight: isNaN(weight) ? 1 : weight,
        planned_at: plannedIso,
        source: input.source,
        external_ref: externalRef,
        created_by: input.createdBy,
        created_by_name: input.createdByName ?? null,
      });
      if (error) result.errors.push(`Row ${i+1}: ${error.message}`);
      else result.inserted++;
    } catch (e) {
      result.errors.push(`Row ${i+1}: ${(e as Error).message}`);
    }
  }
  return result;
}

/** Minimal CSV-line parser. Handles quoted fields and embedded commas;
 *  doesn't handle multi-line quoted fields (rare for schedule exports). */
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuote) {
      if (c === '"') {
        if (line[i+1] === '"') { cur += '"'; i++; }
        else { inQuote = false; }
      } else cur += c;
    } else {
      if (c === '"') inQuote = true;
      else if (c === ",") { out.push(cur); cur = ""; }
      else cur += c;
    }
  }
  out.push(cur);
  return out;
}

// ─── Parsed-row import ──────────────────────────────────────────
//
// New path used by the file-upload importer. Skips the CSV layer
// and writes already-normalized ParsedMilestone rows. Same upsert
// semantics as importGhostMilestones — rows with an externalRef
// update on re-import, others always insert.

export interface ParsedMilestoneRow {
  name: string;
  plannedAt: string;
  plannedStartAt?: string | null;
  weight?: number;
  description?: string | null;
  externalRef?: string | null;
  parentExternalRef?: string | null;
  outlineLevel?: number | null;
  wbs?: string | null;
  isSummary?: boolean;
}

export interface ImportParsedInput {
  orgId: string;
  projectId?: string | null;
  documentId?: string | null;
  source: Exclude<MilestoneSource, "manual">;
  rows: ParsedMilestoneRow[];
  createdBy: string;
  createdByName?: string;
}

function coerceIsoMaybe(s: string | null | undefined): string | null {
  if (!s) return null;
  const trimmed = s.trim();
  if (!trimmed) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? `${trimmed}T00:00:00Z` : trimmed;
}

/** Heuristic shift assignment based on a planned start hour.
 *  6am-6pm → day, 6pm-6am → night. Null until plannedStartAt is known. */
function shiftFromStart(plannedStartIso: string | null): "day" | "night" | null {
  if (!plannedStartIso) return null;
  const d = new Date(plannedStartIso);
  if (isNaN(d.getTime())) return null;
  const h = d.getUTCHours();
  return (h >= 6 && h < 18) ? "day" : "night";
}

export async function importMilestonesFromParsed(input: ImportParsedInput): Promise<ImportResult> {
  const result: ImportResult = { inserted: 0, updated: 0, skipped: 0, errors: [] };

  // Pass 1: write every row WITHOUT parent_id. We can't resolve
  // parent UUIDs yet because the parent rows are also in this same
  // batch and may not have ids until they're inserted. Track each
  // row's externalRef → DB id in a map for pass 2.
  const refToId = new Map<string, string>();

  for (let i = 0; i < input.rows.length; i++) {
    const r = input.rows[i];
    const name = r.name?.trim();
    if (!name) { result.skipped++; continue; }
    const planned = r.plannedAt?.trim();
    if (!planned) { result.skipped++; continue; }
    const plannedIso = coerceIsoMaybe(planned)!;
    const plannedStartIso = coerceIsoMaybe(r.plannedStartAt ?? null);
    const weight = Number(r.weight ?? 1);

    const baseFields = {
      name,
      description: r.description ?? null,
      weight: isNaN(weight) ? 1 : weight,
      planned_at: plannedIso,
      planned_start_at: plannedStartIso,
      outline_level: r.outlineLevel ?? null,
      wbs: r.wbs ?? null,
      is_summary: !!r.isSummary,
      shift: shiftFromStart(plannedStartIso),
    } as Record<string, unknown>;

    try {
      if (r.externalRef) {
        const { data: existing } = await supabase
          .from("milestones")
          .select("id")
          .eq("org_id", input.orgId)
          .eq("source", input.source)
          .eq("external_ref", r.externalRef)
          .maybeSingle();
        if (existing) {
          const id = (existing as { id: string }).id;
          refToId.set(r.externalRef, id);
          const { error } = await supabase.from("milestones").update({
            ...baseFields,
            updated_at: new Date().toISOString(),
            updated_by: input.createdBy,
          }).eq("id", id);
          if (error) result.errors.push(`Row ${i + 1}: ${error.message}`);
          else result.updated++;
          continue;
        }
      }
      const { data: inserted, error } = await supabase.from("milestones").insert({
        org_id: input.orgId,
        project_id: input.projectId ?? null,
        document_id: input.documentId ?? null,
        ...baseFields,
        source: input.source,
        external_ref: r.externalRef ?? null,
        created_by: input.createdBy,
        created_by_name: input.createdByName ?? null,
      }).select("id").maybeSingle();
      if (error) {
        result.errors.push(`Row ${i + 1}: ${error.message}`);
        continue;
      }
      if (inserted && r.externalRef) {
        refToId.set(r.externalRef, (inserted as { id: string }).id);
      }
      result.inserted++;
    } catch (e) {
      result.errors.push(`Row ${i + 1}: ${(e as Error).message}`);
    }
  }

  // Pass 2: resolve parent_id wherever both parent and child landed.
  // Done as a separate loop because the parent might appear AFTER the
  // child in the input order (rare but happens with some MS Project
  // exports). Skipped rows have nothing to resolve.
  const updates: Array<{ id: string; parent_id: string }> = [];
  for (const r of input.rows) {
    if (!r.externalRef || !r.parentExternalRef) continue;
    const childId = refToId.get(r.externalRef);
    const parentId = refToId.get(r.parentExternalRef);
    if (!childId || !parentId) continue;
    if (childId === parentId) continue; // safety
    updates.push({ id: childId, parent_id: parentId });
  }
  if (updates.length > 0) {
    // Issue updates in parallel; small batches stay well under
    // Supabase's concurrent-write cap.
    await Promise.all(updates.map((u) =>
      supabase.from("milestones").update({ parent_id: u.parent_id }).eq("id", u.id)
    ));
  }

  return result;
}
