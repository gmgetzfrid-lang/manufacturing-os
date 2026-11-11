// docRecord - one reading of a `documents` row and a `document_versions`
// row, shared by the library page and anything that opens a document from
// somewhere else (the map, search results) without going to its folder.

import { supabase } from "@/lib/supabase";
import type { AccessControl, DocumentRecord, DocumentVersion, NodeVisibility } from "@/types/schema";

// Map a raw `documents` row to a DocumentRecord. Module-level so both the
// folder fetch and the deep-link loaders (which fetch docs by id, outside the
// current folder) share one mapper.
export function docRecordFromRow(r: Record<string, unknown>): DocumentRecord {
  return {
    id: r.id as string, orgId: r.org_id as string, libraryId: r.library_id as string,
    collectionId: r.collection_id as string | undefined, documentNumber: r.document_number as string,
    title: r.title as string, name: r.name as string, status: r.status as DocumentRecord['status'],
    rev: r.rev as string, currentVersionId: r.current_version_id as string | undefined,
    checkedOutBy: r.checked_out_by as string | undefined, checkedOutByName: r.checked_out_by_name as string | undefined,
    checkedOutAt: r.checked_out_at as unknown as DocumentRecord['checkedOutAt'], activeCollaborators: (r.active_collaborators as string[]) ?? [],
    currentLockId: r.current_lock_id as string | undefined, setId: r.set_id as string | undefined,
    sheetNumber: r.sheet_number as number | undefined, sheetTotal: r.sheet_total as number | undefined,
    visibility: r.visibility as NodeVisibility | undefined, acl: r.acl as AccessControl | undefined,
    aclIndex: r.acl_index as unknown as DocumentRecord['aclIndex'], metadata: r.metadata as unknown as DocumentRecord['metadata'],
    updatedAt: r.updated_at as unknown as DocumentRecord['updatedAt'], createdAt: r.created_at as unknown as DocumentRecord['createdAt'],
    createdBy: (r.created_by as string) ?? '',
    reviewPolicy: (r.review_policy as DocumentRecord['reviewPolicy']) ?? null,
    lastReviewedAt: (r.last_reviewed_at as string | null) ?? null,
    lastReviewedBy: (r.last_reviewed_by as string | null) ?? null,
    nextReviewDate: (r.next_review_date as string | null) ?? null,
    ownerUserId: (r.owner_user_id as string | null) ?? null,
    ownerName: (r.owner_name as string | null) ?? null,
    ackPolicy: (r.ack_policy as DocumentRecord['ackPolicy']) ?? null,
    reviewControl: (r.review_control as DocumentRecord['reviewControl']) ?? null,
    effectiveDate: (r.effective_date as string | null) ?? null,
    retentionPolicy: (r.retention_policy as DocumentRecord['retentionPolicy']) ?? null,
    retentionUntil: (r.retention_until as string | null) ?? null,
    dispositionState: (r.disposition_state as DocumentRecord['dispositionState']) ?? null,
    legalHold: !!r.legal_hold,
    legalHoldMatter: (r.legal_hold_matter as string | null) ?? null,
    legalHoldReason: (r.legal_hold_reason as string | null) ?? null,
    origin: (r.origin as DocumentRecord['origin']) ?? "internal",
    externalSource: (r.external_source as string | null) ?? null,
    externalReference: (r.external_reference as string | null) ?? null,
    externalEdition: (r.external_edition as string | null) ?? null,
    externalUrl: (r.external_url as string | null) ?? null,
  };
}

// Exactly the columns the list view consumes (mirrors docRecordFromRow). Using
// this instead of select("*") keeps the large `search_tsv` tsvector and the
// deprecated `revision_history` JSONB off the wire on every folder open.
export const DOC_LIST_COLUMNS =
  "id, org_id, library_id, collection_id, document_number, title, name, status, rev, " +
  "current_version_id, checked_out_by, checked_out_by_name, checked_out_at, active_collaborators, " +
  "current_lock_id, set_id, sheet_number, sheet_total, visibility, acl, acl_index, metadata, " +
  "updated_at, created_at, created_by, review_policy, last_reviewed_at, last_reviewed_by, next_review_date, owner_user_id, owner_name, ack_policy, review_control, effective_date, " +
  "retention_policy, retention_until, disposition_state, legal_hold, legal_hold_matter, legal_hold_reason, " +
  "origin, external_source, external_reference, external_edition, external_url";

/** A raw `document_versions` row as a DocumentVersion. */
export function versionFromRow(r: Record<string, unknown>): DocumentVersion {
  return {
  id: r.id as string,
  orgId: r.org_id as string,
  recordId: r.record_id as string,
  revisionLabel: r.revision_label as string,
  issueType: r.issue_type as DocumentVersion['issueType'],
  changeType: r.change_type as DocumentVersion['changeType'],
  fileUrl: r.file_url as string,
  fileType: r.file_type as string,
  size: r.size as number,
  isFlattened: r.is_flattened as boolean | undefined,
  hasWatermark: r.has_watermark as boolean | undefined,
  watermarkPolicyId: r.watermark_policy_id as string | undefined,
  downloadPolicy: r.download_policy as DocumentVersion['downloadPolicy'],
  changeLog: r.change_log as string | undefined,
  relatedTicketId: r.related_ticket_id as string | undefined,
  createdBy: r.created_by as string,
  createdByName: r.created_by_name as string | undefined,
  createdAt: r.created_at as unknown as DocumentVersion['createdAt'],
  approvedBy: r.approved_by as string | undefined,
  supersedesVersionId: r.supersedes_version_id as string | undefined,
  drawnBy: r.drawn_by as string | undefined,
  drawnByName: r.drawn_by_name as string | undefined,
  checkedBy: r.checked_by as string | undefined,
  checkedByName: r.checked_by_name as string | undefined,
  approvedByName: r.approved_by_name as string | undefined,
  approvedAt: r.approved_at as unknown as DocumentVersion['approvedAt'],
  releasedAt: r.released_at as unknown as DocumentVersion['releasedAt'],
  supersededAt: r.superseded_at as unknown as DocumentVersion['supersededAt'],
  mocReference: r.moc_reference as string | undefined,
  sourceFileName: r.source_file_name as string | undefined,
  revertedFromVersionId: r.reverted_from_version_id as string | undefined,
  fileHash: r.file_hash as string | undefined,
    };
}

/** A document and the version to show for it (its current one; else the
 *  newest approved), read by id from wherever it is filed. Null: gone, or
 *  not this person's to see. */
export async function loadDocForViewing(docId: string): Promise<{ doc: DocumentRecord; version: DocumentVersion | null } | null> {
  const { data } = await supabase.from("documents").select(DOC_LIST_COLUMNS).eq("id", docId).maybeSingle();
  if (!data) return null;
  const doc = docRecordFromRow(data as unknown as Record<string, unknown>);
  if (doc.currentVersionId) {
    const { data: v } = await supabase.from("document_versions").select("*").eq("id", doc.currentVersionId).maybeSingle();
    if (v) return { doc, version: versionFromRow(v as Record<string, unknown>) };
  }
  const { data: vs } = await supabase.from("document_versions").select("*").eq("record_id", docId)
    .or("review_state.is.null,review_state.eq.approved").order("created_at", { ascending: false }).limit(1);
  return { doc, version: vs && vs.length ? versionFromRow(vs[0] as Record<string, unknown>) : null };
}
