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
import { shiftForStart, shiftAfterMove } from "@/lib/scheduleFilter";
import { SCHEDULE_IMPORT_LIMITS } from "@/lib/scheduleParsers";
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

  // Snapshot the prior finish so we can log a human reschedule note, and the
  // stored shift + start so a date move can re-label it.
  let priorFinish: string | null = null;
  let priorShift: string | null = null;
  let priorStart: string | null = null;
  if ("plannedAt" in input.patch || "plannedStartAt" in input.patch) {
    const { data: before } = await supabase.from("milestones").select("planned_at, planned_start_at, shift").eq("id", input.id).maybeSingle();
    priorFinish = (before as { planned_at: string } | null)?.planned_at ?? null;
    priorStart = (before as { planned_start_at: string | null } | null)?.planned_start_at ?? null;
    priorShift = (before as { shift: string | null } | null)?.shift ?? null;
  }
  // Shift follows the task (PC SCHED-9): a day / night label whose start
  // moves into the other band is re-labelled — the RPC's rule, one helper.
  // An explicit shift in the same patch wins; an unlabelled row, a hand-set
  // "swing" and a move within the band keep what is stored.
  if ("plannedStartAt" in input.patch && !("shift" in input.patch) && typeof update.planned_start_at === "string") {
    const next = shiftAfterMove(priorShift, priorStart, update.planned_start_at);
    if (next !== priorShift) update.shift = next;
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

export interface MoveBatchResult {
  /** Ids the database changed. */
  matched: string[];
  /** Ids whose row was edited by someone else since the caller loaded it
   *  (expected updated_at no longer matches) — refresh and tell the user. */
  unmatched: string[];
  /** True count of rows changed (the RPC's ROW_COUNT, not the request size). */
  count: number;
  /** "rpc" via apply_milestone_moves; "rows" on a pre-migration database. */
  via: "rpc" | "rows";
  /** The batch audit row or the per-row breadcrumbs could not be written. */
  auditError?: string;
}

/** Thrown by applyMilestoneMoves (by default) when the optimistic lock
 *  rejected some moves: the caller's optimistic dates for those rows were
 *  never saved, so a silent success would leave the board showing them. The
 *  moves that matched ARE saved (breadcrumbs and audit written); `result`
 *  carries both lists. */
export class MoveConflictError extends Error {
  readonly result: MoveBatchResult;
  constructor(result: MoveBatchResult) {
    const n = result.unmatched.length;
    const moved = result.matched.length;
    super(`${n} task${n === 1 ? " was" : "s were"} changed by someone else and ${n === 1 ? "was" : "were"} not moved${moved > 0 ? ` (the other ${moved} moved)` : ""}. Reload the schedule and try again.${result.auditError ? ` Also: ${result.auditError}.` : ""}`);
    this.name = "MoveConflictError";
    this.result = result;
  }
}

/** Persist a batch of reflowed date changes ATOMICALLY via the
 *  apply_milestone_moves RPC (20260907, re-created in 20261098) — all rows
 *  move or none do (a cascading drag used to fire N browser writes; a
 *  mid-batch failure left the schedule half-moved). Falls back to per-row
 *  updates on pre-migration databases.
 *
 *  Each move carries the row's expected updated_at (the caller's loaded
 *  value, or the row as read just before the call): a row edited by someone
 *  else since then is left alone and reported in `unmatched` (PT SCH-7). Every
 *  moved row gets a 'reschedule' breadcrumb with its before/after finish,
 *  matching updateMilestone's shape, and the batch audit row carries the
 *  before/after dates and is a CHECKED write (PC SCHED-11).
 *
 *  Rejected moves THROW a MoveConflictError by default (after the trail is
 *  written), so a caller that applied its dates optimistically and reads only
 *  success / failure shows an error and refreshes instead of a success. A
 *  caller that renders `unmatched` itself passes `onUnmatched: "return"`. */
export async function applyMilestoneMoves(input: {
  orgId: string;
  projectId: string;
  moves: Array<{ id: string; plannedStartAt: string; plannedAt: string; expectedUpdatedAt?: string | null }>;
  actorUserId: string;
  actorUserName?: string;
  actorUserEmail?: string;
  actorUserRole?: string;
  /** "throw" (default): a MoveConflictError when any move was rejected.
   *  "return": hand the rejected ids back in `unmatched` for the caller to show. */
  onUnmatched?: "throw" | "return";
}): Promise<MoveBatchResult> {
  if (input.moves.length === 0) return { matched: [], unmatched: [], count: 0, via: "rpc" };
  const ids = input.moves.map((m) => m.id);

  // The rows as they stand: before/after for the trail, and the lock value
  // for any move whose caller did not supply one.
  type BeforeRow = { id: string; planned_at: string; planned_start_at: string | null; updated_at: string | null; status: MilestoneStatus };
  const before = new Map<string, BeforeRow>();
  let readError: string | null = null;
  for (let i = 0; i < ids.length && !readError; i += 200) {
    const { data, error: readErr } = await supabase
      .from("milestones")
      .select("id, planned_at, planned_start_at, updated_at, status")
      .in("id", ids.slice(i, i + 200));
    if (readErr) { readError = readErr.message; break; }
    for (const r of (data ?? []) as BeforeRow[]) before.set(r.id, r);
  }
  // Fail closed: without the read, a move whose caller supplied no expected
  // updated_at would go out with the lock OFF. Refuse the batch (nothing is
  // moved). When every move carries the caller's own lock value the read only
  // fed the trail, so the move proceeds and the missing trail is reported.
  if (readError && input.moves.some((m) => m.expectedUpdatedAt === undefined)) {
    throw new Error(`Could not read the tasks before moving them (${readError}) — nothing was moved. Try again.`);
  }

  const { data, error } = await supabase.rpc("apply_milestone_moves", {
    p_org: input.orgId,
    p_project: input.projectId,
    p_moves: input.moves.map((m) => ({
      id: m.id, start: m.plannedStartAt, finish: m.plannedAt,
      expected_updated_at: m.expectedUpdatedAt !== undefined ? m.expectedUpdatedAt : (before.get(m.id)?.updated_at ?? null),
    })),
  });
  if (error) {
    // PGRST202 = function not deployed yet — keep working, row by row
    // (updateMilestone writes its own breadcrumb per row).
    if (error.code === "PGRST202" || /apply_milestone_moves/.test(error.message ?? "")) {
      await Promise.all(input.moves.map((m) => updateMilestone({
        id: m.id,
        patch: { plannedStartAt: m.plannedStartAt, plannedAt: m.plannedAt },
        updatedBy: input.actorUserId, updatedByName: input.actorUserName,
        updatedByEmail: input.actorUserEmail, updatedByRole: input.actorUserRole,
      })));
      return { matched: ids, unmatched: [], count: ids.length, via: "rows" };
    }
    throw new Error(error.message);
  }
  // 20260907 returned an INT; 20261098 returns {matched, unmatched, count}.
  let matched: string[] = ids;
  let unmatched: string[] = [];
  let count = ids.length;
  if (data && typeof data === "object") {
    const d = data as { matched?: string[]; unmatched?: string[]; count?: number };
    matched = Array.isArray(d.matched) ? d.matched : ids;
    unmatched = Array.isArray(d.unmatched) ? d.unmatched : [];
    count = typeof d.count === "number" ? d.count : matched.length;
  } else if (typeof data === "number") count = data;

  const result: MoveBatchResult = { matched, unmatched, count, via: "rpc" };
  const errs: string[] = [];
  if (readError) errs.push(`breadcrumbs: the tasks could not be read before the move (${readError}), so no before-dates were recorded`);

  // Per-row breadcrumbs: the task's own trail shows the move, not just
  // status flips. Same shape as updateMilestone's reschedule note.
  const matchedSet = new Set(matched);
  const notes: Array<Record<string, unknown>> = [];
  for (const m of input.moves) {
    if (!matchedSet.has(m.id)) continue;
    const b = before.get(m.id);
    if (!b || b.planned_at === m.plannedAt) continue;
    const days = Math.round((Date.parse(m.plannedAt) - Date.parse(b.planned_at)) / 86400000);
    if (days === 0) continue;
    notes.push({
      org_id: input.orgId, milestone_id: m.id, kind: "reschedule", status_at: b.status,
      body: `Finish ${days > 0 ? `+${days}` : days} day${Math.abs(days) === 1 ? "" : "s"} → ${new Date(m.plannedAt).toLocaleDateString()}`,
      created_by: input.actorUserId, created_by_name: input.actorUserName ?? null,
    });
  }
  for (let i = 0; i < notes.length; i += 200) {
    const { error: noteErr } = await supabase.from("milestone_notes").insert(notes.slice(i, i + 200));
    if (noteErr) { errs.push(`breadcrumbs: ${noteErr.message}`); break; }
  }

  // The batch audit row: before/after per moved row, never silently lost.
  const SHOWN = 50;
  const shownMoves = input.moves.filter((m) => matchedSet.has(m.id)).slice(0, SHOWN).map((m) => {
    const b = before.get(m.id);
    return { id: m.id, before: b ? { start: b.planned_start_at, finish: b.planned_at } : null, after: { start: m.plannedStartAt, finish: m.plannedAt } };
  });
  const auditRow = {
    action: "MILESTONES_RESCHEDULED",
    resource_type: "project", resource_id: input.projectId,
    org_id: input.orgId, user_id: input.actorUserId, user_email: input.actorUserEmail ?? null,
    details: {
      count, requested: input.moves.length, unmatched: unmatched.length,
      shown: shownMoves.length, total: matched.length, truncated: matched.length > SHOWN,
      moves: shownMoves,
    },
  };
  let auditRes = await supabase.from("audit_logs").insert(auditRow);
  if (auditRes.error) auditRes = await supabase.from("audit_logs").insert(auditRow); // one retry
  if (auditRes.error) errs.push(`audit: ${auditRes.error.message}`);
  if (errs.length) result.auditError = errs.join("; ");
  if (unmatched.length > 0 && (input.onUnmatched ?? "throw") === "throw") throw new MoveConflictError(result);
  return result;
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
  /** The merge plan (always computed; the only output of a dryRun). */
  plan?: ImportPlan;
  /** Tag written onto every row this import inserted or updated, so a
   *  cancelled or interrupted import is visible and reversible. */
  batchId?: string;
  /** True when the caller aborted mid-way: rows written so far carry batchId. */
  cancelled?: boolean;
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
  /** False when the source's start had no time of day (stored at 00:00Z):
   *  a new row then gets no day / night label (PC SCHED-9). When absent, a
   *  bare "YYYY-MM-DD" start is read the same way. */
  startHasTime?: boolean;
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
  /** Compute the merge plan and write NOTHING (GAP-403: show the diff first). */
  dryRun?: boolean;
  /** Opt-in: let the file's % complete / status / actual dates replace
   *  progress the crew recorded in the app. Off by default (PT SCH-2). */
  overwriteProgress?: boolean;
  /** Tag for this import's writes; generated when absent. */
  batchId?: string;
  /** Cancel between chunks. Rows already written keep their batchId. */
  signal?: AbortSignal;
  onProgress?: (p: { done: number; total: number; phase: "rows" | "structure" }) => void;
}

/** What a re-import would do, computed BEFORE anything is written. Rows the
 *  file does not mention are reported, never deleted (a filtered export is
 *  not a deletion — GAP-403). */
export interface ImportPlan {
  added: number;
  changed: number;
  unchanged: number;
  /** Rows already in the project (same source) that this file does not carry. */
  notInFile: number;
  notInFileNames: string[];
  /** Existing rows whose progress on the board (recorded in the app or set
   *  by an earlier import) differs from the file's. */
  localProgressAtRisk: Array<{ id: string; name: string; localPercent: number; localStatus: MilestoneStatus; filePercent: number | null }>;
  /** Existing rows whose parent or predecessor links this file changes (PT
   *  SCH-16 sets structure to exactly what the file says — a link added in
   *  the app to an imported row is removed if the file does not carry it).
   *  `onlyStructure` counts rows whose plan fields are otherwise unchanged. */
  structure: { rows: number; onlyStructure: number; parents: number; linksAdded: number; linksRemoved: number };
  /** Existing rows keyed by POSITION before content keys (`csv-row:N` /
   *  `msp-row:N`), or by an earlier content key, that this file's row matches
   *  on name + planned start + planned finish: adopted and re-keyed instead of
   *  added beside themselves (PT SCH-3). `rekeyedOnly` counts those whose
   *  plan and structure are otherwise unchanged — they are still written, to
   *  carry the new key. */
  rekeyed: number;
  rekeyedOnly: number;
  /** The per-file row cap the importer enforces. */
  rowCap: number;
}

function coerceIsoMaybe(s: string | null | undefined): string | null {
  if (!s) return null;
  const trimmed = s.trim();
  if (!trimmed) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? `${trimmed}T00:00:00Z` : trimmed;
}

/** Heuristic shift assignment based on a planned start hour, read in UTC
 *  (wall-clock-as-UTC storage). 6am-6pm → day, 6pm-6am → night. Null until
 *  plannedStartAt is known. One implementation, shared with the filter. */
function shiftFromStart(plannedStartIso: string | null): "day" | "night" | null {
  return shiftForStart(plannedStartIso);
}

/** Set the hierarchy migrations (20260703 / 20260705 / 20260731) added.
 *  Determined by the existing-row read (its legacy tier) or, failing that,
 *  on the first chunk refused for an unknown column — from then on every
 *  row in the same import drops these fields so we don't keep re-trying
 *  schema we know is missing. The whole batch still lands; the hierarchy
 *  just isn't preserved until the user runs the migration. */
const NEW_SCHEMA_FIELDS = [
  "planned_start_at", "actual_start_at", "outline_level", "wbs", "is_summary", "shift",
  "work_order_ref", "responsible_party", "responsible_kind", "responsible_org",
  "location", "duration_hours", "attributes", "percent_complete",
] as const;
/** Columns added by 20261097 (projects Round G). Dropped first, on their own,
 *  when a database has the hierarchy migration but not that one. */
const ROUND_G_FIELDS = ["import_batch_id"] as const;
function looksLikeUnknownColumn(msg: string | undefined): boolean {
  if (!msg) return false;
  return /column .* does not exist|unknown column|could not find the/i.test(msg);
}

/** Rows of `milestones` the importer reads to plan a merge: every column a
 *  plan field writes (so "unchanged" means unchanged), plus actuals and
 *  structure. */
interface ExistingImportRow {
  id: string;
  external_ref: string | null;
  name: string;
  description: string | null;
  weight: number | null;
  outline_level: number | null;
  wbs: string | null;
  is_summary: boolean | null;
  shift: string | null;
  work_order_ref: string | null;
  responsible_party: string | null;
  responsible_kind: string | null;
  responsible_org: string | null;
  location: string | null;
  duration_hours: number | null;
  attributes: Record<string, unknown> | null;
  status: MilestoneStatus;
  percent_complete: number | null;
  actual_at: string | null;
  actual_start_at: string | null;
  planned_at: string;
  planned_start_at: string | null;
  parent_id: string | null;
  depends_on: string[] | null;
  created_by: string;
  created_by_name: string | null;
}

const IMPORT_CHUNK = 200;
const STRUCTURE_CONCURRENCY = 25;

function newBatchId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `batch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** True when the row carries progress recorded in the app (or by an earlier
 *  import) that a plan-only re-import must not erase. */
function hasLocalProgress(r: ExistingImportRow): boolean {
  return (Number(r.percent_complete ?? 0) > 0) || r.status !== "planned" || !!r.actual_at || !!r.actual_start_at;
}

function sameDeps(a: string[] | null | undefined, b: string[]): boolean {
  const x = Array.isArray(a) ? a : [];
  if (x.length !== b.length) return false;
  const set = new Set(x);
  return b.every((v) => set.has(v));
}

/** Every plan column the importer writes (import_batch_id aside), compared
 *  against the stored row so an identical re-import writes nothing. */
const PLAN_COMPARE_COLUMNS = [
  "name", "description", "weight", "planned_at", "planned_start_at",
  "outline_level", "wbs", "is_summary", "shift",
  "work_order_ref", "responsible_party", "responsible_kind", "responsible_org",
  "location", "duration_hours", "attributes",
] as const;
const INSTANT_COLUMNS = new Set<string>(["planned_at", "planned_start_at"]);
const NUMBER_COLUMNS = new Set<string>(["weight", "outline_level", "duration_hours"]);

/** JSON with object keys sorted, so key order never reads as a change. */
function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as Record<string, unknown>).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

/** Stored value vs. the value the importer would write, per column type:
 *  timestamps as instants (PostgREST returns `…+00:00`, the parser `…Z`),
 *  numerics as numbers, attributes as canonical JSON, text with "" = null. */
function samePlanValue(column: string, stored: unknown, next: unknown): boolean {
  if (INSTANT_COLUMNS.has(column)) {
    const a = stored == null || stored === "" ? null : String(stored);
    const b = next == null || next === "" ? null : String(next);
    if (a === null || b === null) return a === b;
    const ta = Date.parse(a), tb = Date.parse(b);
    return Number.isFinite(ta) && Number.isFinite(tb) ? ta === tb : a === b;
  }
  if (NUMBER_COLUMNS.has(column)) {
    if (stored == null || next == null) return (stored == null) === (next == null);
    return Number(stored) === Number(next);
  }
  if (column === "is_summary") return !!stored === !!next;
  if (column === "attributes") return canonicalJson(stored ?? {}) === canonicalJson(next ?? {});
  const a = stored == null || stored === "" ? null : stored;
  const b = next == null || next === "" ? null : next;
  return a === b;
}

/** The existing-row read, by schema tier: everything; without `depends_on`
 *  (20260715 not applied); without the 20260703 / 20260705 / 20260731
 *  columns. The tier the database answers decides which writes degrade. */
const EXISTING_READ = {
  full: "id, external_ref, name, description, weight, outline_level, wbs, is_summary, shift, work_order_ref, responsible_party, responsible_kind, responsible_org, location, duration_hours, attributes, status, percent_complete, actual_at, actual_start_at, planned_at, planned_start_at, parent_id, depends_on, created_by, created_by_name",
  noDeps: "id, external_ref, name, description, weight, outline_level, wbs, is_summary, shift, work_order_ref, responsible_party, responsible_kind, responsible_org, location, duration_hours, attributes, status, percent_complete, actual_at, actual_start_at, planned_at, planned_start_at, parent_id, created_by, created_by_name",
  legacy: "id, external_ref, name, description, weight, status, actual_at, planned_at, created_by, created_by_name",
} as const;
type ExistingReadTier = keyof typeof EXISTING_READ;

/** Every existing row of this source in the import scope, in one query per
 *  page (PostgREST caps a page at 1,000 rows; the row cap is 5,000). An
 *  unknown-column refusal steps down a tier and the whole read restarts, so
 *  the degrade paths below are reachable on an older database. */
async function fetchExistingImportRows(input: ImportParsedInput): Promise<{ rows: ExistingImportRow[]; tier: ExistingReadTier; error?: string }> {
  const tiers: ExistingReadTier[] = ["full", "noDeps", "legacy"];
  const PAGE = 1000;
  let lastError = "";
  for (const tier of tiers) {
    const out: ExistingImportRow[] = [];
    let stepDown = false;
    for (let from = 0; ; from += PAGE) {
      let q = supabase
        .from("milestones")
        .select(EXISTING_READ[tier])
        .eq("org_id", input.orgId)
        .eq("source", input.source)
        .not("external_ref", "is", null);
      if (input.projectId) q = q.eq("project_id", input.projectId);
      else if (input.documentId) q = q.eq("document_id", input.documentId);
      else q = q.is("project_id", null).is("document_id", null);
      const { data, error } = await q.order("id").range(from, from + PAGE - 1);
      if (error) {
        if (looksLikeUnknownColumn(error.message)) { stepDown = true; lastError = error.message; break; }
        return { rows: out, tier, error: error.message };
      }
      const page = (data ?? []) as unknown as ExistingImportRow[];
      out.push(...page);
      if (page.length < PAGE) break;
    }
    if (!stepDown) return { rows: out, tier };
  }
  return { rows: [], tier: "legacy", error: lastError };
}

/** A keyless CSV row's content key, or a position key from before content
 *  keys: `csv-key:…` / `msp-row:12` → { tag: "csv" | "msp", kind }. */
function keylessRef(ref: string | null | undefined): { tag: string; kind: "row" | "key" } | null {
  const m = ref?.match(/^([a-z0-9]+)-(row|key):/i);
  return m ? { tag: m[1].toLowerCase(), kind: m[2].toLowerCase() as "row" | "key" } : null;
}

/**
 * File-upload importer (GAP-403's engine half).
 *
 *   * Identity: rows match on external_ref within (org, project, source) — the
 *     20260704 unique index — so a re-import updates the same rows.
 *   * Plan vs. actuals: planned dates, names, structure and links come from
 *     the file; percent_complete / status / actual_* on a row with local
 *     progress are left alone unless overwriteProgress is set (PT SCH-2).
 *   * Structure is set to exactly what the file says for rows the file
 *     carries — parent and predecessors cleared when the file has none —
 *     while rows the file does not mention are left untouched (PT SCH-16).
 *   * One read of the existing rows, chunked inserts / upserts, chunked
 *     structure updates, a row cap, progress and cancel (PT SCH-14).
 *   * dryRun returns the plan and writes nothing (GAP-403 acceptance 2).
 */
export async function importMilestonesFromParsed(input: ImportParsedInput): Promise<ImportResult> {
  const batchId = input.batchId ?? newBatchId();
  const result: ImportResult = { inserted: 0, updated: 0, skipped: 0, errors: [], batchId };
  const rowCap = SCHEDULE_IMPORT_LIMITS.maxRows;
  if (input.rows.length > rowCap) {
    result.errors.push(`This file has ${input.rows.length.toLocaleString()} rows; the import limit is ${rowCap.toLocaleString()} rows per file. Split the schedule (for example by phase) and import the parts separately. Nothing was written.`);
    return result;
  }

  // ── Normalise every row once ─────────────────────────────────────
  type Prepared = {
    index: number;
    row: ParsedMilestoneRow;
    name: string;
    plannedIso: string;
    plannedStartIso: string | null;
    dateOnlyStart: boolean;
    planFields: Record<string, unknown>;
    /** What the file says about progress — undefined when it says nothing. */
    actualFields: Record<string, unknown> | undefined;
    filePercent: number | null;
    existing: ExistingImportRow | null;
    id: string | null;
    /** The existing row's old external_ref when this row adopted it (SCH-3). */
    rekeyedFrom: string | null;
  };
  const prepared: Prepared[] = [];
  for (let i = 0; i < input.rows.length; i++) {
    const r = input.rows[i];
    const name = r.name?.trim();
    if (!name) { result.skipped++; continue; }
    const planned = r.plannedAt?.trim();
    if (!planned) { result.skipped++; continue; }
    const plannedIso = coerceIsoMaybe(planned)!;
    const plannedStartIso = coerceIsoMaybe(r.plannedStartAt ?? null);
    // A start with no time of day is stored at 00:00Z; that midnight is not a
    // shift reading, so it earns no day / night label (PC SCHED-9).
    const dateOnlyStart = !!plannedStartIso && (r.startHasTime === false
      || (r.startHasTime === undefined && /^\d{4}-\d{2}-\d{2}$/.test((r.plannedStartAt ?? "").trim())));
    const weight = Number(r.weight ?? 1);

    // Carry the source schedule's progress through: MS Project %Complete, P6
    // physical %, or a CSV "% complete" column. Derive the workflow status from
    // it (100 ⇒ completed, >0 ⇒ in_progress, else planned). A file that carries
    // no progress at all claims nothing about it.
    const fileClaims = r.percentComplete != null && Number.isFinite(r.percentComplete);
    const importPct = fileClaims ? Math.max(0, Math.min(100, Math.round(r.percentComplete as number))) : 0;
    const importStatus: MilestoneStatus = importPct >= 100 ? "completed" : importPct > 0 ? "in_progress" : "planned";
    const actualFields: Record<string, unknown> = {
      status: importStatus,
      percent_complete: importPct,
      actual_at: importStatus === "completed" ? plannedIso : null,
      actual_start_at: importPct > 0 ? (plannedStartIso ?? plannedIso) : null,
    };
    const planFields: Record<string, unknown> = {
      name,
      description: r.description ?? null,
      weight: isNaN(weight) ? 1 : weight,
      planned_at: plannedIso,
      planned_start_at: plannedStartIso,
      outline_level: r.outlineLevel ?? null,
      wbs: r.wbs ?? null,
      is_summary: !!r.isSummary,
      shift: dateOnlyStart ? null : shiftFromStart(plannedStartIso),
      work_order_ref: r.workOrderRef ?? null,
      responsible_party: r.responsibleParty ?? null,
      responsible_kind: r.responsibleKind ?? null,
      responsible_org: r.responsibleOrg ?? null,
      location: r.location ?? null,
      duration_hours: r.durationHours ?? null,
      attributes: r.attributes && Object.keys(r.attributes).length > 0 ? r.attributes : {},
      import_batch_id: batchId,
    };
    prepared.push({ index: i, row: r, name, plannedIso, plannedStartIso, dateOnlyStart, planFields, actualFields: fileClaims ? actualFields : undefined, filePercent: fileClaims ? importPct : null, existing: null, id: null, rekeyedFrom: null });
  }

  // ── One read of what is already there ────────────────────────────
  const { rows: existingRows, tier: readTier, error: readErr } = await fetchExistingImportRows(input);
  if (readErr) {
    result.errors.push(`Could not read the existing schedule: ${readErr}. Nothing was written.`);
    return result;
  }
  // The tier the read answered decides the writes up front: no 20260703 →
  // the hierarchy fields are dropped; no 20260715 → links are not written.
  let degradeRoundG = false;   // 20261097 not applied: drop import_batch_id
  let degradeToLegacy = readTier === "legacy"; // 20260703 not applied: drop the hierarchy fields
  let depsColumnMissing = readTier !== "full"; // 20260715 not applied: keep the hierarchy, drop the links
  const existingByRef = new Map<string, ExistingImportRow>();
  for (const e of existingRows) if (e.external_ref) existingByRef.set(e.external_ref, e);
  const refToId = new Map<string, string>();
  const fileRefs = new Set<string>();
  const claimed = new Set<string>();
  const attach = (p: Prepared, e: ExistingImportRow) => {
    p.existing = e; p.id = e.id; claimed.add(e.id);
    if (p.row.externalRef) refToId.set(p.row.externalRef, e.id);
    // An existing row's shift follows the same rule as a drag (PC SCHED-9):
    // re-labelled only when its start moves into the other band; a
    // hand-set label, swing or an unlabelled row is not recomputed, and a
    // date-only start (no band to read) keeps what is stored.
    p.planFields.shift = p.dateOnlyStart
      ? (e.shift ?? null)
      : shiftAfterMove(e.shift ?? null, e.planned_start_at, p.plannedStartIso);
  };
  for (const p of prepared) {
    if (!p.row.externalRef) continue;
    fileRefs.add(p.row.externalRef);
    const e = existingByRef.get(p.row.externalRef);
    if (e) attach(p, e);
  }
  // Adoption (PT SCH-3): a keyless row whose content key matches nothing may
  // be a row imported before content keys — keyed by its POSITION
  // (`csv-row:N`) — or under an earlier content key. An unclaimed row of the
  // same tag with the same name (trimmed, case-folded), planned finish and
  // planned start (as instants) is that row: it is adopted and re-keyed,
  // keeping its id and the crew's progress, instead of a duplicate being
  // added beside it. Candidates pair in file order (position rows by index).
  const candidates = new Map<string, ExistingImportRow[]>();
  const rowIndex = (ref: string) => Number(ref.slice(ref.indexOf(":") + 1)) || 0;
  for (const e of existingRows) {
    const k = keylessRef(e.external_ref);
    if (!k || claimed.has(e.id) || fileRefs.has(e.external_ref!)) continue;
    const bucket = `${k.tag}|${String(e.name ?? "").trim().toLowerCase()}`;
    const list = candidates.get(bucket) ?? [];
    list.push(e);
    candidates.set(bucket, list);
  }
  for (const list of candidates.values()) {
    list.sort((a, b) => {
      const ka = keylessRef(a.external_ref)!, kb = keylessRef(b.external_ref)!;
      if (ka.kind !== kb.kind) return ka.kind === "row" ? -1 : 1;
      return ka.kind === "row" ? rowIndex(a.external_ref!) - rowIndex(b.external_ref!) : String(a.external_ref).localeCompare(String(b.external_ref));
    });
  }
  for (const p of prepared) {
    if (p.existing) continue;
    const k = keylessRef(p.row.externalRef);
    if (!k || k.kind !== "key") continue;
    const list = candidates.get(`${k.tag}|${p.name.toLowerCase()}`);
    const e = list?.find((c) => !claimed.has(c.id)
      && samePlanValue("planned_at", c.planned_at, p.plannedIso)
      && (degradeToLegacy || samePlanValue("planned_start_at", c.planned_start_at, p.plannedStartIso)));
    if (!e) continue;
    p.rekeyedFrom = e.external_ref;
    attach(p, e);
  }

  // ── The plan ──────────────────────────────────────────────────────
  const plan: ImportPlan = {
    added: 0, changed: 0, unchanged: 0, notInFile: 0, notInFileNames: [], localProgressAtRisk: [],
    structure: { rows: 0, onlyStructure: 0, parents: 0, linksAdded: 0, linksRemoved: 0 }, rekeyed: 0, rekeyedOnly: 0, rowCap,
  };
  // On a legacy database only the columns it has are compared (and written).
  const compareColumns = degradeToLegacy
    ? PLAN_COMPARE_COLUMNS.filter((c) => !(NEW_SCHEMA_FIELDS as readonly string[]).includes(c))
    : PLAN_COMPARE_COLUMNS;
  const planChanged = (p: Prepared, e: ExistingImportRow): boolean =>
    compareColumns.some((c) => !samePlanValue(c, (e as unknown as Record<string, unknown>)[c], p.planFields[c]));
  const progressWouldChange = (p: Prepared, e: ExistingImportRow): boolean =>
    !!p.actualFields && ((!degradeToLegacy && Number(e.percent_complete ?? 0) !== (p.filePercent ?? 0)) || e.status !== p.actualFields.status);
  const writeActuals = (p: Prepared): boolean => {
    if (!p.actualFields) return false;                 // the file says nothing about progress
    if (!p.existing) return true;                      // a new row takes the file's progress
    if (!hasLocalProgress(p.existing)) return true;    // nothing local to protect
    return !!input.overwriteProgress;                  // explicit opt-in only
  };
  const toWrite: Array<{ p: Prepared; changed: boolean }> = [];
  for (const p of prepared) {
    if (!p.existing) { plan.added++; toWrite.push({ p, changed: true }); continue; }
    const progressAtRisk = hasLocalProgress(p.existing) && progressWouldChange(p, p.existing);
    if (progressAtRisk) plan.localProgressAtRisk.push({ id: p.existing.id, name: p.existing.name, localPercent: Number(p.existing.percent_complete ?? 0), localStatus: p.existing.status, filePercent: p.filePercent });
    const changed = planChanged(p, p.existing) || (writeActuals(p) && progressWouldChange(p, p.existing));
    if (changed) plan.changed++; else plan.unchanged++;
    // A re-keyed row is written even when nothing else changed: it carries
    // the new key.
    toWrite.push({ p, changed: changed || !!p.rekeyedFrom });
    // Structure the file would set on this row (a ref the file adds resolves
    // once inserted — counted as a change here, since it cannot equal a
    // stored id). None on a legacy database: the structure pass is skipped.
    let structureChanges = false;
    if (!degradeToLegacy) {
      const planRef = (ref: string): string | null => refToId.get(ref) ?? (fileRefs.has(ref) ? `new:${ref}` : null);
      const e = p.existing;
      const wantParentRaw = p.row.parentExternalRef ? planRef(p.row.parentExternalRef) : null;
      const wantParent = wantParentRaw && wantParentRaw !== e.id ? wantParentRaw : null;
      const wantDeps = depsColumnMissing ? [] : Array.from(new Set((p.row.dependsOnExternalRefs ?? []).map(planRef).filter((x): x is string => !!x && x !== e.id)));
      const haveDeps = !depsColumnMissing && Array.isArray(e.depends_on) ? e.depends_on : [];
      const parentMoves = (e.parent_id ?? null) !== wantParent;
      const added = wantDeps.filter((d) => !haveDeps.includes(d)).length;
      const removed = haveDeps.filter((d) => !wantDeps.includes(d)).length;
      if (parentMoves || added > 0 || removed > 0) {
        structureChanges = true;
        plan.structure.rows++;
        if (!changed) plan.structure.onlyStructure++;
        if (parentMoves) plan.structure.parents++;
        plan.structure.linksAdded += added;
        plan.structure.linksRemoved += removed;
      }
    }
    if (p.rekeyedFrom) {
      plan.rekeyed++;
      if (!changed && !structureChanges) plan.rekeyedOnly++;
    }
  }
  for (const e of existingRows) {
    if (e.external_ref && !fileRefs.has(e.external_ref) && !claimed.has(e.id)) {
      plan.notInFile++;
      if (plan.notInFileNames.length < 10) plan.notInFileNames.push(e.name);
    }
  }
  result.plan = plan;
  if (input.dryRun) return result;

  // ── Writes: chunked, cancellable, degrade-aware ───────────────────
  const stripForSchema = (fields: Record<string, unknown>): Record<string, unknown> => {
    const out = { ...fields };
    if (degradeRoundG || degradeToLegacy) for (const f of ROUND_G_FIELDS) delete out[f];
    if (degradeToLegacy) for (const f of NEW_SCHEMA_FIELDS) delete out[f];
    return out;
  };
  const scope = { org_id: input.orgId, project_id: input.projectId ?? null, document_id: input.documentId ?? null, source: input.source };
  const insertPayload = (p: Prepared) => stripForSchema({
    ...scope, ...p.planFields, ...(p.actualFields ?? {}),
    external_ref: p.row.externalRef ?? null,
    created_by: input.createdBy, created_by_name: input.createdByName ?? null,
  });
  const updateFields = (p: Prepared) => stripForSchema({
    ...p.planFields, ...(writeActuals(p) ? p.actualFields : {}),
    ...(p.rekeyedFrom ? { external_ref: p.row.externalRef } : {}),
    updated_at: new Date().toISOString(), updated_by: input.createdBy,
  });
  // The upsert's INSERT half must be a complete row (NOT NULL columns), so the
  // existing row's provenance travels with it unchanged.
  const upsertPayload = (p: Prepared) => ({
    id: p.id!, ...scope, external_ref: p.row.externalRef ?? null,
    created_by: p.existing!.created_by, created_by_name: p.existing!.created_by_name,
    ...updateFields(p),
  });
  const total = toWrite.filter((w) => w.changed).length;
  let done = 0;
  const report = (phase: "rows" | "structure") => input.onProgress?.({ done, total, phase });
  const cancelled = () => !!input.signal?.aborted;
  const rowLabel = (p: Prepared) => `Row ${p.index + 1}`;

  /** Run a chunk write; on a schema error step down a tier and retry the
   *  same chunk; on any other error isolate the bad rows one at a time so a
   *  single unreadable row does not sink two hundred good ones. */
  async function writeChunk(chunk: Prepared[], mode: "insert" | "upsert"): Promise<void> {
    const attempt = async () => {
      if (mode === "insert") {
        return supabase.from("milestones").insert(chunk.map(insertPayload)).select("id, external_ref");
      }
      return supabase.from("milestones").upsert(chunk.map(upsertPayload), { onConflict: "id" }).select("id, external_ref");
    };
    let res = await attempt();
    if (res.error && looksLikeUnknownColumn(res.error.message)) {
      if (!degradeRoundG) degradeRoundG = true;
      else degradeToLegacy = true;
      res = await attempt();
      if (res.error && looksLikeUnknownColumn(res.error.message) && !degradeToLegacy) { degradeToLegacy = true; res = await attempt(); }
    }
    if (!res.error) {
      const returned = (res.data ?? []) as Array<{ id: string; external_ref: string | null }>;
      for (const r of returned) if (r.external_ref && !refToId.has(r.external_ref)) refToId.set(r.external_ref, r.id);
      for (const p of chunk) {
        if (mode === "insert") { result.inserted++; if (p.row.externalRef) p.id = refToId.get(p.row.externalRef) ?? null; }
        else result.updated++;
      }
      return;
    }
    // Not a schema problem: isolate per row.
    for (const p of chunk) {
      const one = mode === "insert"
        ? await supabase.from("milestones").insert(insertPayload(p)).select("id").maybeSingle()
        : await supabase.from("milestones").update(updateFields(p)).eq("id", p.id!).select("id").maybeSingle();
      if (one.error) { result.errors.push(`${rowLabel(p)}: ${one.error.message}`); continue; }
      if (mode === "insert") {
        result.inserted++;
        const id = (one.data as { id: string } | null)?.id ?? null;
        p.id = id;
        if (id && p.row.externalRef) refToId.set(p.row.externalRef, id);
      } else result.updated++;
    }
  }

  const inserts = toWrite.filter((w) => w.changed && !w.p.existing).map((w) => w.p);
  const upserts = toWrite.filter((w) => w.changed && !!w.p.existing).map((w) => w.p);
  // A bulk write sends the UNION of its rows' keys and fills a missing key
  // with NULL, so rows that carry status / percent_complete / actual_* and
  // rows that do not must never share a request (status is NOT NULL, and an
  // upsert would null a protected row's progress). One key set per request.
  const byKeySet = (list: Prepared[], carriesActuals: (p: Prepared) => boolean): Prepared[][] =>
    [list.filter(carriesActuals), list.filter((p) => !carriesActuals(p))].filter((g) => g.length > 0);
  const groups: Array<readonly ["insert" | "upsert", Prepared[]]> = [
    ...byKeySet(inserts, (p) => !!p.actualFields).map((g) => ["insert", g] as const),
    ...byKeySet(upserts, writeActuals).map((g) => ["upsert", g] as const),
  ];
  report("rows");
  for (const [mode, list] of groups) {
    for (let i = 0; i < list.length; i += IMPORT_CHUNK) {
      if (cancelled()) { result.cancelled = true; result.errors.push(`Import cancelled after ${done} of ${total} rows. Rows written so far are tagged with batch ${batchId}.`); return result; }
      const chunk = list.slice(i, i + IMPORT_CHUNK);
      try { await writeChunk(chunk, mode); }
      catch (e) { for (const p of chunk) result.errors.push(`${rowLabel(p)}: ${(e as Error).message}`); }
      done += chunk.length;
      report("rows");
    }
  }

  // ── Structure: exactly what the file says, for the rows it carries ─
  // parent_id and depends_on are resolved now that every row has an id. A
  // row the file carries with no parent / no predecessors gets NULL / [] —
  // stale structure never survives a re-import (PT SCH-16). Rows the file
  // does not mention are not touched.
  if (degradeToLegacy) {
    result.errors.push(
      "Heads up: hierarchy migration 20260703_milestones_hierarchy.sql hasn't been applied to your database, so parent/child relationships and start dates were dropped on this import. Run the migration in Supabase SQL Editor and re-import to get the full schedule.",
    );
    return result;
  }
  const structure: Array<{ id: string; parent_id: string | null; depends_on: string[] }> = [];
  for (const p of prepared) {
    const id = p.id ?? (p.row.externalRef ? refToId.get(p.row.externalRef) ?? null : null);
    if (!id) continue;
    const parentId = p.row.parentExternalRef ? (refToId.get(p.row.parentExternalRef) ?? null) : null;
    const parent_id = parentId && parentId !== id ? parentId : null;
    const depends_on = (p.row.dependsOnExternalRefs ?? [])
      .map((ref) => refToId.get(ref))
      .filter((x): x is string => !!x && x !== id);
    if (p.existing) {
      if ((p.existing.parent_id ?? null) === parent_id && (depsColumnMissing || sameDeps(p.existing.depends_on, depends_on))) continue;
    } else if (!parent_id && (depsColumnMissing || depends_on.length === 0)) continue; // a fresh row is already NULL / []
    structure.push({ id, parent_id, depends_on });
  }
  for (let i = 0; i < structure.length; i += STRUCTURE_CONCURRENCY) {
    if (cancelled()) { result.cancelled = true; result.errors.push(`Import cancelled while wiring structure (${i} of ${structure.length} done). Rows are tagged with batch ${batchId}; re-import the same file to finish.`); return result; }
    const chunk = structure.slice(i, i + STRUCTURE_CONCURRENCY);
    await Promise.all(chunk.map(async (u) => {
      const fields: Record<string, unknown> = depsColumnMissing ? { parent_id: u.parent_id } : { parent_id: u.parent_id, depends_on: u.depends_on };
      let res = await supabase.from("milestones").update(fields).eq("id", u.id);
      if (res.error && !depsColumnMissing && looksLikeUnknownColumn(res.error.message)) {
        depsColumnMissing = true; // 20260715 not applied — keep the hierarchy, drop the links
        res = await supabase.from("milestones").update({ parent_id: u.parent_id }).eq("id", u.id);
      }
      if (res.error) result.errors.push(`Structure for ${u.id}: ${res.error.message}`);
    }));
    input.onProgress?.({ done: Math.min(i + chunk.length, structure.length), total: structure.length, phase: "structure" });
  }
  if (depsColumnMissing && prepared.some((p) => (p.row.dependsOnExternalRefs?.length ?? 0) > 0)) {
    result.errors.push(
      "Heads up: migration 20260715_milestone_dependencies.sql hasn't been applied to your database, so the file's predecessor links were not imported (the hierarchy was). Run the migration in Supabase SQL Editor and re-import to get the links.",
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
//
// Both are ONE RPC call (20261099): set_project_baseline / clear_project_
// baseline apply as a single statement (no half-applied baseline), enforce
// the same authority as apply_milestone_moves at the data layer, write the
// prior snapshot to milestone_baseline_history before overwriting it, and
// audit themselves. A BEFORE UPDATE trigger refuses direct writes to the
// baseline_* columns outside those RPCs (PC SCHED-3 / PT SAF-7). On a
// database without the migration the legacy per-row path still runs, so
// the button keeps working — the rail is the migration.

const RPC_MISSING = (error: { code?: string; message?: string }, fn: string) =>
  error.code === "PGRST202" || new RegExp(fn).test(error.message ?? "");

export async function setBaseline(input: {
  orgId: string;
  projectId: string;
  actorUserId: string;
  actorUserEmail?: string;
  actorUserRole?: string;
}): Promise<{ ok: boolean; count: number; error?: string; via: "rpc" | "legacy"; historyId?: string | null }> {
  const { data, error } = await supabase.rpc("set_project_baseline", { p_org: input.orgId, p_project: input.projectId });
  if (!error) {
    const d = (data ?? {}) as { count?: number; history_id?: string | null };
    const count = Number(d.count ?? 0);
    if (count === 0) return { ok: false, count: 0, error: "No tasks to baseline.", via: "rpc" };
    return { ok: true, count, via: "rpc", historyId: d.history_id ?? null };
  }
  if (!RPC_MISSING(error, "set_project_baseline")) return { ok: false, count: 0, error: error.message, via: "rpc" };

  // Legacy path (20261099 not applied): per-row writes, client-side audit.
  const { data: rows, error: readErr } = await supabase
    .from("milestones")
    .select("id, planned_at, planned_start_at")
    .eq("org_id", input.orgId)
    .eq("project_id", input.projectId);
  if (readErr) return { ok: false, count: 0, error: readErr.message, via: "legacy" };
  if (!rows || rows.length === 0) return { ok: false, count: 0, error: "No tasks to baseline.", via: "legacy" };

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
    details: { count, requested: rows.length, partial: errors.length > 0 },
  }).catch(() => { /* audit is best-effort */ });

  return {
    ok: errors.length === 0, count, via: "legacy",
    error: errors.length > 0 ? `Baseline applied to ${count} of ${rows.length} tasks — ${errors[0]}` : undefined,
  };
}

/** Remove the project's baseline. Audited (SCHEDULE_BASELINE_CLEARED) and,
 *  through the RPC, preserved in milestone_baseline_history first. */
export async function clearBaseline(input: {
  orgId: string;
  projectId: string;
  actorUserId: string;
  actorUserEmail?: string;
  actorUserRole?: string;
}): Promise<{ ok: boolean; count: number; error?: string; via: "rpc" | "legacy" }> {
  const { data, error } = await supabase.rpc("clear_project_baseline", { p_org: input.orgId, p_project: input.projectId });
  if (!error) {
    const d = (data ?? {}) as { count?: number };
    return { ok: true, count: Number(d.count ?? 0), via: "rpc" };
  }
  if (!RPC_MISSING(error, "clear_project_baseline")) return { ok: false, count: 0, error: error.message, via: "rpc" };

  const { data: cleared, error: updErr } = await supabase.from("milestones").update({
    baseline_start_at: null, baseline_finish_at: null, baseline_set_at: null, baseline_set_by: null,
  }).eq("org_id", input.orgId).eq("project_id", input.projectId).select("id");
  if (updErr) return { ok: false, count: 0, error: updErr.message, via: "legacy" };
  const count = (cleared ?? []).length;
  await logAuditAction({
    action: "SCHEDULE_BASELINE_CLEARED",
    resourceType: "project",
    resourceId: input.projectId,
    orgId: input.orgId,
    userId: input.actorUserId,
    userEmail: input.actorUserEmail,
    userRole: input.actorUserRole,
    details: { count },
  }).catch(() => { /* audit is best-effort */ });
  return { ok: true, count, via: "legacy" };
}
