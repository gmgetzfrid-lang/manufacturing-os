// lib/issueStatus.ts — which statuses ISSUE a revision as a controlled copy,
// and which status changes make a document a controlled issue.
//
// Pure and dependency-light (it imports only the shared not-current set) so
// the client editors that change a status (the metadata editor, the bulk
// editor) can ask it without pulling the publish library into their bundle.
// lib/revisions.ts re-exports both predicates, so every existing import
// keeps working.
//
// The database reads the same rules: 20261139 (REV-17, a first issue) lists
// the five statuses; 20261144 (REV-18) defines is_controlled_issue_status —
// the same trim (exactly the characters String.prototype.trim removes) and
// the same five statuses — and its v_issuing is isIssueTransition. Both are
// pinned to this file by test (lib/__tests__/dcRoundFStatusTransition.test.ts).

import { NOT_CURRENT_STATUSES } from "@/lib/aiBoundary";

/** REV-15 / REV-17: the statuses in which a NEW document is not a controlled
 *  copy — work in progress. With the shared not-current set
 *  (NOT_CURRENT_STATUSES), they are the only statuses a first revision may
 *  be written under without being an ISSUE. */
export const WORK_IN_PROGRESS_STATUSES: ReadonlySet<string> = new Set(["Draft", "In Review"]);

/** REV-15 / REV-17: does a document born in this status ISSUE its first
 *  revision as a controlled copy? Everything but work in progress and the
 *  not-current statuses does (Issued, IFC, a library's own status). Such a
 *  creation starts the compliance clocks (startIssuedDocumentClocks), and in
 *  a library whose policy requires sign-off only a controller may make it —
 *  the database's publish guard reads the same set (20261139, pinned by
 *  test). */
export function isControlledIssueStatus(status: string | null | undefined): boolean {
  const s = (status ?? "").trim();
  return !WORK_IN_PROGRESS_STATUSES.has(s) && !NOT_CURRENT_STATUSES.has(s);
}

/** REV-18: does this status change make the document a controlled ISSUE?
 *  A document that HAS a current revision moving out of a status that is not
 *  an issue (Draft, In Review, Superseded, Void, Archived) into one that is —
 *  the database's v_issuing (20261144, is_controlled_issue_status: the same
 *  predicate, pinned by test). Such a write takes the publisher tier, is
 *  refused over an active hold, and under a policy that requires sign-off is
 *  a controller's unless the revision carries a complete roster. A document
 *  with no current revision has nothing to issue (a register row). */
export function isIssueTransition(input: {
  fromStatus: string | null | undefined; toStatus: string | null | undefined; hasCurrentRevision: boolean;
}): boolean {
  return input.hasCurrentRevision && !isControlledIssueStatus(input.fromStatus) && isControlledIssueStatus(input.toStatus);
}

/** REV-18: the sentences the publish guard refuses an issue with (20261144),
 *  and the ones it already refused the same write with for a non-publisher
 *  (OWN-15) — what a status editor recognises as "the issue rule said no". */
export const ISSUE_REFUSAL_SENTENCES = [
  "release the hold before issuing it",
  "a revision that was not reviewed can't be made a controlled issue",
  "You do not have authority to publish revisions in this library",
  "release the hold before publishing a new revision",
] as const;

/** REV-18: is this error text the publish guard refusing a status change? */
export function isIssueRefusal(message: string | null | undefined): boolean {
  const m = message ?? "";
  return ISSUE_REFUSAL_SENTENCES.some((s) => m.includes(s));
}
