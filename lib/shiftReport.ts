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
import { effectiveWeight, leafPercent, roundPct, type ProgressInfo } from "@/lib/scheduleProgress";
import { dayKey, dayKeyToMs, wallClock, wallClockToMs, addDays, dayDiff, hasTimeOfDay } from "@/lib/scheduleTz";
import { startMsOf, finishMsOf, wbsCompare } from "@/lib/calendarPlacement";
import { blocksStart, linkOf } from "@/lib/scheduleLinks";

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

// ── Which shift does a task's work ───────────────────────────────────
//
// A turnaround runs day and night, but most work belongs to one crew: the
// exchanger crew works days, the tower runs nights. The report must count a
// task's planned hours only in the shifts that do it — a day task doesn't
// fall "behind" overnight, and day work left unfinished isn't the night
// crew's must-do. Read from the task's own times against the project's
// shift-change times; a person can set it outright on the task.

/** The project's shift-change times as set on the shift report (kept in
 *  this browser), or the defaults. */
export function readShiftTimes(projectId?: string | null): ShiftTimes {
  try {
    if (!projectId || typeof localStorage === "undefined") return DEFAULT_SHIFT_TIMES;
    const raw = localStorage.getItem(`shiftTimes:${projectId}`);
    return raw ? { ...DEFAULT_SHIFT_TIMES, ...(JSON.parse(raw) as Partial<ShiftTimes>) } : DEFAULT_SHIFT_TIMES;
  } catch { return DEFAULT_SHIFT_TIMES; }
}

/** "day" / "night" — one crew; "both" — worked round the clock (stored as
 *  "swing", the value the database already accepts for it). */
export type WorkShift = "day" | "night" | "both";

/** Every shift window touching [from, to), in order. */
export function shiftWindowsBetween(from: number, to: number, tz: string, times: ShiftTimes = DEFAULT_SHIFT_TIMES, max = 2000): ShiftWindow[] {
  const out: ShiftWindow[] = [];
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return out;
  let w = shiftAt(from, tz, times);
  for (let i = 0; i < max && w.start < to; i++) { out.push(w); w = nextShift(w, tz, times); }
  return out;
}

const overlapMs = (a0: number, a1: number, b0: number, b1: number) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));

/** A task's span as worked: timed tasks as written; a date-only task
 *  (midnight to midnight) covers its days, inclusive. */
export function workSpan(m: Milestone, tz: string): { start: number; finish: number; timed: boolean } {
  const s = startMsOf(m), f = finishMsOf(m);
  const timed = (Number.isFinite(s) && hasTimeOfDay(s, tz)) || (Number.isFinite(f) && hasTimeOfDay(f, tz));
  if (timed || !Number.isFinite(f)) return { start: s, finish: f, timed: true };
  const s0 = Number.isFinite(s) ? s : f;
  return { start: s0, finish: addDays(Math.max(s0, f), 1, tz), timed: false };
}

/** The crew a task's working hours (from the schedule's calendar, e.g.
 *  "06:00-18:00") belong to, against the shift-change times: mostly in
 *  one crew's hours → that crew; well into both → round the clock. Null
 *  when the task carries no calendar hours. */
export function calendarShift(m: Milestone, times: ShiftTimes = DEFAULT_SHIFT_TIMES): WorkShift | null {
  const raw = (m.attributes as Record<string, unknown> | null | undefined)?.work_hours;
  if (typeof raw !== "string" || !raw.trim()) return null;
  const toMin = (hm: string) => { const [h, mm] = hm.split(":").map(Number); return (h || 0) * 60 + (mm || 0); };
  const ds = toMin(times.dayStart), ns = toMin(times.nightStart);
  // The day crew's minutes of the clock (the day can't wrap midnight here).
  const dayOverlap = (a: number, b: number) => ds < ns ? Math.max(0, Math.min(b, ns) - Math.max(a, ds)) : 0;
  let total = 0, day = 0;
  for (const part of raw.split(",")) {
    const [x, y] = part.split("-");
    if (!x || !y) continue;
    const a = toMin(x), b = toMin(y);
    if (!(b > a)) continue;
    total += b - a; day += dayOverlap(a, b);
  }
  if (total <= 0) return null;
  const share = day / total;
  if (share >= 0.65) return "day";
  if (share <= 0.35) return "night";
  return "both";
}

/** Which shift does this task's work. See the note above. */
export function workShiftOf(m: Milestone, tz: string, times: ShiftTimes = DEFAULT_SHIFT_TIMES): WorkShift {
  const set = m.shift as string | null | undefined;
  if (set === "both" || set === "swing") return "both";
  // The schedule's own calendar says which hours it's worked — a person's
  // Day / Night on the task still wins.
  if (set !== "day" && set !== "night") {
    const cal = calendarShift(m, times);
    if (cal) return cal;
  }
  const { start, finish, timed } = workSpan(m, tz);
  if (!timed) return set === "night" ? "night" : "day";
  if (!Number.isFinite(start) || !Number.isFinite(finish) || finish <= start) {
    return Number.isFinite(start) ? shiftAt(start, tz, times).kind : "day";
  }
  let dayMs = 0, nightMs = 0;
  for (const w of shiftWindowsBetween(start, finish, tz, times)) {
    const o = overlapMs(start, finish, w.start, w.end);
    if (w.kind === "day") dayMs += o; else nightMs += o;
  }
  const total = dayMs + nightMs;
  const slack = Math.max(20 * 60_000, total * 0.05);   // a step ending a few minutes past shift change is still that shift's
  if (nightMs <= slack) return "day";
  if (dayMs <= slack) return "night";
  // Spans both. Its planned hours tell which: work that fits in the day
  // hours (and is well short of the elapsed time) is the day crew's.
  const dur = m.durationHours != null && m.durationHours > 0 ? m.durationHours * 3_600_000 : NaN;
  if (Number.isFinite(dur)) {
    if (dur >= total * 0.9) return "both";
    const fitsDay = dur <= dayMs * 1.1, fitsNight = dur <= nightMs * 1.1;
    if (fitsDay && !fitsNight) return "day";
    if (fitsNight && !fitsDay) return "night";
  }
  // Starts and ends on the same crew's shift — that crew's job.
  const a = shiftAt(start, tz, times).kind, b = shiftAt(finish - 1, tz, times).kind;
  if (a === b) return a;
  if (set === "day" || set === "night") return set;
  return "both";
}

/** The stretches of time a task is worked: its span, cut to its shift. */
export function workWindows(m: Milestone, tz: string, times: ShiftTimes = DEFAULT_SHIFT_TIMES, span?: { start: number; finish: number }): Array<[number, number]> {
  const ws = workSpan(m, tz);
  const start = span?.start ?? ws.start, finish = span?.finish ?? ws.finish;
  if (!Number.isFinite(start) || !Number.isFinite(finish) || finish <= start) return [];
  const kind = workShiftOf(m, tz, times);
  if (kind === "both") return [[start, finish]];
  const out: Array<[number, number]> = [];
  for (const w of shiftWindowsBetween(start, finish, tz, times)) {
    if (w.kind !== kind) continue;
    const a = Math.max(start, w.start), b = Math.min(finish, w.end);
    if (b > a) out.push([a, b]);
  }
  return out;
}

/** Does this task have work planned in this shift? */
export function worksIn(m: Milestone, w: ShiftWindow, tz: string, times: ShiftTimes = DEFAULT_SHIFT_TIMES): boolean {
  const kind = workShiftOf(m, tz, times);
  if (kind !== "both" && kind !== w.kind) return false;
  const { start, finish } = workSpan(m, tz);
  if (finish <= start) return start >= w.start && start < w.end;   // a zero-length milestone
  return start < w.end && finish > w.start;
}

/** Share of a task's planned work the plan expects done by `now`: the
 *  worked hours elapsed over the worked hours in total — so the clock
 *  only runs while its crew is on shift. */
export function plannedFraction(m: Milestone, now: number, tz: string, times: ShiftTimes = DEFAULT_SHIFT_TIMES, span?: { start: number; finish: number }): number {
  const ws = workSpan(m, tz);
  const s = span?.start ?? ws.start, f = span?.finish ?? ws.finish;
  if (!(f > s)) return now >= f ? 1 : 0;
  const win = workWindows(m, tz, times, { start: s, finish: f });
  const total = win.reduce((a, [x, y]) => a + (y - x), 0);
  if (total <= 0) return Math.max(0, Math.min(1, (now - s) / (f - s)));
  const done = win.reduce((a, [x, y]) => a + overlapMs(x, y, -Infinity, now), 0);
  return Math.max(0, Math.min(1, done / total));
}

/** Share of a step the plan expects done by `now`, against its baseline
 *  when one was captured (moving work later must not erase a slip). */
export function expectedFraction(m: Milestone, now: number, tz: string, times: ShiftTimes = DEFAULT_SHIFT_TIMES): number {
  const toMs = (v: unknown): number => (v == null ? NaN : v instanceof Date ? v.getTime() : typeof v === "number" ? v : Date.parse(String(v)));
  const bs = toMs(m.baselineStartAt), bf = toMs(m.baselineFinishAt);
  if (!(Number.isFinite(bs) && Number.isFinite(bf))) return plannedFraction(m, now, tz, times);
  // Measured as baselined — on the crew it was baselined for: moving a day
  // job onto nights must not turn the baseline's day hours into night ones.
  const asBaselined = { ...m, plannedStartAt: m.baselineStartAt, plannedAt: m.baselineFinishAt } as Milestone;
  return plannedFraction(asBaselined, now, tz, times);
}

/** When a task is due: its finish, or for a date-only task the end of its
 *  last day (a task dated Oct 26 isn't late until Oct 26 is over). */
export function dueMsOf(m: Milestone, tz: string): number {
  return workSpan(m, tz).finish;
}

/** Past due and not done — one rule for every count, filter and report. */
export function isOverdue(m: Milestone, now: number, tz: string, percent?: number): boolean {
  if (m.status === "completed" || (percent ?? leafPercent(m)) >= 100) return false;
  const due = dueMsOf(m, tz);
  return Number.isFinite(due) && due <= now;
}

/** Where a step stands against its plan right now (see ShiftRow.pace). */
export function paceOf(m: Milestone, percent: number, now: number, tz: string, times: ShiftTimes = DEFAULT_SHIFT_TIMES): Pace {
  if (m.status === "completed" || percent >= 100) return "done";
  if (m.status === "blocked" || m.status === "on_hold") return "held";
  const due = dueMsOf(m, tz);
  if (Number.isFinite(due) && due <= now) return "overdue";
  // Same line as the task and the job (standingOf): 5 points short is behind.
  return percent + BEHIND_POINTS <= expectedFraction(m, now, tz, times) * 100 ? "behind" : "on plan";
}

/** Each main task's (a leaf's parent's) planned % by now: its steps'
 *  expected shares, weighted like % complete. */
export function expectedByParent(milestones: Milestone[], now: number, tz: string, times: ShiftTimes = DEFAULT_SHIFT_TIMES): Map<string, number> {
  const byId = new Map(milestones.filter((m) => m.id).map((m) => [m.id!, m]));
  const parents = new Set(milestones.map((m) => m.parentId).filter((x): x is string => !!x));
  const acc = new Map<string, { w: number; e: number }>();
  for (const m of milestones) {
    if (!m.parentId || (m.id && parents.has(m.id))) continue;   // leaves only
    const w = workHours(m, tz), e = expectedFraction(m, now, tz, times);
    // Every task above the step, not just its parent: a main task's plan
    // includes the work in its sub-groups, like its % complete does.
    const seen = new Set<string>();
    for (let pid: string | null | undefined = m.parentId; pid && !seen.has(pid); pid = byId.get(pid)?.parentId) {
      seen.add(pid);
      const a = acc.get(pid) ?? { w: 0, e: 0 };
      a.w += w; a.e += w * e;
      acc.set(pid, a);
    }
  }
  return new Map([...acc].map(([k, v]) => [k, v.w > 0 ? Math.round((v.e / v.w) * 100) : 0]));
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
    if (leaves.some((m) => worksIn(m, w, tz, times))) return w;
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
  parentId: string | null;
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
  /** Planned work-hours (duration_hours, else weight, else 1). */
  hours: number;
  /** Hours still to do = hours × (1 − percent). */
  hoursLeft: number;
  /** Its planned finish has passed and it isn't done. */
  overdue: boolean;
  /** Its planned start has passed and nothing has been done on it. */
  lateStart: boolean;
  /** Steps that must finish before it can start and aren't done — it
   *  cannot run on its planned time while these are open. */
  waitingOn: Array<{ id: string; name: string }>;
  /** Which shift does its work: "day", "night" or round the clock. */
  work: WorkShift;
  /** % the plan expects done by now (on its crew's hours). */
  expectedPct: number;
  /** Where unfinished work stands: past its finish ("overdue"), well short
   *  of where the plan has it by now ("behind"), held ("held"), or where
   *  the plan has it — work planned to carry on ("on plan"). Done = "done". */
  pace: Pace;
}

export type Pace = "done" | "overdue" | "behind" | "held" | "on plan";
/** How far short of (or past) the plan, in percentage points, before work
 *  is called behind (or ahead) — one line for the job, each task and each
 *  step, in every view, so the headline and the rows can't disagree. */
export const BEHIND_POINTS = 5;

/** The verdict for actual vs planned %, the same everywhere. */
export function standingOf(actualPct: number, plannedPct: number): "ahead" | "on track" | "behind" {
  const v = actualPct - plannedPct;
  return v <= -BEHIND_POINTS ? "behind" : v >= BEHIND_POINTS ? "ahead" : "on track";
}

/** Planned work-hours for a step — the weight % complete rolls up by
 *  (lib/scheduleProgress effectiveWeight): its duration, else a weight
 *  someone set, else the length of its planned window. One measure for the
 *  plan, the actual and the gap. */
export function workHours(m: Milestone, tz?: string): number {
  return Math.round(effectiveWeight(m, tz) * 10) / 10;
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
    /** Steps with no planned dates: left out of plan and actual alike. */
    unscheduled: number;
    plannedStart: number | null;
    plannedFinish: number | null;
    daysElapsed: number;
    daysTotal: number;
    /** What "plan said by now" is measured against: the captured baseline
     *  (so moving work around can't hide slippage) or, when no baseline
     *  exists, the live planned dates. */
    planBasis: "baseline" | "current";
    /** When the baseline was captured (latest stamp), for "measured
     *  against the plan as of …". Null without a baseline. */
    baselineSetAt: string | null;
  };
  review: {
    scheduled: ShiftRow[];
    done: ShiftRow[];
    inProgress: ShiftRow[];
    notStarted: ShiftRow[];
    carryOver: ShiftRow[];
  };
  goals: {
    /** MUST DO — everything the next shift should work to hold the plan:
     *  carry-overs first (critical ones on top), then its planned work. */
    all: ShiftRow[];
    carryOver: ShiftRow[];
    planned: ShiftRow[];
    critical: ShiftRow[];
    /** Work-hours still to do across the must-do list. */
    mustDoHours: number;
    /** Unfinished work the next shift doesn't do (day work during a night
     *  turnover): it waits for its own crew — listed, not counted as
     *  this shift's must-do. */
    otherShift: ShiftRow[];
    /** Work under way that the next shift's crew doesn't do — set to the
     *  other crew — paused over the next shift and resuming after it (so a
     *  job "continuing as planned" doesn't vanish from the next shift). */
    paused: ShiftRow[];
    /** STRETCH — work planned for the following shifts that is ready to
     *  pull forward (its predecessors done or on the must-do list), in
     *  schedule order. Doing it banks time or claws back a deficit. */
    stretch: ShiftRow[];
    /** How the job stands in work-hours: positive = behind the plan by
     *  this many hours, negative = ahead. */
    gapHours: number;
    /** Index (1-based) of the stretch item at which the cumulative stretch
     *  hours cover the deficit — "must-do plus stretch 1..N gets you back on
     *  plan". Null when not behind or when stretch can't cover it. */
    backOnTrackAt: number | null;
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
  const toMs = (v: unknown): number => (v == null ? NaN : v instanceof Date ? v.getTime() : typeof v === "number" ? v : Date.parse(String(v)));

  // What each step waits on: its recorded predecessors; when the schedule
  // records none at all, the step before it under the same parent that
  // finishes by the time it starts (a sequence of steps on one piece of
  // equipment runs in order).
  const anyLinks = milestones.some((m) => (m.dependsOn ?? []).length > 0);
  const siblingsOf = new Map<string, Milestone[]>();
  for (const [pid, list] of kids) siblingsOf.set(pid, [...list].sort((a, b) => startMsOf(a) - startMsOf(b)));
  const predecessorsOf = (m: Milestone): Milestone[] => {
    if (anyLinks) return (m.dependsOn ?? []).map((id) => byId.get(id)).filter((x): x is Milestone => !!x);
    if (!m.parentId) return [];
    const sibs = siblingsOf.get(m.parentId) ?? [];
    const i = sibs.findIndex((x) => x.id === m.id);
    const prev = i > 0 ? sibs[i - 1] : undefined;
    return prev && finishMsOf(prev) <= startMsOf(m) + 3_600_000 ? [prev] : [];
  };
  const doneM = (m: Milestone) => m.status === "completed" || pctOf(m) >= 100;
  const startedM = (m: Milestone) => doneM(m) || m.status === "in_progress" || pctOf(m) > 0;

  const rowFor = (m: Milestone, win: ShiftWindow): ShiftRow => {
    const chain = pathOf(m);
    const s = startMsOf(m), f = finishMsOf(m);
    const due = dueMsOf(m, tz);
    const percent = pctOf(m);
    const finished = m.status === "completed" || percent >= 100;
    const hours = workHours(m, tz);
    return {
      leaf: m,
      path: chain.slice().reverse().map((a) => a.name),
      parentName: chain[0]?.name ?? null,
      parentId: chain[0]?.id ?? null,
      start: s, finish: f, percent,
      status: m.status,
      carryOver: false,
      critical: !!m.id && criticalIds.has(m.id),
      dueInShift: due > win.start && due <= win.end,
      startsInShift: s >= win.start && s < win.end,
      offSchedule: !(s < win.end && f > win.start),
      reason: m.statusReason ?? null,
      hours,
      hoursLeft: Math.round(hours * (1 - Math.min(100, Math.max(0, percent)) / 100) * 10) / 10,
      overdue: !finished && Number.isFinite(due) && due <= now,
      lateStart: !finished && percent <= 0 && m.status !== "in_progress" && Number.isFinite(s) && s < now,
      // Waiting = a link that stops it starting: finish-to-start until the
      // other is done, start-to-start until it has started.
      waitingOn: finished ? [] : predecessorsOf(m)
        .filter((p) => blocksStart(linkOf(m.linkTypes, p.id ?? ""), { done: doneM(p), started: startedM(p) }))
        .map((p) => ({ id: p.id ?? p.name, name: p.name })),
      work: workShiftOf(m, tz, times),
      expectedPct: Math.round(expectedFraction(m, now, tz, times) * 100),
      pace: paceOf(m, percent, now, tz, times),
    };
  };
  const inWin = (ms: number, win: ShiftWindow) => Number.isFinite(ms) && ms >= win.start && ms < win.end;

  const leaves = milestones.filter((m) => isLeaf(m) && m.plannedAt && Number.isFinite(startMsOf(m)) && Number.isFinite(finishMsOf(m)));
  // Planned in a shift = its span covers the shift AND that shift's crew
  // does it (a day task spanning three days is not night work).
  const overlaps = (m: Milestone, win: ShiftWindow) => worksIn(m, win, tz, times);
  const cmp = (a: ShiftRow, b: ShiftRow) =>
    (a.start - b.start) || (a.finish - b.finish) || wbsCompare(a.leaf.wbs, b.leaf.wbs) || a.leaf.name.localeCompare(b.leaf.name);

  // ── 1. Overall standing ──────────────────────────────────────────
  // Plan and actual over the SAME steps (the scheduled ones), weighted the
  // same way (work-hours): a step with no dates can't be planned, so it
  // can't count against the actual either — it's reported as unscheduled.
  let wsum = 0, wplanned = 0, wactual = 0, stepsDone = 0, baselined = 0;
  let baselineSetAt: string | null = null;
  let plannedStart = Infinity, plannedFinish = -Infinity;
  for (const m of leaves) {
    const s = startMsOf(m), f = finishMsOf(m);
    plannedStart = Math.min(plannedStart, s); plannedFinish = Math.max(plannedFinish, f);
    const w = workHours(m, tz);
    // Measure "where the plan said we'd be" against the BASELINE when one
    // was captured: dragging a task later must not erase the slip.
    const bs = toMs(m.baselineStartAt), bf = toMs(m.baselineFinishAt);
    const useBase = Number.isFinite(bs) && Number.isFinite(bf);
    if (useBase) {
      baselined++;
      const setMs = toMs(m.baselineSetAt);
      if (Number.isFinite(setMs) && (!baselineSetAt || setMs > Date.parse(baselineSetAt))) baselineSetAt = new Date(setMs).toISOString();
    }
    // The plan's clock runs only while the task's crew is on shift: a day
    // task earns no planned progress overnight.
    const frac = expectedFraction(m, now, tz, times);
    const pct = pctOf(m);
    wsum += w; wplanned += w * frac; wactual += w * pct / 100;
    if (DONE({ status: m.status, percent: pct })) stepsDone++;
  }
  const plannedPct = wsum > 0 ? roundPct((wplanned / wsum) * 100) : 0;
  const actualPct = wsum > 0 ? roundPct((wactual / wsum) * 100) : 0;
  const variancePct = actualPct - plannedPct;
  const standing: ShiftReport["overall"]["standing"] = standingOf(actualPct, plannedPct);
  const unscheduled = milestones.filter((m) => isLeaf(m) && !leaves.includes(m)).length;
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
  // Carry-over = due by now and not done. Mid-shift, work due at 16:00
  // isn't carried over at 10:00 — it's still this shift's.
  for (const r of scheduled) r.carryOver = !DONE(r) && dueMsOf(r.leaf, tz) <= now;
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
    .map((r) => { r.carryOver = dueMsOf(r.leaf, tz) <= now; return r; })
    .sort((a, b) => Number(a.offSchedule) - Number(b.offSchedule) || cmp(a, b));
  const notStarted = scheduled.filter((r) => !DONE(r) && !isOpen(r));
  // Carry-over also includes anything older that is still open: it was due
  // before this shift ended and nobody closed it.
  const carryOver = leaves
    .filter((m) => dueMsOf(m, tz) <= now && !DONE({ status: m.status, percent: pctOf(m) }))
    .map((m) => { const r = rowFor(m, shift); r.carryOver = true; return r; })
    .sort((a, b) => Number(b.critical) - Number(a.critical) || cmp(a, b));

  // ── 3. Goals for the next shift ──────────────────────────────────
  // Blocked / on-hold work can't be worked: it's listed under Blocked (with
  // its reason), not on the next crew's list or in its hours.
  const held = (m: Milestone) => m.status === "blocked" || m.status === "on_hold";
  const planned = leaves
    .filter((m) => overlaps(m, next) && !held(m) && !DONE({ status: m.status, percent: pctOf(m) }))
    .map((m) => rowFor(m, next))
    .filter((r) => !carryOver.some((c) => c.leaf.id === r.leaf.id))
    .sort((a, b) => Number(b.critical) - Number(a.critical) || cmp(a, b));
  const forNext = (r: ShiftRow) => r.work === "both" || r.work === next.kind;
  const carriedAll = carryOver.filter((r) => !held(r.leaf)).map((r) => ({ ...rowFor(r.leaf, next), carryOver: true }))
    .sort((a, b) => Number(b.critical) - Number(a.critical) || cmp(a, b));
  const goalsCarry = carriedAll.filter(forNext);
  const otherShift = carriedAll.filter((r) => !forNext(r));
  const all = [...goalsCarry, ...planned];
  const listed = new Set([...all, ...otherShift].map((r) => r.leaf.id));
  const paused = leaves
    .filter((m) => m.id && !listed.has(m.id) && !held(m) && !DONE({ status: m.status, percent: pctOf(m) })
      && (m.status === "in_progress" || pctOf(m) > 0) && workSpan(m, tz).finish > next.start && workSpan(m, tz).start < next.end)
    .map((m) => rowFor(m, next))
    .filter((r) => !forNext(r))
    .sort(cmp);
  const critical = all.filter((r) => r.critical);
  const mustDoHours = Math.round(all.reduce((acc, r) => acc + r.hoursLeft, 0) * 10) / 10;

  // Stretch: planned for the following shifts (up to ~2 shifts after the
  // next one), not done, not already on the must-do list, and READY — every
  // predecessor is done or is itself on the must-do list.
  const mustIds = new Set(all.map((r) => r.leaf.id ?? ""));
  const doneIds = new Set(leaves.filter((m) => DONE({ status: m.status, percent: pctOf(m) })).map((m) => m.id ?? ""));
  const horizonEnd = nextShift(nextShift(next, tz, times), tz, times).end;
  const stretch = leaves
    .filter((m) => m.id && !mustIds.has(m.id) && !doneIds.has(m.id) && !held(m) && startMsOf(m) >= next.end && startMsOf(m) < horizonEnd)
    .filter((m) => (m.dependsOn ?? []).every((d) => {
      const p = byId.get(d);
      return !p || doneIds.has(d) || mustIds.has(d) || !blocksStart(linkOf(m.linkTypes, d), { done: doneM(p), started: startedM(p) });
    }))
    .map((m) => rowFor(m, next))
    .filter(forNext)
    .sort((a, b) => Number(b.critical) - Number(a.critical) || cmp(a, b))
    .slice(0, 12);
  // Deficit in work-hours against the plan as of now: planned hours earned
  // by now minus hours actually done.
  const gapHours = Math.round((wplanned - wactual) * 10) / 10;
  let backOnTrackAt: number | null = null;
  if (gapHours > 0) {
    let acc = 0;
    for (let i = 0; i < stretch.length; i++) { acc += stretch[i].hoursLeft; if (acc >= gapHours) { backOnTrackAt = i + 1; break; } }
  }

  // ── 4. Blocked / on hold ─────────────────────────────────────────
  const blocked = leaves
    .filter((m) => m.status === "blocked" || m.status === "on_hold")
    .map((m) => rowFor(m, next)).sort(cmp);

  return {
    tz, now, shift, next,
    overall: {
      actualPct, plannedPct, variancePct, standing, stepsDone, stepsTotal: leaves.length, unscheduled,
      plannedStart: hasSpan ? plannedStart : null, plannedFinish: hasSpan ? plannedFinish : null,
      daysElapsed, daysTotal,
      planBasis: baselined > 0 ? "baseline" : "current",
      baselineSetAt: baselined > 0 ? baselineSetAt : null,
    },
    review: { scheduled, done, inProgress, notStarted, carryOver },
    goals: { all, carryOver: goalsCarry, planned, critical, mustDoHours, otherShift, paused, stretch, gapHours, backOnTrackAt },
    blocked,
  };
}

/** "Day · Mon Oct 26 · 05:30–17:30" */
export function shiftLabel(w: ShiftWindow, tz: string): string {
  const d = new Date(w.start).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", timeZone: tz });
  const t = (ms: number) => { const c = wallClock(ms, tz); return `${String(c.hour).padStart(2, "0")}:${String(c.minute).padStart(2, "0")}`; };
  return `${w.kind === "day" ? "Day" : "Night"} shift · ${d} · ${t(w.start)}–${t(w.end)}`;
}
