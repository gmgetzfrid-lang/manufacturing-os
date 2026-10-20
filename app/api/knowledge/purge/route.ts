// /api/knowledge/purge — remove knowledge documents or a whole library.
//
// POST { orgId, libraryId, documentIds? } → { done, removedDocuments, remainingDocuments }
//   documentIds set: remove those documents (upload-origin ones; documents
//   mirrored from document control are managed by their source link).
//   documentIds unset: remove the whole library.
// Bounded per call; the client repeats until done. Admin/DocCtrl only.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { purgeKnowledge } from "@/lib/knowledgePurge";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const h = req.headers.get("authorization");
  if (!h?.startsWith("Bearer ")) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(h.slice(7));
  if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  let body: { orgId?: string; libraryId?: string; documentIds?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Expected JSON body" }, { status: 400 }); }
  const orgId = String(body.orgId ?? "");
  const libraryId = String(body.libraryId ?? "");
  if (!orgId || !libraryId) return NextResponse.json({ error: "orgId and libraryId are required" }, { status: 400 });

  const { data: m } = await supabaseAdmin
    .from("org_members").select("role, roles")
    .eq("org_id", orgId).eq("uid", user.id).eq("status", "active").maybeSingle();
  const roles = new Set<string>([(m?.role as string) ?? "", ...(((m?.roles as string[]) ?? []))]);
  if (!m || (!roles.has("Admin") && !roles.has("DocCtrl"))) {
    return NextResponse.json({ error: "Only Admins and Document Control can remove library content." }, { status: 403 });
  }
  const { data: lib } = await supabaseAdmin
    .from("knowledge_libraries").select("id, name").eq("id", libraryId).eq("org_id", orgId).maybeSingle();
  if (!lib) return NextResponse.json({ done: true, removedDocuments: 0, remainingDocuments: 0 });

  let documentIds: string[] | undefined;
  if (Array.isArray(body.documentIds)) {
    documentIds = body.documentIds.filter((x): x is string => typeof x === "string" && /^[0-9a-f-]{36}$/i.test(x)).slice(0, 2000);
    // Mirrors of controlled documents are removed by unlinking their source.
    const { data: mirrored } = await supabaseAdmin
      .from("knowledge_documents").select("id").in("id", documentIds).not("source_document_id", "is", null);
    const skip = new Set(((mirrored ?? []) as Array<{ id: string }>).map((r) => r.id));
    documentIds = documentIds.filter((id) => !skip.has(id));
    if (documentIds.length === 0) return NextResponse.json({ done: true, removedDocuments: 0, remainingDocuments: 0 });
  }

  try {
    const result = await purgeKnowledge(supabaseAdmin, { orgId, libraryId, documentIds, deadlineMs: Date.now() + 45_000 });
    if (result.done) {
      await supabaseAdmin.from("audit_logs").insert({
        action: documentIds ? "KNOWLEDGE_DOCUMENTS_REMOVED" : "KNOWLEDGE_LIBRARY_DELETED",
        resource_type: "knowledge_library", resource_id: libraryId, org_id: orgId, user_id: user.id,
        details: { library: lib.name, ...(documentIds ? { documents: documentIds.length } : {}) },
      }).then(() => undefined, () => undefined);
    }
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: `Couldn't finish removing: ${(e as Error).message}` }, { status: 502 });
  }
}
