// /api/equipment-bridge — the drawing→equipment bridge's control surface.
//
//   GET  ?orgId&libraryId          → suggestion rows for the library's docs
//                                    (the sweep wizard's table)
//   POST { action:"sweep", orgId, libraryId }
//                                  → recompute suggestions for every document
//                                    in the library that has an indexed
//                                    knowledge twin
//   POST { action:"apply", orgId, documentIds, tags? }
//                                  → apply suggestions (registry discovery +
//                                    column populate)
//   POST { action:"settings", orgId, libraryId, targetColumnKey, autoApply,
//          defaultUnitCode, createAssets }
//                                  → save the library's bridge mapping
//
// Admin and Doc Control only — the bridge
// writes documents and the registry.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { computeForKnowledgeDoc, applyForDocument, unlinkForDocument, folderUnitOf, type BridgeConfig } from "@/lib/equipmentBridgeServer";

/** A folder and every folder under it, in a library. */
async function folderTree(libraryId: string, folderId: string): Promise<Set<string>> {
  const { rows: all } = await fetchAllRows<{ id: string; parent_id: string | null; deleted_at: string | null }>((from, to) => supabaseAdmin
    .from("collections").select("id, parent_id, deleted_at").eq("library_id", libraryId).order("id").range(from, to));
  const rows = all.filter((c) => !c.deleted_at);
  const out = new Set<string>([folderId]);
  for (let grew = true; grew;) {
    grew = false;
    for (const c of rows) if (c.parent_id && out.has(c.parent_id) && !out.has(c.id)) { out.add(c.id); grew = true; }
  }
  return out;
}
import { fetchAllRows } from "@/lib/fetchAllRows";

export const runtime = "nodejs";
export const maxDuration = 60;

const WRITER_ROLES = new Set(["Admin", "DocCtrl"]);

function bad(msg: string, status = 400) {
  return NextResponse.json({ error: msg }, { status });
}

async function authWriter(req: NextRequest, orgId: string): Promise<{ userId: string; role: string } | NextResponse> {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return bad("Not authenticated", 401);
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(authHeader.slice(7));
  if (error || !user) return bad("Not authenticated", 401);
  const { data: member } = await supabaseAdmin
    .from("org_members").select("role").eq("org_id", orgId).eq("uid", user.id)
    .eq("status", "active").maybeSingle();
  if (!member || !WRITER_ROLES.has(String(member.role))) return bad("Not permitted", 403);
  return { userId: user.id, role: String(member.role) };
}

export async function GET(req: NextRequest) {
  const orgId = req.nextUrl.searchParams.get("orgId") ?? "";
  const libraryId = req.nextUrl.searchParams.get("libraryId") ?? "";
  if (!orgId || !libraryId) return bad("orgId and libraryId required");
  const auth = await authWriter(req, orgId);
  if (auth instanceof NextResponse) return auth;

  const { rows: allDocs } = await fetchAllRows<{ id: string; collection_id: string | null; document_number: string | null; title: string | null; name: string | null; rev: string | null; sheet_number: number | null; sheet_total: number | null; metadata: Record<string, unknown> | null }>((from, to) => supabaseAdmin
    .from("documents").select("id, collection_id, document_number, title, name, rev, sheet_number, sheet_total, metadata")
    .eq("org_id", orgId).eq("library_id", libraryId).neq("status", "Archived").order("id").range(from, to));
  // Opened in a folder: that folder's drawings (and its subfolders'), only.
  const folderId = req.nextUrl.searchParams.get("folderId") || null;
  const inFolder = folderId ? await folderTree(libraryId, folderId) : null;
  const docList = inFolder ? allDocs.filter((d) => d.collection_id && inFolder.has(d.collection_id)) : allDocs;
  const ids = docList.map((d) => d.id);

  const rows: Array<Record<string, unknown>> = [];
  for (let i = 0; i < ids.length; i += 100) {
    const { data } = await supabaseAdmin
      .from("document_equipment_suggestions").select("*")
      .eq("org_id", orgId).in("document_id", ids.slice(i, i + 100));
    rows.push(...((data ?? []) as Array<Record<string, unknown>>));
  }
  const nameById = new Map(docList.map((d) => [d.id, d.document_number || d.title || d.name || d.id.slice(0, 8)]));
  // The sheet each row is off, so it can be checked against the drawing.
  const sheetOf = (d: (typeof docList)[number]) => {
    const md = d.metadata ?? {};
    const own = d.sheet_number ?? (typeof md.sheet === "string" || typeof md.sheet === "number" ? String(md.sheet) : null);
    return own == null || own === "" ? null : String(own);
  };
  const infoById = new Map(docList.map((d) => [d.id, { number: d.document_number, title: d.title, rev: d.rev, sheet: sheetOf(d), sheetTotal: d.sheet_total }]));

  // Which docs have knowledge twins at all (so the wizard can say "N linked").
  const { data: twins } = await supabaseAdmin
    .from("knowledge_documents").select("id, source_document_id, status")
    .in("source_document_id", ids.length > 0 ? ids : ["00000000-0000-0000-0000-000000000000"]);

  const { data: lib } = await supabaseAdmin
    .from("libraries").select("equipment_bridge, custom_columns").eq("id", libraryId).maybeSingle();

  return NextResponse.json({
    suggestions: rows.map((r) => ({ ...r, documentLabel: nameById.get(String(r.document_id)) ?? "-", doc: infoById.get(String(r.document_id)) ?? null })),
    canAdd: auth.role === "Admin",
    folder: folderId ? { id: folderId, unitCode: await folderUnitOf(supabaseAdmin, orgId, folderId) } : null,
    linkedDocs: ((twins ?? []) as Array<{ source_document_id: string; status: string }>)
      .map((t) => ({ documentId: t.source_document_id, status: t.status })),
    bridge: (lib?.equipment_bridge ?? null) as BridgeConfig | null,
    customColumns: lib?.custom_columns ?? [],
  });
}

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return bad("Invalid JSON body"); }
  const orgId = String(body.orgId ?? "");
  const action = String(body.action ?? "");
  if (!orgId) return bad("orgId required");
  const auth = await authWriter(req, orgId);
  if (auth instanceof NextResponse) return auth;

  if (action === "settings") {
    const libraryId = String(body.libraryId ?? "");
    if (!libraryId) return bad("libraryId required");
    const cfg: BridgeConfig = {
      targetColumnKey: body.targetColumnKey ? String(body.targetColumnKey) : undefined,
      autoApply: body.autoApply === true,
      defaultUnitCode: body.defaultUnitCode ? String(body.defaultUnitCode) : undefined,
      createAssets: body.createAssets !== false,
    };
    const { error } = await supabaseAdmin.from("libraries")
      .update({ equipment_bridge: cfg }).eq("id", libraryId).eq("org_id", orgId);
    if (error) return bad(error.message, 500);
    return NextResponse.json({ ok: true });
  }

  if (action === "sweep") {
    const libraryId = String(body.libraryId ?? "");
    if (!libraryId) return bad("libraryId required");
    // Every knowledge twin of this doc-control library's documents, ready or
    // not — compute skips gracefully when there are no entities yet.
    const { rows: docs } = await fetchAllRows<{ id: string; collection_id: string | null }>((from, to) => supabaseAdmin
      .from("documents").select("id, collection_id")
      .eq("org_id", orgId).eq("library_id", libraryId).neq("status", "Archived").order("id").range(from, to));
    const inFolder = body.folderId ? await folderTree(libraryId, String(body.folderId)) : null;
    const ids = docs.filter((d) => !inFolder || (d.collection_id && inFolder.has(d.collection_id))).map((d) => d.id);
    let computed = 0;
    for (let i = 0; i < ids.length; i += 100) {
      const { data: twins } = await supabaseAdmin
        .from("knowledge_documents").select("id")
        .in("source_document_id", ids.slice(i, i + 100));
      for (const t of (twins ?? []) as Array<{ id: string }>) {
        try { await computeForKnowledgeDoc(supabaseAdmin, t.id); computed++; } catch { /* per-doc failures never sink the sweep */ }
      }
    }
    return NextResponse.json({ ok: true, computed });
  }

  if (action === "apply") {
    const documentIds = Array.isArray(body.documentIds) ? body.documentIds.map(String) : [];
    if (documentIds.length === 0) return bad("documentIds required");
    const tags = Array.isArray(body.tags) ? body.tags.map(String) : undefined;
    // Per drawing: the tags ticked, and what was decided for each.
    const perDoc = (body.perDoc && typeof body.perDoc === "object" ? body.perDoc : {}) as Record<string, { tags?: unknown; choices?: unknown }>;
    const results: Array<{ documentId: string; appliedTags?: string[]; createdAssets?: number; updatedAssets?: number; failed?: Array<{ tag: string; why: string }>; error?: string }> = [];
    for (const documentId of documentIds.slice(0, 500)) {
      try {
        const own = perDoc[documentId];
        const ownTags = Array.isArray(own?.tags) ? (own!.tags as unknown[]).map(String) : tags;
        const choices = own?.choices && typeof own.choices === "object" ? own.choices as Record<string, { skip?: boolean; code?: string | null; typeCode?: string | null; overwrite?: boolean }> : undefined;
        // Only admins add equipment; others link what's already listed.
        const r = await applyForDocument(supabaseAdmin, { orgId, documentId, userId: auth.userId, tags: ownTags, choices, byPerson: true, mayCreate: auth.role === "Admin" });
        results.push({ documentId, ...r });
        // Read the sheet again against the registry as it is now, so what
        // was just added or linked shows as listed.
        const { data: twins } = await supabaseAdmin.from("knowledge_documents").select("id").eq("source_document_id", documentId);
        for (const t of (twins ?? []) as Array<{ id: string }>) await computeForKnowledgeDoc(supabaseAdmin, t.id, { autoApply: false }).catch(() => undefined);
      } catch (e) {
        results.push({ documentId, error: (e as Error).message });
      }
    }
    return NextResponse.json({ ok: true, results });
  }

  if (action === "unlink") {
    const documentId = String(body.documentId ?? "");
    const tags = Array.isArray(body.tags) ? body.tags.map(String) : [];
    if (!documentId || !tags.length) return bad("documentId and tags required");
    const r = await unlinkForDocument(supabaseAdmin, { orgId, documentId, tags, userId: auth.userId });
    return NextResponse.json({ ok: true, ...r });
  }

  // A folder's unit, set by a person: it wins over one read off the name.
  if (action === "folderUnit") {
    const folderId = String(body.folderId ?? "");
    const unitCode = String(body.unitCode ?? "");
    if (!folderId || !unitCode) return bad("folderId and unitCode required");
    const a = `folder:${folderId}`;
    await supabaseAdmin.from("estate_edges").update({ status: "dismissed" }).eq("org_id", orgId).eq("a", a).eq("type", "belongs_to_unit").neq("b", `cbunit:${unitCode}`);
    const { error } = await supabaseAdmin.from("estate_edges").upsert({
      org_id: orgId, a, b: `cbunit:${unitCode}`, type: "belongs_to_unit", origin: "person", tier: "provable", confidence: 1, status: "applied",
      summary: `Folder set to unit ${unitCode} by hand`, evidence: { where: "equipment from drawings" }, created_by: auth.userId,
    }, { onConflict: "org_id,a,b,type" });
    if (error) return bad(error.message, 500);
    await supabaseAdmin.from("estate_edges").update({ status: "applied", origin: "person" }).eq("org_id", orgId).eq("a", a).eq("type", "belongs_to_unit").eq("b", `cbunit:${unitCode}`);
    return NextResponse.json({ ok: true });
  }

  return bad(`Unknown action "${action}"`);
}
