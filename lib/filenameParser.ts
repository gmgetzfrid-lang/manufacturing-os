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
//   EP 5-3-10 - Ball Valves.pdf -> docNum: EP 5-3-10, title: Ball Valves
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

// A revision token: _R7, -R02, R38, RevA, Rev 3, Rev.B, Revision 2, Rev B1.
// It must stand on its own — "Relief", "Review", "Revised" are words, not
// revisions — so it ends at the end of the name or at a separator.
const REV_TOKEN = /(?:^|[_\-. ])(?:rev(?:ision)?[._\- ]?([A-Z]\d{0,2}|\d{1,3})|r(\d{1,3}))(?=$|[_\-. ])/gi;
// Sheet: SHT01, SHEET_2, SH-3 — again as its own token.
const SHEET_TOKEN = /(?:^|[_\-. ])(?:SHT|SHEET|SH)[._\- ]?(\d{1,3})(?=$|[_\-. ])/gi;
// Only unmistakable dates: 2024-03-15, 15-03-2024, 3_15_2024, and the
// CAD-export stamp "_09-14-26" (zero-padded month-day-year after an
// underscore). A short a-b-c like 5-3-10 is a document number far more
// often than a date.
const DATE_TOKEN = /\b(?:(?:19|20)\d{2}[-_.]\d{1,2}[-_.]\d{1,2}|\d{1,2}[-_.]\d{1,2}[-_.](?:19|20)\d{2})\b|(?<=_)(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])-\d{2}(?=$|[_. ])/g;
// "NUMBER - Title": a spaced dash (or en/em dash) separating the two.
const NUMBER_TITLE = /^(.+?)\s+[-\u2013\u2014]\s+(.+)$/;

const tidy = (s: string) => s.replace(/\s+/g, " ").replace(/^[_\-. ]+|[_\-. ]+$/g, "").trim();

export function parseFilename(filename: string): ParsedFilename {
  // Strip extension
  const base = filename.replace(/\.[^.]+$/, "");

  // ─── Rev extraction ────────────────────────────────────────────────
  // The LAST revision token wins ("…_R1_R2" means R2).
  let rev = "0";
  for (const m of base.matchAll(REV_TOKEN)) rev = (m[1] ?? m[2]).toUpperCase();

  // ─── Sheet extraction ──────────────────────────────────────────────
  let sheet: string | undefined;
  const sheetMatch = [...base.matchAll(SHEET_TOKEN)][0];
  if (sheetMatch) sheet = sheetMatch[1];

  // ─── Unit extraction ───────────────────────────────────────────────
  // Patterns: Unit_100, U-200, prefix 100-
  let unit: string | undefined;
  const unitMatch1 = base.match(/(?:^|[_\- ])U(?:nit)?[._\- ]?(\d{2,4})(?=$|[_\-. ])/i);
  if (unitMatch1) {
    unit = unitMatch1[1];
  } else {
    const prefixMatch = base.match(/^(\d{2,4})[\-_]/);
    if (prefixMatch) unit = prefixMatch[1];
  }

  // ─── Date extraction ───────────────────────────────────────────────
  const datestamp = base.match(DATE_TOKEN)?.[0];

  // ─── Type detection ────────────────────────────────────────────────
  let type: string | undefined;
  for (const { pattern, label } of DOC_TYPE_TOKENS) {
    if (pattern.test(base)) { type = label; break; }
  }

  // ─── Number and title ──────────────────────────────────────────────
  // Rev, sheet and date tokens come out; what is left is the identity.
  const strip = (s: string) => tidy(s.replace(REV_TOKEN, " ").replace(SHEET_TOKEN, " ").replace(DATE_TOKEN, " "));
  const split = base.match(NUMBER_TITLE);
  let docNum: string;
  let title: string;
  if (split && /\d/.test(split[1]) && split[1].length <= 40) {
    // "EP 5-3-10 - Ball Valves": the number, then the title.
    docNum = strip(split[1]) || tidy(split[1]);
    title = strip(split[2].replace(/_+/g, " ")) || tidy(split[2]);
  } else {
    docNum = strip(base);
    title = tidy(base.replace(/_+/g, " "));
  }

  return {
    documentNumber: docNum || base,
    title: title || base,
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
