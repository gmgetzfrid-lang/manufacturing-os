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
}

export interface DateChange {
  id: string;
  plannedStartAt: string; // ISO
  plannedAt: string;      // ISO
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

  // 1) Shift the dragged node and all descendants by the delta.
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
    start.set(sid, start.get(sid)! + delta);
    finish.set(sid, finish.get(sid)! + delta);
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
