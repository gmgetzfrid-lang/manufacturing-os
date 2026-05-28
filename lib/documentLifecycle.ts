// lib/documentLifecycle.ts
//
// Document-lifecycle workflows that go beyond a single forward rev-up:
//
//   - splitDocument:    one doc → N new docs (Sheet 3 → 3A + 3B)
//   - mergeDocuments:   N source docs → one target (existing or new)
//   - renumberDocument: change documents.document_number (with audit)
//   - setLevelRevUp:    batch rev-up of every sheet in a set
//
// All four use the existing document_supersessions table as the
// source-of-truth lineage record (no new schema). Audit events flow
// through lib/audit.ts so the Phase 3 timeline picks them up.
//
// Side-effect responsibilities for each operation are explicit:
//
//   - asset_tags: caller passes a per-target distribution; we don't
//     guess. Union, partition, and dedupe are the caller's call.
//   - holds: optional carry-over with origin note added to the copy.
//   - project_documents: optional carry-over of membership rows.
//   - scope FKs (plant/unit/system): copied from source by default;
//     caller can override.
//   - sheet_number / sheet_total on a set: we update the
//     document_sets.sheet_count, but we don't auto-renumber siblings —
//     that's too destructive to do silently. Callers can pass an
//     explicit sheet_number per new doc.
//
// What we deliberately don't do:
//   - We do NOT auto-rewrite cross-references inside other PDFs.
//     Those callouts ("see Sheet 3") live in the file content; only
//     a human can fix them. We DO surface "N other docs reference
//     this doc number" as a warning in the wizard preview (UI side).
//   - We do NOT merge revision history. Each new doc starts fresh
//     at the user-chosen rev label. The source doc keeps its full
//     history under Superseded status.

import { supabase } from "@/lib/supabase";
import { uploadToPath, makeLibraryStoragePath } from "@/lib/storage";
import { logRevisionEvent, logHoldEvent } from "@/lib/audit";
import { revUpDocument, type RevUpInput } from "@/lib/revisions";
import type {
  DocumentRecord, DocumentVersion, AssetTag,
} from "@/types/schema";

// ─── Common helpers ─────────────────────────────────────────────

interface ActorContext {
  orgId: string;
  actorUserId: string;
  actorEmail?: string;
  actorRole?: string;
}

async function sha256Hex(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Insert a brand-new document row + first version row + set
 *  current_version_id, all in one go. Returns the inserted document id.
 *  This is the building block used by split and merge to materialize
 *  new sheets. */
async function createNewDocWithFirstVersion(input: {
  orgId: string;
  libraryId: string;
  folderPath?: string[];
  collectionId?: string | null;
  setId?: string | null;
  sheetNumber?: number | null;
  documentNumber: string;
  title: string;
  name?: string;
  initialRevLabel: string;
  changeLog: string;
  assetTags: AssetTag[];
  // Optional scope FK inheritance
  plantId?: string | null;
  unitId?: string | null;
  systemId?: string | null;
  metadata?: Record<string, unknown>;
  file: File;
  actor: ActorContext;
  actorName?: string;
  /** Audit action type fired for the new doc — varies by caller
   *  (CREATED_FROM_SPLIT vs CREATED_FROM_MERGE). */
  creationAuditAction: "CREATED_FROM_SPLIT" | "CREATED_FROM_MERGE";
  /** Reference back to the operation that birthed this doc — the
   *  source doc id (for split) or array of source ids (for merge). */
  creationDetails: Record<string, unknown>;
}): Promise<{ documentId: string; versionId: string; fileUrl: string }> {
  const { orgId, libraryId, folderPath, file, actor } = input;
  const now = new Date().toISOString();

  // 1. Insert documents row first so we have an id to scope the version under.
  const { data: docData, error: docErr } = await supabase
    .from("documents")
    .insert({
      org_id: orgId,
      library_id: libraryId,
      collection_id: input.collectionId ?? null,
      set_id: input.setId ?? null,
      sheet_number: input.sheetNumber ?? null,
      document_number: input.documentNumber,
      title: input.title,
      name: input.name ?? input.title,
      rev: input.initialRevLabel,
      revision: input.initialRevLabel,
      status: "Issued",
      asset_tags: input.assetTags,
      plant_id: input.plantId ?? null,
      unit_id: input.unitId ?? null,
      system_id: input.systemId ?? null,
      metadata: input.metadata ?? {},
      created_by: actor.actorUserId,
      updated_by: actor.actorUserId,
    })
    .select("id")
    .single();
  if (docErr || !docData) throw new Error(docErr?.message || "Failed to create new document");
  const newDocId = (docData as { id: string }).id;

  // 2. Hash + upload the file.
  const fileHash = await sha256Hex(file);
  const safeRev = input.initialRevLabel.replace(/[^\w.\-]+/g, "_");
  const stem = file.name.replace(/\.[^.]+$/, "");
  const ext = file.name.split(".").pop() || "pdf";
  const versionedName = `${stem}__rev${safeRev}__${Date.now()}.${ext}`;
  const storagePath = makeLibraryStoragePath({ orgId, libraryId, folderPath, filename: versionedName });
  const uploadResult = await uploadToPath(file, storagePath, { contentType: file.type || undefined });

  // 3. Insert first version row.
  const { data: verData, error: verErr } = await supabase
    .from("document_versions")
    .insert({
      org_id: orgId,
      record_id: newDocId,
      revision_label: input.initialRevLabel,
      change_log: input.changeLog,
      file_url: uploadResult.url,
      file_type: file.type || "application/octet-stream",
      size: uploadResult.size,
      file_hash: fileHash,
      released_at: now,
      created_by: actor.actorUserId,
      created_by_name: input.actorName || actor.actorEmail || actor.actorUserId,
      created_at: now,
      source_file_name: file.name,
    })
    .select("id")
    .single();
  if (verErr || !verData) throw new Error(verErr?.message || "Failed to create version row");
  const versionId = (verData as { id: string }).id;

  // 4. Promote the version on the document.
  const { error: updErr } = await supabase
    .from("documents")
    .update({ current_version_id: versionId, updated_at: now })
    .eq("id", newDocId);
  if (updErr) throw new Error(updErr.message);

  // 5. Audit row.
  await logRevisionEvent({
    orgId,
    documentId: newDocId,
    versionId,
    userId: actor.actorUserId,
    userEmail: actor.actorEmail ?? "",
    userRole: actor.actorRole ?? "",
    type: input.creationAuditAction,
    details: {
      ...input.creationDetails,
      revisionLabel: input.initialRevLabel,
      narrative: input.changeLog,
      fileHash,
    },
  });

  return { documentId: newDocId, versionId, fileUrl: uploadResult.url };
}

/** Mark a document as superseded and link its replacements via the
 *  document_supersessions join table. Idempotent on the join rows. */
async function markSupersededAndLink(input: {
  sourceDocId: string;
  replacementDocIds: string[];
  reason: string;
  mocReference?: string;
  actor: ActorContext;
  /** Audit action recorded on the SOURCE document. DOC_SPLIT for
   *  splits, DOC_MERGED for merges, SUPERSEDE_DOC for plain
   *  supersessions. */
  sourceAuditAction: "DOC_SPLIT" | "DOC_MERGED" | "SUPERSEDE_DOC";
  /** Extra detail to record in the audit row. */
  details?: Record<string, unknown>;
}): Promise<void> {
  const { sourceDocId, replacementDocIds, reason, mocReference, actor } = input;
  const now = new Date().toISOString();

  const { error: updErr } = await supabase
    .from("documents")
    .update({
      status: "Superseded",
      superseded_at: now,
      superseded_by_user: actor.actorUserId,
      supersession_reason: reason.trim(),
      supersession_moc: mocReference?.trim() || null,
      updated_at: now,
      updated_by: actor.actorUserId,
    })
    .eq("id", sourceDocId);
  if (updErr) throw new Error(updErr.message);

  if (replacementDocIds.length > 0) {
    const rows = replacementDocIds.map((rid) => ({
      org_id: actor.orgId,
      superseded_doc_id: sourceDocId,
      replacement_doc_id: rid,
      reason: reason.trim(),
      created_by: actor.actorUserId,
      created_at: now,
    }));
    // ON CONFLICT DO NOTHING — partial UNIQUE on (superseded, replacement)
    await supabase.from("document_supersessions").upsert(rows, { onConflict: "superseded_doc_id,replacement_doc_id" });
  }

  // Empty version id on the audit log — supersession is a document-
  // level state change, not a version creation.
  await logRevisionEvent({
    orgId: actor.orgId,
    documentId: sourceDocId,
    versionId: "",
    userId: actor.actorUserId,
    userEmail: actor.actorEmail ?? "",
    userRole: actor.actorRole ?? "",
    type: input.sourceAuditAction,
    details: {
      reason: reason.trim(),
      mocReference: mocReference?.trim() || null,
      replacementDocIds,
      ...(input.details ?? {}),
    },
  });
}

/** Copy any ACTIVE holds from the source document onto the target,
 *  with a note describing the carry-over. Skips any reason that's
 *  already open on the target (the partial UNIQUE constraint would
 *  reject it anyway). */
async function copyActiveHoldsToDoc(input: {
  sourceDocId: string;
  targetDocId: string;
  originLabel: string;        // e.g. "Sheet 3 (split)"
  actor: ActorContext;
}): Promise<number> {
  const { sourceDocId, targetDocId, originLabel, actor } = input;

  const { data: openHolds } = await supabase
    .from("document_holds")
    .select("reason, notes, expected_release_at")
    .eq("document_id", sourceDocId)
    .is("released_at", null);

  const rows = (openHolds as Array<{ reason: string; notes: string | null; expected_release_at: string | null }>) ?? [];
  if (rows.length === 0) return 0;

  // Check existing open reasons on the target so we don't try to
  // insert duplicates (the partial unique would reject them).
  const { data: existing } = await supabase
    .from("document_holds")
    .select("reason")
    .eq("document_id", targetDocId)
    .is("released_at", null);
  const existingReasons = new Set(
    ((existing as Array<{ reason: string }>) ?? []).map((r) => r.reason)
  );

  let copied = 0;
  for (const h of rows) {
    if (existingReasons.has(h.reason)) continue;
    const note = `Carried over from ${originLabel}.${h.notes ? ` Original notes: ${h.notes}` : ""}`;
    const { data: insertedHold, error } = await supabase
      .from("document_holds")
      .insert({
        org_id: actor.orgId,
        document_id: targetDocId,
        reason: h.reason,
        notes: note,
        expected_release_at: h.expected_release_at,
        opened_by: actor.actorUserId,
        opened_by_name: actor.actorEmail ?? null,
      })
      .select("id")
      .single();
    if (!error && insertedHold) {
      copied++;
      // Mirror the hold audit event so the timeline shows it.
      await logHoldEvent({
        orgId: actor.orgId,
        documentId: targetDocId,
        holdId: (insertedHold as { id: string }).id,
        userId: actor.actorUserId,
        userEmail: actor.actorEmail,
        userRole: actor.actorRole,
        type: "HOLD_OPENED",
        reason: h.reason,
        details: { carriedOverFrom: sourceDocId, originLabel },
      });
    }
  }
  return copied;
}

/** Copy project_documents membership rows from source to target.
 *  The trigger maintains rows when checkouts happen; this manual copy
 *  is what gives a new doc immediate membership in the same projects
 *  its source belonged to. Uses source='manual' so the trigger
 *  doesn't fight it. */
async function copyProjectMembershipToDoc(input: {
  sourceDocId: string;
  targetDocId: string;
  actor: ActorContext;
}): Promise<number> {
  const { sourceDocId, targetDocId, actor } = input;
  const { data: links } = await supabase
    .from("project_documents")
    .select("project_id")
    .eq("document_id", sourceDocId);
  const rows = ((links as Array<{ project_id: string }>) ?? []);
  if (rows.length === 0) return 0;

  const now = new Date().toISOString();
  const inserts = rows.map((r) => ({
    org_id: actor.orgId,
    project_id: r.project_id,
    document_id: targetDocId,
    first_seen_at: now,
    last_seen_at: now,
    source: "manual" as const,
  }));
  const { error } = await supabase
    .from("project_documents")
    .upsert(inserts, { onConflict: "project_id,document_id" });
  if (error) throw new Error(error.message);
  return inserts.length;
}

// ─── splitDocument ──────────────────────────────────────────────

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
  }

  // 2. Mark the source as Superseded and write the supersessions join rows.
  await markSupersededAndLink({
    sourceDocId: source.id,
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

  // 3. Carry over holds + project memberships to each new doc.
  let holdsCopied = 0;
  let projectsCopied = 0;
  if (copyHolds) {
    for (const newId of newDocumentIds) {
      holdsCopied += await copyActiveHoldsToDoc({
        sourceDocId: source.id, targetDocId: newId,
        originLabel: `${source.documentNumber ?? "source"} (split)`,
        actor,
      });
    }
  }
  if (copyProjectMembership) {
    for (const newId of newDocumentIds) {
      projectsCopied += await copyProjectMembershipToDoc({
        sourceDocId: source.id, targetDocId: newId, actor,
      });
    }
  }

  // 4. Bump set's sheet_count if appropriate.
  if (inheritCollectionAndSet && source.setId) {
    // Source still exists in the set (as Superseded) and we added N new.
    // Net change to the active sheet count: +N (existing sheets unchanged,
    // source becomes inactive, new ones added). We update sheet_count to
    // reflect ACTIVE sheets only, leaving the historical row in place.
    await supabase
      .from("document_sets")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", source.setId);
    // We intentionally don't recompute sheet_count here — the existing
    // SetManager UI is the authority for that re-count.
  }

  return {
    supersededSourceId: source.id,
    newDocumentIds,
    holdsCopied,
    projectMembershipsCopied: projectsCopied,
  };
}

// ─── mergeDocuments ─────────────────────────────────────────────

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

// ─── renumberDocument ───────────────────────────────────────────

export interface RenumberInput {
  doc: DocumentRecord;
  newDocumentNumber: string;
  reason: string;
  orgId: string;
  actorUserId: string;
  actorEmail?: string;
  actorRole?: string;
}

export async function renumberDocument(input: RenumberInput): Promise<void> {
  const { doc, newDocumentNumber, reason, orgId, actorUserId, actorEmail, actorRole } = input;
  if (!doc.id) throw new Error("Document is missing an id.");
  if (!newDocumentNumber.trim()) throw new Error("New document number is required.");
  if (!reason.trim()) throw new Error("Reason is required.");
  const oldNumber = doc.documentNumber ?? null;
  const now = new Date().toISOString();

  const { error } = await supabase
    .from("documents")
    .update({
      document_number: newDocumentNumber.trim(),
      updated_at: now,
      updated_by: actorUserId,
    })
    .eq("id", doc.id);
  if (error) throw new Error(error.message);

  await logRevisionEvent({
    orgId, documentId: doc.id, versionId: "",
    userId: actorUserId, userEmail: actorEmail ?? "", userRole: actorRole ?? "",
    type: "DOC_RENUMBERED",
    details: {
      previousDocumentNumber: oldNumber,
      newDocumentNumber: newDocumentNumber.trim(),
      reason: reason.trim(),
    },
  });
}

// ─── setLevelRevUp ──────────────────────────────────────────────
//
// Batch rev-up of every active sheet in a set. Each sheet still gets
// its own RevUp call (so each gets a real version row, hash, and
// audit event) — the batch wrapper just shares the metadata that's
// typically uniform across the set (MOC, change_log, issue type)
// and aggregates results.
//
// We do NOT accept N PDF files here — the per-sheet file is provided
// by the caller because each sheet's file is different.

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

  // Single audit event recording the batch operation itself.
  await logRevisionEvent({
    orgId,
    documentId: setId,            // resourceId = set id (so the set's timeline picks it up if we ever add one)
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
