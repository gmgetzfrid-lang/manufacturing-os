// lib/knowledgeText.ts
//
// Pure text machinery for the AI knowledge libraries — no supabase, no
// network, no provider imports, so the unit tests exercise exactly what
// ingestion and ask-time use.

/** Split one PDF page's text into search-friendly chunks. Target ~1400 chars
 *  with sentence-boundary preference and 160-char overlap so a fact that
 *  straddles a boundary is findable from either side. */
export function chunkPageText(raw: string, target = 1400, overlap = 160): string[] {
  const text = raw.replace(/\s+/g, " ").trim();
  if (text.length < 40) return [];            // page furniture / stray marks
  if (text.length <= target) return [text];

  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + target, text.length);
    if (end < text.length) {
      // Prefer to break at a sentence end inside the last 40% of the window.
      const window = text.slice(start + Math.floor(target * 0.6), end);
      const lastStop = window.lastIndexOf(". ");
      if (lastStop > 0) end = start + Math.floor(target * 0.6) + lastStop + 1;
    }
    chunks.push(text.slice(start, end).trim());
    if (end >= text.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return chunks.filter((c) => c.length >= 40);
}

/** Pull a JSON array of strings out of model output that may be wrapped in
 *  prose or a code fence. Falls back to the raw question if nothing parses —
 *  a bad model answer must never kill the search step. */
export function parseSearchQueries(modelOutput: string, fallback: string): string[] {
  const tryParse = (s: string): string[] | null => {
    try {
      const v = JSON.parse(s) as unknown;
      if (Array.isArray(v)) {
        const strs = v.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
        return strs.length > 0 ? strs : null;
      }
    } catch { /* keep trying */ }
    return null;
  };

  const direct = tryParse(modelOutput.trim());
  if (direct) return direct.slice(0, 5);

  const match = modelOutput.match(/\[[\s\S]*?\]/);
  if (match) {
    const fromBlock = tryParse(match[0]);
    if (fromBlock) return fromBlock.slice(0, 5);
  }
  return [fallback];
}

/** Which [n] citation markers does the answer actually use? Ordered, deduped. */
export function extractCitationNumbers(answer: string): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const m of answer.matchAll(/\[(\d{1,2})\]/g)) {
    const n = Number(m[1]);
    if (n >= 1 && !seen.has(n)) { seen.add(n); out.push(n); }
  }
  return out;
}

export interface RetrievedChunk {
  id: string;
  document_id: string;
  page: number;
  content: string;
  rank: number;
}

/** Merge multi-query search results: dedupe by chunk id keeping best rank,
 *  order by rank, cap the count and each chunk's length so the prompt stays
 *  a predictable size on any provider. */
export function mergeRetrieved(
  batches: RetrievedChunk[][], cap = 14, maxChars = 1600,
): RetrievedChunk[] {
  const best = new Map<string, RetrievedChunk>();
  for (const batch of batches) {
    for (const c of batch) {
      const prev = best.get(c.id);
      if (!prev || c.rank > prev.rank) best.set(c.id, c);
    }
  }
  return [...best.values()]
    .sort((a, b) => b.rank - a.rank)
    .slice(0, cap)
    .map((c) => ({ ...c, content: c.content.slice(0, maxChars) }));
}
