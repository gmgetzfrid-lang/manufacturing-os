// lib/scheduleReflow.ts
//
// The math behind on-the-fly rescheduling in the Execution views.
//
// Field reality never matches the plan: you do 3 of 10 sub-items
// early, a cleaning crew is late so you jump ahead on other work and
// push the blocked work back. The schedule has to bend to that without
// a fight — and without silently inflating the total duration.
//
// ONE rule covers every case:
//
//   Dragging a node moves that node AND all its descendants by the
//   drop delta (preserving each item's own duration), then every
//   ANCESTOR's span is recomputed to exactly envelope its children.
//
//   * Drag a parent  → the whole subtree shifts together (job slipped).
//   * Drag one leaf  → only it moves; siblings stay; the parent bar
//                      "bleeds" to cover both the moved item and the
//                      ones still on the plan. Total span only grows
//                      if the moved item lands outside the envelope.
//
// This module is pure (no I/O) so it can be unit-tested and reused by
// both the timeline and the calendar tile view.

import type { Milestone } from "@/types/schema";
import { isImportedMilestone } from "@/lib/milestoneLiveness";

export interface ReflowNode {
  id: string;
  parentId?: string | null;
  /** ISO. When null, the node is treated as starting on plannedAt. */
  plannedStartAt?: string | null;
  /** ISO finish (always present). */
  plannedAt: string;
  /** Status — drives the default move mode (in_progress work that
   *  slips is taking LONGER → extend; everything else is just waiting
   *  → defer). Optional so existing callers keep working. */
  status?: string;
  /** Predecessor task ids (finish-to-start): this task can't start until
   *  every one of these finishes. Optional. */
  dependsOn?: string[] | null;
  /** Explicitly pin this node's dates (an ACTUAL). When omitted, a
   *  `status === "completed"` node is treated as locked. Locked tasks are
   *  never moved by reflow / cascade / sequencing — exactly like MS Project
   *  and Primavera, where actuals don't reschedule themselves. */
  locked?: boolean;
  /** The row's ACTUAL finish (actual_at). A row that carries one is locked
   *  exactly like a completed row — no batch engine rewrites its plan
   *  (PC SCHED-5), whatever its status reads. */
  actualAt?: string | null;
  /** Finish-to-start lag per predecessor id, in WORKING hours (negative =
   *  lead), as the source schedule recorded it (attributes.source_links, PT
   *  SCH-8) — the importer's unit: 8 h a working day, 40 h a working week
   *  (MS Project's LinkLag, P6's lag_hr_cnt). Applied through afterLagMs, as
   *  working days Monday–Friday, never as elapsed hours (PC SCHED-13). A
   *  predecessor with no entry has zero lag. */
  lagHours?: Record<string, number> | null;
}

/** Completed work, a row with an actual finish, or an explicitly pinned node
 *  is an ACTUAL: the reschedule engine never moves it. This is what lets you
 *  push the remaining work around without disturbing the tasks already in
 *  the ground. */
export function isLocked(n: ReflowNode | undefined): boolean {
  if (!n) return false;
  return n.locked === true || n.status === "completed" || !!n.actualAt;
}

export interface DateChange {
  id: string;
  plannedStartAt: string; // ISO
  plannedAt: string;      // ISO
}

// Two fundamentally different "moves":
//   defer  — we'll do it later. Start AND finish slide together;
//            duration (and work hours) unchanged.
//   extend — it's taking longer. Finish slides, start stays;
//            duration grows, so work hours grow with it.
export type MoveMode = "defer" | "extend";

/** Pick the sensible default mode from a node's status:
 *  in_progress that slips later = taking longer (extend); anything
 *  else (planned / on_hold / blocked) = just waiting (defer). Moving
 *  EARLIER is always a defer (you can't "extend" backwards). */
export function defaultMoveMode(status: string | undefined, deltaDays: number): MoveMode {
  if (deltaDays < 0) return "defer";
  return status === "in_progress" ? "extend" : "defer";
}

export interface MoveImpact {
  changes: DateChange[];
  mode: MoveMode;
  /** Days the node moved (the requested delta). */
  deltaDays: number;
  /** True when this move changes the node's own duration (extend). */
  addsDuration: boolean;
  /** Node's duration before / after, in days (calendar span). */
  durationDaysBefore: number;
  durationDaysAfter: number;
}

export const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** Is `ms` exactly 00:00:00.000 UTC — a date-only value under the
 *  wall-clock-as-UTC storage convention? */
export function isUtcMidnight(ms: number): boolean {
  return Number.isFinite(ms) && ms % DAY_MS === 0;
}

/** The instant a finish-to-start successor may start after a task that
 *  finishes at `finishMs` (PC SCHED-13). A date-only finish (stored at 00:00
 *  UTC) covers that whole day — the board draws it to the end of the day —
 *  so work may follow from the next midnight. A timed finish (MS Project's
 *  17:00) ends at its own instant: a successor may start the same evening
 *  or the next morning, never "a full calendar day later". */
export function fsReadyMs(finishMs: number): number {
  return isUtcMidnight(finishMs) ? finishMs + DAY_MS : finishMs;
}

/** The smallest whole-day shift that brings `startMs` to or past `requiredMs`
 *  (0 when it already is). Shifting by whole days keeps the task's clock time
 *  — an 08:00 start stays an 08:00 start (PC SCHED-13, PT SCH-11). */
export function wholeDaysToClear(startMs: number, requiredMs: number): number {
  if (!(startMs < requiredMs)) return 0;
  return Math.ceil((requiredMs - startMs) / DAY_MS) * DAY_MS;
}

/** Hours in one working day — the unit the importer stores lag in
 *  (lib/scheduleParsers.ts durationTextToHours: "1d" = 8 h, "1w" = 40 h;
 *  MS Project LinkLag / 600; P6 lag_hr_cnt). */
export const WORK_DAY_HOURS = 8;

/** Does the one-day step [a, a + 1 day) cover a working day — is the calendar
 *  day its last instant falls in a Monday to Friday (wall-clock-as-UTC)? For
 *  a date-only anchor (00:00) that is the day itself; for a timed one (17:00)
 *  it is the day the step ends in, so a Friday 17:00 + 1 working day is the
 *  next Monday 17:00, as the scheduling tool counts it. */
function stepIsWorkday(a: number): boolean {
  const wd = new Date(a + DAY_MS - 1).getUTCDay();
  return wd !== 0 && wd !== 6;
}

/** The instant a finish-to-start lag of `lagHours` WORKING hours (negative =
 *  lead) ends, counted from `readyMs` (fsReadyMs of the predecessor's finish)
 *  — PC SCHED-13. Whole working days (8 h each) skip Saturdays and Sundays;
 *  the hours left under a day are added as clock hours. Applying the stored
 *  hours as elapsed time cut a "+5d" lag (stored +40 h) to 1⅔ calendar days.
 *  There is still no project calendar: holidays are not skipped and a task
 *  pushed past the lag may land on a weekend (the engine counts calendar
 *  days). A negative lag (a lead) walks back the same way; walking a lag back
 *  from an instant and forward again never ends after that instant, which is
 *  what the critical path's backward pass relies on. */
export function afterLagMs(readyMs: number, lagHours: number | null | undefined): number {
  if (typeof lagHours !== "number" || !Number.isFinite(lagHours) || lagHours === 0 || !Number.isFinite(readyMs)) return readyMs;
  const abs = Math.abs(lagHours);
  let whole = Math.floor(abs / WORK_DAY_HOURS + 1e-9);
  const restMs = Math.max(0, Math.round((abs - whole * WORK_DAY_HOURS) * HOUR_MS));
  const dir = lagHours > 0 ? 1 : -1;
  // Forward: whole days, then the hours left. Backward undoes it in reverse
  // order (hours, then days), so walking a lead back and the lag forward
  // again never ends after where it started.
  let t = dir > 0 ? readyMs : readyMs - restMs;
  // Any seven consecutive day-steps hold exactly five working days: skip whole
  // weeks, leaving at least one working day for the day-by-day walk (which
  // stops right after the last working day, before a trailing weekend).
  if (whole > 5) {
    const weeks = Math.floor((whole - 1) / 5);
    t += dir * weeks * 7 * DAY_MS;
    whole -= weeks * 5;
  }
  if (dir > 0) {
    while (whole > 0) { if (stepIsWorkday(t)) whole--; t += DAY_MS; }
    return t + restMs;
  }
  while (whole > 0) { t -= DAY_MS; if (stepIsWorkday(t)) whole--; }
  return t;
}

// Monday 1970-01-05 00:00 UTC — the working clock's origin.
const WORK_EPOCH_MS = 4 * DAY_MS;

/** The WORKING clock: milliseconds of Monday-to-Friday time (wall-clock-as-
 *  UTC) elapsed since a fixed Monday. It runs through every weekday — the
 *  evening and the night included, like the calendar-day engine — and stops
 *  from Saturday 00:00 to Monday 00:00, so a Saturday or Sunday instant reads
 *  the same as the Monday 00:00 after it. The critical path measures gaps and
 *  float on it (PC SCHED-10): a Friday finish followed by a Monday start is
 *  a hand-off, not two days of float — and the weekend days that carry
 *  unfinished work are added back by workingClock (lib/criticalPath.ts). No
 *  holidays (no project calendar). */
export function workingTimeMs(ms: number): number {
  if (!Number.isFinite(ms)) return ms;
  const since = ms - WORK_EPOCH_MS;
  const day = Math.floor(since / DAY_MS);
  const week = Math.floor(day / 7);
  const dow = day - week * 7; // 0 = Monday … 6 = Sunday
  const inDay = since - day * DAY_MS;
  return week * 5 * DAY_MS + (dow < 5 ? dow * DAY_MS + inDay : 5 * DAY_MS);
}

/** Working time from `fromMs` to `toMs` on the working clock — negative when
 *  `toMs` is earlier. Saturdays and Sundays are not counted. */
export function workingGapMs(fromMs: number, toMs: number): number {
  return workingTimeMs(toMs) - workingTimeMs(fromMs);
}

/** Is the UTC day number `day` (floor(ms / DAY_MS)) a Saturday or a Sunday
 *  (wall-clock-as-UTC)? */
export function isWeekendUtcDay(day: number): boolean {
  const wd = new Date(day * DAY_MS).getUTCDay();
  return wd === 0 || wd === 6;
}

/** The working clock with some weekend DAYS worked (PC SCHED-10): Monday to
 *  Friday as workingTimeMs, plus exactly the Saturdays and Sundays listed in
 *  `workedWeekendDays` (UTC day numbers, floor(ms / DAY_MS)), each counted
 *  whole; every other weekend day still stops the clock. With none listed it
 *  IS workingTimeMs. A weekday in the list is ignored (it already counts). A
 *  stored lag's length on this clock is still lagWorkingMs: a working day is
 *  one day of the clock, whichever days count. */
export function workingClock(workedWeekendDays?: Iterable<number>): (ms: number) => number {
  const days = [...new Set(workedWeekendDays ?? [])]
    .filter((d) => Number.isInteger(d) && isWeekendUtcDay(d))
    .sort((a, b) => a - b);
  if (days.length === 0) return workingTimeMs;
  const worked = new Set(days);
  return (ms: number) => {
    if (!Number.isFinite(ms)) return ms;
    const day = Math.floor(ms / DAY_MS);
    // Worked weekend days wholly before this one (binary search).
    let lo = 0, hi = days.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (days[mid] < day) lo = mid + 1; else hi = mid; }
    return workingTimeMs(ms) + lo * DAY_MS + (worked.has(day) ? ms - day * DAY_MS : 0);
  };
}

/** A stored lag (WORKING hours, negative = lead) as a length on the working
 *  clock — what afterLagMs walks: a whole working day per WORK_DAY_HOURS,
 *  then the hours left under a day as clock hours. */
export function lagWorkingMs(lagHours: number | null | undefined): number {
  if (typeof lagHours !== "number" || !Number.isFinite(lagHours) || lagHours === 0) return 0;
  const abs = Math.abs(lagHours);
  const whole = Math.floor(abs / WORK_DAY_HOURS + 1e-9);
  const restMs = Math.max(0, Math.round((abs - whole * WORK_DAY_HOURS) * HOUR_MS));
  return (lagHours > 0 ? 1 : -1) * (whole * DAY_MS + restMs);
}

/** Add whole calendar days to an instant in UTC, keeping its clock time.
 *  The one date-arithmetic helper the schedule's editors share (PT SCH-12:
 *  local-calendar setDate on a UTC value gains or loses a day across DST). */
export function addUtcDays(iso: string, days: number): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  return new Date(t + days * DAY_MS).toISOString();
}

/** The start of a task that runs `days` calendar days and finishes at
 *  `finishIso` (inclusive): finish − (days − 1) days, in UTC (PT SCH-12). */
export function startForDuration(finishIso: string, days: number): string {
  return addUtcDays(finishIso, -(Math.max(1, Math.round(days)) - 1));
}

/** A stored instant as the wall-clock date + time an editor shows. Planned
 *  dates are wall-clock-as-UTC, so the UTC fields ARE the wall clock — a
 *  local rendering would show the wrong day west of Greenwich (PT SCH-10). */
export function toWallClock(iso: string | null | undefined): { date: string; time: string } | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const s = new Date(t).toISOString();
  return { date: s.slice(0, 10), time: s.slice(11, 16) };
}

/** A wall-clock date (YYYY-MM-DD) + time (HH:MM or HH:MM:SS; none = 00:00) as
 *  the stored instant — built as a UTC string, never parsed in the viewer's
 *  zone. Null when the date is not a real date or the time does not read. */
export function fromWallClock(date: string, time?: string | null): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  if (time && !/^\d{2}:\d{2}(:\d{2})?$/.test(time)) return null;
  const hms = !time ? "00:00:00" : time.length === 5 ? `${time}:00` : time;
  const t = Date.parse(`${date}T${hms}.000Z`);
  if (!Number.isFinite(t)) return null;
  const iso = new Date(t).toISOString();
  return iso.slice(0, 10) === date ? iso : null; // 2026-02-30 is not a date
}

function startMsOf(n: ReflowNode): number {
  const s = n.plannedStartAt ?? n.plannedAt;
  return Date.parse(s);
}
function finishMsOf(n: ReflowNode): number {
  return Date.parse(n.plannedAt);
}

/** Re-envelope every parent, deepest first, so each summary exactly covers
 *  its children — except a LOCKED parent (an imported summary, whose dates
 *  the scheduling tool owns; a pinned row; a row with an actual): it keeps
 *  its stored dates, and those are what its own parent envelopes (PT SCH-13,
 *  PC SCHED-5). Re-enveloping an imported phase whose stored span differs
 *  from its children's put it in the change set of every drag in the
 *  project, and the batch was then refused whole. */
function reenvelopeParents(
  byId: Map<string, ReflowNode>,
  childrenByParent: Map<string, ReflowNode[]>,
  start: Map<string, number>,
  finish: Map<string, number>,
): void {
  const depthOf = (nid: string): number => {
    let d = 0, c = byId.get(nid)?.parentId ?? null;
    const g = new Set<string>();
    while (c && byId.has(c) && !g.has(c)) { g.add(c); d++; c = byId.get(c)!.parentId ?? null; }
    return d;
  };
  for (const pid of [...childrenByParent.keys()].sort((a, b) => depthOf(b) - depthOf(a))) {
    if (isLocked(byId.get(pid))) continue;
    const kids = childrenByParent.get(pid) ?? [];
    if (kids.length === 0) continue;
    let lo = Infinity, hi = -Infinity;
    for (const k of kids) { lo = Math.min(lo, start.get(k.id)!); hi = Math.max(hi, finish.get(k.id)!); }
    if (Number.isFinite(lo) && Number.isFinite(hi)) { start.set(pid, lo); finish.set(pid, hi); }
  }
}

/** One DateChange per node whose start or finish moved. A locked node is
 *  never in it — no engine writes an actual's, a pinned row's or an imported
 *  row's dates (PT SCH-13, PC SCHED-5). */
function changesFrom(nodes: ReflowNode[], start: Map<string, number>, finish: Map<string, number>): DateChange[] {
  const changes: DateChange[] = [];
  for (const n of nodes) {
    if (isLocked(n)) continue;
    const s0 = startMsOf(n), f0 = finishMsOf(n);
    const s1 = start.get(n.id)!, f1 = finish.get(n.id)!;
    if (s1 !== s0 || f1 !== f0) {
      changes.push({ id: n.id, plannedStartAt: new Date(s1).toISOString(), plannedAt: new Date(f1).toISOString() });
    }
  }
  return changes;
}

/**
 * Compute the full set of date changes produced by dragging `id` by
 * `deltaDays`. Returns one DateChange per affected node (the dragged
 * subtree plus any ancestor whose envelope shifted). Empty when the
 * delta is zero or the node is unknown.
 */
export function computeTreeMove(
  nodes: ReflowNode[],
  id: string,
  deltaDays: number,
  mode: MoveMode = "defer",
): DateChange[] {
  if (!Number.isFinite(deltaDays) || deltaDays === 0) return [];

  const byId = new Map<string, ReflowNode>();
  const childrenByParent = new Map<string, ReflowNode[]>();
  for (const n of nodes) {
    byId.set(n.id, n);
  }
  for (const n of nodes) {
    const pid = n.parentId && byId.has(n.parentId) ? n.parentId : null;
    if (!pid) continue;
    const arr = childrenByParent.get(pid) ?? [];
    arr.push(n);
    childrenByParent.set(pid, arr);
  }
  if (!byId.has(id)) return [];

  const isLeaf = (nid: string) => (childrenByParent.get(nid)?.length ?? 0) === 0;
  // Can't move an actual. Dragging a completed leaf is a no-op; dragging a
  // parent still moves the unlocked work inside it (handled below).
  if (isLeaf(id) && isLocked(byId.get(id))) return [];

  const delta = deltaDays * DAY_MS;

  // Working copies of every node's start/finish in ms. We mutate these
  // as we shift the subtree and reflow parents, then diff at the end.
  const start = new Map<string, number>();
  const finish = new Map<string, number>();
  for (const n of nodes) {
    start.set(n.id, startMsOf(n));
    finish.set(n.id, finishMsOf(n));
  }

  // 1) Shift the LEAVES of the dragged subtree (parents derive their span in
  //    step 2). Completed/locked leaves are ACTUALS — they stay put while the
  //    remaining work slides around them.
  //    defer  → both start and finish shift by delta (slides in time).
  //    extend → the dragged leaf's FINISH moves but its START stays (it's
  //             taking longer). extend only ever applies to a dragged leaf;
  //             a dragged parent's leaves always defer-slide.
  const subtree: string[] = [];
  const stack = [id];
  const seen = new Set<string>();
  while (stack.length) {
    const cur = stack.pop()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    subtree.push(cur);
    for (const k of childrenByParent.get(cur) ?? []) stack.push(k.id);
  }
  for (const sid of subtree) {
    if (!isLeaf(sid)) continue;            // parents re-envelope in step 2
    if (isLocked(byId.get(sid))) continue; // actuals don't move
    if (mode === "extend" && sid === id) {
      finish.set(sid, finish.get(sid)! + delta);
    } else {
      start.set(sid, start.get(sid)! + delta);
      finish.set(sid, finish.get(sid)! + delta);
    }
  }

  // 2) Re-envelope EVERY parent (deepest first) so each summary exactly covers
  //    its children — including any locked leaf that stayed behind. Doing the
  //    whole tree (not just ancestors of the drag) keeps sub-parents correct
  //    when some of their children were locked. A locked parent (imported,
  //    pinned, an actual) keeps its stored dates (PT SCH-13).
  reenvelopeParents(byId, childrenByParent, start, finish);

  // 3) Emit a change for every unlocked node whose start or finish moved.
  return changesFrom(nodes, start, finish);
}

/** Days in a node's calendar span (finish − start + 1, min 1). */
function spanDays(n: ReflowNode): number {
  const d = Math.round((finishMsOf(n) - startMsOf(n)) / DAY_MS) + 1;
  return Math.max(1, d);
}

/**
 * Recompute EVERY parent/summary node's span to exactly envelope its
 * children, processing deepest parents first so each sees already-updated
 * child envelopes. Pure: returns one DateChange per parent whose span moved.
 * A locked parent — an imported summary (`locked`), an actual — keeps its
 * stored dates and is never in the result (PT SCH-13).
 *
 * Use after a direct leaf edit that did NOT go through computeTreeMove —
 * e.g. setTaskDuration, which changes a leaf's start/finish in isolation and
 * would otherwise leave the parent bar no longer covering its child.
 */
export function reflowAllAncestors(nodes: ReflowNode[]): DateChange[] {
  const byId = new Map<string, ReflowNode>();
  const childrenByParent = new Map<string, ReflowNode[]>();
  for (const n of nodes) byId.set(n.id, n);
  for (const n of nodes) {
    const pid = n.parentId && byId.has(n.parentId) ? n.parentId : null;
    if (!pid) continue;
    const arr = childrenByParent.get(pid) ?? [];
    arr.push(n);
    childrenByParent.set(pid, arr);
  }

  const start = new Map<string, number>();
  const finish = new Map<string, number>();
  for (const n of nodes) { start.set(n.id, startMsOf(n)); finish.set(n.id, finishMsOf(n)); }

  // Envelope bottom-up (a parent waits for descendants); a locked parent —
  // an imported summary, an actual — keeps its stored dates (PT SCH-13).
  reenvelopeParents(byId, childrenByParent, start, finish);
  return changesFrom(nodes, start, finish);
}

/**
 * Would adding `newPredId` as a predecessor of `taskId` create a cycle?
 * True if taskId is already (transitively) a predecessor of newPredId, or
 * they're the same task. Used to keep the dependency graph a DAG.
 */
export function wouldCreateCycle(nodes: ReflowNode[], taskId: string, newPredId: string): boolean {
  if (taskId === newPredId) return true;
  const byId = new Map<string, ReflowNode>();
  for (const n of nodes) byId.set(n.id, n);
  // Walk newPredId's predecessor closure; if we reach taskId, it's a cycle.
  const stack = [newPredId];
  const seen = new Set<string>();
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === taskId) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const p of byId.get(cur)?.dependsOn ?? []) stack.push(p);
  }
  return false;
}

/** Every task that (transitively) depends on `taskId`, plus `taskId` itself —
 *  exactly the tasks that may NOT become its predecessors. One O(n + e) walk,
 *  so a picker can test every candidate without a DFS per candidate
 *  (PT PERF-5). Run it over the FULL milestone set, never a filtered view
 *  (PT SCH-9). */
export function dependentsClosure(nodes: ReflowNode[], taskId: string): Set<string> {
  const successors = new Map<string, string[]>();
  for (const n of nodes) {
    for (const p of n.dependsOn ?? []) {
      const arr = successors.get(p) ?? [];
      arr.push(n.id);
      successors.set(p, arr);
    }
  }
  const out = new Set<string>([taskId]);
  const stack = [taskId];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const s of successors.get(cur) ?? []) {
      if (!out.has(s)) { out.add(s); stack.push(s); }
    }
  }
  return out;
}

/** The loop that adding "`taskId` depends on `newPredId`" would close, as a
 *  list of ids from `taskId` round to itself (`[taskId, …, newPredId,
 *  taskId]`), or null when it closes none — so a refusal can NAME the links
 *  (PT SCH-4 / SCH-9). */
export function linkCyclePath(nodes: ReflowNode[], taskId: string, newPredId: string): string[] | null {
  if (taskId === newPredId) return [taskId, taskId];
  const byId = new Map<string, ReflowNode>();
  for (const n of nodes) byId.set(n.id, n);
  // Search newPredId's predecessor closure for taskId, remembering the path.
  const prev = new Map<string, string>();
  const stack = [newPredId];
  const seen = new Set<string>([newPredId]);
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === taskId) {
      // cur (taskId) is a predecessor of … of newPredId: walk back to newPredId.
      const chain: string[] = [taskId];
      let x = taskId;
      while (x !== newPredId) { x = prev.get(x)!; chain.push(x); }
      // chain = [taskId, …, newPredId]: each depends on the one before it.
      return [...chain, taskId];
    }
    for (const p of byId.get(cur)?.dependsOn ?? []) {
      if (seen.has(p)) continue;
      seen.add(p);
      prev.set(p, cur);
      stack.push(p);
    }
  }
  return null;
}

/** A cascade that cannot be applied safely. `cycle`: the finish-to-start
 *  links (with a pushed task carrying its sub-tasks) form a loop, so every
 *  pass would push the same tasks out again — the move is refused instead of
 *  absorbed (PT SCH-4). `runaway`: a task would move further than any acyclic
 *  cascade over this schedule could push it (the span plus every task laid
 *  end to end, a day per link and every lag) — a backstop that only a loop
 *  can reach, so it never lets a cascade write dates years out. `edges` name
 *  the loop (or the chain that ran away) in order. */
export class CascadeRefusedError extends Error {
  readonly kind: "cycle" | "runaway";
  readonly edges: Array<{ from: string; to: string; via: "link" | "contains" }>;
  constructor(kind: "cycle" | "runaway", edges: Array<{ from: string; to: string; via: "link" | "contains" }>) {
    super(kind === "cycle"
      ? `The dependency links form a loop (${edges.map((e) => `${e.from} → ${e.to}`).join(", ")}); nothing was moved.`
      : `The cascade would push tasks further than any cascade over this schedule can (${edges.map((e) => `${e.from} → ${e.to}`).join(", ")}); nothing was moved.`);
    this.name = "CascadeRefusedError";
    this.kind = kind;
    this.edges = edges;
  }
}

/** What a cascade would write, and the locked successors it could not move. */
export interface CascadePlan {
  changes: DateChange[];
  /** Successors that are locked (an actual, a pinned or an imported row) and
   *  now start before their predecessor is ready. They were NOT moved; the
   *  caller says so rather than hiding the broken link. */
  held: Array<{ id: string; predecessorId: string }>;
}

/**
 * Forward finish-to-start cascade. After the tasks in `changedIds` moved,
 * push any dependent task that now starts before its predecessors are ready:
 * successor.start >= max(predecessor ready + lag), where "ready" is the
 * predecessor's finish instant — the end of its day for a date-only finish,
 * the instant itself for a timed one (fsReadyMs) — and lag is the source
 * schedule's own, in working time (ReflowNode.lagHours through afterLagMs,
 * default 0). A pushed task moves by whole days, so it keeps its clock time
 * (PC SCHED-13). Only ever pushes FORWARD (never pulls a task earlier),
 * carries each pushed task's subtree — except the actuals inside it, which
 * stay put (PC SCHED-5, matching computeTreeMove) — and re-envelopes
 * ancestors; a locked task or phase (an actual, an imported row) is never in
 * the result (PT SCH-13). Each task is settled once, in topological order
 * (PT SCH-4). A link from a PHASE waits for all the work inside it: the
 * phase is read at the latest current finish in its subtree, and a task that
 * moves inside a phase makes the phase's successors look again — a locked
 * phase (an actual, an imported or pinned summary) keeps its stored dates and
 * is never written, but its links are still honoured, and a locked successor
 * they now break is reported in `held` (PC SCHED-5). A loop in the links is
 * REFUSED with its edges named (CascadeRefusedError), and so is a push
 * further than any acyclic cascade over the schedule could go. Pure.
 */
export function cascadeDependents(nodes: ReflowNode[], changedIds: string[]): DateChange[] {
  return planCascade(nodes, changedIds).changes;
}

/** cascadeDependents, plus the locked successors it held (see CascadePlan). */
export function planCascade(nodes: ReflowNode[], changedIds: string[]): CascadePlan {
  const byId = new Map<string, ReflowNode>();
  const childrenByParent = new Map<string, ReflowNode[]>();
  for (const n of nodes) byId.set(n.id, n);
  for (const n of nodes) {
    const pid = n.parentId && byId.has(n.parentId) ? n.parentId : null;
    if (!pid) continue;
    const arr = childrenByParent.get(pid) ?? [];
    arr.push(n);
    childrenByParent.set(pid, arr);
  }

  // predecessor id -> ids of tasks that depend on it.
  const successors = new Map<string, string[]>();
  let edgeCount = 0;
  for (const n of nodes) {
    for (const pred of n.dependsOn ?? []) {
      if (!byId.has(pred)) continue;
      const arr = successors.get(pred) ?? [];
      arr.push(n.id);
      successors.set(pred, arr);
      edgeCount++;
    }
  }
  if (successors.size === 0) return { changes: [], held: [] };

  const start = new Map<string, number>();
  const finish = new Map<string, number>();
  let lo = Infinity, hi = -Infinity, work = 0, lagSpan = 0;
  for (const n of nodes) {
    const s0 = startMsOf(n), f0 = finishMsOf(n);
    start.set(n.id, s0); finish.set(n.id, f0);
    if (Number.isFinite(s0)) lo = Math.min(lo, s0);
    if (Number.isFinite(f0)) hi = Math.max(hi, f0);
    if (Number.isFinite(s0) && Number.isFinite(f0)) work += Math.max(0, f0 - s0) + DAY_MS;
    // A lag of H working hours spans at most H/8 working days × 7/5 in
    // calendar time, plus under a week of rounding and the hours under a day
    // (afterLagMs) — 8 days are allowed for those.
    for (const h of Object.values(n.lagHours ?? {})) {
      if (Number.isFinite(h) && h > 0) lagSpan += (h / WORK_DAY_HOURS * 7 / 5 + 8) * DAY_MS;
    }
  }
  // The runaway backstop: an acyclic cascade can never push a task further
  // than the schedule's span plus every task laid end to end, a day per link
  // and every lag — so a push past that is refused, never written.
  const bound = (Number.isFinite(lo) && Number.isFinite(hi) ? hi - lo : 0) + work + (edgeCount + 1) * DAY_MS + lagSpan;

  const subtreeOf = (rootId: string): string[] => {
    const out: string[] = [];
    const stack = [rootId];
    const seen = new Set<string>();
    while (stack.length) {
      const cur = stack.pop()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      out.push(cur);
      for (const k of childrenByParent.get(cur) ?? []) stack.push(k.id);
    }
    return out;
  };

  // Each node's ancestors, nearest first (the tree does not change here).
  const ancestorCache = new Map<string, string[]>();
  const ancestorsOf = (id: string): string[] => {
    const hit = ancestorCache.get(id);
    if (hit) return hit;
    const out: string[] = [];
    const seen = new Set<string>([id]);
    for (let c = byId.get(id)?.parentId ?? null; c && byId.has(c) && !seen.has(c); c = byId.get(c)!.parentId ?? null) {
      seen.add(c);
      out.push(c);
    }
    ancestorCache.set(id, out);
    return out;
  };
  const isWithin = (id: string, anc: string) => ancestorsOf(id).includes(anc);

  // A PHASE's finish-to-start links wait for all the work inside it: it is
  // read at the latest current finish in its subtree (its own stored finish
  // included). A locked phase — an actual, an imported or a pinned summary —
  // keeps its stored dates and is never re-enveloped or written (PT SCH-13),
  // so without this its links read the stored finish while a task inside it
  // moved past it, and its successors were neither pushed nor held (PC
  // SCHED-5, fourth review pass). Read by requirement() only, never written.
  const readyCache = new Map<string, number>(); // cleared on every shift
  const phaseFinish = (pred: string): number => {
    const f = finish.get(pred)!;
    if (!(childrenByParent.get(pred)?.length)) return f;
    const hit = readyCache.get(pred);
    if (hit !== undefined) return hit;
    let hi = f;
    for (const t of subtreeOf(pred)) { const ft = finish.get(t)!; if (ft > hi) hi = ft; }
    readyCache.set(pred, hi);
    return hi;
  };

  // The instant `s` may start: the latest of its predecessors' ready instants
  // plus each link's lag (working time, afterLagMs), and the predecessor that
  // sets it. A phase predecessor is read at phaseFinish — unless `s` sits
  // inside that phase (a link from a phase to its own task), when its stored
  // finish is used as before.
  const requirement = (s: ReflowNode): { req: number; from: string | null } => {
    let req = -Infinity;
    let from: string | null = null;
    for (const pred of s.dependsOn ?? []) {
      if (!finish.has(pred)) continue;
      const pf = isWithin(s.id, pred) ? finish.get(pred)! : phaseFinish(pred);
      const r = afterLagMs(fsReadyMs(pf), s.lagHours?.[pred]);
      if (r > req) { req = r; from = pred; }
    }
    return { req, from };
  };

  // The successors of the phases a node sits in: a move of the node can make
  // each of them start before its phase is done. A successor inside that
  // phase, or one that contains the node, is a link from a phase to its own
  // work and is left out.
  const viaPhases = (id: string): Array<{ sid: string; phase: string }> => {
    const out: Array<{ sid: string; phase: string }> = [];
    for (const a of ancestorsOf(id)) {
      for (const sid of successors.get(a) ?? []) if (!isWithin(sid, a) && !isWithin(id, sid)) out.push({ sid, phase: a });
    }
    return out;
  };

  // Who last moved each node: its predecessor (a link) or the ancestor it
  // was carried with (contains). A push whose own cause chain already
  // contains the task being pushed is a loop, however long.
  const cause = new Map<string, { from: string; via: "link" | "contains" }>();
  const causeChain = (fromId: string): Array<{ from: string; to: string; via: "link" | "contains" }> => {
    const chain: Array<{ from: string; to: string; via: "link" | "contains" }> = [];
    const seen = new Set<string>();
    let cur = fromId;
    while (!seen.has(cur)) {
      seen.add(cur);
      const c = cause.get(cur);
      if (!c) break;
      chain.unshift({ from: c.from, to: cur, via: c.via });
      cur = c.from;
    }
    return chain;
  };
  const moved = new Map<string, number>(); // cumulative displacement per node
  const held = new Map<string, { id: string; predecessorId: string }>();
  const shift = (t: string, delta: number, why: { from: string; via: "link" | "contains" }) => {
    readyCache.clear();
    start.set(t, start.get(t)! + delta);
    finish.set(t, finish.get(t)! + delta);
    const total = (moved.get(t) ?? 0) + delta;
    moved.set(t, total);
    cause.set(t, why);
    if (total > bound) throw new CascadeRefusedError("runaway", causeChain(t));
  };

  const seeds = [...new Set(changedIds)].filter((id) => byId.has(id));

  // The part of the network this move can reach: through a link to a
  // successor, from a task to the sub-tasks a push of it would carry, or
  // from a task to the successors of the phases it sits in.
  const outOf = (id: string): string[] => [
    ...(successors.get(id) ?? []),
    ...(childrenByParent.get(id) ?? []).map((k) => k.id),
    ...viaPhases(id).map((v) => v.sid),
  ];
  const affected = new Set<string>();
  {
    const stack = [...seeds];
    while (stack.length) {
      const cur = stack.pop()!;
      if (affected.has(cur)) continue;
      affected.add(cur);
      for (const o of outOf(cur)) stack.push(o);
    }
  }
  const indeg = new Map<string, number>();
  for (const id of affected) indeg.set(id, 0);
  for (const id of affected) for (const o of outOf(id)) if (affected.has(o)) indeg.set(o, indeg.get(o)! + 1);
  const order = [...affected].filter((id) => indeg.get(id) === 0);
  for (let i = 0; i < order.length; i++) {
    for (const o of outOf(order[i])) {
      if (!affected.has(o)) continue;
      const d = indeg.get(o)! - 1;
      indeg.set(o, d);
      if (d === 0) order.push(o);
    }
  }

  if (order.length === affected.size) {
    // No loop anywhere the move reaches (PT SCH-4): settle each task ONCE, in
    // topological order — every predecessor and the parent that carries it
    // are final before it is looked at. A FIFO relaxation re-pushed a task
    // each time a longer path reached it (a reversed fan-in of 40 tasks took
    // ~800 steps) and its step guard refused legitimate cascades.
    const movedSet = new Set<string>(); // the primary moves, then every task the cascade shifts
    const rolled = new Set<string>();   // phases with a moved task inside (see phaseFinish)
    const markMoved = (t: string) => { movedSet.add(t); for (const a of ancestorsOf(t)) rolled.add(a); };
    for (const sd of seeds) markMoved(sd);
    const carried = new Map<string, number>(); // shift inherited from pushed ancestors
    const own = new Map<string, number>();     // this task's own push
    for (const t of order) {
      const n = byId.get(t)!;
      const pid = n.parentId && byId.has(n.parentId) && affected.has(n.parentId) ? n.parentId : null;
      const c = pid ? (carried.get(pid) ?? 0) + (own.get(pid) ?? 0) : 0;
      carried.set(t, c);
      const triggered = (n.dependsOn ?? []).some((p) => movedSet.has(p) || (rolled.has(p) && !isWithin(t, p)));
      if (isLocked(n)) {
        // An actual (or an imported / pinned row) is never carried or pushed
        // — it stays where it is and a link it now breaks is reported.
        if (triggered) {
          const { req, from } = requirement(n);
          if (start.get(t)! < req) held.set(t, { id: t, predecessorId: from ?? t });
        }
        continue;
      }
      if (c !== 0) { shift(t, c, { from: pid!, via: "contains" }); markMoved(t); }
      if (!triggered) continue;
      const { req, from } = requirement(n);
      if (!(start.get(t)! < req)) continue;
      const delta = wholeDaysToClear(start.get(t)!, req);
      own.set(t, delta);
      shift(t, delta, { from: from!, via: "link" });
      markMoved(t);
    }
  } else {
    // A loop in the links (with a pushed task carrying its sub-tasks) is
    // somewhere the move reaches. Relax push by push and refuse the moment a
    // push goes round the loop (its cause chain holds the task being pushed);
    // a loop no push goes round is left alone. The displacement bound ends
    // any relaxation; the step count is the Bellman-Ford limit behind it.
    const queue = [...seeds];
    const queued = new Set(queue);
    const guard = nodes.length * (nodes.length + edgeCount) + 32;
    let steps = 0;
    while (queue.length) {
      if (steps++ > guard) throw new CascadeRefusedError("runaway", causeChain(queue[0]));
      const pid = queue.shift()!;
      queued.delete(pid);
      // Its own successors, and those of every phase it sits in (the link
      // from the phase is the one a held successor is reported against).
      const next = [...(successors.get(pid) ?? []).map((sid) => ({ sid, phase: pid })), ...viaPhases(pid)];
      for (const { sid, phase } of next) {
        const s = byId.get(sid);
        if (!s) continue;
        const { req } = requirement(s);
        if (!Number.isFinite(req)) continue;
        const curStart = start.get(sid)!;
        if (!(curStart < req)) continue;
        // A locked successor is an ACTUAL (or an imported row whose dates the
        // scheduling tool owns) — never push it out; report the broken link.
        if (isLocked(s)) { held.set(sid, { id: sid, predecessorId: phase }); continue; }
        if (pid === sid) throw new CascadeRefusedError("cycle", [{ from: sid, to: sid, via: "link" }]);
        const chain = causeChain(pid);
        const at = chain.findIndex((e) => e.from === sid);
        if (at >= 0) throw new CascadeRefusedError("cycle", [...chain.slice(at), { from: pid, to: sid, via: "link" }]);
        const delta = wholeDaysToClear(curStart, req);
        for (const t of subtreeOf(sid)) {
          // Actuals inside the pushed subtree stay where they happened (PC
          // SCHED-5) — the parent re-envelopes around them below.
          if (t !== sid && isLocked(byId.get(t))) continue;
          shift(t, delta, t === sid ? { from: pid, via: "link" } : { from: byId.get(t)?.parentId ?? sid, via: "contains" });
          // Its own dependents — and its sub-tasks' dependents — may need to move too.
          if (!queued.has(t)) { queued.add(t); queue.push(t); }
        }
      }
    }
  }

  // Re-envelope ancestors bottom-up (a locked parent keeps its dates).
  reenvelopeParents(byId, childrenByParent, start, finish);
  const changes = changesFrom(nodes, start, finish);
  // A held successor that a later push satisfied after all is not held.
  const heldOut = [...held.values()].filter((h) => start.get(h.id)! < requirement(byId.get(h.id)!).req);
  return { changes, held: heldOut };
}

/**
 * Lay a parent's DIRECT children end-to-end in schedule order
 * (finish-to-start): each child starts as soon as the previous one is done —
 * the next midnight after a date-only finish, the same instant after a timed
 * one (fsReadyMs) — moved by whole days so it keeps its own clock time and
 * duration (PC SCHED-13), carrying its subtree along except the actuals
 * inside it, which stay put (PC SCHED-5). This is the classic "these steps
 * are sequential — the next can't start until the prior finishes."
 * Ancestors re-envelope. Pure.
 */
export function sequenceSiblings(nodes: ReflowNode[], parentId: string): DateChange[] {
  const byId = new Map<string, ReflowNode>();
  const childrenByParent = new Map<string, ReflowNode[]>();
  for (const n of nodes) byId.set(n.id, n);
  for (const n of nodes) {
    const pid = n.parentId && byId.has(n.parentId) ? n.parentId : null;
    if (!pid) continue;
    const arr = childrenByParent.get(pid) ?? [];
    arr.push(n);
    childrenByParent.set(pid, arr);
  }
  const kids = (childrenByParent.get(parentId) ?? []).slice()
    .sort((a, b) => (startMsOf(a) - startMsOf(b)) || finishMsOf(a) - finishMsOf(b));
  if (kids.length < 2) return [];

  const start = new Map<string, number>();
  const finish = new Map<string, number>();
  for (const n of nodes) { start.set(n.id, startMsOf(n)); finish.set(n.id, finishMsOf(n)); }

  const subtreeOf = (rootId: string): string[] => {
    const out: string[] = [];
    const stack = [rootId];
    const seen = new Set<string>();
    while (stack.length) {
      const cur = stack.pop()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      out.push(cur);
      for (const k of childrenByParent.get(cur) ?? []) stack.push(k.id);
    }
    return out;
  };

  // The latest finish anywhere in a child's subtree (after any shift) — a
  // summary child whose actuals stayed behind still ends where its latest work ends.
  const subtreeFinish = (rootId: string): number => {
    let f = -Infinity;
    for (const sid of subtreeOf(rootId)) f = Math.max(f, finish.get(sid)!);
    return f;
  };
  let cursor: number | null = null; // the instant the previous child is done (fsReadyMs)
  for (const kid of kids) {
    // A locked (completed) child is an actual — leave it exactly where it is
    // and sequence the rest around it; the cursor still advances past it.
    if (isLocked(kid)) { cursor = Math.max(cursor ?? -Infinity, fsReadyMs(subtreeFinish(kid.id))); continue; }
    const curStart = start.get(kid.id)!;
    // Whole days either way (a layout: a child may be pulled in as well as
    // pushed out), so the child keeps its clock time.
    const delta = cursor === null ? 0 : Math.ceil((cursor - curStart) / DAY_MS) * DAY_MS;
    if (delta !== 0) {
      for (const sid of subtreeOf(kid.id)) {
        if (sid !== kid.id && isLocked(byId.get(sid))) continue; // actuals stay put (PC SCHED-5)
        start.set(sid, start.get(sid)! + delta);
        finish.set(sid, finish.get(sid)! + delta);
      }
    }
    cursor = fsReadyMs(subtreeFinish(kid.id));
  }

  // Re-envelope ancestors bottom-up from the updated leaves (a locked parent
  // keeps its dates — PT SCH-13).
  reenvelopeParents(byId, childrenByParent, start, finish);
  return changesFrom(nodes, start, finish);
}

/**
 * Resize a SUMMARY/parent task by dragging one of its edges — "extend the
 * overall project". A summary's span is derived from its children, so we
 * proportionally SCALE the whole subtree from the opposite (fixed) edge:
 *   edge="finish", +N → every descendant's offset+duration scales so the
 *                       phase ends N days later (anchored at its start).
 *   edge="start",  -N → it begins N days earlier (anchored at its finish).
 * Leaves never collapse below 1 day; every ancestor re-envelopes. Pure.
 */
export function computeSummaryResize(
  nodes: ReflowNode[],
  id: string,
  edge: "start" | "finish",
  deltaDays: number,
): DateChange[] {
  if (!Number.isFinite(deltaDays) || deltaDays === 0) return [];
  const byId = new Map<string, ReflowNode>();
  const childrenByParent = new Map<string, ReflowNode[]>();
  for (const n of nodes) byId.set(n.id, n);
  for (const n of nodes) {
    const pid = n.parentId && byId.has(n.parentId) ? n.parentId : null;
    if (!pid) continue;
    const arr = childrenByParent.get(pid) ?? [];
    arr.push(n);
    childrenByParent.set(pid, arr);
  }
  if (!byId.has(id)) return [];

  // Gather the subtree's leaves (the only nodes with real, settable dates).
  const leaves: ReflowNode[] = [];
  const stack = [id];
  const seen = new Set<string>();
  while (stack.length) {
    const cur = stack.pop()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const kids = childrenByParent.get(cur) ?? [];
    if (kids.length === 0) { if (cur !== id) leaves.push(byId.get(cur)!); }
    else for (const k of kids) stack.push(k.id);
  }
  if (leaves.length === 0) return [];

  let lo = Infinity, hi = -Infinity;
  for (const l of leaves) { lo = Math.min(lo, startMsOf(l)); hi = Math.max(hi, finishMsOf(l)); }
  const oldSpan = hi - lo;
  if (oldSpan <= 0) return [];
  const deltaMs = deltaDays * DAY_MS;
  const newSpan = edge === "finish" ? oldSpan + deltaMs : oldSpan - deltaMs;
  if (newSpan < DAY_MS) return []; // never collapse the whole phase below a day
  const k = newSpan / oldSpan;
  const anchor = edge === "finish" ? lo : hi;

  const start = new Map<string, number>();
  const finish = new Map<string, number>();
  for (const n of nodes) { start.set(n.id, startMsOf(n)); finish.set(n.id, finishMsOf(n)); }

  // Round each leaf's MOVE to whole days — never its absolute instant to UTC
  // midnight, which dragged every 17:00 finish onto the next day and moved a
  // "+1 day" phase's tasks by two (PT SCH-11). Each leaf keeps its clock time.
  const snapMove = (orig: number, scaled: number) => orig + Math.round((scaled - orig) / DAY_MS) * DAY_MS;
  for (const l of leaves) {
    if (isLocked(l)) continue; // a completed leaf is an actual — never rescale it
    const s0 = startMsOf(l), f0 = finishMsOf(l);
    let s: number, f: number;
    if (edge === "finish") {
      s = anchor + (s0 - anchor) * k;
      f = anchor + (f0 - anchor) * k;
    } else {
      s = anchor - (anchor - s0) * k;
      f = anchor - (anchor - f0) * k;
    }
    s = snapMove(s0, s); f = snapMove(f0, f);
    if (f < s) f = s + (f0 - s0); // rounding crossed the pair: keep the leaf's own span
    start.set(l.id, s);
    finish.set(l.id, f);
  }

  // Re-envelope parents bottom-up (deepest first) from the updated leaves (a
  // locked parent keeps its dates — PT SCH-13).
  reenvelopeParents(byId, childrenByParent, start, finish);
  return changesFrom(nodes, start, finish);
}

/**
 * Preview a move WITHOUT a status hint: caller supplies the mode. This
 * is what the UI calls so it can show the impact ("+1 day of work, now
 * 4 days" vs "just shifting the date") before the user commits.
 */
export function previewMove(
  nodes: ReflowNode[],
  id: string,
  deltaDays: number,
  mode: MoveMode,
): MoveImpact {
  const node = nodes.find((n) => n.id === id);
  const before = node ? spanDays(node) : 1;
  const changes = computeTreeMove(nodes, id, deltaDays, mode);
  const after = mode === "extend" ? Math.max(1, before + deltaDays) : before;
  return {
    changes,
    mode,
    deltaDays,
    addsDuration: mode === "extend" && deltaDays !== 0,
    durationDaysBefore: before,
    durationDaysAfter: after,
  };
}

/**
 * Resize one EDGE of a node by dragging it, changing its duration:
 *   edge="start"  → move the start by deltaDays (finish stays).
 *   edge="finish" → move the finish by deltaDays (start stays).
 * The node's span is clamped to at least 1 day. Ancestors reflow to
 * envelope the new span. (Resizing a parent isn't offered — parents
 * derive their span from children.) Returns the date changes.
 */
export function computeEdgeResize(
  nodes: ReflowNode[],
  id: string,
  edge: "start" | "finish",
  deltaDays: number,
): DateChange[] {
  if (!Number.isFinite(deltaDays) || deltaDays === 0) return [];
  const byId = new Map<string, ReflowNode>();
  const childrenByParent = new Map<string, ReflowNode[]>();
  for (const n of nodes) byId.set(n.id, n);
  for (const n of nodes) {
    const pid = n.parentId && byId.has(n.parentId) ? n.parentId : null;
    if (!pid) continue;
    const arr = childrenByParent.get(pid) ?? [];
    arr.push(n);
    childrenByParent.set(pid, arr);
  }
  const node = byId.get(id);
  if (!node) return [];
  if (isLocked(node)) return []; // can't resize an actual

  const start = new Map<string, number>();
  const finish = new Map<string, number>();
  for (const n of nodes) { start.set(n.id, startMsOf(n)); finish.set(n.id, finishMsOf(n)); }

  const delta = deltaDays * DAY_MS;
  let s = start.get(id)!, f = finish.get(id)!;
  if (edge === "start") s = Math.min(s + delta, f);       // can't cross finish
  else f = Math.max(f + delta, s);                        // can't cross start
  // Guarantee a >= 1-day span.
  if (f - s < 0) { if (edge === "start") s = f; else f = s; }
  start.set(id, s);
  finish.set(id, f);

  // Reflow ancestors to envelope updated children — a locked ancestor (an
  // imported summary, an actual) keeps its stored dates (PT SCH-13).
  let cur = node.parentId ?? null;
  const guard = new Set<string>();
  while (cur && byId.has(cur) && !guard.has(cur)) {
    guard.add(cur);
    const kids = childrenByParent.get(cur) ?? [];
    if (kids.length > 0 && !isLocked(byId.get(cur))) {
      let lo = Infinity, hi = -Infinity;
      for (const k of kids) { lo = Math.min(lo, start.get(k.id)!); hi = Math.max(hi, finish.get(k.id)!); }
      if (Number.isFinite(lo) && Number.isFinite(hi)) { start.set(cur, lo); finish.set(cur, hi); }
    }
    cur = byId.get(cur)!.parentId ?? null;
  }

  return changesFrom(nodes, start, finish);
}

/** The finish-to-start lag (hours; negative = lead) the source schedule
 *  recorded for the link from the predecessor whose external ref is
 *  `predExternalRef`, read from the task's `attributes.source_links` — the
 *  importer writes `FS <ref> +8h` there for every FS link that carries lag
 *  (PT SCH-8, lib/scheduleParsers.ts). 0 when the link carries none, or when
 *  its lag was not understood (`… (lag not understood)`). */
export function fsLagHours(sourceLinks: unknown, predExternalRef: string | null | undefined): number {
  if (typeof sourceLinks !== "string" || !predExternalRef) return 0;
  for (const part of sourceLinks.split(";")) {
    const m = /^\s*FS\s+(\S+)\s+([+-]\d+(?:\.\d+)?)h\s*$/.exec(part);
    if (m && m[1] === predExternalRef) {
      const h = Number(m[2]);
      return Number.isFinite(h) ? h : 0;
    }
  }
  return 0;
}

/** The engine's view of a milestone list — ONE mapping for every caller (the
 *  board, the dependency picker, the duration editor), so they reason over
 *  the same nodes:
 *    * `actualAt` locks a row with an actual finish (PC SCHED-5);
 *    * an imported row is `locked` — its dates come from the scheduling tool
 *      and the next import writes them back, so no engine moves it (PT SCH-13);
 *    * `lagHours` carries each FS link's lag from `attributes.source_links`,
 *      matched through the predecessor's external ref (PT SCH-8).
 *  Pass the FULL list — never a display-filtered view (PT SCH-9). */
export function reflowNodesFromMilestones(milestones: Milestone[]): ReflowNode[] {
  const refById = new Map<string, string>();
  for (const m of milestones) if (m.id && m.externalRef) refById.set(m.id, m.externalRef);
  return milestones.filter((m) => !!m.id).map((m) => {
    const links = (m.attributes as Record<string, unknown> | null | undefined)?.source_links;
    let lagHours: Record<string, number> | null = null;
    if (typeof links === "string") {
      for (const pred of m.dependsOn ?? []) {
        const h = fsLagHours(links, refById.get(pred));
        if (h !== 0) (lagHours ??= {})[pred] = h;
      }
    }
    return {
      id: m.id!,
      parentId: m.parentId ?? null,
      plannedStartAt: (m.plannedStartAt as string | undefined) ?? null,
      plannedAt: m.plannedAt as string,
      status: m.status,
      dependsOn: m.dependsOn ?? null,
      actualAt: (m.actualAt as string | null | undefined) ?? null,
      locked: isImportedMilestone(m),
      lagHours,
    };
  });
}
