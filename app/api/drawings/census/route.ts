// POST /api/drawings/census — read a drawing sheet the way the chat does.
//   { orgId, documentId | knowledgeDocumentId, page? }
//     → one page read with the caller's own model; the last page also
//       corrects the drawing's equipment column and links.
//   { orgId, action: "pending" }
//     → read copies in drawing libraries not yet read this way.
// Writer roles; the reading is billed to the caller's key, under the same
// gates and monthly cap as every AI feature.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { requireMember } from "@/lib/estate/serverAuth";
import { censusPage } from "@/lib/drawingCensus";
import { GovernedCallError } from "@/lib/ai/governedCall";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const t0 = Date.now();
  let body: { orgId?: string; documentId?: string; knowledgeDocumentId?: string; page?: number; action?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Expected JSON body" }, { status: 400 }); }
  const orgId = String(body.orgId ?? "");
  const auth = await requireMember(req, orgId, ["Admin", "DocCtrl", "Manager", "Supervisor"]);
  if (auth.error) return NextResponse.json({ error: auth.error.message }, { status: auth.error.status });

  if (body.action === "pending") {
    const { data: libs } = await supabaseAdmin.from("knowledge_libraries").select("id, ai_features").eq("org_id", orgId).limit(200);
    const drawingLibs = ((libs as Array<{ id: string; ai_features: Record<string, unknown> | null }> | null) ?? []).filter((l) => (l.ai_features ?? {}).drawingIntel === true).map((l) => l.id);
    if (!drawingLibs.length) return NextResponse.json({ pending: [] });
    const { data: docs } = await supabaseAdmin.from("knowledge_documents").select("id, name, source_document_id").in("library_id", drawingLibs).eq("status", "ready").not("source_document_id", "is", null).limit(3000);
    const all = (docs as Array<{ id: string; name: string; source_document_id: string }> | null) ?? [];
    // One read copy per drawing is enough: the same document mirrored into
    // two libraries is read once.
    const seen = new Set<string>();
    const uniq = all.filter((d) => { if (seen.has(d.source_document_id)) return false; seen.add(d.source_document_id); return true; });
    const read = new Set<string>();
    for (let i = 0; i < uniq.length; i += 200) {
      const { data: c } = await supabaseAdmin.from("knowledge_page_entities").select("document_id").eq("kind", "census").in("document_id", uniq.slice(i, i + 200).map((d) => d.id)).limit(20000);
      for (const r of (c as Array<{ document_id: string }> | null) ?? []) read.add(r.document_id);
    }
    return NextResponse.json({ pending: uniq.filter((d) => !read.has(d.id)).map((d) => ({ knowledgeDocumentId: d.id, name: d.name })), total: uniq.length });
  }

  let kdocId = String(body.knowledgeDocumentId ?? "");
  if (!kdocId && body.documentId) {
    // Prefer a copy in a drawing library; any ready copy otherwise.
    const { data: copies } = await supabaseAdmin.from("knowledge_documents").select("id, library_id, status").eq("org_id", orgId).eq("source_document_id", String(body.documentId)).limit(10);
    const list = (copies as Array<{ id: string; library_id: string; status: string }> | null) ?? [];
    if (list.length) {
      const { data: libs } = await supabaseAdmin.from("knowledge_libraries").select("id, ai_features").in("id", list.map((c) => c.library_id));
      const drawing = new Set(((libs as Array<{ id: string; ai_features: Record<string, unknown> | null }> | null) ?? []).filter((l) => (l.ai_features ?? {}).drawingIntel === true).map((l) => l.id));
      kdocId = (list.find((c) => drawing.has(c.library_id)) ?? list[0]).id;
    }
  }
  if (!kdocId) return NextResponse.json({ error: "This drawing is not in a read library yet. Press Connect everything on the Documents map once, then read it." }, { status: 404 });
  try {
    const r = await censusPage({ orgId, userId: auth.caller!.userId, knowledgeDocId: kdocId, page: Math.max(1, Number(body.page ?? 1) || 1), deadlineMs: t0 + 57_000 });
    return NextResponse.json({ knowledgeDocumentId: kdocId, ...r });
  } catch (e) {
    if (e instanceof GovernedCallError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
