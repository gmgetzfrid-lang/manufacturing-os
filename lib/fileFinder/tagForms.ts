// lib/fileFinder/tagForms.ts — one identity for every way a tag gets typed.
//
// Equipment tags, AFE numbers, drawing numbers and unit codes all arrive in
// a dozen spellings: U1-A, U1A, U-1A, u 1 a, U-1-A. The Site Codebook's
// normalizeTag keeps a display dash, which makes "U1-A" and "U1A" two
// different strings. Matching needs something blunter: strip everything that
// isn't a letter or digit and compare what's left. Display can keep the dash;
// matching never sees it.

/** "U1-A" / "u 1a" / "U-1-A" → "U1A". */
export function canonicalForm(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[‐-―−]/g, "-")
    .replace(/[^A-Z0-9]/g, "");
}

/** Split a canonical form into letters / digits / trailing letters, or null
 *  when it isn't shaped like an identifier (needs letters AND digits). */
export function splitCanonical(canon: string): { prefix: string; digits: string; suffix: string } | null {
  // Suffix is letters only, at most two: U1A, P101A, E22AB. Digits in a suffix
  // mean two things got glued together ("U1A" + "R7"), never one identifier.
  const m = canon.match(/^([A-Z]{1,6})(\d{1,8})([A-Z]{0,2})$/);
  if (!m) return null;
  return { prefix: m[1], digits: m[2], suffix: m[3] };
}

/** The spellings a person might have used for one canonical identifier —
 *  for showing "also matches U1A, U-1A, U-1-A" and for building text queries. */
export function tagVariants(canon: string): string[] {
  const parts = splitCanonical(canon);
  if (!parts) return [canon];
  const { prefix, digits, suffix } = parts;
  const out = new Set<string>([canon]);
  out.add(`${prefix}-${digits}${suffix}`);
  if (suffix) {
    out.add(`${prefix}${digits}-${suffix}`);
    out.add(`${prefix}-${digits}-${suffix}`);
  }
  return [...out];
}

// Tokens that look like tags but are document plumbing, not things.
const NOT_IDENTIFIERS = new Set([
  "REV", "R", "SHT", "SH", "SHEET", "PG", "PAGE", "NO", "FIG", "SEC", "ITEM",
  "VER", "V0", "COPY", "DRAFT", "FINAL", "OLD", "NEW",
]);

/** Does this single token look like an identifier (letters + digits)? */
export function looksLikeIdentifier(token: string): boolean {
  const canon = canonicalForm(token);
  const parts = splitCanonical(canon);
  if (!parts) return false;
  if (NOT_IDENTIFIERS.has(parts.prefix)) return false;
  // "R7" / "V2" style revision stubs: one letter, one digit, no suffix.
  if (parts.prefix.length === 1 && parts.digits.length === 1 && !parts.suffix && /^[RV]$/.test(parts.prefix)) return false;
  return true;
}

/** Every identifier-shaped token in a piece of text, canonical, de-duplicated.
 *
 *  Tokens split on whitespace and path punctuation, then on dashes,
 *  underscores and dots into pieces. Pieces are tried as runs of up to three
 *  (longest first), so "U1-A" and "U-1-A" become one identifier "U1A" rather
 *  than "U1" plus "A", while "born-u1a" stays "U1A" because a four-letter
 *  word is never a tag prefix — only a glued run with a short alphabetic
 *  head ("E-101", "AFE-200155", "PSV-2001A") is read as one identifier. */
export function findIdentifiers(text: string): string[] {
  const out = new Set<string>();
  const tokens = text.split(/[\s,;:/\\()[\]{}"'|<>]+/).filter(Boolean);
  for (const t of tokens) {
    const bare = t.replace(/\.[A-Za-z0-9]{1,5}$/, "");
    const pieces = bare.split(/[-_.\s]+/).filter(Boolean);
    let i = 0;
    while (i < pieces.length) {
      let taken = 0;
      for (let len = Math.min(3, pieces.length - i); len >= 1; len--) {
        const run = pieces.slice(i, i + len);
        if (len > 1) {
          const head = run[0];
          // A glued run needs a short alphabetic head or an alnum head: "E"-"101",
          // "U1"-"A", "AFE"-"200155". "born"-"u1a" is a word and a tag, not one tag.
          if (/^[A-Za-z]+$/.test(head) && head.length > 3) continue;
          if (!/^[A-Za-z]/.test(head)) continue;
        }
        const joined = run.join("");
        if (looksLikeIdentifier(joined)) { out.add(canonicalForm(joined)); taken = len; break; }
      }
      i += taken || 1;
    }
  }
  return [...out];
}

/** Is `needle` a looser form of `hay`? "U1" is a prefix of "U1A"; "U1A" is
 *  not a prefix of "U1". Same prefix letters required so "E1" ≠ "EA1". */
export function isLooserIdentifier(needle: string, hay: string): boolean {
  if (needle === hay) return false;
  const a = splitCanonical(needle), b = splitCanonical(hay);
  if (!a || !b) return false;
  return a.prefix === b.prefix && a.digits === b.digits && !a.suffix && !!b.suffix;
}
