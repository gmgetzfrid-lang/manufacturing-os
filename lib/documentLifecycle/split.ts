// lib/documentLifecycle/split.ts
//
// One document → N new documents.
//
// Splits a sheet that's gotten too cluttered (or one that legitimately
// needs to become multiple drawings). The source is parked under
// Superseded, every new sheet gets its own document row + first
// version row, and document_supersessions captures the lineage.

import { supabase } from "@/lib/supabase";
import type { DocumentRecord, AssetTag } from "@/types/schema";
import {
  type ActorContext,
  createNewDocWithFirstVersion,
  markSupersededAndLink,
  copyActiveHoldsToDoc,
  copyProjectMembershipToDoc,
  withCompensation,
  archiveRolledBackDoc,
  restoreSupersededSource,
} from "./common";

export interface SplitTargetSpec {
  /** The new document_number for this target sheet. */
  documentNumber: string;
  title: string;
  /** Optional. Defaults to the title. */
  name?: string;
  /** Optional sheet_number within the source's set. If omitted, the
   *  set's sheet_total advances and the new doc is appended. */
  sheetNumber?: number | null;
  /** Asset tags assigned to this target. Caller controls distribution. */
  assetTags: AssetTag[];
  /** PDF file for this target's initial revision. Required — splits
   *  must produce real documents the diff overlay can hit. */
  file: File;
  initialRevLabel: string;     // typically "0" or "A"
  changeLog: string;           // typically "Created via split of <source>"
  /** Optional metadata overrides. By default we copy the source's metadata. */
  metadataOverrides?: Record<string, unknown>;
}

export interface SplitDocumentInput {
  source: DocumentRecord;
  libraryId: string;
  folderPath?: string[];
  targets: SplitTargetSpec[];
  reason: string;                 // required
  mocReference?: string;
  /** Carry over the source's active holds to every new target.
   *  Defaults to true — splits usually preserve blockers. */
  copyHolds?: boolean;
  /** Copy project_documents memberships to every new target.
   *  Defaults to true. */
  copyProjectMembership?: boolean;
  /** Copy plant/unit/system scope FKs to new targets. Defaults to true. */
  copyScope?: boolean;
  /** Inherit the source's collection_id and set_id. Defaults to true. */
  inheritCollectionAndSet?: boolean;
  orgId: string;
  actorUserId: string;
  actorUserName?: string;
  actorEmail?: string;
  actorRole?: string;
}

export interface SplitDocumentResult {
  supersededSourceId: string;
  newDocumentIds: string[];
  holdsCopied: number;
  projectMembershipsCopied: number;
}

export async function splitDocument(input: SplitDocumentInput): Promise<SplitDocumentResult> {
  const {
    source, libraryId, folderPath, targets, reason, mocReference,
    copyHolds = true, copyProjectMembership = true, copyScope = true,
    inheritCollectionAndSet = true,
    orgId, actorUserId, actorUserName, actorEmail, actorRole,
  } = input;

  if (!source.id) throw new Error("Source document is missing an id.");
  if (targets.length < 2) throw new Error("A split must produce at least 2 new documents.");
  if (!reason.trim()) throw new Error("Split reason is required.");
  for (const t of targets) {
    if (!t.documentNumber.trim()) throw new Error("Each split target needs a document_number.");
    if (!t.title.trim())          throw new Error("Each split target needs a title.");
    if (!t.initialRevLabel.trim()) throw new Error("Each split target needs an initial rev label.");
    if (!t.file)                  throw new Error("Each split target needs a PDF file.");
  }

  const actor: ActorContext = { orgId, actorUserId, actorEmail, actorRole };
  const priorSourceStatus = source.status ?? "Issued";
  const sourceId = source.id; // narrowed to string by the guard above

  return withCompensation(async (register) => {
  // 1. Materialize each new doc with its first revision.
  const newDocumentIds: string[] = [];
  for (const t of targets) {
    const r = await createNewDocWithFirstVersion({
      orgId,
      libraryId,
      folderPath,
      collectionId: inheritCollectionAndSet ? (source.collectionId ?? null) : null,
      setId:        inheritCollectionAndSet ? (source.setId ?? null)        : null,
      sheetNumber:  t.sheetNumber ?? null,
      documentNumber: t.documentNumber.trim(),
      title: t.title.trim(),
      name: t.name?.trim() || t.title.trim(),
      initialRevLabel: t.initialRevLabel.trim(),
      changeLog: t.changeLog.trim() || `Created via split of ${source.documentNumber ?? source.id}`,
      assetTags: t.assetTags ?? [],
      plantId:  copyScope ? (source.plantId  ?? null) : null,
      unitId:   copyScope ? (source.unitId   ?? null) : null,
      systemId: copyScope ? (source.systemId ?? null) : null,
      metadata: { ...(source.metadata ?? {}), ...(t.metadataOverrides ?? {}) },
      file: t.file,
      actor,
      actorName: actorUserName,
      creationAuditAction: "CREATED_FROM_SPLIT",
      creationDetails: {
        sourceDocumentId: source.id,
        sourceDocumentNumber: source.documentNumber ?? null,
        reason: reason.trim(),
        mocReference: mocReference?.trim() || null,
      },
    });
    newDocumentIds.push(r.documentId);
    // If a later step fails, archive this just-created doc on rollback.
    register({
      describe: `archive rolled-back split target ${t.documentNumber}`,
      run: () => archiveRolledBackDoc(r.documentId, actor),
    });
  }

  // 2. Mark the source as Superseded and write the supersessions join rows.
  await markSupersededAndLink({
    sourceDocId: sourceId,
    replacementDocIds: newDocumentIds,
    reason: reason.trim(),
    mocReference,
    actor,
    sourceAuditAction: "DOC_SPLIT",
    details: {
      newDocumentCount: newDocumentIds.length,
      newDocumentNumbers: targets.map((t) => t.documentNumber),
    },
  });
  // If a later step fails, restore the source to its prior status on rollback.
  register({
    describe: `restore source ${source.documentNumber ?? source.id} from Superseded`,
    run: () => restoreSupersededSource(sourceId, priorSourceStatus, newDocumentIds, actor),
  });

  // 3. Carry over holds + project memberships to each new doc. These are
  //    SECONDARY effects: the split itself (new docs + supersession) is
  //    already durable and correct above. A transient copy failure here is
  //    reported via honest counts rather than rolling back the whole split,
  //    so we don't undo valid structural work over a membership hiccup.
  let holdsCopied = 0;
  let projectsCopied = 0;
  if (copyHolds) {
    for (const newId of newDocumentIds) {
      holdsCopied += await copyActiveHoldsToDoc({
        sourceDocId: sourceId, targetDocId: newId,
        originLabel: `${source.documentNumber ?? "source"} (split)`,
        actor,
      });
    }
  }
  if (copyProjectMembership) {
    for (const newId of newDocumentIds) {
      try {
        projectsCopied += await copyProjectMembershipToDoc({
          sourceDocId: sourceId, targetDocId: newId, actor,
        });
      } catch { /* secondary effect — count stays honest, split stands */ }
    }
  }

  // 4. Bump set's sheet_count if appropriate.
  if (inheritCollectionAndSet && source.setId) {
    // Source still exists in the set (as Superseded) and we added N new.
    // We touch updated_at to signal change; the SetManager UI is the
    // authority for the actual sheet_count re-computation.
    await supabase
      .from("document_sets")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", source.setId);
  }

  return {
    supersededSourceId: sourceId,
    newDocumentIds,
    holdsCopied,
    projectMembershipsCopied: projectsCopied,
  };
  });
}
