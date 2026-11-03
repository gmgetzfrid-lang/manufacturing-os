// ampm - a time put in that lands on the other crew's shift is likely AM
// and PM mixed up: 12:00 AM for noon on a day job reads as midnight, and
// the step shows as started 10 hours early. The same clock time 12 hours
// over, on the step's own crew's shift (and not later than now), is
// offered; the person picks.

import type { Milestone } from "@/types/schema";
import { shiftAt, workShiftOf, type ShiftTimes } from "@/lib/shiftReport";
import { fmtInTz } from "@/lib/scheduleTz";

const H12 = 12 * 3_600_000;

export interface AmPmSlip {
  /** The time as it would be with AM and PM the other way round. */
  other: number;
  /** "12:00 AM is midnight, on the night shift - this step's crew works days." */
  says: string;
  /** "12:00 PM" */
  otherLabel: string;
  /** "12:00 AM" */
  asPut: string;
}

const clock = (t: number, tz: string) => fmtInTz(t, tz, { hour: "numeric", minute: "2-digit", hour12: true });

/** A time on the other crew's shift, and the one it more likely is. Null:
 *  it's on the step's crew's shift, the step runs round the clock, or the
 *  other reading isn't on its shift either (or hasn't happened yet). */
export function ampmSlip(t: number, m: Milestone, tz: string, times: ShiftTimes, now = Date.now(), crewName?: string | null,
  /** The planned time it's to be read against (its planned start, or
   *  finish), for a step that runs round the clock. */
  planned?: number): AmPmSlip | null {
  if (!Number.isFinite(t)) return null;
  const hour = Number(fmtInTz(t, tz, { hour: "numeric", hour12: false }).replace(/\D/g, "")) % 24;
  const other = hour < 12 ? t + H12 : t - H12;
  if (other > now + 60_000) return null;
  const asPut = clock(t, tz), otherLabel = clock(other, tz);
  const midnight = hour === 0 ? " is midnight," : "";
  const crew = workShiftOf(m, tz, times);
  if (crew === "both") {
    // Round the clock: any hour can be right. Asked only when the other
    // reading is a good 6 hours nearer the plan.
    if (planned == null || !Number.isFinite(planned)) return null;
    const d1 = Math.abs(t - planned), d2 = Math.abs(other - planned);
    if (d1 < 6 * 3_600_000 || d2 > d1 - 6 * 3_600_000) return null;
    const h = Math.round(d1 / 3_600_000);
    return { other, asPut, otherLabel, says: `${asPut}${midnight || " is"} ${h} h ${t < planned ? "before" : "after"} its plan (${clock(planned, tz)}).` };
  }
  if (shiftAt(t, tz, times).kind === crew) return null;
  if (shiftAt(other, tz, times).kind !== crew) return null;
  const who = crewName?.trim() ? `${crewName.trim()} works` : "this step's crew works";
  return {
    other, asPut, otherLabel,
    says: `${asPut}${midnight} ${midnight ? "on" : "is on"} the ${crew === "day" ? "night" : "day"} shift - ${who} ${crew === "day" ? "days" : "nights"}.`,
  };
}
