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
 *  heavy content. Lives at metadata.archive_summary; removed again on restore. */
function buildTombstone(row: TombstoneSource): Record<string, unknown> {
  const atts = Array.isArray(row.attachments) ? row.attachments : [];
  const comments = Array.isArray(row.comments) ? row.comments : [];
  const history = Array.isArray(row.history) ? row.history : [];
  return {
    commentCount: comments.length,
    attachmentCount: atts.length,
    attachmentNames: atts
      .map((a) => (a as { name?: string } | null)?.name)
      .filter((n): n is string => typeof n === "string")
      .slice(0, 6),
    historyCount: history.length,
    archivedReason: "Long-closed — full content moved to the archive to free storage.",
  };
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

  // 1. Delete attachment binaries from R2 (DeleteObjects caps at 1000 keys).
  const keys = tickets
    .flatMap((t) => (Array.isArray(t.attachments) ? t.attachments : []))
    .map((a) => (a?.url || "").toString())
    .filter(Boolean)
    .map((Key) => ({ Key }));
  let keysDeleted = 0;
  const errors: string[] = [];
  for (let i = 0; i < keys.length; i += 1000) {
    const batch = keys.slice(i, i + 1000);
    try {
      await r2.send(new DeleteObjectsCommand({ Bucket: R2_BUCKET, Delete: { Objects: batch } }));
      keysDeleted += batch.length;
    } catch (e) {
      errors.push((e as Error).message);
    }
  }

  // 2. Delete the queryable comment rows for these tickets.
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const { error } = await sb.from("ticket_comments").delete().in("ticket_id", chunk);
    if (error) errors.push(error.message);
  }

  // 3. Clear the heavy comment/history JSONB and stamp the stub with a small
  //    "what was here" tombstone (counts + attachment names). Done even if some R2
  //    deletes failed — the content is safe in the saved archive either way, and
  //    archived_at is what drives the "it's not gone, provide the archive" prompt.
  const now = new Date().toISOString();
  let reclaimedTickets = 0;
  for (const t of tickets) {
    const metadata = (t.metadata && typeof t.metadata === "object") ? t.metadata : {};
    const { error } = await sb
      .from("tickets")
      .update({
        comments: [], history: [],
        metadata: { ...metadata, archive_summary: buildTombstone(t) },
        archived_at: now, archive_id: archiveId,
      })
      .eq("id", t.id)
      .eq("org_id", orgId);
    if (error) errors.push(error.message);
    else reclaimedTickets++;
  }

  try {
    await sb.from("audit_logs").insert({
      action: "TICKET_ARCHIVE_RECLAIM",
      resource_id: orgId, resource_type: "org", org_id: orgId,
      user_id: actor.userId, user_email: actor.email,
      details: { archiveId, reclaimedTickets, keysDeleted, errors: errors.slice(0, 5) },
    });
  } catch { /* best-effort */ }

  return NextResponse.json({ ok: true, archiveId, reclaimedTickets, keysDeleted, errors });
}
