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
// terminal (CLOSED/CANCELED), aged tickets are eligible — open tickets are never
// touched. Binaries are path-preserved under /files so the SAME dropped-archive
// viewer (findInBackup) that opens shed documents opens these too.

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

function clampDays(raw: unknown): number {
  const n = Number(raw);
  return Number.isFinite(n) ? Math.max(30, Math.min(3650, Math.floor(n))) : DEFAULT_DAYS;
}
function parseBytes(raw: unknown): number | null {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

async function fetchTerminalTickets(sb: SupabaseClient, orgId: string): Promise<TicketShedRow[]> {
  const { data } = await sb
    .from("tickets")
    .select("id, ticket_id, title, status, last_modified, created_at, attachments, archived_at")
    .eq("org_id", orgId)
    .in("status", [...TERMINAL_TICKET_STATUSES])
    .is("archived_at", null)
    .order("last_modified", { ascending: true })
    .limit(8000);
  return (data as TicketShedRow[] | null) ?? [];
}

export async function GET(req: NextRequest) {
  const orgId = req.nextUrl.searchParams.get("orgId") || "";
  const days = clampDays(req.nextUrl.searchParams.get("days"));
  const targetBytes = parseBytes(req.nextUrl.searchParams.get("targetBytes"));
  const actor = await authorizeOrgRole(req, orgId, SHED_ROLES);
  if ("error" in actor) return NextResponse.json({ error: actor.error }, { status: actor.status });

  const rows = await fetchTerminalTickets(actor.admin, orgId);
  const sel = selectTicketShedCandidates(rows, { olderThanDays: days, targetBytes });

  return NextResponse.json({
    cutoffDays: days,
    eligibleCount: sel.totalCount + sel.skipped,
    selectedCount: sel.totalCount,
    reclaimableBytes: sel.totalBytes,
    sample: sel.selected.slice(0, 20).map((t) => ({
      id: t.id, ticketId: t.ticket_id, title: t.title, status: t.status,
      bytes: ticketAttachmentBytes(t.attachments), lastModified: t.last_modified,
    })),
    note:
      `Closed/canceled tickets quiet for over ${days} days are eligible. The whole ticket — ` +
      "comment thread, history and attachment files — is bundled into one archive and a " +
      "lightweight stub stays in the list. Producing an archive deletes nothing; content is " +
      "freed only after you confirm the archive is saved.",
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
  const rows = await fetchTerminalTickets(sb, orgId);
  const sel = selectTicketShedCandidates(rows, { olderThanDays: days, targetBytes });
  if (sel.totalCount === 0) return NextResponse.json({ error: "No closed tickets are old enough to archive." }, { status: 400 });

  const selectedIds = sel.selected.map((t) => t.id);

  // Pull the FULL rows (every JSONB blob) and all comment rows for the selection.
  const fullRowsById = new Map<string, Record<string, unknown>>();
  for (let i = 0; i < selectedIds.length; i += 200) {
    const chunk = selectedIds.slice(i, i + 200);
    const { data } = await sb.from("tickets").select("*").in("id", chunk).eq("org_id", orgId);
    for (const r of ((data ?? []) as Array<Record<string, unknown>>)) fullRowsById.set(r.id as string, r);
  }
  const commentsByTicket = new Map<string, unknown[]>();
  for (let i = 0; i < selectedIds.length; i += 200) {
    const chunk = selectedIds.slice(i, i + 200);
    const { data } = await sb.from("ticket_comments").select("*").in("ticket_id", chunk);
    for (const c of ((data ?? []) as Array<Record<string, unknown>>)) {
      const tid = c.ticket_id as string;
      const arr = commentsByTicket.get(tid) ?? [];
      arr.push(c);
      commentsByTicket.set(tid, arr);
    }
  }

  const archiveId = makeArchiveId({ at: new Date(), token: (globalThis.crypto?.randomUUID?.() || "").replace(/-/g, "").slice(-4) || "0000" });

  // Bundle: tickets/<id>.json (whole row), tickets/<id>.comments.json (comment
  // rows), files/<storage-key> (attachment binaries).
  const zip = new JSZip();
  const ticketsFolder = zip.folder("tickets");
  const filesFolder = zip.folder("files");
  let capturedTickets = 0, bundledFiles = 0, missedFiles = 0, fileBytes = 0;
  const capturedIds: string[] = [];

  for (const t of sel.selected) {
    const full = fullRowsById.get(t.id);
    if (!full) continue;
    ticketsFolder?.file(`${t.id}.json`, JSON.stringify(full, null, 2));
    const cmts = commentsByTicket.get(t.id) ?? [];
    if (cmts.length) ticketsFolder?.file(`${t.id}.comments.json`, JSON.stringify(cmts, null, 2));

    const atts = (full.attachments as TicketAttachmentLite[] | null) ?? [];
    for (const a of atts) {
      const key = (a?.url || "").toString();
      if (!key) continue;
      try {
        const obj = await r2.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }));
        const buf = await obj.Body!.transformToByteArray();
        filesFolder?.file(key, buf);
        bundledFiles++; fileBytes += buf.byteLength;
      } catch {
        missedFiles++; // unreadable binary → still archive the ticket text; the file stays in R2
      }
    }
    capturedTickets++; capturedIds.push(t.id);
  }
  if (capturedTickets === 0) return NextResponse.json({ error: "Could not read any selected tickets." }, { status: 502 });

  zip.file("ARCHIVE.txt",
    `Ticket archive ${archiveId}\nProduced ${new Date().toISOString()}\nOrg ${orgId}\n` +
    `${capturedTickets} ticket(s), ${bundledFiles} attachment file(s), ${fileBytes} bytes.\n` +
    `Save this as <root>/data/${archiveId}.zip and keep it — it's the only copy of these ` +
    `closed tickets' full content (comments, history, attachments) once space is reclaimed.\n`);
  const zipBytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE", compressionOptions: { level: 6 } });

  // Catalog the archive and LINK the captured tickets (archive_id only; the stub
  // and the freeing happen at commit).
  try {
    await sb.from("archives").insert({
      org_id: orgId, archive_id: archiveId, kind: "space",
      file_count: bundledFiles, total_bytes: fileBytes,
      created_by: actor.userId, created_by_email: actor.email,
      note: `${capturedTickets} closed ticket(s)${missedFiles ? `, ${missedFiles} attachment(s) unreadable & left in place` : ""}`,
    });
  } catch { /* best-effort catalog */ }
  for (let i = 0; i < capturedIds.length; i += 200) {
    const chunk = capturedIds.slice(i, i + 200);
    await sb.from("tickets").update({ archive_id: archiveId }).in("id", chunk).eq("org_id", orgId);
  }

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
    },
  });
}
