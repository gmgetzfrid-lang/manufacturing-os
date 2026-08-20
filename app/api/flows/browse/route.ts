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
import { assembleFlowsBrowse, type FlowsBrowseInputs } from "@/lib/flowsBrowse";

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

  // The pool "missing" counts draw from: AI-readable docs in DC libraries
  // that folder-scoped sources touch (whole-library sources can't miss).
  const wholeLibs = new Set(sources.filter((s) => s.sourceType === "library").map((s) => s.sourceId));
  const partialLibs = [...new Set(sources
    .filter((s) => s.sourceType === "folder")
    .map((s) => landscape.folders.get(s.sourceId)?.library_id)
    .filter((x): x is string => !!x && !wholeLibs.has(x)))];
  const dcCountableDocs: FlowsBrowseInputs["dcCountableDocs"] = [];
  if (partialLibs.length > 0) {
    const aiExcluded = new Set<string>();
    {
      const { data } = await supabaseAdmin
        .from("documents").select("id").eq("org_id", orgId).eq("ai_excluded", true);
      for (const r of (data ?? []) as Array<{ id: string }>) aiExcluded.add(r.id);
    }
    const { data } = await supabaseAdmin
      .from("documents")
      .select("id, library_id, collection_id, status, archived_at, current_version_id")
      .eq("org_id", orgId).in("library_id", partialLibs).limit(5000);
    for (const d of (data ?? []) as Array<{
      id: string; library_id: string; collection_id: string | null;
      status: string | null; archived_at: string | null; current_version_id: string | null;
    }>) {
      const verdict = aiReadability({
        id: d.id, status: d.status, archivedAt: d.archived_at,
        currentVersionId: d.current_version_id, aiExcluded: aiExcluded.has(d.id),
      }, true);
      if (!verdict.readable) continue;
      dcCountableDocs.push({ libraryId: d.library_id, collectionId: d.collection_id });
    }
  }

  const dcLibraryNames = new Map<string, string>();
  for (const [id, l] of landscape.libraries) dcLibraryNames.set(id, l.name);
  const dcFolders: FlowsBrowseInputs["dcFolders"] = new Map();
  for (const [id, f] of landscape.folders) {
    dcFolders.set(id, {
      name: f.name, libraryId: f.library_id,
      parentId: f.parent_id ?? null, pathNames: f.path_names,
    });
  }

  const libraries = assembleFlowsBrowse({
    knowledgeLibraries: ((libRows ?? []) as Array<{ id: string; name: string }>),
    knowledgeDocs, sources, dcLibraryNames, dcFolders, dcDocContainers, dcCountableDocs,
  });

  return NextResponse.json({ libraries, canSync: principal.isController });
}
