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
import { aiReadability } from "@/lib/aiBoundary";
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

  // ── Per-folder doc counts, for suggestions and drift — paged so a big
  // site's counts stay true (a hard 5000 cap zeroed folders arbitrarily),
  // and AI-READABLE only, so "12 docs" in a drift banner never turns into
  // "linked — 0 documents pulled in" (the sync skips superseded/archived/
  // fileless/excluded docs, so this count must too). ─────────────────────
  const aiExcluded = new Set<string>();
  {
    const { data } = await supabaseAdmin
      .from("documents").select("id").eq("org_id", orgId).eq("ai_excluded", true);
    for (const r of (data ?? []) as Array<{ id: string }>) aiExcluded.add(r.id);
  }
  const docCountByFolder = new Map<string, number>();
  for (let from = 0; from < 20_000; from += 1000) {
    const { data } = await supabaseAdmin
      .from("documents")
      .select("id, collection_id, status, archived_at, current_version_id")
      .eq("org_id", orgId).order("id").range(from, from + 999);
    for (const d of (data ?? []) as Array<{
      id: string; collection_id: string | null;
      status: string | null; archived_at: string | null; current_version_id: string | null;
    }>) {
      if (!d.collection_id) continue;
      const verdict = aiReadability({
        id: d.id, status: d.status, archivedAt: d.archived_at,
        currentVersionId: d.current_version_id, aiExcluded: aiExcluded.has(d.id),
      }, true);
      if (!verdict.readable) continue;
      docCountByFolder.set(d.collection_id, (docCountByFolder.get(d.collection_id) ?? 0) + 1);
    }
    if ((data ?? []).length < 1000) break;
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
  const [{ data: srcRows, error: srcErr }, { data: kdocRows, error: kdocErr }] = await Promise.all([
    supabaseAdmin.from("knowledge_sources")
      .select("id, source_type, source_id, source_name")
      .eq("org_id", orgId).eq("library_id", boundLibrary.id),
    supabaseAdmin.from("knowledge_documents")
      .select("id, name, status, source_document_id")
      .eq("org_id", orgId).eq("library_id", boundLibrary.id).limit(2000),
  ]);
  // A failed sources read must NOT masquerade as "no sources" — empty
  // coverage would flag every mirrored doc as moved-out and paint a false
  // data-loss warning. Fail loudly instead.
  if (srcErr) return bad(`Couldn't load the library's sources: ${srcErr.message}`, 500);
  if (kdocErr) return bad(`Couldn't load the library's documents: ${kdocErr.message}`, 500);
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
    // sourceId rides along so the wizard can match watched containers by
    // ID — a snapshot name comparison breaks the moment a folder renames.
    sources: sources.map((s) => ({ id: s.id, type: s.type, sourceId: s.sourceId, name: s.name })),
    counts,
    drift: {
      deadSources: drift.deadSources,
      movedOut: drift.movedOut.slice(0, 10),
      // The list is capped for display; the TOTAL must not be — "10 moved"
      // when 400 moved is a lie about data loss.
      movedOutTotal: drift.movedOut.length,
      newMatches: drift.newMatches.slice(0, 6),
    },
    suggestions: [],
    canManage: principal.isController,
  });
}

// ── POST: bind (or unbind) the area's knowledge library ─────────────────────
//
// Server-side on purpose: the codebook RLS write policy checks only the
// headline role column, so a member whose DocCtrl authority lives in the
// additive roles[] array would get a SILENT zero-row update from the
// client. Here the bar is the same principal.isController that gates every
// other knowledge mutation — and a denied write is a loud 403, never a
// green no-op.
export async function POST(req: NextRequest) {
  let body: { orgId?: string; unitCode?: string; knowledgeLibraryId?: string | null };
  try { body = await req.json(); } catch { return bad("Expected JSON body", 400); }
  const orgId = String(body.orgId ?? "").trim();
  const unitCode = String(body.unitCode ?? "").trim();
  const klId = body.knowledgeLibraryId == null ? null : String(body.knowledgeLibraryId).trim();
  if (!orgId || !unitCode) return bad("orgId and unitCode are required", 400);

  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return bad("Not signed in", 401);
  const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
  if (userErr || !userData?.user) return bad("Not signed in", 401);
  const principal = await loadPrincipal(orgId, userData.user.id);
  if (!principal) return bad("Not a member of this workspace", 403);
  if (!principal.isController) {
    return bad("Only Admin or Doc Control can bind an area's knowledge library.", 403);
  }

  if (klId) {
    const { data: kl } = await supabaseAdmin
      .from("knowledge_libraries").select("id")
      .eq("id", klId).eq("org_id", orgId).maybeSingle();
    if (!kl) return bad("Knowledge library not found", 404);
  }

  const { data: unitRow, error: unitErr } = await supabaseAdmin
    .from("codebook_entries").select("id, meta")
    .eq("org_id", orgId).eq("kind", "unit").eq("code", unitCode).maybeSingle();
  if (unitErr) return bad(unitErr.message, 500);
  if (!unitRow) return bad(`Unit ${unitCode} isn't in the Site Codebook.`, 404);

  const meta = { ...((unitRow.meta as Record<string, unknown>) ?? {}) };
  if (klId) meta.knowledgeLibraryId = klId;
  else delete meta.knowledgeLibraryId;
  const { data: updated, error: upErr } = await supabaseAdmin
    .from("codebook_entries")
    .update({ meta, updated_at: new Date().toISOString() })
    .eq("id", unitRow.id as string)
    .select("id");
  if (upErr) return bad(upErr.message, 500);
  if (!updated || updated.length === 0) return bad("The binding didn't save — try again.", 500);
  return NextResponse.json({ ok: true });
}
