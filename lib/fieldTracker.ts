// fieldTracker - the pen-and-paper field tracker: a blank form printed once
// (at the start of the job, or for the work coming up on a long one) and
// filled in by hand. It carries only what's needed to find the work: each
// work order, its resources and plan, each step with its plan and resource.
// Nothing recorded is printed on it. Each step has lines to write its
// updates on (start, finish, %, notes), as many as its plan is long; a step
// that runs out of lines gets a sheet of its own.
//
// Plain HTML with its own styles (FIELD_CSS), landscape, for a print window.

export interface FieldStep { id: string; name: string; crew: string; planStart: number; planFinish: number }
export interface FieldOrder { key: string; wo: string | null; name: string; crews: string[]; planStart: number; planFinish: number; steps: FieldStep[] }

const H = 3_600_000, DAY = 24 * H;

/** Lines a step gets from how long its plan is: a few hours 2, half a day
 *  3, a day 4, two days 5, three to four days 6, five to six days 7, a
 *  week or more 8. */
export function linesFor(ms: number): number {
  if (!Number.isFinite(ms) || ms <= 4 * H) return 2;
  if (ms <= 12 * H) return 3;
  if (ms <= DAY) return 4;
  if (ms <= 2 * DAY) return 5;
  if (ms <= 4 * DAY) return 6;
  if (ms < 7 * DAY) return 7;
  return 8;
}

/** The work planned in a date range: each work order with a step whose plan
 *  falls in it, only those steps. */
export function inRange(orders: FieldOrder[], from: number, to: number): FieldOrder[] {
  return orders.map((o) => ({ ...o, steps: o.steps.filter((s) => s.planStart < to && s.planFinish > from) })).filter((o) => o.steps.length > 0);
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** "Oct 26 10:00 AM" in plant time. */
const when = (t: number, tz: string) => (Number.isFinite(t)
  ? `${new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: tz })} ${new Date(t).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: tz })}`
  : "-");
const plan = (a: number, b: number, tz: string) => `${when(a, tz)} to ${when(b, tz)}`;
const pill = (c: string) => `<span class="pill">${esc(c)}</span>`;

export const FIELD_CSS = `
@page{size:letter landscape;margin:.4in}
*{box-sizing:border-box}
body{margin:0;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.ft{font-family:Arial,Helvetica,sans-serif;color:#0f172a}
.ft .top{display:flex;justify-content:space-between;align-items:baseline;border-bottom:2px solid #0f172a;padding-bottom:4px;margin-bottom:6px}
.ft .top h1{font-size:14pt;margin:0}
.ft .top .r{font-size:9pt;color:#475569;white-space:nowrap}
.ft .how{font-size:8.5pt;color:#475569;margin-bottom:8px}
.ft .wo{margin-bottom:10px}
.ft .woh{background:#e2e8f0;padding:5px 7px;border:1px solid #94a3b8;border-bottom:none;display:flex;justify-content:space-between;gap:12px;align-items:baseline;break-after:avoid}
.ft .woh .t{font-size:10.5pt;font-weight:bold}
.ft .woh .t .n{font-size:11pt;margin-right:8px}
.ft .woh .m,.ft .sh .m{font-size:8.5pt;color:#334155;text-align:right}
.ft .woh .m b,.ft .sh .m b{color:#0f172a}
.ft .pill{display:inline-block;font-size:7.5pt;font-weight:bold;border:1px solid #64748b;border-radius:3px;padding:0 4px;color:#0f172a;background:#fff;margin:0 0 0 2px;white-space:nowrap}
.ft table{width:100%;border-collapse:collapse;table-layout:fixed}
.ft thead{display:table-header-group}
.ft th{font-size:8pt;text-transform:uppercase;letter-spacing:.3px;color:#334155;background:#f1f5f9;border:1px solid #94a3b8;padding:3px 5px;text-align:left}
.ft td{border:1px solid #94a3b8;height:.36in;padding:2px 5px;vertical-align:top;font-size:9.5pt}
.ft td.step b{display:block;font-size:10pt}
.ft td.step .plan{color:#334155;font-size:8pt;margin:2px 0}
.ft td.step .pill{margin:0}
.ft tbody.s{break-inside:avoid}
.ft tbody.s tr:last-child td{border-bottom:2px solid #475569}
.ft td.pct{text-align:right;color:#94a3b8;font-size:8pt;vertical-align:bottom}
.ft .sh{border:1px solid #94a3b8;border-bottom:none;padding:5px 7px;display:flex;justify-content:space-between;align-items:baseline;gap:12px}
.ft .sh b{font-size:12pt}
.ft .none{font-size:10pt;color:#475569;padding:12px 0}
`;

/** The form. `lines`: each step's lines ("auto": from its work order's plan,
 *  or in a range, from how much of the step falls in it); `step`: one
 *  step's own sheet (its work order the only one in `orders`). */
export function fieldTrackerHtml(input: {
  project: string; tz: string; orders: FieldOrder[];
  lines: "auto" | number;
  /** Work planned in a date range (the orders already narrowed to it). */
  range?: { from: number; to: number };
  step?: string;
  /** Lines on a one-step sheet: a page of them. */
  sheetLines?: number;
}): string {
  const { tz } = input;
  const day = (t: number) => new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: tz });
  const title = input.step ? "Field tracker: one step" : input.range ? `Field tracker: ${day(input.range.from)} to ${day(input.range.to - 1)}` : "Field tracker";
  const out: string[] = [`<div class="ft"><div class="top"><h1>${esc(input.project)} - ${esc(title)}</h1><div class="r">Page ___ of ___</div></div>`];
  const woHead = (o: FieldOrder) => `<div class="woh"><div class="t"><span class="n">${o.wo ? `WO ${esc(o.wo)}` : "No WO"}</span>${esc(o.name)}</div>`
    + `<div class="m">${o.crews.length ? `Resources ${o.crews.map(pill).join(" ")} &nbsp;·&nbsp; ` : ""}Plan <b>${esc(plan(o.planStart, o.planFinish, tz))}</b></div></div>`;
  if (input.step) {
    const o = input.orders[0], s = o?.steps.find((x) => x.id === input.step);
    if (!o || !s) return `${out.join("")}<div class="none">That step isn't on the schedule.</div></div>`;
    out.push(woHead(o));
    out.push(`<div class="sh"><b>${esc(s.name)}</b><span class="m">${s.crew ? `Resource ${pill(s.crew)} &nbsp;·&nbsp; ` : ""}Plan <b>${esc(plan(s.planStart, s.planFinish, tz))}</b></span></div>`);
    out.push(`<table><colgroup><col style="width:31%"><col style="width:31%"><col style="width:8%"><col style="width:30%"></colgroup><thead><tr><th>Start (date &amp; time)</th><th>Finish (date &amp; time)</th><th>%</th><th>Notes</th></tr></thead><tbody>`);
    for (let i = 0; i < (input.sheetLines ?? 16); i++) out.push(`<tr><td></td><td></td><td class="pct">%</td><td></td></tr>`);
    out.push(`</tbody></table></div>`);
    return out.join("\n");
  }
  out.push(`<div class="how">Write each update by hand: Start and Finish as date and time, the % at that update, and anything worth noting. A step that runs out of lines: print it a sheet of its own.</div>`);
  if (!input.orders.length) out.push(`<div class="none">No work ${input.range ? "planned in these dates" : "on the schedule"}.</div>`);
  for (const o of input.orders) {
    out.push(`<section class="wo">${woHead(o)}<table><colgroup><col style="width:23%"><col style="width:24%"><col style="width:24%"><col style="width:7%"><col style="width:22%"></colgroup>`);
    out.push(`<thead><tr><th>Step &amp; plan</th><th>Start (date &amp; time)</th><th>Finish (date &amp; time)</th><th>%</th><th>Notes</th></tr></thead>`);
    for (const s of o.steps) {
      const span = input.range ? Math.min(s.planFinish, input.range.to) - Math.max(s.planStart, input.range.from) : o.planFinish - o.planStart;
      const n = input.lines === "auto" ? linesFor(span) : Math.max(2, Math.min(8, Math.round(input.lines)));
      out.push(`<tbody class="s">`);
      for (let r = 0; r < n; r++) {
        out.push(r === 0
          ? `<tr><td class="step" rowspan="${n}"><b>${esc(s.name)}</b><div class="plan">Plan ${esc(plan(s.planStart, s.planFinish, tz))}</div>${s.crew ? pill(s.crew) : ""}</td><td></td><td></td><td class="pct">%</td><td></td></tr>`
          : `<tr><td></td><td></td><td class="pct">%</td><td></td></tr>`);
      }
      out.push(`</tbody>`);
    }
    out.push(`</table></section>`);
  }
  out.push(`</div>`);
  return out.join("\n");
}

/** The whole page, ready to print. */
export function fieldTrackerDocument(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>${FIELD_CSS}</style></head><body>${body}</body></html>`;
}
