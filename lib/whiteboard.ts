// lib/whiteboard.ts
//
// Phase 8 — Turnaround Whiteboard data layer.
//
// Thin wrapper around the assets table for the operational
// whiteboard view. Two responsibilities:
//
//   1. listEquipmentForWhiteboard({orgId, plant/unit/system filters})
//      → assets with their whiteboard_state, ordered for the grid
//
//   2. setEquipmentState(assetId, newState, reason?, actor)
//      → flips the column + fires an EQUIPMENT_STATE_CHANGED
//        audit event so the timeline picks it up
//
// All state transitions are valid (no enforced workflow); this
// reflects the real operational pattern where an equipment item
// can move backward (e.g. completed → drafting because someone
// found a problem during commissioning). The audit log preserves
// every transition for reconstruction.

import { supabase } from "@/lib/supabase";
import { logAuditAction } from "@/lib/audit";
import type { Asset } from "@/lib/assets";

export type EquipmentState =
  | "pending" | "drafting" | "executing" | "completed" | "blocked";

/** The ordered states the board's "click to advance" cycles through.
 *  Blocked is intentionally out of the cycle — it's a side branch
 *  the user picks deliberately via the state menu. */
export const ADVANCEABLE_STATES: EquipmentState[] = [
  "pending", "drafting", "executing", "completed",
];

export const ALL_STATES: EquipmentState[] = [
  "pending", "drafting", "executing", "completed", "blocked",
];

export const STATE_LABEL: Record<EquipmentState, string> = {
  pending:   "Pending",
  drafting:  "Drafting",
  executing: "Executing",
  completed: "Completed",
  blocked:   "Blocked",
};

/** Tailwind-friendly tone names; the consumer builds the actual
 *  class strings so we don't pull tailwind config into the lib. */
export const STATE_TONE: Record<EquipmentState, "slate" | "blue" | "amber" | "emerald" | "red"> = {
  pending:   "slate",
  drafting:  "blue",
  executing: "amber",
  completed: "emerald",
  blocked:   "red",
};

/** What state does "click to advance" go to next? Blocked is treated
 *  as a sink — clicking on a blocked tile cycles back to pending. */
export function nextState(current: EquipmentState): EquipmentState {
  if (current === "blocked") return "pending";
  const idx = ADVANCEABLE_STATES.indexOf(current);
  if (idx < 0) return "pending";
  return ADVANCEABLE_STATES[(idx + 1) % ADVANCEABLE_STATES.length];
}

// ─── Reads ─────────────────────────────────────────────────────

export interface ListEquipmentParams {
  orgId: string;
  plantId?: string;
  unitId?: string;
  systemId?: string;
  /** Filter to one state, or null for all. */
  state?: EquipmentState | null;
  /** Include archived rows. Defaults false. */
  includeArchived?: boolean;
  /** Optional free-text against tag / description / location. */
  search?: string;
  limit?: number;
}

export async function listEquipmentForWhiteboard(params: ListEquipmentParams): Promise<Asset[]> {
  const { orgId, plantId, unitId, systemId, state, includeArchived, search, limit = 500 } = params;
  let q = supabase.from("assets").select("*").eq("org_id", orgId).limit(limit);
  if (plantId)  q = q.eq("plant_id", plantId);
  if (unitId)   q = q.eq("unit_id", unitId);
  if (systemId) q = q.eq("system_id", systemId);
  if (state)    q = q.eq("whiteboard_state", state);
  if (!includeArchived) q = q.eq("archived", false);
  if (search && search.trim()) {
    const s = search.trim();
    q = q.or(`tag.ilike.%${s}%,description.ilike.%${s}%,location.ilike.%${s}%`);
  }
  q = q.order("tag", { ascending: true });
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data as Asset[]) ?? [];
}

export interface StateCounts {
  pending: number;
  drafting: number;
  executing: number;
  completed: number;
  blocked: number;
  total: number;
}

/** Counts equipment by state in the given scope. Cheap — one query,
 *  hits the (org_id, whiteboard_state) partial index. */
export async function getStateCounts(params: Omit<ListEquipmentParams, "limit" | "state">): Promise<StateCounts> {
  const { orgId, plantId, unitId, systemId, includeArchived } = params;
  let q = supabase.from("assets").select("whiteboard_state").eq("org_id", orgId);
  if (plantId)  q = q.eq("plant_id", plantId);
  if (unitId)   q = q.eq("unit_id", unitId);
  if (systemId) q = q.eq("system_id", systemId);
  if (!includeArchived) q = q.eq("archived", false);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  const rows = (data as Array<{ whiteboard_state: EquipmentState }>) ?? [];
  const counts: StateCounts = { pending: 0, drafting: 0, executing: 0, completed: 0, blocked: 0, total: 0 };
  for (const r of rows) {
    counts[r.whiteboard_state]++;
    counts.total++;
  }
  return counts;
}

// ─── Mutations ──────────────────────────────────────────────────

export interface SetStateInput {
  asset: Asset;
  newState: EquipmentState;
  /** Optional reason — surfaces in the audit details. */
  reason?: string;
  actorUserId: string;
  actorEmail?: string;
  actorRole?: string;
}

export async function setEquipmentState(input: SetStateInput): Promise<Asset> {
  const { asset, newState, reason, actorUserId, actorEmail, actorRole } = input;
  if (!asset.id) throw new Error("Asset is missing an id.");
  if (asset.whiteboard_state === newState) return asset;  // no-op

  const previous = asset.whiteboard_state;
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("assets")
    .update({
      whiteboard_state: newState,
      updated_at: now,
      updated_by: actorUserId,
    })
    .eq("id", asset.id)
    .select("*")
    .single();

  if (error || !data) throw new Error(error?.message ?? "Failed to update equipment state");

  // Audit on resource_type='asset' so it's properly scoped and the
  // document-timeline queries (which filter on resource_type='document')
  // don't surface equipment events incorrectly.
  await logAuditAction({
    action: "EQUIPMENT_STATE_CHANGED",
    resourceId: asset.id,
    resourceType: "asset",
    orgId: asset.org_id,
    userId: actorUserId,
    userEmail: actorEmail,
    userRole: actorRole,
    details: { previousState: previous, newState, assetTag: asset.tag, reason: reason?.trim() || null },
  });

  return data as Asset;
}
