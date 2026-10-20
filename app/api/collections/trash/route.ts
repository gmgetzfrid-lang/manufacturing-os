// /api/collections/trash — the folder 30-day delete hold.
//
// GET  ?orgId&libraryId  → the library's trashed folders (controllers only)
// POST { orgId, collectionId } → restore one (controllers only)
//
// Deleting a folder steps its contents up and soft-deletes the emptied
// shell (see /api/collections/delete). Restore brings the shell back at its
// old spot — or the library root if the old parent has since vanished or is
// itself in the trash. Its former contents stayed where the delete moved
// them; move-undo or a manual move brings them back. The maintenance cron
// purges shells 30 days after deletion.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { loadPrincipal } from "@/lib/knowledgeAccess";

export const runtime = "nodejs";

const TRASH_HOLD_DAYS = 30;

function bad(msg: string, status = 400) {
  return NextResponse.json({ error: msg }, { status });
}

async function authController(req: NextRequest, orgId: string) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return { error: bad("Unauthorized", 401) };
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(authHeader.slice(7));
  if (error || !user) return { error: bad("Unauthorized", 401) };
  const principal = await loadPrincipal(orgId, user.id);
  if (!principal?.isController) {
    return { error: bad("Only Admins and Document Controllers can manage deleted folders.", 403) };
  }
  return { user };
}

export async function GET(req: NextRequest) {
  const orgId = String(req.nextUrl.searchParams.get("orgId") ?? "").trim();
  const libraryId = String(req.nextUrl.searchParams.get("libraryId") ?? "").trim();
  if (!orgId || !libraryId) return bad("orgId and libraryId are required");
  const auth = await authController(req, orgId);
  if ("error" in auth) return auth.error;

  const { data, error } = await supabaseAdmin
    .from("collections")
    .select("id, name, path_names, deleted_at, parent_id")
    .eq("org_id", orgId).eq("library_id", libraryId)
    .not("deleted_at", "is", null)
    .order("deleted_at", { ascending: false })
    .limit(200);
  if (error) {
    if (/deleted_at|42703/i.test(`${error.code} ${error.message}`)) {
      // Pre-migration DB: the trash doesn't exist yet.
      return NextResponse.json({ folders: [] });
    }
    return bad(`Couldn't load deleted folders: ${error.message}`, 500);
  }
  // A branch deleted in one go shares one timestamp — list only its top
  // folder; restoring that brings the rest back with it.
  const stampOf = new Map((data ?? []).map((r) => [r.id as string, r.deleted_at as string]));
  const tops = (data ?? []).filter((r) => {
    const p = r.parent_id as string | null;
    return !p || stampOf.get(p) !== r.deleted_at;
  });
  const folders = tops.map((r) => {
    const deletedAt = r.deleted_at as string;
    const purge = new Date(deletedAt);
    purge.setDate(purge.getDate() + TRASH_HOLD_DAYS);
    return {
      id: r.id as string,
      name: r.name as string,
      pathNames: Array.isArray(r.path_names) ? (r.path_names as string[]) : [],
      deletedAt,
      purgeAt: purge.toISOString(),
    };
  });
  return NextResponse.json({ folders });
}

export async function POST(req: NextRequest) {
  let body: { orgId?: string; collectionId?: string };
  try { body = await req.json(); } catch { return bad("Invalid JSON body"); }
  const orgId = String(body.orgId ?? "").trim();
  const collectionId = String(body.collectionId ?? "").trim();
  if (!orgId || !collectionId) return bad("orgId and collectionId are required");
  const auth = await authController(req, orgId);
  if ("error" in auth) return auth.error;

  const { data: node, error: nodeErr } = await supabaseAdmin
    .from("collections").select("id, org_id, library_id, parent_id, name, deleted_at")
    .eq("id", collectionId).maybeSingle();
  if (nodeErr) return bad(`Couldn't load the folder: ${nodeErr.message}`, 500);
  if (!node || node.org_id !== orgId) return bad("Folder not found.", 404);
  if (!node.deleted_at) return bad("That folder isn't in the trash.");

  // Old parent must still exist and be live; otherwise re-attach at root.
  let parentId = (node.parent_id as string | null) ?? null;
  if (parentId) {
    const { data: parent } = await supabaseAdmin
      .from("collections").select("id, deleted_at").eq("id", parentId).maybeSingle();
    if (!parent || parent.deleted_at) parentId = null;
  }

  const { error: restoreErr } = await supabaseAdmin
    .from("collections")
    .update({ deleted_at: null, deleted_by: null, parent_id: parentId })
    .eq("id", collectionId);
  if (restoreErr) return bad(`Couldn't restore the folder: ${restoreErr.message}`, 500);

  // Its branch, if it was deleted in the same operation (same timestamp).
  const { data: sameOp } = await supabaseAdmin
    .from("collections").select("id, parent_id")
    .eq("library_id", node.library_id as string).eq("deleted_at", node.deleted_at as string).limit(5000);
  const kids = new Map<string, string[]>();
  for (const r of (sameOp ?? []) as Array<{ id: string; parent_id: string | null }>) {
    if (!r.parent_id) continue;
    const arr = kids.get(r.parent_id);
    if (arr) arr.push(r.id); else kids.set(r.parent_id, [r.id]);
  }
  const branch: string[] = [];
  for (let q = [collectionId]; q.length;) {
    const next: string[] = [];
    for (const id of q) for (const k of kids.get(id) ?? []) { branch.push(k); next.push(k); }
    q = next;
  }
  for (let i = 0; i < branch.length; i += 200) {
    await supabaseAdmin.from("collections")
      .update({ deleted_at: null, deleted_by: null }).in("id", branch.slice(i, i + 200));
  }

  await supabaseAdmin.from("audit_logs").insert({
    action: "FOLDER_RESTORED",
    resource_type: "collection", resource_id: collectionId,
    org_id: orgId, user_id: auth.user.id, user_email: auth.user.email ?? null,
    details: { name: node.name, restoredToParent: parentId },
  }).then(() => undefined, () => undefined);

  return NextResponse.json({ ok: true, restoredToParent: parentId });
}
