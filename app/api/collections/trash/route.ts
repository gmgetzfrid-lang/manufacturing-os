// /api/collections/trash — the folder 30-day delete hold.
//
// GET  ?orgId&libraryId  → the library's trashed folders (controllers only)
// POST { orgId, collectionId } → restore one (controllers only)
//
// Deleting a folder steps its contents up and soft-deletes the emptied
// shell (see /api/collections/delete). Restore brings the shell back at its
// old spot — or the library root if the old parent has since vanished or is
// itself in the trash — and (RET-10) returns the documents the delete stepped
// up, if they are still where it left them, re-clocking their retention
// against the restored folder's policy so a deadline the delete nulled comes
// back with the folder. The maintenance cron purges shells 30 days after
// deletion.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { loadPrincipal } from "@/lib/knowledgeAccess";
import {
  loadDestinationPolicies,
  reclockRetentionForDocs,
  RETENTION_DOC_COLUMNS,
  type RetentionDocRow,
} from "@/lib/serverRetention";
import type { RetentionPolicy } from "@/types/schema";

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
    .select("id, name, path_names, deleted_at")
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
  const folders = (data ?? []).map((r) => {
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
    .from("collections").select("id, org_id, library_id, parent_id, name, deleted_at, retention_policy")
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

  // RET-10: bring the stepped-up documents home and re-clock them. The delete
  // recorded which documents it moved and where (FOLDER_DELETED audit detail);
  // only records STILL sitting where the delete left them are moved back —
  // anything a person has since moved on purpose stays put.
  const returned = await returnSteppedUpDocuments(orgId, collectionId, node.library_id as string,
    (node.retention_policy as RetentionPolicy | null) ?? null);

  await supabaseAdmin.from("audit_logs").insert({
    action: "FOLDER_RESTORED",
    resource_type: "collection", resource_id: collectionId,
    org_id: orgId, user_id: auth.user.id, user_email: auth.user.email ?? null,
    details: { name: node.name, restoredToParent: parentId, ...returned },
  }).then(() => undefined, () => undefined);

  return NextResponse.json({ ok: true, restoredToParent: parentId, ...returned });
}

async function returnSteppedUpDocuments(
  orgId: string, collectionId: string, libraryId: string, folderPolicy: RetentionPolicy | null,
): Promise<{ documentsReturned: number; retentionRecomputed: number; retentionFailed: number; note?: string }> {
  const none = { documentsReturned: 0, retentionRecomputed: 0, retentionFailed: 0 };
  const { data: logs, error: logErr } = await supabaseAdmin
    .from("audit_logs").select("details")
    .eq("org_id", orgId).eq("action", "FOLDER_DELETED").eq("resource_id", collectionId)
    .order("timestamp", { ascending: false }).limit(1);
  if (logErr) return { ...none, note: `The delete record could not be read (${logErr.message}); the folder's former contents were left where the delete moved them.` };
  const details = ((logs ?? [])[0] as { details?: Record<string, unknown> } | undefined)?.details;
  const ids = Array.isArray(details?.steppedDocIds) ? (details!.steppedDocIds as unknown[]).filter((x): x is string => typeof x === "string") : [];
  if (ids.length === 0) return { ...none, note: "No record of which documents the delete stepped up; its former contents were left where the delete moved them." };
  const heir = typeof details?.contentsMovedTo === "string" ? (details!.contentsMovedTo as string) : null;

  const moved: RetentionDocRow[] = [];
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    let q = supabaseAdmin.from("documents").update({ collection_id: collectionId })
      .in("id", chunk).eq("org_id", orgId).eq("library_id", libraryId);
    q = heir ? q.eq("collection_id", heir) : q.is("collection_id", null);
    const { data, error } = await q.select(RETENTION_DOC_COLUMNS);
    if (error) return { ...none, documentsReturned: moved.length, note: `Returning the folder's documents failed part-way (${error.message}).` };
    moved.push(...((data ?? []) as RetentionDocRow[]));
  }
  if (moved.length === 0) return none;
  const { libPolicy } = await loadDestinationPolicies(supabaseAdmin, libraryId, null);
  const reclock = await reclockRetentionForDocs(supabaseAdmin, moved, folderPolicy, libPolicy);
  return {
    documentsReturned: moved.length,
    retentionRecomputed: reclock.updated,
    retentionFailed: reclock.failed,
    ...(reclock.firstError ? { note: `Re-clocking retention failed for ${reclock.failed} record(s): ${reclock.firstError}` } : {}),
  };
}
