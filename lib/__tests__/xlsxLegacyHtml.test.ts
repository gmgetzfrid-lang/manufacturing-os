// Document-control XEDGE-12 — an HTML-table ".xls" reads exactly as it did
// under SheetJS 0.18.5: lib/xlsxLegacyHtml.ts ports 0.18.5's HTML reader
// with linear-time scans in place of its backtracking regular expressions.
//
//   1. Each scan returns exactly what the 0.18.5 expression it replaces
//      returns (the expressions are copied here from xlsx 0.18.5), on random
//      inputs built from the characters those expressions care about.
//   2. Per-cell text marks, read with 0.18.5's own attribute parser: every
//      spelling 0.18.5 honoured keeps its text, nothing else does — including
//      SheetJS's own export, which marks every cell s / n / b.
//   3. The reader never hangs: the merge walk 0.18.5 (and 0.20.3) loops in
//      forever is refused, and 10 MB of hostile markup reads in linear time.
//
// Expected values were produced by lib/xlsxData.ts parseWorkbook on xlsx
// 0.18.5 over the same bytes, in UTC.

import { describe, it, expect } from "vitest";
import * as XLSX from "xlsx";
import { parseWorkbook } from "@/lib/xlsxData";
import { legacyHtmlScans, MERGE_LOOP_REFUSAL, MERGE_BUDGET_REFUSAL, COLUMN_LIMIT_REFUSAL } from "@/lib/xlsxLegacyHtml";

const inZone = <T,>(zone: string, fn: () => T): T => {
  const tz = process.env.TZ;
  try { process.env.TZ = zone; return fn(); } finally { process.env.TZ = tz; }
};
const rows = (html: string | Buffer) => inZone("UTC", () => parseWorkbook(Buffer.isBuffer(html) ? html : Buffer.from(html)).rows);

// ── 0.18.5's own expressions (xlsx 0.18.5, xlsx.js) ─────────────────────────
const ATTREGEXG = /([^"\s?>/]+)\s*=\s*((?:")([^"]*)(?:")|(?:')([^']*)(?:')|([^'">\s]+))/g;
const ENTITIES: Array<[RegExp, string]> = [
  ["nbsp", " "], ["middot", "·"], ["quot", '"'], ["apos", "'"], ["gt", ">"], ["lt", "<"], ["amp", "&"],
].map(([e, ch]) => [new RegExp("&" + e + ";", "ig"), ch]);
function htmldecode018(str: string): string {
  let o = str.replace(/^[\t\n\r ]+/, "").replace(/[\t\n\r ]+$/, "").replace(/>\s+/g, ">").replace(/\s+</g, "<")
    .replace(/[\t\n\r ]+/g, " ").replace(/<\s*[bB][rR]\s*\/?>/g, "\n").replace(/<[^>]*>/g, "");
  for (const [re, ch] of ENTITIES) o = o.replace(re, ch);
  return o;
}

let seed = 20261118;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const randomString = (alphabet: string[], max: number) => {
  let s = "";
  const n = Math.floor(rnd() * max);
  for (let i = 0; i < n; i++) s += alphabet[Math.floor(rnd() * alphabet.length)];
  return s;
};

describe("XEDGE-12 — each linear scan matches the 0.18.5 expression it replaces", () => {
  it("attribute matches = tag.match(attregexg)", () => {
    const alphabet = ["t", "a", "=", '"', "'", " ", "\t", "\n", "?", "/", ">", ":", "_", "-", "s", "x"];
    for (let i = 0; i < 20000; i++) {
      const tag = "<td" + randomString(alphabet, 24);
      expect(legacyHtmlScans.attributeMatches(tag), tag).toEqual(tag.match(ATTREGEXG) ?? []);
    }
  });

  it("row split, comment strip, table match and htmldecode = their 0.18.5 regular expressions", () => {
    const alphabet = ["<", ">", "t", "T", "r", "R", "d", "a", "b", "l", "e", "/", ":", "!", "-", " ", "\n", "\r", " ", "x", "&", ";", "n", "s", "p", " ", "B"];
    const words = ["<tr", "<TR", ":<tr", "<table", "</table>", "</TABLE>", "<!--", "-->", "<br>", "< br />", "&nbsp;", "&AMP;", "&lt;", ">", "<", " ", "\n", "x"];
    for (let i = 0; i < 20000; i++) {
      const s = rnd() < 0.5 ? randomString(alphabet, 30) : randomString(words, 12);
      expect(legacyHtmlScans.splitRows(s), s).toEqual(s.split(/(:?<tr[^>]*>)/i));
      expect(legacyHtmlScans.stripOneLineComments(s), s).toEqual(s.replace(/<!--.*?-->/g, ""));
      expect(legacyHtmlScans.matchTables(s), s).toEqual(s.match(/<table[\s\S]*?>[\s\S]*?<\/table>/gi) ?? []);
      expect(legacyHtmlScans.htmlDecode(s), s).toEqual(htmldecode018(s));
    }
  });
});

describe("XEDGE-12 — an HTML cell's text mark is read per cell, with 0.18.5's attribute rules", () => {
  const T = (attr: string) =>
    `<table><tr><th>Part</th><th>Due</th></tr><tr><td${attr}>00123</td><td>15-Mar-2026</td></tr><tr><td${attr}>1e3</td><td>2026-03-15</td></tr></table>`;
  const KEPT = [{ Part: "00123", Due: "2026-03-15" }, { Part: "1e3", Due: "2026-03-15" }];
  const TYPED = [{ Part: "123", Due: "2026-03-15" }, { Part: "1000", Due: "2026-03-15" }];

  it("every spelling 0.18.5 honoured keeps the cell's text — and only that cell's", () => {
    for (const attr of [
      ' t="s"', " t='s'", " t=s", " T='s'", ' data-t="s"', ' data-t = "s"', ' x:t="s"', ' DATA-T="s"',
      ' class="x"t="s"', ' t_' + "a".repeat(70) + '="s"', " t_a'b=\"s\"",
    ]) expect(rows(T(attr)), attr).toEqual(KEPT);
  });

  it("nothing else marks a cell: other values, comments, another table, an onclick, cell text", () => {
    for (const html of [
      T(' t="str"'), T(' t="S"'), T(' t="n"'),
      // 0.18.5's attribute expression reads `class='x'data-t='s'` as ONE attribute, class.
      T(" class='x'data-t='s'"), T(` onclick="go('?t=s')"`), T(' title="t=s"'),
      T("").replace("<tr>", '<!-- <td t="s">x</td> --><tr>'),
      T("") + '<table><tr><td t="s">z</td></tr></table>',
      T("").replace("<th>Part</th>", "<th>Weight = Steel</th>"),
    ]) expect(rows(html).map((r) => Object.values(r)), html).toEqual(TYPED.map((r) => Object.values(r)));
  });

  it("a mixed table (SheetJS's export marks every cell s / n / b) reads each cell as 0.18.5 did", () => {
    const sheetjs = '<table><tr><td data-t="s">Part</td><td data-t="s">Due</td><td data-t="s">Qty</td><td data-t="s">Ok</td></tr>'
      + '<tr><td data-t="s" data-v="00123">00123</td><td data-t="n" data-v="46096" data-z="d-mmm-yyyy">15-Mar-2026</td><td data-t="n">1.5</td><td data-t="b">TRUE</td></tr>'
      + '<tr><td data-t="s">1-2</td><td data-t="n" data-z="mmmm d, yyyy">March 16, 2026</td><td data-t="n">007</td><td data-t="b">FALSE</td></tr></table>';
    expect(rows(sheetjs)).toEqual([
      { Part: "00123", Due: "2026-03-15", Qty: "1.5", Ok: "Yes" },
      { Part: "1-2", Due: "2026-03-16", Qty: "7", Ok: "No" },
    ]);
  });

  it("a SheetJS 0.20.3 HTML export of text, number, boolean and date columns (four date formats) reads as 0.18.5 read it", () => {
    const formats = ["d-mmm-yyyy", "mmmm d, yyyy", "yyyy-mm-dd", "dd-mmm-yy"];
    const ws = XLSX.utils.aoa_to_sheet([["Part", "Qty", "Ok", ...formats.map((_, i) => `D${i}`)], ["00123", 1.5, true, 46096, 46096, 46096, 46096], ["1-2", 7, false, 46097, 46097, 46097, 46097]]);
    formats.forEach((z, i) => { for (const r of [2, 3]) { const a = XLSX.utils.encode_cell({ r: r - 1, c: 3 + i }); ws[a].z = z; delete ws[a].w; } });
    expect(rows(XLSX.utils.sheet_to_html(ws))).toEqual([
      { Part: "00123", Qty: "1.5", Ok: "Yes", D0: "2026-03-15", D1: "2026-03-15", D2: "2026-03-15", D3: "2026-03-15" },
      { Part: "1-2", Qty: "7", Ok: "No", D0: "2026-03-16", D1: "2026-03-16", D2: "2026-03-16", D3: "2026-03-16" },
    ]);
  });

  it("UTF-16, a UTF-8 BOM and leading whitespace decode as 0.18.5 decoded them", () => {
    const html = T(' t="s"');
    expect(rows(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(html, "utf16le")]))).toEqual(KEPT);
    expect(rows(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(html)]))).toEqual(KEPT);
    expect(rows("\n  " + html)).toEqual(KEPT);
    // Non-ASCII: a UTF-8 file behind leading whitespace decodes cleanly; a
    // UTF-16 file went through cpexcel's UTF-8 decoder after its UTF-16 one
    // under 0.18.5 and came out mangled — reproduced, not repaired.
    const table = "<table><tr><td>Part</td><td>Note</td></tr><tr><td>A</td><td>café € 中</td></tr></table>";
    expect(rows(Buffer.from("\n" + table))).toEqual([{ Part: "A", Note: "café € 中" }]);
    expect(rows(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(table, "utf16le")]))).toEqual([{ Part: "A", Note: "caf\u982c \u{7cbf4}d>" }]);
    // Invalid UTF-8 behind leading whitespace: cpexcel's decoder, not Node's (which would give U+FFFD).
    const invalid = Buffer.concat([Buffer.from("\n<table><tr><td>Part</td><td>Note</td></tr><tr><td>A</td><td>x"), Buffer.from([0xe9, 0x41, 0xf0, 0x9f, 0x98, 0x80, 0xc3]), Buffer.from("y</td></tr></table>")]);
    expect(rows(invalid)).toEqual([{ Part: "A", Note: "x\u9070\u07d8\u0003y" }]);
  });
});

describe("XEDGE-12 — the HTML reader never hangs", () => {
  it("a merged cell spanning 0 columns, which 0.18.5 and 0.20.3 loop on forever, is refused", () => {
    const loop = "<table><tr><td colspan=0 rowspan=2>x</td></tr><tr><td>z</td></tr></table>";
    expect(() => parseWorkbook(Buffer.from(loop))).toThrow(MERGE_LOOP_REFUSAL);
    const stacked = "<table><tr>" + "<td rowspan=9999>x</td>".repeat(16_000) + "</tr>" + "<tr><td>y</td></tr>".repeat(500) + "</table>";
    expect(() => parseWorkbook(Buffer.from(stacked))).toThrow(MERGE_BUDGET_REFUSAL);
  }, 60_000);

  it("a runaway colspan past Excel's last column is refused at once (0.18.5 and 0.20.3 built every row that wide)", () => {
    const tiny = Buffer.from("<table><tr><td colspan=1000000>a</td><td>b</td></tr></table>");
    const thousandRows = Buffer.from("<table>" + "<tr><td colspan=100000>a</td><td>b</td></tr>".repeat(1000) + "</table>");
    for (const bytes of [tiny, thousandRows]) {
      const started = Date.now();
      expect(() => parseWorkbook(bytes)).toThrow(COLUMN_LIMIT_REFUSAL);
      expect(Date.now() - started).toBeLessThan(2000);
    }
    // Column XFD itself is still a column.
    expect(rows("<table><tr><td>Tag</td><td colspan=16382>x</td><td>Last</td></tr><tr><td>P-1</td></tr></table>")[0].Tag).toBe("P-1");
  });

  it("the merge-step budget is one per file: many tables each under it cannot add up past it", () => {
    const table = "<table><tr>" + "<td rowspan=9999>x</td>".repeat(1000) + "</tr>" + "<tr><td>y</td></tr>".repeat(1000) + "</table>";
    expect(() => parseWorkbook(Buffer.from("<html>" + table))).not.toThrow();
    expect(() => parseWorkbook(Buffer.from("<html>" + table.repeat(30)))).toThrow(MERGE_BUDGET_REFUSAL);
  }, 60_000);

  it("65,535 tables read as 65,535 sheets; the 65,536th is refused, as 0.18.5 refused it", () => {
    const one = "<table><tr><td>x</td></tr></table>";
    expect(parseWorkbook(Buffer.from("<html>" + one.repeat(65_535))).sheetNames).toHaveLength(65_535);
    expect(() => parseWorkbook(Buffer.from("<html>" + one.repeat(65_536)))).toThrow("Too many worksheets");
    const started = Date.now();
    expect(() => parseWorkbook(Buffer.from("<html>" + one.repeat(700_000)))).toThrow("Too many worksheets");
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 60_000);

  it("10 MB of hostile markup reads in linear time", () => {
    const H = "<html><table>";
    const N = 10 * 1024 * 1024;
    const fill = (pre: string, unit: string, post = "") => Buffer.from(pre + unit.repeat(Math.floor((N - pre.length - post.length) / unit.length)) + post, "latin1");
    for (const [name, bytes] of [
      ["bare attributes", fill(H + "<tr><td", " t", ">x</td></tr></table>")],
      ["one long attribute run", fill(H + "<tr><td ", "data-t_", ">x</td></tr></table>")],
      ["unclosed quotes", fill(H + "<tr><td ", 'a="', ">x</td></tr></table>")],
      ["<tr without >", fill(H, "<tr", "</table>")],
      ["unclosed comments", fill(H, "<!--", "</table>")],
      ["space before <", fill(H + "<tr><td>", " <", " x</td></tr></table>")],
      ["< without >", fill(H + "<tr><td>x", "<", "</td></tr></table>")],
      ["UTF-16", Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("<html><table><tr><td>" + "é€ ".repeat(N / 8) + "</td></tr></table>", "utf16le")])],
    ] as Array<[string, Buffer]>) {
      const started = Date.now();
      try { parseWorkbook(bytes); } catch { /* a refusal is fine; a hang is not */ }
      expect(Date.now() - started, name).toBeLessThan(20_000);
    }
  }, 300_000);
});
