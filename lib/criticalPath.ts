// lib/criticalPath.ts
//
// The critical path, from the schedule's own dependency links (PT SCH-15 /
// PC SCHED-10). The date-walk heuristic that lived here ("critical-path
// lite": walk backward by date contiguity inside a 1-day slack / 14-day
// window) is RETIRED — it ignored the finish-to-start links the reschedule
// engine honours, merged parallel chains into one seam, dropped any driver
// more than 14 days back, and counted a 90%-done task's hours in full.
//
// What this computes: a backward pass over the SCHEDULED network. Each leaf
// keeps its planned dates; the latest it could be ready without delaying the
// project finish is
//
//     lateReady(n) = min over successors s of (lateStart(s) − lag(n→s)),
//                    or the project finish when n has no successor
//     lateStart(s) = lateReady(s) − occupied(s)
//
// and its TOTAL FLOAT is lateReady(n) − ready(n) (reported per leaf).
// "Ready" is the instant a finish-to-start successor may start
// (scheduleReflow.fsReadyMs: the end of the day for a date-only finish, the
// instant for a timed one), and lag is the source schedule's own
// (attributes.source_links, PT SCH-8), stored in WORKING hours and counted
// as working days Monday–Friday (scheduleReflow.afterLagMs, the rule the
// cascade applies) — "+5d" is five working days, not 40 elapsed hours.
//
// The PATH is the chain of DRIVING links traced back from the finish —
// Primavera's "longest path": start from the unfinished leaves that are ready
// within the tolerance of the project finish, and follow each predecessor
// link whose successor starts within the tolerance of that predecessor being
// ready (+ lag). Per-link, because with no working calendar the calendar-day
// float of a chain of 08:00–17:00 tasks grows by an overnight gap at every
// hand-off; a driving link is judged on its own gap (default tolerance: under
// one calendar day, so the evening-finish / morning-start hand-off drives).
//
// Calendar days, no working calendar: a weekend gap between two linked tasks
// is not driving. A leaf with no links only counts when it ends at the
// finish. Summaries are envelopes: a link to or from a phase applies to
// every leaf inside it. A loop in the links is reported and left out. Pure.

import type { Milestone } from "@/types/schema";
import { DAY_MS, afterLagMs, fsReadyMs, reflowNodesFromMilestones } from "@/lib/scheduleReflow";
import { leafPercent } from "@/lib/scheduleProgress";

export interface CriticalPathResult {
  /** Unfinished leaf ids on the driving chain(s) back from the finish — what gates it. */
  ids: Set<string>;
  /** The project finish (ISO): the latest leaf finish. */
  finish: string | null;
  /** Hours still to do on the path: Σ planned hours × (100 − % complete) / 100. */
  remainingHours: number;
  /** Total float per unfinished leaf, in days (leaves in a loop are absent). */
  floatDays: Map<string, number>;
  /** Whether any finish-to-start link connects two leaves at all. */
  linked: boolean;
  /** Unfinished leaves with no link in or out — they count only when they
   *  end at the finish, so the screen can say "add links to see the chain". */
  unlinked: number;
  /** Leaf ids inside a loop of links (left out of the pass), or null. */
  cycle: string[] | null;
}

const startMs = (m: Milestone) => Date.parse((m.plannedStartAt as string | undefined) ?? (m.plannedAt as string));
const finishMs = (m: Milestone) => Date.parse(m.plannedAt as string);

export function computeCriticalPath(
  milestones: Milestone[],
  opts?: { toleranceDays?: number },
): CriticalPathResult {
  const tolerance = (opts?.toleranceDays ?? 1) * DAY_MS;
  const empty: CriticalPathResult = { ids: new Set(), finish: null, remainingHours: 0, floatDays: new Map(), linked: false, unlinked: 0, cycle: null };

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

  const ready = new Map<string, number>();
  const occupied = new Map<string, number>();
  let projectReady = -Infinity, projectFinish = -Infinity;
  for (const id of leafIds) {
    const m = byId.get(id)!;
    const f = finishMs(m);
    const s = Number.isFinite(startMs(m)) ? startMs(m) : f;
    const r = fsReadyMs(f);
    ready.set(id, r);
    occupied.set(id, Math.max(0, r - s));
    projectReady = Math.max(projectReady, r);
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

  const lateReady = new Map<string, number>();
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i];
    let lr = projectReady;
    for (const [s, lag] of succ.get(id) ?? []) {
      const sLate = lateReady.get(s);
      if (sLate === undefined) continue; // a successor inside a loop does not constrain
      lr = Math.min(lr, afterLagMs(sLate - occupied.get(s)!, -lag));
    }
    lateReady.set(id, lr);
  }

  const floatDays = new Map<string, number>();
  let unlinked = 0;
  const open = (id: string) => byId.get(id)!.status !== "completed" && inOrder.has(id);
  for (const id of order) {
    if (!open(id)) continue;
    floatDays.set(id, Math.round(((lateReady.get(id)! - ready.get(id)!) / DAY_MS) * 10) / 10);
    if (!hasPred.has(id) && !succ.has(id)) unlinked++;
  }

  // The driving chain(s), traced back from the finish through driving links.
  const preds = new Map<string, Array<{ p: string; lag: number }>>();
  for (const [p, row] of succ) for (const [sId, lag] of row) {
    const arr = preds.get(sId) ?? []; arr.push({ p, lag }); preds.set(sId, arr);
  }
  const ids = new Set<string>();
  const stack = leafIds.filter((id) => open(id) && projectReady - ready.get(id)! < tolerance);
  while (stack.length) {
    const id = stack.pop()!;
    if (ids.has(id)) continue;
    ids.add(id);
    const start = ready.get(id)! - occupied.get(id)!;
    for (const { p, lag } of preds.get(id) ?? []) {
      if (!open(p) || ids.has(p)) continue;
      if (start - afterLagMs(ready.get(p)!, lag) < tolerance) stack.push(p);
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
    linked,
    unlinked,
    cycle: cycle.length > 0 ? cycle : null,
  };
}
