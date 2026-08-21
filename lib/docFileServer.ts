// lib/docFileServer.ts — SERVER-ONLY. Resolve a doc-control document to the
// R2 key of its current stored file, for routes that read pages with vision
// (checklist segmentation, quality-manual review). Current version first,
// pending version as fallback — a checklist uploaded five minutes ago is
// usually still in review, and refusing to read it would be pedantry.

import { supabaseAdmin } from "@/lib/supabaseAdmin";

export interface ResolvedDocFile {
  documentId: string;
  label: string;
  fileKey: string;
  fileType: string | null;
}

export async function resolveDocumentFile(orgId: string, documentId: string): Promise<ResolvedDocFile | null> {
  const { data: doc } = await supabaseAdmin
    .from("documents")
    .select("id, document_number, title, name, current_version_id, pending_version_id")
    .eq("org_id", orgId).eq("id", documentId).maybeSingle();
  if (!doc) return null;
  const versionId = (doc.current_version_id as string | null) ?? (doc.pending_version_id as string | null);
  if (!versionId) return null;
  // org_id re-checked on the version too: the pointer columns are
  // member-writable, so a forged cross-org version id must never resolve.
  const { data: ver } = await supabaseAdmin
    .from("document_versions").select("file_url, file_type")
    .eq("id", versionId).eq("org_id", orgId).maybeSingle();
  if (!ver?.file_url) return null;
  return {
    documentId: String(doc.id),
    label: String(doc.document_number || doc.title || doc.name || "Document"),
    fileKey: String(ver.file_url),
    fileType: (ver.file_type as string | null) ?? null,
  };
}
