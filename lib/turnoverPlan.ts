// turnoverPlan — where every step goes at a turnover, decided once.
//
// The screen report and the email read the same answer, so they can't
// disagree. The rule: each step appears ONCE, in the place that says what
// happens to it —
//   done      finished this shift (or moved forward and on no list)
//   next      the next crew's own work, in priority order
//   try       marked at the meeting: the next crew could try it
//   carry     waits for its own crew (the other shift): unfinished, under
//             way and continuing, or put in hours its crew isn't on
//   held      blocked or on hold — needs a decision
// Progress made this shift rides on the step's own row ("+25 this shift"),
// never in a second list.

import type { ShiftReport, ShiftRow } from "@/lib/shiftReport";

export type NextKind = "next" | "try" | "carry" | "held";
export type NextTone = "rose" | "amber" | "emerald" | "muted";

export interface TurnoverPlan {
  /** Finished this shift. */
  done: ShiftRow[];
  /** Moved forward this shift, not finished, and on no list below. */
  moved: ShiftRow[];
  /** Everything still open, once each, the next crew's work first. */
  items: Array<{ r: ShiftRow; kind: NextKind }>;
  kindOf: Map<ShiftRow, NextKind>;
  /** Marked "could try" — the other crew's carried work and pulled-ahead steps. */
  tried: ShiftRow[];
  pulled: ShiftRow[];
  carries: ShiftRow[];
  held: ShiftRow[];
}

const isHeld = (r: ShiftRow) => r.status === "blocked" || r.status === "on_hold";

export function turnoverPlan(report: ShiftReport, isTried: (id: string) => boolean): TurnoverPlan {
  const { review, goals, blocked } = report;
  const marked = (r: ShiftRow) => !!r.leaf.id && isTried(r.leaf.id);
  // The other crew's work: unfinished, put in hours its crew isn't on, or
  // under way and continuing on its next shift.
  const allCarries = [...goals.otherShift, ...goals.movedOff, ...goals.paused];
  const pulled = goals.pulled.filter(marked);
  const tried = [...allCarries.filter(marked), ...pulled];
  const items: Array<{ r: ShiftRow; kind: NextKind }> = [];
  const seen = new Set<string>();
  const add = (rs: ShiftRow[], kind: NextKind) => {
    for (const r of rs) {
      const k = r.leaf.id ?? r.leaf.name;
      if (seen.has(k)) continue;
      seen.add(k);
      items.push({ r, kind });
    }
  };
  // Claimed in this order — a blocked step is "held" even when it's also
  // on a list; one marked to try is not also "waits for its crew".
  add(blocked, "held");
  add(tried, "try");
  add(goals.all, "next");
  // All of it listed — a step behind plan, or with a comment, is never
  // just a name in a line.
  add(allCarries.filter((r) => !isHeld(r)), "carry");
  const RANK: Record<NextKind, number> = { next: 0, try: 1, carry: 2, held: 3 };
  items.sort((a, b) => RANK[a.kind] - RANK[b.kind]);
  const kindOf = new Map(items.map((x) => [x.r, x.kind]));
  const done = review.done;
  const doneIds = new Set(done.map((r) => r.leaf.id ?? r.leaf.name));
  // Moved this shift but on no list (mostly later work done early) — kept,
  // so no progress goes unreported.
  const moved = (review.knownStart ? review.progressed : review.ahead)
    .filter((r) => r.percent < 100 && !doneIds.has(r.leaf.id ?? r.leaf.name) && !seen.has(r.leaf.id ?? r.leaf.name));
  return {
    done, moved, items, kindOf, tried, pulled,
    carries: items.filter((x) => x.kind === "carry").map((x) => x.r),
    held: items.filter((x) => x.kind === "held").map((x) => x.r),
  };
}

/** Points gained this shift — only when the shift's start is on record. */
export function gainOf(report: ShiftReport, r: ShiftRow): number {
  return report.review.knownStart && r.pctStart != null && r.percent > r.pctStart ? r.percent - r.pctStart : 0;
}

/** What happens to a step next, as a short label and the detail behind it.
 *  The screen shows the label in its When column and the detail as a tag;
 *  the email joins them. */
export function nextOf(report: ShiftReport, r: ShiftRow, kind: NextKind, t: { T: (ms: number) => string; DTs: (ms: number) => string },
  o: { pulled?: boolean; crew?: string | null } = {}): { label: string; detail?: string; tone?: NextTone } {
  const { shift, next } = report;
  const other = next.kind === "day" ? "night" : "day";
  const late = r.dueAt < shift.start ? `late, was due ${t.DTs(r.dueAt)}` : `was due ${t.DTs(r.dueAt)}`;
  const span = (a: number, b: number) => `${t.T(Math.max(a, next.start))}–${b <= next.end ? t.T(b) : "…"}`;
  switch (kind) {
    case "held":
      return { label: r.status === "blocked" ? "Blocked" : "On hold", detail: r.reason ?? "no reason recorded", tone: r.status === "blocked" ? "rose" : "amber" };
    case "try":
      return {
        label: `Could try${o.crew ? ` (${o.crew})` : ""}`,
        detail: o.pulled ? `pulled ahead — planned ${t.DTs(r.crewStart)}` : r.carryOver ? `${other} crew's — ${late}`
          : r.start < next.start ? `${other} crew's — under way` : `${other} crew's — planned ${t.DTs(r.start)}`,
        tone: "amber",
      };
    case "carry":
      if (r.carryOver) return { label: `Waits for ${other} crew`, detail: late, tone: r.dueAt < shift.start ? "rose" : "amber" };
      // Under way, continues on its crew's next shift.
      if (r.start < next.start) {
        return r.pace === "behind"
          ? { label: `Waits for ${other} crew`, detail: `behind plan (plan had ${r.expectedPct}%), continues next ${other} shift`, tone: "amber" }
          : { label: `Waits for ${other} crew`, detail: `on plan, continues next ${other} shift`, tone: "muted" };
      }
      return { label: `Waits for ${other} crew`, detail: `no ${next.kind} crew — planned ${t.DTs(r.start)}`, tone: "muted" };
    default:
      if (r.carryOver) return { label: "Carried over", detail: late, tone: "amber" };
      if (r.reflowed) return { label: span(r.crewStart, r.crewFinish) };
      if (r.start < next.start) return r.pace === "behind" ? { label: "Continues", detail: "behind plan", tone: "amber" } : { label: "Continues" };
      return { label: span(r.start, r.finish) };
  }
}

/** Where a step stands, and — for the next crew's own work — its goal by
 *  the end of that shift. "45% → 45%" never shows: at its goal, it's "45%". */
export function standing(r: ShiftRow, kind: NextKind): string {
  const goal = kind === "next" ? r.goalPct ?? r.percent : r.percent;
  return goal > r.percent ? `${r.percent}% → ${goal}%` : `${r.percent}%`;
}

/** What the last turnover asked of this shift, in one line (as entered):
 *  "1 of 3 done — Pull bundle 0% → 40%, Blinds not started". */
export function askedLine(asked: Array<{ name: string; from: number; now: number | null }>, result: (a: { from: number; now: number | null }) => string): string {
  const done = asked.filter((a) => (a.now ?? 0) >= 100).length;
  const open = asked.filter((a) => (a.now ?? 0) < 100);
  const list = open.slice(0, 3).map((a) => `${a.name} ${result(a)}`).join(", ") + (open.length > 3 ? ` + ${open.length - 3} more` : "");
  return `${done} of ${asked.length} done${open.length ? ` — ${list}` : ""} (as entered).`;
}

type Fmt = { T: (ms: number) => string; DTs: (ms: number) => string; hrs: (h: number) => string };

/** A step's share of the gap — "+4 h ahead" — when it has one worth saying. */
export function shareOf(report: ShiftReport, id: string | null | undefined): { hours: number; side: "ahead" | "behind" } | null {
  if (!id) return null;
  const a = report.overall.drivers.ahead.find((d) => d.id === id);
  if (a && a.hours >= 0.1) return { hours: a.hours, side: "ahead" };
  const b = report.overall.drivers.behind.find((d) => d.id === id);
  if (b && b.hours >= 0.1) return { hours: b.hours, side: "behind" };
  return null;
}

/** What a step done (or moved) this shift means for the plan: on plan,
 *  early, or late — never a bare check mark. `text` is the sentence. */
export function doneOf(report: ShiftReport, r: ShiftRow, t: Fmt): { label: string; detail: string; tone: NextTone; text: string } {
  const sh = shareOf(report, r.leaf.id);
  const worth = sh?.side === "ahead" ? `put you ${t.hrs(Math.round(sh.hours * 10) / 10)} ahead` : "";
  if (r.percent >= 100) {
    if (r.plannedLater) return { label: "Done early", detail: `planned ${t.DTs(r.crewStart)}${worth ? ` · ${worth}` : ""}`, tone: "emerald", text: `done early (planned ${t.DTs(r.crewStart)})${worth ? ` — ${worth}` : ""}` };
    if (r.dueAt < report.shift.start) return { label: "Done late", detail: `was due ${t.DTs(r.dueAt)}`, tone: "amber", text: `done late (was due ${t.DTs(r.dueAt)})` };
    return { label: "Done", detail: "on plan", tone: "emerald", text: "done, on plan" };
  }
  const g = gainOf(report, r);
  const moved = g > 0 ? `${r.percent - g}% → ${r.percent}%` : `${r.percent}%`;
  return r.plannedLater
    ? { label: moved, detail: `started early — planned ${t.DTs(r.crewStart)}${worth ? ` · ${worth}` : ""}`, tone: "emerald", text: `${moved} this shift, started early (planned ${t.DTs(r.crewStart)})${worth ? ` — ${worth}` : ""}` }
    : { label: moved, detail: "progress this shift", tone: "emerald", text: `${moved} this shift` };
}

/** Ahead or behind, and why: the total, then the steps that make it up. */
export function gapStory(report: ShiftReport, t: Fmt, max = 5) {
  const { overall, goals } = report;
  const d = overall.drivers;
  const gap = goals.gapHours;
  const h = (x: number) => t.hrs(Math.round(x * 10) / 10);
  const headline = gap < -0.5 ? `Ahead by ${h(-gap)} of work — ${h(d.aheadHours)} done ahead of plan, less ${h(d.behindHours)} behind.`
    : gap > 0.5 ? `Behind by ${h(gap)} of work — ${h(d.behindHours)} behind plan, less ${h(d.aheadHours)} done ahead.`
      : `Even with the plan — ${h(d.aheadHours)} ahead and ${h(d.behindHours)} behind balance out.`;
  const now = report.now;
  const line = (x: (typeof d.ahead)[number], side: "ahead" | "behind") => ({
    task: x.parentName, step: x.name,
    text: side === "ahead"
      ? `${x.percent >= 100 ? "done" : `${x.percent}% done`}, plan had ${x.planPct}% by now${x.start > now ? ` (planned ${t.DTs(x.start)})` : ""}`
      : `${x.percent}% done, plan had ${x.planPct}% by now${x.finish < now ? ` (planned finish ${t.DTs(x.finish)})` : ""}`,
    hours: `${side === "ahead" ? "+" : "−"}${h(x.hours)}`,
  });
  const rest = (xs: typeof d.ahead) => { const more = xs.slice(max); return more.length ? { count: more.length, hours: h(more.reduce((a, x) => a + x.hours, 0)) } : null; };
  return {
    headline,
    ahead: { total: h(d.aheadHours), lines: d.ahead.slice(0, max).map((x) => line(x, "ahead")), more: rest(d.ahead) },
    behind: { total: h(d.behindHours), lines: d.behind.slice(0, max).map((x) => line(x, "behind")), more: rest(d.behind) },
  };
}
