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
//   string[]  — only these work nights. Each entry is one of
//     "crew:*:<crew>"        that crew, on all its work
//     "crew:<jobId>:<crew>"  that crew, only under that job
//     "<jobId>"              that job, any crew (older setting; still honored)
//   A crew is the step's responsible party — or, left blank, its work
//   order's (lib/workOrderCrew); "" = steps with none to be found.

import type { Milestone } from "@/types/schema";
import { inheritedCrews } from "@/lib/workOrderCrew";

export type NightJobs = "file" | string[];

/** One crew on nights: everywhere (job null) or only under one job. */
export interface NightCrew { crew: string; job: string | null }

const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

export function crewEntry(crew: string, job: string | null): string { return `crew:${job ?? "*"}:${crew}`; }
export function parseEntry(e: string): NightCrew | { job: string } {
  if (!e.startsWith("crew:")) return { job: e };
  const rest = e.slice(5);
  const i = rest.indexOf(":");
  if (i < 0) return { job: e };
  const job = rest.slice(0, i);
  return { crew: rest.slice(i + 1), job: job === "*" ? null : job };
}

/** Steps nobody on nights works, marked as day work (a copy, never saved).
 *  A step a person set to night / round the clock on its own keeps that. */
export function applyNightStaffing(milestones: Milestone[], night: NightJobs | undefined): Milestone[] {
  if (!Array.isArray(night)) return milestones;
  const jobs = new Set<string>();
  const crews: NightCrew[] = [];
  for (const e of night) { const x = parseEntry(e); if ("crew" in x) crews.push(x); else jobs.add(x.job); }
  const byId = new Map<string, Milestone>();
  for (const m of milestones) if (m.id) byId.set(m.id, m);
  // A step with no crew named works with its work order's crew.
  const woCrew = inheritedCrews(milestones);
  // The step and everything above it.
  const lineOf = (m: Milestone): Set<string> => {
    const out = new Set<string>();
    for (let c: Milestone | undefined = m, g = 0; c?.id && g < 60 && !out.has(c.id); c = c.parentId ? byId.get(c.parentId) : undefined, g++) out.add(c.id);
    return out;
  };
  // A job named (older setting) covers its own row too.
  const jobsCover = (m: Milestone) => { const line = lineOf(m); for (const j of jobs) if (line.has(j)) return true; return false; };
  const staffed = (m: Milestone): boolean => {
    const line = lineOf(m);
    for (const j of jobs) if (line.has(j)) return true;
    const who = norm(m.responsibleParty || (m.id ? woCrew.get(m.id) : undefined));
    return crews.some((c) => norm(c.crew) === who && (c.job == null || line.has(c.job)));
  };
  // A job with any step on nights is worked on nights (its own row follows its steps).
  const parents = new Set<string>();
  for (const m of milestones) if (m.parentId) parents.add(m.parentId);
  const onNights = new Set<string>();
  for (const m of milestones) {
    if (!m.id || parents.has(m.id) || !staffed(m)) continue;
    for (const id of lineOf(m)) onNights.add(id);
  }
  return milestones.map((m) => {
    if (m.shift === "night" || (m.shift as string) === "swing" || (m.shift as string) === "both") return m;
    const on = m.id ? (parents.has(m.id) ? onNights.has(m.id) || jobsCover(m) : staffed(m)) : false;
    return on ? m : { ...m, staffedShift: "day" as const };
  });
}

export interface CrewChoice {
  /** As written on the schedule ("" = no crew named). */
  crew: string;
  steps: number;
  /** Steps the schedule file puts in night hours. */
  nightSteps: number;
  /** The equipment / jobs this crew has steps on — each step's own parent. */
  jobs: Array<{ id: string; name: string; crumbs: string; steps: number; nightSteps: number }>;
}

/** The crews to offer, each with the jobs it works: crews with work the
 *  file puts at night first. */
export function nightCrewChoices(milestones: Milestone[], isNightStep: (m: Milestone) => boolean): CrewChoice[] {
  const woCrew = inheritedCrews(milestones);
  const byId = new Map<string, Milestone>();
  const parents = new Set<string>();
  for (const m of milestones) { if (m.id) byId.set(m.id, m); if (m.parentId) parents.add(m.parentId); }
  const crumbsOf = (m: Milestone) => {
    const out: string[] = [];
    for (let p = m.parentId ? byId.get(m.parentId) : undefined, g = 0; p && g < 60; p = p.parentId ? byId.get(p.parentId) : undefined, g++) out.unshift(p.name);
    return out.join(" › ");
  };
  const crews = new Map<string, { label: string; steps: number; nightSteps: number; jobs: Map<string, { id: string; name: string; crumbs: string; steps: number; nightSteps: number; wbs: string }> }>();
  for (const m of milestones) {
    if (!m.id || parents.has(m.id)) continue; // steps only
    const label = m.responsibleParty?.trim() || woCrew.get(m.id) || "";
    const key = norm(label);
    const c = crews.get(key) ?? { label, steps: 0, nightSteps: 0, jobs: new Map() };
    const night = isNightStep(m) ? 1 : 0;
    c.steps++; c.nightSteps += night;
    const job = m.parentId ? byId.get(m.parentId) : undefined;
    if (job?.id) {
      const j = c.jobs.get(job.id) ?? { id: job.id, name: job.name, crumbs: crumbsOf(job), steps: 0, nightSteps: 0, wbs: job.wbs ?? "" };
      j.steps++; j.nightSteps += night;
      c.jobs.set(job.id, j);
    }
    crews.set(key, c);
  }
  return [...crews.values()]
    .map((c) => ({ crew: c.label, steps: c.steps, nightSteps: c.nightSteps,
      jobs: [...c.jobs.values()].sort((a, b) => a.wbs.localeCompare(b.wbs, undefined, { numeric: true }) || a.name.localeCompare(b.name, undefined, { numeric: true }))
        .map(({ wbs: _w, ...j }) => j) }))
    .sort((a, b) => Number(b.nightSteps > 0) - Number(a.nightSteps > 0) || Number(a.crew === "") - Number(b.crew === "") || a.crew.localeCompare(b.crew, undefined, { numeric: true }));
}

/** An older job-only setting as crew entries: each crew working under
 *  those jobs, on the jobs its steps are in. */
export function toCrewEntries(milestones: Milestone[], night: string[]): string[] {
  const woCrew = inheritedCrews(milestones);
  const out = new Set<string>();
  const jobs = new Set<string>();
  for (const e of night) { const x = parseEntry(e); if ("crew" in x) out.add(e); else jobs.add(x.job); }
  if (jobs.size === 0) return [...out];
  const byId = new Map<string, Milestone>();
  const parents = new Set<string>();
  for (const m of milestones) { if (m.id) byId.set(m.id, m); if (m.parentId) parents.add(m.parentId); }
  for (const m of milestones) {
    if (!m.id || parents.has(m.id) || !m.parentId) continue;
    let under = false;
    for (let c: Milestone | undefined = m, g = 0; c?.id && g < 60; c = c.parentId ? byId.get(c.parentId) : undefined, g++) if (jobs.has(c.id)) { under = true; break; }
    if (under) out.add(crewEntry(m.responsibleParty?.trim() || woCrew.get(m.id) || "", m.parentId));
  }
  return [...out];
}

// ── By job: the way the setup asks it now ──
// Every job works days. A job the schedule puts in night hours either
// stays on days, or runs days and nights: with all its crews on nights, or
// only some of them. Saved in the same entries: all its crews as the job
// itself ("<jobId>", which also covers crews added to it later), some as
// "crew:<jobId>:<crew>" each.

export interface JobChoice {
  /** The job: each step's own parent (the equipment's task). */
  id: string;
  name: string;
  crumbs: string;
  /** The crews with steps under it, as written ("" = no crew named). */
  crews: string[];
  steps: number;
  /** Steps the schedule file puts in night hours. */
  nightSteps: number;
}

/** The jobs to decide: those the schedule puts in night hours, in the
 *  schedule's order. */
export function nightJobChoices(milestones: Milestone[], isNightStep: (m: Milestone) => boolean): JobChoice[] {
  const woCrew = inheritedCrews(milestones);
  const byId = new Map<string, Milestone>();
  const parents = new Set<string>();
  for (const m of milestones) { if (m.id) byId.set(m.id, m); if (m.parentId) parents.add(m.parentId); }
  const crumbsOf = (m: Milestone) => {
    const out: string[] = [];
    for (let p = m.parentId ? byId.get(m.parentId) : undefined, g = 0; p && g < 60; p = p.parentId ? byId.get(p.parentId) : undefined, g++) out.unshift(p.name);
    return out.join(" › ");
  };
  const jobs = new Map<string, JobChoice & { wbs: string; first: number }>();
  for (const m of milestones) {
    if (!m.id || parents.has(m.id) || !m.parentId) continue;
    const job = byId.get(m.parentId);
    if (!job?.id) continue;
    const j = jobs.get(job.id) ?? { id: job.id, name: job.name, crumbs: crumbsOf(job), crews: [], steps: 0, nightSteps: 0, wbs: job.wbs ?? "", first: Infinity };
    const crew = m.responsibleParty?.trim() || woCrew.get(m.id) || "";
    if (!j.crews.some((c) => norm(c) === norm(crew))) j.crews.push(crew);
    j.steps++;
    if (isNightStep(m)) j.nightSteps++;
    jobs.set(job.id, j);
  }
  return [...jobs.values()]
    .filter((j) => j.nightSteps > 0)
    .sort((a, b) => a.wbs.localeCompare(b.wbs, undefined, { numeric: true }) || a.name.localeCompare(b.name, undefined, { numeric: true }))
    .map(({ wbs: _w, first: _f, ...j }) => ({ ...j, crews: j.crews.sort((a, b) => Number(a === "") - Number(b === "") || a.localeCompare(b, undefined, { numeric: true })) }));
}

/** Each job's crews on nights, from what's saved: "*" for all of them. A
 *  crew saved on nights for all its work counts on every job it has. */
export function jobNightCrews(jobs: JobChoice[], night: string[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const everywhere = new Set<string>();
  const ids = new Set(jobs.map((j) => j.id));
  for (const e of night) {
    const x = parseEntry(e);
    if (!("crew" in x)) { if (ids.has(x.job)) out.set(x.job, new Set(["*"])); continue; }
    if (x.job == null) { everywhere.add(norm(x.crew)); continue; }
    if (!ids.has(x.job)) continue;
    const cur = out.get(x.job) ?? new Set<string>();
    if (!cur.has("*")) cur.add(x.crew);
    out.set(x.job, cur);
  }
  for (const j of jobs) {
    const cur = out.get(j.id);
    if (cur?.has("*")) continue;
    const on = new Set(cur ?? []);
    for (const c of j.crews) if (everywhere.has(norm(c))) on.add(c);
    // Every one of its crews: the job as a whole.
    if (j.crews.length > 0 && j.crews.every((c) => [...on].some((o) => norm(o) === norm(c)))) out.set(j.id, new Set(["*"]));
    else if (on.size) out.set(j.id, on);
  }
  return out;
}

/** The setting to save for each job's night crews. */
export function jobNightEntries(picks: Map<string, Set<string>>): string[] {
  const out: string[] = [];
  for (const [job, crews] of picks) {
    if (crews.has("*")) out.push(job);
    else for (const c of crews) out.push(crewEntry(c, job));
  }
  return out.sort();
}
