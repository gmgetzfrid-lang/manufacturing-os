// POST /api/estate/folder-mark — what a folder stands for.
//   { orgId, action: "info", folderId }                 → its marks, inherited marks, pickers
//   { orgId, action: "mark", folderId, mark }           → mark it (area / type / equipment / clear)
//   { orgId, action: "plan", libraryId, levels }        → what each folder of a library would become
//   { orgId, action: "apply", libraryId, levels }       → mark them; call again while `more`
// Admin and Doc Control only. Search links for the documents underneath are
// refreshed after the response.

import { NextRequest, NextResponse, after } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { requireMember } from "@/lib/estate/serverAuth";
import { folderMarkInfo, markFolder, planLibrary, applyLibrary, type FolderMark } from "@/lib/estate/folderMarksServer";
import type { LevelMeaning } from "@/lib/estate/folderMarks";

export const runtime = "nodejs";
export const maxDuration = 60;

const LEVELS = new Set<LevelMeaning>(["area", "type", "equipment", "skip"]);

export async function POST(req: NextRequest) {
  const t0 = Date.now();
  let body: { orgId?: string; action?: string; folderId?: string; libraryId?: string; mark?: FolderMark; levels?: string[] };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Expected JSON body" }, { status: 400 }); }
  const orgId = String(body.orgId ?? "");
  const auth = await requireMember(req, orgId, ["Admin", "DocCtrl"]);
  if (auth.error) return NextResponse.json({ error: auth.error.message }, { status: auth.error.status });
  const actor = { userId: auth.caller!.userId, name: auth.caller!.email };
  const levels = (Array.isArray(body.levels) ? body.levels : []).slice(0, 6).map((l) => (LEVELS.has(l as LevelMeaning) ? l : "skip") as LevelMeaning);
  const refreshLinks = (libraryId: string | null) => after(async () => {
    const { resolveEstate } = await import("@/lib/estate/resolverServer");
    await resolveEstate(supabaseAdmin, { orgId, libraryIds: libraryId ? [libraryId] : undefined, actor }).catch(() => undefined);
  });
  try {
    if (body.action === "info") return NextResponse.json(await folderMarkInfo(supabaseAdmin, orgId, String(body.folderId ?? "")));
    if (body.action === "mark") {
      if (!body.mark || typeof body.mark !== "object") return NextResponse.json({ error: "mark is required" }, { status: 400 });
      const state = await markFolder(supabaseAdmin, { orgId, folderId: String(body.folderId ?? ""), mark: body.mark, actor });
      const { data: f } = await supabaseAdmin.from("collections").select("library_id").eq("id", String(body.folderId ?? "")).maybeSingle();
      refreshLinks((f as { library_id?: string } | null)?.library_id ?? null);
      return NextResponse.json({ state });
    }
    if (body.action === "plan") return NextResponse.json({ rows: await planLibrary(supabaseAdmin, orgId, String(body.libraryId ?? ""), levels) });
    if (body.action === "apply") {
      const r = await applyLibrary(supabaseAdmin, { orgId, libraryId: String(body.libraryId ?? ""), levels, actor, deadlineMs: t0 + 45_000 });
      if (!r.more) refreshLinks(String(body.libraryId ?? ""));
      return NextResponse.json(r);
    }
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 422 });
  }
}
