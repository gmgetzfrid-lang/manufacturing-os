// lib/managementUpdate.ts — the shift turnover as an update for management.
//
// The meeting report runs a turnover: numbered agenda, prompts, the order
// to work in, stretch goals, sign-off. Management reads none of that. They
// want, in a glance: are we on plan, what got done, what didn't and why,
// what needs them, what's next. So the update is short tables, one line per
// main task where a line per step would be noise, and nothing that's empty —
// no "did not finish" when everything finished, no "needs a decision" when
// nothing is blocked.

import { BEHIND_POINTS, type Pace, type ShiftReport, type ShiftRow, type ShiftWindow, type WorkShift } from "@/lib/shiftReport";
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
  stepsOf?: (id: string) => Array<{ id?: string; name: string; start: number; finish: number; percent: number; pace: Pace; expectedPct: number; status: string; work?: WorkShift }> | undefined;
  /** The latest comment on a step ("sent out for calibration"), and when. */
  noteOf?: (stepId: string) => string | { body: string; at?: string | number | null } | undefined;
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
  out.push({
    id: "stand", title: "Where we stand",
    sub: overall.plannedFinish ? `Day ${overall.daysElapsed} of ${overall.daysTotal} · planned finish ${f.D(overall.plannedFinish)}` : undefined,
    blocks: [{
      k: "stats", items: [
        { label: "Complete", value: `${overall.actualPct}%`, tone: overall.standing === "behind" ? "rose" : overall.standing === "ahead" ? "emerald" : "slate" },
        { label: "Plan", value: `${overall.plannedPct}%`, tone: "slate" },
        { label: gapTile.label, value: Math.abs(gap) <= 0.5 ? "even" : overall.standing === "on track" ? `${f.hrs(Math.abs(gap))} ${gap > 0 ? "behind" : "ahead"}` : f.hrs(Math.abs(gap)), tone: gapTile.tone },
        { label: "Steps done", value: `${overall.stepsDone} / ${overall.stepsTotal}`, tone: "slate" },
      ],
    }],
  });

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
    const self = { id: r.leaf.id ?? undefined, name: r.leaf.name, start: r.start, finish: r.finish, percent: r.percent, pace: r.pace, expectedPct: r.expectedPct, status: r.status, work: r.work };
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
    // Name the step the status is about — "next step" when it's the one in
    // the Next step column — so a step's 0% isn't read as the task's.
    const who = (x: typeof next) => (x === next ? "next step " : `${x.name} `);
    const more = issues.length > 1 ? ` (+${issues.length - 1} more)` : "";
    const plan = id ? look.planOf?.(id) : undefined;
    const fin = id ? look.finishOf(id) : r.finish;
    // The planned finish — not a forecast — and only while it's ahead.
    const finText = fin != null && Number.isFinite(fin) && fin > report.now ? ` · planned finish ${f.DTs(fin)}` : "";
    const status: ExportCell = worst
      ? worst.pace === "overdue" ? { t: `Overdue — ${who(worst)}${Number.isFinite(worst.finish) ? `was due ${f.DTs(worst.finish)}` : "past due"}${more}`, tone: "rose" }
        : worst.pace === "held" ? { t: `${worst.status === "blocked" ? "Blocked" : "On hold"} — ${worst === next ? "next step" : worst.name}${more} (see below)`, tone: worst.status === "blocked" ? "rose" : "amber" }
          : { t: `Behind — ${who(worst)}${worst.percent}% of ${worst.expectedPct}% planned${more}`, tone: "amber" }
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
      rank: worst ? order[worst.pace] : behind ? 2 : 3, behind, complete: false,
    });
  }
  if (rows.length > 0) {
    rows.sort((a, b) => a.rank - b.rank);
    const nBehind = rows.filter((x) => x.behind).length, nDone = rows.filter((x) => x.complete).length;
    // Every problem is listed; quiet rows stop at the cap with a count.
    const problems = rows.filter((x) => x.rank <= 2);
    const quiet = rows.filter((x) => x.rank > 2);
    const room = Math.max(3, MAX_ROWS - problems.length);
    const shown = [...problems, ...quiet.slice(0, room)];
    const hidden = quiet.length - Math.min(quiet.length, room);
    out.push({
      id: "last", title: `Last shift — ${shiftName(shift)} ${f.D(shift.start)}`,
      sub: [`${review.done.length} step${review.done.length === 1 ? "" : "s"} done`, nBehind ? `${nBehind} task${nBehind === 1 ? "" : "s"} behind` : null, nDone ? `${nDone} complete` : null].filter(Boolean).join(" · "),
      flag: rows.some((x) => x.rank <= 1) ? "rose" : nBehind ? "amber" : null,
      blocks: [{
        k: "table", head: ["Task", "Done / planned now", "Next step", "Status"], align: ["left", "right", "left", "left"],
        textLabels: ["", "done/planned", "next", ""],
        rows: [...shown.map((x) => x.cells), ...(hidden > 0 ? [[muted(`+ ${hidden} more on plan or complete`), "", "", ""] as ExportCell[]] : [])],
      }],
    });
  }

  // ── Needs a decision ── only when something is blocked or on hold.
  if (blocked.length > 0) {
    out.push({
      id: "decide", title: "Needs a decision", flag: blocked.some((r) => r.status === "blocked") ? "rose" : "amber",
      blocks: [{
        k: "table", head: ["Task", "Step", "Status", "Reason"], textLabels: ["", "", "", ""],
        rows: byTask(blocked, (r) => [
          r.leaf.name,
          r.status === "blocked" ? { t: "Blocked", tone: "rose", bold: true } : { t: "On hold", tone: "amber", bold: true },
          r.reason ?? muted("no reason recorded"),
        ]),
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
  // The other crew's unfinished work leads (it needs attention); its work
  // paused overnight follows the list.
  const carry: ExportBlock[] = goals.otherShift.length ? [{ k: "note", text: `${otherName} shift carry-over — pick up if you can: ${names(goals.otherShift)}.`, tone: "amber" } as ExportBlock] : [];
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
        k: "table", head: ["Task", "Step", "Planned", "Done"], align: ["left", "left", "left", "right"], textLabels: ["", "", "", "done"],
        rows: [...byTask(nextList, (r) => [
          { t: r.leaf.name, note: note(r.leaf.id) },
          r.carryOver ? { t: `carried over — was due ${f.DTs(r.finish)}`, tone: "rose" }
            : r.start < next.start ? (r.pace === "behind" ? { t: "continues — behind plan", tone: "amber" } : muted("continues as planned"))
              : `${f.T(r.start)}–${r.finish <= next.end ? f.T(r.finish) : "…"}`,
          r.percent > 0 ? `${r.percent}%` : "",
        ]), ...(nextHidden > 0 ? [[muted(`+ ${nextHidden} more steps`), "", "", ""] as ExportCell[]] : [])],
      }, ...extra],
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
