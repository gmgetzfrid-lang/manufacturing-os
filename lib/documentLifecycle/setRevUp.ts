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
import { revUpDocument } from "@/lib/revisions";
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
  failed: Array<{ documentId: string; documentNumber: string | null; error: string }>;
}

export async function setLevelRevUp(input: SetRevUpInput): Promise<SetRevUpResult> {
  const { setId, sheets, libraryId, folderPath, sharedChangeLog, sharedMocReference,
          issueType, changeType, orgId, actorUserId, actorEmail, actorRole } = input;

  if (sheets.length === 0) throw new Error("setLevelRevUp needs at least one sheet.");
  if (!sharedChangeLog.trim()) throw new Error("Shared change narrative is required.");

  const failed: SetRevUpResult["failed"] = [];
  let succeeded = 0;

  for (const sheet of sheets) {
    try {
      await revUpDocument({
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
      });
      succeeded++;
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
      setId, totalSheets: sheets.length, succeeded, failedCount: failed.length,
      sharedChangeLog: sharedChangeLog.trim(),
      sharedMocReference: sharedMocReference?.trim() || null,
    },
  });

  return { succeeded, failed };
}
