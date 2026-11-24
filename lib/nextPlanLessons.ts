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
//   - Crews (CREW_RULE, lib/nextPlan): every crew held at its size for the
//     whole job. Said once, with what this year shows about it (a crew
//     handed more jobs at once than it ever worked at a time); not a lesson
//     to leave out.
// Then the target (this year's planned finish): when the schedule still
// misses it, the changes that pull the finish in, one at a time, the one
// that saves the most first: start sooner, nights too (by a night shift
// already on site), another crew for the whole job. More time is said only
// when none of them closes the gap.
//
// Pure: no database here.

import type { Milestone, MilestoneNote } from "@/types/schema";
import type { AsBuilt } from "@/lib/asBuiltSchedule";
import type { AsBuiltWork } from "@/lib/asBuiltWork";
import { shiftKey } from "@/lib/asBuiltWork";
import type { ShiftTimes } from "@/lib/shiftReport";
import { crewFlows, overloaded, type CrewFlow } from "@/lib/crewFlow";
import { causeOfText } from "@/lib/postEventReview";
import { nextPlan, nightCrews, dayNumber, mostAtOnce, CREW_RULE, OFFSITE_STEP, type NextPlan, type PlanChange } from "@/lib/nextPlan";
export { OFFSITE_STEP, mostAtOnce };

const H = 3_600_000;
const r1 = (n: number) => Math.round(n * 10) / 10;
const ms = (v: unknown): number => (v == null ? NaN : typeof v === "number" ? v : Date.parse(String(v)));

/** A step that is the trip itself: out for service, hot-shotted to a shop. */
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
  /** The schedule's own rule, said here: nothing to leave out. */
  rule?: boolean;
}

type Input = { built: AsBuilt; work: AsBuiltWork; milestones: Milestone[]; tz: string; times: ShiftTimes };

const change = (id: string, c: Record<string, unknown>): PlanChange => ({ id, said: "", at: 0, ...c } as PlanChange);
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

  // When the unit is down and its equipment can be opened: its own phase's
  // shutdown's last activity (Phase 1's work never waits for Phase 2's
  // shutdown), else the phase's first activity, else the first shift.
  const phaseOf = new Map(built.orders.map((o) => [o.key, o.phase ?? null]));
  const shut = base.acts.filter((a) => isShutdown(built.orders.find((o) => o.key === a.order)?.name ?? ""));
  const readyFor = (id: string): number => {
    const ph = phaseOf.get(stepOf.get(id)?.o.key ?? "") ?? null;
    const mine = shut.filter((a) => (phaseOf.get(a.order) ?? null) === ph);
    if (mine.length) return Math.max(...mine.map((a) => a.finish));
    const acts = base.acts.filter((a) => (phaseOf.get(a.order) ?? null) === ph);
    if (ph != null && acts.length) return Math.min(...acts.map((a) => a.start));
    return shut.length ? Math.max(...shut.map((a) => a.finish)) : base.start;
  };

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
    if (chain.length) cs.push(change(`${lid}:floor`, { kind: "floor", target: { ids: chain }, at: readyFor(id) }));
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
          change(`${lid}:floor`, { kind: "floor", target: { ids: [`${w.id}:1`, ...chain] }, at: readyFor(w.id) }),
          change(`${lid}:first`, { kind: "first", target: { ids: [...chain, `${w.id}:1`, `${w.id}:w`] } }),
        ],
      });
      break;
    }
  }

  // (Links the work didn't wait on are the schedule's own rule now: it
  // follows the order the work was really done in.)

  // ── Crews: every crew held at its size (CREW_RULE) ──
  // Said once, with what this year shows: a crew handed more jobs at once
  // than it ever worked at a time.
  const flows = input.flows ?? crewFlows(built, work, new Map(input.milestones.filter((m) => m.id).map((m) => [m.id!, m.dependsOn ?? []])));
  const sizes = Object.entries(base.sizes);
  if (sizes.length) {
    const saw: string[] = [];
    for (const f of flows) {
      const c = work.crews.find((x) => x.crew === f.crew);
      // What it really worked at once: at its busiest moment, or in its busiest shift.
      const k = Math.max(1, f.peak.working.length, c?.mostMoved ?? 1);
      if (f.peak.open <= k || !(overloaded(f) || f.waitH >= 24)) continue;
      // Only what this view can show for itself; how long jobs waited and
      // what the plan gave it are the post-event review's to say.
      saw.push(`${f.peak.open} of ${f.crew}'s jobs were ready at once this year, and it never worked more than ${k} at a time.`);
    }
    const n = (from: string) => sizes.filter(([, s]) => s.from === from).length;
    const counts = [[n("plan"), "from a staffing plan"], [n("counted"), "from a head count"], [n("worked"), "from the most jobs each worked at once this year"], [n("person"), "set by you"]].filter(([k]) => Number(k) > 0).map(([k, w]) => `${k} ${w}`);
    out.unshift({
      id: "crews:held", area: "contractors", rule: true, acts: [], changes: [],
      title: "Every crew held at its size for the whole job",
      saw: [...saw, `${sizes.length} crew${sizes.length === 1 ? "" : "s"} sized: ${counts.join(", ")}. Each one's size and where it came from is under Crews below.`].join(" "),
      does: CREW_RULE,
    });
  }
  return out;
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
    if (skipped.has(l.id) || l.rule) continue;
    const others = lessonChanges(lessons, new Set([...skipped, l.id]));
    const without = nextPlan({ ...input, changes: [...others, ...(l.honest ?? []), ...person] });
    out[l.id] = r1((without.finish - plan.finish) / H);
  }
  return out;
}

export interface Lever { change: PlanChange; words: string; savedH: number; finish: number }

/** Another crew brought for the whole job (a "more" change), in words, from
 *  the plan with it in: its days on site, what it adds every shift, and what
 *  that costs in man-hours over the whole job (CREW_RULE: never mid-job). */
export function moreWords(p: NextPlan, crew: string, tz: string): string {
  const s = p.sizes[crew];
  const busy = (p.jobs[crew] ?? []).map((n) => n > 0);
  const i0 = busy.indexOf(true), i1 = busy.lastIndexOf(true);
  if (!s || i0 < 0) return `Bring another ${crew} crew for the whole job`;
  const day = (i: number) => dayNumber(p, p.shifts[i].start, tz);
  const span = `Day ${day(i0)} to Day ${day(i1)}`;
  // Every shift from its first to its last that it works.
  const on = p.shifts.slice(i0, i1 + 1).filter((w) => (w.kind === "night" ? s.works.night : s.works.day));
  if (s.hands && s.perCrew) {
    const add = { day: s.hands.day != null ? s.perCrew.day ?? 0 : 0, night: s.hands.night != null ? s.perCrew.night ?? 0 : 0 };
    const mh = on.reduce((n, w) => n + (w.kind === "night" ? add.night : add.day) * ((w.end - w.start) / H), 0);
    const what = [add.day ? `${add.day} more on the tools every day shift` : "", add.night ? `${add.night} more every night shift` : ""].filter(Boolean).join(" and ");
    return `Bring another ${crew} crew for the whole job, ${span}: ${what} (${Math.round(mh).toLocaleString("en-US")} man-hours)`;
  }
  const n = s.jobs ?? 1;
  return `Bring another ${crew} crew for the whole job, ${span}: ${n} jobs at a time instead of ${n - 1}, one more crew on each of its ${on.length} shifts (its hands aren't known)`;
}

/** What pulls the finish in to `target`, one change at a time, the one that
 *  saves the most first; stops at the target or when nothing saves half an
 *  hour. `orderName`: each work order's name. No crew grows mid-job: nights
 *  too only by a crew's night shift already on site, and any more crew is
 *  brought for the whole job (CREW_RULE). */
export function toTarget(input: Input, changes: PlanChange[], plan: NextPlan, target: number, orderName: (key: string) => string): { levers: Lever[]; finish: number; shortH: number } {
  const levers: Lever[] = [];
  let cur = plan, list = [...changes];
  for (let round = 0; round < 4 && cur.finish > target + 30 * 60_000; round++) {
    const byId = new Map(cur.acts.map((a) => [a.id, a]));
    const path = cur.driving.map((id) => byId.get(id)).filter((a): a is NonNullable<typeof a> => !!a);
    const orders = [...new Set(path.map((a) => a.order))];
    const nights = nightCrews(cur);
    const tries: Array<{ c: PlanChange; words: string; crew?: string }> = [];
    for (const o of orders) {
      if (path.some((a) => a.order === o && a.floor != null && a.start <= a.floor + 60_000)) tries.push({ c: change(`lever:asap:${o}:${round}`, { kind: "asap", target: { order: o } }), words: `Start ${orderName(o)} as soon as what comes before it is done, not on this year's planned date` });
      const days = cur.acts.filter((a) => a.order === o && a.cal === "day" && nights.has(a.crew));
      const by = [...new Set(days.map((a) => a.crew))];
      if (days.length) tries.push({ c: change(`lever:nights:${o}:${round}`, { kind: "nights", target: { ids: days.map((a) => a.id) }, on: true }), words: `Run ${orderName(o)} on nights too, with ${by.join(" and ")}'s night shift already on site (its ${r1(days.reduce((n, a) => n + a.hours, 0))} h of work runs days and nights, no one added)` });
    }
    for (const crew of new Set(path.filter((a) => a.heldForCrew).map((a) => a.crew))) {
      if (!cur.sizes[crew]) continue;
      tries.push({ c: change(`lever:more:${crew}:${round}`, { kind: "more", crew, crews: 1 }), words: "", crew });
    }
    let best: { p: NextPlan; t: (typeof tries)[number] } | null = null;
    for (const t of tries) {
      const p = nextPlan({ ...input, changes: [...list, t.c] });
      if (p.finish < (best?.p.finish ?? cur.finish) - 30 * 60_000) best = { p, t };
    }
    if (!best) break;
    const words = best.t.crew ? moreWords(best.p, best.t.crew, input.tz) : best.t.words;
    levers.push({ change: best.t.c, words, savedH: r1((cur.finish - best.p.finish) / H), finish: best.p.finish });
    list = [...list, best.t.c]; cur = best.p;
  }
  return { levers, finish: cur.finish, shortH: r1(Math.max(0, cur.finish - target) / H) };
}
