// lib/rfqFromScope.ts - the RFQ letter, in the plant's own layout (the
// Kern Energy RFQ template: To / From / Date / Contact / Work Location;
// 1 Schedule & Shift Coverage; 2 Scope at a Glance; 3 Site Expectations;
// 4 What to Include with Your Quote; 5 Submission; Binder Contents),
// filled from the project: the scope counted from the work order list's
// groups, the shift times and turnover meetings from the project's
// settings, the dates and who it's to and from as typed. The work orders
// themselves go on the last pages, grouped as the list groups them.
//
// rfqContent is pure (what the letter says); rfqDocx makes the Word file.

import PizZip from "pizzip";
import { byCategory, type ScopeComing, type ScopeWO } from "@/lib/woIntake";

export interface RfqFrom {
  project: string;
  org: string;
  service: string;
  to: string;
  fromName: string;
  contact: string;
  location: string;
  /** "YYYY-MM-DD" */
  quoteBy: string;
  start?: string;
  finish?: string;
  dayStart: string;
  nightStart: string;
  meetingBefore: number;
  nights: boolean;
  workByOthers?: string;
  equipmentPlan?: string;
  ownerSupplies?: string;
  crews?: string[];
  items: ScopeWO[];
  coming: ScopeComing[];
  today?: Date;
}

/** The plant's words for a group of work in Scope at a Glance. */
const GLANCE: Array<[RegExp, string]> = [
  [/^tower/i, "Towers (tunnel and clean)"],
  [/^exchanger/i, "Heat exchangers (open, clean, service)"],
  [/^fin ?fan/i, "Fin fans"],
  [/^vessel/i, "Vessels"],
  [/^heater/i, "Heaters (open for inspection)"],
  [/^piping/i, "Piping work orders"],
  [/^pump/i, "Pumps"],
];

const hhmm = (v: string) => v.replace(":", "").padStart(4, "0");
const minus = (v: string, min: number) => { const [h, m] = v.split(":").map(Number); const t = ((h * 60 + m - min) % 1440 + 1440) % 1440; return `${String(Math.floor(t / 60)).padStart(2, "0")}${String(t % 60).padStart(2, "0")}`; };
const longDate = (d: Date) => d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
const mdy = (iso?: string) => { if (!iso) return ""; const [y, m, d] = iso.split("-"); return `${Number(m)}/${Number(d)}/${y}`; };

export interface RfqContent {
  title: string;
  subtitle: string;
  head: Array<[string, string]>;
  quoteBy: string;
  intro: string;
  coverage: { rows: string[][]; shifts: string };
  glance: { rows: Array<[string, number, number]>; note: string; coming: string | null };
  expectations: Array<[string, string]>;
  include: Array<[string, string]>;
  submission: string;
  binder: string;
  workOrders: Array<{ group: string; rows: Array<[string, string, string]> }>;
}

/** What the letter says, from the project. */
export function rfqContent(f: RfqFrom): RfqContent {
  const today = f.today ?? new Date();
  const year = f.start ? f.start.slice(0, 4) : String(today.getFullYear());
  const groups = byCategory(f.items);
  const rows: Array<[string, number, number]> = [];
  // The list's own groups, in the plant's words where it has them; nothing
  // counted twice.
  for (const g of groups) {
    const word = GLANCE.find(([re]) => re.test(g.category))?.[1] ?? g.category;
    rows.push([word, g.equipment, g.items.length]);
  }
  const coverage = f.nights ? "12-hr day and night shifts (24-hr coverage)" : "12-hr day shifts";
  const meetings = [minus(f.dayStart, f.meetingBefore), minus(f.nightStart, f.meetingBefore)];
  return {
    title: `Request for Quotation (RFQ): ${year} ${f.project}`,
    subtitle: `${f.service} for the ${f.project}`,
    head: [["To", f.to], ["From", `${f.fromName}, ${f.org}`], ["Date", longDate(today)], ["Contact", f.contact], ["Work Location", f.location]],
    quoteBy: mdy(f.quoteBy),
    intro: `${f.org} is requesting a quotation for ${f.service.toLowerCase()} on the ${f.project}. The Scope of Work and schedule are included in this binder. This letter covers timing, site expectations, and what we would like to see in your quote.`,
    coverage: {
      rows: [[f.project, f.start ? `${mdy(f.start)} - ${hhmm(f.dayStart)}` : "To be confirmed", f.finish ? mdy(f.finish) : "To be confirmed", coverage]],
      shifts: `Shifts run ${hhmm(f.dayStart)} to ${hhmm(f.nightStart)} (days)${f.nights ? ` and ${hhmm(f.nightStart)} to ${hhmm(f.dayStart)} (nights)` : ""}.`,
    },
    glance: {
      rows,
      note: `Equipment details and work orders are listed at the end of this letter and in the Scope of Work.${f.workByOthers?.trim() ? ` ${f.workByOthers.trim().replace(/\.?$/, ".")}` : ""}`,
      // "Control Valves" reads "control valves"; "PSVs" stays as written.
      coming: f.coming.length ? `Scope still being added: ${f.coming.map((c) => (/^[A-Z][a-z]/.test(c.what) ? c.what.toLowerCase() : c.what)).join(", ")}. An addendum will follow.` : null,
    },
    expectations: [
      ["On-Site QA/QC.", "The turnaround will need a dedicated on-site QA/QC representative from your team, covering every shift worked. This role handles QC sign-offs in the schedule, blind and torque records, hydrotest records, weld and NDE documentation for piping work, and a turnover package at the close of the turnaround."],
      ["Shift Turnover Meetings.", `${f.org} holds shift turnover meetings daily at ${meetings[0]}${f.nights ? ` and ${meetings[1]}` : ""}. Supervision from your team will need to attend each meeting throughout the turnaround.`],
      ["Safety.", "All team members working on site who have not completed our facility's contractor site-specific orientation or whose training has expired must complete or renew it prior to starting work."],
    ],
    include: [
      ["Staffing Plan:", `An organization chart naming key supervision and QA/QC, daily headcount by craft and shift, and crew assignments aligned with the schedule resources${f.crews?.length ? ` (${f.crews.join(", ")})` : ""}.`],
      ["Equipment Plan:", f.equipmentPlan?.trim() || "Rigging, bolting, and hydrotest equipment."],
      ["Clarifications & Exclusions:", `Including any materials, consumables, or services you are assuming ${f.org} will provide${f.ownerSupplies?.trim() ? ` (${f.ownerSupplies.trim()})` : ""}.`],
    ],
    submission: `Please send your quotation to the contact above by ${mdy(f.quoteBy)}. Questions are welcome at any time by phone or email.`,
    binder: `Binder Contents: (1) this RFQ letter; (2) ${f.project} Scope of Work & Schedule.`,
    workOrders: groups.map((g) => ({ group: `${g.category} (${g.items.length})`, rows: g.items.map((x) => [x.wo, [x.tag, x.equipmentName || x.equipment].filter(Boolean).join(" "), x.what] as [string, string, string]) })),
  };
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const run = (t: string, o: { b?: boolean; sz?: number; color?: string } = {}) =>
  `<w:r><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/>${o.b ? "<w:b/>" : ""}${o.color ? `<w:color w:val="${o.color}"/>` : ""}<w:sz w:val="${o.sz ?? 22}"/></w:rPr><w:t xml:space="preserve">${esc(t)}</w:t></w:r>`;
const p = (runs: string, after = 120, extra = "") => `<w:p><w:pPr><w:spacing w:after="${after}"/>${extra}</w:pPr>${runs}</w:p>`;
const NAVY = "0B1F4D";
const cell = (w: number, inner: string, shade?: string) => `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/>${shade ? `<w:shd w:val="clear" w:color="auto" w:fill="${shade}"/>` : ""}<w:tcMar><w:top w:w="60" w:type="dxa"/><w:left w:w="100" w:type="dxa"/><w:bottom w:w="60" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tcMar></w:tcPr>${inner}</w:tc>`;
const table = (widths: number[], rows: string[][], headRow = true) =>
  `<w:tbl><w:tblPr><w:tblW w:w="${widths.reduce((a, b) => a + b, 0)}" w:type="dxa"/><w:tblBorders>${["top", "left", "bottom", "right", "insideH", "insideV"].map((k) => `<w:${k} w:val="single" w:sz="4" w:space="0" w:color="BFC7D5"/>`).join("")}</w:tblBorders><w:tblLayout w:type="fixed"/></w:tblPr><w:tblGrid>${widths.map((w) => `<w:gridCol w:w="${w}"/>`).join("")}</w:tblGrid>` +
  rows.map((r, i) => `<w:tr>${r.map((c, j) => cell(widths[j], p(run(c, { b: headRow && i === 0, sz: 20 }), 0), headRow && i === 0 ? "EEF1F8" : undefined)).join("")}</w:tr>`).join("") + `</w:tbl>`;

function documentXml(c: RfqContent): string {
  const W = 9360;
  const h = (t: string) => p(run(t, { b: true, sz: 24, color: NAVY }), 80, '<w:spacing w:before="240" w:after="80"/>');
  const body = [
    p(run(c.title, { b: true, sz: 32, color: NAVY }), 40),
    p(run(c.subtitle, { b: true, sz: 24 }), 200),
    table([2000, W - 2000], c.head.map(([k, v]) => [k, v]), false),
    p(run("Preferred Quote Date  ", { b: true }) + run(c.quoteBy), 160, '<w:spacing w:before="160" w:after="160"/>'),
    p(run(c.intro)),
    h("1)  Schedule & Shift Coverage"),
    table([2700, 2000, 2000, W - 6700], [["Unit", "Mechanical Start", "Mechanical Complete", "Shift Coverage"], ...c.coverage.rows]),
    p(run(c.coverage.shifts), 120, '<w:spacing w:before="120" w:after="120"/>'),
    h("2)  Scope at a Glance"),
    table([W - 3000, 1500, 1500], [["Equipment / Work Type", "Equipment", "Work orders"], ...c.glance.rows.map(([a, b, n]) => [a, String(b), String(n)])]),
    p(run(c.glance.note), 80, '<w:spacing w:before="120" w:after="80"/>'),
    ...(c.glance.coming ? [p(run(c.glance.coming, { b: true }))] : []),
    h("3)  Site Expectations"),
    ...c.expectations.map(([k, v]) => p(run(`${k} `, { b: true }) + run(v))),
    h("4)  What to Include with Your Quote"),
    ...c.include.map(([k, v], i) => p(run(`${i + 1}.  ${k} `, { b: true }) + run(v), 100, '<w:ind w:left="360"/>')),
    h("5)  Submission"),
    p(run(c.submission)),
    p(run(c.binder, { b: true }), 120),
    `<w:p><w:r><w:br w:type="page"/></w:r></w:p>`,
    p(run("Work orders in this scope", { b: true, sz: 28, color: NAVY }), 120),
    ...c.workOrders.flatMap((g) => [p(run(g.group, { b: true, sz: 22 }), 60, '<w:spacing w:before="160" w:after="60"/>'), table([1200, 3000, W - 4200], [["WO", "Equipment", "Work"], ...g.rows.map((r) => [...r])])]),
  ];
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body.join("")}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1080" w:right="1440" w:bottom="1080" w:left="1440"/></w:sectPr></w:body></w:document>`;
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;
const RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;

/** The RFQ as a Word file. */
export function rfqDocx(f: RfqFrom): Uint8Array {
  const zip = new PizZip();
  zip.file("[Content_Types].xml", CONTENT_TYPES);
  zip.file("_rels/.rels", RELS);
  zip.file("word/document.xml", documentXml(rfqContent(f)));
  return zip.generate({ type: "uint8array" });
}
