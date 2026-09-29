// Document-control Round F — P10 EDGES: the pure template / workbook libs.
//
//   XEDGE-2   contentDispositionAttachment / asciiFoldFilename.
//   XEDGE-11  findPlaceholders sees `{@raw}` tags; pickDeclaredValues; and
//             renderTemplate REFUSES a template carrying a raw-XML tag —
//             proven against the real docxtemplater, which otherwise splices
//             the caller's markup straight into the document.
//   XEDGE-12  parseWorkbook runs on hardened input: byte cap, per-sheet row
//             cap, a `__proto__` sheet name cannot pollute Object.prototype,
//             and withPrototypeGuard detects + reverts a polluting parse.

import { describe, it, expect } from "vitest";
import PizZip from "pizzip";
import * as XLSX from "xlsx";
import {
  findPlaceholders, hasRawXmlTag, pickDeclaredValues, asciiFoldFilename, contentDispositionAttachment,
} from "@/lib/outputTemplateText";
import { renderTemplate, TemplateRenderError, extractDocxText } from "@/lib/docxRender";
import { parseWorkbook, withPrototypeGuard, MAX_WORKBOOK_BYTES, MAX_SHEET_ROWS, SHEET_ROW_WINDOW } from "@/lib/xlsxData";
import { chunkDocuments, downloadNameFromDisposition, RENDER_CHUNK } from "@/lib/outputTemplates";

/** A minimal but real .docx: content types, package rels, one paragraph. */
function docx(bodyXml: string): Buffer {
  const z = new PizZip();
  z.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
  z.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  z.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${bodyXml}</w:body></w:document>`);
  return z.generate({ type: "nodebuffer" });
}
const para = (text: string) => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;

describe("XEDGE-2 — header-safe filenames", () => {
  it("asciiFoldFilename strips accents, replaces everything else non-ASCII, never returns empty", () => {
    expect(asciiFoldFilename("Bericht — Nord Süd.docx")).toBe("Bericht _ Nord Sud.docx");
    expect(asciiFoldFilename("報告書.docx")).toBe("_.docx");
    expect(asciiFoldFilename("a\"b\r\nc")).toBe("a_b_c");
    expect(asciiFoldFilename("")).toBe("document");
    expect(asciiFoldFilename("—")).toBe("_");
    // a backslash is quoted-string escape syntax: it must never precede the closing quote
    expect(asciiFoldFilename("foo\\")).toBe("foo_");
    expect(asciiFoldFilename("a\\b.docx")).toBe("a_b.docx");
  });
  it("contentDispositionAttachment is pure ASCII and carries the exact UTF-8 name as filename*", () => {
    const h = contentDispositionAttachment("RFQ — 12 documents.zip");
    for (const ch of h) expect(ch.charCodeAt(0)).toBeLessThan(0x80);
    expect(h).toBe("attachment; filename=\"RFQ _ 12 documents.zip\"; filename*=UTF-8''RFQ%20%E2%80%94%2012%20documents.zip");
    expect(decodeURIComponent(h.split("UTF-8''")[1])).toBe("RFQ — 12 documents.zip");
    // quotes and line breaks can never break out of the parameter
    expect(contentDispositionAttachment('x"\r\ny.docx')).toBe("attachment; filename=\"xy.docx\"; filename*=UTF-8''xy.docx");
    // RFC 5987 reserves ' ( ) * — they are percent-encoded
    expect(contentDispositionAttachment("a'(b)*.docx")).toContain("filename*=UTF-8''a%27%28b%29%2A.docx");
    // a name ending in a backslash (a reviewed draft's edited filename) still terminates the quoted-string
    const trailing = contentDispositionAttachment("foo\\");
    expect(trailing).toBe("attachment; filename=\"foo_\"; filename*=UTF-8''foo%5C");
    expect(trailing).not.toMatch(/\\"/);
    // the header construction the runtime refused before now succeeds
    expect(() => new Response("x", { headers: { "content-disposition": h } })).not.toThrow();
    expect(() => new Response("x", { headers: { "content-disposition": 'attachment; filename="a — b.zip"' } })).toThrow();
  });
  it("the client prefers filename* and falls back to filename", () => {
    expect(downloadNameFromDisposition("attachment; filename=\"RFQ _ 2.zip\"; filename*=UTF-8''RFQ%20%E2%80%94%202.zip")).toBe("RFQ — 2.zip");
    expect(downloadNameFromDisposition('attachment; filename="plain.zip"')).toBe("plain.zip");
    expect(downloadNameFromDisposition(null)).toBe("documents");
  });
});

describe("XEDGE-11 — raw-XML tags are seen and refused; values are filtered", () => {
  it("findPlaceholders reports {@tag} separately and never as a field", () => {
    const found = findPlaceholders("Hi {name} {@rawxml} {#rows}{x}{/rows}");
    expect(found.fields.sort()).toEqual(["name", "x"]);
    expect(found.loops).toEqual(["rows"]);
    expect(found.raw).toEqual(["rawxml"]);
    expect(hasRawXmlTag("text {@ x } more")).toBe(true);
    expect(hasRawXmlTag("text {x} more")).toBe(false);
  });

  it("pickDeclaredValues keeps only declared tags and stringifies", () => {
    const declared = [{ tag: "name" }, { tag: "count" }];
    expect(pickDeclaredValues({ name: "A", count: 3, evil: "<w:p/>", "@raw": "x" }, declared)).toEqual({ name: "A", count: "3" });
    expect(pickDeclaredValues({ name: null }, declared)).toEqual({ name: "" });
    expect(pickDeclaredValues(undefined, declared)).toEqual({});
    expect(pickDeclaredValues({ anything: "x" }, [])).toEqual({});
  });

  it("the real renderer fills a plain tag", () => {
    const out = renderTemplate(docx(para("Hello {name}, ref {ref}")), { name: "World" });
    // {ref} is unresolved → empty (nullGetter), never "undefined"
    expect(extractDocxText(out)).toBe("Hello World, ref");
  });

  it("the real renderer REFUSES a template with a raw-XML tag (docxtemplater would otherwise splice the value in as markup)", () => {
    expect(() => renderTemplate(docx(para("{@rawxml}")), { rawxml: "<w:p><w:r><w:t>INJECTED</w:t></w:r></w:p>" }))
      .toThrow(TemplateRenderError);
    expect(() => renderTemplate(docx(para("{@rawxml}")), {})).toThrow(/raw-XML tag/);
    // a tag Word split across two runs is still seen (tags are stripped before the scan)
    const split = docx(`<w:p><w:r><w:t>{</w:t></w:r><w:r><w:t>@raw}</w:t></w:r></w:p>`);
    expect(() => renderTemplate(split, {})).toThrow(/raw-XML tag/);
    // a raw tag in a header part is refused too
    const z = new PizZip(docx(para("plain {name}")));
    z.file("word/header1.xml", `<w:hdr xmlns:w="x"><w:p><w:r><w:t>{@h}</w:t></w:r></w:p></w:hdr>`);
    expect(() => renderTemplate(z.generate({ type: "nodebuffer" }), { name: "x" })).toThrow(/header1\.xml|raw-XML tag/);
  });

  it("the client slices a batch to the server cap", () => {
    expect(RENDER_CHUNK).toBe(25);
    expect(chunkDocuments(Array.from({ length: 60 }, (_, i) => i)).map((c) => c.length)).toEqual([25, 25, 10]);
    expect(chunkDocuments([])).toEqual([]);
    expect(chunkDocuments([1, 2, 3], 2)).toEqual([[1, 2], [3]]);
  });
});

describe("XEDGE-12 — the workbook parser runs on hardened input", () => {
  const workbook = (sheets: Array<{ name: string; rows: unknown[][] }>): Buffer => {
    const wb = XLSX.utils.book_new();
    for (const s of sheets) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(s.rows), s.name);
    return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
  };

  it("refuses a workbook over the byte cap before parsing", () => {
    const huge = Buffer.alloc(MAX_WORKBOOK_BYTES + 1);
    expect(() => parseWorkbook(huge)).toThrow(/limit is 25 MB/);
  });

  it("a workbook whose sheet name is __proto__ does not mutate Object.prototype and is not addressed as a sheet", () => {
    const before = new Set(Object.getOwnPropertyNames(Object.prototype));
    const bytes = workbook([{ name: "__proto__", rows: [["polluted", "x"], ["1", "2"]] }, { name: "Data", rows: [["WO", "Desc"], ["1", "pump"]] }]);
    const out = parseWorkbook(bytes);
    expect(out.sheetNames).toEqual(["Data"]);
    expect(out.rows).toEqual([{ WO: "1", Desc: "pump" }]);
    expect(Object.getOwnPropertyNames(Object.prototype).filter((k) => !before.has(k))).toEqual([]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    // a workbook with ONLY an unsafe sheet yields nothing rather than the prototype
    const only = parseWorkbook(workbook([{ name: "__proto__", rows: [["a", "b"], ["1", "2"]] }]));
    expect(only).toEqual({ sheetName: "", headers: [], rows: [], sheetNames: [] });
  });

  it("withPrototypeGuard detects a polluting parse, reverts it and refuses the file", () => {
    expect(() => withPrototypeGuard(() => {
      (Object.prototype as unknown as Record<string, unknown>).__xedge12_polluted = true;
      return 1;
    })).toThrow(/attempted to alter the runtime \(__xedge12_polluted\)/);
    expect("__xedge12_polluted" in {}).toBe(false);
    expect(withPrototypeGuard(() => 42)).toBe(42);
  });

  const dataRows = (n: number): unknown[][] => {
    const rows: unknown[][] = [["WO", "Desc"]];
    for (let i = 0; i < n; i++) rows.push([String(i), "x"]);
    return rows;
  };

  it("a sheet with exactly MAX_SHEET_ROWS data rows parses whole and reports the true count", () => {
    const out = parseWorkbook(workbook([{ name: "Big", rows: dataRows(MAX_SHEET_ROWS) }]));
    expect(out.headers).toEqual(["WO", "Desc"]);
    expect(out.rows.length).toBe(MAX_SHEET_ROWS);
    expect(out.rows[0]).toEqual({ WO: "0", Desc: "x" });
    expect(out.rows[MAX_SHEET_ROWS - 1]).toEqual({ WO: String(MAX_SHEET_ROWS - 1), Desc: "x" });
  });

  it("one data row over the cap is REFUSED, never silently truncated to a wrong row count", () => {
    // MAX_SHEET_ROWS + 1 data rows: the physical sheet (header + data) is 10,002 rows,
    // inside the read window, so this is the data-row limb of the refusal.
    expect(() => parseWorkbook(workbook([{ name: "Big", rows: dataRows(MAX_SHEET_ROWS + 1) }])))
      .toThrow(/Sheet "Big" has more than 10,000 data rows; the generator drafts at most 10,000 per sheet\. Split it/);
    // blank rows between data rows do not count toward the cap (and are not returned)
    const sparse = dataRows(MAX_SHEET_ROWS - 10);
    for (let i = 1; i <= 20; i++) sparse.splice(i * 3, 0, ["", ""]);
    expect(sparse.length).toBeLessThan(SHEET_ROW_WINDOW);
    expect(parseWorkbook(workbook([{ name: "Sparse", rows: sparse }])).rows.length).toBe(MAX_SHEET_ROWS - 10);
  });

  it("a sheet whose used range runs past the bounded read window is refused (xlsx via !fullref, csv via a filled !ref)", () => {
    // xlsx: well over the window — sheetRows trims the read, !fullref keeps the truth
    expect(() => parseWorkbook(workbook([{ name: "Big", rows: dataRows(MAX_SHEET_ROWS + 200) }])))
      .toThrow(new RegExp(`Sheet "Big" runs to row ${(MAX_SHEET_ROWS + 201).toLocaleString("en-US")} or beyond; the generator reads at most 10,000 data rows per sheet\\. Remove the trailing rows or split it`));
    // xlsx: a few data rows plus one stray cell far below (used-range bloat) — unread rows cannot be trusted blank
    const ws = XLSX.utils.aoa_to_sheet(dataRows(5));
    ws[XLSX.utils.encode_cell({ r: SHEET_ROW_WINDOW + 500, c: 0 })] = { t: "s", v: "stray" };
    ws["!ref"] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: SHEET_ROW_WINDOW + 500, c: 1 } });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Bloat");
    expect(() => parseWorkbook(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer))
      .toThrow(/Sheet "Bloat" runs to row 10,517 or beyond/);
    // csv: no !fullref exists, so a !ref that fills the window is the cut signal
    const csv = Buffer.from(dataRows(SHEET_ROW_WINDOW + 10).map((r) => r.join(",")).join("\n"));
    expect(() => parseWorkbook(csv)).toThrow(/runs to row 10,016 or beyond/);
    // csv under the window parses whole
    const small = Buffer.from(dataRows(30).map((r) => r.join(",")).join("\n"));
    expect(parseWorkbook(small).rows.length).toBe(30);
    expect(SHEET_ROW_WINDOW).toBe(MAX_SHEET_ROWS + 16);
  });
});
