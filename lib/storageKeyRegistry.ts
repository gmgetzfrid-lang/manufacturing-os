// lib/storageKeyRegistry.ts
//
// THE registry of every database column that holds a storage (R2) key: one
// (table, columns, extractor) list, read by BOTH collectors that must agree
// (admin-and-org BKP-2 / BKP-9, intelligence ILIFE-1):
//
//   - lib/dataExport.ts collectFilePaths: the backup's file manifest, built
//     from the exported rows. A key it misses is a binary no backup carries.
//   - lib/storageOrphans.ts collectReferencedKeys: the orphan sweep's
//     reference set, read from the database. A key it misses is a LIVE file
//     the sweep deletes as an "orphan" seven days after upload.
//
// Before this file each collector kept its own list (8 sources and 11), and
// neither knew cost_documents.file_url, so every vendor quote was both absent
// from every backup and eligible for permanent deletion.
// lib/__tests__/storageKeyRegistry.test.ts is the binary analogue of
// exportCoverage.test.ts, from three sides:
//   - the column census: every column in supabase/ whose NAME says "storage
//     key" is registered here or declared NOT a key (with the reason), and
//     every key that sits INSIDE a JSON column under some other name is
//     declared in JSON_KEY_COLUMNS (a name census cannot see those);
//   - the writer census: every call site in the app that writes an object to
//     storage (uploadToPath, PutObjectCommand, the presigned-PUT doors) names
//     the column its key is persisted into, and that column must be
//     registered here — this is how a JSON-embedded key is caught when it is
//     added (the page backgrounds in libraries / collections.page_config were
//     missed by the name census until it existed);
//   - the two collectors read exactly this list.
//
// Kept dependency-free (a type-only supabase import, no aws) so tests and
// both collectors import it without side effects; the database read below
// takes the client as a parameter.

import type { SupabaseClient } from "@supabase/supabase-js";

/** A storage key a row references, with the byte size the row records (null
 *  when none) and the key column (`table.column`) it was read from. */
export interface StorageKeyRef {
  path: string;
  size: number | null;
  column: string;
}

export interface StorageKeySource {
  /** Names the source in the collectors' fail-closed error messages. */
  label: string;
  table: string;
  /** The key-bearing columns (top-level names) this source reads. A key may
   *  sit inside a JSON column (`tickets.attachments[].url`,
   *  `org_configurations.data.logoPath`); the column is still the census unit. */
  keyColumns: readonly string[];
  /** Other columns the extractor reads (a size, a filter) — never keys. */
  readColumns?: readonly string[];
  /** Every candidate key in one row, with the size the row records and the
   *  key column (one of `keyColumns`) it sits in. The caller drops values
   *  that are not storage keys (blank, URL, data URI). */
  extract: (row: Record<string, unknown>) => Array<{ column: string; path: unknown; size?: unknown }>;
}

const list = (v: unknown): Array<Record<string, unknown>> =>
  (Array.isArray(v) ? v : []).filter((x): x is Record<string, unknown> => !!x && typeof x === "object");

/** A library's or folder's page background: page_config.background.imagePath
 *  (types/schema.ts PageConfig), uploaded by components/documents/
 *  CustomizeNodeModal.tsx under orgs/<org>/branding/backgrounds/. */
const pageBackground = (v: unknown): unknown =>
  ((v as { background?: { imagePath?: unknown } | null } | null)?.background ?? null)?.imagePath;

/** Every source of a storage key in the schema (the sweep reads them in this
 *  order; the backup's file manifest is ordered by STORAGE_KEY_COLUMNS). */
export const STORAGE_KEY_SOURCES: readonly StorageKeySource[] = [
  {
    // The issued PDF AND the native source (the DWG behind it — BKP-9): a
    // drawing whose source is not in the backup cannot be revised again.
    label: "document_versions", table: "document_versions",
    keyColumns: ["file_url", "source_file_key"], readColumns: ["size"],
    extract: (r) => [
      { column: "file_url", path: r.file_url, size: r.size },
      { column: "source_file_key", path: r.source_file_key },
    ],
  },
  {
    // Every knowledge-library source PDF (BKP-9). A mirror of a controlled
    // revision names the SAME object as that revision (ILIFE-5).
    label: "knowledge_documents", table: "knowledge_documents",
    keyColumns: ["file_key"], readColumns: ["file_size"],
    extract: (r) => [{ column: "file_key", path: r.file_key, size: r.file_size }],
  },
  {
    label: "asset_photos", table: "asset_photos",
    keyColumns: ["file_url"], readColumns: ["file_size"],
    extract: (r) => [{ column: "file_url", path: r.file_url, size: r.file_size }],
  },
  {
    // Nested in JSONB; an attachment records its size as text ("2.00 MB",
    // formatBytes / CheckInPanel), which is not a byte count — keysOf reads
    // it as unknown and the export asks storage for the real size.
    label: "tickets(attachments)", table: "tickets",
    keyColumns: ["attachments"],
    extract: (r) => list(r.attachments).map((a) => ({ column: "attachments", path: a.url, size: a.size })),
  },
  {
    label: "markup_requests", table: "markup_requests",
    keyColumns: ["shared_markup_url"],
    extract: (r) => [{ column: "shared_markup_url", path: r.shared_markup_url }],
  },
  {
    label: "plot_plans", table: "plot_plans",
    keyColumns: ["image_path"],
    extract: (r) => [{ column: "image_path", path: r.image_path }],
  },
  {
    label: "libraries(cover)", table: "libraries",
    keyColumns: ["cover_image_url"],
    extract: (r) => [{ column: "cover_image_url", path: r.cover_image_url }],
  },
  {
    label: "collections(cover)", table: "collections",
    keyColumns: ["cover_image_url"],
    extract: (r) => [{ column: "cover_image_url", path: r.cover_image_url }],
  },
  {
    // The library's page background image, inside JSON (page_config).
    label: "libraries(page background)", table: "libraries",
    keyColumns: ["page_config"],
    extract: (r) => [{ column: "page_config", path: pageBackground(r.page_config) }],
  },
  {
    // The folder's page background image, inside JSON (page_config).
    label: "collections(page background)", table: "collections",
    keyColumns: ["page_config"],
    extract: (r) => [{ column: "page_config", path: pageBackground(r.page_config) }],
  },
  {
    // Not in any backup: `users` is excluded from the export whole (global
    // identity — lib/exportTables.ts). The sweep must still protect it.
    label: "users(avatar)", table: "users",
    keyColumns: ["avatar_path"],
    extract: (r) => [{ column: "avatar_path", path: r.avatar_path }],
  },
  {
    // The org logo: the {key:'branding'} row's data.logoPath.
    label: "org_configurations(branding)", table: "org_configurations",
    keyColumns: ["data"], readColumns: ["key"],
    extract: (r) => (r.key === "branding" ? [{ column: "data", path: (r.data as { logoPath?: unknown } | null)?.logoPath }] : []),
  },
  {
    // The authored .docx / .xlsx template and its examples (BKP-9).
    label: "output_templates", table: "output_templates",
    keyColumns: ["template_file_key", "example_files"],
    extract: (r) => [
      { column: "template_file_key", path: r.template_file_key },
      ...list(r.example_files).map((ex) => ({ column: "example_files", path: ex.key ?? ex.url })),
    ],
  },
  {
    // Vendor quotes and cost documents — written by lib/costDocs.ts and the
    // intake door (orgs/<org>/project-costs/…). In NEITHER collector before
    // the registry (BKP-2 / ILIFE-1).
    label: "cost_documents", table: "cost_documents",
    keyColumns: ["file_url"],
    extract: (r) => [{ column: "file_url", path: r.file_url }],
  },
];

/** Every `table.column` in the schema that holds a storage key — the census
 *  (lib/__tests__/storageKeyRegistry.test.ts) pins this list to supabase/
 *  and to the app's storage writers. The orphan sweep refuses to run when a
 *  source no longer reads one of them (`registryGaps`, BKP-2 Done-when 3).
 *
 *  ORDER IS THE BACKUP'S FILE ORDER (collectFilePaths): a server ZIP embeds
 *  binaries in this order up to its byte cap (lib/exportRunner.ts
 *  EXPORT_MAX_EMBED_BYTES) and lists the rest as omitted. The columns every
 *  backup carried before the registry come first, in their old order, so a
 *  workspace near the cap keeps embedding what it embedded before; the
 *  columns the registry added (BKP-9 / BKP-2) follow. */
export const STORAGE_KEY_COLUMNS: readonly string[] = [
  // what collectFilePaths carried before the registry, in its order
  "document_versions.file_url",
  "tickets.attachments",
  "markup_requests.shared_markup_url",
  "asset_photos.file_url",
  "plot_plans.image_path",
  "libraries.cover_image_url",
  "collections.cover_image_url",
  "org_configurations.data",
  // added by the registry
  "document_versions.source_file_key",
  "cost_documents.file_url",
  "output_templates.template_file_key",
  "output_templates.example_files",
  "knowledge_documents.file_key",
  "libraries.page_config",
  "collections.page_config",
  // never in an org backup (`users` is excluded whole); the sweep protects it
  "users.avatar_path",
];

/** The registered columns whose key sits INSIDE a JSON value under a name the
 *  census cannot read (a column-name census sees `attachments`, not the
 *  `url` inside it). Declared here, with where the key sits, so the census
 *  counts them (storageKeyRegistry.test.ts) and a database `.in()` match
 *  skips them (`plainKeyColumns`). */
export const JSON_KEY_COLUMNS: Record<string, string> = {
  "tickets.attachments": "attachments[].url — every ticket attachment and intake redline",
  "org_configurations.data": "data.logoPath on the {key:'branding'} row — the workspace logo",
  "output_templates.example_files": "example_files[].key (or .url) — an output template's filled-in examples",
  "libraries.page_config": "page_config.background.imagePath — the library page's background image",
  "collections.page_config": "page_config.background.imagePath — the folder page's background image",
};

/** Columns whose NAME looks like a storage key but whose value is not one of
 *  ours. The census tripwire reads this map; each needs its reason. */
export const NOT_STORAGE_KEY_COLUMNS: Record<string, string> = {
  "ai_connections.api_key": "an AI provider's API key — a credential, never a storage key (the table is excluded from the export whole)",
  "ai_connections.embedding_api_key": "an embedding provider's API key — a credential, never a storage key",
  "answer_skills.builtin_key": "the id of a built-in reasoning skill in code",
  "link_rules.builtin_key": "the id of a built-in link detector in code",
  "collections.path": "the folder's breadcrumb (a text path of folder names), not an object key",
  "document_related_resources.url": "an external link a person attached to a document",
  "documents.external_url": "a link to the record in an external system",
  "documents.uniqueness_key": "the document-number uniqueness key",
  "export_destinations.include_files": "a flag: whether a scheduled export carries binaries",
  "export_destinations.webhook_url": "the customer's own webhook endpoint",
  "export_runs.destination_path": "the object key in the CUSTOMER's bucket that a run wrote — not in our storage",
  "export_runs.download_url": "a presigned URL to a finished export archive under exports/ (a protected prefix the sweep never touches)",
  "org_configurations.key": "the configuration row's name",
  "platform_settings.key": "the deployment setting's name",
};

/** Tables that point at binaries only THROUGH another table, so they hold no
 *  key of their own (the plan named asset_files with cost_documents). */
export const BINARY_LINK_TABLES: Record<string, string> = {
  asset_files:
    "links an asset (tag) to a DOCUMENT (document_id → documents); its binaries are that document's revisions, collected through document_versions.file_url / source_file_key",
};

/** Exported tables whose rows RECORD a key as history (who downloaded or
 *  deleted which object) rather than reference a live binary. The export's
 *  value scan for unregistered keys skips them: an audit row of a file
 *  deleted last year is not a file the backup lacks. */
export const KEY_MENTION_TABLES: Record<string, string> = {
  audit_logs: "STORAGE_DELETE / download rows name the key they acted on — including objects since deleted",
  export_runs: "destination_path is the object a run wrote in the CUSTOMER's bucket, never in ours",
  export_destinations: "prefix is a path in the CUSTOMER's bucket, never in ours",
};

/** A value that can be an object key in our bucket (not a URL, blob or data URI). */
export function isStorageKey(path: unknown): path is string {
  return typeof path === "string" && path.length > 0 && !/^(https?:|blob:|data:)/i.test(path);
}

const byteSize = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;

/** The storage keys one row of `source` references, sizes normalised. */
export function keysOf(source: StorageKeySource, row: Record<string, unknown>): StorageKeyRef[] {
  const out: StorageKeyRef[] = [];
  for (const c of source.extract(row)) {
    if (isStorageKey(c.path)) out.push({ path: c.path, size: byteSize(c.size), column: `${source.table}.${c.column}` });
  }
  return out;
}

/** The PostgREST select for a database read of `source` — always with `id`,
 *  which the orphan collector's keyset paging walks. */
export function selectFor(source: StorageKeySource): string {
  return Array.from(new Set(["id", ...source.keyColumns, ...(source.readColumns ?? [])])).join(", ");
}

/** Key columns the schema declares (STORAGE_KEY_COLUMNS) that no source in
 *  `sources` reads, and source columns the declaration does not list. Both
 *  empty, or the registry is not the whole truth. */
export function registryGaps(sources: readonly StorageKeySource[] = STORAGE_KEY_SOURCES): {
  unread: string[];
  undeclared: string[];
} {
  const read = new Set(sources.flatMap((s) => s.keyColumns.map((c) => `${s.table}.${c}`)));
  const declared = new Set(STORAGE_KEY_COLUMNS);
  return {
    unread: [...declared].filter((c) => !read.has(c)).sort(),
    undeclared: [...read].filter((c) => !declared.has(c)).sort(),
  };
}

/** BKP-9 Done-when 3: storage keys under `orgs/<orgId>/` that the exported
 *  rows hold OUTSIDE every registered source — found by a value scan of every
 *  string (JSON included) in every exported table but the KEY_MENTION_TABLES.
 *  `known` is every key the registry collected (shed ones included). Returns
 *  each key once, with the first `table.column` it was found in. */
export function findUnregisteredOrgKeys(
  tables: Record<string, unknown[]>,
  orgId: string,
  known: ReadonlySet<string>,
): Array<{ path: string; at: string }> {
  if (!orgId) return [];
  const prefix = `orgs/${orgId}/`;
  const found = new Map<string, string>();
  const walk = (v: unknown, at: string, depth: number) => {
    if (depth > 12 || v == null) return;
    if (typeof v === "string") {
      if (v.startsWith(prefix) && v.length > prefix.length && isStorageKey(v) && !known.has(v) && !found.has(v)) found.set(v, at);
      return;
    }
    if (Array.isArray(v)) { for (const x of v) walk(x, at, depth + 1); return; }
    if (typeof v === "object") for (const x of Object.values(v as Record<string, unknown>)) walk(x, at, depth + 1);
  };
  for (const [table, rows] of Object.entries(tables)) {
    if (Object.prototype.hasOwnProperty.call(KEY_MENTION_TABLES, table)) continue;
    for (const row of rows ?? []) {
      if (!row || typeof row !== "object") continue;
      for (const [col, v] of Object.entries(row as Record<string, unknown>)) walk(v, `${table}.${col}`, 0);
    }
  }
  return Array.from(found, ([path, at]) => ({ path, at }));
}

/** The plain (non-JSON) key columns — the ones a database `.in()` can match. */
export function plainKeyColumns(sources: readonly StorageKeySource[] = STORAGE_KEY_SOURCES): Array<{ table: string; column: string }> {
  return sources.flatMap((s) => s.keyColumns
    .filter((c) => !Object.prototype.hasOwnProperty.call(JSON_KEY_COLUMNS, `${s.table}.${c}`))
    .map((column) => ({ table: s.table, column })));
}

/** intelligence ILIFE-5: the keys among `keys` that a row OUTSIDE the
 *  excluded columns still names — above all a knowledge-library mirror
 *  (`knowledge_documents.file_key`), which names the SAME object as the
 *  controlled revision it mirrors. A step that frees a revision's bytes (the
 *  document shed) must keep every key this returns. Bucket-wide on purpose,
 *  like the orphan sweep's reference set (DEC-57): a reference anywhere
 *  protects the object. Plain columns only (the JSON-embedded keys —
 *  ticket attachments, the branding logo, template examples, page
 *  backgrounds — are never a revision's key). Throws on ANY read error: the caller refuses to free
 *  rather than guess (fail closed). `except` lists `table.column` entries
 *  the caller already judged (the shed's own document_versions.file_url,
 *  RET-8's sharedLiveKeys). */
export async function keysReferencedOutside(
  sb: SupabaseClient,
  keys: readonly string[],
  except: readonly string[] = [],
): Promise<Set<string>> {
  const uniq = Array.from(new Set(keys.filter(isStorageKey)));
  const hit = new Set<string>();
  if (uniq.length === 0) return hit;
  const skip = new Set(except);
  for (const { table, column } of plainKeyColumns()) {
    if (skip.has(`${table}.${column}`)) continue;
    for (let i = 0; i < uniq.length; i += 200) {
      const chunk = uniq.slice(i, i + 200);
      const { data, error } = await sb.from(table).select(column).in(column, chunk);
      if (error) {
        throw new Error(`Couldn't verify whether ${table}.${column} still references these storage keys (${error.message}); refusing to proceed.`);
      }
      for (const r of (data ?? []) as unknown as Array<Record<string, unknown>>) {
        const v = r[column];
        if (typeof v === "string") hit.add(v);
      }
    }
  }
  return hit;
}
