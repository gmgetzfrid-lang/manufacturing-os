// meetingPlan — the agendas for the meetings a job runs on, computed from
// the schedule. Pure functions; the view only formats.
//
//   Kick-off   before (or on) day one: what the job is, when, who, the
//              chain that drives the finish date, what's not ready, and
//              what the first day and night shifts do.
//   Turnover   every shift change: lib/shiftReport.ts.
//   Close-out  at the end: where it finished against plan, what's still
//              open, what finished late.

import type { Milestone } from "@/types/schema";
import { leafPercent, type ProgressInfo } from "@/lib/scheduleProgress";
import { startMsOf, finishMsOf, wbsCompare } from "@/lib/calendarPlacement";
import { dayDiff } from "@/lib/scheduleTz";
import {
  buildShiftReport, shiftAt, nextShift, previousShift, workHours, DEFAULT_SHIFT_TIMES,
  type ShiftTimes, type ShiftWindow, type ShiftRow,
} from "@/lib/shiftReport";

export type MeetingKind = "kickoff" | "turnover" | "closeout";

export interface PlanRow {
  leaf: Milestone;
  parentId: string | null;
  parentName: string | null;
  /** Ancestors above the parent, outermost first. */
  crumbs: string[];
  start: number;
  finish: number;
  hours: number;
  percent: number;
  critical: boolean;
  who: string | null;
}

export interface GroupLine {
  id: string;
  name: string;
  crumbs: string[];
  start: number;
  finish: number;
  steps: number;
  hours: number;
  critical: number;
  who: string[];
}

export interface KickoffPlan {
  start: number | null;
  finish: number | null;
  daysTotal: number;
  steps: number;
  hours: number;
  /** Steps with no planned dates — not on the schedule yet. */
  unscheduled: number;
  groups: GroupLine[];
  /** The chain that drives the finish date, in order. */
  critical: PlanRow[];
  people: Array<{ name: string; steps: number; hours: number; first: number }>;
  /** Blocked or on hold before the job has started. */
  notReady: PlanRow[];
  /** The first shifts with work, and what each one does. */
  firstShifts: Array<{ window: ShiftWindow; rows: ShiftRow[]; hours: number }>;
}

export interface CloseoutPlan {
  start: number | null;
  finish: number | null;
  steps: number;
  done: number;
  actualPct: number;
  /** Done steps finished after their planned finish / on or before it. */
  late: number;
  onTime: number;
  /** When the last step was actually completed, if recorded. */
  lastActual: number | null;
  open: PlanRow[];
  blocked: PlanRow[];
}

const DONE = (m: Milestone, pct: number) => m.status === "completed" || pct >= 100;
const toMs = (v: unknown): number => (v == null ? NaN : v instanceof Date ? v.getTime() : typeof v === "number" ? v : Date.parse(String(v)));

function index(milestones: Milestone[]) {
  const byId = new Map<string, Milestone>();
  const hasKids = new Set<string>();
  for (const m of milestones) if (m.id) byId.set(m.id, m);
  for (const m of milestones) if (m.parentId && byId.has(m.parentId)) hasKids.add(m.parentId);
  const leaves = milestones.filter((m) => !(m.id && hasKids.has(m.id)));
  const chain = (m: Milestone) => {
    const out: Milestone[] = [];
    const guard = new Set<string>();
    let cur = m.parentId ? byId.get(m.parentId) : undefined;
    while (cur && cur.id && !guard.has(cur.id)) { guard.add(cur.id); out.push(cur); cur = cur.parentId ? byId.get(cur.parentId) : undefined; }
    return out; // nearest first
  };
  return { byId, leaves, chain };
}

function planRow(m: Milestone, chain: Milestone[], criticalIds: Set<string>, progress?: Map<string, ProgressInfo>): PlanRow {
  return {
    leaf: m,
    parentId: chain[0]?.id ?? null,
    parentName: chain[0]?.name ?? null,
    crumbs: chain.slice(1).reverse().map((a) => a.name),
    start: startMsOf(m), finish: finishMsOf(m),
    hours: workHours(m),
    percent: (m.id ? progress?.get(m.id)?.percent : undefined) ?? leafPercent(m),
    critical: !!m.id && criticalIds.has(m.id),
    who: m.responsibleParty?.trim() || null,
  };
}

const byTime = (a: PlanRow, b: PlanRow) => (a.start - b.start) || (a.finish - b.finish) || wbsCompare(a.leaf.wbs, b.leaf.wbs) || a.leaf.name.localeCompare(b.leaf.name);

/** Which meeting the page should open on: kick-off before the job starts,
 *  close-out once everything is done or the plan has ended, else turnover. */
export function defaultMeeting(milestones: Milestone[], now: number, progress?: Map<string, ProgressInfo>): MeetingKind {
  const { leaves } = index(milestones);
  const dated = leaves.filter((m) => m.plannedAt && Number.isFinite(startMsOf(m)) && Number.isFinite(finishMsOf(m)));
  if (dated.length === 0) return "kickoff";
  const first = Math.min(...dated.map(startMsOf));
  const last = Math.max(...dated.map(finishMsOf));
  const pct = (m: Milestone) => (m.id ? progress?.get(m.id)?.percent : undefined) ?? leafPercent(m);
  const started = dated.some((m) => m.status === "in_progress" || m.status === "completed" || pct(m) > 0);
  if (now < first && !started) return "kickoff";
  if (dated.every((m) => DONE(m, pct(m))) || now > last + 12 * 3600_000) return "closeout";
  return "turnover";
}

export function buildKickoff(input: {
  milestones: Milestone[]; progress?: Map<string, ProgressInfo>; criticalIds?: Set<string>;
  tz: string; times?: ShiftTimes; firstShiftCount?: number;
}): KickoffPlan {
  const { milestones, progress, tz } = input;
  const times = input.times ?? DEFAULT_SHIFT_TIMES;
  const criticalIds = input.criticalIds ?? new Set<string>();
  const { leaves, chain } = index(milestones);
  const dated = leaves.filter((m) => m.plannedAt && Number.isFinite(startMsOf(m)) && Number.isFinite(finishMsOf(m)));
  const rows = dated.map((m) => planRow(m, chain(m), criticalIds, progress)).sort(byTime);
  const start = rows.length ? Math.min(...rows.map((r) => r.start)) : null;
  const finish = rows.length ? Math.max(...rows.map((r) => r.finish)) : null;

  // Equipment / work groups: the immediate parent of each step.
  const groups = new Map<string, GroupLine>();
  for (const r of rows) {
    const key = r.parentId ?? `leaf:${r.leaf.id}`;
    const g = groups.get(key) ?? {
      id: key, name: r.parentName ?? r.leaf.name, crumbs: r.crumbs, start: r.start, finish: r.finish,
      steps: 0, hours: 0, critical: 0, who: [],
    };
    g.start = Math.min(g.start, r.start); g.finish = Math.max(g.finish, r.finish);
    g.steps++; g.hours += r.hours; if (r.critical) g.critical++;
    if (r.who && !g.who.includes(r.who)) g.who.push(r.who);
    groups.set(key, g);
  }

  const people = new Map<string, { name: string; steps: number; hours: number; first: number }>();
  for (const r of rows) {
    if (!r.who) continue;
    const p = people.get(r.who) ?? { name: r.who, steps: 0, hours: 0, first: r.start };
    p.steps++; p.hours += r.hours; p.first = Math.min(p.first, r.start);
    people.set(r.who, p);
  }

  // The first shifts with work: review the shift BEFORE each one so its
  // planned list is that shift's work.
  const firstShifts: KickoffPlan["firstShifts"] = [];
  if (start != null) {
    let w = shiftAt(start, tz, times);
    for (let i = 0; i < (input.firstShiftCount ?? 2); i++) {
      const rep = buildShiftReport({ milestones, progress, criticalIds, tz, times, shift: previousShift(w, tz, times), now: w.start });
      // The plan as written: what each shift is scheduled to do (nothing has
      // been missed yet at a kick-off, so there is no carry-over to show).
      const list = rep.goals.planned;
      firstShifts.push({ window: w, rows: list, hours: Math.round(list.reduce((a, r) => a + r.hoursLeft, 0) * 10) / 10 });
      w = nextShift(w, tz, times);
    }
  }

  return {
    start, finish,
    daysTotal: start != null && finish != null ? Math.max(1, dayDiff(start, finish, tz) + 1) : 0,
    steps: rows.length,
    hours: Math.round(rows.reduce((a, r) => a + r.hours, 0) * 10) / 10,
    unscheduled: leaves.length - dated.length,
    groups: [...groups.values()].sort((a, b) => a.start - b.start || a.name.localeCompare(b.name)).map((g) => ({ ...g, hours: Math.round(g.hours * 10) / 10 })),
    critical: rows.filter((r) => r.critical),
    people: [...people.values()].sort((a, b) => a.first - b.first).map((p) => ({ ...p, hours: Math.round(p.hours * 10) / 10 })),
    notReady: leaves.filter((m) => m.status === "blocked" || m.status === "on_hold").map((m) => planRow(m, chain(m), criticalIds, progress)).sort(byTime),
    firstShifts,
  };
}

export function buildCloseout(input: {
  milestones: Milestone[]; progress?: Map<string, ProgressInfo>; criticalIds?: Set<string>;
}): CloseoutPlan {
  const { milestones, progress } = input;
  const criticalIds = input.criticalIds ?? new Set<string>();
  const { leaves, chain } = index(milestones);
  const rows = leaves.map((m) => planRow(m, chain(m), criticalIds, progress));
  const dated = rows.filter((r) => Number.isFinite(r.start) && Number.isFinite(r.finish));
  let late = 0, onTime = 0, lastActual: number | null = null, wsum = 0, wdone = 0;
  for (const r of rows) {
    wsum += r.hours; wdone += r.hours * Math.min(100, Math.max(0, r.percent)) / 100;
    if (!DONE(r.leaf, r.percent)) continue;
    const a = toMs(r.leaf.actualAt);
    if (Number.isFinite(a)) {
      lastActual = lastActual == null ? a : Math.max(lastActual, a);
      if (Number.isFinite(r.finish)) { if (a > r.finish + 60_000) late++; else onTime++; }
    }
  }
  return {
    start: dated.length ? Math.min(...dated.map((r) => r.start)) : null,
    finish: dated.length ? Math.max(...dated.map((r) => r.finish)) : null,
    steps: rows.length,
    done: rows.filter((r) => DONE(r.leaf, r.percent)).length,
    actualPct: wsum > 0 ? Math.round((wdone / wsum) * 100) : 0,
    late, onTime, lastActual,
    open: rows.filter((r) => !DONE(r.leaf, r.percent) && r.leaf.status !== "blocked" && r.leaf.status !== "on_hold")
      .sort((a, b) => Number(b.critical) - Number(a.critical) || byTime(a, b)),
    blocked: rows.filter((r) => r.leaf.status === "blocked" || r.leaf.status === "on_hold").sort(byTime),
  };
}
