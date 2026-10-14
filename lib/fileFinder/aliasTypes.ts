// lib/fileFinder/aliasTypes.ts — what a taught alias is, independent of where
// it is stored. The finder's query parser and ranker only ever see this shape.

export type FinderAliasKind = "unit" | "equipment" | "term";
export type FinderAliasOrigin = "human" | "ingest" | "usage";

export interface FinderAlias {
  id: string;
  orgId: string;
  /** What people type or say: "born", "U1-A", "the north furnace". */
  term: string;
  termCanonical: string;
  /** What the files actually say. For a unit alias, the codebook unit code
   *  or label ("crude"); for equipment, the tag; for a term, the word. */
  means: string;
  meansCanonical: string;
  kind: FinderAliasKind;
  origin: FinderAliasOrigin;
  /** Times a result reached through this alias was opened. Ranking signal. */
  hits: number;
  /** Times a chip expanded through this alias was removed by the user. */
  misses: number;
  note: string | null;
  createdByName: string | null;
  createdAt: string;
}

/** 0..1 confidence from origin plus what usage has taught since. */
export function aliasConfidence(a: Pick<FinderAlias, "origin" | "hits" | "misses">): number {
  const base = a.origin === "human" ? 0.9 : a.origin === "ingest" ? 0.6 : 0.4;
  const signal = (a.hits - a.misses) * 0.03;
  return Math.max(0.05, Math.min(1, base + signal));
}
