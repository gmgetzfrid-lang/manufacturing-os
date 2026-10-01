// lib/storageOrphans.ts — SERVER-ONLY. Find (and reclaim) R2 objects that
// nothing in the database references anymore.
//
// The old knowledge-upload flow deleted index rows but never the PDF, and
// over time other flows can strand files the same way — the bucket only
// grows. This module walks the bucket, collects EVERY storage key the
// database references, and diffs.
//
// SAFETY MODEL — deleting a live file is unrecoverable, so this fails
// closed at every layer:
//   - the reference collector queries every key column of the one registry
//     the backup also reads (lib/storageKeyRegistry.ts, BKP-2), and refuses
//     to run when that list falls short of the schema's;
//     if ANY query errors (table renamed, column dropped), the whole scan
//     ABORTS rather than treating those keys as unreferenced;
//   - objects younger than MIN_AGE_DAYS are never candidates (in-flight
//     uploads whose DB row lands after the object);
//   - protected prefixes (offline-archive zips, export artifacts) are never
//     candidates;
//   - deletion re-runs the full scan server-side and only deletes keys that
//     are STILL orphans — the client's list is display, not authority;
//   - and just before each DeleteObjects batch it asks the database again,
//     key by key (recheckStillNamed): the scan read the reference set page by
//     page, so a reference that moved behind its cursor while it ran (a row
//     already read deleted while one naming the key lands behind it) can be
//     missing from it. One statement per column sees one snapshot; a key any
//     column names then is kept, and a read error stops the purge before
//     that batch with nothing in it deleted (intelligence ILIFE-6 c. 3);
//   - the WALK is confined to the caller's org prefix (RET-7): one
//     workspace's admin never lists, sizes or deletes another tenant's
//     objects. The reference collector stays bucket-wide on purpose — a key
//     any tenant references is protected — only the candidate set is scoped.

import type { SupabaseClient } from "@supabase/supabase-js";
import { ListObjectsV2Command, DeleteObjectsCommand } from "@aws-sdk/client-s3";
import { r2, R2_BUCKET } from "@/lib/r2";
import { orgKeyPrefix } from "@/lib/shedKeyGuard";
import { STORAGE_KEY_SOURCES, keysOf, selectFor, registryGaps, keysReferencedOutside, type StorageKeySource } from "@/lib/storageKeyRegistry";

const MIN_AGE_DAYS = 7;
const PROTECTED_PREFIXES = ["data/", "exports/"];
const PAGE = 1000;

/** Every storage key the database references. Throws on ANY query error —
 *  an incomplete reference set must never masquerade as a complete one.
 *
 *  The sources are lib/storageKeyRegistry.ts STORAGE_KEY_SOURCES — the SAME
 *  list the backup's file manifest is built from (BKP-2 / BKP-9), so a key
 *  column is registered once for both. `sources` exists for tests; the scan
 *  refuses to run when it reads fewer key columns than the schema declares
 *  (STORAGE_KEY_COLUMNS, pinned to supabase/ by the census test). */
export async function collectReferencedKeys(
  sb: SupabaseClient,
  sources: readonly StorageKeySource[] = STORAGE_KEY_SOURCES,
): Promise<Set<string>> {
  const gaps = registryGaps(sources);
  if (gaps.unread.length > 0) {
    throw new Error(
      `reference scan refused: the schema's storage-key columns ${gaps.unread.join(", ")} are read by no collector source — aborting (fail-closed)`,
    );
  }
  const keys = new Set<string>();

  for (const source of sources) {
    const { label, table } = source;
    // KEYSET pages of 1000, ordered by id (ILIFE-6 criterion 3). XEDGE-13
    // ordered the OFFSET windows; but an offset still moves when a row the
    // scan has already read is deleted — every later row shifts up one place,
    // the first row of the next window is never read, and a count taken
    // after the loop agrees. A reference silently missed here is an object
    // permanently deleted as an "orphan". `.gt("id", last)` never moves: a
    // concurrent delete cannot hide a row that is still there. The per-table
    // count cross-check below still turns any remaining drift (a row inserted
    // behind the cursor) into a loud abort.
    let last: string | null = null;
    let paged = 0;
    for (;;) {
      let q = sb.from(table).select(selectFor(source)).order("id", { ascending: true });
      if (last !== null) q = q.gt("id", last);
      const { data, error } = await q.limit(PAGE);
      if (error) {
        throw new Error(`reference scan failed at ${label}: ${error.message} — aborting (fail-closed)`);
      }
      const rows = (data ?? []) as unknown as Array<Record<string, unknown>>;
      for (const r of rows) for (const k of keysOf(source, r)) keys.add(k.path);
      paged += rows.length;
      if (rows.length < PAGE) break;
      const id = rows[rows.length - 1].id;
      if (id === null || id === undefined || String(id) === last) {
        throw new Error(`reference scan at ${label} cannot advance past a page (no id) — aborting (fail-closed)`);
      }
      last = String(id);
    }
    const { count, error: countErr } = await sb
      .from(table)
      .select("id", { head: true, count: "exact" });
    if (countErr) {
      throw new Error(`reference count failed at ${label}: ${countErr.message} — aborting (fail-closed)`);
    }
    if (count != null && count !== paged) {
      throw new Error(
        `reference scan at ${label} paged ${paged} rows but the table counts ${count} — the reference set may be incomplete; aborting (fail-closed)`,
      );
    }
  }
  return keys;
}

export interface OrphanScan {
  orphans: Array<{ key: string; size: number; lastModified: string | null }>;
  orphanBytes: number;
  /** Objects and bytes under THIS org's prefix only (RET-7) — never the bucket. */
  totalObjects: number;
  totalBytes: number;
  referencedKeys: number;
  skippedYoung: number;
  truncated: boolean;
  /** The prefix the walk was confined to. */
  scope: string;
}

/** Walk THIS org's prefix and report objects nothing (in any org) references.
 *  Read-only. `orgId` is required: a scan is always confined to
 *  `orgs/<orgId>/`, so one tenant's admin never sees another's keys. */
export async function scanOrphans(sb: SupabaseClient, orgId: string, maxPages = 500): Promise<OrphanScan> {
  if (!orgId) throw new Error("scanOrphans: orgId is required — the walk must be confined to one workspace.");
  const prefix = orgKeyPrefix(orgId);
  const referenced = await collectReferencedKeys(sb);
  const cutoff = Date.now() - MIN_AGE_DAYS * 86400 * 1000;

  const orphans: OrphanScan["orphans"] = [];
  let orphanBytes = 0, totalObjects = 0, totalBytes = 0, skippedYoung = 0;
  let token: string | undefined;
  let pages = 0;
  do {
    const res = await r2.send(new ListObjectsV2Command({
      Bucket: R2_BUCKET, Prefix: prefix, ContinuationToken: token, MaxKeys: 1000,
    }));
    for (const obj of res.Contents ?? []) {
      const key = obj.Key ?? "";
      const size = obj.Size ?? 0;
      // Belt and braces: a key outside the prefix is never a candidate, even
      // if the listing hands one back.
      if (!key.startsWith(prefix)) continue;
      totalObjects++;
      totalBytes += size;
      if (!key || referenced.has(key)) continue;
      if (PROTECTED_PREFIXES.some((p) => key.startsWith(p))) continue;
      if ((obj.LastModified?.getTime() ?? Date.now()) > cutoff) { skippedYoung++; continue; }
      orphans.push({ key, size, lastModified: obj.LastModified?.toISOString() ?? null });
      orphanBytes += size;
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
    pages++;
  } while (token && pages < maxPages);

  orphans.sort((a, b) => b.size - a.size);
  return {
    orphans, orphanBytes, totalObjects, totalBytes,
    referencedKeys: referenced.size, skippedYoung, truncated: !!token, scope: prefix,
  };
}

/** intelligence ILIFE-6 criterion 3: one containment read per key for each
 *  JSON-embedded key column (JSON_KEY_COLUMNS — a `.in()` cannot match a key
 *  inside a JSON value). Each probe is the JSON shape the registry's
 *  extractor reads the key from; lib/__tests__/storageOrphansRecheck.test.ts
 *  pins one probe set per JSON_KEY_COLUMNS entry. */
export const JSON_KEY_PROBES: Readonly<Record<string, ReadonlyArray<{ table: string; column: string; shape: (key: string) => unknown }>>> = {
  "tickets.attachments": [{ table: "tickets", column: "attachments", shape: (key) => [{ url: key }] }],
  "org_configurations.data": [{ table: "org_configurations", column: "data", shape: (key) => ({ logoPath: key }) }],
  "output_templates.example_files": [
    { table: "output_templates", column: "example_files", shape: (key) => [{ key }] },
    { table: "output_templates", column: "example_files", shape: (key) => [{ url: key }] },
  ],
  "libraries.page_config": [{ table: "libraries", column: "page_config", shape: (key) => ({ background: { imagePath: key } }) }],
  "collections.page_config": [{ table: "collections", column: "page_config", shape: (key) => ({ background: { imagePath: key } }) }],
};

/** How many JSON containment reads run at once. */
const RECHECK_CONCURRENCY = 16;

/** The keys among `keys` that ANY registered key column names right now: the
 *  plain columns by one `.in()` statement per column and 200 keys
 *  (keysReferencedOutside, which also refuses a read a row cap cut short),
 *  the JSON-embedded ones by a containment read per key. Throws on any read
 *  error — the caller deletes nothing it could not clear. */
export async function recheckStillNamed(sb: SupabaseClient, keys: readonly string[]): Promise<Set<string>> {
  const named = await keysReferencedOutside(sb, keys);
  const probes = Object.values(JSON_KEY_PROBES).flat();
  const work: Array<{ key: string; probe: (typeof probes)[number] }> = [];
  for (const key of keys) {
    if (named.has(key)) continue;
    for (const probe of probes) work.push({ key, probe });
  }
  let next = 0;
  let failure: Error | null = null;
  const run = async () => {
    while (failure === null && next < work.length) {
      const { key, probe } = work[next++];
      if (named.has(key)) continue;
      const { data, error } = await sb.from(probe.table).select("id").contains(probe.column, probe.shape(key) as Record<string, unknown>).limit(1);
      if (error) {
        failure = new Error(`Couldn't verify whether ${probe.table}.${probe.column} still references ${key} (${error.message}); refusing to delete.`);
        return;
      }
      if (Array.isArray(data) && data.length > 0) named.add(key);
    }
  };
  await Promise.all(Array.from({ length: Math.min(RECHECK_CONCURRENCY, work.length) }, run));
  if (failure) throw failure;
  return named;
}

/** Delete THIS org's orphans. RE-SCANS server-side (confined to the org
 *  prefix) and deletes only keys that are still orphans right now — the
 *  caller's list is never trusted, and a key outside the prefix is never
 *  sent to DeleteObjects. Each batch is re-checked against every registered
 *  key column just before it is deleted (ILIFE-6 c. 3): a key named there is
 *  kept (`kept`), and a re-check that cannot read stops the purge before
 *  that batch, nothing in it deleted. */
export async function deleteOrphans(sb: SupabaseClient, orgId: string): Promise<{
  deleted: number; freedBytes: number; errors: string[]; scope: string; kept: number;
}> {
  const scan = await scanOrphans(sb, orgId);
  const prefix = scan.scope;
  const out = { deleted: 0, freedBytes: 0, errors: [] as string[], scope: prefix, kept: 0 };
  const candidates = scan.orphans.filter((o) => o.key.startsWith(prefix));
  for (let i = 0; i < candidates.length; i += 500) {
    let batch = candidates.slice(i, i + 500);
    let stillNamed: Set<string>;
    try {
      stillNamed = await recheckStillNamed(sb, batch.map((o) => o.key));
    } catch (e) {
      out.errors.push(`${(e as Error).message} The purge stopped before this batch; nothing in it was deleted.`);
      break;
    }
    if (stillNamed.size > 0) {
      out.kept += batch.filter((o) => stillNamed.has(o.key)).length;
      batch = batch.filter((o) => !stillNamed.has(o.key));
    }
    if (batch.length === 0) continue;
    try {
      const res = await r2.send(new DeleteObjectsCommand({
        Bucket: R2_BUCKET,
        Delete: { Objects: batch.map((o) => ({ Key: o.key })), Quiet: true },
      }));
      const failed = new Set((res.Errors ?? []).map((e) => e.Key ?? ""));
      for (const e of res.Errors ?? []) out.errors.push(`${e.Key}: ${e.Message}`);
      for (const o of batch) {
        if (!failed.has(o.key)) { out.deleted++; out.freedBytes += o.size; }
      }
    } catch (e) {
      out.errors.push((e as Error).message);
      break;
    }
  }
  return out;
}
