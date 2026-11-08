// phaseReport - how a phase did (or the whole project, phase by phase):
// progress against plan day by day, the finish, the hours, the work added,
// and its share of the money: the budget split by the phases' shares, what's
// committed and spent on it.
//
// Money by phase:
//   - a budget line kept for one phase is all that phase's; any other line
//     is split by the phases' shares (the AFE slider);
//   - spending goes where it was booked (the entry's phase), else its
//     line's phase, else the phase whose dates it falls in, else it's
//     split by the shares too.
//
// Pure, but for the HTML's look. Everything said comes from the data.

import type { Milestone } from "@/types/schema";
import { scheduleAt, type ProgressLogRow } from "@/lib/progressHistory";
import { phaseIndex, phaseOnDay, phaseAmount, phaseDates, type ProjectPhase } from "@/lib/projectPhases";
import { dayKey, wallClockToMs, fmtInTz } from "@/lib/scheduleTz";
import { workHours, expectedFraction, DEFAULT_SHIFT_TIMES, type ShiftTimes } from "@/lib/shiftReport";
import { noEmDash } from "@/lib/noEmDash";
import { discoveryOf } from "@/lib/discovery";

export interface CostLine { id: string; name: string; cost_type?: string | null; budget: number | null; phase_id?: string | null; status?: string | null }
export interface CostEntry { cost_account_id: string; entry_type: string; amount: number | null; entry_date: string | null; status?: string | null; phase_id?: string | null }

export interface PhaseStats {
  phase: ProjectPhase | null;
  steps: number;
  done: number;
  /** Planned hours of work. */
  hours: number;
  /** % complete now, and % planned by now (hours-weighted). */
  actualPct: number;
  plannedPct: number;
  plannedStart: number | null;
  plannedFinish: number | null;
  /** Every step done: when the last one finished. */
  finishedAt: number | null;
  /** Added after the plan (discovery and added scope): how many finds, their
   *  steps, and the hours of work as the schedule has it now. */
  added: { count: number; steps: number; hours: number };
  /** Day by day: % planned and % done by the end of each day (done: up to today). */
  days: Array<{ day: string; planned: number; actual: number | null }>;
  budget: number;
  committed: number;
  spent: number;
  lines: Array<{ name: string; budget: number; committed: number; spent: number }>;
}

const ms = (s: unknown) => { const t = typeof s === "string" ? Date.parse(s) : NaN; return Number.isFinite(t) ? t : null; };
const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 10 : 0);

/** The steps that are work: not a task over others, not a summary, not
 *  cancelled, with planned dates (the shift report's own rule, so the two
 *  agree on % planned and done). */
function leaves(ms0: Milestone[]): Milestone[] {
  const parents = new Set(ms0.map((m) => m.parentId).filter(Boolean) as string[]);
  return ms0.filter((m) => m.id && !parents.has(m.id) && !m.isSummary && !(m as { cancelledAt?: unknown }).cancelledAt
    && m.plannedAt && (ms(m.plannedStartAt) ?? ms(m.plannedAt)) != null);
}

/** One phase's numbers (phase null: the whole project). */
export function phaseStats(input: {
  milestones: Milestone[]; phases: ProjectPhase[]; phase: ProjectPhase | null;
  log: ProgressLogRow[] | null; tz: string; now: number;
  /** The shift times: the plan earns progress only while the crew is on shift. */
  times?: ShiftTimes;
  /** The AFE (else the lines' total) to split by the shares. */
  total: number | null;
  lines: CostLine[]; entries: CostEntry[];
}): PhaseStats {
  const { phases, phase, tz, now } = input;
  const times = input.times ?? DEFAULT_SHIFT_TIMES;
  // Weighed by hours of work, as the shift report weighs them.
  const weight = (m: Milestone) => workHours(m, tz);
  const idx = phaseIndex(input.milestones, phases);
  const mine = phase ? input.milestones.filter((m) => m.id && idx.get(m.id) === phase.id) : input.milestones;
  const work = leaves(mine);
  const hours = work.reduce((a, m) => a + weight(m), 0);
  const doneOf = (m: Milestone) => m.status === "completed" || Number(m.percentComplete ?? 0) >= 100;
  const done = work.filter(doneOf);
  const earned = work.reduce((a, m) => a + weight(m) * (doneOf(m) ? 1 : Math.max(0, Math.min(100, Number(m.percentComplete ?? 0))) / 100), 0);
  const starts = work.map((m) => ms(m.plannedStartAt) ?? ms(m.plannedAt)).filter((x): x is number => x != null);
  const ends = work.map((m) => ms(m.plannedAt)).filter((x): x is number => x != null);
  const plannedAt = (t: number) => work.reduce((a, m) => a + weight(m) * expectedFraction(m, t, tz, times), 0);
  const finishes = done.map((m) => ms(m.actualAt)).filter((x): x is number => x != null);
  const finishedAt = work.length > 0 && done.length === work.length && finishes.length ? Math.max(...finishes) : null;

  // Day by day: planned, and done by the log (each step's % at the day's end).
  const days: PhaseStats["days"] = [];
  const first = phase?.start ?? (starts.length ? dayKey(Math.min(...starts), tz) : null);
  const lastPlan = ends.length ? dayKey(Math.max(...ends), tz) : null;
  const last = [phase?.end, lastPlan, finishedAt != null ? dayKey(finishedAt, tz) : null].filter((x): x is string => !!x).sort().pop() ?? null;
  if (first && last && work.length) {
    const ids = new Set(work.map((m) => m.id!));
    const hist = (input.log ?? []).filter((r) => ids.has(r.milestone_id)).sort((a, b) => (ms(a.at) ?? 0) - (ms(b.at) ?? 0));
    const today = dayKey(now, tz);
    const w = new Map(work.map((m) => [m.id!, weight(m)]));
    let d = first;
    for (let guard = 0; d <= last && guard < 120; guard++) {
      const [y, mo, dd] = d.split("-").map(Number);
      const end = wallClockToMs({ year: y, month: mo, day: dd + 1, hour: 0, minute: 0, second: 0 }, tz);
      let actual: number | null = null;
      // Today: where it stands now (the log is behind what's on the steps).
      if (d === today) actual = pct(earned, hours);
      else if (d < today) {
        // The job as it stood at the day's end, read the way the shift
        // report reads it (a finish back-dated before then counts as done).
        const then = scheduleAt(work, hist, end - 1).milestones;
        actual = pct(then.reduce((a, m) => a + (w.get(m.id!) ?? 0) * (m.status === "completed" ? 100 : Math.max(0, Math.min(100, Number(m.percentComplete ?? 0)))) / 100, 0), hours);
      }
      days.push({ day: d, planned: pct(plannedAt(end), hours), actual });
      const next = new Date(Date.UTC(y, mo - 1, dd + 1));
      d = next.toISOString().slice(0, 10);
    }
  }

  // Added after the plan: discovery and added scope.
  const addedSteps = work.filter((m) => !!discoveryOf(m));
  const finds = new Set(addedSteps.map((m) => discoveryOf(m)!.id));

  // Money.
  const shareOf = (p: ProjectPhase | null) => (p ? p.share : 100);
  const linePhaseShare = (l: CostLine) => (!phase ? 1 : l.phase_id ? (l.phase_id === phase.id ? 1 : 0) : shareOf(phase) / 100);
  const lineById = new Map(input.lines.map((l) => [l.id, l]));
  const entryShare = (e: CostEntry) => {
    if (!phase) return 1;
    const line = lineById.get(e.cost_account_id);
    const ph = e.phase_id || line?.phase_id || (e.entry_date ? phaseOnDay(e.entry_date.slice(0, 10), phases)?.id : null) || null;
    return ph ? (ph === phase.id ? 1 : 0) : shareOf(phase) / 100;
  };
  const lineRows = input.lines.filter((l) => l.status !== "closed").map((l) => {
    const es = input.entries.filter((e) => e.cost_account_id === l.id && e.status !== "void");
    const sum = (types: string[]) => es.filter((e) => types.includes(e.entry_type)).reduce((a, e) => a + Number(e.amount ?? 0) * entryShare(e), 0);
    return { name: l.name, budget: Math.round(Number(l.budget ?? 0) * linePhaseShare(l)), committed: Math.round(sum(["commitment"])), spent: Math.round(sum(["actual", "adjustment"])) };
  }).filter((r) => r.budget || r.committed || r.spent);
  const linesTotal = input.lines.reduce((a, l) => a + Number(l.budget ?? 0), 0);
  const budget = phase ? phaseAmount(input.total ?? linesTotal, phase.share) : Math.round(input.total ?? linesTotal);

  return {
    phase, steps: work.length, done: done.length, hours: Math.round(hours),
    actualPct: pct(earned, hours), plannedPct: pct(plannedAt(now), hours),
    plannedStart: starts.length ? Math.min(...starts) : null, plannedFinish: ends.length ? Math.max(...ends) : null, finishedAt,
    added: { count: finds.size, steps: addedSteps.length, hours: Math.round(addedSteps.reduce((a, m) => a + weight(m), 0)) },
    days, budget,
    committed: lineRows.reduce((a, r) => a + r.committed, 0), spent: lineRows.reduce((a, r) => a + r.spent, 0),
    lines: lineRows,
  };
}

// ─── The report (print, the screen's preview, email) ─────────────────────

const NAVY = "#000A72", INK = "#0f172a", MUTED = "#64748b", RULE = "#e2e8f0", GREEN = "#0f766e", RED = "#b91c1c", AMBER = "#b45309";
const FONT = "font-family:Lato,Calibri,Arial,sans-serif;";
const esc = (s: string) => noEmDash(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const money = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

/** A bar as table cells (shows in Outlook and Gmail, and prints). */
function bar(p: number, color: string, mark?: number): string {
  const w = Math.max(0, Math.min(100, Math.round(p)));
  const m = mark != null ? Math.max(0, Math.min(100, Math.round(mark))) : null;
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;"><tr>` +
    (w > 0 ? `<td width="${w}%" bgcolor="${color}" style="background-color:${color};height:10px;line-height:10px;font-size:0;${m != null && m <= w ? `border-right:2px solid ${INK};` : ""}">&nbsp;</td>` : "") +
    (w < 100 ? `<td bgcolor="#f1f5f9" style="background-color:#f1f5f9;height:10px;line-height:10px;font-size:0;${m != null && m > w ? `border-right:2px solid ${INK};` : ""}">&nbsp;</td>` : "") +
    `</tr></table>`;
}

function tile(label: string, value: string, sub: string, color = INK): string {
  return `<td style="${FONT}border:1px solid ${RULE};padding:8px 10px;vertical-align:top;" width="20%"><div style="font-size:9.5px;font-weight:bold;letter-spacing:.08em;text-transform:uppercase;color:${MUTED};">${esc(label)}</div>` +
    `<div style="font-size:19px;font-weight:bold;color:${color};margin-top:2px;">${esc(value)}</div><div style="font-size:11px;color:${MUTED};">${esc(sub)}</div></td>`;
}

const h2 = (t: string) => `<div style="${FONT}font-size:14px;font-weight:bold;color:${NAVY};margin:18px 0 6px;border-bottom:2px solid ${NAVY};padding-bottom:3px;">${esc(t)}</div>`;

/** One phase's section: numbers, progress day by day, money by line. */
export function phaseSectionHtml(s: PhaseStats, tz: string, now: number): string {
  const when = (t: number | null) => (t == null ? "-" : `${fmtInTz(t, tz, { weekday: "short", month: "short", day: "numeric" })} ${fmtInTz(t, tz, { hour: "numeric", minute: "2-digit", hour12: true })}`);
  const late = s.finishedAt != null && s.plannedFinish != null ? s.finishedAt - s.plannedFinish : null;
  const lateWords = late == null ? null : Math.abs(late) < 3_600_000 ? "on plan" : `${Math.round(Math.abs(late) / 3_600_000)} h ${late > 0 ? "late" : "early"}`;
  const gap = s.actualPct - s.plannedPct;
  const left = s.budget - s.spent;
  let html = `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;margin-top:6px;"><tr>` +
    tile("Complete", `${s.actualPct}%`, `plan by now ${s.plannedPct}%`, gap >= 0 ? GREEN : RED) +
    tile("Steps done", `${s.done} / ${s.steps}`, `${s.hours.toLocaleString("en-US")} h of planned work`) +
    tile(s.finishedAt != null ? "Finished" : "Planned finish", s.finishedAt != null ? when(s.finishedAt) : when(s.plannedFinish), s.finishedAt != null ? `${lateWords} (plan ${when(s.plannedFinish)})` : `started ${when(s.plannedStart)}`, late != null && late > 3_600_000 ? RED : INK) +
    tile("Budget", money(s.budget), `${money(s.spent)} spent · ${money(s.committed)} committed`) +
    tile(left >= 0 ? "Left" : "Over budget", money(Math.abs(left)), s.budget ? `${Math.round((s.spent / s.budget) * 100)}% of budget spent` : "no budget", left >= 0 ? GREEN : RED) +
    `</tr></table>`;
  if (s.added.count) html += `<div style="${FONT}font-size:12px;color:${AMBER};margin-top:6px;"><b>Added after the plan:</b> ${s.added.count} (${s.added.steps} step${s.added.steps === 1 ? "" : "s"}), ${s.added.hours} h of work (discovery and added scope).</div>`;

  if (s.days.length) {
    html += h2("Progress, planned and done, day by day");
    html += `<table cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;${FONT}font-size:11.5px;">` +
      `<tr><td style="color:${MUTED};padding:2px 6px 4px 0;" width="13%"></td><td style="color:${MUTED};padding:2px 0 4px;"><span style="color:#94a3b8;">■</span> Planned &nbsp; <span style="color:${GREEN};">■</span> Done</td><td width="16%"></td></tr>` +
      s.days.map((d) => {
        const [y, m, dd] = d.day.split("-").map(Number);
        const label = new Date(Date.UTC(y, m - 1, dd)).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
        return `<tr><td style="padding:3px 6px 3px 0;white-space:nowrap;color:${INK};">${esc(label)}</td><td style="padding:3px 0;">${bar(d.planned, "#94a3b8")}<div style="height:3px;font-size:0;line-height:0;">&nbsp;</div>${d.actual != null ? bar(d.actual, d.actual + 0.05 >= d.planned ? GREEN : RED) : `<div style="font-size:10px;color:${MUTED};">ahead</div>`}</td>` +
          `<td style="padding:3px 0 3px 8px;white-space:nowrap;text-align:right;color:${MUTED};">${d.planned}%${d.actual != null ? ` / <b style="color:${d.actual + 0.05 >= d.planned ? GREEN : RED};">${d.actual}%</b>` : ""}</td></tr>`;
      }).join("") + `</table>`;
  }

  if (s.lines.length) {
    html += h2("Money by budget line");
    html += `<table cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;${FONT}font-size:11.5px;">` +
      `<tr style="color:${MUTED};font-size:10px;text-transform:uppercase;letter-spacing:.06em;"><td style="padding:4px 6px 4px 0;border-bottom:1px solid ${RULE};">Line</td><td style="padding:4px 6px;border-bottom:1px solid ${RULE};" width="34%">Spent of budget</td><td style="padding:4px 6px;text-align:right;border-bottom:1px solid ${RULE};">Budget</td><td style="padding:4px 6px;text-align:right;border-bottom:1px solid ${RULE};">Committed</td><td style="padding:4px 0 4px 6px;text-align:right;border-bottom:1px solid ${RULE};">Spent</td></tr>` +
      s.lines.map((l) => {
        const over = l.budget > 0 && l.spent > l.budget;
        return `<tr><td style="padding:4px 6px 4px 0;border-bottom:1px solid ${RULE};">${esc(l.name)}</td><td style="padding:4px 6px;border-bottom:1px solid ${RULE};">${bar(l.budget ? (l.spent / l.budget) * 100 : 0, over ? RED : GREEN)}</td>` +
          `<td style="padding:4px 6px;text-align:right;border-bottom:1px solid ${RULE};">${money(l.budget)}</td><td style="padding:4px 6px;text-align:right;border-bottom:1px solid ${RULE};">${money(l.committed)}</td><td style="padding:4px 0 4px 6px;text-align:right;border-bottom:1px solid ${RULE};${over ? `color:${RED};font-weight:bold;` : ""}">${money(l.spent)}</td></tr>`;
      }).join("") + `</table>`;
  }
  void now;
  return html;
}

/** The phases side by side, and the whole project. */
export function rollupHtml(all: PhaseStats, each: PhaseStats[], tz: string): string {
  const d = (t: number | null) => (t == null ? "-" : fmtInTz(t, tz, { month: "short", day: "numeric" }));
  const row = (s: PhaseStats, total = false) => {
    const left = s.budget - s.spent;
    const st = total ? `font-weight:bold;border-top:2px solid ${INK};` : `border-bottom:1px solid ${RULE};`;
    return `<tr><td style="padding:5px 6px 5px 0;${st}">${esc(s.phase ? s.phase.name : "Whole project")}${s.phase ? `<div style="font-size:10.5px;color:${MUTED};">${esc(phaseDates(s.phase))}</div>` : ""}</td>` +
      `<td style="padding:5px 6px;${st}" width="22%">${bar(s.actualPct, s.actualPct + 0.05 >= s.plannedPct ? GREEN : RED, s.plannedPct)}<div style="font-size:10.5px;color:${MUTED};">${s.actualPct}% done · plan ${s.plannedPct}%</div></td>` +
      `<td style="padding:5px 6px;text-align:right;${st}">${s.done}/${s.steps}</td><td style="padding:5px 6px;text-align:right;${st}">${s.finishedAt != null ? `done ${d(s.finishedAt)}` : d(s.plannedFinish)}</td>` +
      `<td style="padding:5px 6px;text-align:right;${st}">${money(s.budget)}</td><td style="padding:5px 6px;text-align:right;${st}">${money(s.spent)}</td>` +
      `<td style="padding:5px 0 5px 6px;text-align:right;${st}color:${left >= 0 ? GREEN : RED};">${left >= 0 ? money(left) : `-${money(-left)}`}</td></tr>`;
  };
  return h2("Phases") + `<table cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;${FONT}font-size:12px;">` +
    `<tr style="color:${MUTED};font-size:10px;text-transform:uppercase;letter-spacing:.06em;"><td style="padding:4px 6px 4px 0;">Phase</td><td style="padding:4px 6px;">Progress</td><td style="padding:4px 6px;text-align:right;">Steps</td><td style="padding:4px 6px;text-align:right;">Finish</td><td style="padding:4px 6px;text-align:right;">Budget</td><td style="padding:4px 6px;text-align:right;">Spent</td><td style="padding:4px 0 4px 6px;text-align:right;">Left</td></tr>` +
    each.map((s) => row(s)).join("") + row(all, true) + `</table>`;
}

/** The whole report: the phase picked, or every phase and the project. */
export function phaseReportHtml(input: { project: string; tz: string; now: number; picked: PhaseStats | null; all: PhaseStats; each: PhaseStats[] }): string {
  const { picked, all, each, tz, now } = input;
  const title = picked?.phase ? `${picked.phase.name} phase report` : "Phase report";
  const sub = picked?.phase ? `${input.project} · ${phaseDates(picked.phase)} · ${picked.phase.share}% of the budget` : `${input.project} · ${each.length} phases`;
  let html = `<div style="${FONT}color:${INK};max-width:820px;">` +
    `<div style="border-top:4px solid ${NAVY};padding:10px 0 4px;"><div style="font-size:10px;font-weight:bold;letter-spacing:.12em;text-transform:uppercase;color:${MUTED};">Phase report</div>` +
    `<div style="font-size:20px;font-weight:bold;color:${NAVY};">${esc(title)}</div><div style="font-size:12px;color:${MUTED};">${esc(sub)} · as of ${esc(fmtInTz(now, tz, { month: "short", day: "numeric" }))} ${esc(fmtInTz(now, tz, { hour: "numeric", minute: "2-digit", hour12: true }))}</div></div>`;
  if (picked?.phase) {
    html += phaseSectionHtml(picked, tz, now);
    html += rollupHtml(all, each, tz);
  } else {
    html += rollupHtml(all, each, tz);
    html += h2("Whole project") + phaseSectionHtml(all, tz, now);
    for (const s of each) html += `<div style="page-break-before:always;"></div>` + h2(s.phase!.name) + phaseSectionHtml(s, tz, now);
  }
  return html + `</div>`;
}

/** As a page to print. */
export const phaseReportDocument = (title: string, body: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>@page{margin:12mm}body{margin:0;-webkit-print-color-adjust:exact;print-color-adjust:exact}@media screen{body{padding:16px}}</style></head><body>${body}</body></html>`;

/** As plain text (a mail app that won't take formatting). */
export function phaseReportText(input: { project: string; picked: PhaseStats | null; all: PhaseStats; each: PhaseStats[] }): string {
  const line = (s: PhaseStats) => `${s.phase ? `${s.phase.name} (${phaseDates(s.phase)})` : "Whole project"}: ${s.actualPct}% done, plan ${s.plannedPct}% · ${s.done}/${s.steps} steps · budget ${money(s.budget)}, spent ${money(s.spent)}, committed ${money(s.committed)}`;
  const out = [`${input.picked?.phase ? `${input.picked.phase.name} phase report` : "Phase report"} - ${input.project}`, ""];
  if (input.picked) out.push(line(input.picked), "");
  out.push("PHASES", ...input.each.map(line), line(input.all));
  return noEmDash(out.join("\n"));
}

/** The close-out's "How the job did": the same numbers, progress and money. */
export const howItDidHtml = (s: PhaseStats, tz: string, now: number) =>
  `<div style="${FONT}color:${INK};max-width:820px;margin:18px auto 0;">${h2(s.phase ? `How ${s.phase.name} did` : "How the job did")}${phaseSectionHtml(s, tz, now)}</div>`;
