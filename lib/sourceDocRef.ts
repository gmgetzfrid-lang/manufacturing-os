// lib/sourceDocRef.ts
//
// Read side of the ticket → source-document backlink (LIFE-13).
//
// Three producers write `tickets.metadata.source_document`, with three
// different shapes:
//   * CheckInPanel        {id, document_number, title, rev, path: null}
//   * requests/new        {id, document_number, title, rev, path} — every
//                         field except id may be "" (searchParams defaults)
//   * lib/transitionIn    {id, number, title} — `number`, no rev, no path
//
// This helper normalizes all three so the ticket page can render one card.
// Normalization is read-side on purpose: the stored blobs are historical
// records and the producers stay untouched here (the divergence itself is
// recorded as its own finding).

export interface SourceDocRef {
  id: string;
  documentNumber: string | null;
  title: string | null;
  rev: string | null;
  path: string | null;
}

const str = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t;
};

/** Parse `metadata.source_document` from any of its producer shapes.
 *  Returns null when there is no usable reference (no non-empty id). */
export function parseSourceDocument(
  metadata: Record<string, unknown> | null | undefined,
): SourceDocRef | null {
  const raw = metadata?.source_document;
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = str(r.id);
  if (!id) return null;
  return {
    id,
    documentNumber: str(r.document_number) ?? str(r.number),
    title: str(r.title),
    rev: str(r.rev),
    path: str(r.path),
  };
}

/** Compare the revision the request was raised against with the document's
 *  current revision. 'unknown' whenever either side is missing — a ticket
 *  that captured no rev must never claim freshness or drift. */
export function revDrift(
  capturedRev: string | null | undefined,
  currentRev: string | null | undefined,
): "same" | "drifted" | "unknown" {
  const a = str(capturedRev ?? null);
  const b = str(currentRev ?? null);
  if (!a || !b) return "unknown";
  return a.toLowerCase() === b.toLowerCase() ? "same" : "drifted";
}
