// lib/xlsxData.ts — SERVER-ONLY. Read tabular source data (the work-order
// spreadsheet) into plain rows the generator can map onto template tags.
//
// Deliberately forgiving about real-world spreadsheets: the header row is
// rarely row 1 (titles, logos, blank spacers come first), so we find the
// first row that actually looks like headers, and we drop fully-empty rows
// rather than minting blank documents from them.
//
// XEDGE-12: the parser is SheetJS 0.20.3, vendored (`vendor/xlsx-0.20.3.tgz`,
// pinned by its lockfile integrity hash) — the npm registry stops at 0.18.5,
// and the prototype-pollution (0.19.3) and ReDoS (0.20.2) fixes exist only on
// the vendor's CDN. It runs in the server process beside the service-role
// client, so every parse still runs on HARDENED input: a byte cap, a per-sheet
// row cap, unsafe sheet names ignored, and a prototype guard that detects and
// reverts any own property the parse adds to Object.prototype /
// Array.prototype, refusing the file.
//
// The move from 0.18.5 changed how SheetJS guesses the type of a cell typed
// as TEXT — a CSV field or an HTML-table cell (the ".xls" many systems export
// is an HTML table): "15-Mar-2026" stopped being a date, "13:45" became a
// date, "#N/A" became a blank error cell, and an HTML "1:45 PM" became an
// Invalid Date that refused the whole file. Every one of those reads worked
// a person's way before, so text-typed cells are re-typed here from the text
// SheetJS keeps for them (`cell.w`) with the 0.18.5 rules
// (`legacyTextCell`), so a text cell reads as it did before the move. An
// HTML table is read by a port of 0.18.5's own HTML reader
// (lib/xlsxLegacyHtml.ts): 0.20.3 also segments those tables differently and
// cannot report 0.18.5's per-cell `t="s"` / `data-t="s"` text mark, so only
// the reader itself reproduces them exactly. Cells a binary workbook (xlsx /
// xls / xlsb) types are SheetJS 0.20.3's own (Excel's calendar for serials
// before 1900-03-01, ruled under DEC-90); an
// OpenDocument sheet keeps 0.18.5's error text and calendar dates (below).
//
// The row cap REFUSES, never truncates: the draft action reports
// `rows.length` as the sheet's row count and the modal drafts "N rows left"
// from it, so a silently cut sheet would read as complete while its tail
// was never drafted. A sheet with more data rows than the cap — or whose
// used range runs past the bounded read window, where we cannot know what
// the unread rows hold — is refused with a message that says how to split it.

import * as XLSX from "xlsx";
import { cellToText } from "@/lib/outputTemplateText";
import { legacyHtmlWorkbook } from "@/lib/xlsxLegacyHtml";

export interface SheetData {
  sheetName: string;
  headers: string[];
  rows: Array<Record<string, string>>;
  /** Sheets present in the workbook (so the UI can offer a picker). */
  sheetNames: string[];
  /** Parallel to `rows`: each row's 1-based row number in the sheet as the
   *  person sees it (the title block above the header and the skipped blank
   *  rows counted), so an importer can say "Row 10" and mean row 10. */
  rowNumbers?: number[];
}

/** Largest workbook the generator will parse. */
export const MAX_WORKBOOK_BYTES = 25 * 1024 * 1024;
/** Most data rows a sheet may hold; more is refused (never silently cut). */
export const MAX_SHEET_ROWS = 10_000;
/** Rows scanned for the header row — see the findIndex below. */
const HEADER_SCAN_ROWS = 15;
/** Physical rows the parser reads per sheet: the header window, the data
 *  cap, and one more so an over-cap sheet always shows a row past the cap. */
export const SHEET_ROW_WINDOW = HEADER_SCAN_ROWS + MAX_SHEET_ROWS + 1;
/** Sheet names that would address the prototype chain rather than a sheet. */
const UNSAFE_SHEET_NAMES: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

const looksLikeHeaderRow = (row: unknown[]): boolean => {
  const filled = row.filter((c) => cellToText(c).length > 0);
  if (filled.length < 2) return false;
  // Headers are short labels, not sentences or pure numbers.
  const labelish = filled.filter((c) => {
    const s = cellToText(c);
    return s.length <= 60 && !/^\d+(\.\d+)?$/.test(s);
  });
  return labelish.length >= Math.ceil(filled.length * 0.7);
};

/** Run `fn` and refuse its result if it added an own property to a shared
 *  prototype (the prototype-pollution class the parser's advisories name).
 *  Any added key is deleted BEFORE throwing, so a warm server instance is
 *  not left polluted for every later request. */
export function withPrototypeGuard<T>(fn: () => T): T {
  const guarded: object[] = [Object.prototype, Array.prototype];
  const before = guarded.map((p) => new Set(Object.getOwnPropertyNames(p)));
  const result = fn();
  const added: string[] = [];
  guarded.forEach((p, i) => {
    for (const k of Object.getOwnPropertyNames(p)) {
      if (before[i].has(k)) continue;
      added.push(k);
      try { delete (p as Record<string, unknown>)[k]; } catch { /* non-configurable: reported below */ }
    }
  });
  if (added.length > 0) {
    throw new Error(`Refused: the spreadsheet attempted to alter the runtime (${added.join(", ")}).`);
  }
  return result;
}

// ── 0.18.5 text-cell typing (XEDGE-12) ─────────────────────────────────────
// A port of SheetJS 0.18.5's `fuzzynum` / `fuzzydate` and of the cell typing
// its CSV and HTML readers applied to a text cell, kept exact except that the
// one super-linear regex (`/[(](.*)[)]/` in fuzzynum, the ReDoS class 0.20.2
// removed) is replaced by a linear scan with the same match.

/** `ss.replace(/[(](.*)[)]/, $1)` without the regex: the leftmost "(" that a
 *  ")" follows on the same line, through the LAST such ")" (greedy `.*`,
 *  which stops at a line terminator). Null when nothing matches. */
function unparenOnce(ss: string): string | null {
  const isLineEnd = (c: string) => c === "\n" || c === "\r" || c === "\u2028" || c === "\u2029";
  let i = ss.indexOf("(");
  while (i !== -1) {
    let end = i + 1;
    while (end < ss.length && !isLineEnd(ss[end])) end++;
    for (let j = end - 1; j > i; j--) {
      if (ss[j] === ")") return ss.slice(0, i) + ss.slice(i + 1, j) + ss.slice(j + 1);
    }
    // No ")" after this "(" on its line, so none after any later "(" on it either.
    i = ss.indexOf("(", end);
  }
  return null;
}

/** SheetJS 0.18.5 `fuzzynum`: "1,234", "$5", "50%", "(12)" as numbers; NaN otherwise. */
function legacyFuzzyNum(s: string): number {
  let v = Number(s);
  if (!isNaN(v)) return isFinite(v) ? v : NaN;
  if (!/\d/.test(s)) return v;
  let wt = 1;
  let ss = s.replace(/([\d]),([\d])/g, "$1$2").replace(/[$]/g, "").replace(/[%]/g, () => { wt *= 100; return ""; });
  if (!isNaN(v = Number(ss))) return v / wt;
  const unparened = unparenOnce(ss);
  if (unparened !== null) { wt = -wt; ss = unparened; }
  if (!isNaN(v = Number(ss))) return v / wt;
  return v;
}

const LEGACY_MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

/** SheetJS 0.18.5 `fuzzydate`: whether the text reads as a date (to the
 *  engine's own Date parser, local time). */
function legacyFuzzyDate(s: string): boolean {
  const o = new Date(s);
  const y = o.getFullYear() - 1900, m = o.getMonth(), d = o.getDate();
  if (isNaN(d)) return false;
  let lower = s.toLowerCase();
  if (lower.match(/jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec/)) {
    lower = lower.replace(/[^a-z]/g, "").replace(/([^a-z]|^)[ap]m?([^a-z]|$)/, "");
    if (lower.length > 3 && LEGACY_MONTHS.indexOf(lower) === -1) return false;
  } else if (lower.match(/[a-z]/)) return false;
  if (y < 0 || y > 8099) return false;
  if ((m > 0 || d > 1) && y !== 101) return true;
  if (s.match(/[^-0-9:,\/\\]/)) return false;
  return true;
}

/** The cell SheetJS 0.18.5 made of one text cell. A date is stored as the
 *  text `cellToText` made of 0.18.5's Date (`new Date(text)`, local time),
 *  so no later UTC / local conversion can move it; a CSV formula is a value-
 *  less formula cell, which reads as blank — exactly as before. */
function legacyTextCell(s: string, family: "dsv" | "html"): XLSX.CellObject {
  if (s.trim().length === 0) return { t: "s", v: s };
  if (family === "dsv" && s.charCodeAt(0) === 0x3d) {
    if (s.charCodeAt(1) === 0x22 && s.charCodeAt(s.length - 1) === 0x22) return { t: "s", v: s.slice(2, -1).replace(/""/g, '"') };
    if (s.length > 1) return { t: "n", f: s.slice(1) };
    return { t: "s", v: s };
  }
  if (s === "TRUE") return { t: "b", v: true };
  if (s === "FALSE") return { t: "b", v: false };
  const n = legacyFuzzyNum(s);
  if (!isNaN(n)) return { t: "n", v: n };
  if (legacyFuzzyDate(s)) return { t: "s", v: cellToText(new Date(s)) };
  return { t: "s", v: s };
}

/** Which of SheetJS's text readers built this workbook: "dsv" (CSV / TSV /
 *  any delimited or single-column text, UTF-8 / UTF-16), "html" (an HTML
 *  table, often saved as .xls), or null for a typed format whose cells are
 *  left as SheetJS read them. */
function textFamily(wb: XLSX.WorkBook, bytes: Uint8Array): "dsv" | "html" | null {
  if (wb.bookType === "html") return "html";
  // The delimited-text reader returns a bare { SheetNames, Sheets } with no
  // bookType; so do only the Lotus (first byte 0x00, or FF 00) and SocialCalc
  // readers, which are told apart by their first bytes.
  const keys = Object.keys(wb).sort().join(",");
  if (wb.bookType !== undefined || keys !== "SheetNames,Sheets") return null;
  if (bytes[0] === 0x00 || (bytes[0] === 0xff && bytes[1] === 0x00)) return null;
  const head = bytes[0] === 0xff && bytes[1] === 0xfe
    ? Buffer.from(bytes.subarray(2, 2 + 40)).toString("utf16le")
    : Buffer.from(bytes.subarray(0, 24)).toString("latin1").replace(/^\xef\xbb\xbf/, "");
  if (head.startsWith("socialcalc:version:")) return null;
  return "dsv";
}

/** Re-type every text cell of `ws` with the 0.18.5 rules, from the text
 *  SheetJS keeps for it. A CRLF inside a quoted CSV field reads as LF, as
 *  0.18.5 (which normalised line ends before splitting) read it. (An HTML
 *  table 0.18.5 would have read is read by lib/xlsxLegacyHtml.ts instead;
 *  "html" here is only a table 0.20.3 alone takes for HTML.) */
function retypeTextCells(ws: XLSX.WorkSheet, family: "dsv" | "html"): void {
  for (const key of Object.keys(ws)) {
    if (key.charAt(0) === "!") continue;
    const cell = ws[key] as XLSX.CellObject | undefined;
    if (!cell || typeof cell.w !== "string" || cell.w.length === 0) continue;
    const text = family === "dsv" ? cell.w.replace(/\r\n/g, "\n") : cell.w;
    ws[key] = legacyTextCell(text, family);
  }
}

/** An error cell read as the error's text ("#DIV/0!"), as 0.18.5 read an
 *  OpenDocument error. */
function keepErrorText(ws: XLSX.WorkSheet): void {
  for (const key of Object.keys(ws)) {
    if (key.charAt(0) === "!") continue;
    const cell = ws[key] as XLSX.CellObject | undefined;
    if (cell?.t === "e" && typeof cell.w === "string") ws[key] = { t: "s", v: cell.w };
  }
}

/** Most cells (rows × columns of the used range) a sheet is read into rows
 *  with: the whole read window (SHEET_ROW_WINDOW, 10,016 rows) × 200 columns. Reading builds every row to the full
 *  width of the range, at about 3 µs and 400 bytes per cell (measured: 2M
 *  cells ≈ 6 s and 0.8 GB peak; 5M ≈ 17 s and 1.6 GB), so a range a few bytes
 *  can declare (a runaway colspan, a CSV line of commas, an xlsx dimension
 *  to XFD) must not reach it. A range past the budget is first trimmed to the
 *  cells actually present (its trailing empty rows and columns read as
 *  nothing); only a sheet whose real data spans more is refused. */
export const MAX_SHEET_CELLS = SHEET_ROW_WINDOW * 200;

/** The range sheet_to_json reads: undefined (the sheet's own) when within
 *  MAX_SHEET_CELLS — exactly as before — else the used range's end trimmed
 *  to the last row and column holding a cell; refused if still over. */
function readRange(ws: XLSX.WorkSheet, sheetName: string): string | undefined {
  const ref = ws["!ref"];
  if (typeof ref !== "string" || !ref) return undefined;
  let r: XLSX.Range;
  try { r = XLSX.utils.decode_range(ref); } catch { return undefined; }
  const cellsIn = (eR: number, eC: number) => (eR - r.s.r + 1) * (eC - r.s.c + 1);
  // An empty HTML table's range is reversed (start past end): nothing to read.
  if (!(r.e.r >= r.s.r && r.e.c >= r.s.c) || !(cellsIn(r.e.r, r.e.c) > MAX_SHEET_CELLS)) return undefined;
  let lastR = r.s.r;
  let lastC = r.s.c;
  for (const key of Object.keys(ws)) {
    if (key.charAt(0) === "!") continue;
    const at = XLSX.utils.decode_cell(key);
    if (at.r < r.s.r || at.r > r.e.r || at.c < r.s.c || at.c > r.e.c) continue;
    if (at.r > lastR) lastR = at.r;
    if (at.c > lastC) lastC = at.c;
  }
  if (cellsIn(lastR, lastC) > MAX_SHEET_CELLS) {
    throw new Error(
      `Sheet "${sheetName}" spans ${(lastR - r.s.r + 1).toLocaleString("en-US")} rows × ${(lastC - r.s.c + 1).toLocaleString("en-US")} columns; the generator reads at most ${MAX_SHEET_CELLS.toLocaleString("en-US")} cells per sheet. Delete unused columns or split it into smaller workbooks.`,
    );
  }
  return XLSX.utils.encode_range({ s: r.s, e: { r: lastR, c: lastC } });
}

/** Rows spanned by an A1-style range string; 0 when absent or unparseable. */
function rangeRows(ref: unknown): number {
  if (typeof ref !== "string" || !ref) return 0;
  try { return XLSX.utils.decode_range(ref).e.r + 1; } catch { return 0; }
}

/** Parse a workbook (xlsx/xls/csv) into headers + row objects. Throws when
 *  the sheet holds more than MAX_SHEET_ROWS data rows (see the header). */
export function parseWorkbook(bytes: Uint8Array | Buffer, sheet?: string): SheetData {
  if (bytes.byteLength > MAX_WORKBOOK_BYTES) {
    throw new Error(
      `That spreadsheet is ${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB; the limit is ${MAX_WORKBOOK_BYTES / 1024 / 1024} MB. Split it or remove embedded images.`,
    );
  }
  // An HTML table 0.18.5 would have read is read by its own reader, ported
  // (lib/xlsxLegacyHtml.ts): segmentation, per-cell text marks and typing
  // exactly as before. Everything else is read by the vendored 0.20.3.
  const legacyHtml = withPrototypeGuard(() => legacyHtmlWorkbook(bytes, SHEET_ROW_WINDOW, (text, markedText) =>
    markedText ? { t: "s", v: text } : legacyTextCell(text, "html")));
  const wb = legacyHtml ?? withPrototypeGuard(() => XLSX.read(bytes, {
    type: "buffer",
    cellDates: true,
    // Bound the work per sheet: header scan window + the data cap + 1.
    sheetRows: SHEET_ROW_WINDOW,
  }));
  // Only sheets that are OWN keys of wb.Sheets under a safe name are real;
  // "__proto__" as a sheet name addresses the prototype, not a sheet.
  const sheetNames = wb.SheetNames.filter(
    (n) => !UNSAFE_SHEET_NAMES.has(n) && Object.prototype.hasOwnProperty.call(wb.Sheets, n),
  );
  const sheetName = sheet && sheetNames.includes(sheet) ? sheet : sheetNames[0];
  if (!sheetName) return { sheetName: "", headers: [], rows: [], sheetNames };

  const ws = wb.Sheets[sheetName];
  const family = legacyHtml ? null : textFamily(wb, bytes);
  if (family) retypeTextCells(ws, family);
  // An OpenDocument sheet (.ods / flat .fods): 0.18.5 kept a formula's error
  // ("#DIV/0!", "#N/A") as its text and read a date as the calendar date the
  // file states; 0.20.3 makes the error a blank error cell and shifts the
  // date to the server's local midnight. Keep both as they were.
  const openDocument = wb.bookType === "ods" || wb.bookType === "fods";
  if (openDocument) keepErrorText(ws);
  // A read the window cut is refused outright: `!fullref` (xlsx/xls) keeps
  // the sheet's whole used range when `sheetRows` trimmed it, and a `!ref`
  // that fills the window (csv leaves no `!fullref`) may have been trimmed.
  const seenRows = Math.max(rangeRows(ws["!fullref"]), rangeRows(ws["!ref"]));
  if (rangeRows(ws["!fullref"]) > SHEET_ROW_WINDOW || rangeRows(ws["!ref"]) >= SHEET_ROW_WINDOW) {
    throw new Error(
      `Sheet "${sheetName}" runs to row ${seenRows.toLocaleString("en-US")} or beyond; the generator reads at most ${MAX_SHEET_ROWS.toLocaleString("en-US")} data rows per sheet. Remove the trailing rows or split it into smaller workbooks.`,
    );
  }
  const range = readRange(ws, sheetName);
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, blankrows: false, defval: "", UTC: openDocument, ...(range ? { range } : {}) });
  // The same rows keyed by column letter: SheetJS applies its one blank-row
  // rule to both reads and stamps each keyed row with its 0-based sheet row
  // (__rowNum__, non-enumerable) — which array rows do not carry.
  const stamped = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { header: "A", blankrows: false, defval: "", UTC: openDocument, ...(range ? { range } : {}) });
  const sheetRowOf = (i: number): number | null => {
    if (stamped.length !== matrix.length) return null;
    const n = (stamped[i] as { __rowNum__?: unknown } | undefined)?.__rowNum__;
    return typeof n === "number" ? n + 1 : null;
  };

  // Find the header row — scan the first 15 rows for the first plausible one.
  let headerIdx = matrix.findIndex((r, i) => i < HEADER_SCAN_ROWS && looksLikeHeaderRow(r));
  if (headerIdx === -1) headerIdx = 0;

  const rawHeaders = (matrix[headerIdx] ?? []).map((c) => cellToText(c));
  // Name unnamed columns so mapping UI never shows blanks.
  const headers = rawHeaders.map((h, i) => h || `Column ${i + 1}`);

  const rows: Array<Record<string, string>> = [];
  const rowNumbers: number[] = [];
  for (let r = headerIdx + 1; r < matrix.length; r++) {
    const row = matrix[r] ?? [];
    const obj: Record<string, string> = {};
    let any = false;
    headers.forEach((h, i) => {
      const v = cellToText(row[i]);
      obj[h] = v;
      if (v) any = true;
    });
    if (!any) continue;
    if (rows.length >= MAX_SHEET_ROWS) {
      throw new Error(
        `Sheet "${sheetName}" has more than ${MAX_SHEET_ROWS.toLocaleString("en-US")} data rows; the generator drafts at most ${MAX_SHEET_ROWS.toLocaleString("en-US")} per sheet. Split it into smaller workbooks.`,
      );
    }
    rows.push(obj);
    const sheetRow = sheetRowOf(r);
    if (sheetRow !== null) rowNumbers.push(sheetRow);
  }
  return { sheetName, headers, rows, sheetNames, ...(rowNumbers.length === rows.length ? { rowNumbers } : {}) };
}
