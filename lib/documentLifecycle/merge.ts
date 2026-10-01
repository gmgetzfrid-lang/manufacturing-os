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
  canPutFirstRevisionInContainer,
  type RevUpInput,
} from "@/lib/revisions";
import { effectiveReviewControlForDocument, effectiveModeForRevUp } from "@/lib/reviewControl";
import type { PublishGuardState } from "@/lib/documentGuards";
import type { DocumentRecord, DocumentVersion, AssetTag } from "@/types/schema";
import {
  type ActorContext,
  type Compensation,
  type SupersededSource,
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
      /** The document to keep — its sources are absorbed. It may also be
       *  listed among `sources` (the wizard lists it there): it is KEPT,
       *  never superseded — it is the replacement. */
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
  /** REV-15: a warning when a newly created target's review clock /
   *  acknowledgment roster did not start (the start threw) or did not fully
   *  start (a write error the clock helpers reported) — the merge stands;
   *  empty otherwise. */
  complianceClockWarnings: string[];
}

interface MergeGate {
  /** The sources the merge ABSORBS (supersedes): every source except an
   *  extended target, which is kept. */
  absorbed: DocumentRecord[];
  preStates: Map<string, PublishGuardState>;
  heldSourceIds: Set<string>;
  priorStatuses: Record<string, string>;
  reviewPolicy: string;
}

/** What the saga committed, for the irreversible half that follows it. */
interface MergeCommitted {
  targetDocumentId: string;
  holdsCopied: number;
  retired: SupersededSource[];
}

export async function mergeDocuments(input: MergeDocumentsInput): Promise<MergeDocumentsResult> {
  const gate = await gateMerge(input);
  // Steps 1-4 can still roll back: every durable change registers its undo
  // BEFORE it is made, and the extended target's rev-up — the one step whose
  // effect a rollback could not take back — runs LAST, so every earlier
  // failure rolls back with nothing published. Nothing irreversible happens
  // inside.
  const committed = await withCompensation((register) => mergeDocumentsInner(input, gate, register));
  return finishMerge(input, gate, committed);
}

/** HLD-2 / REV-11 / REV-12: everything a merge must know and refuse BEFORE
 *  it writes anything — the supersede gate on every absorbed source, the
 *  carried-hold rule, the kept target's own gate (and the rev-up's), the
 *  authority to issue in a target library the sources are not in, the
 *  governing review policy of the target, and the status every absorbed
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
  if (target.kind === "extend_existing" && !target.target.id) throw new Error("Extend target needs an id.");
  const keptId = target.kind === "extend_existing" ? target.target.id! : null;
  const absorbed = sources.filter((s) => s.id !== keptId);
  if (absorbed.length === 0) throw new Error("A merge needs at least one document to absorb besides the target.");

  const preStates = new Map<string, PublishGuardState>();
  const heldSourceIds = new Set<string>();
  for (const src of absorbed) {
    const st = await authorizePublish({
      documentId: src.id!, libraryId: src.libraryId || target.libraryId, orgId, actorUserId, actorRole,
      overrideReason: input.overrideReason ?? reason, force: input.force, operation: "merge",
      subjectLabel: src.documentNumber ?? undefined,
    });
    preStates.set(src.id!, st);
    if (st.activeHolds.length > 0) heldSourceIds.add(src.id!);
  }
  if (heldSourceIds.size > 0 && !copyHolds) {
    const labels = absorbed.filter((s) => heldSourceIds.has(s.id!)).map((s) => s.documentNumber ?? s.id).join(", ");
    throw new Error(`${labels} ${heldSourceIds.size === 1 ? "has an active hold" : "have active holds"} — a merge must carry holds onto the target. Turn "carry over holds" back on.`);
  }

  let reviewPolicy: string;
  if (target.kind === "create_new") {
    // REV-11: a new target in a library the sources are not in takes
    // authority THERE — it is born owned by the actor, so the database's
    // publish guard would admit it on that alone.
    const crossLibrary = absorbed.some((s) => (s.libraryId || target.libraryId) !== target.libraryId);
    if (crossLibrary) {
      const ok = await canPutFirstRevisionInContainer({ orgId, libraryId: target.libraryId, collectionId: null, actorUserId, actorRole });
      if (!ok) {
        throw new Error(`You don't have authority to issue documents in the library ${target.documentNumber.trim()} would be created in — nothing was merged. Ask an Admin or Doc Control.`);
      }
    }
    reviewPolicy = (await resolveCreationReviewGate({
      libraryId: target.libraryId, collectionId: null,
      what: `the merged document ${target.documentNumber.trim()}`,
      actor: { orgId, actorUserId, actorRole },
    })).recorded;
  } else if (target.revUp) {
    // The kept target's rev-up runs LAST (after every source is superseded),
    // so its own gate is asked NOW, exactly as revUpDocument will ask it —
    // per-library authority or ownership, the lock (no override: the merge
    // passes none to the rev-up) and the hold (no force) — so a refusal
    // changes nothing.
    await authorizePublish({ documentId: keptId!, libraryId: target.libraryId, orgId, actorUserId, actorRole });
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
    // No rev-up: the kept target takes the absorbed sources' holds and tag
    // union. Its content does not change and neither write advances it at
    // the database, so its gate is authority and the lock ONLY (review fix
    // 3): a held target — the natural place to absorb obsolete sheets —
    // still takes a merge, as it did before Round F and as the database
    // allows. Carrying more holds onto a held document is harmless.
    await authorizePublish({
      documentId: keptId!, libraryId: target.libraryId, orgId, actorUserId, actorRole,
      overrideReason: input.overrideReason ?? reason, force: input.force, operation: "merge",
      holds: "ignore",
    });
    reviewPolicy = "none — the extended target's content is unchanged (no rev-up)";
  }

  const { data: rows, error: stErr } = await supabase
    .from("documents").select("id, status").in("id", absorbed.map((s) => s.id!));
  if (stErr) throw new Error(`Couldn't read the sources' statuses (${stErr.message}) — nothing was merged.`);
  const priorStatuses: Record<string, string> = {};
  for (const r of (rows as Array<{ id: string; status: string | null }> | null) ?? []) priorStatuses[r.id] = String(r.status ?? "Issued");
  const missing = absorbed.filter((s) => !(s.id! in priorStatuses));
  if (missing.length > 0) throw new Error(`Couldn't find ${missing.map((s) => s.documentNumber ?? s.id).join(", ")} — nothing was merged.`);

  return { absorbed, preStates, heldSourceIds, priorStatuses, reviewPolicy };
}

async function mergeDocumentsInner(
  input: MergeDocumentsInput,
  gate: MergeGate,
  register: (c: Compensation) => void,
): Promise<MergeCommitted> {
  const {
    sources, target, reason, mocReference,
    copyHolds = true,
    orgId, actorUserId, actorUserName, actorEmail, actorRole,
  } = input;
  const { absorbed } = gate;

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
        sourceDocumentIds: absorbed.map((s) => s.id),
        sourceDocumentNumbers: absorbed.map((s) => s.documentNumber ?? null),
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
    // Extend existing: the kept target's content and tags change only after
    // the saga (its rev-up last, below; its tag union in finishMerge).
    targetDocumentId = target.target.id!;
  }

  // 2. HLD-2: carry every held source's holds onto the target BEFORE any
  //    source is superseded — inside the register, so a hold that fails to
  //    carry rolls the merge back rather than reporting a smaller count.
  let holdsCopied = 0;
  if (copyHolds) {
    for (const src of absorbed) {
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

  // 3. Mark each absorbed source as Superseded, link to the target. REV-14:
  //    each restore is registered BEFORE its flip, so a refusal at ANY
  //    source — its own flip or lineage write included — puts back every
  //    source already flipped AND that one.
  const retired: SupersededSource[] = [];
  for (const src of absorbed) {
    retired.push(await markSupersededAndLink({
      sourceDocId: src.id!,
      replacementDocIds: [targetDocumentId],
      reason: reason.trim(),
      mocReference,
      actor,
      register,
      label: `merge source ${src.documentNumber ?? src.id}`,
    }));
  }

  // 4. The extended target's rev-up, LAST: everything before it rolls back
  //    cleanly, and a rev-up that throws has published nothing (its
  //    refusals all come before the publish contract commits, and nothing
  //    after the commit throws). Its gate was asked in gateMerge with no
  //    hold on the target; the only holds on it now are the ones this merge
  //    carried — which the controller's explicit force on the sources
  //    already passed (HLD-2) — so that force, and only then, rides along.
  if (target.kind === "extend_existing" && target.revUp) {
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
      force: input.force === true && holdsCopied > 0,
    };
    await revUpDocument(revUpInput);
  }

  return { targetDocumentId, holdsCopied, retired };
}

/** The merge's irreversible half — run only after the saga committed:
 *  each absorbed source's in-flight review voided and share links revoked
 *  (REV-6 / REV-10, on its DOC_MERGED record), the kept target's tag union
 *  and its CREATED_FROM_MERGE record, project memberships, and the
 *  checkout holders told. Nothing here throws or rolls anything back. */
async function finishMerge(
  input: MergeDocumentsInput,
  gate: MergeGate,
  committed: MergeCommitted,
): Promise<MergeDocumentsResult> {
  const {
    target, reason, mocReference, copyProjectMembership = true,
    orgId, actorUserId, actorEmail, actorRole,
  } = input;
  const { absorbed } = gate;
  const { targetDocumentId, holdsCopied, retired } = committed;
  const actor: ActorContext = { orgId, actorUserId, actorEmail, actorRole };

  // 5. REV-12: every DOC_MERGED event carries the statuses ALL absorbed
  //    siblings held (read fresh in the gate), so reversing from any one of
  //    them restores each correctly.
  for (const r of retired) {
    await completeSourceRetirement({
      source: r,
      replacementDocIds: [targetDocumentId],
      reason: reason.trim(),
      mocReference,
      actor,
      sourceAuditAction: "DOC_MERGED",
      details: {
        mergedIntoDocumentId: targetDocumentId,
        mergeSiblings: absorbed.map((s) => s.id),
        // Explicit, authoritative flag so reverseMerge never has to infer
        // intent from a free-text note. true → target was freshly created
        // (park it on reverse); false → target was an existing doc extended
        // by the merge (leave it active on reverse).
        targetWasNewlyCreated: target.kind === "create_new",
        priorStatuses: gate.priorStatuses,
        // HLD-2 (review fix 4): the holds on THIS source the controller's
        // explicit force proceeded over (empty when it was not held).
        proceededOverHolds: (gate.preStates.get(r.sourceDocId)?.activeHolds ?? []).map((h) => ({ id: h.id ?? null, reason: h.reason })),
      },
    });
  }

  if (target.kind === "extend_existing") {
    // 6. The kept target's tag union (checked for the row too — an RLS
    //    zero-row answer is a refusal; either is on its record, the merge
    //    stands) and the record that it absorbed the sources.
    const { data: tagged, error: tagWriteErr } = await supabase.from("documents").update({
      asset_tags: target.assetTagsUnion,
      updated_at: new Date().toISOString(),
      updated_by: actorUserId,
    }).eq("id", targetDocumentId).select("id");
    const tagErr = tagWriteErr ?? (((tagged as unknown[] | null) ?? []).length === 0 ? { message: "the write was refused" } : null);
    await logRevisionEvent({
      orgId, documentId: targetDocumentId, versionId: "",
      userId: actorUserId, userEmail: actorEmail ?? "", userRole: actorRole ?? "",
      type: "CREATED_FROM_MERGE",
      details: {
        sourceDocumentIds: absorbed.map((s) => s.id),
        sourceDocumentNumbers: absorbed.map((s) => s.documentNumber ?? null),
        reason: reason.trim(),
        mocReference: mocReference?.trim() || null,
        note: "Existing document extended via merge",
        reviewPolicy: gate.reviewPolicy,
        assetTagsError: tagErr?.message ?? null,
      },
    });
  }

  // 6b. REV-15: a target CREATED by the merge is an issued first revision —
  //     its review clock and read-&-understood roster start now, after the
  //     saga (the call createDocumentWithFile makes). An extended target's
  //     rev-up started its own through the post-publish pipeline; without a
  //     rev-up its content did not change.
  const complianceClockWarnings = target.kind === "create_new"
    ? await startClocksForIssuedDocuments([targetDocumentId], actor)
    : [];

  // 7. Project memberships from each source — a secondary effect, reported
  //    via an honest count, never cause for a rollback.
  let projectsCopied = 0;
  if (copyProjectMembership) {
    for (const src of absorbed) {
      try {
        projectsCopied += await copyProjectMembershipToDoc({
          sourceDocId: src.id!, targetDocId: targetDocumentId, actor,
        });
      } catch { /* secondary effect — count stays honest, merge stands */ }
    }
  }

  for (const src of absorbed) {
    const pre = gate.preStates.get(src.id!);
    if (!pre) continue;
    await notifyHolderOfRetirement({
      preState: pre, documentId: src.id!, libraryId: src.libraryId || target.libraryId, orgId, actorUserId, actorEmail,
      verb: "merged", action: "merge", reason: reason.trim(),
    });
  }

  return {
    targetDocumentId,
    supersededSourceIds: absorbed.map((s) => s.id!),
    holdsCopied,
    projectMembershipsCopied: projectsCopied,
    complianceClockWarnings,
  };
}

function scopeIfAllAgree(sources: DocumentRecord[], key: "plantId" | "unitId" | "systemId"): string | null {
  const first = sources[0]?.[key] ?? null;
  if (!first) return null;
  return sources.every((s) => s[key] === first) ? (first ?? null) : null;
}
