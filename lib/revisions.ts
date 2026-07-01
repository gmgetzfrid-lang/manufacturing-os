// lib/revisions.ts
// Document-control business logic for the Rev-Up workflow.
//
// A Rev-Up is the canonical "I'm publishing a new revision of an existing
// document" operation. It:
//   1. Hashes the uploaded file (SHA-256) so future audits can prove which
//      bytes were attached to which revision.
//   2. Uploads the new file to a revision-scoped storage path (so the
//      previous file remains intact and readable).
//   3. Creates a new `document_versions` row with the full engineering
//      signoff chain, MOC reference, source CAD filename, and a link to
//      the version it supersedes.
//   4. Marks the previous version's `superseded_at` so version-history
//      queries can render "Superseded YYYY-MM-DD" without joining sibling
//      rows.
//   5. Flips `documents.current_version_id` and rolls the human-readable
//      `documents.rev` label forward.
//   6. Writes a `REV_UP` row to `audit_logs` with everything needed for a
//      PSM-style audit reconstruction.

import { supabase } from "@/lib/supabase";
import { uploadToPath, makeLibraryStoragePath } from "@/lib/storage";
import { logRevisionEvent } from "@/lib/audit";
import {
  fetchPublishGuardState,
  evaluatePublishGuard,
  resolveCanControlLibrary,
  DocumentMutationBlockedError,
  type PublishGuardState,
} from "@/lib/documentGuards";
import { getActiveEpisode, postEpisodeSystemMessage } from "@/lib/checkoutEpisodes";
import { notify } from "@/lib/inAppNotifications";
import type { Principal } from "@/lib/permissions";
import type { DocumentRecord, DocumentVersion, DocumentStatus, Role } from "@/types/schema";
import { onDocumentIssued } from "@/lib/reviewCycles";
import { onDocumentIssuedAck } from "@/lib/acknowledgments";
import { isEffectiveOwnerOfDocument } from "@/lib/ownership";

export type RevUpInput = {
  doc: DocumentRecord;
  libraryId: string;
  folderPath?: string[];
  file: File;

  // Required engineering metadata (form-validated upstream)
  revisionLabel: string;
  changeLog: string;

  // Optional fields the user may fill in
  issueType?: DocumentVersion["issueType"];
  changeType?: DocumentVersion["changeType"];
  drawnByName?: string;
  checkedByName?: string;
  approvedByName?: string;
  mocReference?: string;
  sourceFileName?: string;

  // Actor context (the user performing the rev-up)
  orgId: string;
  actorUserId: string;
  actorEmail?: string;
  actorRole?: string;
  /** Controllers (Admin/DocCtrl) may force past a foreign lock or active hold. */
  force?: boolean;
  /** Required when publishing over ANOTHER user's checkout. The message shown to
   *  that user (what's happening + why). Their checkout is left OPEN; they're
   *  notified and deep-linked to the new revision. */
  overrideReason?: string;
};

export type RevUpResult = {
  newVersion: DocumentVersion;
  supersededVersionId: string | null;
};

async function sha256Hex(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function suggestRevLabel(current?: string | null): string {
  if (!current) return "0";
  const trimmed = current.trim();
  // Numeric (0, 1, 2, …) — increment by 1
  if (/^\d+$/.test(trimmed)) return String(parseInt(trimmed, 10) + 1);
  // Prefixed numeric (R0, R1, Rev 3, …)
  const m = trimmed.match(/^(.*?)(\d+)$/);
  if (m) return `${m[1]}${parseInt(m[2], 10) + 1}`;
  // Single alpha (A, B, C, …)
  if (/^[A-Y]$/i.test(trimmed)) return String.fromCharCode(trimmed.charCodeAt(0) + 1);
  // Fallback: append "_next"
  return `${trimmed}_next`;
}

/** Public helper so the modal can pre-fill the rev label input. */
export function suggestNextRevisionLabel(currentRev?: string | null): string {
  return suggestRevLabel(currentRev);
}

/**
 * Authorize a publish on `libraryId` and evaluate the lock/hold guard, returning
 * the authoritative pre-publish state. Throws a UI-safe error when the actor
 * lacks per-library publish authority, when a required override reason is missing,
 * or when the guard blocks (foreign lock without authority, or an active hold).
 *
 * `force` is set ONLY when the doc is locked by ANOTHER user — so a normal publish
 * still respects an active hold exactly as before; we never silently blow past a
 * hold on an ordinary rev-up.
 */
async function authorizePublish(opts: {
  documentId: string;
  libraryId: string;
  orgId: string;
  actorUserId: string;
  actorRole?: string;
  overrideReason?: string;
}): Promise<PublishGuardState> {
  const principal: Principal = {
    uid: opts.actorUserId,
    role: (opts.actorRole ?? "Viewer") as Role,
    orgId: opts.orgId,
  };
  let canControlLibrary = await resolveCanControlLibrary(opts.libraryId, principal);
  // The document's effective owner may publish it even without library authority.
  if (!canControlLibrary) {
    canControlLibrary = await isEffectiveOwnerOfDocument(opts.documentId, opts.actorUserId);
  }
  if (!canControlLibrary) {
    throw new Error(
      "You don't have authority to publish revisions in this library. Ask an Admin or Doc Control to grant it.",
    );
  }
  const state = await fetchPublishGuardState(opts.documentId);
  const lockedByOther =
    !!state.checkedOutBy && String(state.checkedOutBy) !== String(opts.actorUserId);
  if (lockedByOther && !opts.overrideReason?.trim()) {
    throw new Error("A reason is required to publish over another user's checkout.");
  }
  const decision = evaluatePublishGuard(state, {
    actorUserId: opts.actorUserId,
    actorRole: opts.actorRole,
    canControlLibrary,
    force: lockedByOther,
  });
  if (!decision.ok) throw new DocumentMutationBlockedError(decision);
  return state;
}

/**
 * After a successful publish over another user's checkout: leave their checkout
 * OPEN, but (a) write a system note onto their active checkout episode and (b)
 * send them an in-app notification deep-linked to the new revision — both carrying
 * what changed + why. Fire-and-forget: a notification hiccup never fails the
 * publish that already committed.
 */
async function noteOverrideOnHolder(opts: {
  preState: PublishGuardState;
  documentId: string;
  libraryId: string;
  orgId: string;
  actorUserId: string;
  actorEmail?: string;
  revisionLabel: string;
  changeNarrative: string;
  overrideReason?: string;
  newVersionId?: string | null;
}): Promise<void> {
  const holder = opts.preState.checkedOutBy;
  if (!holder || String(holder) === String(opts.actorUserId)) return;
  const who = opts.actorEmail || opts.actorUserId;
  const reason = opts.overrideReason?.trim() || "(no reason given)";
  try {
    const episode = await getActiveEpisode(opts.documentId);
    await postEpisodeSystemMessage({
      orgId: opts.orgId,
      documentId: opts.documentId,
      episodeId: episode?.id ?? null,
      text: `${who} published Rev ${opts.revisionLabel} while you have this checked out — your checkout stays open. What changed: ${opts.changeNarrative}. Why now: ${reason}`,
    });
  } catch {
    /* best-effort: the notification below is the primary signal */
  }
  await notify({
    orgId: opts.orgId,
    userId: String(holder),
    kind: "revision_published_over_checkout",
    title: `New Rev ${opts.revisionLabel} published while you're checked out`,
    body: `What changed: ${opts.changeNarrative} — ${reason}`,
    link: `/documents/${opts.libraryId}?doc=${opts.documentId}`,
    resourceType: "document",
    resourceId: opts.documentId,
    actorUserId: opts.actorUserId,
    actorName: who,
    metadata: { newVersionId: opts.newVersionId ?? null, newRev: opts.revisionLabel, reason },
  });
}

/**
 * Create a BRAND-NEW document and attach its first version from an uploaded file.
 *
 * Distinct from revUpDocument (which publishes a new revision over an EXISTING
 * doc and is gated by per-library publish authority): this is a creation, gated
 * by library write access at the UI/RLS layer, so it does NOT run the publish
 * guard. Used by the "upload & link a drawing" flow.
 */
export async function createDocumentWithFile(input: {
  orgId: string;
  libraryId: string;
  collectionId?: string | null;
  folderPath?: string[];
  documentNumber: string;
  title?: string;
  file: File;
  status?: DocumentStatus;
  actorUserId: string;
  actorEmail?: string;
}): Promise<{ documentId: string }> {
  const now = new Date().toISOString();
  const docNum = input.documentNumber.trim();
  if (!docNum) throw new Error("A document number is required.");
  const title = input.title?.trim() || docNum;

  const { data: docRow, error: docErr } = await supabase
    .from("documents")
    .insert({
      org_id: input.orgId,
      library_id: input.libraryId,
      collection_id: input.collectionId ?? null,
      document_number: docNum,
      title,
      name: title,
      rev: "0",
      status: input.status ?? "Issued",
      created_at: now,
      created_by: input.actorUserId,
      updated_at: now,
      updated_by: input.actorUserId,
    })
    .select("id")
    .single();
  if (docErr || !docRow) throw new Error(docErr?.message || "Failed to create document");
  const documentId = docRow.id as string;

  const fileHash = await sha256Hex(input.file);
  const storagePath = makeLibraryStoragePath({
    orgId: input.orgId,
    libraryId: input.libraryId,
    folderPath: input.folderPath,
    filename: `Rev0_${input.file.name || "drawing.pdf"}`,
  });
  const uploadResult = await uploadToPath(input.file, storagePath, { contentType: input.file.type });

  const { data: ver, error: verErr } = await supabase
    .from("document_versions")
    .insert({
      org_id: input.orgId,
      record_id: documentId,
      revision_label: "0",
      file_url: uploadResult.url,
      file_type: input.file.type || null,
      size: uploadResult.size,
      change_log: "Initial upload",
      created_by: input.actorUserId,
      created_by_name: input.actorEmail || input.actorUserId,
      created_at: now,
      released_at: now,
      file_hash: fileHash,
    })
    .select("id")
    .single();
  if (verErr || !ver) throw new Error(verErr?.message || "Failed to create the document's file version");

  await supabase.from("documents").update({ current_version_id: ver.id, updated_at: now }).eq("id", documentId);
  // Seed the review clock so a new doc picks up any library/folder review cycle.
  await onDocumentIssued({ orgId: input.orgId, documentId, userId: input.actorUserId, userName: input.actorEmail });
  // Open the read-&-understood roster if an ack policy covers this new doc.
  await onDocumentIssuedAck({ orgId: input.orgId, documentId, actorId: input.actorUserId, actorName: input.actorEmail });
  return { documentId };
}

export async function revUpDocument(input: RevUpInput): Promise<RevUpResult> {
  const {
    doc, libraryId, folderPath, file,
    revisionLabel, changeLog, issueType, changeType,
    drawnByName, checkedByName, approvedByName,
    mocReference, sourceFileName,
    orgId, actorUserId, actorEmail, actorRole,
  } = input;

  if (!doc.id) throw new Error("Document is missing an id");
  if (!revisionLabel.trim()) throw new Error("Revision label is required");
  if (!changeLog.trim()) throw new Error("Change narrative is required");

  // 0. Authorize BEFORE we upload anything: the actor must hold per-library
  //    publish authority (Admin/DocCtrl, or granted "publish" on this library),
  //    and either own the lock / find it clear, or supply an override reason to
  //    publish over another user's checkout. Returns the pre-publish state so we
  //    know whose checkout (if any) to notify afterward.
  const preState = await authorizePublish({
    documentId: doc.id, libraryId, orgId, actorUserId, actorRole,
    overrideReason: input.overrideReason,
  });

  // 1. Hash the bytes BEFORE uploading so the hash matches what's stored.
  const fileHash = await sha256Hex(file);

  // 2. Upload to a revision-scoped path. Suffix with the rev label + epoch
  //    so re-uploads under the same revision don't collide.
  const safeRev = revisionLabel.trim().replace(/[^\w.\-]+/g, "_");
  const stem = file.name.replace(/\.[^.]+$/, "");
  const ext = file.name.split(".").pop() || "pdf";
  const versionedName = `${stem}__rev${safeRev}__${Date.now()}.${ext}`;

  const storagePath = makeLibraryStoragePath({
    orgId, libraryId, folderPath, filename: versionedName,
  });
  const uploadResult = await uploadToPath(file, storagePath, {
    contentType: file.type || undefined,
  });

  const now = new Date().toISOString();
  const previousVersionId = doc.currentVersionId ?? null;

  // 3. Create the new version row. Supersedes link is captured immutably here.
  const { data: insertedRow, error: insertErr } = await supabase
    .from("document_versions")
    .insert({
      org_id: orgId,
      record_id: doc.id,
      revision_label: revisionLabel.trim(),
      issue_type: issueType ?? null,
      change_type: changeType ?? null,
      file_url: uploadResult.url,
      file_type: file.type || "application/octet-stream",
      size: uploadResult.size,
      change_log: changeLog.trim(),
      created_by: actorUserId,
      created_by_name: actorEmail || actorUserId,
      created_at: now,
      // Document-control columns
      supersedes_version_id: previousVersionId,
      drawn_by_name: drawnByName?.trim() || null,
      checked_by_name: checkedByName?.trim() || null,
      approved_by_name: approvedByName?.trim() || null,
      released_at: now,
      moc_reference: mocReference?.trim() || null,
      source_file_name: sourceFileName?.trim() || null,
      file_hash: fileHash,
    })
    .select("*")
    .single();

  if (insertErr || !insertedRow) {
    throw new Error(insertErr?.message || "Failed to write new version row");
  }

  // 4. Mark the previous version as superseded (cosmetic — derivable from
  //    supersedes_version_id on the new row, but cheaper to read).
  if (previousVersionId) {
    await supabase
      .from("document_versions")
      .update({ superseded_at: now })
      .eq("id", previousVersionId);
  }

  // 5. Promote the new version on the parent document and roll the rev label.
  const { error: docErr } = await supabase
    .from("documents")
    .update({
      current_version_id: insertedRow.id,
      rev: revisionLabel.trim(),
      revision: revisionLabel.trim(),
      status: "Issued",
      updated_at: now,
      updated_by: actorUserId,
    })
    .eq("id", doc.id);

  if (docErr) throw new Error(docErr.message);

  // 6. Audit row — captures everything needed to reconstruct the change.
  await logRevisionEvent({
    orgId,
    documentId: doc.id,
    versionId: insertedRow.id as string,
    userId: actorUserId,
    userEmail: actorEmail ?? "",
    userRole: actorRole ?? "",
    type: "REV_UP",
    details: {
      previousRev: doc.rev ?? null,
      newRev: revisionLabel.trim(),
      previousVersionId,
      narrative: changeLog.trim(),
      issueType: issueType ?? null,
      changeType: changeType ?? null,
      mocReference: mocReference?.trim() || null,
      sourceFileName: sourceFileName?.trim() || null,
      fileHash,
      drawnByName: drawnByName?.trim() || null,
      checkedByName: checkedByName?.trim() || null,
      approvedByName: approvedByName?.trim() || null,
    },
  });

  // 7. If we published over another user's checkout, leave it open but note what
  //    happened on their episode and notify them with a link to the new revision.
  await noteOverrideOnHolder({
    preState, documentId: doc.id, libraryId, orgId, actorUserId, actorEmail,
    revisionLabel: revisionLabel.trim(), changeNarrative: changeLog.trim(),
    overrideReason: input.overrideReason, newVersionId: insertedRow.id as string,
  });

  // A new revision IS a review — reset the review clock (recomputes next_review_date).
  await onDocumentIssued({ orgId, documentId: doc.id, userId: actorUserId, userName: actorEmail });
  // A new revision requires re-acknowledgment — void the prior rev's roster and
  // open a fresh one for everyone assigned.
  await onDocumentIssuedAck({ orgId, documentId: doc.id, actorId: actorUserId, actorName: actorEmail });

  return {
    newVersion: rowToVersion(insertedRow),
    supersededVersionId: previousVersionId,
  };
}

/** Map a Supabase row to the TS interface. Exposed so other panels can reuse. */
export function rowToVersion(r: Record<string, unknown>): DocumentVersion {
  return {
    id: r.id as string,
    orgId: r.org_id as string | undefined,
    recordId: r.record_id as string,
    revisionLabel: r.revision_label as string,
    issueType: r.issue_type as DocumentVersion["issueType"],
    changeType: r.change_type as DocumentVersion["changeType"],
    fileUrl: r.file_url as string,
    fileType: r.file_type as string | undefined,
    size: r.size as number | undefined,
    isFlattened: r.is_flattened as boolean | undefined,
    hasWatermark: r.has_watermark as boolean | undefined,
    watermarkPolicyId: r.watermark_policy_id as string | undefined,
    downloadPolicy: r.download_policy as DocumentVersion["downloadPolicy"],
    changeLog: r.change_log as string | undefined,
    relatedTicketId: r.related_ticket_id as string | undefined,
    createdBy: r.created_by as string,
    createdByName: r.created_by_name as string | undefined,
    createdAt: r.created_at as unknown as DocumentVersion["createdAt"],
    approvedBy: r.approved_by as string | undefined,
    supersedesVersionId: r.supersedes_version_id as string | undefined,
    drawnBy: r.drawn_by as string | undefined,
    drawnByName: r.drawn_by_name as string | undefined,
    checkedBy: r.checked_by as string | undefined,
    checkedByName: r.checked_by_name as string | undefined,
    approvedByName: r.approved_by_name as string | undefined,
    approvedAt: r.approved_at as unknown as DocumentVersion["approvedAt"],
    releasedAt: r.released_at as unknown as DocumentVersion["releasedAt"],
    supersededAt: r.superseded_at as unknown as DocumentVersion["supersededAt"],
    mocReference: r.moc_reference as string | undefined,
    sourceFileName: r.source_file_name as string | undefined,
    revertedFromVersionId: r.reverted_from_version_id as string | undefined,
    fileHash: r.file_hash as string | undefined,
  };
}

/** List every version of a document, newest first. */
export async function listVersions(documentId: string): Promise<DocumentVersion[]> {
  const { data, error } = await supabase
    .from("document_versions")
    .select("*")
    .eq("record_id", documentId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []).map(rowToVersion);
}

// ─── REVERT ───────────────────────────────────────────────────────────────
// Rolling back to a previous version is never a silent flip of
// current_version_id. We create a brand-new version row that COPIES the file
// payload of the chosen old version, sets reverted_from_version_id, and goes
// through the same supersedes_version_id chain as any other rev-up. The audit
// log gets a REVERT entry with the reason and (optional) MOC. The result is
// that the version history can always be replayed forward — no rewrites.

export type RevertInput = {
  doc: DocumentRecord;
  libraryId: string;                  // scopes the per-library publish-authority check
  targetVersion: DocumentVersion;     // the older version we're reverting to
  reason: string;                     // required free text
  mocReference?: string;
  orgId: string;
  actorUserId: string;
  actorEmail?: string;
  actorRole?: string;
  /** Controllers (Admin/DocCtrl) may force past a foreign lock or active hold. */
  force?: boolean;
  /** Required when reverting a doc someone else has checked out. */
  overrideReason?: string;
};

export async function revertToVersion(input: RevertInput): Promise<DocumentVersion> {
  const { doc, libraryId, targetVersion, reason, mocReference, orgId, actorUserId, actorEmail, actorRole } = input;
  if (!doc.id) throw new Error("Document is missing an id");
  if (!targetVersion.id) throw new Error("Target version is missing an id");
  if (!reason.trim()) throw new Error("Revert reason is required");

  // Same invariants as a rev-up: only an authorized publisher for this library,
  // and either own/clear lock or an override reason for a foreign checkout.
  const preState = await authorizePublish({
    documentId: doc.id, libraryId, orgId, actorUserId, actorRole,
    overrideReason: input.overrideReason,
  });

  const previousVersionId = doc.currentVersionId ?? null;
  const now = new Date().toISOString();

  // The new version row reuses the target version's file_url. We deliberately
  // do NOT copy the file in storage — the new row points to the same bytes the
  // older row points to. file_hash carries forward so integrity verification
  // still works. If you want a literal file copy later, we can add that.
  const revertedLabel = `${targetVersion.revisionLabel}-revert-${Date.now()}`;

  const { data: insertedRow, error: insertErr } = await supabase
    .from("document_versions")
    .insert({
      org_id: orgId,
      record_id: doc.id,
      revision_label: revertedLabel,
      issue_type: targetVersion.issueType ?? null,
      change_type: "Correction",
      file_url: targetVersion.fileUrl,
      file_type: targetVersion.fileType ?? null,
      size: targetVersion.size ?? null,
      change_log: `REVERT to Rev ${targetVersion.revisionLabel}: ${reason.trim()}`,
      created_by: actorUserId,
      created_by_name: actorEmail || actorUserId,
      created_at: now,
      supersedes_version_id: previousVersionId,
      released_at: now,
      moc_reference: mocReference?.trim() || null,
      reverted_from_version_id: targetVersion.id,
      file_hash: targetVersion.fileHash ?? null,
    })
    .select("*")
    .single();

  if (insertErr || !insertedRow) throw new Error(insertErr?.message || "Failed to create revert version");

  if (previousVersionId) {
    await supabase
      .from("document_versions")
      .update({ superseded_at: now })
      .eq("id", previousVersionId);
  }

  const { error: docErr } = await supabase
    .from("documents")
    .update({
      current_version_id: insertedRow.id,
      rev: revertedLabel,
      revision: revertedLabel,
      status: "Issued",
      updated_at: now,
      updated_by: actorUserId,
    })
    .eq("id", doc.id);

  if (docErr) throw new Error(docErr.message);

  await logRevisionEvent({
    orgId,
    documentId: doc.id,
    versionId: insertedRow.id as string,
    userId: actorUserId,
    userEmail: actorEmail ?? "",
    userRole: actorRole ?? "",
    type: "REVERT",
    details: {
      revertedFromVersionId: targetVersion.id,
      revertedFromRev: targetVersion.revisionLabel,
      previousVersionId,
      reason: reason.trim(),
      mocReference: mocReference?.trim() || null,
    },
  });

  await noteOverrideOnHolder({
    preState, documentId: doc.id, libraryId, orgId, actorUserId, actorEmail,
    revisionLabel: revertedLabel,
    changeNarrative: `Reverted to Rev ${targetVersion.revisionLabel}: ${reason.trim()}`,
    overrideReason: input.overrideReason, newVersionId: insertedRow.id as string,
  });

  return rowToVersion(insertedRow);
}

// ─── ARCHIVE / UNARCHIVE ──────────────────────────────────────────────────

export type ArchiveInput = {
  doc: DocumentRecord;
  reason: string;
  orgId: string;
  actorUserId: string;
  actorEmail?: string;
  actorRole?: string;
};

export async function archiveDocument(input: ArchiveInput): Promise<void> {
  const { doc, reason, orgId, actorUserId, actorEmail, actorRole } = input;
  if (!doc.id) throw new Error("Document is missing an id");
  if (!reason.trim()) throw new Error("Archive reason is required");

  const now = new Date().toISOString();
  const { error } = await supabase
    .from("documents")
    .update({
      status: "Archived",
      archived_at: now,
      archived_by: actorUserId,
      archive_reason: reason.trim(),
      updated_at: now,
      updated_by: actorUserId,
    })
    .eq("id", doc.id);

  if (error) throw new Error(error.message);

  await logRevisionEvent({
    orgId,
    documentId: doc.id,
    versionId: doc.currentVersionId ?? "",
    userId: actorUserId,
    userEmail: actorEmail ?? "",
    userRole: actorRole ?? "",
    type: "ARCHIVE_DOC",
    details: { reason: reason.trim(), action: "archive" },
  });
}

export async function unarchiveDocument(input: ArchiveInput & { restoreStatus?: string }): Promise<void> {
  const { doc, reason, orgId, actorUserId, actorEmail, actorRole, restoreStatus } = input;
  if (!doc.id) throw new Error("Document is missing an id");

  const now = new Date().toISOString();
  const { error } = await supabase
    .from("documents")
    .update({
      status: restoreStatus || "Issued",
      archived_at: null,
      archived_by: null,
      archive_reason: null,
      updated_at: now,
      updated_by: actorUserId,
    })
    .eq("id", doc.id);

  if (error) throw new Error(error.message);

  await logRevisionEvent({
    orgId,
    documentId: doc.id,
    versionId: doc.currentVersionId ?? "",
    userId: actorUserId,
    userEmail: actorEmail ?? "",
    userRole: actorRole ?? "",
    type: "ARCHIVE_DOC",
    details: { reason: reason?.trim() || "Restored from archive", action: "unarchive" },
  });
}

// ─── SUPERSEDE DOCUMENT ───────────────────────────────────────────────────
// One whole document is replaced by zero or more *different* documents.
// (Rev-Up is for a new revision of the same document; this is for retiring
// or splitting a drawing.)

export type SupersedeInput = {
  doc: DocumentRecord;                    // the document being retired
  replacementDocNumbers: string[];        // document_number strings for the replacement(s)
  libraryId: string;                      // scope the doc-number lookup
  reason: string;                         // required
  mocReference?: string;
  orgId: string;
  actorUserId: string;
  actorEmail?: string;
  actorRole?: string;
  /** Controllers (Admin/DocCtrl) may force past a foreign lock or active hold. */
  force?: boolean;
  /** Required when superseding a doc someone else has checked out. */
  overrideReason?: string;
};

export type SupersedeResult = {
  resolvedReplacementIds: string[];
  unresolvedDocNumbers: string[];         // doc numbers that couldn't be looked up
};

export async function supersedeDocument(input: SupersedeInput): Promise<SupersedeResult> {
  const {
    doc, replacementDocNumbers, libraryId, reason, mocReference,
    orgId, actorUserId, actorEmail, actorRole,
  } = input;
  if (!doc.id) throw new Error("Document is missing an id");
  if (!reason.trim()) throw new Error("Supersession reason is required");

  // Retiring a document is a canonical-state change too: same per-library publish
  // authority + lock/hold guard, and an override reason if someone else is
  // actively editing it.
  const preState = await authorizePublish({
    documentId: doc.id, libraryId, orgId, actorUserId, actorRole,
    overrideReason: input.overrideReason,
  });

  const now = new Date().toISOString();

  // Resolve replacement document numbers to UUIDs scoped to this library.
  const resolved: string[] = [];
  const unresolved: string[] = [];
  if (replacementDocNumbers.length > 0) {
    const { data } = await supabase
      .from("documents")
      .select("id, document_number")
      .eq("org_id", orgId)
      .eq("library_id", libraryId)
      .in("document_number", replacementDocNumbers);

    const map = new Map<string, string>();
    for (const row of (data ?? []) as Array<{ id: string; document_number: string }>) {
      map.set(row.document_number, row.id);
    }
    for (const dn of replacementDocNumbers) {
      const id = map.get(dn);
      if (id) resolved.push(id);
      else unresolved.push(dn);
    }
  }

  // Mark the original document as Superseded with full metadata.
  const { error: updErr } = await supabase
    .from("documents")
    .update({
      status: "Superseded",
      superseded_at: now,
      superseded_by_user: actorUserId,
      supersession_reason: reason.trim(),
      supersession_moc: mocReference?.trim() || null,
      updated_at: now,
      updated_by: actorUserId,
    })
    .eq("id", doc.id);

  if (updErr) throw new Error(updErr.message);

  // Record the (old → new) join rows. Idempotent via UNIQUE constraint —
  // we ignore duplicate-key errors so re-running the action is safe.
  if (resolved.length > 0) {
    const rows = resolved.map((replacementId) => ({
      org_id: orgId,
      superseded_doc_id: doc.id,
      replacement_doc_id: replacementId,
      reason: reason.trim(),
      created_by: actorUserId,
      created_at: now,
    }));
    await supabase.from("document_supersessions").insert(rows);
  }

  await logRevisionEvent({
    orgId,
    documentId: doc.id,
    versionId: doc.currentVersionId ?? "",
    userId: actorUserId,
    userEmail: actorEmail ?? "",
    userRole: actorRole ?? "",
    type: "SUPERSEDE_DOC",
    details: {
      reason: reason.trim(),
      mocReference: mocReference?.trim() || null,
      replacementDocNumbers,
      resolvedReplacementIds: resolved,
      unresolvedDocNumbers: unresolved,
    },
  });

  // If we superseded a doc someone else had checked out, leave their checkout open
  // but tell them it was retired (and why), with a link to the document.
  const holder = preState.checkedOutBy;
  if (holder && String(holder) !== String(actorUserId)) {
    const who = actorEmail || actorUserId;
    try {
      const episode = await getActiveEpisode(doc.id);
      await postEpisodeSystemMessage({
        orgId, documentId: doc.id, episodeId: episode?.id ?? null,
        text: `${who} superseded this document while you have it checked out — your checkout stays open. Reason: ${reason.trim()}`,
      });
    } catch {
      /* best-effort */
    }
    await notify({
      orgId, userId: String(holder),
      kind: "revision_published_over_checkout",
      title: "Document superseded while you're checked out",
      body: `Superseded by ${who}: ${reason.trim()}`,
      link: `/documents/${libraryId}?doc=${doc.id}`,
      resourceType: "document", resourceId: doc.id,
      actorUserId, actorName: who,
      metadata: { action: "supersede", reason: reason.trim() },
    });
  }

  return { resolvedReplacementIds: resolved, unresolvedDocNumbers: unresolved };
}

// ─── BACKFILL HISTORICAL VERSION ─────────────────────────────────────────
//
// `backfillVersion` is for adding a HISTORICAL revision to a document
// after the fact. Use case: existing app users have been uploading
// only the current version of each drawing, and now they want to
// retroactively populate the chain so the Phase 4 Compare/diff
// overlay has something to diff against.
//
// Key difference from revUpDocument:
//   - Does NOT update documents.current_version_id
//   - Does NOT update documents.rev / revision / status
//   - Does NOT mark any other version as superseded
//   - released_at defaults to NOW() but can be set to a historical
//     date the user provides
//   - The backfilled row's supersedes_version_id is optional — pass
//     a value to slot into the chain, omit to leave the row
//     "free-floating" (still searchable, still diffable, just not
//     part of the linked-list chain)
//
// Fires a REV_BACKFILL audit event so the timeline shows this was
// added historically, not released forward.

export type BackfillInput = {
  doc: DocumentRecord;
  libraryId: string;
  folderPath?: string[];
  file: File;

  // Required engineering metadata
  revisionLabel: string;
  changeLog: string;

  // Optional fields
  issueType?: DocumentVersion["issueType"];
  changeType?: DocumentVersion["changeType"];
  drawnByName?: string;
  checkedByName?: string;
  approvedByName?: string;
  mocReference?: string;
  sourceFileName?: string;

  /** Historical release timestamp (ISO 8601). Defaults to NOW(). */
  releasedAt?: string;
  /** Optional: this backfilled rev supersedes which existing version. */
  supersedesVersionId?: string;

  // Actor context
  orgId: string;
  actorUserId: string;
  actorEmail?: string;
  actorRole?: string;
};

export async function backfillVersion(input: BackfillInput): Promise<DocumentVersion> {
  const {
    doc, libraryId, folderPath, file,
    revisionLabel, changeLog, issueType, changeType,
    drawnByName, checkedByName, approvedByName,
    mocReference, sourceFileName,
    releasedAt, supersedesVersionId,
    orgId, actorUserId, actorEmail, actorRole,
  } = input;

  if (!doc.id) throw new Error("Document is missing an id");
  if (!revisionLabel.trim()) throw new Error("Revision label is required");
  if (!changeLog.trim()) throw new Error("Change narrative is required");

  // Hash + upload to a revision-scoped path. Suffix marks the file as
  // a backfilled historical version so it doesn't collide with a
  // forward rev-up under the same label.
  const fileHash = await sha256Hex(file);
  const safeRev = revisionLabel.trim().replace(/[^\w.\-]+/g, "_");
  const stem = file.name.replace(/\.[^.]+$/, "");
  const ext = file.name.split(".").pop() || "pdf";
  const versionedName = `${stem}__rev${safeRev}__backfill__${Date.now()}.${ext}`;

  const storagePath = makeLibraryStoragePath({
    orgId, libraryId, folderPath, filename: versionedName,
  });
  const uploadResult = await uploadToPath(file, storagePath, {
    contentType: file.type || undefined,
  });

  const now = new Date().toISOString();
  const effectiveReleasedAt = releasedAt || now;

  // Insert the historical version row. Critically: we do NOT change
  // documents.current_version_id / rev / status here. The current
  // revision of the document is whatever it was before this call.
  const { data: insertedRow, error: insertErr } = await supabase
    .from("document_versions")
    .insert({
      org_id: orgId,
      record_id: doc.id,
      revision_label: revisionLabel.trim(),
      issue_type: issueType ?? null,
      change_type: changeType ?? null,
      file_url: uploadResult.url,
      file_type: file.type || "application/octet-stream",
      size: uploadResult.size,
      change_log: changeLog.trim(),
      created_by: actorUserId,
      created_by_name: actorEmail || actorUserId,
      created_at: now,                         // when the row was inserted
      released_at: effectiveReleasedAt,        // when the file was historically released
      supersedes_version_id: supersedesVersionId ?? null,
      drawn_by_name: drawnByName?.trim() || null,
      checked_by_name: checkedByName?.trim() || null,
      approved_by_name: approvedByName?.trim() || null,
      moc_reference: mocReference?.trim() || null,
      source_file_name: sourceFileName?.trim() || null,
      file_hash: fileHash,
    })
    .select("*")
    .single();

  if (insertErr || !insertedRow) {
    throw new Error(insertErr?.message || "Failed to write backfilled version row");
  }

  await logRevisionEvent({
    orgId,
    documentId: doc.id,
    versionId: insertedRow.id as string,
    userId: actorUserId,
    userEmail: actorEmail ?? "",
    userRole: actorRole ?? "",
    type: "REV_BACKFILL",
    details: {
      revisionLabel: revisionLabel.trim(),
      narrative: changeLog.trim(),
      issueType: issueType ?? null,
      changeType: changeType ?? null,
      releasedAt: effectiveReleasedAt,
      supersedesVersionId: supersedesVersionId ?? null,
      mocReference: mocReference?.trim() || null,
      sourceFileName: sourceFileName?.trim() || null,
      fileHash,
    },
  });

  return rowToVersion(insertedRow);
}
