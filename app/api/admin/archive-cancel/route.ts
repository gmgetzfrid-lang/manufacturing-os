// /api/admin/archive-cancel — abandon a produced-but-not-committed archive.
//
// POST { orgId, archiveId } → clears archive_id on every row LINKED to that
// archive that hasn't been committed yet (archived_at IS NULL), for both the
// ticket shed and the document shed, and removes the catalog entry if nothing
// was ever committed under it.
//
// WHY: produce stamps archive_id before the admin commits. If they never commit
// (closed the tab, lost the download, changed their mind), those rows keep
// archive_id set and are excluded from future produce — stranded, un-archivable,
// invisible. This is the operator's recovery handle: it makes a produce safely
// revocable. It never touches committed stubs (archived_at set), so it can't undo
// a real archive. Admin/DocCtrl only.

import { NextRequest, NextResponse } from "next/server";
import { authorizeOrgRole } from "@/lib/serverAuth";

export const runtime = "nodejs";

const SHED_ROLES = ["Admin", "DocCtrl"];

export async function POST(req: NextRequest) {
  let body: { orgId?: string; archiveId?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const orgId = body.orgId || "";
  const archiveId = (body.archiveId || "").trim();
  const actor = await authorizeOrgRole(req, orgId, SHED_ROLES);
  if ("error" in actor) return NextResponse.json({ error: actor.error }, { status: actor.status });
  if (!archiveId) return NextResponse.json({ error: "archiveId is required" }, { status: 400 });
  const sb = actor.admin;

  // Unlink only the UNCOMMITTED rows; .select() tells us how many we freed.
  const { data: t } = await sb
    .from("tickets")
    .update({ archive_id: null })
    .eq("org_id", orgId).eq("archive_id", archiveId).is("archived_at", null)
    .select("id");
  const { data: d } = await sb
    .from("document_versions")
    .update({ archive_id: null })
    .eq("org_id", orgId).eq("archive_id", archiveId).is("archived_at", null)
    .select("id");
  const ticketsUnlinked = (t as Array<{ id: string }> | null)?.length ?? 0;
  const versionsUnlinked = (d as Array<{ id: string }> | null)?.length ?? 0;

  // Was anything ever COMMITTED under this archive? If not, it was a fully
  // abandoned produce — drop its catalog row too. If yes, leave the catalog (it's
  // a real archive that holds committed stubs).
  const { count: committed } = await sb
    .from("tickets")
    .select("id", { count: "exact", head: true })
    .eq("org_id", orgId).eq("archive_id", archiveId).not("archived_at", "is", null);
  const { count: committedDocs } = await sb
    .from("document_versions")
    .select("id", { count: "exact", head: true })
    .eq("org_id", orgId).eq("archive_id", archiveId).not("archived_at", "is", null);
  let catalogRemoved = false;
  if ((committed ?? 0) === 0 && (committedDocs ?? 0) === 0) {
    await sb.from("archives").delete().eq("org_id", orgId).eq("archive_id", archiveId);
    catalogRemoved = true;
  }

  try {
    await sb.from("audit_logs").insert({
      action: "ARCHIVE_PRODUCE_CANCELED",
      resource_id: orgId, resource_type: "org", org_id: orgId,
      user_id: actor.userId, user_email: actor.email,
      details: { archiveId, ticketsUnlinked, versionsUnlinked, catalogRemoved },
    });
  } catch { /* best-effort */ }

  return NextResponse.json({ ok: true, archiveId, ticketsUnlinked, versionsUnlinked, catalogRemoved });
}
