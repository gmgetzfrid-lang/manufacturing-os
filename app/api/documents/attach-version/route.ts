// /api/documents/attach-version — save a new document's FIRST revision row
// on the server, for when the browser's own insert is refused by the
// database's row rules (e.g. "infinite recursion detected in policy for
// relation document_versions" — a policy loop that turned every upload of a
// 1,100-file folder into a failure).
//
// Deliberately narrow, so it can't become a way around permissions: it only
// attaches the first revision to a document that THE CALLER created, in an
// org they're an active member of, that has no revision yet, pointing at a
// file inside that org's own storage prefix.
//
// POST { orgId, documentId, revisionLabel, fileUrl, fileType, size, fileHash? }
//   → { versionId }

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

export const runtime = "nodejs";

function bad(msg: string, status = 400) {
  return NextResponse.json({ error: msg }, { status });
}

export async function POST(req: NextRequest) {
  const h = req.headers.get("authorization");
  if (!h?.startsWith("Bearer ")) return bad("Unauthorized", 401);
  const { data: { user }, error: authErr } = await supabaseAdmin.auth.getUser(h.slice(7));
  if (authErr || !user) return bad("Unauthorized", 401);

  let b: Record<string, unknown>;
  try { b = await req.json(); } catch { return bad("Invalid JSON body"); }
  const orgId = String(b.orgId ?? "");
  const documentId = String(b.documentId ?? "");
  const fileUrl = String(b.fileUrl ?? "");
  if (!orgId || !documentId || !fileUrl) return bad("orgId, documentId and fileUrl are required");
  if (!fileUrl.startsWith(`orgs/${orgId}/`) || fileUrl.includes("..")) return bad("That file isn't in this organization's storage.", 403);

  const { data: member } = await supabaseAdmin.from("org_members").select("uid")
    .eq("org_id", orgId).eq("uid", user.id).eq("status", "active").maybeSingle();
  if (!member) return bad("Not a member of this organization.", 403);

  const { data: doc } = await supabaseAdmin.from("documents")
    .select("id, org_id, created_by, current_version_id").eq("id", documentId).maybeSingle();
  if (!doc || doc.org_id !== orgId) return bad("Document not found.", 404);
  if (doc.created_by !== user.id) return bad("Only the person who created this document can attach its first file here.", 403);
  if (doc.current_version_id) return bad("This document already has a file.", 409);
  const { count } = await supabaseAdmin.from("document_versions")
    .select("id", { count: "exact", head: true }).eq("record_id", documentId);
  if ((count ?? 0) > 0) return bad("This document already has a revision.", 409);

  const now = new Date().toISOString();
  const { data: ver, error: vErr } = await supabaseAdmin.from("document_versions").insert({
    org_id: orgId,
    record_id: documentId,
    revision_label: String(b.revisionLabel ?? "0").slice(0, 40) || "0",
    file_url: fileUrl,
    file_type: String(b.fileType ?? "application/octet-stream").slice(0, 200),
    size: Number(b.size) || 0,
    file_hash: typeof b.fileHash === "string" && /^[0-9a-f]{64}$/.test(b.fileHash) ? b.fileHash : null,
    created_by: user.id,
    created_by_name: user.email ?? user.id,
    created_at: now,
  }).select("id").single();
  if (vErr || !ver) return bad(`Couldn't save the revision: ${vErr?.message ?? "unknown error"}`, 500);

  const { error: uErr } = await supabaseAdmin.from("documents")
    .update({ current_version_id: ver.id }).eq("id", documentId);
  if (uErr) return bad(`Saved the revision but couldn't link it: ${uErr.message}`, 500);
  return NextResponse.json({ versionId: ver.id });
}
