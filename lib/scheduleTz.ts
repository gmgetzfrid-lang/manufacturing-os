// scheduleTz — every schedule date in the app is read and written through
// the PROJECT's timezone (projects.timezone, an IANA name such as
// "America/Chicago"). A turnaround runs at one plant, so everyone on it
// must see the same day boundaries: "6:00 on Oct 14" means 6:00 at the
// plant whether the viewer is in Houston or on a laptop in Calgary.
//
// Storage is unchanged: milestones carry UTC instants. These helpers turn
// an instant into the plant's wall clock (for display and day bucketing)
// and a wall clock typed into a form back into an instant. Projects with
// no zone set behave exactly as before — UTC — so nothing moves until a
// user picks the plant's zone in project settings.
//
// No library: Intl.DateTimeFormat gives the offset for any instant, and
// the inverse (wall clock → instant) is the standard two-pass guess that
// stays correct across DST transitions.

export const DEFAULT_SCHEDULE_TZ = "UTC";

export interface WallClock {
  year: number;
  /** 1–12 */
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export function isValidTimeZone(tz: string | null | undefined): tz is string {
  if (!tz) return false;
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; }
  catch { return false; }
}

/** The zone to use for a project: its own, or UTC when unset/invalid. */
export function normalizeTimeZone(tz: string | null | undefined): string {
  return isValidTimeZone(tz) ? tz : DEFAULT_SCHEDULE_TZ;
}

/** The device's zone, for prefilling a new project. */
export function browserTimeZone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || DEFAULT_SCHEDULE_TZ; }
  catch { return DEFAULT_SCHEDULE_TZ; }
}

/** Every IANA zone the runtime knows, for a picker. */
export function listTimeZones(): string[] {
  try {
    const sv = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
    const list = sv ? sv.call(Intl, "timeZone") : [];
    return list.includes("UTC") ? list : ["UTC", ...list];
  } catch { return [DEFAULT_SCHEDULE_TZ]; }
}

const partsCache = new Map<string, Intl.DateTimeFormat>();
function partsFormatter(tz: string): Intl.DateTimeFormat {
  let f = partsCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    partsCache.set(tz, f);
  }
  return f;
}

/** The plant's wall clock for an instant. */
export function wallClock(ms: number, tz: string): WallClock {
  const out: WallClock = { year: 0, month: 0, day: 0, hour: 0, minute: 0, second: 0 };
  for (const p of partsFormatter(tz).formatToParts(new Date(ms))) {
    const v = Number(p.value);
    switch (p.type) {
      case "year": out.year = v; break;
      case "month": out.month = v; break;
      case "day": out.day = v; break;
      case "hour": out.hour = v % 24; break; // some engines print "24" at midnight
      case "minute": out.minute = v; break;
      case "second": out.second = v; break;
    }
  }
  return out;
}

function asUtc(w: WallClock): number {
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
}

/** Offset of the zone at an instant, in ms (positive east of UTC). */
export function tzOffsetMs(ms: number, tz: string): number {
  return asUtc(wallClock(ms, tz)) - ms;
}

/** The instant at which the plant's clock reads this wall time. Across a
 *  DST gap the nonexistent hour resolves forward; in an overlap the first
 *  occurrence wins. Day/hour overflow is allowed (day 32 → next month). */
export function wallClockToMs(w: WallClock, tz: string): number {
  const guess = asUtc(w);
  const first = guess - tzOffsetMs(guess, tz);
  const second = guess - tzOffsetMs(first, tz);
  return second;
}

/** "YYYY-MM-DD" of the plant day an instant falls on. */
export function dayKey(ms: number, tz: string): string {
  const w = wallClock(ms, tz);
  return `${w.year}-${String(w.month).padStart(2, "0")}-${String(w.day).padStart(2, "0")}`;
}

/** Midnight (plant time) of the given "YYYY-MM-DD". */
export function dayKeyToMs(key: string, tz: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!m) return NaN;
  return wallClockToMs({ year: +m[1], month: +m[2], day: +m[3], hour: 0, minute: 0, second: 0 }, tz);
}

/** Midnight (plant time) of the day the instant falls on. */
export function startOfDay(ms: number, tz: string): number {
  const w = wallClock(ms, tz);
  return wallClockToMs({ ...w, hour: 0, minute: 0, second: 0 }, tz);
}

/** Same wall clock, n plant-days later (23/25-hour DST days included). */
export function addDays(ms: number, n: number, tz: string): number {
  const w = wallClock(ms, tz);
  return wallClockToMs({ ...w, day: w.day + n }, tz);
}

/** Whole plant-days from a to b (b − a), by calendar date, DST-proof. */
export function dayDiff(aMs: number, bMs: number, tz: string): number {
  const a = wallClock(aMs, tz), b = wallClock(bMs, tz);
  return Math.round((Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / 86400000);
}

/** 0 = Sunday … 6 = Saturday, in plant time. */
export function dayOfWeek(ms: number, tz: string): number {
  const w = wallClock(ms, tz);
  return new Date(Date.UTC(w.year, w.month - 1, w.day)).getUTCDay();
}

/** First of the month (plant time) containing the instant, as an instant. */
export function startOfMonth(ms: number, tz: string): number {
  const w = wallClock(ms, tz);
  return wallClockToMs({ year: w.year, month: w.month, day: 1, hour: 0, minute: 0, second: 0 }, tz);
}

export function addMonths(ms: number, n: number, tz: string): number {
  const w = wallClock(ms, tz);
  const idx = w.month - 1 + n;
  const year = w.year + Math.floor(idx / 12);
  const month = ((idx % 12) + 12) % 12 + 1;
  return wallClockToMs({ year, month, day: 1, hour: 0, minute: 0, second: 0 }, tz);
}

/** True when the instant lands off midnight on the plant clock — i.e. the
 *  task carries a real time of day, not just a date. */
export function hasTimeOfDay(ms: number, tz: string): boolean {
  const w = wallClock(ms, tz);
  return w.hour !== 0 || w.minute !== 0;
}

/** "6:00" / "14:30" on the plant clock, "" at exactly midnight. */
export function clockLabel(ms: number, tz: string): string {
  if (!Number.isFinite(ms)) return "";
  const w = wallClock(ms, tz);
  if (w.hour === 0 && w.minute === 0) return "";
  // Always AM / PM: "5:09 PM", never "17:09".
  return `${w.hour % 12 || 12}:${String(w.minute).padStart(2, "0")} ${w.hour < 12 ? "AM" : "PM"}`;
}

/** Value for an <input type="datetime-local"> showing plant time. */
export function toDateTimeInput(iso: string | number | Date | null | undefined, tz: string): string {
  if (iso == null || iso === "") return "";
  const ms = toMs(iso);
  if (!Number.isFinite(ms)) return "";
  const w = wallClock(ms, tz);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${w.year}-${p(w.month)}-${p(w.day)}T${p(w.hour)}:${p(w.minute)}`;
}

/** Parse a datetime-local value ("YYYY-MM-DDTHH:mm[:ss]") as plant time. */
export function fromDateTimeInput(value: string | null | undefined, tz: string): string | null {
  if (!value) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if (!m) return null;
  const ms = wallClockToMs({ year: +m[1], month: +m[2], day: +m[3], hour: +m[4], minute: +m[5], second: m[6] ? +m[6] : 0 }, tz);
  return new Date(ms).toISOString();
}

/** Parse a date-only value ("YYYY-MM-DD") as plant time at the given hour. */
export function fromDateInput(value: string | null | undefined, tz: string, hour = 0, minute = 0): string | null {
  if (!value) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const ms = wallClockToMs({ year: +m[1], month: +m[2], day: +m[3], hour, minute, second: 0 }, tz);
  return new Date(ms).toISOString();
}

/** Interpret a timestamp string the way a schedule file means it: a bare
 *  date or a naive "2026-08-15 08:00" is plant wall-clock time; anything
 *  carrying its own offset ("Z", "+02:00") is kept as that instant. */
export function naiveToIso(raw: string, tz: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?$/.exec(s);
  if (m) {
    const ms = wallClockToMs({ year: +m[1], month: +m[2], day: +m[3], hour: m[4] ? +m[4] : 0, minute: m[5] ? +m[5] : 0, second: m[6] ? +m[6] : 0 }, tz);
    return new Date(ms).toISOString();
  }
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** Re-anchor an instant so the SAME wall clock holds in a different zone:
 *  "08:00 as UTC" becomes "08:00 as America/Chicago". Used when a project's
 *  zone changes and the schedule's times should stay as written. */
export function shiftWallClock(iso: string | number | Date, fromTz: string, toTz: string): string {
  const ms = toMs(iso);
  if (!Number.isFinite(ms)) return typeof iso === "string" ? iso : new Date(NaN).toString();
  return new Date(wallClockToMs(wallClock(ms, fromTz), toTz)).toISOString();
}

/** Short zone name at an instant: "CDT", "GMT+2", "UTC". */
export function tzAbbrev(tz: string, ms: number = Date.now()): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" }).formatToParts(new Date(ms));
    return parts.find((p) => p.type === "timeZoneName")?.value ?? tz;
  } catch { return tz; }
}

/** "America/Chicago (CDT)" — for badges and pickers. */
export function tzLabel(tz: string, ms: number = Date.now()): string {
  const abbr = tzAbbrev(tz, ms);
  return abbr === tz ? tz : `${tz.replace(/_/g, " ")} (${abbr})`;
}

/** toLocaleDateString / toLocaleString pinned to the plant zone. */
export function fmtInTz(ms: number | string | Date, tz: string, options: Intl.DateTimeFormatOptions): string {
  const n = toMs(ms);
  if (!Number.isFinite(n)) return "";
  return new Date(n).toLocaleString(undefined, { ...options, timeZone: tz });
}

export function toMs(v: string | number | Date | null | undefined): number {
  if (v == null || v === "") return NaN;
  if (v instanceof Date) return v.getTime();
  if (typeof v === "number") return v;
  return Date.parse(v);
}
