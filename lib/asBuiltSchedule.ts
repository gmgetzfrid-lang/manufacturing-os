// asBuiltSchedule - the job as it was really done, work order by work
// order and step by step, against the original plan: when each was planned,
// when it really started and finished, how long it took, how far off the
// plan it finished, and what was added or taken off along the way.
//
//   - Plan: the original plan as saved (lib/closeoutStatus originalPlan),
//     else, with none saved, the schedule as planned. Work added after it
//     was saved has its own planned dates, marked as added.
//   - Actual: the times recorded on each step. A step marked done with no
//     start recorded says so ("not recorded"), and its bar starts at its
//     planned start (lib/asBuilt, the as-built calendar's rule).
//   - Work orders as everywhere else (lib/workOrderGroups).
//
// Builds the timeline (print, PDF), the table, and the Excel file from the
// same rows, so they can't disagree.

import type { Milestone } from "@/types/schema";
import type { CancelledJob } from "@/lib/cancelledJobs";
import { workOrderGroupsOf } from "@/lib/workOrderGroups";
import { workHours } from "@/lib/shiftReport";
import { builtSpan } from "@/lib/asBuilt";
import { startMsOf, finishMsOf } from "@/lib/calendarPlacement";
import { discoveryOf, kindOf, ADDED } from "@/lib/discovery";
import { originalPlan, vsPlanWords } from "@/lib/closeoutStatus";
import { phaseIndex, type ProjectPhase } from "@/lib/projectPhases";
import { fmtInTz, wallClock, dayKey, wallClockToMs } from "@/lib/scheduleTz";
import { noEmDash } from "@/lib/noEmDash";
import { hoursDays } from "@/lib/phaseReport";
import { shiftKey, type AsBuiltWork } from "@/lib/asBuiltWork";

const toMs = (v: unknown): number | null => { const t = v == null || v === "" ? NaN : typeof v === "number" ? v : Date.parse(String(v)); return Number.isFinite(t) ? t : null; };
const H = 3_600_000;
const r1 = (n: number) => Math.round(n * 10) / 10;

export type BuiltStatus = "done" | "in_progress" | "held" | "not_started";
export const BUILT_WORD: Record<BuiltStatus, string> = { done: "Done", in_progress: "In progress", held: "Held", not_started: "Not started" };

export interface BuiltStep {
  id: string;
  name: string;
  crew: string | null;
  /** In the original plan; else added after it ("discovery", "added scope",
   *  or put in after the plan was saved). */
  inPlan: boolean;
  added: string | null;
  planStart: number | null;
  planFinish: number | null;
  /** Actual start: as recorded; null when none was. */
  start: number | null;
  /** Where its bar starts: the recorded start, else (done) its planned start. */
  barStart: number | null;
  finish: number | null;
  status: BuiltStatus;
  pct: number;
  plannedH: number;
  /** Start to finish, both recorded. */
  elapsedH: number | null;
  /** Finished after (+) or before (-) its planned finish, hours. */
  varianceH: number | null;
}

export interface BuiltOrder {
  key: string;
  wo: string | null;
  name: string;
  phase: string | null;
  steps: BuiltStep[];
  planStart: number | null;
  planFinish: number | null;
  start: number | null;
  barStart: number | null;
  /** Every step done: the last finish. */
  finish: number | null;
  done: number;
  status: BuiltStatus;
  /** Every step added after the plan: an added work order. */
  allAdded: boolean;
  /** Found work given its own WO: the work order it was found on. */
  foundOn: string | null;
  varianceH: number | null;
}

export interface AsBuilt {
  orders: BuiltOrder[];
  basis: { kind: "baseline" | "schedule"; savedAt: number | null };
  planStart: number | null;
  planFinish: number | null;
  start: number | null;
  /** Every step done: the last finish. */
  finish: number | null;
  steps: number;
  done: number;
  added: number;
  startsNotRecorded: number;
  cancelled: Array<{ name: string; where: string; steps: number; at: number | null; note: string | null }>;
}

const statusOf = (m: Milestone): BuiltStatus =>
  m.status === "completed" || Number(m.percentComplete ?? 0) >= 100 ? "done"
    : m.status === "on_hold" || m.status === "blocked" ? "held"
      : m.status === "in_progress" || Number(m.percentComplete ?? 0) > 0 || toMs(m.actualStartAt) != null ? "in_progress" : "not_started";

export function buildAsBuilt(input: {
  milestones: Milestone[]; childrenByParent: Map<string, Milestone[]>; cancelled?: CancelledJob[];
  phases?: ProjectPhase[]; tz: string;
}): AsBuilt {
  const { milestones, childrenByParent, tz } = input;
  const phases = input.phases ?? [];
  const leaves = milestones.filter((m) => m.id && !(childrenByParent.get(m.id)?.length) && !m.isSummary && !(m as { cancelledAt?: unknown }).cancelledAt);
  const plan = originalPlan(leaves);
  const inPlan = new Set(plan.steps.map((m) => m.id!));
  const pIdx = phases.length ? phaseIndex(milestones, phases) : null;
  const phaseName = (id: string | undefined) => (id && pIdx ? phases.find((p) => p.id === pIdx.get(id))?.name ?? null : null);

  const stepOf = (m: Milestone): BuiltStep => {
    const based = plan.kind === "baseline" && inPlan.has(m.id!);
    const planStart = based ? toMs(m.baselineStartAt) : Number.isFinite(startMsOf(m)) ? startMsOf(m) : null;
    const planFinish = based ? toMs(m.baselineFinishAt) : Number.isFinite(finishMsOf(m)) ? finishMsOf(m) : null;
    const status = statusOf(m);
    const finish = status === "done" ? toMs(m.actualAt) : null;
    const start = toMs(m.actualStartAt);
    const span = status === "done" && finish != null ? builtSpan(m) : null;
    const barStart = start ?? (span && Number.isFinite(span.start) ? span.start : null);
    const d = discoveryOf(m);
    return {
      id: m.id!, name: m.name, crew: m.responsibleParty?.trim() || null,
      inPlan: inPlan.has(m.id!), added: d ? ADDED[kindOf(d)].lower : inPlan.has(m.id!) ? null : "put in after the plan was saved",
      planStart, planFinish, start, barStart, finish, status,
      pct: status === "done" ? 100 : Math.round(Number(m.percentComplete ?? 0)),
      plannedH: workHours(m, tz),
      elapsedH: start != null && finish != null && finish >= start ? r1((finish - start) / H) : null,
      varianceH: finish != null && planFinish != null ? r1((finish - planFinish) / H) : null,
    };
  };

  const orders: BuiltOrder[] = [];
  const leafIds = new Set(leaves.map((m) => m.id!));
  const byId = new Map(milestones.filter((m) => m.id).map((m) => [m.id!, m]));
  for (const [key, g] of workOrderGroupsOf(milestones, childrenByParent)) {
    const steps = g.steps.filter((m) => leafIds.has(m.id!)).map(stepOf)
      .sort((a, b) => (a.planStart ?? Infinity) - (b.planStart ?? Infinity) || (a.barStart ?? Infinity) - (b.barStart ?? Infinity));
    if (!steps.length) continue;
    const nums = (xs: Array<number | null>) => xs.filter((x): x is number => x != null);
    const done = steps.filter((s) => s.status === "done").length;
    const allDone = done === steps.length;
    const finishes = nums(steps.map((s) => s.finish));
    const planFinishes = nums(steps.map((s) => s.planFinish));
    const finish = allDone && finishes.length === steps.length ? Math.max(...finishes) : null;
    const planFinish = planFinishes.length ? Math.max(...planFinishes) : null;
    orders.push({
      key, wo: g.wo, name: [g.owner.name, ...(g.also ?? []).map((x) => x.name)].join(" + "),
      phase: phaseName(g.owner.id ?? steps[0].id) ?? phaseName(steps[0].id),
      steps,
      planStart: nums(steps.map((s) => s.planStart)).length ? Math.min(...nums(steps.map((s) => s.planStart))) : null,
      planFinish,
      start: nums(steps.map((s) => s.start)).length ? Math.min(...nums(steps.map((s) => s.start))) : null,
      barStart: nums(steps.map((s) => s.barStart)).length ? Math.min(...nums(steps.map((s) => s.barStart))) : null,
      finish, done,
      status: allDone ? "done" : steps.some((s) => s.status === "held") ? "held" : steps.some((s) => s.status !== "not_started") ? "in_progress" : "not_started",
      allAdded: steps.every((s) => !s.inPlan),
      foundOn: discoveryOf(g.owner) && g.owner.parentId ? byId.get(g.owner.parentId)?.name ?? null : null,
      varianceH: finish != null && planFinish != null ? r1((finish - planFinish) / H) : null,
    });
  }
  orders.sort((a, b) => (a.planStart ?? Infinity) - (b.planStart ?? Infinity) || (a.wo ?? "~").localeCompare(b.wo ?? "~"));

  const all = orders.flatMap((o) => o.steps);
  const nums = (xs: Array<number | null>) => xs.filter((x): x is number => x != null);
  const allDone = all.length > 0 && all.every((s) => s.status === "done");
  const fin = nums(all.map((s) => s.finish));
  return {
    orders,
    basis: { kind: plan.kind, savedAt: plan.savedAt },
    planStart: plan.start, planFinish: plan.finish,
    start: nums(all.map((s) => s.barStart)).length ? Math.min(...nums(all.map((s) => s.barStart))) : null,
    finish: allDone && fin.length === all.length ? Math.max(...fin) : null,
    steps: all.length, done: all.filter((s) => s.status === "done").length,
    added: all.filter((s) => !s.inPlan).length,
    startsNotRecorded: all.filter((s) => s.status === "done" && s.start == null).length,
    cancelled: (input.cancelled ?? []).map((c) => ({ name: c.m.name, where: c.crumbs.join(" › "), steps: c.steps, at: c.at, note: c.m.cancelNote ?? null })),
  };
}

/** Steps packed into lanes so none overlap: steps done one after another
 *  share a lane, steps worked at the same time stack. `from`/`to` in ms. */
export function laneSteps<T extends { from: number; to: number }>(xs: T[]): { lanes: number; at: Array<T & { lane: number }> } {
  const ends: number[] = [];
  const at = [...xs].sort((a, b) => a.from - b.from || a.to - b.to).map((x) => {
    let lane = ends.findIndex((e) => e <= x.from);
    if (lane < 0) { lane = ends.length; ends.push(x.to); } else ends[lane] = x.to;
    return { ...x, lane };
  });
  return { lanes: ends.length, at };
}

/** A step's bar as built: its start (recorded, else its planned start when
 *  done) to its finish, or to `now` while it's still going. Null: not
 *  started, or no times to place it. */
export function stepBar(s: BuiltStep, now: number): { from: number; to: number } | null {
  const from = s.barStart;
  const to = s.finish ?? (s.status !== "not_started" ? now : null);
  return from != null && to != null && to > from ? { from, to } : null;
}

// ─── Each work order against its own plan (the screen and the page) ─────

/** How late it finished against its own planned finish, in hours; not
 *  done, how late it is so far (`sofar`). Null: not due yet, or no plan. */
export function lateOf(o: { planFinish: number | null; finish: number | null }, now: number): { h: number | null; sofar: boolean } {
  if (o.planFinish == null) return { h: null, sofar: false };
  if (o.finish != null) return { h: (o.finish - o.planFinish) / H, sofar: false };
  return now > o.planFinish ? { h: (now - o.planFinish) / H, sofar: true } : { h: null, sofar: false };
}

/** "12 h", "26 h (1.1 days)", "6 h so far", "on time (3 h early)": a late
 *  by figure in words, and whether it is late. */
export function lateWords(o: { planFinish: number | null; finish: number | null }, now: number): { text: string; late: boolean } {
  const { h, sofar } = lateOf(o, now);
  if (h == null) return { text: o.planFinish == null ? "no plan" : "not due yet", late: false };
  if (h >= 0.5) return { text: `${hoursDays(h)}${sofar ? " so far" : ""}`, late: true };
  if (sofar) return { text: "due now", late: false };
  return { text: h <= -0.5 ? `on time (${hoursDays(-h)} early)` : "on time", late: false };
}

/** A phase (or the whole job) in a sentence: "Finished 33.5 h late". */
export function answerOf(b: { planFinish: number | null; finish: number | null }, now: number): { text: string; late: boolean } {
  const { h, sofar } = lateOf(b, now);
  if (b.planFinish == null) return { text: b.finish != null ? "Finished, with no plan dates to measure against" : "Not done, with no plan dates", late: false };
  if (h == null) return { text: "Not done yet", late: false };
  if (sofar) return h >= 0.5 ? { text: `Not done, ${hoursDays(h)} past its planned finish`, late: true } : { text: "Not done, due now", late: false };
  return h >= 0.5 ? { text: `Finished ${hoursDays(h)} late`, late: true } : { text: h <= -0.5 ? `Finished ${hoursDays(-h)} early` : "Finished on time", late: false };
}

/** A phase's work orders, on the phase's own plan: its planned finish (the
 *  original plan's last step in it), its finish (every step done), and the
 *  span its bars run across (first planned or actual start to last planned
 *  or actual finish, or now for work still going). */
export interface PhaseBlock { name: string | null; orders: BuiltOrder[]; planFinish: number | null; finish: number | null; from: number; to: number }

/** The work orders by phase, in the order the phases come; one block (name
 *  null) when there are no phases. */
export function phaseBlocks(a: AsBuilt, now: number): PhaseBlock[] {
  const by = new Map<string, BuiltOrder[]>();
  for (const o of a.orders) { const k = o.phase ?? ""; const xs = by.get(k); if (xs) xs.push(o); else by.set(k, [o]); }
  const nums = (xs: Array<number | null>) => xs.filter((v): v is number => v != null);
  return [...by.entries()].map(([k, orders]) => {
    const inPlan = nums(orders.flatMap((o) => o.steps.filter((s) => s.inPlan).map((s) => s.planFinish)));
    const any = nums(orders.map((o) => o.planFinish));
    const planFinish = inPlan.length ? Math.max(...inPlan) : any.length ? Math.max(...any) : null;
    const finish = orders.every((o) => o.finish != null) ? Math.max(...nums(orders.map((o) => o.finish))) : null;
    const pts = nums(orders.flatMap((o) => [o.planStart, o.planFinish, o.barStart, o.finish ?? (o.status !== "not_started" ? now : null)]));
    const from = pts.length ? Math.min(...pts) : now;
    return { name: k || null, orders, planFinish, finish, from, to: Math.max(pts.length ? Math.max(...pts) : now, from + 12 * H) };
  });
}

/** Most late first: the latest against its own planned finish at the top
 *  (work still open by how late it is so far), then on time, then not due
 *  or with no plan; ties in planned start order. */
export function mostLateFirst<T extends { planFinish: number | null; finish: number | null; planStart: number | null }>(xs: T[], now: number): T[] {
  const key = (o: T) => lateOf(o, now).h ?? -Infinity;
  return [...xs].sort((a, b) => key(b) - key(a) || (a.planStart ?? 0) - (b.planStart ?? 0));
}

// ─── Words ───────────────────────────────────────────────────────────────

const esc = (s: string) => noEmDash(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const dt = (t: number | null, tz: string) => (t == null ? "" : `${fmtInTz(t, tz, { month: "numeric", day: "numeric" })} ${fmtInTz(t, tz, { hour: "numeric", minute: "2-digit", hour12: true })}`);
const dtLong = (t: number | null, tz: string) => (t == null ? "-" : `${fmtInTz(t, tz, { weekday: "short", month: "short", day: "numeric" })}, ${fmtInTz(t, tz, { hour: "numeric", minute: "2-digit", hour12: true })}`);
/** "+33.5 h" / "-2 h" / "on plan" */
export const varianceWords = (h: number | null) => (h == null ? "" : Math.abs(h) < 0.5 ? "on plan" : `${h > 0 ? "+" : "-"}${r1(Math.abs(h))} h`);

/** What the plan and the actual times are, in words: said on every copy. */
export function asBuiltKey(a: AsBuilt, tz: string): string[] {
  const out = [
    a.basis.kind === "baseline"
      ? `Plan: the original plan${a.basis.savedAt != null ? ` as saved ${fmtInTz(a.basis.savedAt, tz, { weekday: "short", month: "short", day: "numeric" })}` : ""}. Work added after it shows its own planned dates and is marked added.`
      : "Plan: the schedule as planned (no original plan was saved). Added work is marked added.",
    "Actual: the start and finish times recorded on each step. Finish vs plan: hours after (+) or before (-) the planned finish.",
  ];
  if (a.startsNotRecorded) out.push(`${a.startsNotRecorded} step${a.startsNotRecorded === 1 ? " was" : "s were"} marked done with no start recorded: shown as "not recorded"; the bar starts at the planned start.`);
  return out;
}

// ─── The printable report (landscape) ────────────────────────────────────
//
// As on the screen: the answer, then each phase on its own dates with its
// own planned-finish line, each work order most late first with its planned
// finish, actual finish, late by and shifts waited, and one bar (the plan a
// gray box, as built solid, the part past its own planned finish red, the
// shifts it waited hatched). Then the same work orders with every step:
// on paper nothing is folded away.

const NAVY = "#000A72", INK = "#0f172a", MUTED = "#64748b", RULE = "#e2e8f0", AMBER = "#b45309", BLUE = "#2563eb", GRAY = "#94a3b8", RED = "#b91c1c";
const FONT = "font-family:Lato,Calibri,Arial,sans-serif;";
const PLAN_BOX = `background:#f1f5f9;border:1px solid ${GRAY};`;
/** Laid over a bar: the shifts it waited with nothing logged. */
const WAITED = "background:repeating-linear-gradient(135deg,transparent 0 2px,#ffffff 2px 4px);";
/** Before a step started: ready, its crew elsewhere. */
const READY = `background:repeating-linear-gradient(135deg,#cbd5e1 0 2px,#ffffff 2px 4px);border:1px solid ${GRAY};`;
const NIGHTS = "Shifts waited: shifts between its first and last work with nothing logged (a step: also the shifts it was ready but not started). Night shifts count only for work that ran on nights.";

/** A phase's days, and where a time falls on them (%). */
function axisOf(from: number, to: number, planEnd: number | null, tz: string) {
  const first = dayKey(from, tz), last = dayKey(to, tz);
  const dayStart = (k: string) => { const [y, m, d] = k.split("-").map(Number); return wallClockToMs({ year: y, month: m, day: d, hour: 0, minute: 0, second: 0 }, tz); };
  const days: string[] = [];
  for (let k = first, g = 0; k <= last && g < 120; g++) {
    days.push(k);
    const [y, m, d] = k.split("-").map(Number);
    k = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
  }
  const t0 = dayStart(days[0]);
  const [ly, lm, ld] = days[days.length - 1].split("-").map(Number);
  const t1 = wallClockToMs({ year: ly, month: lm, day: ld + 1, hour: 0, minute: 0, second: 0 }, tz);
  const x = (t: number) => Math.max(0, Math.min(100, ((t - t0) / (t1 - t0)) * 100));
  const grid = days.map((k, i) => `<div style="position:absolute;left:${(i / days.length) * 100}%;top:0;bottom:0;border-left:1px solid ${RULE};"></div>`).join("");
  // The phase's planned finish: one dark line through every row.
  const planLine = planEnd != null ? `<div style="position:absolute;left:${x(planEnd)}%;top:0;bottom:0;border-left:2px solid ${INK};"></div>` : "";
  const head = days.map((k) => { const [y, m, d] = k.split("-").map(Number); const dd = new Date(Date.UTC(y, m - 1, d)); return `<div style="flex:1;text-align:center;font-size:8.5px;color:${MUTED};border-left:1px solid ${RULE};padding:1px 0;">${dd.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" })}<br>${m}/${d}</div>`; }).join("");
  const bar = (s: number | null, f: number | null, style: string, top: number, h: number, title = "") => {
    if (s == null || f == null || f <= s) return "";
    const l = x(s), w = Math.max(0.4, x(f) - l);
    return `<div${title ? ` title="${esc(title)}"` : ""} style="position:absolute;left:${l}%;width:${w}%;top:${top}px;height:${h}px;${style}border-radius:2px;box-sizing:border-box;overflow:hidden;"></div>`;
  };
  return { x, grid, planLine, head, bar };
}
type Axis = ReturnType<typeof axisOf>;
/** Only what the page reads of the job as worked (lib/asBuiltWork). */
type Worked = Pick<AsBuiltWork, "shifts" | "steps" | "orders">;

/** One bar: the plan a gray box, as built solid to its own planned finish,
 *  red past it, the shifts it waited hatched over it; `faded` when its
 *  start wasn't recorded. */
function barHtml(x: { planStart: number | null; planFinish: number | null; from: number | null; to: number | null }, ax: Axis, waits: Array<{ start: number; end: number }>, ready: Array<{ start: number; end: number }> = [], faded = false): string {
  const { planStart: ps, planFinish: pf, from, to } = x;
  const fade = faded ? "opacity:.55;" : "";
  let h = ax.bar(ps, pf, PLAN_BOX, 2, 14);
  for (const r of ready) h += ax.bar(r.start, r.end, READY, 5, 8);
  if (from != null && to != null && to > from) {
    if (pf == null || from < pf) h += ax.bar(from, pf == null ? to : Math.min(to, pf), `background:${BLUE};${fade}`, 5, 8);
    if (pf != null && to > pf) h += ax.bar(Math.max(from, pf), to, `background:${RED};${fade}`, 5, 8);
  }
  for (const w of waits) h += ax.bar(w.start, w.end, WAITED, 5, 8);
  return h;
}

const KEY = `<div style="${FONT}font-size:10px;color:${MUTED};margin:2px 0 4px;">` +
  `<span style="display:inline-block;width:14px;height:8px;${PLAN_BOX}"></span> Plan &nbsp; ` +
  `<span style="display:inline-block;width:14px;height:6px;background:${BLUE};"></span> As built &nbsp; ` +
  `<span style="display:inline-block;width:14px;height:6px;background:${RED};"></span> Past its own planned finish &nbsp; ` +
  `<span style="display:inline-block;width:14px;height:6px;background:${BLUE};position:relative;"><span style="position:absolute;inset:0;${WAITED}"></span></span> Shifts waited, nothing logged &nbsp; ` +
  `<span style="display:inline-block;width:14px;height:6px;${READY}"></span> Ready, not started &nbsp; ` +
  `<span style="display:inline-block;width:2px;height:10px;background:${INK};"></span> The phase's planned finish &nbsp; Faded: start not recorded</div>`;

/** Every work order with its steps, the phases each on their own dates. */
function blocksHtml(a: AsBuilt, tz: string, now: number, work: Worked | null): { overview: string; detail: string } {
  const blocks = phaseBlocks(a, now);
  const idx = new Map((work?.shifts ?? []).map((w, i) => [shiftKey(w), i]));
  const shiftsOf = (keys: string[]) => keys.map((k) => idx.get(k)).filter((i): i is number => i != null).map((i) => work!.shifts[i]);
  const cell = (v: string, extra = "") => `<td style="${FONT}font-size:9.5px;padding:2px 4px;border-bottom:1px solid ${RULE};vertical-align:top;${extra}">${v}</td>`;
  const th = (t: string, right = false) => `<th style="${FONT}font-size:8.5px;font-weight:bold;text-transform:uppercase;letter-spacing:.05em;color:${MUTED};text-align:${right ? "right" : "left"};padding:3px 4px;border-bottom:1px solid ${INK};vertical-align:bottom;">${t}</th>`;
  const when2 = (t: number | null) => (t == null ? "-" : `${esc(fmtInTz(t, tz, { month: "numeric", day: "numeric" }))}<br>${esc(fmtInTz(t, tz, { hour: "numeric", minute: "2-digit", hour12: true }))}`);
  const late = (x: { planFinish: number | null; finish: number | null }) => { const w = lateWords(x, now); return cell(esc(w.text), `text-align:right;${w.late ? `color:${RED};font-weight:bold;` : ""}`); };
  const waited = (n: number | null) => cell(n == null ? "-" : n ? `${n}` : "-", `text-align:right;${n ? `color:${AMBER};font-weight:bold;` : `color:${MUTED};`}`);
  const lane = (ax: Axis, inner: string, h: number) => `<td style="padding:0;border-bottom:1px solid ${RULE};"><div style="position:relative;height:${h}px;">${ax.grid}${inner}${ax.planLine}</div></td>`;
  const orderEnd = (o: BuiltOrder) => o.finish ?? (o.status !== "not_started" ? now : null);
  const orderName = (o: BuiltOrder) => `<b>${o.wo ? `WO ${esc(o.wo)} · ` : ""}${esc(o.name)}</b>${o.phase ? ` <span style="color:${MUTED};">· ${esc(o.phase)}</span>` : ""}${o.allAdded ? ` <span style="color:${AMBER};font-weight:bold;">· added</span>` : ""}` +
    `${o.foundOn ? `<div style="font-size:8.5px;color:${MUTED};">Found on ${esc(o.foundOn)}</div>` : ""}<div style="font-size:8.5px;color:${MUTED};">${o.done} of ${o.steps.length} steps done</div>`;
  const orderBar = (o: BuiltOrder, ax: Axis) => {
    const ow = work?.orders.get(o.key);
    const waits = ow ? ow.cells.flatMap((c, i) => (c === "wait" ? [work!.shifts[i]] : [])) : [];
    return barHtml({ planStart: o.planStart, planFinish: o.planFinish, from: o.barStart, to: orderEnd(o) }, ax, waits);
  };
  const blockHead = (b: PhaseBlock) => {
    const ans = answerOf(b, now);
    return `<div style="${FONT}font-size:12px;color:${INK};margin:10px 0 2px;">${b.name ? `<b style="font-size:13px;">${esc(b.name)}</b> &nbsp;` : ""}` +
      `<span style="color:${MUTED};">Planned finish</span> <b>${esc(dtLong(b.planFinish, tz))}</b> · ${b.finish != null ? `<span style="color:${MUTED};">finished</span> <b>${esc(dtLong(b.finish, tz))}</b>` : "not done yet"}` +
      ` · <b style="color:${ans.late ? RED : INK};">${esc(ans.text.charAt(0).toLowerCase() + ans.text.slice(1))}</b> · ${b.orders.length} work order${b.orders.length === 1 ? "" : "s"}</div>`;
  };
  let overview = "", detail = "";
  for (const b of blocks) {
    const ax = axisOf(b.from, b.to, b.planFinish, tz);
    const orders = mostLateFirst(b.orders, now);
    overview += blockHead(b) +
      `<table cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;table-layout:fixed;"><colgroup><col style="width:230px"><col style="width:64px"><col style="width:64px"><col style="width:84px"><col style="width:46px"><col><col style="width:70px"></colgroup>` +
      `<tr>${th("Work order")}${th("Planned finish")}${th("Actual finish")}${th("Late by", true)}${th("Shifts waited", true)}<th style="padding:0;border-bottom:1px solid ${INK};"><div style="display:flex;">${ax.head}</div></th>${th("Status")}</tr>` +
      orders.map((o) => `<tr>${cell(orderName(o))}${cell(when2(o.planFinish))}${cell(o.finish != null ? when2(o.finish) : esc(BUILT_WORD[o.status].toLowerCase()), o.finish != null ? "" : `color:${MUTED};`)}${late(o)}${waited(work ? work.orders.get(o.key)?.waited ?? 0 : null)}` +
        `${lane(ax, orderBar(o, ax), 20)}${cell(esc(BUILT_WORD[o.status]), "white-space:nowrap;")}</tr>`).join("") + `</table>`;
    detail += blockHead(b) +
      `<table cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;table-layout:fixed;"><colgroup><col style="width:250px"><col style="width:60px"><col style="width:60px"><col><col style="width:44px"><col style="width:84px"><col style="width:46px"><col style="width:74px"></colgroup>` +
      `<tr>${th("Work order, step")}${th("Planned finish")}${th("Actual finish")}<th style="padding:0;border-bottom:1px solid ${INK};"><div style="display:flex;">${ax.head}</div></th>${th("Took", true)}${th("Late by", true)}${th("Shifts waited", true)}${th("Status")}</tr>` +
      orders.map((o) => {
        const top = `<tr style="background:#f1f5f9;">${cell(orderName(o))}${cell(when2(o.planFinish))}${cell(o.finish != null ? when2(o.finish) : "-")}${lane(ax, orderBar(o, ax), 20)}${cell("")}${late(o)}${waited(work ? work.orders.get(o.key)?.waited ?? 0 : null)}${cell(esc(BUILT_WORD[o.status]), "white-space:nowrap;")}</tr>`;
        const steps = o.steps.map((s) => {
          const sb = stepBar(s, now);
          const w = work?.steps.get(s.id);
          const span = s.start != null || s.finish != null ? `${s.start != null ? esc(dt(s.start, tz)) : `<span style="color:${AMBER};">start not recorded</span>`} to ${s.finish != null ? esc(dt(s.finish, tz)) : "still going"}` : "";
          const nWaited = w ? w.waits.reduce((n, r) => n + r.shifts, 0) + (w.ready?.shifts.length ?? 0) : null;
          const bar = barHtml({ planStart: s.planStart, planFinish: s.planFinish, from: sb?.from ?? null, to: sb?.to ?? null }, ax, w ? shiftsOf(w.waits.flatMap((r) => r.keys)) : [], w?.ready ? shiftsOf(w.ready.shifts) : [], s.start == null);
          return `<tr>${cell(`${esc(s.name)}<div style="font-size:8.5px;color:${MUTED};">${[s.crew ? esc(s.crew) : "", span].filter(Boolean).join(" · ")}</div>${s.added ? `<div style="font-size:8.5px;color:${AMBER};">${esc(s.added.charAt(0).toUpperCase() + s.added.slice(1))}</div>` : ""}`, "padding-left:12px;")}` +
            `${cell(when2(s.planFinish))}${cell(s.finish != null ? when2(s.finish) : "-")}${lane(ax, bar, 20)}` +
            `${cell(s.elapsedH != null ? `${s.elapsedH} h` : "", "text-align:right;white-space:nowrap;")}${late(s)}${waited(nWaited)}` +
            `${cell(s.status === "done" ? "Done" : `${esc(BUILT_WORD[s.status])}${s.pct ? ` ${s.pct}%` : ""}`, "white-space:nowrap;")}</tr>`;
        }).join("");
        return top + steps;
      }).join("") + `</table>`;
  }
  const h2 = (t: string) => `<div style="${FONT}font-size:14px;font-weight:bold;color:${NAVY};margin:16px 0 4px;border-bottom:2px solid ${NAVY};padding-bottom:3px;">${esc(t)}</div>`;
  const note = `<div style="${FONT}font-size:9.5px;color:${MUTED};margin-bottom:2px;">Late by: against each work order's own planned finish (a step's against its own). ${work ? esc(NIGHTS) : "Shifts waited weren't read for this copy."}</div>`;
  return {
    overview: h2("Work orders, most late first") + note + KEY + overview,
    detail: h2("Work orders and steps") + `<div style="${FONT}font-size:9.5px;color:${MUTED};">Most late first, each with every step. Plan h and exact times are in the Excel file.</div>` + KEY + detail,
  };
}

/** The whole report as a page to print (landscape). `work`: the job as
 *  worked (lib/asBuiltWork), for the shifts each waited. */
export function asBuiltDocument(a: AsBuilt, o: { project: string; scope: string; tz: string; now: number; work?: Worked | null }): string {
  const { tz, now } = o;
  const tile = (k: string, v: string, s: string) => `<td style="${FONT}border:1px solid ${RULE};padding:6px 8px;vertical-align:top;"><div style="font-size:8.5px;font-weight:bold;letter-spacing:.08em;text-transform:uppercase;color:${MUTED};">${esc(k)}</div><div style="font-size:15px;font-weight:bold;color:${INK};">${esc(v)}</div><div style="font-size:9.5px;color:${MUTED};">${esc(s)}</div></td>`;
  const late = a.finish != null && a.planFinish != null ? r1((a.finish - a.planFinish) / H) : null;
  const blocks = phaseBlocks(a, now);
  // The answer first, each phase against its own plan.
  const answers = blocks.map((b) => ({ b, ans: answerOf(b, now) }));
  const answer = `<div style="${FONT}font-size:16px;font-weight:bold;margin-top:6px;">` + (answers.length === 1
    ? `<span style="color:${answers[0].ans.late ? RED : INK};">${esc(answers[0].ans.text)}</span>`
    : answers.map(({ b, ans }) => `${esc(b.name ?? "No phase")}: <span style="color:${ans.late ? RED : INK};">${esc(ans.text.charAt(0).toLowerCase() + ans.text.slice(1))}</span>`).join(` <span style="color:${MUTED};font-weight:normal;">·</span> `)) + `</div>`;
  const tiles = `<table cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;margin-top:6px;"><tr>` +
    tile("Original plan", a.planStart != null ? `${dt(a.planStart, tz)} to ${dt(a.planFinish, tz)}` : "-", a.basis.kind === "baseline" ? "as saved" : "no plan saved: the schedule as planned") +
    tile("As built", a.start != null ? `${dt(a.start, tz)} to ${a.finish != null ? dt(a.finish, tz) : "still going"}` : "not started", a.finish != null ? "first start to last finish" : `${a.done} of ${a.steps} steps done`) +
    tile(blocks.length > 1 ? "Whole job vs plan" : "Finish vs plan", a.finish != null && late != null ? vsPlanWords(late) : "-", a.finish != null ? `finished ${dtLong(a.finish, tz)}` : "not finished") +
    tile("Steps", `${a.done} / ${a.steps}`, `${a.orders.length} work orders`) +
    tile("Added after the plan", `${a.added} step${a.added === 1 ? "" : "s"}`, a.cancelled.length ? `${a.cancelled.length} taken off` : "nothing taken off") +
    `</tr></table>`;
  const key = `<div style="${FONT}font-size:9.5px;color:${MUTED};margin-top:6px;line-height:1.45;">${asBuiltKey(a, tz).map(esc).join("<br>")}</div>`;
  const cancelled = a.cancelled.length
    ? `<div style="${FONT}font-size:14px;font-weight:bold;color:${NAVY};margin:16px 0 4px;border-bottom:2px solid ${NAVY};padding-bottom:3px;">Taken off the schedule</div>` +
      `<table cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;${FONT}font-size:9.5px;">${a.cancelled.map((c) => `<tr><td style="padding:2px 4px;border-bottom:1px solid ${RULE};"><b>${esc(c.name)}</b>${c.where ? ` <span style="color:${MUTED};">${esc(c.where)}</span>` : ""}</td><td style="padding:2px 4px;border-bottom:1px solid ${RULE};">${c.steps} step${c.steps === 1 ? "" : "s"}</td><td style="padding:2px 4px;border-bottom:1px solid ${RULE};">${esc(dt(c.at, tz))}</td><td style="padding:2px 4px;border-bottom:1px solid ${RULE};">${esc(c.note ?? "")}</td></tr>`).join("")}</table>`
    : "";
  const parts = blocksHtml(a, tz, now, o.work ?? null);
  const body = `<div style="${FONT}color:${INK};">` +
    `<div style="border-top:4px solid ${NAVY};padding:8px 0 2px;"><div style="font-size:10px;font-weight:bold;letter-spacing:.12em;text-transform:uppercase;color:${MUTED};">As-built schedule</div>` +
    `<div style="font-size:19px;font-weight:bold;color:${NAVY};">${esc(o.project)}</div><div style="font-size:11px;color:${MUTED};">${esc(o.scope)} · as of ${esc(dtLong(now, tz))}</div></div>` +
    answer + tiles + key + parts.overview + parts.detail + cancelled + `</div>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(`${o.project} - as-built schedule`)}</title><style>@page{size:landscape;margin:10mm}body{margin:0;-webkit-print-color-adjust:exact;print-color-adjust:exact}@media screen{body{padding:16px}}tr{page-break-inside:avoid}</style></head><body>${body}</body></html>`;
}

// ─── Excel ───────────────────────────────────────────────────────────────

/** An instant as an Excel date-time, in plant time (sorts and filters as a date). */
const excelTime = (t: number | null, tz: string) => {
  if (t == null) return null;
  const w = wallClock(t, tz);
  return { t: "n", v: Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) / 86_400_000 + 25_569, z: "m/d/yyyy h:mm AM/PM" };
};

export async function downloadAsBuilt(a: AsBuilt, o: { project: string; scope: string; tz: string; fileName: string }): Promise<void> {
  const XLSX = await import("xlsx");
  const head = ["Phase", "WO", "Work order", "Step", "Crew", "In original plan", "Added", "Plan start", "Plan finish", "Actual start", "Start recorded", "Actual finish", "Plan h", "Took h", "Finish vs plan (h)", "Status", "%"];
  const aoa: unknown[][] = [
    [`${o.project} - as-built schedule (${o.scope})`],
    ...asBuiltKey(a, o.tz).map((k) => [k]),
    [],
    head,
  ];
  for (const ord of a.orders) {
    for (const s of ord.steps) {
      aoa.push([
        ord.phase ?? "", ord.wo ?? "", ord.name, s.name, s.crew ?? "", s.inPlan ? "Yes" : "No", s.added ?? "",
        excelTime(s.planStart, o.tz), excelTime(s.planFinish, o.tz), excelTime(s.start, o.tz), s.start != null ? "Yes" : s.status === "done" ? "No" : "", excelTime(s.finish, o.tz),
        r1(s.plannedH), s.elapsedH ?? "", s.varianceH ?? "", BUILT_WORD[s.status], s.pct,
      ]);
    }
  }
  const headRow = aoa.findIndex((r) => r === head) + 1;
  const isCell = (c: unknown) => !!c && typeof c === "object" && "z" in (c as object);
  const ws = XLSX.utils.aoa_to_sheet(aoa.map((r) => r.map((c) => (c == null || isCell(c) ? "" : c))) as unknown[][]);
  // Date cells: Excel date-times in plant time.
  aoa.forEach((row, ri) => row.forEach((c, ci) => { if (isCell(c)) ws[XLSX.utils.encode_cell({ r: ri, c: ci })] = c as never; }));
  ws["!cols"] = [12, 9, 34, 38, 18, 9, 16, 18, 18, 18, 9, 18, 7, 7, 9, 11, 5].map((wch) => ({ wch }));
  ws["!autofilter"] = { ref: `A${headRow}:Q${aoa.length}` };
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "As-built");
  if (a.cancelled.length) {
    const when = (t: number | null) => (t == null ? "" : `${fmtInTz(t, o.tz, { month: "numeric", day: "numeric", year: "numeric" })} ${fmtInTz(t, o.tz, { hour: "numeric", minute: "2-digit", hour12: true })}`);
    const cs = XLSX.utils.aoa_to_sheet([["Taken off the schedule", "Where", "Steps", "When", "Note"], ...a.cancelled.map((c) => [c.name, c.where, c.steps, when(c.at), c.note ?? ""])]);
    cs["!cols"] = [40, 50, 7, 20, 50].map((wch) => ({ wch }));
    XLSX.utils.book_append_sheet(wb, cs, "Taken off");
  }
  XLSX.writeFile(wb, o.fileName);
}
