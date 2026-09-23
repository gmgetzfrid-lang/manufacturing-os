// lib/xlsxData.ts — SERVER-ONLY. Read tabular source data (the work-order
// spreadsheet) into plain rows the generator can map onto template tags.
//
// Deliberately forgiving about real-world spreadsheets: the header row is
// rarely row 1 (titles, logos, blank spacers come first), so we find the
// first row that actually looks like headers, and we drop fully-empty rows
// rather than minting blank documents from them.
//
// XEDGE-12: the parser is the npm-registry xlsx 0.18.5 — the last registry
// release; the prototype-pollution (0.19.3) and ReDoS (0.20.2) fixes exist
// only on the vendor CDN — and it runs in the server process beside the
// service-role client. Until the dependency is moved, every parse runs on
// HARDENED input: a byte cap, a per-sheet row cap, unsafe sheet names
// ignored, and a prototype guard that detects and reverts any own property
// the parse adds to Object.prototype / Array.prototype, refusing the file.

import * as XLSX from "xlsx";
import { cellToText } from "@/lib/outputTemplateText";

export interface SheetData {
  sheetName: string;
  headers: string[];
  rows: Array<Record<string, string>>;
  /** Sheets present in the workbook (so the UI can offer a picker). */
  sheetNames: string[];
}

/** Largest workbook the generator will parse. */
export const MAX_WORKBOOK_BYTES = 25 * 1024 * 1024;
/** Data rows parsed per sheet (the draft path slices 25 at a time anyway). */
export const MAX_SHEET_ROWS = 10_000;
/** Rows scanned for the header row — see the findIndex below. */
const HEADER_SCAN_ROWS = 15;
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

/** Parse a workbook (xlsx/xls/csv) into headers + row objects. */
export function parseWorkbook(bytes: Uint8Array | Buffer, sheet?: string): SheetData {
  if (bytes.byteLength > MAX_WORKBOOK_BYTES) {
    throw new Error(
      `That spreadsheet is ${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB; the limit is ${MAX_WORKBOOK_BYTES / 1024 / 1024} MB. Split it or remove embedded images.`,
    );
  }
  const wb = withPrototypeGuard(() => XLSX.read(bytes, {
    type: "buffer",
    cellDates: true,
    // Bound the work per sheet: header scan window + the data rows we keep.
    sheetRows: HEADER_SCAN_ROWS + MAX_SHEET_ROWS,
  }));
  // Only sheets that are OWN keys of wb.Sheets under a safe name are real;
  // "__proto__" as a sheet name addresses the prototype, not a sheet.
  const sheetNames = wb.SheetNames.filter(
    (n) => !UNSAFE_SHEET_NAMES.has(n) && Object.prototype.hasOwnProperty.call(wb.Sheets, n),
  );
  const sheetName = sheet && sheetNames.includes(sheet) ? sheet : sheetNames[0];
  if (!sheetName) return { sheetName: "", headers: [], rows: [], sheetNames };

  const ws = wb.Sheets[sheetName];
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, blankrows: false, defval: "" });

  // Find the header row — scan the first 15 rows for the first plausible one.
  let headerIdx = matrix.findIndex((r, i) => i < HEADER_SCAN_ROWS && looksLikeHeaderRow(r));
  if (headerIdx === -1) headerIdx = 0;

  const rawHeaders = (matrix[headerIdx] ?? []).map((c) => cellToText(c));
  // Name unnamed columns so mapping UI never shows blanks.
  const headers = rawHeaders.map((h, i) => h || `Column ${i + 1}`);

  const rows: Array<Record<string, string>> = [];
  for (let r = headerIdx + 1; r < matrix.length && rows.length < MAX_SHEET_ROWS; r++) {
    const row = matrix[r] ?? [];
    const obj: Record<string, string> = {};
    let any = false;
    headers.forEach((h, i) => {
      const v = cellToText(row[i]);
      obj[h] = v;
      if (v) any = true;
    });
    if (any) rows.push(obj);
  }
  return { sheetName, headers, rows, sheetNames };
}
