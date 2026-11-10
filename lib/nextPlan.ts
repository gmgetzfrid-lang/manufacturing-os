// nextPlan - the schedule suggested for next time, made from this one as
// it was really done (lib/asBuiltWork), and changed by what a person tells
// it ("V-7 is critical, start it as soon as possible", "Ancon has 2 crews on
// nights", a head count typed in).
//
// The rules, said the same way on screen:
//   - This year's activities, links, crews, day / night / both calendars,
//     and planned start dates as the earliest each can start.
//   - Work found this year is in from the start, in the order and on the
//     shifts it was really done.
//   - An activity done inside fewer shifts than its plan gets that length;
//     nothing is made longer from a guess.
//   - Start-up begins once every work order is done.
//   - A crew's hands, when set, limit how much of its work can run at once;
//     work over that waits (the most urgent first).
//
// Pure: no database here.

import type { Milestone } from "@/types/schema";
import type { AsBuilt } from "@/lib/asBuiltSchedule";
import type { AsBuiltWork } from "@/lib/asBuiltWork";
import { shiftAt, nextShift, shiftWindowsBetween, calendarShift, type ShiftTimes, type ShiftWindow } from "@/lib/shiftReport";
import { dayKey, dayKeyToMs } from "@/lib/scheduleTz";

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

const isStartUp = (name: string) => /start\s*-?\s*up/i.test(name);
const isShutdown = (name: string) => /shut\s*-?\s*down/i.test(name);

/** This year's job, made into next time's activities (before any change). */
export function planActivities(input: { built: AsBuilt; work: AsBuiltWork; milestones: Milestone[]; tz: string; times: ShiftTimes }): PlanAct[] {
  const { built, work, tz, times } = input;
  const byId = new Map(input.milestones.filter((m) => m.id).map((m) => [m.id!, m]));
  const all = built.orders.flatMap((o) => o.steps.map((s) => ({ s, o })));
  const ids = new Set(all.map((x) => x.s.id));
  const acts: PlanAct[] = [];
  for (const { s, o } of all) {
    const m = byId.get(s.id); const w = work.steps.get(s.id);
    if (!m || !w) continue;
    const plan = Math.max(0, s.plannedH);
    // The plan's own calendar (06:00-18:00, 24 hours), not this job's
    // night-crew setting: next time's crews are what's being planned.
    let cal: Cal = calendarShift(m, times) ?? (m.shift === "day" ? "day" : m.shift === "night" ? "night" : "both");
    const nightsWorked = w.worked.some((k) => k.endsWith(":night")), daysWorked = w.worked.some((k) => k.endsWith(":day"));
    let hours = plan, kind: ActKind = "same", basis = "";
    if (w.found) {
      kind = "found"; basis = "found this year";
      if (nightsWorked && daysWorked) cal = "both"; else if (nightsWorked) cal = "night"; else if (daysWorked) cal = "day";
    }
    const bound = w.worked.length * 12;
    if (!w.found && w.worked.length && bound < plan) { hours = bound; kind = "shorter"; basis = `done within ${w.worked.length} shift${w.worked.length === 1 ? "" : "s"} this year (plan ${r1(plan)} h)`; }
    let preds = (m.dependsOn ?? []).filter((p) => ids.has(p));
    let floor: number | null = s.inPlan ? s.planStart : null;
    if (w.found) {
      // In the order it was really done: two finds worked side by side stay
      // side by side, whatever link was typed when they were added.
      const a0 = s.start;
      preds = preds.filter((p) => { const q = all.find((x) => x.s.id === p)?.s; return !(q && !q.inPlan && a0 != null && q.finish != null && a0 < q.finish); });
      if (!preds.length) {
        const before = o.steps.filter((x) => x.id !== s.id && x.finish != null && a0 != null && x.finish <= a0).sort((a, b) => (b.finish ?? 0) - (a.finish ?? 0))[0];
        if (before) preds = [before.id]; else floor = a0;
      }
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
export function applyChanges(base: PlanAct[], changes: PlanChange[], tz: string, times: ShiftTimes, day1: number): { acts: PlanAct[]; pre: PlanAct[]; headsSet: Record<string, Record<number, number>> } {
  let acts: PlanAct[] = base.map((a) => ({ ...a, preds: [...a.preds], changedBy: [...(a.changedBy ?? [])] }));
  const pre: PlanAct[] = [];
  const headsSet: Record<string, Record<number, number>> = {};
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
    }
  }
  return { acts, pre, headsSet };
}

/** Schedule the activities: forward through their links and calendars; a
 *  crew with hands set runs only as much at once as they can carry. */
export function schedule(input: {
  acts: PlanAct[]; pre?: PlanAct[]; tz: string; times: ShiftTimes;
  /** Man-hours per plan hour, by crew (1 when not known). */
  pace: Record<string, { mh: number; from: string }>;
  toolHours: { day: number; night: number };
  headsSet?: Record<string, Record<number, number>>;
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

  // Shifts to schedule into (grown as needed).
  const shifts: ShiftWindow[] = shiftWindowsBetween(day1, day1 + 30 * 86_400_000, tz, times, 4000);
  const idxAt = (t: number) => { let lo = 0, hi = shifts.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (shifts[mid].start <= t) lo = mid; else hi = mid - 1; } return lo; };
  const used: Record<string, number[]> = {};
  const occupancy = (s: number, f: number) => {
    const out: Array<[number, number]> = [];
    if (f <= s) return out;
    for (let i = idxAt(s); i < shifts.length && shifts[i].start < f; i++) {
      const ov = (Math.min(f, shifts[i].end) - Math.max(s, shifts[i].start)) / H;
      if (ov > 1e-6) out.push([i, ov]);
    }
    return out;
  };
  const capOf = (crew: string, i: number) => {
    const n = headsSet[crew]?.[i];
    return n == null ? Infinity : (n * toolOf(shifts[i])) / paceOf(crew);
  };

  // Ready list: links first, then the most urgent, then the earliest.
  const done = new Map<string, { start: number; finish: number; held: boolean }>();
  const waiting = new Set(acts.map((a) => a.id));
  const est = (a: PlanAct) => Math.max(a.floor ?? day1, ...a.preds.map((p) => done.get(p)?.finish ?? -Infinity), day1);
  for (let guard = 0; waiting.size && guard < acts.length * 4 + 10; guard++) {
    const ready = [...waiting].map((id) => byId.get(id)!).filter((a) => a.preds.every((p) => done.has(p) || !byId.has(p)));
    if (!ready.length) {
      // A loop in the links: break it at the earliest.
      const a = byId.get([...waiting][0])!; a.preds = a.preds.filter((p) => done.has(p)); continue;
    }
    ready.sort((a, b) => Number(!!b.first) - Number(!!a.first) || est(a) - est(b) || a.name.localeCompare(b.name));
    const a = ready[0];
    let s = snapStart(est(a), a.cal, tz, times), f = advance(s, a.hours, a.cal, tz, times), held = false;
    if (headsSet[a.crew]) {
      for (let g = 0; g < 400; g++) {
        const occ = occupancy(s, f);
        const bad = occ.find(([i, h]) => (used[a.crew]?.[i] ?? 0) + h > capOf(a.crew, i) + 1e-6);
        if (!bad) break;
        held = true;
        s = snapStart(shifts[Math.min(shifts.length - 1, bad[0] + 1)].start, a.cal, tz, times);
        f = advance(s, a.hours, a.cal, tz, times);
      }
    }
    for (const [i, h] of occupancy(s, f)) { (used[a.crew] ??= [])[i] = (used[a.crew][i] ?? 0) + h; }
    done.set(a.id, { start: s, finish: f, held });
    waiting.delete(a.id);
  }

  const out = acts.map((a) => ({ ...a, start: done.get(a.id)?.start ?? day1, finish: done.get(a.id)?.finish ?? day1, heldForCrew: done.get(a.id)?.held ?? false }));
  const finish = out.length ? Math.max(...out.map((a) => a.finish)) : day1;
  const n = Math.max(1, idxAt(finish) + 1);
  const shown = shifts.slice(0, n);
  const load: Record<string, number[]> = {}, jobs: Record<string, number[]> = {};
  for (const a of out) {
    for (const [i, h] of occupancy(a.start, a.finish)) {
      if (i >= n) continue;
      (load[a.crew] ??= Array(n).fill(0))[i] += h;
      (jobs[a.crew] ??= Array(n).fill(0))[i] += 1;
    }
  }
  const heads: Record<string, number[]> = {}, headsShown: Record<string, Array<number | null>> = {};
  for (const [crew, l] of Object.entries(load)) {
    heads[crew] = l.map((h, i) => (h > 0 ? Math.ceil((h * paceOf(crew)) / toolOf(shown[i]) - 1e-9) : 0));
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
    if (!pred.length) {
      // A gap of off-calendar time (a day crew waiting for morning).
      const near = cur.preds.map((p) => outById.get(p)).filter((p): p is (typeof out)[number] => !!p && p.finish <= cur!.start && snapStart(p.finish, cur!.cal, tz, times) >= cur!.start - 60_000);
      if (!near.length) break;
      cur = near.reduce((x, y) => (y.finish > x.finish ? y : x));
      continue;
    }
    cur = pred.reduce((x, y) => (y.finish > x.finish ? y : x));
  }
  return { acts: out, pre: input.pre ?? [], start: day1, finish, driving, shifts: shown, load, jobs, heads, headsSet: headsShown, pace: input.pace };
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

/** The whole thing: this year's job, the changes, scheduled. */
export function nextPlan(input: { built: AsBuilt; work: AsBuiltWork; milestones: Milestone[]; tz: string; times: ShiftTimes; changes: PlanChange[] }): NextPlan {
  const base = planActivities(input);
  const floors = base.map((a) => a.floor).filter((t): t is number => t != null);
  const day1 = floors.length ? shiftAt(Math.min(...floors), input.tz, input.times).start : Date.now();
  const { acts, pre, headsSet } = applyChanges(base, input.changes, input.tz, input.times, day1);
  return schedule({ acts, pre, tz: input.tz, times: input.times, pace: paceOf(input.work), toolHours: input.work.toolHours, headsSet, day1 });
}

/** The one change that pulls the finish in most: running a work order on
 *  the finish path on nights too, or letting it start as soon as its links
 *  allow. Null when neither moves it. */
export function finishLever(input: { built: AsBuilt; work: AsBuiltWork; milestones: Milestone[]; tz: string; times: ShiftTimes; changes: PlanChange[] }, plan: NextPlan): { change: PlanChange; finish: number; savedH: number; acts: number; hours: number } | null {
  const byId = new Map(plan.acts.map((a) => [a.id, a]));
  const orders = [...new Set(plan.driving.map((id) => byId.get(id)?.order).filter((o): o is string => !!o))];
  let best: { change: PlanChange; finish: number; savedH: number; acts: number; hours: number } | null = null;
  const tries: PlanChange[] = [];
  const dayOnes = orders.filter((o) => plan.acts.some((a) => a.order === o && a.cal === "day"));
  if (dayOnes.length) tries.push({ id: "lever:nights", said: "", at: 0, kind: "nights", target: { ids: plan.acts.filter((a) => dayOnes.includes(a.order) && a.cal === "day").map((a) => a.id) }, on: true });
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
