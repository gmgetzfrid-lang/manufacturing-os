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

/** The mirror's stored file is not under its workspace's storage prefix, so
 *  the read predicate cannot be applied to it: closed, and said. */
export const MIRROR_KEY_OUTSIDE_WORKSPACE =
  "This mirrored file is stored outside the workspace's storage area, so access to its source can't be checked. A document controller can re-sync the knowledge library to fix it.";

/** The mirror's stored file is not a revision of the document it says it
 *  mirrors, so the decision could not be made about that document: closed. */
export const MIRROR_UNBOUND =
  "This mirrored file no longer matches a revision of its source document, so access to it can't be checked. A document controller can re-sync the knowledge library to fix it.";

/** No such knowledge document in a workspace the caller belongs to. */
export const MIRROR_NOT_FOUND = "That document is no longer in the library.";

/** A direct upload is not a mirror: it opens from its own stored file. */
export const MIRROR_IS_UPLOAD = "This document was uploaded directly to the library — it opens from its own stored file.";
