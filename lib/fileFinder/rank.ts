// lib/fileFinder/rank.ts — scoring the way a careful person would, out loud.
//
// Every point added or taken away is a named piece of evidence on the result,
// so "why is this first?" and "why is that buried?" are always answerable.
//
// A person who has never seen this estate doesn't stop at exact matches.
// They typed "10-1-15" and the file says "EP10-1-15": that's the one, they
// just left the prefix off. They typed "heatr": that's "heater". They typed
// "P-101" and the folder has "F-101": same number, renumbered prefix, worth
// a look. So every code and word is matched in TIERS — exact, contained,
// close — and a looser tier still places, with the evidence saying exactly
// how loose it was. Nothing comes back empty while something is near.
//
// Negative evidence is where it starts to behave like a human: a folder that
// names a different unit, a zero-byte file, a date two years off, a
// superseded status. None of these is a hard filter except the two that make
// a file useless (empty bytes, OS junk) — everything else lowers a score and
// tells you.

import type { IndexEntry } from "./fileIndex";
import type { ParsedQuery, UnitLike, QueryChip } from "./queryParse";
import { wordNamesUnit } from "./queryParse";
import { digitsOf, tagVariants, splitCanonical } from "./tagForms";
import { isClose } from "./fuzzy";

export interface Evidence {
  kind: "identifier" | "word" | "phrase" | "unit" | "year" | "size" | "junk" | "status" | "duplicate" | "source";
  /** Human sentence: "Folder says Transmix, a different unit". */
  label: string;
  delta: number;
  /** exact, or how loose the match was. Drives the result card's wording. */
  tier?: "exact" | "contains" | "within" | "close" | "number";
}

export type Verdict = "strong" | "possible" | "weak" | "rejected";

export interface RankedHit {
  entry: IndexEntry;
  score: number;
  verdict: Verdict;
  evidence: Evidence[];
  /** Other entries with identical bytes, for "also in N places". */
  sameBytes: IndexEntry[];
}

const W = {
  codeExactName: 55, codeExactPath: 30,
  codeContainsName: 35, codeContainsPath: 20,
  codeWithinName: 25, codeWithinPath: 14,
  codeCloseName: 20, codeClosePath: 10,
  codeNumberName: 12, codeNumberPath: 6,
  phraseName: 22, phrasePath: 12,
  wordName: 12, wordPath: 8, wordLoose: 7, wordLoosePath: 4,
  unitHit: 20, unitOther: -30,
  yearHit: 15, yearOff1: -5, yearOff2: -12, yearOffMore: -20,
  emptyFile: -60, junk: -50, superseded: -15,
};

const JUNK = /^(thumbs\.db|desktop\.ini|\.ds_store|~\$.*|.*\.(tmp|bak|lnk|crdownload|part))$/i;

export const STRONG_AT = 50;
export const POSSIBLE_AT = 20;

const pretty = (canon: string) => tagVariants(canon)[1] ?? canon;

const isDigit = (ch: string) => ch >= "0" && ch <= "9";

/** Does `q` sit inside `h` on letter/digit boundaries? "10115" inside
 *  "EP10115" (after the P) yes; "P101" inside "EP10115" no — that would be
 *  cutting a code mid-run, which no person reads as a match. */
function containsOnBoundary(h: string, q: string): boolean {
  let from = 0;
  while (from <= h.length - q.length) {
    const i = h.indexOf(q, from);
    if (i < 0) return false;
    const before = i === 0 || isDigit(h[i - 1]) !== isDigit(q[0]);
    const end = i + q.length;
    const after = end === h.length || isDigit(h[end]) !== isDigit(q[q.length - 1]);
    if (before && after) return true;
    from = i + 1;
  }
  return false;
}

/** Best match tier for one query code against one set of entry codes (plus
 *  the whole canonical name, for when extraction cut differently). */
function matchCode(q: string, hay: string[], nameCanon: string): { tier: Evidence["tier"]; against: string; detail: string } | null {
  const pool = nameCanon ? [...hay, nameCanon] : hay;
  if (hay.includes(q)) return { tier: "exact", against: q, detail: "" };
  // Contained: "10115" inside "EP10115" — they left a prefix (or suffix) off.
  let best: { tier: Evidence["tier"]; against: string; detail: string } | null = null;
  if (q.length >= 3) {
    for (const h of pool) {
      if (h.length > q.length && containsOnBoundary(h, q)) {
        const missing = h.startsWith(q) ? `the ${pretty(h.slice(q.length))} at the end` : h.endsWith(q) ? `the ${h.slice(0, h.length - q.length)} prefix` : "part of it";
        const cand = { tier: "contains" as const, against: h, detail: `missing ${missing}` };
        if (!best || h.length < best.against.length) best = cand;
      }
    }
    if (best) return best;
  }
  // Within: they typed more than the file has ("EP10-1-15A" vs "EP10-1-15").
  for (const h of hay) {
    if (h.length >= 3 && q.length > h.length && containsOnBoundary(q, h)) {
      const cand = { tier: "within" as const, against: h, detail: "the file has less of it" };
      if (!best || h.length > best.against.length) best = cand;
    }
  }
  if (best) return best;
  // Close: a typo or transposition away.
  for (const h of hay) {
    const c = isClose(q, h);
    if (c.close) {
      const cand = { tier: "close" as const, against: h, detail: `${c.edits} character${c.edits === 1 ? "" : "s"} off` };
      if (!best || c.edits < Number(best.detail[0])) best = cand;
    }
  }
  if (best) return best;
  // Same number, different prefix: F-101 vs P-101 — renumbered or mistyped type letter.
  const qd = digitsOf(q);
  if (qd.length >= 3 && splitCanonical(q)) {
    for (const h of hay) {
      if (h !== q && splitCanonical(h) && digitsOf(h) === qd) return { tier: "number", against: h, detail: "same number, different prefix" };
    }
  }
  return null;
}

/** Best match tier for one query word against entry words. */
function matchWord(w: string, hay: string[], nameCanon: string): { tier: "exact" | "close"; against: string; detail: string } | null {
  if (hay.includes(w)) return { tier: "exact", against: w, detail: "" };
  for (const h of hay) {
    if (w.length >= 4 && h.length >= 4 && (h.startsWith(w) || w.startsWith(h))) return { tier: "close", against: h, detail: "starts the same" };
  }
  for (const h of hay) {
    const c = isClose(w, h);
    if (c.close) return { tier: "close", against: h, detail: `${c.edits} letter${c.edits === 1 ? "" : "s"} off` };
  }
  if (w.length >= 4 && nameCanon.includes(w.toUpperCase())) return { tier: "close", against: w, detail: "inside the name" };
  return null;
}

export function rankEntries(
  entries: IndexEntry[],
  q: ParsedQuery,
  ctx: { units?: UnitLike[]; sameBytes?: Map<string, IndexEntry[]> } = {},
): RankedHit[] {
  const units = ctx.units ?? [];
  const out: RankedHit[] = [];
  const via = (c: QueryChip) => (c.via === "alias" ? " (via alias)" : c.via === "codebook" ? " (codebook)" : "");
  const scale = (c: QueryChip) => c.confidence;

  for (const e of entries) {
    const ev: Evidence[] = [];
    const nameCodes = [...e.idents, ...(e.numberCanon ? [e.numberCanon] : [])];

    // Codes: best tier in the name beats any tier in the folder chain.
    for (const c of q.identifiers) {
      const inName = matchCode(c.value, nameCodes, e.nameCanon);
      const inPath = inName ? null : matchCode(c.value, e.pathIdents, "");
      const m = inName ?? inPath;
      if (!m) continue;
      const where = inName ? "Name" : "Folder";
      const tierW = {
        exact: inName ? W.codeExactName : W.codeExactPath,
        contains: inName ? W.codeContainsName : W.codeContainsPath,
        within: inName ? W.codeWithinName : W.codeWithinPath,
        close: inName ? W.codeCloseName : W.codeClosePath,
        number: inName ? W.codeNumberName : W.codeNumberPath,
      }[m.tier ?? "exact"];
      const label =
        m.tier === "exact" ? `${where} says ${c.label}${via(c)}`
        : m.tier === "contains" ? `${where} says ${pretty(m.against)}, which contains ${c.label} (${m.detail})`
        : m.tier === "within" ? `${where} says ${pretty(m.against)}, part of ${c.label}`
        : m.tier === "close" ? `${where} says ${pretty(m.against)}, close to ${c.label} (${m.detail})`
        : `${where} says ${pretty(m.against)}: ${m.detail} from ${c.label}`;
      ev.push({ kind: "identifier", label, delta: tierW * scale(c), tier: m.tier });
    }

    // Phrases first, then words that weren't already covered by a phrase hit.
    const covered = new Set<string>();
    const text = e.words.join(" ");
    const pathText = e.pathWords.join(" ");
    for (const c of q.phrases) {
      if (text.includes(c.value)) {
        ev.push({ kind: "phrase", label: `Name says ${c.label}${via(c)}`, delta: W.phraseName * scale(c), tier: "exact" });
        c.value.split(" ").forEach((w) => covered.add(w));
      } else if (pathText.includes(c.value)) {
        ev.push({ kind: "phrase", label: `Folder says ${c.label}${via(c)}`, delta: W.phrasePath * scale(c), tier: "exact" });
        c.value.split(" ").forEach((w) => covered.add(w));
      }
    }
    for (const c of q.words) {
      if (covered.has(c.value)) continue;
      const inName = matchWord(c.value, e.words, e.nameCanon);
      const inPath = inName ? null : matchWord(c.value, e.pathWords, "");
      const m = inName ?? inPath;
      if (!m) continue;
      const where = inName ? "Name" : "Folder";
      if (m.tier === "exact") {
        ev.push({ kind: "word", label: `${where} says "${c.value}"${via(c)}`, delta: (inName ? W.wordName : W.wordPath) * scale(c), tier: "exact" });
      } else {
        ev.push({ kind: "word", label: `${where} says "${m.against}", close to "${c.value}" (${m.detail})${via(c)}`, delta: (inName ? W.wordLoose : W.wordLoosePath) * scale(c), tier: "close" });
      }
    }

    // Units: the one asked for is a plus; any OTHER codebook unit named in the
    // folder chain is a minus. "Transmix" is not where a crude heater lives.
    if (q.units.length && units.length) {
      const asked = new Set(q.units.map((u) => u.value));
      const named = new Set<string>();
      for (const w of [...e.pathWords, ...e.words]) {
        for (const u of units) if (wordNamesUnit(w, u)) named.add(u.code);
      }
      for (const code of named) {
        const u = units.find((x) => x.code === code)!;
        if (asked.has(code)) {
          const chip = q.units.find((c) => c.value === code)!;
          ev.push({ kind: "unit", label: `Lives under ${u.label}${via(chip)}`, delta: W.unitHit * scale(chip) });
        } else {
          ev.push({ kind: "unit", label: `Folder says ${u.label}, a different unit`, delta: W.unitOther });
        }
      }
    }

    // A candidate has to match something the user actually named — a code, a
    // word or a phrase, exactly or loosely. Being in the right unit's folder
    // is support for a match, never a match on its own.
    const positive = ev.filter((x) => x.delta > 0 && (x.kind === "identifier" || x.kind === "word" || x.kind === "phrase"))
      .reduce((s, x) => s + x.delta, 0);
    if (positive <= 0) continue;

    // Years: soft. Late uploads are common, so a one-year miss is a nudge.
    if (q.years.length) {
      const asked = q.years.map((c) => Number(c.value));
      const conf = Math.max(...q.years.map((c) => c.confidence));
      if (e.years.length) {
        let best = Infinity, bestYear = e.years[0];
        for (const y of e.years) for (const a of asked) { const d = Math.abs(y - a); if (d < best) { best = d; bestYear = y; } }
        if (best === 0) ev.push({ kind: "year", label: `Dated ${bestYear}`, delta: W.yearHit * conf });
        else if (best === 1) ev.push({ kind: "year", label: `Dated ${bestYear}, one year off (late upload?)`, delta: W.yearOff1 * conf });
        else if (best === 2) ev.push({ kind: "year", label: `Dated ${bestYear}, two years off`, delta: W.yearOff2 * conf });
        else ev.push({ kind: "year", label: `Dated ${bestYear}, ${best} years off`, delta: W.yearOffMore * conf });
      } else if (e.uploadYear) {
        ev.push({ kind: "year", label: `No date on the file; uploaded ${e.uploadYear}`, delta: 0 });
      }
    }

    // Dead files.
    let rejected = false;
    if (e.sizeBytes === 0) { ev.push({ kind: "size", label: "0 KB — empty file", delta: W.emptyFile }); rejected = true; }
    if (JUNK.test(e.name)) { ev.push({ kind: "junk", label: "OS or temp junk", delta: W.junk }); rejected = true; }
    if (e.status && /^(superseded|void|archived)$/i.test(e.status)) {
      ev.push({ kind: "status", label: `Status ${e.status}`, delta: W.superseded });
    }

    const same = (e.hash && ctx.sameBytes?.get(e.hash)?.filter((x) => x.id !== e.id)) || [];
    if (same.length) ev.push({ kind: "duplicate", label: `Same bytes in ${same.length + 1} places`, delta: 0 });
    if (e.source === "listing") ev.push({ kind: "source", label: `Listed on ${e.listingName}, not in the system`, delta: 0 });

    const score = Math.round(ev.reduce((s, x) => s + x.delta, 0));
    const verdict: Verdict = rejected ? "rejected" : score >= STRONG_AT ? "strong" : score >= POSSIBLE_AT ? "possible" : "weak";
    out.push({ entry: e, score, verdict, evidence: ev, sameBytes: same });
  }

  const order: Record<Verdict, number> = { strong: 0, possible: 1, weak: 2, rejected: 3 };
  return out.sort((a, b) => order[a.verdict] - order[b.verdict] || b.score - a.score || a.entry.name.localeCompare(b.entry.name));
}
