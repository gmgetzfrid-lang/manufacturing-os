// lib/shiftTimesStore.ts — the project's shift-change times, shared.
//
// Day and night are split at the times the site uses (meetings at 5:30,
// shifts at 6:00 …). Kept on the project so every laptop and tablet splits
// work the same way; a copy is cached in the browser so the schedule can
// read it at once, and a change is announced to every open view.

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { DEFAULT_SHIFT_TIMES, readShiftTimes, type ShiftTimes } from "@/lib/shiftReport";

const EVENT = "shifttimes:changed";
const key = (projectId: string) => `shiftTimes:${projectId}`;

const hm = (s: string) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec((s || "").trim());
  return m && +m[1] < 24 && +m[2] < 60 ? +m[1] * 60 + +m[2] : null;
};

/** Why these times can't be used, or null when they're fine. Day must
 *  start earlier in the day than night (05:30 / 17:30, not the reverse). */
export function shiftTimesProblem(t: ShiftTimes): string | null {
  const d = hm(t.dayStart), n = hm(t.nightStart);
  if (d == null || n == null) return "Use 24-hour times like 05:30.";
  if (d === n) return "Day and night can't start at the same time.";
  if (d > n) return "Day shift must start earlier in the day than night shift (e.g. 06:00 and 18:00).";
  const lead = t.meetingBefore;
  if (lead != null && !(Number.isFinite(lead) && lead >= 0 && lead <= 180)) return "The meeting lead must be 0–180 minutes before the shift change.";
  return null;
}

function cache(projectId: string, t: ShiftTimes) {
  try { localStorage.setItem(key(projectId), JSON.stringify(t)); } catch { /* private mode */ }
  try { window.dispatchEvent(new CustomEvent(EVENT, { detail: { projectId } })); } catch { /* SSR */ }
}

/** Load the project's times from the database (falls back to this
 *  browser's copy when the column isn't there yet). */
export async function loadProjectShiftTimes(projectId: string): Promise<ShiftTimes> {
  const { data, error } = await supabase.from("projects").select("shift_times").eq("id", projectId).maybeSingle();
  if (error || !data) return readShiftTimes(projectId);
  const raw = (data as { shift_times: (Partial<ShiftTimes> & { letterhead?: unknown }) | null }).shift_times;
  // The letterhead lives beside the times (lib/letterheadStore) — not carried here.
  const { letterhead: _letterhead, ...times } = raw ?? {};
  const t = raw ? { ...DEFAULT_SHIFT_TIMES, ...times } : DEFAULT_SHIFT_TIMES;
  const safe = shiftTimesProblem(t) ? DEFAULT_SHIFT_TIMES : t;
  const prev = readShiftTimes(projectId);
  if (JSON.stringify(prev) !== JSON.stringify(safe)) cache(projectId, safe);
  return safe;
}

/** A crew size the app can count with: 0–50 hands, 0–24 h. */
export function cleanPullCrew(c: { crew?: string | null; hands?: number; hours?: number }): { crew: string | null; hands: number; hours: number } {
  const n = (v: unknown, max: number, dflt: number) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(max, Math.round(v * 10) / 10)) : dflt);
  return { crew: (c.crew ?? "").trim() || null, hands: n(c.hands, 50, 2), hours: n(c.hours, 24, 12) };
}

/** Save the times for everyone on the project. */
export async function saveProjectShiftTimes(projectId: string, t: ShiftTimes): Promise<void> {
  const problem = shiftTimesProblem(t);
  if (problem) throw new Error(problem);
  const clean: ShiftTimes = {
    dayStart: t.dayStart.trim().padStart(5, "0"), nightStart: t.nightStart.trim().padStart(5, "0"),
    ...(t.meetingBefore != null ? { meetingBefore: Math.round(t.meetingBefore) } : {}),
    // Which jobs have a night crew (lib/nightStaffing) — kept with the times.
    ...(t.nightJobs === "file" || Array.isArray(t.nightJobs) ? { nightJobs: t.nightJobs === "file" ? "file" : t.nightJobs.filter((x) => typeof x === "string") } : {}),
    ...(t.helpers ? { helpers: cleanPullCrew(t.helpers) } : {}),
  };
  // Keep the letterhead saved beside the times (lib/letterheadStore).
  const { data: kept } = await supabase.from("projects").select("lh:shift_times->letterhead").eq("id", projectId).maybeSingle();
  const lh = (kept as { lh?: unknown } | null)?.lh;
  const { data, error } = await supabase.from("projects").update({ shift_times: lh ? { ...clean, letterhead: lh } : clean }).eq("id", projectId).select("id");
  if (error) {
    // The column isn't there yet: keep them on this device meanwhile.
    if (/shift_times/.test(error.message)) {
      cache(projectId, clean);
      throw new Error("Saved on this device only — run migration 20261027_project_shift_times.sql so everyone on the project gets these times.");
    }
    throw new Error(`Not saved: ${error.message}`);
  }
  // The database saved nothing (not allowed to change this project).
  if (!data || data.length === 0) throw new Error("Not saved — only the project owner or an admin can change the shift times.");
  cache(projectId, clean);
}

/** The project's shift times, kept current: loads once, follows changes
 *  made in any view of this browser. */
export function useShiftTimes(projectId?: string | null): ShiftTimes {
  return useShiftTimesState(projectId).times;
}

/** The times, and whether the project's own copy has been read yet — until
 *  then they're this browser's cached copy (or the 05:30 / 17:30 guess on a
 *  device that has none), which mustn't be taken for "not set". */
export function useShiftTimesState(projectId?: string | null): { times: ShiftTimes; loaded: boolean } {
  const [state, setState] = useState<{ projectId?: string | null; t: ShiftTimes; loaded: boolean }>(() => ({ projectId, t: readShiftTimes(projectId), loaded: false }));
  // A different project: read its cached times at once (no effect needed).
  const same = state.projectId === projectId;
  const t = same ? state.t : readShiftTimes(projectId);
  const setT = (x: ShiftTimes) => setState({ projectId, t: x, loaded: true });
  useEffect(() => {
    if (!projectId) return;
    let live = true;
    loadProjectShiftTimes(projectId).then((x) => { if (live) setT(x); }).catch(() => { if (live) setT(readShiftTimes(projectId)); });
    const on = (e: Event) => {
      if ((e as CustomEvent<{ projectId: string }>).detail?.projectId === projectId) setT(readShiftTimes(projectId));
    };
    window.addEventListener(EVENT, on);
    return () => { live = false; window.removeEventListener(EVENT, on); };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- setT is rebuilt each render; projectId is what matters
  }, [projectId]);
  return { times: t, loaded: same && state.loaded };
}

/** Have the project's shift times been saved, or is the app still on its
 *  05:30 / 17:30 guess? Null while loading. Kept current after a save. */
export function useShiftTimesSaved(projectId?: string | null): boolean | null {
  const [state, setState] = useState<{ projectId?: string | null; saved: boolean | null }>({ projectId, saved: null });
  useEffect(() => {
    if (!projectId) return;
    let live = true;
    const check = () => shiftTimesSaved(projectId).then((v) => { if (live) setState({ projectId, saved: v }); }).catch(() => undefined);
    void check();
    const on = (e: Event) => { if ((e as CustomEvent<{ projectId: string }>).detail?.projectId === projectId) void check(); };
    window.addEventListener(EVENT, on);
    return () => { live = false; window.removeEventListener(EVENT, on); };
  }, [projectId]);
  return state.projectId === projectId ? state.saved : null;
}

async function shiftTimesSaved(projectId: string): Promise<boolean | null> {
  const { data, error } = await supabase.from("projects").select("shift_times").eq("id", projectId).maybeSingle();
  if (error) {
    // The column isn't there yet: a copy saved on this device counts. Any
    // other failure: unknown — neither shouted about nor shown as set.
    if (!/shift_times/.test(error.message)) return null;
    try { return localStorage.getItem(key(projectId)) != null; } catch { return null; }
  }
  if (!data) return null;
  const raw = (data as { shift_times: Partial<ShiftTimes> | null }).shift_times;
  // Stored but unusable is the same as not set: the app is on its guess.
  return raw != null && !shiftTimesProblem({ ...DEFAULT_SHIFT_TIMES, ...raw });
}
