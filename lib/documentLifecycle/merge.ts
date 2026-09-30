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
import {
  revUpDocument, authorizePublish, notifyHolderOfRetirement, resolveCreationReviewGate,
  type RevUpInput,
} from "@/lib/revisions";
import { effectiveReviewControlForDocument, effectiveModeForRevUp } from "@/lib/reviewControl";
import type { PublishGuardState } from "@/lib/documentGuards";
import type { DocumentRecord, DocumentVersion, AssetTag } from "@/types/schema";
import {
  type ActorContext,
  type Compensation,
  createNewDocWithFirstVersion,
  markSupersededAndLink,
  copyActiveHoldsToDoc,
  copyProjectMembershipToDoc,
  withCompensation,
  archiveRolledBackDoc,
  restoreSupersededSource,
  releaseCarriedHolds,
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
  /** HLD-2: false is REFUSED when any source has an active hold. */
  copyHolds?: boolean;
  copyProjectMembership?: boolean;
  /** HLD-2: a controller's explicit force past an active hold on a source. */
  force?: boolean;
  /** Message to whoever has a source checked out. Defaults to the reason. */
  overrideReason?: string;
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

interface MergeGate {
  preStates: Map<string, PublishGuardState>;
  heldSourceIds: Set<string>;
  priorStatuses: Record<string, string>;
  reviewPolicy: string;
}

export async function mergeDocuments(input: MergeDocumentsInput): Promise<MergeDocumentsResult> {
  const gate = await gateMerge(input);
  return withCompensation((register) => mergeDocumentsInner(input, gate, register));
}

/** HLD-2 / REV-11 / REV-12: everything a merge must know and refuse BEFORE
 *  it writes anything — the supersede gate on every source, the carried-hold
 *  rule, the governing review policy of the target, and the status every
 *  source actually holds (read fresh; recorded on each DOC_MERGED event so a
 *  reversal restores all of them, not a hardcoded Issued). */
async function gateMerge(input: MergeDocumentsInput): Promise<MergeGate> {
  const {
    sources, target, reason, copyHolds = true,
    orgId, actorUserId, actorRole,
  } = input;
  if (sources.length < 2) throw new Error("A merge needs at least 2 source documents.");
  if (!reason.trim()) throw new Error("Merge reason is required.");
  for (const s of sources) {
    if (!s.id) throw new Error("Every source document needs an id.");
  }

  const preStates = new Map<string, PublishGuardState>();
  const heldSourceIds = new Set<string>();
  for (const src of sources) {
    const st = await authorizePublish({
      documentId: src.id!, libraryId: src.libraryId || target.libraryId, orgId, actorUserId, actorRole,
      overrideReason: input.overrideReason ?? reason, force: input.force,
    });
    preStates.set(src.id!, st);
    if (st.activeHolds.length > 0) heldSourceIds.add(src.id!);
  }
  if (heldSourceIds.size > 0 && !copyHolds) {
    const labels = sources.filter((s) => heldSourceIds.has(s.id!)).map((s) => s.documentNumber ?? s.id).join(", ");
    throw new Error(`${labels} ${heldSourceIds.size === 1 ? "has an active hold" : "have active holds"} — a merge must carry holds onto the target. Turn "carry over holds" back on, or release the holds first.`);
  }

  let reviewPolicy: string;
  if (target.kind === "create_new") {
    reviewPolicy = (await resolveCreationReviewGate({
      libraryId: target.libraryId, collectionId: null,
      what: `the merged document ${target.documentNumber.trim()}`,
    })).recorded;
  } else if (target.revUp) {
    // The extended target's rev-up publishes merged content through the
    // contract — the same per-document review policy RevUpModal and
    // setLevelRevUp resolve. A merge has no "route through review?"
    // checkbox, so a policy that REQUIRES sign-off refuses here (the actor
    // submits the revision for review, then merges without a rev-up).
    let mode: string;
    try {
      const control = await effectiveReviewControlForDocument({
        reviewControl: target.target.reviewControl ?? null,
        collectionId: target.target.collectionId ?? null,
        libraryId: target.libraryId,
      });
      mode = effectiveModeForRevUp({ control, changeType: target.revUp.changeType ?? null });
    } catch (e) {
      throw new Error(`Couldn't verify the review policy for ${target.target.documentNumber ?? "the merge target"} — nothing was merged: ${(e as Error).message}`);
    }
    if (mode === "require") {
      throw new Error(
        `${target.target.documentNumber ?? "The merge target"} requires reviewer sign-off for this revision — a merge can't publish it unreviewed. ` +
        "Submit the merged revision for review first, then run the merge without a rev-up.",
      );
    }
    reviewPolicy = mode === "publisher_choice"
      ? "publisher_choice — the publisher chose to publish the merged revision directly by running the merge"
      : "none — the governing policy does not require sign-off for this revision";
  } else {
    reviewPolicy = "none — the extended target's content is unchanged (no rev-up)";
  }

  const { data: rows, error: stErr } = await supabase
    .from("documents").select("id, status").in("id", sources.map((s) => s.id!));
  if (stErr) throw new Error(`Couldn't read the sources' statuses (${stErr.message}) — nothing was merged.`);
  const priorStatuses: Record<string, string> = {};
  for (const r of (rows as Array<{ id: string; status: string | null }> | null) ?? []) priorStatuses[r.id] = String(r.status ?? "Issued");
  const missing = sources.filter((s) => !(s.id! in priorStatuses));
  if (missing.length > 0) throw new Error(`Couldn't find ${missing.map((s) => s.documentNumber ?? s.id).join(", ")} — nothing was merged.`);

  return { preStates, heldSourceIds, priorStatuses, reviewPolicy };
}

async function mergeDocumentsInner(
  input: MergeDocumentsInput,
  gate: MergeGate,
  register: (c: Compensation) => void,
): Promise<MergeDocumentsResult> {
  const {
    sources, target, reason, mocReference,
    copyHolds = true, copyProjectMembership = true,
    orgId, actorUserId, actorUserName, actorEmail, actorRole,
  } = input;

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
      initialStatus: "Issued",
      creationAuditAction: "CREATED_FROM_MERGE",
      creationDetails: {
        sourceDocumentIds: sources.map((s) => s.id),
        sourceDocumentNumbers: sources.map((s) => s.documentNumber ?? null),
        reason: reason.trim(),
        mocReference: mocReference?.trim() || null,
        reviewPolicy: gate.reviewPolicy,
      },
    });
    targetDocumentId = r.documentId;
    // Archive the freshly-created target if a later step fails.
    register({
      describe: `archive rolled-back merge target ${target.documentNumber}`,
      run: () => archiveRolledBackDoc(r.documentId, actor),
    });
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
        reviewPolicy: gate.reviewPolicy,
      },
    });
  }

  // 2. HLD-2: carry every held source's holds onto the target BEFORE any
  //    source is superseded — inside the register, so a hold that fails to
  //    carry rolls the merge back rather than reporting a smaller count.
  let holdsCopied = 0;
  if (copyHolds) {
    for (const src of sources) {
      if (!gate.heldSourceIds.has(src.id!)) continue;
      const carried = await copyActiveHoldsToDoc({
        sourceDocId: src.id!, targetDocId: targetDocumentId,
        originLabel: `${src.documentNumber ?? "source"} (merge)`,
        actor,
      });
      holdsCopied += carried.copied;
      register({
        describe: `release the holds carried from ${src.documentNumber ?? src.id} onto the merge target`,
        run: () => releaseCarriedHolds(carried.holdIds, actor),
      });
    }
  }

  // 3. Mark each source as Superseded, link to the target. REV-12: every
  //    DOC_MERGED event carries the statuses ALL siblings held (read fresh in
  //    the gate), so reversing from any one of them restores each correctly.
  for (const src of sources) {
    const { priorStatus } = await markSupersededAndLink({
      sourceDocId: src.id!,
      replacementDocIds: [targetDocumentId],
      reason: reason.trim(),
      mocReference,
      actor,
      sourceAuditAction: "DOC_MERGED",
      details: {
        mergedIntoDocumentId: targetDocumentId,
        mergeSiblings: sources.map((s) => s.id),
        // Explicit, authoritative flag so reverseMerge never has to infer
        // intent from a free-text note. true → target was freshly created
        // (park it on reverse); false → target was an existing doc extended
        // by the merge (leave it active on reverse).
        targetWasNewlyCreated: target.kind === "create_new",
        priorStatuses: gate.priorStatuses,
      },
    });
    // Restore this source on rollback if a subsequent source fails to supersede.
    register({
      describe: `restore merge source ${src.documentNumber ?? src.id}`,
      run: () => restoreSupersededSource(src.id!, priorStatus, [targetDocumentId], actor),
    });
  }

  // 4. Project memberships from each source — a secondary effect, reported
  //    via an honest count, never cause for a rollback.
  let projectsCopied = 0;
  if (copyProjectMembership) {
    for (const src of sources) {
      try {
        projectsCopied += await copyProjectMembershipToDoc({
          sourceDocId: src.id!, targetDocId: targetDocumentId, actor,
        });
      } catch { /* secondary effect — count stays honest, merge stands */ }
    }
  }

  for (const src of sources) {
    const pre = gate.preStates.get(src.id!);
    if (!pre) continue;
    await notifyHolderOfRetirement({
      preState: pre, documentId: src.id!, libraryId: src.libraryId || target.libraryId, orgId, actorUserId, actorEmail,
      verb: "merged", action: "merge", reason: reason.trim(),
    });
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
