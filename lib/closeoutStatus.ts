// closeoutStatus - where a job stands for its close-out: the work (every
// step done, when the last one finished against the plan), and whether a
// finished job should open on its close-out.
//
// Pure.

import type { Milestone } from "@/types/schema";
import { discoveryOf } from "@/lib/discovery";
import { phaseIndex, type ProjectPhase } from "@/lib/projectPhases";

const ms = (s: unknown) => { const t = typeof s === "string" ? Date.parse(s) : NaN; return Number.isFinite(t) ? t : null; };
const isDone = (m: Pick<Milestone, "status" | "percentComplete">) => m.status === "completed" || Number(m.percentComplete ?? 0) >= 100;

/** The steps that are work: no steps under them, not a summary, not cancelled. */
export function workSteps<T extends Pick<Milestone, "id" | "parentId" | "isSummary"> & { cancelledAt?: unknown }>(all: T[]): T[] {
  const parents = new Set(all.map((m) => m.parentId).filter(Boolean) as string[]);
  return all.filter((m) => m.id && !parents.has(m.id) && !m.isSummary && !m.cancelledAt);
}

/** The original plan: the steps in it, with their dates as saved.
 *  - "baseline": the plan as saved (Plan › Save baseline). Its steps are the
 *    ones saved with it; added work and steps put in after it was saved
 *    aren't in it.
 *  - "schedule": no plan saved, so the schedule as it is stands in for it,
 *    without the added work (discovery, added scope).
 *  Its start and finish are the saved dates (else the planned ones). */
export interface OriginalPlan {
  kind: "baseline" | "schedule";
  steps: Milestone[];
  start: number | null;
  finish: number | null;
  /** When it was saved (the first save). */
  savedAt: number | null;
}

export function originalPlan(steps: Milestone[]): OriginalPlan {
  const isAdded = (m: Milestone) => !!discoveryOf(m);
  const saved = steps.filter((m) => !isAdded(m) && ms(m.baselineStartAt) != null && ms(m.baselineFinishAt) != null);
  const kind: OriginalPlan["kind"] = saved.length ? "baseline" : "schedule";
  const inIt = kind === "baseline" ? saved : steps.filter((m) => !isAdded(m));
  const startOf = (m: Milestone) => (kind === "baseline" ? ms(m.baselineStartAt) : ms(m.plannedStartAt) ?? ms(m.plannedAt));
  const finishOf = (m: Milestone) => (kind === "baseline" ? ms(m.baselineFinishAt) : ms(m.plannedAt));
  const starts = inIt.map(startOf).filter((x): x is number => x != null);
  const ends = inIt.map(finishOf).filter((x): x is number => x != null);
  const set = saved.map((m) => ms(m.baselineSetAt)).filter((x): x is number => x != null);
  return {
    kind, steps: inIt,
    start: starts.length ? Math.min(...starts) : null,
    finish: ends.length ? Math.max(...ends) : null,
    savedAt: set.length ? Math.min(...set) : null,
  };
}

/** Progress already recorded on the schedule: steps done, and started (not
 *  done). What a clear or a replace would cut off from the reports. */
export function recordedProgress(all: Milestone[]): { done: number; started: number } {
  const steps = workSteps(all as Array<Milestone & { cancelledAt?: unknown }>);
  const done = steps.filter(isDone).length;
  const started = steps.filter((m) => !isDone(m) && (m.status === "in_progress" || m.status === "on_hold" || m.status === "blocked" || Number(m.percentComplete ?? 0) > 0 || !!m.actualStartAt)).length;
  return { done, started };
}

/** "113 steps already have progress recorded (113 done)": said before
 *  a clear or a replace. Empty when there's none. */
export function progressWarning(all: Milestone[]): string {
  const { done, started } = recordedProgress(all);
  const n = done + started;
  if (!n) return "";
  return `${n} step${n === 1 ? " already has" : "s already have"} progress recorded (${[done ? `${done} done` : "", started ? `${started} started` : ""].filter(Boolean).join(", ")}). This cuts that record off: the reports, the as-built schedule and each shift's history will no longer show it.`;
}

export interface WorkSummary {
  total: number;
  done: number;
  allDone: boolean;
  /** Every step done: when the last one finished. */
  finishedAt: number | null;
  /** The original plan's finish (as saved; see originalPlan). */
  plannedFinish: number | null;
  /** Finished minus planned, in hours (negative: early). */
  hoursAfterPlan: number | null;
}

export function workSummary(all: Milestone[]): WorkSummary {
  const steps = workSteps(all as Array<Milestone & { cancelledAt?: unknown }>);
  const done = steps.filter(isDone);
  const allDone = steps.length > 0 && done.length === steps.length;
  const finishes = done.map((m) => ms(m.actualAt)).filter((x): x is number => x != null);
  const finishedAt = allDone && finishes.length ? Math.max(...finishes) : null;
  // Measured against the original plan's finish (as saved).
  const plannedFinish = originalPlan(steps).finish;
  return {
    total: steps.length, done: done.length, allDone, finishedAt, plannedFinish,
    hoursAfterPlan: finishedAt != null && plannedFinish != null ? Math.round(((finishedAt - plannedFinish) / 3_600_000) * 10) / 10 : null,
  };
}

/** "33.5 h after plan", "2 h before plan", "on plan". */
export function vsPlanWords(h: number | null): string {
  if (h == null) return "";
  if (Math.abs(h) < 0.5) return "on plan";
  return `${Math.abs(h)} h ${h > 0 ? "after" : "before"} plan`;
}

type StepRow = { id: string; parent_id: string | null; status: string; percent_complete: number | null; is_summary?: boolean | null; cancelled_at?: string | null; attributes?: unknown };

/** Where the work stands, phase by phase, from the steps as read for the
 *  project page: the phases with no schedule, whether every scheduled step
 *  is done, and whether the whole job is (every phase scheduled and done). */
export function workState(rows: StepRow[], phases: ProjectPhase[] = []): { unscheduled: ProjectPhase[]; scheduledDone: boolean; allDone: boolean } {
  const parents = new Set(rows.map((r) => r.parent_id).filter(Boolean) as string[]);
  const steps = rows.filter((r) => !parents.has(r.id) && !r.is_summary && !r.cancelled_at);
  const scheduledDone = steps.length > 0 && steps.every((r) => r.status === "completed" || Number(r.percent_complete ?? 0) >= 100);
  if (!phases.length) return { unscheduled: [], scheduledDone, allDone: scheduledDone };
  const idx = phaseIndex(rows.map((r) => ({ id: r.id, parentId: r.parent_id, attributes: r.attributes ?? null } as unknown as Milestone)), phases);
  const unscheduled = phases.filter((p) => !steps.some((r) => idx.get(r.id) === p.id));
  return { unscheduled, scheduledDone, allDone: scheduledDone && unscheduled.length === 0 };
}

/** Open a project on its close-out: completed, or every step of every
 *  phase done (a phase with no schedule yet isn't done). */
export const opensOnCloseout = (status: string | null | undefined, rows: StepRow[], phases: ProjectPhase[] = []) =>
  status === "completed" || workState(rows, phases).allDone;
