// /api/flows/browse — the PFD picker's map of where documents actually live.
//
// Returns every knowledge library with its documents grouped by the
// document-control container they were mirrored from (DC library / folder
// path), with NO row caps — the old flat 50-row list silently hid whole
// folders. Per library it also names the DC containers its sources don't
// watch, so "why is my folder missing?" gets a real answer in the UI
// ("never linked") instead of a mystery.
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

  // Every document, paged — the whole point is that nothing hides.
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

  // Where each mirrored doc lives in doc control.
  const dcDocContainers: FlowsBrowseInputs["dcDocContainers"] = new Map();
  const dcIds = [...new Set(knowledgeDocs.map((d) => d.sourceDocumentId).filter((x): x is string => !!x))];
  for (let i = 0; i < dcIds.length; i += 100) {
    const { data } = await supabaseAdmin
      .from("documents").select("id, library_id, collection_id")
      .in("id", dcIds.slice(i, i + 100));
    for (const d of data ?? []) {
      dcDocContainers.set(d.id as string, {
        libraryId: (d.library_id as string | null) ?? null,
        collectionId: (d.collection_id as string | null) ?? null,
      });
    }
  }

  // Every controlled doc in the org, split by the AI boundary: readable ones
  // feed the missing/pending/unwatched math, blocked ones are tallied WITH
  // their reason — "the AI can't see it" always names why.
  const dcCountableDocs: FlowsBrowseInputs["dcCountableDocs"] = [];
  const dcHeldDocs: FlowsBrowseInputs["dcHeldDocs"] = [];
  {
    const aiExcluded = new Set<string>();
    {
      const { data } = await supabaseAdmin
        .from("documents").select("id").eq("org_id", orgId).eq("ai_excluded", true);
      for (const r of (data ?? []) as Array<{ id: string }>) aiExcluded.add(r.id);
    }
    const { data } = await supabaseAdmin
      .from("documents")
      .select("id, library_id, collection_id, status, archived_at, current_version_id")
      .eq("org_id", orgId).limit(5000);
    for (const d of (data ?? []) as Array<{
      id: string; library_id: string | null; collection_id: string | null;
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
      if (verdict.readable) {
        dcCountableDocs.push({ id: d.id, libraryId, collectionId: d.collection_id });
      } else if (verdict.reason && verdict.reason !== "out_of_scope") {
        dcHeldDocs.push({ libraryId, collectionId: d.collection_id, reason: verdict.reason });
      }
    }
  }

  // Among watched-but-unmirrored readable docs (any KL): which have no
  // ingestable PDF as their current revision? Those never sync — say so
  // instead of promising a Sync will fix them. Bounded to 200 candidates.
  const dcFoldersForCoverage: FlowsBrowseInputs["dcFolders"] = new Map();
  for (const [id, f] of landscape.folders) {
    dcFoldersForCoverage.set(id, {
      name: f.name, libraryId: f.library_id,
      parentId: f.parent_id ?? null, pathNames: f.path_names,
    });
  }
  const nonPdfDocIds = new Set<string>();
  {
    const union = sourceCoverage(sources, dcFoldersForCoverage);
    const mirrored = new Set(knowledgeDocs.map((d) => d.sourceDocumentId).filter(Boolean));
    const candidates = dcCountableDocs
      .filter((d) => !mirrored.has(d.id) && isCovered(d, union))
      .slice(0, 200);
    if (candidates.length > 0) {
      const { data: verRows } = await supabaseAdmin
        .from("documents").select("id, current_version_id")
        .in("id", candidates.map((c) => c.id));
      const versionByDoc = new Map(
        ((verRows ?? []) as Array<{ id: string; current_version_id: string | null }>)
          .map((r) => [r.current_version_id ?? "", r.id]),
      );
      const versionIds = [...versionByDoc.keys()].filter(Boolean);
      for (let i = 0; i < versionIds.length; i += 100) {
        const { data } = await supabaseAdmin
          .from("document_versions").select("id, file_url, file_type")
          .in("id", versionIds.slice(i, i + 100));
        for (const v of (data ?? []) as Array<{ id: string; file_url: string | null; file_type: string | null }>) {
          const isPdf = (v.file_type ?? "").toLowerCase().includes("pdf")
            || (v.file_url ?? "").toLowerCase().endsWith(".pdf");
          if (!v.file_url || !isPdf) {
            const docId = versionByDoc.get(v.id);
            if (docId) nonPdfDocIds.add(docId);
          }
        }
      }
    }
  }

  const dcLibraryNames = new Map<string, string>();
  for (const [id, l] of landscape.libraries) dcLibraryNames.set(id, l.name);

  const { libraries, unwatched } = assembleFlowsBrowse({
    knowledgeLibraries: ((libRows ?? []) as Array<{ id: string; name: string }>),
    knowledgeDocs, sources, dcLibraryNames,
    dcFolders: dcFoldersForCoverage,
    dcDocContainers, dcCountableDocs, dcHeldDocs, nonPdfDocIds,
  });

  return NextResponse.json({ libraries, unwatched, canSync: principal.isController });
}
