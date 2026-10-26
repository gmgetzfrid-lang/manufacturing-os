// lib/taskQuickLook.ts — the answers people ask about a step in the meeting.
//
// "Where should it be by the end of shift?", "When is it scheduled to be
// done?", "When is the whole exchanger done?", "What comes after it?" —
// one small card, from the schedule alone. And a search so any step can be
// looked up, even one not on tonight's report.

import type { Milestone } from "@/types/schema";
import type { ProgressInfo } from "@/lib/scheduleProgress";
import { leafPercent } from "@/lib/scheduleProgress";
import { startMsOf, finishMsOf } from "@/lib/calendarPlacement";
import { expectedFraction, type ShiftTimes } from "@/lib/shiftReport";

export interface QuickLookStep {
  id: string;
  name: string;
  /** The equipment / group it sits under. */
  parentName: string | null;
  who: string | null;
  start: number;
  finish: number;
  percent: number;
}

/** A task above the step — equipment, area, phase, the job — and when it
 *  is scheduled to be done. */
export interface QuickLookLevel {
  id: string;
  name: string;
  finish: number;
  percent: number;
  done: number;
  total: number;
}

export interface QuickLook extends QuickLookStep {
  wo: string | null;
  status: Milestone["status"];
  reason: string | null;
  /** % the plan has it at as of the report. */
  planNow: number;
  /** % the plan has it at by the end of the next shift. */
  goal: number;
  /** The equipment it belongs to: when it finishes and how far along. */
  equipment: QuickLookLevel | null;
  /** Every level above it, nearest first (equipment … the whole job). */
  levels: QuickLookLevel[];
  /** The equipment's steps in start order, this one marked, and the one
   *  that comes next marked. */
  order: Array<QuickLookStep & { isThis: boolean; isNext: boolean }>;
  /** What follows it: the steps that wait on it, else the next step on
   *  the same equipment. Empty = the last step there. */
  next: QuickLookStep[];
  /** Steps on OTHER equipment that wait on it. */
  nextElsewhere: QuickLookStep[];
  /** Unfinished steps it waits on. */
  waitsOn: QuickLookStep[];
}

export interface QuickLookIndex {
  byId: Map<string, Milestone>;
  children: Map<string, Milestone[]>;
  /** Steps that list each id in their dependsOn. */
  successors: Map<string, Milestone[]>;
  leaves: Milestone[];
}

export function quickLookIndex(milestones: Milestone[]): QuickLookIndex {
  const byId = new Map<string, Milestone>();
  const children = new Map<string, Milestone[]>();
  const successors = new Map<string, Milestone[]>();
  for (const m of milestones) {
    if (m.id) byId.set(m.id, m);
    if (m.parentId) children.set(m.parentId, [...(children.get(m.parentId) ?? []), m]);
  }
  const leaves = milestones.filter((m) => m.id && !children.has(m.id));
  for (const m of leaves) for (const d of m.dependsOn ?? []) successors.set(d, [...(successors.get(d) ?? []), m]);
  return { byId, children, successors, leaves };
}

const pctOf = (m: Milestone, progress?: Map<string, ProgressInfo>) => (m.id ? progress?.get(m.id)?.percent : undefined) ?? leafPercent(m);
const byStart = (a: Milestone, b: Milestone) => startMsOf(a) - startMsOf(b) || finishMsOf(a) - finishMsOf(b);

function stepOf(m: Milestone, idx: QuickLookIndex, progress?: Map<string, ProgressInfo>): QuickLookStep {
  return {
    id: m.id ?? m.name, name: m.name,
    parentName: m.parentId ? idx.byId.get(m.parentId)?.name ?? null : null,
    who: m.responsibleParty ?? null,
    start: startMsOf(m), finish: finishMsOf(m), percent: pctOf(m, progress),
  };
}

export function quickLook(id: string, idx: QuickLookIndex, o: {
  progress?: Map<string, ProgressInfo>; tz: string; times: ShiftTimes; asOf: number; goalAt: number;
}): QuickLook | null {
  const m = idx.byId.get(id);
  if (!m || idx.children.has(id)) return null;
  const base = stepOf(m, idx, o.progress);
  const done = base.percent >= 100 || m.status === "completed";
  const parent = m.parentId ? idx.byId.get(m.parentId) : undefined;
  // Every step under a task, nested groups included.
  const under = (pid: string): Milestone[] => (idx.children.get(pid) ?? []).flatMap((c) => (c.id && idx.children.has(c.id) ? under(c.id) : [c]));
  const levelOf = (t: Milestone): QuickLookLevel => {
    const steps = t.id ? under(t.id) : [];
    const finishes = [finishMsOf(t), ...steps.map(finishMsOf)].filter(Number.isFinite);
    return {
      id: t.id ?? t.name, name: t.name,
      finish: finishes.length ? Math.max(...finishes) : NaN,
      percent: (t.id ? o.progress?.get(t.id)?.percent : undefined) ?? Math.round(steps.reduce((a, s) => a + pctOf(s, o.progress), 0) / Math.max(1, steps.length)),
      done: steps.filter((s) => pctOf(s, o.progress) >= 100).length,
      total: steps.length,
    };
  };
  const levels: QuickLookLevel[] = [];
  for (let t = parent, n = 0; t && n < 10; t = t.parentId ? idx.byId.get(t.parentId) : undefined, n++) levels.push(levelOf(t));
  const equipment = levels[0] ?? null;
  const eqSteps = (parent?.id ? under(parent.id) : [m]).slice().sort(byStart);
  const eqIds = new Set(eqSteps.map((x) => x.id));

  const succ = (idx.successors.get(id) ?? []).slice().sort(byStart);
  const nextOnEquipment = eqSteps
    .filter((x) => x.id !== id && (startMsOf(x) > base.start || (startMsOf(x) === base.start && finishMsOf(x) > base.finish)))
    .slice(0, 1);
  const next = (succ.length ? succ.slice(0, 3) : nextOnEquipment).map((x) => stepOf(x, idx, o.progress));
  const nextIds = new Set(next.map((x) => x.id));
  const order = eqSteps.map((x) => ({ ...stepOf(x, idx, o.progress), isThis: x.id === id, isNext: nextIds.has(x.id ?? x.name) }));
  const nextElsewhere = succ.filter((x) => !eqIds.has(x.id)).map((x) => stepOf(x, idx, o.progress));

  const waitsOn = (m.dependsOn ?? [])
    .map((d) => idx.byId.get(d)).filter((p): p is Milestone => !!p && pctOf(p, o.progress) < 100)
    .sort(byStart).map((x) => stepOf(x, idx, o.progress));

  // Past its finish and not done: the goal is to finish it.
  const goal = done ? 100 : base.finish <= o.goalAt ? 100 : Math.round(expectedFraction(m, o.goalAt, o.tz, o.times) * 100);
  return {
    ...base,
    wo: m.workOrderRef ?? null, status: m.status, reason: m.statusReason ?? null,
    planNow: Math.round(expectedFraction(m, o.asOf, o.tz, o.times) * 100),
    goal, equipment, levels, order, next, nextElsewhere, waitsOn,
  };
}

/** Steps matching a search — by name, work order, equipment or crew —
 *  soonest first. "E-12" finds every step on E-12. */
export function searchSteps(q: string, idx: QuickLookIndex, limit = 8): QuickLookStep[] {
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const hay = (m: Milestone) => {
    const chain: string[] = [];
    for (let p = m.parentId ? idx.byId.get(m.parentId) : undefined, n = 0; p && n < 8; p = p.parentId ? idx.byId.get(p.parentId) : undefined, n++) chain.push(p.name);
    return [m.name, m.workOrderRef ?? "", m.responsibleParty ?? "", ...chain].join(" ").toLowerCase();
  };
  return idx.leaves
    .filter((m) => { const h = hay(m); return words.every((w) => h.includes(w)); })
    .sort(byStart).slice(0, limit)
    .map((m) => stepOf(m, idx));
}
