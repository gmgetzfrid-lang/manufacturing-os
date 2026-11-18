// lib/xlsxLegacyHtml.ts — SERVER-ONLY. The HTML-table reader of SheetJS
// 0.18.5, ported so an HTML ".xls" reads exactly as it did before the move to
// the vendored 0.20.3 (document-control XEDGE-12).
//
// Many systems export "Excel" as an HTML table saved with a .xls name. 0.20.3
// reads those tables differently from 0.18.5 — not only the value typing
// (which lib/xlsxData.ts re-types for CSV) but the segmentation itself: which
// comments are dropped, how rows and tables are found, and which attributes
// mark a cell as text (`t="s"` / `data-t="s"`, read by 0.18.5's own tag
// parser). Re-typing 0.20.3's cells cannot recover 0.18.5's per-cell text
// mark, so this module reads the table itself, step for step as 0.18.5 did:
// the same dispatch (which bytes are HTML at all), the same decoding, the same
// table / comment / row / cell segmentation, the same attribute parser, the
// same `htmldecode`, the same merge walk. Only the implementation differs:
// every one of 0.18.5's regular expressions that could backtrack super-
// linearly on hostile input (the ReDoS class 0.20.2 removed) is replaced by a
// scan with the same matches, so the reader runs in time linear in its input.
// Cell VALUES are typed by the caller (lib/xlsxData.ts `legacyTextCell`), from
// the decoded text and the 0.18.5 text mark.

import * as XLSX from "xlsx";

/** The caller's 0.18.5 typing of one cell's decoded text; `markedText` is
 *  0.18.5's `_t == "s"`. */
export type LegacyCellTyper = (text: string, markedText: boolean) => XLSX.CellObject;

// ── Decoding, as 0.18.5's readSync / parse_xlml_xml decoded an HTML file ───

/** cpexcel's lenient UTF-8 decoder (`magic_decode[65001]`), which 0.18.5 ran
 *  on a "binary" string: no validation, char codes taken as bytes as-is. */
function cptableUtf8Decode(s: string): string {
  const len = s.length;
  const units = new Uint16Array(2 * len);
  let u = 0;
  let i = 0;
  if (len >= 3 && s.charCodeAt(0) === 0xef && s.charCodeAt(1) === 0xbb && s.charCodeAt(2) === 0xbf) i = 3;
  for (let j = 1; i < len; i += j) {
    j = 1;
    const D = s.charCodeAt(i);
    let w: number;
    if (D < 128) w = D;
    else if (D < 224) { w = (D & 31) * 64 + (s.charCodeAt(i + 1) & 63); j = 2; }
    else if (D < 240) { w = ((D & 15) << 12) + (s.charCodeAt(i + 1) & 63) * 64 + (s.charCodeAt(i + 2) & 63); j = 3; }
    else { w = (D & 7) * 262144 + ((s.charCodeAt(i + 1) & 63) << 12) + (s.charCodeAt(i + 2) & 63) * 64 + (s.charCodeAt(i + 3) & 63); j = 4; }
    if (w < 65536) units[u++] = w;
    else {
      w -= 65536;
      units[u++] = 0xd800 + ((w >> 10) & 1023);
      units[u++] = 0xdc00 + (w & 1023);
    }
  }
  let out = "";
  for (let k = 0; k < u; k += 8192) out += String.fromCharCode(...units.subarray(k, Math.min(k + 8192, u)));
  return out;
}

/** read_plaintext: skip leading LF / CR / space; HTML only if "<" follows. */
function afterPlainWhitespace(s: string): string | null {
  let i = 0;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c === 0x0a || c === 0x0d || c === 0x20) { ++i; continue; }
    return c === 0x3c ? s.slice(i) : null;
  }
  return null;
}

/** The string 0.18.5's parse_xlml_xml worked on, when readSync (type
 *  "buffer") would have sent these bytes there; null otherwise. */
function legacyXmlString(bytes: Uint8Array): string | null {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buf.length === 0) return null;
  const b0 = buf[0];
  if (b0 === 0x3c || (b0 === 0xef && buf[3] === 0x3c)) return buf.toString("utf8");
  if (b0 === 0x0a || b0 === 0x0d || b0 === 0x20) {
    const s = afterPlainWhitespace(buf.toString("latin1"));
    return s === null ? null : cptableUtf8Decode(s);
  }
  if (b0 === 0xff && buf[1] === 0xfe) {
    const s = afterPlainWhitespace(buf.subarray(2).toString("utf16le"));
    return s === null ? null : cptableUtf8Decode(s);
  }
  return null;
}

/** parse_xlml_xml's choice between delimited text, HTML and XML 2003. */
function isLegacyHtml(str: string): boolean {
  const opening = str.slice(0, 1024).toLowerCase().replace(/".*?"/g, "");
  if ((opening.indexOf(">") & 1023) > Math.min(opening.indexOf(",") & 1023, opening.indexOf(";") & 1023)) return false;
  if (opening.indexOf("<?xml") !== -1) return false;
  return ["html", "table", "head", "meta", "script", "style", "div"].some((tag) => opening.indexOf("<" + tag) >= 0);
}

// ── Linear scans with the matches of 0.18.5's regular expressions ──────────

const lower = (c: number) => (c >= 0x41 && c <= 0x5a ? c + 32 : c);
/** `s` at `i` starts with the ASCII `lit` (lower case), ASCII-case-insensitively — as /…/i does. */
function startsWithCI(s: string, i: number, lit: string): boolean {
  if (i + lit.length > s.length) return false;
  for (let k = 0; k < lit.length; k++) if (lower(s.charCodeAt(i + k)) !== lit.charCodeAt(k)) return false;
  return true;
}
function indexOfCI(s: string, lit: string, from: number): number {
  for (let i = s.indexOf("<", from); i !== -1; i = s.indexOf("<", i + 1)) if (startsWithCI(s, i, lit)) return i;
  return -1;
}
const isLineTerminator = (c: number) => c === 0x0a || c === 0x0d || c === 0x2028 || c === 0x2029;
const WS = /\s/;
const isWs = (ch: string) => WS.test(ch);

/** str.match(/<table[\s\S]*?>[\s\S]*?<\/table>/gi). */
function matchTables(str: string): string[] {
  const out: string[] = [];
  let pos = 0;
  for (;;) {
    const start = indexOfCI(str, "<table", pos);
    if (start === -1) return out;
    const gt = str.indexOf(">", start + 6);
    if (gt === -1) return out;
    const close = indexOfCI(str, "</table>", gt + 1);
    if (close === -1) return out;
    out.push(str.slice(start, close + 8));
    pos = close + 8;
  }
}

/** str.replace(/<!--.*?-->/g, "") — `.` stops at a line terminator. */
function stripOneLineComments(str: string): string {
  let out = "";
  let pos = 0;
  let from = 0;
  for (;;) {
    const open = str.indexOf("<!--", from);
    if (open === -1) break;
    let k = open + 4;
    let end = -1;
    for (; k < str.length && !isLineTerminator(str.charCodeAt(k)); k++) {
      if (str.charCodeAt(k) === 0x2d && str.charCodeAt(k + 1) === 0x2d && str.charCodeAt(k + 2) === 0x3e) { end = k + 3; break; }
    }
    if (end === -1) { from = k; continue; } // no "-->" on this line: no later "<!--" on it closes either
    out += str.slice(pos, open);
    pos = from = end;
  }
  return out + str.slice(pos);
}

/** s.split(/(:?<tr[^>]*>)/i) — the separators kept, a ":" just before one included. */
function splitRows(s: string): string[] {
  const out: string[] = [];
  let p = 0;
  let from = 0;
  for (;;) {
    const lt = indexOfCI(s, "<tr", from);
    if (lt === -1) break;
    const gt = s.indexOf(">", lt + 3);
    if (gt === -1) break; // `[^>]*>` needs a ">"; none follows any later "<tr" either
    const start = lt > p && s.charCodeAt(lt - 1) === 0x3a ? lt - 1 : lt;
    out.push(s.slice(p, start), s.slice(start, gt + 1));
    p = from = gt + 1;
  }
  out.push(s.slice(p));
  return out;
}

const NAME_STOP = (c: string) => c === '"' || c === "?" || c === ">" || c === "/" || isWs(c);

/** tag.match(/([^"\s?>\/]+)\s*=\s*((?:")([^"]*)(?:")|(?:')([^']*)(?:')|([^'">\s]+))/g),
 *  without the backtracking: for a name run [p, r) the regex takes the
 *  longest name [p, k) — k = r, else each "=" inside the run, right to left —
 *  whose value parses; a value's validity does not depend on p, so a run
 *  with no valid k yields no match from any of its positions. */
function attributeMatches(tag: string): string[] {
  const n = tag.length;
  const lastDq = tag.lastIndexOf('"');
  const lastSq = tag.lastIndexOf("'");
  /** End of the value whose `=` is at eqPos, or -1 when it does not parse. */
  const valueEnd = (eqPos: number): number => {
    let v = eqPos + 1;
    while (v < n && isWs(tag[v])) v++;
    if (v >= n) return -1;
    const c = tag[v];
    if (c === '"') return lastDq > v ? tag.indexOf('"', v + 1) + 1 : -1;
    if (c === "'") return lastSq > v ? tag.indexOf("'", v + 1) + 1 : -1;
    if (c === ">") return -1;
    let e = v;
    while (e < n && tag[e] !== "'" && tag[e] !== '"' && tag[e] !== ">" && !isWs(tag[e])) e++;
    return e;
  };
  const out: string[] = [];
  let pos = 0;
  while (pos < n) {
    let p = pos;
    while (p < n && NAME_STOP(tag[p])) p++;
    if (p >= n) break;
    let r = p;
    while (r < n && !NAME_STOP(tag[r])) r++;
    let end = -1;
    let w = r;
    while (w < n && isWs(tag[w])) w++;
    if (w < n && tag[w] === "=") end = valueEnd(w);
    for (let k = r - 1; end === -1 && k > p; k--) if (tag[k] === "=") end = valueEnd(k);
    if (end === -1) { pos = r; continue; }
    out.push(tag.slice(p, end));
    pos = end;
  }
  return out;
}

/** parsexmltag(tag) — only what the HTML reader reads from it. */
function parseCellTag(tag: string): Record<string, string> {
  const z: Record<string, string> = {};
  let eq = 0;
  for (; eq !== tag.length; ++eq) { const c = tag.charCodeAt(eq); if (c === 32 || c === 10 || c === 13) break; }
  if (eq === tag.length) return z;
  for (const cc of attributeMatches(tag)) {
    let c = 0;
    for (; c !== cc.length; ++c) if (cc.charCodeAt(c) === 61) break;
    let q = cc.slice(0, c).trim();
    while (cc.charCodeAt(c + 1) === 32) ++c;
    const quote = cc.charCodeAt(c + 1);
    const quot = quote === 34 || quote === 39 ? 1 : 0;
    const v = cc.slice(c + 1 + quot, cc.length - quot);
    let j = 0;
    for (; j !== q.length; ++j) if (q.charCodeAt(j) === 58) break;
    if (j === q.length) {
      if (q.indexOf("_") > 0) q = q.slice(0, q.indexOf("_"));
      z[q] = v;
      z[q.toLowerCase()] = v;
    } else {
      const k = (j === 5 && q.slice(0, 5) === "xmlns" ? "xmlns" : "") + q.slice(j + 1);
      if (z[k] && q.slice(j - 3, j) === "ext") continue;
      z[k] = v;
      z[k.toLowerCase()] = v;
    }
  }
  return z;
}

const HTML_ENTITIES: Array<[RegExp, string]> = [
  ["nbsp", " "], ["middot", "·"], ["quot", '"'], ["apos", "'"], ["gt", ">"], ["lt", "<"], ["amp", "&"],
].map(([e, ch]) => [new RegExp("&" + e + ";", "ig"), ch]);
const isTnrSp = (c: number) => c === 0x09 || c === 0x0a || c === 0x0d || c === 0x20;

/** 0.18.5's htmldecode, step for step. */
function htmlDecode(str: string): string {
  let a = 0;
  let b = str.length;
  while (a < b && isTnrSp(str.charCodeAt(a))) a++; // .replace(/^[\t\n\r ]+/, "")
  while (b > a && isTnrSp(str.charCodeAt(b - 1))) b--; // .replace(/[\t\n\r ]+$/, "")
  let o = str.slice(a, b).replace(/>\s+/g, ">");
  // .replace(/\s+</g, "<"): a whitespace run is dropped when "<" follows it
  let t = "";
  let last = 0;
  const runs = /\s+/g;
  for (let r = runs.exec(o); r !== null; r = runs.exec(o)) {
    const e = r.index + r[0].length;
    if (o[e] === "<") { t += o.slice(last, r.index); last = e; }
  }
  o = (t + o.slice(last)).replace(/[\t\n\r ]+/g, " ").replace(/<\s*[bB][rR]\s*\/?>/g, "\n");
  // .replace(/<[^>]*>/g, "")
  t = "";
  let pos = 0;
  for (let lt = o.indexOf("<"); lt !== -1; lt = o.indexOf("<", pos)) {
    const gt = o.indexOf(">", lt + 1);
    if (gt === -1) break;
    t += o.slice(pos, lt);
    pos = gt + 1;
  }
  o = t + o.slice(pos);
  for (const [re, ch] of HTML_ENTITIES) o = o.replace(re, ch);
  return o;
}

interface Merge { s: { r: number; c: number }; e: { r: number; c: number } }

export const MERGE_LOOP_REFUSAL = "That spreadsheet's table merges a cell into itself (a merged cell with a column span of 0 or less), so it cannot be read. Save it as .xlsx or .csv and try again.";
export const MERGE_BUDGET_REFUSAL = "That spreadsheet's table has too many overlapping merged cells to read. Save it as .xlsx or .csv and try again.";

/** html_to_sheet. The merge walk keeps 0.18.5's rule — repeatedly, the FIRST
 *  merge (in creation order) whose start column is C and whose rows cover R
 *  sends C past it — but looks only at merges starting in column C and drops
 *  the ones whose rows ended (R never decreases), instead of rescanning all. */
function htmlToSheet(chunk: string, sheetRows: number, typeCell: LegacyCellTyper): XLSX.WorkSheet {
  const ws: XLSX.WorkSheet = {};
  const str = stripOneLineComments(chunk);
  const i0 = indexOfCI(str, "<table", 0);
  if (i0 === -1) throw new Error("Invalid HTML: could not find <table>");
  const close = indexOfCI(str, "</table", 0);
  const rows = splitRows(str.slice(i0, close > 0 ? close : str.length));
  let R = -1;
  let C = 0;
  const range = { s: { r: 10000000, c: 10000000 }, e: { r: 0, c: 0 } };
  const merges: Merge[] = [];
  let walkBudget = 1_000_000 + 4 * chunk.length;
  // Per start column, the merges in creation order and the index of the first
  // one whose rows have not ended (R never decreases, so an ended merge can
  // never cover again). Creation rows never decrease either, so once the
  // first live merge started in this row, none in the column covers R.
  const byColumn = new Map<number, { list: Merge[]; head: number }>();
  const coverAt = (col: number, row: number): Merge | undefined => {
    if (Number.isNaN(col)) return undefined; // 0.18.5 compared with ==: NaN never matched
    const at = byColumn.get(col);
    if (!at) return undefined;
    while (at.head < at.list.length && !(at.list[at.head].e.r >= row)) at.head++;
    const first = at.list[at.head];
    return first && first.s.r < row ? first : undefined;
  };
  for (const piece of rows) {
    const row = piece.trim();
    const hd = row.slice(0, 3).toLowerCase();
    if (hd === "<tr") { ++R; if (sheetRows && sheetRows <= R) { --R; break; } C = 0; continue; }
    if (hd !== "<td" && hd !== "<th") continue;
    for (const raw of row.split(/<\/t[dh]>/i)) {
      const cell = raw.trim();
      if (!/<t[dh]/i.test(cell)) continue;
      let m = cell;
      let cc = 0;
      while (m.charAt(0) === "<" && (cc = m.indexOf(">")) > -1) m = m.slice(cc + 1);
      // 0.18.5 (and 0.20.3) loop here forever when a walk revisits a merge
      // (a merged cell with colspan 0 or below sends C back to itself), and
      // spend time quadratic in the merges when many rowspans stack up; both
      // are refused instead of hanging the request.
      for (let mg = coverAt(C, R), steps = 0; mg; mg = coverAt(C, R)) {
        if (++steps > merges.length) throw new Error(MERGE_LOOP_REFUSAL);
        if (--walkBudget < 0) throw new Error(MERGE_BUDGET_REFUSAL);
        C = mg.e.c + 1;
      }
      const tag = parseCellTag(cell.slice(0, cell.indexOf(">")));
      const CS = tag.colspan ? +tag.colspan : 1;
      const RS = +tag.rowspan;
      if (RS > 1 || CS > 1) {
        const mg: Merge = { s: { r: R, c: C }, e: { r: R + (RS || 1) - 1, c: C + CS - 1 } };
        merges.push(mg);
        const at = byColumn.get(C);
        if (at) at.list.push(mg); else byColumn.set(C, { list: [mg], head: 0 });
      }
      const markedText = (tag.t || tag["data-t"] || "") === "s";
      if (!m.length) { C += CS; continue; }
      m = htmlDecode(m);
      if (range.s.r > R) range.s.r = R;
      if (range.e.r < R) range.e.r = R;
      if (range.s.c > C) range.s.c = C;
      if (range.e.c < C) range.e.c = C;
      if (!m.length) { C += CS; continue; }
      ws[XLSX.utils.encode_cell({ r: R, c: C })] = typeCell(m, markedText);
      C += CS;
    }
  }
  ws["!ref"] = XLSX.utils.encode_range(range);
  if (merges.length) ws["!merges"] = merges;
  return ws;
}

/** The workbook 0.18.5 made of these bytes when it read them as an HTML
 *  table; null when 0.18.5 would not have read them as HTML at all. Throws
 *  0.18.5's own error when the HTML holds no table. */
export function legacyHtmlWorkbook(bytes: Uint8Array, sheetRows: number, typeCell: LegacyCellTyper): XLSX.WorkBook | null {
  const str = legacyXmlString(bytes);
  if (str === null || !isLegacyHtml(str)) return null;
  const tables = matchTables(str);
  if (tables.length === 0) throw new Error("Invalid HTML: could not find <table>");
  const wb: XLSX.WorkBook = { SheetNames: [], Sheets: {} };
  tables.forEach((chunk, idx) => {
    const name = "Sheet" + (idx + 1);
    wb.SheetNames.push(name);
    wb.Sheets[name] = htmlToSheet(chunk, sheetRows, typeCell);
  });
  return wb;
}

/** The linear scans, exposed so a test can hold each to the 0.18.5 regular
 *  expression it replaces. */
export const legacyHtmlScans = { attributeMatches, splitRows, stripOneLineComments, matchTables, htmlDecode, cptableUtf8Decode, parseCellTag };
