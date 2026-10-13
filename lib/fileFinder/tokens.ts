// lib/fileFinder/tokens.ts — words, years and stopwords, shared by the query
// parser and the index builder so both sides cut text the same way. A word
// that the indexer keeps but the parser drops (or vice versa) can never match.

const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "of", "for", "in", "on", "at", "to", "from", "by", "with",
  "i", "we", "me", "my", "our", "you", "it", "its", "is", "are", "was", "be",
  "want", "need", "find", "get", "show", "looking", "look", "search", "please",
  "file", "files", "doc", "docs", "document", "documents", "drawing", "drawings",
  "pdf", "dwg", "xlsx", "docx", "copy", "final", "new", "old",
]);

export function isStopword(w: string): boolean { return STOPWORDS.has(w); }

/** The lightest possible stemming: "heaters" and "heater", "valves" and
 *  "valve" are one word. Nothing cleverer — a real stemmer would merge
 *  "crude" and "crudes" fine but also do surprising things to tag-like words. */
export function stem(w: string): string {
  if (w.length >= 5 && w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (w.length >= 5 && w.endsWith("es") && /[sxz]es$|[cs]hes$/.test(w)) return w.slice(0, -2);
  if (w.length >= 4 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

/** Lowercase alphabetic words, 2+ letters, stopwords removed, lightly
 *  stemmed. Digits-only tokens are not words (years and identifiers are
 *  handled separately). */
export function words(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/[^a-z0-9&]+/)) {
    if (!raw) continue;
    const w = raw.replace(/&/g, "and");
    if (w.length < 2) continue;
    if (/^\d+$/.test(w)) continue;
    if (isStopword(w)) continue;
    out.push(stem(w));
  }
  return out;
}

/** Adjacent word pairs — "pilot valve", "born heater". A phrase hit is worth
 *  more than two separate word hits because it is far less likely by chance. */
export function bigrams(ws: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i + 1 < ws.length; i++) out.push(`${ws[i]} ${ws[i + 1]}`);
  return out;
}

const YEAR_MIN = 1980;
const YEAR_MAX = 2039;

/** Every plausible year in a piece of text: bare 4-digit years, and the year
 *  inside dates written 2019-01-15, 01-15-2019, 01/15/19, 2019_01_15. */
export function years(text: string): number[] {
  const out = new Set<number>();
  const add = (y: number) => { if (y >= YEAR_MIN && y <= YEAR_MAX) out.add(y); };
  for (const m of text.matchAll(/(?<![0-9])((?:19|20)\d{2})(?![0-9])/g)) add(Number(m[1]));
  // dd-mm-yy / mm-dd-yy with a two-digit year, only when it is clearly a date.
  for (const m of text.matchAll(/(?<![0-9])\d{1,2}[-/._]\d{1,2}[-/._](\d{2})(?![0-9])/g)) {
    const yy = Number(m[1]);
    add(yy >= 80 ? 1900 + yy : 2000 + yy);
  }
  return [...out].sort();
}

/** First year from an ISO-ish date string, or undefined. */
export function yearOf(date: string | null | undefined): number | undefined {
  if (!date) return undefined;
  const m = date.match(/^(\d{4})/);
  if (!m) return undefined;
  const y = Number(m[1]);
  return y >= YEAR_MIN && y <= YEAR_MAX ? y : undefined;
}
