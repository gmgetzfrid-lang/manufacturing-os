import { addDays, dayDiff, DEFAULT_SCHEDULE_TZ, hasTimeOfDay, startOfDay } from "@/lib/scheduleTz";
import { earliestStart, linkOf, type LinkMap } from "@/lib/scheduleLinks";
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
  /** Predecessor task ids: this task waits on each of these. Optional. */
  dependsOn?: string[] | null;
  /** How it waits on each (start-to-start, lag…); missing = finish-to-start. */
  links?: LinkMap | null;
  /** Explicitly pin this node's dates (an ACTUAL). When omitted, a
   *  `status === "completed"` node is treated as locked. Locked tasks are
   *  never moved by reflow / cascade / sequencing — exactly like MS Project
   *  and Primavera, where actuals don't reschedule themselves. */
  locked?: boolean;
}

/** Completed work (or an explicitly pinned node) is an ACTUAL: the reschedule
 *  engine never moves it. This is what lets you push the remaining work around
 *  without disturbing the tasks already in the ground. */
export function isLocked(n: ReflowNode | undefined): boolean {
  if (!n) return false;
  return n.locked === true || n.status === "completed";
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

const DAY_MS = 86_400_000;
const QUARTER_HOUR_MS = 15 * 60_000;

// Day arithmetic runs in the PLANT's zone (the project timezone) so a
// move of "+1 day" keeps a task's clock time across a daylight-saving
// change, and day snapping lands on plant midnight, not UTC midnight.

function startMsOf(n: ReflowNode): number {
  const s = n.plannedStartAt ?? n.plannedAt;
  return Date.parse(s);
}
function finishMsOf(n: ReflowNode): number {
  return Date.parse(n.plannedAt);
}

/** No clock time on either end: the task is date-only and covers its days
 *  inclusively (finish = plant midnight of its LAST day). Same test as the
 *  timeline's barGeometry and the shift report's workSpan. */
function isDateOnly(s: number, f: number, tz: string): boolean {
  return !hasTimeOfDay(s, tz) && !hasTimeOfDay(f, tz);
}

/** When a task's work is really over, i.e. the earliest a successor may
 *  start: the finish instant for timed work, the next plant midnight for a
 *  date-only task (its last day is a whole working day). */
function workEnd(s: number, f: number, tz: string): number {
  return isDateOnly(s, f, tz) ? addDays(Math.max(s, f), 1, tz) : f;
}

/** Fewest whole plant days (may be negative) that move `ms` to at or after
 *  `req`. Moving by days keeps the task's own clock time. */
function daysToReach(ms: number, req: number, tz: string): number {
  let n = dayDiff(ms, req, tz);
  while (addDays(ms, n, tz) < req) n++;
  while (addDays(ms, n - 1, tz) >= req) n--;
  return n;
}

/** Move a node and its subtree so it starts at or after `req`. A date-only
 *  task, or one waiting on a date-only predecessor (`byDay`), moves by whole
 *  plant days so it keeps its clock time / stays date-only; timed work after
 *  timed work starts exactly at `req`, back-to-back. Locked rows stay put. */
function moveSubtreeTo(
  ids: string[], rootId: string, req: number, byDay: boolean,
  start: Map<string, number>, finish: Map<string, number>,
  byId: Map<string, ReflowNode>, tz: string,
): void {
  const s0 = start.get(rootId)!, f0 = finish.get(rootId)!;
  let shift: (ms: number) => number;
  if (byDay || isDateOnly(s0, f0, tz)) {
    const n = daysToReach(s0, req, tz);
    if (n === 0) return;
    shift = (ms) => addDays(ms, n, tz);
  } else {
    const delta = req - s0;
    if (delta === 0) return;
    shift = (ms) => ms + delta;
  }
  for (const t of ids) {
    if (t !== rootId && isLocked(byId.get(t))) continue; // actuals inside never move
    start.set(t, shift(start.get(t)!));
    finish.set(t, shift(finish.get(t)!));
  }
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
  tz: string = DEFAULT_SCHEDULE_TZ,
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

  const shift = (ms: number) => addDays(ms, deltaDays, tz);

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
      finish.set(sid, shift(finish.get(sid)!));
    } else {
      start.set(sid, shift(start.get(sid)!));
      finish.set(sid, shift(finish.get(sid)!));
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
function spanDays(n: ReflowNode, tz: string = DEFAULT_SCHEDULE_TZ): number {
  const d = dayDiff(startMsOf(n), finishMsOf(n), tz) + 1;
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

/**
 * Forward finish-to-start cascade. After the tasks in `changedIds` moved,
 * push any dependent task that now starts before its latest predecessor's
 * work ends: the finish instant of timed work, or the next plant day after a
 * date-only predecessor (see workEnd). Only ever pushes
 * FORWARD (never pulls a task earlier), carries each pushed task's subtree,
 * re-envelopes ancestors, and is cycle-safe (bounded). Pure.
 */
/** The task rows above changed steps, refitted to wrap their steps — and
 *  nothing else: the steps linked after a changed step keep their planned
 *  dates (the forecast, not the plan, carries what a change pushes). Returns
 *  the changes given plus each ancestor whose span differs. */
export function withAncestors(nodes: ReflowNode[], primary: DateChange[]): DateChange[] {
  if (!primary.length) return primary;
  const given = new Map(primary.map((c) => [c.id, c]));
  const byId = new Map(nodes.map((n) => [n.id, given.has(n.id) ? { ...n, plannedStartAt: given.get(n.id)!.plannedStartAt, plannedAt: given.get(n.id)!.plannedAt } : n]));
  const kids = new Map<string, ReflowNode[]>();
  for (const n of byId.values()) if (n.parentId && byId.has(n.parentId)) kids.set(n.parentId, [...(kids.get(n.parentId) ?? []), n]);
  const out = new Map(given);
  // Each changed step's parents, nearest first; a parent refits from all its children as they now stand.
  const seen = new Set<string>();
  const order: string[] = [];
  for (const c of primary) {
    for (let p = byId.get(c.id)?.parentId ?? null; p && byId.has(p) && !seen.has(p); p = byId.get(p)!.parentId ?? null) { seen.add(p); order.push(p); }
  }
  const depth = (id: string) => { let d = 0; for (let p = byId.get(id)?.parentId ?? null; p && byId.has(p); p = byId.get(p)!.parentId ?? null) d++; return d; };
  for (const pid of order.sort((a, b) => depth(b) - depth(a))) {
    const ks = kids.get(pid) ?? [];
    let lo = Infinity, hi = -Infinity;
    for (const k of ks) { const s = startMsOf(k), f = finishMsOf(k); if (Number.isFinite(s)) lo = Math.min(lo, s); if (Number.isFinite(f)) hi = Math.max(hi, f); }
    const p = byId.get(pid)!;
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || (lo === startMsOf(p) && hi === finishMsOf(p))) continue;
    const c = { id: pid, plannedStartAt: new Date(lo).toISOString(), plannedAt: new Date(hi).toISOString() };
    out.set(pid, c);
    byId.set(pid, { ...p, plannedStartAt: c.plannedStartAt, plannedAt: c.plannedAt });
  }
  return [...out.values()];
}

export function cascadeDependents(nodes: ReflowNode[], changedIds: string[], tz: string = DEFAULT_SCHEDULE_TZ): DateChange[] {
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
  for (const n of nodes) {
    for (const pred of n.dependsOn ?? []) {
      if (!byId.has(pred)) continue;
      const arr = successors.get(pred) ?? [];
      arr.push(n.id);
      successors.set(pred, arr);
    }
  }
  if (successors.size === 0) return [];

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

  const queue = [...changedIds];
  const guard = nodes.length * 4 + 32;
  let steps = 0;
  while (queue.length && steps++ < guard) {
    const pid = queue.shift()!;
    for (const sid of successors.get(pid) ?? []) {
      const s = byId.get(sid);
      if (!s) continue;
      // A completed successor is an ACTUAL — it already happened, so never push
      // it out just because a predecessor moved. This is the "if the earlier
      // tasks are done, only the remaining ones reschedule" rule.
      if (isLocked(s)) continue;
      let req = -Infinity, byDay = false;
      const ss = start.get(sid)!, sf = finish.get(sid)!;
      const succLen = workEnd(ss, sf, tz) - ss;
      for (const pred of s.dependsOn ?? []) {
        if (!finish.has(pred)) continue;
        const ps = start.get(pred)!, pf = finish.get(pred)!;
        // Each link type (finish-to-start, start-to-start, …, with its lag)
        // gives the earliest this task may start.
        const link = linkOf(s.links, pred);
        const at = earliestStart(link, { start: ps, end: workEnd(ps, pf, tz) }, succLen);
        // Whole days when either end is date-only and there's no hourly lag.
        const dayish = (isDateOnly(ps, pf, tz) || isDateOnly(ss, sf, tz)) && link.lagHours % 24 === 0;
        if (at > req) { req = at; byDay = dayish; }
        else if (at === req && dayish) byDay = true;
      }
      if (!Number.isFinite(req)) continue;
      if (start.get(sid)! < req) {
        moveSubtreeTo(subtreeOf(sid), sid, req, byDay, start, finish, byId, tz);
        queue.push(sid); // its own dependents may need to move too
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
    let lo = Infinity, hi = -Infinity;
    for (const kdn of kids) { lo = Math.min(lo, start.get(kdn.id)!); hi = Math.max(hi, finish.get(kdn.id)!); }
    if (Number.isFinite(lo) && Number.isFinite(hi)) { start.set(ppid, lo); finish.set(ppid, hi); }
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
 * Lay a parent's DIRECT children end-to-end in schedule order
 * (finish-to-start): timed steps run back-to-back (08–10, 10–12, …), a
 * date-only step starts the plant day after the previous one's last day,
 * preserving each child's own duration and carrying its whole
 * subtree along. This is the classic "these steps are sequential — the next
 * can't start until the prior finishes." Ancestors re-envelope. Pure.
 */
export function sequenceSiblings(nodes: ReflowNode[], parentId: string, tz: string = DEFAULT_SCHEDULE_TZ): DateChange[] {
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

  // When the previous child's work ends (workEnd), and whether that end is a
  // day boundary from a date-only step (then the next one moves by whole days).
  let cursor: number | null = null;
  let cursorByDay = false;
  for (const kid of kids) {
    const ks = start.get(kid.id)!, kf = finish.get(kid.id)!;
    // A locked (completed) child is an actual — leave it exactly where it is
    // and sequence the rest around it; the cursor still advances past it.
    if (isLocked(kid)) {
      const end = workEnd(ks, kf, tz);
      if (cursor === null || end > cursor) { cursor = end; cursorByDay = isDateOnly(ks, kf, tz); }
      continue;
    }
    if (cursor !== null) moveSubtreeTo(subtreeOf(kid.id), kid.id, cursor, cursorByDay, start, finish, byId, tz);
    const ns = start.get(kid.id)!, nf = finish.get(kid.id)!;
    cursor = workEnd(ns, nf, tz);
    cursorByDay = isDateOnly(ns, nf, tz);
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
 * Date-only leaves snap to whole days and never collapse below 1 day; timed
 * leaves keep their clock times (to the quarter hour) and never become
 * zero-length or inverted. Every ancestor re-envelopes. Pure.
 */
export function computeSummaryResize(
  nodes: ReflowNode[],
  id: string,
  edge: "start" | "finish",
  deltaDays: number,
  tz: string = DEFAULT_SCHEDULE_TZ,
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

  // Date-only steps snap to the nearest plant midnight (half a day forward,
  // then floor). Timed steps keep their clock: round to the quarter hour, so
  // a 08:00–10:00 job doesn't turn into a zero-length midnight blip.
  const snap = (ms: number) => startOfDay(ms + DAY_MS / 2, tz);
  const quarter = (ms: number) => Math.round(ms / QUARTER_HOUR_MS) * QUARTER_HOUR_MS;
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
    if (isDateOnly(s0, f0, tz)) {
      s = snap(s); f = snap(f);
      if (f < s) f = s; // keep at least a same-day (1-day) span
    } else {
      s = quarter(s); f = quarter(f);
      // Never zero-length or inverted: at least 15 min (or its own length
      // if it was shorter than that to begin with).
      const minLen = Math.max(0, Math.min(f0 - s0, QUARTER_HOUR_MS));
      if (f - s < minLen) f = s + minLen;
      // Both ends landing on midnight would read as a date-only task covering
      // whole days; pull the finish back a quarter so it stays timed.
      if (isDateOnly(s, f, tz) && f - s > QUARTER_HOUR_MS) f -= QUARTER_HOUR_MS;
      else if (isDateOnly(s, f, tz)) f = s + QUARTER_HOUR_MS;
    }
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
  tz: string = DEFAULT_SCHEDULE_TZ,
): MoveImpact {
  const node = nodes.find((n) => n.id === id);
  const before = node ? spanDays(node, tz) : 1;
  const changes = computeTreeMove(nodes, id, deltaDays, mode, tz);
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
  tz: string = DEFAULT_SCHEDULE_TZ,
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

  let s = start.get(id)!, f = finish.get(id)!;
  if (edge === "start") s = Math.min(addDays(s, deltaDays, tz), f);  // can't cross finish
  else f = Math.max(addDays(f, deltaDays, tz), s);                   // can't cross start
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
