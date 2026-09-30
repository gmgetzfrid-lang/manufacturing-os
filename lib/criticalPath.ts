// lib/criticalPath.ts
//
// The critical path, from the schedule's own dependency links (PT SCH-15 /
// PC SCHED-10). The date-walk heuristic that lived here ("critical-path
// lite": walk backward by date contiguity inside a 1-day slack / 14-day
// window) is RETIRED — it ignored the finish-to-start links the reschedule
// engine honours, merged parallel chains into one seam, dropped any driver
// more than 14 days back, and counted a 90%-done task's hours in full.
//
// What this computes: a backward pass over the SCHEDULED network of the
// unfinished leaves. Each leaf keeps its planned dates; the latest it could be
// ready without delaying the finish is
//
//     lateReady(n) = min over unfinished successors s of (lateStart(s) − lag(n→s)),
//                    or the finish when n has none
//     lateStart(s) = lateReady(s) − occupied(s)
//
// and its TOTAL FLOAT is lateReady(n) − ready(n) (reported per leaf). "The
// finish" here is the latest ready instant of an UNFINISHED leaf: a task that
// is done (completed, or carrying an actual finish) no longer gates anything,
// so a completed inspection that still carries the latest planned date does
// not empty the path, and a finished successor does not constrain its
// predecessors. "Ready" is the instant a finish-to-start successor may start
// (scheduleReflow.fsReadyMs: the end of the day for a date-only finish, the
// instant for a timed one), and lag is the source schedule's own
// (attributes.source_links, PT SCH-8), stored in WORKING hours and counted as
// working days Monday–Friday (scheduleReflow.afterLagMs, the rule the cascade
// applies) — "+5d" is five working days, not 40 elapsed hours.
//
// Every gap, occupancy and float is measured on the WORKING clock
// (scheduleReflow.workingTimeMs: Monday to Friday, the clock stopped over the
// weekend) — the calendar lag already runs on. Measured in calendar days, a
// Friday finish followed by a Monday start is two days of "float", so every
// weekly hand-off broke the chain and the path stopped at the last weekend.
// Float is reported in working days.
//
// Unless the plan works weekends. With no project calendar the clock is
// INFERRED from the plan (the `calendar` field): when any unfinished leaf
// starts or finishes on a Saturday or Sunday (wall-clock-as-UTC) — a weekend
// shutdown, a 24/7 turnaround — every day is a working day and the path runs
// on the 7-day clock (calendar time; a lag's working days are calendar days).
// On the Mon–Fri clock weekend work weighs nothing: every weekend instant
// collapses onto Friday 24:00, so a Saturday task with a day of slack, or an
// unlinked Saturday-morning job, read as "ending at the finish" and critical.
//
// The PATH is the chain of DRIVING links traced back from the finish —
// Primavera's "longest path": start from the unfinished leaves that are ready
// within the tolerance of the finish, and follow each predecessor link whose
// successor starts within the tolerance of that predecessor being ready
// (+ lag). Per-link, because with no project calendar the float of a chain of
// 08:00–17:00 tasks grows by an overnight gap at every hand-off; a driving link
// is judged on its own gap (default tolerance: under one working day, so the
// evening-finish / morning-start hand-off and the Friday-to-Monday one drive).
//
// No project calendar: holidays are not skipped. A leaf with no links only
// counts when it ends at the finish. Summaries are envelopes: a link to or
// from a phase applies to every leaf inside it. A loop in the links is
// reported and left out. Pure.

import type { Milestone } from "@/types/schema";
import { DAY_MS, afterLagMs, fsReadyMs, lagWorkingMs, reflowNodesFromMilestones, workingTimeMs } from "@/lib/scheduleReflow";
import { leafPercent } from "@/lib/scheduleProgress";

export interface CriticalPathResult {
  /** Unfinished leaf ids on the driving chain(s) back from the finish — what gates it. */
  ids: Set<string>;
  /** The schedule's envelope (ISO): the latest leaf finish, finished tasks included. */
  finish: string | null;
  /** Hours still to do on the path: Σ planned hours × (100 − % complete) / 100. */
  remainingHours: number;
  /** Total float per unfinished leaf, in working days of `calendar` —
   *  Monday to Friday, or every day on a plan that works weekends (leaves in
   *  a loop are absent). */
  floatDays: Map<string, number>;
  /** The clock every gap and float was measured on, inferred from the plan:
   *  "seven-day" when an unfinished leaf starts or finishes on a Saturday or
   *  Sunday, else "mon-fri". */
  calendar: PathCalendar;
  /** Whether any finish-to-start link connects two leaves at all. */
  linked: boolean;
  /** Unfinished leaves with no link in or out — they count only when they
   *  end at the finish, so the screen can say "add links to see the chain". */
  unlinked: number;
  /** Leaf ids inside a loop of links (left out of the pass), or null. */
  cycle: string[] | null;
}

/** The working week the path is measured on (see the header). */
export type PathCalendar = "mon-fri" | "seven-day";

/** How a caption names the clock: "working days Mon–Fri", or "every day,
 *  weekends included" for a plan that works weekends. */
export function pathCalendarLabel(calendar: PathCalendar): string {
  return calendar === "seven-day" ? "every day, weekends included" : "working days Mon–Fri";
}

/** Saturday or Sunday, wall-clock-as-UTC (the stored form of a planned date). */
const onWeekend = (ms: number) => { const wd = new Date(ms).getUTCDay(); return wd === 0 || wd === 6; };

const startMs = (m: Milestone) => Date.parse((m.plannedStartAt as string | undefined) ?? (m.plannedAt as string));
const finishMs = (m: Milestone) => Date.parse(m.plannedAt as string);

export function computeCriticalPath(
  milestones: Milestone[],
  opts?: { toleranceDays?: number },
): CriticalPathResult {
  const tolerance = (opts?.toleranceDays ?? 1) * DAY_MS;
  const empty: CriticalPathResult = { ids: new Set(), finish: null, remainingHours: 0, floatDays: new Map(), calendar: "mon-fri", linked: false, unlinked: 0, cycle: null };

  const byId = new Map<string, Milestone>();
  for (const m of milestones) if (m.id) byId.set(m.id, m);
  const kids = new Map<string, string[]>();
  for (const m of milestones) {
    if (!m.id || !m.parentId || !byId.has(m.parentId) || m.parentId === m.id) continue;
    const arr = kids.get(m.parentId) ?? []; arr.push(m.id); kids.set(m.parentId, arr);
  }
  const isLeaf = (id: string) => (kids.get(id)?.length ?? 0) === 0;
  const leafIds = milestones.filter((m) => m.id && m.plannedAt && isLeaf(m.id) && Number.isFinite(finishMs(m))).map((m) => m.id!);
  if (leafIds.length === 0) return empty;

  // A link to / from a phase applies to every leaf inside it.
  const leavesUnder = new Map<string, string[]>();
  const leavesOf = (id: string): string[] => {
    const cached = leavesUnder.get(id);
    if (cached) return cached;
    const out: string[] = [];
    const stack = [id]; const seen = new Set<string>();
    while (stack.length) {
      const cur = stack.pop()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      const k = kids.get(cur) ?? [];
      if (k.length === 0) { if (byId.get(cur)?.plannedAt) out.push(cur); } else stack.push(...k);
    }
    leavesUnder.set(id, out);
    return out;
  };

  // Leaf-level successor edges with their lag (working hours; afterLagMs
  // turns them into calendar time from the instant they are counted from).
  const lagOf = new Map<string, Record<string, number> | null>();
  for (const n of reflowNodesFromMilestones(milestones)) lagOf.set(n.id, n.lagHours ?? null);
  const succ = new Map<string, Map<string, number>>(); // pred leaf → (succ leaf → lag, working hours)
  const hasPred = new Set<string>();
  let linked = false;
  for (const m of milestones) {
    if (!m.id) continue;
    for (const pred of m.dependsOn ?? []) {
      if (!byId.has(pred)) continue;
      const lagH = lagOf.get(m.id)?.[pred] ?? 0;
      for (const p of leavesOf(pred)) for (const s of leavesOf(m.id)) {
        if (p === s) continue;
        const row = succ.get(p) ?? new Map<string, number>();
        row.set(s, Math.max(row.get(s) ?? -Infinity, lagH));
        succ.set(p, row);
        hasPred.add(s);
        linked = true;
      }
    }
  }

  // The clock (see the header): Mon–Fri, unless an unfinished leaf starts or
  // finishes on a weekend — then every day counts. Lag on the 7-day clock is
  // its working days as calendar days, so the backward pass (lagWorkingMs)
  // and the driving test (lagEnd) still agree.
  const unfinished = (id: string) => { const m = byId.get(id)!; return m.status !== "completed" && !m.actualAt; };
  const calendar: PathCalendar = leafIds.some((id) => {
    if (!unfinished(id)) return false;
    const m = byId.get(id)!;
    const f = finishMs(m);
    const s = Number.isFinite(startMs(m)) ? startMs(m) : f;
    return onWeekend(s) || onWeekend(f);
  }) ? "seven-day" : "mon-fri";
  const clock = calendar === "seven-day" ? (ms: number) => ms : workingTimeMs;
  const lagEnd = calendar === "seven-day"
    ? (readyMs: number, lagH: number) => readyMs + lagWorkingMs(lagH)
    : afterLagMs;

  // Ready instants (calendar) and, on the path's clock, ready / occupied.
  const ready = new Map<string, number>();
  const readyW = new Map<string, number>();
  const occupiedW = new Map<string, number>();
  let projectFinish = -Infinity;
  for (const id of leafIds) {
    const m = byId.get(id)!;
    const f = finishMs(m);
    const s = Number.isFinite(startMs(m)) ? startMs(m) : f;
    const r = fsReadyMs(f);
    ready.set(id, r);
    readyW.set(id, clock(r));
    occupiedW.set(id, Math.max(0, clock(r) - clock(s)));
    projectFinish = Math.max(projectFinish, f);
  }

  // Reverse topological order (Kahn over the successor edges); a leaf left
  // over is inside a loop of links and is reported, not guessed at.
  const indeg = new Map<string, number>();
  for (const id of leafIds) indeg.set(id, 0);
  for (const [, row] of succ) for (const s of row.keys()) if (indeg.has(s)) indeg.set(s, indeg.get(s)! + 1);
  const order: string[] = [];
  const q = leafIds.filter((id) => indeg.get(id) === 0);
  while (q.length) {
    const cur = q.shift()!;
    order.push(cur);
    for (const s of succ.get(cur)?.keys() ?? []) {
      if (!indeg.has(s)) continue;
      const d = indeg.get(s)! - 1;
      indeg.set(s, d);
      if (d === 0) q.push(s);
    }
  }
  const inOrder = new Set(order);
  const cycle = leafIds.filter((id) => !inOrder.has(id));

  // Unfinished and analysable: not completed, no actual finish, not in a loop.
  const open = (id: string) => unfinished(id) && inOrder.has(id);
  // The finish the float is measured against: the latest ready instant of an
  // UNFINISHED leaf (a completed task's planned date gates nothing).
  let projectReadyW = -Infinity;
  for (const id of order) if (open(id)) projectReadyW = Math.max(projectReadyW, readyW.get(id)!);

  const lateReady = new Map<string, number>(); // the path's clock
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i];
    if (!open(id)) continue;
    let lr = projectReadyW;
    for (const [s, lag] of succ.get(id) ?? []) {
      const sLate = lateReady.get(s);
      if (sLate === undefined) continue; // a finished successor, or one inside a loop, does not constrain
      lr = Math.min(lr, sLate - occupiedW.get(s)! - lagWorkingMs(lag));
    }
    lateReady.set(id, lr);
  }

  const floatDays = new Map<string, number>();
  let unlinked = 0;
  for (const id of order) {
    if (!open(id)) continue;
    floatDays.set(id, Math.round(((lateReady.get(id)! - readyW.get(id)!) / DAY_MS) * 10) / 10);
    if (!hasPred.has(id) && !succ.has(id)) unlinked++;
  }

  // The driving chain(s), traced back from the finish through driving links,
  // each gap measured on the path's clock.
  const preds = new Map<string, Array<{ p: string; lag: number }>>();
  for (const [p, row] of succ) for (const [sId, lag] of row) {
    const arr = preds.get(sId) ?? []; arr.push({ p, lag }); preds.set(sId, arr);
  }
  const ids = new Set<string>();
  const stack = leafIds.filter((id) => open(id) && projectReadyW - readyW.get(id)! < tolerance);
  while (stack.length) {
    const id = stack.pop()!;
    if (ids.has(id)) continue;
    ids.add(id);
    const startW = readyW.get(id)! - occupiedW.get(id)!;
    for (const { p, lag } of preds.get(id) ?? []) {
      if (!open(p) || ids.has(p)) continue;
      if (startW - clock(lagEnd(ready.get(p)!, lag)) < tolerance) stack.push(p);
    }
  }
  let remainingHours = 0;
  for (const id of ids) {
    const m = byId.get(id)!;
    if (typeof m.durationHours === "number" && m.durationHours > 0) {
      remainingHours += m.durationHours * (100 - leafPercent(m)) / 100;
    }
  }

  return {
    ids,
    finish: Number.isFinite(projectFinish) ? new Date(projectFinish).toISOString() : null,
    remainingHours,
    floatDays,
    calendar,
    linked,
    unlinked,
    cycle: cycle.length > 0 ? cycle : null,
  };
}
