// lib/specSelect.ts — answering "which spec / class should I use" the way
// an engineer does: filter the catalog, then narrow.
//
// A selection question isn't answered by finding a sentence. The library
// holds a catalog a person marked — entries keyed by a code, each with the
// fields it prints (a rating, what it's for, a material…) — and the answer
// is the catalog filtered by what the asker gave (the rating, the use in
// their words AND in the words the company's documents use for it),
// followed by what would narrow it further: the fields on which the
// remaining candidates differ. Pure functions; the engine feeds them the
// records and the term ties it found.

export interface CatalogRecord {
  code: string;
  documentId: string;
  documentName: string;
  page: number;
  rating?: string;
  service?: string;
  /** Other "Label: value" fields printed on the entry's opening page. */
  attrs?: Record<string, string>;
  /** The name a person gave the catalog it belongs to. */
  catalog?: string;
}

export interface Candidate extends CatalogRecord {
  /** Which of the asker's terms its service matched, and how. */
  matched: { term: string; how: "asker" | "company" | "lead" }[];
}

/** "which spec / class / material … should I use / for …" */
export function isSelectionQuestion(question: string): boolean {
  const q = question.toLowerCase();
  return /\b(which|what)\b[^?]{0,60}\b(spec|specs|specification|piping class|line class|pipe class|class|material|gasket|bolting|trim)\b/.test(q)
    && /\b(use|for|select|choose|pick|need|should|apply|go with|recommend)\b/.test(q);
}

/** Chemical formulas extracted with subscripts come apart ("H 2 S"). */
export const normChem = (s: string) => s.toLowerCase().replace(/\b([a-z]{1,2})\s?(\d)\s?([a-z]{1,2})\b/g, "$1$2$3").replace(/\s+/g, " ").trim();

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const has = (hay: string, term: string) => new RegExp(`(^|[^a-z0-9])${esc(term)}(s|es)?([^a-z0-9]|$)`).test(hay);
const sameRating = (recorded: string | undefined, asked: string) => !!recorded && new RegExp(`(^|[^0-9])${asked}([^0-9]|$)`).test(recorded);

/** Every candidate label before a colon: the last 1–4 capitalised words
 *  ("Rating", "Water Rating", "Sour Water Rating"). */
function labelCandidates(t: string): Array<{ at: number; end: number; options: string[] }> {
  const out: Array<{ at: number; end: number; options: string[] }> = [];
  for (const m of t.matchAll(/:\s+/g)) {
    const before = t.slice(Math.max(0, (m.index ?? 0) - 80), m.index);
    const words = before.split(" ").filter(Boolean);
    const options: string[] = [];
    for (let k = 1; k <= 4 && k <= words.length; k++) {
      const w = words.slice(-k);
      if (!w.every((x) => /^[A-Z][A-Za-z/&().-]*$/.test(x))) break;
      options.push(w.join(" "));
    }
    if (options.length) out.push({ at: (m.index ?? 0) - options[0].length, end: (m.index ?? 0) + m[0].length, options });
  }
  return out;
}

/** How often each candidate label appears across a book's opening pages —
 *  a real field label ("Rating") repeats on every class; "Sour Water
 *  Rating" is a service line running into it. */
export function labelCounts(texts: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const text of texts) {
    const seen = new Set<string>();
    for (const c of labelCandidates(text.replace(/\s+/g, " "))) for (const o of c.options) {
      if (seen.has(o)) continue;
      seen.add(o);
      counts.set(o, (counts.get(o) ?? 0) + 1);
    }
  }
  return counts;
}

/** "Label: value" pairs printed on a class's opening page ("Corrosion
 *  Allowance: 0.125", "Temperature Range: -20 - 450"). With `counts` from the
 *  whole book, each label is the wording that repeats across classes. */
export function openingFields(text: string, counts?: Map<string, number>): Record<string, string> {
  const t = text.replace(/\s+/g, " ");
  const marks = labelCandidates(t).map((c) => {
    const label = counts
      // The most-repeated wording; among equals, the longest ("Corrosion
      // Allowance" repeats exactly as often as "Allowance").
      ? [...c.options].sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0) || b.length - a.length)[0]
      : c.options[Math.min(1, c.options.length - 1)];
    return { label, at: c.end - (t.slice(0, c.end).match(/:\s+$/)?.[0].length ?? 0) - label.length, end: c.end };
  });
  const out: Record<string, string> = {};
  for (let i = 0; i < marks.length && Object.keys(out).length < 14; i++) {
    const value = t.slice(marks[i].end, i + 1 < marks.length ? marks[i + 1].at : undefined).trim().slice(0, 160);
    if (value && marks[i].label.length <= 40 && !(marks[i].label in out)) out[marks[i].label] = value;
  }
  return out;
}

/** Filter a catalog by rating(s) and service terms. A service matches on the
 *  asker's own words, on the words the company's documents tie them to
 *  ("sour gas" written as "Wet H2S"), or only on a related term (a lead). */
export function filterCandidates(records: CatalogRecord[], o: {
  ratings: string[];
  askerTerms: string[];
  companyTerms: string[];
  leadTerms: string[];
}): Candidate[] {
  const out: Candidate[] = [];
  for (const r of records) {
    // A class whose rating wasn't recorded stays — marked — rather than
    // vanishing from a shortlist because a field couldn't be read.
    if (o.ratings.length && r.rating && !o.ratings.some((x) => sameRating(r.rating, x))) continue;
    const hay = normChem(`${r.service ?? ""} ${r.code}`);
    const matched: Candidate["matched"] = [
      ...o.askerTerms.filter((t) => has(hay, normChem(t))).map((term) => ({ term, how: "asker" as const })),
      ...o.companyTerms.filter((t) => has(hay, normChem(t))).map((term) => ({ term, how: "company" as const })),
      ...o.leadTerms.filter((t) => has(hay, normChem(t))).map((term) => ({ term, how: "lead" as const })),
    ];
    if (matched.length === 0) continue;
    out.push({ ...r, matched });
  }
  const rank = (c: Candidate) => (c.matched.some((m) => m.how === "asker") ? 0 : c.matched.some((m) => m.how === "company") ? 1 : 2)
    + (o.ratings.length && !c.rating ? 3 : 0);
  return out.sort((a, b) => rank(a) - rank(b) || a.code.localeCompare(b.code));
}

/** The fields on which the candidates differ — what to ask for next. */
export function distinguishers(cands: Candidate[]): Array<{ field: string; values: string[] }> {
  const fields = new Map<string, Set<string>>();
  const put = (k: string, v?: string) => { if (!v) return; const s = fields.get(k) ?? new Set<string>(); s.add(v.trim()); fields.set(k, s); };
  for (const c of cands) {
    put("Rating", c.rating);
    for (const [k, v] of Object.entries(c.attrs ?? {})) if (!/^services?$/i.test(k)) put(k, v);
  }
  return [...fields].filter(([, v]) => v.size > 1).map(([field, v]) => ({ field, values: [...v].slice(0, 6) }))
    .sort((a, b) => b.values.length - a.values.length).slice(0, 6);
}

/** The marked catalogs a question names, by the name a person gave them:
 *  "what piping spec…" names a catalog called "Piping specs". */
export function catalogsNamedIn(question: string, names: string[]): string[] {
  const stem = (w: string) => w.toLowerCase().replace(/(ies)$/, "y").replace(/(s|es)$/, "");
  const q = new Set(question.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).map(stem));
  return [...new Set(names)].filter((n) => {
    const words = n.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !["the", "and", "our", "for", "all"].includes(w)).map(stem);
    return words.length > 0 && words.every((w) => q.has(w));
  });
}

/** Where a library explains how to select and what its codes mean: its
 *  selection section ("Line Class Selection") and its code legend ("the
 *  first character defines…", "Designator Codes"). Generic catalog words —
 *  the library's own text supplies the procedure. */
export function guideTerms(question: string): string[] {
  const q = question.toLowerCase();
  const noun = /\bmaterial/.test(q) ? "material" : /\bgasket/.test(q) ? "gasket" : "class";
  return [`${noun} selection`, "first character", "designator"];
}

/** The narrowed list as the answer model reads it — the facts only; how to
 *  answer a selection question is a Reasoning Skill the workspace owns. */
export function selectionBlock(cands: Candidate[], o: {
  ratings: string[]; askerTerms: string[]; companyTerms: string[]; total: number; cite: (c: Candidate) => number | null;
}): string {
  if (cands.length === 0) {
    return `\n\nCATALOG FILTERED — the catalog of ${o.total} classes was filtered by ${o.ratings.length ? `rating ${o.ratings.join("/")}` : "no rating"} ` +
      `and the words ${[...o.askerTerms, ...o.companyTerms].map((t) => `"${t}"`).join(", ")}: NO entry matched.`;
  }
  const strong = cands.filter((c) => c.matched.some((m) => m.how !== "lead"));
  const shown = (strong.length ? strong : cands).slice(0, 24);
  const lines = shown.map((c) => {
    const why = c.matched.map((m) => (m.how === "asker" ? `"${m.term}" (asker's word)` : m.how === "company" ? `"${m.term}" (company's word for it)` : `"${m.term}" (related only)`)).join(", ");
    const fields = [c.rating ? `rating ${c.rating}` : "rating not recorded — read it on the page or from the code's legend",
      ...Object.entries(c.attrs ?? {}).filter(([k]) => !/^services?$/i.test(k)).slice(0, 4).map(([k, v]) => `${k} ${v}`)].filter(Boolean).join(" · ");
    const n = o.cite(c);
    return `- ${c.code}${n ? ` [${n}]` : ""} — ${c.catalog ? `${c.catalog}, ` : ""}${c.documentName.replace(/\.pdf$/i, "")} p.${c.page} — for: "${(c.service ?? "").slice(0, 160)}"${fields ? ` — ${fields}` : ""} — matched ${why}`;
  });
  const split = distinguishers(shown);
  return "\n\nCATALOG FILTERED — every catalog entry in the libraries " +
    `(${o.total}) was filtered by ${o.ratings.length ? `rating ${o.ratings.map((r) => `Class ${r}`).join(" or ")}` : "use only (no rating given)"} ` +
    `and by the words ${[...o.askerTerms.map((t) => `"${t}"`), ...o.companyTerms.map((t) => `"${t}" (the company's word for it)`)].join(", ")}. ` +
    `${strong.length || cands.length} matched${strong.length && strong.length < cands.length ? ` (${cands.length - strong.length} more only on a related word)` : ""}:\n` +
    lines.join("\n") +
    (split.length ? `\nTHEY DIFFER ON: ${split.map((d) => `${d.field} (${d.values.join(" / ")})`).join("; ")}.` : "") +
    "\nA table of these entries is shown to the user with your answer.";
}
