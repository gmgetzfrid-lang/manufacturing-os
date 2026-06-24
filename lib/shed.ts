// lib/shed.ts
//
// The space-saver's brain (Machine A) for the document-control library.
//
// Rule (per the product owner): keep the last N revisions of each controlled
// document instantly available; archive everything OLDER than those N to cold
// storage. It's a history-depth rule, not an age rule — you always keep the N
// most recent revisions hot (which always includes the current one, so the
// current revision is never shed). Metadata, checksum and change reason for the
// archived revisions stay in the DB forever; only the heavy binary moves.
//
// Pure + deterministic so it's unit-tested without a DB.

export interface ShedCandidateRow {
  id: string;
  file_url?: string | null;
  size?: number | null;
  superseded_at?: string | null;
  archived_at?: string | null;
  /** Set once captured into an un-committed archive — counted toward keep-N but
   *  never re-selected, so a second produce can't re-point it to a new archive. */
  archive_id?: string | null;
  created_at?: string | null;
  revision_label?: string | null;
  record_id?: string | null;
}

export interface ShedSelection {
  selected: ShedCandidateRow[];
  totalBytes: number;
  totalCount: number;
  /** Eligible rows left because the byte target was already met. */
  skipped: number;
}

export interface ShedOptions {
  /** Keep the N most-recent revisions of each document hot (>=1). */
  keepPerDoc: number;
  /** Optional extra age floor: only shed if also superseded this long ago. */
  olderThanDays?: number;
  /** Reference time (defaults to now). */
  now?: Date;
  /** Stop once this many bytes are selected. Omit to take everything eligible. */
  targetBytes?: number | null;
}

const recencyTs = (r: ShedCandidateRow) => Date.parse(r.created_at || r.superseded_at || "") || 0;
const supersededTs = (r: ShedCandidateRow) => Date.parse(r.superseded_at || r.created_at || "") || 0;

/** True when a row is a safe shed candidate: has a binary, isn't already
 *  archived, is genuinely superseded (never the current revision), and — if an
 *  age floor is given — was superseded before the cutoff. */
export function isEligible(row: ShedCandidateRow, cutoff: Date | null): boolean {
  if (!row.file_url) return false;
  if (row.archived_at) return false;
  if (row.archive_id) return false; // already captured into an un-committed archive — don't re-point
  if (!(Number(row.size) > 0)) return false;
  if (!row.superseded_at) return false; // safety belt — current revisions never qualify
  if (cutoff) {
    const sup = Date.parse(row.superseded_at);
    if (!Number.isFinite(sup) || sup > cutoff.getTime()) return false;
  }
  return true;
}

/**
 * Choose what to shed: per document, keep the N newest revisions and consider
 * everything older. Among those, take eligible rows oldest-first; when
 * targetBytes is set, stop as soon as enough is selected.
 */
export function selectShedCandidates(rows: ShedCandidateRow[], opts: ShedOptions): ShedSelection {
  const keepN = Math.max(1, Math.floor(opts.keepPerDoc));
  const now = opts.now ?? new Date();
  const cutoff = opts.olderThanDays && opts.olderThanDays > 0
    ? new Date(now.getTime() - opts.olderThanDays * 86400 * 1000)
    : null;

  // Group revisions by their document, newest first, and take everything past N.
  const groups = new Map<string, ShedCandidateRow[]>();
  for (const r of rows) {
    const key = r.record_id || r.id;
    const g = groups.get(key);
    if (g) g.push(r); else groups.set(key, [r]);
  }
  const beyondKeep: ShedCandidateRow[] = [];
  for (const group of groups.values()) {
    // Newest first; break ties on id (descending) so keep-N is deterministic
    // even when revisions share a created_at (backfills, identical-second saves).
    group.sort((a, b) => (recencyTs(b) - recencyTs(a)) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    beyondKeep.push(...group.slice(keepN)); // older than the last N
  }

  const eligible = beyondKeep
    .filter((r) => isEligible(r, cutoff))
    // Oldest superseded first; tie-break on id so a byte-target cut is stable.
    .sort((a, b) => (supersededTs(a) - supersededTs(b)) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

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
