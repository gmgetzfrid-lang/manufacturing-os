// lib/thor/suggest.ts — what the THOR search box offers while you type.
//
// All of it comes from the index itself (thor_vocabulary): the unit names,
// the equipment-type folders under them (VESSELS, EXCHANGERS, RELIEF
// VALVES…), every equipment tag and description. Pure functions:
//
//   ghostCompletion — the grey rest-of-the-word after the caret (Tab takes it)
//   exampleSearches — real searches to show in the empty box, built from the
//                     most-documented equipment, so every example finds files
//   resolveTags     — "V-1 in the crude unit": which V-1s exist, in scope or not
//   categoryChips   — words that name an equipment-type folder, as one chip

import { matchKey } from "./tokens";
import { unitName, unitWords, type ThorQuery } from "./query";
import type { ThorVocabulary } from "./client";

type Eq = ThorVocabulary["equipment"][number];

const GRAMMAR = [
  "latest to oldest", "oldest to newest", "newest first", "oldest first", "largest first", "smallest first",
  "only pdfs", "pdfs", "drawings", "p&ids", "inspection reports", "inspections", "datasheets", "calculations",
  "photos", "excel", "word", "emails", "after 2020", "before 2020", "between 2015 and 2020", "last year",
  "this year", "past month", "past 5 years", "over 10 mb", "under 1 mb", "in the ",
];

const clean = (s: string) => s.toLowerCase().replace(/\s*\(.*?\)\s*/g, " ").replace(/\s+/g, " ").trim();

/** A tag as people write it: "V-3", "X-14A", "PSV-003". */
const tagForm = (t: string) => t.toUpperCase();

/** The tag people use: the one its description starts with ("V-3 PREFRACTIONATOR TOWER"), else the shortest. */
export function primaryTag(e: Pick<Eq, "tags" | "description">): string | null {
  if (!e.tags.length) return null;
  const d = (e.description ?? "").toUpperCase();
  return e.tags.find((t) => d.startsWith(t.toUpperCase())) ?? [...e.tags].sort((a, b) => a.length - b.length)[0];
}

/** A description without its leading tag or trailing note: "H-2 FRACTIONATOR HEATER - BORN HEATER" → "fractionator heater". */
export function describe(e: Pick<Eq, "tags" | "description">): string | null {
  if (!e.description) return null;
  let d = e.description;
  const tag = primaryTag(e);
  if (tag && d.toUpperCase().startsWith(tag.toUpperCase())) d = d.slice(tag.length);
  d = clean(d.replace(/^[\s\-–:]+/, "").split(/\s[-–]\s/)[0]);
  return /[a-z]{4}/.test(d) ? d : null;
}

/** grammar / unit / category complete whole phrases; equipment names one word at a time. */
interface Candidate { text: string; weight: number; wordwise: boolean }

let cache: { vocab: ThorVocabulary; list: Candidate[] } | null = null;

function candidates(vocab: ThorVocabulary): Candidate[] {
  if (cache?.vocab === vocab) return cache.list;
  const seen = new Map<string, { weight: number; wordwise: boolean }>();
  const add = (text: string, weight: number, wordwise = false) => {
    const t = text.toLowerCase();
    if (t.length < 2) return;
    const had = seen.get(t);
    if (!had || had.weight < weight) seen.set(t, { weight, wordwise });
  };
  GRAMMAR.forEach((g, i) => add(g, 1_000_000 - i));
  for (const u of vocab.units) {
    const name = unitName(u.folder).toLowerCase();
    add(name, 500_000 + u.files);
    add(`the ${name}`, 400_000 + u.files);
  }
  for (const c of vocab.categories) add(clean(c.name), 300_000 + c.files);
  for (const e of vocab.equipment) {
    for (const t of e.tags) add(t, 100_000 + e.files);
    add(e.number, 50_000 + e.files);
    const d = describe(e);
    if (d) add(d, 10_000 + e.files, true);
  }
  const list = [...seen].map(([text, v]) => ({ text, ...v })).sort((a, b) => b.weight - a.weight);
  cache = { vocab, list };
  return list;
}

/**
 * The rest of what is being typed, from the vocabulary: "only pdfs of the
 * vessel v-1 in the cru" → "de unit". Matches the last one to three words so
 * phrases ("relief va" → "lves") complete too. Empty when nothing fits, or
 * the caret sits after a space.
 */
export function ghostCompletion(text: string, vocab: ThorVocabulary | null): string {
  if (!vocab || !text || /\s$/.test(text)) return "";
  const words = text.split(/\s+/);
  const list = candidates(vocab);
  for (let n = Math.min(3, words.length); n >= 1; n--) {
    const frag = words.slice(-n).join(" ");
    const f = frag.toLowerCase();
    if (f.length < 2) continue;
    // Already a whole phrase ("latest to oldest"): nothing to add.
    if (n > 1 && list.some((c) => c.text === f)) return "";
    const hit = list.find((c) => c.text.length > f.length && c.text.startsWith(f));
    if (!hit) continue;
    let rest = hit.text.slice(f.length);
    // An equipment name completes the word being typed, then the next on Tab.
    if (hit.wordwise) { const sp = rest.indexOf(" ", 1); if (sp > 0) rest = rest.slice(0, sp); }
    // Match the case being typed: "PREF" → "RACTIONATOR".
    return frag === frag.toUpperCase() && /[A-Z]/.test(frag) ? rest.toUpperCase() : rest;
  }
  return "";
}

/** Real example searches — each built from equipment that has files, in the unit it belongs to. */
export function exampleSearches(vocab: ThorVocabulary | null): string[] {
  if (!vocab) return [];
  const unitOf = (code: string | null) => {
    const u = vocab.units.find((x) => x.code === code);
    return u ? unitName(u.folder).toLowerCase() : null;
  };
  const tagged = vocab.equipment.filter((e) => primaryTag(e) && e.unit && unitOf(e.unit) && e.files > 20 && describe(e));
  const out: string[] = [];
  const t0 = tagged[0], t1 = tagged.find((e) => e.unit !== t0?.unit) ?? tagged[1], t2 = tagged.find((e) => e !== t0 && e !== t1 && e.unit !== t1?.unit);
  const noun = (e: Eq) => /tower|drum|vessel|accumulator|receiver|separator|filter|stripper/i.test(e.description ?? "") ? "vessel" : /heater|exchanger|cooler|condenser|pump|tank/i.exec(e.description ?? "")?.[0].toLowerCase() ?? "equipment";
  if (t0) out.push(`only PDFs of the ${noun(t0)} ${tagForm(primaryTag(t0)!)} in the ${unitOf(t0.unit)} from latest to oldest`);
  // A distinctive word from a well-documented piece of equipment, shortened the way people do.
  const word = tagged.map((e) => describe(e)!.split(" ").find((w) => w.length >= 9)).find(Boolean);
  if (word) out.push(`newest ${word.slice(0, 7)} drawings`);
  if (t1) out.push(`inspection reports for ${tagForm(primaryTag(t1)!)} in the ${unitOf(t1.unit)} after 2020`);
  const cat = vocab.categories.find((c) => /valve|exchanger|pump|vessel|tank/i.test(c.name));
  const bigUnit = [...vocab.units].sort((a, b) => b.files - a.files)[1];
  if (cat && bigUnit) out.push(`${clean(cat.name)} in the ${unitName(bigUnit.folder).toLowerCase()} over 5 MB`);
  if (t2) out.push(`datasheets for ${t2.number}`);
  const d1 = tagged[3] && describe(tagged[3]);
  if (d1) out.push(`${d1} photos oldest first`);
  return out;
}

export interface TagResolution {
  key: string;
  label: string;
  /** Equipment with this tag inside the units asked for (or anywhere when none were). */
  inScope: Eq[];
  /** Same tag in other units — offered when inScope is empty. */
  elsewhere: Eq[];
}

/** Which piece of equipment each tag in the query means, given the units asked for. */
export function resolveTags(q: ThorQuery | null, vocab: ThorVocabulary | null): TagResolution[] {
  if (!q || !vocab) return [];
  return q.tags.map((key) => {
    const all = vocab.equipment.filter((e) => e.tags.some((t) => matchKey(t) === key));
    const inScope = q.units.length ? all.filter((e) => e.unit && q.units.includes(e.unit)) : all;
    return { key, label: key.toUpperCase().replace(/^([A-Z]+)(\d)/, "$1-$2"), inScope, elsewhere: inScope.length ? [] : all };
  });
}

/**
 * Words that together name an equipment-type folder ("vessel" → VESSELS,
 * "relief valves" → RELIEF VALVES). They still rank as words — this only
 * says so on one chip instead of several.
 */
export function categoryChips(q: ThorQuery | null, vocab: ThorVocabulary | null): Array<{ name: string; terms: string[] }> {
  if (!q || !vocab || !q.terms.length) return [];
  const out: Array<{ name: string; terms: string[] }> = [];
  const used = new Set<string>();
  const cats = vocab.categories.map((c) => ({ name: c.name, words: unitWords(`0000 - ${clean(c.name)}`) })).filter((c) => c.words.length)
    .sort((a, b) => b.words.length - a.words.length);
  for (const c of cats) {
    const terms = c.words.map((w) => q.terms.find((t) => !used.has(t) && t.length >= 3 && (w.startsWith(t) || t.startsWith(w))));
    if (terms.every(Boolean)) {
      for (const t of terms) used.add(t!);
      out.push({ name: c.name, terms: terms as string[] });
    }
  }
  return out;
}
