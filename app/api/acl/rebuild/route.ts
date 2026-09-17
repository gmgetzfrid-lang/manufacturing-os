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
// Authority: an ACTIVE member of the library's org. The operation takes no
// input beyond "which library": it re-derives stored indexes from stored
// ACLs and can only make them MORE faithful to the rules a controller or
// owner already saved — nothing is exposed (counts only) and no rule changes.
// The caller's session token is verified; the recompute itself runs as the
// service role because descendants may be rows the caller cannot read.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { loadPrincipal } from "@/lib/knowledgeAccess";
import { rebuildAclIndexes } from "@/lib/aclIndexRebuild";

export const runtime = "nodejs";

function bad(msg: string, status = 400) {
  return NextResponse.json({ error: msg }, { status });
}

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return bad("Unauthorized", 401);
  const { data: { user }, error: authErr } = await supabaseAdmin.auth.getUser(authHeader.slice(7));
  if (authErr || !user) return bad("Unauthorized", 401);

  let body: { orgId?: unknown; libraryId?: unknown };
  try { body = await req.json(); } catch { return bad("Invalid JSON body"); }
  const orgId = String(body.orgId ?? "").trim();
  const libraryId = String(body.libraryId ?? "").trim();
  if (!orgId || !libraryId) return bad("orgId and libraryId are required");

  const principal = await loadPrincipal(orgId, user.id);
  if (!principal) return bad("Not a member of this organization.", 403);

  const { data: lib, error: libErr } = await supabaseAdmin
    .from("libraries").select("id, org_id").eq("id", libraryId).maybeSingle();
  if (libErr) return bad(`Couldn't load the library: ${libErr.message}`, 500);
  if (!lib || (lib as { org_id?: string }).org_id !== orgId) return bad("Library not found.", 404);

  const counts = await rebuildAclIndexes(supabaseAdmin, Date.now(), { orgId, libraryId });
  return NextResponse.json({
    ok: counts.errors.length === 0,
    rebuilt: { libraries: counts.libraries, folders: counts.folders, documents: counts.documents, sets: counts.sets },
    errors: counts.errors,
  });
}
