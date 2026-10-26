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
import { mergeImportedProgress } from "@/lib/scheduleRules";
import { DEFAULT_SCHEDULE_TZ, naiveToIso, normalizeTimeZone, shiftWallClock, addDays, hasTimeOfDay, dayDiff } from "@/lib/scheduleTz";
import { fetchAllRows } from "@/lib/fetchAllRows";
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
  critical_override?: "yes" | "no" | null;
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
  attributes: Record<string, string | number | boolean | null> | null;
  depends_on: string[] | null;
  link_types?: Record<string, { type: "FS" | "SS" | "FF" | "SF"; lagHours: number }> | null;
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
    criticalOverride: r.critical_override ?? null,
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
    attributes: r.attributes ?? {},
    dependsOn: Array.isArray(r.depends_on) ? r.depends_on : [],
    linkTypes: r.link_types ?? null,
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
  plannedAt: string;             // ISO finish
  /** ISO start; omitted = a point-in-time step on plannedAt. */
  plannedStartAt?: string | null;
  /** Real hours of work — what the shift report weighs this step by. */
  durationHours?: number | null;
  /** Equipment / step group this belongs under. */
  parentId?: string | null;
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
  if (input.plannedStartAt && Date.parse(input.plannedStartAt) > Date.parse(input.plannedAt)) {
    throw new Error("Start must be on or before the finish.");
  }
  const core: Record<string, unknown> = {
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
  };
  const rich: Record<string, unknown> = {};
  if (input.plannedStartAt) rich.planned_start_at = input.plannedStartAt;
  if (input.durationHours != null && Number.isFinite(input.durationHours) && input.durationHours > 0) rich.duration_hours = input.durationHours;
  if (input.parentId) rich.parent_id = input.parentId;
  let ins = await supabase.from("milestones").insert({ ...core, ...rich }).select("*").single();
  if (ins.error && Object.keys(rich).length > 0 && looksLikeUnknownColumn(ins.error.message)) {
    // Pre-hierarchy database: land the step, drop the fields it can't hold.
    ins = await supabase.from("milestones").insert(core).select("*").single();
  }
  const { data, error } = ins;

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
    details: { plannedAt: row.planned_at, plannedStartAt: row.planned_start_at ?? null, durationHours: row.duration_hours ?? null, parentId: row.parent_id ?? null, weight: row.weight, source: row.source },
  });

  return m;
}

export type MilestonePatch = Partial<Pick<Milestone,
  | "name" | "description" | "weight" | "plannedAt" | "plannedStartAt"
  | "linkedRevisionLabel" | "linkedTicketId" | "shift" | "criticalOverride"
  | "workOrderRef" | "responsibleParty" | "responsibleKind" | "responsibleOrg"
  | "actualParty" | "actualKind" | "actualOrg" | "location" | "durationHours"
  | "attributes" | "dependsOn" | "linkTypes" | "responsibleUserId" | "responsibleUserName"
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
  criticalOverride: "critical_override",
  workOrderRef: "work_order_ref",
  responsibleParty: "responsible_party", responsibleKind: "responsible_kind", responsibleOrg: "responsible_org",
  responsibleUserId: "responsible_user_id", responsibleUserName: "responsible_user_name",
  actualParty: "actual_party", actualKind: "actual_kind", actualOrg: "actual_org",
  location: "location", durationHours: "duration_hours", attributes: "attributes",
  dependsOn: "depends_on",
  linkTypes: "link_types",
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

  let { data, error } = await supabase.from("milestones").update(update).eq("id", input.id).select("*").single();
  // Before the link-types migration: save the rest (links as finish-to-start).
  if (error && "link_types" in update && looksLikeUnknownColumn(error.message)) {
    delete update.link_types;
    ({ data, error } = await supabase.from("milestones").update(update).eq("id", input.id).select("*").single());
  }
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

/** Persist a batch of reflowed date changes ATOMICALLY via the 20260907
 *  RPC — all rows move or none do (a cascading drag used to fire N browser
 *  writes; a mid-batch failure left the schedule half-moved). Falls back to
 *  per-row updates on pre-migration databases. One audit entry per batch. */
export async function applyMilestoneMoves(input: {
  orgId: string;
  projectId: string;
  moves: Array<{ id: string; plannedStartAt: string; plannedAt: string }>;
  actorUserId: string;
  actorUserName?: string;
  actorUserEmail?: string;
  actorUserRole?: string;
}): Promise<void> {
  if (input.moves.length === 0) return;
  const { error } = await supabase.rpc("apply_milestone_moves", {
    p_org: input.orgId,
    p_project: input.projectId,
    p_moves: input.moves.map((m) => ({ id: m.id, start: m.plannedStartAt, finish: m.plannedAt })),
  });
  if (error) {
    // PGRST202 = function not deployed yet — keep working, row by row.
    if (error.code === "PGRST202" || /apply_milestone_moves/.test(error.message ?? "")) {
      await Promise.all(input.moves.map((m) => updateMilestone({
        id: m.id,
        patch: { plannedStartAt: m.plannedStartAt, plannedAt: m.plannedAt },
        updatedBy: input.actorUserId, updatedByName: input.actorUserName,
        updatedByEmail: input.actorUserEmail, updatedByRole: input.actorUserRole,
      })));
      return;
    }
    throw new Error(error.message);
  }
  await supabase.from("audit_logs").insert({
    action: "MILESTONES_RESCHEDULED",
    resource_type: "project", resource_id: input.projectId,
    org_id: input.orgId, user_id: input.actorUserId, user_email: input.actorUserEmail ?? null,
    details: { count: input.moves.length, ids: input.moves.map((m) => m.id).slice(0, 50) },
  }).then(() => undefined, () => undefined);
}

/** Write a bulk field change (lib/bulkEdit.ts plans it): tasks that end up
 *  with the same value are written together, 200 at a time, and the change
 *  is audited once — what field, from what, to what, on which tasks. */
export async function applyBulkFieldChange(input: {
  orgId: string;
  projectId: string;
  field: keyof typeof PATCH_COLUMN;
  changes: Array<{ id: string; after: string | null }>;
  /** For the audit trail: "replace Acme → Gulf Coast" or "set on selection". */
  summary: { mode: "replace" | "set"; from?: string; to: string | null };
  actorUserId: string;
  actorUserEmail?: string;
}): Promise<void> {
  const col = PATCH_COLUMN[input.field];
  if (!col || input.changes.length === 0) return;
  const now = new Date().toISOString();
  const byValue = new Map<string | null, string[]>();
  for (const c of input.changes) byValue.set(c.after, [...(byValue.get(c.after) ?? []), c.id]);
  for (const [value, ids] of byValue) {
    for (let i = 0; i < ids.length; i += 200) {
      const { error } = await supabase.from("milestones")
        .update({ [col]: value, updated_at: now, updated_by: input.actorUserId })
        .in("id", ids.slice(i, i + 200));
      if (error) throw new Error(error.message);
    }
  }
  await supabase.from("audit_logs").insert({
    action: "MILESTONES_BULK_EDITED",
    resource_type: "project", resource_id: input.projectId,
    org_id: input.orgId, user_id: input.actorUserId, user_email: input.actorUserEmail ?? null,
    details: { field: input.field, ...input.summary, count: input.changes.length, ids: input.changes.map((c) => c.id).slice(0, 100) },
  }).then(() => undefined, () => undefined);
}

export interface SetMilestoneStatusInput {
  id: string;
  status: MilestoneStatus;
  /** Why it's blocked / on hold. Omitted on a hold = keep the reason
   *  already recorded; any other status clears it. */
  statusReason?: string;
  /** Free-form breadcrumb note captured with the transition
   *  ("waiting on parts", "contractor no-show"). */
  note?: string;
  /** When the work was really finished (ISO), for a completion recorded
   *  after the fact — so the shift that did it gets the credit. */
  completedAt?: string;
  /** Progress to record with the move to in progress (1–99). */
  percentComplete?: number;
  actorUserId: string;
  actorUserName?: string;
  actorUserEmail?: string;
  actorUserRole?: string;
}

/** A recorded time, never later than now. */
function pastIso(iso: string | undefined, now: string): string {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) && t < Date.parse(now) ? new Date(t).toISOString() : now;
}

const HOLDS: MilestoneStatus[] = ["blocked", "on_hold", "missed"];

/** Transition status. 'completed' stamps actual_at + completer;
 *  first move to 'in_progress' stamps actual_start_at; leaving
 *  'completed' clears actual_at. Every transition drops a breadcrumb
 *  note onto the milestone's activity log. */
export async function setMilestoneStatus(input: SetMilestoneStatusInput): Promise<Milestone> {
  const now = new Date().toISOString();

  // Read current timestamps. actual_start_at is stamped once; first_completed_at
  // is the immutable record of the ORIGINAL completion. actual_at is when it
  // was LAST signed off: a reopen→complete cycle stamps the new sign-off so
  // the shift that really finished it gets the credit.
  const { data: cur } = await supabase
    .from("milestones").select("actual_start_at, first_completed_at, percent_complete, status_reason").eq("id", input.id).maybeSingle();
  const curRow = cur as { actual_start_at: string | null; first_completed_at: string | null; percent_complete: number | null; status_reason: string | null } | null;
  const existingStart = curRow?.actual_start_at ?? null;
  const existingFirstCompleted = curRow?.first_completed_at ?? null;
  const existingPct = curRow?.percent_complete != null ? Math.round(Number(curRow.percent_complete)) : 0;

  const update: Record<string, unknown> = {
    status: input.status,
    // A hold keeps the reason on record unless a new one is given; leaving
    // the hold clears it (a stale "waiting on crane" would read as current).
    status_reason: HOLDS.includes(input.status) ? (input.statusReason?.trim() || curRow?.status_reason || null) : null,
    updated_at: now,
    updated_by: input.actorUserId,
  };
  // Keep percent_complete coherent with the workflow state so the fill bar and
  // earned value can never contradict the status: completed ⇒ 100, planned ⇒ 0,
  // in_progress clamped below 100. blocked/on_hold/missed keep their logged %.
  if (input.status === "completed") {
    update.percent_complete = 100;
    // The sign-off time is now (or when the work really finished); the
    // FIRST completion stays on record in first_completed_at so the history
    // of a reopen is never lost.
    const doneAt = pastIso(input.completedAt, now);
    update.actual_at = doneAt;
    if (!existingFirstCompleted) update.first_completed_at = doneAt;
    update.completed_by = input.actorUserId;
    update.completed_by_name = input.actorUserName ?? null;
    if (!existingStart || Date.parse(existingStart) > Date.parse(doneAt)) update.actual_start_at = doneAt;
  } else if (input.status === "in_progress") {
    const want = input.percentComplete != null && Number.isFinite(input.percentComplete) ? Math.round(input.percentComplete) : existingPct;
    update.percent_complete = Math.min(99, Math.max(0, want));
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
  /** Recording progress takes a blocked / on-hold task off hold (the
   *  person said work is happening). Default: the hold stays. */
  resume?: boolean;
  /** When the work was really finished (ISO), if it reaches 100%. */
  completedAt?: string;
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
  const isException = !input.resume && (prevStatus === "blocked" || prevStatus === "on_hold" || prevStatus === "missed");

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
  if (!HOLDS.includes(nextStatus)) update.status_reason = null;
  if (nextStatus === "completed") {
    const doneAt = pastIso(input.completedAt, now);
    update.actual_at = doneAt;
    if (!existingFirstCompleted) update.first_completed_at = doneAt;
    update.completed_by = input.actorUserId;
    update.completed_by_name = input.actorUserName ?? null;
    if (!existingStart || Date.parse(existingStart) > Date.parse(doneAt)) update.actual_start_at = doneAt;
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

/** Where a task stood: what Undo puts back, exactly. */
export interface MilestoneState {
  id: string;
  status: MilestoneStatus;
  percentComplete: number;
  statusReason?: string | null;
  actualAt?: string | null;
  actualStartAt?: string | null;
  completedBy?: string | null;
  completedByName?: string | null;
}

const isoOrNull = (v: unknown): string | null => {
  const t = v == null ? NaN : v instanceof Date ? v.getTime() : typeof v === "number" ? v : Date.parse(String(v));
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

export const stateOf = (m: Milestone): MilestoneState => ({
  id: m.id!, status: m.status, percentComplete: m.percentComplete ?? 0, statusReason: m.statusReason ?? null,
  actualAt: isoOrNull(m.actualAt), actualStartAt: isoOrNull(m.actualStartAt),
  completedBy: m.completedBy ?? null, completedByName: m.completedByName ?? null,
});

/** Put tasks back exactly as they were (status, %, reason, actual times)
 *  in one write each — Undo. A task someone else changed since is still
 *  restored; the caller only offers Undo for its own most recent change. */
export async function restoreMilestoneStates(states: MilestoneState[], actorUserId: string): Promise<{ failed: string[] }> {
  const now = new Date().toISOString();
  const failed: string[] = [];
  await Promise.all(states.map(async (st) => {
    const { error } = await supabase.from("milestones").update({
      status: st.status, percent_complete: st.percentComplete, status_reason: st.statusReason ?? null,
      actual_at: st.actualAt ?? null, actual_start_at: st.actualStartAt ?? null,
      completed_by: st.completedBy ?? null, completed_by_name: st.completedByName ?? null,
      updated_at: now, updated_by: actorUserId,
    }).eq("id", st.id);
    if (error) failed.push(st.id);
  }));
  return { failed };
}

/** Correct when work really started / finished — a night-shift completion
 *  entered next morning belongs to the night shift. Times can't be in the
 *  future, and a finish can't come before the start. */
export async function setActualTimes(input: {
  id: string; actualStartAt?: string | null; actualAt?: string | null; actorUserId: string; actorUserName?: string;
}): Promise<Milestone> {
  const now = Date.now();
  const ms = (v?: string | null) => (v ? Date.parse(v) : NaN);
  // Check the pair as it will be stored: a new start against the finish
  // already recorded, and the other way round.
  const { data: cur } = await supabase.from("milestones").select("actual_start_at, actual_at").eq("id", input.id).maybeSingle();
  const stored = cur as { actual_start_at: string | null; actual_at: string | null } | null;
  const s = ms(input.actualStartAt !== undefined ? input.actualStartAt : stored?.actual_start_at);
  const f = ms(input.actualAt !== undefined ? input.actualAt : stored?.actual_at);
  if ((Number.isFinite(s) && s > now) || (Number.isFinite(f) && f > now)) throw new Error("An actual time can't be in the future.");
  if (Number.isFinite(s) && Number.isFinite(f) && f < s) throw new Error("Finish can't be before start.");
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString(), updated_by: input.actorUserId };
  if (input.actualStartAt !== undefined) patch.actual_start_at = input.actualStartAt;
  if (input.actualAt !== undefined) patch.actual_at = input.actualAt;
  const { data, error } = await supabase.from("milestones").update(patch).eq("id", input.id).select("*").single();
  if (error || !data) throw new Error(error?.message ?? "Couldn't save the actual times");
  const m = rowToMilestone(data as MilestoneRow);
  await addMilestoneNote({
    orgId: m.orgId, milestoneId: m.id!, kind: "status", statusAt: m.status,
    body: `Actual times corrected${input.actualStartAt !== undefined ? ` · started ${input.actualStartAt ? new Date(input.actualStartAt).toISOString() : "—"}` : ""}${input.actualAt !== undefined ? ` · finished ${input.actualAt ? new Date(input.actualAt).toISOString() : "—"}` : ""}`,
    createdBy: input.actorUserId, createdByName: input.actorUserName,
  }).catch(() => undefined);
  return m;
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

/** The latest comment on each step (kind "note" — not status or
 *  reschedule breadcrumbs), for the shift report: "sent out for
 *  calibration" says why a step reads the way it does. */
export async function latestNotes(milestoneIds: string[]): Promise<Map<string, { id: string; body: string; at: string | null; by: string | null; byId: string | null }>> {
  const out = new Map<string, { id: string; body: string; at: string | null; by: string | null; byId: string | null }>();
  for (let i = 0; i < milestoneIds.length; i += 200) {
    const chunk = milestoneIds.slice(i, i + 200);
    const { rows: data, error } = await fetchAllRows<unknown>((from, to) => supabase.from("milestone_notes")
      .select("id, milestone_id, body, created_at, created_by, created_by_name")
      .in("milestone_id", chunk).eq("kind", "note")
      .order("created_at", { ascending: false }).order("id").range(from, to));
    if (error) continue;
    for (const r of (data ?? []) as Array<{ id: string; milestone_id: string; body: string | null; created_at: string | null; created_by: string | null; created_by_name: string | null }>) {
      if (!r.body || out.has(r.milestone_id)) continue;
      out.set(r.milestone_id, { id: r.id, body: r.body, at: r.created_at, by: r.created_by_name, byId: r.created_by });
    }
  }
  return out;
}

/** Fix a comment's wording. */
export async function updateMilestoneNote(id: string, body: string): Promise<void> {
  const text = body.trim();
  if (!text) throw new Error("A comment can't be empty — delete it instead.");
  const { data, error } = await supabase.from("milestone_notes").update({ body: text }).eq("id", id).select("id");
  if (error) throw new Error(error.message);
  if (!data || data.length === 0) throw new Error("That comment couldn't be changed.");
}

/** Remove a comment. */
export async function deleteMilestoneNote(id: string): Promise<void> {
  const { data, error } = await supabase.from("milestone_notes").delete().eq("id", id).select("id");
  if (error) throw new Error(error.message);
  if (!data || data.length === 0) throw new Error("That comment couldn't be deleted.");
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

  const { data: gone, error: delErr } = await supabase.from("milestones").delete().eq("id", id).select("id");
  if (delErr) throw new Error(delErr.message);
  if (!gone || gone.length === 0) throw new Error("This task wasn't deleted — you may not have permission to delete it on this project.");

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

/** What a delete removed — enough to put it all back (Undo). */
export interface DeletedTasks {
  rows: MilestoneRow[]; notes: MilestoneNoteRow[]; orphans: Array<{ id: string; parentId: string }>;
  /** Tasks the database refused to delete (permissions) — still there. */
  notDeleted?: number;
}

/** Delete tasks — with everything under them when `withChildren` — and
 *  hand back what was removed so Undo can restore it, comments included.
 *  Steps left behind under a deleted parent move up to its parent. */
export async function deleteMilestones(input: {
  orgId: string; projectId: string; ids: string[]; withChildren: boolean;
  actorUserId: string; actorUserEmail?: string;
}): Promise<DeletedTasks> {
  const { rows: all, error: loadErr } = await fetchAllRows<MilestoneRow>((from, to) => supabase.from("milestones").select("*")
    .eq("org_id", input.orgId).eq("project_id", input.projectId).order("id").range(from, to));
  if (loadErr) throw new Error(loadErr);
  const byParent = new Map<string, MilestoneRow[]>();
  for (const r of all) if (r.parent_id) byParent.set(r.parent_id, [...(byParent.get(r.parent_id) ?? []), r]);
  const kill = new Set<string>();
  const add = (id: string) => {
    if (kill.has(id)) return;
    kill.add(id);
    if (input.withChildren) for (const c of byParent.get(id) ?? []) add(c.id);
  };
  input.ids.forEach(add);
  const rows = all.filter((r) => kill.has(r.id));
  const parentOf = new Map(all.map((r) => [r.id, r.parent_id]));
  const orphans: Array<{ id: string; parentId: string }> = [];
  for (const r of all) {
    if (kill.has(r.id) || !r.parent_id || !kill.has(r.parent_id)) continue;
    orphans.push({ id: r.id, parentId: r.parent_id });
    let up = parentOf.get(r.parent_id) ?? null;
    while (up && kill.has(up)) up = parentOf.get(up) ?? null;
    const { error } = await supabase.from("milestones").update({ parent_id: up }).eq("id", r.id);
    if (error) throw new Error(error.message);
  }
  const ids = [...kill];
  const notes: MilestoneNoteRow[] = [];
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const { rows: n } = await fetchAllRows<MilestoneNoteRow>((from, to) => supabase.from("milestone_notes").select("*").in("milestone_id", chunk).order("id").range(from, to));
    notes.push(...n);
  }
  const gone = new Set<string>();
  let failure: string | null = null;
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await supabase.from("milestones").delete().in("id", ids.slice(i, i + 200)).select("id");
    if (error) { failure = error.message; break; }
    for (const r of (data ?? []) as Array<{ id: string }>) gone.add(r.id);
  }
  // Steps moved up from under a parent that is still there go back under it.
  for (const o of orphans) {
    if (!gone.has(o.parentId)) await supabase.from("milestones").update({ parent_id: o.parentId }).eq("id", o.id);
  }
  if (gone.size === 0) {
    throw new Error(failure ?? "Nothing was deleted — you may not have permission to delete tasks on this project.");
  }
  await logAuditAction({
    action: "MILESTONES_DELETED", resourceType: "project", resourceId: input.projectId,
    orgId: input.orgId, userId: input.actorUserId, userEmail: input.actorUserEmail,
    details: { count: gone.size, names: rows.filter((r) => gone.has(r.id)).slice(0, 50).map((r) => r.name) },
  }).catch(() => undefined);
  // What was really removed — all of it can be put back with Undo, even
  // when some tasks were refused.
  return {
    rows: rows.filter((r) => gone.has(r.id)),
    notes: notes.filter((n) => gone.has(n.milestone_id)),
    orphans: orphans.filter((o) => gone.has(o.parentId)),
    notDeleted: ids.length - gone.size,
  };
}

/** Undo a delete: the tasks come back with their ids, comments and links. */
export async function restoreDeletedMilestones(d: DeletedTasks): Promise<void> {
  // Parents before children, so parent_id always points at a row.
  const ids = new Set(d.rows.map((r) => r.id));
  const ordered: MilestoneRow[] = [];
  const placed = new Set<string>();
  const place = (r: MilestoneRow, guard = 0) => {
    if (placed.has(r.id) || guard > 50) return;
    if (r.parent_id && ids.has(r.parent_id) && !placed.has(r.parent_id)) {
      const p = d.rows.find((x) => x.id === r.parent_id);
      if (p) place(p, guard + 1);
    }
    placed.add(r.id); ordered.push(r);
  };
  d.rows.forEach((r) => place(r));
  for (let i = 0; i < ordered.length; i += 200) {
    const { error } = await supabase.from("milestones").insert(ordered.slice(i, i + 200));
    if (error) throw new Error(error.message);
  }
  for (const o of d.orphans) await supabase.from("milestones").update({ parent_id: o.parentId }).eq("id", o.id);
  for (let i = 0; i < d.notes.length; i += 200) {
    await supabase.from("milestone_notes").insert(d.notes.slice(i, i + 200));
  }
}

/** Delete EVERY milestone on a project (notes cascade with them) so the
 *  schedule can be rebuilt from a fresh import. Audited with the count.
 *  Irreversible — callers confirm first. */
export async function clearProjectSchedule(input: {
  orgId: string; projectId: string;
  actorUserId: string; actorUserEmail?: string; actorUserRole?: string;
}): Promise<{ deleted: number }> {
  const { count, error: countErr } = await supabase
    .from("milestones")
    .select("id", { count: "exact", head: true })
    .eq("org_id", input.orgId)
    .eq("project_id", input.projectId);
  if (countErr) throw new Error(countErr.message);
  const deleted = count ?? 0;
  if (deleted === 0) return { deleted: 0 };
  const { error } = await supabase
    .from("milestones")
    .delete()
    .eq("org_id", input.orgId)
    .eq("project_id", input.projectId);
  if (error) throw new Error(error.message);
  await logAuditAction({
    action: "SCHEDULE_CLEARED",
    resourceId: input.projectId, resourceType: "project",
    orgId: input.orgId, userId: input.actorUserId,
    userEmail: input.actorUserEmail, userRole: input.actorUserRole,
    details: { deleted },
  });
  return { deleted };
}

/** Put every task on a project back to "not started" so the real run
 *  starts clean after a rehearsal: 0 %, status planned, and the actual
 *  start / completion stamps cleared (the first-completion stamp is
 *  sticky, so a test completion would otherwise date a real one). Planned
 *  dates, dependencies and free-text notes stay; the status-change notes
 *  written during the rehearsal are removed. The plan as it stands at
 *  this moment becomes the baseline the report measures against — this
 *  is the "go-live" button. */
export async function resetProjectProgress(input: {
  orgId: string; projectId: string;
  actorUserId: string; actorUserEmail?: string; actorUserRole?: string;
}): Promise<{ reset: number }> {
  const { rows, error: loadErr } = await fetchAllRows<{ id: string }>((from, to) => supabase
    .from("milestones").select("id").eq("org_id", input.orgId).eq("project_id", input.projectId).order("id").range(from, to));
  if (loadErr) throw new Error(loadErr);
  const ids = rows.map((r) => r.id);
  if (ids.length === 0) return { reset: 0 };
  const { error } = await supabase
    .from("milestones")
    .update({
      percent_complete: 0,
      status: "planned",
      status_reason: null,
      actual_at: null,
      actual_start_at: null,
      first_completed_at: null,
      completed_by: null,
      completed_by_name: null,
      updated_at: new Date().toISOString(),
      updated_by: input.actorUserId,
    })
    .eq("org_id", input.orgId)
    .eq("project_id", input.projectId);
  if (error) throw new Error(error.message);
  // Status-change notes from the rehearsal would read as history; drop them.
  for (let i = 0; i < ids.length; i += 200) {
    await supabase.from("milestone_notes").delete().eq("kind", "status").in("milestone_id", ids.slice(i, i + 200));
  }
  await logAuditAction({
    action: "SCHEDULE_PROGRESS_RESET",
    resourceId: input.projectId, resourceType: "project",
    orgId: input.orgId, userId: input.actorUserId,
    userEmail: input.actorUserEmail, userRole: input.actorUserRole,
    details: { reset: ids.length },
  });
  await setBaseline({ orgId: input.orgId, projectId: input.projectId, actorUserId: input.actorUserId, actorUserEmail: input.actorUserEmail, actorUserRole: input.actorUserRole });
  return { reset: ids.length };
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
  // Every row: a schedule past 1,000 tasks must not lose its last ones.
  const { rows, error } = await fetchAllRows<MilestoneRow>((from, to) => {
    let q = supabase.from("milestones").select("*").eq("org_id", orgId);
    if (projectId) q = q.eq("project_id", projectId);
    if (documentId) q = q.eq("document_id", documentId);
    if (!includeGhost) q = q.eq("source", "manual");
    return q.order("planned_at", { ascending: true }).order("id").range(from, to);
  });
  if (error) throw new Error(error);
  return rows.map(rowToMilestone);
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
    // Milestone-style earned value: each row counts by its own hours or
    // weight (not its window's length).
    const w = effectiveWeight({ weight: m.weight, durationHours: m.durationHours });
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
  /** Rows this import created (Undo removes them). */
  insertedIds?: string[];
}

/** The whole schedule of a project as stored — taken just before an
 *  import so the import can be undone exactly. */
export interface ScheduleSnapshot { rows: MilestoneRow[]; notes: MilestoneNoteRow[] }

export async function snapshotSchedule(orgId: string, projectId: string): Promise<ScheduleSnapshot> {
  const { rows, error } = await fetchAllRows<MilestoneRow>((from, to) => supabase.from("milestones").select("*")
    .eq("org_id", orgId).eq("project_id", projectId).order("id").range(from, to));
  if (error) throw new Error(`Couldn't take a copy of the schedule first: ${error}`);
  const notes: MilestoneNoteRow[] = [];
  const ids = rows.map((r) => r.id);
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const { rows: n } = await fetchAllRows<MilestoneNoteRow>((from, to) => supabase.from("milestone_notes").select("*").in("milestone_id", chunk).order("id").range(from, to));
    notes.push(...n);
  }
  return { rows, notes };
}

/** Put the schedule back as it was before an import. A merge is undone in
 *  place — the new rows removed, the updated ones written back — so the
 *  tasks keep their ids, comments and progress history. A replace (which
 *  deleted everything first) brings the old tasks back with their
 *  comments. */
export async function undoImport(input: {
  orgId: string; projectId: string; snapshot: ScheduleSnapshot; insertedIds: string[]; replaced: boolean;
  actorUserId: string; actorUserEmail?: string;
}): Promise<void> {
  const { snapshot } = input;
  // Remove what the import added.
  const added = input.replaced
    ? (await fetchAllRows<{ id: string }>((from, to) => supabase.from("milestones").select("id")
        .eq("org_id", input.orgId).eq("project_id", input.projectId).order("id").range(from, to))).rows.map((r) => r.id)
    : input.insertedIds;
  const old = new Set(snapshot.rows.map((r) => r.id));
  const drop = input.replaced ? added : added.filter((id) => !old.has(id));
  for (let i = 0; i < drop.length; i += 200) {
    const { error } = await supabase.from("milestones").delete().in("id", drop.slice(i, i + 200));
    if (error) throw new Error(error.message);
  }
  if (input.replaced) {
    await restoreDeletedMilestones({ rows: snapshot.rows, notes: snapshot.notes, orphans: [] });
  } else {
    // Write every pre-import row back as it was (parents first is not
    // needed: they all still exist).
    for (const r of snapshot.rows) {
      const { id, created_at: _c, ...rest } = r as MilestoneRow & { created_at?: string };
      void _c;
      const { error } = await supabase.from("milestones").update(rest).eq("id", id);
      if (error) throw new Error(error.message);
    }
  }
  await logAuditAction({
    action: "SCHEDULE_IMPORT_UNDONE", resourceType: "project", resourceId: input.projectId,
    orgId: input.orgId, userId: input.actorUserId, userEmail: input.actorUserEmail,
    details: { removed: drop.length, restored: snapshot.rows.length, replaced: input.replaced },
  }).catch(() => undefined);
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
  /** Link type and lag per predecessor externalRef (missing = finish-to-start). */
  linksByRef?: Record<string, { type: "FS" | "SS" | "FF" | "SF"; lagHours: number }>;
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
  /** The project's zone: bare dates and naive times in the rows are
   *  plant wall-clock time. Omitted = UTC. */
  timeZone?: string | null;
  /** The file IS the plan of record (a fresh or replace import): baseline
   *  every row from it afterwards. Otherwise only rows that are new to the
   *  project get a baseline, and only when the project already has one. */
  baselineAll?: boolean;
}

/** Bare "2026-08-15" / naive "2026-08-15 08:00" → plant time; anything
 *  with its own offset is kept. Unparseable input passes through so the
 *  database rejects it with a clear error. */
function coerceIsoMaybe(s: string | null | undefined, tz: string): string | null {
  if (!s) return null;
  const trimmed = s.trim();
  if (!trimmed) return null;
  return naiveToIso(trimmed, tz) ?? trimmed;
}

/** Heuristic shift assignment based on a planned start hour at the plant.
 *  6am-6pm → day, 6pm-6am → night. Null until plannedStartAt is known. */

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
  const insertedIds: string[] = [];
  const tz = normalizeTimeZone(input.timeZone ?? DEFAULT_SCHEDULE_TZ);
  const nowIso = new Date().toISOString();

  // Earlier imports wrote MS Project's project-summary row (UID 0, the
  // file's title) as a childless task spanning the whole schedule. The
  // parser no longer emits it; drop a leftover one on re-import so the
  // calendar stops carrying it on every day.
  if (input.projectId && !input.rows.some((r) => r.externalRef === "msp-uid:0")) {
    const { error: cleanupErr } = await supabase
      .from("milestones")
      .delete()
      .eq("org_id", input.orgId)
      .eq("project_id", input.projectId)
      .eq("external_ref", "msp-uid:0");
    if (cleanupErr) result.errors.push(`Couldn't remove the old project-summary row: ${cleanupErr.message}`);
  }

  // Files without an id column used to be keyed by line number
  // ("csv-row:12"); they're now keyed by outline path and name
  // ("csv-key:e-12 › pull bundle"). On the first re-import after that
  // change, match the old rows by name so nothing is duplicated, and move
  // them onto the new key.
  // Old rows are matched by the same key the file's rows now carry — their
  // outline path of names (or WBS), and which repeat of it they are, in
  // file order — so two "Pull bundle" steps under different exchangers
  // each find their own row.
  const legacyByKey = new Map<string, string[]>();
  if (input.projectId && input.rows.some((r) => /-key:/.test(r.externalRef ?? ""))) {
    const { rows: all } = await fetchAllRows<{ id: string; name: string; parent_id: string | null; external_ref: string | null; wbs: string | null }>((from, to) => supabase
      .from("milestones").select("id, name, parent_id, external_ref, wbs").eq("org_id", input.orgId).eq("project_id", input.projectId!)
      .order("id").range(from, to));
    const byId = new Map(all.map((r) => [r.id, r]));
    const norm = (x: string) => x.trim().replace(/\s+/g, " ").toLowerCase();
    const pathOf = (r: { name: string; parent_id: string | null }) => {
      const names: string[] = [];
      const seen = new Set<string>();
      for (let cur: typeof r | undefined = r; cur; cur = cur.parent_id && !seen.has(cur.parent_id) ? byId.get(cur.parent_id) : undefined) {
        if (cur.parent_id) seen.add(cur.parent_id);
        names.unshift(norm(cur.name));
      }
      return names.join(" › ");
    };
    const lineOf = (ref: string) => Number(ref.match(/-row:(\d+)$/)?.[1] ?? Infinity);
    const legacy = all.filter((r) => /-row:\d+$/.test(r.external_ref ?? "")).sort((a, b) => lineOf(a.external_ref!) - lineOf(b.external_ref!));
    for (const o of legacy) {
      for (const k of [pathOf(o), o.wbs ? `wbs ${norm(o.wbs)}` : null]) {
        if (k) legacyByKey.set(k, [...(legacyByKey.get(k) ?? []), o.id]);
      }
    }
  }
  const takenLegacy = new Set<string>();

  for (let i = 0; i < input.rows.length; i++) {
    const r = input.rows[i];
    const name = r.name?.trim();
    if (!name) { result.skipped++; continue; }
    const planned = r.plannedAt?.trim();
    if (!planned) { result.skipped++; continue; }
    const plannedIso = coerceIsoMaybe(planned, tz)!;
    const plannedStartIso = coerceIsoMaybe(r.plannedStartAt ?? null, tz);
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
      // Which crew does a step is read from its times against the project's
      // shift-change times when it's used (lib/shiftReport workShiftOf) — a
      // guess stored here (from a fixed 6:00–18:00 day) went stale and
      // mislabelled 5:30 starts as night work.
      baseFields.shift = null;
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
          .select("id, status, percent_complete, actual_at, actual_start_at, description, work_order_ref, responsible_party, responsible_kind, responsible_org, location, attributes")
          .eq("org_id", input.orgId)
          .eq("source", input.source)
          .eq("external_ref", r.externalRef);
        if (input.projectId) q = q.eq("project_id", input.projectId);
        else if (input.documentId) q = q.eq("document_id", input.documentId);
        else q = q.is("project_id", null).is("document_id", null);
        let { data: existing } = await q.maybeSingle();
        if (!existing && legacyByKey.size > 0) {
          // "csv-key:e-12 › pull bundle #2" → the 2nd old row on that path.
          const m = (r.externalRef ?? "").match(/-key:(.*?)(?:\u241F(\d+))?$/);
          const ids = m ? legacyByKey.get(m[1]) ?? [] : [];
          const oldId = ids[(m?.[2] ? Number(m[2]) : 1) - 1];
          if (oldId && !takenLegacy.has(oldId)) {
            takenLegacy.add(oldId);
            await supabase.from("milestones").update({ external_ref: r.externalRef }).eq("id", oldId);
            ({ data: existing } = await supabase.from("milestones")
              .select("id, status, percent_complete, actual_at, actual_start_at, description, work_order_ref, responsible_party, responsible_kind, responsible_org, location, attributes")
              .eq("id", oldId).maybeSingle());
          }
        }
        if (existing) {
          const ex = existing as { id: string; status: MilestoneStatus | null; percent_complete: number | null; actual_at: string | null; actual_start_at: string | null } & Record<string, unknown>;
          const id = ex.id;
          refToId.set(r.externalRef, id);
          // A re-import refreshes the PLAN (dates, names, hierarchy, hours)
          // but never takes progress away: what the crew recorded on the
          // floor is the truth, the file can only raise it. The baseline
          // is untouched here too — that is the yardstick.
          const planFields = { ...baseFields };
          delete planFields.status; delete planFields.percent_complete;
          delete planFields.actual_at; delete planFields.actual_start_at;
          // Who / where / why is kept as people set it in the app (a
          // contractor swapped, a crew set to nights): the file only fills
          // what's blank. The crew override is never touched.
          delete planFields.shift;
          for (const k of ["description", "work_order_ref", "responsible_party", "responsible_kind", "responsible_org", "location"]) {
            const cur = ex[k];
            if ((typeof cur === "string" && cur.trim() !== "") || planFields[k] == null) delete planFields[k];
          }
          if (planFields.attributes) {
            const cur = (ex.attributes ?? {}) as Record<string, unknown>;
            const file = planFields.attributes as Record<string, unknown>;
            planFields.attributes = { ...file, ...cur };
            // The working calendar is the schedule's — always the file's.
            for (const k of ["work_calendar", "work_hours", "ms_critical"]) {
              if (file[k] != null) (planFields.attributes as Record<string, unknown>)[k] = file[k];
            }
          }
          const progressPatch = mergeImportedProgress({
            status: ex.status ?? "planned",
            percent: ex.percent_complete != null ? Number(ex.percent_complete) : 0,
            actualAt: ex.actual_at, actualStartAt: ex.actual_start_at,
          }, r.percentComplete, nowIso) ?? {};
          let updateRes = await supabase.from("milestones").update({
            ...planFields,
            ...progressPatch,
            updated_at: nowIso,
            updated_by: input.createdBy,
          }).eq("id", id);
          if (updateRes.error && looksLikeUnknownColumn(updateRes.error.message)) {
            degradeToLegacy = true;
            const legacyFields: Record<string, unknown> = { ...planFields, ...progressPatch };
            for (const f of NEW_SCHEMA_FIELDS) delete legacyFields[f];
            updateRes = await supabase.from("milestones").update({
              ...legacyFields,
              updated_at: nowIso,
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
      if (insertRes.data) {
        const newId = (insertRes.data as { id: string }).id;
        insertedIds.push(newId);
        if (r.externalRef) refToId.set(r.externalRef, newId);
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
    // Link types (start-to-start, lags…) come along keyed by predecessor.
    const depUpdates: Array<{ id: string; depends_on: string[]; link_types: Record<string, { type: "FS" | "SS" | "FF" | "SF"; lagHours: number }> | null }> = [];
    for (const r of input.rows) {
      if (!r.externalRef || !r.dependsOnExternalRefs?.length) continue;
      const id = refToId.get(r.externalRef);
      if (!id) continue;
      const predIds: string[] = [];
      const links: Record<string, { type: "FS" | "SS" | "FF" | "SF"; lagHours: number }> = {};
      for (const ref of r.dependsOnExternalRefs) {
        const pid = refToId.get(ref);
        if (!pid || pid === id) continue;
        predIds.push(pid);
        const l = r.linksByRef?.[ref];
        if (l && (l.type !== "FS" || l.lagHours)) links[pid] = l;
      }
      if (predIds.length > 0) depUpdates.push({ id, depends_on: predIds, link_types: Object.keys(links).length ? links : null });
    }
    if (depUpdates.length > 0) {
      await Promise.all(depUpdates.map(async (u) => {
        let res = await supabase.from("milestones").update({ depends_on: u.depends_on, link_types: u.link_types }).eq("id", u.id);
        if (res.error && looksLikeUnknownColumn(res.error.message)) {
          // No link_types column yet: keep the links as finish-to-start.
          res = await supabase.from("milestones").update({ depends_on: u.depends_on }).eq("id", u.id);
        }
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

  // Pass 4: the yardstick. A replace / first import makes the file the plan
  // of record, so every row is baselined. A refresh import leaves existing
  // baselines alone and only gives the NEW rows one (at their imported
  // dates) when the project is already baselined — otherwise they would
  // never count in "where the plan said we'd be".
  if (input.projectId && !degradeToLegacy) {
    try {
      if (input.baselineAll) {
        await setBaseline({ orgId: input.orgId, projectId: input.projectId, actorUserId: input.createdBy });
      } else if (insertedIds.length > 0) {
        const { data: anyBase } = await supabase
          .from("milestones").select("id")
          .eq("org_id", input.orgId).eq("project_id", input.projectId)
          .not("baseline_set_at", "is", null).limit(1);
        if (anyBase && anyBase.length > 0) {
          for (let i = 0; i < insertedIds.length; i += 200) {
            const { data: fresh } = await supabase
              .from("milestones").select("id, planned_at, planned_start_at").in("id", insertedIds.slice(i, i + 200));
            await Promise.all(((fresh ?? []) as Array<{ id: string; planned_at: string; planned_start_at: string | null }>).map((r) =>
              supabase.from("milestones").update({
                baseline_start_at: r.planned_start_at ?? r.planned_at,
                baseline_finish_at: r.planned_at,
                baseline_set_at: nowIso,
                baseline_set_by: input.createdBy,
              }).eq("id", r.id)));
          }
        }
      }
    } catch (e) {
      result.errors.push(`Baseline: ${(e as Error).message}`);
    }
  }

  result.insertedIds = insertedIds;
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
  /** The shifted dates are the new plan of record: re-capture the
   *  baseline afterwards so the report measures against them. */
  resetBaseline?: boolean;
  /** The plant's zone: the shift moves tasks by calendar days there, so
   *  a 6:00 start stays 6:00 across a daylight-saving change. */
  timeZone?: string;
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

// ─── PROJECT TIMEZONE CHANGE ─────────────────────────────────────────
// When a project's zone changes, the schedule's written times should
// survive: a task the team knows as "Oct 14, 8:00" must still read
// 8:00 at the plant afterwards. Each planned/baseline instant is
// re-anchored so its wall clock in the OLD zone becomes the same wall
// clock in the NEW zone. Actual dates are history (real instants) and
// are left alone.

export async function shiftScheduleTimeZone(input: {
  orgId: string; projectId: string; fromTimeZone: string; toTimeZone: string;
}): Promise<{ shiftedCount: number; errors: string[] }> {
  const from = normalizeTimeZone(input.fromTimeZone), to = normalizeTimeZone(input.toTimeZone);
  if (from === to) return { shiftedCount: 0, errors: [] };
  const errors: string[] = [];
  const cols = ["planned_at", "planned_start_at", "baseline_start_at", "baseline_finish_at"] as const;
  const { rows, error } = await fetchAllRows<Record<string, string | null> & { id: string }>((from, to) => supabase
    .from("milestones")
    .select("id, planned_at, planned_start_at, baseline_start_at, baseline_finish_at")
    .eq("org_id", input.orgId)
    .eq("project_id", input.projectId).order("id").range(from, to));
  if (error) return { shiftedCount: 0, errors: [`Couldn't load milestones: ${error}`] };
  let shiftedCount = 0;
  const updatedAt = new Date().toISOString();
  for (const raw of (rows ?? []) as Array<Record<string, string | null> & { id: string }>) {
    const patch: Record<string, string> = {};
    for (const c of cols) {
      const v = raw[c];
      if (!v) continue;
      const moved = shiftWallClock(v, from, to);
      if (moved !== v) patch[c] = moved;
    }
    if (Object.keys(patch).length === 0) continue;
    patch.updated_at = updatedAt;
    const { error: upErr } = await supabase.from("milestones").update(patch).eq("id", raw.id);
    if (upErr) errors.push(`${raw.id.slice(0, 8)}: ${upErr.message}`);
    else shiftedCount++;
  }
  return { shiftedCount, errors };
}

export async function rebaseSchedule(input: RebaseScheduleInput): Promise<RebaseResult> {
  const errors: string[] = [];
  // 1. Load the current schedule so we can find the earliest anchor.
  const { rows, error: loadErr } = await fetchAllRows<{ id: string; planned_at: string; planned_start_at: string | null; actual_at: string | null; actual_start_at: string | null; updated_at: string | null }>((from, to) => supabase
    .from("milestones")
    .select("id, planned_at, planned_start_at, actual_at, actual_start_at, updated_at")
    .eq("org_id", input.orgId)
    .eq("project_id", input.projectId).order("id").range(from, to));
  if (loadErr) {
    errors.push(`Couldn't load milestones: ${loadErr}`);
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
  // Whole days by the plant's calendar, then any leftover clock time.
  const rtz = normalizeTimeZone(input.timeZone ?? DEFAULT_SCHEDULE_TZ);
  const wholeDays = dayDiff(earliestMs, newAnchorMs, rtz);
  const leftover = newAnchorMs - addDays(earliestMs, wholeDays, rtz);
  const moveMs = (iso: string) => new Date(addDays(new Date(iso).getTime(), wholeDays, rtz) + leftover).toISOString();

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
  for (const raw of rows) {
    const patch: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
      updated_by: input.actorUserId,
    };
    if (raw.planned_at) patch.planned_at = moveMs(raw.planned_at);
    if (raw.planned_start_at) patch.planned_start_at = moveMs(raw.planned_start_at);
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
      resetBaseline: !!input.resetBaseline,
    },
  });

  if (input.resetBaseline && shifted > 0) {
    const b = await setBaseline({ orgId: input.orgId, projectId: input.projectId, actorUserId: input.actorUserId, actorUserEmail: input.actorUserEmail, actorUserRole: input.actorUserRole });
    if (!b.ok && b.error) errors.push(`Baseline: ${b.error}`);
  }

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

/** Set a task's length, keeping its finish. A task with clock times
 *  takes `hours` (or `days` × 24); a date-only task spans `days` calendar
 *  days, inclusive, in the plant's zone. */
export async function setTaskDuration(input: {
  id: string;
  days?: number;
  hours?: number;
  timeZone?: string;
  actorUserId: string;
}): Promise<{ ok: boolean; error?: string }> {
  const hours = input.hours ?? (input.days != null ? input.days * 24 : NaN);
  if (!(hours > 0)) return { ok: false, error: "Duration must be more than zero." };
  const dtz = normalizeTimeZone(input.timeZone ?? DEFAULT_SCHEDULE_TZ);
  const { data: row, error: readErr } = await supabase
    .from("milestones")
    .select("planned_at, project_id, parent_id")
    .eq("id", input.id)
    .maybeSingle();
  if (readErr || !row) return { ok: false, error: readErr?.message ?? "Task not found" };
  const r = row as { planned_at: string; project_id: string | null; parent_id: string | null };
  const finishMs = Date.parse(r.planned_at);
  if (!Number.isFinite(finishMs)) return { ok: false, error: "Task has no valid finish date." };
  const timed = hasTimeOfDay(finishMs, dtz) || input.hours != null;
  const newStartIso = new Date(timed
    ? finishMs - hours * 3600000
    : addDays(finishMs, -(Math.max(1, Math.round(hours / 24)) - 1), dtz)).toISOString();
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
      const { rows } = await fetchAllRows<{ id: string; parent_id: string | null; planned_start_at: string | null; planned_at: string }>((from, to) => supabase
        .from("milestones")
        .select("id, parent_id, planned_start_at, planned_at")
        .eq("project_id", r.project_id!).order("id").range(from, to));
      if (rows.length) {
        const nodes: ReflowNode[] = rows
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
  const { rows, error } = await fetchAllRows<{ id: string; planned_at: string; planned_start_at: string | null }>((from, to) => supabase
    .from("milestones")
    .select("id, planned_at, planned_start_at")
    .eq("org_id", input.orgId)
    .eq("project_id", input.projectId).order("id").range(from, to));
  if (error) return { ok: false, count: 0, error };
  if (!rows || rows.length === 0) return { ok: false, count: 0, error: "No tasks to baseline." };

  const now = new Date().toISOString();
  let count = 0;
  const errors: string[] = [];
  await Promise.all(rows.map(async (r) => {
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
