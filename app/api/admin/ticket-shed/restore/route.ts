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
// Hardened against a hand-edited / hostile archive:
//   • only rows that are CURRENTLY archived stubs IN THIS ORG are touched — a
//     snapshot can never overwrite a hot ticket or cross orgs (the update is
//     gated on the LIVE row, not the zip's claims);
//   • a binary is re-uploaded only to a key the live stub actually owns (its own
//     attachments[].url) and under the org prefix — no within/cross-org overwrite;
//   • the zip is size/entry/decompression-bounded so a compression bomb can't OOM;
//   • the archived flag is cleared ONLY when every binary re-uploaded.

import { NextRequest, NextResponse } from "next/server";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import JSZip from "jszip";
import { authorizeOrgRole } from "@/lib/serverAuth";
import { r2, R2_BUCKET } from "@/lib/r2";
import { findInBackup } from "@/lib/archive";

export const runtime = "nodejs";
export const maxDuration = 300; // bounded work; never run unbounded on a hostile zip

const SHED_ROLES = ["Admin", "DocCtrl"];

// Input bounds — a restore archive is admin-produced and small; these only exist
// to stop a malicious/corrupt zip from exhausting memory or wall-clock.
const MAX_ZIP_BYTES = 200 * 1024 * 1024;          // 200 MB raw upload
const MAX_ENTRIES = 20_000;                        // total zip entries
const MAX_TICKETS = 5_000;                          // tickets/*.json files
const MAX_DECOMPRESSED = 2 * 1024 * 1024 * 1024;    // cumulative inflated bytes

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

interface StubRow { id: string; attachments: Array<{ url?: string }> | null }

export async function POST(req: NextRequest) {
  const orgId = req.nextUrl.searchParams.get("orgId") || "";
  const confirm = req.nextUrl.searchParams.get("confirm") === "true";
  const actor = await authorizeOrgRole(req, orgId, SHED_ROLES);
  if ("error" in actor) return NextResponse.json({ error: actor.error }, { status: actor.status });
  if (!confirm) return NextResponse.json({ error: "Confirmation required: pass confirm=true." }, { status: 400 });
  const sb = actor.admin;

  const declaredLen = Number(req.headers.get("content-length") || "0");
  if (declaredLen > MAX_ZIP_BYTES) {
    return NextResponse.json({ error: `Archive too large (max ${Math.round(MAX_ZIP_BYTES / 1048576)} MB).` }, { status: 413 });
  }

  let zip: JSZip;
  try {
    const buf = await req.arrayBuffer();
    if (!buf.byteLength) return NextResponse.json({ error: "Empty body — POST the archive zip." }, { status: 400 });
    if (buf.byteLength > MAX_ZIP_BYTES) {
      return NextResponse.json({ error: `Archive too large (max ${Math.round(MAX_ZIP_BYTES / 1048576)} MB).` }, { status: 413 });
    }
    zip = await JSZip.loadAsync(buf);
  } catch {
    return NextResponse.json({ error: "Could not read the archive (not a valid zip)." }, { status: 400 });
  }

  const entryPaths = Object.keys(zip.files);
  if (entryPaths.length > MAX_ENTRIES) {
    return NextResponse.json({ error: "Archive has too many entries." }, { status: 413 });
  }
  const ticketJsonPaths = entryPaths.filter(
    (p) => /(^|\/)tickets\/[^/]+\.json$/.test(p) && !p.endsWith(".comments.json"),
  );
  if (ticketJsonPaths.length === 0) {
    return NextResponse.json({ error: "No tickets found in this archive." }, { status: 400 });
  }
  if (ticketJsonPaths.length > MAX_TICKETS) {
    return NextResponse.json({ error: "Archive has too many tickets." }, { status: 413 });
  }

  // Original content types captured at produce time (inline rendering preserved).
  let fileMeta: Record<string, string> = {};
  const metaEntry = entryPaths.find((p) => /(^|\/)files-meta\.json$/.test(p));
  if (metaEntry) {
    try { fileMeta = JSON.parse(await zip.files[metaEntry].async("string")) as Record<string, string>; } catch { /* inference fallback */ }
  }

  // Parse the snapshots, collecting the in-org ticket ids the zip references.
  const prefix = `orgs/${orgId}/`;
  const snapshots: Array<{ tp: string; row: Record<string, unknown>; id: string }> = [];
  let badJson = 0, skippedForeign = 0;
  for (const tp of ticketJsonPaths) {
    let row: Record<string, unknown>;
    try { row = JSON.parse(await zip.files[tp].async("string")); } catch { badJson++; continue; }
    const id = row.id as string | undefined;
    if (!id) { badJson++; continue; }
    if ((row.org_id as string) !== orgId) { skippedForeign++; continue; } // never cross orgs
    snapshots.push({ tp, row, id });
  }

  // Fetch the LIVE rows for those ids and keep only the ones that are CURRENTLY
  // archived stubs in this org. This is the authority — a snapshot can never
  // overwrite a hot ticket or invent a row; and it gives us each stub's real
  // attachment keys so we only re-upload bytes to keys the ticket legitimately owns.
  const stubById = new Map<string, StubRow>();
  const ids = snapshots.map((s) => s.id);
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const { data } = await sb
      .from("tickets")
      .select("id, attachments")
      .in("id", chunk)
      .eq("org_id", orgId)
      .not("archived_at", "is", null); // only archived stubs are restorable
    for (const r of ((data ?? []) as StubRow[])) stubById.set(r.id, r);
  }

  let restored = 0, partial = 0, filesUploaded = 0, filesMissing = 0, commentRows = 0,
    skippedForeignKey = 0, notArchived = 0;
  let decompressed = 0;
  const errors: string[] = [];

  for (const { tp, row, id } of snapshots) {
    const stub = stubById.get(id);
    if (!stub) { notArchived++; continue; } // hot ticket or not present — never overwrite it

    // The only keys we may write are the ones the LIVE stub records, under our prefix.
    const allowedKeys = new Set(
      (Array.isArray(stub.attachments) ? stub.attachments : [])
        .map((a) => (a?.url || "").toString())
        .filter((k) => k && k.startsWith(prefix)),
    );

    let ticketOk = true;
    for (const k of allowedKeys) {
      const entry = findInBackup(entryPaths, k);
      if (!entry) { ticketOk = false; filesMissing++; continue; }
      try {
        const bytes = await zip.files[entry].async("uint8array");
        decompressed += bytes.byteLength;
        if (decompressed > MAX_DECOMPRESSED) {
          return NextResponse.json({ error: "Archive decompresses to too much data; aborted.", restored, filesUploaded }, { status: 413 });
        }
        await r2.send(new PutObjectCommand({ Bucket: R2_BUCKET, Key: k, Body: bytes, ContentType: fileMeta[k] || inferContentType(k) }));
        filesUploaded++;
      } catch (e) {
        ticketOk = false;
        errors.push(`upload ${k}: ${(e as Error).message}`);
      }
    }
    // Count any zip-declared key the stub does NOT own (ignored, never written).
    const snapKeys = Array.isArray(row.attachments) ? (row.attachments as Array<{ url?: string }>) : [];
    for (const a of snapKeys) {
      const k = (a?.url || "").toString();
      if (k && !allowedKeys.has(k)) skippedForeignKey++;
    }
    if (!ticketOk) { partial++; continue; } // leave the stub intact (recovery pointer preserved)

    // Re-insert comment rows, STAMPING org_id + ticket_id server-side.
    const cp = tp.replace(/\.json$/, ".comments.json");
    if (zip.files[cp]) {
      try {
        const rawStr = await zip.files[cp].async("string");
        decompressed += rawStr.length;
        const raw = JSON.parse(rawStr) as Record<string, unknown>[];
        const cmts = raw.map((c) => ({ ...c, org_id: orgId, ticket_id: id }));
        for (let i = 0; i < cmts.length; i += 200) {
          const chunk = cmts.slice(i, i + 200);
          const up = await sb.from("ticket_comments").upsert(chunk, { onConflict: "id", ignoreDuplicates: true });
          if (!up.error) commentRows += chunk.length;
          else errors.push(`comments ${id}: ${up.error.message}`);
        }
      } catch { /* the JSONB copy below also carries the thread */ }
    }

    // Restore the JSONB + pre-archive metadata snapshot and clear the flags — but
    // ONLY on a still-archived stub (defence-in-depth against a TOCTOU flip).
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
      .eq("org_id", orgId)
      .not("archived_at", "is", null);
    if (error) { errors.push(`update ${id}: ${error.message}`); continue; }
    if ((count ?? 0) === 0) { notArchived++; continue; }
    restored++;
  }

  try {
    await sb.from("audit_logs").insert({
      action: "TICKET_ARCHIVE_RESTORE",
      resource_id: orgId, resource_type: "org", org_id: orgId,
      user_id: actor.userId, user_email: actor.email,
      details: { restored, partial, filesUploaded, filesMissing, commentRows, skippedForeign, skippedForeignKey, notArchived, badJson, errors: errors.slice(0, 8) },
    });
  } catch { /* best-effort */ }

  return NextResponse.json({ ok: true, restored, partial, filesUploaded, filesMissing, commentRows, skippedForeign, skippedForeignKey, notArchived, badJson, errors });
}
