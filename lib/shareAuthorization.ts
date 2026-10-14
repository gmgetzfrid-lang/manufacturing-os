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

/** The creator's current authority over the shared document:
 *   - "ok"      an active member of the share's org who can read it now;
 *   - "lapsed"  no creator, no active membership, or the document is no
 *               longer readable to them — the link is dead ("revoked");
 *   - "unknown" a read the decision needs failed (the creator's membership or
 *               teams — loadPrincipal's PrincipalUnreadableError — or the
 *               landscape / document reads, KACL-12): a TEMPORARY condition.
 *               The share never serves on it, and never calls it "revoked" or
 *               records it as a lapsed authority (I-12 second review fix: a
 *               statement timeout told the recipient "revoked" and wrote
 *               `authority_lapsed` — false evidence). */
export type ShareAuthority = "ok" | "lapsed" | "unknown";

export async function shareAuthority(
  orgId: string,
  createdBy: string | null | undefined,
  documentId: string,
): Promise<ShareAuthority> {
  if (!createdBy) return "lapsed";
  try {
    const principal = await loadPrincipal(orgId, createdBy);
    if (!principal) return "lapsed";
    if (principal.isController) return "ok";
    const readable = await readableControlledDocIds(principal, [documentId]);
    return readable.has(documentId) ? "ok" : "lapsed";
  } catch {
    // Never serve a controlled document when we cannot confirm the creator's
    // current authority — and never say it lapsed.
    return "unknown";
  }
}

/**
 * True when `createdBy` is an active member of `orgId` who can currently read
 * `documentId` (shareAuthority "ok"). False (fail-closed) when the creator is
 * unknown/left, the document is no longer readable to them, or that could not
 * be confirmed. A null/absent creator is refused — a share with no owner has
 * no authority to serve on. Share serving asks shareAuthority, which tells
 * "lapsed" from "unknown".
 */
export async function shareStillAuthorized(
  orgId: string,
  createdBy: string | null | undefined,
  documentId: string,
): Promise<boolean> {
  return (await shareAuthority(orgId, createdBy, documentId)) === "ok";
}
