// lib/hybridRank.ts — fusing keyword and meaning without comparing apples.
//
// Two retrievers, two incompatible scales. Postgres `ts_rank` returns
// something like 0.06 and means "this many query terms, weighted". Cosine
// similarity returns 0.83 and means "these vectors point the same way".
// Adding them, averaging them, or normalising them against each other are all
// the same mistake dressed differently: the numbers do not measure the same
// thing, so any arithmetic on them is superstition.
//
// Reciprocal Rank Fusion sidesteps it entirely by throwing the scores away
// and keeping only the ORDER. A document that both retrievers rank highly
// wins; a document only one of them found still places, which is the whole
// point — keyword search catches "PSV-2001" that no embedding will, and
// vector search catches "what holds the pump down" when the standard says
// "anchor bolt design", and neither can do the other's job.
//
// Pure and unit-tested, because retrieval quality is the difference between
// an assistant people use and one they stop trusting after two bad answers.

/** One retriever's output, best first. Only the order is used. */
export interface RankedList<T> {
  /** What the list is, for explaining the result to a human. */
  source: string;
  items: T[];
}

export interface FusedItem<T> {
  item: T;
  /** Fused score. Comparable only within one fusion, never across runs. */
  score: number;
  /** Which retrievers found it, and at what position (1-based). */
  found: Array<{ source: string; rank: number }>;
}

/**
 * The RRF constant. 60 is the value from the original paper and the one every
 * implementation uses; it damps the difference between rank 1 and rank 2 so a
 * single retriever's confident-but-wrong top hit can't dominate a document
 * both retrievers agreed on.
 */
export const RRF_K = 60;

/**
 * Fuse ranked lists.
 *
 * `identity` maps an item to its stable id — the same passage arriving from
 * two retrievers has to be recognised as one passage, or fusion degenerates
 * into concatenation.
 */
export function fuseRankings<T>(
  lists: ReadonlyArray<RankedList<T>>,
  identity: (item: T) => string,
  options: { k?: number; weights?: Record<string, number> } = {},
): Array<FusedItem<T>> {
  const k = options.k ?? RRF_K;
  const weights = options.weights ?? {};
  const merged = new Map<string, FusedItem<T>>();

  for (const list of lists) {
    const weight = weights[list.source] ?? 1;
    list.items.forEach((item, index) => {
      const id = identity(item);
      const rank = index + 1;
      const contribution = weight / (k + rank);
      const existing = merged.get(id);
      if (existing) {
        existing.score += contribution;
        existing.found.push({ source: list.source, rank });
      } else {
        merged.set(id, { item, score: contribution, found: [{ source: list.source, rank }] });
      }
    });
  }

  return [...merged.values()].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    // Deterministic tie-break: agreement first, then the better single rank.
    // Without this the order depends on Map insertion and two identical runs
    // can disagree, which makes retrieval bugs impossible to reproduce.
    if (b.found.length !== a.found.length) return b.found.length - a.found.length;
    return Math.min(...a.found.map((f) => f.rank)) - Math.min(...b.found.map((f) => f.rank));
  });
}

/**
 * Why did this passage surface? In words, for the reader.
 *
 * "Both keyword and meaning search found this" is a meaningfully different
 * statement from "only the meaning search found this", and a controller
 * deciding whether to trust an answer deserves to know which they're looking
 * at.
 */
export function explainFusion(found: ReadonlyArray<{ source: string; rank: number }>): string {
  if (found.length === 0) return "no retriever found this";
  if (found.length === 1) return `${found[0].source} only (#${found[0].rank})`;
  return `${found.map((f) => `${f.source} #${f.rank}`).join(" + ")}`;
}
