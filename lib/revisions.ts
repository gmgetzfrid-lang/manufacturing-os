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
import type { DocumentRecord, DocumentVersion } from "@/types/schema";

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
