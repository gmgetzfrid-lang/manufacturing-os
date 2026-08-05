// lib/relatedResources.ts — curated "Related" links on a document.
//
// The human-curated layer of the relationship web (the automatic layer is
// document_assets + findRelatedDocuments): pin another controlled document
// or an external URL to any document, with a label and an order. Idea from
// HashiCorp Hermes' related-resources model, rebuilt org-native.

import { supabase } from "@/lib/supabase";

export interface RelatedResource {
  id: string;
  document_id: string;
  kind: "document" | "url";
  target_document_id: string | null;
  url: string | null;
  label: string;
  sort_order: number;
  created_by_name: string | null;
  /** Hydrated for kind=document. */
  target?: { document_number: string | null; title: string | null; library_id: string } | null;
}

export async function listRelatedResources(documentId: string): Promise<RelatedResource[]> {
  const { data, error } = await supabase
    .from("document_related_resources").select("*")
    .eq("document_id", documentId).order("sort_order").order("created_at");
  if (error) {
    if (error.code === "42P01" || /does not exist/i.test(error.message)) return [];
    throw new Error(error.message);
  }
  const rows = (data as RelatedResource[]) ?? [];
  const ids = rows.filter((r) => r.kind === "document" && r.target_document_id)
    .map((r) => r.target_document_id as string);
  if (ids.length > 0) {
    const { data: docs } = await supabase
      .from("documents").select("id, document_number, title, library_id").in("id", ids);
    const byId = new Map((docs ?? []).map((d) => [
      (d as { id: string }).id,
      d as { document_number: string | null; title: string | null; library_id: string },
    ]));
    for (const r of rows) {
      if (r.target_document_id) r.target = byId.get(r.target_document_id) ?? null;
    }
  }
  return rows;
}

export async function addRelatedResource(input: {
  orgId: string; documentId: string;
  kind: "document" | "url";
  targetDocumentId?: string; url?: string; label?: string;
  userId: string; userName?: string;
  sortOrder?: number;
}): Promise<void> {
  const { error } = await supabase.from("document_related_resources").insert({
    org_id: input.orgId,
    document_id: input.documentId,
    kind: input.kind,
    target_document_id: input.targetDocumentId ?? null,
    url: input.url ?? null,
    label: (input.label ?? "").trim(),
    sort_order: input.sortOrder ?? 0,
    created_by: input.userId,
    created_by_name: input.userName ?? null,
  });
  if (error) throw new Error(error.message);
}

export async function removeRelatedResource(id: string): Promise<void> {
  const { error } = await supabase.from("document_related_resources").delete().eq("id", id);
  if (error) throw new Error(error.message);
}

// ── Backlinks — the other direction of the web ─────────────────────────────
//
// Obsidian's core magic: opening a note shows everything that points AT it,
// not just what it points to. Here that means: documents whose curated pins
// target this one, and projects this document has traveled through.

export interface DocumentBacklinks {
  /** Documents that pinned THIS document as related. */
  docs: Array<{
    id: string; document_number: string | null; title: string | null;
    library_id: string; pinned_by: string | null;
  }>;
  /** Projects this document appears in. */
  projects: Array<{ id: string; name: string }>;
}

export async function listBacklinks(documentId: string): Promise<DocumentBacklinks> {
  const empty: DocumentBacklinks = { docs: [], projects: [] };
  const [pinsRes, projRes] = await Promise.all([
    supabase.from("document_related_resources")
      .select("document_id, created_by_name")
      .eq("target_document_id", documentId).limit(25),
    supabase.from("project_documents")
      .select("project_id")
      .eq("document_id", documentId).limit(10),
  ]);
  // Pre-migration or RLS-hidden — backlinks just don't render.
  const pins = pinsRes.error ? [] :
    ((pinsRes.data as Array<{ document_id: string; created_by_name: string | null }>) ?? []);
  const projLinks = projRes.error ? [] :
    ((projRes.data as Array<{ project_id: string }>) ?? []);

  const out: DocumentBacklinks = { docs: [], projects: [] };
  if (pins.length > 0) {
    const { data } = await supabase
      .from("documents").select("id, document_number, title, library_id")
      .in("id", pins.map((p) => p.document_id));
    const byName = new Map(pins.map((p) => [p.document_id, p.created_by_name]));
    out.docs = ((data as Array<{ id: string; document_number: string | null; title: string | null; library_id: string }>) ?? [])
      .map((d) => ({ ...d, pinned_by: byName.get(d.id) ?? null }));
  }
  if (projLinks.length > 0) {
    const { data } = await supabase
      .from("projects").select("id, name")
      .in("id", [...new Set(projLinks.map((p) => p.project_id))]);
    out.projects = (data as Array<{ id: string; name: string }>) ?? [];
  }
  return out.docs.length === 0 && out.projects.length === 0 ? empty : out;
}
