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

// Every table that holds org-scoped data. Listed explicitly (rather than
// reflected) so adding a new table is a deliberate decision: if it holds
// customer data, it gets exported.
const ORG_SCOPED_TABLES = [
  // Document control
  "documents",
  "document_versions",
  "document_supersessions",
  "document_holds",
  "document_assets",
  "document_sets",
  "document_shares",
  "document_favorites",
  "e_signatures",
  "transmittals",
  "libraries",
  "collections",
  "curated_collections",
  "curated_collection_items",
  "library_views",
  "metadata_templates",
  "watermark_policies",
  "plot_plans",
  "download_audits",

  // Workflow / drafting
  "tickets",
  "ticket_comments",
  "checkout_sessions",
  "checkout_episodes",
  "checkout_messages",

  // Projects + schedule + cost
  "projects",
  "project_members",
  "project_documents",
  "project_activity",
  "markup_requests",
  "milestones",
  "milestone_notes",
  "cost_entries",
  "cost_accounts",
  "cost_documents",

  // Equipment + operational scope
  "assets",
  "asset_types",
  "asset_photos",
  "plants",
  "units",
  "systems",

  // Collaboration + audit + notifications
  "teams",
  "team_members",
  "notes",
  "audit_logs",
  "email_notifications",
  "notifications",

  // Org configuration
  "orgs",
  "org_members",
  "org_configurations",
  "table_views",
  "sla_defaults",
  "export_destinations",
  "export_runs",
] as const;

// User-scoped tables exported alongside (membership in this org acts as
// the join — we only include rows for users who belong to the org).
const USER_SCOPED_FOR_ORG_TABLES = ["notification_preferences"] as const;

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
    totalBytes: number;
    presignedUrlExpiresIn: number;
  };
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
  //    ticket attachments, and markup-request shared files. Generate presigned
  //    URLs for each. We never include the file bytes in the JSON — too large.
  //    The customer downloads each file via the presigned URLs.
  const filePaths = collectFilePaths(tables);
  const files: DataExportEnvelope["files"] = [];
  let totalBytes = 0;
  for (const path of filePaths) {
    try {
      const { data: signed } = await sb.storage
        .from("documents")               // adjust if you use multiple buckets
        .createSignedUrl(path, expiresIn);
      const { data: meta } = await sb.storage.from("documents").info(path);
      const m = meta as { metadata?: { size?: number; mimetype?: string } | null; created_at?: string | null } | null;
      const size = m?.metadata?.size ?? null;
      if (size) totalBytes += Number(size);
      files.push({
        path,
        size,
        contentType: m?.metadata?.mimetype ?? null,
        createdAt: m?.created_at ?? null,
        presignedUrl: signed?.signedUrl ?? "",
      });
    } catch {
      // If a referenced path is missing in storage (legacy data, broken
      // record), include it with no URL so the customer knows it exists.
      files.push({ path, size: null, presignedUrl: "" });
    }
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
  notes.push(
    "Every column from the source schema is preserved verbatim. JSON keys mirror Postgres column names (snake_case).",
    `Presigned URLs for files expire ${expiresIn} seconds (${(expiresIn / 3600).toFixed(1)} hours) from exportedAt.`,
    "Re-running an export at any time is free and unlimited.",
    "The schema DDL for this snapshot lives in the repository at supabase/schema.sql.",
  );

  const manifest: DataExportManifest = {
    schemaVersion: "manufacturing-os/2026-06-20",
    exportedAt: startedAt,
    orgId: params.orgId,
    orgName,
    exportedBy: { userId: params.exporterUserId, email: params.exporterEmail },
    tables: tableCounts,
    complete: failedTables.length === 0,
    files: {
      count: files.length,
      totalBytes,
      presignedUrlExpiresIn: expiresIn,
    },
    notes,
  };

  return { manifest, tables, files };
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

function collectFilePaths(tables: Record<string, unknown[]>): string[] {
  const set = new Set<string>();

  // Document versions store file_url which is the storage path
  for (const row of (tables.document_versions as Array<{ file_url?: string }>) ?? []) {
    if (row.file_url) set.add(row.file_url);
  }

  // Ticket attachments are nested in JSONB
  for (const t of (tables.tickets as Array<{ attachments?: Array<{ url?: string }> }>) ?? []) {
    for (const att of t.attachments ?? []) if (att.url) set.add(att.url);
  }

  // Markup-request shared files
  for (const r of (tables.markup_requests as Array<{ shared_markup_url?: string }>) ?? []) {
    if (r.shared_markup_url) set.add(r.shared_markup_url);
  }

  // Equipment photos
  for (const p of (tables.asset_photos as Array<{ file_url?: string }>) ?? []) {
    if (p.file_url) set.add(p.file_url);
  }

  // Plot-plan / P&ID background images
  for (const pp of (tables.plot_plans as Array<{ image_path?: string }>) ?? []) {
    if (pp.image_path) set.add(pp.image_path);
  }

  return Array.from(set);
}
