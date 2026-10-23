// lib/executionReport.ts
//
// Execution analytics: the "where do we actually stand" layer. Pure,
// testable, no I/O. Turns the milestone tree into the numbers a
// turnaround/outage manager needs at a glance and in an end-of-job
// report:
//
//   * completion (by count and by planned work-hours)
//   * schedule health — ahead / behind, overdue, on-hold & blocked
//     (with the reasons captured on the task)
//   * planned vs. actual performer (did the contractor we planned
//     actually do it, or did our crew?)
//   * per-group rollups (each top-level WBS node)
//   * a naive forecast finish based on progress-to-date
//
// "Group" is whatever the schedule's top level is (unit / area / phase
// / sub-project) — never assume a specific facility's vocabulary.

import type { Milestone, MilestoneStatus } from "@/types/schema";
import { effectiveWeight, leafPercent, roundPct } from "@/lib/scheduleProgress";
import { dayDiff } from "@/lib/scheduleTz";
import { startOf, finishOf } from "@/lib/scheduleTime";
import { expectedFraction, isOverdue, BEHIND_POINTS, DEFAULT_SHIFT_TIMES, type ShiftTimes } from "@/lib/shiftReport";

export interface GroupRollup {
  id: string;
  name: string;
  total: number;
  done: number;
  inProgress: number;
  onHold: number;
  blocked: number;
  overdue: number;
  pctComplete: number;       // 0..100, effort-weighted, partial-aware
  plannedHours: number;
  earnedHours: number;       // hours earned = Σ hours × (% complete)
  start: string | null;      // ISO envelope
  finish: string | null;     // ISO envelope
}

export interface Blocker {
  id: string;
  name: string;
  status: Extract<MilestoneStatus, "on_hold" | "blocked">;
  reason: string | null;
  group: string | null;
  plannedAt: string;
}

export interface PerformerSplit {
  /** Of completed leaves, how many were done by who actually did them. */
  byActualKind: Record<string, number>;   // e.g. { employee: 4, contractor: 7 }
  /** Completed leaves where the actual performer differs from the plan. */
  deviations: Array<{ id: string; name: string; planned: string | null; actual: string | null }>;
}

export interface ExecutionReport {
  totalLeaves: number;
  done: number;
  inProgress: number;
  planned: number;
  onHold: number;
  blocked: number;
  missed: number;
  overdue: number;             // not complete & finish < now
  pctComplete: number;         // 0..100, effort-weighted, partial-aware
  plannedHours: number;
  earnedHours: number;         // Σ hours × (% complete) — partial-aware
  pctHours: number;            // 0..100 by hours (partial-aware)
  /** Schedule envelope. */
  start: string | null;
  finish: string | null;
  elapsedDays: number;
  totalDays: number;
  /** Expected % done if perfectly on pace (time elapsed / total). */
  expectedPct: number;
  /** pctComplete − expectedPct. Positive = ahead, negative = behind. */
  paceDelta: number;
  /** Naive forecast finish ISO, or null. */
  forecastFinish: string | null;
  groups: GroupRollup[];
  blockers: Blocker[];
  performers: PerformerSplit;
  /** Drift vs the approved baseline. Null when no baseline is set. */
  baseline: BaselineDrift | null;
}

export interface BaselineDrift {
  /** How many leaves carry a baseline. */
  baselinedLeaves: number;
  /** Current finish − baseline finish, in days, for the project
   *  envelope. Positive = finishing later than planned. */
  finishDriftDays: number;
  /** Baseline project finish + current projected finish (ISO). */
  baselineFinish: string | null;
  currentFinish: string | null;
  /** Leaves whose finish moved later than baseline (slipped) and
   *  earlier (pulled in). */
  slipped: number;
  pulledIn: number;
  /** The worst few slips, for the report. */
  worstSlips: Array<{ id: string; name: string; days: number }>;
}

const DAY = 86_400_000;

// Dates arrive as strings, Dates or epoch numbers — read them all.
const startMs = (m: Milestone) => startOf(m);
const finishMs = (m: Milestone) => finishOf(m);
// Work-hours: the same measure % complete is weighted by, so "work hours
// done" and "% complete" can never tell different stories.
const hoursOf = (m: Milestone, tz?: string) => effectiveWeight(m, tz);

export function computeExecutionReport(milestones: Milestone[], opts?: {
  now?: Date;
  /** Plant zone and shift-change times: "expected by now" counts each step's
   *  planned hours only on the shift that does it, as the shift report does. */
  tz?: string; shiftTimes?: ShiftTimes;
}): ExecutionReport {
  const now = (opts?.now ?? new Date()).getTime();
  const byId = new Map<string, Milestone>();
  for (const m of milestones) if (m.id) byId.set(m.id, m);

  const childrenByParent = new Map<string, Milestone[]>();
  for (const m of milestones) {
    const pid = m.parentId && byId.has(m.parentId) ? m.parentId : null;
    if (!pid) continue;
    const arr = childrenByParent.get(pid) ?? [];
    arr.push(m);
    childrenByParent.set(pid, arr);
  }
  const isLeaf = (m: Milestone) => !m.id || (childrenByParent.get(m.id) ?? []).length === 0;

  // Leaves do the real work — count & hours roll up from them.
  const leaves = milestones.filter((m) => m.plannedAt && isLeaf(m));

  const topGroupOf = (m: Milestone): Milestone => {
    let cur = m;
    const guard = new Set<string>();
    while (cur.parentId && byId.has(cur.parentId) && cur.id && !guard.has(cur.id)) {
      guard.add(cur.id);
      cur = byId.get(cur.parentId)!;
    }
    return cur;
  };

  // The same rules as the shift report: past due = past the end of its
  // planned work (a date-only task, its whole last day); done = complete or
  // at 100%.
  const tz = opts?.tz ?? "UTC";
  const overdue = (m: Milestone) => isOverdue(m, now, tz);
  const isDone = (m: Milestone) => m.status === "completed" || leafPercent(m) >= 100;

  // ── Top-line ─────────────────────────────────────────────────
  const tally = { done: 0, inProgress: 0, planned: 0, onHold: 0, blocked: 0, missed: 0, overdue: 0 };
  let plannedHours = 0, earnedHours = 0;
  let wsum = 0, wpct = 0; // effort-weighted progress (matches the rest of the app)
  let envStart = Infinity, envFinish = -Infinity;
  // The window the plan % is measured on: baseline dates where captured.
  let baseStart = Infinity, baseFinish = -Infinity;

  for (const m of leaves) {
    if (isDone(m)) tally.done++;
    else switch (m.status) {
      case "in_progress": tally.inProgress++; break;
      case "on_hold": tally.onHold++; break;
      case "blocked": tally.blocked++; break;
      case "missed": tally.missed++; break;
      default: tally.planned++;
    }
    if (overdue(m)) tally.overdue++;
    const h = hoursOf(m, tz);
    const lp = leafPercent(m);             // 0..100, status-reconciled, partial-aware
    plannedHours += h;
    earnedHours += h * (lp / 100);         // PARTIAL earned hours, not just fully-done
    const w = effectiveWeight(m, tz);
    wsum += w; wpct += w * lp;
    const s = startMs(m), f = finishMs(m);
    if (Number.isFinite(s)) envStart = Math.min(envStart, s);
    if (Number.isFinite(f)) envFinish = Math.max(envFinish, f);
    const bs = Date.parse(String(m.baselineStartAt ?? "")), bf = Date.parse(String(m.baselineFinishAt ?? ""));
    const hasBase = Number.isFinite(bs) && Number.isFinite(bf);
    const s2 = hasBase ? bs : s, f2 = hasBase ? bf : f;
    if (Number.isFinite(s2)) baseStart = Math.min(baseStart, s2);
    if (Number.isFinite(f2)) baseFinish = Math.max(baseFinish, f2);
  }

  const totalLeaves = leaves.length;
  // Effort-weighted % that counts partial progress (a 90%-done task is 90%,
  // not 0). `done` (count of fully-complete leaves) is reported separately.
  const pctComplete = wsum > 0 ? roundPct(wpct / wsum) : 0;
  const pctHours = plannedHours > 0 ? Math.round((earnedHours / plannedHours) * 100) : pctComplete;

  const start = Number.isFinite(envStart) ? new Date(envStart).toISOString() : null;
  const finish = Number.isFinite(envFinish) ? new Date(envFinish).toISOString() : null;
  // Days by the plant's calendar — "Day 2 of 4" here and on the shift report.
  const totalDays = (Number.isFinite(envStart) && Number.isFinite(envFinish))
    ? Math.max(1, dayDiff(envStart, envFinish, tz) + 1) : 0;
  const elapsedDays = Number.isFinite(envStart) ? Math.max(0, Math.min(totalDays, dayDiff(envStart, now, tz) + 1)) : 0;
  // Where the plan says the job should be by now: each step's share of its
  // own worked hours elapsed, weighted like % complete — the same number the
  // shift report shows as "plan by now". (Days elapsed over days in the job
  // said nothing about what work was due, and ran through nights for day work.)
  let wexp = 0;
  for (const m of leaves) wexp += effectiveWeight(m, tz) * expectedFraction(m, now, tz, opts?.shiftTimes ?? DEFAULT_SHIFT_TIMES);
  const expectedPct = wsum > 0 ? Math.min(100, roundPct((wexp / wsum) * 100)) : 0;
  const paceDelta = pctComplete - expectedPct;

  // Forecast from the same work-hours pace as the verdict, so the two can't
  // disagree: on plan or ahead → the planned finish; behind → the plan
  // stretched by how far behind the work is (planned % ÷ done %), or, past
  // the planned end, the pace so far carried to 100%. Behind with nothing
  // done yet → no forecast (nothing to project from).
  // Past the planned end and not done: the pace so far carried to 100%
  // (never a date already gone). Behind before the end: the window the
  // plan % was measured on (the baseline when there is one) stretched by
  // planned ÷ done — no earlier than the current planned finish.
  let forecastFinish: string | null = finish;
  const behind = pctComplete < 100 && expectedPct - pctComplete >= BEHIND_POINTS;
  if (pctComplete < 100 && Number.isFinite(envStart) && Number.isFinite(envFinish) && (behind || now > envFinish)) {
    if (pctComplete <= 0) forecastFinish = null;
    else if (now > envFinish) forecastFinish = new Date(now + (now - envStart) * ((100 - pctComplete) / pctComplete)).toISOString();
    else {
      const bs = Number.isFinite(baseStart) ? baseStart : envStart, bf = Number.isFinite(baseFinish) ? baseFinish : envFinish;
      forecastFinish = new Date(Math.max(envFinish, bs + (bf - bs) * (expectedPct / pctComplete))).toISOString();
    }
  }

  // ── Per-group rollups ────────────────────────────────────────
  const groupMap = new Map<string, GroupRollup>();
  const groupWeight = new Map<string, { wsum: number; wpct: number }>();
  for (const m of leaves) {
    const g = topGroupOf(m);
    const key = g.id ?? g.name;
    let r = groupMap.get(key);
    if (!r) {
      r = { id: g.id ?? key, name: g.name, total: 0, done: 0, inProgress: 0, onHold: 0, blocked: 0, overdue: 0, pctComplete: 0, plannedHours: 0, earnedHours: 0, start: null, finish: null };
      groupMap.set(key, r);
      groupWeight.set(key, { wsum: 0, wpct: 0 });
    }
    r.total++;
    if (isDone(m)) r.done++;
    else if (m.status === "in_progress") r.inProgress++;
    else if (m.status === "on_hold") r.onHold++;
    else if (m.status === "blocked") r.blocked++;
    if (overdue(m)) r.overdue++;
    const h = hoursOf(m, tz);
    const lp = leafPercent(m);
    r.plannedHours += h;
    r.earnedHours += h * (lp / 100);  // partial earned hours
    const gw = groupWeight.get(key)!;
    gw.wsum += effectiveWeight(m, tz); gw.wpct += effectiveWeight(m, tz) * lp;
    const s = startMs(m), f = finishMs(m);
    if (Number.isFinite(s)) r.start = r.start && Date.parse(r.start) <= s ? r.start : new Date(s).toISOString();
    if (Number.isFinite(f)) r.finish = r.finish && Date.parse(r.finish) >= f ? r.finish : new Date(f).toISOString();
  }
  const groups = Array.from(groupMap.values())
    .map((r) => { const gw = groupWeight.get(r.id); return { ...r, pctComplete: gw && gw.wsum > 0 ? roundPct(gw.wpct / gw.wsum) : 0 }; })
    .sort((a, b) => (a.start ? Date.parse(a.start) : 0) - (b.start ? Date.parse(b.start) : 0));

  // ── Blockers (on-hold / blocked) with their captured reasons ─
  const blockers: Blocker[] = leaves
    .filter((m) => m.status === "on_hold" || m.status === "blocked")
    .map((m) => ({
      id: m.id ?? "",
      name: m.name,
      status: m.status as "on_hold" | "blocked",
      reason: m.statusReason ?? null,
      group: (() => { const g = topGroupOf(m); return g.id === m.id ? null : g.name; })(),
      plannedAt: m.plannedAt as string,
    }))
    .sort((a, b) => Date.parse(a.plannedAt) - Date.parse(b.plannedAt));

  // ── Planned vs actual performer ──────────────────────────────
  const byActualKind: Record<string, number> = {};
  const deviations: PerformerSplit["deviations"] = [];
  for (const m of leaves) {
    if (m.status !== "completed") continue;
    const actualKind = (m.actualKind || m.responsibleKind || "unspecified").toString();
    byActualKind[actualKind] = (byActualKind[actualKind] ?? 0) + 1;
    const planned = m.responsibleParty ?? m.responsibleOrg ?? null;
    const actual = m.actualParty ?? m.actualOrg ?? null;
    if (actual && planned && actual.trim().toLowerCase() !== planned.trim().toLowerCase()) {
      deviations.push({ id: m.id ?? "", name: m.name, planned, actual });
    }
  }

  // ── Baseline drift ───────────────────────────────────────────
  let baseline: BaselineDrift | null = null;
  const baselined = leaves.filter((m) => m.baselineFinishAt);
  if (baselined.length > 0) {
    let slipped = 0, pulledIn = 0;
    let blFinishMax = -Infinity, curFinishMax = -Infinity;
    const slips: Array<{ id: string; name: string; days: number }> = [];
    for (const m of baselined) {
      const bl = Date.parse(m.baselineFinishAt as string);
      const cur = finishMs(m);
      if (Number.isFinite(bl)) blFinishMax = Math.max(blFinishMax, bl);
      if (Number.isFinite(cur)) curFinishMax = Math.max(curFinishMax, cur);
      const d = Math.round((cur - bl) / DAY);
      if (d > 0) { slipped++; slips.push({ id: m.id ?? "", name: m.name, days: d }); }
      else if (d < 0) pulledIn++;
    }
    slips.sort((a, b) => b.days - a.days);
    baseline = {
      baselinedLeaves: baselined.length,
      finishDriftDays: (Number.isFinite(blFinishMax) && Number.isFinite(curFinishMax))
        ? Math.round((curFinishMax - blFinishMax) / DAY) : 0,
      baselineFinish: Number.isFinite(blFinishMax) ? new Date(blFinishMax).toISOString() : null,
      currentFinish: Number.isFinite(curFinishMax) ? new Date(curFinishMax).toISOString() : null,
      slipped, pulledIn,
      worstSlips: slips.slice(0, 6),
    };
  }

  return {
    totalLeaves, done: tally.done, inProgress: tally.inProgress, planned: tally.planned,
    onHold: tally.onHold, blocked: tally.blocked, missed: tally.missed, overdue: tally.overdue,
    pctComplete, plannedHours, earnedHours, pctHours,
    start, finish, elapsedDays, totalDays, expectedPct, paceDelta, forecastFinish,
    groups, blockers,
    performers: { byActualKind, deviations },
    baseline,
  };
}
