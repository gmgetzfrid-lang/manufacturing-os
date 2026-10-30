// lib/criticalModeStore.ts — where the project's critical path comes from.
//
// "From the schedule file", "App's estimate" or "Only what I mark"
// (lib/criticalPath CriticalMode). Kept on the project so every screen and
// every printout agrees; a copy is cached in the browser so the schedule
// can read it at once, and a change is announced to every open view.

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import type { CriticalMode } from "@/lib/criticalPath";

const EVENT = "criticalmode:changed";
const key = (projectId: string) => `criticalMode:${projectId}`;
const MODES: CriticalMode[] = ["links", "file", "estimate", "none"];
const valid = (v: unknown): CriticalMode | null => (MODES.includes(v as CriticalMode) ? (v as CriticalMode) : null);

function readCached(projectId?: string | null): CriticalMode | null {
  if (!projectId) return null;
  try { return valid(localStorage.getItem(key(projectId))); } catch { return null; }
}

function cache(projectId: string, mode: CriticalMode | null) {
  try { if (mode) localStorage.setItem(key(projectId), mode); else localStorage.removeItem(key(projectId)); } catch { /* private mode */ }
  try { window.dispatchEvent(new CustomEvent(EVENT, { detail: { projectId } })); } catch { /* SSR */ }
}

export async function loadCriticalMode(projectId: string): Promise<CriticalMode | null> {
  const { data, error } = await supabase.from("projects").select("critical_mode").eq("id", projectId).maybeSingle();
  if (error || !data) return readCached(projectId);
  const mode = valid((data as { critical_mode?: string | null }).critical_mode);
  if (mode !== readCached(projectId)) cache(projectId, mode);
  return mode;
}

/** Save the choice for everyone on the project. */
export async function saveCriticalMode(projectId: string, mode: CriticalMode): Promise<void> {
  const { data, error } = await supabase.from("projects").update({ critical_mode: mode }).eq("id", projectId).select("id");
  if (error) {
    if (/critical_mode/.test(error.message)) {
      cache(projectId, mode);
      throw new Error(mode === "links"
        ? "Saved on this device only - run migration 20261106_links_and_discovery.sql so everyone on the project gets it."
        : "Saved on this device only - run migration 20261101_critical_path_control.sql so everyone on the project gets it.");
    }
    throw new Error(`Not saved: ${error.message}`);
  }
  if (!data || data.length === 0) throw new Error("Not saved - only the project owner or an admin can change this.");
  cache(projectId, mode);
}

/** The project's choice (null = not chosen: the file's flags if the import
 *  has them, else the estimate), kept current across views. */
export function useCriticalMode(projectId?: string | null): CriticalMode | null {
  const [state, setState] = useState<{ projectId?: string | null; mode: CriticalMode | null }>(() => ({ projectId, mode: readCached(projectId) }));
  const mode = state.projectId === projectId ? state.mode : readCached(projectId);
  useEffect(() => {
    if (!projectId) return;
    let live = true;
    loadCriticalMode(projectId).then((m) => { if (live) setState({ projectId, mode: m }); }).catch(() => undefined);
    const on = (e: Event) => {
      if ((e as CustomEvent<{ projectId: string }>).detail?.projectId === projectId) setState({ projectId, mode: readCached(projectId) });
    };
    window.addEventListener(EVENT, on);
    return () => { live = false; window.removeEventListener(EVENT, on); };
  }, [projectId]);
  return mode;
}

/** The project's choice and whether it has been read yet (a fresh device
 *  starts with nothing cached) — so a form doesn't offer to overwrite a
 *  saved choice it hasn't seen. */
export function useCriticalModeLoaded(projectId?: string | null): boolean {
  const [loaded, setLoaded] = useState<{ projectId?: string | null; ok: boolean }>({ projectId, ok: false });
  useEffect(() => {
    if (!projectId) return;
    let live = true;
    loadCriticalMode(projectId).then(() => { if (live) setLoaded({ projectId, ok: true }); }).catch(() => undefined);
    return () => { live = false; };
  }, [projectId]);
  return loaded.projectId === projectId && loaded.ok;
}
