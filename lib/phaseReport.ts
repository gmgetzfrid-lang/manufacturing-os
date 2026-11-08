// phaseReport - how a phase did (or the whole project, phase by phase):
// progress against plan day by day, the finish, the hours, the work added,
// and its share of the money: the budget split by the phases' shares, what's
// committed and spent on it.
//
// Money by phase:
//   - a budget line kept for one phase is all that phase's; any other line
//     is split by the phases' shares (the AFE slider);
//   - spending goes where it was booked (the entry's phase), else its
//     line's phase, else the phase whose dates it falls in, else it's
//     split by the shares too.
//
// Pure, but for the HTML's look. Everything said comes from the data.

import type { Milestone } from "@/types/schema";
import type { ProgressLogRow } from "@/lib/progressHistory";
import { phaseIndex, phaseOnDay, phaseAmount, phaseDates, type ProjectPhase } from "@/lib/projectPhases";
import { dayKey, fmtInTz } from "@/lib/scheduleTz";
import { workHours, expectedFraction, shiftWindowsBetween, DEFAULT_SHIFT_TIMES, type ShiftTimes } from "@/lib/shiftReport";
import { builtCurves, pctAt, type BuiltCurve } from "@/lib/asBuiltProgress";
import { woOf } from "@/lib/workOrderCrew";
import { originalPlan } from "@/lib/closeoutStatus";
import { noEmDash } from "@/lib/noEmDash";
import { discoveryOf } from "@/lib/discovery";

export interface CostLine { id: string; name: string; cost_type?: string | null; budget: number | null; phase_id?: string | null; status?: string | null }
export interface CostEntry { cost_account_id: string; entry_type: string; amount: number | null; entry_date: string | null; status?: string | null; phase_id?: string | null }

/** One shift on the progress chart: where the original plan said the work
 *  would be by its end, and where it really was (as built). */
export interface ShiftRow {
  kind: "day" | "night";
  /** The plant day it belongs to (a night belongs to the day it starts). */
  dayKey: string;
  start: number;
  end: number;
  /** % of the original plan's work planned done by the shift's end (by
   *  now for the shift under way). Null once the plan has finished (the
   *  shift after the one it finishes in). */
  plan: number | null;
  /** The shift the original plan finishes in. */
  planEnds: boolean;
  /** % of the original plan's work done by the shift's end, as built (by
   *  now for the shift under way). Null for shifts to come. */
  done: number | null;
  /** Work not in the original plan: the hours of it known by then, and
   *  done by then (null for shifts to come). */
  addedKnown: number;
  addedDone: number | null;
  /** Under way now. */
  current: boolean;
  /** The shift the last step was done in. */
  finishes: boolean;
}

/** A step in the slip story: which, and where it stood. */
export interface SlipStep {
  id: string;
  name: string;
  /** The task (equipment) it's under, and its work order. */
  task: string;
  wo: string;
  crew: string;
  /** In the original plan (else added after). */
  inPlan: boolean;
  /** Hours of its planned work it was behind at the time. */
  hoursBehind: number;
  /** When it was done (null: not yet). */
  finish: number | null;
}

/** When the work fell behind the original plan, and what was behind:
 *  from the times recorded, no schedule links needed. */
export interface Slip {
  /** The first shift it was behind. */
  first: ShiftRow | null;
  /** The shift it fell behind for good: behind from then until the plan's
   *  work was all done. */
  forGood: ShiftRow | null;
  /** The widest gap: points, and hours of the plan's work. */
  widest: { row: ShiftRow; points: number; hours: number } | null;
  /** When it fell behind for good (else first): the steps furthest behind. */
  behind: SlipStep[];
  /** Still going when the plan said all done (finished after it, or not yet). */
  pastPlan: SlipStep[];
}

export interface PhaseStats {
  phase: ProjectPhase | null;
  steps: number;
  done: number;
  /** Hours of work, all of it (with any added). */
  hours: number;
  /** % complete now, and % planned by now (hours-weighted) - the Shift
   *  tab's own figures. */
  actualPct: number;
  plannedPct: number;
  plannedStart: number | null;
  /** The original plan's finish (see planBasis). */
  plannedFinish: number | null;
  /** Every step done: when the last one finished. */
  finishedAt: number | null;
  /** Added after the plan (discovery and added scope): how many finds, their
   *  steps, and the hours of work as the schedule has it now. */
  added: { count: number; steps: number; hours: number };
  /** Shift by shift: the original plan against the work done, as built. */
  shifts: ShiftRow[];
  /** When it fell behind and what was behind (see Slip). */
  slip: Slip;
  /** The plan the chart is measured against: the original plan as saved
   *  (the baseline), else, with none saved, the schedule as it is. */
  planBasis: { kind: "baseline" | "schedule"; savedAt: number | null; hours: number; steps: number; start: number | null; finish: number | null };
  /** Work not in that plan: steps and hours (added work, and steps put in
   *  after the plan was saved). */
  outside: { steps: number; hours: number };
  /** Done with no start recorded: spread from their planned start. */
  startGuessed: number;
  /** Done (or under way) with no time to place it: counted from now only. */
  untimed: number;
  /** This phase has no schedule yet. */
  noSchedule: boolean;
  /** Its schedule was put in after its planned start, with nothing done
   *  before then recorded: when it was put in. */
  loadedLate: number | null;
  /** The whole project: the phases with no schedule yet, and how many are done. */
  missing: ProjectPhase[];
  phasesDone: number;
  /** The whole project: how many phases it has (0 when it has none, or for a phase). */
  phaseCount: number;
  budget: number;
  committed: number;
  spent: number;
  lines: Array<{ name: string; budget: number; committed: number; spent: number }>;
}

const ms = (s: unknown) => { const t = typeof s === "string" ? Date.parse(s) : typeof s === "number" ? s : NaN; return Number.isFinite(t) ? t : null; };
const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 10 : 0);

/** The steps that are work: not a task over others, not a summary, not
 *  cancelled, with planned dates (the shift report's own rule, so the two
 *  agree on % planned and done). */
function leaves(ms0: Milestone[]): Milestone[] {
  const parents = new Set(ms0.map((m) => m.parentId).filter(Boolean) as string[]);
  return ms0.filter((m) => m.id && !parents.has(m.id) && !m.isSummary && !(m as { cancelledAt?: unknown }).cancelledAt
    && m.plannedAt && (ms(m.plannedStartAt) ?? ms(m.plannedAt)) != null);
}

const doneOf = (m: Milestone) => m.status === "completed" || Number(m.percentComplete ?? 0) >= 100;

/** When the schedule was put in, if that was after its planned start and
 *  no work before then has been recorded (else null). */
function loadedLateOf(work: Milestone[], planStart: number | null): number | null {
  const made = work.map((m) => ms(m.createdAt)).filter((x): x is number => x != null);
  if (!made.length || planStart == null) return null;
  const at = Math.min(...made);
  if (at <= planStart + 3_600_000) return null;
  const before = work.some((m) => { const a = ms(m.actualStartAt) ?? ms(m.actualAt); return a != null && a < at; });
  return before ? null : at;
}

/** Behind the original plan at a shift's end (after the plan was done, its
 *  work counts as planned 100%). */
export const behindAt = (r: ShiftRow) => r.done != null && r.done + 0.05 < (r.plan ?? 100);

function slipOf(x: {
  shifts: ShiftRow[]; work: Milestone[]; plan: Milestone[]; planHours: number; planFinish: number | null;
  curves: Map<string, BuiltCurve>; weight: (m: Milestone) => number; now: number; tz: string; times: ShiftTimes;
  inPlan: Set<string>; milestones: Milestone[];
}): Slip {
  const rows = x.shifts.filter((r) => r.done != null);
  const first = rows.find(behindAt) ?? null;
  // Behind from here to the end (or until the plan's work reached 100%).
  let forGood: ShiftRow | null = null;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (!behindAt(rows[i])) break;
    forGood = rows[i];
  }
  if (forGood && rows[rows.length - 1] && !behindAt(rows[rows.length - 1])) forGood = null;
  // Caught up in the end (the plan's work all done): the streak before that.
  if (!forGood) {
    let end = rows.length - 1;
    while (end >= 0 && !behindAt(rows[end])) end--;
    if (end >= 0 && rows.slice(end + 1).every((r) => (r.done ?? 0) >= 100)) {
      let i = end;
      while (i > 0 && behindAt(rows[i - 1])) i--;
      forGood = rows[i];
    }
  }
  let widest: Slip["widest"] = null;
  for (const r of rows) {
    if (!behindAt(r)) continue;
    const points = Math.round(((r.plan ?? 100) - (r.done ?? 0)) * 10) / 10;
    if (!widest || points > widest.points) widest = { row: r, points, hours: Math.round((points / 100) * x.planHours * 10) / 10 };
  }
  const byId = new Map(x.milestones.filter((m) => m.id).map((m) => [m.id!, m]));
  const about = (m: Milestone) => {
    const parent = m.parentId ? byId.get(m.parentId) : undefined;
    let wo = woOf(m);
    for (let p = parent; !wo && p; p = p.parentId ? byId.get(p.parentId) : undefined) wo = woOf(p);
    return { id: m.id!, name: m.name, task: parent?.name ?? "", wo, crew: m.responsibleParty?.trim() ?? "", inPlan: x.inPlan.has(m.id!) };
  };
  const at = forGood ?? first;
  const behind: SlipStep[] = [];
  if (at) {
    const t = at.current ? x.now : at.end;
    for (const m of x.plan) {
      const c = x.curves.get(m.id!);
      const planned = expectedFraction(m, t, x.tz, x.times);
      const done = c && c.points.length ? pctAt(c, t) / 100 : 0;
      const hb = x.weight(m) * (planned - done);
      if (hb >= 0.5) behind.push({ ...about(m), hoursBehind: Math.round(hb * 10) / 10, finish: doneOf(m) ? ms(m.actualAt) : null });
    }
    behind.sort((a, b) => b.hoursBehind - a.hoursBehind);
  }
  const pastPlan: SlipStep[] = [];
  if (x.planFinish != null) {
    for (const m of x.work) {
      const f = doneOf(m) ? ms(m.actualAt) : null;
      if (f != null ? f > x.planFinish : x.now > x.planFinish) {
        const c = x.curves.get(m.id!);
        const left = c && c.points.length ? 1 - pctAt(c, x.planFinish) / 100 : 1;
        pastPlan.push({ ...about(m), hoursBehind: Math.round(x.weight(m) * left * 10) / 10, finish: f });
      }
    }
    pastPlan.sort((a, b) => (a.finish ?? Infinity) - (b.finish ?? Infinity));
  }
  return { first, forGood, widest, behind, pastPlan };
}

/** One phase's numbers (phase null: the whole project). */
export function phaseStats(input: {
  milestones: Milestone[]; phases: ProjectPhase[]; phase: ProjectPhase | null;
  log: ProgressLogRow[] | null; tz: string; now: number;
  /** The shift times: the plan earns progress only while the crew is on shift. */
  times?: ShiftTimes;
  /** The AFE (else the lines' total) to split by the shares. */
  total: number | null;
  lines: CostLine[]; entries: CostEntry[];
}): PhaseStats {
  const { phases, phase, tz, now } = input;
  const times = input.times ?? DEFAULT_SHIFT_TIMES;
  // Weighed by hours of work, as the shift report weighs them.
  const weight = (m: Milestone) => workHours(m, tz);
  const idx = phaseIndex(input.milestones, phases);
  const mine = phase ? input.milestones.filter((m) => m.id && idx.get(m.id) === phase.id) : input.milestones;
  const work = leaves(mine);
  const hours = work.reduce((a, m) => a + weight(m), 0);
  const done = work.filter(doneOf);
  const earned = work.reduce((a, m) => a + weight(m) * (doneOf(m) ? 1 : Math.max(0, Math.min(100, Number(m.percentComplete ?? 0))) / 100), 0);
  const plannedAt = (t: number) => work.reduce((a, m) => a + weight(m) * expectedFraction(m, t, tz, times), 0);
  const finishes = done.map((m) => ms(m.actualAt)).filter((x): x is number => x != null);

  // The whole project with phases: a phase with no schedule isn't done.
  const all = leaves(input.milestones);
  const inPhase = (p: ProjectPhase) => all.filter((m) => m.id && idx.get(m.id) === p.id);
  const missing = !phase ? phases.filter((p) => inPhase(p).length === 0) : [];
  const phasesDone = !phase ? phases.filter((p) => { const w = inPhase(p); return w.length > 0 && w.every(doneOf); }).length : 0;
  const finishedAt = work.length > 0 && done.length === work.length && finishes.length && missing.length === 0 ? Math.max(...finishes) : null;

  // The plan the chart measures against: the original plan (saved), and
  // what's outside it (added after).
  const plan = originalPlan(work);
  const inPlan = new Set(plan.steps.map((m) => m.id!));
  const outside = work.filter((m) => !inPlan.has(m.id!));
  const planHours = plan.steps.reduce((a, m) => a + weight(m), 0);
  const planAt = (t: number) => plan.steps.reduce((a, m) => a + weight(m) * expectedFraction(m, t, tz, times), 0);

  // As built: each step's progress over time.
  const curves = builtCurves(work, input.log, now);
  const startGuessed = work.filter((m) => doneOf(m) && !Number.isFinite(Date.parse(String(m.actualStartAt ?? ""))) && (curves.get(m.id!)?.points.length ?? 0) > 0).length;
  const untimed = work.filter((m) => { const c = curves.get(m.id!); return !!c && c.points.length === 0 && c.untimed > 0; }).length;
  const doneHours = (steps: Milestone[], t: number, withUntimed: boolean) => steps.reduce((a, m) => {
    const c = curves.get(m.id!);
    if (!c) return a;
    const p = c.points.length ? pctAt(c, t) : withUntimed ? c.untimed : 0;
    return a + weight(m) * p / 100;
  }, 0);
  const knownAt = (m: Milestone) => discoveryOf(m)?.foundAt ?? ms(m.createdAt) ?? -Infinity;

  const shifts: ShiftRow[] = [];
  if (work.length) {
    const startsAt = [plan.start, ...[...curves.values()].map((c) => c.points[0]?.[0] ?? null)].filter((x): x is number => x != null && Number.isFinite(x));
    const allDone = done.length === work.length;
    const lastDone = finishes.length ? Math.max(...finishes) : null;
    const endsAt = [plan.finish, allDone ? lastDone : now].filter((x): x is number => x != null && Number.isFinite(x));
    if (startsAt.length && endsAt.length) {
      const wins = shiftWindowsBetween(Math.min(...startsAt), Math.max(...endsAt) + 1, tz, times, 400);
      const lastWin = wins[wins.length - 1];
      for (const w of wins) {
        const current = now >= w.start && now < w.end;
        const future = w.start >= now;
        const t = current ? now : w.end;
        const planEnds = plan.finish != null && plan.finish > w.start && plan.finish <= w.end;
        // The shift under way: measured against the plan by now, not by its end (it isn't over).
        const planVal = plan.finish != null && w.start >= plan.finish ? null : pct(planAt(t), planHours);
        // Steps with no time to place them count from now: in the shift under way, or the last one shown.
        const withUntimed = current || (w === lastWin && now >= w.end);
        shifts.push({
          kind: w.kind, dayKey: w.dayKey, start: w.start, end: w.end,
          plan: planHours > 0 ? planVal : null, planEnds,
          done: future || planHours <= 0 ? null : pct(doneHours(plan.steps, t, withUntimed), planHours),
          addedKnown: Math.round(outside.filter((m) => knownAt(m) <= w.end).reduce((a, m) => a + weight(m), 0) * 10) / 10,
          addedDone: future ? null : Math.round(doneHours(outside, t, withUntimed) * 10) / 10,
          current,
          finishes: allDone && lastDone != null && lastDone > w.start && lastDone <= w.end,
        });
      }
    }
  }

  // The slip story: when it fell behind, and what was behind.
  const slip = slipOf({ shifts, work, plan: plan.steps, planHours, planFinish: plan.finish, curves, weight, now, tz, times, inPlan, milestones: input.milestones });

  // Added after the plan: discovery and added scope.
  const addedSteps = work.filter((m) => !!discoveryOf(m));
  const finds = new Set(addedSteps.map((m) => discoveryOf(m)!.id));

  // Money.
  const shareOf = (p: ProjectPhase | null) => (p ? p.share : 100);
  const linePhaseShare = (l: CostLine) => (!phase ? 1 : l.phase_id ? (l.phase_id === phase.id ? 1 : 0) : shareOf(phase) / 100);
  const lineById = new Map(input.lines.map((l) => [l.id, l]));
  const entryShare = (e: CostEntry) => {
    if (!phase) return 1;
    const line = lineById.get(e.cost_account_id);
    const ph = e.phase_id || line?.phase_id || (e.entry_date ? phaseOnDay(e.entry_date.slice(0, 10), phases)?.id : null) || null;
    return ph ? (ph === phase.id ? 1 : 0) : shareOf(phase) / 100;
  };
  const lineRows = input.lines.filter((l) => l.status !== "closed").map((l) => {
    const es = input.entries.filter((e) => e.cost_account_id === l.id && e.status !== "void");
    const sum = (types: string[]) => es.filter((e) => types.includes(e.entry_type)).reduce((a, e) => a + Number(e.amount ?? 0) * entryShare(e), 0);
    return { name: l.name, budget: Math.round(Number(l.budget ?? 0) * linePhaseShare(l)), committed: Math.round(sum(["commitment"])), spent: Math.round(sum(["actual", "adjustment"])) };
  }).filter((r) => r.budget || r.committed || r.spent);
  const linesTotal = input.lines.reduce((a, l) => a + Number(l.budget ?? 0), 0);
  const budget = phase ? phaseAmount(input.total ?? linesTotal, phase.share) : Math.round(input.total ?? linesTotal);

  return {
    phase, steps: work.length, done: done.length, hours: Math.round(hours),
    actualPct: pct(earned, hours), plannedPct: pct(plannedAt(now), hours),
    plannedStart: plan.start, plannedFinish: plan.finish, finishedAt,
    added: { count: finds.size, steps: addedSteps.length, hours: Math.round(addedSteps.reduce((a, m) => a + weight(m), 0)) },
    shifts, slip,
    planBasis: { kind: plan.kind, savedAt: plan.savedAt, hours: Math.round(planHours), steps: plan.steps.length, start: plan.start, finish: plan.finish },
    outside: { steps: outside.length, hours: Math.round(outside.reduce((a, m) => a + weight(m), 0)) },
    startGuessed, untimed,
    noSchedule: work.length === 0, missing, phasesDone, phaseCount: phase ? 0 : phases.length,
    loadedLate: loadedLateOf(work, plan.start),
    budget,
    committed: lineRows.reduce((a, r) => a + r.committed, 0), spent: lineRows.reduce((a, r) => a + r.spent, 0),
    lines: lineRows,
  };
}

// ─── The report (print, the screen's preview, email) ─────────────────────

const NAVY = "#000A72", INK = "#0f172a", MUTED = "#64748b", RULE = "#e2e8f0", GREEN = "#0f766e", RED = "#b91c1c", AMBER = "#b45309";
const FONT = "font-family:Lato,Calibri,Arial,sans-serif;";
const esc = (s: string) => noEmDash(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const money = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

/** A bar as table cells (shows in Outlook and Gmail, and prints). */
function bar(p: number, color: string, mark?: number): string {
  const w = Math.max(0, Math.min(100, Math.round(p)));
  const m = mark != null ? Math.max(0, Math.min(100, Math.round(mark))) : null;
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;"><tr>` +
    (w > 0 ? `<td width="${w}%" bgcolor="${color}" style="background-color:${color};height:10px;line-height:10px;font-size:0;${m != null && m <= w ? `border-right:2px solid ${INK};` : ""}">&nbsp;</td>` : "") +
    (w < 100 ? `<td bgcolor="#f1f5f9" style="background-color:#f1f5f9;height:10px;line-height:10px;font-size:0;${m != null && m > w ? `border-right:2px solid ${INK};` : ""}">&nbsp;</td>` : "") +
    `</tr></table>`;
}

function tile(label: string, value: string, sub: string, color = INK): string {
  return `<td style="${FONT}border:1px solid ${RULE};padding:8px 10px;vertical-align:top;" width="20%"><div style="font-size:9.5px;font-weight:bold;letter-spacing:.08em;text-transform:uppercase;color:${MUTED};">${esc(label)}</div>` +
    `<div style="font-size:19px;font-weight:bold;color:${color};margin-top:2px;">${esc(value)}</div><div style="font-size:11px;color:${MUTED};">${esc(sub)}</div></td>`;
}

const h2 = (t: string) => `<div style="${FONT}font-size:14px;font-weight:bold;color:${NAVY};margin:18px 0 6px;border-bottom:2px solid ${NAVY};padding-bottom:3px;">${esc(t)}</div>`;

const dayWords = (dayKey: string) => { const [y, m, d] = dayKey.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }); };
const dateTime = (t: number, tz: string) => `${fmtInTz(t, tz, { weekday: "short", month: "short", day: "numeric" })}, ${fmtInTz(t, tz, { hour: "numeric", minute: "2-digit", hour12: true })}`;
const hrs = (h: number) => `${Math.round(h * 10) / 10} h`;

/** "Sat, Oct 24 · Night" */
export const shiftLabel = (r: ShiftRow) => `${dayWords(r.dayKey)} · ${r.kind === "day" ? "Day" : "Night"}`;


/** What the chart shows, in words: what the gray is measured from, how the
 *  green was worked out, and anything it couldn't place. Said every time. */
export function chartKey(s: PhaseStats, tz: string): string[] {
  const b = s.planBasis;
  const out = [
    b.kind === "baseline"
      ? `Gray: the original plan${b.savedAt != null ? ` as saved ${fmtInTz(b.savedAt, tz, { weekday: "short", month: "short", day: "numeric" })}` : ""}, ${hrs(b.hours)} of work${b.finish != null ? ` finishing ${dateTime(b.finish, tz)}` : ""}. It stops when the plan was done.`
      : `Gray: the schedule as planned, ${hrs(b.hours)} of work${b.finish != null ? ` finishing ${dateTime(b.finish, tz)}` : ""} (no original plan was saved, so this is the schedule as it is now, without added work). It stops when the plan was done.`,
    "Green: that work done by the end of each shift, from the times recorded on each step (its start, any % entered, its finish), spread evenly between them. Red where it was behind the plan.",
  ];
  if (s.outside.steps) out.push(`Added work, not in the original plan (${s.outside.steps} step${s.outside.steps === 1 ? "" : "s"}, ${hrs(s.outside.hours)}), is counted on its own: done of what was known by then.`);
  if (s.startGuessed) out.push(`${s.startGuessed} step${s.startGuessed === 1 ? " was" : "s were"} marked done with no start time recorded: spread from the planned start.`);
  if (s.untimed) out.push(`${s.untimed} step${s.untimed === 1 ? " has" : "s have"} progress with no time recorded: counted only in the last shift shown.`);
  return out;
}

/** "Phase 2: no schedule yet, should have started Sat, Nov 7" */
export function noScheduleWords(p: ProjectPhase, now: number, tz: string): string {
  if (!p.start) return `${p.name}: no schedule yet`;
  return `${p.name}: no schedule yet, ${p.start <= dayKey(now, tz) ? "should have started" : "starts"} ${dayWords(p.start)}`;
}

/** One phase's section: numbers, progress shift by shift, money by line. */
export function phaseSectionHtml(s: PhaseStats, tz: string, now: number,
  /** chart: false - the whole project in phases: each phase's chart and story follow, each against its own plan. */
  opts: { chart?: boolean } = {}): string {
  const chart = opts.chart !== false;
  const when = (t: number | null) => (t == null ? "-" : dateTime(t, tz));
  if (s.noSchedule && s.phase) {
    return `<div style="${FONT}font-size:13px;color:${AMBER};margin-top:8px;padding:8px 10px;border:1px solid #fcd34d;background:#fffbeb;"><b>${esc(noScheduleWords(s.phase, now, tz))}.</b> Nothing to measure until its schedule is imported.</div>` + moneyHtml(s);
  }
  const late = s.finishedAt != null && s.plannedFinish != null ? s.finishedAt - s.plannedFinish : null;
  const lateWords = late == null ? null : Math.abs(late) < 1_800_000 ? "on plan" : `${hrs(Math.abs(late) / 3_600_000)} ${late > 0 ? "after" : "before"} plan`;
  const gap = s.actualPct - s.plannedPct;
  const left = s.budget - s.spent;
  const notAll = s.missing.length > 0;
  let html = "";
  if (notAll) html += `<div style="${FONT}font-size:12.5px;color:${AMBER};margin-top:8px;padding:8px 10px;border:1px solid #fcd34d;background:#fffbeb;"><b>${esc(s.missing.map((p) => noScheduleWords(p, now, tz)).join("; "))}.</b> The project isn't done, and the figures below cover only the phases with a schedule.</div>`;
  html += `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;margin-top:6px;"><tr>` +
    // The whole project in phases: how many phases are done, never one % across them.
    (!chart && s.phaseCount
      ? tile("Phases done", `${s.phasesDone} of ${s.phaseCount}`, "each against its own plan below", s.phasesDone === s.phaseCount ? GREEN : INK)
      : tile(notAll ? "Complete (scheduled)" : "Complete", `${s.actualPct}%`, `plan by now ${s.plannedPct}%`, gap >= 0 ? GREEN : RED)) +
    tile("Steps done", `${s.done} / ${s.steps}`, `${s.hours.toLocaleString("en-US")} h of work`) +
    (notAll
      ? tile("Finish", "Not finished", `${s.missing.map((p) => p.name).join(", ")} not scheduled`, AMBER)
      : tile(s.finishedAt != null ? "Finished" : "Planned finish", s.finishedAt != null ? when(s.finishedAt) : when(s.plannedFinish), s.finishedAt != null ? `${lateWords} (plan ${when(s.plannedFinish)})` : `plan started ${when(s.plannedStart)}`, late != null && late > 1_800_000 ? RED : INK)) +
    tile("Budget", money(s.budget), `${money(s.spent)} spent · ${money(s.committed)} committed`) +
    tile(left >= 0 ? "Left" : "Over budget", money(Math.abs(left)), s.budget ? `${Math.round((s.spent / s.budget) * 100)}% of budget spent` : "no budget", left >= 0 ? GREEN : RED) +
    `</tr></table>`;
  if (s.added.count) html += `<div style="${FONT}font-size:12px;color:${AMBER};margin-top:6px;"><b>Added after the plan:</b> ${s.added.count} (${s.added.steps} step${s.added.steps === 1 ? "" : "s"}), ${s.added.hours} h of work (discovery and added scope).</div>`;

  if (!chart) return html + `<div style="${FONT}font-size:11.5px;color:${MUTED};margin-top:6px;">Each phase is measured against its own plan below: the phases aren't one job, so their progress isn't drawn as one.</div>` + moneyHtml(s);
  if (s.shifts.length) {
    html += h2("Progress against the original plan, shift by shift");
    html += `<div style="${FONT}font-size:11px;color:${MUTED};margin:0 0 6px;line-height:1.45;">${chartKey(s, tz).map(esc).join("<br>")}</div>`;
    html += `<table cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;${FONT}font-size:11.5px;">` +
      s.shifts.map((r) => {
        const red = behindAt(r);
        const doneColor = red ? RED : GREEN;
        const planCell = r.plan != null ? bar(r.plan, "#94a3b8") : `<div style="font-size:10px;color:${MUTED};">plan done</div>`;
        const doneCell = r.done != null ? bar(r.done, doneColor) : `<div style="font-size:10px;color:${MUTED};">to come</div>`;
        const added = r.addedKnown > 0 ? `<div style="font-size:10px;color:${AMBER};">added ${hrs(r.addedDone ?? 0)} of ${hrs(r.addedKnown)}</div>` : "";
        return `<tr${r.kind === "night" ? ` style="background:#f8fafc;"` : ""}><td style="padding:2px 6px 2px 0;white-space:nowrap;color:${INK};">${esc(shiftLabel(r))}${r.planEnds && s.plannedFinish != null ? `<div style="font-size:10px;font-weight:bold;color:${NAVY};">plan finish ${esc(fmtInTz(s.plannedFinish, tz, { hour: "numeric", minute: "2-digit", hour12: true }))}</div>` : ""}${r.finishes && s.finishedAt != null ? `<div style="font-size:10px;font-weight:bold;color:${GREEN};">all done ${esc(fmtInTz(s.finishedAt, tz, { hour: "numeric", minute: "2-digit", hour12: true }))}</div>` : ""}${r.current ? `<div style="font-size:10px;color:${MUTED};">now</div>` : ""}</td>` +
          `<td style="padding:2px 0;">${planCell}<div style="height:2px;font-size:0;line-height:0;">&nbsp;</div>${doneCell}</td>` +
          `<td style="padding:2px 0 2px 8px;white-space:nowrap;text-align:right;color:${MUTED};" width="22%">${r.plan != null ? `${r.plan}%` : "past plan"}${r.done != null ? ` / <b style="color:${doneColor};">${r.done}%</b>${r.plan == null && red ? ` <b style="color:${RED};">late</b>` : ""}` : ""}${added}</td></tr>`;
      }).join("") + `</table>`;
  }
  return html + slipHtml(s, tz) + moneyHtml(s);
}


/** When it fell behind, by how much, and what was behind (in words). */
export function slipWords(s: PhaseStats, tz: string): string[] {
  const sl = s.slip, out: string[] = [];
  const at = (r: ShiftRow) => `${shiftLabel(r)}: ${r.done}% done against ${r.plan ?? 100}% planned`;
  if (s.loadedLate != null && s.plannedStart != null) out.push(`The schedule was put in ${dateTime(s.loadedLate, tz)}, after its planned start (${dateTime(s.plannedStart, tz)}), and nothing done before then is recorded: enter what's been done, with its times, and this will catch up.`);
  if (sl.forGood) out.push(s.finishedAt != null ? `Fell behind the plan for good ${at(sl.forGood)}, and didn't catch up before the finish.` : `Behind the plan since ${at(sl.forGood)}${sl.forGood.current ? " so far" : ""}, and hasn't caught up yet.`);
  if (sl.first && sl.first !== sl.forGood) out.push(`${sl.forGood ? "Behind once before" : "Behind"} ${at(sl.first)}${sl.forGood ? ", then caught up" : ""}.`);
  if (sl.widest) out.push(`Widest gap ${shiftLabel(sl.widest.row)}: ${sl.widest.points} points, ${hrs(sl.widest.hours)} of the plan's work.`);
  if (!sl.first) out.push("Never behind the original plan at a shift's end.");
  if (s.finishedAt != null && s.plannedFinish != null && s.finishedAt > s.plannedFinish + 1_800_000) out.push(`Planned to be done ${dateTime(s.plannedFinish, tz)}; the last step was done ${dateTime(s.finishedAt, tz)}.`);
  return out;
}

const stepLine = (x: SlipStep) => `${x.task ? `${x.task} \u203a ` : ""}${x.name}${x.wo ? ` (WO ${x.wo})` : ""}${x.crew ? `, ${x.crew}` : ""}${x.inPlan ? "" : " - added after the plan"}`;
export { stepLine as slipStepLine };

function slipHtml(s: PhaseStats, tz: string): string {
  const sl = s.slip;
  if (!s.shifts.length) return "";
  const words = slipWords(s, tz);
  const list = (title: string, xs: SlipStep[], right: (x: SlipStep) => string, more: number) =>
    `<div style="${FONT}font-size:11.5px;font-weight:bold;color:${INK};margin:8px 0 2px;">${esc(title)}</div>` +
    `<table cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;${FONT}font-size:11px;">${xs.map((x) => `<tr><td style="padding:2px 6px 2px 0;border-bottom:1px solid ${RULE};">${esc(stepLine(x))}</td><td style="padding:2px 0 2px 6px;border-bottom:1px solid ${RULE};text-align:right;white-space:nowrap;color:${MUTED};">${esc(right(x))}</td></tr>`).join("")}</table>` +
    (more > 0 ? `<div style="${FONT}font-size:10.5px;color:${MUTED};">and ${more} more</div>` : "");
  let html = h2(s.finishedAt != null && s.plannedFinish != null && s.finishedAt > s.plannedFinish + 1_800_000 ? "Why it finished late" : "Where it slipped") +
    `<div style="${FONT}font-size:12px;color:${INK};line-height:1.5;">${words.map(esc).join("<br>")}</div>`;
  const at = sl.forGood ?? sl.first;
  if (at && sl.behind.length) html += list(`Furthest behind ${at.current ? "now, in" : "at the end of"} ${shiftLabel(at)}`, sl.behind.slice(0, 6), (x) => `${hrs(x.hoursBehind)} behind`, sl.behind.length - 6);
  if (sl.pastPlan.length && s.plannedFinish != null) html += list(`Still going when the plan said done (${dateTime(s.plannedFinish, tz)})`, sl.pastPlan.slice(0, 10), (x) => (x.finish != null ? `done ${dateTime(x.finish, tz)}` : "not done"), sl.pastPlan.length - 10);
  return html;
}

function moneyHtml(s: PhaseStats): string {
  if (!s.lines.length) return "";
  return h2("Money by budget line") +
    `<table cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;${FONT}font-size:11.5px;">` +
    `<tr style="color:${MUTED};font-size:10px;text-transform:uppercase;letter-spacing:.06em;"><td style="padding:4px 6px 4px 0;border-bottom:1px solid ${RULE};">Line</td><td style="padding:4px 6px;border-bottom:1px solid ${RULE};" width="34%">Spent of budget</td><td style="padding:4px 6px;text-align:right;border-bottom:1px solid ${RULE};">Budget</td><td style="padding:4px 6px;text-align:right;border-bottom:1px solid ${RULE};">Committed</td><td style="padding:4px 0 4px 6px;text-align:right;border-bottom:1px solid ${RULE};">Spent</td></tr>` +
    s.lines.map((l) => {
      const over = l.budget > 0 && l.spent > l.budget;
      return `<tr><td style="padding:4px 6px 4px 0;border-bottom:1px solid ${RULE};">${esc(l.name)}</td><td style="padding:4px 6px;border-bottom:1px solid ${RULE};">${bar(l.budget ? (l.spent / l.budget) * 100 : 0, over ? RED : GREEN)}</td>` +
        `<td style="padding:4px 6px;text-align:right;border-bottom:1px solid ${RULE};">${money(l.budget)}</td><td style="padding:4px 6px;text-align:right;border-bottom:1px solid ${RULE};">${money(l.committed)}</td><td style="padding:4px 0 4px 6px;text-align:right;border-bottom:1px solid ${RULE};${over ? `color:${RED};font-weight:bold;` : ""}">${money(l.spent)}</td></tr>`;
    }).join("") + `</table>`;
}

/** The phases side by side, and the whole project. */
export function rollupHtml(all: PhaseStats, each: PhaseStats[], tz: string, now: number): string {
  const d = (t: number | null) => (t == null ? "-" : fmtInTz(t, tz, { month: "short", day: "numeric" }));
  const row = (s: PhaseStats, total = false) => {
    const left = s.budget - s.spent;
    const st = total ? `font-weight:bold;border-top:2px solid ${INK};` : `border-bottom:1px solid ${RULE};`;
    const name = `<td style="padding:5px 6px 5px 0;${st}">${esc(s.phase ? s.phase.name : "Whole project")}${s.phase ? `<div style="font-size:10.5px;color:${MUTED};">${esc(phaseDates(s.phase))}</div>` : ""}</td>`;
    const money3 = `<td style="padding:5px 6px;text-align:right;${st}">${money(s.budget)}</td><td style="padding:5px 6px;text-align:right;${st}">${money(s.spent)}</td>` +
      `<td style="padding:5px 0 5px 6px;text-align:right;${st}color:${left >= 0 ? GREEN : RED};">${left >= 0 ? money(left) : `-${money(-left)}`}</td>`;
    if (s.noSchedule && s.phase) {
      return `<tr>${name}<td style="padding:5px 6px;${st}color:${AMBER};font-size:11px;" width="22%">${esc(noScheduleWords(s.phase, now, tz).replace(`${s.phase.name}: `, ""))}</td><td style="padding:5px 6px;text-align:right;${st}color:${MUTED};">-</td><td style="padding:5px 6px;text-align:right;${st}color:${AMBER};">not scheduled</td>${money3}</tr>`;
    }
    if (!s.phase && s.missing.length) {
      return `<tr>${name}<td style="padding:5px 6px;${st}color:${AMBER};font-size:11px;" width="22%">${s.phasesDone} of ${s.phasesDone + (each.length - s.phasesDone)} phases done · ${esc(s.missing.map((p) => p.name).join(", "))} not scheduled</td>` +
        `<td style="padding:5px 6px;text-align:right;${st}">${s.done}/${s.steps}<div style="font-size:10px;font-weight:normal;color:${MUTED};">scheduled so far</div></td><td style="padding:5px 6px;text-align:right;${st}color:${AMBER};">not finished</td>${money3}</tr>`;
    }
    return `<tr>${name}<td style="padding:5px 6px;${st}" width="22%">${bar(s.actualPct, s.actualPct + 0.05 >= s.plannedPct ? GREEN : RED, s.plannedPct)}<div style="font-size:10.5px;color:${MUTED};">${s.actualPct}% done · plan ${s.plannedPct}%</div></td>` +
      `<td style="padding:5px 6px;text-align:right;${st}">${s.done}/${s.steps}</td><td style="padding:5px 6px;text-align:right;${st}">${s.finishedAt != null ? `done ${d(s.finishedAt)}` : `plan ${d(s.plannedFinish)}`}</td>${money3}</tr>`;
  };
  return h2("Phases") + `<table cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;${FONT}font-size:12px;">` +
    `<tr style="color:${MUTED};font-size:10px;text-transform:uppercase;letter-spacing:.06em;"><td style="padding:4px 6px 4px 0;">Phase</td><td style="padding:4px 6px;">Progress</td><td style="padding:4px 6px;text-align:right;">Steps</td><td style="padding:4px 6px;text-align:right;">Finish</td><td style="padding:4px 6px;text-align:right;">Budget</td><td style="padding:4px 6px;text-align:right;">Spent</td><td style="padding:4px 0 4px 6px;text-align:right;">Left</td></tr>` +
    each.map((s) => row(s)).join("") + row(all, true) + `</table>`;
}

/** The whole report: the phase picked, or every phase and the project. */
export function phaseReportHtml(input: { project: string; tz: string; now: number; picked: PhaseStats | null; all: PhaseStats; each: PhaseStats[] }): string {
  const { picked, all, each, tz, now } = input;
  const title = picked?.phase ? `${picked.phase.name} phase report` : "Phase report";
  const sub = picked?.phase ? `${input.project} · ${phaseDates(picked.phase)} · ${picked.phase.share}% of the budget` : `${input.project} · ${each.length} phases`;
  let html = `<div style="${FONT}color:${INK};max-width:820px;">` +
    `<div style="border-top:4px solid ${NAVY};padding:10px 0 4px;"><div style="font-size:10px;font-weight:bold;letter-spacing:.12em;text-transform:uppercase;color:${MUTED};">Phase report</div>` +
    `<div style="font-size:20px;font-weight:bold;color:${NAVY};">${esc(title)}</div><div style="font-size:12px;color:${MUTED};">${esc(sub)} · as of ${esc(fmtInTz(now, tz, { month: "short", day: "numeric" }))} ${esc(fmtInTz(now, tz, { hour: "numeric", minute: "2-digit", hour12: true }))}</div></div>`;
  if (picked?.phase) {
    html += phaseSectionHtml(picked, tz, now);
    html += rollupHtml(all, each, tz, now);
  } else {
    html += rollupHtml(all, each, tz, now);
    html += h2("Whole project") + phaseSectionHtml(all, tz, now, { chart: each.length === 0 });
    for (const s of each) html += `<div style="page-break-before:always;"></div>` + h2(s.phase!.name) + phaseSectionHtml(s, tz, now);
  }
  return html + `</div>`;
}

/** As a page to print. */
export const phaseReportDocument = (title: string, body: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>@page{margin:12mm}body{margin:0;-webkit-print-color-adjust:exact;print-color-adjust:exact}@media screen{body{padding:16px}}</style></head><body>${body}</body></html>`;

/** As plain text (a mail app that won't take formatting). */
export function phaseReportText(input: { project: string; picked: PhaseStats | null; all: PhaseStats; each: PhaseStats[] }): string {
  const line = (s: PhaseStats) => {
    const who = s.phase ? `${s.phase.name} (${phaseDates(s.phase)})` : "Whole project";
    const cash = `budget ${money(s.budget)}, spent ${money(s.spent)}, committed ${money(s.committed)}`;
    if (s.noSchedule && s.phase) return `${who}: no schedule yet · ${cash}`;
    if (!s.phase && s.missing.length) return `${who}: not finished, ${s.missing.map((p) => p.name).join(", ")} not scheduled · ${s.done}/${s.steps} steps scheduled so far · ${cash}`;
    return `${who}: ${s.actualPct}% done, plan ${s.plannedPct}% · ${s.done}/${s.steps} steps${s.finishedAt != null ? " · finished" : ""} · ${cash}`;
  };
  const out = [`${input.picked?.phase ? `${input.picked.phase.name} phase report` : "Phase report"} - ${input.project}`, ""];
  if (input.picked) out.push(line(input.picked), "");
  out.push("PHASES", ...input.each.map(line), line(input.all));
  return noEmDash(out.join("\n"));
}

/** The close-out's "How the job did": the same numbers, progress and money. */
export const howItDidHtml = (s: PhaseStats, tz: string, now: number, opts: { chart?: boolean } = {}) =>
  `<div style="${FONT}color:${INK};max-width:820px;margin:18px auto 0;">${h2(s.phase ? `How ${s.phase.name} did` : "How the job did")}${phaseSectionHtml(s, tz, now, opts)}</div>`;
