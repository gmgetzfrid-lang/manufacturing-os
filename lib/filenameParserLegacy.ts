// lib/filenameParserLegacy.ts — the filename reader as it shipped before
// 2026-10-21, kept ONLY so the name repair can recognise exactly what it
// produced. Never use it to name anything.
//
// Its faults, for the record: any word starting with "r" after a space read
// as a revision ("EP 5-3-10 - Relief Valve" → rev "elief"), and any a-b-c
// number read as a date and was cut out ("EP 5-3-10" → "EP").

export function legacyParseFilename(filename: string): { documentNumber: string; title: string; rev: string } {
  const base = filename.replace(/\.[^.]+$/, "");
  let rev = "0";
  const revMatch = base.match(/[_\- ](?:r(?:ev)?[\.\-]?)([A-Z0-9]+)\b/i);
  if (revMatch) rev = revMatch[1];
  const docNum = base
    .replace(/[_\- ](?:r(?:ev)?[\.\-]?)[A-Z0-9]+/gi, "")
    .replace(/(?:SHT|SHEET|SH)[._\- ]?\d{1,3}/gi, "")
    .replace(/\d{1,2}[\-_]\d{1,2}[\-_]\d{2,4}/g, "")
    .replace(/[_\- ]+$/, "")
    .replace(/^[_\- ]+/, "")
    .trim();
  const title = base.replace(/[_]+/g, " ").replace(/\s+/g, " ").trim();
  return { documentNumber: docNum || base, title, rev };
}
