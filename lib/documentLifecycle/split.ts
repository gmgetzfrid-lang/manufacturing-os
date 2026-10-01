// lib/documentLifecycle/split.ts
//
// One document → N new documents.
//
// Splits a sheet that's gotten too cluttered (or one that legitimately
// needs to become multiple drawings). The source is parked under
// Superseded, every new sheet gets its own document row + first
// version row, and document_supersessions captures the lineage.

import { supabase } from "@/lib/supabase";
import {
  authorizePublish, notifyHolderOfRetirement, resolveCreationReviewGate, canPutFirstRevisionInContainer,
} from "@/lib/revisions";
import type { DocumentRecord, AssetTag } from "@/types/schema";
import {
  type ActorContext,
  createNewDocWithFirstVersion,
  markSupersededAndLink,
  completeSourceRetirement,
  copyActiveHoldsToDoc,
  copyProjectMembershipToDoc,
  withCompensation,
  archiveRolledBackDoc,
  releaseCarriedHolds,
  startClocksForIssuedDocuments,
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
   *  Defaults to true — splits usually preserve blockers. HLD-2: false is
   *  REFUSED when the source has an active hold (a structural edit must not
   *  launder a stop-work signal away). */
  copyHolds?: boolean;
  /** HLD-2: a controller's explicit force past an active hold on the source
   *  (the supersede rule — an override reason never jumps a hold). */
  force?: boolean;
  /** Message to the user who has the source checked out, if anyone else
   *  does. Defaults to the split reason (the supersede modal's rule). */
  overrideReason?: string;
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
  /** REV-15: a new sheet whose review clock / acknowledgment roster did not
   *  start (the split stands); empty when every sheet's started. */
  complianceClockWarnings: string[];
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
  const sourceId = source.id; // narrowed to string by the guard above
  const sourceLabel = source.documentNumber ?? source.id;

  // HLD-2 / REV-11: the SAME gate as supersedeDocument, before anything is
  // written — per-library publish authority (or the source's effective
  // owner), the lock (a foreign checkout needs a reason; its holder is told),
  // and the hold (only a controller's explicit force passes it — the Split
  // wizard passes it only on the controller's "Proceed over the active hold"
  // acknowledgement, HLD-2 review fix 4).
  const preState = await authorizePublish({
    documentId: sourceId, libraryId, orgId, actorUserId, actorRole,
    overrideReason: input.overrideReason ?? reason, force: input.force, operation: "split",
    subjectLabel: sourceLabel,
  });
  // REV-11: sheets landing in ANOTHER library than the source's take
  // authority there too — they are born owned by the actor, so the
  // database's publish guard would admit them on that alone.
  const sourceLibraryId = source.libraryId || libraryId;
  if (sourceLibraryId !== libraryId) {
    const ok = await canPutFirstRevisionInContainer({
      orgId, libraryId, collectionId: inheritCollectionAndSet ? (source.collectionId ?? null) : null, actorUserId, actorRole,
    });
    if (!ok) {
      throw new Error("You don't have authority to issue documents in the library the split sheets would land in — nothing was split. Ask an Admin or Doc Control.");
    }
  }
  const sourceHeld = preState.activeHolds.length > 0;
  if (sourceHeld && !copyHolds) {
    throw new Error(`${sourceLabel} has an active hold — a split must carry it onto every new sheet. Turn "carry over holds" back on.`);
  }
  // REV-11: the new sheets are controlled first issues that REPLACE a
  // controlled drawing — the governing review policy is resolved for the
  // folder / library they land in; one that requires sign-off refuses
  // anyone but a controller, whose decision is recorded on every sheet.
  const review = await resolveCreationReviewGate({
    libraryId,
    collectionId: inheritCollectionAndSet ? (source.collectionId ?? null) : null,
    what: `the sheets split from ${sourceLabel}`,
    actor: { orgId, actorUserId, actorRole },
  });

  // Steps 1-3 can still roll back: every durable change registers its undo
  // BEFORE it is made, and a failure anywhere runs them all. Nothing
  // irreversible happens inside — see step 4.
  const done = await withCompensation(async (register) => {
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
      initialStatus: "Issued",
      creationAuditAction: "CREATED_FROM_SPLIT",
      creationDetails: {
        sourceDocumentId: source.id,
        sourceDocumentNumber: source.documentNumber ?? null,
        reason: reason.trim(),
        mocReference: mocReference?.trim() || null,
        reviewPolicy: review.recorded,
      },
    });
    newDocumentIds.push(r.documentId);
    // If a later step fails, archive this just-created doc on rollback.
    register({
      describe: `archive rolled-back split target ${t.documentNumber}`,
      run: () => archiveRolledBackDoc(r.documentId, actor),
    });
  }

  // 2. HLD-2: carry the source's holds onto every new sheet BEFORE the source
  //    is superseded — inside the register, so a hold that fails to carry
  //    rolls the whole split back instead of reporting a smaller count.
  let holdsCopied = 0;
  if (copyHolds && sourceHeld) {
    for (const newId of newDocumentIds) {
      const carried = await copyActiveHoldsToDoc({
        sourceDocId: sourceId, targetDocId: newId,
        originLabel: `${source.documentNumber ?? "source"} (split)`,
        actor,
      });
      holdsCopied += carried.copied;
      register({
        describe: `release the holds carried onto rolled-back split target ${newId}`,
        run: () => releaseCarriedHolds(carried.holdIds, actor),
      });
    }
  }

  // 3. Mark the source as Superseded and write the supersessions join rows.
  //    REV-12: the status the source actually held is read fresh; REV-14:
  //    its restore is registered BEFORE the flip, so a refused flip or
  //    lineage write puts the source back instead of leaving it Superseded
  //    with its replacements archived.
  const retired = await markSupersededAndLink({
    sourceDocId: sourceId,
    replacementDocIds: newDocumentIds,
    reason: reason.trim(),
    mocReference,
    actor,
    register,
    label: `source ${source.documentNumber ?? source.id}`,
  });
  return { newDocumentIds, holdsCopied, retired };
  });
  const { newDocumentIds, holdsCopied, retired } = done;

  // 4. Nothing below rolls back. NOW the irreversible half of the
  //    retirement: the source's in-flight review is voided (REV-6) and its
  //    share links revoked (REV-10), each outcome on the DOC_SPLIT record
  //    with the REV-12 prior status and instant.
  await completeSourceRetirement({
    source: retired,
    replacementDocIds: newDocumentIds,
    reason: reason.trim(),
    mocReference,
    actor,
    sourceAuditAction: "DOC_SPLIT",
    details: {
      newDocumentCount: newDocumentIds.length,
      newDocumentNumbers: targets.map((t) => t.documentNumber),
      holdsCarried: holdsCopied,
      // HLD-2 (review fix 4): the holds the controller's explicit force
      // proceeded over (empty when the source was not held).
      proceededOverHolds: preState.activeHolds.map((h) => ({ id: h.id ?? null, reason: h.reason })),
    },
  });

  // 4b. REV-15: every new sheet is an ISSUED first revision — its review
  //     clock and read-&-understood roster start now (the call
  //     createDocumentWithFile makes), after the saga, so nobody is asked to
  //     acknowledge a sheet a rollback archived.
  const complianceClockWarnings = await startClocksForIssuedDocuments(newDocumentIds, actor);

  // 5. Project memberships are a SECONDARY effect: the split itself (new
  //    docs + carried holds + supersession) is durable and correct above; a
  //    membership hiccup is reported via an honest count, never a rollback.
  let projectsCopied = 0;
  if (copyProjectMembership) {
    for (const newId of newDocumentIds) {
      try {
        projectsCopied += await copyProjectMembershipToDoc({
          sourceDocId: sourceId, targetDocId: newId, actor,
        });
      } catch { /* secondary effect — count stays honest, split stands */ }
    }
  }

  // 6. Bump set's sheet_count if appropriate.
  if (inheritCollectionAndSet && source.setId) {
    // Source still exists in the set (as Superseded) and we added N new.
    // We touch updated_at to signal change; the SetManager UI is the
    // authority for the actual sheet_count re-computation.
    await supabase
      .from("document_sets")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", source.setId);
  }

  await notifyHolderOfRetirement({
    preState, documentId: sourceId, libraryId, orgId, actorUserId, actorEmail,
    verb: "split", action: "split", reason: reason.trim(),
  });

  return {
    supersededSourceId: sourceId,
    newDocumentIds,
    holdsCopied,
    projectMembershipsCopied: projectsCopied,
    complianceClockWarnings,
  };
}
