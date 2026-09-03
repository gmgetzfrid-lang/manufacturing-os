// /api/graph/mentions — run the mention engine.
//
// POST { orgId }                → backfill every ready document in the org
// POST { orgId, documentId }    → re-index one knowledge document
//
// Resumable by design: the work is idempotent per document, and an invocation
// that runs out of wall clock reports `incomplete` so the caller POSTs again
// rather than believing a truncated pass was the whole plant. That distinction
// is the difference between "your map is finished" and "your map is missing
// half your drawings and nobody said so".

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  backfillOrgMentions, indexDocumentMentions, loadAliasDictionary,
} from "@/lib/mentionIndexer";
import { memberHoldsAny } from "@/lib/roleHeld";

export const runtime = "nodejs";
export const maxDuration = 60;

/** Stop with room to write and reply. A killed invocation reports nothing,
 *  and a caller that hears nothing retries forever. */
const BUDGET_MS = 45_000;

function bad(msg: string, status = 400) {
  return NextResponse.json({ error: msg }, { status });
}

export async function POST(req: NextRequest) {
  const deadline = Date.now() + BUDGET_MS;
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return bad("Unauthorized", 401);
  const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(authHeader.slice(7));
  if (authError || !user) return bad("Unauthorized", 401);

  let body: { orgId?: string; documentId?: string };
  try { body = await req.json(); } catch { return bad("Invalid JSON"); }
  const orgId = body.orgId?.trim();
  if (!orgId) return bad("orgId is required");

  // Rebuilding the org's link map is a controller action, not a read.
  const { data: member } = await supabaseAdmin
    .from("org_members").select("role, roles")
    .eq("org_id", orgId).eq("uid", user.id).eq("status", "active").maybeSingle();
  // ADD-1: authority by the role COLLECTION, never the headline alone.
  if (!memberHoldsAny(member as { role?: unknown; roles?: unknown } | null, ["Admin", "DocCtrl", "Manager", "Supervisor"])) {
    return bad("Forbidden", 403);
  }

  try {
    if (body.documentId) {
      const dictionary = await loadAliasDictionary(orgId);
      const { data: doc } = await supabaseAdmin
        .from("knowledge_documents")
        .select("id, source_document_id")
        .eq("id", body.documentId).eq("org_id", orgId).maybeSingle();
      if (!doc) return bad("Document not found", 404);
      const result = await indexDocumentMentions(
        orgId, body.documentId, dictionary,
        (doc as { source_document_id: string | null }).source_document_id,
      );
      return NextResponse.json({ ...result, documents: 1, incomplete: false });
    }

    const result = await backfillOrgMentions(orgId, undefined, deadline);
    return NextResponse.json(result);
  } catch (e) {
    const msg = (e as Error).message;
    if (/does not exist/i.test(msg)) {
      return bad("The mention engine isn't installed — run migration 20260929_mention_engine.sql.", 503);
    }
    return bad(msg, 500);
  }
}
