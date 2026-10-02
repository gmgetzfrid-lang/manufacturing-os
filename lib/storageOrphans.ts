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
//   - and just before each DeleteObjects batch it asks the database again
//     about every candidate in it (recheckStillNamed): the scan read the
//     reference set page by page, so a reference that moved behind its cursor
//     while it ran (a row already read deleted while one naming the key lands
//     behind it) can be missing from it. Each statement sees one snapshot; a
//     key any column names then is kept, and a read error stops the purge
//     before that batch with nothing in it deleted (intelligence ILIFE-6 c. 3);
//   - a purge stops at a batch boundary before the route's time limit
//     (ORPHAN_PURGE_BUDGET_MS) and says to run it again, rather than being
//     killed mid-batch with nothing reported;
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

/** intelligence ILIFE-6 criterion 3: the JSON shapes a key is embedded in,
 *  for each JSON-embedded key column (JSON_KEY_COLUMNS — a `.in()` cannot
 *  match a key inside a JSON value). Each probe is the JSON shape the
 *  registry's extractor reads the key from; lib/__tests__/storageOrphansRecheck.test.ts
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

/** The probe as the jsonb literal PostgREST's `cs` filter takes — ALWAYS a
 *  JSON string. postgrest-js writes an ARRAY value as a Postgres array
 *  literal (`cs.{[object Object]}`), which a jsonb column refuses (22P02),
 *  so every true orphan's re-check failed and the purge deleted nothing. */
export function probeLiteral(probe: { shape: (key: string) => unknown }, key: string): string {
  return JSON.stringify(probe.shape(key));
}

/** A value inside a PostgREST logic-tree (`.or()`) term: double-quoted, with
 *  `\` and `"` backslash-escaped — PostgREST's escape for reserved characters,
 *  read back verbatim (the codebase's convention: lib/companies.ts orValue,
 *  lib/orchestrator/protocol.ts ilikeContainsValue). A JSON probe carries
 *  quotes, colons, braces and, in a key, possibly a comma or parenthesis. */
export function orTermValue(value: string): string {
  return `"${value.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
}

/** How long one batched containment statement's `or=(…)` may be, URL-encoded.
 *  postgrest-js flags URLs past 8,000 characters as likely to exceed server
 *  limits; the rest of the URL is well under the 2,000 left. */
const RECHECK_OR_URL_BUDGET = 6000;
/** The same budget for one plain-column `.in()` list. keysReferencedOutside
 *  sends up to 200 keys per `.in()`; at real key lengths
 *  (`orgs/<uuid>/documents/<uuid>/<stamp>_<name>.pdf`, ~120 characters) that
 *  is a ~26,000-character URL the gateway refuses (414), and every purge with
 *  more than a few dozen candidates stopped before its first batch. */
const RECHECK_IN_URL_BUDGET = 6000;

/** How many characters `value` takes in a query string — the
 *  application/x-www-form-urlencoded form URLSearchParams (and so
 *  postgrest-js) writes, which encodes `/`, `(`, `)` and `,` too. */
export function wireLength(value: string): number {
  return new URLSearchParams([["", value]]).toString().length - 1;
}

/** `keys` (deduplicated, in order) cut into `.in()` lists whose encoded
 *  length stays within `budget` — each key as postgrest-js writes it inside
 *  `in.(…)` (double-quoted when it holds `,`, `(` or `)`), plus its encoded
 *  comma — and never more than keysReferencedOutside's own 200 per list. */
export function inListChunks(keys: readonly string[], budget: number = RECHECK_IN_URL_BUDGET): string[][] {
  const out: string[][] = [];
  let cur: string[] = [];
  let size = 0;
  for (const key of new Set(keys)) {
    const len = wireLength(/[,()]/.test(key) ? `"${key}"` : key) + 3;
    if (cur.length > 0 && (size + len > budget || cur.length >= 200)) { out.push(cur); cur = []; size = 0; }
    cur.push(key);
    size += len;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}
/** How many re-check statements run at once. */
const RECHECK_CONCURRENCY = 8;

/** Thrown by recheckStillNamed when the caller's deadline passes first. */
export class RecheckDeadlineError extends Error {
  constructor() {
    super("The purge reached its time limit before this batch could be checked.");
    this.name = "RecheckDeadlineError";
  }
}

/** The keys among `keys` that ANY registered key column names right now: the
 *  plain columns by one `.in()` statement per column per list of keys sized
 *  to RECHECK_IN_URL_BUDGET (inListChunks → keysReferencedOutside, which also
 *  refuses a read a row cap cut short; up to RECHECK_CONCURRENCY lists at once);
 *  the JSON-embedded ones by ONE containment statement per column per chunk
 *  of keys — `col.cs."<probe>"` terms OR-ed, sized to RECHECK_OR_URL_BUDGET —
 *  asked only "does any row match?" (`limit(1)`). A chunk nothing matches
 *  (every true orphan's) is cleared in that one read; a chunk with a match is
 *  re-asked key by key (`.contains` with the JSON literal) to learn which keys
 *  are named, so an answer never rests on the batched form alone. Throws on
 *  any read error — the caller deletes nothing it could not clear — and with
 *  RecheckDeadlineError once `opts.deadline` (epoch ms) has passed. */
export async function recheckStillNamed(
  sb: SupabaseClient,
  keys: readonly string[],
  opts: { deadline?: number } = {},
): Promise<Set<string>> {
  const pastDeadline = () => opts.deadline !== undefined && Date.now() >= opts.deadline;
  if (pastDeadline()) throw new RecheckDeadlineError();
  const named = new Set<string>();
  {
    const lists = inListChunks(keys);
    let at = 0;
    let stop: unknown = null;
    const runPlain = async () => {
      while (stop === null && at < lists.length) {
        if (pastDeadline()) { stop = new RecheckDeadlineError(); return; }
        const list = lists[at++];
        try {
          for (const key of await keysReferencedOutside(sb, list)) named.add(key);
        } catch (e) {
          stop = e;
          return;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(RECHECK_CONCURRENCY, lists.length) }, runPlain));
    if (stop !== null) throw stop;
  }
  if (pastDeadline()) throw new RecheckDeadlineError();

  type Group = { table: string; column: string; probes: ReadonlyArray<{ shape: (key: string) => unknown }> };
  const work: Array<{ group: Group; keys: string[]; terms: string[] }> = [];
  for (const probes of Object.values(JSON_KEY_PROBES)) {
    if (probes.length === 0) continue;
    const group: Group = { table: probes[0].table, column: probes[0].column, probes };
    let chunk: { group: Group; keys: string[]; terms: string[] } | null = null;
    let size = 0;
    for (const key of keys) {
      if (named.has(key)) continue;
      const terms = probes.map((p) => `${group.column}.cs.${orTermValue(probeLiteral(p, key))}`);
      const len = terms.reduce((n, t) => n + wireLength(t) + 3, 0);
      if (chunk && size + len > RECHECK_OR_URL_BUDGET) { work.push(chunk); chunk = null; size = 0; }
      if (!chunk) chunk = { group, keys: [], terms: [] };
      chunk.keys.push(key);
      chunk.terms.push(...terms);
      size += len;
    }
    if (chunk) work.push(chunk);
  }

  const refuse = (table: string, column: string, what: string, message: string) =>
    new Error(`Couldn't verify whether ${table}.${column} still references ${what} (${message}); refusing to delete.`);
  let next = 0;
  let failure: Error | null = null;
  const run = async () => {
    while (failure === null && next < work.length) {
      if (pastDeadline()) { failure = new RecheckDeadlineError(); return; }
      const { group, keys: chunkKeys, terms } = work[next++];
      const { data, error } = await sb.from(group.table).select("id").or(terms.join(",")).limit(1);
      if (error) {
        failure = refuse(group.table, group.column, chunkKeys.length === 1 ? chunkKeys[0] : `${chunkKeys.length} keys including ${chunkKeys[0]}`, error.message);
        return;
      }
      if (!Array.isArray(data) || data.length === 0) continue;
      // Something in this chunk is named: learn which keys, one exact read each.
      for (const key of chunkKeys) {
        for (const probe of group.probes) {
          if (failure !== null) return;
          if (pastDeadline()) { failure = new RecheckDeadlineError(); return; }
          const one = await sb.from(group.table).select("id").contains(group.column, probeLiteral(probe, key)).limit(1);
          if (one.error) { failure = refuse(group.table, group.column, key, one.error.message); return; }
          if (Array.isArray(one.data) && one.data.length > 0) { named.add(key); break; }
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(RECHECK_CONCURRENCY, work.length) }, run));
  if (failure) throw failure;
  return named;
}

/** How long a purge may run before it stops at a batch boundary: the
 *  orphans route's maxDuration is 300 s, and a function the platform kills
 *  mid-purge reports nothing — not the batches already deleted, not its
 *  STORAGE_ORPHANS_PURGED row. */
export const ORPHAN_PURGE_BUDGET_MS = 240_000;

/** Delete THIS org's orphans. RE-SCANS server-side (confined to the org
 *  prefix) and deletes only keys that are still orphans right now — the
 *  caller's list is never trusted, and a key outside the prefix is never
 *  sent to DeleteObjects. Each batch is re-checked against every registered
 *  key column just before it is deleted (ILIFE-6 c. 3): a key named there is
 *  kept (`kept`), and a re-check that cannot read stops the purge before
 *  that batch, nothing in it deleted. The purge stops at a batch boundary at
 *  `opts.deadline` (default: ORPHAN_PURGE_BUDGET_MS from the call), before a
 *  batch the slowest one so far says would overrun it, and returns what it
 *  deleted with an error saying to run it again. */
export async function deleteOrphans(sb: SupabaseClient, orgId: string, opts: { deadline?: number } = {}): Promise<{
  deleted: number; freedBytes: number; errors: string[]; scope: string; kept: number;
}> {
  const deadline = opts.deadline ?? Date.now() + ORPHAN_PURGE_BUDGET_MS;
  const scan = await scanOrphans(sb, orgId);
  const prefix = scan.scope;
  const out = { deleted: 0, freedBytes: 0, errors: [] as string[], scope: prefix, kept: 0 };
  const candidates = scan.orphans.filter((o) => o.key.startsWith(prefix));
  const stopAtLimit = (from: number) =>
    out.errors.push(
      `Stopped at the time limit: ${candidates.length - from} orphaned file(s) were not checked or deleted this time. Run the purge again to continue.`,
    );
  let slowest = 0;
  for (let i = 0; i < candidates.length; i += 500) {
    if (Date.now() + slowest >= deadline) { stopAtLimit(i); break; }
    const started = Date.now();
    let batch = candidates.slice(i, i + 500);
    let stillNamed: Set<string>;
    try {
      stillNamed = await recheckStillNamed(sb, batch.map((o) => o.key), { deadline });
    } catch (e) {
      if (e instanceof RecheckDeadlineError) { stopAtLimit(i); break; }
      out.errors.push(`${(e as Error).message} The purge stopped before this batch; nothing in it was deleted.`);
      break;
    }
    if (stillNamed.size > 0) {
      out.kept += batch.filter((o) => stillNamed.has(o.key)).length;
      batch = batch.filter((o) => !stillNamed.has(o.key));
    }
    if (batch.length > 0) {
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
    slowest = Math.max(slowest, Date.now() - started);
  }
  return out;
}
