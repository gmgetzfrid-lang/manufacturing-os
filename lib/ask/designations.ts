// lib/ask/designations.ts — document numbers written in text, matched to
// the documents a library holds. Pure, so the engine and the answer tests
// read "does this line name a document we have?" the same way.

const DES = /\b[A-Za-z]{1,8}[- ]?\d+(?:[-.]\d+)*[A-Za-z]?\b/g;

const squash = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");

/** Designation-shaped tokens in a text ("EP 5-2-3", "B31.3", "STD-205"). */
export function designationsIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(DES)) {
    const sq = squash(m[0]);
    if (sq.length < 4 || !/\d/.test(sq) || !/[A-Z]/.test(sq)) continue;
    if (!out.includes(m[0])) out.push(m[0]);
  }
  return out;
}

/** Does a document's name carry this designation — as a whole number, so
 *  "EP 1-4" is not "EP 1-4-1" and "B31.3" is not "B31.31"? */
export function designationMatcher(des: string): RegExp {
  const parts = des.toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
  return new RegExp(`(^|[^A-Z0-9])${parts.join("[^A-Z0-9]*")}(?![0-9])(?![-.][0-9])`);
}

/** The documents (by name) a text names, in order, at most `limit`. */
export function docsNamedIn<T extends { name: string }>(text: string, docs: T[], limit: number): T[] {
  const out: T[] = [];
  for (const des of designationsIn(text)) {
    const re = designationMatcher(des);
    for (const d of docs) {
      if (out.length >= limit) return out;
      if (!out.includes(d) && re.test(d.name.toUpperCase())) out.push(d);
    }
  }
  return out;
}

const titleOf = (name: string) => name.replace(/\.[a-z0-9]{2,4}$/i, "").toLowerCase().replace(/[^a-z0-9()]+/g, " ").trim();

/** The documents a text names by TITLE — "E2G Piping Specs (All)" has no
 *  number to match on. Only distinctive titles count (two words or more,
 *  ten characters or more), so "Index" never matches everything. */
export function docsTitledIn<T extends { name: string }>(text: string, docs: T[], limit: number): T[] {
  const t = ` ${titleOf(text)} `;
  const out: T[] = [];
  for (const d of docs) {
    if (out.length >= limit) break;
    const title = titleOf(d.name);
    if (title.length < 10 || title.split(" ").length < 2) continue;
    if (t.includes(` ${title} `)) out.push(d);
  }
  return out;
}
