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
  archived_at: string | null;
}

/** A small, queryable snapshot of "what was here" kept on the stub so the
 *  archived ticket can show its shape (counts + attachment names) without the
 *  heavy content. Lives at metadata.archive_summary; removed again on restore.
 *
 *  commentCount is taken from the JSONB `comments` array — that's the SUPERSET
 *  the ticket UI actually renders and that the archive zip's row snapshot
 *  carries. The ticket_comments table is only a partial shadow (it's missing
 *  workflow-generated comments and any comment predating the table), so counting
 *  it would under-report "what was here", often to zero. */
function buildTombstone(row: TombstoneSource): Record<string, unknown> {
  const atts = Array.isArray(row.attachments) ? row.attachments : [];
  const history = Array.isArray(row.history) ? row.history : [];
  const comments = Array.isArray(row.comments) ? row.comments : [];
  // Preserve the revision/rejection root-cause tally so the analytics breakdown
  // doesn't lose this (long-closed) ticket's categories once its comments are gone.
  const revisionCategories: Record<string, number> = {};
  for (const c of comments) {
    const cc = c as { type?: string; category?: string };
    if (cc?.type === "Revision" || cc?.type === "Rejection") {
      const cat = cc.category || "Uncategorized";
      revisionCategories[cat] = (revisionCategories[cat] ?? 0) + 1;
    }
  }
  return {
    commentCount: comments.length,
    revisionCategories,
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

  // Every ticket linked to this archive — INCLUDING any already stamped by a
  // prior, possibly interrupted, commit. Re-processing those (idempotently) is
  // what makes commit self-healing after a crash between stamping and freeing.
  const { data: rows } = await sb
    .from("tickets")
    .select("id, attachments, comments, history, metadata, archived_at")
    .eq("org_id", orgId)
    .eq("archive_id", archiveId);
  const tickets = (rows as Array<TombstoneSource> | null) ?? [];
  if (tickets.length === 0) {
    return NextResponse.json({ ok: true, reclaimedTickets: 0, note: "Nothing linked to this archive (already restored, or never produced)." });
  }
  const errors: string[] = [];

  const keysFor = (t: TombstoneSource): string[] =>
    (Array.isArray(t.attachments) ? t.attachments : [])
      .map((a) => (a?.url || "").toString())
      .filter(Boolean);

  // 1. STAMP any not-yet-stamped stub FIRST (fail-closed): clear the heavy JSONB,
  //    write the tombstone, set archived_at — guarded by `archived_at is null` so
  //    a concurrent commit can't double-free, and only a PROVABLE stamp (count===1)
  //    proceeds to the deletes. Rows already stamped by an earlier interrupted
  //    commit skip the stamp (keeping their tombstone) but still get re-freed below.
  const now = new Date().toISOString();
  let newlyStamped = 0;
  const idsToFree: string[] = [];
  const keysByTicket = new Map<string, string[]>();
  for (const t of tickets) {
    if (t.archived_at) {
      idsToFree.push(t.id);
      keysByTicket.set(t.id, keysFor(t));
      continue;
    }
    const metadata = (t.metadata && typeof t.metadata === "object" && !Array.isArray(t.metadata)) ? t.metadata : {};
    const tombstone = buildTombstone(t);
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
    if ((count ?? 0) === 0) { errors.push(`stamp ${t.id}: raced — left untouched`); continue; }
    newlyStamped++;
    idsToFree.push(t.id);
    keysByTicket.set(t.id, keysFor(t));
  }

  // 2. A concurrent restore could have un-archived one of these stubs between our
  //    stamp and here. Re-verify which ids are STILL archived and free ONLY those,
  //    so we never delete the comments/binaries of a ticket someone just restored.
  //    (Shrinks the race to the gap between this check and the delete; the deletes
  //    are idempotent so a re-run still finishes any genuinely-archived leftovers.)
  const stillArchived = new Set<string>();
  for (let i = 0; i < idsToFree.length; i += 200) {
    const chunk = idsToFree.slice(i, i + 200);
    const { data } = await sb.from("tickets").select("id").in("id", chunk).eq("org_id", orgId).not("archived_at", "is", null);
    for (const r of ((data ?? []) as Array<{ id: string }>)) stillArchived.add(r.id);
  }
  const freeIds = idsToFree.filter((id) => stillArchived.has(id));
  const keysToDelete = freeIds.flatMap((id) => keysByTicket.get(id) ?? []);

  for (let i = 0; i < freeIds.length; i += 200) {
    const chunk = freeIds.slice(i, i + 200);
    const { error } = await sb.from("ticket_comments").delete().in("ticket_id", chunk).eq("org_id", orgId);
    if (error) errors.push(`comments[${i}]: ${error.message}`);
  }
  const { deleted: keysDeleted, errors: delErrors } = await deleteR2Keys(keysToDelete);
  errors.push(...delErrors);

  const reclaimedTickets = newlyStamped;
  try {
    await sb.from("audit_logs").insert({
      action: "TICKET_ARCHIVE_RECLAIM",
      resource_id: orgId, resource_type: "org", org_id: orgId,
      user_id: actor.userId, user_email: actor.email,
      details: { archiveId, reclaimedTickets, reprocessed: idsToFree.length - newlyStamped, keysDeleted, errors: errors.slice(0, 8) },
    });
  } catch { /* best-effort */ }

  return NextResponse.json({ ok: true, archiveId, reclaimedTickets, processed: idsToFree.length, keysDeleted, errors });
}
