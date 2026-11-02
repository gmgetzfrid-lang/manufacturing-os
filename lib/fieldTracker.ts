// fieldTracker - the pen-and-paper field tracker: a blank form printed once
// (at the start of the job, or for the work coming up on a long one) and
// filled in by hand. It carries only what's needed to find the work: each
// work order, its resources and plan, each step with its plan and resource.
// Nothing recorded is printed on it. Each step has lines to write its
// updates on (start, finish, %, notes); a step that runs out of lines gets
// a sheet of its own.
//
// Made to find a work order fast on a clipboard: the pages are laid out
// here (not left to the browser), so each page says "Page 3 of 14" and
// shows the work orders on it big in its top corner, a work order that
// runs onto the next page says so there, and page 1 lists every work
// order with its page. Work orders print in WO number order (or in plan
// order), each step whole on a page, no half-empty pages.
//
// Plain HTML with its own styles (FIELD_CSS), landscape, for a print window.

export interface FieldStep { id: string; name: string; crew: string; planStart: number; planFinish: number }
export interface FieldOrder { key: string; wo: string | null; name: string; crews: string[]; planStart: number; planFinish: number; steps: FieldStep[] }

/** Lines a step: "auto" from the step's own plan, or a set number (2 to 8). */
export type FieldLines = "auto" | number;
/** "wo": WO number order (work with no WO last); "plan": as planned. */
export type FieldSort = "wo" | "plan";

const H = 3_600_000, DAY = 24 * H;

/** Lines a step gets from how long a plan is: a few hours 2, half a day
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

/** The work orders in print order: by WO number (numbers in number order,
 *  work with no WO after them, as planned), or as planned. */
export function sortOrders(orders: FieldOrder[], by: FieldSort): FieldOrder[] {
  const plan = (a: FieldOrder, b: FieldOrder) => a.planStart - b.planStart || a.name.localeCompare(b.name);
  if (by === "plan") return [...orders].sort(plan);
  return [...orders].sort((a, b) => (a.wo ? 0 : 1) - (b.wo ? 0 : 1)
    || (a.wo && b.wo ? a.wo.localeCompare(b.wo, "en", { numeric: true }) : 0)
    || plan(a, b));
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const dateOf = (t: number, tz: string) => new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: tz });
const timeOf = (t: number, tz: string) => new Date(t).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: tz });
/** "Oct 26 10:00 AM to 12:00 PM" (one day), "Oct 26 10:00 AM to Oct 27 8:00 AM". */
export function planText(a: number, b: number, tz: string): string {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return "-";
  const da = dateOf(a, tz), db = dateOf(b, tz);
  return `${da} ${timeOf(a, tz)} to ${da === db ? "" : `${db} `}${timeOf(b, tz)}`;
}
const pill = (c: string) => `<span class="pill">${esc(c)}</span>`;
const woWord = (o: FieldOrder) => (o.wo ? `WO ${o.wo}` : "No WO");

// ── The page, in inches (letter landscape, .4in margins: 10.2 x 7.7) ──
// Text widths are estimated on the wide side so nothing wraps more than
// planned; every block's height is set from the same numbers.
const L = {
  /** What a page holds, with a little to spare. */
  page: 7.55,
  width: 10.2,
  /** The page's top line: title, the work orders on it, page n of N. */
  head: 0.56,
  how: 0.28,
  th: 0.27,
  row: 0.36,
  /** The work order's bar: padding, each line, and its borders. */
  barPad: 0.1, barLine: 0.23, barEdge: 0.03,
  idxHead: 0.5, idxRow: 0.215, idxGap: 0.14,
  /** Step column: 25% of the width, less its padding. */
  stepText: 0.25 * 10.2 - 0.14,
};
// Arial (and its look-alikes: Helvetica, Liberation Sans) character widths,
// in thousandths of the font size, for " " to "~"; a little extra on top.
const W_REG = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
const W_BOLD = [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584];
/** About how wide a text prints, in inches (on the wide side). */
export function textW(s: string, pt: number, bold = false): number {
  const t = bold ? W_BOLD : W_REG;
  let u = 0;
  for (const ch of s) { const c = ch.charCodeAt(0); u += c >= 32 && c <= 126 ? t[c - 32] : 640; }
  return (u / 1000) * (pt / 72) * 1.07;
}
/** Lines a text takes in a width (words kept whole unless one is wider than the line). */
export function wrapLines(s: string, pt: number, bold: boolean, width: number): number {
  const words = s.split(/\s+/).filter(Boolean);
  if (!words.length) return 1;
  const sp = textW(" ", pt, bold);
  let lines = 1, cur = 0;
  for (const w of words) {
    const ww = textW(w, pt, bold);
    if (cur > 0 && cur + sp + ww <= width) { cur += sp + ww; continue; }
    if (cur > 0) lines++;
    cur = ww;
    while (cur > width) { lines++; cur -= width; }
  }
  return lines;
}

/** Rows a step takes: its lines, or more if its name and plan need them. */
function stepRows(s: FieldStep, lines: number, tz: string): number {
  const need = 0.07 + wrapLines(s.name, 10, true, L.stepText) * 0.17 + wrapLines(`Plan ${planText(s.planStart, s.planFinish, tz)}`, 8, false, L.stepText) * 0.14 + 0.05 + (s.crew ? 0.19 : 0);
  return Math.max(lines, Math.ceil(need / L.row - 0.02));
}

/** The work order's bar: lines it takes (1 when it all fits on one line). */
function barLines(o: FieldOrder, tz: string): { lines: number; inline: boolean } {
  const w = L.width - 0.2;
  const left = textW(woWord(o), 13, true) + 0.15 + textW(o.name, 10.5, true);
  const right = (o.crews.length ? textW("Resources ", 8.5) + o.crews.reduce((n, c) => n + textW(c, 7.5, true) + 0.16, 0) + textW(" · ", 8.5) : 0) + textW(`Plan ${planText(o.planStart, o.planFinish, tz)}`, 8.5, true);
  if (left + right + 0.35 <= w) return { lines: 1, inline: true };
  return { lines: Math.ceil(left / w) + Math.ceil(right / w), inline: false };
}
const barH = (lines: number) => L.barPad + lines * L.barLine;
/** The bar's row on the page, borders and all. */
const barRow = (lines: number) => barH(lines) + L.barEdge;

export const FIELD_CSS = `
@page{size:letter landscape;margin:.4in}
*{box-sizing:border-box}
body{margin:0;-webkit-print-color-adjust:exact;print-color-adjust:exact;background:#fff}
@media screen{body.ftdoc{padding:.4in}.ft .pg{min-height:7.7in;border-bottom:1px dashed #cbd5e1;margin-bottom:.8in}}
.ft{font-family:Arial,Helvetica,sans-serif;color:#0f172a}
.ft .pg{break-after:page;page-break-after:always}
.ft .pg:last-child{break-after:auto;page-break-after:auto}
.ft .ph{height:${L.head - 0.08}in;margin-bottom:.08in;display:flex;justify-content:space-between;align-items:flex-end;gap:16px;border-bottom:2px solid #0f172a;padding-bottom:4px;overflow:hidden}
.ft .ph .tl{min-width:0;font-size:9.5pt;color:#334155;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ft .ph .tl b{font-size:13pt;color:#0f172a;margin-right:6px}
.ft .ph .gr{display:flex;align-items:baseline;gap:14px;white-space:nowrap}
.ft .ph .gw{font-size:18pt;font-weight:bold;letter-spacing:.2px}
.ft .ph .pn{font-size:10pt;font-weight:bold;color:#334155}
.ft .how{height:${L.how}in;font-size:8.5pt;color:#475569;overflow:hidden}
.ft .idx{margin-bottom:${L.idxGap}in}
.ft .idx .ih{height:${L.idxHead}in;display:flex;flex-direction:column;justify-content:flex-end}
.ft .idx .ih .h{font-size:11pt;font-weight:bold;margin-bottom:3px}
.ft .idx .ih .cols .ie{height:auto;border-bottom:1px solid #94a3b8;font-size:7.5pt;text-transform:uppercase;letter-spacing:.3px;color:#475569;font-weight:bold;padding-bottom:2px}
.ft .idx .cols{display:grid;grid-template-columns:1fr 1fr;column-gap:.35in}
.ft .idx .ie{height:${L.idxRow}in;display:grid;grid-template-columns:.8in 1fr .45in;align-items:center;gap:6px;border-bottom:1px dotted #cbd5e1;font-size:9pt}
.ft .idx .ie b{font-size:9.5pt}
.ft .idx .ie span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ft .idx .ie i{font-style:normal;font-weight:bold;text-align:right}
.ft .pill{display:inline-block;font-size:7.5pt;font-weight:bold;border:1px solid #64748b;border-radius:3px;padding:0 4px;color:#0f172a;background:#fff;margin:0 0 0 2px;white-space:nowrap}
.ft table{width:100%;border-collapse:collapse;table-layout:fixed}
.ft th{height:${L.th}in;font-size:8pt;text-transform:uppercase;letter-spacing:.3px;color:#334155;background:#f1f5f9;border:1px solid #94a3b8;padding:0 5px;text-align:left;vertical-align:middle}
.ft tr.r{height:${L.row}in}
.ft td{border:1px solid #94a3b8;padding:0 5px;vertical-align:top;font-size:9.5pt}
.ft tr.end td{border-bottom:2px solid #475569}
.ft td.step{padding:0}
.ft td.step .sc{padding:3px 6px;overflow-wrap:anywhere}
.ft td.step b{display:block;font-size:10pt;line-height:1.2}
.ft td.step .plan{color:#334155;font-size:8pt;line-height:1.25;margin:2px 0}
.ft td.step .pill{margin:0}
.ft td.pct{text-align:right;color:#94a3b8;font-size:8pt;vertical-align:bottom;padding-bottom:2px}
.ft tr.wo td{background:#e2e8f0;border:1px solid #94a3b8;border-top:2px solid #0f172a;padding:0}
.ft .bar{padding:${L.barPad / 2}in 7px;overflow-wrap:anywhere}
.ft .bar.in{display:flex;justify-content:space-between;align-items:center;gap:12px;white-space:nowrap}
.ft .bar .t{font-size:10.5pt;font-weight:bold;line-height:${L.barLine}in}
.ft .bar .t .n{font-size:12.5pt;line-height:1;margin-right:8px}
.ft .bar .m{font-size:8.5pt;color:#334155;line-height:${L.barLine}in}
.ft .bar .m .pill{line-height:1.2}
.ft .bar.in .m{text-align:right}
.ft .bar .m b{color:#0f172a}
.ft .bar .c{font-size:9pt;font-weight:normal;color:#334155;margin-left:8px}
.ft .sh{border:1px solid #94a3b8;border-top:none;padding:5px 7px;display:flex;justify-content:space-between;align-items:baseline;gap:12px}
.ft .sh b{font-size:12pt}
.ft .sh .m{font-size:8.5pt;color:#334155}
.ft .sh .m b{color:#0f172a;font-size:8.5pt}
.ft .one tr.r{height:.36in}
.ft .none{font-size:10pt;color:#475569;padding:12px 0}
`;

const COLS = `<colgroup><col style="width:25%"><col style="width:23%"><col style="width:23%"><col style="width:6%"><col style="width:23%"></colgroup>`;
const THEAD = `<thead><tr><th>Step &amp; plan</th><th>Start (date &amp; time)</th><th>Finish (date &amp; time)</th><th>%</th><th>Notes</th></tr></thead>`;

function barHtml(o: FieldOrder, tz: string, cont: number | null): { html: string; h: number } {
  const t = `<div class="t"><span class="n">${esc(woWord(o))}</span>${esc(o.name)}${cont != null ? `<span class="c">continued from page ${cont}</span>` : ""}</div>`;
  if (cont != null) {
    const lines = Math.max(1, Math.ceil((textW(woWord(o), 13, true) + 0.15 + textW(`${o.name} continued from page 99`, 10.5, true)) / (L.width - 0.2)));
    return { html: `<tr class="wo"><td colspan="5"><div class="bar" style="min-height:${barH(lines).toFixed(3)}in">${t}</div></td></tr>`, h: barRow(lines) };
  }
  const { lines, inline } = barLines(o, tz);
  const m = `<div class="m">${o.crews.length ? `Resources ${o.crews.map(pill).join(" ")} &nbsp;·&nbsp; ` : ""}Plan <b>${esc(planText(o.planStart, o.planFinish, tz))}</b></div>`;
  return { html: `<tr class="wo"><td colspan="5"><div class="bar${inline ? " in" : ""}" style="min-height:${barH(lines).toFixed(3)}in">${t}${m}</div></td></tr>`, h: barRow(lines) };
}

function stepHtml(s: FieldStep, rows: number, tz: string): string {
  const out: string[] = [];
  for (let r = 0; r < rows; r++) {
    const cls = r === rows - 1 ? "r end" : "r";
    out.push(r === 0
      ? `<tr class="${cls}"><td class="step" rowspan="${rows}"><div class="sc"><b>${esc(s.name)}</b><div class="plan">Plan ${esc(planText(s.planStart, s.planFinish, tz))}</div>${s.crew ? pill(s.crew) : ""}</div></td><td></td><td></td><td class="pct">%</td><td></td></tr>`
      : `<tr class="${cls}"><td></td><td></td><td class="pct">%</td><td></td></tr>`);
  }
  return out.join("");
}

/** The work orders on a page, for its top corner: up to four, then "+N". */
function guide(words: string[]): string {
  const u = [...new Set(words)];
  if (!u.length) return "";
  const nums = u.map((w) => w.replace(/^WO /, ""));
  const shown = nums.slice(0, 4).join(" · ");
  return `${u.every((w) => w.startsWith("WO ")) ? "WO " : ""}${shown}${u.length > 4 ? ` +${u.length - 4}` : ""}`;
}

interface Page { parts: string[]; words: string[]; used: number; table: boolean; index?: { from: number; to: number } }

/** The form, laid out page by page. `lines`: each step's lines; `sort`:
 *  WO number order (default) or plan order; `step`: one step's own sheet
 *  (its work order the only one in `orders`). */
export function fieldTrackerHtml(input: {
  project: string; tz: string; orders: FieldOrder[];
  lines: FieldLines;
  sort?: FieldSort;
  /** Work planned in a date range (the orders already narrowed to it). */
  range?: { from: number; to: number };
  step?: string;
  /** Lines on a one-step sheet: a page of them. */
  sheetLines?: number;
}): string {
  const { tz } = input;
  const title = input.step ? "Field tracker: one step" : input.range ? `Field tracker: ${dateOf(input.range.from, tz)} to ${dateOf(input.range.to - 1, tz)}` : "Field tracker";
  const head = (n: number, of: number, words: string[]) => `<div class="ph"><div class="tl"><b>${esc(input.project)}</b>${esc(title)}</div><div class="gr"><span class="gw">${esc(guide(words))}</span><span class="pn">Page ${n} of ${of}</span></div></div>`;

  if (input.step) {
    const o = input.orders[0], s = o?.steps.find((x) => x.id === input.step);
    if (!o || !s) return `<div class="ft"><section class="pg">${head(1, 1, [])}<div class="none">That step isn't on the schedule.</div></section></div>`;
    const rows: string[] = [];
    for (let i = 0; i < (input.sheetLines ?? 16); i++) rows.push(`<tr class="r"><td></td><td></td><td class="pct">%</td><td></td></tr>`);
    return `<div class="ft"><section class="pg one">${head(1, 1, [woWord(o)])}<table>${COLS}<tbody>${barHtml(o, tz, null).html}</tbody></table>`
      + `<div class="sh"><b>${esc(s.name)}</b><span class="m">${s.crew ? `Resource ${pill(s.crew)} &nbsp;·&nbsp; ` : ""}Plan <b>${esc(planText(s.planStart, s.planFinish, tz))}</b></span></div>`
      + `<table><colgroup><col style="width:31%"><col style="width:31%"><col style="width:8%"><col style="width:30%"></colgroup><thead><tr><th>Start (date &amp; time)</th><th>Finish (date &amp; time)</th><th>%</th><th>Notes</th></tr></thead><tbody>${rows.join("")}</tbody></table></section></div>`;
  }

  const orders = sortOrders(input.orders, input.sort ?? "wo");
  const pages: Page[] = [];
  const fresh = (): Page => { const p: Page = { parts: [], words: [], used: L.head, table: false }; pages.push(p); return p; };
  let pg = fresh();
  pg.parts.push(`<div class="how">Write each update by hand: Start and Finish as date and time, the % at that update, and anything worth noting. A step that runs out of lines: print it a sheet of its own.</div>`);
  pg.used += L.how;
  if (!orders.length) pg.parts.push(`<div class="none">No work ${input.range ? "planned in these dates" : "on the schedule"}.</div>`);

  // The index: every work order and its page, in two columns, on page 1
  // (and the pages after it, on a job with a great many).
  const showIndex = orders.length > 1;
  if (showIndex) {
    let i = 0;
    while (i < orders.length) {
      const fit = Math.floor((L.page - pg.used - L.idxHead - L.idxGap) / L.idxRow) * 2;
      if (fit < 2) { pg = fresh(); continue; }
      const n = Math.min(fit, orders.length - i);
      pg.index = { from: i, to: i + n };
      pg.parts.push(`<!--index-->`);
      pg.used += L.idxHead + Math.ceil(n / 2) * L.idxRow + L.idxGap;
      i += n;
      if (i < orders.length) pg = fresh();
    }
  }

  const firstPage = new Map<string, number>();
  const room = () => L.page - pg.used - (pg.table ? 0 : L.th);
  const put = (html: string, h: number, word: string) => {
    if (!pg.table) { pg.parts.push(`<table>${COLS}${THEAD}<tbody>`); pg.used += L.th; pg.table = true; }
    pg.parts.push(html); pg.used += h; pg.words.push(word);
  };
  const turn = () => { if (!pg.parts.length) return; if (pg.table) pg.parts.push(`</tbody></table>`); pg = fresh(); };

  for (const o of orders) {
    const word = woWord(o);
    const bar = barHtml(o, tz, null);
    const steps = o.steps.map((s) => {
      const span = input.range ? Math.min(s.planFinish, input.range.to) - Math.max(s.planStart, input.range.from) : s.planFinish - s.planStart;
      const n = input.lines === "auto" ? linesFor(span) : Math.max(2, Math.min(8, Math.round(input.lines)));
      const rows = stepRows(s, n, tz);
      return { html: stepHtml(s, rows, tz), h: rows * L.row };
    });
    const whole = bar.h + steps.reduce((n, s) => n + s.h, 0);
    const blank = L.page - L.head - L.th;
    // A short work order stays on one page; any other starts where there's
    // room for its bar and first step, and carries on over the page.
    const first = bar.h + (steps[0]?.h ?? 0);
    if ((whole <= blank * 0.5 && whole > room()) || first > room()) turn();
    firstPage.set(o.key, pages.length);
    put(bar.html, bar.h, word);
    for (const s of steps) {
      if (s.h > room()) {
        turn();
        const c = barHtml(o, tz, firstPage.get(o.key)!);
        put(c.html, c.h, word);
      }
      put(s.html, s.h, word);
    }
  }
  if (pg.table) pg.parts.push(`</tbody></table>`);
  // A page left holding only the index's tail and nothing else is fine; an
  // empty last page isn't.
  while (pages.length > 1 && !pages[pages.length - 1].parts.length) pages.pop();

  const of = pages.length;
  const indexHtml = (from: number, to: number) => {
    const list = orders.slice(from, to);
    const half = Math.ceil(list.length / 2);
    const col = (xs: FieldOrder[]) => `<div>${xs.map((o) => `<div class="ie"><b>${esc(o.wo ?? "No WO")}</b><span>${esc(o.name)}</span><i>${firstPage.get(o.key) ?? ""}</i></div>`).join("")}</div>`;
    const labels = `<div class="ie"><span>WO</span><span>Work order</span><span style="text-align:right">Page</span></div>`;
    return `<div class="idx"><div class="ih"><div class="h">Find a work order${from > 0 ? " (continued)" : ""}</div><div class="cols">${labels}${list.length > 1 ? labels : "<div></div>"}</div></div><div class="cols">${col(list.slice(0, half))}${col(list.slice(half))}</div></div>`;
  };
  const out = pages.map((p, i) => {
    const body = p.parts.map((x) => (x === "<!--index-->" && p.index ? indexHtml(p.index.from, p.index.to) : x)).join("\n");
    return `<section class="pg">${head(i + 1, of, p.words)}${body}</section>`;
  });
  return `<div class="ft">${out.join("\n")}</div>`;
}

/** Pages in a form made here. */
export const fieldPages = (html: string) => (html.match(/<section class="pg/g) ?? []).length;

/** The whole page, ready to print. */
export function fieldTrackerDocument(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>${FIELD_CSS}</style></head><body class="ftdoc">${body}</body></html>`;
}

/** The form for a choice (whole job, one work order, one step, a date
 *  range), as a page ready to print. `dayMs`: a plant day's start. */
export function fieldTrackerFor(c: { kind: "job"; lines: FieldLines; sort?: FieldSort } | { kind: "wo"; key: string; lines: FieldLines } | { kind: "step"; key: string; step: string } | { kind: "range"; from: string; to: string; lines: FieldLines; sort?: FieldSort },
  o: { project: string; tz: string; orders: FieldOrder[]; dayMs: (day: string) => number }): string {
  const { project, tz, orders } = o;
  const one = (k: string) => orders.filter((x) => x.key === k);
  const body = c.kind === "step" ? fieldTrackerHtml({ project, tz, orders: one(c.key), lines: "auto", step: c.step })
    : c.kind === "wo" ? fieldTrackerHtml({ project, tz, orders: one(c.key), lines: c.lines })
      : c.kind === "range" ? (() => { const range = { from: o.dayMs(c.from), to: o.dayMs(c.to) + 86_400_000 }; return fieldTrackerHtml({ project, tz, orders: inRange(orders, range.from, range.to), lines: c.lines, sort: c.sort, range }); })()
        : fieldTrackerHtml({ project, tz, orders, lines: c.lines, sort: c.sort });
  return fieldTrackerDocument(`${project} - Field tracker`, body);
}
