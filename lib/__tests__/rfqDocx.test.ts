// @vitest-environment jsdom
//
// projects Round G — RFQ-1 / RFQ-2 / BID-3 letter line. The starter RFQ's
// main document part must strict-parse whatever an org member pastes into
// a field (Word's Shift+Enter, Excel's multi-line cells, PDF form feeds), a
// multi-paragraph scope must survive as paragraphs and line breaks, a
// non-Latin vendor still gets a distinct filename, and the due date cannot
// be misread by any locale. Runs in jsdom for its strict XML DOMParser.

import { describe, it, expect } from "vitest";
import { buildRfqDocumentXml, cleanXmlText, rfqFileName, formatDueDate, fileSlug, type RfqInput } from "@/lib/rfqDocx";

const base: RfqInput = {
  projectName: "Unit 300 Revamp", orgName: "Bayou Fab", companyName: "Gulf Mechanical",
  rfqGroup: "Unit 300 exchanger repipe", purpose: "Replace piping.", sowLabel: "SOW-0012",
  quoteUrl: "https://example.test/submit/abc", dueDate: "2026-09-01", turnoverItems: ["Weld maps", "Hydrotest records"],
};

/** Strict parse: jsdom's XML parser reports malformed input as a
 *  <parsererror> document instead of throwing. */
function strictParse(xml: string): { ok: boolean; doc: Document } {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  return { ok: doc.getElementsByTagName("parsererror").length === 0, doc };
}
const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

describe("RFQ-1 — the document strict-parses whatever the fields contain", () => {
  it("a clean input parses", () => {
    expect(strictParse(buildRfqDocumentXml(base)).ok).toBe(true);
  });

  it("a purpose containing a Shift+Enter (VT) break produces a document that strict-parses, as a line break", () => {
    const xml = buildRfqDocumentXml({ ...base, purpose: "Replace piping.\u000BSecond line." });
    const { ok, doc } = strictParse(xml);
    expect(ok).toBe(true);
    expect(doc.getElementsByTagNameNS(W, "br").length).toBeGreaterThanOrEqual(1);
    expect(xml).not.toContain("\u000B");
  });

  it("fuzz: every C0 control byte, in every field, yields well-formed XML", () => {
    const controls = Array.from({ length: 0x20 }, (_, i) => String.fromCharCode(i)).concat("\u007F", "￾");
    const fields: Array<keyof RfqInput> = ["projectName", "orgName", "companyName", "rfqGroup", "purpose", "sowLabel", "quoteUrl"];
    for (const c of controls) {
      for (const f of fields) {
        const input = { ...base, [f]: `before${c}after` } as RfqInput;
        const { ok } = strictParse(buildRfqDocumentXml(input));
        expect(ok, `field ${f} with U+${c.charCodeAt(0).toString(16).padStart(4, "0")}`).toBe(true);
      }
      const { ok } = strictParse(buildRfqDocumentXml({ ...base, turnoverItems: [`item${c}x`, "plain"] }));
      expect(ok, `turnover item with U+${c.charCodeAt(0).toString(16)}`).toBe(true);
    }
  });

  it("cleanXmlText keeps line-break meaning and drops the rest; metacharacters are still escaped", () => {
    expect(cleanXmlText("a\u000Bb\u000Cc\r\nd\re\u0000f\u0007g")).toBe("a\nb\nc\nd\nefg");
    const xml = buildRfqDocumentXml({ ...base, purpose: "Fittings <2\" & \"valves\"" });
    expect(strictParse(xml).ok).toBe(true);
    expect(xml).toContain("&lt;2&quot; &amp; &quot;valves&quot;");
  });
});

describe("RFQ-2 — newlines, filenames and the due date", () => {
  it("a multi-paragraph purpose renders as multiple paragraphs with line breaks inside them", () => {
    const xml = buildRfqDocumentXml({ ...base, purpose: "Replace piping.\nSecond line.\n\nSecond paragraph.\n\nThird." });
    const { ok, doc } = strictParse(xml);
    expect(ok).toBe(true);
    const texts = [...doc.getElementsByTagNameNS(W, "t")].map((t) => t.textContent);
    expect(texts).toContain("Replace piping.");
    expect(texts).toContain("Second line.");
    expect(texts).toContain("Second paragraph.");
    expect(texts).toContain("Third.");
    // No <w:t> carries a raw newline any more.
    expect(texts.some((t) => (t ?? "").includes("\n"))).toBe(false);
    // Three paragraphs for three blocks, with one <w:br/> inside the first.
    const paras = [...doc.getElementsByTagNameNS(W, "p")].filter((p) => /Replace piping|Second paragraph|Third\./.test(p.textContent ?? ""));
    expect(paras).toHaveLength(3);
    expect(paras[0].getElementsByTagNameNS(W, "br").length).toBe(1);
  });

  it("a non-Latin company name yields a distinct, non-empty filename", () => {
    const a = rfqFileName({ rfqGroup: "«scope»", companyName: "株式会社" });
    const b = rfqFileName({ rfqGroup: "«scope»", companyName: "有限会社" });
    expect(a).toMatch(/^RFQ-scope-company-[0-9a-f]+\.docx$/);
    expect(a).not.toBe(b);
    expect(rfqFileName({ rfqGroup: "Unit 300 repipe", companyName: "Gulf Mechanical, Inc." })).toBe("RFQ-Unit-300-repipe-Gulf-Mechanical-Inc.docx");
    expect(fileSlug("", "company", 40)).toMatch(/^company-/);
  });

  it("the due date is unambiguous to any reader: ISO plus the month spelled out", () => {
    expect(formatDueDate("2026-09-01")).toBe("2026-09-01 (1 September 2026)");
    const xml = buildRfqDocumentXml({ ...base, dueDate: "2026-09-01" });
    expect(xml).toContain("Quotes due: 2026-09-01 (1 September 2026)");
    expect(xml).not.toMatch(/9\/1\/2026|1\/9\/2026/);
  });
});

describe("BID-3 — the letter's promise matches the scorer", () => {
  it("tells bidders that declared exclusions do not lower their score", () => {
    const xml = buildRfqDocumentXml(base);
    expect(xml).toContain("Declared exclusions do not lower your score");
  });

  it("promises only what the scorer does: price scored, manpower once three bids state hours, coverage and gaps reviewed by people", () => {
    const xml = buildRfqDocumentXml(base);
    // COST-5: manpower is scored only when three bids state plausible hours — the letter never promises more.
    expect(xml).toContain("Price is scored, and so is manpower once at least three bids state labor hours in line with one another; scope coverage and any undeclared gaps are reviewed by our evaluators.");
    expect(xml).not.toContain("Price and manpower are scored;");
    // The scorer has no coverage part and no gap penalty (DEC-50) — the letter must not claim either.
    expect(xml).not.toMatch(/compared line by line on price, manpower, and scope coverage/);
    expect(xml).not.toMatch(/count against the bid/);
  });
});
