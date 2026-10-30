// shiftPlan — changing what the next shift does, in the schedule itself:
// swap a step on its list for one from later on, pull one in, or push one
// out. The planned dates of the steps moved change (the baseline doesn't;
// linked work after them keeps its plan), and the change is checked first:
// what the step pulled in still waits on, whether it's the other crew's
// hours, whether it touches the critical path, and what it does to the
// turnaround's forecast finish. The calendar, the shift report and the
// email all read the schedule, so they follow.

import type { Milestone } from "@/types/schema";
import type { DateChange } from "@/lib/scheduleReflow";
import { computeCpm } from "@/lib/cpm";
import { resolveCriticalPath, type CriticalMode } from "@/lib/criticalPath";
import { predecessorConflicts } from "@/lib/openWork";
import { startMsOf, finishMsOf } from "@/lib/calendarPlacement";
import { workShiftOf, type ShiftTimes, type ShiftWindow } from "@/lib/shiftReport";
import { woOf } from "@/lib/workOrderCrew";

export type ShiftPlanAction =
  /** `inId` takes `outId`'s place on the next shift; `outId` takes the
   *  place `inId` had. */
  | { kind: "swap"; inId: string; outId: string }
  /** `inId` comes onto the next shift. */
  | { kind: "pull"; inId: string }
  /** `outId` comes off the next shift, to start at `to`. */
  | { kind: "push"; outId: string; to: number };

export interface PlannedMove { id: string; name: string; wo: string | null; from: [number, number]; to: [number, number] }

export interface ShiftPlanChange {
  /** Every date that changes: the steps moved, linked work after them, and
   *  the tasks around them refitted. */
  moves: DateChange[];
  in?: PlannedMove;
  out?: PlannedMove;
  /** Linked work it pushes later in the forecast (hours), biggest first; its plan stays. */
  pushed: Array<{ id: string; name: string; hours: number }>;
  /** What the step pulled in waits on that won't be done when it starts. */
  waits: Array<{ name: string; until: number }>;
  /** The step pulled in was the other crew's hours (day work on a night
   *  shift): saving lets the shift's crew work it. */
  crewHours: string[];
  /** What changes on the step pulled in besides its dates: worked on
   *  either crew's hours, and who does it. */
  inPatch?: { shift?: "swing"; responsibleParty?: string };
  impact: {
    /** The turnaround's forecast finish (lib/cpm): before → after. */
    finish: [number, number];
    /** A step moved is on the critical path (before or after). */
    critical: boolean;
  };
}

const H = 3_600_000;
const iso = (t: number) => new Date(t).toISOString();

export function planShiftChange(milestones: Milestone[], action: ShiftPlanAction, o: { next: ShiftWindow; now: number; tz: string; times: ShiftTimes; mode?: CriticalMode | null;
  /** Who does the step pulled in (default: as it is). */
  crew?: string | null }): ShiftPlanChange | null {
  const { next, now, tz, times } = o;
  const byId = new Map(milestones.filter((m) => m.id).map((m) => [m.id!, m]));
  const span = (m: Milestone) => Math.max(0, finishMsOf(m) - startMsOf(m));
  const inM = action.kind !== "push" ? byId.get(action.inId) : undefined;
  const outM = action.kind !== "pull" ? byId.get(action.outId) : undefined;
  if ((action.kind !== "push" && !inM) || (action.kind !== "pull" && !outM)) return null;
  // Starting on the next shift: where the step it replaces starts in it,
  // else the shift's start (or now, once it's under way).
  const nowMin = Math.ceil(now / 60_000) * 60_000;
  const shiftStart = nowMin > next.start ? Math.min(nowMin, next.end - 60_000) : next.start;
  const inStart = (() => {
    if (!inM) return NaN;
    const s = outM ? startMsOf(outM) : NaN;
    return Number.isFinite(s) && s >= shiftStart && s < next.end ? s : shiftStart;
  })();
  // Off the next shift: where the step that replaces it was (never before
  // the next shift is over), or where it was sent.
  const outStart = (() => {
    if (!outM) return NaN;
    if (action.kind === "push") return Math.max(action.to, next.end);
    return Math.max(inM ? startMsOf(inM) : next.end, next.end);
  })();
  const primary: DateChange[] = [];
  const mv = (m: Milestone | undefined, s: number): PlannedMove | undefined => {
    if (!m?.id || !Number.isFinite(s)) return undefined;
    const from: [number, number] = [startMsOf(m), finishMsOf(m)];
    const to: [number, number] = [s, s + span(m)];
    if (to[0] !== from[0] || to[1] !== from[1]) primary.push({ id: m.id, plannedStartAt: iso(to[0]), plannedAt: iso(to[1]) });
    // Its WO: its own, else the work order above it.
    let wo = woOf(m);
    for (let p = m.parentId ? byId.get(m.parentId) : undefined; !wo && p; p = p.parentId ? byId.get(p.parentId) : undefined) wo = woOf(p);
    return { id: m.id, name: m.name, wo: wo || null, from, to };
  };
  const inMove = mv(inM, inStart);
  const outMove = mv(outM, outStart);
  if (!primary.length) return null;

  // Only the steps pulled in or pushed out move: linked work after them
  // keeps its planned dates (the forecast carries what the move pushes).
  const set = new Map(primary.map((c) => [c.id, c]));
  // The tasks around a moved step stretch to cover it — never shrink, and
  // nothing else about them changes.
  const env = new Map<string, [number, number]>();
  for (const c of [...set.values()]) {
    const s = Date.parse(c.plannedStartAt), f = Date.parse(c.plannedAt);
    for (let p = byId.get(c.id)?.parentId ? byId.get(byId.get(c.id)!.parentId!) : undefined; p?.id; p = p.parentId ? byId.get(p.parentId) : undefined) {
      const [ps, pf] = env.get(p.id) ?? [startMsOf(p), finishMsOf(p)];
      if (!Number.isFinite(ps) || !Number.isFinite(pf) || (s >= ps && f <= pf)) break;
      env.set(p.id, [Math.min(ps, s), Math.max(pf, f)]);
    }
  }
  for (const [id, [s, f]] of env) set.set(id, { id, plannedStartAt: iso(s), plannedAt: iso(f) });
  const moves = [...set.values()];

  const after = milestones.map((m) => { const c = m.id ? set.get(m.id) : undefined; return c ? { ...m, plannedStartAt: c.plannedStartAt, plannedAt: c.plannedAt } : m; });
  const parents = new Set(milestones.map((m) => m.parentId).filter(Boolean) as string[]);
  const before = computeCpm(milestones, { now, tz });
  const afterCpm = computeCpm(after, { now, tz });
  // Linked work the move pushes later — in the forecast; its plan stays.
  const pushed = [...afterCpm.steps.values()]
    .filter((st) => !parents.has(st.id) && st.id !== inMove?.id && st.id !== outMove?.id && !st.done)
    .map((st) => ({ id: st.id, name: byId.get(st.id)?.name ?? "", hours: Math.round(((st.ef - (before.steps.get(st.id)?.ef ?? st.ef)) / H) * 10) / 10 }))
    .filter((x) => x.hours > 0)
    .sort((a, b) => b.hours - a.hours);
  const afterById = new Map(after.filter((m) => m.id).map((m) => [m.id!, m]));
  const waits = inM ? predecessorConflicts(afterById.get(inM.id!)!, inStart, afterById).map((x) => ({ name: x.pred.name, until: x.predFinish })) : [];
  const crewHours: string[] = [];
  const inPatch: NonNullable<ShiftPlanChange["inPatch"]> = {};
  if (inM) {
    const w = workShiftOf(inM, tz, times);
    if (w !== "both" && w !== next.kind) { crewHours.push(`${inM.name} is ${w}-crew work`); inPatch.shift = "swing"; }
    const who = o.crew?.trim();
    if (who && who !== (inM.responsibleParty?.trim() ?? "")) inPatch.responsibleParty = who;
  }
  const critBefore = resolveCriticalPath(milestones, o.mode ?? null, { now, tz }).ids;
  const critAfter = resolveCriticalPath(after, o.mode ?? null, { now, tz }).ids;
  const ids = [inMove?.id, outMove?.id].filter(Boolean) as string[];
  return {
    moves, in: inMove, out: outMove, pushed, waits, crewHours, ...(Object.keys(inPatch).length ? { inPatch } : {}),
    impact: { finish: [before.forecastFinish, afterCpm.forecastFinish], critical: ids.some((id) => critBefore.has(id) || critAfter.has(id)) },
  };
}

/** The shifts a step can be pushed to: the next few after the next shift. */
export function laterShifts(next: ShiftWindow, nextOf: (w: ShiftWindow) => ShiftWindow, n = 6): ShiftWindow[] {
  const out: ShiftWindow[] = [];
  let w = next;
  for (let i = 0; i < n; i++) { w = nextOf(w); out.push(w); }
  return out;
}

/** The reason, said on each step moved (kept as a reschedule entry, so it
 *  never stands in for the work comment the report reads). */
export function planNote(c: ShiftPlanChange, reason: string, label: (t: number) => string): Array<{ id: string; body: string }> {
  const wo = (m?: PlannedMove) => (m ? (m.wo ? `WO ${m.wo} ${m.name}` : m.name) : "");
  const out: Array<{ id: string; body: string }> = [];
  if (c.in) out.push({ id: c.in.id, body: `Re-planned to ${label(c.in.to[0])}${c.out ? ` in place of ${wo(c.out)}` : ""} - ${reason}` });
  if (c.out) out.push({ id: c.out.id, body: `Re-planned to ${label(c.out.to[0])}${c.in ? ` - ${wo(c.in)} done first` : ""} - ${reason}` });
  return out;
}
