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
//     flowReads: { readable, read, otherDocs } | null, // AREA-8: flow drawings read
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
import { flowReadCoverage } from "@/lib/flowsRead";
import { loadCodebookAdmin } from "@/lib/codebookServer";
import { parseDrawingNumber } from "@/lib/codebook";

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
    const { data, error: docErr } = await supabaseAdmin
      .from("documents")
      .select("id, collection_id, status, archived_at, current_version_id")
      .eq("org_id", orgId).order("id").range(from, from + 999);
    // A failed page must FAIL, not read as "zero documents" — empty counts
    // silently kill drift detection and flip checklist steps to todo.
    if (docErr) return bad(`Couldn't count documents: ${docErr.message}`, 500);
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
  // Roll counts up each folder's ancestry: linking "PFDs / Crude Unit"
  // pulls in everything under it, so its advertised count must say so —
  // a parent showing "0 docs" over full children is the inverse of honest.
  {
    const rolled = new Map<string, number>();
    for (const [folderId, count] of docCountByFolder) {
      let cur: string | null = folderId;
      const seen = new Set<string>();
      while (cur && !seen.has(cur)) {
        seen.add(cur);
        rolled.set(cur, (rolled.get(cur) ?? 0) + count);
        cur = landscape.folders.get(cur)?.parent_id ?? null;
      }
    }
    docCountByFolder.clear();
    for (const [k, v] of rolled) docCountByFolder.set(k, v);
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
      drift: { deadSources: [], movedOut: [], movedOutTotal: 0, newMatches: [] },
      suggestions: suggestFoldersForUnit(unit, allFolders),
      flowReads: null,
      canManage: principal.isController,
    });
  }

  // ── Bound: state + drift ──────────────────────────────────────────────
  const { data: srcRows, error: srcErr } = await supabaseAdmin
    .from("knowledge_sources")
    .select("id, source_type, source_id, source_name")
    .eq("org_id", orgId).eq("library_id", boundLibrary.id);
  // A failed sources read must NOT masquerade as "no sources" — empty
  // coverage would flag every mirrored doc as moved-out and paint a false
  // data-loss warning. Fail loudly instead.
  if (srcErr) return bad(`Couldn't load the library's sources: ${srcErr.message}`, 500);
  // Mirrors, PAGED — headline counts and moved-out detection computed on an
  // arbitrary 2000-row slice would lie on big libraries.
  const kdocRows: Array<{ id: string; name: string; status: string | null; source_document_id: string | null }> = [];
  for (let from = 0; from < 10_000; from += 1000) {
    const { data, error: kdocErr } = await supabaseAdmin
      .from("knowledge_documents")
      .select("id, name, status, source_document_id")
      .eq("org_id", orgId).eq("library_id", boundLibrary.id)
      .order("id").range(from, from + 999);
    if (kdocErr) return bad(`Couldn't load the library's documents: ${kdocErr.message}`, 500);
    kdocRows.push(...((data ?? []) as typeof kdocRows));
    if ((data ?? []).length < 1000) break;
  }
  const sources = ((srcRows ?? []) as Array<{
    id: string; source_type: string; source_id: string; source_name: string;
  }>).map((s) => ({
    id: s.id,
    type: s.source_type === "folder" ? "folder" as const : "library" as const,
    sourceId: s.source_id,
    name: s.source_name,
  }));
  const kdocs = kdocRows;
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
  const dcById = new Map<string, { collectionId: string | null; libraryId: string | null; number: string | null }>();
  for (let i = 0; i < dcIds.length; i += 100) {
    const { data, error: dcErr } = await supabaseAdmin
      .from("documents").select("id, collection_id, library_id, document_number")
      .in("id", dcIds.slice(i, i + 100));
    // A failed chunk would make its docs read as "deleted in doc control"
    // and silently vanish from moved-out detection — fail instead.
    if (dcErr) return bad(`Couldn't locate mirrored documents: ${dcErr.message}`, 500);
    for (const d of (data ?? []) as Array<{ id: string; collection_id: string | null; library_id: string | null; document_number?: string | null }>) {
      dcById.set(d.id, { collectionId: d.collection_id, libraryId: d.library_id, number: d.document_number ?? null });
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
  // AREA-8: how many of the shelf's FLOW DRAWINGS have been read for flows
  // — a FLOWS_READ record (a read, flows found or not) or a flow read off
  // it. A flow drawing is a ready document whose title or doc-control folder
  // names it one (PFD, P&ID, block diagram — lib/flowsRead namesFlowDrawing),
  // or one already read; the data sheets, manuals and standards on the same
  // shelf are counted apart, not owed a paid read. Coverage, not presence:
  // one hand-drawn flow no longer ticks the deep read for 400 unread
  // drawings. Null when it cannot be counted.
  const readyDocs = kdocs.filter((d) => d.status === "ready");
  const readIds = await flowReadIds(orgId, new Set(readyDocs.map((d) => d.id)));
  const folderPathOf = (sourceDocumentId: string | null): string[] => {
    const at = sourceDocumentId ? dcById.get(sourceDocumentId) : undefined;
    if (!at) return [];
    const folder = at.collectionId ? landscape.folders.get(at.collectionId) : undefined;
    const lib = at.libraryId ? landscape.libraries.get(at.libraryId)?.name : undefined;
    return [...(lib ? [lib] : []), ...(folder ? (folder.path_names.length > 0 ? folder.path_names : [folder.name]) : [])];
  };
  // The drawing type a mirror's number decodes to (Site Codebook
  // drawing_type, "02" → "P&ID"): a P&ID titled only by its number, in a
  // folder that does not say so, still counts. A codebook that cannot be
  // read decodes nothing and the title / folder test stands alone.
  const book = readIds === null ? null : await loadCodebookAdmin(supabaseAdmin, orgId);
  const drawingTypeOf = (sourceDocumentId: string | null): string | null => {
    const number = sourceDocumentId ? dcById.get(sourceDocumentId)?.number : null;
    return number && book ? parseDrawingNumber(number, book)?.drawingTypeLabel ?? null : null;
  };
  const flowReads = readIds === null ? null : flowReadCoverage(
    readyDocs.map((d) => ({
      id: d.id, name: d.name, folderPath: folderPathOf(d.source_document_id),
      drawingType: drawingTypeOf(d.source_document_id),
    })),
    readIds,
  );

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
    flowReads,
    canManage: principal.isController,
  });
}

/** AREA-8: which of these knowledge documents have been read for flows;
 *  null when that cannot be told. */
async function flowReadIds(orgId: string, ready: ReadonlySet<string>): Promise<Set<string> | null> {
  const read = new Set<string>();
  for (let from = 0; from < 50_000; from += 1000) {
    const { data, error } = await supabaseAdmin
      .from("audit_logs").select("id, resource_id")
      .eq("org_id", orgId).eq("action", "FLOWS_READ")
      .order("id").range(from, from + 999);
    if (error) return null;
    for (const r of (data ?? []) as Array<{ resource_id: string | null }>) {
      if (r.resource_id && ready.has(r.resource_id)) read.add(r.resource_id);
    }
    if ((data ?? []).length < 1000) break;
  }
  for (let from = 0; from < 50_000; from += 1000) {
    const { data, error } = await supabaseAdmin
      .from("process_flows").select("id, source_document_id")
      .eq("org_id", orgId).not("source_document_id", "is", null)
      .order("id").range(from, from + 999);
    if (error) {
      if (error.code === "42P01" || /does not exist|could not find the table/i.test(error.message)) break;
      return null;
    }
    for (const r of (data ?? []) as Array<{ source_document_id: string | null }>) {
      if (r.source_document_id && ready.has(r.source_document_id)) read.add(r.source_document_id);
    }
    if ((data ?? []).length < 1000) break;
  }
  return read;
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
