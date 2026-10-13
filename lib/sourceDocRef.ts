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
//
// drafting-flow Round G, DF-P2 (HAND-7 / HAND-3 base version): the canonical
// shape also carries `version_id` — the document_versions id the request was
// raised against, captured server-side by /api/tickets/create from the
// document's current_version_id at capture (or the version the producer
// names, when it is a version of that document) — so drift is decided by
// version id, never by comparing rev labels. null when it is not known (a
// requester who saw a rev that is no longer current, or a historical row).
//
// GAP-8: a request raised from several sheets keeps the PRIMARY sheet in the
// singular `source_document` (every existing reader keys on it) and lists
// every sheet, primary first, in `metadata.source_documents` beside it.
// `parseSourceDocuments` reads both.

export interface SourceDocRef {
  id: string;
  documentNumber: string | null;
  title: string | null;
  rev: string | null;
  path: string | null;
  /** HAND-7: the version the request was raised against (null: not known). */
  versionId: string | null;
}

/** The canonical stored shape (LIFE-15, plus HAND-7's version_id). */
export interface SourceDocumentRefRow {
  id: string;
  document_number: string | null;
  title: string | null;
  rev: string | null;
  version_id: string | null;
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
  return parseRef(metadata?.source_document);
}

/** One stored reference, any producer shape; null without a non-empty id. */
function parseRef(raw: unknown): SourceDocRef | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const id = str(r.id);
  if (!id) return null;
  return {
    id,
    documentNumber: str(r.document_number) ?? str(r.number),
    title: str(r.title),
    rev: str(r.rev),
    path: str(r.path),
    versionId: str(r.version_id),
  };
}

/** GAP-8: every source document a ticket names — the singular
 *  `source_document` (the primary sheet) first, then each entry of the
 *  `source_documents` array beside it — deduplicated by id. A single-source
 *  ticket (every historical row) reads as a list of one; no reference, none. */
export function parseSourceDocuments(
  metadata: Record<string, unknown> | null | undefined,
): SourceDocRef[] {
  const out: SourceDocRef[] = [];
  const seen = new Set<string>();
  const add = (r: SourceDocRef | null) => {
    if (r && !seen.has(r.id)) { seen.add(r.id); out.push(r); }
  };
  add(parseSourceDocument(metadata));
  const list = metadata?.source_documents;
  if (Array.isArray(list)) for (const raw of list) add(parseRef(raw));
  return out;
}

/** The ONE shape every producer writes (LIFE-15; HAND-7 adds version_id).
 *  Returns null without a non-empty id, so a producer can never write a
 *  reference to nothing. */
export function buildSourceDocumentRef(doc: {
  id?: string | null; documentNumber?: string | null; title?: string | null; rev?: string | null; versionId?: string | null;
}): SourceDocumentRefRow | null {
  const id = str(doc.id);
  if (!id) return null;
  return { id, document_number: str(doc.documentNumber), title: str(doc.title), rev: str(doc.rev), version_id: str(doc.versionId) };
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

/** One side of a drift comparison: the version id and the display rev. */
export interface DriftSide {
  versionId?: string | null;
  rev?: string | null;
}

/** Compare the revision the request was raised against with the document's
 *  current revision. HAND-7: when both sides carry a version id the answer
 *  is decided by the ids alone (two revisions can share a label — a reopen
 *  re-issue, a re-lettered branch — and one revision can be relabelled);
 *  otherwise by the rev labels, as for every row captured before version
 *  ids were (pass a plain string per side for that). 'unknown' whenever the
 *  deciding fact is missing on either side — a ticket that captured nothing
 *  must never claim freshness or drift. */
export function revDrift(
  captured: string | null | undefined | DriftSide,
  current: string | null | undefined | DriftSide,
): "same" | "drifted" | "unknown" {
  const side = (v: string | null | undefined | DriftSide): { versionId: string | null; rev: string | null } =>
    v != null && typeof v === "object"
      ? { versionId: str(v.versionId ?? null), rev: str(v.rev ?? null) }
      : { versionId: null, rev: str(v ?? null) };
  const a = side(captured);
  const b = side(current);
  if (a.versionId && b.versionId) return a.versionId === b.versionId ? "same" : "drifted";
  if (!a.rev || !b.rev) return "unknown";
  return a.rev.toLowerCase() === b.rev.toLowerCase() ? "same" : "drifted";
}
