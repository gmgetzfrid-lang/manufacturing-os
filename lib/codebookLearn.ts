// lib/codebookLearn.ts - what the site's own numbers say about its codes.
//
// A site's drawing numbers and equipment IDs already follow its convention;
// the codebook only has to be told. This reads the numbers on file and says
// what they show, with the count behind each line, for a person to accept:
//
//   drawing numbers   "5502-D 2000": unit 55, type 02, size D, number 2000.
//                     60 of 61 numbers read that way.
//   drawing types     type 02 is filed under "P&ID's" (58 of 58), type 03
//                     under "PFD's" (2 of 2).
//   tag letters       equipment whose ID says type 30 (Exchangers) is tagged
//                     E (32) or X (29).
//
// Nothing here writes, and nothing is proposed that the numbers do not show
// plainly: a pattern most numbers do not fit, a type filed in several
// places, a letter shared between types are all left out. Pure.

import type { Codebook, DrawingSegment } from "@/lib/codebook";

export interface NumberSample { number: string; topFolder: string | null }

export interface LearnedType { code: string; count: number; folder: string | null; inFolder: number; label: string | null; known: string | null }
export interface LearnedNumbering {
  segments: DrawingSegment[];
  /** Numbers that read as the pattern, of the numbers looked at. */
  fit: number; total: number;
  /** `sheet`: the sheet number saved on the end of the number
   *  ("3002-D 1086-13" is drawing 1086, sheet 13), when there is one. */
  examples: Array<{ number: string; unit: string; unitLabel: string; type: string; size: string; serial: string; sheet: string | null }>;
  types: LearnedType[];
  misses: string[];
}

/** "P&ID's" reads "P&ID"; "PFDs" reads "PFD"; "Isometrics" stays. */
export function folderAsTypeName(folder: string): string {
  const s = folder.trim().replace(/[‘’]/g, "'");
  if (/'s$/i.test(s)) return s.slice(0, -2);
  return /^[A-Z&]{2,6}s$/.test(s) ? s.slice(0, -1) : s;
}

/** The drawing-number convention the numbers on file follow: unit code,
 *  two-digit type, one size letter, a number. Null unless at least five
 *  numbers, and four in five of those looked at, read that way with a unit
 *  the codebook has. */
export function learnDrawingNumbers(samples: NumberSample[], book: Codebook): LearnedNumbering | null {
  const widths = Array.from(new Set(book.units.map((u) => u.code.length)));
  if (widths.length !== 1) return null; // unit codes of mixed length: not a pattern this reads
  const U = widths[0];
  const re = new RegExp(`^(\\d{${U}})(\\d{2})[-_. ]?([A-Z])[-_. ]+(\\d{2,6})(?!\\d)`, "i");
  const unit = new Map(book.units.map((u) => [u.code, u.label]));
  const withNumber = samples.filter((s) => s.number.trim());
  const hits: Array<{ s: NumberSample; m: RegExpMatchArray }> = [];
  const misses: string[] = [];
  for (const s of withNumber) {
    const m = s.number.trim().match(re);
    if (m && unit.has(m[1])) hits.push({ s, m }); else misses.push(s.number.trim());
  }
  if (hits.length < 5 || hits.length / withNumber.length < 0.8) return null;
  const byType = new Map<string, Map<string, number>>();
  for (const { s, m } of hits) {
    const t = byType.get(m[2]) ?? new Map<string, number>();
    const f = s.topFolder ?? "";
    t.set(f, (t.get(f) ?? 0) + 1);
    byType.set(m[2], t);
  }
  const types: LearnedType[] = [...byType.entries()].map(([code, folders]) => {
    const count = [...folders.values()].reduce((a, b) => a + b, 0);
    const [folder, inFolder] = [...folders.entries()].sort((a, b) => b[1] - a[1])[0];
    // A type is named for a folder only when all but one in ten of its drawings sit there.
    const named = folder && inFolder / count >= 0.9 ? folderAsTypeName(folder) : null;
    return { code, count, folder: folder || null, inFolder, label: named, known: book.drawingTypes.find((d) => d.code === code)?.label ?? null };
  }).sort((a, b) => b.count - a.count);
  const seen = new Set<string>();
  const examples = hits.filter(({ m }) => { const k = `${m[1]}${m[2]}`; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 4)
    .map(({ s, m }) => ({
      number: s.number.trim(), unit: m[1], unitLabel: unit.get(m[1]) ?? m[1], type: m[2], size: m[3].toUpperCase(), serial: m[4],
      sheet: s.number.trim().slice(m[0].length).match(/^[-_. ]+0*(\d{1,3})$/)?.[1] ?? null,
    }));
  return {
    segments: [{ kind: "unit", digits: U }, { kind: "drawing_type", digits: 2 }, { kind: "size", letters: 1 }, { kind: "iterable" }],
    fit: hits.length, total: withNumber.length, examples, types, misses: misses.slice(0, 8),
  };
}

export interface RegistrySample { tag: string; code: string | null }
export interface LearnedPrefixes { typeCode: string; typeLabel: string; letters: Array<{ letter: string; count: number }>; have: string[] }

/** The letters each equipment type is tagged with, from the registry: an
 *  ID says the type ("5530.29" is type 30), the tag says the letter
 *  ("E-22"). A letter is given to a type only when nine in ten of the tags
 *  with that letter are that type, and at least two are. */
export function learnTagLetters(assets: RegistrySample[], book: Codebook): LearnedPrefixes[] {
  const unitCodes = [...book.units.map((u) => u.code)].sort((a, b) => b.length - a.length);
  const types = new Map(book.equipmentTypes.map((t) => [t.code, t]));
  const byLetter = new Map<string, Map<string, number>>();
  for (const a of assets) {
    const m = String(a.code ?? "").trim().match(/^(\d+)\.\d+[A-Za-z]{0,2}$/);
    const letter = a.tag.trim().match(/^([A-Za-z]{1,4})[-\s]?\d/)?.[1]?.toUpperCase();
    if (!m || !letter) continue;
    const u = unitCodes.find((c) => m[1].startsWith(c));
    const typeCode = u ? m[1].slice(u.length) : null;
    if (!typeCode || !types.has(typeCode)) continue;
    const t = byLetter.get(letter) ?? new Map<string, number>();
    t.set(typeCode, (t.get(typeCode) ?? 0) + 1);
    byLetter.set(letter, t);
  }
  const out = new Map<string, LearnedPrefixes>();
  for (const [letter, counts] of byLetter) {
    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    const [typeCode, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (n < 2 || n / total < 0.9) continue;
    const t = types.get(typeCode)!;
    const row = out.get(typeCode) ?? { typeCode, typeLabel: t.label, letters: [], have: (t.meta.tagPrefixes ?? []).map((p) => p.toUpperCase()) };
    row.letters.push({ letter, count: n });
    out.set(typeCode, row);
  }
  return [...out.values()]
    .map((r) => ({ ...r, letters: r.letters.sort((a, b) => b.count - a.count) }))
    // Only types with a letter the codebook does not have yet.
    .filter((r) => r.letters.some((l) => !r.have.includes(l.letter)))
    .sort((a, b) => a.typeLabel.localeCompare(b.typeLabel));
}
