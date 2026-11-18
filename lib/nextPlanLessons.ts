// nextPlanLessons - what this job taught, put into the schedule suggested for
// next time (lib/nextPlan), and what it takes to make the target.
//
// The lessons come from the record, the same facts the post-event review
// reads (lib/crewFlow, lib/postEventReview):
//   - Off-site repair or calibration (a step named for it, or a comment that
//     says the part went out): planned at the clock time it was really away,
//     and what gets it out (blinds, unbolting, pulling) moved to first thing
//     once the unit is down, in the order it was really done, so it is back
//     in time.
//   - A crew handed more jobs at once than it ever worked at a time: it takes
//     them that many at a time, the ones that hold the finish first.
// Then the target (this year's planned finish): when the schedule still
// misses it, the changes that pull the finish in, one at a time, the one
// that saves the most first: start sooner, nights too, a second crew. More
// time is said only when none of them closes the gap.
//
// Pure: no database here.

import type { Milestone, MilestoneNote } from "@/types/schema";
import type { AsBuilt } from "@/lib/asBuiltSchedule";
import type { AsBuiltWork } from "@/lib/asBuiltWork";
import { shiftKey } from "@/lib/asBuiltWork";
import type { ShiftTimes } from "@/lib/shiftReport";
import { crewFlows, overloaded, type CrewFlow } from "@/lib/crewFlow";
import { causeOfText } from "@/lib/postEventReview";
import { nextPlan, type NextPlan, type PlanChange } from "@/lib/nextPlan";

const H = 3_600_000;
const r1 = (n: number) => Math.round(n * 10) / 10;
const ms = (v: unknown): number => (v == null ? NaN : typeof v === "number" ? v : Date.parse(String(v)));

/** A step that is the trip itself: out for service, hot-shotted to a shop. */
export const OFFSITE_STEP = /\b(out for (service|repair|calibration|cal)|hot\s*-?\s*shot|(send|sent|ship|shipped|haul|hauled|truck|trucked)\s+(it\s+)?(out|off|to)\b|to (the )?(shop|vendor)\b|at (the )?(shop|vendor)\b|off[- ]?site)/i;
/** The shutdown itself ("Transmix-2 - Shutdown"), not work that needs one
 *  ("Shutdown-Required Inspection ..."). */
const isShutdown = (name: string) => /shut\s*-?\s*down\s*$/i.test(name.trim()) && !/required/i.test(name);

export interface Lesson {
  id: string;
  /** The review's area it comes from. */
  area: "logistics" | "contractors" | "planning";
  title: string;
  /** What this year's record shows. */
  saw: string;
  /** What the suggested schedule does about it. */
  does: string;
  changes: PlanChange[];
  /** Off site: the change that only plans the real time away (on this
   *  year's dates), to say what sending it first thing saves. */
  honest?: PlanChange[];
  /** The activities it is about (as the plan names them after the change). */
  acts: string[];
  crew?: string;
}

type Input = { built: AsBuilt; work: AsBuiltWork; milestones: Milestone[]; tz: string; times: ShiftTimes };

const change = (id: string, c: Record<string, unknown>): PlanChange => ({ id, said: "", at: 0, ...c } as PlanChange);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const hoursWord = (h: number) => (h >= 36 ? `${r1(h / 24)} days` : `${Math.round(h)} h`);

/** The lessons this job's record gives, against the schedule made from it
 *  with no changes (`base`). `notes`: the steps' comments. */
export function planLessons(input: Input & { notes: MilestoneNote[]; base: NextPlan; now: number; flows?: CrewFlow[] }): Lesson[] {
  const { built, work, base, now } = input;
  const out: Lesson[] = [];
  const steps = built.orders.flatMap((o) => o.steps.map((s) => ({ s, o })));
  const stepOf = new Map(steps.map((x) => [x.s.id, x]));
  const actOf = new Map(base.acts.map((a) => [a.id, a]));
  const idx = new Map(work.shifts.map((w, i) => [shiftKey(w), i]));

  // When the unit is down and its equipment can be opened: the shutdown's
  // last activity, else the first shift.
  const shut = base.acts.filter((a) => isShutdown(built.orders.find((o) => o.key === a.order)?.name ?? ""));
  const ready = shut.length ? Math.max(...shut.map((a) => a.finish)) : base.start;

  // What came before a step on its equipment this year: the steps of its
  // work order that were done when it started (the order it was really
  // done in), the latest last.
  const before = (id: string): string[] => {
    const x = stepOf.get(id); if (!x) return [];
    const at = x.s.start ?? x.s.planStart;
    if (at == null) return [];
    return x.o.steps.filter((p) => p.id !== id && actOf.has(p.id) && (p.finish != null ? p.finish <= at + 60_000 : p.start == null && p.planFinish != null && p.planFinish <= at)).sort((a, b) => (a.finish ?? a.planFinish ?? 0) - (b.finish ?? b.planFinish ?? 0)).map((p) => p.id);
  };
  // Links a step didn't really wait on this year: what it is linked to was
  // done after it started, or never.
  const notWaited = (id: string): string[] => {
    const x = stepOf.get(id); const a = actOf.get(id);
    if (!x || !a || x.s.start == null) return [];
    return a.preds.filter((p) => { const q = stepOf.get(p)?.s; return !!q && (q.finish == null || q.finish > x.s.start! + 60_000); });
  };
  // Pull a step's way out to first thing: each step before it in the order
  // it was really done, as soon as the unit is down; links inside the work
  // order it didn't really wait on dropped.
  const firstThing = (lid: string, id: string): PlanChange[] => {
    const chain = before(id);
    const x = stepOf.get(id)!;
    const sameOrder = new Set(x.o.steps.map((p) => p.id));
    const cs: PlanChange[] = [];
    const all = [...chain, id];
    for (let i = 0; i < all.length; i++) {
      const a = actOf.get(all[i]); if (!a) continue;
      const prev = i > 0 ? all[i - 1] : null;
      const drop = [...new Set([...a.preds.filter((p) => sameOrder.has(p) && p !== prev && !chain.slice(0, i).includes(p)), ...notWaited(a.id)])];
      if (drop.length || (prev && !a.preds.includes(prev))) cs.push(change(`${lid}:link:${a.id}`, { kind: "relink", actId: a.id, drop, add: prev ? [prev] : [] }));
    }
    if (chain.length) cs.push(change(`${lid}:floor`, { kind: "floor", target: { ids: chain }, at: ready }));
    cs.push(change(`${lid}:first`, { kind: "first", target: { ids: all } }));
    return cs;
  };

  // ── Off site: a step that is the trip ──
  for (const { s, o } of steps) {
    const a = actOf.get(s.id); if (!a || !OFFSITE_STEP.test(s.name)) continue;
    const away = s.start != null ? ((s.finish ?? (s.status !== "not_started" ? now : s.start)) - s.start) / H : null;
    const hours = away != null && away > 0 ? Math.max(away, s.status === "done" ? 0 : s.plannedH) : s.plannedH;
    const lid = `offsite:${s.id}`;
    const set = change(`${lid}:set`, { kind: "set", actId: s.id, hours: r1(hours), cal: "both", crew: "Off site", basis: `off site: ${hoursWord(hours)} around the clock (${away != null ? "this year" : "the plan"})`, kindAs: "changed" });
    const chain = before(s.id);
    const names = chain.map((id) => stepOf.get(id)?.s.name).filter(Boolean) as string[];
    out.push({
      id: lid, area: "logistics", acts: [...chain, s.id],
      title: `${o.name}: get it out first thing`,
      saw: away != null
        ? `${s.name} took ${hoursWord(away)}${s.status === "done" ? "" : " so far, not back yet"} this year, start to finish, against ${r1(s.plannedH)} h in the plan.`
        : `${s.name} is time off site: ${r1(s.plannedH)} h in the plan.`,
      does: `${s.name} is planned at ${hoursWord(hours)} around the clock${names.length ? `, and ${names.join(", ")} ${names.length === 1 ? "goes" : "go"} first thing once the unit is down, so it leaves as early as it can` : ", as soon as what comes before it is done"}.`,
      changes: [set, ...firstThing(lid, s.id)],
      honest: [set],
    });
  }

  // ── Off site: a comment says the part went out ──
  const notesOf = new Map<string, Array<{ at: number; body: string }>>();
  for (const n of input.notes) {
    const at = ms(n.happenedAt ?? n.createdAt); if (!Number.isFinite(at) || !n.body) continue;
    notesOf.set(n.milestoneId, [...(notesOf.get(n.milestoneId) ?? []), { at, body: n.body }]);
  }
  for (const w of work.steps.values()) {
    const x = stepOf.get(w.id); const a = actOf.get(w.id);
    if (!x || !a || !w.waits.length || OFFSITE_STEP.test(x.s.name)) continue;
    const mine = (notesOf.get(w.id) ?? []).sort((p, q) => p.at - q.at);
    for (const run of w.waits) {
      const i0 = idx.get(run.from), i1 = idx.get(run.to);
      if (i0 == null || i1 == null) continue;
      const end = work.shifts[i1].end;
      const sent = mine.find((n) => n.at <= end && n.at >= (x.s.start ?? -Infinity) && causeOfText(n.body) === "offsite");
      if (!sent) continue;
      const resume = w.worked.map((k) => idx.get(k)).filter((i): i is number => i != null && i > i1).sort((p, q) => p - q)[0];
      const back = resume != null ? work.shifts[resume].start : x.s.finish ?? now;
      const awayH = Math.max(1, (back - sent.at) / H);
      const quoted = /(\d+(?:\.\d+)?)\s*-?\s*(?:hrs?|hours?)\b/i.exec(sent.body);
      const days = /(\d+(?:\.\d+)?)\s*-?\s*days?\b/i.exec(sent.body);
      const quoteH = quoted ? Number(quoted[1]) : days ? Number(days[1]) * 24 : null;
      const planH = r1(Math.max(awayH, quoteH ?? 0));
      const moved = Object.entries(w.moved).filter(([k]) => (idx.get(k) ?? 1e9) < i0).reduce((n, [, v]) => n + v, 0) / 100;
      const fraction = moved > 0.05 && moved < 0.95 ? moved : 0.5;
      const lid = `offsite:${w.id}`;
      const short = x.s.name.split(/\s+(?:from|on|for)\s+/i)[0].slice(0, 40);
      const chain = before(w.id);
      const split = change(`${lid}:split`, { kind: "split", actId: w.id, fraction, name: `${short} off site`, crew: "Off site", hours: planH, cal: "both" });
      out.push({
        honest: [split],
        id: lid, area: "logistics", acts: [...chain, `${w.id}:1`, `${w.id}:w`, `${w.id}:2`],
        title: `${x.o.name}: out first thing, back in time`,
        saw: `"${sent.body.trim().slice(0, 140)}" It was away ${hoursWord(awayH)}${quoteH != null ? ` (quoted ${hoursWord(quoteH)})` : ""}; the plan gave the whole job ${r1(x.s.plannedH)} h, with no time off site.`,
        does: `Taken out first thing once the unit is down, ${hoursWord(planH)} off site around the clock, then put back.`,
        changes: [
          ...(notWaited(w.id).length ? [change(`${lid}:link`, { kind: "relink", actId: w.id, drop: notWaited(w.id), add: [] })] : []),
          split,
          change(`${lid}:floor`, { kind: "floor", target: { ids: [`${w.id}:1`, ...chain] }, at: ready }),
          change(`${lid}:first`, { kind: "first", target: { ids: [...chain, `${w.id}:1`, `${w.id}:w`] } }),
        ],
      });
      break;
    }
  }

  // ── Links the work didn't wait on ──
  // This year's plan linked steps the crews started before what they were
  // linked to was done: next time they don't wait on them either.
  const loose = base.acts.map((a) => ({ a, drop: notWaited(a.id) })).filter((x) => x.drop.length && !out.some((l) => l.acts.includes(x.a.id)));
  if (loose.length) {
    const orderName = (k: string) => built.orders.find((o) => o.key === k)?.name ?? "";
    const named = [...new Set(loose.map((x) => orderName(x.a.order)).filter(Boolean))];
    out.push({
      id: "links", area: "planning", acts: loose.map((x) => x.a.id),
      title: `${loose.length} link${loose.length === 1 ? "" : "s"} the work didn't wait on`,
      saw: `In this year's plan, ${plural(loose.length, "step")} waited on other work, but in the field ${loose.length === 1 ? "it" : "they"} started before that work was done: ${named.slice(0, 4).join(", ")}${named.length > 4 ? ` and ${named.length - 4} more` : ""}.`,
      does: "Those steps go in the order they were really done, without waiting on those links.",
      changes: loose.map((x) => change(`links:${x.a.id}`, { kind: "relink", actId: x.a.id, drop: x.drop, add: [] })),
    });
  }

  // ── A crew handed more at once than it worked ──
  const flows = input.flows ?? crewFlows(built, work, new Map(input.milestones.filter((m) => m.id).map((m) => [m.id!, m.dependsOn ?? []])));
  for (const f of flows) {
    const c = work.crews.find((x) => x.crew === f.crew);
    // What it really worked at once: at its busiest moment, or in its busiest shift.
    const k = Math.max(1, f.peak.working.length, c?.mostMoved ?? 1);
    const mine = base.acts.filter((a) => a.crew === f.crew && a.hours > 0);
    const most = mostAtOnce(mine);
    if (f.peak.open <= k || !(overloaded(f) || f.waitH >= 24)) continue;
    out.push({
      id: `crew:${f.crew}`, area: "contractors", crew: f.crew, acts: mine.map((a) => a.id),
      title: `${f.crew}: ${k} job${k === 1 ? "" : "s"} at a time`,
      saw: `${f.peak.open} jobs sat open for ${f.crew} at once this year, and it never worked more than ${k} at a time${f.plannedPeak ? `; the plan gave it ${f.plannedPeak}` : ""}. Its jobs waited ${Math.round(f.waitH)} h in all.`,
      does: most > k ? `${f.crew} takes its jobs ${k} at a time, the ones that hold the finish first (the plan as it stands gives it ${most} at once).` : `${f.crew} takes its jobs ${k} at a time, the ones that hold the finish first.`,
      changes: [change(`crew:${f.crew}:jobs`, { kind: "jobs", crew: f.crew, n: k })],
    });
  }
  return out;
}

/** The most activities open at one moment. */
export function mostAtOnce(acts: Array<{ start: number; finish: number }>): number {
  const ev: Array<[number, number]> = [];
  for (const a of acts) if (a.finish > a.start) { ev.push([a.start, 1]); ev.push([a.finish, -1]); }
  ev.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  let n = 0, best = 0;
  for (const [, d] of ev) { n += d; best = Math.max(best, n); }
  return best;
}

/** The changes the lessons put in (those not left out). */
export function lessonChanges(lessons: Lesson[], skipped: Set<string>): PlanChange[] {
  return lessons.filter((l) => !skipped.has(l.id)).flatMap((l) => l.changes);
}

/** What each lesson does to the finish: hours sooner (+) or later (-) than
 *  with it left out, the rest the same. */
export function lessonEffects(input: Input, lessons: Lesson[], skipped: Set<string>, person: PlanChange[], plan: NextPlan): Record<string, number> {
  const out: Record<string, number> = {};
  for (const l of lessons) {
    if (skipped.has(l.id)) continue;
    const others = lessonChanges(lessons, new Set([...skipped, l.id]));
    const without = nextPlan({ ...input, changes: [...others, ...(l.honest ?? []), ...person] });
    out[l.id] = r1((without.finish - plan.finish) / H);
  }
  return out;
}

export interface Lever { change: PlanChange; words: string; savedH: number; finish: number }

/** What pulls the finish in to `target`, one change at a time, the one that
 *  saves the most first; stops at the target or when nothing saves half an
 *  hour. `orderName`: each work order's name. */
export function toTarget(input: Input, changes: PlanChange[], plan: NextPlan, target: number, orderName: (key: string) => string): { levers: Lever[]; finish: number; shortH: number } {
  const levers: Lever[] = [];
  let cur = plan, list = [...changes];
  for (let round = 0; round < 4 && cur.finish > target + 30 * 60_000; round++) {
    const byId = new Map(cur.acts.map((a) => [a.id, a]));
    const path = cur.driving.map((id) => byId.get(id)).filter((a): a is NonNullable<typeof a> => !!a);
    const orders = [...new Set(path.map((a) => a.order))];
    const tries: Array<{ c: PlanChange; words: string }> = [];
    for (const o of orders) {
      if (path.some((a) => a.order === o && a.floor != null && a.start <= a.floor + 60_000)) tries.push({ c: change(`lever:asap:${o}:${round}`, { kind: "asap", target: { order: o } }), words: `Start ${orderName(o)} as soon as what comes before it is done, not on this year's planned date` });
      const days = cur.acts.filter((a) => a.order === o && a.cal === "day");
      if (days.length) tries.push({ c: change(`lever:nights:${o}:${round}`, { kind: "nights", target: { ids: days.map((a) => a.id) }, on: true }), words: `Put a night crew on ${orderName(o)} (its ${r1(days.reduce((n, a) => n + a.hours, 0))} h of work runs days and nights, 12-hour shifts)` });
    }
    for (const crew of new Set(path.filter((a) => a.heldForCrew).map((a) => a.crew))) {
      const n = cur.jobsCap[crew]; if (!n) continue;
      tries.push({ c: change(`lever:jobs:${crew}:${round}`, { kind: "jobs", crew, n: n + 1 }), words: `Another ${crew} crew: ${n + 1} jobs at a time instead of ${n}` });
    }
    let best: { p: NextPlan; t: (typeof tries)[number] } | null = null;
    for (const t of tries) {
      const p = nextPlan({ ...input, changes: [...list, t.c] });
      if (p.finish < (best?.p.finish ?? cur.finish) - 30 * 60_000) best = { p, t };
    }
    if (!best) break;
    levers.push({ change: best.t.c, words: best.t.words, savedH: r1((cur.finish - best.p.finish) / H), finish: best.p.finish });
    list = [...list, best.t.c]; cur = best.p;
  }
  return { levers, finish: cur.finish, shortH: r1(Math.max(0, cur.finish - target) / H) };
}
