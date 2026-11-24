// lib/ask/titleRouting.ts — which documents an engineer would OPEN.
//
// Search finds pages whose words match the question. A person answering
// "can I weld a coupling into a blind flange" doesn't search for words;
// they open the fabrication practice, because that's where fabrication
// details live. Passage search alone never opened EP 5-5-1 (Piping
// Fabrication) for that question: its pages say "couplings" and "Figure
// 4", not "blind flange".
//
// So the planning step is shown a short list of the library's document
// titles that may govern the question, and names the ones to open. The
// list is built here: titles that share the question's words (rarer words
// count more), then their SIBLINGS — documents in the same family as the
// ones matched or retrieved (EP 5-5-2 Welding → EP 5-5-1 Fabrication,
// EP 5-5-3 …). Base practices come before their checklists, data sheets
// and forms.

import { contentWords, stem } from "@/lib/ask/pageTargets";

export interface TitledDoc { id: string; name: string }

/** "EP 5-5-1 - Piping Fabrication" → { family: "EP 5-5", base: "EP 5-5-1",
 *  variant: "" }; "EP 5-5-1C - …Checklist" → variant "C". */
export function designationOf(name: string): { family: string; base: string; variant: string } | null {
  const m = /^\s*([A-Z]{1,8})[\s-]*(\d+)[-.](\d+)(?:[-.](\d+))?([A-Z][A-Za-z0-9-]*)?\b/.exec(name);
  if (!m) return null;
  const [, pre, a, b, c, variant] = m;
  return {
    family: `${pre} ${a}-${b}`,
    base: c ? `${pre} ${a}-${b}-${c}` : `${pre} ${a}-${b}`,
    variant: variant ?? "",
  };
}

const titleWords = (name: string) =>
  new Set((name.replace(/^\s*[A-Z]{1,8}[\s-]*[\d.-]+[A-Za-z0-9-]*\s*[-–—:]?\s*/, "")
    .toLowerCase().match(/[a-z][a-z0-9]{2,}/g) ?? []).map(stem));

export function routeCandidates(input: {
  docs: TitledDoc[];
  /** The question. Its words count fully. */
  question: string;
  /** The plan's search queries. Their words count half: they add
   *  vocabulary, and generic words ("requirements", "materials"). */
  queries?: string[];
  /** Documents the first search round already returned. */
  retrievedDocIds: string[];
  cap?: number;
}): TitledDoc[] {
  const { docs, question, retrievedDocIds } = input;
  const cap = input.cap ?? 75;
  if (docs.length === 0) return [];
  const qWords = new Set(contentWords(question));
  const allWords = new Set([...qWords, ...contentWords((input.queries ?? []).join(" "))]);
  const sets = docs.map((d) => titleWords(d.name));
  const n = docs.length;
  const weight = new Map<string, number>();
  for (const w of allWords) {
    const df = sets.reduce((k, s) => k + (s.has(w) ? 1 : 0), 0);
    if (df > 0) weight.set(w, Math.log(1 + n / df) * (qWords.has(w) ? 1 : 0.5));
  }
  const score = sets.map((set) => {
    let s = 0;
    for (const [w, v] of weight) if (set.has(w)) s += v;
    return s;
  });
  const des = docs.map((d) => designationOf(d.name));
  const matched = docs.map((_, i) => i).filter((i) => score[i] > 0)
    .sort((a, b) => score[b] - score[a] || (des[a]?.variant ? 1 : 0) - (des[b]?.variant ? 1 : 0) || docs[a].name.localeCompare(docs[b].name));

  // A: the best title matches.
  const picked: number[] = matched.slice(0, 25);
  // B: their families, and the families of what search already found —
  // every base practice in them (not checklists, data sheets or drawings),
  // the family of the best match first.
  const families: string[] = [];
  const addFamily = (i: number) => { const f = des[i]?.family; if (f && !families.includes(f)) families.push(f); };
  for (const i of matched.slice(0, 10)) addFamily(i);
  const retrieved = new Set(retrievedDocIds);
  docs.forEach((d, i) => { if (retrieved.has(d.id)) addFamily(i); });
  const have = new Set(picked);
  const siblings = docs.map((_, i) => i)
    .filter((i) => !have.has(i) && des[i] && !des[i]!.variant && families.includes(des[i]!.family))
    .sort((a, b) => families.indexOf(des[a]!.family) - families.indexOf(des[b]!.family) || docs[a].name.localeCompare(docs[b].name, undefined, { numeric: true }));
  return [...picked, ...siblings].slice(0, cap).map((i) => docs[i]);
}

const squash = (t: string) => t.toUpperCase().replace(/[^A-Z0-9]/g, "");

/** How well a document NAME matches a designation someone wrote:
 *  3 = it IS that document ("EP 5-5-1" → "EP 5-5-1 - Piping Fabrication"),
 *  2 = a variant of it ("EP 5-5-1C - … Checklist"),
 *  1 = the title mentions it elsewhere,
 *  0 = no match. "EP 5-5-1" never matches "EP 5-5-10". */
export function designationMatch(designation: string, name: string): number {
  const want = squash(designation);
  if (want.length < 3) return 0;
  const d = designationOf(name);
  if (d) {
    if (squash(d.base) === want) return d.variant ? 2 : 3;
    if (squash(d.base + d.variant) === want) return 3;
  }
  const sq = squash(name);
  let at = sq.indexOf(want);
  while (at >= 0) {
    const next = sq.charAt(at + want.length);
    const prev = at > 0 ? sq.charAt(at - 1) : "";
    // Not the middle of a longer number ("EP551" inside "EP5510").
    if (!/[0-9]/.test(next) && !(/[0-9]/.test(want.charAt(0)) && /[0-9]/.test(prev))) return d ? 1 : 2;
    at = sq.indexOf(want, at + 1);
  }
  return 0;
}
