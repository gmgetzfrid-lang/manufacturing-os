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
// The read side normalizes all three so the ticket page renders one card —
// historical rows keep every shape they were written in. Since LIFE-15 every
// producer writes through `buildSourceDocumentRef` below, so new rows share
// ONE canonical shape: {id, document_number, title, rev} with null (never "")
// for anything unknown and no `path` (it had no consumer).

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

/** The ONE shape every producer writes (LIFE-15). Returns null without a
 *  non-empty id, so a producer can never write a reference to nothing. */
export function buildSourceDocumentRef(doc: {
  id?: string | null; documentNumber?: string | null; title?: string | null; rev?: string | null;
}): { id: string; document_number: string | null; title: string | null; rev: string | null } | null {
  const id = str(doc.id);
  if (!id) return null;
  return { id, document_number: str(doc.documentNumber), title: str(doc.title), rev: str(doc.rev) };
}

/** LIFE-9: the unit a document belongs to, read the way the viewer hand-off
 *  reads it — the first custom-metadata value whose key names a unit/area. */
export function unitOfDocumentMetadata(metadata: Record<string, unknown> | null | undefined): string | null {
  if (!metadata || typeof metadata !== "object") return null;
  for (const [k, v] of Object.entries(metadata)) {
    if (/\bunit\b|\barea\b/i.test(k) && v != null && v !== "") return String(v);
  }
  return null;
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
