// /api/admin/ticket-shed/restore — bring archived (stub) tickets fully back.
//
// POST ?orgId=&confirm=true  with the raw archive ZIP as the request body.
//
// Reverses a ticket-shed commit for every ticket in the archive: re-uploads its
// attachment binaries to R2, restores the comment/history JSONB on the row, and
// clears archived_at/archive_id so the ticket is hot again. ticket_comments rows
// are re-inserted (skip-on-conflict). Additive + re-runnable. Admin/DocCtrl only.
//
// Only updates stub rows already in THIS org — a snapshot whose org_id doesn't
// match is skipped, never cross-imported.

import { NextRequest, NextResponse } from "next/server";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import JSZip from "jszip";
import { authorizeOrgRole } from "@/lib/serverAuth";
import { r2, R2_BUCKET } from "@/lib/r2";
import { findInBackup } from "@/lib/archive";

export const runtime = "nodejs";

const SHED_ROLES = ["Admin", "DocCtrl"];

const CONTENT_TYPES: Record<string, string> = {
  pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
  gif: "image/gif", svg: "image/svg+xml", webp: "image/webp", txt: "text/plain",
  csv: "text/csv", zip: "application/zip", dxf: "image/vnd.dxf", dwg: "application/acad",
  doc: "application/msword", xls: "application/vnd.ms-excel",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};
function inferContentType(key: string): string {
  return CONTENT_TYPES[(key.toLowerCase().split(".").pop() || "")] || "application/octet-stream";
}

export async function POST(req: NextRequest) {
  const orgId = req.nextUrl.searchParams.get("orgId") || "";
  const confirm = req.nextUrl.searchParams.get("confirm") === "true";
  const actor = await authorizeOrgRole(req, orgId, SHED_ROLES);
  if ("error" in actor) return NextResponse.json({ error: actor.error }, { status: actor.status });
  if (!confirm) return NextResponse.json({ error: "Confirmation required: pass confirm=true." }, { status: 400 });
  const sb = actor.admin;

  let zip: JSZip;
  try {
    const buf = await req.arrayBuffer();
    if (!buf.byteLength) return NextResponse.json({ error: "Empty body — POST the archive zip." }, { status: 400 });
    zip = await JSZip.loadAsync(buf);
  } catch {
    return NextResponse.json({ error: "Could not read the archive (not a valid zip)." }, { status: 400 });
  }

  const entryPaths = Object.keys(zip.files);
  const ticketJsonPaths = entryPaths.filter(
    (p) => /(^|\/)tickets\/[^/]+\.json$/.test(p) && !p.endsWith(".comments.json"),
  );
  if (ticketJsonPaths.length === 0) {
    return NextResponse.json({ error: "No tickets found in this archive." }, { status: 400 });
  }

  let restored = 0, filesUploaded = 0, filesMissing = 0, commentRows = 0, skippedForeign = 0, missingStub = 0;
  const errors: string[] = [];

  for (const tp of ticketJsonPaths) {
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(await zip.files[tp].async("string"));
    } catch {
      errors.push(`bad json: ${tp}`);
      continue;
    }
    const id = row.id as string | undefined;
    if (!id) continue;
    if ((row.org_id as string) !== orgId) { skippedForeign++; continue; } // never cross orgs

    // 1. Re-upload attachment binaries from the archive's /files folder.
    const atts = Array.isArray(row.attachments) ? (row.attachments as Array<{ url?: string }>) : [];
    for (const a of atts) {
      const key = (a?.url || "").toString();
      if (!key) continue;
      const entry = findInBackup(entryPaths, key);
      if (!entry) { filesMissing++; continue; }
      try {
        const bytes = await zip.files[entry].async("uint8array");
        await r2.send(new PutObjectCommand({ Bucket: R2_BUCKET, Key: key, Body: bytes, ContentType: inferContentType(key) }));
        filesUploaded++;
      } catch (e) {
        errors.push((e as Error).message);
      }
    }

    // 2. Re-insert the queryable comment rows (skip-on-conflict, re-runnable).
    const cp = tp.replace(/\.json$/, ".comments.json");
    if (zip.files[cp]) {
      try {
        const cmts = JSON.parse(await zip.files[cp].async("string")) as Record<string, unknown>[];
        for (let i = 0; i < cmts.length; i += 200) {
          const chunk = cmts.slice(i, i + 200);
          const up = await sb.from("ticket_comments").upsert(chunk, { onConflict: "id", ignoreDuplicates: true });
          if (!up.error) commentRows += chunk.length;
        }
      } catch { /* the JSONB copy below also carries the thread */ }
    }

    // 3. Restore the heavy JSONB and clear the archived flags on the existing stub.
    const { error, count } = await sb
      .from("tickets")
      .update(
        { comments: row.comments ?? [], history: row.history ?? [], archived_at: null, archive_id: null },
        { count: "exact" },
      )
      .eq("id", id)
      .eq("org_id", orgId);
    if (error) { errors.push(error.message); continue; }
    if ((count ?? 0) === 0) { missingStub++; continue; } // stub no longer present
    restored++;
  }

  try {
    await sb.from("audit_logs").insert({
      action: "TICKET_ARCHIVE_RESTORE",
      resource_id: orgId, resource_type: "org", org_id: orgId,
      user_id: actor.userId, user_email: actor.email,
      details: { restored, filesUploaded, filesMissing, commentRows, skippedForeign, missingStub, errors: errors.slice(0, 5) },
    });
  } catch { /* best-effort */ }

  return NextResponse.json({ ok: true, restored, filesUploaded, filesMissing, commentRows, skippedForeign, missingStub, errors });
}
