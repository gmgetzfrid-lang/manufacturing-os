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
import { createHash } from "node:crypto";
import JSZip from "jszip";
import type { SupabaseClient } from "@supabase/supabase-js";
import { authorizeOrgRole } from "@/lib/serverAuth";
import { r2, R2_BUCKET } from "@/lib/r2";
import { selectShedCandidates, type ShedCandidateRow } from "@/lib/shed";
import { makeArchiveId, archiveLocation } from "@/lib/archive";
import { partitionOrgKeys, sharedLiveKeys } from "@/lib/shedKeyGuard";
import { keysReferencedOutside } from "@/lib/storageKeyRegistry";

export const runtime = "nodejs";

const SHED_ROLES = ["Admin", "DocCtrl"];
const DEFAULT_KEEP = 5;
// Produce builds the zip fully in memory (JSZip + per-file buffers). Cap one
// archive so a mature org's first-ever shed can't OOM the runtime — the UI
// chunks: produce → save → commit → produce again for the rest.
const MAX_PRODUCE_BYTES = 1_500_000_000; // 1.5 GB per archive

function clampKeep(raw: unknown): number {
  const n = Number(raw);
  return Number.isFinite(n) ? Math.max(1, Math.min(100, Math.floor(n))) : DEFAULT_KEEP;
}
function parseBytes(raw: unknown): number | null {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}
function clampTarget(raw: unknown): number {
  const n = parseBytes(raw);
  return n == null ? MAX_PRODUCE_BYTES : Math.min(n, MAX_PRODUCE_BYTES);
}

async function fetchCandidates(sb: SupabaseClient, orgId: string): Promise<ShedCandidateRow[]> {
  // All non-archived revisions (current + superseded) so the keep-last-N grouping
  // can see each document's full recent history.
  const { data } = await sb
    .from("document_versions")
    .select("id, file_url, size, superseded_at, archive_id, created_at, revision_label, record_id, file_hash")
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
  const rows = ((data as ShedCandidateRow[] | null) ?? []).filter((r) => r.record_id);

  // RET-1: a version whose parent document is under LEGAL HOLD is never a shed
  // candidate. The hold triggers guard row DELETEs only — the shed deletes R2
  // bytes, which they never see — so the hold must be honored here. Fail
  // CLOSED: if the hold read errors, offer no candidates rather than shedding
  // possibly-held evidence.
  const { data: held, error: heldErr } = await sb
    .from("documents")
    .select("id")
    .eq("org_id", orgId)
    .eq("legal_hold", true);
  if (heldErr) {
    throw new Error(`Couldn't verify legal holds (${heldErr.message}); refusing to select candidates.`);
  }
  const heldIds = new Set(((held as Array<{ id: string }> | null) ?? []).map((d) => d.id));
  return heldIds.size === 0 ? rows : rows.filter((r) => !heldIds.has(r.record_id as string));
}

/** The storage-key guards, applied to a selection BEFORE anything is
 *  claimed (RET-6 / RET-8, see lib/shedKeyGuard.ts; intelligence ILIFE-5):
 *    · a key outside `orgs/<orgId>/` (or unsafe) is never read or claimed —
 *      a member can repoint file_url via PostgREST, and the archive must not
 *      become the exfiltration channel;
 *    · a key still referenced by a NON-archived row outside the selection
 *      (a revert's current revision shares the reverted-to key) is never
 *      claimed — freeing it would delete the current revision's bytes;
 *    · a key any other registered key column still names — above all a
 *      knowledge-library mirror (`knowledge_documents.file_key`), which names
 *      the SAME object as the revision it mirrors until the next sync — is
 *      never claimed (lib/storageKeyRegistry.ts keysReferencedOutside).
 *  Both counted in `sharedSkipped`. Throws when either read fails (fail
 *  closed). */
async function refineSelection(sb: SupabaseClient, orgId: string, selected: ShedCandidateRow[]): Promise<{
  rows: ShedCandidateRow[]; rejectedKeys: number; sharedSkipped: number;
}> {
  const { owned, rejected } = partitionOrgKeys(selected, orgId, (r) => r.file_url);
  const insideIds = new Set(owned.map((r) => r.id));
  const shared = await sharedLiveKeys(sb, orgId, owned.map((r) => r.file_url as string), insideIds);
  // ILIFE-5: a key a knowledge mirror (or any other registered column) still names is never claimed.
  const elsewhere = await keysReferencedOutside(sb, owned.map((r) => r.file_url as string), ["document_versions.file_url"]);
  const rows = owned.filter((r) => !shared.has(r.file_url as string) && !elsewhere.has(r.file_url as string));
  return { rows, rejectedKeys: rejected.length, sharedSkipped: owned.length - rows.length };
}

export async function GET(req: NextRequest) {
  const orgId = req.nextUrl.searchParams.get("orgId") || "";
  const keep = clampKeep(req.nextUrl.searchParams.get("keep"));
  const targetBytes = clampTarget(req.nextUrl.searchParams.get("targetBytes"));
  const actor = await authorizeOrgRole(req, orgId, SHED_ROLES);
  if ("error" in actor) return NextResponse.json({ error: actor.error }, { status: actor.status });

  let rows: ShedCandidateRow[];
  try {
    rows = await fetchCandidates(actor.admin, orgId);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 503 });
  }
  const sel = selectShedCandidates(rows, { keepPerDoc: keep, targetBytes });
  let refined: Awaited<ReturnType<typeof refineSelection>>;
  try {
    refined = await refineSelection(actor.admin, orgId, sel.selected);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 503 });
  }
  const selectedBytes = refined.rows.reduce((n, r) => n + (Number(r.size) || 0), 0);

  return NextResponse.json({
    keepPerDoc: keep,
    eligibleCount: refined.rows.length + sel.skipped,
    selectedCount: refined.rows.length,
    reclaimableBytes: selectedBytes,
    /** Eligible files beyond this archive's byte cap — produce again for these. */
    remainingCount: sel.skipped,
    /** RET-6: rows whose storage key is not under this org's prefix — never read, never freed. */
    rejectedKeys: refined.rejectedKeys,
    /** RET-8 / ILIFE-5: rows whose key a live revision outside the selection, or a knowledge-library copy, still names — left in place. */
    sharedSkipped: refined.sharedSkipped,
    maxArchiveBytes: MAX_PRODUCE_BYTES,
    sample: refined.rows.slice(0, 20).map((r) => ({
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
  const targetBytes = clampTarget(body.targetBytes);
  let rows: ShedCandidateRow[];
  try {
    rows = await fetchCandidates(sb, orgId);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 503 });
  }
  const sel = selectShedCandidates(rows, { keepPerDoc: keep, targetBytes });
  let refined: Awaited<ReturnType<typeof refineSelection>>;
  try {
    refined = await refineSelection(sb, orgId, sel.selected);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 503 });
  }
  const selected = refined.rows;
  if (selected.length === 0) {
    return NextResponse.json({
      error: "Nothing eligible to shed in this window.",
      rejectedKeys: refined.rejectedKeys, sharedSkipped: refined.sharedSkipped,
    }, { status: 400 });
  }

  const archiveId = makeArchiveId({ at: new Date(), token: (globalThis.crypto?.randomUUID?.() || "").replace(/-/g, "").slice(-8) || "00000000" });
  const selectedIds = selected.map((r) => r.id);

  // Reserve the archive label first — a collision (random 8-hex token) must ABORT,
  // not be swallowed, or two produces could share a label that commit frees together.
  const { error: catErr } = await sb.from("archives").insert({
    org_id: orgId, archive_id: archiveId, kind: "space",
    file_count: 0, total_bytes: 0,
    created_by: actor.userId, created_by_email: actor.email, note: "producing…",
  });
  if (catErr) return NextResponse.json({ error: "Archive label collision — please retry." }, { status: 409 });

  // CLAIM the versions atomically before bundling so two concurrent produces can't
  // grab the same rows and race the archive_id stamp. Captured versions keep this
  // archive_id; any unreadable binary is un-claimed after the loop.
  const claimedIds = new Set<string>();
  for (let i = 0; i < selectedIds.length; i += 200) {
    const chunk = selectedIds.slice(i, i + 200);
    const { data } = await sb
      .from("document_versions")
      .update({ archive_id: archiveId })
      .in("id", chunk).eq("org_id", orgId).is("archive_id", null).is("archived_at", null)
      .select("id");
    for (const v of ((data ?? []) as Array<{ id: string }>)) claimedIds.add(v.id);
  }
  if (claimedIds.size === 0) {
    await sb.from("archives").delete().eq("org_id", orgId).eq("archive_id", archiveId);
    return NextResponse.json({ error: "Those revisions were just archived by another run." }, { status: 409 });
  }

  // Build the space archive: every claimed binary, path-preserved under /files
  // so the in-memory viewer (findInBackup) opens it later by its storage key.
  const zip = new JSZip();
  const filesFolder = zip.folder("files");
  let bundled = 0, missed = 0, bytes = 0, unhashed = 0, hashMismatch = 0;
  const capturedIds: string[] = [];
  // Integrity manifest (RET-12): key → the SHA-256 of the bytes ACTUALLY
  // captured, beside the DB's recorded hash, so a re-opened zip is verified
  // against what was bundled — not against a claim the DB made at upload.
  const manifest: Record<string, { sha256: string | null; dbSha256: string | null; size: number; revision: string | null; versionId: string; documentId: string | null }> = {};
  for (const r of selected) {
    if (!claimedIds.has(r.id)) continue;
    const key = r.file_url as string;
    try {
      const obj = await r2.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }));
      const buf = await obj.Body!.transformToByteArray();
      const computed = createHash("sha256").update(buf).digest("hex");
      const recorded = (r.file_hash as string | null) ?? null;
      if (recorded && recorded.toLowerCase() !== computed) {
        // The live object is not the bytes the record says it is (a repointed
        // key, a truncated upload). Commit must never free it on the strength
        // of this zip: leave it un-claimed and un-bundled, and say so.
        hashMismatch++;
        continue;
      }
      if (!recorded) unhashed++;
      filesFolder?.file(key, buf);
      manifest[key] = {
        sha256: computed,
        dbSha256: recorded,
        size: buf.byteLength,
        revision: (r.revision_label as string | null) ?? null,
        versionId: r.id,
        documentId: (r.record_id as string | null) ?? null,
      };
      bundled++; bytes += buf.byteLength; capturedIds.push(r.id);
    } catch {
      missed++; // can't capture → leave it untouched (never linked, never deleted)
    }
  }
  zip.file("files-manifest.json", JSON.stringify(manifest, null, 2));
  // Un-claim any version we claimed but couldn't read (unreadable binary) so it
  // returns to the eligible pool instead of being stranded with this archive_id.
  const capturedSet = new Set(capturedIds);
  const toUnclaim = Array.from(claimedIds).filter((id) => !capturedSet.has(id));
  for (let i = 0; i < toUnclaim.length; i += 200) {
    const chunk = toUnclaim.slice(i, i + 200);
    await sb.from("document_versions").update({ archive_id: null }).in("id", chunk).eq("org_id", orgId).eq("archive_id", archiveId).is("archived_at", null);
  }
  if (bundled === 0) {
    await sb.from("archives").delete().eq("org_id", orgId).eq("archive_id", archiveId);
    return NextResponse.json({ error: "Could not read any selected binaries from storage." }, { status: 502 });
  }

  // Name the EXACT save path using the org's configured archive root — a
  // literal "<root>" placeholder makes admins guess.
  const { data: locRow } = await sb.from("archive_settings").select("location_hint").eq("org_id", orgId).maybeSingle();
  const savePath = archiveLocation((locRow as { location_hint?: string | null } | null)?.location_hint, "space", archiveId);
  zip.file("ARCHIVE.txt",
    `Space-saver archive ${archiveId}\nProduced ${new Date().toISOString()}\nOrg ${orgId}\n` +
    `${bundled} file(s), ${bytes} bytes.\nSave this as ${savePath} and keep it — ` +
    `it's the only copy of these superseded revisions once space is reclaimed.\n` +
    `Integrity: files-manifest.json records the SHA-256 of the bytes captured (sha256) beside the ` +
    `hash the database recorded at upload (dbSha256). ${unhashed} file(s) had no recorded hash; ` +
    `${hashMismatch} file(s) whose live bytes disagreed with their recorded hash were NOT captured and stay in live storage; ` +
    `${refined.rejectedKeys} row(s) with a storage key outside this workspace were refused; ` +
    `${refined.sharedSkipped} row(s) whose key a current revision or a knowledge-library copy still names were left in place.\n`);
  const zipBytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE", compressionOptions: { level: 6 } });

  // Finalize the catalog counts (reserved + versions already claimed above).
  const noteExtras = [
    missed ? `${missed} unreadable, left in place` : "",
    hashMismatch ? `${hashMismatch} hash mismatch, left in place` : "",
    unhashed ? `${unhashed} without a recorded hash` : "",
  ].filter(Boolean);
  await sb.from("archives").update({
    file_count: bundled, total_bytes: bytes,
    note: `${bundled} superseded revision binaries${noteExtras.length ? ` (${noteExtras.join("; ")})` : ""}`,
  }).eq("org_id", orgId).eq("archive_id", archiveId);

  return new NextResponse(zipBytes as unknown as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${archiveId}.zip"`,
      "Cache-Control": "no-store",
      "X-Archive-Id": archiveId,
      "X-Archive-Files": String(bundled),
      "X-Archive-Bytes": String(bytes),
      "X-Archive-Remaining": String(sel.skipped),
      "X-Archive-Unhashed": String(unhashed),
      "X-Archive-Hash-Mismatch": String(hashMismatch),
      "X-Archive-Rejected-Keys": String(refined.rejectedKeys),
      "X-Archive-Shared-Skipped": String(refined.sharedSkipped),
    },
  });
}
