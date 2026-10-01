// lib/documentLifecycle/setRevUp.ts
//
// Batch rev-up of every active sheet in a set. Each sheet still gets
// its own RevUp call (so each gets a real version row, hash, and
// audit event) — the batch wrapper just shares the metadata that's
// typically uniform across the set (MOC, change_log, issue type)
// and aggregates results.
//
// We do NOT accept N PDF files here — the per-sheet file is provided
// by the caller because each sheet's file is different.

import { logRevisionEvent } from "@/lib/audit";
import { revUpDocument, submitForReview, firstIssueGateForRevUp } from "@/lib/revisions";
import { effectiveReviewControlForDocument, effectiveModeForRevUp } from "@/lib/reviewControl";
import type { DocumentRecord, DocumentVersion } from "@/types/schema";

export interface SetRevUpSheetSpec {
  doc: DocumentRecord;
  file: File;
  revisionLabel: string;
}

export interface SetRevUpInput {
  setId: string;
  sheets: SetRevUpSheetSpec[];
  libraryId: string;
  folderPath?: string[];
  /** Shared metadata across the whole set bump. */
  sharedChangeLog: string;
  sharedMocReference?: string;
  issueType?: DocumentVersion["issueType"];
  changeType?: DocumentVersion["changeType"];
  orgId: string;
  actorUserId: string;
  actorEmail?: string;
  actorRole?: string;
}

export interface SetRevUpResult {
  succeeded: number;
  /** Sheets routed into pre-publish review (in-review drafts, not yet live). */
  sentForReview: number;
  failed: Array<{ documentId: string; documentNumber: string | null; error: string }>;
}

export async function setLevelRevUp(input: SetRevUpInput): Promise<SetRevUpResult> {
  const { setId, sheets, libraryId, folderPath, sharedChangeLog, sharedMocReference,
          issueType, changeType, orgId, actorUserId, actorEmail, actorRole } = input;

  if (sheets.length === 0) throw new Error("setLevelRevUp needs at least one sheet.");
  if (!sharedChangeLog.trim()) throw new Error("Shared change narrative is required.");

  const failed: SetRevUpResult["failed"] = [];
  let succeeded = 0;
  let sentForReview = 0;

  for (const sheet of sheets) {
    try {
      const common = {
        doc: sheet.doc,
        libraryId,
        folderPath,
        file: sheet.file,
        revisionLabel: sheet.revisionLabel,
        changeLog: sharedChangeLog,
        issueType,
        changeType,
        mocReference: sharedMocReference,
        orgId, actorUserId, actorEmail, actorRole,
      };
      // The set path must honor the SAME pre-publish review gate as a
      // single-sheet rev-up — the audit found it silently bypassed the gate
      // (fresh versions have no roster, so the DB guard never fires either).
      let willReview = false;
      try {
        const control = await effectiveReviewControlForDocument({
          reviewControl: sheet.doc.reviewControl ?? null,
          collectionId: sheet.doc.collectionId ?? null,
          libraryId,
        });
        // REV-18 (P13 review fix): a sheet that is not issued yet (a Draft,
        // or no current revision) would be ISSUED by this bump — a first
        // issue, which under a require policy (chain OR document) only a
        // controller publishes unreviewed. Whatever the change type, such a
        // sheet goes to review like a Major change, never to `failed` for a
        // direct publish revUpDocument would refuse.
        const firstIssue = await firstIssueGateForRevUp({
          doc: sheet.doc, libraryId, actor: { orgId, actorUserId, actorRole },
        });
        // Batch bumps have no per-sheet "route through review?" checkbox, so
        // publisher_choice defaults to the safe side: through review.
        willReview = effectiveModeForRevUp({ control, changeType, firstIssueMustReview: firstIssue.mustReview }) !== "none";
      } catch (e) {
        // RG-6: an unresolved policy is UNKNOWN, never "no policy". The sheet
        // is refused (it lands in `failed`, like RevUpModal's refusal) — a
        // batch never publishes a sheet directly because its gate could not
        // be read.
        throw new Error(`Couldn't verify the pre-publish review policy for ${sheet.doc.documentNumber ?? sheet.doc.id ?? "this sheet"} — it was not published: ${(e as Error).message}`);
      }

      if (willReview) {
        await submitForReview(common);
        sentForReview++;
      } else {
        await revUpDocument(common);
        succeeded++;
      }
    } catch (e) {
      failed.push({
        documentId: sheet.doc.id ?? "",
        documentNumber: sheet.doc.documentNumber ?? null,
        error: (e as Error).message,
      });
    }
  }

  // Single audit event recording the batch operation itself. resourceId
  // = set id (so the set's timeline picks it up if we ever add one).
  await logRevisionEvent({
    orgId,
    documentId: setId,
    versionId: "",
    userId: actorUserId, userEmail: actorEmail ?? "", userRole: actorRole ?? "",
    type: "SET_REV_UP",
    details: {
      setId, totalSheets: sheets.length, succeeded, sentForReview, failedCount: failed.length,
      sharedChangeLog: sharedChangeLog.trim(),
      sharedMocReference: sharedMocReference?.trim() || null,
    },
  });

  return { succeeded, sentForReview, failed };
}
