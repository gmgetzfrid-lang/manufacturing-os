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

import { whoOf, type ShiftReport, type ShiftRow } from "@/lib/shiftReport";
import { equipmentTag } from "@/lib/safetyMoment";
import { discoveryOf, kindOf, ADDED } from "@/lib/discovery";

export type NextKind = "next" | "try" | "carry" | "held";

/** The order the supervisor dragged each table into, kept on the shift's
 *  record: Done by task, Next and Carries by step. Anything not in it (new
 *  since) follows, in the usual order. */
export interface TableOrder { done?: string[]; next?: string[]; later?: string[] }

/** `list` in `order` first, then the rest as they were. */
export function inOrder<T>(list: T[], keyOf: (x: T) => string, order?: string[]): T[] {
  if (!order?.length) return list;
  const at = new Map(order.map((k, i) => [k, i]));
  const known = list.filter((x) => at.has(keyOf(x))).sort((a, b) => at.get(keyOf(a))! - at.get(keyOf(b))!);
  return [...known, ...list.filter((x) => !at.has(keyOf(x)))];
}
export type NextTone = "rose" | "amber" | "emerald" | "muted";

export interface TurnoverPlan {
  /** Finished this shift. */
  done: ShiftRow[];
  /** Moved forward this shift, not finished — credited under Done even
   *  when it's also on a list below (that list says what happens next). */
  moved: ShiftRow[];
  /** Everything still open, once each, the next crew's work first. */
  items: Array<{ r: ShiftRow; kind: NextKind }>;
  kindOf: Map<ShiftRow, NextKind>;
  /** Marked "could try" — the other crew's carried work and pulled-ahead steps. */
  tried: ShiftRow[];
  pulled: ShiftRow[];
  carries: ShiftRow[];
  held: ShiftRow[];
  /** The tables' own order, when the supervisor set one. */
  order?: TableOrder;
}

const isHeld = (r: ShiftRow) => r.status === "blocked" || r.status === "on_hold";

export function turnoverPlan(report: ShiftReport, isTried: (id: string) => boolean, order?: TableOrder): TurnoverPlan {
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
  // The order dragged at the meeting: the next crew's table (its numbers
  // follow), and the other crew's.
  if (order?.next?.length || order?.later?.length) {
    const key = (x: { r: ShiftRow }) => x.r.leaf.id ?? x.r.leaf.name;
    const tonight = items.filter((x) => x.kind === "next" || x.kind === "try");
    const later = items.filter((x) => x.kind === "carry" || x.kind === "held");
    items.splice(0, items.length, ...inOrder(tonight, key, order.next), ...inOrder(later, key, order.later));
  }
  const kindOf = new Map(items.map((x) => [x.r, x.kind]));
  const done = review.done;
  const doneIds = new Set(done.map((r) => r.leaf.id ?? r.leaf.name));
  // Everything moved forward this shift but not finished — the shift gets
  // credit for it under Done, wherever it goes next.
  const moved = (review.knownStart ? review.progressed : review.ahead)
    .filter((r) => r.percent < 100 && !doneIds.has(r.leaf.id ?? r.leaf.name));
  return {
    done, moved, items, kindOf, tried, pulled, order,
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
 *  the end of that shift: "25% · goal 100%" — where it is first, never a
 *  "0% → …" to puzzle out. At its goal, just "45%". */
export function standing(r: ShiftRow, kind: NextKind): string {
  const goal = kind === "next" ? r.goalPct ?? r.percent : r.percent;
  return goal > r.percent ? `${r.percent}% · goal ${goal}%` : `${r.percent}%`;
}

/** What the last turnover asked of this shift, in one line (as entered):
 *  "1 of 3 done — Pull bundle 40%, Blinds not started". */
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
 *  early, or late — never a bare check mark. `text` is the sentence; its
 *  hours ahead or behind are their own column (vsPlan). */
export function doneOf(report: ShiftReport, r: ShiftRow, t: Fmt): { label: string; detail: string; tone: NextTone; text: string } {
  if (r.percent >= 100) {
    if (r.plannedLater) return { label: "Done early", detail: `planned ${t.DTs(r.crewStart)}`, tone: "emerald", text: `done early (planned ${t.DTs(r.crewStart)})` };
    if (r.dueAt < report.shift.start) return { label: "Done late", detail: `was due ${t.DTs(r.dueAt)}`, tone: "amber", text: `done late (was due ${t.DTs(r.dueAt)})` };
    return { label: "Done", detail: "on plan", tone: "emerald", text: "done, on plan" };
  }
  const moved = `${r.percent}%`;
  return r.plannedLater
    ? { label: moved, detail: `started early — planned ${t.DTs(r.crewStart)}`, tone: "emerald", text: `${moved} this shift, started early (planned ${t.DTs(r.crewStart)})` }
    : { label: moved, detail: "progress this shift", tone: "emerald", text: `${moved} this shift` };
}

/** A step's hours ahead (+) or behind (−) the plan, for its row: "+4 h",
 *  "−4.8 h", or "" when it's on plan. */
export function vsPlan(report: ShiftReport, r: ShiftRow, hrs: (h: number) => string): { text: string; tone?: "emerald" | "rose" } {
  const sh = shareOf(report, r.leaf.id);
  if (!sh) return { text: "" };
  const h = hrs(Math.round(sh.hours * 10) / 10);
  return sh.side === "ahead" ? { text: `+${h}`, tone: "emerald" } : { text: `−${h}`, tone: "rose" };
}

/** Ahead or behind steps that aren't on the turnover's lists (done early
 *  on an earlier shift, say) — so the total still adds up on the page. */
export function offListDrivers(report: ShiftReport, plan: TurnoverPlan, hrs: (h: number) => string): { ahead: string | null; behind: string | null } {
  const listed = new Set([...plan.done, ...plan.moved, ...plan.items.map((x) => x.r)].map((r) => r.leaf.id));
  const line = (xs: typeof report.overall.drivers.ahead, sign: string) => {
    const off = xs.filter((x) => x.hours >= 0.1 && !listed.has(x.id ?? undefined));
    if (!off.length) return null;
    const total = hrs(Math.round(off.reduce((a, x) => a + x.hours, 0) * 10) / 10);
    const names = off.slice(0, 4).map((x) => `${x.parentName ? `${x.parentName} ` : ""}${x.name} ${sign}${hrs(Math.round(x.hours * 10) / 10)}`).join(", ");
    return `${off.length} step${off.length === 1 ? "" : "s"}, ${sign}${total} — ${names}${off.length > 4 ? ` + ${off.length - 4} more` : ""}`;
  };
  return { ahead: line(report.overall.drivers.ahead, "+"), behind: line(report.overall.drivers.behind, "−") };
}

/** Ahead or behind, and why: the total, then the steps that make it up. */
export function gapStory(report: ShiftReport, t: Fmt, max = 5) {
  const { overall, goals } = report;
  const d = overall.drivers;
  const gap = goals.gapHours;
  const h = (x: number) => t.hrs(Math.round(x * 10) / 10);
  // Plain words, with the jobs named: how the job can be ahead overall
  // while some of it is late.
  const headline = gap < -0.5 ? `Overall ahead of plan by ${h(-gap)} of work.`
    : gap > 0.5 ? `Overall behind plan by ${h(gap)} of work.`
      : "Overall even with the plan.";
  const names = (xs: typeof d.ahead) => {
    const top = xs.filter((x) => x.hours >= 0.1).slice(0, 4).map((x) => { const tag = equipmentTag(x.parentName, x.name); return tag && tag !== x.name ? `${tag}: ${x.name}` : x.name; });
    const more = xs.filter((x) => x.hours >= 0.1).length - top.length;
    return top.join(", ") + (more > 0 ? ` + ${more} more` : "");
  };
  const aheadLine = d.aheadHours >= 0.1 ? `${h(d.aheadHours)} of work done earlier than planned — ${names(d.ahead)}.` : null;
  const behindLine = d.behindHours >= 0.1 ? `${h(d.behindHours)} of work the plan has done by now that isn't — ${names(d.behind)}.` : null;
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
    headline, aheadLine, behindLine,
    ahead: { total: h(d.aheadHours), lines: d.ahead.slice(0, max).map((x) => line(x, "ahead")), more: rest(d.ahead) },
    behind: { total: h(d.behindHours), lines: d.behind.slice(0, max).map((x) => line(x, "behind")), more: rest(d.behind) },
  };
}

/** Who was on the shift just worked, and who's on the next one — by crew,
 *  for the top of the turnover. */
export function crewsOf(report: ShiftReport, plan: TurnoverPlan, hrs: (h: number) => string): {
  worked: Array<{ crew: string; text: string; note?: string }>;
  coming: Array<{ crew: string; text: string; note?: string }>;
} {
  const who = (r: ShiftRow) => r.leaf.responsibleParty?.trim() || "No crew named";
  const sort = <T extends { n: number }>(m: Map<string, T>) => [...m].sort((a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0], undefined, { numeric: true }));
  // Steps with no crew on them are named, so the missing crew can be filled in.
  const stepLabel = (r: ShiftRow) => (r.parentName ? `${r.parentName}: ${r.leaf.name}` : r.leaf.name);
  const wNames: string[] = [], cNames: string[] = [];
  // Under the crew's name, so the short count beside it never wraps.
  const unnamed = (crew: string, names: string[]) => (crew === "No crew named" && names.length ? `${names.slice(0, 3).join("; ")}${names.length > 3 ? ` + ${names.length - 3} more` : ""} — no responsible party set` : undefined);
  // Worked: the shift's own planned work, and anything finished or moved on it.
  const seen = new Set<string>();
  const w = new Map<string, { n: number; done: number }>();
  for (const r of [...report.review.scheduled.filter((r) => r.work === "both" || r.work === report.shift.kind), ...plan.done, ...plan.moved]) {
    const k = r.leaf.id ?? r.leaf.name;
    if (seen.has(k)) continue;
    seen.add(k);
    if (!r.leaf.responsibleParty?.trim()) wNames.push(stepLabel(r));
    const e = w.get(who(r)) ?? { n: 0, done: 0 };
    e.n++; if (r.percent >= 100) e.done++;
    w.set(who(r), e);
  }
  const c = new Map<string, { n: number; hours: number }>();
  for (const x of plan.items) {
    if (x.kind !== "next") continue;
    if (!x.r.leaf.responsibleParty?.trim()) cNames.push(stepLabel(x.r));
    const e = c.get(who(x.r)) ?? { n: 0, hours: 0 };
    e.n++; e.hours += x.r.hoursNext ?? 0;
    c.set(who(x.r), e);
  }
  return {
    // Short, so it fits beside the name on a phone: "12 of 15 done", "2 steps · 6 h".
    worked: sort(w).map(([crew, e]) => ({ crew, text: `${e.done} of ${e.n} done`, note: unnamed(crew, wNames) })),
    coming: sort(c).map(([crew, e]) => ({ crew, text: `${e.n} step${e.n === 1 ? "" : "s"} · ${hrs(Math.round(e.hours * 10) / 10)}`, note: unnamed(crew, cNames) })),
  };
}

/** What got done, one row per task (equipment): its steps finished or
 *  moved this shift in one cell, what that meant for the plan, and the
 *  hours it's worth — not a line per sub-step. */
/** One step done or moved on the shift, on its own line: when (the time
 *  punched for it), its WO when the task has more than one, its comment. */
export interface DoneLine { id: string; name: string; time?: number; wo?: string; note?: string;
  /** Was on the critical path when the shift began. */
  critical?: boolean;
  /** Discovery or added scope (lib/discovery): the word for it. */
  discovery?: string }

// ── The critical path on the report's rows — the screen and the email read
// these, so they say the same. ────────────────────────────────────────────

/** A step's place against the critical path, in a few words: near it (a
 *  shift or less of float), or trending to it — lost 4 h or more of float
 *  this shift with two shifts or less left. Critical itself is its own red
 *  tag. */
export function pathNote(r: ShiftRow, hrs: (h: number) => string): string | null {
  if (r.critical || r.floatH == null) return null;
  const lost = r.floatThenH != null && r.floatThenH - r.floatH >= 4 && r.floatH <= 24;
  const drop = lost ? `float ${hrs(r.floatThenH!)} → ${hrs(r.floatH)} this shift` : null;
  if (r.near) return `near critical — ${drop ?? `${hrs(r.floatH)} of float`}`;
  return drop ? `trending to critical — ${drop}` : null;
}

/** On the next crew's list: work that needs the same crew at the same time
 *  as critical work — the crew can't do both; the critical goes first. */
export function competition(report: ShiftReport, rows: ShiftRow[]): Map<string, { crew: string; critical: ShiftRow[] }> {
  const out = new Map<string, { crew: string; critical: ShiftRow[] }>();
  const next = report.next;
  if (!next || !rows.some((r) => r.critical)) return out;
  const win = (r: ShiftRow) => [Math.max(r.reflowed ? r.crewStart : r.start, next.start), Math.min(r.reflowed ? r.crewFinish : r.finish, next.end)] as const;
  const crit = rows.filter((r) => r.critical && !isHeld(r));
  for (const r of rows) {
    if (r.critical || isHeld(r) || !r.leaf.id) continue;
    const crew = whoOf(r);
    const [a, b] = win(r);
    // Carried-over work runs from the start of the shift.
    const hits = crit.filter((c) => whoOf(c) === crew && (() => { const [x, y] = win(c); return Math.max(a, x) < Math.min(b, y) || (r.carryOver && c.carryOver); })());
    if (hits.length) out.set(r.leaf.id, { crew, critical: hits });
  }
  return out;
}

export function doneByTask(report: ShiftReport, plan: TurnoverPlan, t: Fmt, noteOf?: (id: string) => string | undefined, o: {
  /** When the step was done, or moved last, on the shift. */
  timeOf?: (id: string) => number | undefined;
  /** Where the whole task stands: % done, and % planned by now. */
  taskPct?: (taskId: string) => { pct: number; plan?: number } | undefined;
  /** Why a step is behind, as said for the report. */
  whyOf?: (id: string) => string | undefined;
  /** How many steps the task has in all (not cancelled). */
  stepCount?: (taskId: string) => number | undefined;
} = {}): Array<{
  task: string; wo: string; steps: string; who: string; result: { text: string; tone: NextTone }; vs: { text: string; tone?: "emerald" | "rose" }; ids: string[];
  /** "3 done", "2 done, 1 in progress" — then a line per step. */
  head: string; lines: DoneLine[];
  /** The step done last on the shift (or moved last, when none was done). */
  last: DoneLine;
  /** "2 of 5 steps done", ", 1 in progress" — what the shift did to the task. */
  count: string;
  taskPct?: { pct: number; plan?: number };
  /** Why it's behind — the steps behind that have a reason given. */
  why?: string;
  key: string;
  /** Some of its work this shift was on the critical path. */
  critical: boolean;
}> {
  const groups = new Map<string, ShiftRow[]>();
  for (const r of [...plan.done, ...plan.moved]) {
    const k = r.parentId ?? `solo:${r.leaf.id ?? r.leaf.name}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  // Critical work leads (it was on the path when the shift began); a
  // dragged order still wins.
  const onPath = (rows: ShiftRow[]) => rows.some((r) => r.wasCritical || r.critical);
  const usual = [...groups.entries()].sort((a, b) => Number(onPath(b[1])) - Number(onPath(a[1])));
  return inOrder(usual, ([k]) => k, plan.order?.done).map(([key, rows]) => {
    const done = rows.filter((r) => r.percent >= 100);
    const moved = rows.filter((r) => r.percent < 100);
    const late = done.filter((r) => !r.plannedLater && r.dueAt < report.shift.start);
    // Still going and short of where the plan has it by now: the count reads amber.
    const behind = moved.filter((r) => !r.plannedLater && r.percent < r.expectedPct - 2);
    // Every step's hours ahead or behind, the ones still going too (they
    // show again on their own row below — this is the task's account).
    let net = 0;
    for (const r of rows) { const sh = shareOf(report, r.leaf.id); if (sh) net += sh.side === "ahead" ? sh.hours : -sh.hours; }
    const h = t.hrs(Math.round(Math.abs(net) * 10) / 10);
    const who = [...new Set(rows.map((r) => r.leaf.responsibleParty?.trim()).filter(Boolean))].join(", ");
    const wos = [...new Set(rows.map((r) => r.leaf.workOrderRef?.trim()).filter(Boolean))];
    const head = `${done.length ? `${done.length} done` : ""}${done.length && moved.length ? ", " : ""}${moved.length ? `${moved.length} in progress` : ""}`;
    const lines: DoneLine[] = [...done, ...moved].map((r) => {
      const id = r.leaf.id ?? r.leaf.name;
      return {
        id, name: r.percent < 100 ? `${r.leaf.name} (${r.percent}%)` : r.leaf.name,
        time: r.leaf.id ? o.timeOf?.(r.leaf.id) : undefined,
        // Its WO in front only when the task has several.
        wo: wos.length > 1 ? r.leaf.workOrderRef?.trim() || undefined : undefined,
        note: r.leaf.id ? noteOf?.(r.leaf.id) : undefined,
        critical: r.wasCritical || r.critical || undefined,
        discovery: discoveryOf(r.leaf) ? ADDED[kindOf(discoveryOf(r.leaf))].lower : undefined,
      };
    });
    // The one step the table shows: the last done (by when), else the last moved.
    const when = (l: DoneLine, r: ShiftRow) => l.time ?? (r.leaf.actualAt ? Date.parse(String(r.leaf.actualAt)) : -Infinity);
    const pick = (rs: ShiftRow[], off: number) => rs.reduce<{ l: DoneLine; t: number } | null>((best, r, i) => {
      const l = lines[off + i], t = when(l, r);
      return !best || t >= best.t ? { l, t } : best;
    }, null);
    const last = (pick(done, 0) ?? pick(moved, done.length))!.l;
    const total = rows[0].parentId ? o.stepCount?.(rows[0].parentId) : undefined;
    const count = `${done.length}${total ? ` of ${total}` : ""} step${(total ?? done.length) === 1 ? "" : "s"} done${moved.length ? `, ${moved.length} in progress` : ""}`;
    // Why it's behind: the steps behind plan that have a reason given.
    const whys = rows.filter((r) => r.leaf.id && shareOf(report, r.leaf.id)?.side === "behind")
      .map((r) => ({ r, w: o.whyOf?.(r.leaf.id!)?.trim() })).filter((x) => x.w);
    const why = whys.length === 1 ? whys[0].w : whys.length ? whys.map((x) => `${x.r.leaf.name}: ${x.w}`).join("; ") : undefined;
    const parentId = rows[0].parentId;
    return {
      head, lines, last, count, why: why || undefined,
      critical: onPath(rows),
      taskPct: parentId ? o.taskPct?.(parentId) : undefined,
      task: rows[0].parentName ?? rows[0].leaf.name,
      // The work order number(s) — one for most work orders.
      wo: [...new Set(rows.map((r) => r.leaf.workOrderRef?.trim()).filter(Boolean))].join(", "),
      // The last step, as the table shows it.
      steps: `${last.name}${last.note ? ` “${last.note}”` : ""}`,
      who,
      // What it means: how many of the task's steps the shift got done.
      result: { text: count, tone: late.length || behind.length ? "amber" : "emerald" },
      vs: Math.abs(net) < 0.1 ? { text: "" } : net > 0 ? { text: `+${h}`, tone: "emerald" } : { text: `−${h}`, tone: "rose" },
      ids: rows.map((r) => r.leaf.id ?? r.leaf.name),
      /** The task's place in the table — what a dragged order keeps. */
      key,
    };
  });
}

/** Behind by this much or more — most of a shift — it shows red. */
export const SEVERE_BEHIND_H = 8;

/** The next shift's list in a few lines, for the five-second read: what's
 *  badly behind (and what waits on it), what's carried over from earlier
 *  shifts (and what it waits on), how much is critical. */
export function watchLines(rows: ShiftRow[], report: ShiftReport, t: { hrs: (h: number) => string }, numOf: (id: string | null | undefined) => number | undefined): Array<{ tone: "rose" | "amber" | "slate"; strong: string; rest?: string }> {
  const out: Array<{ tone: "rose" | "amber" | "slate"; strong: string; rest?: string }> = [];
  const label = (r: ShiftRow) => { const tag = equipmentTag(r.parentName, r.leaf.name); return tag && !r.leaf.name.startsWith(tag) ? `${tag} ${r.leaf.name}` : r.leaf.name; };
  const listed = new Set(rows.map((r) => r.leaf.id));
  const h = (x: number) => t.hrs(Math.round(x * 10) / 10);
  const and = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
  // Badly behind — and the steps on the list that can't start until it's done.
  const severe = rows.map((r) => ({ r, s: shareOf(report, r.leaf.id) })).filter((x) => x.s?.side === "behind" && x.s.hours >= SEVERE_BEHIND_H)
    .sort((a, b) => b.s!.hours - a.s!.hours).slice(0, 2);
  for (const { r, s } of severe) {
    const after = rows.filter((x) => x.waitingOn.some((w) => w.id === r.leaf.id));
    const crit = after.some((x) => x.critical) ? ", and it's on the critical path" : "";
    // Hours of its work, not hours late — and what it's waiting on, if anything.
    const of = r.hours > 0 ? ` of ${h(r.hours)}` : "";
    const waits = r.waitingOn.length ? ` (waiting on ${r.waitingOn[0].name}${r.waitingOn.length > 1 ? ` +${r.waitingOn.length - 1}` : ""})` : "";
    out.push({ tone: "rose", strong: `${label(r)} is ${h(s!.hours)}${of} behind${waits}`, rest: after.length ? ` — ${and(after.map((x) => x.leaf.name))} can't start until it's done${crit}.` : "." });
  }
  // Carried over from earlier shifts — and what they wait on that isn't on this list.
  const carried = rows.filter((r) => r.carryOver);
  if (carried.length) {
    const waits = carried.filter((r) => r.waitingOn.some((w) => !listed.has(w.id)));
    const names = [...new Set(waits.flatMap((r) => r.waitingOn.filter((w) => !listed.has(w.id)).map((w) => w.name)))];
    const who = waits.length === carried.length ? (carried.length === 1 ? "it waits" : carried.length === 2 ? "both wait" : "all wait") : `${waits.length} wait`;
    out.push({ tone: "amber", strong: `${carried.length} carried over from earlier shifts`,
      rest: waits.length ? ` — ${who} on steps not on this list (${names.slice(0, 3).join(", ")}${names.length > 3 ? ` + ${names.length - 3} more` : ""}).` : ` — ${and(carried.slice(0, 3).map(label))}.` });
  }
  const crit = rows.filter((r) => r.critical);
  if (crit.length) {
    const nums = crit.map((r) => numOf(r.leaf.id)).filter((n): n is number => n != null);
    out.push({ tone: "slate", strong: `${crit.length} of ${rows.length} step${rows.length === 1 ? "" : "s"} ${crit.length === 1 ? "is" : "are"} critical`, rest: nums.length ? ` — #${nums.join(", #")}.` : "." });
  }
  // Near the path, or losing float fast.
  const near = rows.filter((r) => pathNote(r, h));
  if (near.length) {
    out.push({ tone: "amber", strong: `${near.length} near the critical path`, rest: ` — ${and(near.slice(0, 3).map((r) => `${numOf(r.leaf.id) ? `#${numOf(r.leaf.id)} ` : ""}${label(r)} (${r.floatH != null ? `${h(r.floatH)} float` : "?"})`))}${near.length > 3 ? ` + ${near.length - 3} more` : ""}.` });
  }
  // The same crew wanted on critical work and on other work at once.
  const comp = competition(report, rows);
  const byCrew = new Map<string, { crit: Set<ShiftRow>; other: ShiftRow[] }>();
  for (const r of rows) {
    const c = r.leaf.id ? comp.get(r.leaf.id) : undefined;
    if (!c) continue;
    const e = byCrew.get(c.crew) ?? { crit: new Set<ShiftRow>(), other: [] };
    c.critical.forEach((x) => e.crit.add(x)); e.other.push(r);
    byCrew.set(c.crew, e);
  }
  for (const [crew, e] of byCrew) {
    const cr = [...e.crit].map((r) => `${numOf(r.leaf.id) ? `#${numOf(r.leaf.id)} ` : ""}${r.leaf.name}`);
    out.push({ tone: "amber", strong: `${crew} is on critical work and ${e.other.length} other step${e.other.length === 1 ? "" : "s"}`,
      rest: ` — ${and(cr.slice(0, 2))} first; ${and(e.other.slice(0, 3).map((r) => `${numOf(r.leaf.id) ? `#${numOf(r.leaf.id)} ` : ""}${r.leaf.name}`))} after${e.other.length > 3 ? ` (+${e.other.length - 3} more)` : ""}.` });
  }
  return out;
}
