// nextPlanCheck - whether the suggested schedule can be trusted, and what
// could still move it.
//
//   - The check: this year's job run back through the same rules (the
//     order it was done in, calendars, start-up after every work order),
//     each step at the length it really took and the found work in. Landing within a shift
//     of the real finish means the rules hold for this job; otherwise the
//     suggested schedule says it is not reliable yet and makes no claim.
//   - The risks: work found by inspection, and jobs that ran a shift or
//     more past their plan, each with what it does to the suggested finish
//     if it happens again. Not planned work: a risk to watch.
//
// Pure: no database here.

import { nextPlan, planActivities, discoveryIds, type Cal, type NextPlan, type PlanChange, type PlanInput } from "@/lib/nextPlan";
import { shiftWindowsBetween, type ShiftTimes } from "@/lib/shiftReport";
import { discoveryOf } from "@/lib/discovery";

const H = 3_600_000;
const r1 = (n: number) => Math.round(n * 10) / 10;
/** Within this of the real finish, the rules hold: one shift. */
export const CHECK_H = 12;

/** Working hours between two times on a calendar (round the clock: all of
 *  it). Work done only outside its calendar (overtime) counts as it ran. */
export function workingHours(from: number, to: number, cal: Cal, tz: string, times: ShiftTimes): number {
  if (!(to > from)) return 0;
  if (cal === "both") return (to - from) / H;
  let n = 0;
  for (const w of shiftWindowsBetween(from, to, tz, times, 2000)) {
    if (w.kind !== cal) continue;
    n += Math.max(0, Math.min(to, w.end) - Math.max(from, w.start));
  }
  return n > 0 ? n / H : (to - from) / H;
}

export interface PlanCheck {
  /** Not finished yet, or nothing recorded to replay. */
  can: boolean;
  /** This year replayed through the rules. */
  replay: number | null;
  /** The job's real finish. */
  actual: number | null;
  /** Replay minus real, hours (+: the replay is later). */
  offH: number | null;
  /** Within a shift. */
  ok: boolean;
  /** Steps replayed at their real length. */
  steps: number;
}

/** This year's real lengths, as changes to the plan made from it: each
 *  done step at the hours it really took, on its calendar. Everything else
 *  (the order it was done in, calendars, start-up after every work order)
 *  is the suggested schedule's own rules. */
export function replayChanges(input: PlanInput): PlanChange[] {
  const steps = new Map(input.built.orders.flatMap((o) => o.steps.map((s) => [s.id, s] as const)));
  const out: PlanChange[] = [];
  for (const a of planActivities(input)) {
    const s = steps.get(a.id);
    if (s?.status === "done" && s.start != null && s.finish != null) out.push({ id: `real:${a.id}`, said: "", at: 0, kind: "set", actId: a.id, hours: r1(workingHours(s.start, s.finish, a.cal, input.tz, input.times)) });
  }
  return out;
}

/** Each done step at the length it really took (the replay's lengths). */
const realHours = (input: PlanInput) => new Map(replayChanges(input).flatMap((c) => (c.kind === "set" && c.hours != null ? [[c.actId, c.hours] as const] : [])));

/** Replay this year through the rules and hold it against the real finish. */
export function checkPlan(input: Omit<PlanInput, "changes">): PlanCheck {
  const actual = input.built.finish;
  const changes = replayChanges({ ...input, changes: [] });
  const steps = changes.filter((c) => c.kind === "set").length;
  if (actual == null || !steps) return { can: false, replay: null, actual, offH: null, ok: false, steps };
  const p = nextPlan({ ...input, changes, withFound: true });
  const offH = r1((p.finish - actual) / H);
  return { can: true, replay: p.finish, actual, offH, ok: Math.abs(offH) <= CHECK_H, steps };
}

export interface PlanRisk {
  id: string;
  kind: "found" | "long";
  /** What happened this year, in words. */
  title: string;
  where: string;
  crew: string;
  /** Hours it added this year (found: its steps' real hours; long: past plan). */
  hours: number;
  /** What it does to the suggested finish if it happens again, hours. */
  finishH: number;
}

/** Found work and jobs that ran long, each tried against the suggested
 *  schedule; the ones that move the finish most first. */
export function planRisks(input: PlanInput, plan: NextPlan, opts: { max?: number } = {}): PlanRisk[] {
  const { built } = input;
  const byId = new Map(input.milestones.filter((m) => m.id).map((m) => [m.id!, m]));
  const orderOf = new Map(built.orders.flatMap((o) => o.steps.map((s) => [s.id, o] as const)));
  const stepOf = new Map(built.orders.flatMap((o) => o.steps.map((s) => [s.id, s] as const)));
  const real = realHours(input);
  const tries: Array<Omit<PlanRisk, "finishH"> & { changes: PlanChange[]; withFound?: boolean; keep?: string[] }> = [];

  // Found by inspection: each find (its steps together).
  const found = new Set(discoveryIds(input.work, input.milestones));
  const groups = new Map<string, string[]>();
  for (const id of found) { const d = discoveryOf(byId.get(id)!); const k = d?.id ?? id; groups.set(k, [...(groups.get(k) ?? []), id]); }
  for (const [k, ids] of groups) {
    const first = byId.get(ids[0])!; const d = discoveryOf(first);
    const o = orderOf.get(ids[0]);
    const where = o?.foundOn ?? o?.name ?? "";
    const hrs = ids.reduce((n, id) => n + (real.get(id) ?? stepOf.get(id)?.plannedH ?? 0), 0);
    tries.push({ id: `found:${k}`, kind: "found", title: d?.what?.trim() || first.name || "Found work", where, crew: (first.actualParty || first.responsibleParty || "").trim() || "Not set", hours: r1(hrs), changes: [], withFound: true, keep: ids });
  }
  // Ran long: a work order whose steps ran a shift or more past their plan
  // in all, on their own calendars (off-site trips left out: the lessons
  // plan them). Tried together, as they happened.
  const long = new Map<string, Array<{ a: NextPlan["acts"][number]; took: number }>>();
  for (const a of plan.acts) {
    if (!stepOf.has(a.id) || a.planHours == null || a.crew === "Off site") continue;
    const took = real.get(a.id);
    if (took == null || took - a.planHours < 1) continue;
    long.set(a.order, [...(long.get(a.order) ?? []), { a, took }]);
  }
  for (const [order, xs] of long) {
    const over = xs.reduce((n, x) => n + x.took - x.a.planHours!, 0);
    if (over < CHECK_H) continue;
    xs.sort((p, q) => (q.took - q.a.planHours!) - (p.took - p.a.planHours!));
    const crews = [...new Set(xs.map((x) => x.a.crew))];
    tries.push({
      id: `long:${order}`, kind: "long", where: built.orders.find((o) => o.key === order)?.name ?? "", crew: crews.join(", "), hours: r1(over),
      title: xs.slice(0, 3).map((x) => `${x.a.name} took ${r1(x.took)} h (plan ${r1(x.a.planHours!)} h)`).join("; ") + (xs.length > 3 ? `; ${xs.length - 3} more` : ""),
      changes: xs.map((x) => ({ id: `risk:${x.a.id}`, said: "", at: 0, kind: "set" as const, actId: x.a.id, hours: r1(x.took) })),
    });
  }

  const out: PlanRisk[] = [];
  for (const t of tries) {
    let p: NextPlan;
    if (t.withFound) {
      // Only this find put back: every other find stays out.
      const others = [...found].filter((id) => !t.keep!.includes(id));
      const drop: PlanChange[] = others.length ? [{ id: "risk:others", said: "", at: 0, kind: "drop", target: { ids: others } }] : [];
      // At the length it really took.
      const took: PlanChange[] = t.keep!.flatMap((id) => { const h = real.get(id); return h != null ? [{ id: `risk:${id}`, said: "", at: 0, kind: "set" as const, actId: id, hours: h }] : []; });
      p = nextPlan({ ...input, withFound: true, changes: [...drop, ...input.changes, ...took] });
    } else p = nextPlan({ ...input, changes: [...input.changes, ...t.changes] });
    const { changes: _c, withFound: _w, keep: _k, ...risk } = t;
    void _c; void _w; void _k;
    out.push({ ...risk, finishH: r1(Math.max(0, (p.finish - plan.finish) / H)) });
  }
  return out.sort((a, b) => b.finishH - a.finishH || b.hours - a.hours).slice(0, opts.max ?? 6);
}
