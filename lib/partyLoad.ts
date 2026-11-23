// partyLoad - who held work up: for each party on the schedule (the
// contractor or crew a step belongs to), how much of its work was ready at
// once, how much it was working, how many jobs it was planned to work at
// once, and what that did to the jobs after them and to the finish.
//
// Every number here is counted from the record, and each is defined once:
//
//   - Ready: when the work before a job was done. "Before" is the step the
//     schedule links it to in its own work order (or on the same piece of
//     equipment); with no such link, the step planned just before it in its
//     work order. A link to another work order counts when that step is
//     another party's and was done before the job started (equipment back
//     for start-up). A link to the same party's job on other equipment is
//     the order the crew was meant to take its jobs in, not work the job
//     needs: not counted. If a step before it in its own work order was not
//     done when the job started, the two ran together and the job did not
//     wait. With nothing before it, a job is ready at its planned start. A
//     job that started is ready by then at the latest.
//   - Open: ready and not finished. Working: started and not finished.
//   - Planned at once: the number a person set for the party, else the most
//     of its jobs the schedule had going at one time (its planned windows).
//   - The time a ready job sat before it started is split three ways:
//       before its planned start: the plan said later (counted as neither);
//       after it, while the party was working its planned number or more:
//         it waited for the party;
//       after it, while the party was working fewer: nobody was on it.
//   - Held up: a job after a waiting job (by the "before" above) that was
//     ready only when the waiting job was done. It was held up by the hours
//     the waiting job lost, less any time it would have waited on other
//     work before it anyway. The hours carry on to the job after that only
//     when it started within an hour of being ready: nothing else held it.
//   - Of the late finish: the work orders that finished after the start-up's
//     planned start (else the baseline finish) set when the start-up could
//     begin. With the waits taken out, each work order finishes earlier by
//     what reached its last step; the start-up could begin when the latest
//     of them is done. The hours that saves are what came through here.
//
// Pure: no database here.

import type { AsBuilt, BuiltStep } from "@/lib/asBuiltSchedule";

const HOUR = 3_600_000;
const r1 = (n: number) => Math.round(n * 10) / 10;
/** A wait shorter than this is a hand-off, not a wait. */
export const LOAD_MIN_H = 1;
/** A job that started this soon after it was ready went as soon as it could. */
const TIGHT_H = 1;
const EQUIPMENT_TAG = /^[A-Z]{1,4}-?\d{1,5}[A-Z]{0,2}$/;
/** The equipment a work order is on ("E-12"), else the work order itself. */
export const equipmentOf = (order: string) => { const t = order.split(" - ")[0].trim(); return EQUIPMENT_TAG.test(t) ? t : order; };

export type WaitKind = "party" | "nobody" | "later" | "reason";
export interface WaitSpan { from: number; to: number; kind: WaitKind }
export interface LoadJob {
  id: string; name: string; order: string; party: string;
  /** The crew calendar the schedule put it on ("Ancon 1"), when it has one. */
  calendar: string | null;
  planStart: number | null; planFinish: number | null;
  /** When it was ready, and how that was found. */
  ready: number;
  readyBy: "before" | "handoff" | "plan" | "together";
  /** The step it was ready after, when it was a step. */
  after: { id: string; name: string; order: string; party: string } | null;
  /** Every step it was ready after (the latest of them set its ready time). */
  before: string[];
  start: number | null; finish: number | null;
  /** Hours from ready to start: waited for the party, nobody on it, the
   *  plan said later, and a reason written on it (the comment). */
  partyH: number; nobodyH: number; laterH: number; reasonH: number; said: string | null;
  spans: WaitSpan[];
}
export interface HeldJob {
  id: string; name: string; order: string; party: string;
  /** The waiting job that held it up, and the hours it was held up. */
  by: string; hours: number;
  /** 1: right after the waiting job; 2: the one after that; ... */
  depth: number;
}
export interface Downstream {
  /** The jobs after the waits that were held up by them. */
  held: HeldJob[];
  /** Hours of the late finish that came through, and in which work order's piece of it. */
  finishH: number; parts: Array<{ order: string; hours: number }>;
}
export interface LoadPoint { t: number; open: number; working: number; waiting: number; nobody: number }
export interface PartyLoad {
  party: string;
  jobs: LoadJob[];
  /** The crew calendars its jobs are on in the schedule. */
  calendars: string[];
  /** Planned at once, and where the number came from. `schedAt`: when the
   *  schedule had that many going; `sched`: what the schedule says, kept when
   *  a person set another number. */
  planned: { n: number; from: "set" | "schedule"; sched: number; schedAt: number | null };
  /** Open, working and waiting (for the party / nobody on it), stepping at each change. */
  series: LoadPoint[];
  peak: { open: number; at: number; working: number };
  mostWorking: { n: number; at: number };
  /** Jobs that waited LOAD_MIN_H or more for the party, longest first. */
  waited: LoadJob[]; partyH: number;
  /** Jobs that sat LOAD_MIN_H or more with nobody on them, longest first. */
  idle: LoadJob[]; nobodyH: number;
  /** What its waits held up, and the hours of the late finish that came
   *  through them; the same for the time nobody was on its ready jobs. */
  down: Downstream; downIdle: Downstream;
  from: number; to: number;
}
/** The finish, as the review reads it: the start-up's planned start (else
 *  the baseline finish), and each work order that finished after it. */
export interface FinishFrame { t0: number; orders: Array<{ order: string; finish: number }> }

interface Step extends BuiltStep { order: string; party: string; calendar: string | null }

const isEquipment = (order: string) => equipmentOf(order) !== order;

function readyOf(s: Step, own: Step[], byId: Map<string, Step>, links: Map<string, string[]>): Pick<LoadJob, "ready" | "readyBy" | "after" | "before"> {
  const start = s.start;
  const linked = new Set((links.get(s.id) ?? []).filter((id) => id !== s.id && byId.has(id)));
  const mine = own.filter((p) => p.id !== s.id);
  const plannedBefore = (p: Step) => linked.has(p.id) || (p.planStart != null && s.planStart != null && p.planStart < s.planStart);
  const who = (x: Step) => ({ id: x.id, name: x.name, order: x.order, party: x.party });
  // A step before it on its own work, still going when it started: they ran together.
  if (start != null) {
    const running = mine.find((p) => plannedBefore(p) && p.start != null && p.start <= start && (p.finish == null || p.finish > start));
    if (running) return { ready: start, readyBy: "together", after: who(running), before: [] };
  }
  // On its own work: the last step done before it started (the shortest wait the record allows).
  const done = mine.filter((p) => p.finish != null && (start != null ? p.finish <= start : plannedBefore(p))).map((p) => ({ p, by: "before" as const }));
  // Other work it is linked to, done before it started: another party's, or
  // any party's when one of the two is not on a piece of equipment (start-up).
  const handoff = [...linked].map((id) => byId.get(id)!).filter((p) => !mine.includes(p) && p.finish != null && (start == null || p.finish <= start)
    && (p.party !== s.party || !isEquipment(p.order) || !isEquipment(s.order))).map((p) => ({ p, by: "handoff" as const }));
  const all = [...done, ...handoff].sort((a, b) => b.p.finish! - a.p.finish!);
  if (all.length) { const [best] = all; return { ready: start != null ? Math.min(best.p.finish!, start) : best.p.finish!, readyBy: best.by, after: who(best.p), before: all.map((x) => x.p.id) }; }
  const plan = s.planStart ?? s.barStart ?? start;
  return { ready: plan != null && start != null ? Math.min(plan, start) : (plan ?? start ?? 0), readyBy: "plan", after: null, before: [] };
}

/** Each step's links with a link to a group (a summary, such as "all the
 *  maintenance work") opened out to every step in it. */
export function linksOf(milestones: Array<{ id?: string; dependsOn?: string[] | null }>, childrenByParent: Map<string, Array<{ id?: string }>>): Map<string, string[]> {
  const leaves = (id: string, seen = new Set<string>()): string[] => {
    if (seen.has(id)) return [];
    seen.add(id);
    const kids = childrenByParent.get(id) ?? [];
    return kids.length ? kids.flatMap((k) => (k.id ? leaves(k.id, seen) : [])) : [id];
  };
  const out = new Map<string, string[]>();
  for (const m of milestones) if (m.id) out.set(m.id, [...new Set((m.dependsOn ?? []).flatMap((d) => leaves(d)))]);
  return out;
}

/** The most windows open at one moment, and the moment. */
function most(xs: Array<{ from: number; to: number }>): { n: number; at: number | null } {
  const ev: Array<[number, number]> = [];
  for (const x of xs) if (x.to > x.from) { ev.push([x.from, 1]); ev.push([x.to, -1]); }
  ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let n = 0, best = 0, at: number | null = null;
  for (const [t, d] of ev) { n += d; if (n > best) { best = n; at = t; } }
  return { n: best, at };
}

export interface LoadInput {
  built: AsBuilt;
  /** Each step's party (lib/asBuiltWork's crew: who did it, else who was to). */
  partyOf: (id: string) => string;
  /** Each step's predecessors, from the schedule's links (lib linksOf: a
   *  link to a group opened out to the steps in it). */
  links?: Map<string, string[]>;
  /** A reason written on a job by a time (its comments), when one was: a
   *  wait with a reason written is put down to that, not to the party. */
  reasonAt?: (id: string, t: number) => string | null;
  /** Each step's crew calendar in the schedule (attributes.work_calendar). */
  calendarOf?: (id: string) => string | null;
  /** The number of jobs at once a person set for a party. */
  atOnce?: Record<string, number>;
  /** The finish, for the hours of it that came through each party's waits. */
  finish?: FinishFrame | null;
  /** The work that closes the event (start-up), when it began after the rest
   *  was done: with nothing else before them, its steps were ready when the
   *  last of the other work was. */
  closing?: string | null;
  /** The end of the record, for work not finished yet. */
  now?: number;
}

export interface LoadRead {
  parties: PartyLoad[];
  /** The jobs held up by any set of waits, and the hours of the finish that came through. */
  downstream: (waits: Array<{ job: LoadJob; hours: number }>) => Downstream;
}
export function partyLoads(input: LoadInput): LoadRead {
  const { built } = input;
  const links = input.links ?? new Map<string, string[]>();
  const steps: Step[] = built.orders.flatMap((o) => o.steps.map((s) => ({ ...s, order: o.name, party: input.partyOf(s.id) || "Not set", calendar: input.calendarOf?.(s.id) ?? null })));
  const byId = new Map(steps.map((s) => [s.id, s]));
  // The steps on the same work, by work order and by piece of equipment.
  const onWork = new Map<string, Step[]>();
  for (const st of steps) { const k = equipmentOf(st.order); onWork.set(k, [...(onWork.get(k) ?? []), st]); }
  const end = input.now ?? Math.max(0, ...steps.map((s) => s.finish ?? s.start ?? 0));

  // Every step: when it was ready, and what it was ready after.
  const jobs = new Map<string, LoadJob>();
  for (const s of steps) {
    const r = readyOf(s, onWork.get(equipmentOf(s.order)) ?? [], byId, links);
    jobs.set(s.id, { id: s.id, name: s.name, order: s.order, party: s.party, calendar: s.calendar, planStart: s.planStart, planFinish: s.planFinish, ...r, start: s.start, finish: s.finish, partyH: 0, nobodyH: 0, laterH: 0, reasonH: 0, said: null, spans: [] });
  }
  // The work that closes the event: ready when the last of the rest was done.
  if (input.closing) {
    const rest = steps.filter((x) => x.order !== input.closing && x.finish != null);
    for (const j of jobs.values()) {
      if (j.order !== input.closing || j.readyBy !== "plan") continue;
      const last = rest.filter((x) => j.start == null || x.finish! <= j.start).sort((a, b) => b.finish! - a.finish!);
      if (!last.length || last[0].finish! <= j.ready) continue;
      j.ready = j.start != null ? Math.min(last[0].finish!, j.start) : last[0].finish!;
      j.readyBy = "handoff"; j.after = { id: last[0].id, name: last[0].name, order: last[0].order, party: last[0].party }; j.before = last.map((x) => x.id);
    }
  }

  const parties = [...new Set(steps.map((s) => s.party))].filter((p) => p !== "Not set");
  const out: PartyLoad[] = [];
  for (const party of parties) {
    const mine = [...jobs.values()].filter((j) => j.party === party && (j.start != null || j.finish != null || j.ready <= end));
    if (!mine.length) continue;
    const sched = most(mine.filter((j) => j.planStart != null && j.planFinish != null).map((j) => ({ from: j.planStart!, to: j.planFinish! })));
    const set = input.atOnce?.[party];
    const planned = set != null && set > 0 ? { n: set, from: "set" as const, sched: sched.n, schedAt: sched.at } : { n: sched.n, from: "schedule" as const, sched: sched.n, schedAt: sched.at };
    const working = (t: number) => mine.filter((j) => j.start != null && j.start <= t && t < (j.finish ?? end)).length;
    // Split each wait at every start and finish of the party's work.
    const cuts = [...new Set(mine.flatMap((j) => [j.start, j.finish]).filter((t): t is number => t != null))].sort((a, b) => a - b);
    for (const j of mine) {
      const stop = j.start ?? end;
      if (stop <= j.ready) continue;
      const plan = j.planStart ?? j.ready;
      const spans: WaitSpan[] = [];
      const add = (from: number, to: number, kind: WaitKind) => { if (to <= from) return; const last = spans[spans.length - 1]; if (last && last.kind === kind && last.to === from) last.to = to; else spans.push({ from, to, kind }); };
      add(j.ready, Math.min(stop, Math.max(plan, j.ready)), "later");
      const from = Math.max(plan, j.ready);
      const pts = [from, ...cuts.filter((t) => t > from && t < stop), stop];
      for (let i = 0; i + 1 < pts.length; i++) {
        const said = input.reasonAt?.(j.id, pts[i + 1]) ?? null;
        if (said) { j.said = said; add(pts[i], pts[i + 1], "reason"); continue; }
        add(pts[i], pts[i + 1], planned.n > 0 && working(pts[i]) >= planned.n ? "party" : "nobody");
      }
      const h = (k: WaitKind) => r1(spans.filter((x) => x.kind === k).reduce((n, x) => n + (x.to - x.from), 0) / HOUR);
      j.spans = spans; j.partyH = h("party"); j.nobodyH = h("nobody"); j.laterH = h("later"); j.reasonH = h("reason");
    }
    // Open, working and waiting, stepping at each change.
    const marks = [...new Set(mine.flatMap((j) => [j.ready, j.start, j.finish, ...j.spans.flatMap((x) => [x.from, x.to])]).filter((t): t is number => t != null))].sort((a, b) => a - b);
    const series: LoadPoint[] = marks.map((t) => ({
      t,
      open: mine.filter((j) => j.ready <= t && t < (j.finish ?? end)).length,
      working: working(t),
      waiting: mine.filter((j) => j.spans.some((x) => x.kind === "party" && x.from <= t && t < x.to)).length,
      nobody: mine.filter((j) => j.spans.some((x) => x.kind === "nobody" && x.from <= t && t < x.to)).length,
    }));
    const peakPt = series.reduce<LoadPoint | null>((b, p) => (!b || p.open > b.open ? p : b), null);
    const workPt = series.reduce<LoadPoint | null>((b, p) => (!b || p.working > b.working ? p : b), null);
    const waited = mine.filter((j) => j.partyH >= LOAD_MIN_H).sort((a, b) => b.partyH - a.partyH);
    const idle = mine.filter((j) => j.nobodyH >= LOAD_MIN_H).sort((a, b) => b.nobodyH - a.nobodyH);
    const d1 = heldUpBy(waited.map((j) => ({ job: j, hours: j.partyH })), input.finish ?? null, jobs);
    const d2 = heldUpBy(idle.map((j) => ({ job: j, hours: j.nobodyH })), input.finish ?? null, jobs);
    // The party's own crew calendars in the schedule ("Ancon 1", "Ancon 2"), not other parties' calendars its jobs were put on.
    const word = party.toLowerCase().split(/[\s(]+/)[0];
    out.push({
      party, jobs: mine.sort((a, b) => a.ready - b.ready), calendars: [...new Set(mine.map((j) => j.calendar).filter((c): c is string => !!c && c.toLowerCase().startsWith(word)))].sort(),
      planned, series,
      peak: { open: peakPt?.open ?? 0, at: peakPt?.t ?? 0, working: peakPt?.working ?? 0 },
      mostWorking: { n: workPt?.working ?? 0, at: workPt?.t ?? 0 },
      waited, partyH: r1(waited.reduce((n, j) => n + j.partyH, 0)),
      idle, nobodyH: r1(idle.reduce((n, j) => n + j.nobodyH, 0)),
      down: d1, downIdle: d2,
      from: Math.min(...mine.map((j) => j.ready)), to: Math.max(...mine.map((j) => j.finish ?? end)),
    });
  }
  const parties2 = out.sort((a, b) => b.down.finishH - a.down.finishH || b.partyH - a.partyH || b.nobodyH - a.nobodyH || a.party.localeCompare(b.party));
  return { parties: parties2, downstream: (waits) => heldUpBy(waits, input.finish ?? null, jobs) };
}

/** The jobs after the waiting jobs that were held up by them, and the hours
 *  of the late finish that came through, by work order. Taken in the order
 *  jobs were ready: a job is held up when the latest of the steps it was
 *  ready after would have been done sooner (each by what it gained); it
 *  passes that on only when it started within an hour of being ready. */
function heldUpBy(waits: Array<{ job: LoadJob; hours: number }>, fin: FinishFrame | null, jobs: Map<string, LoadJob>): Downstream {
  const lost = new Map(waits.map((w) => [w.job.id, w.hours]));
  // How much sooner each job would have been done.
  const earlier = new Map<string, number>();
  const held: HeldJob[] = [];
  const order = [...jobs.values()].sort((a, b) => a.ready - b.ready || (a.finish ?? Infinity) - (b.finish ?? Infinity));
  for (const s of order) {
    let push = 0;
    if (s.before.length) {
      const sooner = Math.max(...s.before.map((id) => { const p = jobs.get(id)!; return (p.finish ?? s.ready) - (earlier.get(id) ?? 0) * HOUR; }));
      push = r1(Math.max(0, (s.ready - sooner) / HOUR));
    }
    if (push >= LOAD_MIN_H && !lost.has(s.id)) {
      // The waiting job it traces back to, through what set each ready time.
      let x: LoadJob | undefined = s, depth = 0;
      while (x && !lost.has(x.id) && x.after && depth < 200) { x = jobs.get(x.after.id); depth++; }
      if (x && lost.has(x.id)) held.push({ id: s.id, name: s.name, order: s.order, party: s.party, by: x.id, hours: push, depth });
    }
    const own = lost.get(s.id) ?? 0;
    const tight = s.start != null && (s.start - s.ready) / HOUR <= TIGHT_H;
    const e = own > 0 ? own : tight ? push : 0;
    if (e > 0) earlier.set(s.id, e);
  }
  const parts: Array<{ order: string; hours: number }> = [];
  let finishH = 0;
  if (fin && fin.orders.length) {
    const orders = [...fin.orders].sort((a, b) => b.finish - a.finish);
    const top = orders[0].finish;
    // With the waits out, the start-up could begin when the latest work order was done.
    let after = fin.t0;
    for (const o of orders) {
      const last = [...jobs.values()].filter((j) => j.order === o.order && j.finish != null).sort((a, b) => b.finish! - a.finish!)[0];
      after = Math.max(after, o.finish - (last ? earlier.get(last.id) ?? 0 : 0) * HOUR);
    }
    finishH = r1(Math.max(0, (top - after) / HOUR));
    // The hours saved, in the pieces of the late finish they fall in (each work order's piece runs from the one before it).
    orders.forEach((o, i) => {
      const lo = Math.max(fin.t0, orders[i + 1]?.finish ?? fin.t0), h = r1(Math.max(0, (o.finish - Math.max(lo, after)) / HOUR));
      if (h > 0) parts.push({ order: o.order, hours: h });
    });
  }
  return { held: held.sort((a, b) => a.depth - b.depth || b.hours - a.hours), finishH, parts };
}
