// reviewFiles - the post-event review as files: a Word report for the
// project file, and the meeting slides as an editable PowerPoint. Both are
// written from the review as it stands (lib/postEventReview) in the order
// an event review is run (lib/reviewBook): the score, the seven areas, the
// action plan. The records behind each line are in the report.
//
// One set of words drives both, so the report and the deck never disagree.

import JSZip from "jszip";
import { noEmDash } from "@/lib/noEmDash";
import { fmtInTz } from "@/lib/scheduleTz";
import { CAUSE_WORD, areaOf, jobWord, orderWord, pointOf, shiftsWord, whenWord, type Finding, type Review } from "@/lib/postEventReview";
import { MIN_WAIT_H, overloaded, type CrewFlow } from "@/lib/crewFlow";
import { AREA_STATE_WORD, GUIDES, VERDICT_WORD, bookOf, guidesOf, type AreaState, type Book, type Guide, type ScoreInputs, type Verdict } from "@/lib/reviewBook";

export interface ReviewFileOpts {
  project: string;
  /** The phase the review is of, when the project has phases. */
  phase: string | null;
  tz: string;
  preparedBy: string | null;
  /** "November 12, 2026". */
  date: string;
  /** Man-hours, incidents, cost and what a person entered, for the score. */
  score?: ScoreInputs;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const live = (r: Review) => r.findings.filter((f) => f.status !== "discarded");
const toClose = (r: Review) => live(r).filter((f) => f.rating === "gap" || f.rating === "opportunity");
/** What the review is of: the phase when the project has phases (the
 *  project's own name can carry both phases and reads as the wrong dates). */
const eventName = (o: ReviewFileOpts) => o.phase ?? o.project;
/** "October 24 to November 2, 2026": the work's own dates, from the records. */
export function eventDates(r: Review, tz: string): string {
  const { start, actualFinish: end } = r.metrics;
  if (start == null) return "";
  const day = (t: number, year: boolean) => fmtInTz(t, tz, { month: "long", day: "numeric", ...(year ? { year: "numeric" } : {}) });
  if (end == null) return `${day(start, true)}, not finished yet`;
  const sameYear = fmtInTz(start, tz, { year: "numeric" }) === fmtInTz(end, tz, { year: "numeric" });
  return `${day(start, !sameYear)} to ${day(end, true)}`;
}
/** Which project it belongs to, and that it covers one phase only. */
const projectLine = (o: ReviewFileOpts) => (o.phase ? `Project: ${o.project}. This review covers ${o.phase} only.` : "");

// ─── The words both files share ────────────────────────────────────

const facts = (f: Finding) => [...f.observation.split("\n").map((l) => l.trim()).filter(Boolean), ...f.info];
const point = (r: Review, o: ReviewFileOpts) => pointOf(r, eventName(o), o.tz);
export const bookFor = (r: Review, o: ReviewFileOpts): Book => bookOf(r, eventName(o), o.tz, o.score ?? {});
const NOT_SET = "Not set";
const scopeLine = (r: Review) => { const m = r.metrics; return m.steps ? `${m.baselineDone} of ${m.baselineSteps} planned activities completed${m.addedSteps ? `, plus ${m.addedDone} of ${m.addedSteps} added from ${plural(r.found.length, "finding")}` : ""}.` : ""; };
/** Against its planned start: "22 h late", "2 h early", "on plan". */
const planWord = (h: number | null) => (h == null ? "" : Math.abs(h) < 1 ? "On plan" : `${Math.abs(h)} h ${h > 0 ? "late" : "early"}`);
/** Every job handed to a crew: when it was open, when the crew started it, how long it sat. */
const plainStep = (n: string) => n.replace(/\s*\([^)]*\)/g, "").replace(/[()]/g, "").trim();
const crewRows = (f: CrewFlow, tz: string): string[][] => f.jobs.map((j) => [jobWord(j), `${plainStep(j.after)} done${j.afterOrder !== j.order ? ` (${orderWord(j.afterOrder)})` : ""}${j.basis === "guessed" ? ", no link in the schedule" : j.basis === "corrected" ? ", as corrected" : ""}`, whenWord(j.openedAt, tz), whenWord(j.startedAt, tz), j.waitH >= 1 ? `${j.waitH} h` : "None", planWord(j.lateStartH)]);
const crewHead = (f: CrewFlow) => ["Job", "Ready when", "Ready from", `${f.crew} started`, "Waited", "Start against plan"];
/** Each crew that was handed work by another: how many jobs, how many of them
 *  waited for it, the longest one, and the most it had open at once. No hours
 *  are added across jobs: a sum of job waits reads as the crew sitting idle. */
export const crewsRows = (r: Review): string[][] => r.flows.filter((f) => f.jobs.length >= 2).map((f) => [f.crew, String(f.jobs.length), f.waited.length ? `${f.waited.length} of ${f.jobs.length}` : "None", f.waited.length ? `${f.waited[0].waitH} h (${orderWord(f.waited[0].order)})${f.waited[0].basis === "guessed" ? ", no link in the schedule" : ""}` : "None", `${f.peak.open}${f.plannedPeak ? ` (plan ${f.plannedPeak})` : ""}`]);
export const CREWS_HEAD = ["Crew", "Jobs handed to it", `Jobs that waited ${MIN_WAIT_H} h or more for it`, "Longest a job waited", "Most open at once"];
export const CREWS_TITLE = "Jobs that waited for each crew";
export const CREWS_NOTE = "These are jobs waiting for the crew to get to them. They are not hours the crew sat idle.";
/** Every work order that finished late: by how much, and where the record shows the hours going. */
const lateRows = (r: Review): string[][] => r.late.filter((o) => !o.told).map((o) => [orderWord(o.order), `${o.lateH} h${o.added ? " (added work)" : ""}`, o.parts.slice(0, 3).map((p) => (p.kind === "over" ? `${p.step.replace(/\s*\([^)]*\)/g, "").replace(/[()]/g, "").trim()}: open ${p.tookH} h, progress logged on ${plural(p.workedShifts, "shift")}, planned as ${p.plannedH} h of work (${p.crew})` : p.kind === "wait" ? `${p.step.replace(/\s*\([^)]*\)/g, "").replace(/[()]/g, "").trim()} sat ${p.hours} h before ${p.crew} started it` : `Started ${p.hours} h after its planned start`)).join("; ") || "Not shown by the record"]);
const LATE_HEAD = ["Work order", "Finished after its plan by", "Where the time went"];

const metricRows = (r: Review): string[][] => {
  const m = r.metrics;
  return [
    ["Finish against the baseline", m.varianceH == null ? "Not finished" : `${m.varianceH > 0 ? "+" : ""}${m.varianceH} h`, "Last activity finished, minus the baseline finish"],
    ["Planned activities completed", `${m.baselineDone} of ${m.baselineSteps}`, "Activities on the schedule when the plan was saved"],
    ["Added activities", m.addedSteps ? `${m.addedSteps} (from ${plural(r.found.length, "finding")})` : "None", "Added during the event from a finding"],
    ["Scope growth", m.addedPct == null ? "Not known" : `${m.addedPct}% (${m.addedH} h on ${m.baselineH} h)`, "Planned hours of added work over planned hours of the baseline"],
    ["Started jobs that sat a shift", `${plural(m.stuckJobs, "job")}, ${plural(m.stuckShifts, "shift")} in all`, "Started, not finished, nothing logged for a whole shift; equipment out for service not counted"],
    ["Ready jobs not started", `${plural(m.readyJobs, "job")}, ${plural(m.readyShifts, "shift")} in all`, "Everything before it done; did not start that shift"],
    ["Labor hours on added work", m.labor ? `${m.labor.pct}% (${m.labor.addedMH} of ${m.labor.totalMH} h)` : "Not known", m.labor ? "Shift head counts times tool hours, shared across the work moved" : `A head count was written down on ${m.headCounts.shiftsCounted} of ${m.headCounts.shiftsWorked} shifts worked`],
  ];
};
/** Every job that waited, one row each: what happened, when, and why. */
const waitedRows = (r: Review): string[][] => [
  ...r.stuck.map((j) => [jobWord(j), j.crew, "Started, then sat", shiftsWord(j.shifts.map((s) => s.key)), [...new Set(j.shifts.map((s) => `${CAUSE_WORD[s.cause]}${s.said ? `: "${s.said}"` : s.crewOn.length ? ` (crew on ${[...new Set(s.crewOn.map(orderWord))].join(", ")})` : ""}`))].join(" Then: ")]),
  ...r.ready.map((j) => [jobWord(j), j.crew, "Ready, not started", shiftsWord(j.shifts), j.said ?? (j.busyOn.length ? `Crew was on ${[...new Set(j.busyOn.map(orderWord))].join(", ")}` : j.crewLogged ? "Crew was on other work" : "No work logged by this crew")]),
  ...r.service.map((j) => [jobWord(j), j.crew, "Out for service (planned)", shiftsWord(j.shifts), `"${j.said}"${j.stillOut ? ` Still out past the time quoted: "${j.stillOut.said}"` : " Back as planned."}`]),
];
const foundRows = (r: Review) => r.found.map((f) => [f.what, orderWord(f.on), String(f.steps), `${f.hours} h`, f.critical ? "Yes" : "No", f.approvedBy ?? "Not recorded"]);
const SOURCES = "Sources: the baseline schedule; progress logged by shift; comments and hold reasons on each job; added-work records with their approver; shift meeting head counts; answers given in the review.";

// ─── Word ──────────────────────────────────────────────────────────

type Block =
  | { k: "title" | "h1" | "h2" | "p" | "muted" | "bullet"; text: string; lead?: string }
  | { k: "num"; text: string; n: number; lead?: string }
  | { k: "table"; head: string[]; rows: string[][]; widths: number[] };

/** The report, top to bottom: what the event showed and what changes, then
 *  the records behind each. */
export function reportBlocks(r: Review, o: ReviewFileOpts): Block[] {
  const b: Block[] = [];
  const m = r.metrics, pt = point(r, o);
  const dates = eventDates(r, o.tz);
  b.push({ k: "muted", text: "POST-EVENT REVIEW" }, { k: "title", text: dates ? `${eventName(o)}: ${dates}` : eventName(o) });
  if (projectLine(o)) b.push({ k: "muted", text: projectLine(o) });
  b.push({ k: "muted", text: [o.preparedBy ? `Prepared by: ${o.preparedBy}` : null, `Written ${o.date}`].filter(Boolean).join("  ·  ") });

  const bk = bookFor(r, o);
  b.push({ k: "h1", text: `1. ${pt.headline}` });
  b.push({ k: "p", text: [pt.span, scopeLine(r)].filter(Boolean).join(" ") });
  if (bk.delayLines.length) { b.push({ k: "p", lead: `${bk.delay.split(":")[0]}: `, text: "" }); for (const l of bk.delayLines) b.push({ k: "bullet", text: l }); }

  b.push({ k: "h1", text: "2. The score: plan against actual" });
  if (bk.score.line) b.push({ k: "p", text: bk.score.line });
  b.push({ k: "table", head: ["Measure", "Target", "Actual", "Result", "Verdict"], rows: bk.score.rows.map((x) => [x.measure, x.plan, x.actual, x.result, VERDICT_WORD[x.verdict]]), widths: [1.1, 1.9, 2.4, 1.3, 1.0] });

  b.push({ k: "h1", text: "3. What went well, what did not, and why" });
  for (const a of bk.areas) {
    b.push({ k: "h2", text: `${a.name}: ${a.tag.toLowerCase()}` });
    for (const w of a.well) b.push({ k: "bullet", lead: "Went well: ", text: w });
    for (const it of a.items) {
      b.push({ k: "bullet", lead: "Did not: ", text: it.didNot });
      if (it.rootCause) b.push({ k: "bullet", lead: "Root cause: ", text: it.rootCause });
      b.push({ k: "bullet", lead: "Action: ", text: `No. ${it.action} in the action plan.` });
    }
    if (a.pending) b.push({ k: "bullet", text: `${a.pending === 1 ? "1 finding waits" : `${a.pending} findings wait`} for a decision in the review.` });
    if (a.state === "none") b.push({ k: "p", text: `Nothing was recorded for this event.${a.guide ? ` How to set it up is in the last appendix (${GUIDES[a.guide].title.toLowerCase()}).` : ""}` });
  }

  b.push({ k: "h1", text: "4. The action plan" });
  if (bk.actions.length) b.push({ k: "table", head: ["No.", "What we will do", "How it will be done", "Benefit", "Who", "By", "Cost"], rows: bk.actions.map((a) => [String(a.n), a.what, a.how, a.benefit, a.who || NOT_SET, a.by || NOT_SET, a.cost || NOT_SET]), widths: [0.35, 1.7, 1.9, 1.6, 0.8, 0.65, 0.65] });
  else b.push({ k: "p", text: pt.pending.length ? "No action has been accepted in the review yet." : "Nothing in the records calls for a change." });
  if (pt.pending.length) { b.push({ k: "h2", text: "Waiting for a decision in the review" }); for (const c of pt.pending) b.push({ k: "bullet", text: `${c.title}.` }); }

  const close = toClose(r);
  b.push({ k: "h1", text: "5. Each finding, with the record behind it" });
  if (!close.length) b.push({ k: "p", text: "None." });
  close.forEach((f, i) => {
    b.push({ k: "h2", text: `${i + 1}. ${f.title}` });
    b.push({ k: "p", lead: "What justifies a change: ", text: f.why || f.effect || "Not written." });
    if (f.effect && f.effect !== f.why) b.push({ k: "p", lead: "What it cost: ", text: f.effect });
    b.push({ k: "p", lead: `How it is done well (${areaOf(f.category).name}): `, text: f.practice });
    if (f.gap) b.push({ k: "p", lead: "Root cause: ", text: f.gap });
    if (f.next) b.push({ k: "p", lead: "What we will do: ", text: f.next });
    if (f.year) b.push({ k: "p", lead: "Longer term: ", text: f.year });
    if (f.owner) b.push({ k: "p", lead: "Who: ", text: f.owner });
    if (f.due) b.push({ k: "p", lead: "By: ", text: f.due });
    if (f.cost) b.push({ k: "p", lead: "Cost: ", text: f.cost });
    b.push({ k: "p", lead: "From the records:", text: "" });
    for (const l of facts(f)) b.push({ k: "bullet", text: l });
  });

  const quiet = live(r).filter((f) => f.rating === "none" && f.source === "records" && f.moved === 0);
  let n = 6;
  if (quiet.length || pt.quiet.length) {
    b.push({ k: "h1", text: `${n++}. What happened that did not move the finish` });
    for (const f of quiet) { b.push({ k: "h2", text: f.title }); for (const l of facts(f)) b.push({ k: "bullet", text: l }); if (f.next) b.push({ k: "p", text: f.next }); }
    for (const t of pt.quiet.filter((t) => !quiet.some((f) => f.title === t))) b.push({ k: "bullet", text: `${t}.` });
  }

  b.push({ k: "h1", text: `${n++}. The event in numbers` });
  b.push({ k: "table", head: ["Measure", "Result", "How it is counted"], rows: metricRows(r), widths: [2.0, 2.0, 2.9] });
  if (r.measures.some((x) => x.set)) b.push({ k: "table", head: ["Measure", "This event", "Target for the next event"], rows: r.measures.filter((x) => x.set).map((x) => [x.measure, x.result, x.target]), widths: [3.4, 1.7, 1.8] });

  if (r.organization) {
    const o2 = r.organization;
    b.push({ k: "h1", text: `${n++}. Event organization` });
    b.push({ k: "p", text: `${o2.filled} of ${o2.required} required roles have a named person${o2.missing.length ? `. Not named: ${o2.missing.join(", ")}` : ""}.` });
    b.push({ k: "table", head: ["Role", "Named", "Responsible for", "Required"], rows: o2.roles.map((x) => [x.role, x.person || "Not named", x.does, x.required ? "Yes" : "No"]), widths: [2.0, 1.6, 2.7, 0.6] });
  }

  let ap = 0; const letter = () => String.fromCharCode(65 + ap++);
  for (const f of r.flows.filter(overloaded)) {
    b.push({ k: "h1", text: `Appendix ${letter()}. What waited for ${f.crew}` });
    b.push({ k: "table", head: crewHead(f), rows: crewRows(f, o.tz), widths: [1.6, 1.7, 1.0, 1.0, 0.7, 0.9] });
  }
  if (lateRows(r).length) {
    b.push({ k: "h1", text: `Appendix ${letter()}. Other work orders that finished after their plan` });
    b.push({ k: "table", head: LATE_HEAD, rows: lateRows(r), widths: [1.8, 1.1, 4.0] });
    b.push({ k: "muted", text: "Work orders that finished 8 h or more after their plan and are not told in a finding above. Open hours are not hours worked." });
  }
  if (crewsRows(r).length) {
    b.push({ k: "h1", text: `Appendix ${letter()}. ${CREWS_TITLE}` });
    b.push({ k: "table", head: CREWS_HEAD, rows: crewsRows(r), widths: [1.5, 1.0, 1.4, 1.9, 1.1] });
    b.push({ k: "muted", text: `Jobs handed to a crew by another crew (opened by one, cleaned or inspected by the next). ${CREWS_NOTE}` });
  }
  b.push({ k: "h1", text: `Appendix ${letter()}. Found work (${plural(r.found.length, "finding")}, ${plural(m.addedSteps, "activity", "activities")})` });
  if (r.found.length) b.push({ k: "table", head: ["Finding", "Where", "Activities", "Work when approved", "Critical path", "Approved by"], rows: foundRows(r), widths: [2.8, 0.9, 0.7, 1.0, 0.7, 0.8] }); else b.push({ k: "p", text: "None." });
  b.push({ k: "h1", text: `Appendix ${letter()}. Jobs that sat a shift` });
  if (waitedRows(r).length) b.push({ k: "table", head: ["Job", "Crew", "What happened", "When", "Why, from the record"], rows: waitedRows(r), widths: [1.7, 0.9, 1.1, 1.0, 2.2] }); else b.push({ k: "p", text: "None." });
  b.push({ k: "muted", text: "Night shifts count only for work that ran on nights. Equipment out for repair or calibration is a planned step, not waiting." });
  const guides = guidesOf(bk);
  if (guides.length) {
    b.push({ k: "h1", text: `Appendix ${letter()}. How to set up what was not measured` });
    for (const g of guides) {
      b.push({ k: "h2", text: g.title });
      b.push({ k: "p", text: g.what });
      g.steps.forEach((t, i) => b.push({ k: "num", n: i + 1, text: t }));
      b.push({ k: "p", lead: "In the app: ", text: g.inApp });
    }
  }
  b.push({ k: "h1", text: `Appendix ${letter()}. Anticipated questions` });
  for (const x of r.qa) b.push({ k: "p", lead: `${x.q} `, text: x.a });
  b.push({ k: "h1", text: `Appendix ${letter()}. How each number is counted` });
  b.push({ k: "table", head: ["Measure", "What it means"], rows: r.definitions.map((d) => [d.measure, d.means]), widths: [2.2, 4.7] });
  b.push({ k: "muted", text: SOURCES });
  return b;
}

const xe = (s: string) => noEmDash(s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const FONT = "Calibri";
const run = (t: string, o: { b?: boolean; sz?: number; color?: string } = {}) =>
  `<w:r><w:rPr><w:rFonts w:ascii="${FONT}" w:hAnsi="${FONT}" w:cs="${FONT}"/>${o.b ? "<w:b/>" : ""}${o.color ? `<w:color w:val="${o.color}"/>` : ""}<w:sz w:val="${(o.sz ?? 10.5) * 2}"/></w:rPr><w:t xml:space="preserve">${xe(t)}</w:t></w:r>`;
const para = (inner: string, o: { before?: number; after?: number; ind?: number; hang?: number; keep?: boolean } = {}) =>
  `<w:p><w:pPr>${o.keep ? "<w:keepNext/>" : ""}<w:spacing w:before="${Math.round((o.before ?? 0) * 20)}" w:after="${Math.round((o.after ?? 4) * 20)}"/>${o.ind ? `<w:ind w:left="${o.ind}"${o.hang ? ` w:hanging="${o.hang}"` : ""}/>` : ""}</w:pPr>${inner}</w:p>`;
const ACCENT = "B8430F", DARK = "16202E", MUTED = "5B6474";

function blockXml(b: Block): string {
  switch (b.k) {
    case "title": return para(run(b.text, { b: true, sz: 20, color: DARK }), { after: 4 });
    case "h1": return para(run(b.text, { b: true, sz: 13, color: DARK }), { before: 12, after: 4, keep: true });
    case "h2": return para(run(b.text, { b: true, sz: 11, color: ACCENT }), { before: 8, after: 3, keep: true });
    case "muted": return para(run(b.text, { sz: 9, color: MUTED }), { after: 5 });
    case "p": return para(`${b.lead ? run(b.lead, { b: true }) : ""}${run(b.text)}`, { after: 3 });
    case "bullet": return para(`${run("•\t")}${b.lead ? run(b.lead, { b: true }) : ""}${run(b.text)}`, { ind: 360, hang: 240, after: 3 });
    case "num": return para(`${run(`${b.n}.\t`)}${b.lead ? run(b.lead, { b: true }) : ""}${run(b.text)}`, { ind: 400, hang: 300, after: 2 });
    case "table": {
      const tw = b.widths.map((w) => Math.round(w * 1440));
      const cell = (t: string, i: number, head: boolean, shade: boolean) =>
        `<w:tc><w:tcPr><w:tcW w:w="${tw[i]}" w:type="dxa"/>${head ? `<w:shd w:val="clear" w:color="auto" w:fill="${DARK}"/>` : shade ? '<w:shd w:val="clear" w:color="auto" w:fill="F1F3F6"/>' : ""}</w:tcPr>${para(run(t, { sz: 9, b: head, color: head ? "FFFFFF" : undefined }), { after: 1, before: 1 })}</w:tc>`;
      const border = (n: string) => `<w:${n} w:val="single" w:sz="4" w:space="0" w:color="D5D9E0"/>`;
      const rows = [`<w:tr><w:trPr><w:tblHeader/><w:cantSplit/></w:trPr>${b.head.map((h, i) => cell(h, i, true, false)).join("")}</w:tr>`,
        ...b.rows.map((r, ri) => `<w:tr><w:trPr><w:cantSplit/></w:trPr>${b.head.map((_, i) => cell(r[i] ?? "", i, false, ri % 2 === 1)).join("")}</w:tr>`)];
      return `<w:tbl><w:tblPr><w:tblW w:w="${tw.reduce((a, c) => a + c, 0)}" w:type="dxa"/><w:tblBorders>${["top", "left", "bottom", "right", "insideH", "insideV"].map(border).join("")}</w:tblBorders><w:tblLayout w:type="fixed"/><w:tblCellMar><w:left w:w="80" w:type="dxa"/><w:right w:w="80" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid>${tw.map((w) => `<w:gridCol w:w="${w}"/>`).join("")}</w:tblGrid>${rows.join("")}</w:tbl>${para("", { after: 4 })}`;
    }
  }
}

/** The report as a Word file. */
export async function reviewDocx(r: Review, o: ReviewFileOpts): Promise<Uint8Array> {
  const body = reportBlocks(r, o).map(blockXml).join("");
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  const footer = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:ftr ${W}><w:p><w:pPr><w:jc w:val="right"/></w:pPr>${run(`${eventName(o)} · Post-event review · page `, { sz: 8, color: MUTED })}<w:r><w:rPr><w:sz w:val="16"/><w:color w:val="${MUTED}"/></w:rPr><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:rPr><w:sz w:val="16"/><w:color w:val="${MUTED}"/></w:rPr><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:r><w:rPr><w:sz w:val="16"/><w:color w:val="${MUTED}"/></w:rPr><w:fldChar w:fldCharType="end"/></w:r></w:p></w:ftr>`;
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body>${body}<w:sectPr><w:footerReference w:type="default" r:id="rId1"/><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1080" w:right="1080" w:bottom="1080" w:left="1080" w:header="500" w:footer="500" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  const zip = new JSZip();
  zip.file("[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/></Types>');
  zip.file("_rels/.rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file("word/_rels/document.xml.rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/></Relationships>');
  zip.file("word/document.xml", doc);
  zip.file("word/footer1.xml", footer);
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

// ─── PowerPoint ────────────────────────────────────────────────────
//
// A short deck that makes its point first: what set the finish, then what
// we change next time. The jobs behind it are backup. Nothing is on a slide
// that someone outside the system can't read cold.

export type SlideItem = string | { text: string; sub?: boolean; bold?: boolean };
export type Tone = "bad" | "warn" | "good" | "none";
export interface SlideTag { text: string; tone: Tone }
/** What is behind a line on a slide: the record, or how to set it up. */
export interface SlideMore { title: string; sections: Array<{ title: string; lines: string[]; numbered?: boolean }> }
/** The type size a slide table is set in, by how much there is to read: as large as fills the slide. */
export const tablePt = (rows: string[][]) => { const c = rows.reduce((n, r) => n + r.join("").length, 0) + rows.length * 30; return c > 1900 ? 10 : c > 1550 ? 11 : c > 1250 ? 12 : c > 1000 ? 13 : c > 780 ? 14 : 15; };
export const TONE_HEX: Record<Tone, { fg: string; bg: string }> = { bad: { fg: "A3200F", bg: "F8DFD9" }, warn: { fg: "7A4D00", bg: "F6E6C2" }, good: { fg: "1C6240", bg: "DCECDF" }, none: { fg: "5D6675", bg: "E2DED4" } };
const VERDICT_TONE: Record<Verdict, Tone> = { met: "good", missed: "bad", unmeasured: "none", untargeted: "warn", open: "none" };
const STATE_TONE: Record<AreaState, Tone> = { finish: "bad", time: "warn", improve: "warn", pending: "none", well: "good", none: "none" };
const guideMore = (g: Guide): SlideMore => ({ title: g.title, sections: [{ title: "What it is", lines: [g.what] }, { title: "How to set it up", lines: g.steps, numbered: true }, { title: "In the app", lines: [g.inApp] }] });
export type SlidePane = { title: string; items?: SlideItem[]; table?: { head: string[]; rows: string[][]; widths: number[]; title?: string } };
type Item = SlideItem;
type Pane = SlidePane;
export interface SlideSpec {
  kicker: string; title: string; notes: string;
  body:
    | { k: "cover"; sub: string; meta: string; agenda: string[] }
    | { k: "asks"; items: Array<{ n: number; ask: string; because: string }>; foot?: string }
    | { k: "table"; head: string[]; rows: string[][]; widths: number[]; foot?: string;
        /** A colored word under each row's first cell ("Missed"). */
        tags?: Array<SlideTag | null>;
        /** What opens when a row is tapped: the record or the how-to behind it. */
        more?: Array<SlideMore | null>;
        /** Counts above the table (the score). */
        tally?: Array<{ n: number; label: string; tone: Tone }>;
        /** One line said above the table ("Where the 33.5 h went: ..."). */
        lead?: string }
    | { k: "split"; left: Pane; right: Pane; ratio?: number; foot?: string };
}

const part = (i: number, n: number) => (n > 1 ? ` (${i + 1} of ${n})` : "");

/** The deck, slide by slide (what the PowerPoint is drawn from), in the order
 *  the review is run: the cover, the score (plan against actual), the seven
 *  areas (went well, did not, root cause, action), and the action plan (what,
 *  how, benefit, who, by what date, cost). Each thing is said once. The record
 *  behind a line opens from the line in the app, and is in the report. */
export function deckSlides(r: Review, o: ReviewFileOpts): SlideSpec[] {
  const s: SlideSpec[] = [], pt = point(r, o), bk = bookFor(r, o);
  const dates = eventDates(r, o.tz);
  const byKey = new Map(r.findings.map((f) => [f.key, f]));
  s.push({ kicker: "Post-event review", title: dates ? `${eventName(o)}: ${dates}` : eventName(o), notes: "The score, then what went well and what did not by area, then what we do about it.",
    body: { k: "cover", sub: projectLine(o), meta: [o.preparedBy, `Written ${o.date}`].filter(Boolean).join("  ·  "), agenda: ["The score: plan against actual", "What went well, what did not, and why", "What we do about it"] } });

  // 1. The score.
  const sc = bk.score;
  s.push({
    kicker: "1 · The score: plan against actual", title: pt.headline, notes: [pt.headline, sc.line].filter(Boolean).join(" "),
    body: {
      k: "table", head: ["Measure", "Target", "Actual", "Result"], widths: [1.4, 2.4, 3.4, 1.7], lead: bk.delay,
      rows: sc.rows.map((x) => [x.measure, x.plan, x.actual, x.result]),
      tags: sc.rows.map((x) => ({ text: VERDICT_WORD[x.verdict], tone: VERDICT_TONE[x.verdict] })),
      more: sc.rows.map((x) => {
        const what = { title: "What it measures", lines: [x.means] };
        if (x.key === "duration" && pt.lines.length) return { title: "Where the late hours went", sections: [{ title: "From the records", lines: pt.lines }] };
        if (x.key === "added" && r.found.length) return { title: "Added work", sections: [what, ...(["added", "discovery"] as const).map((k) => ({ title: k === "added" ? "Added scope: known work, not on the plan" : "Discovery: found when opened or inspected", lines: r.found.filter((f) => (f.kind === "added") === (k === "added")).map((f) => `${orderWord(f.on)}: ${f.what}. ${f.hours} h${f.critical ? ", on the critical path" : ""}.`) })).filter((g) => g.lines.length)] };
        if (x.key === "quality" && r.failedTests.length) return { title: "Quality", sections: [what, { title: "From the records", lines: r.failedTests.map((f) => `${orderWord(f.order)} ${f.step}: "${f.said}"`) }, ...(x.guide ? guideMore(GUIDES[x.guide]).sections.slice(1) : [])] };
        if (x.key === "safety" && r.standDowns.length) return { title: "Safety", sections: [what, { title: "Stand-downs, from the records", lines: r.standDowns.map((h) => `${orderWord(h.order)} ${h.name}: ${h.hours} h. "${h.reason}"`) }, ...(x.guide ? guideMore(GUIDES[x.guide]).sections.slice(1) : [])] };
        return x.guide ? { ...guideMore(GUIDES[x.guide]), sections: [what, ...guideMore(GUIDES[x.guide]).sections.slice(1)] } : { title: x.measure, sections: [what] };
      }),
      tally: [{ n: sc.met, label: "met", tone: "good" as Tone }, { n: sc.missed, label: "missed", tone: "bad" as Tone }, { n: sc.untargeted, label: "no target set", tone: "warn" as Tone }, { n: sc.unmeasured, label: "not measured", tone: "none" as Tone }].filter((x) => x.n > 0),
      foot: [sc.untargeted ? "No target set: set it on the line in the review." : "", sc.unmeasured ? "Not measured: the event did not record it. Open the line for how to set it up." : ""].filter(Boolean).join(" "),
    },
  });

  // 2. The seven areas.
  const costly = bk.areas.filter((a) => a.hours > 0).sort((a, b) => b.hours - a.hours);
  const late = r.metrics.varianceH ?? 0;
  const areasTitle = costly.length ? `${costly.map((a, i) => (i === 0 ? `${a.name} cost ${a.hours}${late ? ` of the ${late}` : ""} h` : `${a.name} ${a.hours} h`)).join(", ")}.`
    : (bk.actions.length ? "Where the event can do better, by area" : bk.pending ? "No finding has been accepted yet" : "Nothing in the records calls for a change");
  s.push({
    kicker: "2 · What went well, what did not, and why", title: areasTitle, notes: bk.areas.map((a) => `${a.name}: ${AREA_STATE_WORD[a.state].toLowerCase()}.`).join(" "),
    body: {
      k: "table", head: ["Area", "What went well", "What did not", "Root cause", "Action"], widths: [1.45, 2.5, 3.0, 2.9, 0.75],
      rows: bk.areas.map((a) => [a.name, a.well.join("\n"),
        a.items.length ? a.items.map((it) => it.didNot).join("\n") : a.pending ? `${a.pending === 1 ? "1 finding waits" : `${a.pending} findings wait`} for your call in the review.` : a.state === "none" ? "Nothing was recorded for this event." : "",
        a.items.map((it) => it.rootCause).filter(Boolean).join("\n"), a.items.map((it) => `No. ${it.action}`).join("\n")]),
      tags: bk.areas.map((a) => ({ text: a.tag, tone: STATE_TONE[a.state] })),
      more: bk.areas.map((a) => {
        const sections = [
          ...(a.parts.length ? [{ title: "Hours of the late finish", lines: a.parts.map((p2) => (r.finish?.delay.find((d) => d.kind === "work" && d.order === p2.order)?.line ?? `${orderWord(p2.order)}: ${p2.hours} h.`)) }] : []),
          ...(a.well.length ? [{ title: "Went well", lines: a.well }] : []),
          ...a.items.map((it) => { const f = byKey.get(it.key); return { title: f?.title ?? it.didNot, lines: f ? facts(f) : [] }; }).filter((x) => x.lines.length),
          ...(a.guide ? guideMore(GUIDES[a.guide]).sections.map((x) => ({ ...x, title: x.title === "What it is" ? GUIDES[a.guide!].title : x.title })) : []),
        ];
        return sections.length ? { title: a.name, sections } : null;
      }),
      foot: bk.pending ? `${bk.pending === 1 ? "1 finding waits" : `${bk.pending} findings wait`} for a decision in the review and ${bk.pending === 1 ? "is" : "are"} not shown.` : "",
    },
  });

  // 3. The action plan, seven to a slide.
  const groups: Array<typeof bk.actions> = [];
  for (let i = 0; i < bk.actions.length; i += 7) groups.push(bk.actions.slice(i, i + 7));
  if (!groups.length) s.push({ kicker: "3 · What we do about it", title: bk.pending ? "No actions accepted yet" : "No actions for the next event", notes: bk.pending ? `${bk.pending} findings wait for a decision in the review.` : "Nothing in the records calls for a change.", body: { k: "asks", items: [], foot: "" } });
  groups.forEach((g, i) => s.push({
    kicker: `3 · What we do about it${part(i, groups.length)}`, title: `${bk.actions.length === 1 ? "1 action" : `${bk.actions.length} actions`} for the next event`, notes: g.map((a) => `${a.n}. ${a.what} Benefit: ${a.benefit}`).join(" "),
    body: {
      k: "table", head: ["What we will do", "How it will be done", "Benefit", "Who", "By", "Cost"], widths: [2.7, 3.0, 2.6, 1.2, 0.95, 0.95],
      rows: g.map((a) => [`${a.n}. ${a.what}`, a.how, a.benefit, a.who || NOT_SET, a.by || NOT_SET, a.cost || NOT_SET]),
      more: g.map((a) => { const f = byKey.get(a.key); return f ? { title: a.what, sections: [...(f.next ? [{ title: "How it will be done", lines: [f.next] }] : []), ...(f.gap ? [{ title: "Root cause", lines: [f.gap] }] : []), { title: "From the records", lines: facts(f) }] } : null; }),
      foot: g.some((a) => !a.who || !a.by || !a.cost) ? "Who, by what date and cost are set on each action in the review." : "",
    },
  }));
  return s;
}

/** The meeting slides as an editable PowerPoint. */
export async function reviewPptx(r: Review, o: ReviewFileOpts, out: "blob" | "nodebuffer" = "blob"): Promise<Blob> {
  const Pptx = (await import("pptxgenjs")).default;
  const p = new Pptx();
  p.layout = "LAYOUT_WIDE"; // 13.33 x 7.5 in
  p.title = `${eventName(o)} post-event review`;
  const BG = "F6F4EF", INK = "16202E", ACC = "B8430F", SOFT = "4A5568";
  const face = "Arial";
  const T = (v: string) => noEmDash(v);
  for (const spec of deckSlides(r, o)) {
    const s = p.addSlide();
    s.background = { color: BG };
    const b = spec.body;
    const bullets = (items: Item[], x: number, y: number, w: number, h: number, size: number) =>
      s.addText(items.map((it) => { const o = typeof it === "string" ? { text: it } : it; return { text: T(o.text), options: { bullet: o.bold ? false : { indent: 14 }, bold: !!o.bold, indentLevel: o.sub ? 1 : 0, breakLine: true, paraSpaceBefore: o.bold ? 6 : 0, paraSpaceAfter: 5 } }; }), { x, y, w, h, fontFace: face, fontSize: size, color: INK, valign: "top" });
    const table = (head: string[], rows: string[][], widths: number[], x: number, y: number, w: number, size?: number, tags?: Array<SlideTag | null>) => {
      const total = widths.reduce((a, c) => a + c, 0);
      const fs = size ?? tablePt(rows);
      s.addTable([head.map((h) => ({ text: T(h), options: { bold: true, color: "FFFFFF", fill: { color: INK }, fontFace: face, fontSize: Math.max(9, fs - 2) } })),
        ...rows.map((row, ri) => head.map((_, i) => {
          const options = { color: INK, fill: { color: ri % 2 ? "ECE8DF" : BG }, fontFace: face, fontSize: fs, valign: "top" as const };
          // A first cell: what it is in bold, then the fact or the verdict under it.
          const [lead, ...more] = (row[i] ?? "").split("\n");
          const tag = i === 0 ? tags?.[ri] : null;
          if (i === 0 && (more.length || tag)) return { text: [{ text: T(lead), options: { bold: true, breakLine: true } }, ...(more.length ? [{ text: T(more.join(" ")), options: { bold: false, breakLine: !!tag } }] : []), ...(tag ? [{ text: T(tag.text), options: { bold: true, fontSize: Math.max(9, fs - 2), color: TONE_HEX[tag.tone].fg } }] : [])], options };
          // Several lines in a cell: one under the other.
          if (more.length) return { text: [lead, ...more].map((t, k, all) => ({ text: T(t), options: { breakLine: k < all.length - 1, paraSpaceAfter: 4 } })), options };
          return { text: T(row[i] ?? ""), options: { ...options, bold: i === 0 } };
        }))],
      { x, y, w, colW: widths.map((c) => (c / total) * w), border: { type: "none" }, margin: [4, 6, 4, 6] });
    };
    const pane = (pn: Pane, x: number, y: number, w: number, h: number) => {
      if (pn.title) s.addText(T(pn.title.toUpperCase()), { x, y, w, h: 0.3, fontFace: face, fontSize: 11, bold: true, color: ACC, charSpacing: 1 });
      const items = pn.items ?? [];
      const chars = items.reduce((n, it) => n + (typeof it === "string" ? it : it.text).length, 0);
      const size = chars > 620 ? 12 : chars > 420 ? 13 : !pn.title ? 18 : 15;
      // Room the lines take, so a table can sit right under them.
      const perLine = Math.max(20, Math.floor((w * 72) / (size * 0.52)));
      const lines = items.reduce((n, it) => n + Math.ceil((typeof it === "string" ? it : it.text).length / perLine), 0);
      const used = pn.table ? Math.min(h - 1.7, lines * size * 1.32 / 72 + items.length * 0.09 + 0.1) : h - 0.35;
      if (items.length) bullets(items, x, y + 0.35, w, used, size);
      if (pn.table) {
        const ty = y + 0.35 + (items.length ? used + 0.1 : 0);
        if (pn.table.title) s.addText(T(pn.table.title.toUpperCase()), { x, y: ty, w, h: 0.3, fontFace: face, fontSize: 11, bold: true, color: ACC, charSpacing: 1 });
        table(pn.table.head, pn.table.rows, pn.table.widths, x, ty + (pn.table.title ? 0.33 : 0), w, 11);
      }
    };
    const foot = (t?: string) => { if (t) s.addText(T(t), { x: 0.6, y: 6.85, w: 12.1, h: 0.4, fontFace: face, fontSize: 10, color: "6B7280", valign: "top" }); };
    if (b.k === "cover") {
      s.addText(T(spec.kicker.toUpperCase()), { x: 0.9, y: 1.5, w: 11.5, h: 0.4, fontFace: face, fontSize: 14, bold: true, color: ACC, charSpacing: 3 });
      s.addText(T(spec.title), { x: 0.9, y: 1.95, w: 11.5, h: 1.1, fontFace: face, fontSize: 38, bold: true, color: INK });
      s.addText(T(b.sub), { x: 0.9, y: 3.05, w: 11.5, h: 0.5, fontFace: face, fontSize: 18, color: SOFT });
      s.addText(b.agenda.map((t, i) => ({ text: T(`${i + 1}.  ${t}`), options: { breakLine: true, paraSpaceAfter: 4 } })), { x: 0.9, y: 3.9, w: 8, h: 2.3, fontFace: face, fontSize: 15, color: INK, valign: "top" });
      s.addText(T(b.meta), { x: 0.9, y: 6.6, w: 11.5, h: 0.4, fontFace: face, fontSize: 13, color: SOFT });
      s.addNotes(T(spec.notes));
      continue;
    }
    s.addText(T(spec.kicker.toUpperCase()), { x: 0.6, y: 0.35, w: 12.1, h: 0.3, fontFace: face, fontSize: 11, bold: true, color: ACC, charSpacing: 2 });
    s.addText(T(spec.title), { x: 0.6, y: 0.65, w: 12.1, h: 0.8, fontFace: face, fontSize: spec.title.length > 70 ? 21 : 25, bold: true, color: INK, valign: "top" });
    if (b.k === "asks") {
      const big = b.items.length <= 4;
      const rowH = Math.min(1.25, 5.1 / Math.max(1, b.items.length));
      if (!b.items.length) s.addText(T(spec.notes), { x: 0.6, y: 1.7, w: 12.1, h: 0.6, fontFace: face, fontSize: 20, color: INK });
      b.items.forEach((it, i) => {
        const y = 1.6 + i * rowH;
        s.addText(String(it.n), { x: 0.6, y, w: 0.6, h: 0.6, fontFace: face, fontSize: big ? 26 : 22, bold: true, color: ACC, valign: "top" });
        s.addText([{ text: T(it.ask), options: { bold: true, fontSize: big ? 20 : 17, color: INK, breakLine: true } }, { text: T(it.because), options: { fontSize: big ? 15 : 13, color: SOFT } }], { x: 1.25, y, w: 11.4, h: rowH - 0.05, fontFace: face, valign: "top", margin: 0 });
      });
      foot(b.foot);
    } else if (b.k === "table") {
      // The tally sits in a line above the table: "1 met · 1 missed · 4 not measured".
      let y = 1.5;
      if (b.lead) { s.addText(T(b.lead), { x: 0.6, y, w: 12.1, h: 0.42, fontFace: face, fontSize: 16, bold: true, color: ACC, valign: "middle" }); y += 0.48; }
      if (b.tally?.length) { s.addText(b.tally.flatMap((t, i) => [{ text: `${i ? "     " : ""}${t.n} `, options: { bold: true, fontSize: 20, color: TONE_HEX[t.tone].fg } }, { text: T(t.label), options: { fontSize: 13, color: SOFT } }]), { x: 0.6, y, w: 12.1, h: 0.45, fontFace: face, valign: "middle" }); y += 0.55; }
      table(b.head, b.rows, b.widths, 0.6, y === 1.5 ? 1.55 : y, 12.1, undefined, b.tags);
      foot(b.foot);
    } else if (b.k === "split") {
      const lw = 12.1 * (b.ratio ?? 0.5) - 0.15;
      pane(b.left, 0.6, 1.55, lw, 5.2);
      if (b.right.title || b.right.items?.length || b.right.table) pane(b.right, 0.6 + lw + 0.3, 1.55, 12.1 - lw - 0.3, 5.2);
      foot(b.foot);
    }
    s.addNotes(T(spec.notes));
  }
  return (await p.write({ outputType: out })) as Blob;
}

/** A phone or tablet: its browser hands a file to the share sheet. */
const handheld = () => typeof navigator !== "undefined" && (/Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1));

/** Hand a file to the person. On a computer it downloads. On a phone or
 *  tablet it opens the share sheet (Save to Files, open in PowerPoint or
 *  Word), since browsers there often drop a plain download. `false`: the
 *  browser wants a fresh tap first (the file took a moment to make), so
 *  offer a Save button and call this again from it. */
export async function saveFile(data: Uint8Array | Blob, name: string, mime: string): Promise<boolean> {
  const blob = new Blob([data as BlobPart], { type: mime });
  if (handheld() && typeof File !== "undefined" && typeof navigator.share === "function") {
    const file = new File([blob], name, { type: mime });
    if (navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file] }); return true; }
      catch (e) {
        const n = (e as { name?: string }).name;
        if (n === "AbortError") return true; // the person closed the sheet
        if (n === "NotAllowedError") return false;
      }
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name; a.rel = "noopener"; document.body.appendChild(a); a.click(); a.remove();
  // Long enough for a phone to ask "Download?" and be answered.
  setTimeout(() => URL.revokeObjectURL(url), 120_000);
  return true;
}
export const fileStem = (o: ReviewFileOpts) => `${o.phase ? `${o.phase} post-event review, ${o.project}` : `${o.project} post-event review`}`.replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim();
