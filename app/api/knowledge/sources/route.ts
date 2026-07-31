// /api/knowledge/sources — link document-control containers into knowledge
// libraries. The knowledge tab stops owning uploads; it subscribes to the
// controlled library instead.
//
//   GET  ?orgId&libraryId              → this library's sources (+doc counts)
//   GET  ?orgId&action=browse          → DC libraries + folders the CALLER
//                                        can read (ACL-filtered server-side;
//                                        the picker shows only these)
//   POST { orgId, libraryId, add: [{type,id}] }
//                                      → link containers (controllers only;
//                                        each container's readability is
//                                        re-verified against the CALLER —
//                                        the UI filter is not the enforcement)
//                                        then run a sync immediately
//   POST { orgId, libraryId, action: "sync" }
//                                      → reconcile now (new docs, rev-ups,
//                                        removals)
//   DELETE { orgId, sourceId }         → unlink; mirrored docs and their
//                                        chunks cascade away
//
// Auth mirrors the other knowledge routes: bearer session + active org
// membership; mutations require Admin/DocCtrl.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  loadPrincipal, loadDcLandscape, containerReadable,
} from "@/lib/knowledgeAccess";
import { syncKnowledgeLibrarySources } from "@/lib/knowledgeSourceSync";

export const runtime = "nodejs";
export const maxDuration = 120;

function bad(msg: string, status = 400) {
  return NextResponse.json({ error: msg }, { status });
}

const missingTable = (message: string, code?: string) =>
  code === "42P01" || /does not exist/i.test(message);

async function authUser(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(authHeader.slice(7));
  return error || !user ? null : user;
}

export async function GET(req: NextRequest) {
  const orgId = (req.nextUrl.searchParams.get("orgId") ?? "").trim();
  if (!orgId) return bad("orgId is required");
  const user = await authUser(req);
  if (!user) return bad("Unauthorized", 401);
  const principal = await loadPrincipal(orgId, user.id);
  if (!principal) return bad("Not a member of this workspace", 403);

  // ── Browse: containers the caller can read, for the picker ─────────────
  if (req.nextUrl.searchParams.get("action") === "browse") {
    const landscape = await loadDcLandscape(orgId);
    const libraries = [...landscape.libraries.entries()]
      .filter(([id]) => containerReadable("library", id, principal, landscape))
      .map(([id, l]) => ({ id, name: l.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const folders = [...landscape.folders.entries()]
      .filter(([id]) => containerReadable("folder", id, principal, landscape))
      .map(([id, f]) => ({
        id,
        name: f.name,
        libraryId: f.library_id,
        libraryName: landscape.libraries.get(f.library_id)?.name ?? "Library",
        parentId: f.parent_id ?? null,
        pathNames: f.path_names,
      }))
      .sort((a, b) =>
        (a.libraryName + "/" + a.pathNames.join("/")).localeCompare(b.libraryName + "/" + b.pathNames.join("/")));
    return NextResponse.json({ libraries, folders, canManage: principal.isController });
  }

  // ── List this knowledge library's sources ──────────────────────────────
  const libraryId = (req.nextUrl.searchParams.get("libraryId") ?? "").trim();
  if (!libraryId) return bad("libraryId is required");
  const { data: sources, error } = await supabaseAdmin
    .from("knowledge_sources")
    .select("id, source_type, source_id, source_name, created_by_name, created_at")
    .eq("org_id", orgId).eq("library_id", libraryId)
    .order("created_at", { ascending: true });
  if (error) {
    if (missingTable(error.message, error.code)) {
      return bad("The knowledge_sources table doesn't exist yet — run migration 20260917 in Supabase.", 424);
    }
    return bad(`Couldn't load sources: ${error.message}`, 500);
  }
  const { data: docCounts } = await supabaseAdmin
    .from("knowledge_documents").select("source_id")
    .eq("library_id", libraryId).not("source_id", "is", null);
  const countBySource = new Map<string, number>();
  for (const d of docCounts ?? []) {
    const sid = d.source_id as string;
    countBySource.set(sid, (countBySource.get(sid) ?? 0) + 1);
  }
  return NextResponse.json({
    sources: (sources ?? []).map((s) => ({
      id: s.id,
      sourceType: s.source_type,
      sourceId: s.source_id,
      sourceName: s.source_name,
      createdByName: s.created_by_name,
      createdAt: s.created_at,
      documentCount: countBySource.get(s.id as string) ?? 0,
    })),
    canManage: principal.isController,
  });
}

export async function POST(req: NextRequest) {
  let body: {
    orgId?: string; libraryId?: string; action?: string;
    add?: Array<{ type?: string; id?: string }>;
  };
  try { body = await req.json(); } catch { return bad("Expected JSON body"); }
  const orgId = String(body.orgId ?? "").trim();
  const libraryId = String(body.libraryId ?? "").trim();
  if (!orgId || !libraryId) return bad("orgId and libraryId are required");
  const user = await authUser(req);
  if (!user) return bad("Unauthorized", 401);
  const principal = await loadPrincipal(orgId, user.id);
  if (!principal) return bad("Not a member of this workspace", 403);
  if (!principal.isController) {
    return bad("Only Admin or Doc Control can manage knowledge sources.", 403);
  }

  const { data: library } = await supabaseAdmin
    .from("knowledge_libraries").select("id, name")
    .eq("id", libraryId).eq("org_id", orgId).maybeSingle();
  if (!library) return bad("Knowledge library not found", 404);

  // ── Re-sync on demand ──────────────────────────────────────────────────
  if (body.action === "sync") {
    const summary = await syncKnowledgeLibrarySources(libraryId);
    return NextResponse.json(summary);
  }

  // ── Link new sources ───────────────────────────────────────────────────
  const additions = Array.isArray(body.add) ? body.add.slice(0, 25) : [];
  if (additions.length === 0) return bad("add[] is required");
  const landscape = await loadDcLandscape(orgId);
  const { data: memberRow } = await supabaseAdmin
    .from("org_members").select("display_name, email")
    .eq("org_id", orgId).eq("uid", user.id).maybeSingle();
  const userName = (memberRow?.display_name as string) || (memberRow?.email as string) || "Member";

  let linked = 0;
  for (const item of additions) {
    const type = item.type === "folder" ? "folder" : item.type === "library" ? "library" : null;
    const id = String(item.id ?? "").trim();
    if (!type || !id) return bad("Each source needs type ('library'|'folder') and id.");
    // Server-side ACL check — the picker filter is convenience, THIS is law.
    if (!containerReadable(type, id, principal, landscape)) {
      return bad("One of the selected containers doesn't exist or isn't readable by you.", 403);
    }
    const sourceName = type === "library"
      ? landscape.libraries.get(id)?.name ?? "Library"
      : (() => {
          const f = landscape.folders.get(id);
          if (!f) return "Folder";
          const lib = landscape.libraries.get(f.library_id)?.name ?? "Library";
          return [lib, ...f.path_names.length ? f.path_names : [f.name]].join(" / ");
        })();
    const { error } = await supabaseAdmin.from("knowledge_sources").insert({
      org_id: orgId, library_id: libraryId,
      source_type: type, source_id: id, source_name: sourceName,
      created_by: user.id, created_by_name: userName,
    });
    if (error) {
      if (missingTable(error.message, error.code)) {
        return bad("The knowledge_sources table doesn't exist yet — run migration 20260917 in Supabase.", 424);
      }
      if (error.code === "23505") continue; // already linked — idempotent
      return bad(`Couldn't link source: ${error.message}`, 500);
    }
    linked++;
  }

  const summary = await syncKnowledgeLibrarySources(libraryId);
  await supabaseAdmin.from("audit_logs").insert({
    action: "KNOWLEDGE_SOURCES_LINKED",
    resource_type: "knowledge_library", resource_id: libraryId,
    org_id: orgId, user_id: user.id,
    details: { library: library.name, linked, added: summary.added },
  }).then(() => undefined, () => undefined);

  return NextResponse.json({ linked, ...summary });
}

export async function DELETE(req: NextRequest) {
  let body: { orgId?: string; sourceId?: string };
  try { body = await req.json(); } catch { return bad("Expected JSON body"); }
  const orgId = String(body.orgId ?? "").trim();
  const sourceId = String(body.sourceId ?? "").trim();
  if (!orgId || !sourceId) return bad("orgId and sourceId are required");
  const user = await authUser(req);
  if (!user) return bad("Unauthorized", 401);
  const principal = await loadPrincipal(orgId, user.id);
  if (!principal) return bad("Not a member of this workspace", 403);
  if (!principal.isController) {
    return bad("Only Admin or Doc Control can manage knowledge sources.", 403);
  }

  const { data: source } = await supabaseAdmin
    .from("knowledge_sources").select("id, library_id, source_name")
    .eq("id", sourceId).eq("org_id", orgId).maybeSingle();
  if (!source) return bad("Source not found", 404);

  // Mirrored docs + chunks cascade via FK.
  const { error } = await supabaseAdmin
    .from("knowledge_sources").delete().eq("id", sourceId);
  if (error) return bad(`Couldn't remove the source: ${error.message}`, 500);

  // Re-sync immediately: a document covered by TWO sources loses its mirror
  // in the cascade above — the remaining source re-adds it right now instead
  // of leaving a gap until the nightly cron.
  const resync = await syncKnowledgeLibrarySources(source.library_id as string);

  await supabaseAdmin.from("audit_logs").insert({
    action: "KNOWLEDGE_SOURCE_REMOVED",
    resource_type: "knowledge_library", resource_id: source.library_id as string,
    org_id: orgId, user_id: user.id,
    details: { sourceName: source.source_name, readded: resync.added },
  }).then(() => undefined, () => undefined);

  return NextResponse.json({ ok: true, readded: resync.added });
}
