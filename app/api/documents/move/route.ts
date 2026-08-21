// /api/documents/move — bulk document relocation, server-side.
//
// Moves used to be raw client-side PostgREST updates guarded only by UI
// affordances. This route gives the gesture (drag-drop, Move to…, context
// menu) a real authority check and finishes the bookkeeping a move
// actually requires:
//
//   1. Authority: Admin/DocCtrl — checked against the ADDITIVE role model
//      (role OR roles[]), the same bar as the SQL is_org_controller().
//   2. Integrity: every doc and the target folder must belong to the same
//      org AND the same library (cross-library moves change ACL chains,
//      numbering and knowledge scope — not supported here).
//   3. Retention: retention policy inherits doc → folder → library, and
//      retention_until is MATERIALIZED — so a move re-clocks every moved
//      doc against the destination's effective policy.
//   4. Audit: one DOCS_MOVED entry with the count and destination.
//
// Knowledge-source scope: the client fires nudgeKnowledgeSources after this
// returns (same library on both ends, so one nudge covers it); the sync
// cron remains the backstop.

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

const MAX_DOCS_PER_MOVE = 500;

function bad(msg: string, status = 400) {
  return NextResponse.json({ error: msg }, { status });
}

type MovedDocRow = RetentionDocRow & { org_id: string; library_id: string };

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return bad("Unauthorized", 401);
  const { data: { user }, error: authErr } = await supabaseAdmin.auth.getUser(authHeader.slice(7));
  if (authErr || !user) return bad("Unauthorized", 401);

  let body: { orgId?: string; docIds?: unknown; targetFolderId?: string | null };
  try { body = await req.json(); } catch { return bad("Invalid JSON body"); }
  const orgId = String(body.orgId ?? "").trim();
  const docIds = Array.isArray(body.docIds)
    ? (body.docIds as unknown[]).map((x) => String(x)).filter(Boolean)
    : [];
  const targetFolderId = body.targetFolderId ? String(body.targetFolderId) : null;
  if (!orgId || docIds.length === 0) return bad("orgId and docIds are required");
  if (docIds.length > MAX_DOCS_PER_MOVE) {
    return bad(`Move up to ${MAX_DOCS_PER_MOVE} documents at a time (got ${docIds.length}).`);
  }

  const principal = await loadPrincipal(orgId, user.id);
  if (!principal) return bad("Not a member of this organization.", 403);
  if (!principal.isController) {
    return bad("Only Admins and Document Controllers can move documents.", 403);
  }

  const { data: docRows, error: docsErr } = await supabaseAdmin
    .from("documents")
    .select(`org_id, library_id, ${RETENTION_DOC_COLUMNS}`)
    .in("id", docIds);
  if (docsErr) return bad(`Couldn't load the documents: ${docsErr.message}`, 500);
  const docs = (docRows ?? []) as MovedDocRow[];
  if (docs.length !== docIds.length) return bad("Some of those documents no longer exist.", 404);
  if (docs.some((d) => d.org_id !== orgId)) return bad("Documents outside this organization.", 403);
  const libraryIds = new Set(docs.map((d) => d.library_id));
  if (libraryIds.size !== 1) return bad("All documents must belong to one library.");
  const libraryId = docs[0].library_id;

  // Destination: a folder in the SAME library, or null = library root.
  let folderPolicy: RetentionPolicy | null = null;
  if (targetFolderId) {
    const { data: folder, error: folderErr } = await supabaseAdmin
      .from("collections")
      .select("id, org_id, library_id, retention_policy")
      .eq("id", targetFolderId).maybeSingle();
    if (folderErr) return bad(`Couldn't load the destination folder: ${folderErr.message}`, 500);
    if (!folder || folder.org_id !== orgId) return bad("Destination folder not found.", 404);
    if (folder.library_id !== libraryId) {
      return bad("The destination folder is in a different library. Moves stay within one library.");
    }
    folderPolicy = (folder.retention_policy as RetentionPolicy | null) ?? null;
  }

  // Deliberately NOT bumping updated_at: a relocation isn't a content
  // change, and several retention bases ("issued"/"superseded") clock from
  // updated_at — bumping it here would silently extend those clocks by the
  // age of the record on every move.
  const { error: moveErr } = await supabaseAdmin
    .from("documents")
    .update({ collection_id: targetFolderId, updated_by: user.id })
    .in("id", docIds);
  if (moveErr) return bad(`Couldn't move the documents: ${moveErr.message}`, 500);

  // Re-clock retention against the destination. One folder + one library
  // policy covers the whole batch (same destination for every doc).
  const { libPolicy } = await loadDestinationPolicies(supabaseAdmin, libraryId, null);
  const reclock = await reclockRetentionForDocs(supabaseAdmin, docs, folderPolicy, libPolicy);

  await supabaseAdmin.from("audit_logs").insert({
    action: "DOCS_MOVED",
    resource_type: "collection", resource_id: targetFolderId ?? libraryId,
    org_id: orgId, user_id: user.id, user_email: user.email ?? null,
    details: {
      count: docIds.length, targetFolderId, libraryId,
      retentionRecomputed: reclock.updated,
      retentionFailed: reclock.failed,
      ...(reclock.firstError ? { retentionError: reclock.firstError } : {}),
    },
  }).then(() => undefined, () => undefined);

  return NextResponse.json({
    ok: true,
    moved: docIds.length,
    retentionRecomputed: reclock.updated,
    retentionFailed: reclock.failed,
    ...(reclock.failed > 0
      ? { warning: `Moved, but ${reclock.failed} retention clock${reclock.failed === 1 ? "" : "s"} couldn't be recomputed (${reclock.firstError ?? "unknown error"}). They'll correct on the next retention pass.` }
      : {}),
  });
}
