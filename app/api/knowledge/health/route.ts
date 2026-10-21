// /api/knowledge/health — is this knowledge library a true copy of its
// linked document libraries, and fix it if not.
//
// GET  ?orgId&libraryId           → KnowledgeHealthReport   (any member)
// POST { orgId, libraryId }       → RepairResult            (Admin / Doc Control)

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { loadPrincipal } from "@/lib/knowledgeAccess";
import { knowledgeHealthReport, repairKnowledgeLibrary } from "@/lib/knowledgeHealthServer";

export const runtime = "nodejs";
export const maxDuration = 60;

function bad(msg: string, status = 400) {
  return NextResponse.json({ error: msg }, { status });
}

async function principalFor(req: NextRequest, orgId: string) {
  const h = req.headers.get("authorization");
  if (!h?.startsWith("Bearer ")) return null;
  const { data: { user } } = await supabaseAdmin.auth.getUser(h.slice(7));
  if (!user) return null;
  return loadPrincipal(orgId, user.id);
}

async function libraryInOrg(orgId: string, libraryId: string): Promise<boolean> {
  const { data } = await supabaseAdmin.from("knowledge_libraries").select("id").eq("id", libraryId).eq("org_id", orgId).maybeSingle();
  return !!data;
}

export async function GET(req: NextRequest) {
  const orgId = req.nextUrl.searchParams.get("orgId") ?? "";
  const libraryId = req.nextUrl.searchParams.get("libraryId") ?? "";
  if (!orgId || !libraryId) return bad("orgId and libraryId are required");
  const p = await principalFor(req, orgId);
  if (!p) return bad("Unauthorized", 401);
  if (!(await libraryInOrg(orgId, libraryId))) return bad("Library not found.", 404);
  try {
    return NextResponse.json(await knowledgeHealthReport(orgId, libraryId));
  } catch (e) {
    return bad(`Couldn't check the library: ${(e as Error).message}`, 500);
  }
}

export async function POST(req: NextRequest) {
  let body: { orgId?: string; libraryId?: string };
  try { body = await req.json(); } catch { return bad("Invalid JSON body"); }
  const orgId = String(body.orgId ?? "");
  const libraryId = String(body.libraryId ?? "");
  if (!orgId || !libraryId) return bad("orgId and libraryId are required");
  const p = await principalFor(req, orgId);
  if (!p) return bad("Unauthorized", 401);
  if (!p.isController) return bad("Only Admins and Document Control can repair a library.", 403);
  if (!(await libraryInOrg(orgId, libraryId))) return bad("Library not found.", 404);
  try {
    const result = await repairKnowledgeLibrary(orgId, libraryId);
    await supabaseAdmin.from("audit_logs").insert({
      action: "KNOWLEDGE_LIBRARY_REPAIRED", resource_type: "knowledge_library", resource_id: libraryId,
      org_id: orgId, user_id: p.uid,
      details: { sync: result.sync, requeued: result.requeued },
    }).then(() => undefined, () => undefined);
    return NextResponse.json(result);
  } catch (e) {
    return bad(`Repair didn't finish: ${(e as Error).message}`, 500);
  }
}
