// lib/jobsSchedule.ts - a schedule made from the project's jobs, for a job
// with no P6 or MS Project file. Each job is a step with the hours the
// planner gives it, one after another from the start, on day shifts only
// unless nights are worked. Jobs on the same equipment sit under it. Pure:
// times are plant wall-clock "YYYY-MM-DD HH:mm"; the importer
// (lib/milestones importMilestonesFromParsed) turns them into instants.

import type { ParsedMilestoneRow } from "@/lib/milestones";
import { isTypedItem, type ScopeWO } from "@/lib/woIntake";

export interface WorkWindow { dayStart: string; nightStart: string; nights: boolean }

const DAY = 1440;
const hm = (s: string) => { const m = /^(\d{1,2}):(\d{2})/.exec(s); return m ? +m[1] * 60 + +m[2] : 0; };

/** "2026-12-01T06:00" or "2026-12-01 06:00" → minutes on a plain calendar. */
export function wallMinutes(s: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(s.trim());
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) / 60000 : null;
}
export function wallText(min: number): string { return new Date(min * 60000).toISOString().slice(0, 16).replace("T", " "); }

/** The working day: day shift start to night shift start, or the whole day
 *  when nights are worked. */
function windowOf(w: WorkWindow): { open: number; close: number } | null {
  if (w.nights) return null;
  const open = hm(w.dayStart), close = hm(w.nightStart);
  return close > open ? { open, close } : null;
}

/** The first working minute at or after `at`. */
export function nextWorking(at: number, w: WorkWindow): number {
  const win = windowOf(w);
  if (!win) return at;
  const base = Math.floor(at / DAY) * DAY;
  if (at < base + win.open) return base + win.open;
  if (at >= base + win.close) return base + DAY + win.open;
  return at;
}

/** When `hours` of work started at `at` finish, the night skipped when
 *  nights aren't worked. */
export function afterWork(at: number, hours: number, w: WorkWindow): number {
  const win = windowOf(w);
  let left = Math.round(hours * 60);
  if (!win) return at + left;
  let t = nextWorking(at, w);
  while (left > 0) {
    const close = Math.floor(t / DAY) * DAY + win.close;
    const take = Math.min(left, close - t);
    t += take; left -= take;
    if (left > 0) t = nextWorking(t, w);
  }
  return t;
}

const keyOf = (x: ScopeWO) => (x.tag || x.equipment || "").trim();

/** The jobs in schedule order: grouped by equipment in the order each piece
 *  first shows, the jobs on it in list order. */
export function inOrder<T extends { item: ScopeWO }>(jobs: T[]): T[] {
  const seen = new Map<string, T[]>();
  let loose = 0;
  for (const j of jobs) {
    // A job with no equipment keeps its own place.
    const k = keyOf(j.item) || `\u0000${loose++}`;
    const g = seen.get(k);
    if (g) g.push(j); else seen.set(k, [j]);
  }
  return [...seen.values()].flat();
}

/** The schedule rows, and when the last job finishes. Every job needs
 *  hours above zero; jobs without are left out (the dialog asks first). */
export function jobsSchedule(jobs: Array<{ item: ScopeWO; hours: number }>, start: string, w: WorkWindow): { rows: ParsedMilestoneRow[]; finish: string | null } {
  const t0 = wallMinutes(start);
  if (t0 == null) return { rows: [], finish: null };
  const timed: Array<{ item: ScopeWO; hours: number; s: number; f: number }> = [];
  let t = t0;
  for (const j of inOrder(jobs.filter((x) => Number.isFinite(x.hours) && x.hours > 0))) {
    const s = nextWorking(t, w);
    const f = afterWork(s, j.hours, w);
    timed.push({ ...j, s, f });
    t = f;
  }
  const rows: ParsedMilestoneRow[] = [];
  let top = 0, prev: string | null = null;
  const groups = new Map<string, { at: number; n: number }>();
  for (const j of timed) {
    const k = keyOf(j.item);
    let parent: string | null = null, wbs: string;
    if (k) {
      let g = groups.get(k);
      if (!g) {
        top += 1;
        g = { at: rows.length, n: 0 };
        groups.set(k, g);
        const on = timed.filter((x) => keyOf(x.item) === k);
        rows.push({
          name: j.item.tag ? `${j.item.tag}${j.item.equipmentName ? ` ${j.item.equipmentName}` : ""}` : k,
          externalRef: `eq:${k}`, isSummary: true, outlineLevel: 1, wbs: String(top),
          plannedStartAt: wallText(on[0].s), plannedAt: wallText(on[on.length - 1].f),
        });
      }
      g.n += 1;
      parent = `eq:${k}`;
      wbs = `${rows[g.at].wbs}.${g.n}`;
    } else { top += 1; wbs = String(top); }
    const ref = `job:${j.item.wo}`;
    rows.push({
      name: j.item.what, externalRef: ref, parentExternalRef: parent, outlineLevel: parent ? 2 : 1, wbs,
      plannedStartAt: wallText(j.s), plannedAt: wallText(j.f), durationHours: j.hours,
      workOrderRef: isTypedItem(j.item.wo) ? null : j.item.wo,
      dependsOnExternalRefs: prev ? [prev] : [],
    });
    prev = ref;
  }
  return { rows, finish: timed.length ? wallText(timed[timed.length - 1].f) : null };
}

/** "Tue, Dec 1, 6:00 PM" from a wall-clock time. */
export function sayWall(s: string): string {
  const m = wallMinutes(s);
  return m == null ? s : new Date(m * 60000).toLocaleString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
