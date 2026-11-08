// closeoutStatus - where a job stands for its close-out: the work (every
// step done, when the last one finished against the plan), and whether a
// finished job should open on its close-out.
//
// Pure.

import type { Milestone } from "@/types/schema";

const ms = (s: unknown) => { const t = typeof s === "string" ? Date.parse(s) : NaN; return Number.isFinite(t) ? t : null; };
const isDone = (m: Pick<Milestone, "status" | "percentComplete">) => m.status === "completed" || Number(m.percentComplete ?? 0) >= 100;

/** The steps that are work: no steps under them, not a summary, not cancelled. */
export function workSteps<T extends Pick<Milestone, "id" | "parentId" | "isSummary"> & { cancelledAt?: unknown }>(all: T[]): T[] {
  const parents = new Set(all.map((m) => m.parentId).filter(Boolean) as string[]);
  return all.filter((m) => m.id && !parents.has(m.id) && !m.isSummary && !m.cancelledAt);
}

export interface WorkSummary {
  total: number;
  done: number;
  allDone: boolean;
  /** Every step done: when the last one finished. */
  finishedAt: number | null;
  /** The plan's finish: the last planned finish. */
  plannedFinish: number | null;
  /** Finished minus planned, in hours (negative: early). */
  hoursAfterPlan: number | null;
}

export function workSummary(all: Milestone[]): WorkSummary {
  const steps = workSteps(all as Array<Milestone & { cancelledAt?: unknown }>);
  const done = steps.filter(isDone);
  const allDone = steps.length > 0 && done.length === steps.length;
  const finishes = done.map((m) => ms(m.actualAt)).filter((x): x is number => x != null);
  const plans = steps.map((m) => ms(m.plannedAt)).filter((x): x is number => x != null);
  const finishedAt = allDone && finishes.length ? Math.max(...finishes) : null;
  const plannedFinish = plans.length ? Math.max(...plans) : null;
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

/** Open a project on its close-out: completed, or every step done. */
export const opensOnCloseout = (status: string | null | undefined, rows: Array<{ id: string; parent_id: string | null; status: string; percent_complete: number | null; is_summary?: boolean | null; cancelled_at?: string | null }>) => {
  if (status === "completed") return true;
  const parents = new Set(rows.map((r) => r.parent_id).filter(Boolean) as string[]);
  const steps = rows.filter((r) => !parents.has(r.id) && !r.is_summary && !r.cancelled_at);
  return steps.length > 0 && steps.every((r) => r.status === "completed" || Number(r.percent_complete ?? 0) >= 100);
};
