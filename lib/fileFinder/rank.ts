// lib/fileFinder/rank.ts — scoring the way a careful person would, out loud.
//
// Every point added or taken away is a named piece of evidence on the result,
// so "why is this first?" and "why is that buried?" are always answerable.
// Positive evidence says the file is probably what was asked for. Negative
// evidence is where it starts to behave like a human: a folder that names a
// different unit, a zero-byte file, a date two years off, a superseded
// status. None of these is a hard filter except the two that make a file
// useless (empty bytes, OS junk) — everything else lowers a score and tells you.

import type { IndexEntry } from "./fileIndex";
import type { ParsedQuery, UnitLike, QueryChip } from "./queryParse";
import { wordNamesUnit } from "./queryParse";
import { isLooserIdentifier } from "./tagForms";

export interface Evidence {
  kind: "identifier" | "word" | "phrase" | "unit" | "year" | "size" | "junk" | "status" | "duplicate" | "source";
  /** Human sentence: "Folder says Transmix, a different unit". */
  label: string;
  delta: number;
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
  identName: 40, identPath: 25, identLoose: 15,
  phraseName: 22, phrasePath: 12,
  wordName: 12, wordPath: 8,
  unitHit: 20, unitOther: -30,
  yearHit: 15, yearOff1: -5, yearOff2: -12, yearOffMore: -20,
  emptyFile: -60, junk: -50, superseded: -15,
};

const JUNK = /^(thumbs\.db|desktop\.ini|\.ds_store|~\$.*|.*\.(tmp|bak|lnk|crdownload|part))$/i;

export const STRONG_AT = 60;
export const POSSIBLE_AT = 25;

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
    let positive = 0;

    // Identifiers.
    for (const c of q.identifiers) {
      if (e.idents.includes(c.value)) {
        ev.push({ kind: "identifier", label: `Name says ${c.label}${via(c)}`, delta: W.identName * scale(c) });
      } else if (e.pathIdents.includes(c.value)) {
        ev.push({ kind: "identifier", label: `Folder says ${c.label}${via(c)}`, delta: W.identPath * scale(c) });
      } else {
        const loose = [...e.idents, ...e.pathIdents].find((h) => isLooserIdentifier(c.value, h) || isLooserIdentifier(h, c.value));
        if (loose) ev.push({ kind: "identifier", label: `${c.label} is a looser match for ${loose}`, delta: W.identLoose * scale(c) });
      }
    }

    // Phrases first, then words that weren't already covered by a phrase hit.
    const covered = new Set<string>();
    const text = e.words.join(" ");
    const pathText = e.pathWords.join(" ");
    for (const c of q.phrases) {
      if (text.includes(c.value)) {
        ev.push({ kind: "phrase", label: `Name says ${c.label}${via(c)}`, delta: W.phraseName * scale(c) });
        c.value.split(" ").forEach((w) => covered.add(w));
      } else if (pathText.includes(c.value)) {
        ev.push({ kind: "phrase", label: `Folder says ${c.label}${via(c)}`, delta: W.phrasePath * scale(c) });
        c.value.split(" ").forEach((w) => covered.add(w));
      }
    }
    for (const c of q.words) {
      if (covered.has(c.value)) continue;
      if (e.words.includes(c.value)) ev.push({ kind: "word", label: `Name says "${c.value}"${via(c)}`, delta: W.wordName * scale(c) });
      else if (e.pathWords.includes(c.value)) ev.push({ kind: "word", label: `Folder says "${c.value}"${via(c)}`, delta: W.wordPath * scale(c) });
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

    // A candidate has to match something the user actually named — an
    // identifier, a word or a phrase. Being in the right unit's folder is
    // support for a match, never a match on its own, or every file under
    // "Crude" would come back for every crude question.
    positive = ev.filter((x) => x.delta > 0 && (x.kind === "identifier" || x.kind === "word" || x.kind === "phrase"))
      .reduce((s, x) => s + x.delta, 0);
    if (positive <= 0) continue;

    // Years: soft. Late uploads are common, so a one-year miss is a nudge.
    if (q.years.length) {
      const asked = q.years.map((c) => Number(c.value));
      if (e.years.length) {
        let best = Infinity, bestYear = e.years[0];
        for (const y of e.years) for (const a of asked) { const d = Math.abs(y - a); if (d < best) { best = d; bestYear = y; } }
        if (best === 0) ev.push({ kind: "year", label: `Dated ${bestYear}`, delta: W.yearHit });
        else if (best === 1) ev.push({ kind: "year", label: `Dated ${bestYear}, one year off (late upload?)`, delta: W.yearOff1 });
        else if (best === 2) ev.push({ kind: "year", label: `Dated ${bestYear}, two years off`, delta: W.yearOff2 });
        else ev.push({ kind: "year", label: `Dated ${bestYear}, ${best} years off`, delta: W.yearOffMore });
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
