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

  // Defense-in-depth (do NOT rely on the UI for a destructive op): only commit an
  // archive that PRODUCE actually finished. A produce that crashed mid-bundle left
  // its rows claimed (archive_id set) but never streamed a zip and never finalized
  // its catalog row (note stays "producing…"). Freeing those would delete bytes the
  // admin has no saved copy of. Missing row = discarded/never produced. The recovery
  // path for a stuck produce is /api/admin/archive-cancel, not commit.
  const { data: cat } = await sb
    .from("archives")
    .select("note")
    .eq("org_id", orgId).eq("archive_id", archiveId)
    .maybeSingle();
  if (!cat) {
    return NextResponse.json({ error: "No such archive for this workspace (already discarded, or never produced)." }, { status: 404 });
  }
  if ((cat as { note?: string }).note === "producing…") {
    return NextResponse.json({ error: "That archive never finished producing — re-produce or discard it. Nothing was freed." }, { status: 409 });
  }

  // ALL rows linked to this archive — both not-yet-stamped (first commit) and
  // already-stamped (a re-run after a partial R2 delete failure). Re-running a
  // commit is the recovery path for orphaned bytes: DeleteObjects on a key
  // that's already gone is a no-op success, so retrying every linked key is
  // safe and cleans up whatever a previous partial failure left billing.
  const { data: rows } = await sb
    .from("document_versions")
    .select("id, file_url, archived_at")
    .eq("org_id", orgId)
    .eq("archive_id", archiveId);
  const versions = ((rows as Array<{ id: string; file_url: string | null; archived_at: string | null }> | null) ?? []).filter((v) => v.file_url);
  if (versions.length === 0) {
    return NextResponse.json({ ok: true, reclaimed: 0, keysDeleted: 0, errors: [], note: "Nothing linked to this archive (already discarded?)." });
  }
  const unstamped = versions.filter((v) => !v.archived_at);

  const errors: string[] = [];

  // 1. STAMP archived_at FIRST (fail-closed): the flag is what drives the
  //    "provide the archive to view" prompt, so set it before removing any byte.
  //    Guarded by `archived_at is null` so a concurrent commit can't double-act,
  //    and `.select()` returns exactly the rows THIS call stamped.
  const now = new Date().toISOString();
  const stamped: Array<{ file_url: string | null }> = [];
  for (let i = 0; i < unstamped.length; i += 200) {
    const chunk = unstamped.slice(i, i + 200).map((v) => v.id);
    const { data, error } = await sb
      .from("document_versions")
      .update({ archived_at: now })
      .in("id", chunk)
      .eq("org_id", orgId)
      .is("archived_at", null)
      .select("file_url");
    if (error) errors.push(`stamp[${i}]: ${error.message}`);
    else stamped.push(...((data as Array<{ file_url: string | null }>) ?? []));
  }

  // 2. Now that the flag is durable, delete from R2 every key linked to this
  //    archive — the ones just stamped AND any stamped by an earlier commit
  //    whose delete partially failed. DeleteObjects returns 200 with a per-key
  //    Errors[] on partial failure (it does NOT throw) — count only the keys
  //    that actually deleted.
  const stampedKeys = new Set(stamped.map((s) => s.file_url).filter(Boolean));
  const keys = versions
    .filter((v) => v.archived_at || stampedKeys.has(v.file_url))
    .map((v) => v.file_url).filter(Boolean).map((Key) => ({ Key: Key as string }));
  let deletedKeys = 0;
  for (let i = 0; i < keys.length; i += 1000) {
    const batch = keys.slice(i, i + 1000);
    try {
      const res = await r2.send(new DeleteObjectsCommand({ Bucket: R2_BUCKET, Delete: { Objects: batch } }));
      const failed = res.Errors ?? [];
      deletedKeys += batch.length - failed.length;
      for (const e of failed) errors.push(`R2 ${e.Key}: ${e.Message || e.Code || "delete failed"}`);
    } catch (e) {
      errors.push((e as Error).message);
    }
  }
  const reclaimed = stamped.length;

  try {
    await sb.from("audit_logs").insert({
      action: "DATA_ARCHIVE_RECLAIM",
      resource_id: orgId, resource_type: "org", org_id: orgId,
      user_id: actor.userId, user_email: actor.email,
      details: { archiveId, reclaimed, keysDeleted: deletedKeys, errors: errors.slice(0, 8) },
    });
  } catch { /* best-effort */ }

  return NextResponse.json({ ok: true, archiveId, reclaimed, keysDeleted: deletedKeys, errors });
}
