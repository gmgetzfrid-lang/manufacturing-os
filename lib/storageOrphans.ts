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
//   - the reference collector queries a fixed list of known key columns;
//     if ANY query errors (table renamed, column dropped), the whole scan
//     ABORTS rather than treating those keys as unreferenced;
//   - objects younger than MIN_AGE_DAYS are never candidates (in-flight
//     uploads whose DB row lands after the object);
//   - protected prefixes (offline-archive zips, export artifacts) are never
//     candidates;
//   - deletion re-runs the full scan server-side and only deletes keys that
//     are STILL orphans — the client's list is display, not authority;
//   - the WALK is confined to the caller's org prefix (RET-7): one
//     workspace's admin never lists, sizes or deletes another tenant's
//     objects. The reference collector stays bucket-wide on purpose — a key
//     any tenant references is protected — only the candidate set is scoped.

import type { SupabaseClient } from "@supabase/supabase-js";
import { ListObjectsV2Command, DeleteObjectsCommand } from "@aws-sdk/client-s3";
import { r2, R2_BUCKET } from "@/lib/r2";
import { orgKeyPrefix } from "@/lib/shedKeyGuard";

const MIN_AGE_DAYS = 7;
const PROTECTED_PREFIXES = ["data/", "exports/"];

const isStorageKey = (path: string | null | undefined): path is string =>
  !!path && !/^(https?:|blob:|data:)/i.test(path);

/** Every storage key the database references. Throws on ANY query error —
 *  an incomplete reference set must never masquerade as a complete one. */
export async function collectReferencedKeys(sb: SupabaseClient): Promise<Set<string>> {
  const keys = new Set<string>();
  const add = (path: string | null | undefined) => {
    if (isStorageKey(path)) keys.add(path);
  };

  // Each source: [label, query, extractor]. Tables added later MUST be
  // registered here — the exportTables tripwire's cousin for binaries.
  type Extractor = (rows: Array<Record<string, unknown>>) => void;
  const sources: Array<[string, string, string, Extractor]> = [
    ["document_versions", "document_versions", "file_url, source_file_key", (rows) => {
      for (const r of rows) { add(r.file_url as string); add(r.source_file_key as string); }
    }],
    ["knowledge_documents", "knowledge_documents", "file_key", (rows) => {
      for (const r of rows) add(r.file_key as string);
    }],
    ["asset_photos", "asset_photos", "file_url", (rows) => {
      for (const r of rows) add(r.file_url as string);
    }],
    ["tickets(attachments)", "tickets", "attachments", (rows) => {
      for (const r of rows) {
        for (const att of (r.attachments as Array<{ url?: string }> | null) ?? []) add(att.url);
      }
    }],
    ["markup_requests", "markup_requests", "shared_markup_url", (rows) => {
      for (const r of rows) add(r.shared_markup_url as string);
    }],
    ["plot_plans", "plot_plans", "image_path", (rows) => {
      for (const r of rows) add(r.image_path as string);
    }],
    ["libraries(cover)", "libraries", "cover_image_url", (rows) => {
      for (const r of rows) add(r.cover_image_url as string);
    }],
    ["collections(cover)", "collections", "cover_image_url", (rows) => {
      for (const r of rows) add(r.cover_image_url as string);
    }],
    ["users(avatar)", "users", "avatar_path", (rows) => {
      for (const r of rows) add(r.avatar_path as string);
    }],
    ["org_configurations(branding)", "org_configurations", "key, data", (rows) => {
      for (const r of rows) {
        if (r.key === "branding") add((r.data as { logoPath?: string } | null)?.logoPath);
      }
    }],
    // Registered late — output templates shipped after this collector was
    // written, so every uploaded .docx/.xlsx template and example was an
    // "orphan" seven days after upload and eligible for permanent deletion.
    ["output_templates", "output_templates", "template_file_key, example_files", (rows) => {
      for (const r of rows) {
        add(r.template_file_key as string);
        for (const ex of (r.example_files as Array<{ key?: string; url?: string }> | null) ?? []) {
          add(ex?.key ?? ex?.url);
        }
      }
    }],
  ];

  for (const [label, table, select, extract] of sources) {
    // Page through — .range in 1000-row windows so big tables don't truncate,
    // ORDERED BY id so windows are STABLE (XEDGE-13): without an ORDER BY,
    // Postgres gives no row order across separate LIMIT/OFFSET queries, so a
    // concurrent update or plan switch could make a row vanish between pages
    // — and a reference silently missed here is an object permanently deleted
    // as an "orphan". The per-table count cross-check below turns any
    // remaining drift into a loud abort instead of an incomplete set that
    // masquerades as complete.
    let from = 0;
    let paged = 0;
    for (;;) {
      const { data, error } = await sb
        .from(table)
        .select(select)
        .order("id", { ascending: true })
        .range(from, from + 999);
      if (error) {
        throw new Error(`reference scan failed at ${label}: ${error.message} — aborting (fail-closed)`);
      }
      const rows = (data ?? []) as unknown as Array<Record<string, unknown>>;
      extract(rows);
      paged += rows.length;
      if (rows.length < 1000) break;
      from += 1000;
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

/** Delete THIS org's orphans. RE-SCANS server-side (confined to the org
 *  prefix) and deletes only keys that are still orphans right now — the
 *  caller's list is never trusted, and a key outside the prefix is never
 *  sent to DeleteObjects. */
export async function deleteOrphans(sb: SupabaseClient, orgId: string): Promise<{
  deleted: number; freedBytes: number; errors: string[]; scope: string;
}> {
  const scan = await scanOrphans(sb, orgId);
  const prefix = scan.scope;
  const out = { deleted: 0, freedBytes: 0, errors: [] as string[], scope: prefix };
  const candidates = scan.orphans.filter((o) => o.key.startsWith(prefix));
  for (let i = 0; i < candidates.length; i += 500) {
    const batch = candidates.slice(i, i + 500);
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
