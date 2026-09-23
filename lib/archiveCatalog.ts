// lib/archiveCatalog.ts — the two pure decisions the offline-archive catalog
// makes per row (document-control RET-13). Pure so the retry path is testable
// without rendering the storage page.
//
// The documented recovery for a failed R2 delete is "run Reclaim on it again
// from the catalog". shed/commit stamps archived_at FIRST and deletes SECOND,
// so after a partial delete failure every linked row is stamped, the archive
// reads "committed", and the Reclaim button — rendered only for "pending" —
// never appeared. Both commit routes now persist the delete shortfall on the
// archives row (`reclaim_shortfall`, migration 20261077); the catalog offers
// Reclaim whenever it is non-zero, and routes the retry by which table holds
// ANY linked rows, not by the pending count alone.

export interface CatalogRowState {
  status: "full" | "producing" | "pending" | "committed" | "empty";
  docPending: number; docCommitted: number;
  ticketPending: number; ticketCommitted: number;
  /** Stamped keys the last commit could not delete (still billed). */
  reclaimShortfall?: number;
}

/** True when the catalog must offer "Reclaim": rows still awaiting reclaim,
 *  OR a committed archive whose last commit left keys in the bucket. */
export function catalogNeedsReclaim(row: CatalogRowState): boolean {
  if (row.status === "pending") return true;
  return row.status === "committed" && (row.reclaimShortfall ?? 0) > 0;
}

/** Which commit endpoint a retry belongs to: decided by which table holds ANY
 *  linked rows (pending + committed). A document archive whose rows are all
 *  stamped has docPending 0 — the old `docPending > 0 ? doc : ticket` rule
 *  sent exactly that archive to the ticket endpoint, which found nothing and
 *  reported "space reclaimed". */
export function catalogCommitTarget(row: CatalogRowState): "doc" | "ticket" {
  const docs = row.docPending + row.docCommitted;
  const tickets = row.ticketPending + row.ticketCommitted;
  return tickets > docs ? "ticket" : "doc";
}

/** The one-line explanation of a row's reclaim state for the catalog chip. */
export function catalogReclaimLabel(row: CatalogRowState): string | null {
  if (row.status === "pending") return "awaiting reclaim — cloud bytes still billed";
  if (row.status === "committed" && (row.reclaimShortfall ?? 0) > 0) {
    return `reclaimed, but ${row.reclaimShortfall} cloud object(s) failed to delete and are still billed — run Reclaim again`;
  }
  return null;
}
