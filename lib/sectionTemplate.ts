// lib/sectionTemplate.ts — find the sections of a "book" document from its
// running header, whatever the company's format.
//
// Spec books, data-sheet books and class databases are many sections bound
// in one PDF, and almost every one carries the section's identifier in a
// running header: "Kern Energy - (FAAA1G) - Piping Database Rev 99",
// "LINE CLASS: A1A   SHEET 3 OF 9", "Piping Material Specification 150-CS-01".
// Nothing here knows any of those formats. It finds, from the pages
// themselves, the one header line that repeats on most pages with exactly
// one changing part — and keeps it only if that part behaves like a section
// key: it holds for runs of consecutive pages, takes several values, and is
// not a page counter or a date.

export interface SectionRange { key: string; first: number; last: number }
export interface RunningKey {
  /** The header line with the key replaced by ⟨key⟩ — shown to people so
   *  they can see what was understood. */
  template: string;
  /** Share of pages carrying the header. */
  coverage: number;
  ranges: SectionRange[];
}

const KEY_SLOT = "⟨key⟩";
const TOP_LINES = 5;

/** A token that could be a section key: has a letter or digit, short, and
 *  not a plain word ("Database") — keys carry digits or are all capitals. */
function keyLike(tok: string): string | null {
  const t = tok.replace(/^[([{"'#:]+|[)\]}"',.:;]+$/g, "");
  if (t.length < 2 || t.length > 16) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9./_-]*$/.test(t)) return null;
  if (!/\d/.test(t) && t !== t.toUpperCase()) return null;
  return t;
}

const DATEISH = /^(\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}|(19|20)\d{2})$/;

export function findRunningKey(pages: Array<{ page: number; text: string }>): RunningKey | null {
  if (pages.length < 4) return null;
  // Candidate templates: each top line with one key-like token blanked.
  type Hit = { page: number; value: string };
  const byTemplate = new Map<string, Hit[]>();
  for (const { page, text } of pages) {
    // Top lines (a header) and bottom lines (a footer) — companies use both.
    const all = text.split(/\n+/).map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
    const lines = all.length <= TOP_LINES * 2 ? all : [...all.slice(0, TOP_LINES), ...all.slice(-TOP_LINES)];
    const seen = new Set<string>();
    for (const line of lines) {
      const toks = line.split(" ");
      if (toks.length > 24) continue;
      toks.forEach((tok, i) => {
        const value = keyLike(tok);
        if (!value) return;
        // Other bare numbers on the line (a sheet counter, a year) are
        // blanked too, so "LINE CLASS: A1A SHEET 3 OF 40" and "… SHEET 4 OF
        // 40" are the same line with the same key.
        const tpl = toks.map((t, j) => (j === i ? t.replace(value, KEY_SLOT) : /^\d+$/.test(t) ? "#" : t)).join(" ");
        if (seen.has(tpl)) return;
        seen.add(tpl);
        const list = byTemplate.get(tpl) ?? [];
        list.push({ page, value: value.toUpperCase() });
        byTemplate.set(tpl, list);
      });
    }
  }

  let best: { tpl: string; hits: Hit[]; score: number } | null = null;
  for (const [tpl, hits] of byTemplate) {
    const coverage = hits.length / pages.length;
    if (coverage < 0.4) continue;
    const distinct = new Set(hits.map((h) => h.value));
    if (distinct.size < 2) continue;                       // a constant, not a key
    // A page counter changes on (almost) every page; a key holds for runs.
    const sorted = [...hits].sort((a, b) => a.page - b.page);
    let changes = 0;
    for (let i = 1; i < sorted.length; i++) if (sorted[i].value !== sorted[i - 1].value) changes++;
    const meanRun = sorted.length / (changes + 1);
    if (meanRun < 1.5) continue;
    // Dates and bare years aren't keys.
    if ([...distinct].filter((v) => DATEISH.test(v)).length > distinct.size / 2) continue;
    // Values equal to the page number are a counter in disguise.
    if (sorted.filter((h) => h.value === String(h.page)).length > sorted.length / 3) continue;
    // Templates with more fixed text are more specific — prefer them.
    const fixed = tpl.replace(KEY_SLOT, "").replace(/\s+/g, "").length;
    const score = coverage * Math.log2(1 + distinct.size) * Math.min(1, fixed / 12);
    if (!best || score > best.score) best = { tpl, hits: sorted, score };
  }
  if (!best) return null;

  // Ranges: a page without the header continues the section before it.
  const valueOf = new Map(best.hits.map((h) => [h.page, h.value]));
  const ranges: SectionRange[] = [];
  for (const { page } of [...pages].sort((a, b) => a.page - b.page)) {
    const v = valueOf.get(page);
    const cur = ranges[ranges.length - 1];
    if (v && (!cur || cur.key !== v)) ranges.push({ key: v, first: page, last: page });
    else if (cur) cur.last = page;
  }
  return { template: best.tpl, coverage: best.hits.length / pages.length, ranges };
}

/** Books with no header line: the section's code is repeated in the page
 *  BODY, in parentheses after each table's heading — "Gate Valve (AAAA1)",
 *  "Fitting (AAAA1)", "Flanges (AAAC2H)". A code qualifies when it holds
 *  for one run of consecutive pages (a note like "(NACE)" or "(PWHT)"
 *  recurs all over the book and is ruled out), and the book has several. */
export function findParenKeys(pages: Array<{ page: number; text: string }>): RunningKey | null {
  if (pages.length < 4) return null;
  const re = /\(([A-Z0-9][A-Z0-9.-]{2,11})\)/g;
  const perPage = new Map<number, Map<string, number>>();
  const pagesOf = new Map<string, number[]>();
  let example: string | null = null;
  for (const { page, text } of pages) {
    const m = new Map<string, number>();
    for (const x of text.matchAll(re)) {
      const k = x[1];
      if (!/[A-Z]/.test(k) || (!/\d/.test(k) && k.length < 4)) continue;
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    perPage.set(page, m);
    for (const k of m.keys()) pagesOf.set(k, [...(pagesOf.get(k) ?? []), page]);
  }
  // A section key sits on one run of pages (gaps of a page or two allowed).
  const contiguous = new Set<string>();
  for (const [k, ps] of pagesOf) {
    ps.sort((a, b) => a - b);
    let runs = 1;
    for (let i = 1; i < ps.length; i++) if (ps[i] - ps[i - 1] > 2) runs++;
    // One run of pages, and not most of the book (a constant would be).
    if (runs <= 2 && ps.length / pages.length < 0.6) contiguous.add(k);
  }
  const hits: Array<{ page: number; value: string }> = [];
  for (const { page } of pages) {
    const m = perPage.get(page)!;
    let best: string | null = null;
    for (const [k, n] of m) if (contiguous.has(k) && (!best || n > m.get(best)!)) best = k;
    if (best) hits.push({ page, value: best });
  }
  const distinct = new Set(hits.map((h) => h.value));
  if (hits.length / pages.length < 0.4 || distinct.size < 3) return null;
  for (const { text } of pages) {
    const k = hits[0]?.value;
    const at = k ? text.match(new RegExp(`([A-Z][A-Za-z]+(?: [A-Z][A-Za-z]+)?) \\(${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)`)) : null;
    if (at) { example = `${at[1]} (${KEY_SLOT})`; break; }
  }
  const valueOf = new Map(hits.map((h) => [h.page, h.value]));
  // A page with no code that sits right before a new section is that
  // section's opening page (a service line before the first table) — it
  // belongs to what follows, not to what came before.
  const sorted = [...pages].sort((a, b) => a.page - b.page);
  for (let i = sorted.length - 2; i >= 0; i--) {
    const here = sorted[i].page, next = valueOf.get(sorted[i + 1].page);
    const prev = i > 0 ? valueOf.get(sorted[i - 1].page) : undefined;
    if (!valueOf.has(here) && next && next !== prev) valueOf.set(here, next);
  }
  const ranges: SectionRange[] = [];
  for (const { page } of sorted) {
    const v = valueOf.get(page);
    const cur = ranges[ranges.length - 1];
    if (v && (!cur || cur.key !== v)) ranges.push({ key: v, first: page, last: page });
    else if (cur) cur.last = page;
  }
  return { template: example ?? `… (${KEY_SLOT})`, coverage: hits.length / pages.length, ranges };
}

/** A book's sections: from a running header if it has one, else from the
 *  codes repeated in its table headings. */
export function findSections(pages: Array<{ page: number; text: string }>): RunningKey | null {
  return findRunningKey(pages) ?? findParenKeys(pages);
}
