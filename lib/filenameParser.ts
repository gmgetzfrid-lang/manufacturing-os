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

import { readNameParts, partsToFields, type NameFields } from "@/lib/filenameRoles";

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
  const base = filename.replace(/\.[^.]+$/, "");
  // Which piece is which, by what it looks like, in any order — see
  // lib/filenameRoles.ts. A batch is read with readBatch, which settles
  // unsure pieces across the files and applies the person's answers.
  const reading = readNameParts(filename);
  return withHints(base, partsToFields(reading.parts, base));
}

/** The type / unit hints that ride alongside the fields. */
export function withHints(base: string, f: NameFields): ParsedFilename {
  // Unit: Unit_100, U-200 (not the first part of a date), or a leading 100-.
  let unit: string | undefined;
  const unitMatch1 = base.match(/(?:^|[_\- ])U(?:nit)?[._\- ]?(\d{2,4})(?=$|[_\-. ])(?![-_.]\d)/i);
  if (unitMatch1) unit = unitMatch1[1];
  else {
    const prefixMatch = base.match(/^(\d{2,4})[\-_]/);
    if (prefixMatch) unit = prefixMatch[1];
  }
  let type: string | undefined;
  for (const { pattern, label } of DOC_TYPE_TOKENS) {
    if (pattern.test(base)) { type = label; break; }
  }
  return {
    documentNumber: f.documentNumber,
    title: f.title,
    rev: f.rev,
    hints: { type, sheet: f.sheet, unit, datestamp: f.datestamp },
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
