// lib/filenameRoles.ts — read ANY file-naming convention, in any order.
//
// Every site names files its own way: "EP 5-3-10 - Ball Valves",
// "2002-D 2001_SHT01_R39_06-09-26", "Ball Valves_Rev B_EP-5310",
// "20240315 P-101 datasheet". Rather than one pattern per convention, a
// name is cut into its pieces and each piece is recognised by what it looks
// like, wherever it sits:
//
//   revision  R7 · Rev 3 · RevA · Revision B · Rev.2
//   sheet     SHT01 · Sheet 2 · SH-3 · 1 of 16
//   date      2024-03-15 · 15.03.2024 · 20240315 · 09-14-26 (zero-padded)
//   number    the first run of pieces carrying digits ("2002-D 2001",
//             "EP 5-3-10", "100-PID-001"), with a short code before it
//   title     the words
//
// A piece that could be two things (a zero-padded 05-03-10, a 6-digit
// 240315, a second number) is marked unsure. A batch of files from one
// place shares one convention, so unsure pieces are settled by the files
// whose same piece was clear. What is still unsure is shown to the person
// once, for the whole batch — and their answer is remembered.

export type NameRole = "number" | "title" | "rev" | "sheet" | "date" | "skip";

export interface NamePart {
  text: string;
  role: NameRole;
  /** The value for its field: "39" for "R39", "01" for "SHT01". */
  value: string;
  sure: boolean;
}

export interface NameReading {
  parts: NamePart[];
  /** The pieces' look, position by position — files with the same shape
   *  follow the same convention, and one answer covers them all. */
  shape: string;
  sure: boolean;
}

export interface NameFields {
  documentNumber: string;
  title: string;
  rev: string;
  sheet?: string;
  datestamp?: string;
}

const REV_INLINE = /^(?:REV(?:ISION)?[._-]?([A-Z]\d{0,2}|\d{1,3})|R(\d{1,3})|RV(\d{1,3}))$/i;
const REV_WORD = /^REV(?:ISION)?\.?$/i;
const SHEET_INLINE = /^(?:SHT|SHEET|SH)[._-]?(\d{1,3})$/i;
const SHEET_WORD = /^(?:SHT|SHEET|SH)\.?$/i;
const REV_VALUE = /^([A-Z]\d{0,2}|\d{1,3})$/i;
const SHEET_VALUE = /^\d{1,3}$/;

const valid = (m: number, d: number) => m >= 1 && m <= 12 && d >= 1 && d <= 31;
/** "sure" | "maybe" | null. */
function dateKind(t: string): "sure" | "maybe" | null {
  let m: RegExpMatchArray | null;
  if ((m = t.match(/^(19|20)\d{2}[-_.](\d{1,2})[-_.](\d{1,2})$/))) return valid(+m[2], +m[3]) ? "sure" : null;
  if ((m = t.match(/^(\d{1,2})[-_.](\d{1,2})[-_.](19|20)\d{2}$/))) return valid(+m[1], +m[2]) || valid(+m[2], +m[1]) ? "sure" : null;
  if ((m = t.match(/^(19|20)\d{2}(\d{2})(\d{2})$/))) return valid(+m[2], +m[3]) ? "maybe" : null;
  // Zero-padded two-digit parts (09-14-26): a CAD export stamp more often
  // than not — but a document number can look the same.
  if ((m = t.match(/^(\d{2})-(\d{2})-(\d{2})$/))) return valid(+m[1], +m[2]) || valid(+m[2], +m[1]) ? "maybe" : null;
  return null;
}

const hasDigit = (t: string) => /\d/.test(t);
const isCode = (t: string) => /^[A-Z&]{1,5}$/.test(t);          // EP, SOP, PID, P&ID-ish
const isWord = (t: string) => /^[\p{L}][\p{L}'&.,()/-]*$/u.test(t) && !hasDigit(t);

/** Cut a name into pieces: underscores and spaced dashes separate fields;
 *  spaces separate words. "Rev 3", "SHT 2" and "1 of 16" stay together. */
function pieces(base: string): string[] {
  const words = base
    .replace(/\s+[-–—]\s+/g, "_")
    .split(/[_\s]+/)
    .map((w) => w.trim())
    .filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i], next = words[i + 1];
    if (next && REV_WORD.test(w) && REV_VALUE.test(next)) { out.push(`${w} ${next}`); i++; continue; }
    // "Unit 100" names a plant area — part of the title, not a document number.
    if (next && /^unit$/i.test(w) && /^\d{1,4}$/.test(next)) { out.push(`${w} ${next}`); i++; continue; }
    if (next && SHEET_WORD.test(w) && SHEET_VALUE.test(next)) { out.push(`${w} ${next}`); i++; continue; }
    if (next && words[i + 2] && /^\d{1,3}$/.test(w) && /^of$/i.test(next) && /^\d{1,3}$/.test(words[i + 2])) {
      out.push(`${w} of ${words[i + 2]}`); i += 2; continue;
    }
    out.push(w);
  }
  return out;
}

function classify(p: string): { role: NameRole; value: string; sure: boolean } | null {
  const compact = p.replace(/\s+/g, "");
  let m: RegExpMatchArray | null;
  if ((m = compact.match(REV_INLINE))) return { role: "rev", value: (m[1] ?? m[2] ?? m[3]).toUpperCase(), sure: true };
  if ((m = compact.match(SHEET_INLINE))) return { role: "sheet", value: m[1], sure: true };
  if ((m = p.match(/^(\d{1,3}) of (\d{1,3})$/i)) && +m[1] <= +m[2]) return { role: "sheet", value: m[1], sure: true };
  if (/^unit \d{1,4}$/i.test(p)) return { role: "title", value: p, sure: true };
  const d = dateKind(p);
  if (d) return { role: "date", value: p, sure: d === "sure" };
  return null;
}

export function readNameParts(filename: string): NameReading {
  const base = filename.replace(/\.[^.]+$/, "");
  const raw = pieces(base);
  const parts: NamePart[] = raw.map((t) => {
    const c = classify(t);
    if (c) return { text: t, ...c };
    if (hasDigit(t)) return { text: t, role: "number", value: t, sure: true };
    return { text: t, role: "title", value: t, sure: true };
  });

  // A zero-padded 09-14-26 at the very END of a name is the export stamp
  // ("…_R39_06-09-26"): that's where conventions put the date.
  const last = parts[parts.length - 1];
  if (parts.length > 1 && last.role === "date" && !last.sure && /^\d{2}-\d{2}-\d{2}$/.test(last.text)) last.sure = true;

  // The number: the FIRST run of digit-bearing pieces, joined, with a short
  // code just before it ("EP" 5-3-10) or between its pieces (100 PID 001).
  const firstNum = parts.findIndex((p) => p.role === "number");
  if (firstNum >= 0) {
    let start = firstNum, end = firstNum;
    if (start > 0 && parts[start - 1].role === "title" && isCode(parts[start - 1].text) && start - 1 === 0) start--;
    while (end + 1 < parts.length) {
      const n = parts[end + 1];
      if (n.role === "number") { end++; continue; }
      if (n.role === "title" && isCode(n.text) && parts[end + 2]?.role === "number") { end += 2; continue; }
      break;
    }
    for (let i = start; i <= end; i++) parts[i].role = "number";
    // A second, separate run of digits: part of the title ("Pump 3"), or a
    // number of its own? Unsure — the batch or the person decides.
    for (let i = end + 1; i < parts.length; i++) {
      if (parts[i].role === "number") { parts[i].role = "title"; parts[i].sure = false; }
    }
  } else {
    // No digits anywhere ("Pump Relief Report"): the whole name stands as
    // the number, and that's a guess worth confirming.
    for (const p of parts) if (p.role === "title" && !isWord(p.text)) p.sure = false;
  }
  const shape = parts.map((p) => (classify(p.text)?.role ?? (hasDigit(p.text) ? "n" : "w"))[0]).join("");
  return { parts, shape: `${parts.length}:${shape}`, sure: parts.every((p) => p.sure) && firstNum >= 0 };
}

/** The fields a reading fills. */
export function partsToFields(parts: NamePart[], base: string): NameFields {
  const of = (r: NameRole) => parts.filter((p) => p.role === r);
  const number = of("number").map((p) => p.text).join(" ").trim();
  const title = of("title").map((p) => p.text).join(" ").replace(/\s+/g, " ").trim();
  const rev = of("rev").at(-1)?.value ?? "0";
  const sheet = of("sheet")[0]?.value;
  const datestamp = of("date")[0]?.value;
  const cleanBase = base.replace(/_+/g, " ").replace(/\s+/g, " ").trim();
  return {
    documentNumber: number || title || cleanBase,
    title: title || number || cleanBase,
    rev,
    ...(sheet ? { sheet } : {}),
    ...(datestamp ? { datestamp } : {}),
  };
}

/** A whole batch. Unsure pieces take the role the SAME piece has in files
 *  of the same shape where it was clear; `overrides` (the person's answer
 *  for a shape) win over everything. */
export function readBatch(filenames: string[], overrides: Record<string, NameRole[]> = {}): Array<NameReading & { fields: NameFields }> {
  const readings = filenames.map(readNameParts);
  const votes = new Map<string, Map<NameRole, number>[]>();
  for (const r of readings) {
    const v = votes.get(r.shape) ?? r.parts.map(() => new Map<NameRole, number>());
    r.parts.forEach((p, i) => { if (p.sure) v[i].set(p.role, (v[i].get(p.role) ?? 0) + 1); });
    votes.set(r.shape, v);
  }
  return readings.map((r, k) => {
    const told = overrides[r.shape];
    const v = votes.get(r.shape)!;
    const parts = r.parts.map((p, i) => {
      if (told?.[i]) return { ...p, role: told[i], value: valueFor(p.text, told[i]), sure: true };
      if (p.sure) return p;
      const best = [...v[i].entries()].sort((a, b) => b[1] - a[1])[0];
      return best ? { ...p, role: best[0], value: valueFor(p.text, best[0]), sure: true } : p;
    });
    const base = filenames[k].replace(/\.[^.]+$/, "");
    return { parts, shape: r.shape, sure: parts.every((p) => p.sure), fields: partsToFields(parts, base) };
  });
}

function valueFor(text: string, role: NameRole): string {
  const c = classify(text);
  if (c && c.role === role) return c.value;
  return text;
}

export const ROLE_LABEL: Record<NameRole, string> = {
  number: "Number", title: "Title", rev: "Revision", sheet: "Sheet", date: "Date", skip: "Ignore",
};
