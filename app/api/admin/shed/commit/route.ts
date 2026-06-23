// /api/admin/shed/commit — the space-saver, step 2 of 2 (irreversible).
//
// POST { orgId, archiveId, confirm } → delete from R2 the binaries that were
// CAPTURED into `archiveId` (archive_id set, archived_at still null), then mark
// those versions archived_at=now. After this, opening one of those revisions
// prompts the user to provide <root>/data/<archiveId>.zip.
//
// Safe by construction: only versions whose bytes were provably bundled into the
// produced archive get linked (archive_id) in step 1, so we never delete a byte
// that isn't already in the admin's saved copy.

import { NextRequest, NextResponse } from "next/server";
import { DeleteObjectsCommand } from "@aws-sdk/client-s3";
import { authorizeOrgRole } from "@/lib/serverAuth";
import { r2, R2_BUCKET } from "@/lib/r2";

export const runtime = "nodejs";

const SHED_ROLES = ["Admin", "DocCtrl"];

export async function POST(req: NextRequest) {
  let body: { orgId?: string; archiveId?: string; confirm?: boolean };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const orgId = body.orgId || "";
  const archiveId = (body.archiveId || "").trim();
  const actor = await authorizeOrgRole(req, orgId, SHED_ROLES);
  if ("error" in actor) return NextResponse.json({ error: actor.error }, { status: actor.status });
  if (!archiveId) return NextResponse.json({ error: "archiveId is required" }, { status: 400 });
  if (body.confirm !== true) {
    return NextResponse.json({ error: "Confirmation required — only reclaim after the archive is safely saved." }, { status: 400 });
  }
  const sb = actor.admin;

  const { data: rows } = await sb
    .from("document_versions")
    .select("id, file_url")
    .eq("org_id", orgId)
    .eq("archive_id", archiveId)
    .is("archived_at", null);
  const versions = ((rows as Array<{ id: string; file_url: string | null }> | null) ?? []).filter((v) => v.file_url);
  if (versions.length === 0) {
    return NextResponse.json({ ok: true, reclaimed: 0, note: "Nothing pending for this archive (already reclaimed?)." });
  }

  // Delete the binaries from R2 in batches (DeleteObjects caps at 1000 keys).
  const keys = versions.map((v) => ({ Key: v.file_url as string }));
  let deletedKeys = 0;
  const errors: string[] = [];
  for (let i = 0; i < keys.length; i += 1000) {
    const batch = keys.slice(i, i + 1000);
    try {
      await r2.send(new DeleteObjectsCommand({ Bucket: R2_BUCKET, Delete: { Objects: batch } }));
      deletedKeys += batch.length;
    } catch (e) {
      errors.push((e as Error).message);
    }
  }

  // Flag the versions as archived (binary now gone). Do this even if some R2
  // deletes failed — the bytes are safe in the saved archive either way, and the
  // flag is what drives the "provide the archive to view" prompt.
  const now = new Date().toISOString();
  for (let i = 0; i < versions.length; i += 200) {
    const chunk = versions.slice(i, i + 200).map((v) => v.id);
    await sb.from("document_versions").update({ archived_at: now }).in("id", chunk).eq("org_id", orgId);
  }

  try {
    await sb.from("audit_logs").insert({
      action: "DATA_ARCHIVE_RECLAIM",
      resource_id: orgId, resource_type: "org", org_id: orgId,
      user_id: actor.userId, user_email: actor.email,
      details: { archiveId, reclaimed: versions.length, keysDeleted: deletedKeys, errors: errors.slice(0, 5) },
    });
  } catch { /* best-effort */ }

  return NextResponse.json({ ok: true, archiveId, reclaimed: versions.length, keysDeleted: deletedKeys, errors });
}
