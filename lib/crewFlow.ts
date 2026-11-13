// crewFlow - where work waited between crews.
//
// A work order passes from crew to crew: one opens the equipment, another
// cleans or inspects it, the first closes it. This reads the as-built record
// for every such hand-off: when the job was open for the next crew, when
// that crew started it, and what the crew was on meanwhile. For each crew it
// gives the hours work sat waiting for it, the most jobs it had open at
// once (against the most the plan gave it), the jobs it ran at the same
// time, and what the same queue would have waited with a second crew.
//
// Nothing here is assumed. The second-crew figure is arithmetic on the
// record's own times: the same jobs, taken in the order they opened, each
// at the hours it actually took.
//
// Pure: no database here.

import type { AsBuilt, BuiltStep } from "@/lib/asBuiltSchedule";
import type { AsBuiltWork } from "@/lib/asBuiltWork";

const HOUR = 3_600_000;
const r1 = (n: number) => Math.round(n * 10) / 10;
/** A wait shorter than this is a normal hand-off, not a queue. */
export const MIN_WAIT_H = 4;

export interface HandedJob {
  id: string; name: string; order: string; crew: string;
  /** The crew whose step it followed in the work order. */
  from: string;
  /** The step it is taken to have followed: the job was ready when that was done. */
  afterId: string; after: string; afterOrder: string;
  /** How that step was arrived at: the schedule's own link inside the work
   *  order, a person's correction, or (a guess) the step before it in the
   *  work order's planned sequence. */
  basis: "linked" | "corrected" | "guessed";
  /** Steps a person may pick instead: finished before this one started, on the same equipment. */
  candidates: Array<{ id: string; name: string; order: string }>;
  /** When that step finished: from then the job was open for this crew. */
  openedAt: number; startedAt: number; finishedAt: number;
  /** Hours it sat open before this crew started it. */
  waitH: number;
  /** Hours of work planned; hours it was open, start to finish (not hours worked). */
  plannedH: number; tookH: number;
  /** Shifts on which progress was logged on it (the as-built record). */
  workedShifts: number;
  /** Started after (+) or before (-) its planned start, hours. */
  lateStartH: number | null;
  /** Opened before (+) or after (-) the plan had it open, hours. */
  openedEarlyH: number | null;
  /** Other work orders this crew logged work on while this one waited. */
  crewOn: string[];
}
export interface CrewFlow {
  crew: string;
  /** Every job handed to it by another crew, in the order they opened. */
  jobs: HandedJob[];
  /** Hours those jobs sat before it started them, in all. */
  waitH: number;
  /** The ones that sat MIN_WAIT_H or more, longest first. */
  waited: HandedJob[];
  plannedH: number; tookH: number;
  /** The most it had open at once (being worked or waiting), and when. */
  peak: { open: number; at: number; working: HandedJob[]; waiting: HandedJob[] };
  /** The most the plan gave it at once. */
  plannedPeak: number;
  /** The most that opened inside any 8 hours. */
  burst: { jobs: HandedJob[]; hours: number };
  /** Jobs it ran at the same time that together took half again their plan or more. */
  together: HandedJob[][];
  /** The same jobs taken as they opened, each at the hours it took: hours of
   *  waiting with one crew working without a break, and with two. */
  queue: { one: number; two: number };
  /** The crew most of these jobs came from. */
  feeder: string | null;
  /** That crew's planned hours of work finished, by day shift, across the
   *  days this crew's jobs were open ("10/27 day" keys). */
  feederOutput: Array<{ key: string; earned: number }>;
}

/** The hours the same queue waits with n crews: each job starts when it
 *  opened or when a crew is free, whichever is later. */
function queueWait(jobs: HandedJob[], n: number): number {
  const free = Array<number>(n).fill(0);
  let wait = 0;
  for (const j of jobs) {
    let k = 0;
    for (let i = 1; i < n; i++) if (free[i] < free[k]) k = i;
    const start = Math.max(j.openedAt, free[k]);
    wait += (start - j.openedAt) / HOUR;
    free[k] = start + j.tookH * HOUR;
  }
  return r1(wait);
}
/** The most intervals open at one moment, and the moment. */
function peakOf<T>(items: T[], from: (x: T) => number, to: (x: T) => number): { open: number; at: number; set: T[] } {
  const ev: Array<[number, number, T]> = [];
  for (const x of items) { ev.push([from(x), 1, x]); ev.push([to(x), -1, x]); }
  ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const open = new Set<T>();
  let best = { open: 0, at: 0, set: [] as T[] };
  for (const [t, d, x] of ev) {
    if (d > 0) open.add(x); else open.delete(x);
    if (open.size > best.open) best = { open: open.size, at: t, set: [...open] };
  }
  return best;
}

/** The step a started step followed in its work order (steps in planned
 *  order). The schedule's own links inside the work order say so when it has
 *  them; a link to another work order is only the order a crew was meant to
 *  take its jobs in. Without one, it is the latest finish among the steps
 *  planned before it that had started before it did. `null`: nothing before
 *  it, or what it followed is not finished. */
export function stepBefore(steps: BuiltStep[], i: number, dependsOn: Map<string, string[]>): BuiltStep | null {
  const s = steps[i];
  if (s.start == null) return null;
  const linked = (dependsOn.get(s.id) ?? []).map((id) => steps.find((p) => p.id === id)).filter((p): p is BuiltStep => !!p);
  let prev: BuiltStep | null = null;
  if (linked.length) { if (linked.some((p) => p.finish == null)) return null; for (const p of linked) if (!prev || p.finish! > prev.finish!) prev = p; }
  else for (const p of steps.slice(0, i)) if (p.finish != null && (p.start ?? p.finish) <= s.start && (!prev || p.finish > prev.finish!)) prev = p;
  return prev;
}

/** `dependsOn`: each step's predecessors, from the schedule's own links. */
export function crewFlows(built: AsBuilt, work: AsBuiltWork, dependsOn: Map<string, string[]> = new Map(), readyAfter: Record<string, string> = {}): CrewFlow[] {
  // Every finished step, to look up a person's correction and the steps on the same equipment.
  const tagOf = (order: string) => order.split(" - ")[0].trim();
  const finished = built.orders.flatMap((o) => o.steps.filter((p) => p.finish != null).map((p) => ({ p, order: o.name })));
  const byStep = new Map(finished.map((x) => [x.p.id, x]));
  const crewOf = (id: string) => work.steps.get(id)?.crew ?? "Not set";
  const orderOf = new Map<string, string>();
  for (const o of built.orders) for (const s of o.steps) orderOf.set(s.id, o.name);
  const byCrew = new Map<string, HandedJob[]>();
  const plannedBy = new Map<string, Array<{ from: number; to: number }>>();

  for (const o of built.orders) {
    const steps = [...o.steps].sort((a, b) => (a.planStart ?? 0) - (b.planStart ?? 0));
    steps.forEach((s, i) => {
      const crew = crewOf(s.id);
      // The plan's own hand-off: the step planned just before it.
      const before = steps[i - 1];
      if (before && crewOf(before.id) !== crew && before.planFinish != null && s.planFinish != null) {
        if (!plannedBy.has(crew)) plannedBy.set(crew, []);
        plannedBy.get(crew)!.push({ from: Math.min(before.planFinish, s.planStart ?? before.planFinish), to: s.planFinish });
      }
      if (s.start == null || s.finish == null) return;
      // A person's correction wins; else the schedule's link in this work order; else the step planned before it.
      const picked = readyAfter[s.id] ? byStep.get(readyAfter[s.id]) : undefined;
      const linked = (dependsOn.get(s.id) ?? []).some((id) => steps.some((p) => p.id === id));
      const prev = picked ? picked.p : stepBefore(steps, i, dependsOn);
      if (!prev || (!picked && crewOf(prev.id) === crew)) return;
      const prevOrder = picked ? picked.order : o.name;
      const openedAt = Math.min(prev.finish!, s.start);
      const candidates = finished.filter((x) => x.p.id !== s.id && tagOf(x.order) === tagOf(o.name) && x.p.finish! <= s.start! && crewOf(x.p.id) !== crew).sort((a, b) => b.p.finish! - a.p.finish!).slice(0, 12).map((x) => ({ id: x.p.id, name: x.p.name, order: x.order }));
      if (!byCrew.has(crew)) byCrew.set(crew, []);
      byCrew.get(crew)!.push({
        id: s.id, name: s.name, order: o.name, crew, from: crewOf(prev.id), afterId: prev.id, after: prev.name, afterOrder: prevOrder, basis: picked ? "corrected" : linked ? "linked" : "guessed", candidates,
        openedAt, startedAt: s.start, finishedAt: s.finish,
        waitH: r1((s.start - openedAt) / HOUR), plannedH: r1(s.plannedH), tookH: r1(s.elapsedH ?? (s.finish - s.start) / HOUR), workedShifts: work.steps.get(s.id)?.worked.length ?? 0,
        lateStartH: s.planStart != null ? r1((s.start - s.planStart) / HOUR) : null,
        openedEarlyH: prev.planFinish != null ? r1((prev.planFinish - prev.finish!) / HOUR) : null, crewOn: [],
      });
    });
  }

  // What each crew logged work on, shift by shift (work order names).
  const on = new Map<string, Map<string, Set<string>>>();
  for (const w of work.steps.values()) for (const k of w.worked) {
    if (!on.has(w.crew)) on.set(w.crew, new Map());
    const m = on.get(w.crew)!;
    if (!m.has(k)) m.set(k, new Set());
    m.get(k)!.add(orderOf.get(w.id) ?? "");
  }
  const keyOf = (w: AsBuiltWork["shifts"][number]) => `${w.dayKey}:${w.kind}`;

  const out: CrewFlow[] = [];
  for (const [crew, list] of byCrew) {
    const jobs = list.sort((a, b) => a.openedAt - b.openedAt || a.startedAt - b.startedAt);
    for (const j of jobs) {
      if (j.waitH < MIN_WAIT_H) continue;
      const seen = new Set<string>();
      for (const w of work.shifts) if (w.start < j.startedAt && w.end > j.openedAt) for (const n of on.get(crew)?.get(keyOf(w)) ?? []) if (n && n !== j.order) seen.add(n);
      j.crewOn = [...seen];
    }
    const pk = peakOf(jobs, (j) => j.openedAt, (j) => j.finishedAt);
    // The most that opened inside any 8 hours.
    let burst: HandedJob[] = [];
    for (let i = 0; i < jobs.length; i++) { const run = jobs.filter((j) => j.openedAt >= jobs[i].openedAt && j.openedAt - jobs[i].openedAt <= 8 * HOUR); if (run.length > burst.length) burst = run; }
    // Run at the same time (two hours or more together), one at twice its plan or more.
    const together: HandedJob[][] = [];
    const used = new Set<string>();
    for (let i = 0; i < jobs.length; i++) for (let k = i + 1; k < jobs.length; k++) {
      const a = jobs[i], b = jobs[k];
      const both = (Math.min(a.finishedAt, b.finishedAt) - Math.max(a.startedAt, b.startedAt)) / HOUR;
      if (both < 2 || used.has(a.id) || used.has(b.id)) continue;
      if (a.plannedH + b.plannedH > 0 && a.tookH + b.tookH >= 1.5 * (a.plannedH + b.plannedH)) { together.push([a, b]); used.add(a.id); used.add(b.id); }
    }
    const from = new Map<string, number>();
    for (const j of jobs) from.set(j.from, (from.get(j.from) ?? 0) + 1);
    const feeder = [...from.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    const first = Math.min(...jobs.map((j) => j.openedAt)), last = Math.max(...jobs.map((j) => j.finishedAt));
    const fw = feeder ? work.crews.find((c) => c.crew === feeder) : undefined;
    const feederOutput = fw ? work.shifts.filter((w) => w.kind === "day" && w.end > first && w.start < last + 24 * HOUR && fw.byShift[keyOf(w)]).map((w) => ({ key: keyOf(w), earned: r1(fw.byShift[keyOf(w)].earned) })) : [];
    out.push({
      crew, jobs, waitH: r1(jobs.reduce((n, j) => n + j.waitH, 0)),
      waited: jobs.filter((j) => j.waitH >= MIN_WAIT_H).sort((a, b) => b.waitH - a.waitH),
      plannedH: r1(jobs.reduce((n, j) => n + j.plannedH, 0)), tookH: r1(jobs.reduce((n, j) => n + j.tookH, 0)),
      peak: { open: pk.open, at: pk.at, working: pk.set.filter((j) => j.startedAt <= pk.at), waiting: pk.set.filter((j) => j.startedAt > pk.at) },
      plannedPeak: peakOf(plannedBy.get(crew) ?? [], (x) => x.from, (x) => x.to).open,
      burst: { jobs: burst, hours: burst.length > 1 ? r1((burst[burst.length - 1].openedAt - burst[0].openedAt) / HOUR) : 0 },
      together, queue: { one: queueWait(jobs, 1), two: queueWait(jobs, 2) }, feeder, feederOutput,
    });
  }
  return out.sort((a, b) => b.waitH - a.waitH);
}

/** A crew that could not keep up with what was handed to it: more open at
 *  once than the plan gave it (three or more), three or more jobs that sat,
 *  a day or more of waiting in all, and a second crew would have cut the
 *  waiting by half or more. */
export function overloaded(f: CrewFlow): boolean {
  return f.peak.open >= 3 && f.peak.open > f.plannedPeak && f.waited.length >= 3 && f.waitH >= 24 && f.queue.one >= 12 && f.queue.two <= f.queue.one / 2;
}
