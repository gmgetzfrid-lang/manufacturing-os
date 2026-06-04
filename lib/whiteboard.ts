// lib/whiteboard.ts
//
// The Phase 8 equipment "whiteboard" — operational state on each asset, with a
// click-to-advance cycle and audit on every change. Drives both the turnaround
// board and the plot-plan markers (lib/plotPlans.ts).

import { supabase } from "@/lib/supabase";
import { logAuditAction } from "@/lib/audit";
import type { WhiteboardState } from "@/types/schema";

export const WHITEBOARD_STATES: WhiteboardState[] = [
  "pending", "drafting", "executing", "completed", "blocked",
];

/** UI config per state: label + the token/Tailwind tones used everywhere the
 *  state is rendered (board cells, plot-plan markers, legends). */
export const STATE_CONFIG: Record<WhiteboardState, {
  label: string;
  /** Hex for SVG markers / inline styles. */
  hex: string;
  /** Tailwind classes for chips/cells. */
  chip: string;
  dot: string;
}> = {
  pending:   { label: "Pending",   hex: "#64748b", chip: "bg-slate-100 text-slate-700 border-slate-200", dot: "bg-slate-400" },
  drafting:  { label: "Drafting",  hex: "#2563eb", chip: "bg-blue-100 text-blue-700 border-blue-200",     dot: "bg-blue-500" },
  executing: { label: "Executing", hex: "#d97706", chip: "bg-amber-100 text-amber-800 border-amber-200",  dot: "bg-amber-500" },
  completed: { label: "Completed", hex: "#16a34a", chip: "bg-emerald-100 text-emerald-700 border-emerald-200", dot: "bg-emerald-500" },
  blocked:   { label: "Blocked",   hex: "#dc2626", chip: "bg-rose-100 text-rose-700 border-rose-200",      dot: "bg-rose-500" },
};

/** The click-to-advance cycle. `blocked` is a deliberate side branch — it's
 *  reached/left explicitly, never by advancing. */
const ADVANCE_ORDER: WhiteboardState[] = ["pending", "drafting", "executing", "completed"];

export function nextState(current: WhiteboardState): WhiteboardState {
  if (current === "blocked") return "drafting"; // leaving blocked resumes work
  const i = ADVANCE_ORDER.indexOf(current);
  if (i < 0) return "drafting";
  return ADVANCE_ORDER[(i + 1) % ADVANCE_ORDER.length];
}

/** Flip an asset's whiteboard_state and write an audit event. resource_type is
 *  'asset' so this never bleeds into document timelines. */
export async function setEquipmentState(input: {
  assetId: string;
  orgId: string;
  newState: WhiteboardState;
  reason?: string;
  actorUserId: string;
  actorEmail?: string;
  actorRole?: string;
  previousState?: WhiteboardState;
}): Promise<void> {
  const { error } = await supabase
    .from("assets")
    .update({ whiteboard_state: input.newState, updated_at: new Date().toISOString(), updated_by: input.actorUserId })
    .eq("id", input.assetId);
  if (error) throw new Error(error.message);

  await logAuditAction({
    orgId: input.orgId,
    userId: input.actorUserId,
    userEmail: input.actorEmail,
    userRole: input.actorRole,
    action: "EQUIPMENT_STATE_CHANGED",
    resourceType: "asset",
    resourceId: input.assetId,
    details: { newState: input.newState, previousState: input.previousState, reason: input.reason },
  }).catch(() => { /* audit is best-effort; never block the flip */ });
}

/** Count of assets in each state for a scope — board sidebar metric. */
export async function getStateCounts(params: {
  orgId: string; plantId?: string; unitId?: string; systemId?: string;
}): Promise<Record<WhiteboardState, number>> {
  let q = supabase.from("assets").select("whiteboard_state").eq("org_id", params.orgId).eq("archived", false);
  if (params.plantId) q = q.eq("plant_id", params.plantId);
  if (params.unitId) q = q.eq("unit_id", params.unitId);
  if (params.systemId) q = q.eq("system_id", params.systemId);
  const { data } = await q;
  const counts: Record<WhiteboardState, number> = { pending: 0, drafting: 0, executing: 0, completed: 0, blocked: 0 };
  for (const r of (data as Array<{ whiteboard_state: WhiteboardState }> ) ?? []) {
    if (r.whiteboard_state in counts) counts[r.whiteboard_state]++;
  }
  return counts;
}
