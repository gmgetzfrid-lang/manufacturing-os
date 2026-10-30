// lib/managementUpdate.ts — the shift turnover as an update for management.
//
// The meeting report runs a turnover: numbered agenda, prompts, the order
// to work in, stretch goals, sign-off. Management reads none of that. They
// want, in a glance: are we on plan, what got done, what didn't and why,
// what needs them, what's next. So the update is short tables, one line per
// main task where a line per step would be noise, and nothing that's empty —
// no "did not finish" when everything finished, no "needs a decision" when
// nothing is blocked.

import { capacityOf, askedResult } from "@/lib/shiftHandover";
import { turnoverPlan, nextOf, askedLine, crewsOf, vsPlan, doneByTask, shareOf, pathNote, competition, type TableOrder } from "@/lib/turnoverPlan";
import { behindWhyBlocks, type BehindWhy } from "@/lib/behindWhy";
import { discoveryOf, discoverySummary, discoveryStepLine, impactLine, ADDED, kindOf as addedKind, addedTitle, type Discovery } from "@/lib/discovery";
import { type PullCrew, type Pace, type ShiftReport, type ShiftRow, type ShiftWindow, type WorkShift } from "@/lib/shiftReport";
import { rankHazards, type HazardJobInput, type HazardKind } from "@/lib/safetyMoment";
import { safetyBrief, talkSources, projectFacts, RISKS_RANKED, type ProjectBase } from "@/lib/safetyTalk";
import type { ExportBlock, ExportCell, ExportSection } from "@/lib/reportExport";

export interface UpdateFormat {
  /** "Thu, Oct 22" */
  D: (ms: number) => string;
  /** "Oct 22 17:00" */
  DTs: (ms: number) => string;
  /** "17:00" */
  T: (ms: number) => string;
  /** "17:30–5:30 (Fri, Oct 23)" */
  win: (w: ShiftWindow) => string;
  hrs: (h: number) => string;
}

export interface UpdateLookups {
  /** A main task's rolled-up % complete. */
  pctOf: (id: string) => number | undefined;
  /** A main task's planned finish (its last step's finish). */
  finishOf: (id: string) => number | undefined;
  /** A main task's planned % by now — to say "on plan" or "behind". */
  planOf?: (id: string) => number | undefined;
  /** A main task's steps — every step under it, sub-groups included — with
   *  where each stands and which crew works it, to name what's next. */
  stepsOf?: (id: string) => Array<{ id?: string; name: string; start: number; finish: number; dueAt?: number; percent: number; pace: Pace; expectedPct: number; status: string; work?: WorkShift }> | undefined;
  /** The latest comment on a step ("sent out for calibration"), and when. */
  noteOf?: (stepId: string) => string | { body: string; at?: string | number | null } | undefined;
  /** Marked at the meeting: the next shift could try this other-crew step. */
  tryOf?: (stepId: string) => { crew?: string | null; note?: string | null } | undefined;
  /** What the last turnover asked this shift to try, and where each got. */
  asked?: Array<{ id: string; name: string; crew: string | null; from: number; now: number | null; pulled?: boolean; why?: string }>;
  /** The crew kept for pulled-forward work, and its size. */
  pull?: PullCrew | null;
  /** The project around the work, for the safety topic's general lines. */
  safetyProject?: ProjectBase;
  /** The risk cards of the shifts before the next one (riskHistory). */
  safetyRecent?: HazardKind[][];
  /** Show the time each step was done in Done (off keeps the update short;
   *  the times are in the time log). */
  showTimes?: boolean;
  /** When a step was done, or moved last, on the shift. */
  timeOf?: (stepId: string) => number | undefined;
  /** Where a whole task stands: % done, % planned by now. */
  taskPct?: (taskId: string) => { pct: number; plan?: number } | undefined;
  /** Why a step is behind, as said for the report. */
  whyOf?: (stepId: string) => string | undefined;
  /** Each crew's supervisor at the meeting and head count — this shift's
   *  and the next's. */
  crewsThis?: Record<string, { supervisor?: string; headcount?: number | null }>;
  crewsNext?: Record<string, { supervisor?: string; headcount?: number | null }>;
  /** The shift's safety incidents: none (said so), or each one. Undefined =
   *  not recorded. */
  incidents?: { none: boolean; items: Array<{ at: number; kind: string; text: string }> };
  /** Notes & actions: the shift's own, and follow-ups left open by earlier
   *  shifts (with where they came from). */
  /** The tables' order as dragged at the meeting (lib/turnoverPlan). */
  order?: TableOrder;
  /** Where the work as it stands lands the finish (lib/cpm), when the
   *  schedule is linked. */
  forecast?: { finish: number; slipH: number };
  /** Discovery work on the schedule (lib/discovery). */
  discovery?: Discovery[];
  /** Why it's behind (lib/behindWhy). */
  why?: BehindWhy;
  shiftNotes?: Array<{ at: number; text: string; followUp?: boolean; from?: string }>;
  /** Shift notes, hour by hour — the approved lines, with the clock each
   *  shows ("8:00 AM", "8:30"). */
  /** The shift by the hour (lib/shiftHourly): its meeting, the first hour
   *  (permitting), then each hour so far. */
  hourly?: Array<{ clock: string; kind?: "meeting" | "permit" | "work"; text: string }>;
}

/** "forecast finish Nov 01 02:18 — 8.3 h late": where the work as it
 *  stands lands the finish (lib/cpm). The screen and the email say it alike. */
export function forecastText(fc: { finish: number; slipH: number }, f: { D: (ms: number) => string; T: (ms: number) => string; hrs: (h: number) => string }): string {
  const at = `${f.D(fc.finish)} ${f.T(fc.finish)}`;
  return Math.abs(fc.slipH) < 0.5 ? `forecast finish ${at}, on plan` : `forecast finish ${at} — ${f.hrs(Math.abs(fc.slipH))} ${fc.slipH > 0 ? "late" : "early"}`;
}

/** "Mike Leonard · 14 on site" — what was entered, "—" when nothing was. */
export function crewLine(c?: { supervisor?: string; headcount?: number | null }): string {
  return [c?.supervisor?.trim() || null, c?.headcount != null ? `${c.headcount} on site` : null].filter(Boolean).join(" · ") || "—";
}

/** The next shift's steps as the safety moment ranks them: their hours
 *  on that shift (what's left, for work already past due). */
export function hazardJobsOf(rows: ShiftRow[], next: ShiftWindow, when: (r: ShiftRow) => string, noteOf?: (id: string) => string | undefined): HazardJobInput[] {
  return rows.map((r) => {
    const span = r.finish - r.start;
    const overlap = Math.max(0, Math.min(r.finish, next.end) - Math.max(r.start, next.start));
    // Its hours on the shift: carried-over work takes the first hours; work
    // moved onto its crew's hours, those.
    const a = r.carryOver ? next.start : Math.max(r.reflowed ? r.crewStart : r.start, next.start);
    const b = r.carryOver ? Math.min(next.end, next.start + Math.max(1, r.hoursLeft) * 3600_000) : Math.min(r.reflowed ? r.crewFinish : r.finish, next.end);
    return {
      id: r.leaf.id ?? r.leaf.name, name: r.leaf.name, parentName: r.parentName, parentId: r.parentId, crumbs: r.path.slice(0, -1),
      who: r.leaf.responsibleParty ?? null, critical: r.critical,
      hours: overlap > 0 && span > 0 ? r.hours * (overlap / span) : r.hoursLeft,
      when: when(r),
      start: a, end: Math.max(a, b), percent: r.percent, late: r.carryOver,
      note: r.leaf.id ? noteOf?.(r.leaf.id) ?? null : null,
    };
  });
}

/** A comment as one quiet line: line breaks folded, long ones cut, and its
 *  date when it was written before this shift — an old "sent out for
 *  calibration" mustn't read as today's news. */
export function noteLine(n: string | { body: string; at?: string | number | null } | undefined, since: number, D: (ms: number) => string, max = 100): string | undefined {
  if (!n) return undefined;
  const body = (typeof n === "string" ? n : n.body).replace(/\s+/g, " ").trim();
  if (!body) return undefined;
  const at = typeof n === "string" || n.at == null ? NaN : typeof n.at === "number" ? n.at : Date.parse(n.at);
  const text = body.length > max ? `${body.slice(0, max - 3).trimEnd()}…` : body;
  return Number.isFinite(at) && at < since ? `${text} · ${D(at)}` : text;
}

/** Long lists stop at this many rows, with a line saying how many more. */
const MAX_ROWS = 12;

const shiftName = (w: ShiftWindow) => (w.kind === "day" ? "Day shift" : "Night shift");

/** Rows as a table where the task is named once, its steps under it.
 *  In the order dragged at the meeting (`runs`), the rows keep that order
 *  and a task is named again where it comes back. */
function byTask(rows: ShiftRow[], cells: (r: ShiftRow) => ExportCell[], taskSub?: (r: ShiftRow) => string | undefined, runs = false): ExportCell[][] {
  const order: string[] = [];
  const groups = new Map<string, ShiftRow[]>();
  for (const r of rows) {
    let k = r.parentId ?? `solo:${r.leaf.id ?? r.leaf.name}`;
    if (runs) {
      const last = order[order.length - 1];
      k = last && last.split("#")[0] === k ? last : `${k}#${order.length}`;
    }
    if (!groups.has(k)) { groups.set(k, []); order.push(k); }
    groups.get(k)!.push(r);
  }
  const out: ExportCell[][] = [];
  for (const k of order) {
    groups.get(k)!.forEach((r, i) => {
      const sub = i === 0 ? taskSub?.(r) : undefined;
      out.push([i === 0 ? { t: r.parentName ?? r.leaf.name, bold: true, ...(sub ? { sub: [{ t: sub }] } : {}) } : "", ...cells(r)]);
    });
  }
  return out;
}
const muted = (t: string): ExportCell => ({ t, tone: "muted" });

export function turnoverUpdate(report: ShiftReport, f: UpdateFormat, look: UpdateLookups): Array<ExportSection & { id: string }> {
  // Three tables, no more: where we stand (and WHY), what got done (and
  // what it meant), and what's next — every open step once, with what
  // happens to it. lib/turnoverPlan decides where each step goes, the
  // same as the screen report.
  const { overall, shift, next } = report;
  const out: Array<ExportSection & { id: string }> = [];
  const other = next.kind === "day" ? "night" : "day";
  const shiftHrs = (next.end - next.start) / 3_600_000;
  const t = { T: f.T, DTs: f.DTs, hrs: f.hrs };
  const note = (id?: string | null) => (id ? noteLine(look.noteOf?.(id), shift.start, f.D) : undefined);
  const who = (r: ShiftRow) => muted(r.leaf.responsibleParty?.trim() ?? "");
  const wo = (r: ShiftRow): ExportCell => r.leaf.workOrderRef?.trim() ?? "";
  const plan = turnoverPlan(report, (id) => !!look.tryOf?.(id), look.order);
  const { items, kindOf, tried, carries, held } = plan;
  const nextList = items.filter((x) => x.kind === "next").map((x) => x.r);
  const nextHrs = Math.round(nextList.reduce((a, r) => a + (r.hoursNext ?? 0), 0) * 10) / 10;
  const capa = capacityOf(look.pull ?? null, tried, shiftHrs);
  const asked = look.asked ?? [];

  // ── 1. Where we stand — the numbers, and the steps that make the gap.
  const finishPassed = overall.plannedFinish != null && report.now > overall.plannedFinish && overall.actualPct < 100;
  const gap = report.goals.gapHours;
  const standTone = overall.standing === "behind" ? "rose" as const : overall.standing === "ahead" ? "emerald" as const : "slate" as const;
  out.push({
    id: "stand", title: "Where we stand",
    sub: overall.plannedFinish ? `Day ${overall.daysElapsed} of ${overall.daysTotal} · planned finish ${f.D(overall.plannedFinish)}${finishPassed ? " — passed" : ""}${look.forecast ? ` · ${forecastText(look.forecast, f)}` : ""}` : undefined,
    flag: overall.standing === "behind" ? "rose" : null,
    blocks: [
      {
        k: "overview",
        stats: [
          { label: "Complete", value: `${overall.actualPct}%`, tone: standTone },
          { label: "Plan by now", value: `${overall.plannedPct}%`, tone: "slate" },
          // Follows the same verdict as the header: never "Work ahead" beside ON TRACK.
          overall.standing === "ahead" ? { label: "Work ahead", value: f.hrs(Math.abs(gap)), tone: standTone }
            : overall.standing === "behind" ? { label: "Work behind", value: f.hrs(Math.abs(gap)), tone: standTone }
              : { label: "Gap", value: Math.abs(gap) <= 0.5 ? "even" : `${f.hrs(Math.abs(gap))} ${gap < 0 ? "ahead" : "behind"}`, tone: standTone },
          { label: "Steps done", value: `${overall.stepsDone} / ${overall.stepsTotal}`, tone: "slate" },
        ],
        bars: overall.plannedStart != null && overall.plannedFinish != null
          ? { done: overall.actualPct, plan: overall.plannedPct, from: f.D(overall.plannedStart), to: f.D(overall.plannedFinish) } : undefined,
        // No bottom-line box: the numbers and bars get the whole width.
        title: "", lines: [],
      },
      // Why: the hours behind by cause, and what holds each chain up.
      ...(look.why && look.why.total >= 0.5 ? behindWhyBlocks(look.why, f) : []),
    ],
  });

  // ── 2. Done this shift — and what each one meant for the plan.
  const doneRows = [...plan.done, ...plan.moved];
  const byTaskDone = doneByTask(report, plan, t, (id) => note(id), { timeOf: look.timeOf, taskPct: look.taskPct, whyOf: look.whyOf });
  const pctText = (p?: { pct: number; plan?: number }) => (p ? `task ${p.pct}% done${p.plan != null ? ` · plan ${p.plan}%` : ""}` : undefined);
  const taskSub = (r: ShiftRow) => (r.parentId ? pctText(look.taskPct?.(r.parentId)) : undefined);
  if (doneRows.length || asked.length) {
    out.push({
      id: "done", title: `Done — ${shiftName(shift)} ${f.D(shift.start)}`,
      sub: [`${plan.done.length} finished`, plan.moved.length ? `${plan.moved.length} moved forward` : null].filter(Boolean).join(" · "),
      blocks: [
        ...(byTaskDone.length ? [{
          k: "table", head: ["Task", "WO", "Done this shift", "Who", "What it means", "vs plan"], align: ["left", "left", "left", "left", "left", "right"],
          textLabels: ["", "WO", "", "by", "", "vs plan"], nowrap: [1, 5],
          rows: byTaskDone.map((x) => [
            { t: x.task, bold: true, ...(x.taskPct || x.critical ? { sub: [...(x.critical ? [{ t: "Critical path", tone: "rose" as const }] : []), ...(x.taskPct ? [{ t: pctText(x.taskPct)! }] : [])] } : {}) }, x.wo,
            // One step per line — its time when times are on, its WO when the task has several.
            { t: `${x.head}:`, lines: x.lines.map((l) => ({ lead: [l.wo ? `WO ${l.wo}` : "", look.showTimes && l.time != null ? f.T(l.time) : ""].filter(Boolean).join(" ") || undefined, t: `${l.name}${l.critical ? " · critical path" : ""}${l.discovery ? ` · ${l.discovery}` : ""}`, note: l.note })) },
            muted(x.who),
            { t: x.result.text, tone: x.result.tone === "amber" ? "amber" : "emerald", bold: true, ...(x.why ? { sub: [{ t: `Why behind: ${x.why}`, tone: "amber" as const, italic: true }] } : {}) },
            { t: x.vs.text, tone: x.vs.tone, bold: true }] as ExportCell[]),
        } as ExportBlock] : []),
        ...(asked.length ? [{ k: "note", text: `Asked to try last turnover: ${askedLine(asked, askedResult)}` } as ExportBlock] : []),
      ],
    });
  }

  // ── 3. Next — every open step once, and what happens to it.
  const onNext = new Set(nextList.map((r) => r.leaf.id));
  const canFinish = (pid: string) => (look.stepsOf?.(pid) ?? []).every((x) => x.pace === "done" || (onNext.has(x.id) && x.pace !== "overdue" && x.pace !== "held"));
  const finishing = [...new Map(nextList.filter((r) => r.parentId && !r.carryOver).map((r) => [r.parentId!, r])).values()]
    .filter((r) => canFinish(r.parentId!))
    .map((r) => ({ name: r.parentName ?? r.leaf.name, at: look.finishOf(r.parentId!) }))
    .filter((x): x is { name: string; at: number } => x.at != null && x.at > next.start && x.at <= next.end)
    .sort((a, b) => a.at - b.at);
  const planCell = (r: ShiftRow): ExportCell => {
    const kind = kindOf.get(r)!;
    const d = kind === "try" ? look.tryOf!(r.leaf.id!)! : null;
    const pulled = plan.pulled.includes(r);
    const x = nextOf(report, r, kind, f, { pulled, crew: d ? d.crew ?? (pulled ? look.pull?.crew ?? null : null) : null });
    // The table is the next shift's: its hours, or "Continues" / "Carried over".
    const label = x.label;
    const text = x.detail ? `${label} — ${x.detail}` : label;
    return x.tone && x.tone !== "muted" ? { t: text, tone: x.tone, bold: kind === "held" } : text;
  };
  // Where it is now, and where it should be by the end of the shift — two
  // columns, no arrows.
  const goalCell = (r: ShiftRow): ExportCell => {
    const goal = kindOf.get(r) === "next" ? r.goalPct ?? r.percent : r.percent;
    return goal > r.percent ? `${goal}%` : { t: "—", tone: "muted" };
  };
  // The next crew's table holds only its own work (and what it could try);
  // the other crew's carried work and anything blocked get their own.
  const tonight = items.filter((x) => x.kind === "next" || x.kind === "try").map((x) => x.r);
  const later = items.filter((x) => x.kind === "carry" || x.kind === "held").map((x) => x.r);
  const vsCell = (r: ShiftRow): ExportCell => { const v = vsPlan(report, r, f.hrs); return { t: v.text, tone: v.tone, bold: true }; };
  // A step's comment shows once: with its credit under Done, if it moved.
  const credited = new Set([...plan.done, ...plan.moved].map((r) => r.leaf.id));
  const whyLine = (r: ShiftRow) => { const w = r.leaf.id && shareOf(report, r.leaf.id)?.side === "behind" ? look.whyOf?.(r.leaf.id)?.trim() : undefined; return w ? [{ t: `Why behind: ${w}`, tone: "amber" as const, italic: true }] : undefined; };
  // Against the critical path: on it, near it, or after the same crew as it.
  const comp = competition(report, [...items.map((x) => x.r)]);
  const pathLines = (r: ShiftRow) => {
    const c = r.leaf.id ? comp.get(r.leaf.id) : undefined;
    const pn = pathNote(r, f.hrs);
    return [
      ...(r.critical ? [{ t: "Critical path", tone: "rose" as const }] : []),
      ...(pn ? [{ t: pn[0].toUpperCase() + pn.slice(1), tone: "amber" as const }] : []),
      ...(c ? [{ t: `Same crew as critical work (${c.crew}): ${c.critical.slice(0, 2).map((x) => x.leaf.name).join(", ")} goes first`, tone: "amber" as const }] : []),
      ...(discoveryOf(r.leaf) ? [{ t: `${ADDED[addedKind(discoveryOf(r.leaf))].word} — ${discoveryOf(r.leaf)!.what}`, tone: "slate" as const }] : []),
    ];
  };
  // What it waits on, as the screen says it: after steps on this list, or
  // on something off it.
  const onList = new Set(items.map((x) => x.r.leaf.id));
  const waitLine = (r: ShiftRow) => {
    const w = r.waitingOn;
    if (!w?.length) return [];
    return [{ t: w.every((x) => onList.has(x.id)) ? `Starts after ${w.map((x) => x.name).join(", ")}` : `Waits on ${w[0].name}${w.length > 1 ? ` +${w.length - 1}` : ""}`, tone: "slate" as const }];
  };
  const stepCell = (r: ShiftRow): ExportCell => {
    const sub = [...pathLines(r), ...(whyLine(r) ?? []), ...waitLine(r)];
    return { t: r.leaf.name, note: [credited.has(r.leaf.id) ? undefined : note(r.leaf.id), kindOf.get(r) === "try" ? look.tryOf!(r.leaf.id!)?.note ?? undefined : undefined].filter(Boolean).join(" · ") || undefined, ...(sub.length ? { sub } : {}) };
  };
  const more = (n: number, cols: number) => (n > 0 ? [[muted(`+ ${n} more`), ...Array(cols - 1).fill("")] as ExportCell[]] : []);
  if (tonight.length || later.length) {
    const shown = tonight.slice(0, MAX_ROWS * 3);
    const ps = look.pull;
    out.push({
      id: "next", title: `Next — ${shiftName(next)} ${f.D(next.start)} ${f.win(next)}`,
      sub: [
        `${nextList.length} step${nextList.length === 1 ? "" : "s"} for the ${next.kind} crew (${f.hrs(nextHrs)})`,
        tried.length ? `${tried.length} could try` : null,
      ].filter(Boolean).join(" · "),
      blocks: [
        tonight.length ? {
          k: "table", head: ["Task", "Step", "WO", "Who", "When", "Done", "Goal", "vs plan"], align: ["left", "left", "left", "left", "left", "right", "right", "right"],
          textLabels: ["", "", "WO", "by", "", "done", "goal", "vs plan"], nowrap: [2, 5, 6, 7],
          rows: [...byTask(shown, (r) => [stepCell(r), wo(r), who(r), planCell(r), `${r.percent}%`, goalCell(r), vsCell(r)], taskSub, !!look.order?.next?.length), ...more(tonight.length - shown.length, 8)],
        } as ExportBlock : { k: "note", text: `Nothing planned for the ${shiftName(next).toLowerCase()}.` } as ExportBlock,
        ...(tried.length ? [{ k: "note", text: `Could try if there's time: ${tried.length} step${tried.length === 1 ? "" : "s"}, ${f.hrs(capa.used)}${capa.hours > 0 && ps ? ` of ${f.hrs(capa.hours)}${capa.over ? " — over" : ""} (${ps.crew ? `${ps.crew}, ` : ""}${ps.hands} × ${Math.min(ps.hours, shiftHrs)} h)` : ""}.`, tone: "amber" } as ExportBlock] : []),
        ...(finishing.length ? [{ k: "note", text: `Planned to finish on the ${shiftName(next).toLowerCase()}: ${finishing.slice(0, 4).map((x) => `${x.name} (${f.T(x.at)})`).join(", ")}${finishing.length > 4 ? ` + ${finishing.length - 4} more` : ""}.` } as ExportBlock] : []),
      ],
    });
  }
  if (later.length > 0) {
    const shown = later.slice(0, MAX_ROWS * 3);
    const why = (r: ShiftRow): ExportCell => {
      const x = nextOf(report, r, kindOf.get(r)!, f);
      const text = kindOf.get(r) === "held" ? `${x.label} — ${x.detail}` : x.detail ?? "";
      return x.tone && x.tone !== "muted" ? { t: text, tone: x.tone, bold: kindOf.get(r) === "held" } : text;
    };
    const doneCell = (r: ShiftRow): ExportCell => `${r.percent}%`;
    out.push({
      // The other crew's next shift starts when the next shift ends.
      id: "carries", title: `Carries over to ${other} shift — ${f.D(next.end)}`,
      sub: [carries.length ? `${carries.length} for the ${other} crew` : null, held.length ? `${held.length} blocked or on hold` : null].filter(Boolean).join(" · ") + ` — not the ${next.kind} shift's work`,
      flag: held.some((r) => r.status === "blocked") ? "rose" : null,
      blocks: [{
        k: "table", head: ["Task", "Step", "WO", "Who", "Why it carries", "Done", "vs plan"], align: ["left", "left", "left", "left", "left", "right", "right"],
        textLabels: ["", "", "WO", "by", "", "done", "vs plan"], nowrap: [2, 5, 6],
        rows: [...byTask(shown, (r) => [stepCell(r), wo(r), who(r), why(r), doneCell(r), vsCell(r)], taskSub, !!look.order?.later?.length), ...more(later.length - shown.length, 7)],
      }],
    });
  }

  // ── Crews: who attended the meeting that started the shift — the first
  // line of its notes, hour by hour (below).
  const cr = crewsOf(report, plan, f.hrs);
  // Each crew: its supervisor at the meeting and head count on site (the
  // attendance) — and any company added at the meeting that has no steps.
  const crewRows = (list: Array<{ crew: string; note?: string }>, counts?: Record<string, { supervisor?: string; headcount?: number | null }>) => {
    const named = new Set(list.map((x) => x.crew));
    const extra = Object.keys(counts ?? {}).filter((k) => !named.has(k) && (counts![k].supervisor?.trim() || counts![k].headcount != null));
    const rows = [...list.map((x) => ({ title: x.crew, value: crewLine(counts?.[x.crew]), note: x.note })), ...extra.map((k) => ({ title: k, value: crewLine(counts![k]) }))];
    return rows.length ? rows : [{ title: "No work planned", value: "" }];
  };
  // ── Safety topics: the job as a whole, then the next shift's two riskiest
  // kinds of work — the things to say out loud. Left out unless ticked.
  const hj = hazardJobsOf(nextList, next, (r) => (r.carryOver ? `due ${f.DTs(r.dueAt)}` : `${f.T(Math.max(r.start, next.start))}–${r.finish <= next.end ? f.T(r.finish) : "…"}`), (id) => note(id));
  const topics = hj.length ? safetyBrief(rankHazards(hj, { shift: next, T: f.T, max: RISKS_RANKED }), next, { project: projectFacts(look.safetyProject, next, hj.map((j) => j.name)), recentRisks: look.safetyRecent }) : [];
  if (topics.length) {
    out.push({
      id: "safety", title: `Safety topics — ${shiftName(next).toLowerCase()}`, offByDefault: true,
      blocks: topics.map((t, i) => ({ k: "bullets", title: `${i + 1}. ${t.title}`, lead: `${t.kicker} — ${t.why}`, tone: i === 0 ? "slate" : i === 1 ? "rose" : "amber", items: t.points.map((p) => p.say), sources: talkSources(t) } as ExportBlock)),
    });
  }

  // ── Safety incidents on the shift — its own box, sent with or without
  // the safety topics.
  const inc = look.incidents;
  out.push({
    id: "incidents", title: `Safety incidents — ${shiftName(shift)} ${f.D(shift.start)}`,
    blocks: !inc ? [{ k: "note", text: "Not recorded.", tone: "muted" }]
      : inc.items.length ? [{ k: "table", head: ["Time", "Kind", "What happened"], align: ["left", "left", "left"], nowrap: [0],
        rows: [...inc.items].sort((a, b) => a.at - b.at).map((x) => [f.T(x.at), { t: x.kind, bold: true }, x.text] as ExportCell[]) }]
      : [{ k: "note", text: "None.", tone: "emerald" }],
  });

  // ── Shift notes, hour by hour: the meeting (who attended), the first
  // hour (permitting), then each hour.
  const hl = look.hourly ?? [];
  if (hl.length) {
    const attended = crewRows(cr.worked, look.crewsThis).filter((x) => x.title !== "No work planned").map((x) => `${x.title}: ${x.value}`).join("; ");
    out.push({
      id: "hourly", title: `Shift notes — ${shiftName(shift)} ${f.D(shift.start)}`, sub: "hour by hour",
      blocks: [{ k: "table", head: ["Time", "What happened"], align: ["left", "left"], textLabels: ["", ""], nowrap: [0], rows: hl.map((x) => [{ t: x.clock, bold: true },
        x.kind === "meeting" ? `Shift meeting — ${[attended, x.text].filter(Boolean).join(". ") || "—"}`
          : x.kind === "permit" ? `Start of shift — permitting${x.text ? `. ${x.text}` : ""}`
            : x.text || { t: "—", tone: "muted" as const }] as ExportCell[]) }],
    });
  }

  // ── Notes & actions: the shift's own, then follow-ups left open earlier.
  const sn = look.shiftNotes ?? [];
  if (sn.length) {
    out.push({
      id: "notes", title: "Notes & actions", sub: "follow-ups and anything else that happened",
      blocks: [{ k: "table", head: ["Time", "Note"], align: ["left", "left"], nowrap: [0],
        rows: [...sn].sort((a, b) => a.at - b.at).map((x) => [x.from ? `${f.D(x.at)} ${f.T(x.at)}` : f.T(x.at), { t: x.text, ...(x.followUp ? { sub: [{ t: x.from ? `Follow-up, open since ${x.from}` : "Follow-up — stays until cleared", tone: "amber" as const }] } : {}) }] as ExportCell[]) }],
    });
  }
  // ── Discovery work: found on the shift — what it added and did to the
  // schedule — and what's still open from earlier.
  const ds = discoverySummary(look.discovery ?? [], shift.start, shift.end);
  if (ds.inShift.length || ds.open.length) {
    out.push({
      id: "discovery", title: `${addedTitle([...ds.inShift, ...ds.open].map((d) => addedKind(d.record)))} — ${shiftName(shift)} ${f.D(shift.start)}`, sub: discoverySub(ds, f.hrs),
      blocks: [
        ...(ds.inShift.length ? [discoveryBlock(ds.inShift, f)] : [{ k: "note", text: "Nothing found this shift.", tone: "muted" } as ExportBlock]),
        ...(ds.open.length ? [{ k: "note", text: `Still open from earlier: ${ds.open.map((d) => `${d.task?.name ?? ""} — ${d.record.what} (${d.steps.filter((x) => x.status !== "completed").length} of ${d.steps.length} steps open)`).join("; ")}.`, tone: "amber" } as ExportBlock] : []),
      ],
    });
  }
  return out;
}

/** "2 found · 14 h added · turnaround +8 h · so far 5, 40 h" */
export function discoverySub(ds: ReturnType<typeof discoverySummary>, hrs: (h: number) => string): string {
  return [
    `${ds.shift.count} added this shift`,
    ds.shift.hours ? `${hrs(ds.shift.hours)} added` : null,
    ds.shift.finishH ? `turnaround +${hrs(ds.shift.finishH)}` : null,
    ds.shift.critical ? `${ds.shift.critical} on the critical path` : null,
    `so far ${ds.job.count} (${hrs(ds.job.hours)}${ds.job.finishH ? `, finish +${hrs(ds.job.finishH)}` : ""})`,
  ].filter(Boolean).join(" · ");
}

/** Discovery as a table — the turnover email and the close-out alike. */
export function discoveryBlock(list: Discovery[], f: { DTs: (ms: number) => string; hrs: (h: number) => string }): ExportBlock {
  return {
    k: "table", head: ["When", "Task", "What", "Work it added", "What it did"], align: ["left", "left", "left", "left", "left"], nowrap: [0],
    rows: list.map((d) => [
      f.DTs(d.record.foundAt),
      { t: d.task?.name ?? "", bold: true, ...(d.task?.workOrderRef ? { sub: [{ t: `WO ${d.task.workOrderRef}` }] } : {}) },
      { t: d.record.what, sub: [{ t: ADDED[addedKind(d.record)].word, tone: "slate" as const }, ...(d.record.approvedBy ? [{ t: `Approved by ${d.record.approvedBy}`, tone: "muted" as const }] : [])] },
      { t: `${d.steps.length} step${d.steps.length === 1 ? "" : "s"}:`, lines: d.steps.map((m) => ({ t: discoveryStepLine(m, f.hrs) })) },
      { t: impactLine(d.record.impact, f.hrs), tone: d.record.impact.critical ? "rose" : "slate", bold: d.record.impact.critical },
    ] as ExportCell[]),
  } as ExportBlock;
}

/** Any section a management update has no use for when it's empty: the
 *  "nothing here" lines. Sections left with no content are dropped. */
export function withoutEmpty<T extends ExportSection>(sections: T[]): T[] {
  return sections
    .map((s) => ({ ...s, blocks: s.blocks.filter((b) => b.k !== "empty") }))
    .filter((s) => s.blocks.some((b) => b.k !== "sub" && b.k !== "label"));
}
