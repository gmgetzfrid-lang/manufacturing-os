// stepShift - putting one step on the night (or day) shift: its planned
// times move into that shift's hours on the same plant day, its length
// kept, and the step is marked for that crew so the night setup never
// hands it back to days (lib/nightStaffing).
//
// Pure: no database here.

import type { Milestone } from "@/types/schema";
import { shiftAt, shiftWindow, nextShift, type ShiftTimes, type ShiftWindow } from "@/lib/shiftReport";

const ms = (v: unknown) => {
  const t = v instanceof Date ? v.getTime() : typeof v === "number" ? v : typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : NaN;
};

/** The shift a step's start falls in. */
export function shiftOfStart(m: Pick<Milestone, "plannedStartAt" | "plannedAt">, tz: string, times: ShiftTimes): ShiftWindow | null {
  const s = ms(m.plannedStartAt ?? m.plannedAt);
  return Number.isFinite(s) ? shiftAt(s, tz, times) : null;
}

/** Its new planned times on `kind`: a day step goes to that day's night
 *  (6 PM on); a night step goes to the next morning's day shift. Already
 *  on that shift: unchanged. A shift that's over is skipped for the next
 *  one of that kind. Null when it has no planned times. */
export function timesOnShift(m: Pick<Milestone, "plannedStartAt" | "plannedAt">, kind: "day" | "night", tz: string, times: ShiftTimes, now: number): { start: number; finish: number } | null {
  const s = ms(m.plannedStartAt ?? m.plannedAt), f = ms(m.plannedAt);
  if (!Number.isFinite(s) || !Number.isFinite(f)) return null;
  const len = Math.max(15 * 60_000, f - s);
  const cur = shiftAt(s, tz, times);
  if (cur.kind === kind) return { start: s, finish: s + len };
  let w = kind === "night" ? shiftWindow(cur.dayKey, "night", tz, times) : nextShift(cur, tz, times);
  for (let g = 0; g < 60 && (w.kind !== kind || w.end <= now); g++) w = nextShift(w, tz, times);
  return { start: w.start, finish: w.start + len };
}
