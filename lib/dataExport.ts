// lib/dataExport.ts
//
// Full-org data export. Used by the /api/data-export/structured endpoint
// to produce a single self-describing JSON document containing every
// record an organization owns, plus a file manifest with presigned
// download URLs for every storage object.
//
// Design goals:
//   1. Self-describing — the document can be read on its own without any
//      knowledge of this codebase. Schema version + table column lists
//      live in the manifest.
//   2. Portable — vanilla JSON. No proprietary encoding, no compression
//      step required. The customer can `cat | jq` their data five years
//      from now without any of our tooling.
//   3. Auditable — running an export is itself a logged action
//      (DATA_EXPORT in audit_logs) so the chain-of-custody is visible.
//
// The endpoint uses the Supabase service-role key to bypass RLS, so this
// function MUST be called from a server context that has already
// verified the caller is an org admin.

import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { r2, R2_BUCKET } from "@/lib/r2";

// The table lists live in lib/exportTables.ts (dependency-free) so the
// coverage tripwire test can import them without pulling in AWS clients.
// Adding a table to the schema without deciding its backup fate fails the
// test suite — see that file for the contract.
import { ORG_SCOPED_TABLES, USER_SCOPED_FOR_ORG_TABLES } from "@/lib/exportTables";
export { ORG_SCOPED_TABLES, USER_SCOPED_FOR_ORG_TABLES, EXPORT_EXCLUDED_TABLES } from "@/lib/exportTables";

export interface DataExportManifest {
  schemaVersion: string;
  exportedAt: string;
  orgId: string;
  orgName?: string;
  exportedBy: { userId: string; email: string };
  /** Per-table outcome. `error` is set when a table could not be exported
   *  (e.g. it isn't org_id-scoped) — its data is NOT in this backup. */
  tables: Array<{ name: string; rowCount: number; error?: string }>;
  /** True when every listed table exported cleanly. False = INCOMPLETE backup. */
  complete: boolean;
  files: {
    count: number;
    /** Files referenced by a record but not found in storage (no URL). */
    missing: number;
    /** Files shed to offline space archives — expected to be absent from
     *  cloud storage; they live in the org's <root>/data/<archive>.zip files. */
    archivedOffline: number;
    totalBytes: number;
    presignedUrlExpiresIn: number;
  };
  /** Space archives (offline zips) that hold binaries this backup can't
   *  include. Full coverage = this backup + these zips. */
  spaceArchives: string[];
  notes: string[];
}

export interface DataExportEnvelope {
  manifest: DataExportManifest;
  tables: Record<string, unknown[]>;
  files: Array<{
    path: string;
    size: number | null;
    contentType?: string | null;
    createdAt?: string | null;
    presignedUrl: string;
  }>;
}

/**
 * Run a full export. Caller must have already verified the user is an
 * admin of the given org_id.
 */
export async function runOrgExport(params: {
  supabaseUrl: string;
  serviceRoleKey: string;
  orgId: string;
  exporterUserId: string;
  exporterEmail: string;
  presignedUrlSeconds?: number;
}): Promise<DataExportEnvelope> {
  const expiresIn = params.presignedUrlSeconds ?? 24 * 60 * 60;
  const sb: SupabaseClient = createClient(params.supabaseUrl, params.serviceRoleKey, {
    auth: { persistSession: false },
  });

  const startedAt = new Date().toISOString();

  // 1. Dump every org-scoped table
  const tables: Record<string, unknown[]> = {};
  const tableCounts: Array<{ name: string; rowCount: number; error?: string }> = [];
  for (const tbl of ORG_SCOPED_TABLES) {
    try {
      const rows = await dumpTable(sb, tbl, "org_id", params.orgId);
      tables[tbl] = rows;
      tableCounts.push({ name: tbl, rowCount: rows.length });
    } catch (e) {
      // A table we couldn't export (e.g. not org_id-scoped) is RECORDED as an
      // error, not silently treated as empty — a backup must never hide a gap.
      tables[tbl] = [];
      tableCounts.push({ name: tbl, rowCount: 0, error: (e as Error).message });
      console.warn(`[dataExport] table ${tbl} FAILED:`, (e as Error).message);
    }
  }

  // 2. User-scoped tables (notification_preferences) — fetched per member
  for (const tbl of USER_SCOPED_FOR_ORG_TABLES) {
    try {
      const memberIds = ((tables.org_members as Array<{ uid: string }>) ?? [])
        .map((r) => r.uid)
        .filter(Boolean);
      const rows = memberIds.length === 0
        ? []
        : await dumpTable(sb, tbl, "user_id", memberIds, true);
      tables[tbl] = rows;
      tableCounts.push({ name: tbl, rowCount: rows.length });
    } catch {
      tables[tbl] = [];
      tableCounts.push({ name: tbl, rowCount: 0 });
    }
  }

  // 3. File manifest: walk every storage path referenced by document_versions,
  //    ticket attachments, equipment photos, plot plans, markup-request shared
  //    files, folder/library covers, and the org logo. Files live in Cloudflare
  //    R2 (the S3 API) — the same backend the app uploads to — so URLs MUST be
  //    signed against R2, not Supabase Storage. (Signing against Supabase
  //    Storage was the bug that produced "complete" backups containing no
  //    binaries.) We never inline bytes in the JSON; the customer downloads
  //    each file via its presigned URL, and the ZIP export embeds them.
  //
  //    Binaries already shed to offline space archives are EXPECTED to be
  //    absent from cloud storage — they're accounted separately (which zips
  //    hold them) instead of being miscounted as "missing".
  const shedInfo = collectShedOffline(tables);
  const fileRefs = collectFilePaths(tables).filter((r) => !shedInfo.keys.has(r.path));
  const files: DataExportEnvelope["files"] = [];
  let totalBytes = 0;
  let missingFiles = 0;
  for (const ref of fileRefs) {
    const { path } = ref;
    // Presigning an R2 GET is a local crypto op (no network), so it always
    // yields a URL; the download itself is the final arbiter of existence.
    let presignedUrl = "";
    try {
      presignedUrl = await getSignedUrl(
        r2,
        new GetObjectCommand({ Bucket: R2_BUCKET, Key: path }),
        { expiresIn },
      );
    } catch {
      presignedUrl = "";
    }
    // Prefer the size already recorded on the row; only reach out to R2
    // (HeadObject) when we don't know it — that both confirms the object
    // exists and picks up its content type.
    let size: number | null = ref.size ?? null;
    let contentType: string | null = null;
    let createdAt: string | null = null;
    if (size == null) {
      try {
        const head = await r2.send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: path }));
        size = typeof head.ContentLength === "number" ? head.ContentLength : null;
        contentType = head.ContentType ?? null;
        createdAt = head.LastModified ? head.LastModified.toISOString() : null;
      } catch {
        // Object is missing in R2 (legacy / broken record). Keep it in the
        // manifest with no URL so the gap is visible, never silently dropped.
        size = null;
        presignedUrl = "";
        missingFiles++;
      }
    }
    if (size) totalBytes += Number(size);
    files.push({ path, size, contentType, createdAt, presignedUrl });
  }

  // 4. Audit row — running an export is itself a tracked event.
  try {
    await sb.from("audit_logs").insert({
      action: "DATA_EXPORT",
      resource_id: params.orgId,
      resource_type: "org",
      org_id: params.orgId,
      user_id: params.exporterUserId,
      user_email: params.exporterEmail,
      details: {
        tableCount: tableCounts.length,
        totalRows: tableCounts.reduce((s, t) => s + t.rowCount, 0),
        fileCount: files.length,
        totalBytes,
        startedAt,
      },
    });
  } catch (e) {
    console.warn("[dataExport] audit insert failed", e);
  }

  // Look up org name for the manifest header
  let orgName: string | undefined;
  try {
    const { data } = await sb.from("orgs").select("name").eq("id", params.orgId).maybeSingle();
    orgName = (data as { name?: string } | null)?.name;
  } catch {}

  const failedTables = tableCounts.filter((t) => t.error);
  const notes: string[] = [];
  if (failedTables.length > 0) {
    notes.push(
      `⚠ INCOMPLETE BACKUP — ${failedTables.length} table(s) could not be exported and their data is NOT included: ` +
      `${failedTables.map((t) => t.name).join(", ")}. See each table's "error" in tables[] (most likely they aren't org_id-scoped and need parent-keyed export). Resolve before relying on this as a full backup.`,
    );
  } else {
    notes.push("This document is a complete export of every record this organization owns.");
  }
  if (missingFiles > 0) {
    notes.push(
      `⚠ ${missingFiles} referenced file(s) were not found in storage and have no download URL ` +
      `(their record is still included). They are likely legacy/orphaned references. ` +
      `${files.length - missingFiles} of ${files.length} files are downloadable.`,
    );
  }
  if (shedInfo.keys.size > 0) {
    notes.push(
      `${shedInfo.keys.size} file(s) were previously archived OFFLINE to reclaim cloud storage; they are not in cloud ` +
      `storage or this backup (their records ARE included). Full binary coverage = this backup PLUS the space ` +
      `archive zip(s): ${shedInfo.archiveIds.join(", ") || "(archive ids unrecorded)"} — kept under <archive root>/data/<id>.zip ` +
      `per your archive settings.`,
    );
  }
  notes.push(
    "Every column from the source schema is preserved verbatim. JSON keys mirror Postgres column names (snake_case).",
    `Presigned URLs for files expire ${expiresIn} seconds (${(expiresIn / 3600).toFixed(1)} hours) from exportedAt.`,
    "Re-running an export at any time is free and unlimited.",
    "The schema DDL for this snapshot is bundled in the ZIP under schema/ (base schema.sql + migrations/).",
  );

  const manifest: DataExportManifest = {
    schemaVersion: "manufacturing-os/2026-07-10",
    exportedAt: startedAt,
    orgId: params.orgId,
    orgName,
    exportedBy: { userId: params.exporterUserId, email: params.exporterEmail },
    tables: tableCounts,
    complete: failedTables.length === 0,
    files: {
      count: files.length,
      missing: missingFiles,
      archivedOffline: shedInfo.keys.size,
      totalBytes,
      presignedUrlExpiresIn: expiresIn,
    },
    spaceArchives: shedInfo.archiveIds,
    notes,
  };

  return { manifest, tables, files };
}

/** Storage keys whose binaries were shed to offline space archives (plus the
 *  archive ids that hold them). These are expected to be absent from cloud
 *  storage — a backup must report them as "in your offline zips", not lose
 *  them in the generic "missing" bucket. */
function collectShedOffline(tables: Record<string, unknown[]>): { keys: Set<string>; archiveIds: string[] } {
  const keys = new Set<string>();
  const ids = new Set<string>();
  for (const row of (tables.document_versions as Array<{ file_url?: string; archived_at?: string | null; archive_id?: string | null }>) ?? []) {
    if (row.archived_at && row.file_url) {
      keys.add(row.file_url);
      if (row.archive_id) ids.add(row.archive_id);
    }
  }
  for (const t of (tables.tickets as Array<{ archived_at?: string | null; archive_id?: string | null; attachments?: Array<{ url?: string }> }>) ?? []) {
    if (!t.archived_at) continue;
    if (t.archive_id) ids.add(t.archive_id);
    for (const att of t.attachments ?? []) {
      if (att?.url) keys.add(att.url);
    }
  }
  return { keys, archiveIds: Array.from(ids).sort() };
}

async function dumpTable(
  sb: SupabaseClient,
  table: string,
  column: string,
  value: string | string[],
  arrayValue = false,
): Promise<unknown[]> {
  const pageSize = 1000;
  const out: unknown[] = [];
  let from = 0;
  // Loop until we get a short page
  // (Supabase caps single requests; this paginates explicitly.)
   
  while (true) {
    let q = sb.from(table).select("*").range(from, from + pageSize - 1);
    if (arrayValue && Array.isArray(value)) {
      q = q.in(column, value);
    } else {
      q = q.eq(column, value as string);
    }
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < pageSize) break;
    from += pageSize;
  }
  return out;
}

export function collectFilePaths(tables: Record<string, unknown[]>): Array<{ path: string; size: number | null }> {
  // Dedupe by R2 key, preferring a known byte size over null so we can skip a
  // HeadObject round-trip when the row already recorded it.
  const map = new Map<string, number | null>();
  const add = (path: string | undefined | null, size?: number | null) => {
    if (!path) return;
    // Only storage KEYS belong here — some columns (covers, legacy rows) may
    // hold full URLs or data URIs, which can't be signed as R2 keys.
    if (/^(https?:|blob:|data:)/i.test(path)) return;
    if (!map.has(path)) { map.set(path, size ?? null); return; }
    if (map.get(path) == null && size != null) map.set(path, size);
  };

  // Document versions store file_url (the R2 key) and a recorded byte size.
  for (const row of (tables.document_versions as Array<{ file_url?: string; size?: number }>) ?? []) {
    add(row.file_url, row.size ?? null);
  }
  // Ticket attachments are nested in JSONB; a size may travel with them.
  for (const t of (tables.tickets as Array<{ attachments?: Array<{ url?: string; size?: number }> }>) ?? []) {
    for (const att of t.attachments ?? []) add(att.url, att.size ?? null);
  }
  // Markup-request shared files
  for (const r of (tables.markup_requests as Array<{ shared_markup_url?: string }>) ?? []) {
    add(r.shared_markup_url);
  }
  // Equipment photos (byte size lives in file_size on this table)
  for (const p of (tables.asset_photos as Array<{ file_url?: string; file_size?: number }>) ?? []) {
    add(p.file_url, p.file_size ?? null);
  }
  // Plot-plan / P&ID background images
  for (const pp of (tables.plot_plans as Array<{ image_path?: string }>) ?? []) {
    add(pp.image_path);
  }
  // Library + folder cover images (skipped automatically when the field holds
  // a pasted external URL rather than an uploaded storage key)
  for (const l of (tables.libraries as Array<{ cover_image_url?: string | null }>) ?? []) {
    add(l.cover_image_url);
  }
  for (const c of (tables.collections as Array<{ cover_image_url?: string | null }>) ?? []) {
    add(c.cover_image_url);
  }
  // Org branding logo — org_configurations row {key:'branding', data:{logoPath}}
  for (const cfg of (tables.org_configurations as Array<{ key?: string; data?: { logoPath?: string } | null }>) ?? []) {
    if (cfg?.key === "branding") add(cfg.data?.logoPath);
  }

  return Array.from(map.entries()).map(([path, size]) => ({ path, size }));
}
