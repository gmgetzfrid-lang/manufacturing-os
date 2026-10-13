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
// a real archive. The storage surface's writes set (Admin / DocCtrl), asked of
// lib/adminGate.ts with the "write" intent (roles-and-permissions SURF-19,
// admin-and-org P7).
//
// admin-and-org ALOG-8 (P7): every write is checked. A refused unlink or
// catalog removal answers 500 naming what was already done; the
// ARCHIVE_PRODUCE_CANCELED audit row is checked too — the cancel has happened
// either way, so a row that could not be written is reported in the answer
// (`auditError`) and logged, never a silent success (the purge's rule).

import { NextRequest, NextResponse } from "next/server";
import { authorizeAdminSurface } from "@/lib/adminGate";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  let body: { orgId?: string; archiveId?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const orgId = body.orgId || "";
  const archiveId = (body.archiveId || "").trim();
  const actor = await authorizeAdminSurface(req, orgId, "storage", "write");
  if ("error" in actor) return NextResponse.json({ error: actor.error }, { status: actor.status });
  if (!archiveId) return NextResponse.json({ error: "archiveId is required" }, { status: 400 });
  const sb = actor.admin;

  // Unlink only the UNCOMMITTED rows; .select() tells us how many we freed.
  const { data: t, error: tErr } = await sb
    .from("tickets")
    .update({ archive_id: null })
    .eq("org_id", orgId).eq("archive_id", archiveId).is("archived_at", null)
    .select("id");
  if (tErr) {
    return NextResponse.json({ error: `The archive was not discarded: its tickets could not be unlinked (${tErr.message}). Nothing was changed.` }, { status: 500 });
  }
  const ticketsUnlinked = (t as Array<{ id: string }> | null)?.length ?? 0;
  const { data: d, error: dErr } = await sb
    .from("document_versions")
    .update({ archive_id: null })
    .eq("org_id", orgId).eq("archive_id", archiveId).is("archived_at", null)
    .select("id");
  if (dErr) {
    return NextResponse.json({
      error: `The archive was only partly discarded: ${ticketsUnlinked} ticket(s) were unlinked, but its revisions could not be (${dErr.message}). Run Discard again.`,
      ticketsUnlinked,
    }, { status: 500 });
  }
  const versionsUnlinked = (d as Array<{ id: string }> | null)?.length ?? 0;

  // Was anything ever COMMITTED under this archive? If not, it was a fully
  // abandoned produce — drop its catalog row too. If yes, leave the catalog (it's
  // a real archive that holds committed stubs). A count that cannot be read
  // keeps the catalog row (never drop the record of a real archive on a guess).
  const { count: committed, error: cErr } = await sb
    .from("tickets")
    .select("id", { count: "exact", head: true })
    .eq("org_id", orgId).eq("archive_id", archiveId).not("archived_at", "is", null);
  const { count: committedDocs, error: cdErr } = await sb
    .from("document_versions")
    .select("id", { count: "exact", head: true })
    .eq("org_id", orgId).eq("archive_id", archiveId).not("archived_at", "is", null);
  let catalogRemoved = false;
  let catalogKeptReason: string | null = null;
  if (cErr || cdErr) {
    catalogKeptReason = `whether anything was committed under it could not be read (${(cErr ?? cdErr)!.message})`;
  } else if ((committed ?? 0) === 0 && (committedDocs ?? 0) === 0) {
    const { error: delErr } = await sb.from("archives").delete().eq("org_id", orgId).eq("archive_id", archiveId);
    if (delErr) catalogKeptReason = `its catalog entry could not be removed (${delErr.message})`;
    else catalogRemoved = true;
  }

  let auditError: string | null = null;
  try {
    const { error } = await sb.from("audit_logs").insert({
      action: "ARCHIVE_PRODUCE_CANCELED",
      resource_id: orgId, resource_type: "org", org_id: orgId,
      user_id: actor.userId, user_email: actor.email, user_role: actor.admittedRole,
      details: { archiveId, ticketsUnlinked, versionsUnlinked, catalogRemoved, ...(catalogKeptReason ? { catalogKeptReason } : {}) },
    });
    if (error) auditError = error.message;
  } catch (e) {
    auditError = (e as Error).message || String(e);
  }
  if (auditError) console.error("[admin/archive-cancel] the ARCHIVE_PRODUCE_CANCELED audit row was not written", auditError);

  return NextResponse.json({
    ok: true, archiveId, ticketsUnlinked, versionsUnlinked, catalogRemoved,
    ...(catalogKeptReason ? { catalogKept: `The catalog entry was kept: ${catalogKeptReason}.` } : {}),
    ...(auditError ? { auditError: `the archive was discarded but its ARCHIVE_PRODUCE_CANCELED audit row was not written: ${auditError}` } : {}),
  });
}
