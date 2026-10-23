// lib/managementUpdate.ts — the shift turnover as an update for management.
//
// The meeting report runs a turnover: numbered agenda, prompts, the order
// to work in, stretch goals, sign-off. Management reads none of that. They
// want, in a glance: are we on plan, what got done, what didn't and why,
// what needs them, what's next. So the update is short tables, one line per
// main task where a line per step would be noise, and nothing that's empty —
// no "did not finish" when everything finished, no "needs a decision" when
// nothing is blocked.

import type { ShiftReport, ShiftRow, ShiftWindow } from "@/lib/shiftReport";
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
}

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
  out.push({
    id: "stand", title: "Where we stand",
    sub: overall.plannedFinish ? `Day ${overall.daysElapsed} of ${overall.daysTotal} · planned finish ${f.D(overall.plannedFinish)}` : undefined,
    blocks: [{
      k: "stats", items: [
        { label: "Complete", value: `${overall.actualPct}%`, tone: overall.standing === "behind" ? "rose" : overall.standing === "ahead" ? "emerald" : "slate" },
        { label: "Plan", value: `${overall.plannedPct}%`, tone: "slate" },
        { label: gap > 0.5 ? "Behind" : gap < -0.5 ? "Ahead" : "Gap", value: Math.abs(gap) > 0.5 ? f.hrs(Math.abs(gap)) : "even", tone: gap > 0.5 ? "rose" : gap < -0.5 ? "emerald" : "slate" },
        { label: "Steps done", value: `${overall.stepsDone} / ${overall.stepsTotal}`, tone: "slate" },
      ],
    }],
  });

  // ── Last shift ──
  // Its own crew's unfinished work (another crew's is theirs to report).
  const own = (r: ShiftRow) => r.work === "both" || r.work === shift.kind;
  const seen = new Set<string>();
  const notFinished: ShiftRow[] = [];
  for (const r of [...review.carryOver, ...review.inProgress, ...review.notStarted]) {
    if (!own(r) || !r.leaf.id || seen.has(r.leaf.id)) continue;
    seen.add(r.leaf.id); notFinished.push(r);
  }
  const blocks: ExportBlock[] = [];
  if (review.done.length > 0) {
    // One line per main task: how far it is, the last step done, and when
    // the rest is planned to finish — so work planned over several days
    // reads as on its way, not as unfinished.
    const tasks = new Map<string, { name: string; id: string | null; last: ShiftRow }>();
    for (const r of review.done) {
      const k = r.parentId ?? `solo:${r.leaf.id ?? r.leaf.name}`;
      const prev = tasks.get(k);
      const when = (x: ShiftRow) => (x.leaf.actualAt ? Date.parse(String(x.leaf.actualAt)) : x.finish);
      if (!prev || when(r) >= when(prev.last)) tasks.set(k, { name: r.parentName ?? r.leaf.name, id: r.parentId, last: r });
    }
    const rows: ExportCell[][] = [...tasks.values()].map((t) => {
      const pct = t.id ? look.pctOf(t.id) ?? 0 : 100;
      if (pct >= 100) return [{ t: t.name, bold: true }, { t: "100%", tone: "emerald", bold: true }, "", { t: "Complete", tone: "emerald" }];
      const fin = t.id ? look.finishOf(t.id) : undefined;
      const late = fin != null && fin <= report.now;
      return [
        { t: t.name, bold: true }, { t: `${pct}%`, bold: true }, t.last.leaf.name,
        fin == null ? "" : late ? { t: `${f.DTs(fin)} · late`, tone: "rose" } : f.DTs(fin),
      ];
    });
    blocks.push({ k: "label", text: "Completed" });
    blocks.push({ k: "table", head: ["Task", "% complete", "Last step done", "Planned finish"], align: ["left", "right", "left", "left"], textLabels: ["", "", "last step", "planned finish"], rows });
  }
  if (notFinished.length > 0) {
    blocks.push({ k: "label", text: "Not finished" });
    blocks.push({
      k: "table", head: ["Task", "Step", "Done", "Status"], align: ["left", "left", "right", "left"], textLabels: ["", "", "", ""],
      // Why a held step is held is said once, under Needs a decision.
      rows: byTask(notFinished, (r) => [
        r.leaf.name,
        r.percent > 0 ? `${r.percent}%` : muted("0%"),
        r.status === "blocked" ? { t: "Blocked", tone: "rose" }
          : r.status === "on_hold" ? { t: "On hold", tone: "amber" }
            : r.percent > 0 ? muted("in progress") : muted("not started"),
      ]),
    });
  }
  if (blocks.length > 0) {
    out.push({
      id: "last", title: `Last shift — ${shiftName(shift)} ${f.D(shift.start)}`,
      sub: `${review.done.length} step${review.done.length === 1 ? "" : "s"} done${notFinished.length ? ` · ${notFinished.length} not finished` : ""}`,
      flag: notFinished.some((r) => r.critical) ? "rose" : null,
      blocks,
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

  // ── Next shift ── its work, in the order it's listed for the crew.
  if (goals.all.length > 0) {
    out.push({
      id: "next", title: `Next shift — ${shiftName(next)} ${f.D(next.start)} ${f.win(next)}`,
      sub: `${goals.all.length} step${goals.all.length === 1 ? "" : "s"} · ${f.hrs(goals.mustDoHours)}`,
      blocks: [{
        k: "table", head: ["Task", "Step", "Planned", "Done"], align: ["left", "left", "left", "right"], textLabels: ["", "", "", "done"],
        rows: byTask(goals.all, (r) => [
          r.leaf.name,
          r.carryOver ? { t: "carried over", tone: "amber" }
            : r.start < next.start ? muted("continues")
              : `${f.T(r.start)}–${r.finish <= next.end ? f.T(r.finish) : "…"}`,
          r.percent > 0 ? `${r.percent}%` : "",
        ]),
      }],
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
