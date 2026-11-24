// lib/figurePages.ts — figure pages that were indexed as labels only.
//
// Until Nov 24 the indexer looked at a page as an image only when it had
// almost no text. A standard's figure page has its caption and the
// drawing's labels as text ("Figure 4 – Permissible Attachment Details for
// Couplings … 1/8 In. Max."), so it was never looked at, and what the
// drawing shows (a coupling set into what) was never in the index. This
// finds those pages so the documents holding them can be read again; the
// indexer then reuses every page it already has and looks only at these.
//
// Pure: the caller supplies the stored passage text.

import { hasFigureCaption, proseSentences } from "@/lib/drawingText";

export interface StoredPassage { document_id: string; page: number; content: string }

/** Is this page a figure whose drawing was never described? */
export function figureNotDescribed(pageText: string): boolean {
  const t = pageText.replace(/\s+/g, " ").trim();
  if (t.length > 1680 || !hasFigureCaption(t)) return false;
  // A description in sentences makes it prose; the older reader wrote it
  // in brackets ("[Two technical drawings showing …]").
  if (proseSentences(t) > 2) return false;
  if (/\[[^\]]{20,}\]/.test(t)) return false;
  return true;
}

/** Documents with figure pages to read, and those pages. */
export function figurePagesToRead(rows: StoredPassage[]): Map<string, number[]> {
  const pages = new Map<string, string[]>();
  for (const r of rows) {
    const k = `${r.document_id}:${r.page}`;
    const list = pages.get(k);
    if (list) list.push(r.content); else pages.set(k, [r.content]);
  }
  const out = new Map<string, number[]>();
  for (const [k, parts] of pages) {
    if (!figureNotDescribed(parts.join(" "))) continue;
    const [doc, page] = k.split(":");
    out.set(doc, [...(out.get(doc) ?? []), Number(page)].sort((a, b) => a - b));
  }
  return out;
}
