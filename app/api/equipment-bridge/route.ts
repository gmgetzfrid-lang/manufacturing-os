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
// Writer roles only (Admin / DocCtrl / Manager / Supervisor) — the bridge
// writes documents and the registry.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { computeForKnowledgeDoc, applyForDocument, type BridgeConfig } from "@/lib/equipmentBridgeServer";
import { memberHoldsAny } from "@/lib/roleHeld";

export const runtime = "nodejs";
export const maxDuration = 60;

const WRITER_ROLES = new Set(["Admin", "DocCtrl", "Manager", "Supervisor"]);

function bad(msg: string, status = 400) {
  return NextResponse.json({ error: msg }, { status });
}

async function authWriter(req: NextRequest, orgId: string): Promise<{ userId: string } | NextResponse> {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return bad("Not authenticated", 401);
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(authHeader.slice(7));
  if (error || !user) return bad("Not authenticated", 401);
  const { data: member } = await supabaseAdmin
    .from("org_members").select("role, roles").eq("org_id", orgId).eq("uid", user.id)
    .eq("status", "active").maybeSingle();
  // ADD-1: authority by the role COLLECTION, never the headline alone.
  if (!member || !memberHoldsAny(member, [...WRITER_ROLES])) return bad("Not permitted", 403);
  return { userId: user.id };
}

export async function GET(req: NextRequest) {
  const orgId = req.nextUrl.searchParams.get("orgId") ?? "";
  const libraryId = req.nextUrl.searchParams.get("libraryId") ?? "";
  if (!orgId || !libraryId) return bad("orgId and libraryId required");
  const auth = await authWriter(req, orgId);
  if (auth instanceof NextResponse) return auth;

  const { data: docs } = await supabaseAdmin
    .from("documents").select("id, document_number, title, name")
    .eq("org_id", orgId).eq("library_id", libraryId).neq("status", "Archived").limit(2000);
  const docList = (docs ?? []) as Array<{ id: string; document_number: string | null; title: string | null; name: string | null }>;
  const ids = docList.map((d) => d.id);

  const rows: Array<Record<string, unknown>> = [];
  for (let i = 0; i < ids.length; i += 100) {
    const { data } = await supabaseAdmin
      .from("document_equipment_suggestions").select("*")
      .eq("org_id", orgId).in("document_id", ids.slice(i, i + 100));
    rows.push(...((data ?? []) as Array<Record<string, unknown>>));
  }
  const nameById = new Map(docList.map((d) => [d.id, d.document_number || d.title || d.name || d.id.slice(0, 8)]));

  // Which docs have knowledge twins at all (so the wizard can say "N linked").
  const { data: twins } = await supabaseAdmin
    .from("knowledge_documents").select("id, source_document_id, status")
    .in("source_document_id", ids.length > 0 ? ids : ["00000000-0000-0000-0000-000000000000"]);

  const { data: lib } = await supabaseAdmin
    .from("libraries").select("equipment_bridge, custom_columns").eq("id", libraryId).maybeSingle();

  return NextResponse.json({
    suggestions: rows.map((r) => ({ ...r, documentLabel: nameById.get(String(r.document_id)) ?? "—" })),
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
    const { data: docs } = await supabaseAdmin
      .from("documents").select("id")
      .eq("org_id", orgId).eq("library_id", libraryId).neq("status", "Archived").limit(2000);
    const ids = ((docs ?? []) as Array<{ id: string }>).map((d) => d.id);
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
    const results: Array<{ documentId: string; appliedTags?: string[]; createdAssets?: number; error?: string }> = [];
    for (const documentId of documentIds.slice(0, 500)) {
      try {
        const r = await applyForDocument(supabaseAdmin, { orgId, documentId, userId: auth.userId, tags });
        results.push({ documentId, ...r });
      } catch (e) {
        results.push({ documentId, error: (e as Error).message });
      }
    }
    return NextResponse.json({ ok: true, results });
  }

  return bad(`Unknown action "${action}"`);
}
