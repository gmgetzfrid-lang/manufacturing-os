// lib/fileFinder/queryParse.ts — what did they actually ask for?
//
// "U1-A for the born heater pilot valve in 2018" is not a string to match. It
// is one identifier, three equipment words, a year, and (through an alias)
// a unit. Each becomes a chip the user can see and correct. Everything the
// ranker does downstream is justified by one of these chips, so a bad parse
// is visible instead of silently producing bad results.

import { canonicalForm, findCodes, tagVariants } from "./tagForms";
import { words, bigrams, years } from "./tokens";
import { aliasConfidence, type FinderAlias } from "./aliasTypes";
import { docTypesIn, docTypeByKey, sheetNumbersIn, revisionsIn, canonicalRev } from "./docTypes";

export interface UnitLike { code: string; label: string }

export type ChipKind = "identifier" | "word" | "phrase" | "year" | "unit" | "sheet" | "rev" | "doctype";

export interface QueryChip {
  kind: ChipKind;
  /** The canonical value the ranker matches on. */
  value: string;
  /** What to print. */
  label: string;
  /** Where it came from: typed, or expanded through an alias/codebook. */
  via: "typed" | "alias" | "codebook";
  /** The alias that produced it, when via === "alias". */
  aliasId?: string;
  /** 0..1 — typed chips are 1; alias chips carry the alias's confidence. */
  confidence: number;
}

export interface ParsedQuery {
  raw: string;
  chips: QueryChip[];
  identifiers: QueryChip[];
  words: QueryChip[];
  phrases: QueryChip[];
  years: QueryChip[];
  units: QueryChip[];
  sheets: QueryChip[];
  revs: QueryChip[];
  docTypes: QueryChip[];
}

function unitWordSet(u: UnitLike): string[] {
  return [...new Set([...words(u.label), ...words(u.code)])];
}

/** Does a lowercase word name this unit? "crude" names "Crude Unit" (code 20). */
export function wordNamesUnit(w: string, u: UnitLike): boolean {
  if (w === u.code.toLowerCase()) return true;
  const uw = unitWordSet(u).filter((x) => x !== "unit");
  return uw.includes(w);
}

export function parseQuery(
  raw: string,
  ctx: { units?: UnitLike[]; aliases?: FinderAlias[] } = {},
): ParsedQuery {
  const units = ctx.units ?? [];
  const aliases = ctx.aliases ?? [];
  const chips: QueryChip[] = [];
  const seen = new Set<string>();
  const push = (c: QueryChip) => {
    const key = `${c.kind}:${c.value}`;
    if (seen.has(key)) return;
    seen.add(key);
    chips.push(c);
  };

  // 0. Structure people say without knowing the naming convention: "sheet 5",
  //    "rev 3", "P&ID". These come out first so "5" is never lost as a bare
  //    digit and "pid" is never just a word.
  for (const n of sheetNumbersIn(raw)) push({ kind: "sheet", value: String(n), label: `sheet ${n}`, via: "typed", confidence: 1 });
  for (const r of revisionsIn(raw)) push({ kind: "rev", value: canonicalRev(r), label: `rev ${r}`, via: "typed", confidence: 1 });
  const structural = raw
    .replace(/(?<![A-Za-z0-9])(?:sheet|sht|sh|page|pg)\s*[-_.#]?\s*\d{1,3}(?![0-9])/gi, " ")
    .replace(/(?<![A-Za-z0-9])(?:rev(?:ision)?\.?\s*[-_#]?\s*|r)(?:[A-Z]{1,2}|\d{1,3}[A-Z]?)(?![A-Za-z0-9])/gi, " ");

  // 1. Codes — before words, so "u1-a" is never also a word. The label keeps
  //    the spelling the person used ("EP10-1-15", "10-1-15"), the value is
  //    the canonical form the matcher compares.
  const codes = findCodes(structural);
  const idents = codes.map((c) => c.canon);
  for (const c of codes) {
    push({ kind: "identifier", value: c.canon, label: c.raw.toUpperCase(), via: "typed", confidence: 1 });
  }
  const identWords = new Set(idents.map((i) => i.toLowerCase()));

  // 2. Years.
  for (const y of years(structural)) push({ kind: "year", value: String(y), label: String(y), via: "typed", confidence: 1 });

  // 3. Words and phrases. A word that names a document type becomes a
  //    doctype chip AND stays a word, so "P&ID" also matches a folder
  //    literally called that.
  const ws = words(structural).filter((w) => !identWords.has(canonicalForm(w).toLowerCase()) && !/^\d{4}$/.test(w));
  for (const key of docTypesIn(ws)) {
    const t = docTypeByKey(key)!;
    push({ kind: "doctype", value: key, label: t.label, via: "typed", confidence: 1 });
  }
  for (const w of ws) push({ kind: "word", value: w, label: w, via: "typed", confidence: 1 });
  for (const b of bigrams(ws)) push({ kind: "phrase", value: b, label: `"${b}"`, via: "typed", confidence: 1 });

  // 4. Units the words name directly (codebook knowledge, no alias needed).
  for (const w of ws) {
    for (const u of units) {
      if (wordNamesUnit(w, u)) {
        push({ kind: "unit", value: u.code, label: `${u.label} (${u.code})`, via: "codebook", confidence: 0.95 });
      }
    }
  }

  // 5. Aliases — a typed word or identifier that someone taught the meaning of.
  //    Bidirectional: typing the taught term OR the thing it means expands to
  //    the other side, so "born" finds files that say "crude" and vice versa.
  const typedCanon = new Set<string>([
    ...idents, ...ws.map(canonicalForm), ...bigrams(ws).map(canonicalForm),
  ]);
  for (const a of aliases) {
    const conf = aliasConfidence(a);
    let other: string | null = null;
    if (typedCanon.has(a.termCanonical)) other = a.means;
    else if (typedCanon.has(a.meansCanonical)) other = a.term;
    if (!other) continue;
    const otherCanon = canonicalForm(other);
    if (a.kind === "unit") {
      const u = units.find((x) => canonicalForm(x.code) === otherCanon || canonicalForm(x.label) === otherCanon
        || words(x.label).some((lw) => canonicalForm(lw) === otherCanon));
      if (u) push({ kind: "unit", value: u.code, label: `${u.label} (${u.code})`, via: "alias", aliasId: a.id, confidence: conf });
      else push({ kind: "word", value: other.toLowerCase(), label: other.toLowerCase(), via: "alias", aliasId: a.id, confidence: conf });
    } else if (a.kind === "equipment") {
      push({ kind: "identifier", value: otherCanon, label: tagVariants(otherCanon)[1] ?? otherCanon, via: "alias", aliasId: a.id, confidence: conf });
    } else {
      const ow = words(other);
      if (ow.length > 1) push({ kind: "phrase", value: ow.join(" "), label: `"${ow.join(" ")}"`, via: "alias", aliasId: a.id, confidence: conf });
      for (const w of ow) push({ kind: "word", value: w, label: w, via: "alias", aliasId: a.id, confidence: conf });
    }
  }

  return {
    raw,
    chips,
    identifiers: chips.filter((c) => c.kind === "identifier"),
    words: chips.filter((c) => c.kind === "word"),
    phrases: chips.filter((c) => c.kind === "phrase"),
    years: chips.filter((c) => c.kind === "year"),
    units: chips.filter((c) => c.kind === "unit"),
    sheets: chips.filter((c) => c.kind === "sheet"),
    revs: chips.filter((c) => c.kind === "rev"),
    docTypes: chips.filter((c) => c.kind === "doctype"),
  };
}

/** Rebuild the parsed query from a chip set the user has edited. */
export function fromChips(raw: string, chips: QueryChip[]): ParsedQuery {
  return {
    raw, chips,
    identifiers: chips.filter((c) => c.kind === "identifier"),
    words: chips.filter((c) => c.kind === "word"),
    phrases: chips.filter((c) => c.kind === "phrase"),
    years: chips.filter((c) => c.kind === "year"),
    units: chips.filter((c) => c.kind === "unit"),
    sheets: chips.filter((c) => c.kind === "sheet"),
    revs: chips.filter((c) => c.kind === "rev"),
    docTypes: chips.filter((c) => c.kind === "doctype"),
  };
}
