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
import { turnoverPlan, nextOf, askedLine, crewsOf, vsPlan, doneByTask } from "@/lib/turnoverPlan";
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

/** Rows as a table where the task is named once, its steps under it. */
function byTask(rows: ShiftRow[], cells: (r: ShiftRow) => ExportCell[]): ExportCell[][] {
  const order: string[] = [];
  const groups = new Map<string, ShiftRow[]>();
  for (const r of rows) {
    const k = r.parentId ?? `solo:${r.leaf.id ?? r.leaf.name}`;
    if (!groups.has(k)) { groups.set(k, []); order.push(k); }
    groups.get(k)!.push(r);
  }
  const out: ExportCell[][] = [];
  for (const k of order) {
    groups.get(k)!.forEach((r, i) => out.push([i === 0 ? { t: r.parentName ?? r.leaf.name, bold: true } : "", ...cells(r)]));
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
  const plan = turnoverPlan(report, (id) => !!look.tryOf?.(id));
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
    sub: overall.plannedFinish ? `Day ${overall.daysElapsed} of ${overall.daysTotal} · planned finish ${f.D(overall.plannedFinish)}${finishPassed ? " — passed" : ""}` : undefined,
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
    ],
  });

  // ── 2. Done this shift — and what each one meant for the plan.
  const doneRows = [...plan.done, ...plan.moved];
  const byTaskDone = doneByTask(report, plan, t, (id) => note(id));
  if (doneRows.length || asked.length) {
    out.push({
      id: "done", title: `Done — ${shiftName(shift)} ${f.D(shift.start)}`,
      sub: [`${plan.done.length} finished`, plan.moved.length ? `${plan.moved.length} moved forward` : null].filter(Boolean).join(" · "),
      blocks: [
        ...(byTaskDone.length ? [{
          k: "table", head: ["Task", "WO", "Done this shift", "Who", "What it means", "vs plan"], align: ["left", "left", "left", "left", "left", "right"],
          textLabels: ["", "WO", "", "by", "", "vs plan"], nowrap: [1, 5],
          rows: byTaskDone.map((x) => [{ t: x.task, bold: true }, x.wo, x.steps, muted(x.who), { t: x.result.text, tone: x.result.tone === "amber" ? "amber" : "emerald", bold: true }, { t: x.vs.text, tone: x.vs.tone, bold: true }] as ExportCell[]),
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
  const stepCell = (r: ShiftRow): ExportCell => ({ t: r.leaf.name, note: [credited.has(r.leaf.id) ? undefined : note(r.leaf.id), kindOf.get(r) === "try" ? look.tryOf!(r.leaf.id!)?.note ?? undefined : undefined].filter(Boolean).join(" · ") || undefined });
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
          rows: [...byTask(shown, (r) => [stepCell(r), wo(r), who(r), planCell(r), `${r.percent}%`, goalCell(r), vsCell(r)]), ...more(tonight.length - shown.length, 8)],
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
        rows: [...byTask(shown, (r) => [stepCell(r), wo(r), who(r), why(r), doneCell(r), vsCell(r)]), ...more(later.length - shown.length, 7)],
      }],
    });
  }

  // ── Crews — right after where we stand: who was here, who's coming.
  const cr = crewsOf(report, plan, f.hrs);
  if (cr.worked.length || cr.coming.length) {
    out.splice(out.findIndex((x) => x.id === "stand") + 1, 0, {
      id: "who", title: "Crews",
      blocks: [{ k: "columns", cols: [
        { title: `${shiftName(shift)} ${f.D(shift.start)} — who was here`, rows: cr.worked.length ? cr.worked.map((x) => ({ title: x.crew, value: x.text, note: x.note })) : [{ title: "No work planned", value: "" }] },
        { title: `${shiftName(next)} ${f.D(next.start)} — who's coming`, rows: cr.coming.length ? cr.coming.map((x) => ({ title: x.crew, value: x.text, note: x.note })) : [{ title: "No work planned", value: "" }] },
      ] }],
    });
  }

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
  return out;
}

/** Any section a management update has no use for when it's empty: the
 *  "nothing here" lines. Sections left with no content are dropped. */
export function withoutEmpty<T extends ExportSection>(sections: T[]): T[] {
  return sections
    .map((s) => ({ ...s, blocks: s.blocks.filter((b) => b.k !== "empty") }))
    .filter((s) => s.blocks.some((b) => b.k !== "sub" && b.k !== "label"));
}
