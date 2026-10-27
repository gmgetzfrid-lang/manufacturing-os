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
import { equipmentTag } from "@/lib/safetyMoment";

export type NextKind = "next" | "try" | "carry" | "held";
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
  // Everything moved forward this shift but not finished — the shift gets
  // credit for it under Done, wherever it goes next.
  const moved = (review.knownStart ? review.progressed : review.ahead)
    .filter((r) => r.percent < 100 && !doneIds.has(r.leaf.id ?? r.leaf.name));
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
export function doneByTask(report: ShiftReport, plan: TurnoverPlan, t: Fmt, noteOf?: (id: string) => string | undefined): Array<{
  task: string; wo: string; steps: string; who: string; result: { text: string; tone: NextTone }; vs: { text: string; tone?: "emerald" | "rose" }; ids: string[];
}> {
  const groups = new Map<string, ShiftRow[]>();
  for (const r of [...plan.done, ...plan.moved]) {
    const k = r.parentId ?? `solo:${r.leaf.id ?? r.leaf.name}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  return [...groups.values()].map((rows) => {
    const done = rows.filter((r) => r.percent >= 100);
    const moved = rows.filter((r) => r.percent < 100);
    const early = done.filter((r) => r.plannedLater);
    const late = done.filter((r) => !r.plannedLater && r.dueAt < report.shift.start);
    const movedEarly = moved.filter((r) => r.plannedLater);
    const stepText = [
      ...done.map((r) => r.leaf.name),
      // Where it is now — one number, read at a glance.
      ...moved.map((r) => `${r.leaf.name} (${r.percent}%)`),
    ].map((txt, i) => { const r = [...done, ...moved][i]; const n = r.leaf.id ? noteOf?.(r.leaf.id) : undefined; return n ? `${txt} “${n}”` : txt; }).join(", ");
    const parts: string[] = [];
    const onPlan = done.length - early.length - late.length;
    if (onPlan > 0) parts.push(done.length === onPlan && !moved.length ? "done, on plan" : `${onPlan} done on plan`);
    if (early.length) parts.push(`${early.length} done early (planned ${t.DTs(Math.min(...early.map((r) => r.crewStart)))}${early.length > 1 ? " on" : ""})`);
    if (late.length) parts.push(`${late.length} done late (was due ${t.DTs(Math.min(...late.map((r) => r.dueAt)))})`);
    if (movedEarly.length) parts.push(`${movedEarly.length} started early (planned ${t.DTs(Math.min(...movedEarly.map((r) => r.crewStart)))}${movedEarly.length > 1 ? " on" : ""})`);
    if (moved.length - movedEarly.length) parts.push(`${moved.length - movedEarly.length} in progress`);
    // Hours count once: a step still on a list below has them on that row.
    const onList = new Set(plan.items.map((x) => x.r.leaf.id));
    let net = 0;
    for (const r of rows) { if (onList.has(r.leaf.id)) continue; const sh = shareOf(report, r.leaf.id); if (sh) net += sh.side === "ahead" ? sh.hours : -sh.hours; }
    const h = t.hrs(Math.round(Math.abs(net) * 10) / 10);
    const who = [...new Set(rows.map((r) => r.leaf.responsibleParty?.trim()).filter(Boolean))].join(", ");
    return {
      task: rows[0].parentName ?? rows[0].leaf.name,
      // The work order number(s) — one for most work orders.
      wo: [...new Set(rows.map((r) => r.leaf.workOrderRef?.trim()).filter(Boolean))].join(", "),
      steps: `${done.length ? `${done.length} done` : ""}${done.length && moved.length ? ", " : ""}${moved.length ? `${moved.length} in progress` : ""}: ${stepText}`,
      who,
      result: { text: parts.join("; "), tone: late.length ? "amber" : "emerald" },
      vs: Math.abs(net) < 0.1 ? { text: "" } : net > 0 ? { text: `+${h}`, tone: "emerald" } : { text: `−${h}`, tone: "rose" },
      ids: rows.map((r) => r.leaf.id ?? r.leaf.name),
    };
  });
}
