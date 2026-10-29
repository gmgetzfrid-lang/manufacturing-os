// workOrdersPrint — the Work orders view on paper: every work order shown
// (the view's filter and search), opened up — its plan against actual,
// where it stands — with all its steps: crew, plan, actual, status, %, and
// the latest comment, or each step's whole history (lib/timeLog).
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
.wop .c{color:#334155}
.wop .hist{margin:2px 0 0;padding:0;list-style:none;color:#334155}
.wop .hist li{margin:1px 0}
.wop .hist .t{color:#64748b;margin-right:4px}
`;

/** The printable body (styles in PRINT_CSS). */
export function workOrdersHtml(input: {
  project: string;
  /** "All work orders", "Behind · '301'" … */
  scope: string;
  /** Default: now. */
  printedAt?: number;
  tz: string;
  orders: PrintOrder[];
  history: boolean;
}): string {
  const { tz } = input;
  const T = (t: number) => printTime(t, tz);
  const span = (a: number, b: number, open = "…") => (Number.isFinite(a) ? `${T(a)} → ${Number.isFinite(b) ? T(b) : open}` : "not started");
  const steps = input.orders.reduce((n, o) => n + o.steps.length, 0);
  const parts: string[] = [];
  parts.push(`<div class="wop"><h1>${esc(input.project)} — Work orders</h1>`);
  parts.push(`<div class="sub">${esc(input.scope)} · ${input.orders.length} work order${input.orders.length === 1 ? "" : "s"}, ${steps} step${steps === 1 ? "" : "s"} · printed ${esc(T(input.printedAt ?? Date.now()))}</div>`);
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
    // The same columns on every work order, so the tables line up down the page.
    const cols = input.history ? [3, 43, 13, 14, 14, 8, 5] : [3, 27, 11, 12, 12, 7, 5, 23];
    parts.push(`<table><colgroup>${cols.map((w) => `<col style="width:${w}%">`).join("")}</colgroup><thead><tr><th></th><th>Step</th><th>Crew</th><th>Plan</th><th>Actual</th><th>Status</th><th class="right">%</th>${input.history ? "" : "<th>Latest comment</th>"}</tr></thead><tbody>`);
    o.steps.forEach((s, i) => {
      const hist = input.history && s.history?.length
        ? `<ul class="hist">${s.history.map((h) => `<li><span class="t">${esc(T(h.at))}</span>${esc([h.what === "Progress" || (h.pct.includes("→") && h.what !== "Done") ? `${h.what} ${h.pct}` : h.what, h.comment].filter(Boolean).join(" — "))}</li>`).join("")}</ul>`
        : "";
      parts.push(`<tr><td class="n">${i + 1}</td><td><b>${esc(s.name)}</b>${s.added ? ` <span class="added">${esc(s.added)}</span>` : ""}${hist}</td><td class="c">${esc(s.crew)}</td>`
        + `<td class="t">${esc(T(s.planStart))}<br>${esc(T(s.planFinish))}</td>`
        + `<td class="t">${Number.isFinite(s.actStart) ? `${esc(T(s.actStart))}<br>${Number.isFinite(s.actFinish) ? esc(T(s.actFinish)) : "…"}` : "—"}</td>`
        + `<td>${esc(s.status)}</td><td class="right">${s.pct}%</td>`
        + (input.history ? "" : `<td class="c">${s.latest ? `<span class="t">${esc(T(s.latest.at))}</span> ${esc(s.latest.text)}` : ""}</td>`)
        + `</tr>`);
    });
    parts.push(`</tbody></table></section>`);
  }
  parts.push(`</div>`);
  return parts.join("\n");
}
