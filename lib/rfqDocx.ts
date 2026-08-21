// lib/rfqDocx.ts — the STARTER RFQ: a real .docx built from the project's
// own data, ready to send with a quote link.
//
// Not a template the user must author first — a batteries-included Request
// For Quote assembled from what the platform already knows: project name
// and purpose, the Summary of Work reference, the scope label (RFQ group),
// the turnover package the winner must deliver (seeded by job size), and
// the submission instructions with the contractor's tokened quote link.
// The point is symmetry: the system READS inbound quotes, so it should
// also write the outbound ask that makes those quotes comparable — asking
// every bidder for the same price breakdown, labor hours, crew size, and
// explicit exclusions the bid tabulation scores on.
//
// Built with PizZip alone (a .docx is a zip of XML) — no template file,
// no new dependency.

import PizZip from "pizzip";

export interface RfqInput {
  projectName: string;
  orgName?: string | null;
  companyName: string;               // who this RFQ is addressed to
  rfqGroup: string | null;           // the scope label bids tabulate under
  purpose?: string | null;
  sowLabel?: string | null;          // Summary of Work document reference
  quoteUrl: string;                  // their tokened submission link
  dueDate?: string | null;           // YYYY-MM-DD
  turnoverItems: string[];           // required package contents
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** One paragraph. style: Title | Heading | Normal | Bullet */
function para(text: string, style: "Title" | "Heading" | "Normal" | "Bullet" = "Normal"): string {
  const props =
    style === "Title" ? `<w:pPr><w:spacing w:after="120"/></w:pPr><w:rPr><w:b/><w:sz w:val="40"/></w:rPr>`
    : style === "Heading" ? `<w:pPr><w:spacing w:before="240" w:after="80"/></w:pPr><w:rPr><w:b/><w:sz w:val="26"/></w:rPr>`
    : style === "Bullet" ? `<w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:rPr><w:sz w:val="22"/></w:rPr>`
    : `<w:pPr><w:spacing w:after="80"/></w:pPr><w:rPr><w:sz w:val="22"/></w:rPr>`;
  const [pPr, rPr] = props.split("</w:pPr>");
  return `<w:p>${pPr}</w:pPr><w:r>${rPr ?? ""}<w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`;
}

function documentXml(i: RfqInput): string {
  const scope = i.rfqGroup ?? "the attached scope";
  const body: string[] = [
    para(`Request for Quote — ${scope}`, "Title"),
    para(`${i.projectName}${i.orgName ? ` · ${i.orgName}` : ""}`, "Normal"),
    para(`To: ${i.companyName}`, "Normal"),
    ...(i.dueDate ? [para(`Quotes due: ${new Date(i.dueDate + "T00:00:00").toLocaleDateString()}`, "Normal")] : []),

    para("1. Scope of work", "Heading"),
    para(i.purpose
      ? `${i.purpose}`
      : "Provide all labor, supervision, equipment, and consumables to complete the scope described below and in the referenced documents."),
    ...(i.sowLabel
      ? [para(`The controlling scope document is the Summary of Work: ${i.sowLabel}. Where this letter and the Summary of Work differ, the Summary of Work governs.`)]
      : [para("A Summary of Work will be issued with this request; it governs the scope.")]),

    para("2. Your quote must include", "Heading"),
    para("Quotes are compared line by line on price, manpower, and scope coverage. To be evaluated fairly, include:"),
    para("A price breakdown by scope item — not a single lump sum.", "Bullet"),
    para("Labor hours and crew size (peak headcount) per item, by craft.", "Bullet"),
    para("An explicit EXCLUSIONS list — anything you are not pricing. Undeclared gaps found during evaluation count against the bid; declared exclusions do not.", "Bullet"),
    para("Quote validity date, and any schedule constraints or premium-time assumptions.", "Bullet"),

    para("3. Turnover package (required from the successful bidder)", "Heading"),
    ...(i.turnoverItems.length > 0
      ? i.turnoverItems.map((t) => para(t, "Bullet"))
      : [para("The required quality/turnover package will be confirmed at award.", "Normal")]),

    para("4. How to submit", "Heading"),
    para(`Submit your quote as a PDF through your dedicated portal link (no account needed):`),
    para(i.quoteUrl),
    para("Your submission is timestamped and lands directly in our bid evaluation. You will see your bid's status (under review / awarded / not selected) at the same link."),
  ];

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>${body.join("")}
<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>
</w:body></w:document>`;
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
</Types>`;

const RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

const DOC_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>
</Relationships>`;

// One bullet list definition (numId 1 → bullet "•").
const NUMBERING = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum>
<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
</w:numbering>`;

/** Build the RFQ and hand it to the browser as a download. */
export function downloadStarterRfq(input: RfqInput): void {
  const zip = new PizZip();
  zip.file("[Content_Types].xml", CONTENT_TYPES);
  zip.file("_rels/.rels", RELS);
  zip.file("word/_rels/document.xml.rels", DOC_RELS);
  zip.file("word/numbering.xml", NUMBERING);
  zip.file("word/document.xml", documentXml(input));
  const blob = zip.generate({
    type: "blob",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
  const safe = (input.rfqGroup ?? "scope").replace(/[^\w\- ]+/g, "").slice(0, 60).trim().replace(/\s+/g, "-");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `RFQ-${safe || "scope"}-${input.companyName.replace(/[^\w\- ]+/g, "").slice(0, 40).trim().replace(/\s+/g, "-")}.docx`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
