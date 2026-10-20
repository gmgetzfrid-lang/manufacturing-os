// lib/knowledgeMirrorAccess.ts — what /api/knowledge/mirror-url answers, in
// words both the route and the knowledge viewer use (isomorphic: no imports).
//
// intelligence KACL-5 criterion 4 / KACL-7 criterion 3 (Round G, I-29): a
// SOURCE-LINKED knowledge mirror (a knowledge_documents row that mirrors a
// controlled document) never hands the browser its storage key. The library
// list no longer selects `file_key` for those rows (lib/knowledge.ts
// listKnowledgeDocuments), and the viewer opens a mirror's page by asking
// /api/knowledge/mirror-url for a short-lived signed URL; that route decides
// through the one read predicate the bytes door applies (I-12) and returns a
// URL, never the key. Direct uploads keep their key and open exactly as
// before.

/** The caller may not read the mirror's source document: no key, no URL, no
 *  bytes — and the viewer says the source is restricted. */
export const MIRROR_SOURCE_RESTRICTED =
  "This page comes from a controlled document you don't have access to — its source is restricted, so it can't be opened here.";

/** The access check could not be made (a lookup failed): closed, and said. */
export const MIRROR_ACCESS_UNVERIFIED =
  "Couldn't verify your access to this document's source — try again.";

/** The mirror's stored file is under ANOTHER workspace's storage prefix, so
 *  it is not this workspace's to open: closed, and said. Permanent — a
 *  re-sync copies the source revision's file reference unchanged, so it
 *  does not move the file. */
export const MIRROR_KEY_OUTSIDE_WORKSPACE =
  "This mirrored file is stored in another workspace's storage area, so it can't be opened from this library. Open the source document in Document Control instead.";

/** The mirror's stored file is not a revision of the document it says it
 *  mirrors, so the decision could not be made about that document: closed.
 *  A re-sync re-points a mirror only when its source publishes a new
 *  revision, so this does not promise one fixes it. */
export const MIRROR_UNBOUND =
  "This mirrored file no longer matches a revision of its source document, so access to it can't be checked and it can't be opened here. Open the source document in Document Control instead.";

/** The mirror's stored key is one the storage guard refuses (a URL, a
 *  traversal segment, a control byte): it can never be signed. Permanent. */
export const MIRROR_KEY_INVALID =
  "This mirrored file's stored key is invalid, so it can't be opened — a document controller must repair the source document's file.";

/** No such knowledge document in a workspace the caller belongs to. */
export const MIRROR_NOT_FOUND = "That document is no longer in the library.";

/** A direct upload is not a mirror: it opens from its own stored file. */
export const MIRROR_IS_UPLOAD = "This document was uploaded directly to the library — it opens from its own stored file.";
