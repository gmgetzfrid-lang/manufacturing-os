// reviewFiles - the post-event review as files: a Word report for the
// project file, and the meeting slides as an editable PowerPoint. Both are
// written from the review as it stands (lib/postEventReview): the records'
// numbers, the findings that weren't thrown out with whatever a person
// changed, and the plan that closes them.
//
// One contents list drives both, so the report and the deck never disagree.

import JSZip from "jszip";
import { noEmDash } from "@/lib/noEmDash";
import {
  CATEGORIES, CAUSE_WORD, GATES, ORGANIZATION, RATING_MEANS, RATING_WORD, ROADMAP, categoryOf, decisionsOf, jobWord, measuresOf, orderWord, shiftWord, shiftsWord, whenWord,
  type Finding, type Review,
} from "@/lib/postEventReview";

export interface ReviewFileOpts {
  project: string;
  /** The phase the review is of, when the project has phases. */
  phase: string | null;
  tz: string;
  preparedBy: string | null;
  /** "November 12, 2026". */
  date: string;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const live = (r: Review) => r.findings.filter((f) => f.status !== "discarded");
const toClose = (r: Review) => live(r).filter((f) => f.rating === "gap" || f.rating === "opportunity");
const eventName = (o: ReviewFileOpts) => (o.phase ? `${o.project}, ${o.phase}` : o.project);

// ─── The words both files share ────────────────────────────────────

/** The summary: the event in a few lines, each number said in full. */
export function summaryLines(r: Review, o: ReviewFileOpts): string[] {
  const m = r.metrics, out: string[] = [];
  if (!m.steps) return ["No schedule to review."];
  out.push(`${m.baselineDone} of ${m.baselineSteps} planned activities were completed${m.addedSteps ? `, plus ${m.addedDone} of ${m.addedSteps} added during the event from ${plural(r.found.length, "finding")}` : ""}.`);
  if (m.varianceH != null && m.baselineFinish != null && m.actualFinish != null) out.push(`The last activity finished ${Math.abs(m.varianceH)} h ${m.varianceH >= 0 ? "after" : "before"} the baseline finish (baseline ${whenWord(m.baselineFinish, o.tz)}; actual ${whenWord(m.actualFinish, o.tz)}).`);
  else if (!m.done) out.push(`${m.steps - m.stepsDone} of ${m.steps} activities are not done yet; the numbers here are to date.`);
  if (m.addedSteps && m.addedPct != null) out.push(`Scope grew ${m.addedPct}%: ${m.addedH} h of added work on a ${m.baselineH} h plan, by the schedule's estimates.`);
  if (m.stuckShifts + m.readyShifts) {
    out.push(`Stuck work: on ${m.shiftsWithStuck} of the ${m.shifts} shifts, ${m.leastAtOnce === m.mostAtOnce ? m.mostAtOnce : `${m.leastAtOnce} to ${m.mostAtOnce}`} jobs sat at the same time. ${plural(m.stuckJobs, "started job")} sat still (${plural(m.stuckShifts, "shift")} in all) and ${plural(m.readyJobs, "ready job")} waited to start (${plural(m.readyShifts, "shift")} in all). Each is listed in the appendix.`);
  } else out.push("No started job sat a full shift, and no ready job waited a full shift to start.");
  const cats = toClose(r).map((f) => categoryOf(f.category).name.toLowerCase()).filter((v, i, a) => a.indexOf(v) === i);
  if (cats.length) out.push(`${plural(cats.length, "category needs", "categories need")} closure: ${cats.join(", ")}.`);
  return out;
}

const metricRows = (r: Review, o: ReviewFileOpts): string[][] => {
  const m = r.metrics;
  return [
    ["Schedule variance", m.varianceH == null ? "Not finished" : `${m.varianceH > 0 ? "+" : ""}${m.varianceH} h`, "Last activity finished, minus the baseline finish"],
    ["Planned activities completed", `${m.baselineDone} of ${m.baselineSteps}`, "Activities on the schedule when the plan was saved"],
    ["Added activities", m.addedSteps ? `${m.addedSteps} (from ${plural(r.found.length, "finding")})` : "None", "Added during the event from a finding"],
    ["Scope growth", m.addedPct == null ? "Not known" : `${m.addedPct}% (${m.addedH} h on ${m.baselineH} h)`, "Planned hours of added work over planned hours of the baseline"],
    ["Started jobs that sat still", `${plural(m.stuckJobs, "job")}, ${plural(m.stuckShifts, "shift")} in all`, "Started, not finished, nothing logged for a whole shift"],
    ["Ready jobs not started", `${plural(m.readyJobs, "job")}, ${plural(m.readyShifts, "shift")} in all`, "Everything before it done; did not start that shift"],
    ["Labor hours on added work", m.labor ? `${m.labor.pct}% (${m.labor.addedMH} of ${m.labor.totalMH} h)` : "Not known", m.labor ? "Shift head counts times tool hours, shared across the work moved" : `Head counts were recorded for ${m.headCounts.counted} of ${m.headCounts.of} crew-shifts`],
  ].map((row) => row.map((c) => (o ? c : c)));
};
const stuckRows = (r: Review) => r.stuck.map((j) => [jobWord(j), j.crew, String(j.shifts.length), shiftsWord(j.shifts.map((s) => s.key)),
  [...new Set(j.shifts.map((s) => `${CAUSE_WORD[s.cause]}${s.said ? `: "${s.said}"` : s.crewOn.length ? ` (crew on ${[...new Set(s.crewOn.map(orderWord))].slice(0, 3).join(", ")})` : ""}`))].join(" Then: ")]);
const readyRows = (r: Review) => r.ready.map((j) => [jobWord(j), j.crew, String(j.shifts.length), shiftsWord(j.shifts), j.said ?? (j.busyOn.length ? [...new Set(j.busyOn.map(orderWord))].join(", ") : j.crewLogged ? "" : "No work logged by this crew")]);
const shiftRows = (r: Review) => [...r.byShift.map((c) => [shiftWord(c.key), String(c.stuck), String(c.ready), String(c.stuck + c.ready)]), ["All", String(r.metrics.stuckShifts), String(r.metrics.readyShifts), String(r.metrics.stuckShifts + r.metrics.readyShifts)]];
const foundRows = (r: Review) => r.found.map((f) => [`${f.what} (${orderWord(f.on)})`, String(f.steps), `${f.hours} h`, f.critical ? "Yes" : "No", f.approvedBy ?? "Not recorded"]);
const SOURCES = "Sources: the baseline schedule; progress logged by shift (Reports, As-built schedule); comments and hold reasons on each job; added-work records with their approver; shift meeting head counts; answers given in the review.";

// ─── Word ──────────────────────────────────────────────────────────

type Block =
  | { k: "title" | "h1" | "h2" | "p" | "muted" | "bullet"; text: string; lead?: string }
  | { k: "num"; text: string; n: number; lead?: string }
  | { k: "table"; head: string[]; rows: string[][]; widths: number[] };

export const REPORT_SECTIONS = ["Summary", "Event metrics", "What performed well", "Assessment by category", "Proposed event organization", "Closure plan", "Measures and targets", "Decisions requested", "Appendices: stuck jobs, ready jobs, by shift, found work, anticipated questions, how each number is counted"];

/** The report, top to bottom. */
export function reportBlocks(r: Review, o: ReviewFileOpts): Block[] {
  const b: Block[] = [];
  const m = r.metrics;
  b.push({ k: "muted", text: "POST-EVENT REVIEW" }, { k: "title", text: eventName(o) });
  b.push({ k: "muted", text: [m.baselineFinish != null && r.metrics.actualFinish != null ? `Finished ${whenWord(m.actualFinish!, o.tz)}` : null, o.preparedBy ? `Prepared by: ${o.preparedBy}` : null, o.date].filter(Boolean).join("  ·  ") });
  b.push({ k: "h2", text: "Contents" });
  REPORT_SECTIONS.forEach((s, i) => b.push({ k: "num", n: i + 1, text: s }));

  b.push({ k: "h1", text: "1. Summary" });
  for (const s of summaryLines(r, o)) b.push({ k: "bullet", text: s });

  b.push({ k: "h1", text: "2. Event metrics" });
  b.push({ k: "table", head: ["Measure", "Result", "How it is counted"], rows: metricRows(r, o), widths: [2.0, 2.0, 2.9] });

  b.push({ k: "h1", text: "3. What performed well" });
  if (r.strengths.length) for (const s of r.strengths) b.push({ k: "bullet", text: s }); else b.push({ k: "p", text: "Nothing the records single out." });

  b.push({ k: "h1", text: "4. Assessment by category" });
  b.push({ k: "muted", text: RATING_MEANS });
  b.push({ k: "table", head: ["Category", "Stage", "Rating", "Basis"], rows: CATEGORIES.map((c) => { const fs = live(r).filter((f) => f.category === c.id); const f = fs[0]; return [c.name, c.stage, f ? RATING_WORD[f.rating] : "Not assessed", fs.map((x) => x.title).join("; ")]; }), widths: [1.9, 1.0, 1.0, 3.0] });
  for (const f of live(r)) {
    const c = categoryOf(f.category);
    b.push({ k: "h2", text: `${c.name} (${c.stage}) · ${RATING_WORD[f.rating]}: ${f.title}` });
    if (f.observation) b.push({ k: "p", lead: "Event observation: ", text: f.observation });
    for (const line of f.info) b.push({ k: "p", lead: "Added: ", text: line });
    if (f.rating === "gap" || f.rating === "opportunity") {
      if (f.practice) b.push({ k: "p", lead: "Leading practice: ", text: f.practice });
      if (f.gap) b.push({ k: "p", lead: "Gap: ", text: f.gap });
      if (f.next) b.push({ k: "p", lead: "Closure, next event: ", text: f.next });
      if (f.year) b.push({ k: "p", lead: "Closure, within 12 months: ", text: f.year });
      if (f.owner) b.push({ k: "p", lead: "Owner: ", text: f.owner });
    }
  }

  b.push({ k: "h1", text: "5. Proposed event organization" });
  b.push({ k: "table", head: ["Role", "Who", "Responsible for"], rows: ORGANIZATION.map((x) => [x.tier, x.who, x.does]), widths: [2.0, 1.9, 3.0] });
  b.push({ k: "muted", text: "How it is set up: define the roles the event needs, match people to them, close shortfalls with training or contract supervision, write each role's responsibilities, and brief them face to face." });

  b.push({ k: "h1", text: "6. Closure plan" });
  b.push({ k: "h2", text: "Next event" });
  b.push({ k: "table", head: ["When", "Action", "Owner"], rows: GATES.map((g) => [g.when, g.what, g.owner]), widths: [1.4, 4.0, 1.5] });
  b.push({ k: "h2", text: "Within 12 months" });
  for (const x of ROADMAP) b.push({ k: "bullet", lead: `${x.when}, ${x.theme}: `, text: x.what });

  b.push({ k: "h1", text: "7. Measures and targets" });
  b.push({ k: "table", head: ["Measure", "This event", "Target"], rows: measuresOf(m).map((x) => [x.measure, x.result, x.target]), widths: [3.4, 1.9, 1.6] });

  b.push({ k: "h1", text: "8. Decisions requested" });
  const ds = decisionsOf(r.findings);
  if (ds.length) ds.forEach((d, i) => b.push({ k: "num", n: i + 1, text: d })); else b.push({ k: "p", text: "None from this review." });

  b.push({ k: "h1", text: `Appendix A. Started jobs that sat still (${plural(m.stuckJobs, "job")}, ${plural(m.stuckShifts, "shift")} in all)` });
  if (r.stuck.length) b.push({ k: "table", head: ["Job", "Crew", "Shifts", "When", "Why, from the record"], rows: stuckRows(r), widths: [1.7, 0.9, 0.5, 1.2, 2.6] }); else b.push({ k: "p", text: "None." });
  b.push({ k: "h1", text: `Appendix B. Ready jobs not started (${plural(m.readyJobs, "job")}, ${plural(m.readyShifts, "shift")} in all)` });
  if (r.ready.length) b.push({ k: "table", head: ["Ready job", "Crew", "Shifts", "When", "Crew was on"], rows: readyRows(r), widths: [2.1, 0.9, 0.5, 1.3, 2.1] }); else b.push({ k: "p", text: "None." });
  b.push({ k: "h1", text: `Appendix C. Stuck jobs by shift (${m.shiftsWithStuck} of ${m.shifts} shifts)` });
  if (r.byShift.length) b.push({ k: "table", head: ["Shift", "Started jobs sitting still", "Ready jobs not started", "Together"], rows: shiftRows(r), widths: [1.6, 2.0, 2.0, 1.3] }); else b.push({ k: "p", text: "None." });
  b.push({ k: "muted", text: "A job that sits several shifts is counted in each. Night shifts count only for work that ran on nights." });
  b.push({ k: "h1", text: `Appendix D. Found work (${plural(r.found.length, "finding")}, ${plural(m.addedSteps, "activity", "activities")})` });
  if (r.found.length) b.push({ k: "table", head: ["Finding", "Activities", "Work when approved", "Critical path", "Approved by"], rows: foundRows(r), widths: [2.9, 0.8, 1.2, 0.9, 1.1] }); else b.push({ k: "p", text: "None." });
  b.push({ k: "h1", text: "Appendix E. Anticipated questions" });
  for (const x of r.qa) b.push({ k: "p", lead: `${x.q} `, text: x.a });
  b.push({ k: "h1", text: "Appendix F. How each number is counted" });
  b.push({ k: "table", head: ["Measure", "What it means", "Where to see it"], rows: r.definitions.map((d) => [d.measure, d.means, d.where]), widths: [1.8, 3.2, 1.9] });
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

export interface SlideSpec {
  kicker: string; title: string; notes: string;
  body:
    | { k: "cover"; sub: string; meta: string }
    | { k: "list"; items: string[]; numbered?: boolean }
    | { k: "tiles"; tiles: Array<{ label: string; value: string; detail: string }>; foot?: string }
    | { k: "table"; head: string[]; rows: string[][]; widths: number[]; foot?: string }
    | { k: "finding"; boxes: Array<{ label: string; text: string; tone: "plain" | "dark" | "accent" }>; foot?: string };
}

const chunk = <T,>(xs: T[], n: number): T[][] => { const out: T[][] = []; for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n)); return out.length ? out : [[]]; };

/** The deck, slide by slide (what the PowerPoint is drawn from). */
export function deckSlides(r: Review, o: ReviewFileOpts): SlideSpec[] {
  const m = r.metrics, s: SlideSpec[] = [];
  const close = toClose(r);
  s.push({ kicker: "Post-event review", title: eventName(o), notes: "Purpose: what the event showed, the gaps against leading practice, and the plan to close them.", body: { k: "cover", sub: "What the event showed, the gaps, and the plan to close them", meta: [o.preparedBy, o.date].filter(Boolean).join("  ·  ") } });
  s.push({ kicker: "Contents", title: "What we will cover", notes: "Results first, then the assessment by category, then the plan and the decisions needed.", body: { k: "list", numbered: true, items: ["Event summary: the numbers and what they mean", "What performed well", "Assessment by category: observation, leading practice, gap, closure", "Proposed event organization", "Closure plan: next event, and within 12 months", "Measures and targets", "Decisions requested", "Appendix: every stuck job, found work, anticipated questions"] } });
  s.push({
    kicker: "1 · Event summary", title: m.varianceH == null ? "The event to date" : m.varianceH > 0.5 ? `Scope delivered; finish ${m.varianceH} h past the baseline` : "Scope delivered on the baseline finish",
    notes: summaryLines(r, o).join(" "),
    body: { k: "tiles", foot: "Each number is defined in the appendix, with where to see it in the system.", tiles: [
      { label: "Schedule variance", value: m.varianceH == null ? "Open" : `${m.varianceH > 0 ? "+" : ""}${m.varianceH} h`, detail: m.baselineFinish != null && m.actualFinish != null ? `Baseline ${whenWord(m.baselineFinish, o.tz)}. Actual ${whenWord(m.actualFinish, o.tz)}.` : "Not finished yet." },
      { label: "Scope", value: `${m.baselineSteps} + ${m.addedSteps}`, detail: `Planned activities, plus ${m.addedSteps} added from ${plural(r.found.length, "finding")}. ${m.stepsDone} of ${m.steps} done.` },
      { label: "Scope growth", value: m.addedPct == null ? "n/a" : `${m.addedPct}%`, detail: `${m.addedH} h of added work on a ${m.baselineH} h plan (schedule estimates).` },
      { label: "Stuck work", value: `${m.shiftsWithStuck} of ${m.shifts}`, detail: m.shiftsWithStuck ? `shifts had jobs sitting, ${m.leastAtOnce === m.mostAtOnce ? m.mostAtOnce : `${m.leastAtOnce} to ${m.mostAtOnce}`} at a time: ${m.stuckJobs} started, ${m.readyJobs} ready.` : "shifts had a job sitting." },
    ] },
  });
  s.push({ kicker: "1 · Event summary", title: "What performed well", notes: "Start with what worked; these are practices to keep.", body: { k: "list", items: r.strengths.length ? r.strengths : ["Nothing the records single out."] } });
  s.push({ kicker: "2 · Assessment", title: "Eight categories across the life of the event", notes: `${RATING_MEANS} ${close.length ? `${plural(close.length, "finding needs", "findings need")} closure.` : ""}`,
    body: { k: "table", head: ["Category", "Stage", "Rating", "Basis"], widths: [3.0, 1.6, 1.6, 6.1], foot: RATING_MEANS, rows: CATEGORIES.map((c) => { const fs = live(r).filter((f) => f.category === c.id); return [c.name, c.stage, fs[0] ? RATING_WORD[fs[0].rating] : "Not assessed", fs.map((x) => x.title).join("; ")]; }) } });
  for (const f of close) s.push(findingSlide(f));
  s.push({ kicker: "3 · Organization", title: "Proposed event organization", notes: "The organization is designed for the event rather than formed from who is available. One person owns the event; coordinators own preparation, planning and logistics; an area coordinator runs each unit day to day.", body: { k: "table", head: ["Role", "Who", "Responsible for"], widths: [3.3, 3.2, 5.8], rows: ORGANIZATION.map((x) => [x.tier, x.who, x.does]) } });
  s.push({ kicker: "4 · Closure plan", title: "Next event: what is in place, by when", notes: "Each gate has an owner. The readiness review two weeks before the start is the last check that nothing is carried into the event open.", body: { k: "table", head: ["When", "Action", "Owner"], widths: [2.3, 7.3, 2.7], rows: GATES.map((g) => [g.when, g.what, g.owner]) } });
  s.push({ kicker: "4 · Closure plan", title: "Within 12 months", notes: "These take longer than one event: written standards first, then the systems, the people, and a yearly self-assessment.", body: { k: "table", head: ["When", "Theme", "What"], widths: [1.8, 1.9, 8.6], rows: ROADMAP.map((x) => [x.when, x.theme, x.what]) } });
  s.push({ kicker: "5 · Measures", title: "How the next event will be measured", notes: "This event's results are the baseline. Targets are for this group to agree.", body: { k: "table", head: ["Measure", "This event", "Target"], widths: [6.3, 3.4, 2.6], rows: measuresOf(m).map((x) => [x.measure, x.result, x.target]) } });
  const ds = decisionsOf(r.findings);
  s.push({ kicker: "6 · Decisions", title: "Decisions requested", notes: "These are the decisions that let the closure plan start.", body: { k: "list", numbered: true, items: ds.length ? ds : ["None from this review."] } });
  chunk(stuckRows(r), 7).forEach((rows, i, a) => s.push({ kicker: `Appendix A${a.length > 1 ? ` (${i + 1} of ${a.length})` : ""}`, title: `Started jobs that sat still: ${plural(m.stuckJobs, "job")}, ${plural(m.stuckShifts, "shift")} in all`, notes: "Every job that had started and went a whole shift with nothing logged, with the reason on record for each shift.", body: { k: "table", head: ["Job", "Crew", "Shifts", "When", "Why, from the record"], widths: [3.3, 1.7, 0.9, 2.0, 4.4], rows, foot: "Night shifts count only for work that ran on nights. Where to see it: Reports, As-built schedule, gray hatched cells." } }));
  chunk(readyRows(r), 8).forEach((rows, i, a) => s.push({ kicker: `Appendix B${a.length > 1 ? ` (${i + 1} of ${a.length})` : ""}`, title: `Ready jobs not started: ${plural(m.readyJobs, "job")}, ${plural(m.readyShifts, "shift")} in all`, notes: "Every job that could have started and did not for a whole shift, with what its crew was on.", body: { k: "table", head: ["Ready job", "Crew", "Shifts", "When", "Crew was on"], widths: [4.0, 1.7, 0.9, 2.2, 3.5], rows, foot: "Where to see it: Reports, As-built schedule, light blue cells." } }));
  s.push({ kicker: "Appendix C", title: `Stuck jobs by shift: ${m.shiftsWithStuck} of ${m.shifts} shifts`, notes: "A job that sits several shifts is counted in each, so these are not hours of delay to the finish.", body: { k: "table", head: ["Shift", "Started jobs sitting still", "Ready jobs not started", "Together"], widths: [3.0, 3.5, 3.5, 2.3], rows: shiftRows(r), foot: "A job that sits several shifts is counted in each." } });
  chunk(foundRows(r), 7).forEach((rows, i, a) => s.push({ kicker: `Appendix D${a.length > 1 ? ` (${i + 1} of ${a.length})` : ""}`, title: `Found work: ${plural(r.found.length, "finding")}, ${plural(m.addedSteps, "activity", "activities")} added`, notes: "Hours are the work estimated when each finding was approved. Most ran alongside other work, so they do not add up to the finish variance.", body: { k: "table", head: ["Finding", "Activities", "Work when approved", "Critical path", "Approved by"], widths: [5.6, 1.3, 2.0, 1.5, 1.9], rows, foot: "Hours are the estimate at approval; most ran alongside other work, so they do not add up to the finish variance." } }));
  chunk(r.qa, 5).forEach((qs, i, a) => s.push({ kicker: `Appendix E${a.length > 1 ? ` (${i + 1} of ${a.length})` : ""}`, title: "Anticipated questions", notes: "Prepared answers, each from the records.", body: { k: "table", head: ["Question", "Answer"], widths: [3.6, 8.7], rows: qs.map((x) => [x.q, x.a]) } }));
  s.push({ kicker: "Appendix F", title: "How each number is counted, and where to see it", notes: SOURCES, body: { k: "table", head: ["Measure", "What it means", "Where to see it"], widths: [3.0, 6.0, 3.3], rows: r.definitions.map((d) => [d.measure, d.means, d.where]), foot: SOURCES } });
  return s;
}

function findingSlide(f: Finding): SlideSpec {
  const c = categoryOf(f.category);
  const obs = [f.observation, ...f.info].filter(Boolean).join(" ");
  return {
    kicker: `2 · ${c.name} · ${c.stage} · ${RATING_WORD[f.rating]}`, title: f.title,
    notes: `${obs} Leading practice: ${f.practice} ${f.gap ? `Gap: ${f.gap} ` : ""}Closure, next event: ${f.next} Within 12 months: ${f.year}${f.owner ? ` Owner: ${f.owner}.` : ""}`,
    body: { k: "finding", foot: f.owner ? `Owner: ${f.owner}` : undefined, boxes: [
      { label: "Event observation", text: obs, tone: "plain" },
      { label: "Leading practice", text: f.practice, tone: "plain" },
      { label: "Gap", text: f.gap, tone: "dark" },
      { label: "Closure", text: `Next event: ${f.next}\n12 months: ${f.year}`, tone: "accent" },
    ] },
  };
}

/** The meeting slides as an editable PowerPoint. */
export async function reviewPptx(r: Review, o: ReviewFileOpts, out: "blob" | "nodebuffer" = "blob"): Promise<Blob> {
  const Pptx = (await import("pptxgenjs")).default;
  const p = new Pptx();
  p.layout = "LAYOUT_WIDE"; // 13.33 x 7.5 in
  p.title = `${eventName(o)} post-event review`;
  const BG = "F6F4EF", INK = "16202E", ACC = "B8430F", SOFT = "4A5568", CARD = "FFFDF9", LINE = "DDD7CC";
  const face = "Arial";
  const T = (v: string) => noEmDash(v);
  const sizeFor = (t: string, big: number) => (t.length > 520 ? big - 5 : t.length > 380 ? big - 4 : t.length > 260 ? big - 2 : big);
  for (const spec of deckSlides(r, o)) {
    const s = p.addSlide();
    s.background = { color: BG };
    if (spec.body.k === "cover") {
      s.addText(T(spec.kicker.toUpperCase()), { x: 0.9, y: 2.3, w: 11.5, h: 0.4, fontFace: face, fontSize: 14, bold: true, color: ACC, charSpacing: 3 });
      s.addText(T(spec.title), { x: 0.9, y: 2.75, w: 11.5, h: 1.2, fontFace: face, fontSize: 40, bold: true, color: INK });
      s.addText(T(spec.body.sub), { x: 0.9, y: 3.95, w: 11.5, h: 0.6, fontFace: face, fontSize: 20, color: SOFT });
      s.addText(T(spec.body.meta), { x: 0.9, y: 6.4, w: 11.5, h: 0.4, fontFace: face, fontSize: 14, color: SOFT });
      s.addNotes(T(spec.notes));
      continue;
    }
    s.addText(T(spec.kicker.toUpperCase()), { x: 0.6, y: 0.4, w: 12.1, h: 0.35, fontFace: face, fontSize: 12, bold: true, color: ACC, charSpacing: 2 });
    s.addText(T(spec.title), { x: 0.6, y: 0.75, w: 12.1, h: 0.9, fontFace: face, fontSize: spec.title.length > 60 ? 24 : 28, bold: true, color: INK, valign: "top" });
    const b = spec.body;
    const foot = (t?: string) => { if (t) s.addText(T(t), { x: 0.6, y: 6.75, w: 12.1, h: 0.45, fontFace: face, fontSize: 11, color: "6B7280", valign: "top" }); };
    if (b.k === "list") {
      s.addText(b.items.map((t, i) => ({ text: T(b.numbered ? `${i + 1}.  ${t}` : t), options: { bullet: b.numbered ? false : { indent: 18 }, breakLine: true, paraSpaceAfter: 10 } })),
        { x: 0.7, y: 1.8, w: 11.9, h: 4.8, fontFace: face, fontSize: b.items.length > 6 ? 18 : 20, color: INK, valign: "top" });
    } else if (b.k === "tiles") {
      const w = 2.9, gap = 0.17;
      b.tiles.forEach((t, i) => {
        const x = 0.6 + i * (w + gap);
        s.addShape(p.ShapeType.roundRect, { x, y: 1.9, w, h: 3.6, fill: { color: CARD }, line: { color: LINE, width: 1 }, rectRadius: 0.08 });
        s.addText(T(t.label.toUpperCase()), { x: x + 0.2, y: 2.05, w: w - 0.4, h: 0.35, fontFace: face, fontSize: 11, bold: true, color: SOFT, charSpacing: 1 });
        s.addText(T(t.value), { x: x + 0.2, y: 2.45, w: w - 0.4, h: 1.0, fontFace: face, fontSize: 36, bold: true, color: i === 0 || i === 3 ? ACC : INK });
        s.addText(T(t.detail), { x: x + 0.2, y: 3.5, w: w - 0.4, h: 1.9, fontFace: face, fontSize: 13, color: SOFT, valign: "top" });
      });
      foot(b.foot);
    } else if (b.k === "table") {
      const total = b.widths.reduce((a, c) => a + c, 0), scale = 12.1 / total;
      const long = b.rows.reduce((n, row) => n + row.join("").length, 0);
      const fs = long > 1500 ? 10 : long > 1000 ? 11 : b.rows.length > 8 ? 11 : 12;
      const rows = [b.head.map((h) => ({ text: T(h), options: { bold: true, color: "FFFFFF", fill: { color: INK }, fontFace: face, fontSize: fs } })),
        ...b.rows.map((row, ri) => b.head.map((_, i) => ({ text: T(row[i] ?? ""), options: { color: INK, fill: { color: ri % 2 ? "ECE8DF" : BG }, fontFace: face, fontSize: fs, valign: "top" as const } })))];
      s.addTable(rows, { x: 0.6, y: 1.75, w: 12.1, colW: b.widths.map((w) => w * scale), border: { type: "none" }, margin: [4, 6, 4, 6] });
      foot(b.foot);
    } else if (b.k === "finding") {
      const w = 5.95, h = 2.25;
      b.boxes.forEach((box, i) => {
        const x = 0.6 + (i % 2) * (w + 0.2), y = 1.75 + Math.floor(i / 2) * (h + 0.2);
        const dark = box.tone === "dark";
        s.addShape(p.ShapeType.roundRect, { x, y, w, h, fill: { color: dark ? INK : CARD }, line: { color: box.tone === "accent" ? ACC : dark ? INK : LINE, width: box.tone === "accent" ? 2 : 1 }, rectRadius: 0.08 });
        s.addText(T(box.label.toUpperCase()), { x: x + 0.2, y: y + 0.12, w: w - 0.4, h: 0.3, fontFace: face, fontSize: 11, bold: true, color: dark ? "E8A27C" : ACC, charSpacing: 1 });
        s.addText(T(box.text || "None."), { x: x + 0.2, y: y + 0.45, w: w - 0.4, h: h - 0.55, fontFace: face, fontSize: sizeFor(box.text, 15), color: dark ? "F6F4EF" : INK, valign: "top" });
      });
      foot(b.foot);
    }
    s.addNotes(T(spec.notes));
  }
  return (await p.write({ outputType: out })) as Blob;
}

/** Save bytes or a blob as a file. */
export function saveFile(data: Uint8Array | Blob, name: string, mime: string): void {
  const blob = data instanceof Blob ? data : new Blob([data as BlobPart], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
export const fileStem = (o: ReviewFileOpts) => `${eventName(o)} post-event review`.replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim();
