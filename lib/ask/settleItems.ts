// lib/ask/settleItems.ts — the "To settle this" list of a draft answer, as
// things the tool can go and look for itself.

const SETTLE_SECTION = /(\*\*To settle this:\*\*)([\s\S]*?)(?=\n\*\*[A-Z][^*\n]{0,40}:\*\*|$)/;

/** The items the draft asks the user for (not its "Best answer" line). */
export function settleItems(answer: string): string[] {
  const m = answer.match(SETTLE_SECTION);
  if (!m) return [];
  return m[2].split("\n").map((l) => l.replace(/^\s*[-*]\s*/, "").trim())
    .filter((l) => l && !/^\*\*Best answer/i.test(l)).slice(0, 4);
}

const STOP = new Set(["the", "and", "for", "that", "this", "with", "from", "its", "would", "give", "gives", "section",
  "document", "pull", "look", "here", "shown", "which", "what", "are", "not", "per", "you", "see", "into", "under", "those"]);

/** An item, as a keyword search: citation markers, markdown and filler out.
 *  Searching INSIDE a named document, that document's own name is noise —
 *  pass it as `exclude` and only the topic remains ("Class 150 entries"). */
export function keywordsOf(item: string, exclude = "", max = 6): string {
  const skip = new Set(exclude.toLowerCase().split(/[^a-z0-9.-]+/).filter(Boolean));
  const words = item.replace(/\[\d+(?:,\s*\d+)*\]/g, " ").replace(/[*"“”—–(),;:]/g, " ")
    .split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w.toLowerCase()) && !skip.has(w.toLowerCase()));
  return [...new Set(words)].slice(0, max).join(" ");
}

/** The same search, loosened: numbers and codes required, any one other
 *  word — for when every word at once finds nothing. */
export function loosened(q: string): string {
  const words = q.split(/\s+/).filter(Boolean);
  const must = words.filter((w) => /\d/.test(w));
  const may = words.filter((w) => !/\d/.test(w));
  return must.length > 0 && may.length > 0 ? may.map((w) => [...must, w].join(" ")).join(" or ") : words.join(" or ");
}

/** Drop the items that name a document the library holds — the search
 *  already looked there; the asker should never be sent for it. */
export function dropLibraryAsks(answer: string, namesLibraryDoc: (line: string) => boolean): string {
  const m = answer.match(SETTLE_SECTION);
  if (!m) return answer;
  const kept = m[2].split("\n").filter((l) => !/^\s*[-*]\s/.test(l) || /Best answer/i.test(l) || !namesLibraryDoc(l)).join("\n");
  return kept === m[2] ? answer : answer.replace(m[0], `${m[1]}${kept}`);
}
