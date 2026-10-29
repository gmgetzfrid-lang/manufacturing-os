// workOrdersPrint — the Work orders view on paper, in one of three formats
// (the view on screen stays as it is): every work order shown (the view's
// filter and search), opened up with all its steps.
//
//   report  — plan against actual, where each WO stands, every step's crew,
//             plan, actual, status, % and the latest comment.
//   history — the same with each step's whole history (lib/timeLog).
//   field   — the pen-and-paper tracker taken out to the crews: a line to
//             write each start, finish and % on (recorded ones printed),
//             room for notes, spare rows on every WO for steps that aren't
//             on the schedule, steps the plan says should have started or
//             finished by now marked, recorded times that look wrong
//             flagged to ask about. Printed at the start of a job it's the
//             daily field sheet; later, the list of what's still missing.
//
// Plain HTML with its own styles, for a print window (on the company
// letterhead when there is one).

import type { TimeLogRow } from "@/lib/timeLog";

export interface PrintStep {
  id: string;
  name: string;
  crew: string;
  planStart: number; planFinish: number;
  actStart: number; actFinish: number;
  status: string;
  /** Finished (its status is done). */
  done: boolean;
  pct: number;
  /** "Discovery" / "Added scope" — put in after the plan. */
  added?: string;
  latest?: { at: number; text: string } | null;
  history?: TimeLogRow[];
}

export interface PrintOrder {
  wo: string | null;
  name: string;
  desc: string;
  crews: string[];
  standing: string;
  pct: number; plan: number; hours: number;
  planStart: number; planFinish: number;
  actStart: number; actFinish: number;
  added: string[];
  done: number;
  steps: PrintStep[];
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A time in a table cell: the day and the clock each kept whole, so a
 *  narrow column (a portrait letterhead) breaks between them, never inside. */
function cellTime(t: number, tz: string): string {
  if (!Number.isFinite(t)) return "—";
  const d = new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: tz });
  const c = new Date(t).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: tz });
  return `<span class="nw">${esc(d)}</span> <span class="nw">${esc(c)}</span>`;
}

const DAY = 86_400_000;

/** What a step is missing, and what about it to ask. */
export function stepGaps(s: PrintStep, now: number): {
  /** The plan says it should have started / be done by now and it isn't recorded. */
  due: "start" | "finish" | null;
  check: string[];
} {
  const hasStart = Number.isFinite(s.actStart), hasFinish = Number.isFinite(s.actFinish);
  const due = !hasStart && s.planStart <= now ? "start"
    : (!s.done || !hasFinish) && s.planFinish <= now ? "finish" : null;
  const check: string[] = [];
  if (hasStart && hasFinish && s.actFinish < s.actStart) check.push("finish is before start");
  if (hasStart && s.actStart < s.planStart - 3 * DAY) check.push(`start is ${Math.round((s.planStart - s.actStart) / DAY)} days before plan`);
  if (hasStart && s.actStart > now + 60_000) check.push("start is in the future");
  if (s.done && !hasStart) check.push("done, but no start time");
  if (s.done && !hasFinish) check.push("done, but no finish time");
  return { due, check };
}

/** "Oct 26, 8:00 AM" in plant time; "—" when there's no time. */
export function printTime(t: number, tz: string): string {
  if (!Number.isFinite(t)) return "—";
  return new Date(t).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true, timeZone: tz });
}

export const PRINT_CSS = `
.wop{font-family:Arial,Helvetica,sans-serif;font-size:8.5pt;line-height:1.3;color:#0f172a}
.wop h1{font-size:13pt;margin:0}
.wop .sub{color:#475569;margin:2px 0 10px}
.wop .wo{margin:0 0 12px;border-top:2px solid #0f172a;padding-top:5px}
.wop .head{display:flex;justify-content:space-between;gap:12px;break-inside:avoid;break-after:avoid}
.wop .num{font-family:"Courier New",monospace;font-weight:700;font-size:10pt}
.wop .name{font-weight:700;font-size:10pt}
.wop .desc{margin-top:1px}
.wop .meta{color:#475569}
.wop .when{display:grid;grid-template-columns:auto 1fr;column-gap:6px;margin-top:2px}
.wop .when b{font-weight:700}
.wop .right{text-align:right;white-space:nowrap}
.wop .pill{display:inline-block;border:1px solid #94a3b8;border-radius:4px;padding:0 4px;font-weight:700}
.wop .behind{color:#be123c;font-weight:700}
.wop .ahead{color:#047857;font-weight:700}
.wop .added{color:#6d28d9;font-weight:700}
.wop table{width:100%;border-collapse:collapse;margin-top:4px;table-layout:fixed}
.wop th{text-align:left;font-size:7.5pt;text-transform:uppercase;letter-spacing:.03em;color:#475569;border-bottom:1px solid #94a3b8;padding:2px 4px}
.wop td{border-bottom:1px solid #e2e8f0;padding:3px 4px;vertical-align:top}
.wop tr{break-inside:avoid}
.wop thead{display:table-header-group}
.wop .n{color:#64748b;width:16px}
.wop .t{white-space:nowrap}
.wop .nw{white-space:nowrap}
.wop td.tm{line-height:1.25}
.wop td.tm div+div{margin-top:2px}
.wop table{font-size:8pt}
.wop .c{color:#334155}
.wop .hist{margin:2px 0 0;padding:0;list-style:none;color:#334155}
.wop .hist li{margin:1px 0}
.wop .hist .t{color:#64748b;margin-right:4px}
.wop .lbl{color:#64748b;font-size:7pt;margin-right:3px}
.wop .blank{display:inline-block;width:62%;height:1.25em;border-bottom:1px solid #475569;vertical-align:bottom}
.wop .blank.pct{width:40%}
.wop .flag{color:#b45309;font-weight:700;margin-top:1px}
.wop .find{margin:0 0 10px;padding:4px 6px;border:1px solid #f59e0b;border-radius:4px;background:#fffbeb}
.wop.field td.tm{font-size:7.5pt}
.wop.field td.c{font-size:7.5pt}
.wop.field td{height:.42in}
.wop.field .blank{width:100%}
.wop.field .blank.pct{width:55%}
.wop.field .small{font-size:7pt;color:#475569}
.wop.field tr.spare td{border-bottom:1px solid #94a3b8}
.wop.field .spare .n{color:#94a3b8}
`;

export type PrintFormat = "report" | "history" | "field";

/** The printable body (styles in PRINT_CSS). */
export function workOrdersHtml(input: {
  project: string;
  /** "All work orders", "Behind · '301'" … */
  scope: string;
  /** Default: now. */
  printedAt?: number;
  tz: string;
  orders: PrintOrder[];
  format: PrintFormat;
  /** What "by now" means for the plan; default printedAt. */
  now?: number;
  /** Field tracker: blank rows on each WO for steps that aren't on the schedule. */
  spareRows?: number;
}): string {
  const { tz, format } = input;
  const field = format === "field";
  const printedAt = input.printedAt ?? Date.now(), now = input.now ?? printedAt;
  const T = (t: number) => printTime(t, tz);
  const span = (a: number, b: number, open = "…") => (Number.isFinite(a) ? `${T(a)} → ${Number.isFinite(b) ? T(b) : open}` : "not started");
  const blank = (label?: string, cls = "") => `${label ? `<span class="lbl">${label}</span>` : ""}<span class="blank${cls ? ` ${cls}` : ""}"></span>`;
  const steps = input.orders.reduce((n, o) => n + o.steps.length, 0);
  const parts: string[] = [];
  parts.push(`<div class="wop${field ? " field" : ""}"><h1>${esc(input.project)} — ${field ? "Field tracker" : "Work orders"}</h1>`);
  parts.push(`<div class="sub">${esc(input.scope)} · ${input.orders.length} work order${input.orders.length === 1 ? "" : "s"}, ${steps} step${steps === 1 ? "" : "s"} · printed ${esc(T(printedAt))}</div>`);
  if (field) {
    // What to go and find out.
    let starts = 0, finishes = 0, checks = 0;
    for (const o of input.orders) for (const s of o.steps) {
      const g = stepGaps(s, now);
      if (g.due === "start") starts++;
      if (g.due === "finish" || (g.due === "start" && s.planFinish <= now)) finishes++;
      if (g.check.length) checks++;
    }
    parts.push(`<div class="find">${starts + finishes + checks > 0
      ? `<b>To find out:</b> ${[starts ? `${starts} start time${starts === 1 ? "" : "s"}` : "", finishes ? `${finishes} finish time${finishes === 1 ? "" : "s"}` : "", checks ? `${checks} recorded time${checks === 1 ? "" : "s"} to check` : ""].filter(Boolean).join(" · ")} — marked ⚑ below: the plan says they should have happened by now. `
      : ""}Write each start, finish and % on its line as you get it; the spare rows under each work order are for steps that aren't on the schedule.</div>`);
  }
  for (const o of input.orders) {
    const hrs = o.standing !== "Done" && Math.abs(o.hours) >= 0.1
      ? `<div class="${o.hours < 0 ? "behind" : "ahead"}">${Math.abs(o.hours)} h ${o.hours < 0 ? "behind" : "ahead"}</div>` : "";
    const meta = [o.crews.join(", "), o.steps.length > 1 ? `${o.done} of ${o.steps.length} steps done` : ""].filter(Boolean).join(" · ");
    parts.push(`<section class="wo"><div class="head"><div>
<div><span class="num">${o.wo ? `WO ${esc(o.wo)}` : "No WO"}</span> <span class="name">${esc(o.name)}</span></div>
${o.desc ? `<div class="desc">${esc(o.desc)}</div>` : ""}
${meta || o.added.length ? `<div class="meta">${esc(meta)}${o.added.map((a) => ` <span class="added">+ ${esc(a)}</span>`).join("")}</div>` : ""}
<div class="when"><span class="meta">Plan</span><span>${esc(span(o.planStart, o.planFinish))}</span><span class="meta">Actual</span><b>${esc(span(o.actStart, o.actFinish))}</b></div>
</div><div class="right"><span class="pill">${esc(o.standing)}</span><div><b>${o.pct}%</b>${o.standing !== "Done" ? ` <span class="meta">(plan ${o.plan}%)</span>` : ""}</div>${hrs}</div></div>`);
    // The same columns on every work order, so the tables line up down the
    // page; they fit a portrait letterhead as well as a landscape page.
    const heads = field ? ["", "Step", "Crew", "Plan", "Start", "Finish", "%", "Notes"]
      : format === "history" ? ["", "Step", "Crew", "Plan", "Actual", "Status"]
      : ["", "Step", "Crew", "Plan", "Actual", "Status", "Latest comment"];
    const cols = field ? [3, 19, 12, 15, 13, 13, 7, 18] : format === "history" ? [3, 41, 13, 16, 16, 11] : [3, 24, 12, 15, 15, 10, 21];
    parts.push(`<table><colgroup>${cols.map((w) => `<col style="width:${w}%">`).join("")}</colgroup><thead><tr>${heads.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>`);
    o.steps.forEach((s, i) => {
      const name = `<b>${esc(s.name)}</b>${s.added ? ` <span class="added">${esc(s.added)}</span>` : ""}`;
      const plan = `<td class="tm"><div>${cellTime(s.planStart, tz)}</div><div>${cellTime(s.planFinish, tz)}</div></td>`;
      if (field) {
        const g = stepGaps(s, now);
        const flags = [
          g.due === "start" ? `⚑ Should have started by ${T(s.planStart)}` : g.due === "finish" ? `⚑ Should be done by ${T(s.planFinish)}` : "",
          ...g.check.map((c) => `Check: ${c}`),
        ].filter(Boolean).map((f) => `<div class="flag">${esc(f)}</div>`).join("");
        parts.push(`<tr><td class="n">${i + 1}</td><td>${name}${flags}</td><td class="c">${esc(s.crew)}</td>${plan}`
          // Recorded times as they are; a line to write on for each one that isn't.
          + `<td class="tm">${Number.isFinite(s.actStart) ? cellTime(s.actStart, tz) : blank()}</td>`
          + `<td class="tm">${Number.isFinite(s.actFinish) ? cellTime(s.actFinish, tz) : blank()}</td>`
          + `<td>${s.done ? "Done" : `${s.pct > 0 ? `<div class="small">was ${s.pct}%</div>` : ""}${blank("", "pct")}%`}</td>`
          + `<td>${s.latest ? `<div class="small">${esc(T(s.latest.at))} ${esc(s.latest.text)}</div>` : ""}${blank()}</td></tr>`);
        return;
      }
      const hist = format === "history" && s.history?.length
        ? `<ul class="hist">${s.history.map((h) => `<li><span class="t">${esc(T(h.at))}</span>${esc([h.what === "Progress" || (h.pct.includes("→") && h.what !== "Done") ? `${h.what} ${h.pct}` : h.what, h.comment].filter(Boolean).join(" — "))}</li>`).join("")}</ul>`
        : "";
      parts.push(`<tr><td class="n">${i + 1}</td><td>${name}${hist}</td><td class="c">${esc(s.crew)}</td>${plan}`
        + `<td class="tm">${Number.isFinite(s.actStart) ? `<div>${cellTime(s.actStart, tz)}</div><div>${Number.isFinite(s.actFinish) ? cellTime(s.actFinish, tz) : "…"}</div>` : "—"}</td>`
        + `<td>${esc(s.status)}${!s.done && s.pct > 0 ? `<br><b>${s.pct}%</b>` : ""}</td>`
        + (format === "history" ? "" : `<td class="c">${s.latest ? `<span class="t">${esc(T(s.latest.at))}</span> ${esc(s.latest.text)}` : ""}</td>`)
        + `</tr>`);
    });
    // Spare rows: steps that happened but aren't on the schedule, penned in.
    if (field) {
      for (let k = 0; k < (input.spareRows ?? 3); k++) {
        parts.push(`<tr class="spare"><td class="n">+</td><td>${blank()}</td><td>${blank()}</td><td></td><td>${blank()}</td><td>${blank()}</td><td>${blank("", "pct")}%</td><td>${blank()}</td></tr>`);
      }
    }
    parts.push(`</tbody></table></section>`);
  }
  parts.push(`</div>`);
  return parts.join("\n");
}
