// lib/knowledgeHealth.ts — is the knowledge library a true copy of its
// linked document libraries? Pure classification, shared by the health
// report and its tests.
//
// Every document in a linked source gets EXACTLY ONE status, so the
// buckets add up to the source's real total and nothing can hide in a gap:
//
//   indexed      mirrored, current revision, every page read
//   partial      mirrored and "ready", but fewer pages read than it has
//   indexing     being read right now
//   stuck        marked "indexing" but nothing has moved for a long time
//   waiting      queued to be read (new, or a new revision)
//   outdated     mirrored, but the document has a newer revision
//   failed       reading it failed (the reason is kept)
//   missing      should be mirrored and isn't — the sync never got to it
//   retired      should be mirrored; its index is set aside and will be
//                restored by the next sync (nothing to pay)
//   notPdf       its current file isn't a PDF (CAD, image…) — can't be read
//   noFile       no current file attached
//   heldBack     a controller held it back from AI
//   notCurrent   superseded / void / archived — the AI reads only what's in force
//
// Index entries NOT backed by a wanted document are "leftovers": the next
// complete sync retires them.

export type HealthStatus =
  | "indexed" | "partial" | "indexing" | "stuck" | "waiting" | "outdated" | "failed"
  | "missing" | "retired" | "notPdf" | "noFile" | "heldBack" | "notCurrent";

/** Fixable by Repair (re-sync / re-queue). The rest are facts about the file. */
export const FIXABLE: ReadonlySet<HealthStatus> = new Set(["partial", "stuck", "outdated", "failed", "missing", "retired"]);
/** Expected never to be indexed — not a fault, but they explain the gap. */
export const NOT_INDEXABLE: ReadonlySet<HealthStatus> = new Set(["notPdf", "noFile", "heldBack", "notCurrent"]);

export const STATUS_LABEL: Record<HealthStatus, string> = {
  indexed: "Indexed",
  partial: "Partly read",
  indexing: "Indexing now",
  stuck: "Stuck",
  waiting: "Waiting to index",
  outdated: "Newer revision not indexed",
  failed: "Failed",
  missing: "Not in the index",
  retired: "Set aside — restores on sync",
  notPdf: "Not a PDF",
  noFile: "No file attached",
  heldBack: "Held back from AI",
  notCurrent: "Superseded or archived",
};

export interface SourceDocFacts {
  id: string;
  name: string;
  /** Why the AI may not read it, or null when it may. */
  blocked: "held_back" | "out_of_scope" | "not_current" | "no_file" | null;
  currentVersionId: string | null;
  /** The current revision's file, when known. */
  fileUrl: string | null;
  fileType: string | null;
}

export interface MirrorFacts {
  id: string;
  status: string;
  sourceVersionId: string | null;
  pagesIndexed: number;
  pageCount: number | null;
  error: string | null;
  /** Last time the row changed, ms since epoch (for "stuck"). */
  touchedAt: number | null;
}

export const STUCK_AFTER_MS = 45 * 60_000;

export const isPdfFile = (fileUrl: string | null, fileType: string | null): boolean =>
  (fileType ?? "").toLowerCase().includes("pdf") || (fileUrl ?? "").toLowerCase().split("?")[0].endsWith(".pdf");

/** One status for one source document. `mirror` is its index entry in THIS
 *  library (retired or not); `retiredElsewhere` = a retired copy exists in
 *  another knowledge library of the org. */
export function classifyDoc(doc: SourceDocFacts, mirror: MirrorFacts | null, now: number, retiredElsewhere = false): HealthStatus {
  if (doc.blocked === "held_back") return "heldBack";
  if (doc.blocked === "not_current") return "notCurrent";
  if (doc.blocked === "no_file" || !doc.currentVersionId) return "noFile";
  if (!isPdfFile(doc.fileUrl, doc.fileType)) return "notPdf";
  if (!mirror) return retiredElsewhere ? "retired" : "missing";
  if (mirror.status === "retired") return "retired";
  if (mirror.sourceVersionId && mirror.sourceVersionId !== doc.currentVersionId) return "outdated";
  if (mirror.status === "stale") return "waiting";
  if (mirror.status === "pending") return "waiting";
  if (mirror.status === "error") return "failed";
  if (mirror.status === "indexing") {
    return mirror.touchedAt !== null && now - mirror.touchedAt > STUCK_AFTER_MS ? "stuck" : "indexing";
  }
  if (mirror.status === "ready") {
    if (!mirror.pageCount || mirror.pagesIndexed <= 0) return "partial";
    return mirror.pagesIndexed < mirror.pageCount ? "partial" : "indexed";
  }
  return "waiting";
}

export interface HealthItem { id: string; name: string; mirrorId: string | null; detail: string | null }

export interface HealthSummary {
  /** Documents in the linked sources (every one of them). */
  total: number;
  counts: Record<HealthStatus, number>;
  /** Up to `sampleSize` examples per status. */
  samples: Partial<Record<HealthStatus, HealthItem[]>>;
  /** Documents that should be searchable. */
  indexable: number;
  /** Index entries with no wanted document behind them. */
  leftovers: HealthItem[];
  healthy: boolean;
}

export function summarize(
  docs: SourceDocFacts[],
  mirrorsByDoc: Map<string, MirrorFacts>,
  extraMirrors: Array<{ id: string; name: string; sourceDocumentId: string; status: string }>,
  now: number,
  opts: { retiredElsewhere?: Set<string>; sampleSize?: number } = {},
): HealthSummary {
  const sampleSize = opts.sampleSize ?? 25;
  const counts = Object.fromEntries(Object.keys(STATUS_LABEL).map((k) => [k, 0])) as Record<HealthStatus, number>;
  const samples: Partial<Record<HealthStatus, HealthItem[]>> = {};
  const wantedIds = new Set<string>();
  for (const d of docs) {
    const m = mirrorsByDoc.get(d.id) ?? null;
    const st = classifyDoc(d, m, now, opts.retiredElsewhere?.has(d.id) ?? false);
    counts[st]++;
    if (!NOT_INDEXABLE.has(st)) wantedIds.add(d.id);
    const list = samples[st] ?? (samples[st] = []);
    if (list.length < sampleSize) {
      const detail = st === "failed" ? m?.error ?? null
        : st === "partial" ? `${m?.pagesIndexed ?? 0} of ${m?.pageCount ?? "?"} pages`
        : st === "notPdf" ? (d.fileUrl ?? "").split("?")[0].split(".").pop()?.toUpperCase() ?? null
        : null;
      list.push({ id: d.id, name: d.name, mirrorId: m?.id ?? null, detail });
    }
  }
  const leftovers = extraMirrors
    .filter((m) => m.status !== "retired" && !wantedIds.has(m.sourceDocumentId))
    .map((m) => ({ id: m.sourceDocumentId, name: m.name, mirrorId: m.id, detail: null }));
  const indexable = docs.length - [...NOT_INDEXABLE].reduce((n, k) => n + counts[k], 0);
  const healthy = [...FIXABLE].every((k) => counts[k] === 0) && leftovers.length === 0;
  return { total: docs.length, counts, samples, indexable, leftovers, healthy };
}
