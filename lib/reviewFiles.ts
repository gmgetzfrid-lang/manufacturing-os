// reviewFiles - the post-event review as files: a Word report for the
// project file, and the meeting slides as an editable PowerPoint. Both are
// written from the review as it stands (lib/postEventReview) and open on
// the same point: what set the finish, then what changes next time. The
// jobs and numbers behind it follow as backup.
//
// One set of words drives both, so the report and the deck never disagree.

import JSZip from "jszip";
import { noEmDash } from "@/lib/noEmDash";
import { fmtInTz } from "@/lib/scheduleTz";
import { CAUSE_WORD, jobWord, orderWord, pointOf, shiftsWord, type Finding, type Review } from "@/lib/postEventReview";

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
const scopeLine = (r: Review) => { const m = r.metrics; return m.steps ? `${m.baselineDone} of ${m.baselineSteps} planned activities completed${m.addedSteps ? `, plus ${m.addedDone} of ${m.addedSteps} added from ${plural(r.found.length, "finding")}` : ""}.` : ""; };
/** The steps on the work that set the finish, with what was written on each. */
const stepRows = (r: Review, said: boolean): string[][] => (r.finish?.steps ?? []).map((st) => [st.name, st.crew || "Not set", `${st.plannedH} h`, `${st.tookH} h`, ...(said ? [st.said.map((t) => `"${t}"`).join(" Then: ")] : [])]);
/** What it cost, for a table cell. */
const costOf = (f: Finding) => f.effect || "Not recorded";

const metricRows = (r: Review): string[][] => {
  const m = r.metrics;
  return [
    ["Finish against the baseline", m.varianceH == null ? "Not finished" : `${m.varianceH > 0 ? "+" : ""}${m.varianceH} h`, "Last activity finished, minus the baseline finish"],
    ["Planned activities completed", `${m.baselineDone} of ${m.baselineSteps}`, "Activities on the schedule when the plan was saved"],
    ["Added activities", m.addedSteps ? `${m.addedSteps} (from ${plural(r.found.length, "finding")})` : "None", "Added during the event from a finding"],
    ["Scope growth", m.addedPct == null ? "Not known" : `${m.addedPct}% (${m.addedH} h on ${m.baselineH} h)`, "Planned hours of added work over planned hours of the baseline"],
    ["Started jobs that sat a shift", `${plural(m.stuckJobs, "job")}, ${plural(m.stuckShifts, "shift")} in all`, "Started, not finished, nothing logged for a whole shift; equipment out for service not counted"],
    ["Ready jobs not started", `${plural(m.readyJobs, "job")}, ${plural(m.readyShifts, "shift")} in all`, "Everything before it done; did not start that shift"],
    ["Labor hours on added work", m.labor ? `${m.labor.pct}% (${m.labor.addedMH} of ${m.labor.totalMH} h)` : "Not known", m.labor ? "Shift head counts times tool hours, shared across the work moved" : `Head counts were recorded for ${m.headCounts.counted} of ${m.headCounts.of} crew-shifts`],
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

/** The report, top to bottom: the point first, the proof after. */
export function reportBlocks(r: Review, o: ReviewFileOpts): Block[] {
  const b: Block[] = [];
  const m = r.metrics, pt = point(r, o);
  const dates = eventDates(r, o.tz);
  b.push({ k: "muted", text: "POST-EVENT REVIEW" }, { k: "title", text: dates ? `${eventName(o)}: ${dates}` : eventName(o) });
  if (projectLine(o)) b.push({ k: "muted", text: projectLine(o) });
  b.push({ k: "muted", text: [o.preparedBy ? `Prepared by: ${o.preparedBy}` : null, `Written ${o.date}`].filter(Boolean).join("  ·  ") });

  b.push({ k: "h1", text: `1. ${pt.headline}` });
  for (const l of [...pt.lines, pt.span, scopeLine(r)].filter(Boolean)) b.push({ k: "bullet", text: l });
  if (pt.order && pt.steps.length) {
    b.push({ k: "h2", text: `${orderWord(pt.order)}: the steps that ran long` });
    b.push({ k: "table", head: ["Step", "Crew", "Planned", "Took", "Recorded on the step"], rows: stepRows(r, true), widths: [1.7, 0.9, 0.6, 0.6, 3.1] });
  }
  for (const g of pt.also) { b.push({ k: "p", lead: "Also late: ", text: g.effect }); for (const t of g.titles) b.push({ k: "bullet", text: `${t}.` }); }
  if (pt.quiet.length) { b.push({ k: "p", lead: "Did not move the finish:", text: "" }); for (const t of pt.quiet) b.push({ k: "bullet", text: `${t}.` }); }

  const close = toClose(r);
  b.push({ k: "h1", text: "2. What we change next time" });
  if (!close.length) b.push({ k: "p", text: "Nothing in the records calls for a change." });
  for (const f of close) {
    b.push({ k: "h2", text: f.title });
    b.push({ k: "p", lead: "What it cost: ", text: costOf(f) });
    b.push({ k: "p", lead: "What happened:", text: "" });
    for (const l of facts(f)) b.push({ k: "bullet", text: l });
    if (f.gap) b.push({ k: "p", lead: "What was missing: ", text: f.gap });
    if (f.next) b.push({ k: "p", lead: "What we do differently: ", text: f.next });
    if (f.year) b.push({ k: "p", lead: "Longer term: ", text: f.year });
    if (f.owner) b.push({ k: "p", lead: "Owner: ", text: f.owner });
  }

  const quiet = live(r).filter((f) => f.rating === "none" && f.source === "records" && f.moved === 0);
  if (quiet.length) {
    b.push({ k: "h1", text: "3. What happened that did not move the finish" });
    for (const f of quiet) { b.push({ k: "h2", text: f.title }); for (const l of facts(f)) b.push({ k: "bullet", text: l }); if (f.next) b.push({ k: "p", text: f.next }); }
  }

  b.push({ k: "h1", text: `${quiet.length ? 4 : 3}. What performed well` });
  if (r.strengths.length) for (const s of r.strengths) b.push({ k: "bullet", text: s }); else b.push({ k: "p", text: "Nothing the records single out." });

  b.push({ k: "h1", text: `${quiet.length ? 5 : 4}. The event in numbers` });
  b.push({ k: "table", head: ["Measure", "Result", "How it is counted"], rows: metricRows(r), widths: [2.0, 2.0, 2.9] });
  if (r.measures.some((x) => x.set)) b.push({ k: "table", head: ["Measure", "This event", "Target for the next event"], rows: r.measures.filter((x) => x.set).map((x) => [x.measure, x.result, x.target]), widths: [3.4, 1.7, 1.8] });

  if (r.organization) {
    const o2 = r.organization;
    b.push({ k: "h1", text: `${quiet.length ? 6 : 5}. Event organization` });
    b.push({ k: "p", text: `${o2.filled} of ${o2.required} required roles have a named person${o2.missing.length ? `. Not named: ${o2.missing.join(", ")}` : ""}.` });
    b.push({ k: "table", head: ["Role", "Named", "Responsible for", "Required"], rows: o2.roles.map((x) => [x.role, x.person || "Not named", x.does, x.required ? "Yes" : "No"]), widths: [2.0, 1.6, 2.7, 0.6] });
  }

  b.push({ k: "h1", text: `Appendix A. Found work (${plural(r.found.length, "finding")}, ${plural(m.addedSteps, "activity", "activities")})` });
  if (r.found.length) b.push({ k: "table", head: ["Finding", "Where", "Activities", "Work when approved", "Critical path", "Approved by"], rows: foundRows(r), widths: [2.8, 0.9, 0.7, 1.0, 0.7, 0.8] }); else b.push({ k: "p", text: "None." });
  b.push({ k: "h1", text: "Appendix B. Jobs that waited" });
  if (waitedRows(r).length) b.push({ k: "table", head: ["Job", "Crew", "What happened", "When", "Why, from the record"], rows: waitedRows(r), widths: [1.7, 0.9, 1.1, 1.0, 2.2] }); else b.push({ k: "p", text: "None." });
  b.push({ k: "muted", text: "Night shifts count only for work that ran on nights. Equipment out for repair or calibration is a planned step, not waiting." });
  b.push({ k: "h1", text: "Appendix C. Anticipated questions" });
  for (const x of r.qa) b.push({ k: "p", lead: `${x.q} `, text: x.a });
  b.push({ k: "h1", text: "Appendix D. How each number is counted" });
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

type Item = string | { text: string; sub?: boolean; bold?: boolean };
type Pane = { title: string; items?: Item[]; table?: { head: string[]; rows: string[][]; widths: number[]; title?: string } };
export interface SlideSpec {
  kicker: string; title: string; notes: string;
  body:
    | { k: "cover"; sub: string; meta: string; agenda: string[] }
    | { k: "table"; head: string[]; rows: string[][]; widths: number[]; foot?: string }
    | { k: "split"; left: Pane; right: Pane; ratio?: number; foot?: string };
}

/** Rows a slide at a time, by how much there is to read. */
function pages(rows: string[][], maxChars: number, maxRows: number): string[][][] {
  const out: string[][][] = []; let cur: string[][] = [], n = 0;
  for (const r of rows) {
    const len = r.join("").length + 40;
    if (cur.length && (n + len > maxChars || cur.length >= maxRows)) { out.push(cur); cur = []; n = 0; }
    cur.push(r); n += len;
  }
  if (cur.length) out.push(cur);
  return out.length ? out : [[]];
}
const part = (i: number, n: number) => (n > 1 ? ` (${i + 1} of ${n})` : "");

/** The deck, slide by slide (what the PowerPoint is drawn from). */
export function deckSlides(r: Review, o: ReviewFileOpts): SlideSpec[] {
  const m = r.metrics, s: SlideSpec[] = [], pt = point(r, o);
  const close = toClose(r);
  const dates = eventDates(r, o.tz);
  s.push({ kicker: "Post-event review", title: dates ? `${eventName(o)}: ${dates}` : eventName(o), notes: "What set the finish, what we change next time, and the jobs behind it.",
    body: { k: "cover", sub: projectLine(o), meta: [o.preparedBy, `Written ${o.date}`].filter(Boolean).join("  ·  "), agenda: ["What set the finish", "What we change next time", "Backup: the jobs behind it"] } });

  // The point: what set the finish, and beside it everything that did not.
  const rest: Item[] = [];
  for (const g of pt.also) { rest.push({ text: g.effect, bold: true }); for (const t of g.titles) rest.push({ text: t, sub: true }); }
  if (pt.quiet.length) { rest.push({ text: "Did not move the finish", bold: true }); for (const t of pt.quiet) rest.push({ text: t, sub: true }); }
  s.push({ kicker: "1 · The point", title: pt.headline, notes: [...pt.lines, pt.span, scopeLine(r)].filter(Boolean).join(" "),
    body: { k: "split", ratio: 0.6,
      left: { title: pt.order ? "What set the finish" : "The finish", items: pt.lines.length ? pt.lines : [pt.span || scopeLine(r)].filter(Boolean),
        ...(pt.order && pt.steps.length ? { table: { title: `${orderWord(pt.order)}: the steps that ran long`, head: ["Step", "Crew", "Planned", "Took"], rows: stepRows(r, false), widths: [4.2, 1.6, 1.0, 1.0] } } : {}) },
      right: { title: "Everything else", items: rest.length ? rest : ["Nothing else in the records moved the finish."] },
      foot: [pt.span, scopeLine(r)].filter(Boolean).join(" ") } });

  // What we change.
  // An owner column only when someone is named: the records don't make one up.
  const owned = close.some((f) => f.owner);
  const cRows = close.map((f) => [`${f.title}\n${f.proof}`, costOf(f), f.next, ...(owned ? [f.owner || "To name"] : [])]);
  if (cRows.length) pages(cRows, 2600, 5).forEach((rows, i, a) =>
    s.push({ kicker: `2 · Next time${part(i, a.length)}`, title: "What we change next time", notes: close.map((f) => `${f.title}: ${f.next}`).join(" "),
      body: { k: "table", head: ["What happened", "What it cost", "What we do differently", ...(owned ? ["Owner"] : [])], widths: owned ? [4.4, 2.6, 3.9, 1.6] : [4.8, 3.0, 4.7], rows } }));

  if (r.organization) s.push({ kicker: "Backup · organization", title: `Event organization: ${r.organization.filled} of ${r.organization.required} required roles named`, notes: r.organization.missing.length ? `Not named yet: ${r.organization.missing.join(", ")}.` : "Every required role has a named person.", body: { k: "table", head: ["Role", "Named", "Responsible for"], widths: [3.6, 2.8, 5.9], rows: r.organization.roles.filter((x) => x.required || x.person).map((x) => [x.role, x.person || "Not named", x.does]) } });
  if (r.measures.some((x) => x.set)) s.push({ kicker: "Backup · targets", title: "Targets for the next event", notes: "Targets agreed in the review, against this event's result.", body: { k: "table", head: ["Measure", "This event", "Target"], widths: [6.3, 3.0, 3.0], rows: r.measures.filter((x) => x.set).map((x) => [x.measure, x.result, x.target]) } });

  // Backup: the jobs behind it.
  if (pt.order && pt.steps.some((st) => st.said.length)) s.push({ kicker: `Backup · ${orderWord(pt.order)}`, title: `${orderWord(pt.order)}: what was written on the steps that ran long`, notes: "The comments are the crew's own, as written on each step.",
    body: { k: "table", head: ["Step", "Crew", "Planned", "Took", "Recorded on the step"], widths: [3.0, 1.4, 0.9, 0.9, 6.1], rows: stepRows(r, true) } });
  if (r.found.length) pages(foundRows(r), 1500, 8).forEach((rows, i, a) =>
    s.push({ kicker: `Backup · found work${part(i, a.length)}`, title: `${m.addedSteps} activities were added from ${plural(r.found.length, "finding")}${m.addedPct != null ? ` (${m.addedH} h on a ${m.baselineH} h plan)` : ""}`, notes: "Hours are the work estimated when each finding was approved.",
      body: { k: "table", head: ["Finding", "Where", "Activities", "Work when approved", "Critical path", "Approved by"], widths: [5.6, 1.3, 1.1, 1.6, 1.2, 1.5], rows } }));
  const waited = waitedRows(r);
  if (waited.length) pages(waited, 2600, 12).forEach((rows, i, a) =>
    s.push({ kicker: `Backup · jobs that waited${part(i, a.length)}`, title: "Jobs that waited, and why", notes: "A job that waits and still finishes before the last work is done does not move the finish. Equipment out for service is a planned step.",
      body: { k: "table", head: ["Job", "Crew", "What happened", "When", "Why, from the record"], widths: [3.3, 1.5, 2.0, 1.7, 3.8], rows, foot: "A job that waits and still finishes before the last work is done does not move the finish." } }));
  pages(r.qa.map((x) => [x.q, x.a]), 2600, 8).forEach((rows, i, a) => s.push({ kicker: `Backup · questions${part(i, a.length)}`, title: "Questions you may get", notes: "Prepared answers, each from the records.", body: { k: "table", head: ["Question", "Answer"], widths: [3.4, 8.9], rows } }));
  return s;
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
  for (const spec of deckSlides(r, o)) {
    const s = p.addSlide();
    s.background = { color: BG };
    const b = spec.body;
    const bullets = (items: Item[], x: number, y: number, w: number, h: number, size: number) =>
      s.addText(items.map((it) => { const o = typeof it === "string" ? { text: it } : it; return { text: T(o.text), options: { bullet: o.bold ? false : { indent: 14 }, bold: !!o.bold, indentLevel: o.sub ? 1 : 0, breakLine: true, paraSpaceBefore: o.bold ? 6 : 0, paraSpaceAfter: 5 } }; }), { x, y, w, h, fontFace: face, fontSize: size, color: INK, valign: "top" });
    const table = (head: string[], rows: string[][], widths: number[], x: number, y: number, w: number, size?: number) => {
      const total = widths.reduce((a, c) => a + c, 0);
      const chars = rows.reduce((n, row) => n + row.join("").length, 0);
      const fs = size ?? (chars > 1300 ? 10 : chars > 800 ? 11 : 12);
      s.addTable([head.map((h) => ({ text: T(h), options: { bold: true, color: "FFFFFF", fill: { color: INK }, fontFace: face, fontSize: fs } })),
        ...rows.map((row, ri) => head.map((_, i) => {
          const options = { color: INK, fill: { color: ri % 2 ? "ECE8DF" : BG }, fontFace: face, fontSize: fs, valign: "top" as const };
          // A first cell of two lines: what it is in bold, the fact under it plain.
          const [lead, ...more] = (row[i] ?? "").split("\n");
          if (i === 0 && more.length) return { text: [{ text: T(lead), options: { bold: true, breakLine: true } }, { text: T(more.join(" ")), options: { bold: false } }], options };
          return { text: T(row[i] ?? ""), options: { ...options, bold: i === 0 } };
        }))],
      { x, y, w, colW: widths.map((c) => (c / total) * w), border: { type: "none" }, margin: [3, 5, 3, 5] });
    };
    const pane = (pn: Pane, x: number, y: number, w: number, h: number) => {
      s.addText(T(pn.title.toUpperCase()), { x, y, w, h: 0.3, fontFace: face, fontSize: 11, bold: true, color: ACC, charSpacing: 1 });
      const items = pn.items ?? [];
      const chars = items.reduce((n, it) => n + (typeof it === "string" ? it : it.text).length, 0);
      const size = chars > 620 ? 12 : 13;
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
    if (b.k === "table") {
      table(b.head, b.rows, b.widths, 0.6, 1.55, 12.1);
      foot(b.foot);
    } else if (b.k === "split") {
      const lw = 12.1 * (b.ratio ?? 0.5) - 0.15;
      pane(b.left, 0.6, 1.55, lw, 5.2);
      pane(b.right, 0.6 + lw + 0.3, 1.55, 12.1 - lw - 0.3, 5.2);
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
export const fileStem = (o: ReviewFileOpts) => `${o.phase ? `${o.phase} post-event review, ${o.project}` : `${o.project} post-event review`}`.replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim();
