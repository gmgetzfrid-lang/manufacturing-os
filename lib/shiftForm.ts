// shiftForm - the shift update in the plant's required format: one table,
// the row's name on the left and what was done on the right.
//
//   Title           | LRU Turnaround November 2026       November 5, 2026 6:00 AM – 6:00 PM
//   5:30 AM Meeting Attendees | Operations – names ... (crew bold)
//   Safety          | No Safety Incidents (bold, underlined) · Safety Topics – ...
//   Work to be Completed After 5:30 AM Meeting | by crew (bold), numbered items
//   Work Completed Between 5:30 AM and 6:00 PM | by crew, numbered items
//   Follow-Up Items | numbered
//   Shift Notes     | 7:00 – what happened (time bold)
//   Personnel Headcount | Maintenance – 6 (bold)
//
// Filled from the shift's own record (the meeting's roster and head count,
// incidents, the safety topic, follow-ups, the hour-by-hour notes) and the
// report (what was planned and done, by crew). Any row can be left out.
// The same table goes out as an email (copied with its formatting), as
// text, printed, and as a Word file laid out like the plant's own.
//
// Pure, except the Word file (JSZip, loaded when asked).

import { noEmDash } from "@/lib/noEmDash";

export type FormRowId = "attend" | "safety" | "plan" | "done" | "followup" | "notes" | "headcount";

export type FormLine =
  /** A crew's name over its items ("Schultz"). */
  | { k: "group"; text: string }
  /** A numbered item; numbering starts again under each group. */
  | { k: "item"; text: string }
  /** A line; `lead` in bold before it ("Operations" – "Jess Montgomery"),
   *  `strong` the whole line bold and underlined ("No Safety Incidents"),
   *  `bold` the whole line bold ("Maintenance – 6"). */
  | { k: "text"; text: string; lead?: string; strong?: boolean; bold?: boolean };

export interface FormRow { id: FormRowId; label: string; lines: FormLine[] }
export interface ShiftForm {
  /** "LRU Turnaround November 2026" */
  title: string;
  /** "November 5, 2026 6:00 AM – 6:00 PM" */
  when: string;
  rows: FormRow[];
}

export const FORM_ROWS: Array<{ id: FormRowId; word: string }> = [
  { id: "attend", word: "Meeting attendees" },
  { id: "safety", word: "Safety" },
  { id: "plan", word: "Work to be completed" },
  { id: "done", word: "Work completed" },
  { id: "followup", word: "Follow-up items" },
  { id: "notes", word: "Shift notes" },
  { id: "headcount", word: "Headcount" },
];

export interface FormInput {
  project: string;
  /** "November 5, 2026", "6:00 AM", "6:00 PM", the meeting's "5:30 AM". */
  date: string; start: string; end: string; meeting: string;
  attendees: Array<{ crew: string; names: string }>;
  incidents?: { none: boolean; items: Array<{ kind: string; text: string; time?: string }> };
  safetyTopic?: string;
  /** Work for the shift and work done, each with its crew. */
  planned: Array<{ crew: string; text: string }>;
  completed: Array<{ crew: string; text: string }>;
  followUps: string[];
  /** The hours: "7:00" and what happened. */
  notes: Array<{ clock: string; text: string }>;
  headcount: Array<{ crew: string; n: number }>;
}

const clean = (s: string) => noEmDash(s).replace(/\s+/g, " ").trim();

/** Items by crew, crews in the order they first come. */
function byCrew(list: Array<{ crew: string; text: string }>): FormLine[] {
  const groups = new Map<string, string[]>();
  for (const x of list) {
    const crew = clean(x.crew) || "Other";
    const t = clean(x.text);
    if (!t) continue;
    const g = groups.get(crew) ?? [];
    if (!g.includes(t)) g.push(t);
    groups.set(crew, g);
  }
  return [...groups.entries()].flatMap(([crew, items]) => [{ k: "group" as const, text: crew }, ...items.map((t) => ({ k: "item" as const, text: t }))]);
}

/** The table, from the shift's data. Rows with nothing in them still show,
 *  saying so, so the reader knows it was looked at. */
export function shiftForm(i: FormInput): ShiftForm {
  const none = (t: string): FormLine[] => [{ k: "text", text: t }];
  const rows: FormRow[] = [
    { id: "attend", label: `${i.meeting} Meeting Attendees`,
      lines: i.attendees.filter((a) => clean(a.names)).length
        ? i.attendees.filter((a) => clean(a.names)).map((a) => ({ k: "text" as const, lead: clean(a.crew), text: ` – ${clean(a.names)}` }))
        : none("No attendance entered") },
    { id: "safety", label: "Safety", lines: [
      ...(i.incidents?.none && !i.incidents.items.length ? [{ k: "text" as const, text: "No Safety Incidents", strong: true }]
        : i.incidents?.items.length ? i.incidents.items.map((x) => ({ k: "text" as const, lead: clean(x.kind), text: ` – ${[x.time, clean(x.text)].filter(Boolean).join(" ")}` }))
          : [{ k: "text" as const, text: "Incidents not entered" }]),
      ...(clean(i.safetyTopic ?? "") ? [{ k: "text" as const, text: `Safety Topics – ${clean(i.safetyTopic!)}` }] : []),
    ] },
    { id: "plan", label: `Work to be Completed After ${i.meeting} Meeting`, lines: i.planned.length ? byCrew(i.planned) : none("No work planned for the shift") },
    { id: "done", label: `Work Completed Between ${i.meeting} and ${i.end}`, lines: i.completed.length ? byCrew(i.completed) : none("Nothing entered as done") },
    { id: "followup", label: "Follow-Up Items", lines: i.followUps.map(clean).filter(Boolean).length ? i.followUps.map(clean).filter(Boolean).map((t) => ({ k: "item" as const, text: t })) : none("None") },
    { id: "notes", label: "Shift Notes", lines: i.notes.filter((n) => clean(n.text)).length
      ? i.notes.filter((n) => clean(n.text)).map((n) => ({ k: "text" as const, lead: `${n.clock} –`, text: ` ${clean(n.text)}` }))
      : none("No notes entered") },
    { id: "headcount", label: "Personnel Headcount", lines: i.headcount.length ? i.headcount.map((h) => ({ k: "text" as const, text: `${clean(h.crew)} – ${h.n}`, bold: true })) : none("No head count entered") },
  ];
  return { title: clean(i.project), when: `${i.date} ${i.start} – ${i.end}`, rows };
}

/** The rows that go out. */
export const formRows = (f: ShiftForm, off: Iterable<FormRowId>) => { const o = new Set(off); return f.rows.filter((r) => !o.has(r.id)); };

// ─── Email (and print) ───────────────────────────────────────────────

const esc = (s: string) => noEmDash(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const FONT = "font-family:Calibri,Carlito,Arial,sans-serif;";
const CELL = `${FONT}font-size:11pt;color:#000000;border:1px solid #ABABAB;vertical-align:top;`;

function linesHtml(lines: FormLine[]): string {
  let out = "", list: string[] = [];
  const flush = () => { if (list.length) { out += `<ol style="${FONT}margin:0 0 6px 0;padding-left:28px;">${list.map((t) => `<li style="margin:0;">${esc(t)}</li>`).join("")}</ol>`; list = []; } };
  for (const l of lines) {
    if (l.k === "item") { list.push(l.text); continue; }
    flush();
    if (l.k === "group") out += `<div style="${FONT}font-size:11pt;font-weight:bold;margin:0;">${esc(l.text)}</div>`;
    else out += `<div style="${FONT}font-size:11pt;margin:0 0 2px 0;">${l.lead ? `<b>${esc(l.lead)}</b>` : ""}${l.strong ? `<b><u>${esc(l.text)}</u></b>` : l.bold ? `<b>${esc(l.text)}</b>` : esc(l.text)}</div>`;
  }
  flush();
  return out;
}

/** The table as an email body: inline styles only, so Outlook and Gmail
 *  keep it as it is. */
export function formHtml(f: ShiftForm, off: Iterable<FormRowId> = []): string {
  const rows = formRows(f, off);
  const title = `<td style="${CELL}padding:4px 6px;" width="19%"></td>` +
    `<td style="${CELL}padding:4px 6px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;"><tr>` +
    `<td style="${FONT}font-size:11pt;">${esc(f.title)}</td><td style="${FONT}font-size:11pt;text-align:right;white-space:nowrap;">${esc(f.when)}</td></tr></table></td>`;
  return `<table data-form="shift" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;max-width:820px;border:1px solid #ABABAB;background-color:#FFFFFF;" bgcolor="#FFFFFF">` +
    `<tr>${title}</tr>` +
    rows.map((r) => `<tr><td style="${CELL}padding:4px 6px;" width="19%">${esc(r.label)}</td><td style="${CELL}padding:4px 6px;">${linesHtml(r.lines)}</td></tr>`).join("") +
    `</table>`;
}

/** The table as plain text (a mail app that won't take formatting). */
export function formText(f: ShiftForm, off: Iterable<FormRowId> = []): string {
  const out: string[] = [`${f.title}    ${f.when}`, ""];
  for (const r of formRows(f, off)) {
    out.push(r.label.toUpperCase());
    let n = 0;
    for (const l of r.lines) {
      if (l.k === "group") { n = 0; out.push(l.text); }
      else if (l.k === "item") out.push(`  ${++n}. ${l.text}`);
      else out.push(`${l.lead ?? ""}${l.text}`);
    }
    out.push("");
  }
  return noEmDash(out.join("\n")).trim();
}

// ─── Word ─────────────────────────────────────────────────────────────

/** What goes above the table in the Word file (the update's header, the
 *  pieces picked): plain data, drawn here. */
export interface FormDocxHeader {
  kind?: string; project?: string; when?: string; asOf?: string;
  status?: { label: string; detail?: string; tone: "rose" | "amber" | "emerald" | "slate" | "muted" };
  standLine?: string;
  tiles?: Array<{ label: string; value: string; tone: "rose" | "amber" | "emerald" | "slate" | "muted" }>;
  bars?: { done: number; plan: number; from: string; to: string };
}

const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const xe = (s: string) => noEmDash(s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const run = (t: string, o: { b?: boolean; u?: boolean; sz?: number; color?: string } = {}) =>
  `<w:r>${o.b || o.u || o.sz || o.color ? `<w:rPr>${o.b ? "<w:b/>" : ""}${o.color ? `<w:color w:val="${o.color}"/>` : ""}${o.sz ? `<w:sz w:val="${o.sz}"/><w:szCs w:val="${o.sz}"/>` : ""}${o.u ? '<w:u w:val="single"/>' : ""}</w:rPr>` : ""}<w:t xml:space="preserve">${xe(t)}</w:t></w:r>`;
const BORDER = (c = "ABABAB") => `<w:tcBorders><w:top w:val="single" w:sz="6" w:space="0" w:color="${c}"/><w:left w:val="single" w:sz="6" w:space="0" w:color="${c}"/><w:bottom w:val="single" w:sz="6" w:space="0" w:color="${c}"/><w:right w:val="single" w:sz="6" w:space="0" w:color="${c}"/></w:tcBorders>`;
const TONE_FILL: Record<string, { fill: string; color: string }> = {
  rose: { fill: "FFF1F2", color: "9F1239" }, amber: { fill: "FFFBEB", color: "92400E" }, emerald: { fill: "ECFDF5", color: "065F46" },
  slate: { fill: "F1F5F9", color: "0F172A" }, muted: { fill: "F1F5F9", color: "475569" },
};
const cell = (w: number, inner: string, o: { fill?: string; border?: boolean } = {}) =>
  `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/>${o.border === false ? "" : BORDER()}${o.fill ? `<w:shd w:val="clear" w:color="auto" w:fill="${o.fill}"/>` : ""}<w:tcMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tcMar></w:tcPr>${inner || "<w:p/>"}</w:tc>`;
const para = (runs: string, pPr = "") => `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ""}${runs}</w:p>`;
const table = (widths: number[], rows: string[], borders = true) =>
  `<w:tbl><w:tblPr><w:tblW w:w="${widths.reduce((a, b) => a + b, 0)}" w:type="dxa"/>${borders ? '<w:tblBorders><w:top w:val="outset" w:sz="6" w:space="0" w:color="auto"/><w:left w:val="outset" w:sz="6" w:space="0" w:color="auto"/><w:bottom w:val="outset" w:sz="6" w:space="0" w:color="auto"/><w:right w:val="outset" w:sz="6" w:space="0" w:color="auto"/></w:tblBorders>' : ""}<w:tblLayout w:type="fixed"/><w:tblCellMar><w:left w:w="0" w:type="dxa"/><w:right w:w="0" w:type="dxa"/></w:tblCellMar><w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="1" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/></w:tblPr><w:tblGrid>${widths.map((w) => `<w:gridCol w:w="${w}"/>`).join("")}</w:tblGrid>${rows.join("")}</w:tbl>`;

// The plant's own: columns 1971 and 8649 twips, Calibri 11.
const COL_L = 1971, COL_R = 8649, FULL = COL_L + COL_R;

function headerXml(h: FormDocxHeader): string {
  let x = "";
  const left = [
    h.kind ? para(run(h.kind.toUpperCase(), { b: true, sz: 16, color: "64748B" }), '<w:spacing w:after="0"/>') : "",
    h.project ? para(run(h.project, { b: true, sz: 30 }), '<w:spacing w:after="0"/>') : "",
    h.when || h.asOf ? para(run([h.when, h.asOf ? `as of ${h.asOf}` : ""].filter(Boolean).join(" · "), { sz: 18, color: "334155" }), '<w:spacing w:after="40"/>') : "",
  ].join("");
  if (left || h.status) {
    const st = h.status ? TONE_FILL[h.status.tone] ?? TONE_FILL.slate : null;
    const statusW = h.status ? 2400 : 0;
    x += table(h.status ? [FULL - statusW, statusW] : [FULL], [`<w:tr>${cell(FULL - statusW, left, { fill: "F8FAFC" })}${h.status ? cell(statusW,
      para(run(h.status.label, { b: true, sz: 26, color: st!.color }), '<w:jc w:val="right"/><w:spacing w:after="0"/>') + (h.status.detail ? para(run(h.status.detail, { sz: 18, color: st!.color }), '<w:jc w:val="right"/><w:spacing w:after="0"/>') : ""),
      { fill: st!.fill }) : ""}</w:tr>`]);
    x += para("", '<w:spacing w:after="80"/>');
  }
  if (h.standLine) x += para(run("Where we stand  ", { b: true, sz: 24 }) + run(h.standLine, { sz: 18, color: "475569" }), '<w:spacing w:after="60"/>');
  if (h.tiles?.length) {
    const w = Math.floor(FULL / Math.max(4, h.tiles.length));
    x += table(h.tiles.map(() => w), [`<w:tr>${h.tiles.map((t) => { const s = TONE_FILL[t.tone] ?? TONE_FILL.slate; return cell(w, para(run(t.label, { b: true, sz: 18 }), '<w:spacing w:after="0"/>') + para(run(t.value, { b: true, sz: 22, color: s.color }), '<w:spacing w:after="0"/>'), { fill: s.fill }); }).join("")}</w:tr>`]);
    x += para("", '<w:spacing w:after="40"/>');
  }
  if (h.bars) {
    const LAB = 800, VAL = 700, BAR = FULL - LAB - VAL;
    const bar = (label: string, pct: number, fill: string) => {
      const p = Math.max(0, Math.min(100, Math.round(pct)));
      const a = Math.round((BAR * p) / 100), b = BAR - a;
      const inner = table([...(a > 0 ? [a] : []), ...(b > 0 ? [b] : [])], [`<w:tr><w:trPr><w:trHeight w:val="160" w:hRule="exact"/></w:trPr>${a > 0 ? cell(a, "<w:p/>", { fill, border: false }) : ""}${b > 0 ? cell(b, "<w:p/>", { fill: "E2E8F0", border: false }) : ""}</w:tr>`], false);
      return `<w:tr>${cell(LAB, para(run(label, { sz: 18, color: "475569" }), '<w:spacing w:after="0"/>'), { border: false })}${cell(BAR, inner + "<w:p/>", { border: false })}${cell(VAL, para(run(`${p}%`, { b: true, sz: 18 }), '<w:jc w:val="right"/><w:spacing w:after="0"/>'), { border: false })}</w:tr>`;
    };
    x += table([LAB, BAR, VAL], [bar("Done", h.bars.done, "0F766E"), bar("Plan", h.bars.plan, "94A3B8")], false);
    x += para(run(`${h.bars.from} → ${h.bars.to} · whole job`, { sz: 16, color: "64748B" }), `<w:ind w:left="${LAB}"/><w:spacing w:after="120"/>`);
  }
  return x;
}

/** The table (and the header picked) as a Word file, laid out like the
 *  plant's: Calibri 11, the same columns and borders, crews bold with
 *  their items numbered under them, the times in Shift Notes bold. */
export async function formDocx(f: ShiftForm, off: Iterable<FormRowId> = [], header?: FormDocxHeader): Promise<Uint8Array> {
  const JSZip = (await import("jszip")).default;
  const rows = formRows(f, off);
  const nums: number[] = [];
  const cellLines = (lines: FormLine[]) => {
    let out = "", num = 0;
    for (const l of lines) {
      if (l.k === "group") { num = 0; out += para(run(l.text, { b: true })); continue; }
      if (l.k === "item") {
        if (!num) { num = nums.length + 1; nums.push(num); }
        out += para(run(l.text), `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="${num}"/></w:numPr>`);
        continue;
      }
      num = 0;
      out += para((l.lead ? run(l.lead, { b: true }) : "") + run(l.text, { b: l.strong || l.bold, u: l.strong }));
    }
    return out || "<w:p/>";
  };
  const titleRow = `<w:tr><w:trPr><w:trHeight w:val="330"/></w:trPr>${cell(COL_L, "<w:p/>")}${cell(COL_R, para(run(f.title) + "<w:r><w:tab/></w:r>" + run(f.when), `<w:tabs><w:tab w:val="right" w:pos="${COL_R - 250}"/></w:tabs>`))}</w:tr>`;
  const body = (header ? headerXml(header) : "") + table([COL_L, COL_R], [
    titleRow,
    ...rows.map((r) => `<w:tr><w:trPr><w:trHeight w:val="330"/></w:trPr>${cell(COL_L, para(run(r.label)))}${cell(COL_R, cellLines(r.lines))}</w:tr>`),
  ]) + "<w:p/>";
  const sect = '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/><w:cols w:space="720"/></w:sectPr>';
  const numbering = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering ${W_NS}><w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum>${nums.map((n) => `<w:num w:numId="${n}"><w:abstractNumId w:val="0"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride></w:num>`).join("")}</w:numbering>`;
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`);
  zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`);
  zip.file("docProps/core.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xe(`${f.title} - ${f.when}`)}</dc:title></cp:coreProperties>`);
  zip.file("word/_rels/document.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/></Relationships>`);
  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W_NS}><w:body>${body}${sect}</w:body></w:document>`);
  zip.file("word/styles.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ${W_NS}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="259" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style><w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style></w:styles>`);
  zip.file("word/numbering.xml", numbering);
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}
