// lib/scheduleTime.ts — times on the schedule, read the way a turnaround runs.
//
// A turnaround is planned in hours: "pull blinds 6:00–10:00, hydro
// 18:00–22:00". Shown by whole days those two look the same, and sorted by a
// parent's stored date a phase can land after the work inside it. These
// helpers place and label work by its actual clock times, in the plant's
// zone, and keep date-only schedules (an import with no times) looking as
// they always did: whole days, inclusive.

import { dayDiff, fmtInTz, clockLabel, hasTimeOfDay, wallClock } from "@/lib/scheduleTz";

export interface Timed { id?: string | null; parentId?: string | null; plannedStartAt?: unknown; plannedAt?: unknown }

const toMs = (v: unknown): number =>
  v == null ? NaN : v instanceof Date ? v.getTime() : typeof v === "number" ? v : typeof v === "string" ? Date.parse(v) : NaN;

export const startOf = (m: Timed): number => toMs(m.plannedStartAt ?? m.plannedAt);
export const finishOf = (m: Timed): number => toMs(m.plannedAt);

/** When each task really runs: a leaf its own dates, a parent from the
 *  earliest start to the latest finish of the work under it (its stored
 *  dates can disagree with its steps). */
export function effectiveSpans(items: Timed[]): Map<string, { start: number; finish: number }> {
  const kids = new Map<string, Timed[]>();
  for (const m of items) if (m.parentId) kids.set(m.parentId, [...(kids.get(m.parentId) ?? []), m]);
  const memo = new Map<string, { start: number; finish: number }>();
  const visit = (m: Timed, guard: Set<string>): { start: number; finish: number } => {
    const id = m.id ?? "";
    if (id && memo.has(id)) return memo.get(id)!;
    const ch = id ? kids.get(id) ?? [] : [];
    let s = NaN, f = NaN;
    if (ch.length && id && !guard.has(id)) {
      guard.add(id);
      for (const c of ch) {
        const sp = visit(c, guard);
        if (Number.isFinite(sp.start) && !(sp.start >= s)) s = sp.start;
        if (Number.isFinite(sp.finish) && !(sp.finish <= f)) f = sp.finish;
      }
      guard.delete(id);
    }
    const out = { start: Number.isFinite(s) ? s : startOf(m), finish: Number.isFinite(f) ? f : finishOf(m) };
    if (id) memo.set(id, out);
    return out;
  };
  for (const m of items) visit(m, new Set());
  return memo;
}

/** Each task's real start (see effectiveSpans). */
export function effectiveStarts(items: Timed[]): Map<string, number> {
  return new Map([...effectiveSpans(items)].map(([k, v]) => [k, v.start]));
}

/** Sibling order: by real start, then WBS, then name. */
export function byStart(starts: Map<string, number>, wbsCompare: (a?: string | null, b?: string | null) => number) {
  return (a: Timed & { wbs?: string | null; name?: string }, b: Timed & { wbs?: string | null; name?: string }): number => {
    const sa = (a.id ? starts.get(a.id) : undefined) ?? startOf(a);
    const sb = (b.id ? starts.get(b.id) : undefined) ?? startOf(b);
    const fa = Number.isFinite(sa), fb = Number.isFinite(sb);
    if (fa !== fb) return fa ? -1 : 1;            // undated last
    if (fa && sa !== sb) return sa - sb;
    return wbsCompare(a.wbs, b.wbs) || (a.name ?? "").localeCompare(b.name ?? "");
  };
}

/** "Thu Oct 22 6:00 AM → 10:00 AM", "Thu Oct 22 6:00 PM → Fri 6:00 AM", or for a
 *  date-only task "Oct 22" / "Oct 22 – Oct 24 · 3d". */
export function spanLabel(s: number, f: number, tz: string): string {
  if (!Number.isFinite(s) || !Number.isFinite(f)) return Number.isFinite(f) ? fmtInTz(f, tz, { month: "short", day: "numeric" }) : "No dates";
  const timed = hasTimeOfDay(s, tz) || hasTimeOfDay(f, tz);
  const day = (ms: number) => fmtInTz(ms, tz, { weekday: "short", month: "short", day: "numeric" });
  if (!timed) {
    const n = dayDiff(s, f, tz) + 1;
    const d = (ms: number) => fmtInTz(ms, tz, { month: "short", day: "numeric" });
    return n <= 1 ? d(f) : `${d(s)} – ${d(f)} · ${n}d`;
  }
  const t = (ms: number) => clockLabel(ms, tz) || "12:00 AM";
  const days = dayDiff(s, f, tz);
  if (days === 0) return `${day(s)} ${t(s)} → ${t(f)}`;
  // Ends at midnight: "→ 12:00 AM" on the start day reads better than "Fri 12:00 AM".
  if (days === 1 && !hasTimeOfDay(f, tz)) return `${day(s)} ${t(s)} → 12:00 AM`;
  const endDay = days < 7 ? fmtInTz(f, tz, { weekday: "short" }) : fmtInTz(f, tz, { month: "short", day: "numeric" });
  return `${day(s)} ${t(s)} → ${endDay} ${t(f)}`;
}

/** Where a moment sits on a day-scaled axis that starts at `domainStart`
 *  (plant midnight): whole days by the calendar, the rest by the clock — so
 *  it lines up with the day ticks even across a DST change. */
export function xAt(ms: number, domainStart: number, pxPerDay: number, tz: string): number {
  const w = wallClock(ms, tz);
  return (dayDiff(domainStart, ms, tz) + (w.hour * 60 + w.minute) / 1440) * pxPerDay;
}

/** A bar's left edge and width. Timed work spans its clock times; a
 *  date-only task fills its days, inclusive, as before. */
export function barGeometry(s: number, f: number, domainStart: number, pxPerDay: number, tz: string): { left: number; width: number } {
  const left = xAt(s, domainStart, pxPerDay, tz);
  const timed = hasTimeOfDay(s, tz) || hasTimeOfDay(f, tz);
  const right = timed ? xAt(f, domainStart, pxPerDay, tz) : xAt(f, domainStart, pxPerDay, tz) + pxPerDay;
  return { left, width: Math.max(4, right - left - 1) };
}

/** Hour step for axis labels at a zoom (px per day), or 0 for none. */
export function hourStep(pxPerDay: number): number {
  const pxPerHour = pxPerDay / 24;
  return pxPerHour >= 40 ? 1 : pxPerHour >= 20 ? 2 : pxPerHour >= 12 ? 3 : pxPerHour >= 6 ? 6 : pxPerHour >= 3.5 ? 12 : 0;
}
