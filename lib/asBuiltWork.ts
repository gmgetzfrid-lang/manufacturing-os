// asBuiltWork - the job as it was really worked, shift by shift, from what
// was already entered: each progress update at the time it was set for
// (not when it was typed), the comments and holds, and the head counts
// taken at the shift meetings.
//
//   - Worked: a shift in which a step's progress moved (or it started or
//     finished). Nothing else counts as work.
//   - Waiting, in progress: a shift between a step's first and last worked
//     shifts with nothing logged on it. The reason is its own comments up to
//     the end of the wait.
//   - Waiting to start: everything before a step was done (and its planned
//     start had come), but it didn't start: whole shifts until it did, and
//     what its crew was moving instead.
//   - A work order is worked in a shift when any of its steps moved; it
//     waits when one of its steps waited and none moved.
//   - Hands: counted at the meeting where counted, a contractor's staffing
//     plan where one was read; the work they moved is plan hours of
//     progress. Never a number that wasn't entered.
//
// Pure: no database here.

import type { Milestone, MilestoneNote } from "@/types/schema";
import type { AsBuilt } from "@/lib/asBuiltSchedule";
import type { ProgressLogRow } from "@/lib/progressHistory";
import type { ShiftRecord } from "@/lib/shiftRecord";
import { shiftAt, shiftWindowsBetween, nextShift, type ShiftTimes, type ShiftWindow } from "@/lib/shiftReport";
import type { StaffingPlans } from "@/lib/staffingPlan";

const toMs = (v: unknown): number | null => { const t = v == null || v === "" ? NaN : typeof v === "number" ? v : Date.parse(String(v)); return Number.isFinite(t) ? t : null; };
export const shiftKey = (w: Pick<ShiftWindow, "dayKey" | "kind">) => `${w.dayKey}:${w.kind}`;

export interface WaitRun { from: string; to: string; shifts: number; why: string[] }
export interface StepWork {
  id: string;
  crew: string;
  /** Shift keys where it moved, in order. */
  worked: string[];
  /** Progress moved in each worked shift (percent points). */
  moved: Record<string, number>;
  /** Plan hours of progress made in each worked shift. */
  earned: Record<string, number>;
  /** In progress with nothing logged. */
  waits: WaitRun[];
  /** Ready to start but not started. */
  ready: { at: number; shifts: string[]; busyOn: string[]; crewLogged: boolean } | null;
  found: boolean;
}
export interface CrewShift {
  /** Steps it moved this shift. */
  moved: number;
  /** Plan hours of progress it made. */
  earned: number;
  counted: { total: number | null; direct: number | null; indirect: number | null } | null;
  planned: { direct: number; indirect: number } | null;
  /** Work moved per hand against its job average. */
  verdict: "ok" | "low" | "high" | null;
}
export interface CrewWork {
  crew: string;
  company: string;
  byShift: Record<string, CrewShift>;
  /** Most steps it moved in one shift. */
  mostMoved: number;
  /** Man-hours for each plan hour of work it finished: what sizes it next
   *  time. From its staffing plan, its counts, or hands per job. */
  pace: { mhPerPlanH: number; from: "plan" | "counted" | "per job"; shifts: number } | null;
  /** Work moved per hand per shift, on average (for the verdicts). */
  perHand: number | null;
}
export interface AsBuiltWork {
  shifts: ShiftWindow[];
  steps: Map<string, StepWork>;
  orders: Map<string, { cells: Array<"work" | "wait" | null>; worked: number; waited: number }>;
  crews: CrewWork[];
  totals: { waitedSteps: number; waitedShifts: number; readySteps: number; readyShifts: number; countedShifts: number };
  /** Hours on the tools in a shift: its length less breaks and the first
   *  hour (start of shift, permitting). */
  toolHours: { day: number; night: number };
}

/** A comment that only repeats what the numbers say. */
const NOISE = /^(progress\s*[→>-]|actual times corrected|started$|done$|marked |status )/i;

export function toolHoursOf(times: ShiftTimes): { day: number; night: number } {
  const len = (a: string, b: string) => {
    const m = (s: string) => { const [h, mm] = s.split(":").map(Number); return (h || 0) * 60 + (mm || 0); };
    const d = (m(b) - m(a) + 1440) % 1440; return d === 0 ? 12 : d / 60;
  };
  const brk = (k: "day" | "night") => (times.breaks ?? []).filter((b) => b.shift === k).reduce((n, b) => n + b.minutes / 60, 0);
  return { day: Math.max(1, len(times.dayStart, times.nightStart) - brk("day") - 1), night: Math.max(1, len(times.nightStart, times.dayStart) - brk("night") - 1) };
}

export function buildAsBuiltWork(input: {
  built: AsBuilt;
  milestones: Milestone[];
  log: ProgressLogRow[];
  notes: MilestoneNote[];
  records: Map<string, ShiftRecord>;
  plans?: StaffingPlans | null;
  companyOf: (crew: string) => string;
  tz: string;
  times: ShiftTimes;
  now: number;
}): AsBuiltWork {
  const { built, tz, times } = input;
  const byId = new Map(input.milestones.filter((m) => m.id).map((m) => [m.id!, m]));
  const steps = built.orders.flatMap((o) => o.steps.map((s) => ({ s, order: o })));
  const stepIds = new Set(steps.map((x) => x.s.id));
  const orderOf = new Map(steps.map((x) => [x.s.id, x.order]));
  const crewOf = (id: string) => { const m = byId.get(id); return (m?.actualParty || m?.responsibleParty || "").trim() || "Not set"; };

  // The window: first plan or actual start to the last finish (or now).
  const starts = steps.flatMap((x) => [x.s.planStart, x.s.start]).filter((t): t is number => t != null);
  const ends = steps.flatMap((x) => [x.s.finish, x.s.planFinish]).filter((t): t is number => t != null);
  const anyOpen = steps.some((x) => x.s.status !== "done" && x.s.start != null);
  const from = starts.length ? Math.min(...starts) : input.now;
  const to = Math.max(ends.length ? Math.max(...ends) : from, anyOpen ? Math.min(input.now, from + 60 * 86_400_000) : from) + 1;
  const shifts = shiftWindowsBetween(from, to, tz, times, 400);
  const keys = shifts.map(shiftKey);
  const idx = new Map(keys.map((k, i) => [k, i]));
  const keyAt = (t: number) => shiftKey(shiftAt(t, tz, times));

  // Progress, by the time it was set for.
  const moved = new Map<string, Record<string, number>>(), touched = new Map<string, Set<string>>();
  for (const r of [...input.log].sort((a, b) => (toMs(a.at) ?? 0) - (toMs(b.at) ?? 0))) {
    if (!stepIds.has(r.milestone_id) || r.new_status === "planned") continue;
    const t = toMs(r.at); if (t == null) continue;
    const k = keyAt(t);
    const before = Number(r.old_percent ?? 0);
    const after = r.new_status === "completed" ? 100 : r.new_percent == null ? before : Number(r.new_percent);
    if (!touched.has(r.milestone_id)) touched.set(r.milestone_id, new Set());
    touched.get(r.milestone_id)!.add(k);
    const d = after - before;
    if (d > 0) { const mv = moved.get(r.milestone_id) ?? {}; mv[k] = (mv[k] ?? 0) + d; moved.set(r.milestone_id, mv); }
  }
  // A step marked done without its last progress logged (or none at all):
  // what's left lands on its recorded finish; its recorded start counts.
  for (const { s } of steps) {
    const t = touched.get(s.id) ?? new Set<string>();
    if (s.start != null && !t.size) t.add(keyAt(s.start));
    if (s.finish != null) {
      const mv = moved.get(s.id) ?? {};
      const total = Object.values(mv).reduce((a, b) => a + b, 0);
      if (total < 100) { const k = keyAt(s.finish); t.add(k); mv[k] = (mv[k] ?? 0) + (100 - total); moved.set(s.id, mv); }
    }
    if (t.size) touched.set(s.id, t);
  }

  // Comments, oldest first, without the ones that only repeat a number.
  const notesBy = new Map<string, Array<{ at: number; body: string }>>();
  for (const n of input.notes) {
    const body = (n.body ?? "").trim();
    const at = toMs(n.happenedAt) ?? toMs(n.createdAt);
    if (!body || at == null || NOISE.test(body) || !stepIds.has(n.milestoneId)) continue;
    if (!notesBy.has(n.milestoneId)) notesBy.set(n.milestoneId, []);
    notesBy.get(n.milestoneId)!.push({ at, body });
  }
  for (const v of notesBy.values()) v.sort((a, b) => a.at - b.at);

  const work = new Map<string, StepWork>();
  for (const { s } of steps) {
    const t = [...(touched.get(s.id) ?? [])].filter((k) => idx.has(k)).sort((a, b) => idx.get(a)! - idx.get(b)!);
    const mv = moved.get(s.id) ?? {};
    const earned: Record<string, number> = {};
    for (const [k, d] of Object.entries(mv)) earned[k] = Math.round(s.plannedH * d) / 100;
    const waits: WaitRun[] = [];
    if (t.length > 1) {
      let run: string[] = [];
      const close = () => {
        if (!run.length) return;
        const end = shifts[idx.get(run[run.length - 1])!].end;
        const said = (notesBy.get(s.id) ?? []).filter((x) => x.at <= end).map((x) => x.body);
        const last2: string[] = [];
        for (const b of said.reverse()) { if (!last2.includes(b)) last2.push(b); if (last2.length === 2) break; }
        waits.push({ from: run[0], to: run[run.length - 1], shifts: run.length, why: last2.reverse() });
        run = [];
      };
      for (let i = idx.get(t[0])!; i <= idx.get(t[t.length - 1])!; i++) {
        if (t.includes(keys[i])) close(); else run.push(keys[i]);
      }
      close();
    }
    work.set(s.id, { id: s.id, crew: crewOf(s.id), worked: t, moved: mv, earned, waits, ready: null, found: !s.inPlan });
  }

  // What each crew moved, shift by shift (for "was on" and the crew rows).
  const crewMoved = new Map<string, Map<string, Map<string, number>>>();
  for (const w of work.values()) {
    for (const k of w.worked) {
      if (!crewMoved.has(w.crew)) crewMoved.set(w.crew, new Map());
      const m = crewMoved.get(w.crew)!;
      if (!m.has(k)) m.set(k, new Map());
      const name = orderOf.get(w.id)?.name ?? "";
      m.get(k)!.set(name, (m.get(k)!.get(name) ?? 0) + 1);
    }
  }

  // Waiting to start.
  for (const { s } of steps) {
    const m = byId.get(s.id); const w = work.get(s.id)!;
    const first = w.worked[0] ?? (s.start != null ? keyAt(s.start) : null);
    if (!m || !first) continue;
    const preds = (m.dependsOn ?? []).filter((p) => stepIds.has(p));
    const pf = preds.map((p) => steps.find((x) => x.s.id === p)?.s.finish ?? null);
    if (!preds.length || pf.some((f) => f == null)) continue;
    let readyAt = Math.max(...(pf as number[]));
    if (s.inPlan && s.planStart != null) readyAt = Math.max(readyAt, s.planStart);
    const i0 = idx.get(keyAt(readyAt)), i1 = idx.get(first);
    if (i0 == null || i1 == null || i1 - i0 < 2) continue;
    const gap = keys.slice(i0 + 1, i1);
    const on = new Map<string, number>();
    let logged = false;
    for (const k of gap) {
      for (const [name, n] of crewMoved.get(w.crew)?.get(k) ?? []) {
        logged = true;
        if (name !== orderOf.get(s.id)?.name) on.set(name, (on.get(name) ?? 0) + n);
      }
    }
    w.ready = { at: readyAt, shifts: gap, busyOn: [...on.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n).slice(0, 3), crewLogged: logged };
  }

  // Work orders by shift.
  const orders = new Map<string, { cells: Array<"work" | "wait" | null>; worked: number; waited: number }>();
  for (const o of built.orders) {
    const ws = o.steps.map((s) => work.get(s.id)!).filter(Boolean);
    const cells = keys.map((k) => ws.some((w) => w.worked.includes(k)) ? "work" as const
      : ws.some((w) => w.waits.some((r) => idx.get(r.from)! <= idx.get(k)! && idx.get(k)! <= idx.get(r.to)!) || w.ready?.shifts.includes(k)) ? "wait" as const : null);
    orders.set(o.key, { cells, worked: cells.filter((c) => c === "work").length, waited: cells.filter((c) => c === "wait").length });
  }

  // Crews: what they moved, the hands counted or planned, and their pace.
  const tool = toolHoursOf(times);
  const toolOf = (k: string) => (k.endsWith(":night") ? tool.night : tool.day);
  const crews: CrewWork[] = [];
  const crewNames = [...new Set([...work.values()].map((w) => w.crew))];
  let countedShifts = 0;
  for (const k of keys) if (Object.values(input.records.get(k)?.crews ?? {}).some((c) => c?.headcount != null || c?.direct != null)) countedShifts++;
  for (const crew of crewNames) {
    const company = input.companyOf(crew);
    const byShift: Record<string, CrewShift> = {};
    for (const k of keys) {
      const ws = [...work.values()].filter((w) => w.crew === crew && w.worked.includes(k));
      const c = input.records.get(k)?.crews?.[crew];
      const total = c?.headcount ?? (c?.direct != null || c?.indirect != null ? (c?.direct ?? 0) + (c?.indirect ?? 0) : null);
      const counted = total != null || c?.direct != null ? { total: total ?? null, direct: c?.direct ?? null, indirect: c?.indirect ?? null } : null;
      const p = input.plans?.[company]?.shifts?.[k] ?? null;
      const earned = ws.reduce((n, w) => n + (w.earned[k] ?? 0), 0);
      if (ws.length || counted || p) byShift[k] = { moved: ws.length, earned: Math.round(earned * 10) / 10, counted, planned: p ? { direct: p.direct, indirect: p.indirect } : null, verdict: null };
    }
    const handsOf = (x: CrewShift) => x.counted?.direct ?? x.planned?.direct ?? x.counted?.total ?? null;
    const withHands = Object.entries(byShift).filter(([, x]) => (handsOf(x) ?? 0) > 0);
    const planShifts = Object.entries(byShift).filter(([, x]) => (x.planned?.direct ?? 0) > 0);
    const countShifts = Object.entries(byShift).filter(([, x]) => (x.counted?.direct ?? x.counted?.total ?? 0) > 0);
    const paceFrom = (rows: Array<[string, CrewShift]>, hands: (x: CrewShift) => number) => {
      const mh = rows.reduce((n, [k, x]) => n + hands(x) * toolOf(k), 0);
      const e = rows.reduce((n, [, x]) => n + x.earned, 0);
      return e > 0 ? Math.round((mh / e) * 100) / 100 : null;
    };
    const mostMoved = Math.max(0, ...Object.values(byShift).map((x) => x.moved));
    let pace: CrewWork["pace"] = null;
    if (planShifts.length >= 3) { const v = paceFrom(planShifts, (x) => x.planned!.direct); if (v) pace = { mhPerPlanH: v, from: "plan", shifts: planShifts.length }; }
    if (!pace && countShifts.length >= 2) { const v = paceFrom(countShifts, (x) => x.counted!.direct ?? x.counted!.total!); if (v) pace = { mhPerPlanH: v, from: "counted", shifts: countShifts.length }; }
    if (!pace && countShifts.length) {
      // Too few counts for a pace: hands per job going.
      const hands = Math.max(...countShifts.map(([, x]) => x.counted!.direct ?? x.counted!.total!));
      if (mostMoved > 0) pace = { mhPerPlanH: Math.round((hands / mostMoved) * 10) / 10, from: "per job", shifts: countShifts.length };
    }
    const per = withHands.map(([, x]) => x.earned / handsOf(x)!);
    const perHand = per.length ? per.reduce((a, b) => a + b, 0) / per.length : null;
    if (perHand) for (const [, x] of withHands) {
      const v = x.earned / handsOf(x)!;
      x.verdict = v < 0.6 * perHand ? "low" : v > 1.5 * perHand ? "high" : "ok";
    }
    crews.push({ crew, company, byShift, mostMoved, pace, perHand: perHand == null ? null : Math.round(perHand * 100) / 100 });
  }
  crews.sort((a, b) => Object.keys(b.byShift).length - Object.keys(a.byShift).length || a.crew.localeCompare(b.crew));

  const ws = [...work.values()];
  return {
    shifts, steps: work, orders, crews, toolHours: tool,
    totals: {
      waitedSteps: ws.filter((w) => w.waits.length).length,
      waitedShifts: ws.reduce((n, w) => n + w.waits.reduce((m, r) => m + r.shifts, 0), 0),
      readySteps: ws.filter((w) => w.ready).length,
      readyShifts: ws.reduce((n, w) => n + (w.ready?.shifts.length ?? 0), 0),
      countedShifts,
    },
  };
}

/** The shift a key names. */
export function shiftOfKey(work: AsBuiltWork, k: string): ShiftWindow | null {
  return work.shifts.find((w) => shiftKey(w) === k) ?? null;
}
export { nextShift };
