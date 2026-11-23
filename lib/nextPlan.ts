// nextPlan - the schedule suggested for next time, made from this one as
// it was really done (lib/asBuiltWork), and changed by what a person tells
// it ("V-7 is critical, start it as soon as possible", "Ancon has 2 crews on
// nights", a head count typed in).
//
// The rules, said the same way on screen:
//   - This year's activities and crews, in the order they were really done:
//     a link the field didn't wait on gives way to what that work waited
//     on, and a work order's steps done before a step started come first.
//     Planned start dates are the earliest each can start (or when it
//     really started, if sooner).
//   - Nights as this year really ran: a crew that worked a work order on two
//     or more nights works it days and nights; otherwise days, 12-hour
//     shifts. The shutdown and start-up run around the clock. (The night
//     setup is for the live shift report, not this.)
//   - Missed scope added this year is in from the start, in the order and
//     on the shifts it was really done. Work found by inspection is not
//     planned; it shows as a risk with what it would do to the finish.
//   - An activity done inside fewer shifts than its plan gets that length;
//     nothing is made longer from a guess.
//   - Start-up begins once every work order is done.
//   - CREW_RULE: a crew's size is set before the job starts and held for
//     the whole job. Its hands on the tools from its staffing plan's first
//     shifts on this job (days and nights each), else the first meeting it
//     was counted at; with no hands known, the most of its jobs it worked
//     in one shift this year, as jobs at a time. A person's setting
//     replaces it, held the same way. Work over that waits, the ones that
//     hold the finish first; the crew never grows mid-job. Another crew
//     comes only for the whole job, from its first shift.
//
// Pure: no database here.

import type { Milestone } from "@/types/schema";
import type { AsBuilt } from "@/lib/asBuiltSchedule";
import { shiftKey, type AsBuiltWork } from "@/lib/asBuiltWork";
import { shiftAt, nextShift, shiftWindowsBetween, calendarShift, type ShiftTimes, type ShiftWindow } from "@/lib/shiftReport";
import { dayKey, dayKeyToMs } from "@/lib/scheduleTz";
import { discoveryOf, kindOf } from "@/lib/discovery";

export type Cal = "day" | "night" | "both";
export type ActKind = "same" | "shorter" | "found" | "new" | "split" | "changed";

export interface PlanAct {
  id: string;
  name: string;
  /** The work order (as-built order key). */
  order: string;
  crew: string;
  hours: number;
  /** This year's planned hours (null: not in this year's plan). */
  planHours: number | null;
  cal: Cal;
  preds: string[];
  /** Earliest start (this year's planned start, a hold). */
  floor: number | null;
  kind: ActKind;
  /** Why this length or this place, in words ("" for as planned). */
  basis: string;
  /** This year it waited this long for its crew. */
  waitedForCrew: { shifts: number; crew: string; busyOn: string[] } | null;
  /** Done before the shutdown: a booking, materials. No bar. */
  pre?: boolean;
  /** Goes first when its crew is short. */
  first?: boolean;
  /** Set by a change (said in the list of changes). */
  changedBy?: string[];
}

export type Target = { order?: string; ids?: string[] };
export type PlanChange = { id: string; said: string; at: number } & (
  | { kind: "nights"; target: Target; on: boolean }
  | { kind: "asap"; target: Target }
  | { kind: "hours"; actId: string; hours: number }
  | { kind: "add"; name: string; crew: string; hours: number; cal?: Cal; after?: string | null; before?: string | null; pre?: boolean; order?: string | null }
  | { kind: "split"; actId: string; fraction: number; name: string; crew: string; hours: number; cal?: Cal }
  | { kind: "drop"; target: Target }
  | { kind: "hold"; target: Target; day: number }
  | { kind: "first"; target: Target }
  | { kind: "heads"; crew: string; shift: number; n: number }
  // At most n of the crew's activities open at once.
  | { kind: "jobs"; crew: string; n: number }
  // One crew kept the whole event: so many on the tools on days and on
  // nights (null: not held), every shift.
  | { kind: "crew"; crew: string; day: number | null; night: number | null }
  // Another crew (or more) brought for the whole job, from its first shift.
  | { kind: "more"; crew: string; crews: number }
  // A lesson (lib/nextPlanLessons) left out by a person.
  | { kind: "skip"; lesson: string }
  // From the lessons: an activity's length and calendar (off-site time is
  // clock time), links it didn't really need, and its earliest start.
  | { kind: "set"; actId: string; hours?: number; cal?: Cal; basis?: string; kindAs?: ActKind; crew?: string }
  | { kind: "relink"; actId: string; drop: string[]; add: string[] }
  | { kind: "floor"; target: Target; at: number | null }
);

export interface NextPlan {
  acts: Array<PlanAct & { start: number; finish: number; heldForCrew: boolean }>;
  pre: PlanAct[];
  /** Day 1, the first shift's start. */
  start: number;
  finish: number;
  /** What sets the finish, last to first. */
  driving: string[];
  shifts: ShiftWindow[];
  /** Per crew, per shift: hours of its work scheduled, and jobs going. */
  load: Record<string, number[]>;
  jobs: Record<string, number[]>;
  /** Per crew, per shift: hands suggested (from the load and its pace). */
  heads: Record<string, number[]>;
  /** Hands set by a person (null where not set). */
  headsSet: Record<string, Array<number | null>>;
  /** Man-hours per plan hour used for each crew, and where it came from. */
  pace: Record<string, { mh: number; from: string }>;
  /** Crews held to so many jobs at once. */
  jobsCap: Record<string, number>;
  /** Crews kept the whole event: hands on the tools, days and nights. */
  crewSize: Record<string, { day: number | null; night: number | null }>;
  /** Each crew's size, held the whole job, and where it came from
   *  (nextPlan; empty from schedule() alone). */
  sizes: Record<string, CrewSize>;
}

/** The rule, said the same way on screen. */
export const CREW_RULE = "A crew's size is set before the job starts and held for the whole job: its staffing plan's first shifts on this job, else the first shift meeting it was counted at, else the most jobs it worked at once this year. Work that doesn't fit waits for the crew; the crew never grows mid-job. People can be released at the end, once its work runs out.";

/** Where a held count came from: the contractor's staffing plan, or a head
 *  count at a shift meeting; `at` is that shift's start. */
export interface SizeFrom { from: "plan" | "counted"; at: number }

/** A crew's size, set before the job starts and held for the whole job. */
export interface CrewSize {
  /** Hands on the tools every day and every night shift (null: it works
   *  no shifts of that kind). Null when held by jobs at a time. */
  hands: { day: number | null; night: number | null } | null;
  /** Jobs at a time, every shift (null: held by hands). */
  jobs: number | null;
  /** Where it came from: its staffing plan, a head count, the most jobs it
   *  worked at once this year, or a person's setting. */
  from: "plan" | "counted" | "worked" | "person";
  /** For hands: where each came from. */
  first: { day: SizeFrom | null; night: SizeFrom | null };
  /** The most of its jobs it worked in one shift this year (0: none logged). */
  worked: number;
  /** The shift kinds it works in this plan. */
  works: { day: boolean; night: boolean };
  /** Hands it had for a shift kind it works with none for the other, so it
   *  is held by jobs at a time instead ("nights": no count on nights). */
  missing: "day" | "night" | "pace" | null;
  /** Another crew (or more) brought for the whole job. */
  more: number;
  /** Hands one more crew adds on a day and on a night shift (by hands:
   *  one job going a whole shift, at its pace). */
  perCrew: { day: number | null; night: number | null } | null;
  /** Its staffing plan puts more on the tools later than on its first
   *  shift: held at the first count. Each rise over the most before it. */
  ramp: Array<{ kind: "day" | "night"; first: number; firstAt: number; rises: Array<{ at: number; n: number }> }>;
}

const H = 3_600_000;
const r1 = (n: number) => Math.round(n * 10) / 10;
const toMs = (v: unknown): number | null => { const t = v == null || v === "" ? NaN : typeof v === "number" ? v : Date.parse(String(v)); return Number.isFinite(t) ? t : null; };

/** Move `t` forward by `hours` of working time on a calendar. */
export function advance(t: number, hours: number, cal: Cal, tz: string, times: ShiftTimes): number {
  if (hours <= 0) return snapStart(t, cal, tz, times);
  if (cal === "both") return t + hours * H;
  let left = hours * H; let w = shiftAt(t, tz, times); let cur = t;
  for (let g = 0; g < 4000; g++) {
    if (w.kind === cal) {
      const from = Math.max(cur, w.start); const room = w.end - from;
      if (left <= room) return from + left;
      left -= Math.max(0, room);
    }
    w = nextShift(w, tz, times); cur = w.start;
  }
  return cur;
}
/** The first working moment at or after `t`. */
export function snapStart(t: number, cal: Cal, tz: string, times: ShiftTimes): number {
  if (cal === "both") return t;
  let w = shiftAt(t, tz, times);
  for (let g = 0; g < 40; g++) { if (w.kind === cal) return Math.max(t, w.start); w = nextShift(w, tz, times); }
  return t;
}

/** A step that is the trip itself ("Hotshot Exchanger to Redman", "Meter Out
 *  for Service"): clock time away, not crew time. */
export const OFFSITE_STEP = /\b(out for (service|repair|calibration|cal)|hot\s*-?\s*shot|(send|sent|ship|shipped|haul|hauled|truck|trucked)\s+(it\s+)?(out|off|to)\b|to (the )?(shop|vendor)\b|at (the )?(shop|vendor)\b|off[- ]?site)/i;
const isStartUp = (name: string) => /start\s*-?\s*up/i.test(name);
/** The shutdown itself ("Transmix-2 - Shutdown"), not work that needs one
 *  ("Shutdown-Required Inspection ..."). */
const isShutdown = (name: string) => /shut\s*-?\s*down\s*$/i.test(name.trim()) && !/required/i.test(name);

/** How a step runs next time, from how its work order's crew really ran it
 *  this year (null: never worked, the file's calendar). A trip off site and
 *  the shutdown and start-up run on the clock. Two or more nights
 *  is a night crew (the as-built's own rule): days and nights. One night
 *  that finished day work is overtime: days. */
function calOf(orderName: string, stepName: string, ran: { days: Set<string>; nights: Set<string> } | undefined, worked: string[]): Cal | null {
  if (isShutdown(orderName) || isStartUp(orderName) || OFFSITE_STEP.test(stepName)) return "both";
  if (!ran || !(ran.days.size + ran.nights.size)) return null;
  if (ran.nights.size >= 2) return ran.days.size ? "both" : "night";
  if (worked.length && worked.every((k) => k.endsWith(":night"))) return "night";
  return "day";
}

/** Steps found by inspection this year (not missed scope): out of next
 *  time's plan, shown as risks. A step not in the plan with no record of
 *  how it came is counted as found. */
export function discoveryIds(work: AsBuiltWork, milestones: Milestone[]): string[] {
  const byId = new Map(milestones.filter((m) => m.id).map((m) => [m.id!, m]));
  return [...work.steps.values()].filter((w) => { const m = byId.get(w.id); return w.found && !!m && kindOf(discoveryOf(m)) !== "added"; }).map((w) => w.id);
}

/** This year's job, made into next time's activities (before any change). */
export function planActivities(input: { built: AsBuilt; work: AsBuiltWork; milestones: Milestone[]; tz: string; times: ShiftTimes }): PlanAct[] {
  const { built, work, times } = input;
  const byId = new Map(input.milestones.filter((m) => m.id).map((m) => [m.id!, m]));
  const all = built.orders.flatMap((o) => o.steps.map((s) => ({ s, o })));
  // The shifts each work order's crews really worked it on this year.
  const ran = new Map<string, { days: Set<string>; nights: Set<string> }>();
  for (const { s, o } of all) {
    const w = work.steps.get(s.id); if (!w) continue;
    const k = `${o.key}|${w.crew}`; const r = ran.get(k) ?? { days: new Set<string>(), nights: new Set<string>() };
    for (const x of w.worked) (x.endsWith(":night") ? r.nights : r.days).add(x);
    ran.set(k, r);
  }
  const ids = new Set(all.map((x) => x.s.id));
  const stepById = new Map(all.map((x) => [x.s.id, x.s]));
  const fileOf = (id: string) => (byId.get(id)?.dependsOn ?? []).filter((p) => ids.has(p) && p !== id);
  const acts: PlanAct[] = [];
  for (const { s, o } of all) {
    const m = byId.get(s.id); const w = work.steps.get(s.id);
    if (!m || !w) continue;
    const plan = Math.max(0, s.plannedH);
    const cal: Cal = calOf(o.name, s.name, ran.get(`${o.key}|${w.crew}`), w.worked) ?? calendarShift(m, times) ?? (m.shift === "day" ? "day" : m.shift === "night" ? "night" : "both");
    let hours = plan, kind: ActKind = "same", basis = "";
    if (w.found) { kind = "found"; basis = kindOf(discoveryOf(m)) === "added" ? "missed scope, added this year" : "found this year"; }
    const bound = w.worked.length * 12;
    if (!w.found && w.worked.length && bound < plan) { hours = bound; kind = "shorter"; basis = `done within ${w.worked.length} shift${w.worked.length === 1 ? "" : "s"} this year (plan ${r1(plan)} h)`; }
    let preds = fileOf(s.id);
    let floor: number | null = s.inPlan ? s.planStart : null;
    if (s.start != null) {
      // In the order it was really done. A link it waited on stays; one it
      // didn't (that work finished after it started) gives way to what that
      // work waited on; and its work order's steps done before it started
      // come first, linked in the file or not.
      const t = s.start + 60_000;
      const doneBy = (id: string) => { const q = stepById.get(id); return q?.finish != null && q.finish <= t; };
      const kept = new Set<string>(); const seen = new Set<string>();
      const walk = (p: string) => { if (seen.has(p)) return; seen.add(p); if (doneBy(p)) kept.add(p); else for (const q of fileOf(p)) walk(q); };
      for (const p of preds) walk(p);
      for (const x of o.steps) if (x.id !== s.id && x.finish != null && x.finish <= t) kept.add(x.id);
      preds = [...kept];
      // A planned date it started before didn't hold it.
      if (floor != null && s.start < floor) floor = s.start;
      if (!preds.length && floor == null) floor = s.start;
    }
    acts.push({
      id: s.id, name: s.name, order: o.key, crew: w.crew, hours: r1(hours), planHours: s.inPlan ? r1(plan) : null, cal, preds, floor, kind, basis,
      waitedForCrew: w.ready && w.ready.crewLogged ? { shifts: w.ready.shifts.length, crew: w.crew, busyOn: w.ready.busyOn } : null,
    });
  }
  // Start-up waits for every work order to be done.
  const orderName = new Map(built.orders.map((o) => [o.key, o.name]));
  const su = acts.filter((a) => isStartUp(orderName.get(a.order) ?? ""));
  if (su.length) {
    const suIds = new Set(su.map((a) => a.id));
    const succ = new Set(acts.flatMap((a) => a.preds));
    const ends = acts.filter((a) => !suIds.has(a.id) && !isShutdown(orderName.get(a.order) ?? "") && !succ.has(a.id)).map((a) => a.id);
    for (const a of su) if (!a.preds.some((p) => suIds.has(p))) a.preds = [...new Set([...a.preds, ...ends])];
  }
  return acts;
}

const hits = (a: PlanAct, t: Target) => (t.ids?.length ? t.ids.includes(a.id) : false) || (t.order ? a.order === t.order : false);

/** The activities after the changes, and the hands set. */
export function applyChanges(base: PlanAct[], changes: PlanChange[], tz: string, times: ShiftTimes, day1: number): { acts: PlanAct[]; pre: PlanAct[]; headsSet: Record<string, Record<number, number>>; jobsCap: Record<string, number>; crewSize: Record<string, { day: number | null; night: number | null }>; more: Record<string, number> } {
  let acts: PlanAct[] = base.map((a) => ({ ...a, preds: [...a.preds], changedBy: [...(a.changedBy ?? [])] }));
  const pre: PlanAct[] = [];
  const headsSet: Record<string, Record<number, number>> = {};
  const jobsCap: Record<string, number> = {};
  const crewSize: Record<string, { day: number | null; night: number | null }> = {};
  const more: Record<string, number> = {};
  const mark = (a: PlanAct, c: PlanChange) => { a.changedBy = [...new Set([...(a.changedBy ?? []), c.id])]; };
  for (const c of changes) {
    if (c.kind === "drop") {
      const gone = new Set(acts.filter((a) => hits(a, c.target)).map((a) => a.id));
      const predsOf = new Map(acts.filter((a) => gone.has(a.id)).map((a) => [a.id, a.preds]));
      const resolve = (p: string, seen = new Set<string>()): string[] => (gone.has(p) && !seen.has(p) ? (seen.add(p), (predsOf.get(p) ?? []).flatMap((q) => resolve(q, seen))) : [p]);
      acts = acts.filter((a) => !gone.has(a.id));
      for (const a of acts) a.preds = [...new Set(a.preds.flatMap((p) => resolve(p)))].filter((p) => !gone.has(p));
    } else if (c.kind === "hours") {
      const a = acts.find((x) => x.id === c.actId); if (a) { a.hours = Math.max(0, c.hours); a.basis = `set to ${r1(a.hours)} h`; a.kind = a.kind === "same" || a.kind === "shorter" ? "changed" : a.kind; mark(a, c); }
    } else if (c.kind === "nights") {
      for (const a of acts) if (hits(a, c.target)) {
        if (c.on && a.cal === "day") { a.cal = "both"; mark(a, c); }
        if (!c.on && a.cal !== "day") { a.cal = "day"; mark(a, c); }
      }
    } else if (c.kind === "asap") {
      for (const a of acts) if (hits(a, c.target) && a.floor != null) { a.floor = null; mark(a, c); }
    } else if (c.kind === "hold") {
      const k = dayKey(day1, tz);
      const at = dayKeyToMs(k, tz) + (Math.max(1, Math.round(c.day)) - 1) * 86_400_000;
      const w = shiftAt(at + 12 * H, tz, times);
      for (const a of acts) if (hits(a, c.target)) { a.floor = Math.max(a.floor ?? 0, w.kind === "day" ? w.start : at); mark(a, c); }
    } else if (c.kind === "first") {
      for (const a of acts) if (hits(a, c.target)) { a.first = true; mark(a, c); }
    } else if (c.kind === "add") {
      const a: PlanAct = { id: `add:${c.id}`, name: c.name, order: c.order ?? acts.find((x) => x.id === c.after || x.id === c.before)?.order ?? "", crew: c.crew || "Not set", hours: Math.max(0, c.hours), planHours: null, cal: c.cal ?? "both", preds: c.after ? [c.after] : [], floor: null, kind: "new", basis: c.said ? `from: ${c.said}` : "", waitedForCrew: null, changedBy: [c.id], pre: !!c.pre };
      if (c.pre) { pre.push(a); continue; }
      if (c.before) { const b = acts.find((x) => x.id === c.before); if (b) { b.preds = [...b.preds.filter((p) => p !== c.after), a.id]; } }
      acts.push(a);
    } else if (c.kind === "split") {
      const i = acts.findIndex((x) => x.id === c.actId); if (i < 0) continue;
      const a = acts[i]; const f = Math.min(0.95, Math.max(0.05, c.fraction));
      const one: PlanAct = { ...a, id: `${a.id}:1`, name: `${a.name} (1 of 2)`, hours: r1(a.hours * f), kind: "split", basis: `split around: ${c.name}`, changedBy: [...(a.changedBy ?? []), c.id] };
      const mid: PlanAct = { id: `${a.id}:w`, name: c.name, order: a.order, crew: c.crew || "Not set", hours: Math.max(0, c.hours), planHours: null, cal: c.cal ?? "both", preds: [one.id], floor: null, kind: "new", basis: c.said ? `from: ${c.said}` : "", waitedForCrew: null, changedBy: [c.id] };
      const two: PlanAct = { ...a, id: `${a.id}:2`, name: `${a.name} (2 of 2)`, hours: r1(a.hours - one.hours), preds: [mid.id], floor: null, kind: "split", basis: `split around: ${c.name}`, waitedForCrew: null, changedBy: [...(a.changedBy ?? []), c.id] };
      acts.splice(i, 1, one, mid, two);
      for (const x of acts) if (x.preds.includes(a.id)) x.preds = x.preds.map((p) => (p === a.id ? two.id : p));
    } else if (c.kind === "heads") {
      (headsSet[c.crew] ??= {})[c.shift] = Math.max(0, Math.round(c.n));
    } else if (c.kind === "crew") {
      if (c.day == null && c.night == null) delete crewSize[c.crew];
      else crewSize[c.crew] = { day: c.day == null ? null : Math.max(1, Math.round(c.day)), night: c.night == null ? null : Math.max(1, Math.round(c.night)) };
    } else if (c.kind === "jobs") {
      if (c.n >= 1) jobsCap[c.crew] = Math.round(c.n); else delete jobsCap[c.crew];
    } else if (c.kind === "more") {
      const n = (more[c.crew] ?? 0) + Math.max(0, Math.round(c.crews));
      if (n > 0) more[c.crew] = n; else delete more[c.crew];
    } else if (c.kind === "set") {
      const a = acts.find((x) => x.id === c.actId);
      if (a) {
        if (c.hours != null) a.hours = Math.max(0, r1(c.hours));
        if (c.cal) a.cal = c.cal;
        if (c.crew) a.crew = c.crew;
        if (c.basis != null) a.basis = c.basis;
        if (c.kindAs) a.kind = c.kindAs;
        mark(a, c);
      }
    } else if (c.kind === "relink") {
      const a = acts.find((x) => x.id === c.actId);
      // A link to a step since split is to its parts (":1", ":2").
      if (a) { a.preds = [...new Set([...a.preds.filter((p) => !c.drop.includes(p) && !c.drop.includes(p.replace(/:(1|2|w)$/, ""))), ...c.add.filter((p) => p !== a.id && acts.some((x) => x.id === p))])]; mark(a, c); }
    } else if (c.kind === "floor") {
      for (const a of acts) if (hits(a, c.target)) { a.floor = c.at; mark(a, c); }
    }
  }
  return { acts, pre, headsSet, jobsCap, crewSize, more };
}

/** Schedule the activities: forward through their links and calendars; a
 *  crew with hands set runs only as much at once as they can carry. */
export function schedule(input: {
  acts: PlanAct[]; pre?: PlanAct[]; tz: string; times: ShiftTimes;
  /** Man-hours per plan hour, by crew (1 when not known). */
  pace: Record<string, { mh: number; from: string }>;
  toolHours: { day: number; night: number };
  headsSet?: Record<string, Record<number, number>>;
  /** At most so many of a crew's activities open at once. */
  jobsCap?: Record<string, number>;
  /** A crew kept the whole event, days and nights. */
  crewSize?: Record<string, { day: number | null; night: number | null }>;
  day1?: number;
}): NextPlan {
  const { tz, times } = input;
  const acts = input.acts;
  const byId = new Map(acts.map((a) => [a.id, a]));
  const floors = acts.map((a) => a.floor).filter((t): t is number => t != null);
  const start0 = input.day1 ?? (floors.length ? Math.min(...floors) : Date.now());
  const first = shiftAt(start0, tz, times);
  const day1 = first.start;
  const toolOf = (w: ShiftWindow) => (w.kind === "night" ? input.toolHours.night : input.toolHours.day);
  const paceOf = (crew: string) => input.pace[crew]?.mh ?? 1;
  const headsSet = input.headsSet ?? {};
  const jobsCap = input.jobsCap ?? {};
  const crewSize = input.crewSize ?? {};

  // Shifts to schedule into (grown as needed).
  const shifts: ShiftWindow[] = shiftWindowsBetween(day1, day1 + 30 * 86_400_000, tz, times, 4000);
  const idxAt = (t: number) => { let lo = 0, hi = shifts.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (shifts[mid].start <= t) lo = mid; else hi = mid - 1; } return lo; };
  /** Hours of an activity in each shift it works: only shifts on its own
   *  calendar (day work left open overnight is not night work). */
  const occupancy = (s: number, f: number, cal: Cal) => {
    const out: Array<[number, number]> = [];
    if (f <= s) return out;
    for (let i = idxAt(s); i < shifts.length && shifts[i].start < f; i++) {
      if (cal !== "both" && shifts[i].kind !== cal) continue;
      const ov = (Math.min(f, shifts[i].end) - Math.max(s, shifts[i].start)) / H;
      if (ov > 1e-6) out.push([i, ov]);
    }
    return out;
  };
  const capOf = (crew: string, i: number) => {
    const n = headsSet[crew]?.[i] ?? crewSize[crew]?.[shifts[i].kind === "night" ? "night" : "day"] ?? null;
    return n == null ? Infinity : (n * toolOf(shifts[i])) / paceOf(crew);
  };
  /** The first moment in [s, f) the crew already has `cap` jobs open, and
   *  when the first of those ends; null when it never does. */
  const crowded = (spans: Array<[number, number]>, s: number, f: number, cap: number): number | null => {
    const near = spans.filter(([a, b]) => a < f && b > s);
    if (near.length < cap) return null;
    const points = [s, ...near.map(([a]) => a).filter((a) => a > s && a < f)].sort((x, y) => x - y);
    for (const t of points) {
      const open = near.filter(([a, b]) => a <= t && b > t);
      if (open.length >= cap) return Math.min(...open.map(([, b]) => b));
    }
    return null;
  };

  // One pass: links first, then (when crews are limited) the most urgent,
  // then the earliest.
  const pass = (urgency: Map<string, number> | null) => {
    const used: Record<string, number[]> = {};
    const spans: Record<string, Array<[number, number]>> = {};
    const done = new Map<string, { start: number; finish: number; held: boolean }>();
    const waiting = new Set(acts.map((a) => a.id));
    const preds = new Map(acts.map((a) => [a.id, [...a.preds]]));
    const est = (a: PlanAct) => Math.max(a.floor ?? day1, ...(preds.get(a.id) ?? []).map((p) => done.get(p)?.finish ?? -Infinity), day1);
    for (let guard = 0; waiting.size && guard < acts.length * 4 + 10; guard++) {
      const ready = [...waiting].map((id) => byId.get(id)!).filter((a) => (preds.get(a.id) ?? []).every((p) => done.has(p) || !byId.has(p)));
      if (!ready.length) {
        // A loop in the links: break it at the earliest.
        const id = [...waiting][0]; preds.set(id, (preds.get(id) ?? []).filter((p) => done.has(p))); continue;
      }
      ready.sort((a, b) => Number(!!b.first) - Number(!!a.first) || (urgency ? (urgency.get(a.id) ?? 0) - (urgency.get(b.id) ?? 0) : 0) || est(a) - est(b) || a.name.localeCompare(b.name));
      const a = ready[0];
      let s = snapStart(est(a), a.cal, tz, times), f = advance(s, a.hours, a.cal, tz, times), held = false;
      const cap = jobsCap[a.crew];
      const hands = !!(headsSet[a.crew] || crewSize[a.crew]);
      if (hands || cap) {
        for (let g = 0; g < 600; g++) {
          let next: number | null = null;
          if (hands) {
            // A shift with none of the crew's work yet always takes one job.
            const bad = occupancy(s, f, a.cal).find(([i, h]) => (used[a.crew]?.[i] ?? 0) > 1e-6 && (used[a.crew]?.[i] ?? 0) + h > capOf(a.crew, i) + 1e-6);
            if (bad) next = shifts[Math.min(shifts.length - 1, bad[0] + 1)].start;
          }
          if (next == null && cap && a.hours > 0) next = crowded(spans[a.crew] ?? [], s, f, cap);
          if (next == null || next <= s) break;
          held = true;
          s = snapStart(next, a.cal, tz, times);
          f = advance(s, a.hours, a.cal, tz, times);
        }
      }
      for (const [i, h] of occupancy(s, f, a.cal)) { (used[a.crew] ??= [])[i] = (used[a.crew][i] ?? 0) + h; }
      if (a.hours > 0) (spans[a.crew] ??= []).push([s, f]);
      done.set(a.id, { start: s, finish: f, held });
      waiting.delete(a.id);
    }
    return done;
  };
  let done = pass(null);
  if (Object.keys(jobsCap).length || Object.keys(headsSet).length || Object.keys(crewSize).length) {
    // The latest each can start without moving the finish, from the first
    // pass: the ones with the least room go first when a crew is short.
    const end = Math.max(...[...done.values()].map((d) => d.finish));
    const succ = new Map<string, string[]>();
    for (const a of acts) for (const p of a.preds) succ.set(p, [...(succ.get(p) ?? []), a.id]);
    const late = new Map<string, number>();
    const lateStart = (id: string, seen = new Set<string>()): number => {
      const k = late.get(id); if (k != null) return k;
      if (seen.has(id)) return end;
      seen.add(id);
      const d = done.get(id)!; const dur = d.finish - d.start;
      const lf = Math.min(end, ...(succ.get(id) ?? []).filter((x) => done.has(x)).map((x) => lateStart(x, seen)));
      const v = lf - dur; late.set(id, v); return v;
    };
    for (const a of acts) if (done.has(a.id)) lateStart(a.id);
    done = pass(late);
  }

  const out = acts.map((a) => ({ ...a, start: done.get(a.id)?.start ?? day1, finish: done.get(a.id)?.finish ?? day1, heldForCrew: done.get(a.id)?.held ?? false }));
  const finish = out.length ? Math.max(...out.map((a) => a.finish)) : day1;
  const n = Math.max(1, idxAt(finish) + 1);
  const shown = shifts.slice(0, n);
  // Per crew, per shift: hours of its work, and the most of its jobs going
  // at one moment in that shift (on their own calendars).
  const load: Record<string, number[]> = {}, jobs: Record<string, number[]> = {};
  const within: Record<string, Array<Array<{ start: number; finish: number }>>> = {};
  for (const a of out) {
    for (const [i, h] of occupancy(a.start, a.finish, a.cal)) {
      if (i >= n) continue;
      (load[a.crew] ??= Array(n).fill(0))[i] += h;
      ((within[a.crew] ??= Array.from({ length: n }, () => []))[i]).push({ start: Math.max(a.start, shown[i].start), finish: Math.min(a.finish, shown[i].end) });
    }
  }
  for (const [crew, xs] of Object.entries(within)) jobs[crew] = xs.map((x) => mostAtOnce(x));
  // Hands the work takes each shift, at the crew's pace; never more than a
  // crew held by hands has (a job bigger than the crew gets all of them).
  const heads: Record<string, number[]> = {}, headsShown: Record<string, Array<number | null>> = {};
  for (const [crew, l] of Object.entries(load)) {
    heads[crew] = l.map((h, i) => {
      if (!(h > 0)) return 0;
      const need = Math.ceil((h * paceOf(crew)) / toolOf(shown[i]) - 1e-9);
      const size = headsSet[crew]?.[i] ?? crewSize[crew]?.[shown[i].kind === "night" ? "night" : "day"] ?? null;
      return size == null ? need : Math.min(need, size);
    });
    headsShown[crew] = l.map((_, i) => headsSet[crew]?.[i] ?? null);
  }

  // What sets the finish: back from the last activity through whatever held
  // each one (the link that finished last; a crew; its earliest start).
  const driving: string[] = [];
  let cur = out.reduce((x, y) => (y.finish > x.finish ? y : x), out[0]);
  const outById = new Map(out.map((a) => [a.id, a]));
  for (let g = 0; cur && g < out.length; g++) {
    driving.push(cur.id);
    const pred = cur.preds.map((p) => outById.get(p)).filter((p): p is (typeof out)[number] => !!p && Math.abs(p.finish - cur!.start) < 60_000 + 1);
    if (!pred.length && cur.heldForCrew) {
      // Held for its crew: the job of the same crew that freed it.
      const freed = out.filter((x) => x.id !== cur!.id && x.crew === cur!.crew && Math.abs(snapStart(x.finish, cur!.cal, tz, times) - cur!.start) < 60_000 + 1 && !driving.includes(x.id));
      if (freed.length) { cur = freed.reduce((x, y) => (y.finish > x.finish ? y : x)); continue; }
    }
    if (!pred.length) {
      // A gap of off-calendar time (a day crew waiting for morning).
      const near = cur.preds.map((p) => outById.get(p)).filter((p): p is (typeof out)[number] => !!p && p.finish <= cur!.start && snapStart(p.finish, cur!.cal, tz, times) >= cur!.start - 60_000);
      if (!near.length) break;
      cur = near.reduce((x, y) => (y.finish > x.finish ? y : x));
      continue;
    }
    cur = pred.reduce((x, y) => (y.finish > x.finish ? y : x));
  }
  return { acts: out, pre: input.pre ?? [], start: day1, finish, driving, shifts: shown, load, jobs, heads, headsSet: headsShown, pace: input.pace, jobsCap, crewSize, sizes: {} };
}

/** The most intervals open at one moment. */
export function mostAtOnce(acts: Array<{ start: number; finish: number }>): number {
  const ev: Array<[number, number]> = [];
  for (const a of acts) if (a.finish > a.start) { ev.push([a.start, 1]); ev.push([a.finish, -1]); }
  ev.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  let n = 0, best = 0;
  for (const [, d] of ev) { n += d; best = Math.max(best, n); }
  return best;
}

/** Man-hours per plan hour for each crew, from what this year showed. */
export function paceOf(work: AsBuiltWork): Record<string, { mh: number; from: string }> {
  const out: Record<string, { mh: number; from: string }> = {};
  for (const c of work.crews) {
    if (!c.pace) continue;
    out[c.crew] = { mh: c.pace.mhPerPlanH, from: c.pace.from === "plan" ? `its staffing plan against the work it finished (${c.pace.shifts} shifts)` : c.pace.from === "counted" ? `its counts against the work it finished (${c.pace.shifts} counted shifts)` : `hands per job going (${c.pace.shifts} counted shift${c.pace.shifts === 1 ? "" : "s"})` };
  }
  return out;
}

export type PlanInput = { built: AsBuilt; work: AsBuiltWork; milestones: Milestone[]; tz: string; times: ShiftTimes; changes: PlanChange[]; withFound?: boolean };

/** Not a crew: time off site, and steps with no crew named. */
const NOT_A_CREW = new Set(["Off site", "Not set"]);

/** Each crew's size by default (CREW_RULE), for the activities it has in
 *  the plan: hands on the tools from its staffing plan's first shifts on
 *  this job, else the first meeting it was counted at, days and nights each,
 *  when its pace is known and every shift kind it works has a count; else
 *  the most of its jobs it worked in one shift this year, as jobs at a time. */
export function crewSizes(work: AsBuiltWork, acts: PlanAct[]): Record<string, CrewSize> {
  const keys = work.shifts.map(shiftKey);
  const startOf = new Map(work.shifts.map((w) => [shiftKey(w), w.start]));
  const pace = paceOf(work);
  // The most of each crew's steps moved in one shift this year.
  const moved = new Map<string, Map<string, number>>();
  for (const w of work.steps.values()) for (const k of w.worked) {
    const m = moved.get(w.crew) ?? new Map<string, number>(); m.set(k, (m.get(k) ?? 0) + 1); moved.set(w.crew, m);
  }
  const recs = new Map(work.crews.map((c) => [c.crew, c]));
  const names = [...new Set(acts.filter((a) => a.hours > 0 && !NOT_A_CREW.has(a.crew)).map((a) => a.crew))];
  // A company's staffing plan read for two or more of this job's crews is
  // the company's, not any one crew's: those crews go by their counts.
  const planned = (crew: string) => Object.values(recs.get(crew)?.byShift ?? {}).some((x) => (x.planned?.direct ?? 0) > 0);
  const byCompany = new Map<string, number>();
  for (const crew of names) if (planned(crew)) { const co = recs.get(crew)!.company; byCompany.set(co, (byCompany.get(co) ?? 0) + 1); }
  // A shift's length (12 h), for what one more crew is.
  const lenOf = (kind: "day" | "night") => { const w = work.shifts.find((x) => x.kind === kind); return w ? (w.end - w.start) / H : 12; };
  const out: Record<string, CrewSize> = {};
  for (const crew of names) {
    const mine = acts.filter((a) => a.crew === crew && a.hours > 0);
    const works = { day: mine.some((a) => a.cal !== "night"), night: mine.some((a) => a.cal !== "day") };
    const r = recs.get(crew);
    // 0: no shift with its progress logged this year (held to one job at a time).
    const worked = Math.max(0, ...(moved.get(crew)?.values() ?? []));
    const shared = !!r && (byCompany.get(r.company) ?? 0) > 1;
    const firstOf = (kind: "day" | "night", get: (x: AsBuiltWork["crews"][number]["byShift"][string]) => number | null | undefined) => {
      for (const k of keys) {
        if (!k.endsWith(`:${kind}`)) continue;
        const x = r?.byShift[k]; const n = x ? get(x) : null;
        if (n != null && n > 0) return { n: Math.round(n), key: k };
      }
      return null;
    };
    const pc = pace[crew]?.mh;
    const perCrew = pc ? { day: works.day ? Math.max(1, Math.ceil((lenOf("day") * pc) / work.toolHours.day - 1e-9)) : null, night: works.night ? Math.max(1, Math.ceil((lenOf("night") * pc) / work.toolHours.night - 1e-9)) : null } : null;
    const hands: { day: number | null; night: number | null } = { day: null, night: null };
    const first: CrewSize["first"] = { day: null, night: null };
    const ramp: CrewSize["ramp"] = [];
    let missing: CrewSize["missing"] = pc ? null : "pace";
    for (const kind of ["day", "night"] as const) {
      if (!works[kind]) continue;
      const p = shared ? null : firstOf(kind, (x) => x.planned?.direct);
      const got = p ?? firstOf(kind, (x) => x.counted?.direct ?? x.counted?.total);
      if (!got) { missing ??= kind; continue; }
      hands[kind] = got.n;
      first[kind] = { from: p ? "plan" : "counted", at: startOf.get(got.key)! };
      if (p) {
        // A staffing plan that adds people after its first shift.
        let top = p.n; const rises: Array<{ at: number; n: number }> = [];
        for (const k of keys.slice(keys.indexOf(p.key) + 1)) {
          if (!k.endsWith(`:${kind}`)) continue;
          const n = Math.round(r?.byShift[k]?.planned?.direct ?? 0);
          if (n > top) { rises.push({ at: startOf.get(k)!, n: n - top }); top = n; }
        }
        if (rises.length) ramp.push({ kind, first: p.n, firstAt: startOf.get(p.key)!, rises });
      }
    }
    const byHands = !missing && (hands.day != null || hands.night != null);
    out[crew] = byHands
      ? { hands, jobs: null, from: first.day?.from === "plan" || first.night?.from === "plan" ? "plan" : "counted", first, worked, works, missing: null, more: 0, perCrew, ramp }
      : { hands: null, jobs: Math.max(1, worked), from: "worked", first: { day: null, night: null }, worked, works, missing: hands.day != null || hands.night != null ? missing : null, more: 0, perCrew, ramp: [] };
  }
  return out;
}

/** The sizes held: a person's setting over the default (held the same
 *  way, the whole job), then any crew brought for the whole job. */
export function holdCrews(defaults: Record<string, CrewSize>, set: { jobsCap: Record<string, number>; crewSize: Record<string, { day: number | null; night: number | null }>; more: Record<string, number> }): Record<string, CrewSize> {
  const out: Record<string, CrewSize> = {};
  const none: CrewSize = { hands: null, jobs: null, from: "person", first: { day: null, night: null }, worked: 1, works: { day: true, night: true }, missing: null, more: 0, perCrew: null, ramp: [] };
  for (const crew of new Set([...Object.keys(defaults), ...Object.keys(set.jobsCap), ...Object.keys(set.crewSize)])) {
    const d = defaults[crew] ?? none;
    let s: CrewSize;
    if (set.crewSize[crew]) {
      // Hands typed in: a shift kind it works left out keeps the default's
      // hands; with none there, it is held to its jobs at a time as well.
      const c = set.crewSize[crew];
      const day = d.works.day ? c.day ?? d.hands?.day ?? null : null, night = d.works.night ? c.night ?? d.hands?.night ?? null : null;
      const gap = (d.works.day && day == null) || (d.works.night && night == null);
      s = { ...d, from: "person", hands: { day, night }, jobs: gap ? d.jobs ?? Math.max(1, d.worked) : null, first: { day: c.day != null ? null : d.first.day, night: c.night != null ? null : d.first.night }, missing: null, ramp: [] };
    } else if (set.jobsCap[crew]) {
      s = { ...d, from: "person", hands: null, jobs: set.jobsCap[crew], first: { day: null, night: null }, missing: null, ramp: [] };
    } else s = { ...d };
    const more = set.more[crew] ?? 0;
    if (more > 0) {
      s.more = more;
      if (s.hands) s.hands = { day: s.hands.day != null ? s.hands.day + more * (s.perCrew?.day ?? 0) : null, night: s.hands.night != null ? s.hands.night + more * (s.perCrew?.night ?? 0) : null };
      if (s.jobs != null) s.jobs += more;
    }
    out[crew] = s;
  }
  return out;
}

/** The whole thing: this year's job, the changes, scheduled. Work found by
 *  inspection is left out unless `withFound`. Every crew is held at its
 *  size for the whole job (CREW_RULE). */
export function nextPlan(input: PlanInput): NextPlan {
  const base = planActivities(input);
  const floors = base.map((a) => a.floor).filter((t): t is number => t != null);
  const day1 = floors.length ? shiftAt(Math.min(...floors), input.tz, input.times).start : Date.now();
  const out = input.withFound ? [] : discoveryIds(input.work, input.milestones);
  const found: PlanChange[] = out.length ? [{ id: "found:out", said: "", at: 0, kind: "drop", target: { ids: out } }] : [];
  const { acts, pre, headsSet, jobsCap, crewSize, more } = applyChanges(base, [...found, ...input.changes], input.tz, input.times, day1);
  const sizes = holdCrews(crewSizes(input.work, acts), { jobsCap, crewSize, more });
  const caps: Record<string, number> = {}, hands: Record<string, { day: number | null; night: number | null }> = {};
  for (const [crew, s] of Object.entries(sizes)) { if (s.jobs != null) caps[crew] = s.jobs; if (s.hands) hands[crew] = s.hands; }
  return { ...schedule({ acts, pre, tz: input.tz, times: input.times, pace: paceOf(input.work), toolHours: input.work.toolHours, headsSet, jobsCap: caps, crewSize: hands, day1 }), sizes };
}

/** A staffing plan that adds people mid-job, in words; null when it doesn't.
 *  `dayOf`: Day N of the plan for a time; `days`: the job's length. */
export function rampWarning(co: string, s: CrewSize, dayOf: (t: number) => number, days: number): string | null {
  if (!s.ramp.length || !s.hands) return null;
  const both = s.hands.day != null && s.hands.night != null;
  const parts = s.ramp.map((r) => r.rises.map((x, i) => `${x.n}${i ? " more" : " on the tools"} on Day ${dayOf(x.at)}`).join(" and ") + (both ? ` (${r.kind} shift)` : ""));
  const job = days <= 4 ? `a ${days}-day job` : Math.round(days / 7) <= 1 ? "a one-week job" : Math.round(days / 7) === 2 ? "a two-week job" : `a ${Math.round(days / 7)}-week job`;
  const firsts = [s.first.day, s.first.night].filter((x): x is SizeFrom => !!x);
  const sameDay = firsts.length && firsts.every((x) => dayOf(x.at) === dayOf(firsts[0].at));
  // The first-shift counts held (before any crew brought for the whole job).
  const held = (k: "day" | "night") => (s.hands![k] == null ? null : s.hands![k]! - s.more * (s.perCrew?.[k] ?? 0));
  const counts = both ? `${held("day")} on days, ${held("night")} on nights` : String(held("day") ?? held("night"));
  return `${co}'s staffing plan adds ${parts.join(", and ")}. People can't be found mid-job on ${job}: this schedule holds ${co} at its ${sameDay ? `Day ${dayOf(firsts[0].at)}` : "first-shift"} count (${counts}).`;
}

/** Crews with a night shift on site in this plan: nights too for their
 *  day work adds no one (CREW_RULE). */
export function nightCrews(plan: Pick<NextPlan, "acts">): Set<string> {
  return new Set(plan.acts.filter((a) => a.hours > 0 && a.cal !== "day" && !NOT_A_CREW.has(a.crew)).map((a) => a.crew));
}

/** The one change that pulls the finish in most: running a work order on
 *  the finish path on nights too (by crews already on nights), or letting it
 *  start as soon as its links allow. Null when neither moves it. */
export function finishLever(input: { built: AsBuilt; work: AsBuiltWork; milestones: Milestone[]; tz: string; times: ShiftTimes; changes: PlanChange[] }, plan: NextPlan): { change: PlanChange; finish: number; savedH: number; acts: number; hours: number } | null {
  const byId = new Map(plan.acts.map((a) => [a.id, a]));
  const orders = [...new Set(plan.driving.map((id) => byId.get(id)?.order).filter((o): o is string => !!o))];
  let best: { change: PlanChange; finish: number; savedH: number; acts: number; hours: number } | null = null;
  const tries: PlanChange[] = [];
  const nights = nightCrews(plan);
  const dayWork = plan.acts.filter((a) => orders.includes(a.order) && a.cal === "day" && nights.has(a.crew));
  if (dayWork.length) tries.push({ id: "lever:nights", said: "", at: 0, kind: "nights", target: { ids: dayWork.map((a) => a.id) }, on: true });
  for (const o of orders) tries.push({ id: `lever:asap:${o}`, said: "", at: 0, kind: "asap", target: { order: o } });
  for (const t of tries) {
    const p = nextPlan({ ...input, changes: [...input.changes, t] });
    const saved = (plan.finish - p.finish) / H;
    if (saved > 0.5 && (!best || saved > best.savedH)) {
      const ids = new Set(p.acts.filter((a) => a.changedBy?.includes(t.id)).map((a) => a.id));
      best = { change: t, finish: p.finish, savedH: r1(saved), acts: ids.size, hours: r1(p.acts.filter((a) => ids.has(a.id)).reduce((n, a) => n + a.hours, 0)) };
    }
  }
  return best;
}

/** Day N of the plan for a time (Day 1 = the first shift's day). */
export function dayNumber(plan: Pick<NextPlan, "start">, t: number, tz: string): number {
  return Math.round((dayKeyToMs(dayKey(t, tz), tz) - dayKeyToMs(dayKey(plan.start, tz), tz)) / 86_400_000) + 1;
}
export { toMs as _toMs };

/** An activity's working time, one piece per shift it works (a day-shift
 *  job is never drawn through the night; round the clock breaks at each
 *  shift change). */
export function shiftParts(a: { start: number; finish: number; cal: "day" | "night" | "both" }, shifts: Array<{ start: number; end: number; kind: string }>): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const w of shifts) {
    if (w.end <= a.start || w.start >= a.finish) continue;
    if (a.cal !== "both" && w.kind !== a.cal) continue;
    const s0 = Math.max(a.start, w.start), s1 = Math.min(a.finish, w.end);
    if (s1 > s0) out.push([s0, s1]);
  }
  return out.length ? out : [[a.start, Math.max(a.finish, a.start + 60_000)]];
}
