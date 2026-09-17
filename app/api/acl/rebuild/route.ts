// POST /api/acl/rebuild — OWN-20: recompute one library subtree's `acl_index`.
//
// `acl_index` is chain-resolved when a node is WRITTEN, so a library's (or a
// folder's) ACL change leaves every descendant's stored index describing the
// old chain until the nightly rebuild (DEC-10). The permission drawer calls
// this right after a successful library / folder save; the rebuild is the
// SAME code path the cron runs (lib/aclIndexRebuild.ts), narrowed to the one
// library, with its diff guard — only nodes whose recomputed index differs
// are written, so a repeat call is a no-op.
//
// Authority: the SAME authority the drawer needed to save the node whose ACL
// changed (the caller has just performed such a save) — a controller (by the
// role COLLECTION), the node's effective owner (folder owner → library owner
// → the owning team's supervisor), or a managePermissions grant on the node's
// ACL chain (DEL-1). Membership alone is not enough: the recompute is a full
// subtree read and write under the service role, and "any member, any
// library, in a loop" is a cheap way to load the database from a Viewer
// session. The caller's session token is verified; the recompute itself runs
// as the service role because descendants may be rows the caller cannot read.
// Counts only come back — never rows.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { loadPrincipal, type KnowledgePrincipal } from "@/lib/knowledgeAccess";
import { rebuildAclIndexes } from "@/lib/aclIndexRebuild";
import { canWithAclChain, type Principal } from "@/lib/permissions";
import { resolveEffectiveOwner, type TeamSupervisorLookup } from "@/lib/ownership";
import type { AccessControl } from "@/types/schema";

export const runtime = "nodejs";

function bad(msg: string, status = 400) {
  return NextResponse.json({ error: msg }, { status });
}

type LibRow = { id: string; org_id: string; acl: AccessControl | null; owner_user_id: string | null; owner_team_id: string | null };
type FolderRow = { id: string; library_id: string; path_ids: string[] | null; acl: AccessControl | null; owner_user_id: string | null };

/** Controller, the node's EFFECTIVE owner, or a managePermissions grant on
 *  the node's ACL chain — the drawer's own save authority. The owner rung is
 *  the ONE chain (OWN-16: resolveEffectiveOwner with the team lookup and
 *  GAP-5 active-member gating, read as the service role). Fails closed when
 *  the chain cannot be read. */
async function hasRebuildAuthority(p: KnowledgePrincipal, lib: LibRow, folder: FolderRow | null): Promise<boolean> {
  if (p.isController) return true;
  const teamId = lib.owner_team_id ?? null;
  const { data: team } = teamId
    ? await supabaseAdmin.from("teams").select("supervisor_user_id").eq("id", teamId).maybeSingle()
    : { data: null };
  const sup = (team as { supervisor_user_id?: string | null } | null)?.supervisor_user_id ?? null;
  const teams: TeamSupervisorLookup | null = teamId ? new Map([[teamId, { userId: sup }]]) : null;
  const candidates = [folder?.owner_user_id, lib.owner_user_id, sup].filter((u): u is string => !!u);
  const { data: active } = candidates.length
    ? await supabaseAdmin.from("org_members").select("uid").eq("org_id", p.orgId).eq("status", "active").in("uid", candidates)
    : { data: [] as Array<{ uid: string }> };
  const activeUids = new Set((active ?? []).map((r) => (r as { uid: string }).uid));
  const eff = resolveEffectiveOwner(
    null,
    folder ? { owner_user_id: folder.owner_user_id } : null,
    { owner_user_id: lib.owner_user_id, owner_team_id: teamId },
    activeUids,
    teams,
  );
  if (eff.userId && eff.userId === p.uid) return true;
  const chain: Array<AccessControl | undefined> = [lib.acl ?? undefined];
  if (folder) {
    const ancestorIds = folder.path_ids ?? [];
    if (ancestorIds.length) {
      const { data: ancs, error } = await supabaseAdmin.from("collections").select("id, acl").in("id", ancestorIds);
      if (error) return false;
      const byId = new Map((ancs ?? []).map((a) => [(a as { id: string }).id, ((a as { acl: AccessControl | null }).acl ?? undefined)]));
      for (const id of ancestorIds) chain.push(byId.get(id));
    }
    chain.push(folder.acl ?? undefined);
  }
  const principal: Principal = { uid: p.uid, role: p.role, roles: p.roles, orgId: p.orgId, teamIds: p.teamIds, isActiveMember: true };
  return canWithAclChain({ principal, action: "managePermissions", aclChain: chain, defaultAllow: false });
}

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return bad("Unauthorized", 401);
  const { data: { user }, error: authErr } = await supabaseAdmin.auth.getUser(authHeader.slice(7));
  if (authErr || !user) return bad("Unauthorized", 401);

  let body: { orgId?: unknown; libraryId?: unknown; collectionId?: unknown };
  try { body = await req.json(); } catch { return bad("Invalid JSON body"); }
  const orgId = String(body.orgId ?? "").trim();
  const libraryId = String(body.libraryId ?? "").trim();
  const collectionId = String(body.collectionId ?? "").trim() || null;
  if (!orgId || !libraryId) return bad("orgId and libraryId are required");

  const principal = await loadPrincipal(orgId, user.id);
  if (!principal) return bad("Not a member of this organization.", 403);

  const { data: lib, error: libErr } = await supabaseAdmin
    .from("libraries").select("id, org_id, acl, owner_user_id, owner_team_id").eq("id", libraryId).maybeSingle();
  if (libErr) return bad(`Couldn't load the library: ${libErr.message}`, 500);
  if (!lib || (lib as { org_id?: string }).org_id !== orgId) return bad("Library not found.", 404);

  let folder: FolderRow | null = null;
  if (collectionId) {
    const { data: f, error: fErr } = await supabaseAdmin
      .from("collections").select("id, library_id, path_ids, acl, owner_user_id").eq("id", collectionId).maybeSingle();
    if (fErr) return bad(`Couldn't load the folder: ${fErr.message}`, 500);
    if (!f || (f as { library_id?: string }).library_id !== libraryId) return bad("Folder not found in this library.", 404);
    folder = f as FolderRow;
  }

  if (!(await hasRebuildAuthority(principal, lib as LibRow, folder))) {
    return bad("Re-indexing a library takes the authority to change its permissions: a controller, the owner, or a permissions grant on it.", 403);
  }

  const counts = await rebuildAclIndexes(supabaseAdmin, Date.now(), { orgId, libraryId });
  return NextResponse.json({
    ok: counts.errors.length === 0,
    rebuilt: { libraries: counts.libraries, folders: counts.folders, documents: counts.documents, sets: counts.sets },
    errors: counts.errors,
  });
}
