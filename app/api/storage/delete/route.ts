import { NextRequest, NextResponse } from "next/server";
import { DeleteObjectCommand } from "@aws-sdk/client-s3";
import { r2, R2_BUCKET } from "@/lib/r2";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { assertSafeStorageKey } from "@/lib/storageKey";

// Deleting a stored object destroys the bytes of a controlled record and is
// irreversible. This route is held to the same bar as /api/admin/purge:
//   - the caller must be a CONTROLLER (Admin/DocCtrl) of the key's org, read
//     additively (role OR roles[]) so a ['Manager','DocCtrl'] member is not
//     wrongly refused (the headline-only read is SURF-10);
//   - the key is traversal-checked (assertSafeStorageKey), as the download
//     route already does;
//   - a key belonging to a document under legal hold or an unreleased hold is
//     refused, FAIL CLOSED — the opposite of the download route's fail-open,
//     because destruction cannot be undone by a later correct read;
//   - every deletion writes an audit row.
// (Audit finding SURF-2 / document-control RET-2 / intelligence DACL-2.)

const CONTROLLER_ROLES = new Set(["Admin", "DocCtrl"]);

export async function DELETE(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const token = authHeader.slice(7);
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { path } = await req.json() as { path: string };
  if (!path) {
    return NextResponse.json({ error: "path is required" }, { status: 400 });
  }
  // Refuse traversal / control-byte keys before the org-prefix gate reasons
  // about them (mirrors download-url; closes the key that authorizes against
  // one prefix while naming another).
  try { assertSafeStorageKey(path); } catch { return NextResponse.json({ error: "Invalid path" }, { status: 400 }); }

  // Require the orgs/<uuid>/ prefix. A non-org-prefixed key previously skipped
  // authorization entirely — every object the app mints is orgs/<uuid>/…, so
  // nothing legitimate depended on that branch.
  const orgMatch = path.match(/^orgs\/([0-9a-fA-F-]{36})\//);
  if (!orgMatch) {
    return NextResponse.json({ error: "Only org-scoped keys may be deleted" }, { status: 403 });
  }
  const orgId = orgMatch[1];

  // Controller authority for the key's org, read additively.
  const { data: member } = await supabaseAdmin
    .from("org_members")
    .select("role, roles")
    .eq("org_id", orgId)
    .eq("uid", user.id)
    .eq("status", "active")
    .maybeSingle();
  if (!member) {
    return NextResponse.json({ error: "Not a member of this workspace" }, { status: 403 });
  }
  const held = new Set<string>([
    (member.role as string) || "",
    ...(((member.roles as string[] | null) ?? [])),
  ]);
  const isController = [...held].some((r) => CONTROLLER_ROLES.has(r));
  if (!isController) {
    return NextResponse.json({ error: "Deleting stored files requires Admin or Document Control." }, { status: 403 });
  }

  // Legal-hold / active-hold refusal, FAIL CLOSED. Resolve the key to its
  // document; if it is under a legal hold or has an unreleased document_holds
  // row, refuse. Any lookup error refuses — never destroy bytes we cannot
  // clear.
  let documentId: string | null = null;
  let versionId: string | null = null;
  try {
    const { data: ver, error: verErr } = await supabaseAdmin
      .from("document_versions")
      .select("id, record_id")
      .eq("file_url", path)
      .limit(1)
      .maybeSingle();
    if (verErr) throw verErr;
    if (ver?.record_id) {
      versionId = (ver.id as string) ?? null;
      documentId = ver.record_id as string;
      const [{ data: doc, error: docErr }, { data: holds, error: holdErr }] = await Promise.all([
        supabaseAdmin.from("documents").select("legal_hold").eq("id", documentId).maybeSingle(),
        supabaseAdmin.from("document_holds").select("id").eq("document_id", documentId).is("released_at", null).limit(1),
      ]);
      if (docErr) throw docErr;
      if (holdErr) throw holdErr;
      if ((doc as { legal_hold?: boolean } | null)?.legal_hold) {
        return NextResponse.json({ error: "This document is under legal hold; its files cannot be deleted." }, { status: 423 });
      }
      if ((holds ?? []).length > 0) {
        return NextResponse.json({ error: "This document has an active hold; release it before deleting files." }, { status: 423 });
      }
    }
  } catch {
    return NextResponse.json({ error: "Could not verify hold status; deletion refused." }, { status: 503 });
  }

  // Chain of custody BEFORE destruction, and FAIL CLOSED on it — the same
  // posture as the hold check above. Written after the delete, a DB hiccup in
  // that gap would leave bytes destroyed with no custody record and a 200
  // (postgrest-js resolves failures into { error } rather than throwing, so a
  // try/catch alone would be dead code and the error invisible). Refusing the
  // delete when the record cannot be written is recoverable; the reverse is
  // not.
  const { data: auditRow, error: auditErr } = await supabaseAdmin
    .from("audit_logs")
    .insert({
      action: "STORAGE_OBJECT_DELETE",
      resource_type: "storage_object",
      resource_id: documentId ?? path,
      org_id: orgId,
      user_id: user.id,
      user_email: user.email ?? null,
      details: { path, documentId, versionId },
    })
    .select("id")
    .maybeSingle();
  if (auditErr) {
    console.error("storage/delete: audit insert failed; deletion refused", { path, orgId, error: auditErr.message });
    return NextResponse.json({ error: "Could not record the deletion; nothing was deleted." }, { status: 503 });
  }

  try {
    await r2.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: path }));
  } catch (e) {
    // The object may still exist — mark the custody row so it never reads as
    // a completed destruction. Best-effort: the failure response stands
    // either way.
    if (auditRow?.id) {
      await supabaseAdmin
        .from("audit_logs")
        .update({ details: { path, documentId, versionId, failed: true, error: (e as Error).message } })
        .eq("id", auditRow.id);
    }
    return NextResponse.json({ error: "Storage deletion failed; the object was not removed." }, { status: 502 });
  }

  return NextResponse.json({ ok: true });
}
