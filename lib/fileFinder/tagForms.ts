// lib/fileFinder/tagForms.ts — one identity for every way a code gets typed.
//
// Equipment tags, AFE numbers, drawing numbers, unit codes, line numbers:
// they all arrive in a dozen spellings. U1-A, U1A, U-1A, u 1 a, U-1-A.
// EP10-1-15, EP10.1.15, ep10_1_15. The Site Codebook's normalizeTag keeps a
// display dash, which makes "U1-A" and "U1A" two different strings.
// Matching needs something blunter: strip everything that isn't a letter or
// digit and compare what's left. Display can keep the dashes; matching
// never sees them.
//
// A CODE here is any token with a digit in it that isn't document plumbing
// (a revision stub, a sheet number) or a bare year. That is deliberately
// wide: "10-1-15" with the EP left off is still a code, and the ranker's job
// is to notice it sits inside "EP10-1-15".

/** "U1-A" / "u 1a" / "U-1-A" → "U1A". "EP10-1-15" → "EP10115". */
export function canonicalForm(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[‐-―−]/g, "-")
    .replace(/[^A-Z0-9]/g, "");
}

/** Split a letter-led canonical form into letters / digits / trailing
 *  letters, or null when it isn't shaped like a tag. Suffix is letters only,
 *  at most two (U1A, P101A, E22AB): digits in a suffix mean two things got
 *  glued together. */
export function splitCanonical(canon: string): { prefix: string; digits: string; suffix: string } | null {
  const m = canon.match(/^([A-Z]{1,6})(\d{1,8})([A-Z]{0,2})$/);
  if (!m) return null;
  return { prefix: m[1], digits: m[2], suffix: m[3] };
}

/** The spellings a person might have used for one canonical tag — for
 *  showing "also matches U1A, U-1A, U-1-A" and for building text queries. */
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

// Tokens that look like codes but are document plumbing, not things.
const PLUMBING = new Set([
  "REV", "R", "SHT", "SH", "SHEET", "PG", "PAGE", "NO", "FIG", "SEC", "ITEM",
  "VER", "V", "COPY", "DRAFT", "FINAL", "OLD", "NEW",
]);

/** A revision/sheet/page stub: R7, REV3, RevA, SHT01, PG2, V2. */
export function isPlumbing(piece: string): boolean {
  const m = canonicalForm(piece).match(/^([A-Z]+)(\d{0,4}[A-Z]?)$/);
  if (!m) return false;
  return PLUMBING.has(m[1]);
}

const isYear = (canon: string) => /^(19|20)\d{2}$/.test(canon);

/** Does this canonical token count as a code? Must carry a digit, must not
 *  be a bare year or a revision stub, and a pure-digit run needs 3+ digits so
 *  "15" on its own doesn't match half the estate. */
export function looksLikeCode(canon: string): boolean {
  if (canon.length < 2 || canon.length > 24) return false;
  if (!/\d/.test(canon)) return false;
  if (isYear(canon)) return false;
  if (/^\d+$/.test(canon) && canon.length < 3) return false;
  if (isPlumbing(canon)) return false;
  return true;
}

/** Back-compat name: a letter-led code shaped like an equipment tag. */
export function looksLikeIdentifier(token: string): boolean {
  const canon = canonicalForm(token);
  return looksLikeCode(canon) && !!splitCanonical(canon);
}

export interface FoundCode {
  canon: string;
  /** How it was written where it was found: "EP10-1-15", "U1-A". */
  raw: string;
}

/** Every code in a piece of text, canonical plus the spelling it was found in.
 *
 *  Tokens split on whitespace and path punctuation, then on dashes,
 *  underscores and dots into pieces. Pieces are tried as runs of up to three
 *  (longest first), so "U1-A", "U-1-A", "EP10-1-15" and "10-1-15" each become
 *  ONE code rather than fragments. A run may start with a digit ("10-1-15",
 *  "100-PID-001") or a short alphabetic head ("E-101", "AFE-200155",
 *  "PSV-2001A"); a four-letter word never heads a run, so "born-u1a" is a
 *  word plus a code, not one code. A revision stub ends any run. */
export function findCodes(text: string): FoundCode[] {
  const out = new Map<string, FoundCode>();
  const tokens = text.split(/[\s,;:/\\()[\]{}"'|<>]+/).filter(Boolean);
  for (const t of tokens) {
    const bare = t.replace(/\.[A-Za-z0-9]{1,5}$/, "");
    const pieces = bare.split(/[-_.\s]+/).filter(Boolean);
    let i = 0;
    while (i < pieces.length) {
      let taken = 0;
      for (let len = Math.min(3, pieces.length - i); len >= 1; len--) {
        const run = pieces.slice(i, i + len);
        if (run.some(isPlumbing)) continue;
        if (len > 1) {
          const head = run[0];
          if (/^[A-Za-z]+$/.test(head) && head.length > 3) continue;
          // A run must not swallow a plain word at its tail either ("U1A-heater").
          const tail = run[run.length - 1];
          if (/^[A-Za-z]+$/.test(tail) && tail.length > 2) continue;
        }
        const canon = canonicalForm(run.join(""));
        if (looksLikeCode(canon)) {
          if (!out.has(canon)) out.set(canon, { canon, raw: run.join("-") });
          taken = len;
          break;
        }
      }
      i += taken || 1;
    }
  }
  return [...out.values()];
}

/** Canonical codes only. */
export function findIdentifiers(text: string): string[] {
  return findCodes(text).map((c) => c.canon);
}

/** Is `needle` a looser form of `hay`? "U1" is a prefix of "U1A"; "U1A" is
 *  not a prefix of "U1". Same prefix letters required so "E1" ≠ "EA1". */
export function isLooserIdentifier(needle: string, hay: string): boolean {
  if (needle === hay) return false;
  const a = splitCanonical(needle), b = splitCanonical(hay);
  if (!a || !b) return false;
  return a.prefix === b.prefix && a.digits === b.digits && !a.suffix && !!b.suffix;
}

/** Just the digits: "EP10115" → "10115". For "same number, different prefix". */
export const digitsOf = (canon: string) => canon.replace(/[^0-9]/g, "");
