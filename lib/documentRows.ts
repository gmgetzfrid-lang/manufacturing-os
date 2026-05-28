// lib/documentRows.ts
//
// Phase 0 stabilization — canonical Postgres-row to DocumentRecord
// mapper. Until this file existed, every screen that read documents
// from Supabase re-implemented a `fromDocRow` helper inline, each
// covering a different subset of fields. That made schema additions
// silently lossy (a new field would show up in some screens and not
// others depending on which inline mapper got updated).
//
// This is the single source of truth. New documents reads should use
// `docRowToDocumentRecord(row)` instead of casting `data as
// DocumentRecord` (which is a lie — the row is snake_case) or
// rolling another inline mapper.
//
// Existing inline mappers (see docs/ARCHITECTURE.md "Row-shape
// contract") are deliberately left in place to avoid a sprawling
// Phase 0 refactor. They should be migrated on touch.

import type {
  AccessControl,
  AclIndex,
  AssetTag,
  DocumentRecord,
  DocumentStatus,
  IngestionState,
  MetadataValue,
  NodeVisibility,
  Timestamp,
} from "@/types/schema";

/** Raw Postgres row shape for the `documents` table. Use this type at
 *  the boundary with Supabase; convert to `DocumentRecord` via
 *  `docRowToDocumentRecord` before passing to UI code. */
export interface DocumentRow {
  id: string;
  org_id: string | null;
  library_id: string;
  collection_id: string | null;
  set_id: string | null;
  sheet_number: number | null;
  sheet_total: number | null;
  name: string | null;
  document_number: string | null;
  title: string | null;
  rev: string | null;
  revision: string | null;
  status: string | null;
  current_version_id: string | null;
  metadata: Record<string, MetadataValue> | null;
  metadata_template_id: string | null;
  metadata_tags: Record<string, string[]> | null;
  ingestion: IngestionState | null;
  asset_tags: AssetTag[] | null;
  tags: string[] | null;
  download_policy: DocumentRecord["downloadPolicy"] | null;
  watermark_policy_id: string | null;
  checked_out_by: string | null;
  checked_out_by_name: string | null;
  checked_out_at: Timestamp | null;
  current_lock_id: string | null;
  checkout_note: string | null;
  active_collaborators: string[] | null;
  revision_history: DocumentRecord["revisionHistory"] | null;
  visibility: NodeVisibility | null;
  acl: AccessControl | null;
  acl_index: AclIndex | null;
  is_private: boolean | null;
  scope: "private" | "org" | null;
  created_at: Timestamp | null;
  created_by: string | null;
  updated_at: Timestamp | null;
  updated_by: string | null;
  archived_at: Timestamp | null;
  archived_by: string | null;
  archive_reason: string | null;
  superseded_at: Timestamp | null;
  superseded_by_user: string | null;
  supersession_reason: string | null;
  supersession_moc: string | null;
  // Phase 1 scope FKs (nullable)
  plant_id: string | null;
  unit_id: string | null;
  system_id: string | null;
  // Phase 2 — trigger-maintained tsvector, never selected by hand
  search_tsv?: unknown;
  // Any forward-compat field
  [extra: string]: unknown;
}

/** Convert a Postgres row from `from("documents").select(...)` into the
 *  canonical camelCase `DocumentRecord`. Safe for partial selects: any
 *  missing field becomes `undefined` rather than throwing. */
export function docRowToDocumentRecord(r: DocumentRow | Record<string, unknown>): DocumentRecord {
  const row = r as DocumentRow;
  return {
    id: row.id as string,
    orgId: (row.org_id as string | null) ?? undefined,
    libraryId: row.library_id as string,
    collectionId: row.collection_id ?? undefined,
    setId: row.set_id ?? undefined,
    sheetNumber: row.sheet_number ?? undefined,
    sheetTotal: row.sheet_total ?? undefined,
    name: row.name ?? undefined,
    documentNumber: row.document_number ?? undefined,
    title: row.title ?? undefined,
    // Canonical revision label. `documents.revision` is a deprecated
    // mirror; we prefer `rev` and fall back to `revision` only if `rev`
    // is missing (defensive — should never happen on live data).
    rev: (row.rev ?? row.revision ?? undefined) as string | undefined,
    revision: row.revision ?? undefined,
    status: (row.status as DocumentStatus | undefined) ?? undefined,
    currentVersionId: row.current_version_id ?? undefined,
    metadata: row.metadata ?? undefined,
    metadataTemplateId: row.metadata_template_id ?? undefined,
    metadataTags: row.metadata_tags ?? undefined,
    ingestion: row.ingestion ?? undefined,
    assetTags: row.asset_tags ?? undefined,
    tags: row.tags ?? undefined,
    downloadPolicy: row.download_policy ?? undefined,
    watermarkPolicyId: row.watermark_policy_id ?? undefined,
    checkedOutBy: row.checked_out_by,
    checkedOutByName: row.checked_out_by_name,
    checkedOutAt: row.checked_out_at,
    currentLockId: row.current_lock_id,
    checkoutNote: row.checkout_note,
    activeCollaborators: row.active_collaborators ?? undefined,
    revisionHistory: row.revision_history ?? undefined,
    visibility: row.visibility ?? undefined,
    acl: row.acl ?? undefined,
    aclIndex: row.acl_index ?? undefined,
    isPrivate: row.is_private ?? undefined,
    scope: row.scope ?? undefined,
    createdAt: row.created_at as Timestamp,
    createdBy: (row.created_by as string | null) ?? "",
    updatedAt: row.updated_at ?? undefined,
    updatedBy: row.updated_by ?? undefined,
    // Phase 1 scope pointers
    plantId: row.plant_id,
    unitId: row.unit_id,
    systemId: row.system_id,
  };
}

/** Map an array of raw rows. Convenience for `.map(docRowToDocumentRecord)`. */
export function docRowsToDocumentRecords(rows: Array<DocumentRow | Record<string, unknown>> | null | undefined): DocumentRecord[] {
  if (!rows) return [];
  return rows.map(docRowToDocumentRecord);
}
