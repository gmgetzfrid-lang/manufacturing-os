// /api/knowledge/ingest — turn a knowledge document's PDF into searchable
// chunks, one client-driven batch at a time.
//
// A 900-page standard cannot be indexed inside one serverless invocation, so
// the CLIENT drives batches: POST { documentId } repeatedly; each call
// ingests the next PAGE_BATCH pages and reports progress. The loop is
// resumable — a dropped connection or timeout just re-POSTs and picks up at
// pages_indexed. The maintenance cron drains the same queue in the
// background (lib/knowledgeIngest is the single engine for both).
//
// Scanned (image-only) pages yield no text; we count them so the UI can say
// "34 of 900 pages had no extractable text" instead of pretending.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { ingestKnowledgeDocBatch } from "@/lib/knowledgeIngest";

export const runtime = "nodejs";
export const maxDuration = 300;

function bad(msg: string, status = 400) {
  return NextResponse.json({ error: msg }, { status });
}

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return bad("Unauthorized", 401);
  const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(authHeader.slice(7));
  if (authError || !user) return bad("Unauthorized", 401);

  let body: { documentId?: string };
  try { body = await req.json(); } catch { return bad("Expected JSON body"); }
  const documentId = String(body.documentId ?? "").trim();
  if (!documentId) return bad("documentId is required");

  const { data: doc } = await supabaseAdmin
    .from("knowledge_documents").select("*").eq("id", documentId).maybeSingle();
  if (!doc) return bad("Document not found", 404);

  // Ingest is a controller action (same bar as adding library documents).
  const { data: member } = await supabaseAdmin
    .from("org_members").select("role, roles")
    .eq("org_id", doc.org_id as string).eq("uid", user.id).eq("status", "active")
    .maybeSingle();
  const roles = new Set<string>([
    (member?.role as string) ?? "", ...(((member?.roles as string[]) ?? [])),
  ]);
  if (!member || (!roles.has("Admin") && !roles.has("DocCtrl"))) {
    return bad("Only Admin or Doc Control can index documents.", 403);
  }

  if (doc.status === "ready") {
    return NextResponse.json({ done: true, pageCount: doc.page_count, pagesIndexed: doc.pages_indexed });
  }

  try {
    const res = await ingestKnowledgeDocBatch({
      id: doc.id as string,
      org_id: doc.org_id as string,
      library_id: doc.library_id as string,
      name: doc.name as string,
      file_key: doc.file_key as string,
      status: doc.status as string,
      pages_indexed: (doc.pages_indexed as number | null) ?? 0,
      page_count: doc.page_count as number | null,
      last_section: (doc.last_section as string | null) ?? null,
    });

    if (res.done) {
      await supabaseAdmin.from("audit_logs").insert({
        action: "KNOWLEDGE_DOC_INDEXED",
        resource_type: "knowledge_document", resource_id: String(doc.id),
        org_id: doc.org_id, user_id: user.id,
        details: { name: doc.name, pages: res.pageCount },
      }).then(() => undefined, () => undefined);
    }

    return NextResponse.json(res);
  } catch (e) {
    const message = (e as Error).message;
    await supabaseAdmin.from("knowledge_documents")
      .update({ status: "error", error: message.slice(0, 500) })
      .eq("id", doc.id as string);
    return bad(`Indexing failed: ${message}`, 502);
  }
}
