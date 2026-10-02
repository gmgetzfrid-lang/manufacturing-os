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
// verified the caller is an org admin (admin-and-org BKP-8: every export
// route is held to the Admin-only data-export surface, lib/adminSurfaces.ts,
// through lib/adminGate.ts — an Admin is in the controller tier, so the
// ACL-restricted documents the service role reads are ones the exporter may
// read anyway; DEC-43). Standalone notes — each author's private scratchpad,
// which RLS keeps from every other member — are still carried, so a restore
// brings them back: whether to keep carrying them is the user's open
// decision (DEC-44 (A&O P3) §4). Until then the Admin-only gate is the
// mitigation, and the manifest and the DATA_EXPORT row count them.

import { createHash, randomUUID } from "node:crypto";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { r2, R2_BUCKET } from "@/lib/r2";
import { presignedGetDisposition } from "@/lib/presignedDisposition";

// The table lists live in lib/exportTables.ts (dependency-free) so the
// coverage tripwire test can import them without pulling in AWS clients.
// Adding a table to the schema without deciding its backup fate fails the
// test suite — see that file for the contract.
import { ORG_SCOPED_TABLES, USER_SCOPED_FOR_ORG_TABLES, REDACT_COLUMNS, EXPORT_KEYED_BY, exportOrderKey, redactRow } from "@/lib/exportTables";
export { ORG_SCOPED_TABLES, USER_SCOPED_FOR_ORG_TABLES, EXPORT_EXCLUDED_TABLES, REDACT_COLUMNS } from "@/lib/exportTables";
// BKP-2 / BKP-9: the file manifest reads the ONE storage-key registry the
// orphan sweep reads too — a key column registered there is in every backup
// and protected from the sweep, both at once.
import { STORAGE_KEY_SOURCES, STORAGE_KEY_COLUMNS, keysOf, findUnregisteredOrgKeys } from "@/lib/storageKeyRegistry";
import { orgKeyPrefix } from "@/lib/shedKeyGuard";

/** How many storage HeadObject checks the export runs at once. A file whose
 *  row records no byte size (every ticket attachment records it as text;
 *  native sources, quotes and templates record none) is checked against
 *  storage for its size and existence. One at a time, a workspace with
 *  thousands of attachments spent minutes here inside routes capped at
 *  maxDuration = 300 (structured, run, run-scheduled). */
export const FILE_CHECK_CONCURRENCY = 24;
/** Wall-clock budget for those checks. A file not checked when it runs out
 *  keeps its download URL, carries no size, and is counted `unchecked`. */
export const FILE_CHECK_BUDGET_MS = 90_000;
/** The checks' hard ceiling, counted from the moment runOrgExport STARTS (not
 *  from the start of the file phase): no check starts later than this, however
 *  long the table dump took. The three callers run under maxDuration = 300
 *  and still have to build and deliver the export after it returns, so a slow
 *  dump spends the checks' time, never the route's. A caller that knows its
 *  own start passes a tighter `deadlineAt`. */
export const FILE_CHECK_CEILING_MS = 150_000;

export interface DataExportManifest {
  schemaVersion: string;
  exportedAt: string;
  orgId: string;
  orgName?: string;
  /** userId null: a run no person started (the scheduled push) — DEC-44 (A&O P3). */
  exportedBy: { userId: string | null; email: string };
  /** Per-table outcome. `error` is set when a table could not be exported
   *  (e.g. it isn't org_id-scoped) — its data is NOT in this backup. `short`
   *  is set when the table WAS exported but its read came up short of the
   *  table's own count twice while the export ran (intelligence ILIFE-6): the
   *  rows read ARE in this backup, and some rows may be missing. */
  tables: Array<{ name: string; rowCount: number; error?: string; short?: string }>;
  /** True when every listed table exported cleanly and in full. False = INCOMPLETE backup. */
  complete: boolean;
  files: {
    count: number;
    /** Files referenced by a record but not found in storage (no URL). */
    missing: number;
    /** BKP-9: files under this workspace's prefix that a value scan of the
     *  exported rows found in a column the storage-key registry does not
     *  list. Each is in `files` (with a URL when storage has it; counted in
     *  `missing`, with no URL, when it does not); this says how many no
     *  registered column named. */
    unregistered: number;
    /** Files listed with a URL but no size because the export's storage
     *  check ran out of time (FILE_CHECK_BUDGET_MS) before reaching them, or
     *  the check failed with an error other than not-found (a throttle,
     *  timeout or 5xx) — not verified, and not counted in `missing` even if
     *  absent. */
    unchecked: number;
    /** Files shed to offline space archives — expected to be absent from
     *  cloud storage; they live in the org's <root>/data/<archive>.zip files. */
    archivedOffline: number;
    totalBytes: number;
    presignedUrlExpiresIn: number;
  };
  /** Space archives (offline zips) that hold binaries this backup can't
   *  include. Full coverage = this backup + these zips. */
  spaceArchives: string[];
  /** EGR-7 / XEDGE-10: credential columns that were NULLED in this export,
   *  per table, so a restore knows shares / intake links / portal links must
   *  be re-issued and destination credentials re-entered rather than
   *  silently arriving dead. */
  redactedColumns: Record<string, string[]>;
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
  /** null for a run no person started (the scheduled push): its audit rows
   *  carry no user id and name the machine instead (DEC-44 (A&O P3)). */
  exporterUserId: string | null;
  exporterEmail: string;
  /** Recorded as the DATA_EXPORT row's user_role (BKP-8): the exporter's
   *  headline role, or "system" for a machine run. */
  exporterRole?: string | null;
  /** Extra facts for the DATA_EXPORT row's details (the delivery channel, a
   *  scheduled destination and who configured it). */
  auditDetails?: Record<string, unknown>;
  /** Which ledger the handed-out files are named against (DEC-44 (A&O P3)
   *  §3) — what was added or removed since that ledger's previous record (a
   *  chained delta), and a new full list (a baseline) only when the chain
   *  since the last one would grow past half the list or
   *  LEDGER_CHAIN_MAX_ROWS rows (recordExport). "workspace" (default): an
   *  export handed to a person — the JSON download, the browser-built Full
   *  ZIP, the manual ZIP — on the workspace's own ledger, shared by every
   *  person's export. `{ destinationId }`: a push to a destination, a bucket
   *  or a webhook, scheduled or Run Now — on that destination's ledger.
   *  Every file that left is named either way; neither writes the whole list
   *  on every run (audit_logs is itself exported, and read whole by every
   *  later export). */
  fileRecord?: "workspace" | { destinationId: string };
  /** The record id this export's DATA_EXPORT row (and its file rows) carry —
   *  the caller's, so a delivery that fails later can be recorded against it
   *  (recordExportUndelivered). Default: a fresh one. */
  recordId?: string;
  /** Called once the DATA_EXPORT row is written, with its record id: from
   *  then on the audit trail says this export left, so a caller whose export
   *  then fails (a refused file list, a ZIP that could not be built, a
   *  delivery refused) records that it did not (recordExportUndelivered). */
  onRecorded?: (recordId: string) => void;
  presignedUrlSeconds?: number;
  /** Override FILE_CHECK_BUDGET_MS (tests). */
  fileCheckBudgetMs?: number;
  /** Absolute time (epoch ms) after which no storage check starts — the
   *  caller's own deadline, already less what it needs after the export
   *  returns (e.g. route start + 240 s). Capped by FILE_CHECK_CEILING_MS from
   *  this call's start either way. */
  deadlineAt?: number;
}): Promise<DataExportEnvelope> {
  const exportStart = Date.now();
  const expiresIn = params.presignedUrlSeconds ?? 24 * 60 * 60;
  const sb: SupabaseClient = createClient(params.supabaseUrl, params.serviceRoleKey, {
    auth: { persistSession: false },
  });

  const startedAt = new Date().toISOString();

  // 1. Dump every org-scoped table
  const tables: Record<string, unknown[]> = {};
  const tableCounts: DataExportManifest["tables"] = [];
  for (const tbl of ORG_SCOPED_TABLES) {
    try {
      const read = await dumpOrgTable(sb, tbl, params.orgId, tables, tableCounts);
      tables[tbl] = read.rows;
      tableCounts.push(outcomeOf(tbl, read));
    } catch (e) {
      // A table we couldn't export (e.g. not org_id-scoped) is RECORDED as an
      // error, not silently treated as empty — a backup must never hide a gap.
      tables[tbl] = [];
      tableCounts.push({ name: tbl, rowCount: 0, error: (e as Error).message });
      console.warn(`[dataExport] table ${tbl} FAILED:`, (e as Error).message);
    }
  }

  // 2. User-scoped tables (notification_preferences) — read through this
  //    workspace's members, PARENT_ID_CHUNK ids per `.in()` exactly as a
  //    parent-keyed child is (dumpThroughParent): one read of every member id
  //    put a ~400-member workspace's URL past what the server accepts, and the
  //    refused read stamped every backup INCOMPLETE.
  for (const tbl of USER_SCOPED_FOR_ORG_TABLES) {
    try {
      const members = tableCounts.find((t) => t.name === "org_members");
      if (!members || members.error || !Object.prototype.hasOwnProperty.call(tables, "org_members")) {
        throw new Error("its parent table org_members was not exported, so its rows cannot be scoped to this workspace");
      }
      const memberIds = Array.from(new Set(
        (tables.org_members as Array<{ uid?: unknown }>)
          .map((r) => r?.uid)
          .filter((v): v is string => typeof v === "string" && v.length > 0),
      ));
      const read = await dumpThroughParent(sb, tbl, "user_id", "org_members", members, memberIds);
      tables[tbl] = read.rows;
      tableCounts.push(outcomeOf(tbl, read));
    } catch (e) {
      // Recorded like an org-scoped table's failure: a read error here is a
      // gap in the backup, never an empty table in a "complete" one.
      tables[tbl] = [];
      tableCounts.push({ name: tbl, rowCount: 0, error: (e as Error).message });
      console.warn(`[dataExport] table ${tbl} FAILED:`, (e as Error).message);
    }
  }

  // BKP-8 Done-when 2 (OPEN — DEC-44 (A&O P3) §4): a standalone note (no
  // document, project or asset) is its author's private scratchpad — RLS
  // (notes_standalone_own, 20260630) admits only created_by. The dump runs as
  // the service role, so it carries every member's. Withholding them would
  // make every backup lose them on restore (the second review fix pass undid
  // that), so they are carried as before this package and counted: the
  // manifest says the archive holds them, and the DATA_EXPORT row records how
  // many left. The user decides whether to withhold them or carry them
  // encrypted to their authors.
  const privateNotes = countPrivateNotes(tables);

  // 3. File manifest: every storage key the exported rows reference, read
  //    through lib/storageKeyRegistry.ts (document revisions and their native
  //    CAD sources, knowledge-library PDFs, output templates, vendor quotes,
  //    ticket attachments, equipment photos, plot plans, markup-request shared
  //    files, folder/library covers, the org logo). Files live in Cloudflare
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
  const registered = collectFilePaths(tables);
  // BKP-9 Done-when 3: a key no registered column names is not silently
  // left out. A value scan of every exported row finds keys under this
  // workspace's prefix that the registry did not collect; they are carried
  // (head-checked like the rest — counted in `missing` when storage lacks
  // them) and counted and named in the manifest.
  const knownKeys = new Set<string>([...registered.map((r) => r.path), ...shedInfo.keys]);
  const unregistered = findUnregisteredOrgKeys(tables, params.orgId, knownKeys);
  const unregisteredPaths = new Set(unregistered.map((u) => u.path));
  const fileRefs = [...registered, ...unregistered.map((u) => ({ path: u.path, size: null }))]
    .filter((r) => !shedInfo.keys.has(r.path));
  // Results land by index: the manifest keeps collectFilePaths' order (the
  // order a capped server ZIP embeds in) whatever order the checks finish.
  const files: DataExportEnvelope["files"] = new Array(fileRefs.length);
  let totalBytes = 0;
  let missingFiles = 0;
  let missingUnregistered = 0;
  let uncheckedFiles = 0;
  /** Of uncheckedFiles: the ones whose check failed with an error other than not-found. */
  let uncheckedByError = 0;
  // The budget runs from here, but never past the ceiling counted from this
  // export's start, nor past the caller's own deadline: a slow table dump
  // leaves the checks less time, not the route.
  const checkDeadline = Math.min(
    Date.now() + (params.fileCheckBudgetMs ?? FILE_CHECK_BUDGET_MS),
    exportStart + FILE_CHECK_CEILING_MS,
    params.deadlineAt ?? Number.POSITIVE_INFINITY,
  );
  await forEachBounded(fileRefs, FILE_CHECK_CONCURRENCY, async (ref, i) => {
    const { path } = ref;
    // Presigning an R2 GET is a local crypto op (no network), so it always
    // yields a URL; the download itself is the final arbiter of existence.
    let presignedUrl = "";
    try {
      // SEC-18 (DEC-49): the export is a download — every per-file URL is an
      // ATTACHMENT named after its key, never inline, so a stored HTML / SVG
      // upload saves instead of rendering on the storage origin.
      const disposition = presignedGetDisposition(path, false);
      presignedUrl = await getSignedUrl(
        r2,
        new GetObjectCommand({ Bucket: R2_BUCKET, Key: path, ...disposition.overrides }),
        { expiresIn },
      );
    } catch {
      presignedUrl = "";
    }
    // Prefer the size already recorded on the row; only reach out to R2
    // (HeadObject) when we don't know it — that both confirms the object
    // exists and picks up its content type. Checks run FILE_CHECK_CONCURRENCY
    // at a time; once the budget is spent, a file is listed unchecked.
    let size: number | null = ref.size ?? null;
    let contentType: string | null = null;
    let createdAt: string | null = null;
    if (size == null && Date.now() >= checkDeadline) {
      uncheckedFiles++;
    } else if (size == null) {
      try {
        const head = await r2.send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: path }));
        size = typeof head.ContentLength === "number" ? head.ContentLength : null;
        contentType = head.ContentType ?? null;
        createdAt = head.LastModified ? head.LastModified.toISOString() : null;
      } catch (e) {
        if (isNotFound(e)) {
          // Object is missing in R2 (legacy / broken record). Keep it in the
          // manifest with no URL so the gap is visible, never silently dropped.
          size = null;
          presignedUrl = "";
          missingFiles++;
          if (unregisteredPaths.has(path)) missingUnregistered++;
        } else {
          // A throttle, timeout or server error says nothing about the object:
          // it keeps its URL (both ZIP producers skip a file without one) and
          // is counted unchecked, never missing.
          uncheckedFiles++;
          uncheckedByError++;
        }
      }
    }
    if (size) totalBytes += Number(size);
    files[i] = { path, size, contentType, createdAt, presignedUrl };
  });

  // 4. The audit trail — running an export is itself a tracked event, and
  //    the record is CHECKED (BKP-13): postgrest resolves a refused insert
  //    into { error } rather than throwing, so the old try/catch never fired
  //    and a run whose DATA_EXPORT row was refused (the scheduled push's
  //    user_id "cron", 22P02 on the uuid column) reported success with no
  //    record. An export that cannot be recorded is refused before anything
  //    leaves. BKP-8 Done-when 3: the files the export hands out are named
  //    too (DATA_EXPORT_FILES), so the chain of custody names the drawings,
  //    not just the event — against a ledger (what changed since its
  //    previous record): the workspace's for an export handed to a person,
  //    the destination's for a push to a bucket or a webhook (`fileRecord`,
  //    DEC-44 (A&O P3) §3).
  await recordExport(sb, params, {
    startedAt,
    tableCount: tableCounts.length,
    totalRows: tableCounts.reduce((s, t) => s + t.rowCount, 0),
    files,
    totalBytes,
    presignedUrlExpiresIn: expiresIn,
    privateNotes,
    versions: (tables.document_versions ?? []) as Array<Record<string, unknown>>,
  });

  // Look up org name for the manifest header
  let orgName: string | undefined;
  try {
    const { data } = await sb.from("orgs").select("name").eq("id", params.orgId).maybeSingle();
    orgName = (data as { name?: string } | null)?.name;
  } catch {}

  const failedTables = tableCounts.filter((t) => t.error);
  const shortTables = tableCounts.filter((t) => !t.error && t.short);
  const notes: string[] = [];
  if (failedTables.length > 0 || shortTables.length > 0) {
    const parts: string[] = [];
    if (failedTables.length > 0) {
      parts.push(
        `${failedTables.length} table(s) could not be exported and their data is NOT included: ` +
        `${failedTables.map((t) => t.name).join(", ")}. See each table's "error" in tables[] for why, and run the export again.`,
      );
    }
    if (shortTables.length > 0) {
      // ILIFE-6: the rows read are kept — a table that changed while it was
      // read is exported slightly short, never empty — and named with counts.
      parts.push(
        `${shortTables.length} table(s) changed while they were read and came up short of their own row count twice; ` +
        `the rows that were read ARE included, but some rows may be missing: ` +
        `${shortTables.map((t) => `${t.name} (${t.short})`).join("; ")}.`,
      );
    }
    notes.push(`⚠ INCOMPLETE BACKUP — ${parts.join(" ")} Resolve before relying on this as a full backup.`);
  } else {
    notes.push("This document is a complete export of every record this organization owns.");
  }
  if (privateNotes > 0) {
    notes.push(`${privateNotes} ${PRIVATE_NOTES_CARRIED}`);
  }
  if (missingFiles > 0) {
    notes.push(
      `⚠ ${missingFiles} referenced file(s) were not found in storage and have no download URL ` +
      `(their record is still included). They are likely legacy/orphaned references. ` +
      `${files.length - missingFiles} of ${files.length} files are downloadable.`,
    );
  }
  if (uncheckedFiles > 0) {
    const byTime = uncheckedFiles - uncheckedByError;
    notes.push(
      (uncheckedByError === 0
        ? `${uncheckedFiles} file(s) could not be checked against storage within this export's time limit.`
        : `${uncheckedFiles} file(s) could not be checked against storage: ` +
          (byTime > 0 ? `${byTime} within this export's time limit, and ` : "") +
          `${uncheckedByError} because storage answered the check with an error other than "not found" (a throttle, timeout or server error).`) +
      " Each is listed with its download URL but no size, and is not counted as missing even if it is gone; downloading it confirms it.",
    );
  }
  if (unregistered.length > 0) {
    const where = Array.from(new Set(unregistered.map((u) => u.at))).sort();
    const included = unregistered.length - missingUnregistered;
    notes.push(
      `⚠ ${unregistered.length} file(s) in this workspace's storage are named by record field(s) the app does not yet track as ` +
      `file references: ${where.slice(0, 10).join(", ")}${where.length > 10 ? ", …" : ""}. A scan of every exported value found them; ` +
      `${included} ${included === 1 ? "is" : "are"} included in this backup` +
      (missingUnregistered > 0
        ? ` and ${missingUnregistered} ${missingUnregistered === 1 ? "was" : "were"} not found in storage (counted with the missing files)`
        : "") +
      ". Until those fields are tracked, the orphaned-file clean-up on the Storage admin page treats these files as unused: " +
      "do not run it before this is resolved.",
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
  const redactedColumns: Record<string, string[]> = Object.fromEntries(
    Object.entries(REDACT_COLUMNS).map(([table, r]) => [table, [...r.columns]]),
  );
  notes.push(
    "Every column from the source schema is preserved verbatim EXCEPT the credential columns listed in manifest.redactedColumns, " +
    "which are exported as null. JSON keys mirror Postgres column names (snake_case).",
    `REDACTED credential columns (secrets never leave the database): ${
      Object.entries(REDACT_COLUMNS).map(([t, r]) => r.columns.map((c) => `${t}.${c}`).join(", ")).join("; ")
    }. After a restore, share links and vendor intake links must be RE-ISSUED (restored rows arrive revoked), ` +
    "a restored transmittal has no portal link (an issued one arrives VOIDED on the register; issue a new transmittal to send again), " +
    "and export destinations must have their credentials re-entered (restored rows arrive disabled).",
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
    complete: failedTables.length === 0 && shortTables.length === 0,
    files: {
      count: files.length,
      missing: missingFiles,
      unregistered: unregistered.length,
      unchecked: uncheckedFiles,
      archivedOffline: shedInfo.keys.size,
      totalBytes,
      presignedUrlExpiresIn: expiresIn,
    },
    spaceArchives: shedInfo.archiveIds,
    redactedColumns,
    notes,
  };

  return { manifest, tables, files };
}

/** BKP-8: the manifest note for the private notes a backup carries. */
export const PRIVATE_NOTES_CARRIED =
  "private note(s) — scratchpad notes attached to no document, project or equipment, which in the app only their authors can read — " +
  "are in this backup, so restoring it brings them back. Keep the archive as private as those notes.";

/** A standalone note: its author's private scratchpad (notes_standalone_own). */
export function isPrivateNote(row: unknown): boolean {
  const r = (row ?? {}) as { document_id?: unknown; project_id?: unknown; asset_id?: unknown };
  return r.document_id == null && r.project_id == null && r.asset_id == null;
}

/** How many private notes the dump carries. */
function countPrivateNotes(tables: Record<string, unknown[]>): number {
  const rows = tables.notes;
  return Array.isArray(rows) ? rows.filter(isPrivateNote).length : 0;
}

/** BKP-8 Done-when 3: how many handed-out files one DATA_EXPORT_FILES audit row names. */
export const EXPORT_FILES_PER_AUDIT_ROW = 500;
/** Audit rows per insert statement (each row carries up to 500 file entries). */
const EXPORT_FILE_ROWS_PER_INSERT = 10;
/** DEC-44 (A&O P3) §3: the `resource_type` of a destination push's
 *  DATA_EXPORT_FILES rows, whose `resource_id` is the destination's id (the
 *  destination routes' own audit rows use the same pair). A push finds its
 *  destination's ledger through the audit_logs resource indexes
 *  (`audit_logs_resource_id_idx`, and `(resource_type, resource_id,
 *  timestamp DESC)` from 20260611) instead of filtering every
 *  DATA_EXPORT_FILES row of the workspace on its JSON details. */
export const DESTINATION_FILES_RESOURCE_TYPE = "export_destination";
/** DEC-44 (A&O P3) §3: the `resource_type` of the workspace's own ledger —
 *  the DATA_EXPORT_FILES rows of every export handed to a person (the JSON
 *  download, the browser-built Full ZIP, the manual ZIP), whose
 *  `resource_id` is the workspace's id; found by the same indexes. The fifth
 *  review fix pass moved a person's export onto it: it wrote its whole list
 *  (about 150 bytes a file) on every run, so a daily Full ZIP of a
 *  20,000-file workspace grew audit_logs — itself exported, and read whole
 *  by every later export — by about 1 GB a year. */
export const WORKSPACE_FILES_RESOURCE_TYPE = "org_export_ledger";
/** The ledger an export's files are named against: its rows' `resource_type`
 *  and `resource_id`. */
export interface ExportLedgerKey {
  resourceType: string;
  resourceId: string;
}
/** DEC-44 (A&O P3) §3: every ledger's rows (its baselines and deltas — a
 *  destination's or the workspace's) are machine rows — user_id NULL, this
 *  label in user_email — and the ledger reads only rows with user_id NULL.
 *  audit_logs_insert (20260813) admits a member's insert only with user_id =
 *  auth.uid(), so no member can write a row the ledger would read (a forged
 *  "baseline" dated 2099 used to force a full list every night); only the
 *  service role can. The person behind an export (a person's download, a Run
 *  Now) is on its DATA_EXPORT row — user_id, the role the surface admitted
 *  them by, the list's sha256 — and in each ledger row's details.exportedBy. */
export const EXPORT_LEDGER_ACTOR = { email: "system:export-ledger", role: "system" } as const;
/** DEC-44 (A&O P3) §3: a ledger's chain of deltas is re-based — a new
 *  baseline written — once the chain since the last baseline, with
 *  tonight's change, would name more than this fraction of tonight's list
 *  (and at least one row's worth, EXPORT_FILES_PER_AUDIT_ROW). Over any run
 *  of exports the ledger then writes at most (1 + 1/fraction) = 3 entries
 *  per changed file, never the whole list per export. */
export const LEDGER_CHAIN_ENTRY_FRACTION = 0.5;
/** …or would span more than this many rows: the most the next push reads
 *  back of the chain (a trickle of one change a night re-bases every 400
 *  changed nights: N/400 a night, amortised). */
export const LEDGER_CHAIN_MAX_ROWS = 400;
/** The chain read's row limit: the chain's own cap, plus room for the rows
 *  of a run that forked it (two pushes at once); under PostgREST's max-rows. */
const LEDGER_CHAIN_READ_LIMIT = LEDGER_CHAIN_MAX_ROWS + 100;
/** A baseline's parts are read this many rows at a time. */
const LEDGER_PART_PAGE = 500;
/** The ledger reads rows no later than now plus this allowance for the
 *  server's clock trailing the database's: a row dated in the future is not
 *  the newest of anything. */
const LEDGER_CLOCK_ALLOWANCE_MS = 60_000;
/** A ledger's parts and chain reads take rows dated no earlier than this
 *  before its baseline's newest row. One export writes a baseline's parts,
 *  EXPORT_FILE_ROWS_PER_INSERT rows to a statement, each statement dated
 *  when it ran (audit_logs.timestamp DEFAULT NOW()), one statement after
 *  another as the export records itself — before its archive is built or
 *  delivered, so on any host (A&O P3 fix pass 8: not because of the routes'
 *  maxDuration, which `next start` does not enforce) — so its earliest part
 *  lies within this of its newest; every delta on its chain was written
 *  after the baseline was read back whole, so after its newest part. Both
 *  ends are the database's own clock. (A recall's DATA_EXPORT_UNDELIVERED
 *  read has its own, wider bound: UNDELIVERED_READ_WINDOW_MS.) */
const LEDGER_WRITE_WINDOW_MS = 15 * 60_000;
/** How long after an export's DATA_EXPORT row a recall (rebuildExportList)
 *  looks for its DATA_EXPORT_UNDELIVERED row. That row is written after the
 *  delivery fails (lib/exportRunner.ts buildAndDeliverExport's catch; the
 *  JSON export's, app/api/data-export/structured), and a delivery has no
 *  time limit off Vercel: the supported Docker self-host runs `next start`,
 *  which does not enforce the routes' maxDuration (300 s), the webhook POST
 *  carries no abort signal and the S3 put and its read-back no request
 *  timeout (the S3 client also retries, three attempts in all). So a large
 *  archive to a slow webhook or bucket fails, and is recorded, long after
 *  its record — the fix pass 7 bound of 15 minutes read such an export as
 *  delivered (A&O P3 fix pass 8). A day covers an archive at the default
 *  embed cap (1.5 GB) failing after a whole upload at about 17 KB/s, or
 *  after the S3 client's three attempts at about 52 KB/s, and a daily
 *  destination's next push is due within it. The writers get no deadline
 *  of their own: one would fail a slow upload that succeeds today. It stays
 *  a range scan of the record's resource on audit_logs_resource_timeline_idx
 *  (resource_type, resource_id, timestamp) — a day of a destination's own
 *  ledger and UNDELIVERED rows, or of the workspace's "org" rows — LIMIT 1.
 *  What it cannot see: a failure recorded later than this, and a delivery
 *  killed mid-flight (Vercel ending the function at 300 s, a container
 *  restart), which records nothing at all. So `undelivered: null` means no
 *  failure is recorded, never that the export arrived. */
export const UNDELIVERED_READ_WINDOW_MS = 24 * 60 * 60_000;

/** DEC-44 (A&O P3) §3: the SHA-256 (hex) of the handed-out file paths, sorted
 *  and newline-joined — the fingerprint a record carries of the whole list:
 *  a destination push's list rebuilt from its baseline and delta rows must
 *  hash to it, and anyone holding the archive can recompute it from its own
 *  list. */
export function exportFileListDigest(paths: readonly string[]): string {
  return createHash("sha256").update([...paths].sort().join("\n"), "utf8").digest("hex");
}

/** DEC-44 (A&O P3) §3: the file list one DATA_EXPORT_FILES row carries,
 *  compact. `paths` are relative to `prefix` — the workspace's storage
 *  prefix (`orgs/<org id>/`) when every path in the row lies under it, else
 *  "" — and `refs` runs parallel to them, keyed by revision: `[d, versionId]`
 *  for a revision's file or native source, where `d` indexes `docs` (each
 *  document the row names, once; null when the revision names none), and
 *  null for any other file. A delta row's `removed` paths are relative to the
 *  same prefix. At real key lengths that is about 150 bytes a file, where an
 *  object per file (`{ path, documentId, versionId }`, the second review fix
 *  pass's shape) took about 250. fileListEntries reads it back whole. */
export interface CompactFileList {
  prefix: string;
  paths: string[];
  docs: string[];
  refs: Array<[number | null, string | null] | null>;
  removed?: string[];
}

/** One DATA_EXPORT_FILES row's files, whole: each path with its prefix put
 *  back, and its document and revision where it has them — what a recall
 *  reads, and what the baseline read-back rebuilds from. */
export function fileListEntries(details: unknown): Array<{ path: string; documentId?: string | null; versionId?: string | null }> {
  const d = (details ?? {}) as { prefix?: unknown; paths?: unknown; docs?: unknown; refs?: unknown };
  const prefix = typeof d.prefix === "string" ? d.prefix : "";
  const docs = Array.isArray(d.docs) ? d.docs : [];
  const refs = Array.isArray(d.refs) ? d.refs : [];
  const out: Array<{ path: string; documentId?: string | null; versionId?: string | null }> = [];
  (Array.isArray(d.paths) ? d.paths : []).forEach((p, i) => {
    if (typeof p !== "string") return;
    const ref = refs[i];
    if (!Array.isArray(ref)) { out.push({ path: prefix + p }); return; }
    const doc = typeof ref[0] === "number" ? docs[ref[0]] : null;
    out.push({ path: prefix + p, documentId: typeof doc === "string" ? doc : null, versionId: typeof ref[1] === "string" ? ref[1] : null });
  });
  return out;
}

/** A delta row's removed paths, whole (prefix put back). */
export function fileListRemoved(details: unknown): string[] {
  const d = (details ?? {}) as { prefix?: unknown; removed?: unknown };
  const prefix = typeof d.prefix === "string" ? d.prefix : "";
  return (Array.isArray(d.removed) ? d.removed : []).filter((p): p is string => typeof p === "string").map((p) => prefix + p);
}

/** DEC-44 (A&O P3) §3: a ledger (a destination's, or the workspace's) as
 *  its next export finds it — its newest baseline (a full list, the
 *  DATA_EXPORT_FILES rows of kind "baseline" one export wrote) and the chain
 *  of deltas since (each the rows of kind "delta" one export wrote, naming
 *  what was added and removed since the record before it, `prev`), read back
 *  whole and checked against the digest the chain's newest record carries. */
export interface ExportLedger {
  baseline: { recordId: string; startedAt: string; sha256: string };
  /** The newest record on the chain — the baseline itself when no delta has
   *  followed it: the list the next delta is computed against. */
  head: { recordId: string; sha256: string };
  /** The delta records on the chain since the baseline, and the entries
   *  (added plus removed) and rows they take. */
  links: number;
  entries: number;
  rows: number;
  /** The head's list: the baseline with every delta on the chain applied. */
  paths: Set<string>;
}

/** A ledger, by its key. `ledger` null with no `problem`: there is none
 *  yet. With a `problem`: one exists but could not be read whole, or does
 *  not hash to its own digest — the caller writes a new full list (the safe
 *  side: every file is named again), never a delta against a list it cannot
 *  vouch for.
 *
 *  Every read goes through the ledger's own rows (`resource_type` and
 *  `resource_id` from its key — DESTINATION_FILES_RESOURCE_TYPE and the
 *  destination, or WORKSPACE_FILES_RESOURCE_TYPE and the workspace), newest
 *  first by `timestamp`, the order of the resource-timeline index; and every
 *  read takes only machine rows (`user_id` NULL — EXPORT_LEDGER_ACTOR: no
 *  member can write one) dated no later than now (plus a minute's clock
 *  allowance). The head read selects only the newest baseline's four small
 *  fields and its `timestamp`; its parts are read LEDGER_PART_PAGE at a time
 *  up to `parts`; the chain read takes that baseline's delta rows, at most
 *  LEDGER_CHAIN_READ_LIMIT. The parts and chain reads take only rows dated
 *  since the baseline (LEDGER_WRITE_WINDOW_MS before its newest row), so an
 *  export walks the index over the rows since its baseline, never the
 *  ledger's whole history (sixth review fix pass: each read filtered every
 *  historical row of the resource on its JSON details). The chain is walked
 *  from its newest record back along `prev` to the baseline, so a record a
 *  concurrent push wrote off the path is passed over. */
export async function readExportLedger(
  sb: Pick<SupabaseClient, "from">,
  orgId: string,
  key: ExportLedgerKey,
): Promise<{ ledger: ExportLedger | null; problem?: string }> {
  const ceiling = new Date(Date.now() + LEDGER_CLOCK_ALLOWANCE_MS).toISOString();
  const head = await sb.from("audit_logs")
    .select("recordId:details->>recordId, parts:details->>parts, sha256:details->>sha256, startedAt:details->>startedAt, timestamp")
    .eq("resource_type", key.resourceType).eq("resource_id", key.resourceId)
    .eq("action", "DATA_EXPORT_FILES").eq("org_id", orgId).is("user_id", null).lte("timestamp", ceiling)
    .eq("details->>kind", "baseline")
    .order("timestamp", { ascending: false }).limit(1);
  if (head.error) return { ledger: null, problem: `the last full list could not be read (${head.error.message})` };
  const first = ((head.data ?? []) as Array<Record<string, unknown> | null>)[0];
  if (!first) return { ledger: null };
  const recordId = typeof first.recordId === "string" ? first.recordId : "";
  const parts = Number(first.parts);
  const sha256 = typeof first.sha256 === "string" ? first.sha256 : "";
  const startedAt = typeof first.startedAt === "string" ? first.startedAt : "";
  if (!recordId || !sha256 || !Number.isInteger(parts) || parts < 1) {
    return { ledger: null, problem: "the last full list is malformed" };
  }

  const read = await readLedgerChain(
    { sb, orgId, key, ceiling, since: ledgerFloor(first.timestamp), refs: false },
    { recordId, parts, sha256 },
    null,
  );
  if ("problem" in read) return { ledger: null, problem: read.problem };
  const { path, head: headId } = read;
  return {
    ledger: {
      baseline: { recordId, startedAt, sha256 },
      head: { recordId: headId, sha256: path.length > 0 ? path[path.length - 1].sha256 : sha256 },
      links: path.length,
      entries: path.reduce((s, l) => s + l.added.length + l.removed.length, 0),
      rows: path.reduce((s, l) => s + l.parts, 0),
      paths: new Set(read.files.keys()),
    },
  };
}

/** One file a ledger names: its path, and its document and revision where it has them. */
export type LedgerFile = ReturnType<typeof fileListEntries>[number];

/** The rows a ledger read takes: the ledger's own machine rows, dated no
 *  later than `ceiling` and, once its baseline is known, no earlier than
 *  `since`. `refs` keeps each file's document and revision (a recall), else
 *  only its path (an export). */
interface LedgerScope {
  sb: Pick<SupabaseClient, "from">;
  orgId: string;
  key: ExportLedgerKey;
  ceiling: string;
  since: string | null;
  refs: boolean;
}

/** One delta record on a chain: what it added and removed since `prev`. */
interface LedgerLink { prev: string; sha256: string; parts: number; seen: Set<number>; added: LedgerFile[]; removed: string[] }

/** The floor of a ledger's parts and chain reads: LEDGER_WRITE_WINDOW_MS
 *  before its baseline's newest row. Null (no floor, every row read as
 *  before) when that row's `timestamp` cannot be read. */
function ledgerFloor(timestamp: unknown): string | null {
  const at = typeof timestamp === "string" ? Date.parse(timestamp) : NaN;
  return Number.isFinite(at) ? new Date(at - LEDGER_WRITE_WINDOW_MS).toISOString() : null;
}

/** A baseline's list, read back whole, with the chain of deltas from it to
 *  `headId` applied (the chain's newest record when null), and checked
 *  against the digests they carry: the baseline's own, and the last
 *  record's on the path. Shared by readExportLedger (the next export) and
 *  rebuildExportList (a recall), so both read the same rows the same way. */
async function readLedgerChain(
  scope: LedgerScope,
  baseline: { recordId: string; parts: number; sha256: string },
  headId: string | null,
): Promise<{ files: Map<string, LedgerFile | null>; path: LedgerLink[]; head: string } | { problem: string }> {
  const { sb, orgId, key, ceiling, since } = scope;
  const { recordId, parts, sha256 } = baseline;
  const rowsOf = (select: string) => {
    const q = sb.from("audit_logs").select(select)
      .eq("resource_type", key.resourceType).eq("resource_id", key.resourceId)
      .eq("action", "DATA_EXPORT_FILES").eq("org_id", orgId).is("user_id", null).lte("timestamp", ceiling);
    return since ? q.gte("timestamp", since) : q;
  };
  const keep = (f: LedgerFile): LedgerFile | null => (scope.refs ? f : null);

  // The baseline's parts, whole.
  const files = new Map<string, LedgerFile | null>();
  const seen = new Set<number>();
  for (let from = 0; from < parts; from += LEDGER_PART_PAGE) {
    const page = await rowsOf("details")
      .eq("details->>recordId", recordId)
      .order("details->>part", { ascending: true })
      .range(from, Math.min(from + LEDGER_PART_PAGE, parts) - 1);
    if (page.error) return { problem: `the last full list could not be read (${page.error.message})` };
    const rows = (page.data ?? []) as Array<{ details?: Record<string, unknown> | null }>;
    for (const r of rows) {
      const d = r.details ?? {};
      if (d.kind !== "baseline" || seen.has(Number(d.part))) continue;
      seen.add(Number(d.part));
      for (const f of fileListEntries(d)) files.set(f.path, keep(f));
    }
    if (rows.length < Math.min(LEDGER_PART_PAGE, parts - from)) break;
  }
  if (seen.size !== parts || exportFileListDigest([...files.keys()]) !== sha256) {
    return { problem: `the last full list (${recordId}) could not be read back whole: ${seen.size} of ${parts} part(s), or its digest does not match` };
  }

  // The chain since it.
  const chain = await rowsOf("details")
    .eq("details->>kind", "delta").eq("details->>baselineId", recordId)
    .order("timestamp", { ascending: false }).limit(LEDGER_CHAIN_READ_LIMIT);
  if (chain.error) return { problem: `the changes since the last full list could not be read (${chain.error.message})` };
  const links = new Map<string, LedgerLink>();
  let newest: string | null = null;
  for (const r of (chain.data ?? []) as Array<{ details?: Record<string, unknown> | null }>) {
    const d = r.details ?? {};
    const id = typeof d.recordId === "string" ? d.recordId : "";
    if (!id) continue;
    if (newest === null) newest = id;
    let link = links.get(id);
    if (!link) {
      link = { prev: typeof d.prev === "string" ? d.prev : "", sha256: typeof d.sha256 === "string" ? d.sha256 : "", parts: Number(d.parts), seen: new Set(), added: [], removed: [] };
      links.set(id, link);
    }
    if (link.seen.has(Number(d.part))) continue;
    link.seen.add(Number(d.part));
    link.added.push(...fileListEntries(d));
    link.removed.push(...fileListRemoved(d));
  }
  const start = headId ?? newest;
  const path: LedgerLink[] = [];
  for (let at = start; at !== null && at !== recordId;) {
    const link = links.get(at);
    if (!link || path.length >= links.size || !Number.isInteger(link.parts) || link.seen.size !== link.parts) {
      return { problem: `the changes since the last full list (${recordId}) could not be read back whole` };
    }
    path.push(link);
    at = link.prev;
  }
  path.reverse();
  for (const link of path) {
    for (const p of link.removed) files.delete(p);
    for (const f of link.added) files.set(f.path, keep(f));
  }
  if (path.length > 0 && exportFileListDigest([...files.keys()]) !== path[path.length - 1].sha256) {
    return { problem: `the changes since the last full list (${recordId}) do not rebuild the list they record` };
  }
  return { files, path, head: path.length > 0 ? (start as string) : recordId };
}

/** DEC-44 (A&O P3) §3: one export's file list, rebuilt from the audit
 *  trail — "who took which drawing". */
export interface RebuiltExportList {
  recordId: string;
  /** Who took the export, from its DATA_EXPORT row: the person (or the
   *  machine, user_id null), the role the surface admitted them by, when.
   *  `userId` is the authoritative field. `audit_logs_insert` (20260813)
   *  checks a member's insert for `user_id = auth.uid()` and an org the
   *  member belongs to (or none) — never the email or the role — so on a
   *  row a member wrote, `email` and `role` are what they put: display hints,
   *  until admin-and-org ALOG-7's trigger resolves them from org_members. A
   *  machine row (user_id null) can be written only by the service role, so
   *  its label and role are the app's own. */
  exporter: { userId: string | null; email: string | null; role: string | null; at: string | null };
  /** The record's own fileRecord: its mode, its ledger, its count and digest. */
  fileRecord: Record<string, unknown>;
  /** Every file the export handed out, by path, with its document and
   *  revision where it has them; its paths hash to the record's sha256. */
  files: LedgerFile[];
  /** Whether a failure to deliver is recorded. Set: the export was recorded
   *  as leaving and then did not (its file list refused, its ZIP not built,
   *  the destination refusing it — recordExportUndelivered), with that row's
   *  error and when it was written. The list is still what the export
   *  carried; the files never reached the other end, so its exporter took
   *  nothing. Null: no DATA_EXPORT_UNDELIVERED row names the record within
   *  UNDELIVERED_READ_WINDOW_MS of it — no failure is recorded, which is not
   *  the same as "arrived" (A&O P3 fix pass 8): a delivery killed mid-flight
   *  (Vercel ending the function at its 300 s maxDuration, a container
   *  restart on a self-host) records nothing, and a failure recorded later
   *  than the window is not read. Read from machine rows only (user_id NULL),
   *  which no member can write, so no member can unsay a delivered export. */
  undelivered: { error: string | null; at: string | null } | null;
}

/** DEC-44 (A&O P3) §3: rebuild one export's file list from the audit trail
 *  alone. The export's DATA_EXPORT row (found by its record id) names who
 *  took it and carries its `fileRecord`; the list is its ledger's baseline
 *  (a baseline record's own rows) with the chain of deltas from it applied
 *  up to the record (or, for a record that changed nothing and wrote no row,
 *  to the record it points at, `prev`) — read by readLedgerChain, the code
 *  the next export reads its ledger with, from the ledger's machine rows
 *  only — and checked against the record's `sha256`. A recall asks it of
 *  each DATA_EXPORT row to learn whether a drawing was in that export — and
 *  checks `undelivered` before it names the exporter as having taken it: an
 *  export recorded and then not delivered (a DATA_EXPORT_UNDELIVERED machine
 *  row naming the record, one read on the record's resource) carried the
 *  list but handed nothing out (A&O P3 fix pass 7). `undelivered: null`
 *  means no failure is recorded, not that the files arrived (fix pass 8;
 *  RebuiltExportList). Who took it is
 *  `exporter.userId`; `email` and `role` are display hints on a member's row
 *  (RebuiltExportList). Never throws: `list` null with a `problem` when the
 *  record is unknown, names no list (an export recorded before this
 *  package), is named by more than one DATA_EXPORT row, cannot be rebuilt
 *  whole and matching its digest, or whether it was delivered cannot be
 *  read. */
export async function rebuildExportList(
  sb: Pick<SupabaseClient, "from">,
  orgId: string,
  recordId: string,
): Promise<{ list: RebuiltExportList | null; problem?: string }> {
  const found = await sb.from("audit_logs").select("user_id, user_email, user_role, timestamp, details")
    .eq("resource_type", "org").eq("resource_id", orgId).eq("action", "DATA_EXPORT").eq("org_id", orgId)
    .eq("details->fileRecord->>recordId", recordId)
    .limit(2);
  if (found.error) return { list: null, problem: `the export's record could not be read (${found.error.message})` };
  const rows = (found.data ?? []) as Array<Record<string, unknown>>;
  if (rows.length === 0) return { list: null, problem: `no export is recorded under ${recordId}` };
  if (rows.length > 1) return { list: null, problem: `more than one export row names the record ${recordId}` };
  const row = rows[0];
  const fileRecord = ((row.details as Record<string, unknown> | null)?.fileRecord ?? null) as Record<string, unknown> | null;
  const mode = fileRecord?.mode;
  const sha256 = typeof fileRecord?.sha256 === "string" ? fileRecord.sha256 : "";
  if (!fileRecord || (mode !== "baseline" && mode !== "delta") || !sha256) {
    return { list: null, problem: `the export ${recordId} names no file list it can be rebuilt from` };
  }
  const destinationId = typeof fileRecord.destinationId === "string" && fileRecord.destinationId ? fileRecord.destinationId : null;
  const key: ExportLedgerKey = destinationId
    ? { resourceType: DESTINATION_FILES_RESOURCE_TYPE, resourceId: destinationId }
    : { resourceType: WORKSPACE_FILES_RESOURCE_TYPE, resourceId: orgId };
  const baselineId = mode === "baseline" ? recordId : String((fileRecord.baseline as { recordId?: unknown } | null)?.recordId ?? "");
  // A delta that changed nothing wrote no row: its list is the record it points at.
  const changed = Number(fileRecord.added ?? 0) + Number(fileRecord.removed ?? 0) > 0;
  const headId = mode === "baseline" ? recordId : changed ? recordId : String(fileRecord.prev ?? "");
  if (!baselineId || headId === "") return { list: null, problem: `the export ${recordId} names no file list it can be rebuilt from` };

  const ceiling = new Date(Date.now() + LEDGER_CLOCK_ALLOWANCE_MS).toISOString();
  const base = await sb.from("audit_logs").select("parts:details->>parts, sha256:details->>sha256, timestamp")
    .eq("resource_type", key.resourceType).eq("resource_id", key.resourceId)
    .eq("action", "DATA_EXPORT_FILES").eq("org_id", orgId).is("user_id", null).lte("timestamp", ceiling)
    .eq("details->>kind", "baseline").eq("details->>recordId", baselineId)
    .order("timestamp", { ascending: false }).limit(1);
  if (base.error) return { list: null, problem: `the export's full list could not be read (${base.error.message})` };
  const b = ((base.data ?? []) as Array<Record<string, unknown> | null>)[0];
  const parts = Number(b?.parts);
  const baseSha = typeof b?.sha256 === "string" ? b.sha256 : "";
  if (!b || !baseSha || !Number.isInteger(parts) || parts < 1) {
    return { list: null, problem: `the full list (${baselineId}) the export ${recordId} is named against is missing or malformed` };
  }
  const read = await readLedgerChain(
    { sb, orgId, key, ceiling, since: ledgerFloor(b.timestamp), refs: true },
    { recordId: baselineId, parts, sha256: baseSha },
    headId,
  );
  if ("problem" in read) return { list: null, problem: read.problem };
  const paths = [...read.files.keys()];
  if (exportFileListDigest(paths) !== sha256) {
    return { list: null, problem: `the list rebuilt for the export ${recordId} does not hash to its record` };
  }
  // Is a failure to deliver recorded? recordExportUndelivered writes its
  // machine row on the export's resource (the destination's, or the
  // workspace's "org"), naming the record, from the same function as the
  // DATA_EXPORT row and after it — both dated by the database
  // (audit_logs.timestamp DEFAULT NOW()) — once the delivery has failed,
  // however long that took (no deadline off Vercel; A&O P3 fix pass 8: the
  // bound was 15 minutes, which a slow large delivery outlasts). So the read
  // walks the resource's rows from the record's own time to
  // UNDELIVERED_READ_WINDOW_MS after it, never the resource's whole history;
  // with no readable time on the record it is unbounded.
  const recordedAt = typeof row.timestamp === "string" ? row.timestamp : null;
  const recordedMs = recordedAt ? Date.parse(recordedAt) : NaN;
  const gone = sb.from("audit_logs").select("error:details->>error, timestamp")
    .eq("resource_type", destinationId ? DESTINATION_FILES_RESOURCE_TYPE : "org").eq("resource_id", destinationId ?? orgId)
    .eq("action", "DATA_EXPORT_UNDELIVERED").eq("org_id", orgId).is("user_id", null)
    .eq("details->>recordId", recordId);
  const undeliveredRead = await (Number.isFinite(recordedMs)
    ? gone.gte("timestamp", recordedAt as string).lte("timestamp", new Date(recordedMs + UNDELIVERED_READ_WINDOW_MS).toISOString())
    : gone
  ).order("timestamp", { ascending: true }).limit(1);
  if (undeliveredRead.error) {
    return { list: null, problem: `whether the export ${recordId} was delivered could not be read (${undeliveredRead.error.message})` };
  }
  const u = ((undeliveredRead.data ?? []) as Array<Record<string, unknown> | null>)[0];
  return {
    list: {
      recordId,
      exporter: {
        userId: typeof row.user_id === "string" ? row.user_id : null,
        email: typeof row.user_email === "string" ? row.user_email : null,
        role: typeof row.user_role === "string" ? row.user_role : null,
        at: recordedAt,
      },
      fileRecord,
      files: paths.sort().map((p) => read.files.get(p) ?? { path: p }),
      undelivered: u
        ? { error: typeof u.error === "string" ? u.error : null, at: typeof u.timestamp === "string" ? u.timestamp : null }
        : null,
    },
  };
}

/** A destination's ledger (readExportLedger). */
export function readDestinationLedger(
  sb: Pick<SupabaseClient, "from">,
  orgId: string,
  destinationId: string,
): Promise<{ ledger: ExportLedger | null; problem?: string }> {
  return readExportLedger(sb, orgId, { resourceType: DESTINATION_FILES_RESOURCE_TYPE, resourceId: destinationId });
}

/** The workspace's own ledger — every person's export (readExportLedger). */
export function readWorkspaceLedger(
  sb: Pick<SupabaseClient, "from">,
  orgId: string,
): Promise<{ ledger: ExportLedger | null; problem?: string }> {
  return readExportLedger(sb, orgId, { resourceType: WORKSPACE_FILES_RESOURCE_TYPE, resourceId: orgId });
}

/** The DATA_EXPORT row, then the DATA_EXPORT_FILES rows naming every file the
 *  export hands out (a presigned URL in the envelope; the server ZIP embeds
 *  from those URLs) — with the document and revision for a revision's file,
 *  so a recall can ask "who took which drawing". Each row's list is compact
 *  (CompactFileList; fileListEntries reads it back). DEC-44 (A&O P3) §3:
 *  every export names its files against a ledger (readExportLedger) — the
 *  workspace's (`fileRecord` "workspace", the default: an export handed to
 *  a person, `resource_type` WORKSPACE_FILES_RESOURCE_TYPE and the
 *  workspace's id) or a destination's (`{ destinationId }`: a push to a
 *  bucket or a webhook, scheduled or Run Now, DESTINATION_FILES_RESOURCE_TYPE
 *  and the destination's id). Against it the export writes a "delta" naming
 *  what was added and removed since the ledger's previous record — 500
 *  entries to a row, none when nothing changed — chained to that record
 *  (`prev`) and to the baseline (`baselineId`); or a new "baseline" naming
 *  every file when there is no ledger it can vouch for, or when the chain
 *  with this export's change would name more than LEDGER_CHAIN_ENTRY_FRACTION
 *  of the list or take more than LEDGER_CHAIN_MAX_ROWS rows. The export's
 *  list is the baseline with the chain applied, and hashes to its
 *  DATA_EXPORT row's sha256. The ledger rows are machine rows
 *  (EXPORT_LEDGER_ACTOR, the exporter in details.exportedBy), so the next
 *  export finds them by index and no member can forge one; who took the
 *  export — the person, the role the surface admitted them by — is on the
 *  DATA_EXPORT row, whose record a recall rebuilds the list of.
 *  The DATA_EXPORT row is written first; `onRecorded` is called once it is.
 *  Every insert is CHECKED and throws: the caller refuses the export
 *  (BKP-13). A machine run (no exporter uid) carries user_id NULL and the
 *  machine's label in user_email (DEC-44 (A&O P3)), never a string in the
 *  uuid column. */
async function recordExport(
  sb: SupabaseClient,
  params: {
    orgId: string; exporterUserId: string | null; exporterEmail: string; exporterRole?: string | null;
    auditDetails?: Record<string, unknown>; fileRecord?: "workspace" | { destinationId: string };
    recordId?: string; onRecorded?: (recordId: string) => void;
  },
  info: {
    startedAt: string; tableCount: number; totalRows: number; totalBytes: number; presignedUrlExpiresIn: number; privateNotes: number;
    files: DataExportEnvelope["files"]; versions: Array<Record<string, unknown>>;
  },
): Promise<void> {
  const actor = {
    org_id: params.orgId,
    user_id: params.exporterUserId,
    user_email: params.exporterEmail,
    user_role: params.exporterRole ?? null,
  };
  const handedOut = info.files.filter((f) => !!f.presignedUrl);
  const byKey = new Map<string, [string | null, string | null]>();
  for (const v of info.versions) {
    const ref: [string | null, string | null] = [typeof v.record_id === "string" ? v.record_id : null, typeof v.id === "string" ? v.id : null];
    for (const col of ["file_url", "source_file_key"]) {
      const k = v[col];
      if (typeof k === "string" && k && !byKey.has(k)) byKey.set(k, ref);
    }
  }
  const orgPrefix = orgKeyPrefix(params.orgId);
  /** One row's compact list: its files (with their refs), and for a delta row its removed paths. */
  const compact = (rowPaths: readonly string[], removed?: readonly string[]): CompactFileList => {
    const every = [...rowPaths, ...(removed ?? [])];
    const prefix = every.length > 0 && every.every((p) => p.startsWith(orgPrefix)) ? orgPrefix : "";
    const docs: string[] = [];
    const docIndex = new Map<string, number>();
    const refs = rowPaths.map((p): [number | null, string | null] | null => {
      const ref = byKey.get(p);
      if (!ref) return null;
      const [documentId, versionId] = ref;
      if (documentId === null) return [null, versionId];
      let at = docIndex.get(documentId);
      if (at === undefined) { at = docs.push(documentId) - 1; docIndex.set(documentId, at); }
      return [at, versionId];
    });
    return {
      prefix,
      paths: rowPaths.map((p) => p.slice(prefix.length)),
      docs,
      refs,
      ...(removed ? { removed: removed.map((p) => p.slice(prefix.length)) } : {}),
    };
  };
  const paths = handedOut.map((f) => f.path);
  const sha256 = exportFileListDigest(paths);
  const recordId = params.recordId ?? randomUUID();
  const chunked = (kind: Record<string, unknown>) => {
    const parts = Math.ceil(paths.length / EXPORT_FILES_PER_AUDIT_ROW);
    return Array.from({ length: parts }, (_, i) => ({
      ...kind,
      recordId,
      startedAt: info.startedAt,
      part: i + 1,
      parts,
      ...compact(paths.slice(i * EXPORT_FILES_PER_AUDIT_ROW, (i + 1) * EXPORT_FILES_PER_AUDIT_ROW)),
    }));
  };

  // The ledger this export names its files against, and whose it is (on the
  // DATA_EXPORT row's fileRecord and on each ledger row).
  const destinationId = params.fileRecord && typeof params.fileRecord === "object" ? params.fileRecord.destinationId : null;
  const ledgerKey: ExportLedgerKey = destinationId
    ? { resourceType: DESTINATION_FILES_RESOURCE_TYPE, resourceId: destinationId }
    : { resourceType: WORKSPACE_FILES_RESOURCE_TYPE, resourceId: params.orgId };
  const owner: Record<string, unknown> = destinationId ? { destinationId } : { ledger: "workspace" };
  const resource = { resource_id: ledgerKey.resourceId, resource_type: ledgerKey.resourceType };
  const fileActor = { org_id: params.orgId, user_id: null, user_email: EXPORT_LEDGER_ACTOR.email, user_role: EXPORT_LEDGER_ACTOR.role };
  const exportedBy = { userId: params.exporterUserId, email: params.exporterEmail };
  let fileRecord!: Record<string, unknown>;
  let fileRows!: Array<Record<string, unknown>>;
  const { ledger, problem } = await readExportLedger(sb, params.orgId, ledgerKey);
  let rebased: string | null = null;
  if (ledger) {
    const current = new Set(paths);
    const added = paths.filter((p) => !ledger.paths.has(p));
    const removed = [...ledger.paths].filter((p) => !current.has(p)).sort();
    const changes = added.length + removed.length;
    const rowsTonight = Math.ceil(changes / EXPORT_FILES_PER_AUDIT_ROW);
    const entryCap = Math.max(Math.ceil(paths.length * LEDGER_CHAIN_ENTRY_FRACTION), EXPORT_FILES_PER_AUDIT_ROW);
    if (ledger.entries + changes <= entryCap && ledger.rows + rowsTonight <= LEDGER_CHAIN_MAX_ROWS) {
      const base = { recordId: ledger.baseline.recordId, startedAt: ledger.baseline.startedAt, sha256: ledger.baseline.sha256 };
      const link = ledger.links + (changes > 0 ? 1 : 0);
      fileRecord = {
        mode: "delta", ...owner, count: paths.length, sha256, recordId, baseline: base,
        prev: ledger.head.recordId, link, added: added.length, removed: removed.length,
      };
      fileRows = Array.from({ length: rowsTonight }, (_, i) => {
        const from = i * EXPORT_FILES_PER_AUDIT_ROW;
        const to = from + EXPORT_FILES_PER_AUDIT_ROW;
        const a = added.length;
        return {
          kind: "delta", ...owner, recordId, startedAt: info.startedAt, baselineId: base.recordId,
          prev: ledger.head.recordId, link, sha256, part: i + 1, parts: rowsTonight, exportedBy,
          ...compact(added.slice(Math.min(from, a), Math.min(to, a)), removed.slice(Math.max(from - a, 0), Math.max(to - a, 0))),
        };
      });
    } else {
      rebased = `the changes since the last full list (${ledger.baseline.recordId}) would name ${ledger.entries + changes} file(s) in ${ledger.rows + rowsTonight} row(s), past the chain's cap of ${entryCap} or ${LEDGER_CHAIN_MAX_ROWS} rows`;
    }
  }
  if (!ledger || rebased) {
    fileRecord = {
      mode: "baseline", ...owner, count: paths.length, sha256, recordId,
      ...(problem ? { baselineProblem: problem } : {}), ...(rebased ? { rebased } : {}),
    };
    fileRows = chunked({ kind: "baseline", ...owner, sha256, exportedBy });
  }

  const { error } = await sb.from("audit_logs").insert({
    action: "DATA_EXPORT",
    resource_id: params.orgId,
    resource_type: "org",
    ...actor,
    details: {
      tableCount: info.tableCount,
      totalRows: info.totalRows,
      fileCount: info.files.length,
      totalBytes: info.totalBytes,
      startedAt: info.startedAt,
      presignedUrls: handedOut.length,
      presignedUrlExpiresIn: info.presignedUrlExpiresIn,
      fileRecordRows: fileRows.length,
      fileRecord,
      ...(info.privateNotes > 0 ? { privateNotes: { carried: info.privateNotes } } : {}),
      ...(params.auditDetails ?? {}),
    },
  });
  if (error) {
    throw new Error(`The export could not be recorded in the audit trail (${error.message}) — it was refused, and nothing was exported.`);
  }
  params.onRecorded?.(recordId);
  const rows = fileRows.map((details) => ({
    action: "DATA_EXPORT_FILES",
    ...resource,
    ...fileActor,
    details,
  }));
  for (let i = 0; i < rows.length; i += EXPORT_FILE_ROWS_PER_INSERT) {
    const { error: filesErr } = await sb.from("audit_logs").insert(rows.slice(i, i + EXPORT_FILE_ROWS_PER_INSERT));
    if (filesErr) {
      throw new Error(`The list of files this export hands out could not be recorded in the audit trail (${filesErr.message}) — it was refused, and nothing was exported.`);
    }
  }
}

/** DEC-44 (A&O P3) §3: an export whose DATA_EXPORT row was written but which
 *  then did not leave — its file list was refused, its ZIP could not be
 *  built, or the destination refused the delivery (a webhook's 500, a failed
 *  bucket put) — is recorded as such: a DATA_EXPORT_UNDELIVERED row naming
 *  the export's record id (and the destination), so a recall that finds the
 *  DATA_EXPORT row and its file list also finds that nothing reached the
 *  other end. A machine row (user_id NULL, so no member can write one that
 *  unsays a delivered export); the person is in details.exportedBy. A
 *  ledger (the workspace's or a destination's) may still chain from the
 *  undelivered record — its list is what the export carried, whether or not
 *  it arrived; the UNDELIVERED row is what says it did not. Returns null once written, else
 *  why it was not (CHECKED: the caller names it with the failure). */
export async function recordExportUndelivered(
  sb: Pick<SupabaseClient, "from">,
  info: { orgId: string; recordId: string; destinationId?: string | null; exporterUserId: string | null; exporterEmail: string; error: string },
): Promise<string | null> {
  const { error } = await sb.from("audit_logs").insert({
    action: "DATA_EXPORT_UNDELIVERED",
    org_id: info.orgId,
    resource_type: info.destinationId ? DESTINATION_FILES_RESOURCE_TYPE : "org",
    resource_id: info.destinationId || info.orgId,
    user_id: null,
    user_email: EXPORT_LEDGER_ACTOR.email,
    user_role: EXPORT_LEDGER_ACTOR.role,
    details: {
      recordId: info.recordId,
      ...(info.destinationId ? { destinationId: info.destinationId } : {}),
      exportedBy: { userId: info.exporterUserId, email: info.exporterEmail },
      error: info.error.slice(0, 500),
    },
  });
  return error ? error.message : null;
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

/** How many parent ids one `.in()` read carries (UUIDs: well inside a URL). */
const PARENT_ID_CHUNK = 150;

/** One table's read: its (redacted) rows, and — when the read came up short
 *  of the table's own count twice while the export ran — why, with the
 *  counts. A short table keeps the rows that were read (ILIFE-6). */
interface TableRead {
  rows: unknown[];
  short: string | null;
}

/** The manifest entry for a table that was read. */
function outcomeOf(name: string, read: TableRead): DataExportManifest["tables"][number] {
  return read.short
    ? { name, rowCount: read.rows.length, short: read.short }
    : { name, rowCount: read.rows.length };
}

/** BKP-4: dump one ORG_SCOPED_TABLES entry by its own key. `org_id` for every
 *  table that has one; lib/exportTables.ts EXPORT_KEYED_BY names the rest —
 *  `orgs` by its id, an org-less child through the ids of its parent, which
 *  ORG_SCOPED_TABLES lists (and so dumps) first. A parent that failed or was
 *  not dumped fails the child: its rows cannot be scoped to this workspace,
 *  so the table is recorded as an error, never exported unscoped. A parent
 *  whose read came up SHORT still scopes its child through the rows it read,
 *  and the child is marked short too (rows under the parent rows the read
 *  missed are not in it). */
async function dumpOrgTable(
  sb: SupabaseClient,
  table: string,
  orgId: string,
  dumped: Record<string, unknown[]>,
  outcomes: ReadonlyArray<{ name: string; error?: string; short?: string }>,
): Promise<TableRead> {
  const keyed = EXPORT_KEYED_BY[table];
  if (!keyed) return dumpTable(sb, table, "org_id", orgId);
  if (!keyed.parent) return dumpTable(sb, table, keyed.column, orgId);
  const parent = keyed.parent;
  const parentOutcome = outcomes.find((t) => t.name === parent);
  if (!parentOutcome || parentOutcome.error || !Object.prototype.hasOwnProperty.call(dumped, parent)) {
    throw new Error(`its parent table ${parent} was not exported, so its rows cannot be scoped to this workspace`);
  }
  const ids = Array.from(new Set(
    (dumped[parent] as Array<{ id?: unknown }>)
      .map((r) => r?.id)
      .filter((v): v is string => typeof v === "string" && v.length > 0),
  ));
  return dumpThroughParent(sb, table, keyed.column, parent, parentOutcome, ids);
}

/** A child table read through its parent's ids (`column` IN ids),
 *  PARENT_ID_CHUNK ids per read so no request outgrows a URL. The rows of
 *  every chunk are kept; a chunk whose read came up short, or a parent whose
 *  read came up short, marks the child short (the rows under parent rows the
 *  read missed are not in it). A read error fails the whole child. */
async function dumpThroughParent(
  sb: SupabaseClient,
  table: string,
  column: string,
  parent: string,
  parentOutcome: { short?: string },
  ids: readonly string[],
): Promise<TableRead> {
  const out: unknown[] = [];
  const shorts: string[] = [];
  if (parentOutcome.short) {
    shorts.push(`read through the ${ids.length} row(s) of its parent table ${parent} that the export could read; the read of ${parent} came up short, so rows under the ones it missed are not included`);
  }
  for (let i = 0; i < ids.length; i += PARENT_ID_CHUNK) {
    const read = await dumpTable(sb, table, column, ids.slice(i, i + PARENT_ID_CHUNK), true);
    for (const row of read.rows) out.push(row);
    if (read.short) shorts.push(read.short);
  }
  return { rows: out, short: shorts.length > 0 ? shorts.join("; ") : null };
}

/** Rows per page read. */
const PAGE_SIZE = 1000;

/** One table's rows in a scope (`column` = `value`, or `column` IN `value`),
 *  every row exactly once (intelligence ILIFE-6, the export half).
 *
 *  - STABLE, UNIQUE ORDER: pages are ordered by the table's key
 *    (lib/exportTables.ts exportOrderKey — `id`, or the declared key of an
 *    id-less table). Before this, `.range()` windows had no ORDER BY, so a
 *    parallel or bitmap plan, or a concurrent write, could hand one row to
 *    two windows and skip another, and the backup still said complete.
 *  - KEYSET, every key: the next page starts AFTER the last row read — `key
 *    > last` for a one-column key, `(a, b) > (x, y)` for a composite one
 *    (`a > x OR (a = x AND b > y)`) — so a row deleted behind the cursor
 *    never moves the next page. (An OFFSET window does move: one delete of a
 *    row already read and the next window skips a live row, while the count
 *    taken after the read agrees with what was read.)
 *  - NO EARLY STOP: an exact count is taken first, and a short page ends the
 *    read only once that many rows are in hand — a server row cap
 *    (PostgREST max-rows) below PAGE_SIZE answers short pages long before
 *    the end.
 *  - RECONCILED: a read that ends with fewer rows than the table held both
 *    before AND after it (a delete alone, or an insert alone, never does
 *    that) is read once more. Still short, the table is marked short and the
 *    backup INCOMPLETE — never quietly short — and it KEEPS the rows the two
 *    reads found (deduplicated by key, the later read's copy winning): a
 *    table that kept changing is exported slightly short, never empty. */
async function dumpTable(
  sb: SupabaseClient,
  table: string,
  column: string,
  value: string | string[],
  arrayValue = false,
): Promise<TableRead> {
  const first = await readScoped(sb, table, column, value, arrayValue);
  let read: { rows: Array<Record<string, unknown>>; short: string | null } = first;
  if (first.short) {
    const second = await readScoped(sb, table, column, value, arrayValue);
    read = second.short
      ? (() => {
          const merged = mergeReads(table, first.rows, second.rows);
          return {
            rows: merged,
            short: `${second.short} (read twice: ${first.rows.length} and ${second.rows.length} row(s); ` +
              `the ${merged.length} distinct row(s) the two reads found are included)`,
          };
        })()
      : second;
  }
  const out: unknown[] = [];
  // A page at a time: spreading a whole large table into one push() would
  // overflow the call stack.
  for (let i = 0; i < read.rows.length; i += PAGE_SIZE) {
    const rows = read.rows.slice(i, i + PAGE_SIZE);
    // EGR-7 / XEDGE-10: credential columns never leave the database — the
    // redaction map in lib/exportTables.ts is applied to EVERY dumped row, so
    // no consumer of the envelope (ZIP, webhook, bucket, JSON download) can
    // carry a live token or an encrypted destination credential.
    out.push(...rows.map((r) => redactRow(table, r as Record<string, unknown>)));
  }
  return { rows: out, short: read.short };
}

/** Two reads of one table, as one set of rows: every row either read found,
 *  once per key (exportOrderKey), the later read's copy winning. */
function mergeReads(
  table: string,
  earlier: Array<Record<string, unknown>>,
  later: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const keys = exportOrderKey(table);
  const keyOf = (r: Record<string, unknown>) => JSON.stringify(keys.map((c) => r[c] ?? null));
  const seen = new Set(later.map(keyOf));
  const out = [...later];
  for (const r of earlier) if (!seen.has(keyOf(r))) out.push(r);
  return out;
}

/** A PostgREST filter value, double-quoted when it holds a character the
 *  logic-tree syntax reserves (keys are UUIDs and integers, which never do). */
function filterValue(v: string | number): string {
  const s = String(v);
  return /[,.:()"\\\s]/.test(s) ? `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : s;
}

/** The keyset condition "after `last`" over a composite key, as a PostgREST
 *  `or` filter: (k1, k2, …) > (v1, v2, …) is
 *  k1 > v1 OR (k1 = v1 AND k2 > v2) OR … */
export function keysetAfter(keys: readonly string[], last: ReadonlyArray<string | number>): string {
  return keys.map((k, i) => {
    const gt = `${k}.gt.${filterValue(last[i])}`;
    if (i === 0) return gt;
    const eqs = keys.slice(0, i).map((e, j) => `${e}.eq.${filterValue(last[j])}`);
    return `and(${[...eqs, gt].join(",")})`;
  }).join(",");
}

async function readScoped(
  sb: SupabaseClient,
  table: string,
  column: string,
  value: string | string[],
  arrayValue: boolean,
): Promise<{ rows: Array<Record<string, unknown>>; short: string | null }> {
  const scoped = (head: boolean) => {
    const q = head ? sb.from(table).select("*", { count: "exact", head: true }) : sb.from(table).select("*");
    return arrayValue && Array.isArray(value) ? q.in(column, value) : q.eq(column, value as string);
  };
  const countNow = async (): Promise<number | null> => {
    const { count, error } = await scoped(true);
    if (error) throw new Error(error.message);
    return typeof count === "number" ? count : null;
  };

  const before = await countNow();
  const keys = exportOrderKey(table);
  const rows: Array<Record<string, unknown>> = [];
  let last: Array<string | number> | null = null;
  for (;;) {
    let q = scoped(false);
    for (const k of keys) q = q.order(k, { ascending: true });
    if (last !== null) q = keys.length === 1 ? q.gt(keys[0], last[0]) : q.or(keysetAfter(keys, last));
    const { data, error } = await q.limit(PAGE_SIZE);
    if (error) throw new Error(error.message);
    const page = (data ?? []) as unknown as Array<Record<string, unknown>>;
    for (const r of page) rows.push(r);
    if (page.length === 0) break;
    if (page.length < PAGE_SIZE && (before === null || rows.length >= before)) break;
    const tail = page[page.length - 1];
    const next = keys.map((k) => tail[k]);
    if (
      next.some((v) => typeof v !== "string" && typeof v !== "number") ||
      (last !== null && next.every((v, i) => String(v) === String(last![i])))
    ) {
      throw new Error(`the read cannot page past ${table}.(${keys.join(", ")}) (no usable key on the last row) — refused rather than export part of the table`);
    }
    last = next as Array<string | number>;
  }

  if (before !== null && rows.length < before) {
    const after = await countNow();
    if (after !== null && rows.length < after) {
      return {
        rows,
        short: `read ${rows.length} row(s), but the table held ${before} before the read and ${after} after it — ` +
          "rows were missed or changed while the export ran; run the export again",
      };
    }
  }
  return { rows, short: null };
}

/** A storage error that says the object is not there (HeadObject's 404) —
 *  the same test as the intake upload's staged-object check. Anything else
 *  (a throttle, a timeout, a 5xx) says nothing about the object. */
function isNotFound(e: unknown): boolean {
  const err = e as { name?: unknown; $metadata?: { httpStatusCode?: unknown } } | null;
  return err?.$metadata?.httpStatusCode === 404 || err?.name === "NotFound" || err?.name === "NoSuchKey";
}

/** Run `fn` over `items`, at most `limit` at a time (each call must settle on
 *  its own; `fn` records its result by index, so order is kept). */
async function forEachBounded<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
}

/** Every storage key the exported rows reference, through the one registry
 *  (lib/storageKeyRegistry.ts) — the same sources as the orphan sweep's
 *  reference set. A source whose table this export does not carry (`users`,
 *  excluded whole) contributes nothing here; the census test pins which
 *  those are. Deduped by key, preferring a recorded byte size over none so
 *  the export can skip a HeadObject round-trip. ORDERED by
 *  STORAGE_KEY_COLUMNS (a key two columns name takes the earlier one's
 *  place): a capped server ZIP embeds in this order, and the columns every
 *  backup carried before the registry come first. */
export function collectFilePaths(tables: Record<string, unknown[]>): Array<{ path: string; size: number | null }> {
  const rankOf = new Map(STORAGE_KEY_COLUMNS.map((c, i) => [c, i]));
  const map = new Map<string, { size: number | null; rank: number; seq: number }>();
  let seq = 0;
  for (const source of STORAGE_KEY_SOURCES) {
    for (const row of (tables[source.table] as Array<Record<string, unknown>> | undefined) ?? []) {
      if (!row || typeof row !== "object") continue;
      for (const { path, size, column } of keysOf(source, row)) {
        const rank = rankOf.get(column) ?? STORAGE_KEY_COLUMNS.length;
        const cur = map.get(path);
        if (!cur) { map.set(path, { size, rank, seq: seq++ }); continue; }
        if (cur.size == null && size != null) cur.size = size;
        if (rank < cur.rank) { cur.rank = rank; cur.seq = seq++; }
      }
    }
  }
  return Array.from(map.entries())
    .sort((a, b) => a[1].rank - b[1].rank || a[1].seq - b[1].seq)
    .map(([path, v]) => ({ path, size: v.size }));
}
