// shiftReport — the shift-change briefing, computed from the schedule.
//
// A turnaround runs on two crews. At each hand-over (05:30 and 17:30 by
// default, plant time) the supervisor needs, on one page:
//   1. Where the job stands overall: actual % against where the plan said
//      we should be right now, so "ahead" or "behind" is a number.
//   2. What the shift that just ended was supposed to do, and what it did:
//      done / in progress / not started, and the CARRY-OVER — work that
//      should have been finished by the end of the shift and wasn't.
//   3. The goals for the next shift: its planned work plus every carry-
//      over, with the items on the critical path on top, so the crew knows
//      what gets the job back on track.
//   4. Anything blocked or on hold, with the reason.
// Pure functions; the view only formats.

import type { Milestone, MilestoneStatus } from "@/types/schema";
import { effectiveWeight, leafPercent, overallPercent, type ProgressInfo } from "@/lib/scheduleProgress";
import { dayKey, dayKeyToMs, wallClock, wallClockToMs, addDays, dayDiff } from "@/lib/scheduleTz";
import { startMsOf, finishMsOf, wbsCompare } from "@/lib/calendarPlacement";

export type ShiftKind = "day" | "night";

export interface ShiftTimes {
  /** "HH:MM" plant time the day shift starts (night shift ends). */
  dayStart: string;
  /** "HH:MM" plant time the night shift starts (day shift ends). */
  nightStart: string;
}

export const DEFAULT_SHIFT_TIMES: ShiftTimes = { dayStart: "05:30", nightStart: "17:30" };

export interface ShiftWindow {
  kind: ShiftKind;
  /** The plant day the shift belongs to ("YYYY-MM-DD"); a night shift
   *  belongs to the day it starts on. */
  dayKey: string;
  start: number;
  end: number;
}

function parseHm(s: string, fallback: string): { h: number; m: number } {
  const m = /^(\d{1,2}):(\d{2})$/.exec((s || "").trim()) ?? /^(\d{1,2}):(\d{2})$/.exec(fallback)!;
  return { h: Math.min(23, Number(m[1])), m: Math.min(59, Number(m[2])) };
}

function atTime(day: string, hm: { h: number; m: number }, tz: string): number {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day)!;
  return wallClockToMs({ year: +d[1], month: +d[2], day: +d[3], hour: hm.h, minute: hm.m, second: 0 }, tz);
}

/** The shift window for a given plant day and kind. */
export function shiftWindow(day: string, kind: ShiftKind, tz: string, times: ShiftTimes = DEFAULT_SHIFT_TIMES): ShiftWindow {
  const ds = parseHm(times.dayStart, DEFAULT_SHIFT_TIMES.dayStart);
  const ns = parseHm(times.nightStart, DEFAULT_SHIFT_TIMES.nightStart);
  if (kind === "day") return { kind, dayKey: day, start: atTime(day, ds, tz), end: atTime(day, ns, tz) };
  const nextDay = dayKey(addDays(dayKeyToMs(day, tz), 1, tz), tz);
  return { kind, dayKey: day, start: atTime(day, ns, tz), end: atTime(nextDay, ds, tz) };
}

/** The shift that contains an instant. */
export function shiftAt(ms: number, tz: string, times: ShiftTimes = DEFAULT_SHIFT_TIMES): ShiftWindow {
  const k = dayKey(ms, tz);
  const day = shiftWindow(k, "day", tz, times);
  if (ms >= day.start && ms < day.end) return day;
  if (ms >= day.end) return shiftWindow(k, "night", tz, times);
  const prev = dayKey(addDays(dayKeyToMs(k, tz), -1, tz), tz);
  return shiftWindow(prev, "night", tz, times);
}

export function nextShift(w: ShiftWindow, tz: string, times: ShiftTimes = DEFAULT_SHIFT_TIMES): ShiftWindow {
  if (w.kind === "day") return shiftWindow(w.dayKey, "night", tz, times);
  const nextDay = dayKey(addDays(dayKeyToMs(w.dayKey, tz), 1, tz), tz);
  return shiftWindow(nextDay, "day", tz, times);
}

export function previousShift(w: ShiftWindow, tz: string, times: ShiftTimes = DEFAULT_SHIFT_TIMES): ShiftWindow {
  if (w.kind === "night") return shiftWindow(w.dayKey, "day", tz, times);
  const prevDay = dayKey(addDays(dayKeyToMs(w.dayKey, tz), -1, tz), tz);
  return shiftWindow(prevDay, "night", tz, times);
}

/** The shift to open on: the one ending now while the job is running;
 *  before the job starts, the first shift with scheduled work; after it
 *  ends, the last one. Never an empty page by default. */
export function defaultReviewShift(milestones: Milestone[], now: number, tz: string, times: ShiftTimes = DEFAULT_SHIFT_TIMES): ShiftWindow {
  let first = Infinity, last = -Infinity;
  for (const m of milestones) {
    if (!m.plannedAt) continue;
    const s = startMsOf(m), f = finishMsOf(m);
    if (Number.isFinite(s)) first = Math.min(first, s);
    if (Number.isFinite(f)) last = Math.max(last, f);
  }
  const current = shiftAt(now - 3600_000, tz, times);
  if (!Number.isFinite(first)) return current;
  if (now < first) return shiftAt(first, tz, times);
  if (now > last) return shiftAt(last - 1, tz, times);
  return current;
}

/** The next shift after `from` that has any scheduled work, or null. */
export function nextShiftWithWork(milestones: Milestone[], from: ShiftWindow, tz: string, times: ShiftTimes = DEFAULT_SHIFT_TIMES, maxShifts = 400): ShiftWindow | null {
  const byId = new Map<string, Milestone>();
  for (const m of milestones) if (m.id) byId.set(m.id, m);
  const hasKids = new Set<string>();
  for (const m of milestones) if (m.parentId && byId.has(m.parentId)) hasKids.add(m.parentId);
  const leaves = milestones.filter((m) => m.plannedAt && !(m.id && hasKids.has(m.id)));
  let w = nextShift(from, tz, times);
  for (let i = 0; i < maxShifts; i++) {
    if (leaves.some((m) => startMsOf(m) < w.end && finishMsOf(m) > w.start)) return w;
    w = nextShift(w, tz, times);
  }
  return null;
}

export interface ShiftRow {
  leaf: Milestone;
  /** Ancestors, outermost first ("Turnaround › Maintenance › Exchangers"). */
  path: string[];
  /** Immediate parent (the equipment / step group), if any. */
  parentName: string | null;
  start: number;
  finish: number;
  percent: number;
  status: MilestoneStatus;
  /** Should have been finished before the next shift starts and isn't. */
  carryOver: boolean;
  /** On the finish-driving chain. */
  critical: boolean;
  /** Finishes inside the shift being looked at. */
  dueInShift: boolean;
  /** Starts inside the shift being looked at. */
  startsInShift: boolean;
  /** Listed on this shift although its schedule slot is elsewhere: done
   *  early/late during the shift, or open work from another slot. */
  offSchedule: boolean;
  reason: string | null;
}

export interface ShiftReport {
  tz: string;
  now: number;
  /** The shift under review (just ended, or ending). */
  shift: ShiftWindow;
  /** The shift being planned. */
  next: ShiftWindow;
  overall: {
    actualPct: number;
    plannedPct: number;
    /** actual − planned, percentage points. */
    variancePct: number;
    standing: "ahead" | "on track" | "behind";
    stepsDone: number;
    stepsTotal: number;
    plannedStart: number | null;
    plannedFinish: number | null;
    daysElapsed: number;
    daysTotal: number;
  };
  review: {
    scheduled: ShiftRow[];
    done: ShiftRow[];
    inProgress: ShiftRow[];
    notStarted: ShiftRow[];
    carryOver: ShiftRow[];
  };
  goals: {
    /** Everything the next shift should work: carry-overs first (critical
     *  ones on top), then the shift's planned work in time order. */
    all: ShiftRow[];
    carryOver: ShiftRow[];
    planned: ShiftRow[];
    critical: ShiftRow[];
  };
  blocked: ShiftRow[];
}

export interface BuildShiftReportInput {
  milestones: Milestone[];
  progress?: Map<string, ProgressInfo>;
  criticalIds?: Set<string>;
  tz: string;
  times?: ShiftTimes;
  /** The shift under review. */
  shift: ShiftWindow;
  /** "Now" for the planned-% comparison; defaults to the shift's end. */
  now?: number;
}

const DONE = (r: { status: MilestoneStatus; percent: number }) => r.status === "completed" || r.percent >= 100;

export function buildShiftReport(input: BuildShiftReportInput): ShiftReport {
  const { milestones, progress, tz } = input;
  const times = input.times ?? DEFAULT_SHIFT_TIMES;
  const criticalIds = input.criticalIds ?? new Set<string>();
  const shift = input.shift;
  const next = nextShift(shift, tz, times);
  const now = input.now ?? shift.end;

  const byId = new Map<string, Milestone>();
  const kids = new Map<string, Milestone[]>();
  for (const m of milestones) if (m.id) byId.set(m.id, m);
  for (const m of milestones) {
    if (m.parentId && byId.has(m.parentId)) kids.set(m.parentId, [...(kids.get(m.parentId) ?? []), m]);
  }
  const isLeaf = (m: Milestone) => !m.id || (kids.get(m.id) ?? []).length === 0;
  const pathOf = (m: Milestone): Milestone[] => {
    const out: Milestone[] = [];
    const guard = new Set<string>();
    let cur = m.parentId ? byId.get(m.parentId) : undefined;
    while (cur && cur.id && !guard.has(cur.id)) { guard.add(cur.id); out.push(cur); cur = cur.parentId ? byId.get(cur.parentId) : undefined; }
    return out; // nearest first
  };
  const pctOf = (m: Milestone) => (m.id ? progress?.get(m.id)?.percent : undefined) ?? leafPercent(m);

  const rowFor = (m: Milestone, win: ShiftWindow): ShiftRow => {
    const chain = pathOf(m);
    const s = startMsOf(m), f = finishMsOf(m);
    const percent = pctOf(m);
    return {
      leaf: m,
      path: chain.slice().reverse().map((a) => a.name),
      parentName: chain[0]?.name ?? null,
      start: s, finish: f, percent,
      status: m.status,
      carryOver: false,
      critical: !!m.id && criticalIds.has(m.id),
      dueInShift: f > win.start && f <= win.end,
      startsInShift: s >= win.start && s < win.end,
      offSchedule: !(s < win.end && f > win.start),
      reason: m.statusReason ?? null,
    };
  };
  const toMs = (v: unknown): number => (v == null ? NaN : v instanceof Date ? v.getTime() : typeof v === "number" ? v : Date.parse(String(v)));
  const inWin = (ms: number, win: ShiftWindow) => Number.isFinite(ms) && ms >= win.start && ms < win.end;

  const leaves = milestones.filter((m) => isLeaf(m) && m.plannedAt && Number.isFinite(startMsOf(m)) && Number.isFinite(finishMsOf(m)));
  const overlaps = (m: Milestone, win: ShiftWindow) => startMsOf(m) < win.end && finishMsOf(m) > win.start;
  const cmp = (a: ShiftRow, b: ShiftRow) =>
    (a.start - b.start) || (a.finish - b.finish) || wbsCompare(a.leaf.wbs, b.leaf.wbs) || a.leaf.name.localeCompare(b.leaf.name);

  // ── 1. Overall standing ──────────────────────────────────────────
  let wsum = 0, wplanned = 0, stepsDone = 0;
  let plannedStart = Infinity, plannedFinish = -Infinity;
  for (const m of leaves) {
    const s = startMsOf(m), f = finishMsOf(m);
    plannedStart = Math.min(plannedStart, s); plannedFinish = Math.max(plannedFinish, f);
    const w = effectiveWeight(m);
    const frac = f <= s ? (now >= f ? 1 : 0) : Math.max(0, Math.min(1, (now - s) / (f - s)));
    wsum += w; wplanned += w * frac;
    if (DONE({ status: m.status, percent: pctOf(m) })) stepsDone++;
  }
  const plannedPct = wsum > 0 ? Math.round((wplanned / wsum) * 100) : 0;
  const actualPct = overallPercent(milestones);
  const variancePct = actualPct - plannedPct;
  const standing: ShiftReport["overall"]["standing"] = variancePct >= 3 ? "ahead" : variancePct <= -3 ? "behind" : "on track";
  const hasSpan = Number.isFinite(plannedStart) && Number.isFinite(plannedFinish);
  const daysTotal = hasSpan ? Math.max(1, dayDiff(plannedStart, plannedFinish, tz) + 1) : 0;
  const daysElapsed = hasSpan ? Math.max(0, Math.min(daysTotal, dayDiff(plannedStart, now, tz) + 1)) : 0;

  // ── 2. Review of the shift ───────────────────────────────────────
  // "Scheduled" = the plan for this shift. "Done" = that plan's steps that
  // are complete PLUS anything whose completion was recorded during the
  // shift (finished early or late — it still got done on this shift).
  // "In progress" = ALL open work on the job, this shift's first, because
  // open work is what the next crew inherits wherever it was planned.
  const scheduled = leaves.filter((m) => overlaps(m, shift)).map((m) => rowFor(m, shift)).sort(cmp);
  for (const r of scheduled) r.carryOver = !DONE(r) && r.finish <= next.start;
  const seenDone = new Set<string>();
  const done: ShiftRow[] = [];
  for (const r of scheduled) if (DONE(r)) { done.push(r); if (r.leaf.id) seenDone.add(r.leaf.id); }
  for (const m of leaves) {
    if (!m.id || seenDone.has(m.id)) continue;
    const row = rowFor(m, shift);
    if (!DONE(row)) continue;
    if (inWin(toMs(m.actualAt), shift)) { done.push(row); seenDone.add(m.id); }
  }
  done.sort(cmp);
  const isOpen = (r: { status: MilestoneStatus; percent: number }) => !DONE(r) && (r.status === "in_progress" || r.percent > 0);
  const inProgress = leaves
    .map((m) => rowFor(m, shift))
    .filter(isOpen)
    .map((r) => { r.carryOver = r.finish <= next.start; return r; })
    .sort((a, b) => Number(a.offSchedule) - Number(b.offSchedule) || cmp(a, b));
  const notStarted = scheduled.filter((r) => !DONE(r) && !isOpen(r));
  // Carry-over also includes anything older that is still open: it was due
  // before this shift ended and nobody closed it.
  const carryOver = leaves
    .filter((m) => finishMsOf(m) <= next.start && !DONE({ status: m.status, percent: pctOf(m) }))
    .map((m) => { const r = rowFor(m, shift); r.carryOver = true; return r; })
    .sort((a, b) => Number(b.critical) - Number(a.critical) || cmp(a, b));

  // ── 3. Goals for the next shift ──────────────────────────────────
  const planned = leaves
    .filter((m) => overlaps(m, next) && !DONE({ status: m.status, percent: pctOf(m) }))
    .map((m) => rowFor(m, next))
    .filter((r) => !carryOver.some((c) => c.leaf.id === r.leaf.id))
    .sort((a, b) => Number(b.critical) - Number(a.critical) || cmp(a, b));
  const goalsCarry = carryOver.map((r) => ({ ...rowFor(r.leaf, next), carryOver: true }))
    .sort((a, b) => Number(b.critical) - Number(a.critical) || cmp(a, b));
  const all = [...goalsCarry, ...planned];
  const critical = all.filter((r) => r.critical);

  // ── 4. Blocked / on hold ─────────────────────────────────────────
  const blocked = leaves
    .filter((m) => m.status === "blocked" || m.status === "on_hold")
    .map((m) => rowFor(m, next)).sort(cmp);

  return {
    tz, now, shift, next,
    overall: {
      actualPct, plannedPct, variancePct, standing, stepsDone, stepsTotal: leaves.length,
      plannedStart: hasSpan ? plannedStart : null, plannedFinish: hasSpan ? plannedFinish : null,
      daysElapsed, daysTotal,
    },
    review: { scheduled, done, inProgress, notStarted, carryOver },
    goals: { all, carryOver: goalsCarry, planned, critical },
    blocked,
  };
}

/** "Day · Mon Oct 26 · 05:30–17:30" */
export function shiftLabel(w: ShiftWindow, tz: string): string {
  const d = new Date(w.start).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", timeZone: tz });
  const t = (ms: number) => { const c = wallClock(ms, tz); return `${String(c.hour).padStart(2, "0")}:${String(c.minute).padStart(2, "0")}`; };
  return `${w.kind === "day" ? "Day" : "Night"} shift · ${d} · ${t(w.start)}–${t(w.end)}`;
}
