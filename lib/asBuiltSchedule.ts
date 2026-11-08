// asBuiltSchedule - the job as it was really done, work order by work
// order and step by step, against the original plan: when each was planned,
// when it really started and finished, how long it took, how far off the
// plan it finished, and what was added or taken off along the way.
//
//   - Plan: the original plan as saved (lib/closeoutStatus originalPlan),
//     else, with none saved, the schedule as planned. Work added after it
//     was saved has its own planned dates, marked as added.
//   - Actual: the times recorded on each step. A step marked done with no
//     start recorded says so ("not recorded"), and its bar starts at its
//     planned start (lib/asBuilt, the as-built calendar's rule).
//   - Work orders as everywhere else (lib/workOrderGroups).
//
// Builds the timeline (print, PDF), the table, and the Excel file from the
// same rows, so they can't disagree.

import type { Milestone } from "@/types/schema";
import type { CancelledJob } from "@/lib/cancelledJobs";
import { workOrderGroupsOf } from "@/lib/workOrderGroups";
import { workHours } from "@/lib/shiftReport";
import { builtSpan } from "@/lib/asBuilt";
import { startMsOf, finishMsOf } from "@/lib/calendarPlacement";
import { discoveryOf, kindOf, ADDED } from "@/lib/discovery";
import { originalPlan, vsPlanWords } from "@/lib/closeoutStatus";
import { phaseIndex, type ProjectPhase } from "@/lib/projectPhases";
import { fmtInTz, wallClock, dayKey, wallClockToMs } from "@/lib/scheduleTz";
import { noEmDash } from "@/lib/noEmDash";

const toMs = (v: unknown): number | null => { const t = v == null || v === "" ? NaN : typeof v === "number" ? v : Date.parse(String(v)); return Number.isFinite(t) ? t : null; };
const H = 3_600_000;
const r1 = (n: number) => Math.round(n * 10) / 10;

export type BuiltStatus = "done" | "in_progress" | "held" | "not_started";
export const BUILT_WORD: Record<BuiltStatus, string> = { done: "Done", in_progress: "In progress", held: "Held", not_started: "Not started" };

export interface BuiltStep {
  id: string;
  name: string;
  crew: string | null;
  /** In the original plan; else added after it ("discovery", "added scope",
   *  or put in after the plan was saved). */
  inPlan: boolean;
  added: string | null;
  planStart: number | null;
  planFinish: number | null;
  /** Actual start: as recorded; null when none was. */
  start: number | null;
  /** Where its bar starts: the recorded start, else (done) its planned start. */
  barStart: number | null;
  finish: number | null;
  status: BuiltStatus;
  pct: number;
  plannedH: number;
  /** Start to finish, both recorded. */
  elapsedH: number | null;
  /** Finished after (+) or before (-) its planned finish, hours. */
  varianceH: number | null;
}

export interface BuiltOrder {
  key: string;
  wo: string | null;
  name: string;
  phase: string | null;
  steps: BuiltStep[];
  planStart: number | null;
  planFinish: number | null;
  start: number | null;
  barStart: number | null;
  /** Every step done: the last finish. */
  finish: number | null;
  done: number;
  status: BuiltStatus;
  /** Every step added after the plan: an added work order. */
  allAdded: boolean;
  varianceH: number | null;
}

export interface AsBuilt {
  orders: BuiltOrder[];
  basis: { kind: "baseline" | "schedule"; savedAt: number | null };
  planStart: number | null;
  planFinish: number | null;
  start: number | null;
  /** Every step done: the last finish. */
  finish: number | null;
  steps: number;
  done: number;
  added: number;
  startsNotRecorded: number;
  cancelled: Array<{ name: string; where: string; steps: number; at: number | null; note: string | null }>;
}

const statusOf = (m: Milestone): BuiltStatus =>
  m.status === "completed" || Number(m.percentComplete ?? 0) >= 100 ? "done"
    : m.status === "on_hold" || m.status === "blocked" ? "held"
      : m.status === "in_progress" || Number(m.percentComplete ?? 0) > 0 || toMs(m.actualStartAt) != null ? "in_progress" : "not_started";

export function buildAsBuilt(input: {
  milestones: Milestone[]; childrenByParent: Map<string, Milestone[]>; cancelled?: CancelledJob[];
  phases?: ProjectPhase[]; tz: string;
}): AsBuilt {
  const { milestones, childrenByParent, tz } = input;
  const phases = input.phases ?? [];
  const leaves = milestones.filter((m) => m.id && !(childrenByParent.get(m.id)?.length) && !m.isSummary && !(m as { cancelledAt?: unknown }).cancelledAt);
  const plan = originalPlan(leaves);
  const inPlan = new Set(plan.steps.map((m) => m.id!));
  const pIdx = phases.length ? phaseIndex(milestones, phases) : null;
  const phaseName = (id: string | undefined) => (id && pIdx ? phases.find((p) => p.id === pIdx.get(id))?.name ?? null : null);

  const stepOf = (m: Milestone): BuiltStep => {
    const based = plan.kind === "baseline" && inPlan.has(m.id!);
    const planStart = based ? toMs(m.baselineStartAt) : Number.isFinite(startMsOf(m)) ? startMsOf(m) : null;
    const planFinish = based ? toMs(m.baselineFinishAt) : Number.isFinite(finishMsOf(m)) ? finishMsOf(m) : null;
    const status = statusOf(m);
    const finish = status === "done" ? toMs(m.actualAt) : null;
    const start = toMs(m.actualStartAt);
    const span = status === "done" && finish != null ? builtSpan(m) : null;
    const barStart = start ?? (span && Number.isFinite(span.start) ? span.start : null);
    const d = discoveryOf(m);
    return {
      id: m.id!, name: m.name, crew: m.responsibleParty?.trim() || null,
      inPlan: inPlan.has(m.id!), added: d ? ADDED[kindOf(d)].lower : inPlan.has(m.id!) ? null : "put in after the plan was saved",
      planStart, planFinish, start, barStart, finish, status,
      pct: status === "done" ? 100 : Math.round(Number(m.percentComplete ?? 0)),
      plannedH: workHours(m, tz),
      elapsedH: start != null && finish != null && finish >= start ? r1((finish - start) / H) : null,
      varianceH: finish != null && planFinish != null ? r1((finish - planFinish) / H) : null,
    };
  };

  const orders: BuiltOrder[] = [];
  const leafIds = new Set(leaves.map((m) => m.id!));
  for (const [key, g] of workOrderGroupsOf(milestones, childrenByParent)) {
    const steps = g.steps.filter((m) => leafIds.has(m.id!)).map(stepOf)
      .sort((a, b) => (a.planStart ?? Infinity) - (b.planStart ?? Infinity) || (a.barStart ?? Infinity) - (b.barStart ?? Infinity));
    if (!steps.length) continue;
    const nums = (xs: Array<number | null>) => xs.filter((x): x is number => x != null);
    const done = steps.filter((s) => s.status === "done").length;
    const allDone = done === steps.length;
    const finishes = nums(steps.map((s) => s.finish));
    const planFinishes = nums(steps.map((s) => s.planFinish));
    const finish = allDone && finishes.length === steps.length ? Math.max(...finishes) : null;
    const planFinish = planFinishes.length ? Math.max(...planFinishes) : null;
    orders.push({
      key, wo: g.wo, name: [g.owner.name, ...(g.also ?? []).map((x) => x.name)].join(" + "),
      phase: phaseName(g.owner.id ?? steps[0].id) ?? phaseName(steps[0].id),
      steps,
      planStart: nums(steps.map((s) => s.planStart)).length ? Math.min(...nums(steps.map((s) => s.planStart))) : null,
      planFinish,
      start: nums(steps.map((s) => s.start)).length ? Math.min(...nums(steps.map((s) => s.start))) : null,
      barStart: nums(steps.map((s) => s.barStart)).length ? Math.min(...nums(steps.map((s) => s.barStart))) : null,
      finish, done,
      status: allDone ? "done" : steps.some((s) => s.status === "held") ? "held" : steps.some((s) => s.status !== "not_started") ? "in_progress" : "not_started",
      allAdded: steps.every((s) => !s.inPlan),
      varianceH: finish != null && planFinish != null ? r1((finish - planFinish) / H) : null,
    });
  }
  orders.sort((a, b) => (a.planStart ?? Infinity) - (b.planStart ?? Infinity) || (a.wo ?? "~").localeCompare(b.wo ?? "~"));

  const all = orders.flatMap((o) => o.steps);
  const nums = (xs: Array<number | null>) => xs.filter((x): x is number => x != null);
  const allDone = all.length > 0 && all.every((s) => s.status === "done");
  const fin = nums(all.map((s) => s.finish));
  return {
    orders,
    basis: { kind: plan.kind, savedAt: plan.savedAt },
    planStart: plan.start, planFinish: plan.finish,
    start: nums(all.map((s) => s.barStart)).length ? Math.min(...nums(all.map((s) => s.barStart))) : null,
    finish: allDone && fin.length === all.length ? Math.max(...fin) : null,
    steps: all.length, done: all.filter((s) => s.status === "done").length,
    added: all.filter((s) => !s.inPlan).length,
    startsNotRecorded: all.filter((s) => s.status === "done" && s.start == null).length,
    cancelled: (input.cancelled ?? []).map((c) => ({ name: c.m.name, where: c.crumbs.join(" › "), steps: c.steps, at: c.at, note: c.m.cancelNote ?? null })),
  };
}

// ─── Words ───────────────────────────────────────────────────────────────

const esc = (s: string) => noEmDash(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const dt = (t: number | null, tz: string) => (t == null ? "" : `${fmtInTz(t, tz, { month: "numeric", day: "numeric" })} ${fmtInTz(t, tz, { hour: "numeric", minute: "2-digit", hour12: true })}`);
const dtLong = (t: number | null, tz: string) => (t == null ? "-" : `${fmtInTz(t, tz, { weekday: "short", month: "short", day: "numeric" })}, ${fmtInTz(t, tz, { hour: "numeric", minute: "2-digit", hour12: true })}`);
/** "+33.5 h" / "-2 h" / "on plan" */
export const varianceWords = (h: number | null) => (h == null ? "" : Math.abs(h) < 0.5 ? "on plan" : `${h > 0 ? "+" : "-"}${r1(Math.abs(h))} h`);

/** What the plan and the actual times are, in words: said on every copy. */
export function asBuiltKey(a: AsBuilt, tz: string): string[] {
  const out = [
    a.basis.kind === "baseline"
      ? `Plan: the original plan${a.basis.savedAt != null ? ` as saved ${fmtInTz(a.basis.savedAt, tz, { weekday: "short", month: "short", day: "numeric" })}` : ""}. Work added after it shows its own planned dates and is marked added.`
      : "Plan: the schedule as planned (no original plan was saved). Added work is marked added.",
    "Actual: the start and finish times recorded on each step. Finish vs plan: hours after (+) or before (-) the planned finish.",
  ];
  if (a.startsNotRecorded) out.push(`${a.startsNotRecorded} step${a.startsNotRecorded === 1 ? " was" : "s were"} marked done with no start recorded: shown as "not recorded"; the bar starts at the planned start.`);
  return out;
}

// ─── The printable report (landscape): timeline, then the table ──────────

const NAVY = "#000A72", INK = "#0f172a", MUTED = "#64748b", RULE = "#e2e8f0", GREEN = "#0f766e", AMBER = "#b45309", BLUE = "#2563eb", GRAY = "#94a3b8";
const FONT = "font-family:Lato,Calibri,Arial,sans-serif;";

function timelineHtml(a: AsBuilt, tz: string, now: number): string {
  const pts = [a.planStart, a.planFinish, a.start, a.finish, ...a.orders.flatMap((o) => [o.planStart, o.planFinish, o.barStart, o.finish ?? (o.status !== "not_started" ? now : null)])].filter((x): x is number => x != null);
  if (!pts.length) return "";
  const first = dayKey(Math.min(...pts), tz), last = dayKey(Math.max(...pts), tz);
  const dayStart = (k: string) => { const [y, m, d] = k.split("-").map(Number); return wallClockToMs({ year: y, month: m, day: d, hour: 0, minute: 0, second: 0 }, tz); };
  const days: string[] = [];
  for (let k = first, g = 0; k <= last && g < 120; g++) {
    days.push(k);
    const [y, m, d] = k.split("-").map(Number);
    k = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
  }
  const t0 = dayStart(days[0]);
  const [ly, lm, ld] = days[days.length - 1].split("-").map(Number);
  const t1 = wallClockToMs({ year: ly, month: lm, day: ld + 1, hour: 0, minute: 0, second: 0 }, tz);
  const x = (t: number) => Math.max(0, Math.min(100, ((t - t0) / (t1 - t0)) * 100));
  const seg = (s: number | null, f: number | null, color: string, top: number, h: number, dashed = false) => {
    if (s == null || f == null) return "";
    const l = x(s), w = Math.max(0.4, x(f) - l);
    return `<div style="position:absolute;left:${l}%;width:${w}%;top:${top}px;height:${h}px;${dashed ? `border:1px dashed ${color};` : `background:${color};`}border-radius:2px;"></div>`;
  };
  const grid = days.map((k, i) => `<div style="position:absolute;left:${(i / days.length) * 100}%;top:0;bottom:0;border-left:1px solid ${RULE};"></div>`).join("");
  const planEnd = a.planFinish != null ? `<div style="position:absolute;left:${x(a.planFinish)}%;top:0;bottom:0;border-left:2px solid ${NAVY};"></div>` : "";
  const head = days.map((k) => { const [y, m, d] = k.split("-").map(Number); const dd = new Date(Date.UTC(y, m - 1, d)); return `<div style="flex:1;text-align:center;font-size:8.5px;color:${MUTED};border-left:1px solid ${RULE};padding:1px 0;">${dd.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" })}<br>${m}/${d}</div>`; }).join("");
  const rows = a.orders.map((o) => {
    const color = o.allAdded ? AMBER : o.status === "done" ? GREEN : BLUE;
    const end = o.finish ?? (o.status !== "not_started" ? now : null);
    return `<tr><td style="${FONT}font-size:9.5px;padding:2px 6px 2px 0;white-space:nowrap;max-width:230px;overflow:hidden;text-overflow:ellipsis;border-bottom:1px solid ${RULE};">${o.wo ? `<b>${esc(o.wo)}</b> ` : ""}${esc(o.name)}</td>` +
      `<td style="padding:0;border-bottom:1px solid ${RULE};"><div style="position:relative;height:18px;">${grid}${planEnd}${seg(o.planStart, o.planFinish, GRAY, 3, 5)}${seg(o.barStart, end, color, 9, 6)}</div></td>` +
      `<td style="${FONT}font-size:9.5px;padding:2px 0 2px 6px;text-align:right;white-space:nowrap;border-bottom:1px solid ${RULE};color:${o.varianceH != null && o.varianceH >= 0.5 ? "#b91c1c" : MUTED};">${o.finish != null ? varianceWords(o.varianceH) : BUILT_WORD[o.status]}</td></tr>`;
  }).join("");
  return `<div style="${FONT}font-size:14px;font-weight:bold;color:${NAVY};margin:14px 0 4px;border-bottom:2px solid ${NAVY};padding-bottom:3px;">Timeline</div>` +
    `<div style="${FONT}font-size:10px;color:${MUTED};margin-bottom:4px;"><span style="display:inline-block;width:14px;height:5px;background:${GRAY};"></span> Plan &nbsp; <span style="display:inline-block;width:14px;height:6px;background:${GREEN};"></span> Actual &nbsp; <span style="display:inline-block;width:14px;height:6px;background:${BLUE};"></span> Still going &nbsp; <span style="display:inline-block;width:14px;height:6px;background:${AMBER};"></span> Added work order &nbsp; <span style="display:inline-block;width:2px;height:10px;background:${NAVY};"></span> Planned finish</div>` +
    `<table cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;table-layout:fixed;"><colgroup><col style="width:230px"><col><col style="width:62px"></colgroup>` +
    `<tr><td></td><td style="padding:0;"><div style="display:flex;">${head}</div></td><td style="${FONT}font-size:8.5px;color:${MUTED};text-align:right;">vs plan</td></tr>${rows}</table>`;
}

function tableHtml(a: AsBuilt, tz: string): string {
  const th = (t: string, right = false) => `<th style="${FONT}font-size:8.5px;font-weight:bold;text-transform:uppercase;letter-spacing:.05em;color:${MUTED};text-align:${right ? "right" : "left"};padding:3px 4px;border-bottom:1px solid ${INK};">${t}</th>`;
  const td = (v: string, extra = "") => `<td style="${FONT}font-size:9.5px;padding:2px 4px;border-bottom:1px solid ${RULE};vertical-align:top;${extra}">${v}</td>`;
  const head = `<tr>${th("Step")}${th("Crew")}${th("Plan start")}${th("Plan finish")}${th("Actual start")}${th("Actual finish")}${th("Plan h", true)}${th("Took h", true)}${th("vs plan", true)}${th("Status")}</tr>`;
  const body = a.orders.map((o) => {
    const top = `<tr style="background:#f1f5f9;">${td(`<b>${o.wo ? `WO ${esc(o.wo)} · ` : ""}${esc(o.name)}</b>${o.phase ? ` <span style="color:${MUTED};">· ${esc(o.phase)}</span>` : ""}${o.allAdded ? ` <span style="color:${AMBER};font-weight:bold;">· added</span>` : ""}`, "")}${td("")}${td(esc(dt(o.planStart, tz)))}${td(esc(dt(o.planFinish, tz)))}${td(esc(dt(o.start, tz)))}${td(esc(dt(o.finish, tz)))}${td("")}${td("")}${td(`<b>${esc(varianceWords(o.varianceH))}</b>`, `text-align:right;${o.varianceH != null && o.varianceH >= 0.5 ? "color:#b91c1c;" : ""}`)}${td(`${o.done}/${o.steps.length} ${esc(BUILT_WORD[o.status].toLowerCase())}`)}</tr>`;
    const steps = o.steps.map((s) => `<tr>${td(`${esc(s.name)}${s.added ? `<div style="font-size:8.5px;color:${AMBER};">added: ${esc(s.added)}</div>` : ""}`, "padding-left:12px;")}${td(esc(s.crew ?? ""))}${td(esc(dt(s.planStart, tz)))}${td(esc(dt(s.planFinish, tz)))}` +
      `${td(s.start != null ? esc(dt(s.start, tz)) : s.status === "done" ? `<span style="color:${AMBER};">not recorded</span>` : "")}${td(esc(dt(s.finish, tz)))}${td(String(r1(s.plannedH)), "text-align:right;")}${td(s.elapsedH != null ? String(s.elapsedH) : "", "text-align:right;")}` +
      `${td(esc(varianceWords(s.varianceH)), `text-align:right;${s.varianceH != null && s.varianceH >= 0.5 ? "color:#b91c1c;" : ""}`)}${td(s.status === "done" ? "Done" : `${esc(BUILT_WORD[s.status])}${s.pct ? ` ${s.pct}%` : ""}`)}</tr>`).join("");
    return top + steps;
  }).join("");
  return `<div style="${FONT}font-size:14px;font-weight:bold;color:${NAVY};margin:16px 0 4px;border-bottom:2px solid ${NAVY};padding-bottom:3px;">Work orders and steps</div>` +
    `<table cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;">${head}${body}</table>`;
}

/** The whole report as a page to print (landscape). */
export function asBuiltDocument(a: AsBuilt, o: { project: string; scope: string; tz: string; now: number }): string {
  const { tz, now } = o;
  const tile = (k: string, v: string, s: string) => `<td style="${FONT}border:1px solid ${RULE};padding:6px 8px;vertical-align:top;"><div style="font-size:8.5px;font-weight:bold;letter-spacing:.08em;text-transform:uppercase;color:${MUTED};">${esc(k)}</div><div style="font-size:15px;font-weight:bold;color:${INK};">${esc(v)}</div><div style="font-size:9.5px;color:${MUTED};">${esc(s)}</div></td>`;
  const late = a.finish != null && a.planFinish != null ? r1((a.finish - a.planFinish) / H) : null;
  const tiles = `<table cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;margin-top:6px;"><tr>` +
    tile("Original plan", a.planStart != null ? `${dt(a.planStart, tz)} to ${dt(a.planFinish, tz)}` : "-", a.basis.kind === "baseline" ? "as saved" : "no plan saved: the schedule as planned") +
    tile("As built", a.start != null ? `${dt(a.start, tz)} to ${a.finish != null ? dt(a.finish, tz) : "still going"}` : "not started", a.finish != null ? "first start to last finish" : `${a.done} of ${a.steps} steps done`) +
    tile("Finish vs plan", a.finish != null && late != null ? vsPlanWords(late) : "-", a.finish != null ? `finished ${dtLong(a.finish, tz)}` : "not finished") +
    tile("Steps", `${a.done} / ${a.steps}`, `${a.orders.length} work orders`) +
    tile("Added after the plan", `${a.added} step${a.added === 1 ? "" : "s"}`, a.cancelled.length ? `${a.cancelled.length} taken off` : "nothing taken off") +
    `</tr></table>`;
  const key = `<div style="${FONT}font-size:9.5px;color:${MUTED};margin-top:6px;line-height:1.45;">${asBuiltKey(a, tz).map(esc).join("<br>")}</div>`;
  const cancelled = a.cancelled.length
    ? `<div style="${FONT}font-size:14px;font-weight:bold;color:${NAVY};margin:16px 0 4px;border-bottom:2px solid ${NAVY};padding-bottom:3px;">Taken off the schedule</div>` +
      `<table cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;${FONT}font-size:9.5px;">${a.cancelled.map((c) => `<tr><td style="padding:2px 4px;border-bottom:1px solid ${RULE};"><b>${esc(c.name)}</b>${c.where ? ` <span style="color:${MUTED};">${esc(c.where)}</span>` : ""}</td><td style="padding:2px 4px;border-bottom:1px solid ${RULE};">${c.steps} step${c.steps === 1 ? "" : "s"}</td><td style="padding:2px 4px;border-bottom:1px solid ${RULE};">${esc(dt(c.at, tz))}</td><td style="padding:2px 4px;border-bottom:1px solid ${RULE};">${esc(c.note ?? "")}</td></tr>`).join("")}</table>`
    : "";
  const body = `<div style="${FONT}color:${INK};">` +
    `<div style="border-top:4px solid ${NAVY};padding:8px 0 2px;"><div style="font-size:10px;font-weight:bold;letter-spacing:.12em;text-transform:uppercase;color:${MUTED};">As-built schedule</div>` +
    `<div style="font-size:19px;font-weight:bold;color:${NAVY};">${esc(o.project)}</div><div style="font-size:11px;color:${MUTED};">${esc(o.scope)} · as of ${esc(dtLong(now, tz))}</div></div>` +
    tiles + key + timelineHtml(a, tz, now) + tableHtml(a, tz) + cancelled + `</div>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(`${o.project} - as-built schedule`)}</title><style>@page{size:landscape;margin:10mm}body{margin:0;-webkit-print-color-adjust:exact;print-color-adjust:exact}@media screen{body{padding:16px}}tr{page-break-inside:avoid}</style></head><body>${body}</body></html>`;
}

// ─── Excel ───────────────────────────────────────────────────────────────

/** An instant as an Excel date-time, in plant time (sorts and filters as a date). */
const excelTime = (t: number | null, tz: string) => {
  if (t == null) return null;
  const w = wallClock(t, tz);
  return { t: "n", v: Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) / 86_400_000 + 25_569, z: "m/d/yyyy h:mm AM/PM" };
};

export async function downloadAsBuilt(a: AsBuilt, o: { project: string; scope: string; tz: string; fileName: string }): Promise<void> {
  const XLSX = await import("xlsx");
  const head = ["Phase", "WO", "Work order", "Step", "Crew", "In original plan", "Added", "Plan start", "Plan finish", "Actual start", "Start recorded", "Actual finish", "Plan h", "Took h", "Finish vs plan (h)", "Status", "%"];
  const aoa: unknown[][] = [
    [`${o.project} - as-built schedule (${o.scope})`],
    ...asBuiltKey(a, o.tz).map((k) => [k]),
    [],
    head,
  ];
  for (const ord of a.orders) {
    for (const s of ord.steps) {
      aoa.push([
        ord.phase ?? "", ord.wo ?? "", ord.name, s.name, s.crew ?? "", s.inPlan ? "Yes" : "No", s.added ?? "",
        excelTime(s.planStart, o.tz), excelTime(s.planFinish, o.tz), excelTime(s.start, o.tz), s.start != null ? "Yes" : s.status === "done" ? "No" : "", excelTime(s.finish, o.tz),
        r1(s.plannedH), s.elapsedH ?? "", s.varianceH ?? "", BUILT_WORD[s.status], s.pct,
      ]);
    }
  }
  const headRow = aoa.findIndex((r) => r === head) + 1;
  const isCell = (c: unknown) => !!c && typeof c === "object" && "z" in (c as object);
  const ws = XLSX.utils.aoa_to_sheet(aoa.map((r) => r.map((c) => (c == null || isCell(c) ? "" : c))) as unknown[][]);
  // Date cells: Excel date-times in plant time.
  aoa.forEach((row, ri) => row.forEach((c, ci) => { if (isCell(c)) ws[XLSX.utils.encode_cell({ r: ri, c: ci })] = c as never; }));
  ws["!cols"] = [12, 9, 34, 38, 18, 9, 16, 18, 18, 18, 9, 18, 7, 7, 9, 11, 5].map((wch) => ({ wch }));
  ws["!autofilter"] = { ref: `A${headRow}:Q${aoa.length}` };
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "As-built");
  if (a.cancelled.length) {
    const when = (t: number | null) => (t == null ? "" : `${fmtInTz(t, o.tz, { month: "numeric", day: "numeric", year: "numeric" })} ${fmtInTz(t, o.tz, { hour: "numeric", minute: "2-digit", hour12: true })}`);
    const cs = XLSX.utils.aoa_to_sheet([["Taken off the schedule", "Where", "Steps", "When", "Note"], ...a.cancelled.map((c) => [c.name, c.where, c.steps, when(c.at), c.note ?? ""])]);
    cs["!cols"] = [40, 50, 7, 20, 50].map((wch) => ({ wch }));
    XLSX.utils.book_append_sheet(wb, cs, "Taken off");
  }
  XLSX.writeFile(wb, o.fileName);
}
