// lib/xlsxData.ts — SERVER-ONLY. Read tabular source data (the work-order
// spreadsheet) into plain rows the generator can map onto template tags.
//
// Deliberately forgiving about real-world spreadsheets: the header row is
// rarely row 1 (titles, logos, blank spacers come first), so we find the
// first row that actually looks like headers, and we drop fully-empty rows
// rather than minting blank documents from them.

import * as XLSX from "xlsx";
import { cellToText } from "@/lib/outputTemplateText";

export interface SheetData {
  sheetName: string;
  headers: string[];
  rows: Array<Record<string, string>>;
  /** Sheets present in the workbook (so the UI can offer a picker). */
  sheetNames: string[];
}

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

/** Parse a workbook (xlsx/xls/csv) into headers + row objects. */
export function parseWorkbook(bytes: Uint8Array | Buffer, sheet?: string): SheetData {
  const wb = XLSX.read(bytes, { type: "buffer", cellDates: true });
  const sheetNames = wb.SheetNames;
  const sheetName = sheet && sheetNames.includes(sheet) ? sheet : sheetNames[0];
  if (!sheetName) return { sheetName: "", headers: [], rows: [], sheetNames };

  const ws = wb.Sheets[sheetName];
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, blankrows: false, defval: "" });

  // Find the header row — scan the first 15 rows for the first plausible one.
  let headerIdx = matrix.findIndex((r, i) => i < 15 && looksLikeHeaderRow(r));
  if (headerIdx === -1) headerIdx = 0;

  const rawHeaders = (matrix[headerIdx] ?? []).map((c) => cellToText(c));
  // Name unnamed columns so mapping UI never shows blanks.
  const headers = rawHeaders.map((h, i) => h || `Column ${i + 1}`);

  const rows: Array<Record<string, string>> = [];
  for (let r = headerIdx + 1; r < matrix.length; r++) {
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
