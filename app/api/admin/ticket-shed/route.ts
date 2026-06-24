// /api/admin/ticket-shed — the closed-ticket space-saver (Machine A), step 1 of 2.
//
//   GET  ?orgId=&days=&targetBytes=  → PREVIEW. Which closed tickets would be
//        archived and how much attachment space reclaimed.
//   POST { orgId, days, targetBytes, confirm } → PRODUCE. Bundle each eligible
//        ticket's WHOLE self — the row JSON (comments/history/metadata/attachments),
//        its ticket_comments rows, and its attachment binaries — into one named
//        archive ZIP, catalog it, LINK the tickets to it (archive_id), and stream
//        the ZIP back to save at <root>/data/<id>.zip.
//
// PRODUCE deletes nothing. Content is freed (and the stub created) only when the
// admin confirms the ZIP is saved and calls /api/admin/ticket-shed/commit. Only
// terminal (CLOSED/CANCELED), aged tickets NOT already linked to an un-committed
// archive are eligible. A ticket is captured ALL-OR-NOTHING: if any one of its
// attachment binaries can't be read it is skipped entirely, so commit can never
// delete a file that isn't in the saved ZIP. Binaries are path-preserved under
// /files so the SAME dropped-archive viewer (findInBackup) opens them.

import { NextRequest, NextResponse } from "next/server";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import JSZip from "jszip";
import type { SupabaseClient } from "@supabase/supabase-js";
import { authorizeOrgRole } from "@/lib/serverAuth";
import { r2, R2_BUCKET } from "@/lib/r2";
import {
  selectTicketShedCandidates,
  ticketAttachmentBytes,
  TERMINAL_TICKET_STATUSES,
  type TicketShedRow,
  type TicketAttachmentLite,
} from "@/lib/ticketShed";
import { makeArchiveId } from "@/lib/archive";

export const runtime = "nodejs";

const SHED_ROLES = ["Admin", "DocCtrl"];
const DEFAULT_DAYS = 90;
const FETCH_LIMIT = 8000;

function clampDays(raw: unknown): number {
  const n = Number(raw);
  return Number.isFinite(n) ? Math.max(30, Math.min(3650, Math.floor(n))) : DEFAULT_DAYS;
}
function parseBytes(raw: unknown): number | null {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

async function fetchTerminalTickets(sb: SupabaseClient, orgId: string): Promise<{ rows: TicketShedRow[]; capped: boolean }> {
  const { data } = await sb
    .from("tickets")
    .select("id, ticket_id, title, status, closed_at, last_modified, created_at, attachments, archived_at")
    .eq("org_id", orgId)
    .in("status", [...TERMINAL_TICKET_STATUSES])
    .is("archived_at", null)
    .is("archive_id", null) // never re-select a ticket already captured into an un-committed archive
    .order("closed_at", { ascending: true, nullsFirst: false }) // oldest-closed first (the eligibility clock)
    .order("id", { ascending: true }) // deterministic tiebreaker under the row cap
    .limit(FETCH_LIMIT);
  const rows = (data as TicketShedRow[] | null) ?? [];
  return { rows, capped: rows.length >= FETCH_LIMIT };
}

export async function GET(req: NextRequest) {
  const orgId = req.nextUrl.searchParams.get("orgId") || "";
  const days = clampDays(req.nextUrl.searchParams.get("days"));
  const targetBytes = parseBytes(req.nextUrl.searchParams.get("targetBytes"));
  const actor = await authorizeOrgRole(req, orgId, SHED_ROLES);
  if ("error" in actor) return NextResponse.json({ error: actor.error }, { status: actor.status });

  const { rows, capped } = await fetchTerminalTickets(actor.admin, orgId);
  const sel = selectTicketShedCandidates(rows, { olderThanDays: days, targetBytes });

  return NextResponse.json({
    cutoffDays: days,
    eligibleCount: sel.totalCount + sel.skipped,
    selectedCount: sel.totalCount,
    reclaimableBytes: sel.totalBytes,
    capped,
    sample: sel.selected.slice(0, 20).map((t) => ({
      id: t.id, ticketId: t.ticket_id, title: t.title, status: t.status,
      bytes: ticketAttachmentBytes(t.attachments), lastModified: t.last_modified,
    })),
    note:
      `Closed/canceled tickets quiet for over ${days} days are eligible. The whole ticket — ` +
      "comment thread, history and attachment files — is bundled into one archive and a " +
      "lightweight stub stays in the list. Producing an archive deletes nothing; content is " +
      "freed only after you confirm the archive is saved." +
      (capped ? ` Showing the oldest ${FETCH_LIMIT}; re-run after committing to reach the rest.` : ""),
  });
}

export async function POST(req: NextRequest) {
  let body: { orgId?: string; days?: number; targetBytes?: number; confirm?: boolean };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const orgId = body.orgId || "";
  const actor = await authorizeOrgRole(req, orgId, SHED_ROLES);
  if ("error" in actor) return NextResponse.json({ error: actor.error }, { status: actor.status });
  if (body.confirm !== true) return NextResponse.json({ error: "Confirmation required: pass confirm:true." }, { status: 400 });
  const sb = actor.admin;

  const days = clampDays(body.days);
  const targetBytes = parseBytes(body.targetBytes);
  const { rows } = await fetchTerminalTickets(sb, orgId);
  const sel = selectTicketShedCandidates(rows, { olderThanDays: days, targetBytes });
  if (sel.totalCount === 0) return NextResponse.json({ error: "No closed tickets are old enough to archive." }, { status: 400 });

  const selectedIds = sel.selected.map((t) => t.id);
  const archiveId = makeArchiveId({ at: new Date(), token: (globalThis.crypto?.randomUUID?.() || "").replace(/-/g, "").slice(-8) || "00000000" });

  // Reserve the archive label first. The token is a random 8-hex slice, so a
  // collision is astronomically unlikely — but if it happens it must ABORT, not
  // be swallowed, or two produces could share one label and commit would free both.
  const { error: catErr } = await sb.from("archives").insert({
    org_id: orgId, archive_id: archiveId, kind: "space",
    file_count: 0, total_bytes: 0,
    created_by: actor.userId, created_by_email: actor.email, note: "producing…",
  });
  if (catErr) return NextResponse.json({ error: "Archive label collision — please retry." }, { status: 409 });

  // CLAIM the rows atomically BEFORE bundling: a conditional update grabs only
  // tickets not already linked to another (possibly concurrent) produce. This is
  // what makes two simultaneous produces safe — the loser claims nothing rather
  // than re-pointing the winner's rows. Captured rows keep this archive_id; any we
  // can't fully bundle are un-claimed after the loop.
  const claimedIds: string[] = [];
  for (let i = 0; i < selectedIds.length; i += 200) {
    const chunk = selectedIds.slice(i, i + 200);
    const { data } = await sb
      .from("tickets")
      .update({ archive_id: archiveId })
      .in("id", chunk).eq("org_id", orgId).is("archive_id", null).is("archived_at", null)
      .select("id");
    for (const r of ((data ?? []) as Array<{ id: string }>)) claimedIds.push(r.id);
  }
  if (claimedIds.length === 0) {
    await sb.from("archives").delete().eq("org_id", orgId).eq("archive_id", archiveId);
    return NextResponse.json({ error: "Those tickets were just archived by another run." }, { status: 409 });
  }

  // Pull the FULL rows (every JSONB blob) and all comment rows for the CLAIMED set.
  const fullRowsById = new Map<string, Record<string, unknown>>();
  for (let i = 0; i < claimedIds.length; i += 200) {
    const chunk = claimedIds.slice(i, i + 200);
    const { data } = await sb.from("tickets").select("*").in("id", chunk).eq("org_id", orgId);
    for (const r of ((data ?? []) as Array<Record<string, unknown>>)) fullRowsById.set(r.id as string, r);
  }
  const commentsByTicket = new Map<string, unknown[]>();
  for (let i = 0; i < claimedIds.length; i += 200) {
    const chunk = claimedIds.slice(i, i + 200);
    const { data } = await sb.from("ticket_comments").select("*").in("ticket_id", chunk).is("deleted_at", null);
    for (const c of ((data ?? []) as Array<Record<string, unknown>>)) {
      const tid = c.ticket_id as string;
      const arr = commentsByTicket.get(tid) ?? [];
      arr.push(c);
      commentsByTicket.set(tid, arr);
    }
  }

  // Bundle: tickets/<id>.json (whole row), tickets/<id>.comments.json (comment
  // rows), files/<storage-key> (attachment binaries), files-meta.json (original
  // content types, replayed on restore).
  const zip = new JSZip();
  const ticketsFolder = zip.folder("tickets");
  const filesFolder = zip.folder("files");
  const fileMeta: Record<string, string> = {};
  let capturedTickets = 0, bundledFiles = 0, fileBytes = 0, skippedIncomplete = 0;
  const capturedIds: string[] = [];

  for (const t of sel.selected) {
    const full = fullRowsById.get(t.id);
    if (!full) continue;
    const atts = (full.attachments as TicketAttachmentLite[] | null) ?? [];

    // Read ALL of this ticket's binaries first. Only commit the ticket to the
    // archive if every one is captured — otherwise commit would later delete an
    // attachment that isn't in this ZIP (data loss). Any unreadable → skip ticket.
    const fetched: Array<{ key: string; buf: Uint8Array; contentType: string }> = [];
    let incomplete = false;
    for (const a of atts) {
      const key = (a?.url || "").toString();
      if (!key) continue;
      try {
        const obj = await r2.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }));
        const buf = await obj.Body!.transformToByteArray();
        fetched.push({ key, buf, contentType: obj.ContentType || "" });
      } catch {
        incomplete = true;
        break;
      }
    }
    if (incomplete) { skippedIncomplete++; continue; }

    ticketsFolder?.file(`${t.id}.json`, JSON.stringify(full, null, 2));
    const cmts = commentsByTicket.get(t.id) ?? [];
    if (cmts.length) ticketsFolder?.file(`${t.id}.comments.json`, JSON.stringify(cmts, null, 2));
    for (const f of fetched) {
      filesFolder?.file(f.key, f.buf);
      if (f.contentType) fileMeta[f.key] = f.contentType;
      bundledFiles++; fileBytes += f.buf.byteLength;
    }
    capturedTickets++; capturedIds.push(t.id);
  }
  // Un-claim any ticket we claimed but could NOT fully bundle (unreadable
  // attachment, or the row vanished) so it returns to the eligible pool instead
  // of being stranded with this archive_id.
  const capturedSet = new Set(capturedIds);
  const toUnclaim = claimedIds.filter((id) => !capturedSet.has(id));
  for (let i = 0; i < toUnclaim.length; i += 200) {
    const chunk = toUnclaim.slice(i, i + 200);
    await sb.from("tickets").update({ archive_id: null }).in("id", chunk).eq("org_id", orgId).eq("archive_id", archiveId).is("archived_at", null);
  }
  if (capturedTickets === 0) {
    await sb.from("archives").delete().eq("org_id", orgId).eq("archive_id", archiveId);
    return NextResponse.json({ error: "Could not fully capture any selected ticket (attachments unreadable). Nothing archived." }, { status: 502 });
  }
  if (Object.keys(fileMeta).length) zip.file("files-meta.json", JSON.stringify(fileMeta, null, 2));

  zip.file("ARCHIVE.txt",
    `Ticket archive ${archiveId}\nProduced ${new Date().toISOString()}\nOrg ${orgId}\n` +
    `${capturedTickets} ticket(s), ${bundledFiles} attachment file(s), ${fileBytes} bytes` +
    `${skippedIncomplete ? `, ${skippedIncomplete} ticket(s) skipped (unreadable attachments, left untouched)` : ""}.\n` +
    `Save this as <root>/data/${archiveId}.zip and keep it — it's the only copy of these ` +
    `closed tickets' full content (comments, history, attachments) once space is reclaimed.\n`);
  const zipBytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE", compressionOptions: { level: 6 } });

  // Finalize the catalog row with real counts (reserved + rows already claimed above).
  await sb.from("archives").update({
    file_count: bundledFiles, total_bytes: fileBytes,
    note: `${capturedTickets} closed ticket(s)${skippedIncomplete ? `, ${skippedIncomplete} skipped (unreadable attachments)` : ""}`,
  }).eq("org_id", orgId).eq("archive_id", archiveId);

  return new NextResponse(zipBytes as unknown as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${archiveId}.zip"`,
      "Cache-Control": "no-store",
      "X-Archive-Id": archiveId,
      "X-Archive-Tickets": String(capturedTickets),
      "X-Archive-Files": String(bundledFiles),
      "X-Archive-Bytes": String(fileBytes),
      "X-Archive-Skipped": String(skippedIncomplete),
    },
  });
}
