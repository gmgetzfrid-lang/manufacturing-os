// /api/admin/shed — the space-saver (Machine A), step 1 of 2.
//
//   GET  ?orgId=&days=&targetBytes=  → PREVIEW. What would be shed + reclaimed.
//   POST { orgId, days, targetBytes, confirm } → PRODUCE. Build a named "space"
//         archive ZIP of exactly those binaries, catalog it, LINK the versions to
//         it (archive_id), and stream the ZIP back to save at <root>/data/<id>.zip.
//
// PRODUCE does NOT delete anything yet — the binary stays in R2 as a safety net
// until the admin confirms they saved the ZIP and calls /api/admin/shed/commit.
// That two-step is deliberate: bytes are only removed once they're provably
// captured offline.
//
// Only superseded, aged revisions are eligible — current revisions are never
// touched, and all metadata/checksums stay in the DB forever.

import { NextRequest, NextResponse } from "next/server";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import JSZip from "jszip";
import type { SupabaseClient } from "@supabase/supabase-js";
import { authorizeOrgRole } from "@/lib/serverAuth";
import { r2, R2_BUCKET } from "@/lib/r2";
import { selectShedCandidates, type ShedCandidateRow } from "@/lib/shed";
import { makeArchiveId } from "@/lib/archive";

export const runtime = "nodejs";

const SHED_ROLES = ["Admin", "DocCtrl"];
const DEFAULT_KEEP = 5;

function clampKeep(raw: unknown): number {
  const n = Number(raw);
  return Number.isFinite(n) ? Math.max(1, Math.min(100, Math.floor(n))) : DEFAULT_KEEP;
}
function parseBytes(raw: unknown): number | null {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

async function fetchCandidates(sb: SupabaseClient, orgId: string): Promise<ShedCandidateRow[]> {
  // All non-archived revisions (current + superseded) so the keep-last-N grouping
  // can see each document's full recent history.
  const { data } = await sb
    .from("document_versions")
    .select("id, file_url, size, superseded_at, archive_id, created_at, revision_label, record_id")
    .eq("org_id", orgId)
    .is("archived_at", null)
    // NB: archive_id-linked (produced-but-not-committed) revisions are INCLUDED
    // here so they still count toward keep-N; selectShedCandidates excludes them
    // from selection via isEligible. Filtering them here would hole-punch the
    // history and let a later produce shed inside the keep-N window.
    .order("record_id", { ascending: true })
    .order("created_at", { ascending: false })
    .order("id", { ascending: true }) // deterministic tiebreaker for identical created_at
    .limit(8000);
  return ((data as ShedCandidateRow[] | null) ?? []).filter((r) => r.record_id);
}

export async function GET(req: NextRequest) {
  const orgId = req.nextUrl.searchParams.get("orgId") || "";
  const keep = clampKeep(req.nextUrl.searchParams.get("keep"));
  const targetBytes = parseBytes(req.nextUrl.searchParams.get("targetBytes"));
  const actor = await authorizeOrgRole(req, orgId, SHED_ROLES);
  if ("error" in actor) return NextResponse.json({ error: actor.error }, { status: actor.status });

  const rows = await fetchCandidates(actor.admin, orgId);
  const sel = selectShedCandidates(rows, { keepPerDoc: keep, targetBytes });

  return NextResponse.json({
    keepPerDoc: keep,
    eligibleCount: sel.totalCount + sel.skipped,
    selectedCount: sel.totalCount,
    reclaimableBytes: sel.totalBytes,
    sample: sel.selected.slice(0, 20).map((r) => ({
      id: r.id, revision: r.revision_label, bytes: Number(r.size) || 0, supersededAt: r.superseded_at,
    })),
    note:
      `Keeps the last ${keep} revisions of each document hot; older history is eligible. ` +
      "Current revisions are never shed. Producing an archive deletes nothing; bytes are removed only after you confirm the archive is saved.",
  });
}

export async function POST(req: NextRequest) {
  let body: { orgId?: string; keep?: number; targetBytes?: number; confirm?: boolean };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const orgId = body.orgId || "";
  const actor = await authorizeOrgRole(req, orgId, SHED_ROLES);
  if ("error" in actor) return NextResponse.json({ error: actor.error }, { status: actor.status });
  if (body.confirm !== true) return NextResponse.json({ error: "Confirmation required: pass confirm:true." }, { status: 400 });
  const sb = actor.admin;

  const keep = clampKeep(body.keep);
  const targetBytes = parseBytes(body.targetBytes);
  const rows = await fetchCandidates(sb, orgId);
  const sel = selectShedCandidates(rows, { keepPerDoc: keep, targetBytes });
  if (sel.totalCount === 0) {
    return NextResponse.json({ error: "Nothing eligible to shed in this window." }, { status: 400 });
  }

  const archiveId = makeArchiveId({ at: new Date(), token: (globalThis.crypto?.randomUUID?.() || "").replace(/-/g, "").slice(-8) || "00000000" });

  // Build the space archive: every selected binary, path-preserved under /files
  // so the in-memory viewer (findInBackup) opens it later by its storage key.
  const zip = new JSZip();
  const filesFolder = zip.folder("files");
  let bundled = 0, missed = 0, bytes = 0;
  const capturedIds: string[] = [];
  for (const r of sel.selected) {
    const key = r.file_url as string;
    try {
      const obj = await r2.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }));
      const buf = await obj.Body!.transformToByteArray();
      filesFolder?.file(key, buf);
      bundled++; bytes += buf.byteLength; capturedIds.push(r.id);
    } catch {
      missed++; // can't capture → leave it untouched (never linked, never deleted)
    }
  }
  if (bundled === 0) return NextResponse.json({ error: "Could not read any selected binaries from storage." }, { status: 502 });

  zip.file("ARCHIVE.txt",
    `Space-saver archive ${archiveId}\nProduced ${new Date().toISOString()}\nOrg ${orgId}\n` +
    `${bundled} file(s), ${bytes} bytes.\nSave this as <root>/data/${archiveId}.zip and keep it — ` +
    `it's the only copy of these superseded revisions once space is reclaimed.\n`);
  const zipBytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE", compressionOptions: { level: 6 } });

  // Catalog the archive and LINK the captured versions to it (archive_id only;
  // archived_at stays null until commit actually deletes the bytes).
  try {
    await sb.from("archives").insert({
      org_id: orgId, archive_id: archiveId, kind: "space",
      file_count: bundled, total_bytes: bytes,
      created_by: actor.userId, created_by_email: actor.email,
      note: `${bundled} superseded revision binaries${missed ? ` (${missed} unreadable, left in place)` : ""}`,
    });
  } catch { /* best-effort catalog */ }
  // Link in chunks to stay within statement limits.
  for (let i = 0; i < capturedIds.length; i += 200) {
    const chunk = capturedIds.slice(i, i + 200);
    await sb.from("document_versions").update({ archive_id: archiveId }).in("id", chunk).eq("org_id", orgId);
  }

  return new NextResponse(zipBytes as unknown as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${archiveId}.zip"`,
      "Cache-Control": "no-store",
      "X-Archive-Id": archiveId,
      "X-Archive-Files": String(bundled),
      "X-Archive-Bytes": String(bytes),
    },
  });
}
