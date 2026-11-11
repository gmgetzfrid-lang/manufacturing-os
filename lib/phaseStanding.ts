// lib/phaseStanding.ts - where each phase stands, on its own clock.
//
// Phases are separate jobs in separate weeks that share one budget. A
// schedule percent or an ahead/behind verdict blended across them says
// nothing true: a phase that finished 33 hours late disappears inside a later
// phase that is ahead. So "All phases" shows one line per phase, each from
// its own steps only, and only the money is combined (lib/projectPhases).
//
// Every line is built from the same report the single-phase screens use
// (lib/executionReport) and the schedule's own forecast (lib/criticalPath),
// so a phase reads the same here as when it is picked. Pure.

import type { Milestone } from "@/types/schema";
import { computeExecutionReport } from "@/lib/executionReport";
import { resolveCriticalPath, type CriticalMode } from "@/lib/criticalPath";
import { inPhase, phaseIndex, phaseOnDay, type ProjectPhase } from "@/lib/projectPhases";
import { dayKey } from "@/lib/scheduleTz";
import type { ShiftTimes } from "@/lib/shiftReport";

export type PhaseState = "no schedule" | "not started" | "running" | "finished";

/** Where a set of steps stands on its own plan (one phase, or a project
 *  with no phases). */
export interface Standing {
  state: PhaseState;
  steps: number;
  done: number;
  /** % of the phase's work done, and where its plan says it should be by now. */
  pct: number;
  planPct: number;
  /** The verdict's two parts: hours done before the plan called for them,
   *  hours the plan called for that aren't done (and on how many steps). */
  aheadHours: number;
  behindHours: number;
  behindSteps: number;
  /** The net: positive is behind. */
  gapHours: number;
  standing: "ahead" | "on track" | "behind";
  overdue: number;
  plannedStart: string | null;
  plannedFinish: string | null;
  /** Running: where the schedule's links say it ends. */
  forecastFinish: string | null;
  /** Finished: when the last step was done. */
  finishedAt: string | null;
  /** Hours late (+) or early (-): the finish against the plan when finished,
   *  the forecast against the plan while running. Null when neither is known. */
  lateHours: number | null;
  /** Finished by the work, with steps of no hours still open. */
  openSteps: number;
}

export interface PhaseStanding extends Standing { id: string; name: string }

export interface StandingOpts { now: number; tz: string; shiftTimes?: ShiftTimes; criticalMode?: CriticalMode | null }

const H = 3_600_000;
const round1 = (n: number) => Math.round(n * 10) / 10;

/** Where these steps stand: the same report and forecast the one-phase
 *  screens show (lib/executionReport, lib/criticalPath). */
export function standingOf(ms: Milestone[], o: StandingOpts): Standing {
  const r = computeExecutionReport(ms, { tz: o.tz, now: new Date(o.now), shiftTimes: o.shiftTimes });
  const base = {
    steps: r.totalLeaves, done: r.done, pct: r.pctComplete, planPct: r.expectedPct,
    aheadHours: r.aheadHours, behindHours: r.behindHours, behindSteps: r.behindSteps, gapHours: r.gapHours, standing: r.standing,
    overdue: r.overdue, plannedStart: r.start, plannedFinish: r.finish, forecastFinish: null as string | null, finishedAt: r.finishedAt, lateHours: null as number | null,
    openSteps: r.allDone ? r.totalLeaves - r.done : 0,
  };
  if (r.totalLeaves === 0) return { ...base, state: "no schedule" };
  const cpm = resolveCriticalPath(ms, o.criticalMode ?? undefined, { now: o.now, tz: o.tz }).cpm;
  const linked = !!cpm && Number.isFinite(cpm.forecastFinish);
  const planMs = Date.parse(String(r.finish ?? ""));
  if (r.allDone) {
    const finMs = Date.parse(String(r.finishedAt ?? ""));
    const late = linked ? cpm!.slipH : Number.isFinite(finMs) && Number.isFinite(planMs) ? (finMs - planMs) / H : null;
    return { ...base, state: "finished", lateHours: late == null ? null : round1(late) };
  }
  const started = r.done > 0 || r.inProgress > 0 || r.pctComplete > 0;
  const startMs = Date.parse(String(r.start ?? ""));
  if (!started && Number.isFinite(startMs) && o.now < startMs) return { ...base, state: "not started" };
  return {
    ...base, state: "running",
    forecastFinish: linked ? new Date(cpm!.forecastFinish).toISOString() : r.forecastFinish,
    lateHours: linked ? round1(cpm!.slipH) : null,
  };
}

/** One line per phase, in the phases' order. `all` is every step on the
 *  project (cancelled ones already left out). */
export function phaseStandings(all: Milestone[], phases: ProjectPhase[], o: StandingOpts): PhaseStanding[] {
  return phases.map((p) => ({ id: p.id, name: p.name, ...standingOf(inPhase(all, phases, p.id), o) }));
}

/** The phase a day's standing belongs to, on a project split in phases:
 *  the one whose dates cover the day; outside every phase's dates (a phase
 *  that ran past its own, the days between two), the latest to have started
 *  by then; before any has started, the first to come. A phase with no
 *  start date set goes by its own schedule's first day. Null: one phase or
 *  none, or nothing dated to go by. */
export function phaseOfDay(day: string, phases: ProjectPhase[], all: Milestone[], tz: string): ProjectPhase | null {
  if (phases.length < 2) return null;
  const covering = phaseOnDay(day, phases);
  if (covering) return covering;
  const idx = phaseIndex(all, phases);
  const first = new Map<string, number>();
  const parents = new Set(all.map((m) => m.parentId).filter(Boolean));
  for (const m of all) {
    if (!m.id || parents.has(m.id)) continue;
    const t = Date.parse(String(m.baselineStartAt ?? m.plannedStartAt ?? m.plannedAt ?? ""));
    const ph = idx.get(m.id);
    if (ph && Number.isFinite(t)) first.set(ph, Math.min(first.get(ph) ?? Infinity, t));
  }
  const starts = phases.map((p) => ({ p, start: p.start ?? (first.has(p.id) ? dayKey(first.get(p.id)!, tz) : null) })).filter((x): x is { p: ProjectPhase; start: string } => !!x.start);
  if (!starts.length) return null;
  const begun = starts.filter((x) => x.start <= day).sort((a, b) => (a.start < b.start ? 1 : a.start > b.start ? -1 : 0));
  if (begun.length) return begun[0].p;
  return starts.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))[0].p;
}

/** "78 h done early, 35 h late on 6 steps": the two sides of a net verdict,
 *  when both are there to show. Null when the net says it all. */
export function verdictParts(s: { aheadHours: number; behindHours: number; behindSteps: number }): string | null {
  if (s.aheadHours < 0.5 || s.behindHours < 0.5) return null;
  return `${round1(s.aheadHours)} h done early, ${round1(s.behindHours)} h late on ${s.behindSteps} step${s.behindSteps === 1 ? "" : "s"}`;
}

/** "33.5 h late", "2 h early", "on time". */
export function lateWords(lateHours: number | null): string | null {
  if (lateHours == null) return null;
  if (lateHours >= 0.5) return `${round1(lateHours)} h late`;
  if (lateHours <= -0.5) return `${round1(-lateHours)} h early`;
  return "on time";
}

/** A phase's standing in words, for its line: the headline, then what
 *  backs it. `when` writes a time the way the screen does. */
export function standingWords(s: Standing, when: (iso: string) => string): { head: string; lines: string[]; tone: "rose" | "emerald" | "amber" | "slate" } {
  const late = lateWords(s.lateHours);
  if (s.state === "no schedule") return { head: "No schedule yet", lines: ["Import its schedule to track it"], tone: "amber" };
  if (s.state === "not started") {
    return { head: "Not started", lines: [[s.plannedStart ? `starts ${when(s.plannedStart)}` : null, s.plannedFinish ? `planned finish ${when(s.plannedFinish)}` : null].filter(Boolean).join(", ")].filter(Boolean), tone: "slate" };
  }
  if (s.state === "finished") {
    return {
      head: `Finished${s.finishedAt ? ` ${when(s.finishedAt)}` : ""}${late ? `, ${late}` : ""}`,
      lines: [s.plannedFinish ? `planned finish ${when(s.plannedFinish)}` : null, s.openSteps ? `${s.openSteps} step${s.openSteps === 1 ? "" : "s"} with no hours still open` : null].filter((x): x is string => !!x),
      tone: (s.lateHours ?? 0) >= 0.5 ? "rose" : (s.lateHours ?? 0) <= -0.5 ? "emerald" : "slate",
    };
  }
  const gap = round1(Math.abs(s.gapHours));
  const verdict = s.standing === "behind" ? `${gap} h behind plan` : s.standing === "ahead" ? `${gap} h ahead of plan` : "on plan";
  return {
    head: `${s.pct}% done, plan by now ${s.planPct}%, ${verdict}`,
    lines: [
      verdictParts(s),
      s.forecastFinish ? `forecast end ${when(s.forecastFinish)}${late ? `, ${late}` : ""}` : null,
      s.overdue ? `${s.overdue} step${s.overdue === 1 ? "" : "s"} overdue` : null,
    ].filter((x): x is string => !!x),
    tone: s.standing === "behind" || (s.lateHours ?? 0) >= 0.5 ? "rose" : s.standing === "ahead" ? "emerald" : "slate",
  };
}

/** One phase in a few words, for a one-line summary. */
export function standingShort(s: PhaseStanding): string {
  if (s.state === "no schedule") return `${s.name}: no schedule`;
  if (s.state === "not started") return `${s.name}: not started`;
  if (s.state === "finished") { const l = lateWords(s.lateHours); return `${s.name}: finished${l ? `, ${l}` : ""}`; }
  return `${s.name}: ${s.pct}% (plan ${s.planPct}%), ${s.standing}`;
}
