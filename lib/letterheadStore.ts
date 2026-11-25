// letterheadStore — the project's letterhead for printed reports, shared.
//
// Kept with the project's shift settings (projects.shift_times.letterhead):
// one place for what the project's reports hang on. Read on its own, so the
// shift times never carry the pictures around; checked on the way in.

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { cleanLetterhead, type Letterhead } from "@/lib/letterhead";

const EVENT = "letterhead:changed";
const cache = new Map<string, Letterhead | null>();
// One read at a time per project, shared by every view that asks.
const reading = new Map<string, Promise<Letterhead | null>>();
const readOnce = (projectId: string) => {
  const p = reading.get(projectId) ?? loadLetterhead(projectId).finally(() => reading.delete(projectId));
  reading.set(projectId, p);
  return p;
};

export async function loadLetterhead(projectId: string): Promise<Letterhead | null> {
  const { data, error } = await supabase.from("projects").select("lh:shift_times->letterhead").eq("id", projectId).maybeSingle();
  if (error) throw new Error(error.message);
  const lh = cleanLetterhead((data as { lh?: unknown } | null)?.lh ?? null);
  cache.set(projectId, lh);
  return lh;
}

/** Save (or with null, remove) the letterhead for everyone on the project.
 *  The shift settings beside it are kept as they are. */
export async function saveLetterhead(projectId: string, lh: Letterhead | null): Promise<void> {
  const clean = lh ? cleanLetterhead({ ...lh, savedAt: new Date().toISOString() }) : null;
  if (lh && !clean) throw new Error("That letterhead couldn't be read - try another file.");
  const { data: cur, error: readErr } = await supabase.from("projects").select("shift_times").eq("id", projectId).maybeSingle();
  if (readErr) throw new Error(`Not saved: ${readErr.message}`);
  const next: Record<string, unknown> = { ...((cur as { shift_times?: Record<string, unknown> | null } | null)?.shift_times ?? {}) };
  if (clean) next.letterhead = clean; else delete next.letterhead;
  const { data, error } = await supabase.from("projects").update({ shift_times: next }).eq("id", projectId).select("id");
  if (error) throw new Error(/shift_times/.test(error.message) ? "Not saved - the project's settings column is missing (migration 20261027_project_shift_times.sql)." : `Not saved: ${error.message}`);
  if (!data || data.length === 0) throw new Error("Not saved - only the project owner or an admin can change the letterhead.");
  cache.set(projectId, clean);
  try { window.dispatchEvent(new CustomEvent(EVENT, { detail: { projectId } })); } catch { /* SSR */ }
}

/** The project's letterhead (null: none), and whether it's been read. */
export function useLetterhead(projectId?: string | null): { lh: Letterhead | null; loaded: boolean } {
  const [state, setState] = useState<{ projectId?: string | null; lh: Letterhead | null; loaded: boolean }>(() =>
    ({ projectId, lh: projectId ? cache.get(projectId) ?? null : null, loaded: !!projectId && cache.has(projectId) }));
  const same = state.projectId === projectId;
  useEffect(() => {
    if (!projectId) return;
    let live = true;
    // Read once per visit: the pictures aren't small.
    if (!cache.has(projectId)) {
      readOnce(projectId).then((lh) => { if (live) setState({ projectId, lh, loaded: true }); })
        .catch(() => { if (live) setState({ projectId, lh: cache.get(projectId) ?? null, loaded: true }); });
    }
    const on = (e: Event) => { if ((e as CustomEvent<{ projectId: string }>).detail?.projectId === projectId) setState({ projectId, lh: cache.get(projectId) ?? null, loaded: true }); };
    window.addEventListener(EVENT, on);
    return () => { live = false; window.removeEventListener(EVENT, on); };
  }, [projectId]);
  // Another project, or read already by another view: straight from the cache.
  return same && state.loaded ? { lh: state.lh, loaded: true } : { lh: projectId ? cache.get(projectId) ?? null : null, loaded: !!projectId && cache.has(projectId) };
}

/** The letterhead a project's printouts sit on: its own, else the
 *  workspace's (the company's letterhead is the same on every job: the one
 *  saved most recently on any of the workspace's projects). `from` names the
 *  project it was saved on when it isn't this one. */
export async function letterheadFor(orgId: string, projectId: string): Promise<{ lh: Letterhead | null; from: string | null }> {
  const own = await loadLetterhead(projectId).catch(() => null);
  if (own) return { lh: own, from: null };
  const { data } = await supabase.from("projects").select("id, name, saved:shift_times->letterhead->>savedAt").eq("org_id", orgId).neq("id", projectId);
  const withOne = ((data ?? []) as Array<{ id: string; name: string | null; saved: string | null }>).filter((p) => p.saved)
    .sort((a, b) => String(b.saved).localeCompare(String(a.saved)));
  for (const p of withOne.slice(0, 3)) {
    const lh = await loadLetterhead(p.id).catch(() => null);
    if (lh) return { lh, from: p.name ?? "another project" };
  }
  return { lh: null, from: null };
}

/** letterheadFor as a hook (undefined while it's read). */
export function useLetterheadFor(orgId: string | null | undefined, projectId: string | null | undefined): { lh: Letterhead | null; from: string | null } | undefined {
  const [state, setState] = useState<{ key: string; v: { lh: Letterhead | null; from: string | null } } | null>(null);
  const key = `${orgId ?? ""}|${projectId ?? ""}`;
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!orgId || !projectId) return;
    let live = true;
    void letterheadFor(orgId, projectId).then((v) => { if (live) setState({ key, v }); }, () => { if (live) setState({ key, v: { lh: null, from: null } }); });
    // A letterhead saved anywhere: read again.
    const on = () => setTick((t) => t + 1);
    window.addEventListener(EVENT, on);
    return () => { live = false; window.removeEventListener(EVENT, on); };
  }, [orgId, projectId, key, tick]);
  return state?.key === key ? state.v : undefined;
}
