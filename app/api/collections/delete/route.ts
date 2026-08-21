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
import { loadPrincipal } from "@/lib/knowledgeAccess";
import { loadCollectionTree, rebuildSubtreePaths } from "@/lib/serverCollections";

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

  // Same bar as the RLS delete policy — is_org_controller() honors the
  // ADDITIVE role model (role OR roles[]), so a secondary-DocCtrl passes.
  const principal = await loadPrincipal(orgId, user.id);
  if (!principal?.isController) {
    return bad("Only Admins and Document Controllers can delete folders.", 403);
  }

  const { data: node } = await supabaseAdmin
    .from("collections").select("id, org_id, library_id, parent_id, name, path_names, path_ids")
    .eq("id", collectionId).eq("org_id", orgId).maybeSingle();
  if (!node) return bad("Folder not found.", 404);
  const heirParent = (node.parent_id as string | null) ?? null;

  // Contents step UP, then the folder goes. Order matters: if the delete
  // ran first, a cascade or FK could take the contents with it.
  const { data: steppedUp, error: childErr } = await supabaseAdmin
    .from("collections").update({ parent_id: heirParent }).eq("parent_id", collectionId)
    .select("id, name");
  if (childErr) return bad(`Couldn't move subfolders out: ${childErr.message}`, 500);
  const { error: docErr } = await supabaseAdmin
    .from("documents").update({ collection_id: heirParent }).eq("collection_id", collectionId);
  if (docErr) return bad(`Couldn't move documents out: ${docErr.message}`, 500);
  const { error: delErr } = await supabaseAdmin
    .from("collections").delete().eq("id", collectionId);
  if (delErr) return bad(`Couldn't delete the folder: ${delErr.message}`, 500);

  // The stepped-up subfolders (and their subtrees) now carry stale
  // denormalized paths that still include the deleted folder — rebuild them
  // from the live tree so breadcrumbs and pickers stay truthful.
  const heirs = ((steppedUp ?? []) as Array<{ id: string }>).map((r) => r.id);
  if (heirs.length) {
    try {
      const tree = await loadCollectionTree(supabaseAdmin, node.library_id as string);
      await rebuildSubtreePaths(supabaseAdmin, tree, heirs);
    } catch {
      // Path denorms are display-only; the parent_id tree is already correct
      // and the next server-side move/rename of the branch self-heals them.
    }
  }

  await supabaseAdmin.from("audit_logs").insert({
    action: "FOLDER_DELETED",
    resource_type: "collection", resource_id: collectionId,
    org_id: orgId, user_id: user.id, user_email: user.email ?? null,
    details: { name: node.name, contentsMovedTo: heirParent },
  }).then(() => undefined, () => undefined);

  return NextResponse.json({ ok: true, contentsMovedTo: heirParent });
}
