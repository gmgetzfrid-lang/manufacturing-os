// closeoutSettings - what a project's close-out was told: the PSSR not
// needed for this job. Kept with the project's settings (shift_times),
// where every setting saves for whoever can change the project.

import { supabase } from "@/lib/supabase";

export interface CloseoutSettings {
  /** "not_needed": no PSSR for this job (said on the close-out). */
  pssr?: "not_needed" | null;
}

export async function loadCloseoutSettings(projectId: string): Promise<CloseoutSettings> {
  const { data } = await supabase.from("projects").select("shift_times").eq("id", projectId).maybeSingle();
  const st = (data as { shift_times?: Record<string, unknown> | null } | null)?.shift_times;
  const c = st && typeof st.closeout === "object" && st.closeout ? (st.closeout as CloseoutSettings) : {};
  return { pssr: c.pssr === "not_needed" ? "not_needed" : null };
}

export async function saveCloseoutSettings(projectId: string, patch: CloseoutSettings): Promise<{ ok: boolean; error?: string }> {
  const { data: cur, error: readErr } = await supabase.from("projects").select("shift_times").eq("id", projectId).maybeSingle();
  if (readErr) return { ok: false, error: readErr.message };
  const st = { ...(((cur as { shift_times?: Record<string, unknown> | null } | null)?.shift_times) ?? {}) };
  st.closeout = { ...((st.closeout as Record<string, unknown> | undefined) ?? {}), ...patch };
  const { data, error } = await supabase.from("projects").update({ shift_times: st }).eq("id", projectId).select("id");
  if (error) return { ok: false, error: error.message };
  if (!data?.length) return { ok: false, error: "Not saved - only the project's owner, a co-owner or an admin can change this." };
  return { ok: true };
}
