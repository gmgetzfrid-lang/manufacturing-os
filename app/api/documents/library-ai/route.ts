// POST /api/documents/library-ai — mark a library "never send to AI".
//   { orgId, libraryId, excluded: boolean } → { excluded, purged }
// Admin and Doc Control only. Turning it on deletes the AI's copies of the
// library's documents at once; turning it off restores nothing by itself —
// the library is read again only if a person links it and reads it.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { requireMember } from "@/lib/estate/serverAuth";
import { purgeLibraryFromAi } from "@/lib/aiLibraries";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  let body: { orgId?: string; libraryId?: string; excluded?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Expected JSON body" }, { status: 400 }); }
  const orgId = String(body.orgId ?? "");
  const libraryId = String(body.libraryId ?? "");
  if (!libraryId || typeof body.excluded !== "boolean") return NextResponse.json({ error: "libraryId and excluded are required" }, { status: 400 });
  const auth = await requireMember(req, orgId, ["Admin", "DocCtrl"]);
  if (auth.error) return NextResponse.json({ error: auth.error.message }, { status: auth.error.status });
  const excluded = body.excluded;
  const { data: lib } = await supabaseAdmin.from("libraries").select("id, name").eq("id", libraryId).eq("org_id", orgId).maybeSingle();
  if (!lib) return NextResponse.json({ error: "No such library in this workspace" }, { status: 404 });
  const { error } = await supabaseAdmin.from("libraries").update({ ai_excluded: excluded }).eq("id", libraryId).eq("org_id", orgId);
  if (error) {
    const missing = error.code === "42703" || /ai_excluded|column/i.test(error.message);
    return NextResponse.json({ error: missing ? "This needs migration 20261021_ai_boundary_runs.sql — apply it in Supabase, then try again." : error.message }, { status: missing ? 424 : 500 });
  }
  let purged = 0;
  if (excluded) {
    try { purged = await purgeLibraryFromAi(supabaseAdmin, orgId, libraryId); }
    catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 500 }); }
  }
  await supabaseAdmin.from("audit_logs").insert({
    action: excluded ? "LIBRARY_AI_EXCLUDED" : "LIBRARY_AI_ALLOWED", resource_type: "library", resource_id: libraryId,
    org_id: orgId, user_id: auth.caller!.userId, details: { name: (lib as { name: string }).name, purged },
  }).then(() => undefined, () => undefined);
  return NextResponse.json({ excluded, purged });
}
