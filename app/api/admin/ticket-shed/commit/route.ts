// /api/admin/ticket-shed/commit — closed-ticket space-saver, step 2 of 2 (irreversible).
//
// POST { orgId, archiveId, confirm } → for every ticket CAPTURED into `archiveId`
// (archive_id set, archived_at still null): delete its attachment binaries from
// R2, delete its ticket_comments rows, clear the heavy comment/history JSONB on
// the row, and stamp archived_at=now. What's left is a lightweight STUB — number,
// title, status, requester, dates, attachment metadata — that still lists in the
// app. Opening it prompts the user to provide <root>/data/<archiveId>.zip.
//
// Safe by construction: only tickets whose full content was provably bundled into
// the produced archive (archive_id set in step 1) are freed here, so nothing is
// removed that isn't already in the admin's saved copy.

import { NextRequest, NextResponse } from "next/server";
import { DeleteObjectsCommand } from "@aws-sdk/client-s3";
import { authorizeOrgRole } from "@/lib/serverAuth";
import { r2, R2_BUCKET } from "@/lib/r2";
import type { TicketAttachmentLite } from "@/lib/ticketShed";

export const runtime = "nodejs";

const SHED_ROLES = ["Admin", "DocCtrl"];

interface TombstoneSource {
  id: string;
  attachments: TicketAttachmentLite[] | null;
  comments: unknown[] | null;
  history: unknown[] | null;
  metadata: Record<string, unknown> | null;
}

/** A small, queryable snapshot of "what was here" kept on the stub so the
 *  archived ticket can show its shape (counts + attachment names) without the
 *  heavy content. Lives at metadata.archive_summary; removed again on restore.
 *  commentCount comes from the authoritative ticket_comments rows, not the
 *  legacy JSONB, so it can't drift. */
function buildTombstone(row: TombstoneSource, commentCount: number): Record<string, unknown> {
  const atts = Array.isArray(row.attachments) ? row.attachments : [];
  const history = Array.isArray(row.history) ? row.history : [];
  return {
    commentCount,
    attachmentCount: atts.length,
    attachmentNames: atts
      .map((a) => (a as { name?: string } | null)?.name)
      .filter((n): n is string => typeof n === "string")
      .slice(0, 6),
    historyCount: history.length,
    archivedReason: "Long-closed — full content moved to the archive to free storage.",
  };
}

/** Delete R2 keys in batches, reading the per-key Errors[] that DeleteObjects
 *  returns in a 200 response (it does NOT throw on partial failure). Returns the
 *  count actually deleted and a message per failed key so orphaned bytes surface
 *  in the audit log instead of being silently reported as reclaimed. */
async function deleteR2Keys(keys: string[]): Promise<{ deleted: number; errors: string[] }> {
  let deleted = 0;
  const errors: string[] = [];
  for (let i = 0; i < keys.length; i += 1000) {
    const batch = keys.slice(i, i + 1000).map((Key) => ({ Key }));
    try {
      const res = await r2.send(new DeleteObjectsCommand({ Bucket: R2_BUCKET, Delete: { Objects: batch } }));
      const failed = res.Errors ?? [];
      deleted += batch.length - failed.length;
      for (const e of failed) errors.push(`R2 ${e.Key}: ${e.Message || e.Code || "delete failed"}`);
    } catch (e) {
      errors.push((e as Error).message);
    }
  }
  return { deleted, errors };
}

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
    .from("tickets")
    .select("id, attachments, comments, history, metadata")
    .eq("org_id", orgId)
    .eq("archive_id", archiveId)
    .is("archived_at", null);
  const tickets = (rows as Array<TombstoneSource> | null) ?? [];
  if (tickets.length === 0) {
    return NextResponse.json({ ok: true, reclaimedTickets: 0, note: "Nothing pending for this archive (already reclaimed?)." });
  }
  const ids = tickets.map((t) => t.id);
  const errors: string[] = [];

  // Authoritative comment-row counts (the archived source of truth) for the
  // tombstone — gathered BEFORE any delete.
  const commentCountById = new Map<string, number>();
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const { data } = await sb.from("ticket_comments").select("ticket_id").in("ticket_id", chunk);
    for (const r of ((data ?? []) as Array<{ ticket_id: string }>)) {
      commentCountById.set(r.ticket_id, (commentCountById.get(r.ticket_id) ?? 0) + 1);
    }
  }

  // 1. STAMP the stub FIRST (fail-closed): clear the heavy JSONB, write the
  //    tombstone, set archived_at — guarded by `archived_at is null` so a
  //    concurrent commit can't double-free. Only tickets that PROVABLY stamped
  //    (count === 1) proceed to the destructive deletes, so a failed/raced stamp
  //    can never destroy content that still looks un-archived to the UI.
  const now = new Date().toISOString();
  const stampedIds: string[] = [];
  const keysToDelete: string[] = [];
  for (const t of tickets) {
    const metadata = (t.metadata && typeof t.metadata === "object" && !Array.isArray(t.metadata)) ? t.metadata : {};
    const fallbackCount = Array.isArray(t.comments) ? t.comments.length : 0;
    const tombstone = buildTombstone(t, commentCountById.get(t.id) ?? fallbackCount);
    const { error, count } = await sb
      .from("tickets")
      .update(
        { comments: [], history: [], metadata: { ...metadata, archive_summary: tombstone }, archived_at: now, archive_id: archiveId },
        { count: "exact" },
      )
      .eq("id", t.id)
      .eq("org_id", orgId)
      .is("archived_at", null);
    if (error) { errors.push(`stamp ${t.id}: ${error.message}`); continue; }
    if ((count ?? 0) === 0) { errors.push(`stamp ${t.id}: already archived or gone — left untouched`); continue; }
    stampedIds.push(t.id);
    for (const a of (Array.isArray(t.attachments) ? t.attachments : [])) {
      const k = (a?.url || "").toString();
      if (k) keysToDelete.push(k);
    }
  }

  // 2. Now the stub + tombstone are durable, free the heavy content for the
  //    stamped tickets only: delete their comment rows, then their attachment
  //    binaries. A failure here leaves orphaned rows/bytes (recoverable), never a
  //    content-destroyed ticket missing its "provide the archive" prompt.
  for (let i = 0; i < stampedIds.length; i += 200) {
    const chunk = stampedIds.slice(i, i + 200);
    const { error } = await sb.from("ticket_comments").delete().in("ticket_id", chunk).eq("org_id", orgId);
    if (error) errors.push(`comments[${i}]: ${error.message}`);
  }
  const { deleted: keysDeleted, errors: delErrors } = await deleteR2Keys(keysToDelete);
  errors.push(...delErrors);

  const reclaimedTickets = stampedIds.length;
  try {
    await sb.from("audit_logs").insert({
      action: "TICKET_ARCHIVE_RECLAIM",
      resource_id: orgId, resource_type: "org", org_id: orgId,
      user_id: actor.userId, user_email: actor.email,
      details: { archiveId, reclaimedTickets, keysDeleted, errors: errors.slice(0, 8) },
    });
  } catch { /* best-effort */ }

  return NextResponse.json({ ok: true, archiveId, reclaimedTickets, keysDeleted, errors });
}
