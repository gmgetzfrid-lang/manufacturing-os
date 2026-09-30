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
  /** Finish-to-start lag per predecessor id, in hours (negative = lead), as
   *  the source schedule recorded it (attributes.source_links, PT SCH-8).
   *  A predecessor with no entry has zero lag. */
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

/** A wall-clock date (YYYY-MM-DD) + time (HH:MM, default 00:00) as the stored
 *  instant — built as a UTC string, never parsed in the viewer's zone. Null
 *  when the date is not a real date. */
export function fromWallClock(date: string, time?: string | null): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const hm = time && /^\d{2}:\d{2}$/.test(time) ? time : "00:00";
  const t = Date.parse(`${date}T${hm}:00.000Z`);
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
  //    when some of their children were locked.
  const depthOf = (nid: string): number => {
    let d = 0, c = byId.get(nid)?.parentId ?? null;
    const g = new Set<string>();
    while (c && byId.has(c) && !g.has(c)) { g.add(c); d++; c = byId.get(c)!.parentId ?? null; }
    return d;
  };
  for (const pid of [...childrenByParent.keys()].sort((a, b) => depthOf(b) - depthOf(a))) {
    const kids = childrenByParent.get(pid) ?? [];
    if (kids.length === 0) continue;
    let lo = Infinity, hi = -Infinity;
    for (const k of kids) {
      lo = Math.min(lo, start.get(k.id)!);
      hi = Math.max(hi, finish.get(k.id)!);
    }
    if (Number.isFinite(lo) && Number.isFinite(hi)) {
      start.set(pid, lo);
      finish.set(pid, hi);
    }
  }

  // 3) Emit a change for every node whose start or finish actually moved.
  const changes: DateChange[] = [];
  for (const n of nodes) {
    const s0 = startMsOf(n), f0 = finishMsOf(n);
    const s1 = start.get(n.id)!, f1 = finish.get(n.id)!;
    if (s1 !== s0 || f1 !== f0) {
      changes.push({
        id: n.id,
        plannedStartAt: new Date(s1).toISOString(),
        plannedAt: new Date(f1).toISOString(),
      });
    }
  }
  return changes;
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

  // Depth from root → envelope bottom-up (a parent waits for descendants).
  const depthOf = (id: string): number => {
    let d = 0, c = byId.get(id)?.parentId ?? null;
    const seen = new Set<string>();
    while (c && byId.has(c) && !seen.has(c)) { seen.add(c); d++; c = byId.get(c)!.parentId ?? null; }
    return d;
  };
  const parents = [...childrenByParent.keys()].sort((a, b) => depthOf(b) - depthOf(a));
  for (const pid of parents) {
    const kids = childrenByParent.get(pid)!;
    let lo = Infinity, hi = -Infinity;
    for (const k of kids) { lo = Math.min(lo, start.get(k.id)!); hi = Math.max(hi, finish.get(k.id)!); }
    if (Number.isFinite(lo) && Number.isFinite(hi)) { start.set(pid, lo); finish.set(pid, hi); }
  }

  const changes: DateChange[] = [];
  for (const n of nodes) {
    const s0 = startMsOf(n), f0 = finishMsOf(n);
    const s1 = start.get(n.id)!, f1 = finish.get(n.id)!;
    if (s1 !== s0 || f1 !== f0) {
      changes.push({ id: n.id, plannedStartAt: new Date(s1).toISOString(), plannedAt: new Date(f1).toISOString() });
    }
  }
  return changes;
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
 *  absorbed (PT SCH-4). `runaway`: a task would move further than the whole
 *  project spans — a backstop that never lets a cascade write dates years
 *  out (further than every task laid end to end could push it). `edges` name
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
 * schedule's own (ReflowNode.lagHours, default 0). A pushed task moves by
 * whole days, so it keeps its clock time (PC SCHED-13). Only ever pushes
 * FORWARD (never pulls a task earlier), carries each pushed task's subtree —
 * except the actuals inside it, which stay put (PC SCHED-5, matching
 * computeTreeMove) — and re-envelopes ancestors. A loop in the links is
 * REFUSED with its edges named (CascadeRefusedError), and so is a push
 * further than the whole schedule spans (PT SCH-4). Pure.
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
  let lo = Infinity, hi = -Infinity, work = 0, lagSum = 0;
  for (const n of nodes) {
    const s0 = startMsOf(n), f0 = finishMsOf(n);
    start.set(n.id, s0); finish.set(n.id, f0);
    if (Number.isFinite(s0)) lo = Math.min(lo, s0);
    if (Number.isFinite(f0)) hi = Math.max(hi, f0);
    if (Number.isFinite(s0) && Number.isFinite(f0)) work += Math.max(0, f0 - s0) + DAY_MS;
    for (const h of Object.values(n.lagHours ?? {})) if (Number.isFinite(h) && h > 0) lagSum += h * HOUR_MS;
  }
  // The runaway backstop: an acyclic cascade can never push a task further
  // than the schedule's span plus every task laid end to end, a day per link
  // and every lag — so a push past that is refused, never written.
  const bound = (Number.isFinite(lo) && Number.isFinite(hi) ? hi - lo : 0) + work + (edgeCount + 1) * DAY_MS + lagSum;

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

  const queue = [...new Set(changedIds)];
  const queued = new Set(queue);
  const guard = (nodes.length + edgeCount) * 4 + 32;
  let steps = 0;
  while (queue.length) {
    if (steps++ > guard) throw new CascadeRefusedError("runaway", causeChain(queue[0]));
    const pid = queue.shift()!;
    queued.delete(pid);
    for (const sid of successors.get(pid) ?? []) {
      const s = byId.get(sid);
      if (!s) continue;
      let req = -Infinity;
      for (const pred of s.dependsOn ?? []) {
        if (!finish.has(pred)) continue;
        const lag = s.lagHours?.[pred];
        req = Math.max(req, fsReadyMs(finish.get(pred)!) + (typeof lag === "number" && Number.isFinite(lag) ? lag * HOUR_MS : 0));
      }
      if (!Number.isFinite(req)) continue;
      const curStart = start.get(sid)!;
      if (!(curStart < req)) continue;
      // A locked successor is an ACTUAL (or an imported row whose dates the
      // scheduling tool owns) — never push it out; report the broken link.
      if (isLocked(s)) { held.set(sid, { id: sid, predecessorId: pid }); continue; }
      if (pid === sid) throw new CascadeRefusedError("cycle", [{ from: sid, to: sid, via: "link" }]);
      const chain = causeChain(pid);
      const at = chain.findIndex((e) => e.from === sid);
      if (at >= 0) throw new CascadeRefusedError("cycle", [...chain.slice(at), { from: pid, to: sid, via: "link" }]);
      const delta = wholeDaysToClear(curStart, req);
      for (const t of subtreeOf(sid)) {
        // Actuals inside the pushed subtree stay where they happened (PC
        // SCHED-5) — the parent re-envelopes around them below.
        if (t !== sid && isLocked(byId.get(t))) continue;
        start.set(t, start.get(t)! + delta);
        finish.set(t, finish.get(t)! + delta);
        const total = (moved.get(t) ?? 0) + delta;
        moved.set(t, total);
        cause.set(t, t === sid ? { from: pid, via: "link" } : { from: byId.get(t)?.parentId ?? sid, via: "contains" });
        if (total > bound) throw new CascadeRefusedError("runaway", causeChain(t));
        // Its own dependents — and its sub-tasks' dependents — may need to move too.
        if (!queued.has(t)) { queued.add(t); queue.push(t); }
      }
    }
  }

  // Re-envelope ancestors bottom-up.
  const depthOf = (nid: string): number => {
    let d = 0, c = byId.get(nid)?.parentId ?? null;
    const g = new Set<string>();
    while (c && byId.has(c) && !g.has(c)) { g.add(c); d++; c = byId.get(c)!.parentId ?? null; }
    return d;
  };
  for (const ppid of [...childrenByParent.keys()].sort((a, b) => depthOf(b) - depthOf(a))) {
    const kids = childrenByParent.get(ppid)!;
    let klo = Infinity, khi = -Infinity;
    for (const kdn of kids) { klo = Math.min(klo, start.get(kdn.id)!); khi = Math.max(khi, finish.get(kdn.id)!); }
    if (Number.isFinite(klo) && Number.isFinite(khi)) { start.set(ppid, klo); finish.set(ppid, khi); }
  }

  const changes: DateChange[] = [];
  for (const n of nodes) {
    const s0 = startMsOf(n), f0 = finishMsOf(n);
    const s1 = start.get(n.id)!, f1 = finish.get(n.id)!;
    if (s1 !== s0 || f1 !== f0) {
      changes.push({ id: n.id, plannedStartAt: new Date(s1).toISOString(), plannedAt: new Date(f1).toISOString() });
    }
  }
  // A held successor that a later push satisfied after all is not held.
  const heldOut = [...held.values()].filter((h) => {
    const s = byId.get(h.id)!;
    let req = -Infinity;
    for (const pred of s.dependsOn ?? []) {
      if (!finish.has(pred)) continue;
      const lag = s.lagHours?.[pred];
      req = Math.max(req, fsReadyMs(finish.get(pred)!) + (typeof lag === "number" && Number.isFinite(lag) ? lag * HOUR_MS : 0));
    }
    return start.get(h.id)! < req;
  });
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

  // Re-envelope ancestors bottom-up from the updated leaves.
  const depthOf = (nid: string): number => {
    let d = 0, c = byId.get(nid)?.parentId ?? null;
    const g = new Set<string>();
    while (c && byId.has(c) && !g.has(c)) { g.add(c); d++; c = byId.get(c)!.parentId ?? null; }
    return d;
  };
  const parents = [...childrenByParent.keys()].sort((a, b) => depthOf(b) - depthOf(a));
  for (const pid of parents) {
    const ch = childrenByParent.get(pid)!;
    let lo = Infinity, hi = -Infinity;
    for (const c of ch) { lo = Math.min(lo, start.get(c.id)!); hi = Math.max(hi, finish.get(c.id)!); }
    if (Number.isFinite(lo) && Number.isFinite(hi)) { start.set(pid, lo); finish.set(pid, hi); }
  }

  const changes: DateChange[] = [];
  for (const n of nodes) {
    const s0 = startMsOf(n), f0 = finishMsOf(n);
    const s1 = start.get(n.id)!, f1 = finish.get(n.id)!;
    if (s1 !== s0 || f1 !== f0) {
      changes.push({ id: n.id, plannedStartAt: new Date(s1).toISOString(), plannedAt: new Date(f1).toISOString() });
    }
  }
  return changes;
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

  // Re-envelope parents bottom-up (deepest first) from the updated leaves.
  const depthOf = (nid: string): number => {
    let d = 0, c = byId.get(nid)?.parentId ?? null;
    const g = new Set<string>();
    while (c && byId.has(c) && !g.has(c)) { g.add(c); d++; c = byId.get(c)!.parentId ?? null; }
    return d;
  };
  const parents = [...childrenByParent.keys()].sort((a, b) => depthOf(b) - depthOf(a));
  for (const pid of parents) {
    const kids = childrenByParent.get(pid)!;
    let plo = Infinity, phi = -Infinity;
    for (const kdn of kids) { plo = Math.min(plo, start.get(kdn.id)!); phi = Math.max(phi, finish.get(kdn.id)!); }
    if (Number.isFinite(plo) && Number.isFinite(phi)) { start.set(pid, plo); finish.set(pid, phi); }
  }

  const changes: DateChange[] = [];
  for (const n of nodes) {
    const s0 = startMsOf(n), f0 = finishMsOf(n);
    const s1 = start.get(n.id)!, f1 = finish.get(n.id)!;
    if (s1 !== s0 || f1 !== f0) {
      changes.push({ id: n.id, plannedStartAt: new Date(s1).toISOString(), plannedAt: new Date(f1).toISOString() });
    }
  }
  return changes;
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

  // Reflow ancestors to envelope updated children.
  let cur = node.parentId ?? null;
  const guard = new Set<string>();
  while (cur && byId.has(cur) && !guard.has(cur)) {
    guard.add(cur);
    const kids = childrenByParent.get(cur) ?? [];
    if (kids.length > 0) {
      let lo = Infinity, hi = -Infinity;
      for (const k of kids) { lo = Math.min(lo, start.get(k.id)!); hi = Math.max(hi, finish.get(k.id)!); }
      if (Number.isFinite(lo) && Number.isFinite(hi)) { start.set(cur, lo); finish.set(cur, hi); }
    }
    cur = byId.get(cur)!.parentId ?? null;
  }

  const changes: DateChange[] = [];
  for (const n of nodes) {
    const s0 = startMsOf(n), f0 = finishMsOf(n);
    const s1 = start.get(n.id)!, f1 = finish.get(n.id)!;
    if (s1 !== s0 || f1 !== f0) {
      changes.push({ id: n.id, plannedStartAt: new Date(s1).toISOString(), plannedAt: new Date(f1).toISOString() });
    }
  }
  return changes;
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
