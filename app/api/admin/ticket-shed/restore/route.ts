// /api/admin/ticket-shed/restore — bring archived (stub) tickets fully back.
//
// POST ?orgId=&confirm=true  with the raw archive ZIP as the request body.
//
// Reverses a ticket-shed commit for every ticket in the archive: re-uploads its
// attachment binaries to R2 (original content types replayed from files-meta.json),
// restores the comment/history JSONB + the pre-archive metadata snapshot, and
// clears archived_at/archive_id so the ticket is hot again. ticket_comments rows
// are re-inserted with org_id/ticket_id stamped server-side. Additive + re-runnable.
// Admin/DocCtrl only.
//
// Hardened against a hand-edited archive:
//   • a ticket whose snapshot org_id != caller org is skipped (never cross-import);
//   • a binary key outside the caller org's prefix is refused (no cross-tenant write);
//   • the archived flag is cleared ONLY when every binary re-uploaded — a partial
//     restore leaves the stub (and its recovery pointer) intact, never half-restored.

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

  // Original content types captured at produce time, so a restored file renders
  // inline exactly as before (falls back to extension inference when absent).
  let fileMeta: Record<string, string> = {};
  const metaEntry = entryPaths.find((p) => /(^|\/)files-meta\.json$/.test(p));
  if (metaEntry) {
    try { fileMeta = JSON.parse(await zip.files[metaEntry].async("string")) as Record<string, string>; } catch { /* inference fallback */ }
  }

  const prefix = `orgs/${orgId}/`; // every legit storage key for this org lives under here
  let restored = 0, partial = 0, filesUploaded = 0, filesMissing = 0, commentRows = 0,
    skippedForeign = 0, skippedForeignKey = 0, missingStub = 0;
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

    // 1. Re-upload every attachment binary. Fail-closed: if ANY is missing,
    //    foreign-keyed, or errors, we do NOT clear the archived flag below — the
    //    stub (and its recovery pointer) stays intact rather than half-restoring.
    const atts = Array.isArray(row.attachments) ? (row.attachments as Array<{ url?: string }>) : [];
    let ticketOk = true;
    for (const a of atts) {
      const key = (a?.url || "").toString();
      if (!key) continue;
      if (!key.startsWith(prefix)) { ticketOk = false; skippedForeignKey++; continue; } // never write another org's key
      const entry = findInBackup(entryPaths, key);
      if (!entry) { ticketOk = false; filesMissing++; continue; }
      try {
        const bytes = await zip.files[entry].async("uint8array");
        await r2.send(new PutObjectCommand({ Bucket: R2_BUCKET, Key: key, Body: bytes, ContentType: fileMeta[key] || inferContentType(key) }));
        filesUploaded++;
      } catch (e) {
        ticketOk = false;
        errors.push(`upload ${key}: ${(e as Error).message}`);
      }
    }
    if (!ticketOk) { partial++; continue; } // leave the stub fully intact

    // 2. Re-insert the comment rows, STAMPING org_id + ticket_id server-side so a
    //    hand-edited archive can't inject rows into another org/ticket.
    const cp = tp.replace(/\.json$/, ".comments.json");
    if (zip.files[cp]) {
      try {
        const raw = JSON.parse(await zip.files[cp].async("string")) as Record<string, unknown>[];
        const cmts = raw.map((c) => ({ ...c, org_id: orgId, ticket_id: id }));
        for (let i = 0; i < cmts.length; i += 200) {
          const chunk = cmts.slice(i, i + 200);
          const up = await sb.from("ticket_comments").upsert(chunk, { onConflict: "id", ignoreDuplicates: true });
          if (!up.error) commentRows += chunk.length;
          else errors.push(`comments ${id}: ${up.error.message}`);
        }
      } catch { /* the JSONB copy below also carries the thread */ }
    }

    // 3. Restore the heavy JSONB + the pre-archive metadata snapshot (which clears
    //    the tombstone) and clear the archived flags on the existing stub.
    const { error, count } = await sb
      .from("tickets")
      .update(
        {
          comments: row.comments ?? [],
          history: row.history ?? [],
          metadata: (row.metadata as Record<string, unknown> | null) ?? {},
          archived_at: null,
          archive_id: null,
        },
        { count: "exact" },
      )
      .eq("id", id)
      .eq("org_id", orgId);
    if (error) { errors.push(`update ${id}: ${error.message}`); continue; }
    if ((count ?? 0) === 0) { missingStub++; continue; } // stub no longer present
    restored++;
  }

  try {
    await sb.from("audit_logs").insert({
      action: "TICKET_ARCHIVE_RESTORE",
      resource_id: orgId, resource_type: "org", org_id: orgId,
      user_id: actor.userId, user_email: actor.email,
      details: { restored, partial, filesUploaded, filesMissing, commentRows, skippedForeign, skippedForeignKey, missingStub, errors: errors.slice(0, 8) },
    });
  } catch { /* best-effort */ }

  return NextResponse.json({ ok: true, restored, partial, filesUploaded, filesMissing, commentRows, skippedForeign, skippedForeignKey, missingStub, errors });
}
