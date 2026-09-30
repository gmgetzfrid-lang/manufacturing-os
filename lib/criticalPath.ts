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
// working days on the path's clock (scheduleReflow.lagWorkingMs) — "+5d" is
// five working days, not 40 elapsed hours.
//
// Every gap, occupancy, lag and float is measured on the WORKING clock
// (scheduleReflow.workingClock): Monday to Friday, the clock stopped over the
// weekend — plus the weekend DAYS that carry unfinished work. Measured in
// calendar days, a Friday finish followed by a Monday start is two days of
// "float", so every weekly hand-off broke the chain and the path stopped at
// the last weekend. Measured Mon–Fri only, weekend work weighed nothing: every
// weekend instant collapses onto Friday 24:00, so a Saturday task with a day
// of slack, or an unlinked Saturday-morning job, read as critical. Float is
// reported in working days of that clock.
//
// With no project calendar the worked weekend days are INFERRED, day by day
// (never the plan's whole week — one Saturday job used to put every weekend
// of the plan on the clock and break every Friday-to-Monday hand-off):
//   * an unfinished leaf that starts or finishes on a Saturday or Sunday
//     (wall-clock-as-UTC) is worked on weekends, so every Saturday and Sunday
//     it spans counts — a weekend shutdown, a Sat → Tue outage task;
//   * a leaf whose both ends fall on weekdays says nothing about the weekend
//     it spans (a six-working-day task runs Monday to Monday), so it marks
//     no weekend day;
//   * a weekend day counts only for the LINKED NETWORK whose leaves work it
//     (the leaves joined by finish-to-start links, either way): an unrelated
//     Saturday job does not give a Mon–Fri chain a day of float at its
//     hand-off. A leaf with no link at all is measured against the finish on
//     the plan's clock (every worked weekend day), so an unlinked Saturday
//     job is not read as ending at a Sunday finish.
// A finished leaf (completed, or with an actual) marks nothing.
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
import { DAY_MS, fsReadyMs, isWeekendUtcDay, lagWorkingMs, reflowNodesFromMilestones, workingClock } from "@/lib/scheduleReflow";
import { leafPercent } from "@/lib/scheduleProgress";

export interface CriticalPathResult {
  /** Unfinished leaf ids on the driving chain(s) back from the finish — what gates it. */
  ids: Set<string>;
  /** The schedule's envelope (ISO): the latest leaf finish, finished tasks included. */
  finish: string | null;
  /** Hours still to do on the path: Σ planned hours × (100 − % complete) / 100. */
  remainingHours: number;
  /** Total float per unfinished leaf, in working days — Monday to Friday
   *  plus the weekend days its linked network works (leaves in a loop are
   *  absent). */
  floatDays: Map<string, number>;
  /** "mon-fri" when no unfinished leaf works a weekend day; else
   *  "worked-weekends": Monday to Friday plus `workedWeekendDays`. */
  calendar: PathCalendar;
  /** The Saturdays and Sundays that carry unfinished work (YYYY-MM-DD,
   *  ascending), inferred as the header says — the days added to the
   *  Mon–Fri clock (each only for the linked network that works it). */
  workedWeekendDays: string[];
  /** Whether any finish-to-start link connects two leaves at all. */
  linked: boolean;
  /** Unfinished leaves with no link in or out — they count only when they
   *  end at the finish, so the screen can say "add links to see the chain". */
  unlinked: number;
  /** Leaf ids inside a loop of links (left out of the pass), or null. */
  cycle: string[] | null;
}

/** The working week the path is measured on (see the header). */
export type PathCalendar = "mon-fri" | "worked-weekends";

/** How a caption names the clock: "working days Mon–Fri", plus the weekend
 *  days with work planned on them when there are any. */
export function pathCalendarLabel(calendar: PathCalendar, workedWeekendDays = 0): string {
  if (calendar !== "worked-weekends") return "working days Mon–Fri";
  return workedWeekendDays > 0
    ? `working days Mon–Fri, plus the ${workedWeekendDays} weekend day${workedWeekendDays === 1 ? "" : "s"} with work planned on ${workedWeekendDays === 1 ? "it" : "them"}`
    : "working days Mon–Fri, plus the weekend days with work planned on them";
}

const startMs = (m: Milestone) => Date.parse((m.plannedStartAt as string | undefined) ?? (m.plannedAt as string));
const finishMs = (m: Milestone) => Date.parse(m.plannedAt as string);

export function computeCriticalPath(
  milestones: Milestone[],
  opts?: { toleranceDays?: number },
): CriticalPathResult {
  const tolerance = (opts?.toleranceDays ?? 1) * DAY_MS;
  const empty: CriticalPathResult = { ids: new Set(), finish: null, remainingHours: 0, floatDays: new Map(), calendar: "mon-fri", workedWeekendDays: [], linked: false, unlinked: 0, cycle: null };

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

  // Leaf-level successor edges with their lag (working hours; lagWorkingMs
  // turns them into a length on the path's clock).
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

  // The clock (see the header): Mon–Fri plus the weekend days that carry
  // unfinished work, each counted for the linked network that works it.
  const unfinished = (id: string) => { const m = byId.get(id)!; return m.status !== "completed" && !m.actualAt; };
  const spanOf = (id: string): { s: number; f: number } => {
    const m = byId.get(id)!;
    const f = finishMs(m);
    return { s: Number.isFinite(startMs(m)) ? startMs(m) : f, f };
  };
  const workedDaysOf = (id: string): number[] => {
    if (!unfinished(id)) return [];
    const { s, f } = spanOf(id);
    const first = Math.floor(s / DAY_MS);
    const last = Math.floor((fsReadyMs(f) - 1) / DAY_MS); // the day its work ends in
    if (!Number.isFinite(first) || !Number.isFinite(last)) return [];
    if (!isWeekendUtcDay(first) && !isWeekendUtcDay(last)) return []; // weekday ends: says nothing
    const out: number[] = [];
    for (let day = first; day <= last;) {
      const wd = new Date(day * DAY_MS).getUTCDay(); // 0 Sun … 6 Sat
      if (wd === 6 || wd === 0) { out.push(day); day += wd === 6 ? 1 : 6; } else day += 6 - wd;
    }
    return out;
  };
  // Linked networks: the leaves joined by links, either way (union–find).
  const root = new Map<string, string>();
  for (const id of leafIds) root.set(id, id);
  const find = (x: string): string => {
    let r = x;
    while (root.get(r) !== r) r = root.get(r)!;
    for (let c = x; root.get(c) !== r;) { const n = root.get(c)!; root.set(c, r); c = n; }
    return r;
  };
  for (const [p, row] of succ) for (const sId of row.keys()) {
    if (!root.has(p) || !root.has(sId)) continue;
    const a = find(p), b = find(sId);
    if (a !== b) root.set(a, b);
  }
  const daysByNet = new Map<string, number[]>();
  const planDays = new Set<number>();
  for (const id of leafIds) {
    const days = workedDaysOf(id);
    if (days.length === 0) continue;
    const net = find(id);
    const arr = daysByNet.get(net) ?? [];
    for (const day of days) { arr.push(day); planDays.add(day); }
    daysByNet.set(net, arr);
  }
  const planClock = workingClock(planDays);
  const netClock = new Map<string, (ms: number) => number>();
  const clockOf = (id: string): ((ms: number) => number) => {
    // A leaf with no link is measured on the plan's clock (see the header).
    if (!hasPred.has(id) && !succ.has(id)) return planClock;
    const net = find(id);
    let c = netClock.get(net);
    if (!c) { c = workingClock(daysByNet.get(net) ?? []); netClock.set(net, c); }
    return c;
  };
  const calendar: PathCalendar = planDays.size > 0 ? "worked-weekends" : "mon-fri";

  // Ready instants (calendar) and, on each leaf's clock, ready / occupied.
  const ready = new Map<string, number>();
  const readyW = new Map<string, number>();
  const occupiedW = new Map<string, number>();
  let projectFinish = -Infinity;
  for (const id of leafIds) {
    const { s, f } = spanOf(id);
    const clock = clockOf(id);
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
  // UNFINISHED leaf (a completed task's planned date gates nothing), read on
  // each leaf's clock. A link joins two leaves of one network, so a leaf and
  // its successors share a clock.
  let projectReady = -Infinity;
  for (const id of order) if (open(id)) projectReady = Math.max(projectReady, ready.get(id)!);
  const finishW = (id: string) => clockOf(id)(projectReady);

  const lateReady = new Map<string, number>(); // the leaf's clock
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i];
    if (!open(id)) continue;
    let lr = finishW(id);
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
  // each gap (and lag) measured on the network's clock — the one the
  // backward pass used, so a link with no float always drives.
  const preds = new Map<string, Array<{ p: string; lag: number }>>();
  for (const [p, row] of succ) for (const [sId, lag] of row) {
    const arr = preds.get(sId) ?? []; arr.push({ p, lag }); preds.set(sId, arr);
  }
  const ids = new Set<string>();
  const stack = leafIds.filter((id) => open(id) && finishW(id) - readyW.get(id)! < tolerance);
  while (stack.length) {
    const id = stack.pop()!;
    if (ids.has(id)) continue;
    ids.add(id);
    const startW = readyW.get(id)! - occupiedW.get(id)!;
    for (const { p, lag } of preds.get(id) ?? []) {
      if (!open(p) || ids.has(p)) continue;
      if (startW - (readyW.get(p)! + lagWorkingMs(lag)) < tolerance) stack.push(p);
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
    workedWeekendDays: [...planDays].sort((a, b) => a - b).map((day) => new Date(day * DAY_MS).toISOString().slice(0, 10)),
    linked,
    unlinked,
    cycle: cycle.length > 0 ? cycle : null,
  };
}
