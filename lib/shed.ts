// lib/shed.ts
//
// The space-saver's brain (Machine A): pick the LEAST-necessary binaries to shed
// to a cold archive first. Pure + deterministic so it's unit-tested without a DB.
//
// "Least necessary" = a revision that has already been superseded (a newer rev
// exists) and has aged past a grace window. Its metadata, checksum and change
// reason stay in the DB forever — only the heavy binary leaves R2, into a named
// offline archive the user holds. Current revisions are NEVER eligible.

export interface ShedCandidateRow {
  id: string;
  file_url?: string | null;
  size?: number | null;
  superseded_at?: string | null;
  archived_at?: string | null;
  created_at?: string | null;
  revision_label?: string | null;
  record_id?: string | null;
}

export interface ShedSelection {
  selected: ShedCandidateRow[];
  totalBytes: number;
  totalCount: number;
  /** Eligible rows that were left because the target was already met. */
  skipped: number;
}

export interface ShedOptions {
  /** Only shed revisions superseded at least this many days ago. */
  olderThanDays: number;
  /** Reference time (defaults to now). */
  now?: Date;
  /** Stop once this many bytes are selected. Omit to take everything eligible. */
  targetBytes?: number | null;
}

/** True when a row is a safe shed candidate: superseded, aged, has a binary,
 *  and not already archived. */
export function isEligible(row: ShedCandidateRow, cutoff: Date): boolean {
  if (!row.file_url) return false;
  if (row.archived_at) return false;            // already shed
  if (!row.superseded_at) return false;          // current revision — never
  if (!(Number(row.size) > 0)) return false;     // nothing to reclaim
  const sup = Date.parse(row.superseded_at);
  if (!Number.isFinite(sup)) return false;
  return sup <= cutoff.getTime();
}

/**
 * Choose what to shed, least-necessary first. Ordering: oldest-superseded first
 * (the least likely to be needed), tie-broken by larger size (frees space
 * faster). When targetBytes is set, stops as soon as enough is selected.
 */
export function selectShedCandidates(rows: ShedCandidateRow[], opts: ShedOptions): ShedSelection {
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - opts.olderThanDays * 86400 * 1000);

  const eligible = rows
    .filter((r) => isEligible(r, cutoff))
    .sort((a, b) => {
      const sa = Date.parse(a.superseded_at as string);
      const sb = Date.parse(b.superseded_at as string);
      if (sa !== sb) return sa - sb;                    // oldest superseded first
      return (Number(b.size) || 0) - (Number(a.size) || 0); // then biggest
    });

  const target = opts.targetBytes ?? null;
  const selected: ShedCandidateRow[] = [];
  let totalBytes = 0;
  for (const r of eligible) {
    if (target != null && totalBytes >= target) break;
    selected.push(r);
    totalBytes += Number(r.size) || 0;
  }

  return {
    selected,
    totalBytes,
    totalCount: selected.length,
    skipped: eligible.length - selected.length,
  };
}
