// lib/titleBlockHeuristics.ts
//
// The PURE half of the title-block reader — text in, guess out. Split from
// lib/titleBlock.ts so it unit-tests without the pdf.js browser runtime.

export interface TitleBlockGuess {
  docNumber?: string;
  rev?: string;
  /** 0..1 — how strongly the text supported the guess. */
  confidence: number;
}

// Keywords that title blocks put next to the drawing number / revision.
const NUMBER_KEYWORDS = /\b(?:DWG|DRAWING|DOC(?:UMENT)?|SHEET)\s*(?:NO|NUMBER|#|№)?\b[.:\s]*/i;
const REV_PATTERN = /\bREV(?:ISION)?\b[.:\s]*([A-Z]{1,2}\d{0,2}|\d{1,3})\b/i;
// A drawing-number-shaped token: letters+digits with separators, must
// contain at least one digit, 4–24 chars. Excludes pure words and dates.
const NUMBER_TOKEN = /\b([A-Z]{1,6}[-–_][A-Z0-9]{1,8}(?:[-–_][A-Z0-9]{1,8}){0,3}|[A-Z]{1,4}\d{2,6}[A-Z]?)\b/g;

export function guessFromText(rawText: string): TitleBlockGuess {
  const text = rawText.toUpperCase();
  const out: TitleBlockGuess = { confidence: 0 };

  // Revision: the labeled form is trustworthy.
  const revMatch = text.match(REV_PATTERN);
  if (revMatch) {
    out.rev = revMatch[1];
    out.confidence += 0.35;
  }

  // Drawing number: prefer a token right after a number keyword; fall back
  // to the most drawing-number-shaped token in the text.
  const kw = text.match(NUMBER_KEYWORDS);
  if (kw && kw.index !== undefined) {
    const after = text.slice(kw.index + kw[0].length, kw.index + kw[0].length + 40);
    const m = after.match(NUMBER_TOKEN);
    const candidate = m?.find((t) => /\d/.test(t));
    if (candidate) {
      out.docNumber = candidate;
      out.confidence += 0.55;
      return out;
    }
  }
  const all = [...text.matchAll(NUMBER_TOKEN)].map((m) => m[1]).filter((t) => /\d/.test(t));
  if (all.length > 0) {
    // Frequency wins: the drawing number repeats (title block + border) more
    // often than incidental tags.
    const freq = new Map<string, number>();
    for (const t of all) freq.set(t, (freq.get(t) ?? 0) + 1);
    const [best, count] = [...freq.entries()].sort((a, b) => b[1] - a[1])[0];
    out.docNumber = best;
    out.confidence += count > 1 ? 0.35 : 0.15;
  }
  return out;
}
