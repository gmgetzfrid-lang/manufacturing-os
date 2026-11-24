// lib/ask/pageTargets.ts — which printed pages the answer step LOOKS at.
//
// The answer model gets a handful of page images (MAX_DEEP_READ_PAGES).
// Which pages fill those seats decides whether it can read a drawing or a
// table at all — text extraction keeps a figure's labels and loses the
// drawing. The old rule counted every "Table 1" / "Figure 3" mentioned
// across ~170 retrieved passages, kept the four most frequent, and resolved
// each label to whichever document had one. A person asking about "EP 5-5-1
// Figure 4" got a pump test plan's table, an electrical detail and a
// methanol unit's figure instead of the page they named, while the index
// had recorded exactly where Figure 4 lives.
//
// The order now, each step only adds pages not already in:
//   1. what the person NAMED (this question and their recent turns),
//      resolved in the document they named or the conversation is about;
//   2. figures and tables the passages most RELEVANT to the question point
//      to, resolved in the SAME document as the passage pointing;
//   3. figure pages among those relevant passages (a figure page's text is
//      its labels — the drawing is the content);
//   4. the top-ranked passage pages.
// A label is never resolved by guessing another document's "Table 1".
//
// Pure (no I/O): the handler supplies the passages and the recorded
// figure/table locations (knowledge_page_entities, kind 'anchor').

import { hasFigureCaption, proseSentences } from "@/lib/drawingText";

export interface PassageLike {
  document_id: string;
  page: number;
  content: string;
}

export interface Anchor {
  tag: string;          // "FIGURE 4", "TABLE 2B" (as recorded at indexing)
  document_id: string;
  page: number;
}

export interface PageTarget {
  documentId: string;
  page: number;
  /** Why this page is attached — shown to the model and kept in the trace. */
  why: "named" | "pointed" | "figure" | "top";
  label?: string;
}

const REF_RE = /\b(?:Table|Fig(?:ure)?\.?|Chart|Detail)\s+[A-Z0-9][A-Z0-9.\-]{0,10}/gi;

/** "fig. 4" / "Figure 4" / "figure 4." → "FIGURE 4". */
export function normalizeLabel(label: string): string {
  return label.toUpperCase()
    .replace(/^FIG(?:URE)?\.?\s*/, "FIGURE ")
    .replace(/\s+/g, " ")
    .replace(/[.\-]+$/, "")
    .trim();
}

/** Figure/table labels written in a piece of text, in order, de-duplicated. */
export function refsIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(REF_RE)) {
    const l = normalizeLabel(m[0]);
    if (!out.includes(l)) out.push(l);
  }
  return out;
}

/** Does this anchor tag name this label? Tags are recorded with stray
 *  punctuation sometimes ("FIGURE 5A."), so compare normalized. */
const sameLabel = (tag: string, label: string) => normalizeLabel(tag) === label;

/** A page whose text is a figure's caption and labels, not prose — the
 *  same test the indexer uses to decide a page must be looked at. */
export function isFigurePage(text: string): boolean {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= 1680 && hasFigureCaption(t) && proseSentences(t) <= 2;
}

const STOP = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "onto", "can", "you", "are", "was",
  "what", "when", "where", "which", "does", "have", "has", "not", "but", "how", "make", "like",
  "use", "used", "will", "would", "should", "could", "about", "there", "their", "them", "then",
  "than", "also", "any", "all", "our", "your", "its", "it's", "is", "be", "to", "of", "in", "on",
  // Words about documents, not the subject: "figure 4 shows it" is about
  // a coupling, not about figures.
  "figure", "fig", "table", "chart", "detail", "page", "section", "paragraph", "document", "show",
  "shows", "says", "wrong", "right", "exactly", "talking", "think", "know", "tell", "need",
]);

/** Content words of a question, lightly stemmed ("couplings" → "coupling",
 *  "welded" → "weld"). */
export function contentWords(text: string): string[] {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().match(/[a-z][a-z0-9]{2,}/g) ?? []) {
    if (STOP.has(raw)) continue;
    out.add(stem(raw));
  }
  return [...out];
}

export function stem(w: string): string {
  return w
    .replace(/(?:ings|ing)$/, "")
    .replace(/ies$/, "y")
    .replace(/([^s])s$/, "$1")
    .replace(/ed$/, "");
}

const wordsOf = (content: string) => new Set((content.toLowerCase().match(/[a-z][a-z0-9]{2,}/g) ?? []).map(stem));

/** The passages most about the question, best first. Each question word a
 *  passage holds counts more the rarer it is among the passages: "coupling"
 *  and "blind" outweigh "flange" and "weld", which half the pile mentions. */
export function mostRelevant<T extends PassageLike>(passages: T[], words: string[], cap: number): T[] {
  if (words.length === 0 || passages.length === 0) return [];
  const sets = passages.map((p) => wordsOf(p.content));
  const df = new Map<string, number>();
  for (const w of words) df.set(w, sets.reduce((n, s) => n + (s.has(w) ? 1 : 0), 0));
  const n = passages.length;
  return passages
    .map((p, i) => {
      let score = 0;
      for (const w of words) if (sets[i].has(w)) score += Math.log(1 + n / Math.max(1, df.get(w) ?? 1));
      return { p, i, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    // A passage that shares one common word with the question isn't
    // about it: keep those within reach of the best.
    .filter((x, _, all) => x.score >= all[0].score * 0.34)
    .slice(0, cap)
    .map((x) => x.p);
}

export function pickPageTargets(input: {
  /** The question, then the person's recent turns (most recent first).
   *  Together they say what the conversation is about: "you are wrong,
   *  figure 4 shows it" carries no subject of its own. */
  asked: string[];
  /** Retrieved passages, best first. */
  passages: PassageLike[];
  /** Recorded figure/table locations for the labels in play. */
  anchors: Anchor[];
  /** Documents the question names, then the ones the conversation is about. */
  namedDocIds: string[];
  conversationDocIds: string[];
  max: number;
}): PageTarget[] {
  const { asked, passages, anchors, namedDocIds, conversationDocIds, max } = input;
  const out: PageTarget[] = [];
  const seen = new Set<string>();
  const add = (t: PageTarget) => {
    const k = `${t.documentId}:${t.page}`;
    if (seen.has(k) || out.length >= max) return;
    seen.add(k);
    out.push(t);
  };
  const retrievedDocs = [...new Set(passages.map((p) => p.document_id))];
  const anchorIn = (label: string, docId: string) =>
    anchors.find((a) => a.document_id === docId && sameLabel(a.tag, label));

  // 1. Named by the person. Resolved in the document they named, then the
  //    one the conversation is about, then a document already retrieved;
  //    only when exactly one document has that label is it taken outright.
  for (const text of asked) {
    for (const label of refsIn(text)) {
      const docOrder = [...namedDocIds, ...conversationDocIds, ...retrievedDocs];
      let hit: Anchor | undefined;
      for (const d of docOrder) { hit = anchorIn(label, d); if (hit) break; }
      if (!hit) {
        const all = anchors.filter((a) => sameLabel(a.tag, label));
        if (new Set(all.map((a) => a.document_id)).size === 1) hit = all[0];
      }
      if (hit) add({ documentId: hit.document_id, page: hit.page, why: "named", label });
    }
  }

  // 2 + 3. The passages most about the question: what they point to (in
  //    their own document), and any that are themselves a figure page.
  const words = contentWords(asked.join(" "));
  for (const p of mostRelevant(passages, words, 10)) {
    for (const label of refsIn(p.content)) {
      const a = anchorIn(label, p.document_id);
      // A passage that IS the figure's own page names itself; that is the
      // figure-page case below, not a pointer.
      if (a && !(a.page === p.page)) add({ documentId: a.document_id, page: a.page, why: "pointed", label });
    }
    if (isFigurePage(p.content)) add({ documentId: p.document_id, page: p.page, why: "figure" });
  }

  // 4. The top-ranked passage pages.
  for (const p of passages.slice(0, 3)) add({ documentId: p.document_id, page: p.page, why: "top" });
  return out;
}

/** Labels whose locations the handler should look up: everything the
 *  person named, plus what the relevant passages point to. */
export function labelsToResolve(asked: string[], passages: PassageLike[]): string[] {
  const words = contentWords(asked.join(" "));
  const out = new Set<string>();
  for (const t of asked) for (const l of refsIn(t)) out.add(l);
  for (const p of mostRelevant(passages, words, 10)) for (const l of refsIn(p.content)) out.add(l);
  return [...out].slice(0, 24);
}
