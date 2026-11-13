// lateWork - every work order that finished late, and where its hours went.
//
// For each one: the steps that took longer than planned, the time it sat
// between steps before a crew started the next one, and how late it began.
// The largest come first. Nothing is left to a fixed list of causes: any
// work order that ran late is read the same way, whatever it is.
//
// The parts are not a sum to the hours late (steps overlap, crews work
// several jobs); they are where the record shows the time going.
//
// Pure: no database here.

import type { AsBuilt } from "@/lib/asBuiltSchedule";
import type { AsBuiltWork } from "@/lib/asBuiltWork";
import { MIN_WAIT_H, stepBefore } from "@/lib/crewFlow";

const HOUR = 3_600_000;
const r1 = (n: number) => Math.round(n * 10) / 10;

export interface LatePart {
  /** "over": a step took longer than planned. "wait": it sat before a crew
   *  started the next step. "start": the work order began late. */
  kind: "over" | "wait" | "start";
  hours: number;
  stepId: string; step: string;
  /** The crew whose step it is (for "wait", the crew that was awaited). */
  crew: string;
  plannedH: number; tookH: number;
}
export interface LateOrder {
  order: string;
  /** Finished this many hours after its plan. */
  lateH: number;
  finish: number;
  /** Added during the event. */
  added: boolean;
  /** Where the hours went, largest first. */
  parts: LatePart[];
}

/** Work orders that finished `minLateH` or more after their plan, latest against plan first. */
export function lateOrders(built: AsBuilt, work: AsBuiltWork, dependsOn: Map<string, string[]> = new Map(), minLateH = 8): LateOrder[] {
  const crewOf = (id: string) => work.steps.get(id)?.crew ?? "Not set";
  const out: LateOrder[] = [];
  for (const o of built.orders) {
    if (o.finish == null || (o.varianceH ?? 0) < minLateH) continue;
    const steps = [...o.steps].sort((a, b) => (a.planStart ?? 0) - (b.planStart ?? 0));
    const parts: LatePart[] = [];
    steps.forEach((s, i) => {
      const took = s.elapsedH ?? (s.start != null && s.finish != null ? (s.finish - s.start) / HOUR : null);
      const base = { stepId: s.id, step: s.name, crew: crewOf(s.id), plannedH: r1(s.plannedH), tookH: r1(took ?? 0) };
      if (took != null && took - s.plannedH >= 2) parts.push({ kind: "over", hours: r1(took - s.plannedH), ...base });
      if (s.start == null) return;
      const prev = stepBefore(steps, i, dependsOn);
      if (prev) { const wait = (s.start - Math.min(prev.finish!, s.start)) / HOUR; if (wait >= MIN_WAIT_H) parts.push({ kind: "wait", hours: r1(wait), ...base }); }
      else if (i === 0 && s.planStart != null && (s.start - s.planStart) / HOUR >= MIN_WAIT_H) parts.push({ kind: "start", hours: r1((s.start - s.planStart) / HOUR), ...base });
    });
    out.push({ order: o.name, lateH: o.varianceH!, finish: o.finish, added: o.allAdded, parts: parts.sort((a, b) => b.hours - a.hours) });
  }
  return out.sort((a, b) => b.lateH - a.lateH);
}
