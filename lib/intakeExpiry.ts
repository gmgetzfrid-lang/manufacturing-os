// intakeExpiry - when a contractor's submit link stops working, and moving
// that date out. A link runs to the end of its last day (on this device's
// clock, as the date was picked). Extending counts from today when the link
// has already run out, else from the day it was going to stop.

/** The end of a picked day ("2026-11-20"), as the instant stored. */
export function endOfDayIso(day: string): string {
  return new Date(`${day}T23:59:59`).toISOString();
}

/** The picked day an expiry reads as on this device ("2026-11-20"). */
export function dayOfIso(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export const isExpired = (iso: string | null, now = Date.now()): boolean => !!iso && Date.parse(iso) <= now;

/** The new expiry `days` on: from the old expiry, or from today if it has
 *  passed (an expired link extended by 7 days works for 7 more days). */
export function extendedExpiry(currentIso: string | null, days: number, now = Date.now()): string {
  const d = new Date(currentIso && Date.parse(currentIso) > now ? Date.parse(currentIso) : now);
  // Calendar days, so a clock change in between never adds or loses one.
  d.setDate(d.getDate() + days);
  return endOfDayIso(dayOfIso(d.toISOString()));
}
