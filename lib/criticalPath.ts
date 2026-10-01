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
// unfinished leaves. Each leaf keeps its planned dates. Every finish-to-start
// link p → s has a GAP — from p being ready (+ lag) to s starting — and every
// leaf a hand-off to the finish; a leaf's TOTAL FLOAT is
//
//     float(n) = min( finish − ready(n),
//                     min over unfinished successors s of (gap(n→s) + float(s)) )
//
// — the least, over its chains of links to the finish, of the gaps along the
// chain (reported per leaf). With one clock this is CPM's lateReady − ready.
// "The finish" here is the latest ready instant of an UNFINISHED leaf: a task
// that is done (completed, or carrying an actual finish) no longer gates
// anything, so a completed inspection that still carries the latest planned
// date does not empty the path, and a finished successor does not constrain
// its predecessors. "Ready" is the instant a finish-to-start successor may
// start (scheduleReflow.fsReadyMs: the end of the day for a date-only finish,
// the instant for a timed one), and lag is the source schedule's own
// (attributes.source_links, PT SCH-8), stored in WORKING hours and counted as
// working days of the clock (scheduleReflow.lagWorkingMs) — "+5d" is five
// working days, not 40 elapsed hours.
//
// Every gap, lag and float is measured on a WORKING clock
// (scheduleReflow.workingClock): Monday to Friday, the clock stopped over the
// weekend — plus the weekend DAYS the hand-off's own two tasks work.
// Measured in calendar days, a Friday finish followed by a Monday start is
// two days of "float", so every weekly hand-off broke the chain and the path
// stopped at the last weekend. Measured Mon–Fri only, weekend work
// weighed nothing: every weekend instant collapses onto Friday 24:00, so a
// Saturday task with a day of slack, or an unlinked Saturday-morning job, read
// as critical. Float is reported in working days.
//
// With no project calendar the worked weekend days are INFERRED, day by day,
// and each hand-off is measured on the clock of its OWN two tasks:
//   * a leaf's own weekend days: an unfinished leaf that starts or finishes on
//     a Saturday or Sunday (wall-clock-as-UTC) is worked on weekends, so every
//     Saturday and Sunday it spans counts — a weekend shutdown, a Sat → Tue
//     outage task. A leaf whose both ends fall on weekdays says nothing about
//     the weekend it spans (a six-working-day task runs Monday to Monday), so
//     it marks no weekend day. A finished leaf marks nothing;
//   * a link p → s is measured Monday to Friday plus the weekend days of p and
//     of s — never those of any other task. A predecessor's days end on the
//     day it finishes and a successor's begin on the day it starts, so a day
//     counts inside a hand-off only as the rest of a weekend day p finishes
//     on, or the part of a weekend day before s starts on it: a weekend
//     crew's Sat 17:00 → Sun 08:00 overnight is 15 hours, while a Friday task
//     feeding a Monday restart is critical (0 float) whatever weekend work
//     also feeds that restart — P6's and MS Project's answer for a Mon–Fri
//     task — and a Saturday job anywhere in the plan never gives a Mon–Fri
//     chain float (the clock is never the plan's, a linked network's, nor a
//     successor's inputs'). For a date-only plan every hand-off is Mon–Fri;
//   * the hand-off to the finish is measured the same way, on the leaf's own
//     days and those of the leaves that set the finish, so an unlinked
//     Saturday-morning job in a weekend shutdown is weighed against the
//     Sunday finish across both days.
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
// from a phase applies to every leaf inside it — so a task linked to a phase
// it sits in (or a phase to its own task) would wait for itself, and is a
// loop, as the link checks and the cascade read it. A LOOP is a strongly
// connected set of unfinished leaves (Tarjan), or one leaf that waits for
// itself: only its members are reported and left out. Every other leaf keeps
// its place in the pass, its links to a loop member dropped, so a loop
// upstream does not take the rest of the path with it. A finished leaf gates
// nothing and waits for nothing here, so a loop through one is not a loop
// for the path. The finish is still the latest UNFINISHED work, a loop
// member's included: every other leaf's float is measured against it, and
// when a loop member's work is the latest — and no unfinished task outside
// the loop ends within the tolerance (under a working day) of it — no chain
// drives the finish: the path is empty and `finishInLoop` says why (eighth review pass: the finish
// was the latest work OUTSIDE the loop, so a chain weeks short of the planned
// finish was drawn at 0 float as "driving the finish"). Pure.

import type { Milestone } from "@/types/schema";
import { DAY_MS, fsReadyMs, isWeekendUtcDay, lagWorkingMs, reflowNodesFromMilestones, workingTimeMs } from "@/lib/scheduleReflow";
import { leafPercent } from "@/lib/scheduleProgress";

export interface CriticalPathResult {
  /** Unfinished leaf ids on the driving chain(s) back from the finish — what gates it. */
  ids: Set<string>;
  /** The schedule's envelope (ISO): the latest leaf finish, finished tasks included. */
  finish: string | null;
  /** Hours still to do on the path: Σ planned hours × (100 − % complete) / 100. */
  remainingHours: number;
  /** Total float per unfinished leaf, in working days: the least, over its
   *  chains of links to the finish, of the gaps along the chain — each
   *  measured Monday to Friday plus the weekend days the link's own two
   *  tasks are planned on (leaves in a loop are absent). */
  floatDays: Map<string, number>;
  /** The clock the PATH was measured on: "mon-fri" when none of its tasks
   *  and hand-offs counts a weekend day; else "worked-weekends": Monday to
   *  Friday plus `workedWeekendDays`. */
  calendar: PathCalendar;
  /** The Saturdays and Sundays the path was measured with (YYYY-MM-DD,
   *  ascending): those its own tasks work, and those counted inside one of
   *  its hand-offs — inferred as the header says. Weekend work elsewhere in
   *  the plan (off the path) is not listed; it still counts in its own
   *  hand-offs' float. */
  workedWeekendDays: string[];
  /** Whether any finish-to-start link connects two leaves at all. */
  linked: boolean;
  /** Unfinished leaves with no link in or out — they count only when they
   *  end at the finish, so the screen can say "add links to see the chain". */
  unlinked: number;
  /** The unfinished leaves that are MEMBERS of a loop of links (left out of
   *  the pass), or null. Only the members: a leaf downstream of a loop keeps
   *  its place on the path. */
  cycle: string[] | null;
  /** The same members, one list per loop — each strongly connected set of
   *  leaves, or one leaf that waits for itself through a phase — so a screen
   *  can tell tasks that wait for EACH OTHER from separate loops (two tasks
   *  each linked to its own phase are two loops, not one). Null with cycle. */
  loops: string[][] | null;
  /** True when a loop member's work is the latest unfinished work and no
   *  unfinished task outside a loop ends within the tolerance (under a
   *  working day) of it, so no chain of links drives the finish and `ids`
   *  is empty. Exactly when `ids` is empty because of a loop. */
  finishInLoop: boolean;
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

/** How a screen names the tasks a loop of links keeps off the path, given
 *  each loop's task names (CriticalPathResult.loops): one task that waits
 *  for itself, several that wait for each other, or — when there are
 *  separate loops — each group named on its own, since removing a link in
 *  one puts back only that loop's tasks (eighth review pass: two tasks each
 *  linked to its own phase read "these tasks wait for each other"). At most
 *  `max` names are listed. Null when there is no loop. */
export function loopNote(groups: string[][], max = 5): string | null {
  const loops = groups.filter((g) => g.length > 0);
  if (loops.length === 0) return null;
  const total = loops.reduce((n, g) => n + g.length, 0);
  const shown: string[][] = [];
  let left = max;
  for (const g of loops) {
    if (left <= 0) break;
    shown.push(g.slice(0, left));
    left -= g.length;
  }
  const listed = shown.reduce((n, g) => n + g.length, 0);
  const names = shown.map((g) => g.map((n) => `“${n}”`).join(", ")).join("; ") + (total > listed ? `, +${total - listed} more` : "");
  const fix = "(in the task panel, or in the scheduling tool for an imported task)";
  if (loops.length > 1) {
    return `Left out of the path — these tasks are in ${loops.length} separate loops of links, each waiting for itself through its links or its phase: ${names}. Remove one link in each loop ${fix} to put its tasks back on the path.`;
  }
  return total === 1
    ? `Left out of the path — this task waits for itself through a loop of links: ${names}. Remove one of those links ${fix} to put it back on the path.`
    : `Left out of the path — these tasks wait for each other through a loop of links: ${names}. Remove one of those links ${fix} to put them back on the path.`;
}

const startMs = (m: Milestone) => Date.parse((m.plannedStartAt as string | undefined) ?? (m.plannedAt as string));
const finishMs = (m: Milestone) => Date.parse(m.plannedAt as string);

export function computeCriticalPath(
  milestones: Milestone[],
  opts?: { toleranceDays?: number },
): CriticalPathResult {
  const tolerance = (opts?.toleranceDays ?? 1) * DAY_MS;
  const empty: CriticalPathResult = { ids: new Set(), finish: null, remainingHours: 0, floatDays: new Map(), calendar: "mon-fri", workedWeekendDays: [], linked: false, unlinked: 0, cycle: null, loops: null, finishInLoop: false };

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
  // A leaf that would wait for ITSELF through a phase — a task linked to a
  // phase it sits in, or a phase linked to a task inside it — is in a loop,
  // as the link checks and the cascade read it (scheduleReflow linkCyclePath
  // / planCascade): reported and left out, never read as "waits for the rest
  // of the phase" (sixth review pass: the three read that link three ways).
  // Its links to the other leaves still count below, so the loop is only the
  // leaf itself (and any leaf it is strongly connected with).
  const selfLoop = new Set<string>();
  let linked = false;
  for (const m of milestones) {
    if (!m.id) continue;
    for (const pred of m.dependsOn ?? []) {
      if (!byId.has(pred)) continue;
      const lagH = lagOf.get(m.id)?.[pred] ?? 0;
      for (const p of leavesOf(pred)) for (const s of leavesOf(m.id)) {
        if (p === s) { selfLoop.add(s); continue; }
        const row = succ.get(p) ?? new Map<string, number>();
        row.set(s, Math.max(row.get(s) ?? -Infinity, lagH));
        succ.set(p, row);
        hasPred.add(s);
        linked = true;
      }
    }
  }

  // The loops: the strongly connected components of the successor edges
  // between UNFINISHED leaves (Tarjan, iterative), plus each unfinished leaf
  // that waits for itself through a phase. Only their MEMBERS are left out
  // (seventh review pass: Kahn's leftover was reported as "the loop", and it
  // held every leaf downstream of the loop too — a phase link expands to
  // every leaf of the phase, so one task linked to its own phase took every
  // later phase off the path and the board highlighted the wrong chain). A
  // finished leaf gates nothing and waits for nothing (the float pass skips
  // its links), so its edges are not read here and a loop through one is no
  // loop for the path.
  const leafSet = new Set(leafIds);
  const unfinished = (id: string) => { const m = byId.get(id)!; return m.status !== "completed" && !m.actualAt; };
  const liveEdge = (p: string, s: string) => p !== s && leafSet.has(p) && leafSet.has(s) && unfinished(p) && unfinished(s);
  const loopMember = new Set<string>();
  const loopSets: string[][] = [];
  {
    const index = new Map<string, number>();
    const low = new Map<string, number>();
    const stack: string[] = [];
    const onStack = new Set<string>();
    let next = 0;
    const outs = (v: string) => [...(succ.get(v)?.keys() ?? [])].filter((w) => liveEdge(v, w));
    for (const root of leafIds) {
      if (index.has(root)) continue;
      const visit = (v: string) => { index.set(v, next); low.set(v, next); next++; stack.push(v); onStack.add(v); };
      visit(root);
      const work: Array<{ v: string; i: number; out: string[] }> = [{ v: root, i: 0, out: outs(root) }];
      while (work.length) {
        const top = work[work.length - 1];
        if (top.i < top.out.length) {
          const w = top.out[top.i++];
          if (!index.has(w)) { visit(w); work.push({ v: w, i: 0, out: outs(w) }); }
          else if (onStack.has(w)) low.set(top.v, Math.min(low.get(top.v)!, index.get(w)!));
          continue;
        }
        work.pop();
        if (work.length) { const up = work[work.length - 1].v; low.set(up, Math.min(low.get(up)!, low.get(top.v)!)); }
        if (low.get(top.v) === index.get(top.v)) {
          const comp: string[] = [];
          let w: string;
          do { w = stack.pop()!; onStack.delete(w); comp.push(w); } while (w !== top.v);
          if (comp.length > 1) { for (const c of comp) loopMember.add(c); loopSets.push(comp); }
          else if (selfLoop.has(top.v) && unfinished(top.v)) { loopMember.add(top.v); loopSets.push(comp); }
        }
      }
    }
  }

  // Reverse topological order (Kahn) over every leaf outside a loop, on the
  // edges between leaves that are unfinished and outside a loop — acyclic by
  // construction, so every such leaf is placed and keeps its place.
  const live = (id: string) => !loopMember.has(id) && unfinished(id);
  const indeg = new Map<string, number>();
  for (const id of leafIds) if (!loopMember.has(id)) indeg.set(id, 0);
  for (const [p, row] of succ) {
    if (!indeg.has(p) || !live(p)) continue;
    for (const s of row.keys()) if (liveEdge(p, s) && indeg.has(s) && live(s)) indeg.set(s, indeg.get(s)! + 1);
  }
  const order: string[] = [];
  const q = leafIds.filter((id) => indeg.get(id) === 0);
  while (q.length) {
    const cur = q.shift()!;
    order.push(cur);
    if (!live(cur)) continue;
    for (const s of succ.get(cur)?.keys() ?? []) {
      if (!liveEdge(cur, s) || !indeg.has(s) || !live(s)) continue;
      const d = indeg.get(s)! - 1;
      indeg.set(s, d);
      if (d === 0) q.push(s);
    }
  }
  const inOrder = new Set(order);
  // The loop's members (a leaf the order could not place would be one too;
  // none can be).
  const cycle = leafIds.filter((id) => loopMember.has(id) || !inOrder.has(id));
  // Each loop's members in list order, the loops by their first member.
  const position = new Map(leafIds.map((id, i) => [id, i] as const));
  const byPosition = (a: string, b: string) => position.get(a)! - position.get(b)!;
  const loops = loopSets.map((l) => [...l].sort(byPosition)).sort((a, b) => byPosition(a[0], b[0]));
  const preds = new Map<string, Array<{ p: string; lag: number }>>();
  for (const [p, row] of succ) for (const [sId, lag] of row) {
    const arr = preds.get(sId) ?? []; arr.push({ p, lag }); preds.set(sId, arr);
  }

  // The clock (see the header). A leaf's OWN weekend days: the Saturdays and
  // Sundays its unfinished span works, when it starts or finishes on one.
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
  // The days a hand-off counts: the weekend days of its OWN two ends — the
  // predecessor's and the successor's — and never those of any other task
  // (sixth review pass: the successor's inputs counted too, so one Saturday
  // delivery feeding W5 gave W4, and every week behind it, a day of float
  // and took the whole Mon–Fri chain off the path). Ascending day lists.
  const NONE: readonly number[] = [];
  const union = (a: readonly number[], b: readonly number[]): readonly number[] => {
    if (a.length === 0 || a === b) return b;
    if (b.length === 0) return a;
    if (a[a.length - 1] < b[0]) return a.concat(b);
    if (b[b.length - 1] < a[0]) return b.concat(a);
    const out: number[] = [];
    for (let i = 0, j = 0; i < a.length || j < b.length;) {
      const x = j >= b.length || (i < a.length && a[i] <= b[j]) ? a[i++] : b[j++];
      if (out.length === 0 || out[out.length - 1] !== x) out.push(x);
    }
    return out;
  };
  const ownDays = new Map<string, readonly number[]>();
  for (const id of leafIds) ownDays.set(id, workedDaysOf(id));
  const own = (id: string): readonly number[] => ownDays.get(id) ?? NONE;
  // The days of an ascending list that overlap [from, to).
  const workedIn = (days: readonly number[], from: number, to: number): number[] => {
    const out: number[] = [];
    if (days.length === 0 || !(to > from)) return out;
    const first = Math.floor(from / DAY_MS), last = Math.ceil(to / DAY_MS) - 1;
    let lo = 0, hi = days.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (days[mid] < first) lo = mid + 1; else hi = mid; }
    for (let i = lo; i < days.length && days[i] <= last; i++) out.push(days[i]);
    return out;
  };
  // Working time from `a` to `b` (signed) on the clock Mon–Fri + `days`:
  // what workingClock(days)(b) − workingClock(days)(a) reads, without
  // building a clock per list.
  const gapOn = (days: readonly number[], a: number, b: number): number => {
    const lo = Math.min(a, b), hi = Math.max(a, b);
    let worked = 0;
    for (const d of workedIn(days, lo, hi)) worked += Math.min(hi, (d + 1) * DAY_MS) - Math.max(lo, d * DAY_MS);
    return workingTimeMs(b) - workingTimeMs(a) + (b >= a ? worked : -worked);
  };

  // Ready and start instants (calendar).
  const ready = new Map<string, number>();
  const start = new Map<string, number>();
  let projectFinish = -Infinity;
  for (const id of leafIds) {
    const { s, f } = spanOf(id);
    ready.set(id, fsReadyMs(f));
    start.set(id, s);
    projectFinish = Math.max(projectFinish, f);
  }

  // Unfinished and analysable: not completed, no actual finish, not a loop's
  // member (a leaf downstream of one is analysed; its link from the member
  // is not read, as a finished predecessor's is not).
  const open = (id: string) => unfinished(id) && inOrder.has(id);
  // The finish the float is measured against: the latest ready instant of an
  // UNFINISHED leaf (a completed task's planned date gates nothing) — a
  // loop's members included: their work is still planned to end then, so a
  // leaf outside the loop has float up to it, and when a member's work is
  // the latest the path is empty unless a leaf outside the loop ends within
  // the tolerance of it (eighth review pass: the latest work outside the loop was used, and
  // a chain weeks short of the finish read 0 float). The hand-off to it is
  // measured, like a link, on its two ends' days: the leaf's own and those
  // of the leaves that set the finish.
  let projectReady = -Infinity;
  for (const id of leafIds) if (unfinished(id)) projectReady = Math.max(projectReady, ready.get(id)!);
  let finishDays: readonly number[] = NONE;
  for (const id of leafIds) if (unfinished(id) && ready.get(id) === projectReady) finishDays = union(finishDays, own(id));
  const toFinishDays = (id: string) => union(own(id), finishDays);
  const toFinishMs = (id: string) => gapOn(toFinishDays(id), ready.get(id)!, projectReady);
  // A link's gap: from the predecessor being ready (+ lag) to the successor's
  // start, on the clock of the link's own two ends.
  const linkDays = (p: string, s: string) => union(own(p), own(s));
  const gapMs = (p: string, s: string, lag: number) =>
    gapOn(linkDays(p, s), ready.get(p)!, start.get(s)!) - lagWorkingMs(lag);

  // Total float, backward: the least, over the leaf's chains of links to the
  // finish, of the gaps along the chain (each on its own two ends' clock)
  // plus the last leaf's hand-off to the finish. A finished successor, or
  // one inside a loop, does not constrain.
  const floatMs = new Map<string, number>();
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i];
    if (!open(id)) continue;
    let f = toFinishMs(id);
    for (const [s, lag] of succ.get(id) ?? []) {
      const fs = floatMs.get(s);
      if (fs === undefined) continue;
      f = Math.min(f, gapMs(id, s, lag) + fs);
    }
    floatMs.set(id, f);
  }

  const floatDays = new Map<string, number>();
  let unlinked = 0;
  for (const id of order) {
    if (!open(id)) continue;
    floatDays.set(id, Math.round((floatMs.get(id)! / DAY_MS) * 10) / 10);
    if (!hasPred.has(id) && !succ.has(id)) unlinked++;
  }

  // The driving chain(s), traced back from the finish through driving links,
  // each gap (and lag) measured as the float was, so a link with no float
  // always drives.
  const ids = new Set<string>();
  const atFinish = leafIds.filter((id) => open(id) && toFinishMs(id) < tolerance);
  const stack = [...atFinish];
  while (stack.length) {
    const id = stack.pop()!;
    if (ids.has(id)) continue;
    ids.add(id);
    for (const { p, lag } of preds.get(id) ?? []) {
      if (!open(p) || ids.has(p)) continue;
      if (gapMs(p, id, lag) < tolerance) stack.push(p);
    }
  }
  // The weekend days the PATH was measured with: those its own tasks work,
  // and those counted inside one of its hand-offs (a driving link, or a
  // driving task's hand-off to the finish) — what the captions count.
  const pathDays = new Set<number>();
  const countWithin = (days: readonly number[], from: number, to: number) => {
    for (const d of workedIn(days, from, to)) pathDays.add(d);
  };
  for (const id of ids) {
    for (const d of own(id)) pathDays.add(d);
    for (const { p, lag } of preds.get(id) ?? []) {
      if (ids.has(p) && gapMs(p, id, lag) < tolerance) countWithin(linkDays(p, id), ready.get(p)!, start.get(id)!);
    }
  }
  for (const id of atFinish) countWithin(toFinishDays(id), ready.get(id)!, projectReady);
  const calendar: PathCalendar = pathDays.size > 0 ? "worked-weekends" : "mon-fri";
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
    workedWeekendDays: [...pathDays].sort((a, b) => a - b).map((day) => new Date(day * DAY_MS).toISOString().slice(0, 10)),
    linked,
    unlinked,
    cycle: cycle.length > 0 ? cycle : null,
    loops: loops.length > 0 ? loops : null,
    finishInLoop: cycle.length > 0 && ids.size === 0,
  };
}
