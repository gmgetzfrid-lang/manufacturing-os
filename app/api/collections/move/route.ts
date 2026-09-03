// /api/collections/move — folder (and whole subtree) relocation, server-side.
//
// The client-side version issued one anon-key UPDATE per descendant with no
// real authority check (collections has no restrictive UPDATE policy, so any
// active member could re-parent folders via raw PostgREST). This route puts
// the move behind the controller bar — checked against the ADDITIVE role
// model (role OR roles[]), same as SQL is_org_controller() — and rebuilds
// the denormalized paths for the entire subtree from the live parent_id
// tree, which also self-heals any stale path_ids left by older moves.
//
// Guards preserved from the client implementation:
//   * a folder can't move into itself,
//   * or into another library,
//   * or into its own subtree (the "my folder vanished" orphan bug).

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { loadPrincipal } from "@/lib/knowledgeAccess";
import { loadCollectionTree, rebuildSubtreePaths, rebuildSubtreeAclIndex, type CollectionTreeRow } from "@/lib/serverCollections";
import type { AccessControl } from "@/types/schema";

export const runtime = "nodejs";

function bad(msg: string, status = 400) {
  return NextResponse.json({ error: msg }, { status });
}

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return bad("Unauthorized", 401);
  const { data: { user }, error: authErr } = await supabaseAdmin.auth.getUser(authHeader.slice(7));
  if (authErr || !user) return bad("Unauthorized", 401);

  let body: { orgId?: string; collectionId?: string; newParentId?: string | null };
  try { body = await req.json(); } catch { return bad("Invalid JSON body"); }
  const orgId = String(body.orgId ?? "").trim();
  const collectionId = String(body.collectionId ?? "").trim();
  const newParentId = body.newParentId ? String(body.newParentId) : null;
  if (!orgId || !collectionId) return bad("orgId and collectionId are required");
  if (newParentId === collectionId) return bad("A folder can't be moved into itself.");

  const principal = await loadPrincipal(orgId, user.id);
  if (!principal) return bad("Not a member of this organization.", 403);
  if (!principal.isController) {
    return bad("Only Admins and Document Controllers can move folders.", 403);
  }

  const { data: nodeRow, error: nodeErr } = await supabaseAdmin
    .from("collections").select("id, org_id, library_id, parent_id, name")
    .eq("id", collectionId).maybeSingle();
  if (nodeErr) return bad(`Couldn't load the folder: ${nodeErr.message}`, 500);
  if (!nodeRow || nodeRow.org_id !== orgId) return bad("Folder not found.", 404);
  const libraryId = nodeRow.library_id as string;

  // The whole library's folder tree in one read — the subtree walk, cycle
  // guard, and path rebuild all come from this single consistent snapshot.
  let tree;
  try { tree = await loadCollectionTree(supabaseAdmin, libraryId); }
  catch (e) { return bad((e as Error).message, 500); }

  if (newParentId) {
    const parent = tree.byId.get(newParentId);
    if (!parent) return bad("Destination folder not found in this library.", 404);
    // Walk the destination's ancestry — landing inside the moved folder's own
    // subtree would detach the whole branch from the root.
    let cursor: CollectionTreeRow | undefined = parent;
    for (let hops = 0; cursor && hops < 200; hops++) {
      if (cursor.id === collectionId) {
        return bad("That folder is inside this one — moving it there would orphan both.");
      }
      cursor = cursor.parent_id ? tree.byId.get(cursor.parent_id) : undefined;
    }
  }

  // Write the new parent, then re-parent in memory and rebuild every denorm
  // path in the subtree from the live tree.
  const { error: moveErr } = await supabaseAdmin
    .from("collections").update({ parent_id: newParentId }).eq("id", collectionId);
  if (moveErr) return bad(`Couldn't move the folder: ${moveErr.message}`, 500);
  const nodeInTree = tree.byId.get(collectionId);
  if (nodeInTree) nodeInTree.parent_id = newParentId;

  // The re-parent above is already committed — from here on the move
  // HAPPENED. A path-rebuild failure must not masquerade as a failed move
  // (the folder would "error" yet visibly relocate), and the audit entry
  // must be written either way: the paths are display denorms; parent_id
  // is the truth and the next server-side move/rename self-heals them.
  let subtreeSize = 0;
  let pathError: string | null = null;
  try { subtreeSize = await rebuildSubtreePaths(supabaseAdmin, tree, [collectionId]); }
  catch (e) { pathError = (e as Error).message; }

  // DOCACL-4: the inherited grants of the whole subtree just changed — rewrite
  // acl_index (folders AND their documents) from the live chain now, not at
  // the next nightly rebuild. Also loud-but-not-fatal: the move happened.
  let aclCounts: { folders: number; documents: number } | null = null;
  let aclError: string | null = null;
  try {
    const { data: lib } = await supabaseAdmin.from("libraries").select("acl").eq("id", libraryId).maybeSingle();
    aclCounts = await rebuildSubtreeAclIndex(supabaseAdmin, tree, (lib?.acl as AccessControl | null) ?? null, [collectionId], Date.now());
  } catch (e) { aclError = (e as Error).message; }

  await supabaseAdmin.from("audit_logs").insert({
    action: "FOLDER_MOVED",
    resource_type: "collection", resource_id: collectionId,
    org_id: orgId, user_id: user.id, user_email: user.email ?? null,
    details: {
      name: nodeRow.name, newParentId, subtreeSize,
      ...(aclCounts ? { aclIndexRewritten: aclCounts } : {}),
      ...(pathError ? { pathRebuildError: pathError } : {}),
      ...(aclError ? { aclIndexError: aclError } : {}),
    },
  }).then(() => undefined, () => undefined);

  const warnings: string[] = [];
  if (pathError) warnings.push(`breadcrumb paths for its subtree couldn't all be rewritten (${pathError}) — they self-correct on the next move or rename`);
  if (aclError) warnings.push(`inherited permissions for its subtree couldn't all be re-indexed (${aclError}) — the nightly rebuild will repair them; until then the old inheritance is enforced`);
  return NextResponse.json({
    ok: true,
    subtreeSize,
    ...(aclCounts ? { aclIndexRewritten: aclCounts } : {}),
    ...(warnings.length ? { warning: `The folder moved, but ${warnings.join("; ")}.` } : {}),
  });
}
