// nightStaffing — which jobs have hands on nights.
//
// A schedule file can plan work around the clock that the site only staffs
// by day (nights here: four hands on the tower). Left to the file's times,
// the turnover tells nights to do day work. The project names the jobs a
// night crew works; every other step is day work, wherever the file put
// its hours — not listed for nights, carried to the next day shift.
//
// Kept with the shift times (projects.shift_times.nightJobs):
//   undefined — not decided: follow the schedule file's times
//   "file"    — decided: follow the file's times
//   string[]  — only these jobs (and everything under them) work nights

import type { Milestone } from "@/types/schema";

export type NightJobs = "file" | string[];

/** Steps outside the night jobs marked as day work (a copy, never saved).
 *  A step a person set to night / round the clock on its own keeps that. */
export function applyNightStaffing(milestones: Milestone[], night: NightJobs | undefined): Milestone[] {
  if (!Array.isArray(night)) return milestones;
  const jobs = new Set(night);
  const byId = new Map<string, Milestone>();
  for (const m of milestones) if (m.id) byId.set(m.id, m);
  const memo = new Map<string, boolean>();
  const underNight = (m: Milestone, guard = 0): boolean => {
    if (!m.id) return false;
    const hit = memo.get(m.id);
    if (hit != null) return hit;
    const p = m.parentId ? byId.get(m.parentId) : undefined;
    const v = jobs.has(m.id) || (!!p && guard < 50 && underNight(p, guard + 1));
    memo.set(m.id, v);
    return v;
  };
  return milestones.map((m) => {
    if (m.shift === "night" || (m.shift as string) === "swing" || (m.shift as string) === "both") return m;
    return underNight(m) ? m : { ...m, staffedShift: "day" as const };
  });
}

/** The jobs to offer: every task with steps under it, top down, with how
 *  many of its steps the file plans in night hours. */
export function nightJobChoices(milestones: Milestone[], isNightStep: (m: Milestone) => boolean): Array<{ id: string; name: string; depth: number; steps: number; nightSteps: number }> {
  const kids = new Map<string, Milestone[]>();
  const byId = new Map<string, Milestone>();
  for (const m of milestones) if (m.id) byId.set(m.id, m);
  for (const m of milestones) if (m.parentId && byId.has(m.parentId)) kids.set(m.parentId, [...(kids.get(m.parentId) ?? []), m]);
  const count = (m: Milestone, guard = 0): { steps: number; nightSteps: number } => {
    const ch = m.id ? kids.get(m.id) ?? [] : [];
    if (ch.length === 0 || guard > 50) return { steps: 1, nightSteps: isNightStep(m) ? 1 : 0 };
    return ch.reduce((a, c) => { const x = count(c, guard + 1); return { steps: a.steps + x.steps, nightSteps: a.nightSteps + x.nightSteps }; }, { steps: 0, nightSteps: 0 });
  };
  const out: Array<{ id: string; name: string; depth: number; steps: number; nightSteps: number }> = [];
  const walk = (list: Milestone[], depth: number) => {
    for (const m of [...list].sort((a, b) => (a.wbs ?? "").localeCompare(b.wbs ?? "", undefined, { numeric: true }) || a.name.localeCompare(b.name))) {
      if (!m.id || !(kids.get(m.id)?.length)) continue;
      out.push({ id: m.id, name: m.name, depth, ...count(m) });
      walk(kids.get(m.id) ?? [], depth + 1);
    }
  };
  walk(milestones.filter((m) => !m.parentId || !byId.has(m.parentId)), 0);
  return out;
}
