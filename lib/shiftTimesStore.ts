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
  if (d > n) return "Day shift must start earlier in the day than night shift (e.g. 05:30 and 17:30).";
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
  const raw = (data as { shift_times: Partial<ShiftTimes> | null }).shift_times;
  const t = raw ? { ...DEFAULT_SHIFT_TIMES, ...raw } : DEFAULT_SHIFT_TIMES;
  const safe = shiftTimesProblem(t) ? DEFAULT_SHIFT_TIMES : t;
  const prev = readShiftTimes(projectId);
  if (prev.dayStart !== safe.dayStart || prev.nightStart !== safe.nightStart) cache(projectId, safe);
  return safe;
}

/** Save the times for everyone on the project. */
export async function saveProjectShiftTimes(projectId: string, t: ShiftTimes): Promise<void> {
  const problem = shiftTimesProblem(t);
  if (problem) throw new Error(problem);
  const clean = { dayStart: t.dayStart.trim().padStart(5, "0"), nightStart: t.nightStart.trim().padStart(5, "0") };
  const { error } = await supabase.from("projects").update({ shift_times: clean }).eq("id", projectId);
  cache(projectId, clean);
  if (error) {
    if (/shift_times/.test(error.message)) throw new Error("Saved on this device only — run migration 20261027_project_shift_times.sql so everyone on the project gets these times.");
    throw new Error(`Saved on this device only: ${error.message}`);
  }
}

/** The project's shift times, kept current: loads once, follows changes
 *  made in any view of this browser. */
export function useShiftTimes(projectId?: string | null): ShiftTimes {
  const [state, setState] = useState<{ projectId?: string | null; t: ShiftTimes }>(() => ({ projectId, t: readShiftTimes(projectId) }));
  // A different project: read its cached times at once (no effect needed).
  const t = state.projectId === projectId ? state.t : readShiftTimes(projectId);
  const setT = (x: ShiftTimes) => setState({ projectId, t: x });
  useEffect(() => {
    if (!projectId) return;
    let live = true;
    loadProjectShiftTimes(projectId).then((x) => { if (live) setT(x); }).catch(() => undefined);
    const on = (e: Event) => {
      if ((e as CustomEvent<{ projectId: string }>).detail?.projectId === projectId) setT(readShiftTimes(projectId));
    };
    window.addEventListener(EVENT, on);
    return () => { live = false; window.removeEventListener(EVENT, on); };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- setT is rebuilt each render; projectId is what matters
  }, [projectId]);
  return t;
}
