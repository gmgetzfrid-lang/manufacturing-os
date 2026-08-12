// /api/collections/delete — folder deletion, done where it can actually work.
//
// The client CANNOT delete a folder: collections has a RESTRICTIVE delete
// policy and no permissive one, so an anon-key DELETE matches zero rows and
// "succeeds" — which shipped as a Delete menu item that visibly did nothing.
// RLS was right to refuse (raw PostgREST deletes from members are a hole);
// the app path belongs here, on the service role, behind the same
// controller check the RLS policy encodes.
//
// The contract matches the confirm dialog: only the folder dies. Its direct
// subfolders and documents step up to the deleted folder's parent first, so
// nothing is ever orphaned into invisibility.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

export const runtime = "nodejs";

function bad(msg: string, status = 400) {
  return NextResponse.json({ error: msg }, { status });
}

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return bad("Unauthorized", 401);
  const { data: { user }, error: authErr } = await supabaseAdmin.auth.getUser(authHeader.slice(7));
  if (authErr || !user) return bad("Unauthorized", 401);

  let body: { orgId?: string; collectionId?: string };
  try { body = await req.json(); } catch { return bad("Invalid JSON body"); }
  const orgId = String(body.orgId ?? "").trim();
  const collectionId = String(body.collectionId ?? "").trim();
  if (!orgId || !collectionId) return bad("orgId and collectionId are required");

  // Same roles the RLS delete policy names.
  const { data: member } = await supabaseAdmin
    .from("org_members").select("role").eq("org_id", orgId).eq("uid", user.id)
    .eq("status", "active").maybeSingle();
  if (!member || !["Admin", "DocCtrl"].includes(String(member.role))) {
    return bad("Only Admins and Document Controllers can delete folders.", 403);
  }

  const { data: node } = await supabaseAdmin
    .from("collections").select("id, org_id, parent_id, name")
    .eq("id", collectionId).eq("org_id", orgId).maybeSingle();
  if (!node) return bad("Folder not found.", 404);
  const heirParent = (node.parent_id as string | null) ?? null;

  // Contents step UP, then the folder goes. Order matters: if the delete
  // ran first, a cascade or FK could take the contents with it.
  const { error: childErr } = await supabaseAdmin
    .from("collections").update({ parent_id: heirParent }).eq("parent_id", collectionId);
  if (childErr) return bad(`Couldn't move subfolders out: ${childErr.message}`, 500);
  const { error: docErr } = await supabaseAdmin
    .from("documents").update({ collection_id: heirParent }).eq("collection_id", collectionId);
  if (docErr) return bad(`Couldn't move documents out: ${docErr.message}`, 500);
  const { error: delErr } = await supabaseAdmin
    .from("collections").delete().eq("id", collectionId);
  if (delErr) return bad(`Couldn't delete the folder: ${delErr.message}`, 500);

  await supabaseAdmin.from("audit_log").insert({
    action: "FOLDER_DELETED",
    resource_type: "collection", resource_id: collectionId,
    org_id: orgId, user_id: user.id,
    details: { name: node.name, contentsMovedTo: heirParent },
  }).then(() => undefined, () => undefined);

  return NextResponse.json({ ok: true, contentsMovedTo: heirParent });
}
