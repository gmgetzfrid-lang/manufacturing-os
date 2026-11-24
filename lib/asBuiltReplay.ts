// asBuiltReplay - the job replayed on what really happened: the same work,
// the same crews, the same shutdown and start-up, only timed better. The
// first step of the schedule suggested for next time (docs/next-update.md,
// section 6): how the job could have run by sequencing alone, before any
// time or people are added.
//
// The rules, in this order, all from the record:
//   - Each step takes the shifts it was really worked (lib/asBuiltWork: a
//     shift its progress moved), on the calendar its crew really worked it
//     (lib/nextPlan planActivities: days, nights or both). A day step that
//     ran into a night as overtime may use as many nights as it really did.
//   - Found and added work starts no earlier than the shift it really
//     started (the shift it was found, when no start was recorded).
//   - CAPACITY_RULE: a crew carries at most the most steps it really worked
//     in one shift of this job, days and nights apart, and works only
//     between its first and last shift of each kind on this job. "In
//     progress" is read as worked that shift: a step open with nothing
//     logged had nobody on it. Never more people, never a new crew, never
//     an extra shift. Steps outside the scope keep their crews' room as they
//     really used it.
//   - Only the links the work really needed (planActivities: a link it
//     waited on stays, one it didn't gives way). A trip off site keeps its
//     real clock time, and a wait with a recorded reason (parts, material,
//     vendor, inspection, permit, weather, a hold: read from what was
//     written, and from the post-event review when given) keeps its real
//     length; neither is pulled in.
//   - What it may take out: a wait with nothing logged and no reason
//     recorded, and shifts a step sat ready while its crew had room. List
//     scheduling, shift by shift: a crew finishes what it started, then its
//     room goes to the ready step with the least room before it would move
//     the finish (the work order that holds the finish first), then the
//     earliest planned. If that order doesn't beat the real finish, the
//     order the work was really done in is tried.
//   - The shutdown stays as it ran. Start-up starts once every work order
//     is done; operations run it around the clock, with no crew limit.
//   - Never a saving the rules don't produce: a replay that doesn't beat the
//     real finish and moves anything later stands down, and the job is shown
//     as it ran.
// One-off delays (a leak, a material shortfall, a failure, a trip off site)
// can be taken out one at a time as a what-if (oneOffDelays, `without`).
//
// Pure: no database here.

import type { Milestone, MilestoneNote } from "@/types/schema";
import type { AsBuilt, BuiltOrder, BuiltStep } from "@/lib/asBuiltSchedule";
import { shiftKey, type AsBuiltWork, type WaitRun } from "@/lib/asBuiltWork";
import { planActivities, isShutdown, isStartUp, OFFSITE_STEP, type Cal } from "@/lib/nextPlan";
import { nextShift, type ShiftTimes, type ShiftWindow } from "@/lib/shiftReport";
import { discoveryOf } from "@/lib/discovery";
import { causeOfText, unexplained, whenWord, type CauseId, type Finding, type StuckJob } from "@/lib/postEventReview";

const H = 3_600_000;
const MIN = 60_000;
const r1 = (n: number) => Math.round(n * 10) / 10;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** Every item, in full. */
const list = (xs: string[]) => (xs.length <= 2 ? xs.join(" and ") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
const hoursWord = (h: number) => (h >= 36 ? `${r1(h / 24)} days` : `${r1(h)} h`);
const toMs = (v: unknown): number | null => { const t = v == null || v === "" ? NaN : typeof v === "number" ? v : Date.parse(String(v)); return Number.isFinite(t) ? t : null; };

/** The rule, said the same way on screen. */
export const CAPACITY_RULE = "Each crew carries at most the most steps it really worked in one shift of this job, days and nights apart, and only between its first and last shift of each kind on this job: never more people, never a new crew, never an extra shift.";

/** What the replay reads from the post-event review (lib/postEventReview),
 *  when it is given: the causes it put on each stuck shift, and the
 *  findings that name a one-off delay. */
export interface ReviewPart {
  findings?: Array<Pick<Finding, "key" | "title" | "because" | "status">>;
  stuck?: StuckJob[];
}

export interface ReplayInput {
  built: AsBuilt;
  work: AsBuiltWork;
  milestones: Milestone[];
  tz: string;
  times: ShiftTimes;
  /** Step ids in scope (a phase's steps); every step when left out. */
  phaseIds?: Iterable<string> | null;
  /** One-off delays to take out (ids from oneOffDelays). */
  without?: string[];
  /** The steps' comments: read for why work that sat ready didn't start. */
  notes?: MilestoneNote[];
  /** The post-event review: the causes it gives, and the findings that
   *  name a one-off delay. */
  review?: ReviewPart | null;
}

/** work: placed shift by shift by the replay. as ran: the shutdown.
 *  off site: its real clock time. start-up: around the clock once every
 *  work order is done. */
export type ReplayHow = "work" | "as ran" | "off site" | "start-up";

export interface ReplayStep {
  id: string;
  name: string;
  /** The work order (as-built order key) and its name. */
  order: string;
  orderName: string;
  crew: string;
  cal: Cal;
  how: ReplayHow;
  /** The shifts it is worked in the replay (shift keys). */
  shifts: string[];
  start: number | null;
  finish: number | null;
  real: { shifts: string[]; start: number | null; finish: number | null };
}

export interface ReplayMove {
  stepId: string;
  stepName: string;
  /** The work order's name. */
  order: string;
  crew: string;
  wasStart: number;
  nowStart: number;
  wasFinish: number;
  nowFinish: number;
  /** Hours sooner this step is done (negative: later). */
  savedH: number;
  /** One plain sentence, from what was recorded. */
  why: string;
}

export interface OneOffDelay {
  id: string;
  /** In plain words, from the record, with what was written. */
  label: string;
  /** The same, short: what it did, without the quote ("Hydro test (E-12)
   *  waited 2 shifts"). What was written is in `said`. */
  short: string;
  /** The steps it is on. */
  stepIds: string[];
  /** The work order's name (the first step's). */
  order: string;
  kind: "wait" | "off site" | "ready" | "ran long";
  cause: CauseId | "hold" | "failure";
  /** Shifts it held the work (its counted wait shifts; off site: shifts
   *  spanned; ran long: the shifts worked past plan). */
  shifts: number;
  /** Wall-clock hours of it. */
  hours: number;
  /** What was written about it. */
  said: string | null;
  from: "comment" | "step name" | "review";
}

export interface Replay {
  /** The real finish of the work in scope (null: nothing is done yet). */
  actualFinish: number | null;
  replayFinish: number | null;
  /** Hours sooner than the real finish, rounded to 0.1 (0 when not sooner). */
  savedH: number;
  /** Which order of work it took: the rule's (critical first), the order it
   *  was really done in, or the job as it ran (nothing could be bettered). */
  sequence: "critical first" | "as really done" | "as ran";
  steps: ReplayStep[];
  /** The shifts the replay and the real job run across. */
  shifts: ShiftWindow[];
  moves: ReplayMove[];
  /** Each crew's room per shift (CAPACITY_RULE), and whether it had any
   *  head count recorded. */
  capacity: Record<string, { day: number; night: number; counted: boolean }>;
  /** What was kept at its real time or length, and why. */
  kept: string[];
  /** What the replay can't know. */
  limits: string[];
  /** Steps with work logged but not marked done: kept as they ran, to the
   *  end of their last logged shift, never moved. */
  notDone: string[];
  /** The result in a sentence. */
  said: string;
  /** With `without`: the finish with those delays in and taken out. */
  whatIf: { without: Array<{ id: string; label: string }>; finishWith: number | null; finishWithout: number | null; savedH: number; said: string } | null;
}

/** A step with its work order, once: "Shell Side Hydro (E-12 - ...)", but
 *  a step named as its work order is said once. */
const named = (step: string, order: string) => (step.trim() === order.trim() ? step : `${step} (${order})`);

/** The shifts a step's planned hours fill (at least one), on shifts the
 *  length of the first it was worked in. */
function plannedUnits(shifts: ShiftWindow[], idx: number[], planHours: number): number {
  const len = idx.length ? (shifts[idx[0]].end - shifts[idx[0]].start) / H : 12;
  return Math.max(1, Math.ceil(planHours / (len || 12) - 1e-6));
}

// ─── Reasons ─────────────────────────────────────────────────────────

const HOLD = /\b(on hold|held|holds?|hold(ing)? (it|for|point))\b/i;
const INSPECTION = /\binspect\w*/i;
/** A failure of the work or the kit: a one-off. */
const FAIL = /\b(fail(ed|ure|s)?|broke(n)?|break ?down|leak\w*|short ?fall|shortage|ran short|short of)\b/i;
const ONE_OFF = new Set<string>(["material", "test", "offsite"]);

type Reason = { cause: CauseId | "hold"; said: string };
/** The reason a line written on the work gives for it waiting, if any. */
function reasonIn(text: string): Reason | null {
  const t = text.trim();
  if (!t) return null;
  const c = causeOfText(t);
  if (c) return { cause: c, said: t };
  if (HOLD.test(t)) return { cause: "hold", said: t };
  if (INSPECTION.test(t)) return { cause: "other_crew", said: t };
  return null;
}
/** The latest of the lines that gives a reason. */
function reasonOf(lines: string[]): Reason | null {
  for (const l of [...lines].reverse()) { const r = reasonIn(l); if (r) return r; }
  return null;
}
const isOneOff = (r: Reason | null) => !!r && (ONE_OFF.has(r.cause) || FAIL.test(r.said));
const causeOf = (r: Reason): OneOffDelay["cause"] => (ONE_OFF.has(r.cause) ? r.cause : FAIL.test(r.said) ? "failure" : r.cause);

/** The text names a tag or a name as a word ("E-12", not "E-120"). */
const names = (text: string, what: string) => !!what && new RegExp(`(^|[^A-Za-z0-9-])${what.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9])`, "i").test(text);
const TAG = /^[A-Z]{1,4}-?\d{1,5}[A-Z]{0,2}\b/;
const tagOf = (order: string) => { const head = order.split(" - ")[0].trim(); return TAG.test(head) ? head.match(TAG)![0] : null; };

// ─── The record, read once ───────────────────────────────────────────

interface Run { id: string; step: string; run: WaitRun; prev: number; next: number; hours: number; reason: Reason | null }
interface Node {
  id: string; name: string; orderKey: string; orderName: string; crew: string; cal: Cal; how: ReplayHow;
  inPlan: boolean;
  preds: string[];
  /** It really started in the shift the last of what it waited on
   *  finished: it may start in the shift its links finish. */
  same: boolean;
  /** Earliest shift index, and the time it came from. */
  floor: number; floorT: number | null;
  /** Its work, split where a kept wait holds it: units, and for each part
   *  after the first, the real shift it resumed (not before) and the shifts
   *  the wait really lasted from the one before. */
  segs: Array<{ units: number; resume: number; gap: number }>;
  units: number;
  budget: { day: number; night: number };
  real: { idx: number[]; first: number; last: number; start: number | null; finish: number | null };
  startOff: number; finishOff: number;
  /** Off site: hours away, and not before its real start (null: taken out). */
  clockH: number; clockFloor: number | null;
  planned: number;
  tail: number;
  /** Waits with nothing logged and no reason (taken out). */
  open: number;
  /** One-off waits taken out by `without`. */
  out: Array<{ shifts: number; said: string | null }>;
  /** Sat ready with a reason recorded: kept. */
  readyReason: Reason | null;
  /** When the work it really needed was done (and its planned start had
   *  come): from the record. */
  readyAt: number | null;
  found: boolean;
}

function readRecord(input: ReplayInput) {
  const { work, tz, times } = input;
  const scope = input.phaseIds ? new Set(input.phaseIds) : null;
  const orders: BuiltOrder[] = input.built.orders
    .map((o) => ({ ...o, steps: o.steps.filter((s) => (!scope || scope.has(s.id)) && work.steps.has(s.id)) }))
    .filter((o) => o.steps.length);
  const built: AsBuilt = { ...input.built, orders };
  const byMs = new Map(input.milestones.filter((m) => m.id).map((m) => [m.id!, m]));
  const acts = new Map(planActivities({ built, work, milestones: input.milestones, tz, times }).map((a) => [a.id, a]));
  const steps = orders.flatMap((o) => o.steps.map((s) => ({ s, o })));
  const inScope = new Set(steps.map((x) => x.s.id));
  // Every step of the job (for crews' room and what they were on).
  const everyStep = new Map(input.built.orders.flatMap((o) => o.steps.map((s) => [s.id, { s, o }] as const)));

  // The shifts, grown past the job's end as the replay needs.
  const shifts: ShiftWindow[] = [...work.shifts];
  const at = new Map(shifts.map((w, i) => [shiftKey(w), i]));
  const grow = (i: number) => {
    while (shifts.length && shifts.length <= i && shifts.length < 6000) {
      const w = nextShift(shifts[shifts.length - 1], tz, times);
      at.set(shiftKey(w), shifts.length); shifts.push(w);
    }
  };
  const idxAt = (t: number): number => {
    if (!shifts.length || t < shifts[0].start) return 0;
    while (t >= shifts[shifts.length - 1].end && shifts.length < 6000) grow(shifts.length);
    let lo = 0, hi = shifts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (shifts[mid].start <= t) lo = mid; else hi = mid - 1; }
    return lo;
  };
  const idxOf = (keys: string[]) => keys.map((k) => at.get(k)).filter((i): i is number => i != null).sort((a, b) => a - b);

  // Comments by step, oldest first.
  const notesOf = new Map<string, Array<{ at: number; body: string }>>();
  for (const n of input.notes ?? []) {
    const t = toMs(n.happenedAt) ?? toMs(n.createdAt); const body = (n.body ?? "").trim();
    if (t == null || !body || !inScope.has(n.milestoneId)) continue;
    notesOf.set(n.milestoneId, [...(notesOf.get(n.milestoneId) ?? []), { at: t, body }]);
  }
  for (const v of notesOf.values()) v.sort((a, b) => a.at - b.at);
  // The review's cause on each stuck shift (a person's answer, or what it read).
  const stuckAt = new Map<string, Map<string, { cause: CauseId; said: string | null }>>();
  for (const j of input.review?.stuck ?? []) {
    const m = new Map<string, { cause: CauseId; said: string | null }>();
    for (const s of j.shifts) if (!unexplained(s.cause)) m.set(s.key, { cause: s.cause, said: s.said });
    if (m.size) stuckAt.set(j.id, m);
  }

  // Each in-progress wait, and the reason recorded for it.
  const runs = new Map<string, Run[]>();
  for (const { s } of steps) {
    const w = work.steps.get(s.id)!;
    const idx = idxOf(w.worked);
    const mine: Run[] = [];
    for (const run of w.waits) {
      const a = at.get(run.from), b = at.get(run.to);
      if (a == null || b == null) continue;
      const prev = [...idx].reverse().find((i) => i < a), next = idx.find((i) => i > b);
      if (prev == null || next == null) continue;
      let reason = reasonOf(run.why);
      if (!reason) {
        const st = stuckAt.get(s.id);
        const hit = run.keys.map((k) => st?.get(k)).find((x) => !!x);
        if (hit) reason = { cause: hit.cause, said: hit.said?.trim() || hit.cause };
      }
      mine.push({ id: `wait:${s.id}:${run.from}`, step: s.id, run, prev, next, hours: r1((shifts[next].start - shifts[prev].end) / H), reason });
    }
    runs.set(s.id, mine);
  }

  const offsite = (s: BuiltStep) => OFFSITE_STEP.test(s.name);
  const kindOf = (o: BuiltOrder, s: BuiltStep): ReplayHow => (isShutdown(o.name) ? "as ran" : isStartUp(o.name) ? "start-up" : offsite(s) ? "off site" : "work");

  // Crews' room: the most steps each really worked in one shift, days and
  // nights apart, over the whole job; and the first and last shift of each
  // kind it worked. Off site and start-up are no crew's room.
  const per = new Map<string, Map<number, number>>();
  for (const w of work.steps.values()) {
    const x = everyStep.get(w.id);
    if (x && (offsite(x.s) || isStartUp(x.o.name))) continue;
    for (const i of idxOf(w.worked)) {
      const m = per.get(w.crew) ?? new Map<number, number>();
      m.set(i, (m.get(i) ?? 0) + 1); per.set(w.crew, m);
    }
  }
  const cap = new Map<string, { day: number; night: number }>();
  const win = new Map<string, { day: [number, number] | null; night: [number, number] | null }>();
  for (const [crew, m] of per) {
    const c = { day: 0, night: 0 }; const wn: { day: [number, number] | null; night: [number, number] | null } = { day: null, night: null };
    for (const [i, n] of m) {
      const k = shifts[i].kind === "night" ? "night" : "day";
      c[k] = Math.max(c[k], n);
      const cur = wn[k]; wn[k] = cur ? [Math.min(cur[0], i), Math.max(cur[1], i)] : [i, i];
    }
    cap.set(crew, c); win.set(crew, wn);
  }
  // Room already taken as it really ran: steps outside the scope.
  const base = new Map<string, Map<number, number>>();
  for (const w of work.steps.values()) {
    if (inScope.has(w.id)) continue;
    const x = everyStep.get(w.id);
    if (x && (offsite(x.s) || isStartUp(x.o.name))) continue;
    for (const i of idxOf(w.worked)) { const m = base.get(w.crew) ?? new Map<number, number>(); m.set(i, (m.get(i) ?? 0) + 1); base.set(w.crew, m); }
  }

  // What each crew was on, shift by shift (work order names), the whole job.
  const crewOn = new Map<string, Map<number, Set<string>>>();
  for (const w of work.steps.values()) {
    const name = everyStep.get(w.id)?.o.name; if (!name) continue;
    for (const i of idxOf(w.worked)) {
      const m = crewOn.get(w.crew) ?? new Map<number, Set<string>>();
      m.set(i, (m.get(i) ?? new Set<string>()).add(name)); crewOn.set(w.crew, m);
    }
  }

  return { input, built, steps, byMs, acts, inScope, shifts, at, grow, idxAt, idxOf, notesOf, runs, kindOf, cap, win, base, crewOn, stuckAt };
}
type Record_ = ReturnType<typeof readRecord>;

/** The steps as the replay places them, with the one-off delays in `takes`
 *  taken out. */
function nodesOf(r: Record_, takes: Set<string>): Map<string, Node> {
  const { input, steps, byMs, acts, inScope, shifts, idxAt, idxOf, notesOf, runs, kindOf } = r;
  const { work } = input;
  const nodes = new Map<string, Node>();
  for (const { s, o } of steps) {
    const w = work.steps.get(s.id)!;
    const a = acts.get(s.id);
    const idx = idxOf(w.worked);
    // Not on the schedule's steps (its links aren't known), or not marked
    // done (its real finish isn't known): it stays as it ran.
    const how = a && s.status === "done" ? kindOf(o, s) : "as ran";
    const start = s.start ?? (idx.length ? shifts[idx[0]].start : s.barStart);
    const finish = s.finish ?? (idx.length ? shifts[idx[idx.length - 1]].end : null);
    const first = idx.length ? idx[0] : start != null ? idxAt(start) : -1;
    const last = idx.length ? idx[idx.length - 1] : finish != null ? idxAt(finish - 1) : -1;
    const len = (i: number) => shifts[i].end - shifts[i].start;
    const startOff = idx.length && start != null ? Math.max(0, Math.min(len(idx[0]) - MIN, start - shifts[idx[0]].start)) : 0;
    const finishOff = idx.length && finish != null ? Math.max(MIN, Math.min(len(last), finish - shifts[last].start)) : 0;
    const cal: Cal = how === "start-up" || how === "off site" ? "both" : a?.cal ?? (idx.length && idx.every((i) => shifts[i].kind === "night") ? "night" : "day");
    const budget = { day: idx.filter((i) => shifts[i].kind !== "night").length, night: idx.filter((i) => shifts[i].kind === "night").length };

    // Its work, split where a kept wait holds it.
    const segs: Node["segs"] = [{ units: 0, resume: -1, gap: 0 }];
    let open = 0; const out: Node["out"] = [];
    const mine = runs.get(s.id) ?? [];
    for (let j = 0; j < idx.length; j++) {
      segs[segs.length - 1].units++;
      if (j === idx.length - 1) continue;
      const run = mine.find((x) => x.prev === idx[j] && x.next === idx[j + 1]);
      if (!run) continue;
      if (run.reason && !takes.has(run.id)) segs.push({ units: 0, resume: idx[j + 1], gap: idx[j + 1] - idx[j] });
      else if (run.reason) out.push({ shifts: run.run.shifts, said: run.reason.said });
      else open += run.run.shifts;
    }

    // Earliest start: the plan's (planActivities), found work its real
    // start (else when it was found).
    let floorT = a?.floor ?? null;
    if (w.found) {
      const foundAt = (() => { const m = byMs.get(s.id); const d = m ? discoveryOf(m) : undefined; return d && Number.isFinite(d.foundAt) ? d.foundAt : null; })();
      const t = s.start ?? foundAt ?? (idx.length ? shifts[idx[0]].start : null);
      floorT = t == null ? null : Math.max(t, foundAt ?? -Infinity);
    }
    const preds = (a?.preds ?? []).filter((p) => inScope.has(p) && p !== s.id);
    // Nothing it waited on and no planned or found time: when it was ready
    // isn't in the record, so it starts no sooner than it really did.
    if (floorT == null && !preds.length) floorT = start;
    // Ran long for a one-off, taken out: it takes its planned shifts, the
    // first ones it was really worked in.
    let units = idx.length; let segsNow = segs; let budgetNow = budget;
    if (takes.has(`long:${s.id}`) && a?.planHours != null) {
      const keep = Math.min(idx.length, plannedUnits(shifts, idx, a.planHours));
      let left = keep;
      segsNow = segs.map((g) => { const u = Math.min(g.units, left); left -= u; return { ...g, units: u }; });
      const kept = idx.slice(0, keep);
      budgetNow = { day: kept.filter((i) => shifts[i].kind !== "night").length, night: kept.filter((i) => shifts[i].kind === "night").length };
      units = keep;
    }
    nodes.set(s.id, {
      id: s.id, name: s.name, orderKey: o.key, orderName: o.name, crew: w.crew, cal, how, inPlan: s.inPlan,
      preds, same: false, floor: floorT == null ? 0 : idxAt(floorT), floorT,
      segs: segsNow.filter((g, i) => i === 0 || g.units > 0), units, budget: budgetNow,
      real: { idx, first, last, start, finish }, startOff, finishOff,
      clockH: how === "off site" && start != null && finish != null ? Math.max(0, (finish - start) / H) : 0,
      clockFloor: how === "off site" ? start : null,
      planned: s.planStart ?? s.start ?? start ?? Infinity, tail: 0, open, out, readyReason: null, readyAt: null, found: w.found,
    });
  }
  // Off site taken out: the trip didn't happen.
  for (const n of nodes.values()) if (n.how === "off site" && takes.has(`offsite:${n.id}`)) { n.clockH = 0; n.clockFloor = null; }

  // Links: a loop in the file is broken where it closes.
  const state = new Map<string, number>();
  const visit = (id: string) => {
    state.set(id, 1);
    const n = nodes.get(id)!;
    n.preds = n.preds.filter((p) => { if (!nodes.has(p)) return false; const s0 = state.get(p); if (s0 === 1) return false; if (!s0) visit(p); return true; });
    state.set(id, 2);
  };
  for (const id of nodes.keys()) if (!state.has(id)) visit(id);
  for (const n of nodes.values()) {
    const lastIn = Math.max(-1, ...n.preds.map((p) => nodes.get(p)!.real.last));
    n.same = n.real.first >= 0 && lastIn >= 0 && n.real.first <= lastIn;
    // When it was really ready: what it needed done, and its planned start come.
    const done = n.preds.map((p) => nodes.get(p)!.real.finish).filter((t): t is number => t != null);
    const ready = Math.max(...done, n.floorT ?? -Infinity);
    n.readyAt = Number.isFinite(ready) ? ready : null;
    // Sat ready with a reason written on it before it started: kept.
    if (n.readyAt != null && n.real.first >= 0 && n.real.first > idxAt(n.readyAt)) {
      const end = shifts[n.real.first].end;
      const said = (notesOf.get(n.id) ?? []).filter((x) => x.at >= n.readyAt! && x.at <= end).map((x) => x.body);
      const why = reasonOf(said);
      if (why) {
        n.readyReason = why;
        if (!takes.has(`ready:${n.id}`)) n.floor = Math.max(n.floor, n.real.first);
      }
    }
  }

  // Room before the finish: the longest run of shifts from it to the end.
  const succ = new Map<string, string[]>();
  for (const n of nodes.values()) for (const p of n.preds) succ.set(p, [...(succ.get(p) ?? []), n.id]);
  const span = (n: Node) => {
    if (n.how === "off site") return Math.ceil(n.clockH / 12);
    if (n.how === "as ran") return n.real.last >= n.real.first && n.real.first >= 0 ? n.real.last - n.real.first + 1 : 0;
    const gaps = n.segs.slice(1).reduce((x, g) => x + Math.max(0, g.gap - 1), 0);
    return (n.cal === "both" ? n.units : Math.max(0, 2 * n.units - 1)) + gaps;
  };
  const memo = new Map<string, number>();
  const tail = (id: string, seen = new Set<string>()): number => {
    const k = memo.get(id); if (k != null) return k;
    if (seen.has(id)) return 0;
    seen.add(id);
    const v = span(nodes.get(id)!) + Math.max(0, ...(succ.get(id) ?? []).map((x) => tail(x, seen)));
    memo.set(id, v); return v;
  };
  for (const n of nodes.values()) n.tail = tail(n.id);
  return nodes;
}

// ─── The replay ──────────────────────────────────────────────────────

interface Placed { idx: Map<string, number[]>; start: Map<string, number>; finish: Map<string, number> }

/** One pass, shift by shift. Null: some work couldn't be placed inside its
 *  crew's shifts on this job (the order tried would need an extra shift). */
function pass(r: Record_, nodes: Map<string, Node>, prio: (a: Node, b: Node) => number): Placed | null {
  const { shifts, grow, idxAt, cap, win, base } = r;
  const taken = new Map<string, Map<number, number>>();
  for (const [crew, m] of base) taken.set(crew, new Map(m));
  const takenAt = (crew: string, i: number) => taken.get(crew)?.get(i) ?? 0;
  const bump = (crew: string, i: number) => { const m = taken.get(crew) ?? new Map<number, number>(); m.set(i, (m.get(i) ?? 0) + 1); taken.set(crew, m); };
  const done = new Map<string, { last: number; finish: number }>();
  const out: Placed = { idx: new Map(), start: new Map(), finish: new Map() };
  const st = new Map<string, { seg: number; inSeg: number; last: number; kinds: { day: number; night: number } }>();
  const pending = new Set<string>();
  const len = (i: number) => shifts[i].end - shifts[i].start;
  const timeIn = (i: number, off: number) => shifts[i].start + Math.min(off, len(i));
  for (const n of nodes.values()) {
    if (n.how === "as ran") {
      out.idx.set(n.id, n.real.idx);
      for (const i of n.real.idx) bump(n.crew, i);
      if (n.real.start != null) out.start.set(n.id, n.real.start);
      if (n.real.finish != null) out.finish.set(n.id, n.real.finish);
      done.set(n.id, { last: n.real.last, finish: n.real.finish ?? (n.real.last >= 0 ? shifts[n.real.last].end : shifts[0].start) });
    } else pending.add(n.id);
  }
  const predOk = (n: Node, i: number) => n.preds.every((p) => { const d = done.get(p); return !!d && (d.last < i || (d.last === i && n.same)); });
  const limited = (n: Node) => n.how === "work";
  const kindOk = (n: Node, kind: "day" | "night", s: { kinds: { day: number; night: number } } | undefined) => n.cal === "both" || n.cal === kind || (s?.kinds[kind] ?? 0) < n.budget[kind];
  const winOf = (n: Node, kind: "day" | "night") => (limited(n) ? win.get(n.crew)?.[kind] ?? null : [0, Infinity] as [number, number]);
  const capOf = (n: Node, kind: "day" | "night") => (limited(n) ? cap.get(n.crew)?.[kind] ?? 0 : Infinity);
  // The last shift a step can still be worked in.
  const lastChance = (n: Node) => {
    if (!limited(n)) return Infinity;
    const ks = (["day", "night"] as const).filter((k) => n.cal === "both" || n.cal === k || n.budget[k] > 0);
    return Math.max(-1, ...ks.map((k) => winOf(n, k)?.[1] ?? -1));
  };
  const realEnd = Math.max(0, ...[...nodes.values()].map((n) => n.real.last));
  const limit = realEnd + 400;

  for (let i = 0; pending.size && i <= limit; i++) {
    grow(i);
    const kind = shifts[i].kind === "night" ? "night" : "day";
    const here = new Set<string>();
    for (let g = 0; g < 500; g++) {
      let moved = false;
      for (const id of [...pending]) {
        const n = nodes.get(id)!;
        if (n.how === "off site") {
          // Clock time: as soon as what it needed is done, never before its real start.
          if (!n.preds.every((p) => done.has(p))) continue;
          const after = Math.max(-Infinity, ...n.preds.map((p) => done.get(p)!.finish));
          const t0 = Math.max(n.clockFloor ?? -Infinity, after, Number.isFinite(after) || n.clockFloor != null ? -Infinity : n.real.start ?? shifts[0].start);
          const fin = t0 + n.clockH * H;
          out.start.set(id, t0); out.finish.set(id, fin); out.idx.set(id, []);
          done.set(id, { last: idxAt(Math.max(t0, fin - 1)), finish: fin });
          pending.delete(id); moved = true;
        } else if (n.units === 0) {
          // No work recorded on it: through as soon as it can start.
          if (!(i >= n.floor && predOk(n, i))) continue;
          out.idx.set(id, []); out.start.set(id, shifts[i].start); out.finish.set(id, shifts[i].start);
          done.set(id, { last: i - 1, finish: shifts[i].start });
          pending.delete(id); moved = true;
        }
      }
      const cands: Array<{ n: Node; going: boolean }> = [];
      for (const id of pending) {
        const n = nodes.get(id)!;
        if (n.how === "off site" || n.units === 0 || here.has(id)) continue;
        const s = st.get(id);
        if (s) {
          const seg = n.segs[s.seg];
          if (s.inSeg === 0 && seg.resume >= 0 && (i < seg.resume || i < s.last + seg.gap)) continue;
        } else if (!(i >= n.floor && predOk(n, i))) continue;
        if (!kindOk(n, kind, s)) continue;
        const w = winOf(n, kind);
        if (!w || i < w[0] || i > w[1]) continue;
        cands.push({ n, going: !!s });
      }
      // A crew finishes what it started; then the rest by the order tried.
      cands.sort((x, y) => Number(y.going) - Number(x.going) || prio(x.n, y.n));
      for (const { n } of cands) {
        if (limited(n) && takenAt(n.crew, i) >= capOf(n, kind)) continue;
        if (limited(n)) bump(n.crew, i);
        here.add(n.id); moved = true;
        const s = st.get(n.id) ?? { seg: 0, inSeg: 0, last: -1, kinds: { day: 0, night: 0 } };
        if (!st.has(n.id)) { st.set(n.id, s); out.start.set(n.id, timeIn(i, n.startOff)); }
        out.idx.set(n.id, [...(out.idx.get(n.id) ?? []), i]);
        s.inSeg++; s.last = i; s.kinds[kind]++;
        if (s.inSeg >= n.segs[s.seg].units) { s.seg++; s.inSeg = 0; }
        if (s.seg >= n.segs.length) {
          const fin = Math.max(out.start.get(n.id)!, timeIn(i, n.finishOff));
          out.finish.set(n.id, fin); done.set(n.id, { last: i, finish: fin }); pending.delete(n.id);
        }
      }
      if (!moved) break;
    }
    for (const id of pending) { const n = nodes.get(id)!; if (n.how !== "off site" && n.units > 0 && i >= lastChance(n)) return null; }
  }
  return pending.size ? null : out;
}

/** The job as it really ran. */
function asRan(nodes: Map<string, Node>): Placed {
  const out: Placed = { idx: new Map(), start: new Map(), finish: new Map() };
  for (const n of nodes.values()) {
    out.idx.set(n.id, n.real.idx);
    if (n.real.start != null) out.start.set(n.id, n.real.start);
    if (n.real.finish != null) out.finish.set(n.id, n.real.finish);
  }
  return out;
}

const finishOf = (nodes: Map<string, Node>, p: Placed) => {
  const xs = [...nodes.values()].filter((n) => n.units > 0 || n.how === "off site" || n.how === "as ran").map((n) => p.finish.get(n.id)).filter((t): t is number => t != null);
  return xs.length ? Math.max(...xs) : null;
};

/** What sets a finish: the work done last (before the start-up, which
 *  waits on every work order); every step done then. */
const settersOf = (nodes: Map<string, Node>, p: Placed): Node[] => {
  const xs = [...nodes.values()].filter((n) => (n.units > 0 || n.how !== "work") && p.finish.get(n.id) != null);
  const work = xs.filter((n) => n.how !== "start-up");
  const pool = work.length ? work : xs;
  const t = Math.max(-Infinity, ...pool.map((n) => p.finish.get(n.id)!));
  return pool.filter((n) => p.finish.get(n.id)! >= t - MIN);
};

type Core = { nodes: Map<string, Node>; placed: Placed; sequence: Replay["sequence"]; actualFinish: number | null; replayFinish: number | null; savedH: number };

function replayCore(r: Record_, takes: Set<string>): Core {
  const nodes = nodesOf(r, takes);
  const actuals = [...nodes.values()].map((n) => n.real.finish).filter((t): t is number => t != null);
  const actualFinish = actuals.length ? Math.max(...actuals) : null;
  const byRule = (a: Node, b: Node) => b.tail - a.tail || a.planned - b.planned || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
  const asDone = (a: Node, b: Node) => a.real.first - b.real.first || byRule(a, b);
  const ran = asRan(nodes);
  const tries: Array<{ sequence: Replay["sequence"]; p: Placed | null }> = [
    { sequence: "critical first", p: pass(r, nodes, byRule) },
    { sequence: "as really done", p: pass(r, nodes, asDone) },
  ];
  const later = (p: Placed) => [...nodes.values()].some((n) => { const f = p.finish.get(n.id), s = p.start.get(n.id); return (f != null && n.real.finish != null && f > n.real.finish + MIN) || (s != null && n.real.start != null && n.how !== "work" && s > n.real.start + MIN) || (n.how === "work" && n.units > 0 && (p.idx.get(n.id)?.[0] ?? -1) > n.real.first); });
  let best: { sequence: Replay["sequence"]; p: Placed; f: number } | null = null;
  for (const t of tries) {
    if (!t.p) continue;
    const f = finishOf(nodes, t.p);
    if (f == null || actualFinish == null) continue;
    if (f < actualFinish - MIN && (!best || f < best.f - MIN)) best = { sequence: t.sequence, p: t.p, f };
  }
  // Not sooner: the pulls-in that move nothing later are still shown; else the job as it ran.
  if (!best) {
    for (const t of [...tries].reverse()) if (t.p && actualFinish != null && (finishOf(nodes, t.p) ?? Infinity) <= actualFinish + MIN && !later(t.p)) { best = { sequence: t.sequence, p: t.p, f: actualFinish }; break; }
  }
  const placed = best?.p ?? ran;
  const replayFinish = best ? Math.min(finishOf(nodes, placed) ?? Infinity, actualFinish ?? Infinity) : actualFinish;
  const savedH = actualFinish != null && replayFinish != null && replayFinish < actualFinish ? r1((actualFinish - replayFinish) / H) : 0;
  return { nodes, placed, sequence: best?.sequence ?? "as ran", actualFinish, replayFinish: replayFinish != null && Number.isFinite(replayFinish) ? replayFinish : null, savedH };
}

// ─── Words ───────────────────────────────────────────────────────────

/** Each change against what really happened, said from the record. */
function movesOf(r: Record_, c: Core): ReplayMove[] {
  const { shifts, idxAt, crewOn } = r;
  const tz = r.input.tz;
  const { nodes, placed } = c;
  const out: ReplayMove[] = [];
  const onCal = (n: Node, i: number) => n.cal === "both" || (shifts[i].kind === "night" ? "night" : "day") === n.cal;
  for (const n of nodes.values()) {
    if (n.how === "as ran" || n.real.start == null || n.real.finish == null) continue;
    const s = placed.start.get(n.id), f = placed.finish.get(n.id);
    if (s == null || f == null) continue;
    const P = placed.idx.get(n.id) ?? [];
    if (n.how === "work" || n.how === "start-up") {
      if (!n.units || !P.length) continue;
      if (P[0] === n.real.first && P[P.length - 1] === n.real.last) continue;
    } else if (Math.abs(s - n.real.start) < MIN && Math.abs(f - n.real.finish) < MIN) continue;
    const parts: string[] = [];
    const sooner = (n.how === "off site" ? s < n.real.start - MIN : P[0] < n.real.first);
    if (sooner) {
      const ri = n.readyAt != null ? idxAt(n.readyAt) : null;
      if (ri != null && n.readyAt! < n.real.start && ri < n.real.first) {
        const between: number[] = [];
        for (let i = ri + 1; i < n.real.first; i++) if (onCal(n, i)) between.push(i);
        if (between.length) {
          const on = new Map<string, number>();
          let logged = false;
          for (const i of between) for (const name of crewOn.get(n.crew)?.get(i) ?? []) { logged = true; if (name !== n.orderName) on.set(name, (on.get(name) ?? 0) + 1); }
          const busy = [...on.entries()].sort((a, b) => b[1] - a[1]).map(([x]) => x);
          parts.push(`was ready at ${whenWord(n.readyAt!, tz)} and sat ${plural(between.length, "shift")} while ${n.crew} ${busy.length ? `was on ${list(busy)}` : logged ? `was on other steps of ${n.orderName}` : "logged no work"}`);
        } else parts.push(`was ready at ${whenWord(n.readyAt!, tz)} and didn't start until ${whenWord(n.real.start, tz)}`);
      } else {
        // It moved because what it waited on is done sooner.
        const moved = n.preds.map((p) => nodes.get(p)!).filter((q) => q.real.finish != null && (placed.finish.get(q.id) ?? Infinity) < q.real.finish - MIN)
          .sort((a, b) => (placed.finish.get(b.id) ?? 0) - (placed.finish.get(a.id) ?? 0));
        if (moved[0]) parts.push(`started once ${moved[0].name}${moved[0].orderKey !== n.orderKey ? ` on ${moved[0].orderName}` : ""} was done`);
        else if (n.readyAt != null) parts.push(`was ready at ${whenWord(n.readyAt, tz)}`);
      }
    }
    if (n.open > 0 && n.how !== "off site" && P.length && P[P.length - 1] - P[0] < n.real.last - n.real.first) parts.push(`was open ${plural(n.open, "shift")} with nothing logged and no reason recorded`);
    for (const x of n.out) parts.push(`had its ${x.shifts}-shift wait${x.said ? ` (recorded: "${x.said}")` : ""} taken out`);
    if (n.how === "off site" && n.clockH === 0 && n.real.finish - n.real.start > MIN) parts.push(`had its ${hoursWord((n.real.finish - n.real.start) / H)} off site taken out`);
    const lateH = r1((s - n.real.start) / H), lateF = r1((f - n.real.finish) / H);
    if (lateH >= 0.5 || (!parts.length && lateF >= 0.5)) {
      const at = n.how === "work" ? n.real.first : idxAt(n.real.start);
      const others = [...nodes.values()].filter((q) => q.id !== n.id && q.crew === n.crew && (placed.idx.get(q.id) ?? []).includes(at)).map((q) => q.name);
      if (lateH >= 0.5) parts.push(`starts ${r1(lateH)} h later than it really did${others.length ? `, while ${n.crew} does ${list(others)} first` : ""}`);
      else parts.push(`finishes ${r1(lateF)} h later than it really did${others.length ? `, sharing ${n.crew} with ${list(others)}` : ""}`);
    }
    if (!parts.length) continue;
    out.push({
      stepId: n.id, stepName: n.name, order: n.orderName, crew: n.crew,
      wasStart: n.real.start, nowStart: s, wasFinish: n.real.finish, nowFinish: f,
      savedH: r1((n.real.finish - f) / H),
      why: `${n.name} ${parts.join(", and ")}.`,
    });
  }
  return out.sort((a, b) => b.savedH - a.savedH || a.nowStart - b.nowStart || a.stepName.localeCompare(b.stepName));
}

// ─── One-off delays ──────────────────────────────────────────────────

type Delay = OneOffDelay & { takes: string[] };

function delaysOf(r: Record_): { list: Delay[]; unmatched: string[] } {
  const { input, steps, runs } = r;
  const nodes = nodesOf(r, new Set());
  const stepOf = new Map(steps.map((x) => [x.s.id, x]));
  const fromComments: Delay[] = [];
  for (const { s, o } of steps) {
    for (const x of runs.get(s.id) ?? []) {
      if (!isOneOff(x.reason)) continue;
      fromComments.push({
        id: x.id, label: `${named(s.name, o.name)} waited ${plural(x.run.shifts, "shift")}: "${x.reason!.said}"`, short: `${named(s.name, o.name)} waited ${plural(x.run.shifts, "shift")}`,
        stepIds: [s.id], order: o.name, kind: "wait", cause: causeOf(x.reason!), shifts: x.run.shifts, hours: x.hours, said: x.reason!.said, from: "comment", takes: [x.id],
      });
    }
    const n = nodes.get(s.id)!;
    if (n.how === "off site" && n.real.start != null && n.real.finish != null && n.real.finish > n.real.start) {
      const h = (n.real.finish - n.real.start) / H;
      const a = r.idxAt(n.real.start), b = r.idxAt(n.real.finish - 1);
      fromComments.push({
        id: `offsite:${s.id}`, label: `${named(s.name, o.name)}: ${hoursWord(h)} off site`, short: `${named(s.name, o.name)}: ${hoursWord(h)} off site`, stepIds: [s.id], order: o.name, kind: "off site", cause: "offsite",
        shifts: Math.max(1, b - a + 1), hours: r1(h), said: null, from: "step name", takes: [`offsite:${s.id}`],
      });
    }
    if (n.readyReason && isOneOff(n.readyReason) && n.readyAt != null && n.real.start != null) {
      const ri = r.idxAt(n.readyAt);
      const sat = Math.max(0, n.real.first - ri - 1);
      fromComments.push({
        id: `ready:${s.id}`, label: `${named(s.name, o.name)} sat ready ${plural(sat, "shift")}: "${n.readyReason.said}"`, short: `${named(s.name, o.name)} sat ready ${plural(sat, "shift")}`, stepIds: [s.id], order: o.name, kind: "ready",
        cause: causeOf(n.readyReason), shifts: sat, hours: r1((n.real.start - n.readyAt) / H), said: n.readyReason.said, from: "comment", takes: [`ready:${s.id}`],
      });
    }
  }

  // Ran long for a one-off: a leak, a failure or a shortfall written on a
  // work order's steps while it was being worked, and the steps of that work
  // order still running then that took more shifts than planned. Taken out,
  // each takes its planned shifts. One per work order, with what was written.
  const longOf = new Map<string, { ids: string[]; extra: number; hours: number; said: string[]; reason: Reason | null }>();
  for (const o of [...new Set(steps.map((x) => x.o))]) {
    const mine = steps.filter((x) => x.o === o).map((x) => ({ s: x.s, n: nodes.get(x.s.id)! }));
    const t0 = Math.min(...mine.map((x) => x.n.real.start ?? Infinity)), t1 = Math.max(...mine.map((x) => x.n.real.finish ?? -Infinity));
    const lines = mine.flatMap((x) => r.notesOf.get(x.s.id) ?? []).filter((c) => c.at >= t0 && c.at <= t1)
      .filter((c) => FAIL.test(c.body) || isOneOff(reasonIn(c.body))).sort((a, b) => a.at - b.at);
    if (!lines.length) continue;
    const first = lines[0].at;
    const g = { ids: [] as string[], extra: 0, hours: 0, said: [...new Set(lines.map((c) => c.body))], reason: reasonIn(lines[0].body) };
    for (const { s, n } of mine) {
      const a = r.acts.get(s.id);
      if (n.how !== "work" || a?.planHours == null || n.real.finish == null || n.real.finish < first) continue;
      const keep = plannedUnits(r.shifts, n.real.idx, a.planHours);
      if (n.real.idx.length <= keep) continue;
      const over = n.real.idx.slice(keep);
      g.ids.push(s.id); g.extra += over.length; g.hours += over.reduce((h, i) => h + (r.shifts[i].end - r.shifts[i].start) / H, 0);
    }
    if (g.ids.length) longOf.set(o.key, g);
  }
  for (const [key, g] of longOf) {
    const o = steps.find((x) => x.o.key === key)!.o;
    fromComments.push({
      id: `long:${key}`, label: `${o.name}: ${list(g.ids.map((id) => stepOf.get(id)!.s.name))} ran ${plural(g.extra, "shift")} past plan, written: "${g.said[0]}"`,
      short: `${o.name}: ${g.ids.length === 1 && stepOf.get(g.ids[0])!.s.name.trim() === o.name.trim() ? "" : `${list(g.ids.map((id) => stepOf.get(id)!.s.name))} `}ran ${plural(g.extra, "shift")} past plan`,
      stepIds: g.ids, order: o.name, kind: "ran long", cause: g.reason ? causeOf(g.reason) : "failure",
      shifts: g.extra, hours: r1(g.hours), said: g.said[0], from: "comment", takes: g.ids.map((id) => `long:${id}`),
    });
  }

  // The review's findings that name a one-off on a work order: the waits on
  // that work order the review (else what was written) puts down to it, and
  // the steps that ran long for it (above).
  const fromReview: Delay[] = [];
  const unmatched: string[] = [];
  const orders = [...new Set(steps.map((x) => x.o))];
  for (const f of input.review?.findings ?? []) {
    if (f.status === "discarded") continue;
    const text = `${f.title}\n${f.because ?? ""}`;
    const fc = causeOfText(f.title) ?? causeOfText(f.because ?? "");
    const failure = FAIL.test(text);
    if (!(fc && ONE_OFF.has(fc)) && !failure) continue;
    const on = orders.filter((o) => { const t = tagOf(o.name); return (t && names(text, t)) || names(text, o.name); });
    if (!on.length) continue;
    const takes: string[] = []; const ids: string[] = []; let shiftsN = 0, hours = 0; const saids: string[] = [];
    const fits = (rs: Reason | null) => !!rs && (fc && ONE_OFF.has(fc) ? rs.cause === fc : isOneOff(rs));
    for (const o of on) for (const s of o.steps) {
      const st = r.stuckAt.get(s.id);
      for (const x of runs.get(s.id) ?? []) {
        const byReview = st ? x.run.keys.some((k) => { const v = st.get(k); return !!v && fits({ cause: v.cause, said: v.said ?? "" }); }) : false;
        if (!byReview && !fits(x.reason)) continue;
        takes.push(x.id); ids.push(s.id); shiftsN += x.run.shifts; hours += x.hours;
        const said = x.reason?.said ?? st?.get(x.run.keys[0])?.said ?? null; if (said && !saids.includes(said)) saids.push(said);
      }
      const n = nodes.get(s.id)!;
      if (n.how === "off site" && (fc === "offsite" || failure) && n.real.start != null && n.real.finish != null && n.real.finish > n.real.start) {
        takes.push(`offsite:${s.id}`); ids.push(s.id); hours += (n.real.finish - n.real.start) / H;
        shiftsN += Math.max(1, r.idxAt(n.real.finish - 1) - r.idxAt(n.real.start) + 1);
      }
    }
    for (const o of on) {
      const g = longOf.get(o.key);
      if (!g) continue;
      takes.push(...g.ids.map((id) => `long:${id}`)); ids.push(...g.ids); shiftsN += g.extra; hours += g.hours;
      for (const x of g.said) if (!saids.includes(x)) saids.push(x);
    }
    if (!takes.length) {
      unmatched.push(`"${f.title}": nothing on ${list(on.map((o) => o.name))} was recorded as a wait for it, so the replay can't take it out (each step keeps the work shifts it really took).`);
      continue;
    }
    const stepNames = [...new Set(ids)].map((id) => stepOf.get(id)!.s.name);
    fromReview.push({
      id: `review:${f.key}`, label: `${f.title}: ${list(stepNames)}, ${plural(shiftsN, "shift")}`, short: `${f.title}: ${list(stepNames)}, ${plural(shiftsN, "shift")}`, stepIds: [...new Set(ids)], order: on[0].name,
      kind: takes.every((t) => t.startsWith("offsite:")) ? "off site" : takes.every((t) => t.startsWith("long:")) ? "ran long" : "wait", cause: fc && ONE_OFF.has(fc) ? fc : "failure",
      shifts: shiftsN, hours: r1(hours), said: saids[0] ?? null, from: "review", takes,
    });
  }
  const covered = new Set(fromReview.flatMap((d) => d.takes));
  return { list: [...fromReview, ...byOrder(fromComments.filter((d) => !d.takes.every((t) => covered.has(t))), steps)], unmatched };
}

/** One line per work order: its one-off waits, trips and overruns are one
 *  event to take out together ("the leak on E-12"), each part still said. */
function byOrder(list: Delay[], steps: Record_["steps"]): Delay[] {
  const groups = new Map<string, Delay[]>();
  for (const d of list) groups.set(d.order, [...(groups.get(d.order) ?? []), d]);
  const out: Delay[] = [];
  for (const [order, ds] of groups) {
    if (ds.length === 1) { out.push(ds[0]); continue; }
    const key = steps.find((x) => x.o.name === order)?.o.key ?? order;
    // Each part without the work order's name, which leads the line once.
    const part = (d: Delay) => {
      let t = d.short;
      if (t.startsWith(`${order}: `)) t = t.slice(order.length + 2);
      else if (t.startsWith(order)) t = t.slice(order.length);
      return t.replace(` (${order})`, "").replace(/^:\s*/, "").trim();
    };
    const saids = [...new Set(ds.map((d) => d.said).filter((x): x is string => !!x))];
    const short = `${order}: ${ds.map(part).join("; ")}`;
    const biggest = [...ds].sort((a, b) => b.hours - a.hours)[0];
    out.push({
      id: `order:${key}`, short, label: saids.length ? `${short}, written: "${saids[0]}"` : short,
      stepIds: [...new Set(ds.flatMap((d) => d.stepIds))], order, kind: biggest.kind, cause: biggest.cause,
      shifts: ds.reduce((n, d) => n + d.shifts, 0), hours: r1(ds.reduce((n, d) => n + d.hours, 0)), said: saids[0] ?? null,
      from: ds.every((d) => d.from === "step name") ? "step name" : "comment", takes: [...new Set(ds.flatMap((d) => d.takes))],
    });
  }
  return out;
}

/** The one-off delays the record names (a leak, a material shortfall, a
 *  failure, a trip off site), each one that can be taken out of the replay
 *  with `without`. */
export function oneOffDelays(input: ReplayInput): OneOffDelay[] {
  if (!input.work.shifts.length) return [];
  return delaysOf(readRecord(input)).list.map(({ takes: _t, ...d }) => { void _t; return d; });
}

// ─── The whole thing ─────────────────────────────────────────────────

/** This job replayed on what really happened: the same work and crews,
 *  better timed. With `without`, the one-off delays named taken out. */
export function replayAsBuilt(input: ReplayInput): Replay {
  const empty = (said: string, limits: string[] = []): Replay => ({ actualFinish: null, replayFinish: null, savedH: 0, sequence: "as ran", steps: [], shifts: [], moves: [], capacity: {}, kept: [], limits, notDone: [], said, whatIf: null });
  if (!input.work.shifts.length) return empty("Nothing was recorded to replay.");
  const r = readRecord(input);
  if (!r.steps.length) return empty("Nothing was recorded to replay.");
  // A step left open (work logged, never marked done) doesn't stop the
  // replay: it stays as it ran, to its last logged shift, and is named.
  // Nothing done at all: there is no real finish to replay against.
  const notDone = r.steps.filter((x) => x.s.status !== "done");
  if (notDone.length === r.steps.length) return empty("Nothing is marked done yet: there is no real finish to replay against.", [`Not done yet: ${list(notDone.map((x) => x.s.name))}.`]);

  const { list: delays, unmatched } = delaysOf(r);
  const asked = input.without ?? [];
  const chosen = asked.map((id) => delays.find((d) => d.id === id)).filter((d): d is Delay => !!d);
  const takes = new Set(chosen.flatMap((d) => d.takes));
  const c = replayCore(r, takes);
  const tz = input.tz;
  // Nothing moved: the job as it ran.
  const moves = c.sequence === "as ran" ? [] : movesOf(r, c);
  if (!moves.length && !c.savedH) { c.sequence = "as ran"; c.placed = asRan(c.nodes); }
  const { nodes, placed } = c;

  const steps: ReplayStep[] = [...nodes.values()].map((n) => ({
    id: n.id, name: n.name, order: n.orderKey, orderName: n.orderName, crew: n.crew, cal: n.cal, how: n.how,
    shifts: (placed.idx.get(n.id) ?? []).map((i) => shiftKey(r.shifts[i])),
    start: placed.start.get(n.id) ?? null, finish: placed.finish.get(n.id) ?? null,
    real: { shifts: n.real.idx.map((i) => shiftKey(r.shifts[i])), start: n.real.start, finish: n.real.finish },
  }));
  const lastIdx = Math.max(0, ...[c.actualFinish, c.replayFinish].filter((t): t is number => t != null).map((t) => r.idxAt(t - 1)));
  const firstIdx = Math.min(...[...nodes.values()].flatMap((n) => [n.real.first, ...(placed.idx.get(n.id) ?? [])]).filter((i) => i >= 0), lastIdx);

  // Crews' room.
  const capacity: Replay["capacity"] = {};
  const crews = [...new Set([...nodes.values()].filter((n) => n.how === "work" || n.how === "as ran").map((n) => n.crew))].sort();
  for (const crew of crews) {
    const k = r.cap.get(crew) ?? { day: 0, night: 0 };
    const rec = input.work.crews.find((x) => x.crew === crew);
    const counted = Object.values(rec?.byShift ?? {}).some((x) => (x.counted?.total ?? x.counted?.direct ?? 0) > 0);
    capacity[crew] = { day: k.day, night: k.night, counted };
  }

  // What stays as it was.
  const kept: string[] = [];
  if ([...nodes.values()].some((n) => n.how === "as ran" && isShutdown(n.orderName))) kept.push("The shutdown stays as it ran.");
  if ([...nodes.values()].some((n) => n.how === "start-up")) kept.push("Start-up starts once every work order of its phase is done, around the clock, for the shifts it really took.");
  for (const n of nodes.values()) {
    if (n.how === "off site" && n.clockH > 0) kept.push(`${named(n.name, n.orderName)} was off site ${hoursWord(n.clockH)}: kept at that, not before it really went.`);
    for (const x of r.runs.get(n.id) ?? []) if (x.reason && !takes.has(x.id)) kept.push(`${named(n.name, n.orderName)} waited ${plural(x.run.shifts, "shift")}, recorded: "${x.reason.said}". Kept at its real length; the work after it starts no sooner than it really did.`);
    if (n.readyReason && !takes.has(`ready:${n.id}`)) kept.push(`${named(n.name, n.orderName)} sat ready before it started, recorded: "${n.readyReason.said}". Kept: it starts when it really did.`);
  }

  // What the replay can't know.
  const limits: string[] = [];
  const open = [...nodes.values()].filter((n) => n.open > 0);
  if (open.length) {
    const shiftsN = open.reduce((x, n) => x + n.open, 0);
    limits.push(`${plural(shiftsN, "shift")} on ${plural(open.length, "step")} had nothing logged and no reason recorded (${list(open.map((n) => n.name))}): the replay takes them out. If work went on and wasn't entered, or a reason wasn't written down, the replay is too hopeful there.`);
  }
  if (!input.notes) limits.push("The comments weren't read: work that sat ready is taken as sitting for no reason.");
  for (const crew of crews) {
    const k = capacity[crew];
    if (crew === "Not set") {
      const n = [...nodes.values()].filter((x) => x.crew === crew && (x.how === "work" || x.how === "as ran")).length;
      limits.push(`${plural(n, "step")} ${n === 1 ? "has" : "have"} no crew named: they are held together as one crew, at the most of them worked in one shift.`);
      continue;
    }
    const sizes = `${k.day} on days${k.night ? `, ${k.night} on nights` : ""}`;
    if (!k.counted) limits.push(`${crew}: no head count was recorded on the shifts it worked. It is held to the most steps it worked at once (${sizes}); the replay can't know whether it had the hands for more or for fewer.`);
    else {
      const rec = input.work.crews.find((x) => x.crew === crew)!;
      for (const kind of ["day", "night"] as const) {
        const ns = Object.entries(rec.byShift).filter(([key]) => key.endsWith(`:${kind}`)).map(([, x]) => x.counted?.total ?? x.counted?.direct ?? null).filter((x): x is number => x != null && x > 0);
        if (ns.length >= 2 && Math.min(...ns) < Math.max(...ns) && k[kind] > 0) limits.push(`${crew}'s head count ran from ${Math.min(...ns)} to ${Math.max(...ns)} on ${kind} shifts. The replay holds it to ${plural(k[kind], "step")} at once every ${kind} shift, so on its smaller shifts it may ask more of it than were there.`);
      }
    }
  }
  for (const n of nodes.values()) {
    const s = r.steps.find((x) => x.s.id === n.id)!.s;
    if (s.status !== "done") continue; // named on its own (notDone)
    if (!n.real.idx.length && s.start == null && s.finish == null) limits.push(`${named(n.name, n.orderName)} has no start, finish or progress recorded: it is taken as taking no time.`);
    else if (!n.real.idx.length && n.how !== "off site") limits.push(`${named(n.name, n.orderName)} has no progress recorded: it is taken as taking no time between what it waited on and what waited on it.`);
    else {
      if (s.start == null && n.how !== "as ran") limits.push(`${named(n.name, n.orderName)} was marked done with no start recorded: it is taken at the ${plural(n.units, "shift")} its progress was logged.`);
      if (s.finish == null) limits.push(`${named(n.name, n.orderName)} has no finish time recorded: the end of its last logged shift is taken as its finish.`);
    }
  }
  for (const x of r.steps) if (!r.acts.has(x.s.id)) limits.push(`${named(x.s.name, x.o.name)} isn't among the schedule's steps: what it waited on isn't known, so it stays as it ran.`);
  if ([...nodes.values()].some((n) => n.found)) limits.push("Found and added work starts no sooner than it really did: the record doesn't say how long approving it and getting ready for it took.");
  if (input.review) limits.push(...unmatched);
  for (const id of asked) if (!delays.some((d) => d.id === id)) limits.push(`"${id}" is not a delay the record lists: left in.`);

  // In a sentence.
  const setters = settersOf(nodes, placed);
  const setterWords = setters.length ? list(setters.map((n) => `${named(n.name, n.orderName)}`)) : "the last step";
  const sets = setters.length > 1 ? "set" : "sets";
  const pulled = moves.filter((m) => m.savedH > 0);
  const said = c.actualFinish == null || c.replayFinish == null ? "Nothing was recorded to replay."
    : c.savedH > 0 ? `Same crews, same work, better timed: done ${whenWord(c.replayFinish, tz)} instead of ${whenWord(c.actualFinish, tz)}, ${c.savedH} h sooner. ${setterWords} ${sets} the finish.`
      : pulled.length ? `${plural(pulled.length, "step")} could have started sooner with the same crews, but the finish stays at ${whenWord(c.actualFinish, tz)}: ${setterWords} still ${sets} it.`
        : `Nothing could be pulled in with the same crews and the same work: the finish stays at ${whenWord(c.actualFinish, tz)}, set by ${setterWords}.`;

  let whatIf: Replay["whatIf"] = null;
  if (chosen.length) {
    const b = replayCore(r, new Set());
    const fw = b.replayFinish, fo = c.replayFinish;
    const saved = fw != null && fo != null ? r1(Math.max(0, (fw - fo) / H)) : 0;
    const labels = list(chosen.map((d) => d.short));
    whatIf = {
      without: chosen.map((d) => ({ id: d.id, label: d.short })), finishWith: fw, finishWithout: fo, savedH: saved,
      said: fw == null || fo == null ? "Nothing was recorded to replay."
        : saved > 0 ? `Without ${labels}: done ${whenWord(fo, tz)} instead of ${whenWord(fw, tz)}, ${saved} h sooner. ${setterWords} ${sets} the finish then.`
          : `Taking out ${labels} doesn't move the finish: ${setterWords} still ${sets} it.`,
    };
  }

  return {
    actualFinish: c.actualFinish, replayFinish: c.replayFinish, savedH: c.savedH, sequence: c.sequence,
    steps, shifts: r.shifts.slice(firstIdx, lastIdx + 1), moves, capacity, kept, limits, notDone: notDone.map((x) => x.s.name), said, whatIf,
  };
}
