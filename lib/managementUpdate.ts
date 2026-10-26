// lib/managementUpdate.ts — the shift turnover as an update for management.
//
// The meeting report runs a turnover: numbered agenda, prompts, the order
// to work in, stretch goals, sign-off. Management reads none of that. They
// want, in a glance: are we on plan, what got done, what didn't and why,
// what needs them, what's next. So the update is short tables, one line per
// main task where a line per step would be noise, and nothing that's empty —
// no "did not finish" when everything finished, no "needs a decision" when
// nothing is blocked.

import { BEHIND_POINTS, whoOf, type Pace, type ShiftReport, type ShiftRow, type ShiftWindow, type WorkShift } from "@/lib/shiftReport";
import { rankHazards, hazardContext, lessonFor, equipmentTag, type HazardJobInput } from "@/lib/safetyMoment";
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
  asked?: Array<{ id: string; name: string; crew: string | null; from: number; now: number | null }>;
}

/** The next shift's steps as the safety moment ranks them: their hours
 *  on that shift (what's left, for work already past due). */
export function hazardJobsOf(rows: ShiftRow[], next: ShiftWindow, when: (r: ShiftRow) => string): HazardJobInput[] {
  return rows.map((r) => {
    const span = r.finish - r.start;
    const overlap = Math.max(0, Math.min(r.finish, next.end) - Math.max(r.start, next.start));
    return {
      id: r.leaf.id ?? r.leaf.name, name: r.leaf.name, parentName: r.parentName, crumbs: r.path.slice(0, -1),
      who: r.leaf.responsibleParty ?? null, critical: r.critical,
      hours: overlap > 0 && span > 0 ? r.hours * (overlap / span) : r.hoursLeft,
      when: when(r),
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
const muted = (t: string): ExportCell => ({ t, tone: "muted" });

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

export function turnoverUpdate(report: ShiftReport, f: UpdateFormat, look: UpdateLookups): Array<ExportSection & { id: string }> {
  const { overall, review, goals, blocked, shift, next } = report;
  const out: Array<ExportSection & { id: string }> = [];

  // ── Where we stand ──
  const gap = goals.gapHours;
  // The tile follows the headline verdict: "Work behind" only when the job
  // is behind, never a red number under ON TRACK. In work-hours, said so.
  const gapTile = overall.standing === "behind" ? { label: "Work behind", tone: "rose" as const }
    : overall.standing === "ahead" ? { label: "Work ahead", tone: "emerald" as const }
      : { label: "Work gap", tone: "slate" as const };
  const standStats = [
    { label: "Complete", value: `${overall.actualPct}%`, tone: overall.standing === "behind" ? "rose" : overall.standing === "ahead" ? "emerald" : "slate" },
    { label: "Plan", value: `${overall.plannedPct}%`, tone: "slate" },
    { label: gapTile.label, value: overall.standing !== "on track" ? f.hrs(Math.abs(gap)) : Math.abs(gap) <= 0.5 ? "even" : `${f.hrs(Math.abs(gap))} ${gap > 0 ? "behind" : "ahead"}`, tone: gapTile.tone },
    { label: "Steps done", value: `${overall.stepsDone} / ${overall.stepsTotal}`, tone: "slate" },
  ] as const;
  // Filled in once the problems are known (the bottom line names them).
  const stand: ExportSection & { id: string } = {
    id: "stand", title: "Where we stand",
    sub: overall.plannedFinish ? `Day ${overall.daysElapsed} of ${overall.daysTotal} · planned finish ${f.D(overall.plannedFinish)}` : undefined,
    blocks: [],
  };
  out.push(stand);

  // ── Last shift ── one row per task the crew had: how far it is, what's
  // next on it, and the one thing to know — on plan, behind, overdue, held
  // or complete. Each task once; the steps behind it aren't repeated. Only
  // this crew's steps (ones it had by the end of its shift) can make its
  // row read behind: night work not yet started isn't the day crew's slip.
  const own = (r: ShiftRow) => r.work === "both" || r.work === shift.kind;
  const ownStep = (x: { work?: WorkShift; start: number }) => (x.work == null || x.work === "both" || x.work === shift.kind) && !(x.start >= shift.end);
  const keyOf = (r: ShiftRow) => r.parentId ?? `solo:${r.leaf.id ?? r.leaf.name}`;
  const touched = new Map<string, ShiftRow>();
  for (const r of [...review.scheduled.filter(own), ...review.done, ...review.carryOver.filter(own), ...review.inProgress.filter(own)]) {
    if (!touched.has(keyOf(r))) touched.set(keyOf(r), r);
  }
  // A comment shows once: under the next shift's step when it's there.
  const nextIds = new Set(goals.all.map((r) => r.leaf.id).filter(Boolean));
  const note = (id?: string | null) => (id ? noteLine(look.noteOf?.(id), shift.start, f.D) : undefined);
  type Row = { cells: ExportCell[]; rank: number; behind: boolean; complete: boolean };
  const rows: Row[] = [];
  for (const r of touched.values()) {
    const id = r.parentId;
    const self = { id: r.leaf.id ?? undefined, name: r.leaf.name, start: r.start, finish: r.finish, dueAt: r.dueAt, percent: r.percent, pace: r.pace, expectedPct: r.expectedPct, status: r.status, work: r.work };
    const steps = (id ? look.stepsOf?.(id) : undefined) ?? [self];
    const pct = id ? look.pctOf(id) ?? 0 : r.percent;
    const name: ExportCell = { t: r.parentName ?? r.leaf.name, bold: true };
    // Complete means the whole task — every step under it — not just this crew's part.
    if (pct >= 100) {
      rows.push({ cells: [name, { t: "100%", bold: true, tone: "emerald" }, "", { t: "Complete", tone: "emerald" }], rank: 4, behind: false, complete: true });
      continue;
    }
    const open = steps.filter((x) => x.pace !== "done").sort((a, b) => a.start - b.start);
    const next = open[0];
    const order = { overdue: 0, held: 1, behind: 2 } as Record<string, number>;
    const issues = open.filter((x) => x.pace in order && ownStep(x)).sort((a, b) => order[a.pace] - order[b.pace]);
    const worst = issues[0];
    // Another crew's step past due or held: not this crew's slip, but the
    // task isn't "on plan" either — say whose it is.
    const otherIssue = worst ? undefined : open.find((x) => x.pace === "overdue" || x.pace === "held");
    // Name the step the status is about — "next step" when it's the one in
    // the Next step column — so a step's 0% isn't read as the task's.
    const who = (x: typeof next) => (x === next ? "next step " : `${x.name} `);
    const more = issues.length > 1 ? ` (+${issues.length - 1} more)` : "";
    const plan = id ? look.planOf?.(id) : undefined;
    const fin = id ? look.finishOf(id) : r.finish;
    // The planned finish — not a forecast — and only while it's ahead.
    const finText = fin != null && Number.isFinite(fin) && fin > report.now ? ` · planned finish ${f.DTs(fin)}` : "";
    const status: ExportCell = worst
      ? worst.pace === "overdue" ? { t: `Overdue — ${who(worst)}${Number.isFinite(worst.dueAt ?? worst.finish) ? `was due ${f.DTs(worst.dueAt ?? worst.finish)}` : "past due"}${more}`, tone: "rose" }
        : worst.pace === "held" ? { t: `${worst.status === "blocked" ? "Blocked" : "On hold"} — ${worst === next ? "next step" : worst.name}${more} (reason below)`, tone: worst.status === "blocked" ? "rose" : "amber" }
          : { t: `Behind — ${who(worst)}${worst.percent}% of ${worst.expectedPct}% planned${more}`, tone: "amber" }
      : otherIssue ? { t: `${otherIssue.pace === "held" ? (otherIssue.status === "blocked" ? "Blocked" : "On hold") : "Past due"} — ${otherIssue.name} (${otherIssue.work === "night" ? "night" : otherIssue.work === "day" ? "day" : "other"} crew's step)`, tone: "amber" }
        : plan != null && pct + BEHIND_POINTS <= plan ? { t: `Behind — ${pct}% of ${plan}% planned`, tone: "amber" }
          : { t: `On plan${finText}`, tone: "emerald" };
    const behind = typeof status !== "string" && (status.tone === "rose" || status.tone === "amber");
    // The step's latest comment rides under it — why it reads 50%, what's
    // really happening — and under the status when that names another step.
    const noteFor = (x?: { id?: string }) => (x?.id && !nextIds.has(x.id) ? note(x.id) : undefined);
    if (worst && worst !== next && typeof status !== "string") status.note = noteFor(worst);
    rows.push({
      // Done against where the plan has the task right now.
      cells: [name, { t: plan != null ? `${pct}% / ${plan}%` : `${pct}%`, bold: true },
        next ? { t: `${next.name}${next.percent > 0 ? ` (${next.percent}%)` : ""}`, note: noteFor(next) } : "", status],
      rank: worst ? order[worst.pace] : behind ? 2 : 3, behind: worst ? worst.pace !== "held" : behind, complete: false,
    });
  }
  // ── Completed ── good news first: the steps finished on the shift.
  if (review.done.length > 0) {
    const list = review.done.slice(0, MAX_ROWS * 2);
    const hiddenDone = review.done.length - list.length;
    // Just "done": when it was marked done isn't when it finished
    // (progress is often caught up later), so no time is claimed.
    out.push({
      id: "done", title: `Completed — ${shiftName(shift)} ${f.D(shift.start)}`,
      sub: `${review.done.length} step${review.done.length === 1 ? "" : "s"} done`,
      blocks: [{
        k: "table", head: ["Task", "Step", "Who", "Done"], align: ["left", "left", "left", "right"], textLabels: ["", "", "by", ""],
        rows: [...byTask(list, (r) => [r.leaf.name, muted(r.leaf.responsibleParty ?? ""), { t: "✓", tone: "emerald", bold: true }]),
          ...(hiddenDone > 0 ? [[muted(`+ ${hiddenDone} more`), "", "", ""] as ExportCell[]] : [])],
      }],
    });
  }

  // ── Asked to try ── what the last turnover asked of this shift.
  const asked = look.asked ?? [];
  const askedDone = asked.filter((a) => (a.now ?? 0) >= 100).length;
  if (asked.length > 0) {
    out.push({
      id: "asked", title: `Asked to try — ${shiftName(shift)}`, sub: `${askedDone} of ${asked.length} done · as entered`,
      blocks: [{ k: "table", head: ["Step", "Crew", "At ship", "Now"], align: ["left", "left", "right", "right"],
        rows: asked.map((a) => [a.name, a.crew ?? muted("—"), `${a.from}%`, a.now == null ? "—" : a.now >= 100 ? { t: "done ✓", tone: "emerald", bold: true } : a.now > a.from ? `${a.now}%` : muted("not started")]) }],
    });
  }

  // ── Problems & decisions ── every task that's overdue, behind or held,
  // once, with the blocked / on-hold steps and their reasons.
  const problems = rows.filter((x) => x.rank <= 2).sort((a, b) => a.rank - b.rank);
  if (problems.length > 0 || blocked.length > 0) {
    const nBehind = problems.filter((x) => x.behind && x.rank !== 1).length;
    out.push({
      id: "problems", title: "Problems & decisions",
      sub: [nBehind ? `${nBehind} task${nBehind === 1 ? "" : "s"} behind or past due` : null, blocked.length ? `${blocked.length} blocked or on hold` : null].filter(Boolean).join(" · "),
      flag: problems.some((x) => x.rank === 0) || blocked.some((r) => r.status === "blocked") ? "rose" : "amber",
      blocks: [
        ...(problems.length ? [{
          k: "table", head: ["Task", "Done / planned now", "Next step", "Status"], align: ["left", "right", "left", "left"],
          textLabels: ["", "done/planned", "next", ""],
          rows: problems.map((x) => x.cells),
        } as ExportBlock] : []),
        ...(blocked.length ? [{
          k: "table", head: ["Task", "Step", "Status", "Reason"], textLabels: ["", "", "", ""],
          rows: byTask(blocked, (r) => [
            r.leaf.name,
            r.status === "blocked" ? { t: "Blocked", tone: "rose", bold: true } : { t: "On hold", tone: "amber", bold: true },
            r.reason ?? muted("no reason recorded"),
          ]),
        } as ExportBlock] : []),
      ],
    });
  }

  // ── On plan ── each other task once: where it is against the plan and
  // its next step. (Finished tasks are in Completed.)
  const quiet = rows.filter((x) => x.rank === 3);
  if (quiet.length > 0) {
    const shown = quiet.slice(0, MAX_ROWS);
    const hiddenQuiet = quiet.length - shown.length;
    out.push({
      id: "onplan", title: "On plan",
      sub: `${quiet.length} task${quiet.length === 1 ? "" : "s"}`,
      blocks: [{
        k: "table", head: ["Task", "Done / planned now", "Next step", "Status"], align: ["left", "right", "left", "left"],
        textLabels: ["", "done/planned", "next", ""],
        rows: [...shown.map((x) => x.cells), ...(hiddenQuiet > 0 ? [[muted(`+ ${hiddenQuiet} more on plan`), "", "", ""] as ExportCell[]] : [])],
      }],
    });
  }

  // ── Next shift ── its work, in the order it's listed for the crew; then
  // one line each for the other crew's unfinished work (theirs, picked up
  // if the next crew can) and its work paused until it's back.
  const otherName = next.kind === "day" ? "Night" : "Day";
  const names = (rows: ShiftRow[]) => {
    const list = rows.slice(0, MAX_ROWS).map((r) => `${r.parentName ? `${r.parentName} — ` : ""}${r.leaf.name}${r.percent > 0 ? ` (${r.percent}%)` : ""}`);
    return list.join("; ") + (rows.length > list.length ? `; + ${rows.length - list.length} more` : "");
  };
  // The other crew's work isn't the next shift's: it has its own section
  // (Carries to …) below. Its work paused over the next shift is a line.
  const carry: ExportBlock[] = [];
  const extra: ExportBlock[] = goals.paused.length ? [{ k: "note", text: `${otherName} crew's work paused until ${f.T(next.end)}: ${names(goals.paused)}.` } as ExportBlock] : [];
  if (goals.all.length === 0 && (carry.length || extra.length)) {
    out.push({ id: "next", title: `Next shift — ${shiftName(next)} ${f.D(next.start)} ${f.win(next)}`, blocks: [...carry, ...extra] });
  }
  if (goals.all.length > 0) {
    const nextList = goals.all.slice(0, MAX_ROWS * 2);
    const nextHidden = goals.all.length - nextList.length;
    out.push({
      id: "next", title: `Next shift — ${shiftName(next)} ${f.D(next.start)} ${f.win(next)}`,
      sub: `${goals.all.length} step${goals.all.length === 1 ? "" : "s"} · ${f.hrs(goals.mustDoHours)} this shift`,
      blocks: [...carry, {
        k: "table", head: ["Task", "Step", "Planned", "Who", "Now → goal"], align: ["left", "left", "left", "left", "right"],
        textLabels: ["", "", "", "by", "now → goal"], nowrap: [2, 4],
        rows: [...byTask(nextList, (r) => [
          { t: r.leaf.name, note: note(r.leaf.id) },
          r.carryOver ? { t: `carried over — was due ${f.DTs(r.dueAt)}`, tone: "rose" }
            : r.reflowed ? { t: `${f.T(r.crewStart)}–${r.crewFinish <= next.end ? f.T(r.crewFinish) : "…"} · file had ${f.DTs(r.start)}`, tone: "amber" }
            : r.start < next.start ? (r.pace === "behind" ? { t: "continues — behind", tone: "amber" } : muted("continues"))
              : `${f.T(r.start)}–${r.finish <= next.end ? f.T(r.finish) : "…"}`,
          muted(r.leaf.responsibleParty ?? ""),
          `${r.percent}% → ${r.goalPct ?? r.percent}%`,
        ]), ...(nextHidden > 0 ? [[muted(`+ ${nextHidden} more steps`), "", "", "", ""] as ExportCell[]] : [])],
      }, ...extra],
    });
  }
  // ── Carries to the other crew: its unfinished work, and work the file
  // put in the next shift's hours that has no crew then.
  const allCarries = [...goals.otherShift, ...goals.movedOff];
  const tried = allCarries.filter((r) => r.leaf.id && look.tryOf?.(r.leaf.id));
  const carries = allCarries.filter((r) => !tried.includes(r));
  if (tried.length > 0) {
    const nextSec = out.find((x) => x.id === "next");
    const block: ExportBlock = {
      k: "table", head: ["Task", "Step", "Why", "Crew", "Done"], align: ["left", "left", "left", "left", "right"],
      textLabels: ["", "", "", "crew", "done"], nowrap: [4],
      rows: byTask(tried, (r) => {
        const d = look.tryOf!(r.leaf.id!)!;
        return [
          { t: r.leaf.name, note: d.note ? `“${d.note}”` : undefined },
          r.carryOver ? { t: `carry-over — was due ${f.DTs(r.dueAt)}`, tone: "amber" } : muted(`${otherName.toLowerCase()} work — planned ${f.DTs(r.start)}`),
          d.crew ?? muted("not named"),
          `${r.percent}%`,
        ];
      }),
    };
    const sub: ExportBlock = { k: "sub", title: `Could try if possible — the ${otherName.toLowerCase()} crew's work`, count: tried.length, tone: "amber" };
    if (nextSec) nextSec.blocks.push(sub, block);
    else out.push({ id: "next", title: `Next shift — ${shiftName(next)} ${f.D(next.start)} ${f.win(next)}`, blocks: [sub, block] });
  }
  if (carries.length > 0) {
    const otherLower = otherName.toLowerCase();
    out.push({
      id: "carries", title: `Carries to ${otherLower} shift`,
      sub: `${carries.length} step${carries.length === 1 ? "" : "s"} for the ${otherLower} crew — not on the ${next.kind} shift's list`,
      blocks: [{
        k: "table", head: ["Task", "Step", "Why", "Who", "Done"], align: ["left", "left", "left", "left", "right"],
        textLabels: ["", "", "", "by", "done"], nowrap: [4],
        rows: byTask(carries.slice(0, MAX_ROWS * 2), (r) => [
          { t: r.leaf.name, note: note(r.leaf.id) },
          r.carryOver ? { t: `carry-over — was due ${f.DTs(r.dueAt)}`, tone: "amber" } : muted(`no ${next.kind} crew — planned ${f.DTs(r.start)}`),
          muted(r.leaf.responsibleParty ?? ""),
          `${r.percent}%`,
        ]),
      }],
    });
  }
  // ── The bottom line, beside the numbers: the verdict, the next shift's
  // size, the one thing to watch, and what finishes on it.
  const fin = overall.plannedFinish ? f.D(overall.plannedFinish) : null;
  const finishPassed = overall.plannedFinish != null && report.now > overall.plannedFinish && overall.actualPct < 100;
  const verdict = finishPassed ? `Planned finish ${fin} has passed — ${overall.actualPct}% done.`
    : overall.standing === "behind" ? `Behind by ${f.hrs(Math.abs(gap))} of work${fin ? ` — planned finish ${fin} at risk` : ""}.`
    : overall.standing === "ahead" ? `Ahead by ${f.hrs(Math.abs(gap))} of work${fin ? ` — planned finish ${fin}` : ""}.`
      : `On track${fin ? ` — planned finish holds for ${fin}` : ""}.`;
  const hoursBy = new Map<string, number>();
  for (const r of goals.all) { const k = equipmentTag(r.parentName, r.leaf.name) ?? r.leaf.name; hoursBy.set(k, (hoursBy.get(k) ?? 0) + (r.hoursNext ?? 0)); }
  const biggest = [...hoursBy].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k]) => k);
  const size = goals.all.length
    ? `${shiftName(next)} has ${goals.all.length} step${goals.all.length === 1 ? "" : "s"} (${f.hrs(goals.mustDoHours)})${biggest.length ? ` — most on ${biggest.join(", ")}` : ""}.`
    : `Nothing is planned for the ${shiftName(next).toLowerCase()}.`;
  const tasksOf = (rs: ShiftRow[]) => [...new Set(rs.map((r) => equipmentTag(r.parentName, r.leaf.name) ?? r.leaf.name))].slice(0, 3).join(", ");
  const pastDue = review.carryOver.filter((r) => r.status !== "blocked" && r.status !== "on_hold");
  const behindTasks = rows.filter((x) => x.rank === 2).length;
  const watch = pastDue.length ? { text: `${pastDue.length} step${pastDue.length === 1 ? "" : "s"} past due — ${tasksOf(pastDue)}.`, tone: "rose" as const }
    : blocked.length ? { text: `${blocked.length} step${blocked.length === 1 ? "" : "s"} blocked or on hold — ${tasksOf(blocked)}.`, tone: "rose" as const }
      : behindTasks ? { text: `${behindTasks} task${behindTasks === 1 ? "" : "s"} behind plan — see Problems.`, tone: "amber" as const }
        : null;
  // Planned to finish on the next shift — only when every open step of the
  // task is on that shift's list, none past due or held.
  const onNext = new Set(goals.all.map((r) => r.leaf.id));
  const canFinish = (pid: string) => (look.stepsOf?.(pid) ?? []).every((x) => x.pace === "done" || (onNext.has(x.id) && x.pace !== "overdue" && x.pace !== "held"));
  const finishing = [...new Map(goals.all.filter((r) => r.parentId && !r.carryOver).map((r) => [r.parentId!, r])).values()]
    .filter((r) => canFinish(r.parentId!))
    .map((r) => ({ name: r.parentName ?? r.leaf.name, at: look.finishOf(r.parentId!) }))
    .filter((x): x is { name: string; at: number } => x.at != null && x.at > next.start && x.at <= next.end)
    .sort((a, b) => a.at - b.at);
  stand.blocks = [{
    k: "overview", stats: [...standStats],
    bars: overall.plannedStart != null && overall.plannedFinish != null
      ? { done: overall.actualPct, plan: overall.plannedPct, from: f.D(overall.plannedStart), to: f.D(overall.plannedFinish) } : undefined,
    title: "Bottom line",
    lines: [
      { text: verdict },
      { text: size },
      ...(watch ? [{ label: "Watch", text: watch.text, tone: watch.tone }] : []),
      ...(tried.length ? [{ label: `${shiftName(next)} could try`, text: `${tried.length} ${otherName.toLowerCase()}-crew step${tried.length === 1 ? "" : "s"}, if possible — see Next shift.` }] : []),
      ...(asked.length ? [{ label: "Asked last turnover", text: `${askedDone} of ${asked.length} done (as entered).` }] : []),
      ...(finishing.length ? [{ label: `Planned to finish on ${shiftName(next).toLowerCase()}`, text: finishing.slice(0, 3).map((x) => `${x.name} (${f.T(x.at)})`).join(", ") + (finishing.length > 3 ? ` + ${finishing.length - 3} more` : "") }] : []),
    ],
  }];

  // ── Crews on the next shift: how many steps and hours each has.
  if (goals.all.length > 0) {
    const crews = new Map<string, { steps: number; hours: number }>();
    for (const r of goals.all) { const w = whoOf(r); const e = crews.get(w) ?? { steps: 0, hours: 0 }; e.steps++; e.hours += r.hoursNext ?? 0; crews.set(w, e); }
    const list = [...crews].sort((a, b) => b[1].hours - a[1].hours || b[1].steps - a[1].steps || a[0].localeCompare(b[0], undefined, { numeric: true }))
      .map(([who, e]) => ({ title: who, value: `${e.steps} step${e.steps === 1 ? "" : "s"} · ${f.hrs(e.hours)}` }));
    const half = Math.ceil(list.length / 2);
    const at = out.findIndex((s) => s.id === "next");
    const crewSec: ExportSection & { id: string } = {
      id: "crews", title: `Crews on ${shiftName(next).toLowerCase()}`,
      blocks: [{ k: "columns", cols: list.length > 3 ? [{ title: "", rows: list.slice(0, half) }, { title: "", rows: list.slice(half) }] : [{ title: "", rows: list }] }],
    };
    out.splice(at >= 0 ? at : out.length, 0, crewSec);
  }

  // ── Safety focus: the next shift's riskiest jobs, each with this shift's
  // "don't miss" lesson. Left out of a copy unless ticked.
  const hazards = rankHazards(hazardJobsOf(goals.all, next, (r) => (r.carryOver ? `due ${f.DTs(r.dueAt)}` : `${f.T(Math.max(r.start, next.start))}–${r.finish <= next.end ? f.T(r.finish) : "…"}`)), { max: 2 });
  if (hazards.length > 0) {
    out.push({
      id: "safety", title: `Safety focus — ${shiftName(next).toLowerCase()}`, offByDefault: true,
      blocks: [{ k: "columns", cols: hazards.map((h, i) => {
        const l = lessonFor(h.kind, next.start);
        return { title: `${i + 1} · ${h.label}`, tone: "amber" as const, rows: [
          { title: hazardContext(h), text: l ? `${l.watch} → ${l.prevent}` : "" },
        ] };
      }) }],
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
