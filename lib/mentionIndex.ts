// lib/mentionIndex.ts — the Obsidian engine, for equipment tags.
//
// Obsidian's real trick isn't the pretty graph, it's that links are DERIVED
// FROM TEXT. Nobody files anything. You write "E-101" in a report and the
// report is now attached to the exchanger, forever, with the sentence you
// wrote as proof.
//
// This is that, for a refinery. Given a document's text and the org's
// equipment dictionary (tags + human aliases), it finds every real mention
// and returns the surrounding sentence with it. The sentence is the point:
// a link you can't interrogate is a link you won't trust, and an inspector
// who can't see WHY a drawing is attached to a vessel will go back to
// scrolling folders.
//
// Everything here is pure. No database, no network — so the matching rules
// that decide what your graph means are unit-testable, and they are tested.

/** One equipment identity the indexer knows how to spot. */
export interface AliasEntry {
  assetId: string;
  /** The literal string to look for — "E-101", "Crude Preheat Exchanger". */
  alias: string;
  /** Where it came from. Human aliases are trusted more than machine guesses. */
  origin: "tag" | "human" | "extraction" | "vision";
}

export interface Mention {
  assetId: string;
  /** Exactly the characters found in the document. */
  matchedText: string;
  /** The sentence around the hit — the evidence shown on the link. */
  snippet: string;
  /** Character offset of the match within the supplied text. */
  offset: number;
  /** 0–1. Drives whether a link is auto-drawn or queued for review. */
  confidence: number;
  origin: AliasEntry["origin"];
}

/** Longest snippet we keep. Long enough to carry a clause, short enough to
 *  read in a hover card without scrolling. */
const SNIPPET_MAX = 260;

/** Alphanumeric runs joined by separators — the shape of every equipment tag
 *  and nothing else. */
const RUNS_ONLY = /^[A-Za-z0-9]+(?:[\s\-_.]+[A-Za-z0-9]+)*$/;

/**
 * Is this alias a TAG rather than a phrase?
 *
 * A tag is runs of letters and digits in any order — "E-101", "21-D-1105",
 * "Pump 202". Tags are matched punctuation-blind because the same exchanger
 * is written five ways across one drawing set. Anchoring on "letters then
 * digits" was wrong: half of refinery tagging starts with the unit number.
 */
function isTagShaped(alias: string): boolean {
  const t = alias.trim();
  return RUNS_ONLY.test(t) && /[A-Za-z]/.test(t) && /\d/.test(t);
}

/** Aliases this short and this generic match half the English language.
 *  "E-1" inside "E-100" is the classic false positive; the digit lookahead
 *  below handles that, but a bare two-character alias is hopeless. */
const MIN_ALIAS_LENGTH = 3;

/** Words that look like tags but are units, standards, or boilerplate. A
 *  P&ID title block is full of them and every one is a false link. */
const STOP_ALIASES = new Set([
  "rev", "no", "dwg", "sht", "sheet", "of", "id", "od", "na", "n/a",
  "psi", "psig", "gpm", "deg", "min", "max", "typ", "ref", "nts",
]);

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build the search pattern for one alias.
 *
 * Tag-shaped aliases ("E-101") match punctuation-blind, because the same
 * exchanger is written five ways across a drawing set and all five mean the
 * exchanger. Everything else ("Crude Preheat Exchanger") matches as words
 * with flexible whitespace, because that's how prose varies.
 *
 * Both end in a guard against a longer identifier: E-101 must never match
 * inside E-1015, or a single typo silently rewires your plant.
 */
export function aliasPattern(alias: string): RegExp | null {
  const trimmed = alias.trim();
  if (trimmed.length < MIN_ALIAS_LENGTH) return null;
  if (STOP_ALIASES.has(trimmed.toLowerCase())) return null;

  if (isTagShaped(trimmed)) {
    // Split into runs of letters and runs of digits, joined by "any or no
    // separator". "21-D-1105" → 21 [sep] D [sep] 1105.
    const parts = trimmed.match(/[A-Za-z]+|\d+/g);
    if (!parts || parts.length < 2) return null;
    const body = parts.map(escapeRe).join("[\\s\\-_.]*");
    // Leading guard: not preceded by a word char or digit-with-separator.
    // Trailing guard: not followed by another digit or letter.
    return new RegExp(`(?<![A-Za-z0-9])${body}(?![A-Za-z0-9])`, "gi");
  }

  const words = trimmed.split(/\s+/).map(escapeRe);
  if (words.join("").length < MIN_ALIAS_LENGTH) return null;
  return new RegExp(`\\b${words.join("\\s+")}\\b`, "gi");
}

/**
 * How much we trust a hit, before any human touches it.
 *
 * Specificity comes from SHAPE, not length. "E101" is four characters and
 * completely unambiguous; "exchanger" is nine and matches half the plant.
 * Scoring by character count put ordinary tags below the auto-link line and
 * would have dumped a working plant map into the review queue.
 */
function confidenceFor(origin: AliasEntry["origin"], alias: string): number {
  const precise = isTagShaped(alias);
  switch (origin) {
    case "tag":        return precise ? 0.98 : 0.9;
    case "human":      return precise ? 0.95 : 0.88;
    case "extraction": return precise ? 0.75 : 0.6;
    case "vision":     return precise ? 0.7 : 0.55;
  }
}

/**
 * The sentence around a hit, trimmed to something readable.
 *
 * Sentence boundaries in drawing text are a fiction — there are no periods on
 * a P&ID, just newlines and pipe-delimited title-block cells. So we bound the
 * window by real sentence punctuation OR by line breaks, whichever is nearer,
 * and fall back to a character window when the text is one long run.
 */
export function snippetAround(text: string, offset: number, length: number): string {
  const HALF = Math.floor(SNIPPET_MAX / 2);
  const from = Math.max(0, offset - HALF);
  const to = Math.min(text.length, offset + length + HALF);
  let window = text.slice(from, to);
  let markStart = offset - from;

  // Prefer a clean left edge: the last sentence end or newline before the hit.
  const left = window.slice(0, markStart);
  const leftCut = Math.max(left.lastIndexOf(". "), left.lastIndexOf("\n"), left.lastIndexOf("| "));
  if (leftCut > 0 && markStart - leftCut < HALF) {
    window = window.slice(leftCut + 1);
    markStart -= leftCut + 1;
  }

  // And a clean right edge.
  const rightFrom = markStart + length;
  const right = window.slice(rightFrom);
  const rightCut = Math.min(
    ...[right.indexOf(". "), right.indexOf("\n"), right.indexOf(" | ")]
      .filter((i) => i > 0)
      .concat([right.length]),
  );
  window = window.slice(0, rightFrom + rightCut + 1);

  const clean = window.replace(/\s+/g, " ").trim();
  const prefix = from > 0 && !/^[A-Z0-9]/.test(clean) ? "…" : "";
  const suffix = to < text.length && clean.length >= SNIPPET_MAX - 2 ? "…" : "";
  return `${prefix}${clean.slice(0, SNIPPET_MAX)}${suffix}`;
}

/**
 * Find every equipment mention in one block of text.
 *
 * Deduplicated per (asset, offset) so an asset with four aliases that all hit
 * the same characters produces one mention, not four — and the winner is the
 * most trustworthy alias, not whichever happened to be scanned first.
 */
export function findMentions(text: string, dictionary: AliasEntry[]): Mention[] {
  if (!text || dictionary.length === 0) return [];
  // Keyed by asset+offset: the same characters can only mean one thing.
  const best = new Map<string, Mention>();

  for (const entry of dictionary) {
    const re = aliasPattern(entry.alias);
    if (!re) continue;
    const confidence = confidenceFor(entry.origin, entry.alias);
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      // Zero-length matches would spin forever.
      if (m[0].length === 0) { re.lastIndex += 1; continue; }
      const key = `${entry.assetId}@${m.index}`;
      const existing = best.get(key);
      if (existing && existing.confidence >= confidence) continue;
      best.set(key, {
        assetId: entry.assetId,
        matchedText: m[0],
        snippet: snippetAround(text, m.index, m[0].length),
        offset: m.index,
        confidence,
        origin: entry.origin,
      });
    }
  }

  return [...best.values()].sort((a, b) => a.offset - b.offset);
}

/**
 * Collapse a page's worth of mentions to one row per asset.
 *
 * A standard that names E-101 forty times is not forty links. It's one link
 * whose strength is forty — and the evidence you show is the FIRST clean
 * sentence, because that's nearly always the defining one ("E-101, Crude
 * Preheat Exchanger, shell side…") rather than the fortieth table row.
 */
export interface AssetMentionSummary {
  assetId: string;
  count: number;
  snippet: string;
  matchedText: string;
  confidence: number;
  origin: AliasEntry["origin"];
}

export function summarizeByAsset(mentions: Mention[]): AssetMentionSummary[] {
  const byAsset = new Map<string, AssetMentionSummary>();
  for (const m of mentions) {
    const prior = byAsset.get(m.assetId);
    if (!prior) {
      byAsset.set(m.assetId, {
        assetId: m.assetId, count: 1, snippet: m.snippet,
        matchedText: m.matchedText, confidence: m.confidence, origin: m.origin,
      });
      continue;
    }
    prior.count += 1;
    // Keep the strongest evidence, and prefer a sentence with actual prose
    // over a bare table cell of the same confidence.
    const better = m.confidence > prior.confidence
      || (m.confidence === prior.confidence && wordCount(m.snippet) > wordCount(prior.snippet) && wordCount(prior.snippet) < 6);
    if (better) {
      prior.snippet = m.snippet;
      prior.matchedText = m.matchedText;
      prior.confidence = m.confidence;
      prior.origin = m.origin;
    }
  }
  // Most-mentioned first: that ordering is what makes a hub look like a hub.
  return [...byAsset.values()].sort((a, b) => b.count - a.count);
}

function wordCount(s: string): number {
  return s.split(/\s+/).filter(Boolean).length;
}

/** Mentions at or above this confidence become real edges without review.
 *  Below it they're proposals — the AI boundary stays visible. */
export const AUTO_LINK_CONFIDENCE = 0.9;
