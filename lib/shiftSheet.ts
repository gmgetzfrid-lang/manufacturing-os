// shiftSheet - the shift sheet: one page for the field, printed at the
// shift's start meeting, with only the work for that shift. Walk up to E-12
// and E-12 is on the page, big, in WO number order.
//
// Its lines are the turnover's list for the shift (lib/shiftReport), so the
// sheet and the meeting say the same:
//   late    carried over: due before the shift and not started
//   going   started before the shift (started ahead of plan too: the plan
//           changes, crews jump ahead)
//   due     planned in the shift
//   pulled  pulled forward at the meeting
//   try     the other crew's work the meeting asked this shift to try
//   early   ready to start early (its steps before are done or due this
//           shift): written on when a crew jumps ahead
// Held work isn't on it (it can't be worked). Work that isn't listed is
// written on the blank lines at the bottom.
//
// Filled in by pen, left to right as the shift goes: Start time, % at lunch,
// % at the end of the shift, Done time, Notes. Times only: the date is on
// top. What's written goes back in on the shift sheet entry screen
// (components/projects/ShiftSheetEntry), line for line.
//
// Plain HTML with its own styles, letter portrait, for a print window. The
// pages are laid out here so each says "Page 1 of 2" and a work order that
// runs onto the next page says so there.

import type { Milestone } from "@/types/schema";
import type { ProgressInfo } from "@/lib/scheduleProgress";
import { leafPercent } from "@/lib/scheduleProgress";
import {
  buildShiftReport, previousShift, meetingLeadMin, timeInShift,
  type ShiftReport, type ShiftRow, type ShiftTimes, type ShiftWindow,
} from "@/lib/shiftReport";
import { woOf } from "@/lib/workOrderCrew";
import { startMsOf } from "@/lib/calendarPlacement";

export type SheetKind = "late" | "going" | "due" | "pulled" | "try" | "early";

export interface SheetLine {
  id: string;
  name: string;
  crew: string;
  kind: SheetKind;
  /** Started before the shift: nothing to write in Start. */
  started: boolean;
  planStart: number;
  planFinish: number;
  /** When its crew is due to be done with it. */
  dueAt: number;
  critical: boolean;
}

export interface SheetGroup {
  key: string;
  wo: string | null;
  /** The work order's task ("E-12 - Transmix Feed/Trans. Diesel Exchanger No. 2"). */
  name: string;
  /** Its equipment tag, when the name starts with one ("E-12"). */
  tag: string | null;
  /** The rest of the name ("Transmix Feed/Trans. Diesel Exchanger No. 2"). */
  rest: string;
  lines: SheetLine[];
}

export interface ShiftSheet { shift: ShiftWindow; groups: SheetGroup[]; count: number }

/** "E-12 - Transmix Feed..." → E-12 and the rest; "UIT-013 - Corilois
 *  Meter" → UIT-013; a name with no tag up front → null. */
export function splitTag(name: string): { tag: string | null; rest: string } {
  const m = /^\s*([A-Z]{1,5}-?\d{1,4}[A-Z]?(?:\/[A-Z])?)\s*[-–:]\s*(.+)$/.exec(name);
  return m ? { tag: m[1], rest: m[2].trim() } : { tag: null, rest: name.trim() };
}

const held = (m: Milestone) => m.status === "blocked" || m.status === "on_hold";
const DONE = (r: ShiftRow) => r.status === "completed" || r.percent >= 100;
const startedRow = (r: ShiftRow) => r.status === "in_progress" || r.percent > 0;

/** The shift's lines, from the turnover's report on the shift before it
 *  (its goals are this shift's). `tryIds`: the other crew's work the
 *  meeting asked this shift to try. */
export function sheetLines(report: ShiftReport, tryIds?: Set<string>): SheetLine[] {
  const target = report.next;
  const out: SheetLine[] = [];
  const seen = new Set<string>();
  const add = (r: ShiftRow, kind: SheetKind) => {
    const id = r.leaf.id;
    if (!id || seen.has(id) || held(r.leaf) || DONE(r)) return;
    seen.add(id);
    const started = startedRow(r);
    out.push({
      id, name: r.leaf.name, crew: r.leaf.responsibleParty?.trim() ?? "",
      kind: started && (kind === "due" || kind === "late") ? "going" : kind,
      started, planStart: r.start, planFinish: r.finish, dueAt: r.dueAt, critical: r.critical,
    });
  };
  for (const r of report.goals.all) add(r, r.carryOver ? "late" : "due");
  for (const r of report.goals.pulled) add(r, "pulled");
  if (tryIds?.size) for (const r of [...report.goals.otherShift, ...report.goals.movedOff, ...report.goals.paused]) if (r.leaf.id && tryIds.has(r.leaf.id)) add(r, "try");
  // Under way and this crew's, wherever the plan has it: a job started
  // ahead of plan is still being worked.
  for (const r of report.review.inProgress) if (r.work === "both" || r.work === target.kind) add(r, "going");
  for (const r of report.goals.stretch) add(r, "early");
  return out;
}

/** The lines by work order: WO number order (numbers as numbers), work with
 *  no WO last; in each, by plan, the ones that could start early last. */
export function groupSheet(lines: SheetLine[], milestones: Milestone[]): SheetGroup[] {
  const byId = new Map(milestones.filter((m) => m.id).map((m) => [m.id!, m]));
  // Its work order: the WO number (its own, or the nearest above), and the
  // highest task carrying that number (the equipment's), not the step a
  // copied-down number sits on.
  const groupOf = (id: string): { key: string; wo: string | null; owner: Milestone } | null => {
    const m = byId.get(id);
    if (!m) return null;
    let wo = "", at: Milestone | undefined = m;
    const seen = new Set<string>();
    for (; at?.id && !seen.has(at.id); at = at.parentId ? byId.get(at.parentId) : undefined) { seen.add(at.id); wo = woOf(at); if (wo) break; }
    let owner = wo && at ? at : (m.parentId ? byId.get(m.parentId) : undefined) ?? m;
    if (wo) for (let up = owner.parentId ? byId.get(owner.parentId) : undefined; up?.id && !seen.has(up.id) && woOf(up) === wo; up = up.parentId ? byId.get(up.parentId) : undefined) { seen.add(up.id); owner = up; }
    return { key: `${wo || "-"}:${owner.id}`, wo: wo || null, owner };
  };
  const groups = new Map<string, SheetGroup>();
  for (const l of lines) {
    const g = groupOf(l.id);
    const key = g?.key ?? `-:${l.id}`;
    const name = g?.owner.name ?? l.name;
    const cur = groups.get(key) ?? { key, wo: g?.wo ?? null, name, ...splitTag(name), lines: [] };
    cur.lines.push(l);
    groups.set(key, cur);
  }
  const first = (g: SheetGroup) => Math.min(...g.lines.map((l) => l.planStart));
  const list = [...groups.values()];
  for (const g of list) g.lines.sort((a, b) => Number(a.kind === "early") - Number(b.kind === "early") || a.planStart - b.planStart || a.name.localeCompare(b.name));
  return list.sort((a, b) => (a.wo ? 0 : 1) - (b.wo ? 0 : 1)
    || (a.wo && b.wo ? a.wo.localeCompare(b.wo, "en", { numeric: true }) : 0)
    || first(a) - first(b) || a.name.localeCompare(b.name));
}

/** The sheet for a shift: the turnover's report on the shift before it,
 *  as of its meeting (or now, when that's later). */
export function buildShiftSheet(input: {
  milestones: Milestone[]; progress?: Map<string, ProgressInfo>; criticalIds?: Set<string>;
  tz: string; times: ShiftTimes; target: ShiftWindow; now: number;
  /** Pulled forward for this shift at the meeting (its turnover's decisions). */
  pullIds?: Iterable<string>;
  tryIds?: Set<string>;
}): ShiftSheet {
  const { milestones, tz, times, target } = input;
  const prev = previousShift(target, tz, times);
  const meetingAt = prev.end - meetingLeadMin(times) * 60_000;
  const report = buildShiftReport({ milestones, progress: input.progress, criticalIds: input.criticalIds, tz, times, shift: prev, now: Math.max(input.now, meetingAt), pullIds: input.pullIds });
  const groups = groupSheet(sheetLines(report, input.tryIds), milestones);
  return { shift: target, groups, count: groups.reduce((n, g) => n + g.lines.length, 0) };
}

/** The sheet as printed, saved on the shift's record: the entry screen
 *  shows the same lines in the same order. */
export interface SheetRecord { ids: string[]; printedAt: number; by?: string | null }
export const sheetIds = (s: ShiftSheet) => s.groups.flatMap((g) => g.lines.map((l) => l.id));

/** The lines for entering a shift's sheet: the ones printed (in that
 *  order), else the sheet as it would print now plus anything started or
 *  finished during the shift. Lines whose step is gone are dropped. */
export function entryLines(input: {
  milestones: Milestone[]; progress?: Map<string, ProgressInfo>; criticalIds?: Set<string>;
  tz: string; times: ShiftTimes; target: ShiftWindow; now: number;
  printed?: SheetRecord | null; pullIds?: Iterable<string>; tryIds?: Set<string>;
}): SheetGroup[] {
  const { milestones, target } = input;
  const byId = new Map(milestones.filter((m) => m.id).map((m) => [m.id!, m]));
  const pctOf = (m: Milestone) => (m.id ? input.progress?.get(m.id)?.percent : undefined) ?? leafPercent(m);
  const lineOf = (m: Milestone, kind: SheetKind): SheetLine => ({
    id: m.id!, name: m.name, crew: m.responsibleParty?.trim() ?? "", kind, started: m.status === "in_progress" || pctOf(m) > 0 || m.status === "completed",
    planStart: startMsOf(m), planFinish: Date.parse(String(m.plannedAt)), dueAt: Date.parse(String(m.plannedAt)), critical: false,
  });
  if (input.printed?.ids.length) {
    const lines = input.printed.ids.map((id) => byId.get(id)).filter((m): m is Milestone => !!m).map((m) => lineOf(m, "due"));
    // Printed order kept: group in the order the ids came.
    const grouped = groupSheet(lines, milestones);
    const pos = new Map(input.printed.ids.map((id, i) => [id, i]));
    for (const g of grouped) g.lines.sort((a, b) => (pos.get(a.id) ?? 0) - (pos.get(b.id) ?? 0));
    return grouped.sort((a, b) => (pos.get(a.lines[0].id) ?? 0) - (pos.get(b.lines[0].id) ?? 0));
  }
  const sheet = buildShiftSheet({ ...input, now: Math.min(input.now, target.start) });
  const listed = new Set(sheetIds(sheet));
  const inShift = (v: unknown) => { const t = v == null ? NaN : Date.parse(String(v)); return Number.isFinite(t) && t >= target.start && t < target.end; };
  const extra = milestones.filter((m) => m.id && !listed.has(m.id) && (inShift(m.actualStartAt) || inShift(m.actualAt))).map((m) => lineOf(m, "going"));
  if (!extra.length) return sheet.groups;
  return groupSheet([...sheet.groups.flatMap((g) => g.lines), ...extra], milestones);
}

// ── When what's written happened ──

/** The times a sheet's columns stand for: lunch (the shift's lunch break,
 *  else the middle of the shift) and the end of the shift (its turnover
 *  meeting, where the % is reported). */
export function sheetTimes(target: ShiftWindow, times: ShiftTimes, tz: string): { lunch: number; end: number; lunchLabel: string; lunchName: string } {
  const lunch = (times.breaks ?? []).find((b) => b.shift === target.kind && /lunch|dinner|meal/i.test(b.label));
  const at = lunch ? timeInShift(target, lunch.start, tz) : null;
  return {
    lunch: at ?? Math.round((target.start + target.end) / 2),
    end: target.end - meetingLeadMin(times) * 60_000,
    lunchLabel: lunch ? `% at ${lunch.label.toLowerCase()}` : "% mid-shift",
    lunchName: lunch ? lunch.label.toLowerCase() : "mid-shift",
  };
}

/** One line as written on the sheet. Times "HH:MM" (24-hour, as a time
 *  input gives them); % as typed. */
export interface SheetEntry {
  start?: string;
  lunchPct?: string;
  endPct?: string;
  done?: string;
  hold?: boolean;
  note?: string;
}

export type SheetEvent =
  | { kind: "start"; at: number }
  | { kind: "pct"; at: number; pct: number }
  | { kind: "done"; at: number }
  | { kind: "hold"; at: number; reason: string }
  | { kind: "note"; at: number; text: string };

const pctOfText = (s?: string): number | null => {
  const t = (s ?? "").replace("%", "").trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? Math.round(n) : NaN;
};

/** What a line's entry means, in time order, or why it can't be saved.
 *  `started`: the step was started before (Start is ignored). Times later
 *  than `now` are put at now (entered during the shift). */
export function planEntry(e: SheetEntry, ctx: { target: ShiftWindow; tz: string; times: ShiftTimes; now: number; started: boolean; currentPct: number }): { events: SheetEvent[]; error?: string } {
  const { target, tz } = ctx;
  const at = sheetTimes(target, ctx.times, tz);
  const clamp = (t: number) => Math.min(t, ctx.now);
  const clock = (s: string | undefined, what: string): number | null | string => {
    if (!s?.trim()) return null;
    const t = timeInShift(target, s.trim(), tz);
    return t == null ? `${what} isn't in this shift - check the time and AM or PM.` : t;
  };
  const start = ctx.started ? null : clock(e.start, "The start time");
  const done = clock(e.done, "The done time");
  if (typeof start === "string") return { events: [], error: start };
  if (typeof done === "string") return { events: [], error: done };
  const lunch = pctOfText(e.lunchPct), end = pctOfText(e.endPct);
  for (const p of [lunch, end]) if (p != null && (Number.isNaN(p) || p < 0 || p > 100)) return { events: [], error: "A % is a number from 0 to 100." };
  if (lunch != null && end != null && end < lunch) return { events: [], error: "The end of shift % is less than the lunch %." };
  if (start != null && done != null && done < start) return { events: [], error: "Done is before the start - check AM or PM." };
  const events: SheetEvent[] = [];
  if (start != null) events.push({ kind: "start", at: clamp(start) });
  // A % of 100 is done: at the time written, else when it was reported.
  const doneAt = done ?? (end === 100 ? at.end : lunch === 100 ? at.lunch : null);
  if (lunch != null && lunch > 0 && lunch < 100 && (doneAt == null || at.lunch < doneAt)) events.push({ kind: "pct", at: clamp(at.lunch), pct: lunch });
  if (end != null && end > 0 && end < 100 && (doneAt == null || at.end < doneAt)) events.push({ kind: "pct", at: clamp(at.end), pct: end });
  if (doneAt != null) events.push({ kind: "done", at: clamp(doneAt) });
  // % that goes backwards from where the step already is isn't saved over it.
  const firstPct = events.find((x) => x.kind === "pct") as { pct: number } | undefined;
  if (firstPct && firstPct.pct < ctx.currentPct && !events.some((x) => x.kind === "done")) return { events: [], error: `It's at ${ctx.currentPct}% already - fix it in the step's history if that's wrong.` };
  const last = events.length ? events[events.length - 1].at : clamp(at.end);
  const note = e.note?.trim() ?? "";
  if (e.hold && doneAt == null) events.push({ kind: "hold", at: last, reason: note || "Held" });
  else if (note) events.push({ kind: "note", at: last, text: note });
  events.sort((a, b) => a.at - b.at);
  return { events };
}

// ── The printed sheet ──

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const timeOf = (t: number, tz: string) => new Date(t).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: tz }).replace(":00 ", " ");
const dayTime = (t: number, tz: string) => `${new Date(t).toLocaleDateString("en-US", { weekday: "short", timeZone: tz })} ${timeOf(t, tz)}`;

/** The plan, as it reads on the sheet: times inside the shift alone, the
 *  day with anything outside it ("10 AM to Wed 4 AM"); a late one, when it
 *  was due; one that could start early, when it's planned. */
export function planWords(l: SheetLine, shift: ShiftWindow, tz: string): string {
  const at = (t: number) => (t >= shift.start && t <= shift.end ? timeOf(t, tz) : dayTime(t, tz));
  if (!Number.isFinite(l.planStart) || !Number.isFinite(l.planFinish)) return "";
  if (l.kind === "late" || (l.kind === "going" && l.dueAt <= shift.start)) return `due ${dayTime(l.dueAt, tz)}`;
  if (l.kind === "early") return `planned ${dayTime(l.planStart, tz)}`;
  return `${at(l.planStart)} to ${at(l.planFinish)}`;
}

const TAG: Partial<Record<SheetKind, string>> = { pulled: "pulled ahead", try: "try it", early: "could start early" };

// Page sizes, in inches (letter portrait, .3in margins top and sides,
// .25in at the foot).
const P = { page: 10.28, head: 0.56, how: 0.2, th: 0.3, row: 0.3, row2: 0.44, groupMin: 0.36, addHead: 0.24, addRow: 0.3 };
const stepWidth = 0.29 * 7.9 - 0.12;
const charW = (s: string, pt: number) => s.length * pt * 0.56 / 72;
const lineH = (l: SheetLine) => (charW(l.name, 8.5) > stepWidth ? P.row2 : P.row);

export const SHEET_CSS = `
@page{size:letter portrait;margin:.3in .3in .25in}
*{box-sizing:border-box}
body{margin:0;background:#fff;-webkit-print-color-adjust:exact;print-color-adjust:exact}
@media screen{body.ssdoc{padding:.3in}.ss .pg{min-height:10.45in;border-bottom:1px dashed #cbd5e1;margin-bottom:.6in}}
.ss{font-family:Arial,Helvetica,sans-serif;color:#0f172a}
.ss .pg{break-after:page;page-break-after:always}
.ss .pg:last-child{break-after:auto;page-break-after:auto}
.ss .top{height:${P.head - 0.06}in;margin-bottom:.06in;display:flex;justify-content:space-between;align-items:flex-end;gap:12px;border-bottom:2px solid #0f172a;padding-bottom:4px}
.ss .top .s{font-size:17pt;font-weight:bold;white-space:nowrap}
.ss .top .p{font-size:9pt;color:#475569;text-align:right}
.ss .top .p b{color:#0f172a}
.ss .how{height:${P.how}in;font-size:8pt;color:#475569;overflow:hidden}
.ss table{width:100%;border-collapse:collapse;table-layout:fixed}
.ss th{height:${P.th}in;font-size:7pt;text-transform:uppercase;letter-spacing:.2px;color:#334155;background:#f1f5f9;border:1px solid #94a3b8;padding:1px 3px;text-align:center;line-height:1.15}
.ss th.l{text-align:left}
.ss td{border:1px solid #94a3b8;padding:1px 4px;font-size:8.5pt;vertical-align:middle;line-height:1.12}
.ss tr.last td{border-bottom:2px solid #0f172a}
.ss td.wo{vertical-align:top;padding:2px 4px;border-bottom:2px solid #0f172a;overflow:hidden}
.ss td.wo .tag{display:block;font-size:13pt;font-weight:bold;line-height:1}
.ss td.wo .tag.sm{font-size:10.5pt}
.ss td.wo .eqn{font-size:7pt;color:#334155;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:1px}
.ss td.wo .cont{font-size:7pt;color:#64748b;font-style:italic}
.ss td.st{overflow:hidden}
.ss td.st b{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;font-size:8.5pt}
.ss td.st .cr{font-size:7pt;color:#475569}
.ss td.st .k{font-size:6.5pt;font-weight:bold;text-transform:uppercase;letter-spacing:.3px;color:#475569;border:1px solid #94a3b8;border-radius:2px;padding:0 2px;margin-left:4px}
.ss td.pl{font-size:7.5pt;color:#334155}
.ss td.pl .late{color:#b91c1c;font-weight:bold}
.ss td.pl .cp{display:block;font-size:6.5pt;font-weight:bold;color:#b91c1c;text-transform:uppercase}
.ss tr.early td.st b,.ss tr.early td.pl{color:#64748b}
.ss td.bx{text-align:center}
.ss td.bx.on{background:#e2e8f0;color:#475569;font-size:7pt}
.ss td.pc{text-align:right;vertical-align:bottom;font-size:7pt;color:#94a3b8;padding-bottom:2px}
.ss tr.ah td{background:#f1f5f9;height:${P.addHead}in;font-size:8pt;color:#334155;border-top:2px solid #0f172a}
.ss tr.ah b{color:#0f172a;margin-right:4px}
.ss tr.add td{height:${P.addRow}in}
.ss .none{font-size:10pt;color:#475569;padding:14px 0}
`;

const COLS = `<colgroup><col style="width:15%"><col style="width:29%"><col style="width:12%"><col style="width:8%"><col style="width:8%"><col style="width:8%"><col style="width:8%"><col style="width:12%"></colgroup>`;

/** The sheet's pages, ready to print. */
export function shiftSheetHtml(sheet: ShiftSheet, o: { project: string; tz: string; times: ShiftTimes; addLines?: number }): string {
  const { tz } = o;
  const w = sheet.shift;
  const day = new Date(w.start).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: tz });
  const title = `${w.kind === "day" ? "Day" : "Night"} shift · ${day} · ${timeOf(w.start, tz)} to ${timeOf(w.end, tz)}`;
  const lunchLabel = sheetTimes(w, o.times, tz).lunchLabel;
  const thead = `<thead><tr><th class="l">Equipment</th><th class="l">Step · crew</th><th class="l">Plan</th><th>Start<br>time</th><th>${esc(lunchLabel.replace("% ", "% "))}</th><th>% end<br>of shift</th><th>Done<br>time</th><th class="l">Notes</th></tr></thead>`;
  const groupHead = (g: SheetGroup, cont: boolean, span: number, h: number) => `<td class="wo" rowspan="${span}" style="height:${h.toFixed(2)}in">${g.tag
    ? `<span class="tag">${esc(g.tag)}</span><div class="eqn">${esc(g.wo ? `WO ${g.wo}` : "No WO")} · ${esc(g.rest)}</div>`
    : `<span class="tag sm">${esc(g.wo ? `WO ${g.wo}` : "No WO")}</span><div class="eqn">${esc(g.rest)}</div>`}${cont ? `<div class="cont">continued</div>` : ""}</td>`;
  const lineHtml = (l: SheetLine) => {
    const plan = planWords(l, w, tz);
    const late = l.kind === "late" || (l.kind === "going" && l.dueAt <= w.start);
    return `<td class="st"><b>${esc(l.name)}</b><span class="cr">${esc(l.crew)}</span>${TAG[l.kind] ? `<span class="k">${TAG[l.kind]}</span>` : ""}</td>`
      + `<td class="pl">${late ? `<span class="late">${esc(plan)}</span>` : esc(plan)}${l.critical ? `<span class="cp">critical</span>` : ""}</td>`
      + `<td class="bx${l.started ? " on" : ""}">${l.started ? "going" : ""}</td><td class="pc">%</td><td class="pc">%</td><td class="bx"></td><td></td>`;
  };

  type Page = { rows: string[]; used: number };
  const pages: Page[] = [];
  const fresh = (first: boolean): Page => { const p = { rows: [] as string[], used: P.head + (first ? P.how : 0) + P.th }; pages.push(p); return p; };
  let pg = fresh(true);
  for (const g of sheet.groups) {
    const hs = g.lines.map(lineH);
    // A short work order stays on one page.
    const whole = Math.max(P.groupMin, hs.reduce((a, b) => a + b, 0));
    if (whole > P.page - pg.used && whole <= 3 && pg.rows.length) pg = fresh(false);
    let i = 0, cont = false;
    while (i < g.lines.length) {
      // As many of its lines as fit here.
      let n = 0, h = 0;
      while (i + n < g.lines.length && pg.used + Math.max(P.groupMin, h + hs[i + n]) <= P.page) { h += hs[i + n]; n++; }
      if (n === 0) { pg = fresh(false); continue; }
      const blockH = Math.max(P.groupMin, h);
      const extra = blockH - h;
      for (let k = 0; k < n; k++) {
        const l = g.lines[i + k];
        const rowH = hs[i + k] + (k === n - 1 ? extra : 0);
        pg.rows.push(`<tr class="${[k === n - 1 ? "last" : "", l.kind === "early" ? "early" : ""].filter(Boolean).join(" ")}" style="height:${rowH.toFixed(2)}in">${k === 0 ? groupHead(g, cont, n, blockH) : ""}${lineHtml(l)}</tr>`);
      }
      pg.used += blockH;
      i += n; cont = true;
      if (i < g.lines.length) pg = fresh(false);
    }
  }
  // Blank lines for work not on the sheet: the room left on the last page
  // (2 to 8 of them), else a few on a page of their own.
  const room = Math.floor((P.page - pg.used - P.addHead) / P.addRow);
  const addN = o.addLines != null ? Math.max(0, o.addLines) : room >= 2 ? Math.min(8, room) : 3;
  if (addN) {
    if (pg.used + P.addHead + P.addRow * addN > P.page) pg = fresh(false);
    pg.rows.push(`<tr class="ah"><td colspan="8"><b>Not on the sheet</b> write the equipment or WO, the step and the crew</td></tr>`);
    for (let k = 0; k < addN; k++) pg.rows.push(`<tr class="add"><td></td><td></td><td></td><td class="bx"></td><td class="pc">%</td><td class="pc">%</td><td class="bx"></td><td></td></tr>`);
    pg.used += P.addHead + P.addRow * addN;
  }
  const of = pages.length;
  const out = pages.map((p, i) => `<section class="pg"><div class="top"><div class="s">${esc(title)}</div><div class="p"><b>${esc(o.project)}</b><br>${sheet.count} job${sheet.count === 1 ? "" : "s"} · Page ${i + 1} of ${of}</div></div>`
    + (i === 0 ? `<div class="how">Times only: the date is on top. "going" = started before this shift. Held: write HOLD and why in Notes.</div>` : "")
    + `<table>${COLS}${thead}<tbody>${p.rows.join("")}</tbody></table>`
    + (i === 0 && sheet.count === 0 ? `<div class="none">Nothing planned for this shift. Write what's worked below.</div>` : "")
    + `</section>`);
  return `<div class="ss">${out.join("\n")}</div>`;
}

export const sheetPages = (html: string) => (html.match(/<section class="pg/g) ?? []).length;

/** The whole page, ready to print. */
export function shiftSheetDocument(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>${SHEET_CSS}</style></head><body class="ssdoc">${body}</body></html>`;
}

/** "Shift sheet - Day Tue Oct 27" for the print window's title. */
export function sheetTitle(w: ShiftWindow, tz: string): string {
  return `Shift sheet - ${w.kind === "day" ? "Day" : "Night"} ${new Date(w.start).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: tz })}`;
}
