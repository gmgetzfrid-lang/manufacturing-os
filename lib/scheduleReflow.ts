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

  const delta = deltaDays * DAY_MS;

  // Working copies of every node's start/finish in ms. We mutate these
  // as we shift the subtree and reflow ancestors, then diff at the end.
  const start = new Map<string, number>();
  const finish = new Map<string, number>();
  for (const n of nodes) {
    start.set(n.id, startMsOf(n));
    finish.set(n.id, finishMsOf(n));
  }

  // 1) Move the dragged node and its descendants.
  //    defer  → both start and finish shift by delta (slides in time).
  //    extend → the dragged node's FINISH moves but its START stays
  //             (it's taking longer). Descendants still slide so the
  //             work inside is pushed out with the new finish.
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
    if (mode === "extend" && sid === id) {
      // Keep start; push finish only → duration grows by delta.
      finish.set(sid, finish.get(sid)! + delta);
    } else {
      start.set(sid, start.get(sid)! + delta);
      finish.set(sid, finish.get(sid)! + delta);
    }
  }

  // 2) Reflow every ancestor of the dragged node, nearest first up to
  //    the root, so each summary exactly envelopes its direct children
  //    (using already-updated child values).
  let cur = byId.get(id)!.parentId ?? null;
  const guard = new Set<string>();
  while (cur && byId.has(cur) && !guard.has(cur)) {
    guard.add(cur);
    const kids = childrenByParent.get(cur) ?? [];
    if (kids.length > 0) {
      let lo = Infinity, hi = -Infinity;
      for (const k of kids) {
        lo = Math.min(lo, start.get(k.id)!);
        hi = Math.max(hi, finish.get(k.id)!);
      }
      if (Number.isFinite(lo) && Number.isFinite(hi)) {
        start.set(cur, lo);
        finish.set(cur, hi);
      }
    }
    cur = byId.get(cur)!.parentId ?? null;
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
