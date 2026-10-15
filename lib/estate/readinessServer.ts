// lib/estate/readinessServer.ts — is the estate set up to connect things?
//
// "Resolve links" can only link what the ground holds: units in the
// codebook, equipment in the registry, drawings that have been read with
// their tags, suggestions applied. This counts each of those once so the
// map can say which step is missing instead of showing nothing.

import type { SupabaseClient } from "@supabase/supabase-js";
import { loadCodebookAdmin } from "@/lib/codebookServer";

export interface EstateReadiness {
  units: number;
  drawingNumberFormat: boolean;
  assets: number;
  assetsWithUnit: number;
  documents: number;
  knowledgeLibraries: number;
  sources: number;
  mirrors: number;
  mirrorsLinked: number;
  mirrorsReady: number;
  mirrorsWaiting: number;
  mirrorsWithTags: number;
  mirrorsHashed: number;
  bridgeLibraries: number;
  suggestions: number;
  suggestionsPending: number;
  edges: { applied: number; pending: number; byType: Record<string, number> };
  foldersWithUnit: number;
  docsWithUnit: number;
  docsWithAsset: number;
  estateMissing: boolean;
}

async function count(q: PromiseLike<{ count: number | null; error: { message: string } | null }>): Promise<number> {
  const r = await q;
  return r.error ? 0 : (r.count ?? 0);
}

export async function computeReadiness(admin: SupabaseClient, orgId: string): Promise<EstateReadiness> {
  const org = (t: string) => admin.from(t).select("id", { count: "exact", head: true }).eq("org_id", orgId);
  const [book, assets, assetsWithUnit, documents, knowledgeLibraries, sources, mirrors, mirrorsLinked, mirrorsReady, mirrorsWaiting, mirrorsHashed, bridgeLibraries, suggestions, suggestionsPending, edgesRes, tagRows] = await Promise.all([
    loadCodebookAdmin(admin, orgId).catch(() => null),
    count(org("assets").eq("archived", false)),
    count(org("assets").eq("archived", false).not("unit_code", "is", null)),
    count(org("documents").neq("status", "Archived")),
    count(org("knowledge_libraries")),
    count(org("knowledge_sources")),
    count(org("knowledge_documents")),
    count(org("knowledge_documents").not("source_document_id", "is", null)),
    count(org("knowledge_documents").eq("status", "ready")),
    count(org("knowledge_documents").in("status", ["pending", "stale", "indexing", "error"])),
    count(org("knowledge_documents").not("file_hash", "is", null)),
    count(org("libraries").not("equipment_bridge->>targetColumnKey", "is", null)),
    count(org("document_equipment_suggestions")),
    count(org("document_equipment_suggestions").eq("status", "pending")),
    admin.from("estate_edges").select("a, type, status").eq("org_id", orgId).limit(50000),
    admin.from("knowledge_page_entities").select("document_id").eq("org_id", orgId).eq("kind", "equipment").limit(20000),
  ]);
  const estateMissing = !!edgesRes.error;
  const edges = { applied: 0, pending: 0, byType: {} as Record<string, number> };
  let foldersWithUnit = 0, docsWithUnit = 0, docsWithAsset = 0;
  for (const e of ((edgesRes.data as Array<{ a: string; type: string; status: string }> | null) ?? [])) {
    if (e.status === "applied") edges.applied++; else if (e.status === "pending") edges.pending++;
    if (e.status !== "applied") continue;
    edges.byType[e.type] = (edges.byType[e.type] ?? 0) + 1;
    if (e.type === "belongs_to_unit" && e.a.startsWith("folder:")) foldersWithUnit++;
    if (e.type === "belongs_to_unit" && e.a.startsWith("doc:")) docsWithUnit++;
    if (e.type === "tagged_to" && e.a.startsWith("doc:")) docsWithAsset++;
  }
  const mirrorsWithTags = new Set(((tagRows.data as Array<{ document_id: string }> | null) ?? []).map((r) => r.document_id)).size;
  return {
    units: book?.units.length ?? 0, drawingNumberFormat: !!book?.drawingNumber,
    assets, assetsWithUnit, documents, knowledgeLibraries, sources, mirrors, mirrorsLinked, mirrorsReady, mirrorsWaiting, mirrorsWithTags, mirrorsHashed,
    bridgeLibraries, suggestions, suggestionsPending, edges, foldersWithUnit, docsWithUnit, docsWithAsset, estateMissing,
  };
}
