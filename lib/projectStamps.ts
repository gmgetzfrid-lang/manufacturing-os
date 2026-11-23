// projectStamps - who changed a project setting kept in a plain column (the
// job size), and when. The column has no room for that, so it's kept
// beside the project's other settings (projects.shift_times.stamps), the
// same place every setting saves for whoever can change the project.

import { supabase } from "@/lib/supabase";
import type { Stamp } from "@/lib/requirementSource";

/** The job size's column comes with this migration. */
export const JOB_KIND_SQL = "20261013_project_controls_program.sql";

export function stampsOf(shiftTimes: Record<string, unknown> | null | undefined): Record<string, Stamp> {
  const raw = shiftTimes && typeof shiftTimes.stamps === "object" && shiftTimes.stamps ? (shiftTimes.stamps as Record<string, unknown>) : {};
  const out: Record<string, Stamp> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!v || typeof v !== "object") continue;
    const o = v as Record<string, unknown>;
    out[k] = { at: typeof o.at === "string" ? o.at : null, by: typeof o.by === "string" ? o.by : null };
  }
  return out;
}

/** Change the job size (it sets the usual turnover list), and keep who and when. */
export async function saveJobKind(projectId: string, kind: "small" | "standard" | "capital", by: string | null): Promise<{ ok: boolean; error?: string }> {
  const { data, error } = await supabase.from("projects").update({ job_kind: kind }).eq("id", projectId).select("id");
  if (error) {
    if (error.code === "42703" || error.code === "PGRST204" || /job_kind/.test(error.message)) {
      return { ok: false, error: `The job size needs a database change first: run supabase/migrations/${JOB_KIND_SQL} in the Supabase SQL editor.` };
    }
    return { ok: false, error: error.message };
  }
  if (!data?.length) return { ok: false, error: "Not saved - only the project's owner, a co-owner or an admin can change this." };
  // Who and when: kept beside the other settings. Not kept is not a failure of the change itself.
  const { data: cur } = await supabase.from("projects").select("shift_times").eq("id", projectId).maybeSingle();
  const st = { ...(((cur as { shift_times?: Record<string, unknown> | null } | null)?.shift_times) ?? {}) };
  st.stamps = { ...stampsOf(st), jobKind: { at: new Date().toISOString(), by } };
  await supabase.from("projects").update({ shift_times: st }).eq("id", projectId).then(() => undefined, () => undefined);
  return { ok: true };
}
