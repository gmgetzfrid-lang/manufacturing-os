// shiftBands — which shift a step is worked on, by date: the day shift
// (5:30–17:30) or that date's night shift (17:30 → 5:30 the next morning).
// Night work after midnight belongs to the night before, the way the crews
// and the shift report count it. The calendar's day boxes and the day list
// split on this, so "yesterday's day shift" is exactly that shift's steps.

import type { Milestone } from "@/types/schema";
import { dayKey, dayKeyToMs, addDays } from "@/lib/scheduleTz";
import { DEFAULT_SHIFT_TIMES, shiftAt, shiftWindowsBetween, workShiftOf, workSpan, type ShiftTimes } from "@/lib/shiftReport";

export type Band = "day" | "night";

export interface BandDays {
  /** Dates whose day shift works the step ("2026-10-27"). */
  day: Set<string>;
  /** Dates whose night shift (that evening into the next morning) works it. */
  night: Set<string>;
}

const overlap = (a0: number, a1: number, b0: number, b1: number) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
// A step ending a few minutes past shift change isn't the next shift's work.
const SLIVER = 20 * 60_000;

/** The dates a span is on, first to last (an exclusive end at midnight
 *  doesn't count the next date). */
function datesOf(start: number, finish: number, tz: string): string[] {
  const out: string[] = [];
  const last = dayKey(Math.max(start, finish - 1), tz);
  for (let d = dayKey(start, tz), i = 0; d <= last && i < 400; d = dayKey(addDays(dayKeyToMs(d, tz), 1, tz), tz), i++) out.push(d);
  return out;
}

/** The day and night shifts a step is worked on. Its crew decides: day
 *  crew work is day work whatever hours the file gave it; night crew work
 *  is the night it falls in; round-the-clock work, every shift it touches. */
export function stepBandDays(m: Milestone, tz: string, times: ShiftTimes = DEFAULT_SHIFT_TIMES): BandDays {
  const out: BandDays = { day: new Set(), night: new Set() };
  const { start, finish, timed } = workSpan(m, tz);
  if (!Number.isFinite(start) || !Number.isFinite(finish)) return out;
  const crew = workShiftOf(m, tz, times);
  if (!timed) {
    // Date-only: its crew's shift on each date.
    for (const d of datesOf(start, finish, tz)) {
      if (crew !== "night") out.day.add(d);
      if (crew !== "day") out.night.add(d);
    }
    return out;
  }
  // The shifts its hours touch — a few minutes over a shift change don't count.
  let wins = finish > start
    ? shiftWindowsBetween(start, finish, tz, times).map((w) => ({ w, o: overlap(start, finish, w.start, w.end) })).filter((x) => x.o > 0)
    : [{ w: shiftAt(start, tz, times), o: 0 }];
  if (wins.some((x) => x.o >= SLIVER)) wins = wins.filter((x) => x.o >= SLIVER);
  const days = wins.filter((x) => x.w.kind === "day").map((x) => x.w.dayKey);
  const nights = wins.filter((x) => x.w.kind === "night").map((x) => x.w.dayKey);
  if (crew === "both") {
    for (const d of days) out.day.add(d);
    for (const d of nights) out.night.add(d);
  } else if (crew === "night") {
    // Night crew work at day hours (set by hand): the nights of its dates.
    for (const d of nights.length ? nights : datesOf(start, finish, tz)) out.night.add(d);
  } else {
    // Day crew work at night hours (no night crew on it): the days of its dates.
    for (const d of days.length ? days : datesOf(start, finish, tz)) out.day.add(d);
  }
  return out;
}

/** Every leaf step's shifts, by id — worked out once for the calendar. */
export function bandIndex(steps: Milestone[], tz: string, times: ShiftTimes = DEFAULT_SHIFT_TIMES): Map<string, BandDays> {
  const out = new Map<string, BandDays>();
  for (const m of steps) if (m.id) out.set(m.id, stepBandDays(m, tz, times));
  return out;
}
