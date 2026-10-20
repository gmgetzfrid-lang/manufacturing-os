// /api/documents/delete — permanent delete of selected documents.
//
// POST { orgId, documentIds } → { deleted, held, remaining }
// Controllers only (the same bar as the documents delete RLS policy).
// Records under a legal hold are reported in `held` and never deleted.
// Bounded per call: the client repeats with `remaining` until it's empty.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { loadPrincipal } from "@/lib/knowledgeAccess";
import { deleteDocumentRows } from "@/lib/serverDocDelete";

export const runtime = "nodejs";
export const maxDuration = 60;

function bad(msg: string, status = 400) {
  return NextResponse.json({ error: msg }, { status });
}

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return bad("Unauthorized", 401);
  const { data: { user }, error: authErr } = await supabaseAdmin.auth.getUser(authHeader.slice(7));
  if (authErr || !user) return bad("Unauthorized", 401);

  let body: { orgId?: string; documentIds?: unknown };
  try { body = await req.json(); } catch { return bad("Invalid JSON body"); }
  const orgId = String(body.orgId ?? "").trim();
  const ids = Array.isArray(body.documentIds)
    ? body.documentIds.filter((x): x is string => typeof x === "string" && /^[0-9a-f-]{36}$/i.test(x)).slice(0, 1000)
    : [];
  if (!orgId || ids.length === 0) return bad("orgId and documentIds are required");

  const principal = await loadPrincipal(orgId, user.id);
  if (!principal?.isController) return bad("Only Admins and Document Controllers can delete documents.", 403);

  try {
    const result = await deleteDocumentRows(supabaseAdmin, orgId, ids, Date.now() + 45_000);
    if (result.deleted.length) {
      await supabaseAdmin.from("audit_logs").insert({
        action: "DOCUMENTS_DELETED",
        resource_type: "document", resource_id: result.deleted[0],
        org_id: orgId, user_id: user.id, user_email: user.email ?? null,
        details: { count: result.deleted.length, ids: result.deleted.slice(0, 200), heldSkipped: result.held.length },
      }).then(() => undefined, () => undefined);
    }
    return NextResponse.json(result);
  } catch (e) {
    return bad((e as Error).message, 500);
  }
}
