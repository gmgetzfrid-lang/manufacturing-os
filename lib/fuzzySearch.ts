// fuzzySearch - one search for every list of steps and work orders, the way
// people type in the field: "v1", "v-1", "V 01" and "V-01" are the same
// tag; "E-2" is "E-02"; a typo in a word ("shultz", "condensor",
// "debutanizr") still finds it; a WO number can be typed in part ("3045").
//
//   const m = searchMatcher("v1 tower");
//   m("V-01 - De-Butanizer Column Clean Tower")   // > 0: a match
//
// Every word typed must be found. The score says how well (exact before a
// prefix before a typo), so lists put the best matches first.

/** Lower case, accents off. */
const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");

/** "007" -> "7", "0" stays "0". */
const zeros = (d: string) => d.replace(/^0+(?=\d)/, "");

type Part = { s: string; digit: boolean; sep: string };

/** The letter runs and number runs in order, each with what came before it. */
function partsOf(text: string): Part[] {
  const t = norm(text);
  const out: Part[] = [];
  const re = /[a-z]+|\d+/g;
  let last = 0;
  for (let m = re.exec(t); m; m = re.exec(t)) {
    out.push({ s: m[0], digit: /\d/.test(m[0][0]), sep: t.slice(last, m.index) });
    last = m.index + m[0].length;
  }
  return out;
}

/** Between a tag's letters and its number: nothing, a dash, a space, "#". */
const TAG_SEP = /^[\s#-]{0,3}$/;
/** A tag's letters: V, E, PSV, LRU, MCC, XV, UIT, TO (up to 5). */
const tagLetters = (p: Part) => !p.digit && p.s.length <= 5;

interface SearchIndex { words: string[]; nums: string[]; tags: Set<string> }

/** What a text can be found by: its words (hyphenated ones joined too),
 *  its numbers (leading zeros off), and its tags ("v1", "psv209", "v12a"). */
export function searchIndex(text: string): SearchIndex {
  const ps = partsOf(text);
  const words = new Set<string>(), nums = new Set<string>(), tags = new Set<string>();
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i], next = ps[i + 1];
    if (p.digit) nums.add(zeros(p.s)); else words.add(p.s);
    // De-Butanizer: also "debutanizer".
    if (!p.digit && next && !next.digit && next.sep === "-") words.add(p.s + next.s);
    if (tagLetters(p) && next?.digit && TAG_SEP.test(next.sep)) {
      const tag = p.s + zeros(next.s);
      tags.add(tag);
      const suf = ps[i + 2];
      if (suf && !suf.digit && suf.sep === "" && suf.s.length <= 2) tags.add(tag + suf.s);
    }
  }
  return { words: [...words], nums: [...nums], tags };
}

type Term = { kind: "tag"; tag: string; letters: string; num: string } | { kind: "num"; s: string } | { kind: "word"; s: string };

/** What was typed, as terms: a tag ("v-1"), a number, or a word. */
function termsOf(query: string): Term[] {
  const ps = partsOf(query);
  const out: Term[] = [];
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i], next = ps[i + 1];
    if (tagLetters(p) && next?.digit && TAG_SEP.test(next.sep)) {
      let tag = p.s + zeros(next.s);
      const suf = ps[i + 2];
      if (suf && !suf.digit && suf.sep === "" && suf.s.length <= 2) { tag += suf.s; i++; }
      out.push({ kind: "tag", tag, letters: p.s, num: zeros(next.s) });
      i++;
      continue;
    }
    // "de-butanizer" typed with its dash: one word.
    if (!p.digit && next && !next.digit && next.sep === "-") { out.push({ kind: "word", s: p.s + next.s }); i++; continue; }
    out.push(p.digit ? { kind: "num", s: zeros(p.s) } : { kind: "word", s: p.s });
  }
  return out;
}

/** Edits between two words (a swap of two letters is one). */
export function editDistance(a: string, b: string, max = 2): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    let rowMin = Infinity;
    for (let j = 1; j <= b.length; j++) {
      const c = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + c);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      rowMin = Math.min(rowMin, d[i][j]);
    }
    if (rowMin > max) return max + 1;
  }
  return d[a.length][b.length];
}

/** Typos allowed in a word this long: none under 4 letters, one up to 7, two past that. */
const allowed = (n: number) => (n < 4 ? 0 : n < 8 ? 1 : 2);

function wordScore(q: string, words: string[]): number {
  let best = 0;
  const typos = allowed(q.length);
  for (const w of words) {
    if (w === q) return 3;
    if (q.length >= 2 && w.startsWith(q)) { best = Math.max(best, 2); continue; }
    if (!typos || best >= 1) continue;
    // A typo in the whole word, or in what's typed so far of a longer one.
    if (editDistance(q, w, typos) <= typos) best = 1;
    else if (q.length >= 5 && w.length > q.length && editDistance(q, w.slice(0, q.length), 1) <= 1) best = 1;
  }
  return best;
}

function termScore(t: Term, ix: SearchIndex): number {
  if (t.kind === "tag") {
    if (ix.tags.has(t.tag)) return 3;
    // Typed part of a longer number ("lru07" for LRU-078): two digits or more.
    if (t.num.length >= 2) for (const g of ix.tags) if (g.startsWith(t.tag)) return 2;
    // A word and a number ("tower 2"), not an equipment tag.
    if (t.letters.length >= 3 && wordScore(t.letters, ix.words) > 0 && ix.nums.includes(t.num)) return 1;
    return 0;
  }
  if (t.kind === "num") {
    if (ix.nums.includes(t.s)) return 3;
    if (t.s.length >= 3 && ix.nums.some((n) => n.startsWith(t.s))) return 2;
    return 0;
  }
  return wordScore(t.s, ix.words);
}

/** A matcher for what was typed: 0 = no match, higher = better. An empty
 *  search matches everything (score 1). */
export function searchMatcher(query: string): (text: string | SearchIndex) => number {
  const terms = termsOf(query);
  if (!terms.length) return () => 1;
  return (text) => {
    const ix = typeof text === "string" ? searchIndex(text) : text;
    let sum = 0;
    for (const t of terms) { const s = termScore(t, ix); if (!s) return 0; sum += s; }
    return sum;
  };
}

/** Something was typed to search by. */
export const hasQuery = (query: string) => termsOf(query).length > 0;

/** Does the text match what was typed? */
export const searchMatches = (query: string, text: string) => searchMatcher(query)(text) > 0;

/** The items that match, best first (ties keep their order). An empty
 *  search keeps them all as they are. */
export function searchFilter<T>(items: T[], query: string, textOf: (x: T) => string): T[] {
  if (!hasQuery(query)) return items;
  const m = searchMatcher(query);
  return items.map((x, i) => ({ x, i, s: m(textOf(x)) })).filter((y) => y.s > 0).sort((a, b) => b.s - a.s || a.i - b.i).map((y) => y.x);
}
