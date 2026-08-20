// /api/flows/browse — the PFD picker's map of where documents actually live.
//
// Returns the org's DOCUMENT-CONTROL tree (libraries → nested folders →
// every controlled document, no caps) with each document's AI state:
// ready to read, waiting on a sync, in a folder no knowledge library
// watches, not a PDF, superseded, fileless, or held back by a controller.
// Plus the PDFs uploaded straight into knowledge libraries. A folder that
// exists on the Documents side can never be missing here — it shows up
// with its documents' states the moment it holds one.
//
// Any active member may look; the heavy lifting is one landscape load plus
// batched id lookups. Assembly itself is pure (lib/flowsBrowse.ts, tested).

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { loadPrincipal, loadDcLandscape } from "@/lib/knowledgeAccess";
import { aiReadability } from "@/lib/aiBoundary";
import {
  assembleFlowsBrowse, sourceCoverage, isCovered, type FlowsBrowseInputs,
} from "@/lib/flowsBrowse";

export const runtime = "nodejs";
export const maxDuration = 60;

const bad = (error: string, status: number) => NextResponse.json({ error }, { status });

const MAX_DOCS = 5000;

const displayName = (d: { name: string | null; title: string | null; document_number: string | null }): string => {
  const number = (d.document_number ?? "").trim();
  const title = (d.title ?? d.name ?? "").trim();
  if (number && title && number !== title) return `${number} — ${title}`;
  return title || number || "Document";
};

export async function GET(req: NextRequest) {
  const orgId = (req.nextUrl.searchParams.get("orgId") ?? "").trim();
  if (!orgId) return bad("orgId is required", 400);
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return bad("Not signed in", 401);
  const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
  if (userErr || !userData?.user) return bad("Not signed in", 401);
  const principal = await loadPrincipal(orgId, userData.user.id);
  if (!principal) return bad("Not a member of this workspace", 403);

  const [{ data: libRows, error: libErr }, landscape] = await Promise.all([
    supabaseAdmin.from("knowledge_libraries").select("id, name")
      .eq("org_id", orgId).order("name"),
    loadDcLandscape(orgId),
  ]);
  if (libErr) return bad(`Couldn't load knowledge libraries: ${libErr.message}`, 500);

  // Every knowledge document, paged — nothing hides.
  const knowledgeDocs: FlowsBrowseInputs["knowledgeDocs"] = [];
  for (let from = 0; from < MAX_DOCS; from += 1000) {
    const { data, error } = await supabaseAdmin
      .from("knowledge_documents")
      .select("id, name, library_id, page_count, status, source_document_id")
      .eq("org_id", orgId).order("name").range(from, from + 999);
    if (error) return bad(`Couldn't load documents: ${error.message}`, 500);
    for (const d of data ?? []) {
      knowledgeDocs.push({
        id: d.id as string,
        name: (d.name as string) ?? "Document",
        libraryId: d.library_id as string,
        pageCount: (d.page_count as number | null) ?? null,
        status: (d.status as string | null) ?? null,
        sourceDocumentId: (d.source_document_id as string | null) ?? null,
      });
    }
    if ((data ?? []).length < 1000) break;
  }

  // Sources may predate migration 20260917 — absent table = no sources.
  let sources: FlowsBrowseInputs["sources"] = [];
  {
    const { data } = await supabaseAdmin
      .from("knowledge_sources").select("library_id, source_type, source_id")
      .eq("org_id", orgId).limit(500);
    sources = ((data ?? []) as Array<{ library_id: string; source_type: string; source_id: string }>)
      .map((s) => ({
        knowledgeLibraryId: s.library_id,
        sourceType: s.source_type === "folder" ? "folder" as const : "library" as const,
        sourceId: s.source_id,
      }));
  }

  const dcFolders: FlowsBrowseInputs["dcFolders"] = new Map();
  for (const [id, f] of landscape.folders) {
    dcFolders.set(id, {
      name: f.name, libraryId: f.library_id,
      parentId: f.parent_id ?? null, pathNames: f.path_names,
    });
  }
  const dcLibraryNames = new Map<string, string>();
  for (const [id, l] of landscape.libraries) dcLibraryNames.set(id, l.name);

  // Every controlled doc, with its AI-boundary verdict kept as a REASON —
  // "the AI can't see it" always names why.
  const dcDocs: FlowsBrowseInputs["dcDocs"] = [];
  const currentVersionByDoc = new Map<string, string>();
  {
    const aiExcluded = new Set<string>();
    {
      const { data } = await supabaseAdmin
        .from("documents").select("id").eq("org_id", orgId).eq("ai_excluded", true);
      for (const r of (data ?? []) as Array<{ id: string }>) aiExcluded.add(r.id);
    }
    // Paged with a stable order — a flat cap returns an ARBITRARY slice
    // past its limit, and this tree's whole promise is that no document
    // silently vanishes from it.
    for (let from = 0; from < 20_000; from += 1000) {
      const { data } = await supabaseAdmin
        .from("documents")
        .select("id, name, title, document_number, library_id, collection_id, status, archived_at, current_version_id")
        .eq("org_id", orgId).order("id").range(from, from + 999);
      for (const d of (data ?? []) as Array<{
        id: string; name: string | null; title: string | null; document_number: string | null;
        library_id: string | null; collection_id: string | null;
        status: string | null; archived_at: string | null; current_version_id: string | null;
      }>) {
        // Effective home library: the doc's own, or its folder's when the doc
        // row doesn't carry one — a doc must never be uncountable.
        const libraryId = d.library_id
          ?? (d.collection_id ? landscape.folders.get(d.collection_id)?.library_id ?? null : null);
        if (!libraryId) continue;
        const verdict = aiReadability({
          id: d.id, status: d.status, archivedAt: d.archived_at,
          currentVersionId: d.current_version_id, aiExcluded: aiExcluded.has(d.id),
        }, true);
        const block = verdict.readable || verdict.reason === "out_of_scope"
          ? null
          : verdict.reason;
        dcDocs.push({
          id: d.id, name: displayName(d), libraryId,
          collectionId: d.collection_id, block,
        });
        if (d.current_version_id) currentVersionByDoc.set(d.id, d.current_version_id);
      }
      if ((data ?? []).length < 1000) break;
    }
  }

  // Among watched-but-unmirrored readable docs: which have no ingestable
  // PDF as their current revision? Those never sync — say so instead of
  // promising a Sync will fix them. Bounded to 200 candidates.
  const nonPdfDocIds = new Set<string>();
  {
    const union = sourceCoverage(sources, dcFolders);
    const mirrored = new Set(knowledgeDocs.map((d) => d.sourceDocumentId).filter(Boolean));
    const candidates = dcDocs
      .filter((d) => !d.block && !mirrored.has(d.id)
        && isCovered({ libraryId: d.libraryId, collectionId: d.collectionId }, union))
      .slice(0, 200);
    const docByVersion = new Map<string, string>();
    for (const c of candidates) {
      const v = currentVersionByDoc.get(c.id);
      if (v) docByVersion.set(v, c.id);
    }
    const versionIds = [...docByVersion.keys()];
    for (let i = 0; i < versionIds.length; i += 100) {
      const { data } = await supabaseAdmin
        .from("document_versions").select("id, file_url, file_type")
        .in("id", versionIds.slice(i, i + 100));
      for (const v of (data ?? []) as Array<{ id: string; file_url: string | null; file_type: string | null }>) {
        const isPdf = (v.file_type ?? "").toLowerCase().includes("pdf")
          || (v.file_url ?? "").toLowerCase().endsWith(".pdf");
        if (!v.file_url || !isPdf) {
          const docId = docByVersion.get(v.id);
          if (docId) nonPdfDocIds.add(docId);
        }
      }
    }
  }

  const knowledgeLibraries = (libRows ?? []) as Array<{ id: string; name: string }>;
  const { tree, uploads } = assembleFlowsBrowse({
    knowledgeLibraries, knowledgeDocs, sources,
    dcLibraryNames, dcFolders, dcDocs, nonPdfDocIds,
  });

  return NextResponse.json({
    tree, uploads,
    knowledgeLibraries,
    canSync: principal.isController,
  });
}
