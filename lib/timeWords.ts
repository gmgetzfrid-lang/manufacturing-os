// timeWords — times as the schedule says them, always with their date: a
// multi-week job has more than one Monday.

import { fmtInTz, dayKey } from "@/lib/scheduleTz";

/** "Mon, Oct 26, 10:00 AM". */
export function whenDated(t: number, tz: string): string {
  return Number.isFinite(t) ? fmtInTz(t, tz, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true }) : "-";
}

/** "Mon, Oct 26, 8:00 AM → 10:00 AM" — the finish's date only when it's another day. */
export function spanDated(a: number, b: number, tz: string): string {
  if (!Number.isFinite(a)) return whenDated(b, tz);
  if (!Number.isFinite(b)) return `${whenDated(a, tz)} → …`;
  const end = dayKey(a, tz) === dayKey(b, tz)
    ? fmtInTz(b, tz, { hour: "numeric", minute: "2-digit", hour12: true })
    : whenDated(b, tz);
  return `${whenDated(a, tz)} → ${end}`;
}

/** "30 min", "2 h", "4.5 h". */
export function hoursShort(h: number): string {
  return h < 1 ? `${Math.max(1, Math.round(h * 60))} min` : `${Math.round(h * 10) / 10} h`;
}
