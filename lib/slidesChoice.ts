// slidesChoice - whether a project's slides go onto the company template.
//
// Kept with the project's settings (projects.shift_times.slides), beside the
// letterhead: one switch per project, the same for everyone on it. Unset
// means yes whenever the workspace has a template.

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

const EVENT = "slideschoice:changed";
const cache = new Map<string, boolean | null>();

export async function loadSlidesChoice(projectId: string): Promise<boolean | null> {
  const { data, error } = await supabase.from("projects").select("s:shift_times->slides").eq("id", projectId).maybeSingle();
  if (error) throw new Error(error.message);
  const v = (data as { s?: { template?: unknown } | null } | null)?.s?.template;
  const out = typeof v === "boolean" ? v : null;
  cache.set(projectId, out);
  return out;
}

/** Save the switch for everyone on the project. Every other setting is kept. */
export async function saveSlidesChoice(projectId: string, template: boolean): Promise<void> {
  const { data: cur, error: readErr } = await supabase.from("projects").select("shift_times").eq("id", projectId).maybeSingle();
  if (readErr) throw new Error(`Not saved: ${readErr.message}`);
  const next: Record<string, unknown> = { ...((cur as { shift_times?: Record<string, unknown> | null } | null)?.shift_times ?? {}), slides: { template } };
  const { data, error } = await supabase.from("projects").update({ shift_times: next }).eq("id", projectId).select("id");
  if (error) throw new Error(`Not saved: ${error.message}`);
  if (!data || data.length === 0) throw new Error("Not saved - only the project owner or an admin can change this.");
  cache.set(projectId, template);
  try { window.dispatchEvent(new CustomEvent(EVENT, { detail: { projectId } })); } catch { /* SSR */ }
}

/** The project's switch: true (template), false (plain) or null (not set: template when there is one). */
export function useSlidesChoice(projectId?: string | null): { choice: boolean | null; loaded: boolean } {
  const [state, setState] = useState<{ id?: string | null; choice: boolean | null; loaded: boolean }>(() => ({ id: projectId, choice: projectId ? cache.get(projectId) ?? null : null, loaded: !!projectId && cache.has(projectId) }));
  useEffect(() => {
    if (!projectId) return;
    let live = true;
    if (!cache.has(projectId)) loadSlidesChoice(projectId).then((c) => { if (live) setState({ id: projectId, choice: c, loaded: true }); }).catch(() => { if (live) setState({ id: projectId, choice: null, loaded: true }); });
    const on = (e: Event) => { if ((e as CustomEvent<{ projectId: string }>).detail?.projectId === projectId) setState({ id: projectId, choice: cache.get(projectId) ?? null, loaded: true }); };
    window.addEventListener(EVENT, on);
    return () => { live = false; window.removeEventListener(EVENT, on); };
  }, [projectId]);
  return state.id === projectId ? { choice: state.choice, loaded: state.loaded } : { choice: projectId ? cache.get(projectId) ?? null : null, loaded: !!projectId && cache.has(projectId) };
}
