// lib/filenameParser.ts
//
// Parses common industrial drawing filename patterns into metadata
// hints for the upload-staging UI. The parser is conservative — if
// it can't confidently identify a field, it returns empty and the
// staging UI's user-edit step fills it in.
//
// Patterns covered (refinery-typical):
//   100-PID-001_R7.pdf         -> docNum: 100-PID-001, rev: 7, type: P&ID
//   200-PID-001_R02.pdf        -> docNum: 200-PID-001, rev: 02
//   2002-D-2001_SHT01_R38.pdf  -> docNum: 2002-D-2001, sheet: 01, rev: 38
//   200-ISO-014_RevA.pdf       -> docNum: 200-ISO-014, rev: A, type: Isometric
//   P-200-301-AS_BUILT.pdf     -> docNum: P-200-301, type: As-Built
//   Unit_100_East_PID.pdf      -> hints.unit: 100, type: P&ID
//
// Each org will eventually want custom regex patterns added to library
// settings. v1 ships with the universal ones above.

export interface ParsedFilename {
  documentNumber: string;
  title: string;
  rev: string;
  hints: {
    type?: string;
    sheet?: string;
    unit?: string;
    datestamp?: string;
  };
}

const DOC_TYPE_TOKENS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\bP&IDs?\b|[_\- ]PID[_\- .]|^PID[_\- ]|[_\- ]PID$/i, label: "P&ID" },
  { pattern: /[_\- ]ISO[_\- .]|^ISO[_\- ]|[_\- ]ISO$|\bisometric\b/i, label: "Isometric" },
  { pattern: /[_\- ]PFD[_\- .]|^PFD[_\- ]/i, label: "PFD" },
  { pattern: /[_\- ]MFD[_\- .]/i, label: "MFD" },
  { pattern: /AS[_\- ]?BUILT/i, label: "As-Built" },
  { pattern: /[_\- ]PLOT[_\- ]PLAN[_\- .]|PLOT_PLAN/i, label: "Plot Plan" },
  { pattern: /\bplan\b|PLAN[_\- ]/i, label: "Drawing" },
  { pattern: /\bspec\b|SPEC[_\- ]/i, label: "Specification" },
  { pattern: /SOP|procedure/i, label: "Procedure" },
  { pattern: /MOC|Management[_\- ]of[_\- ]Change/i, label: "MOC" },
];

export function parseFilename(filename: string): ParsedFilename {
  // Strip extension
  const base = filename.replace(/\.[^.]+$/, "");

  // ─── Rev extraction ────────────────────────────────────────────────
  // Patterns:  _R7, _R02, _Rev7, _RevA, -R38
  let rev = "0";
  const revMatch = base.match(/[_\- ](?:r(?:ev)?[\.\-]?)([A-Z0-9]+)\b/i);
  if (revMatch) rev = revMatch[1];

  // ─── Sheet extraction ──────────────────────────────────────────────
  // Patterns: SHT01, SHEET_2, _S1, _SH01
  let sheet: string | undefined;
  const sheetMatch = base.match(/(?:SHT|SHEET|SH)[._\- ]?(\d{1,3})\b/i);
  if (sheetMatch) sheet = sheetMatch[1];

  // ─── Unit extraction ───────────────────────────────────────────────
  // Patterns: Unit_100, U-200, 100_Unit, prefix 100-
  let unit: string | undefined;
  const unitMatch1 = base.match(/(?:^|[_\- ])U(?:nit)?[._\- ]?(\d{2,4})\b/i);
  if (unitMatch1) {
    unit = unitMatch1[1];
  } else {
    // Try matching prefix like "100-" or "200-PID..."
    const prefixMatch = base.match(/^(\d{2,4})[\-_]/);
    if (prefixMatch) unit = prefixMatch[1];
  }

  // ─── Date extraction ───────────────────────────────────────────────
  // Strip trailing dates so they don't pollute the doc number
  const dateMatch = base.match(/(\d{1,2}[\-_]\d{1,2}[\-_]\d{2,4})/);
  const datestamp = dateMatch ? dateMatch[1] : undefined;

  // ─── Type detection ────────────────────────────────────────────────
  let type: string | undefined;
  for (const { pattern, label } of DOC_TYPE_TOKENS) {
    if (pattern.test(base)) { type = label; break; }
  }

  // ─── Document number ───────────────────────────────────────────────
  // Strip rev, sheet, date, and known type suffixes. Whatever remains
  // is the document number.
  const docNum = base
    .replace(/[_\- ](?:r(?:ev)?[\.\-]?)[A-Z0-9]+/gi, "")
    .replace(/(?:SHT|SHEET|SH)[._\- ]?\d{1,3}/gi, "")
    .replace(/\d{1,2}[\-_]\d{1,2}[\-_]\d{2,4}/g, "")
    .replace(/[_\- ]+$/, "")
    .replace(/^[_\- ]+/, "")
    .trim();

  // ─── Title ─────────────────────────────────────────────────────────
  // Human-readable: collapse underscores/dashes to spaces
  const title = base
    .replace(/[_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return {
    documentNumber: docNum || base,
    title,
    rev,
    hints: { type, sheet, unit, datestamp },
  };
}

/**
 * Try to detect a common pattern across all uploaded files. If the
 * doc-number portion is structured (e.g., all start with "100-"), we
 * can surface a "Bulk apply unit: 100" suggestion.
 */
export function detectBulkHints(parsed: ParsedFilename[]): {
  commonUnit?: string;
  commonType?: string;
} {
  if (parsed.length === 0) return {};
  const units = parsed.map((p) => p.hints.unit).filter(Boolean) as string[];
  const types = parsed.map((p) => p.hints.type).filter(Boolean) as string[];

  const allSameUnit = units.length === parsed.length && new Set(units).size === 1;
  const allSameType = types.length === parsed.length && new Set(types).size === 1;

  return {
    commonUnit: allSameUnit ? units[0] : undefined,
    commonType: allSameType ? types[0] : undefined,
  };
}
