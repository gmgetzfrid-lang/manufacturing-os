// lib/shareAuthorization.ts — SERVER-ONLY.
//
// A public share link (document_shares) serves on the authority of the person
// who created it. Before serving a document's metadata or bytes, the share
// routes re-check that the creator is STILL an active member of the share's
// org AND can STILL read the document under its current ACL. This closes the
// half of EGRESS-1 that the org-join alone does not: a share created legitimately
// keeps working forever unless it is revoked or expires — so if the sharer
// loses read access (an ACL deny lands, the document is made private, or they
// are removed from the org), the link must stop serving.
//
// Reuses the same read-decision the ask pipeline enforces (lib/knowledgeAccess),
// so a share can never grant more than its creator currently holds.

import { loadPrincipal, readableControlledDocIds } from "@/lib/knowledgeAccess";

/**
 * True when `createdBy` is an active member of `orgId` who can currently read
 * `documentId`. False (fail-closed) when the creator is unknown/left, or the
 * document is no longer readable to them. A null/absent creator is refused —
 * a share with no owner has no authority to serve on.
 */
export async function shareStillAuthorized(
  orgId: string,
  createdBy: string | null | undefined,
  documentId: string,
): Promise<boolean> {
  if (!createdBy) return false;
  try {
    const principal = await loadPrincipal(orgId, createdBy);
    if (!principal) return false;
    if (principal.isController) return true;
    const readable = await readableControlledDocIds(principal, [documentId]);
    return readable.has(documentId);
  } catch {
    // Never serve a controlled document when we cannot confirm the creator's
    // current authority.
    return false;
  }
}
