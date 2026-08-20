// /api/area/knowledge-status — one operating area's knowledge, diagnosed.
//
// GET ?orgId&unitCode →
//   {
//     unit: { code, label },
//     boundLibrary: { id, name } | null,      // the area's knowledge shelf
//     knowledgeLibraries: [{id, name}],       // for the wizard's pick list
//     sources: [{ id, type, name }],          // what the shelf watches
//     counts: { ready, pending },             // mirrored docs by state
//     drift: {                                // doc control reorganized?
//       deadSources: [{ id, sourceName }],    //   watched folder deleted
//       movedOut: [{ kdocId, name }],         //   docs moved out — will drop
//       newMatches: [{ id, name, libraryName, pathNames, docCount }],
//     },
//     suggestions: [ same shape as newMatches ], // wizard pre-checks these
//     canManage: boolean,
//   }
//
// Auto-tracking is the sync's job (adds, rev-ups, removals). THIS route's
// job is the human-facing question the sync can't answer: "does the link
// still match how doc control is organized?" — answered on every open of
// the area page, BEFORE the next sync silently acts on a reorg.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { loadPrincipal, loadDcLandscape, containerReadable } from "@/lib/knowledgeAccess";
import {
  suggestFoldersForUnit, computeAreaDrift, type AreaFolder,
} from "@/lib/areaKnowledge";

export const runtime = "nodejs";
export const maxDuration = 30;

const bad = (error: string, status: number) => NextResponse.json({ error }, { status });

export async function GET(req: NextRequest) {
  const orgId = (req.nextUrl.searchParams.get("orgId") ?? "").trim();
  const unitCode = (req.nextUrl.searchParams.get("unitCode") ?? "").trim();
  if (!orgId || !unitCode) return bad("orgId and unitCode are required", 400);
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return bad("Not signed in", 401);
  const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
  if (userErr || !userData?.user) return bad("Not signed in", 401);
  const principal = await loadPrincipal(orgId, userData.user.id);
  if (!principal) return bad("Not a member of this workspace", 403);

  // ── The unit and its binding ──────────────────────────────────────────
  const { data: unitRow } = await supabaseAdmin
    .from("codebook_entries").select("code, label, meta")
    .eq("org_id", orgId).eq("kind", "unit").eq("code", unitCode).maybeSingle();
  if (!unitRow) return bad(`Unit ${unitCode} isn't in the Site Codebook.`, 404);
  const unit = { code: unitRow.code as string, label: (unitRow.label as string) || `Unit ${unitCode}` };
  const boundId = ((unitRow.meta as { knowledgeLibraryId?: string } | null)?.knowledgeLibraryId ?? "").trim() || null;

  const [{ data: klRows }, landscape] = await Promise.all([
    supabaseAdmin.from("knowledge_libraries").select("id, name").eq("org_id", orgId).order("name"),
    loadDcLandscape(orgId),
  ]);
  const knowledgeLibraries = (klRows ?? []) as Array<{ id: string; name: string }>;
  const boundLibrary = boundId ? knowledgeLibraries.find((l) => l.id === boundId) ?? null : null;

  // ── Per-folder doc counts, for suggestions and drift ──────────────────
  const docCountByFolder = new Map<string, number>();
  {
    const { data } = await supabaseAdmin
      .from("documents").select("collection_id").eq("org_id", orgId).limit(5000);
    for (const d of (data ?? []) as Array<{ collection_id: string | null }>) {
      if (!d.collection_id) continue;
      docCountByFolder.set(d.collection_id, (docCountByFolder.get(d.collection_id) ?? 0) + 1);
    }
  }
  // Same ACL bar as the sources browse picker: a folder the caller can't
  // read in doc control must not surface here by name either.
  const allFolders: AreaFolder[] = [...landscape.folders.entries()]
    .filter(([id]) => containerReadable("folder", id, principal, landscape))
    .map(([id, f]) => ({
      id,
      name: f.name,
      libraryId: f.library_id,
      libraryName: landscape.libraries.get(f.library_id)?.name ?? "Library",
      pathNames: f.path_names.length > 0 ? f.path_names : [f.name],
      docCount: docCountByFolder.get(id) ?? 0,
    }));

  // ── Unbound: just the wizard's raw material ───────────────────────────
  if (!boundLibrary) {
    return NextResponse.json({
      unit,
      boundLibrary: null,
      knowledgeLibraries,
      sources: [],
      counts: { ready: 0, pending: 0 },
      drift: { deadSources: [], movedOut: [], newMatches: [] },
      suggestions: suggestFoldersForUnit(unit, allFolders),
      canManage: principal.isController,
    });
  }

  // ── Bound: state + drift ──────────────────────────────────────────────
  const [{ data: srcRows }, { data: kdocRows }] = await Promise.all([
    supabaseAdmin.from("knowledge_sources")
      .select("id, source_type, source_id, source_name")
      .eq("org_id", orgId).eq("library_id", boundLibrary.id),
    supabaseAdmin.from("knowledge_documents")
      .select("id, name, status, source_document_id")
      .eq("org_id", orgId).eq("library_id", boundLibrary.id).limit(2000),
  ]);
  const sources = ((srcRows ?? []) as Array<{
    id: string; source_type: string; source_id: string; source_name: string;
  }>).map((s) => ({
    id: s.id,
    type: s.source_type === "folder" ? "folder" as const : "library" as const,
    sourceId: s.source_id,
    name: s.source_name,
  }));
  const kdocs = (kdocRows ?? []) as Array<{
    id: string; name: string; status: string | null; source_document_id: string | null;
  }>;
  const counts = {
    ready: kdocs.filter((d) => d.status === "ready").length,
    pending: kdocs.filter((d) => d.status !== "ready").length,
  };

  // Coverage: whole-library sources cover everything they contain; folder
  // sources cover their subtrees (same rule as the sync).
  const wholeLibs = new Set(sources.filter((s) => s.type === "library").map((s) => s.sourceId));
  const coveredFolderIds = new Set<string>();
  {
    const children = new Map<string, string[]>();
    for (const [id, f] of landscape.folders) {
      if (!f.parent_id) continue;
      const list = children.get(f.parent_id) ?? [];
      list.push(id);
      children.set(f.parent_id, list);
    }
    const stack = sources.filter((s) => s.type === "folder").map((s) => s.sourceId);
    while (stack.length) {
      const cur = stack.pop() as string;
      if (coveredFolderIds.has(cur)) continue;
      coveredFolderIds.add(cur);
      for (const c of children.get(cur) ?? []) stack.push(c);
    }
    // Folders inside whole-library sources are covered too.
    for (const [id, f] of landscape.folders) {
      if (wholeLibs.has(f.library_id)) coveredFolderIds.add(id);
    }
  }

  // Where each mirrored doc lives in doc control NOW.
  const dcIds = [...new Set(kdocs.map((d) => d.source_document_id).filter((x): x is string => !!x))];
  const dcById = new Map<string, { collectionId: string | null; libraryId: string | null }>();
  for (let i = 0; i < dcIds.length; i += 100) {
    const { data } = await supabaseAdmin
      .from("documents").select("id, collection_id, library_id")
      .in("id", dcIds.slice(i, i + 100));
    for (const d of (data ?? []) as Array<{ id: string; collection_id: string | null; library_id: string | null }>) {
      dcById.set(d.id, { collectionId: d.collection_id, libraryId: d.library_id });
    }
  }
  const mirroredDocs = kdocs
    .filter((d) => d.source_document_id)
    .map((d) => {
      const at = dcById.get(d.source_document_id as string);
      // Root docs of a whole-library source count as covered: model that by
      // mapping "root of covered library" onto a synthetic covered id.
      const inWholeLib = !!at?.libraryId && wholeLibs.has(at.libraryId);
      return {
        kdocId: d.id,
        name: d.name,
        collectionId: inWholeLib ? "__whole" : at?.collectionId ?? null,
        inDc: !!at,
      };
    });
  const coveredWithWhole = new Set(coveredFolderIds);
  coveredWithWhole.add("__whole");

  const drift = computeAreaDrift({
    unit,
    sources: sources.filter((s) => s.type === "folder")
      .map((s) => ({ id: s.id, sourceId: s.sourceId, sourceName: s.name })),
    existingFolderIds: new Set(landscape.folders.keys()),
    coveredFolderIds: coveredWithWhole,
    coversEverything: false,
    mirroredDocs,
    allFolders,
  });

  return NextResponse.json({
    unit,
    boundLibrary,
    knowledgeLibraries,
    sources: sources.map((s) => ({ id: s.id, type: s.type, name: s.name })),
    counts,
    drift: {
      deadSources: drift.deadSources,
      movedOut: drift.movedOut.slice(0, 10),
      newMatches: drift.newMatches.slice(0, 6),
    },
    suggestions: [],
    canManage: principal.isController,
  });
}
