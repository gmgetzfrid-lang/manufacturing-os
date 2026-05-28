// lib/documentLifecycle/merge.ts
//
// N source documents → one target.
//
// Two target modes:
//   - create_new: scaffold a brand-new doc that absorbs the sources
//   - extend_existing: keep one of the existing docs and absorb the
//     others into it (with an optional rev-up of that target)

import { supabase } from "@/lib/supabase";
import { logRevisionEvent } from "@/lib/audit";
import { revUpDocument, type RevUpInput } from "@/lib/revisions";
import type { DocumentRecord, DocumentVersion, AssetTag } from "@/types/schema";
import {
  type ActorContext,
  createNewDocWithFirstVersion,
  markSupersededAndLink,
  copyActiveHoldsToDoc,
  copyProjectMembershipToDoc,
} from "./common";

export type MergeTargetSpec =
  | {
      kind: "create_new";
      documentNumber: string;
      title: string;
      name?: string;
      sheetNumber?: number | null;
      assetTags: AssetTag[];
      file: File;
      initialRevLabel: string;
      changeLog: string;
      libraryId: string;
      folderPath?: string[];
    }
  | {
      kind: "extend_existing";
      /** The document to keep — its sources are absorbed. */
      target: DocumentRecord;
      libraryId: string;
      folderPath?: string[];
      /** Optionally rev-up the extended target with a new PDF file
       *  (the merged content). If omitted, the target's current
       *  version is unchanged. */
      revUp?: {
        file: File;
        revisionLabel: string;
        changeLog: string;
        issueType?: DocumentVersion["issueType"];
        changeType?: DocumentVersion["changeType"];
        mocReference?: string;
        sourceFileName?: string;
      };
      assetTagsUnion: AssetTag[];
    };

export interface MergeDocumentsInput {
  sources: DocumentRecord[];            // ≥ 2
  target: MergeTargetSpec;
  reason: string;
  mocReference?: string;
  copyHolds?: boolean;
  copyProjectMembership?: boolean;
  orgId: string;
  actorUserId: string;
  actorUserName?: string;
  actorEmail?: string;
  actorRole?: string;
}

export interface MergeDocumentsResult {
  targetDocumentId: string;
  supersededSourceIds: string[];
  holdsCopied: number;
  projectMembershipsCopied: number;
}

export async function mergeDocuments(input: MergeDocumentsInput): Promise<MergeDocumentsResult> {
  const {
    sources, target, reason, mocReference,
    copyHolds = true, copyProjectMembership = true,
    orgId, actorUserId, actorUserName, actorEmail, actorRole,
  } = input;

  if (sources.length < 2) throw new Error("A merge needs at least 2 source documents.");
  if (!reason.trim()) throw new Error("Merge reason is required.");
  for (const s of sources) {
    if (!s.id) throw new Error("Every source document needs an id.");
  }

  const actor: ActorContext = { orgId, actorUserId, actorEmail, actorRole };

  // 1. Resolve the target document id (creating or extending).
  let targetDocumentId: string;

  if (target.kind === "create_new") {
    const r = await createNewDocWithFirstVersion({
      orgId,
      libraryId: target.libraryId,
      folderPath: target.folderPath,
      collectionId: null,
      setId: sources.every((s) => s.setId && s.setId === sources[0].setId) ? sources[0].setId : null,
      sheetNumber: target.sheetNumber ?? null,
      documentNumber: target.documentNumber.trim(),
      title: target.title.trim(),
      name: target.name?.trim() || target.title.trim(),
      initialRevLabel: target.initialRevLabel.trim(),
      changeLog: target.changeLog.trim() || `Created via merge of ${sources.map((s) => s.documentNumber).filter(Boolean).join(", ")}`,
      assetTags: target.assetTags ?? [],
      // Scope inherited only if every source agrees (no auto-decision).
      plantId:  scopeIfAllAgree(sources, "plantId"),
      unitId:   scopeIfAllAgree(sources, "unitId"),
      systemId: scopeIfAllAgree(sources, "systemId"),
      metadata: {},
      file: target.file,
      actor,
      actorName: actorUserName,
      creationAuditAction: "CREATED_FROM_MERGE",
      creationDetails: {
        sourceDocumentIds: sources.map((s) => s.id),
        sourceDocumentNumbers: sources.map((s) => s.documentNumber ?? null),
        reason: reason.trim(),
        mocReference: mocReference?.trim() || null,
      },
    });
    targetDocumentId = r.documentId;
  } else {
    // Extend existing — optionally rev-up.
    if (!target.target.id) throw new Error("Extend target needs an id.");
    targetDocumentId = target.target.id;

    // Update asset_tags to the union the caller provided.
    await supabase.from("documents").update({
      asset_tags: target.assetTagsUnion,
      updated_at: new Date().toISOString(),
      updated_by: actorUserId,
    }).eq("id", targetDocumentId);

    if (target.revUp) {
      // Reuse the canonical rev-up flow.
      const revUpInput: RevUpInput = {
        doc: target.target,
        libraryId: target.libraryId,
        folderPath: target.folderPath,
        file: target.revUp.file,
        revisionLabel: target.revUp.revisionLabel,
        changeLog: target.revUp.changeLog,
        issueType: target.revUp.issueType,
        changeType: target.revUp.changeType,
        mocReference: target.revUp.mocReference ?? mocReference,
        sourceFileName: target.revUp.sourceFileName,
        orgId, actorUserId, actorEmail, actorRole,
      };
      await revUpDocument(revUpInput);
    }

    // Audit on the target documenting that it absorbed merges.
    await logRevisionEvent({
      orgId, documentId: targetDocumentId, versionId: "",
      userId: actorUserId, userEmail: actorEmail ?? "", userRole: actorRole ?? "",
      type: "CREATED_FROM_MERGE",
      details: {
        sourceDocumentIds: sources.map((s) => s.id),
        sourceDocumentNumbers: sources.map((s) => s.documentNumber ?? null),
        reason: reason.trim(),
        mocReference: mocReference?.trim() || null,
        note: "Existing document extended via merge",
      },
    });
  }

  // 2. Mark each source as Superseded, link to the target.
  for (const src of sources) {
    await markSupersededAndLink({
      sourceDocId: src.id!,
      replacementDocIds: [targetDocumentId],
      reason: reason.trim(),
      mocReference,
      actor,
      sourceAuditAction: "DOC_MERGED",
      details: { mergedIntoDocumentId: targetDocumentId, mergeSiblings: sources.map((s) => s.id) },
    });
  }

  // 3. Carry over holds + project memberships from each source.
  let holdsCopied = 0;
  let projectsCopied = 0;
  if (copyHolds) {
    for (const src of sources) {
      holdsCopied += await copyActiveHoldsToDoc({
        sourceDocId: src.id!, targetDocId: targetDocumentId,
        originLabel: `${src.documentNumber ?? "source"} (merge)`,
        actor,
      });
    }
  }
  if (copyProjectMembership) {
    for (const src of sources) {
      projectsCopied += await copyProjectMembershipToDoc({
        sourceDocId: src.id!, targetDocId: targetDocumentId, actor,
      });
    }
  }

  return {
    targetDocumentId,
    supersededSourceIds: sources.map((s) => s.id!),
    holdsCopied,
    projectMembershipsCopied: projectsCopied,
  };
}

function scopeIfAllAgree(sources: DocumentRecord[], key: "plantId" | "unitId" | "systemId"): string | null {
  const first = sources[0]?.[key] ?? null;
  if (!first) return null;
  return sources.every((s) => s[key] === first) ? (first ?? null) : null;
}
