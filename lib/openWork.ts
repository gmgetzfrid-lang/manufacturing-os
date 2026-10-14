// openWork — "what is live right now, whatever the plan says".
//
// The calendar and the Day view are built from PLANNED dates. Real
// outages drift from the plan in two ways that must never fall out of
// sight:
//   • CARRY-OVER: a step whose planned finish has passed and that isn't
//     done. It belongs at the top of today until someone finishes it or
//     re-plans it.
//   • STARTED EARLY: a step planned for a later day that the crew has
//     already begun (in progress, or any % entered). It belongs on today
//     too, because that's where the hands are.
// Pure helpers over the milestone list; the views decide how to show
// them. Only leaves count — parents roll up.

import type { Milestone, MilestoneStatus } from "@/types/schema";
import { startMsOf, finishMsOf } from "@/lib/calendarPlacement";

export type OpenWorkKind = "overdue" | "started-early";

export interface OpenWork {
  leaf: Milestone;
  kind: OpenWorkKind;
  start: number;
  finish: number;
  percent: number;
}

const pctOf = (m: Milestone) => (m.percentComplete != null ? Math.round(m.percentComplete) : (m.status === "completed" ? 100 : 0));
const isDone = (m: Milestone) => m.status === "completed" || pctOf(m) >= 100;
const isUnderway = (m: Milestone) => !isDone(m) && (m.status === "in_progress" || pctOf(m) > 0);

function leavesOf(milestones: Milestone[]): Milestone[] {
  const byId = new Set<string>();
  for (const m of milestones) if (m.id) byId.add(m.id);
  const hasKids = new Set<string>();
  for (const m of milestones) if (m.parentId && byId.has(m.parentId)) hasKids.add(m.parentId);
  return milestones.filter((m) => m.plannedAt && !(m.id && hasKids.has(m.id)));
}

/** Open steps whose planned finish is before `dayStartMs` — overdue work
 *  that carries into this day. Critical first, then oldest due first. */
export function overdueOpenWork(milestones: Milestone[], dayStartMs: number, criticalIds?: Set<string>): OpenWork[] {
  const out: OpenWork[] = [];
  for (const m of leavesOf(milestones)) {
    const f = finishMsOf(m), s = startMsOf(m);
    if (!Number.isFinite(f) || f >= dayStartMs || isDone(m)) continue;
    out.push({ leaf: m, kind: "overdue", start: s, finish: f, percent: pctOf(m) });
  }
  const crit = (w: OpenWork) => (criticalIds && w.leaf.id ? Number(criticalIds.has(w.leaf.id)) : 0);
  return out.sort((a, b) => crit(b) - crit(a) || a.finish - b.finish || a.leaf.name.localeCompare(b.leaf.name));
}

/** Steps planned to start on or after `dayEndMs` that are already underway —
 *  work the crew pulled forward. Soonest planned first. */
export function startedEarlyWork(milestones: Milestone[], dayEndMs: number): OpenWork[] {
  const out: OpenWork[] = [];
  for (const m of leavesOf(milestones)) {
    const s = startMsOf(m), f = finishMsOf(m);
    if (!Number.isFinite(s) || s < dayEndMs || !isUnderway(m)) continue;
    out.push({ leaf: m, kind: "started-early", start: s, finish: f, percent: pctOf(m) });
  }
  return out.sort((a, b) => a.start - b.start || a.leaf.name.localeCompare(b.leaf.name));
}

/** Predecessors of `task` that would still be unfinished when it starts at
 *  `newStartMs` — the dependency conflicts a move or an early start creates. */
export function predecessorConflicts(
  task: Milestone,
  newStartMs: number,
  byId: Map<string, Milestone>,
): Array<{ pred: Milestone; predFinish: number }> {
  const out: Array<{ pred: Milestone; predFinish: number }> = [];
  for (const id of task.dependsOn ?? []) {
    const p = byId.get(id);
    if (!p || isDone(p)) continue;
    const pf = finishMsOf(p);
    if (Number.isFinite(pf) && pf > newStartMs) out.push({ pred: p, predFinish: pf });
  }
  return out.sort((a, b) => b.predFinish - a.predFinish);
}

export const openWorkStatusLabel = (s: MilestoneStatus) => (s === "in_progress" ? "in progress" : s === "on_hold" ? "on hold" : s);
