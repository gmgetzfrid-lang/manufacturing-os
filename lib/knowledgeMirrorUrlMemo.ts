// lib/knowledgeMirrorUrlMemo.ts — the knowledge viewer's per-mount memory of
// a source-linked mirror's signed URL (isomorphic: no imports).
//
// Ruled by the integrator at the I-29 merge, 2026-10-20 (DEC-90) — DEC-43
// frequency without the stale-revision bug. Every open of a mirror asks
// /api/knowledge/mirror-url, and every answer the bytes door signs for a
// controller served only by the controller tier writes one
// CONTROLLER_RESTRICTED_READ row (DEC-43, R4: one row per access). With no
// memory at all, a carousel that steps between two sources and back re-signs
// (and re-records) the same file on every step. The fix pass removed the
// module-wide cache because it was keyed by the knowledge document id alone,
// and a mirror keeps that id when its source publishes a new revision
// (lib/knowledgeSourceSync re-points file_key on the same row) — so a URL
// remembered by id opened the superseded revision's file.
//
// This memory is the middle: it lives inside ONE CitedPageViewer mount (the
// viewer creates it once per mount), it is keyed by (documentId, revision) —
// the source revision's document_versions id, else its revision label —
// NEVER by the document id alone (no revision known → nothing is remembered,
// every open asks), and an entry lives at most the window the route GRANTED,
// less a safety margin. A grant is filed under the revision the ROUTE says it
// signed, and looked up by the revision the page listed, so a stale listing
// never serves a URL for a revision it did not ask about. Resulting DEC-43
// frequency: at most one sign (one bypass row) per file per revision per
// viewer mount, within the granted window.

/** Which revision of a mirror — as the page lists it, or as the route says
 *  it signed it. */
export interface MirrorRevision {
  sourceVersionId?: string | null;
  sourceRev?: string | null;
}

/** What the route granted (lib/knowledge requestKnowledgeMirrorUrl). */
export interface MirrorUrlGrantLike extends MirrorRevision {
  url: string;
  /** The window the route GRANTED, in seconds; null/absent = not remembered. */
  expiresIn?: number | null;
}

/** An entry is dropped this many seconds before the granted window ends, so
 *  a remembered URL never expires while the PDF is still loading. */
export const MIRROR_URL_MEMO_MARGIN_SECONDS = 60;

/** The memory key: (documentId, revision) — `null` when no revision is known,
 *  which means "never remembered" (never keyed by the document id alone). */
export function mirrorRevisionKey(documentId: string | null | undefined, rev: MirrorRevision | null | undefined): string | null {
  if (!documentId) return null;
  const v = rev?.sourceVersionId?.trim();
  if (v) return `${documentId}\u0000v:${v}`;
  const r = rev?.sourceRev?.trim();
  if (r) return `${documentId}\u0000r:${r}`;
  return null;
}

export interface MirrorUrlMemo {
  /** The mirror's URL for this revision: remembered within the granted
   *  window, else asked of `sign` (whose grant is remembered under the
   *  revision it says it signed). */
  open(documentId: string, revision: MirrorRevision | null | undefined, sign: (documentId: string) => Promise<MirrorUrlGrantLike>): Promise<string>;
  /** Entries currently held (tests). */
  size(): number;
}

export function createMirrorUrlMemo(now: () => number = () => Date.now()): MirrorUrlMemo {
  const entries = new Map<string, { url: string; until: number }>();
  return {
    async open(documentId, revision, sign) {
      const key = mirrorRevisionKey(documentId, revision);
      if (key) {
        const hit = entries.get(key);
        if (hit && now() < hit.until) return hit.url;
        if (hit) entries.delete(key);
      }
      const grant = await sign(documentId);
      const signedKey = mirrorRevisionKey(documentId, grant);
      const windowSeconds = typeof grant.expiresIn === "number" && Number.isFinite(grant.expiresIn)
        ? grant.expiresIn - MIRROR_URL_MEMO_MARGIN_SECONDS
        : 0;
      if (signedKey && windowSeconds > 0) entries.set(signedKey, { url: grant.url, until: now() + windowSeconds * 1000 });
      return grant.url;
    },
    size: () => entries.size,
  };
}
