// closeoutSettings - what a project's close-out was told: the PSSR not
// needed for this job (or for one phase), and who said so, when. Kept with
// the project's settings (shift_times), where every setting saves for
// whoever can change the project.

import { supabase } from "@/lib/supabase";

/** One phase's PSSR: the checklist that is it, or not needed for that
 *  phase; and who last changed whether it is needed, when. */
export interface PhasePssr { checklistId?: string | null; notNeeded?: boolean; at?: string | null; by?: string | null }

export interface CloseoutSettings {
  /** "not_needed": no PSSR for this job (said on the close-out). */
  pssr?: "not_needed" | null;
  /** Who last changed `pssr`, and when (none: never changed, or changed
   *  before this was kept). */
  pssrAt?: string | null;
  pssrBy?: string | null;
  /** A project in phases: each phase's PSSR (each restart has its own): the
   *  checklist that is it, or not needed for that phase. */
  pssrByPhase?: Record<string, PhasePssr>;
}

/** Fired after a close-out setting is saved, so every view of it re-reads. */
export const CLOSEOUT_CHANGED = "closeout-settings:changed";

const str = (v: unknown) => (typeof v === "string" && v ? v : null);

export async function loadCloseoutSettings(projectId: string): Promise<CloseoutSettings> {
  const { data } = await supabase.from("projects").select("shift_times").eq("id", projectId).maybeSingle();
  const st = (data as { shift_times?: Record<string, unknown> | null } | null)?.shift_times;
  const c = st && typeof st.closeout === "object" && st.closeout ? (st.closeout as Record<string, unknown>) : {};
  const by: Record<string, PhasePssr> = {};
  if (c.pssrByPhase && typeof c.pssrByPhase === "object") {
    for (const [k, v0] of Object.entries(c.pssrByPhase as Record<string, unknown>)) {
      if (!v0 || typeof v0 !== "object") continue;
      const v = v0 as Record<string, unknown>;
      by[k] = { checklistId: str(v.checklistId), notNeeded: v.notNeeded === true, at: str(v.at), by: str(v.by) };
    }
  }
  return { pssr: c.pssr === "not_needed" ? "not_needed" : null, pssrAt: str(c.pssrAt), pssrBy: str(c.pssrBy), pssrByPhase: by };
}

export async function saveCloseoutSettings(projectId: string, patch: CloseoutSettings): Promise<{ ok: boolean; error?: string }> {
  const { data: cur, error: readErr } = await supabase.from("projects").select("shift_times").eq("id", projectId).maybeSingle();
  if (readErr) return { ok: false, error: readErr.message };
  const st = { ...(((cur as { shift_times?: Record<string, unknown> | null } | null)?.shift_times) ?? {}) };
  const was = (st.closeout as Record<string, unknown> | undefined) ?? {};
  // A phase's PSSR changes only that phase's (and keeps what it had: a
  // checklist tied to it stays tied when only "needed" changes).
  const wasBy = ((was.pssrByPhase as Record<string, Record<string, unknown>> | undefined) ?? {});
  const byPhase = patch.pssrByPhase
    ? { ...wasBy, ...Object.fromEntries(Object.entries(patch.pssrByPhase).map(([k, v]) => [k, { ...(wasBy[k] ?? {}), ...v }])) }
    : was.pssrByPhase;
  st.closeout = { ...was, ...patch, ...(byPhase ? { pssrByPhase: byPhase } : {}) };
  const { data, error } = await supabase.from("projects").update({ shift_times: st }).eq("id", projectId).select("id");
  if (error) return { ok: false, error: error.message };
  if (!data?.length) return { ok: false, error: "Not saved - only the project's owner, a co-owner or an admin can change this." };
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(CLOSEOUT_CHANGED, { detail: { projectId } }));
  return { ok: true };
}

/** Say whether one phase (or, with no phase, the job) needs a PSSR, and
 *  keep who said so and when. */
export function savePssrNeeded(projectId: string, phaseId: string | null, needed: boolean, by: string | null): Promise<{ ok: boolean; error?: string }> {
  const at = new Date().toISOString();
  return phaseId
    ? saveCloseoutSettings(projectId, { pssrByPhase: { [phaseId]: { notNeeded: !needed, at, by } } })
    : saveCloseoutSettings(projectId, { pssr: needed ? null : "not_needed", pssrAt: at, pssrBy: by });
}
