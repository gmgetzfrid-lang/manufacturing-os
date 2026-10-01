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
    /** BKP-9: files under this workspace's prefix that a value scan of the
     *  exported rows found in a column the storage-key registry does not
     *  list. Each is in `files` (with a URL when storage has it; counted in
     *  `missing`, with no URL, when it does not); this says how many no
     *  registered column named. */
    unregistered: number;
    /** Files listed with a URL but no size because the export's storage
     *  check ran out of time (FILE_CHECK_BUDGET_MS) before reaching them —
     *  not verified, and not counted in `missing` even if absent. */
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
  exporterUserId: string;
  exporterEmail: string;
  presignedUrlSeconds?: number;
  /** Override FILE_CHECK_BUDGET_MS (tests). */
  fileCheckBudgetMs?: number;
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
      const rows = await dumpOrgTable(sb, tbl, params.orgId, tables, tableCounts);
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
  const checkDeadline = Date.now() + (params.fileCheckBudgetMs ?? FILE_CHECK_BUDGET_MS);
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
      } catch {
        // Object is missing in R2 (legacy / broken record). Keep it in the
        // manifest with no URL so the gap is visible, never silently dropped.
        size = null;
        presignedUrl = "";
        missingFiles++;
        if (unregisteredPaths.has(path)) missingUnregistered++;
      }
    }
    if (size) totalBytes += Number(size);
    files[i] = { path, size, contentType, createdAt, presignedUrl };
  });

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
      `${failedTables.map((t) => t.name).join(", ")}. See each table's "error" in tables[] (a read the database refused, or rows that changed while the export ran — run it again). Resolve before relying on this as a full backup.`,
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
  if (uncheckedFiles > 0) {
    notes.push(
      `${uncheckedFiles} file(s) could not be checked against storage within this export's time limit. Each is listed with its ` +
      "download URL but no size, and is not counted as missing even if it is gone; downloading it confirms it.",
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
    complete: failedTables.length === 0,
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

/** BKP-4: dump one ORG_SCOPED_TABLES entry by its own key. `org_id` for every
 *  table that has one; lib/exportTables.ts EXPORT_KEYED_BY names the rest —
 *  `orgs` by its id, an org-less child through the ids of its parent, which
 *  ORG_SCOPED_TABLES lists (and so dumps) first. A parent that failed or was
 *  not dumped fails the child: its rows cannot be scoped to this workspace,
 *  so the table is recorded as an error, never exported unscoped. */
async function dumpOrgTable(
  sb: SupabaseClient,
  table: string,
  orgId: string,
  dumped: Record<string, unknown[]>,
  outcomes: ReadonlyArray<{ name: string; error?: string }>,
): Promise<unknown[]> {
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
  const out: unknown[] = [];
  for (let i = 0; i < ids.length; i += PARENT_ID_CHUNK) {
    for (const row of await dumpTable(sb, table, keyed.column, ids.slice(i, i + PARENT_ID_CHUNK), true)) out.push(row);
  }
  return out;
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
 *  - KEYSET: a one-column key pages `key > last`, so a row deleted behind
 *    the cursor never moves the next page. A composite key (a few small link
 *    tables) pages by offset in key order, deduplicated by key.
 *  - NO EARLY STOP: an exact count is taken first, and a short page ends the
 *    read only once that many rows are in hand — a server row cap
 *    (PostgREST max-rows) below PAGE_SIZE answers short pages long before
 *    the end.
 *  - RECONCILED: a read that ends with fewer rows than the table held both
 *    before AND after it (a delete alone, or an insert alone, never does
 *    that) is read once more; still short, the table is an error and the
 *    backup is INCOMPLETE, never quietly short. */
async function dumpTable(
  sb: SupabaseClient,
  table: string,
  column: string,
  value: string | string[],
  arrayValue = false,
): Promise<unknown[]> {
  let read = await readScoped(sb, table, column, value, arrayValue);
  if (read.short) read = await readScoped(sb, table, column, value, arrayValue);
  if (read.short) throw new Error(read.short);
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
  return out;
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
  const keyset = keys.length === 1 ? keys[0] : null;
  const seen = keyset ? null : new Set<string>();
  const rows: Array<Record<string, unknown>> = [];
  let last: string | number | null = null;
  let offset = 0;
  for (;;) {
    let q = scoped(false);
    for (const k of keys) q = q.order(k, { ascending: true });
    if (keyset) {
      if (last !== null) q = q.gt(keyset, last);
      q = q.limit(PAGE_SIZE);
    } else {
      q = q.range(offset, offset + PAGE_SIZE - 1);
    }
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    const page = (data ?? []) as unknown as Array<Record<string, unknown>>;
    for (const r of page) {
      if (seen) {
        const k = JSON.stringify(keys.map((c) => r[c] ?? null));
        if (seen.has(k)) continue;
        seen.add(k);
      }
      rows.push(r);
    }
    if (page.length === 0) break;
    if (page.length < PAGE_SIZE && (before === null || rows.length >= before)) break;
    if (keyset) {
      const next = page[page.length - 1][keyset];
      if ((typeof next !== "string" && typeof next !== "number") || (last !== null && String(next) === String(last))) {
        throw new Error(`the read cannot page past ${table}.${keyset} (no usable key on the last row) — refused rather than export part of the table`);
      }
      last = next;
    } else {
      offset += page.length;
    }
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
