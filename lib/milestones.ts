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
import { logMilestoneEvent, logAuditAction } from "@/lib/audit";
import { reflowAllAncestors, type ReflowNode } from "@/lib/scheduleReflow";
import { effectiveWeight, leafPercent } from "@/lib/scheduleProgress";
import type {
  Milestone, MilestoneStatus, MilestoneSource, MilestoneNote, MilestoneAttributes,
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
  percent_complete: number | null;
  planned_at: string;
  planned_start_at: string | null;
  actual_at: string | null;
  actual_start_at: string | null;
  status: MilestoneStatus;
  is_summary: boolean;
  outline_level: number | null;
  wbs: string | null;
  shift: "day" | "night" | "swing" | null;
  work_order_ref: string | null;
  responsible_party: string | null;
  responsible_user_id: string | null;
  responsible_user_name: string | null;
  responsible_kind: string | null;
  responsible_org: string | null;
  actual_party: string | null;
  actual_kind: string | null;
  actual_org: string | null;
  location: string | null;
  duration_hours: number | null;
  actual_hours: number | null;
  attributes: Record<string, string | number | boolean | null> | null;
  depends_on: string[] | null;
  baseline_start_at: string | null;
  baseline_finish_at: string | null;
  baseline_set_at: string | null;
  baseline_set_by: string | null;
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
    percentComplete: r.percent_complete != null ? Number(r.percent_complete) : 0,
    plannedAt: r.planned_at,
    plannedStartAt: r.planned_start_at,
    actualAt: r.actual_at,
    actualStartAt: r.actual_start_at,
    status: r.status,
    isSummary: r.is_summary ?? false,
    outlineLevel: r.outline_level,
    wbs: r.wbs,
    shift: r.shift,
    workOrderRef: r.work_order_ref,
    responsibleParty: r.responsible_party,
    responsibleUserId: r.responsible_user_id,
    responsibleUserName: r.responsible_user_name,
    responsibleKind: r.responsible_kind,
    responsibleOrg: r.responsible_org,
    actualParty: r.actual_party,
    actualKind: r.actual_kind,
    actualOrg: r.actual_org,
    location: r.location,
    durationHours: r.duration_hours != null ? Number(r.duration_hours) : null,
    // Tolerate pre-migration rows (column absent ⇒ undefined ⇒ null).
    actualHours: r.actual_hours != null ? Number(r.actual_hours) : null,
    attributes: r.attributes ?? {},
    dependsOn: Array.isArray(r.depends_on) ? r.depends_on : [],
    baselineStartAt: r.baseline_start_at,
    baselineFinishAt: r.baseline_finish_at,
    baselineSetAt: r.baseline_set_at,
    baselineSetBy: r.baseline_set_by,
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

export type MilestonePatch = Partial<Pick<Milestone,
  | "name" | "description" | "weight" | "plannedAt" | "plannedStartAt"
  | "linkedRevisionLabel" | "linkedTicketId" | "shift"
  | "workOrderRef" | "responsibleParty" | "responsibleKind" | "responsibleOrg"
  | "actualParty" | "actualKind" | "actualOrg" | "location" | "durationHours"
  | "attributes" | "dependsOn" | "responsibleUserId" | "responsibleUserName"
>>;

export interface UpdateMilestoneInput {
  id: string;
  patch: MilestonePatch;
  updatedBy: string;
  updatedByName?: string;
  updatedByEmail?: string;
  updatedByRole?: string;
}

// Map a camelCase patch key to its DB column. Only keys present here
// are writable through updateMilestone.
const PATCH_COLUMN: Record<string, string> = {
  name: "name", description: "description", weight: "weight",
  plannedAt: "planned_at", plannedStartAt: "planned_start_at",
  linkedRevisionLabel: "linked_revision_label", linkedTicketId: "linked_ticket_id",
  shift: "shift",
  workOrderRef: "work_order_ref",
  responsibleParty: "responsible_party", responsibleKind: "responsible_kind", responsibleOrg: "responsible_org",
  responsibleUserId: "responsible_user_id", responsibleUserName: "responsible_user_name",
  actualParty: "actual_party", actualKind: "actual_kind", actualOrg: "actual_org",
  location: "location", durationHours: "duration_hours", attributes: "attributes",
  dependsOn: "depends_on",
};

export async function updateMilestone(input: UpdateMilestoneInput): Promise<Milestone> {
  const update: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
    updated_by: input.updatedBy,
  };
  for (const [key, col] of Object.entries(PATCH_COLUMN)) {
    if (!(key in input.patch)) continue;
    let v = (input.patch as Record<string, unknown>)[key];
    if (typeof v === "string") v = v.trim() === "" ? null : v.trim();
    update[col] = v ?? null;
  }
  // name must never be nulled.
  if ("name" in input.patch && input.patch.name) update.name = input.patch.name.trim();

  // Snapshot the prior finish so we can log a human reschedule note.
  let priorFinish: string | null = null;
  if ("plannedAt" in input.patch) {
    const { data: before } = await supabase.from("milestones").select("planned_at").eq("id", input.id).maybeSingle();
    priorFinish = (before as { planned_at: string } | null)?.planned_at ?? null;
  }

  const { data, error } = await supabase.from("milestones").update(update).eq("id", input.id).select("*").single();
  if (error || !data) throw new Error(error?.message ?? "Failed to update milestone");
  const m = rowToMilestone(data as MilestoneRow);

  // Breadcrumb: record a reschedule on the task's own activity trail
  // when the finish date actually moved (so "what changed" shows moves,
  // not just status flips).
  if (priorFinish && input.patch.plannedAt && priorFinish !== input.patch.plannedAt) {
    const days = Math.round((Date.parse(input.patch.plannedAt as string) - Date.parse(priorFinish)) / 86400000);
    if (days !== 0) {
      await addMilestoneNote({
        orgId: m.orgId, milestoneId: m.id!, kind: "reschedule", statusAt: m.status,
        body: `Finish ${days > 0 ? `+${days}` : days} day${Math.abs(days) === 1 ? "" : "s"} → ${new Date(input.patch.plannedAt as string).toLocaleDateString()}`,
        createdBy: input.updatedBy, createdByName: input.updatedByName,
      }).catch(() => { /* best-effort */ });
    }
  }

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
  /** Free-form breadcrumb note captured with the transition
   *  ("waiting on parts", "contractor no-show"). */
  note?: string;
  actorUserId: string;
  actorUserName?: string;
  actorUserEmail?: string;
  actorUserRole?: string;
}

/** Transition status. 'completed' stamps actual_at + completer;
 *  first move to 'in_progress' stamps actual_start_at; leaving
 *  'completed' clears actual_at. Every transition drops a breadcrumb
 *  note onto the milestone's activity log. */
export async function setMilestoneStatus(input: SetMilestoneStatusInput): Promise<Milestone> {
  const now = new Date().toISOString();

  // Read current timestamps. actual_start_at is stamped once; first_completed_at
  // is the immutable record of the ORIGINAL completion — so a reopen→complete
  // cycle restores the original date instead of overwriting it with "now".
  const { data: cur } = await supabase
    .from("milestones").select("actual_start_at, first_completed_at, percent_complete").eq("id", input.id).maybeSingle();
  const curRow = cur as { actual_start_at: string | null; first_completed_at: string | null; percent_complete: number | null } | null;
  const existingStart = curRow?.actual_start_at ?? null;
  const existingFirstCompleted = curRow?.first_completed_at ?? null;
  const existingPct = curRow?.percent_complete != null ? Math.round(Number(curRow.percent_complete)) : 0;

  const update: Record<string, unknown> = {
    status: input.status,
    status_reason: input.statusReason?.trim() || null,
    updated_at: now,
    updated_by: input.actorUserId,
  };
  // Keep percent_complete coherent with the workflow state so the fill bar and
  // earned value can never contradict the status: completed ⇒ 100, planned ⇒ 0,
  // in_progress clamped below 100. blocked/on_hold/missed keep their logged %.
  if (input.status === "completed") {
    update.percent_complete = 100;
    // Restore the original completion date if this milestone was completed
    // before; only stamp "now" on the very first completion. Never let a
    // re-completion silently rewrite earned-value history.
    update.actual_at = existingFirstCompleted ?? now;
    if (!existingFirstCompleted) update.first_completed_at = now;
    update.completed_by = input.actorUserId;
    update.completed_by_name = input.actorUserName ?? null;
    if (!existingStart) update.actual_start_at = now;
  } else if (input.status === "in_progress") {
    update.percent_complete = Math.min(99, Math.max(0, existingPct));
    update.actual_at = null;
    update.completed_by = null;
    update.completed_by_name = null;
    if (!existingStart) update.actual_start_at = now;
  } else if (input.status === "planned") {
    update.percent_complete = 0;
    update.actual_at = null;
    update.completed_by = null;
    update.completed_by_name = null;
  } else {
    // blocked / on_hold / missed — orthogonal to physical progress; leave the
    // logged percent untouched (a task can be 40% done and blocked).
    update.actual_at = null;
    update.completed_by = null;
    update.completed_by_name = null;
  }

  const { data, error } = await supabase.from("milestones").update(update).eq("id", input.id).select("*").single();
  if (error || !data) throw new Error(error?.message ?? "Failed to update milestone status");
  const m = rowToMilestone(data as MilestoneRow);

  // Breadcrumb note for the task's own activity log.
  await addMilestoneNote({
    orgId: m.orgId,
    milestoneId: m.id!,
    kind: "status",
    statusAt: input.status,
    body: input.note?.trim() || input.statusReason?.trim() || null,
    createdBy: input.actorUserId,
    createdByName: input.actorUserName,
  }).catch(() => { /* note is best-effort; never block the transition */ });

  const res = pickResource(m);
  const auditType =
    input.status === "completed" ? "MILESTONE_COMPLETED" :
    input.status === "missed"    ? "MILESTONE_MISSED"    :
    (input.status === "blocked" || input.status === "on_hold") ? "MILESTONE_BLOCKED" :
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
    details: { newStatus: input.status, statusReason: input.statusReason, note: input.note, plannedAt: m.plannedAt, actualAt: m.actualAt },
  });

  return m;
}

export interface SetMilestoneProgressInput {
  id: string;
  /** Target physical progress, 0–100. */
  percentComplete: number;
  note?: string;
  actorUserId: string;
  actorUserName?: string;
  actorUserEmail?: string;
  actorUserRole?: string;
}

/**
 * Set a LEAF task's physical progress (0–100) and derive its workflow status:
 *   100 ⇒ completed,  0 ⇒ planned,  1..99 ⇒ in_progress.
 * An explicit exception state (blocked / on_hold / missed) is preserved — those
 * are deliberate and orthogonal to "how much is physically done", so logging
 * 40% on a blocked task keeps it blocked-at-40%. Completion stamps the actual
 * dates exactly like setMilestoneStatus (and restores the original first
 * completion date on a re-complete). Summary/parent progress is never set here —
 * it's rolled up from children (see lib/scheduleProgress.ts).
 */
export async function setMilestoneProgress(input: SetMilestoneProgressInput): Promise<Milestone> {
  const now = new Date().toISOString();
  const pct = Math.max(0, Math.min(100, Math.round(input.percentComplete)));

  const { data: cur } = await supabase
    .from("milestones")
    .select("actual_start_at, first_completed_at, status")
    .eq("id", input.id).maybeSingle();
  const curRow = cur as { actual_start_at: string | null; first_completed_at: string | null; status: MilestoneStatus } | null;
  const existingStart = curRow?.actual_start_at ?? null;
  const existingFirstCompleted = curRow?.first_completed_at ?? null;
  const prevStatus: MilestoneStatus = curRow?.status ?? "planned";
  const isException = prevStatus === "blocked" || prevStatus === "on_hold" || prevStatus === "missed";

  let nextStatus: MilestoneStatus;
  if (pct >= 100) nextStatus = "completed";
  else if (pct <= 0) nextStatus = isException ? prevStatus : "planned";
  else nextStatus = isException ? prevStatus : "in_progress";

  const update: Record<string, unknown> = {
    percent_complete: pct,
    status: nextStatus,
    updated_at: now,
    updated_by: input.actorUserId,
  };
  if (nextStatus === "completed") {
    update.actual_at = existingFirstCompleted ?? now;
    if (!existingFirstCompleted) update.first_completed_at = now;
    update.completed_by = input.actorUserId;
    update.completed_by_name = input.actorUserName ?? null;
    if (!existingStart) update.actual_start_at = now;
  } else {
    update.actual_at = null;
    update.completed_by = null;
    update.completed_by_name = null;
    // Starting work (first crossing above 0%) stamps the actual start.
    if (pct > 0 && !existingStart) update.actual_start_at = now;
  }

  const { data, error } = await supabase.from("milestones").update(update).eq("id", input.id).select("*").single();
  if (error || !data) throw new Error(error?.message ?? "Failed to update milestone progress");
  const m = rowToMilestone(data as MilestoneRow);

  await addMilestoneNote({
    orgId: m.orgId,
    milestoneId: m.id!,
    kind: "status",
    statusAt: nextStatus,
    body: input.note?.trim() || `Progress → ${pct}%`,
    createdBy: input.actorUserId,
    createdByName: input.actorUserName,
  }).catch(() => { /* note is best-effort; never block the update */ });

  const res = pickResource(m);
  await logMilestoneEvent({
    orgId: m.orgId,
    milestoneId: m.id!,
    resourceType: res.resourceType,
    resourceId: res.resourceId,
    userId: input.actorUserId,
    userEmail: input.actorUserEmail,
    userRole: input.actorUserRole,
    type: nextStatus === "completed" ? "MILESTONE_COMPLETED" : "MILESTONE_UPDATED",
    name: m.name,
    details: { percentComplete: pct, newStatus: nextStatus },
  });

  return m;
}

// ─── Field input: actual hours (ACWP source) ─────────────────────

export interface LogActualHoursInput {
  id: string;
  /** Total actual labor hours expended to date on the task. Null clears it. */
  actualHours: number | null;
  actorUserId: string;
  actorUserName?: string;
  actorUserEmail?: string;
  actorUserRole?: string;
}

export interface LogActualHoursResult {
  ok: boolean;
  milestone?: Milestone;
  /** True when the actual_hours column isn't there yet (pre-migration) — the
   *  caller surfaces a "run the migration" hint rather than a hard error. */
  needsMigration?: boolean;
}

/**
 * Log the ACTUAL labor hours expended on a leaf task — the frictionless field
 * input that feeds ACWP for cost EVM (Σ actual_hours × blended rate). Writes a
 * breadcrumb note + audit event. Tolerant of pre-migration environments: if the
 * actual_hours column is missing it returns { ok:false, needsMigration:true }
 * instead of throwing.
 */
export async function logActualHours(input: LogActualHoursInput): Promise<LogActualHoursResult> {
  const now = new Date().toISOString();
  const hours =
    input.actualHours == null || !Number.isFinite(input.actualHours)
      ? null
      : Math.max(0, Math.round(input.actualHours * 100) / 100);

  const { data, error } = await supabase
    .from("milestones")
    .update({ actual_hours: hours, updated_at: now, updated_by: input.actorUserId })
    .eq("id", input.id)
    .select("*")
    .single();

  if (error || !data) {
    if (looksLikeUnknownColumn(error?.message)) return { ok: false, needsMigration: true };
    throw new Error(error?.message ?? "Failed to log actual hours");
  }
  const m = rowToMilestone(data as MilestoneRow);

  await addMilestoneNote({
    orgId: m.orgId, milestoneId: m.id!, kind: "field", statusAt: m.status,
    body: hours == null ? "Actual hours cleared" : `Actual hours → ${hours}h`,
    createdBy: input.actorUserId, createdByName: input.actorUserName,
  }).catch(() => { /* best-effort breadcrumb */ });

  const res = pickResource(m);
  await logMilestoneEvent({
    orgId: m.orgId, milestoneId: m.id!,
    resourceType: res.resourceType, resourceId: res.resourceId,
    userId: input.actorUserId, userEmail: input.actorUserEmail, userRole: input.actorUserRole,
    type: "MILESTONE_UPDATED", name: m.name,
    details: { actualHours: hours },
  });

  return { ok: true, milestone: m };
}

// ─── Milestone activity notes (breadcrumb trail) ─────────────────

interface MilestoneNoteRow {
  id: string; org_id: string; milestone_id: string;
  kind: MilestoneNote["kind"]; status_at: MilestoneStatus | null;
  body: string | null; created_at: string; created_by: string; created_by_name: string | null;
}

function noteRowTo(r: MilestoneNoteRow): MilestoneNote {
  return {
    id: r.id, orgId: r.org_id, milestoneId: r.milestone_id,
    kind: r.kind, statusAt: r.status_at, body: r.body,
    createdAt: r.created_at, createdBy: r.created_by, createdByName: r.created_by_name,
  };
}

export async function addMilestoneNote(input: {
  orgId: string; milestoneId: string;
  kind: MilestoneNote["kind"]; statusAt?: MilestoneStatus | null;
  body?: string | null; createdBy: string; createdByName?: string;
}): Promise<MilestoneNote> {
  const { data, error } = await supabase.from("milestone_notes").insert({
    org_id: input.orgId, milestone_id: input.milestoneId,
    kind: input.kind, status_at: input.statusAt ?? null,
    body: input.body?.trim() || null,
    created_by: input.createdBy, created_by_name: input.createdByName ?? null,
  }).select("*").single();
  if (error || !data) throw new Error(error?.message ?? "Failed to add note");
  return noteRowTo(data as MilestoneNoteRow);
}

export async function listMilestoneNotes(milestoneId: string): Promise<MilestoneNote[]> {
  const { data, error } = await supabase
    .from("milestone_notes").select("*").eq("milestone_id", milestoneId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return ((data as MilestoneNoteRow[]) ?? []).map(noteRowTo);
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
    planned: 0, in_progress: 0, completed: 0, missed: 0, blocked: 0, on_hold: 0,
  };

  // Roll up over LEAF tasks only. Summary/parent rows are envelopes of their
  // children — counting their weight too would double-count the work. Earned
  // value is each leaf's effort × its real percent_complete (not a binary
  // completed flag), so partial progress moves the needle the way it should.
  const parentIds = new Set<string>();
  for (const m of milestones) { if (m.parentId) parentIds.add(m.parentId); }
  const isLeaf = (m: Milestone) => !(m.id && parentIds.has(m.id));

  for (const m of milestones) {
    if (!isLeaf(m)) continue;
    const w = effectiveWeight(m);
    totalWeight += w;
    byStatus[m.status]++;
    const plannedMs = new Date(m.plannedAt as string).getTime();
    if (plannedMs > plannedEndMs) plannedEndMs = plannedMs;
    if (plannedMs <= now.getTime()) plannedValue += w;
    earnedValue += w * (leafPercent(m) / 100);
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
      // Project already past planned end; forecast = now + remaining-work
      // guess, projecting the observed earn rate forward.
      //
      // Defensive: derive the earn rate from the EARLIEST valid milestone
      // creation time, and only forecast when we have (a) real elapsed time,
      // (b) something actually earned, and (c) work remaining. Otherwise a
      // missing/future createdAt or a zero earn would yield a nonsense date
      // (Infinity, negative, or "now"). When we can't compute meaningfully,
      // leave forecastEndAt null — the UI already handles that.
      const remaining = totalWeight - earnedValue;
      const nowMs = now.getTime();
      let earliestCreatedMs = Infinity;
      for (const m of milestones) {
        const t = m.createdAt ? new Date(m.createdAt as string).getTime() : NaN;
        if (Number.isFinite(t) && t < earliestCreatedMs) earliestCreatedMs = t;
      }
      const elapsedMs = Number.isFinite(earliestCreatedMs) ? nowMs - earliestCreatedMs : 0;
      if (elapsedMs > 0 && earnedValue > 0 && remaining > 0) {
        const earnedRatePerMs = earnedValue / elapsedMs;
        forecastEndAt = new Date(nowMs + remaining / earnedRatePerMs).toISOString();
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
      // Upsert on (org, project/document, source, external_ref) so
      // re-imports of the same file to a different project don't
      // hijack rows that belong to the original project.
      if (externalRef) {
        let q = supabase
          .from("milestones")
          .select("id")
          .eq("org_id", input.orgId)
          .eq("source", input.source)
          .eq("external_ref", externalRef);
        if (input.projectId) q = q.eq("project_id", input.projectId);
        else if (input.documentId) q = q.eq("document_id", input.documentId);
        else q = q.is("project_id", null).is("document_id", null);
        const { data: existing } = await q.maybeSingle();
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
  /** Source schedule's progress (MS Project %Complete, P6 physical %, CSV
   *  "% complete"). Drives the imported status + percent_complete. */
  percentComplete?: number;
  description?: string | null;
  externalRef?: string | null;
  parentExternalRef?: string | null;
  outlineLevel?: number | null;
  wbs?: string | null;
  isSummary?: boolean;
  /** External refs of predecessor rows (finish-to-start). Resolved to ids
   *  in pass 3 once every row has an id. */
  dependsOnExternalRefs?: string[];
  // Rich execution fields extracted from the source schedule.
  workOrderRef?: string | null;
  responsibleParty?: string | null;
  responsibleKind?: string | null;
  responsibleOrg?: string | null;
  location?: string | null;
  durationHours?: number | null;
  attributes?: MilestoneAttributes | null;
}

export interface ImportParsedInput {
  orgId: string;
  projectId?: string | null;
  documentId?: string | null;
  /** Provenance. File imports pass p6/msproject/csv/mpxj; AI-generated
   *  schedules (reviewed + applied by the user) land as 'manual'. */
  source: MilestoneSource;
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

/** Set the hierarchy migration (20260703) has applied. Determined
 *  lazily on first INSERT failure caused by an unknown column —
 *  once we hit it, every subsequent row in the same import drops
 *  the new fields so we don't keep re-trying schema we know is
 *  missing. The whole batch still lands; the hierarchy just isn't
 *  preserved until the user runs the migration. */
const NEW_SCHEMA_FIELDS = [
  "planned_start_at", "outline_level", "wbs", "is_summary", "shift",
  "work_order_ref", "responsible_party", "responsible_kind", "responsible_org",
  "location", "duration_hours", "attributes", "percent_complete",
] as const;
function looksLikeUnknownColumn(msg: string | undefined): boolean {
  if (!msg) return false;
  return /column .* does not exist|unknown column|could not find the/i.test(msg);
}

export async function importMilestonesFromParsed(input: ImportParsedInput): Promise<ImportResult> {
  const result: ImportResult = { inserted: 0, updated: 0, skipped: 0, errors: [] };
  let degradeToLegacy = false; // flipped on first unknown-column error

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

    // Carry the source schedule's progress through: MS Project %Complete, P6
    // physical %, or a CSV "% complete" column. Derive the workflow status from
    // it (100 ⇒ completed, >0 ⇒ in_progress, else planned) so an imported,
    // partially-done schedule lands with its real progress instead of resetting
    // everything to 0% / planned.
    const importPct = r.percentComplete != null && Number.isFinite(r.percentComplete)
      ? Math.max(0, Math.min(100, Math.round(r.percentComplete)))
      : 0;
    const importStatus: MilestoneStatus = importPct >= 100 ? "completed" : importPct > 0 ? "in_progress" : "planned";

    const baseFields: Record<string, unknown> = {
      name,
      description: r.description ?? null,
      weight: isNaN(weight) ? 1 : weight,
      planned_at: plannedIso,
      // status + actuals are core columns (always present); percent_complete is
      // stripped automatically on a pre-migration DB via NEW_SCHEMA_FIELDS.
      status: importStatus,
      percent_complete: importPct,
      actual_at: importStatus === "completed" ? plannedIso : null,
      actual_start_at: importPct > 0 ? (plannedStartIso ?? plannedIso) : null,
    };
    if (!degradeToLegacy) {
      baseFields.planned_start_at = plannedStartIso;
      baseFields.outline_level = r.outlineLevel ?? null;
      baseFields.wbs = r.wbs ?? null;
      baseFields.is_summary = !!r.isSummary;
      baseFields.shift = shiftFromStart(plannedStartIso);
      baseFields.work_order_ref = r.workOrderRef ?? null;
      baseFields.responsible_party = r.responsibleParty ?? null;
      baseFields.responsible_kind = r.responsibleKind ?? null;
      baseFields.responsible_org = r.responsibleOrg ?? null;
      baseFields.location = r.location ?? null;
      baseFields.duration_hours = r.durationHours ?? null;
      baseFields.attributes = r.attributes && Object.keys(r.attributes).length > 0 ? r.attributes : {};
    }

    try {
      if (r.externalRef) {
        // Scope the existing-row lookup to project_id (or document_id)
        // so cross-project re-imports of the same .mpp insert new rows
        // instead of clobbering rows on a different project. Fixes the
        // bug where importing the same schedule to a second project
        // left the new project empty.
        let q = supabase
          .from("milestones")
          .select("id")
          .eq("org_id", input.orgId)
          .eq("source", input.source)
          .eq("external_ref", r.externalRef);
        if (input.projectId) q = q.eq("project_id", input.projectId);
        else if (input.documentId) q = q.eq("document_id", input.documentId);
        else q = q.is("project_id", null).is("document_id", null);
        const { data: existing } = await q.maybeSingle();
        if (existing) {
          const id = (existing as { id: string }).id;
          refToId.set(r.externalRef, id);
          let updateRes = await supabase.from("milestones").update({
            ...baseFields,
            updated_at: new Date().toISOString(),
            updated_by: input.createdBy,
          }).eq("id", id);
          if (updateRes.error && looksLikeUnknownColumn(updateRes.error.message)) {
            degradeToLegacy = true;
            const legacyFields = { ...baseFields };
            for (const f of NEW_SCHEMA_FIELDS) delete legacyFields[f];
            updateRes = await supabase.from("milestones").update({
              ...legacyFields,
              updated_at: new Date().toISOString(),
              updated_by: input.createdBy,
            }).eq("id", id);
          }
          if (updateRes.error) result.errors.push(`Row ${i + 1}: ${updateRes.error.message}`);
          else result.updated++;
          continue;
        }
      }
      let insertRes = await supabase.from("milestones").insert({
        org_id: input.orgId,
        project_id: input.projectId ?? null,
        document_id: input.documentId ?? null,
        ...baseFields,
        source: input.source,
        external_ref: r.externalRef ?? null,
        created_by: input.createdBy,
        created_by_name: input.createdByName ?? null,
      }).select("id").maybeSingle();
      if (insertRes.error && looksLikeUnknownColumn(insertRes.error.message)) {
        // Schema migration hasn't been applied — drop the new fields
        // and retry. Hierarchy will be lost until the user runs
        // 20260703_milestones_hierarchy.sql, but the import lands.
        degradeToLegacy = true;
        const legacyFields = { ...baseFields };
        for (const f of NEW_SCHEMA_FIELDS) delete legacyFields[f];
        insertRes = await supabase.from("milestones").insert({
          org_id: input.orgId,
          project_id: input.projectId ?? null,
          document_id: input.documentId ?? null,
          ...legacyFields,
          source: input.source,
          external_ref: r.externalRef ?? null,
          created_by: input.createdBy,
          created_by_name: input.createdByName ?? null,
        }).select("id").maybeSingle();
      }
      if (insertRes.error) {
        result.errors.push(`Row ${i + 1}: ${insertRes.error.message}`);
        continue;
      }
      if (insertRes.data && r.externalRef) {
        refToId.set(r.externalRef, (insertRes.data as { id: string }).id);
      }
      result.inserted++;
    } catch (e) {
      result.errors.push(`Row ${i + 1}: ${(e as Error).message}`);
    }
  }

  // Pass 2: resolve parent_id wherever both parent and child landed.
  // Done as a separate loop because the parent might appear AFTER the
  // child in the input order (rare but happens with some MS Project
  // exports). Skipped rows have nothing to resolve. Skipped entirely
  // when we've degraded to legacy schema — parent_id column doesn't
  // exist there either.
  if (!degradeToLegacy) {
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
      await Promise.all(updates.map((u) =>
        supabase.from("milestones").update({ parent_id: u.parent_id }).eq("id", u.id)
      ));
    }

    // Pass 3: resolve finish-to-start dependencies (predecessor external refs
    // → ids). Degrades silently if the depends_on column isn't migrated yet.
    const depUpdates: Array<{ id: string; depends_on: string[] }> = [];
    for (const r of input.rows) {
      if (!r.externalRef || !r.dependsOnExternalRefs?.length) continue;
      const id = refToId.get(r.externalRef);
      if (!id) continue;
      const predIds = r.dependsOnExternalRefs
        .map((ref) => refToId.get(ref))
        .filter((x): x is string => !!x && x !== id);
      if (predIds.length > 0) depUpdates.push({ id, depends_on: predIds });
    }
    if (depUpdates.length > 0) {
      await Promise.all(depUpdates.map(async (u) => {
        const res = await supabase.from("milestones").update({ depends_on: u.depends_on }).eq("id", u.id);
        if (res.error && !looksLikeUnknownColumn(res.error.message)) {
          result.errors.push(`Dependencies for ${u.id}: ${res.error.message}`);
        }
      }));
    }
  } else {
    result.errors.push(
      "Heads up: hierarchy migration 20260703_milestones_hierarchy.sql hasn't been applied to your database, so parent/child relationships and start dates were dropped on this import. Run the migration in Supabase SQL Editor and re-import to get the full schedule.",
    );
  }

  return result;
}

// ─── Rebase ──────────────────────────────────────────────────────
//
// Shift every milestone on a project by the same delta so an old
// schedule can be reused with a new start date. The delta is the
// difference between the project's current earliest planned date
// and the user-chosen new start. All relative spacing — task
// durations, gaps between tasks, the WBS — is preserved.
//
// Use cases:
//   * "We did this turnaround last year. Use the same schedule for
//     the one in two weeks." → pick the new TA start date, rebase.
//   * "Slipping start by 3 days." → pick today+3, rebase.

export interface RebaseScheduleInput {
  orgId: string;
  projectId: string;
  /** ISO date — the day the FIRST task should now start.
   *  e.g. "2026-06-15T08:00:00Z". The delta from the current
   *  earliest planned_start_at (or planned_at if start is NULL)
   *  becomes the shift applied to every row. */
  newStartIso: string;
  actorUserId: string;
  actorUserName?: string;
  actorUserEmail?: string;
  actorUserRole?: string;
}

export interface RebaseResult {
  shiftedCount: number;
  /** Days shifted (positive = forward in time, negative = back). */
  shiftDays: number;
  /** Old anchor date for the audit log. */
  oldAnchor: string | null;
  /** New anchor date. */
  newAnchor: string;
  errors: string[];
}

export async function rebaseSchedule(input: RebaseScheduleInput): Promise<RebaseResult> {
  const errors: string[] = [];
  // 1. Load the current schedule so we can find the earliest anchor.
  const { data: rows, error: loadErr } = await supabase
    .from("milestones")
    .select("id, planned_at, planned_start_at, actual_at, actual_start_at, updated_at")
    .eq("org_id", input.orgId)
    .eq("project_id", input.projectId);
  if (loadErr) {
    errors.push(`Couldn't load milestones: ${loadErr.message}`);
    return { shiftedCount: 0, shiftDays: 0, oldAnchor: null, newAnchor: input.newStartIso, errors };
  }
  if (!rows || rows.length === 0) {
    errors.push("No milestones on this project to rebase.");
    return { shiftedCount: 0, shiftDays: 0, oldAnchor: null, newAnchor: input.newStartIso, errors };
  }

  // 2. Find the earliest plannedStart (fallback planned_at) — that
  //    becomes the anchor we shift FROM.
  let earliestMs = Infinity;
  for (const r of rows as Array<{ planned_at: string; planned_start_at: string | null }>) {
    const candidate = r.planned_start_at ?? r.planned_at;
    if (!candidate) continue;
    const t = new Date(candidate).getTime();
    if (Number.isFinite(t) && t < earliestMs) earliestMs = t;
  }
  if (!Number.isFinite(earliestMs)) {
    errors.push("Couldn't find any planned dates on this project.");
    return { shiftedCount: 0, shiftDays: 0, oldAnchor: null, newAnchor: input.newStartIso, errors };
  }

  const newAnchorMs = new Date(input.newStartIso).getTime();
  if (!Number.isFinite(newAnchorMs)) {
    errors.push(`Invalid newStartIso: ${input.newStartIso}`);
    return { shiftedCount: 0, shiftDays: 0, oldAnchor: new Date(earliestMs).toISOString(), newAnchor: input.newStartIso, errors };
  }
  const deltaMs = newAnchorMs - earliestMs;
  const shiftDays = Math.round(deltaMs / 86400000);

  if (deltaMs === 0) {
    return {
      shiftedCount: 0, shiftDays: 0,
      oldAnchor: new Date(earliestMs).toISOString(),
      newAnchor: input.newStartIso,
      errors: ["Schedule already starts on that date — no shift needed."],
    };
  }

  // 3. Apply delta to every row. Plain row-by-row update — clean,
  //    auditable, and tolerable for the typical schedule size (a
  //    few hundred to a few thousand rows). RLS rejects rows the
  //    user can't write, so this respects org-scoping naturally.
  let shifted = 0;
  let skipped = 0;
  for (const raw of rows as Array<{ id: string; planned_at: string; planned_start_at: string | null; actual_at: string | null; actual_start_at: string | null; updated_at: string | null }>) {
    const patch: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
      updated_by: input.actorUserId,
    };
    if (raw.planned_at) patch.planned_at = new Date(new Date(raw.planned_at).getTime() + deltaMs).toISOString();
    if (raw.planned_start_at) patch.planned_start_at = new Date(new Date(raw.planned_start_at).getTime() + deltaMs).toISOString();
    // Actual dates do NOT shift — they're history.
    // Optimistic lock: only shift if the row hasn't been edited since we read
    // it, so a concurrent change isn't silently overwritten and counted as a
    // success. A zero-row result = someone else touched it → skip + report.
    let q = supabase.from("milestones").update(patch).eq("id", raw.id);
    if (raw.updated_at) q = q.eq("updated_at", raw.updated_at);
    const { data: updatedRow, error } = await q.select("id").maybeSingle();
    if (error) errors.push(`${raw.id.slice(0, 8)}: ${error.message}`);
    else if (!updatedRow) skipped++;
    else shifted++;
  }
  if (skipped > 0) {
    errors.push(`${skipped} task${skipped === 1 ? "" : "s"} were edited by someone else during the rebase and were left unchanged — re-check those dates.`);
  }

  await logAuditAction({
    action: "SCHEDULE_REBASED",
    resourceType: "project",
    resourceId: input.projectId,
    orgId: input.orgId,
    userId: input.actorUserId,
    userEmail: input.actorUserEmail,
    userRole: input.actorUserRole,
    details: {
      shiftedCount: shifted,
      shiftDays,
      oldAnchor: new Date(earliestMs).toISOString(),
      newAnchor: input.newStartIso,
    },
  });

  return {
    shiftedCount: shifted,
    shiftDays,
    oldAnchor: new Date(earliestMs).toISOString(),
    newAnchor: input.newStartIso,
    errors,
  };
}

// ─── Manual grouping ─────────────────────────────────────────────
//
// When the imported schedule doesn't carry hierarchy (common with
// turnaround punch lists, CSV exports, or older MPP files), users
// can build the WBS in-app: select a bunch of tasks, name a new
// parent, and reparent them in one shot.
//
// Also: set duration on a task so a 1-day task becomes a 3-day task.

export interface GroupTasksInput {
  orgId: string;
  projectId: string;
  /** Either create a new parent (pass parentName) or reuse an
   *  existing one (pass parentId). Exactly one is required. */
  parentName?: string;
  parentId?: string;
  /** IDs of the children to reparent. */
  childIds: string[];
  actorUserId: string;
  actorUserName?: string;
  actorUserEmail?: string;
  actorUserRole?: string;
}

export interface GroupTasksResult {
  parentId: string;
  parentName: string;
  childCount: number;
  errors: string[];
}

export async function groupTasksUnderParent(input: GroupTasksInput): Promise<GroupTasksResult> {
  const errors: string[] = [];
  if (input.childIds.length === 0) {
    errors.push("No tasks selected to group.");
    return { parentId: "", parentName: "", childCount: 0, errors };
  }
  if (!input.parentName && !input.parentId) {
    errors.push("Provide either parentName or parentId.");
    return { parentId: "", parentName: "", childCount: 0, errors };
  }

  // Resolve parent: existing or new.
  let parentId = input.parentId ?? "";
  let parentName = "";

  if (parentId) {
    const { data, error } = await supabase
      .from("milestones")
      .select("id, name")
      .eq("id", parentId)
      .maybeSingle();
    if (error || !data) {
      errors.push(`Parent ${parentId.slice(0,8)} not found.`);
      return { parentId, parentName: "", childCount: 0, errors };
    }
    parentName = (data as { name: string }).name;
  } else {
    // Create a new summary parent. Use the EARLIEST child's planned
    // date as the parent's planned date (so the parent appears
    // before the children on the calendar).
    const { data: kids } = await supabase
      .from("milestones")
      .select("planned_at, planned_start_at")
      .in("id", input.childIds);
    let earliest = Infinity;
    let latest = -Infinity;
    for (const k of (kids ?? []) as Array<{ planned_at: string; planned_start_at: string | null }>) {
      const s = k.planned_start_at ?? k.planned_at;
      if (s) {
        const t = new Date(s).getTime();
        if (Number.isFinite(t) && t < earliest) earliest = t;
      }
      if (k.planned_at) {
        const t = new Date(k.planned_at).getTime();
        if (Number.isFinite(t) && t > latest) latest = t;
      }
    }
    const parentStart = Number.isFinite(earliest) ? new Date(earliest).toISOString() : new Date().toISOString();
    const parentFinish = Number.isFinite(latest) ? new Date(latest).toISOString() : parentStart;

    const { data: created, error: createErr } = await supabase
      .from("milestones")
      .insert({
        org_id: input.orgId,
        project_id: input.projectId,
        name: input.parentName!.trim(),
        weight: 1,
        planned_start_at: parentStart,
        planned_at: parentFinish,
        is_summary: true,
        source: "manual",
        created_by: input.actorUserId,
        created_by_name: input.actorUserName ?? null,
      })
      .select("id, name")
      .single();
    if (createErr || !created) {
      errors.push(`Couldn't create parent task: ${createErr?.message ?? "unknown"}`);
      return { parentId: "", parentName: "", childCount: 0, errors };
    }
    parentId = (created as { id: string }).id;
    parentName = (created as { name: string }).name;
  }

  // Reparent the children. RLS handles org-scoping.
  let updated = 0;
  for (const cid of input.childIds) {
    if (cid === parentId) continue; // safety
    const { error } = await supabase
      .from("milestones")
      .update({
        parent_id: parentId,
        updated_at: new Date().toISOString(),
        updated_by: input.actorUserId,
      })
      .eq("id", cid);
    if (error) errors.push(`${cid.slice(0,8)}: ${error.message}`);
    else updated++;
  }

  await logAuditAction({
    action: "TASKS_GROUPED",
    resourceType: "project",
    resourceId: input.projectId,
    orgId: input.orgId,
    userId: input.actorUserId,
    userEmail: input.actorUserEmail,
    userRole: input.actorUserRole,
    details: { parentId, parentName, childCount: updated },
  });

  return { parentId, parentName, childCount: updated, errors };
}

/** Set a task's duration (in days). Updates planned_start_at so
 *  the task spans `days` calendar days ending on its planned_at.
 *  Useful when the import only gave us a single finish date and
 *  the user knows the task actually takes 3 days. */
export async function setTaskDuration(input: {
  id: string;
  days: number;
  actorUserId: string;
}): Promise<{ ok: boolean; error?: string }> {
  if (input.days < 1) return { ok: false, error: "Duration must be at least 1 day." };
  const { data: row, error: readErr } = await supabase
    .from("milestones")
    .select("planned_at, project_id, parent_id")
    .eq("id", input.id)
    .maybeSingle();
  if (readErr || !row) return { ok: false, error: readErr?.message ?? "Task not found" };
  const r = row as { planned_at: string; project_id: string | null; parent_id: string | null };
  const finish = new Date(r.planned_at);
  if (isNaN(finish.getTime())) return { ok: false, error: "Task has no valid finish date." };
  const start = new Date(finish); start.setDate(finish.getDate() - (input.days - 1));
  const newStartIso = start.toISOString();
  const { error: updErr } = await supabase
    .from("milestones")
    .update({
      planned_start_at: newStartIso,
      updated_at: new Date().toISOString(),
      updated_by: input.actorUserId,
    })
    .eq("id", input.id);
  if (updErr) return { ok: false, error: updErr.message };

  // Re-envelope ancestors so a parent/summary bar still covers this leaf.
  // (Drag edits reflow via computeTreeMove; a direct duration set didn't,
  // leaving the parent span stale until the next drag.) Best-effort: the
  // leaf update already committed, so we don't fail the call if this slips.
  if (r.parent_id && r.project_id) {
    try {
      const { data: rows } = await supabase
        .from("milestones")
        .select("id, parent_id, planned_start_at, planned_at")
        .eq("project_id", r.project_id);
      if (rows) {
        const nodes: ReflowNode[] = (rows as Array<{ id: string; parent_id: string | null; planned_start_at: string | null; planned_at: string }>)
          .map((m) => ({
            id: m.id,
            parentId: m.parent_id,
            plannedStartAt: m.id === input.id ? newStartIso : m.planned_start_at,
            plannedAt: m.planned_at,
          }));
        const changes = reflowAllAncestors(nodes);
        await Promise.all(changes.map((c) =>
          supabase.from("milestones").update({
            planned_start_at: c.plannedStartAt,
            planned_at: c.plannedAt,
            updated_at: new Date().toISOString(),
            updated_by: input.actorUserId,
          }).eq("id", c.id),
        ));
      }
    } catch { /* envelope reflow is best-effort */ }
  }
  return { ok: true };
}

// ─── Baseline (approved-plan snapshot) ───────────────────────────
//
// Capture each task's current planned start/finish as its baseline so
// drift ("planned vs now") becomes glanceable. One call snapshots the
// whole project. Re-running re-baselines (e.g. after a formal
// re-plan). clearBaseline removes it.

export async function setBaseline(input: {
  orgId: string;
  projectId: string;
  actorUserId: string;
  actorUserEmail?: string;
  actorUserRole?: string;
}): Promise<{ ok: boolean; count: number; error?: string }> {
  const { data: rows, error } = await supabase
    .from("milestones")
    .select("id, planned_at, planned_start_at")
    .eq("org_id", input.orgId)
    .eq("project_id", input.projectId);
  if (error) return { ok: false, count: 0, error: error.message };
  if (!rows || rows.length === 0) return { ok: false, count: 0, error: "No tasks to baseline." };

  const now = new Date().toISOString();
  let count = 0;
  const errors: string[] = [];
  await Promise.all((rows as Array<{ id: string; planned_at: string; planned_start_at: string | null }>).map(async (r) => {
    const { error: e } = await supabase.from("milestones").update({
      baseline_start_at: r.planned_start_at ?? r.planned_at,
      baseline_finish_at: r.planned_at,
      baseline_set_at: now,
      baseline_set_by: input.actorUserId,
    }).eq("id", r.id);
    if (e) errors.push(e.message); else count++;
  }));

  await logAuditAction({
    action: "SCHEDULE_BASELINED",
    resourceType: "project",
    resourceId: input.projectId,
    orgId: input.orgId,
    userId: input.actorUserId,
    userEmail: input.actorUserEmail,
    userRole: input.actorUserRole,
    details: { count },
  }).catch(() => { /* audit is best-effort */ });

  return { ok: errors.length === 0, count, error: errors[0] };
}

export async function clearBaseline(input: {
  orgId: string;
  projectId: string;
  actorUserId: string;
}): Promise<{ ok: boolean; error?: string }> {
  const { error } = await supabase.from("milestones").update({
    baseline_start_at: null, baseline_finish_at: null, baseline_set_at: null, baseline_set_by: null,
  }).eq("org_id", input.orgId).eq("project_id", input.projectId);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}
