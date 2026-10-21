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
